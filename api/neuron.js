import { redis, getAuth } from "./_lib.js";
import { loadGraph, saveGraph, removeNode, publicGraph, starSummary, tidyGraph } from "./_neuron.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const email = auth.user.email;

    if (req.method === "GET") return res.status(200).json(publicGraph(await loadGraph(email)));

    if (req.method === "DELETE") {
      const id = String(req.query?.id || "");
      if (id === "all") { await redis("DEL", `neuron:${email}`); return res.status(200).json({ ok: true }); }
      const g = await loadGraph(email);
      if (!g.nodes[id]) return res.status(404).json({ error: "That star is already gone." });
      removeNode(g, id);
      await saveGraph(email, g);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "POST") {
      const action = req.body?.action;
      const g = await loadGraph(email);

      if (action === "delete") {
        const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String).slice(0, 300) : [];
        let n = 0;
        for (const id of ids) if (g.nodes[id]) { removeNode(g, id); n++; }
        await saveGraph(email, g);
        return res.status(200).json({ ok: true, deleted: n });
      }
      if (action === "summary") {
        const id = String(req.body.id || "");
        if (!g.nodes[id]) return res.status(404).json({ error: "That star is gone." });
        const summary = await starSummary(email, g, id, !!req.body.force);
        return res.status(200).json({ summary });
      }
      if (action === "tidy") {
        const r = await tidyGraph(email, g);
        return res.status(200).json({ ...r, ...publicGraph(g) });
      }
      return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(405).json({ error: "Not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
