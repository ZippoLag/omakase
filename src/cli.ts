/**
 * CLI command layer (M1): `word`, `kanji`, `search`.
 *
 * Each command reads from the read-only SQLite DB (dist/kanji.db) and returns
 * text produced by src/format.ts — byte-identical to the golden files.
 */
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { DB_PATH } from "../data/build/config.js";
import {
  exampleSentences,
  findWordByWriting,
  glossThesaurus,
  isKanaInput,
  loadKanji,
  radicalChar,
  searchGloss,
  searchKanjiByReading,
  searchReadingPrefix,
  wordThesaurus,
} from "./lookup.js";
import type { SearchHit } from "./lookup.js";
import {
  renderExamples,
  renderSearch,
  renderThesaurus,
  renderWordBody,
  renderKanji,
  renderKanjiReadingSearch,
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
 * `word <query> [--limit N]` — exact match on a writing. Renders the entry
 * body, then the thesaurus (top 5 synonyms/antonyms, when present), then
 * example sentences.
 */
export function cmdWord(
  db: DB,
  query: string,
  tags: Record<string, string>,
  limit?: number,
): string | null {
  const word = findWordByWriting(db, query);
  if (!word) return null;
  const body = renderWordBody(word, tags, limit);
  let { synonyms, antonyms } = wordThesaurus(db, word);
  // Fallback for entries with no cross-reference links at all: related words
  // inferred from shared distinctive English gloss tokens (glosses_fts).
  if (synonyms.length === 0 && antonyms.length === 0) {
    synonyms = glossThesaurus(db, word).synonyms;
  }
  const thesaurus = renderThesaurus(synonyms, antonyms);
  const examples = renderExamples(exampleSentences(db, word));
  return [body, thesaurus, examples].filter(Boolean).join("\n");
}

/**
 * `kanji <query>` — kanji page when the query is a literal, otherwise a
 * kanji-by-reading search (kana or romaji prefix on on/kun/nanori readings).
 */
export function cmdKanji(db: DB, query: string): string | null {
  const kanji = loadKanji(db, query);
  if (kanji) {
    let radicalDisplay: string | null = null;
    if (kanji.classicalRadical != null) {
      radicalDisplay = `${radicalChar(db, kanji.classicalRadical) ?? "?"} (${kanji.classicalRadical})`;
    }
    return renderKanji(kanji, radicalDisplay);
  }
  const hits = searchKanjiByReading(db, query);
  if (hits.length === 0) return null;
  return renderKanjiReadingSearch(query, hits);
}

/**
 * `search <query>`:
 *   - kana input  → reading-prefix (kana text)
 *   - ASCII input → romaji reading-prefix over the romaji column; a hit whose
 *                   romaji *equals* the whole query counts as reading intent
 *                   (e.g. `taberu` → 食べる). Otherwise an English gloss-token
 *                   match is preferred when present (e.g. `eat` → “to eat”
 *                   words, not エアターミナル “eataminaru”), with partial
 *                   romaji prefixes as the last resort.
 */
export function cmdSearch(db: DB, query: string): SearchHit[] {
  const trimmed = query.trim();
  const hits = searchReadingPrefix(db, trimmed);
  if (hits.length === 0) return isAscii(trimmed) ? searchGloss(db, trimmed) : hits;
  if (!isAscii(trimmed)) return hits; // kana input: reading prefix wins
  const exact = db.prepare(
    "SELECT 1 FROM writings WHERE kind = 'kana' AND romaji = ? LIMIT 1",
  ).get(trimmed.toLowerCase());
  if (exact) return hits;
  const gloss = searchGloss(db, trimmed);
  return gloss.length > 0 ? gloss : hits;
}

function isAscii(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

// ---------------------------------------------------------------------------
// Dispatcher + main()
// ---------------------------------------------------------------------------

const COMMANDS = ["word", "kanji", "search"] as const;
type Command = (typeof COMMANDS)[number];

/** Base overview shown by `omakase --help` (also used for unknown/missing commands). */
const USAGE = `Japanese quick-reference CLI (100% offline)

Usage:
  omakase <command> [args...]
  omakase --help              show this overview
  omakase <command> --help    show help for a specific command

Commands:
  word    dictionary entry + thesaurus (synonyms/antonyms) + example sentences
  kanji   kanji page (readings, meanings, compounds)
  search  English gloss / kana / romaji search

Run "omakase <command> --help" for details on a command.
`;

/** Detailed help per command, shown by `omakase <command> --help`. */
const COMMAND_HELP: Record<Command, string> = {
  word: `Usage:
  omakase word <writing> [--limit N]

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

Examples:
  omakase word 食べる
  omakase word 為る --limit 3
`,
  kanji: `Usage:
  omakase kanji <query>

Render a kanji page (stroke count, grade/JLPT/frequency, classical radical,
on/kun/nanori readings, meanings, compounds) when <query> is a kanji
literal. Otherwise <query> is a reading: kanji whose on/kun/nanori readings
start with it are listed (kana or romaji, dot separators ignored).

Arguments:
  <query>        a kanji literal (e.g. 食), kana, or romaji reading

Examples:
  omakase kanji 食
  omakase kanji まか
  omakase kanji makase
`,
  search: `Usage:
  omakase search <query>

Search the dictionary. How the query is interpreted depends on its form:
  - kana input  → reading-prefix match (e.g. たべ)
  - ASCII input → romaji reading-prefix match (e.g. taberu); an exact
                  reading wins, otherwise an English gloss token search
                  is preferred when present (e.g. "eat")
  - kanji whose readings start with the query are appended in a
    "Kanji:" section (e.g. まか → 任)

Arguments:
  <query>        kana, romaji, or an English gloss

Examples:
  omakase search たべ
  omakase search taberu
  omakase search eat
`,
};

/** Flags that take a separate following value, per the USAGE text (e.g. `--limit 3`). */
const VALUE_FLAGS = new Set(["limit"]);

function parseArgs(argv: string[]): { args: string[]; flags: Map<string, string | null> } {
  const args: string[] = [];
  const flags = new Map<string, string | null>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      flags.set(a === "-h" ? "h" : "help", null);
      continue;
    }
    if (!a.startsWith("--")) {
      args.push(a);
      continue;
    }
    const [k, ...rest] = a.slice(2).split("=");
    if (!k) continue;
    if (rest.length) {
      // `--limit=2` (equals form)
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

/** Run one command against an open DB, returning its output (or null for error+exit). */
export function runCommand(
  db: DB,
  command: string,
  query: string | undefined,
  flags: Map<string, string | null>,
  stderr: (s: string) => void,
): string | null {
  const tags = loadTags(db);
  switch (command) {
    case "word": {
      if (!query) {
        stderr("error: word requires a query\n");
        return "";
      }
      const limitStr = flags.get("limit");
      const limit = limitStr ? Number(limitStr) : undefined;
      const out = cmdWord(db, query, tags, limit);
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
      const out = cmdKanji(db, query);
      if (!out) {
        stderr(`no kanji "${query}"\n`);
        return "";
      }
      return out;
    }
    case "search": {
      if (!query) {
        stderr("error: search requires a query\n");
        return "";
      }
      const trimmed = query.trim();
      const hits = cmdSearch(db, trimmed);
      // Surface kanji whose readings start with the query too (Tangorin-style).
      const kanjiHits = isKanaInput(trimmed) || isAscii(trimmed)
        ? searchKanjiByReading(db, trimmed)
        : [];
      return renderSearch(query, hits, kanjiHits);
    }
    default:
      stderr(USAGE);
      return "";
  }
}

/** Entrypoint shared by the bin. Reads argv and DB path, prints result. */
export function main(
  argv: string[],
  dbPath: string,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): number {
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
    const out = runCommand(db, command, args[0], flags, stderr);
    if (out === null) return 2;
    if (out !== "") stdout(out);
    return 0;
  } finally {
    db.close();
  }
}

export { DB_PATH };

/** Called from the bin / npm cli script with the real process args. */
export function cli(argv: string[]): number {
  return main(argv, process.env.JAPANESE_DB ?? DB_PATH, process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr));
}

// Run directly: `tsx src/cli.ts word 食べる`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = cli(process.argv.slice(2));
}