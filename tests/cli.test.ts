/**
 * CLI tests.
 *
 * Help handling (`omakase --help` / `omakase <command> --help`) must not
 * require (or open) the database, and is tested with a bogus DB path — plus
 * the full end-to-end paths (real commands against a fixture DB on disk):
 * exit codes, stderr error messages, and `--limit` flag parsing through the
 * real `main()` → `parseArgs` → `runCommand` wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { main } from "../src/cli.js";
import { LICENSE_TEXT } from "../src/licenses.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { transform } from "../data/build/transform.js";
import { buildDb } from "../data/build/buildDb.js";

const FIXTURES = "tests/fixtures";

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Run `main` with captured stdout/stderr; the DB path is never reached. */
async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(
    argv,
    "/nonexistent/kanji.db", // help returns before opening the DB
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
  );
  return { code, stdout, stderr };
}

/**
 * Build the fixture DB on disk (main() opens it readonly) through the REAL
 * transform/buildDb pipeline, and return the DB path plus its temp dir so the
 * caller can clean up.
 */
function buildFixtureDbFile(): { dbPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "omakase-cli-"));
  const dbPath = join(dir, "kanji.db");
  const entries = readdirSync(join(FIXTURES, "entries")).filter((f) => !f.startsWith("_") && f.endsWith(".json"));
  const words = entries.filter((f) => f.startsWith("jmdict-")).map((f) => loadJson<unknown>(join(FIXTURES, "entries", f)));
  const characters = entries.filter((f) => f.startsWith("kanjidic2-")).map((f) => loadJson<unknown>(join(FIXTURES, "entries", f)));
  const krad: { version: string; kanji: Record<string, string[]> } = { version: "", kanji: {} };
  const radk: { version: string; radicals: Record<string, { strokeCount: number; code: string | null; kanji: string[] }> } = { version: "", radicals: {} };
  for (const f of entries) {
    if (f.startsWith("krad-")) {
      const s = loadJson<{ literal: string; components: string[] }>(join(FIXTURES, "entries", f));
      krad.kanji[s.literal] = s.components;
    }
    if (f.startsWith("radk-")) {
      const s = loadJson<{ strokeCount?: number; code?: string | null; kanji?: string[] }>(join(FIXTURES, "entries", f));
      const lit = f.slice(5, -5);
      radk.radicals[lit] = { strokeCount: s.strokeCount ?? 0, code: s.code ?? null, kanji: s.kanji ?? [] };
    }
  }
  const furigana = entries
    .filter((f) => f.startsWith("furigana-"))
    .flatMap((f) => loadJson<unknown[]>(join(FIXTURES, "entries", f)));
  const rows = transform({ words } as never, { characters } as never, krad, radk, furigana as never);
  const tags = loadJson<Record<string, string>>(join(FIXTURES, "meta", "tags.json"));
  const db = buildDb(rows, {
    tags: JSON.stringify(tags),
    // A dictionary build stamp, as build:db writes it — exercised by --version.
    version: "0.1.0-build.999 (999 commits, abcdef0)",
  }, { dbPath });
  try {
    // Seed sentences in sorted-filename order (ids 1..n), like lookups.test.ts.
    const insert = db.prepare("INSERT INTO sentences (id, japanese, english) VALUES (?, ?, ?)");
    const files = readdirSync(join(FIXTURES, "sentences")).filter((f) => f.endsWith(".json")).sort();
    const tx = db.transaction(() => {
      files.forEach((f, i) => {
        const s = loadJson<{ japanese: string; english: string }>(join(FIXTURES, "sentences", f));
        insert.run(i + 1, s.japanese, s.english);
      });
    }) as () => void;
    tx();
    // stroke_order rows + svg files (from the fixture strokes) so the
    // `kanji <lit> --strokes` end-to-end tests resolve a real diagram.
    const strokeIns = db.prepare("INSERT INTO stroke_order (kanji, svg_file) VALUES (?, ?)");
    strokeIns.run("食", "098df.svg");
    strokeIns.run("水", "06c34.svg");
  } finally {
    db.close();
  }
  // Copy the stroke diagrams next to the DB (the CLI resolves dist/strokes
  // relative to the database path).
  mkdirSync(join(dir, "strokes"), { recursive: true });
  copyFileSync(join(FIXTURES, "strokes", "098df.svg"), join(dir, "strokes", "098df.svg"));
  copyFileSync(join(FIXTURES, "strokes", "06c34.svg"), join(dir, "strokes", "06c34.svg"));
  return { dbPath, dir };
}

/** Run `main` against an on-disk fixture DB (opened readonly), capturing output. */
async function runOnDb(argv: string[], dbPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(
    argv,
    dbPath,
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
  );
  return { code, stdout, stderr };
}

test("no args: shows base help on stdout, exits 1", async () => {
  const { code, stdout } = await run([]);
  assert.equal(code, 1);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(/omakase <command> \[args\.\.\.\]/.test(stdout));
});

test("--help: shows base help listing all commands, exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout, stderr } = await run([flag]);
    assert.equal(code, 0, `${flag} exit code`);
    assert.equal(stderr, "", `${flag} writes no error`);
    assert.ok(stdout.includes("Japanese quick-reference CLI"));
    for (const cmd of ["word", "kanji", "search"]) {
      assert.ok(stdout.includes(cmd), `${flag} lists command: ${cmd}`);
    }
  }
});

test("word --help: detailed usage with --limit, exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout } = await run(["word", flag]);
    assert.equal(code, 0);
    assert.ok(stdout.includes("omakase word <writing>"));
    assert.ok(stdout.includes("--limit N"));
  }
});

test("kanji --help: detailed usage with <query> (literal or reading), exits 0", async () => {
  const { code, stdout } = await run(["kanji", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("omakase kanji <query>"));
  assert.ok(stdout.includes("stroke count"));
});

test("search --help: detailed usage describing input forms, exits 0", async () => {
  const { code, stdout } = await run(["search", "-h"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("omakase search <query>"));
  assert.ok(stdout.includes("prefix-matched"));
});

test("unknown command: error to stderr with base help, exits 2", async () => {
  const { code, stdout, stderr } = await run(["bogus"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("unknown command: bogus"));
  assert.ok(stderr.includes("Usage:"));
});

test("help wins over a missing database", async () => {
  // The dbPath is bogus; help must still succeed because it never opens the DB.
  const { code, stdout } = await run(["word", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("omakase word"));
});

test("--version / -V: prints the app version without opening the DB", async () => {
  for (const flag of ["--version", "-V"]) {
    const { code, stdout, stderr } = await run([flag]); // bogus DB path — must not be opened
    assert.equal(code, 0, `${flag} exit code`);
    assert.equal(stderr, "", `${flag} writes no error`);
    assert.match(stdout, /^omakase \d+\.\d+\.\d+-build\.\d+ \(/, `${flag} stamp line`);
    assert.ok(stdout.includes("commits"), `${flag} shows git provenance`);
    assert.equal(stdout.trim().split("\n").length, 1, `${flag} app line only (no DB)`);
  }
});

test("--license / --licenses: prints the full embedded license without opening the DB", async () => {
  for (const flag of ["--license", "--licenses"]) {
    const { code, stdout, stderr } = await run([flag]); // bogus DB path — must not be opened
    assert.equal(code, 0, `${flag} exit code`);
    assert.equal(stderr, "", `${flag} writes no error`);
    assert.ok(stdout.includes("Sebastián R. Vansteenkiste"), `${flag} has the author credit`);
    assert.ok(stdout.includes("Permission is hereby granted"), `${flag} has the MIT text`);
    assert.ok(stdout.includes("CC BY-SA 4.0"), `${flag} has the data licenses`);
    assert.ok(stdout.includes("EDRDG"), `${flag} has the EDRDG attribution`);
    assert.ok(stdout.includes("Disclaimer"), `${flag} has the disclaimers`);
  }
});

test("the embedded license text matches LICENSE.md byte-for-byte", async () => {
  const file = readFileSync(join(ROOT, "LICENSE.md"), "utf8");
  assert.equal(LICENSE_TEXT, file);
});

test("--version with a database: app line plus the dictionary build stamp", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const { code, stdout, stderr } = await runOnDb(["--version"], dbPath);
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^omakase \d+\.\d+\.\d+-build\.\d+/);
    assert.ok(stdout.includes("dictionary build: 0.1.0-build.999 (999 commits, abcdef0)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- end-to-end: real commands against an on-disk fixture DB ---------------

test("word <query>: real DB lookup exits 0 and prints the entry + examples", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const { code, stdout, stderr } = await runOnDb(["word", "食べる"], dbPath);
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.ok(stdout.includes("食べる [たべる] (common)"));
    assert.ok(stdout.includes("1. to eat"));
    assert.ok(stdout.includes("Examples:"));

    // Kana-only entries resolve too.
    const kanaOnly = await runOnDb(["word", "いい"], dbPath);
    assert.equal(kanaOnly.code, 0);
    assert.ok(kanaOnly.stdout.includes("いい [いい] (common)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("word --limit N: space and equals flag forms both truncate senses", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    // 食べる has 2 senses; --limit 1 (space form) shows the first only.
    const space = await runOnDb(["word", "食べる", "--limit", "1"], dbPath);
    assert.equal(space.code, 0);
    assert.ok(space.stdout.includes("  1. to eat"));
    assert.ok(!space.stdout.includes("  2. to live on"));
    assert.ok(space.stdout.includes("… and 1 more senses"));

    // --limit=2 (equals form) keeps both senses, no trailing note.
    const eq = await runOnDb(["word", "食べる", "--limit=2"], dbPath);
    assert.equal(eq.code, 0);
    assert.ok(eq.stdout.includes("  2. to live on"));
    assert.ok(!eq.stdout.includes("more senses"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("word --offset: windows the thesaurus with its per-block remainder notes", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    // The synthetic ぺーじんぐ entry carries 7 related + 8 antonym links:
    // --offset 1 shows rows [1, 6) of each block with the note counting what
    // remains past the whole window (1 related, 2 antonyms). Its xrefs are
    // one-way, so they render as Related — never as Synonyms.
    const { code, stdout } = await runOnDb(["word", "ぺーじんぐ", "--offset", "1"], dbPath);
    assert.equal(code, 0);
    assert.ok(stdout.includes("Antonyms:") && stdout.includes("Related:"), stdout);
    assert.ok(!stdout.includes("Synonyms:"), stdout);
    assert.ok(stdout.includes("  … and 2 more"), stdout);
    assert.ok(stdout.includes("  … and 1 more"), stdout);
    // The equals form matches the space form, and --offset 0 the plain command.
    assert.equal((await runOnDb(["word", "ぺーじんぐ", "--offset=1"], dbPath)).stdout, stdout);
    const zero = await runOnDb(["word", "ぺーじんぐ", "--offset", "0"], dbPath);
    const plain = await runOnDb(["word", "ぺーじんぐ"], dbPath);
    assert.equal(zero.stdout, plain.stdout);
    // Past the end of both lists the thesaurus section disappears entirely.
    const past = await runOnDb(["word", "ぺーじんぐ", "--offset", "8"], dbPath);
    assert.equal(past.code, 0);
    assert.ok(!past.stdout.includes("Antonyms:") && !past.stdout.includes("Related:"), past.stdout);
    // Invalid values are errors on stderr, no output.
    const bad = await runOnDb(["word", "ぺーじんぐ", "--offset", "-1"], dbPath);
    assert.equal(bad.stdout, "");
    assert.ok(bad.stderr.includes("error: --offset must be a non-negative integer"), bad.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("word <missing>: error to stderr, no stdout (exits 0)", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const { code, stdout, stderr } = await runOnDb(["word", "存在しない"], dbPath);
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.ok(stderr.includes('no entry for "存在しない"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing query: word/kanji/search each write an error to stderr", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const cases: [string[], string][] = [
      [["word"], "error: word requires a query"],
      [["kanji"], "error: kanji requires a literal"],
      [["search"], "error: search requires a query"],
    ];
    for (const [argv, message] of cases) {
      const { code, stdout, stderr } = await runOnDb(argv, dbPath);
      assert.equal(code, 0, `${argv.join(" ")} exit code`);
      assert.equal(stdout, "");
      assert.ok(stderr.includes(message), `${argv.join(" ")} stderr: expected ${message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kanji --strokes: braille stroke-order frames lead the page", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const { code, stdout, stderr } = await runOnDb(["kanji", "水", "--strokes"], dbPath);
    assert.equal(code, 0);
    assert.equal(stderr, "");
    // The stroke block comes first (art on top), then the normal page.
    assert.ok(stdout.startsWith("Stroke order (水, 4 strokes):\n"), stdout.slice(0, 60));
    // One labelled frame per stroke, with the kvg stroke type.
    for (const [label, type] of [["1/4", "㇚"], ["2/4", "㇇"], ["3/4", "㇒"], ["4/4", "㇏"]] as const) {
      assert.ok(stdout.includes(`\n  ${label} (${type})\n`), `frame label ${label}`);
    }
    // Frames are braille rows (each grid row starts with a U+2800+ cell).
    const frameRows = stdout.split("\n").filter((l) => /^  [\u2800-\u28ff]+$/.test(l));
    assert.ok(frameRows.length >= 80, `braille rows present (${frameRows.length})`);
    // The page follows after the frames.
    assert.ok(stdout.includes("\n\n水  [4 strokes]\n"), "page follows the block");
    assert.ok(stdout.includes("Meanings:\n     water"), "page body intact");
    // Deterministic: identical input renders identical output.
    const again = await runOnDb(["kanji", "水", "--strokes"], dbPath);
    assert.equal(again.stdout, stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kanji --strokes: errors for multi-literal, reading queries, and no diagram", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    // Multi-literal: one kanji at a time.
    const multi = await runOnDb(["kanji", "飲食", "--strokes"], dbPath);
    assert.equal(multi.code, 0);
    assert.equal(multi.stdout, "");
    assert.ok(multi.stderr.includes("error: --strokes needs a single kanji literal"), multi.stderr);
    // Reading query (kana): no page to draw.
    const reading = await runOnDb(["kanji", "たべ", "--strokes"], dbPath);
    assert.equal(reading.stdout, "");
    assert.ok(reading.stderr.includes("error: --strokes needs a single kanji literal"), reading.stderr);
    // 喰 has a kanji page but no stroke_order row in the fixtures.
    const none = await runOnDb(["kanji", "喰", "--strokes"], dbPath);
    assert.equal(none.code, 0);
    assert.equal(none.stdout, "");
    assert.ok(none.stderr.includes('no stroke-order data for "喰"'), none.stderr);
    // A plain page (no flag) never mentions strokes and stays byte-identical.
    const plain = await runOnDb(["kanji", "水"], dbPath);
    assert.ok(!plain.stdout.includes("Stroke order"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kanji: literal page and reading search both work end-to-end", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const lit = await runOnDb(["kanji", "食"], dbPath);
    assert.equal(lit.code, 0);
    assert.ok(lit.stdout.includes("食  [9 strokes]"));
    assert.ok(lit.stdout.includes("Compounds:"));

    // Reading-search branch (kana or romaji): 水's kun みず → "mizu".
    // (The entry lists both kun readings みず / みず-, so match the row prefix.)
    const romaji = await runOnDb(["kanji", "mizu"], dbPath);
    assert.equal(romaji.code, 0);
    assert.ok(romaji.stdout.includes("  水  [みず"));

    const noMatch = await runOnDb(["kanji", "無"], dbPath);
    assert.equal(noMatch.code, 0);
    assert.equal(noMatch.stdout, "");
    assert.ok(noMatch.stderr.includes('no kanji "無"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search: meaning + reading sections, Kanji section, and empty result", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const gloss = await runOnDb(["search", "eat"], dbPath);
    assert.equal(gloss.code, 0);
    assert.ok(gloss.stdout.includes("Meanings (2):"));
    assert.ok(gloss.stdout.includes("食べる  [たべる]\n     to eat"));
    assert.ok(!gloss.stdout.includes("Readings ("), "no reading hits for eat");

    const kana = await runOnDb(["search", "たべ"], dbPath);
    assert.equal(kana.code, 0);
    assert.ok(kana.stdout.includes("Readings (2):"));
    assert.ok(kana.stdout.includes("食べ物  [たべもの (tabemono)]"));
    assert.ok(kana.stdout.includes("Kanji (1):"));
    assert.ok(kana.stdout.includes("食  [た.べる]"));

    const empty = await runOnDb(["search", "zqxjk"], dbPath);
    assert.equal(empty.code, 0);
    assert.ok(empty.stdout.includes("(no results)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search --offset: windows the result rows (space/equals forms, invalid values)", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    // たべ has 2 reading hits; --offset 1 --max 1 shows the SECOND row
    // (window [1, 2)) with no remainder note.
    for (const argv of [
      ["search", "たべ", "--offset", "1", "--max", "1"],
      ["search", "たべ", "--offset=1", "--max=1"],
    ]) {
      const { code, stdout } = await runOnDb(argv, dbPath);
      assert.equal(code, 0, `${argv.join(" ")} exit code`);
      assert.ok(stdout.includes("Readings (2):"), `${argv.join(" ")} header counts the full section`);
      assert.ok(stdout.includes("食べ物  [たべもの (tabemono)]"), `${argv.join(" ")} second row shown`);
      assert.ok(!stdout.includes("食べる"), `${argv.join(" ")} first row skipped`);
      assert.ok(!stdout.includes("  … and "), `${argv.join(" ")} no note at the window end`);
    }
    // A mid-list window keeps the remainder note: `search to` has 12 meaning
    // hits, so [1, 6) shows 5 rows with 6 still to come.
    const note = await runOnDb(["search", "to", "--offset", "1", "--max", "5"], dbPath);
    assert.equal(note.code, 0);
    assert.ok(note.stdout.includes("Meanings (12):"));
    assert.ok(note.stdout.includes("  … and 6 more"));
    // --offset 0 is allowed and identical to omitting it.
    const zero = await runOnDb(["search", "eat", "--offset", "0"], dbPath);
    const plain = await runOnDb(["search", "eat"], dbPath);
    assert.equal(zero.code, 0);
    assert.equal(zero.stdout, plain.stdout);
    // Invalid values are errors on stderr, no output.
    for (const bad of ["-1", "abc", "1.5"]) {
      const { code, stdout, stderr } = await runOnDb(["search", "eat", "--offset", bad], dbPath);
      assert.equal(code, 0);
      assert.equal(stdout, "");
      assert.ok(stderr.includes("error: --offset must be a non-negative integer"), stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kanji --offset: pages compounds with the remainder note", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    // 食 has 5 compound words; --max 2 --offset 2 shows rows [2, 4) (食べもの,
    // 食事) with 1 still to come.
    const { code, stdout } = await runOnDb(["kanji", "食", "--max", "2", "--offset", "2"], dbPath);
    assert.equal(code, 0);
    assert.ok(stdout.includes("食べもの  [食[た]べもの]"), stdout);
    assert.ok(stdout.includes("食事  [食[しょく]事[じ]]"), stdout);
    assert.ok(!stdout.includes("食べる  [食[た]べる]"), "first compound skipped");
    assert.ok(stdout.includes("  … and 1 more"), stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search --max/-max: caps a section (space, equals, and -max forms)", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    // たべ hits 2 readings; --max 1 shows the first and notes the remainder.
    for (const argv of [["search", "たべ", "--max", "1"], ["search", "たべ", "--max=1"], ["search", "たべ", "-max", "1"]]) {
      const { code, stdout } = await runOnDb(argv, dbPath);
      assert.equal(code, 0, `${argv.join(" ")} exit code`);
      assert.ok(stdout.includes("Readings (2):"), `${argv.join(" ")} header counts the section`);
      assert.ok(stdout.includes("食べる  [たべる (taberu)]"), `${argv.join(" ")} first row`);
      assert.ok(stdout.includes("  … and 1 more"), `${argv.join(" ")} remainder note`);
      assert.ok(!stdout.includes("食べ物"), `${argv.join(" ")} second row capped off`);
    }

    // An invalid cap is an error on stderr, no output.
    const bad = await runOnDb(["search", "たべ", "--max", "0"], dbPath);
    assert.equal(bad.code, 0);
    assert.equal(bad.stdout, "");
    assert.ok(bad.stderr.includes("error: --max must be a positive integer"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search: a reading match and an English word both appear in ranked sections", async () => {
  // ``take`` is a romaji reading (たけ) — but no fixture word reads たけ, so
  // the Readings section is absent; ``taberu`` lands in Readings with romaji.
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    const romaji = await runOnDb(["search", "taberu"], dbPath);
    assert.equal(romaji.code, 0);
    assert.ok(romaji.stdout.includes("Readings (1):"));
    assert.ok(romaji.stdout.includes("食べる  [たべる (taberu)]\n     to eat"));
    assert.ok(!romaji.stdout.includes("Meanings ("), "no meaning hits for taberu");

    // Spaced romaji (``ta be ru``) still matches the reading.
    const spaced = await runOnDb(["search", "ta be ru"], dbPath);
    assert.equal(spaced.code, 0);
    assert.ok(spaced.stdout.includes("食べる  [たべる (taberu)]"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty ASCII gloss search: prints a reading-path hint (did you mean)", async () => {
  const { dbPath, dir } = buildFixtureDbFile();
  try {
    // Completely unmatched query: generic hint pointing at the reading path.
    const miss = await runOnDb(["search", "zqxjk"], dbPath);
    assert.equal(miss.code, 0);
    assert.ok(miss.stdout.includes("(no results)"));
    assert.ok(miss.stdout.includes("readings match by kana or romaji prefix"));

    // ``eat zzz``: the ANDed gloss search is empty, but a relaxed single-token
    // match suggests 食べる and its reading as the path to search instead.
    const close = await runOnDb(["search", "eat zzz"], dbPath);
    assert.equal(close.code, 0);
    assert.ok(close.stdout.includes("did you mean「食べる [たべる] to eat」"));
    assert.ok(close.stdout.includes("omakase search たべる"));
    assert.ok(close.stdout.includes("taberu"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cannot open the DB: real command exits 1 with guidance on stderr", async () => {
  const { code, stdout, stderr } = await runOnDb(["word", "食べる"], "/nonexistent/kanji.db");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("cannot open database at /nonexistent/kanji.db"));
});