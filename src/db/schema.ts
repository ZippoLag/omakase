/**
 * SQLite schema for the offline dictionary DB.
 * Mirrors data-model.md §3. Schema version must bump on any DDL change.
 *
 * SCHEMA_VERSION itself lives in ./schema-version.js so the web app can import
 * the number without bundling the DDL (see that module's comment).
 */
export { SCHEMA_VERSION } from "./schema-version.js";

export const DDL = `
PRAGMA foreign_keys = ON;

-- ============ Provenance ============
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ============ JMdict ============
CREATE TABLE words (
  id     TEXT PRIMARY KEY,
  common INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE writings (
  id               INTEGER PRIMARY KEY,
  word_id          TEXT    NOT NULL REFERENCES words(id),
  kind             TEXT    NOT NULL CHECK (kind IN ('kanji','kana')),
  text             TEXT    NOT NULL,
  common           INTEGER NOT NULL DEFAULT 0,
  romaji           TEXT,
  tags             TEXT,
  applies_to_kanji TEXT
);
CREATE INDEX idx_writings_text      ON writings(text);
CREATE INDEX idx_writings_word      ON writings(word_id);
CREATE INDEX idx_writings_kind_text ON writings(kind, text);
CREATE INDEX idx_writings_romaji    ON writings(romaji) WHERE romaji IS NOT NULL;

CREATE TABLE senses (
  id               INTEGER PRIMARY KEY,
  word_id          TEXT    NOT NULL REFERENCES words(id),
  position         INTEGER NOT NULL,
  part_of_speech   TEXT    NOT NULL,
  applies_to_kanji TEXT    NOT NULL,
  applies_to_kana   TEXT    NOT NULL,
  field            TEXT,
  dialect          TEXT,
  misc             TEXT,
  info             TEXT,
  language_source  TEXT,
  related          TEXT,
  antonym          TEXT
);
CREATE INDEX idx_senses_word ON senses(word_id);

CREATE TABLE glosses (
  id       INTEGER PRIMARY KEY,
  sense_id INTEGER NOT NULL REFERENCES senses(id),
  lang     TEXT    NOT NULL,
  type     TEXT,
  gender   TEXT,
  text     TEXT    NOT NULL
);
CREATE INDEX idx_glosses_sense ON glosses(sense_id);

-- ============ KANJIDIC2 ============
CREATE TABLE kanji (
  literal           TEXT PRIMARY KEY,
  stroke_count      INTEGER,
  grade             INTEGER,
  frequency         INTEGER,
  jlpt_level        INTEGER,
  classical_radical INTEGER,
  radical_names     TEXT,
  variants          TEXT,
  codepoints        TEXT
);

CREATE TABLE kanji_readings (
  kanji   TEXT NOT NULL REFERENCES kanji(literal),
  type    TEXT NOT NULL CHECK (type IN ('on','kun')),
  value   TEXT NOT NULL,
  on_type TEXT
);
CREATE INDEX idx_kanji_readings_value ON kanji_readings(value);
CREATE INDEX idx_kanji_readings_kanji ON kanji_readings(kanji);

CREATE TABLE kanji_meanings (
  kanji TEXT NOT NULL REFERENCES kanji(literal),
  lang  TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX idx_kanji_meanings_kanji ON kanji_meanings(kanji);

CREATE TABLE kanji_nanori (
  kanji TEXT NOT NULL REFERENCES kanji(literal),
  value TEXT NOT NULL
);
CREATE INDEX idx_kanji_nanori_kanji ON kanji_nanori(kanji);

-- ============ Radicals ============
CREATE TABLE radicals (
  radical      TEXT PRIMARY KEY,
  stroke_count INTEGER,
  code         TEXT
);

CREATE TABLE kanji_radicals (
  kanji   TEXT NOT NULL REFERENCES kanji(literal),
  radical TEXT NOT NULL REFERENCES radicals(radical),
  PRIMARY KEY (kanji, radical)
);
CREATE INDEX idx_kanji_radicals_radical ON kanji_radicals(radical);

-- ============ Enrichment: kanji -> words ============
CREATE TABLE kanji_words (
  kanji      TEXT    NOT NULL REFERENCES kanji(literal),
  word_id    TEXT    NOT NULL REFERENCES words(id),
  writing_id INTEGER NOT NULL REFERENCES writings(id),
  position   INTEGER NOT NULL
);
CREATE INDEX idx_kanji_words_kanji ON kanji_words(kanji);
CREATE INDEX idx_kanji_words_word  ON kanji_words(word_id);

-- ============ Enrichment: M2 tables (created empty; populated later) ============
CREATE TABLE conjugations (
  word_id TEXT NOT NULL REFERENCES words(id),
  reading TEXT NOT NULL,
  class   TEXT NOT NULL,
  form    TEXT NOT NULL,
  value   TEXT NOT NULL,
  display TEXT
);
CREATE INDEX idx_conjugations_value   ON conjugations(value);
CREATE INDEX idx_conjugations_display ON conjugations(display) WHERE display IS NOT NULL;
CREATE INDEX idx_conjugations_word    ON conjugations(word_id);

CREATE TABLE furigana (
  word_id  TEXT NOT NULL REFERENCES words(id),
  writing  TEXT NOT NULL,
  reading  TEXT NOT NULL,
  segments TEXT NOT NULL
);
CREATE INDEX idx_furigana_word ON furigana(word_id);

CREATE TABLE sentences (
  id       INTEGER PRIMARY KEY,
  japanese TEXT NOT NULL,
  english  TEXT NOT NULL
);
CREATE INDEX idx_sentences_japanese ON sentences(japanese);

CREATE TABLE word_sentences (
  word_id     TEXT    NOT NULL REFERENCES words(id),
  sentence_id INTEGER NOT NULL REFERENCES sentences(id),
  PRIMARY KEY (word_id, sentence_id)
);

-- ============ Enrichment: thesaurus links (derived at build time) ============
-- Scored relation graph, materialized offline so the runtime thesaurus is a
-- single indexed read (no per-xref lookups, no query-time FTS scoring).
--   kind    synonym  a defensible substitute: real mutual xref "related", or
--                    a gloss-similarity edge that cleared the score gate
--           related  a one-directional JMdict "related" ("see also") term
--           antonym  explicit JMdict "antonym"
--   source  xref / gloss (a curated 'wn' source may join later)
--   score   1 for xref edges, the weighted-Dice confidence for gloss ones
--   from_sense / to_sense  matched sense numbers (1-based), so a hit shows
--           the gloss of the sense that actually matched
-- Self-links, unresolvable xrefs and duplicate targets are dropped; the first
-- link to a target wins. 2-hop closure is deliberately NOT materialized —
-- synonyms-of-synonyms was the dominant noise source (THESAURUS-PLAN.md).
CREATE TABLE thesaurus_links (
  kind       TEXT    NOT NULL CHECK (kind IN ('synonym','related','antonym')),
  source     TEXT    NOT NULL DEFAULT 'xref' CHECK (source IN ('xref','gloss')),
  from_word  TEXT    NOT NULL REFERENCES words(id),
  to_word    TEXT    NOT NULL REFERENCES words(id),
  from_sense INTEGER,                    -- source sense number (1-based); NULL for xref reverse edges
  to_sense   INTEGER,                    -- target sense number (1-based); NULL when unspecified
  score      REAL    NOT NULL DEFAULT 1, -- 0..1 confidence (xref edges are 1)
  hops       INTEGER NOT NULL DEFAULT 1 CHECK (hops IN (1,2)) -- vestigial: always 1, no 2-hop rows
);
CREATE INDEX idx_thesaurus_from ON thesaurus_links(kind, from_word, score DESC);
CREATE INDEX idx_thesaurus_to   ON thesaurus_links(kind, to_word);

CREATE TABLE stroke_order (
  kanji    TEXT PRIMARY KEY REFERENCES kanji(literal),
  svg_file TEXT NOT NULL
);

-- ============ Full-text search (FTS5) ============
CREATE VIRTUAL TABLE writings_fts USING fts5(
  text, romaji,
  content='', tokenize='trigram'
);
CREATE VIRTUAL TABLE glosses_fts USING fts5(
  text,
  content='', tokenize='unicode61'
);
`;
