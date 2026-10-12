"use strict";
// Hourly wind and weather from the National Weather Service (api.weather.gov).
// Forecasts are cached per ~4 km cell for an hour, and the last one is kept
// so it still shows (marked as old) with no signal.

const DIRS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DIR_DEG = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
                  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const WX_TTL = 60 * 60 * 1000;
const wxMem = new Map();

function wxKey(lng, lat) { return `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`; }

// Resolves { periods: [{ t, end, dir, mph, temp, sky, pop }], days: [{ date, name, day, night }],
// pressure, fetched, stale } or null. `days` comes from the 12-hour forecast and may be
// empty; `pressure` (from Open-Meteo, since NWS has none) may be null.
async function getForecast(lng, lat) {
  const key = wxKey(lng, lat);
  let fc = wxMem.get(key) || store.get("wx2:" + key, null);
  if (fc && Date.now() - fc.fetched < WX_TTL) return fc;
  try {
    const pt = await (await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`)).json();
    const url = pt.properties?.forecastHourly;
    if (!url) throw new Error("No forecast for this point");
    const [hourly, daily, pressure] = await Promise.all([
      fetch(url).then(r => r.json()),
      fetch(pt.properties.forecast).then(r => r.json()).catch(() => null),
      getPressure(lng, lat).catch(() => null),
    ]);
    const periods = (hourly.properties?.periods || []).slice(0, 168).map(p => ({
      t: p.startTime, end: p.endTime, dir: p.windDirection, mph: parseInt(p.windSpeed, 10) || 0,
      temp: p.temperature, sky: p.shortForecast, pop: p.probabilityOfPrecipitation?.value ?? null,
    }));
    if (!periods.length) throw new Error("Empty forecast");
    fc = { periods, days: dailyDays(daily), pressure, fetched: Date.now() };
    wxMem.set(key, fc);
    store.set("wx2:" + key, fc);
    return fc;
  } catch {
    return fc ? { ...fc, stale: true } : null;
  }
}

// ---------- Pressure ----------
// Hourly sea-level pressure from Open-Meteo, from yesterday through the next
// 8 days, as { t0, p: [inHg per hour] }
async function getPressure(lng, lat) {
  const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lng.toFixed(3), hourly: "pressure_msl",
    past_days: "1", forecast_days: "8", timeformat: "unixtime", timezone: "GMT" });
  const h = (await (await fetch(url)).json()).hourly;
  if (!h?.time?.length) throw new Error("No pressure data");
  return { t0: h.time[0] * 1000, p: h.pressure_msl.map(v => v == null ? null : +(v * 0.02953).toFixed(2)) };
}

function pressureAt(fc, ms) {
  const pr = fc?.pressure;
  if (!pr) return null;
  const i = Math.round((ms - pr.t0) / 3600000);
  return pr.p[i] ?? null;
}

// Change over the 3 hours before `ms`: 0.06 in or more is a rapid change
function pressureArrow(fc, ms) {
  const a = pressureAt(fc, ms - 3 * 3600000), b = pressureAt(fc, ms);
  if (a == null || b == null) return "";
  const d = b - a;
  return d >= 0.06 ? "⇈" : d >= 0.02 ? "↑" : d <= -0.06 ? "⇊" : d <= -0.02 ? "↓" : "→";
}

// What pressure does over a local day starting at `mid` (ms):
// { kind: "front" | "rising" | "falling" | "steady", fast, change, low, lowAt, start }
function dayPressure(fc, mid) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const v = pressureAt(fc, mid + i * 3600000);
    if (v != null) pts.push([mid + i * 3600000, v]);
  }
  if (pts.length < 20) return null;
  const start = pts[0][1], end = pts.at(-1)[1];
  const low = pts.reduce((m, x) => x[1] < m[1] ? x : m);
  const change = +(end - start).toFixed(2);
  if (low[1] <= start - 0.06 && low[1] <= end - 0.06)
    return { kind: "front", change, low: low[1], lowAt: low[0], start };
  const kind = Math.abs(change) < 0.04 ? "steady" : change > 0 ? "rising" : "falling";
  return { kind, fast: Math.abs(change) >= 0.15, change, start };
}

function dayPressureText(dp, fmt) {
  if (!dp) return "";
  const sign = n => (n > 0 ? "+" : "") + n.toFixed(2);
  if (dp.kind === "front") return `Front passes: pressure bottoms out at ${dp.low.toFixed(2)} in around ${fmt(dp.lowAt)}, then rises`;
  if (dp.kind === "steady") return `Pressure steady near ${dp.start.toFixed(2)} in`;
  return `Pressure ${dp.kind}${dp.fast ? " fast" : ""} (${sign(dp.change)} in over the day)`;
}
const DAY_PRESSURE_ICON = { front: "↓↑", rising: "↑", falling: "↓", steady: "→" };

// Group the NWS 12-hour periods into calendar days (in the forecast office's
// time zone, which the timestamps carry): the daytime high and that night's low
function dailyDays(daily) {
  const days = new Map();
  for (const p of daily?.properties?.periods || []) {
    const date = p.startTime.slice(0, 10);
    const d = days.get(date) || { date, name: p.name };
    const part = { temp: p.temperature, sky: p.shortForecast, text: p.detailedForecast,
                   pop: p.probabilityOfPrecipitation?.value ?? null, wind: `${p.windDirection} ${p.windSpeed}`.trim() };
    if (p.isDaytime) { d.day = part; d.name = p.name; } else d.night = part;
    days.set(date, d);
  }
  return [...days.values()];
}

function periodAt(fc, when = new Date()) {
  const t = +when;
  return fc?.periods.find(p => t >= +new Date(p.t) && t < +new Date(p.end)) || null;
}

// A 16-point wind ("NNW") counts for either neighbouring 8-point choice (N or NW)
function windMatches(dir, good) {
  if (!dir || !good?.length) return false;
  if (good.includes(dir)) return true;
  const deg = DIR_DEG[dir];
  if (deg == null) return false;
  return good.some(g => Math.abs(((DIR_DEG[g] - deg + 540) % 360) - 180) <= 22.5);
}

// Local hour/date at a place, for comparing forecast hours to legal hunting hours
function partsIn(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

// Stretches of forecast hours with a good wind, trimmed to legal hunting
// hours when the rules data knows them for this spot
function goodWindows(fc, good, lng, lat, limit = 3) {
  if (!fc || !good?.length) return [];
  const place = typeof placeAt === "function" && rules.data ? placeAt([lng, lat]) : null;
  // The part of an hour that falls inside legal hours, as [start, end] ms
  const legalPart = p => {
    const s = +new Date(p.t), e = +new Date(p.end);
    if (!place) return [s, e];
    const loc = partsIn(new Date(s), place.tz), h = hoursOn(loc.iso, place);
    if (!h) return null;
    const dayStart = s - loc.min * 60000;
    const a = Math.max(s, dayStart + h.open * 60000), b = Math.min(e, dayStart + h.close * 60000);
    return a < b ? [a, b] : null;
  };
  const now = Date.now(), out = [];
  let cur = null;
  for (const p of fc.periods) {
    if (+new Date(p.end) <= now) continue;
    const part = windMatches(p.dir, good) ? legalPart(p) : null;
    if (part) {
      if (cur && cur.end === part[0]) cur.end = part[1];
      else { if (cur) out.push(cur); cur = { start: Math.max(part[0], now), end: part[1] }; }
    } else if (cur) { out.push(cur); cur = null; }
    if (out.length >= limit) break;
  }
  if (cur && out.length < limit) out.push(cur);
  return out;
}

const fmtWxDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const fmtWxHour = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const fmtWxTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function fmtWindow(w) {
  const a = new Date(w.start), b = new Date(w.end);
  const today = new Date().toDateString() === a.toDateString();
  const t = d => d.getMinutes() ? fmtWxTime.format(d) : fmtWxHour.format(d);
  return `${today ? "Today" : fmtWxDay.format(a)} ${t(a)}–${t(b)}`;
}

function windText(p) { return !p ? "" : (!p.mph || !p.dir) ? "Calm" : `${p.dir} ${p.mph} mph`; }

// Small arrow pointing where the wind blows toward
function windArrow(dir) {
  const s = document.createElement("span");
  s.className = "wind-arrow";
  s.textContent = "↓";
  s.style.transform = `rotate(${DIR_DEG[dir] ?? 0}deg)`;
  s.setAttribute("aria-hidden", "true");
  return s;
}

function ageText(fc) {
  const m = Math.round((Date.now() - fc.fetched) / 60000);
  return m < 2 ? "just updated" : m < 60 ? `updated ${m} min ago` : `updated ${Math.round(m / 60)} hr ago`;
}

// Wind card at the top of the pins sheet
async function renderWindCard() {
  const box = $("wind-card");
  const { pt, source } = rulesPoint();
  box.replaceChildren(el("div", "fine", "Loading wind forecast…"));
  const fc = await getForecast(pt[0], pt[1]);
  box.replaceChildren();
  if (!fc) { box.append(el("div", "fine", "Wind forecast unavailable. It needs a signal the first time.")); return; }
  const now = periodAt(fc) || fc.periods[0];
  const head = el("div", "wind-now");
  if (now.mph && now.dir) head.append(windArrow(now.dir));
  head.append(el("strong", null, windText(now)), el("span", "wind-sky", `${now.temp}°F · ${now.sky}`));
  const strip = el("div", "wind-strip");
  for (const p of fc.periods.filter(p => +new Date(p.end) > Date.now()).slice(0, 12)) {
    const c = el("div", "wind-hour");
    const calm = !p.mph || !p.dir;
    c.append(el("span", "wind-h", fmtWxHour.format(new Date(p.t))));
    if (calm) c.append(el("span", "wind-calm", "Calm"));
    else c.append(windArrow(p.dir), el("span", null, p.dir), el("span", "wind-mph", `${p.mph}`));
    c.append(el("span", "wind-temp", `${p.temp}°`));
    strip.append(c);
  }
  const more = el("button", "more-btn", "7-day forecast and moon ›");
  more.addEventListener("click", () => { closeSheet("sheet-pins"); rules.date = null; renderRules(); openSheet("sheet-rules"); });
  box.append(head, strip, more, el("div", "fine wind-meta", `NWS forecast for ${source} · ${ageText(fc)}${fc.stale ? " (no signal)" : ""}`));
}
