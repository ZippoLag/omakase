# Test fixtures & golden outputs

Pinned, real-data fixtures for the CLI's core lookup commands, plus the golden
expected outputs they must reproduce byte-for-byte.

## Layout

```
tests/fixtures/
  manifest.json                  sha256 of the pinned source downloads
  entries/                       exact JSON snapshots from the source release
    jmdict-<id>-<name>.json      JMdict word entries (11: taberu, kuru, yoi,
                                 tabemono, shokuji, kirei, atsui, nomu, kuu,
                                 suru, ii)
    kanjidic2-<name>.json        KANJIDIC2 characters (10: 食 水 飲 見 行 来 良 暑 綺 喰)
    krad-<kanji>.json            kradfile component slices
    radk-<radical>.json          radkfile radical slices (水 食 口)
  meta/tags.json                 JMdict tag → description map (for POS display)
  sentences/sentence-*.json      real curated Tatoeba JA–EN pairs
  conjugations/<name>.json       real conjugation tables (taberu, kuru, suru,
                                 yoi, ii) + _provenance.json
  golden/*.txt                   expected CLI output (the contract)
  scripts/
    extract-fixtures.py          re-pull entries from the pinned release (sha256-verified)
    render-goldens.py            reference formatter → golden/*.txt
```

## Provenance

| Data | Source | License |
|---|---|---|
| `entries/*` (words, kanji, radicals) | **jmdict-simplified 3.6.2+20260824122934** — exact snapshots; download sha256 pinned in `manifest.json` | CC BY-SA 4.0 (EDRDG) |
| `meta/tags.json` | same release | CC BY-SA 4.0 |
| `conjugations/{taberu,kuru,suru,yoi,ii}.json` | **jkindrix/japanese-language-data** `data/grammar/conjugations.json` (fetched 2026-08-28; provenance in `_provenance.json`) | CC BY-SA 4.0 |
| `conjugations/{aru,shokuji,kanzuru}.json` | **hand-derived [G] gap classes** per `conjugation-engine.md` §4.5/4.7 (v5r-i bare ある, vs suru noun 食事, vz 感ずる) — not present in the upstream dataset; each file carries a `provenance` field. **`pnpm run validate:conjugations` diffs these against the engine** (the engine is the only ground truth for these classes) | CC BY-SA 4.0 (our derivation) |
| `sentences/*` | curated Tatoeba subset of the same dataset (real Tatoeba IDs, `license_flag` per sentence) | CC BY 2.0 FR |
| furigana in goldens | **hand-pinned known-correct values** (e.g. 食[たべ]る) — the pipeline will source these from JmdictFurigana; a deliberate diff is expected when that lands | — |
| radical numbers (e.g. 184→食) | Kangxi radical numbering (public domain) | — |

## Regeneration

```bash
# 1. Re-extract entries from the pinned release (verifies sha256, refuses to
#    proceed if upstream moved to a new release):
python3 tests/fixtures/scripts/extract-fixtures.py

# 2. Regenerate goldens from fixtures (review `git diff tests/fixtures/golden`):
python3 tests/fixtures/scripts/render-goldens.py
```

Both are deliberate, reviewable steps — golden files are **not** auto-updated by
the test suite.

## Golden test design

1. **Unit/golden tests (stable, run in CI):** the test suite builds a small
   SQLite DB from `entries/*` + `conjugations/*` + `sentences/*` using the real
   transform code, runs each CLI command against it, and compares stdout
   byte-for-byte to `golden/*.txt`. These never change unless a fixture or the
   output contract changes on purpose.
2. **Smoke/integration tests (against the full eng-common build):** assert
   non-exact properties instead of goldens — e.g. `search eat` returns > 0
   results and the top result contains `食べる`; `kanji 食` shows 9 strokes.
   These tolerate the weekly JMdict drift.
3. **`--update` flag:** regenerates goldens from the current formatter output
   for review; the diff is the review surface (never merge un-reviewed).

## Output contract notes (v1)

- `search` ordering is **entry id ascending** in these goldens — deliberately
  simple and deterministic. FTS5 bm25 relevance ranking is a later enhancement
  and will update the goldens with a reviewed diff.
- `word` shows all senses; `--limit N` truncates with a trailing
  `… and N more senses` line (see `word-suru-limit3.txt`).
- **[G] gap-class goldens:** `conjugate-aru` (suppletive ない, blank
  potential/passive/causative), `conjugate-shokuji` (suru noun: 食事する…),
  `conjugate-kanzuru` (vz: 感ずる→感じます…), plus deconjugate cases
  `deconjugate-nai` (ない→有る) and `deconjugate-shokujishite` (食事して→食事).
  These pin **our** engine's behavior (no upstream ground truth exists) and are
  the acceptance criteria for the engine's gap-class coverage.
- `kanji` compounds are computed from the word fixtures (kanji writings
  containing the literal, sorted by entry id, first gloss each).
- `deconjugate` matches against the `conjugations` table values (index-backed
  in the app); `deconjugate-nomatch.txt` pins the no-result output.
- POS lines join JMdict tag descriptions (from `meta/tags.json`), sentence-case
  on the first label only.
