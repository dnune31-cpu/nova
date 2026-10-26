const MODELS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

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

async function buildContent(m, withExtras) {
  const text = typeof m.content === "string" ? m.content.slice(0, 8000) : "";
  if (!withExtras) return text || "(attachment)";

  const blocks = [];
  for (const a of (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 6)) {
    if (a.type === "image" && IMAGE_TYPES.includes(a.media_type) && typeof a.data === "string") {
      blocks.push({ type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } });
    } else if (a.type === "pdf" && typeof a.data === "string") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } });
    } else if (a.type === "text" && typeof a.text === "string") {
      blocks.push({ type: "text", text: `File: ${String(a.name || "file").slice(0, 100)}\n\n${a.text.slice(0, 60000)}` });
    }
  }

  const links = [...new Set([
    ...(Array.isArray(m.links) ? m.links : []),
    ...(text.match(URL_RE) || []),
  ])].slice(0, 3);
  const pages = await Promise.all(links.map(readPage));
  for (const p of pages) blocks.push({ type: "text", text: p });

  if (blocks.length === 0) return text || "(empty message)";
  blocks.push({ type: "text", text: text || "Please look at what I attached." });
  return blocks;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const model = MODELS[req.body?.model] || MODELS.haiku;
  let msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  msgs = msgs.filter(m => m && (m.role === "user" || m.role === "assistant")).slice(-12);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length) return res.status(400).json({ error: "No messages sent" });

  const lastUser = msgs.map(m => m.role).lastIndexOf("user");
  const messages = await Promise.all(msgs.map(async (m, i) => ({
    role: m.role,
    content: await buildContent(m, i === lastUser),
  })));

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1500, system: SYSTEM, messages }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error(data);
      return res.status(500).json({ error: data?.error?.message || "The AI request failed" });
    }
    const reply = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    res.status(200).json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't reach the AI. Try again." });
  }
}
