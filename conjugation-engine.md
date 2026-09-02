# Conjugation engine spec

Generates the `conjugations` table (data-model.md §3) from JMdict entries at build
time. Validated against **jkindrix/japanese-language-data** `conjugations.json`
(3,511 real tables, fetched 2026-08-28, CC BY-SA 4.0).

Notation: **[V]** = behavior verified against that dataset; **[G]** = standard
grammar, *not* covered by their data (gaps noted below) — our engine must still
handle these.

---

## 1. Input & output

**Input:** a JMdict word entry (from `jmdict-simplified` JSON): `kanji[]`, `kana[]`
(readings), and `sense[].partOfSpeech` (normalized per-sense tag lists).

**Output:** one conjugation table **per kana reading** (`reading`), each with a
set of `(form, value)` pairs where `value` is **kana**. A separate display step
renders kanji writings (see §6).

**DB shape (delta on data-model.md):**
```sql
CREATE TABLE conjugations (
  word_id TEXT NOT NULL REFERENCES words(id),
  reading TEXT NOT NULL,   -- the kana reading being conjugated
  form    TEXT NOT NULL,   -- form key from the taxonomy below
  value   TEXT NOT NULL,   -- conjugated form in kana (deconjugate index target)
  display TEXT             -- kanji-rendered form for display (NULL when = value)
);
CREATE INDEX idx_conjugations_value ON conjugations(value);
CREATE INDEX idx_conjugations_display ON conjugations(display) WHERE display IS NOT NULL;
CREATE INDEX idx_conjugations_word  ON conjugations(word_id);
```

---

## 2. POS tag → class mapping

Conjugatable JMdict POS tags and their class. All other tags (nouns `n`, `suf`,
`aux-v`, archaic `v4h/v4r`, `vn`, `v-unspec`, …) are **not** conjugated.

| JMdict tag(s) | Class | Example |
|---|---|---|
| `v1` | **ichidan** | 食べる [V] |
| `v5u` | **godan** (u) | 買う [V] |
| `v5u-s` | **godan-u special** (う音便) | 問う, 乞う [V] |
| `v5uru` | **godan-u archaic** | 覆う, 恋う [G] |
| `v5k` | **godan** (k) | 書く [V] |
| `v5k-s` | **godan-k special** (行く) | 行く [V] |
| `v5g` | **godan** (g) | 泳ぐ [V] |
| `v5s` | **godan** (s) | 話す [V] |
| `v5t` | **godan** (t) | 待つ [V] |
| `v5n` | **godan** (n) | 死ぬ [V] |
| `v5b` | **godan** (b) | 遊ぶ [V] |
| `v5m` | **godan** (m) | 飲む [V] |
| `v5r` | **godan** (r) | 入る [V] |
| `v5r-i` | **ある family** (suppletive ない) | 有る, ことがある [G — upstream implements it, see note] |
| `v5aru` | **godan -aru special** (honorifics) | いらっしゃる [V] |
| `vk` | **kuru** (irregular) | 来る [V] |
| `vs`, `vs-i`, `vs-c`, `vs-s`, `vs-a` | **suru** (irregular) | 為る [V], 食事 (vs noun) [G] |
| `vz` | **suru-z** (ずる) | 感ずる [G] |
| `adj-i` | **i-adjective** | 暑い [V], 良い [V] |
| `adj-ix` | **i-adjective irregular** (いい) | いい [V] |
| `adj-na` | **na-adjective** | 綺麗, 明白 [V] |

**Class selection:** generate **one table per distinct conjugatable POS tag** on
an entry, matching upstream (e.g. an entry tagged `v1, vt` gets one v1 table; one
tagged `n, vi, vs` gets one suru table; only conjugatable tags produce tables).
Non-conjugatable tags (n, suf, aux-v, …) are ignored.

---

## 3. Form taxonomy

Three form sets, matching the union of form keys in japanese-language-data
exactly (verified: no extra/missing keys in their 3,511 tables).

### Verb set (16 forms) — used by ichidan, all godan, kuru, suru [V]
`dictionary, polite_nonpast, polite_past, polite_negative, polite_past_negative,
te_form, ta_form, nai_form, nakatta_form, potential, passive, causative,
imperative, volitional, conditional_ba, conditional_tara`

### i-adjective set (8 forms) — adj-i and adj-ix [V]
`dictionary, negative, past, past_negative, adverbial, te_form, conditional_ba,
conditional_tara`

### na-adjective set (10 forms) — adj-na [V]
`dictionary, polite_nonpast, polite_past, polite_negative, polite_past_negative,
te_form, nai_form, ta_form, nakatta_form, attributive`

---

## 4. Derivation rules

`stem` = reading minus the final character (kana), except where noted.

### 4.1 Ichidan (`v1`) — stem + suffix
| Form | Suffix | 食べる → |
|---|---|---|
| dictionary | — | たべる |
| polite_nonpast / past / negative / past_negative | ます / ました / ません / ませんでした | たべます … [V] |
| te_form / ta_form | て / た | たべて / たべた [V] |
| nai_form / nakatta_form | ない / なかった | たべない / たべなかった [V] |
| potential / passive | られる (identical — dedup in display) | たべられる [V] |
| causative | させる | たべさせる [V] |
| imperative | ろ | たべろ [V] |
| volitional | よう | たべよう [V] |
| conditional_ba / conditional_tara | れば / たら | たべれば / たべたら [V] |

### 4.2 Godan (`v5*`) — a-column stem + suffix
All godan classes share the non-音便 forms; only te/ta differ (§4.3).
Stem = reading minus final う/く/ぐ/す/つ/ぬ/ぶ/む/る. `A` = stem ending in the
a-column (う→わ, く→か, ぐ→が, す→さ, つ→た, ぬ→な, ぶ→ば, む→ま, る→ら).

| Form | Rule | 飲む (v5m) → | 話す (v5s) → |
|---|---|---|---|
| polite_nonpast | stem + います | のみます [V] | はなします [V] |
| polite_past | stem + いました | のみました [V] | — |
| polite_negative | stem + いません | のみません [V] | — |
| polite_past_negative | stem + いませんでした | — | — |
| nai_form | A-stem + ない | のまない [V] | はなさない [V] |
| nakatta_form | A-stem + なかった | のまなかった [V] | — |
| potential | e-stem + る | のめる [V] | はなせる [V] |
| passive | A-stem + れる | のまれる [V] | — |
| causative | A-stem + せる | のませる [V] | — |
| imperative | e-stem | のめ [V] | はなせ [V] |
| volitional | o-stem + う | のもう [V] | — |
| conditional_ba | e-stem + ば | のめば [V] | — |
| conditional_tara | ta-stem + ら | のんだら [V] | — |
| te_form / ta_form | see §4.3 | のんで / のんだ [V] | はなして / はなした [V] |

### 4.3 音便 (sound-change) table for te/ta
| Ending | Class | te/ta | Example |
|---|---|---|---|
| う (regular) | v5u | 促音便 って/った | 買う→かって [V] |
| う (special) | **v5u-s** | う音便 うて/うた | 問う→とうて, 乞う→こうた [V] |
| う (archaic) | v5uru | う音便 うて/うた | 覆う→おおうて [G] |
| く | v5k | い音便 いて/いた | 書く→かいて [V] |
| く | **v5k-s** | 促音便 って/った | 行く→いって [V] |
| ぐ | v5g | い音便 いで/いだ | 泳ぐ→およいで [V] |
| す | v5s | して/した (no change) | 話す→はなして [V] |
| つ | v5t | 促音便 って/った | 待つ→まって [V] |
| ぬ | v5n | 撥音便 んで/んだ | 死ぬ→しんで [V] |
| ぶ | v5b | 撥音便 んで/んだ | 遊ぶ→あそんで [V] |
| む | v5m | 撥音便 んで/んだ | 飲む→のんで [V] |
| る | v5r | 促音便 って/った | 入る→はいって [V] |

### 4.4 Godan -aru honorifics (`v5aru`) — い-stem
いらっしゃる: polite stem = いらっしゃ**い** (drop る, add い).
- polite forms: いらっしゃいます / いました / いません / いませんでした [V]
- imperative: **いらっしゃい** (not いらっしゃれ) [V] (なさる→なさい, くださる→ください)
- all other forms regular godan (nai いらっしゃらない [V], te いらっしゃって [V], …)

### 4.5 ある family (`v5r-i`) — suppletive negative [G]
JMdict tags ある as **`v5r-i`** (not v5aru — v5aru is the honorific -aru class).
Upstream implements v5r-i as the ある family (bare 有る/在る plus compounds like
ことがある, である):
- **nai_form / nakatta_form**: replace the trailing ある with ない / なかった —
  bare ある → ない / なかった (never あらない), ことがある → ことがない.
- **potential / passive / causative**: **blank** (no modern register uses them).
- Bare ある keeps imperative あれ, volitional あろう, conditional あれば;
  **compounds** blank imperative / volitional / conditional_ba.
- All other forms regular godan (あって, あった, あります, あれば…).
Not present in the validation dataset — golden-pinned via `conjugate-aru` / `deconjugate-nai`.

### 4.6 Kuru (`vk`) — 来る [V]
| Form | Value | | Form | Value |
|---|---|---|---|---|
| dictionary | くる | | potential / passive | こられる |
| polite_nonpast | きます | | causative | こさせる |
| polite_past | きました | | imperative | こい |
| polite_negative | きません | | volitional | こよう |
| polite_past_negative | きませんでした | | conditional_ba | くれば |
| te_form | きて | | conditional_tara | きたら |
| ta_form | きた | | | |
| nai_form | こない | | | |
| nakatta_form | こなかった | | | |

### 4.7 Suru (`vs`, `vs-i`, `vs-c`, `vs-s`, `vs-a`) — する [V]
| Form | Value | | Form | Value |
|---|---|---|---|---|
| dictionary | する | | potential | **できる** (irregular — not される) |
| polite_nonpast | します | | passive | される |
| polite_past | しました | | causative | させる |
| polite_negative | しません | | imperative | しろ (also せよ — emit しろ) |
| polite_past_negative | しませんでした | | volitional | しよう |
| te_form | して | | conditional_ba | すれば |
| ta_form | した | | conditional_tara | したら |
| nai_form | しない | | | |
| nakatta_form | しなかった | | | |

**vs (suru nouns)** [G]: the reading is the noun only (食事 → しょくじ); the
conjugated table = noun reading + every する form above (しょくじ**する**,
しょくじ**します**, しょくじ**して**, しょくじ**できる**…). No 食事 tables in the
validation dataset — golden-pin with our fixture (word-shokuji).
**vz (ずる)** [G]: ずる behaves as じる after ず→じ (感ずる → 感じます, 感じた,
感じない, 感じれば…); dictionary 感ずる, potential 感じられる. Not in dataset.
**vs-c / vs-a (～す verbs)** [G]: vs-c is the "su verb — precursor to the
modern suru"; the reading ends in す (死す → しす) and that final す plays the
role of する's す — stem = reading minus す, dictionary = the reading itself
(死します, 死して, 死しない, 死できる — not 死す*する). The vs-a class covers the same
す-ending shape plus the suru-noun form (検討 → 検討する). Neither class has
tables in the validation dataset — golden-pin with our fixtures
(conjugate-shisu, conjugate-aisuru, conjugate-ou, conjugate-kentou).

### 4.8 i-adjective (`adj-i`) — stem + suffix [V]
Stem = reading minus final い.
| Form | Suffix | 暑い → | 良い → |
|---|---|---|---|
| dictionary | — | あつい | よい |
| negative | くない | あつくない | よくない |
| past | かった | あつかった | よかった |
| past_negative | くなかった | あつくなかった | よくなかった |
| adverbial | く | あつく | よく |
| te_form | くて | あつくて | よくて |
| conditional_ba | ければ | あつければ | よければ |
| conditional_tara | かったら | あつかったら | よかったら |

### 4.9 i-adjective irregular (`adj-ix`) — いい [V]
いい conjugates as if it were よい: negative よくない, past よかった, past_negative
よくなかった, adverbial よく, te_form よくて, conditional_ba よければ,
conditional_tara よかったら. Same values as the 良い/よい table.

### 4.10 na-adjective (`adj-na`) — append to whole reading [V]
| Form | Suffix | 綺麗 → |
|---|---|---|
| dictionary | だ | きれいだ |
| polite_nonpast | です | きれいです |
| polite_past | でした | きれいでした |
| polite_negative | ではありません | きれいではありません |
| polite_past_negative | ではありませんでした | きれいではありませんでした |
| te_form | で | きれいで |
| nai_form | ではない | きれいではない |
| ta_form | だった | きれいだった |
| nakatta_form | ではなかった | きれいではなかった |
| attributive | な | きれいな |

---

## 5. Special cases checklist

1. **Primary reading only**: the engine conjugates `kana[0]` (matching upstream);
   per-reading tables are a deferred enhancement. 入る's いる/はいる are separate
   JMdict entries, each with its own table [V]. 良い's secondary えい reading is
   not conjugated.
2. **Multiple kanji writings** → display renders each writing (§6); values are
   identical per reading.
3. **Multiple classes on one entry** → single class by §2 priority.
4. **行く (v5k-s)**: いって/いった, not いいて/いいた [V].
5. **問う/乞う (v5u-s)**: とうて/とうた; nai とわない [V].
6. **ある (v5aru)**: ない/なかった [G].
7. **する potential = できる** (never される); passive される, causative させる,
   imperative しろ [V].
8. **来る**: こない (nai), きます (polite), こい (imperative), こられる
   (potential/passive) [V].
9. **いい (adj-ix)** behaves as よい [V].
10. **Honorific -aru** imperatives: いらっしゃい/なさい/ください/おっしゃい [V].
11. **v5r-i** = regular v5r 促音便 [V].
12. **ら抜き/さ入れ colloquial forms** (食べれる, 来れる, 見さない): out of scope —
    standard forms only.
13. **同形 potential/passive** for ichidan and 来る: one row, display notes both.

---

## 6. Display forms (kanji rendering)

Engine values are kana; display_forms renders the kanji writing where possible.
Algorithm (verified against upstream `_compute_display_forms`, reproduces all 5
pinned tables byte-for-byte [V]):

1. If no kanji writing (dictionary_form == reading): display = kana value.
2. **adj-na**: every form is `reading + copula`, so replace the full reading
   prefix with the writing: 明白+です → 明白です [V].
3. Everything else — **longest common suffix** between writing `W` and reading
   `R`: let `s` = common trailing kana, `kanji_prefix` = `W` minus `s`,
   `reading_prefix` = `R` minus `s`. In every form that **starts with**
   `reading_prefix`, replace that prefix with `kanji_prefix`; forms that don't
   stay kana. Examples:
   - 食べる/たべる (s=べる): たべます→食べます, たべれば→食べれば [V]
   - 良い/よい (s=い): よかった→良かった, よくない→良くない [V]
   - 来る/くる (s=る): くれば→来れば ✓ but きます (starts き≠く) stays kana [V]
   - 為る/する (s=る): すれば→為れば ✓ but します/して/した stay kana [V]
   - 有る/ある (s=る): あって→有って ✓ but ない (starts な≠あ) stays kana [G]
   - 感ずる/かんずる (s=ずる): かんじます→感じます [G]
4. **suru nouns (vs) with zero common suffix** (食事/しょくじ): display = `W` +
   `form.slice(reading.length)` for forms starting with the reading: しょくじする
   → 食事する, しょくじできます→食事できます [G].

---

## 7. Validation plan

1. **Fixture goldens (byte-exact):** engine output for the 5 pinned tables must
   equal `tests/fixtures/conjugations/*.json` exactly, on both `forms` (kana) and
   `display_forms` — 食べる (v1), 来る (vk), 為る (vs-i), 良い (adj-i), いい (adj-ix).
   These are already the `conjugate-*.txt` goldens.
2. **Full-corpus diff (3,511 tables):** `pnpm run validate:conjugations` runs the
   engine over every entry in the pinned upstream `conjugations.json` (sha256
   verified, cached in `data/raw/`), diffs `forms` and `display_forms`, and
   writes `dist/conjugation-validation.json`. **Result (2026-08-28): 3,511/3,511
   pass (100.00%), 0 mismatches, 0 skipped** across all 19 classes — the engine
   reproduces the upstream dataset byte-for-byte, including the ある-family
   blanks and v5k-s/v5u-s/v5aru/v5r-i overrides. Re-run the command after any
   engine change; a new mismatch triages into: (a) engine bug → fix,
   (b) upstream quirk → documented divergence, (c) unsupported form → extend
   taxonomy.
3. **Gap coverage (marked [G]):** `pnpm run validate:conjugations` also diffs the
   [G] gap fixtures in `tests/fixtures/conjugations/` through the same engine
   path — bare ある (v5r-i, 1296400), suru noun 食事 (vs, 1358490), vz 感ずる
   (1609650), plus one fixture per class with no upstream rows: vs-c 死す
   (2410560), vs-s 愛する (1150450), v5uru 覆う (9000101, synthetic), vs-a
   検討 (9000102, synthetic). **Result (2026-09-02): 12/12 fixtures pass,
   0 mismatches.** Combined with the 3,511 upstream tables: **3,523/3,523
   pass (100.00%)**.
4. **Deconjugate check:** every generated `value` must deconjugate back to its
   entry via `idx_conjugations_value` (round-trip test).

## 8. Out of scope (v1 engine)

Archaic classes (`v4h`, `v4r`, `v2*`), `vn` (irregular nu), `v-unspec`,
non-conjugatable POS, keigo/politeness variants beyond です/ます, and
colloquial/ら抜き forms.
