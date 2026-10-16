"use strict";
// Scent cones: a wedge downwind of each tree stand and ground blind, from the
// forecast wind for the current hour. Flags trail cams, rubs and scrapes that
// sit inside a stand's cone. Calm air shows a small circle (scent pools and swirls).

const SCENT_FROM = ["stand", "blind"];
const SCENT_SIGN = ["cam", "rub", "scrape"];
const SCENT_LEN = 300;       // m (about 330 yd)
const SCENT_HALF = 25;       // degrees either side of straight downwind
const SCENT_CALM = 70;       // m radius when calm
let scentOn = store.get("scent:on", true);

// Point `m` metres from `pt` on compass bearing `deg` (fine at these distances)
function destPoint(pt, deg, m) {
  const r = deg * Math.PI / 180;
  return [pt[0] + m * Math.sin(r) / (111320 * Math.cos(pt[1] * Math.PI / 180)), pt[1] + m * Math.cos(r) / 111320];
}

function bearingDeg(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

const isCalm = p => !p.mph || !p.dir || DIR_DEG[p.dir] == null;

function scentPolygon(pt, p) {
  const ring = [];
  if (isCalm(p)) {
    for (let a = 0; a <= 360; a += 15) ring.push(destPoint(pt, a, SCENT_CALM));
  } else {
    const down = (DIR_DEG[p.dir] + 180) % 360;
    ring.push(pt);
    for (let a = -SCENT_HALF; a <= SCENT_HALF; a += 5) ring.push(destPoint(pt, down + a, SCENT_LEN));
    ring.push(pt);
  }
  return { type: "Polygon", coordinates: [ring] };
}

// Sign pins (cams, rubs, scrapes) inside this stand's scent for forecast hour `p`
function scentHits(stand, p) {
  const pt = [stand.lng, stand.lat];
  const down = isCalm(p) ? null : (DIR_DEG[p.dir] + 180) % 360;
  return pins.filter(x => SCENT_SIGN.includes(x.type)).map(x => {
    const q = [x.lng, x.lat], d = distMeters(pt, q);
    if (down == null) return d <= SCENT_CALM ? { pin: x, d } : null;
    const off = Math.abs(((bearingDeg(pt, q) - down + 540) % 360) - 180);
    return d <= SCENT_LEN && off <= SCENT_HALF ? { pin: x, d } : null;
  }).filter(Boolean).sort((a, b) => a.d - b.d);
}

// { period, hits, text } for one stand right now, or null without a forecast
async function scentInfo(stand) {
  const fc = await getForecast(stand.lng, stand.lat);
  const p = periodAt(fc);
  if (!p) return null;
  const hits = scentHits(stand, p);
  const where = isCalm(p) ? "Calm: scent pools around the stand"
    : `Scent drifts ${DIRS8[Math.round(((DIR_DEG[p.dir] + 180) % 360) / 45) % 8]} on a ${p.dir} wind`;
  const over = hits.length ? `. Over ${hits.map(h => `${h.pin.name || PIN_TYPES[h.pin.type].label} (${fmtDist(h.d)})`).join(", ")}` : "";
  return { period: p, hits, text: where + over + "." };
}

let scentSeq = 0;
async function drawScent() {
  const src = map.getSource("scent");
  if (!src) return;
  const seq = ++scentSeq;
  if (!scentOn) { src.setData(empty()); return; }
  const feats = [];
  for (const s of pins.filter(x => SCENT_FROM.includes(x.type) && (typeof pinVisible !== "function" || pinVisible(x, "me")))) {
    const fc = await getForecast(s.lng, s.lat);
    const p = periodAt(fc);
    if (!p) continue;
    feats.push({ type: "Feature", properties: { hit: scentHits(s, p).length > 0 }, geometry: scentPolygon([s.lng, s.lat], p) });
  }
  if (seq === scentSeq) src.setData({ type: "FeatureCollection", features: feats });
}

document.addEventListener("land-ready", () => {
  map.addSource("scent", { type: "geojson", data: empty() });
  map.addLayer({ id: "scent-fill", type: "fill", source: "scent",
                 paint: { "fill-color": ["case", ["get", "hit"], "#e5534b", "#ffb347"], "fill-opacity": 0.22 } }, "sel-line");
  map.addLayer({ id: "scent-line", type: "line", source: "scent",
                 paint: { "line-color": ["case", ["get", "hit"], "#e5534b", "#ffb347"], "line-width": 1.5, "line-dasharray": [2, 2] } }, "sel-line");
  const cb = $("scent-on");
  cb.checked = scentOn;
  cb.addEventListener("change", () => { scentOn = cb.checked; store.set("scent:on", scentOn); drawScent(); });
  drawScent();
});
// The forecast hour changes; redraw now and then
setInterval(() => scentOn && drawScent(), 10 * 60000);
