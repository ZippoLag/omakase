/**
 * Build dist/kanji.db from transformed rows. One transaction per dictionary
 * group; FTS indexes rebuilt last; DB left read-only friendly (query_only
 * is a connection setting, so we just build cleanly here).
 */
import Database from "better-sqlite3";

type DB = InstanceType<typeof Database>;
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION } from "../../src/db/schema.js";
import type { Transformed } from "./transform.js";
import { DB_PATH } from "./config.js";

export type BuildOptions = {
  /** DB file path, or ':memory:' for an in-memory database (tests). */
  dbPath?: string;
};

export interface BuildSummary {
  words: number;
  writings: number;
  senses: number;
  glosses: number;
  kanji: number;
  kanjiReadings: number;
  kanjiMeanings: number;
  kanjiNanori: number;
  radicals: number;
  kanjiRadicals: number;
  kanjiWords: number;
  conjugations: number;
  furigana: number;
  thesaurusLinks: number;
  /** stroke_order rows (kanji with a KanjiVG svg), added after buildDb. */
  strokes: number;
  dbBytes: number;
}

export function summarize(rows: Transformed, dbBytes: number): BuildSummary {
  return {
    words: rows.words.length,
    writings: rows.writings.length,
    senses: rows.senses.length,
    glosses: rows.glosses.length,
    kanji: rows.kanji.length,
    kanjiReadings: rows.kanjiReadings.length,
    kanjiMeanings: rows.kanjiMeanings.length,
    kanjiNanori: rows.kanjiNanori.length,
    radicals: rows.radicals.length,
    kanjiRadicals: rows.kanjiRadicals.length,
    kanjiWords: rows.kanjiWords.length,
    conjugations: rows.conjugations.length,
    furigana: rows.furigana.length,
    thesaurusLinks: rows.thesaurusLinks.length,
    strokes: 0, // populated by the build entrypoint after the svg files are written
    dbBytes,
  };
}

export function buildDb(rows: Transformed, meta: Record<string, string>, options: BuildOptions = {}): DB {
  const dbPath = options.dbPath ?? DB_PATH;
  if (dbPath !== ":memory:") {
    rmSync(dbPath, { force: true });
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);

  db.exec(DDL);

  const insert = {
    words: db.prepare("INSERT INTO words (id, common) VALUES (?, ?)"),
    writings: db.prepare(
      "INSERT INTO writings (id, word_id, kind, text, common, romaji, tags, applies_to_kanji) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    senses: db.prepare(
      "INSERT INTO senses (id, word_id, position, part_of_speech, applies_to_kanji, applies_to_kana, field, dialect, misc, info, language_source, related, antonym) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    glosses: db.prepare("INSERT INTO glosses (id, sense_id, lang, type, gender, text) VALUES (?, ?, ?, ?, ?, ?)"),
    kanji: db.prepare(
      "INSERT INTO kanji (literal, stroke_count, grade, frequency, jlpt_level, classical_radical, radical_names, variants, codepoints) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    kanjiReadings: db.prepare("INSERT INTO kanji_readings (kanji, type, value, on_type) VALUES (?, ?, ?, ?)"),
    kanjiMeanings: db.prepare("INSERT INTO kanji_meanings (kanji, lang, value) VALUES (?, ?, ?)"),
    kanjiNanori: db.prepare("INSERT INTO kanji_nanori (kanji, value) VALUES (?, ?)"),
    radicals: db.prepare("INSERT INTO radicals (radical, stroke_count, code) VALUES (?, ?, ?)"),
    kanjiRadicals: db.prepare("INSERT INTO kanji_radicals (kanji, radical) VALUES (?, ?)"),
    kanjiWords: db.prepare("INSERT INTO kanji_words (kanji, word_id, writing_id, position) VALUES (?, ?, ?, ?)"),
    conjugations: db.prepare("INSERT INTO conjugations (word_id, reading, class, form, value, display) VALUES (?, ?, ?, ?, ?, ?)"),
    furigana: db.prepare("INSERT INTO furigana (word_id, writing, reading, segments) VALUES (?, ?, ?, ?)"),
    thesaurusLinks: db.prepare("INSERT INTO thesaurus_links (kind, from_word, to_word, to_sense, hops) VALUES (?, ?, ?, ?, ?)"),
    meta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)"),
  };

  const tx = db.transaction(() => {
    for (const w of rows.words) insert.words.run(w.id, w.common);
    for (const w of rows.writings) insert.writings.run(w.id, w.word_id, w.kind, w.text, w.common, w.romaji, w.tags, w.applies_to_kanji);
    for (const s of rows.senses) insert.senses.run(s.id, s.word_id, s.position, s.part_of_speech, s.applies_to_kanji, s.applies_to_kana, s.field, s.dialect, s.misc, s.info, s.language_source, s.related, s.antonym);
    for (const g of rows.glosses) insert.glosses.run(g.id, g.sense_id, g.lang, g.type, g.gender, g.text);
    for (const k of rows.kanji) insert.kanji.run(k.literal, k.stroke_count, k.grade, k.frequency, k.jlpt_level, k.classical_radical, k.radical_names, k.variants, k.codepoints);
    for (const r of rows.kanjiReadings) insert.kanjiReadings.run(r.kanji, r.type, r.value, r.on_type);
    for (const m of rows.kanjiMeanings) insert.kanjiMeanings.run(m.kanji, m.lang, m.value);
    for (const n of rows.kanjiNanori) insert.kanjiNanori.run(n.kanji, n.value);
    for (const r of rows.radicals) insert.radicals.run(r.radical, r.stroke_count, r.code);
    for (const r of rows.kanjiRadicals) insert.kanjiRadicals.run(r.kanji, r.radical);
    for (const r of rows.kanjiWords) insert.kanjiWords.run(r.kanji, r.word_id, r.writing_id, r.position);
    for (const c of rows.conjugations) insert.conjugations.run(c.word_id, c.reading, c.class, c.form, c.value, c.display);
    for (const f of rows.furigana) insert.furigana.run(f.word_id, f.writing, f.reading, f.segments);
    for (const l of rows.thesaurusLinks) insert.thesaurusLinks.run(l.kind, l.from_word, l.to_word, l.to_sense, l.hops);
  });
  tx();

  // FTS (contentless tables: rowid = base table id)
  const ftsTx = db.transaction(() => {
    const writingsFts = db.prepare("INSERT INTO writings_fts (rowid, text, romaji) VALUES (?, ?, ?)");
    for (const w of rows.writings) writingsFts.run(w.id, w.text, w.romaji ?? "");
    const glossesFts = db.prepare("INSERT INTO glosses_fts (rowid, text) VALUES (?, ?)");
    for (const g of rows.glosses) glossesFts.run(g.id, g.text);
  });
  ftsTx();

  const metaTx = db.transaction(() => {
    for (const [key, value] of Object.entries({ schema_version: String(SCHEMA_VERSION), ...meta })) {
      insert.meta.run(key, value);
    }
  });
  metaTx();

  db.pragma("optimize");
  return db; // caller closes (file mode: close before statSync for portability)
}
