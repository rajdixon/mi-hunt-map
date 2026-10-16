"use strict";
// 3D view: tilts the map and raises the terrain from public elevation tiles
// (Mapzen Terrarium on AWS, built from USGS 3DEP; about 10 m detail in
// Michigan). Off by default; it needs a signal and uses more battery. While
// it's on the map can also be rotated, and a compass appears to snap north.
// With a mouse, buttons tilt and turn it too (right-drag isn't obvious, and is
// awkward on a trackpad).

const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
// Michigan is fairly flat, so hills are raised to make ridges and draws readable
const HILLS = [["Low", 1.5], ["Medium", 2.5], ["High", 4]];
let hills = store.get("hills", 2.5);
let on3d = store.get("3d", false);

function set3d(on, animate = true) {
  on3d = on; store.set("3d", on);
  $("btn-3d").setAttribute("aria-pressed", String(on));
  $("btn-3d").setAttribute("aria-label", on ? "Turn off 3D view" : "3D view");
  $("tilt-pad").hidden = !on;
  if (on) {
    addDem();
    map.setTerrain({ source: "dem", exaggeration: hills });
    map.dragRotate.enable(); map.touchZoomRotate.enableRotation(); map.touchPitch.enable();
    map.easeTo({ pitch: Math.max(map.getPitch(), 65), duration: animate ? 800 : 0 });
  } else {
    map.dragRotate.disable(); map.touchZoomRotate.disableRotation(); map.touchPitch.disable();
    map.easeTo({ pitch: 0, bearing: 0, duration: animate ? 600 : 0 });
    map.once("moveend", () => { if (!on3d) map.setTerrain(null); });
  }
  showCompass();
}

function setHills(v) {
  hills = v; store.set("hills", v);
  if (on3d) map.setTerrain({ source: "dem", exaggeration: v });
  renderHills();
}

function renderHills() {
  const box = $("hills-pick");
  box.replaceChildren(...HILLS.map(([label, v]) => {
    const b = el("button", null, label); b.type = "button"; b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(v === hills));
    b.onclick = () => setHills(v);
    return b;
  }));
}

function showCompass() {
  const b = map.getBearing(), c = $("btn-compass");
  c.hidden = Math.abs(b) < 0.5;
  c.querySelector("svg").style.transform = `rotate(${-b}deg)`;
}

map.touchPitch.disable();
map.on("rotate", showCompass);
$("btn-compass").addEventListener("click", () => map.easeTo({ bearing: 0, duration: 400 }));
$("btn-3d").addEventListener("click", () => set3d(!on3d));
for (const b of document.querySelectorAll("#tilt-pad [data-turn]")) b.addEventListener("click", () =>
  map.easeTo({ bearing: map.getBearing() + +b.dataset.turn, duration: 400 }));
for (const b of document.querySelectorAll("#tilt-pad [data-tilt]")) b.addEventListener("click", () =>
  map.easeTo({ pitch: Math.min(map.getMaxPitch(), Math.max(0, map.getPitch() + +b.dataset.tilt)), duration: 400 }));

// Set up on first use, not on the map's "load": that waits for every tile on
// screen, which on a big screen can take long enough for a tap on 3D to do nothing
function addDem() {
  if (map.getSource("dem")) return;
  map.addSource("dem", { type: "raster-dem", tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: "terrarium",
                         attribution: "Terrain: Mapzen, USGS" });
  map.setSky?.({ "sky-color": "#a9c7e2", "horizon-color": "#e4edf2", "sky-horizon-blend": 0.6, "fog-color": "#dfe7ea" });
}

renderHills();
if (on3d) map.isStyleLoaded() ? set3d(true, false) : map.once("style.load", () => set3d(true, false));
