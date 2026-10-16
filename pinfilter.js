"use strict";
// Which pins show on the map: by person (you and each partner), by pin type,
// and partners' copies of a spot already pinned. A partner's pin is a copy
// when it's the same type within 30 m, or any type within 10 m, of one that's
// already showing (yours first, then partners in order). Your pin then
// carries the partner's initial instead. Partners' tracks, lines and areas
// follow their person chip. The pin list still lists all your pins.

let pinFilter = { who: [], types: [], dedupe: true, ...store.get("pinFilter", {}) };   // who/types: the ones hidden
const DUPE_SAME_M = 30, DUPE_ANY_M = 10;

function setPinFilter(change) {
  pinFilter = { ...pinFilter, ...change };
  store.set("pinFilter", pinFilter);
  drawPins();
  if (typeof drawPartners === "function") drawPartners();
  renderPinFilter();
  if (!$("sheet-pins").hidden) renderPinList();
}

const pinTypeKey = p => PIN_TYPES[p.type] ? p.type : "other";
function pinVisible(pin, who) { return !pinFilter.who.includes(who) && !pinFilter.types.includes(pinTypeKey(pin)); }
const personShown = who => !pinFilter.who.includes(who);

// { hidden: Set of partner pin ids that are copies, alsoOn: Map(your pin id -> [partner names]) }
function pinCopies() {
  const hidden = new Set(), alsoOn = new Map();
  if (!pinFilter.dedupe || typeof hasPartners !== "function" || !hasPartners()) return { hidden, alsoOn };
  const shown = pins.filter(p => pinVisible(p, "me")).map(p => ({ p, mine: true }));
  for (const partner of group.partners) for (const pin of partner.pins) {
    if (!pinVisible(pin, partner.key)) continue;
    const at = [pin.lng, pin.lat];
    const twin = shown.find(x => {
      const d = distMeters(at, [x.p.lng, x.p.lat]);
      return d <= DUPE_ANY_M || (d <= DUPE_SAME_M && pinTypeKey(x.p) === pinTypeKey(pin));
    });
    if (!twin) { shown.push({ p: pin, mine: false }); continue; }
    hidden.add(pin.id);
    if (twin.mine) alsoOn.set(twin.p.id, [...(alsoOn.get(twin.p.id) || []), partner.name]);
  }
  return { hidden, alsoOn };
}

// ---------- The "Show on map" box in the Pins sheet ----------
function renderPinFilter() {
  const box = $("pin-filter");
  const partners = typeof hasPartners === "function" && hasPartners() ? group.partners : [];
  const theirs = partners.flatMap(p => p.pins);
  box.hidden = !pins.length && !theirs.length;
  if (box.hidden) return;
  const chip = (label, on, onclick, lead) => {
    const b = el("button", "filter-chip");
    b.type = "button"; b.setAttribute("aria-pressed", String(on));
    if (lead) b.append(lead);
    b.append(label); b.onclick = onclick;
    return b;
  };
  const flip = (list, v) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];
  box.replaceChildren(el("div", "glance-label", "Show on map"));

  if (partners.length) {
    const row = el("div", "filter-row");
    for (const [key, name] of [["me", "Mine"], ...partners.map(p => [p.key, p.name])]) {
      const dot = el("span", "ph-dot", key === "me" ? initial(myName || "Me") : initial(name));
      row.append(chip(name, personShown(key), () => setPinFilter({ who: flip(pinFilter.who, key) }), dot));
    }
    box.append(row);
  }
  const used = new Set([...pins, ...theirs].map(pinTypeKey));
  const types = el("div", "filter-row");
  for (const [k, t] of Object.entries(PIN_TYPES)) if (used.has(k))
    types.append(chip(t.label, !pinFilter.types.includes(k), () => setPinFilter({ types: flip(pinFilter.types, k) }), pinDot(k)));
  box.append(types);

  const copies = pinCopies();
  if (partners.length) {
    const label = el("label", "share-check");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = pinFilter.dedupe;
    cb.onchange = () => setPinFilter({ dedupe: cb.checked });
    label.append(cb, el("span", null, "Hide partners' pins at spots already pinned"));
    box.append(label);
  }
  const all = [...pins.map(p => [p, "me"]), ...partners.flatMap(pt => pt.pins.map(p => [p, pt.key]))];
  const showing = all.filter(([p, who]) => pinVisible(p, who) && !copies.hidden.has(p.id)).length;
  const status = el("div", "filter-status");
  const bits = [`Showing ${showing} of ${all.length} pin${all.length === 1 ? "" : "s"}`];
  if (copies.hidden.size) bits.push(`${copies.hidden.size} cop${copies.hidden.size === 1 ? "y" : "ies"} hidden`);
  status.append(el("span", "fine", bits.join(" · ")));
  if (pinFilter.who.length || pinFilter.types.length) {
    const reset = el("button", "btn-ghost small-btn", "Show all");
    reset.type = "button"; reset.onclick = () => setPinFilter({ who: [], types: [] });
    status.append(reset);
  }
  box.append(status);
  $("btn-pins").classList.toggle("filtered", !!(pinFilter.who.length || pinFilter.types.length));
}

$("btn-pins").addEventListener("click", renderPinFilter);
$("btn-pins").classList.toggle("filtered", !!(pinFilter.who.length || pinFilter.types.length));
drawPins();
