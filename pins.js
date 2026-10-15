"use strict";
// Personal pins (stands, blinds, camp, trail cams, rubs, scrapes...) with good-wind settings and a hunt
// log. Stored only in this browser's localStorage; nothing is uploaded.
// Backup: GPX (pins only, opens in other apps) or JSON (everything).

const PIN_TYPES = {
  stand:   { label: "Tree stand", color: "#ff6a13",
             svg: '<path d="M8 3v18M16 3v18M8 7h8M8 11h8M8 15h8" fill="none"/>' },
  blind:   { label: "Ground blind", color: "#d4a63a",
             svg: '<path d="M3 20 12 5l9 15Z" fill="none"/><path d="M9.5 14h5" fill="none"/>' },
  camp:    { label: "Camp", color: "#3d8bff",
             svg: '<path d="M3 11 12 4l9 7M5.5 9.5V20h13V9.5" fill="none"/><path d="M10 20v-5h4v5" fill="none"/>' },
  cam:     { label: "Trail cam", color: "#1f9e8f",
             svg: '<rect x="6" y="3.5" width="12" height="17" rx="2.5" fill="none"/><circle cx="12" cy="10.5" r="3" fill="none"/><path d="M10 16.5h4" fill="none"/>' },
  rub:     { label: "Buck rub", color: "#a8662e", sign: true,
             svg: '<path d="M8 2.5v19M16 2.5v19" fill="none"/><path d="m10.5 8 3 1.5-3 1.5 3 1.5-3 1.5 3 1.5" fill="none"/>' },
  scrape:  { label: "Buck scrape", color: "#8a55d6", sign: true,
             svg: '<path d="M9.8 4C7.4 7.2 6.9 11.6 8 15.4c.6 1.9 2.4 1.6 2.6-.2l.1-10.4c0-1-.4-1.2-.9-.8Z"/><path d="M14.2 4c2.4 3.2 2.9 7.6 1.8 11.4-.6 1.9-2.4 1.6-2.6-.2l-.1-10.4c0-1 .4-1.2.9-.8Z"/><path d="M4 20.5h16" fill="none"/>' },
  parking: { label: "Parking", color: "#8f9aa6",
             svg: '<path d="M8 20V4h5a4 4 0 0 1 0 8H8" fill="none"/>' },
  other:   { label: "Other", color: "#e5534b",
             svg: '<circle cx="12" cy="12" r="4.5"/>' },
};
const SHARE_BASE = "https://rajdixon.github.io/mi-hunt-map/";
const LOG_KINDS = { sighting: "Sighting", shot: "Shot", harvest: "Harvest", nodeer: "No deer", note: "Note", check: "Cam check" };

let pins = store.get("pins", []);
const markers = new Map();
let editing = null;   // pin being created or edited

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function savePins() { store.set("pins", pins); drawPins(); }

function pinDot(type) {
  const t = PIN_TYPES[type] || PIN_TYPES.other;
  const s = el("span", "pin-dot");
  s.style.setProperty("--pin", t.color);
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${t.svg}</svg>`;
  return s;
}

function pinMarkerEl(pin) {
  const t = PIN_TYPES[pin.type] || PIN_TYPES.other;
  const b = el("button", "pin");
  b.style.setProperty("--pin", t.color);
  b.setAttribute("aria-label", `${t.label}: ${pin.name || "Unnamed"}`);
  b.append(pinDot(pin.type), el("span", "pin-label", pin.name || ""));
  b.addEventListener("click", e => {
    e.stopPropagation();
    if (typeof measure !== "undefined" && measure) measureAdd([pin.lng, pin.lat]);
    else if (typeof drawing !== "undefined" && drawing) drawAdd([pin.lng, pin.lat]);
    else openPinEditor(pin);
  });
  return b;
}

function drawPins() {
  for (const m of markers.values()) m.remove();
  markers.clear();
  for (const p of pins)
    markers.set(p.id, new maplibregl.Marker({ element: pinMarkerEl(p), anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map));
  if (typeof drawScent === "function") drawScent();
}

// ---------- Distance ----------
function distMeters(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Distances in the units picked in Settings: yards and miles (default),
// feet and miles, or metres and kilometres
const units = () => (typeof settings !== "undefined" && settings.units) || "yd";
function fmtDist(m) {
  const u = units();
  if (u === "m") return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  if (u === "ft" && m < 402.34) return `${Math.round(m * 3.28084)} ft`;   // under a quarter mile
  if (u === "yd" && m < 914.4) return `${Math.round(m * 1.0936)} yd`;
  return `${(m / 1609.34).toFixed(m < 16093 ? (m < 1609.34 ? 2 : 1) : 0)} mi`;
}
// Walks and tracks: miles or kilometres with two decimals
const fmtTrip = m => units() === "m" ? `${(m / 1000).toFixed(2)} km` : `${(m / 1609.34).toFixed(2)} mi`;
const fmtArea = m2 => units() === "m"
  ? `${(m2 / 10000).toFixed(m2 < 100000 ? 2 : 1)} ha`
  : `${(m2 / 4046.86).toFixed(m2 < 40468 ? 2 : 1)} acres`;
// GPS accuracy, short
const fmtAcc = m => units() === "m" ? `±${Math.round(m)} m` : `±${Math.round(m * 3.281)} ft`;
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

// ---------- Pins list ----------
function logSummary(p) {
  const log = p.log || [];
  if (!log.length) return "";
  const n = log.filter(x => x.kind === "sighting").length;
  const last = log.reduce((a, b) => (a.t > b.t ? a : b));
  return `${n ? `${n} sighting${n === 1 ? "" : "s"} · ` : ""}last ${new Date(last.t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

async function renderPinList() {
  const ul = $("pin-list"); ul.replaceChildren();
  $("pin-empty").hidden = pins.length > 0;
  $("btn-pin-gps").disabled = !lastFix;
  const here = lastFix;
  const list = [...pins].sort((a, b) => here ? distMeters(here, [a.lng, a.lat]) - distMeters(here, [b.lng, b.lat]) : b.created - a.created);
  for (const p of list) {
    const t = PIN_TYPES[p.type] || PIN_TYPES.other;
    const li = el("li");
    const b = el("button", "pin-row");
    const text = el("span", "pin-row-text");
    const meta = here ? `${t.label} · ${fmtDist(distMeters(here, [p.lng, p.lat]))} ${bearing(here, [p.lng, p.lat])}`
                      : `${t.label} · ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    text.append(el("span", "pin-row-name", p.name || t.label), el("span", "pin-row-meta", meta));
    const sum = [camSummary(p), logSummary(p), statsSummary(p)].filter(Boolean).join(" · ");
    if (sum) text.append(el("span", "pin-row-meta", sum));
    if (p.shared && typeof hasPartners === "function" && hasPartners()) text.append(el("span", "pin-row-meta shared-with", `Shared with ${sharedWith(p)}`));
    const scentLine = el("span", "pin-row-meta scent-warn"); scentLine.hidden = true;
    text.append(scentLine);
    if (SCENT_FROM.includes(p.type)) scentInfo(p).then(s => {
      if (!s?.hits.length) return;
      scentLine.textContent = `Scent over ${s.hits.map(h => h.pin.name || PIN_TYPES[h.pin.type].label).join(", ")} now`;
      scentLine.hidden = false;
    });
    const badge = el("span", "wind-badge"); badge.hidden = true;
    b.append(pinDot(p.type), text, badge);
    b.addEventListener("click", () => {
      stopFollowing();
      map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15) });
      openPinEditor(p);
    });
    li.append(b);
    ul.append(li);
    // Good/bad wind right now for stands with winds set
    if (p.winds?.length) getForecast(p.lng, p.lat).then(fc => {
      const now = periodAt(fc);
      if (!now) return;
      const ok = windMatches(now.dir, p.winds);
      badge.textContent = ok ? `Good wind · ${now.dir}` : `Wrong wind · ${now.dir}`;
      badge.dataset.ok = ok;
      badge.hidden = false;
    });
  }
}

$("btn-pins").addEventListener("click", () => {
  if (!$("sheet-pins").hidden) return closeSheet("sheet-pins");
  renderPinList();
  renderWindCard();
  openSheet("sheet-pins");
});
$("btn-pin-gps").addEventListener("click", () => lastFix && openPinEditor({ lng: lastFix[0], lat: lastFix[1] }));
$("btn-pin-center").addEventListener("click", () => {
  const c = map.getCenter();
  openPinEditor({ lng: c.lng, lat: c.lat });
});

// ---------- Editor ----------
function openPinEditor(pin, { shared = false } = {}) {
  editing = { type: "stand", name: "", notes: "", winds: [], log: [], ...pin };
  const isNew = !pin.id;
  $("pin-edit-title").textContent = shared ? "Shared pin" : isNew ? "New pin" : (pin.name || PIN_TYPES[pin.type]?.label || "Pin");
  $("pin-shared-note").hidden = !shared;

  const types = $("pin-types"); types.replaceChildren();
  for (const [k, t] of Object.entries(PIN_TYPES)) {
    const b = el("button", "pin-type");
    b.type = "button"; b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(editing.type === k));
    b.append(pinDot(k), el("span", null, t.label));
    b.addEventListener("click", () => {
      editing.type = k;
      $("pin-wind-field").hidden = !!t.sign;
      renderScentNote();
      types.querySelectorAll(".pin-type").forEach(x => x.setAttribute("aria-checked", String(x === b)));
    });
    types.append(b);
  }

  const winds = $("pin-winds"); winds.replaceChildren();
  for (const d of DIRS8) {
    const b = el("button", "wind-chip", d);
    b.type = "button"; b.setAttribute("aria-pressed", String(editing.winds.includes(d)));
    b.addEventListener("click", () => {
      editing.winds = editing.winds.includes(d) ? editing.winds.filter(x => x !== d) : [...editing.winds, d];
      b.setAttribute("aria-pressed", String(editing.winds.includes(d)));
      renderGoodWindows();
    });
    winds.append(b);
  }
  renderGoodWindows();
  renderScentNote();
  $("pin-wind-field").hidden = !!PIN_TYPES[editing.type]?.sign;

  $("pin-name").value = editing.name;
  $("pin-notes").value = editing.notes;
  $("pin-coords").textContent = `${editing.lat.toFixed(5)}, ${editing.lng.toFixed(5)}` +
    (lastFix ? ` · ${fmtDist(distMeters(lastFix, [editing.lng, editing.lat]))} from you` : "");
  $("pin-directions").href = `https://www.google.com/maps/dir/?api=1&destination=${editing.lat.toFixed(6)},${editing.lng.toFixed(6)}`;
  for (const id of ["pin-directions", "btn-pin-share", "btn-pin-delete"]) $(id).hidden = isNew;
  const del = $("btn-pin-delete");
  del.classList.remove("confirm"); del.textContent = "Delete";
  $("pin-log").hidden = isNew;
  $("log-form").hidden = true;
  $("share-note").textContent = "";
  renderLog();
  renderStats();
  $("photo-note").textContent = "";
  renderPhotos();
  if (typeof renderShareToggle === "function") renderShareToggle("pin-share", editing);
  showPreview(editing);
  openSheet("sheet-pin-edit");
}

async function renderGoodWindows() {
  const box = $("pin-good-windows");
  if (!editing?.winds.length) { box.textContent = "Pick the winds this spot hunts well in."; return; }
  box.textContent = "Checking the forecast…";
  const p = editing, fc = await getForecast(p.lng, p.lat);
  if (editing !== p) return;
  if (!fc) { box.textContent = "Forecast unavailable without a signal."; return; }
  const now = periodAt(fc);
  const w = goodWindows(fc, p.winds, p.lng, p.lat);
  box.textContent = (now ? `Now: ${windText(now)}${windMatches(now.dir, p.winds) ? " (good)" : ""}. ` : "") +
    (w.length ? `Good wind in legal hours: ${w.map(fmtWindow).join(", ")}.` : "No good-wind hunting hours in the next 3 days.");
}

async function renderScentNote() {
  const box = $("pin-scent"), p = editing;
  box.textContent = ""; box.classList.remove("scent-warn");
  if (!p || !SCENT_FROM.includes(p.type)) return;
  const s = await scentInfo(p);
  if (editing !== p || !s) return;
  box.textContent = s.text;
  box.classList.toggle("scent-warn", s.hits.length > 0);
}

// Ghost marker while placing a new pin
let preview = null;
function showPreview(p) {
  preview?.remove(); preview = null;
  if (p.id) return;
  preview = new maplibregl.Marker({ element: el("div", "pin-preview") }).setLngLat([p.lng, p.lat]).addTo(map);
}
function closePinEditor() {
  preview?.remove(); preview = null;
  editing = null;
  closeSheet("sheet-pin-edit");
}

$("pin-form").addEventListener("submit", e => {
  e.preventDefault();
  if (!editing) return;
  editing.name = $("pin-name").value.trim();
  editing.notes = $("pin-notes").value.trim();
  const sh = typeof readShareToggle === "function" ? readShareToggle("pin-share") : undefined;
  if (sh) Object.assign(editing, sh);
  if (editing.id) pins = pins.map(p => p.id === editing.id ? { ...editing } : p);
  else pins.push({ ...editing, id: newId(), created: Date.now() });
  savePins();
  closePinEditor();
});
$("btn-pin-cancel").addEventListener("click", closePinEditor);
document.querySelector('[data-close="sheet-pin-edit"]').addEventListener("click", closePinEditor);
$("btn-pin-delete").addEventListener("click", () => {
  const b = $("btn-pin-delete");
  if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Tap again to delete"; return; }
  pins = pins.filter(p => p.id !== editing.id);
  savePins();
  closePinEditor();
});

// ---------- Hunt log ----------
function updatePin(id, fn) {
  pins = pins.map(p => p.id === id ? fn({ ...p }) : p);
  store.set("pins", pins);
  editing = { ...editing, ...pins.find(p => p.id === id) };
}

function renderLog() {
  const ul = $("log-list"); ul.replaceChildren();
  const log = [...(editing?.log || [])].sort((a, b) => b.t.localeCompare(a.t));
  $("log-empty").hidden = log.length > 0;
  for (const x of log) {
    const li = el("li", "log-item");
    const head = el("div", "log-head");
    head.append(el("span", `log-kind log-${x.kind}`, LOG_KINDS[x.kind] || x.kind),
      el("span", "log-time", new Date(x.t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })));
    if (x.wind) head.append(el("span", "log-wind", x.wind));
    const del = el("button", "log-del", "Delete");
    del.addEventListener("click", () => {
      if (!del.classList.contains("confirm")) { del.classList.add("confirm"); del.textContent = "Confirm"; return; }
      updatePin(editing.id, p => ({ ...p, log: (p.log || []).filter(y => y.id !== x.id) }));
      renderLog(); renderStats(); drawPins();
    });
    head.append(del);
    li.append(head);
    if (x.text) li.append(el("div", "log-text", x.text));
    ul.append(li);
  }
}

function localInputValue(d) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(+d - off).toISOString().slice(0, 16);
}

$("btn-log-add").addEventListener("click", async () => {
  const f = $("log-form");
  f.hidden = false;
  f.dataset.kind = "sighting";
  f.querySelectorAll(".log-kind-btn").forEach(b => b.setAttribute("aria-checked", String(b.dataset.kind === "sighting")));
  $("log-text").value = "";
  $("log-time").value = localInputValue(new Date());
  $("log-wind").value = "";
  const p = editing, fc = await getForecast(p.lng, p.lat);
  const now = periodAt(fc);
  if (now && editing === p && !$("log-wind").value) $("log-wind").value = `${windText(now)}, ${now.temp}°F`;
});
document.querySelectorAll(".log-kind-btn").forEach(b => b.addEventListener("click", () => {
  $("log-form").dataset.kind = b.dataset.kind;
  document.querySelectorAll(".log-kind-btn").forEach(x => x.setAttribute("aria-checked", String(x === b)));
}));
// When the time is changed, fill in the forecast wind for that hour if it's in range
$("log-time").addEventListener("change", async () => {
  const p = editing, fc = await getForecast(p.lng, p.lat);
  const at = periodAt(fc, new Date($("log-time").value));
  if (at && editing === p) $("log-wind").value = `${windText(at)}, ${at.temp}°F`;
});
$("btn-log-cancel").addEventListener("click", () => { $("log-form").hidden = true; });
$("btn-log-save").addEventListener("click", async () => {
  const p = editing;
  let t = new Date($("log-time").value);
  if (isNaN(t)) t = new Date();
  const wind = $("log-wind").value.trim();
  const entry = { id: newId(), kind: $("log-form").dataset.kind, t: t.toISOString(), text: $("log-text").value.trim(), wind };
  // Save the weather as numbers too (wind, temp, pressure trend) for the patterns.
  // If the wind text was edited by hand, it wins over the forecast.
  const wx = wxAt(await getForecast(p.lng, p.lat), t);
  const typed = entryWx({ wind });
  if (wx || typed.dir || typed.temp != null) entry.wx = { ...wx, ...Object.fromEntries(Object.entries(typed).filter(([, v]) => v != null)) };
  if (editing !== p) return;
  updatePin(p.id, q => ({ ...q, log: [...(q.log || []), entry] }));
  $("log-form").hidden = true;
  renderLog();
  renderStats();
});

// ---------- Share a pin ----------
// Name, type and spot go in the link's #fragment, which browsers never send
// to the web server. Notes, winds and the log stay on this phone.
$("btn-pin-share").addEventListener("click", async () => {
  const p = editing;
  const t = PIN_TYPES[p.type]?.label || "Pin";
  // Links go to the public copy so people without a login to your server can open them
  const url = `${SHARE_BASE}#pin=${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.type},${encodeURIComponent(p.name || "")}`;
  const text = `${p.name || t} (${t}): ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  if (navigator.share) {
    try { await navigator.share({ title: p.name || t, text, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    $("share-note").textContent = "Link copied. Paste it into a text message.";
  } catch {
    $("share-note").textContent = url;
  }
});

function openSharedPinFromLink() {
  const m = /^#pin=(-?[\d.]+),(-?[\d.]+),(\w+),?(.*)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.pathname);
  const lat = +m[1], lng = +m[2];
  if (!isFinite(lat) || !isFinite(lng)) return;
  let name = "";
  try { name = decodeURIComponent(m[4]).slice(0, 60); } catch {}
  map.jumpTo({ center: [lng, lat], zoom: 15 });
  openPinEditor({ lat, lng, type: PIN_TYPES[m[3]] ? m[3] : "other", name }, { shared: true });
}

// ---------- Long-press (or right-click) the map to drop a pin ----------
let pressTimer = null, pressedAt = 0;
function cancelPress() { clearTimeout(pressTimer); pressTimer = null; }
map.on("touchstart", e => {
  cancelPress();
  if (e.originalEvent.touches.length !== 1) return;
  const ll = e.lngLat;
  if ((typeof drawing !== "undefined" && drawing) || (typeof measure !== "undefined" && measure)) return;
  pressTimer = setTimeout(() => {
    pressedAt = Date.now();
    navigator.vibrate?.(30);
    openPinEditor({ lng: ll.lng, lat: ll.lat });
  }, 600);
});
for (const ev of ["touchend", "touchcancel", "dragstart", "zoomstart", "rotatestart"]) map.on(ev, cancelPress);
map.on("touchmove", cancelPress);
map.on("contextmenu", e => { if (typeof drawing !== "undefined" && drawing) return; pressedAt = Date.now(); openPinEditor({ lng: e.lngLat.lng, lat: e.lngLat.lat }); });
// The tap that ends a long-press shouldn't also open parcel details
function pinsSuppressClick() { return Date.now() - pressedAt < 700; }

// ---------- Backup: GPX (pins) and JSON (everything) ----------
function xmlEsc(s) { return String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]); }

// Phones: share sheet (save to Files, AirDrop, email to yourself). Elsewhere: download.
async function saveFile(name, type, content) {
  const file = new File([content], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const today = () => new Date().toISOString().slice(0, 10);

$("btn-pin-export").addEventListener("click", () => saveFile(`hunt-pins-${today()}.gpx`, "application/gpx+xml",
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MI Hunt Land" xmlns="http://www.topografix.com/GPX/1/1">
${pins.map(p => `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">
    <name>${xmlEsc(p.name || PIN_TYPES[p.type]?.label || "Pin")}</name>${p.notes ? `\n    <desc>${xmlEsc(p.notes)}</desc>` : ""}
    <type>${xmlEsc(p.type)}</type>
  </wpt>`).join("\n")}
</gpx>
`));

$("btn-backup-export").addEventListener("click", () => saveFile(`mi-hunt-land-backup-${today()}.json`, "application/json",
  JSON.stringify({ app: "MI Hunt Land", version: 1, exported: new Date().toISOString(),
                   pins, tracks: typeof tracks !== "undefined" ? tracks : [], shapes: typeof shapes !== "undefined" ? shapes : [] }, null, 1)));

$("btn-pin-import").addEventListener("click", () => $("pin-file").click());
$("pin-file").addEventListener("change", async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const text = await f.text();
  let added = 0, addedTracks = 0, addedShapes = 0;
  const near = (a, b) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
  if (text.trimStart().startsWith("{")) {
    // Full JSON backup: merge pins (with logs) and tracks by id
    try {
      const b = JSON.parse(text);
      for (const p of b.pins || []) {
        if (!isFinite(p.lat) || !isFinite(p.lng) || pins.some(x => x.id === p.id || near(x, p))) continue;
        pins.push(p); added++;
      }
      if (typeof importTracks === "function") addedTracks = importTracks(b.tracks || []);
      for (const x of b.shapes || []) {
        if (!Array.isArray(x.pts) || shapes.some(y => y.id === x.id)) continue;
        shapes.push(x); addedShapes++;
      }
      if (addedShapes) saveShapes();
    } catch { $("pin-io-note").textContent = "That file isn't a MI Hunt Land backup."; return; }
  } else {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    for (const w of doc.querySelectorAll("wpt")) {
      const p = { lat: +w.getAttribute("lat"), lng: +w.getAttribute("lon") };
      if (!isFinite(p.lat) || !isFinite(p.lng) || pins.some(x => near(x, p))) continue;
      const type = w.querySelector("type")?.textContent.trim();
      pins.push({ ...p, id: newId(), created: Date.now(), type: PIN_TYPES[type] ? type : "other",
                  name: w.querySelector("name")?.textContent.trim() || "", notes: w.querySelector("desc")?.textContent.trim() || "" });
      added++;
    }
  }
  savePins();
  renderPinList();
  const parts = [added && `${added} pin${added === 1 ? "" : "s"}`, addedTracks && `${addedTracks} track${addedTracks === 1 ? "" : "s"}`,
                 addedShapes && `${addedShapes} line${addedShapes === 1 ? "" : "s"} or area${addedShapes === 1 ? "" : "s"}`].filter(Boolean);
  $("pin-io-note").textContent = parts.length ? `Imported ${parts.join(", ")}.` : "Nothing new in that file.";
});

drawPins();
document.addEventListener("land-ready", openSharedPinFromLink);
