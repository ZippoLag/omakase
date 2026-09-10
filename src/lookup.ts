/**
 * Read-only query layer over the SQLite dictionary DB.
 *
 * M1 covers the word / kanji / search lookups the CLI commands plus the
 * golden tests need. The shapes returned here mirror the fixture rendering
 * contract in tests/fixtures/scripts/render-goldens.py so the formatters can
 * reproduce the golden outputs byte-for-byte.
 */
import { kangxiChar } from "./kangxi.js";
import { katakanaToHiragana, toRomaji } from "./kana.js";

/** A value bound to a SQL parameter (strings, numbers, nulls). */
export type SqlValue = string | number | null;

/**
 * Minimal synchronous SQLite surface the query layer needs. Implemented by
 * better-sqlite3 in the CLI and by the sqlite-wasm statement shim in the web
 * app (src/web) — keeps this module browser-portable. `get`/`all` return
 * opaque values; every call site casts rows to the shape it expects.
 * Parameters are typed loosely (unknown[]) so both drivers' bind signatures
 * stay structurally compatible; the query layer only ever binds strings,
 * numbers and nulls.
 */
export interface DbLike {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

type DB = DbLike;

export interface LoadedWriting {
  text: string;
  common: boolean;
}
export interface LoadedSense {
  partOfSpeech: string[];
  glosses: string[];
}
export interface LoadedWord {
  id: string;
  common: boolean;
  kanji: LoadedWriting[];
  kana: LoadedWriting[];
  senses: LoadedSense[];
  /** writing -> ruby-marked reading (from the furigana table). */
  furigana: Map<string, string>;
}

/** Load a word entry (writings, senses, glosses, furigana) by JMdict id. */
export function loadWord(db: DB, id: string): LoadedWord | null {
  const word = db.prepare("SELECT id, common FROM words WHERE id = ?").get(id) as { id: string; common: number } | undefined;
  if (!word) return null;

  const kanji = db.prepare(
    "SELECT text, common FROM writings WHERE word_id = ? AND kind = 'kanji' ORDER BY id",
  ).all(id) as { text: string; common: number }[];
  const kana = db.prepare(
    "SELECT text, common FROM writings WHERE word_id = ? AND kind = 'kana' ORDER BY id",
  ).all(id) as { text: string; common: number }[];
  const sensesRaw = db.prepare(
    "SELECT id, part_of_speech FROM senses WHERE word_id = ? ORDER BY position",
  ).all(id) as { id: number; part_of_speech: string }[];

  const senses: LoadedSense[] = sensesRaw.map((s) => ({
    partOfSpeech: JSON.parse(s.part_of_speech) as string[],
    glosses: (db.prepare("SELECT text FROM glosses WHERE sense_id = ? ORDER BY id").all(s.id) as { text: string }[]).map((g) => g.text),
  }));

  const fg = db.prepare("SELECT writing, segments FROM furigana WHERE word_id = ?").all(id) as { writing: string; segments: string }[];
  const furigana = new Map(fg.map((f) => [f.writing, f.segments]));

  return {
    id: word.id,
    common: word.common === 1,
    kanji: kanji.map((k) => ({ text: k.text, common: k.common === 1 })),
    kana: kana.map((k) => ({ text: k.text, common: k.common === 1 })),
    senses,
    furigana,
  };
}

/**
 * Find a word by an exact writing (kanji or kana). Prefers the first word
 * whose common headword equals the query (used by the `word` command).
 */
export function findWordByWriting(db: DB, query: string): LoadedWord | null {
  const row = db.prepare(
    "SELECT word_id FROM writings WHERE text = ? ORDER BY common DESC, word_id LIMIT 1",
  ).get(query) as { word_id: string } | undefined;
  return row ? loadWord(db, row.word_id) : null;
}

/** First common kanji + first common kana (render-goldens display_header). */
export function displayHeader(word: LoadedWord): { text: string; reading: string | null; common: boolean } {
  const w = word.kanji.find((k) => k.common) ?? word.kanji[0];
  const r = word.kana.find((k) => k.common) ?? word.kana[0];
  const text = w ? w.text : r ? r.text : "?";
  const reading = r ? r.text : null;
  return { text, reading, common: word.common };
}

/** First English gloss across all senses (render-goldens first_gloss). */
export function firstGloss(word: LoadedWord): string {
  for (const s of word.senses) {
    for (const g of s.glosses) {
      if (g) return g;
    }
  }
  return "";
}

/**
 * Ruby-marked form of a writing of a loaded word (from the furigana table; a
 * writing with no dataset entry falls back to the bare writing, which callers
 * treat as "no annotation").
 */
export function rubyFor(word: LoadedWord, writing: string): string {
  return word.furigana.get(writing) ?? writing;
}

// ---- kanji ----------------------------------------------------------------

/**
 * When every character of `query` is a kanji with an entry in the kanji
 * table, return those characters in order; otherwise return null. Lets
 * `kanji 制作者` behave like `kanji 制` + `kanji 作` + `kanji 者` — one page
 * per character — while leaving kana/romaji (reading-search) queries alone.
 */
export function kanjiLiterals(db: DB, query: string): string[] | null {
  const chars = [...query];
  if (chars.length === 0) return null;
  const rows = db.prepare(
    `SELECT literal FROM kanji WHERE literal IN (${chars.map(() => "?").join(",")})`,
  ).all(...chars) as { literal: string }[];
  const found = new Set(rows.map((r) => r.literal));
  return chars.every((c) => found.has(c)) ? chars : null;
}

export interface LoadedKanji {
  literal: string;
  strokeCount: number | null;
  grade: number | null;
  frequency: number | null;
  jlptLevel: number | null;
  classicalRadical: number | null;
  /** Component radicals from kradfile (rowid = kradfile order), e.g. 喰 → [口, 食]. */
  radicals: string[];
  on: string[];
  kun: string[];
  nanori: string[];
  meanings: string[];
  compounds: { wordId: string; writing: string; ruby: string; gloss: string }[];
  /** Distinct words containing this kanji, before the compounds cap. */
  compoundTotal: number;
  /** stroke-order SVG file name (e.g. '098df.svg') or null when KanjiVG has
   * no diagram for this character (stroke_order table row absent). */
  strokeFile: string | null;
}

function firstGlossById(db: DB, id: string): string {
  const senses = db.prepare("SELECT id FROM senses WHERE word_id = ? ORDER BY position").all(id) as { id: number }[];
  for (const s of senses) {
    const g = db.prepare("SELECT text FROM glosses WHERE sense_id = ? ORDER BY id LIMIT 1").get(s.id) as { text: string } | undefined;
    if (g) return g.text;
  }
  return "";
}

/**
 * Load a kanji page (radical breakdown, readings, meanings, nanori,
 * compounds) by literal. `radicals` are the kradfile component radicals in
 * kradfile order (a radical kanji lists itself first, e.g. 見 → 見 目 儿).
 * `maxCompounds` caps the compounds list (the page still reports how many
 * compounds exist via LoadedKanji.compoundTotal).
 */
/**
 * Stroke-order SVG file for a kanji literal (stroke_order index), or null
 * when KanjiVG has no diagram for it. Browser-portable (no filesystem IO —
 * callers resolve the file name to a path or URL).
 */
export function strokeFileFor(db: DB, literal: string): string | null {
  const row = db.prepare("SELECT svg_file FROM stroke_order WHERE kanji = ?").get(literal) as { svg_file: string } | undefined;
  return row?.svg_file ?? null;
}

/**
 * Load a kanji page (radical breakdown, readings, meanings, nanori,
 * compounds) by literal. `radicals` are the kradfile component radicals in
 * kradfile order (a radical kanji lists itself first, e.g. 見 → 見 目 儿).
 * `maxCompounds` caps the compounds list (the page still reports how many
 * compounds exist via LoadedKanji.compoundTotal); `offset` starts the
 * window `offset` rows in, so a paged kanji page shows rows
 * [offset, offset+maxCompounds) while still reporting the full total.
 */
export function loadKanji(db: DB, literal: string, maxCompounds?: number, offset = 0): LoadedKanji | null {
  const k = db.prepare(
    "SELECT literal, stroke_count, grade, frequency, jlpt_level, classical_radical FROM kanji WHERE literal = ?",
  ).get(literal) as LoadedKanjiRow | undefined;
  if (!k) return null;

  const on = (db.prepare("SELECT value FROM kanji_readings WHERE kanji = ? AND type = 'on' ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);
  const kun = (db.prepare("SELECT value FROM kanji_readings WHERE kanji = ? AND type = 'kun' ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);
  const nanori = (db.prepare("SELECT value FROM kanji_nanori WHERE kanji = ? ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);
  const meanings = (db.prepare("SELECT value FROM kanji_meanings WHERE kanji = ? AND lang = 'en' ORDER BY rowid").all(literal) as { value: string }[]).map((r) => r.value);
  const radicals = (db.prepare("SELECT radical FROM kanji_radicals WHERE kanji = ? ORDER BY rowid").all(literal) as { radical: string }[]).map((r) => r.radical);

  const rows = db.prepare(`
    SELECT kw.word_id, kw.writing_id, w.text AS writing
    FROM kanji_words kw
    JOIN writings w ON w.id = kw.writing_id
    WHERE kw.kanji = ?
    ORDER BY kw.word_id, kw.writing_id
  `).all(literal) as { word_id: string; writing_id: number; writing: string }[];

  // Rows are in word-id order; cap the list before loading words (each load
  // is a handful of queries) and report the uncapped total for the note.
  const compoundTotal = rows.length;
  const window = maxCompounds === undefined ? rows.slice(offset) : rows.slice(offset, offset + maxCompounds);
  const compounds = window.map((r) => {
    const word = loadWord(db, r.word_id);
    return {
      wordId: r.word_id,
      writing: r.writing,
      ruby: word?.furigana.get(r.writing) ?? r.writing,
      gloss: word ? firstGloss(word) : "",
    };
  });

  return {
    literal: k.literal,
    strokeCount: k.stroke_count,
    grade: k.grade,
    frequency: k.frequency,
    jlptLevel: k.jlpt_level,
    classicalRadical: k.classical_radical,
    radicals,
    on,
    kun,
    nanori,
    meanings,
    compounds,
    compoundTotal,
    strokeFile: strokeFileFor(db, literal),
  };
}

// ---- words containing a set of kanji ----------------------------------------

export interface KanjiWordHit {
  word: LoadedWord;
  /** the writing that carries the matched kanji (with the most of them). */
  writing: string;
  /** ruby-marked form of `writing` (furigana table, falling back to bare). */
  ruby: string;
  /** first English gloss across all senses. */
  gloss: string;
  /** how many of the requested kanji appear in this word (1..n). */
  matched: number;
}

/**
 * Words whose writings contain any of `literals`, ranked most-likely-first:
 * the most distinct requested kanji first (all before subsets), then common
 * words, then entry id — capped at `max` shown, with the total reported.
 * One hit per word, showing the writing that carries the most requested
 * kanji (the first one by writings.id when several tie), with furigana and
 * first gloss (compounds-style row).
 *
 * Ranking and the `max` cap are pushed into SQL — windowed CTEs pick each
 * word's best writing and rank the distinct words before a LIMIT — so only
 * the top `max` words are ever loaded. A multi-kanji query like 制作者 can
 * otherwise pull every compound of every character (plus per-word common
 * flags, chunked under the variable limit) into JS just to rank and drop
 * all but the top rows. `total` reports the pre-cap word count.
 */
export function wordsContainingKanji(db: DB, literals: string[], max: number, offset = 0): { hits: KanjiWordHit[]; total: number } {
  const ph = literals.map(() => "?").join(",");
  // COUNT(*) OVER () runs over the ranked set (before the LIMIT), so one
  // statement returns both the capped words and the pre-cap total.
  const rows = db.prepare(`
    WITH per_writing AS (
      SELECT kw.word_id, kw.writing_id, w.text AS writing,
             COUNT(DISTINCT kw.kanji) AS matched
      FROM kanji_words kw
      JOIN writings w ON w.id = kw.writing_id
      WHERE kw.kanji IN (${ph})
      GROUP BY kw.word_id, kw.writing_id
    ),
    best AS (
      SELECT word_id, writing, matched,
             ROW_NUMBER() OVER (
               PARTITION BY word_id ORDER BY matched DESC, writing_id
             ) AS rn
      FROM per_writing
    )
    SELECT b.word_id, b.writing, b.matched, COUNT(*) OVER () AS total
    FROM best b
    JOIN words w ON w.id = b.word_id
    WHERE b.rn = 1
    ORDER BY b.matched DESC, w.common DESC, CAST(b.word_id AS INTEGER)
    LIMIT ? OFFSET ?
  `).all(...literals, max, offset) as {
    word_id: string;
    writing: string;
    matched: number;
    total: number;
  }[];

  const hits: KanjiWordHit[] = [];
  for (const r of rows) {
    const word = loadWord(db, r.word_id);
    if (!word) continue;
    hits.push({
      word,
      writing: r.writing,
      ruby: word.furigana.get(r.writing) ?? r.writing,
      gloss: firstGloss(word),
      matched: r.matched,
    });
  }
  return { hits, total: rows.length === 0 ? 0 : Number(rows[0]!.total) };
}

interface LoadedKanjiRow {
  literal: string;
  stroke_count: number | null;
  grade: number | null;
  frequency: number | null;
  jlpt_level: number | null;
  classical_radical: number | null;
}

/** Radical character for a Kangxi radical number (e.g. 184 → 食), if known. */
export function radicalChar(db: DB, number: number): string | null {
  const ch = kangxiChar(number);
  if (ch) return ch;
  const row = db.prepare("SELECT radical FROM radicals WHERE code = ?").get(String(number)) as { radical: string } | undefined;
  return row?.radical ?? null;
}

// ---- search ---------------------------------------------------------------

export interface SearchHit {
  word: LoadedWord;
  /** kana reading shown in the result row (`[たべる]` / `[たべる (taberu)]`). */
  reading: string;
  /** Hepburn romaji of `reading` — set on reading-prefix hits so the CLI can
   * show (and bold) the romaji next to the kana; unset on meaning hits. */
  romaji?: string;
  /** gloss line: the matched sense gloss for meaning hits, the first gloss
   * for reading hits. This is the text the CLI bolds overlaps into. */
  gloss: string;
  /** reading-prefix hits only: true when the reading *equals* the query, so
   * the CLI can tell genuine reading intent (take → たけ) from accidental
   * ASCII prefix hits (eat → エアタオル "eataoru"). */
  exact?: boolean;
}

function isKana(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x3041 && c <= 0x3096) || (c >= 0x30a1 && c <= 0x30f6);
}

export function isKanaInput(input: string): boolean {
  return [...input].some(isKana);
}

/** Lowercased [a-z0-9]+ tokens from a gloss query, dropping single characters. */
export function glossQueryTokens(query: string): string[] {
  return (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}

/**
 * Word ids whose FTS gloss row matches `expr` (FTS5 query language: prefix
 * terms like `develop*`, `AND`/`OR` …), ordered by word id. FTS rowid = gloss
 * id (glosses_fts is contentless, populated in buildDb), so the join goes
 * through glosses → senses (ids are per-table sequences, so a bare
 * senses.id = f.rowid join would mispair whenever the ids coincide).
 */
function glossWordIds(db: DB, expr: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT s.word_id
    FROM glosses_fts f
    JOIN glosses g ON g.id = f.rowid
    JOIN senses s ON s.id = g.sense_id
    WHERE glosses_fts MATCH ?
    ORDER BY s.word_id
  `).all(expr) as { word_id: string }[];
  return rows.map((r) => r.word_id);
}

/**
 * English-gloss (meaning) search over the FTS5 `glosses_fts` index
 * (unicode61). The query is split into lowercased alphanumeric tokens
 * (single characters dropped); a word matches when ONE of its senses
 * contains every token — each as an exact gloss word or as a word prefix
 * (`develop` matches a gloss containing "development"), in any order across
 * that sense's glosses. Tokens split across different senses do NOT match
 * (flexible containment means within one sense).
 *
 * Rows are ranked most-likely-first: senses whose match is strongest come
 * first — (1) more exact-token terms, (2) prefix-only terms, (3) common
 * words, (4) entry id. The gloss shown for a hit is the first gloss of the
 * first covering sense that contains a matched term (not merely sense 1),
 * which is what the CLI bolds.
 *
 * Candidate discovery per token uses the FTS index (`"tok"` for exact,
 * `tok*` for prefix); words are then scored in JS against their loaded
 * glosses.
 *
 * Async so the web worker can report real progress: the candidate pool is
 * fully known before the load loop, so `onProgress(done, total)` is called
 * every `PROGRESS_CHUNK` loaded candidates (and once at the end). Passed no
 * callback it behaves exactly like the CLI's old synchronous search — the
 * awaits cost nothing and the output is byte-identical (timing only). The
 * pool is ordered by word id; a candidate whose rank lands in the top `max`
 * is independent of how many were loaded before it.
 */
export type MeaningProgress = (done: number, total: number) => void | Promise<void>;

/** Yield cadence of the candidate load loop (see searchMeanings). Small
 * (8) so the wasm worker yields to the event loop ~8× more often than a
 * chunk of 64 would: progress messages reach the UI more frequently, the
 * lookup watchdog is extended more finely, and the % readout updates
 * smoother. Cost is negligible — one extra postMessage per 8 rows. The CLI
 * passes no onProgress, so the loop never awaits here and output is
 * byte-identical (timing only). */
const PROGRESS_CHUNK = 8;

export async function searchMeanings(
  db: DB,
  query: string,
  onProgress?: MeaningProgress,
): Promise<SearchHit[]> {
  const tokens = glossQueryTokens(query);
  if (tokens.length === 0) return [];

  const glossWords = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  interface Ranked {
    word: LoadedWord;
    display: string;
    exactCount: number;
    prefixCount: number;
    /** position of the first sense that covers every token (0-based). */
    sense: number;
  }

  const rank = (word: LoadedWord): Ranked | null => {
    const exact = new Array<boolean>(tokens.length).fill(false);
    const covered = new Array<boolean>(tokens.length).fill(false);
    let display: string | null = null;
    let firstSense: number | null = null;
    for (let si = 0; si < word.senses.length; si++) {
      const s = word.senses[si]!;
      // Per-sense flags: does THIS sense contain every token?
      const m = new Array<boolean>(tokens.length).fill(false);
      const e = new Array<boolean>(tokens.length).fill(false);
      for (const g of s.glosses) {
        const ws = glossWords(g);
        tokens.forEach((t, k) => {
          if (ws.includes(t)) {
            e[k] = true;
            m[k] = true;
          } else if (ws.some((w) => w.startsWith(t))) m[k] = true;
        });
      }
      if (!m.every(Boolean)) continue; // this sense lacks some token
      if (firstSense === null) firstSense = si;
      e.forEach((v, k) => { if (v) exact[k] = true; });
      m.forEach((v, k) => { if (v) covered[k] = true; });
      if (display === null) {
        for (const g of s.glosses) {
          const ws = glossWords(g);
          if (ws.some((w) => tokens.some((t) => w === t || w.startsWith(t)))) {
            display = g;
            break;
          }
        }
      }
    }
    if (firstSense === null) return null; // no single sense contains all tokens
    return {
      word,
      display: display ?? firstGloss(word),
      exactCount: exact.filter(Boolean).length,
      prefixCount: covered.filter(Boolean).length - exact.filter(Boolean).length,
      sense: firstSense,
    };
  };

  // Candidate pools via FTS: words where every token occurs as an exact gloss
  // token, or (falling back) as a token prefix. Exact pools rank first.
  const perToken = tokens.map((t) => ({
    exact: new Set(glossWordIds(db, `"${t}"`)),
    any: new Set(glossWordIds(db, `${t}*`)),
  }));
  const intersect = (sets: Set<string>[]): string[] => {
    let cur: Set<string> | null = null;
    for (const s of sets) {
      if (cur === null) {
        cur = s;
        continue;
      }
      const next = new Set<string>();
      for (const id of cur) if (s.has(id)) next.add(id);
      cur = next;
    }
    return cur ? [...cur] : [];
  };
  const exactPool = intersect(perToken.map((p) => p.exact));
  const anyPool = intersect(perToken.map((p) => p.any));
  const exactSet = new Set(exactPool);
  const ranked: Ranked[] = [];
  const seen = new Set<string>();
  // The pool has no duplicates (exact ids, then any-only ids), so done runs
  // 1..total in order and the final call always reports total/total.
  //
  // Both pools are capped at MEANING_POOL_LIMIT: ultra-common single tokens
  // (of: ~31k, to: ~21k, the: ~18k exact gloss words in the real dictionary)
  // would otherwise score tens of thousands of loaded words synchronously
  // and run for tens of minutes in wasm — the watchdog would kill them as
  // "took too long" instead of answering. Typical tokens stay far under the
  // cap (eat: 120, water: 1153, develop: 33), so their pools are unchanged;
  // only the truly pathological ones are bounded, at the cost of ranking
  // within a capped pool for those (acceptable — the alternative is a hang).
  const pool = [
    ...exactPool.slice(0, MEANING_POOL_LIMIT),
    ...anyPool.filter((i) => !exactSet.has(i)).slice(0, MEANING_POOL_LIMIT),
  ];
  const total = pool.length;
  let done = 0;
  for (const id of pool) {
    if (seen.has(id)) continue;
    seen.add(id);
    const word = loadWord(db, id);
    if (!word) continue;
    const r = rank(word);
    if (r) ranked.push(r);
    done++;
    if (onProgress && (done % PROGRESS_CHUNK === 0 || done === total)) {
      await onProgress(done, total);
    }
  }
  ranked.sort((a, b) =>
    b.exactCount - a.exactCount ||
    b.prefixCount - a.prefixCount ||
    a.sense - b.sense ||
    Number(b.word.common) - Number(a.word.common) ||
    a.word.id.localeCompare(b.word.id, undefined, { numeric: true }),
  );

  const out: SearchHit[] = [];
  for (const r of ranked) {
    const { reading } = displayHeader(r.word);
    out.push({ word: r.word, reading: reading ?? "", gloss: r.display });
  }
  return out;
}

/** Max words scored per meaning search from each candidate pool (exact and
 * prefix-only alike): caps the pathological ultra-common-token case without
 * ever touching typical queries. */
const MEANING_POOL_LIMIT = 2000;

/** ASCII-only input check (gloss + romaji paths). */
export function isAsciiInput(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

export interface ReadingSuggestion {
  word: LoadedWord;
  /** the suggested reading (kana), which the CLI can search by prefix. */
  reading: string;
  /** romaji transcription of the suggested reading (src/kana.ts). */
  romaji: string;
  gloss: string;
}

/**
 * Best-effort "did you mean" for an ASCII query whose gloss + reading searches
 * both came up empty: relaxes to *any single non-stopword token* as a prefix
 * term and returns the first word (by id) whose gloss matches. Null when no
 * token matches anything, so the caller can fall back to a generic hint.
 */
export function suggestReading(db: DB, query: string): ReadingSuggestion | null {
  const tokens = glossQueryTokens(query).filter((t) => !GLOSS_STOPWORDS.has(t));
  for (const t of tokens) {
    const ids = glossWordIds(db, `${t}*`);
    if (ids.length === 0) continue;
    const word = loadWord(db, ids[0]!);
    if (!word) continue;
    const { reading } = displayHeader(word);
    return {
      word,
      reading: reading ?? "",
      romaji: toRomaji(reading ?? ""),
      gloss: firstGloss(word),
    };
  }
  return null;
}

/**
 * Escape SQL LIKE wildcards (`%`, `_`) plus the escape char itself so user
 * input (or a DB-derived writing) is matched literally — paired with the
 * `ESCAPE '\\'` clause on every LIKE below.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

export interface ReadingPrefixResult {
  hits: SearchHit[];
  /** distinct words whose kana writing starts with the prefix, before `max`. */
  total: number;
}

/**
 * Reading-prefix search over kana writings, matched against the kana text
 * (kana input) or the stored romaji (ASCII input). Input spaces are ignored
 * (`ta be ru` searches like `taberu`), so romaji typed one kana at a time
 * still hits. Rows are ranked most-likely-first: an exact reading match
 * wins, then common words, then the closest (shortest) reading, then entry
 * id — one hit per word, showing its first matching kana writing.
 *
 * Ranking and the `max` cap are pushed into SQL — one windowed statement
 * picks each word's first matching kana writing (lowest writings.id), ranks
 * the distinct words, and LIMIT/OFFSETs before any word is loaded — so at
 * most `max` words are loaded instead of every prefix match (short
 * kana/romaji prefixes can otherwise match thousands). `max` is the LIMIT
 * bound; a negative value means no cap, like SQLite. `offset` starts the
 * window `offset` rows in (paging; the CLI instead requests a LIMIT of
 * offset+max and lets the renderer slice). `total` reports the pre-cap
 * count (COUNT(*) OVER () runs before the LIMIT) so callers can still
 * render the ``… and N more`` remainder.
 */
export function searchReadingPrefix(db: DB, prefix: string, max: number, offset = 0): ReadingPrefixResult {
  const q = prefix.trim();
  const kana = isKanaInput(q);
  const needle = (kana ? q : q.toLowerCase()).replace(/\s+/g, "");
  if (!needle) return { hits: [], total: 0 };
  const col = kana ? "text" : "romaji";
  // COUNT(*) OVER () runs over the full ranked set (before the LIMIT), so
  // one statement returns both the capped hits and the pre-cap total.
  const rows = db.prepare(`
    WITH firsts AS (
      SELECT word_id, text, romaji,
             ROW_NUMBER() OVER (PARTITION BY word_id ORDER BY id) AS rn
      FROM writings
      WHERE kind = 'kana' AND ${col} LIKE ? ESCAPE '\\'
    )
    SELECT f.word_id, f.text, f.romaji, COUNT(*) OVER () AS total
    FROM firsts f
    JOIN words w ON w.id = f.word_id
    WHERE f.rn = 1
    ORDER BY (f.${col} = ?) DESC, w.common DESC, LENGTH(f.text), CAST(f.word_id AS INTEGER)
    LIMIT ? OFFSET ?
  `).all(`${escapeLike(needle)}%`, needle, max, offset) as {
    word_id: string;
    text: string;
    romaji: string | null;
    total: number;
  }[];

  const hits: SearchHit[] = [];
  for (const r of rows) {
    const word = loadWord(db, r.word_id);
    if (!word) continue; // words is writings' parent (FK), so unreachable
    const exact = kana ? r.text === needle : (r.romaji ?? "") === needle;
    hits.push({ word, exact, reading: r.text, romaji: r.romaji ?? "", gloss: firstGloss(word) });
  }
  return { hits, total: rows.length === 0 ? 0 : Number(rows[0]!.total) };
}

// ---- kanji reading search --------------------------------------------------

export interface KanjiReadingHit {
  literal: string;
  /** the on/kun/nanori readings that matched the prefix (stored form). */
  readings: string[];
  /** English meanings. */
  meanings: string[];
}

const stripDots = (s: string): string => s.replace(/\./g, "");

/** kana→hiragana with reading dots removed, so た.べる normalizes to たべる. */
function normalizeReading(s: string): string {
  return katakanaToHiragana(stripDots(s));
}

/** Katakana counterpart of a standard-range hiragana char (or null). */
function katakanaOf(hira: string): string | null {
  const code = hira.codePointAt(0)!;
  return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : null;
}

/**
 * Kanji whose on/kun/nanori reading starts with the query, ordered by literal.
 * Kana input matches kana (katakana readings normalized to hiragana; kun dot
 * separators ignored); ASCII input matches the Hepburn-ish romaji of each
 * reading (src/kana.ts). One entry per kanji, listing only the matched
 * readings, mirroring how the word search shows the matched reading.
 *
 * Candidate discovery is index-driven: a reading can match the prefix only
 * if its first character normalizes to one of the kana that can START it —
 * the needle's own first kana (hiragana + katakana form) for kana input, or
 * every kana whose romaji begins with the needle's first letter for ASCII
 * (the small-tsu geminate is added too, since っ-initial readings romanize
 * to any consonant). kanji_readings.value carries idx_kanji_readings_value,
 * so the candidates are fetched as one UNION ALL of per-variant value-range
 * seeks; kanji_nanori has no value index, so it is a single filtered scan.
 * The few surviving rows are verified exactly in JS (dots, kana script and
 * full romaji prefix), and the per-kanji readings/meanings are fetched for
 * the matched literals in a handful of chunked queries — not per kanji.
 */
export function searchKanjiByReading(db: DB, query: string): KanjiReadingHit[] {
  const isKana = isKanaInput(query);
  const needle = isKana ? normalizeReading(query) : query.toLowerCase();
  if (!needle) return [];
  const matches = (value: string): boolean => {
    const norm = normalizeReading(value);
    return isKana ? norm.startsWith(needle) : toRomaji(norm).startsWith(needle);
  };

  const starts: string[] = [];
  const addStart = (hira: string): void => {
    starts.push(hira);
    const kata = katakanaOf(hira);
    if (kata) starts.push(kata);
  };
  if (isKana) {
    addStart(needle[0]!);
  } else {
    for (let code = 0x3041; code <= 0x3096; code++) {
      const hira = String.fromCodePoint(code);
      if (toRomaji(hira).startsWith(needle[0]!)) addStart(hira);
    }
  }
  addStart("っ"); // っ-initial readings romanize to any following consonant
  if (starts.length === 0) return [];

  // [first char, next codepoint) spans — `value LIKE 'X%'` equivalents that
  // are pure range constraints, so the UNION branches can seek the index.
  const spans = starts.map((ch) => {
    const code = ch.codePointAt(0)!;
    return [ch, String.fromCodePoint(code + 1)] as const;
  });
  const spansPh = spans.map(() => "(value >= ? AND value < ?)").join(" OR ");
  const spanParams = spans.flat();

  const matched = new Set<string>();
  const readingRows = db.prepare(
    spans.map(() => "SELECT kanji, value FROM kanji_readings WHERE value >= ? AND value < ?").join(" UNION ALL "),
  ).all(...spanParams) as { kanji: string; value: string }[];
  for (const r of readingRows) {
    if (matches(r.value)) matched.add(r.kanji);
  }
  const nanoriRows = db.prepare(
    `SELECT kanji, value FROM kanji_nanori WHERE ${spansPh}`,
  ).all(...spanParams) as { kanji: string; value: string }[];
  for (const n of nanoriRows) {
    if (matches(n.value)) matched.add(n.kanji);
  }
  if (matched.size === 0) return [];

  const literals = [...matched].sort();
  const per = new Map<string, { readings: string[]; nanori: string[]; meanings: string[] }>();
  for (const literal of literals) per.set(literal, { readings: [], nanori: [], meanings: [] });

  // Per-literal rows, chunked under SQLite's variable limit: matched readings
  // (the rows shown), nanori, and English meanings, each in rowid order.
  for (let i = 0; i < literals.length; i += 900) {
    const batch = literals.slice(i, i + 900);
    const ph = batch.map(() => "?").join(",");
    const readRows = db.prepare(
      `SELECT kanji, value FROM kanji_readings WHERE kanji IN (${ph}) ORDER BY kanji, rowid`,
    ).all(...batch) as { kanji: string; value: string }[];
    for (const r of readRows) {
      if (matches(r.value)) per.get(r.kanji)!.readings.push(r.value);
    }
    const nanaRows = db.prepare(
      `SELECT kanji, value FROM kanji_nanori WHERE kanji IN (${ph}) ORDER BY kanji, rowid`,
    ).all(...batch) as { kanji: string; value: string }[];
    for (const r of nanaRows) {
      if (matches(r.value)) per.get(r.kanji)!.nanori.push(r.value);
    }
    const meanRows = db.prepare(
      `SELECT kanji, value FROM kanji_meanings WHERE kanji IN (${ph}) AND lang = 'en' ORDER BY kanji, rowid`,
    ).all(...batch) as { kanji: string; value: string }[];
    for (const r of meanRows) per.get(r.kanji)!.meanings.push(r.value);
  }

  const out: KanjiReadingHit[] = [];
  for (const literal of literals) {
    const p = per.get(literal)!;
    out.push({ literal, readings: [...p.readings, ...p.nanori], meanings: p.meanings });
  }
  return out;
}

// ---- thesaurus -------------------------------------------------------------

export interface ThesaurusHit {
  word: LoadedWord;
  /** gloss of the referenced sense (or the first gloss when no sense is given). */
  gloss: string;
}

/** Glosses of the referenced sense (or the first gloss when no sense given). */
function xrefGloss(word: LoadedWord, sense: number | null): string {
  if (sense != null) {
    const s = word.senses[sense - 1];
    if (s && s.glosses.length > 0) return s.glosses.join("; ");
  }
  return firstGloss(word);
}

const THESAURUS_LIMIT = 5;

/**
 * Thesaurus for a word: synonyms (`related`) and antonyms (`antonym`) from the
 * materialized `thesaurus_links` table — resolved offline into forward links,
 * reverse links, and 2-hop closure rows (see data/build/transform.ts). Rows
 * are read in build order, so the first link to a target wins (preferring the
 * sense-specific gloss of a forward link); targets are de-duplicated and
 * "top" = common words first, then by word id; each list is windowed at
 * [offset, offset+limit) (default limit 5) with the full pre-window counts
 * reported alongside, so a paged CLI/web can show the remainder note.
 */
export function wordThesaurus(
  db: DB,
  word: LoadedWord,
  limit: number = THESAURUS_LIMIT,
  offset = 0,
): { synonyms: ThesaurusHit[]; antonyms: ThesaurusHit[]; synonymTotal: number; antonymTotal: number } {
  const collect = (kind: "related" | "antonym"): { hits: ThesaurusHit[]; total: number } => {
    const rows = db.prepare(
      `SELECT to_word, to_sense FROM thesaurus_links
       WHERE kind = ? AND from_word = ? AND to_word != from_word
       ORDER BY rowid`,
    ).all(kind, word.id) as { to_word: string; to_sense: number | null }[];
    const hits: ThesaurusHit[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.to_word)) continue;
      seen.add(r.to_word);
      const target = loadWord(db, r.to_word);
      if (!target) continue;
      hits.push({ word: target, gloss: xrefGloss(target, r.to_sense) });
    }
    hits.sort((a, b) =>
      Number(b.word.common) - Number(a.word.common) ||
      a.word.id.localeCompare(b.word.id, undefined, { numeric: true }),
    );
    return { hits, total: hits.length };
  };
  const syn = collect("related");
  const ant = collect("antonym");
  return {
    synonyms: syn.hits.slice(offset, offset + limit),
    antonyms: ant.hits.slice(offset, offset + limit),
    synonymTotal: syn.total,
    antonymTotal: ant.total,
  };
}

// ---- gloss-token thesaurus fallback -----------------------------------------

/**
 * Function words and other overly generic gloss tokens that say nothing about
 * semantic similarity ("to", "be", "of", "e.g.", …). Kept in sync with the
 * reference renderer in tests/fixtures/scripts/render-goldens.py
 * (GLOSS_STOPWORDS).
 */
const GLOSS_STOPWORDS = new Set([
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
function glossTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((t) => t.length > 1 && !GLOSS_STOPWORDS.has(t));
}

/** Coarse POS class for a JMdict tag ("verb" / "adj" / "noun" / "adv"). */
function coarseClass(tag: string): string | null {
  if (tag.startsWith("v") || tag === "aux-v") return "verb";
  if (tag.startsWith("adj")) return "adj";
  if (/^n(?:-|$)/.test(tag) || tag === "pn" || tag === "pr" || tag === "num") return "noun";
  if (tag === "adv") return "adv";
  return null;
}

/** Coarse POS classes across all senses of a word (empty = uncategorisable). */
function coarsePosClasses(senses: { partOfSpeech: string[] }[]): Set<string> {
  const out = new Set<string>();
  for (const s of senses) {
    for (const tag of s.partOfSpeech) {
      const c = coarseClass(tag);
      if (c) out.add(c);
    }
  }
  return out;
}

/** Cap on the number of distinct gloss tokens queried per word. */
const GLOSS_TOKEN_CAP = 30;

/**
 * Fallback thesaurus for entries with no cross-reference links at all:
 * related words are inferred from shared, distinctive English gloss tokens
 * over the existing `glosses_fts` index (one quoted FTS query per token). A
 * candidate scores the summed specificity (ln(1 + N/df)) of its shared
 * tokens; candidates must share a coarse POS class when both sides are
 * categorisable, and the word itself plus any already-linked targets are
 * excluded. Ties break common-first, then by word id; capped at `limit`.
 * Mirrors render-goldens.py `render_gloss_thesaurus`.
 */
export function glossThesaurus(
  db: DB,
  word: LoadedWord,
  limit: number = THESAURUS_LIMIT,
  offset = 0,
): { synonyms: ThesaurusHit[]; antonyms: ThesaurusHit[]; synonymTotal: number; antonymTotal: number } {
  const tokens = new Set<string>();
  for (const s of word.senses) {
    for (const g of s.glosses) {
      for (const t of glossTokens(g)) tokens.add(t);
    }
  }
  if (tokens.size === 0) return { synonyms: [], antonyms: [], synonymTotal: 0, antonymTotal: 0 };

  const sourceClasses = coarsePosClasses(word.senses);
  const skip = new Set<string>([word.id]);
  for (const r of db.prepare(
    "SELECT DISTINCT to_word FROM thesaurus_links WHERE from_word = ?",
  ).all(word.id) as { to_word: string }[]) {
    skip.add(r.to_word);
  }
  const total = (db.prepare("SELECT COUNT(*) AS n FROM words").get() as { n: number }).n;

  // Per token: FTS hit word ids. df = distinct words containing the token
  // (computed before skipping self/linked targets); shared tokens per word.
  const df = new Map<string, number>();
  const shared = new Map<string, Set<string>>();
  for (const t of [...tokens].slice(0, GLOSS_TOKEN_CAP)) {
    const rows = db.prepare(`
      SELECT DISTINCT s.word_id
      FROM glosses_fts f
      JOIN glosses g ON g.id = f.rowid
      JOIN senses s ON s.id = g.sense_id
      WHERE glosses_fts MATCH ?
    `).all(`"${t}"`) as { word_id: string }[];
    df.set(t, rows.length);
    for (const r of rows) {
      if (skip.has(r.word_id)) continue;
      let set = shared.get(r.word_id);
      if (!set) {
        set = new Set();
        shared.set(r.word_id, set);
      }
      set.add(t);
    }
  }

  const candIds = [...shared.keys()];
  if (candIds.length === 0) return { synonyms: [], antonyms: [], synonymTotal: 0, antonymTotal: 0 };

  // Coarse POS per candidate (all senses) for the class-overlap filter.
  const candClasses = new Map<string, Set<string>>();
  const posRows = db.prepare(
    `SELECT word_id, part_of_speech FROM senses WHERE word_id IN (${candIds.map(() => "?").join(",")})`,
  ).all(...candIds) as { word_id: string; part_of_speech: string }[];
  for (const r of posRows) {
    let set = candClasses.get(r.word_id);
    if (!set) {
      set = new Set();
      candClasses.set(r.word_id, set);
    }
    for (const c of coarsePosClasses([{ partOfSpeech: JSON.parse(r.part_of_speech) as string[] }])) set.add(c);
  }

  // common flag is a tie-breaker after score and shared-token count
  const commonRows = db.prepare(
    `SELECT id, common FROM words WHERE id IN (${candIds.map(() => "?").join(",")})`,
  ).all(...candIds) as { id: string; common: number }[];
  const commonById = new Map(commonRows.map((r) => [r.id, r.common === 1]));

  interface Cand {
    id: string;
    score: number;
    sharedCount: number;
  }
  const cands: Cand[] = [];
  for (const id of candIds) {
    const targetClasses = candClasses.get(id);
    if (sourceClasses.size > 0 && targetClasses && targetClasses.size > 0) {
      let overlap = false;
      for (const c of sourceClasses) {
        if (targetClasses.has(c)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) continue;
    }
    const toks = shared.get(id)!;
    let score = 0;
    for (const t of toks) score += Math.log(1 + total / (df.get(t) ?? 1));
    cands.push({ id, score, sharedCount: toks.size });
  }

  cands.sort((a, b) =>
    b.score - a.score ||
    b.sharedCount - a.sharedCount ||
    Number(commonById.get(b.id)) - Number(commonById.get(a.id)) ||
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  );

  const synonyms: ThesaurusHit[] = [];
  for (const c of cands.slice(offset, offset + limit)) {
    const target = loadWord(db, c.id);
    if (!target) continue;
    synonyms.push({ word: target, gloss: firstGloss(target) });
  }
  return { synonyms, antonyms: [], synonymTotal: cands.length, antonymTotal: 0 };
}

// ---- example sentences ----------------------------------------------------

export interface LoadedSentence {
  id: number;
  japanese: string;
  english: string;
}

/** Sentences whose Japanese contains any writing of the word, ordered by id. */
export function exampleSentences(db: DB, word: LoadedWord): LoadedSentence[] {
  const writings = [...word.kanji.map((k) => k.text), ...word.kana.map((k) => k.text)];
  const matches: { id: number; japanese: string; english: string }[] = [];
  for (const w of writings) {
    matches.push(...db.prepare(
      "SELECT id, japanese, english FROM sentences WHERE japanese LIKE ? ESCAPE '\\' ORDER BY id",
    ).all(`%${escapeLike(w)}%`) as { id: number; japanese: string; english: string }[]);
  }
  // de-dup by id, preserve ascending
  const seen = new Set<number>();
  const out: LoadedSentence[] = [];
  for (const m of matches) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, japanese: m.japanese, english: m.english });
  }
  return out;
}