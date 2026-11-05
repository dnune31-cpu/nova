import crypto from "node:crypto";
import { redis, getJSON, getAuth } from "./_lib.js";

// Nova Cards: an UNO-style card game for 2 to 4 players with a room code. Empty seats can be filled with bots.
// The server keeps the deck and everyone's hands, so each player only ever sees their own cards.
const TTL = 6 * 3600;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["r", "y", "g", "b"];
const LEVELS = ["easy", "medium", "hard"];
const BOT_NAMES = ["Byte", "Pixel", "Bolt", "Chip", "Gizmo", "Sprocket"];
const BOT = { // how long a bot waits before moving, and how often it remembers to call NOVA
  easy: { wait: 1700, call: 0.55, catch: 0 },
  medium: { wait: 1300, call: 0.85, catch: 2600 },
  hard: { wait: 950, call: 1, catch: 1500 },
};
const key = c => `cards:${c}`;
const clean = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const rnd = n => crypto.randomInt(n);

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function newDeck() {
  const d = []; let id = 0;
  for (const c of COLORS) {
    d.push({ id: id++, c, v: "0" });
    for (const v of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "rev", "+2"]) { d.push({ id: id++, c, v }); d.push({ id: id++, c, v }); }
  }
  for (let i = 0; i < 4; i++) { d.push({ id: id++, c: "w", v: "wild" }); d.push({ id: id++, c: "w", v: "+4" }); }
  return shuffle(d);
}
const top = room => room.discard[room.discard.length - 1];
const playable = (room, card) => card.c === "w" || card.c === room.color || card.v === top(room).v;
function drawOne(room) {
  if (!room.deck.length) { // reshuffle the pile (keep the top card)
    const t = room.discard.pop();
    room.deck = shuffle(room.discard.map(c => (c.c === "w" ? { ...c, chosen: undefined } : c)));
    room.discard = [t];
  }
  return room.deck.pop() || null;
}
function give(room, i, n) { const got = []; for (let k = 0; k < n; k++) { const c = drawOne(room); if (!c) break; room.players[i].hand.push(c); got.push(c); } return got; }
const next = (room, from, steps = 1) => { const n = room.players.length; return (((from + room.dir * steps) % n) + n) % n; };
function event(room, e) { room.seq = (room.seq || 0) + 1; room.event = { seq: room.seq, ...e, at: Date.now() }; }
const skipLeft = (room, from) => { let t = from; while (room.players[t].left) t = next(room, t); return t; };
const advance = (room, steps = 1) => { let t = room.turn; for (let s = 0; s < steps; s++) t = skipLeft(room, next(room, t)); room.turn = t; room.drew = null; };
const humansFirst = room => { room.players.sort((a, b) => (a.bot ? 1 : 0) - (b.bot ? 1 : 0)); };

function view(room, email) {
  const me = room.players.findIndex(p => p.email === email);
  return {
    code: room.code, status: room.status, me, host: room.players[0]?.email === email,
    players: room.players.map((p, i) => ({ name: p.name, count: p.hand.length, called: !!p.called, left: !!p.left, bot: p.bot || null, me: i === me })),
    hand: me >= 0 ? room.players[me].hand : [],
    top: room.discard.length ? top(room) : null, color: room.color || null, turn: room.turn, dir: room.dir,
    deck: room.deck.length, drew: me >= 0 && room.turn === me ? room.drew ?? null : null,
    catchable: room.catchable ?? null, winner: room.winner ?? null, event: room.event || null, seq: room.seq || 0, game: room.game || 1,
  };
}
async function save(room) { await redis("SET", key(room.code), JSON.stringify(room), "EX", String(TTL)); }
const err = (res, code, msg, room, email) => res.status(code).json({ error: msg, room: room ? view(room, email) : undefined });

function startGame(room) {
  room.deck = newDeck(); room.discard = []; room.dir = 1; room.turn = 0; room.drew = null; room.catchable = null; room.winner = null;
  room.players.forEach(p => { p.hand = []; p.called = false; });
  for (let k = 0; k < 7; k++) room.players.forEach((_, i) => give(room, i, 1));
  let first = room.deck.pop();
  while (!/^\d$/.test(first.v)) { room.deck.unshift(first); first = room.deck.pop(); } // start on a number card
  room.discard.push(first); room.color = first.c; room.status = "playing";
  event(room, { type: "start", by: 0 });
}

/* ----- moves (shared by people and bots) ----- */
function doDraw(room, me) {
  const p = room.players[me];
  const [c] = give(room, me, 1);
  p.called = false;
  if (c && playable(room, c)) room.drew = c.id; else advance(room);
  event(room, { type: "draw", by: me, count: c ? 1 : 0 });
  return c;
}
function doPlay(room, me, idx, color, call) {
  const p = room.players[me], card = p.hand[idx];
  p.hand.splice(idx, 1);
  room.discard.push(card);
  room.color = card.c === "w" ? color : card.c;
  if (room.catchable != null && room.catchable !== me) room.catchable = null; // the chance to catch passes
  if (call) p.called = true;
  const e = { type: "play", by: me, card, color: room.color };
  if (!p.hand.length) { room.status = "over"; room.winner = me; room.drew = null; e.win = true; event(room, e); return; }
  if (p.hand.length === 1 && !p.called) room.catchable = me;
  if (p.hand.length > 1) p.called = false;
  const active = room.players.filter(x => !x.left).length;
  if (card.v === "rev") { room.dir *= -1; e.dir = room.dir; advance(room, active === 2 ? 2 : 1); }
  else if (card.v === "skip") { e.target = skipLeft(room, next(room, me)); advance(room, 2); }
  else if (card.v === "+2" || card.v === "+4") {
    const t = skipLeft(room, next(room, me)), n = card.v === "+2" ? 2 : 4;
    give(room, t, n); room.players[t].called = false; e.target = t; e.count = n;
    advance(room, 2);
  } else advance(room);
  event(room, e);
}
function doCatch(room, by) {
  const t = room.catchable;
  give(room, t, 2); room.players[t].called = false; room.catchable = null;
  event(room, { type: "catch", by, target: t, count: 2 });
}

/* ----- bots ----- */
function bestColor(hand) {
  const n = { r: 0, y: 0, g: 0, b: 0 };
  for (const c of hand) if (c.c !== "w") n[c.c]++;
  return COLORS.reduce((a, b) => (n[b] > n[a] ? b : a), COLORS[rnd(4)]);
}
function botChoose(room, me) {
  const p = room.players[me], lv = p.bot;
  const ok = p.hand.map((c, i) => [c, i]).filter(([c]) => playable(room, c) && (room.drew == null || c.id === room.drew));
  if (!ok.length) return null;
  if (lv === "easy") return ok[rnd(ok.length)];
  const nxt = room.players[skipLeft(room, next(room, me))];
  const colorCount = c => p.hand.filter(x => x.c === c).length;
  const score = ([c]) => {
    let s = 0;
    if (c.c === "w") s -= 30; // keep wild cards for later
    else s += colorCount(c.c) * 3; // dump the color you have most of
    if (["skip", "rev", "+2"].includes(c.v)) s += lv === "hard" && nxt.hand.length <= 3 ? 40 : 4;
    if (c.v === "+4") s += lv === "hard" && nxt.hand.length <= 3 ? 35 : -10;
    if (/^\d$/.test(c.v)) s += Number(c.v) * 0.5; // get rid of high numbers
    return s + Math.random() * (lv === "hard" ? 1 : 6);
  };
  return ok.sort((a, b) => score(b) - score(a))[0];
}
// lets bots move. Runs whenever someone checks the room, so bots play in "real time" while people are watching.
function botStep(room) {
  if (room.status !== "playing" || !room.event) return false;
  const since = Date.now() - room.event.at;
  // bots catch people who forgot to call NOVA
  const t = room.catchable;
  if (t != null && room.players[t] && !room.players[t].bot) {
    const catcher = room.players.findIndex(p => p.bot && !p.left && BOT[p.bot].catch && since > BOT[p.bot].catch);
    if (catcher >= 0 && room.players[t].hand.length === 1) { doCatch(room, catcher); return true; }
  }
  const p = room.players[room.turn];
  if (!p || !p.bot || p.left || since < BOT[p.bot].wait) return false;
  const pick = botChoose(room, room.turn);
  if (pick) {
    const [card, idx] = pick;
    const call = p.hand.length === 2 && Math.random() < BOT[p.bot].call;
    doPlay(room, room.turn, idx, card.c === "w" ? bestColor(p.hand.filter(c => c.id !== card.id)) : null, call);
  } else doDraw(room, room.turn);
  return true;
}
async function runBots(room) {
  if (room.status !== "playing" || !room.players.some(p => p.bot)) return room;
  if (!botStep({ ...JSON.parse(JSON.stringify(room)) })) return room; // nothing to do yet
  // only one request gets to move the bot for this step
  const got = await redis("SET", `${key(room.code)}:bot:${room.seq}`, "1", "NX", "PX", "8000");
  if (!got) return room;
  const fresh = await getJSON(key(room.code));
  if (!fresh || fresh.seq !== room.seq) return fresh || room;
  if (botStep(fresh)) await save(fresh);
  return fresh;
}

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const email = auth.user.email, name = String(auth.user.name || "Player").slice(0, 24);

    if (req.method === "GET") {
      let room = await getJSON(key(clean(req.query?.code)));
      if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      room = await runBots(room);
      return res.status(200).json({ room: view(room, email) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });
    const { action } = req.body || {};

    if (action === "create") {
      let code = "";
      for (let t = 0; t < 8; t++) { code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join(""); if (!(await getJSON(key(code)))) break; }
      const room = { code, status: "lobby", players: [{ email, name, hand: [] }], deck: [], discard: [], dir: 1, turn: 0, game: 1, seq: 0 };
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }

    const room = await getJSON(key(clean(req.body?.code)));
    if (!room) return res.status(404).json({ error: "No room with that code. Check it and try again." });
    const me = room.players.findIndex(p => p.email === email);

    if (action === "join") {
      if (me < 0) {
        if (room.status !== "lobby") return err(res, 409, "That game already started.");
        if (room.players.length >= 4) return err(res, 409, "That room is full (4 players).");
        room.players.push({ email, name, hand: [] });
        humansFirst(room);
        event(room, { type: "join", by: room.players.findIndex(p => p.email === email) });
        await save(room);
      }
      return res.status(200).json({ room: view(room, email) });
    }
    if (me < 0) return res.status(403).json({ error: "You're not in this room." });

    if (action === "addbot" || action === "removebot") {
      if (me !== 0) return err(res, 403, "Only the host can add bots.", room, email);
      if (room.status === "playing") return err(res, 400, "Wait until this round ends.", room, email);
      if (room.status === "over") { room.players = room.players.filter(p => !p.left); room.status = "lobby"; }
      if (action === "addbot") {
        if (room.players.length >= 4) return err(res, 400, "The room is full.", room, email);
        const lv = LEVELS.includes(req.body.level) ? req.body.level : "medium";
        const used = new Set(room.players.map(p => p.name));
        const nm = BOT_NAMES.find(n => !used.has(n)) || "Bot";
        room.players.push({ email: "bot:" + crypto.randomBytes(4).toString("hex"), name: nm, bot: lv, hand: [] });
        event(room, { type: "join", by: room.players.length - 1 });
      } else {
        const i = Number(req.body.index);
        if (!room.players[i]?.bot) return err(res, 400, "That's not a bot.", room, email);
        room.players.splice(i, 1);
      }
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }
    if (action === "start") {
      if (me !== 0) return err(res, 403, "Only the host can start.", room, email);
      if (room.status === "playing") return err(res, 400, "The game already started.", room, email);
      room.players = room.players.filter(p => !p.left);
      if (room.players.length < 2) return err(res, 400, "You need at least 2 players. Add a bot!", room, email);
      if (room.status === "over") room.game = (room.game || 1) + 1;
      startGame(room);
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }
    if (action === "leave") {
      if (room.status === "lobby") {
        room.players.splice(me, 1);
        humansFirst(room);
        if (!room.players.some(p => !p.bot)) { await redis("DEL", key(room.code)); return res.status(200).json({ ok: true }); }
      } else {
        const p = room.players[me];
        room.deck.unshift(...p.hand); p.hand = []; p.left = true;
        const still = room.players.filter(x => !x.left);
        if (!still.some(x => !x.bot)) { await redis("DEL", key(room.code)); return res.status(200).json({ ok: true }); }
        if (room.status === "playing" && still.length < 2) { room.status = "over"; room.winner = room.players.findIndex(x => !x.left); }
        else if (room.status === "playing" && room.turn === me) { room.drew = null; do { room.turn = next(room, room.turn); } while (room.players[room.turn].left); }
      }
      event(room, { type: "leave", by: me });
      await save(room);
      return res.status(200).json({ ok: true });
    }
    if (room.status !== "playing") return err(res, 400, "The game isn't going right now.", room, email);
    const p = room.players[me];

    if (action === "call") { // "NOVA!" when you're about to have one card
      if (p.hand.length <= 2) p.called = true;
      if (room.catchable === me) room.catchable = null;
      event(room, { type: "call", by: me });
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }
    if (action === "catch") { // someone forgot to call: they draw 2
      const t = room.catchable;
      if (t === null || t === undefined || t === me || room.players[t].hand.length !== 1) return err(res, 400, "Too late to catch them.", room, email);
      doCatch(room, me);
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }
    if (room.turn !== me) return err(res, 400, "It's not your turn.", room, email);

    if (action === "draw") {
      if (room.drew != null) return err(res, 400, "You already drew. Play that card or pass.", room, email);
      const c = doDraw(room, me);
      await save(room);
      return res.status(200).json({ room: view(room, email), drawn: c || null });
    }
    if (action === "pass") {
      if (room.drew == null) return err(res, 400, "Draw a card first.", room, email);
      advance(room);
      event(room, { type: "pass", by: me });
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }
    if (action === "play") {
      const idx = p.hand.findIndex(c => c.id === req.body.card);
      if (idx < 0) return err(res, 400, "You don't have that card.", room, email);
      const card = p.hand[idx];
      if (room.drew != null && card.id !== room.drew) return err(res, 400, "You can only play the card you just drew.", room, email);
      if (!playable(room, card)) return err(res, 400, "That card doesn't match the color or number.", room, email);
      if (card.c === "w" && !COLORS.includes(req.body.color)) return err(res, 400, "Pick a color.", room, email);
      doPlay(room, me, idx, req.body.color, !!req.body.call);
      await save(room);
      return res.status(200).json({ room: view(room, email) });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
