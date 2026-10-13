"use strict";
// Weather radar: the NWS composite (NEXRAD base reflectivity) from Iowa State's
// mesonet tile mirror, refreshed every 5 minutes. "Play" loops the last 50
// minutes so you can see which way the rain is moving. Needs a signal.

const RADAR_URL = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913";
const RADAR_TIME = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json";
const RADAR_AGO = [50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];   // minutes before the latest scan
const RADAR_OPACITY = 0.65;
let radarOn = store.get("radar:on", false);
let radarValid = null, radarTimer = null, radarPlay = null, radarFrame = RADAR_AGO.length - 1;

const radarId = ago => `radar-${ago}`;
const radarTiles = ago => [`${RADAR_URL}${ago ? `-m${String(ago).padStart(2, "0")}m` : ""}/{z}/{x}/{y}.png?v=${radarValid ? +radarValid : 0}`];

// Layers are added on first use: the latest scan always, the older ones when playing
function radarLayer(ago) {
  const id = radarId(ago);
  if (map.getLayer(id)) return;
  map.addSource(id, { type: "raster", tiles: radarTiles(ago), tileSize: 256, maxzoom: 10, attribution: "NWS radar via Iowa Environmental Mesonet" });
  map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-fade-duration": 0 } }, "areas-line");
}

function showFrame(i) {
  radarFrame = i;
  for (const [j, ago] of RADAR_AGO.entries())
    if (map.getLayer(radarId(ago))) map.setPaintProperty(radarId(ago), "raster-opacity", radarOn && j === i ? RADAR_OPACITY : 0);
  renderRadarBar();
}

async function refreshRadar() {
  try {
    const meta = (await (await fetch(RADAR_TIME, { cache: "no-store" })).json()).meta;
    const valid = new Date(meta.valid);
    if (radarValid && +valid === +radarValid) return;
    radarValid = valid;
  } catch { radarValid = radarValid || null; }
  for (const ago of RADAR_AGO) map.getSource(radarId(ago))?.setTiles(radarTiles(ago));
  renderRadarBar();
}

function setRadar(on) {
  radarOn = on; store.set("radar:on", on);
  $("radar-on").checked = on;
  clearInterval(radarTimer); stopRadarPlay();
  if (on) {
    radarLayer(0);
    refreshRadar();
    radarTimer = setInterval(refreshRadar, 5 * 60000);
  }
  showFrame(RADAR_AGO.length - 1);
}

function playRadar() {
  if (radarPlay) return stopRadarPlay();
  RADAR_AGO.forEach(radarLayer);
  let i = 0;
  showFrame(0);
  radarPlay = setInterval(() => {
    i = (i + 1) % (RADAR_AGO.length + 3);   // hold on the latest scan for a moment
    showFrame(Math.min(i, RADAR_AGO.length - 1));
  }, 600);
  renderRadarBar();
}
function stopRadarPlay() {
  clearInterval(radarPlay); radarPlay = null;
  if (map.getLayer(radarId(0))) showFrame(RADAR_AGO.length - 1);
}

const fmtRadar = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function renderRadarBar() {
  const bar = $("radar-bar");
  bar.hidden = !radarOn;
  if (!radarOn) return;
  const ago = RADAR_AGO[radarFrame];
  const t = radarValid ? fmtRadar.format(new Date(+radarValid - ago * 60000)) : "";
  const old = radarValid && Date.now() - radarValid > 20 * 60000;
  $("radar-time").textContent = !t ? "Radar\nloading…" : radarPlay ? `Radar\n${t}` : `Radar as of\n${t}${old ? " (old)" : ""}`;
  $("btn-radar-play").textContent = radarPlay ? "Stop" : "Play last hour";
  $("btn-radar-play").setAttribute("aria-pressed", String(!!radarPlay));
}

document.addEventListener("land-ready", () => { if (radarOn) setRadar(true); else renderRadarBar(); });
$("radar-on").checked = radarOn;
$("radar-on").addEventListener("change", e => setRadar(e.target.checked));
$("btn-radar-play").addEventListener("click", playRadar);
$("btn-radar-off").addEventListener("click", () => setRadar(false));
document.addEventListener("visibilitychange", () => { if (radarOn && document.visibilityState === "visible") refreshRadar(); });
