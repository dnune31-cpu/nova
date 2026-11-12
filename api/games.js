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

/* ===== The Lineup: a two-player guessing game (rooms with kind "lineup"; chess rooms have no kind) =====
   Both players see the same lineup of 24 made-up people, drawn fresh for every game. Each secretly picks one. On your turn you ask
   one yes/no question about the other player's person ("Do they wear glasses?") and the server answers it truthfully, or you name
   the person you think it is. A right guess wins. A wrong guess costs you your next turn. */
const A_SIZE = 24;
// what a question can be about. (Skin tone and shirt colour are only there for variety: they are never asked about.)
const A_TRAITS = { hair: ["black", "brown", "blond", "red", "grey"], style: ["short", "long", "curly"], glasses: [true, false], hat: [true, false], beard: [true, false], eyes: ["brown", "blue", "green"], earrings: [true, false] };
const A_NAMES = ["Ada", "Ben", "Cleo", "Dev", "Elio", "Fern", "Gus", "Hana", "Ivo", "Jade", "Kai", "Lena", "Milo", "Nia", "Omar", "Pia", "Quinn", "Rosa", "Sami", "Tess", "Uma", "Vik", "Wren", "Xavi", "Yara", "Zeke",
  "Aria", "Bo", "Cy", "Dot", "Ezra", "Flo", "Gia", "Hugo", "Ines", "Jax", "Kit", "Lux", "Mae", "Noor", "Otis", "Remy", "Suki", "Theo"];
function makeLineup() {
  const pick = a => a[crypto.randomInt(a.length)], seen = new Set(), names = [...A_NAMES], out = [];
  while (out.length < A_SIZE) {
    const a = {}; for (const [k, vals] of Object.entries(A_TRAITS)) a[k] = pick(vals);
    const sig = JSON.stringify(a); if (seen.has(sig)) continue; // no two people look the same
    seen.add(sig);
    out.push({ name: names.splice(crypto.randomInt(names.length), 1)[0], ...a, skin: crypto.randomInt(5), shirt: crypto.randomInt(6) });
  }
  return out;
}
const aSeat = (room, email) => room.p.findIndex(x => x && x.email === email);
function aView(room, email, cheat) {
  const me = aSeat(room, email), over = room.status === "over";
  return {
    kind: "lineup", code: room.code, status: room.status, me, game: room.game || 1, updated: room.updated,
    players: room.p.map(x => (x ? x.name : null)), board: room.board,
    picked: room.secret.map(x => x !== null), mine: me >= 0 ? room.secret[me] : null,
    theirs: over && me >= 0 ? room.secret[1 - me] : null, // the other player's person is only shown once the game is over
    ...(cheat && me >= 0 && !over && room.secret[1 - me] !== null ? { peek: room.secret[1 - me] } : {}), // ...unless the admin has cheats switched on
    turn: room.turn, log: room.log, winner: room.winner ?? null, result: room.result || null, rematch: room.rematch || [],
  };
}
function aPass(room) { // hand the turn over; a player who guessed wrong sits one turn out
  const next = 1 - room.turn;
  if (room.skip[next]) { room.skip[next] = false; room.log.push({ by: next, skipped: true }); } else room.turn = next;
}
async function lineup(req, res, me) {
  const { action } = req.body || {};
  if (action === "create") {
    let code = "";
    for (let tries = 0; tries < 8; tries++) { code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join(""); if (!(await getJSON(key(code)))) break; }
    const room = { kind: "lineup", code, p: [me, null], board: makeLineup(), secret: [null, null], status: "waiting", turn: 0, log: [], skip: [false, false], game: 1, rematch: [] };
    await save(room);
    return res.status(200).json({ room: aView(room, me.email, me.cheat) });
  }
  const room = await getJSON(key(clean(req.body?.code)));
  if (!room || room.kind !== "lineup") return res.status(404).json({ error: "No room with that code. Check it and try again." });
  let i = aSeat(room, me.email);
  const reply = (status, extra = {}) => res.status(status).json({ ...extra, room: aView(room, me.email, me.cheat) });
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
    if (room.status !== "picking") return reply(400, { error: "You can't change your pick now." });
    const k = Number(req.body.index);
    if (!Number.isInteger(k) || k < 0 || k >= room.board.length) return reply(400, { error: "Pick one of the people." });
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
      if (!Number.isInteger(k) || k < 0 || k >= room.board.length) return reply(400, { error: "Pick one of the people." });
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
    if (room.rematch.length === 2) Object.assign(room, { board: makeLineup(), secret: [null, null], status: "picking", turn: 0, log: [], skip: [false, false], winner: null, result: null, rematch: [], game: (room.game || 1) + 1 });
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
    Object.defineProperty(me, "cheat", { value: !!(auth.user.admin && auth.user.cheats), enumerable: false }); // not saved into rooms

    if (req.method === "GET") {
      const room = await getJSON(key(clean(req.query?.code)));
      if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      if (room.kind === "lineup") return res.status(200).json({ room: aView(room, me.email, me.cheat) });
      return res.status(200).json({ room: view(room, me.email) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });
    const { action } = req.body || {};
    if (req.body?.game === "lineup") return await lineup(req, res, me);

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
