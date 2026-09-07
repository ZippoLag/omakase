/**
 * UI: a composable, hierarchical single-line input with three buttons — kanji / word /
 * search. Every action runs its lookup in the DB worker and inserts a fresh
 * results pane directly below the button row, pushing older panes down
 * (newest-first history).
 *
 * Nested Results: Clicking magnifying glass icons or kanji within result panes
 * creates nested results within the parent pane instead of top-level panes.
 * No duplicate content exists at the same level under the same parent.
 *
 * Caching: All search results are cached in-memory for instant retrieval.
 *
 * Collapsible: Each result and result list can be individually collapsed/expanded.
 *
 * Auto-scroll: Global toggle enables/disables automatic scrolling to new results.
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
import { cacheManager } from "./cache.js";
import {
  type ResultNode,
  type LegacyPaneRecord,
  generateNodeId,
  createResultNode,
  createErrorResultNode,
  hasDuplicate,
  registerResult,
  unregisterResult,
  clearDuplicateTracker,
  findResultById,
  addResultToParent,
  deleteResultFromTree,
  toggleResultCollapse,
  countResults,
  migrateToHierarchical,
  deserializeResultTree,
  serializeCollapsedStates,
  restoreCollapsedStates,
  seedNodeIdFromTree,
  clearResultTree
} from "./tree.js";

// ---- DOM -------------------------------------------------------------------
const form = document.querySelector<HTMLFormElement>("#lookup")!;
const input = document.querySelector<HTMLInputElement>("#query")!;
const maxInput = document.querySelector<HTMLInputElement>("#max")!;
const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-cmd]");
const status = document.querySelector<HTMLDivElement>("#status")!;
/** The status line's message text (the % readout below is a sibling span). */
const statusMsg = document.querySelector<HTMLSpanElement>("#status .status-msg")!;
/** Live "x%" readout shown next to the status while the engine boots. */
const pctEl = document.querySelector<HTMLSpanElement>("#status .pct")!;
const versionBadge = document.querySelector<HTMLSpanElement>("#version")!;
const clearBtn = document.querySelector<HTMLButtonElement>("#clear")!;
const panes = document.querySelector<HTMLDivElement>("#panes")!;
/** Cancel control for the in-flight lookup — a sibling of the command
 * buttons (never nested inside one), overlaid on the busy button. */
const cancelOp = document.querySelector<HTMLButtonElement>("#cancel-op")!;

// Auto-scroll toggle element (will be added to header)
let autoScrollToggle: HTMLButtonElement | null = null;

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
  /** Parent ID for nested results */
  parentId: string | null;
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

// ---- Composable UI State ------------------------------------------------
/** Hierarchical result tree (top-level nodes only) */
let resultTree: ResultNode[] = [];

/** Auto-scroll preference */
let autoScrollEnabled = true;

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
  autoScrollEnabled?: unknown;
  collapsedStates?: unknown;
  resultTree?: unknown;
}

const STORAGE_KEY = "omakase.state";
const COMMANDS: readonly string[] = ["kanji", "word", "search"];

/**
 * Write input, last command, max, auto-scroll and the pane history to localStorage.
 */
function saveState(): void {
  try {
    const collapsedStates = serializeCollapsedStates(resultTree);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 2,
        query: input.value,
        command: lastCommand,
        max: parseMax(),
        autoScrollEnabled,
        resultTree: resultTree,
        collapsedStates
      }),
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
 *
 * The creep must NEVER overshoot a floor that a future section or counted
 * value has to claim: setOpPct is monotonic, so a target at/above the next
 * floor (or 99 before any section lands) would swallow that progress forever
 * and park the bar while real work is still streaming. Targets therefore cap
 * just below the next floor; the floor itself is only ever claimed by real
 * arrival (opSectionClaim / op-progress).
 */
function armOpTicker(command: Command): void {
  disarmOpTicker();
  const ladder = OP_LADDERS[command];
  // Before any section lands, ease toward just below the FIRST floor; after
  // a claim, ease toward just below the NEXT section's floor (99 only means
  // "no floor left to claim" — every section already streamed).
  const idx = lastSectionClaimed ? ladder.order.indexOf(lastSectionClaimed) : -1;
  const next = idx >= 0 && idx + 1 < ladder.order.length ? ladder.order[idx + 1]! : null;
  let target: number;
  if (next === null) {
    // No next section: lastSectionClaimed was the final one (or the op has
    // none at all). Creep toward the finish line without crossing 99.
    target = 99;
  } else {
    const nextFloor = ladder.floors[next] ?? 100;
    if (ladder.counted.has(next)) {
      // The counted section (search meanings) claims its whole range with
      // real progress; keep the liveness creep in the gap just below it.
      target = Math.min(opFloor + 5, nextFloor - 1);
    } else {
      target = Math.max(Math.min(nextFloor - 1, 99), opFloor + 0.5);
    }
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
 * Map from operation ID to the DOM element for streaming panes
 */
const streamingPaneById = new Map<number, { pane: HTMLElement, pre: HTMLElement, parentId: string | null }>();

/**
 * The pane for a dequeued lookup, created immediately: header + a few
 * skeleton rows (the worker's streamed sections fill the body in). Kept out
 * of the tree until its final `result` lands, so a crash mid-lookup never
 * persists a half-built pane.
 */
function addSkeletonPane(item: Pending): void {
  const nodeId = `op_${item.id}`; // Temporary ID for streaming
  const parentId = item.parentId;
  
  const pane = document.createElement("section");
  pane.className = "pane streaming";
  pane.dataset.nodeId = nodeId;
  if (parentId) {
    pane.classList.add("nested");
  }
  
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
  
  // Insert into appropriate location
  if (parentId) {
    const parentPane = document.querySelector(`[data-node-id="${parentId}"]`);
    if (parentPane) {
      let childrenContainer = parentPane.querySelector('.pane-children');
      if (!childrenContainer) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'pane-children';
        const preElement = parentPane.querySelector('pre');
        if (preElement) {
          parentPane.insertBefore(childrenContainer, preElement.nextSibling);
        } else {
          parentPane.appendChild(childrenContainer);
        }
      }
      childrenContainer.prepend(pane);
    } else {
      // Parent not found, add to top level
      panes.prepend(pane);
    }
  } else {
    panes.prepend(pane);
  }
  
  // Conditional auto-scroll
  if (autoScrollEnabled) {
    pane.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  
  paneByOpId.set(item.id, pane);
  streamingPaneById.set(item.id, { pane, pre, parentId });
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
function appendSectionText(pre: HTMLElement, text: string, parentId: string | null): void {
  pre.querySelectorAll(".skel-line").forEach((el) => el.remove());
  const nodes: (Node | string)[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push("\n");
    nodes.push(...linkifyLine(line, parentId));
  });
  pre.append(...nodes);
}

// ---- query expansion -------------------------------------------------------
/** CJK ideographs — every displayed kanji is individually clickable. */
const KANJI_RE = /\p{Script=Han}/u;
/** Separators between words in a `word` box: commas (ASCII `,`, full-width
 * `，`, Japanese `、`) and any whitespace. */
const WORD_SEP_RE = /[\s,，、]+/u;

/**
 * The individual words of a `word` box, in order (runs between separators).
 */
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
function submit(command: Command, context?: { parentId: string | null }): void {
  if (engineDead) return;
  const raw = input.value;
  const parentId = context?.parentId ?? null;
  const max = parseMax();
  
  // Action-level dedupe gate, keyed on the RAW box value — what the user
  // actually asked — never on the individual lookups a multi-item box
  // expands into. An identical action (same command, raw value, parent) is
  // already registered: its panes are up, queued, or cached from an earlier
  // identical run, so the whole batch is a no-op. Different raw strings are
  // different actions: 制・作者 after 制作者 still renders its three pages,
  // and a multi-word box after its words were looked up separately does too.
  if (hasDuplicate(parentId, command, raw)) {
    input.focus();
    return;
  }
  
  const queries = command === "word"
    ? wordTokens(raw)
    : command === "kanji"
      ? kanjiQueries(raw)
      : [raw.trim()];
  
  // Dedupe WITHIN this one action only: repeated tokens (水 水 → one 水
  // pane) and queries already sitting in the queue are enqueued once. This
  // never consults the duplicate tracker — a registered action with a
  // different raw string is free to render again.
  const seen = new Set(queue.map((p) => `${p.command}\u0000${p.query}\u0000${p.parentId}`));
  const pending: { query: string; parentId: string | null; max: number }[] = [];
  
  for (const q of queries) {
    if (q.length === 0) continue;
    const key = `${command}\u0000${q}\u0000${parentId}`;
    if (!seen.has(key)) {
      seen.add(key);
      pending.push({ query: q, parentId, max });
    }
  }
  
  if (pending.length === 0) {
    input.focus();
    return;
  }
  
  // The action is accepted: register it ONCE, now, before anything renders
  // or drains — a second identical click is then caught by the gate above
  // even while this batch is still queued. Nothing downstream registers the
  // individual expanded queries anymore: per-literal tracking is what let
  // 制作者 be swallowed after standalone 制/作/者 lookups. Deleting a batch's
  // panes only unregisters single-item actions (node query == the raw box);
  // a multi-item action's entry lingers — acceptable, an identical re-click
  // stays suppressed rather than duplicating a visible batch.
  registerResult(parentId, command, raw);
  
  lastCommand = command;
  for (const p of pending) {
    // Check cache first
    const cached = cacheManager.getCached(command, p.query, p.max);
    if (cached) {
      // Use cached result - create new node with proper parent context
      const newNode = createResultNode(
        cached.command,
        cached.query,
        cached.text,
        cached.error,
        cached.strokes,
        p.parentId,
        p.max
      );
      
      // Add to tree and render
      resultTree = addResultToParent(resultTree, newNode, p.parentId);
      renderResultNode(newNode);
    } else {
      // Not cached, add to queue
      queue.push({ 
        id: nextId++, 
        command, 
        query: p.query, 
        max: p.max,
        parentId: p.parentId
      });
      cacheManager.markFetchStarted(command, p.query, p.max);
    }
  }
  
  saveState();
  syncBusyUi();
  input.select();
  drain();
}

/** Add a pane indicating the operation was cancelled. */
function addCancelledPane(command: string, query: string, parentId: string | null = null): void {
  const nodeId = generateNodeId();
  const pane = document.createElement("section");
  pane.className = "pane error cancelled";
  pane.dataset.nodeId = nodeId;
  if (parentId) {
    pane.classList.add("nested");
  }

  const head = document.createElement("div");
  head.className = "pane-head";
  
  // No collapse toggle: cancelled panes are not tree nodes (nothing to
  // collapse), so a toggle here would be inert.
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
  
  // Insert at appropriate location
  if (parentId) {
    const parentPane = document.querySelector(`[data-node-id="${parentId}"]`);
    if (parentPane) {
      let childrenContainer = parentPane.querySelector('.pane-children');
      if (!childrenContainer) {
        childrenContainer = document.createElement('div');
        childrenContainer.className = 'pane-children';
        const preElement = parentPane.querySelector('pre');
        if (preElement) {
          parentPane.insertBefore(childrenContainer, preElement.nextSibling);
        } else {
          parentPane.appendChild(childrenContainer);
        }
      }
      childrenContainer.prepend(pane);
    } else {
      panes.prepend(pane);
    }
  } else {
    panes.prepend(pane);
  }
  
  if (autoScrollEnabled) {
    pane.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

/** Cancel the currently-running operation only (head of queue). */
function cancelCurrentOperation(): void {
  const head = queue[0];
  if (!head) return;
  
  // Mark as cancelled and clean up
  cancelledOps.add(head.id);
  queue.shift();
  inFlight = false;
  // The cancelled lookup's watchdog must not fire later and kill the engine
  // while some other lookup (or nothing at all) is running — drop the timer
  // armed for it here; drain() below re-arms for the new head.
  disarmWatchdog();
  
  // Remove skeleton pane and replace with cancelled message
  const skeletonData = streamingPaneById.get(head.id);
  if (skeletonData) {
    skeletonData.pane.remove();
    streamingPaneById.delete(head.id);
  }
  paneByOpId.delete(head.id);
  opTexts.delete(head.id);
  cacheManager.markFetchCompleted(head.command, head.query, head.max);
  
  if (opActiveId === head.id) {
    opActiveId = null;
    opCommand = null;
    endOpProgress();
  }
  
  // Add cancelled pane for user visibility
  addCancelledPane(head.command, head.query, head.parentId);
  
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
      // pane and claim its floor on the operation ladder. Gated on the ACTIVE
      // op (like op-progress): a section from a cancelled or already-forgotten
      // lookup must neither render into a stale skeleton nor claim a ladder
      // floor (setOpPct is monotonic — a stray claim would park the bar above
      // the active op's real progress).
      if (opActiveId !== msg.id || cancelledOps.has(msg.id)) break;
      const streamingData = streamingPaneById.get(msg.id);
      if (streamingData) {
        const { pre, parentId } = streamingData;
        appendSectionText(pre, msg.text, parentId);
      }
      const texts = opTexts.get(msg.id);
      if (texts) texts.push(msg.text);
      opSectionClaim(msg.label);
      // The worker is demonstrably alive and mid-lookup: extend the watchdog
      // so a slow-but-streaming lookup (e.g. the long meaning search on a
      // phone) is never killed while it is still making progress.
      armWatchdog();
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
      // Liveness extension: same rationale as op-section — the watchdog must
      // only fire when the worker has gone silent, not while real progress
      // messages keep arriving for the active lookup.
      armWatchdog();
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
 * A lookup answered. Only the reply for the queue's head is ever acted on:
 * replies for cancelled or forgotten lookups and strays from a dead engine
 * are inert. Whatever the outcome, the busy chrome and queue are synced
 * afterwards, so the UI always returns to a usable state.
 */
function handleResult(msg: Extract<WorkerMessage, { kind: "result" }>): void {
  // THE protocol gate — read the head and match BEFORE touching any state.
  // A reply that is not the head's (a cancelled lookup the worker still
  // finished, or a stray from a dead engine) must leave inFlight true and the
  // head's watchdog armed: the old code disarmed/reset them first, which let
  // a late reply for a cancelled op make drain() re-post the head (same id,
  // second skeleton pane) and cascade the desync down the queue.
  const item = queue[0] ?? null;
  if (!item || item.id !== msg.id) {
    cancelledOps.delete(msg.id); // GC the cancel marker; nothing else to do
    return;
  }
  const wasCancelled = cancelledOps.has(msg.id);
  cancelledOps.delete(msg.id);
  queue.shift();
  disarmWatchdog();
  inFlight = false;
  
  // This lookup's streaming state: a real reply swaps the skeleton for the
  // final pane; a cancelled head's entries were already dropped at cancel
  // time (both removals are no-ops there).
  const streamingData = streamingPaneById.get(msg.id);
  streamingPaneById.delete(msg.id);
  const skeletonPane = paneByOpId.get(msg.id);
  paneByOpId.delete(msg.id);
  const streamedText = opTexts.get(msg.id)?.join("") ?? "";
  opTexts.delete(msg.id);
  cacheManager.markFetchCompleted(item.command, item.query, item.max);
  
  if (streamingData) streamingData.pane.remove();
  if (skeletonPane) skeletonPane.remove();
  
  try {
    if (wasCancelled) {
      // The cancelled lookup's terminal reply: the user already got the
      // "operation cancelled" pane (cancelCurrentOperation) — register
      // nothing, render nothing.
    } else if (msg.error !== null) {
      const errorNode = createErrorResultNode(item.command, item.query, msg.error, item.parentId, item.max);
      resultTree = addResultToParent(resultTree, errorNode, item.parentId);
      renderResultNode(errorNode);
      
    } else if (msg.text !== null) {
      // Legacy whole-result path (no sections streamed).
      const resultNode = createResultNode(item.command, item.query, msg.text, false, msg.strokes, item.parentId, item.max);
      resultTree = addResultToParent(resultTree, resultNode, item.parentId);
      renderResultNode(resultNode);
      
      // Cache the result
      cacheManager.setCache(item.command, item.query, item.max, resultNode);
      
    } else {
      // Streamed success: the sections already rendered the pane — swap the
      // skeleton for the canonical pane (trashbin + history + linkified
      // text) built from the concatenated sections, byte-identical to what
      // the CLI would have printed.
      if (streamedText !== "") {
        const resultNode = createResultNode(item.command, item.query, streamedText, false, msg.strokes, item.parentId, item.max);
        resultTree = addResultToParent(resultTree, resultNode, item.parentId);
        renderResultNode(resultNode);
        
        // Cache the result
        cacheManager.setCache(item.command, item.query, item.max, resultNode);
      } else {
        // Defensive: hits always stream
        const errorNode = createErrorResultNode(item.command, item.query, "(empty result)", item.parentId, item.max);
        resultTree = addResultToParent(resultTree, errorNode, item.parentId);
        renderResultNode(errorNode);
      }
    }
  } catch (err) {
    // A pane must never wedge the queue: report and keep draining.
    console.error("could not render result pane:", err);
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

/** Overlay the cancel control on the busy command button's right edge. */
function showCancelButton(button: HTMLButtonElement): void {
  const row = document.querySelector("#buttons")!;
  const br = row.getBoundingClientRect();
  const r = button.getBoundingClientRect();
  cancelOp.hidden = false;
  cancelOp.style.left = `${r.right - br.left - 28}px`;
  cancelOp.style.top = `${r.top - br.top + (r.height - 20) / 2}px`;
}

function hideCancelButton(): void {
  cancelOp.hidden = true;
}

/** Remove the spinner from whatever button carries it (restores the label). */
function removeSpinner(): void {
  if (!spinnerOn) return;
  const b = spinnerOn;
  b.classList.remove("busy");
  b.textContent = b.dataset.label ?? "";
  delete b.dataset.label;
  spinnerOn = null;
  hideCancelButton();
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
      
      // Overlay the cancel control on the busy button — a sibling of the
      // command buttons, never a child (button-inside-button is invalid
      // HTML and clobbered the command button's label).
      showCancelButton(button);
      
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
 * spinning forever, and reloading the page restarts it.
 */
function engineDown(message: string): void {
  disarmWatchdog();
  const lost = inFlight ? (queue[0] ?? null) : null;
  inFlight = false;
  if (lost) {
    queue.shift();
    // The in-flight lookup's skeleton pane becomes an error pane — never a
    // duplicate (the skeleton must not linger next to a fresh error pane).
    const streamingData = streamingPaneById.get(lost.id);
    streamingPaneById.delete(lost.id);
    const skeletonPane = paneByOpId.get(lost.id);
    paneByOpId.delete(lost.id);
    opTexts.delete(lost.id);
    cacheManager.markFetchCompleted(lost.command, lost.query, lost.max);
    
    if (streamingData) streamingData.pane.remove();
    if (skeletonPane) skeletonPane.remove();
    
    try {
      const errorNode = createErrorResultNode(lost.command, lost.query, `engine error — ${message}`, lost.parentId, lost.max);
      resultTree = addResultToParent(resultTree, errorNode, lost.parentId);
      renderResultNode(errorNode);
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
        const errorNode = createErrorResultNode(item.command, item.query, `engine error — ${message}`, item.parentId, item.max);
        resultTree = addResultToParent(resultTree, errorNode, item.parentId);
        renderResultNode(errorNode);
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
 * "Word row" — `  writing  [reading/ruby]  gloss…`, the shape used by
 * compounds, multi-kanji Words, search hits, thesaurus and deconjugate rows.
 * The bracket group allows nested ruby like `食[たべ]物[もの]`.
 */
const WORD_ROW_RE = /^(\s*)([^\[\]]*?)\s{2}\[((?:[^\[\]]|\[[^\[\]]*\]|\\[[^\[\]]*\\])*)\](.*)$/;

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

/** Chevron icons for collapse/expand toggles */
const CHEVRON_DOWN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const CHEVRON_RIGHT_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

/** One kanji character as a button → `kanji <ch>` lookup. */
function kanjiButton(ch: string, parentId: string | null = null): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tok tok-kanji";
  b.textContent = ch;
  b.title = `kanji ${ch}`;
  b.addEventListener("click", () => {
    // Token clicks stay live while a lookup runs — they are the only
    // controls left enabled — and submit()/drain() queue them behind the
    // in-flight lookup (see the queueing notes in the module header).
    input.value = ch;
    submit("kanji", { parentId });
  });
  return b;
}

/** A word-lookup icon at the left of a word → `word <writing>` lookup. */
function wordIconButton(writing: string, parentId: string | null = null): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tok tok-word";
  b.title = `word ${writing}`;
  b.setAttribute("aria-label", `look up "${writing}"`);
  b.innerHTML = WORD_ICON_SVG;
  b.addEventListener("click", () => {
    // Same as kanjiButton: clicks queue while the app is busy.
    input.value = writing;
    submit("word", { parentId });
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
function linkifyLine(line: string, parentId: string | null = null): (Node | string)[] {
  const out: (Node | string)[] = [];
  const m = WORD_ROW_RE.exec(line);
  let cursor = 0;
  if (m) {
    const writingStart = m[1]!.length;
    const writing = m[2]!;
    if (KANJI_RE.test(writing) || KANA_RE.test(writing)) {
      out.push(line.slice(cursor, writingStart));
      out.push(wordIconButton(writing, parentId));
      cursor = writingStart;
    }
  }
  for (const ch of line.slice(cursor)) {
    out.push(KANJI_RE.test(ch) ? kanjiButton(ch, parentId) : ch);
  }
  return out;
}

/**
 * Create collapse toggle button for a result pane
 */
function createCollapseToggle(nodeId: string, initiallyCollapsed: boolean = false): HTMLButtonElement {
  const toggle = document.createElement("button");
  toggle.className = "pane-collapse";
  toggle.innerHTML = initiallyCollapsed ? CHEVRON_RIGHT_SVG : CHEVRON_DOWN_SVG;
  toggle.title = initiallyCollapsed ? 'Expand' : 'Collapse';
  toggle.setAttribute('aria-label', initiallyCollapsed ? 'Expand' : 'Collapse');
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    toggleResult(nodeId);
  });
  return toggle;
}

/**
 * Toggle collapse state for a result node in the UI and state. A collapsed
 * pane reduces to its head banner: both its own body (pre) and its nested
 * children are hidden, and restored by the same state on reload.
 */
function toggleResult(nodeId: string): void {
  resultTree = toggleResultCollapse(resultTree, nodeId);
  
  const pane = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (!pane) return;
  // The node must exist in the tree — only real result panes carry a toggle
  // (cancelled panes have none), so a miss means the pane was already
  // deleted; nothing to update.
  const node = findResultById(resultTree, nodeId);
  if (!node) return;
  
  pane.classList.toggle('collapsed', node.collapsed);
  const childrenContainer = pane.querySelector('.pane-children');
  if (childrenContainer) {
    childrenContainer.classList.toggle('hidden', node.collapsed);
  }
  const toggle = pane.querySelector('.pane-collapse') as HTMLButtonElement | null;
  if (toggle) {
    toggle.innerHTML = node.collapsed ? CHEVRON_RIGHT_SVG : CHEVRON_DOWN_SVG;
    toggle.title = node.collapsed ? 'Expand' : 'Collapse';
    toggle.setAttribute('aria-label', node.collapsed ? 'Expand' : 'Collapse');
  }
  
  saveState();
}

/**
 * Delete a result node from the UI and state
 */
function deleteResult(nodeId: string): void {
  resultTree = deleteResultFromTree(resultTree, nodeId);
  
  const pane = document.querySelector(`[data-node-id="${nodeId}"]`);
  if (pane) {
    pane.remove();
  }
  
  updateClearButton();
  saveState();
}

/**
 * Render a single result node as DOM
 */
function renderResultNode(node: ResultNode): HTMLElement {
  const pane = document.createElement("section");
  pane.className = `pane${node.parentId ? ' nested' : ''}${node.collapsed ? ' collapsed' : ''}${node.error ? ' error' : ''}`;
  pane.dataset.nodeId = node.id;

  // Header
  const head = document.createElement("div");
  head.className = "pane-head";

  // Collapse toggle
  const collapseToggle = createCollapseToggle(node.id, node.collapsed);
  head.append(collapseToggle);

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = node.command;
  
  const q = document.createElement("span");
  q.className = "pane-query";
  q.textContent = node.query;

  const del = document.createElement("button");
  del.type = "button";
  del.className = "pane-del";
  del.title = "Delete this result";
  del.setAttribute("aria-label", `Delete result for ${node.query}`);
  del.innerHTML = TRASH_ICON_SVG;
  del.addEventListener("click", () => {
    deleteResult(node.id);
  });

  head.append(badge, q, del);

  // Content
  const pre = document.createElement("pre");
  const content = node.text.endsWith("\n") ? node.text.slice(0, -1) : node.text;
  const nodes: (Node | string)[] = [];
  content.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push("\n");
    nodes.push(...linkifyLine(line, node.id));
  });
  pre.append(...nodes);

  pane.append(head, pre);

  // Children container (for nested results)
  const childrenContainer = document.createElement("div");
  childrenContainer.className = `pane-children${node.collapsed ? ' hidden' : ''}`;
  
  // Render children recursively
  for (const child of node.children) {
    const childPane = renderResultNode(child);
    childrenContainer.appendChild(childPane);
  }
  
  pane.append(childrenContainer);

  // Insert into appropriate location
  if (node.parentId) {
    const parentPane = document.querySelector(`[data-node-id="${node.parentId}"]`);
    if (parentPane) {
      let parentChildrenContainer = parentPane.querySelector('.pane-children');
      if (!parentChildrenContainer) {
        parentChildrenContainer = document.createElement('div');
        parentChildrenContainer.className = 'pane-children';
        const preElement = parentPane.querySelector('pre');
        if (preElement) {
          parentPane.insertBefore(parentChildrenContainer, preElement.nextSibling);
        } else {
          parentPane.appendChild(parentChildrenContainer);
        }
      }
      parentChildrenContainer.prepend(pane);
    } else {
      // Parent not found, add to top level
      panes.prepend(pane);
    }
  } else {
    panes.prepend(pane);
  }
  // Auto-scroll if enabled
  if (autoScrollEnabled) {
    pane.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  
  // Attach stroke widgets if this is a kanji result with stroke data
  if (node.command === 'kanji' && node.strokes && node.strokes.length > 0) {
    attachStrokeWidgets(pane, node.strokes);
  }

  // Every rendered pane is history: the header trashbin tracks whether there
  // is anything to delete (regression from the nesting refactor, which lost
  // the updateClearButton call the flat addPane used to make).
  updateClearButton();

  return pane;
}

/**
 * Render the entire result tree
 */
function renderResultTree(): void {
  panes.replaceChildren();
  for (const node of resultTree) {
    renderResultNode(node);
  }
}

// ---- panes -----------------------------------------------------------------
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
  if (pre) {
    const head = pane.querySelector('.pane-head');
    if (head && head.nextSibling === pre) {
      pane.insertBefore(strip, pre);
    } else {
      pane.insertBefore(strip, pre);
    }
  }
}

/** The header trashbin is enabled only while there is history to delete. */
function updateClearButton(): void {
  clearBtn.disabled = countResults(resultTree) === 0;
}

/** Header trashbin: remove every result pane and clear the persisted history. */
function clearAll(): void {
  resultTree = clearResultTree();
  cacheManager.clear();
  panes.replaceChildren();
  updateClearButton();
  saveState();
}

/**
 * Restore input, max, last command and the result history from storage.
 */
function restoreState(): void {
  let stored: StoredState | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as StoredState | null;
  } catch {
    /* corrupt storage — start fresh */
  }
  if (!stored || stored.v === undefined) {
    setLastCommand("search");
    return;
  }
  
  // Load auto-scroll preference (default to true)
  autoScrollEnabled = stored.autoScrollEnabled !== false;
  
  // Handle legacy format (v1) - flat panes
  if (stored.v === 1 && Array.isArray(stored.panes)) {
    const legacyPanes = stored.panes as LegacyPaneRecord[];
    resultTree = migrateToHierarchical(legacyPanes);
  } else if (stored.v === 2 && Array.isArray(stored.resultTree)) {
    // New hierarchical format
    resultTree = deserializeResultTree(stored.resultTree);
    
    // Restore collapsed states
    if (stored.collapsedStates && typeof stored.collapsedStates === 'object') {
      resultTree = restoreCollapsedStates(resultTree, stored.collapsedStates as Record<string, boolean>);
    }
  }
  
  // Restore UI state
  if (typeof stored.query === "string") input.value = stored.query;
  const m = Number(stored.max);
  if (Number.isInteger(m) && m >= 1) maxInput.value = String(m);
  const command = typeof stored.command === "string" && COMMANDS.includes(stored.command)
    ? (stored.command as Command)
    : "search";
  setLastCommand(command);
  
  // New lookups must never reuse ids restored nodes already carry: seed the
  // counter past the highest id in the restored tree (a fresh page starts at
  // 1, which would collide with the ids deserialized above).
  seedNodeIdFromTree(resultTree);
  
  // Render tree
  renderResultTree();
  updateClearButton();
}

// ---- Auto-scroll toggle -----------------------------------------------------
/**
 * Initialize the auto-scroll toggle in the header
 */
function initializeAutoScrollToggle(): void {
  autoScrollToggle = document.createElement("button");
  autoScrollToggle.id = "auto-scroll-toggle";
  autoScrollToggle.className = "header-toggle";
  updateAutoScrollToggleText();
  autoScrollToggle.title = 'Toggle auto-scroll for new results';
  autoScrollToggle.setAttribute('aria-label', autoScrollEnabled ? 'Disable auto-scroll' : 'Enable auto-scroll');
  autoScrollToggle.addEventListener('click', () => {
    autoScrollEnabled = !autoScrollEnabled;
    updateAutoScrollToggleText();
    if (autoScrollToggle) {
      autoScrollToggle.setAttribute('aria-label', autoScrollEnabled ? 'Disable auto-scroll' : 'Enable auto-scroll');
    }
    localStorage.setItem('omakase.autoScroll', String(autoScrollEnabled));
    saveState();
  });
  
  // Insert in header - before the clear button
  const header = document.querySelector('header');
  if (header && clearBtn.parentNode === header) {
    header.insertBefore(autoScrollToggle, clearBtn);
  }
}

/**
 * Update the auto-scroll toggle button text
 */
function updateAutoScrollToggleText(): void {
  if (autoScrollToggle) {
    autoScrollToggle.textContent = autoScrollEnabled ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
  }
}

// ---- controls --------------------------------------------------------------
function setControlsDisabled(v: boolean): void {
  input.disabled = v;
  maxInput.disabled = v;
  for (const b of buttons) b.disabled = v;
}

// ---- events ----------------------------------------------------------------
// Initialize auto-scroll toggle on startup
initializeAutoScrollToggle();

// Load auto-scroll preference from localStorage if available
try {
  const savedAutoScroll = localStorage.getItem('omakase.autoScroll');
  if (savedAutoScroll !== null) {
    autoScrollEnabled = savedAutoScroll !== 'false';
  }
} catch {
  // localStorage not available
}

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
cancelOp.addEventListener("click", cancelCurrentOperation);

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