"use strict";
// Draw lines and shapes on the map with a name, color and notes: property
// lines, routes in, drag lines, food plots, bedding areas, sanctuaries.
// Saved like pins, synced to the server and included in backups.

const SHAPE_COLORS = [
  ["#ff6a13", "Orange"], ["#f2c94c", "Yellow"], ["#57c26b", "Green"], ["#a86b32", "Brown"],
  ["#e5534b", "Red"], ["#3d8bff", "Blue"], ["#c13cff", "Purple"], ["#ffffff", "White"],
];
const SHAPE_IDEAS = {
  line: ["Property line", "Route in", "Route out", "Drag line", "Shooting lane", "Fence", "Creek crossing"],
  area: ["Food plot", "Bedding area", "Sanctuary", "Thicket", "Cut / clearcut", "Swamp", "Hunting area"],
};

let shapes = store.get("shapes", []);
let drawing = null;        // { kind: "line" | "area", pts, editId }
let shapeEditing = null;   // shape open in the editor
const shapeLabels = new Map();

function saveShapes() { store.set("shapes", shapes); drawShapes(); }

function shapeLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += distMeters(pts[i - 1], pts[i]);
  return d;
}
function shapeSize(s) {
  return s.kind === "area"
    ? `${fmtArea(areaM2(s.pts))} · ${fmtLen(shapeLength([...s.pts, s.pts[0]]))} around`
    : fmtLen(shapeLength(s.pts));
}
function shapeGeom(s) {
  return s.kind === "area" ? { type: "Polygon", coordinates: [[...s.pts, s.pts[0]]] } : { type: "LineString", coordinates: s.pts };
}
// Where a label sits: middle of a line, centre of an area
function shapeAnchor(s) {
  if (s.kind === "area") {
    const n = s.pts.length;
    return [s.pts.reduce((a, p) => a + p[0], 0) / n, s.pts.reduce((a, p) => a + p[1], 0) / n];
  }
  const half = shapeLength(s.pts) / 2;
  let d = 0;
  for (let i = 1; i < s.pts.length; i++) {
    const seg = distMeters(s.pts[i - 1], s.pts[i]);
    if (d + seg >= half) {
      const k = seg ? (half - d) / seg : 0, a = s.pts[i - 1], b = s.pts[i];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    d += seg;
  }
  return s.pts[0];
}

// ---------- Map ----------
function shapesFC(list, extra = {}) {
  return { type: "FeatureCollection", features: list.filter(s => s.pts?.length >= (s.kind === "area" ? 3 : 2))
    .map(s => ({ type: "Feature", properties: { id: s.id, color: s.color || "#ff6a13", ...extra }, geometry: shapeGeom(s) })) };
}

function drawShapes() {
  map.getSource("shapes")?.setData(shapesFC(shapes));
  for (const m of shapeLabels.values()) m.remove();
  shapeLabels.clear();
  for (const s of shapes) {
    if (!s.name || !s.pts?.length) continue;
    const e = el("div", "shape-label", s.name);
    e.style.setProperty("--shape", s.color || "#ff6a13");
    shapeLabels.set(s.id, new maplibregl.Marker({ element: e, anchor: "center" }).setLngLat(shapeAnchor(s)).addTo(map));
  }
  if (typeof drawPartnerShapes === "function") drawPartnerShapes();
}

function drawDraft() {
  const src = map.getSource("draw");
  if (!src) return;
  if (!drawing) { src.setData(empty()); return; }
  const p = drawing.pts, f = [];
  if (drawing.kind === "area" && p.length >= 3) f.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...p, p[0]]] } });
  if (p.length >= 2) f.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: drawing.kind === "area" && p.length >= 3 ? [...p, p[0]] : p } });
  for (const c of p) f.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } });
  src.setData({ type: "FeatureCollection", features: f });
}

document.addEventListener("land-ready", () => {
  map.addSource("shapes", { type: "geojson", data: empty() });
  map.addLayer({ id: "shapes-fill", type: "fill", source: "shapes", filter: ["==", "$type", "Polygon"],
                 paint: { "fill-color": ["get", "color"], "fill-opacity": 0.2 } }, "sel-line");
  map.addLayer({ id: "shapes-casing", type: "line", source: "shapes", layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": "#000", "line-opacity": 0.35, "line-width": 5 } }, "sel-line");
  map.addLayer({ id: "shapes-line", type: "line", source: "shapes", layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": ["get", "color"], "line-width": 3 } }, "sel-line");
  map.addSource("draw", { type: "geojson", data: empty() });
  map.addLayer({ id: "draw-fill", type: "fill", source: "draw", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#ff6a13", "fill-opacity": 0.15 } });
  map.addLayer({ id: "draw-casing", type: "line", source: "draw", filter: ["==", "$type", "LineString"],
                 layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-opacity": 0.4, "line-width": 6 } });
  map.addLayer({ id: "draw-line", type: "line", source: "draw", filter: ["==", "$type", "LineString"],
                 layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ff6a13", "line-width": 3, "line-dasharray": [2, 1] } });
  map.addLayer({ id: "draw-pt", type: "circle", source: "draw", filter: ["==", "$type", "Point"],
                 paint: { "circle-radius": 5, "circle-color": "#ff6a13", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  drawShapes();
});
// Labels only once zoomed in enough to read them
const labelZoom = () => document.body.classList.toggle("shape-labels", map.getZoom() >= 13);
map.on("zoomend", labelZoom); labelZoom();

// For the tap handler in app.js: your shapes under a tap (lines get a finger-sized target)
function shapeAt(point) {
  if (!map.getLayer("shapes-line")) return null;
  const f = map.queryRenderedFeatures([[point.x - 10, point.y - 10], [point.x + 10, point.y + 10]], { layers: ["shapes-line"] })[0]
         || map.queryRenderedFeatures(point, { layers: ["shapes-fill"] })[0];
  return f ? shapes.find(s => s.id === f.properties.id) : null;
}

// ---------- Drawing ----------
function startDrawing(kind = "line", from = null) {
  if (typeof measure !== "undefined" && measure) stopMeasure();
  for (const s of document.querySelectorAll(".sheet")) if (!s.hidden) closeSheet(s.id);
  drawing = from ? { kind: from.kind, pts: from.pts.map(p => [...p]), editId: from.id } : { kind, pts: [] };
  drawDraft(); renderDrawBar();
}
function stopDrawing() { drawing = null; drawDraft(); renderDrawBar(); }

function drawClick(e) {
  if (!drawing) return false;
  drawAdd([e.lngLat.lng, e.lngLat.lat]);
  return true;
}
function drawAdd(c) { drawing.pts.push(c); drawDraft(); renderDrawBar(); }

function renderDrawBar() {
  const bar = $("draw-bar");
  bar.hidden = !drawing;
  $("btn-draw").setAttribute("aria-pressed", String(!!drawing));
  if (!drawing) return;
  document.querySelectorAll(".draw-mode").forEach(b => b.setAttribute("aria-checked", String(b.dataset.kind === drawing.kind)));
  const p = drawing.pts, need = drawing.kind === "area" ? 3 : 2;
  $("draw-main").textContent = p.length < need ? `Tap ${need - p.length} more point${need - p.length === 1 ? "" : "s"}`
    : drawing.kind === "area" ? fmtArea(areaM2(p)) : fmtLen(shapeLength(p));
  $("draw-sub").textContent = p.length < need
    ? (drawing.kind === "area" ? "Tap around the edge of the area." : "Tap along the line, start to end.")
    : drawing.kind === "area" ? `${fmtLen(shapeLength([...p, p[0]]))} around · tap Done when it's closed` : `${p.length} points · tap Done to name it`;
  $("btn-draw-undo").disabled = !p.length;
  $("btn-draw-done").disabled = p.length < need;
}

$("btn-draw").addEventListener("click", () => drawing ? stopDrawing() : startDrawing());
$("btn-draw-cancel").addEventListener("click", stopDrawing);
$("btn-draw-undo").addEventListener("click", () => { drawing.pts.pop(); drawDraft(); renderDrawBar(); });
document.querySelectorAll(".draw-mode").forEach(b => b.addEventListener("click", () => {
  drawing.kind = b.dataset.kind; drawDraft(); renderDrawBar();
}));
$("btn-draw-done").addEventListener("click", () => {
  const d = drawing;
  stopDrawing();
  const old = d.editId && shapes.find(s => s.id === d.editId);
  if (old) {
    shapes = shapes.map(s => s.id === old.id ? { ...s, kind: d.kind, pts: d.pts } : s);
    saveShapes();
    openShapeEditor(shapes.find(s => s.id === old.id));
  } else {
    openShapeEditor({ kind: d.kind, pts: d.pts, name: "", notes: "", color: d.kind === "area" ? "#57c26b" : "#ff6a13" });
  }
});

// ---------- Editor ----------
function openShapeEditor(s) {
  shapeEditing = { ...s };
  const isNew = !s.id;
  $("shape-title").textContent = isNew ? (s.kind === "area" ? "New area" : "New line") : (s.name || (s.kind === "area" ? "Area" : "Line"));
  $("shape-size").textContent = shapeSize(s);
  $("shape-name").value = s.name || "";
  $("shape-name").placeholder = s.kind === "area" ? "e.g. Bedding area" : "e.g. Route in";
  const ideas = $("shape-ideas"); ideas.replaceChildren();
  for (const t of SHAPE_IDEAS[s.kind]) {
    const b = el("button", "idea-chip", t); b.type = "button";
    b.onclick = () => { $("shape-name").value = t; };
    ideas.append(b);
  }
  $("shape-notes").value = s.notes || "";
  const colors = $("shape-colors"); colors.replaceChildren();
  for (const [c, label] of SHAPE_COLORS) {
    const b = el("button", "color-chip"); b.type = "button";
    b.style.setProperty("--chip", c);
    b.setAttribute("aria-label", label); b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(shapeEditing.color === c));
    b.onclick = () => {
      shapeEditing.color = c;
      colors.querySelectorAll(".color-chip").forEach(x => x.setAttribute("aria-checked", String(x === b)));
    };
    colors.append(b);
  }
  for (const id of ["btn-shape-redraw", "btn-shape-delete"]) $(id).hidden = isNew;
  const del = $("btn-shape-delete"); del.classList.remove("confirm"); del.textContent = "Delete";
  if (typeof renderShareToggle === "function") renderShareToggle("shape-share", shapeEditing, "shape");
  // Show the draft while naming a new one
  if (isNew) { map.getSource("draw")?.setData(shapesFC([{ ...s, id: "draft" }])); }
  openSheet("sheet-shape");
}

function closeShapeEditor() {
  shapeEditing = null;
  map.getSource("draw")?.setData(empty());
  closeSheet("sheet-shape");
}

$("shape-form").addEventListener("submit", e => {
  e.preventDefault();
  const s = { ...shapeEditing, name: $("shape-name").value.trim(), notes: $("shape-notes").value.trim() };
  const sh = typeof readShareToggle === "function" ? readShareToggle("shape-share", "shape") : undefined;
  if (sh) Object.assign(s, sh);
  if (s.id) shapes = shapes.map(x => x.id === s.id ? s : x);
  else shapes.push({ ...s, id: newId(), created: Date.now() });
  saveShapes();
  closeShapeEditor();
});
$("btn-shape-cancel").addEventListener("click", closeShapeEditor);
document.querySelector('[data-close="sheet-shape"]').addEventListener("click", closeShapeEditor);
$("btn-shape-redraw").addEventListener("click", () => { const s = shapeEditing; closeShapeEditor(); startDrawing(s.kind, s); });
$("btn-shape-delete").addEventListener("click", () => {
  const b = $("btn-shape-delete");
  if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Tap again to delete"; return; }
  shapes = shapes.filter(s => s.id !== shapeEditing.id);
  saveShapes();
  closeShapeEditor();
});

// ---------- List (in the Pins sheet) ----------
function renderShapeList() {
  const ul = $("shape-list"); ul.replaceChildren();
  $("shape-empty").hidden = shapes.length > 0;
  for (const s of [...shapes].sort((a, b) => (b.updated || b.created) - (a.updated || a.created))) {
    const li = el("li");
    const b = el("button", "pin-row");
    const sw = el("span", `shape-swatch ${s.kind}`); sw.style.setProperty("--shape", s.color || "#ff6a13");
    const text = el("span", "pin-row-text");
    text.append(el("span", "pin-row-name", s.name || (s.kind === "area" ? "Area" : "Line")),
                el("span", "pin-row-meta", (s.kind === "area" ? "Area · " : "Line · ") + shapeSize(s)));
    if (s.notes) text.append(el("span", "pin-row-meta", s.notes));
    b.append(sw, text);
    b.onclick = () => {
      stopFollowing();
      const bb = s.pts.reduce((x, p) => x.extend(p), new maplibregl.LngLatBounds(s.pts[0], s.pts[0]));
      map.fitBounds(bb, { padding: 60, maxZoom: 17 });
      openShapeEditor(s);
    };
    li.append(b);
    ul.append(li);
  }
}
$("btn-pins").addEventListener("click", renderShapeList);
$("btn-draw-new").addEventListener("click", () => startDrawing());
