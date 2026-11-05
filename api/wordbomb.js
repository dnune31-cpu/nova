import crypto from "node:crypto";
import { redis, getJSON, getAuth } from "./_lib.js";

// Word Bomb: party word game for 1 to 8 friends with a room code.
// On your turn, type a real word that contains the letters shown before the bomb goes off.
// The fuse is random and hidden, and resets after every good word. Each round the fuse gets shorter
// and the letters get harder. Good words fill your power bar; a full bar is an extra life.
const TTL = 6 * 3600;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const START_LIVES = 3, MAX_LIVES = 5, MAX_PLAYERS = 8;
const SCRABBLE = { a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3, n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10 };
// how much a word fills your power bar (out of 100): longer words and rare letters count more
const wordPoints = w => Math.max(5, Math.min(40, Math.round([...w].reduce((t, ch) => t + (SCRABBLE[ch] || 1), 0) * 1.1 + Math.max(0, w.length - 5) * 2)));
// the fuse for each bomb: a random length that shrinks every round
function fuseRange(round) { const f = Math.pow(0.88, round - 1); return [Math.max(3500, Math.round(10000 * f)), Math.max(6000, Math.round(17000 * f))]; }
const WORD_URLS = [
  "https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt",
  "https://cdn.jsdelivr.net/gh/dolph/dictionary@master/enable1.txt",
];
const LEVELS = ["easy", "medium", "hard"];
const BOT_NAMES = ["Byte", "Pixel", "Bolt", "Chip", "Gizmo", "Sprocket", "Widget"];
const BOT = { // think = pause before typing, per = ms per letter, fail = chance it freezes up, len = word lengths it likes
  easy: { think: [2200, 4800], per: 260, fail: 0.25, len: [3, 6] },
  medium: { think: [1300, 3000], per: 170, fail: 0.1, len: [4, 8] },
  hard: { think: [600, 1500], per: 105, fail: 0.03, len: [5, 11] },
};
const key = c => `wb:${c}`;
const tkey = c => `wb:${c}:t`;
const clean = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ----- word list (loaded once per server instance) ----- */
let WORDS = null, DICT = null, TIERS = null, loading = null;
function loadWords() {
  if (DICT) return Promise.resolve();
  if (!loading) loading = (async () => {
    let txt = "";
    for (const u of WORD_URLS) {
      try { const r = await fetch(u); if (r.ok) { txt = await r.text(); if (txt.length > 500000) break; } } catch {}
    }
    if (txt.length < 500000) { loading = null; throw new Error("Couldn't load the word list. Try again in a moment."); }
    WORDS = txt.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => /^[a-z]{2,}$/.test(w));
    DICT = new Set(WORDS);
    const counts = new Map();
    for (const w of WORDS) {
      const seen = new Set();
      for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) seen.add(w.slice(i, i + n));
      for (const s of seen) counts.set(s, (counts.get(s) || 0) + 1);
    }
    // letter groups sorted by how many words have them: easy ones are common, hard ones are rare
    const all = [...counts];
    TIERS = [all.filter(([, c]) => c >= 2500), all.filter(([, c]) => c >= 1000 && c < 2500), all.filter(([, c]) => c >= 400 && c < 1000)].map(t => t.map(([x]) => x));
  })();
  return loading;
}
function newPrompt(round) { // harder letters show up more often as the rounds go on
  const r = round - 1, w = [Math.max(0.05, 1 - r * 0.18), 0.6, Math.min(1.4, r * 0.2)];
  let x = Math.random() * (w[0] + w[1] + w[2]), t = 0;
  while (t < 2 && x > w[t]) { x -= w[t]; t++; }
  const tier = TIERS[t];
  return tier[crypto.randomInt(tier.length)];
}

/* ----- bots ----- */
const between = ([a, b]) => a + crypto.randomInt(b - a + 1);
function botWord(prompt, used, lv) {
  const [a, b] = BOT[lv].len, start = crypto.randomInt(WORDS.length);
  let fallback = null;
  for (let k = 0; k < WORDS.length; k++) {
    const w = WORDS[(start + k) % WORDS.length];
    if (!w.includes(prompt) || used.includes(w)) continue;
    if (w.length >= a && w.length <= b) return w;
    if (!fallback) fallback = w;
  }
  return fallback;
}
// a bot plans its turn once (what to type and when), then the word goes in when the time comes
function botStep(room) {
  if (room.status !== "playing") return false;
  const i = room.turn, p = room.players[i];
  if (!p || !p.bot) return false;
  const now = Date.now(), plan = room.botPlan;
  if (!plan || plan.turnId !== room.turnId) {
    const c = BOT[p.bot] || BOT.medium, fail = Math.random() < c.fail;
    const word = botWord(room.prompt, room.used, p.bot);
    const typeAt = now + between(c.think);
    room.botPlan = fail || !word
      ? { turnId: room.turnId, word: null, text: word ? word.slice(0, Math.max(room.prompt.length, Math.ceil(word.length / 2))) : room.prompt, typeAt, per: c.per * 1.6 }
      : { turnId: room.turnId, word, text: word, typeAt, per: c.per, doneAt: typeAt + word.length * c.per + 300 };
    return true;
  }
  if (plan.word && now >= plan.doneAt) { acceptWord(room, i, plan.word); return true; }
  return false;
}
const botNeeds = room => {
  if (room.status !== "playing") return false;
  const p = room.players[room.turn];
  if (!p || !p.bot) return false;
  const plan = room.botPlan;
  return !plan || plan.turnId !== room.turnId || (plan.word && Date.now() >= plan.doneAt);
};
function botTyping(room) { // what the bot has typed so far, letter by letter
  const p = room.players[room.turn], plan = room.botPlan;
  if (!p?.bot || !plan || plan.turnId !== room.turnId) return null;
  const n = Math.max(0, Math.min(plan.text.length, Math.floor((Date.now() - plan.typeAt) / plan.per)));
  return { text: plan.text.slice(0, n).toUpperCase(), bad: null };
}
const humansFirst = room => { room.players.sort((a, b) => (a.bot ? 1 : 0) - (b.bot ? 1 : 0)); };

/* ----- game helpers ----- */
function event(room, e) { room.seq = (room.seq || 0) + 1; room.event = { seq: room.seq, ...e, at: Date.now() }; }
const inGame = p => p.alive && !p.left;
function nextAlive(room, from) {
  const n = room.players.length;
  for (let s = 1; s <= n; s++) { const i = (from + s) % n; if (inGame(room.players[i])) return i; }
  return from;
}
function newBomb(room) { const [a, b] = fuseRange(room.round || 1), t = a + crypto.randomInt(b - a + 1); room.bomb = { start: Date.now(), total: t, deadline: Date.now() + t }; }
// a round ends once everyone still in has had a turn
function endTurn(room) {
  room.roundTurns = (room.roundTurns || 0) + 1;
  if (room.roundTurns >= Math.max(1, room.players.filter(inGame).length)) { room.round = (room.round || 1) + 1; room.roundTurns = 0; return true; }
  return false;
}
function newTurn(room, i) { room.turn = i; room.turnId = (room.turnId || 0) + 1; room.turnStart = Date.now(); room.prompt = newPrompt(room.round || 1); }
function checkOver(room) {
  const alive = room.players.map((p, i) => [p, i]).filter(([p]) => inGame(p));
  if (alive.length === 0 || (!room.solo && alive.length <= 1)) {
    room.status = "over"; room.winner = alive.length ? alive[0][1] : -1;
    return true;
  }
  return false;
}
// the bomb goes off if its time ran out (checked whenever anyone looks at the room)
function tick(room) {
  if (room.status !== "playing" || Date.now() < room.bomb.deadline) return false;
  const i = room.turn, p = room.players[i];
  p.lives = Math.max(0, p.lives - 1);
  if (p.lives === 0) p.alive = false;
  const e = { type: "boom", by: i, prompt: room.prompt, out: !p.alive };
  if (!checkOver(room)) { if (endTurn(room)) e.round = room.round; newTurn(room, nextAlive(room, i)); newBomb(room); }
  else e.win = true;
  event(room, e);
  return true;
}
function acceptWord(room, me, w) {
  const p = room.players[me];
  room.used.push(w); p.last = w; p.words = (p.words || 0) + 1;
  const pts = wordPoints(w);
  p.power = (p.power || 0) + pts;
  let bonus = false, full = false;
  if (p.power >= 100) { p.power = 0; full = true; bonus = p.lives < MAX_LIVES; if (bonus) p.lives++; }
  const e = { type: "word", by: me, word: w, prompt: room.prompt, pts, bonus, full };
  if (endTurn(room)) e.round = room.round;
  newTurn(room, nextAlive(room, me));
  newBomb(room); // a good word resets the bomb
  event(room, e);
}
function stage(room) {
  if (room.status !== "playing") return 0;
  const f = (Date.now() - room.bomb.start) / room.bomb.total;
  return f < 0.5 ? 0 : f < 0.8 ? 1 : 2;
}

function view(room, email, typing) {
  const me = room.players.findIndex(p => p.email === email);
  return {
    code: room.code, status: room.status, me, host: room.players[0]?.email === email,
    players: room.players.map((p, i) => ({ name: p.name, lives: p.lives ?? START_LIVES, power: p.power || 0, alive: p.alive !== false, left: !!p.left, last: p.last || "", words: p.words || 0, bot: p.bot || null, me: i === me })),
    turn: room.turn ?? 0, turnId: room.turnId || 0, prompt: room.prompt || null, stage: stage(room),
    usedCount: (room.used || []).length, winner: room.winner ?? null, event: room.event || null, seq: room.seq || 0, game: room.game || 1,
    typing: botTyping(room) || (typing && typing.turnId === room.turnId ? { text: typing.text || "", bad: typing.bad || null } : null),
    round: room.round || 1, beat: room.status === "playing" ? fuseRange(room.round || 1)[0] : 0, maxLives: MAX_LIVES,
  };
}
async function save(room) { await redis("SET", key(room.code), JSON.stringify(room), "EX", String(TTL)); }
async function setTyping(room, text, bad) {
  await redis("SET", tkey(room.code), JSON.stringify({ turnId: room.turnId, text: String(text).slice(0, 30), bad: bad || null }), "EX", String(TTL));
}
async function load(code) {
  const [r, t] = await Promise.all([redis("GET", key(code)), redis("GET", tkey(code))]);
  return [r ? JSON.parse(r) : null, t ? JSON.parse(t) : null];
}
// only one change to a room at a time, so two people can't both trigger the same explosion
async function withLock(code, fn) {
  const lk = `wb:${code}:lock`, tok = crypto.randomBytes(6).toString("hex");
  let got = false;
  for (let i = 0; i < 30 && !got; i++) { got = !!(await redis("SET", lk, tok, "NX", "PX", "5000")); if (!got) await sleep(70); }
  if (!got) throw Object.assign(new Error("The room is busy. Try again."), { status: 503 });
  try { return await fn(); } finally { if ((await redis("GET", lk)) === tok) await redis("DEL", lk); }
}

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const email = auth.user.email, name = String(auth.user.name || "Player").slice(0, 24);

    if (req.method === "GET") {
      const code = clean(req.query?.code);
      let [room, typing] = await load(code);
      if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      if (room.status === "playing" && (Date.now() >= room.bomb.deadline || botNeeds(room))) {
        await loadWords();
        room = await withLock(code, async () => {
          const r = await getJSON(key(code)); if (!r) return r;
          let changed = tick(r);
          changed = botStep(r) || changed;
          if (changed) await save(r);
          return r;
        });
        if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      }
      return res.status(200).json({ room: view(room, email, typing) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });
    const { action } = req.body || {};

    if (action === "create") {
      let code = "";
      for (let t = 0; t < 8; t++) { code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join(""); if (!(await redis("EXISTS", key(code)))) break; }
      const room = { code, status: "lobby", players: [{ email, name }], game: 1, seq: 0, used: [] };
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }

    const code = clean(req.body?.code);

    if (action === "type") { // live typing, so everyone sees what the current player is typing
      const [room] = await load(code);
      if (!room) return res.status(404).json({ error: "No room with that code." });
      const me = room.players.findIndex(p => p.email === email);
      if (room.status === "playing" && me === room.turn && req.body.turnId === room.turnId) await setTyping(room, String(req.body.text || "").toUpperCase().replace(/[^A-Z]/g, ""));
      return res.status(200).json({ ok: true });
    }

    if (action === "word") await loadWords();
    const out = await withLock(code, async () => {
      const room = await getJSON(key(code));
      if (!room) return [404, { error: "No room with that code. Check it and try again." }];
      const me = room.players.findIndex(p => p.email === email);
      const reply = async (status, extra = {}) => { const [, t] = await load(code); return [status, { ...extra, room: view(room, email, t) }]; };

      if (action === "join") {
        if (me < 0) {
          if (room.status === "playing") return [409, { error: "That game already started. Wait for the next round." }];
          if (room.players.filter(p => !p.left).length >= MAX_PLAYERS) return [409, { error: "That room is full (8 players)." }];
          if (room.status === "over") room.players = room.players.filter(p => !p.left);
          room.players.push({ email, name });
          humansFirst(room);
          event(room, { type: "join", by: room.players.findIndex(p => p.email === email) });
          await save(room);
        }
        return reply(200);
      }
      if (me < 0) return [403, { error: "You're not in this room." }];

      if (action === "addbot" || action === "removebot") {
        if (me !== 0) return reply(403, { error: "Only the host can add bots." });
        if (room.status === "playing") return reply(400, { error: "Wait until this round ends." });
        if (action === "addbot") {
          if (room.players.filter(p => !p.left).length >= MAX_PLAYERS) return reply(400, { error: "The room is full." });
          const lv = LEVELS.includes(req.body.level) ? req.body.level : "medium";
          const used = new Set(room.players.map(p => p.name));
          room.players.push({ email: "bot:" + crypto.randomBytes(4).toString("hex"), name: BOT_NAMES.find(n => !used.has(n)) || "Bot", bot: lv });
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
        if (me !== 0) return reply(403, { error: "Only the host can start." });
        if (room.status === "playing") return reply(400, { error: "The game already started." });
        await loadWords();
        room.players = room.players.filter(p => !p.left);
        humansFirst(room);
        room.botPlan = null;
        room.players.forEach(p => { p.lives = START_LIVES; p.power = 0; p.words = 0; p.alive = true; p.last = ""; });
        room.solo = room.players.length === 1;
        if (room.status === "over") room.game = (room.game || 1) + 1;
        room.used = []; room.winner = null; room.status = "playing"; room.round = 1; room.roundTurns = 0;
        newTurn(room, crypto.randomInt(room.players.length)); newBomb(room);
        event(room, { type: "start" });
        await save(room);
        return reply(200);
      }
      if (action === "leave") {
        if (room.status === "lobby") {
          room.players.splice(me, 1);
          humansFirst(room);
          if (!room.players.some(p => !p.bot)) { await redis("DEL", key(code), tkey(code)); return [200, { ok: true }]; }
        } else {
          const p = room.players[me]; p.left = true; p.alive = false;
          if (!room.players.some(x => !x.bot && !x.left)) { await redis("DEL", key(code), tkey(code)); return [200, { ok: true }]; }
          if (room.status === "playing" && !checkOver(room) && room.turn === me) { newTurn(room, nextAlive(room, me)); newBomb(room); }
        }
        event(room, { type: "leave", by: me });
        await save(room);
        return [200, { ok: true }];
      }
      if (room.status !== "playing") return reply(400, { error: "The game isn't going right now." });

      if (action === "word") {
        if (tick(room)) { await save(room); return reply(400, { error: "Too slow! 💥", code: "boom" }); }
        if (room.turn !== me) return reply(400, { error: "It's not your turn." });
        const w = String(req.body.word || "").trim().toLowerCase();
        let bad = null;
        if (!/^[a-z]{2,30}$/.test(w)) bad = "notword";
        else if (!w.includes(room.prompt)) bad = "prompt";
        else if (room.used.includes(w)) bad = "used";
        else if (!DICT.has(w)) bad = "notword";
        if (bad) {
          await setTyping(room, w.toUpperCase(), bad);
          const msg = { notword: "Not in the dictionary", prompt: `Needs "${room.prompt.toUpperCase()}"`, used: "Already used" }[bad];
          return reply(400, { error: msg, code: bad });
        }
        acceptWord(room, me, w);
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
