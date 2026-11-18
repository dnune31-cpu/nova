import crypto from "node:crypto";

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const ALL_MODELS = ["haiku", "sonnet", "opus"];
// Sonnet is the strongest model the site actually uses. The page calls Haiku "Sonnet" and Sonnet "Opus"; the old "opus" level runs on Sonnet too.
export const MODEL_IDS = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-sonnet-5-5" };

// Where the data lives. If Supabase is set up (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in Vercel), the site uses it:
// every command goes to the "kv" function made by supabase-setup.sql, which understands the same Redis-style commands
// the rest of the code already sends. If those two settings are missing, it falls back to the old Upstash database.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, ""), SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const useSupabase = !!(SB_URL && SB_KEY);

function checkDb() {
  if (!useSupabase && (!DB_URL || !DB_TOKEN)) throw new Error("The database isn't connected yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.");
}
// the old database's error for a used-up request allowance is long and technical; people get a plain sentence instead
const friendly = e => (/max requests limit/i.test(String(e)) ? "The site has hit its usage limit for now. Please try again later." : String(e));

// sends a batch of commands to Supabase in one request; returns one {result} or {error} per command
async function supabase(cmds) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/kv`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ cmds: cmds.map(c => c.map(String)) }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(d)) throw new Error((d && (d.message || d.error)) || "Database error (" + r.status + ")");
  return d;
}

export async function redis(...cmd) {
  checkDb();
  if (useSupabase) { const [d] = await supabase([cmd]); if (d.error) throw new Error(d.error); return d.result; }
  const r = await fetch(DB_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
  });
  const d = await r.json();
  if (d.error) throw new Error(friendly(d.error));
  return d.result;
}

export async function pipeline(cmds) {
  if (!cmds.length) return [];
  checkDb();
  if (useSupabase) return (await supabase(cmds)).map(x => x.result);
  const r = await fetch(`${DB_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds.map(c => c.map(String))),
  });
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error(friendly(d.error || "Database error"));
  return d.map(x => x.result);
}

export const getJSON = async key => { const v = await redis("GET", key); return v ? JSON.parse(v) : null; };
export const setJSON = (key, value, ...opts) => redis("SET", key, JSON.stringify(value), ...opts);

export const normEmail = e => String(e || "").trim().toLowerCase();
export const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
export const isAdminEmail = e => !!process.env.ADMIN_EMAIL && normEmail(e) === normEmail(process.env.ADMIN_EMAIL);
// The owner's email never has to wait to be accepted. It's kept here as a fingerprint (SHA-256), not written out, so the address itself isn't in the code.
const OWNER_HASHES = ["6b27f0b7b07102985ab8f9465707cfdea7a5c0b957137859758d78bae9af7a62", "22f004937d9607eb4b5867a9bff5297bf667de24cbcbacb6226b6a4b8a1ddeca"];
export const isOwnerEmail = e => isAdminEmail(e) || OWNER_HASHES.includes(crypto.createHash("sha256").update(normEmail(e)).digest("hex"));

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
export function checkPassword(pw, salt, hash) {
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// several cookies can be set on one reply
function addCookie(res, cookie) {
  const prev = res.getHeader ? res.getHeader("Set-Cookie") : undefined;
  res.setHeader("Set-Cookie", [].concat(prev || [], cookie));
}
/* ----- device bans -----
   Every browser that opens Prism gets a random device id, kept in a long-lived cookie (and a copy in the page's storage, sent back
   as the x-nova-dev header, so clearing one of the two doesn't shake it off). The admin can ban a person's devices: the cover then
   never opens on them and every request from them is treated as logged out. A banned person who logs in somewhere new gets that
   device banned too. It can't follow someone to a private window or another browser until they log in there. */
const DEV_AGE = 60 * 60 * 24 * 730;
const devOk = v => /^[a-f0-9]{32}$/.test(v || "");
export function getDevice(req) {
  const c = getCookie(req, "nova_dev"), h = String(req.headers["x-nova-dev"] || "");
  return devOk(c) ? c : devOk(h) ? h : null;
}
export function ensureDevice(req, res) { // gives this browser an id if it has none, and (re)plants the cookie
  const id = getDevice(req) || crypto.randomBytes(16).toString("hex");
  addCookie(res, `nova_dev=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DEV_AGE}`);
  return id;
}
export const deviceBanned = async id => !!id && !!(await redis("GET", `devban:${id}`));
export const noteDevice = (email, id) => (id ? redis("SADD", `devs:${email}`, id) : null); // remembers which devices an account has used
export const banDevice = (id, email) => redis("SET", `devban:${id}`, email || "1");
export async function setDeviceBan(email, on) { // bans or unbans every device this account has used
  const ids = (await redis("SMEMBERS", `devs:${email}`)) || [];
  if (ids.length) await pipeline(ids.map(id => (on ? ["SET", `devban:${id}`, email] : ["DEL", `devban:${id}`])));
  return ids.length;
}

// A login is remembered on the device for a year, and every visit starts that year again, so a device that keeps coming back stays logged in.
const REMEMBER = 60 * 60 * 24 * 365;
const sessionCookie = token => `nova_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${REMEMBER}`;
export async function createSession(res, email, admin = false) {
  const token = crypto.randomBytes(32).toString("hex");
  await setJSON(`session:${token}`, { email, admin }, "EX", REMEMBER);
  addCookie(res, sessionCookie(token));
}
// called when the page opens and finds you still logged in: pushes the expiry of this device's login back out to a full year
export async function renewSession(req, res) {
  const token = getCookie(req, "nova_session");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  if (await redis("EXPIRE", `session:${token}`, REMEMBER)) addCookie(res, sessionCookie(token));
}

export async function clearSession(req, res) {
  const token = getCookie(req, "nova_session");
  if (token && /^[a-f0-9]{64}$/.test(token)) await redis("DEL", `session:${token}`);
  addCookie(res, "nova_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
}

export async function getAuth(req) {
  const token = getCookie(req, "nova_session");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const dev = getDevice(req);
  const [sv, banned] = await pipeline([["GET", `session:${token}`], ["GET", `devban:${dev || "-"}`]]);
  if (banned || !sv) return null; // a banned device is treated as logged out everywhere
  const s = JSON.parse(sv);
  const user = await getJSON(`user:${s.email}`);
  if (!user || user.blocked || user.pending) return null; // (pending: signed up but not accepted by the admin yet)
  return { user, admin: !!s.admin && !!user.admin };
}

export function publicUser(user, admin) {
  return { name: user.name, email: user.email, models: admin ? ALL_MODELS : (user.models || ["haiku"]), admin, cheats: !!(user.admin && user.cheats) };
}

export async function logEvent(type, email) {
  await pipeline([
    ["LPUSH", "loginlog", JSON.stringify({ type, email, time: Date.now() })],
    ["LTRIM", "loginlog", 0, 299],
  ]);
}

export async function tooManyAttempts(key) {
  const n = await redis("INCR", `attempts:${key}`);
  if (n === 1) await redis("EXPIRE", `attempts:${key}`, 900);
  return n > 10;
}

// Marks the current session as admin (after the admin password is entered in Settings)
export async function elevateSession(req) {
  const token = getCookie(req, "nova_session");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  const s = await getJSON(`session:${token}`);
  if (!s) return;
  s.admin = true;
  await setJSON(`session:${token}`, s, "EX", REMEMBER);
}
