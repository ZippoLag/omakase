/**
 * Type declarations for scripts/sw-version.mjs (used by tests that import it).
 */
export declare function cacheName(version: string): string;
export declare function versionFromStamp(stampSource: string): string | null;
export declare function patchSwCache(swSource: string, version: string): string;