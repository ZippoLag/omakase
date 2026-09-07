/**
 * DB worker: the only place sqlite-wasm runs (OPFS is worker-only). Boots
 * the engine, ensures the dictionary is present in OPFS and current
 * (fetching it from the server once — and re-importing when the served
 * build's stamp differs from the copy in OPFS, so rebuilt dictionaries
 * reach existing installs), opens it read-only through the statement shim,
 * and answers `run` requests by rendering the same text as the `omakase`
 * CLI.
 */
import sqlite3InitModule, { type OpfsDatabase, type Sqlite3Static } from "../vendor/index.mjs";
import { WasmDb } from "./shim.js";
import { dbLooksHealthy, kanjiStrokePages, loadTags, streamKanji, streamSearch, streamWord } from "./commands.js";
import { OP_LADDERS } from "./worker-api.js";
import type { WorkerMessage, WorkerRequest } from "./worker-api.js";

/** OPFS path of the dictionary (also its URL on the server). */
const DB_PATH = "/kanji.db";

/**
 * Startup progress ladder (0–100), monotonically rising until `ready`. Each
 * stage announces its own floor as it finishes and the UI fills toward it,
 * so the divider bar doubles as the boot gauge: a dot at 0% that grows to
 * the full line at 100%.
 *
 * Only two stages can dominate a boot on a phone: the sqlite engine init
 * (which exposes no measurable sub-progress — see `bootProgress`) and the
 * dictionary import (byte-accurate). Everything between them is sub-second,
 * so it simply snaps up when it finishes.
 */
const BOOT_ENGINE_PCT = 30; // engine init — the biggest unmeasured share
/** Byte-accurate import maps into [IMPORT_PCT_BASE, IMPORT_PCT_TOP]. */
const IMPORT_PCT_BASE = 34;
const IMPORT_PCT_TOP = 92;
/** Tail floors (no-import boots; an import already sits above these). */
const BOOT_OPEN_PCT = 55; // dictionary open (OPFS probe + open done)
const BOOT_TAGS_PCT = 78; // tag/index rows loaded
const BOOT_TAIL_PCT = 96; // final word-count / meta reads

const send = (msg: WorkerMessage): void => {
  (postMessage as (m: WorkerMessage) => void)(msg);
};

/**
 * Resolve `p` while easing the boot bar toward `ceiling` (the stage's
 * weight): engine init exposes no internal progress, so without this the
 * bar would sit still for the whole stage — indistinguishable from a hang.
 * The approach is asymptotic and capped just below `ceiling`, so the bar
 * keeps moving for as long as the stage actually takes and the ceiling is
 * only claimed by the next milestone.
 */
function bootProgress<T>(p: Promise<T>, ceiling: number): Promise<T> {
  let pct = 0;
  const iv = setInterval(() => {
    pct += (ceiling - pct) * 0.15;
    send({ kind: "boot", pct: Math.min(Math.round(pct * 10) / 10, ceiling - 1.05) });
  }, 150);
  p.then(() => clearInterval(iv), () => clearInterval(iv));
  return p;
}

/** Map an import byte fraction onto its stage of the boot ladder. */
function importPct(loaded: number, total: number): number {
  if (total <= 0) return IMPORT_PCT_TOP;
  return IMPORT_PCT_BASE + ((IMPORT_PCT_TOP - IMPORT_PCT_BASE) * loaded) / total;
}

let db: WasmDb | null = null;
let tags: Record<string, string> = {};

async function ensureDb(engine: Sqlite3Static): Promise<OpfsDatabase> {
  const OpfsDb = engine.oo1.OpfsDb;
  if (!OpfsDb) {
    throw new Error(
      "This browser can't run the OPFS-backed dictionary. OPFS needs a secure "
      + "context served with COOP/COEP headers (SharedArrayBuffer) and a recent "
      + "browser (Chrome 108+/Safari 17+).",
    );
  }

  // The served dictionary's build stamp comes from dist/meta.json at the
  // docroot. Best effort: offline (fetch failure) we keep whatever OPFS
  // already holds — the app must still boot from cache.
  let serverStamp: string | null = null;
  try {
    const metaRes = await fetch("./meta.json");
    if (metaRes.ok) {
      const meta = (await metaRes.json()) as { version?: unknown };
      serverStamp = typeof meta.version === "string" ? meta.version : null;
    }
  } catch {
    /* offline — no update check */
  }

  // Already imported on a previous visit? Read its build stamp to detect a
  // newer served dictionary (rebuilt DBs carry new tables/rows — e.g. the
  // stroke_order index — that old OPFS copies lack), and probe its
  // integrity: a truncated or interrupted import can leave a copy whose meta
  // (the first table — front of the file) reads fine while data pages past
  // the cut are gone — trusting it boots "ready" while every lookup fails.
  let localStamp: string | null = null;
  let localHealthy = false;
  try {
    const existing = new OpfsDb(DB_PATH, "r");
    try {
      const probe = new WasmDb(existing);
      const row = probe.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      localStamp = row?.value ?? null;
      localHealthy = dbLooksHealthy(probe);
    } finally {
      existing.close();
    }
  } catch {
    /* no dictionary in OPFS yet (or unreadable copy) — first visit / re-import */
  }

  // A stamped copy that fails the integrity probe is damaged: re-import it
  // (importDb truncates + rewrites the OPFS file, so no explicit delete is
  // needed) rather than trust it until the first lookup blows up.
  if (localStamp !== null && !localHealthy) {
    send({ kind: "status", text: "Dictionary copy is damaged — re-importing…" });
    return importDictionary(OpfsDb, "Re-downloading dictionary…");
  }
  if (localStamp !== null && serverStamp !== null && serverStamp !== localStamp) {
    send({ kind: "status", text: "Newer dictionary build found — updating…" });
    return importDictionary(OpfsDb, "Updating dictionary into device storage…");
  }
  if (localStamp !== null) return new OpfsDb(DB_PATH, "r");
  return importDictionary(OpfsDb, "Downloading dictionary into device storage…");
}

/** The subset of the sqlite-wasm OpfsDb class the import path needs. */
type OpfsDbCtor = {
  importDb(filename: string, data: () => Promise<Uint8Array | ArrayBuffer | undefined>): Promise<number>;
  new (filename: string, flags: string): OpfsDatabase;
};

/** Stream the served kanji.db into OPFS (importDb truncates any old file).
 * Each chunk reports byte-accurate progress mapped onto the boot ladder, so
 * the divider bar and % readout keep moving for the whole download. */
async function importDictionary(OpfsDb: OpfsDbCtor, status: string): Promise<OpfsDatabase> {
  send({ kind: "status", text: status });
  const res = await fetch(DB_PATH);
  if (!res.ok || !res.body) {
    throw new Error(`Cannot fetch ${DB_PATH} (HTTP ${res.status}). Is the server serving the built dictionary?`);
  }
  const total = Number(res.headers.get("Content-Length") ?? 0);
  const reader = res.body.getReader();
  let loaded = 0;
  await OpfsDb.importDb(DB_PATH, async () => {
    const { done, value } = await reader.read();
    if (done) {
      send({ kind: "progress", pct: importPct(loaded, total), loadedBytes: loaded, totalBytes: total });
      return undefined;
    }
    loaded += value.byteLength;
    if (total > 0) {
      send({ kind: "progress", pct: importPct(loaded, total), loadedBytes: loaded, totalBytes: total });
    }
    return value;
  });
  return new OpfsDb(DB_PATH, "r");
}

/**
 * One-shot guard for the boot repair below: a failed boot is retried exactly
 * once (re-import + reopen) before giving up, so a genuinely broken
 * environment — no network, unsupported browser — fails fast instead of
 * looping. Per worker instance: the UI's own restart loop (MAX_BOOT_FAILURES)
 * spawns fresh instances, each with one repair attempt.
 */
let repairAttempted = false;

/** Dictionary open + tag/count reads + `ready`, shared by the normal boot and
 * the one-shot repair retry. ensureDb is where the dictionary is checked and
 * (re)imported, so re-running this path is also the repair. */
async function openAndReady(engine: Sqlite3Static): Promise<void> {
  const raw = await ensureDb(engine);
  // After an import the ladder already sits past these floors, so the main
  // thread ignores them (its gauge only ever moves forward); on a no-import
  // boot they are the real milestones.
  send({ kind: "boot", pct: BOOT_OPEN_PCT });
  db = new WasmDb(raw);
  tags = loadTags(db);
  send({ kind: "boot", pct: BOOT_TAGS_PCT });
  send({ kind: "boot", pct: BOOT_TAIL_PCT });
  const n = db.prepare("SELECT COUNT(*) AS n FROM words").get() as { n: number } | undefined;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
  send({
    kind: "ready",
    version: engine.version.libVersion,
    words: typeof n?.n === "number" ? n.n : 0,
    dict: row?.value ?? null,
  });
}

async function boot(): Promise<void> {
  try {
    // sqlite engine init: no measurable sub-progress — bootProgress keeps the
    // gauge moving while it runs (see the ladder comment above).
    const engine = await bootProgress(sqlite3InitModule(), BOOT_ENGINE_PCT);
    await openAndReady(engine);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (repairAttempted) {
      send({ kind: "fatal", message });
      return;
    }
    repairAttempted = true;
    // One self-healing attempt: a dictionary copy torn by an interrupted
    // import (or a flaky network that cut one short) strands the app until a
    // manual reload — re-run the whole open path once; ensureDb's integrity
    // probe re-imports a damaged copy from the server. Only if that fails too
    // is the environment genuinely broken.
    send({ kind: "status", text: "Dictionary damaged — retrying once…" });
    try {
      const engine = await bootProgress(sqlite3InitModule(), BOOT_ENGINE_PCT);
      await openAndReady(engine);
    } catch {
      /* repaired or not, report the original failure below */
    }
    send({ kind: "fatal", message });
  }
}

/**
 * One lookup, streamed exactly like the CLI renders it: each section is
 * posted as it completes (the UI appends it to the pane), then a terminal
 * `result` — `text: null` on a streamed success, `error` on a miss. The
 * awaits between sections let the worker's event loop breathe, so progress
 * messages posted from inside the long meaning search actually reach the
 * main thread (see OP_LADDERS / streamSearch's `onProgress`).
 */
async function handleRun(req: WorkerRequest & { kind: "run" }): Promise<void> {
  if (!db) {
    send({ kind: "result", id: req.id, text: null, error: "dictionary not ready" });
    return;
  }
  const q = req.query.trim();
  if (!q) {
    send({ kind: "result", id: req.id, text: null, error: "type something to look up" });
    return;
  }
  const emit = async (label: string, text: string): Promise<void> => {
    send({ kind: "op-section", id: req.id, label, text });
  };
  try {
    switch (req.command) {
      case "word": {
        const r = await streamWord(db, q, tags, emit);
        send({ kind: "result", id: req.id, text: null, error: r.error });
        return;
      }
      case "kanji": {
        const r = await streamKanji(db, q, req.max, emit);
        // Stroke-order pages are only meaningful for a kanji page (not a miss).
        const strokes = r.error === null ? kanjiStrokePages(db, q) : undefined;
        send({ kind: "result", id: req.id, text: null, error: r.error, strokes });
        return;
      }
      case "search": {
        // The meaning search is the one section long enough to measure (wasm
        // profiling: 1–55 s for common English tokens): map real done/total
        // onto its ladder segment so the bar follows actual work, not easing.
        const base = OP_LADDERS.search.floors.readings!;
        const top = OP_LADDERS.search.floors.meanings!;
        const onProgress = async (done: number, total: number): Promise<void> => {
          if (total <= 0) return;
          send({
            kind: "op-progress",
            id: req.id,
            pct: base + ((top - base) * done) / total,
            text: `searching meanings… (${done.toLocaleString()} / ${total.toLocaleString()})`,
          });
        };
        // Heartbeat BEFORE the discovery phase: the candidate FTS scan
        // (glossWordIds per token) posts no progress and can take seconds on
        // a phone, so claim the readings floor immediately — the main thread
        // follows it verbatim (and extends the watchdog on it), keeping the
        // bar moving and the lookup alive through the silent stretch. The
        // header section streamed by streamSearch re-arms the watchdog again.
        send({ kind: "op-progress", id: req.id, pct: base, text: "searching meanings…" });
        const r = await streamSearch(db, q, req.max, emit, onProgress);
        send({ kind: "result", id: req.id, text: null, error: r.error });
        return;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A dictionary that booted cleanly can still be torn later (storage
    // eviction on phones reclaims OPFS pages mid-session), so every lookup
    // fails with these SQLite errors. Don't paper over it with error panes:
    // tell the UI the engine is broken so it restarts the worker, whose boot
    // path now re-checks the file and re-imports a damaged copy.
    if (/database disk image is malformed|not a database/i.test(message)) {
      send({ kind: "fatal", message: `dictionary is corrupt — restarting to re-import (${message})` });
      return;
    }
    send({
      kind: "result",
      id: req.id,
      text: null,
      error: `lookup failed: ${message}`,
    });
  }
}

addEventListener("message", (ev: MessageEvent) => {
  const req = ev.data as WorkerRequest;
  if (!req || req.kind !== "run") return;
  void handleRun(req).catch((err) => {
    send({
      kind: "result",
      id: req.id,
      text: null,
      error: `lookup crashed: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
});

void boot();
