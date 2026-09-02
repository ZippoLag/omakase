# SQLite WASM engine (vendored)

Runtime files for the in-browser SQLite engine used by the offline web app.
Copied verbatim from the npm package `@sqlite.org/sqlite-wasm` (version
`3.53.0-build1`, SQLite 3.53.0) so the web app can be built and served
without `node_modules` present.

| File | Purpose |
|---|---|
| `index.mjs` | Bundler-friendly ESM wrapper (`sqlite3InitModule`) + OO1 API + OPFS VFS |
| `sqlite3.wasm` | The SQLite WASM binary |
| `sqlite3-opfs-async-proxy.js` | Async proxy worker the OPFS VFS talks to |
| `index.d.mts` | TypeScript declarations (upstream, unmodified) |

## Licenses

- SQLite itself is in the **public domain** (https://sqlite.org/copyright.html).
- The JavaScript/WASM wrapper code is **Apache 2.0**; the wrapper is based on
  https://sqlite.org/wasm. Keep these notices with any redistribution.

To refresh: `pnpm add -D @sqlite.org/sqlite-wasm` then copy the four dist
files here (see `scripts/build-web.mjs`).
