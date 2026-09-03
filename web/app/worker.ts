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

/** Stream the served kanji.db into OPFS (importDb truncates any old file). */
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
