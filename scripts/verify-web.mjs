/**
 * End-to-end smoke test of the offline web app, driving the installed Chrome
 * (headless) against the local https server. Verifies the real pipeline:
 * sqlite-wasm boots in a worker, the 287 MB dictionary imports into OPFS,
 * FTS5-backed word/kanji/search lookups render CLI text, and a reload with
 * the network switched off still serves queries from OPFS + service worker.
 *
 * Run:  pnpm run web:verify   (requires web/.certs/*.pem — web:gen-cert)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8643;
const URL = `https://127.0.0.1:${PORT}/`;

const CHROME =
  process.env.CHROME_PATH
  ?? (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "/usr/bin/google-chrome");

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

const consoleLog = [];
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function waitFor(page, fn, timeoutMs, what) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}

async function runLookup(page, cmd, query) {
  await page.evaluate(([c, q]) => {
    const input = document.querySelector("#query");
    input.value = q;
    document.querySelector(`button[data-cmd="${c}"]`).click();
  }, [cmd, query]);
  try {
    await waitFor(
      page,
      () => page.evaluate((q) => {
        const first = document.querySelector("#panes .pane");
        const st = document.querySelector("#status").textContent;
        const lastRun = first?.querySelector(".pane-query")?.textContent;
        // The newest pane must be the one we just asked for (queries are serialized).
        return first && lastRun === q && !st.startsWith("starting") ? { text: first.querySelector("pre")?.textContent ?? "", err: first.classList.contains("error"), q: lastRun } : null;
      }, query),
      30000,
      "lookup result",
    );
  } catch (e) {
    const diag = await page.evaluate(() => ({
      status: document.querySelector("#status")?.textContent ?? "",
      panes: document.querySelectorAll("#panes .pane").length,
    }));
    throw new Error(`${e.message} | status=${diag.status} panes=${diag.panes} | console:\n${consoleLog.join("\n") || "(none)"}`);
  }
  const pane = await page.evaluate(() => {
    const first = document.querySelector("#panes .pane");
    return {
      text: first.querySelector("pre")?.textContent ?? "",
      isError: first.classList.contains("error"),
      query: first.querySelector(".pane-query")?.textContent ?? "",
    };
  });
  return pane;
}

async function main() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--ignore-certificate-errors", "--window-size=420,900"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error" || m.type() === "warn") consoleLog.push(`${m.type()}: ${t}`);
    });
    page.on("pageerror", (e) => consoleLog.push(`pageerror: ${e.message}`));

    console.log("→ first visit (imports dictionary into OPFS)…");
    await page.goto(URL, { waitUntil: "load", timeout: 60000 });
    const statusText = await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready") ? s : null;
      }),
      180000,
      "worker ready (dictionary import)",
    );
    check("engine ready, dictionary in OPFS", statusText.includes("ready"), statusText);
    check("word count reported", /ready — \d/.test(statusText), statusText.split("ready")[1]?.trim());

    // word
    let p = await runLookup(page, "word", "食べる");
    check("word 食べる shows senses", p.text.includes("1. to eat") && p.text.includes("[たべる]"), `err=${p.isError}`);
    // kanji (page)
    p = await runLookup(page, "kanji", "食");
    check("kanji 食 page renders", p.text.includes("strokes") && p.text.includes("On:") && p.text.includes("eat"), "kanji page");
    // kanji (reading search)
    p = await runLookup(page, "kanji", "makase");
    check("kanji reading search hits", p.text.includes("任") || p.text.includes("委"), p.text.slice(0, 60));
    // search romaji readings
    p = await runLookup(page, "search", "taberu");
    check("search taberu → Readings", p.text.includes("Readings") && p.text.includes("食べる"), "search taberu");
    // search english meanings
    p = await runLookup(page, "search", "eat");
    check("search eat → Meanings", p.text.includes("Meanings") && p.text.includes("to eat"), "search eat");
    // thesaurus
    p = await runLookup(page, "word", "暑い");
    check("word 暑い thesaurus/antonyms", p.text.includes("Antonyms") && p.text.includes("寒い"), "thesaurus");
    // error path (no entry)
    p = await runLookup(page, "word", "zzzznotaword");
    check("unknown word shows error pane", p.isError && p.text.includes("no entry"), p.text);
    await waitFor(page, () => page.$$eval("#panes .pane", (els) => els.length).then((n) => n >= 7), 15000, "7 panes");
    check("panes newest-first (7 panes)", (await page.$$eval("#panes .pane", (els) => els.length)) === 7, "history growing");

    // offline: reload with network disabled — shell comes from the service
    // worker, the dictionary from OPFS.
    console.log("→ offline reload…");
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "load", timeout: 30000 });
    const offStatus = await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready") ? s : null;
      }),
      60000,
      "offline ready",
    );
    check("offline: app boots from cache/OPFS", !!offStatus, offStatus);
    p = await runLookup(page, "word", "食べる");
    check("offline: query still works", p.text.includes("1. to eat"), `err=${p.isError}`);
    await page.setOfflineMode(false);

    // OPFS VFS logs NotFound probes for sidecar files (journals) as errors; benign.
    const realErrors = consoleLog.filter(
      (l) => !l.includes("Failed to load resource")
        && !l.includes("favicon")
        && !l.includes("opfs async-proxy")
        && !l.includes("xOpen")
        && !l.includes("OPFS xGetLastError")
        && !l.includes("deprecated"),
    );
    check("no console/page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verification failed:", err.message);
  process.exit(1);
});
