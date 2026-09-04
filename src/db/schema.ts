/**
 * SQLite schema for the offline dictionary DB.
 * Mirrors data-model.md §3. Schema version must bump on any DDL change.
 */
export const SCHEMA_VERSION = 3;

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
-- Resolved cross-reference graph from senses.related/antonym: one row per
-- forward link, its reverse (relatedness and antonymy are symmetric), and
-- 2-hop closure rows (related→related gives synonyms-of-synonyms;
-- related→antonym gives indirect antonyms). Materialized offline so the
-- runtime thesaurus is a single indexed query instead of per-xref lookups.
CREATE TABLE thesaurus_links (
  kind      TEXT    NOT NULL CHECK (kind IN ('related','antonym')),
  from_word TEXT    NOT NULL REFERENCES words(id),
  to_word   TEXT    NOT NULL REFERENCES words(id),
  to_sense  INTEGER,              -- referenced sense number (1-based); NULL when unspecified / reverse / 2-hop
  hops      INTEGER NOT NULL DEFAULT 1 CHECK (hops IN (1,2))
);
CREATE INDEX idx_thesaurus_from ON thesaurus_links(kind, from_word);
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
