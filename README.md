# japanese-cli

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
npm install

# Expose the `japanese` command on your PATH (optional but recommended):
npm link
```

If you don't want to `npm link`, you can always call the CLI through the run
script or `tsx`:

```bash
npm run cli -- word 食べる
npx tsx src/cli.ts word 食べる
```

### Build the database

Querying needs the offline dictionary first — build it from the pinned,
sha256-verified sources (downloaded once and cached in `data/raw/`):

```bash
npm run build:db
```

This writes `dist/kanji.db` (~47 MB) with ~22k words, ~13k kanji, and ~111k
conjugation forms. Re-run it whenever you pull updated source data.

## Usage

```
japanese <command> [args...]
japanese --help              show the overview of all commands
japanese <command> --help    show detailed help for a command
```

### Help

- `japanese --help` or `japanese -h` — brief description and a list of all
  commands.
- `japanese <command> --help` or `japanese <command> -h` — detailed usage for
  that command (arguments, options, examples).

```
$ japanese --help
Japanese quick-reference CLI (100% offline)

Usage:
  japanese <command> [args...]
  japanese --help              show this overview
  japanese <command> --help    show help for a specific command

Commands:
  word    dictionary entry + example sentences
  kanji   kanji page (readings, meanings, compounds)
  search  English gloss / kana / romaji search

Run "japanese <command> --help" for details on a command.
```

### `word` — dictionary entries

```bash
japanese word 食べる
japanese word 為る --limit 3          # first 3 senses only (also --limit=3)
```

```
$ japanese word 食べる
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
japanese kanji 食
japanese kanji 水
```

Shows stroke count, grade/JLPT/frequency, classical radical, on/kun/nanori
readings, meanings, and compounds containing the character.

### `search` — gloss / kana / romaji search

How the query is interpreted depends on its form:

- **kana input** → reading-prefix match, e.g. `japanese search たべ`
- **ASCII input** → romaji reading-prefix match, e.g. `japanese search taberu`;
  if nothing matches, falls back to an English gloss token search, e.g.
  `japanese search eat`

```bash
$ japanese search taberu
taberu

  食べる  [たべる]  to eat

$ japanese search eat
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
npm run typecheck             # tsc --noEmit
npm test                      # golden + unit tests (node:test via tsx)
npm run validate:conjugations # conjugations diff + gap fixtures
```

Data sources, the relational schema, and the CLI output format contract are
documented in [`data-model.md`](data-model.md) and
[`architecture.md`](architecture.md) (the golden tests encode the exact output
format byte-for-byte).

## Node version note

Queries run through the [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3)
**native** binding (`^11`), which supports Node 20–22 but not Node 24+ (its
binary crashes on GC there). `package.json` therefore declares
`"engines": ">=20 <24"`, and [`.nvmrc`](.nvmrc) pins **22**. If you switch to a
different Node version, rebuild the native binding to match it
(`npm rebuild better-sqlite3`).