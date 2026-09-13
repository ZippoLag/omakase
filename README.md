# omakase

A 100% offline Japanese quick-reference utilities, available as CLI tool and installable Progressive Web Application hosted at [omakase-kun.pages.dev](https://omakase-kun.pages.dev/). This tool can be used to look up dictionary entries with a thesaurus — synonyms, antonyms and related terms — via `word`, kanji pages via `kanji`, and search the dictionary by kana, romaji, or English gloss via `search`, all against a local SQLite database — no network access at query time.

> **Note from author:** Hi, I'm [Sebastián](https://github.com/zippolag), I love [tangorin](https://tangorin.com/), and if I could I would economically support them so their servers have all the oomph required to always reply in milliseconds, but sadly, I cannot. Hence, faced with the need to have a quick Japanese reference always available, and since I had access to [FREEBUFF](https://freebuff.com/get-started?ref=ref-48e765cb-2146-4cf9-8fba-2a2af1676e77&referrer=Sebasti%C3%A1n+Vansteenkiste) (affiliate link), I took the chance to iterate over my use cases and build just what I needed: a japanese reference app which I can access both as a CLI in my terminal and as a PWA in any device. I still have many improvements I would love to build on top of thise, but I've already exceeded the time limit I had set for myself not to go overboard with the scope.

## Requirements

- **Node.js 20–22** (see [Node version note](#node-version-note)). CI runs Node
  22 (pinned in [`.nvmrc`](.nvmrc)).

## Install (one command)

The repo ships a single installer that handles everything — building,
installing from scratch, and updating:

```bash
git clone <this-repo>
cd omakase
./install.sh
```

It picks the pinned Node (20–22), sets it as the nvm default, installs pnpm via
corepack, installs dependencies, builds the offline database, links the
`omakase` command onto your PATH, and verifies the toolchain
(typecheck + conjugation validation + the test suite). Re-run it any time to
refresh / update the whole setup — it fetches latest sources, rebuilds the DB,
and re-links.

Useful flags (see `./install.sh --help`):

```bash
./install.sh --force-db   # re-download dictionary sources and rebuild the DB
./install.sh --no-db      # skip the database build
./install.sh --no-pull    # skip `git pull` (fresh checkout or offline)
./install.sh --no-verify  # skip typecheck / validate / test
./install.sh --help       # show all options
```

## Uninstall

To cleanly revert everything the installer creates (the global `omakase`
command, `node_modules/`, and the `dist/` build), run:

```bash
./uninstall.sh              # remove global command, node_modules/, dist/
./uninstall.sh --purge      # also delete the downloaded dictionary sources
./uninstall.sh --help       # show all options
```

Run `./uninstall.sh` followed by `./install.sh` any time you want a clean,
from-scratch build (for example, to rebuild the native `better-sqlite3`
binding for a different Node version).

### Manual install

If you prefer to run each step yourself instead of using `./install.sh`:

```bash
git clone <this-repo>
cd omakase
# Use the pinned Node version (see node version note) and pnpm (via corepack):
corepack enable && corepack use   # installs the pnpm version from package.json
pnpm install

# Expose the `omakase` command on your PATH (optional but recommended):
pnpm link . --global

# Equivalent shortcut that only symlinks the command (does not re-run pnpm
# install / re-link dependencies the way `pnpm link` does):
pnpm run link:global
```

If you don't want to link `omakase`, you can always call the CLI through the
run script or `tsx`:

```bash
pnpm run cli -- word 食べる
pnpm exec tsx src/cli.ts word 食べる
```

### Build the database

Querying needs the offline dictionary first — build it from the pinned,
sha256-verified sources (downloaded once and cached in `data/raw/`):

```bash
pnpm run build:db
```

This writes `dist/kanji.db` (~290 MB) with ~219k words, ~13k kanji, and
~506k conjugation forms (built from the full `jmdict-eng` release, not the
common-only subset). Re-run it whenever you pull updated source data.

## Usage

```
omakase <command> [args...]
omakase --help              show the overview of all commands
omakase <command> --help    show detailed help for a command
```

### Help

- `omakase --help` or `omakase -h` — brief description and a list of all
  commands.
- `omakase --license` (also `--licenses`) — prints the full license &
  attribution text (MIT code license, every data-source and library license,
  and the disclaimers). The text is embedded in the CLI itself, so it works
  even when `omakase` is installed without the source tree (no `LICENSE.md`
  on disk); it never opens the database.
- `omakase <command> --help` or `omakase <command> -h` — detailed usage for
  that command (arguments, options, examples).

```
$ omakase --help
omakase 0.1.0-build.12 (23 commits, 4677205)

Japanese quick-reference CLI (100% offline)

Usage:
  omakase <command> [args...]
  omakase --version           show the app and dictionary build versions
  omakase --license           show the full license & attribution text
  omakase --help              show this overview
  omakase <command> --help    show help for a specific command

Commands:
  word    dictionary entry + thesaurus (synonyms/antonyms/related) + example sentences
  kanji   kanji page (readings, meanings, compounds)
  search  English gloss / kana / romaji search

Run "omakase <command> --help" for details on a command.
```

### `word` — dictionary entries + thesaurus

```bash
omakase word 食べる
omakase word 為る --limit 3          # first 3 senses only (also --limit=3)
```

Each entry also works as a thesaurus. Three provenance-separated blocks are
shown after the senses (up to 5 rows each, highest confidence first):

- **Synonyms** — words you could actually substitute: JMdict entries that
  cite each other, or build-time gloss-similarity edges whose best
  sense-level match clears a confidence gate (same part of speech, shared
  distinctive English gloss tokens).
- **Antonyms** — explicit JMdict antonyms (plus their backlinks).
- **Related** — one-way JMdict “see also” terms (plus backlinks), which are
  *not* synonyms and are labeled accordingly.

The relations are materialized at build time, so a lookup is a single indexed
read — no query-time full-text scoring. When nothing clears the bar the entry
shows no thesaurus block at all, rather than a list of guesses.

`--limit N` caps the senses; `--offset N` starts every thesaurus block N rows
in, and each block then shows its own `… and N more` remainder note. The same
`--offset` (and `--max`) windowing applies to the capped lists of `kanji` and
`search`.

```
$ omakase word 食べる
食べる [たべる] (common)

Writings: 食べる・喰べる
Readings: たべる
Furigana: 食[た]べる

Ichidan verb; transitive verb

  1. to eat
  2. to live on (e.g. a salary); to live off; to subsist on

$ omakase word 暑い
暑い [あつい] (common)

Writings: 暑い
Readings: あつい
Furigana: 暑[あつ]い

Adjective (keiyoushi)

  1. hot; warm; sultry; heated

Antonyms:
  寒い  [さむい]
     cold (e.g. weather)
```

### `kanji` — kanji pages and reading search

```bash
omakase kanji 食              # page for a literal
omakase kanji 制作者          # words containing 制・作・者, then a page each
omakase kanji 制作者 --max 5 # smaller word / compound lists
omakase kanji まか            # kanji whose readings start with まか
omakase kanji makase          # same, by romaji reading
```

Every list in `kanji` output is capped at **30 rows** by default; raise or
lower it with `-max N` (also `--max N` / `--max=N`, like `search`). One or
more kanji literals render a full page per character: stroke count,
grade/JLPT/frequency, classical radical, a kradfile radical breakdown,
on/kun/nanori readings, meanings, and compounds containing the character
(capped at N). A multi-kanji query
first lists **words containing the characters** — those with all of them
first, then subsets ranked by how many they match, common words first (also
capped at N) — followed by one page per character (`kanji 制作者` ≡ `kanji 制`
`kanji 作` `kanji 者`). Any other query is treated as a **reading**: kanji
whose on/kun/nanori readings start with it are listed — kana or romaji, with
the dot separators in kun readings (e.g. まか.せる) ignored:

```
$ omakase kanji makase
makase

  任  [まか.せる]  responsibility; duty; term; entrust to; appoint
  委  [まかせ]  committee; entrust to; leave to; devote; discard
```

A kanji page can also **draw its stroke order in the terminal**: add
`--strokes` to a single-literal page and the KanjiVG stroke diagram is
rendered as one braille frame per stroke (each frame shows the glyph drawn
so far, labelled `1/N`…`N/N` with the stroke type), above the normal page —
for characters the shipped KanjiVG set covers:

```
$ omakase kanji 食 --strokes | head -5
Stroke order (食, 9 strokes):

  1/9 (㇒)
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣦⠀⠀…
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⣟⠀⠀⠀⠀…
```

### `search` — readings and meanings, ranked

Results come back in up to three ranked sections (each capped at 30 rows by
default; raise it with `--max N`):

- **Readings** — kana / romaji reading-prefix matches (e.g. `たべ`, `taberu`,
  or `ta be ru`); each row shows the kana reading *and* its romaji
- **Meanings** — English-gloss matches: the query's words are ANDed and
  prefix-matched within a single sense, so `omakase search eat` finds “to
  eat” words and `omakase search develop film` finds
  現像 “development (of film)”
- **Kanji** — kanji whose on/kun/nanori readings start with the query (the
  same reading search as the `kanji` command)

Rows are sorted most-likely-first: an exact reading or exact gloss token
beats a prefix match, then common words beat rare ones, then entry id. A
query that is both a plausible reading and an English word shows both
sections — `search take` lists 竹-type readings (たけ) and “to take” meanings
side by side. When the terminal supports it, the literal overlap of your
query is **bolded** on each result: the romaji/kana of reading hits, the
matched gloss words of meaning hits. An ASCII search with no hits at all
prints a “did you mean” hint pointing at the reading-prefix path.

```
$ omakase search eat
eat

Meanings (2):
  食べる  [たべる]  to eat
  食う  [くう]  to eat

$ omakase search taberu
taberu

Readings (1):
  食べる  [たべる (taberu)]  to eat

Kanji (1):
  食  [た.べる]  eat; food

$ omakase search take --max 10
take

Readings (3):
  竹  [たけ (take)]  bamboo; the middle (of a three-tier ranking system)
  …

Meanings (12):
  取る  [とる]  to take
  …
```

## Exit codes

| Code | Meaning                                   |
|------|-------------------------------------------|
| `0`  | Success (including help and empty search) |
| `1`  | Missing command / cannot open the DB      |
| `2`  | Unknown command                           |

## Versioning

The app version is a **build stamp** shared by the CLI and the web app:
`<pkg-version>-build.<N>`, e.g. `0.1.0-build.12`, plus the git provenance it
was built from (commit count, short sha, commit date). It is generated into
`src/version.ts` by [`scripts/version.mjs`](scripts/version.mjs) and **bumps
automatically on every build and every commit**:

- **Per build** — `pnpm run build:db` and `pnpm run web:build` re-stamp first
  and print the new version as the first line of the build. `build:db` also
  records the stamp in the database (`meta` table) and `dist/meta.json`, so a
  dictionary can be traced to the exact build that produced it.
- **Per commit** — a pre-commit git hook (`.githooks/pre-commit`, installed
  by `./install.sh` via `core.hooksPath`) re-stamps `src/version.ts` and
  stages it, so every commit carries a fresh version number.

The counter lives in the gitignored `.build-number` file and never goes
backwards (it is floored at the last committed stamp), so versions stay
monotonic across clones and machines. To re-stamp by hand (e.g. after a
manual edit), run `pnpm run stamp`.

Where it shows up:

```bash
$ omakase --version
omakase 0.1.0-build.12 (23 commits, 4677205)
dictionary build: 0.1.0-build.10 (22 commits, 9f3c2b1)
```

`omakase --version` (also `-V`) needs no database for the app line; the
`dictionary build:` line appears when the DB carries a stamp. In the web app
the version lives in the header badge (hovering it shows the full stamp and
the dictionary build); the status bar keeps startup progress while the
engine boots and then a terse `ready — 218,577 words (100% offline)`.

## Phone web app (fully offline)

The same dictionary ships as a tiny static web app you can install on a phone
(Android Chrome or iOS Safari → *Add to Home Screen*). It runs the real
`dist/kanji.db` in an in-browser SQLite (sqlite-wasm) engine: the first time
you open it, the dictionary is copied into the phone's private storage
(OPFS), and from then on everything — lookups and the app itself — works
with no network at all. The UI is deliberately minimal: one input, three
buttons (`kanji` / `word` / `search`), and each click adds a result pane
below the buttons, pushing older results down.

The lookups reuse the exact query + rendering code as the CLI
(`src/lookup.ts` / `src/format.ts`), so panes show the same output the CLI
prints. The row-cap input next to the search box (a small integer box,
default 30) plays the role of the CLI's `-max`. Nothing is published
anywhere: you serve the app from your own computer over your home Wi-Fi,
once, to install it — or, if you'd rather have a public URL that works
forever, publish it to the free Cloudflare tier (see
[Publish it online for free](#publish-it-online-for-free-cloudflare-pages--r2)).

Lookups are **queued, never dropped**: only one runs at a time, and any
clicks that land while one is in flight (the interactive tokens below stay
tappable) simply join the queue and still get their own pane, in click
order, and while several lookups are pending **each command button shows a
badge with how many panes of its kind are still queued behind the one in
flight** (the spinner marks the running lookup; the badges count down as
each pane lands). Every lookup **streams**: its pane appears immediately
with a skeleton body, the worker posts each rendered section as it
completes (word: entry → thesaurus → examples; search: Readings → Meanings
→ Kanji; kanji: the page), and the divider bar under the controls shows the
current lookup's progress — ladder floors per section, with a real
measured percentage inside the long meaning search. The boxes also expand a
bit beyond the strict CLI one-query-one-run model — **word** with several
comma- and/or space-separated words looks each word up separately (each
pane is exactly what looking that word up alone returns), with repeats
deduplicated (`水 水` → one 水 lookup, and `水, 水, 食事` → the 水 and
食事 panes only). Dedupe also reaches across actions: a lookup that is
already pending — queued or in flight — is never enqueued again, so
clicking the same kanji or word token twice in a row still yields a single
pane. **kanji** ignores every non-kanji character in the box (`食べる` →
食) and then looks up **each kanji it contains as its own lookup** —
`制・作者` → `kanji 制` + `kanji 作` + `kanji 者`, one per character — so
every individual kanji page comes back, each byte-identical to looking the
character up alone and each rendered as soon as its own lookup finishes (a
multi-kanji box resolves one kanji at a time instead of
freezing until the whole batch is ready); kana/romaji boxes still run the
kanji-by-reading search. **search** is unchanged — it always gets the raw
query, verbatim.

Lookups are fast because the shared query layer never full-scans: every
word a kanji page or a search loads reads its furigana ruby through the
indexed `furigana(word_id)` lookup (`idx_furigana_word`, schema v3), which
kept a single kanji page in the WASM engine from taking seconds on a phone.

Result panes are interactive: every kanji character shown is individually
tappable (equivalent to typing it alone and pressing **kanji**), and each
dictionary word displayed in a list (compounds, multi-kanji “Words”, search
hits, thesaurus rows) carries a small magnifier icon at its left that looks
the whole word up (equivalent to typing it and pressing **word**).

Kanji pages also get a **stroke-order animation**: each kanji pane opens
with a widget for its character that draws the strokes in order, with a ↻
button to replay (a multi-kanji box yields one such pane per character, so
`kanji 制作者` mounts three widgets across its three panes). The diagrams come
from the same KanjiVG svg files the CLI's `--strokes` uses — they are fetched
lazily (a few KB each, cached by the service worker on first view), so the
first kanji page you open adds nothing to the one-time dictionary import.

### Build & run once on your computer

```bash
# 1. Build the web bundle (also needs dist/kanji.db — run ./install.sh or pnpm run build:db first)
pnpm run web:build

# 2. Create a TLS cert trusted by your machines (needs mkcert: brew install mkcert)
pnpm run web:gen-cert     # prints the CA file path; also installs it on this Mac

# 3. Serve over your LAN (https, with the COOP/COEP headers the engine needs)
pnpm run web:serve        # prints your https://<lan-ip>:8443 URL
```

`pnpm run web:verify` runs an automated end-to-end check in headless Chrome
(import → lookups → offline reload); set `CHROME_PATH` if Chrome isn't in the
default location.

The UI keeps its state in `localStorage`: the input box, the last used
command, the max count, and the result history are restored on reload. Each
result pane has a red trashbin that deletes that single result (from the list
and the stored history); the header has one that clears every result.

### Trust the certificate on your phone (one time)

The server uses a locally-generated CA (`mkcert`). Install its root
certificate on each phone (the path is printed by `web:gen-cert`):

- **Android**: copy `rootCA.pem` to the phone (USB / Drive), then
  *Settings → Security → More security settings → Install a certificate →
  CA certificate* and pick the file.
- **iPhone**: AirDrop `rootCA.pem` to the phone, *Settings → General → VPN &
  Device Management* → install the profile, then *Settings → General →
  About → Certificate Trust Settings* → enable full trust for it.

### Install on the phone

Open `https://<your-lan-ip>:8443` in the phone browser (same Wi-Fi as your
computer), wait for the one-time import (progress bar; ~340 MB), then
**Add to Home Screen** (Android Chrome: menu → *Add to Home screen*; iOS
Safari: *Share → Add to Home Screen*). Afterwards the app opens full-screen
and works offline — airplane mode included. The computer only needs to be on
when you (re)install or update.

### Notes & limits

- Needs a browser with OPFS + SharedArrayBuffer (Chrome 108+, Safari 17+);
  iPhone/iPad Safari 16.x can't run the OPFS engine. The server must stay
  https with the COOP/COEP headers — the provided `serve-web` script does
  this.
- The dictionary occupies ~340 MB of phone storage (it lives in the
  browser's private origin storage, so iOS may evict it only under extreme
  storage pressure; re-opening the app re-imports if it is gone). Stroke
  diagrams are separate small files (~6.4k KanjiVG svgs, ~40 MB in `dist/`,
  CC BY-SA 3.0 © Ulrich Apel): only the ones you actually view are fetched
  and cached, on top of the dictionary import.
- Updating the app = rebuild + re-serve, then open the app once online; the
  service worker cache version is stamped from the build version at
  `web:build` time, so it bumps automatically on every build (old caches are
  purged on the next visit). A rebuilt **dictionary** reaches existing
  installs the same way: the worker compares the build stamp in OPFS with
  the one served in `dist/meta.json` and re-imports the new file when they
  differ (you see the import progress bar again).
- `web/vendor/` holds the pinned sqlite-wasm engine (see its README) so the
  web app builds and serves without `node_modules`.

### Publish it online for free (Cloudflare Pages + R2)

The same `dist/` can be published to the **permanent free tier** of
Cloudflare — no server, no credit card, no bandwidth bill. This is the
"host it forever" path: anyone opens the URL (or installs the PWA from it)
and the ~340 MB dictionary is downloaded once per device into its own
storage, exactly like the LAN install.

Why Cloudflare, specifically:

- The app must run under **cross-origin isolation** — the sqlite-wasm OPFS
  engine needs SharedArrayBuffer, which requires `Cross-Origin-Opener-Policy`
  / `Cross-Origin-Embedder-Policy` response headers. Cloudflare Pages is the
  free host that lets you set custom headers (via `dist/_headers`, emitted
  by `web:build`); GitHub Pages, Neocities, Surge, etc. cannot, so the app
  can't run there.
- The ~341 MB `kanji.db` exceeds every free host's per-file limit (Pages
  itself caps assets at 25 MiB), so it is stored in **Cloudflare R2** (10 GB
  free, no egress fees) and streamed to the app through a tiny Pages
  Function at `/kanji.db`.
- Pages and R2 charge **nothing for bandwidth** on the free tier — each
  device's ~341 MB one-time import costs $0, forever. Netlify/Vercel's free
  100 GB/month would be exhausted after ~300 imports.

```
browser / phone
  ├─ https://<project>.pages.dev/         app shell = dist/ minus kanji.db
  │     · index.html, sw.js, web/app/*.js, strokes/, …
  │     · _headers → COOP/COEP/CORP (cross-origin isolation)
  └─ https://<project>.pages.dev/kanji.db  Pages Function → R2 bucket
        · streams the dist/kanji.db uploaded by deploy:web
```

#### One-time setup (manual steps)

1. **Create a free Cloudflare account** at dash.cloudflare.com/sign-up (no
   credit card).
2. **Install dependencies**: `pnpm install` (wrangler is a devDependency).
3. **Log in wrangler**: `pnpm exec wrangler login` (opens a browser). For
   CI, set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` instead.
4. **Create R2 API credentials** (for the dictionary upload — wrangler's
   `r2 object put` caps files at 300 MiB, and `kanji.db` is ~341 MB
   (325 MiB), so
   the upload goes through R2's S3-compatible multipart API instead):
   dash.cloudflare.com → R2 → **Manage R2 API Tokens** → **Create API
   Token** (Object Read & Write, bucket: `omakase-db`), then either export
   them or write them to the gitignored `.env` / `.dev.vars` (which
   `deploy:web` reads for you — no shell setup needed on later releases):
   ```bash
   export R2_ACCESS_KEY_ID=<access key id>
   export R2_SECRET_ACCESS_KEY=<secret access key>
   ```
5. **Build**: `pnpm run web:build` (needs `dist/kanji.db` — run
   `./install.sh` or `pnpm run build:db` first).
6. **Deploy**: `pnpm run deploy:web` — it creates the R2 bucket
   (`omakase-db`) and the Pages project (`omakase-kun`, live at
   <https://omakase-kun.pages.dev>) automatically on first run, and prints
   the exact URL afterwards (edit `name` in `wrangler.toml` first if you
   want a different project). Cloudflare suffixes the domain when
   `<name>.pages.dev` is already taken globally (the earlier `omakase`
   project landed at `omakase-cub.pages.dev` for exactly that reason), so
   trust the printed URL over a hardcoded one.
7. **Open the printed URL** — the first visit shows the one-time
   import progress bar (~340 MB); afterwards the app works offline exactly
   like the LAN install, and can be added to the home screen.

#### Every release

```bash
pnpm run web:build && pnpm run deploy:web    # or: pnpm run deploy:web -- --build
```

`deploy:web` uploads `dist/kanji.db` to R2 via multipart (key `kanji.db`;
needs the `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` env vars from step
4), temporarily
parks it out of `dist/` (Pages rejects the 25 MiB-per-asset limit), deploys
the rest to Pages, and restores it. Both halves come from the **same build**,
so the served `dist/meta.json` stamp and the dictionary in R2 always match:
existing installs re-import exactly when a new build ships, and never
twice. (Run `node scripts/deploy-web.mjs --help` for options: `--build`,
`--branch`.)

Notes:

- **Stamp sync is by construction** — `build:db` writes `dist/kanji.db` and
  `dist/meta.json` together, and `deploy:web` ships both halves from that one
  `dist/`, so the dictionary in R2 and the served `meta.json` always agree.
  Never upload a `kanji.db` to R2 from a different build than the `dist/` you
  deploy: the worker's update check compares the served `meta.json` stamp
  with the copy in OPFS, so a mismatched pair would re-import on every boot.
- **The shell and the dictionary carry separate build stamps.** `build:db`
  stamps `dist/meta.json` (and the dictionary's own `meta` table) with the
  **dictionary** build; `web:build` stamps the **shell** (index.html/sw.js
  asset URLs and the service-worker cache name) with its own number and does
  **not** touch `meta.json`. Clients re-import based on the dictionary stamp,
  so rebuilding only the shell never forces a ~341 MB re-download, and the
  About dialog shows both.
- **A `build:db` that changed the dictionary must ship with the shell** —
  run the full `pnpm run deploy:web`. A *shell-only* re-deploy (parking
  `dist/kanji.db` aside and running `pnpm exec wrangler pages deploy --branch
  main`, which needs no R2 credentials) is only safe while the dictionary in
  R2 is unchanged: after a schema bump the app refuses to boot on the older
  dictionary with an explicit "the served dictionary was built for schema N,
  but this app needs M" error instead of silently failing every thesaurus
  lookup — but the fix is still the full deploy.
- **Shell-only re-deploys need no R2 credentials**: when the bucket already
  holds the dictionary for the current build (e.g. a second Pages project
  bound to the same bucket), the parked-dictionary Pages deploy above
  publishes the shell on its own — the `/kanji.db` route keeps streaming the
  R2 object unchanged.
- **Several projects can share one bucket** — they then serve the same
  dictionary, so one `deploy:web` release updates all of them at once (and
  they can never drift apart).
- **Custom domain**: add it in the Pages dashboard (free plan: 100 custom
  domains); the app's root-relative paths work unchanged.
- **Free-tier budget**: R2 storage 10 GB (this app: ~0.34 GB), Pages 20,000
  files (we ship ~6.5k), Pages Functions 100k requests/day; bandwidth is
  unmetered on both.

## Development

```bash
pnpm run typecheck             # tsc --noEmit
pnpm test                      # golden + unit tests (node:test via tsx)
pnpm run validate:conjugations # conjugations diff + gap fixtures
```

Data sources, the relational schema, and the CLI output format contract are
documented in [`data-model.md`](data-model.md) and
[`architecture.md`](architecture.md) (the golden tests encode the exact output
format byte-for-byte). The stroke-order data (KanjiVG, CC BY-SA 3.0) is
fetched at build time into `dist/strokes/` and indexed by the `stroke_order`
table (see `tangorin_sources.md` §2 and `tests/fixtures/README.md` for
provenance).

## Credits & licenses

omakase is built **by [Sebastián R. Vansteenkiste](https://github.com/zippolag)
via [DeepSeek V4 Flash](https://www.deepseek.com/) @
[FREEBUFF](https://freebuff.com/get-started?ref=ref-48e765cb-2146-4cf9-8fba-2a2af1676e77&referrer=Sebasti%C3%A1n+Vansteenkiste)** (affiliate link). It is an independent, from-scratch
reimplementation inspired by [tangorin.com](https://tangorin.com/) (the free
Japanese–English dictionary initially developed by Gregory Bober and now owned
by Archie Preston) — no Tangorin code or data is included; all dictionary
content comes from the upstream open projects below.

The app code is MIT-licensed; the dictionary data it builds keeps the
share-alike licences of its sources. Full license texts and disclaimers live in
[`LICENSE.md`](LICENSE.md), every third-party source and library is listed with
its copyright and license text in [`NOTICE.md`](NOTICE.md), and the
source/license research is documented in
[`tangorin_sources.md`](tangorin_sources.md). The same attribution shows up in
`omakase --help`, behind the “i” button in the web app footer, and in full via
`omakase --license` (the text is embedded in the CLI, so it prints even when
the command is installed without the source tree).

| What | Source | License |
|---|---|---|
| Word dictionary | [JMdict](https://www.edrdg.org/jmdict/edict_doc.html) (via [jmdict-simplified](https://github.com/scriptin/jmdict-simplified)) | CC BY-SA 4.0 © James W. Breen & EDRDG (NPM packages MIT) |
| Kanji dictionary | [KANJIDIC2](https://www.edrdg.org/kanjidic/kanjd2index.html) | CC BY-SA 4.0 © James W. Breen & EDRDG |
| Radical decomposition | kradfile-u / radkfile | CC BY-SA 4.0 (kradfile-u © Jim Rose, KanjiCafe.com) |
| Ruby / furigana | [JmdictFurigana](https://github.com/Doublevil/JmdictFurigana) | MIT (data derived from JMdict, CC BY-SA 4.0) |
| Stroke order | [KanjiVG](https://kanjivg.tagaini.net/) | CC BY-SA 3.0 © Ulrich Apel |
| Example sentences | [Tatoeba](https://tatoeba.org/) | CC BY 2.0 FR (some CC0) |
| SQLite engine (CLI) | [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) | MIT |
| SQLite engine (web) | [@sqlite.org/sqlite-wasm](https://sqlite.org/wasm) | Apache-2.0 (SQLite itself: public domain) |
| Dev tooling | TypeScript, tsx, puppeteer-core, @types/* | Apache-2.0 / MIT |

## Node version note

Queries run through the [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3)
**native** binding (`^11`), which supports Node 20–22 but not Node 24+ (its
binary crashes on GC there). `package.json` therefore declares
`"engines": ">=20 <24"`, and [`.nvmrc`](.nvmrc) pins **22**. `./install.sh`
switches to this pinned version (via nvm) and sets it as your nvm default, so
the `omakase` command and all pnpm dev commands work in any shell. If you
switch Node versions after installing, rebuild the native binding to match
(`pnpm rebuild better-sqlite3`).