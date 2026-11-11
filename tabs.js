"use strict";
// The tab bar (bottom of a phone, top right on a wider screen): Map, Pins,
// Tools, Weather and More. Each tab opens its sheet and lights up while that
// sheet (or one opened from it) is showing; Map closes whatever is open.
// Also here: the Tools and More sheets, the on-counts on the Layers sheet's
// groups, and hiding pin and line names when zoomed out.

const TAB_OF = {
  "sheet-pins": "btn-pins", "sheet-pin-edit": "btn-pins", "sheet-shape": "btn-pins",
  "sheet-tools": "tab-tools", "sheet-tracks": "tab-tools", "sheet-offline": "tab-tools",
  "sheet-rules": "tab-weather",
  "sheet-more": "tab-more", "sheet-settings": "tab-more", "sheet-usage": "tab-more",
};
// Called by liftButtons() whenever a sheet opens or closes
function markTab(open) {
  const cur = (open && TAB_OF[open.id]) || "tab-map";
  for (const t of document.querySelectorAll("#tabbar .tab"))
    t.id === cur ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current");
}
const openSheetEl = () => [...document.querySelectorAll(".sheet")].find(s => !s.hidden);

// Map: close the open sheet the same way its × does (so its own clean-up runs)
$("tab-map").addEventListener("click", () => openSheetEl()?.querySelector(".sheet-close")?.click());
$("tab-weather").addEventListener("click", () => $("hours-chip").click());
$("tab-more").addEventListener("click", () =>
  $("sheet-more").hidden ? openSheet("sheet-more") : closeSheet("sheet-more"));

// ---------- Tools ----------
function renderTools() {
  $("tool-tracks-note").textContent = rec ? "Recording now"
    : tracks.length ? `${tracks.length} saved · record your walk in` : "Record your walk in";
  $("tool-offline-note").textContent = areas.length
    ? `${areas.length} area${areas.length > 1 ? "s" : ""} saved` : "Save the map for no signal";
}
$("tab-tools").addEventListener("click", () => {
  if (!$("sheet-tools").hidden) return closeSheet("sheet-tools");
  renderTools();
  openSheet("sheet-tools");
});
// Measure, draw and 3D happen on the map: get the sheet out of the way first
for (const id of ["btn-measure", "btn-draw", "tool-3d"])
  $(id).addEventListener("click", () => closeSheet("sheet-tools"));
$("tool-3d").addEventListener("click", () => $("btn-3d").click());

// ---------- Layers: open/closed groups and how many layers each has on ----------
const groupOpen = store.get("layer-groups", {});
function countGroups() {
  for (const d of document.querySelectorAll(".layer-group")) {
    const n = [...d.querySelectorAll("input[type=checkbox]")].filter(i => i.checked && !i.closest(".cover-list")).length;
    const c = d.querySelector(".group-count");
    c.textContent = n ? `${n} on` : "Off";
    c.classList.toggle("on", n > 0);
  }
}
for (const d of document.querySelectorAll(".layer-group")) {
  const k = d.dataset.group;
  if (k in groupOpen) d.open = groupOpen[k];
  d.addEventListener("toggle", () => { groupOpen[k] = d.open; store.set("layer-groups", groupOpen); });
}
$("sheet-layers").addEventListener("change", countGroups);
$("btn-layers").addEventListener("click", () => {
  countGroups();
  // First time: open the overlays group if something in it is already on
  const ov = document.querySelector('.layer-group[data-group="overlays"]');
  if (!("overlays" in groupOpen) && ov.querySelector(".group-count.on")) ov.open = true;
});

// ---------- Names on the map: hidden when zoomed out, where they pile up ----------
const FAR_ZOOM = 12;
function zoomLabels() { document.body.classList.toggle("far", map.getZoom() < FAR_ZOOM); }
map.on("zoomend", zoomLabels);
zoomLabels();
liftButtons();
