"use strict";
// Deer activity forecast: a 1–5 score for each day and an hour-by-hour curve
// for the day picked in the hunting-hours sheet. Weighted by what GPS-collar
// studies found (the rut and a temperature drop matter most, pressure changes
// some; strong wind, steady rain and heat keep deer bedded), then nudged by
// your own hunt log once it has enough sits. The moon is left out on purpose.

// Typical Michigan rut timing in the Lower Peninsula; the U.P. runs a few days
// earlier. [from "MM-DD", phase, day bonus, midday activity floor, what it means]
const RUT = [
  ["07-01", "Early season", 0, 0.2, "Deer are on summer and early-fall food patterns, moving mostly at first and last light."],
  ["10-15", "Pre-rut", 0.5, 0.25, "Rubs and scrapes are going up and bucks start moving more in daylight."],
  ["10-25", "Seeking", 1, 0.4, "Bucks cruise for the first does in heat. All-day sits start to pay off."],
  ["11-04", "Chasing", 2, 0.5, "The most daytime buck movement of the year. Sit as long as you can."],
  ["11-13", "Peak breeding", 1.5, 0.4, "Bucks are locked down with does, so it's hit or miss, but anything can walk by."],
  ["11-23", "Post-rut", 0, 0.25, "Worn-out bucks feed and rest. Food sources matter most."],
  ["12-05", "Second rut", 0.5, 0.3, "Does that weren't bred, and some fawns, come into heat: a short second wave."],
  ["12-20", "Late season", 0, 0.2, "Cold and food drive movement. Hunt near the best food on the coldest days."],
];
const UP_EARLIER = 3;    // days
const MIN_LOG_SITS = 8;  // sits across all your pins before your log counts

function rutPhase(iso, place) {
  const md = addDays(iso, place?.peninsula === "UP" ? UP_EARLIER : 0).slice(5);
  let row = RUT.at(-1);   // January to June
  for (const r of RUT) if (md >= r[0]) row = r;
  const [, name, bonus, floor, note] = row;
  return { name, bonus, floor, note };
}

// ---------- Your hunt log, across all your pins ----------
// Deer-seen rate overall, and for the conditions given; each value is pulled
// toward the overall rate until it has a few sits behind it.
function logRates() {
  const sits = (typeof pins === "undefined" ? [] : pins).flatMap(pinSits);
  if (sits.length < MIN_LOG_SITS) return null;
  const p0 = sits.filter(s => s.deer).length / sits.length;
  if (!p0) return null;
  const rate = (f, v) => {
    const m = sits.filter(s => f(s) === v), deer = m.filter(s => s.deer).length;
    return { value: v, deer, sits: m.length, lift: (deer + 3 * p0) / (m.length + 3) / p0 };
  };
  return {
    sits: sits.length,
    temp: t => rate(s => tempBand(s.wx.temp), tempBand(t)),
    press: dp => rate(s => pressBand(s.wx.dp), pressBand(dp)),
    time: am => rate(s => s.am, am),
  };
}

// ---------- The day ----------
// { stars 1–5, label, kind, plus, minus, rut } or null without a forecast
function dayActivity(fc, iso, place, pt, log = logRates()) {
  const d = fc?.days?.find(x => x.date === iso), h = hoursOn(iso, place);
  if (!d || !h) return null;
  const tz = place.tz, mid = tzMidnight(iso, tz);
  const at = min => mid + min * 60000;
  const hunt = [at(h.open + 15), at(h.close - 45)].map(t => ({ t, p: periodAt(fc, new Date(t)) })).filter(x => x.p);
  const plus = [], minus = [];
  let score = 0;

  const rut = rutPhase(iso, place);
  if (rut.bonus) { score += rut.bonus; plus.push(rut.name.toLowerCase() + (rut.name.includes("rut") ? "" : " phase of the rut")); }
  const drop = frontDrop(fc.days, iso);
  if (drop) { score += 2; plus.push(`cold snap (${drop}° cooler)`); }
  const dp = dayPressure(fc, mid);
  if (dp && dp.kind !== "steady") { score += 1; plus.push(dp.kind === "front" ? "front passing" : `pressure ${dp.kind}`); }
  const st = standFit(fc, mid, h, pt);
  if (st.fit) { score += 1; plus.push(`${st.fit} stand${st.fit === 1 ? "" : "s"} fit the wind`); }
  else if (st.near) { score -= 1; minus.push("no stand fits the wind"); }
  const windy = Math.max(0, ...hunt.map(x => x.p.mph));
  if (windy >= 15) { score -= windy >= 25 ? 2 : 1; minus.push(`${windy >= 25 ? "very windy" : "windy"} (${windy} mph)`); }
  const wet = Math.max(0, ...hunt.map(x => x.p.pop ?? 0));
  if (wet >= 60) { score -= 1; minus.push(`rain likely (${wet}%)`); }
  const high = d.day?.temp;
  if (high != null && high >= 70) { score -= 1; minus.push(`warm (high ${high}°)`); }

  // Your log: how often you saw deer at this temperature and pressure trend
  if (log && hunt.length) {
    const temp = Math.round(hunt.reduce((a, x) => a + x.p.temp, 0) / hunt.length);
    const dps = hunt.map(x => [pressureAt(fc, x.t), pressureAt(fc, x.t - 3 * 3600000)]).filter(([a, b]) => a != null && b != null);
    const rows = [log.temp(temp)];
    if (dps.length) rows.push(log.press(dps.reduce((a, [x, y]) => a + x - y, 0) / dps.length));
    const lift = rows.reduce((a, r) => a * r.lift, 1);
    const tell = rows.filter(r => r.sits >= 3).sort((a, b) => Math.abs(b.lift - 1) - Math.abs(a.lift - 1))[0];
    const words = r => `your log: deer on ${r.deer} of ${r.sits} sits ${/°/.test(r.value) ? `at ${r.value}` : `with ${r.value.toLowerCase()} pressure`}`;
    if (tell && lift >= 1.3) { score += 1; plus.push(words(tell)); }
    else if (tell && lift <= 0.7) { score -= 1; minus.push(words(tell)); }
  }

  const stars = score <= -2 ? 1 : score < 0 ? 2 : score < 2 ? 3 : score < 3.5 ? 4 : 5;
  const [label, kind] = [, ["Slow day", "slow"], ["Slow day", "slow"], ["Fair day", "fair"], ["Good day to hunt", "good"], ["Great day to hunt", "good"]][stars];
  return { stars, label, kind, plus, minus, rut };
}

// Your stands nearby with a wind set, and how many get their wind in legal light
function standFit(fc, mid, h, pt) {
  if (typeof pins === "undefined") return { near: 0, fit: 0 };
  const near = pins.filter(p => p.winds?.length && kmBetween([p.lng, p.lat], pt) <= STAND_RANGE_KM);
  const open = mid + h.open * 60000, close = mid + h.close * 60000, from = Math.max(open, Date.now());
  if (!near.length || from >= close) return { near: 0, fit: 0 };
  const hours = fc.periods.filter(p => +new Date(p.end) > open && +new Date(p.t) < close);
  if (!hours.length) return { near: 0, fit: 0 };
  return { near: near.length, fit: near.filter(p => windWindows(hours, p.winds, from, close).length).length };
}

// ---------- Hour by hour ----------
// Deer are most active around first and last light; the rut lifts midday.
// Each hour is then raised or lowered by its weather and by the day's score.
// [{ start, end, v 0–1+, past, stands: [names whose wind fits] }]
function hourlyActivity(fc, iso, place, pt, act, log = logRates()) {
  const h = hoursOn(iso, place);
  if (!h) return [];
  const mid = tzMidnight(iso, place.tz), open = mid + h.open * 60000, close = mid + h.close * 60000;
  const dawn = open + 45 * 60000, dusk = close - 30 * 60000, sd = 70 * 60000;
  const g = x => Math.exp(-0.5 * (x / sd) ** 2);
  const floor = act?.rut.floor ?? rutPhase(iso, place).floor;
  const scale = act ? 0.6 + 0.1 * act.stars : 0.9;
  const amLift = log && Math.min(1.25, Math.max(0.75, log.time(true).lift));
  const pmLift = log && Math.min(1.25, Math.max(0.75, log.time(false).lift));
  // Same stretches of good wind the stand list shows (at least half an hour)
  const periods = fc.periods.filter(p => +new Date(p.end) > open && +new Date(p.t) < close);
  const stands = (typeof pins === "undefined" ? [] : pins)
    .filter(p => p.winds?.length && kmBetween([p.lng, p.lat], pt) <= STAND_RANGE_KM)
    .map(p => ({ name: p.name || PIN_TYPES[p.type]?.label || "Pin", wins: windWindows(periods, p.winds, open, close) }));
  const out = [];
  for (let s = open - (open % 3600000); s < close; s += 3600000) {
    const a = Math.max(s, open), b = Math.min(s + 3600000, close), c = (a + b) / 2;
    if (b - a < 10 * 60000) continue;
    let v = floor + (1 - floor) * Math.max(g(c - dawn), g(c - dusk));
    const p = periodAt(fc, new Date(c));
    if (p) {
      if (p.temp >= 70) v *= 0.7; else if (p.temp >= 60) v *= 0.85;
      if (p.mph >= 25) v *= 0.6; else if (p.mph >= 15) v *= 0.8;
      if ((p.pop ?? 0) >= 60) v *= 0.75;
      const pr = pressureAt(fc, c), before = pressureAt(fc, c - 3 * 3600000);
      if (pr != null && before != null && Math.abs(pr - before) >= 0.04) v *= 1.15;
    }
    if (log) v *= c < mid + 12 * 3600000 ? amLift : pmLift;
    out.push({ start: a, end: b, v: v * scale, past: b <= Date.now(),
               stands: stands.filter(x => x.wins.some(w => w.start < b && w.end > a)).map(x => x.name) });
  }
  return out;
}

// The best one to three stretches still ahead, with the stands whose wind fits
function bestWindows(hours) {
  const ahead = hours.filter(x => !x.past);
  if (!ahead.length) return [];
  const top = Math.max(...ahead.map(x => x.v)), runs = [];
  for (const x of ahead) {
    if (x.v < top * 0.8) continue;
    const last = runs.at(-1);
    if (last && last.end === x.start) { last.end = x.end; last.sum += x.v; last.hours.push(x); }
    else runs.push({ start: x.start, end: x.end, sum: x.v, hours: [x] });
  }
  return runs.sort((a, b) => b.sum - a.sum).slice(0, 3).sort((a, b) => a.start - b.start).map(r => ({
    ...r, stands: [...new Set(r.hours.flatMap(x => x.stands))].filter(n => r.hours.filter(x => x.stands.includes(n)).length * 2 >= r.hours.length),
  }));
}

const LEVEL = v => v >= 0.75 ? "high" : v >= 0.45 ? "mid" : "low";

// The curve for the hours sheet: bars, a time axis, and the best times
function activityChart(hours, fmt) {
  const box = el("div", "act");
  box.append(el("div", "glance-label", "Deer activity by hour"));
  const bars = el("div", "act-bars");
  bars.style.gridTemplateColumns = `repeat(${hours.length}, minmax(0, 1fr))`;
  const axis = el("div", "act-axis");
  axis.style.gridTemplateColumns = bars.style.gridTemplateColumns;
  const label = t => fmt(t).replace(/:00(?=\D|$)/, "").replace(/\s?([AP])M$/i, (_, x) => x.toLowerCase());
  hours.forEach((x, i) => {
    const bar = el("div", "act-bar");
    bar.dataset.level = LEVEL(x.v);
    if (x.past) bar.classList.add("past");
    bar.style.height = `${Math.round(Math.min(1, x.v / 1.1) * 100)}%`;
    bar.title = `${timeRange(fmt(x.start), fmt(x.end))}: ${{ high: "high", mid: "moderate", low: "low" }[LEVEL(x.v)]}` +
      (x.stands.length ? ` · wind fits ${x.stands.join(", ")}` : "");
    const col = el("div", "act-col");
    col.append(bar);
    if (x.stands.length) col.append(el("span", "act-fit"));
    bars.append(col);
    axis.append(el("span", null, i % 3 === 0 ? label(x.start) : ""));
  });
  box.append(bars, axis);
  const best = bestWindows(hours);
  if (best.length) box.append(el("div", "act-best", "Best: " + best.map(w =>
    timeRange(fmt(w.start), fmt(w.end)) + (w.stands.length ? ` (${w.stands.join(", ")})` : "")).join(" · ")));
  box.append(el("p", "fine", "Taller bars, more movement expected. A green dot means the wind fits one of your stands that hour."));
  return box;
}

// Five small bars for the 7-day strip
function activityPips(act) {
  const s = el("span", "od-score");
  s.dataset.kind = act.kind;
  s.setAttribute("aria-label", `Activity ${act.stars} of 5`);
  s.title = `${act.label}: ${act.stars} of 5`;
  for (let i = 1; i <= 5; i++) s.append(el("i", i <= act.stars ? "on" : null));
  return s;
}
