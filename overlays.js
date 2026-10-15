"use strict";
// DNR reference overlays. Most are too big to ship with the app, so they're
// queried from the DNR's ArcGIS services for the area on screen once you're
// zoomed in far enough. DMU boundaries use the copy already in data/.

const DNR = "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services";
const TRAILS = "https://utility.arcgis.com/usrsvcs/servers/860ad7121ae043418c66abb32bb01e96/rest/services/DNR/DNRTrailsOPENDATA/FeatureServer";

// Cover types grouped into a few colors a hunter can read at a glance
const STAND_GROUPS = [
  ["Aspen & birch", "#d9e05a", ["Aspen", "Lowland Aspen/Balsam Poplar", "Paper Birch"]],
  ["Oak", "#c8873a", ["Oak"]],
  ["Hardwoods", "#86b85c", ["Northern Hardwood", "Mixed Upland Deciduous", "Lowland Deciduous", "Upland Mixed Forest"]],
  ["Pine & upland conifer", "#2f6b3a", ["Red Pine", "Jack Pine", "White Pine", "Natural Mixed Pines", "Planted Mixed Pines",
                                         "Upland Conifers", "Upland Spruce/Fir", "Hemlock"]],
  ["Swamp conifer", "#3f8f86", ["Lowland Conifers", "Cedar", "Lowland Spruce/Fir", "Tamarack", "Treed Bog", "Lowland Mixed Forest"]],
  ["Openings & brush", "#e6cf8c", ["Herbaceous Openland", "Upland Shrub", "Low-Density Trees", "Cropland",
                                    "Bare/Sparsely Vegetated", "Sand, Soil", "Exposed Rock"]],
  ["Marsh & bog", "#86afc9", ["Lowland Shrub", "Marsh", "Bog"]],
  ["Water", "#4a8fd9", ["Water", "Water(OI)"]],
];
const standColor = ["match", ["get", "CoverType"], ...STAND_GROUPS.flatMap(([, c, types]) => [types, c]), "#9a9a9a"];
const COVER_OTHER = ["Other & unclassified", "#9a9a9a"];

// Which cover groups to show (Layers, under the stand overlay): null for all,
// else group names. "Only oak" shows just the oak stands.
let coverOn = store.get("cover", null);
const coverShown = name => !coverOn || coverOn.includes(name);
function coverFilter() {
  if (!coverOn) return null;
  const cover = ["coalesce", ["get", "CoverType"], ""];
  const picked = STAND_GROUPS.filter(([n]) => coverShown(n)).flatMap(([, , t]) => t);
  const known = STAND_GROUPS.flatMap(([, , t]) => t);
  return ["any", ["in", cover, ["literal", picked]], ...(coverShown(COVER_OTHER[0]) ? [["!", ["in", cover, ["literal", known]]]] : [])];
}
function setCover(list) {
  const all = [...STAND_GROUPS.map(([n]) => n), COVER_OTHER[0]];
  coverOn = list && all.every(n => list.includes(n)) ? null : list;
  store.set("cover", coverOn);
  const stands = OVERLAYS.find(o => o.id === "stands");
  for (const id of overlayLayerIds(stands)) if (map.getLayer(id)) map.setFilter(id, coverFilter());
  renderCoverPick();
}
function renderCoverPick() {
  const box = $("cover-pick");
  if (!box) return;
  const rows = [...STAND_GROUPS.map(([n, c]) => [n, c]), COVER_OTHER];
  const all = rows.map(([n]) => n);
  const head = el("div", "cover-head");
  head.append(el("span", null, coverOn ? `Showing ${coverOn.length} of ${rows.length}` : "Showing all cover types"));
  const btn = (text, fn) => { const b = el("button", "cover-btn", text); b.type = "button"; b.onclick = fn; return b; };
  head.append(btn("All", () => setCover(null)), btn("None", () => setCover([])));
  const ul = el("ul", "cover-list");
  for (const [n, c] of rows) {
    const li = el("li"), label = el("label");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = coverShown(n);
    cb.onchange = () => setCover(cb.checked ? [...(coverOn || all), n] : all.filter(x => coverShown(x) && x !== n));
    const sw = el("span", "cover-swatch"); sw.style.background = c;
    label.append(cb, sw, el("span", null, n));
    li.append(label, btn("Only", () => setCover([n])));
    ul.append(li);
  }
  box.replaceChildren(head, ul);
}

const ROAD_TYPES = { 0: "Primary forest road", 1: "Secondary forest road", 2: "Forest access route", 3: "Administrative access only", 4: "Non-DNR road" };
const SURFACES = { 0: "Paved", 1: "Gravel", 2: "Dirt" };

function plss(geo) {
  const m = /^(\d+)([NS])(\d+)([EW])(\d+)?$/.exec(geo || "");
  if (!m) return geo;
  return `T${+m[1]}${m[2]} R${+m[3]}${m[4]}` + (m[5] ? ` Sec. ${+m[5]}` : "");
}

const OVERLAYS = [
  { id: "stands", name: "Forest stand cover type", note: "State forest stands: aspen, oak, pine… Pick which to show", minzoom: 13,
    url: `${DNR}/MiHuntStandSymbologyFRDPublic/FeatureServer/0`,
    fields: ["CoverType", "OverallSize", "DominantAge", "CanopyClosure", "Date"],
    layers: [
      { type: "fill", paint: { "fill-color": standColor, "fill-opacity": 0.45 } },
      { type: "line", paint: { "line-color": standColor, "line-width": 1 } }],
    info: p => ({ kind: "Forest stand", title: p.CoverType || "Unclassified stand",
      rows: [["Size class", p.OverallSize], ["Age", p.DominantAge && `${p.DominantAge} years`],
             ["Canopy", p.CanopyClosure && `${p.CanopyClosure}%`], ["Inventoried", p.Date]] }) },

  { id: "roads", name: "DNR roads", note: "Forest roads, two-tracks, ORV status", minzoom: 11,
    url: `${DNR}/DNR_ROADS/FeatureServer/0`, where: "RoadType < 5",
    fields: ["RoadPrimary", "RoadType", "SurfaceType", "RoadORVUse", "RoadOpeningDate", "RoadClosingDate"],
    layers: [
      { type: "line", paint: { "line-color": "#fff", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 2, 16, 6], "line-opacity": 0.7 } },
      { type: "line", filter: ["!=", ["get", "RoadType"], 2],
        paint: { "line-color": ["match", ["get", "RoadType"], 0, "#7a3e12", "#a0581f"],
                 "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 16, 3] } },
      // Forest access routes (two-tracks) dashed
      { type: "line", filter: ["==", ["get", "RoadType"], 2],
        paint: { "line-color": "#b8794a", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 16, 3], "line-dasharray": [2, 1.5] } }],
    info: p => ({ kind: "DNR road", title: p.RoadPrimary || ROAD_TYPES[p.RoadType] || "DNR road",
      rows: [["Type", ROAD_TYPES[p.RoadType]], ["Surface", SURFACES[p.SurfaceType]], ["ORVs", p.RoadORVUse]] }) },

  { id: "trails", name: "DNR trails", note: "Includes hunter walking trails and closures", minzoom: 10, group: "trails",
    url: `${TRAILS}/21`, fields: ["TrailNamePrimary", "Name", "TrailType"],
    layers: [{ type: "line", paint: { "line-color": "#7b4fb8", "line-width": 2, "line-dasharray": [2, 1] } }],
    info: p => ({ kind: "DNR trail", title: p.TrailNamePrimary || p.Name || "Trail", rows: [["Type", p.TrailType]] }) },
  { id: "hwt", group: "trails", minzoom: 10, url: `${TRAILS}/9`, fields: ["*"],
    layers: [{ type: "line", paint: { "line-color": "#ff6a13", "line-width": 2.5, "line-dasharray": [1.5, 1] } }],
    info: p => ({ kind: "Hunter walking trail", title: p.TrailNamePrimary || p.Name || p.TrailName || "Hunter walking trail", rows: [] }) },
  { id: "closures", group: "trails", minzoom: 9, url: `${TRAILS}/0`,
    fields: ["TrailNamePrimary", "PublicComments", "OpenClosedStatusNonmotor", "OpenClosedStatusORV"],
    layers: [{ type: "line", paint: { "line-color": "#e5534b", "line-width": 4, "line-opacity": 0.85 } }],
    info: p => ({ kind: "Temporary trail closure", title: p.TrailNamePrimary || "Trail closure",
      rows: [["Foot/bike", p.OpenClosedStatusNonmotor], ["ORV", p.OpenClosedStatusORV], ["Details", p.PublicComments]] }) },

  { id: "parking", name: "DNR parking", note: "Parking lots on DNR land", minzoom: 10,
    url: `${DNR}/DNRReferenceAssetsOPENDATA/FeatureServer/6`, fields: ["DESCRIP", "SURFMATERIAL", "COMMENTS"],
    layers: [{ type: "circle", paint: { "circle-radius": 6, "circle-color": "#1f5fbf", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } }],
    info: p => ({ kind: "DNR parking", title: p.DESCRIP || "Parking lot", rows: [["Surface", p.SURFMATERIAL], ["Notes", p.COMMENTS]] }) },

  { id: "sections", name: "Sections & townships", note: "Public Land Survey lines", minzoom: 12, group: "plss",
    url: `${DNR}/DNRPublicLandSurveySystemOPENDATA/FeatureServer/1`, fields: ["GeoID"],
    layers: [
      { type: "fill", paint: { "fill-color": "#000", "fill-opacity": 0 } },
      { type: "line", paint: { "line-color": "#3b3b3b", "line-width": 0.8, "line-opacity": 0.7 } }],
    info: p => ({ kind: "Section", title: plss(p.GeoID), rows: [] }) },
  { id: "townships", group: "plss", minzoom: 8,
    url: `${DNR}/DNRPublicLandSurveySystemOPENDATA/FeatureServer/3`, fields: ["GeoID"],
    layers: [{ type: "line", paint: { "line-color": "#1d1d1d", "line-width": 1.6, "line-opacity": 0.7 } }],
    info: null },

  // Private land owners from county tax parcels, where the county publishes
  // them openly. One toggle for all counties; each county is its own source.
  { id: "parcels-kzoo", name: "Private land owners", group: "parcels", minzoom: 14,
    note: "Tax parcels with owner names: Kalamazoo County so far",
    url: "https://services3.arcgis.com/RGltUbqpl4h9E3Qh/arcgis/rest/services/Parcels_2025_view/FeatureServer/11",
    fields: ["PELNUMBER", "ONERNAME1", "ONERNAME2", "PCOMBINED", "PRTYCLSTXT", "Acres", "GOVUNIT", "BSAlink"],
    layers: [
      { type: "fill", paint: { "fill-color": "#f2c14e", "fill-opacity": 0.06 } },
      { type: "line", paint: { "line-color": "#f2c14e", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 18, 2] } }],
    info: p => ({ kind: "Private parcel · Kalamazoo County 2025", title: [p.ONERNAME1, p.ONERNAME2].filter(Boolean).join(" / ") || "Owner not listed",
      rows: [["Acres", p.Acres], ["Address", p.PCOMBINED], ["Class", p.PRTYCLSTXT], ["Township", p.GOVUNIT], ["Parcel", p.PELNUMBER],
             ["Tax record", p.BSAlink && linkEl("Open in BS&A", p.BSAlink)]] }) },

  { id: "landlocked", name: "Possibly landlocked public land", note: "Public land no public road touches; often less hunting pressure",
    minzoom: 0, local: "data/landlocked.geojson",
    layers: [
      { type: "fill", paint: { "fill-color": "#e5534b", "fill-opacity": 0.28 } },
      { type: "line", paint: { "line-color": "#e5534b", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 14, 3] } }],
    info: p => ({ kind: "Possibly landlocked public land", title: p.unit ? `${p.unit} (${p.kind})` : p.kind,
      rows: [["Acres", p.acres],
             ["Why", "No public road touches this piece, or the State Forest, Commercial Forest or HAP land around it."],
             ["Getting in", "You may be able to reach it by water, a DNR trail, an easement, or with a landowner's permission to cross. Crossing private land without permission is trespassing."]] }) },

  { id: "dmus", name: "Deer management units", note: "2026 DMU boundaries", minzoom: 0, local: "data/dmu.geojson",
    layers: [
      { type: "fill", paint: { "fill-color": "#000", "fill-opacity": 0 } },
      { type: "line", paint: { "line-color": "#d62f8a", "line-width": 2, "line-dasharray": [3, 2] } }],
    info: p => ({ kind: "Deer management unit", title: `DMU ${p.DeerManagementUnit}`, rows: [["Name", p.MangementUnitName]] }) },
];

// One toggle per group (trails, sections): the first overlay of a group carries its name
const groupOf = o => o.group || o.id;
const overlayOn = store.get("overlays", {});
const loaded = {};   // id -> { bbox, zoom } covered by the current data
const inflight = {};

function overlayLayerIds(o) { return o.layers.map((_, i) => `ov-${o.id}-${i}`); }

document.addEventListener("land-ready", () => {
  for (const o of OVERLAYS) {
    map.addSource(`ov-${o.id}`, { type: "geojson", data: empty(), tolerance: 0.4 });
    o.layers.forEach((l, i) => map.addLayer({
      id: `ov-${o.id}-${i}`, source: `ov-${o.id}`, type: l.type, paint: l.paint, ...(l.filter ? { filter: l.filter } : {}),
      layout: { visibility: overlayOn[groupOf(o)] ? "visible" : "none", ...(l.type === "line" ? { "line-cap": "round" } : {}) },
    }, "areas-line"));
  }
  setCover(coverOn);
  buildOverlayList();
  refreshOverlays();
});

map.on("moveend", () => refreshOverlays());

function buildOverlayList() {
  const ul = $("overlay-list"); ul.replaceChildren();
  for (const o of OVERLAYS.filter(o => o.name)) {
    const g = groupOf(o);
    const li = document.createElement("li");
    li.innerHTML = `<label for="ov-${g}"><input type="checkbox" id="ov-${g}">
      <span><span class="layer-name"></span><span class="layer-note"></span></span></label>`;
    li.querySelector(".layer-name").textContent = o.name;
    li.querySelector(".layer-note").textContent = o.note;
    li.querySelector(".layer-note").dataset.group = g;
    const cb = li.querySelector("input");
    cb.checked = !!overlayOn[g];
    cb.addEventListener("change", () => {
      overlayOn[g] = cb.checked; store.set("overlays", overlayOn);
      for (const x of OVERLAYS.filter(x => groupOf(x) === g))
        for (const id of overlayLayerIds(x)) map.setLayoutProperty(id, "visibility", cb.checked ? "visible" : "none");
      refreshOverlays();
      if (o.id === "stands") $("cover-pick").hidden = !cb.checked;
    });
    if (o.id === "stands") {
      const pick = el("div", "cover-pick"); pick.id = "cover-pick"; pick.hidden = !cb.checked;
      li.append(pick);
    }
    ul.append(li);
  }
  renderCoverPick();
  updateZoomHints();
}

function updateZoomHints() {
  const z = map.getZoom();
  document.querySelectorAll("#overlay-list .layer-note").forEach(n => {
    const o = OVERLAYS.find(x => x.name && groupOf(x) === n.dataset.group);
    const need = Math.min(...OVERLAYS.filter(x => groupOf(x) === n.dataset.group).map(x => x.minzoom));
    n.replaceChildren(o.note);
    if (overlayOn[n.dataset.group] && z < need) {
      const s = document.createElement("span"); s.className = "zoom-hint"; s.textContent = " · Zoom in to see";
      n.append(s);
    }
  });
}

async function refreshOverlays() {
  updateZoomHints();
  const z = map.getZoom(), b = map.getBounds();
  // Fetch a margin around the view so small pans don't refetch
  const dx = (b.getEast() - b.getWest()) * 0.25, dy = (b.getNorth() - b.getSouth()) * 0.25;
  const want = [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  for (const o of OVERLAYS) {
    if (!overlayOn[groupOf(o)]) continue;
    const src = map.getSource(`ov-${o.id}`);
    if (o.local) {
      if (!loaded[o.id]) { loaded[o.id] = true; fetch(o.local).then(r => r.json()).then(fc => src.setData(fc)).catch(() => {}); }
      continue;
    }
    if (z < o.minzoom) { if (loaded[o.id]) { src.setData(empty()); loaded[o.id] = null; } continue; }
    const have = loaded[o.id];
    // Reuse data if it covers the view and was fetched at similar detail
    if (have && contains(have.bbox, view) && Math.abs(have.zoom - z) < 2) continue;
    inflight[o.id]?.abort();
    const ctrl = inflight[o.id] = new AbortController();
    try {
      const fc = await queryLayer(o, want, z, ctrl.signal);
      if (ctrl.signal.aborted) continue;
      src.setData(fc);
      loaded[o.id] = { bbox: want, zoom: z };
    } catch (e) {
      if (e.name !== "AbortError") console.warn(`Overlay ${o.id} failed`, e);
    }
  }
}

function linkEl(text, href) {
  const a = document.createElement("a");
  a.textContent = text; a.href = href; a.target = "_blank"; a.rel = "noopener";
  return a;
}

function contains(a, b) { return a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3]; }

async function queryLayer(o, bbox, z, signal) {
  const params = {
    where: o.where || "1=1", outFields: o.fields.join(","), f: "geojson", outSR: 4326,
    geometry: bbox.map(v => v.toFixed(5)).join(","), geometryType: "esriGeometryEnvelope", inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
    // Simplify to about one screen pixel at this zoom
    maxAllowableOffset: (360 / (256 * 2 ** z)).toPrecision(2), geometryPrecision: 6,
  };
  const features = [];
  for (let page = 0, offset = 0; page < 8; page++) {
    const body = new URLSearchParams({ ...params, resultOffset: offset });
    const res = await fetch(`${o.url}/query`, { method: "POST", body, signal });
    const fc = await res.json();
    if (fc.error) throw new Error(fc.error.message);
    features.push(...fc.features);
    if (!fc.properties?.exceededTransferLimit && !fc.exceededTransferLimit) break;
    offset += fc.features.length;
  }
  return { type: "FeatureCollection", features };
}

// For the tap handler in app.js
function overlayHitsAt(point) {
  const ids = OVERLAYS.filter(o => o.info && overlayOn[groupOf(o)]).flatMap(overlayLayerIds).filter(id => map.getLayer(id));
  if (!ids.length) return [];
  const feats = map.queryRenderedFeatures([[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]], { layers: ids });
  // One entry per overlay, in list order (stand before road before section...)
  const first = new Map();
  for (const f of feats) {
    const o = OVERLAYS.find(x => f.layer.id.startsWith(`ov-${x.id}-`));
    if (!first.has(o)) first.set(o, f);
  }
  return OVERLAYS.filter(o => first.has(o)).map(o => o.info(first.get(o).properties || {}));
}
