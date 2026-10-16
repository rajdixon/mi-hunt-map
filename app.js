"use strict";

// Drawn bottom to top; the info sheet reports the top-most hit.
const LAYERS = [
  { id: "national_forest", name: "National Forest", note: "Huron-Manistee, Hiawatha, Ottawa", color: "#9cc65a",
    title: p => p.Unit_Name || "National Forest land",
    rows: p => [["Agency", "US Forest Service"], ["Info", p.Link && link(p.Link)]] },
  { id: "commercial_forest", name: "Commercial Forest", note: "Private land open to foot access for hunting", color: "#c07a45",
    title: () => "Commercial Forest land",
    rows: p => [["Owner", p.FullLegalName], ["County", p.CountyName], ["Acres", p.Acres],
                ["Access", "Open on foot for hunting, fishing and trapping. Check DNR rules on vehicles and blinds."]] },
  { id: "state_forest", name: "State Forest", note: "DNR Forest Resources Division", color: "#2f8f46",
    title: p => p.UnitName ? `${p.UnitName} Forest Unit` : "State Forest",
    rows: p => [["County", p.County]] },
  { id: "state_wildlife", name: "State Game & Wildlife Areas", note: "DNR Wildlife Division", color: "#1fa5a0",
    title: p => p.OfficialWLDProjectAreaName || "State Wildlife Area",
    rows: p => [["Type", p.AreaType]] },
  { id: "state_parks", name: "State Parks & Rec Areas", note: "Huntable portions only", color: "#a77bd6",
    title: p => p.Facility || "State Park land",
    rows: p => [["Hunting/trapping", p.HuntTrap], ["Restrictions", p.HuntTrapRestrictions],
                ["Early goose", p.EarlyGoose], ["Notes", p.Comments]] },
  { id: "hap", name: "Hunter Access Program", note: "Private land leased for public hunting", color: "#ffc21a",
    title: p => `HAP site ${p.HAPID ?? ""}`.trim(),
    rows: p => [["County", p.COUNTY], ["Hunt types", p.HuntType], ["Check-in", p.HAPInfo],
                ["Notes", p.SpecialComment], ["Acres", p.acres && Math.round(p.acres)]] },
];

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const USGS = "https://basemap.nationalmap.gov/arcgis/rest/services";
const ROADS_REF = { url: `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, attr: "" };
const PLACES_REF = { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, attr: "" };
// fill: land-shading opacity that reads well on that background
const BASEMAPS = {
  topo: { label: "Topo", fill: 0.32, layers: [
    { url: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`, attr: "Esri, USGS, NOAA" }] },
  sat: { label: "Satellite", fill: 0.42, layers: [
    { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, attr: "Esri, Maxar, Earthstar Geographics" },
    ROADS_REF, PLACES_REF] },
  // Light shading so the terrain stays visible through it
  lidar: { label: "LiDAR terrain", fill: 0.16, layers: [
    // USGS 3DEP bare-earth elevation (LiDAR where flown), lit from several directions
    { url: "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage" +
           "?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image" +
           "&renderingRule=%7B%22rasterFunction%22%3A%22Hillshade%20Multidirectional%22%7D",
      attr: "USGS 3DEP", maxzoom: 17 },
    ROADS_REF, PLACES_REF] },
  usgs: { label: "USGS Topo", fill: 0.32, layers: [
    { url: `${USGS}/USGSTopo/MapServer/tile/{z}/{y}/{x}`, attr: "USGS The National Map", maxzoom: 16 }] },
  usgsImg: { label: "Imagery + Topo", fill: 0.42, layers: [
    { url: `${USGS}/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}`, attr: "USGS The National Map", maxzoom: 16 }] },
};

const store = {
  get(k, d) { try { const v = localStorage.getItem("mhl:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mhl:" + k, JSON.stringify(v)); } catch {} },
};

const $ = id => document.getElementById(id);
const data = {};          // id -> FeatureCollection with per-feature bbox
let basemap = store.get("basemap", "topo");
if (!BASEMAPS[basemap]) basemap = "topo";
const visible = store.get("visible", Object.fromEntries(LAYERS.map(l => [l.id, true])));

function link(url) {
  const a = document.createElement("a");
  a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Forest Service site";
  return a;
}

// ---------- Map ----------
const map = new maplibregl.Map({
  container: "map",
  style: { version: 8, sources: {}, layers: [] },
  center: store.get("center", [-85.6, 44.6]),
  zoom: store.get("zoom", 6),
  maxBounds: [[-93.5, 40.5], [-80.5, 49.5]],
  attributionControl: { compact: true, customAttribution: "Michigan DNR" },
  dragRotate: false, maxPitch: 70,   // rotate and tilt only in 3D view (view3d.js)
});
map.touchZoomRotate.disableRotation();
const scaleControl = new maplibregl.ScaleControl({ unit: "imperial" });
map.addControl(scaleControl, "bottom-left");
// With a mouse: zoom buttons, and the cursor's coordinates (when GPS isn't showing)
const mouse = matchMedia("(hover: hover) and (pointer: fine)").matches;
if (mouse) {
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("mousemove", e => {
    if (lastFix) return;
    const c = $("coords");
    c.hidden = false;
    c.textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
  });
  map.getCanvas().addEventListener("mouseleave", () => { if (!lastFix) $("coords").hidden = true; });
}
document.body.classList.toggle("mouse", mouse);

function setBasemap(name) {
  basemap = name; store.set("basemap", name);
  for (const k of Object.keys(BASEMAPS)) {
    BASEMAPS[k].layers.forEach((_, i) => {
      const id = `bm-${k}-${i}`;
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", k === name ? "visible" : "none");
    });
  }
  document.querySelectorAll("[data-basemap]").forEach(b =>
    b.setAttribute("aria-checked", String(b.dataset.basemap === name)));
  // Land shading strength depends on the background
  for (const l of LAYERS) if (map.getLayer(l.id + "-fill"))
    map.setPaintProperty(l.id + "-fill", "fill-opacity", BASEMAPS[name].fill);
}

map.on("load", async () => {
  for (const [k, b] of Object.entries(BASEMAPS)) {
    b.layers.forEach((t, i) => {
      const id = `bm-${k}-${i}`;
      map.addSource(id, { type: "raster", tiles: [t.url], tileSize: 256, maxzoom: t.maxzoom || 19, attribution: t.attr });
      map.addLayer({ id, type: "raster", source: id, layout: { visibility: "none" } });
    });
  }

  await Promise.all(LAYERS.map(async l => {
    const res = await fetch(`data/${l.id}.geojson`);
    const fc = await res.json();
    fc.features.forEach(f => { f.bbox = bboxOf(f.geometry); });
    data[l.id] = fc;
  }));

  for (const l of LAYERS) {
    map.addSource(l.id, { type: "geojson", data: data[l.id], tolerance: 0.25 });
    const vis = visible[l.id] === false ? "none" : "visible";
    map.addLayer({ id: l.id + "-fill", type: "fill", source: l.id, layout: { visibility: vis },
                   paint: { "fill-color": l.color, "fill-opacity": 0.32 } });
    map.addLayer({ id: l.id + "-line", type: "line", source: l.id, layout: { visibility: vis },
                   paint: { "line-color": l.color, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 12, 1.5, 15, 2.5] } });
  }

  // Saved offline areas
  map.addSource("areas", { type: "geojson", data: areasGeoJSON() });
  map.addLayer({ id: "areas-line", type: "line", source: "areas",
                 paint: { "line-color": "#ff6a13", "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.8 } });

  // Selected parcel outline + user position
  map.addSource("sel", { type: "geojson", data: empty() });
  map.addLayer({ id: "sel-line", type: "line", source: "sel",
                 paint: { "line-color": "#ff6a13", "line-width": 3 } });
  map.addSource("me", { type: "geojson", data: empty() });
  map.addLayer({ id: "me-acc", type: "fill", source: "me", filter: ["==", "$type", "Polygon"],
                 paint: { "fill-color": "#3d8bff", "fill-opacity": 0.15 } });
  map.addLayer({ id: "me-halo", type: "circle", source: "me", filter: ["==", "$type", "Point"],
                 paint: { "circle-radius": 11, "circle-color": "#fff" } });
  map.addLayer({ id: "me-dot", type: "circle", source: "me", filter: ["==", "$type", "Point"],
                 paint: { "circle-radius": 7.5, "circle-color": "#3d8bff" } });

  setBasemap(basemap);
  buildLayerList();
  fetch("data/meta.json").then(r => r.json()).then(m => { $("data-date").textContent = m.updated; }).catch(() => {});
  document.dispatchEvent(new Event("land-ready"));
});

map.on("moveend", () => {
  const c = map.getCenter();
  store.set("center", [+c.lng.toFixed(4), +c.lat.toFixed(4)]);
  store.set("zoom", +map.getZoom().toFixed(2));
});

// ---------- Tap a parcel ----------
map.on("click", e => {
  if (typeof measureClick === "function" && measureClick(e)) return;
  if (typeof pinsSuppressClick === "function" && pinsSuppressClick()) return;
  if (typeof drawClick === "function" && drawClick(e)) return;
  const shape = typeof shapeAt === "function" && shapeAt(e.point);
  if (shape) { openShapeEditor(shape); return; }
  if (typeof partnerShapeAt === "function" && partnerShapeAt(e.point)) return;
  const hits = hitsAt([e.lngLat.lng, e.lngLat.lat], true);
  // Overlay features under the tap (stand, road, trail, section...), from overlays.js
  const extras = typeof overlayHitsAt === "function" ? overlayHitsAt(e.point) : [];
  if (!hits.length && !extras.length) { closeSheet("sheet-info"); map.getSource("sel").setData(empty()); return; }
  showInfo(hits[0], e.lngLat, extras);
});

function fillRows(dl, rows) {
  dl.replaceChildren();
  for (const [k, v] of rows) {
    if (v == null || v === "" || (typeof v === "string" && !v.trim())) continue;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd");
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    dl.append(dt, dd);
  }
}

function showInfo(hit, lngLat, extras = []) {
  const main = hit ? { kind: hit.layer.name, title: hit.layer.title(hit.feature.properties || {}),
                       rows: hit.layer.rows(hit.feature.properties || {}) } : extras.shift();
  $("info-kind").textContent = main.kind;
  $("info-title").textContent = main.title;
  fillRows($("info-rows"), main.rows);
  const more = $("info-extra"); more.replaceChildren();
  for (const x of extras) {
    const sec = document.createElement("div"); sec.className = "info-extra";
    const k = document.createElement("div"); k.className = "kind"; k.textContent = x.kind;
    const t = document.createElement("div"); t.className = "info-extra-title"; t.textContent = x.title;
    const dl = document.createElement("dl"); dl.className = "rows";
    fillRows(dl, x.rows);
    sec.append(k, t, dl);
    more.append(sec);
  }
  $("info-coords").textContent = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
  map.getSource("sel").setData(hit ? hit.feature : empty());
  openSheet("sheet-info");
}

// ---------- Geometry ----------
function empty() { return { type: "FeatureCollection", features: [] }; }

function bboxOf(g) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inGeom(pt, g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some(poly => inRing(pt, poly[0]) && !poly.slice(1).some(h => inRing(pt, h)));
}

// Top-most layer first. onlyVisible limits taps to layers the user can see.
function hitsAt(pt, onlyVisible) {
  const out = [];
  for (const l of [...LAYERS].reverse()) {
    if (!data[l.id] || (onlyVisible && visible[l.id] === false)) continue;
    for (const f of data[l.id].features) {
      const b = f.bbox;
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      if (inGeom(pt, f.geometry)) { out.push({ layer: l, feature: f }); break; }
    }
  }
  return out;
}

// ---------- Location ----------
let watchId = null, follow = true, lastFix = null;

$("btn-locate").addEventListener("click", () => {
  if (watchId != null && lastFix) {
    // Second tap recenters; long-press style toggling is too fiddly with gloves
    follow = true;
    map.easeTo({ center: lastFix, zoom: Math.max(map.getZoom(), 14) });
    return;
  }
  if (!("geolocation" in navigator)) return setStatus("off", "Location not available on this device");
  setStatus("wait", "Finding you…");
  $("btn-locate").setAttribute("aria-pressed", "true");
  startWatch();
});

// GPS runs constantly, or, with Battery saver on, once a minute. Recording a
// track and Go to always get full speed.
let pollTimer = null;
const SAVER_MS = 60000;
function gpsSaver() {
  return typeof settings !== "undefined" && settings.saver
    && !(typeof rec !== "undefined" && rec) && !(typeof goTarget !== "undefined" && goTarget);
}
function startWatch() {
  if (gpsSaver()) {
    watchId = "poll";
    const once = () => navigator.geolocation.getCurrentPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 });
    once();
    pollTimer = setInterval(once, SAVER_MS);
  } else {
    watchId = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
}
function stopWatch() {
  if (watchId === "poll") clearInterval(pollTimer);
  else if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
// After Battery saver, recording or Go to changes: switch GPS mode if it's on
function refreshWatch() {
  if (watchId == null || (watchId === "poll") === gpsSaver()) return;
  stopWatch(); startWatch();
}

map.on("dragstart", () => { follow = false; });
// Jumping somewhere on purpose (search, a pin, a saved track) stops following GPS
function stopFollowing() { follow = false; }

function onFix(pos) {
  const { longitude: lng, latitude: lat, accuracy } = pos.coords;
  const first = !lastFix;
  lastFix = [lng, lat];
  map.getSource("me")?.setData({ type: "FeatureCollection", features: [
    circle(lng, lat, accuracy),
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: lastFix } },
  ] });
  if (first) map.flyTo({ center: lastFix, zoom: Math.max(map.getZoom(), 14), speed: 1.6 });
  else if (follow) map.easeTo({ center: lastFix, duration: 600 });

  if (typeof refreshRules === "function") refreshRules();
  if (typeof trackOnFix === "function") trackOnFix(pos);
  if (typeof gotoOnFix === "function") gotoOnFix(pos);
  if (typeof partnersOnFix === "function") partnersOnFix(pos);
  const hits = hitsAt(lastFix, false);
  if (hits.length) setStatus("in", `On ${hits[0].layer.name}`);
  else setStatus("out", "Not on mapped public land");
  const c = $("coords");
  c.hidden = false;
  c.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}  ${typeof fmtAcc === "function" ? fmtAcc(accuracy) : `±${Math.round(accuracy * 3.281)} ft`}`;
}

function onFixError(err) {
  const msg = err.code === 1 ? "Location blocked. Allow it in browser settings"
            : err.code === 3 ? "Still looking for GPS…" : "Can't get location";
  setStatus(err.code === 3 ? "wait" : "off", msg);
  if (err.code === 1) { stopWatch(); $("btn-locate").setAttribute("aria-pressed", "false"); }
}

function setStatus(state, text) {
  $("status").dataset.state = state;
  $("status-text").textContent = text;
}

function circle(lng, lat, meters) {
  const pts = [], n = 48, dLat = meters / 111320, dLng = dLat / Math.cos(lat * Math.PI / 180);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } };
}

// ---------- Sheets & layer list ----------
// Buttons ride above whichever sheet is open so they never get covered
const sheetObserver = new ResizeObserver(liftButtons);
document.querySelectorAll(".sheet").forEach(s => sheetObserver.observe(s));
function liftButtons() {
  const open = [...document.querySelectorAll(".sheet")].find(s => !s.hidden);
  const docked = open && innerWidth < 700;
  const h = docked ? open.offsetHeight : 0;
  // Wider screens: the sheet is a side panel on the left
  // (layout box, not getBoundingClientRect: the slide-in animation would skew it; zoom scales both)
  const z = +getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom") || 1;
  const w = open && !docked ? Math.round((open.offsetLeft + open.offsetWidth) * z) : 0;
  document.documentElement.style.setProperty("--sheet-h", h + "px");
  document.documentElement.style.setProperty("--sheet-w", w + "px");
  // Keep the map's center in the visible area beside or above the sheet (the rules panel reads it)
  const p = map.getPadding();
  if (p.bottom !== h || p.left !== w) map.setPadding({ top: 0, left: w, right: 0, bottom: h });
}
addEventListener("resize", liftButtons);

// Keyboard: Escape closes the open panel; / or Ctrl+K opens search
document.addEventListener("keydown", e => {
  if (e.defaultPrevented || !$("photo-viewer").hidden) return;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (e.key === "Escape") {
    const open = [...document.querySelectorAll(".sheet")].find(s => !s.hidden);
    if (open) { e.preventDefault(); closeSheet(open.id); if (typing) e.target.blur(); }
    return;
  }
  if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    if ($("sheet-search").hidden) $("btn-search").click();
    setTimeout(() => $("search-input").focus(), 50);
  }
});
function openSheet(id) {
  for (const s of document.querySelectorAll(".sheet")) s.hidden = s.id !== id;
  liftButtons();
}
function closeSheet(id) { $(id).hidden = true; liftButtons(); }

$("btn-layers").addEventListener("click", () =>
  $("sheet-layers").hidden ? openSheet("sheet-layers") : closeSheet("sheet-layers"));
$("btn-offline").addEventListener("click", () => {
  if (!$("sheet-offline").hidden) return closeSheet("sheet-offline");
  renderOffline();
  openSheet("sheet-offline");
});
document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", () => {
    closeSheet(b.dataset.close);
    if (b.dataset.close === "sheet-info") map.getSource("sel")?.setData(empty());
  }));
for (const [k, b] of Object.entries(BASEMAPS)) {
  const btn = document.createElement("button");
  btn.dataset.basemap = k; btn.setAttribute("role", "radio");
  btn.setAttribute("aria-checked", String(k === basemap));
  btn.textContent = b.label;
  btn.addEventListener("click", () => setBasemap(k));
  $("basemap-list").append(btn);
}

function buildLayerList() {
  const ul = $("layer-list"); ul.replaceChildren();
  for (const l of [...LAYERS].reverse()) {
    const li = document.createElement("li");
    li.innerHTML = `<label for="lyr-${l.id}">
      <input type="checkbox" id="lyr-${l.id}">
      <span class="swatch" style="background:${l.color}55;border-color:${l.color}"></span>
      <span><span class="layer-name"></span><span class="layer-note"></span></span></label>`;
    li.querySelector(".layer-name").textContent = l.name;
    li.querySelector(".layer-note").textContent = l.note;
    const cb = li.querySelector("input");
    cb.checked = visible[l.id] !== false;
    cb.addEventListener("change", () => {
      visible[l.id] = cb.checked; store.set("visible", visible);
      for (const suffix of ["-fill", "-line"])
        map.setLayoutProperty(l.id + suffix, "visibility", cb.checked ? "visible" : "none");
    });
    ul.append(li);
  }
}

// ---------- Offline areas ----------
// Saved tiles live in their own cache, which the service worker checks
// before the network and never trims.
const OFFLINE_CACHE = "offline-tiles-v1";
const SAVE_MIN_Z = 8, SAVE_MAX_Z = 16, SAVE_LIMIT = 6000, AVG_TILE_KB = 20;
let areas = store.get("areas", []);
let saving = null;   // AbortController while a save runs

function lng2x(lng, z) { return Math.floor((lng + 180) / 360 * 2 ** z); }
function lat2y(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
}

function tileUrls(bounds, basemapName) {
  const [w, s, e, n] = bounds, urls = [];
  if (!BASEMAPS[basemapName]) return urls;
  for (let z = SAVE_MIN_Z; z <= SAVE_MAX_Z; z++) {
    const x0 = lng2x(w, z), x1 = lng2x(e, z), y0 = lat2y(n, z), y1 = lat2y(s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
      for (const t of BASEMAPS[basemapName].layers)
        if (z <= (t.maxzoom || 19)) urls.push(tileUrl(t.url, z, x, y));
  }
  return urls;
}

// Web Mercator extent of tile z/x/y, for image services (LiDAR) that take a bbox
function tileUrl(tpl, z, x, y) {
  if (!tpl.includes("{bbox-epsg-3857}"))
    return tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const R = 20037508.342789244, size = 2 * R / 2 ** z;
  const bbox = [-R + x * size, R - (y + 1) * size, -R + (x + 1) * size, R - y * size].join(",");
  return tileKey(tpl.replace("{bbox-epsg-3857}", bbox));
}

// Same rounding the service worker uses, so saved bbox tiles match the map's requests
function tileKey(url) {
  return url.replace(/bbox=([^&]+)/, (_, b) =>
    "bbox=" + decodeURIComponent(b).split(",").map(v => Math.round(+v)).join(","));
}

function viewBounds() {
  return flatBounds().map(v => +v.toFixed(5));
}

// The area the screen would show looking straight down. A tilted map's
// bounds run out to the horizon, far more than anyone means by "this view".
function flatBounds(scale = 1) {
  if (map.getPitch() < 1 && Math.abs(map.getBearing()) < 1 && scale === 1) {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  const c = map.getCenter(), c2 = map.getContainer(), p = map.getPadding();
  const degPerPx = 360 / (512 * 2 ** map.getZoom());
  const w = (c2.clientWidth - p.left - p.right) * degPerPx * scale / 2;
  const h = (c2.clientHeight - p.top - p.bottom) * degPerPx * Math.cos(c.lat * Math.PI / 180) * scale / 2;
  const r = Math.max(w, h);   // rotated: cover every way round
  return Math.abs(map.getBearing()) < 1 ? [c.lng - w, c.lat - h, c.lng + w, c.lat + h] : [c.lng - r, c.lat - r, c.lng + r, c.lat + r];
}

function areasGeoJSON() {
  return { type: "FeatureCollection", features: areas.map(a => {
    const [w, s, e, n] = a.bounds;
    return { type: "Feature", properties: { id: a.id },
             geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
  }) };
}

function saveAreas() {
  store.set("areas", areas);
  map.getSource("areas")?.setData(areasGeoJSON());
}

function mb(tiles) { return Math.max(1, Math.round(tiles * AVG_TILE_KB / 1024)); }

function renderEstimate() {
  if (saving) return;
  const n = tileUrls(viewBounds(), basemap).length;
  const label = BASEMAPS[basemap].label;
  const box = $("save-estimate");
  if (n > SAVE_LIMIT) {
    box.className = "save-estimate warn";
    box.innerHTML = `<strong>Area too large</strong>Zoom in to save. This view needs ${n.toLocaleString()} tiles; the limit is ${SAVE_LIMIT.toLocaleString()}.`;
  } else {
    box.className = "save-estimate";
    box.innerHTML = `<strong>About ${mb(n)} MB</strong>${n.toLocaleString()} ${label} tiles, zoom levels ${SAVE_MIN_Z}–${SAVE_MAX_Z}`;
  }
  $("btn-save").disabled = n > SAVE_LIMIT || !navigator.onLine;
  if (!navigator.onLine) $("btn-save").textContent = "Connect to save";
  else $("btn-save").textContent = "Save this area";
}

function renderOffline() {
  renderEstimate();
  const ul = $("area-list"); ul.replaceChildren();
  $("area-empty").hidden = areas.length > 0;
  for (const a of areas) {
    const li = document.createElement("li");
    const main = document.createElement("button");
    main.className = "area-main";
    main.innerHTML = `<span class="area-name"></span><span class="area-meta"></span>`;
    main.querySelector(".area-name").textContent = a.name;
    main.querySelector(".area-meta").textContent =
      `${BASEMAPS[a.basemap]?.label || a.basemap} · ${a.saved.toLocaleString()} tiles · ~${mb(a.saved)} MB · ${a.date}`;
    main.addEventListener("click", () => {
      closeSheet("sheet-offline");
      stopFollowing();
      map.fitBounds([[a.bounds[0], a.bounds[1]], [a.bounds[2], a.bounds[3]]], { padding: 20 });
    });
    const del = document.createElement("button");
    del.className = "area-del"; del.textContent = "Delete";
    // Two taps to delete: the viewer can't show confirm() dialogs reliably on phones
    del.addEventListener("click", () => {
      if (!del.classList.contains("confirm")) { del.classList.add("confirm"); del.textContent = "Tap to confirm"; return; }
      deleteArea(a.id);
    });
    li.append(main, del);
    ul.append(li);
  }
  storageNote();
}

async function storageNote() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    $("storage-note").textContent = `Using ${Math.round(usage / 1048576)} MB of ${Math.round(quota / 1048576).toLocaleString()} MB available on this device.`;
  } catch { $("storage-note").textContent = ""; }
}

map.on("moveend", () => { if (!$("sheet-offline").hidden) renderEstimate(); });
addEventListener("online", renderEstimate);
addEventListener("offline", renderEstimate);

$("btn-save").addEventListener("click", async () => {
  const bounds = viewBounds(), urls = tileUrls(bounds, basemap);
  if (urls.length > SAVE_LIMIT) return;
  try { await navigator.storage?.persist?.(); } catch {}
  const cache = await caches.open(OFFLINE_CACHE);
  saving = new AbortController();
  $("btn-save").hidden = true; $("btn-cancel").hidden = false;
  $("save-progress").hidden = false;

  let done = 0, failed = 0, next = 0;
  const box = $("save-estimate");
  const update = () => {
    $("save-bar").style.width = `${(done / urls.length) * 100}%`;
    box.className = "save-estimate";
    box.innerHTML = `<strong>Saving… ${Math.round(done / urls.length * 100)}%</strong>${done.toLocaleString()} of ${urls.length.toLocaleString()} tiles`;
  };
  update();
  const worker = async () => {
    while (next < urls.length && !saving.signal.aborted) {
      const url = urls[next++];
      try {
        if (!(await cache.match(url))) {
          const res = await fetch(url, { cache: "no-store", signal: saving.signal });
          if (res.ok) await cache.put(url, res); else failed++;
        }
      } catch { if (!saving.signal.aborted) failed++; }
      done++;
      if (done % 20 === 0 || done === urls.length) update();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const cancelled = saving.signal.aborted;
  saving = null;
  $("btn-save").hidden = false; $("btn-cancel").hidden = true; $("save-progress").hidden = true;
  if (cancelled) { renderOffline(); return; }

  const c = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const hit = hitsAt(c, false)[0];
  areas.unshift({
    id: Date.now().toString(36), bounds, basemap,
    name: hit ? `Near ${hit.layer.title(hit.feature.properties || {})}` : `Area at ${c[1].toFixed(3)}, ${c[0].toFixed(3)}`,
    saved: urls.length - failed,
    date: new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
  });
  saveAreas();
  renderOffline();
  if (failed) {
    box.className = "save-estimate warn";
    box.innerHTML = `<strong>Saved with gaps</strong>${failed.toLocaleString()} tiles didn't download. Save again with a better connection to fill them in.`;
  } else {
    box.className = "save-estimate";
    box.innerHTML = `<strong>Saved</strong>This area's map now works with no signal.`;
  }
});

$("btn-cancel").addEventListener("click", () => saving?.abort());

async function deleteArea(id) {
  const area = areas.find(a => a.id === id);
  areas = areas.filter(a => a.id !== id);
  saveAreas();
  // Keep tiles that another saved area still covers
  const keep = new Set(areas.flatMap(a => tileUrls(a.bounds, a.basemap)));
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all(tileUrls(area.bounds, area.basemap).filter(u => !keep.has(u)).map(u => cache.delete(u)));
  renderOffline();
}

// ---------- Offline shell ----------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  // When a new version (e.g. a weekly data refresh) takes over, reload once to show it
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !saving) location.reload();
  });
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
