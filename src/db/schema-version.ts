/**
 * Schema version of the offline dictionary, on its own so a consumer can read
 * it without pulling in the DDL.
 *
 * `src/db/schema.ts` re-exports it (the build and the CLI read it from there),
 * and the web worker imports it directly: the browser bundle has no use for
 * the DDL text, and the worker needs this number to refuse a dictionary built
 * for a different schema. Without that check a mismatched dictionary opens and
 * reports "ready" (its meta table is at the front of the file, so it reads
 * fine) while every thesaurus read fails on the newer columns — the silent
 * failure the boot integrity probe exists to prevent, one level up.
 *
 * Bump on any DDL change. `SCHEMA_VERSION` lands in the DB's `meta` table
 * (`schema_version`) and in `dist/meta.json`, so the served pair is
 * self-describing.
 */
export const SCHEMA_VERSION = 4;
