# omakase

A 100% offline Japanese quick-reference CLI. Look up dictionary entries
(`word`), kanji pages (`kanji`), and search the dictionary by kana, romaji, or
English gloss (`search`), all against a local SQLite database — no network
access at query time.

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
  word    dictionary entry + example sentences
  kanji   kanji page (readings, meanings, compounds)
  search  English gloss / kana / romaji search

Run "omakase <command> --help" for details on a command.
```

### `word` — dictionary entries

```bash
omakase word 食べる
omakase word 為る --limit 3          # first 3 senses only (also --limit=3)
```

```
$ omakase word 食べる
食べる [たべる] (common)

Writings: 食べる・喰べる
Readings: たべる
Furigana: 食[たべ]る

Ichidan verb; transitive verb

  1. to eat
  2. to live on (e.g. a salary); to live off; to subsist on
```

### `kanji` — kanji pages and reading search

```bash
omakase kanji 食        # page for a literal
omakase kanji まか      # kanji whose readings start with まか
omakase kanji makase    # same, by romaji reading
```

A single kanji literal renders the full page (stroke count, grade/JLPT/
frequency, classical radical, on/kun/nanori readings, meanings, and compounds
containing the character). Any other query is treated as a **reading**: kanji
whose on/kun/nanori readings start with it are listed — kana or romaji, with
the dot separators in kun readings (e.g. まか.せる) ignored:

```
$ omakase kanji makase
makase

  任  [まか.せる]  responsibility; duty; term; entrust to; appoint
  委  [まかせ]  committee; entrust to; leave to; devote; discard
```

### `search` — gloss / kana / romaji search

How the query is interpreted depends on its form:

- **kana input** → reading-prefix match, e.g. `omakase search たべ`
- **ASCII input** → romaji reading-prefix match, e.g. `omakase search taberu`;
  an exact reading wins; otherwise an English gloss token search is preferred
  when it matches, e.g. `omakase search eat`

Word hits are followed by a **Kanji:** section listing kanji whose
on/kun/nanori readings start with the query (the same reading search as the
`kanji` command):

```
$ omakase search makase
makase

  任せる  [まかせる]  to leave (a matter, decision, etc. to someone)
  …

Kanji:
  任  [まか.せる]  responsibility; duty; term; entrust to; appoint
```

```bash
$ omakase search taberu
taberu

  食べる  [たべる]  to eat

$ omakase search eat
eat

  遣る  [やる]  to do
  食べる  [たべる]  to eat
  …
```

## Exit codes

| Code | Meaning                                   |
|------|-------------------------------------------|
| `0`  | Success (including help and empty search) |
| `1`  | Missing command / cannot open the DB      |
| `2`  | Unknown command                           |

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