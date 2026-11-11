import { redis, getJSON, getAuth, MODEL_IDS, isAdminEmail } from "./_lib.js";

// Moo-llion: a daily word game. Everyone gets the same 7 prompts each day ("Name a dog breed").
// The rarer your (still correct) answer, the higher your cow's balloon floats.
// How rarity works: once a day Claude writes the prompts plus a long list of answers for each one,
// ranked from what most people would say to the most obscure. That list is saved in the database.
// Your answer is matched against the list; answers that aren't on it get one Claude check
// (is it correct, how obscure is it), which is saved so everyone gets the same verdict.
// Players on moollion.cc just pick a name (no password): the browser keeps a random player id
// and sends it as the x-moo-player header. Names are claimed so two people can't share one.
export const config = { maxDuration: 120 };

const N = 7, KEEP = 40 * 86400;
const EPOCH = Date.UTC(2026, 10, 8); // day #1
const TIERS = ["Pasture", "Treetops", "Clouds", "Jet stream", "Stratosphere", "One in a Moo-llion"];
const METERS = [[20, 90], [120, 300], [350, 800], [900, 1800], [2000, 3500], [4000, 6000]];
const LINES = [
  "Everyone said that one. Barely off the grass.",
  "A solid pick. Plenty of people thought of it.",
  "Nice. Fewer people went there.",
  "Now you're flying. Not many said that.",
  "Way up there. Almost nobody said that.",
  "One in a moo-llion. Nobody saw that coming.",
];
const BACKUP = ["Name a dog breed", "Name a fruit", "Name a sport", "Name a country", "Name a musical instrument", "Name a type of cheese", "Name a bird",
  "Name a vegetable", "Name a board game", "Name a body part", "Name a kind of tree", "Name a famous painter", "Name a pasta shape", "Name a dinosaur",
  "Name a car brand", "Name a planet or moon", "Name a fish", "Name a flower", "Name a breakfast food", "Name a chemical element", "Name a dance style"];

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const dayNum = d => Math.round((Date.parse(d + "T00:00:00Z") - EPOCH) / 86400000) + 1;
const shift = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const K = {
  day: d => `moo:day:${d}`, gen: d => `moo:gen:${d}`, plays: d => `moo:p:${d}`, verdict: (d, i) => `moo:v:${d}:${i}`,
  pid: id => `moo:pid:${id}`, name: n => `moo:name:${n}`, ip: (d, ip) => `moo:ip:${d}:${ip}`,
  user: e => `moo:u:${e}`, lock: e => `moo:lk:${e}`, judged: (d, e) => `moo:j:${d}:${e}`, recent: "moo:recent", rate: d => `moo:rate:${d}`,
};

/* ----- matching answers (forgiving about case, accents, "the", plurals and small typos) ----- */
export function norm(s) {
  let t = String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, "");
  if (t.length > 4 && t.endsWith("ies")) t = t.slice(0, -3) + "y";
  else if (t.length > 4 && /(ches|shes|sses|xes|oes)$/.test(t)) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1); // swapped letters
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    pp = prev; prev = cur;
  }
  return prev[b.length];
}
export function findInList(list, answer) {
  const k = norm(answer); if (!k) return -1;
  let near = -1, nearD = 9;
  for (let i = 0; i < list.length; i++) {
    for (const alias of String(list[i]).split("|")) {
      const a = norm(alias); if (!a) continue;
      if (a === k) return i;
      const max = k.length >= 9 ? 2 : k.length >= 5 ? 1 : 0;
      if (max) { const d = lev(a, k, max); if (d <= max && d < nearD) { near = i; nearD = d; } }
    }
  }
  return near;
}
// where an answer lands: tier 0-5 and meters
export function scoreFromRank(idx, len) {
  const p = len > 1 ? idx / (len - 1) : 0, cuts = [0, 0.1, 0.3, 0.55, 0.8, 1.0001];
  let t = 0; while (t < 4 && p >= cuts[t + 1]) t++;
  return place(t, (p - cuts[t]) / (cuts[t + 1] - cuts[t]));
}
// one rarity scale for everything: every answer on a day's list is rated on it, and so are new answers Claude checks.
// An answer's tier comes from its own rating (how rarely people would say it), not from its spot on the list.
export const RARITY_SCALE = `Picture asking 1,000 random people this prompt, each giving a few answers.
0-19 = lots of people would say it (the famous, obvious answers).
20-39 = a fair number of people would say it.
40-59 = most people know it but few would think to say it.
60-77 = rarely said; takes real knowledge of the topic.
78-91 = very rare; only fans or experts would come up with it.
92-100 = almost nobody would ever say it: truly one in a million.
Be strict: the most famous handful should be under 10, and only genuinely obscure answers go above 90.
Rate how rarely it would be SAID, not how hard it is to spell or how long it is. A famous thing is common even if it sits late in a list.`;
export const RARE_CUTS = [20, 40, 60, 78, 92];
export const rareTier = r => { const v = Math.max(0, Math.min(100, Number(r) || 0)); let t = 0; while (t < 5 && v >= RARE_CUTS[t]) t++; return t; };
export function scoreFromRating(r) {
  const v = Math.max(0, Math.min(100, Number(r) || 0)), cuts = [0, ...RARE_CUTS, 100.01], t = rareTier(v);
  return place(t, (v - cuts[t]) / (cuts[t + 1] - cuts[t]));
}
export const scoreFromObscurity = scoreFromRating;
function place(t, f) { const [lo, hi] = METERS[t]; return { tier: t, m: Math.round((lo + (hi - lo) * Math.max(0, Math.min(1, f))) / 10) * 10 }; }

/* ----- Claude ----- */
async function claude(model, system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_IDS[model], max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || "Claude request failed");
  const text = (d.content || []).map(c => c.text || "").join("");
  if (!text) throw new Error("Empty reply (" + d.stop_reason + ")");
  return text;
}
function parseJSON(text, open) {
  const s = text.indexOf(open), e = text.lastIndexOf(open === "[" ? "]" : "}");
  if (s < 0 || e < s) throw new Error("Bad JSON from Claude");
  return JSON.parse(text.slice(s, e + 1));
}
const SYS = "You help run Moo-llion, a daily word game. Players give ONE answer to each prompt and their cow's balloon floats higher the rarer (but still correct) the answer is. Reply with JSON only.";

async function makePrompts(recent, harder = false) {
  try {
    const t = await claude("sonnet", SYS, `Write 10 prompts for today's game.
Rules:
${harder ? `- Make these HARDER than usual: narrower categories that still have at least 80 real, checkable answers (like a bone in the human body, a Greek god, a constellation, a French dish, a chess opening, a Roman emperor). Still possible: an average high school student should be able to name at least 3 answers to each.`
  : `- Every prompt must have at least 150 real, checkable answers, from very common to very obscure (like dog breeds, fruits, sports, countries, cheeses, birds, board games, famous painters).`}
- Mix the themes: animals, food, places, science, sports, pop culture, everyday things, history. No two prompts on the same theme.
- Keep each under 40 characters and start with "Name a", "Name an" or "Name something".
- Nothing gross, mean or adult. Fun for high school students.
- Don't reuse any of these recent prompts: ${JSON.stringify(recent.slice(0, 50))}
Reply with only a JSON array of 10 strings.`, 800);
    const seen = new Set(recent.map(norm));
    const arr = parseJSON(t, "[").map(x => String(x).trim().slice(0, 60)).filter(x => x && !seen.has(norm(x))); // never repeat a recent prompt
    if (arr.length >= N) return arr.slice(0, N);
    console.error("moo prompts: only " + arr.length + " new prompts", t.slice(0, 200));
  } catch (e) { console.error("moo prompts", e.message); }
  const pool = BACKUP.filter(p => !recent.includes(p)), pick = [];
  while (pick.length < N) { const src = pool.length ? pool : BACKUP; const p = src.splice(Math.floor(Math.random() * src.length), 1)[0]; if (p && !pick.includes(p)) pick.push(p); }
  return pick;
}
async function makeList(prompt) {
  try {
    const t = await claude("sonnet", SYS, `Prompt: "${prompt}"
List 160 different correct answers, ordered from the answer the MOST people would say first, down to the most obscure answers that are still definitely correct.
Use each answer's most common name. Put alternate names or spellings after a | (example: "Chickpea|Garbanzo bean").
Reply with only a JSON array of strings.`, 4000);
    return parseJSON(t, "[").map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 220);
  } catch (e) { console.error("moo list", e.message); return []; }
}
// rates every answer on a list with the scale above
export async function rateList(prompt, list) {
  const names = list.map(x => x.split("|")[0]);
  const t = await claude("sonnet", SYS, `Prompt: "${prompt}"
Rate how RARE each answer below is as an answer to this prompt, from 0 to 100.
${RARITY_SCALE}
Answers:
${names.map((x, i) => (i + 1) + ". " + x).join("\n")}
Reply with only a JSON object mapping each answer's number to its rating, like {"1": 3, "2": 41}.`, 5000);
  const o = parseJSON(t, "{"), out = names.map((_, i) => { const v = Number(o[i + 1]); return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null; });
  const have = out.filter(v => v !== null).length;
  if (have < names.length * 0.8) throw new Error("Rated only " + have + " of " + names.length);
  for (let i = 0; i < out.length; i++) if (out[i] === null) { // fill gaps from the neighbors
    let a = i - 1; while (a >= 0 && out[a] === null) a--; let b = i + 1; while (b < out.length && out[b] === null) b++;
    out[i] = a >= 0 && b < out.length ? Math.round((out[a] + out[b]) / 2) : a >= 0 ? out[a] : b < out.length ? out[b] : 50;
  }
  return out;
}
// a few already-rated answers from the list, spread from common to rare, so a new answer is rated on the same footing
function anchors(list, rare) {
  if (!rare || !list.length) return "";
  const picks = [];
  for (const want of [5, 30, 50, 70, 88]) {
    let best = -1;
    for (let k = 0; k < list.length; k++) if (Number.isFinite(rare[k]) && !picks.includes(k) && (best < 0 || Math.abs(rare[k] - want) < Math.abs(rare[best] - want))) best = k;
    if (best >= 0) picks.push(best);
  }
  return picks.length ? `\nFor reference, these answers to the same prompt were rated: ${picks.map(k => `${list[k].split("|")[0]} = ${rare[k]}`).join(", ")}.` : "";
}
async function judge(prompt, answer, list = [], rare = null) {
  const t = await claude("haiku", SYS, `Prompt: "${prompt}"
Player's answer: "${answer}"
1. Is it a real, correct answer to the prompt? Be fair: accept normal spellings and small typos, but reject jokes, made-up things, things that don't fit, and answers that are too vague (like "dog" for "Name a dog breed").
2. If correct, how RARE is it as an answer, 0 to 100? ${RARITY_SCALE}${anchors(list, rare)}
Reply with only JSON: {"valid": true or false, "name": "the answer's proper name", "obscurity": number, "why": "a short friendly reason, max 12 words"}`, 200);
  const v = parseJSON(t, "{");
  return { valid: !!v.valid, name: String(v.name || answer).slice(0, 60), obscurity: Math.max(0, Math.min(100, Number(v.obscurity) || 0)), why: String(v.why || "").slice(0, 90) };
}

/* ----- the day's puzzle ----- */
async function getDay(d, harder = false, chosen = null) {
  const day = await getJSON(K.day(d));
  if (day) return day;
  const got = await redis("SET", K.gen(d), "1", "NX", "EX", "150");
  if (!got) return null; // someone else is making it right now
  try {
    const recent = (await redis("LRANGE", K.recent, "0", "60")) || [];
    const prompts = chosen || await makePrompts(recent, harder);
    const lists = await Promise.all(prompts.map(makeList));
    const made = { date: d, prompts, lists, ver: Date.now() };
    await redis("SET", K.day(d), JSON.stringify(made), "EX", String(KEEP)); // saved now, so the day exists even if rating runs out of time
    for (const p of prompts) await redis("LPUSH", K.recent, p);
    await redis("LTRIM", K.recent, "0", "80");
    return (await rateDay(d, made)) || made;
  } finally { await redis("DEL", K.gen(d)); }
}
// gives every answer on today's lists its own rarity rating (lists that are already rated are left alone)
const unrated = day => day.lists.some((l, i) => l.length && !(day.rare && Array.isArray(day.rare[i]) && day.rare[i].length === l.length));
async function rateDay(d, day) {
  if (!unrated(day)) return day;
  if (!(await redis("SET", K.rate(d), "1", "NX", "EX", "110"))) return null; // someone else is rating right now
  try {
    const rare = await Promise.all(day.lists.map(async (l, i) => {
      const have = day.rare && day.rare[i];
      if (!l.length || (Array.isArray(have) && have.length === l.length)) return have || null;
      try { return await rateList(day.prompts[i], l); } catch (e) { console.error("moo rate", e.message); return null; }
    }));
    const now = await getJSON(K.day(d));
    if (!now || now.ver !== day.ver) return null; // the day was restarted meanwhile
    now.rare = rare;
    await redis("SET", K.day(d), JSON.stringify(now), "EX", String(KEEP));
    return now;
  } finally { await redis("DEL", K.rate(d)); }
}

// who is playing: a random id kept in their browser, plus the name they picked
async function who(req) {
  const id = String(req.headers["x-moo-player"] || "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const p = await getJSON(K.pid(id));
  return { id, key: "p:" + id, name: p?.name || null };
}
const cleanName = n => String(n || "").replace(/[^\p{L}\p{N} _.'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);

async function view(d, day, email, name) {
  const all = (await redis("HGETALL", K.plays(d))) || [];
  const plays = {};
  for (let i = 0; i < all.length; i += 2) { try { plays[all[i]] = JSON.parse(all[i + 1]); } catch {} }
  const mine = plays[email] || { answers: [], total: 0 };
  const done = mine.answers.length >= N;
  const u = (await getJSON(K.user(email))) || {};
  const board = Object.entries(plays).filter(([e]) => e.startsWith("p:")).map(([e, p]) => {
    const best = p.answers.reduce((b, a) => (a.m > (b?.m ?? -1) ? a : b), null);
    return { name: p.name, total: p.total, count: p.answers.length, me: e === email, best: done && best ? { answer: best.answer, tier: best.tier } : null };
  }).sort((a, b) => b.total - a.total).slice(0, 30);
  return {
    date: d, num: dayNum(d), count: N, tiers: TIERS, name,
    prompts: day.prompts.slice(0, Math.min(N, mine.answers.length + 1)),
    answers: mine.answers, total: mine.total, done, unrated: unrated(day),
    streak: u.last === d || u.last === shift(d, -1) ? u.streak || 0 : 0,
    board,
  };
}

export default async function handler(req, res) {
  try {
    const d = today(), action = req.method === "POST" ? (req.body || {}).action : null;
    if (action === "newday") { // the site owner can throw out today's prompts and make a fresh set (everyone's flight for today restarts)
      const auth = await getAuth(req);
      if (!auth || (!auth.admin && !isAdminEmail(auth.user.email))) return res.status(403).json({ error: "Only the site owner can restart a day." });
      await redis("DEL", K.day(d), K.plays(d), K.gen(d));
      const chosen = Array.isArray(req.body.prompts) && req.body.prompts.length === N ? req.body.prompts.map(x => String(x).trim().slice(0, 60)) : null;
      const day = await getDay(d, !!req.body.harder, chosen);
      if (!day) return res.status(503).json({ error: "Someone else is making today's prompts right now. Try again in a minute." });
      return res.status(200).json({ ok: true, date: d, prompts: day.prompts });
    }
    if (action === "reset") { // the site owner (logged in to Nova) can wipe a player's flight for today
      const auth = await getAuth(req);
      if (!auth || (!auth.admin && !isAdminEmail(auth.user.email))) return res.status(403).json({ error: "Only the site owner can restart a day." });
      const pid = String(req.body.pid || "").toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(pid)) return res.status(400).json({ error: "Which player?" });
      const email = "p:" + pid;
      await redis("HDEL", K.plays(d), email);
      const u = (await getJSON(K.user(email))) || {};
      if (u.last === d) await redis("SET", K.user(email), JSON.stringify({ ...u, last: (u.streak || 0) > 1 ? shift(d, -1) : null, streak: Math.max(0, (u.streak || 0) - 1) }));
      return res.status(200).json({ ok: true });
    }

    const me = await who(req);
    if (!me) return res.status(401).json({ error: "Pick a name to play.", code: "name" });
    if (action === "hello") { // pick (or change) your name
      const nm = cleanName(req.body.name), low = nm.toLowerCase();
      if (nm.length < 2) return res.status(400).json({ error: "Names need at least 2 letters or numbers." });
      const owner = await redis("GET", K.name(low));
      if (owner && owner !== me.id) return res.status(409).json({ error: "That name is taken. Try another one." });
      if (!owner && !(await redis("SET", K.name(low), me.id, "NX"))) return res.status(409).json({ error: "That name is taken. Try another one." });
      if (me.name && me.name.toLowerCase() !== low && (await redis("GET", K.name(me.name.toLowerCase()))) === me.id) await redis("DEL", K.name(me.name.toLowerCase()));
      await redis("SET", K.pid(me.id), JSON.stringify({ name: nm, since: Date.now() }));
      me.name = nm;
      const ph = await redis("HGET", K.plays(d), me.key); // keep today's leaderboard name in sync
      if (ph) { const pl = JSON.parse(ph); pl.name = nm; await redis("HSET", K.plays(d), me.key, JSON.stringify(pl)); }
    }
    if (!me.name) return res.status(401).json({ error: "Pick a name to play.", code: "name" });
    const email = me.key, name = me.name;
    const day = await getDay(d);
    if (!day) return res.status(200).json({ preparing: true });

    if (req.method === "GET" && req.query?.rate) { await rateDay(d, day); return res.status(200).json({ ok: true }); } // a side request from the page: rate today's lists if they aren't yet
    if (req.method === "GET" || action === "hello") return res.status(200).json(action === "hello" ? { state: await view(d, day, email, name) } : await view(d, day, email, name));
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    if (action !== "answer" && action !== "skip") return res.status(400).json({ error: "Unknown action" });
    const got = await redis("SET", K.lock(email), "1", "NX", "PX", "20000");
    if (!got) return res.status(429).json({ error: "One answer at a time." });
    try {
      const plays = await redis("HGET", K.plays(d), email);
      const mine = plays ? JSON.parse(plays) : { name, answers: [], total: 0 };
      const i = mine.answers.length;
      if (i >= N) return res.status(400).json({ error: "You already finished today's flight." });
      if (Number(req.body.i) !== i) return res.status(409).json({ error: "That prompt is already done.", state: await view(d, day, email, name) });
      const prompt = day.prompts[i], list = day.lists[i] || [], rare = day.rare && Array.isArray(day.rare[i]) && day.rare[i].length === list.length ? day.rare[i] : null;
      // an answer on the list scores by its own rarity rating (so it can reach any tier); until a list is rated, by its spot on the list
      const listScore = k => rare && Number.isFinite(rare[k]) ? scoreFromRating(rare[k]) : scoreFromRank(k, list.length);
      let result;
      if (action === "skip") result = { answer: "", tier: -1, m: 0, note: "Skipped. The cow stayed put." };
      else {
        const raw = String(req.body.answer || "").replace(/\s+/g, " ").trim().slice(0, 50);
        if (raw.length < 2) return res.status(400).json({ error: "Type an answer first." });
        const at = findInList(list, raw);
        if (at >= 0) {
          const s = listScore(at);
          result = { answer: list[at].split("|")[0], ...s, note: at === 0 && s.tier === 0 ? "The number one answer. Everyone says that." : LINES[s.tier] };
        } else {
          const key = norm(raw);
          let v = await getJSON(`${K.verdict(d + (day.ver ? "." + day.ver : ""), i)}:${key}`);
          if (!v) {
            const n = await redis("INCR", K.judged(d, email));
            if (n === 1) await redis("EXPIRE", K.judged(d, email), "172800");
            if (n > 250) return res.status(429).json({ error: "That's a lot of guesses today. Try one of your answers again later." });
            const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 64) || "x";
            const ni = await redis("INCR", K.ip(d, ip));
            if (ni === 1) await redis("EXPIRE", K.ip(d, ip), "172800");
            if (ni > 3000) return res.status(429).json({ error: "Too many guesses from here today. Come back tomorrow." });
            try { v = await judge(prompt, raw, list, rare); } catch (e) { console.error("moo judge", e.message); return res.status(503).json({ error: "Couldn't check that answer right now. Try again." }); }
            await redis("SET", `${K.verdict(d + (day.ver ? "." + day.ver : ""), i)}:${key}`, JSON.stringify(v), "EX", String(KEEP));
          }
          if (!v.valid) return res.status(422).json({ error: v.why || "That doesn't fit the prompt. Try another answer.", code: "invalid" });
          const k2 = findInList(list, v.name); // Claude knew another name for something that's on the list
          const s = k2 >= 0 ? listScore(k2) : scoreFromRating(v.obscurity);
          result = { answer: k2 >= 0 ? list[k2].split("|")[0] : v.name || raw, ...s, note: k2 < 0 && v.why ? `${v.why}` : LINES[s.tier] };
        }
      }
      result.i = i;
      mine.name = name; mine.answers.push(result); mine.total = mine.answers.reduce((t, a) => t + a.m, 0);
      await redis("HSET", K.plays(d), email, JSON.stringify(mine));
      await redis("EXPIRE", K.plays(d), String(KEEP));
      if (mine.answers.length === N) { // finished: keep the streak going
        const u = (await getJSON(K.user(email))) || {};
        const streak = u.last === shift(d, -1) ? (u.streak || 0) + 1 : u.last === d ? u.streak || 1 : 1;
        await redis("SET", K.user(email), JSON.stringify({ last: d, streak, best: Math.max(u.best || 0, mine.total) }));
      }
      return res.status(200).json({ result, state: await view(d, day, email, name) });
    } finally { await redis("DEL", K.lock(email)); }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Something went wrong" });
  }
}
