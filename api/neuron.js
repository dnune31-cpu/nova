import { redis, getAuth } from "./_lib.js";
import { loadGraph, saveGraph, removeNode } from "./_neuron.js";

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const email = auth.user.email;

    if (req.method === "GET") {
      const g = await loadGraph(email);
      const nodes = Object.entries(g.nodes).map(([id, n]) => ({
        id, label: n.label, count: n.count, first: n.first, last: n.last, chats: n.chats || [],
      }));
      const links = Object.entries(g.links).map(([k, w]) => {
        const [a, b] = k.split("|");
        return { a, b, w };
      }).filter(l => g.nodes[l.a] && g.nodes[l.b]);
      return res.status(200).json({ nodes, links });
    }

    if (req.method === "DELETE") {
      const id = String(req.query?.id || "");
      if (id === "all") {
        await redis("DEL", `neuron:${email}`);
        return res.status(200).json({ ok: true });
      }
      const g = await loadGraph(email);
      if (!g.nodes[id]) return res.status(404).json({ error: "That star is already gone." });
      removeNode(g, id);
      await saveGraph(email, g);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
