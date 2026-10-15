// Notifications: each person's inbox (the bell in the top bar), phone alerts
// through Web Push, and the evening check that writes "good wind tomorrow"
// and "cold front" notes. Web Push (RFC 8291 encryption, VAPID) is done with
// node:crypto so the server still has no dependencies.
//
// Files in DATA_DIR:
//   inbox/<key>.json   { items, subs, prefs, sent }
//   vapid.json         the server's push signing key, made on first start
//   notify-state.json  when the evening check last ran

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SunCalc = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "suncalc.js"));
const TZ = "America/Detroit";
const KEEP_DAYS = 60, KEEP_ITEMS = 100;
const EVENING_HOUR = 19;   // the evening check runs after 7 PM Eastern
export const KINDS = {
  partner: "A partner shares a pin, track, line or area",
  wind: "Good winds at your stands tomorrow (evening)",
  front: "A cold front tomorrow (evening)",
  people: "Someone new opens the app",
};
const OWNER_ONLY = new Set(["people"]);

let cfg;   // { DATA_DIR, OWNER, keyOf }
export function initNotify(c) { cfg = c; setInterval(() => evening().catch(e => console.error("evening", e)), 5 * 60e3).unref(); }

const b64u = b => Buffer.from(b).toString("base64url");
const writeJson = async (f, v) => {
  await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(v), { mode: 0o600 });
  await fs.rename(tmp, f);
};
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };

// ---------- Inbox ----------
const inboxFile = email => path.join(cfg.DATA_DIR, "inbox", cfg.keyOf(email) + ".json");
const locks = new Map();
// Read, change and save one inbox at a time per person
function withInbox(email, fn) {
  const run = (locks.get(email) || Promise.resolve()).then(async () => {
    const box = { items: [], subs: [], prefs: {}, sent: {}, ...(await readJson(inboxFile(email), {})) };
    const out = await fn(box);
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    box.items = box.items.filter(x => x.t > cutoff).slice(0, KEEP_ITEMS);
    for (const [k, t] of Object.entries(box.sent)) if (t < cutoff) delete box.sent[k];
    await writeJson(inboxFile(email), box);
    return out;
  });
  locks.set(email, run.catch(() => {}));
  return run;
}

const wants = (box, kind) => box.prefs[kind] !== false;
const unreadOf = box => box.items.filter(x => !x.read).length;
export const unreadCount = async email => unreadOf({ items: [], ...(await readJson(inboxFile(email), {})) });

// Add a note to someone's inbox and push it to their phones. `once` is a key
// that stops the same note being sent twice (e.g. "wind:2026-10-15").
export async function notify(email, { kind, title, body = "", at = null, once = null }) {
  const pushTo = await withInbox(email, box => {
    if (!wants(box, kind) || (once && box.sent[once])) return null;
    if (once) box.sent[once] = Date.now();
    const item = { id: crypto.randomBytes(6).toString("hex"), t: Date.now(), kind, title, body, at, read: false };
    box.items.unshift(item);
    return { subs: box.subs.slice(), msg: { title, body, tag: item.id, url: `/?note=${item.id}`, unread: unreadOf(box) } };
  });
  if (!pushTo?.subs.length) return;
  const gone = [];
  await Promise.all(pushTo.subs.map(async s => {
    try {
      const status = await webPush(s, pushTo.msg);
      if (status === 404 || status === 410) gone.push(s.endpoint);
      else if (status >= 400) console.error("push", status, new URL(s.endpoint).host);
    } catch (e) { console.error("push", e.message); }
  }));
  if (gone.length) await withInbox(email, box => { box.subs = box.subs.filter(s => !gone.includes(s.endpoint)); });
}

// /api/notes...
export async function notesApi(req, res, email, sub, body, send, owner) {
  const kinds = Object.keys(KINDS).filter(k => owner || !OWNER_ONLY.has(k));
  if (req.method === "GET" && !sub) {
    const box = { items: [], subs: [], prefs: {}, ...(await readJson(inboxFile(email), {})) };
    return send(res, 200, {
      items: box.items, unread: unreadOf(box), vapid: (await vapid()).pub,
      prefs: Object.fromEntries(kinds.map(k => [k, wants(box, k)])), kinds: Object.fromEntries(kinds.map(k => [k, KINDS[k]])),
      subs: box.subs.map(s => s.endpoint),
    });
  }
  if (req.method !== "POST" && req.method !== "DELETE") return send(res, 405, { error: "Method not allowed" });
  const b = await body();
  if (sub === "read") {
    const n = await withInbox(email, box => {
      for (const x of box.items) if (b.all || (b.ids || []).includes(x.id)) x.read = true;
      return unreadOf(box);
    });
    return send(res, 200, { unread: n });
  }
  if (sub === "clear") { await withInbox(email, box => { box.items = []; }); return send(res, 200, { unread: 0 }); }
  if (sub === "prefs") {
    await withInbox(email, box => { for (const k of kinds) if (typeof b.prefs?.[k] === "boolean") box.prefs[k] = b.prefs[k]; });
    return send(res, 200, { ok: true });
  }
  if (sub === "sub") {
    const s = b.subscription;
    if (req.method === "DELETE") {
      await withInbox(email, box => { box.subs = box.subs.filter(x => x.endpoint !== b.endpoint); });
      return send(res, 200, { ok: true });
    }
    let host = "";
    try { host = new URL(s?.endpoint).hostname; } catch {}
    // Only the browsers' own push services
    if (!/(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|mozaws\.net|notify\.windows\.com)$/.test(host)
      || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") return send(res, 400, { error: "Bad subscription" });
    await withInbox(email, box => {
      box.subs = box.subs.filter(x => x.endpoint !== s.endpoint);
      box.subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, t: Date.now() });
      box.subs = box.subs.slice(-6);
    });
    return send(res, 200, { ok: true });
  }
  if (sub === "test") {
    await notify(email, { kind: "test", title: "Alerts are on", body: "This is how MI Hunt Land notifications will look." });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: "Not found" });
}

// ---------- Web Push ----------
let vapidKeys = null;
async function vapid() {
  if (vapidKeys) return vapidKeys;
  const f = path.join(cfg.DATA_DIR, "vapid.json");
  let jwk = await readJson(f, null);
  if (!jwk) {
    jwk = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
    await writeJson(f, jwk);
  }
  const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const pub = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]));
  return (vapidKeys = { key, pub });
}

export async function webPush(sub, msg) {
  const { key, pub } = await vapid();
  const uaPub = Buffer.from(sub.keys.p256dh, "base64url"), auth = Buffer.from(sub.keys.auth, "base64url");
  // RFC 8291: a one-off key pair, shared secret with the browser, then aes128gcm (RFC 8188)
  const ecdh = crypto.createECDH("prime256v1");
  const asPub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPub);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([c.update(Buffer.concat([Buffer.from(JSON.stringify(msg)), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const payload = Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, sealed]);

  const aud = new URL(sub.endpoint).origin;
  const jwtHead = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const jwtBody = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${cfg.OWNER || "admin@tradersedges.net"}` }));
  const sig = crypto.sign("sha256", Buffer.from(`${jwtHead}.${jwtBody}`), { key, dsaEncoding: "ieee-p1363" });
  const r = await fetch(sub.endpoint, {
    method: "POST", body: payload, signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `vapid t=${jwtHead}.${jwtBody}.${b64u(sig)}, k=${pub}`,
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(12 * 3600), Urgency: "normal",
    },
  });
  return r.status;
}

// ---------- Evening check: tomorrow's winds and cold fronts ----------
const DIR_DEG = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
                  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
// Same rule as the app: the forecast direction, or within 22.5° of a good one
function windMatches(dir, good) {
  if (!dir || !good?.length) return false;
  if (good.includes(dir)) return true;
  const deg = DIR_DEG[dir];
  return deg != null && good.some(g => Math.abs(((DIR_DEG[g] - deg + 540) % 360) - 180) <= 22.5);
}
const dayOf = t => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
const hourOf = t => +new Date(t).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const clock = t => new Date(t).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(":00", "");
const UA = { "User-Agent": "MI Hunt Land (hunt.tradersedges.net)", Accept: "application/geo+json" };

const cache = new Map();
async function hourly(lng, lat) {
  const k = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (!cache.has(k)) cache.set(k, (async () => {
    const pt = await (await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { headers: UA })).json();
    const r = await (await fetch(pt.properties.forecastHourly, { headers: UA })).json();
    return r.properties.periods.map(p => ({ s: +new Date(p.startTime), e: +new Date(p.endTime), dir: p.windDirection }));
  })().catch(() => null));
  return cache.get(k);
}

// Legal hours are about 30 minutes before sunrise to 30 after sunset; this
// uses the sun at the stand, close to the digest's zone table
function legal(day, lng, lat) {
  const t = SunCalc.getTimes(new Date(`${day}T17:00:00Z`), lat, lng);   // early afternoon in Michigan
  return [t.sunrise.getTime() - 30 * 60e3, t.sunset.getTime() + 30 * 60e3];
}

async function goodTomorrow(pin, day) {
  const fc = await hourly(pin.lng, pin.lat);
  if (!fc) return null;
  const [open, close] = legal(day, pin.lng, pin.lat), out = [];
  for (const p of fc) {
    const a = Math.max(p.s, open), b = Math.min(p.e, close);
    if (a >= b || !windMatches(p.dir, pin.winds)) continue;
    const last = out[out.length - 1];
    if (last && last[1] === a) last[1] = b; else out.push([a, b]);
  }
  return out;
}

async function highs(lng, lat) {
  const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lng.toFixed(3), daily: "temperature_2m_max", temperature_unit: "fahrenheit",
    timezone: TZ, forecast_days: "2" });
  const d = (await (await fetch(url)).json()).daily;
  return d?.temperature_2m_max?.length === 2 ? d.temperature_2m_max.map(Math.round) : null;
}

// users(): [{ email, doc }]
let usersOf = async () => [];
export function onEvening(fn) { usersOf = fn; }

async function evening() {
  const now = Date.now();
  if (hourOf(now) < EVENING_HOUR) return;
  const stateFile = path.join(cfg.DATA_DIR, "notify-state.json"), state = await readJson(stateFile, {});
  const today = dayOf(now);
  if (state.evening === today) return;
  state.evening = today;
  await writeJson(stateFile, state);
  cache.clear();
  const tomorrow = dayOf(now + 86400e3);
  const name = new Date(`${tomorrow}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  for (const { email, doc } of await usersOf()) {
    const stands = (doc.pins || []).filter(p => !p.deleted && p.winds?.length && Number.isFinite(p.lng) && Number.isFinite(p.lat));
    if (!stands.length) continue;
    const lines = [];
    for (const p of stands.slice(0, 12)) {
      const w = await goodTomorrow(p, tomorrow);
      if (w?.length) lines.push(`${p.name || "Stand"}: ${w.map(([a, b]) => `${clock(a)}–${clock(b)}`).join(", ")}`);
    }
    if (lines.length) await notify(email, {
      kind: "wind", once: `wind:${tomorrow}`, title: `Good wind ${name} at ${lines.length === 1 ? lines[0].split(":")[0] : `${lines.length} stands`}`,
      body: lines.join("\n"),
    });
    const h = await highs(stands[0].lng, stands[0].lat).catch(() => null);
    if (h && h[0] - h[1] >= 8) await notify(email, {
      kind: "front", once: `front:${tomorrow}`, title: `Cold front ${name}: high ${h[1]}°F`,
      body: `${h[0] - h[1]}° colder than today. Deer tend to move more after a temperature drop.`,
      at: [stands[0].lng, stands[0].lat],
    });
  }
}
// For testing: run the evening check now
export async function eveningNow() { const f = path.join(cfg.DATA_DIR, "notify-state.json"); await writeJson(f, {}); return evening(); }
