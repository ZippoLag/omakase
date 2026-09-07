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
 * Create a new result node
 */
export function createResultNode(
  command: Command,
  query: string,
  text: string,
  error: boolean,
  strokes: StrokePage[] | undefined,
  parentId: string | null = null,
  max: number = 30
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
  max: number = 30
): ResultNode {
  return createResultNode(command, query, errorMessage, true, undefined, parentId, max);
}

/**
 * Duplicate tracker: prevents same (parent, command, query) combinations at same level
 */
const duplicateTracker = new Map<string, Set<string>>();

/**
 * Check if a result would be a duplicate at the specified parent level
 */
export function hasDuplicate(parentId: string | null, command: Command, query: string): boolean {
  const parentKey = parentId ?? 'root';
  const entryKey = `${command}|${query}`;
  
  const existing = duplicateTracker.get(parentKey);
  if (existing && existing.has(entryKey)) {
    return true;
  }
  
  return false;
}

/**
 * Register a new result to prevent duplicates
 */
export function registerResult(parentId: string | null, command: Command, query: string): void {
  const parentKey = parentId ?? 'root';
  const entryKey = `${command}|${query}`;
  
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
  const entryKey = `${command}|${query}`;
  
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
    registerResult(null, newNode.command, newNode.query);
  } else {
    // Find parent and add as child
    const parent = findResultById(newRootNodes, parentId);
    if (parent) {
      parent.children.unshift(newNode);
      registerResult(parentId, newNode.command, newNode.query);
    } else {
      // Parent not found, add as top-level
      newRootNodes.unshift(newNode);
      registerResult(null, newNode.command, newNode.query);
    }
  }
  
  return newRootNodes;
}

/**
 * Delete a result node and all its children from the tree
 */
export function deleteResultFromTree(
  rootNodes: ResultNode[],
  targetId: string
): ResultNode[] {
  const newRootNodes: ResultNode[] = [];
  
  for (const node of rootNodes) {
    if (node.id === targetId) {
      // Remove duplicate tracking for this node
      unregisterResult(node.parentId, node.command, node.query);
      continue;
    }
    
    // Check children
    const filteredChildren: ResultNode[] = [];
    for (const child of node.children) {
      if (child.id === targetId) {
        // Remove duplicate tracking for this child
        unregisterResult(child.parentId, child.command, child.query);
        continue;
      }
      
      // Recursively filter grandchildren
      const filteredGrandchildren = deleteResultFromTree([child], targetId);
      if (filteredGrandchildren.length > 0) {
        const childCopy = { ...child, children: filteredGrandchildren };
        filteredChildren.push(childCopy);
      }
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
    30 // default max
  ));
}

/**
 * Deserialize result tree from localStorage
 */
export function deserializeResultTree(data: unknown): ResultNode[] {
  if (!Array.isArray(data)) {
    return [];
  }
  
  return data as ResultNode[];
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
    const collapsed = states[node.id] ?? false;
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