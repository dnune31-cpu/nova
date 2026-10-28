import crypto from "node:crypto";
import { redis, getJSON, setJSON, getAuth, ALL_MODELS, MODEL_IDS } from "./_lib.js";
import { loadGraph, knownLabels, conceptRule, splitConcepts, recordConcepts, findStarRefs, starContext } from "./_neuron.js";

const SYSTEM = `You are Nova, a sharp, friendly AI assistant for students. Answer like an expert would: directly, accurately and completely.
- When given a problem, solve it fully and state the final answer clearly. Show the key steps briefly so the work can be checked.
- When the student shares a photo, file, web page or screen snapshot, use it to answer. If a page couldn't be loaded, say so.
- For screen snapshots, focus on the question shown and ignore menus, tabs and unrelated windows. If the answer goes into an online homework box, also give it as plain text in the exact format the box asks for (for example "Use a comma to separate answers").
- Use LaTeX for math: $...$ inline and $$...$$ for display. Put the final answer of a math problem in \\boxed{}.
- If something is ambiguous, say what you assumed and answer anyway.
- Keep answers focused, with no filler.`;

// Tutor mode (turned on with the Tutor button): teach instead of just answering
const TUTOR = `You are Nova, a friendly study helper for high school students.
Your goal is to help students understand, not to do their homework for them.
- Explain ideas clearly and simply, step by step, using examples.
- For homework problems, guide the student through the steps and check their thinking instead of only giving the final answer. If they've already tried, show the full solution so they can compare.
- When asked to quiz, ask one question at a time and wait for the answer.
- When the student shares a photo, file, or web page, use it to answer. If a page couldn't be loaded, say so.
- Sometimes the student shares a snapshot of their screen. Focus on the schoolwork in it, ignore menus, tabs and unrelated windows, and refer to it naturally ("on your screen…").
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
      if (a.screen) blocks.push({ type: "text", text: "Snapshot of my screen right now" + (["left half", "right half", "top half", "bottom half"].includes(a.screen) ? ` (${a.screen}, the two halves overlap a little)` : "") + ":" });
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

// what the student should see so far: the hidden <concepts> line is left out
function visibleText(raw) {
  let s = raw.replace(/^\s+/, "");
  const low = s.toLowerCase();
  if (s.length < 10 && "<concepts>".startsWith(low)) return null;
  if (low.startsWith("<concepts>")) {
    const close = low.indexOf("</concepts>"), nl = s.indexOf("\n");
    const ends = [close >= 0 ? close + 11 : -1, nl].filter(x => x >= 0);
    if (!ends.length) return null;
    s = s.slice(Math.min(...ends)).replace(/^\s+/, "");
  }
  return s.replace(/<concepts>[^\n]*?(<\/concepts>|\n|$)/gi, "");
}

// troll mode (an admin can switch it on for someone): every answer is this, no AI call
function trollReply() {
  const E = ["👀", "😂", "🤣", "💀", "😭", "🗿", "🔥", "🤡", "😹", "🫵", "😆", "👁️"];
  let e = "";
  for (let i = 0; i < 12; i++) e += E[Math.floor(Math.random() * E.length)];
  return `<div class="trollmsg">BOI YOU REALLY THOUGHT SIGMA 6767676767676767 SKIBIDI TUNG TUNG!!!<div class="trollemo">${e}</div></div>`;
}

// Nova can draw graphs: the page turns these code blocks into a plot
const GRAPH_RULE = `

Graphs: you can draw graphs. When a graph would really help (functions, curves, slope fields, comparing functions) or the student asks for one, include a fenced code block with the language "graph" holding JSON, for example:
\`\`\`graph
{"title":"dy/dx = xy","x":[-3,3],"y":[-4,4],"functions":[{"expr":"exp(x^2/2)","label":"y = e^(x²/2)"}],"slopefield":"x*y","points":[{"x":0,"y":1,"label":"(0, 1)"}]}
\`\`\`
Rules for the JSON: "x" and "y" are [min, max] (leave out "y" to fit it automatically); up to 5 "functions" written in x using * for multiplication, ^ for powers and sin, cos, tan, sec, csc, cot, asin, acos, atan, sqrt, abs, exp, ln, log, pi, e; "slopefield" is dy/dx written in x and y; "points" are optional labeled points like intercepts or turning points. Only plain y = f(x) curves, no implicit equations. Keep explaining in words as usual; never mention the JSON.`;

// estimated API prices (US$ per million tokens), used for the admin panel's "Spent" column
const PRICES = { haiku: [0.1, 0.5], sonnet: [2, 10], opus: [4, 20] };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

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

    // the Stop button: flag this answer so the stream that's writing it stops early
    if (typeof req.body?.stop === "string") {
      if (!/^[a-z0-9]{8,32}$/.test(req.body.stop)) return res.status(400).json({ error: "Bad request" });
      await redis("SET", `stop:${email}:${req.body.stop}`, "1", "EX", "120");
      return res.status(200).json({ ok: true });
    }
    const wantStream = req.body?.stream === true;
    const troll = !!user.troll && !admin;
    const rid = typeof req.body?.rid === "string" && /^[a-z0-9]{8,32}$/.test(req.body.rid) ? req.body.rid : null;

    const modelKey = req.body?.model;
    const allowed = admin ? ALL_MODELS : (user.models || ["haiku"]);
    if (!allowed.includes(modelKey)) return res.status(403).json({ error: "You don't have access to that model yet." });
    const limit = Number(user.dailyLimit) || 0;
    if (!admin && limit > 0 && user.day === today() && (user.dayMsgs || 0) >= limit) {
      return res.status(429).json({ error: `You've used all ${limit} of today's messages. They reset at midnight` });
    }

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

    // Constellation: tell Nova which concepts this student already has so it reuses the same names,
    // and if they mention "the ___ star", give Nova everything saved under that star
    let graph = null, starRefs = [], starText = "";
    if (!troll) try {
      graph = await loadGraph(email);
      starRefs = findStarRefs(text, graph);
      if (starRefs.length) starText = await starContext(email, graph, starRefs);
    } catch (e) { console.error(e); }
    const mine = typeof user.instructions === "string" ? user.instructions.trim() : "";
    const base = (req.body?.mode === "tutor" ? TUTOR : SYSTEM) + GRAPH_RULE +
      (mine ? `\n\nThe student's custom instructions (follow them unless they conflict with the rules above):\n${mine}` : "");
    const system = graph ? base + starText + conceptRule(knownLabels(graph)) : base;

    // stream the answer from Claude so the student sees it being written
    const up = new AbortController();
    let stopped = false, clientGone = false;
    res.on("close", () => { if (!res.writableFinished) { clientGone = true; stopped = true; up.abort(); } });
    const stopKey = rid ? `stop:${email}:${rid}` : null;
    const checkStop = async () => {
      if (!stopKey || stopped) return;
      try { if (await redis("GET", stopKey)) { stopped = true; up.abort(); } } catch {}
    };
    await checkStop();

    let raw = "", stopReason = null, tokIn = 0, tokOut = 0;
    const send = o => { if (wantStream && !clientGone) res.write(JSON.stringify(o) + "\n"); };
    let shown = "";
    const emit = () => {
      if (!wantStream) return;
      const v = visibleText(raw);
      if (v === null || v === shown) return;
      if (v.startsWith(shown)) send({ t: "d", d: v.slice(shown.length) });
      else send({ t: "r", text: v });
      shown = v;
    };

    if (!stopped && !troll) {
      let r;
      try {
        r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: MODEL_IDS[modelKey], max_tokens: 3000, system, messages, stream: true }),
          signal: up.signal,
        });
      } catch (e) {
        if (!stopped) throw e;
      }
      if (r && !r.ok) {
        let data = {};
        try { data = await r.json(); } catch {}
        console.error(data);
        return res.status(500).json({ error: data?.error?.message || "The AI request failed" });
      }
      if (wantStream) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
        send({ t: "start", chatId, title: chat.title, stars: starRefs.map(k => graph?.nodes[k]?.label).filter(Boolean) });
      }
      if (r) {
        const poll = setInterval(checkStop, 700);
        try {
          const reader = r.body.getReader(), dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i); buf = buf.slice(i + 2);
              const line = block.split("\n").find(l => l.startsWith("data:"));
              if (!line) continue;
              let ev;
              try { ev = JSON.parse(line.slice(5)); } catch { continue; }
              if (ev.type === "message_start") { const u = ev.message?.usage || {}; tokIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); }
              else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { raw += ev.delta.text; emit(); }
              else if (ev.type === "message_delta") { if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason; if (ev.usage?.output_tokens) tokOut = ev.usage.output_tokens; }
              else if (ev.type === "error") throw new Error(ev.error?.message || "The AI stream failed");
            }
          }
        } catch (e) {
          if (!stopped) throw e;
        } finally {
          clearInterval(poll);
        }
      }
    } else if (wantStream) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
      send({ t: "start", chatId, title: chat.title, stars: [] });
    }
    if (stopKey) redis("DEL", stopKey).catch(() => {});
    if (troll && !stopped) { raw = trollReply(); if (wantStream) send({ t: "d", d: raw }); }

    let { reply, items } = splitConcepts(raw);
    if (stopped) {
      reply = reply ? reply + "\n\n*(Stopped)*" : "*(Stopped before answering.)*";
      items = [];
    } else if (stopReason === "max_tokens") {
      reply += "\n\n*(I ran out of room here. Say \"continue\" and I'll pick up where I left off.)*";
    }
    if (!reply) reply = "*(No answer came back. Try asking again.)*";

    if (graph && items.length) {
      try { await recordConcepts(email, items, chatId, graph); }
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
      // what this message cost, roughly (stopped answers still count what was written)
      if (stopped && !tokOut && raw) tokOut = Math.ceil(raw.length / 4);
      const p = PRICES[modelKey] || PRICES.sonnet;
      const cost = (tokIn * p[0] + tokOut * p[1]) / 1e6;
      fresh.cost = (fresh.cost || 0) + cost;
      const d = today();
      if (fresh.day !== d) { fresh.day = d; fresh.dayMsgs = 0; fresh.dayCost = 0; }
      fresh.dayMsgs = (fresh.dayMsgs || 0) + 1;
      fresh.dayCost = (fresh.dayCost || 0) + cost;
      await setJSON(`user:${email}`, fresh);
    }

    const result = { reply, chatId, title: chat.title, stopped, concepts: items.map(i => i.name), stars: starRefs.map(k => graph?.nodes[k]?.label).filter(Boolean) };
    if (wantStream) {
      send({ t: "done", ...result });
      return res.end();
    }
    return res.status(200).json(result);
  } catch (e) {
    console.error(e);
    const error = e.message || "Couldn't reach the AI. Try again.";
    if (res.headersSent) { try { res.write(JSON.stringify({ t: "error", error }) + "\n"); } catch {} return res.end(); }
    return res.status(500).json({ error });
  }
}
