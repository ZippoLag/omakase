/**
 * Result caching system for composable UI.
 * Provides in-memory caching of search results to avoid redundant worker calls.
 */

import type { Command, StrokePage } from "./worker-api.js";
import type { ResultNode } from "./tree.js";

/**
 * Cache key separator for command+query+max combinations. NUL (\u0000), like
 * the queue's `seen` keys in main.ts: queries can legally contain `|` (a
 * kanji/word search box may include the character), and a `|` separator
 * would make keys ambiguous to any code that splits them back apart.
 */
const CACHE_KEY_SEP = "\u0000";

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
    return this.cache.get(key) ?? null;
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
      if (firstKey) this.cache.delete(firstKey);
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
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
    this.pendingFetches.clear();
  }
}

/**
 * Global cache instance
 */
export const cacheManager = new ResultCacheManager();