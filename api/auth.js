import {
  redis, getJSON, setJSON, normEmail, validEmail, isAdminEmail, hashPassword, checkPassword,
  safeEqual, createSession, renewSession, clearSession, getAuth, ensureDevice, deviceBanned, noteDevice, banDevice, publicUser, logEvent, tooManyAttempts, ALL_MODELS, elevateSession, pipeline,
} from "./_lib.js";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const dev = ensureDevice(req, res);
      if (req.query?.gate) return res.status(200).json({ dev, banned: await deviceBanned(dev) }); // the cover page asks this before it will open
      const auth = await getAuth(req);
      if (auth) {
        if (auth.user.devban) { await banDevice(dev, auth.user.email); return res.status(200).json({ user: null }); } // a banned person turned up on a new device
        await renewSession(req, res).catch(() => {}); // still logged in on this device: remember it for another year
        await noteDevice(auth.user.email, dev);
      }
      return res.status(200).json({ user: auth ? publicUser(auth.user, auth.admin) : null });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const { action, name, password } = req.body || {};
    const email = normEmail(req.body?.email);
    const dev = ensureDevice(req, res);
    // a banned device can't log in or sign up; it gets the same message as a wrong password, so it gives nothing away
    if ((action === "login" || action === "register") && (await deviceBanned(dev))) return res.status(401).json({ error: "Wrong email or password." });

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
      

      const { salt, hash } = hashPassword(password);
      const now = Date.now();
      const user = { name: cleanName, email, salt, hash, created: now, lastLogin: now, models: ["haiku"], blocked: false, messages: 0 };
      const ok = await redis("SET", `user:${email}`, JSON.stringify(user), "NX");
      if (!ok) return res.status(409).json({ error: "That email is already registered. Try logging in." });
      await redis("SADD", "users", email);
      await noteDevice(email, dev);
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
      if (user.devban) { await banDevice(dev, email); await noteDevice(email, dev); return res.status(401).json({ error: "Wrong email or password." }); } // device-banned person on a new device: ban it too
      if (user.blocked) return res.status(403).json({ error: "This account has been turned off." });
      await noteDevice(email, dev);
      user.lastLogin = Date.now();
      await setJSON(`user:${email}`, user);
      await redis("DEL", `attempts:login:${email}`);
      await createSession(res, email);
      await logEvent("login", email);
      return res.status(200).json({ user: publicUser(user, false) });
    }

    if (action === "unlockAdmin") {
      const me = await getAuth(req);
      if (!me) return res.status(401).json({ error: "Please log in again." });
      if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: "Admin access isn't set up yet." });
      const em = me.user.email;
      if (await tooManyAttempts(`unlock:${em}`) || await tooManyAttempts("unlock-all")) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
      if (typeof password !== "string" || !safeEqual(password, process.env.ADMIN_PASSWORD)) return res.status(401).json({ error: "That's not the admin password." });
      const user = await getJSON(`user:${em}`);
      if (!user) return res.status(401).json({ error: "Please log in again." });
      user.admin = true; user.models = ALL_MODELS;
      await setJSON(`user:${em}`, user);
      await redis("DEL", `attempts:unlock:${em}`);
      await elevateSession(req);
      await logEvent("admin unlock", em);
      return res.status(200).json({ user: publicUser(user, true) });
    }

    if (action === "instructions") {
      const me = await getAuth(req);
      if (!me) return res.status(401).json({ error: "Please log in again." });
      const user = await getJSON(`user:${me.user.email}`);
      if (!user) return res.status(401).json({ error: "Please log in again." });
      if (typeof req.body?.text === "string") {
        user.instructions = req.body.text.replace(/\r/g, "").trim().slice(0, 1500);
        await setJSON(`user:${me.user.email}`, user);
      }
      return res.status(200).json({ instructions: user.instructions || "" });
    }

    if (action === "deleteAccount") {
      const me = await getAuth(req);
      if (!me) return res.status(401).json({ error: "Please log in again." });
      if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: "Type DELETE to confirm." });
      const em = me.user.email;
      const flat = (await redis("HGETALL", `chatlist:${em}`)) || [];
      const ids = flat.filter((_, i) => i % 2 === 0);
      await pipeline([...ids.map(id => ["DEL", `chat:${em}:${id}`]), ["DEL", `chatlist:${em}`], ["DEL", `neuron:${em}`], ["DEL", `user:${em}`], ["SREM", "users", em]]);
      await clearSession(req, res);
      await logEvent("deleted account", em);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
