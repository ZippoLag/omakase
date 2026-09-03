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
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchSwCache, versionFromStamp } from "./sw-version.mjs";

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

// Static shell files land at the docroot (dist/).
for (const f of ["index.html", "style.css", "manifest.webmanifest", "icon.svg"]) {
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
// new cache and the sw purges older caches on activate.
const version = versionFromStamp(readFileSync(join(root, "src", "version.ts"), "utf8"));
if (!version) {
  console.error("src/version.ts has no version stamp — version stamping did not run?");
  process.exit(1);
}
try {
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

const dbPath = join(root, "dist", "kanji.db");
if (!existsSync(dbPath)) {
  console.warn("⚠  dist/kanji.db missing — run `pnpm run build:db` (or `./install.sh`) before serving.");
} else {
  const mb = (statSync(dbPath).size / 1048576).toFixed(0);
  console.log(`dictionary: dist/kanji.db (${mb} MB)`);
}
console.log("web build done → dist/ (serve with `pnpm run web:serve`)");
