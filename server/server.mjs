// MI Hunt Land sync server: serves the app and keeps each user's pins,
// hunt logs and tracks. No dependencies; Node 22+.
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
//   DEV_USER        local testing only: skip Access and act as this email
//   CF_CERTS_URL    testing only: where to fetch Access signing keys

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PORT = +(process.env.PORT || 8095);
const APP_DIR = path.resolve(process.env.APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.homedir(), "mi-hunt-data"));
const { CF_TEAM, CF_AUD, DEV_USER } = process.env;
const ALLOWED = (process.env.ALLOWED_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_BODY = 20 * 1024 * 1024;
const TOMB_DAYS = 180;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".geojson": "application/geo+json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
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
  if (DEV_USER) return DEV_USER.toLowerCase();
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
const fileOf = email => path.join(DATA_DIR, crypto.createHash("sha256").update(email).digest("hex").slice(0, 24) + ".json");

async function load(email) {
  try { return JSON.parse(await fs.readFile(fileOf(email), "utf8")); }
  catch { return { email, pins: [], tracks: [] }; }
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

// ---------- HTTP ----------
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error("Too large"), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

async function api(req, res, email, pathname) {
  if (pathname !== "/api/sync") return send(res, 404, { error: "Not found" });
  if (req.method === "GET") {
    const doc = await load(email);
    return send(res, 200, { email, pins: doc.pins, tracks: doc.tracks });
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    const doc = await load(email);
    doc.email = email;
    doc.pins = merge(doc.pins, Array.isArray(body.pins) ? body.pins : []);
    doc.tracks = merge(doc.tracks, Array.isArray(body.tracks) ? body.tracks : []);
    doc.saved = Date.now();
    await save(email, doc);
    return send(res, 200, { email, pins: doc.pins, tracks: doc.tracks });
  }
  return send(res, 405, { error: "Method not allowed" });
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
    const { pathname } = new URL(req.url, "http://x");
    if (pathname.startsWith("/api/")) return await api(req, res, email, pathname);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
    return await serveFile(req, res, pathname);
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : "Server error" });
    if (!e.status) console.error(e);
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`MI Hunt Land on 127.0.0.1:${PORT}, app ${APP_DIR}, data ${DATA_DIR}`));
