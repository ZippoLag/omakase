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
import { loadWord, searchKanjiByReading, searchReadingPrefix, wordThesaurus } from "../src/lookup.js";
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
  // thesaurus: 暑い has an antonym (寒い), 有る a related word (居る).
  ["word-atsui.txt", "暑い"],
  ["word-aru.txt", "有る"],
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
      const out = renderSearch(query, cmdSearch(db, query), searchKanjiByReading(db, query));
      assert.equal(out, golden(file), file);
    }
  } finally {
    db.close();
  }
});

test("kanji reading search: kana prefix, dot separators ignored", () => {
  const db = buildFixtureDb();
  try {
    // 食's kun た.べる normalizes to たべる, matching the たべ prefix.
    assert.deepEqual(searchKanjiByReading(db, "たべ"), [
      { literal: "食", readings: ["た.べる"], meanings: ["eat", "food"] },
    ]);
    assert.deepEqual(searchKanjiByReading(db, "taberu"), [
      { literal: "食", readings: ["た.べる"], meanings: ["eat", "food"] },
    ]);
  } finally {
    db.close();
  }
});

test("kanji reading search: romaji prefix across on/kun readings", () => {
  const db = buildFixtureDb();
  try {
    // 水 (みず), 見 (みる) via kun, plus 行 via its nanori みち; ordered by literal.
    assert.deepEqual(searchKanjiByReading(db, "mi").map((h) => h.literal), ["水", "行", "見"]);
    // on reading: 食's ショク → "shoku".
    assert.deepEqual(searchKanjiByReading(db, "shoku").map((h) => h.literal), ["食"]);
    assert.equal(searchKanjiByReading(db, "zzz").length, 0);
  } finally {
    db.close();
  }
});

test("thesaurus caps synonyms and antonyms at 5 each", () => {
  const db = buildFixtureDb();
  try {
    const tags = loadTags(db);
    // Give 暑い 6 related links to existing fixture words, as the build would
    // materialize into thesaurus_links. All six targets are common, so the
    // top-5 by word id are kept and 綺麗 (1591900, the largest id) is dropped.
    const link = db.prepare(
      "INSERT INTO thesaurus_links (kind, from_word, to_word, to_sense, hops) VALUES ('related', '1343460', ?, 1, 1)",
    );
    for (const target of ["1169870", "1210360", "1296400", "1358280", "1358490", "1591900"]) link.run(target);
    // And 6 antonym links for 良い (1605820), which has no built-in antonyms.
    const antLink = db.prepare(
      "INSERT INTO thesaurus_links (kind, from_word, to_word, to_sense, hops) VALUES ('antonym', '1605820', ?, null, 1)",
    );
    for (const target of ["1169870", "1210360", "1296400", "1358280", "1358490", "1591900"]) antLink.run(target);

    const section = (out: string, header: string, next?: string): string[] => {
      const lines = out.split("\n");
      const start = lines.indexOf(header) + 1;
      const end = next ? lines.indexOf(next, start) : lines.length;
      return end < 0 ? [] : lines.slice(start, end).filter((l) => l.trim() !== "");
    };

    const out = cmdWord(db, "暑い", tags);
    assert.ok(out != null);
    const synRows = section(out, "Synonyms:", "Antonyms:");
    assert.equal(synRows.length, 5);
    assert.match(synRows[0]!, /^  飲む  \[のむ\]/);
    assert.match(synRows[4]!, /^  食事  \[しょくじ\]/);
    assert.ok(!synRows.some((l) => l.includes("綺麗")), "6th synonym is capped off");

    const antOut = cmdWord(db, "良い", tags);
    assert.ok(antOut != null);
    const antRows = section(antOut, "Antonyms:");
    assert.equal(antRows.length, 5);
    assert.match(antRows[0]!, /^  飲む  \[のむ\]/);
    assert.match(antRows[4]!, /^  食事  \[しょくじ\]/);
    assert.ok(!antRows.some((l) => l.includes("綺麗")), "6th antonym is capped off");
  } finally {
    db.close();
  }
});

test("thesaurus_links: forward, reverse and 2-hop closure built offline", () => {
  const mk = (id: string, common: boolean, text: string, extra: { related?: unknown[]; antonym?: unknown[] } = {}): JmdictWord => ({
    id,
    kanji: [],
    kana: [{ common, text, tags: [], appliesToKanji: ["*"] }],
    sense: [{
      partOfSpeech: ["n"],
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: extra.related ?? [],
      antonym: extra.antonym ?? [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      languageSource: [],
      gloss: [{ lang: "eng", gender: null, type: null, text: "gloss of " + text }],
    }],
  });
  const words: JmdictWord[] = [
    mk("10", true, "ア", { related: [["ビ", 1]] }),
    mk("20", true, "ビ", { related: [["シ", 1]], antonym: [["フ", 1]] }),
    mk("30", true, "シ", { antonym: [["ド", 1]] }),
    mk("40", false, "ド"),
    mk("50", true, "フ"),
  ];
  // Real pipeline: xrefs are resolved and closed over before anything is queried.
  const rows = transform(
    { words } as never,
    { characters: [] } as never,
    { version: "", kanji: {} } as KradfileFile,
    { version: "", radicals: {} } as RadkfileFile,
  );
  const db = buildDb(rows, { tags: "{}" }, { dbPath: ":memory:" });
  try {
    const links = db.prepare(
      "SELECT kind, from_word, to_word, to_sense, hops FROM thesaurus_links ORDER BY rowid",
    ).all() as { kind: string; from_word: string; to_word: string; to_sense: number | null; hops: number }[];
    assert.deepEqual(links, [
      // forward links, in word/sense order, keeping the referenced sense
      { kind: "related", from_word: "10", to_word: "20", to_sense: 1, hops: 1 },
      { kind: "related", from_word: "20", to_word: "30", to_sense: 1, hops: 1 },
      { kind: "antonym", from_word: "20", to_word: "50", to_sense: 1, hops: 1 },
      { kind: "antonym", from_word: "30", to_word: "40", to_sense: 1, hops: 1 },
      // reverse edges: one-directional references become bidirectional
      { kind: "related", from_word: "20", to_word: "10", to_sense: null, hops: 1 },
      { kind: "related", from_word: "30", to_word: "20", to_sense: null, hops: 1 },
      { kind: "antonym", from_word: "50", to_word: "20", to_sense: null, hops: 1 },
      { kind: "antonym", from_word: "40", to_word: "30", to_sense: null, hops: 1 },
      // 2-hop closure per base row (related → related, then related → antonym;
      // self-references dropped): ア→シ via ビ, ア→フ via ビ, ビ→ド via シ,
      // シ→ア via ビ, シ→フ via ビ.
      { kind: "related", from_word: "10", to_word: "30", to_sense: null, hops: 2 },
      { kind: "antonym", from_word: "10", to_word: "50", to_sense: null, hops: 2 },
      { kind: "antonym", from_word: "20", to_word: "40", to_sense: null, hops: 2 },
      { kind: "related", from_word: "30", to_word: "10", to_sense: null, hops: 2 },
      { kind: "antonym", from_word: "30", to_word: "50", to_sense: null, hops: 2 },
    ]);

    // Runtime thesaurus reads the materialized table: forward + reverse +
    // 2-hop, ranked common-first then word id, capped at 5.
    const thes = (id: string) => wordThesaurus(db, loadWord(db, id)!);
    assert.deepEqual(thes("10").synonyms.map((h) => h.word.id), ["20", "30"]);
    assert.deepEqual(thes("10").antonyms.map((h) => h.word.id), ["50"]);
    assert.equal(thes("10").antonyms[0]!.gloss, "gloss of フ"); // 2-hop rows fall back to the first gloss
    assert.deepEqual(thes("20").synonyms.map((h) => h.word.id), ["10", "30"]);
    assert.deepEqual(thes("20").antonyms.map((h) => h.word.id), ["50", "40"]);
    // reverse antonym edge: ド (40) never declares an antonym of its own
    assert.deepEqual(thes("40").antonyms.map((h) => h.word.id), ["30"]);
    assert.deepEqual(thes("40").synonyms, []);
    assert.equal(wordThesaurus(db, loadWord(db, "10")!, 1).synonyms.length, 1);
  } finally {
    db.close();
  }
});

test("no-match paths return null / empty result set", () => {
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
