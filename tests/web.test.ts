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
import { dbLooksHealthy, dictionaryAction, readSchemaVersion, schemaMismatchMessage } from "../web/app/commands.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { ResultCacheManager } from "../web/app/cache.js";
import { foldAnchors, splicePage } from "../web/app/paging.js";
import type { PageAnchor, PageSection } from "../web/app/worker-api.js";
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
import type { PageState } from "../web/app/tree.js";
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

// ---------------------------------------------------------------------------
// readSchemaVersion / dictionaryAction: the boot guard against a dictionary
// built for another schema (a shell deployed without its matching dictionary
// would otherwise report "ready" and then fail every thesaurus read on the
// newer columns), and the decision table that keeps a working copy offline.
// ---------------------------------------------------------------------------

test("schemaMismatchMessage: names both schemas and the fix", () => {
  // The one wording both the pre-flight check and the post-import backstop
  // show, so a user who hits it is told exactly what to run.
  const msg = schemaMismatchMessage(3);
  assert.match(msg, /built for schema 3/);
  assert.match(msg, new RegExp(`this app needs ${SCHEMA_VERSION}`));
  assert.match(msg, /pnpm run deploy:web/);
  // Unrecorded/unreadable schema is reported as unknown, not as a number.
  assert.match(schemaMismatchMessage(null), /built for schema unknown/);
});

test("dictionaryAction: no readable copy imports, whatever the server says", () => {
  assert.equal(dictionaryAction(null, false, null, null), "import");
  // An unreadable copy is also "no copy" — never a re-import loop candidate.
  assert.equal(dictionaryAction(null, false, null, "v2"), "import");
});

test("dictionaryAction: a differing served stamp is the update path", () => {
  assert.equal(dictionaryAction("v1", true, 4, "v2"), "update");
  // Damage and an out-of-date schema both re-import anyway, so the update
  // message (the common upgrade) wins for the user.
  assert.equal(dictionaryAction("v1", false, 3, "v2"), "update");
});

test("dictionaryAction: a healthy, current copy of the served build opens", () => {
  assert.equal(dictionaryAction("v1", true, 4, "v1"), "open");
  // Offline (the meta.json fetch failed) must never force a 341 MB re-import:
  // a healthy copy of the current schema still opens with no network.
  assert.equal(dictionaryAction("v1", true, 4, null), "open");
});

test("dictionaryAction: damage or an older schema re-imports", () => {
  // Damaged (quick_check failed) under the served stamp.
  assert.equal(dictionaryAction("v1", false, 4, "v1"), "reimport");
  // Built for another schema: every thesaurus read would fail on the newer
  // columns, so it gets the same treatment as damage.
  assert.equal(dictionaryAction("v1", true, 3, "v1"), "reimport");
  // A copy from before schema_version was recorded (null) is "unknown", not 4.
  assert.equal(dictionaryAction("v1", true, null, "v1"), "reimport");
});

test("readSchemaVersion: reads the schema_version the dictionary was built with", { skip: sqliteSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "omakase-schema-"));
  try {
    const path = join(dir, "dict.db");
    const db = new DatabaseSync!(path);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO meta VALUES ('version', 'v1')").run();
    db.prepare("INSERT INTO meta VALUES ('schema_version', '4')").run();
    db.close();
    const reopened = new DatabaseSync!(path, { readOnly: true });
    assert.strictEqual(readSchemaVersion(reopened), 4);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSchemaVersion: null when the row, table or file is unusable", { skip: sqliteSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "omakase-schema-"));
  try {
    // A dictionary from before schema_version was recorded (the fixture has
    // only the `version` row): null, never a throw — the caller decides.
    const legacy = new DatabaseSync!(makeDictDb(dir), { readOnly: true });
    assert.strictEqual(readSchemaVersion(legacy), null);
    legacy.close();
    // Garbage bytes: the open may succeed and the query throws — still null.
    const garbagePath = join(dir, "garbage.db");
    writeFileSync(garbagePath, Buffer.alloc(4096, 0xa5));
    const garbage = new DatabaseSync!(garbagePath, { readOnly: true });
    assert.strictEqual(readSchemaVersion(garbage), null);
    garbage.close();
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

test("isValidResultNode: accepts valid persisted pages (W17i)", () => {
  const node = validNode({
    pages: [
      { section: "compounds", total: 1207, offset: 5, line: 41 },
      { section: "meanings", total: 406, offset: 30, line: 87 },
    ],
  });
  assert.equal(isValidResultNode(node), true);
});

// ★The `PageSection` union (worker-api.ts) is the source of truth for the
// restore validator's section list, and the two enumerations must not drift:
// `related` was added to the union for the word thesaurus' Related block
// without being added to tree.ts's list, so a pane paged on `Related:` was
// treated as corrupt state and the WHOLE pane disappeared on reload. The list
// below is deliberately independent of the one in tree.ts — the type guard
// makes it exhaustive over the union (a new section fails to compile here) and
// the loop then proves the validator accepts every member.
const ALL_PAGE_SECTIONS = [
  "synonyms",
  "antonyms",
  "related",
  "compounds",
  "readings",
  "meanings",
  "kanji",
] as const;
type UnlistedPageSection = Exclude<PageSection, (typeof ALL_PAGE_SECTIONS)[number]>;
// `never` once every PageSection is listed above.
const allPageSectionsAreListed: UnlistedPageSection extends never ? true : never = true;
void allPageSectionsAreListed;

test("isValidResultNode: accepts EVERY PageSection — the validator must cover the union", () => {
  for (const section of ALL_PAGE_SECTIONS) {
    const node = validNode({ pages: [{ section, total: 6, offset: 5, line: 3 }] });
    assert.equal(isValidResultNode(node), true, `"${section}" must be a valid persisted section`);
    assert.equal(
      deserializeResultTree([node]).length,
      1,
      `a pane paged on "${section}" must survive a restore, not be pruned as corrupt`,
    );
  }
});

test("isValidResultNode: rejects malformed pages (W17i)", () => {
  // non-array
  assert.equal(isValidResultNode(validNode({ pages: "x" })), false);
  // bad section name
  assert.equal(isValidResultNode(validNode({ pages: [{ section: "words", total: 5, offset: 0, line: 3 }] })), false);
  // missing/non-number fields
  assert.equal(isValidResultNode(validNode({ pages: [{ section: "compounds", total: 5 }] })), false);
  assert.equal(isValidResultNode(validNode({ pages: [{ section: "compounds", total: "5", offset: 0, line: 3 }] })), false);
  // a malformed entry among valid ones rejects the node
  assert.equal(isValidResultNode(validNode({ pages: [{ section: "kanji", total: 2, offset: 0, line: 1 }, null] })), false);
});

test("deserializeResultTree: round-trips persisted pages (W17i)", () => {
  const pages = [
    { section: "compounds", total: 1207, offset: 5, line: 41 },
  ];
  const restored = deserializeResultTree([validNode({ pages })]);
  assert.deepEqual(restored[0]!.pages, pages);
});

test("deserializeResultTree: prunes a node with malformed pages", () => {
  const out = deserializeResultTree([validNode({ pages: [{ section: "bogus", total: 1, offset: 0, line: 0 }] })]);
  assert.equal(out.length, 0, "the whole node is dropped (pages are own fields)");
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

// =============================================================================
// W17i paging — the DOM-free foldAnchors / splicePage (★W18f) + the ★W18a
// shared-array clone discipline
// =============================================================================

test("foldAnchors: folds per-section lines into global node lines, accumulating separators", () => {
  // Sections are the raw op-section chunks: each ends with a newline and
  // carries its own separator, so concatenation IS the node text.
  const sections = [
    "食べる [たべる] (common)\n\n  1. to eat\n", // word body
    "\nSynonyms:\n  食う  [くう]\n     to eat\n  … and 3 more\n", // thesaurus (offset line 0 = the separator)
    "\nExamples:\n\n  1. …\n     …\n",
  ];
  const anchors: PageAnchor[][] = [
    [],
    [{ section: "synonyms", total: 8, shown: 5, line: 4 }],
    [],
  ];
  const pages = foldAnchors(sections, anchors);
  assert.equal(pages.length, 1);
  // Global line of the note = newlines in section 0 (3: body, blank, sense)
  // plus its local line 4.
  assert.deepEqual(pages[0], { section: "synonyms", total: 8, offset: 5, line: 7 });
  // The folded line really is the note in the concatenated text.
  const text = sections.join("");
  assert.equal(text.split("\n")[pages[0]!.line], "  … and 3 more");
});

test("foldAnchors: multiple anchors per section (synonyms + antonyms) keep block order", () => {
  const sections = [
    "word\n",
    "\nSynonyms:\n  a  [x]\n     g1\n  … and 1 more\n\nAntonyms:\n  b  [y]\n     g2\n  … and 2 more\n",
  ];
  const pages = foldAnchors(sections, [
    [],
    [
      { section: "synonyms", total: 6, shown: 5, line: 4 },
      { section: "antonyms", total: 7, shown: 5, line: 9 },
    ] as PageAnchor[],
  ]);
  assert.deepEqual(pages.map((p) => p.section), ["synonyms", "antonyms"]);
  const text = sections.join("");
  assert.equal(text.split("\n")[pages[0]!.line], "  … and 1 more");
  assert.equal(text.split("\n")[pages[1]!.line], "  … and 2 more");
});

test("foldAnchors: empty sections and no anchors fold to no pages", () => {
  assert.deepEqual(foldAnchors([], []), []);
  assert.deepEqual(foldAnchors(["a\n", "b\n"], [[], []]), []);
});

/** A typical paged pane: body + thesaurus with a synonyms note at global
 * line 6, plus a later anchor (e.g. an antonyms note) below it. */
function pagedText(): { text: string; pages: PageState[] } {
  const text = [
    "食べる [たべる] (common)",
    "",
    "  1. to eat",
    "Synonyms:",
    "  食う  [くう]",
    "     to eat",
    "  … and 3 more",
    "",
    "Antonyms:",
    "  有る  [ある]",
    "     to be",
    "  … and 1 more",
    "",
  ].join("\n") + "\n";
  return {
    text,
    pages: [
      { section: "synonyms", total: 8, offset: 5, line: 6 },
      { section: "antonyms", total: 6, offset: 5, line: 11 },
    ],
  };
}

test("splicePage: replaces the note with rows, updates offset/line, shifts later anchors", () => {
  const { text, pages } = pagedText();
  const rows = ["  来る  [くる]", "     to come", "  行く  [いく]", "     to go", "  見る  [みる]", "     to see"];
  // 6 lines = 3 rows (each row is a writing+gloss pair). remaining = total
  // - (offset + rows added) by the worker's arithmetic, so total must be 10
  // for remaining 2 at request offset 5: 10 - (5 + 3) = 2.
  const spliced = splicePage(text, pages.map((p, i) => (i === 0 ? { ...p, total: 10 } : p)), 0, rows, 2);
  // Rows (6 lines) + new note (1) replace the old note (1): delta 6.
  assert.equal(spliced.delta, 6);
  const lines = spliced.text.split("\n");
  assert.equal(lines[6], "  来る  [くる]");
  assert.equal(lines[11], "     to see");
  assert.equal(lines[12], "  … and 2 more"); // remaining 2
  // The later antonyms anchor shifted by the delta; its note line is intact.
  assert.equal(spliced.pages.length, 2);
  // offset advances by the ROWS added (3), not the inserted line count (6):
  // offset counts rows and the worker's remaining already reflects them
  // (total - remaining = 10 - 2 = 8 = 5 shown + 3 added).
  assert.equal(spliced.pages[0]!.offset, 8);
  assert.equal(spliced.pages[0]!.line, 12); // old line 6 + 6 rows
  assert.equal(spliced.pages[1]!.line, 17); // 11 + delta 6
  assert.equal(lines[spliced.pages[1]!.line], "  … and 1 more");
  // Trailing newline shape preserved: text still ends with "\n".
  assert.ok(spliced.text.endsWith("\n"));
});

test("splicePage: exhaustion (remaining 0) removes the note and drops the page", () => {
  const { text, pages } = pagedText();
  const rows = ["  来る  [くる]", "     to come", "  行く  [いく]", "     to go"];
  const spliced = splicePage(text, pages, 0, rows, 0);
  // 4 rows replace the 1-line note: delta 3.
  assert.equal(spliced.delta, 3);
  assert.equal(spliced.pages.length, 1); // synonyms exhausted → dropped
  assert.equal(spliced.pages[0]!.section, "antonyms");
  assert.equal(spliced.pages[0]!.line, 14); // 11 + 3
  const lines = spliced.text.split("\n");
  assert.equal(lines[9], "     to go");
  assert.equal(lines[10], ""); // blank separator after the last row — no note
  assert.ok(!spliced.text.includes("  … and 3 more"), "old note gone");
  assert.ok(!spliced.text.includes("  … and 2 more"), "no new note at exhaustion");
  assert.ok(spliced.text.endsWith("\n"));
});

test("splicePage: empty rows (a past-the-end window) still remove the note when done", () => {
  const { text, pages } = pagedText();
  const spliced = splicePage(text, pages, 1, [], 0);
  assert.equal(spliced.delta, -1); // note removed, nothing inserted
  assert.equal(spliced.pages.length, 1);
  assert.equal(spliced.pages[0]!.section, "synonyms");
  const lines = spliced.text.split("\n");
  assert.ok(!lines.includes("  … and 1 more"), "antonyms note removed");
});

test("splicePage: a stale line index (corrupt restored state) is left untouched", () => {
  const { text, pages } = pagedText();
  // Point a page at a body line (index 2, not a note): the splice must bail
  // out with the text and pages untouched instead of corrupting node.text.
  const corrupt = splicePage(text, [{ ...pages[0]!, line: 2 }], 0, ["x"], 1);
  assert.equal(corrupt.text, text);
  assert.equal(corrupt.pages.length, 1);
  assert.equal(corrupt.delta, 0);
});

test("pages clone (W18a): a pane built from a cache entry must not share the cached pages", () => {
  // The W18a hazard: setCache stores the finished node by reference, so a
  // pane built from the cache entry receives `cached.pages` by reference.
  // Paging that pane rebinds its own pages (and any future in-place splice
  // would hit the shared array), so submit clones BOTH the array and each
  // PageState before handing it to a new node. This pins that discipline:
  // after paging the cloned pane, the cache entry's pages are untouched.
  const original = pagedText();
  const cachedPages = [...original.pages]; // what the cache entry holds
  const newPanePages = cachedPages.map((pg) => ({ ...pg })); // submit's clone

  // Page the new pane to exhaustion (its synonyms page is dropped).
  const spliced = splicePage(original.text, newPanePages, 0, ["  来る  [くる]", "     to come"], 0);
  assert.equal(spliced.pages.length, 1, "the clone's pages array shrank");
  // The cache entry's array AND its PageState objects are independent and
  // unchanged — a reload of the cached sibling still finds both buttons.
  assert.notEqual(spliced.pages, cachedPages);
  assert.deepEqual(cachedPages, original.pages);
  assert.equal(cachedPages.length, 2);
  assert.equal(cachedPages[0]!.offset, 5);
  assert.equal(cachedPages[0]!.line, 6);
  assert.equal(cachedPages[1]!.line, 11);
  // The clone itself is a different array of different objects (not a
  // shallow alias of the cache entry).
  assert.notEqual(newPanePages, cachedPages);
  assert.notEqual(newPanePages[0], cachedPages[0]);
  assert.deepEqual(newPanePages, cachedPages); // same values, independent objects
});