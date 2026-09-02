/**
 * DB worker: the only place sqlite-wasm runs (OPFS is worker-only). Boots
 * the engine, ensures the 289 MB dictionary is present in OPFS (fetching it
 * from the server once, chunked through OpfsDb.importDb), opens it read-only
 * through the statement shim, and answers `run` requests by rendering the
 * same text as the `omakase` CLI.
 */
import sqlite3InitModule, { type OpfsDatabase, type Sqlite3Static } from "../vendor/index.mjs";
import { WasmDb } from "./shim.js";
import { loadTags, runKanji, runSearch, runWord } from "./commands.js";
import type { WorkerMessage, WorkerRequest } from "./worker-api.js";

/** OPFS path of the dictionary (also its URL on the server). */
const DB_PATH = "/kanji.db";

const send = (msg: WorkerMessage): void => {
  (postMessage as (m: WorkerMessage) => void)(msg);
};

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
  // Already imported on a previous visit?
  try {
    return new OpfsDb(DB_PATH, "r");
  } catch {
    /* fall through to import */
  }

  send({ kind: "status", text: "Downloading dictionary into device storage…" });
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
      send({ kind: "progress", loadedBytes: loaded, totalBytes: total });
      return undefined;
    }
    loaded += value.byteLength;
    if (total > 0) send({ kind: "progress", loadedBytes: loaded, totalBytes: total });
    return value;
  });
  return new OpfsDb(DB_PATH, "r");
}

async function boot(): Promise<void> {
  try {
    const engine = await sqlite3InitModule();
    const raw = await ensureDb(engine);
    db = new WasmDb(raw);
    tags = loadTags(db);
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
