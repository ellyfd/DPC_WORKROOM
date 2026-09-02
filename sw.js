/* DPC Hub — service worker (PWA offline shell).
   Bump CACHE when shipping new assets; old caches are purged on activate. */
const CACHE = "dpc-hub-v20260804e";

// App shell precached on install. Versioned query strings match index.html so
// a bump fetches fresh copies; the no-store routes below are never cached.
// 全部 js/*.mjs 都列在這:CACHE 名稱隨部署換,install 一次抓齊同版模組,
// 不會出現新 main.mjs 配到舊子模組的混版。
const SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=20260804e",
  "/js/main.mjs?v=20260804e",
  "/js/state.mjs?v=20260804e",
  "/js/helpers.mjs?v=20260804e",
  "/js/sync.mjs?v=20260804e",
  "/js/data.mjs?v=20260804e",
  "/js/board.mjs?v=20260804e",
  "/js/files.mjs?v=20260804e",
  "/js/menus.mjs?v=20260804e",
  "/js/popovers.mjs?v=20260804e",
  "/js/tips.mjs?v=20260804e",
  "/js/history.mjs?v=20260804e",
  "/manifest.webmanifest",
  "/icon-192.png?v=20260616a",
  "/icon-512.png?v=20260616a",
];

// Dynamic, user-data routes — always hit the network, never serve from cache.
function isNoStore(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/files/") ||
    url.pathname.startsWith("/p/") ||
    url.pathname === "/sw.js"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin pass through
  if (isNoStore(url)) return; // network-only, no SW handling

  // Navigations → network-first, fall back to cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // Static assets → stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
