import crypto from "node:crypto";
import { redis, getJSON, getAuth } from "./_lib.js";

// Word Bomb: party word game for 1 to 8 friends with a room code.
// On your turn, type a real word that contains the letters shown before the bomb goes off.
// The fuse is random and hidden. The server checks words and handles explosions.
const TTL = 6 * 3600;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ALPHA = "abcdefghijlmnopqrstuv"; // use all of these to earn a life back
const START_LIVES = 2, MAX_LIVES = 3, MAX_PLAYERS = 8;
const FUSE_MIN = 12000, FUSE_MAX = 30000, MIN_TURN = 3500;
const WORD_URLS = [
  "https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt",
  "https://cdn.jsdelivr.net/gh/dolph/dictionary@master/enable1.txt",
];
const key = c => `wb:${c}`;
const tkey = c => `wb:${c}:t`;
const clean = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ----- word list (loaded once per server instance) ----- */
let WORDS = null, DICT = null, PROMPTS = null, loading = null;
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
    PROMPTS = [...counts].filter(([, c]) => c >= 600).map(([s]) => s);
  })();
  return loading;
}
const newPrompt = () => PROMPTS[crypto.randomInt(PROMPTS.length)];
function example(prompt, used) { // a word that would have worked (shown after an explosion)
  const start = crypto.randomInt(WORDS.length);
  for (let k = 0; k < WORDS.length; k++) {
    const w = WORDS[(start + k) % WORDS.length];
    if (w.length <= 9 && w.includes(prompt) && !used.includes(w)) return w;
  }
  return null;
}

/* ----- game helpers ----- */
function event(room, e) { room.seq = (room.seq || 0) + 1; room.event = { seq: room.seq, ...e, at: Date.now() }; }
const inGame = p => p.alive && !p.left;
function nextAlive(room, from) {
  const n = room.players.length;
  for (let s = 1; s <= n; s++) { const i = (from + s) % n; if (inGame(room.players[i])) return i; }
  return from;
}
function newBomb(room) { const t = FUSE_MIN + crypto.randomInt(FUSE_MAX - FUSE_MIN + 1); room.bomb = { start: Date.now(), total: t, deadline: Date.now() + t }; }
function newTurn(room, i) { room.turn = i; room.turnId = (room.turnId || 0) + 1; room.turnStart = Date.now(); room.prompt = newPrompt(); }
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
  const e = { type: "boom", by: i, prompt: room.prompt, example: example(room.prompt, room.used), out: !p.alive };
  if (!checkOver(room)) { newTurn(room, p.alive ? nextAlive(room, i) : nextAlive(room, i)); newBomb(room); }
  else e.win = true;
  event(room, e);
  return true;
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
    players: room.players.map((p, i) => ({ name: p.name, lives: p.lives ?? START_LIVES, letters: p.letters || "", alive: p.alive !== false, left: !!p.left, last: p.last || "", words: p.words || 0, me: i === me })),
    turn: room.turn ?? 0, turnId: room.turnId || 0, prompt: room.prompt || null, stage: stage(room),
    usedCount: (room.used || []).length, winner: room.winner ?? null, event: room.event || null, seq: room.seq || 0, game: room.game || 1,
    typing: typing && typing.turnId === room.turnId ? { text: typing.text || "", bad: typing.bad || null } : null,
    alpha: ALPHA, maxLives: MAX_LIVES,
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
      if (room.status === "playing" && Date.now() >= room.bomb.deadline) {
        await loadWords();
        room = await withLock(code, async () => { const r = await getJSON(key(code)); if (r && tick(r)) await save(r); return r; });
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
          event(room, { type: "join", by: room.players.length - 1 });
          await save(room);
        }
        return reply(200);
      }
      if (me < 0) return [403, { error: "You're not in this room." }];

      if (action === "start") {
        if (me !== 0) return reply(403, { error: "Only the host can start." });
        if (room.status === "playing") return reply(400, { error: "The game already started." });
        await loadWords();
        room.players = room.players.filter(p => !p.left);
        room.players.forEach(p => { p.lives = START_LIVES; p.letters = ""; p.words = 0; p.alive = true; p.last = ""; });
        room.solo = room.players.length === 1;
        if (room.status === "over") room.game = (room.game || 1) + 1;
        room.used = []; room.winner = null; room.status = "playing";
        newTurn(room, crypto.randomInt(room.players.length)); newBomb(room);
        event(room, { type: "start" });
        await save(room);
        return reply(200);
      }
      if (action === "leave") {
        if (room.status === "lobby") {
          room.players.splice(me, 1);
          if (!room.players.length) { await redis("DEL", key(code), tkey(code)); return [200, { ok: true }]; }
        } else {
          const p = room.players[me]; p.left = true; p.alive = false;
          if (room.status === "playing" && !checkOver(room) && room.turn === me) { newTurn(room, nextAlive(room, me)); room.bomb.deadline = Math.max(room.bomb.deadline, Date.now() + MIN_TURN); }
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
        const p = room.players[me];
        room.used.push(w); p.last = w; p.words = (p.words || 0) + 1;
        let letters = new Set(p.letters || ""); for (const ch of w) if (ALPHA.includes(ch)) letters.add(ch);
        let bonus = false;
        if (letters.size >= ALPHA.length) { letters = new Set(); bonus = p.lives < MAX_LIVES; if (bonus) p.lives++; }
        p.letters = [...letters].sort().join("");
        const e = { type: "word", by: me, word: w, prompt: room.prompt, bonus, full: !letters.size };
        newTurn(room, nextAlive(room, me));
        room.bomb.deadline = Math.max(room.bomb.deadline, Date.now() + MIN_TURN);
        event(room, e);
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
