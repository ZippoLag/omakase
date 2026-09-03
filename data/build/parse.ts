/**
 * Typed loaders for jmdict-simplified release archives (tgz of a single JSON)
 * and the KanjiVG stroke-order zip. Field names match
 * @scriptin/jmdict-simplified-types exactly.
 */
import { gunzipSync } from "node:zlib";
import { RELEASE } from "./config.js";
import { readZip } from "./unzip.js";

export interface JmdictKanji {
  common: boolean;
  text: string;
  tags: string[];
}
export interface JmdictKana {
  common: boolean;
  text: string;
  tags: string[];
  appliesToKanji: string[];
}
export interface JmdictGloss {
  lang: string;
  gender: string | null;
  type: string | null;
  text: string;
}
export interface JmdictSense {
  partOfSpeech: string[];
  appliesToKanji: string[];
  appliesToKana: string[];
  related: unknown[];
  antonym: unknown[];
  field: string[];
  dialect: string[];
  misc: string[];
  info: string[];
  languageSource: unknown[];
  gloss: JmdictGloss[];
}
export interface JmdictWord {
  id: string;
  kanji: JmdictKanji[];
  kana: JmdictKana[];
  sense: JmdictSense[];
}
export interface JmdictFile {
  version: string;
  languages: string[];
  dictDate: string;
  commonOnly: boolean;
  dictRevisions: string[];
  tags: Record<string, string>;
  words: JmdictWord[];
}

export interface Kanjidic2Character {
  literal: string;
  codepoints: { type: string; value: string }[];
  radicals: { type: string; value: number }[];
  misc: {
    grade: number | null;
    strokeCounts: number[];
    variants: { type: string; value: string }[];
    frequency: number | null;
    radicalNames: string[];
    jlptLevel: number | null;
  };
  dictionaryReferences: unknown[];
  queryCodes: unknown[];
  readingMeaning: {
    groups: {
      readings: { type: string; onType: string | null; status: string | null; value: string }[];
      meanings: { lang: string; value: string }[];
    }[];
    nanori: string[];
  } | null;
}
export interface Kanjidic2File {
  version: string;
  dictDate: string;
  fileVersion: number;
  databaseVersion: string;
  characters: Kanjidic2Character[];
}

/** One ruby segment of a JmdictFurigana entry: a kanji (or other symbol)
 * with its reading, or a bare kana run (no `rt`). */
export interface FuriganaSegment {
  ruby: string;
  rt?: string;
}

/** One JmdictFurigana entry: text + reading keyed pair with its segments. */
export interface FuriganaEntry {
  text: string;
  reading: string;
  furigana: FuriganaSegment[];
}

export interface KradfileFile {
  version: string;
  kanji: Record<string, string[]>;
}

export interface RadkfileRadicalInfo {
  strokeCount: number;
  code: string | null;
  kanji: string[];
}
export interface RadkfileFile {
  version: string;
  radicals: Record<string, RadkfileRadicalInfo>;
}

function loadJson<T>(buf: Buffer): T {
  // The archives are .tgz = gzip of a tar containing a single .json file.
  // Decompress fully, then read the first tar entry (512-byte header;
  // file size is an octal string at offset 124, data follows at offset 512).
  const tar = gunzipSync(buf);
  const sizeField = tar.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "");
  const size = parseInt(sizeField, 8);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("unexpected tar layout: size field = " + JSON.stringify(sizeField));
  }
  const json = tar.subarray(512, 512 + size);
  return JSON.parse(json.toString("utf-8")) as T;
}

/**
 * Load the JmdictFurigana JSON (same tgz-of-single-json layout, but the inner
 * JSON is UTF-8 with a BOM, which breaks a bare JSON.parse).
 */
export function loadFurigana(buf: Buffer): FuriganaEntry[] {
  const tar = gunzipSync(buf);
  const sizeField = tar.subarray(124, 136).toString("utf-8").replace(/\0.*$/, "");
  const size = parseInt(sizeField, 8);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("unexpected furigana tar layout: size field = " + JSON.stringify(sizeField));
  }
  const json = tar.subarray(512, 512 + size).toString("utf-8").replace(/^\uFEFF/, "");
  return JSON.parse(json) as FuriganaEntry[];
}

export function loadJmdict(buf: Buffer): JmdictFile {
  return loadJson<JmdictFile>(buf);
}
export function loadKanjidic2(buf: Buffer): Kanjidic2File {
  return loadJson<Kanjidic2File>(buf);
}
export function loadKradfile(buf: Buffer): KradfileFile {
  return loadJson<KradfileFile>(buf);
}
export function loadRadkfile(buf: Buffer): RadkfileFile {
  return loadJson<RadkfileFile>(buf);
}

// ---- KanjiVG (stroke order) ------------------------------------------------

export interface KanjivgEntry {
  /** the svg file name, e.g. '098df.svg' (Unicode codepoint in hex). */
  file: string;
  /** the kanji literal the file draws (from its codepoint), e.g. '食'. */
  literal: string;
  /** raw SVG text (stroke paths, stroke numbers, kvg attributes). */
  text: string;
}

/** KanjiVG zip entries are flat files named kanji/<5-hex-codepoint>.svg. */
const KANJIVG_FILE_RE = /^kanji\/([0-9a-f]{5})\.svg$/;

/**
 * Load the KanjiVG `-main` zip: one SVG per kanji (no variant forms), each
 * named by its codepoint, e.g. kanji/098df.svg for 食 (U+98DF). Entries for
 * characters outside the CJK ideograph range (symbols, kana, …) are kept
 * here too — the build drops them when no kanji row matches the literal.
 */
export function loadKanjivg(buf: Buffer): KanjivgEntry[] {
  const out: KanjivgEntry[] = [];
  for (const entry of readZip(buf)) {
    const m = KANJIVG_FILE_RE.exec(entry.name);
    if (!m) continue;
    const literal = String.fromCodePoint(parseInt(m[1]!, 16));
    out.push({ file: `${m[1]}.svg`, literal, text: entry.data.toString("utf8") });
  }
  return out;
}

export const RELEASE_TAG = RELEASE;
