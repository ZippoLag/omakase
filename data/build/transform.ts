/**
 * Transform parsed jmdict-simplified JSON into the relational rows defined
 * in data-model.md §3. Deterministic: identical input ⇒ identical rows.
 */
import { toRomaji } from "../../src/kana.js";
import { furiganaFor } from "../../src/furigana.js";
import { CONJUGATABLE, conjugateReading, type ConjClass } from "../../src/conjugation.js";
import type {
  JmdictFile,
  Kanjidic2File,
  KradfileFile,
  RadkfileFile,
  JmdictWord,
} from "./parse.js";

export interface WordRow {
  id: string;
  common: number;
}
export interface WritingRow {
  id: number;
  word_id: string;
  kind: "kanji" | "kana";
  text: string;
  common: number;
  romaji: string | null;
  tags: string | null;
  applies_to_kanji: string | null;
}
export interface SenseRow {
  id: number;
  word_id: string;
  position: number;
  part_of_speech: string;
  applies_to_kanji: string;
  applies_to_kana: string;
  field: string | null;
  dialect: string | null;
  misc: string | null;
  info: string | null;
  language_source: string | null;
  related: string | null;
  antonym: string | null;
}
export interface GlossRow {
  id: number;
  sense_id: number;
  lang: string;
  type: string | null;
  gender: string | null;
  text: string;
}
export interface KanjiRow {
  literal: string;
  stroke_count: number | null;
  grade: number | null;
  frequency: number | null;
  jlpt_level: number | null;
  classical_radical: number | null;
  radical_names: string | null;
  variants: string | null;
  codepoints: string | null;
}
export interface KanjiReadingRow {
  kanji: string;
  type: "on" | "kun";
  value: string;
  on_type: string | null;
}
export interface KanjiMeaningRow {
  kanji: string;
  lang: string;
  value: string;
}
export interface KanjiNanoriRow {
  kanji: string;
  value: string;
}
export interface RadicalRow {
  radical: string;
  stroke_count: number | null;
  code: string | null;
}
export interface KanjiRadicalRow {
  kanji: string;
  radical: string;
}
export interface KanjiWordRow {
  kanji: string;
  word_id: string;
  writing_id: number;
  position: number;
}
export interface ConjugationRow {
  word_id: string;
  reading: string;
  class: string;
  form: string;
  value: string;
  display: string | null;
}
export interface FuriganaRow {
  word_id: string;
  writing: string;
  reading: string;
  segments: string;
}

export interface Transformed {
  words: WordRow[];
  writings: WritingRow[];
  senses: SenseRow[];
  glosses: GlossRow[];
  kanji: KanjiRow[];
  kanjiReadings: KanjiReadingRow[];
  kanjiMeanings: KanjiMeaningRow[];
  kanjiNanori: KanjiNanoriRow[];
  radicals: RadicalRow[];
  kanjiRadicals: KanjiRadicalRow[];
  kanjiWords: KanjiWordRow[];
  conjugations: ConjugationRow[];
  furigana: FuriganaRow[];
}

const json = (v: unknown): string => JSON.stringify(v);

function isKanji(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return code >= 0x4e00 && code <= 0x9fff;
}

export function transform(
  jmdict: JmdictFile,
  kanjidic2: Kanjidic2File,
  kradfile: KradfileFile,
  radkfile: RadkfileFile,
): Transformed {
  const words: WordRow[] = [];
  const writings: WritingRow[] = [];
  const senses: SenseRow[] = [];
  const glosses: GlossRow[] = [];
  const kanjiWords: KanjiWordRow[] = [];
  const conjugations: ConjugationRow[] = [];
  const furigana: FuriganaRow[] = [];

  let writingId = 1;
  let senseId = 1;
  let glossId = 1;

  for (const word of jmdict.words) {
    words.push({ id: word.id, common: isCommon(word) ? 1 : 0 });

    const kanjiWritings = word.kanji.map((k) => ({
      id: writingId++,
      word_id: word.id,
      kind: "kanji" as const,
      text: k.text,
      common: k.common ? 1 : 0,
      romaji: null,
      tags: json(k.tags),
      applies_to_kanji: null,
    }));
    const kanaWritings = word.kana.map((k) => ({
      id: writingId++,
      word_id: word.id,
      kind: "kana" as const,
      text: k.text,
      common: k.common ? 1 : 0,
      romaji: toRomaji(k.text),
      tags: json(k.tags),
      applies_to_kanji: json(k.appliesToKanji),
    }));
    writings.push(...kanjiWritings, ...kanaWritings);

    for (const [pos, sense] of word.sense.entries()) {
      const senseRow: SenseRow = {
        id: senseId++,
        word_id: word.id,
        position: pos + 1,
        part_of_speech: json(sense.partOfSpeech),
        applies_to_kanji: json(sense.appliesToKanji),
        applies_to_kana: json(sense.appliesToKana),
        field: json(sense.field),
        dialect: json(sense.dialect),
        misc: json(sense.misc),
        info: json(sense.info),
        language_source: json(sense.languageSource),
        related: json(sense.related),
        antonym: json(sense.antonym),
      };
      senses.push(senseRow);

      for (const gloss of sense.gloss) {
        glosses.push({
          id: glossId++,
          sense_id: senseRow.id,
          lang: gloss.lang,
          type: gloss.type,
          gender: gloss.gender,
          text: gloss.text,
        });
      }
    }

    // kanji -> word cross-refs ("composed use into more complex terms")
    for (const writing of kanjiWritings) {
      const seen = new Set<string>();
      [...writing.text].forEach((ch, pos) => {
        if (isKanji(ch) && !seen.has(ch)) {
          seen.add(ch);
          kanjiWords.push({ kanji: ch, word_id: word.id, writing_id: writing.id, position: pos });
        }
      });
    }

    // conjugation tables: one per distinct conjugatable POS class
    const classes = new Set<ConjClass>();
    for (const sense of word.sense) {
      for (const tag of sense.partOfSpeech) {
        const cls = CONJUGATABLE[tag];
        if (cls) classes.add(cls);
      }
    }
    if (classes.size > 0 && word.kana.length > 0) {
      const reading = word.kana[0]!.text;
      const dictionaryForm = word.kanji[0]?.text ?? reading;
      for (const cls of classes) {
        const table = conjugateReading(reading, cls, dictionaryForm);
        if (!table) continue;
        for (const [form, value] of Object.entries(table.forms)) {
          const display = table.displayForms[form] ?? value;
          conjugations.push({
            word_id: word.id,
            reading,
            class: cls,
            form,
            value,
            display: display === value ? null : display,
          });
        }
      }
    }

    // furigana: pin ruby only for known writings (M1 pinned map; M2 = JmdictFurigana)
    const headReading = word.kana[0]?.text ?? "";
    for (const k of kanjiWritings) {
      const ruby = furiganaFor(k.text);
      if (ruby !== k.text) {
        furigana.push({
          word_id: word.id,
          writing: k.text,
          reading: headReading,
          segments: ruby,
        });
      }
    }
  }

  // ---- KANJIDIC2 ----
  const kanji: KanjiRow[] = [];
  const kanjiReadings: KanjiReadingRow[] = [];
  const kanjiMeanings: KanjiMeaningRow[] = [];
  const kanjiNanori: KanjiNanoriRow[] = [];
  const kanjiSet = new Set<string>();

  for (const c of kanjidic2.characters) {
    kanjiSet.add(c.literal);
    const classical = c.radicals.find((r) => r.type === "classical");
    kanji.push({
      literal: c.literal,
      stroke_count: c.misc.strokeCounts[0] ?? null,
      grade: c.misc.grade,
      frequency: c.misc.frequency,
      jlpt_level: c.misc.jlptLevel,
      classical_radical: classical?.value ?? null,
      radical_names: json(c.misc.radicalNames),
      variants: json(c.misc.variants),
      codepoints: json(c.codepoints),
    });

    for (const group of c.readingMeaning?.groups ?? []) {
      for (const reading of group.readings) {
        if (reading.type === "ja_on") {
          kanjiReadings.push({ kanji: c.literal, type: "on", value: reading.value, on_type: reading.onType });
        } else if (reading.type === "ja_kun") {
          kanjiReadings.push({ kanji: c.literal, type: "kun", value: reading.value, on_type: reading.onType });
        }
      }
      for (const meaning of group.meanings) {
        kanjiMeanings.push({ kanji: c.literal, lang: meaning.lang, value: meaning.value });
      }
    }
    for (const n of c.readingMeaning?.nanori ?? []) {
      kanjiNanori.push({ kanji: c.literal, value: n });
    }
  }

  // drop kanji→word rows for characters missing from KANJIDIC2 (no kanji page exists)
  const filteredKanjiWords = kanjiWords.filter((r) => kanjiSet.has(r.kanji));

  // ---- radicals ----
  const radicals: RadicalRow[] = [];
  const knownRadicals = new Set<string>();
  for (const [char, info] of Object.entries(radkfile.radicals)) {
    knownRadicals.add(char);
    radicals.push({ radical: char, stroke_count: info.strokeCount, code: info.code });
  }

  const kanjiRadicals: KanjiRadicalRow[] = [];
  for (const [char, components] of Object.entries(kradfile.kanji)) {
    for (const component of components) {
      if (!knownRadicals.has(component)) {
        // kradfile may reference radicals absent from radkfile; keep FK valid
        knownRadicals.add(component);
        radicals.push({ radical: component, stroke_count: null, code: null });
      }
      kanjiRadicals.push({ kanji: char, radical: component });
    }
  }

  return {
    words,
    writings,
    senses,
    glosses,
    kanji,
    kanjiReadings,
    kanjiMeanings,
    kanjiNanori,
    radicals,
    kanjiRadicals,
    kanjiWords: filteredKanjiWords,
    conjugations,
    furigana,
  };
}

function isCommon(word: JmdictWord): boolean {
  return (
    word.kanji.some((k) => k.common) ||
    word.kana.some((k) => k.common)
  );
}
