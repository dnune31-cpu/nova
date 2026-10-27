import { getJSON, setJSON, MODEL_IDS } from "./_lib.js";

// Constellation: each user's map of concepts they've studied with Nova.
// One JSON doc per user: { nodes: { key: {label, subject, count, first, last, chats, notes, summary} }, links: { "a|b": weight } }

const MAX_NODES = 200, MAX_NOTES = 40;
export const SUBJECTS = ["Biology", "Chemistry", "Physics", "Math", "History", "English", "Languages",
  "Computer Science", "Economics", "Psychology", "Art & Music", "Other"];

// "Newton's Laws", "newtons law", "The Newton's Laws" -> same key
export function normKey(s) {
  let k = String(s || "").toLowerCase().replace(/['’`]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
  const w = k.split(" "), last = w[w.length - 1] || "";
  if (last.length > 3 && /s$/.test(last) && !/(ss|us|is|ies|ous|xis)$/.test(last)) w[w.length - 1] = last.slice(0, -1);
  return w.join(" ").slice(0, 48);
}
const flat = s => String(s || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const linkKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const cleanLabel = s => String(s || "").replace(/\s+/g, " ").trim().slice(0, 48);

export async function loadGraph(email) {
  const g = await getJSON(`neuron:${email}`);
  return g && g.nodes ? g : { nodes: {}, links: {} };
}
export const saveGraph = (email, g) => setJSON(`neuron:${email}`, g);

export function findKey(g, label) {
  const k = normKey(label);
  if (!k) return null;
  if (g.nodes[k]) return k;
  for (const [id, n] of Object.entries(g.nodes)) if (normKey(n.label) === k) return id;
  return null;
}

export function knownLabels(g, n = 60) {
  return Object.values(g.nodes).sort((a, b) => b.last - a.last).slice(0, n).map(x => x.label);
}

// Added to Nova's system prompt so concepts come back inside the normal reply (no extra API call).
export function conceptRule(known) {
  return `

Constellation tagging (hidden from the student):
Start every reply with ONE line in exactly this form, then a newline, then your answer:
<concepts>[{"name":"Krebs Cycle","subject":"Biology","note":"Covered the 8 steps in the mitochondrial matrix; each turn makes 3 NADH, 1 FADH2, 1 ATP and 2 CO2.","related":["Glycolysis"]}]</concepts>
Rules:
- 0 to 4 items, only for concepts this reply actually teaches or works through, not ones merely mentioned in passing. For small talk or off-topic messages write <concepts>[]</concepts>.
- name: the standard textbook name, Title Case, singular where natural, 1 to 4 words, no class or subject prefix (write "Krebs Cycle", not "AP Bio Krebs Cycle Steps").` +
    (known.length ? `\n- If it is the same idea as one of the student's existing concepts, reuse that exact name: ${known.join("; ")}.` : "") + `
- subject: exactly one of ${SUBJECTS.join(", ")}.
- note: one factual sentence (max 35 words) saying what this reply covered about the concept, specific enough to study from (key facts, numbers, formulas).
- related: names (existing ones or ones in this list) that are directly connected in meaning: a part of it, a prerequisite, something it causes or explains. Use [] if none. Never connect ideas from unrelated topics just because they came up together.
- The line must be valid JSON on a single line. Never mention it to the student.`;
}

export function splitConcepts(raw) {
  raw = String(raw);
  let items = [];
  const m = raw.match(/<concepts>([^\n]*?)(<\/concepts>|\n|$)/i);
  if (m) {
    const body = m[1].trim();
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j)) items = j;
    } catch {
      items = body.split(";").map(s => ({ name: s.split(":")[0] }));
    }
  }
  items = items.filter(x => x && typeof x.name === "string" && cleanLabel(x.name)).slice(0, 4).map(x => ({
    name: cleanLabel(x.name),
    subject: SUBJECTS.includes(x.subject) ? x.subject : null,
    note: typeof x.note === "string" ? x.note.replace(/\s+/g, " ").trim().slice(0, 300) : "",
    related: Array.isArray(x.related) ? x.related.filter(r => typeof r === "string").slice(0, 6) : [],
  }));
  const reply = raw.replace(/<concepts>[^\n]*?(<\/concepts>|\n|$)/gi, "").trim();
  return { reply, items };
}

function addLink(g, a, b, w = 1) {
  if (!a || !b || a === b || !g.nodes[a] || !g.nodes[b]) return;
  const lk = linkKey(a, b);
  g.links[lk] = (g.links[lk] || 0) + w;
}

export function removeNode(g, k) {
  delete g.nodes[k];
  for (const lk of Object.keys(g.links)) {
    const [a, b] = lk.split("|");
    if (a === k || b === k) delete g.links[lk];
  }
}

// Adds what this reply taught to the graph. Only concepts the model says are related get strung together.
export async function recordConcepts(email, items, chatId, g) {
  const now = Date.now(), keys = [];
  for (const it of items) {
    let k = findKey(g, it.name) || normKey(it.name);
    if (!k || keys.includes(k)) { keys.push(null); continue; }
    keys.push(k);
    const n = g.nodes[k] || (g.nodes[k] = { label: it.name, count: 0, first: now, chats: [], notes: [] });
    n.count++; n.last = now;
    if (it.subject) n.subject = it.subject;
    n.chats = [chatId, ...(n.chats || []).filter(c => c !== chatId)].slice(0, 12);
    if (it.note) n.notes = [...(n.notes || []), { t: now, c: chatId, n: it.note }].slice(-MAX_NOTES);
  }
  items.forEach((it, i) => {
    const a = keys[i];
    if (!a) return;
    for (const r of it.related) addLink(g, a, findKey(g, r));
  });
  // two ideas taught in the same reply, in the same subject, with no stated relations: a light link
  items.forEach((it, i) => items.forEach((jt, j) => {
    if (j <= i || !keys[i] || !keys[j]) return;
    if (!it.related.length && !jt.related.length && it.subject && it.subject === jt.subject) addLink(g, keys[i], keys[j]);
  }));

  const all = Object.keys(g.nodes);
  if (all.length > MAX_NODES) {
    const drop = all.filter(k => !keys.includes(k))
      .sort((a, b) => g.nodes[a].count - g.nodes[b].count || g.nodes[a].last - g.nodes[b].last)
      .slice(0, all.length - MAX_NODES);
    for (const k of drop) removeNode(g, k);
  }
  await saveGraph(email, g);
  return keys.filter(Boolean);
}

export async function callClaude(model, system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_IDS[model], max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || "The AI request failed");
  return d.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

const SUMMARY_SYSTEM = `You write compact study summaries for a high school student, using ONLY the material provided about one concept.
Format: a one or two sentence overview, then **Key points** followed by 3 to 8 short bullets with the specific facts, numbers, steps and formulas that were covered (use $...$ LaTeX for math).
If the material only touches the concept briefly, keep it short and say what has been covered so far. No preamble and no other headings.`;

// Summary of everything a student has covered for one star. Cached until new notes arrive.
export async function starSummary(email, g, key, force = false) {
  const n = g.nodes[key];
  if (!n) throw new Error("That star is gone.");
  const notes = n.notes || [], stamp = `${notes.length}|${n.count}`;
  if (!force && n.summary && n.summaryN === stamp) return n.summary;

  let material = notes.map(x => "- " + x.n).join("\n");
  if (notes.length < 3) {
    // older stars were saved before notes existed: read the chats they came from
    const words = flat(n.label).split(" ").filter(w => w.length > 3);
    let budget = 7000;
    for (const cid of (n.chats || []).slice(0, 4)) {
      if (budget <= 0) break;
      const chat = await getJSON(`chat:${email}:${cid}`);
      if (!chat) continue;
      for (const m of chat.messages || []) {
        if (budget <= 0) break;
        if (m.role !== "assistant" || !m.content) continue;
        const low = flat(m.content);
        if (words.length && !words.some(w => low.includes(w))) continue;
        const piece = m.content.slice(0, Math.min(2500, budget));
        budget -= piece.length;
        material += `\n\n[From the chat "${chat.title}"]\n${piece}`;
      }
    }
  }
  if (!material.trim()) {
    n.summary = "Nothing has been saved about this star yet. Ask Nova about it and the details will build up here.";
  } else {
    n.summary = (await callClaude("haiku", SUMMARY_SYSTEM,
      `Concept: ${n.label}${n.subject ? ` (${n.subject})` : ""}\n\nEverything the student has covered about it:\n${material}`, 700)).trim();
  }
  n.summaryN = stamp; n.summaryAt = Date.now();
  await saveGraph(email, g);
  return n.summary;
}

// Stars the student mentions as "the ___ star" in a message
export function findStarRefs(text, g) {
  const msg = " " + flat(text) + " ";
  if (!msg.includes(" star")) return [];
  return Object.entries(g.nodes)
    .map(([k, n]) => [k, flat(n.label)])
    .filter(([, lab]) => lab && (msg.includes(" " + lab + " star ") || msg.includes(" " + lab + " stars ")))
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3).map(([k]) => k);
}

export async function starContext(email, g, keys) {
  const parts = [];
  for (const k of keys) {
    const n = g.nodes[k];
    if (!n) continue;
    let s = "";
    try { s = await starSummary(email, g, k); } catch (e) { console.error(e); }
    const recent = (n.notes || []).slice(-10).map(x => "- " + x.n).join("\n");
    parts.push(`### ${n.label}${n.subject ? ` (${n.subject})` : ""}\n${s}${recent ? `\n\nNotes from past sessions:\n${recent}` : ""}`);
  }
  if (!parts.length) return "";
  return `

The student is referring to saved stars from their Constellation (their map of everything they've studied with you). Here is everything covered so far for each one. Use it to review with them, build on what they already learned, and point out anything important that hasn't been covered yet.

${parts.join("\n\n")}`;
}

const TIDY_SYSTEM = `You organize a high school student's concept map. Input: one concept per line as "label | subject | times studied".
Return ONLY a JSON object, no prose:
{"rename":{"old label":"new label"},"merge":[{"into":"label","from":["label"]}],"remove":["label"],"subjects":{"label":"Subject"},"links":[["label a","label b"]]}
Rules:
- rename: only when a label is awkward, too long, or not the standard textbook name. Title Case, 1 to 4 words.
- merge: only true duplicates or synonyms of the same idea. Use final (renamed) labels.
- remove: entries that are not real study concepts (greetings, jokes, chit-chat).
- subjects: give every remaining concept (final label) exactly one of: ${SUBJECTS.join(", ")}.
- links: pairs of final labels that are directly related in meaning (part of, prerequisite, causes, explains, applies). Mostly within a subject; across subjects only for a real connection (for example "Work-Energy Theorem" and "Integral"). Never link unrelated ideas. Aim for 1 to 4 links per concept when related ones exist.`;

function mergeInto(g, from, into) {
  if (from === into || !g.nodes[from] || !g.nodes[into]) return;
  const a = g.nodes[from], b = g.nodes[into];
  b.count += a.count; b.first = Math.min(b.first, a.first); b.last = Math.max(b.last, a.last);
  b.chats = [...new Set([...(b.chats || []), ...(a.chats || [])])].slice(0, 12);
  b.notes = [...(b.notes || []), ...(a.notes || [])].sort((x, y) => x.t - y.t).slice(-MAX_NOTES);
  b.subject = b.subject || a.subject;
  delete b.summary; delete b.summaryN;
  for (const [lk, w] of Object.entries(g.links)) {
    const [x, y] = lk.split("|");
    if (x === from || y === from) {
      delete g.links[lk];
      addLink(g, x === from ? into : x, y === from ? into : y, w);
    }
  }
  delete g.nodes[from];
}

export async function tidyGraph(email, g) {
  const entries = Object.entries(g.nodes);
  if (!entries.length) return { merged: 0, removed: 0 };
  const list = entries.map(([, n]) => `${n.label} | ${n.subject || "?"} | ${n.count}`).join("\n");
  const out = await callClaude("sonnet", TIDY_SYSTEM, list, 6000);
  let j;
  try { j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)); }
  catch { throw new Error("Couldn't read the tidy-up result. Try again."); }
  let merged = 0, removed = 0;

  for (const [oldL, newL] of Object.entries(j.rename || {})) {
    const k = findKey(g, oldL), label = cleanLabel(newL);
    if (!k || !label) continue;
    const target = findKey(g, label);
    if (target && target !== k) { mergeInto(g, k, target); merged++; continue; }
    const nk = normKey(label);
    g.nodes[k].label = label;
    if (nk && nk !== k && !g.nodes[nk]) {
      g.nodes[nk] = g.nodes[k];
      for (const [lk, w] of Object.entries(g.links)) {
        const [x, y] = lk.split("|");
        if (x === k || y === k) { delete g.links[lk]; g.links[linkKey(x === k ? nk : x, y === k ? nk : y)] = w; }
      }
      delete g.nodes[k];
    }
  }
  for (const m of j.merge || []) {
    const into = findKey(g, m.into);
    if (!into) continue;
    for (const f of m.from || []) { const k = findKey(g, f); if (k && k !== into) { mergeInto(g, k, into); merged++; } }
  }
  for (const r of j.remove || []) { const k = findKey(g, r); if (k) { removeNode(g, k); removed++; } }
  for (const [l, s] of Object.entries(j.subjects || {})) {
    const k = findKey(g, l);
    if (k && SUBJECTS.includes(s)) g.nodes[k].subject = s;
  }
  if (Array.isArray(j.links)) {
    const old = g.links;
    g.links = {};
    for (const p of j.links) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const a = findKey(g, p[0]), b = findKey(g, p[1]);
      if (a && b && a !== b) g.links[linkKey(a, b)] = old[linkKey(a, b)] || 1;
    }
  }
  await saveGraph(email, g);
  return { merged, removed };
}

export function publicGraph(g) {
  const nodes = Object.entries(g.nodes).map(([id, n]) => ({
    id, label: n.label, subject: n.subject || "Other", count: n.count, first: n.first, last: n.last,
    chats: n.chats || [], notes: (n.notes || []).length,
  }));
  const links = Object.entries(g.links).map(([k, w]) => { const [a, b] = k.split("|"); return { a, b, w }; })
    .filter(l => g.nodes[l.a] && g.nodes[l.b]);
  return { nodes, links };
}
