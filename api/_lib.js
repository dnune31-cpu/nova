import crypto from "node:crypto";

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const ALL_MODELS = ["haiku", "sonnet", "opus"];
export const MODEL_IDS = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

function checkDb() {
  if (!DB_URL || !DB_TOKEN) throw new Error("The database isn't connected yet. Add Upstash Redis in Vercel's Storage tab.");
}

export async function redis(...cmd) {
  checkDb();
  const r = await fetch(DB_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.result;
}

export async function pipeline(cmds) {
  if (!cmds.length) return [];
  checkDb();
  const r = await fetch(`${DB_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${DB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds.map(c => c.map(String))),
  });
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error(d.error || "Database error");
  return d.map(x => x.result);
}

export const getJSON = async key => { const v = await redis("GET", key); return v ? JSON.parse(v) : null; };
export const setJSON = (key, value, ...opts) => redis("SET", key, JSON.stringify(value), ...opts);

export const normEmail = e => String(e || "").trim().toLowerCase();
export const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
export const isAdminEmail = e => !!process.env.ADMIN_EMAIL && normEmail(e) === normEmail(process.env.ADMIN_EMAIL);

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

export async function createSession(res, email, admin = false) {
  const token = crypto.randomBytes(32).toString("hex");
  await setJSON(`session:${token}`, { email, admin }, "EX", 60 * 60 * 24 * 30);
  res.setHeader("Set-Cookie", `nova_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}

export async function clearSession(req, res) {
  const token = getCookie(req, "nova_session");
  if (token && /^[a-f0-9]{64}$/.test(token)) await redis("DEL", `session:${token}`);
  res.setHeader("Set-Cookie", "nova_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
}

export async function getAuth(req) {
  const token = getCookie(req, "nova_session");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await getJSON(`session:${token}`);
  if (!s) return null;
  const user = await getJSON(`user:${s.email}`);
  if (!user || user.blocked) return null;
  return { user, admin: !!s.admin && !!user.admin };
}

export function publicUser(user, admin) {
  return { name: user.name, email: user.email, models: admin ? ALL_MODELS : (user.models || ["haiku"]), admin };
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
  await setJSON(`session:${token}`, s, "EX", 60 * 60 * 24 * 30);
}
