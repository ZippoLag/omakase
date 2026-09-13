/**
 * Type declarations for scripts/sw-version.mjs (used by tests that import it).
 */
export declare function cacheName(version: string): string;
export declare function versionFromStamp(stampSource: string): string | null;
export declare function missingPrecacheEntries(swSource: string, emitted: string[]): string[];
export declare function assertPrecacheCovers(swSource: string, emitted: string[]): void;
export declare function patchIndexHtml(htmlSource: string, version: string): string;
export declare function patchSwCache(swSource: string, version: string): string;