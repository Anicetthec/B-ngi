const CACHE_NAME = "bingii-shell-v7";
const SHELL = ["/", "/bingii-logo.svg", "/bingii-app-icon.svg", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  if (event.request.destination === "script" || event.request.destination === "style") {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const update = fetch(event.request).then((response) => {
          if (!response.ok) return response;
          return caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone())).then(() => response);
        });
        return cached || update;
      }),
    );
    return;
  }
  if (event.request.destination === "image" || event.request.destination === "font") {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
