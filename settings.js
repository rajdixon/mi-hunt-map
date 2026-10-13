"use strict";
// Settings (gear in the top bar): text size, night mode, keep the screen on,
// map labels and go-to walking pace. Kept on this phone only.

const TEXT_SIZES = [["Small", 0.9], ["Normal", 1], ["Large", 1.15], ["Extra large", 1.3]];
const PACES = [["Slow", 1.5], ["Normal", 2], ["Fast", 3]];   // mph, for go-to walking times
const settings = { text: 1, night: false, awake: false, labels: true, pace: 2, ...store.get("settings", {}) };
let awakeLock = null;

function applySettings() {
  document.documentElement.style.setProperty("--ui-zoom", settings.text);
  document.body.classList.toggle("night", settings.night);
  document.body.classList.toggle("no-labels", !settings.labels);
  document.querySelector('meta[name="theme-color"]').content = settings.night ? "#000000" : "#1d2419";
  holdAwake();
}
function setSetting(k, v) {
  settings[k] = v; store.set("settings", settings);
  applySettings(); renderSettings();
  if (k === "pace" && typeof renderGoto === "function") renderGoto();
}
const walkMps = () => settings.pace * 1609.34 / 3600;

// Screen on while the app is open; phones drop the lock when you switch away
async function holdAwake() {
  if (!settings.awake) { awakeLock?.release().catch(() => {}); awakeLock = null; return; }
  if (awakeLock || document.visibilityState !== "visible") return;
  try {
    awakeLock = await navigator.wakeLock.request("screen");
    awakeLock.addEventListener("release", () => { awakeLock = null; });
  } catch { awakeLock = null; }
}
document.addEventListener("visibilitychange", holdAwake);

function choice(name, options, value, set) {
  const g = el("div", "seg"); g.setAttribute("role", "radiogroup"); g.setAttribute("aria-label", name);
  for (const [label, v] of options) {
    const b = el("button", null, label); b.type = "button"; b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(v === value));
    b.onclick = () => set(v);
    g.append(b);
  }
  return g;
}
function toggle(text, note, on, set) {
  const label = el("label", "share-check setting-row");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = on;
  cb.onchange = () => set(cb.checked);
  const t = el("span"); t.append(el("span", "layer-name", text), el("span", "layer-note", note));
  label.append(cb, t);
  return label;
}

function renderSettings() {
  const box = $("settings-body");
  if (!box) return;
  box.replaceChildren(
    el("h3", "sheet-sub", "Text size"),
    choice("Text size", TEXT_SIZES, settings.text, v => setSetting("text", v)),
    el("p", "fine", "Makes buttons, panels and labels bigger. The map itself zooms with your fingers as usual."),
    el("h3", "sheet-sub", "In the field"),
    toggle("Night mode", "Red, dimmed screen that keeps your night vision in a dark stand", settings.night, v => setSetting("night", v)),
    toggle("Keep the screen on", "While the app is open. Uses more battery; the screen still turns off when you lock the phone", settings.awake, v => setSetting("awake", v)),
    toggle("Names on the map", "Labels under pins, lines and areas", settings.labels, v => setSetting("labels", v)),
    el("h3", "sheet-sub", "Go-to walking pace"),
    choice("Walking pace", PACES.map(([l, v]) => [`${l} · ${v} mph`, v]), settings.pace, v => setSetting("pace", v)),
    el("p", "fine", "Used for the walking time in Go to. 2 mph is a steady pace through the woods."),
  );
  const about = el("div", "settings-about");
  const guide = el("a", "btn-ghost link-btn", "User guide (PDF)");
  guide.href = "docs/MI-Hunt-Land-Guide.pdf"; guide.target = "_blank"; guide.rel = "noopener";
  const update = el("button", "btn-ghost", "Check for update");
  update.type = "button";
  update.onclick = async () => {
    update.textContent = "Checking…";
    try { await (await navigator.serviceWorker?.getRegistration())?.update(); } catch {}
    setTimeout(() => location.reload(), 800);
  };
  const acts = el("div", "save-actions"); acts.append(guide, update);
  about.append(el("h3", "sheet-sub", "About"), acts,
    el("p", "fine", `Version ${APP_VERSION}. Settings are saved on this phone only.`));
  box.append(about);
}

const APP_VERSION = "2026-10-13";
$("btn-settings").addEventListener("click", () => {
  if (!$("sheet-settings").hidden) return closeSheet("sheet-settings");
  renderSettings();
  openSheet("sheet-settings");
});
applySettings();
