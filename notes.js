"use strict";
// Notifications: the bell in the top bar shows how many are unread and opens
// the list. Phone alerts (Web Push) are turned on per device from the same
// panel; on iPhone they only work in the app added to the Home Screen.

let notes = { items: [], unread: 0, prefs: {}, kinds: {}, subs: [], vapid: null, loaded: false };
const NOTE_ICON = { partner: "👥", wind: "🍃", front: "❄️", people: "👤", test: "🔔" };

function setUnread(n) {
  notes.unread = n;
  const b = $("notes-badge");
  b.hidden = !n;
  b.textContent = n > 9 ? "9+" : String(n);
  $("btn-notes").setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
  try { n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch {}
}

async function loadNotes() {
  if (!syncOn || onPublicCopy) return;
  try {
    const res = await fetch("/api/notes", { redirect: "manual", credentials: "same-origin" });
    if (!res.ok) throw new Error(res.status);
    notes = { ...(await res.json()), loaded: true };
    setUnread(notes.unread);
  } catch {}
}

const notesPost = (sub, body, method = "POST") => fetch(`/api/notes/${sub}`, {
  method, redirect: "manual", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
}).then(r => r.ok ? r.json() : Promise.reject(r.status));

function noteAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} hr ago`;
  return new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// ---------- Phone alerts ----------
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const inHomeScreenApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function mySub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

async function alertsOn() {
  if (await Notification.requestPermission() !== "granted") throw new Error("blocked");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(notes.vapid) });
  await notesPost("sub", { subscription: sub.toJSON() });
}

async function alertsOff() {
  const sub = await mySub();
  if (!sub) return;
  await notesPost("sub", { endpoint: sub.endpoint }, "DELETE").catch(() => {});
  await sub.unsubscribe();
}

async function renderAlerts(box) {
  box.replaceChildren(el("h3", "sheet-sub", "Alerts on this device"));
  const say = t => box.append(el("p", "fine", t));
  if (isIOS() && !inHomeScreenApp()) {
    return say("On iPhone, alerts only work in the app on your Home Screen. Add it (Share, then Add to Home Screen), open it from there, and turn alerts on in this panel.");
  }
  if (!pushSupported()) return say("This browser can't show alerts. The bell still collects everything here.");
  const sub = await mySub();
  const on = !!sub && Notification.permission === "granted" && notes.subs.includes(sub.endpoint);
  if (Notification.permission === "denied") {
    return say("Alerts are blocked for this site. Allow notifications for MI Hunt Land in your phone or browser settings, then come back here.");
  }
  const row = el("div", "save-actions");
  const btn = el("button", on ? "btn-ghost" : "btn-primary", on ? "Turn off alerts" : "Turn on alerts");
  btn.type = "button";
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = on ? "Turning off…" : "Turning on…";
    try { on ? await alertsOff() : await alertsOn(); await loadNotes(); }
    catch (e) { note.textContent = e.message === "blocked" ? "Alerts weren't allowed." : "Couldn't turn alerts on. Check your signal and try again."; }
    renderAlerts(box);
  };
  row.append(btn);
  if (on) {
    const test = el("button", "btn-ghost", "Send a test");
    test.type = "button";
    test.onclick = async () => { test.disabled = true; await notesPost("test").catch(() => {}); test.textContent = "Sent"; loadNotes().then(renderNoteList); };
    row.append(test);
  }
  const note = el("p", "fine", on ? "This device gets an alert for each notification you have switched on below."
    : "Get an alert on this device even when the app is closed.");
  box.append(row, note);
}

function renderPrefs(box) {
  box.replaceChildren(el("h3", "sheet-sub", "Notify me when"));
  for (const [k, label] of Object.entries(notes.kinds)) {
    if (k === "partner" && !(typeof hasPartners === "function" && hasPartners())) continue;
    box.append(toggle(label, "", notes.prefs[k], async v => {
      notes.prefs[k] = v;
      await notesPost("prefs", { prefs: { [k]: v } }).catch(() => {});
    }));
  }
  box.querySelectorAll(".layer-note:empty").forEach(n => n.remove());
}

function renderNoteList() {
  const list = $("notes-list");
  list.replaceChildren();
  $("notes-empty").hidden = notes.items.length > 0;
  $("btn-notes-clear").hidden = !notes.items.length;
  for (const n of notes.items) {
    const li = el("li");
    const b = el("button", "note-row" + (n.read ? "" : " unread"));
    b.type = "button";
    const text = el("span", "note-text");
    text.append(el("span", "note-title", n.title));
    if (n.body) text.append(el("span", "note-body", n.body));
    text.append(el("span", "note-time", noteAgo(n.t)));
    b.append(el("span", "note-ico", NOTE_ICON[n.kind] || "🔔"), text);
    if (n.at) b.onclick = () => { closeSheet("sheet-notes"); map.flyTo({ center: n.at, zoom: Math.max(map.getZoom(), 14) }); };
    else b.disabled = true;
    li.append(b);
    list.append(li);
  }
}

async function openNotes() {
  openSheet("sheet-notes");
  renderNoteList();
  await loadNotes();
  renderNoteList();
  renderPrefs($("notes-prefs"));
  renderAlerts($("notes-alerts"));
  // Opening the list reads them; they stay highlighted until next time
  if (notes.unread) { setUnread(0); notesPost("read", { all: true }).catch(() => {}); }
}

$("btn-notes").addEventListener("click", () => $("sheet-notes").hidden ? openNotes() : closeSheet("sheet-notes"));
$("btn-notes-clear").addEventListener("click", async () => {
  notes.items = []; renderNoteList(); setUnread(0);
  await notesPost("clear").catch(() => {});
});

// A tapped alert opens the app at /?note=<id>, or messages an open copy
function openFromAlert() {
  const id = new URLSearchParams(location.search).get("note");
  if (!id) return;
  history.replaceState(null, "", location.pathname + location.hash);
  openNotes();
}
navigator.serviceWorker?.addEventListener("message", e => { if (e.data?.note) openNotes(); });

if (!onPublicCopy) {
  (function waitForSync(n = 0) {
    if (syncOn) { loadNotes(); openFromAlert(); return; }
    if (n < 30) setTimeout(() => waitForSync(n + 1), 1000);
  })();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadNotes(); });
  setInterval(() => { if (document.visibilityState === "visible") loadNotes(); }, 5 * 60000);
}
