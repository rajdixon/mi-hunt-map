"use strict";
// Measure: tap points for distance (and the area they enclose), or drop
// 450 ft rings for Michigan's safety zone around occupied buildings.

const RING_M = 137.16;   // 450 ft
let measure = null;      // { mode: "line" | "ring", pts: [[lng, lat]], rings: [[lng, lat]] }

function circlePolygon(c, m) {
  const ring = [];
  for (let a = 0; a <= 360; a += 6) ring.push(destPoint(c, a, m));
  return { type: "Polygon", coordinates: [ring] };
}

// Area of a lng/lat polygon in square metres (flat projection, fine for a few miles)
function areaM2(pts) {
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length * Math.PI / 180;
  const xy = pts.map(p => [p[0] * 111320 * Math.cos(lat0), p[1] * 111320]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function fmtLen(m) {
  const ft = m * 3.28084;
  return ft < 300 ? `${Math.round(ft)} ft` : fmtDist(m);
}

function drawMeasure() {
  const src = map.getSource("measure");
  if (!src) return;
  if (!measure) { src.setData(empty()); return; }
  const f = [];
  for (const c of measure.rings) {
    f.push({ type: "Feature", properties: { kind: "ring" }, geometry: circlePolygon(c, RING_M) });
    f.push({ type: "Feature", properties: { kind: "pt" }, geometry: { type: "Point", coordinates: c } });
  }
  const p = measure.pts;
  if (p.length >= 3) f.push({ type: "Feature", properties: { kind: "area" }, geometry: { type: "Polygon", coordinates: [[...p, p[0]]] } });
  if (p.length >= 2) f.push({ type: "Feature", properties: { kind: "line" }, geometry: { type: "LineString", coordinates: p } });
  for (const c of p) f.push({ type: "Feature", properties: { kind: "pt" }, geometry: { type: "Point", coordinates: c } });
  src.setData({ type: "FeatureCollection", features: f });
}

function renderMeasureBar() {
  const bar = $("measure-bar");
  bar.hidden = !measure;
  $("btn-measure").setAttribute("aria-pressed", String(!!measure));
  if (!measure) return;
  document.querySelectorAll(".measure-mode").forEach(b => b.setAttribute("aria-checked", String(b.dataset.mode === measure.mode)));
  let main, sub;
  if (measure.mode === "ring") {
    main = measure.rings.length ? `${measure.rings.length} safety ring${measure.rings.length === 1 ? "" : "s"}` : "Tap a building";
    sub = "450 ft safety zone around an occupied building or farm building. No hunting inside, gun or bow, without written permission from the owner or occupant.";
  } else {
    const p = measure.pts;
    let total = 0;
    for (let i = 1; i < p.length; i++) total += distMeters(p[i - 1], p[i]);
    main = p.length < 2 ? "Tap points on the map" : fmtLen(total);
    sub = p.length < 2 ? "Distance between taps, and the area they enclose."
      : p.length === 2 ? `${bearing(p[0], p[1])} · tap more points for area`
      : `Area ${(areaM2(p) / 4046.86).toFixed(areaM2(p) < 40468 ? 2 : 1)} acres · last leg ${fmtLen(distMeters(p.at(-2), p.at(-1)))}`;
  }
  $("measure-main").textContent = main;
  $("measure-sub").textContent = sub;
  $("btn-measure-undo").disabled = !(measure.mode === "ring" ? measure.rings.length : measure.pts.length);
}

// Called first by the map's click handler; true means the tap was used here
function measureClick(e) {
  if (!measure) return false;
  measureAdd([e.lngLat.lng, e.lngLat.lat]);
  return true;
}
// Also used when a pin is tapped while measuring, to measure to it exactly
function measureAdd(c) {
  (measure.mode === "ring" ? measure.rings : measure.pts).push(c);
  drawMeasure(); renderMeasureBar();
}

function startMeasure() {
  for (const s of document.querySelectorAll(".sheet")) if (!s.hidden) closeSheet(s.id);
  measure = { mode: "line", pts: [], rings: [] };
  drawMeasure(); renderMeasureBar();
}
function stopMeasure() { measure = null; drawMeasure(); renderMeasureBar(); }

document.addEventListener("land-ready", () => {
  map.addSource("measure", { type: "geojson", data: empty() });
  const k = v => ["==", ["get", "kind"], v];
  map.addLayer({ id: "measure-fill", type: "fill", source: "measure", filter: ["in", ["get", "kind"], ["literal", ["area", "ring"]]],
                 paint: { "fill-color": ["case", k("ring"), "#e5534b", "#ffffff"], "fill-opacity": 0.18 } });
  map.addLayer({ id: "measure-ring", type: "line", source: "measure", filter: k("ring"),
                 paint: { "line-color": "#e5534b", "line-width": 2 } });
  map.addLayer({ id: "measure-line", type: "line", source: "measure", filter: k("line"),
                 layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": "#fff", "line-width": 3 } });
  map.addLayer({ id: "measure-pt", type: "circle", source: "measure", filter: k("pt"),
                 paint: { "circle-radius": 5, "circle-color": "#ff6a13", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
});

$("btn-measure").addEventListener("click", () => measure ? stopMeasure() : startMeasure());
$("btn-measure-done").addEventListener("click", stopMeasure);
$("btn-measure-undo").addEventListener("click", () => {
  (measure.mode === "ring" ? measure.rings : measure.pts).pop();
  drawMeasure(); renderMeasureBar();
});
document.querySelectorAll(".measure-mode").forEach(b => b.addEventListener("click", () => {
  measure.mode = b.dataset.mode;
  renderMeasureBar();
}));
