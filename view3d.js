"use strict";
// 3D view: tilts the map and raises the terrain from public elevation tiles
// (Mapzen Terrarium on AWS, built from USGS 3DEP; about 10 m detail in
// Michigan). Off by default; it needs a signal and uses more battery. While
// it's on the map can also be rotated, and a compass appears to snap north.

const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const EXAGGERATION = 1.5;   // Michigan is flat; a little lift makes ridges readable
let on3d = store.get("3d", false);

function set3d(on, animate = true) {
  on3d = on; store.set("3d", on);
  $("btn-3d").setAttribute("aria-pressed", String(on));
  $("btn-3d").setAttribute("aria-label", on ? "Turn off 3D view" : "3D view");
  if (on) {
    map.setTerrain({ source: "dem", exaggeration: EXAGGERATION });
    map.dragRotate.enable(); map.touchZoomRotate.enableRotation(); map.touchPitch.enable();
    map.easeTo({ pitch: Math.max(map.getPitch(), 60), duration: animate ? 800 : 0 });
  } else {
    map.dragRotate.disable(); map.touchZoomRotate.disableRotation(); map.touchPitch.disable();
    map.easeTo({ pitch: 0, bearing: 0, duration: animate ? 600 : 0 });
    map.once("moveend", () => { if (!on3d) map.setTerrain(null); });
  }
  showCompass();
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

map.on("load", () => {
  map.addSource("dem", { type: "raster-dem", tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: "terrarium",
                         attribution: "Terrain: Mapzen, USGS" });
  map.setSky?.({ "sky-color": "#a9c7e2", "horizon-color": "#e4edf2", "sky-horizon-blend": 0.6, "fog-color": "#dfe7ea" });
  if (on3d) set3d(true, false);
});
