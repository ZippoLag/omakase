/**
 * Shared English-gloss tokenization, used by BOTH the build-time synonym pass
 * (`data/build/transform.ts`) and the runtime "did you mean" hint
 * (`src/lookup.ts` suggestReading), so the two never drift apart.
 *
 * Kept in sync with the reference renderer in
 * tests/fixtures/scripts/render-goldens.py (GLOSS_STOPWORDS / gloss_tokens /
 * coarse_class).
 */

/** Function words and other overly generic gloss tokens that say nothing about
 * semantic similarity ("to", "be", "of", "e.g.", …). */
export const GLOSS_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "if", "then", "else",
  "not", "no", "of", "to", "in", "on", "at", "for", "with", "by", "from",
  "as", "is", "are", "was", "were", "be", "been", "being", "am", "do",
  "does", "did", "done", "have", "has", "had", "it", "its", "this", "that",
  "these", "those", "i", "you", "he", "she", "we", "they", "me", "him",
  "her", "us", "them", "my", "your", "our", "their", "e", "g", "etc",
  "eg", "ie", "sth", "sb", "some", "something", "someone", "somebody",
  "anything", "anyone", "thing", "things", "way", "ways", "one", "two",
  "used", "usu", "often", "also", "such", "very", "more", "most", "when",
  "what", "which", "who", "whom", "whose", "how", "why", "up", "down",
  "out", "off", "over", "under", "into", "onto", "about", "after", "before",
  "between", "during", "through", "until", "against", "among", "along",
  "lit", "arch", "obs", "dated", "rare", "uk", "sl", "coll", "fam",
  "derog", "hon", "pol", "vulg", "esp", "first", "last", "kind", "sort",
]);

/** Lowercased [a-z]+ gloss tokens, minus stopwords and single letters. */
export function glossTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((t) => t.length > 1 && !GLOSS_STOPWORDS.has(t));
}

/** Coarse POS class for a JMdict tag ("verb" / "adj" / "noun" / "adv"). */
export function coarseClass(tag: string): string | null {
  if (tag.startsWith("v") || tag === "aux-v") return "verb";
  if (tag.startsWith("adj")) return "adj";
  if (/^n(?:-|$)/.test(tag) || tag === "pn" || tag === "pr" || tag === "num") return "noun";
  if (tag === "adv") return "adv";
  return null;
}

/** Coarse POS classes for a set of JMdict tags (empty = uncategorisable). */
export function coarsePosClasses(tags: string[]): Set<string> {
  const out = new Set<string>();
  for (const tag of tags) {
    const c = coarseClass(tag);
    if (c) out.add(c);
  }
  return out;
}
