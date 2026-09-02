/**
 * Web replica of the CLI command glue (src/cli.ts minus Node/arg parsing):
 * runs one `word` / `kanji` / `search` against the open dictionary and
 * renders the same output text the golden tests pin, so panes show exactly
 * what `omakase` prints — byte-for-byte, minus ANSI color.
 */
import type { DbLike } from "../../src/lookup.js";
import {
  displayHeader,
  exampleSentences,
  findWordByWriting,
  glossThesaurus,
  isKanaInput,
  kanjiLiterals,
  loadKanji,
  radicalChar,
  searchKanjiByReading,
  wordsContainingKanji,
  searchMeanings,
  searchReadingPrefix,
  suggestReading,
  wordThesaurus,
} from "../../src/lookup.js";
import {
  KANJI_MAX_DEFAULT,
  renderExamples,
  renderKanji,
  renderKanjiReadingSearch,
  renderKanjiWords,
  renderSearch,
  renderThesaurus,
  renderWordBody,
} from "../../src/format.js";

/** JMdict tag -> description map, stored in the meta table (like cli.loadTags). */
export function loadTags(db: DbLike): Record<string, string> {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'tags'").get() as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as Record<string, string>;
  } catch {
    return {};
  }
}

/** ASCII-only input (gloss + romaji paths), mirroring cli.ts's private check. */
function isAscii(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

/** `word <query>` — entry body + thesaurus + example sentences. */
export function runWord(db: DbLike, query: string, tags: Record<string, string>): string | null {
  const word = findWordByWriting(db, query);
  if (!word) return null;
  const body = renderWordBody(word, tags);
  let { synonyms, antonyms } = wordThesaurus(db, word);
  if (synonyms.length === 0 && antonyms.length === 0) {
    synonyms = glossThesaurus(db, word).synonyms;
  }
  const thesaurus = renderThesaurus(synonyms, antonyms);
  const examples = renderExamples(exampleSentences(db, word));
  return [body, thesaurus, examples].filter(Boolean).join("\n");
}

/**
 * `kanji <query> [-max N]` — mirrors cli.ts's cmdKanji: a multi-kanji query
 * first lists words containing the characters (ranked, capped at `max`),
 * then one page per kanji literal with compounds capped at `max`; kana /
 * romaji queries go through the kanji-by-reading search, capped at `max`.
 */
export function runKanji(db: DbLike, query: string, max: number = KANJI_MAX_DEFAULT): string | null {
  const literals = kanjiLiterals(db, query);
  if (literals) {
    const parts: string[] = [];
    if (literals.length > 1) {
      const words = wordsContainingKanji(db, literals, max);
      const wordsText = renderKanjiWords(words.hits, words.total, max);
      if (wordsText !== "") parts.push(wordsText);
    }
    for (const literal of literals) {
      const kanji = loadKanji(db, literal, max);
      if (!kanji) return null; // every literal passed kanjiLiterals, so unreachable
      let radicalDisplay: string | null = null;
      if (kanji.classicalRadical != null) {
        radicalDisplay = `${radicalChar(db, kanji.classicalRadical) ?? "?"} (${kanji.classicalRadical})`;
      }
      parts.push(renderKanji(kanji, radicalDisplay));
    }
    // No separator: every part ends with a newline (see cli.ts cmdKanji).
    return parts.join("");
  }
  const hits = searchKanjiByReading(db, query);
  if (hits.length === 0) return null;
  return renderKanjiReadingSearch(query, hits, max);
}

/** `search <query>` — ranked readings/meanings/kanji sections + did-you-mean hint. */
export function runSearch(db: DbLike, query: string, max: number = 30): string {
  const trimmed = query.trim();
  const readings = searchReadingPrefix(db, trimmed);
  const meanings = isAscii(trimmed) ? searchMeanings(db, trimmed) : [];
  const keepReadings = isKanaInput(trimmed)
    || meanings.length === 0
    || readings.some((h) => h.exact);
  const shownReadings = keepReadings ? readings : [];
  const kanjiHits = isKanaInput(trimmed) || isAscii(trimmed)
    ? searchKanjiByReading(db, trimmed)
    : [];
  const out = renderSearch(trimmed, shownReadings, meanings, kanjiHits, { max, color: false });
  if (shownReadings.length === 0 && meanings.length === 0 && kanjiHits.length === 0 && isAscii(trimmed)) {
    return out + webSearchHint(db, trimmed);
  }
  return out;
}

/** "did you mean" hint — mirrors cli.ts searchHint. */
function webSearchHint(db: DbLike, query: string): string {
  const sug = suggestReading(db, query);
  if (sug && sug.reading) {
    const text = displayHeader(sug.word).text;
    return (
      `  hint: no gloss matches — did you mean「${text} [${sug.reading}] ${sug.gloss}」?\n` +
      `  readings match by prefix — try \`search ${sug.reading}\` (romaji: ${sug.romaji})\n`
    );
  }
  return (
    "  hint: no matches — readings match by kana or romaji prefix\n" +
    "  try e.g. `search genzou`, or the kanji reading search `kanji genzou`\n"
  );
}

