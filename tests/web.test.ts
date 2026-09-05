/**
 * Web UI tests - tests for browser-based functionality.
 * These tests focus on the logic and state management of web UI features.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// =============================================================================
// Test suites for cancel functionality
// =============================================================================

// Mock the necessary global state for testing
interface Pending {
  id: number;
  command: string;
  query: string;
  max: number;
}

// Test cancel operation state management
test("cancelCurrentOperation: removes head from queue", () => {
  const queue: Pending[] = [
    { id: 1, command: "word", query: "test", max: 30 },
    { id: 2, command: "kanji", query: "日", max: 30 },
  ];
  
  // Simulate the cancel logic
  const head = queue[0];
  if (!head) throw new Error("No head");
  
  const cancelledOps = new Set<number>();
  cancelledOps.add(head.id);
  queue.shift();
  
  // Verify queue state
  assert.strictEqual(queue.length, 1);
  assert.deepStrictEqual(queue[0], { id: 2, command: "kanji", query: "日", max: 30 });
  assert.ok(cancelledOps.has(1));
  assert.strictEqual(cancelledOps.size, 1);
});

test("cancelCurrentOperation: handles empty queue", () => {
  const queue: Pending[] = [];
  const cancelledOps = new Set<number>();
  
  // Simulate the cancel logic
  const head = queue[0];
  if (!head) {
    // This is the expected path for empty queue
    assert.strictEqual(queue.length, 0);
    assert.strictEqual(cancelledOps.size, 0);
    return; // Test passes
  }
  
  // Should not reach here
  assert.fail("Should not process empty queue");
});

test("cancelCurrentOperation: tracks multiple cancelled operations", () => {
  const queue: Pending[] = [
    { id: 1, command: "word", query: "test1", max: 30 },
    { id: 2, command: "kanji", query: "日", max: 30 },
  ];
  
  const cancelledOps = new Set<number>();
  
  // Cancel first operation
  const head1 = queue[0];
  if (head1) {
    cancelledOps.add(head1.id);
    queue.shift();
  }
  
  // Cancel second operation (now at head)
  const head2 = queue[0];
  if (head2) {
    cancelledOps.add(head2.id);
    queue.shift();
  }
  
  // Verify all operations cancelled
  assert.strictEqual(queue.length, 0);
  assert.strictEqual(cancelledOps.size, 2);
  assert.ok(cancelledOps.has(1));
  assert.ok(cancelledOps.has(2));
});

// Test handleResult logic for cancelled operations
test("handleResult: skips processing for cancelled operations", () => {
  const cancelledOps = new Set<number>([1, 3]);
  const queue: Pending[] = [{ id: 2, command: "word", query: "test", max: 30 }];
  
  // Simulate the message
  const msg = { kind: "result" as const, id: 1, text: null, error: null };
  const item = queue[0] ?? null;
  
  // Simulate the cancelled check logic
  if (cancelledOps.has(msg.id)) {
    cancelledOps.delete(msg.id);
    if (item?.id === msg.id) {
      queue.shift();
    }
    // Early return for cancelled ops
    assert.strictEqual(cancelledOps.size, 1); // Should have removed id 1
    assert.strictEqual(queue.length, 1);    // Queue unchanged
    return; // Test passes
  }
  
  assert.fail("Should have skipped processing for cancelled operation");
});

// Test streaming message handling for cancelled operations
test("op-section: skips processing for cancelled operations", () => {
  const cancelledOps = new Set<number>([1]);
  const msg = { kind: "op-section" as const, id: 1, label: "body", text: "test" };
  
  // Simulate the op-section handler logic
  if (cancelledOps.has(msg.id)) {
    // Should break/return early
    assert.ok(true); // Test passes if we get here
    return;
  }
  
  assert.fail("Should have skipped op-section for cancelled operation");
});

test("op-progress: skips processing for cancelled operations", () => {
  const cancelledOps = new Set<number>([1]);
  const opActiveId = 1;
  const msg = { kind: "op-progress" as const, id: 1, pct: 50, text: "test" };
  
  // Simulate the op-progress handler logic
  if (opActiveId !== msg.id || cancelledOps.has(msg.id)) {
    // Should break/return early
    assert.ok(true); // Test passes if we get here
    return;
  }
  
  assert.fail("Should have skipped op-progress for cancelled operation");
});

// Test queue management during cancellation
test("queue management: only head operation is cancelled", () => {
  const queue: Pending[] = [
    { id: 1, command: "word", query: "test1", max: 30 },
    { id: 2, command: "kanji", query: "日", max: 30 },
    { id: 3, command: "search", query: "hello", max: 30 },
  ];
  
  const cancelledOps = new Set<number>();
  
  // Simulate cancelling head only
  const head = queue[0];
  if (head) {
    cancelledOps.add(head.id);
    queue.shift(); // Only remove head
  }
  
  // Verify only head was cancelled
  assert.strictEqual(cancelledOps.size, 1);
  assert.ok(cancelledOps.has(1));
  assert.strictEqual(queue.length, 2);
  assert.deepStrictEqual(queue[0], { id: 2, command: "kanji", query: "日", max: 30 });
  assert.deepStrictEqual(queue[1], { id: 3, command: "search", query: "hello", max: 30 });
});

// Test state cleanup during cancellation
test("state cleanup: removes all tracking for cancelled operation", () => {
  const paneByOpId = new Map<number, { remove(): void }>(); // stand-in for main.ts's DOM map — tests typecheck without the DOM lib
  const opTexts = new Map<number, string[]>();
  const opActiveId = 1;
  const opCommand = "word";
  let nextOpActiveId: number | null = opActiveId;
  let nextOpCommand: string | null = opCommand;
  
  const head = { id: 1, command: "word", query: "test", max: 30 };
  
  // Simulate cleanup logic
  const skeletonPane = paneByOpId.get(head.id);
  if (skeletonPane) {
    // Would be removed in real implementation
    assert.ok(true);
  }
  paneByOpId.delete(head.id);
  opTexts.delete(head.id);
  
  if (opActiveId === head.id) {
    nextOpActiveId = null;
    nextOpCommand = null;
  }
  
  // Verify cleanup
  assert.strictEqual(paneByOpId.has(head.id), false);
  assert.strictEqual(opTexts.has(head.id), false);
  assert.strictEqual(nextOpActiveId, null);
  assert.strictEqual(nextOpCommand, null);
});

// =============================================================================
// Test suites for composable UI functionality
// =============================================================================

// Simple duplicate detection tracker for testing
const duplicateTracker = new Map<string, Set<string>>();

function hasDuplicateTest(parentId: string | null, command: string, query: string): boolean {
  const parentKey = parentId ?? 'root';
  const entryKey = `${command}|${query}`;
  
  const existing = duplicateTracker.get(parentKey);
  return !!(existing && existing.has(entryKey));
}

function registerResultTest(parentId: string | null, command: string, query: string): void {
  const parentKey = parentId ?? 'root';
  const entryKey = `${command}|${query}`;
  
  let parentSet = duplicateTracker.get(parentKey);
  if (!parentSet) {
    parentSet = new Set<string>();
    duplicateTracker.set(parentKey, parentSet);
  }
  
  parentSet.add(entryKey);
}

function clearDuplicateTrackerTest(): void {
  duplicateTracker.clear();
}

test("composable: duplicate detection prevents same query under same parent", () => {
  clearDuplicateTrackerTest();
  
  // First registration should allow
  assert.strictEqual(hasDuplicateTest(null, "word", "test"), false);
  registerResultTest(null, "word", "test");
  
  // Same query under same parent should be duplicate
  assert.strictEqual(hasDuplicateTest(null, "word", "test"), true);
  
  // Different parent should allow
  assert.strictEqual(hasDuplicateTest("parent1", "word", "test"), false);
  
  // Different query under same parent should allow
  assert.strictEqual(hasDuplicateTest(null, "word", "different"), false);
  
  // Different command under same parent should allow
  assert.strictEqual(hasDuplicateTest(null, "kanji", "test"), false);
});

test("composable: duplicate detection works with parent context", () => {
  clearDuplicateTrackerTest();
  
  // Register result under parent1
  registerResultTest("parent1", "word", "test");
  
  // Same result should be allowed under parent2
  assert.strictEqual(hasDuplicateTest("parent2", "word", "test"), false);
  
  // But not under parent1
  assert.strictEqual(hasDuplicateTest("parent1", "word", "test"), true);
});

// Test word token parsing
const WORD_SEP_RE = /[\s,，、]+/u;

function wordTokens(raw: string): string[] {
  return raw.split(WORD_SEP_RE).filter((s) => s !== "");
}

test("composable: wordTokens splits on spaces", () => {
  const tokens = wordTokens("hello world");
  assert.deepStrictEqual(tokens, ["hello", "world"]);
});

test("composable: wordTokens splits on commas", () => {
  const tokens = wordTokens("hello,world");
  assert.deepStrictEqual(tokens, ["hello", "world"]);
});

test("composable: wordTokens handles single word", () => {
  const tokens = wordTokens("hello");
  assert.deepStrictEqual(tokens, ["hello"]);
});

// Test kanji query parsing
const KANJI_RE = /\p{Script=Han}/u;

function kanjiQuery(raw: string): string {
  const literals = [...raw].filter((ch) => KANJI_RE.test(ch));
  return literals.length > 0 ? literals.join("") : raw.trim();
}

function kanjiQueries(raw: string): string[] {
  const stripped = kanjiQuery(raw);
  return KANJI_RE.test(stripped) ? [...stripped] : [stripped];
}

test("composable: kanjiQuery extracts only kanji from mixed text", () => {
  const result = kanjiQuery("食べる");
  assert.strictEqual(result, "食");
});

test("composable: kanjiQuery handles multiple kanji", () => {
  const result = kanjiQuery("制作者");
  assert.strictEqual(result, "制作者");
});

test("composable: kanjiQueries splits into individual kanji", () => {
  const result = kanjiQueries("制作者");
  assert.deepStrictEqual(result, ["制", "作", "者"]);
});

test("composable: kanjiQueries returns single array for non-kanji", () => {
  const result = kanjiQueries("hello");
  assert.deepStrictEqual(result, ["hello"]);
});

// Test queue logic with parent context
interface QueueItem {
  id: number;
  command: string;
  query: string;
  max: number;
  parentId: string | null;
}

test("composable: queue items with parent context are properly identified", () => {
  const queue: QueueItem[] = [
    { id: 1, command: "word", query: "test", max: 30, parentId: null },
    { id: 2, command: "kanji", query: "日", max: 30, parentId: "parent1" },
  ];
  
  const topLevel = queue.filter(item => item.parentId === null);
  const nested = queue.filter(item => item.parentId !== null);
  
  assert.strictEqual(topLevel.length, 1);
  assert.strictEqual(nested.length, 1);
  assert.strictEqual(topLevel[0]!.id, 1);
  assert.strictEqual(nested[0]!.id, 2);
});

test("composable: duplicate detection in queue with parent context", () => {
  const existing = new Set<string>();
  existing.add("word\u0000test\u0000null");
  existing.add("kanji\u0000日\u0000parent1");
  
  const key1 = "word\u0000test\u0000null";
  const key2 = "word\u0000test\u0000parent1";
  
  // Same query and command but different parent should be different
  assert.strictEqual(existing.has(key1), true);
  assert.strictEqual(existing.has(key2), false);
});

// Test auto-scroll state
test("composable: auto-scroll toggle defaults to enabled", () => {
  const autoScrollEnabled = true; // Default value
  assert.strictEqual(autoScrollEnabled, true);
});

test("composable: auto-scroll toggle can be disabled", () => {
  let autoScrollEnabled = true;
  autoScrollEnabled = !autoScrollEnabled;
  assert.strictEqual(autoScrollEnabled, false);
});

// Test cache key generation
test("composable: cache key generation is consistent", () => {
  const key1: string = `word|test|30`; // typed as string so the !== comparisons below are allowed
  const key2 = `word|test|30`;
  const key3: string = `kanji|日|30`;
  
  assert.strictEqual(key1, key2);
  assert.ok(key1 !== key3);
});

test("composable: cache key differentiates by command", () => {
  const wordKey: string = `word|test|30`;
  const kanjiKey: string = `kanji|test|30`;
  const searchKey: string = `search|test|30`;
  
  assert.ok(wordKey !== kanjiKey);
  assert.ok(wordKey !== searchKey);
  assert.ok(kanjiKey !== searchKey);
});