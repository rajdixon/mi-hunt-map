// App code: network-first (short timeout), so updates show up right away
// and the saved copy is used only with no signal.
// Land data: cache-first; a data refresh bumps VERSION to replace it.
// Basemap tiles: areas saved from the Offline maps sheet (never trimmed),
// plus tiles cached as you browse (up to MAX_TILES).
const VERSION = "v35-2026-10-22";
const SHELL = `shell-${VERSION}`;
const TILES = "tiles-v1";
const PHOTOS = "photos-v1";
const PRIVATE = "private-v1";
const MAX_TILES = 4000;
const TILE_HOSTS = ["server.arcgisonline.com", "basemap.nationalmap.gov", "elevation.nationalmap.gov", "s3.amazonaws.com"];

// LiDAR tiles are requested by bounding box; round it so a saved tile and
// the map's request for the same tile share one cache key (same as app.js)
function tileKey(url) {
  return url.replace(/bbox=([^&]+)/, (_, b) =>
    "bbox=" + decodeURIComponent(b).split(",").map(v => Math.round(+v)).join(","));
}

const SHELL_FILES = [
  "./", "index.html", "style.css", "app.js", "rules.js", "weather.js", "outlook.js", "activity.js", "vendor/suncalc.js", "pins.js", "tracks.js", "overlays.js", "view3d.js", "search.js", "scent.js", "stats.js", "measure.js", "radar.js", "goto.js", "draw.js", "settings.js", "sync.js", "usage.js", "notes.js", "photos.js", "partners.js", "pinfilter.js", "private.js", "manifest.webmanifest", "icon.svg", "icon-192.png",
  "data/meta.json", "data/state_forest.geojson", "data/state_wildlife.geojson", "data/state_parks.geojson",
  "data/hap.geojson", "data/commercial_forest.geojson", "data/national_forest.geojson",
  "data/counties.geojson", "data/landlocked.geojson", "data/dmu.geojson", "data/deer_rules_2026.json",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css",
];

self.addEventListener("install", e => {
  // cache: "reload" skips the browser's HTTP cache (GitHub Pages allows 10 min),
  // so a new version never stores stale copies of the old files
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Alerts from the server (notes.js turns them on)
self.addEventListener("push", e => {
  let m = {};
  try { m = e.data.json(); } catch { m = { title: "MI Hunt Land", body: e.data?.text() || "" }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(m.title || "MI Hunt Land", {
      body: m.body || "", tag: m.tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: m.url || "/" },
    }),
    m.unread && self.navigator.setAppBadge ? self.navigator.setAppBadge(m.unread).catch(() => {}) : null,
  ]));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    if (open) { open.postMessage({ note: new URL(url).searchParams.get("note") }); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Photos never change once uploaded: keep each one after it's first seen, for offline
  if (url.origin === location.origin && url.pathname.startsWith("/api/photos/")) { e.respondWith(photo(e.request)); return; }
  // Owner's private layers: fresh when there's a signal, the last copy when not
  if (url.origin === location.origin && url.pathname.startsWith("/api/private/")) { e.respondWith(privateFile(e.request)); return; }
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;   // sync: always live
  if (url.hostname === "mesonet.agron.iastate.edu") return;   // radar: always live, never kept

  if (TILE_HOSTS.includes(url.hostname)) {
    // The page's "Save this area" downloads write their own cache
    if (e.request.cache === "no-store") return;
    e.respondWith(tile(e.request));
    return;
  }
  const appCode = url.origin === location.origin && !url.pathname.includes("/data/");
  e.respondWith(appCode ? networkFirst(e.request) : cacheFirst(e.request, url));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req, { cache: "no-cache" });
  try {
    // With a saved copy, give the network 3 seconds; without one, wait for it
    const res = saved ? await Promise.race([net,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]) : await net;
    if (res.ok) { cache.put(req, res.clone()); return res; }
    // A page load that needs signing in again must reach the sign-in page.
    // Anything else (a script answered by a sign-in redirect or an error) would
    // break the app, so use the saved copy.
    if (req.mode === "navigate" || !saved) return res;
    return saved;
  } catch {
    return saved || Response.error();
  }
}

async function cacheFirst(req, url) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && (url.origin === location.origin || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com"))) {
    const copy = res.clone();
    caches.open(SHELL).then(c => c.put(req, copy));
  }
  return res;
}

async function privateFile(req) {
  const cache = await caches.open(PRIVATE);
  try {
    const res = await fetch(req, { redirect: "manual" });
    if (res.ok) await cache.put(req, res.clone());
    else if (res.status === 404) await cache.delete(req);   // no longer the owner, or removed
    return res.ok || res.status === 404 ? res : (await cache.match(req)) || res;
  } catch {
    return (await cache.match(req)) || new Response("", { status: 504 });
  }
}

async function photo(req) {
  const cache = await caches.open(PHOTOS);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req, { redirect: "manual" });
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}

async function tile(req) {
  // Saved offline areas first, then tiles cached while browsing
  const key = tileKey(req.url);
  const hit = await caches.match(key);
  if (hit) return hit;
  const cache = await caches.open(TILES);
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") {
      await cache.put(key, res.clone());
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
