/**
 * Service-worker cache version stamping tests.
 *
 * scripts/build-web.mjs derives the offline shell's cache name from the
 * freshly stamped build version (via scripts/sw-version.mjs), so every web
 * build publishes a new service worker cache and older caches are purged on
 * activate. These tests pin the derivation and substitution rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheName, patchSwCache, versionFromStamp } from "../scripts/sw-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("cache name embeds the full build version", () => {
  assert.equal(cacheName("0.1.0-build.7"), "omakase-0.1.0-build.7");
  // A different build version must yield a different cache name — that is the
  // whole point: every web build bumps the version, so the cache changes.
  assert.notEqual(cacheName("0.1.0-build.7"), cacheName("0.1.0-build.8"));
});

test("patchSwCache substitutes the CACHE constant with the stamped version", () => {
  const sw = 'const CACHE = "omakase-v__VERSION__";\nself.addEventListener("install", () => {});';
  const out = patchSwCache(sw, "0.1.0-build.7");
  assert.ok(out.startsWith('const CACHE = "omakase-0.1.0-build.7";'));
  // The rest of the worker source is untouched.
  assert.ok(out.includes('self.addEventListener("install"'));
});

test("patchSwCache fails loudly when the CACHE constant is missing", () => {
  assert.throws(() => patchSwCache("const NOPE = 1;", "0.1.0-build.7"), /CACHE constant not found/);
});

test("a new build version always changes the emitted cache constant", () => {
  const sw = 'const CACHE = "omakase-v6";';
  assert.notEqual(patchSwCache(sw, "0.1.0-build.7"), patchSwCache(sw, "0.1.0-build.8"));
});

test("versionFromStamp composes the version from the generated stamp", () => {
  // VERSION is emitted as a template literal, so the parser must read
  // APP_VERSION + BUILD directly rather than matching VERSION itself.
  const stamp = [
    'export const APP_VERSION = "0.1.0";',
    "export const BUILD = 9;",
    "export const VERSION = `${APP_VERSION}-build.${BUILD}`;",
  ].join("\n");
  assert.equal(versionFromStamp(stamp), "0.1.0-build.9");
  assert.equal(versionFromStamp("export const FOO = 1;"), null);
});

test("versionFromStamp agrees with the committed generated stamp", () => {
  // The build stamps dist/sw.js from src/version.ts; if the format ever
  // drifts, this test (and the web build) fail loudly instead of shipping a
  // stale service worker cache name.
  const stamp = readFileSync(join(root, "src", "version.ts"), "utf8");
  const version = versionFromStamp(stamp);
  assert.ok(version, "src/version.ts should carry a version stamp");
  assert.match(version, /^\d+\.\d+\.\d+-build\.\d+$/);
  // The composed version must be cacheable: cacheName(version) is the CACHE
  // constant the served sw.js carries.
  assert.equal(cacheName(version), `omakase-${version}`);
});