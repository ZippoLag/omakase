/**
 * Hierarchical result tree management for composable UI.
 * Handles nested result nodes, duplicate prevention, and tree operations.
 */

import type { Command, StrokePage } from "./worker-api.js";

/** Unique identifier generator */
let nextNodeId = 1;

/**
 * A result node in the hierarchical tree structure.
 * Represents a single search result that can have nested children.
 */
export interface ResultNode {
  id: string;
  parentId: string | null;
  command: Command;
  query: string;
  text: string;
  error: boolean;
  strokes?: StrokePage[];
  children: ResultNode[];
  collapsed: boolean;
  createdAt: number;
  max: number; // Store max parameter for cache key
}

/**
 * Legacy PaneRecord for backwards compatibility with existing localStorage.
 */
export interface LegacyPaneRecord {
  command: string;
  query: string;
  text: string;
  error: boolean;
  strokes?: StrokePage[];
}

/**
 * Generate unique node ID
 */
export function generateNodeId(): string {
  return `node_${nextNodeId++}`;
}

/**
 * Reset node ID generator (useful for testing)
 */
export function resetNodeIdGenerator(): void {
  nextNodeId = 1;
}

/**
 * Seed the node ID counter past the highest id in a restored tree. A fresh
 * page restarts the counter at 1 while restored nodes keep the ids they were
 * saved with — without this, the first new lookups after a reload collide
 * with restored ids and the tree (and its rendering) corrupts.
 */
export function seedNodeIdFromTree(rootNodes: ResultNode[]): void {
  let max = 0;
  const walk = (ns: ResultNode[]) => {
    for (const n of ns) {
      const m = /^node_(\d+)$/.exec(n.id);
      if (m) max = Math.max(max, Number(m[1]));
      walk(n.children);
    }
  };
  walk(rootNodes);
  if (nextNodeId <= max) nextNodeId = max + 1;
}

/**
 * Create a new result node
 */
export function createResultNode(
  command: Command,
  query: string,
  text: string,
  error: boolean,
  strokes: StrokePage[] | undefined,
  parentId: string | null = null,
  max: number = 5
): ResultNode {
  return {
    id: generateNodeId(),
    parentId,
    command,
    query,
    text,
    error,
    strokes,
    children: [],
    collapsed: false,
    createdAt: Date.now(),
    max
  };
}

/**
 * Create an error result node
 */
export function createErrorResultNode(
  command: Command,
  query: string,
  errorMessage: string,
  parentId: string | null = null,
  max: number = 5
): ResultNode {
  return createResultNode(command, query, errorMessage, true, undefined, parentId, max);
}

/**
 * Duplicate tracker for ACTIONS, keyed (parent, command, raw box value): it
 * records what the user actually asked for — a multi-item box (制作者) is one
 * entry under its raw contents, never one entry per expanded query (制, 作,
 * 者) — so only identical re-requests are suppressed. The UI registers an
 * action once at submit time; panes that render afterwards never re-register
 * their individual queries.
 */
/** Separator in action-tracker entry keys (parent, command, raw box value).
 * NUL, like the queue's `seen` keys in main.ts: a raw box value may
 * legitimately contain `|`, and a `|` separator would make a key ambiguous
 * to any code that splits it back apart. */
const ACTION_KEY_SEP = "\u0000";

const duplicateTracker = new Map<string, Set<string>>();

/**
 * Check if an action (same parent, command and raw box value) is already
 * registered — i.e. its panes are up, queued, or cached from an identical
 * earlier run.
 */
export function hasDuplicate(parentId: string | null, command: Command, query: string): boolean {
  const parentKey = parentId ?? 'root';
  const entryKey = `${command}${ACTION_KEY_SEP}${query}`;
  
  const existing = duplicateTracker.get(parentKey);
  if (existing && existing.has(entryKey)) {
    return true;
  }
  
  return false;
}

/**
 * Register an action (parent, command, raw box value) so that an identical
 * re-request under the same parent is suppressed.
 */
export function registerResult(parentId: string | null, command: Command, query: string): void {
  const parentKey = parentId ?? 'root';
  const entryKey = `${command}${ACTION_KEY_SEP}${query}`;
  
  let parentSet = duplicateTracker.get(parentKey);
  if (!parentSet) {
    parentSet = new Set<string>();
    duplicateTracker.set(parentKey, parentSet);
  }
  
  parentSet.add(entryKey);
}

/**
 * Remove a result from duplicate tracking (when deleted)
 */
export function unregisterResult(parentId: string | null, command: Command, query: string): void {
  const parentKey = parentId ?? 'root';
  const entryKey = `${command}${ACTION_KEY_SEP}${query}`;
  
  const parentSet = duplicateTracker.get(parentKey);
  if (parentSet) {
    parentSet.delete(entryKey);
    if (parentSet.size === 0) {
      duplicateTracker.delete(parentKey);
    }
  }
}

/**
 * Clear all duplicate tracking
 */
export function clearDuplicateTracker(): void {
  duplicateTracker.clear();
}

/**
 * Find a result node by ID in the tree
 */
export function findResultById(rootNodes: ResultNode[], targetId: string): ResultNode | null {
  for (const node of rootNodes) {
    if (node.id === targetId) {
      return node;
    }
    
    const foundInChildren = findResultById(node.children, targetId);
    if (foundInChildren) {
      return foundInChildren;
    }
  }
  return null;
}

/**
 * Add a result node to the tree at the specified parent
 *
 * This deliberately does NOT touch the duplicate tracker. The action that
 * produced the node was already registered once, keyed on its RAW box value
 * (see submit in main.ts); a node rendered from a multi-item action carries
 * an individual expanded query (制作者 → 制), and re-registering that per
 * literal is exactly what used to swallow a later box expanding to the same
 * literals.
 */
export function addResultToParent(
  rootNodes: ResultNode[],
  newNode: ResultNode,
  parentId: string | null = null
): ResultNode[] {
  const newRootNodes = [...rootNodes];
  
  if (parentId === null) {
    // Top-level node
    newRootNodes.unshift(newNode);
  } else {
    // Find parent and add as child
    const parent = findResultById(newRootNodes, parentId);
    if (parent) {
      parent.children.unshift(newNode);
    } else {
      // Parent not found, add as top-level
      newRootNodes.unshift(newNode);
    }
  }
  
  return newRootNodes;
}

/**
 * Delete a result node and all its children from the tree
 *
 * Each deleted node unregisters its (parent, command, node.query) action. For
 * a node a single-item action produced, node.query IS the raw box value, so
 * the action is freed and an identical re-click works again. For a node a
 * multi-item action rendered, node.query is one literal of the batch and
 * matches no entry — a harmless no-op: a batch's panes never registered their
 * individual literals, so the batch's action entry lingers and an identical
 * re-click stays suppressed even after all its panes are deleted.
 */
export function deleteResultFromTree(
  rootNodes: ResultNode[],
  targetId: string
): ResultNode[] {
  const newRootNodes: ResultNode[] = [];
  
  for (const node of rootNodes) {
    if (node.id === targetId) {
      // Unregister the node's own action (no-op for multi-item panes — see above)
      unregisterResult(node.parentId, node.command, node.query);
      continue;
    }
    
    // Check children
    const filteredChildren: ResultNode[] = [];
    for (const child of node.children) {
      if (child.id === targetId) {
        // Unregister the child's own action (no-op for multi-item panes — see above)
        unregisterResult(child.parentId, child.command, child.query);
        continue;
      }
      
      // Recursively filter the child's own descendants. The recursion must
      // walk child.children (not [child] — wrapping the child would rebuild
      // the child itself and hand it back as its own children array, nesting
      // a self-clone under every surviving child).
      const filteredGrandchildren = deleteResultFromTree(child.children, targetId);
      const childCopy = { ...child, children: filteredGrandchildren };
      filteredChildren.push(childCopy);
    }
    
    const nodeCopy = { ...node, children: filteredChildren };
    newRootNodes.push(nodeCopy);
  }
  
  return newRootNodes;
}

/**
 * Toggle collapse state for a result node
 */
export function toggleResultCollapse(
  rootNodes: ResultNode[],
  targetId: string
): ResultNode[] {
  const newRootNodes: ResultNode[] = [];
  
  for (const node of rootNodes) {
    if (node.id === targetId) {
      const updatedNode = { ...node, collapsed: !node.collapsed };
      newRootNodes.push(updatedNode);
      continue;
    }
    
    const updatedChildren = toggleResultCollapse(node.children, targetId);
    const nodeCopy = { ...node, children: updatedChildren };
    newRootNodes.push(nodeCopy);
  }
  
  return newRootNodes;
}

/**
 * Count total results in the tree
 */
export function countResults(rootNodes: ResultNode[]): number {
  let count = rootNodes.length;
  for (const node of rootNodes) {
    count += countResults(node.children);
  }
  return count;
}

/**
 * Migrate legacy flat panes to hierarchical tree
 */
export function migrateToHierarchical(panes: LegacyPaneRecord[]): ResultNode[] {
  return panes.map(pane => createResultNode(
    pane.command as Command,
    pane.query,
    pane.text,
    pane.error,
    pane.strokes,
    null, // top-level
    5 // default max
  ));
}

/** The persisted fields of a result node (children are validated separately). */
type ResultNodeShape = Omit<ResultNode, "children">;

const RESULT_COMMANDS = new Set<string>(["kanji", "word", "search"]);

/** Shape check for one stroke-order page entry. */
function isValidStrokePage(v: unknown): v is StrokePage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.literal === "string" && typeof o.svgFile === "string";
}

/** Own-field shape check for a result node (children aside). */
function isValidNodeShape(o: Record<string, unknown>): o is ResultNodeShape {
  if (typeof o.id !== "string") return false;
  if (o.parentId !== null && typeof o.parentId !== "string") return false;
  if (typeof o.command !== "string" || !RESULT_COMMANDS.has(o.command)) return false;
  if (typeof o.query !== "string") return false;
  if (typeof o.text !== "string") return false;
  if (typeof o.error !== "boolean") return false;
  if (o.strokes !== undefined && !(Array.isArray(o.strokes) && o.strokes.every(isValidStrokePage))) return false;
  if (typeof o.collapsed !== "boolean") return false;
  if (typeof o.max !== "number") return false;
  return true;
}

/**
 * Recursive validator for a persisted result node: every own field must be
 * the right type AND every descendant must validate too — a corrupt or
 * foreign subtree can never slip past restore and crash rendering.
 */
export function isValidResultNode(v: unknown): v is ResultNode {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const rawChildren = o.children;
  if (!isValidNodeShape(o)) return false;
  return Array.isArray(rawChildren) && rawChildren.every(isValidResultNode);
}

/**
 * Sanitize one node recursively: null when its own shape is invalid,
 * otherwise the node with only its valid children kept. Unlike
 * isValidResultNode (which rejects a node wholesale when any descendant is
 * bad), this prunes invalid children so one bad descendant does not take a
 * whole subtree down.
 */
function sanitizeResultNode(v: unknown): ResultNode | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const rawChildren = o.children;
  if (!isValidNodeShape(o)) return null;
  const children = Array.isArray(rawChildren)
    ? rawChildren.map(sanitizeResultNode).filter((c): c is ResultNode => c !== null)
    : [];
  return { ...o, children };
}

/**
 * Deserialize result tree from localStorage, hardened against corrupt or
 * foreign state: invalid nodes are dropped and invalid children are pruned
 * from otherwise-valid parents — never a blind cast that crashes
 * renderResultNode mid-render (and gets re-persisted by the next saveState,
 * crashing every reload the same way).
 */
export function deserializeResultTree(data: unknown): ResultNode[] {
  if (!Array.isArray(data)) {
    return [];
  }
  
  return data
    .map(sanitizeResultNode)
    .filter((n): n is ResultNode => n !== null);
}

/**
 * Serialize collapsed states for persistence
 */
export function serializeCollapsedStates(rootNodes: ResultNode[]): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  
  const collectStates = (nodes: ResultNode[]) => {
    for (const node of nodes) {
      if (node.collapsed) {
        states[node.id] = true;
      }
      collectStates(node.children);
    }
  };
  
  collectStates(rootNodes);
  return states;
}

/**
 * Deserialize and apply collapsed states to tree
 */
export function restoreCollapsedStates(
  rootNodes: ResultNode[],
  states: Record<string, boolean> | undefined
): ResultNode[] {
  if (!states) {
    return rootNodes;
  }
  
  const newRootNodes: ResultNode[] = [];
  
  for (const node of rootNodes) {
    // A corrupt/foreign state can carry non-boolean values (e.g. strings) —
    // treat anything that is not a boolean as "not collapsed" instead of
    // crashing or rendering a truthy string as collapsed.
    const raw = states[node.id];
    const collapsed = typeof raw === "boolean" ? raw : false;
    const updatedChildren = restoreCollapsedStates(node.children, states);
    const nodeCopy = { ...node, collapsed, children: updatedChildren };
    newRootNodes.push(nodeCopy);
  }
  
  return newRootNodes;
}

/**
 * Clear all tree state (for clear all functionality)
 */
export function clearResultTree(): ResultNode[] {
  clearDuplicateTracker();
  resetNodeIdGenerator();
  return [];
}