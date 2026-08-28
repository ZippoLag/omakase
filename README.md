# omakase

A 100% offline Japanese quick-reference CLI. Look up dictionary entries
(`word`), kanji pages (`kanji`), and search the dictionary by kana, romaji, or
English gloss (`search`), all against a local SQLite database — no network
access at query time.

## Requirements

- **Node.js 20–22** (see [Node version note](#node-version-note)). CI runs Node
  22 (pinned in [`.nvmrc`](.nvmrc)).

## Install

```bash
git clone <this-repo>
cd omakase
# Use the pinned Node version (see node version note) and pnpm (via corepack):
corepack enable && corepack use   # installs the pnpm version from package.json
pnpm install

# Expose the `omakase` command on your PATH (optional but recommended):
pnpm link --global
```

If you don't want to `pnpm link --global`, you can always call the CLI through
the run script or `tsx`:

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

This writes `dist/kanji.db` (~47 MB) with ~22k words, ~13k kanji, and ~111k
conjugation forms. Re-run it whenever you pull updated source data.

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

### `kanji` — kanji pages

```bash
omakase kanji 食
omakase kanji 水
```

Shows stroke count, grade/JLPT/frequency, classical radical, on/kun/nanori
readings, meanings, and compounds containing the character.

### `search` — gloss / kana / romaji search

How the query is interpreted depends on its form:

- **kana input** → reading-prefix match, e.g. `omakase search たべ`
- **ASCII input** → romaji reading-prefix match, e.g. `omakase search taberu`;
  if nothing matches, falls back to an English gloss token search, e.g.
  `omakase search eat`

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
`"engines": ">=20 <24"`, and [`.nvmrc`](.nvmrc) pins **22**. Make sure your
shell is on the pinned Node (e.g. `nvm use`) before running pnpm, and use
[corepack](https://corepack.nodejs.org/) (enabled via `corepack enable`) so the
pnpm version pinned in `package.json` (`packageManager`) — and committed
`pnpm-lock.yaml` — are used consistently. If you switch to a different Node
version, rebuild the native binding to match it
(`pnpm rebuild better-sqlite3`).