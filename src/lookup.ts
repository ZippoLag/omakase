/**
 * Read-only query layer over the SQLite dictionary DB.
 *
 * M1 covers the word / kanji / search lookups the CLI commands plus the
 * golden tests need. The shapes returned here mirror the fixture rendering
 * contract in tests/fixtures/scripts/render-goldens.py so the formatters can
 * reproduce the golden outputs byte-for-byte.
 */
import type Database from "better-sqlite3";
import { furiganaFor } from "./furigana.js";
import { kangxiChar } from "./kangxi.js";
import { katakanaToHiragana, toRomaji } from "./kana.js";

type DB = InstanceType<typeof Database>;

export interface LoadedWriting {
  text: string;
  common: boolean;
}
export interface LoadedSense {
  partOfSpeech: string[];
  glosses: string[];
}
export interface LoadedWord {
  id: string;
  common: boolean;
  kanji: LoadedWriting[];
  kana: LoadedWriting[];
  senses: LoadedSense[];
  /** writing -> ruby-marked reading (from the furigana table). */
  furigana: Map<string, string>;
}

/** Load a word entry (writings, senses, glosses, furigana) by JMdict id. */
export function loadWord(db: DB, id: string): LoadedWord | null {
  const word = db.prepare("SELECT id, common FROM words WHERE id = ?").get(id) as { id: string; common: number } | undefined;
  if (!word) return null;

  const kanji = db.prepare(
    "SELECT text, common FROM writings WHERE word_id = ? AND kind = 'kanji' ORDER BY id",
  ).all(id) as { text: string; common: number }[];
  const kana = db.prepare(
    "SELECT text, common FROM writings WHERE word_id = ? AND kind = 'kana' ORDER BY id",
  ).all(id) as { text: string; common: number }[];
  const sensesRaw = db.prepare(
    "SELECT id, part_of_speech FROM senses WHERE word_id = ? ORDER BY position",
  ).all(id) as { id: number; part_of_speech: string }[];

  const senses: LoadedSense[] = sensesRaw.map((s) => ({
    partOfSpeech: JSON.parse(s.part_of_speech) as string[],
    glosses: (db.prepare("SELECT text FROM glosses WHERE sense_id = ? ORDER BY id").all(s.id) as { text: string }[]).map((g) => g.text),
  }));

  const fg = db.prepare("SELECT writing, segments FROM furigana WHERE word_id = ?").all(id) as { writing: string; segments: string }[];
  const furigana = new Map(fg.map((f) => [f.writing, f.segments]));

  return {
    id: word.id,
    common: word.common === 1,
    kanji: kanji.map((k) => ({ text: k.text, common: k.common === 1 })),
    kana: kana.map((k) => ({ text: k.text, common: k.common === 1 })),
    senses,
    furigana,
  };
}

/**
 * Find a word by an exact writing (kanji or kana). Prefers the first word
 * whose common headword equals the query (used by the `word` command).
 */
export function findWordByWriting(db: DB, query: string): LoadedWord | null {
  const row = db.prepare(
    "SELECT word_id FROM writings WHERE text = ? ORDER BY common DESC, word_id LIMIT 1",
  ).get(query) as { word_id: string } | undefined;
  return row ? loadWord(db, row.word_id) : null;
}

/** First common kanji + first common kana (render-goldens display_header). */
export function displayHeader(word: LoadedWord): { text: string; reading: string | null; common: boolean } {
  const w = word.kanji.find((k) => k.common) ?? word.kanji[0];
  const r = word.kana.find((k) => k.common) ?? word.kana[0];
  const text = w ? w.text : r ? r.text : "?";
  const reading = r ? r.text : null;
  return { text, reading, common: word.common };
}

/** First English gloss across all senses (render-goldens first_gloss). */
export function firstGloss(word: LoadedWord): string {
  for (const s of word.senses) {
    for (const g of s.glosses) {
      if (g) return g;
    }
  }
  return "";
}

/** Ruby for a writing of a loaded word (furigana table, falling back to bare). */
export function rubyFor(word: LoadedWord, writing: string): string {
  return word.furigana.get(writing) ?? furiganaFor(writing);
}

// ---- kanji ----------------------------------------------------------------

export interface LoadedKanji {
  literal: string;
  strokeCount: number | null;
  grade: number | null;
  frequency: number | null;
  jlptLevel: number | null;
  classicalRadical: number | null;
  on: string[];
  kun: string[];
  nanori: string[];
  meanings: string[];
  compounds: { wordId: string; writing: string; ruby: string; gloss: string }[];
}

function firstGlossById(db: DB, id: string): string {
  const senses = db.prepare("SELECT id FROM senses WHERE word_id = ? ORDER BY position").all(id) as { id: number }[];
  for (const s of senses) {
    const g = db.prepare("SELECT text FROM glosses WHERE sense_id = ? ORDER BY id LIMIT 1").get(s.id) as { text: string } | undefined;
    if (g) return g.text;
  }
  return "";
}

/** Load a kanji page (readings, meanings, nanori, compounds) by literal. */
export function loadKanji(db: DB, literal: string): LoadedKanji | null {
  const k = db.prepare(
    "SELECT literal, stroke_count, grade, frequency, jlpt_level, classical_radical FROM kanji WHERE literal = ?",
  ).get(literal) as LoadedKanjiRow | undefined;
  if (!k) return null;

  const on = (db.prepare("SELECT value FROM kanji_readings WHERE kanji = ? AND type = 'on' ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);
  const kun = (db.prepare("SELECT value FROM kanji_readings WHERE kanji = ? AND type = 'kun' ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);
  const nanori = (db.prepare("SELECT value FROM kanji_nanori WHERE kanji = ? ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);
  const meanings = (db.prepare("SELECT value FROM kanji_meanings WHERE kanji = ? AND lang = 'en' ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);

  const rows = db.prepare(`
    SELECT kw.word_id, kw.writing_id, w.text AS writing
    FROM kanji_words kw
    JOIN writings w ON w.id = kw.writing_id
    WHERE kw.kanji = ?
    ORDER BY kw.word_id, kw.writing_id
  `).all(literal) as { word_id: string; writing_id: number; writing: string }[];

  const compounds = rows.map((r) => {
    const word = loadWord(db, r.word_id);
    return {
      wordId: r.word_id,
      writing: r.writing,
      ruby: word?.furigana.get(r.writing) ?? r.writing,
      gloss: word ? firstGloss(word) : "",
    };
  });

  return {
    literal: k.literal,
    strokeCount: k.stroke_count,
    grade: k.grade,
    frequency: k.frequency,
    jlptLevel: k.jlpt_level,
    classicalRadical: k.classical_radical,
    on,
    kun,
    nanori,
    meanings,
    compounds,
  };
}

interface LoadedKanjiRow {
  literal: string;
  stroke_count: number | null;
  grade: number | null;
  frequency: number | null;
  jlpt_level: number | null;
  classical_radical: number | null;
}

/** Radical character for a Kangxi radical number (e.g. 184 → 食), if known. */
export function radicalChar(db: DB, number: number): string | null {
  const ch = kangxiChar(number);
  if (ch) return ch;
  const row = db.prepare("SELECT radical FROM radicals WHERE code = ?").get(String(number)) as { radical: string } | undefined;
  return row?.radical ?? null;
}

// ---- search ---------------------------------------------------------------

export interface SearchHit {
  word: LoadedWord;
  /** the specific kana/reading shown (the matched reading for prefix hits). */
  reading: string;
  gloss: string;
}

function isKana(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x3041 && c <= 0x3096) || (c >= 0x30a1 && c <= 0x30f6);
}

export function isKanaInput(input: string): boolean {
  return [...input].some(isKana);
}

/**
 * English-gloss token search via the FTS5 `glosses_fts` index (unicode61),
 * ordered by word id. One hit per word; gloss shown is the first gloss.
 * The quoted token is matched literally, so FTS operators (`*`, `-`, …) in
 * the query are inert. Mirrors render-goldens `eat` example.
 */
export function searchGloss(db: DB, token: string): SearchHit[] {
  const needle = token.toLowerCase();
  const quoted = '"' + needle.replace(/"/g, '""') + '"';
  // FTS rowid = gloss id (glosses_fts is contentless, populated in buildDb),
  // so join through glosses → senses (ids are per-table sequences, so a bare
  // senses.id = f.rowid join would mispair whenever the ids coincide).
  const rows = db.prepare(`
    SELECT DISTINCT s.word_id
    FROM glosses_fts f
    JOIN glosses g ON g.id = f.rowid
    JOIN senses s ON s.id = g.sense_id
    WHERE glosses_fts MATCH ?
    ORDER BY s.word_id
  `).all(quoted) as { word_id: string }[];
  const out: SearchHit[] = [];
  for (const r of rows) {
    const word = loadWord(db, r.word_id);
    if (!word) continue;
    const { reading } = displayHeader(word);
    out.push({ word, reading: reading ?? "", gloss: firstGloss(word) });
  }
  return out;
}

/** Reading-prefix search (kana text or romaji column), ordered by word id. */
export function searchReadingPrefix(db: DB, prefix: string): SearchHit[] {
  const col = isKanaInput(prefix) ? "text" : "romaji";
  const rows = db.prepare(
    `SELECT word_id, text FROM writings WHERE kind = 'kana' AND ${col} LIKE ? ORDER BY word_id, id`,
  ).all(`${prefix}%`) as { word_id: string; text: string }[];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.word_id)) continue;
    seen.add(r.word_id);
    const word = loadWord(db, r.word_id);
    if (!word) continue;
    out.push({ word, reading: r.text, gloss: firstGloss(word) });
  }
  return out;
}

// ---- kanji reading search --------------------------------------------------

export interface KanjiReadingHit {
  literal: string;
  /** the on/kun/nanori readings that matched the prefix (stored form). */
  readings: string[];
  /** English meanings. */
  meanings: string[];
}

const stripDots = (s: string): string => s.replace(/\./g, "");

/** kana→hiragana with reading dots removed, so た.べる normalizes to たべる. */
function normalizeReading(s: string): string {
  return katakanaToHiragana(stripDots(s));
}

/**
 * Kanji whose on/kun/nanori reading starts with the query, ordered by literal.
 * Kana input matches kana (katakana readings normalized to hiragana; kun dot
 * separators ignored); ASCII input matches the Hepburn-ish romaji of each
 * reading (src/kana.ts). One entry per kanji, listing only the matched
 * readings, mirroring how the word search shows the matched reading.
 */
export function searchKanjiByReading(db: DB, query: string): KanjiReadingHit[] {
  const isKana = isKanaInput(query);
  const needle = isKana ? normalizeReading(query) : query.toLowerCase();
  const matches = (value: string): boolean => {
    const norm = normalizeReading(value);
    return isKana ? norm.startsWith(needle) : toRomaji(norm).startsWith(needle);
  };

  const matched = new Set<string>();
  const readings = db.prepare("SELECT kanji, value FROM kanji_readings ORDER BY kanji").all() as { kanji: string; value: string }[];
  for (const r of readings) {
    if (matches(r.value)) matched.add(r.kanji);
  }
  const nanori = db.prepare("SELECT kanji, value FROM kanji_nanori ORDER BY kanji").all() as { kanji: string; value: string }[];
  for (const n of nanori) {
    if (matches(n.value)) matched.add(n.kanji);
  }

  if (matched.size === 0) return [];
  const out: KanjiReadingHit[] = [];
  for (const literal of [...matched].sort()) {
    const hitReadings = (db.prepare("SELECT type, value FROM kanji_readings WHERE kanji = ? ORDER BY rowid").all(literal) as { type: string; value: string }[])
      .filter((r) => matches(r.value))
      .map((r) => r.value);
    const hitNanori = (db.prepare("SELECT value FROM kanji_nanori WHERE kanji = ? ORDER BY rowid").all(literal) as { value: string }[])
      .filter((n) => matches(n.value))
      .map((n) => n.value);
    const meanings = (db.prepare("SELECT value FROM kanji_meanings WHERE kanji = ? AND lang = 'en' ORDER BY rowid").all(literal) as { value: string }[])
      .map((m) => m.value);
    out.push({ literal, readings: [...hitReadings, ...hitNanori], meanings });
  }
  return out;
}

// ---- thesaurus -------------------------------------------------------------

export interface ThesaurusHit {
  word: LoadedWord;
  /** gloss of the referenced sense (or the first gloss when no sense is given). */
  gloss: string;
}

/** Glosses of the referenced sense (or the first gloss when no sense given). */
function xrefGloss(word: LoadedWord, sense: number | null): string {
  if (sense != null) {
    const s = word.senses[sense - 1];
    if (s && s.glosses.length > 0) return s.glosses.join("; ");
  }
  return firstGloss(word);
}

const THESAURUS_LIMIT = 5;

/**
 * Thesaurus for a word: synonyms (`related`) and antonyms (`antonym`) from the
 * materialized `thesaurus_links` table — resolved offline into forward links,
 * reverse links, and 2-hop closure rows (see data/build/transform.ts). Rows
 * are read in build order, so the first link to a target wins (preferring the
 * sense-specific gloss of a forward link); targets are de-duplicated and
 * "top" = common words first, then by word id; each list is capped at `limit`
 * (default 5).
 */
export function wordThesaurus(
  db: DB,
  word: LoadedWord,
  limit: number = THESAURUS_LIMIT,
): { synonyms: ThesaurusHit[]; antonyms: ThesaurusHit[] } {
  const collect = (kind: "related" | "antonym"): ThesaurusHit[] => {
    const rows = db.prepare(
      `SELECT to_word, to_sense FROM thesaurus_links
       WHERE kind = ? AND from_word = ? AND to_word != from_word
       ORDER BY rowid`,
    ).all(kind, word.id) as { to_word: string; to_sense: number | null }[];
    const hits: ThesaurusHit[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.to_word)) continue;
      seen.add(r.to_word);
      const target = loadWord(db, r.to_word);
      if (!target) continue;
      hits.push({ word: target, gloss: xrefGloss(target, r.to_sense) });
    }
    hits.sort((a, b) =>
      Number(b.word.common) - Number(a.word.common) ||
      a.word.id.localeCompare(b.word.id, undefined, { numeric: true }),
    );
    return hits.slice(0, limit);
  };
  return { synonyms: collect("related"), antonyms: collect("antonym") };
}

// ---- example sentences ----------------------------------------------------

export interface LoadedSentence {
  id: number;
  japanese: string;
  english: string;
}

/** Sentences whose Japanese contains any writing of the word, ordered by id. */
export function exampleSentences(db: DB, word: LoadedWord): LoadedSentence[] {
  const writings = [...word.kanji.map((k) => k.text), ...word.kana.map((k) => k.text)];
  const matches: { id: number; japanese: string; english: string }[] = [];
  for (const w of writings) {
    matches.push(...db.prepare(
      "SELECT id, japanese, english FROM sentences WHERE japanese LIKE ? ORDER BY id",
    ).all(`%${w}%`) as { id: number; japanese: string; english: string }[]);
  }
  // de-dup by id, preserve ascending
  const seen = new Set<number>();
  const out: LoadedSentence[] = [];
  for (const m of matches) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, japanese: m.japanese, english: m.english });
  }
  return out;
}