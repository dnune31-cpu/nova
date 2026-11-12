import crypto from "node:crypto";
import { redis, getJSON, getAuth } from "./_lib.js";

// Online chess rooms: one player creates a room code, the other joins it on another device.
// Both browsers check the room every couple of seconds. Moves are checked in the browser with chess.js;
// the server makes sure it's really your turn and keeps the list of moves.
const TTL = 6 * 3600;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const key = c => `room:${c}`;
const clean = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

function view(room, email) {
  const color = room.white?.email === email ? "w" : room.black?.email === email ? "b" : null;
  return {
    code: room.code, color, moves: room.moves, status: room.status, result: room.result || null,
    white: room.white ? room.white.name : null, black: room.black ? room.black.name : null,
    rematch: room.rematch || [], game: room.game || 1, updated: room.updated,
  };
}
async function save(room) { room.updated = Date.now(); await redis("SET", key(room.code), JSON.stringify(room), "EX", String(TTL)); }

/* ===== Alien Lineup: a two-player guessing game (rooms with kind "aliens"; chess rooms have no kind) =====
   Both players see the same lineup of 24 aliens. Each secretly picks one. On your turn you ask one yes/no question about the
   other player's alien ("Does it have horns?") and the server answers it truthfully, or you name the alien you think it is.
   A right guess wins. A wrong guess costs you your next turn. */
const A_COLORS = ["green", "purple", "blue", "orange", "pink"], A_SIZE = 24;
const A_TRAITS = { color: A_COLORS, eyes: [1, 2, 3], antennae: [0, 1, 2], horns: [true, false], spots: [true, false], limbs: ["tentacles", "legs"], mouth: ["smile", "fangs"] };
const A_SYL = ["zib", "quo", "mox", "vee", "tra", "blu", "nar", "plo", "xi", "gru", "wob", "fen", "kli", "oon", "sha", "dro", "pip", "yul", "ark", "eem", "tog", "luz", "bim", "raz"];
function alienLineup() {
  const pick = a => a[crypto.randomInt(a.length)], seen = new Set(), names = new Set(), out = [];
  while (out.length < A_SIZE) {
    const a = {}; for (const [k, vals] of Object.entries(A_TRAITS)) a[k] = pick(vals);
    const sig = JSON.stringify(a); if (seen.has(sig)) continue; // no two aliens look the same
    seen.add(sig);
    let nm; do { nm = pick(A_SYL) + pick(A_SYL).slice(crypto.randomInt(2)); nm = nm[0].toUpperCase() + nm.slice(1); } while (names.has(nm));
    names.add(nm); out.push({ name: nm, ...a });
  }
  return out;
}
const aSeat = (room, email) => room.p.findIndex(x => x && x.email === email);
function aView(room, email) {
  const me = aSeat(room, email), over = room.status === "over";
  return {
    kind: "aliens", code: room.code, status: room.status, me, game: room.game || 1, updated: room.updated,
    players: room.p.map(x => (x ? x.name : null)), board: room.board,
    picked: room.secret.map(x => x !== null), mine: me >= 0 ? room.secret[me] : null,
    theirs: over && me >= 0 ? room.secret[1 - me] : null, // the other player's alien is only shown once the game is over
    turn: room.turn, log: room.log, winner: room.winner ?? null, result: room.result || null, rematch: room.rematch || [],
  };
}
function aPass(room) { // hand the turn over; a player who guessed wrong sits one turn out
  const next = 1 - room.turn;
  if (room.skip[next]) { room.skip[next] = false; room.log.push({ by: next, skipped: true }); } else room.turn = next;
}
async function aliens(req, res, me) {
  const { action } = req.body || {};
  if (action === "create") {
    let code = "";
    for (let tries = 0; tries < 8; tries++) { code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join(""); if (!(await getJSON(key(code)))) break; }
    const room = { kind: "aliens", code, p: [me, null], board: alienLineup(), secret: [null, null], status: "waiting", turn: 0, log: [], skip: [false, false], game: 1, rematch: [] };
    await save(room);
    return res.status(200).json({ room: aView(room, me.email) });
  }
  const room = await getJSON(key(clean(req.body?.code)));
  if (!room || room.kind !== "aliens") return res.status(404).json({ error: "No room with that code. Check it and try again." });
  let i = aSeat(room, me.email);
  const reply = (status, extra = {}) => res.status(status).json({ ...extra, room: aView(room, me.email) });
  if (action === "join") {
    if (i < 0) {
      if (room.p[0] && room.p[1]) return res.status(409).json({ error: "That room is already full." });
      room.p[room.p[0] ? 1 : 0] = me; room.status = "picking";
      await save(room);
    }
    return reply(200);
  }
  if (i < 0) return res.status(403).json({ error: "You're not in this room." });
  if (action === "pick") {
    if (room.status !== "picking") return reply(400, { error: "You can't change your alien now." });
    const k = Number(req.body.index);
    if (!Number.isInteger(k) || k < 0 || k >= room.board.length) return reply(400, { error: "Pick one of the aliens." });
    room.secret[i] = k;
    if (room.secret[0] !== null && room.secret[1] !== null) { room.status = "playing"; room.turn = crypto.randomInt(2); }
    await save(room);
    return reply(200);
  }
  if (action === "ask" || action === "guess") {
    if (room.status !== "playing") return reply(400, { error: "The game isn't going right now." });
    if (room.turn !== i) return reply(400, { error: "It's not your turn." });
    const theirs = room.board[room.secret[1 - i]];
    if (action === "ask") {
      const trait = String(req.body.trait || ""), vals = A_TRAITS[trait];
      const value = vals && vals.find(v => String(v) === String(req.body.value));
      if (!vals || value === undefined) return reply(400, { error: "Pick a question from the list." });
      room.log.push({ by: i, trait, value, yes: theirs[trait] === value });
      aPass(room);
    } else {
      const k = Number(req.body.index);
      if (!Number.isInteger(k) || k < 0 || k >= room.board.length) return reply(400, { error: "Pick one of the aliens." });
      const right = k === room.secret[1 - i];
      room.log.push({ by: i, guess: k, right });
      if (right) { room.status = "over"; room.winner = i; room.result = "guess"; }
      else { room.skip[i] = true; aPass(room); } // wrong: the other player gets two turns in a row
    }
    await save(room);
    return reply(200);
  }
  if (action === "resign") {
    if (room.status === "playing" || room.status === "picking") { room.status = "over"; room.winner = 1 - i; room.result = "resign"; await save(room); }
    return reply(200);
  }
  if (action === "rematch") {
    if (room.status !== "over") return reply(400, { error: "Finish this game first." });
    room.rematch = [...new Set([...(room.rematch || []), i])];
    if (room.rematch.length === 2) Object.assign(room, { board: alienLineup(), secret: [null, null], status: "picking", turn: 0, log: [], skip: [false, false], winner: null, result: null, rematch: [], game: (room.game || 1) + 1 });
    await save(room);
    return reply(200);
  }
  return res.status(400).json({ error: "Unknown action" });
}

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const me = { email: auth.user.email, name: String(auth.user.name || "Player").slice(0, 30) };

    if (req.method === "GET") {
      const room = await getJSON(key(clean(req.query?.code)));
      if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      if (room.kind === "aliens") return res.status(200).json({ room: aView(room, me.email) });
      return res.status(200).json({ room: view(room, me.email) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });
    const { action } = req.body || {};
    if (req.body?.game === "aliens") return await aliens(req, res, me);

    if (action === "create") {
      let code = "";
      for (let tries = 0; tries < 8; tries++) {
        code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join("");
        if (!(await getJSON(key(code)))) break;
      }
      const room = { code, white: me, black: null, moves: [], status: "waiting", game: 1 };
      await save(room);
      return res.status(200).json({ room: view(room, me.email) });
    }

    const code = clean(req.body?.code);
    const room = await getJSON(key(code));
    if (!room || room.kind) return res.status(404).json({ error: "No room with that code. Check it and try again." });
    const color = room.white?.email === me.email ? "w" : room.black?.email === me.email ? "b" : null;

    if (action === "join") {
      if (!color) {
        if (room.white && room.black) return res.status(409).json({ error: "That room is already full." });
        if (!room.black) room.black = me; else room.white = me;
        room.status = "playing";
        await save(room);
      }
      return res.status(200).json({ room: view(room, me.email) });
    }
    if (!color) return res.status(403).json({ error: "You're not in this room." });

    if (action === "move") {
      if (room.status !== "playing") return res.status(400).json({ error: "The game isn't going right now." });
      const turn = room.moves.length % 2 === 0 ? "w" : "b";
      if (turn !== color) return res.status(400).json({ error: "It's not your turn." });
      if (req.body.ply !== room.moves.length) return res.status(409).json({ error: "Out of sync", room: view(room, me.email) });
      const from = String(req.body.from || ""), to = String(req.body.to || ""), promo = String(req.body.promotion || "");
      if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to) || !/^[qrbn]?$/.test(promo)) return res.status(400).json({ error: "Bad move" });
      room.moves.push(from + to + promo);
      const end = req.body.end; // the mover's browser reports checkmate or a draw
      if (end && ["checkmate", "draw", "stalemate"].includes(end.type)) {
        room.status = "over";
        room.result = end.type === "checkmate" ? { type: "checkmate", winner: color } : { type: end.type };
      }
      await save(room);
      return res.status(200).json({ room: view(room, me.email) });
    }
    if (action === "resign") {
      if (room.status === "playing") { room.status = "over"; room.result = { type: "resign", winner: color === "w" ? "b" : "w" }; await save(room); }
      return res.status(200).json({ room: view(room, me.email) });
    }
    if (action === "rematch") {
      room.rematch = [...new Set([...(room.rematch || []), color])];
      if (room.rematch.length === 2 && room.white && room.black) { // both said yes: swap colors and start over
        [room.white, room.black] = [room.black, room.white];
        room.moves = []; room.status = "playing"; room.result = null; room.rematch = []; room.game = (room.game || 1) + 1;
      }
      await save(room);
      return res.status(200).json({ room: view(room, me.email) });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
