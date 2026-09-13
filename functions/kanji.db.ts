/**
 * Cloudflare Pages Function: serves the dictionary (`kanji.db`) from the R2
 * bucket bound as `DB`. The ~341 MB file exceeds Pages' 25 MiB per-asset
 * limit, so it lives in R2 (free tier: 10 GB storage, zero egress fees) and
 * is streamed to the app through this route.
 *
 * The app fetches `/kanji.db` once at boot and imports it into OPFS (see
 * web/app/worker.ts — `DB_PATH`); the service worker deliberately never
 * caches this route (web/sw.js), and `Cache-Control: no-cache` makes the
 * browser revalidate through the object's ETag, so a re-deployed dictionary
 * is picked up instead of a stale HTTP-cached copy. The object key is
 * overwritten by `pnpm run deploy:web` on every release, always with the
 * same build that produced the served `dist/meta.json` stamp — that keeps
 * the worker's "is a newer dictionary served?" check in sync.
 *
 * The COOP/COEP/CORP headers must match the dev server
 * (scripts/serve-web.mjs) and dist/_headers: they make the page
 * cross-origin-isolated, which the sqlite-wasm OPFS engine
 * (SharedArrayBuffer) requires.
 */
interface Env {
  /** R2 bucket holding `kanji.db` (wrangler.toml: [[r2_buckets]] binding = "DB"). */
  DB: R2Bucket;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const obj = await env.DB.get("kanji.db");
  if (!obj) {
    return new Response(
      "kanji.db not found in the R2 bucket — run `pnpm run deploy:web` to upload it.",
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-cache",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(obj.body, { headers });
};