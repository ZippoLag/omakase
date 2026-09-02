/**
 * Build pipeline entry point (M0).
 *
 *   pnpm run build:db [-- --force]     (--force re-downloads sources)
 *
 * Downloads the pinned jmdict-simplified release (sha256-verified, cached in
 * data/raw/), transforms it into the relational model from data-model.md, and
 * writes dist/kanji.db + dist/meta.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { fetchAll } from "./fetch.js";
import { loadFurigana, loadJmdict, loadKanjidic2, loadKradfile, loadRadkfile, RELEASE_TAG } from "./parse.js";
import { transform } from "./transform.js";
import { buildDb, summarize } from "./buildDb.js";
import {
  ASSETS,
  DIST_DIR,
  META_PATH,
  DB_PATH,
  FURIGANA_ASSET,
  FURIGANA_RELEASE,
  FURIGANA_SOURCE,
} from "./config.js";

const force = process.argv.includes("--force");

async function main(): Promise<void> {
  console.log("fetching sources (release %s)%s", RELEASE_TAG, force ? " [force]" : "");
  const blobs = await fetchAll(force);

  const jmdict = loadJmdict(blobs.get(ASSETS[0]!.name)!);
  const kanjidic2 = loadKanjidic2(blobs.get(ASSETS[1]!.name)!);
  const kradfile = loadKradfile(blobs.get(ASSETS[2]!.name)!);
  const radkfile = loadRadkfile(blobs.get(ASSETS[3]!.name)!);
  const furigana = loadFurigana(blobs.get(FURIGANA_ASSET)!);

  console.log("parsed: %d words, %d kanji, %d radicals, %d furigana pairs",
    jmdict.words.length, kanjidic2.characters.length, Object.keys(radkfile.radicals).length, furigana.length);

  console.log("transforming…");
  const rows = transform(jmdict, kanjidic2, kradfile, radkfile, furigana);

  console.log("building %s…", "dist/kanji.db");
  const db = buildDb(rows, {
    source: "scriptin/jmdict-simplified",
    release: RELEASE_TAG,
    dict_date: jmdict.dictDate,
    kanjidic_db: kanjidic2.databaseVersion,
    tags: JSON.stringify(jmdict.tags), // POS tag -> description map (CLI display)
  });
  db.close();
  const summary = summarize(rows, statSync(DB_PATH).size);

  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(META_PATH, JSON.stringify({
    source: "scriptin/jmdict-simplified",
    release: RELEASE_TAG,
    dictDate: jmdict.dictDate,
    kanjidicDatabaseVersion: kanjidic2.databaseVersion,
    furigana: { source: FURIGANA_SOURCE, release: FURIGANA_RELEASE },
    builtAt: new Date().toISOString(),
    counts: summary,
    assets: ASSETS.map((a) => ({ name: a.name, sha256: a.sha256 })),
  }, null, 2) + "\n");

  console.log("done: dist/kanji.db (" + (summary.dbBytes / 1e6).toFixed(1) + " MB)");
  console.log("  words=%d writings=%d senses=%d glosses=%d", summary.words, summary.writings, summary.senses, summary.glosses);
  console.log("  kanji=%d readings=%d meanings=%d nanori=%d", summary.kanji, summary.kanjiReadings, summary.kanjiMeanings, summary.kanjiNanori);
  console.log("  radicals=%d kanji_radicals=%d kanji_words=%d conjugations=%d",
    summary.radicals, summary.kanjiRadicals, summary.kanjiWords, summary.conjugations);
  console.log("  furigana=%d (JmdictFurigana %s)", summary.furigana, FURIGANA_RELEASE);
  console.log("  thesaurus_links=%d (forward + reverse + 2-hop)", summary.thesaurusLinks);
  const conjugatedWordIds = new Set(rows.conjugations.map((c) => c.word_id));
  console.log("  (conjugation tables generated for %d words)",
    rows.words.filter((w) => conjugatedWordIds.has(w.id)).length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
