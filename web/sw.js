/* omakase offline shell.
 *
 * Caches the app + engine so the UI runs with no network after the first
 * visit. The 289 MB dictionary is NOT cached here — it is imported into OPFS
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
  // emitted app modules
  "./web/app/main.js",
  "./web/app/worker.js",
  "./web/app/shim.js",
  "./web/app/commands.js",
  "./web/app/worker-api.js",
  "./web/app/tree.js",
  "./web/app/cache.js",
  "./web/app/stroke-widget.js",
  // compiled shared query/render layer
  "./src/lookup.js",
  "./src/format.js",
  "./src/version.js",
  "./src/kana.js",
  "./src/kangxi.js",
  "./src/conjugation.js",
  // SQLite WASM engine
  "./web/vendor/index.mjs",
  "./web/vendor/sqlite3.wasm",
  "./web/vendor/sqlite3-opfs-async-proxy.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch((err) => console.warn("precache incomplete:", err)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // The dictionary download must always hit the network (OPFS import); the
  // browser HTTP cache still applies.
  if (url.pathname === "/kanji.db") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
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
