import { getJSON, setJSON } from "./_lib.js";

// Neuron: each user's graph of concepts Nova has talked about with them.
// Stored as one JSON doc per user: { nodes: { key: {...} }, links: { "a|b": weight } }

const MAX_NODES = 150;

export const conceptKey = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40);
const linkKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export async function loadGraph(email) {
  const g = await getJSON(`neuron:${email}`);
  return g && g.nodes ? g : { nodes: {}, links: {} };
}
export const saveGraph = (email, g) => setJSON(`neuron:${email}`, g);

export function knownLabels(g, n = 40) {
  return Object.values(g.nodes).sort((a, b) => b.last - a.last).slice(0, n).map(x => x.label);
}

// Extra instruction added to Nova's system prompt so the concepts come back
// inside the normal reply (no extra API call, so no extra cost).
export function conceptRule(known) {
  return `\n\nAfter your answer, put this on its own final line: <concepts>Concept One; Concept Two</concepts>
List 1 to 4 short names (1 to 4 words each, Title Case) for the main study concepts covered in this exchange.` +
    (known.length ? ` Reuse one of these exact names when it is the same idea: ${known.join("; ")}.` : "") +
    ` If the message is only small talk, write <concepts></concepts>. Never mention this line to the student.`;
}

export function splitConcepts(raw) {
  let labels = [];
  const m = String(raw).match(/<concepts>([\s\S]*?)(<\/concepts>|$)/i);
  if (m) labels = m[1].split(/[;\n]/).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 4);
  const reply = String(raw).replace(/<concepts>[\s\S]*?(<\/concepts>|$)/gi, "").trim();
  return { reply, labels };
}

// Adds the concepts to the graph. Concepts in the same message are linked,
// and each one is also linked to the concepts from the previous message in that chat.
// Returns the keys so the chat can remember them for next time.
export async function recordConcepts(email, labels, chatId, g, prevKeys = []) {
  const now = Date.now(), keys = [];
  for (const raw of labels) {
    const label = raw.slice(0, 40), k = conceptKey(label);
    if (!k || keys.includes(k)) continue;
    keys.push(k);
    const n = g.nodes[k] || (g.nodes[k] = { label, count: 0, first: now, chats: [] });
    n.count++; n.last = now;
    n.chats = [chatId, ...(n.chats || []).filter(c => c !== chatId)].slice(0, 12);
  }
  if (!keys.length) return prevKeys;
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) {
      const lk = linkKey(keys[i], keys[j]);
      g.links[lk] = (g.links[lk] || 0) + 1;
    }
  for (const p of prevKeys || [])
    for (const k of keys)
      if (p !== k && g.nodes[p]) {
        const lk = linkKey(p, k);
        g.links[lk] = (g.links[lk] || 0) + 1;
      }

  // keep the graph a sensible size: drop the least-used, oldest stars
  const all = Object.keys(g.nodes);
  if (all.length > MAX_NODES) {
    const drop = all.filter(k => !keys.includes(k))
      .sort((a, b) => g.nodes[a].count - g.nodes[b].count || g.nodes[a].last - g.nodes[b].last)
      .slice(0, all.length - MAX_NODES);
    for (const k of drop) removeNode(g, k);
  }
  await saveGraph(email, g);
  return keys;
}

export function removeNode(g, k) {
  delete g.nodes[k];
  for (const lk of Object.keys(g.links)) {
    const [a, b] = lk.split("|");
    if (a === k || b === k) delete g.links[lk];
  }
}
