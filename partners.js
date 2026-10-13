"use strict";
// Hunting partners: the people listed in the server's HUNT_GROUP. Each of you
// picks which pins, tracks, lines and areas to share; partners see them on
// their map (read-only) along with each other's location while the app is
// open. Only on the server copy; it all rides along with sync.

let group = store.get("group", null);   // { partners: [{ key, name, joined, pins, tracks, shapes }], me }
let myName = store.get("group:name", "");
let whereShare = store.get("where:share", false);
let partnerWhere = [];                    // [{ key, name, lng, lat, acc, t }]
let lastWherePost = 0, whereTimer = null;
const partnerMarkers = [], hereMarkers = new Map();

const hasPartners = () => !!(typeof syncOn !== "undefined" && syncOn && group?.partners?.length);
const partnerById = key => group?.partners.find(p => p.key === key);
const initial = name => (name || "?").trim().charAt(0).toUpperCase();

function setGroup(g, name) {
  group = g; store.set("group", g);
  if (name != null) { myName = name; store.set("group:name", name); }
  drawPartners();
  renderPartnersCard();
  if (hasPartners()) pollWhere(); else stopWhere();
}

// ---------- Share toggles (pin editor, line/area editor) ----------
// Sharing an item shares its spot, name and type only. Notes, winds, the hunt
// log and photos each go along only if ticked; the server strips the rest.
const SHARE_EXTRAS = {
  pin: [["shareNotes", "Notes"], ["shareWinds", "Good winds"], ["shareLog", "Hunt log"], ["sharePhotos", "Photos"]],
  shape: [["shareNotes", "Notes"]],
};
function renderShareToggle(boxId, item, kind = "pin") {
  const box = $(boxId);
  box.replaceChildren();
  box.hidden = !hasPartners();
  if (box.hidden) return;
  const check = (id, text, on) => {
    const label = el("label", "share-check"); label.htmlFor = id;
    const cb = el("input"); cb.type = "checkbox"; cb.id = id; cb.checked = !!on;
    label.append(cb, el("span", null, text));
    return [label, cb];
  };
  const [main, cb] = check(`${boxId}-cb`, `Share with ${group.partners.map(p => p.name).join(", ")}`, item?.shared);
  const extras = el("div", "share-extras");
  extras.append(el("span", "fine", kind === "pin" ? "They see the spot, name and type. Also share:" : "They see the line or area and its name. Also share:"));
  for (const [k, text] of SHARE_EXTRAS[kind]) extras.append(check(`${boxId}-${k}`, text, item?.[k])[0]);
  extras.hidden = !cb.checked;
  cb.onchange = () => { extras.hidden = !cb.checked; };
  box.append(main, extras);
}
// { shared, shareNotes, ... } from the toggles, or undefined when they aren't shown
function readShareToggle(boxId, kind = "pin") {
  const cb = $(`${boxId}-cb`);
  if (!cb || $(boxId).hidden) return undefined;
  const out = { shared: cb.checked };
  for (const [k] of SHARE_EXTRAS[kind]) out[k] = cb.checked && !!$(`${boxId}-${k}`)?.checked;
  return out;
}

// ---------- Partners' things on the map ----------
function partnerPinEl(pin, partner) {
  const t = PIN_TYPES[pin.type] || PIN_TYPES.other;
  const b = el("button", "pin partner-pin");
  b.style.setProperty("--pin", t.color);
  b.setAttribute("aria-label", `${partner.name}'s ${t.label}: ${pin.name || "Unnamed"}`);
  const dot = pinDot(pin.type);
  dot.append(el("span", "partner-badge", initial(partner.name)));
  b.append(dot, el("span", "pin-label", pin.name || ""));
  b.addEventListener("click", e => {
    e.stopPropagation();
    if (typeof measure !== "undefined" && measure) measureAdd([pin.lng, pin.lat]);
    else if (typeof drawing !== "undefined" && drawing) drawAdd([pin.lng, pin.lat]);
    else openPartnerPin(pin, partner);
  });
  return b;
}

function drawPartners() {
  for (const m of partnerMarkers) m.remove();
  partnerMarkers.length = 0;
  const ps = hasPartners() ? group.partners : [];
  for (const partner of ps) for (const pin of partner.pins)
    partnerMarkers.push(new maplibregl.Marker({ element: partnerPinEl(pin, partner), anchor: "center" }).setLngLat([pin.lng, pin.lat]).addTo(map));
  map.getSource("partner-tracks")?.setData({ type: "FeatureCollection", features: ps.flatMap(partner => partner.tracks
    .filter(t => t.points?.length > 1)
    .map(t => ({ type: "Feature", properties: { key: partner.key, id: t.id }, geometry: { type: "LineString", coordinates: t.points.map(p => [p[0], p[1]]) } }))) });
  drawPartnerShapes();
}

function drawPartnerShapes() {
  const ps = hasPartners() ? group.partners : [];
  map.getSource("partner-shapes")?.setData({ type: "FeatureCollection", features: ps.flatMap(partner =>
    shapesFC(partner.shapes, { key: partner.key }).features) });
}

// For the tap handler in app.js: a partner's line or area under the tap
function partnerShapeAt(point) {
  if (!hasPartners() || !map.getLayer("partner-shapes-line")) return false;
  const f = map.queryRenderedFeatures([[point.x - 10, point.y - 10], [point.x + 10, point.y + 10]], { layers: ["partner-shapes-line"] })[0]
         || map.queryRenderedFeatures(point, { layers: ["partner-shapes-fill"] })[0];
  if (!f) return false;
  const partner = partnerById(f.properties.key), s = partner?.shapes.find(x => x.id === f.properties.id);
  if (!s) return false;
  showPartnerInfo(`${partner.name}'s ${s.kind === "area" ? "area" : "line"}`, s.name || (s.kind === "area" ? "Area" : "Line"),
    [["Size", shapeSize(s)], ["Notes", s.notes]]);
  return true;
}

function showPartnerInfo(kind, title, rows, extra = []) {
  $("info-kind").textContent = kind;
  $("info-title").textContent = title;
  fillRows($("info-rows"), rows);
  $("info-extra").replaceChildren(...extra);
  $("info-coords").textContent = "";
  map.getSource("sel")?.setData(empty());
  openSheet("sheet-info");
}

function openPartnerPin(pin, partner) {
  const t = PIN_TYPES[pin.type] || PIN_TYPES.other;
  const log = [...(pin.log || [])].sort((a, b) => b.t.localeCompare(a.t));
  const extra = [];
  const go = el("button", "btn-primary", "Go to");
  go.type = "button";
  go.onclick = () => { closeSheet("sheet-info"); startGoto({ name: pin.name || t.label, lng: pin.lng, lat: pin.lat }); };
  const acts = el("div", "save-actions"); acts.append(go);
  extra.push(acts);
  if (pin.photos?.length) {
    const grid = el("div", "photo-grid");
    for (const ph of [...pin.photos].sort((a, b) => b.t.localeCompare(a.t))) {
      const a = el("a", "photo-thumb");
      a.href = `/api/photos/${ph.id}/full?o=${partner.key}`; a.target = "_blank"; a.rel = "noopener";
      const img = el("img"); img.loading = "lazy"; img.alt = ph.note || ""; img.src = `/api/photos/${ph.id}/thumb?o=${partner.key}`;
      a.append(img, el("span", "photo-time", fmtPhotoTime(ph.t)));
      grid.append(a);
    }
    extra.push(el("h3", "sheet-sub", `Photos (${pin.photos.length})`), grid);
  }
  if (log.length) {
    const ul = el("ul", "log-list");
    for (const x of log.slice(0, 8)) {
      const li = el("li", "log-item"), head = el("div", "log-head");
      head.append(el("span", `log-kind log-${x.kind}`, LOG_KINDS[x.kind] || x.kind),
        el("span", "log-time", new Date(x.t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })));
      if (x.wind) head.append(el("span", "log-wind", x.wind));
      li.append(head);
      if (x.text) li.append(el("div", "log-text", x.text));
      ul.append(li);
    }
    extra.push(el("h3", "sheet-sub", "Hunt log"), ul);
  }
  showPartnerInfo(`${partner.name}'s ${t.label.toLowerCase()}`, pin.name || t.label, [
    ["Notes", pin.notes],
    ["Good winds", pin.winds?.length ? pin.winds.join(", ") : ""],
    ["Their patterns", pin.log?.length ? statsSummary(pin) : ""],
    ["From you", lastFix ? `${fmtDist(distMeters(lastFix, [pin.lng, pin.lat]))} ${bearing(lastFix, [pin.lng, pin.lat])}` : ""],
    ["Location", `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`],
  ], extra);
}

// ---------- Live locations ----------
const agoText = t => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
};

function drawWhere() {
  const keep = new Set();
  for (const w of hasPartners() ? partnerWhere : []) {
    keep.add(w.key);
    let m = hereMarkers.get(w.key);
    if (!m) {
      const e = el("button", "partner-here");
      e.append(el("span", "ph-dot", initial(w.name)), el("span", "ph-label"));
      e.addEventListener("click", ev => { ev.stopPropagation(); renderPartnersCard(); openPinsSheet(); });
      m = new maplibregl.Marker({ element: e, anchor: "center" }).setLngLat([w.lng, w.lat]).addTo(map);
      hereMarkers.set(w.key, m);
    }
    m.setLngLat([w.lng, w.lat]);
    const e = m.getElement();
    e.classList.toggle("stale", Date.now() - w.t > 15 * 60000);
    e.querySelector(".ph-label").textContent = `${w.name} · ${agoText(w.t)}`;
    e.setAttribute("aria-label", `${w.name}, ${agoText(w.t)}`);
  }
  for (const [k, m] of hereMarkers) if (!keep.has(k)) { m.remove(); hereMarkers.delete(k); }
}

async function whereCall(method, body) {
  try {
    const res = await fetch("/api/where", { method, redirect: "manual", headers: body ? { "Content-Type": "application/json" } : {},
                                            body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) return;
    partnerWhere = (await res.json()).partners || [];
    drawWhere();
    if (!$("sheet-pins").hidden) renderPartnersCard();
  } catch {}
}

function pollWhere() {
  clearTimeout(whereTimer);
  if (!hasPartners()) return;
  if (document.visibilityState === "visible") {
    if (whereShare && lastFix) { lastWherePost = Date.now(); whereCall("POST", { lng: lastFix[0], lat: lastFix[1], acc: lastAcc }); }
    else whereCall("GET");
  }
  whereTimer = setTimeout(pollWhere, 30000);
}
function stopWhere() { clearTimeout(whereTimer); partnerWhere = []; drawWhere(); }

// From app.js on each GPS fix: send it now if it's been a while
let lastAcc = 0;
function partnersOnFix(pos) {
  lastAcc = pos.coords.accuracy;
  if (whereShare && hasPartners() && Date.now() - lastWherePost > 30000) pollWhere();
}

function setWhereShare(on) {
  whereShare = on; store.set("where:share", on);
  if (on) { if (watchId == null) $("btn-locate").click(); pollWhere(); }
  else whereCall("DELETE");
  renderPartnersCard();
}

// ---------- Partners card (top of the Pins sheet) ----------
function renderPartnersCard() {
  const box = $("partners-card");
  if (!box) return;
  box.hidden = !hasPartners();
  if (box.hidden) return;
  box.replaceChildren(el("h3", "sheet-sub", "Hunting partners"));

  const share = el("label", "share-check");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = whereShare;
  cb.onchange = () => setWhereShare(cb.checked);
  share.append(cb, el("span", null, "Share my location with them while the app is open"));
  box.append(share);

  const ul = el("ul", "partner-list");
  for (const p of group.partners) {
    const w = partnerWhere.find(x => x.key === p.key);
    const li = el("li", "partner-row");
    const text = el("div", "pin-row-text");
    text.append(el("span", "pin-row-name", p.name));
    const where = !p.joined ? "Hasn't signed in yet"
      : w ? `${lastFix ? `${fmtDist(distMeters(lastFix, [w.lng, w.lat]))} ${bearing(lastFix, [w.lng, w.lat])} · ` : ""}seen ${agoText(w.t)}`
      : "Not sharing location";
    text.append(el("span", "pin-row-meta", where));
    const counts = [p.pins.length && `${p.pins.length} pin${p.pins.length === 1 ? "" : "s"}`,
                    p.tracks.length && `${p.tracks.length} track${p.tracks.length === 1 ? "" : "s"}`,
                    p.shapes.length && `${p.shapes.length} line${p.shapes.length === 1 ? "" : "s"}/area${p.shapes.length === 1 ? "" : "s"}`].filter(Boolean);
    if (counts.length) text.append(el("span", "pin-row-meta", `Sharing ${counts.join(", ")}`));
    const dot = el("span", "ph-dot", initial(p.name));
    li.append(dot, text);
    if (w) {
      const go = el("button", "btn-ghost small-btn", "Go to");
      go.onclick = () => startGoto({ name: p.name, lng: w.lng, lat: w.lat });
      const see = el("button", "btn-ghost small-btn", "Show");
      see.onclick = () => { closeSheet("sheet-pins"); stopFollowing(); map.flyTo({ center: [w.lng, w.lat], zoom: Math.max(map.getZoom(), 15) }); };
      const acts = el("div", "partner-acts"); acts.append(see, go);
      li.append(acts);
    }
    ul.append(li);
  }
  box.append(ul);

  const nameField = el("label", "field");
  const input = el("input"); input.type = "text"; input.maxLength = 40; input.value = myName; input.autocomplete = "off";
  input.onchange = async () => {
    const res = await fetch("/api/me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: input.value }) }).catch(() => null);
    if (res?.ok) { const d = await res.json(); setGroup(d.group, d.name); }
  };
  nameField.append(el("span", null, "Your name, as partners see it"), input);
  box.append(nameField,
    el("p", "fine", "Partners see the pins, tracks, lines and areas you mark \"Share\". Phones only send location while the app is open on screen."));
}
function openPinsSheet() { if ($("sheet-pins").hidden) $("btn-pins").click(); }

document.addEventListener("land-ready", () => {
  map.addSource("partner-tracks", { type: "geojson", data: empty() });
  map.addLayer({ id: "partner-tracks", type: "line", source: "partner-tracks", layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": "#4fc3f7", "line-width": 3, "line-dasharray": [2, 1.2], "line-opacity": 0.85 } }, "sel-line");
  map.addSource("partner-shapes", { type: "geojson", data: empty() });
  map.addLayer({ id: "partner-shapes-fill", type: "fill", source: "partner-shapes", filter: ["==", "$type", "Polygon"],
                 paint: { "fill-color": ["get", "color"], "fill-opacity": 0.12 } }, "sel-line");
  map.addLayer({ id: "partner-shapes-line", type: "line", source: "partner-shapes", layout: { "line-cap": "round", "line-join": "round" },
                 paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": [2, 1.2] } }, "sel-line");
  drawPartners();
});
$("btn-pins").addEventListener("click", renderPartnersCard);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && hasPartners()) pollWhere(); });
setInterval(drawWhere, 60000);
