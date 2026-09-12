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
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAll, fetchFile } from "./fetch.js";
import { LICENSES_SUMMARY } from "./licenses.js";
import { loadFurigana, loadJmdict, loadKanjidic2, loadKanjivg, loadKradfile, loadRadkfile, RELEASE_TAG } from "./parse.js";
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
  KANJIVG_ASSET,
  KANJIVG_RELEASE,
  KANJIVG_SHA256,
  KANJIVG_SOURCE,
  KANJIVG_URL,
  STROKES_DIR,
} from "./config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Stamp this build: bump the version counter (scripts/version.mjs) and report
 * the new version before anything else, so the DB records this build's stamp.
 * Degrades gracefully (version "unknown") if stamping fails — the dictionary
 * itself is still built.
 */
function stampBuild(): Record<string, string | number> {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "version.mjs"), "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status === 0 && r.stdout) {
    try {
      const v = JSON.parse(r.stdout) as Record<string, string | number>;
      console.log("building %s", v.line as string);
      return v;
    } catch { /* fall through */ }
  }
  console.log("building omakase (unknown version — stamping failed)");
  return {};
}

const force = process.argv.includes("--force");

async function main(): Promise<void> {
  const v = stampBuild();
  console.log("fetching sources (release %s)%s", RELEASE_TAG, force ? " [force]" : "");
  const blobs = await fetchAll(force);

  const jmdict = loadJmdict(blobs.get(ASSETS[0]!.name)!);
  const kanjidic2 = loadKanjidic2(blobs.get(ASSETS[1]!.name)!);
  const kradfile = loadKradfile(blobs.get(ASSETS[2]!.name)!);
  const radkfile = loadRadkfile(blobs.get(ASSETS[3]!.name)!);
  const furigana = loadFurigana(blobs.get(FURIGANA_ASSET)!);
  // Stroke-order SVGs (KanjiVG main zip) — a separate repo/release from the
  // jmdict-simplified assets above, so it fetches through its own URL.
  const kanjivg = loadKanjivg(await fetchFile(KANJIVG_ASSET, KANJIVG_URL, KANJIVG_SHA256, force));

  console.log("parsed: %d words, %d kanji, %d radicals, %d furigana pairs",
    jmdict.words.length, kanjidic2.characters.length, Object.keys(radkfile.radicals).length, furigana.length);
  console.log("kanjivg: %d svg files (%s)", kanjivg.length, KANJIVG_RELEASE);

  console.log("transforming…");
  const rows = transform(jmdict, kanjidic2, kradfile, radkfile, furigana);

  // Stroke order rows: every KanjiVG svg whose codepoint matches a kanji in
  // the dictionary. Kept out of transform() because the svg files are loose
  // assets, not DB rows — the DB only indexes them.
  const kanjiSet = new Set(rows.kanji.map((k) => k.literal));
  const strokes = kanjivg.filter((e) => kanjiSet.has(e.literal));
  console.log("stroke_order: %d kanji have a stroke svg (of %d in the kanji table)",
    strokes.length, rows.kanji.length);

  console.log("building %s…", "dist/kanji.db");
  const db = buildDb(rows, {
    source: "scriptin/jmdict-simplified",
    release: RELEASE_TAG,
    dict_date: jmdict.dictDate,
    kanjidic_db: kanjidic2.databaseVersion,
    tags: JSON.stringify(jmdict.tags), // POS tag -> description map (CLI display)
    // License / attribution provenance (see LICENSE.md for the full texts).
    licenses: LICENSES_SUMMARY,
    // Version stamp of this build (`omakase --version` and the web ready
    // status read the `version` key; the rest is structured provenance).
    version: String(v.versionFull ?? "unknown"),
    app_version: String(v.version ?? ""),
    build: String(v.build ?? ""),
    commits: String(v.commits ?? ""),
    commit: String(v.commit ?? ""),
  });

  // stroke_order index rows + the loose svg files under dist/strokes/.
  const insertStroke = db.prepare("INSERT INTO stroke_order (kanji, svg_file) VALUES (?, ?)");
  const strokeTx = db.transaction(() => {
    for (const s of strokes) insertStroke.run(s.literal, s.file);
  });
  strokeTx();
  mkdirSync(STROKES_DIR, { recursive: true });
  for (const s of strokes) {
    writeFileSync(join(STROKES_DIR, s.file), s.text);
  }
  db.close();
  const summary = summarize(rows, statSync(DB_PATH).size);
  summary.strokes = strokes.length;

  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(META_PATH, JSON.stringify({
    source: "scriptin/jmdict-simplified",
    release: RELEASE_TAG,
    dictDate: jmdict.dictDate,
    kanjidicDatabaseVersion: kanjidic2.databaseVersion,
    furigana: { source: FURIGANA_SOURCE, release: FURIGANA_RELEASE },
    strokes: { source: KANJIVG_SOURCE, release: KANJIVG_RELEASE, count: strokes.length },
    licenses: LICENSES_SUMMARY,
    version: v.versionFull ?? null,
    build: v.build ?? null,
    commit: v.commit ?? null,
    builtAt: new Date().toISOString(),
    counts: summary,
    assets: ASSETS.map((a) => ({ name: a.name, sha256: a.sha256 })),
  }, null, 2) + "\n");

  console.log("done: dist/kanji.db (" + (summary.dbBytes / 1e6).toFixed(1) + " MB)");
  console.log("  words=%d writings=%d senses=%d glosses=%d", summary.words, summary.writings, summary.senses, summary.glosses);
  console.log("  kanji=%d readings=%d meanings=%d nanori=%d", summary.kanji, summary.kanjiReadings, summary.kanjiMeanings, summary.kanjiNanori);
  console.log("  radicals=%d kanji_radicals=%d kanji_words=%d conjugations=%d",
    summary.radicals, summary.kanjiRadicals, summary.kanjiWords, summary.conjugations);
  console.log("  stroke_order=%d (KanjiVG %s)", summary.strokes, KANJIVG_RELEASE);
  console.log("  furigana=%d (JmdictFurigana %s)", summary.furigana, FURIGANA_RELEASE);
  console.log("  thesaurus_links=%d", summary.thesaurusLinks);
  const linkBreakdown = new Map<string, number>();
  for (const l of rows.thesaurusLinks) {
    const key = `${l.kind}/${l.source}`;
    linkBreakdown.set(key, (linkBreakdown.get(key) ?? 0) + 1);
  }
  console.log("    by kind/source: %s", [...linkBreakdown].sort()
    .map(([k, n]) => `${k}=${n}`).join(", "));
  console.log("    words with a relation: %d", new Set(rows.thesaurusLinks.map((l) => l.from_word)).size);
  const conjugatedWordIds = new Set(rows.conjugations.map((c) => c.word_id));
  console.log("  (conjugation tables generated for %d words)",
    rows.words.filter((w) => conjugatedWordIds.has(w.id)).length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
