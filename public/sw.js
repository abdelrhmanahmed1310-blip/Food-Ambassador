/*
 * Food Ambassador service worker (DECISIONS.md ADR-060).
 *
 * Only what the cashier screen needs to work without a connection:
 * - the app's build files (/_next/static, content-hashed): cache first;
 * - the till page itself: network first, the last copy when offline;
 * - the manifest and icons.
 * Everything else — every other page, every API call, the order sync — goes
 * to the network as usual. Orders are kept in IndexedDB by the page, never
 * here. The cached till pages are deleted on the sign-in page.
 */
const STATIC_CACHE = "fa-static-v1";
const PAGE_CACHE = "fa-pos-pages-v1";
const MAX_STATIC = 400;
const TILL = /^\/o\/[^/]+\/pos\/registers\/[^/]+\/sell\/?$/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = [STATIC_CACHE, PAGE_CACHE];
      for (const key of await caches.keys())
        if (key.startsWith("fa-") && !keep.includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STATIC))) await cache.delete(key);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trim(cache);
  }
  return response;
}

function offlinePage() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<title>Offline</title><body style="font-family:sans-serif;padding:2rem">' +
      "<h1>Offline — غير متصل</h1><p>Open the till once while online so it can work offline.</p>" +
      "<p>افتح شاشة البيع مرة واحدة أثناء الاتصال لتعمل دون اتصال.</p></body>",
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function tillPage(request) {
  const url = new URL(request.url);
  const key = url.origin + url.pathname;
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    // Keep only a real till page (not a redirect to sign-in or an error page).
    if (response.ok && !response.redirected) await cache.put(key, response.clone());
    return response;
  } catch {
    return (await cache.match(key)) ?? offlinePage();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate" && TILL.test(url.pathname)) event.respondWith(tillPage(request));
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "cache-till" && Array.isArray(data.assets)) {
    // The page that installed this worker was loaded before it took control:
    // store its build files and the page now, so the next load works offline.
    event.waitUntil(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        for (const href of data.assets) {
          const url = new URL(href, self.location.origin);
          if (url.origin !== self.location.origin || !url.pathname.startsWith("/_next/static/"))
            continue;
          if (await cache.match(url.href)) continue;
          try {
            const response = await fetch(url.href);
            if (response.ok) await cache.put(url.href, response);
          } catch {
            // Offline right now; it is cached on its next load.
          }
        }
        if (
          typeof data.page === "string" &&
          TILL.test(new URL(data.page, self.location.origin).pathname)
        ) {
          try {
            await tillPage(
              new Request(new URL(data.page, self.location.origin).href, {
                credentials: "same-origin",
              }),
            );
          } catch {
            // Ignore: cached on the next online load.
          }
        }
      })(),
    );
  }
  if (data.type === "clear-pages") event.waitUntil(caches.delete(PAGE_CACHE));
});
