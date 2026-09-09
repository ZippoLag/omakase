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

async function waitFor(page, fn, timeoutMs, what, intervalMs = 250) {
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
        const busy = document.querySelector("#lookup").hasAttribute("aria-busy");
        // The newest pane must be the one we just asked for (queries are
        // serialized), and the queue must be drained — a streaming skeleton
        // pane matches the query before its sections have landed.
        return first && lastRun === q && !st.startsWith("starting") && !busy
          ? { text: first.querySelector("pre")?.textContent ?? "", err: first.classList.contains("error"), q: lastRun }
          : null;
      }, query),
      // The first lookup after the OPFS import reads a cold 318 MB DB
      // before the OS page cache warms up — generous ceiling (a warm lookup
      // is expected to answer in well under a second; see the perf section).
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
  const indexHtml = readFileSync(join(root, "dist", "index.html"), "utf8");
  check(
    "sw.js cache name stamped with the served build version",
    !!stamp && swJs.includes(`const CACHE = "omakase-${stamp}";`),
    stamp ? `CACHE=omakase-${stamp}` : "(dist/src/version.js has no stamp — run web:build)",
  );
  // Version-busted shell assets (W6): dist/index.html must link style.css and
  // web/app/main.js with the build version as a query param, and dist/sw.js
  // must precache the SAME versioned URLs — otherwise a new build can resolve
  // old cached assets (stale/unstyled UI) until the next update.
  check(
    "index.html links the versioned shell assets (cache-busting)",
    !!stamp
      && indexHtml.includes(`href="./style.css?v=${stamp}"`)
      && indexHtml.includes(`src="./web/app/main.js?v=${stamp}"`),
    stamp ? `assets ?v=${stamp}` : "(dist/src/version.js has no stamp — run web:build)",
  );
  check(
    "sw.js precaches the same versioned shell assets",
    !!stamp
      && swJs.includes(`"./style.css?v=${stamp}"`)
      && swJs.includes(`"./web/app/main.js?v=${stamp}"`),
    stamp ? `precache ?v=${stamp}` : "(dist/src/version.js has no stamp — run web:build)",
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
    // W13 helper: a window.fetch patch so the stroke-widget tests can hold or
    // fail stroke-svg requests deterministically. The svg fetch runs on the
    // main thread (window.fetch) but goes through the service worker, whose
    // network fetches are NOT visible to puppeteer request interception — the
    // patch (installed before the app loads, applied on every document) is
    // the only reliable hook. Mode is switched at runtime via
    // window.__strokeFetchMode: "pass" (default) lets requests through,
    // "delay" holds stroke-svg responses 800 ms, "abort" rejects them.
    await page.evaluateOnNewDocument(() => {
      const origFetch = window.fetch.bind(window);
      window.__strokeFetchMode = "pass";
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (/\/strokes\/[^/]+\.svg$/.test(url)) {
          const mode = window.__strokeFetchMode;
          if (mode === "abort") {
            return Promise.reject(new TypeError("Failed to fetch (stroke svg aborted by test)"));
          }
          if (mode === "delay") {
            return new Promise((resolve, reject) => {
              setTimeout(() => origFetch(input, init).then(resolve, reject), 800);
            });
          }
        }
        return origFetch(input, init);
      };
    });

    console.log("→ first visit (imports dictionary into OPFS)…");
    await page.goto(URL, { waitUntil: "load", timeout: 60000 });
    // While the engine starts / dictionary imports, boot must report itself:
    // a live % readout next to the status message and the divider gauge under
    // the controls, starting from its 0% dot. Sampled right after load — the
    // 289 MB import below guarantees a long boot window still ahead.
    const bootProbe = await page.evaluate(() => {
      const pct = document.querySelector("#status .pct");
      const pctText = pct?.textContent ?? "";
      return {
        pctVisible: !!pct && !pct.hidden && /\d+%/.test(pctText),
        prog: getComputedStyle(document.documentElement).getPropertyValue("--progress").trim(),
      };
    });
    check(
      "boot: % readout next to the status, gauge below 100%",
      bootProbe.pctVisible && bootProbe.prog !== "100%",
      JSON.stringify(bootProbe),
    );
    const statusText = await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready") ? s : null;
      }),
      180000,
      "worker ready (dictionary import)",
    );
    check("engine ready, dictionary in OPFS", statusText.startsWith("ready —"), statusText);
    // The ready status is deliberately terse — word count + the offline note.
    // The build provenance (v<ver>-build.<n>, commits, SQLite version) lives
    // in the header badge's hover tooltip instead (checked below). The count
    // may use any locale grouping (218.577 vs 218,577), so only the shape is
    // pinned.
    const terseReady = /^ready — [\d.,\s]+ words \(100% offline\)$/.test(statusText);
    check(
      "ready status: word count + offline note only (no build stamp)",
      terseReady && !statusText.includes("-build.") && !statusText.includes("SQLite") && !statusText.includes("·"),
      statusText,
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
    // Loading is done: the % readout is gone and the divider gauge sits at the
    // full line (100%) — its resting look as the divider under the controls.
    const readyProgress = await page.evaluate(() => {
      const pct = document.querySelector("#status .pct");
      return {
        pctHidden: !!pct && pct.hidden,
        pctText: pct?.textContent ?? "",
        prog: getComputedStyle(document.documentElement).getPropertyValue("--progress").trim(),
      };
    });
    check(
      "ready: % readout gone, divider gauge full",
      readyProgress.pctHidden && readyProgress.pctText === "" && readyProgress.prog === "100%",
      JSON.stringify(readyProgress),
    );

    // default command highlight is search (before anything is clicked)
    const hl = await page.evaluate(() => {
      const p = (c) => document.querySelector(`button[data-cmd="${c}"]`).classList.contains("primary");
      return { search: p("search"), word: p("word"), kanji: p("kanji") };
    });
    check("default highlight is search", hl.search && !hl.word && !hl.kanji, JSON.stringify(hl));

    // the per-list "max" cap moved into the settings pane (W14): a number
    // input there defaulting to 5, and the input row holds only the query.
    const maxBox = await page.evaluate(() => {
      const el = document.querySelector("#settings-max");
      return {
        exists: !!el,
        type: el?.type,
        value: el?.value,
        inlineMaxGone: !document.querySelector("#inputrow #max"),
      };
    });
    check(
      "settings max box: number input in the settings pane, default 5",
      maxBox.exists && maxBox.type === "number" && maxBox.value === "5" && maxBox.inlineMaxGone,
      JSON.stringify(maxBox),
    );
    // ---- W14: settings pane ------------------------------------------------
    // The gear at the right end of the header opens the settings dialog,
    // which hosts auto-scroll, the max count, the theme toggle and the
    // background/accent color pickers.
    // The closed dialog must be truly hidden (display:none / zero rect), not
    // merely !open — an author display:flex rule on #settings would override
    // the UA's dialog:not([open]) hiding and leave the styled settings
    // window permanently visible in the page flow, with an ✕ that cannot
    // close it (close() on a never-modal dialog is a no-op).
    const closedHidden = await page.evaluate(() => {
      const d = document.querySelector("#settings");
      const s = getComputedStyle(d);
      const r = d.getBoundingClientRect();
      return s.display === "none" || r.width === 0 || r.height === 0;
    });
    check("W14: closed settings dialog is hidden (not in the page flow)", closedHidden);
    const gearProbe = await page.evaluate(() => {
      const gear = document.querySelector("#settings-gear");
      const clear = document.querySelector("#clear");
      gear.click();
      const dialog = document.querySelector("#settings");
      return {
        gear: !!gear,
        // gear sits after clear: PRECEDING is set when the argument (clear)
        // comes before the reference (gear)
        afterClear: !!(gear && clear && (gear.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_PRECEDING)),
        dialogOpen: dialog.open,
        modal: dialog.matches(":modal"),
        close: !!document.querySelector("#settings-close"),
        autoScroll: !!document.querySelector("#settings-auto-scroll"),
        maxInSettings: !!document.querySelector("#settings-max"),
        themeLight: !!document.querySelector("#theme-light"),
        themeDark: !!document.querySelector("#theme-dark"),
        bgColor: document.querySelector("#bg-color")?.value ?? "",
        accentColor: document.querySelector("#accent-color")?.value ?? "",
      };
    });
    check(
      "W14: gear opens the settings dialog (auto-scroll, max, theme, colors)",
      gearProbe.gear && gearProbe.afterClear && gearProbe.dialogOpen && gearProbe.modal && gearProbe.close
        && gearProbe.autoScroll && gearProbe.maxInSettings
        && gearProbe.themeLight && gearProbe.themeDark
        && gearProbe.bgColor === "#A6DDCF" && gearProbe.accentColor === "#EF6A5E",
      JSON.stringify(gearProbe),
    );
    // close it with a REAL pointer click (mouse at the button's coordinates,
    // not el.click()) — the programmatic path bypasses hit-testing, so it
    // could never catch a close button a real user cannot press. Then assert
    // the dialog is gone from both the top layer and the page flow.
    const closeBtn = await page.$("#settings-close");
    const closeBox = await closeBtn.boundingBox();
    await page.mouse.click(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
    const closedAfter = await page.evaluate(() => {
      const d = document.querySelector("#settings");
      const s = getComputedStyle(d);
      const r = d.getBoundingClientRect();
      return { open: d.open, hidden: s.display === "none" || r.width === 0 || r.height === 0 };
    });
    check(
      "W14: real click on the close button dismisses the dialog completely",
      !closedAfter.open && closedAfter.hidden,
      JSON.stringify(closedAfter),
    );

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

    // ---- W16: tone system (final revision) + configurable colors ----------
    // The headless-Chrome environment's system preference is dark, so the
    // “fresh profile” here is not a light one — force the theme to light
    // through the settings pane first, then probe the computed styles. The
    // final revision moved the configurable color OUT of the page background
    // into the surfaces: the app background is the neutral tint-less tone
    // (#f7f7f5 light / #111418 dark), while the muted aquamarine (#A6DDCF at
    // 100% intensity, driven by theme.ts) is the TINT (tone-1) that colors
    // the input, the command buttons and the top-level panes. Pane heads use
    // the softer tone-2 (#DBF1EC in light — --tint-soft) and nested results
    // alternate between the two tones by depth (checked in the tokens
    // block). The accent gained a role in the tree: every pane's command
    // badge carries it. Live controls: a valid accent hex flips --accent and
    // the progress bar; the bg slider blends the tint toward the theme base
    // (0% = plain white in light mode; the dark 0% = black + capped tint are
    // probed in the W14 dark block below).
    const w16Base = await page.evaluate(() => {
      const setVal = (sel, v) => {
        const el = document.querySelector(sel);
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      document.querySelector("#settings-gear").click();
      const light = document.querySelector("#theme-light");
      if (document.documentElement.dataset.theme !== "light") light.click();
      // --tint-soft is a color-mix(), which computed style reports as
      // `color(srgb r g b)` floats — normalize to the rgb() form every other
      // color comes back as.
      const normBg = (el) => {
        const v = getComputedStyle(el).backgroundColor;
        const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
        if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
        const c = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v);
        if (c) return `rgb(${Math.round(+c[1] * 255)}, ${Math.round(+c[2] * 255)}, ${Math.round(+c[3] * 255)})`;
        return v;
      };
      // Capture the resting styles BEFORE the live-control mutations below.
      const body = getComputedStyle(document.body);
      const input = getComputedStyle(document.querySelector("#query"));
      const btn = getComputedStyle(document.querySelector('button[data-cmd="search"]'));
      const pane = document.querySelector("#panes .pane");
      const pst = pane ? getComputedStyle(pane) : null;
      const headEl = pane?.querySelector(".pane-head") ?? null;
      const badge = pane ? getComputedStyle(pane.querySelector(".badge")) : null;
      const h1 = getComputedStyle(document.querySelector("h1"));
      const root = document.documentElement;
      setVal("#accent-color", "#3366FF");
      const accent = root.style.getPropertyValue("--accent").trim();
      const bar = getComputedStyle(document.querySelector("#lookup"), "::after").backgroundColor;
      setVal("#bg-mix", "0");
      const tintZero = getComputedStyle(document.querySelector("#query")).backgroundColor;
      setVal("#bg-mix", "100");
      const tintFull = getComputedStyle(document.querySelector("#query")).backgroundColor;
      // restore the stock colors so the rest of the suite sees them
      setVal("#accent-color", "#EF6A5E");
      document.querySelector("#settings-close").click();
      return {
        bodyBg: body.backgroundColor,
        bodyShadow: body.textShadow,
        inputBg: input.backgroundColor,
        btnBg: btn.backgroundColor,
        paneBg: pst?.backgroundColor ?? null,
        paneRadius: pst?.borderRadius ?? null,
        paneShadow: pst?.boxShadow ?? null,
        headBg: headEl ? normBg(headEl) : null,
        badgeColor: badge?.color ?? null,
        h1Font: h1.fontFamily,
        btnFont: btn.fontFamily,
        accent, bar, tintZero, tintFull,
      };
    });
    check(
      "W16: neutral app background with tinted controls (input + buttons)",
      w16Base.bodyBg === "rgb(247, 247, 245)" && w16Base.bodyShadow === "none"
        && w16Base.inputBg === "rgb(166, 221, 207)" && w16Base.btnBg === "rgb(166, 221, 207)",
      JSON.stringify(w16Base),
    );
    check(
      "W16: panes are softly rounded with a single border (no inset double frame)",
      w16Base.paneRadius === "8px" && !/inset/.test(w16Base.paneShadow),
      JSON.stringify(w16Base),
    );
    check(
      "W16: top-level panes carry the tint, heads the soft tone, badges the accent",
      w16Base.paneBg === "rgb(166, 221, 207)" && w16Base.headBg === "rgb(219, 241, 236)"
        && w16Base.badgeColor === "rgb(239, 106, 94)",
      JSON.stringify(w16Base),
    );
    check(
      "W16: header + buttons use the monospace chrome stack",
      /monospace|SF Mono|Menlo|Consolas/i.test(w16Base.h1Font)
        && /monospace|SF Mono|Menlo|Consolas/i.test(w16Base.btnFont),
      JSON.stringify(w16Base),
    );
    check(
      "W16: accent hex drives --accent and the progress bar color",
      w16Base.accent === "#3366FF" && w16Base.bar === "rgb(51, 102, 255)",
      JSON.stringify(w16Base),
    );
    check(
      "W16: bg slider blends the tint toward the theme base (0% = white in light)",
      w16Base.tintZero === "rgb(255, 255, 255)" && w16Base.tintFull === "rgb(166, 221, 207)",
      JSON.stringify(w16Base),
    );

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

    // ---- per-operation progress + streaming panes ---------------------------
    // A lookup's pane appears immediately (header + skeleton rows) and the
    // divider bar + % readout report the CURRENT operation's progress — the
    // slow gloss search below (a few seconds of meaning scoring) gives the
    // probes a real window to sample mid-flight.
    const streamProbe = await page.evaluate(async () => {
      const input = document.querySelector("#query");
      input.value = "water";
      document.querySelector('button[data-cmd="search"]').click();
      // Sample 1 — synchronously after the click: the pane appears immediately
      // (header + skeleton rows), before the worker's first reply can land.
      const immediate = (() => {
        const p = document.querySelector("#panes .pane.streaming");
        return {
          skel: !!p && p.querySelectorAll(".skel-line").length > 0,
          paneQ: p?.querySelector(".pane-query")?.textContent ?? "",
          prog0: getComputedStyle(document.documentElement).getPropertyValue("--progress").trim(),
        };
      })();
      // Sample 2 — after the first worker messages land: the search header
      // section streams immediately (it only echoes the query), clearing the
      // skeleton rows, and the worker's pre-discovery heartbeat claims the
      // readings floor at once — so the bar has already left the dot well
      // before the long meaning search produces its first counted value
      // (W7: it must never park at 0% through the silent stretch).
      await new Promise((r) => setTimeout(r, 600));
      const streamPane = document.querySelector("#panes .pane.streaming");
      const pct = document.querySelector("#status .pct");
      const prog = getComputedStyle(document.documentElement).getPropertyValue("--progress").trim();
      const status = document.querySelector("#status .status-msg")?.textContent ?? "";
      const barPct = Number.parseFloat(prog);
      return {
        ...immediate,
        laterSkel: !!streamPane && streamPane.querySelectorAll(".skel-line").length > 0,
        paneText: streamPane?.querySelector("pre")?.textContent ?? "",
        pctVisible: !!pct && !pct.hidden && /\d+%/.test(pct.textContent ?? ""),
        prog,
        mid: prog !== "0%" && prog !== "100%",
        barPastDot: Number.isFinite(barPct) && barPct >= 10,
        status,
      };
    });
    check(
      "op: pane streams instantly, header clears the skeleton, bar leaves 0% promptly",
      streamProbe.skel && streamProbe.paneQ === "water"
        && streamProbe.prog0 === "0%"
        && !streamProbe.laterSkel && streamProbe.paneText.startsWith("water")
        && streamProbe.pctVisible && streamProbe.mid && streamProbe.barPastDot
        && (streamProbe.status.includes("looking up") || streamProbe.status.includes("searching")),
      JSON.stringify(streamProbe),
    );
    const waterPane = await waitFor(
      page,
      () => page.evaluate(() => {
        const first = document.querySelector("#panes .pane");
        const qry = first?.querySelector(".pane-query")?.textContent;
        if (qry !== "water") return null;
        if (document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
        const pct = document.querySelector("#status .pct");
        return {
          hasSkel: !!first.querySelector(".skel-line"),
          error: first.classList.contains("error"),
          text: first.querySelector("pre")?.textContent ?? "",
          pctHidden: !!pct && pct.hidden,
          prog: getComputedStyle(document.documentElement).getPropertyValue("--progress").trim(),
          status: document.querySelector("#status .status-msg")?.textContent ?? "",
        };
      }),
      60000,
      "water result (streamed sections + final pane)",
    );
    check(
      "op: result finalizes the pane, bar rests full, % readout hidden",
      !!waterPane && !waterPane.hasSkel && !waterPane.error && waterPane.text.includes("Meanings")
        && waterPane.pctHidden && waterPane.prog === "100%" && waterPane.status.startsWith("ready"),
      JSON.stringify(waterPane ? { skel: waterPane.hasSkel, prog: waterPane.prog, status: waterPane.status } : null),
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
        if (!first || qry !== "taberu") return null;
        if (document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
        return { badge: first.querySelector(".badge")?.textContent, text: first.querySelector("pre")?.textContent ?? "" };
      }),
      60000,
      "enter search result",
    );
    check(
      "Enter runs default search command",
      enterPane?.badge === "search" && enterPane.text.includes("Readings") && enterPane.text.includes("食べる"),
      JSON.stringify(enterPane),
    );

    // The shimmer rows are a placeholder: cleared the moment the first
    // section lands, so they are never left stacked above the streamed text.
    // word 走る streams its body almost instantly, then spends a couple of
    // hundred ms on the gloss-fallback thesaurus — a real window where the
    // pane is still `.streaming` (the result has not rebuilt it yet), already
    // holding body text, with zero skeleton rows left. Poll tight enough to
    // land inside that window. (Runs after the Enter probe above: clicking
    // word here would otherwise change the default command the Enter probe
    // relies on.)
    await page.evaluate(() => {
      const input = document.querySelector("#query");
      input.value = "走る";
      document.querySelector('button[data-cmd="word"]').click();
    });
    const midWord = await waitFor(
      page,
      () => page.evaluate(() => {
        const pane = document.querySelector("#panes .pane.streaming");
        const text = pane?.querySelector("pre")?.textContent ?? "";
        return pane && text.length > 0 && pane.querySelectorAll(".skel-line").length === 0
          ? {
            q: pane.querySelector(".pane-query")?.textContent ?? "",
            head: text.slice(0, 40),
            hasWord: text.includes("走る"),
          }
          : null;
      }),
      10000,
      "word body landed (skeleton cleared, pane still streaming)",
      20,
    );
    check(
      "op: skeleton rows cleared when the first section lands, before the result rebuilds the pane",
      !!midWord && midWord.q === "走る" && midWord.hasWord,
      JSON.stringify(midWord),
    );
    // The probe sampled 走る mid-stream — let its result land and the queue
    // drain before the next lookup starts, like every other probe leaves the
    // app (never stack the next op on top of an in-flight one).
    await waitFor(
      page,
      () => page.evaluate(() => {
        if (document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
        const first = document.querySelector("#panes .pane");
        return first?.querySelector(".pane-query")?.textContent === "走る" && !first.classList.contains("error")
          ? true
          : null;
      }),
      30000,
      "走る result finalizes after the mid-stream probe",
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
    // ---- W13: char box + skeleton + stepping + failure fallback ------------
    // The widget pairs the animation with a font-rendered twin of the kanji
    // in a box the same size (so a character is always visible), shows a
    // shimmer skeleton while the svg loads, steps one stroke at a time with
    // ‹/›, and keeps the character when the diagram cannot be fetched.
    const charProbe = await page.evaluate(() => {
      const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
      const char = fig?.querySelector(".stroke-char");
      const svg = fig?.querySelector("svg.stroke-svg");
      const cr = char?.getBoundingClientRect();
      const sr = svg?.getBoundingClientRect();
      return {
        char: char?.textContent ?? "",
        prev: !!fig?.querySelector(".stroke-prev"),
        replay: !!fig?.querySelector(".stroke-replay"),
        next: !!fig?.querySelector(".stroke-next"),
        sameSize: !!(cr && sr && Math.abs(cr.width - sr.width) < 1 && Math.abs(cr.height - sr.height) < 1),
        sizes: cr && sr ? { char: `${cr.width}x${cr.height}`, svg: `${sr.width}x${sr.height}` } : null,
      };
    });
    check(
      "W13: font-rendered kanji box beside the animation, same size + step buttons",
      charProbe.char === "食" && charProbe.prev && charProbe.replay && charProbe.next && charProbe.sameSize,
      JSON.stringify(charProbe),
    );
    // stepping: ‹ / › move one stroke at a time; the boundary buttons disable.
    // Start from a settled state (replay until every stroke is drawn).
    await page.evaluate(() => {
      document.querySelector("#panes .pane:first-child .stroke-widget .stroke-replay").click();
    });
    await waitFor(
      page,
      () => page.evaluate(() => {
        const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
        const next = fig?.querySelector(".stroke-next");
        return next && next.disabled ? true : null;
      }),
      15000,
      "auto-play finished (all strokes drawn)",
    );
    const stepBack = await page.evaluate(() => {
      const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
      const prev = fig.querySelector(".stroke-prev");
      const next = fig.querySelector(".stroke-next");
      const paths = [...fig.querySelectorAll("svg.stroke-svg path")];
      const visible = () => paths.filter((p) => Math.abs(parseFloat(p.style.strokeDashoffset) || 0) < 0.5).length;
      for (let i = 0; i < 9; i++) prev.click();
      return { visible: visible(), prevDisabled: prev.disabled, nextDisabled: next.disabled };
    });
    check(
      "W13: ‹ steps backward one stroke at a time (0 left, prev disabled)",
      stepBack.visible === 0 && stepBack.prevDisabled && !stepBack.nextDisabled,
      JSON.stringify(stepBack),
    );
    const stepFwd = await page.evaluate(() => {
      const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
      const prev = fig.querySelector(".stroke-prev");
      const next = fig.querySelector(".stroke-next");
      const paths = [...fig.querySelectorAll("svg.stroke-svg path")];
      const visible = () => paths.filter((p) => Math.abs(parseFloat(p.style.strokeDashoffset) || 0) < 0.5).length;
      for (let i = 0; i < 9; i++) next.click();
      return { visible: visible(), prevDisabled: prev.disabled, nextDisabled: next.disabled };
    });
    check(
      "W13: › steps forward one stroke at a time (all 9, next disabled)",
      stepFwd.visible === 9 && stepFwd.nextDisabled && !stepFwd.prevDisabled,
      JSON.stringify(stepFwd),
    );
    // › pressed mid-play cancels the auto-play and draws exactly one more.
    const midPlay = await page.evaluate(async () => {
      const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
      const replay = fig.querySelector(".stroke-replay");
      const next = fig.querySelector(".stroke-next");
      const paths = [...fig.querySelectorAll("svg.stroke-svg path")];
      const visible = () => paths.filter((p) => Math.abs(parseFloat(p.style.strokeDashoffset) || 0) < 0.5).length;
      replay.click(); // starts the auto-play (stroke 1 draws synchronously)
      next.click(); // same task: cancels the play, draws exactly one more
      const rightAfter = visible();
      await new Promise((r) => setTimeout(r, 1200));
      const later = visible();
      return { rightAfter, later };
    });
    check(
      "W13: › mid-play cancels the auto-play and draws exactly one stroke",
      midPlay.rightAfter === 2 && midPlay.later === 2,
      JSON.stringify(midPlay),
    );
    // loading skeleton + failure fallback — deterministic via the
    // window.fetch patch installed before the app loaded (SW fetches bypass
    // puppeteer request interception): "delay" holds the stroke-svg response
    // 800 ms so the skeleton is observable, "abort" rejects it so the widget
    // keeps only the font-rendered character.
    await page.evaluate(() => { window.__strokeFetchMode = "delay"; });
    await page.evaluate(() => {
      const input = document.querySelector("#query");
      input.value = "語";
      document.querySelector('button[data-cmd="kanji"]').click();
    });
    const skeletonProbe = await waitFor(
      page,
      () => page.evaluate(() => {
        const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
        if (!fig?.querySelector(".stroke-skeleton")) return null;
        return {
          char: fig.querySelector(".stroke-char")?.textContent ?? "",
          controlsDisabled: !!(fig.querySelector(".stroke-prev")?.disabled
            && fig.querySelector(".stroke-replay")?.disabled
            && fig.querySelector(".stroke-next")?.disabled),
        };
      }),
      8000,
      "stroke skeleton visible while the svg is delayed",
      100,
    );
    check(
      "W13: shimmer skeleton + char while the svg loads (controls disabled)",
      !!skeletonProbe && skeletonProbe.char === "語" && skeletonProbe.controlsDisabled,
      JSON.stringify(skeletonProbe),
    );
    await page.evaluate(() => { window.__strokeFetchMode = "pass"; });
    const afterDelay = await waitFor(
      page,
      () => page.evaluate(() => {
        const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
        const svg = fig?.querySelector("svg.stroke-svg");
        if (!fig || fig.querySelector(".stroke-skeleton") || !svg || svg.querySelectorAll("path").length === 0) return null;
        return {
          paths: svg.querySelectorAll("path").length,
          label: fig.querySelector(".stroke-label")?.textContent ?? "",
        };
      }),
      10000,
      "delayed svg finishes loading (skeleton cleared)",
      100,
    );
    check(
      "W13: skeleton clears once the svg lands (stroke count in the label)",
      !!afterDelay && afterDelay.paths > 0 && /^語 · \d+ strokes$/.test(afterDelay.label),
      JSON.stringify(afterDelay),
    );

    await page.evaluate(() => { window.__strokeFetchMode = "abort"; });
    await page.evaluate(() => {
      const input = document.querySelector("#query");
      input.value = "漢";
      document.querySelector('button[data-cmd="kanji"]').click();
    });
    const abortProbe = await waitFor(
      page,
      () => page.evaluate(() => {
        const fig = document.querySelector("#panes .pane:first-child .stroke-widget");
        // fetch aborted → animation cell + control bar removed, char kept
        if (!fig || fig.querySelector("svg.stroke-svg") || fig.querySelector(".stroke-bar")) return null;
        return { char: fig.querySelector(".stroke-char")?.textContent ?? "" };
      }),
      10000,
      "aborted svg leaves only the font-rendered kanji",
      100,
    );
    check(
      "W13: failed svg fetch keeps the same-size font-rendered kanji",
      abortProbe?.char === "漢",
      JSON.stringify(abortProbe),
    );

    await page.evaluate(() => { window.__strokeFetchMode = "pass"; });
    // W13: a collapsed kanji pane hides its stroke widgets too — only the
    // head banner stays (the strip is a sibling of the pane body, so the
    // .pane.collapsed pre rule never reached it). Probe on the 漢 pane, then
    // re-expand so the collapse block below sees an expanded first pane.
    const stripCollapse = await page.evaluate(() => {
      const pane = document.querySelector("#panes .pane:first-child");
      const strip = pane.querySelector(".stroke-strip");
      const toggle = pane.querySelector(".pane-collapse");
      const before = strip.offsetHeight > 0;
      toggle.click();
      const collapsedHidden = strip.offsetHeight === 0 && pane.classList.contains("collapsed");
      toggle.click();
      return { before, collapsedHidden, restored: strip.offsetHeight > 0 };
    });
    check(
      "W13: collapse hides the stroke strip, expand restores it",
      stripCollapse.before && stripCollapse.collapsedHidden && stripCollapse.restored,
      JSON.stringify(stripCollapse),
    );
    // kanji (reading search)
    p = await runLookup(page, "kanji", "makase");
    check("kanji reading search hits", p.text.includes("任") || p.text.includes("委"), p.text.slice(0, 60));
    const noWidget = await page.evaluate(() =>
      !document.querySelector("#panes .pane:first-child .stroke-widget"));
    check("kanji reading search has no stroke widgets", noWidget, "list results are not kanji pages");
    // multi-kanji: a box holding several kanji resolves one kanji at a time
    // as separate lookups — one pane per character, byte-identical to looking
    // the character up alone. The panes stream in: the first renders while
    // the later lookups are still queued (never after the whole batch), which
    // is exactly what one-request-per-kanji buys on slow devices. The trace
    // must run on a FRESH batch — a cached literal renders instantly with no
    // queueing to observe, so the standalone 制/作/者 pages used for the
    // byte-equality comparison are looked up AFTER the trace, not before.
    // Watch a multi-item lookup land: the click's own task already shows the
    // mid-batch state (skeleton up, queue badge counting what is behind), so
    // that same-task read is the first trace tick; polling then continues at
    // ~10 ms granularity until every expected pane is up and the queue has
    // drained.
    const streamPanes = async (cmd, value, expect) => {
      const base = await page.$$eval("#panes .pane", (els) => els.length);
      const t0 = Date.now();
      // submit() → drain() run synchronously inside the click handler, so a
      // read in the SAME task sees the exact mid-batch state with no timing
      // race: the first pane's streaming skeleton is already up, aria-busy is
      // set, and the queue badge counts the lookups still behind it. (A
      // cached batch instead renders every pane synchronously here — count
      // equals the whole batch and nothing ever queued.)
      const first = await page.evaluate(([c, v, b]) => {
        const input = document.querySelector("#query");
        input.value = v;
        document.querySelector(`button[data-cmd="${c}"]`).click();
        const els = [...document.querySelectorAll("#panes .pane")];
        return {
          count: els.length - b,
          busy: document.querySelector("#lookup").hasAttribute("aria-busy"),
          counter: document.querySelector(`button[data-cmd="${c}"] .btn-n`)?.textContent ?? null,
          topQ: els[0]?.querySelector(".pane-query")?.textContent ?? "",
        };
      }, [cmd, value, base]);
      const trace = [first];
      for (;;) {
        const st = await page.evaluate(([b, c]) => {
          const els = [...document.querySelectorAll("#panes .pane")];
          const busy = document.querySelector("#lookup").hasAttribute("aria-busy");
          // per-command badge: how many panes of THIS command are still queued
          // behind the in-flight head (the spinner marks the running one)
          const counter = document.querySelector(`button[data-cmd="${c}"] .btn-n`)?.textContent ?? null;
          return {
            count: els.length - b,
            busy,
            counter,
            topQ: els[0]?.querySelector(".pane-query")?.textContent ?? "",
          };
        }, [base, cmd]);
        trace.push(st);
        if (st.count >= expect.length && !st.busy) break;
        if (Date.now() - t0 > 60000) throw new Error(`timeout streaming ${cmd} "${value}"`);
        await sleep(10);
      }
      const panes = await page.evaluate(([b, n]) => [...document.querySelectorAll("#panes .pane")]
        .slice(0, n).map((pn) => ({
          q: pn.querySelector(".pane-query")?.textContent ?? "",
          badge: pn.querySelector(".badge")?.textContent ?? "",
          error: pn.classList.contains("error"),
          text: pn.querySelector("pre")?.textContent ?? "",
        })), [base, expect.length]);
      return { trace, panes, totalMs: Date.now() - t0 };
    };
    // 制作者 box → three kanji lookups (制, then 作, then 者). Lookups are
    // serialized, so the very first trace tick already shows 制's pane (its
    // streaming skeleton) while 作 + 者 are still queued — the kanji badge
    // reads 2 (both still to come), proving progressive rendering.
    const km = await streamPanes("kanji", "制作者", ["制", "作", "者"]);
    const kmFirst = km.trace.find((t) => t.count === 1);
    check(
      "multi-kanji streams: 制's pane is up while 作 + 者 are still queued",
      kmFirst?.topQ === "制" && kmFirst?.busy && kmFirst?.counter === "2",
      JSON.stringify(kmFirst ?? km.trace),
    );
    // Standalone pages for the byte-equality comparison — looked up AFTER the
    // trace so the box above was still uncached (these render instantly from
    // the cache the box just populated).
    const kanjiParts = [];
    for (const ch of ["制", "作", "者"]) {
      kanjiParts.push((await runLookup(page, "kanji", ch)).text);
    }
    check(
      "multi-kanji: 制作者 box → one pane per kanji, byte-equal to each standalone page",
      km.panes.length === 3
        && km.panes.map((d) => d.badge).join(",") === "kanji,kanji,kanji"
        && km.panes.every((d) => !d.error)
        && km.panes[0].text === kanjiParts[2]
        && km.panes[1].text === kanjiParts[1]
        && km.panes[2].text === kanjiParts[0],
      `top-down ${km.panes.map((d) => d.q).join(",")} in ${km.totalMs} ms`,
    );
    // one stroke-order widget per pane — each per-kanji pane mounts its own
    const multiWidgets = await waitFor(
      page,
      () => page.evaluate(() => {
        const panes = [...document.querySelectorAll("#panes .pane")].slice(0, 3);
        const figs = panes.map((pn) => pn.querySelectorAll(".stroke-widget svg.stroke-svg path").length);
        return figs.length === 3 && figs.every((n) => n > 0)
          ? panes.map((pn) => pn.querySelector(".stroke-label")?.textContent ?? "")
          : null;
      }),
      30000,
      "per-kanji stroke widgets",
    );
    check(
      "multi-kanji: each per-kanji pane mounts its own stroke widget (制, 作, 者)",
      Array.isArray(multiWidgets) && multiWidgets.length === 3
        && ["制", "作", "者"].every((c) => multiWidgets.some((l) => l.startsWith(`${c} ·`))),
      JSON.stringify(multiWidgets),
    );
    // search romaji readings — たべる (kana) rather than the already-run
    // taberu: the action dedupe (W2) suppresses identical re-requests, and
    // both queries match the same reading-prefix hits, so the pane is
    // byte-identical to the taberu search the Enter probe ran above.
    p = await runLookup(page, "search", "たべる");
    check("search たべる → Readings", p.text.includes("Readings") && p.text.includes("食べる"), "search たべる");
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
    // search english meanings — a fresh gloss query ("eat" itself was
    // already searched by the busy probe above, so the dedupe would suppress
    // it; the two-word query still intersects on 食べる's gloss "to eat")
    p = await runLookup(page, "search", "to eat");
    check("search \"to eat\" → Meanings", p.text.includes("Meanings") && p.text.includes("to eat"), "search \"to eat\"");
    // thesaurus
    p = await runLookup(page, "word", "暑い");
    check("word 暑い thesaurus/antonyms", p.text.includes("Antonyms") && p.text.includes("寒い"), "thesaurus");
    // error path (no entry)
    p = await runLookup(page, "word", "zzzznotaword");
    check("unknown word shows error pane", p.isError && p.text.includes("no entry"), p.text);

    // Reset the history before the token-centric section below. The action
    // dedupe (W2) suppresses identical re-requests, and this section — plus
    // everything after it (queued actions, multi-word boxes, dedupe probes,
    // max caps) — was authored to run against a fresh slate where its own
    // lookups are the first of their kind. The header trashbin clears the
    // tree, the duplicate tracker AND the result cache in one go.
    await page.evaluate(() => {
      document.querySelector("#clear").click();
    });
    const clearedCount = await page.$$eval("#panes .pane", (els) => els.length);
    check("history cleared before the token section", clearedCount === 0, String(clearedCount));

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
    // Nested results: the word page opens under the pane that hosted the
    // compound row (the top-level kanji-食 page) as its newest child — it is
    // not a fresh top-level pane, so it is read from the hosting pane.
    const tokWordPane = await waitFor(
      page,
      () => page.evaluate((q) => {
        const host = document.querySelector("#panes .pane:first-child");
        if (!host || document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
        const child = host.querySelector(".pane-children > .pane");
        if (!child) return null;
        return child.querySelector(".badge")?.textContent === "word"
          && child.querySelector(".pane-query")?.textContent === q
          ? child.querySelector("pre")?.textContent : null;
      }, expectedWord),
      30000,
      `word icon click (${expectedWord})`,
    );
    check(
      "tokens: word icon click → word pane nested under the hosting pane",
      !!tokWordPane && tokWordPane.includes("Writings"),
      tokWordPane ? `${expectedWord}: ${tokWordPane.slice(0, 40)}` : "(none)",
    );
    // click the 食 kanji token → a kanji page nests under the pane that
    // hosts the token (the kanji-食 page) as its newest child, above the word
    // page opened above (its 食 page was cached by the standalone lookup, so
    // it renders immediately rather than streaming)
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("#panes .pane:first-child pre .tok-kanji")]
        .find((x) => x.textContent === "食");
      b.click();
    });
    const tokKanjiPane = await waitFor(
      page,
      () => page.evaluate(() => {
        const host = document.querySelector("#panes .pane:first-child");
        if (!host || document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
        const child = host.querySelector(".pane-children > .pane");
        if (!child) return null;
        return child.querySelector(".badge")?.textContent === "kanji"
          && child.querySelector(".pane-query")?.textContent === "食"
          ? child.querySelector("pre")?.textContent : null;
      }),
      30000,
      "kanji token click",
    );
    check(
      "tokens: kanji click → kanji 食 pane nested under the hosting pane",
      !!tokKanjiPane && tokKanjiPane.includes("strokes"),
      tokKanjiPane ? tokKanjiPane.slice(0, 40) : "(none)",
    );
    // W16 tone alternation: nested results take the opposite tone from their
    // host — every pane's tone class must match its real DOM nesting depth
    // (even depth = tint, odd = soft), and a depth-1 child renders on the
    // soft shade while its head shares it. Light theme is still active here
    // (the W16 block forced it; the dark flip happens in the reload block).
    const toneProbe = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("#panes .pane")];
      return panes.map((p) => {
        let depth = 0;
        let el = p.parentElement;
        while (el) {
          if (el.classList.contains("pane")) depth++;
          el = el.parentElement;
        }
        return {
          q: p.querySelector(".pane-query")?.textContent ?? "",
          depth,
          cls: p.classList.contains("tone-tint") ? "tint"
            : p.classList.contains("tone-soft") ? "soft" : "?",
        };
      });
    });
    check(
      "tokens: pane tones alternate by nesting depth (even = tint, odd = soft)",
      toneProbe.length > 0
        && toneProbe.every((t) => t.cls === (t.depth % 2 === 0 ? "tint" : "soft")),
      JSON.stringify(toneProbe.slice(0, 8)),
    );
    const nestedTone = await page.evaluate(() => {
      const host = document.querySelector("#panes .pane:first-child");
      const child = host?.querySelector(".pane-children > .pane");
      if (!child) return null;
      // --tint-soft is a color-mix(): normalize the `color(srgb …)` form.
      const normBg = (el) => {
        const v = getComputedStyle(el).backgroundColor;
        const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
        if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
        const c = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v);
        if (c) return `rgb(${Math.round(+c[1] * 255)}, ${Math.round(+c[2] * 255)}, ${Math.round(+c[3] * 255)})`;
        return v;
      };
      return {
        childBg: normBg(child),
        childHead: normBg(child.querySelector(".pane-head")),
      };
    });
    check(
      "tokens: a nested pane renders on the soft tone (body + head)",
      !!nestedTone && nestedTone.childBg === "rgb(219, 241, 236)"
        && nestedTone.childHead === "rgb(219, 241, 236)",
      JSON.stringify(nestedTone),
    );
    // A search result list is one two-space word row per hit: the exact
    // reading せいさくしゃ matches 制作者 alone, and that row carries the
    // word icon + keeps its kanji clickable — a `word 制作者` magnifier
    // target for the queued-action probes below.
    p = await runLookup(page, "search", "せいさくしゃ");
    const seisakushaTok = await page.evaluate(() => {
      const pre = document.querySelector("#panes .pane:first-child pre");
      return {
        icons: [...pre.querySelectorAll(".tok-word")].map((b) => b.title),
        kanji: [...pre.querySelectorAll(".tok-kanji")].map((b) => b.textContent),
      };
    });
    check(
      "tokens: search hit row has the word icon + clickable kanji (word 制作者)",
      seisakushaTok.icons.includes("word 制作者")
        && ["制", "作", "者"].every((c) => seisakushaTok.kanji.includes(c)),
      JSON.stringify({ icons: seisakushaTok.icons.slice(0, 3), kanji: [...new Set(seisakushaTok.kanji)].slice(0, 8) }),
    );

    // ---- queued actions: clicks during a lookup enqueue, never drop ------
    // Command buttons and inputs lock while a lookup runs, but the
    // per-character kanji and magnifier tokens inside result panes stay
    // tappable. Those clicks must queue behind the running lookup — one
    // lookup at a time — and each queued action must still get its own pane,
    // with the controls returning to an idle state after. A click whose
    // lookup was ALREADY CACHED this session renders instantly instead of
    // queueing, so the probe queues lookups that are still fresh: the word
    // 制作者 (never looked up yet) and a kanji from the 食 page's compound
    // rows that was never looked up alone — anything but the kanji already
    // queried above (制/作/者/食). Results nest under the pane whose token
    // was clicked; top-level results (the word 水) stay top-level.
    const qBefore = await page.$$eval("#panes .pane", (els) => els.length);
    const busyProbe = await page.evaluate(() => {
      const input = document.querySelector("#query");
      // The せいさくしゃ search pane carries the `word 制作者` magnifier; the
      // top-level kanji-食 page's compound rows carry the fresh kanji tokens.
      const topPane = (badge, q) => [...document.querySelectorAll("#panes > .pane")]
        .find((p) => p.querySelector(".badge")?.textContent === badge
          && p.querySelector(".pane-query")?.textContent === q);
      const searchPane = topPane("search", "せいさくしゃ");
      const shokuPane = topPane("kanji", "食");
      const mag = searchPane?.querySelector('pre .tok-word[title="word 制作者"]') ?? null;
      const used = new Set([..."制作者食"]);
      const tok = [...(shokuPane?.querySelector("pre")?.querySelectorAll(".tok-kanji") ?? [])]
        .find((b) => !used.has(b.textContent));
      input.value = "水";
      document.querySelector('button[data-cmd="word"]').click(); // in flight now
      // While it runs, queue a magnifier (word) click and a kanji-token click
      // behind it — both must be accepted, not dropped.
      mag?.click();
      tok?.click();
      return {
        magFound: !!mag,
        tokFound: !!tok,
        picked: tok?.textContent ?? null,
        spinnerOnWord: !!document.querySelector('button[data-cmd="word"] .spinner'),
        // per-command badges: word 水 is in flight; 制作者 (word) and the
        // picked kanji are queued behind it — each button counts its own kind
        wordBadge: document.querySelector('button[data-cmd="word"] .btn-n')?.textContent ?? null,
        kanjiBadge: document.querySelector('button[data-cmd="kanji"] .btn-n')?.textContent ?? null,
        searchBadge: document.querySelector('button[data-cmd="search"] .btn-n')?.textContent ?? null,
        buttonsDisabled: [...document.querySelectorAll("button[data-cmd]")].every((b) => b.disabled),
        inputDisabled: input.disabled,
        ariaBusy: document.querySelector("#lookup").getAttribute("aria-busy"),
      };
    });
    check(
      "busy: tokens stay tappable while a lookup runs (spinner on word)",
      busyProbe.magFound && busyProbe.tokFound && !!busyProbe.picked && busyProbe.spinnerOnWord
        && busyProbe.buttonsDisabled && busyProbe.inputDisabled && busyProbe.ariaBusy === "true",
      JSON.stringify(busyProbe),
    );
    check(
      "busy: per-command badges count each kind queued behind the running lookup",
      busyProbe.wordBadge === "1" && busyProbe.kanjiBadge === "1" && busyProbe.searchBadge === null,
      JSON.stringify({ word: busyProbe.wordBadge, kanji: busyProbe.kanjiBadge, search: busyProbe.searchBadge }),
    );
    // All three lookups must complete, one at a time, in click order. The
    // word 水 was already in flight → its pane is the newest TOP-LEVEL pane;
    // the queued word 制作者 and kanji panes nest under the panes whose
    // tokens were clicked (search せいさくしゃ / kanji 食), newest first.
    const queued = await waitFor(
      page,
      () => page.evaluate(([base, picked]) => {
        const els = [...document.querySelectorAll("#panes .pane")];
        if (els.length < base + 3) return null;
        // The panes must be FINAL (queue drained) — a streaming skeleton for
        // the last lookup would match these queries before it has landed.
        if (document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
        const read = (p) => ({
          q: p.querySelector(".pane-query")?.textContent ?? "",
          badge: p.querySelector(".badge")?.textContent ?? "",
          error: p.classList.contains("error"),
          // text: the word-comma section compares box panes byte-equal to the
          // standalone 水 page — which is THIS pane (a re-request would be
          // suppressed by the action dedupe), so the text is captured here.
          text: p.querySelector("pre")?.textContent ?? "",
        });
        const topPane = (badge, q) => [...document.querySelectorAll("#panes > .pane")]
          .find((p) => p.querySelector(".badge")?.textContent === badge
            && p.querySelector(".pane-query")?.textContent === q);
        const top = document.querySelector("#panes > .pane");
        const searchPane = topPane("search", "せいさくしゃ");
        const shokuPane = topPane("kanji", "食");
        const wordChild = searchPane?.querySelector(".pane-children > .pane") ?? null;
        const kanjiChild = shokuPane?.querySelector(".pane-children > .pane") ?? null;
        const mizu = top ? read(top) : null;
        const word = wordChild ? read(wordChild) : null;
        const kanji = kanjiChild ? read(kanjiChild) : null;
        return mizu && word && kanji
          && mizu.q === "水" && mizu.badge === "word"
          && word.q === "制作者" && word.badge === "word"
          && kanji.q === picked && kanji.badge === "kanji"
          ? { mizu, word, kanji } : null;
      }, [qBefore, busyProbe.picked]),
      60000,
      "three queued panes",
    );
    check(
      "clicks during a lookup enqueue — panes land one at a time, each under its hosting pane",
      !!queued && !queued.mizu.error && !queued.word.error && !queued.kanji.error,
      JSON.stringify(queued),
    );
    // The queue must drain fully: spinner gone, labels restored, idle again.
    const idleAfterQueue = await page.evaluate(() => ({
      labels: [...document.querySelectorAll("button[data-cmd]")].map((b) => b.textContent.trim()),
      spinners: document.querySelectorAll("button[data-cmd] .spinner").length,
      counters: document.querySelectorAll("button[data-cmd] .btn-n").length,
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
    // 水 was already looked up by the queued-actions probe above — the
    // action dedupe (W2) suppresses a re-request, so the standalone page is
    // the text that probe captured, not a fresh lookup.
    const soloMizu = { text: queued.mizu.text };
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
          if (document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
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
            ? { got, added: els.length - base, counters: document.querySelectorAll("button[data-cmd] .btn-n").length }
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

    // dedupe also reaches across actions: while a fresh kanji lookup is
    // pending (in flight after the first click), clicking the SAME token
    // again must not enqueue a second identical lookup — but a distinct
    // token still queues. The kanji badge therefore reads 1 (only the second
    // kanji behind the running first — the duplicate click was dropped), and
    // exactly two panes land, nested under the pane whose tokens were
    // clicked. Earlier blocks already looked up 制/作/者/食 (plus the kanji
    // the queued-action block picked), so the targets here must be picked
    // dynamically: a kanji queried this session renders instantly from the
    // result cache instead of streaming, which would break the "while
    // pending" premise. Every kanji pane's query is excluded, and the first
    // pane (newest-first DOM order) holding two fresh kanji tokens becomes
    // the host.
    const xProbe = await page.evaluate(() => {
      const panes = [...document.querySelectorAll("#panes .pane")];
      // Any kanji queried this session has a kanji pane somewhere (nested or
      // top-level) — exclude those queries so the clicks below always hit a
      // lookup that is still uncached.
      const queried = new Set(
        panes
          .filter((p) => p.querySelector(".badge")?.textContent === "kanji")
          .map((p) => p.querySelector(".pane-query")?.textContent ?? "")
          .filter(Boolean),
      );
      let host = null;
      let hostKidsBefore = 0;
      let picked = [];
      for (const p of panes) {
        const fresh = [...new Set(
          [...p.querySelectorAll("pre .tok-kanji")]
            .map((b) => b.textContent)
            .filter((c) => !queried.has(c)),
        )];
        if (fresh.length >= 2) {
          host = p;
          hostKidsBefore = p.querySelectorAll(".pane-children > .pane").length;
          picked = fresh.slice(0, 2);
          break;
        }
      }
      if (!host || picked.length < 2) {
        return {
          found: false,
          queried: [...queried],
          panes: panes.map((p) => ({
            q: p.querySelector(".pane-query")?.textContent ?? "",
            kanjiTokens: p.querySelectorAll("pre .tok-kanji").length,
          })),
        };
      }
      // Tag the host so the panes can be asserted under exactly this pane.
      host.setAttribute("data-xhost", "1");
      const toks = [...host.querySelectorAll("pre .tok-kanji")];
      const btn = (c) => toks.find((b) => b.textContent === c);
      btn(picked[0]).click(); // kanji picked[0] in flight now
      btn(picked[0]).click(); // same pending lookup again → must be dropped
      btn(picked[1]).click(); // distinct lookup → queues behind
      return {
        found: true,
        picked,
        hostKidsBefore,
        hostQuery: host.querySelector(".pane-query")?.textContent ?? "",
        ariaBusy: document.querySelector("#lookup").getAttribute("aria-busy"),
        kanjiBadge: document.querySelector('button[data-cmd="kanji"] .btn-n')?.textContent ?? null,
        wordBadge: document.querySelector('button[data-cmd="word"] .btn-n')?.textContent ?? null,
        searchBadge: document.querySelector('button[data-cmd="search"] .btn-n')?.textContent ?? null,
      };
    });
    check(
      "cross-action dedupe: re-clicking a pending token does not re-enqueue",
      xProbe.found && xProbe.ariaBusy === "true" && xProbe.kanjiBadge === "1"
        && xProbe.wordBadge === null && xProbe.searchBadge === null,
      JSON.stringify(xProbe),
    );
    const xDone = xProbe.found
      ? await waitFor(
        page,
        () => page.evaluate(([x, y, before]) => {
          const host = document.querySelector("#panes [data-xhost]");
          if (!host || document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
          const kids = [...host.querySelectorAll(".pane-children > .pane")];
          if (kids.length < before + 2) return null;
          const read = (p) => ({
            q: p.querySelector(".pane-query")?.textContent ?? "",
            badge: p.querySelector(".badge")?.textContent ?? "",
            error: p.classList.contains("error"),
          });
          const top = read(kids[0]);
          const next = read(kids[1]);
          // Newest child first: the queued distinct kanji lands on top of
          // the first-clicked one — a leaked duplicate would add a third
          // kanji child and fail this read.
          return top.q === y && next.q === x ? { top, next, added: kids.length - before } : null;
        }, [xProbe.picked[0], xProbe.picked[1], xProbe.hostKidsBefore]),
        60000,
        "cross-action dedupe panes",
      )
      : null;
    check(
      "cross-action dedupe: two fresh kanji panes nest under the clicked pane, queue drained",
      !!xDone && xDone.added === 2
        && xDone.top.q === xProbe.picked[1] && xDone.next.q === xProbe.picked[0]
        && xDone.top.badge === "kanji" && xDone.next.badge === "kanji"
        && !xDone.top.error && !xDone.next.error,
      JSON.stringify(xDone),
    );
    // Drop the temporary host marker used to locate the nested panes.
    await page.evaluate(() => {
      document.querySelector("#panes [data-xhost]")?.removeAttribute("data-xhost");
    });

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
          if (document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
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
    // 制・作者 ignores the punctuation and looks up each kanji separately —
    // the same three per-kanji panes the plain 制作者 box produced above.
    const km2 = await streamPanes("kanji", "制・作者", ["制", "作", "者"]);
    check(
      "kanji: 制・作者 → punctuation ignored, one pane per individual kanji",
      km2.panes.length === 3
        && km2.panes.map((d) => d.badge).join(",") === "kanji,kanji,kanji"
        && km2.panes.every((d) => !d.error)
        && km2.panes[0].text === kanjiParts[2]
        && km2.panes[1].text === kanjiParts[1]
        && km2.panes[2].text === kanjiParts[0],
      `top-down ${km2.panes.map((d) => d.q).join(",")} in ${km2.totalMs} ms`,
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

    // the settings max box drives the caps end-to-end (it lives in the
    // settings dialog since W14; submit reads its value live)
    await page.evaluate(() => { document.querySelector("#settings-max").value = "3"; });
    // 食's page is already up from the token section — the dedupe would
    // suppress a re-request, so cap a fresh kanji page (水) instead.
    p = await runLookup(page, "kanji", "水");
    check("max=3 caps kanji compounds", p.text.includes("… and "), p.text.slice(0, 80));
    await page.evaluate(() => { document.querySelector("#settings-max").value = "5"; });
    p = await runLookup(page, "search", "eat");
    check("max=5 caps search sections", p.text.includes("… and "), p.text.slice(0, 80));
    await page.evaluate(() => { document.querySelector("#settings-max").value = "5"; });

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
    // W4: capture the top-down pane order too — the existing reload check only
    // compared counts, which let the restored tree render in the wrong order
    // (oldest on top) without failing.
    // W14: flip auto-scroll + theme through the settings pane before the
    // reload — they must survive alongside the rest of the state.
    await page.evaluate(() => {
      document.querySelector("#settings-gear").click();
      const auto = document.querySelector("#settings-auto-scroll");
      if (auto.checked) auto.click();
      document.querySelector("#theme-dark").click();
      document.querySelector("#settings-close").click();
    });
    // W16: in dark mode the ink is the soft warm white (#E8E6E3) with no
    // text-shadow, and the TINT (tone-1) is capped toward black so the light
    // ink stays readable on tinted surfaces: the bg slider's 0% lands on the
    // dark base (black) and 100% on the 45%-strength shade (#4B635D) rather
    // than the raw pastel. The pane head's tone-2 follows (#2C3839). The
    // dialog is already closed, but dispatching input on its controls still
    // applies the theme.
    const w16Dark = await page.evaluate(() => {
      const root = document.documentElement;
      const setVal = (sel, v) => {
        const el = document.querySelector(sel);
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const ink = getComputedStyle(root).getPropertyValue("--ink").trim();
      const bodyShadow = getComputedStyle(document.body).textShadow;
      setVal("#bg-mix", "0");
      const tintZero = getComputedStyle(document.querySelector("#query")).backgroundColor;
      setVal("#bg-mix", "100");
      const tintFull = getComputedStyle(document.querySelector("#query")).backgroundColor;
      // --tint-soft is a color-mix(): normalize the `color(srgb …)` form
      // Chrome reports for computed backgrounds.
      const normBg = (el) => {
        const v = getComputedStyle(el).backgroundColor;
        const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
        if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
        const c = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v);
        if (c) return `rgb(${Math.round(+c[1] * 255)}, ${Math.round(+c[2] * 255)}, ${Math.round(+c[3] * 255)})`;
        return v;
      };
      const headBg = normBg(document.querySelector("#panes .pane .pane-head"));
      setVal("#bg-mix", "100"); // restore so the reload persists the stock mix
      return { ink, bodyShadow, tintZero, tintFull, headBg };
    });
    check(
      "W16: dark mode caps the tint for readable light ink (0% = black, 100% = dark shade)",
      w16Dark.ink.toLowerCase() === "#e8e6e3" && w16Dark.bodyShadow === "none"
        && w16Dark.tintZero === "rgb(0, 0, 0)" && w16Dark.tintFull === "rgb(75, 99, 93)"
        && w16Dark.headBg === "rgb(44, 56, 57)",
      JSON.stringify(w16Dark),
    );
    const beforeReload = await page.evaluate(() => ({
      query: document.querySelector("#query").value,
      max: document.querySelector("#settings-max").value,
      theme: document.documentElement.dataset.theme ?? "",
      autoScroll: (() => {
        try { return JSON.parse(localStorage.getItem("omakase.state")).autoScrollEnabled; } catch { return null; }
      })(),
      cmd: [...document.querySelectorAll("button[data-cmd]")]
        .find((b) => b.classList.contains("primary"))?.dataset.cmd,
      panes: document.querySelectorAll("#panes .pane").length,
      topOrder: [...document.querySelectorAll("#panes > .pane > .pane-head > .pane-query")]
        .map((el) => el.textContent),
    }));
    await page.reload({ waitUntil: "load", timeout: 30000 });
    const restored = await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready") ? {
          query: document.querySelector("#query").value,
          max: document.querySelector("#settings-max").value,
          theme: document.documentElement.dataset.theme ?? "",
          autoScroll: (() => {
            try { return JSON.parse(localStorage.getItem("omakase.state")).autoScrollEnabled; } catch { return null; }
          })(),
          cmd: [...document.querySelectorAll("button[data-cmd]")]
            .find((b) => b.classList.contains("primary"))?.dataset.cmd,
          panes: document.querySelectorAll("#panes .pane").length,
          topOrder: [...document.querySelectorAll("#panes > .pane > .pane-head > .pane-query")]
            .map((el) => el.textContent),
          topLevel: document.querySelectorAll("#panes > .pane").length,
          inParents: [...document.querySelectorAll("#panes .pane-children > .pane")].length,
          perParent: [...document.querySelectorAll("#panes > .pane")]
            .filter((p) => p.querySelectorAll(".pane-children > .pane").length > 0)
            .map((p) => ({
              q: p.querySelector(".pane-query")?.textContent ?? "",
              kids: [...p.querySelectorAll(".pane-children > .pane")].map((k) =>
                `${k.querySelector(".pane-query")?.textContent ?? ""}(${k.dataset.nodeId})`),
            })),
          trace: (window.__trace ? Object.fromEntries(Object.entries(window.__trace)) : null),
          udon: [...document.querySelectorAll("#panes .pane-query")].some((el) => el.textContent === "うどん"),
          tree: (() => {
            try {
              const st = JSON.parse(localStorage.getItem("omakase.state"));
              const walk = (nodes) => nodes.map((n) => ({ q: n.query, id: n.id.slice(0, 6), kids: n.children?.length ?? 0 }));
              return { v: st.v, top: st.resultTree.length, roots: walk(st.resultTree) };
            } catch { return null; }
          })(),
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
    // W4: the restored tree must render the same top-down order as the live
    // DOM (newest pane on top) — a reload must not flip the history.
    check(
      "reload preserves top-down pane order",
      JSON.stringify(restored.topOrder) === JSON.stringify(beforeReload.topOrder),
      JSON.stringify({ before: beforeReload.topOrder, after: restored.topOrder }),
    );
    // W14: the theme + auto-scroll choices persisted through the reload
    check(
      "W14: theme + auto-scroll survive a reload",
      beforeReload.theme === "dark" && restored.theme === "dark" && restored.autoScroll === false,
      JSON.stringify({ before: { theme: beforeReload.theme, autoScroll: beforeReload.autoScroll }, after: { theme: restored.theme, autoScroll: restored.autoScroll } }),
    );
    // restore the defaults so the probes below see a light, auto-scrolling app
    await page.evaluate(() => {
      document.querySelector("#settings-gear").click();
      const auto = document.querySelector("#settings-auto-scroll");
      if (!auto.checked) auto.click();
      document.querySelector("#theme-light").click();
      document.querySelector("#settings-close").click();
    });

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

    // ---- lookup performance: every flow answers within budget ---------------
    // Regression guard for the dictionary query layer. The ruby for a loaded
    // word is read through `furigana WHERE word_id = ?`; while that column was
    // unindexed every loadWord paid a full scan of the 225k-row furigana
    // table — ~0.5 s per kanji page natively and tens of seconds per lookup
    // in the WASM worker (kanji pages load 30 words, gloss searches hundreds).
    // Each flow below must answer well within budget on warm caches, and
    // multi-item flows must stream one pane at a time instead of rendering
    // after the whole batch.
    await page.evaluate(() => document.querySelector("#clear").click());
    const timed = async (cmd, value) => {
      const r = await streamPanes(cmd, value, [value]);
      return { ms: r.totalMs, pane: r.panes[0] };
    };
    // warm every path once (page cache for kanji.db + worker code paths)
    await timed("search", "water");
    const tk = await timed("kanji", "木");
    check(
      "perf: single kanji 木 answers quickly (furigana word lookups indexed)",
      !tk.pane.error && tk.ms < 5000,
      `${tk.ms} ms`,
    );
    const tw = await timed("word", "走る");
    check(
      "perf: single word 走る answers quickly (thesaurus + ruby included)",
      !tw.pane.error && tw.ms < 5000,
      `${tw.ms} ms`,
    );
    const ts = await timed("search", "develop");
    check(
      "perf: English search develop answers quickly (no full scans)",
      !ts.pane.error && ts.ms < 8000,
      `${ts.ms} ms`,
    );
    // multi-word box streams too: 水's pane lands while 食事 is still queued
    const wstream = await streamPanes("word", "水 食事", ["食事", "水"]);
    const wFirst = wstream.trace.find((t) => t.count === 1);
    check(
      "perf: multi-word box streams — 水 lands while 食事 is still queued",
      wFirst?.topQ === "水" && wFirst?.busy
        && wstream.panes.length === 2 && wstream.totalMs < 8000,
      `batch ${wstream.totalMs} ms; trace ${wstream.trace.map((t) => `${t.count}${t.busy ? "b" : "i"}`).join(",")}`,
    );

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
        // Bring the target to viewport center first: panes land under the
        // sticky header when a lookup smooth-scrolls them in, so a probe that
        // hovers the top row's icon without scrolling would hover the header.
        await page.$eval(sel, (el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
        const b = await page.$eval(sel, (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 4 });
        await sleep(60);
      }
    };
    await page.setViewport({ width: 420, height: 900, isMobile: false, hasTouch: false });
    // Switching isMobile/hasTouch forces Chrome to reload the page, so the app
    // boots again (controls disabled until the worker reports ready). Wait for
    // that before probing hover/focus — otherwise the controls are still
    // disabled: the hover emphasis cue cannot act on them, and a lookup click
    // below is silently dropped (disabled buttons swallow clicks).
    await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready") ? s : null;
      }),
      60000,
      "feedback-section ready (desktop viewport)",
    );
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
    // real label. The settings pane's text inputs (the per-list max and the
    // color hex inputs) are text inputs: they must keep their resting weight
    // (no bolding of the typed text) and show the accent ring instead. (The
    // old inline #max box moved into the settings dialog in W14.)
    await page.evaluate(() => {
      document.querySelector("#settings-gear").click();
      document.querySelector("#settings-max").focus();
    });
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
      "keyboard focus rings the settings max input without emboldening it",
      focusState?.tag === "INPUT" && focusState.id === "settings-max"
        && focusState.weight === "400"
        && focusState.outlineStyle === "solid" && focusState.outlineWidth === "2px"
        && focusState.outlineColor === focusState.accent,
      JSON.stringify(focusState),
    );
    // Back to the app: closing the dialog returns focus to the gear, and the
    // next real command button after the inputs (query → kanji) is a button —
    // keyboard focus must embolden it exactly like hover does.
    await page.evaluate(() => document.querySelector("#settings-close").click());
    let btnState = null;
    for (let i = 0; i < 6 && btnState === null; i++) {
      await page.keyboard.press("Tab");
      btnState = await page.evaluate(() => {
        const el = document.activeElement;
        return el
          ? { tag: el.tagName, id: el.id ?? "", cmd: el.dataset?.cmd ?? "", weight: getComputedStyle(el).fontWeight }
          : null;
      });
      if (btnState && !(btnState.tag === "BUTTON" && btnState.cmd === "kanji")) btnState = null;
    }
    check(
      "keyboard focus emboldens command buttons",
      !!btnState && btnState.cmd === "kanji" && btnState.weight === "700",
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
    // Tab until it holds focus (clear → settings gear → query → …); while
    // blurred, record its rest border so we can assert it is untouched, and
    // log where focus actually lands so a failure shows the real tab order.
    const inputRest = await page.evaluate(() => {
      const q = document.querySelector("#query");
      const s = getComputedStyle(q);
      return {
        borderColor: s.borderColor,
        queryDisabled: q.disabled, maxDisabled: document.querySelector("#settings-max").disabled,
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
    // tabbing (… → kanji → word → search → pane → …) until a kanji token
    // inside a result pane is focused.
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

    // ---- collapse/expand: a collapsed pane reduces to its head banner ------
    // Collapsing hides BOTH the pane's own body (pre) and its nested
    // children, leaving only the head banner; expanding restores them; and
    // the collapsed state survives a reload (restore renders pre-collapsed).
    const collapseProbe = await page.evaluate(async () => {
      const pane = document.querySelector("#panes .pane");
      const pre = pane.querySelector("pre");
      const children = pane.querySelector(".pane-children");
      const toggle = pane.querySelector(".pane-collapse");
      const before = { preH: pre.offsetHeight, childH: children ? children.offsetHeight : null };
      toggle.click();
      // let the max-height transition finish before measuring
      await new Promise((r) => setTimeout(r, 450));
      return {
        before,
        after: {
          preH: pre.offsetHeight,
          childH: children ? children.offsetHeight : null,
          collapsedClass: pane.classList.contains("collapsed"),
          childrenHidden: children ? children.classList.contains("hidden") : null,
          aria: toggle.getAttribute("aria-label"),
        },
      };
    });
    check(
      "collapse: pane reduces to its head banner (body + children hidden)",
      !!collapseProbe && collapseProbe.after.collapsedClass && collapseProbe.after.preH === 0
        && (collapseProbe.after.childrenHidden === true || collapseProbe.after.childH === 0)
        && collapseProbe.after.aria === "Expand"
        && collapseProbe.before.preH > 0,
      JSON.stringify(collapseProbe),
    );
    const expandProbe = await page.evaluate(async () => {
      const pane = document.querySelector("#panes .pane");
      const pre = pane.querySelector("pre");
      const toggle = pane.querySelector(".pane-collapse");
      toggle.click();
      await new Promise((r) => setTimeout(r, 450));
      return {
        preH: pre.offsetHeight,
        collapsedClass: pane.classList.contains("collapsed"),
        aria: toggle.getAttribute("aria-label"),
      };
    });
    check(
      "collapse: second click expands the pane again",
      expandProbe.preH > 0 && !expandProbe.collapsedClass && expandProbe.aria === "Collapse",
      JSON.stringify(expandProbe),
    );
    // collapse a pane, then reload: the restored pane must come back
    // pre-collapsed (its body still tucked under the head banner).
    await page.evaluate(() => {
      document.querySelector("#panes .pane .pane-collapse").click();
    });
    await page.reload({ waitUntil: "load", timeout: 30000 });
    const collapseRestored = await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        if (!s.startsWith("ready")) return null;
        // after restore the pane order is whatever the storage held; find
        // the pane that was collapsed by its restored state
        const panes = [...document.querySelectorAll("#panes .pane")];
        const collapsed = panes.filter((p) => p.classList.contains("collapsed"));
        if (collapsed.length === 0) return null;
        const pane = collapsed[0];
        return {
          count: collapsed.length,
          preH: pane.querySelector("pre").offsetHeight,
          aria: pane.querySelector(".pane-collapse").getAttribute("aria-label"),
        };
      }),
      60000,
      "collapsed pane restored",
    );
    check(
      "collapse: collapsed state survives a reload (restored pre-collapsed)",
      !!collapseRestored && collapseRestored.count === 1 && collapseRestored.preH === 0
        && collapseRestored.aria === "Expand",
      JSON.stringify(collapseRestored),
    );

    // ---- corrupt/foreign state restore (W8) --------------------------------
    // A corrupt or foreign omakase.state (nodes missing required fields) must
    // not crash the boot: restoreState drops the bad tree and starts empty
    // instead of re-persisting a state that crashes every reload.
    await page.evaluate(() => {
      localStorage.setItem("omakase.state", JSON.stringify({
        v: 2,
        query: "",
        command: "search",
        max: 30,
        theme: "pink", // corrupt: not a valid theme
        bgColor: "not-a-color", // corrupt: not a hex
        bgMix: "huge", // corrupt: not a number
        accentColor: 42, // corrupt: not a string
        resultTree: [{ id: "x" }], // missing children/command/query/text/error/collapsed/max
        collapsedStates: { x: "not-a-boolean" }, // non-boolean collapsed value
      }));
    });
    await page.reload({ waitUntil: "load", timeout: 30000 });
    const corruptBoot = await waitFor(
      page,
      () => page.evaluate(() => {
        const s = document.querySelector("#status")?.textContent ?? "";
        return s.startsWith("ready")
          ? {
            panes: document.querySelectorAll("#panes .pane").length,
            query: document.querySelector("#query").value,
            theme: document.documentElement.dataset.theme ?? "",
            tint: document.documentElement.style.getPropertyValue("--tint").trim(),
            accent: document.documentElement.style.getPropertyValue("--accent").trim(),
          }
          : null;
      }),
      60000,
      "corrupt-state ready",
    );
    check(
      "corrupt state: app boots ready with no panes (bad tree dropped, no crash)",
      !!corruptBoot && corruptBoot.panes === 0,
      JSON.stringify(corruptBoot),
    );
    // W14: the corrupt settings values fell back to valid defaults — the
    // theme is a real light/dark value and the applied colors are hex.
    check(
      "W14: corrupt settings restore as defaults without crashing",
      !!corruptBoot && ["light", "dark"].includes(corruptBoot.theme)
        && /^#[0-9a-f]{6}$/i.test(corruptBoot.tint) && /^#[0-9a-f]{6}$/i.test(corruptBoot.accent),
      JSON.stringify(corruptBoot),
    );
    // The app is fully usable again: a fresh lookup renders normally — the
    // recovery path after dropping the bad state.
    p = await runLookup(page, "word", "食べる");
    check("corrupt state: a fresh lookup recovers the app", p.text.includes("1. to eat"), `err=${p.isError}`);

    // ---- W15: footer anchoring + credits dialog fits the screen -----------
    // body is a flex column (min-height 100dvh) and #panes flex-grows: with
    // no panes the footer pins to the viewport bottom; with a full page of
    // panes it sits in flow right after the last one. The credits panel is
    // fixed and centered, viewport-constrained wherever the page is scrolled,
    // and its body scrolls (long URLs wrap).
    // Viewport comparisons use documentElement.clientHeight/clientWidth (the
    // layout viewport the CSS resolves 100dvh/100vw against): under this
    // suite's mobile emulation window.innerHeight reports the emulated
    // visual-viewport height (1119) while the CSS viewport is 900.
    // 1. Fresh state: clear all panes → the footer bottom hugs the viewport.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector("#clear").click();
    });
    const w15Anchor = await waitFor(
      page,
      () => page.evaluate(() => {
        const f = document.querySelector("footer").getBoundingClientRect();
        const vh = document.documentElement.clientHeight;
        return Math.abs(f.bottom - vh) <= 2 ? {
          bottom: Math.round(f.bottom),
          viewportH: vh,
          panes: document.querySelectorAll("#panes .pane").length,
        } : null;
      }),
      10000,
      "footer anchored with no panes",
    );
    check(
      "W15: with no panes the footer is pinned to the viewport bottom",
      !!w15Anchor && w15Anchor.panes === 0,
      JSON.stringify(w15Anchor),
    );
    // 2. A full page: one word box with many words lands one pane each — 18
    // panes overflow the 900px viewport, and the footer sits in flow below
    // the last pane (document coordinates, so scroll position is irrelevant).
    const W15_WORDS = "水 食事 食べる 食べ物 制作者 学校 学生 先生 家族 時間 今日 明日 何 行く 見る 言う 聞く 話す";
    await page.evaluate((w) => {
      const input = document.querySelector("#query");
      input.value = w;
      document.querySelector('button[data-cmd="word"]').click();
    }, W15_WORDS);
    const w15Full = await waitFor(
      page,
      () => page.evaluate(() => {
        if (document.querySelector("#lookup").hasAttribute("aria-busy")) return null;
        const panes = [...document.querySelectorAll("#panes .pane")];
        if (panes.length < 15) return null;
        const last = panes[panes.length - 1].getBoundingClientRect();
        const footer = document.querySelector("footer").getBoundingClientRect();
        return {
          count: panes.length,
          scrollHeight: document.scrollingElement.scrollHeight,
          viewportH: document.documentElement.clientHeight,
          footerTop: footer.top + window.scrollY,
          lastPaneBottom: last.bottom + window.scrollY,
        };
      }),
      120000,
      "15+ panes",
    );
    check(
      "W15: a full page scrolls and the footer is pushed below the last pane",
      !!w15Full && w15Full.count >= 15 && w15Full.scrollHeight > w15Full.viewportH
        && w15Full.footerTop >= w15Full.lastPaneBottom,
      JSON.stringify(w15Full && {
        count: w15Full.count,
        scrollHeight: w15Full.scrollHeight,
        footerTop: Math.round(w15Full.footerTop),
        lastPaneBottom: Math.round(w15Full.lastPaneBottom),
      }),
    );
    // 3. Credits: the i disclosure opens a fixed panel fully inside the
    // viewport at scroll-top AND at the page bottom; the panel's body scrolls
    // to its end with the last link reachable.
    const w15Credits = await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector(".credits summary").click();
      const panel = document.querySelector(".credits-panel");
      const r = panel.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      return {
        open: document.querySelector(".credits").open,
        inside: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= vh,
        rect: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) },
        viewportW: vw,
        viewportH: vh,
      };
    });
    check(
      "W15: credits panel fits the viewport at scroll-top",
      !!w15Credits && w15Credits.open && w15Credits.inside,
      JSON.stringify(w15Credits),
    );
    const w15CreditsScrolled = await page.evaluate(() => {
      window.scrollTo(0, document.scrollingElement.scrollHeight);
      const panel = document.querySelector(".credits-panel");
      const r = panel.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      return {
        inside: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= vh,
        rect: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) },
        viewportH: vh,
      };
    });
    check(
      "W15: credits panel stays inside the viewport when the page is scrolled",
      !!w15CreditsScrolled && w15CreditsScrolled.inside,
      JSON.stringify(w15CreditsScrolled),
    );
    const w15CreditsEnd = await page.evaluate(() => {
      const panel = document.querySelector(".credits-panel");
      panel.scrollTop = panel.scrollHeight;
      const links = [...panel.querySelectorAll("a")];
      const last = links[links.length - 1].getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      return {
        scrollable: panel.scrollHeight > panel.clientHeight,
        reachable: panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1,
        lastInside: last.top >= pr.top - 1 && last.bottom <= pr.bottom + 1,
      };
    });
    check(
      "W15: credits panel scrolls to its end with the last link reachable",
      !!w15CreditsEnd && w15CreditsEnd.reachable && w15CreditsEnd.lastInside,
      JSON.stringify(w15CreditsEnd),
    );
    // close the disclosure and restore the scroll (clean state for the
    // console-error check below)
    await page.evaluate(() => {
      document.querySelector(".credits summary").click();
      window.scrollTo(0, 0);
    });

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
