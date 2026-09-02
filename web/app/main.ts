/**
 * UI: a full-width single-line input with three buttons — kanji / word /
 * search. Every click runs the lookup in the DB worker and inserts a fresh
 * results pane directly below the button row, pushing older panes down
 * (newest-first history).
 */
import type { Command, WorkerMessage, WorkerRequest } from "./worker-api.js";

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

// ---- DOM -------------------------------------------------------------------
const form = document.querySelector<HTMLFormElement>("#lookup")!;
const input = document.querySelector<HTMLInputElement>("#query")!;
const maxInput = document.querySelector<HTMLInputElement>("#max")!;
const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-cmd]");
const status = document.querySelector<HTMLDivElement>("#status")!;
const panes = document.querySelector<HTMLDivElement>("#panes")!;

// ---- state -----------------------------------------------------------------
/** Queue of lookups waiting for the worker (single in-flight at a time). */
const queue: { id: number; command: Command; query: string; max: number }[] = [];
let busy = false;
let nextId = 1;
/** Command run by the last button click — Enter repeats it. Default: search. */
let lastCommand: Command = "search";
let ready = false;

/**
 * Per-list row cap from the "max" input: a positive integer, else the
 * default (30). Non-integer / empty / out-of-range values fall back.
 */
function parseMax(): number {
  const v = Number(maxInput.value);
  return Number.isInteger(v) && v >= 1 ? v : 30;
}

function setStatus(text: string, extraClass = ""): void {
  status.textContent = text;
  status.className = extraClass;
}

function fmtMB(n: number): string {
  return `${Math.max(0, Math.round(n / 1048576))} MB`;
}

// ---- worker messages -------------------------------------------------------
worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case "status":
      setStatus(msg.text);
      break;
    case "progress": {
      const pct = msg.totalBytes > 0 ? Math.round((msg.loadedBytes / msg.totalBytes) * 100) : 0;
      setStatus(`Importing dictionary… ${pct}% (${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)})`, "busy");
      document.documentElement.style.setProperty("--progress", `${pct}%`);
      break;
    }
    case "ready":
      ready = true;
      document.documentElement.style.setProperty("--progress", "100%");
      setStatus(`ready — ${msg.words.toLocaleString()} words · SQLite ${msg.version} (100% offline)`);
      setControlsDisabled(false);
      input.focus();
      drain();
      break;
    case "result": {
      const head = queue.shift();
      busy = false;
      const item = head && head.id === msg.id ? head : null;
      if (msg.text !== null) addPane(item?.command ?? "result", item?.query ?? "", msg.text, false);
      else if (msg.error !== null) addPane(item?.command ?? "result", item?.query ?? "", msg.error, true);
      clearBusy();
      setControlsDisabled(false);
      drain();
      break;
    }
    case "fatal":
      clearBusy();
      setStatus(`⚠ ${msg.message}`, "error");
      setControlsDisabled(true);
      break;
  }
};

worker.onerror = (ev: ErrorEvent) => {
  clearBusy();
  setStatus(`⚠ worker crashed: ${ev.message ?? "unknown error"}`, "error");
  setControlsDisabled(true);
};

// ---- queue -----------------------------------------------------------------
function drain(): void {
  if (busy || !ready) return;
  const item = queue[0];
  if (!item) return;
  busy = true;
  const req: WorkerRequest = { kind: "run", id: item.id, command: item.command, query: item.query, max: item.max };
  worker.postMessage(req);
}

function submit(command: Command): void {
  if (busy) return; // one operation at a time — the busy UI blocks new input anyway
  const query = input.value;
  if (!query.trim()) {
    input.focus();
    return;
  }
  lastCommand = command;
  queue.push({ id: nextId++, command, query, max: parseMax() });
  beginBusy(command);
  input.select();
  drain();
}

// ---- busy state -------------------------------------------------------------
/** Command whose lookup is in flight (null when idle) — its label is a spinner. */
let busyCommand: Command | null = null;

function buttonFor(command: Command): HTMLButtonElement | null {
  for (const b of buttons) {
    if (b.dataset.cmd === command) return b;
  }
  return null;
}

/** Highlight the active command button (default: search). */
function setLastCommand(command: Command): void {
  lastCommand = command;
  for (const b of buttons) b.classList.toggle("primary", b.dataset.cmd === command);
}

/** Disable everything and swap the pressed button's label for a spinner. */
function beginBusy(command: Command): void {
  busyCommand = command;
  form.setAttribute("aria-busy", "true");
  setControlsDisabled(true);
  const b = buttonFor(command);
  if (b) {
    b.dataset.label = b.textContent ?? "";
    b.textContent = "";
    b.classList.add("busy");
    const spin = document.createElement("span");
    spin.className = "spinner";
    spin.setAttribute("aria-hidden", "true");
    b.appendChild(spin);
  }
}

/** Put the button label back and mark the form idle (does not touch disabled). */
function clearBusy(): void {
  if (busyCommand !== null) {
    const b = buttonFor(busyCommand);
    if (b) {
      b.classList.remove("busy");
      b.textContent = b.dataset.label ?? "";
      delete b.dataset.label;
    }
    busyCommand = null;
  }
  form.removeAttribute("aria-busy");
}

// ---- interactive tokens -----------------------------------------------------
/** CJK ideographs — every displayed kanji is individually clickable. */
const KANJI_RE = /\p{Script=Han}/u;
/** Hiragana/katakana — a writing containing kana is a word, not a lone kanji. */
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * “Word row” — `  writing  [reading/ruby]  gloss…`, the shape used by
 * compounds, multi-kanji Words, search hits, thesaurus and deconjugate rows.
 * The bracket group allows nested ruby like `食[たべ]物[もの]`.
 */
const WORD_ROW_RE = /^(\s*)([^\[]*?)\s{2}\[((?:[^\[\]]|\[[^\[\]]*\])*)\](.*)$/;

/** Magnifier glyph for word-lookup buttons (inline SVG, monochrome). */
const WORD_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" ' +
  'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
  '<circle cx="11" cy="11" r="7"/><path d="m16.3 16.3 4.2 4.2"/></svg>';

/** One kanji character as a button → `kanji <ch>` lookup. */
function kanjiButton(ch: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tok tok-kanji";
  b.textContent = ch;
  b.title = `kanji ${ch}`;
  b.addEventListener("click", () => {
    input.value = ch;
    submit("kanji");
  });
  return b;
}

/** A word-lookup icon at the left of a word → `word <writing>` lookup. */
function wordIconButton(writing: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tok tok-word";
  b.title = `word ${writing}`;
  b.setAttribute("aria-label", `look up “${writing}”`);
  b.innerHTML = WORD_ICON_SVG;
  b.addEventListener("click", () => {
    input.value = writing;
    submit("word");
  });
  return b;
}

/**
 * Render one output line as DOM nodes: every kanji becomes an individual
 * kanji-lookup button; on word rows the writing also gets a word-lookup icon
 * at its left when it is an actual dictionary word (contains kana or multiple
 * kanji — a standalone single kanji stays kanji-only). Bracket contents
 * (readings/ruby) are left plain apart from their own kanji being clickable.
 */
function linkifyLine(line: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const m = WORD_ROW_RE.exec(line);
  let cursor = 0;
  if (m) {
    const writingStart = m[1]!.length;
    const writing = m[2]!;
    const hanCount = [...writing].filter((c) => KANJI_RE.test(c)).length;
    if (KANA_RE.test(writing) || hanCount >= 2) {
      out.push(line.slice(cursor, writingStart));
      out.push(wordIconButton(writing));
      cursor = writingStart;
    }
  }
  for (const ch of line.slice(cursor)) {
    out.push(KANJI_RE.test(ch) ? kanjiButton(ch) : ch);
  }
  return out;
}

// ---- panes -----------------------------------------------------------------
/** One results pane: a small header (command · query) + the CLI text. */
function addPane(command: string, query: string, text: string, isError: boolean): void {
  const pane = document.createElement("section");
  pane.className = "pane";
  if (isError) pane.classList.add("error");

  const head = document.createElement("div");
  head.className = "pane-head";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = command;
  const q = document.createElement("span");
  q.className = "pane-query";
  q.textContent = query;
  head.append(badge, q);

  const pre = document.createElement("pre");
  const content = text.endsWith("\n") ? text.slice(0, -1) : text;
  const nodes: (Node | string)[] = [];
  content.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push("\n");
    nodes.push(...linkifyLine(line));
  });
  pre.append(...nodes);

  pane.append(head, pre);
  panes.prepend(pane); // newest pane sits directly below the button row
  pane.scrollIntoView({ block: "start", behavior: "smooth" });
}

function setControlsDisabled(v: boolean): void {
  input.disabled = v;
  maxInput.disabled = v;
  for (const b of buttons) b.disabled = v;
}

// ---- events ----------------------------------------------------------------
for (const b of buttons) {
  b.addEventListener("click", () => {
    setLastCommand(b.dataset.cmd as Command);
    submit(b.dataset.cmd as Command);
  });
}
form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  submit(lastCommand);
});

// ---- service worker (offline shell; the dictionary lives in OPFS) ----------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch((err: unknown) => {
      console.warn("service worker registration failed (app still works online):", err);
    });
  });
}

setLastCommand("search"); // default action + highlight: search
setControlsDisabled(true);
setStatus("starting engine…", "busy");
