/**
 * Web build: typecheck+emit the app TS (tsconfig.web.json) and assemble the
 * servable tree in dist/:
 *
 *   dist/index.html, sw.js, style.css, manifest.webmanifest, icon.svg  (shell)
 *   dist/LICENSE.md, dist/NOTICE.md   attribution docs (linked from the footer)
 *   dist/web/app/*.js        emitted UI + worker modules
 *   dist/web/vendor/*        SQLite WASM engine (copied from web/vendor)
 *   dist/src/*.js            emitted shared query/render layer
 *   dist/kanji.db            the already-built dictionary (built by build:db)
 *
 * `dist/` is the web server root.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPrecacheCovers, patchIndexHtml, patchSwCache, versionFromStamp } from "./sw-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// Stamp this build first (bump the version counter, regenerate src/version.ts)
// so the emitted app bundle carries the new version — its output is printed
// straight through (the version is the first line of the build).
const stamp = spawnSync(process.execPath, [join(root, "scripts", "version.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (stamp.status !== 0) {
  console.error("version stamping failed");
  process.exit(stamp.status ?? 1);
}

const tscBin = require.resolve("typescript/bin/tsc");
const run = spawnSync(process.execPath, [tscBin, "-p", join(root, "tsconfig.web.json")], {
  cwd: root,
  stdio: "inherit",
});
if (run.status !== 0) {
  console.error("tsc failed");
  process.exit(run.status ?? 1);
}

// Static shell files land at the docroot (dist/). index.html is written
// separately below once the build version is known, so its asset links carry
// the version stamp (?v=<version>) — a new build can never resolve old
// cached assets, and the service worker precaches the same versioned URLs.
for (const f of ["style.css", "manifest.webmanifest", "icon.svg"]) {
  cpSync(join(root, "web", f), join(root, "dist", f));
}

// Attribution documents ship with the served app (served at the docroot, so
// the footer's LICENSE.md / NOTICE.md links and the manifest description work
// offline via the service worker's precache).
for (const f of ["LICENSE.md", "NOTICE.md"]) {
  cpSync(join(root, f), join(root, "dist", f));
}

// The service worker's cache name is derived from the freshly stamped build
// version (written to src/version.ts above), so every web build publishes a
// new cache and the sw purges older caches on activate. index.html gets the
// same version on its shell asset links (style.css / web/app/main.js) and the
// sw's PRECACHE entries match, so a new build can never resolve old cached
// assets.
/** Every module tsc emitted under dist/, as web-root-relative paths. */
function emittedModules() {
  const walk = (dir) => existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      )
    : [];
  return [...walk(join(root, "dist", "web", "app")), ...walk(join(root, "dist", "src"))]
    .filter((p) => p.endsWith(".js"))
    .map((p) => relative(join(root, "dist"), p).split("\\").join("/"));
}

const version = versionFromStamp(readFileSync(join(root, "src", "version.ts"), "utf8"));
if (!version) {
  console.error("src/version.ts has no version stamp — version stamping did not run?");
  process.exit(1);
}
try {
  // The offline shell must precache every module the build emits: a module
  // missing from PRECACHE is only fetched on first use, so a cold (or
  // partially cached) start breaks offline while the install looks healthy.
  // The list is hand-maintained in web/sw.js, so check it against what tsc
  // actually emitted and fail the build on any gap.
  assertPrecacheCovers(readFileSync(join(root, "web", "sw.js"), "utf8"), emittedModules());
  writeFileSync(
    join(root, "dist", "index.html"),
    patchIndexHtml(readFileSync(join(root, "web", "index.html"), "utf8"), version),
  );
  writeFileSync(
    join(root, "dist", "sw.js"),
    patchSwCache(readFileSync(join(root, "web", "sw.js"), "utf8"), version),
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// Vendored engine (runtime files + provenance + type decls).
mkdirSync(join(root, "dist", "web", "vendor"), { recursive: true });
cpSync(join(root, "web", "vendor"), join(root, "dist", "web", "vendor"), { recursive: true });

// Cloudflare Pages _headers: cross-origin isolation (the sqlite-wasm OPFS
// engine needs SharedArrayBuffer, which requires COOP/COEP) plus revalidation
// for the shell files whose freshness matters (index.html, sw.js, meta.json).
// Mirrors the headers scripts/serve-web.mjs sends in dev. The dictionary
// route is a Pages Function (functions/kanji.db.ts), so it sets its own.
writeFileSync(
  join(root, "dist", "_headers"),
  [
    "/*",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: require-corp",
    "  Cross-Origin-Resource-Policy: same-origin",
    "  X-Content-Type-Options: nosniff",
    "",
    "/index.html",
    "  Cache-Control: no-cache",
    "",
    "/sw.js",
    "  Cache-Control: no-cache",
    "",
    "/meta.json",
    "  Cache-Control: no-cache",
    "",
  ].join("\n"),
);

const dbPath = join(root, "dist", "kanji.db");
if (!existsSync(dbPath)) {
  console.warn("⚠  dist/kanji.db missing — run `pnpm run build:db` (or `./install.sh`) before serving.");
} else {
  const mb = (statSync(dbPath).size / 1048576).toFixed(0);
  console.log(`dictionary: dist/kanji.db (${mb} MB)`);
}
console.log("web build done → dist/ (serve with `pnpm run web:serve`)");
