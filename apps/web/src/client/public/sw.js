// Minimal offline app shell — specs.md NFR-4 (editing and export work offline once
// loaded; plan state itself lives in IndexedDB, handled by the page, not this worker).
const CACHE_NAME = "floorcraft-shell-v2";
const SHELL_URLS = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

function cachePut(req, res) {
  // Clone synchronously, before any await gap — by the time caches.open() resolves the
  // caller may already be reading the body, and clone() throws once a body is disturbed.
  if (!res.ok) return;
  const copy = res.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache API responses

  // index.html is the only entry point that is NOT content-hashed, so serving it
  // cache-first would pin every returning visitor to whichever deployment they first
  // loaded — their browser would go on requesting that build's hashed bundle forever,
  // and shipped fixes would never reach them. Navigations go to the network first and
  // fall back to the cached shell only when offline (NFR-4).
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          cachePut(req, res);
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached ?? caches.match("/index.html"))),
    );
    return;
  }

  // Everything else is content-hashed and therefore immutable: cache-first is both
  // safe (a new build means a new URL) and the fast path.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          cachePut(req, res);
          return res;
        }),
    ),
  );
});
