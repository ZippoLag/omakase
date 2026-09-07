/**
 * Pure, DOM-free query helpers shared by the UI (main.ts) and the unit
 * tests: how a `word` / `kanji` box expands into the actual lookups, and how
 * the per-list row cap parses. Kept in their own module (no DOM imports) so
 * tests can exercise the shipped code directly — see tests/web.test.ts.
 */

/** CJK ideographs — every displayed kanji is individually clickable. */
export const KANJI_RE = /\p{Script=Han}/u;
/** Separators between words in a `word` box: commas (ASCII `,`, full-width
 * `，`, Japanese `、`) and any whitespace. */
export const WORD_SEP_RE = /[\s,，、]+/u;

/**
 * The individual words of a `word` box, in order (runs between separators).
 */
export function wordTokens(raw: string): string[] {
  return raw.split(WORD_SEP_RE).filter((s) => s !== "");
}

/**
 * The query a `kanji` click actually runs: when the box holds at least one
 * kanji, every non-kanji character is ignored — 食べる → 食, 制・作者 →
 * 制作者 — so the page for each individual kanji still comes back. A box
 * with no kanji at all (kana or romaji, e.g. a reading search) is left
 * untouched.
 */
export function kanjiQuery(raw: string): string {
  const literals = [...raw].filter((ch) => KANJI_RE.test(ch));
  return literals.length > 0 ? literals.join("") : raw.trim();
}

/**
 * The lookups a `kanji` click enqueues, in box order: when the box holds
 * kanji, ONE lookup per kanji literal — 制・作者 → 制, 作, 者 — so each
 * character's page is its own lookup, landing (and rendering) one at a time
 * instead of after the whole batch, byte-identical to looking it up alone.
 * A box with no kanji at all (kana or romaji, e.g. a reading search) stays a
 * single query, unchanged.
 */
export function kanjiQueries(raw: string): string[] {
  const stripped = kanjiQuery(raw);
  return KANJI_RE.test(stripped) ? [...stripped] : [stripped];
}

/**
 * Per-list row cap from the "max" input's value: a positive integer, else
 * the default (30). Non-integer / empty / out-of-range values fall back.
 * Pure — the caller passes the input's value (`parseMax(maxInput.value)`).
 */
export function parseMax(value: string): number {
  const v = Number(value);
  return Number.isInteger(v) && v >= 1 ? v : 30;
}