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
import { cacheName, patchIndexHtml, patchSwCache, versionFromStamp } from "../scripts/sw-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The real worker source — the fixture patchSwCache must round-trip (the
// tests below pin both the CACHE constant and the versioned PRECACHE assets).
const swSource = readFileSync(join(root, "web", "sw.js"), "utf8");

test("cache name embeds the full build version", () => {
  assert.equal(cacheName("0.1.0-build.7"), "omakase-0.1.0-build.7");
  // A different build version must yield a different cache name — that is the
  // whole point: every web build bumps the version, so the cache changes.
  assert.notEqual(cacheName("0.1.0-build.7"), cacheName("0.1.0-build.8"));
});

test("patchSwCache substitutes the CACHE constant and versions the precache assets", () => {
  const out = patchSwCache(swSource, "0.1.0-build.7");
  assert.ok(out.includes('const CACHE = "omakase-0.1.0-build.7";'));
  // The shell assets in PRECACHE carry the same version as index.html's
  // links (patchIndexHtml) — the new sw precaches the new assets, never a
  // stale cached copy.
  assert.ok(out.includes('"./style.css?v=0.1.0-build.7"'));
  assert.ok(out.includes('"./web/app/main.js?v=0.1.0-build.7"'));
  // The rest of the worker source is untouched.
  assert.ok(out.includes('self.addEventListener("install"'));
});

test("patchSwCache fails loudly when the CACHE constant is missing", () => {
  assert.throws(() => patchSwCache("const NOPE = 1;", "0.1.0-build.7"), /CACHE constant not found/);
});

test("patchSwCache fails loudly when the precache asset entries are missing", () => {
  assert.throws(
    () => patchSwCache('const CACHE = "omakase-v6";', "0.1.0-build.7"),
    /PRECACHE asset entries not found/,
  );
});

test("a new build version always changes the emitted cache constant and asset URLs", () => {
  const a = patchSwCache(swSource, "0.1.0-build.7");
  const b = patchSwCache(swSource, "0.1.0-build.8");
  assert.notEqual(a, b);
  assert.ok(a.includes('"omakase-0.1.0-build.7"') && a.includes('?v=0.1.0-build.7'));
  assert.ok(b.includes('"omakase-0.1.0-build.8"') && b.includes('?v=0.1.0-build.8'));
});

test("patchIndexHtml versions the shell asset links", () => {
  const html = [
    '<link rel="stylesheet" href="./style.css">',
    '<script type="module" src="./web/app/main.js"></script>',
  ].join("\n");
  const out = patchIndexHtml(html, "0.1.0-build.7");
  assert.ok(out.includes('href="./style.css?v=0.1.0-build.7"'));
  assert.ok(out.includes('src="./web/app/main.js?v=0.1.0-build.7"'));
  // No other markup is touched.
  assert.ok(out.includes('<link rel="stylesheet"') && out.includes('<script type="module"'));
});

test("patchIndexHtml fails loudly when an asset link is missing", () => {
  assert.throws(() => patchIndexHtml("<html></html>", "0.1.0-build.7"), /versioned .* link not found/);
});

test("patchIndexHtml agrees with the real index.html", () => {
  // The served page (dist/index.html) is built from web/index.html — pin the
  // substitution against the real source so a renamed asset link fails loudly.
  const html = readFileSync(join(root, "web", "index.html"), "utf8");
  const out = patchIndexHtml(html, "0.1.0-build.7");
  assert.ok(out.includes('href="./style.css?v=0.1.0-build.7"'));
  assert.ok(out.includes('src="./web/app/main.js?v=0.1.0-build.7"'));
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