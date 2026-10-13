"use strict";
// Record your walk in, then follow it back out. Uses the same GPS watch as the
// location button. Phones only give web apps GPS while the app is open on
// screen, so recording keeps the screen awake (where supported).

let tracks = store.get("tracks", []);
let rec = store.get("track:active", null);   // { id, start, points: [[lng, lat, t]] }
let wakeLock = null;
const shownTracks = new Set(store.get("tracks:shown", []));

function saveTracks() { store.set("tracks", tracks); store.set("tracks:shown", [...shownTracks]); }
function saveRec() { store.set("track:active", rec); }

function trackDist(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += distMeters(points[i - 1], points[i]);
  return d;
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
}

// ---------- Map layers ----------
document.addEventListener("land-ready", () => {
  map.addSource("tracks-saved", { type: "geojson", data: empty() });
  map.addLayer({ id: "tracks-saved", type: "line", source: "tracks-saved", layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": "#c13cff", "line-width": 3, "line-opacity": 0.85 } }, "sel-line");
  map.addSource("track-rec", { type: "geojson", data: empty() });
  map.addLayer({ id: "track-back", type: "line", source: "track-rec", filter: ["==", ["get", "kind"], "back"],
                 paint: { "line-color": "#fff", "line-width": 2, "line-dasharray": [1, 2] } }, "sel-line");
  map.addLayer({ id: "track-rec", type: "line", source: "track-rec", filter: ["==", ["get", "kind"], "path"],
                 layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": "#ff6a13", "line-width": 4 } }, "sel-line");
  map.addLayer({ id: "track-start", type: "circle", source: "track-rec", filter: ["==", ["get", "kind"], "start"],
                 paint: { "circle-radius": 8, "circle-color": "#2fa84f", "circle-stroke-color": "#fff", "circle-stroke-width": 3 } }, "sel-line");
  drawSavedTracks();
  drawRec();
  if (rec) resumeRecording();
});

function drawRec() {
  const src = map.getSource("track-rec");
  if (!src) return;
  if (!rec || !rec.points.length) { src.setData(empty()); return; }
  const pts = rec.points.map(p => [p[0], p[1]]);
  const feats = [
    { type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: pts[0] } },
  ];
  if (pts.length > 1) feats.push({ type: "Feature", properties: { kind: "path" }, geometry: { type: "LineString", coordinates: pts } });
  // Straight line from where you are back to the start
  if (lastFix) feats.push({ type: "Feature", properties: { kind: "back" }, geometry: { type: "LineString", coordinates: [lastFix, pts[0]] } });
  src.setData({ type: "FeatureCollection", features: feats });
}

function drawSavedTracks() {
  map.getSource("tracks-saved")?.setData({ type: "FeatureCollection", features: tracks
    .filter(t => shownTracks.has(t.id) && t.points.length > 1)
    .map(t => ({ type: "Feature", properties: { id: t.id }, geometry: { type: "LineString", coordinates: t.points.map(p => [p[0], p[1]]) } })) });
}

// ---------- Recording ----------
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { wakeLock = null; }
}
document.addEventListener("visibilitychange", () => { if (rec && document.visibilityState === "visible") keepAwake(); });

function ensureLocation() {
  if (watchId == null) $("btn-locate").click();
}

function startRecording() {
  rec = { id: newId(), start: Date.now(), points: lastFix ? [[lastFix[0], lastFix[1], Date.now()]] : [] };
  saveRec();
  resumeRecording();
  refreshWatch();
}

function resumeRecording() {
  ensureLocation();
  keepAwake();
  renderRecPill();
  drawRec();
}

// Called by app.js for every GPS fix
function trackOnFix(pos) {
  if (!rec) return;
  const { longitude: lng, latitude: lat, accuracy } = pos.coords;
  if (accuracy > 40) { renderRecPill(); return; }   // too rough to draw a trail with
  const last = rec.points.at(-1);
  if (!last || distMeters(last, [lng, lat]) >= 8) {
    rec.points.push([+lng.toFixed(6), +lat.toFixed(6), Date.now()]);
    saveRec();
  }
  drawRec();
  renderRecPill();
}

function stopRecording() {
  if (!rec) return;
  if (rec.points.length > 1) {
    const c = rec.points[Math.floor(rec.points.length / 2)];
    const hit = hitsAt([c[0], c[1]], false)[0];
    tracks.unshift({
      id: rec.id, start: rec.start, end: Date.now(), points: rec.points, dist: trackDist(rec.points),
      name: `${new Date(rec.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}` +
            (hit ? ` · ${hit.layer.title(hit.feature.properties || {})}` : ""),
    });
    shownTracks.add(rec.id);
    saveTracks();
  }
  rec = null;
  saveRec();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  drawRec();
  drawSavedTracks();
  renderRecPill();
  refreshWatch();
}

function renderRecPill() {
  const pill = $("rec-pill");
  pill.hidden = !rec;
  if (!rec) return;
  const dist = trackDist(rec.points);
  let back = "Waiting for GPS…";
  if (lastFix && rec.points.length) {
    const s = rec.points[0];
    back = `Start ${fmtDist(distMeters(lastFix, s))} ${bearing(lastFix, s)}`;
  }
  $("rec-main").textContent = `${fmtTrip(dist)} · ${fmtDur(Date.now() - rec.start)}`;
  $("rec-sub").textContent = back;
  if (!$("sheet-tracks").hidden) renderTrackSheet();
}
setInterval(() => rec && renderRecPill(), 30000);

// ---------- Sheet ----------
function renderTrackSheet() {
  const st = $("track-status");
  st.replaceChildren();
  if (rec) {
    const dist = trackDist(rec.points);
    st.append(el("div", "track-live", `Recording · ${fmtTrip(dist)} · ${fmtDur(Date.now() - rec.start)}`));
    if (lastFix && rec.points.length) {
      const s = rec.points[0];
      st.append(el("div", "track-back", `Back to start: ${fmtDist(distMeters(lastFix, s))} ${bearing(lastFix, s)} in a straight line`));
    }
    st.append(el("p", "fine", "Keep the app open on screen. Phones stop GPS for web apps when the screen locks or you switch apps; recording picks up again when you come back."));
  }
  $("btn-track-start").hidden = !!rec;
  $("btn-track-stop").hidden = !rec;

  const ul = $("track-list"); ul.replaceChildren();
  $("track-empty").hidden = tracks.length > 0;
  for (const t of tracks) {
    const li = el("li", "track-item");
    const main = el("button", "area-main");
    main.append(el("span", "area-name", t.name),
      el("span", "area-meta", `${fmtTrip(t.dist)} · ${fmtDur(t.end - t.start)}`));
    main.addEventListener("click", () => {
      shownTracks.add(t.id); saveTracks(); drawSavedTracks();
      const xs = t.points.map(p => p[0]), ys = t.points.map(p => p[1]);
      closeSheet("sheet-tracks");
      stopFollowing();
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 50, maxZoom: 17 });
    });
    const show = el("button", "area-del", shownTracks.has(t.id) ? "Hide" : "Show");
    show.addEventListener("click", () => {
      shownTracks.has(t.id) ? shownTracks.delete(t.id) : shownTracks.add(t.id);
      saveTracks(); drawSavedTracks(); renderTrackSheet();
    });
    const gpx = el("button", "area-del", "GPX");
    gpx.addEventListener("click", () => saveFile(`track-${new Date(t.start).toISOString().slice(0, 10)}.gpx`, "application/gpx+xml",
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MI Hunt Land" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${xmlEsc(t.name)}</name><trkseg>
${t.points.map(p => `    <trkpt lat="${p[1]}" lon="${p[0]}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>
`));
    const del = el("button", "area-del", "Delete");
    del.addEventListener("click", () => {
      if (!del.classList.contains("confirm")) { del.classList.add("confirm"); del.textContent = "Confirm"; return; }
      tracks = tracks.filter(x => x.id !== t.id);
      shownTracks.delete(t.id);
      saveTracks(); drawSavedTracks(); renderTrackSheet();
    });
    const actions = el("div", "track-actions");
    actions.append(show, gpx);
    if (typeof hasPartners === "function" && hasPartners()) {
      const sh = el("button", "area-del" + (t.shared ? " on" : ""), t.shared ? "Shared ✓" : "Share");
      sh.setAttribute("aria-pressed", String(!!t.shared));
      sh.addEventListener("click", () => {
        tracks = tracks.map(x => x.id === t.id ? { ...x, shared: !x.shared } : x);
        saveTracks(); renderTrackSheet();
      });
      actions.append(sh);
    }
    actions.append(del);
    li.append(main, actions);
    ul.append(li);
  }
}

// From a JSON backup: add tracks not already here. Returns how many were added.
function importTracks(list) {
  let n = 0;
  for (const t of list) {
    if (!t?.id || !Array.isArray(t.points) || tracks.some(x => x.id === t.id)) continue;
    tracks.push(t); n++;
  }
  tracks.sort((a, b) => b.start - a.start);
  saveTracks(); drawSavedTracks();
  return n;
}

$("btn-tracks").addEventListener("click", () => {
  if (!$("sheet-tracks").hidden) return closeSheet("sheet-tracks");
  renderTrackSheet();
  openSheet("sheet-tracks");
});
$("rec-pill").addEventListener("click", () => { renderTrackSheet(); openSheet("sheet-tracks"); });
$("btn-track-start").addEventListener("click", () => { startRecording(); renderTrackSheet(); });
$("btn-track-stop").addEventListener("click", () => { stopRecording(); renderTrackSheet(); });
