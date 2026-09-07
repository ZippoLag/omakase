/**
 * Web replica of the CLI command glue (src/cli.ts minus Node/arg parsing):
 * runs one `word` / `kanji` / `search` against the open dictionary and
 * renders the same output text the golden tests pin, so panes show exactly
 * what `omakase` prints — byte-for-byte, minus ANSI color.
 */
import type { DbLike } from "../../src/lookup.js";
import {
  displayHeader,
  exampleSentences,
  findWordByWriting,
  glossThesaurus,
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
import type { StrokePage } from "./worker-api.js";
import {
  KANJI_MAX_DEFAULT,
  renderExamples,
  renderKanji,
  renderKanjiReadingSearch,
  renderKanjiWords,
  searchSections,
  renderThesaurus,
  renderWordBody,
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
 * empty parts are skipped exactly like `filter(Boolean)`.
 */
export async function streamWord(
  db: DbLike,
  query: string,
  tags: Record<string, string>,
  emit: (label: string, text: string) => Promise<void> | void,
): Promise<StreamResult> {
  const word = findWordByWriting(db, query);
  if (!word) return { error: `no entry for "${query}"` };
  const body = renderWordBody(word, tags);
  if (body) await emit("body", body);
  let { synonyms, antonyms } = wordThesaurus(db, word);
  // Fallback for entries with no cross-reference links at all: related words
  // inferred from shared distinctive English gloss tokens (glosses_fts).
  if (synonyms.length === 0 && antonyms.length === 0) {
    synonyms = glossThesaurus(db, word).synonyms;
  }
  const thesaurus = renderThesaurus(synonyms, antonyms);
  if (thesaurus) await emit("thesaurus", "\n" + thesaurus);
  const examples = renderExamples(exampleSentences(db, word));
  if (examples) await emit("examples", "\n" + examples);
  return { error: null };
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
  emit: (label: string, text: string) => Promise<void> | void,
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
      await emit("page", renderKanji(kanji, radicalDisplay));
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
export async function streamSearch(
  db: DbLike,
  query: string,
  max: number = 30,
  emit: (label: string, text: string) => Promise<void> | void,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<StreamResult> {
  const trimmed = query.trim();
  // Reading rows are ranked and capped at `max` inside the lookup (SQL
  // LIMIT); `total` feeds the header/remainder note.
  const { hits: readings, total: readingsTotal } = searchReadingPrefix(db, trimmed, max);
  const meanings = isAscii(trimmed) ? await searchMeanings(db, trimmed, onProgress) : [];
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
  // Ladder labels per section, derived from what is actually present:
  // searchSections omits empty blocks, so an index-based label would misname
  // e.g. a meanings-only result as "readings" (under-claiming its floor) or
  // a kanji-only one as "readings" instead of "kanji". Mirror the same
  // presence rules in the same order; the one remaining shape is the sole
  // "(no results)" block, labeled "none".
  const labels = ["header"];
  if (shownReadings.length > 0) labels.push("readings");
  if (meanings.length > 0) labels.push("meanings");
  if (kanjiHits.length > 0) labels.push("kanji");
  if (labels.length === 1) labels.push("none"); // the "(no results)" block
  for (let i = 0; i < secs.length; i++) {
    await emit(labels[i]!, (i === 0 ? "" : "\n") + secs[i]!);
  }
  if (shownReadings.length === 0 && meanings.length === 0 && kanjiHits.length === 0 && isAscii(trimmed)) {
    await emit("hint", webSearchHint(db, trimmed));
  }
  return { error: null };
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

