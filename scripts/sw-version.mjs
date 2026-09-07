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
 * Version the shell asset URLs in index.html (`href="./style.css"`,
 * `src="./web/app/main.js"`) with the build version, so a new build's html
 * can never resolve old cached assets. The same substitution rule is applied
 * to the service worker's PRECACHE list (patchSwCache), so both sides agree
 * on the exact URL set. Fails loudly (throws) if a target link is missing,
 * so a reformatted index.html can never ship unversioned.
 */
export function patchIndexHtml(htmlSource, version) {
  const css = `./style.css?v=${version}`;
  const js = `./web/app/main.js?v=${version}`;
  const patched = htmlSource
    .replace(/href="\.\/style\.css"/, `href="${css}"`)
    .replace(/src="\.\/web\/app\/main\.js"/, `src="${js}"`);
  if (!patched.includes(`href="${css}"`) || !patched.includes(`src="${js}"`)) {
    throw new Error("index.html: versioned style.css/main.js link not found — cannot stamp the asset versions");
  }
  return patched;
}

/**
 * Substitute the CACHE constant in the service worker source with the cache
 * name for `version`, and version the shell asset entries in PRECACHE the
 * same way patchIndexHtml versions index.html — so the new service worker
 * precaches the new assets, never a stale cached copy. Fails loudly (throws)
 * if the source has no CACHE constant or no precache asset entries, so a
 * reformatted sw.js can never ship with a stale cache name or unversioned
 * assets.
 */
export function patchSwCache(swSource, version) {
  const cache = cacheName(version);
  let patched = swSource.replace(/const CACHE = "[^"]*";/, `const CACHE = "${cache}";`);
  if (!patched.includes(`const CACHE = "${cache}";`)) {
    throw new Error("sw.js: CACHE constant not found — cannot stamp the cache version");
  }
  patched = patched
    .replace(/"\.\/style\.css"/, `"./style.css?v=${version}"`)
    .replace(/"\.\/web\/app\/main\.js"/, `"./web/app/main.js?v=${version}"`);
  if (!patched.includes(`"./style.css?v=${version}"`) || !patched.includes(`"./web/app/main.js?v=${version}"`)) {
    throw new Error("sw.js: PRECACHE asset entries not found — cannot stamp the asset versions");
  }
  return patched;
}