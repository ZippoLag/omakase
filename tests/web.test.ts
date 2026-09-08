/**
 * Web UI tests — against the REAL shipped modules (tree.ts, cache.ts,
 * query.ts, commands.ts), never inline re-implementations (W11): the old
 * fakes passed vacuously and could not catch regressions. DOM-free modules
 * are tested directly here; DOM-bound behavior (streaming panes, collapse
 * DOM, busy chrome, restore render, dedupe in the live queue) is covered by
 * the e2e suite (scripts/verify-web.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbLooksHealthy } from "../web/app/commands.js";
import { ResultCacheManager } from "../web/app/cache.js";
import {
  addResultToParent,
  clearDuplicateTracker,
  clearResultTree,
  countResults,
  createErrorResultNode,
  createResultNode,
  deleteResultFromTree,
  deserializeResultTree,
  findResultById,
  hasDuplicate,
  isValidResultNode,
  migrateToHierarchical,
  registerResult,
  resetNodeIdGenerator,
  restoreCollapsedStates,
  seedNodeIdFromTree,
  serializeCollapsedStates,
  toggleResultCollapse,
  unregisterResult,
} from "../web/app/tree.js";
import { kanjiQueries, kanjiQuery, parseMax, wordTokens } from "../web/app/query.js";
import {
  DARK_TINT_SCALE,
  DEFAULT_ACCENT,
  DEFAULT_BG,
  DEFAULT_BG_MIX,
  DARK_BASE,
  LIGHT_BASE,
  effectiveBg,
  effectiveTint,
  isHexColor,
  mixHex,
} from "../web/app/theme.js";

// node:sqlite only exists unflagged on Node ≥22.13 (absent on Node 20, behind
// --experimental-sqlite on 22.5–22.12). The dbLooksHealthy tests below need a
// real SQLite file, so gate them instead of crashing the whole suite on older
// runtimes — the project still supports Node 20 for the better-sqlite3-driven
// tests, and CI runs .nvmrc=22 (≥22.13), where these do run.
const DatabaseSync = await import("node:sqlite").then(
  (m) => m.DatabaseSync as typeof import("node:sqlite").DatabaseSync | undefined,
  () => undefined,
);
const sqliteSkip = DatabaseSync === undefined
  ? "node:sqlite unavailable (needs Node ≥22.13)"
  : false;

// =============================================================================
// query.ts — the pure query-expansion helpers the UI shares with the tests
// (moved out of main.ts in W11 so the shipped code is what gets tested).
// =============================================================================

test("query: wordTokens splits a word box on spaces", () => {
  assert.deepEqual(wordTokens("水 食事"), ["水", "食事"]);
  assert.deepEqual(wordTokens("水  食事"), ["水", "食事"]);
  assert.deepEqual(wordTokens("食べる"), ["食べる"]);
});

test("query: wordTokens splits on ASCII, full-width and Japanese commas", () => {
  assert.deepEqual(wordTokens("水,食事"), ["水", "食事"]);
  assert.deepEqual(wordTokens("水，食事"), ["水", "食事"]);
  assert.deepEqual(wordTokens("水、食事"), ["水", "食事"]);
  assert.deepEqual(wordTokens("水, 食事、ご飯"), ["水", "食事", "ご飯"]);
});

test("query: wordTokens handles a single word and empty input", () => {
  assert.deepEqual(wordTokens("水"), ["水"]);
  assert.deepEqual(wordTokens(""), []);
  assert.deepEqual(wordTokens("   "), []);
});

test("query: kanjiQuery extracts only kanji from mixed text", () => {
  assert.equal(kanjiQuery("食べる"), "食");
  assert.equal(kanjiQuery("制・作者"), "制作者");
  assert.equal(kanjiQuery("水"), "水");
});

test("query: kanjiQuery leaves non-kanji input untouched (trimmed)", () => {
  assert.equal(kanjiQuery("taberu"), "taberu");
  assert.equal(kanjiQuery(" たべる "), "たべる");
  assert.equal(kanjiQuery(""), "");
});

test("query: kanjiQueries splits a multi-kanji box into one lookup per literal", () => {
  assert.deepEqual(kanjiQueries("制・作者"), ["制", "作", "者"]);
  assert.deepEqual(kanjiQueries("食べる"), ["食"]);
});

test("query: kanjiQueries stays a single query when the box has no kanji", () => {
  assert.deepEqual(kanjiQueries("taberu"), ["taberu"]);
  assert.deepEqual(kanjiQueries("たべ"), ["たべ"]);
});

test("query: parseMax keeps a positive integer, falls back to 5 otherwise", () => {
  assert.equal(parseMax("5"), 5);
  assert.equal(parseMax("30"), 30);
  assert.equal(parseMax(""), 5); // Number("") = 0
  assert.equal(parseMax("3.5"), 5);
  assert.equal(parseMax("0"), 5);
  assert.equal(parseMax("-1"), 5);
  assert.equal(parseMax("abc"), 5);
});

// ---- theme.ts (W14 settings colors) --------------------------------------
test("theme: isHexColor accepts 6-digit hex and rejects everything else", () => {
  assert.equal(isHexColor("#7FFFD4"), true);
  assert.equal(isHexColor("#1a2B3c"), true);
  assert.equal(isHexColor("#fff"), false); // 3-digit shorthand rejected
  assert.equal(isHexColor("7FFFD4"), false); // no #
  assert.equal(isHexColor("#7FFFD"), false); // too short
  assert.equal(isHexColor("#7FFFD40"), false); // too long
  assert.equal(isHexColor("#GGGGGG"), false); // non-hex digits
  assert.equal(isHexColor(42), false);
  assert.equal(isHexColor(null), false);
});

test("theme: mixHex lerps linearly between base and picked", () => {
  assert.equal(mixHex(LIGHT_BASE, "#000000", 0), "#ffffff");
  assert.equal(mixHex(LIGHT_BASE, "#000000", 1), "#000000");
  assert.equal(mixHex(LIGHT_BASE, "#000000", 0.5), "#808080");
  assert.equal(mixHex("#000000", "#ffffff", 0.25), "#404040");
  // t clamps outside 0..1
  assert.equal(mixHex(LIGHT_BASE, "#000000", 2), "#000000");
  assert.equal(mixHex(LIGHT_BASE, "#000000", -1), "#ffffff");
});

test("theme: effectiveBg blends the theme base toward the picked color", () => {
  // default: muted aquamarine at 100% intensity IS the tint surface color
  assert.equal(effectiveBg("light", DEFAULT_BG, DEFAULT_BG_MIX), "#a6ddcf");
  // 0% = the plain theme base: white in light, black in dark (mixHex emits
  // lowercase hex)
  assert.equal(effectiveBg("light", DEFAULT_BG, 0), "#ffffff");
  assert.equal(effectiveBg("dark", DEFAULT_BG, 0), "#000000");
  // midpoint mixes white/muted aquamarine
  assert.equal(effectiveBg("light", DEFAULT_BG, 50), mixHex(LIGHT_BASE, DEFAULT_BG, 0.5));
  // a non-hex picked color falls back to the theme base
  assert.equal(effectiveBg("dark", "not-a-color", 100), DARK_BASE);
  // mix clamps to 0..100
  assert.equal(effectiveBg("light", "#000000", 250), "#000000");
});

test("theme: effectiveTint equals effectiveBg in light, capped toward black in dark", () => {
  // light: the tint IS the effective bg (input/buttons/even-depth panes take it)
  assert.equal(effectiveTint("light", DEFAULT_BG, 100), effectiveBg("light", DEFAULT_BG, 100));
  assert.equal(effectiveTint("light", DEFAULT_BG, 100), "#a6ddcf");
  assert.equal(effectiveTint("light", DEFAULT_BG, 0), "#ffffff");
  // dark: scaled toward black so the light ink stays readable on tinted
  // surfaces — at 100% only DARK_TINT_SCALE of the picked color survives
  assert.equal(effectiveTint("dark", DEFAULT_BG, 0), "#000000");
  assert.equal(
    effectiveTint("dark", DEFAULT_BG, 100),
    mixHex(DEFAULT_BG, DARK_BASE, 1 - DARK_TINT_SCALE),
  );
  // a non-hex picked color still falls back to the theme base
  assert.equal(effectiveTint("dark", "not-a-color", 100), DARK_BASE);
  assert.equal(effectiveTint("light", "not-a-color", 100), LIGHT_BASE);
});

test("theme: defaults are the muted aquamarine bg, orange accent, 100 mix", () => {
  assert.equal(DEFAULT_BG, "#A6DDCF");
  assert.equal(DEFAULT_ACCENT, "#EF6A5E");
  assert.equal(DEFAULT_BG_MIX, 100);
});

// =============================================================================
// tree.ts — result tree operations (the real module)
// =============================================================================

test("tree: createResultNode builds a well-formed node", () => {
  resetNodeIdGenerator();
  const n = createResultNode("word", "水", "text", false, undefined, "parent_1", 15);
  assert.ok(n.id.startsWith("node_"), n.id);
  assert.equal(n.parentId, "parent_1");
  assert.equal(n.command, "word");
  assert.equal(n.query, "水");
  assert.equal(n.text, "text");
  assert.equal(n.error, false);
  assert.deepEqual(n.children, []);
  assert.equal(n.collapsed, false);
  assert.equal(n.max, 15);
  assert.equal(typeof n.createdAt, "number");
});

test("tree: createErrorResultNode flags the node as an error", () => {
  const n = createErrorResultNode("search", "zqxjk", "no results", null, 5);
  assert.equal(n.error, true);
  assert.equal(n.text, "no results");
  assert.equal(n.max, 5);
});

test("tree: addResultToParent keeps top-level nodes newest-first (unshift)", () => {
  resetNodeIdGenerator();
  const a = createResultNode("word", "水", "a", false, undefined, null, 30);
  const b = createResultNode("word", "食事", "b", false, undefined, null, 30);
  const c = createResultNode("word", "食べる", "c", false, undefined, null, 30);
  let tree = addResultToParent([], a);
  tree = addResultToParent(tree, b);
  tree = addResultToParent(tree, c);
  assert.deepEqual(tree.map((n) => n.query), ["食べる", "食事", "水"]);
});

test("tree: addResultToParent nests children newest-first under the parent", () => {
  resetNodeIdGenerator();
  const parent = createResultNode("kanji", "食", "parent", false, undefined, null, 30);
  let tree = addResultToParent([], parent);
  const child1 = createResultNode("word", "食事", "c1", false, undefined, parent.id, 30);
  const child2 = createResultNode("word", "食べる", "c2", false, undefined, parent.id, 30);
  tree = addResultToParent(tree, child1, parent.id);
  tree = addResultToParent(tree, child2, parent.id);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0]!.children.map((n) => n.query), ["食べる", "食事"]);
});

test("tree: addResultToParent falls back to top level when the parent is missing", () => {
  resetNodeIdGenerator();
  const orphan = createResultNode("word", "水", "x", false, undefined, "ghost", 30);
  const tree = addResultToParent([], orphan, "ghost");
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.parentId, "ghost");
  assert.equal(tree[0]!.query, "水");
});

test("tree: findResultById finds top-level and nested nodes", () => {
  resetNodeIdGenerator();
  const parent = createResultNode("kanji", "食", "p", false, undefined, null, 30);
  const child = createResultNode("word", "食事", "c", false, undefined, parent.id, 30);
  const tree = addResultToParent(addResultToParent([], parent), child, parent.id);
  assert.equal(findResultById(tree, parent.id)?.query, "食");
  assert.equal(findResultById(tree, child.id)?.query, "食事");
  assert.equal(findResultById(tree, "missing"), null);
});

test("tree: deleteResultFromTree removes a top-level node", () => {
  resetNodeIdGenerator();
  const a = createResultNode("word", "水", "a", false, undefined, null, 30);
  const b = createResultNode("word", "食事", "b", false, undefined, null, 30);
  const tree = addResultToParent(addResultToParent([], a), b);
  const after = deleteResultFromTree(tree, a.id);
  assert.deepEqual(after.map((n) => n.query), ["食事"]);
});

test("tree: deleteResultFromTree removes a nested child and its descendants", () => {
  resetNodeIdGenerator();
  const parent = createResultNode("kanji", "食", "p", false, undefined, null, 30);
  const child = createResultNode("word", "食事", "c", false, undefined, parent.id, 30);
  const grandchild = createResultNode("word", "食べる", "g", false, undefined, child.id, 30);
  let tree = addResultToParent([], parent);
  tree = addResultToParent(tree, child, parent.id);
  tree = addResultToParent(tree, grandchild, child.id);
  const after = deleteResultFromTree(tree, child.id);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0]!.children, []);
});

test("tree: deleteResultFromTree deep recursion keeps surviving descendants intact", () => {
  // Regression: the recursion must walk child.children (not [child]) — the
  // wrapping bug nested a self-clone under every surviving child.
  resetNodeIdGenerator();
  const parent = createResultNode("kanji", "食", "p", false, undefined, null, 30);
  const child = createResultNode("word", "食事", "c", false, undefined, parent.id, 30);
  const keep = createResultNode("word", "食べる", "keep", false, undefined, child.id, 30);
  const drop = createResultNode("word", "食べ物", "drop", false, undefined, child.id, 30);
  let tree = addResultToParent([], parent);
  tree = addResultToParent(tree, child, parent.id);
  tree = addResultToParent(tree, keep, child.id);
  tree = addResultToParent(tree, drop, child.id);
  const after = deleteResultFromTree(tree, drop.id);
  const survivors = after[0]!.children[0]!.children;
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0]!.query, "食べる");
  assert.equal(survivors[0]!.children.length, 0); // no self-clone nesting
});

test("tree: toggleResultCollapse flips only the target node", () => {
  resetNodeIdGenerator();
  const a = createResultNode("word", "水", "a", false, undefined, null, 30);
  const b = createResultNode("word", "食事", "b", false, undefined, null, 30);
  const tree = addResultToParent(addResultToParent([], a), b);
  const collapsed = toggleResultCollapse(tree, a.id);
  assert.equal(collapsed.find((n) => n.query === "水")!.collapsed, true);
  assert.equal(collapsed.find((n) => n.query === "食事")!.collapsed, false);
  const expanded = toggleResultCollapse(collapsed, a.id);
  assert.equal(expanded.find((n) => n.query === "水")!.collapsed, false);
});

test("tree: countResults counts top-level nodes and all descendants", () => {
  resetNodeIdGenerator();
  const parent = createResultNode("kanji", "食", "p", false, undefined, null, 30);
  const child = createResultNode("word", "食事", "c", false, undefined, parent.id, 30);
  const grandchild = createResultNode("word", "食べる", "g", false, undefined, child.id, 30);
  const other = createResultNode("word", "水", "o", false, undefined, null, 30);
  let tree = addResultToParent([], parent);
  tree = addResultToParent(tree, child, parent.id);
  tree = addResultToParent(tree, grandchild, child.id);
  tree = addResultToParent(tree, other);
  assert.equal(countResults(tree), 4);
});

test("tree: migrateToHierarchical lifts legacy flat panes to top-level nodes", () => {
  resetNodeIdGenerator();
  const legacy = [
    { command: "word", query: "水", text: "water", error: false, strokes: undefined },
    { command: "kanji", query: "食", text: "eat", error: true, strokes: [{ literal: "食", svgFile: "098df.svg" }] },
  ];
  const tree = migrateToHierarchical(legacy);
  assert.equal(tree.length, 2);
  assert.equal(tree[0]!.command, "word");
  assert.equal(tree[0]!.query, "水");
  assert.equal(tree[0]!.parentId, null);
  assert.equal(tree[0]!.max, 5); // legacy panes get the default max (30 → 5 since W14)
  assert.equal(tree[1]!.error, true);
  assert.deepEqual(tree[1]!.strokes, [{ literal: "食", svgFile: "098df.svg" }]);
});

test("tree: serialize → deserialize round-trip preserves the whole tree", () => {
  resetNodeIdGenerator();
  const parent = createResultNode("kanji", "食", "p", false, [{ literal: "食", svgFile: "098df.svg" }], null, 30);
  const child = createResultNode("word", "食事", "c", false, undefined, parent.id, 30);
  const tree = addResultToParent(addResultToParent([], parent), child, parent.id);
  // Persist exactly like saveState: JSON stringify, then a fresh deserialize.
  const restored = deserializeResultTree(JSON.parse(JSON.stringify(tree)));
  assert.equal(restored.length, 1);
  const rp = restored[0]!;
  assert.equal(rp.id, parent.id);
  assert.equal(rp.query, "食");
  assert.deepEqual(rp.strokes, [{ literal: "食", svgFile: "098df.svg" }]);
  assert.equal(rp.children.length, 1);
  assert.equal(rp.children[0]!.query, "食事");
  assert.equal(rp.children[0]!.parentId, parent.id);
});

test("tree: seedNodeIdFromTree pushes the id counter past restored ids", () => {
  resetNodeIdGenerator();
  const tree = deserializeResultTree([
    { id: "node_7", parentId: null, command: "word", query: "水", text: "x", error: false, children: [], collapsed: false, max: 30 },
  ]);
  seedNodeIdFromTree(tree);
  const fresh = createResultNode("word", "食事", "y", false, undefined, null, 30);
  const m = /^node_(\d+)$/.exec(fresh.id)!;
  assert.ok(Number(m[1]!) > 7, fresh.id);
});

test("tree: serializeCollapsedStates records only collapsed nodes", () => {
  resetNodeIdGenerator();
  const a = createResultNode("word", "水", "a", false, undefined, null, 30);
  const b = createResultNode("word", "食事", "b", false, undefined, null, 30);
  const tree = addResultToParent(addResultToParent([], a), b);
  const states = serializeCollapsedStates(tree);
  assert.deepEqual(states, {});
  const collapsed = toggleResultCollapse(tree, a.id);
  assert.deepEqual(serializeCollapsedStates(collapsed), { [a.id]: true });
});

test("tree: clearResultTree empties the tree and resets ids and tracking", () => {
  resetNodeIdGenerator();
  registerResult(null, "word", "水");
  const tree = [createResultNode("word", "水", "a", false, undefined, null, 30)];
  const cleared = clearResultTree();
  assert.deepEqual(cleared, []);
  assert.equal(hasDuplicate(null, "word", "水"), false); // tracker cleared too
  const fresh = createResultNode("word", "食事", "b", false, undefined, null, 30);
  assert.equal(fresh.id, "node_1"); // counter reset
});

// ---- action duplicate tracker (real module, W2/W10 semantics) --------------

test("tracker: register → duplicate → unregister lifecycle", () => {
  try {
    clearDuplicateTracker();
    assert.equal(hasDuplicate(null, "word", "test"), false);
    registerResult(null, "word", "test");
    assert.equal(hasDuplicate(null, "word", "test"), true);
    // Different command, query or parent are distinct actions.
    assert.equal(hasDuplicate(null, "kanji", "test"), false);
    assert.equal(hasDuplicate(null, "word", "other"), false);
    assert.equal(hasDuplicate("parent", "word", "test"), false);
    unregisterResult(null, "word", "test");
    assert.equal(hasDuplicate(null, "word", "test"), false);
  } finally {
    clearDuplicateTracker();
  }
});

test("tracker: queries containing a pipe are distinct entries", () => {
  try {
    clearDuplicateTracker();
    registerResult(null, "word", "a|b");
    assert.equal(hasDuplicate(null, "word", "a|b"), true);
    assert.equal(hasDuplicate(null, "word", "a"), false);
    assert.equal(hasDuplicate(null, "word", "a|b|c"), false);
    assert.equal(hasDuplicate("parent", "word", "a|b"), false);
    unregisterResult(null, "word", "a|b");
    assert.equal(hasDuplicate(null, "word", "a|b"), false);
  } finally {
    clearDuplicateTracker();
  }
});

// =============================================================================
// cache.ts — the real ResultCacheManager
// =============================================================================

test("cache: keys embed the NUL separator, not a pipe", () => {
  const cache = new ResultCacheManager();
  const key = cache.getCacheKey("word", "a|b", 30);
  // The key splits back unambiguously into exactly command / query / max,
  // with the pipe surviving INSIDE the query part — a `|` separator would
  // have split it into four parts and lost the query.
  const parts = key.split("\u0000");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "word");
  assert.equal(parts[1], "a|b");
  assert.equal(parts[2], "30");
});

test("cache: keys round-trip when the query contains a pipe character", () => {
  const cache = new ResultCacheManager();
  const piped = createResultNode("word", "a|b", "text one", false, undefined, null, 30);
  const plain = createResultNode("word", "a", "text two", false, undefined, null, 30);
  cache.setCache("word", "a|b", 30, piped);
  cache.setCache("word", "a", 30, plain);
  assert.equal(cache.getCached("word", "a|b", 30)?.text, "text one");
  assert.equal(cache.getCached("word", "a", 30)?.text, "text two");
  assert.equal(cache.getCached("word", "a|b", 31), null);
});

test("cache: evicts the oldest entry when the cache is full", () => {
  const cache = new ResultCacheManager(2);
  const first = createResultNode("word", "水", "first", false, undefined, null, 30);
  const second = createResultNode("word", "食事", "second", false, undefined, null, 30);
  const third = createResultNode("word", "食べる", "third", false, undefined, null, 30);
  cache.setCache("word", "水", 30, first);
  cache.setCache("word", "食事", 30, second);
  assert.equal(cache.getCached("word", "水", 30), first);
  cache.setCache("word", "食べる", 30, third); // evicts 水 (oldest)
  assert.equal(cache.getCached("word", "水", 30), null);
  assert.equal(cache.getCached("word", "食事", 30), second);
  assert.equal(cache.getCached("word", "食べる", 30), third);
});

test("cache: pending-fetch marks guard in-flight lookups and clear() resets", () => {
  const cache = new ResultCacheManager();
  assert.equal(cache.isFetchInProgress("word", "水", 30), false);
  cache.markFetchStarted("word", "水", 30);
  assert.equal(cache.isFetchInProgress("word", "水", 30), true);
  // Same command/query but a different max is a separate fetch.
  assert.equal(cache.isFetchInProgress("word", "水", 31), false);
  cache.markFetchCompleted("word", "水", 30);
  assert.equal(cache.isFetchInProgress("word", "水", 30), false);

  const node = createResultNode("word", "水", "x", false, undefined, null, 30);
  cache.setCache("word", "水", 30, node);
  cache.clear();
  assert.equal(cache.getCached("word", "水", 30), null);
  assert.equal(cache.isFetchInProgress("word", "水", 30), false);
});

// =============================================================================
// W5: dictionary integrity probe (dbLooksHealthy) against real SQLite files
// =============================================================================

/** Build a small real dictionary-shaped DB: meta at the front (the first
 * table, like src/db/schema.ts) plus enough data pages to make a tail cut
 * meaningful. Returns the file path; the DB is closed. Only called when
 * `sqliteSkip` is false. */
function makeDictDb(dir: string): string {
  const path = join(dir, "dict.db");
  const db = new DatabaseSync!(path);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE words (id INTEGER PRIMARY KEY, w TEXT)");
  db.prepare("INSERT INTO meta VALUES ('version', 'v1')").run();
  // One transaction: node:sqlite would otherwise fsync per row (implicit
  // transactions), making the fixture build take tens of seconds.
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO words (w) VALUES (?)");
  for (let i = 0; i < 50000; i++) insert.run(`word${i}_${"x".repeat(50)}`);
  db.exec("COMMIT");
  db.close();
  return path;
}

test("dbLooksHealthy: accepts an intact dictionary", { skip: sqliteSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "omakase-db-"));
  try {
    const path = makeDictDb(dir);
    const db = new DatabaseSync!(path, { readOnly: true });
    assert.strictEqual(dbLooksHealthy(db), true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dbLooksHealthy: rejects a tail-truncated dictionary (interrupted import)", { skip: sqliteSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "omakase-db-"));
  try {
    const path = makeDictDb(dir);
    // Cut 40% off the end — the interrupted-import shape: the front of the
    // file (header + meta) still opens and reads, but data pages past the cut
    // are gone, so quick_check must flag the copy as corrupt.
    const size = statSync(path).size;
    truncateSync(path, Math.floor(size * 0.6));
    const db = new DatabaseSync!(path, { readOnly: true });
    assert.strictEqual(dbLooksHealthy(db), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dbLooksHealthy: rejects a garbage file that still opens", { skip: sqliteSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "omakase-db-"));
  try {
    const path = join(dir, "garbage.db");
    // Random bytes (not a SQLite file): the open may succeed, but the first
    // query throws — the probe must never throw past the caller.
    writeFileSync(path, Buffer.alloc(4096, 0xa5));
    const db = new DatabaseSync!(path, { readOnly: true });
    assert.strictEqual(dbLooksHealthy(db), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// W8: restore hardening — isValidResultNode / deserializeResultTree /
// restoreCollapsedStates against corrupt or foreign localStorage state
// =============================================================================

/** A well-formed node as it would be persisted (shape only — ids need not be
 * unique for the validator). */
function validNode(overrides = {}): Record<string, unknown> {
  return {
    id: "node_1",
    parentId: null,
    command: "kanji",
    query: "食",
    text: "食: strokes 9\nOn: ショク",
    error: false,
    strokes: [{ literal: "食", svgFile: "098df.svg" }],
    children: [],
    collapsed: false,
    createdAt: 1234,
    max: 30,
    ...overrides,
  };
}

test("isValidResultNode: accepts a well-formed node (with children)", () => {
  const node = validNode({ children: [validNode({ id: "node_2", command: "word" })] });
  assert.equal(isValidResultNode(node), true);
});

test("isValidResultNode: rejects a node missing children", () => {
  const { children: _omit, ...noChildren } = validNode();
  assert.equal(isValidResultNode(noChildren), false);
});

test("isValidResultNode: rejects a wrong (foreign) command", () => {
  assert.equal(isValidResultNode(validNode({ command: "spell" })), false);
});

test("isValidResultNode: rejects a non-boolean collapsed", () => {
  assert.equal(isValidResultNode(validNode({ collapsed: "yes" })), false);
});

test("isValidResultNode: rejects non-string text/query/id and non-number max", () => {
  assert.equal(isValidResultNode(validNode({ id: 7 })), false);
  assert.equal(isValidResultNode(validNode({ query: null })), false);
  assert.equal(isValidResultNode(validNode({ text: 42 })), false);
  assert.equal(isValidResultNode(validNode({ max: "30" })), false);
});

test("isValidResultNode: rejects a node with an invalid descendant", () => {
  assert.equal(isValidResultNode(validNode({ children: [validNode({ command: 7 })] })), false);
});

test("deserializeResultTree: non-array input yields an empty tree", () => {
  assert.deepEqual(deserializeResultTree(null), []);
  assert.deepEqual(deserializeResultTree({}), []);
  assert.deepEqual(deserializeResultTree("junk"), []);
});

test("deserializeResultTree: drops invalid nodes (the corrupt-state shape)", () => {
  // The e2e corrupt shape: `{v:2, resultTree:[{id:"x"}]}` — missing every
  // required field must not survive restore.
  const out = deserializeResultTree([{ id: "x" }, validNode()]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "node_1");
});

test("deserializeResultTree: prunes invalid children from a valid parent", () => {
  const node = validNode({
    children: [validNode({ id: "good_child" }), { id: "bad_child" }, "junk"],
  });
  const out = deserializeResultTree([node]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.children.length, 1);
  assert.equal(out[0]!.children[0]!.id, "good_child");
});

test("restoreCollapsedStates: non-boolean state values fall back to false", () => {
  const nodes = deserializeResultTree([
    validNode({ id: "a" }),
    validNode({ id: "b" }),
  ]);
  const restored = restoreCollapsedStates(nodes, { a: true, b: "yes", c: 1 } as unknown as Record<string, boolean>);
  assert.equal(restored[0]!.collapsed, true);
  assert.equal(restored[1]!.collapsed, false);
});