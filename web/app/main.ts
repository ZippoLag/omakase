/**
 * UI: a full-width single-line input with three buttons — kanji / word /
 * search. Every action runs its lookup in the DB worker and inserts a fresh
 * results pane directly below the button row, pushing older panes down
 * (newest-first history).
 *
 * Actions are queued, never dropped: any number of clicks — command buttons,
 * Enter, or the per-character kanji / magnifier tokens inside result panes —
 * enqueue their lookups, and only one is processed at a time, so rapid taps
 * each still get their own pane. A `word` box holding several comma- and/or
 * space-separated words looks each word up separately (identical to typing
 * it alone and pressing word) but repeated words are looked up once — 水 水
 * queues a single word-水 lookup, not two — and a lookup that is already
 * pending (queued or in flight) is never enqueued again. A `kanji` box ignores every
 * character that is not a kanji, so each kanji it contains still gets its
 * page — and each kanji a box holds becomes its own lookup (制・作者 queues
 * kanji 制, kanji 作, kanji 者), so a multi-kanji box resolves one kanji at
 * a time: every pane is exactly what looking that character up alone
 * returns, and each appears as soon as its own lookup finishes instead of
 * after the whole batch. The `search` action is unchanged.
 *
 * While several lookups are pending (more than one action in the queue) the
 * busy button shows a small counter with how many result panes are still to
 * come, counting down as each lands.
 *
 * The input box, the last pressed command, the max count and the result
 * history are persisted to localStorage and restored on reload; each pane
 * (and the header) has a red trashbin to delete results. The queue and busy
 * chrome are wired so no user action can leave the UI stuck: a lookup that
 * errors, a worker that crashes, or one that never answers all drain back to
 * an idle, usable control row.
 */
import type { Command, StrokePage, WorkerMessage, WorkerRequest } from "./worker-api.js";
import { strokeWidgetFigure } from "./stroke-widget.js";
import { VERSION, VERSION_FULL } from "../../src/version.js";

// ---- DOM -------------------------------------------------------------------
const form = document.querySelector<HTMLFormElement>("#lookup")!;
const input = document.querySelector<HTMLInputElement>("#query")!;
const maxInput = document.querySelector<HTMLInputElement>("#max")!;
const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-cmd]");
const status = document.querySelector<HTMLDivElement>("#status")!;
const versionBadge = document.querySelector<HTMLSpanElement>("#version")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear")!;
const panes = document.querySelector<HTMLDivElement>("#panes")!;

// Version badge — the app stamp at boot; the full stamp + dictionary build
// (from DB meta) once the worker reports ready.
versionBadge.textContent = `v${VERSION}`;

// ---- state -----------------------------------------------------------------
/** One queued lookup. The queue is FIFO and only its head is ever sent to
 * the worker, whose replies pair back by id — so actions run strictly one at
 * a time no matter how many clicks land while one is in flight. */
interface Pending {
  id: number;
  command: Command;
  /** The exact text this lookup runs (captured when the action fired): a word
   * action carries a single word, a kanji action the kanji-only query. */
  query: string;
  max: number;
}

const queue: Pending[] = [];
let nextId = 1;
/** Command run by the last button click — Enter repeats it. Default: search. */
let lastCommand: Command = "search";
/** The engine reported ready — lookups may be sent. */
let ready = false;
/** A lookup has been posted and its reply has not arrived yet. */
let inFlight = false;
/** The engine failed permanently (could not boot after retries) — the only
 * state where lookups cannot run; the status bar says so and asks to reload. */
let engineDead = false;
/** Consecutive engine-downs without a ready in between (reset on ready). */
let bootFailures = 0;

// ---- persistent state (localStorage) ---------------------------------------
/** One result pane as persisted/restored (the CLI text + how it was asked).
 * `strokes` (kanji literal pages only) records the stroke-order svg file
 * behind each page character, so restored panes can re-mount the widgets. */
interface PaneRecord {
  command: string;
  query: string;
  text: string;
  error: boolean;
  strokes?: StrokePage[];
}

interface StoredState {
  v?: unknown;
  query?: unknown;
  command?: unknown;
  max?: unknown;
  panes?: unknown;
}

const STORAGE_KEY = "omakase.state";
const COMMANDS: readonly string[] = ["kanji", "word", "search"];
/** Result history, newest first — mirrors the #panes DOM order (child 0 = newest). */
let history: PaneRecord[] = [];

/** Write input, last command, max and the pane history to localStorage. */
function saveState(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, query: input.value, command: lastCommand, max: parseMax(), panes: history }),
    );
  } catch {
    /* storage unavailable (private mode / quota) — persistence is a nicety */
  }
}

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

// ---- query expansion -------------------------------------------------------
/** CJK ideographs — every displayed kanji is individually clickable. */
const KANJI_RE = /\p{Script=Han}/u;
/** Separators between words in a `word` box: commas (ASCII `,`, full-width
 * `，`, Japanese `、`) and any whitespace. */
const WORD_SEP_RE = /[\s,，、]+/u;

/** The individual words of a `word` box, in order (runs between separators). */
function wordTokens(raw: string): string[] {
  return raw.split(WORD_SEP_RE).filter((s) => s !== "");
}

/**
 * The query a `kanji` click actually runs: when the box holds at least one
 * kanji, every non-kanji character is ignored — 食べる → 食, 制・作者 →
 * 制作者 — so the page for each individual kanji still comes back. A box
 * with no kanji at all (kana or romaji, e.g. a reading search) is left
 * untouched.
 */
function kanjiQuery(raw: string): string {
  const literals = [...raw].filter((ch) => KANJI_RE.test(ch));
  return literals.length > 0 ? literals.join("") : raw.trim();
}

/**
 * The lookups a `kanji` click enqueues, in box order: when the box holds
 * kanji, ONE lookup per kanji literal — 制・作者 → 制, 作, 者 — so each
 * character's page is its own lookup, landing (and rendering) one at a time
 * instead of after the whole batch, byte-identical to looking it up alone.
 * A box with no kanji at all (kana or romaji, e.g. a reading search) stays a
 * single query, unchanged.
 */
function kanjiQueries(raw: string): string[] {
  const stripped = kanjiQuery(raw);
  return KANJI_RE.test(stripped) ? [...stripped] : [stripped];
}

// ---- queue -----------------------------------------------------------------
/**
 * Fire an action for the box's current contents (captured now, so later
 * edits never retroactively change a queued lookup) and enqueue its lookups.
 * Clicks always enqueue — they are never dropped while one lookup runs —
 * and `drain` processes the queue one entry at a time. `word` splits a
 * multi-word box into one lookup per word (each pane is exactly what looking
 * that word up alone returns); `kanji` ignores non-kanji characters; the
 * `search` action is sent verbatim.
 */
function submit(command: Command): void {
  if (engineDead) return;
  const raw = input.value;
  const queries = command === "word"
    ? wordTokens(raw)
    : command === "kanji"
      ? kanjiQueries(raw)
      : [raw.trim()];
  // Repeated lookups collapse before anything is enqueued — both repeats
  // inside one action (a word box like 水 水 queues a single lookup) and
  // lookups that are already pending: the queue's head stays in place until
  // its result lands, so this also covers whatever is in flight. A token
  // clicked twice in a row therefore gets one pane, not two. The dedupe key
  // is command + normalized query, so kanji 食 and word 食 stay distinct.
  const seen = new Set(queue.map((p) => `${p.command}\u0000${p.query}`));
  const pending: string[] = [];
  for (const q of queries) {
    const key = `${command}\u0000${q}`;
    if (q.length > 0 && !seen.has(key)) {
      seen.add(key);
      pending.push(q);
    }
  }
  if (pending.length === 0) {
    input.focus();
    return;
  }
  lastCommand = command;
  const max = parseMax();
  for (const q of pending) queue.push({ id: nextId++, command, query: q, max });
  saveState();
  syncBusyUi();
  input.select();
  drain();
}

/** Send the head of the queue to the worker — the only place requests go out. */
function drain(): void {
  if (inFlight || !ready) return;
  const item = queue[0];
  if (!item) return;
  inFlight = true;
  syncBusyUi();
  const req: WorkerRequest = { kind: "run", id: item.id, command: item.command, query: item.query, max: item.max };
  worker.postMessage(req);
  armWatchdog();
}

// ---- worker messages -------------------------------------------------------
function onWorkerMessage(ev: MessageEvent<WorkerMessage>): void {
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
      engineDead = false;
      bootFailures = 0;
      document.documentElement.style.setProperty("--progress", "100%");
      versionBadge.title = `omakase ${VERSION_FULL}${msg.dict ? ` · dictionary build: ${msg.dict}` : ""}`;
      setStatus(`ready — ${msg.words.toLocaleString()} words · v${VERSION_FULL} · SQLite ${msg.version} (100% offline)`);
      syncBusyUi();
      drain();
      if (queue.length === 0) input.focus();
      break;
    case "result":
      handleResult(msg);
      break;
    case "fatal":
      engineDown(msg.message);
      break;
  }
}

/**
 * A lookup answered. The worker replies strictly in queue order, so the head
 * is ours; anything else is a stray from a dead engine and is ignored rather
 * than trusted. Whatever the outcome, the busy chrome and queue are synced
 * afterwards, so the UI always returns to a usable state.
 */
function handleResult(msg: Extract<WorkerMessage, { kind: "result" }>): void {
  disarmWatchdog();
  const item = queue[0] ?? null;
  inFlight = false;
  if (item && item.id === msg.id) {
    queue.shift();
    try {
      if (msg.text !== null) addPane(item.command, item.query, msg.text, false, msg.strokes);
      else if (msg.error !== null) addPane(item.command, item.query, msg.error, true);
    } catch (err) {
      // A pane must never wedge the queue: report and keep draining.
      console.error("could not render result pane:", err);
    }
  }
  syncBusyUi();
  drain();
}

// ---- busy chrome -----------------------------------------------------------
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

/** Button currently showing the spinner (its label is hidden). */
let spinnerOn: HTMLButtonElement | null = null;

/** Remove the spinner from whatever button carries it (restores the label). */
function removeSpinner(): void {
  if (!spinnerOn) return;
  const b = spinnerOn;
  b.classList.remove("busy");
  b.textContent = b.dataset.label ?? "";
  delete b.dataset.label;
  spinnerOn = null;
}

/**
 * Keep the busy chrome consistent with the queue: while lookups are pending
 * the form is aria-busy, the inputs and command buttons are disabled, and
 * the spinner sits on the button of the lookup at the head of the queue (it
 * hops buttons when the next queued lookup uses another command). Every path
 * out of a lookup — reply, engine failure, timeout — funnels back through
 * here, so once the queue drains the controls are always re-enabled and the
 * pressed button's label is always restored.
 */
function syncBusyUi(): void {
  const head = queue[0] ?? null;
  const button = head ? buttonFor(head.command) : null;
  if (button !== spinnerOn) {
    removeSpinner();
    if (button && head) {
      button.dataset.label = button.textContent ?? "";
      button.textContent = "";
      button.classList.add("busy");
      const spin = document.createElement("span");
      spin.className = "spinner";
      spin.setAttribute("aria-hidden", "true");
      button.appendChild(spin);
      spinnerOn = button;
    }
  }
  // Small queue counter: while more than one lookup is pending (the queue
  // holds the in-flight head plus anything queued behind it) the busy button
  // shows how many panes are still to come, counting down as each lands.
  if (spinnerOn) {
    const pendingCount = queue.length;
    let counter = spinnerOn.querySelector<HTMLSpanElement>(".queue-n");
    if (pendingCount > 1) {
      if (!counter) {
        counter = document.createElement("span");
        counter.className = "queue-n";
        counter.setAttribute("aria-hidden", "true");
        spinnerOn.appendChild(counter);
      }
      counter.textContent = String(pendingCount);
    } else if (counter) {
      counter.remove();
    }
  }
  if (head) form.setAttribute("aria-busy", "true");
  else form.removeAttribute("aria-busy");
  setControlsDisabled(!!head || !ready);
}

/** The engine is down — worker crashed, a lookup timed out, or a boot
 * failed. Whatever lookup was in flight will never be answered: it is
 * surfaced as an error pane and dropped, the engine is restarted, and the
 * rest of the queue drains once the fresh engine reports ready. Only after
 * several consecutive failures does the app give up (the environment cannot
 * run the engine) — it then settles into a clear error state instead of
 * spinning forever, and reloading the page restarts it. */
function engineDown(message: string): void {
  disarmWatchdog();
  const lost = inFlight ? (queue[0] ?? null) : null;
  inFlight = false;
  if (lost) {
    queue.shift();
    try {
      addPane(lost.command, lost.query, `engine error — ${message}`, true);
    } catch {
      /* never wedge on a pane */
    }
  }
  ready = false;
  bootFailures++;
  if (bootFailures >= MAX_BOOT_FAILURES) {
    engineDead = true;
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        addPane(item.command, item.query, `engine error — ${message}`, true);
      } catch {
        /* never wedge on a pane */
      }
    }
    removeSpinner();
    form.removeAttribute("aria-busy");
    setControlsDisabled(true);
    setStatus(`⚠ ${message} — reload the page to restart the app`, "error");
    return;
  }
  setStatus(`⚠ engine hiccup — restarting…`, "busy");
  worker.terminate();
  worker = makeWorker();
  syncBusyUi();
  drain(); // no-op until the fresh engine reports ready
}

// ---- watchdog --------------------------------------------------------------
/** A lookup should never hang the UI: if the worker stops answering, treat
 * it as an engine failure (drops the stuck lookup with an error pane and
 * restarts the engine). Generous — the first cold lookup after the
 * dictionary import can take a while on slow devices. */
const LOOKUP_TIMEOUT_MS = 120000;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function armWatchdog(): void {
  disarmWatchdog();
  watchdog = setTimeout(() => engineDown("a lookup took too long"), LOOKUP_TIMEOUT_MS);
}

function disarmWatchdog(): void {
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

// ---- worker lifecycle ------------------------------------------------------
function onWorkerError(ev: ErrorEvent): void {
  engineDown(ev.message ? `engine crashed (${ev.message})` : "engine crashed");
}

/** Consecutive engine failures before giving up (reset on every ready). */
const MAX_BOOT_FAILURES = 3;

/** The engine worker — recreated on crash so the app keeps working. */
let worker = makeWorker();

function makeWorker(): Worker {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  w.onmessage = onWorkerMessage;
  w.onerror = onWorkerError;
  return w;
}

// ---- interactive tokens -----------------------------------------------------
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

/** Trashbin glyph for the per-pane and header delete buttons (red via CSS). */
const TRASH_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" ' +
  'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 14h10l1-14"/></svg>';

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
 * at its left when it is an actual dictionary word (contains kanji or kana —
 * even a single character). Bracket contents (readings/ruby) are left plain
 * apart from their own kanji being clickable.
 */
function linkifyLine(line: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  const m = WORD_ROW_RE.exec(line);
  let cursor = 0;
  if (m) {
    const writingStart = m[1]!.length;
    const writing = m[2]!;
    if (KANJI_RE.test(writing) || KANA_RE.test(writing)) {
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
/**
 * Build one results pane: a small header (command · query · trashbin) + the
 * CLI text. Deleting via the trashbin removes the pane and its history
 * record (persisted), leaving the rest of the history intact.
 */
function renderPane(rec: PaneRecord): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "pane";
  if (rec.error) pane.classList.add("error");

  const head = document.createElement("div");
  head.className = "pane-head";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = rec.command;
  const q = document.createElement("span");
  q.className = "pane-query";
  q.textContent = rec.query;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "pane-del";
  del.title = "Delete this result";
  del.setAttribute("aria-label", `Delete result for ${rec.query}`);
  del.innerHTML = TRASH_ICON_SVG;
  del.addEventListener("click", () => {
    history = history.filter((r) => r !== rec);
    pane.remove();
    updateClearButton();
    saveState();
  });
  head.append(badge, q, del);

  const pre = document.createElement("pre");
  const content = rec.text.endsWith("\n") ? rec.text.slice(0, -1) : rec.text;
  const nodes: (Node | string)[] = [];
  content.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push("\n");
    nodes.push(...linkifyLine(line));
  });
  pre.append(...nodes);

  pane.append(head, pre);
  return pane;
}

/** Add a fresh result pane (newest first) and persist the history. */
function addPane(
  command: string,
  query: string,
  text: string,
  isError: boolean,
  strokes?: StrokePage[],
): void {
  const rec: PaneRecord = { command, query, text, error: isError, ...(strokes && strokes.length > 0 ? { strokes } : {}) };
  history.unshift(rec);
  updateClearButton();
  const pane = renderPane(rec);
  panes.prepend(pane); // newest pane sits directly below the button row
  attachStrokeWidgets(pane, rec.strokes);
  pane.scrollIntoView({ block: "start", behavior: "smooth" });
  saveState();
}

/**
 * Stroke-order widgets live between a pane's header and its text: one figure
 * per page character (kanji 制作者 gets three). Widgets fetch their svg
 * lazily and remove themselves when no diagram is available, so this is a
 * pure enhancement — the text pane renders regardless.
 */
function attachStrokeWidgets(pane: HTMLElement, strokes: StrokePage[] | undefined): void {
  if (!strokes || strokes.length === 0) return;
  const strip = document.createElement("div");
  strip.className = "stroke-strip";
  for (const page of strokes) strip.appendChild(strokeWidgetFigure(page));
  const pre = pane.querySelector("pre");
  if (pre) pane.insertBefore(strip, pre);
}

/** The header trashbin is enabled only while there is history to delete. */
function updateClearButton(): void {
  clearBtn.disabled = history.length === 0;
}

/** Header trashbin: remove every result pane and clear the persisted history. */
function clearAll(): void {
  history = [];
  panes.replaceChildren();
  updateClearButton();
  saveState();
}

/** Restore input, max, last command and the result history from storage. */
function restoreState(): void {
  let stored: StoredState | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as StoredState | null;
  } catch {
    /* corrupt storage — start fresh */
  }
  if (!stored || stored.v !== 1) {
    setLastCommand("search");
    return;
  }
  if (typeof stored.query === "string") input.value = stored.query;
  const m = Number(stored.max);
  if (Number.isInteger(m) && m >= 1) maxInput.value = String(m);
  const command = typeof stored.command === "string" && COMMANDS.includes(stored.command)
    ? (stored.command as Command)
    : "search";
  setLastCommand(command);
  if (Array.isArray(stored.panes)) {
    for (const rec of stored.panes) {
      if (
        rec && typeof rec === "object"
        && typeof (rec as PaneRecord).command === "string"
        && typeof (rec as PaneRecord).query === "string"
        && typeof (rec as PaneRecord).text === "string"
      ) {
        const r = rec as PaneRecord;
        const strokes: StrokePage[] | undefined = Array.isArray(r.strokes)
          ? r.strokes.filter(
              (s) => s && typeof s.literal === "string" && typeof s.svgFile === "string",
            )
          : undefined;
        history.push({
          command: r.command,
          query: r.query,
          text: r.text,
          error: !!r.error,
          ...(strokes && strokes.length > 0 ? { strokes } : {}),
        });
      }
    }
    // history is newest-first; appending in order reproduces the DOM order.
    for (const rec of history) {
      const pane = renderPane(rec);
      panes.append(pane);
      attachStrokeWidgets(pane, rec.strokes);
    }
  }
  updateClearButton();
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
    saveState(); // persist the command even when the query is empty (submit bails)
  });
}
form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  submit(lastCommand);
});
input.addEventListener("input", saveState);
maxInput.addEventListener("input", saveState);
clearBtn.addEventListener("click", clearAll);

// ---- service worker (offline shell; the dictionary lives in OPFS) ----------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch((err: unknown) => {
      console.warn("service worker registration failed (app still works online):", err);
    });
  });
}
clearBtn.innerHTML = TRASH_ICON_SVG;
restoreState(); // input, max, last command and pane history from localStorage
setControlsDisabled(true);
setStatus("starting engine…", "busy");
