// App shell + land data: cache-first, so the map works with no signal.
// Basemap tiles: cached as you browse (up to MAX_TILES), so areas you've
// looked at while online stay visible offline.
const VERSION = "v1-2026-10-09";
const SHELL = `shell-${VERSION}`;
const TILES = "tiles-v1";
const MAX_TILES = 4000;

const SHELL_FILES = [
  "./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png",
  "data/meta.json", "data/state_forest.geojson", "data/state_wildlife.geojson", "data/state_parks.geojson",
  "data/hap.geojson", "data/commercial_forest.geojson", "data/national_forest.geojson",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  if (url.hostname === "server.arcgisonline.com") {
    e.respondWith(tile(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && (url.origin === location.origin || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com"))) {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") {
      await cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  trimming = false;
}
