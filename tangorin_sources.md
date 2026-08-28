# Tangorin data sources — and what to use for a 100% offline app

**Research date:** 2026-08-28
**Primary source:** https://tangorin.com/about (Tangorin's own "About / Data sources" page — this is the "comprehensive list of data sources" linked from every Tangorin page footer). Everything else was verified against the upstream projects' own sites.

Tangorin is a free online Japanese–English dictionary built *almost entirely* on open EDRDG (Electronic Dictionary Research and Development Group, Jim Breen) projects plus a few other open datasets. It does **not** rely on any proprietary API — everything below is downloadable data, which makes a fully offline clone very feasible.

---

## 1. What Tangorin actually uses

### Data sources (the content)

| # | Source | Type | What Tangorin uses it for | License |
|---|--------|------|---------------------------|---------|
| 1 | **JMdict** (EDRDG / Jim Breen, est. 1999, successor of EDICT/EDICT2) | Word dictionary, XML, 178,000+ entries | Core of the **Words** dictionary: definitions, POS tags, readings, kanji/kana writings, priority markers, cross-refs | CC BY-SA 4.0 (EDRDG licence) |
| 2 | **KANJIDIC2** (EDRDG) | Kanji dictionary, XML, 13,000+ entries (JIS X 0208/0212/0213) | **Kanji** pages: on/kun readings, meanings, stroke count, grade, frequency, JLPT level, radical, variants | CC BY-SA 4.0 (EDRDG licence) |
| 3 | **JMnedict** (EDRDG) | Named-entity dictionary, XML, 740,000+ proper names (ENAMDICT successor) | **Names** dictionary (people, places, orgs) | CC BY-SA 4.0 (EDRDG licence) |
| 4 | **kradfile-u** (Jim Rose / KanjiCafe.com, based on Michael Raine's 1994 RADKFILE) | Radical decomposition of 13,108 kanji | **Multi-radical search** and the "kanji elements" breakdown on kanji pages | EDRDG licence (same CC BY-SA terms; kradfile-u copyright held by Jim Rose) |
| 5 | **KanjiVG** (Ulrich Apel) | SVG stroke-order diagrams + character decomposition | **Stroke order diagrams** on kanji/word pages, character decomposition | CC BY-SA 3.0 |
| 6 | **Tatoeba** (started 2006 by Trang Ho, based on the Tanaka Corpus) | Example sentences with translations, JA–EN and multi-lingual | **Example sentences** shown under word entries | CC BY 2.0 (FR) / CC0 for some sentences |

### Software (not data — Tangorin's own tooling, not something you "license")

| # | Tool | What Tangorin uses it for | License |
|---|------|---------------------------|---------|
| 7 | **MeCab** (Taku Kudo) | Part-of-speech / morphological analysis — used to **deconstruct example sentences and generate furigana** | GPL (BSD-style terms also apply per MeCab's dual licensing) |
| 8 | **WanaKana** (Tofugu / WaniKani) | JS library for kanji/hiragana/katakana/romaji detection & conversion | MIT |

### Conjugations — no external source
Tangorin's **"Inflection" / conjugation tables** are **not** credited to any external dataset on the About page. They are generated in-house from JMdict's POS tags (ichidan/godan/irregular verb classes, i-/na-adjectives, etc.) by Tangorin's own conjugation engine. See §4 for offline options.

### Links out, not data in
Tangorin word pages link to **Yahoo!辞書, goo辞書, alc.co.jp, Weblio, and Wiktionary** ("Search other dictionaries for …"). These are outbound links only — Tangorin does not import their data, and they are not usable for an offline app.

### API
Tangorin has **no public API** (`https://tangorin.com/api` returns 404). It is a website over a local database built from the files above. Nothing to integrate, which is fine — the raw data is all that's needed.

---

## 2. Where to get each source (canonical + offline-friendly)

All URLs verified as of the research date.

### JMdict — words
- **Canonical:** https://www.edrdg.org/jmdict/edict_doc.html (JMdict.xml / JMdict_e.xml, JMdict.gz; EDICT/EDICT2 legacy text format also available)
- **Offline-friendly JSON:** [scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified) — JMdict in JSON, with `full` and `common-only` variants, per-language versions (English, German, Russian, etc.), and a version built **with Tatoeba example sentences** (from JMdict_e_examp.xml). Released weekly. NPM packages `@scriptin/jmdict-simplified-types` / `-loader` (MIT).
- **Furigana-aligned:** [Doublevil/JmdictFurigana](https://github.com/Doublevil/JmdictFurigana) — maps each kanji in every headword to its reading segments (28,920 entries in the unified dataset below).

### KANJIDIC2 — kanji
- **Canonical:** https://www.edrdg.org/kanjidic/kanjd2index.html (kanjidic2.xml.gz)
- **Offline-friendly JSON:** jmdict-simplified (above) includes Kanjidic2 JSON (English-only default, other languages available).
- Contains per kanji: on/kun readings, English meanings, stroke count, radical, grade (1–8), JLPT level, frequency rank, variant forms, nanori.

### JMnedict — names
- **Canonical:** https://www.edrdg.org/enamdict/enamdict_doc.html (JMnedict.xml.gz)
- **Offline-friendly JSON:** jmdict-simplified (above). ~740k entries, ~30–50 MB — you may want to trim it or leave it optional.

### kradfile-u — radical decomposition
- **Canonical:** https://www.edrdg.org/krad/kradinf.html (RADKFILE/KRADFILE; kradfile-u is the merged/extended version by Jim Rose)
- **Offline-friendly:** jmdict-simplified includes KRADFILE/RADKFILE as JSON; also mirrored in many repos (e.g. jmettraux/kensaku `data/kradfile-u`). Also **KanjiVG** carries radical/component info per character (see below).

### KanjiVG — stroke order
- **Canonical:** https://kanjivg.tagaini.net/ (main zip of all SVGs on the [files page](https://kanjivg.tagaini.net/files.html); GitHub mirror: [KanjiVG/kanjivg](https://github.com/KanjiVG/kanjivg))
- Each SVG contains: ordered stroke paths, stroke types, radicals, and component (element) decomposition — so it covers *both* stroke order and part-composition.
- Coverage: full JIS kanji set; **100% of the 2,136 Jōyō kanji** (verified in the unified dataset below: 6,416 SVGs committed).

### Tatoeba — example sentences
- **Canonical:** https://tatoeba.org/en/downloads (full per-language exports; `sentences.tar.bz2`, links tables)
- **Offline-friendly curated JA–EN:** via jmdict-simplified "with examples" build, or the curated 25,980-pair set in the unified dataset below. Full Tatoeba JP–EN export ≈ 232k pairs.
- License: CC BY 2.0 FR / CC0 (per-sentence choice); derived collections usually CC BY 2.0. Note: **the Japanese half of Tatoeba is not always reliable** — the curated Tanaka-corpus-derived subset is the safer choice for an app.

### MeCab / tokenization (for furigana + sentence parsing)
- **Canonical:** https://taku910.github.io/mecab/ (MeCab itself) + dictionary: `mecab-ipadic` (GPL) or `UniDic` (more accurate, bigger).
- **Offline browser-friendly alternative:** [kuromoji.js](https://github.com/takuyaa/kuromoji.js) — pure-JS MeCab-style tokenizer that runs fully offline in browsers/Node (Apache 2.0, bundled dictionary). Tangorin uses MeCab server-side; you don't have to.

---

## 3. Feature → data source mapping for the offline app

| Feature you want | Source to use | Notes |
|---|---|---|
| Kanji quick reference (readings on/kun, meanings, stroke count, grade, JLPT, frequency, radical) | **KANJIDIC2** (via jmdict-simplified JSON) | Everything is one record per kanji; trivially indexable |
| Reading ways / furigana for words | **JMdict** `r_ele` readings + **JmdictFurigana** for kanji→kana segment alignment | Needed to render ruby text correctly |
| Writing strokes (stroke order diagrams) | **KanjiVG** SVGs | Animate by iterating the ordered stroke paths; also gives stroke count cross-check |
| Kanji → component/radical decomposition | **kradfile-u** + **KanjiVG** element data | Tangorin's "kanji elements" + multi-radical search |
| Composition into compound terms (jukugo) | **JMdict** (all compounds are entries) + a **kanji→word cross-reference index** | Build the index yourself from JMdict, or use the prebuilt one (see §4) |
| Conjugations | **No data source needed** — generate from JMdict POS tags | Tangorin does exactly this; see options below |
| Example sentences | **Tatoeba** (curated JA–EN subset) | Tag sentences with their JMdict word IDs for lookups |
| Proper names | **JMnedict** | Optional big download (~740k entries) |
| POS tagging / tokenization for parsing input & sentences | **kuromoji.js** (browser) or **MeCab** + ipadic/UniDic (native) | Needed to split input like "食べて" into dictionary forms |

### Conjugation options (Tangorin generates these; so can you)
1. **Roll your own engine** from JMdict POS tags (ichidan `v1`, godan `v5*`, irregular `vk/vs/vz`, i-adj `adj-i`, na-adj `adj-na`). Tangorin's own approach. Moderate effort, full control.
2. **Use a precomputed dataset:** the unified dataset below ships **`data/grammar/conjugations.json` — 3,511 conjugation tables** (ichidan, godan incl. edge cases, suru-verbs, i-/na-adjectives, irregular いい).
3. **Use an open-source library:** Kuroshiro (JS), fasiha/kamiya-codec (JS), japanese-verb-conjugator (Python), Doushi (C#), or kuromoji-based deconjugators. All run offline.

---

## 4. One-stop prepackaged options (strongly recommended to evaluate)

Instead of stitching raw XML yourself, consider starting from one of these:

1. **[scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified)** — JMdict + JMnedict + Kanjidic2 + KRADFILE/RADKFILE all in consistent JSON, refreshed weekly, CC BY-SA 4.0. This alone covers ~90% of Tangorin's content (everything except KanjiVG SVGs and Tatoeba sentences, which you add separately).

2. **[jkindrix/japanese-language-data](https://github.com/jkindrix/japanese-language-data)** — a unified, cross-linked, reproducible, CC BY-SA 4.0 dataset (~277k entries) that aggregates **JMdict, KANJIDIC2, KanjiVG, Tatoeba, Kanjium (pitch accent), Waller JLPT lists, and Wikipedia Kangxi radicals** — plus prebuilt cross-reference indices and conjugation tables. Includes:
   - `kanji.json` (13,108), `words.json` (23,119 common + full 216k on demand), `radicals.json`, JMnedict names on demand
   - KanjiVG stroke-order SVGs (6,416, 100% Jōyō coverage) + index
   - `conjugations.json` (3,511 tables), `furigana.json` (28,920), `jukugo-compounds.json` (14,350)
   - Cross-refs: **kanji→words (3,589), kanji→radicals (12,156), reading→words (24,927), word→sentences (14,842)**, etc.
   - This is the closest thing to "Tangorin as a downloadable database" that exists today.

3. **[yomidevs/jmdict-yomitan](https://github.com/yomidevs/jmdict-yomitan)** — JMdict/JMnedict/KANJIDIC packaged for the Yomitan browser extension; a proven, compact, indexed format you could embed or convert from.

---

## 5. Licensing notes & gotchas

- **JMdict, KANJIDIC2, JMnedict:** CC BY-SA 4.0 ("EDRDG licence", https://www.edrdg.org/edrdg/licence.html). **Share-alike:** any distribution of a derived work must be under CC BY-SA 4.0 and must credit EDRDG. Fine for a free/offline app; relevant if you plan a closed-source commercial app.
- **kradfile-u:** EDRDG licence; copyright of the kradfile2/u revisions held by Jim Rose.
- **KanjiVG:** CC BY-SA 3.0 — same share-alike condition; attribute Ulrich Apel.
- **Tatoeba:** CC BY 2.0 FR (some CC0) — attribution to Tatoeba and sentence authors required. The original **Tanaka Corpus** subset is what most dictionaries (incl. Tangorin) surface.
- **MeCab:** GPL; `mecab-ipadic` GPL. Prefer **kuromoji.js** (Apache 2.0) if you want to avoid GPL in a browser app.
- **WanaKana:** MIT — trivially reusable for kana/romaji input handling.
- **Mix-and-match is safe** as long as the whole shipped dataset stays CC BY-SA-compatible; MIT/Apache *code* libraries can be bundled alongside without forcing your code to be share-alike.

---

## 6. Approximate sizes (for the offline bundle)

| Dataset | Approx. size | Notes |
|---|---|---|
| KANJIDIC2 (XML) | ~4 MB | ~13k kanji |
| JMdict (XML) | ~60 MB | ~200k entries; EDICT2 text is ~4 MB |
| JMdict "common-only" JSON | ~5–10 MB | jmdict-simplified `common` variant — plenty for quick reference |
| JMdict full JSON | ~100–150 MB | jmdict-simplified `full` |
| JMnedict | ~30–50 MB | ~740k names; optional |
| KanjiVG (all SVGs) | ~15–30 MB zipped | ~13k files; Jōyō-only subset is much smaller |
| kradfile-u | ~100 KB | trivial |
| Tatoeba JP–EN (curated) | ~5–10 MB | 25–30k pairs; full export is ~50 MB+ |
| kuromoji.js + dict | ~30 MB | tokenizer for input parsing/furigana |
| **unified dataset (japanese-language-data)** | ~150 MB committed; full build larger | everything above except JMnedict + full corpora (on demand) |

A genuinely "quick reference" offline app can ship comfortably well under 100 MB by using the common-only JMdict, Jōyō-subset KanjiVG SVGs, curated Tatoeba, and kuromoji.

---

## 7. Bottom line

Tangorin is built from **six open datasets (JMdict, KANJIDIC2, JMnedict, kradfile-u, KanjiVG, Tatoeba) + two open libraries (MeCab, WanaKana)** — no proprietary APIs, no paid feeds. Every feature you listed maps to a downloadable, offline-bundlable source:

- kanji + readings → **KANJIDIC2**
- stroke order → **KanjiVG**
- composition/compounds → **JMdict + kradfile-u/KanjiVG decomposition + kanji→word index**
- conjugations → **generate from JMdict POS tags** (Tangorin does; a precomputed table also exists)
- example sentences → **Tatoeba**

For fastest results, evaluate **jmdict-simplified** (JSON everything except strokes/sentences) or the **jkindrix/japanese-language-data** unified dataset (which already cross-links all of it), then add KanjiVG SVGs and kuromoji for offline tokenization.

---

## 8. Data backbone decision (2026-08-28): jmdict-simplified

Head-to-head, based on live repo state at the research date:

| Dimension | **jmdict-simplified** (scriptin) | **japanese-language-data** (jkindrix) |
|---|---|---|
| What it is | Faithful JSON conversion of the 4 EDRDG files (JMdict, JMnedict, Kanjidic2, KRADFILE/RADKFILE) | Unified, cross-linked aggregation of ~10 sources (JMdict, KANJIDIC2, KanjiVG, Tatoeba, Kanjium, Waller JLPT, Kangxi radicals, …) |
| Word coverage | **Full JMdict committed**: 218,577 entries (eng release 11 MB, eng-common 1.37 MB) | Committed set is **common-only**: 23,119 words; full 216k + names (~720k) are gitignored, built on demand via `just build` |
| Names | 743,620 entries, committed as release asset | ~720k, built on demand |
| Kanji | 13,108 entries, committed | 13,108 entries, committed (via jmdict-simplified) |
| Freshness | **Weekly automated releases** (last: 3.6.2+20260824, 4 days before research date) | **Last commit 2026-04-14** (~4.5 months stale at research date); no release cadence |
| Maintenance risk | 9 years old, 389★, fully automated CI — low bus factor | Single maintainer, 6★, activity stalled since April 2026 — high bus factor |
| Enrichments bundled | None — raw per-source JSON, you build the joins | Conjugations (3,511 tables), furigana (28,920), pitch accent (136k), JLPT classifications, jukugo compounds (14,350), kanji→words / reading→words / kanji→radicals / word→sentence cross-refs, sentence difficulty |
| Schema & tooling | Consistent JSON, human-readable field names, TS types + NPM loader (MIT) | Schema-validated, test-covered, reproducible `just` build with pinned SHA256s; no published packages |
| License | CC BY-SA 4.0 (data), MIT (NPM packages) | CC BY-SA 4.0 (everything) |
| Size | eng-common 1.37 MB zip — tiny for quick reference | ~150 MB committed, larger full build |

**Decision: jmdict-simplified is the data backbone.**

Reasons:
1. **Freshness.** It tracks JMdict weekly and automatically; a dictionary's correctness depends on current entries. japanese-language-data is ~4.5 months stale and its cadence is unpredictable.
2. **Completeness, committed.** Full 218k-word JMdict + 743k names ship as release assets. japanese-language-data commits only the common subset and makes you run its build for the rest.
3. **Reliability / bus factor.** 9 years, 389★, fully automated weekly CI vs. one maintainer, 6★, stalled since April 2026.
4. **Ecosystem.** NPM types + loader, used across many downstream projects; trivial to consume in any stack.
5. **Everything japanese-language-data adds is derivable from the backbone**: cross-ref indices are a simple join over JMdict entries, conjugations come from JMdict POS tags, furigana comes from the separate JmdictFurigana upstream, and KanjiVG/Tatoeba are needed by both approaches anyway.

**What the backbone does not give you, and where each piece comes from:**
- Stroke order → **KanjiVG** (needed regardless of choice)
- Example sentences → **Tatoeba** (needed regardless of choice)
- Conjugations → generate from JMdict POS tags (own engine, or bootstrap from japanese-language-data's `conjugations.json`, or an off-the-shelf conjugator like Kuroshiro/kamiya-codec)
- kanji→words / reading→words cross-refs → build a small index at import time (~tens of lines over JMdict entries)
- Furigana alignment → **JmdictFurigana** upstream, or tokenize with kuromoji/MeCab

**Recommended build (hybrid, best of both):** backbone = jmdict-simplified refreshed weekly; bootstrap enrichment *schemas* and initial values once from japanese-language-data (conjugations.json, furigana.json, cross-ref design); then regenerate enrichments from the fresh backbone in our own import pipeline so nothing depends on a stalled repo's data going forward.

---

## 9. Offline bundle size estimate (verified 2026-08-28)

All numbers below were measured from live sources on the research date (release assets, npm registry, and the committed files in jkindrix/japanese-language-data), not guessed.

### Standard build: eng-common JMdict + Jōyō KanjiVG + curated Tatoeba + kuromoji

| Component | Download (compressed) | On disk (uncompressed) | Source of number |
|---|---|---|---|
| **eng-common JMdict** (jmdict-simplified 3.6.2+20260824) | 1.44 MB (tgz asset) | **16.5 MB** JSON (16,482,605 B measured by streaming the release tgz) | jmdict-simplified release asset |
| **Jōyō KanjiVG SVGs** (2,136 kanji) | ~3–4 MB (zipped) | **~9.4 MB** (6,416 SVGs = 28.09 MB in japanese-language-data → avg 4.4 KB/file; Jōyō = 2,136 files) | measured via GitHub tree API |
| **Curated Tatoeba JA–EN** (25,980 pairs) | ~2–3 MB | **9.9 MB** (sentences.json exact) | measured via GitHub tree API |
| **kuromoji.js + ipadic** | ~12–15 MB (npm tarball) | **41.3 MB** (npm unpackedSize exact) | npm registry |
| **Total** | **~20–25 MB** | **~77 MB** | |

With JSON converted to a compact store (SQLite or binary) the on-disk figure typically drops to **~60–70 MB** (SQLite + indexes usually comes in under the raw JSON), and the SVGs can be gzip-embedded at ~4 MB.

### Variants

| Variant | On disk | Notes |
|---|---|---|
| **Lean** (common words + Jōyō SVGs + 5k curated sentences + trimmed kuromoji dict built from eng-common headwords) | **~35–45 MB** | kuromoji is the single biggest chunk; a custom trimmed dictionary cuts it from 41 MB to ~5–10 MB at the cost of tokenization recall |
| **Standard** (this estimate) | **~65–77 MB** | good balance for a quick-reference app |
| **Full** (+ full 218k JMdict, JMnedict names, pitch accent, full corpora) | **200 MB+** | full JMdict alone adds ~120 MB uncompressed (23.9 MB compressed asset); JMnedict ~50 MB; pitch-accent.json 17.8 MB; full Tatoeba JP–EN ~50 MB+ |

### Notes
- **eng-common** covers the ~30k words marked common in JMdict — plenty for quick reference lookups; the long tail (archaic/rare/specialized) lives in the full JMdict, which you can add later without restructuring.
- The **Jōyō SVG** figure is the lean choice; the official KanjiVG **main zip** (all ~13k kanji, no variants) is 12.65 MB compressed if you want full coverage instead.
- kuromoji's 41.3 MB is the stock ipadic bundle; browser apps can lazy-load it or ship a trimmed build.
- Everything above is permissive to redistribute offline under CC BY-SA 4.0 (data) / Apache-2.0 (kuromoji).

---

## 10. Data model & storage

The source-to-schema mapping and the storage decision (SQLite + FTS5, with KanjiVG SVGs as loose files) live in **[`data-model.md`](data-model.md)** — full DDL, index strategy, and build/update notes.
