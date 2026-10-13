"use strict";
// Go to: a live arrow, distance and walking time to a pin (or a partner),
// from GPS and the phone's compass. Works with no signal. Without a compass
// the arrow is drawn against map north, and turns into a real pointer once
// you're walking (from the GPS course).

const WALK_MPS = 2 * 1609.34 / 3600;   // 2 mph: off-trail, in the woods
let goTarget = store.get("goto", null);   // { name, lng, lat }
let heading = null, headingSrc = "", compassAsked = false, arrived = false;

function startGoto(target) {
  goTarget = { name: target.name || "Pin", lng: target.lng, lat: target.lat };
  store.set("goto", goTarget);
  arrived = false;
  for (const s of document.querySelectorAll(".sheet")) if (!s.hidden) closeSheet(s.id);
  if (watchId == null) $("btn-locate").click(); else refreshWatch();
  startCompass();
  if (lastFix) map.fitBounds(new maplibregl.LngLatBounds(lastFix, lastFix).extend([goTarget.lng, goTarget.lat]),
    { padding: { top: 140, bottom: 200, left: 50, right: 90 }, maxZoom: 17 });
  else map.flyTo({ center: [goTarget.lng, goTarget.lat], zoom: Math.max(map.getZoom(), 15) });
  stopFollowing();
  renderGoto();
}

function stopGoto() {
  goTarget = null; store.set("goto", null);
  map.getSource("goto")?.setData(empty());
  renderGoto();
  refreshWatch();
}

// ---------- Compass ----------
function onOrient(e) {
  let h = null;
  if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;             // iPhone
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;                  // Android
  if (h == null) return;
  heading = (h + (screen.orientation?.angle || 0) + 360) % 360;
  headingSrc = "compass";
  scheduleGoto();
}

async function startCompass() {
  if (compassAsked) return;
  // iPhone asks once, and only from a tap
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    try { if (await DeviceOrientationEvent.requestPermission() !== "granted") return; } catch { return; }
  }
  compassAsked = true;
  addEventListener("deviceorientationabsolute", onOrient);
  addEventListener("deviceorientation", onOrient);
}

// Called from app.js on every GPS fix
function gotoOnFix(pos) {
  const { heading: h, speed } = pos.coords;
  // Walking: the GPS course is a fine pointer when there's no compass
  if (headingSrc !== "compass" && h != null && !isNaN(h) && speed > 0.6) { heading = h; headingSrc = "course"; }
  scheduleGoto();
}

// ---------- Display ----------
function bearingTo(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

let gotoFrame = 0;
function scheduleGoto() {
  if (!goTarget || gotoFrame) return;
  gotoFrame = requestAnimationFrame(() => { gotoFrame = 0; renderGoto(); });
}

function renderGoto() {
  const bar = $("goto-bar");
  bar.hidden = !goTarget;
  document.body.classList.toggle("going", !!goTarget);
  if (!goTarget) return;
  const to = [goTarget.lng, goTarget.lat];
  $("goto-name").textContent = `To ${goTarget.name}`;
  $("btn-goto-compass").hidden = headingSrc === "compass";
  if (!lastFix) {
    $("goto-dist").textContent = "Finding you…";
    $("goto-sub").textContent = "Waiting for GPS";
    $("goto-arrow").style.opacity = 0.3;
    map.getSource("goto")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: to } }] });
    return;
  }
  const d = distMeters(lastFix, to), brg = bearingTo(lastFix, to);
  const close = d <= 15;
  if (close && !arrived) { arrived = true; navigator.vibrate?.([80, 60, 80]); }
  if (d > 40) arrived = false;
  const turn = heading == null ? brg : brg - heading;
  const arrow = $("goto-arrow");
  arrow.style.opacity = 1;
  arrow.style.transform = `rotate(${turn}deg)`;
  arrow.classList.toggle("map-north", heading == null);
  arrow.classList.toggle("here", close);
  const mins = Math.max(1, Math.round(d / (typeof walkMps === "function" ? walkMps() : WALK_MPS) / 60));
  $("goto-dist").textContent = close ? "You're there" : fmtLen(d);
  $("goto-sub").textContent = close ? `Within ${fmtLen(d)}`
    : `${bearing(lastFix, to)} · ${Math.round(brg)}° · ~${mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(1)} hr`} walk` +
      (heading == null ? " · arrow is map-up" : "");
  map.getSource("goto")?.setData({ type: "FeatureCollection", features: [
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [lastFix, to] } },
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: to } }] });
}

document.addEventListener("land-ready", () => {
  map.addSource("goto", { type: "geojson", data: empty() });
  map.addLayer({ id: "goto-line", type: "line", source: "goto", filter: ["==", "$type", "LineString"],
                 layout: { "line-cap": "round" }, paint: { "line-color": "#ff6a13", "line-width": 3, "line-dasharray": [1, 1.6] } });
  map.addLayer({ id: "goto-pt", type: "circle", source: "goto", filter: ["==", "$type", "Point"],
                 paint: { "circle-radius": 12, "circle-color": "rgba(255,106,19,.2)", "circle-stroke-color": "#ff6a13", "circle-stroke-width": 3 } });
  if (goTarget) renderGoto();
});

$("btn-goto-stop").addEventListener("click", stopGoto);
$("btn-goto-compass").addEventListener("click", () => { compassAsked = false; startCompass(); });
$("btn-pin-goto").addEventListener("click", () => {
  const p = editing;
  if (!p) return;
  closePinEditor();
  startGoto({ name: p.name || PIN_TYPES[p.type]?.label, lng: p.lng, lat: p.lat });
});
renderGoto();
