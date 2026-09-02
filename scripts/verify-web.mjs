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
