/**
 * Transform parsed jmdict-simplified JSON into the relational rows defined
 * in data-model.md §3. Deterministic: identical input ⇒ identical rows.
 */
import { toRomaji } from "../../src/kana.js";
import { coarsePosClasses, glossTokens } from "../../src/gloss.js";
import { CONJUGATABLE, conjugateReading, type ConjClass } from "../../src/conjugation.js";
import type {
  FuriganaEntry,
  FuriganaSegment,
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
  kind: "synonym" | "related" | "antonym";
  source: "xref" | "gloss";
  from_word: string;
  to_word: string;
  /** source sense number (1-based); null for synthetic reverse edges. */
  from_sense: number | null;
  /** referenced sense number (1-based); null when unspecified / reverse. */
  to_sense: number | null;
  /** 1 for xref edges, the weighted-Dice confidence (0..1) for gloss edges. */
  score: number;
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

/** Render JmdictFurigana segments to one ruby-marked string (`食[た]べる`). */
export function renderFurigana(segments: FuriganaSegment[]): string {
  return segments.map((s) => (s.rt ? `${s.ruby}[${s.rt}]` : s.ruby)).join("");
}

/**
 * (writing, reading) -> ruby-marked string, from the raw JmdictFurigana
 * entries. The dataset keys on the exact JMdict spelling + kana reading pair,
 * so lookups use the word's own kana writings as-is.
 */
export function furiganaLookup(entries: FuriganaEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    map.set(`${e.text}\u0000${e.reading}`, renderFurigana(e.furigana));
  }
  return map;
}

/**
 * Ruby-marked segments for a kanji writing of a word: the first kana reading
 * (JMdict kana order) that has a dataset entry wins. Returns null when the
 * dataset has no entry for any (writing, reading) pair — the CLI then omits
 * the Furigana line rather than echoing the writing.
 */
export function furiganaForWriting(
  word: Pick<JmdictWord, "kana">,
  writing: string,
  lookup: Map<string, string>,
): { reading: string; segments: string } | null {
  for (const k of word.kana) {
    const segments = lookup.get(`${writing}\u0000${k.text}`);
    if (segments !== undefined) return { reading: k.text, segments };
  }
  return null;
}

function isKanji(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return code >= 0x4e00 && code <= 0x9fff;
}

export function transform(
  jmdict: JmdictFile,
  kanjidic2: Kanjidic2File,
  kradfile: KradfileFile,
  radkfile: RadkfileFile,
  furiganaData: FuriganaEntry[],
): Transformed {
  const lookup = furiganaLookup(furiganaData);

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

    // furigana: ruby segmentation sourced from the JmdictFurigana dataset
    // (writing × first kana reading with an entry). No entry -> no row; the
    // CLI omits the Furigana line for such writings instead of echoing them.
    for (const k of kanjiWritings) {
      const fg = furiganaForWriting(word, k.text, lookup);
      if (fg && fg.segments !== k.text) {
        furigana.push({
          word_id: word.id,
          writing: k.text,
          reading: fg.reading,
          segments: fg.segments,
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
 * into `thesaurus_links` rows:
 *   - a mutual `related` pair (both entries really cite each other) becomes
 *     `kind='synonym'`; a one-way one stays honestly labeled `related`,
 *   - explicit `antonym` xrefs stay `kind='antonym'`, plus the reverse of
 *     one-way rows (relatedness and antonymy are symmetric),
 *   - gloss-similarity synonyms are appended by `buildGlossSynonymLinks`.
 * 2-hop closure is deliberately NOT materialized — see THESAURUS-PLAN.md.
 * Self-links and unresolvable xrefs are dropped; repeated targets are
 * de-duplicated with first occurrence winning (real forward rows precede the
 * synthetic reverses, so a sense-specific gloss is preferred at query time).
 * Resolution mirrors the runtime lookups: common-first, then min word id.
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

  // 1-hop forward xrefs (real declarations only, in word/sense/xref order)
  const forward: ThesaurusLinkRow[] = [];
  for (const word of words) {
    word.sense.forEach((sense, si) => {
      const fromSense = si + 1;
      for (const [kind, xrefs] of [
        ["related", sense.related],
        ["antonym", sense.antonym],
      ] as const) {
        for (const raw of xrefs) {
          if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
          let reading: string | null = null;
          let toSense: number | null = null;
          const second = raw[1];
          if (typeof second === "number") {
            toSense = second;
          } else if (typeof second === "string") {
            // the reading may carry a "・N" sense disambiguator, e.g. "いる・1"
            const m = /・(\d+)$/.exec(second);
            reading = m ? second.slice(0, m.index) : second;
            if (m) toSense = Number(m[1]);
            if (typeof raw[2] === "number") toSense = raw[2];
          }
          const target = resolve(raw[0], reading);
          if (!target) continue;
          forward.push({
            kind,
            source: "xref",
            from_word: word.id,
            to_word: target,
            from_sense: fromSense,
            to_sense: toSense,
            score: 1,
            hops: 1,
          });
        }
      }
    });
  }

  // Reciprocal = the two entries really cite each other. Only the real forward
  // edges count: the synthetic reverse below must not fabricate symmetry (that
  // is exactly what turned every one-way "see also" into a "synonym").
  const relatedPairs = new Set(
    forward.filter((r) => r.kind === "related").map((r) => `${r.from_word}\u0000${r.to_word}`),
  );
  const isMutual = (a: string, b: string): boolean =>
    relatedPairs.has(`${a}\u0000${b}`) && relatedPairs.has(`${b}\u0000${a}`);

  const links: ThesaurusLinkRow[] = [];
  const seen = new Set<string>();
  const push = (row: ThesaurusLinkRow): void => {
    if (row.from_word === row.to_word) return;
    const key = `${row.kind}|${row.from_word}|${row.to_word}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(row);
  };

  // Real links: a mutual `related` pair is a genuine synonym; a one-way one
  // stays honestly labeled `related`.
  for (const r of forward) {
    push({
      ...r,
      kind: r.kind === "related" ? (isMutual(r.from_word, r.to_word) ? "synonym" : "related") : "antonym",
    });
  }
  // See-also is symmetric: add the reverse of one-way pairs so the target can
  // discover the source too. Mutual pairs already have both real rows above.
  for (const r of forward) {
    if (r.kind === "related" && isMutual(r.from_word, r.to_word)) continue;
    push({
      kind: r.kind,
      source: "xref",
      from_word: r.to_word,
      to_word: r.from_word,
      from_sense: null,
      to_sense: null,
      score: 1,
      hops: 1,
    });
  }

  // Gloss-similarity synonyms, materialized here so the runtime is a plain
  // indexed read (the old query-time FTS fallback is gone). Appended one row
  // at a time on purpose: at full dictionary scale this array is far larger
  // than V8's argument limit, so `links.push(...rows)` overflows the call
  // stack ("Maximum call stack size exceeded" — hit on the first full build).
  for (const row of buildGlossSynonymLinks(words, links)) links.push(row);

  return links;
}

function isCommon(word: JmdictWord): boolean {
  return (
    word.kanji.some((k) => k.common) ||
    word.kana.some((k) => k.common)
  );
}

// ---- gloss-similarity synonyms (build-time) --------------------------------
//
// The old runtime fallback compared whole-word token bags with no threshold, so
// multi-sense words matched anything sharing one English word (為る→飲む via
// "carry"). This pass compares **sense to sense** instead, drops glue tokens by
// document frequency, and only keeps edges that clear a weighted-Dice score
// gate. Everything is materialized, so the hot path stays a single indexed
// read. Tunables are mirrored in tests/fixtures/scripts/render-goldens.py.

/** Max distinct gloss tokens considered per word (existing runtime cap). */
export const GLOSS_TOKEN_CAP = 30;
/**
 * A shared token appearing in more than this many senses is glue — dropped.
 *
 * This is a *glue* ceiling, not a stopword filter: it must sit above the whole
 * content vocabulary, not just above the function words. Measured over the
 * full dictionary (253,299 senses): eat 123, beautiful 235, live 246, drink
 * 286, story 322, run 440, food 791, work 1,026, make 1,142. The previous
 * value of 200 therefore deleted the words that carry the meaning — every real
 * synonym whose glosses are short and common was scored on the leftovers and
 * fell below the gate (食べる→食う exists at 4,000 and does not at 200).
 * 4,000 keeps the whole content vocabulary while still dropping tokens that
 * appear everywhere; raising it further changes nothing at all (4,000 and
 * 20,000 produce byte-identical edge sets), so it is deliberately not tighter.
 */
export const GLOSS_DF_CEIL = 4000;
/**
 * Minimum shared (kept) tokens before a candidate is scored at all.
 *
 * One is not enough: on the judged sample of common words, single-token
 * matches were 54% wrong — they join words that merely occupy the same domain
 * (観劇 "theatre-going" vs シアター "theater", 減速 "deceleration" vs 減衰時間
 * "deceleration time") — while two-or-more-token matches were 85% right. A
 * one-token overlap is too thin to tell synonymy from topical adjacency.
 */
export const GLOSS_MIN_SHARED = 2;
/** Minimum weighted-Dice score (0..1) for a synonym edge.
 *
 * 0.5 let in a long tail of near-misses. 0.6 was picked on the judged sample
 * (51 common words, every edge read by hand against both senses' glosses): it
 * keeps 45/51 of those words showing a synonym while the edges it admits are
 * ~94% defensible and only ~6% clearly wrong (at 0.5 those were 78% / 22%).
 * Below the gate the honest answer is no synonym at all. */
export const GLOSS_MIN_SCORE = 0.6;
/** Max gloss-synonym edges materialized per word. */
export const GLOSS_TOP_K = 5;

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

interface GlossSense {
  wordId: string;
  senseNo: number;
  /** kept tokens of this sense (word cap + df ceiling applied). */
  tokens: string[];
  classes: Set<string>;
}

/**
 * Weighted-Dice similarity of two (already kept-token-filtered) senses:
 * `2·Σ_{shared} w / (Σ_A w + Σ_B w)` with `w(t) = ln(1 + N/df(t))`.
 */
function senseScore(a: string[], b: string[], weight: (t: string) => number): number {
  const bSet = new Set(b);
  let num = 0;
  let den = 0;
  for (const t of a) {
    const w = weight(t);
    den += w;
    if (bSet.has(t)) num += w;
  }
  for (const t of b) den += weight(t);
  return den === 0 ? 0 : (2 * num) / den;
}

/**
 * Materialize `kind='synonym', source='gloss'` edges for every word that has
 * no explicit synonym/related signal of its own (a received backlink is not
 * one), scoring sense pairs and keeping the top `GLOSS_TOP_K` targets per word.
 */
function buildGlossSynonymLinks(words: JmdictWord[], xrefLinks: ThesaurusLinkRow[]): ThesaurusLinkRow[] {
  // Per-sense token lists (gloss order preserved, deduped), then the per-word
  // cap: a word only ever considers its first GLOSS_TOKEN_CAP distinct tokens.
  const rawTokens: string[][] = [];
  const senseMeta: { wordId: string; senseNo: number; classes: Set<string> }[] = [];
  const wordTokens = new Map<string, string[]>();
  const wordTokenSet = new Map<string, Set<string>>();
  for (const word of words) {
    const seenTokens = new Set<string>();
    const ordered: string[] = [];
    word.sense.forEach((sense, si) => {
      const toks: string[] = [];
      const local = new Set<string>();
      for (const g of sense.gloss) {
        for (const t of glossTokens(g.text)) {
          if (local.has(t)) continue;
          local.add(t);
          toks.push(t);
          if (!seenTokens.has(t)) {
            seenTokens.add(t);
            if (ordered.length < GLOSS_TOKEN_CAP) ordered.push(t);
          }
        }
      }
      rawTokens.push(toks);
      senseMeta.push({ wordId: word.id, senseNo: si + 1, classes: coarsePosClasses(sense.partOfSpeech) });
    });
    wordTokens.set(word.id, ordered);
    wordTokenSet.set(word.id, new Set(ordered));
  }

  // Document frequency over senses (only tokens inside the per-word cap).
  const df = new Map<string, number>();
  rawTokens.forEach((toks, i) => {
    const keep = wordTokenSet.get(senseMeta[i]!.wordId)!;
    for (const t of new Set(toks.filter((t) => keep.has(t)))) df.set(t, (df.get(t) ?? 0) + 1);
  });
  const N = rawTokens.length;
  const weight = (t: string): number => Math.log(1 + N / (df.get(t) ?? 1));
  const kept = (t: string): boolean => (df.get(t) ?? 0) <= GLOSS_DF_CEIL;

  const senses: GlossSense[] = rawTokens.map((toks, i) => {
    const meta = senseMeta[i]!;
    const keep = wordTokenSet.get(meta.wordId)!;
    return { ...meta, tokens: toks.filter((t) => keep.has(t) && kept(t)) };
  });
  const postings = new Map<string, number[]>();
  senses.forEach((s, i) => {
    for (const t of s.tokens) {
      let arr = postings.get(t);
      if (!arr) {
        arr = [];
        postings.set(t, arr);
      }
      arr.push(i);
    }
  });

  // Words that already carry a synonym/related signal OF THEIR OWN, and the
  // targets each word already links to (an xref target is never re-proposed as
  // a synonym). A synthetic backlink (`from_sense === null`) is not a signal of
  // the target's own: it only exists so the target can discover the source, and
  // treating it as one silently denied the gloss pass to every word that merely
  // *received* a one-way xref (~19k of them) — they rendered a Related block of
  // inbound links and no synonyms at all. `linked` deliberately keeps backlink
  // targets, so such a related pair is still never promoted to a synonym.
  const hasSignal = new Set<string>();
  const linked = new Map<string, Set<string>>();
  for (const r of xrefLinks) {
    let set = linked.get(r.from_word);
    if (!set) {
      set = new Set();
      linked.set(r.from_word, set);
    }
    set.add(r.to_word);
    if (r.from_sense !== null && (r.kind === "synonym" || r.kind === "related")) hasSignal.add(r.from_word);
  }
  const common = new Map<string, boolean>(words.map((w) => [w.id, isCommon(w)]));
  const sensesByWord = new Map<string, number[]>();
  senses.forEach((s, i) => {
    let arr = sensesByWord.get(s.wordId);
    if (!arr) {
      arr = [];
      sensesByWord.set(s.wordId, arr);
    }
    arr.push(i);
  });

  const rows: ThesaurusLinkRow[] = [];
  for (const word of words) {
    if (hasSignal.has(word.id)) continue;
    const mySenseIdx = sensesByWord.get(word.id)!;
    const sourceTokens = wordTokens.get(word.id)!;
    if (sourceTokens.length === 0) continue;
    const skip = linked.get(word.id);

    // Candidate words: those sharing at least one kept token, with the shared
    // token set kept so the gate can look at count and rarity.
    const shared = new Map<string, Set<string>>();
    for (const t of sourceTokens) {
      for (const j of postings.get(t) ?? []) {
        const other = senses[j]!.wordId;
        if (other === word.id) continue;
        if (skip?.has(other)) continue;
        let set = shared.get(other);
        if (!set) {
          set = new Set();
          shared.set(other, set);
        }
        set.add(t);
      }
    }
    if (shared.size === 0) continue;

    const cands: { id: string; score: number; sharedCount: number; fromSense: number; toSense: number }[] = [];
    for (const [otherId, sharedToks] of shared) {
      // Gate: a single shared token is too weak a signal (see GLOSS_MIN_SHARED).
      if (sharedToks.size < GLOSS_MIN_SHARED) continue;

      // Best sense pair (same coarse POS when both sides categorise).
      let best = 0;
      let fromSense = 0;
      let toSense = 0;
      for (const i of mySenseIdx) {
        const a = senses[i]!;
        for (const j of sensesByWord.get(otherId)!) {
          const b = senses[j]!;
          if (a.classes.size > 0 && b.classes.size > 0 && !intersects(a.classes, b.classes)) continue;
          const score = senseScore(a.tokens, b.tokens, weight);
          if (score > best) {
            best = score;
            fromSense = a.senseNo;
            toSense = b.senseNo;
          }
        }
      }
      if (best < GLOSS_MIN_SCORE) continue;
      cands.push({ id: otherId, score: best, sharedCount: sharedToks.size, fromSense, toSense });
    }
    if (cands.length === 0) continue;

    cands.sort((a, b) =>
      b.score - a.score ||
      b.sharedCount - a.sharedCount ||
      Number(common.get(b.id)) - Number(common.get(a.id)) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
    for (const c of cands.slice(0, GLOSS_TOP_K)) {
      rows.push({
        kind: "synonym",
        source: "gloss",
        from_word: word.id,
        to_word: c.id,
        from_sense: c.fromSense,
        to_sense: c.toSense,
        score: c.score,
        hops: 1,
      });
    }
  }
  return rows;
}
