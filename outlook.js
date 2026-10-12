"use strict";
// Weather and moon for the day picked in the hunting-hours sheet. The moon is
// worked out on the phone (SunCalc), so it works offline; the forecast is NWS.
// Solunar periods are shown because hunters ask for them, with a note that
// GPS-collar studies found little link between the moon and deer movement.

const MOON_NAMES = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous",
                    "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];
const MOON_ICONS = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const FRONT_DROP = 8;   // °F cooler daytime high than the day before

// The instant local midnight starts `iso` in time zone `tz`
function tzMidnight(iso, tz) {
  const guess = Date.parse(iso + "T00:00:00Z");
  const p = partsIn(new Date(guess), tz);
  const offset = p.iso === iso ? p.min : p.min - 1440;
  return guess - offset * 60000;
}

function moonPhase(iso, tz) {
  const ill = SunCalc.getMoonIllumination(new Date(tzMidnight(iso, tz) + 12 * 3600000));
  const i = Math.round(ill.phase * 8) % 8;
  return { name: MOON_NAMES[i], icon: MOON_ICONS[i], lit: Math.round(ill.fraction * 100) };
}

// Moonrise, moonset, overhead and underfoot during the local day, by sampling
// the moon's altitude every 5 minutes. Any of them can be missing on a given day.
function moonEvents(iso, tz, lat, lng) {
  const start = tzMidnight(iso, tz), step = 5 * 60000, n = 24 * 12;
  const h0 = 0.133 * Math.PI / 180;
  const alt = [];
  for (let i = 0; i <= n; i++) alt.push(SunCalc.getMoonPosition(new Date(start + i * step), lat, lng).altitude);
  const out = {};
  for (let i = 1; i <= n; i++) {
    const a = alt[i - 1] - h0, b = alt[i] - h0;
    if ((a < 0) !== (b < 0)) {
      const t = start + (i - 1 + a / (a - b)) * step;
      if (a < 0) out.rise ??= t; else out.set ??= t;
    }
    if (i < n) {
      if (alt[i] > alt[i - 1] && alt[i] >= alt[i + 1]) out.over = start + i * step;
      if (alt[i] < alt[i - 1] && alt[i] <= alt[i + 1]) out.under = start + i * step;
    }
  }
  return out;
}

// Solunar periods: major = 2 hours centred on moon overhead/underfoot,
// minor = 1 hour centred on moonrise/moonset
function solunar(ev) {
  const p = [];
  for (const k of ["over", "under"]) if (ev[k]) p.push({ kind: "Major", start: ev[k] - 3600000, end: ev[k] + 3600000 });
  for (const k of ["rise", "set"]) if (ev[k]) p.push({ kind: "Minor", start: ev[k] - 1800000, end: ev[k] + 1800000 });
  return p.sort((a, b) => a.start - b.start);
}

function fmtIn(tz) {
  const f = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz });
  return t => f.format(new Date(t));
}

// Daytime high this day vs the day before, from the NWS 12-hour forecast
function frontDrop(days, iso) {
  const i = days.findIndex(d => d.date === iso);
  const a = days[i - 1]?.day?.temp, b = days[i]?.day?.temp;
  return i > 0 && a != null && b != null && a - b >= FRONT_DROP ? a - b : 0;
}

function renderOutlook(sec, place, iso, pt) {
  const [lng, lat] = pt, tz = place.tz, fmt = fmtIn(tz);
  const h = hoursOn(iso, place);

  const wx = el("div", "outlook-wx");
  wx.append(el("p", "fine", "Loading forecast…"));

  // Moon
  const ph = moonPhase(iso, tz), ev = moonEvents(iso, tz, lat, lng);
  const moon = el("div", "moon");
  const icon = el("span", "moon-icon", ph.icon); icon.setAttribute("aria-hidden", "true");
  const mt = el("div", "moon-text");
  mt.append(el("strong", null, `${ph.name} · ${ph.lit}% lit`));
  const times = [["rise", "Rise"], ["over", "Overhead"], ["set", "Set"], ["under", "Underfoot"]]
    .filter(([k]) => ev[k]).sort((a, b) => ev[a[0]] - ev[b[0]]).map(([k, l]) => `${l} ${fmt(ev[k])}`);
  mt.append(el("span", "moon-times", times.join(" · ")));
  moon.append(icon, mt);

  // Trimmed to legal hours
  const mid = tzMidnight(iso, tz);
  const sol = !h ? [] : solunar(ev)
    .map(p => ({ ...p, start: Math.max(p.start, mid + h.open * 60000), end: Math.min(p.end, mid + h.close * 60000) }))
    .filter(p => p.end - p.start >= 10 * 60000);
  const solP = el("p", "plain solunar");
  solP.textContent = sol.length
    ? `Solunar periods in legal hours: ${sol.map(p => `${p.kind} ${fmt(p.start)}–${fmt(p.end)}`).join(", ")}.`
    : "No solunar periods fall in legal hours this day.";

  const strip = el("div", "outlook-strip");
  const note = el("p", "fine",
    "Solunar times are a hunting tradition, not proven science: GPS-collar studies (Penn State, NC State, King Ranch) " +
    "found moon phase made little difference to deer movement. Temperature was the most consistent predictor, " +
    "so look for days marked as cold snaps. Pressure findings are mixed; a front passing (↓↑) usually brings the cold snap.");
  sec.append(wx, moon, solP, strip, note);
  drawStrip(strip, null, place, iso);

  getForecast(lng, lat).then(fc => {
    if (!sec.isConnected || rules.date !== iso) return;
    fillWeather(wx, fc, iso, h, tz, fmt);
    drawStrip(strip, fc, place, iso);
  });
}

function fillWeather(wx, fc, iso, h, tz, fmt) {
  wx.replaceChildren();
  if (!fc) { wx.append(el("p", "fine", "Forecast unavailable. It needs a signal the first time.")); return; }
  const d = fc.days?.find(x => x.date === iso);
  const mid = tzMidnight(iso, tz);
  const at = min => periodAt(fc, new Date(mid + min * 60000));
  const first = h && at(h.open + 15), lastH = h && at(h.close - 45);
  if (!d && !first && !lastH) {
    wx.append(el("p", "fine", "The NWS forecast covers the next 7 days."));
    return;
  }
  if (d) {
    const top = el("div", "wx-top");
    const temps = el("strong", "wx-temps",
      [d.day && `${d.day.temp}°`, d.night && `${d.night.temp}°`].filter(Boolean).join(" / "));
    const lbl = d.day && d.night ? "High / low tonight" : d.day ? "High" : "Low tonight";
    const right = el("div", "wx-sky");
    const part = d.day || d.night;
    right.append(el("span", null, part.sky), el("span", "fine", `${lbl}${part.pop ? ` · ${part.pop}% rain` : ""}`));
    top.append(temps, right);
    wx.append(top);
    const drop = frontDrop(fc.days, iso);
    if (drop) wx.append(el("div", "wx-front", `Cold snap: high ${drop}° cooler than the day before`));
  }
  const dp = dayPressure(fc, mid);
  if (dp) {
    const pe = el("div", "wx-pressure", dayPressureText(dp, fmt));
    pe.dataset.kind = dp.kind;
    wx.append(pe);
  }
  const line = (label, p, min) => {
    if (!p) return null;
    const ms = mid + min * 60000, pr = pressureAt(fc, ms);
    return el("div", "wx-hunt", `${label}: ${p.temp}°, ${windText(p)}${p.pop ? `, ${p.pop}% rain` : ""}` +
      (pr != null ? `, ${pr.toFixed(2)} in ${pressureArrow(fc, ms)}` : ""));
  };
  const rows = [line(`First light (${fmtMin(h.open)})`, first, h?.open + 15),
                line(`Last hour (${fmtMin(h.close - 60)})`, lastH, h?.close - 45)].filter(Boolean);
  if (rows.length) wx.append(...rows);
  if (d?.day?.text) wx.append(el("p", "fine wx-detail", d.day.text));
  else if (d?.night?.text) wx.append(el("p", "fine wx-detail", `Tonight: ${d.night.text}`));
  wx.append(el("p", "fine", `NWS forecast${fc.pressure ? ", pressure from Open-Meteo" : ""} · ${ageText(fc)}${fc.stale ? " (no signal)" : ""}` +
    (fc.pressure ? ". Arrows show the last 3 hours: ⇈/⇊ is a rapid change (0.06 in or more)." : "")));
}

// Seven days from today: moon, high/low, cold snaps and pressure. Tap a day to pick it.
function drawStrip(strip, fc, place, iso) {
  strip.replaceChildren();
  const today = nowIn(place.tz).iso;
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    if (!hoursOn(d, place)) break;
    const f = fc?.days?.find(x => x.date === d);
    const b = el("button", "outlook-day");
    b.type = "button";
    b.setAttribute("aria-pressed", String(d === iso));
    b.append(el("span", "od-name", i === 0 ? "Today" : fmtWxDay.format(new Date(d + "T12:00:00Z"))),
             el("span", "od-moon", moonPhase(d, place.tz).icon),
             el("span", "od-temp", f ? [f.day?.temp, f.night?.temp].map(t => t == null ? "–" : `${t}°`).join(" ") : "–"));
    const drop = fc ? frontDrop(fc.days, d) : 0;
    if (drop) b.append(el("span", "od-front", `▼${drop}°`));
    const dp = fc && dayPressure(fc, tzMidnight(d, place.tz));
    if (dp) {
      const s = el("span", "od-pressure", DAY_PRESSURE_ICON[dp.kind]);
      s.dataset.kind = dp.kind;
      s.title = dayPressureText(dp, fmtIn(place.tz));
      b.append(s);
    }
    b.onclick = () => { rules.date = d; renderRules(); };
    strip.append(b);
  }
}
