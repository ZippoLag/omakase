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

    // default command highlight is search (before anything is clicked)
    const hl = await page.evaluate(() => {
      const p = (c) => document.querySelector(`button[data-cmd="${c}"]`).classList.contains("primary");
      return { search: p("search"), word: p("word"), kanji: p("kanji") };
    });
    check("default highlight is search", hl.search && !hl.word && !hl.kanji, JSON.stringify(hl));

    // the "max" box: a small number input on the same line as the query,
    // defaulting to 30
    const maxBox = await page.evaluate(() => {
      const el = document.querySelector("#max");
      return { exists: !!el, type: el?.type, value: el?.value };
    });
    check("max box: number input, default 30", maxBox.exists && maxBox.type === "number" && maxBox.value === "30", JSON.stringify(maxBox));

    // busy state while a query is in flight: pressed button shows a spinner
    // and is disabled; other buttons and the input are disabled too.
    const busy = await page.evaluate(() => {
      const input = document.querySelector("#query");
      input.value = "eat";
      document.querySelector('button[data-cmd="search"]').click(); // listener runs synchronously
      const pressed = document.querySelector('button[data-cmd="search"]');
      return {
        pressedDisabled: pressed.disabled,
        spinner: !!pressed.querySelector(".spinner"),
        label: pressed.textContent.trim(),
        othersDisabled: [...document.querySelectorAll("button[data-cmd]")]
          .filter((b) => b !== pressed).every((b) => b.disabled),
        inputDisabled: input.disabled,
        ariaBusy: document.querySelector("#lookup").getAttribute("aria-busy"),
      };
    });
    check("busy: pressed button disabled + spinner", busy.pressedDisabled && busy.spinner && busy.label === "", JSON.stringify(busy));
    check("busy: other buttons + input disabled", busy.othersDisabled && busy.inputDisabled && busy.ariaBusy === "true", JSON.stringify(busy));
    let p = await runLookup(page, "search", "eat");
    check("busy lookup still returns result", p.text.includes("Meanings"), `err=${p.isError}`);
    const idle = await page.evaluate(() => {
      const s = document.querySelector('button[data-cmd="search"]');
      return {
        disabledNow: s.disabled,
        spinnerGone: !s.querySelector(".spinner"),
        label: s.textContent.trim(),
        othersEnabled: [...document.querySelectorAll("button[data-cmd]")].every((b) => !b.disabled),
        inputEnabled: !document.querySelector("#query").disabled,
        ariaBusy: document.querySelector("#lookup").hasAttribute("aria-busy"),
      };
    });
    check(
      "idle: spinner replaced + controls re-enabled",
      !idle.disabledNow && idle.spinnerGone && idle.label === "search" && idle.othersEnabled && idle.inputEnabled && !idle.ariaBusy,
      JSON.stringify(idle),
    );

    // Enter runs the default (search) command
    await page.evaluate(() => {
      const input = document.querySelector("#query");
      input.value = "taberu";
      document.querySelector("#lookup").requestSubmit();
    });
    const enterPane = await waitFor(
      page,
      () => page.evaluate(() => {
        const first = document.querySelector("#panes .pane");
        const qry = first?.querySelector(".pane-query")?.textContent;
        return first && qry === "taberu"
          ? { badge: first.querySelector(".badge")?.textContent, text: first.querySelector("pre")?.textContent ?? "" }
          : null;
      }),
      30000,
      "enter search result",
    );
    check(
      "Enter runs default search command",
      enterPane?.badge === "search" && enterPane.text.includes("Readings") && enterPane.text.includes("食べる"),
      JSON.stringify(enterPane),
    );

    // word
    p = await runLookup(page, "word", "食べる");
    check("word 食べる shows senses", p.text.includes("1. to eat") && p.text.includes("[たべる]"), `err=${p.isError}`);
    // highlight follows the last clicked command
    const hl2 = await page.evaluate(() => {
      const p2 = (c) => document.querySelector(`button[data-cmd="${c}"]`).classList.contains("primary");
      return { word: p2("word"), search: p2("search") };
    });
    check("highlight follows clicked command", hl2.word && !hl2.search, JSON.stringify(hl2));
    // kanji (page)
    p = await runLookup(page, "kanji", "食");
    check("kanji 食 page renders", p.text.includes("strokes") && p.text.includes("On:") && p.text.includes("eat"), "kanji page");
    // kanji (reading search)
    p = await runLookup(page, "kanji", "makase");
    check("kanji reading search hits", p.text.includes("任") || p.text.includes("委"), p.text.slice(0, 60));
    // multi-kanji: 制作者 = ranked Words section (all three kanji first),
    // then one page per character identical to looking each up alone
    const kanjiParts = [];
    for (const ch of ["制", "作", "者"]) {
      kanjiParts.push((await runLookup(page, "kanji", ch)).text);
    }
    p = await runLookup(page, "kanji", "制作者");
    const wordsFirst = /^Words \(\d+\):\n  制作者  \[/.test(p.text);
    check(
      "multi-kanji: ranked Words section first, then one page per character",
      wordsFirst && p.text.includes("制作者  [") && kanjiParts.every((t) => p.text.includes(t))
        && p.text.endsWith(kanjiParts[2]),
      `${p.text.length}B singles=${kanjiParts.map((t) => t.length).join(",")}B`,
    );
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

    // the max box drives the caps end-to-end
    await page.evaluate(() => { document.querySelector("#max").value = "3"; });
    p = await runLookup(page, "kanji", "食");
    check("max=3 caps kanji compounds", p.text.includes("… and "), p.text.slice(0, 80));
    await page.evaluate(() => { document.querySelector("#max").value = "5"; });
    p = await runLookup(page, "search", "eat");
    check("max=5 caps search sections", p.text.includes("… and "), p.text.slice(0, 80));
    await page.evaluate(() => { document.querySelector("#max").value = "30"; });

    await waitFor(page, () => page.$$eval("#panes .pane", (els) => els.length).then((n) => n >= 15), 15000, "15 panes");
    check("panes newest-first (15 panes)", (await page.$$eval("#panes .pane", (els) => els.length)) === 15, "history growing");

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
