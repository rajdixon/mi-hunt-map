"use strict";
// Search: coordinates, your pins, public land by name, counties, DMUs,
// township/range/section, and (with a signal) towns and places.

let searchIndex = null;
let searchMarker = null;

function unionBbox(a, b) { return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : [...b]; }

function buildIndex() {
  const groups = new Map();
  const add = (label, kind, bbox) => {
    const key = kind + "|" + label;
    const g = groups.get(key);
    if (g) g.bbox = unionBbox(g.bbox, bbox);
    else groups.set(key, { label, kind, bbox: [...bbox] });
  };
  for (const l of LAYERS) {
    for (const f of data[l.id]?.features || []) {
      const p = f.properties || {};
      const name = l.id === "hap" ? `HAP site ${p.HAPID} (${p.COUNTY} County)` : l.title(p);
      if (name && !/^(State Forest|National Forest land|Commercial Forest land|State Park land)$/.test(name)) add(name, l.name, f.bbox);
    }
  }
  for (const f of rules.counties?.features || []) add(`${f.properties.Name} County`, "County", f.bbox);
  for (const f of rules.dmus?.features || []) add(`DMU ${f.properties.DeerManagementUnit} · ${f.properties.MangementUnitName.replace(/^DMU-\d+\s*/, "")}`, "Deer management unit", f.bbox);
  searchIndex = [...groups.values()];
}

// "44.661, -84.713", "44.661 84.713", "N44 39.66 W84 42.78", "44°39'40\"N 84°42'47\"W"
function parseCoords(q) {
  const nums = q.replace(/[°'"′″,]/g, " ").replace(/([NSEWnsew])/g, " $1 ").trim().split(/\s+/);
  const parts = [];
  let cur = { v: [], hemi: null };
  for (const t of nums) {
    if (/^[NSEW]$/i.test(t)) {
      const h = t.toUpperCase();
      if (!cur.v.length) cur.hemi = h;                                                  // prefix: N44 ...
      else if (cur.hemi) { parts.push(cur); cur = { v: [], hemi: h }; }                 // next prefixed value
      else { cur.hemi = h; parts.push(cur); cur = { v: [], hemi: null }; }              // suffix: 44 39 N
    } else if (/^-?\d+(\.\d+)?$/.test(t)) cur.v.push(+t);
    else return null;
  }
  if (cur.v.length) parts.push(cur);
  let a, b;
  if (parts.length === 2) [a, b] = parts;
  else if (parts.length === 1 && parts[0].v.length % 2 === 0) {
    const h = parts[0].v.length / 2;
    a = { v: parts[0].v.slice(0, h) }; b = { v: parts[0].v.slice(h) };
  } else return null;
  const dec = ({ v, hemi }) => {
    if (!v.length || v.length > 3) return NaN;
    const sign = v[0] < 0 || hemi === "S" || hemi === "W" ? -1 : 1;
    return sign * (Math.abs(v[0]) + (v[1] || 0) / 60 + (v[2] || 0) / 3600);
  };
  let lat = dec(a), lng = dec(b);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (Math.abs(lat) > 60 && Math.abs(lng) < 60) [lat, lng] = [lng, lat];
  if (lng > 0 && lng >= 82 && lng <= 91) lng = -lng;   // Michigan is west longitude
  if (lat < 41 || lat > 49 || lng < -93 || lng > -80) return null;
  return [lng, lat];
}

// "T29N R2W S23", "29N 2W 23", "T29N R2W"
function parsePlss(q) {
  const m = /^\s*T?\s*(\d{1,2})\s*([NS])[\s,]*R?\s*(\d{1,2})\s*([EW])(?:[\s,]*(?:S(?:EC(?:TION)?)?\.?)?\s*(\d{1,2}))?\s*$/i.exec(q);
  if (!m) return null;
  const pad = n => String(+n).padStart(2, "0");
  const tr = `${pad(m[1])}${m[2].toUpperCase()}${pad(m[3])}${m[4].toUpperCase()}`;
  return m[5] ? { geo: tr + pad(m[5]), layer: 1, label: `T${+m[1]}${m[2].toUpperCase()} R${+m[3]}${m[4].toUpperCase()} Sec. ${+m[5]}` }
              : { geo: tr, layer: 3, label: `T${+m[1]}${m[2].toUpperCase()} R${+m[3]}${m[4].toUpperCase()}` };
}

function localResults(q) {
  const out = [];
  const c = parseCoords(q);
  if (c) out.push({ label: `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`, kind: "Coordinates", point: c });
  const plssQ = parsePlss(q);
  if (plssQ) out.push({ label: plssQ.label, kind: "Township / section", plss: plssQ });
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || c) return out;
  const match = s => { const l = s.toLowerCase(); return words.every(w => l.includes(w)); };
  for (const p of pins) if (match(p.name || "")) out.push({ label: p.name, kind: `My pin · ${PIN_TYPES[p.type]?.label || "Pin"}`, point: [p.lng, p.lat], pin: p });
  if (!searchIndex) buildIndex();
  const hits = searchIndex.filter(x => match(x.label));
  // Names that start with the query first
  hits.sort((a, b) => (+!a.label.toLowerCase().startsWith(words[0])) - (+!b.label.toLowerCase().startsWith(words[0])) || a.label.localeCompare(b.label));
  out.push(...hits.slice(0, 25));
  return out;
}

function renderResults(list, note) {
  const ul = $("search-results"); ul.replaceChildren();
  for (const r of list) {
    const li = el("li");
    const b = el("button", "search-row");
    b.append(el("span", "search-label", r.label), el("span", "search-kind", r.kind));
    b.addEventListener("click", () => goTo(r));
    li.append(b);
    ul.append(li);
  }
  $("search-note").textContent = note ?? (list.length ? "" : "No matches on the map. Press Search to look up towns and places.");
}

async function goTo(r) {
  searchMarker?.remove(); searchMarker = null;
  stopFollowing();
  closeSheet("sheet-search");
  if (r.pin) { map.flyTo({ center: r.point, zoom: Math.max(map.getZoom(), 15) }); openPinEditor(r.pin); return; }
  if (r.plss) {
    try {
      const url = `${DNR}/DNRPublicLandSurveySystemOPENDATA/FeatureServer/${r.plss.layer}/query?` +
        new URLSearchParams({ where: `GeoID='${r.plss.geo}'`, returnExtentOnly: "true", outSR: 4326, f: "json" });
      const e = (await (await fetch(url)).json()).extent;
      if (!e || !isFinite(e.xmin)) throw new Error("not found");
      r = { ...r, bbox: [e.xmin, e.ymin, e.xmax, e.ymax] };
    } catch {
      openSheet("sheet-search");
      $("search-note").textContent = `Couldn't find ${r.plss.label}. Township/section search needs a signal.`;
      return;
    }
  }
  if (r.bbox) {
    map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 40, maxZoom: 15 });
    return;
  }
  map.flyTo({ center: r.point, zoom: Math.max(map.getZoom(), 14) });
  searchMarker = new maplibregl.Marker({ element: el("div", "pin-preview") }).setLngLat(r.point).addTo(map);
}
map.on("click", () => { searchMarker?.remove(); searchMarker = null; });

async function searchPlaces(q) {
  $("search-note").textContent = "Searching places…";
  try {
    const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
      q, format: "jsonv2", countrycodes: "us", viewbox: "-90.5,48.3,-82.1,41.6", bounded: "1", limit: "8" });
    const res = await (await fetch(url)).json();
    const places = res.map(p => ({ label: p.display_name.split(", ").slice(0, 3).join(", "), kind: "Place",
      ...(p.boundingbox && p.type !== "house"
        ? { bbox: [+p.boundingbox[2], +p.boundingbox[0], +p.boundingbox[3], +p.boundingbox[1]] }
        : { point: [+p.lon, +p.lat] }) }));
    renderResults([...localResults(q), ...places], places.length ? "" : "No places found.");
  } catch {
    $("search-note").textContent = "Place search needs a signal. Map names and coordinates still work.";
  }
}

$("btn-search").addEventListener("click", () => {
  openSheet("sheet-search");
  const i = $("search-input");
  i.focus(); i.select();
  if (i.value) renderResults(localResults(i.value));
});
let searchTimer = null;
$("search-input").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => q ? renderResults(localResults(q)) : renderResults([], ""), 120);
});
$("search-form").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("search-input").value.trim();
  if (!q) return;
  const local = localResults(q);
  // Coordinates or a section: go straight there
  if (local[0] && (local[0].kind === "Coordinates" || local[0].plss)) return goTo(local[0]);
  searchPlaces(q);
});
