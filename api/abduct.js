import crypto from "node:crypto";
import { redis, getJSON, MODEL_IDS } from "./_lib.js";
import { norm, findInList, scoreFromRank, scoreFromObscurity } from "./moo.js";

// Alien Party (moollion.cc): a pass-the-turn party mode for 1 to 8 friends with a room code.
// Cows stand in a line. The alien's UFO hovers over whoever's turn it is and slowly beams them up
// (a hidden timer). Name something that fits the prompt before you get abducted. Everyone answers
// the same prompt for a random stretch of turns: one full trip around the line, sometimes a bit more,
// so nobody is always first on a fresh prompt.
// Rarer answers fill your power bar more; a full bar is an extra heart. Last cow standing wins.
// Rarity uses ranked answer lists (the same kind the daily game uses), kept in a shared prompt bank.
export const config = { maxDuration: 60 };

const TTL = 6 * 3600, LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const START_LIVES = 3, MAX_LIVES = 5, MAX_PLAYERS = 8, REVEAL = 2200; // REVEAL = the "new prompt!" moment before the beam starts
const PTS = [10, 16, 24, 34, 48, 70]; // power bar fill per rarity tier (100 = +1 heart)
const LEVELS = ["easy", "medium", "hard"], BOT_NAMES = ["Byte", "Pixel", "Bolt", "Chip", "Gizmo", "Sprocket", "Widget"];
const BOT = { // think = pause before typing, per = ms per letter, fail = chance it freezes, pick = part of the ranked list it answers from
  easy: { think: [2600, 5200], per: 150, fail: 0.2, pick: [0, 0.35] },
  medium: { think: [1800, 3600], per: 110, fail: 0.1, pick: [0.15, 0.7] },
  hard: { think: [1200, 2600], per: 80, fail: 0.04, pick: [0.4, 1] },
};
const SEED = [
  "Name a dog breed", "Name a fruit", "Name a sport", "Name a country", "Name a musical instrument",
  "Name a type of cheese", "Name a bird", "Name a vegetable", "Name a board game", "Name a kind of tree",
  "Name a famous painter", "Name a pasta shape", "Name a dinosaur", "Name a car brand", "Name a fish",
  "Name a flower", "Name a breakfast food", "Name a chemical element", "Name a dance style", "Name a city in Europe",
  "Name an insect", "Name a spice or herb", "Name a sea creature", "Name a superhero", "Name a type of bread",
  "Name a card game", "Name a river", "Name a farm animal", "Name a kitchen tool", "Name a planet, moon or star",
  "Name a Disney movie", "Name a video game", "Name a dessert", "Name a snake", "Name a gemstone",
  "Name a cat breed", "Name a type of pasta sauce", "Name a soup", "Name a candy bar", "Name an ice cream flavor",
  "Name a cereal brand", "Name a fast food chain", "Name a soda or soft drink", "Name a type of nut", "Name a type of bean",
  "Name a sandwich", "Name a type of cookie", "Name a cake", "Name a condiment or sauce", "Name a capital city",
  "Name a US state", "Name a country in Africa", "Name a country in Asia", "Name a city in South America", "Name an island",
  "Name a mountain or mountain range", "Name a desert", "Name a lake", "Name a famous landmark", "Name a national park",
  "Name an ocean or sea", "Name a volcano", "Name a mammal", "Name a reptile", "Name a shark species",
  "Name a whale or dolphin", "Name a monkey or ape", "Name a big cat", "Name a bird of prey", "Name a butterfly or moth",
  "Name a spider", "Name a frog or toad", "Name a bug that flies", "Name an animal that lives in the Arctic", "Name an animal found in Australia",
  "Name an extinct animal", "Name an Olympic sport", "Name a soccer club", "Name an NBA team", "Name an NFL team",
  "Name an MLB team", "Name a famous athlete", "Name a martial art", "Name a yoga pose", "Name a track and field event",
  "Name a swimming stroke", "Name a winter sport", "Name a gymnastics move", "Name a tennis player", "Name a Formula 1 driver",
  "Name a Pixar movie", "Name an animated TV show", "Name a Marvel character", "Name a DC character", "Name a Pokémon",
  "Name a Nintendo character", "Name a video game console", "Name a Harry Potter character", "Name a Star Wars character", "Name a Lord of the Rings character",
  "Name a Greek god or goddess", "Name a Norse god", "Name a mythical creature", "Name a fairy tale", "Name a bone in the human body",
  "Name an organ in the human body", "Name a muscle", "Name a disease", "Name a unit of measurement", "Name a shape",
  "Name a color", "Name a programming language", "Name a computer brand", "Name an app on a phone", "Name a social media platform",
  "Name a website", "Name a US president", "Name a famous scientist", "Name an inventor", "Name a famous composer",
  "Name a rapper", "Name a pop singer", "Name a rock band", "Name a boy band or girl group", "Name a musical (stage show)",
  "Name an opera", "Name a famous author", "Name a novel", "Name a poet", "Name a Shakespeare play",
  "Name a tool in a toolbox", "Name a thing in a bathroom", "Name a thing in a classroom", "Name a school subject", "Name a piece of furniture",
  "Name a kitchen appliance", "Name a type of shoe", "Name a type of hat", "Name a piece of clothing", "Name a fabric",
  "Name a type of boat", "Name a type of aircraft", "Name a car model", "Name a bicycle part", "Name a profession",
  "Name a thing that's yellow", "Name a thing that's round", "Name a thing with wheels", "Name a thing that's cold", "Name a thing that flies",
  "Name a thing that's sticky", "Name a word that rhymes with cat", "Name a word that starts with Q", "Name a word with double letters", "Name a palindrome word",
  "Name an onomatopoeia (sound word)", "Name an emotion", "Name a weather event", "Name a holiday", "Name a language",
  "Name an alphabet or writing system", "Name a currency", "Name a type of dance music", "Name a guitar brand", "Name a chess opening",
  "Name a knot", "Name a cloud type", "Name a rock or mineral", "Name a constellation", "Name a famous ship",
  "Name a drink you'd order at a café", "Name a tech company", "Name a festival or celebration", "Name a metal", "Name a tarot card",
];
const key = c => `ab:${c}`, tkey = c => `ab:${c}:t`, BANK = "ab:bank";
const clean = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const between = ([a, b]) => a + crypto.randomInt(b - a + 1);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

/* ----- Claude (same checks as the daily game) ----- */
async function claude(model, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_IDS[model], max_tokens: maxTokens, system: "You help run Moo-llion, a word game where players name answers to prompts and rarer correct answers score more. Reply with JSON only.", messages: [{ role: "user", content: user }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || "Claude request failed");
  return (d.content || []).map(c => c.text || "").join("");
}
function parseJSON(t, open) { const s = t.indexOf(open), e = t.lastIndexOf(open === "[" ? "]" : "}"); if (s < 0 || e < s) throw new Error("Bad JSON"); return JSON.parse(t.slice(s, e + 1)); }
async function judge(prompt, answer) {
  const t = await claude("haiku", `Prompt: "${prompt}"
Player's answer: "${answer}"
1. Is it a real, correct answer to the prompt? Be fair: accept normal spellings and small typos, but reject jokes, made-up things, things that don't fit, and answers that are too vague.
2. If correct, how obscure is it from 0 to 100? 0 = the first thing everyone says. 50 = most people know it but wouldn't think of it. 80 = only fans or experts would know it. 100 = almost nobody has heard of it.
Reply with only JSON: {"valid": true or false, "name": "the answer's proper name", "obscurity": number, "why": "a short friendly reason, max 10 words"}`, 160);
  const v = parseJSON(t, "{");
  return { valid: !!v.valid, name: String(v.name || answer).slice(0, 50), obscurity: Math.max(0, Math.min(100, Number(v.obscurity) || 0)), why: String(v.why || "").slice(0, 80) };
}
async function makeList(prompt) {
  const t = await claude("haiku", `Prompt: "${prompt}"
List 120 different correct answers, ordered from the answer the MOST people would say first, down to the most obscure answers that are still definitely correct.
Use each answer's most common name. Put alternate names or spellings after a | (example: "Chickpea|Garbanzo bean").
Reply with only a JSON array of strings.`, 4000);
  let arr; try { arr = parseJSON(t, "["); } catch { // cut off mid-list: keep every complete answer
    const s = t.indexOf("["), e = t.lastIndexOf('",'); if (s < 0 || e < s) throw new Error("Bad JSON " + t.length + ": " + t.slice(0, 160).replace(/\s+/g, " ")); arr = JSON.parse(t.slice(s, e + 1) + "]");
  }
  return arr.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 200);
}

/* ----- the prompt bank: prompts with ranked answer lists, shared by every room ----- */
async function bankPrompts() {
  const have = (await redis("HKEYS", BANK)) || [];
  if (have.length < 10) { // borrow the daily game's prompts and lists
    for (let k = 0; k < 30; k++) {
      const d = new Date(Date.now() - k * 86400000), ds = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
      const day = await getJSON(`moo:day:${ds}`);
      if (day) for (let i = 0; i < day.prompts.length; i++) { const p = day.prompts[i]; if (day.lists[i]?.length >= 40 && !have.includes(p)) { have.push(p); await redis("HSET", BANK, p, JSON.stringify(day.lists[i])); } }
    }
  }
  return have;
}
// adds a few missing prompt lists to the bank at once (each prompt is only ever written by one request)
async function growBank(have, n = 3) {
  const todo = SEED.filter(p => !have.includes(p)).sort(() => Math.random() - 0.5), picked = [];
  for (const p of todo) { if (picked.length >= n) break; if (await redis("SET", "ab:g2:" + norm(p), "1", "NX", "EX", "60")) picked.push(p); }
  const made = await Promise.all(picked.map(async p => {
    try { const list = await makeList(p); if (list.length >= 40) { await redis("HSET", BANK, p, JSON.stringify(list)); return p; } }
    catch (e) { console.error("abduct list", e.message); }
    await redis("SET", "ab:g2:" + norm(p), "1", "EX", "21600"); // didn't work out: leave this prompt alone for a few hours
    return null;
  }));
  return made.filter(Boolean);
}
async function listFor(prompt) { const v = await redis("HGET", BANK, prompt); return v ? JSON.parse(v) : []; }

/* ----- game helpers ----- */
function fuseRange(round) { const f = Math.pow(0.94, round - 1); return [Math.max(6000, Math.round(10500 * f)), Math.max(8500, Math.round(16500 * f))]; }
function event(room, e) { room.seq = (room.seq || 0) + 1; room.event = { seq: room.seq, ...e, at: Date.now() }; }
const inGame = p => p.alive && !p.left;
function nextAlive(room, from) { const n = room.players.length; for (let s = 1; s <= n; s++) { const i = (from + s) % n; if (inGame(room.players[i])) return i; } return from; }
function newBeam(room) { const [a, b] = fuseRange(room.round || 1), t = a + crypto.randomInt(b - a + 1), start = Math.max(Date.now(), room.reveal || 0); room.beam = { start, total: t, deadline: start + t }; }
function nextPrompt(room) {
  if (!room.deck?.length) room.deck = [...room.pool].sort(() => Math.random() - 0.5).filter(p => p !== room.prompt);
  room.prompt = room.deck.shift() || room.pool[0]; room.used = []; room.reveal = Date.now() + REVEAL;
  const alive = Math.max(1, room.players.filter(inGame).length); // lasts one trip around the line, sometimes up to half a trip more
  room.promptLeft = alive + crypto.randomInt(Math.ceil(alive * 0.6) + 1);
}
function endTurn(room) { // a round ends once everyone still in has had a turn
  room.roundTurns = (room.roundTurns || 0) + 1;
  if (room.roundTurns >= Math.max(1, room.players.filter(inGame).length)) { room.round = (room.round || 1) + 1; room.roundTurns = 0; return true; }
  return false;
}
function newTurn(room, i, newPrompt) { room.turn = i; room.turnId = (room.turnId || 0) + 1; room.botPlan = null; if (newPrompt || !room.prompt) nextPrompt(room); }
const promptDone = room => { room.promptLeft = (room.promptLeft || 1) - 1; return room.promptLeft <= 0; };
function checkOver(room) {
  const alive = room.players.map((p, i) => [p, i]).filter(([p]) => inGame(p));
  if (alive.length === 0 || (!room.solo && alive.length <= 1)) { room.status = "over"; room.winner = alive.length ? alive[0][1] : -1; return true; }
  return false;
}
// too slow: the UFO beams the cow up and it loses a heart (checked whenever anyone looks at the room)
function tick(room) {
  if (room.status !== "playing" || Date.now() < room.beam.deadline) return false;
  const i = room.turn, p = room.players[i];
  p.lives = Math.max(0, p.lives - 1); if (p.lives === 0) p.alive = false;
  const e = { type: "abduct", by: i, prompt: room.prompt, out: !p.alive };
  if (!checkOver(room)) { if (endTurn(room)) e.round = room.round; const np = promptDone(room); if (np) e.newPrompt = true; newTurn(room, nextAlive(room, i), np); newBeam(room); }
  else e.win = true;
  event(room, e);
  return true;
}
function accept(room, i, ans) { // ans = {key, answer, tier}
  const p = room.players[i], pts = PTS[ans.tier];
  room.used.push(ans.key); p.last = { answer: ans.answer, tier: ans.tier }; p.answers = (p.answers || 0) + 1;
  if (!p.best || ans.tier > p.best.tier) p.best = { answer: ans.answer, tier: ans.tier };
  p.power = (p.power || 0) + pts;
  let full = false, bonus = false;
  if (p.power >= 100) { p.power = 0; full = true; bonus = p.lives < MAX_LIVES; if (bonus) p.lives++; }
  const e = { type: "answer", by: i, answer: ans.answer, tier: ans.tier, pts, full, bonus, note: ans.note || "" };
  const up = endTurn(room); if (up) e.round = room.round;
  const np = promptDone(room); if (np) e.newPrompt = true;
  newTurn(room, nextAlive(room, i), np); newBeam(room);
  event(room, e);
}

/* ----- bots ----- */
function botStep(room, list) {
  if (room.status !== "playing") return false;
  const i = room.turn, p = room.players[i];
  if (!p?.bot) return false;
  const now = Date.now(), plan = room.botPlan;
  if (!plan || plan.turnId !== room.turnId) {
    const c = BOT[p.bot] || BOT.medium, n = list.length, [a, b] = c.pick;
    const free = [];
    for (let k = Math.floor(a * n); k < Math.max(Math.floor(a * n) + 1, Math.floor(b * n)); k++) if (list[k] && !room.used.includes("i:" + k)) free.push(k);
    const k = free.length && Math.random() >= c.fail ? free[crypto.randomInt(free.length)] : -1;
    const text = k >= 0 ? list[k].split("|")[0] : (list[crypto.randomInt(Math.max(1, n))] || "uhh").split("|")[0].slice(0, 3) + "…";
    const typeAt = Math.max(now, room.reveal || 0) + between(c.think);
    room.botPlan = { turnId: room.turnId, k, text, typeAt, per: c.per, doneAt: k >= 0 ? typeAt + text.length * c.per + 400 : null };
    return true;
  }
  if (plan.k >= 0 && now >= plan.doneAt) {
    const s = scoreFromRank(plan.k, list.length);
    accept(room, i, { key: "i:" + plan.k, answer: plan.text, tier: s.tier });
    return true;
  }
  return false;
}
const botNeeds = room => {
  if (room.status !== "playing") return false;
  const p = room.players[room.turn]; if (!p?.bot) return false;
  const plan = room.botPlan; return !plan || plan.turnId !== room.turnId || (plan.k >= 0 && Date.now() >= plan.doneAt);
};
function botView(room) {
  const p = room.players[room.turn], plan = room.botPlan;
  if (room.status !== "playing" || !p?.bot || !plan || plan.turnId !== room.turnId) return null;
  return { turnId: plan.turnId, text: plan.text, startIn: plan.typeAt - Date.now(), per: plan.per };
}

function view(room, me, typing) {
  const mi = room.players.findIndex(p => p.id === me);
  const heat = room.status === "playing" ? Math.max(0, Math.min(1, (Date.now() - room.beam.start) / room.beam.total)) : 0;
  return {
    code: room.code, status: room.status, me: mi, host: mi === 0,
    players: room.players.map((p, i) => ({ name: p.name, lives: p.lives ?? START_LIVES, power: p.power || 0, alive: p.alive !== false, left: !!p.left, last: p.last || null, best: p.best || null, answers: p.answers || 0, bot: p.bot || null, me: i === mi })),
    turn: room.turn ?? 0, turnId: room.turnId || 0, prompt: room.prompt || null, round: room.round || 1, usedCount: (room.used || []).length,
    heat: Math.round(heat * 1000) / 1000, heatRate: room.status === "playing" ? Math.round(1e6 / room.beam.total) / 1000 : 0,
    revealIn: room.status === "playing" ? Math.max(0, (room.reveal || 0) - Date.now()) : 0, promptLeft: room.promptLeft || 0,
    botType: botView(room), winner: room.winner ?? null, event: room.event || null, seq: room.seq || 0, game: room.game || 1,
    typing: typing && typing.turnId === room.turnId && room.status === "playing" ? { text: typing.text || "", bad: typing.bad || null } : null,
    maxLives: MAX_LIVES, preparing: !!room.preparing,
  };
}
async function save(room) { await redis("SET", key(room.code), JSON.stringify(room), "EX", String(TTL)); }
async function load(code) { const [r, t] = await Promise.all([redis("GET", key(code)), redis("GET", tkey(code))]); return [r ? JSON.parse(r) : null, t ? JSON.parse(t) : null]; }
async function setTyping(room, text, bad) { await redis("SET", tkey(room.code), JSON.stringify({ turnId: room.turnId, text: String(text).slice(0, 40), bad: bad || null }), "EX", String(TTL)); }
async function withLock(code, fn) {
  const lk = `ab:${code}:lock`, tok = crypto.randomBytes(6).toString("hex");
  let got = false;
  for (let i = 0; i < 30 && !got; i++) { got = !!(await redis("SET", lk, tok, "NX", "PX", "5000")); if (!got) await sleep(70); }
  if (!got) throw Object.assign(new Error("The room is busy. Try again."), { status: 503 });
  try { return await fn(); } finally { if ((await redis("GET", lk)) === tok) await redis("DEL", lk); }
}
async function who(req) {
  const id = String(req.headers["x-moo-player"] || "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  const p = await getJSON(`moo:pid:${id}`);
  return p?.name ? { id, name: p.name } : null;
}

export default async function handler(req, res) {
  try {
    const me = await who(req);
    if (!me) return res.status(401).json({ error: "Pick a name to play.", code: "name" });
    const id = me.id;

    if (req.method === "GET") {
      const code = clean(req.query?.code);
      let [room, typing] = await load(code);
      if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      if (room.status === "playing" && (Date.now() >= room.beam.deadline || botNeeds(room))) {
        const list = await listFor(room.prompt);
        room = await withLock(code, async () => {
          const r = await getJSON(key(code)); if (!r) return r;
          let changed = tick(r);
          changed = botStep(r, r.prompt === room.prompt ? list : await listFor(r.prompt)) || changed;
          if (changed) await save(r);
          return r;
        });
        if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      } else if (room.status !== "playing" && req.query?.grow) { // a side request from the lobby: add a few prompts to the shared bank
        const have = await bankPrompts();
        if (SEED.some(p => !have.includes(p))) await growBank(have, 3);
      }
      return res.status(200).json({ room: view(room, id, typing) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });
    const { action } = req.body || {};

    if (action === "create") {
      let code = "";
      for (let t = 0; t < 8; t++) { code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join(""); if (!(await redis("EXISTS", key(code)))) break; }
      const room = { code, status: "lobby", players: [{ id, name: me.name }], game: 1, seq: 0, used: [] };
      await save(room);
      return res.status(200).json({ room: view(room, id) });
    }
    const code = clean(req.body?.code);

    if (action === "type") {
      const [room] = await load(code);
      if (!room) return res.status(404).json({ error: "No room with that code." });
      const mi = room.players.findIndex(p => p.id === id);
      if (room.status === "playing" && mi === room.turn && req.body.turnId === room.turnId) await setTyping(room, String(req.body.text || "").slice(0, 40));
      return res.status(200).json({ ok: true });
    }

    // an answer is checked before taking the room lock (checking a new answer with Claude can take a second)
    let checked = null;
    if (action === "answer") {
      const at = Date.now();
      const [room0] = await load(code);
      if (!room0) return res.status(404).json({ error: "No room with that code." });
      const mi = room0.players.findIndex(p => p.id === id);
      if (room0.status !== "playing" || mi !== room0.turn) return res.status(400).json({ error: "It's not your turn." });
      if (at < (room0.reveal || 0)) return res.status(400).json({ error: "Wait for the new prompt!", code: "wait" });
      const raw = String(req.body.answer || "").replace(/\s+/g, " ").trim().slice(0, 50);
      if (raw.length < 2) return res.status(400).json({ error: "Type an answer first." });
      const list = await listFor(room0.prompt), k = findInList(list, raw);
      if (k >= 0) { const s = scoreFromRank(k, list.length); checked = { key: "i:" + k, answer: list[k].split("|")[0], tier: s.tier }; }
      else {
        const nk = norm(raw), vk = `ab:v:${norm(room0.prompt)}:${nk}`;
        let v = await getJSON(vk);
        if (!v) {
          const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 64) || "x", ik = `moo:ip:${today()}:${ip}`;
          const ni = await redis("INCR", ik); if (ni === 1) await redis("EXPIRE", ik, "172800");
          if (ni > 400) return res.status(429).json({ error: "Too many guesses from here today." });
          try { v = await judge(room0.prompt, raw); } catch { return res.status(503).json({ error: "Couldn't check that answer. Try again fast!" }); }
          await redis("SET", vk, JSON.stringify(v), "EX", String(30 * 86400));
        }
        if (!v.valid) { await setTyping(room0, raw, "bad"); return res.status(400).json({ error: v.why || "That doesn't fit the prompt.", code: "invalid" }); }
        const s = scoreFromObscurity(v.obscurity);
        checked = { key: "n:" + norm(v.name || raw), alt: "n:" + nk, answer: v.name || raw, tier: s.tier, note: v.why };
      }
      checked.at = at; checked.turnId = room0.turnId;
    }

    const out = await withLock(code, async () => {
      const room = await getJSON(key(code));
      if (!room) return [404, { error: "No room with that code. Check it and try again." }];
      const mi = room.players.findIndex(p => p.id === id);
      const reply = async (status, extra = {}) => { const [, t] = await load(code); return [status, { ...extra, room: view(room, id, t) }]; };

      if (action === "join") {
        if (mi < 0) {
          if (room.status === "playing") return [409, { error: "That game already started. Wait for the next one." }];
          if (room.players.filter(p => !p.left).length >= MAX_PLAYERS) return [409, { error: "That room is full (8 cows)." }];
          if (room.status === "over") room.players = room.players.filter(p => !p.left);
          room.players.push({ id, name: me.name });
          room.players.sort((a, b) => (a.bot ? 1 : 0) - (b.bot ? 1 : 0));
          event(room, { type: "join", by: room.players.findIndex(p => p.id === id) });
          await save(room);
        } else if (room.players[mi].name !== me.name && room.status !== "playing") { room.players[mi].name = me.name; await save(room); }
        return reply(200);
      }
      if (mi < 0) return [403, { error: "You're not in this room." }];

      if (action === "addbot" || action === "removebot") {
        if (mi !== 0) return reply(403, { error: "Only the host can add bots." });
        if (room.status === "playing") return reply(400, { error: "Wait until this game ends." });
        if (action === "addbot") {
          if (room.players.filter(p => !p.left).length >= MAX_PLAYERS) return reply(400, { error: "The room is full." });
          const lv = LEVELS.includes(req.body.level) ? req.body.level : "medium", used = new Set(room.players.map(p => p.name));
          room.players.push({ id: "bot:" + crypto.randomBytes(4).toString("hex"), name: BOT_NAMES.find(n => !used.has(n)) || "Bot", bot: lv });
          event(room, { type: "join", by: room.players.length - 1 });
        } else {
          const i = Number(req.body.index);
          if (!room.players[i]?.bot) return reply(400, { error: "That's not a bot." });
          room.players.splice(i, 1);
        }
        await save(room);
        return reply(200);
      }
      if (action === "start") {
        if (mi !== 0) return reply(403, { error: "Only the host can start." });
        if (room.status === "playing") return reply(400, { error: "The game already started." });
        let pool = await bankPrompts();
        if (pool.length < 5) { await growBank(pool, 5); pool = await bankPrompts(); }
        if (!pool.length) return reply(503, { error: "The aliens are still writing prompts. Try again in a few seconds." });
        room.pool = pool; room.deck = [];
        room.players = room.players.filter(p => !p.left).sort((a, b) => (a.bot ? 1 : 0) - (b.bot ? 1 : 0));
        room.players.forEach(p => { p.lives = START_LIVES; p.power = 0; p.answers = 0; p.alive = true; p.last = null; p.best = null; });
        room.solo = room.players.length === 1;
        if (room.status === "over") room.game = (room.game || 1) + 1;
        room.winner = null; room.status = "playing"; room.round = 1; room.roundTurns = 0; room.prompt = null;
        newTurn(room, crypto.randomInt(room.players.length), true); newBeam(room);
        event(room, { type: "start" });
        await save(room);
        return reply(200);
      }
      if (action === "leave") {
        if (room.status === "lobby") {
          room.players.splice(mi, 1);
          if (!room.players.some(p => !p.bot)) { await redis("DEL", key(code), tkey(code)); return [200, { ok: true }]; }
        } else {
          const p = room.players[mi]; p.left = true; p.alive = false;
          if (!room.players.some(x => !x.bot && !x.left)) { await redis("DEL", key(code), tkey(code)); return [200, { ok: true }]; }
          if (room.status === "playing" && !checkOver(room) && room.turn === mi) { newTurn(room, nextAlive(room, mi), false); newBeam(room); }
        }
        event(room, { type: "leave", by: mi });
        await save(room);
        return [200, { ok: true }];
      }
      if (room.status !== "playing") return reply(400, { error: "The game isn't going right now." });

      if (action === "answer") {
        // the answer counts if it arrived before the beam finished, even if checking it took a moment
        if (room.turnId !== checked.turnId || room.turn !== mi) { tick(room); await save(room); return reply(400, { error: "Too slow! 🛸", code: "abducted" }); }
        if (checked.at > room.beam.deadline) { tick(room); await save(room); return reply(400, { error: "Too slow! 🛸", code: "abducted" }); }
        if (room.used.includes(checked.key) || (checked.alt && room.used.includes(checked.alt))) return reply(400, { error: "Someone already said that!", code: "used" });
        if (checked.alt) room.used.push(checked.alt);
        accept(room, mi, checked);
        await save(room);
        return reply(200);
      }
      return [400, { error: "Unknown action" }];
    });
    return res.status(out[0]).json(out[1]);
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.message || "Something went wrong" });
  }
}
