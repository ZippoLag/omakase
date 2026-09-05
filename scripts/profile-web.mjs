/**
 * Lookup profiler: drives the real web app in headless Chrome and measures how
 * long each section of a lookup actually takes inside the WASM worker, so the
 * per-operation progress floors can be sized from evidence rather than guess.
 *
 * Whole-operation wall time (click → idle) is always measured from the page.
 * Per-section breakdowns need a temporary probe: attach per-section wall ms to
 * each result (a perfMarks array in web/app/commands.ts + a `perf` field on
 * the worker's result message) and stash it in main.ts as
 * `window.__omakasePerf`. Without the probe the section columns are empty and
 * only the whole-op times print.
 *
 * The Chrome profile is persistent (a fixed temp dir), so the 289 MB
 * dictionary imports into OPFS once — run `--phase boot` first (a run that
 * just boots the app and exits), then the full battery boots in seconds.
 *
 * Run:
 *   node scripts/profile-web.mjs --phase boot      # first run: import + boot
 *   node scripts/profile-web.mjs                   # the timing battery
 *   node scripts/profile-web.mjs --throttle=4      # low-end-CPU projection
 *   (requires web/.certs/*.pem — web:gen-cert — and a web:build)
 */
import { spawn } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8644;
const URL = `https://127.0.0.1:${PORT}/`;
const PHASE = process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "battery";
const THROTTLE = Number(process.argv.find((a) => a.startsWith("--throttle="))?.split("=")[1] ?? 0);
// Only run cases whose label contains this substring (e.g. --filter=word).
const FILTER = process.argv.find((a) => a.startsWith("--filter="))?.split("=")[1] ?? "";

const CHROME =
  process.env.CHROME_PATH
  ?? (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google Chrome\\Application\\chrome.exe"
      : "/usr/bin/google-chrome");

// Persistent profile so the dictionary import happens only on the very first run.
const PROFILE = join(tmpdir(), "omakase-web-profile");

/** Unbuffered logging — progress is visible even when the run is killed. */
function log(msg) {
  writeSync(1, `${msg}\n`);
}

function startServer() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(root, "scripts", "serve-web.mjs"), "--port", String(PORT), "--host", "127.0.0.1"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("serving")) res(child);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (code) => rej(new Error(`server exited ${code}`)));
    setTimeout(() => rej(new Error("server start timeout")), 10000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, timeoutMs, what, intervalMs = 50) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Run one lookup; returns whole-op wall ms + the worker's per-section marks. */
async function timedLookup(page, cmd, query, max) {
  const before = await page.$$eval("#panes .pane", (els) => els.length);
  const t0 = Date.now();
  await page.evaluate(([c, q, m]) => {
    const input = document.querySelector("#query");
    input.value = q;
    if (m && m !== 30) document.querySelector("#max").value = String(m);
    document.querySelector(`button[data-cmd="${c}"]`).click();
  }, [cmd, query, max]);
  try {
    await waitFor(
      page,
      () => page.evaluate(([c, q, b]) => {
        const els = [...document.querySelectorAll("#panes .pane")];
        if (els.length < b + 1) return null;
        const busy = document.querySelector("#lookup").hasAttribute("aria-busy");
        const first = els[0];
        if (busy) return null;
        const badge = first.querySelector(".badge")?.textContent;
        const qry = first.querySelector(".pane-query")?.textContent;
        // The newest pane must be ours and the queue fully drained.
        if (badge !== c || qry !== q) return null;
        const err = first.classList.contains("error");
        return err ? { error: first.querySelector("pre")?.textContent ?? "" } : true;
      }, [cmd, query, before]),
      120000,
      `lookup ${cmd} ${query}`,
    );
  } catch (e) {
    throw new Error(`${e.message} (${cmd} ${query})`);
  }
  const totalMs = Date.now() - t0;
  const probe = await page.evaluate(() => {
    const p = window.__omakasePerf;
    return p ? { id: p.id, perf: p.perf } : null;
  });
  return { totalMs, marks: probe?.perf ?? null };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// [label, command, query, max] — spread over typical + worst-case inputs per
// command: common words (big example scans), a kanji with many compounds, and
// gloss searches whose FTS pools are large.
const CASES = [
  ["word 食べる", "word", "食べる", 30],
  ["word 走る", "word", "走る", 30],
  ["word 水", "word", "水", 30],
  ["word 暑い", "word", "暑い", 30],
  ["kanji 食", "kanji", "食", 30],
  ["kanji 木", "kanji", "木", 30],
  ["kanji 喰", "kanji", "喰", 30],
  ["kanji たべ (reading)", "kanji", "たべ", 30],
  ["search taberu", "search", "taberu", 30],
  ["search たべ", "search", "たべ", 30],
  ["search eat", "search", "eat", 30],
  ["search water", "search", "water", 30],
  ["search develop", "search", "develop", 30],
  ["search the", "search", "the", 30],
  ["search to (max 100)", "search", "to", 100],
  ["search eat (max 100)", "search", "eat", 100],
];

function fmt(ms) {
  return ms < 10 ? ms.toFixed(1) : `${Math.round(ms)}`;
}

async function main() {
  if (!existsSync(join(root, "dist", "kanji.db"))) {
    log("dist/kanji.db missing — run web:build / build:db first");
    process.exit(1);
  }
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    userDataDir: PROFILE,
    args: ["--no-sandbox", "--disable-gpu", "--ignore-certificate-errors", "--window-size=420,900"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
    if (THROTTLE) await page.emulateCPUThrottling(THROTTLE);
    log(`→ ${PHASE} phase, throttle=${THROTTLE || 1} — opening app…`);
    await page.goto(URL, { waitUntil: "load", timeout: 60000 });
    const bootStart = Date.now();
    await waitFor(
      page,
      () => page.evaluate(() => (document.querySelector("#status")?.textContent ?? "").startsWith("ready")),
      THROTTLE ? 600000 : 240000,
      "worker ready (first run imports the dictionary into OPFS)",
    );
    log(`   ready in ${((Date.now() - bootStart) / 1000).toFixed(1)} s`);
    if (PHASE === "boot") return;

    // The persistent profile's service worker may serve stale bundles from an
    // earlier build's cache — unregister it and clear the caches, then reload
    // once so every further request hits the freshly built dist on the wire.
    await page.evaluate(() =>
      navigator.serviceWorker.getRegistrations().then((rs) =>
        Promise.all(rs.map((r) => r.unregister()))
      ).then(() =>
        caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
      )
    );
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await waitFor(
      page,
      () => page.evaluate(() => (document.querySelector("#status")?.textContent ?? "").startsWith("ready")),
      120000,
      "re-ready after service-worker reset",
    );
    log("   service worker reset — measuring fresh bundles");

    const rows = [];
    for (const [label, cmd, query, max] of CASES) {
      if (FILTER && !label.includes(FILTER)) continue;
      // One warm run (JIT + page cache for kanji.db), then several measured.
      await timedLookup(page, cmd, query, max).catch((e) => log(`   ! warm failed: ${e.message}`));
      const totals = [];
      const byMark = new Map(); // label -> ms[]
      for (let i = 0; i < 3; i++) {
        const r = await timedLookup(page, cmd, query, max);
        totals.push(r.totalMs);
        for (const m of r.marks ?? []) {
          if (!byMark.has(m.label)) byMark.set(m.label, []);
          byMark.get(m.label).push(m.ms);
        }
      }
      const marks = [...byMark.entries()].map(([label, xs]) => ({ label, ms: median(xs) }));
      const workerSum = marks.reduce((a, m) => a + m.ms, 0);
      rows.push({ label, total: median(totals), marks, workerSum });
      const parts = marks.map((m) => `${m.label}=${fmt(m.ms)}`).join("  ");
      log(
        `${label.padEnd(24)} op ${fmt(median(totals)).padStart(6)} ms  worker Σ ${fmt(workerSum).padStart(6)} ms  | ${parts}`,
      );
    }

    log("\n── section share of worker time ──");
    for (const r of rows) {
      if (r.workerSum <= 0) continue;
      const shares = r.marks
        .map((m) => `${m.label} ${((100 * m.ms) / r.workerSum).toFixed(1)}%`)
        .join(", ");
      log(`${r.label.padEnd(24)} ${shares}`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

void main();
