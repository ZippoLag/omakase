/**
 * Web build: typecheck+emit the app TS (tsconfig.web.json) and assemble the
 * servable tree in dist/:
 *
 *   dist/index.html, sw.js, style.css, manifest.webmanifest, icon.svg  (shell)
 *   dist/web/app/*.js        emitted UI + worker modules
 *   dist/web/vendor/*        SQLite WASM engine (copied from web/vendor)
 *   dist/src/*.js            emitted shared query/render layer
 *   dist/kanji.db            the already-built dictionary (built by build:db)
 *
 * `dist/` is the web server root.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

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
for (const f of ["index.html", "sw.js", "style.css", "manifest.webmanifest", "icon.svg"]) {
  cpSync(join(root, "web", f), join(root, "dist", f));
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
