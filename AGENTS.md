# AGENTS.md — omakase working guide

This file is for **agents** (and humans) working on the omakase codebase. It
maps the repo, states the quality gates every change must pass, and records
lessons learned so past pitfalls are not repeated. **Read `README.md` first**
for the product, usage, and install story; this file is the engineering
companion.

> **Work-in-progress note.** `REVIEW-FIXES.md` (untracked, temporary) holds
> the numbered implementation plan (W1–W16) for the review of the last 15
> unpushed commits. It must be **deleted once every item is done and
> verified** — see its "Definition of done". Its lessons are distilled here;
> keep this file updated as the work progresses. Do not commit REVIEW-FIXES.md
> as-is.

---

## 1. What this is

A 100% offline Japanese quick-reference tool with **two front-ends** over one
read-only SQLite dictionary:

1. **CLI** (`src/cli.ts`, `bin/omakase`) — better-sqlite3, Node 20–22.
2. **Phone web app / PWA** (`web/`) — the same dictionary in an in-browser
   sqlite-wasm engine, fully offline after a one-time import into OPFS.

Both reuse the **same query + render layer** (`src/lookup.ts`, `src/format.ts`,
`src/kana.ts`, `src/kangxi.ts`, `src/conjugation.ts`, `src/strokes.ts`), so the
web panes show **byte-for-byte the same text the CLI prints** (minus ANSI
color). Preserving that contract is the single most important invariant in the
codebase.

Authoritative docs:

| File | Covers |
|---|---|
| `README.md` | Product, install, usage, versioning, phone-app workflow |
| `architecture.md` | CLI architecture, layers, data flow, milestones |
| `data-model.md` | Relational schema, indexes, FTS setup |
| `conjugation-engine.md` | Conjugation engine spec + validation |
| `tangorin_sources.md` | Data sources, licenses, provenance |
| `REVIEW-FIXES.md` | TEMPORARY — the current review plan (delete when done) |

## 2. Repo layout

```
src/            CLI + shared query/render layer (imported by BOTH front-ends)
  cli.ts        arg parsing + command glue (Node-only)
  lookup.ts     dictionary queries (word/kanji/search, thesaurus, sentences)
  format.ts     text rendering — the output contract the golden tests pin
  db/           schema.ts (DDL) · connection.ts · queries.ts
  version.ts    GENERATED build stamp (do not edit; see §7)
web/            phone app (PWA)
  app/main.ts   UI: queue, streaming panes, tree, localStorage, busy chrome
  app/worker.ts DB worker: sqlite-wasm boot, OPFS import/self-heal, lookups
  app/commands.ts  web replica of the CLI command glue (streaming sections)
  app/tree.ts   hierarchical result tree + duplicate tracker (pure, DOM-free)
  app/cache.ts  in-memory result cache (pure, DOM-free)
  app/worker-api.ts  message protocol types + OP_LADDERS progress ladders
  app/shim.ts   WasmDb statement shim over sqlite-wasm
  app/stroke-widget.ts  kanji stroke-order animation widget
  sw.js         service worker (offline shell; cache name stamped at build)
  index.html / style.css / manifest.webmanifest / icon.svg
  vendor/       pinned sqlite-wasm engine (ships without node_modules)
scripts/        version.mjs (stamp) · build-web.mjs · sw-version.mjs ·
                verify-web.mjs (e2e) · serve-web.mjs (TLS LAN server) ·
                profile-web.mjs · link-global.mjs
functions/      Cloudflare Pages Function — kanji.db.ts streams the dictionary
                from R2 · wrangler.toml (Pages + R2 config) ·
                pnpm-workspace.yaml (pnpm 11 build approvals)
tests/          node:test suites (goldens + unit) · fixtures/
data/           build pipeline (fetch/parse/transform → dist/kanji.db)
dist/           build artifact: kanji.db + strokes/ + web shell (gitignored)
```

## 3. Commands & quality gates

**Node version is critical.** `better-sqlite3` (native binding, `^11`) only
supports **Node 20–22** — it crashes on Node 24+. `package.json` declares
`"engines": ">=20 <24"` and `.nvmrc` pins **22** (CI runs 22). Use
`nvm use` / the pinned version. After switching Node, `pnpm rebuild
better-sqlite3`. Run everything with pnpm (corepack).

| Command | What it checks | Required? |
|---|---|---|
| `pnpm run typecheck` | `tsc --noEmit` for CLI/tests (`tsconfig.json`) | Always |
| `pnpm run web:typecheck` | `tsc -p tsconfig.web.json --noEmit` (web + shared layer) | Always |
| `pnpm test` | CLI golden + unit suites; **needs Node 20–22** (native binding) | Always |
| `pnpm exec tsx --test tests/web.test.ts` | web unit tests — run on **any** Node (no native deps; some tests skip below Node 22.13) | Always |
| `pnpm run validate:conjugations` | conjugation diff + gap fixtures | When touching conjugation |
| `pnpm run web:build && pnpm run web:verify` | full e2e in headless Chrome (import → lookups → offline reload). Needs `web/.certs` (`pnpm run web:gen-cert`) and Chrome (`CHROME_PATH` if not default) | When touching the web app |
| `pnpm run typecheck:functions` | `tsc -p tsconfig.functions.json --noEmit` (Cloudflare Pages Functions) | When touching `functions/` |
| `pnpm run deploy:web` | publish `dist/` to Cloudflare Pages + R2 (see README "Publish it online for free") | When publishing the web app |
| `pnpm run build:db` | rebuild `dist/kanji.db` (long; needs `data/raw/` sources) | Only when data/build changes |

**Definition of done for any web change:** both typechecks pass, `pnpm test`
green on Node 22, and `pnpm run web:build && pnpm run web:verify` fully green
(was 2× red on HEAD at review start; must stay 85/85). `pnpm test` needs the
Node 22 runtime — a local Node 24 cannot load better-sqlite3 (run under nvm or
rely on CI).

## 4. CLI architecture (brief)

- Read-only SQLite, `PRAGMA query_only = ON`, prepared statements only
  (`src/db/`). Services are pure functions over queries; CLI commands are thin
  (parse → service → format).
- **The golden tests pin the output byte-for-byte** (`tests/lookups.test.ts`,
  `tests/cli.test.ts`). Any change to `src/format.ts` / `src/lookup.ts` that
  alters rendered text is a breaking change — check the goldens.
- `tests/lookups.test.ts` contains the **`searchSections` join-equality guard**
  (a web-streaming invariant, see §5): section concatenation must equal the
  CLI's single-shot output.

## 5. Web app architecture & invariants

### Message protocol (`web/app/worker-api.ts`)

Main thread ↔ worker messages: `run` (request) → `status` / `boot` /
`progress` / `ready` / `op-section` / `op-progress` / `result` / `fatal`.
Requests carry an `id`; replies pair back by id.

### The streaming + progress ladder

- Every lookup streams: the pane (header + skeleton rows) appears immediately
  (`addSkeletonPane`), the worker emits one `op-section` per rendered section
  (word: body → thesaurus → examples; search: Readings → Meanings → Kanji;
  kanji: the page), the UI appends each raw chunk, and a final `result`
  (`text: null` on streamed success) swaps the skeleton for the canonical
  pane built by concatenating the sections.
- **Invariants (do not break):**
  - Sections must concatenate to the CLI text **byte-for-byte** (blank-line
    separators are carried by the sections themselves — never strip trailing
    newlines when appending).
  - `appendSectionText` keeps the trailing newline; stripping it collapses the
    blank lines between sections mid-stream.
  - Search `readings` can only be kept/emitted after `meanings` is known
    (`keepReadings` depends on it) — **do not** "optimize" readings to emit
    early; it breaks byte-identity. The search **header** section (the echoed
    query, section 0 of `searchSections`) depends on nothing and streams
    immediately; the worker also posts a pre-discovery `op-progress`
    heartbeat claiming the readings floor, so the bar leaves 0% at once and
    the watchdog is armed through the silent FTS discovery phase.
  - The divider bar is driven by `OP_LADDERS` floors; progress is **monotonic**
    and the eased creep must **never overshoot a floor** that a later section
    must claim (`setOpPct` never goes backwards; a stray claim parks the bar).
  - The worker re-arms the UI watchdog on every `op-section` / `op-progress`
    for the **active** op; messages for a cancelled/forgotten op are inert
    (gated on `opActiveId` + `cancelledOps`).
- **The queue is FIFO and only its head is ever posted.** Clicks during a
  lookup enqueue (never drop); per-command badges count panes still queued
  *behind* the in-flight head.

### The result tree + dedupe (`web/app/tree.ts`, pure)

- `resultTree` holds top-level nodes **newest-first** (`addResultToParent`
  unshifts); live DOM insertion prepends. **`renderResultTree` must iterate
  top-level nodes in reverse** so a reload preserves the live top-down order
  — **W4 is still open** (current code iterates forward, which flips history
  after reload; see REVIEW-FIXES W4).
- **Dedupe is action-level, keyed on the RAW box value** (`submit` in
  `main.ts`): `registerResult(parentId, command, raw)` once at submit time.
  Never re-register per expanded query (per-literal tracking is what swallowed
  `制作者` after standalone 制/作/者 lookups — fixed in W2; keep it that way).
  Intra-batch dedupe (`水 水` → one pane) stays a local `seen` set.
- Persisted state (`omakase.state`, v2) is **validated on restore, never blind
  cast**: `deserializeResultTree` prunes invalid nodes/children,
  `restoreCollapsedStates` treats non-boolean as false, and `restoreState`
  wraps the render in try/catch and wipes bad storage (W8). **Keep any new
  persisted field validated the same way** — a corrupt/foreign state must
  never crash boot or be re-persisted.
- **Input persistence is debounced, pane mutations are immediate** (W9): the
  query/max listeners go through `saveStateSoon` (~300 ms pause — full-tree
  serialization on every keystroke janks phones with many panes), while
  lookups/deletes/collapses/clears call `saveState()` right away, and
  `saveState()` cancels any pending debounce so a queued write never
  re-serializes a superseded state.
- After restore, **seed the node-id counter past restored ids**
  (`seedNodeIdFromTree`) — otherwise new lookups collide with restored ids.
- `deleteResultFromTree` recursion must walk `child.children`, never
  `[child]` (wrapping the child nested a self-clone — the "doubled nested
  panes after reload" bug).

### Cache (`web/app/cache.ts`)

In-memory LRU-ish cache of finished `ResultNode`s keyed by
`command\u0000query\u0000max` — NUL separators (like the queue `seen` keys)
so a query containing `|` can never be mis-split. The cache exposes only what
main.ts uses: `getCached` / `setCache` / `isFetchInProgress` /
`markFetchStarted` / `markFetchCompleted` / `clear`. Dead members were removed
in W10 — before adding any cache API, grep for callers first.

### Busy chrome & cancel (`main.ts`)

- The cancel control (`#cancel-op`) is a **sibling of the command buttons**,
  overlaid on the busy one — never nested inside a button (button-inside-
  button is invalid HTML and clobbered the label; W3).
- The spinner lives inside the active command button; the label is restored
  from `dataset.label` (the command name), **never** from live `textContent`
  (per-command badges live inside the buttons and would bake into the
  snapshot).
- `syncBusyUi` runs the badge pass **before** the spinner logic for the same
  reason.
- `handleResult` has a strict **protocol gate**: read the queue head and match
  `msg.id` BEFORE touching any state; a late reply for a cancelled/forgotten
  op must leave `inFlight` and the watchdog untouched (desync cascade bug).
- Cancelled panes are **not** tree nodes — no collapse toggle on them (inert).
- A lookup that errors, times out, or hits a dead worker always drains back to
  an idle control row; after `MAX_BOOT_FAILURES` the app gives up with a clear
  "reload the page" state.

### OPFS dictionary + self-healing (`web/app/worker.ts`)

- The dictionary lives in OPFS; `ensureDb` probes the existing copy: compares
  build stamps (re-import when the served `dist/meta.json` is newer) and runs
  `PRAGMA quick_check` via `dbLooksHealthy` (re-import when damaged — a
  truncated/interrupted import passes the old stamp-only probe and boots
  "ready" while every lookup fails; W5).
- Boot retries the open path **once** (`repairAttempted` guard) before sending
  `fatal`; per-lookup `database disk image is malformed` / `not a database`
  errors are escalated to `fatal` (worker restart re-runs the health check),
  not papered over with error panes.
- `dbLooksHealthy` is unit-tested against real node:sqlite fixtures (intact /
  tail-truncated / garbage), gated to skip below Node 22.13.

### Service worker & versioning (`web/sw.js`, `scripts/sw-version.mjs`)

- `web:build` stamps `dist/sw.js`'s CACHE constant and **versions the shell
  asset URLs** (`./style.css?v=<version>`, `./web/app/main.js?v=<version>`) in
  both `dist/index.html` and the SW precache — a new build can never resolve
  old cached assets (W6). `patchIndexHtml` / `patchSwCache` fail loudly if a
  target link is missing.
- The SW only `skipWaiting()`s on a **complete precache** and only purges old
  caches when the current cache holds every precache entry; navigations are
  network-first, other requests cache-first **scoped to the current cache
  name** (`caches.match(req, { cacheName: CACHE })`).
-  The 289 MB dictionary is **not** precached — it lives in OPFS only;
  `/kanji.db` requests always hit the network (browser HTTP cache applies).

### Free deployment (Cloudflare Pages + R2)

`functions/kanji.db.ts` + `wrangler.toml` + `scripts/deploy-web.mjs` publish
the app on Cloudflare's permanent free tier (see README "Publish it online
for free" for the manual one-time setup). The live project is `omakase-kun`
→ <https://omakase-kun.pages.dev>, bound to the R2 bucket `omakase-db` (the
`name` in wrangler.toml is the Pages project and the pages.dev label follows
from it — Cloudflare suffixes the label when the plain name is taken, which
is why the earlier `omakase` project served omakase-cub.pages.dev; deploy:web
prints the real domain rather than assuming it). The old `omakase` project
has since been deleted; the bucket stays, because it holds the dictionary.

The shell (dist/ minus kanji.db) goes to Pages — `dist/_headers`, emitted by build-web.mjs, supplies
COOP/COEP/CORP (cross-origin isolation the OPFS engine needs) and
`Cache-Control: no-cache` for index.html / sw.js / meta.json — while the
308 MB dictionary (over Pages' 25 MiB per-asset limit) lives in an R2
bucket and is streamed through the `kanji.db.ts` Function
(`env.DB.get("kanji.db")`, `Cache-Control: no-cache` so the browser
revalidates via the object's ETag instead of serving a stale overwritten
copy). `deploy:web` uploads dist/kanji.db to R2 and deploys the rest of
dist/ (parking the DB in `.deploy-tmp/` first; a leftover parked file is
restored on the next run). The R2 object and the served dist/meta.json
stamp must **always come from the same build** — the worker re-imports
whenever the stamps differ, so a mismatched pair re-imports every boot.
Keep `DB_PATH` root-absolute and the shell paths relative; the SW's
`/kanji.db` bypass is what lets the import always hit the network.

## 6. Quality procedures & test conventions

- **Unit tests test the shipped modules, not reimplementations** (W11):
  `tests/web.test.ts` imports the real `tree.ts` / `cache.ts` / `query.ts` /
  `commands.ts` code — the pure query helpers (`wordTokens`, `kanjiQuery`,
  `kanjiQueries`, `parseMax` + regexes) live in `web/app/query.ts` (DOM-free,
  imported by main.ts). The old inline fakes were dropped. When adding web
  logic, prefer pure DOM-free modules (`tree.ts`, `cache.ts`, `query.ts`,
  `commands.ts`) so it is unit-testable with `tsx --test` on any Node; DOM-
  bound behavior belongs in the e2e suite.
- **E2E lives in `scripts/verify-web.mjs`** (puppeteer-core, real Chrome,
  fresh profile, local https server). It covers boot/progress, streaming,
  busy/idle chrome, queued actions, multi-word/multi-kanji boxes, dedupe,
  tokens/nesting, reload persistence, offline reload, perf budgets
  (`develop < 8000 ms`), focus/hover, collapse/expand + restore, and corrupt-
  state recovery. It leaves the app in a clean state after each probe and
  waits for `ready` after every reload/viewport switch.
- **Golden output contract:** never change rendered text without updating the
  goldens deliberately — web panes and CLI output must stay identical.
- **Console hygiene:** the e2e asserts zero console/page errors (OPFS sidecar
  "NotFound" noise is filtered as benign); don't add stray `console.log`s to
  shipped code.
- **Web e2e that must stall/fail a request:** puppeteer `setRequestInterception` does
  NOT see fetches that go through the service worker (SW network fetches bypass it).
  The stroke-widget tests control the svg fetches with a `window.fetch` patch
  installed via `page.evaluateOnNewDocument` before the app loads, switching modes
  at runtime through a global (`window.__strokeFetchMode` = pass/delay/abort) —
  reuse that pattern rather than fighting request interception.

## 7. Version stamping & build counter

- `src/version.ts` is **generated** (`scripts/version.mjs`) — never edit by
  hand. The stamp `0.1.0-build.N` bumps on every `build:db` / `web:build` and
  on every commit (`.githooks/pre-commit` re-stamps and stages it).
- The counter lives in **gitignored `.build-number`**; `version.mjs` floors it
  at the committed BUILD in `src/version.ts`, so versions stay monotonic.
  **Commit `src/version.ts`, never `.build-number`** (W12 — a tracked counter
  desynced from the stamp). `.gitignore` must keep the file ignored; the
  pre-commit hook stages only `src/version.ts`.
- The SW cache name, index.html asset links, `dist/meta.json`, and the DB
  `meta` table all carry the same stamp — keep them consistent when touching
  versioning. `--print --json` reports a real `commitDate` parsed from the
  committed `COMMIT_DATE` (W12), never `""`.## 8. Known open work (from REVIEW-FIXES.md)

- **W13 (stroke-widget UX) and W14 (settings pane) are DONE** — see their statuses
  in REVIEW-FIXES.md. W14 moved the max cap into the settings dialog (default 5) and
  removed the header auto-scroll button + the `omakase.autoScroll` key; the e2e
  probes reference `#settings-max` now. Post-review fix: the closed dialog no longer
  renders in the page flow (author `display` on a `<dialog>` overrides the UA's
  closed-state hiding — scope layout rules to `#settings[open]`), and the e2e
  drives the ✕ with a real pointer click + visibility assertions.
- **W17a (shared renderer) and W17i (resumable paging) are DONE** — see their
  statuses in REVIEW-FIXES.md (Phase 3). W17a reworked the shared renderer:
  two-line gloss rows everywhere a writing/reading precedes a gloss (word
  thesaurus, kanji compounds, search rows, kanji Meanings split), thesaurus
  `… and N more` remainder notes, `--offset` on word/kanji/search with the new
  row-only helpers `thesaurusRowList`/`kanjiCompoundRows`/`searchRowList`, and
  new offset goldens. W17i built resumable paging on top: `ResultNode.pages`
  (persisted + W8-validated), the DOM-free `web/app/paging.ts` (`foldAnchors`
  folds per-section anchors into global line numbers, `splicePage` rewrites
  node.text/pages), load-more buttons inline in the pane pre, the ★W18a
  cached-path clone (a pane built from a cache entry must clone `pages` AND
  each `PageState` — `handlePageResult` mutates in place), the ★W18d page-
  request watchdog (`pageContext` + timeout re-arms the button, late replies
  inert), and `meaningRankCache` in commands.ts. Two landmines the e2e
  surfaced: `findNoteNode` must count `\n` boundaries, never child nodes
  (linkifyLine splits lines into per-character text nodes), and `splicePage`
  must advance `offset` by ROWS (`total - remaining`), never by inserted line
  count (compound/thesaurus rows are two lines each). Keep both when touching
  paging.
- **W16 (cosmetic overhaul: softened wood-block/monospace look + configurable
  bg/accent) is DONE** — see its status in REVIEW-FIXES.md. Post-review
  softening: the `--line-inner` inset double-frame was dropped (single
  `1px` border + faint pane lift shadow), moderate radii came back (8px
  panes, 6px controls, 4px chips), dark ink is warm-white `#e8e6e3` with no
  text-shadow, and the default tint is muted aquamarine `#A6DDCF`
  (not the neon `#7FFFD4`) — the mono chrome identity is unchanged.
  **Final revision (tone system):** the configurable color moved OUT of the
  page background into the surfaces — the app background is the neutral
  tint-less tone (`--bg`, no longer JS-overridden) and `--tint` (tone-1,
  `effectiveTint` in theme.ts) colors the input, the command buttons and
  even-depth panes; `--tint-soft` (tone-2) colors pane heads, the stroke
  strip and odd-depth panes, so nested results alternate tones by depth
  (`tone-tint`/`tone-soft` classes from each node's parentId chain; the
  skeleton/cancelled panes measure depth in the DOM). Pane command badges
  carry the accent, and dark mode caps the tint (`DARK_TINT_SCALE = 0.45`)
  so the light ink stays readable. The e2e W16 block forces the theme to
  light through the settings pane first — this environment's system
  preference is dark, so a fresh profile is not light by default — and pins
  the restyle through computed styles (`color-mix` results are normalized
  from `color(srgb …)` back to rgb in the probes).
- **W15 (footer anchoring + "i" dialog fit) is DONE** — see its status in
  REVIEW-FIXES.md. `body` is a flex column (`min-height: 100dvh`), `#panes` is
  `flex: 1 0 auto` (bottom padding cut to 10px — the footer owns the bottom
  spacing), and the credits panel is fixed and centered with `50vw/50vh` +
  `translate(-50%,-50%)`, viewport-constrained and internally scrollable with
  wrapping links. Two environment lessons from its e2e: under this suite's
  mobile emulation `window.innerHeight/innerWidth` report the emulated
  "inner" viewport (1119×523) while the CSS layout viewport is
  `documentElement.clientHeight/clientWidth` (900×420) — compare rects against
  the latter, never `window.inner*` — and `%` on a fixed element resolves
  against the emulated ICB, so the panel centers with vw/vh (identical on real
  devices). All W1–W16 are now implemented, and W17 Phases 1 + 2 are
  landed. Phase 1 (cosmetic): W17h font bump, W17g nested centering, W17b
  bar-to-top, W17-width overflow hardening, W17-settings-dvh fallback.
  Phase 2 (structural UI): W17c About modal (the header #version badge and
  the footer credits <details> became the About dialog — the only home of
  the build provenance now; idle status is a terse "ready"), W17e stroke ⏮
  rewind, W17f hide-on-scroll control row (rAF-throttled passive listener,
  .scrolled-down), W17d self-nesting (a pane's own literal/writing is plain
  text — never a button that would nest a pane into itself; the streaming
  sections linkify with the same rule via command/query on the skeleton
  entries), and W17j erase-all-data (settings danger zone: confirm →
  unregister SWs, delete caches, clear storage, wipe OPFS, reload). The
  e2e is 151 checks; the W17j block runs last (after the console-error
  probe) and its waitFor keys on a zero-pane fresh shell — the pre-wipe
  page is also idle "ready", so a status-only poll matches it before the
  async wipe + reload land.

## 9. Golden rules (the short version)

1. **Node 20–22 only** — never run/verify under Node 24+ without nvm.
2. **Never break byte-identity** between web panes and CLI output (sections
   join = CLI text; goldens pin it).
3. **Never break the web e2e** — `web:build && web:verify` must stay green;
   add e2e coverage for new UI behavior.
4. **Validate persisted state**; never blind-cast restore; never re-persist a
   state that crashed once.
5. **Dedupe on the raw user action**, never on expanded per-item queries.
6. **Never nest interactive elements inside buttons**; keep cancel/spinner
   chrome as siblings.
7. **Progress is monotonic; creep never overshoots floors; watchdog extends on
   real progress.**
8. **Trust nothing from OPFS without a `quick_check`**; self-heal, retry once,
   then fail loudly with a reload hint.
9. **`src/version.ts` is generated; `.build-number` is never committed.**
10. **Never style a `<dialog>` with an author `display` rule** — it overrides the
    UA's `dialog:not([open]) { display: none }` and the closed dialog renders
    permanently in the page flow (with a close button that can't close it).
    Scope layout to `[open]`, and e2e dialog probes must assert visibility, not
    just the `open` attribute.
11. **Pin UI restyles through computed styles in the e2e** (`backgroundColor`,
    `borderRadius`, `boxShadow`, `fontFamily`, `textShadow`) — CSS has no golden
    text to catch a regression, so a restyle that visually breaks can stay green.
    Never assume the browser's system color scheme: headless Chrome here reports
    dark, so theme-dependent probes must force the theme explicitly first.
12. **`REVIEW-FIXES.md` is temporary** — finish W1–W16, delete it, and keep
    this file as the durable record.
13. **Free hosting is Pages + R2, deployed via `pnpm run deploy:web`** — the
    shell goes to Pages (with `_headers` supplying COOP/COEP/CORP), the
    dictionary streams from R2 through `functions/kanji.db.ts`, and the R2
    object must always come from the same build as the deployed
    `dist/meta.json` (a stale pair makes the worker re-import on every boot).
    `name` in wrangler.toml is the Pages project *and* the pages.dev label,
    and several projects may share one bucket (they then serve the same
    dictionary — a shell-only re-deploy needs no R2 credentials at all).