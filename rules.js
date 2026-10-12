"use strict";
// Deer hunting hours and rules for a location, from the 2026 DNR deer digest
// (data/deer_rules_2026.json). Uses the GPS fix when location is on,
// otherwise the center of the map.

const rules = { data: null, counties: null, dmus: null, date: null };

const ET = "America/Detroit", CT = "America/Menominee";
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fmtLong = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

Promise.all([
  fetch("data/deer_rules_2026.json").then(r => r.json()),
  fetch("data/counties.geojson").then(r => r.json()),
  fetch("data/dmu.geojson").then(r => r.json()),
]).then(([data, counties, dmus]) => {
  for (const fc of [counties, dmus]) fc.features.forEach(f => {
    f.bbox = bboxOf(f.geometry);
    f.size = (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]);
  });
  Object.assign(rules, { data, counties, dmus });
  refreshRules();
}).catch(() => { $("hours-chip").hidden = true; });

// ---------- Lookups ----------
function featureAt(fc, pt) {
  let best = null;
  for (const f of fc.features) {
    const b = f.bbox;
    if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
    // Some DMUs sit inside others (e.g. 452 inside the northeast counties): take the smallest
    if (inGeom(pt, f.geometry) && (!best || f.size < best.size)) best = f;
  }
  return best;
}

function rulesPoint() {
  if (watchId != null && lastFix) return { pt: lastFix, source: "your location" };
  const c = map.getCenter();
  return { pt: [c.lng, c.lat], source: "map center" };
}

function placeAt(pt) {
  const county = featureAt(rules.counties, pt);
  if (!county) return null;
  const dmuF = featureAt(rules.dmus, pt);
  const name = county.properties.Name;
  const dmu = dmuF?.properties.DeerManagementUnit || null;
  const h = rules.data.hours;
  const zone = (dmu && h.dmuZone[dmu]) || h.countyZone[name];
  const central = h.centralTime.includes(name);
  return {
    county: name, dmu, dmuName: dmuF?.properties.MangementUnitName || "",
    peninsula: county.properties.Peninsula === "Upper" ? "UP" : "LP",
    zone, offset: h.offsets[zone], central, tz: central ? CT : ET,
  };
}

// ---------- Hours ----------
function toMin(hm) { const [h, m] = hm.split(":").map(Number); return h * 60 + m; }

function fmtMin(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function hoursOn(iso, place) {
  const row = rules.data.hours.zoneA[iso];
  if (!row) return null;
  const adj = place.offset - (place.central ? 60 : 0);
  return { open: toMin(row[0]) + adj, close: toMin(row[1]) + 12 * 60 + adj, base: row };
}

function nowIn(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dur(min) { return min >= 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`; }

function liveStatus(place) {
  const now = nowIn(place.tz), h = hoursOn(now.iso, place);
  if (!h) return null;
  if (now.min < h.open) return { state: "before", text: `Opens ${fmtMin(h.open)}`, sub: `in ${dur(h.open - now.min)}` };
  if (now.min <= h.close) return { state: "open", text: `Legal until ${fmtMin(h.close)}`, sub: `${dur(h.close - now.min)} left` };
  const t = hoursOn(addDays(now.iso, 1), place);
  return { state: "after", text: "Closed for today", sub: t ? `Opens ${fmtMin(t.open)} tomorrow` : "" };
}

// ---------- Seasons & rules ----------
function seasonsOn(iso, place) {
  return rules.data.seasons.filter(s =>
    iso >= s.start && iso <= s.end &&
    (s.area === "all" || s.area === place.peninsula || (s.area === "dmu" && s.dmus.includes(place.dmu))) &&
    !(s.except || []).includes(place.dmu));
}

function nextSeason(iso, place) {
  return rules.data.seasons
    .filter(s => s.start > iso && (s.area === "all" || s.area === place.peninsula ||
      (s.area === "dmu" && s.dmus.includes(place.dmu))) && !(s.except || []).includes(place.dmu))
    .sort((a, b) => a.start.localeCompare(b.start))[0];
}

function aprGroup(place) {
  const a = rules.data.apr;
  return a.groups[a.dmuGroup[place.dmu] || (place.peninsula === "UP" ? "up" : "lp")];
}

function antlerlessText(place) {
  const a = rules.data.antlerless;
  if (place.peninsula === "LP") {
    const n = a.lpCountyLimit[place.county];
    return `Universal antlerless licenses are valid in all open Lower Peninsula DMUs.` +
      (n ? ` Use limit in ${place.county} County: ${n} per hunter.` : "");
  }
  if (a.upClosed.includes(place.dmu)) return `DMU ${place.dmu} is closed to antlerless harvest with a universal antlerless license.`;
  if (a.upAllowed.includes(place.dmu)) {
    const n = a.upLimit[place.dmu];
    return `Universal antlerless licenses are valid in DMU ${place.dmu}.` + (n ? ` Use limit: ${n} per hunter.` : "");
  }
  return "In the Upper Peninsula, universal antlerless licenses are valid only in DMUs 022, 055, 121, 122, 155 and 255.";
}

// ---------- Rendering ----------
let rulesTimer = null;
function refreshRules() {
  clearTimeout(rulesTimer);
  rulesTimer = setTimeout(() => { renderChip(); if (!$("sheet-rules").hidden) renderRules(); }, 150);
}
map.on("moveend", refreshRules);
setInterval(renderChip, 60000);

function renderChip() {
  if (!rules.data) return;
  const chip = $("hours-chip");
  const place = placeAt(rulesPoint().pt);
  if (!place) { chip.hidden = true; return; }
  const now = nowIn(place.tz), h = hoursOn(now.iso, place), live = liveStatus(place);
  chip.hidden = false;
  chip.dataset.state = live ? live.state : "off";
  $("chip-main").textContent = h ? `${fmtMin(h.open)} – ${fmtMin(h.close)}` : "Deer hours";
  $("chip-sub").textContent = live ? `${live.text} · ${place.county} Co.` : `Not in the 2026 table · ${place.county} Co.`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function section(title, page) {
  const s = el("section", "rule-sec");
  const h = el("h3", "sheet-sub", title);
  if (page) h.append(el("span", "page-ref", `Digest p. ${page}`));
  s.append(h);
  return s;
}

function renderRules() {
  if (!rules.data) return;
  const { pt, source } = rulesPoint();
  const place = placeAt(pt);
  const body = $("rules-body"); body.replaceChildren();
  document.body.classList.toggle("show-crosshair", source === "map center");
  if (!place) {
    $("rules-title").textContent = "Outside Michigan";
    $("rules-meta").textContent = "Move the map over Michigan to see hunting hours and rules.";
    return;
  }
  const tzLabel = place.central ? "Central Time" : "Eastern Time";
  $("rules-title").textContent = `${place.county} County`;
  $("rules-meta").textContent =
    `${place.dmu ? `DMU ${place.dmu}` : "DMU unknown"} · Hour zone ${place.zone} (+${place.offset} min) · Using ${source}`;

  const today = nowIn(place.tz).iso;
  const t = rules.data.hours.zoneA, first = Object.keys(t)[0], last = Object.keys(t).at(-1);
  if (!rules.date || rules.date < first || rules.date > last) rules.date = today >= first && today <= last ? today : first;
  const iso = rules.date;

  // Hours
  const hs = section("Legal hunting hours", rules.data.hours.page);
  const nav = el("div", "date-nav");
  const prev = el("button", "date-step", "‹"); prev.setAttribute("aria-label", "Previous day");
  const next = el("button", "date-step", "›"); next.setAttribute("aria-label", "Next day");
  const input = el("input", "date-input"); input.type = "date"; input.id = "rules-date";
  input.min = first; input.max = last; input.value = iso;
  prev.disabled = iso <= first; next.disabled = iso >= last;
  prev.onclick = () => { rules.date = addDays(iso, -1); renderRules(); };
  next.onclick = () => { rules.date = addDays(iso, 1); renderRules(); };
  input.onchange = () => { if (input.value) { rules.date = input.value; renderRules(); } };
  nav.append(prev, input, next);
  if (iso !== today && today >= first && today <= last) {
    const back = el("button", "date-today", "Today");
    back.onclick = () => { rules.date = today; renderRules(); };
    nav.append(back);
  }
  hs.append(nav);

  const h = hoursOn(iso, place);
  const big = el("div", "hours-big");
  big.append(el("div", "hours-col", ""), el("div", "hours-col", ""));
  big.children[0].append(el("span", "hours-label", "Opens"), el("strong", null, fmtMin(h.open)));
  big.children[1].append(el("span", "hours-label", "Closes"), el("strong", null, fmtMin(h.close)));
  hs.append(el("div", "hours-date", fmtLong.format(new Date(iso + "T00:00:00Z"))), big);
  if (iso === today) {
    const live = liveStatus(place);
    if (live) {
      const p = el("div", "live", `${live.text}${live.sub ? " · " + live.sub : ""}`);
      p.dataset.state = live.state;
      hs.append(p);
    }
  }
  const adj = place.central ? `, minus 1 hour for Central Time` : "";
  hs.append(el("p", "fine", `${tzLabel}. Zone A table ${h.base[0]} a.m. / ${h.base[1]} p.m., plus ${place.offset} min for zone ${place.zone}${adj}.`));

  const week = el("table", "week");
  week.innerHTML = `<thead><tr><th>Day</th><th>Opens</th><th>Closes</th></tr></thead>`;
  const tb = el("tbody");
  for (let i = 1; i <= 7; i++) {
    const d = addDays(iso, i), x = hoursOn(d, place);
    if (!x) break;
    const tr = el("tr");
    tr.append(el("td", null, fmtDay.format(new Date(d + "T00:00:00Z"))), el("td", null, fmtMin(x.open)), el("td", null, fmtMin(x.close)));
    tr.onclick = () => { rules.date = d; renderRules(); };
    tb.append(tr);
  }
  week.append(tb);
  if (tb.children.length) { hs.append(el("div", "week-title", "Following days")); hs.append(week); }
  body.append(hs);

  // Seasons
  const ss = section(iso === today ? "Seasons open today" : "Seasons open this day", rules.data.seasonsPage);
  const open = seasonsOn(iso, place);
  if (open.length) {
    const ul = el("ul", "season-list");
    for (const s of open) {
      const li = el("li");
      li.append(el("strong", null, s.name), el("span", "season-dates", `${short(s.start)} – ${short(s.end)}`));
      if (s.note) li.append(el("span", "season-note", s.note));
      ul.append(li);
    }
    ss.append(ul);
  } else {
    const n = nextSeason(iso, place);
    ss.append(el("p", "plain", n ? `No deer seasons open. Next: ${n.name}, ${short(n.start)}.` : "No deer seasons open."));
  }
  body.append(ss);

  // Antler point restrictions
  const as = section("What you can take", rules.data.apr.page);
  const g = aprGroup(place);
  for (const [license, cells] of g.rows) {
    const card = el("div", "apr");
    card.append(el("div", "apr-license", license));
    const same = cells.every(c => c === cells[0]);
    const dl = el("dl", "apr-rows");
    const pairs = same ? [["All seasons", cells[0]]] : groupSeasons(g.seasons, cells);
    for (const [k, v] of pairs) dl.append(el("dt", null, k), el("dd", null, v));
    card.append(dl);
    as.append(card);
  }
  as.append(el("p", "fine", rules.data.apr.youthNote + " A legal point is at least 1 inch long."));
  body.append(as);

  // Antlerless + baiting + notes
  const al = section("Universal antlerless license", rules.data.antlerless.page);
  al.append(el("p", "plain", antlerlessText(place)));
  body.append(al);
  const bs = section("Baiting and feeding", rules.data.baiting.page);
  bs.append(el("p", "plain", rules.data.baiting[place.peninsula]));
  body.append(bs);
  const note = rules.data.dmuNotes[place.dmu];
  if (note) {
    const ns = section(`DMU ${place.dmu}`);
    ns.append(el("p", "plain", note));
    body.append(ns);
  }

  const src = el("p", "fine");
  src.append("From the ");
  const a = el("a", null, rules.data.source.title); a.href = rules.data.source.url; a.target = "_blank"; a.rel = "noopener";
  src.append(a, ". A summary only: check the full digest and Michigan.gov/DNRLaws before you hunt.");
  body.append(src);
}

// Merge adjacent seasons with the same rule ("Early archery, Late archery: …")
function groupSeasons(seasons, cells) {
  const m = new Map();
  cells.forEach((c, i) => m.set(c, [...(m.get(c) || []), seasons[i]]));
  return [...m].map(([rule, ss]) => [ss.join(", "), rule]);
}

function short(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

$("hours-chip").addEventListener("click", () => {
  if (!$("sheet-rules").hidden) { closeSheet("sheet-rules"); document.body.classList.remove("show-crosshair"); return; }
  rules.date = null;
  renderRules();
  openSheet("sheet-rules");
});
document.querySelector('[data-close="sheet-rules"]').addEventListener("click", () =>
  document.body.classList.remove("show-crosshair"));
