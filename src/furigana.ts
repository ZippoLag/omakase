/**
 * Furigana (ruby) annotations for kanji writings.
 *
 * M1 carries a hand-pinned, known-correct map so the CLI can display readings
 * the way the golden outputs require (e.g. 食[たべ]る). The README documents
 * that the pipeline will source these from JmdictFurigana in M2 — when that
 * lands, this map is replaced by a generated one and the goldens get a
 * reviewed diff. Until then this is treated as ground truth.
 *
 * Values are the final ruby-marked strings: kanji segments with their reading
 * in brackets, kana passthrough unchanged. `furiganaFor` returns the ruby for
 * a pinned writing, or the writing itself when unpinned (no known split).
 */
const FURIGANA: Record<string, string> = {
  食べる: "食[たべ]る", 喰べる: "喰[たべ]る",
  食べ物: "食[たべ]物[もの]", 食べもの: "食[たべ]もの",
  食事: "食[しょく]事[じ]",
  来る: "来[く]る", 來る: "來[く]る",
  良い: "良[よ]い", 好い: "好[よ]い", 善い: "善[よ]い",
  佳い: "佳[よ]い", 吉い: "吉[よ]い", 宜い: "宜[よ]い",
  綺麗: "綺[き]麗[れい]", 奇麗: "奇[き]麗[れい]", 暉麗: "暉[き]麗[れい]",
  暑い: "暑[あつ]い",
  飲む: "飲[の]む", 呑む: "呑[の]む", 飮む: "飮[の]む", 吞む: "吞[の]む",
  食う: "食[く]う", 喰う: "喰[く]う", 啖う: "啖[く]う",
  為る: "為[す]る",
};

/** Ruby-marked form of `writing` (falls back to the bare writing). */
export function furiganaFor(writing: string): string {
  return FURIGANA[writing] ?? writing;
}

/** All pinned (writing → ruby) entries, for seeding the furigana table. */
export function furiganaEntries(): [string, string][] {
  return Object.entries(FURIGANA);
}