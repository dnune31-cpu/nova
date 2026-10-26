import {
  redis, getJSON, setJSON, normEmail, validEmail, isAdminEmail, hashPassword, checkPassword,
  safeEqual, createSession, clearSession, getAuth, publicUser, logEvent, tooManyAttempts, ALL_MODELS,
} from "./_lib.js";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const auth = await getAuth(req);
      return res.status(200).json({ user: auth ? publicUser(auth.user, auth.admin) : null });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const { action, name, password } = req.body || {};
    const email = normEmail(req.body?.email);

    if (action === "logout") {
      await clearSession(req, res);
      return res.status(200).json({ ok: true });
    }

    if (action === "register") {
      const cleanName = String(name || "").trim().slice(0, 40);
      if (!cleanName) return res.status(400).json({ error: "Enter your name." });
      if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email." });
      if (typeof password !== "string" || password.length < 8) return res.status(400).json({ error: "Use a password with at least 8 characters." });
      if (password.length > 200) return res.status(400).json({ error: "That password is too long." });
      if (isAdminEmail(email)) return res.status(409).json({ error: "That email is already registered. Try logging in." });

      const { salt, hash } = hashPassword(password);
      const now = Date.now();
      const user = { name: cleanName, email, salt, hash, created: now, lastLogin: now, models: ["haiku"], blocked: false, messages: 0 };
      const ok = await redis("SET", `user:${email}`, JSON.stringify(user), "NX");
      if (!ok) return res.status(409).json({ error: "That email is already registered. Try logging in." });
      await redis("SADD", "users", email);
      await createSession(res, email);
      await logEvent("signup", email);
      return res.status(200).json({ user: publicUser(user, false) });
    }

    if (action === "login") {
      if (await tooManyAttempts(`login:${email}`)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
      const user = await getJSON(`user:${email}`);
      if (!user || typeof password !== "string" || !checkPassword(password, user.salt, user.hash)) {
        return res.status(401).json({ error: "Wrong email or password." });
      }
      if (user.blocked) return res.status(403).json({ error: "This account has been turned off." });
      user.lastLogin = Date.now();
      await setJSON(`user:${email}`, user);
      await redis("DEL", `attempts:login:${email}`);
      await createSession(res, email);
      await logEvent("login", email);
      return res.status(200).json({ user: publicUser(user, false) });
    }

    if (action === "admin") {
      if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return res.status(500).json({ error: "Admin login isn't set up yet." });
      if (await tooManyAttempts("admin")) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
      if (!isAdminEmail(email) || typeof password !== "string" || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
        return res.status(401).json({ error: "Wrong email or password." });
      }
      let user = await getJSON(`user:${email}`);
      const now = Date.now();
      if (!user) user = { name: "Admin", email, created: now, models: ALL_MODELS, blocked: false, messages: 0 };
      user.lastLogin = now; user.blocked = false; user.models = ALL_MODELS;
      await setJSON(`user:${email}`, user);
      await redis("SADD", "users", email);
      await redis("DEL", "attempts:admin");
      await createSession(res, email, true);
      await logEvent("admin login", email);
      return res.status(200).json({ user: publicUser(user, true) });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
