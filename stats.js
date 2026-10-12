"use strict";
// Patterns from a pin's hunt log: which wind, time of day, temperature and
// pressure trend you saw deer in. Entries are grouped into sits (one morning
// or one evening at a spot); a sit "had deer" if any sighting, shot or harvest
// was logged. "No deer" entries record the sits where nothing showed.

const DEER_KINDS = ["sighting", "shot", "harvest"];
const SIT_KINDS = [...DEER_KINDS, "nodeer"];

// Structured weather for a log entry: saved with newer entries, parsed from
// the "NW 8 mph, 41°F" text for older ones
function entryWx(x) {
  if (x.wx) return x.wx;
  const m = /^\s*(Calm|[NSEW]{1,3})\b/i.exec(x.wind || ""), t = /(-?\d+)\s*°/.exec(x.wind || "");
  return { dir: m ? (m[1].toLowerCase() === "calm" ? "Calm" : m[1].toUpperCase()) : null, temp: t ? +t[1] : null };
}

// Weather at time `t` from a forecast, for saving with a log entry
function wxAt(fc, t) {
  const p = periodAt(fc, t);
  const out = {};
  if (p) Object.assign(out, { dir: isCalm(p) ? "Calm" : p.dir, mph: p.mph, temp: p.temp });
  const pr = pressureAt(fc, +t), before = pressureAt(fc, +t - 3 * 3600000);
  if (pr != null) out.p = pr;
  if (pr != null && before != null) out.dp = +(pr - before).toFixed(2);
  return Object.keys(out).length ? out : null;
}

const dir8 = d => d === "Calm" ? "Calm" : DIR_DEG[d] == null ? null : DIRS8[Math.round(DIR_DEG[d] / 45) % 8];
const tempBand = t => t == null ? null : t < 30 ? "Below 30°" : t < 45 ? "30–44°" : t < 60 ? "45–59°" : "60° and up";
const pressBand = dp => dp == null ? null : dp >= 0.02 ? "Rising" : dp <= -0.02 ? "Falling" : "Steady";

function pinSits(pin) {
  const sits = new Map();
  for (const x of pin.log || []) {
    if (!SIT_KINDS.includes(x.kind)) continue;
    const d = new Date(x.t);
    const key = d.toDateString() + (d.getHours() < 12 ? " AM" : " PM");
    const s = sits.get(key) || { deer: false, am: d.getHours() < 12, wx: {} };
    if (DEER_KINDS.includes(x.kind)) s.deer = true;
    const w = entryWx(x);
    for (const k of ["dir", "temp", "dp"]) if (s.wx[k] == null && w[k] != null) s.wx[k] = w[k];
    sits.set(key, s);
  }
  return [...sits.values()];
}

// [{ title, rows: [{ value, deer, sits }] }] sorted best first, or null if too few sits
function pinStats(pin) {
  const sits = pinSits(pin);
  if (sits.length < 3) return { sits: sits.length, groups: null };
  const dims = [
    ["Wind", s => dir8(s.wx.dir)],
    ["Time", s => s.am ? "Morning" : "Evening"],
    ["Temperature", s => tempBand(s.wx.temp)],
    ["Pressure", s => pressBand(s.wx.dp)],
  ];
  const groups = dims.map(([title, f]) => {
    const m = new Map();
    for (const s of sits) {
      const v = f(s);
      if (v == null) continue;
      const r = m.get(v) || { value: v, deer: 0, sits: 0 };
      r.sits++; if (s.deer) r.deer++;
      m.set(v, r);
    }
    const rows = [...m.values()].sort((a, b) => b.deer / b.sits - a.deer / a.sits || b.sits - a.sits);
    return { title, rows };
  }).filter(g => g.rows.length);
  return { sits: sits.length, withDeer: sits.filter(s => s.deer).length, groups };
}

// Short "Best: NW wind, mornings" line for the pin list
function statsSummary(pin) {
  const st = pinStats(pin);
  if (!st.groups) return "";
  const pick = t => st.groups.find(g => g.title === t)?.rows.find(r => r.sits >= 2 && r.deer > 0);
  const w = pick("Wind"), tm = pick("Time");
  const parts = [w && (w.value === "Calm" ? "calm" : `${w.value} wind`), tm && (tm.value === "Morning" ? "mornings" : "evenings")].filter(Boolean);
  return parts.length ? "Best: " + parts.join(", ") : "";
}

function renderStats() {
  const box = $("pin-stats");
  box.replaceChildren();
  if (!editing?.id) { box.hidden = true; return; }
  const st = pinStats(editing);
  box.hidden = st.sits === 0;
  if (!st.groups) {
    box.append(el("p", "fine", `${st.sits} sit${st.sits === 1 ? "" : "s"} logged. Patterns show after 3 sits.`));
    return;
  }
  box.append(el("div", "stats-head", `Your patterns · ${st.withDeer} of ${st.sits} sits with deer`));
  for (const g of st.groups) {
    const row = el("div", "stats-row");
    row.append(el("span", "stats-title", g.title));
    const vals = el("span", "stats-vals");
    g.rows.forEach((r, i) => {
      const v = el("span", "stats-val", `${r.value} ${r.deer}/${r.sits}`);
      if (i === 0 && r.deer > 0 && r.sits >= 2) v.classList.add("best");
      vals.append(v);
    });
    row.append(vals);
    box.append(row);
  }
  box.append(el("p", "fine", "Sits with deer / sits logged. Log \"No deer\" when you see nothing, or every sit looks like a good one."));
}
