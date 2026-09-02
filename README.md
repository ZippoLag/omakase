# omakase

A 100% offline Japanese quick-reference CLI. Look up dictionary entries with
a thesaurus — synonyms and antonyms — via `word`, kanji pages via `kanji`,
and search the dictionary by kana, romaji, or English gloss via `search`, all
against a local SQLite database — no network access at query time.

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
- `omakase <command> --help` or `omakase <command> -h` — detailed usage for
  that command (arguments, options, examples).

```
$ omakase --help
Japanese quick-reference CLI (100% offline)

Usage:
  omakase <command> [args...]
  omakase --help              show this overview
  omakase <command> --help    show help for a specific command

Commands:
  word    dictionary entry + thesaurus (synonyms/antonyms) + example sentences
  kanji   kanji page (readings, meanings, compounds)
  search  English gloss / kana / romaji search

Run "omakase <command> --help" for details on a command.
```

### `word` — dictionary entries + thesaurus

```bash
omakase word 食べる
omakase word 為る --limit 3          # first 3 senses only (also --limit=3)
```

Each entry also works as a thesaurus: the top **synonyms** (up to 5) and
**antonyms** (up to 5) are taken from the entry's JMdict cross-references —
extended at build time with reverse links and 2-hop closure so referenced
words and indirect relationships show up too — and shown after the senses,
when present — common words first. When an entry has no cross-references at
all, up to 5 related words are inferred from shared, distinctive English
gloss tokens (same part of speech preferred), so nearly every common word
gets a thesaurus.

```
$ omakase word 食べる
食べる [たべる] (common)

Writings: 食べる・喰べる
Readings: たべる
Furigana: 食[たべ]る

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
  寒い  [さむい]  cold (e.g. weather)
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
grade/JLPT/frequency, classical radical, on/kun/nanori readings, meanings,
and compounds containing the character (capped at N). A multi-kanji query
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
once, to install it.

Result panes are interactive: every kanji character shown is individually
tappable (equivalent to typing it alone and pressing **kanji**), and each
dictionary word displayed in a list (compounds, multi-kanji “Words”, search
hits, thesaurus rows) carries a small magnifier icon at its left that looks
the whole word up (equivalent to typing it and pressing **word**).

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
computer), wait for the one-time import (progress bar; ~300 MB), then
**Add to Home Screen** (Android Chrome: menu → *Add to Home screen*; iOS
Safari: *Share → Add to Home Screen*). Afterwards the app opens full-screen
and works offline — airplane mode included. The computer only needs to be on
when you (re)install or update.

### Notes & limits

- Needs a browser with OPFS + SharedArrayBuffer (Chrome 108+, Safari 17+);
  iPhone/iPad Safari 16.x can't run the OPFS engine. The server must stay
  https with the COOP/COEP headers — the provided `serve-web` script does
  this.
- The dictionary occupies ~300 MB of phone storage (it lives in the
  browser's private origin storage, so iOS may evict it only under extreme
  storage pressure; re-opening the app re-imports if it is gone).
- Updating the app = rebuild + re-serve, then open the app once online; the
  service worker cache version (`web/sw.js` `CACHE`) is bumped on releases.
- `web/vendor/` holds the pinned sqlite-wasm engine (see its README) so the
  web app builds and serves without `node_modules`.

## Development

```bash
pnpm run typecheck             # tsc --noEmit
pnpm test                      # golden + unit tests (node:test via tsx)
pnpm run validate:conjugations # conjugations diff + gap fixtures
```

Data sources, the relational schema, and the CLI output format contract are
documented in [`data-model.md`](data-model.md) and
[`architecture.md`](architecture.md) (the golden tests encode the exact output
format byte-for-byte).

## Node version note

Queries run through the [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3)
**native** binding (`^11`), which supports Node 20–22 but not Node 24+ (its
binary crashes on GC there). `package.json` therefore declares
`"engines": ">=20 <24"`, and [`.nvmrc`](.nvmrc) pins **22**. `./install.sh`
switches to this pinned version (via nvm) and sets it as your nvm default, so
the `omakase` command and all pnpm dev commands work in any shell. If you
switch Node versions after installing, rebuild the native binding to match
(`pnpm rebuild better-sqlite3`).