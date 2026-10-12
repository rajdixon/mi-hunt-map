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

const BASEMAPS = {
  topo: [{ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
           attr: "Esri, USGS, NOAA" }],
  sat: [{ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          attr: "Esri, Maxar, Earthstar Geographics" },
        { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
          attr: "" },
        { url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          attr: "" }],
};

const store = {
  get(k, d) { try { const v = localStorage.getItem("mhl:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mhl:" + k, JSON.stringify(v)); } catch {} },
};

const $ = id => document.getElementById(id);
const data = {};          // id -> FeatureCollection with per-feature bbox
let basemap = store.get("basemap", "topo");
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
  dragRotate: false, pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");

function setBasemap(name) {
  basemap = name; store.set("basemap", name);
  for (const k of Object.keys(BASEMAPS)) {
    BASEMAPS[k].forEach((_, i) => {
      const id = `bm-${k}-${i}`;
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", k === name ? "visible" : "none");
    });
  }
  document.querySelectorAll("[data-basemap]").forEach(b =>
    b.setAttribute("aria-checked", String(b.dataset.basemap === name)));
  // Fills read better a bit stronger over imagery
  for (const l of LAYERS) if (map.getLayer(l.id + "-fill"))
    map.setPaintProperty(l.id + "-fill", "fill-opacity", name === "sat" ? 0.42 : 0.32);
}

map.on("load", async () => {
  for (const [k, tiles] of Object.entries(BASEMAPS)) {
    tiles.forEach((t, i) => {
      const id = `bm-${k}-${i}`;
      map.addSource(id, { type: "raster", tiles: [t.url], tileSize: 256, maxzoom: 19, attribution: t.attr });
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
});

map.on("moveend", () => {
  const c = map.getCenter();
  store.set("center", [+c.lng.toFixed(4), +c.lat.toFixed(4)]);
  store.set("zoom", +map.getZoom().toFixed(2));
});

// ---------- Tap a parcel ----------
map.on("click", e => {
  const hits = hitsAt([e.lngLat.lng, e.lngLat.lat], true);
  if (!hits.length) { closeSheet("sheet-info"); map.getSource("sel").setData(empty()); return; }
  showInfo(hits[0], e.lngLat);
});

function showInfo({ layer, feature }, lngLat) {
  const p = feature.properties || {};
  $("info-kind").textContent = layer.name;
  $("info-title").textContent = layer.title(p);
  const dl = $("info-rows"); dl.replaceChildren();
  for (const [k, v] of layer.rows(p)) {
    if (v == null || v === "" || (typeof v === "string" && !v.trim())) continue;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd");
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    dl.append(dt, dd);
  }
  $("info-coords").textContent = `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`;
  map.getSource("sel").setData(feature);
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
  watchId = navigator.geolocation.watchPosition(onFix, onFixError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
});

map.on("dragstart", () => { follow = false; });

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

  const hits = hitsAt(lastFix, false);
  if (hits.length) setStatus("in", `On ${hits[0].layer.name}`);
  else setStatus("out", "Not on mapped public land");
  const c = $("coords");
  c.hidden = false;
  c.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(accuracy * 3.281)} ft`;
}

function onFixError(err) {
  const msg = err.code === 1 ? "Location blocked. Allow it in browser settings"
            : err.code === 3 ? "Still looking for GPS…" : "Can't get location";
  setStatus(err.code === 3 ? "wait" : "off", msg);
  if (err.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; $("btn-locate").setAttribute("aria-pressed", "false"); }
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
  document.documentElement.style.setProperty("--sheet-h", docked ? open.offsetHeight + "px" : "0px");
}
function openSheet(id) {
  for (const s of document.querySelectorAll(".sheet")) s.hidden = s.id !== id;
  liftButtons();
}
function closeSheet(id) { $(id).hidden = true; liftButtons(); }

$("btn-layers").addEventListener("click", () =>
  $("sheet-layers").hidden ? openSheet("sheet-layers") : closeSheet("sheet-layers"));
document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", () => {
    closeSheet(b.dataset.close);
    if (b.dataset.close === "sheet-info") map.getSource("sel")?.setData(empty());
  }));
document.querySelectorAll("[data-basemap]").forEach(b =>
  b.addEventListener("click", () => setBasemap(b.dataset.basemap)));

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

// ---------- Offline shell ----------
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
