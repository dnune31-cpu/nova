import crypto from "node:crypto";
import { redis, getJSON, setJSON, getAuth, ALL_MODELS, MODEL_IDS } from "./_lib.js";
import { loadGraph, knownLabels, conceptRule, splitConcepts, recordConcepts } from "./_neuron.js";

const SYSTEM = `You are Nova, a friendly study helper for high school students.
Your goal is to help students understand, not to do their homework for them.
- Explain ideas clearly and simply, step by step, using examples.
- For homework problems, guide the student through the steps and check their thinking instead of only giving the final answer. If they've already tried, show the full solution so they can compare.
- When asked to quiz, ask one question at a time and wait for the answer.
- When the student shares a photo, file, or web page, use it to answer. If a page couldn't be loaded, say so.
- Use LaTeX for math: $...$ inline and $$...$$ for display.
- Keep answers focused and not too long. Be encouraging but honest when something is wrong.`;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function isBlockedHost(host) {
  host = host.toLowerCase();
  return (
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    host === "0.0.0.0" || host.startsWith("127.") || host.startsWith("10.") ||
    host.startsWith("192.168.") || host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.includes(":") || host.startsWith("[")
  );
}

async function readPage(raw) {
  let url;
  try { url = new URL(raw); } catch { return `Link: ${raw}\n(Not a valid link.)`; }
  if (!["http:", "https:"].includes(url.protocol) || isBlockedHost(url.hostname)) {
    return `Link: ${raw}\n(This link can't be opened.)`;
  }
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (NovaStudyHelper)" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!r.ok) return `Link: ${raw}\n(The page returned an error: ${r.status}.)`;
    const type = r.headers.get("content-type") || "";
    if (!type.includes("text/")) return `Link: ${raw}\n(This link isn't a readable web page.)`;
    let text = await r.text();
    if (type.includes("html")) {
      const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
      text = text
        .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      text = (title ? `Title: ${title.trim()}\n` : "") + text;
    }
    text = text.replace(/\s+/g, " ").trim().slice(0, 12000);
    return `Content of the web page ${raw}:\n\n${text}`;
  } catch {
    return `Link: ${raw}\n(The page couldn't be loaded.)`;
  }
}

async function buildNewContent(text, attachments, links) {
  const blocks = [];
  for (const a of (Array.isArray(attachments) ? attachments : []).slice(0, 6)) {
    if (a.type === "image" && IMAGE_TYPES.includes(a.media_type) && typeof a.data === "string") {
      blocks.push({ type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } });
    } else if (a.type === "pdf" && typeof a.data === "string") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } });
    } else if (a.type === "text" && typeof a.text === "string") {
      blocks.push({ type: "text", text: `File: ${String(a.name || "file").slice(0, 100)}\n\n${a.text.slice(0, 60000)}` });
    }
  }
  const allLinks = [...new Set([...(Array.isArray(links) ? links : []), ...(text.match(URL_RE) || [])])].slice(0, 3);
  const pages = await Promise.all(allLinks.map(readPage));
  for (const p of pages) blocks.push({ type: "text", text: p });
  if (!blocks.length) return text || "(empty message)";
  blocks.push({ type: "text", text: text || "Please look at what I attached." });
  return blocks;
}

function historyText(m) {
  let t = m.content || "";
  const extras = [...(m.files || []), ...(m.links || [])];
  if (m.role === "user" && extras.length) t = `${t}\n[Earlier I shared: ${extras.join(", ")}]`.trim();
  return t || "(attachment)";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const { user, admin } = auth;
    const email = user.email;

    const modelKey = req.body?.model;
    const allowed = admin ? ALL_MODELS : (user.models || ["haiku"]);
    if (!allowed.includes(modelKey)) return res.status(403).json({ error: "You don't have access to that model yet." });

    const text = typeof req.body?.content === "string" ? req.body.content.slice(0, 8000) : "";
    const attachments = req.body?.attachments || [];
    const links = Array.isArray(req.body?.links) ? req.body.links.slice(0, 3).map(String) : [];
    if (!text && !attachments.length && !links.length) return res.status(400).json({ error: "Empty message" });

    let chatId = req.body?.chatId;
    let chat = null;
    if (chatId) {
      if (!/^[a-f0-9]{16}$/.test(chatId)) return res.status(400).json({ error: "Unknown chat" });
      chat = await getJSON(`chat:${email}:${chatId}`);
    }
    if (!chat) {
      chatId = crypto.randomBytes(8).toString("hex");
      const title = (text || attachments[0]?.name || links[0] || "New chat").replace(/\s+/g, " ").slice(0, 48);
      chat = { id: chatId, title, created: Date.now(), messages: [] };
    }

    let history = chat.messages.slice(-11).map(m => ({ role: m.role, content: historyText(m) }));
    while (history.length && history[0].role !== "user") history.shift();
    const messages = [...history, { role: "user", content: await buildNewContent(text, attachments, links) }];

    // Neuron: tell Nova which concepts this student already has so it reuses the same names
    let graph = null;
    try { graph = await loadGraph(email); } catch (e) { console.error(e); }
    const system = graph ? SYSTEM + conceptRule(knownLabels(graph)) : SYSTEM;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL_IDS[modelKey], max_tokens: 1500, system, messages }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error(data);
      return res.status(500).json({ error: data?.error?.message || "The AI request failed" });
    }
    const raw = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const { reply, labels } = splitConcepts(raw);

    if (graph && labels.length) {
      try { chat.lastConcepts = await recordConcepts(email, labels, chatId, graph, chat.lastConcepts || []); }
      catch (e) { console.error(e); }
    }

    const now = Date.now();
    chat.messages.push({
      role: "user", content: text, time: now,
      files: attachments.map(a => String(a.name || "file").slice(0, 100)), links,
    });
    chat.messages.push({ role: "assistant", content: reply, model: modelKey, time: now });
    chat.messages = chat.messages.slice(-200);
    chat.updated = now;
    await setJSON(`chat:${email}:${chatId}`, chat);
    await redis("HSET", `chatlist:${email}`, chatId, JSON.stringify({ id: chatId, title: chat.title, updated: now }));

    const fresh = await getJSON(`user:${email}`);
    if (fresh) {
      fresh.messages = (fresh.messages || 0) + 1;
      fresh.lastActive = now;
      fresh.usage = fresh.usage || {};
      fresh.usage[modelKey] = (fresh.usage[modelKey] || 0) + 1;
      await setJSON(`user:${email}`, fresh);
    }

    return res.status(200).json({ reply, chatId, title: chat.title, concepts: labels });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Couldn't reach the AI. Try again." });
  }
}
