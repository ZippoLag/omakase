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
import { renderKanjiWords, renderSearch } from "../src/format.js";
import {
  exampleSentences,
  glossThesaurus,
  loadWord,
  searchKanjiByReading,
  searchReadingPrefix,
  wordThesaurus,
  wordsContainingKanji,
} from "../src/lookup.js";
import type { LoadedWord } from "../src/lookup.js";
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
  // Multi-kanji: one page per character, blank line between pages.
  ["kanji-inshoku.txt", "飲食"],
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
      const { readings, meanings } = cmdSearch(db, query);
      const out = renderSearch(query, readings, meanings, searchKanjiByReading(db, query));
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

test("gloss fallback fills words with no links; linked words keep explicit thesaurus", () => {
  const db = buildFixtureDb();
  try {
    const tags = loadTags(db);
    // 食べる has no cross-reference links -> fallback infers synonyms from glosses.
    const taberu = cmdWord(db, "食べる", tags);
    assert.ok(taberu != null);
    assert.ok(taberu.includes("Synonyms:"), "fallback adds a Synonyms section");
    assert.ok(taberu.includes("食う"), "食う shares the 'eat' gloss token");
    // 暑い has an explicit antonym -> no gloss fallback (and no synonym list).
    const atsui = cmdWord(db, "暑い", tags);
    assert.ok(atsui != null);
    assert.ok(!atsui.includes("Synonyms:"), "linked word is not given gloss fallback");
    assert.ok(atsui.includes("Antonyms:"));
  } finally {
    db.close();
  }
});

test("gloss-thesaurus fallback: shared tokens, POS filter, exclusion, common tie-break", () => {
  const mk = (id: string, common: boolean, text: string, pos: string[], glosses: string[], extra: { related?: unknown[] } = {}): JmdictWord => ({
    id,
    kanji: [],
    kana: [{ common, text, tags: [], appliesToKanji: ["*"] }],
    sense: [{
      partOfSpeech: pos,
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: extra.related ?? [],
      antonym: [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      languageSource: [],
      gloss: glosses.map((g) => ({ lang: "eng", gender: null, type: null, text: g })),
    }],
  });
  const words: JmdictWord[] = [
    mk("10", true, "ア", ["v1"], ["to eat"], { related: [["ド", 1]] }),
    mk("20", false, "ビ", ["v1"], ["to eat"]),
    mk("30", true, "シ", ["n"], ["eat well"]),
    mk("40", true, "エ", ["v1"], ["to eat", "to drink"]),
    mk("60", true, "ド", ["v1"], ["to eat"]),
  ];
  const rows = transform(
    { words } as never,
    { characters: [] } as never,
    { version: "", kanji: {} } as KradfileFile,
    { version: "", radicals: {} } as RadkfileFile,
  );
  const db = buildDb(rows, { tags: "{}" }, { dbPath: ":memory:" });
  try {
    const ids = (hits: { word: { id: string } }[]) => hits.map((h) => h.word.id);
    // ア has a link (→ ド): explicit thesaurus wins, no gloss fallback.
    assert.deepEqual(ids(wordThesaurus(db, loadWord(db, "10")!).synonyms), ["60"]);
    // glossThesaurus directly: skips self, the linked target ド, and noun シ;
    // ties break common-first then by word id.
    assert.deepEqual(ids(glossThesaurus(db, loadWord(db, "10")!).synonyms), ["40", "20"]);
    // ビ has no links: all verbs sharing "eat", common first, id tie-break.
    assert.deepEqual(ids(wordThesaurus(db, loadWord(db, "20")!).synonyms), []);
    assert.deepEqual(ids(glossThesaurus(db, loadWord(db, "20")!).synonyms), ["10", "40", "60"]);
    assert.equal(glossThesaurus(db, loadWord(db, "20")!, 1).synonyms.length, 1);
    // シ is a noun: no candidates share both a token and a POS class.
    assert.deepEqual(ids(glossThesaurus(db, loadWord(db, "30")!).synonyms), []);
  } finally {
    db.close();
  }
});

test("kanji compound ≡ one call per character, with a ranked Words section", () => {
  const db = buildFixtureDb();
  try {
    const single = (lit: string): string => cmdKanji(db, lit)!;
    // 飲食: a ranked Words section (words containing 飲 or 食, most matched
    // first) precedes the two pages; the pages are byte-identical to calling
    // kanji once per character.
    const words = wordsContainingKanji(db, ["飲", "食"], 30);
    const wordsText = renderKanjiWords(words.hits, words.total, 30);
    assert.equal(cmdKanji(db, "飲食"), wordsText + single("飲") + single("食"));
    // Fixture ranking: every candidate matches exactly one kanji, so common
    // words first, then entry id — 飲む is the lowest id.
    assert.match(wordsText, /^Words \(5\):/);
    assert.ok(wordsText.split("\n")[1]!.startsWith("  飲む  [飲[の]む]"), wordsText);
    // A query mixing kanji and kana is not a literal sequence: it falls back
    // to the reading search (which finds nothing for 食べ) rather than pages.
    assert.equal(cmdKanji(db, "食べ"), null);
    // Kana / romaji queries still take the reading-search path (matched
    // reading rows, not per-character pages).
    const hits = cmdKanji(db, "shoku");
    assert.ok(hits != null && hits.includes("食  "));
    const kana = cmdKanji(db, "たべ");
    assert.ok(kana != null && kana.includes("食  [た.べる]"), "kana query goes via reading search");
  } finally {
    db.close();
  }
});

test("kanji -max caps compounds, words and reading results", () => {
  const db = buildFixtureDb();
  try {
    const rows = (out: string): string[] =>
      out.split("\n").filter((l) => l.startsWith("  ") && !l.startsWith("  …"));
    // Compounds capped: 食 has 5 compound words in the fixtures.
    const capped = cmdKanji(db, "食", 2)!;
    assert.equal(rows(capped).length, 2);
    assert.ok(capped.includes("… and 3 more"), capped);
    // A generous cap shows everything, with no truncation note.
    const full = cmdKanji(db, "食", 30)!;
    assert.equal(rows(full).length, 5);
    assert.ok(!full.includes("… and "));
    // Multi-kanji Words section capped (5 candidates, 2 shown).
    const multi = cmdKanji(db, "飲食", 2)!;
    assert.match(multi, /^Words \(5\):/);
    assert.ok(multi.includes("… and 3 more"), multi);
    // Reading-search results capped: "mi" matches 水・行・見 in the fixtures.
    const mi = cmdKanji(db, "mi", 2)!;
    assert.equal(rows(mi).length, 2);
    assert.ok(mi.includes("… and 1 more"), mi);
    assert.ok(!cmdKanji(db, "mi", 30)!.includes("… and "));
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
    const { readings, meanings } = cmdSearch(db, "zqxjk");
    assert.equal(readings.length + meanings.length, 0);
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

test("cmdSearch: an exact reading lands in Readings with its romaji, no meaning hits", () => {
  const db = buildFixtureDb();
  try {
    const { readings, meanings } = cmdSearch(db, "taberu");
    // ``taberu`` hits the romaji reading directly; no gloss contains it.
    assert.deepEqual(readings.map((h) => ({ reading: h.reading, romaji: h.romaji, gloss: h.gloss })), [
      { reading: "たべる", romaji: "taberu", gloss: "to eat" },
    ]);
    assert.equal(meanings.length, 0);
  } finally {
    db.close();
  }
});

test("cmdSearch: unmatched ASCII goes to the Meanings (gloss) section", () => {
  const db = buildFixtureDb();
  try {
    // No reading romaji starts with ``eat``, so it must scan glosses.
    const { readings, meanings } = cmdSearch(db, "eat");
    assert.equal(readings.length, 0);
    assert.ok(meanings.length > 0);
    assert.ok(meanings.some((h) => h.reading === "たべる" && h.gloss === "to eat"));
  } finally {
    db.close();
  }
});

test("cmdSearch: romaji spaced per kana still hits the reading (``ta be ru`` → たべる)", () => {
  const db = buildFixtureDb();
  try {
    const { readings } = cmdSearch(db, "ta be ru");
    assert.deepEqual(readings.map((h) => h.reading), ["たべる"]);
  } finally {
    db.close();
  }
});

test("cmdSearch gloss: tokens are ANDed and prefix-matched", () => {
  const mk = (id: string, writing: string, reading: string, glosses: string[]): JmdictWord => ({
    id,
    kanji: writing ? [{ common: true, text: writing, tags: [] }] : [],
    kana: [{ common: true, text: reading, tags: [], appliesToKanji: ["*"] }],
    sense: glosses.map((g) => ({
      partOfSpeech: ["n"],
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: [],
      antonym: [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      languageSource: [],
      gloss: [{ lang: "eng", gender: null, type: null, text: g }],
    })),
  });
  const words: JmdictWord[] = [
    // 現像: both ``develop`` and ``film`` tokens live in ONE gloss → matches.
    mk("10", "現像", "げんぞう", ["development (of film); photographic processing"]),
    mk("20", "開発", "かいはつ", ["development (of a project, land, etc.)"]),
    mk("30", "育成", "いくせい", ["to develop"]),
    mk("40", "", "ふぃるむ", ["film"]),
    mk("50", "開発者", "かいはつしゃ", ["developer"]),
    // Both tokens exist but in DIFFERENT sense glosses → ``develop film`` must NOT match.
    mk("60", "育成中", "いくせいちゅう", ["to develop", "film stock"]),
  ];
  const rows = transform(
    { words } as never,
    { characters: [] } as never,
    { version: "", kanji: {} } as KradfileFile,
    { version: "", radicals: {} } as RadkfileFile,
  );
  const db = buildDb(rows, { tags: "{}" }, { dbPath: ":memory:" });
  try {
    const ids = (q: string): string[] => cmdSearch(db, q).meanings.map((h) => h.word.id);
    // Multi-word query: every token must prefix-match within a single sense
    // (word 60's tokens live in DIFFERENT senses and must NOT match).
    assert.deepEqual(ids("develop film"), ["10"]);
    // Ranking: exact-token glosses first (30, 60 = "to develop"), then
    // prefix matches (10/20 "development…", 50 "developer") by common+id.
    assert.deepEqual(ids("develop"), ["30", "60", "10", "20", "50"]);
    // ``devel`` has no exact matches: everything is a prefix match, ordered
    // by common then entry id.
    assert.deepEqual(ids("devel"), ["10", "20", "30", "50", "60"]);
    assert.deepEqual(ids("film"), ["10", "40", "60"]);
    assert.deepEqual(ids("zzz"), []);
  } finally {
    db.close();
  }
});

test("cmdSearch: ambiguous query shows BOTH ranked sections (reading + meaning)", () => {
  // ``take`` is a valid romaji reading (たけ) AND an English word ("to take").
  const mk = (id: string, writing: string, reading: string, common: boolean, gloss: string): JmdictWord => ({
    id,
    kanji: writing ? [{ common, text: writing, tags: [] }] : [],
    kana: [{ common, text: reading, tags: [], appliesToKanji: ["*"] }],
    sense: [{
      partOfSpeech: ["n"],
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: [],
      antonym: [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      languageSource: [],
      gloss: [{ lang: "eng", gender: null, type: null, text: gloss }],
    }],
  });
  const words: JmdictWord[] = [
    mk("10", "竹", "たけ", true, "bamboo"),
    mk("20", "岳", "たけ", false, "peak; mountain"),
    mk("30", "取る", "とる", true, "to take"),
  ];
  const rows = transform(
    { words } as never,
    { characters: [] } as never,
    { version: "", kanji: {} } as KradfileFile,
    { version: "", radicals: {} } as RadkfileFile,
  );
  const db = buildDb(rows, { tags: "{}" }, { dbPath: ":memory:" });
  try {
    const { readings, meanings } = cmdSearch(db, "take");
    // Readings: both たけ words are exact ``take``; the common 竹 ranks first.
    assert.deepEqual(readings.map((h) => ({ reading: h.reading, romaji: h.romaji })), [
      { reading: "たけ", romaji: "take" },
      { reading: "たけ", romaji: "take" },
    ]);
    assert.deepEqual(readings.map((h) => h.word.id), ["10", "20"]);
    // Meanings: ``to take`` matches 取る (and NOT the たけ readings, whose
    // glosses lack the token).
    assert.deepEqual(meanings.map((h) => h.word.id), ["30"]);
  } finally {
    db.close();
  }
});

test("meaning ranking: an earlier covering sense beats a later one", () => {
  // Both words carry an exact ``eat`` gloss; 遣る-style late slang senses must
  // not outrank a word whose primary sense is the match.
  const mk = (id: string, glossesPerSense: string[][]): JmdictWord => ({
    id,
    kanji: [],
    kana: [{ common: true, text: "あ" + id, tags: [], appliesToKanji: ["*"] }],
    sense: glossesPerSense.map((glosses) => ({
      partOfSpeech: ["v1"],
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: [],
      antonym: [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      languageSource: [],
      gloss: glosses.map((g) => ({ lang: "eng", gender: null, type: null, text: g })),
    })),
  });
  const words: JmdictWord[] = [
    mk("10", [["to prepare dinner"], ["to eat; to drink (vulgar)"]]),
    mk("20", [["to eat"]]),
  ];
  const rows = transform(
    { words } as never,
    { characters: [] } as never,
    { version: "", kanji: {} } as KradfileFile,
    { version: "", radicals: {} } as RadkfileFile,
  );
  const db = buildDb(rows, { tags: "{}" }, { dbPath: ":memory:" });
  try {
    const ids = cmdSearch(db, "eat").meanings.map((h) => h.word.id);
    // 20's sense 1 covers; 10 only covers via sense 2 -> 20 ranks first even
    // though its entry id is larger.
    assert.deepEqual(ids, ["20", "10"]);
  } finally {
    db.close();
  }
});

test("cmdSearch: accidental ASCII reading prefixes are dropped when meanings match", () => {
  // ``eat`` prefix-matches the katakana loan エアタオル (romaji ``eataoru``)
  // but the user means the English word — the reading hit must not crowd out
  // the meaning hits (unlike a genuinely ambiguous query like ``take``).
  const mk = (id: string, reading: string, gloss: string): JmdictWord => ({
    id,
    kanji: [],
    kana: [{ common: true, text: reading, tags: [], appliesToKanji: ["*"] }],
    sense: [{
      partOfSpeech: ["n"],
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: [],
      antonym: [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      languageSource: [],
      gloss: [{ lang: "eng", gender: null, type: null, text: gloss }],
    }],
  });
  const words: JmdictWord[] = [
    mk("10", "エアタオル", "hand dryer"), // romaji eataoru: starts with ``eat``
    mk("20", "たべる", "to eat"),
  ];
  const rows = transform(
    { words } as never,
    { characters: [] } as never,
    { version: "", kanji: {} } as KradfileFile,
    { version: "", radicals: {} } as RadkfileFile,
  );
  const db = buildDb(rows, { tags: "{}" }, { dbPath: ":memory:" });
  try {
    // ``eat``: the eataoru reading match exists but is not exact, and there
    // are meaning hits -> Readings section is dropped.
    const eat = cmdSearch(db, "eat");
    assert.deepEqual(eat.meanings.map((h) => h.word.id), ["20"]);
    assert.equal(eat.readings.length, 0, "accidental reading prefix hidden");
    // ``eata``: no meaning hits, so the reading-prefix path is the answer.
    const eata = cmdSearch(db, "eata");
    assert.equal(eata.meanings.length, 0);
    assert.deepEqual(eata.readings.map((h) => h.word.id), ["10"]);
  } finally {
    db.close();
  }
});

test("search: LIKE wildcards in the query are matched literally, not as SQL wildcards", () => {
  const db = buildFixtureDb();
  try {
    // A bare ``%`` used to match every kana writing (``LIKE '%%%'`` = anything),
    // and ``_`` acted as a single-char wildcard (``tab_r`` matched たべる).
    const flat = (q: string): { reading: string }[] => [
      ...cmdSearch(db, q).readings,
      ...cmdSearch(db, q).meanings,
    ];
    assert.equal(flat("%").length, 0);
    assert.equal(flat("_").length, 0);
    assert.equal(flat("tab_r").length, 0);
    // The kana column has the same protection.
    assert.equal(flat("たべ%").length, 0);
    assert.equal(flat("たべ_る").length, 0);
    // A backslash in the query is literal too, not an escape for the engine.
    assert.equal(flat("tab\\eru").length, 0);
    // Ordinary prefixes still match after escaping.
    assert.deepEqual(readings(searchReadingPrefix(db, "tabe")), ["たべる", "たべもの"]);
    assert.deepEqual(readings(searchReadingPrefix(db, "たべ")), ["たべる", "たべもの"]);
  } finally {
    db.close();
  }
});

test("exampleSentences: a ``%`` inside a writing matches literally", () => {
  // Without escaping, the ``%`` in the writing ``50%見る`` would widen
  // ``LIKE '%50%見る%'`` to match any sentence with ``50`` before ``見る``
  // (here: ``500見る``), even though it never contains the literal writing.
  const mk = (id: string): JmdictWord => ({
    id,
    kanji: [{ common: true, text: "50%見る", tags: [] }],
    kana: [{ common: true, text: "みる", tags: [], appliesToKanji: ["*"] }],
    sense: [{
      partOfSpeech: ["v1"],
      appliesToKanji: ["*"],
      appliesToKana: ["*"],
      related: [],
      antonym: [],
      field: [],
      dialect: [],
      misc: [],
      info: [],
      languageSource: [],
      gloss: [{ lang: "eng", gender: null, type: null, text: "to see" }],
    }],
  });
  const rows = transform(
    { words: [mk("10")] } as never,
    { characters: [] } as never,
    { version: "", kanji: {} } as KradfileFile,
    { version: "", radicals: {} } as RadkfileFile,
  );
  const db = buildDb(rows, { tags: "{}" }, { dbPath: ":memory:" });
  try {
    const insert = db.prepare("INSERT INTO sentences (id, japanese, english) VALUES (?, ?, ?)");
    insert.run(1, "50%見る", "contains the literal writing");
    insert.run(2, "500見る", "only matches via a widened wildcard");
    const found = exampleSentences(db, loadWord(db, "10")!);
    assert.deepEqual(found.map((s) => s.id), [1]);
  } finally {
    db.close();
  }
});

// ---- search result rendering (sections, caps, bold) -----------------------

/** Minimal LoadedWord for render-only tests (kana-only, single gloss). */
function fakeWord(id: string, reading: string, gloss: string): LoadedWord {
  return {
    id,
    common: true,
    kanji: [],
    kana: [{ text: reading, common: true }],
    senses: [{ partOfSpeech: [], glosses: [gloss] }],
    furigana: new Map(),
  };
}

test("renderSearch: sections with counts; reading rows print kana + romaji", () => {
  const readings = [
    { word: fakeWord("1", "たべる", "to eat"), reading: "たべる", romaji: "taberu", gloss: "to eat" },
  ];
  const out = renderSearch("taberu", readings, [], []);
  assert.ok(out.startsWith("taberu\n"));
  assert.ok(out.includes("Readings (1):\n  たべる  [たべる (taberu)]  to eat"));
  // Empty result keeps the old plain shape (used for the hint tail).
  assert.equal(renderSearch("zqxjk", [], [], []), "zqxjk\n\n  (no results)\n");
});

test("renderSearch: multi-section output separates Readings / Meanings / Kanji", () => {
  const readings = [
    { word: fakeWord("1", "たけ", "bamboo"), reading: "たけ", romaji: "take", gloss: "bamboo" },
  ];
  const meanings = [
    { word: fakeWord("2", "とる", "to take"), reading: "とる", gloss: "to take" },
  ];
  const out = renderSearch("take", readings, meanings, []);
  assert.ok(out.includes("Readings (1):\n  たけ  [たけ (take)]  bamboo"));
  assert.ok(out.includes("\n\nMeanings (1):\n  とる  [とる]  to take"));
  assert.ok(!out.includes("Kanji:"));
});

test("renderSearch bolds literal query overlap when color is on, plain when off", () => {
  const B = "\u001b[1m";
  const B_OFF = "\u001b[22m";
  // Reading rows: the romaji (ASCII query) / kana (kana query) overlap is bolded.
  const take = renderSearch("take", [{ word: fakeWord("1", "たけ", "bamboo"), reading: "たけ", romaji: "take", gloss: "bamboo" }], [], [], { color: true });
  assert.ok(take.includes(`  たけ  [たけ (${B}take${B_OFF})]  bamboo`), "romaji overlap bolded");
  const kana = renderSearch("たべ", [{ word: fakeWord("1", "たべる", "to eat"), reading: "たべる", romaji: "taberu", gloss: "to eat" }], [], [], { color: true });
  assert.ok(kana.includes(`  たべる  [${B}たべ${B_OFF}る (taberu)]  to eat`), "kana overlap bolded");
  // Meaning rows: matched gloss words (and their matched prefix) are bolded.
  const gloss = renderSearch(
    "develop film",
    [],
    [{ word: fakeWord("2", "げんぞう", "development (of film)"), reading: "げんぞう", gloss: "development (of film); photographic processing" }],
    [],
    { color: true },
  );
  assert.ok(
    gloss.includes(`  げんぞう  [げんぞう]  ${B}develop${B_OFF}ment (of ${B}film${B_OFF}); photographic processing`),
    "gloss overlaps bolded",
  );
  // Without color there are no escape codes anywhere.
  const plain = renderSearch("develop film", [], [{ word: fakeWord("2", "げんぞう", "x"), reading: "げんぞう", gloss: "development (of film)" }], [], {});
  assert.ok(!plain.includes("\u001b"), "no ANSI codes when color is off");
});

test("renderSearch: each section caps at max rows with a count + trailing note", () => {
  const hits = Array.from({ length: 35 }, (_, i) => ({
    word: fakeWord(String(i), "たべる", "to eat"),
    reading: "たべる",
    romaji: "taberu",
    gloss: "to eat",
  }));
  const out = renderSearch("tabe", hits, [], []);
  assert.ok(out.includes("Readings (35):"), "header counts the full section");
  const rows = out.split("\n").filter((l) => l.startsWith("  たべる  [たべる (taberu)]"));
  assert.equal(rows.length, 30, "30 rows shown by default");
  assert.ok(out.includes("  … and 5 more"), "remainder is noted");
  // A raised cap shows everything.
  const wide = renderSearch("tabe", hits, [], [], { max: 40 });
  assert.ok(!wide.includes("more"), "no truncation note under the cap");
  assert.equal(wide.split("\n").filter((l) => l.startsWith("  たべる  [たべる (taberu)]")).length, 35);
});
