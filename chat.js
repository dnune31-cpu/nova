const SYSTEM = `You are Nova, a friendly study helper for high school students.
Your goal is to help students understand, not to do their homework for them.
- Explain ideas clearly and simply, step by step, using examples.
- For homework problems, guide the student through the steps and check their thinking instead of only giving the final answer. If they've already tried, show the full solution so they can compare.
- When asked to quiz, ask one question at a time and wait for the answer.
- Use LaTeX for math: $...$ inline and $$...$$ for display.
- Keep answers focused and not too long. Be encouraging but honest when something is wrong.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: "No messages sent" });
  }

  const clean = messages
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-20);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 1500,
        system: SYSTEM,
        messages: clean,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error(data);
      return res.status(500).json({ error: data?.error?.message || "The AI request failed" });
    }
    const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    res.status(200).json({ reply: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't reach the AI. Try again." });
  }
}
