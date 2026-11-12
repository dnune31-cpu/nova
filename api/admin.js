import { redis, pipeline, getJSON, setJSON, getAuth, normEmail, isAdminEmail, ALL_MODELS, setDeviceBan } from "./_lib.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth || !auth.admin) return res.status(403).json({ error: "Admins only." });

    if (req.method === "GET") {
      const emails = (await redis("SMEMBERS", "users")) || [];
      const raw = await pipeline(emails.map(e => ["GET", `user:${e}`]));
      const users = raw.filter(Boolean).map(v => JSON.parse(v)).map(u => ({
        name: u.name, email: u.email, created: u.created, lastLogin: u.lastLogin, lastActive: u.lastActive || null,
        models: u.models || ["haiku"], blocked: !!u.blocked, devban: !!u.devban, troll: !!u.troll, cost: u.cost || 0, dailyLimit: u.dailyLimit || 0, todayMsgs: u.day === today() ? u.dayMsgs || 0 : 0, todayCost: u.day === today() ? u.dayCost || 0 : 0, messages: u.messages || 0, usage: u.usage || {}, admin: !!u.admin,
      })).sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
      const log = ((await redis("LRANGE", "loginlog", 0, 99)) || []).map(x => JSON.parse(x));
      return res.status(200).json({ users, log, announce: await getJSON("announce"), cheats: !!auth.user.cheats });
    }

    if (req.method === "POST") {
      // Erases every Nova account and everything saved for them (chats, study data, game rooms, sessions, the login log, the announcement).
      // Moo-llion and Alien Party data (keys starting moo: or ab:) is kept. This can't be undone, so the admin has to type ERASE.
      if (req.body?.wipe !== undefined) {
        if (req.body.wipe !== "ERASE") return res.status(400).json({ error: "Type ERASE to confirm." });
        const doomed = []; let cursor = "0", rounds = 0;
        do {
          const r = await redis("SCAN", cursor, "COUNT", "500"); cursor = String(r[0]);
          for (const k of r[1] || []) if (!k.startsWith("moo:") && !k.startsWith("ab:")) doomed.push(k);
        } while (cursor !== "0" && ++rounds < 2000);
        for (let i = 0; i < doomed.length; i += 100) await redis("DEL", ...doomed.slice(i, i + 100));
        console.log("nova wipe: erased " + doomed.length + " keys");
        return res.status(200).json({ ok: true, erased: doomed.length });
      }
      // "Enable cheats": a switch on the admin's own account. While it is on, the games quietly help this admin
      // (a word to type in Word Bomb, the best move in chess, the other player's pick in The Lineup). Nobody else sees any of it.
      if (typeof req.body?.cheats === "boolean") {
        const self = await getJSON(`user:${auth.user.email}`);
        if (!self) return res.status(401).json({ error: "Please log in again." });
        self.cheats = req.body.cheats;
        await setJSON(`user:${auth.user.email}`, self);
        return res.status(200).json({ ok: true, cheats: self.cheats });
      }
      if (typeof req.body?.announce === "string") {
      const text = req.body.announce.replace(/\s+/g, " ").trim().slice(0, 280);
      if (!text) { await redis("DEL", "announce"); return res.status(200).json({ ok: true, announce: null }); }
      const ann = { id: Date.now().toString(36), text, time: Date.now() };
      await setJSON("announce", ann);
      return res.status(200).json({ ok: true, announce: ann });
    }
    const email = normEmail(req.body?.email);
      
      const user = await getJSON(`user:${email}`);
      if (!user) return res.status(404).json({ error: "User not found." });
    if (user.admin) return res.status(400).json({ error: "You can't change an admin account." });
      // Deletes one person's account for good: their login, chats and saved study data. They can register again afterwards (block them instead to keep them out).
      if (req.body.remove === true) {
        const flat = (await redis("HGETALL", `chatlist:${email}`)) || [];
        const ids = flat.filter((_, i) => i % 2 === 0);
        await pipeline([...ids.map(id => ["DEL", `chat:${email}:${id}`]), ["DEL", `chatlist:${email}`], ["DEL", `neuron:${email}`], ["DEL", `user:${email}`], ["SREM", "users", email],
          ["LPUSH", "loginlog", JSON.stringify({ type: "deleted by admin", email, time: Date.now() })], ["LTRIM", "loginlog", 0, 299]]);
        return res.status(200).json({ ok: true, removed: email });
      }
      if (Array.isArray(req.body.models)) {
        const models = ALL_MODELS.filter(m => req.body.models.includes(m));
        user.models = models.length ? models : ["haiku"];
      }
      if (typeof req.body.blocked === "boolean") user.blocked = req.body.blocked;
      // Device ban: the cover stops opening on every device this person has used, and on any device they log in from later
      let devices;
      if (typeof req.body.devban === "boolean") { user.devban = req.body.devban; devices = await setDeviceBan(email, user.devban); }
    if (typeof req.body.troll === "boolean") user.troll = req.body.troll;
    if (req.body.dailyLimit !== undefined) user.dailyLimit = Math.max(0, Math.min(1000, parseInt(req.body.dailyLimit) || 0));
      await setJSON(`user:${email}`, user);
      return res.status(200).json({ ok: true, models: user.models, blocked: user.blocked, devban: !!user.devban, devices, troll: !!user.troll, dailyLimit: user.dailyLimit || 0 });
    }

    return res.status(405).json({ error: "Not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
