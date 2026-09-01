# App data model & storage decision

**Decision:** store the offline dictionary in **SQLite (one file)** with **FTS5** for full-text search, and keep **KanjiVG SVGs as loose asset files** referenced by an index table. Schema and rationale below, mapped 1:1 to the jmdict-simplified JSON schema (verified against `@scriptin/jmdict-simplified-types/index.ts`, release 3.6.2+20260824).

---

## 1. Why SQLite (and why not the alternatives)

| Option | Verdict | Why |
|---|---|---|
| **SQLite + FTS5** | ✅ **Pick** | Single file, zero server, transactional, B-tree indexes, built-in full-text search (FTS5), portable to every target: native on iOS/Android/desktop, `sql.js` / `wa-sqlite` (WASM) in the browser — keeps the 100%-offline promise. A 30k-entry common JMdict fits in ~12–15 MB *including* indexes, well under the measured 16.5 MB of raw JSON. Incremental updates are easy: rebuild tables in a transaction from each weekly release. |
| Plain JSON (as shipped) | ❌ | No indexes → every lookup is a scan; English search would need a hand-rolled inverted index; larger on disk (16.5 MB) and slower to load. Fine only for the "lean" proof-of-concept. |
| Custom binary format | ❌ | Best read performance, but you write and maintain a query/search layer yourself, and it's the least portable across platforms. High cost, no real win at this data size. |
| LMDB | ❌ | Great read perf, but no SQL, no FTS, and native dependencies on mobile — worse fit than SQLite for a dictionary. |
| DuckDB | ❌ | Columnar/analytics-oriented, heavier runtime, not designed for point lookups on mobile. |

**Layout:** one `.db` file for all structured data (JMdict, KANJIDIC2, radicals, conjugations, furigana, sentences, cross-refs, FTS indexes) + a `strokes/` directory of KanjiVG SVGs (~9–10 MB for Jōyō) referenced by an index table. Strokes stay as files because they're served/animated as-is and never queried.

---

## 2. Source JSON → app tables (mapping)

| jmdict-simplified JSON | App table(s) |
|---|---|
| `JMdict.words[].id` | `words.id` |
| `JMdict.words[].kanji[]` | `writings` (`kind='kanji'`) |
| `JMdict.words[].kana[]` | `writings` (`kind='kana'`) |
| `JMdict.words[].sense[]` | `senses` |
| `JMdict.words[].sense[].gloss[]` | `glosses` |
| `Kanjidic2.characters[]` | `kanji` (misc fields) + `kanji_readings` (ja_on/ja_kun extracted from `readingMeaning.groups`) + `kanji_meanings` + `kanji_nanori` |
| `Kradfile.kanji` (kanji → components) | `kanji_radicals` |
| `Radkfile.radicals` (radical → info + kanji) | `radicals` |
| *derived from JMdict writings* | `kanji_words` (kanji → words that contain it) |
| *derived from POS tags / conjugation engine* | `conjugations` |
| *from JmdictFurigana* | `furigana` |
| *from curated Tatoeba + matching* | `sentences`, `word_sentences` |
| *from KanjiVG files* | `stroke_order` (index) |

Notes on JMdict quirks the schema preserves (from the type docs):
- `kanji` and `kana` are both *writings*, not strictly "spelling vs reading" — some words are kana-only, and some `kanji` writings contain non-kanji (e.g. `ＣＤプレイヤー`).
- A kana writing may only apply to specific kanji writings (`appliesToKanji`, `"*"` = all) — keep it.
- A sense may only apply to specific kanji/kana writings (`appliesToKanji`/`appliesToKana`) — keep it.
- POS tags are normalized per-sense (never inherited) — this is what the conjugation engine keys off.

---

## 3. SQLite schema (DDL)

```sql
PRAGMA foreign_keys = ON;

-- ============ Provenance ============
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,  -- 'schema_version', 'jmdict_release', 'kanjidic_dbver', 'built_at'
  value TEXT
);

-- ============ JMdict ============
-- One row per JMdict entry.
CREATE TABLE words (
  id     TEXT PRIMARY KEY,           -- JMdict entry id, e.g. '1001230'
  common INTEGER NOT NULL DEFAULT 0  -- 1 if any writing carries the 'common' flag
);

-- All spellings of all words (kanji + kana forms).
CREATE TABLE writings (
  id               INTEGER PRIMARY KEY,
  word_id          TEXT    NOT NULL REFERENCES words(id),
  kind             TEXT    NOT NULL CHECK (kind IN ('kanji','kana')),
  text             TEXT    NOT NULL,             -- the surface form
  common           INTEGER NOT NULL DEFAULT 0,
  romaji           TEXT,                         -- generated for kind='kana' (input search)
  tags             TEXT,                         -- JSON array (ateji, oK, uk, ...)
  applies_to_kanji TEXT                          -- JSON array; kind='kana' only; '*' = all
);
CREATE INDEX idx_writings_text        ON writings(text);
CREATE INDEX idx_writings_word        ON writings(word_id);
CREATE INDEX idx_writings_kind_text   ON writings(kind, text);
CREATE INDEX idx_writings_romaji      ON writings(romaji) WHERE romaji IS NOT NULL;

-- One row per sense (translation block) of an entry.
CREATE TABLE senses (
  id               INTEGER PRIMARY KEY,
  word_id          TEXT    NOT NULL REFERENCES words(id),
  position         INTEGER NOT NULL,             -- sense order within entry (1-based)
  part_of_speech   TEXT    NOT NULL,             -- JSON array of tags, e.g. ["v1","vt"] -- drives conjugations
  applies_to_kanji TEXT    NOT NULL,             -- JSON array; '*' = all
  applies_to_kana   TEXT    NOT NULL,            -- JSON array; '*' = all
  field            TEXT,                         -- JSON array (math, food, ...)
  dialect          TEXT,                         -- JSON array
  misc             TEXT,                         -- JSON array
  info             TEXT,                         -- JSON array
  language_source  TEXT,                         -- JSON array (loanword origins)
  related          TEXT,                         -- JSON array of xref tuples
  antonym          TEXT                          -- JSON array of xref tuples
);
CREATE INDEX idx_senses_word ON senses(word_id);

CREATE TABLE glosses (
  id       INTEGER PRIMARY KEY,
  sense_id INTEGER NOT NULL REFERENCES senses(id),
  lang     TEXT    NOT NULL,                     -- 'eng', 'ger', 'rus', ...
  type     TEXT,                                 -- 'literal'|'figurative'|'explanation'|'trademark'|NULL
  gender   TEXT,                                 -- 'masculine'|'feminine'|'neuter'|NULL
  text     TEXT    NOT NULL
);
CREATE INDEX idx_glosses_sense ON glosses(sense_id);

-- ============ KANJIDIC2 ============
-- One row per kanji. Misc fields flattened from Kanjidic2Character.misc.
CREATE TABLE kanji (
  literal           TEXT PRIMARY KEY,   -- the character
  stroke_count      INTEGER,            -- misc.strokeCounts[0] (canonical)
  grade             INTEGER,            -- 1..8, NULL (Jōyō = 1..6 + 8)
  frequency         INTEGER,            -- newspaper frequency rank (1..2500), NULL
  jlpt_level        INTEGER,            -- old 4-level scale (1..4), NULL
  classical_radical INTEGER,            -- radicals[] where type='classical'
  radical_names     TEXT,               -- JSON array (if this kanji is itself a radical)
  variants          TEXT,               -- JSON array of {type, value}
  codepoints        TEXT                -- JSON array (ucs, jis208, ...)
);

-- on/kun readings, flattened out of readingMeaning.groups for indexability.
CREATE TABLE kanji_readings (
  kanji   TEXT NOT NULL REFERENCES kanji(literal),
  type    TEXT NOT NULL CHECK (type IN ('on','kun')),
  value   TEXT NOT NULL,               -- on: katakana; kun: hiragana (with '.' / '-' markers)
  on_type TEXT                         -- 'kan'|'go'|'tou'|"kan'you"|NULL
);
CREATE INDEX idx_kanji_readings_value ON kanji_readings(value);  -- reading -> kanji lookup

CREATE TABLE kanji_meanings (
  kanji TEXT NOT NULL REFERENCES kanji(literal),
  lang  TEXT NOT NULL,                 -- 'en', 'es', 'fr', ...
  value TEXT NOT NULL
);
CREATE INDEX idx_kanji_meanings_kanji ON kanji_meanings(kanji);

CREATE TABLE kanji_nanori (
  kanji TEXT NOT NULL REFERENCES kanji(literal),
  value TEXT NOT NULL                  -- name-only readings
);
CREATE INDEX idx_kanji_nanori_kanji ON kanji_nanori(kanji);

-- ============ Radicals (kradfile-u + radkfile) ============
CREATE TABLE radicals (
  radical      TEXT PRIMARY KEY,       -- the radical character
  stroke_count INTEGER,
  code         TEXT                    -- JIS code / image ref, NULL
);

-- kanji -> its component radicals (multi-radical search).
CREATE TABLE kanji_radicals (
  kanji   TEXT NOT NULL REFERENCES kanji(literal),
  radical TEXT NOT NULL REFERENCES radicals(radical),
  PRIMARY KEY (kanji, radical)
);
CREATE INDEX idx_kanji_radicals_radical ON kanji_radicals(radical);

-- ============ Enrichment: kanji -> words (compounds) ============
-- Built at import: for every kanji character in every 'kanji' writing,
-- a row records that this kanji composes this word. Powers "composed use
-- into more complex terms" (e.g. 食 -> 食べる, 食事, 食堂...).
CREATE TABLE kanji_words (
  kanji      TEXT    NOT NULL REFERENCES kanji(literal),
  word_id    TEXT    NOT NULL REFERENCES words(id),
  writing_id INTEGER NOT NULL REFERENCES writings(id),
  position   INTEGER NOT NULL          -- index of the kanji within the writing
);
CREATE INDEX idx_kanji_words_kanji ON kanji_words(kanji);
CREATE INDEX idx_kanji_words_word  ON kanji_words(word_id);

-- ============ Enrichment: conjugations ============
-- One row per conjugated form. Generated from senses.part_of_speech
-- (v1/v5*/vk/vs/adj-i/adj-na/...) by our conjugation engine; may be
-- bootstrapped once from japanese-language-data conjugations.json.
CREATE TABLE conjugations (
  word_id TEXT NOT NULL REFERENCES words(id),
  reading TEXT NOT NULL,               -- kana reading the table applies to
  class   TEXT NOT NULL,               -- JMdict POS class (conjugation-engine.md §2)
  form    TEXT NOT NULL,               -- e.g. 'te', 'negative', 'past', 'volitional', ...
  value   TEXT NOT NULL,               -- conjugated surface in kana (deconjugation index target)
  display TEXT                         -- kanji-rendered form (NULL when = value)
);
CREATE INDEX idx_conjugations_value   ON conjugations(value);   -- deconjugation search (食べて -> 食べる)
CREATE INDEX idx_conjugations_display ON conjugations(display) WHERE display IS NOT NULL;
CREATE INDEX idx_conjugations_word    ON conjugations(word_id);

-- ============ Enrichment: furigana ============
CREATE TABLE furigana (
  word_id  TEXT NOT NULL REFERENCES words(id),
  writing  TEXT NOT NULL,              -- kanji writing
  reading  TEXT NOT NULL,              -- kana reading
  segments TEXT NOT NULL               -- JSON: [{"kanji":"食","kana":"たべ"}, ...]
);

-- ============ Enrichment: sentences (curated Tatoeba) ============
CREATE TABLE sentences (
  id       INTEGER PRIMARY KEY,        -- Tatoeba sentence id
  japanese TEXT NOT NULL,
  english  TEXT NOT NULL
);
CREATE INDEX idx_sentences_japanese ON sentences(japanese);

-- word <-> sentence links (built by matching writings in sentence text,
-- optionally via kuromoji tokenization for accuracy).
CREATE TABLE word_sentences (
  word_id     TEXT    NOT NULL REFERENCES words(id),
  sentence_id INTEGER NOT NULL REFERENCES sentences(id),
  PRIMARY KEY (word_id, sentence_id)
);

-- ============ Enrichment: thesaurus links (derived at build time) ============
-- Resolved cross-reference graph from senses.related/antonym: one row per
-- forward link, its reverse (relatedness and antonymy are symmetric), and
-- 2-hop closure rows (related→related gives synonyms-of-synonyms;
-- related→antonym gives indirect antonyms). Self-links, unresolvable xrefs,
-- and repeated targets are dropped at build time (first occurrence keeps its
-- sense-specific gloss). Materialized offline so the runtime thesaurus is a
-- single indexed query instead of per-xref lookups.
CREATE TABLE thesaurus_links (
  kind      TEXT    NOT NULL CHECK (kind IN ('related','antonym')),
  from_word TEXT    NOT NULL REFERENCES words(id),
  to_word   TEXT    NOT NULL REFERENCES words(id),
  to_sense  INTEGER,              -- referenced sense number (1-based); NULL when unspecified / reverse / 2-hop
  hops      INTEGER NOT NULL DEFAULT 1 CHECK (hops IN (1,2))
);
CREATE INDEX idx_thesaurus_from ON thesaurus_links(kind, from_word);
CREATE INDEX idx_thesaurus_to   ON thesaurus_links(kind, to_word);

-- ============ Enrichment: stroke order (KanjiVG) ============
-- SVGs stored as files in assets/strokes/; this maps kanji -> file.
CREATE TABLE stroke_order (
  kanji    TEXT PRIMARY KEY REFERENCES kanji(literal),
  svg_file TEXT NOT NULL               -- e.g. '06f35.svg'
);

-- ============ Full-text search (FTS5) ============
-- Contentless FTS tables (index only; join back by rowid), rebuilt per release.
-- trigram tokenizer (SQLite >= 3.34) gives kanji substring matching
-- (search 食べ -> 食べる, and partial compounds); unicode61 tokenizes English.
CREATE VIRTUAL TABLE writings_fts USING fts5(
  text, romaji,
  content='', tokenize='trigram'
);
CREATE VIRTUAL TABLE glosses_fts USING fts5(
  text,
  content='', tokenize='unicode61'
);
```

**Row counts (full jmdict-eng build, 2026-08-29):** words 218,577, writings 498,621, senses 253,299, glosses 442,536, kanji 13,108, kanji_readings 37,048, kanji_meanings 48,088, kanji_nanori 3,454, kanji_radicals 54,321, kanji_words 584,238, conjugations 506,348 (34,609 words), sentences 25,980, word_sentences ~45k, thesaurus_links (schema v2) 129,673 rows. All trivially within SQLite's comfort zone. The thesaurus_links closure lifts coverage from the raw xrefs: 32,014 → 50,917 words with synonym links and 1,054 → 1,546 words with antonym links (445 antonym pairs come from 2-hop closure, 524 from reverse edges).

---

## 4. Query patterns → index strategy

| Feature | Query | Index / mechanism |
|---|---|---|
| Kanji detail (readings, meanings, strokes, grade, JLPT, radical) | `SELECT ... FROM kanji WHERE literal = ?` + joins | PK on `kanji.literal` |
| Kanji lookup by reading (kana or romaji) | `kanji_readings.value` / prefix | `idx_kanji_readings_value` |
| Word lookup by spelling | `writings.text = ?` / prefix | `idx_writings_text` |
| Partial / compound search | `writings_fts MATCH '食べる'` (≥3 chars); `writings.text LIKE '%食%'` (1–2 chars) | FTS5 trigram has a 3-char minimum — the search layer must fall back to a LIKE scan for shorter queries (54k rows, still fast) |
| English meaning search | `glosses_fts MATCH 'eat'` | FTS5 unicode61 |
| Words containing a kanji ("composed use") | `kanji_words WHERE kanji = ?` | `idx_kanji_words_kanji` |
| Kanji by radical(s) (multi-radical) | `kanji_radicals` intersection | PK + `idx_kanji_radicals_radical` |
| Kanji by stroke count / grade / JLPT | `kanji WHERE stroke_count/grade/jlpt_level = ?` | add covering indexes as needed |
| Conjugation display | `conjugations WHERE word_id = ?` | `idx_conjugations_word` |
| Deconjugation (食べて → 食べる) | `conjugations WHERE value = ?` | `idx_conjugations_value` |
| Example sentences for a word | `word_sentences` → `sentences` | PK on `(word_id, sentence_id)` |
| Thesaurus (synonyms/antonyms) | `thesaurus_links WHERE kind = ? AND from_word = ?` (forward + reverse + 2-hop already materialized) | `idx_thesaurus_from` |
| Stroke order for a kanji | `stroke_order WHERE kanji = ?` | PK |
| Romaji input | `writings.romaji` prefix | `idx_writings_romaji` |

---

## 5. Build & update notes

- **Import pipeline** (per release): stream each jmdict-simplified JSON → `INSERT` inside one transaction per dictionary → build `kanji_words`, `conjugations`, `furigana`, `word_sentences` → rebuild FTS (`INSERT INTO writings_fts(writings_fts) VALUES('rebuild')`) → `PRAGMA optimize` → write `meta` (release tag, dates, licenses).
- **Weekly refresh**: the DB is fully regenerable from the latest jmdict-simplified release (1.44 MB download, measured) + KanjiVG + curated Tatoeba; bump `meta.schema_version` only when the DDL changes.
- **Browser target**: use `wa-sqlite` (any modern SQLite, incl. trigram FTS5) or `sql.js`; ship the `.db` as an asset, open it read-only, `PRAGMA query_only = ON`.
- **Measured size on disk (2026-08-29)**: DB **289.6 MB** (full jmdict-eng, 218,577 words + 506k conjugation rows + FTS) + strokes ~9–10 MB + kuromoji 41 MB → ~340 MB total. The trigram FTS index (~3× text) and the conjugation table are the main cost. The build takes ~18 s on a laptop (transform 2 s + inserts 14 s); the full-dictionary build previously hit an O(words × conjugations) summary computation in `data/build/index.ts`, now replaced with a Set lookup.
