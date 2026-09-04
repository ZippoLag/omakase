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
import { kanjiStrokePages, loadTags, runKanji, runSearch, runWord } from "./commands.js";
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
  // stroke_order index — that old OPFS copies lack).
  let localStamp: string | null = null;
  try {
    const existing = new OpfsDb(DB_PATH, "r");
    try {
      const probe = new WasmDb(existing);
      const row = probe.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
      localStamp = row?.value ?? null;
    } finally {
      existing.close();
    }
  } catch {
    /* no dictionary in OPFS yet — first visit */
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

async function boot(): Promise<void> {
  try {
    // sqlite engine init: no measurable sub-progress — bootProgress keeps the
    // gauge moving while it runs (see the ladder comment above).
    const engine = await bootProgress(sqlite3InitModule(), BOOT_ENGINE_PCT);
    // Dictionary check + import (byte-accurate progress) or plain open. After
    // an import the ladder already sits past these floors, so the main thread
    // ignores them (its gauge only ever moves forward); on a no-import boot
    // they are the real milestones.
    const raw = await ensureDb(engine);
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
  } catch (err) {
    send({ kind: "fatal", message: err instanceof Error ? err.message : String(err) });
  }
}

/** One lookup, rendered exactly like the CLI (word/kanji return null on miss). */
function handleRun(req: WorkerRequest & { kind: "run" }): WorkerMessage {
  if (!db) return { kind: "result", id: req.id, text: null, error: "dictionary not ready" };
  const q = req.query.trim();
  if (!q) return { kind: "result", id: req.id, text: null, error: "type something to look up" };
  try {
    switch (req.command) {
      case "word": {
        const out = runWord(db, q, tags);
        return {
          kind: "result",
          id: req.id,
          text: out,
          error: out === null ? `no entry for "${q}"` : null,
        };
      }
      case "kanji": {
        const out = runKanji(db, q, req.max);
        return {
          kind: "result",
          id: req.id,
          text: out,
          error: out === null ? `no kanji "${q}"` : null,
          strokes: out === null ? undefined : kanjiStrokePages(db, q),
        };
      }
      case "search":
        return { kind: "result", id: req.id, text: runSearch(db, q, req.max), error: null };
    }
  } catch (err) {
    return {
      kind: "result",
      id: req.id,
      text: null,
      error: `lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

addEventListener("message", (ev: MessageEvent) => {
  const req = ev.data as WorkerRequest;
  if (!req || req.kind !== "run") return;
  try {
    send(handleRun(req));
  } catch (err) {
    send({
      kind: "result",
      id: req.id,
      text: null,
      error: `lookup crashed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

void boot();
