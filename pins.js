"use strict";
// Personal pins (blinds, stands, camp...). Stored only in this browser's
// localStorage; nothing is uploaded. Export/import as GPX for backup or
// moving to another phone.

const PIN_TYPES = {
  stand:   { label: "Tree stand", color: "#ff6a13",
             svg: '<path d="M8 3v18M16 3v18M8 7h8M8 11h8M8 15h8" fill="none"/>' },
  blind:   { label: "Ground blind", color: "#d4a63a",
             svg: '<path d="M3 20 12 5l9 15Z" fill="none"/><path d="M9.5 14h5" fill="none"/>' },
  camp:    { label: "Camp", color: "#3d8bff",
             svg: '<path d="M3 11 12 4l9 7M5.5 9.5V20h13V9.5" fill="none"/><path d="M10 20v-5h4v5" fill="none"/>' },
  parking: { label: "Parking", color: "#8f9aa6",
             svg: '<path d="M8 20V4h5a4 4 0 0 1 0 8H8" fill="none"/>' },
  other:   { label: "Other", color: "#e5534b",
             svg: '<circle cx="12" cy="12" r="4.5"/>' },
};

let pins = store.get("pins", []);
const markers = new Map();
let editing = null;   // pin being created or edited

function savePins() { store.set("pins", pins); drawPins(); }

function pinEl(pin) {
  const t = PIN_TYPES[pin.type] || PIN_TYPES.other;
  const el = document.createElement("button");
  el.className = "pin";
  el.style.setProperty("--pin", t.color);
  el.setAttribute("aria-label", `${t.label}: ${pin.name || "Unnamed"}`);
  el.innerHTML = `<span class="pin-dot"><svg viewBox="0 0 24 24" aria-hidden="true">${t.svg}</svg></span><span class="pin-label"></span>`;
  el.querySelector(".pin-label").textContent = pin.name || "";
  el.addEventListener("click", e => { e.stopPropagation(); openPinEditor(pin); });
  return el;
}

function drawPins() {
  for (const m of markers.values()) m.remove();
  markers.clear();
  for (const p of pins) {
    markers.set(p.id, new maplibregl.Marker({ element: pinEl(p), anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map));
  }
}

// ---------- Distance ----------
function distMeters(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtDist(m) {
  const yd = m * 1.0936;
  return yd < 1000 ? `${Math.round(yd)} yd` : `${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`;
}
function bearing(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

// ---------- Pins list ----------
function renderPinList() {
  const ul = $("pin-list"); ul.replaceChildren();
  $("pin-empty").hidden = pins.length > 0;
  $("btn-pin-gps").disabled = !lastFix;
  const here = lastFix;
  const list = [...pins].sort((a, b) => here ? distMeters(here, [a.lng, a.lat]) - distMeters(here, [b.lng, b.lat]) : b.created - a.created);
  for (const p of list) {
    const t = PIN_TYPES[p.type] || PIN_TYPES.other;
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "pin-row";
    b.innerHTML = `<span class="pin-dot" style="--pin:${t.color}"><svg viewBox="0 0 24 24" aria-hidden="true">${t.svg}</svg></span>
      <span class="pin-row-text"><span class="pin-row-name"></span><span class="pin-row-meta"></span></span>`;
    b.querySelector(".pin-row-name").textContent = p.name || t.label;
    b.querySelector(".pin-row-meta").textContent = here
      ? `${t.label} · ${fmtDist(distMeters(here, [p.lng, p.lat]))} ${bearing(here, [p.lng, p.lat])}`
      : `${t.label} · ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    b.addEventListener("click", () => {
      map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15) });
      openPinEditor(p);
    });
    li.append(b);
    ul.append(li);
  }
}

$("btn-pins").addEventListener("click", () => {
  if (!$("sheet-pins").hidden) return closeSheet("sheet-pins");
  renderPinList();
  openSheet("sheet-pins");
});
$("btn-pin-gps").addEventListener("click", () => lastFix && openPinEditor({ lng: lastFix[0], lat: lastFix[1] }));
$("btn-pin-center").addEventListener("click", () => {
  const c = map.getCenter();
  openPinEditor({ lng: c.lng, lat: c.lat });
});

// ---------- Editor ----------
function openPinEditor(pin) {
  editing = { type: "stand", name: "", notes: "", ...pin };
  const isNew = !pin.id;
  $("pin-edit-title").textContent = isNew ? "New pin" : (pin.name || PIN_TYPES[pin.type]?.label || "Pin");
  const types = $("pin-types"); types.replaceChildren();
  for (const [k, t] of Object.entries(PIN_TYPES)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pin-type"; b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(editing.type === k));
    b.style.setProperty("--pin", t.color);
    b.innerHTML = `<span class="pin-dot"><svg viewBox="0 0 24 24" aria-hidden="true">${t.svg}</svg></span><span></span>`;
    b.lastChild.textContent = t.label;
    b.addEventListener("click", () => {
      editing.type = k;
      types.querySelectorAll(".pin-type").forEach(x => x.setAttribute("aria-checked", String(x === b)));
    });
    types.append(b);
  }
  $("pin-name").value = editing.name;
  $("pin-notes").value = editing.notes;
  $("pin-coords").textContent = `${editing.lat.toFixed(5)}, ${editing.lng.toFixed(5)}` +
    (lastFix ? ` · ${fmtDist(distMeters(lastFix, [editing.lng, editing.lat]))} from you` : "");
  $("pin-directions").href = `https://www.google.com/maps/dir/?api=1&destination=${editing.lat.toFixed(6)},${editing.lng.toFixed(6)}`;
  $("pin-directions").hidden = isNew;
  const del = $("btn-pin-delete");
  del.hidden = isNew; del.classList.remove("confirm"); del.textContent = "Delete";
  showPreview(editing);
  openSheet("sheet-pin-edit");
}

// Ghost marker while placing a new pin
let preview = null;
function showPreview(p) {
  preview?.remove(); preview = null;
  if (p.id) return;
  const el = document.createElement("div");
  el.className = "pin-preview";
  preview = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
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
  if (editing.id) pins = pins.map(p => p.id === editing.id ? { ...editing } : p);
  else pins.push({ ...editing, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now() });
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

// ---------- Long-press (or right-click) the map to drop a pin ----------
let pressTimer = null, pressedAt = 0;
function cancelPress() { clearTimeout(pressTimer); pressTimer = null; }
map.on("touchstart", e => {
  cancelPress();
  if (e.originalEvent.touches.length !== 1) return;
  const ll = e.lngLat;
  pressTimer = setTimeout(() => {
    pressedAt = Date.now();
    navigator.vibrate?.(30);
    openPinEditor({ lng: ll.lng, lat: ll.lat });
  }, 600);
});
for (const ev of ["touchend", "touchcancel", "dragstart", "zoomstart", "rotatestart"]) map.on(ev, cancelPress);
map.on("touchmove", cancelPress);
map.on("contextmenu", e => { pressedAt = Date.now(); openPinEditor({ lng: e.lngLat.lng, lat: e.lngLat.lat }); });
// The tap that ends a long-press shouldn't also open parcel details
function pinsSuppressClick() { return Date.now() - pressedAt < 700; }

// ---------- Export / import (GPX) ----------
function esc(s) { return String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]); }

$("btn-pin-export").addEventListener("click", async () => {
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MI Hunt Land" xmlns="http://www.topografix.com/GPX/1/1">
${pins.map(p => `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">
    <name>${esc(p.name || PIN_TYPES[p.type]?.label || "Pin")}</name>${p.notes ? `\n    <desc>${esc(p.notes)}</desc>` : ""}
    <type>${esc(p.type)}</type>
  </wpt>`).join("\n")}
</gpx>
`;
  const file = new File([gpx], `hunt-pins-${new Date().toISOString().slice(0, 10)}.gpx`, { type: "application/gpx+xml" });
  // Phones: share sheet (save to Files, AirDrop, email to yourself). Elsewhere: download.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Hunt pins" }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$("btn-pin-import").addEventListener("click", () => $("pin-file").click());
$("pin-file").addEventListener("change", async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const doc = new DOMParser().parseFromString(await f.text(), "application/xml");
  let added = 0;
  for (const w of doc.querySelectorAll("wpt")) {
    const lat = +w.getAttribute("lat"), lng = +w.getAttribute("lon");
    if (!isFinite(lat) || !isFinite(lng)) continue;
    // Skip waypoints already pinned (same spot within ~1 m)
    if (pins.some(p => Math.abs(p.lat - lat) < 1e-5 && Math.abs(p.lng - lng) < 1e-5)) continue;
    const type = w.querySelector("type")?.textContent.trim();
    pins.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: Date.now(),
      lat, lng, type: PIN_TYPES[type] ? type : "other",
      name: w.querySelector("name")?.textContent.trim() || "", notes: w.querySelector("desc")?.textContent.trim() || "",
    });
    added++;
  }
  savePins();
  renderPinList();
  $("pin-io-note").textContent = added ? `Imported ${added} pin${added === 1 ? "" : "s"}.` : "No new pins found in that file.";
});

drawPins();
