// Service worker minimale: rende l'app installabile e utilizzabile offline
// (mostra l'ultima lista scaricata anche senza connessione).

const CACHE = "phdtracker-v8";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isData = url.pathname.includes("/data/") || url.pathname.includes("/config/");

  if (isData) {
    // network-first: dati sempre freschi quando possibile, cache come fallback offline
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // cache-first per lo shell dell'app
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
