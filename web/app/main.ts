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
 * Every lookup streams: the pane (header + skeleton rows) appears the moment
 * its lookup starts, the worker posts each rendered section as it completes
 * (entry body → thesaurus → examples for word, Readings → Meanings → Kanji
 * for search, the page for kanji), and the pane body fills in as sections
 * land — the divider bar under the controls shows the current operation's
 * completion (ladder floors per section, real counted % inside the long
 * meaning search), and the % readout sits next to the status message.
 *
 * While several lookups are pending, each command button shows a small badge
 * with how many panes of ITS kind are still queued behind the one in flight
 * (the spinner marks the running lookup), counting down as each lands.
 *
 * The input box, the last pressed command, the max count and the result
 * history are persisted to localStorage and restored on reload; each pane
 * (and the header) has a red trashbin to delete results. The queue and busy
 * chrome are wired so no user action can leave the UI stuck: a lookup that
 * errors, a worker that crashes, or one that never answers all drain back to
 * an idle, usable control row.
 */
import { OP_LADDERS } from "./worker-api.js";
import type { Command, StrokePage, WorkerMessage, WorkerRequest } from "./worker-api.js";
import { strokeWidgetFigure } from "./stroke-widget.js";
import { VERSION, VERSION_FULL } from "../../src/version.js";

// ---- DOM -------------------------------------------------------------------
const form = document.querySelector<HTMLFormElement>("#lookup")!;
const input = document.querySelector<HTMLInputElement>("#query")!;
const maxInput = document.querySelector<HTMLInputElement>("#max")!;
const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-cmd]");
const status = document.querySelector<HTMLDivElement>("#status")!;
/** The status line's message text (the % readout below is a sibling span). */
const statusMsg = document.querySelector<HTMLSpanElement>("#status .status-msg")!;
/** Live “x%” readout shown next to the status while the engine boots. */
const pctEl = document.querySelector<HTMLSpanElement>("#status .pct")!;
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
/** Track cancelled operation IDs to ignore their results when they arrive. */
const cancelledOps = new Set<number>();

// ---- per-operation streaming + progress -------------------------------------
/** Skeleton panes keyed by the in-flight request id (created at drain). */
const paneByOpId = new Map<number, HTMLElement>();
/** Raw section texts per request, concatenated into the final pane text. */
const opTexts = new Map<number, string[]>();
/** The request whose sections/progress currently drive the divider bar. */
let opActiveId: number | null = null;
let opCommand: Command | null = null;
/** Last ladder label claimed by a streamed section (drives the next eased target). */
let lastSectionClaimed: string | null = null;
/** Monotonic progress floor of the current operation (0–100, never backwards). */
let opFloor = 0;
/** Eased creep between sections (the bar keeps moving during sync stretches). */
let opTicker: ReturnType<typeof setInterval> | null = null;
/** Word count from the ready message, for restoring the idle status line. */
let readyWords = 0;

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
  statusMsg.textContent = text;
  status.className = extraClass;
}

function fmtMB(n: number): string {
  return `${Math.max(0, Math.round(n / 1048576))} MB`;
}

// ---- boot progress ---------------------------------------------------------
/** Latest boot progress %, monotonic — the divider bar under the controls
 * only ever fills (a tiny dot at 0%, the full line at 100% = ready). The
 * worker announces each startup stage as it completes (see worker.ts), so
 * the bar tracks real milestones; the CSS width transition smooths the jumps
 * between them. */
let bootPct = 0;
/** Last integer % written to the readout (skip redundant DOM writes). */
let lastPctText = -1;

function setBootPct(pct: number): void {
  if (!Number.isFinite(pct) || pct < bootPct) return; // stale/restart — never backwards
  bootPct = Math.min(pct, 100);
  pctEl.hidden = false;
  const shown = Math.round(bootPct);
  if (shown !== lastPctText) {
    lastPctText = shown;
    pctEl.textContent = `${shown}%`;
  }
  document.documentElement.style.setProperty("--progress", `${bootPct}%`);
}

/** Boot is over (or the engine died): hide the readout, park the bar. */
function endBootProgress(): void {
  bootPct = 0;
  lastPctText = -1;
  pctEl.textContent = "";
  pctEl.hidden = true;
  document.documentElement.style.setProperty("--progress", "0%");
}

// ---- per-operation progress (the divider bar + % readout during lookups) ---
/** A lookup started: reset the bar to its dot and ease toward the first floor. */
function startOpProgress(item: Pending): void {
  endOpProgress();
  opActiveId = item.id;
  opCommand = item.command;
  lastSectionClaimed = null;
  // Reset the shared monotonic driver (boot is long over by now).
  bootPct = 0;
  lastPctText = -1;
  pctEl.hidden = false;
  setOpPct(0);
  setStatus(`looking up ${item.query}…`, "busy");
  armOpTicker(item.command);
}

/** A streamed section landed: claim its ladder floor, ease toward the next. */
function opSectionClaim(label: string): void {
  if (opActiveId === null || opCommand === null) return;
  lastSectionClaimed = label;
  const floor = OP_LADDERS[opCommand].floors[label] ?? 100;
  setOpPct(floor);
  armOpTicker(opCommand);
}

/** Monotonic progress write (shares the boot driver; ops reset it first). */
function setOpPct(pct: number): void {
  if (!Number.isFinite(pct)) return;
  if (pct > opFloor) opFloor = pct;
  setBootPct(pct);
}

function disarmOpTicker(): void {
  if (opTicker !== null) {
    clearInterval(opTicker);
    opTicker = null;
  }
}

/**
 * Eased creep toward the next section's floor while waiting for it — the
 * synchronous stretches between sections have no measurable progress, so
 * without this the bar would freeze mid-op. Counted sections (search
 * meanings) own the bar instead: the creep only proves liveness until the
 * first counted value lands, then real values climb it monotonically.
 */
function armOpTicker(command: Command): void {
  disarmOpTicker();
  const ladder = OP_LADDERS[command];
  const idx = lastSectionClaimed ? ladder.order.indexOf(lastSectionClaimed) : -1;
  const next = idx >= 0 && idx + 1 < ladder.order.length ? ladder.order[idx + 1]! : null;
  let target: number;
  if (next === null) {
    target = 99; // every section streamed — creep toward the finish line
  } else if (ladder.counted.has(next)) {
    target = Math.min(opFloor + 5, 99); // the counted section drives the climb
  } else {
    target = Math.max(Math.min(ladder.floors[next] ?? 99, 99), opFloor + 0.5);
  }
  opTicker = setInterval(() => {
    setOpPct(opFloor + (target - opFloor) * 0.15);
  }, 150);
}

/**
 * The operation finished (or the engine died): stop the creep. With the queue
 * drained the divider rests at its full line, the % readout hides and the
 * terse ready line returns; with more panes queued the next drain resets the
 * bar to its dot.
 */
function endOpProgress(): void {
  disarmOpTicker();
  opActiveId = null;
  opCommand = null;
  lastSectionClaimed = null;
  opFloor = 0;
  if (queue.length === 0) {
    pctEl.textContent = "";
    pctEl.hidden = true;
    document.documentElement.style.setProperty("--progress", "100%");
    setStatus(`ready — ${readyWords.toLocaleString()} words (100% offline)`);
  }
}

// ---- streaming panes --------------------------------------------------------
/**
 * The pane for a dequeued lookup, created immediately: header + a few
 * skeleton rows (the worker's streamed sections fill the body in). Kept out
 * of the history until its final `result` lands, so a crash mid-lookup never
 * persists a half-built pane.
 */
function addSkeletonPane(item: Pending): void {
  const pane = document.createElement("section");
  pane.className = "pane streaming";
  const head = document.createElement("div");
  head.className = "pane-head";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.command;
  const q = document.createElement("span");
  q.className = "pane-query";
  q.textContent = item.query;
  head.append(badge, q);
  const pre = document.createElement("pre");
  for (let i = 0; i < 3; i++) {
    const line = document.createElement("span");
    line.className = "skel-line";
    line.style.width = `${[88, 64, 76][i]}%`;
    pre.appendChild(line);
  }
  pane.append(head, pre);
  panes.prepend(pane);
  pane.scrollIntoView({ block: "start", behavior: "smooth" });
  paneByOpId.set(item.id, pane);
  opTexts.set(item.id, []);
}

/** Append one streamed section's text (linkified, like the final pane). The
 * trailing newline is kept — never stripped: every section already carries
 * the separator before the next one, so stripping it collapsed the blank
 * lines between sections while streaming (body/thesaurus sat on adjacent
 * lines, the search hint glued to the last row) until the final rebuild
 * popped them back in. Appending the raw text keeps the mid-stream layout
 * identical to the finished pane. The skeleton shimmer rows are cleared the
 * moment the first section lands — they are a placeholder, never left
 * stacked above the streamed text (later appends find none left). */
function appendSectionText(pre: HTMLElement, text: string): void {
  pre.querySelectorAll(".skel-line").forEach((el) => el.remove());
  const nodes: (Node | string)[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push("\n");
    nodes.push(...linkifyLine(line));
  });
  pre.append(...nodes);
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

/** Add a pane indicating the operation was cancelled. */
function addCancelledPane(command: string, query: string): void {
  const pane = document.createElement("section");
  pane.className = "pane error cancelled";
  
  const head = document.createElement("div");
  head.className = "pane-head";
  
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = command;
  
  const q = document.createElement("span");
  q.className = "pane-query";
  q.textContent = query;
  
  const del = document.createElement("button");
  del.type = "button";
  del.className = "pane-del";
  del.title = "Delete this result";
  del.setAttribute("aria-label", `Delete result for ${query}`);
  del.innerHTML = TRASH_ICON_SVG;
  del.addEventListener("click", () => {
    pane.remove();
    updateClearButton();
  });
  
  head.append(badge, q, del);
  
  const pre = document.createElement("pre");
  pre.textContent = "operation cancelled";
  
  pane.append(head, pre);
  panes.prepend(pane);
  pane.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** Cancel the currently-running operation only (head of queue). */
function cancelCurrentOperation(): void {
  const head = queue[0];
  if (!head) return;
  
  // Mark as cancelled and clean up
  cancelledOps.add(head.id);
  queue.shift();
  inFlight = false;
  
  // Remove skeleton pane and replace with cancelled message
  const skeletonPane = paneByOpId.get(head.id);
  if (skeletonPane) {
    skeletonPane.remove();
  }
  paneByOpId.delete(head.id);
  opTexts.delete(head.id);
  
  if (opActiveId === head.id) {
    opActiveId = null;
    opCommand = null;
    endOpProgress();
  }
  
  // Add cancelled pane for user visibility
  addCancelledPane(head.command, head.query);
  
  // Update UI and process next
  syncBusyUi();
  drain();
}

/** Send the head of the queue to the worker — the only place requests go out. */
function drain(): void {
  if (inFlight || !ready) return;
  const item = queue[0];
  if (!item) return;
  inFlight = true;
  // The pane appears now (header + skeleton body) and fills in as the
  // worker streams its sections — no more blank waiting for the whole batch.
  addSkeletonPane(item);
  syncBusyUi();
  startOpProgress(item);
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
    case "boot":
      setBootPct(msg.pct);
      break;
    case "progress": {
      setBootPct(msg.pct);
      // The % lives in the readout next to the message; the text carries the
      // byte counts for scale (the readout is the overall boot %, not the
      // dictionary's download %).
      setStatus(`Importing dictionary… ${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)}`, "busy");
      break;
    }
    case "op-section": {
      // A streamed section of the in-flight lookup: append it to the skeleton
      // pane and claim its floor on the operation ladder.
      // Skip if this operation was cancelled
      if (cancelledOps.has(msg.id)) break;
      const pane = paneByOpId.get(msg.id);
      if (pane) {
        const pre = pane.querySelector("pre");
        if (pre) appendSectionText(pre, msg.text);
      }
      const texts = opTexts.get(msg.id);
      if (texts) texts.push(msg.text);
      opSectionClaim(msg.label);
      break;
    }
    case "op-progress": {
      // Counted progress (search meanings): follow the worker's absolute %
      // verbatim — real work, not easing — and show its phase label. Both
      // writes are gated on the ACTIVE op: a message for a lookup that
      // already finished (or never started on this engine) must neither nudge
      // the gauge nor clobber the status line. In-order delivery makes a
      // stray unreachable, but a dead engine's late messages stay inert.
      if (opActiveId !== msg.id || cancelledOps.has(msg.id)) break;
      setOpPct(msg.pct);
      setStatus(msg.text, "busy");
      break;
    }
    case "ready":
      ready = true;
      engineDead = false;
      bootFailures = 0;
      readyWords = msg.words;
      versionBadge.title = `omakase ${VERSION_FULL}${msg.dict ? ` · dictionary build: ${msg.dict}` : ""}`;
      // The full stamp (build, commits, SQLite version) lives in the header
      // badge's hover tooltip — the status bar just says it's ready.
      setStatus(`ready — ${msg.words.toLocaleString()} words (100% offline)`);
      endBootProgress(); // hide the % readout…
      // …and leave the divider as the full line (its resting look).
      document.documentElement.style.setProperty("--progress", "100%");
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
  
  // Skip processing if this operation was cancelled
  if (cancelledOps.has(msg.id)) {
    cancelledOps.delete(msg.id);
    if (item?.id === msg.id) {
      queue.shift();
    }
    // Clean up any in-progress state
    paneByOpId.delete(msg.id);
    opTexts.delete(msg.id);
    if (opActiveId === msg.id) {
      opActiveId = null;
      opCommand = null;
    }
    endOpProgress();
    syncBusyUi();
    drain();
    return;
  }
  
  if (item && item.id === msg.id) {
    queue.shift();
    const pane = paneByOpId.get(msg.id);
    paneByOpId.delete(msg.id);
    const streamedText = opTexts.get(msg.id)?.join("") ?? "";
    opTexts.delete(msg.id);
    try {
      if (msg.error !== null) {
        if (pane) pane.remove();
        addPane(item.command, item.query, msg.error, true);
      } else if (msg.text !== null) {
        // Legacy whole-result path (no sections streamed).
        if (pane) pane.remove();
        addPane(item.command, item.query, msg.text, false, msg.strokes);
      } else {
        // Streamed success: the sections already rendered the pane — swap the
        // skeleton for the canonical pane (trashbin + history + linkified
        // text) built from the concatenated sections, byte-identical to what
        // the CLI would have printed.
        if (pane) pane.remove();
        if (streamedText !== "") addPane(item.command, item.query, streamedText, false, msg.strokes);
        else addPane(item.command, item.query, "(empty result)", true); // defensive: hits always stream
      }
    } catch (err) {
      // A pane must never wedge the queue: report and keep draining.
      console.error("could not render result pane:", err);
    }
  }
  endOpProgress(); // queue empty → park the bar and restore the ready line
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
/** Cancel button for the currently running operation. */
let cancelBtnOn: HTMLButtonElement | null = null;

/** Remove the spinner and cancel button from whatever button carries it (restores the label). */
function removeSpinner(): void {
  if (!spinnerOn) return;
  const b = spinnerOn;
  b.classList.remove("busy");
  b.textContent = b.dataset.label ?? "";
  delete b.dataset.label;
  spinnerOn = null;
  
  // Also remove cancel button if it exists
  if (cancelBtnOn) {
    cancelBtnOn.remove();
    cancelBtnOn = null;
  }
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
  // Per-command pending badges FIRST: every button shows how many panes of
  // its kind are still queued BEHIND the in-flight head (the spinner marks
  // the head; the badge counts only what is still to come). A [kanji, kanji,
  // word] queue therefore shows a badge on kanji AND on word, each ticking
  // down as its panes land — instead of a single total on the active button,
  // which told you nothing about the other kinds waiting behind it. The
  // badge pass must run BEFORE the spinner logic below: the spinner captures
  // the button's label to restore later, and a badge still attached at that
  // point would bake its number into the restored label ("kanji1").
  for (const b of buttons) {
    const cmd = b.dataset.cmd as Command;
    const queued = queue.slice(1).filter((p) => p.command === cmd).length;
    let badge = b.querySelector<HTMLSpanElement>(".btn-n");
    if (queued > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "btn-n";
        badge.setAttribute("aria-hidden", "true");
        b.appendChild(badge);
      }
      badge.textContent = String(queued);
    } else if (badge) {
      badge.remove();
    }
  }
  if (button !== spinnerOn) {
    removeSpinner();
    if (button && head) {
      // The label to restore is the button's command name — NEVER its live
      // textContent: the per-command badges live inside the button, so a
      // textContent snapshot would bake a badge number into the restored
      // label ("kanji2") whether the badge is being added or removed in the
      // same pass.
      button.dataset.label = button.dataset.cmd ?? "";
      button.textContent = "";
      button.classList.add("busy");
      const spin = document.createElement("span");
      spin.className = "spinner";
      spin.setAttribute("aria-hidden", "true");
      button.appendChild(spin);
      
      // Add cancel button alongside spinner
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cancel-btn";
      cancel.textContent = "×";
      cancel.title = "Cancel";
      cancel.setAttribute("aria-label", "Cancel current lookup");
      cancel.addEventListener("click", (ev) => {
        ev.stopPropagation();
        cancelCurrentOperation();
      });
      button.appendChild(cancel);
      cancelBtnOn = cancel;
      
      spinnerOn = button;
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
    // The in-flight lookup's skeleton pane becomes an error pane — never a
    // duplicate (the skeleton must not linger next to a fresh error pane).
    const pane = paneByOpId.get(lost.id);
    paneByOpId.delete(lost.id);
    opTexts.delete(lost.id);
    if (pane) pane.remove();
    try {
      addPane(lost.command, lost.query, `engine error — ${message}`, true);
    } catch {
      /* never wedge on a pane */
    }
  }
  // The engine is restarting from scratch: park the progress gauge — the
  // fresh worker reports a new boot ladder from 0.
  endOpProgress();
  endBootProgress();
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
    if (form.hasAttribute("aria-busy")) return;
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
    if (form.hasAttribute("aria-busy")) return;
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
// The divider starts as a dot: from here the worker's boot milestones drive
// it (and the % readout) to the full line at ready.
setBootPct(0);
