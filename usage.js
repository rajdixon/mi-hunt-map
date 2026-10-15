"use strict";
// Usage: tells the server when the app is opened, how long it's on screen and
// which features get used, so the owner can see who uses what (Settings,
// Usage, owner only). Nothing about where you are or what you saved is sent.

// Buttons and switches whose use is counted, by element id
const FEATURES = {
  "btn-search": "search", "btn-measure": "measure", "btn-draw": "draw", "btn-draw-new": "draw",
  "hours-chip": "outlook", "btn-layers": "layers", "btn-offline": "offline", "btn-save": "offline-save",
  "btn-locate": "gps", "btn-pins": "pins", "btn-tracks": "tracks", "btn-track-start": "track-record",
  "btn-pin-goto": "goto", "pin-directions": "drive", "btn-pin-share": "share-link", "btn-photo-add": "photos",
  "btn-log-save": "hunt-log", "radar-on": "radar", "scent-on": "scent", "btn-backup-export": "backup",
  "btn-settings": "settings", "btn-notes": "notifications",
};
const FEATURE_NAMES = {
  search: "Search", measure: "Measure", draw: "Lines & areas", outlook: "Hours & outlook", layers: "Layers",
  offline: "Offline maps", "offline-save": "Saved offline areas", gps: "My location", pins: "My pins", tracks: "Tracks",
  "track-record": "Recorded tracks", goto: "Go to", drive: "Driving directions", "share-link": "Shared pin links",
  photos: "Trail cam photos", "hunt-log": "Hunt log entries", radar: "Radar", scent: "Scent cones",
  backup: "Backups", settings: "Settings", notifications: "Notifications", "pin-save": "Pins saved",
};
let feats = {}, onScreenSince = document.visibilityState === "visible" ? Date.now() : 0, lastOpen = 0;
const countFeature = k => { feats[k] = (feats[k] || 0) + 1; };

document.addEventListener("click", e => {
  const t = e.target.closest?.("[id]");
  if (t && FEATURES[t.id] && t.type !== "checkbox") countFeature(FEATURES[t.id]);
}, true);
document.addEventListener("change", e => { if (e.target.checked && FEATURES[e.target.id]) countFeature(FEATURES[e.target.id]); }, true);
$("pin-form")?.addEventListener("submit", () => countFeature("pin-save"), true);

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function sendPing(open) {
  if (!syncOn || onPublicCopy) return;
  const now = Date.now(), mins = onScreenSince ? (now - onScreenSince) / 60000 : 0;
  const body = { v: APP_VERSION, app: standalone(), open, mins, feats };
  const sent = feats;
  feats = {};
  if (onScreenSince) onScreenSince = now;
  try {
    const res = await fetch("/api/ping", { method: "POST", redirect: "manual", credentials: "same-origin", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(res.status);
  } catch {
    for (const [k, n] of Object.entries(sent)) feats[k] = (feats[k] || 0) + n;   // try again next time
  }
}

// An "open" is the app coming on screen after at least 30 minutes away
function maybeOpen() {
  if (Date.now() - lastOpen < 30 * 60000) return sendPing(false);
  lastOpen = Date.now();
  sendPing(true);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { onScreenSince = Date.now(); maybeOpen(); }
  else { sendPing(false); onScreenSince = 0; }
});
setInterval(() => { if (document.visibilityState === "visible") sendPing(false); }, 5 * 60000);
// Sync decides whether we're on the server; wait for it
(function waitForSync(n = 0) {
  if (syncOn) return maybeOpen();
  if (n < 30) setTimeout(() => waitForSync(n + 1), 1000);
})();

// ---------- Owner: everyone's usage ----------
const isOwner = () => store.get("owner", false);

function ago(t) {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} hr ago`;
  return `${Math.round(m / 1440)} days ago`;
}
const hrs = m => m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} hr`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const shortDay = d => new Date(d + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" });

function dauChart(days) {
  const max = Math.max(1, ...days.map(d => d.users));
  const box = el("div", "use-chart");
  box.setAttribute("role", "img");
  box.setAttribute("aria-label", `People using the app each day, last 30 days. Most in a day: ${max}.`);
  for (const d of days) {
    const bar = el("div", "use-bar");
    bar.style.setProperty("--h", `${(d.users / max) * 100}%`);
    bar.title = `${shortDay(d.day)}: ${plural(d.users, "person")}`;
    if (!d.users) bar.classList.add("zero");
    box.append(bar);
  }
  const axis = el("div", "use-axis");
  axis.append(el("span", null, shortDay(days[0].day)), el("span", null, "Today"));
  const wrap = el("div", "use-chart-wrap");
  wrap.append(box, axis);
  return wrap;
}

function strip(active, today) {
  // Last 30 days, oldest first, one cell per day used
  const set = new Set(active), s = el("div", "use-strip");
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400e3).toLocaleDateString("en-CA", { timeZone: "America/Detroit" });
    const c = el("span", set.has(d) ? "on" : "");
    c.title = `${shortDay(d)}${set.has(d) ? ": used" : ""}`;
    s.append(c);
  }
  return s;
}

function userCard(u) {
  const card = el("li", "use-user");
  const head = el("div", "use-head");
  const who = el("div", "use-who");
  who.append(el("span", "use-name", u.name), el("span", "use-email", u.email));
  const tags = el("div", "use-tags");
  if (u.owner) tags.append(el("span", "use-tag", "Owner"));
  if (u.partner) tags.append(el("span", "use-tag", "Partner"));
  if (u.today) tags.append(el("span", "use-tag on", "Today"));
  head.append(who, tags);

  const nums = el("dl", "use-nums");
  const num = (v, label) => { const d = el("div"); d.append(el("dt", null, label), el("dd", null, v)); nums.append(d); };
  num(ago(u.last), "Last seen");
  num(`${u.days7} / 7`, "Days this week");
  num(`${u.days30} / 30`, "Days this month");
  num(hrs(u.mins30), "Time in 30 days");

  const rows = el("dl", "rows use-rows");
  const row = (k, v) => { if (v) rows.append(el("dt", null, k), el("dd", null, v)); };
  const c = u.content;
  row("Saved", [plural(c.pins, "pin"), `${c.logs} log ${c.logs === 1 ? "entry" : "entries"}`, plural(c.photos, "photo"),
    plural(c.tracks, "track"), `${c.shapes} ${c.shapes === 1 ? "line or area" : "lines and areas"}`].join(" · "));
  if (c.shared) row("Shared", `${c.shared} with partners`);
  const top = Object.entries(u.feats).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => `${FEATURE_NAMES[k] || k} ${n}`).join(" · ");
  row("Most used", top || "Nothing yet in the last 30 days");
  row("Opens", u.opens30 ? `${u.opens30} in 30 days` : "");
  row("Devices", u.devices.map(d => `${d.label} (${ago(d.t)})`).join(", "));
  row("Version", u.version || "");
  row("First seen", u.first ? new Date(u.first).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "Before usage tracking");

  card.append(head, nums, strip(u.active, u.today), rows);
  return card;
}

async function renderUsage() {
  const box = $("usage-body");
  box.replaceChildren(el("p", "fine lead", "Loading…"));
  let data;
  try {
    const res = await fetch("/api/usage", { redirect: "manual", credentials: "same-origin" });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    box.replaceChildren(el("p", "fine lead", navigator.onLine ? "Couldn't load usage from the server." : "Usage needs a signal."));
    return;
  }
  const u = data.users;
  const sum = el("dl", "use-nums use-summary");
  const s = (v, label) => { const d = el("div"); d.append(el("dt", null, label), el("dd", null, String(v))); sum.append(d); };
  s(u.length, "People");
  s(u.filter(x => x.today).length, "Today");
  s(u.filter(x => x.days7).length, "This week");
  s(hrs(u.reduce((a, x) => a + x.mins7, 0)), "Time this week");
  const list = el("ul", "use-list");
  u.forEach(x => list.append(userCard(x)));
  box.replaceChildren(
    sum,
    el("h3", "sheet-sub", "People using it each day"),
    dauChart(data.days),
    el("h3", "sheet-sub", "Everyone"),
    list,
    el("p", "fine", `Counted since ${new Date(data.since).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}. Time is while the app is open on screen. "Most used" counts taps in the last 30 days. Saved counts come from what each person has synced. Only you can see this.`),
  );
}

function openUsage() {
  if (!isOwner()) return;
  openSheet("sheet-usage");
  renderUsage();
}
