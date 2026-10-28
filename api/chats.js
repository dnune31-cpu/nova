import { redis, getJSON, setJSON, getAuth } from "./_lib.js";

const validId = id => typeof id === "string" && /^[a-f0-9]{16}$/.test(id);

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const email = auth.user.email;
    const id = req.query?.id;

    if (req.method === "GET" && !id) {
      const flat = (await redis("HGETALL", `chatlist:${email}`)) || [];
      const chats = [];
      for (let i = 1; i < flat.length; i += 2) chats.push(JSON.parse(flat[i]));
      chats.sort((a, b) => b.updated - a.updated);
      return res.status(200).json({ chats });
    }
    if (!validId(id)) return res.status(400).json({ error: "Unknown chat" });

    if (req.method === "GET") {
      const chat = await getJSON(`chat:${email}:${id}`);
      if (!chat) return res.status(404).json({ error: "That chat doesn't exist anymore." });
      return res.status(200).json({ chat });
    }
    if (req.method === "PATCH") {
      const title = String(req.body?.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!title) return res.status(400).json({ error: "Give the chat a name." });
      const key = `chat:${email}:${id}`;
      const chat = await getJSON(key);
      if (!chat) return res.status(404).json({ error: "That chat doesn't exist anymore." });
      chat.title = title;
      await setJSON(key, chat);
      await redis("HSET", `chatlist:${email}`, id, JSON.stringify({ id, title, updated: chat.updated || chat.created || Date.now() }));
      return res.status(200).json({ ok: true, title });
    }
    if (req.method === "DELETE") {
      await redis("DEL", `chat:${email}:${id}`);
      await redis("HDEL", `chatlist:${email}`, id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "Not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
