/**
 * Result caching system for composable UI.
 * Provides in-memory caching of search results to avoid redundant worker calls.
 */

import type { Command, StrokePage } from "./worker-api.js";
import type { ResultNode } from "./tree.js";
import { createResultNode } from "./tree.js";

/**
 * Cache key separator for command+query+max combinations
 */
const CACHE_KEY_SEP = "|";

/**
 * Result cache that stores completed search results
 */
export class ResultCacheManager {
  /** In-memory cache: cacheKey -> ResultNode */
  private cache: Map<string, ResultNode> = new Map();
  
  /** Track which cache keys are currently being fetched */
  private pendingFetches: Set<string> = new Set();
  
  /** Maximum cache size to prevent memory issues */
  private maxCacheSize: number;
  
  /** Cache hit statistics for debugging */
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  };

  constructor(maxCacheSize: number = 1000) {
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Generate cache key for a query
   */
  getCacheKey(command: Command, query: string, max: number): string {
    return `${command}${CACHE_KEY_SEP}${query}${CACHE_KEY_SEP}${max}`;
  }

  /**
   * Check if result is already cached
   */
  getCached(command: Command, query: string, max: number): ResultNode | null {
    const key = this.getCacheKey(command, query, max);
    const cached = this.cache.get(key) ?? null;
    
    if (cached) {
      this.stats.hits++;
    } else {
      this.stats.misses++;
    }
    
    return cached;
  }

  /**
   * Store result in cache
   */
  setCache(command: Command, query: string, max: number, node: ResultNode): void {
    const key = this.getCacheKey(command, query, max);
    
    // Check if we need to evict old entries
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(key)) {
      // Remove oldest entry (simple LRU approximation)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
      }
    }
    
    this.cache.set(key, node);
  }

  /**
   * Check if a request is already in progress for this cache key
   */
  isFetchInProgress(command: Command, query: string, max: number): boolean {
    const key = this.getCacheKey(command, query, max);
    return this.pendingFetches.has(key);
  }

  /**
   * Mark a cache key as being fetched
   */
  markFetchStarted(command: Command, query: string, max: number): void {
    const key = this.getCacheKey(command, query, max);
    this.pendingFetches.add(key);
  }

  /**
   * Mark a cache key as no longer being fetched
   */
  markFetchCompleted(command: Command, query: string, max: number): void {
    const key = this.getCacheKey(command, query, max);
    this.pendingFetches.delete(key);
  }

  /**
   * Get cache statistics
   */
  getStats(): { hits: number; misses: number; evictions: number; size: number } {
    return {
      ...this.stats,
      size: this.cache.size
    };
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
    this.pendingFetches.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Remove a specific entry from cache
   */
  remove(command: Command, query: string, max: number): boolean {
    const key = this.getCacheKey(command, query, max);
    return this.cache.delete(key);
  }

  /**
   * Remove all entries matching a specific command
   */
  removeByCommand(command: Command): number {
    let removedCount = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${command}${CACHE_KEY_SEP}`)) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    return removedCount;
  }

  /**
   * Remove all entries matching a specific query
   */
  removeByQuery(query: string): number {
    let removedCount = 0;
    for (const key of this.cache.keys()) {
      const parts = key.split(CACHE_KEY_SEP);
      if (parts.length >= 2 && parts[1] === query) {
        this.cache.delete(key);
        removedCount++;
      }
    }
    return removedCount;
  }

  /**
   * Create a cached result node if available, otherwise create a new one for streaming
   */
  createNodeWithCache(
    command: Command,
    query: string,
    max: number,
    parentId: string | null = null
  ): { node: ResultNode; fromCache: boolean } {
    const cached = this.getCached(command, query, max);
    
    if (cached) {
      // Create a new node based on cached data but with new parent context
      const cachedNode = cached;
      const newNode = createResultNode(
        cachedNode.command,
        cachedNode.query,
        cachedNode.text,
        cachedNode.error,
        cachedNode.strokes,
        parentId,
        cachedNode.max
      );
      
      // Copy children from cached node (they maintain their parent relationships)
      // Note: In our architecture, children are created through clicks, so we don't
      // copy them here to avoid duplication
      
      return { node: newNode, fromCache: true };
    }
    
    // Create a placeholder node for streaming
    const placeholderNode = createResultNode(
      command,
      query,
      "", // Empty text initially, will be filled by streaming
      false,
      undefined,
      parentId,
      max
    );
    
    return { node: placeholderNode, fromCache: false };
  }

  /**
   * Serialize cache for persistence (for debugging/metrics)
   */
  serialize(): string {
    return JSON.stringify({
      size: this.cache.size,
      stats: this.stats
    });
  }
}

/**
 * Global cache instance
 */
export const cacheManager = new ResultCacheManager();