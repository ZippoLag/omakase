/**
 * Service-worker cache versioning.
 *
 * The offline shell's cache name is derived from the stamped build version
 * (scripts/version.mjs → src/version.ts), so every web build publishes a new
 * cache and the service worker purges older caches on activate. These helpers
 * are shared between scripts/build-web.mjs (which stamps dist/sw.js at build
 * time) and the unit tests, so the substitution rule has one definition.
 */

/** Cache name for the offline shell: omakase-<build version>. */
export function cacheName(version) {
  return `omakase-${version}`;
}

/**
 * Compose the build version (e.g. "0.1.0-build.9") from a generated
 * src/version.ts source. VERSION itself is emitted as a template literal
 * (`${APP_VERSION}-build.${BUILD}`), so APP_VERSION and BUILD are read
 * directly. Returns null when the source carries no stamp.
 */
export function versionFromStamp(stampSource) {
  const app = /export const APP_VERSION = "([^"]+)";/.exec(stampSource);
  const build = /export const BUILD = (\d+);/.exec(stampSource);
  if (!app || !build) return null;
  return `${app[1]}-build.${build[1]}`;
}

/**
 * Substitute the CACHE constant in the service worker source with the cache
 * name for `version`. Fails loudly (throws) if the source has no CACHE
 * constant, so a reformatted sw.js can never ship with a stale cache name.
 */
export function patchSwCache(swSource, version) {
  const cache = cacheName(version);
  const patched = swSource.replace(/const CACHE = "[^"]*";/, `const CACHE = "${cache}";`);
  if (!patched.includes(`const CACHE = "${cache}";`)) {
    throw new Error("sw.js: CACHE constant not found — cannot stamp the cache version");
  }
  return patched;
}