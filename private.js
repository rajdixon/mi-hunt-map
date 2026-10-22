"use strict";
// The owner's private map layers. The server only hands these files to the
// owner; what they are (names, notes, legend) comes from the files themselves.
// An "image" layer is a picture laid over the map, with an optional grayscale
// twin whose pixel values are shown on tap; a "points" layer is numbered dots.
// The service worker keeps the last copy, so they work with no signal.

const PRIV = "/api/private/";
let privIndex = null;
const privOn = store.get("priv:on", {});
const privPix = new Map();   // layer id -> { w, h, data } of the values image
const privMarkers = new Map();   // layer id -> [maplibregl.Marker]

async function loadPrivate() {
  if (typeof isOwner !== "function" || !isOwner()) return;
  try {
    const res = await fetch(PRIV + "index.json");
    if (!res.ok) return;
    privIndex = await res.json();
  } catch { return; }
  for (const l of privIndex.layers) {
    if (l.type === "image") {
      map.addSource(`priv-${l.id}`, { type: "image", url: PRIV + l.file, coordinates: l.corners });
      map.addLayer({ id: `priv-${l.id}`, type: "raster", source: `priv-${l.id}`,
                     layout: { visibility: privOn[l.id] ? "visible" : "none" }, paint: { "raster-resampling": "nearest" } }, "areas-line");
      if (l.values) loadValues(l);
    } else if (l.type === "points") {
      const data = await fetch(PRIV + l.file).then(r => r.json()).catch(() => null);
      if (!data) continue;
      privMarkers.set(l.id, data.features.map(f => {
        const b = el("button", "priv-spot", String(f.properties.rank));
        b.style.background = l.color || "#ffd23f";
        b.dataset.title = f.properties.title;
        const [lng, lat] = f.geometry.coordinates;
        b.addEventListener("click", ev => {
          ev.stopPropagation();
          showInfo(null, { lng, lat }, [{ kind: l.kind, title: f.properties.title, rows: f.properties.rows || [] }]);
        });
        return new maplibregl.Marker({ element: b, anchor: "center" }).setLngLat([lng, lat]);
      }));
      if (privOn[l.id]) privMarkers.get(l.id).forEach(showMarker);
    }
  }
  renderPrivateList();
}

function loadValues(l) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
    privPix.set(l.id, { w: img.width, h: img.height, data: g.getImageData(0, 0, img.width, img.height).data });
  };
  img.src = PRIV + l.values;
}

function setPrivate(id, on) {
  privOn[id] = on; store.set("priv:on", privOn);
  if (map.getLayer(`priv-${id}`)) map.setLayoutProperty(`priv-${id}`, "visibility", on ? "visible" : "none");
  for (const m of privMarkers.get(id) || []) on ? showMarker(m) : m.remove();
}

// Adding a Marker resets its label to "Map marker"
function showMarker(m) { m.addTo(map); m.getElement().setAttribute("aria-label", m.getElement().dataset.title); }

// The Layers sheet: a section only the owner sees
function renderPrivateList() {
  const box = $("private-layers");
  if (!privIndex?.layers.length) { box.hidden = true; return; }
  const ul = el("ul", "layer-list overlay-list");
  for (const l of privIndex.layers) {
    const li = el("li"), label = el("label"), cb = el("input");
    cb.type = "checkbox"; cb.id = `priv-${l.id}-cb`; label.htmlFor = cb.id; cb.checked = !!privOn[l.id];
    cb.onchange = () => setPrivate(l.id, cb.checked);
    const text = el("span");
    text.append(el("span", "layer-name", l.name), el("span", "layer-note", l.note));
    label.append(cb, text); li.append(label);
    if (l.legend) {
      const leg = el("div", "priv-legend");
      for (const k of l.legend) {
        const row = el("span", "priv-key");
        const sw = el("i"); sw.style.background = `rgb(${k.color.join(",")})`;
        row.append(sw, k.label); leg.append(row);
      }
      li.append(leg);
    }
    ul.append(li);
  }
  box.replaceChildren(el("h3", "sheet-sub", "Only you"), ul,
    el("p", "fine", "Only your account can see these. They're a guide for where to scout, not a promise."));
  box.hidden = false;
}

// For the tap handler in app.js: what the private layers say at this spot
function privateHitsAt(e) {
  if (!privIndex) return [];
  const out = [];
  for (const l of privIndex.layers) {
    if (!privOn[l.id]) continue;
    if (l.type === "image" && privPix.has(l.id)) {
      const v = pixelAt(l, privPix.get(l.id), e.lngLat);
      if (v == null || v === 255) continue;
      out.push({ kind: l.kind, title: l.none?.[v] || `About ${v} ${l.unit}`, rows: [] });
    }
  }
  return out;
}

// The image is stretched between its corners in Web Mercator, as the map draws it
function pixelAt(l, px, ll) {
  const [[w, n], , [e, s]] = l.corners;
  const merc = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const x = Math.floor((ll.lng - w) / (e - w) * px.w);
  const y = Math.floor((merc(n) - merc(ll.lat)) / (merc(n) - merc(s)) * px.h);
  if (x < 0 || y < 0 || x >= px.w || y >= px.h) return null;
  return px.data[(y * px.w + x) * 4];
}

document.addEventListener("land-ready", loadPrivate);
