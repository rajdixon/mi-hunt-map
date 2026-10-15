// MI Hunt Land sync server: serves the app and keeps each user's pins,
// hunt logs, tracks and drawings, and lets a small group of hunting partners
// see what each other shares and where they are. No dependencies; Node 22+.
//
// It sits behind a Cloudflare Tunnel with Cloudflare Access in front, listens
// on localhost only, and checks the Access login token on every request.
// Without CF_TEAM and CF_AUD set it serves nothing, so it can't be exposed
// by mistake before Access is set up.
//
// Environment:
//   PORT            default 8095
//   APP_DIR         the app's files (this repo), default: the folder above this one
//   DATA_DIR        where user data is kept, default ~/mi-hunt-data
//   CF_TEAM         Cloudflare Zero Trust team name (<team>.cloudflareaccess.com)
//   CF_AUD          the Access application's AUD tag
//   ALLOWED_EMAILS  optional comma-separated allow list, checked as well as Access
//   HUNT_GROUP      comma-separated emails of hunting partners (you included) who
//                   see each other's shared pins, tracks and drawings, and live
//                   locations. Each still needs a login in the Access policy.
//   OWNER_EMAIL     the app's owner, who can see everyone's usage (Settings, Usage)
//   DEV_USER        local testing only: skip Access and act as this email
//   CF_CERTS_URL    testing only: where to fetch Access signing keys

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { initNotify, notify, notesApi, unreadCount, onEvening } from "./notify.mjs";

const PORT = +(process.env.PORT || 8095);
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), "mi-hunt-data"));
const { CF_TEAM, CF_AUD, DEV_USER } = process.env;
const emails = v => (v || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED = emails(process.env.ALLOWED_EMAILS);
const GROUP = emails(process.env.HUNT_GROUP);
const OWNER = emails(process.env.OWNER_EMAIL)[0] || "";
const WHERE_HOURS = 12;   // partner locations older than this are dropped
const MAX_BODY = 20 * 1024 * 1024;
const ORPHAN_DAYS = 7;   // photos no pin refers to are removed after this long
const TOMB_DAYS = 180;
const USAGE_DAYS = 120;   // daily usage kept this long

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".geojson": "application/geo+json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
// Folders in the repo that are not part of the app
const PRIVATE = new Set(["server", "scripts", ".git", ".github", "node_modules"]);

// ---------- Cloudflare Access token ----------
let certs = { at: 0, keys: new Map() };
async function accessKey(kid) {
  if (!certs.keys.has(kid) || Date.now() - certs.at > 3600e3) {
    const r = await fetch(process.env.CF_CERTS_URL || `https://${CF_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
    const { keys } = await r.json();
    certs = { at: Date.now(), keys: new Map(keys.map(k => [k.kid, crypto.createPublicKey({ key: k, format: "jwk" })])) };
  }
  return certs.keys.get(kid);
}

const b64json = s => JSON.parse(Buffer.from(s, "base64url").toString());

// The signed-in email, or null
async function userOf(req) {
  // Local testing only (DEV_USER is never set on the server): a second user via header
  if (DEV_USER) return String(req.headers["x-dev-user"] || DEV_USER).toLowerCase();
  const token = req.headers["cf-access-jwt-assertion"];
  if (!token) return null;
  try {
    const [h, p, sig] = token.split(".");
    const head = b64json(h), body = b64json(p);
    if (head.alg !== "RS256") return null;
    const key = await accessKey(head.kid);
    if (!key || !crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"))) return null;
    const aud = [].concat(body.aud);
    const now = Date.now() / 1000;
    if (!aud.includes(CF_AUD) || body.iss !== `https://${CF_TEAM}.cloudflareaccess.com` || !(body.exp > now) || (body.nbf && body.nbf > now + 60)) return null;
    const email = String(body.email || "").toLowerCase();
    if (!email || (ALLOWED.length && !ALLOWED.includes(email))) return null;
    return email;
  } catch {
    return null;
  }
}

// ---------- Data ----------
const keyOf = email => crypto.createHash("sha256").update(email).digest("hex").slice(0, 24);
const fileOf = email => path.join(DATA_DIR, keyOf(email) + ".json");
const photoDir = email => path.join(DATA_DIR, "photos", keyOf(email));
const PHOTO_ID = /^[a-z0-9]{6,32}$/;
const PHOTO_SIZES = ["full", "thumb"];

// Everyone who has synced: [{ email, doc }]
async function allDocs() {
  let names = [];
  try { names = (await fs.readdir(DATA_DIR)).filter(n => /^[0-9a-f]{24}\.json$/.test(n)); } catch {}
  const out = [];
  for (const n of names) {
    try { const doc = JSON.parse(await fs.readFile(path.join(DATA_DIR, n), "utf8")); if (doc.email) out.push({ email: doc.email, doc }); } catch {}
  }
  return out;
}

async function load(email) {
  try { return { shapes: [], ...JSON.parse(await fs.readFile(fileOf(email), "utf8")) }; }
  catch { return { email, pins: [], tracks: [], shapes: [] }; }
}

// Write to a temp file and rename, so a crash never leaves half a file
const queues = new Map();
function save(email, doc) {
  const run = (queues.get(email) || Promise.resolve()).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    const f = fileOf(email), tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
    await fs.rename(tmp, f);
  });
  queues.set(email, run.catch(() => {}));
  return run;
}

const stamp = x => x.updated ?? x.created ?? 0;

// Merge two lists by id; the newer edit wins (deletes are { id, deleted, updated })
function merge(a = [], b = []) {
  const m = new Map();
  for (const x of [...a, ...b]) {
    if (!x || typeof x.id !== "string") continue;
    const cur = m.get(x.id);
    if (!cur || stamp(x) > stamp(cur)) m.set(x.id, x);
  }
  const cutoff = Date.now() - TOMB_DAYS * 86400e3;
  return [...m.values()].filter(x => !x.deleted || stamp(x) > cutoff);
}

// ---------- Hunting partners ----------
// What each member shares, kept in group.json so it survives restarts:
// { [key]: { name, pins, tracks, shapes } }. Live locations stay in memory.
const inGroup = email => GROUP.length > 1 && GROUP.includes(email);
const groupFile = () => path.join(DATA_DIR, "group.json");
let group = null;
const where = new Map();   // key -> { name, lng, lat, acc, t }

async function loadGroup() {
  if (!group) { try { group = JSON.parse(await fs.readFile(groupFile(), "utf8")); } catch { group = {}; } }
  // Drop anyone taken out of HUNT_GROUP
  const keys = new Set(GROUP.map(keyOf));
  for (const k of Object.keys(group)) if (!keys.has(k)) delete group[k];
  return group;
}

const nameOf = (email, doc) => (doc?.name || "").trim() || email.split("@")[0];
// Only what the owner ticked goes to partners: notes, winds, the hunt log and
// photos are left out unless each was chosen
const OPTIONAL = { notes: "shareNotes", winds: "shareWinds", log: "shareLog", photos: "sharePhotos" };
const shared = list => (list || []).filter(x => x.shared && !x.deleted).map(x => {
  const out = { ...x };
  for (const [field, flag] of Object.entries(OPTIONAL)) if (!x[flag]) delete out[field];
  return out;
});
// Each shared thing goes to everyone in the group (no shareTo, including people
// added later) or only to the partners listed in shareTo
const sharedWithKey = (x, k) => x.shareTo == null || (Array.isArray(x.shareTo) && x.shareTo.includes(k));
// What one partner may see of a member's shares; who else it went to stays private
const seenBy = (list, k) => (list || []).filter(x => sharedWithKey(x, k)).map(({ shareTo, ...x }) => x);

async function publish(email, doc) {
  if (!inGroup(email)) return;
  const g = await loadGroup(), before = g[keyOf(email)];
  g[keyOf(email)] = { name: nameOf(email, doc), pins: shared(doc.pins), tracks: shared(doc.tracks), shapes: shared(doc.shapes) };
  if (before) tellPartners(email, before, g[keyOf(email)]).catch(e => console.error("notify", e));
  const tmp = `${groupFile()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(g), { mode: 0o600 });
  await fs.rename(tmp, groupFile());
}

// Tell the other members about anything newly shared
// Tell each other member about anything they can now see that they couldn't before
async function tellPartners(email, before, now) {
  const what = x => x.k === "pins" ? "a pin" : x.k === "tracks" ? "a track" : x.kind === "area" ? "an area" : "a line";
  for (const e of GROUP) {
    if (e === email) continue;
    const k = keyOf(e);
    const had = new Set(["pins", "tracks", "shapes"].flatMap(t => before[t].filter(x => sharedWithKey(x, k)).map(x => x.id)));
    const fresh = ["pins", "tracks", "shapes"].flatMap(t => now[t].filter(x => sharedWithKey(x, k) && !had.has(x.id)).map(x => ({ ...x, k: t })));
    if (!fresh.length) continue;
    const first = fresh[0], label = first.name || (first.k === "tracks" ? "a track" : "");
    const title = fresh.length === 1 ? `${now.name} shared ${label ? `"${label}"` : what(first)} with you` : `${now.name} shared ${fresh.length} things with you`;
    const body = fresh.slice(0, 6).map(x => x.name || what(x)).join(", ");
    await notify(e, { kind: "partner", title, body, at: first.k === "pins" ? [first.lng, first.lat] : null });
  }
}

// The other members and what they share; null when you're not in a group
async function partnersOf(email) {
  if (!inGroup(email)) return null;
  const g = await loadGroup(), me = keyOf(email);
  return {
    partners: GROUP.filter(e => e !== email).map(e => {
      const k = keyOf(e), x = g[k];
      return { key: k, name: x?.name || e.split("@")[0], joined: !!x, pins: seenBy(x?.pins, me), tracks: seenBy(x?.tracks, me), shapes: seenBy(x?.shapes, me) };
    }),
    me,
  };
}

function wherePartners(email) {
  const me = keyOf(email), cutoff = Date.now() - WHERE_HOURS * 3600e3, out = [];
  for (const [k, w] of where) {
    if (w.t < cutoff) where.delete(k);
    else if (k !== me && (w.to == null || w.to.includes(me))) { const { to, ...rest } = w; out.push({ key: k, ...rest }); }
  }
  return out;
}

// ---------- Usage ----------
// usage.json: { [email]: { first, last, devices: { label: t }, version, days: { "YYYY-MM-DD": { opens, mins, feats } } } }
// The app pings when it opens and every 5 minutes while it's on screen;
// it also counts which features were used since the last ping.
const usageFile = () => path.join(DATA_DIR, "usage.json");
let usage = null, usageDirty = false;
async function loadUsage() {
  if (!usage) { try { usage = JSON.parse(await fs.readFile(usageFile(), "utf8")); } catch { usage = {}; } }
  return usage;
}
async function flushUsage() {
  if (!usageDirty) return;
  usageDirty = false;
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${usageFile()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(usage), { mode: 0o600 });
  await fs.rename(tmp, usageFile());
}
setInterval(() => flushUsage().catch(e => console.error("usage", e)), 60e3).unref();
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => flushUsage().catch(() => {}).finally(() => process.exit(0)));

// Days in the owner's time zone (the server runs on UTC)
const dayOf = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Detroit" });

function deviceOf(ua = "", app) {
  const os = /iPad/.test(ua) ? "iPad" : /iPhone|iPod/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Other";
  return `${os} ${app ? "app" : "browser"}`;
}

const FEATURE = /^[a-z][a-z0-9-]{0,23}$/;
async function ping(req, email, body) {
  const u = await loadUsage(), now = Date.now();
  if (!u[email] && OWNER && email !== OWNER)
    notify(OWNER, { kind: "people", title: `${email} opened MI Hunt Land`, body: "Their first time. See Settings, Usage stats." }).catch(e => console.error("notify", e));
  const me = u[email] ||= { first: now, days: {}, devices: {} };
  me.last = now;
  if (typeof body.v === "string") me.version = body.v.slice(0, 24);
  me.devices[deviceOf(req.headers["user-agent"], !!body.app)] = now;
  const d = me.days[dayOf(now)] ||= { opens: 0, mins: 0, feats: {} };
  if (body.open) d.opens++;
  // Minutes on screen since the last ping, capped so a stuck tab can't inflate it
  d.mins += Math.max(0, Math.min(10, Math.round(+body.mins || 0)));
  if (body.feats && typeof body.feats === "object") {
    for (const [k, n] of Object.entries(body.feats).slice(0, 40))
      if (FEATURE.test(k)) d.feats[k] = (d.feats[k] || 0) + Math.max(0, Math.min(500, Math.round(+n || 0)));
  }
  const cutoff = dayOf(now - USAGE_DAYS * 86400e3);
  for (const k of Object.keys(me.days)) if (k < cutoff) delete me.days[k];
  usageDirty = true;
}

// Everyone's usage, for the owner: one row per person who has used the app
async function usageStats() {
  const u = await loadUsage(), now = Date.now();
  const docs = new Map((await allDocs()).map(x => [x.email, x.doc]));
  const today = dayOf(now), last = n => Array.from({ length: n }, (_, i) => dayOf(now - i * 86400e3));
  const d7 = last(7), d30 = last(30);
  const live = list => (list || []).filter(x => !x.deleted);
  const users = [...new Set([...Object.keys(u), ...docs.keys()])].map(email => {
    const me = u[email] || { days: {}, devices: {} }, doc = docs.get(email);
    const sum = (days, k) => days.reduce((a, d) => a + (me.days[d]?.[k] || 0), 0);
    const feats = {};
    for (const d of d30) for (const [k, n] of Object.entries(me.days[d]?.feats || {})) feats[k] = (feats[k] || 0) + n;
    const pins = live(doc?.pins), tracks = live(doc?.tracks);
    return {
      email, name: nameOf(email, doc), owner: email === OWNER, partner: inGroup(email),
      first: me.first || null, last: me.last || doc?.saved || null, synced: doc?.saved || null, version: me.version || null,
      devices: Object.entries(me.devices).sort((a, b) => b[1] - a[1]).map(([label, t]) => ({ label, t })),
      today: !!me.days[today],
      days7: d7.filter(d => me.days[d]).length, days30: d30.filter(d => me.days[d]).length,
      opens30: sum(d30, "opens"), mins30: sum(d30, "mins"), mins7: sum(d7, "mins"),
      feats,
      active: d30.filter(d => me.days[d]).reverse(),
      content: {
        pins: pins.length, logs: pins.reduce((a, p) => a + (p.log || []).length, 0),
        photos: pins.reduce((a, p) => a + (p.photos || []).length, 0),
        tracks: tracks.length, shapes: live(doc?.shapes).length,
        shared: pins.filter(p => p.shared).length + tracks.filter(t => t.shared).length + live(doc?.shapes).filter(s => s.shared).length,
      },
    };
  }).sort((a, b) => (b.last || 0) - (a.last || 0));
  const days = d30.slice().reverse().map(d => ({ day: d, users: users.filter(x => u[x.email]?.days[d]).length }));
  return { users, days, today, since: Math.min(...Object.values(u).map(x => x.first || now), now) };
}

// ---------- HTTP ----------
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readRaw(req, max = MAX_BODY) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Object.assign(new Error("Too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  return JSON.parse((await readRaw(req)).toString() || "{}");
}

// ---------- Photos ----------
// /api/photos/<id>/<full|thumb>: the phone resizes before upload and sends JPEGs
async function photos(req, res, email, parts, owner) {
  const [id, size] = parts;
  if (!PHOTO_ID.test(id || "")) return send(res, 404, { error: "Not found" });
  let dir = photoDir(email);
  // A partner's photo: only to view, and only on a pin they share
  if (owner && owner !== keyOf(email)) {
    const g = inGroup(email) ? await loadGroup() : {};
    const ok = req.method === "GET" && /^[0-9a-f]{24}$/.test(owner)
      && g[owner]?.pins.some(p => sharedWithKey(p, keyOf(email)) && (p.photos || []).some(x => x.id === id));
    if (!ok) return send(res, 404, { error: "Not found" });
    dir = path.join(DATA_DIR, "photos", owner);
  }
  if (req.method === "DELETE" && !size) {
    await Promise.all(PHOTO_SIZES.map(z => fs.rm(path.join(dir, `${id}.${z}.jpg`), { force: true })));
    return send(res, 200, { ok: true });
  }
  if (!PHOTO_SIZES.includes(size)) return send(res, 404, { error: "Not found" });
  const file = path.join(dir, `${id}.${size}.jpg`);
  if (req.method === "GET") {
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
      return res.end(body);
    } catch { return send(res, 404, { error: "Not found" }); }
  }
  if (req.method === "PUT") {
    const body = await readRaw(req, 15 * 1024 * 1024);
    if (body[0] !== 0xff || body[1] !== 0xd8) return send(res, 415, { error: "JPEG only" });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, file);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: "Method not allowed" });
}

// Remove photo files that no pin has referred to for a week (pin or photo deleted)
async function pruneOrphans(email, doc) {
  const keep = new Set(doc.pins.filter(p => !p.deleted).flatMap(p => (p.photos || []).map(x => x.id)));
  const dir = photoDir(email);
  let names = [];
  try { names = await fs.readdir(dir); } catch { return; }
  const cutoff = Date.now() - ORPHAN_DAYS * 86400e3;
  for (const n of names) {
    const id = n.split(".")[0];
    if (keep.has(id)) continue;
    const f = path.join(dir, n);
    try { if ((await fs.stat(f)).mtimeMs < cutoff) await fs.rm(f); } catch {}
  }
}

const reply = async (email, doc) =>
  ({ email, name: nameOf(email, doc), owner: !!OWNER && email === OWNER, unread: await unreadCount(email), pins: doc.pins, tracks: doc.tracks, shapes: doc.shapes, group: await partnersOf(email) });

async function api(req, res, email, url) {
  const { pathname } = url;
  if (pathname.startsWith("/api/photos/")) return photos(req, res, email, pathname.slice(12).split("/"), url.searchParams.get("o"));
  if (pathname === "/api/where") return whereApi(req, res, email);
  if (pathname === "/api/notes" || pathname.startsWith("/api/notes/"))
    return notesApi(req, res, email, pathname.slice(11), () => readBody(req), send, !!OWNER && email === OWNER);
  if (pathname === "/api/ping" && req.method === "POST") { await ping(req, email, await readBody(req)); return send(res, 200, { ok: true }); }
  if (pathname === "/api/usage") {
    if (!OWNER || email !== OWNER || req.method !== "GET") return send(res, 404, { error: "Not found" });
    return send(res, 200, await usageStats());
  }
  if (pathname === "/api/me" && req.method === "POST") {
    const body = await readBody(req);
    const doc = await load(email);
    doc.email = email;
    doc.name = String(body.name || "").trim().slice(0, 40);
    await save(email, doc);
    await publish(email, doc);
    return send(res, 200, await reply(email, doc));
  }
  if (pathname !== "/api/sync") return send(res, 404, { error: "Not found" });
  if (req.method === "GET") return send(res, 200, await reply(email, await load(email)));
  if (req.method === "POST") {
    const body = await readBody(req);
    const doc = await load(email);
    doc.email = email;
    for (const k of ["pins", "tracks", "shapes"]) doc[k] = merge(doc[k], Array.isArray(body[k]) ? body[k] : []);
    doc.saved = Date.now();
    await save(email, doc);
    await publish(email, doc);
    pruneOrphans(email, doc).catch(e => console.error("prune", e));
    return send(res, 200, await reply(email, doc));
  }
  return send(res, 405, { error: "Method not allowed" });
}

// Live locations: POST yours while sharing, DELETE to stop, GET your partners'
async function whereApi(req, res, email) {
  if (!inGroup(email)) return send(res, 404, { error: "No hunting group" });
  const key = keyOf(email);
  if (req.method === "POST") {
    const b = await readBody(req);
    const lng = +b.lng, lat = +b.lat;
    if (!(Math.abs(lng) <= 180 && Math.abs(lat) <= 90)) return send(res, 400, { error: "Bad location" });
    // to: null for everyone in the group, or the partner keys picked
    const to = Array.isArray(b.to) ? b.to.filter(k => typeof k === "string" && /^[0-9a-f]{24}$/.test(k)) : null;
    where.set(key, { name: nameOf(email, await load(email)), lng, lat, acc: Math.round(+b.acc || 0), t: Date.now(), to });
  } else if (req.method === "DELETE") {
    where.delete(key);
  } else if (req.method !== "GET") {
    return send(res, 405, { error: "Method not allowed" });
  }
  return send(res, 200, { partners: wherePartners(email), sharing: where.has(key) });
}

async function serveFile(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
  const parts = rel.split("/");
  if (parts.some(s => s.startsWith(".") || s === "") || PRIVATE.has(parts[0])) return send(res, 404, "Not found", "text/plain");
  const file = path.join(APP_DIR, rel);
  if (!file.startsWith(APP_DIR + path.sep)) return send(res, 404, "Not found", "text/plain");
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      // The service worker keeps the offline copy; always check for a newer one
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!DEV_USER && (!CF_TEAM || !CF_AUD)) return send(res, 503, "Not configured: set CF_TEAM and CF_AUD.", "text/plain");
    const email = await userOf(req);
    if (!email) return send(res, 403, "Sign in through Cloudflare Access.", "text/plain");
    const url = new URL(req.url, "http://x"), { pathname } = url;
    if (pathname.startsWith("/api/")) return await api(req, res, email, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    return await serveFile(req, res, pathname);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : "Server error" });
    if (!e.status) console.error(e);
  }
});

initNotify({ DATA_DIR, OWNER, keyOf });
onEvening(allDocs);

server.listen(PORT, "127.0.0.1", () => console.log(`MI Hunt Land on 127.0.0.1:${PORT}, app ${APP_DIR}, data ${DATA_DIR}`));
