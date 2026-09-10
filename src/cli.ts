/**
 * CLI command layer (M1): `word`, `kanji`, `search`.
 *
 * Each command reads from the read-only SQLite DB (dist/kanji.db) and returns
 * text produced by src/format.ts — byte-identical to the golden files.
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "../data/build/config.js";
import { VERSION_FULL } from "./version.js";
import { LICENSE_TEXT } from "./licenses.js";
import { strokeFrames } from "./strokes.js";
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
  searchMeanings,
  searchReadingPrefix,
  suggestReading,
  wordThesaurus,
  wordsContainingKanji,
} from "./lookup.js";
import type { SearchHit } from "./lookup.js";
import {
  renderExamples,
  renderSearch,
  renderThesaurus,
  renderWordBody,
  renderKanji,
  renderKanjiReadingSearch,
  renderKanjiWords,
  KANJI_MAX_DEFAULT,
  SEARCH_MAX_DEFAULT,
} from "./format.js";

type DB = InstanceType<typeof Database>;

/** Load the JMdict tag→description map stored in meta (CLI POS display). */
export function loadTags(db: DB): Record<string, string> {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'tags'").get() as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * `word <query> [--limit N] [--offset N]` — exact match on a writing. Renders
 * the entry body, then the thesaurus (top 5 synonyms/antonyms, when present),
 * then example sentences. `offset` starts the thesaurus window `offset` rows
 * in (each list shows rows N..N+5 with the remainder note).
 */
export function cmdWord(
  db: DB,
  query: string,
  tags: Record<string, string>,
  limit?: number,
  offset = 0,
): string | null {
  const word = findWordByWriting(db, query);
  if (!word) return null;
  const body = renderWordBody(word, tags, limit);
  let { synonyms, antonyms, synonymTotal, antonymTotal } = wordThesaurus(db, word, 5, offset);
  // Fallback for entries with no cross-reference links at all: related words
  // inferred from shared distinctive English gloss tokens (glosses_fts).
  if (synonyms.length === 0 && antonyms.length === 0) {
    const fallback = glossThesaurus(db, word, 5, offset);
    synonyms = fallback.synonyms;
    synonymTotal = fallback.synonymTotal;
  }
  const thesaurus = renderThesaurus(synonyms, antonyms, { synonymTotal, antonymTotal, offset });
  const examples = renderExamples(exampleSentences(db, word));
  return [body, thesaurus, examples].filter(Boolean).join("\n");
}

/**
 * `kanji <query> [-max N] [--offset N]` — when the query is one or more
 * kanji literals:
 *   - a multi-kanji query first lists words containing the characters
 *     (all before subsets, ranked), capped at `max`;
 *   - then renders one page per character (`kanji 制作者` ≡ `kanji 制` `kanji 作`
 *     `kanji 者`), each page's compounds capped at `max`;
 * otherwise fall back to the kanji-by-reading search (kana or romaji prefix
 * on on/kun/nanori readings), also capped at `max`. `offset` starts every
 * capped list `offset` rows in (words, compounds, reading rows), with the
 * remainder note counting what is left past the window.
 */
export function cmdKanji(db: DB, query: string, max: number = KANJI_MAX_DEFAULT, offset = 0): string | null {
  const literals = kanjiLiterals(db, query);
  if (literals) {
    const parts: string[] = [];
    if (literals.length > 1) {
      const words = wordsContainingKanji(db, literals, max, offset);
      const wordsText = renderKanjiWords(words.hits, words.total, max, offset);
      if (wordsText !== "") parts.push(wordsText);
    }
    for (const literal of literals) {
      const kanji = loadKanji(db, literal, max, offset);
      if (!kanji) return null; // every literal passed kanjiLiterals, so unreachable
      let radicalDisplay: string | null = null;
      if (kanji.classicalRadical != null) {
        radicalDisplay = `${radicalChar(db, kanji.classicalRadical) ?? "?"} (${kanji.classicalRadical})`;
      }
      parts.push(renderKanji(kanji, radicalDisplay, offset));
    }
    // No separator: every part ends with a newline, so the pages are
    // byte-identical to running `kanji 制` + `kanji 作` + `kanji 者` back to
    // back, with the ranked Words section slotted in front.
    return parts.join("");
  }
  const hits = searchKanjiByReading(db, query);
  if (hits.length === 0) return null;
  return renderKanjiReadingSearch(query, hits, max, offset);
}

/**
 * `kanji <literal> --strokes`: braille stroke-order frames — one frame per
 * stroke, each showing the glyph accumulated so far — rendered from the
 * KanjiVG svg that the stroke_order table points at (resolved under
 * `strokesDir`, the directory holding the database). The kvg stroke type
 * (e.g. ㇒) labels each frame when the svg carries one.
 *
 * Returns null (after writing an error to stderr) when the query is not a
 * single literal, the character has no stroke diagram, or its svg cannot be
 * read — the run then fails like any other kanji miss (no page, error on
 * stderr), since the flag made the query specific about what it wanted.
 */
function strokeOrderBlock(
  db: DB,
  query: string,
  strokesDir: string | undefined,
  stderr: (s: string) => void,
): string | null {
  const literals = kanjiLiterals(db, query);
  if (!literals || literals.length !== 1) {
    stderr(
      "error: --strokes needs a single kanji literal — e.g. `omakase kanji 食 --strokes`\n",
    );
    return null;
  }
  const literal = literals[0]!;
  const kanji = loadKanji(db, literal);
  if (!kanji || !kanji.strokeFile) {
    stderr(`no stroke-order data for "${literal}"\n`);
    return null;
  }
  if (!strokesDir) {
    stderr("error: stroke svg directory unavailable\n");
    return null;
  }
  const svgPath = join(strokesDir, "strokes", kanji.strokeFile);
  let svg: string;
  try {
    svg = readFileSync(svgPath, "utf8");
  } catch (err) {
    stderr(`error: cannot read stroke svg ${svgPath}: ${(err as Error).message}\n`);
    return null;
  }
  const { strokes, frames } = strokeFrames(svg);
  if (strokes.length === 0 || frames.length !== strokes.length) {
    stderr(`error: no stroke paths parsed from ${svgPath}\n`);
    return null;
  }
  const lines: string[] = [`Stroke order (${literal}, ${strokes.length} strokes):`, ""];
  frames.forEach((frame, i) => {
    const type = strokes[i]!.type;
    lines.push(`  ${i + 1}/${strokes.length}${type ? ` (${type})` : ""}`);
    for (const row of frame.split("\n")) lines.push("  " + row);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * `search <query>` sections:
 *   - readings — reading-prefix matches over kana text / stored romaji
 *     (ASCII input, incl. spaces typed between kana: `ta be ru` ≈ `taberu`)
 *   - meanings — English-gloss matches (ASCII input only): query tokens are
 *     ANDed and prefix-matched within a single sense, so `eat` finds “to
 *     eat” words and `develop film` finds 現像 “development (of film)”.
 *
 * An ASCII query shows BOTH ranked sections when it is genuinely ambiguous
 * (`take` → たけ readings AND “to take” meanings). But when the query has
 * real meaning hits and its reading matches are only accidental prefixes
 * (`eat` → エアタオル “eataoru”, never an exact reading), the meaning hits
 * are what was asked for and the Readings section is dropped — katakana
 * loans no longer crowd out “to eat” words.
 *
 * Reading rows are ranked and capped at `max` inside the lookup (SQL LIMIT),
 * so `search あ`-class prefixes never load every match; `readingsTotal`
 * reports the full pre-cap count so the renderer can show the remainder.
 */
export async function cmdSearch(
  db: DB,
  query: string,
  max: number = SEARCH_MAX_DEFAULT,
  offset = 0,
): Promise<{ readings: SearchHit[]; readingsTotal: number; meanings: SearchHit[] }> {
  const trimmed = query.trim();
  // Reading rows are SQL-ranked and capped at `max` rows, so a short prefix
  // never loads every match; with an offset the LIMIT grows to offset+max
  // (the renderer slices the window [offset, offset+max) out of it — the
  // SQL cap is preserved, at most offset+max words are ever loaded).
  const { hits: readings, total: readingsTotal } = searchReadingPrefix(db, trimmed, offset + max);
  const meanings = isAscii(trimmed) ? await searchMeanings(db, trimmed) : [];
  const keepReadings = isKanaInput(trimmed)
    || meanings.length === 0
    || readings.some((h) => h.exact);
  return {
    readings: keepReadings ? readings : [],
    readingsTotal: keepReadings ? readingsTotal : 0,
    meanings,
  };
}

function isAscii(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

/**
 * "did you mean" hint for an empty ASCII search: point at the reading-prefix
 * path. When `suggestReading` finds a candidate word from a relaxed gloss
 * token, name it and its reading; otherwise give a generic reading hint.
 */
function searchHint(db: DB, query: string): string {
  const sug = suggestReading(db, query);
  if (sug && sug.reading) {
    const text = displayHeader(sug.word).text;
    return (
      `  hint: no gloss matches — did you mean「${text} [${sug.reading}] ${sug.gloss}」?\n` +
      `  readings match by prefix — try \`omakase search ${sug.reading}\` (romaji: ${sug.romaji})\n`
    );
  }
  return (
    "  hint: no matches — readings match by kana or romaji prefix\n" +
    "  try e.g. `omakase search genzou`, or the kanji reading search `omakase kanji genzou`\n"
  );
}

// ---------------------------------------------------------------------------
// Dispatcher + main()
// ---------------------------------------------------------------------------

const COMMANDS = ["word", "kanji", "search"] as const;
type Command = (typeof COMMANDS)[number];

/** Base overview shown by `omakase --help` (also used for unknown/missing commands). */
const USAGE = `omakase ${VERSION_FULL}

Japanese quick-reference CLI (100% offline)

Usage:
  omakase <command> [args...]
  omakase --version           show the app and dictionary build versions
  omakase --license           show the full license & attribution text
  omakase --help              show this overview
  omakase <command> --help    show help for a specific command

Commands:
  word    dictionary entry + thesaurus (synonyms/antonyms) + example sentences
  kanji   kanji page (readings, meanings, compounds)
  search  English gloss / kana / romaji search

Run "omakase <command> --help" for details on a command.

Credits: by Sebastián R. Vansteenkiste (https://github.com/zippolag) via DeepSeek V4 Flash (https://www.deepseek.com/) @ FREEBUFF (https://freebuff.com/get-started?ref=ref-48e765cb-2146-4cf9-8fba-2a2af1676e77&referrer=Sebasti%C3%A1n+Vansteenkiste) (affiliate link)
Data: JMdict/KANJIDIC2/kradfile/radkfile (EDRDG, CC BY-SA 4.0) · KanjiVG (CC BY-SA 3.0) · Tatoeba (CC BY 2.0) — run "omakase --license" for the full text
`;

/** Detailed help per command, shown by `omakase <command> --help`. */
const COMMAND_HELP: Record<Command, string> = {
  word: `Usage:
  omakase word <writing> [--limit N] [--offset N]

Look up a dictionary entry for a word, matching on its kanji or kana spelling,
with a thesaurus: up to 5 related words (synonyms) and up to 5 antonyms,
taken from the entry's JMdict cross-references, extended with reverse links
and 2-hop closure materialized at build time. When an entry has no
cross-references at all, up to 5 related words are inferred from shared
English gloss tokens instead.

Arguments:
  <writing>      the word to look up (kanji or kana, e.g. 食べる)

Options:
  --limit N      show only the first N senses, with a trailing
                 "… and M more senses" note; also accepts --limit=N
  --offset N     start the thesaurus window N rows in; each paged list shows
                 rows N..N+5 with the remainder note (also accepts
                 --offset=N)

Examples:
  omakase word 食べる
  omakase word 為る --limit 3
  omakase word 行く --offset 5
`,
  kanji: `Usage:
  omakase kanji <query> [-max N] [--offset N]

When <query> is one or more kanji literals, render a kanji page per character
(stroke count, grade/JLPT/frequency, classical radical, a kradfile radical
breakdown, on/kun/nanori readings, meanings, compounds — the compounds
capped at N). A multi-kanji query ("kanji 制作者" ≡ "kanji 制" "kanji 作"
"kanji 者") first lists the words containing the characters — all of them
before subsets, ranked by how many are matched — capped at N, before the
per-kanji pages. Otherwise <query> is a reading: kanji whose
on/kun/nanori readings start with it are listed (kana or romaji, dot
separators ignored), capped at N.

Arguments:
  <query>        kanji literal(s) (e.g. 食, 制作者), kana, or romaji reading

Options:
  -max N / --max N   cap words / compounds / reading results at N rows
                     (default ${KANJI_MAX_DEFAULT}; also accepts --max=N or
                     -max N)
  --offset N     start every capped list (words, compounds, reading rows)
                 N rows in; each list shows rows N..N+M with the remainder
                 note (also accepts --offset=N)
  --strokes          render the stroke order of a single kanji literal as
                     braille frames (one frame per stroke, each showing the
                     glyph drawn so far) from its KanjiVG diagram

Examples:
  omakase kanji 食
  omakase kanji 制作者
  omakase kanji 制作者 --max 5
  omakase kanji まか
  omakase kanji makase
  omakase kanji 食 --strokes
  omakase kanji 食 --max 5 --offset 5
`,
  search: `Usage:
  omakase search <query> [--max N] [--offset N]

Search the dictionary, returning up to ${SEARCH_MAX_DEFAULT} hits per section
(raise the cap with --max). Results are split into ranked sections:
  - Readings: kana / romaji reading-prefix matches (e.g. たべ, taberu,
    "ta be ru"); each row shows its kana reading plus romaji
  - Meanings: English-gloss matches — the query's words are ANDed and
    prefix-matched within a single sense (e.g. "develop film" finds
    現像 "development (of film)"; "eat" finds "to eat" words)
  - Kanji: kanji whose on/kun/nanori readings start with the query
When a query is both a plausible reading and English (e.g. take → たけ,
ken → けん) the Readings and Meanings sections are both shown; when the
terminal supports it, the literal overlap of the query is bolded in each
result (the romaji for reading hits, the gloss for meaning hits).

Arguments:
  <query>        kana, romaji (single or multi-word), or an English gloss

Options:
  --max N        show at most N hits per section instead of
                 ${SEARCH_MAX_DEFAULT} (also accepts --max=N or -max N)
  --offset N     start the result window N rows in; each paged list shows
                 rows N..N+M with the remainder note (also accepts
                 --offset=N)

Examples:
  omakase search たべ
  omakase search taberu
  omakase search "ta be ru"
  omakase search "develop film"
  omakase search take
  omakase search eat --max 10
  omakase search eat --max 10 --offset 10
`,
};

/** Flags that take a separate following value, per the USAGE text (e.g. `--limit 3`). */
const VALUE_FLAGS = new Set(["limit", "max", "offset"]);

function parseArgs(argv: string[]): { args: string[]; flags: Map<string, string | null> } {
  const args: string[] = [];
  const flags = new Map<string, string | null>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      flags.set(a === "-h" ? "h" : "help", null);
      continue;
    }
    // `-max` is accepted as an alias of `--max` (single-dash, like `-h`);
    // other single-dash args stay positional so `search -ing` still queries.
    const long = a.startsWith("--") || /^-max($|=)/.test(a);
    if (!long) {
      args.push(a);
      continue;
    }
    const [k, ...rest] = (a.startsWith("--") ? a.slice(2) : a.slice(1)).split("=");
    if (!k) continue;
    if (rest.length) {
      // `--limit=2` / `--max=2` (equals form)
      flags.set(k, rest.join("="));
    } else if (VALUE_FLAGS.has(k)) {
      // `--limit 2` (space form): consume the following value token.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(k, next);
        i++;
      } else {
        flags.set(k, null);
      }
    } else {
      flags.set(k, null);
    }
  }
  return { args, flags };
}

/**
 * `omakase --version`: the app stamp always; the dictionary's own build stamp
 * from the DB meta when the database exists (readonly, best-effort).
 */
function versionLine(dbPath: string): string {
  const app = `omakase ${VERSION_FULL}`;
  let dict: string | null = null;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
      if (row) dict = row.value;
    } finally {
      db.close();
    }
  } catch {
    /* no database (or unreadable) — app version only */
  }
  return dict ? `${app}\ndictionary build: ${dict}` : app;
}

/**
 * `--max` cap for search sections: a positive integer, defaulting to
 * SEARCH_MAX_DEFAULT. Prints an error (and returns null) when invalid.
 */
function searchMax(flags: Map<string, string | null>, stderr: (s: string) => void): number | null {
  const raw = flags.get("max");
  if (raw === null || raw === undefined) return SEARCH_MAX_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    stderr("error: --max must be a positive integer\n");
    return null;
  }
  return n;
}

/**
 * `--offset` window start for word/kanji/search: a non-negative integer
 * (0 allowed), defaulting to 0. Prints an error (and returns null) when
 * invalid.
 */
function searchOffset(flags: Map<string, string | null>, stderr: (s: string) => void): number | null {
  const raw = flags.get("offset");
  if (raw === null || raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    stderr("error: --offset must be a non-negative integer\n");
    return null;
  }
  return n;
}

/** Run one command against an open DB, returning its output (or null for error+exit). */
export async function runCommand(
  db: DB,
  command: string,
  query: string | undefined,
  flags: Map<string, string | null>,
  stderr: (s: string) => void,
  opts: { color?: boolean; strokesDir?: string } = {},
): Promise<string | null> {
  const tags = loadTags(db);
  switch (command) {
    case "word": {
      if (!query) {
        stderr("error: word requires a query\n");
        return "";
      }
      const limitStr = flags.get("limit");
      const limit = limitStr ? Number(limitStr) : undefined;
      const offsetWord = searchOffset(flags, stderr);
      if (offsetWord === null) return "";
      const out = cmdWord(db, query, tags, limit, offsetWord);
      if (!out) {
        stderr(`no entry for "${query}"\n`);
        return "";
      }
      return out;
    }
    case "kanji": {
      if (!query) {
        stderr("error: kanji requires a literal\n");
        return "";
      }
      const max = searchMax(flags, stderr);
      if (max === null) return "";
      const offsetKanji = searchOffset(flags, stderr);
      if (offsetKanji === null) return "";
      const out = cmdKanji(db, query, max, offsetKanji);
      if (!out) {
        stderr(`no kanji "${query}"\n`);
        return "";
      }
      if (flags.has("strokes")) {
        const block = strokeOrderBlock(db, query, opts.strokesDir, stderr);
        if (block === null) return "";
        // Stroke-order art first (the flag asks to see the drawing); the
        // page follows below it.
        return block + "\n" + out;
      }
      return out;
    }
    case "search": {
      if (!query) {
        stderr("error: search requires a query\n");
        return "";
      }
      const trimmed = query.trim();
      const max = searchMax(flags, stderr);
      if (max === null) return "";
      const offsetSearch = searchOffset(flags, stderr);
      if (offsetSearch === null) return "";
      const { readings, readingsTotal, meanings } = await cmdSearch(db, trimmed, max, offsetSearch);
      // Surface kanji whose readings start with the query too (Tangorin-style).
      const kanjiHits = isKanaInput(trimmed) || isAscii(trimmed)
        ? searchKanjiByReading(db, trimmed)
        : [];
      const out = renderSearch(trimmed, readings, meanings, kanjiHits, {
        max,
        offset: offsetSearch,
        color: opts.color ?? false,
        totals: { readings: readingsTotal },
      });
      // An ASCII search that found nothing (readings, meanings, kanji) gets a
      // "did you mean" hint pointing at the reading-prefix path — a reading is
      // almost always how the word is actually searched.
      if (readings.length === 0 && meanings.length === 0 && kanjiHits.length === 0 && isAscii(trimmed)) {
        return out + searchHint(db, trimmed);
      }
      return out;
    }
    default:
      stderr(USAGE);
      return "";
  }
}

/** Entrypoint shared by the bin. Reads argv and DB path, prints result. */
export async function main(
  argv: string[],
  dbPath: string,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
  opts: { color?: boolean } = {},
): Promise<number> {
  const [command, ...rest] = argv;

  // Base help: `omakase --help` / `-h`. A missing command also shows help
  // (to stdout) but exits non-zero since no command was invoked.
  if (!command) {
    stdout(USAGE);
    return 1;
  }
  if (command === "--help" || command === "-h") {
    stdout(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-V") {
    stdout(versionLine(dbPath) + "\n");
    return 0;
  }
  // The license text is embedded in the CLI itself (src/licenses.ts), so it
  // prints even when omakase is installed without the source tree (no
  // LICENSE.md on disk) — and never opens the database.
  if (command === "--license" || command === "--licenses") {
    stdout(LICENSE_TEXT);
    return 0;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    stderr(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  const { args, flags } = parseArgs(rest);

  // Per-command help: `omakase <command> --help` / `-h`.
  if (flags.has("help") || flags.has("h")) {
    stdout(COMMAND_HELP[command as Command]);
    return 0;
  }

  let db: DB;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    stderr(`cannot open database at ${dbPath} — run \`pnpm run build:db\` first.\n${(err as Error).message}\n`);
    return 1;
  }

  try {
    const out = await runCommand(
      db, command, args[0], flags, stderr,
      { color: opts.color, strokesDir: dirname(dbPath) },
    );
    if (out === null) return 2;
    if (out !== "") stdout(out);
    return 0;
  } finally {
    db.close();
  }
}

export { DB_PATH };

/** Called from the bin / npm cli script with the real process args. */
export async function cli(argv: string[]): Promise<number> {
  return main(
    argv,
    process.env.JAPANESE_DB ?? DB_PATH,
    process.stdout.write.bind(process.stdout),
    process.stderr.write.bind(process.stderr),
    { color: !!process.stdout.isTTY },
  );
}

// Run directly: `tsx src/cli.ts word 食べる`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await cli(process.argv.slice(2));
}