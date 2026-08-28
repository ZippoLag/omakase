/**
 * Conjugation engine validation (conjugation-engine.md §7.2).
 *
 * Runs the engine over all 3,511 tables in jkindrix/japanese-language-data's
 * conjugations.json and diffs `forms` (kana) and `display_forms` per entry,
 * reporting pass rate by class. Download is pinned by sha256 and cached in
 * data/raw/.
 *
 *   npm run validate:conjugations
 *
 * Output: console summary + dist/conjugation-validation.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conjugateReading, type ConjClass } from "../../src/conjugation.js";

const URL = "https://raw.githubusercontent.com/jkindrix/japanese-language-data/main/data/grammar/conjugations.json";
const SHA256 = "95b434beaebf66f8e454c6c3972b585ad992ea403d9a3765137d562669566c3a";
const CACHE = join("data", "raw", "conjugations-upstream.json");
const REPORT = join("dist", "conjugation-validation.json");

interface UpstreamEntry {
  id: string;
  dictionary_form: string;
  reading: string;
  class: string;
  forms: Record<string, string>;
  display_forms: Record<string, string>;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function loadUpstream(): Promise<UpstreamEntry[]> {
  if (!existsSync(CACHE) || sha256(readFileSync(CACHE)) !== SHA256) {
    console.log("downloading upstream conjugations.json…");
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== SHA256) throw new Error(`sha256 mismatch: expected ${SHA256}, got ${got}`);
    mkdirSync(join("data", "raw"), { recursive: true });
    writeFileSync(CACHE, buf);
  }
  const data = JSON.parse(readFileSync(CACHE, "utf-8")) as { entries: UpstreamEntry[] };
  return data.entries;
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

function diffEntry(entry: UpstreamEntry): { pass: boolean; kana: Mismatch["kana"]; display: Mismatch["display"] } | "skipped" {
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

async function main(): Promise<void> {
  const entries = await loadUpstream();
  console.log(`validating engine against ${entries.length} upstream tables…`);

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

  const mismatchCount = entries.length - totalPass - skipped;
  console.log(`\npass: ${totalPass}/${entries.length} (${(100 * totalPass / entries.length).toFixed(2)}%), ` +
    `mismatches: ${mismatchCount}, skipped: ${skipped}\n`);
  console.log("by class:");
  for (const [cls, s] of [...byClass.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const pct = s.total ? (100 * s.pass / s.total).toFixed(1) : "—";
    console.log(`  ${cls.padEnd(7)} ${String(s.total).padStart(5)} total, ${String(s.pass).padStart(5)} pass (${pct}%), ${String(s.mismatches.length).padStart(2)} mismatch, ${String(s.skipped).padStart(2)} skipped`);
  }

  const sample = [...byClass.values()].flatMap((s) => s.mismatches).slice(0, 8);
  if (sample.length > 0) {
    console.log("\nsample mismatches:");
    for (const m of sample) {
      console.log(`  ${m.dictionary_form} [${m.reading}] (${m.class}, id ${m.id})`);
      for (const d of [...m.kana, ...m.display].slice(0, 4)) {
        console.log(`    ${d.form}: expected ${JSON.stringify(d.expected)} got ${JSON.stringify(d.got)}`);
      }
    }
  }

  mkdirSync("dist", { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    upstream: "jkindrix/japanese-language-data data/grammar/conjugations.json",
    sha256: SHA256,
    runAt: new Date().toISOString(),
    total: entries.length,
    pass: totalPass,
    mismatches: mismatchCount,
    skipped,
    byClass: Object.fromEntries([...byClass.entries()].map(([k, v]) => [k, {
      total: v.total, pass: v.pass, skipped: v.skipped,
      mismatchSample: v.mismatches.slice(0, 20),
    }])),
  }, null, 2) + "\n");
  console.log(`\nreport written to ${REPORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
