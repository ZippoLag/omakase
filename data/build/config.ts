/**
 * Pinned source release + integrity checksums.
 * Update these together when bumping to a newer jmdict-simplified release
 * (see tests/fixtures/manifest.json which is generated from the same pins).
 */
export const SOURCE = "scriptin/jmdict-simplified";
export const RELEASE = "3.6.2+20260824122934";

export interface Asset {
  /** Release asset file name */
  name: string;
  /** sha256 of the downloaded asset */
  sha256: string;
}

export const ASSETS: Asset[] = [
  {
    name: `jmdict-eng-common-${RELEASE}.json.tgz`,
    sha256: "3f2063c08fdac7209918be3495f4a447a01c97ff3add857f61d0bcfd9ed31e5b",
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
];

export const RAW_DIR = "data/raw";
export const DIST_DIR = "dist";
export const DB_PATH = "dist/kanji.db";
export const META_PATH = "dist/meta.json";
