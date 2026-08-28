/**
 * CLI help handling: `japanese --help` / `-h` shows the overview of all
 * commands, and `japanese <command> --help` / `-h` shows detailed usage for
 * that command. Help paths must not require (or open) the database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";

/** Run `main` with captured stdout/stderr; the DB path is never reached. */
function run(argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = main(
    argv,
    "/nonexistent/kanji.db", // help returns before opening the DB
    (s) => {
      stdout += s;
    },
    (s) => {
      stderr += s;
    },
  );
  return { code, stdout, stderr };
}

test("no args: shows base help on stdout, exits 1", () => {
  const { code, stdout } = run([]);
  assert.equal(code, 1);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(/japanese <command> \[args\.\.\.\]/.test(stdout));
});

test("--help: shows base help listing all commands, exits 0", () => {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout, stderr } = run([flag]);
    assert.equal(code, 0, `${flag} exit code`);
    assert.equal(stderr, "", `${flag} writes no error`);
    assert.ok(stdout.includes("Japanese quick-reference CLI"));
    for (const cmd of ["word", "kanji", "search"]) {
      assert.ok(stdout.includes(cmd), `${flag} lists command: ${cmd}`);
    }
  }
});

test("word --help: detailed usage with --limit, exits 0", () => {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout } = run(["word", flag]);
    assert.equal(code, 0);
    assert.ok(stdout.includes("japanese word <writing>"));
    assert.ok(stdout.includes("--limit N"));
  }
});

test("kanji --help: detailed usage with <literal>, exits 0", () => {
  const { code, stdout } = run(["kanji", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("japanese kanji <literal>"));
  assert.ok(stdout.includes("stroke count"));
});

test("search --help: detailed usage describing input forms, exits 0", () => {
  const { code, stdout } = run(["search", "-h"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("japanese search <query>"));
  assert.ok(stdout.includes("gloss token search"));
});

test("unknown command: error to stderr with base help, exits 2", () => {
  const { code, stdout, stderr } = run(["bogus"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("unknown command: bogus"));
  assert.ok(stderr.includes("Usage:"));
});

test("help wins over a missing database", () => {
  // The dbPath is bogus; help must still succeed because it never opens the DB.
  const { code, stdout } = run(["word", "--help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("japanese word"));
});