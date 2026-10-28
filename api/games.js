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

export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    const me = { email: auth.user.email, name: String(auth.user.name || "Player").slice(0, 30) };

    if (req.method === "GET") {
      const room = await getJSON(key(clean(req.query?.code)));
      if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      return res.status(200).json({ room: view(room, me.email) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });
    const { action } = req.body || {};

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
    if (!room) return res.status(404).json({ error: "No room with that code. Check it and try again." });
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
