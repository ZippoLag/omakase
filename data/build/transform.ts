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
export interface ThesaurusLinkRow {
  kind: "related" | "antonym";
  from_word: string;
  to_word: string;
  /** referenced sense number (1-based); null when unspecified / reverse / 2-hop. */
  to_sense: number | null;
  hops: 1 | 2;
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
  thesaurusLinks: ThesaurusLinkRow[];
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
  const thesaurusLinks = buildThesaurusLinks(jmdict.words);

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
    thesaurusLinks,
  };
}

/**
 * Resolve every sense-level `related`/`antonym` xref tuple in the dictionary
 * into `thesaurus_links` rows: forward links, reverse links (relatedness and
 * antonymy are symmetric), and 2-hop closure rows (related→related for
 * synonyms-of-synonyms; related→antonym for indirect antonyms). Self-links
 * and unresolvable xrefs are dropped; repeated targets are de-duplicated with
 * first occurrence winning (forward rows precede reverse/2-hop rows, so a
 * sense-specific gloss is preferred at query time). Resolution mirrors the
 * previous runtime lookups: common-first, then min word id.
 */
function buildThesaurusLinks(words: JmdictWord[]): ThesaurusLinkRow[] {
  // writing text -> candidate word ids (insertion order)
  const allByText = new Map<string, string[]>();
  const kanjiByText = new Map<string, string[]>();
  const kanaByText = new Map<string, Set<string>>();
  const commonIds = new Set<string>();
  const addCandidate = (map: Map<string, string[]>, text: string, id: string) => {
    const arr = map.get(text);
    if (arr) arr.push(id);
    else map.set(text, [id]);
  };
  for (const word of words) {
    if (isCommon(word)) commonIds.add(word.id);
    for (const k of word.kanji) {
      addCandidate(allByText, k.text, word.id);
      addCandidate(kanjiByText, k.text, word.id);
    }
    for (const k of word.kana) {
      addCandidate(allByText, k.text, word.id);
      let set = kanaByText.get(k.text);
      if (!set) {
        set = new Set();
        kanaByText.set(k.text, set);
      }
      set.add(word.id);
    }
  }

  // common first, then smallest numeric id (mirrors findWordByWriting ordering)
  const pick = (cands: string[] | undefined): string | null => {
    if (!cands || cands.length === 0) return null;
    let best = cands[0]!;
    for (const id of cands) {
      const bestCommon = commonIds.has(best);
      const idCommon = commonIds.has(id);
      if (idCommon && !bestCommon) {
        best = id;
      } else if (idCommon === bestCommon && Number(id) < Number(best)) {
        best = id;
      }
    }
    return best;
  };

  const resolve = (text: string, reading: string | null): string | null => {
    if (reading) {
      const kanjiIds = kanjiByText.get(text);
      const kanaIds = kanaByText.get(reading);
      if (!kanjiIds || !kanaIds) return null;
      return pick(kanjiIds.filter((id) => kanaIds.has(id)));
    }
    return pick(allByText.get(text));
  };

  const links: ThesaurusLinkRow[] = [];
  const seen = new Set<string>();
  const push = (kind: "related" | "antonym", from: string, to: string, toSense: number | null, hops: 1 | 2): void => {
    if (from === to) return;
    const key = `${kind}|${from}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ kind, from_word: from, to_word: to, to_sense: toSense, hops });
  };

  // forward links, in word/sense/xref order (first occurrence keeps its gloss)
  const forward: ThesaurusLinkRow[] = [];
  for (const word of words) {
    for (const sense of word.sense) {
      for (const [kind, xrefs] of [
        ["related", sense.related],
        ["antonym", sense.antonym],
      ] as const) {
        for (const raw of xrefs) {
          if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
          let reading: string | null = null;
          let senseNo: number | null = null;
          const second = raw[1];
          if (typeof second === "number") {
            senseNo = second;
          } else if (typeof second === "string") {
            // the reading may carry a "・N" sense disambiguator, e.g. "いる・1"
            const m = /・(\d+)$/.exec(second);
            reading = m ? second.slice(0, m.index) : second;
            if (m) senseNo = Number(m[1]);
            if (typeof raw[2] === "number") senseNo = raw[2];
          }
          const target = resolve(raw[0], reading);
          if (!target) continue;
          forward.push({ kind, from_word: word.id, to_word: target, to_sense: senseNo, hops: 1 });
        }
      }
    }
  }
  for (const r of forward) push(r.kind, r.from_word, r.to_word, r.to_sense, 1);

  // reverse edges
  for (const r of forward) push(r.kind, r.to_word, r.from_word, null, 1);

  // base 1-hop edge sets (forward + reverse) for the closure step
  const relEdges = new Map<string, Set<string>>();
  const antEdges = new Map<string, Set<string>>();
  const addEdge = (map: Map<string, Set<string>>, from: string, to: string) => {
    let set = map.get(from);
    if (!set) {
      set = new Set();
      map.set(from, set);
    }
    set.add(to);
  };
  for (const r of links) {
    if (r.hops !== 1) continue;
    if (r.kind === "related") addEdge(relEdges, r.from_word, r.to_word);
    else addEdge(antEdges, r.from_word, r.to_word);
  }

  // 2-hop closure over a snapshot of the 1-hop rows (exactly one extra hop)
  const base = links.filter((r) => r.hops === 1 && r.kind === "related");
  for (const r of base) {
    for (const u of relEdges.get(r.to_word) ?? []) {
      if (u !== r.from_word) push("related", r.from_word, u, null, 2);
    }
    for (const u of antEdges.get(r.to_word) ?? []) {
      if (u !== r.from_word) push("antonym", r.from_word, u, null, 2);
    }
  }

  return links;
}

function isCommon(word: JmdictWord): boolean {
  return (
    word.kanji.some((k) => k.common) ||
    word.kana.some((k) => k.common)
  );
}
