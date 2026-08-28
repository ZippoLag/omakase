# Architecture: offline Japanese quick-reference CLI

**Target:** a 100% offline command-line tool for quick reference of kanji (readings, strokes, composition), words, compounds, conjugations, and example sentences.
**Decisions this builds on:** data backbone = jmdict-simplified (see `tangorin_sources.md` §8); storage = SQLite + FTS5 (see `data-model.md`).

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | **TypeScript + Node.js 20+** | WanaKana (romaji↔kana) and kuromoji.js (tokenizer) are JS libraries — using them natively avoids reimplementing kana conversion; jmdict-simplified ships TS types + NPM loader; logic stays portable if a GUI is ever wanted |
| SQLite | **better-sqlite3** | Fastest synchronous binding; perfect for CLI (no async ceremony); native, no WASM needed |
| CLI framework | **commander** (or hand-rolled arg parsing) | Small, standard; also support `--json` output for scripting |
| Romaji/kana | **WanaKana** | Handles romaji input → kana (typing "taberu" finds 食べる) |
| Tokenizer | **kuromoji.js** (lazy-loaded) | Only needed for sentence tokenization / deconjugation assist; 41 MB dict is an *optional* dependency |
| Conjugation | **own engine** (from JMdict POS tags) | No off-the-shelf data source; validated against japanese-language-data `conjugations.json` (3,511 tables) — full spec in `conjugation-engine.md` |
| Testing | **node:test** + golden fixtures | Zero extra deps |
| Packaging | `npm` package; optional single-binary via Bun/`pkg` later | Native module bundling is a follow-up, not v1 |

---

## 2. Layers

```
┌─────────────────────────────────────────────────────────────┐
│  CLI layer            src/commands/*   arg parsing, output  │
├─────────────────────────────────────────────────────────────┤
│  Service layer        src/services/*   domain logic         │
│    search · words · kanji · radicals · conjugation          │
│    sentences · strokes · tokenizer · romaji                 │
├─────────────────────────────────────────────────────────────┤
│  Storage layer        src/db/*         read-only SQLite     │
│    schema.ts (DDL) · connection.ts · queries.ts             │
├─────────────────────────────────────────────────────────────┤
│  Data layer           dist/            kanji.db + strokes/  │
│    built offline by the build pipeline (data/build/*)       │
└─────────────────────────────────────────────────────────────┘
```

- **Storage layer** is the only module that touches SQLite. Opens the DB **read-only** (`SQLITE_OPEN_READONLY`), `PRAGMA query_only = ON`, prepared statements only.
- **Services** are pure functions over queries — no IO except the DB handle. Each maps 1:1 to a feature.
- **CLI commands** are thin: parse args → call service → format (plain table or `--json`).
- **Data layer** is an artifact, not code: produced at build time, shipped with the tool.

---

## 3. Data flow

### Build pipeline (offline, run by the maintainer / CI — not at runtime)

```
jmdict-simplified release (1.44 MB tgz) ─┐
KanjiVG main zip (12.65 MB) ─────────────┤
curated Tatoeba JA–EN (9.9 MB JSON) ─────┤→  data/build/
JmdictFurigana + kradfile/radkfile ──────┘     fetch.ts (pinned URLs + sha256)
                                               parse.ts (JSON → typed structs)
                                               transform.ts (writings, senses, glosses,
                                                   kanji readings/meanings, radicals,
                                                   kanji_words, conjugations, furigana,
                                                   word_sentences, romaji columns)
                                               buildDb.ts (one tx per dict → kanji.db)
                                               rebuild FTS (trigram + unicode61)
                                               package.ts (dist/: kanji.db, strokes/*.svg, meta.json)
```

Output: **`dist/kanji.db`** (~15–20 MB) + **`dist/strokes/*.svg`** (~9–10 MB Jōyō) + **`dist/meta.json`** (source versions, dates, licenses — printed by `japanese info`).

### Query flow (runtime, every command)

```
input → normalize (WanaKana: romaji→kana; kuromoji: deconjugate if needed)
      → service query (prepared statement, indexes from data-model.md §4)
      → format (table / JSON) → stdout, exit 0/1
```

All data is local; there is **no runtime network access** by design.

---

## 4. CLI command surface

| Command | Feature | Backing table/index |
|---|---|---|
| `japanese kanji 食` | readings (on/kun + nanori), meanings, stroke count, grade, JLPT, frequency, radical, decomposition | `kanji` + `kanji_readings` + `kanji_meanings` + `kanji_radicals` |
| `japanese kanji 食 --words` | compounds: words containing the kanji (with furigana) | `kanji_words` |
| `japanese kanji --radical 氵 --radical 口` | multi-radical search (intersection) | `kanji_radicals` (PK) |
| `japanese kanji --stroke 8 --grade 3` | filter by stroke count / grade / JLPT | `kanji` covering indexes |
| `japanese word 食べる` | definitions, readings, POS, furigana, common flag | `words` + `writings` + `senses` + `glosses` + `furigana` |
| `japanese word taberu` | romaji input | WanaKana → `writings.romaji` |
| `japanese search eat` | English full-text search | `glosses_fts` (unicode61) |
| `japanese search たべ` | reading prefix / kanji substring search | `writings_fts` (trigram) + `idx_writings_text` |
| `japanese conjugate 食べる` | full conjugation table (polite/plain, tenses, forms) | `conjugations` (by `word_id`) |
| `japanese deconjugate 食べて` | → base forms 食べる, 食べれる, … | `conjugations` (by `value`) — index-backed, instant |
| `japanese sentence 食` | example sentences for a word/kanji | `word_sentences` + `sentences` |
| `japanese stroke 食` | stroke count, stroke order summary; `--export out.svg` writes the KanjiVG file; `--animate out.gif` (optional) | `stroke_order` + `strokes/*.svg` |
| `japanese radical 水` | kanji grouped by radical | `radicals` + `kanji_radicals` |
| `japanese info` | data provenance: sources, versions, dates, licenses | `meta` table |

**Output contract:** human-readable aligned tables by default; every command supports `--json` (stable schema for scripting) and `--limit`. Exit 0 on found results, 1 on no match / error. `--help` on every command.

---

## 5. Offline & packaging strategy

- **No runtime network.** The tool ships with `dist/` (DB + strokes + meta). First install = single `npm install` (or copied artifact); no downloads at run time.
- **kuromoji (41 MB) is an optional dependency** — only required for sentence tokenization; `deconjugate` works without it via the `conjugations` index. `package.json` marks it `optionalDependencies`, loaded lazily.
- **Refreshing data** = re-running the build pipeline (a maintainer action), producing a new `dist/`. The app binary never changes; data artifacts are versioned via `meta.json`.
- **Distribution:** plain Node package first; single-binary via Bun `--compile` or `pkg` is a documented follow-up (native-module bundling needs verification).

---

## 6. Performance notes

- DB is read-only and opened once per invocation; typical lookups are single-row B-tree hits (<1 ms).
- FTS5 trigram index makes kanji substring search fast even on the full 218k build.
- WanaKana loads in ~ms; kuromoji is lazy (only for `--tokenize`/sentence matching).
- Startup target: < 100 ms to first result on a modern machine (no heavy init).

---

## 7. Testing & validation

| Layer | Test |
|---|---|
| Transform | fixture-based: known entries (食べる, する, 来る, いい, edge kanji) → exact DB rows |
| Schema | validate against `data-model.md` DDL; integrity checks (FKs, no NULL glosses, sense positions) |
| Conjugation | diff against japanese-language-data `conjugations.json` for the overlapping word set; hand-verified edge cases (v5k-s, v5aru, いい, suru/来る irregulars) |
| Search | golden queries: English `eat`, kana `たべ`, kanji substring `食`, romaji `taberu`, deconjugate `食べて` |
| Data provenance | checksums of pinned source versions; `japanese info` output matches `meta.json` |

---

## 8. Milestones

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Bootstrap** | Repo, tsconfig, build pipeline skeleton, fetch + parse jmdict-simplified eng-common, build DB | `dist/kanji.db` builds; opens read-only |
| **M1 — Core lookups** | `word`, `search`, `kanji`, `info` commands; WanaKana romaji input | Golden tests pass; <100 ms lookups |
| **M2 — Enrichment** | `kanji --words` (compounds), `conjugate`, `deconjugate`, `sentence`, `radical`, multi-radical search, furigana rendering, stroke export | All commands working offline against Jōyō set |
| **M3 — Polish** | `--json` everywhere, limits/paging, error handling, packaging (npm + optional single binary), README with attribution | Releaseable v1.0 |

---

## 9. Open questions / future

- **Full dictionary toggle:** add `--full` flag shipping the full 218k JMdict (adds ~120 MB) once eng-common proves out.
- **Pitch accent:** Kanjium data (17.8 MB) can be added to the `writings` table later.
- **GUI wrapper:** service layer is framework-agnostic, so a web/Tauri shell could reuse it unchanged.
- **Stroke animation in terminal:** out of scope for v1 (SVG export only); could render ASCII/Unicode block animation as a stretch goal.
