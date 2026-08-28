/**
 * M1 golden harness for the word / kanji / search CLI commands.
 *
 * Builds an in-memory DB from tests/fixtures/entries/*.json using the REAL
 * transform/buildDb code, seeds the sentences table from the curated fixture
 * sentences, then compares command output byte-for-byte to the goldens in
 * tests/fixtures/golden/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { transform } from "../data/build/transform.js";
import { buildDb } from "../data/build/buildDb.js";
import { cmdWord, cmdKanji, cmdSearch, loadTags } from "../src/cli.js";
import { renderSearch } from "../src/format.js";
import { searchReadingPrefix } from "../src/lookup.js";
import type { JmdictWord, Kanjidic2Character, KradfileFile, RadkfileFile } from "../data/build/parse.js";

type DB = InstanceType<typeof Database>;

const FIXTURES = "tests/fixtures";

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function fixtureDir(dir: string): string[] {
  return readdirSync(join(FIXTURES, dir)).filter((f) => !f.startsWith("_") && f.endsWith(".json"));
}

/** Build the fixture DB through the real pipeline, plus seeded sentences. */
function buildFixtureDb(): DB {
  const words: JmdictWord[] = fixtureDir("entries")
    .filter((f) => f.startsWith("jmdict-"))
    .map((f) => loadJson<JmdictWord>(join(FIXTURES, "entries", f)));

  const characters: Kanjidic2Character[] = fixtureDir("entries")
    .filter((f) => f.startsWith("kanjidic2-"))
    .map((f) => loadJson<Kanjidic2Character>(join(FIXTURES, "entries", f)));

  const krad: KradfileFile = { version: "", kanji: {} };
  for (const f of fixtureDir("entries")) {
    if (f.startsWith("krad-")) {
      const slice = loadJson<{ literal: string; components: string[] }>(join(FIXTURES, "entries", f));
      krad.kanji[slice.literal] = slice.components;
    }
  }

  const radk: RadkfileFile = { version: "", radicals: {} };
  for (const f of fixtureDir("entries")) {
    if (f.startsWith("radk-")) {
      const slice = loadJson<{ strokeCount?: number; code?: string | null; kanji?: string[] }>(join(FIXTURES, "entries", f));
      const lit = f.slice(5, -5);
      radk.radicals[lit] = {
        strokeCount: slice.strokeCount ?? 0,
        code: slice.code ?? null,
        kanji: slice.kanji ?? [],
      };
    }
  }

  const rows = transform({ words } as never, { characters } as never, krad, radk);
  const tags = loadJson<Record<string, string>>(join(FIXTURES, "meta", "tags.json"));
  const db = buildDb(rows, { tags: JSON.stringify(tags) }, { dbPath: ":memory:" });

  // Seed the sentences table from the curated fixture sentences (ids in
  // sorted-filename order so example ordering matches the goldens).
  const insert = db.prepare("INSERT INTO sentences (id, japanese, english) VALUES (?, ?, ?)");
  const files = fixtureDir("sentences").sort();
  const tx = db.transaction(() => {
    files.forEach((f, i) => {
      const s = loadJson<{ japanese: string; english: string }>(join(FIXTURES, "sentences", f));
      insert.run(i + 1, s.japanese, s.english);
    });
  }) as () => void;
  tx();
  return db;
}

function golden(name: string): string {
  return readFileSync(join(FIXTURES, "golden", name), "utf-8");
}

const WORD_GOLDENS: [string, string, string?, number?][] = [
  ["word-taberu.txt", "食べる"],
  ["word-shokuji.txt", "食事"],
  ["word-kirei.txt", "綺麗"],
  ["word-yoi.txt", "良い"],
  ["word-ii.txt", "いい"],
  ["word-suru-limit3.txt", "為る", undefined, 3],
];

const KANJI_GOLDENS: [string, string][] = [
  ["kanji-shoku.txt", "食"],
  ["kanji-mizu.txt", "水"],
  ["kanji-kuu.txt", "喰"],
];

const SEARCH_GOLDENS: [string, string][] = [
  ["search-eat.txt", "eat"],
  ["search-taberu.txt", "たべ"],
  ["search-taberu-romaji.txt", "taberu"],
];

test("word goldens (dictionary entries + examples, byte-for-byte)", () => {
  const db = buildFixtureDb();
  try {
    const tags = loadTags(db);
    for (const [file, query, , limit] of WORD_GOLDENS) {
      const out = cmdWord(db, query, tags, limit);
      assert.ok(out != null, `no word output for ${query} (${file})`);
      assert.equal(out, golden(file), file);
    }
  } finally {
    db.close();
  }
});

test("kanji goldens (kanji pages, byte-for-byte)", () => {
  const db = buildFixtureDb();
  try {
    for (const [file, literal] of KANJI_GOLDENS) {
      const out = cmdKanji(db, literal);
      assert.ok(out != null, `no kanji output for ${literal} (${file})`);
      assert.equal(out, golden(file), file);
    }
  } finally {
    db.close();
  }
});

test("search goldens (English / kana / romaji, byte-for-byte)", () => {
  const db = buildFixtureDb();
  try {
    for (const [file, query] of SEARCH_GOLDENS) {
      const out = renderSearch(query, cmdSearch(db, query));
      assert.equal(out, golden(file), file);
    }
  } finally {
    db.close();
  }
});test("no-match paths return null / empty result set", () => {
  const db = buildFixtureDb();
  try {
    const tags = loadTags(db);
    assert.equal(cmdWord(db, "存在しない語", tags), null);
    assert.equal(cmdKanji(db, "無"), null);
    assert.equal(cmdSearch(db, "zqxjk").length, 0);
  } finally {
    db.close();
  }
});

const readings = (hits: { reading: string }[]) => hits.map((h) => h.reading);

// 食べる -> たべる -> ``taberu``; 食べ物 -> たべもの -> ``tabemono``. They share
// the romaji prefix ``tabe`` but diverge at position 5 (``taberu`` is not a
// prefix of ``tabemono``), so ``taberu``/``tabem`` must select exactly one.
test("romaji prefix search: exact-vs-shared-prefix readings", () => {
  const db = buildFixtureDb();
  try {
    assert.deepEqual(readings(searchReadingPrefix(db, "taberu")), ["たべる"]);
    assert.deepEqual(readings(searchReadingPrefix(db, "tabem")), ["たべもの"]);
    // The shared ``tabe`` prefix matches both, ordered by word id.
    assert.deepEqual(readings(searchReadingPrefix(db, "tabe")), ["たべる", "たべもの"]);
  } finally {
    db.close();
  }
});

test("romaji prefix search is ASCII case-insensitive", () => {
  const db = buildFixtureDb();
  try {
    assert.deepEqual(readings(searchReadingPrefix(db, "TABERU")), ["たべる"]);
    assert.deepEqual(readings(searchReadingPrefix(db, "TaBe")), ["たべる", "たべもの"]);
  } finally {
    db.close();
  }
});

test("kana prefix search mirrors romaji prefix", () => {
  const db = buildFixtureDb();
  try {
    assert.deepEqual(readings(searchReadingPrefix(db, "たべ")), ["たべる", "たべもの"]);
    assert.deepEqual(readings(searchReadingPrefix(db, "たべる")), ["たべる"]);
  } finally {
    db.close();
  }
});

test("unmatched romaji prefix returns no kana fallback", () => {
  const db = buildFixtureDb();
  try {
    assert.equal(searchReadingPrefix(db, "tabxyz").length, 0);
    assert.equal(searchReadingPrefix(db, "食べ物ローマ字").length, 0);
  } finally {
    db.close();
  }
});

test("cmdSearch: reading-prefix hit short-circuits gloss fallback", () => {
  const db = buildFixtureDb();
  try {
    // ``taberu`` hits a romaji reading directly -> returns eating verb, not a gloss scan.
    assert.deepEqual(cmdSearch(db, "taberu").map((h) => ({ reading: h.reading, gloss: h.gloss })), [
      { reading: "たべる", gloss: "to eat" },
    ]);
  } finally {
    db.close();
  }
});

test("cmdSearch: unmatched ASCII falls back to English gloss token search", () => {
  const db = buildFixtureDb();
  try {
    // No reading romaji starts with ``eat``, so it must scan glosses.
    const hits = cmdSearch(db, "eat");
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.reading === "たべる" && h.gloss === "to eat"));
  } finally {
    db.close();
  }
});
