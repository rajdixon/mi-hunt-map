"use strict";
// Google satellite (with Google's roads and place names) from the Map Tiles
// API. The server hands signed-in phones the key (/api/gmaps); each phone
// starts its own tile session, good for about two weeks. Google's terms don't
// allow keeping its tiles, so they're never cached: with no signal the Esri
// imagery under it shows instead (app.js setBasemap), and offline saves use Esri.

const GMAPS = "https://tile.googleapis.com";
let gmaps = store.get("gmaps", null);   // { key, session, expiry (ms) }

async function gmapsSession(key) {
  const res = await fetch(`${GMAPS}/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US",
                           layerTypes: ["layerRoadmap"], scale: "scaleFactor2x", highDpi: true }),
  });
  if (!res.ok) throw new Error(`Google session ${res.status}`);
  const s = await res.json();
  gmaps = { key, session: s.session, expiry: +s.expiry * 1000 };
  store.set("gmaps", gmaps);
}

const gmapsTiles = () => [`${GMAPS}/v1/2dtiles/{z}/{x}/{y}?session=${gmaps.session}&key=${gmaps.key}`];

function gmapsLayer() {
  if (map.getSource("bm-google")) { map.getSource("bm-google").setTiles(gmapsTiles()); return; }
  map.addSource("bm-google", { type: "raster", tiles: gmapsTiles(), tileSize: 256, maxzoom: 20, attribution: "Google Maps" });
  // Just above the other backgrounds, under the land and everything else
  const above = map.getStyle().layers.find(l => !l.id.startsWith("bm-"));
  map.addLayer({ id: "bm-google", type: "raster", source: "bm-google", layout: { visibility: "none" } }, above?.id);
  // Google satellite became the default: move everyone to it once
  if (!store.get("gmaps:default", false)) { store.set("gmaps:default", true); basemap = "google"; }
  setBasemap(basemap);
}

async function gmapsStart() {
  let key = gmaps?.key;
  try {
    const res = await fetch("/api/gmaps", { redirect: "manual", credentials: "same-origin" });
    if (res.status === 404) {
      // Not set up on the server: no Google option
      store.set("gmaps", gmaps = null);
      document.querySelector('[data-basemap="google"]')?.remove();
      if (basemap === "google") setBasemap("sat");
      return;
    }
    if (res.ok) key = (await res.json()).key;
  } catch {}   // no signal: use the saved key and session
  if (!key) return;
  if (!gmaps || gmaps.key !== key || gmaps.expiry - Date.now() < 86400e3) {
    try { await gmapsSession(key); } catch { if (!gmaps || gmaps.expiry < Date.now()) return; }
  }
  gmapsLayer();
}

// A session that has run out mid-use: get a new one, once
let gmapsRenewing = false;
map.on("error", async e => {
  if (e.sourceId !== "bm-google" || gmapsRenewing || ![401, 403].includes(e.error?.status)) return;
  gmapsRenewing = true;
  try { await gmapsSession(gmaps.key); gmapsLayer(); } catch {}
  setTimeout(() => { gmapsRenewing = false; }, 60000);
});

// Google's copyright for what's on screen goes in the map's attribution
let gmapsAttrTimer = null;
function gmapsAttribution() {
  clearTimeout(gmapsAttrTimer);
  if (basemap !== "google" || !gmaps || !map.getSource("bm-google") || !navigator.onLine) return;
  gmapsAttrTimer = setTimeout(async () => {
    const b = map.getBounds(), q = new URLSearchParams({ session: gmaps.session, key: gmaps.key,
      zoom: Math.round(map.getZoom()), north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
    try {
      const v = await (await fetch(`${GMAPS}/tile/v1/viewport?${q}`)).json();
      const src = map.getSource("bm-google");
      if (!src || !v.copyright) return;
      src.attribution = `Google Maps · ${v.copyright}`;
      map._controls?.find(c => c._updateAttributions)?._updateAttributions();
    } catch {}
  }, 800);
}
map.on("moveend", gmapsAttribution);

if (map.getLayer("bm-topo-0")) gmapsStart(); else map.once("load", gmapsStart);
