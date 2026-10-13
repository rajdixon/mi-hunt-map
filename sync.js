"use strict";
// Sync pins (with their hunt logs), saved tracks, and drawn lines and areas with the private server
// at hunt.tradersedges.net. The phone keeps its own copy and works offline;
// changes go up when there's a signal. Each pin and track carries an
// `updated` time and the newer edit wins; deletes are kept as markers so
// they reach every device.
//
// On the old public GitHub Pages address this shows a "moved" screen instead,
// except for shared-pin links, which keep working there for people without
// a login.

const HOME = "https://hunt.tradersedges.net/";
const MOVED = true;    // the public copy points people to the server
const onPublicCopy = location.hostname.endsWith("github.io");
let syncOn = false, syncBusy = false, syncAgain = false, syncTimer = null, applying = false;
let syncState = { at: store.get("sync:at", 0), msg: "" };
const SYNCED = ["pins", "tracks", "shapes"];
const tombs = { pins: {}, tracks: {}, shapes: {}, ...store.get("sync:tombs", {}) };

// ---------- Change tracking ----------
// Every save of pins or tracks goes through store.set; stamp what changed
// and remember what was deleted.
const sansStamp = x => JSON.stringify({ ...x, updated: undefined });
const lastSaved = { pins: new Map(), tracks: new Map(), shapes: new Map() };
for (const k of SYNCED) for (const x of store.get(k, [])) lastSaved[k].set(x.id, sansStamp(x));

const storeSet = store.set;
store.set = (k, v) => {
  if (SYNCED.includes(k) && Array.isArray(v)) {
    const before = lastSaved[k], now = Date.now(), after = new Map();
    for (const x of v) {
      const s = sansStamp(x);
      if (!applying && before.get(x.id) !== s) { x.updated = now; delete tombs[k][x.id]; }
      after.set(x.id, s);
    }
    if (!applying) for (const id of before.keys()) if (!after.has(id)) tombs[k][id] = now;
    lastSaved[k] = after;
    storeSet("sync:tombs", tombs);
    if (!applying) scheduleSync();
  }
  storeSet(k, v);
};

// ---------- Sync ----------
function scheduleSync(ms = 2000) {
  if (!syncOn) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}

function outgoing(k, list) {
  return [...list, ...Object.entries(tombs[k]).map(([id, t]) => ({ id, deleted: true, updated: t }))];
}

async function syncNow() {
  if (!syncOn || onPublicCopy) return;
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true;
  try {
    // redirect: "manual" so an expired login shows up as a redirect, not a page of HTML
    const res = await fetch("/api/sync", {
      method: "POST", redirect: "manual", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pins: outgoing("pins", pins), tracks: outgoing("tracks", tracks), shapes: outgoing("shapes", shapes) }),
    });
    if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) { setSync("", "login"); return; }
    if (!res.ok) throw new Error(res.status);
    applyServer(await res.json());
    syncState.at = Date.now(); storeSet("sync:at", syncState.at);
    setSync("", "ok");
  } catch {
    setSync(navigator.onLine ? "Couldn't reach the server; will retry." : "No signal; changes will sync later.", "wait");
  } finally {
    syncBusy = false;
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}

// Take the server's merged lists, keeping any edit made here while the request was out
function applyServer(doc) {
  const take = (k, local, remote) => {
    const m = new Map(remote.map(x => [x.id, x]));
    for (const x of local) { const r = m.get(x.id); if (!r || (x.updated ?? 0) > (r.updated ?? 0)) m.set(x.id, x); }
    for (const [id, t] of Object.entries(tombs[k])) {
      const r = m.get(id);
      if (r && !r.deleted && (r.updated ?? 0) > t) delete tombs[k][id];   // re-created elsewhere since
    }
    // Deletes the server has stored no longer need to be kept here
    for (const x of remote) if (x.deleted) delete tombs[k][x.id];
    return [...m.values()].filter(x => !x.deleted && !tombs[k][x.id]);
  };
  if ("group" in doc && typeof setGroup === "function") setGroup(doc.group, doc.name);
  const newPins = take("pins", pins, doc.pins || []), newTracks = take("tracks", tracks, doc.tracks || []);
  const newShapes = take("shapes", shapes, doc.shapes || []);
  const changed = JSON.stringify(newPins) !== JSON.stringify(pins) || JSON.stringify(newTracks) !== JSON.stringify(tracks)
    || JSON.stringify(newShapes) !== JSON.stringify(shapes);
  applying = true;
  try {
    pins = newPins; tracks = newTracks.sort((a, b) => b.start - a.start); shapes = newShapes;
    store.set("pins", pins); store.set("tracks", tracks); store.set("shapes", shapes);
    storeSet("sync:tombs", tombs);
  } finally { applying = false; }
  if (!changed) return;
  drawPins(); drawSavedTracks(); drawShapes();
  if (!$("sheet-pins").hidden) { renderPinList(); renderShapeList(); }
  if (!$("sheet-tracks").hidden) renderTrackSheet();
  if (editing?.id) editing = { ...editing, ...pins.find(p => p.id === editing.id) };
}

function setSync(msg, state) {
  syncState.msg = msg; syncState.state = state;
  renderSyncStatus();
}

function renderSyncStatus() {
  const box = $("sync-status");
  if (!box) return;
  box.hidden = !syncOn;
  if (!syncOn) return;
  box.replaceChildren();
  box.dataset.state = syncState.state || "";
  if (syncState.state === "login") {
    box.append("Signed out of the server. ");
    const a = el("a", null, "Sign in again"); a.href = "/";
    box.append(a, " to sync.");
    return;
  }
  const ago = syncState.at ? Math.round((Date.now() - syncState.at) / 60000) : null;
  box.textContent = syncState.msg ||
    (ago == null ? "Syncing with your server…" : `Synced with your server ${ago < 1 ? "just now" : ago < 60 ? `${ago} min ago` : `${Math.round(ago / 60)} hr ago`}.`);
}

// ---------- Start ----------
async function startSync() {
  try {
    const res = await fetch("/api/sync", { redirect: "manual", credentials: "same-origin" });
    if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) { syncOn = true; setSync("", "login"); return; }
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return;   // not on the server
    syncOn = true;
    applyServer(await res.json());
    await syncNow();   // send anything made here (or offline) that the server lacks
  } catch {
    // Offline at start: assume the server, sync when back
    if (store.get("sync:at", 0)) { syncOn = true; setSync("No signal; changes will sync later.", "wait"); }
  }
}

function showMoved() {
  const hasData = pins.length || tracks.length || shapes.length;
  if (!hasData || store.get("moved:stay", false)) {
    if (!hasData && !store.get("moved:stay", false)) location.replace(HOME);
    return;
  }
  const box = el("div", "moved");
  box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
  const card = el("div", "moved-card");
  card.append(el("h2", null, "This map has moved"),
    el("p", null, "MI Hunt Land now lives on your private server, where pins, hunt logs and tracks are backed up and synced."),
    el("p", "fine", `This copy has ${pins.length} pin${pins.length === 1 ? "" : "s"} and ${tracks.length} track${tracks.length === 1 ? "" : "s"} saved on this phone. To bring them over: 1. Save a backup file. 2. Open the new address and sign in. 3. In Pins, tap Import and pick the file.`));
  const save = el("button", "btn-primary", "Save backup file");
  save.onclick = () => $("btn-backup-export").click();
  const go = el("a", "btn-ghost link-btn", "Open hunt.tradersedges.net"); go.href = HOME;
  const stay = el("button", "moved-stay", "Keep using this copy without sync");
  stay.onclick = () => { store.set("moved:stay", true); box.remove(); };
  const acts = el("div", "save-actions"); acts.append(save, go);
  card.append(acts, stay);
  box.append(card);
  document.body.append(box);
}

if (onPublicCopy) {
  if (MOVED && !location.hash.startsWith("#pin=")) showMoved();
} else {
  startSync();
  addEventListener("online", () => scheduleSync(500));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleSync(500); });
  setInterval(() => scheduleSync(0), 5 * 60000);
  setInterval(renderSyncStatus, 60000);
}
