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

// The weather and moon parts of the hours sheet:
//   glance  summary card: a verdict, right now (on the day being planned), the day's
//           outlook, stands the wind suits, moon in one line
//   strip   7-day picker
//   detail  forecast wording, what the pressure means, moon times, solunar
function renderOutlook({ glance, strip, detail }, place, iso, pt) {
  const [lng, lat] = pt, tz = place.tz, fmt = fmtIn(tz);
  const h = hoursOn(iso, place), today = nowIn(tz).iso, isToday = iso === today;
  const showNow = iso === huntDay(place);   // today, or tomorrow after legal light ends

  const nowBox = el("div", "glance-now"), dayBox = el("div", "glance-day"), standBox = el("div", "glance-stands");
  const verdict = el("div", "verdict");
  nowBox.hidden = !showNow; standBox.hidden = true; verdict.hidden = true;
  glance.insertBefore(verdict, glance.children[1] || null);
  dayBox.append(el("p", "fine", "Loading forecast…"));

  const ph = moonPhase(iso, tz), ev = moonEvents(iso, tz, lat, lng);
  const moonLine = el("div", "glance-line");
  moonLine.append(el("span", "glance-ico", ph.icon), `${ph.name} · ${ph.lit}% lit`);
  glance.append(nowBox, dayBox, standBox, moonLine);

  // Detail: weather wording, then moon and solunar
  const wxMore = el("div", "outlook-wx");
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
  const note = el("p", "fine",
    "Solunar times are a hunting tradition, not proven science: GPS-collar studies (Penn State, NC State, King Ranch) " +
    "found moon phase made little difference to deer movement. Temperature was the most consistent predictor, " +
    "so look for days marked as cold snaps. Pressure findings are mixed; a front passing (↓↑) usually brings the cold snap.");
  detail.append(wxMore, moon, solP, note);
  drawStrip(strip, null, place, iso);

  getForecast(lng, lat).then(fc => {
    if (!glance.isConnected || rules.date !== iso) return;
    if (showNow) fillNow(nowBox, fc);
    fillDay(dayBox, fc, iso, h, tz, fmt, isToday ? "Today's outlook" : iso === addDays(today, 1) ? "Tomorrow's outlook" : "Outlook");
    const stands = fillStands(standBox, fc, iso, h, tz, pt, fmt);
    fillVerdict(verdict, fc, iso, h, tz, stands);
    fillWeatherMore(wxMore, fc, iso, tz, fmt);
    drawStrip(strip, fc, place, iso);
  });
}

// Right now: temperature, sky, wind, pressure and its 3-hour trend
function fillNow(box, fc) {
  const p = fc && periodAt(fc);
  if (!p) { box.hidden = true; return; }
  const pr = pressureAt(fc, Date.now());
  const big = el("div", "now-temp", `${p.temp}°`);
  const facts = el("div", "now-facts");
  facts.append(el("strong", null, p.sky));
  const wind = el("span");
  if (p.mph && p.dir) wind.append(windArrow(p.dir), " ");
  wind.append(`Wind ${windText(p)}`);
  facts.append(wind);
  const bits = [pr != null && `${pr.toFixed(2)} in ${TREND_WORD[pressureArrow(fc, Date.now())] || ""}`.trim(),
                p.pop ? `${p.pop}% rain` : ""].filter(Boolean);
  if (bits.length) facts.append(el("span", null, bits.join(" · ")));
  box.replaceChildren(el("div", "glance-label", `Right now${fc.stale ? " (last saved forecast)" : ""}`), el("div", "now-row"));
  box.lastChild.append(big, facts);
}

// The day: high/low, sky, cold snap, pressure, first light and last hour
function fillDay(box, fc, iso, h, tz, fmt, label) {
  box.replaceChildren();
  if (!fc) { box.append(el("p", "fine", "Forecast unavailable. It needs a signal the first time.")); return; }
  const d = fc.days?.find(x => x.date === iso);
  const mid = tzMidnight(iso, tz);
  const at = min => periodAt(fc, new Date(mid + min * 60000));
  const first = h && at(h.open + 15), lastH = h && at(h.close - 45);
  if (!d && !first && !lastH) { box.append(el("p", "fine", "The NWS forecast covers the next 7 days.")); return; }
  box.append(el("div", "glance-label", label));
  if (d) {
    const top = el("div", "wx-top");
    const temps = el("strong", "wx-temps",
      [d.day && `${d.day.temp}°`, d.night && `${d.night.temp}°`].filter(Boolean).join(" / "));
    const lbl = d.day && d.night ? "High / low tonight" : d.day ? "High" : "Low tonight";
    const right = el("div", "wx-sky");
    const part = d.day || d.night;
    right.append(el("span", null, part.sky), el("span", "fine", `${lbl}${part.pop ? ` · ${part.pop}% rain` : ""}`));
    top.append(temps, right);
    box.append(top);
    const drop = frontDrop(fc.days, iso);
    if (drop) box.append(el("div", "wx-front", `Cold snap: high ${drop}° cooler than the day before`));
  }
  const dp = dayPressure(fc, mid);
  if (dp) {
    const pe = el("div", "wx-pressure", dayPressureText(dp, fmt));
    pe.dataset.kind = dp.kind;
    box.append(pe);
  }
  const line = (label, p, min) => {
    if (!p) return null;
    const ms = mid + min * 60000, pr = pressureAt(fc, ms);
    return el("div", "wx-hunt", `${label}: ${p.temp}°, ${windText(p)}${p.pop ? `, ${p.pop}% rain` : ""}` +
      (pr != null ? `, ${pr.toFixed(2)} in ${pressureArrow(fc, ms)}` : ""));
  };
  const rows = [line(`First light (${fmtMin(h.open)})`, first, h?.open + 15),
                line(`Last hour (${fmtMin(h.close - 60)})`, lastH, h?.close - 45)].filter(Boolean);
  if (rows.length) box.append(...rows);
}

// Your stands nearby, with the stretches of legal light this day when the
// wind suits each one, and what your hunt log says works there.
// Returns { near, fit } counts for the verdict.
const STAND_RANGE_KM = 25;
function fillStands(box, fc, iso, h, tz, pt, fmt) {
  box.hidden = true; box.replaceChildren();
  const none = { near: 0, fit: 0 };
  if (!fc || !h || typeof pins === "undefined") return none;
  const near = pins.filter(p => p.winds?.length && kmBetween([p.lng, p.lat], pt) <= STAND_RANGE_KM);
  if (!near.length) return none;
  const mid = tzMidnight(iso, tz), open = mid + h.open * 60000, close = mid + h.close * 60000;
  const from = Math.max(open, Date.now()), started = from > open;
  if (from >= close) return none;   // legal light is over for the day
  const hours = fc.periods.filter(p => +new Date(p.end) > open && +new Date(p.t) < close);
  if (!hours.length) return none;
  const rows = near.map(p => ({ p, wins: windWindows(hours, p.winds, from, close) }))
    .sort((a, b) => b.wins.length - a.wins.length);
  const fit = rows.filter(x => x.wins.length);
  box.append(el("div", "glance-label", "Your stands nearby"));
  for (const x of rows) {
    const b = el("button", "glance-stand");
    b.type = "button";
    if (!x.wins.length) b.classList.add("off");
    const head = el("div", "gs-head");
    head.append(el("strong", null, x.p.name || PIN_TYPES[x.p.type]?.label || "Pin"),
      el("span", "gs-wins", x.wins.length ? x.wins.map(w => timeRange(fmt(w.start), fmt(w.end))).join(", ") : started ? "No good wind left" : "Wrong wind"));
    b.append(head);
    const pat = standPattern(x.p, hours);
    if (pat) b.append(el("span", "gs-pattern" + (pat.today ? " today" : ""), pat.text));
    b.onclick = () => { closeSheet("sheet-rules"); document.body.classList.remove("show-crosshair"); map.flyTo({ center: [x.p.lng, x.p.lat], zoom: Math.max(map.getZoom(), 15) }); };
    box.append(b);
  }
  box.append(el("p", "fine", "Times are when the forecast wind is one you picked for the stand, within legal hours."));
  box.hidden = false;
  return { near: near.length, fit: fit.length };
}

// "9:00 AM", "10:00 AM" -> "9–10 AM"
function timeRange(a, b) {
  const short = t => t.replace(/:00(?=\D|$)/, "");
  a = short(a); b = short(b);
  const ma = /\s?[AP]M$/i.exec(a), mb = /\s?[AP]M$/i.exec(b);
  if (ma && mb && ma[0].trim() === mb[0].trim()) a = a.slice(0, -ma[0].length);
  return `${a}–${b}`;
}

// Runs of forecast hours whose wind suits `good`, clipped to [from, to]
function windWindows(hours, good, from, to) {
  const out = [];
  for (const p of hours) {
    const s = Math.max(+new Date(p.t), from), e = Math.min(+new Date(p.end), to);
    if (s >= e || !windMatches(p.dir, good)) continue;
    const last = out.at(-1);
    if (last && last.end === s) last.end = e; else out.push({ start: s, end: e });
  }
  return out.filter(w => w.end - w.start >= 30 * 60000);
}

// "Deer on 4 of 5 NW-wind sits", marked when this day's wind is that wind
function standPattern(pin, hours) {
  const st = pinStats(pin);
  const best = st.groups?.find(g => g.title === "Wind")?.rows.find(r => r.sits >= 2 && r.deer > 0);
  if (!best) return st.sits ? { text: `${st.sits} sit${st.sits === 1 ? "" : "s"} logged; patterns show after 3`, today: false } : null;
  const label = best.value === "Calm" ? "calm" : `${best.value}-wind`;
  const today = hours.some(p => dir8(isCalm(p) ? "Calm" : p.dir) === best.value);
  return { text: `Your log: deer on ${best.deer} of ${best.sits} ${label} sits${today ? ` · ${best.value === "Calm" ? "calm" : best.value} is forecast` : ""}`, today };
}

// One line on how the day looks for deer movement, and why. Weighted by what
// the GPS-collar studies found: a temperature drop matters most, a pressure
// change some; strong wind, steady rain and heat keep deer bedded.
function fillVerdict(box, fc, iso, h, tz, stands) {
  box.hidden = true; box.replaceChildren();
  const d = fc?.days?.find(x => x.date === iso);
  if (!fc || !h || !d) return;
  const mid = tzMidnight(iso, tz);
  const huntHours = [periodAt(fc, new Date(mid + (h.open + 15) * 60000)), periodAt(fc, new Date(mid + (h.close - 45) * 60000))].filter(Boolean);
  const plus = [], minus = [];
  let score = 0;
  const drop = frontDrop(fc.days, iso);
  if (drop) { score += 2; plus.push(`cold snap (${drop}° cooler)`); }
  const dp = dayPressure(fc, mid);
  if (dp && dp.kind !== "steady") { score += 1; plus.push(dp.kind === "front" ? "front passing" : `pressure ${dp.kind}`); }
  if (stands.fit) { score += 1; plus.push(`${stands.fit} stand${stands.fit === 1 ? "" : "s"} fit the wind`); }
  else if (stands.near) { score -= 1; minus.push("no stand fits the wind"); }
  const windy = Math.max(0, ...huntHours.map(p => p.mph));
  if (windy >= 15) { score -= windy >= 25 ? 2 : 1; minus.push(`${windy >= 25 ? "very windy" : "windy"} (${windy} mph)`); }
  const wet = Math.max(0, ...huntHours.map(p => p.pop ?? 0));
  if (wet >= 60) { score -= 1; minus.push(`rain likely (${wet}%)`); }
  const high = d.day?.temp;
  if (high != null && high >= 70) { score -= 1; minus.push(`warm (high ${high}°)`); }
  const [label, kind] = score >= 2 ? ["Good day to hunt", "good"] : score >= 0 ? ["Fair day", "fair"] : ["Slow day", "slow"];
  box.dataset.kind = kind;
  const why = [...plus.map(x => "+ " + x), ...minus.map(x => "− " + x)];
  box.append(el("strong", "verdict-label", label),
    el("span", "verdict-why", why.length ? why.join("  ") : "Nothing stands out either way"));
  box.title = "A guide from the forecast, not a promise: temperature drops matter most in the studies, pressure changes some.";
  box.hidden = false;
}

function kmBetween(a, b) {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

// Detail: the NWS wording, what the pressure means, and where it all comes from
function fillWeatherMore(box, fc, iso, tz, fmt) {
  box.replaceChildren();
  if (!fc) return;
  const d = fc.days?.find(x => x.date === iso);
  if (d?.day?.text) box.append(el("p", "plain wx-detail", d.day.text));
  if (d?.night?.text) box.append(el("p", "plain wx-detail", `Tonight: ${d.night.text}`));
  const dp = dayPressure(fc, tzMidnight(iso, tz));
  if (dp) {
    const pe = el("div", "wx-pressure", dayPressureText(dp, fmt));
    pe.dataset.kind = dp.kind;
    box.append(pe, el("p", "fine wx-meaning", PRESSURE_MEANING[dp.kind]));
  }
  box.append(el("p", "fine", `NWS forecast${fc.pressure ? ", pressure from Open-Meteo" : ""} · ${ageText(fc)}${fc.stale ? " (no signal)" : ""}` +
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
