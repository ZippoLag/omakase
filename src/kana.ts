/**
 * Kana → romaji (Hepburn-ish) converter.
 * Used at build time to populate writings.romaji for kana readings,
 * enabling romaji input search. A pragmatic approximation: plain ASCII,
 * おう→ou, し→shi, っ → geminate, ー → repeated vowel.
 */

const GOJUON: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "wi", ゑ: "we", を: "wo", ん: "n",
  ゔ: "vu",
};

/** Small kana handled as digraph/second elements. */
const SMALL_YA: Record<string, string> = { ゃ: "ya", ゅ: "yu", ょ: "yo" };
const SMALL_VOWEL: Record<string, string> = { ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o" };

/** i-row bases whose consonant changes before ゃ/ゅ/ょ (shi→sh, chi→ch, ji→j). */
const IRREGULAR_Y: Record<string, string> = { shi: "sh", chi: "ch", ji: "j" };

const HIRA_START = 0x3041;
const HIRA_END = 0x3096;
const KATA_START = 0x30a1;
const KATA_END = 0x30f6;
const LONG_VOWEL = "ー";

export function katakanaToHiragana(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= KATA_START && code <= KATA_END) {
      out += String.fromCodePoint(code - 0x60);
    } else {
      out += ch;
    }
  }
  return out;
}

export function toRomaji(input: string): string {
  const s = katakanaToHiragana(input);
  let out = "";
  let lastVowel = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const next = s[i + 1];

    if (ch === LONG_VOWEL) {
      out += lastVowel;
      continue;
    }
    if (ch === "っ") {
      if (next) {
        const rom = GOJUON[next] ?? SMALL_YA[next] ?? SMALL_VOWEL[next];
        if (rom) out += rom[0]!; // geminate: duplicate the following consonant
      }
      continue;
    }
    if (ch in SMALL_YA) {
      continue; // consumed by the preceding i-row base
    }
    if (ch in SMALL_VOWEL) {
      out += SMALL_VOWEL[ch]!;
      lastVowel = SMALL_VOWEL[ch]!;
      continue;
    }

    const base = GOJUON[ch];
    if (base) {
      if (next && next in SMALL_YA) {
        const isIrregular = ch === "し" || ch === "ち" || ch === "じ" || ch === "ぢ";
        const consonant = base.endsWith("i") ? IRREGULAR_Y[base] ?? base.slice(0, -1) : base;
        const small = SMALL_YA[next]!;
        const vowel = isIrregular ? small[1]! : small;
        out += consonant + vowel;
        i++; // consume the small kana
      } else {
        out += base;
      }
      const v = base.slice(-1);
      if ("aeiou".includes(v)) lastVowel = v;
      continue;
    }

    if (ch === "ゝ" || ch === "ゞ") continue; // iteration marks: ignore
    out += ch; // non-kana passthrough (rare in readings)
  }
  return out;
}
