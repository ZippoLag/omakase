/**
 * Conjugation engine validation (conjugation-engine.md §7.2).
 *
 * Runs the engine over every table in jkindrix/japanese-language-data's
 * conjugations.json (3,511 tables) AND the [G] gap-class fixtures under
 * tests/fixtures/conjugations/ (bare ある, suru noun 食事, vz 感ずる, plus one
 * fixture per class with no upstream rows — vs-c 死す, vs-s 愛する, v5uru 覆う
 * [synthetic], vs-a 検討 [synthetic] — and the upstream-verified pinned
 * tables), diffing `forms` (kana) and `display_forms` per entry, reporting
 * pass rate by class.
 *
 * The upstream download is pinned by sha256 and cached in data/raw/. The [G]
 * fixtures carry a `provenance` field marking them as our engine-generated
 * expected values (no upstream ground truth exists for those classes).
 *
 *   pnpm run validate:conjugations
 *
 * Output: console summary + dist/conjugation-validation.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conjugateReading, type ConjClass } from "../../src/conjugation.js";

const URL = "https://raw.githubusercontent.com/jkindrix/japanese-language-data/main/data/grammar/conjugations.json";
const SHA256 = "95b434beaebf66f8e454c6c3972b585ad992ea403d9a3765137d562669566c3a";
// Committed, sha-pinned snapshot of the upstream file (underscore-prefixed so
// the gap-fixture loader below skips it). Kept in fixtures so CI validates
// fully offline and always checks against the exact data it was pinned to.
const PINNED = join("tests", "fixtures", "conjugations", "_upstream-conjugations.json");
// Disposable download cache used only when the committed snapshot is absent.
const CACHE = join("data", "raw", "conjugations-upstream.json");
const FIXTURES_DIR = join("tests", "fixtures", "conjugations");
const REPORT = join("dist", "conjugation-validation.json");

interface TableEntry {
  id: string;
  dictionary_form: string;
  reading: string;
  class: string;
  forms: Record<string, string>;
  display_forms: Record<string, string>;
  /** present on [G] gap fixtures and the upstream-verified pinned tables */
  provenance?: string;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function loadUpstream(): Promise<TableEntry[]> {
  // Prefer the committed snapshot so CI never touches the network; fall back
  // to a cached download, then to a fresh (verified) download into data/raw.
  for (const path of [PINNED, CACHE]) {
    if (existsSync(path) && sha256(readFileSync(path)) === SHA256) {
      console.log(`using ${path} (sha256 verified)`);
      return (JSON.parse(readFileSync(path, "utf-8")) as { entries: TableEntry[] }).entries;
    }
  }
  console.log("downloading upstream conjugations.json…");
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== SHA256) throw new Error(`sha256 mismatch: expected ${SHA256}, got ${got}`);
  mkdirSync(join("data", "raw"), { recursive: true });
  writeFileSync(CACHE, buf);
  return (JSON.parse(buf.toString("utf-8")) as { entries: TableEntry[] }).entries;
}

/** [G] gap-class + pinned tables from tests/fixtures/conjugations/*.json */
function loadGapFixtures(): TableEntry[] {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  return files.map((f) => JSON.parse(
    readFileSync(join(FIXTURES_DIR, f), "utf-8"),
  ) as TableEntry);
}

interface Mismatch {
  id: string;
  dictionary_form: string;
  reading: string;
  class: string;
  kana: { form: string; expected: string; got: string }[];
  display: { form: string; expected: string; got: string }[];
}

interface ClassStats {
  total: number;
  pass: number;
  mismatches: Mismatch[];
  skipped: number;
}

function diffEntry(entry: TableEntry): { pass: boolean; kana: Mismatch["kana"]; display: Mismatch["display"] } | "skipped" {
  const table = conjugateReading(entry.reading, entry.class as ConjClass, entry.dictionary_form);
  if (!table) return "skipped";

  const kana: Mismatch["kana"] = [];
  const keys = new Set([...Object.keys(entry.forms), ...Object.keys(table.forms)]);
  for (const form of keys) {
    const expected = entry.forms[form] ?? "";
    const got = table.forms[form] ?? "";
    if (expected !== got) kana.push({ form, expected, got });
  }
  const display: Mismatch["display"] = [];
  for (const form of keys) {
    const expected = entry.display_forms[form] ?? "";
    const got = table.displayForms[form] ?? "";
    if (expected !== got) display.push({ form, expected, got });
  }
  return { pass: kana.length === 0 && display.length === 0, kana, display };
}

interface RunResult {
  byClass: Map<string, ClassStats>;
  total: number;
  pass: number;
  skipped: number;
  mismatches: number;
  entries: TableEntry[];
}

function runValidation(entries: TableEntry[]): RunResult {
  const byClass = new Map<string, ClassStats>();
  let totalPass = 0;
  let skipped = 0;

  for (const entry of entries) {
    const stats = byClass.get(entry.class) ?? { total: 0, pass: 0, mismatches: [], skipped: 0 };
    stats.total++;
    const result = diffEntry(entry);
    if (result === "skipped") {
      stats.skipped++;
      skipped++;
    } else if (result.pass) {
      stats.pass++;
      totalPass++;
    } else {
      stats.mismatches.push({
        id: entry.id,
        dictionary_form: entry.dictionary_form,
        reading: entry.reading,
        class: entry.class,
        kana: result.kana,
        display: result.display,
      });
    }
    byClass.set(entry.class, stats);
  }

  return {
    byClass,
    total: entries.length,
    pass: totalPass,
    skipped,
    mismatches: entries.length - totalPass - skipped,
    entries,
  };
}

function printSummary(label: string, r: RunResult): void {
  console.log(`\n${label} — pass: ${r.pass}/${r.total} (${(100 * r.pass / r.total).toFixed(2)}%), mismatches: ${r.mismatches}, skipped: ${r.skipped}`);
  console.log("by class:");
  for (const [cls, s] of [...r.byClass.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const pct = s.total ? (100 * s.pass / s.total).toFixed(1) : "—";
    console.log(`  ${cls.padEnd(7)} ${String(s.total).padStart(5)} total, ${String(s.pass).padStart(5)} pass (${pct}%), ${String(s.mismatches.length).padStart(2)} mismatch, ${String(s.skipped).padStart(2)} skipped`);
  }
}

function printSamples(r: RunResult, limit = 8): void {
  const sample = [...r.byClass.values()].flatMap((s) => s.mismatches).slice(0, limit);
  if (sample.length === 0) return;
  console.log("\nsample mismatches:");
  for (const m of sample) {
    console.log(`  ${m.dictionary_form} [${m.reading}] (${m.class}, id ${m.id})`);
    for (const d of [...m.kana, ...m.display].slice(0, 4)) {
      console.log(`    ${d.form}: expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.got)}`);
    }
  }
}

async function main(): Promise<void> {
  const upstream = await loadUpstream();
  const gaps = loadGapFixtures();

  const run1 = runValidation(upstream);
  printSummary("upstream tables (" + upstream.length + ")", run1);
  printSamples(run1);

  const gapGrouped = runValidation(gaps);
  printSummary("fixture gap tables (" + gaps.length + ")", gapGrouped);
  printSamples(gapGrouped);

  // Combined totals for the report
  const combined = runValidation([...upstream, ...gaps]);
  const totalPass = combined.pass;
  const total = combined.total;
  const mismatchCount = combined.mismatches;
  const skipped = combined.skipped;
  console.log(`\nTOTAL (upstream + gap fixtures): pass ${totalPass}/${total} (${(100 * totalPass / total).toFixed(2)}%), mismatches ${mismatchCount}, skipped ${skipped}`);

  mkdirSync("dist", { recursive: true });
  const classify = (e: TableEntry): "upstream" | "fixture" =>
    e.provenance ? "fixture" : "upstream";

  writeFileSync(REPORT, JSON.stringify({
    upstream: "jkindrix/japanese-language-data data/grammar/conjugations.json",
    upstreamSha256: SHA256,
    upstreamSource: PINNED,
    gapFixtures: join("tests", "fixtures", "conjugations") + "/*.json (body equals engine output; see provenance field)",
    runAt: new Date().toISOString(),
    totals: { total, pass: totalPass, mismatches: mismatchCount, skipped },
    upstreamResult: {
      total: run1.total, pass: run1.pass, mismatches: run1.mismatches, skipped: run1.skipped,
      byClass: Object.fromEntries([...run1.byClass.entries()].map(([k, v]) => [k, {
        total: v.total, pass: v.pass, skipped: v.skipped,
        mismatchSample: v.mismatches.slice(0, 20),
      }])),
    },
    gapFixtureResult: {
      total: gapGrouped.total, pass: gapGrouped.pass, mismatches: gapGrouped.mismatches, skipped: gapGrouped.skipped,
      byClass: Object.fromEntries([...gapGrouped.byClass.entries()].map(([k, v]) => [k, {
        total: v.total, pass: v.pass, skipped: v.skipped,
        mismatchSample: v.mismatches.slice(0, 20),
      }])),
    },
    entriesBySource: Object.fromEntries([...combined.byClass.entries()].map(([k, v]) => [k, {
      total: v.total,
      sources: [...new Set(combined.entries.filter((e) => e.class === k).map((e) => classify(e)))],
    }])),
  }, null, 2) + "\n");
  console.log(`\nreport written to ${REPORT}`);

  // The validation is a CI gate: any mismatch between the engine and the
  // pinned upstream tables fails the run (the report above has the details).
  if (combined.mismatches > 0) {
    console.error(`FAIL: ${combined.mismatches} conjugation mismatch(es) — see ${REPORT}`);
    process.exit(1);
  }
  if (combined.skipped > 0) {
    console.error(`WARN: ${combined.skipped} table(s) skipped (engine produced no table)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});