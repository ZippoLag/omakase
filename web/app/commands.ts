/**
 * Web replica of the CLI command glue (src/cli.ts minus Node/arg parsing):
 * runs one `word` / `kanji` / `search` against the open dictionary and
 * renders the same output text the golden tests pin, so panes show exactly
 * what `omakase` prints — byte-for-byte, minus ANSI color.
 */
import type { DbLike } from "../../src/lookup.js";
import type { SearchHit } from "../../src/lookup.js";
import {
  displayHeader,
  exampleSentences,
  findWordByWriting,
  isKanaInput,
  kanjiLiterals,
  loadKanji,
  radicalChar,
  searchKanjiByReading,
  strokeFileFor,
  wordsContainingKanji,
  searchMeanings,
  searchReadingPrefix,
  suggestReading,
  wordThesaurus,
} from "../../src/lookup.js";
import type { PageAnchor, PageRequest, PageSection, StrokePage } from "./worker-api.js";
import { SCHEMA_VERSION } from "../../src/db/schema-version.js";
import {
  KANJI_MAX_DEFAULT,
  kanjiCompoundRows,
  renderExamples,
  renderKanji,
  renderKanjiReadingSearch,
  renderKanjiWords,
  searchRowList,
  searchSections,
  renderThesaurus,
  renderWordBody,
  thesaurusRowList,
} from "../../src/format.js";

/**
 * Cheap integrity probe for the opened dictionary: `PRAGMA quick_check` must
 * return exactly one row whose value is `ok`. Anything else — extra rows, or
 * a thrown error (`database disk image is malformed` / `file is not a
 * database`) — means the copy was truncated or damaged (an interrupted
 * import, storage eviction) and must be re-imported rather than trusted.
 * Runs through the WasmDb shim in the worker and any DbLike driver in tests
 * (node:sqlite / better-sqlite3), so it is testable against a real
 * truncated fixture.
 */
export function dbLooksHealthy(db: DbLike): boolean {
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
    return rows.length === 1 && rows[0]?.quick_check === "ok";
  } catch {
    return false;
  }
}

/**
 * The `schema_version` a dictionary was built with, or null when the row (or
 * the whole table) is absent. The worker compares it against the schema its
 * own build needs: a dictionary from another schema still opens and reports
 * "ready" — its meta table sits at the front of the file, so a stamp read
 * succeeds — while every thesaurus read fails on the newer columns. Detecting
 * the mismatch at boot is what keeps that from surfacing as "the app is
 * ready but every lookup is broken".
 */
export function readSchemaVersion(db: DbLike): number | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown } | undefined;
    const n = Number(row?.value);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** What boot should do with the dictionary copy it found in OPFS. */
export type DictionaryAction = "open" | "update" | "reimport" | "import";

/**
 * The actionable boot error for a dictionary built for another schema. One
 * source for the wording, because two call sites need it: the cheap pre-flight
 * check (the served `meta.json` declares `schemaVersion`, so a shell deployed
 * without its matching dictionary is refused *without* downloading ~341 MB
 * only to fail) and the post-import backstop (`requireSchema`, which also
 * catches a served file that lies about or omits the field).
 *
 * Callers own the null semantics: `null` means "not recorded / unreadable",
 * which the pre-flight treats as "unknown, go on and import" and the backstop
 * treats as a mismatch.
 */
export function schemaMismatchMessage(found: number | null): string {
  return `the served dictionary was built for schema ${found ?? "unknown"}, but this app needs ${SCHEMA_VERSION}`
    + " — the dictionary is older than the deployed shell. Run `pnpm run deploy:web` (it uploads"
    + " dist/kanji.db and the shell from one build) and reload.";
}

/**
 * Decide the dictionary's fate from the probes taken at boot — the pure half
 * of `ensureDb`, so the (fiddly) combinations are unit-testable:
 *
 *   import    no readable copy in OPFS (first visit, or evicted storage)
 *   update    a readable copy, but the served build stamp differs — the
 *             common upgrade path, and the only one that is *expected*
 *   reimport  a readable copy of the served build that cannot be trusted:
 *             damaged (fails quick_check) or built for another schema
 *   open      a healthy copy of the served schema and build — the offline path
 *
 * Order matters. The stamp is checked before health/schema so a normal update
 * reports "newer dictionary found" rather than "damaged"; a mismatched schema
 * is treated like damage (re-import, then `requireSchema` in the worker fails
 * loudly if the served dictionary is wrong too); and `serverStamp === null`
 * (offline, the meta.json fetch failed) must never force a re-import — a
 * healthy copy still opens and the app works with no network.
 */
export function dictionaryAction(
  localStamp: string | null,
  localHealthy: boolean,
  localSchema: number | null,
  serverStamp: string | null,
): DictionaryAction {
  if (localStamp === null) return "import";
  if (serverStamp !== null && serverStamp !== localStamp) return "update";
  if (!localHealthy || localSchema !== SCHEMA_VERSION) return "reimport";
  return "open";
}

/** JMdict tag -> description map, stored in the meta table (like cli.loadTags). */
export function loadTags(db: DbLike): Record<string, string> {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'tags'").get() as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as Record<string, string>;
  } catch {
    return {};
  }
}

/** ASCII-only input (gloss + romaji paths), mirroring cli.ts's private check. */
function isAscii(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

/** Outcome of a streaming lookup: `error` on a miss, otherwise the sections
 * (already emitted) carry the whole result — the CLI text byte-for-byte. */
export interface StreamResult {
  error: string | null;
}

/**
 * `word <query>` — entry body + thesaurus + example sentences, streamed as
 * one section per part in render order. Each section carries the separator
 * the CLI's `filter(Boolean).join("\n")` would insert (a blank line), so
 * concatenating the emitted sections reproduces `cmdWord` byte-for-byte;
 * empty parts are skipped exactly like `filter(Boolean)`. The thesaurus
 * section carries load-more anchors for its capped synonyms/antonyms/related
 * lists.
 */
export async function streamWord(
  db: DbLike,
  query: string,
  tags: Record<string, string>,
  emit: (label: string, text: string, pages?: PageAnchor[]) => Promise<void> | void,
): Promise<StreamResult> {
  const word = findWordByWriting(db, query);
  if (!word) return { error: `no entry for "${query}"` };
  const body = renderWordBody(word, tags);
  if (body) await emit("body", body);
  const { synonyms, antonyms, related, synonymTotal, antonymTotal, relatedTotal } = wordThesaurus(db, word);
  const thesaurus = renderThesaurus(synonyms, antonyms, related, { synonymTotal, antonymTotal, relatedTotal });
  if (thesaurus) {
    // One anchor per capped list, located by scanning the rendered block for
    // its ``… and N more`` note lines in block order (synonyms → antonyms →
    // related).
    const anchors = noteAnchors("\n" + thesaurus, [
      { section: "synonyms", total: synonymTotal, shown: synonyms.length },
      { section: "antonyms", total: antonymTotal, shown: antonyms.length },
      { section: "related", total: relatedTotal, shown: related.length },
    ]);
    await emit("thesaurus", "\n" + thesaurus, anchors);
  }
  const examples = renderExamples(exampleSentences(db, word));
  if (examples) await emit("examples", "\n" + examples);
  return { error: null };
}

/**
 * Find the ``… and N more`` note line(s) inside a rendered section text,
 * pairing each with its paged list. `blocks` must be in render order (the
 * lists appear in that order inside `text`); a block whose list is not
 * capped (no note line follows) contributes no anchor. The note line's
 * 0-based index is into `text.split("\n")` — the section's separator
 * newline (leading "\n") counts as line 0, exactly how the UI folds
 * per-section anchors into global node lines (paging.ts foldAnchors).
 */
function noteAnchors(
  text: string,
  blocks: { section: PageSection; total: number; shown: number }[],
): PageAnchor[] {
  const lines = text.split("\n");
  const anchors: PageAnchor[] = [];
  let cursor = 0;
  for (const b of blocks) {
    if (b.total <= b.shown) continue;
    for (let i = cursor; i < lines.length; i++) {
      if (/^  … and \d+ more$/.test(lines[i]!)) {
        anchors.push({ section: b.section, total: b.total, shown: b.shown, line: i });
        cursor = i + 1;
        break;
      }
    }
  }
  return anchors;
}

/**
 * `kanji <query> [-max N]` — mirrors cli.ts's cmdKanji: a multi-kanji query
 * first lists words containing the characters (ranked, capped at `max`),
 * then one page per kanji literal with compounds capped at `max`; kana /
 * romaji queries go through the kanji-by-reading search, capped at `max`.
 * The web UI never sends a multi-kanji query (it splits the box into one
 * lookup per character), but the multi-literal branch stays for CLI parity.
 * Pages concatenate with no separator — each render already ends in a
 * newline — so the emitted sections join to `cmdKanji`'s text byte-for-byte.
 */
export async function streamKanji(
  db: DbLike,
  query: string,
  max: number = KANJI_MAX_DEFAULT,
  emit: (label: string, text: string, pages?: PageAnchor[]) => Promise<void> | void,
): Promise<StreamResult> {
  const literals = kanjiLiterals(db, query);
  if (literals) {
    if (literals.length > 1) {
      const words = wordsContainingKanji(db, literals, max);
      const wordsText = renderKanjiWords(words.hits, words.total, max);
      if (wordsText !== "") await emit("words", wordsText);
    }
    for (const literal of literals) {
      const kanji = loadKanji(db, literal, max);
      if (!kanji) return { error: `no kanji "${query}"` }; // unreachable after kanjiLiterals
      let radicalDisplay: string | null = null;
      if (kanji.classicalRadical != null) {
        radicalDisplay = `${radicalChar(db, kanji.classicalRadical) ?? "?"} (${kanji.classicalRadical})`;
      }
      const page = renderKanji(kanji, radicalDisplay);
      // The compounds list is the only capped list on a kanji page (the web
      // never sends multi-kanji boxes, so the Words section carries no
      // anchor — CLI parity only).
      const anchors = kanji.compoundTotal > kanji.compounds.length
        ? noteAnchors(page, [{ section: "compounds", total: kanji.compoundTotal, shown: kanji.compounds.length }])
        : [];
      await emit("page", page, anchors);
    }
    return { error: null };
  }
  const hits = searchKanjiByReading(db, query);
  if (hits.length === 0) return { error: `no kanji "${query}"` };
  await emit("reading-search", renderKanjiReadingSearch(query, hits, max));
  return { error: null };
}

/**
 * Stroke-order pages behind a `kanji` query: when the query is one or more
 * kanji literals (so `runKanji` renders a page per character), return the
 * stroke_order svg file for each character that has one — the UI animates
 * these on the pane. Reading searches render no pages, so they get [].
 */
export function kanjiStrokePages(db: DbLike, query: string): StrokePage[] {
  const literals = kanjiLiterals(db, query);
  if (!literals) return [];
  const pages: StrokePage[] = [];
  for (const literal of literals) {
    const svgFile = strokeFileFor(db, literal);
    if (svgFile) pages.push({ literal, svgFile });
  }
  return pages;
}

/**
 * `search <query>` — ranked readings/meanings/kanji sections + did-you-mean
 * hint, streamed in render order via `searchSections` (the single source of
 * the byte-identical section text; see the join-equality test). `onProgress`
 * receives real done/total while the meaning search runs — the one section
 * long enough (and measurable enough) to count, see worker.ts. Sections are
 * emitted with the blank-line separator between them, and the hint (when an
 * ASCII search finds nothing) concatenates as its own trailing section.
 */
/**
 * Per-query ranked meaning lists for fast page continuations: the full
 * searchMeanings result per trimmed query, capped at a few entries (the
 * oldest evicted on insert — Map iteration order). Populated by streamSearch
 * AND by meanings page requests, so the first page click on a section that
 * was already searched once is instant; a click on a query whose cache
 * entry was evicted (or that never searched meanings) re-runs the search.
 */
const MEANING_CACHE_CAP = 8;
const meaningRankCache = new Map<string, SearchHit[]>();

function trimMeaningCache(): void {
  while (meaningRankCache.size > MEANING_CACHE_CAP) {
    const first = meaningRankCache.keys().next().value;
    if (first === undefined) break;
    meaningRankCache.delete(first);
  }
}

export async function streamSearch(
  db: DbLike,
  query: string,
  max: number = 30,
  emit: (label: string, text: string, pages?: PageAnchor[]) => Promise<void> | void,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<StreamResult> {
  const trimmed = query.trim();
  // The header section only echoes the query (section 0 of searchSections) —
  // emit it BEFORE any lookup runs so the pane claims its ladder floor (0)
  // and the bar leaves the dot immediately, instead of sitting at 0% through
  // the whole meaning search. Byte-identity is untouched: the concatenation
  // is header + "\n" + section1 + "\n" + … exactly as before, and the CLI
  // echoes the same trimmed query (cmdSearch / renderSearch).
  //
  // NOTE the readings section CANNOT be emitted early: whether it is shown
  // at all depends on `keepReadings`, which depends on `meanings` (a kana
  // query keeps readings; an ASCII search keeps them only when there is no
  // meaning match or an exact reading hit). Emitting readings before
  // meanings were known would break the byte-identical contract — do not
  // "optimize" this.
  await emit("header", `${trimmed}\n`);
  // Reading rows are ranked and capped at `max` inside the lookup (SQL
  // LIMIT); `total` feeds the header/remainder note.
  const { hits: readings, total: readingsTotal } = searchReadingPrefix(db, trimmed, max);
  const meanings = isAscii(trimmed) ? await searchMeanings(db, trimmed, onProgress) : [];
  // The full ranked meaning list is cached for fast page continuations (a
  // page click on the Meanings note slices it instead of re-searching).
  if (isAscii(trimmed)) {
    meaningRankCache.set(trimmed, meanings);
    trimMeaningCache();
  }
  const keepReadings = isKanaInput(trimmed)
    || meanings.length === 0
    || readings.some((h) => h.exact);
  const shownReadings = keepReadings ? readings : [];
  const kanjiHits = isKanaInput(trimmed) || isAscii(trimmed)
    ? searchKanjiByReading(db, trimmed)
    : [];
  const secs = searchSections(trimmed, shownReadings, meanings, kanjiHits, {
    max,
    color: false,
    totals: { readings: keepReadings ? readingsTotal : 0 },
  });
  // Ladder labels for the sections AFTER the header, derived from what is
  // actually present: searchSections omits empty blocks, so an index-based
  // label would misname e.g. a meanings-only result as "readings"
  // (under-claiming its floor) or a kanji-only one as "readings" instead of
  // "kanji". Mirror the same presence rules in the same order; the one
  // remaining shape is the sole "(no results)" block, labeled "none".
  const labels: string[] = [];
  if (shownReadings.length > 0) labels.push("readings");
  if (meanings.length > 0) labels.push("meanings");
  if (kanjiHits.length > 0) labels.push("kanji");
  if (labels.length === 0) labels.push("none"); // the "(no results)" block
  for (let i = 1; i < secs.length; i++) {
    const label = labels[i - 1]!;
    // Per-section page anchor: the section shows at most `max` rows, so a
    // full section beyond the cap gets a load-more button after its note.
    // `shown`/`total` mirror searchSections' own arithmetic (rows sliced at
    // offset 0 here), so the button's "N more" matches the note's count.
    const total = label === "readings" ? (keepReadings ? readingsTotal : 0)
      : label === "meanings" ? meanings.length
        : label === "kanji" ? kanjiHits.length
          : 0;
    const shown = label === "readings" ? shownReadings.length
      : label === "meanings" ? Math.min(meanings.length, max)
        : label === "kanji" ? Math.min(kanjiHits.length, max)
          : 0;
    const anchors = label === "none" || label === "hint"
      ? []
      : noteAnchors("\n" + secs[i]!, [{ section: label as PageSection, total, shown }]);
    await emit(label, "\n" + secs[i]!, anchors);
  }
  if (shownReadings.length === 0 && meanings.length === 0 && kanjiHits.length === 0 && isAscii(trimmed)) {
    await emit("hint", webSearchHint(db, trimmed));
  }
  return { error: null };
}

/**
 * One load-more continuation: fetch the next `max` rows of a pane's paged
 * list starting at `offset` and render them raw (byte-identical to what the
 * CLI prints for that window — the same row renderers). `remaining` is how
 * many rows are still left after this window, so the UI can re-add the
 * ``… and N more`` note and button. Meanings page requests hit the per-query
 * ranked-list cache (only the first click re-runs the search); every other
 * section is a bounded SQL window.
 */
export async function streamPage(
  db: DbLike,
  req: PageRequest,
): Promise<{ rowsText: string; remaining: number; error: string | null }> {
  try {
    const { max, offset, section, query } = req;
    const remaining = (total: number, shown: number): number => Math.max(0, total - (offset + shown));
    switch (section) {
      case "synonyms":
      case "antonyms":
      case "related": {
        const word = findWordByWriting(db, query);
        if (!word) return { rowsText: "", remaining: 0, error: `no entry for "${query}"` };
        const { synonyms, antonyms, related, synonymTotal, antonymTotal, relatedTotal } =
          wordThesaurus(db, word, max, offset);
        const hits = section === "synonyms" ? synonyms : section === "antonyms" ? antonyms : related;
        const total = section === "synonyms" ? synonymTotal : section === "antonyms" ? antonymTotal : relatedTotal;
        return { rowsText: thesaurusRowList(hits), remaining: remaining(total, hits.length), error: null };
      }
      case "compounds": {
        const kanji = loadKanji(db, query, max, offset);
        if (!kanji) return { rowsText: "", remaining: 0, error: `no kanji "${query}"` };
        return { rowsText: kanjiCompoundRows(kanji), remaining: remaining(kanji.compoundTotal, kanji.compounds.length), error: null };
      }
      case "readings": {
        const { hits, total } = searchReadingPrefix(db, query.trim(), max, offset);
        return { rowsText: searchRowList("readings", hits), remaining: remaining(total, hits.length), error: null };
      }
      case "meanings": {
        const trimmed = query.trim();
        let ranked = meaningRankCache.get(trimmed);
        if (!ranked) {
          // Only ASCII queries produce a Meanings section; a cache miss (or
          // eviction) re-runs the ranked search — the one slow page.
          if (!isAscii(trimmed)) return { rowsText: "", remaining: 0, error: "no meaning matches for this query" };
          ranked = await searchMeanings(db, trimmed);
          meaningRankCache.set(trimmed, ranked);
          trimMeaningCache();
        }
        const hits = ranked.slice(offset, offset + max);
        return { rowsText: searchRowList("meanings", hits), remaining: remaining(ranked.length, hits.length), error: null };
      }
      case "kanji": {
        // searchKanjiByReading is uncapped: slice the full list for the window
        // and report what is still left past it.
        const all = searchKanjiByReading(db, query.trim());
        const hits = all.slice(offset, offset + max);
        return { rowsText: searchRowList("kanji", hits), remaining: remaining(all.length, hits.length), error: null };
      }
    }
  } catch (err) {
    return {
      rowsText: "",
      remaining: 0,
      error: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** "did you mean" hint — mirrors cli.ts searchHint. */
function webSearchHint(db: DbLike, query: string): string {
  const sug = suggestReading(db, query);
  if (sug && sug.reading) {
    const text = displayHeader(sug.word).text;
    return (
      `  hint: no gloss matches — did you mean「${text} [${sug.reading}] ${sug.gloss}」?\n` +
      `  readings match by prefix — try \`search ${sug.reading}\` (romaji: ${sug.romaji})\n`
    );
  }
  return (
    "  hint: no matches — readings match by kana or romaji prefix\n" +
    "  try e.g. `search genzou`, or the kanji reading search `kanji genzou`\n"
  );
}

