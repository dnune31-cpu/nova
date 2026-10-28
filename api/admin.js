import { redis, pipeline, getJSON, setJSON, getAuth, normEmail, isAdminEmail, ALL_MODELS } from "./_lib.js";

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
        models: u.models || ["haiku"], blocked: !!u.blocked, troll: !!u.troll, cost: u.cost || 0, dailyLimit: u.dailyLimit || 0, todayMsgs: u.day === today() ? u.dayMsgs || 0 : 0, todayCost: u.day === today() ? u.dayCost || 0 : 0, messages: u.messages || 0, usage: u.usage || {}, admin: !!u.admin,
      })).sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
      const log = ((await redis("LRANGE", "loginlog", 0, 99)) || []).map(x => JSON.parse(x));
      return res.status(200).json({ users, log });
    }

    if (req.method === "POST") {
      const email = normEmail(req.body?.email);
      
      const user = await getJSON(`user:${email}`);
      if (!user) return res.status(404).json({ error: "User not found." });
    if (user.admin) return res.status(400).json({ error: "You can't change an admin account." });
      if (Array.isArray(req.body.models)) {
        const models = ALL_MODELS.filter(m => req.body.models.includes(m));
        user.models = models.length ? models : ["haiku"];
      }
      if (typeof req.body.blocked === "boolean") user.blocked = req.body.blocked;
    if (typeof req.body.troll === "boolean") user.troll = req.body.troll;
    if (req.body.dailyLimit !== undefined) user.dailyLimit = Math.max(0, Math.min(1000, parseInt(req.body.dailyLimit) || 0));
      await setJSON(`user:${email}`, user);
      return res.status(200).json({ ok: true, models: user.models, blocked: user.blocked, troll: !!user.troll, dailyLimit: user.dailyLimit || 0 });
    }

    return res.status(405).json({ error: "Not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
