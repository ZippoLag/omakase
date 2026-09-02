/**
 * Statement shim: exposes the tiny better-sqlite3-style surface the shared
 * query layer (`src/lookup.ts`, typed as DbLike) needs on top of the OO1
 * API of sqlite-wasm. `get`/`all` prepare + bind + step + reset + finalize
 * per call, exactly like the CLI's per-query `prepare()` calls.
 */
import type { DbLike, SqlValue } from "../../src/lookup.js";
import type { Database, PreparedStatement } from "../vendor/index.mjs";

export class WasmDb implements DbLike {
  constructor(readonly raw: Database) {}

  prepare(sql: string): WasmStatement {
    return new WasmStatement(this.raw.prepare(sql));
  }

  close(): void {
    this.raw.close();
  }
}

class WasmStatement {
  constructor(private readonly stmt: PreparedStatement) {}

  /** First row as a column-name-keyed object, or undefined when no rows. */
  get(...params: unknown[]): unknown {
    const s = this.stmt;
    try {
      if (params.length > 0) s.bind(params as SqlValue[]);
      if (!s.step()) return undefined;
      return s.get({});
    } finally {
      try {
        s.reset();
        s.finalize();
      } catch {
        /* already finalized / closed */
      }
    }
  }

  /** All rows as column-name-keyed objects. */
  all(...params: unknown[]): unknown[] {
    const s = this.stmt;
    const rows: unknown[] = [];
    try {
      if (params.length > 0) s.bind(params as SqlValue[]);
      while (s.step()) rows.push(s.get({}));
      return rows;
    } finally {
      try {
        s.reset();
        s.finalize();
      } catch {
        /* already finalized / closed */
      }
    }
  }
}
