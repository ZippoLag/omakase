/**
 * Pinned source release + integrity checksums.
 * Update these together when bumping to a newer jmdict-simplified release
 * (see tests/fixtures/manifest.json which is generated from the same pins).
 */
export const SOURCE = "scriptin/jmdict-simplified";
export const RELEASE = "3.6.2+20260824122934";

/**
 * JmdictFurigana release pin (Doublevil/JmdictFurigana, MIT; data derived from
 * JMdict, CC BY-SA 4.0). Rebuilt monthly from the same upstream JMdict that
 * jmdict-simplified mirrors, so the release dates track each other. The repo
 * ships a plain JSON and a .tar.gz of the same file; we pin the .tar.gz so the
 * existing tar loader applies unchanged. The inner JSON is UTF-8 with a BOM.
 */
export const FURIGANA_SOURCE = "Doublevil/JmdictFurigana";
export const FURIGANA_RELEASE = "2.3.1+2026-08-25";
export const FURIGANA_ASSET = "JmdictFurigana.json.tar.gz";
export const FURIGANA_SHA256 = "74bcd9d814de16acc006c328a4b2ebb6ab6733614c9135bc5d7553bcf62240a1";

export interface Asset {
  /** Release asset file name */
  name: string;
  /** sha256 of the downloaded asset */
  sha256: string;
}

export const ASSETS: Asset[] = [
  {
    // Full English-gloss JMdict (218,577 words), not the eng-common subset:
    // eng-common drops entries whose headword/reading are all marked
    // non-common (e.g. お任せ/おまかせ "omakase"), so the full variant is
    // required for complete coverage.
    name: `jmdict-eng-${RELEASE}.json.tgz`,
    sha256: "d9b74539bce7df82491a57ad96a0634a988129db6ca4a362f7221bc5e736871f",
  },
  {
    // -all (13,108 kanji) rather than -en (10,384): kradfile covers the full
    // JIS set, so the kanji table must too, or kanji_radicals FK fails.
    name: `kanjidic2-all-${RELEASE}.json.tgz`,
    sha256: "e0ea8713190ad7a4407949d93e68fa29f8dfd49c604fffef4ecca8ea19f2fc89",
  },
  {
    name: `kradfile-${RELEASE}.json.tgz`,
    sha256: "535d6ac0d8aef49eba309c1f85c77836af735d3b178b6ce7a1218e6ba1c1dec1",
  },
  {
    name: `radkfile-${RELEASE}.json.tgz`,
    sha256: "d69f9c7227612059229a824e06eea39c75edfe87777a4ca1236d820ca86c369b",
  },
  {
    // Curated kanji->kana ruby segmentation for JMdict headwords (236,255
    // text+reading pairs). Release 2.3.1+2026-08-25 (5 MB tgz of a single
    // JSON with a UTF-8 BOM).
    name: FURIGANA_ASSET,
    sha256: FURIGANA_SHA256,
  },
];

export const RAW_DIR = "data/raw";
export const DIST_DIR = "dist";
export const DB_PATH = "dist/kanji.db";
export const META_PATH = "dist/meta.json";
