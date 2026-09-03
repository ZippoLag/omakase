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
import { existsSync, readFileSync } from "node:fs";
import { versionFromStamp } from "./sw-version.mjs";
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
      // The first lookup after the OPFS import reads a cold 318 MB DB
      // (gloss FTS scoring loads hundreds of words through the async proxy
      // and can take ~40 s before the page cache warms up).
      120000,
      "lookup result",
    );
  } catch (e) {
    const diag = await page.evaluate(() => ({
      status: document.querySelector("#status")?.textContent ?? "",
      panes: document.querySelectorAll("#panes .pane").length,
      ariaBusy: document.querySelector("#lookup")?.getAttribute("aria-busy") ?? null,
      wordDisabled: document.querySelector('button[data-cmd="word"]')?.disabled ?? null,
      clearDisabled: document.querySelector("#clear")?.disabled ?? null,
    }));
    throw new Error(`${e.message} | status=${diag.status} panes=${diag.panes} ariaBusy=${diag.ariaBusy} wordDisabled=${diag.wordDisabled} clearDisabled=${diag.clearDisabled} | console:\n${consoleLog.join("\n") || "(none)"}`);
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
  // Static invariant: the served service worker's cache name must be stamped
  // with the version the served app reports (both emitted by web:build).
  const stamp = versionFromStamp(readFileSync(join(root, "dist", "src", "version.js"), "utf8"));
  const swJs = readFileSync(join(root, "dist", "sw.js"), "utf8");
  check(
    "sw.js cache name stamped with the served build version",
    !!stamp && swJs.includes(`const CACHE = "omakase-${stamp}";`),
    stamp ? `CACHE=omakase-${stamp}` : "(dist/src/version.js has no stamp — run web:build)",
  );

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
    check(
      "status reports the app version (v<ver>-build.<n>)",
      /v\d+\.\d+\.\d+-build\.\d+/.test(statusText),
      statusText.split("ready")[1]?.trim(),
    );
    const badge = await page.evaluate(() => {
      const el = document.querySelector("#version");
      return { text: el?.textContent ?? "", title: el?.getAttribute("title") ?? "" };
    });
    check(
      "header badge shows the app version and (on ready) the dictionary stamp",
      /^v\d+\.\d+\.\d+-build\.\d+/.test(badge.text) && badge.title.includes("dictionary build:"),
      JSON.stringify(badge),
    );

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
      60000,
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
    // ---- stroke-order widget --------------------------------------------
    // The kanji pane mounts a widget per page character: it fetches the
    // KanjiVG svg (dist/strokes/098df.svg for 食), renders its 9 stroke
    // paths, labels them, and enables a replay button.
    const strokeWidget = await waitFor(
      page,
      () => page.evaluate(() => {
        const pane = document.querySelector("#panes .pane:first-child");
        const fig = pane?.querySelector(".stroke-widget");
        const svg = fig?.querySelector("svg.stroke-svg");
        if (!fig || !svg) return null;
        const paths = svg.querySelectorAll("path");
        const replay = fig.querySelector(".stroke-replay");
        return paths.length > 0 && !replay.disabled
          ? { paths: paths.length, label: fig.querySelector(".stroke-label")?.textContent ?? "" }
          : null;
      }),
      30000,
      "stroke-order widget",
    );
    check(
      "kanji pane: stroke-order widget with 9 strokes + replay",
      strokeWidget?.paths === 9 && strokeWidget.label === "食 · 9 strokes",
      JSON.stringify(strokeWidget),
    );
    // replay redraws the sequence without breaking the strokes
    const replayWidget = await page.evaluate(() => {
      const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
      const before = fig.querySelectorAll("path").length;
      fig.querySelector(".stroke-replay").click();
      const after = fig.querySelectorAll("path").length;
      return { before, after };
    });
    check(
      "stroke widget replay keeps all strokes",
      replayWidget.before === 9 && replayWidget.after === 9,
      JSON.stringify(replayWidget),
    );
    // kanji (reading search)
    p = await runLookup(page, "kanji", "makase");
    check("kanji reading search hits", p.text.includes("任") || p.text.includes("委"), p.text.slice(0, 60));
    const noWidget = await page.evaluate(() =>
      !document.querySelector("#panes .pane:first-child .stroke-widget"));
    check("kanji reading search has no stroke widgets", noWidget, "list results are not kanji pages");
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
    // one stroke-order widget per page character (制・作・者)
    const multiWidgets = await waitFor(
      page,
      () => page.evaluate(() => {
        const figs = [...document.querySelectorAll("#panes .pane:first-child .stroke-widget")];
        return figs.length === 3 && figs.every((f) => f.querySelectorAll("svg path").length > 0)
          ? figs.map((f) => f.querySelector(".stroke-label")?.textContent ?? "")
          : null;
      }),
      30000,
      "multi-kanji stroke widgets",
    );
    check(
      "multi-kanji pane: one stroke widget per page character",
      Array.isArray(multiWidgets) && multiWidgets.length === 3
        && ["制", "作", "者"].every((c) => multiWidgets.some((l) => l.startsWith(`${c} ·`))),
      JSON.stringify(multiWidgets),
    );
    // search romaji readings
    p = await runLookup(page, "search", "taberu");
    check("search taberu → Readings", p.text.includes("Readings") && p.text.includes("食べる"), "search taberu");
    // a single-kanji word row (the search “Kanji” section) also gets the
    // word-lookup icon, while the writing kanji stays clickable
    const singleKanjiTok = await page.evaluate(() => {
      const pre = document.querySelector("#panes .pane:first-child pre");
      return {
        icons: [...pre.querySelectorAll(".tok-word")].map((b) => b.title),
        kanji: [...pre.querySelectorAll(".tok-kanji")].map((b) => b.textContent),
      };
    });
    check(
      "tokens: single-kanji word row has word icon + kanji button",
      singleKanjiTok.icons.includes("word 食") && singleKanjiTok.kanji.includes("食"),
      JSON.stringify({ icons: singleKanjiTok.icons, kanji: singleKanjiTok.kanji }),
    );
    // search english meanings
    p = await runLookup(page, "search", "eat");
    check("search eat → Meanings", p.text.includes("Meanings") && p.text.includes("to eat"), "search eat");
    // thesaurus
    p = await runLookup(page, "word", "暑い");
    check("word 暑い thesaurus/antonyms", p.text.includes("Antonyms") && p.text.includes("寒い"), "thesaurus");
    // error path (no entry)
    p = await runLookup(page, "word", "zzzznotaword");
    check("unknown word shows error pane", p.isError && p.text.includes("no entry"), p.text);

    // ---- clickable tokens in result panes ---------------------------------
    // Every displayed kanji is individually clickable → `kanji <ch>`;
    // dictionary words carry a word-lookup icon at their left → `word <w>`.
    p = await runLookup(page, "word", "食べる");
    const wordTok = await page.evaluate(() => {
      const pre = document.querySelector("#panes .pane:first-child pre");
      return [...pre.querySelectorAll(".tok-kanji")].map((b) => b.textContent);
    });
    check(
      "tokens: per-kanji buttons in word pane",
      wordTok.includes("食") && wordTok.every((k) => !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(k)),
      JSON.stringify(wordTok),
    );
    // the kanji page's Compounds rows are words: they get a word icon and the
    // writing kanji stay individually clickable
    p = await runLookup(page, "kanji", "食");
    const compoundTok = await page.evaluate(() => {
      const pre = document.querySelector("#panes .pane:first-child pre");
      return {
        icons: [...pre.querySelectorAll(".tok-word")].map((b) => b.title),
        kanji: [...pre.querySelectorAll(".tok-kanji")].map((b) => b.textContent),
      };
    });
    check(
      "tokens: compound rows have word icon + clickable kanji",
      compoundTok.icons.length >= 5
        && compoundTok.icons.every((t) => t.startsWith("word "))
        && compoundTok.kanji.includes("食") && compoundTok.kanji.length >= 5,
      `${compoundTok.icons.length} icons, ${compoundTok.kanji.length} kanji buttons`,
    );
    // click a word icon from the page (a real compound row) → same as typing
    // the word + pressing word
    const clickTarget = compoundTok.icons[0];
    const expectedWord = clickTarget.replace(/^word /, "");
    await page.evaluate((title) => {
      const b = [...document.querySelectorAll("#panes .pane:first-child pre .tok-word")]
        .find((x) => x.title === title);
      b.click();
    }, clickTarget);
    const tokWordPane = await waitFor(
      page,
      () => page.evaluate((q) => {
        const first = document.querySelector("#panes .pane");
        return first && first.querySelector(".badge")?.textContent === "word"
          && first.querySelector(".pane-query")?.textContent === q
          ? first.querySelector("pre")?.textContent : null;
      }, expectedWord),
      30000,
      `word icon click (${expectedWord})`,
    );
    check(
      "tokens: word icon click → word pane for that compound",
      !!tokWordPane && tokWordPane.includes("Writings"),
      tokWordPane ? `${expectedWord}: ${tokWordPane.slice(0, 40)}` : "(none)",
    );
    // click the 食 kanji token → same as typing it + pressing kanji
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#panes .pane:first-child pre .tok-kanji")]
        .find((x) => x.textContent === "食");
      b.click();
    });
    const tokKanjiPane = await waitFor(
      page,
      () => page.evaluate(() => {
        const first = document.querySelector("#panes .pane");
        return first && first.querySelector(".badge")?.textContent === "kanji"
          && first.querySelector(".pane-query")?.textContent === "食"
          ? first.querySelector("pre")?.textContent : null;
      }),
      30000,
      "kanji token click",
    );
    check(
      "tokens: kanji click → kanji 食 pane",
      !!tokKanjiPane && tokKanjiPane.includes("strokes"),
      tokKanjiPane ? tokKanjiPane.slice(0, 40) : "(none)",
    );
    // multi-kanji Words row: the ranked word gets an icon, each character a button
    p = await runLookup(page, "kanji", "制作者");
    const multiTok = await page.evaluate(() => {
      const pre = document.querySelector("#panes .pane:first-child pre");
      return {
        icons: [...pre.querySelectorAll(".tok-word")].map((b) => b.title),
        kanji: [...pre.querySelectorAll(".tok-kanji")].map((b) => b.textContent),
      };
    });
    check(
      "tokens: multi-kanji Words row icon + per-char buttons",
      multiTok.icons.includes("word 制作者")
        && ["制", "作", "者"].every((c) => multiTok.kanji.includes(c)),
      JSON.stringify({ icons: multiTok.icons.slice(0, 3), kanji: [...new Set(multiTok.kanji)].slice(0, 8) }),
    );
    // click the word icon on 制作者 → `word 制作者` in the box
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#panes .pane:first-child pre .tok-word")]
        .find((x) => x.title === "word 制作者");
      b.click();
    });
    const tokSeisakusha = await waitFor(
      page,
      () => page.evaluate(() => {
        const first = document.querySelector("#panes .pane");
        return first && first.querySelector(".badge")?.textContent === "word"
          && first.querySelector(".pane-query")?.textContent === "制作者"
          ? first.querySelector("pre")?.textContent : null;
      }),
      30000,
      "word icon click (制作者)",
    );
    check(
      "tokens: word icon click → word 制作者 pane",
      !!tokSeisakusha && tokSeisakusha.includes("Writings"),
      tokSeisakusha ? tokSeisakusha.slice(0, 40) : "(none)",
    );

    // ---- queued actions: clicks during a lookup enqueue, never drop ------
    // Command buttons and inputs lock while a lookup runs, but the
    // per-character kanji and magnifier tokens inside result panes stay
    // tappable. Those clicks must queue behind the running lookup — one
    // lookup at a time — and each queued action must still get its own pane,
    // in click order, with the controls returning to an idle state after.
    const qBefore = await page.$$eval("#panes .pane", (els) => els.length);
    const busyProbe = await page.evaluate(() => {
      const input = document.querySelector("#query");
      input.value = "水";
      document.querySelector('button[data-cmd="word"]').click(); // in flight now
      // While it runs, queue a magnifier (word) click and a kanji-token click
      // behind it — both must be accepted, not dropped.
      const mag = [...document.querySelectorAll("#panes .pane pre .tok-word")]
        .find((b) => b.title === "word 制作者");
      mag?.click();
      const tok = [...document.querySelectorAll("#panes .pane pre .tok-kanji")]
        .find((b) => b.textContent === "食");
      tok?.click();
      return {
        magFound: !!mag,
        tokFound: !!tok,
        spinnerOnWord: !!document.querySelector('button[data-cmd="word"] .spinner'),
        // queue counter: word 水 is in flight, 制作者 + 食 are queued behind it
        counter: document.querySelector('button[data-cmd="word"] .queue-n')?.textContent ?? null,
        buttonsDisabled: [...document.querySelectorAll("button[data-cmd]")].every((b) => b.disabled),
        inputDisabled: input.disabled,
        ariaBusy: document.querySelector("#lookup").getAttribute("aria-busy"),
      };
    });
    check(
      "busy: tokens stay tappable while a lookup runs (spinner on word)",
      busyProbe.magFound && busyProbe.tokFound && busyProbe.spinnerOnWord
        && busyProbe.buttonsDisabled && busyProbe.inputDisabled && busyProbe.ariaBusy === "true",
      JSON.stringify(busyProbe),
    );
    check(
      "busy: queue counter shows how many panes are still to come",
      busyProbe.counter === "3",
      `counter=${busyProbe.counter}`,
    );
    // All three lookups must complete, one at a time, in click order: the
    // last-queued kanji pane lands on top, then the queued word, then the
    // word that was already running when the tokens were clicked.
    const queued = await waitFor(
      page,
      () => page.evaluate((base) => {
        const els = [...document.querySelectorAll("#panes .pane")];
        if (els.length < base + 3) return null;
        const got = els.slice(0, 3).map((p) => ({
          q: p.querySelector(".pane-query")?.textContent ?? "",
          badge: p.querySelector(".badge")?.textContent ?? "",
          error: p.classList.contains("error"),
        }));
        return got[0].q === "食" && got[1].q === "制作者" && got[2].q === "水" ? got : null;
      }, qBefore),
      60000,
      "three queued panes",
    );
    check(
      "clicks during a lookup enqueue — panes in click order, one at a time",
      queued?.length === 3
        && queued[0].badge === "kanji" && queued[1].badge === "word" && queued[2].badge === "word"
        && queued.every((p) => !p.error),
      JSON.stringify(queued),
    );
    // The queue must drain fully: spinner gone, labels restored, idle again.
    const idleAfterQueue = await page.evaluate(() => ({
      labels: [...document.querySelectorAll("button[data-cmd]")].map((b) => b.textContent.trim()),
      spinners: document.querySelectorAll("button[data-cmd] .spinner").length,
      counters: document.querySelectorAll("button[data-cmd] .queue-n").length,
      allEnabled: [...document.querySelectorAll("button[data-cmd]")].every((b) => !b.disabled),
      inputEnabled: !document.querySelector("#query").disabled,
      ariaBusy: document.querySelector("#lookup").hasAttribute("aria-busy"),
    }));
    check(
      "queue drains: spinner + counter gone, labels restored, controls re-enabled",
      idleAfterQueue.spinners === 0 && idleAfterQueue.counters === 0
        && idleAfterQueue.allEnabled && idleAfterQueue.inputEnabled && !idleAfterQueue.ariaBusy
        && idleAfterQueue.labels.join(",") === "kanji,word,search",
      JSON.stringify(idleAfterQueue),
    );

    // ---- word: comma/space-separated words look each up separately --------
    // A box holding several words (comma and/or space separated) must behave
    // exactly like pressing word on each word alone: one pane per word, each
    // byte-identical to its standalone lookup.
    const soloMizu = await runLookup(page, "word", "水");
    const soloShokuji = await runLookup(page, "word", "食事");
    const twoPanes = async (value, expectTopDown) => {
      const before = await page.$$eval("#panes .pane", (els) => els.length);
      await page.evaluate(([c, v]) => {
        const input = document.querySelector("#query");
        input.value = v;
        document.querySelector(`button[data-cmd="${c}"]`).click();
      }, ["word", value]);
      return waitFor(
        page,
        () => page.evaluate(([exp, base]) => {
          const els = [...document.querySelectorAll("#panes .pane")];
          if (els.length < base + exp.length) return null;
          const got = els.slice(0, exp.length).map((p) => ({
            q: p.querySelector(".pane-query")?.textContent ?? "",
            badge: p.querySelector(".badge")?.textContent ?? "",
            error: p.classList.contains("error"),
            text: p.querySelector("pre")?.textContent ?? "",
          }));
          return exp.every((q, i) => got[i]?.q === q) ? got : null;
        }, [expectTopDown, before]),
        60000,
        `word panes for "${value}"`,
      );
    };
    // comma + space separators: 水, 食事 → 水 then 食事 (食事 pane on top)
    let multi = await twoPanes("水, 食事", ["食事", "水"]);
    check(
      "word: comma/space box → one pane per word, equal to each standalone word",
      multi?.length === 2
        && multi.every((m) => m.badge === "word" && !m.error)
        && multi[0].text === soloShokuji.text && multi[1].text === soloMizu.text,
      JSON.stringify(multi?.map((m) => ({ q: m.q, len: m.text.length }))),
    );
    // Japanese 、 separator alone: 食事、水 → 食事 then 水 (水 pane on top)
    multi = await twoPanes("食事、水", ["水", "食事"]);
    check(
      "word: 、-separated box → one pane per word, equal to each standalone word",
      multi?.length === 2
        && multi.every((m) => m.badge === "word" && !m.error)
        && multi[0].text === soloMizu.text && multi[1].text === soloShokuji.text,
      JSON.stringify(multi?.map((m) => ({ q: m.q, len: m.text.length }))),
    );

    // repeated words are deduplicated before enqueueing: a box that names the
    // same word twice (or more) behaves exactly as if it named it once — one
    // pane, identical to the standalone lookup, and the queue drains fully.
    const dedupePanes = async (value, expectTopDown) => {
      const before = await page.$$eval("#panes .pane", (els) => els.length);
      await page.evaluate(([c, v]) => {
        const input = document.querySelector("#query");
        input.value = v;
        document.querySelector(`button[data-cmd="${c}"]`).click();
      }, ["word", value]);
      return waitFor(
        page,
        () => page.evaluate(([exp, base]) => {
          const els = [...document.querySelectorAll("#panes .pane")];
          const busy = document.querySelector("#lookup").getAttribute("aria-busy");
          if (busy || els.length < base + exp.length) return null;
          const got = els.slice(0, exp.length).map((p) => ({
            q: p.querySelector(".pane-query")?.textContent ?? "",
            badge: p.querySelector(".badge")?.textContent ?? "",
            error: p.classList.contains("error"),
            text: p.querySelector("pre")?.textContent ?? "",
          }));
          return exp.every((q, i) => got[i]?.q === q)
            ? { got, added: els.length - base, counters: document.querySelectorAll("button[data-cmd] .queue-n").length }
            : null;
        }, [expectTopDown, before]),
        60000,
        `deduped word panes for "${value}"`,
      );
    };
    let dd = await dedupePanes("水 水", ["水"]);
    check(
      "word: 水 水 dedupes to one pane, equal to the standalone 水 lookup",
      dd?.added === 1 && dd.counters === 0
        && dd.got[0].badge === "word" && !dd.got[0].error && dd.got[0].text === soloMizu.text,
      JSON.stringify(dd?.got.map((g) => ({ q: g.q, len: g.text.length }))),
    );
    // the same word three times still yields a single pane
    dd = await dedupePanes("水 水 水", ["水"]);
    check(
      "word: 水 水 水 dedupes to one pane (not three)",
      dd?.added === 1 && dd.got[0].text === soloMizu.text,
      JSON.stringify(dd?.got.map((g) => ({ q: g.q, len: g.text.length }))),
    );
    // duplicates among several words are dropped while order is kept: only the
    // first occurrence of each word is looked up (水, 水, 食事 → 食事 + 水)
    dd = await dedupePanes("水, 水, 食事", ["食事", "水"]);
    check(
      "word: 水, 水, 食事 → two panes (食事, 水), each equal to its standalone lookup",
      dd?.added === 2 && dd.counters === 0
        && dd.got[0].text === soloShokuji.text && dd.got[1].text === soloMizu.text
        && dd.got.every((g) => g.badge === "word" && !g.error),
      JSON.stringify(dd?.got.map((g) => ({ q: g.q, len: g.text.length }))),
    );

    // dedupe also reaches across actions: while a kanji-食 lookup is pending
    // (in flight after the first click), clicking the same 食 token again must
    // not enqueue a second identical lookup — but a distinct token (作) still
    // queues. Queue length therefore caps at 2 (counter reads 2, not 3), and
    // exactly two panes land: 作 (newest, on top) then 食.
    const xBefore = await page.$$eval("#panes .pane", (els) => els.length);
    const xProbe = await page.evaluate(() => {
      const findTok = (ch) => [...document.querySelectorAll("#panes .pane pre .tok-kanji")]
        .find((b) => b.textContent === ch);
      const shoku = findTok("食");
      const saku = findTok("作");
      shoku?.click(); // kanji 食 in flight now
      shoku?.click(); // same pending lookup again → must be dropped
      saku?.click(); // distinct lookup → queues behind
      return {
        shokuFound: !!shoku,
        sakuFound: !!saku,
        ariaBusy: document.querySelector("#lookup").getAttribute("aria-busy"),
        counter: document.querySelector("button[data-cmd] .queue-n")?.textContent ?? null,
      };
    });
    check(
      "cross-action dedupe: re-clicking a pending token does not re-enqueue",
      xProbe.shokuFound && xProbe.sakuFound && xProbe.ariaBusy === "true" && xProbe.counter === "2",
      JSON.stringify(xProbe),
    );
    const xDone = await waitFor(
      page,
      () => page.evaluate((base) => {
        const els = [...document.querySelectorAll("#panes .pane")];
        if (els.length < base + 2) return null;
        const got = els.slice(0, 2).map((p) => ({
          q: p.querySelector(".pane-query")?.textContent ?? "",
          badge: p.querySelector(".badge")?.textContent ?? "",
          error: p.classList.contains("error"),
        }));
        const busy = document.querySelector("#lookup").hasAttribute("aria-busy");
        return got[0].q === "作" && got[1].q === "食" && !busy ? got : null;
      }, xBefore),
      60000,
      "cross-action dedupe panes",
    );
    check(
      "cross-action dedupe: two panes (作 on top, 食 below), queue drained",
      xDone?.length === 2
        && xDone[0].badge === "kanji" && xDone[1].badge === "kanji"
        && xDone.every((p) => !p.error),
      JSON.stringify(xDone),
    );

    // ---- kanji: non-kanji characters in the box are ignored ---------------
    // Typing a word (or pasting text with punctuation) and pressing kanji
    // must still show the page for every kanji it contains — the non-kanji
    // characters are ignored, not fed to the reading-search fallback.
    const onePane = async (cmd, value, expectQuery) => {
      const before = await page.$$eval("#panes .pane", (els) => els.length);
      await page.evaluate(([c, v]) => {
        const input = document.querySelector("#query");
        input.value = v;
        document.querySelector(`button[data-cmd="${c}"]`).click();
      }, [cmd, value]);
      return waitFor(
        page,
        () => page.evaluate(([exp, base]) => {
          const els = [...document.querySelectorAll("#panes .pane")];
          if (els.length < base + 1) return null;
          const first = els[0];
          const got = {
            q: first.querySelector(".pane-query")?.textContent ?? "",
            badge: first.querySelector(".badge")?.textContent ?? "",
            error: first.classList.contains("error"),
            text: first.querySelector("pre")?.textContent ?? "",
          };
          return got.q === exp ? got : null;
        }, [expectQuery, before]),
        60000,
        `${cmd} pane for "${value}"`,
      );
    };
    let kan = await onePane("kanji", "食べる", "食");
    check(
      "kanji: 食べる → kana ignored, the 食 page comes back",
      kan?.badge === "kanji" && !kan.error
        && kan.text.includes("On:") && kan.text.includes("eat"),
      kan ? `${kan.text.slice(0, 40)}…` : "(none)",
    );
    // 制・作者 strips to 制作者: the exact multi-kanji run (ranked Words
    // section first, then one page per character — same output as the typed
    // 制作者 verified above).
    kan = await onePane("kanji", "制・作者", "制作者");
    check(
      "kanji: 制・作者 → punctuation ignored, one page per individual kanji",
      kan?.badge === "kanji" && !kan.error
        && /^Words \(\d+\):\n  制作者  \[/.test(kan.text)
        && kanjiParts.every((t) => kan.text.includes(t))
        && kan.text.endsWith(kanjiParts[2]),
      kan ? `${kan.text.length}B pages=${kanjiParts.map((t) => t.length).join(",")}B` : "(none)",
    );
    // A box with no kanji at all is left untouched: the reading search still
    // runs (kana/romaji queries must not be stripped to nothing).
    kan = await onePane("kanji", "makase", "makase");
    check(
      "kanji: reading search untouched when the box has no kanji",
      kan?.badge === "kanji" && !kan.error
        && (kan.text.includes("任") || kan.text.includes("委")),
      kan ? kan.text.slice(0, 60) : "(none)",
    );

    // search is deliberately untouched: a multi-word box is NOT split there
    // (one pane, the verbatim query — only word/kanji expand their queries).
    const searchBox = await onePane("search", "水 食事", "水 食事");
    check(
      "search is not split: one pane with the verbatim multi-word query",
      searchBox?.badge === "search",
      JSON.stringify(searchBox ? { badge: searchBox.badge, len: searchBox.text.length } : null),
    );

    // the max box drives the caps end-to-end
    await page.evaluate(() => { document.querySelector("#max").value = "3"; });
    p = await runLookup(page, "kanji", "食");
    check("max=3 caps kanji compounds", p.text.includes("… and "), p.text.slice(0, 80));
    await page.evaluate(() => { document.querySelector("#max").value = "5"; });
    p = await runLookup(page, "search", "eat");
    check("max=5 caps search sections", p.text.includes("… and "), p.text.slice(0, 80));
    await page.evaluate(() => { document.querySelector("#max").value = "30"; });

    const paneCount = await waitFor(
      page,
      () => page.$$eval("#panes .pane", (els) => els.length).then((n) => (n >= 15 ? n : null)),
      15000,
      "15 panes",
    );
    check("panes newest-first (history grows)", paneCount >= 15, `${paneCount} panes`);

    // ---- persistent state (localStorage) ------------------------------------
    // Input, max, last command and the result history survive a reload; the
    // per-pane trashbin deletes one result (visible + persisted), the header
    // trashbin deletes them all.
    p = await runLookup(page, "word", "うどん");
    const delProbe = await page.evaluate(() => {
      const first = document.querySelector("#panes .pane");
      return {
        hasDel: !!first?.querySelector(".pane-del"),
        q: first?.querySelector(".pane-query")?.textContent ?? "",
        clearEnabled: !document.querySelector("#clear").disabled,
        clearHasIcon: !!document.querySelector("#clear svg"),
      };
    });
    check("each pane has a delete (trashbin) button", delProbe.hasDel && delProbe.q === "うどん", JSON.stringify(delProbe));
    // No reload has happened since boot: with results in the list the header
    // trashbin must be enabled and show its icon (it starts disabled).
    check(
      "header trashbin enabled + icon visible with results",
      delProbe.clearEnabled && delProbe.clearHasIcon,
      JSON.stringify({ enabled: delProbe.clearEnabled, hasIcon: delProbe.clearHasIcon }),
    );
    const delClick = await page.evaluate(() => {
      const before = document.querySelectorAll("#panes .pane").length;
      document.querySelector("#panes .pane .pane-del").click();
      return {
        before,
        after: document.querySelectorAll("#panes .pane").length,
        gone: ![...document.querySelectorAll("#panes .pane-query")].some((el) => el.textContent === "うどん"),
      };
    });
    check(
      "pane trashbin removes that result from the list",
      delClick.before === delClick.after + 1 && delClick.gone,
      JSON.stringify(delClick),
    );

    // reload (online): input, max, command highlight and history come back,
    // and the deleted pane stays deleted (it was removed from storage too).
    const beforeReload = await page.evaluate(() => ({
      query: document.querySelector("#query").value,
      max: document.querySelector("#max").value,
      cmd: [...document.querySelectorAll("button[data-cmd]")]
        .find((b) => b.classList.contains("primary"))?.dataset.cmd,
      panes: document.querySelectorAll("#panes .pane").length,
    }));
    await page.reload({ waitUntil: "load", timeout: 30000 });
    const restored = await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready") ? {
          query: document.querySelector("#query").value,
          max: document.querySelector("#max").value,
          cmd: [...document.querySelectorAll("button[data-cmd]")]
            .find((b) => b.classList.contains("primary"))?.dataset.cmd,
          panes: document.querySelectorAll("#panes .pane").length,
          udon: [...document.querySelectorAll("#panes .pane-query")].some((el) => el.textContent === "うどん"),
        } : null;
      }),
      60000,
      "reload ready with restored state",
    );
    check(
      "reload restores input, max, command and pane history",
      restored.query === beforeReload.query && restored.max === beforeReload.max
        && restored.cmd === beforeReload.cmd && restored.panes === beforeReload.panes,
      JSON.stringify({ before: beforeReload, after: restored }),
    );
    check("deleted pane stays deleted after reload", !restored.udon, `udon present: ${restored.udon}`);

    // header trashbin: all results gone, button disables itself
    const cleared = await page.evaluate(() => {
      document.querySelector("#clear").click();
      return {
        panes: document.querySelectorAll("#panes .pane").length,
        disabled: document.querySelector("#clear").disabled,
      };
    });
    check("header trashbin clears all results and disables itself", cleared.panes === 0 && cleared.disabled, JSON.stringify(cleared));

    // offline: reload with network disabled — shell comes from the service
    // worker, the dictionary from OPFS (history was cleared above, so the
    // offline lookup below runs against a fresh pane).
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
    // The header trashbin was disabled (history was cleared, then reloaded with
    // no panes); the fresh lookup must re-enable it — no reload involved.
    const clearState = await page.evaluate(() => ({
      panes: document.querySelectorAll("#panes .pane").length,
      disabled: document.querySelector("#clear").disabled,
      hasIcon: !!document.querySelector("#clear svg"),
    }));
    check(
      "header trashbin re-enabled by a new result (no reload)",
      clearState.panes === 1 && !clearState.disabled && clearState.hasIcon,
      JSON.stringify(clearState),
    );
    await page.setOfflineMode(false);

    // ---- interactive hover / keyboard-focus feedback -----------------------
    // Runs last so the pointer/focus probes can't disturb any later lookup.
    // The suite runs under a mobile-touch viewport (hover: none), so the
    // hover probes temporarily switch to a desktop pointer and restore the
    // mobile viewport right after. Hovering a control emboldens it; untouched
    // and disabled controls keep their resting weight; keyboard focus (Tab)
    // gives the same emphasis as hover. Text inputs are the exception to the
    // weight cue — their typed text never emboldens, and the accent ring
    // marks their focused state instead.
    const weight = (sel) => page.$eval(sel, (el) => getComputedStyle(el).fontWeight);
    const hover = async (sel) => { // center the pointer over the element
      for (let i = 0; i < 4; i++) {
        const b = await page.$eval(sel, (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 4 });
        await sleep(60);
      }
    };
    await page.setViewport({ width: 420, height: 900, isMobile: false, hasTouch: false });
    const cmdBtn = 'button[data-cmd="kanji"]';
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.mouse.move(0, 0);
    const cmdRest = await weight(cmdBtn);
    await hover(cmdBtn);
    const cmdHover = await weight(cmdBtn);
    await page.mouse.move(0, 0);
    const cmdAfter = await weight(cmdBtn);
    check(
      "hover emboldens a control, then returns to rest",
      cmdRest === "600" && cmdHover === "700" && cmdAfter === "600",
      `${cmdRest}→${cmdHover}→${cmdAfter}`,
    );
    // Text inputs are the exception to the weight cue: the query text is the
    // user's own input, and emboldening it on hover would make the whole
    // line jump. Hovering must leave the input's weight untouched.
    const qWeightRest = await weight("#query");
    await hover("#query");
    const qWeightHover = await weight("#query");
    await page.mouse.move(0, 0);
    check(
      "hover leaves the query input's weight untouched",
      qWeightRest === "400" && qWeightHover === "400",
      `${qWeightRest}→${qWeightHover}`,
    );
    // disabled controls are not interactive: no emphasis while hovered
    await page.evaluate(() => {
      document.querySelector('button[data-cmd="word"]').disabled = true;
    });
    await hover('button[data-cmd="word"]');
    const disabledW = await weight('button[data-cmd="word"]');
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      document.querySelector('button[data-cmd="word"]').disabled = false;
    });
    check("disabled controls ignore hover emphasis", disabledW === "600", disabledW);

    // icon glyphs carry no text, so there is no font-weight to embolden: the
    // magnifier word-lookup icon must show the same emphasis as a heavier
    // stroke (it used to dim via opacity instead). Probe it over a pane that
    // is guaranteed to carry word rows — a fresh kanji page lookup.
    await runLookup(page, "kanji", "食");
    const magSel = "#panes .pane:first-child pre .tok-word";
    const magRest = await page.$eval(magSel, (el) => getComputedStyle(el.querySelector("svg")).strokeWidth);
    await hover(magSel);
    const magHover = await page.$eval(magSel, (el) => getComputedStyle(el.querySelector("svg")).strokeWidth);
    await page.mouse.move(0, 0);
    check(
      "hover emphasizes the magnifier icon (heavier stroke, not translucency)",
      magRest === "2.2px" && magHover === "3.6px",
      `${magRest}→${magHover}`,
    );
    await page.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: true });
    // Switching isMobile/hasTouch forces Chrome to reload the page, so the app
    // boots again (controls disabled until the worker reports ready). Wait for
    // that before probing focus — otherwise every control is still disabled
    // and Tab skips straight from the header to the pane buttons.
    await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready") ? s : null;
      }),
      60000,
      "feedback-section ready",
    );
    // Keyboard focus (Tab) emboldens like hover — but only controls with a
    // real label. The app focuses the query input on ready, so blurring keeps
    // the browser's tab start-point there and one Tab lands on the next
    // top-level control (#max, a text input): it must keep its resting weight
    // (no bolding of the user's typed text) and show the accent ring instead.
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("Tab");
    const focusState = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const s = getComputedStyle(el);
      const accent = getComputedStyle(document.querySelector(".pane-del")).color;
      return {
        tag: el.tagName, id: el.id ?? "", weight: s.fontWeight,
        outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth,
        outlineColor: s.outlineColor, accent,
      };
    });
    check(
      "keyboard focus rings the max input without emboldening it",
      focusState?.tag === "INPUT" && focusState.id === "max"
        && focusState.weight === "400"
        && focusState.outlineStyle === "solid" && focusState.outlineWidth === "2px"
        && focusState.outlineColor === focusState.accent,
      JSON.stringify(focusState),
    );
    // The control after the inputs is a real command button — keyboard focus
    // must embolden it exactly like hover does.
    await page.keyboard.press("Tab");
    const btnState = await page.evaluate(() => {
      const el = document.activeElement;
      return el
        ? { tag: el.tagName, id: el.id ?? "", cmd: el.dataset?.cmd ?? "", weight: getComputedStyle(el).fontWeight }
        : null;
    });
    check(
      "keyboard focus emboldens command buttons",
      btnState?.tag === "BUTTON" && btnState.cmd === "kanji" && btnState.weight === "700",
      JSON.stringify(btnState),
    );
    // The same focus must draw the shared accent ring — that is what makes
    // keyboard focus visible on icon-only buttons (the header trashbin holds
    // an svg, so the weight cue above cannot act on it). Walk Shift+Tab back
    // from wherever the first Tab landed until the trashbin holds focus.
    let onClear = false;
    for (let i = 0; i < 10 && !onClear; i++) {
      onClear = await page.evaluate(() => {
        const a = document.activeElement;
        return !!a && a.id === "clear" && a.tagName === "BUTTON";
      });
      if (!onClear) {
        await page.keyboard.down("Shift");
        await page.keyboard.press("Tab");
        await page.keyboard.up("Shift");
      }
    }
    const ringState = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const s = getComputedStyle(el);
      const accent = getComputedStyle(document.querySelector(".pane-del")).color;
      return {
        tag: el.tagName, id: el.id ?? "",
        outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor,
        accent,
      };
    });
    check(
      "keyboard focus draws the accent ring on icon buttons",
      onClear && ringState?.tag === "BUTTON" && ringState.outlineStyle === "solid"
        && ringState.outlineWidth === "2px" && ringState.outlineColor === ringState.accent,
      JSON.stringify(ringState),
    );
    // The query input must show the identical ring — the same rule and shape
    // as every other control — replacing its old accent border-color change.
    // Tab until it holds focus (clear → query → max → …); while blurred,
    // record its rest border so we can assert it is untouched, and log where
    // focus actually lands so a failure shows the real tab order.
    const inputRest = await page.evaluate(() => {
      const q = document.querySelector("#query");
      const s = getComputedStyle(q);
      return {
        borderColor: s.borderColor,
        queryDisabled: q.disabled, maxDisabled: document.querySelector("#max").disabled,
        kanjiDisabled: document.querySelector('button[data-cmd="kanji"]').disabled,
        ariaBusy: document.querySelector("#lookup")?.getAttribute("aria-busy"),
      };
    });
    const seen = [];
    let inputRing = null;
    for (let i = 0; i < 6 && inputRing === null; i++) {
      await page.keyboard.press("Tab");
      inputRing = await page.evaluate(() => {
        const el = document.activeElement;
        const s = getComputedStyle(el);
        return el?.id === "query"
          ? {
              outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth,
              outlineColor: s.outlineColor, borderColor: s.borderColor,
              accent: getComputedStyle(document.querySelector(".pane-del")).color,
            }
          : null;
      });
      if (inputRing === null) {
        seen.push(
          await page.evaluate(() => {
            const el = document.activeElement;
            return el
              ? { tag: el.tagName, id: el.id ?? "", type: el.type ?? "", cls: el.className ?? "", cmd: el.dataset?.cmd ?? "", disabled: el.disabled ?? null }
              : null;
          }),
        );
      }
    }
    check(
      "query input gets the accent ring, not a border-color change",
      inputRing?.outlineStyle === "solid" && inputRing.outlineWidth === "2px"
        && inputRing.outlineColor === inputRing.accent
        && inputRing.borderColor === inputRest.borderColor,
      JSON.stringify({ rest: inputRest, focused: inputRing, seen }),
    );
    // keyboard focus rings + emboldens the inline result tokens too: keep
    // tabbing (clear → query → max → kanji → word → search → pane → …) until
    // a kanji token inside a result pane is focused.
    let tokState = null;
    for (let i = 0; i < 40 && tokState === null; i++) {
      await page.keyboard.press("Tab");
      tokState = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el?.classList?.contains("tok-kanji")) return null;
        const s = getComputedStyle(el);
        return {
          weight: s.fontWeight, text: el.textContent,
          outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth,
        };
      });
    }
    check(
      "keyboard focus rings and emboldens result tokens",
      tokState?.weight === "700" && tokState.outlineStyle === "solid" && tokState.outlineWidth === "2px",
      JSON.stringify(tokState),
    );
    await page.evaluate(() => document.activeElement?.blur?.());

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
