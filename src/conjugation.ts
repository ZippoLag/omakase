/**
 * Conjugation engine — spec: conjugation-engine.md.
 *
 * Generates kana conjugation tables from a reading + JMdict POS class, plus
 * kanji-rendered display forms. The display algorithm reproduces
 * jkindrix/japanese-language-data `_compute_display_forms` exactly, with one
 * extension: suru nouns (vs) with no kanji/kana common suffix render the
 * writing prefix (食事する), per conjugation-engine.md §6.
 */

export type ConjClass =
  | "v1" | "v5u" | "v5k" | "v5g" | "v5s" | "v5t" | "v5n" | "v5b" | "v5m" | "v5r"
  | "v5k-s" | "v5u-s" | "v5uru" | "v5aru" | "v5r-i"
  | "vk" | "vs" | "vs-i" | "vs-c" | "vs-s" | "vs-a" | "vz"
  | "adj-i" | "adj-ix" | "adj-na";

export interface ConjTable {
  /** form key -> kana value */
  forms: Record<string, string>;
  /** form key -> kanji-rendered display value */
  displayForms: Record<string, string>;
}

/** JMdict POS tags that produce a conjugation table (tag -> class). */
export const CONJUGATABLE: Record<string, ConjClass> = {
  v1: "v1",
  v5u: "v5u", v5k: "v5k", v5g: "v5g", v5s: "v5s", v5t: "v5t",
  v5n: "v5n", v5b: "v5b", v5m: "v5m", v5r: "v5r",
  "v5k-s": "v5k-s", "v5u-s": "v5u-s", v5uru: "v5uru",
  v5aru: "v5aru", "v5r-i": "v5r-i",
  vk: "vk",
  vs: "vs", "vs-i": "vs-i", "vs-c": "vs-c", "vs-s": "vs-s", "vs-a": "vs-a",
  vz: "vz",
  "adj-i": "adj-i", "adj-ix": "adj-ix", "adj-na": "adj-na",
};

/** Canonical form order per class family (matches upstream insertion order). */
export const FORM_ORDER: Record<ConjClass, string[]> = {
  // verb set (16)
  v1: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5u: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5k: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5g: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5s: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5t: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5n: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5b: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5m: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5r: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  "v5k-s": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  "v5u-s": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5uru: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  v5aru: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  "v5r-i": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  vk: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  vs: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  "vs-i": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  "vs-c": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  "vs-s": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  "vs-a": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  vz: ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "ta_form", "nai_form", "nakatta_form", "potential", "passive", "causative",
    "imperative", "volitional", "conditional_ba", "conditional_tara"],
  // i-adjective set (8)
  "adj-i": ["dictionary", "negative", "past", "past_negative", "adverbial", "te_form",
    "conditional_ba", "conditional_tara"],
  "adj-ix": ["dictionary", "negative", "past", "past_negative", "adverbial", "te_form",
    "conditional_ba", "conditional_tara"],
  // na-adjective set (10)
  "adj-na": ["dictionary", "polite_nonpast", "polite_past", "polite_negative", "polite_past_negative",
    "te_form", "nai_form", "ta_form", "nakatta_form", "attributive"],
};

// ---- godan helpers (mirror upstream GODAN_VOWEL_MAP / TE_FORM_TRANSFORMS) ----

const GODAN_VOWEL: Record<string, [string, string, string, string]> = {
  う: ["わ", "い", "え", "お"],
  く: ["か", "き", "け", "こ"],
  ぐ: ["が", "ぎ", "げ", "ご"],
  す: ["さ", "し", "せ", "そ"],
  つ: ["た", "ち", "て", "と"],
  ぬ: ["な", "に", "ね", "の"],
  ぶ: ["ば", "び", "べ", "ぼ"],
  む: ["ま", "み", "め", "も"],
  る: ["ら", "り", "れ", "ろ"],
};

const TE_TA: Record<string, [string, string]> = {
  う: ["って", "った"], つ: ["って", "った"], る: ["って", "った"],
  ぬ: ["んで", "んだ"], ぶ: ["んで", "んだ"], む: ["んで", "んだ"],
  く: ["いて", "いた"], ぐ: ["いで", "いだ"], す: ["して", "した"],
};

const GODAN_ENDING: Record<string, string> = {
  v5u: "う", v5k: "く", v5g: "ぐ", v5s: "す", v5t: "つ", v5n: "ぬ",
  v5b: "ぶ", v5m: "む", v5r: "る", "v5k-s": "く", "v5u-s": "う",
  v5uru: "う", v5aru: "る", "v5r-i": "る",
};

// ---- class conjugators (kana values; insertion order = canonical form order) ----

function ichidan(reading: string): Record<string, string> | null {
  if (!reading.endsWith("る")) return null;
  const root = reading.slice(0, -1);
  return {
    dictionary: reading,
    polite_nonpast: root + "ます", polite_past: root + "ました",
    polite_negative: root + "ません", polite_past_negative: root + "ませんでした",
    te_form: root + "て", ta_form: root + "た",
    nai_form: root + "ない", nakatta_form: root + "なかった",
    potential: root + "られる", passive: root + "られる", causative: root + "させる",
    imperative: root + "ろ", volitional: root + "よう",
    conditional_ba: root + "れば", conditional_tara: root + "たら",
  };
}

function godan(reading: string, pos: string): Record<string, string> | null {
  const ending = GODAN_ENDING[pos];
  if (!ending || !reading.endsWith(ending)) return null;
  const root = reading.slice(0, -1);
  const [a, i, e, o] = GODAN_VOWEL[ending]!;
  let [te, ta] = TE_TA[ending]!;
  if (pos === "v5k-s") { te = "って"; ta = "った"; }        // 行く
  if (pos === "v5u-s" || pos === "v5uru") { te = "うて"; ta = "うた"; } // 問う/覆う

  const forms: Record<string, string> = {
    dictionary: reading,
    polite_nonpast: root + i + "ます", polite_past: root + i + "ました",
    polite_negative: root + i + "ません", polite_past_negative: root + i + "ませんでした",
    te_form: root + te, ta_form: root + ta,
    nai_form: root + a + "ない", nakatta_form: root + a + "なかった",
    potential: root + e + "る", passive: root + a + "れる", causative: root + a + "せる",
    imperative: root + e, volitional: root + o + "う",
    conditional_ba: root + e + "ば", conditional_tara: root + ta + "ら",
  };

  if (pos === "v5aru") {
    // honorific -aru: い-stem polite, imperative い
    forms.polite_nonpast = root + "います";
    forms.polite_past = root + "いました";
    forms.polite_negative = root + "いません";
    forms.polite_past_negative = root + "いませんでした";
    forms.imperative = root + "い";
  } else if (pos === "v5r-i") {
    // ある family: suppletive negative; no potential/passive/causative
    if (reading.endsWith("ある")) {
      const prefix = reading.slice(0, -2);
      forms.nai_form = prefix + "ない";
      forms.nakatta_form = prefix + "なかった";
      if (prefix) { // compounds (ことがある, である) lack imperative/volitional/conditional
        forms.imperative = "";
        forms.volitional = "";
        forms.conditional_ba = "";
      }
    }
    forms.potential = "";
    forms.passive = "";
    forms.causative = "";
  }
  return forms;
}

function suru(reading: string, pos: string): Record<string, string> | null {
  // vs-i / vs / vz all conjugate the する portion; for vs (suru noun) the
  // reading is the noun itself and する is appended.
  let root: string;
  if (pos === "vz") {
    if (!reading.endsWith("ずる")) return null;
    root = reading.slice(0, -2) + "じ"; // ずる → じ for all non-dictionary forms
    return {
      dictionary: reading,
      polite_nonpast: root + "ます", polite_past: root + "ました",
      polite_negative: root + "ません", polite_past_negative: root + "ませんでした",
      te_form: root + "て", ta_form: root + "た",
      nai_form: root + "ない", nakatta_form: root + "なかった",
      potential: root + "られる", passive: root + "られる", causative: root + "させる",
      imperative: root + "ろ", volitional: root + "よう",
      conditional_ba: root + "れば", conditional_tara: root + "たら",
    };
  }
  let dictionary: string;
  if (reading.endsWith("する")) {
    root = reading.slice(0, -2);
    dictionary = reading;
  } else if ((pos === "vs-c" || pos === "vs-a") && reading.endsWith("す")) {
    // ～す verbs (vs-c "su verb — precursor to suru", archaic vs-a): the
    // reading's final す plays the role of する's す, so the stem is the
    // reading minus す and the dictionary form is the reading itself
    // (死す [しす] → 死します, 死して, 死しない — conjugation-engine.md §4.7).
    root = reading.slice(0, -1);
    dictionary = reading;
  } else {
    root = reading; // vs suru noun: 食事 → しょくじ
    dictionary = reading + "する";
  }
  return {
    dictionary,
    polite_nonpast: root + "します", polite_past: root + "しました",
    polite_negative: root + "しません", polite_past_negative: root + "しませんでした",
    te_form: root + "して", ta_form: root + "した",
    nai_form: root + "しない", nakatta_form: root + "しなかった",
    potential: root + "できる", passive: root + "される", causative: root + "させる",
    imperative: root + "しろ", volitional: root + "しよう",
    conditional_ba: root + "すれば", conditional_tara: root + "したら",
  };
}

const KURU: Record<string, string> = {
  dictionary: "くる",
  polite_nonpast: "きます", polite_past: "きました",
  polite_negative: "きません", polite_past_negative: "きませんでした",
  te_form: "きて", ta_form: "きた",
  nai_form: "こない", nakatta_form: "こなかった",
  potential: "こられる", passive: "こられる", causative: "こさせる",
  imperative: "こい", volitional: "こよう",
  conditional_ba: "くれば", conditional_tara: "きたら",
};

function iAdjective(reading: string, irregular: boolean): Record<string, string> | null {
  if (irregular) {
    if (!reading.endsWith("いい")) return null;
    const root = reading.slice(0, -2) + "よ";
    return {
      dictionary: reading,
      negative: root + "くない", past: root + "かった",
      past_negative: root + "くなかった", adverbial: root + "く",
      te_form: root + "くて", conditional_ba: root + "ければ",
      conditional_tara: root + "かったら",
    };
  }
  if (!reading.endsWith("い")) return null;
  const root = reading.slice(0, -1);
  return {
    dictionary: reading,
    negative: root + "くない", past: root + "かった",
    past_negative: root + "くなかった", adverbial: root + "く",
    te_form: root + "くて", conditional_ba: root + "ければ",
    conditional_tara: root + "かったら",
  };
}

function naAdjective(reading: string): Record<string, string> {
  return {
    dictionary: reading + "だ",
    polite_nonpast: reading + "です", polite_past: reading + "でした",
    polite_negative: reading + "ではありません", polite_past_negative: reading + "ではありませんでした",
    te_form: reading + "で", nai_form: reading + "ではない",
    ta_form: reading + "だった", nakatta_form: reading + "ではなかった",
    attributive: reading + "な",
  };
}

// ---- display forms (upstream `_compute_display_forms` + vs suru-noun rule) ----

function longestCommonSuffixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function replacePrefix(forms: Record<string, string>, oldPrefix: string, newPrefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, form] of Object.entries(forms)) {
    out[name] = !form ? form : form.startsWith(oldPrefix) ? newPrefix + form.slice(oldPrefix.length) : form;
  }
  return out;
}

export function computeDisplayForms(
  dictionaryForm: string,
  reading: string,
  forms: Record<string, string>,
  cls: ConjClass,
): Record<string, string> {
  if (dictionaryForm === reading) return { ...forms };
  if (cls === "adj-na") return replacePrefix(forms, reading, dictionaryForm);

  const s = longestCommonSuffixLength(dictionaryForm, reading);
  if (s > 0) {
    const kanjiPrefix = dictionaryForm.slice(0, -s);
    const readingPrefix = reading.slice(0, -s);
    if (kanjiPrefix) return replacePrefix(forms, readingPrefix, kanjiPrefix);
    return { ...forms };
  }
  // zero common suffix: suru nouns render the writing prefix (食事する);
  // everything else stays kana.
  if (cls === "vs" || cls === "vs-i" || cls === "vs-c" || cls === "vs-s" || cls === "vs-a" || cls === "vz") {
    return replacePrefix(forms, reading, dictionaryForm);
  }
  return { ...forms };
}

/**
 * Conjugate a reading for a JMdict POS class.
 * @param reading    primary kana reading (conjugation stem)
 * @param cls        class (a CONJUGATABLE value)
 * @param dictionaryForm  kanji writing to render display forms (falls back to reading)
 */
export function conjugateReading(
  reading: string,
  cls: ConjClass,
  dictionaryForm = reading,
): ConjTable | null {
  let forms: Record<string, string> | null;
  switch (cls) {
    case "v1": forms = ichidan(reading); break;
    case "vk": forms = reading === "くる" ? { ...KURU } : null; break;
    case "vs": case "vs-i": case "vs-c": case "vs-s": case "vs-a": case "vz":
      forms = suru(reading, cls); break;
    case "adj-i": forms = iAdjective(reading, false); break;
    case "adj-ix": forms = iAdjective(reading, true); break;
    case "adj-na": forms = naAdjective(reading); break;
    default: forms = godan(reading, cls); break;
  }
  if (!forms) return null;
  return { forms, displayForms: computeDisplayForms(dictionaryForm, reading, forms, cls) };
}
