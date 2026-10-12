"use strict";
// Photos on pins (trail cam pictures mostly), stored on your server. The phone
// shrinks each picture before upload (a full copy up to 2048 px and a small
// thumbnail) and keeps the time the camera took it, read from the photo's
// EXIF data. The list of photos lives on the pin, so it syncs like the rest.
// Only on the server copy: the public copy has nowhere to keep them.

const PHOTO_FULL = 2048, PHOTO_THUMB = 360;
let viewer = null;   // { pin, i }

const photoUrl = (id, size) => `/api/photos/${id}/${size}`;
const newPhotoId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).toLowerCase();

// "2026:10:12 06:42:10" from the EXIF block of a JPEG, as a local Date, or null
function exifTime(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let o = 2;
  while (o + 4 < v.byteLength) {
    const marker = v.getUint16(o), len = v.getUint16(o + 2);
    if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return tiffTime(v, o + 10);   // "Exif"
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    o += 2 + len;
  }
  return null;
}
function tiffTime(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const tag = (ifd, want) => {
    const n = u16(t + ifd);
    for (let i = 0; i < n; i++) {
      const e = t + ifd + 2 + i * 12;
      if (u16(e) === want) return { count: u32(e + 4), value: u32(e + 8) };
    }
    return null;
  };
  const str = tg => tg && String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + t + tg.value, Math.min(tg.count, 19)));
  try {
    const exif = tag(u32(t + 4), 0x8769);
    const s = (exif && str(tag(exif.value, 0x9003))) || str(tag(u32(t + 4), 0x0132));
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s || "");
    if (!m) return null;
    const d = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d) || d.getFullYear() < 2000 ? null : d;
  } catch { return null; }
}

// Shrink to `max` px on the long side; browsers apply the EXIF rotation when drawing
function resize(img, max, quality) {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((ok, fail) => c.toBlob(b => b ? ok(b) : fail(new Error("Couldn't read photo")), "image/jpeg", quality));
}

function loadImage(file) {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error("Not a photo this phone can read")); };
    img.src = url;
  });
}

async function putPhoto(id, size, blob) {
  const res = await fetch(photoUrl(id, size), { method: "PUT", body: blob, headers: { "Content-Type": "image/jpeg" }, redirect: "manual" });
  if (res.type === "opaqueredirect" || res.status === 403) throw new Error("Signed out of the server. Reload to sign in.");
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

async function addPhotos(files) {
  const p = editing, note = $("photo-note");
  if (!p?.id || !files.length) return;
  const added = [];
  let failed = 0, lastErr = "";
  for (let i = 0; i < files.length; i++) {
    note.textContent = `Uploading ${i + 1} of ${files.length}…`;
    try {
      const f = files[i];
      const t = exifTime(await f.slice(0, 256 * 1024).arrayBuffer()) || new Date(f.lastModified || Date.now());
      const img = await loadImage(f);
      const id = newPhotoId();
      await putPhoto(id, "full", await resize(img, PHOTO_FULL, 0.85));
      await putPhoto(id, "thumb", await resize(img, PHOTO_THUMB, 0.75));
      added.push({ id, t: t.toISOString(), added: Date.now(), note: "" });
    } catch (e) {
      failed++; lastErr = e.message;
      if (!navigator.onLine) { lastErr = "No signal. Photos need a signal to upload."; break; }
    }
  }
  if (added.length) {
    updatePin(p.id, q => {
      const log = [...(q.log || [])];
      // Pulling a camera card counts as checking the camera
      if (q.type === "cam") log.push({ id: newId(), kind: "check", t: new Date().toISOString(), text: `${added.length} photo${added.length === 1 ? "" : "s"} added`, wind: "" });
      return { ...q, photos: [...(q.photos || []), ...added], log };
    });
    renderLog();
  }
  note.textContent = failed ? `${added.length} added, ${failed} failed: ${lastErr}` : `${added.length} photo${added.length === 1 ? "" : "s"} added.`;
  renderPhotos();
}

const fmtPhotoTime = d => new Date(d).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const sortedPhotos = pin => [...(pin.photos || [])].sort((a, b) => b.t.localeCompare(a.t));

function renderPhotos() {
  const sec = $("pin-photos");
  const show = !!(editing?.id && syncOn);
  sec.hidden = !show;
  if (!show) return;
  const grid = $("photo-grid"); grid.replaceChildren();
  const list = sortedPhotos(editing);
  $("photo-count").textContent = list.length ? `${list.length}` : "";
  list.forEach((ph, i) => {
    const b = el("button", "photo-thumb");
    b.type = "button";
    b.setAttribute("aria-label", `Photo from ${fmtPhotoTime(ph.t)}`);
    const img = el("img"); img.loading = "lazy"; img.alt = ""; img.src = photoUrl(ph.id, "thumb");
    b.append(img, el("span", "photo-time", fmtPhotoTime(ph.t)));
    b.onclick = () => openViewer(editing, i);
    grid.append(b);
  });
}

// ---------- Full-screen viewer ----------
function openViewer(pin, i) {
  viewer = { pin: pin.id, i };
  $("photo-viewer").hidden = false;
  showViewer();
}
function closeViewer() { viewer = null; $("photo-viewer").hidden = true; }

function showViewer() {
  const pin = pins.find(p => p.id === viewer?.pin);
  const list = pin ? sortedPhotos(pin) : [];
  if (!list.length) return closeViewer();
  viewer.i = Math.max(0, Math.min(viewer.i, list.length - 1));
  const ph = list[viewer.i];
  $("viewer-img").src = photoUrl(ph.id, "full");
  $("viewer-time").textContent = `${fmtPhotoTime(ph.t)} · ${viewer.i + 1} of ${list.length}`;
  $("viewer-note").value = ph.note || "";
  $("viewer-prev").disabled = viewer.i === 0;
  $("viewer-next").disabled = viewer.i === list.length - 1;
  const del = $("viewer-delete");
  del.classList.remove("confirm"); del.textContent = "Delete";
}

function editPhoto(fn) {
  const pin = pins.find(p => p.id === viewer?.pin);
  if (!pin) return;
  const ph = sortedPhotos(pin)[viewer.i];
  updatePin(pin.id, q => ({ ...q, photos: fn(q.photos || [], ph) }));
}

$("viewer-prev").onclick = () => { viewer.i--; showViewer(); };
$("viewer-next").onclick = () => { viewer.i++; showViewer(); };
$("viewer-close").onclick = () => { closeViewer(); renderPhotos(); };
$("viewer-note").addEventListener("change", e => {
  const note = e.target.value.trim();
  editPhoto((list, ph) => list.map(x => x.id === ph.id ? { ...x, note } : x));
});
$("viewer-delete").onclick = () => {
  const del = $("viewer-delete");
  if (!del.classList.contains("confirm")) { del.classList.add("confirm"); del.textContent = "Tap again to delete"; return; }
  const pin = pins.find(p => p.id === viewer?.pin);
  const ph = pin && sortedPhotos(pin)[viewer.i];
  if (!ph) return;
  editPhoto(list => list.filter(x => x.id !== ph.id));
  // The server also removes files no pin refers to, so this is just tidier
  fetch(`/api/photos/${ph.id}`, { method: "DELETE" }).catch(() => {});
  showViewer();
};
document.addEventListener("keydown", e => {
  if (!viewer) return;
  if (e.key === "Escape") $("viewer-close").click();
  if (e.key === "ArrowLeft" && !$("viewer-prev").disabled) $("viewer-prev").click();
  if (e.key === "ArrowRight" && !$("viewer-next").disabled) $("viewer-next").click();
});

$("btn-photo-add").onclick = () => $("photo-file").click();
$("photo-file").addEventListener("change", e => {
  const files = [...e.target.files];
  e.target.value = "";
  addPhotos(files);
});

// Pin list line for trail cams: "Checked 3 days ago · 24 photos"
function camSummary(p) {
  if (p.type !== "cam") return "";
  const n = (p.photos || []).length;
  const checks = (p.log || []).filter(x => x.kind === "check").map(x => +new Date(x.t));
  const last = checks.length ? Math.max(...checks) : 0;
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  return [days == null ? "" : `Checked ${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`}`,
          n ? `${n} photo${n === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
}
