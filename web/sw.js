/* omakase offline shell.
 *
 * Caches the app + engine so the UI runs with no network after the first
 * visit. The ~341 MB dictionary is NOT cached here — it is imported into OPFS
 * once by the worker and served only from device storage. The cache name is
 * stamped from the build version by scripts/build-web.mjs, so every web build
 * publishes a new cache (old caches are deleted on activate).
 */
// Cache name for the offline shell. scripts/build-web.mjs substitutes the
// placeholder below with the freshly stamped build version (e.g.
// "omakase-0.1.0-build.7") when it emits dist/sw.js, so the cache changes on
// every web build. The placeholder itself is never served (dist/ is the web
// root); keep it valid JS for typechecking/dev runs.
const CACHE = "omakase-v__VERSION__";

const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./icon.svg",
  // attribution documents (linked from the footer)
  "./LICENSE.md",
  "./NOTICE.md",
  // emitted app modules (must list every module the build emits —
  // scripts/build-web.mjs verifies this list against dist/ and fails loudly,
  // because a gap leaves the offline shell incomplete)
  "./web/app/main.js",
  "./web/app/worker.js",
  "./web/app/shim.js",
  "./web/app/commands.js",
  "./web/app/worker-api.js",
  "./web/app/tree.js",
  "./web/app/cache.js",
  "./web/app/paging.js",
  "./web/app/query.js",
  "./web/app/stroke-widget.js",
  "./web/app/theme.js",
  // compiled shared query/render layer
  "./src/lookup.js",
  "./src/format.js",
  "./src/version.js",
  "./src/kana.js",
  "./src/kangxi.js",
  "./src/conjugation.js",
  "./src/gloss.js",
  "./src/db/schema-version.js",
  // SQLite WASM engine
  "./web/vendor/index.mjs",
  "./web/vendor/sqlite3.wasm",
  "./web/vendor/sqlite3-opfs-async-proxy.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // addAll is all-or-nothing: one failed fetch rejects the whole batch,
      // leaving the cache half-populated. Only take over (skipWaiting) when
      // the precache actually completed — an incomplete precache must not
      // replace the current worker, or activate would delete the old cache
      // and leave offline users with a broken shell. The old worker keeps
      // serving until a later update succeeds.
      const ok = await cache.addAll(PRECACHE).then(() => true, (err) => {
        console.warn("precache incomplete — keeping the current version active:", err);
        return false;
      });
      if (ok) self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Only purge older caches when THIS cache actually holds every precache
      // entry — deleting them while the new cache is incomplete would leave
      // offline users with nothing to serve. An incomplete cache simply keeps
      // the old caches around (the app stays usable); the next successful
      // update cleans them up.
      const entries = await Promise.all(PRECACHE.map((u) => cache.match(u)));
      if (entries.every((e) => e !== undefined)) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      }
      await self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // The dictionary download must always hit the network (OPFS import); the
  // browser HTTP cache still applies.
  if (url.pathname === "/kanji.db") return;

  // Navigations go network-first so a fresh deploy is picked up on the next
  // reload (offline falls back to the precached shell); every other request
  // is cache-first WITHIN this build's cache only — never a stale cache from
  // an older build — falling back to the network and caching the response.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request, { cacheName: CACHE })),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { cacheName: CACHE }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      });
    }),
  );
});
