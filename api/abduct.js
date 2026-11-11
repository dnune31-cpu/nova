import crypto from "node:crypto";
import { redis, pipeline, getJSON, MODEL_IDS } from "./_lib.js";
import { norm, findInList, scoreFromRank, RARITY_SCALE, rareTier, rateList } from "./moo.js";

// Alien Party (moollion.cc): a pass-the-turn party mode for 1 to 8 friends with a room code.
// Cows stand in a line. The alien's UFO hovers over whoever's turn it is and slowly beams them up
// (a hidden timer). Name something that fits the prompt before you get abducted. Everyone answers
// the same prompt for a random stretch of turns: one full trip around the line, sometimes a bit more,
// so nobody is always first on a fresh prompt.
// Rarer answers fill your power bar more; a full bar is an extra heart. Last cow standing wins.
// Rarity uses ranked answer lists (the same kind the daily game uses), kept in a shared prompt bank.
export const config = { maxDuration: 120 };

const TTL = 6 * 3600, LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENS = "ab:len", RARE = "ab:rare";
const START_LIVES = 3, MAX_LIVES = 5, MAX_PLAYERS = 8, REVEAL = 2200; // REVEAL = the "new prompt!" moment before the beam starts
// An answer counts if it reached the server before the beam finished (GRACE covers the trip over the network). While it is
// being checked the turn is held, so nobody gets abducted with an answer in the air; time spent on a wrong answer is given back.
const GRACE = 600, HOLD_MS = 12000, FREEZE_MAX = 6000;
const PTS = [10, 16, 24, 34, 48, 70]; // power bar fill per rarity tier (100 = +1 heart)
const LEVELS = ["easy", "medium", "hard"], BOT_NAMES = ["Byte", "Pixel", "Bolt", "Chip", "Gizmo", "Sprocket", "Widget"];
const BOT = { // think = pause before typing, per = ms per letter, fail = chance it freezes, pick = part of the ranked list it answers from
  easy: { think: [2600, 5200], per: 150, fail: 0.2, pick: [0, 0.35] },
  medium: { think: [1800, 3600], per: 110, fail: 0.1, pick: [0.15, 0.7] },
  hard: { think: [1200, 2600], per: 80, fail: 0.04, pick: [0.4, 1] },
};
// prompts by difficulty: broad and easy early on, narrower (but still with plenty of answers) as the rounds go up
const EASY = [
  "Name a dog breed", "Name a fruit", "Name a sport", "Name a country", "Name a musical instrument",
  "Name a bird", "Name a vegetable", "Name a board game", "Name a fish", "Name a flower",
  "Name a breakfast food", "Name a superhero", "Name a farm animal", "Name a kitchen tool", "Name a Disney movie",
  "Name a video game", "Name a dessert", "Name an ice cream flavor", "Name a fast food chain", "Name a soda or soft drink",
  "Name a sandwich", "Name a type of cookie", "Name a US state", "Name a mammal", "Name an Olympic sport",
  "Name a famous athlete", "Name a Pixar movie", "Name an animated TV show", "Name a Marvel character", "Name a Pokémon",
  "Name a Nintendo character", "Name a Harry Potter character", "Name a Star Wars character", "Name an organ in the human body", "Name a shape",
  "Name a color", "Name an app on a phone", "Name a social media platform", "Name a website", "Name a pop singer",
  "Name a rapper", "Name a piece of furniture", "Name a kitchen appliance", "Name a piece of clothing", "Name a profession",
  "Name a thing that's yellow", "Name a thing that's round", "Name a thing with wheels", "Name a thing that's cold", "Name a thing that flies",
  "Name an emotion", "Name a holiday", "Name a language", "Name a school subject", "Name a thing in a bathroom",
  "Name a thing in a classroom", "Name a type of shoe", "Name a candy bar", "Name a cereal brand", "Name a car brand",
  "Name an insect", "Name a sea creature", "Name a big cat", "Name a tech company", "Name a type of bread",
  "Name a cake", "Name a pizza topping", "Name an animal at the zoo", "Name a thing at the beach", "Name a toy",
  "Name a movie", "Name a TV show", "Name a city in the US", "Name a vehicle", "Name a body part",
  "Name a thing in a backpack", "Name a drink", "Name a restaurant chain", "Name a type of candy", "Name a party game",
  "Name a movie villain", "Name a cartoon character", "Name a thing you see in the sky", "Name a thing that's red", "Name a thing that's green",
  "Name a thing that's hot", "Name a job at a hospital", "Name a Halloween costume", "Name a movie actor or actress", "Name a clothing brand",
  "Name a shoe brand", "Name a snack food", "Name a thing at a birthday party", "Name a thing in a fridge", "Name a thing in a toolbox or garage",
  "Name a thing that's soft", "Name a thing you plug in", "Name a pet", "Name a thing at a farm", "Name a sports team",
  "Name a famous singer", "Name a video game character", "Name a SpongeBob or Simpsons character",
];
const MEDIUM = [
  "Name a type of cheese", "Name a kind of tree", "Name a famous painter", "Name a pasta shape", "Name a dinosaur",
  "Name a spice or herb", "Name a type of pasta sauce", "Name a soup", "Name a type of nut", "Name a type of bean",
  "Name a condiment or sauce", "Name a capital city", "Name a country in Africa", "Name a country in Asia", "Name a country in Europe",
  "Name a city in Europe", "Name a city in South America", "Name a city in Asia", "Name an island", "Name a mountain or mountain range",
  "Name a desert", "Name a lake", "Name a national park", "Name a river", "Name a famous landmark", "Name an ocean or sea",
  "Name a volcano", "Name a reptile", "Name a whale or dolphin", "Name a monkey or ape", "Name a bird of prey",
  "Name a bug that flies", "Name an animal that lives in the Arctic", "Name an animal found in Australia", "Name an extinct animal", "Name a soccer club",
  "Name an NBA team", "Name an NFL team", "Name an MLB team", "Name a martial art", "Name a track and field event",
  "Name a winter sport", "Name a tennis player", "Name a DC character", "Name a video game console", "Name a Lord of the Rings character",
  "Name a Greek god or goddess", "Name a mythical creature", "Name a fairy tale", "Name a disease", "Name a unit of measurement",
  "Name a programming language", "Name a computer brand", "Name a US president", "Name a famous scientist", "Name an inventor",
  "Name a famous composer", "Name a rock band", "Name a boy band or girl group", "Name a musical (stage show)", "Name a famous author",
  "Name a novel", "Name a Shakespeare play", "Name a tool in a toolbox", "Name a type of hat", "Name a fabric",
  "Name a type of boat", "Name a type of aircraft", "Name a car model", "Name a bicycle part", "Name a thing that's sticky",
  "Name a word that rhymes with cat", "Name a weather event", "Name a currency", "Name a type of dance music", "Name a guitar brand",
  "Name a dance style", "Name a card game", "Name a chemical element", "Name a planet, moon or star", "Name a gemstone",
  "Name a cat breed", "Name a snake", "Name a famous ship", "Name a drink you'd order at a café", "Name a festival or celebration",
  "Name a metal", "Name a cocktail", "Name a Mexican food", "Name an Italian food", "Name a Japanese food",
  "Name a Chinese food", "Name an Indian dish", "Name a type of pastry", "Name a berry", "Name a tropical fruit",
  "Name a root vegetable", "Name a type of tea", "Name a famous painting", "Name a famous building", "Name a Taylor Swift song",
  "Name a Batman villain", "Name a Spider-Man villain", "Name a Super Smash Bros fighter", "Name a Minecraft item or block", "Name a Christmas song",
  "Name a horror movie", "Name a Marvel movie", "Name a type of doctor", "Name a music genre", "Name a math term",
  "Name a slang word", "Name a compound word", "Name a word that rhymes with day", "Name a word that ends in -tion", "Name a word that's also a name",
  "Name a hairstyle", "Name a famous TV host", "Name a YouTuber", "Name a famous comedian", "Name an Olympic athlete",
  "Name a soccer player", "Name a basketball player", "Name a famous American football player", "Name a famous baseball player", "Name a fast car",
  "Name a famous racehorse or horse breed", "Name a type of dog toy or pet supply", "Name a board or card game from your childhood", "Name a famous duo", "Name an ancient wonder or ruin",
  "Name a famous explorer", "Name a famous king or queen", "Name an empire in history", "Name a war in history",
];
const HARD = [
  "Name a bone in the human body", "Name a muscle", "Name a yoga pose", "Name a gymnastics move", "Name a Norse god",
  "Name an opera", "Name a poet", "Name a chess opening", "Name a knot", "Name a rock or mineral",
  "Name a constellation", "Name a tarot card", "Name a palindrome word", "Name a word that starts with Q", "Name a word with double letters",
  "Name an onomatopoeia (sound word)", "Name an alphabet or writing system", "Name a butterfly or moth", "Name a spider", "Name a frog or toad",
  "Name a Formula 1 driver", "Name a shark species", "Name a breed of horse", "Name a breed of chicken", "Name a type of apple",
  "Name a type of mushroom", "Name a pepper or chili", "Name a leafy green", "Name a citrus fruit", "Name a wine grape",
  "Name a type of sushi", "Name a French dish", "Name a cheese from France", "Name a word that ends in -ology", "Name a word that starts with Z",
  "Name a French word used in English", "Name a Latin phrase used in English", "Name a type of cell in the body", "Name a part of the brain", "Name a hormone",
  "Name a disease caused by a virus", "Name a medical specialty", "Name a rocket or spacecraft", "Name an astronaut", "Name a space mission",
  "Name a fighter jet", "Name a famous bridge", "Name a famous museum", "Name a Shakespeare character", "Name a Greek hero",
  "Name an Egyptian god", "Name a Roman emperor", "Name a famous battle", "Name a famous philosopher", "Name a famous mathematician",
  "Name an ancient civilization", "Name a city in Japan", "Name a city in Italy", "Name a US state capital", "Name a nocturnal animal",
  "Name an animal that hibernates", "Name a word for a group of animals (like a pride of lions)", "Name a musical term (like forte)", "Name a jazz musician", "Name a famous guitarist",
  "Name an Oscar Best Picture winner", "Name an Alfred Hitchcock movie", "Name a Minecraft mob", "Name a Linux or terminal command", "Name a geometry term",
  "Name a law or equation in physics", "Name a subatomic particle", "Name a Beatles song", "Name a Michael Jackson song", "Name a James Bond movie",
  "Name a Star Wars planet", "Name a Mario Kart track", "Name an 8-bit or retro video game", "Name a deep-sea creature", "Name an invertebrate",
  "Name a seabird", "Name a dog breed from Germany", "Name a type of fern or moss", "Name a cactus or succulent", "Name a famous diamond or jewel",
  "Name a font or typeface",
];
const SEED = [...EASY, ...MEDIUM, ...HARD], LEVEL = {};
[EASY, MEDIUM, HARD].forEach((ps, lv) => ps.forEach(p => LEVEL[p] = lv));
const levelOf = p => LEVEL[p] ?? 1; // the daily game's prompts count as medium
const key = c => `ab:${c}`, tkey = c => `ab:${c}:t`, pkey = c => `ab:${c}:p`, BANK = "ab:bank";
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
  const text = (d.content || []).map(c => c.text || "").join("");
  if (!text) throw new Error("Empty reply (" + d.stop_reason + ": " + (d.content || []).map(c => c.type).join(",") + ")");
  return text;
}
function parseJSON(t, open) { const s = t.indexOf(open), e = t.lastIndexOf(open === "[" ? "]" : "}"); if (s < 0 || e < s) throw new Error("Bad JSON"); return JSON.parse(t.slice(s, e + 1)); }
async function judge(prompt, answer) {
  const ask = model => claude(model, `Prompt: "${prompt}"
Player's answer: "${answer}"
1. Is it a real, correct answer to the prompt? Be fair: accept normal spellings and small typos, but reject jokes, made-up things, things that don't fit, and answers that are too vague.
2. If correct, how RARE is it as an answer, 0 to 100? ${RARITY_SCALE}
3. If it's wrong but looks like a misspelling of a correct answer, put the correct answer in "suggest", otherwise leave it "".
Reply with only JSON: {"valid": true or false, "name": "the answer's proper name", "obscurity": number, "why": "a short friendly reason, max 10 words", "suggest": ""}`, 240);
  // Haiku and Sonnet are asked at the same moment; the first good verdict wins
  const v = await Promise.any(["haiku", "sonnet"].map(m => ask(m).then(t => parseJSON(t, "{"))));
  return { valid: !!v.valid, name: String(v.name || answer).slice(0, 50), obscurity: Math.max(0, Math.min(100, Number(v.obscurity) || 0)), why: String(v.why || "").slice(0, 80), suggest: v.valid ? "" : String(v.suggest || "").slice(0, 50) };
}
const LIST_RULES = `Use each answer's most common name. Put alternate names or spellings after a | (example: "Chickpea|Garbanzo bean").
Reply with only a JSON array of strings.`;
function parseList(t) {
  let arr; try { arr = parseJSON(t, "["); } catch { // cut off mid-list: keep every complete answer
    const s = t.indexOf("["), e = t.lastIndexOf('",'); if (s < 0 || e < s) throw new Error("Bad JSON " + t.length + ": " + t.slice(0, 160).replace(/\s+/g, " ")); arr = JSON.parse(t.slice(s, e + 1) + "]");
  }
  return arr.map(x => String(x).trim().slice(0, 80)).filter(Boolean);
}
// adds answers to a list, skipping any that are already on it (under any of their names)
function mergeLists(list, more) {
  const seen = new Set(list.flatMap(x => x.split("|").map(norm)));
  for (const x of more) { const ks = x.split("|").map(norm).filter(Boolean); if (ks.length && !ks.some(k => seen.has(k))) { list.push(x); ks.forEach(k => seen.add(k)); } }
  return list;
}
// a big ranked answer list: the well-known answers in order, then a second batch of deeper cuts, built at the same time
async function makeList(prompt) {
  const [a, b] = await Promise.allSettled([
    claude("sonnet", `Prompt: "${prompt}"
List 120 different correct answers, ordered from the answer the MOST people would say first, down to the most obscure answers that are still definitely correct.
${LIST_RULES}`, 4000),
    claude("sonnet", `Prompt: "${prompt}"
List 150 lesser-known answers that are still definitely correct. Skip the 40 answers most people would say first. Order them from fairly well known down to very obscure (things only fans or experts know).
${LIST_RULES}`, 4500)]);
  const top = a.status === "fulfilled" ? parseList(a.value) : [], deep = b.status === "fulfilled" ? parseList(b.value) : [];
  if (top.length < 30) throw new Error("List too short: " + (a.reason?.message || top.length));
  return mergeLists(top, deep).slice(0, 320);
}
// grows a list that's already in the bank with a batch of deeper cuts
async function extendList(prompt, list) {
  const t = await claude("sonnet", `Prompt: "${prompt}"
These answers are already known: ${list.map(x => x.split("|")[0]).join(", ")}.
List up to 150 MORE correct answers that are not in that list. Order them from fairly well known down to very obscure (things only fans or experts know).
${LIST_RULES}`, 4500);
  return mergeLists([...list], parseList(t)).slice(0, 320);
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
// adds a few missing prompt lists to the bank at once (each prompt is only ever written by one request);
// once every prompt has a list, it deepens the shortest old lists instead
async function growBank(have, n = 3) {
  const todo = SEED.filter(p => !have.includes(p)).sort(() => Math.random() - 0.5), picked = [];
  for (const p of todo) { if (picked.length >= n) break; if (await redis("SET", "ab:g3:" + norm(p), "1", "NX", "EX", "120")) picked.push(p); }
  if (!picked.length) { // nothing missing: deepen lists made before lists got big
    const lens = (await redis("HGETALL", LENS)) || [], known = {};
    for (let i = 0; i < lens.length; i += 2) known[lens[i]] = Number(lens[i + 1]);
    for (const p of have.filter(p => !(known[p] >= 170)).sort(() => Math.random() - 0.5)) {
      if (picked.length >= n) break;
      if (await redis("SET", "ab:x:" + norm(p), "1", "NX", "EX", "120")) picked.push(p);
    }
    if (!picked.length) return rateBank(have, n + 2);
    const made = await Promise.all(picked.map(async p => {
      try {
        const old = await listFor(p), list = old.length >= 170 ? old : await extendList(p, old);
        await redis("HSET", BANK, p, JSON.stringify(list)); await redis("HSET", LENS, p, String(Math.max(170, list.length))); await redis("HDEL", RARE, p); return p;
      } catch (e) { console.error("abduct extend", e.message); await redis("SET", "ab:x:" + norm(p), "1", "EX", "21600"); return null; }
    }));
    return made.filter(Boolean);
  }
  const made = await Promise.all(picked.map(async p => {
    try { const list = await makeList(p); if (list.length >= 40) { await redis("HSET", BANK, p, JSON.stringify(list)); await redis("HSET", LENS, p, String(Math.max(170, list.length))); await redis("HDEL", RARE, p); return p; } }
    catch (e) { console.error("abduct list", e.message); }
    await redis("SET", "ab:g3:" + norm(p), "1", "EX", "21600"); // didn't work out: leave this prompt alone for a few hours
    return null;
  }));
  return made.filter(Boolean);
}
// rates the lists that don't have rarity ratings yet (a few at a time)
async function rateBank(have, n) {
  const rated = new Set((await redis("HKEYS", RARE)) || []), picked = [];
  for (const p of have.filter(p => !rated.has(p)).sort(() => Math.random() - 0.5)) {
    if (picked.length >= n) break;
    if (await redis("SET", "ab:r:" + norm(p), "1", "NX", "EX", "120")) picked.push(p);
  }
  const made = await Promise.all(picked.map(async p => {
    try { const list = await listFor(p); await redis("HSET", RARE, p, JSON.stringify(await rateList(p, list))); return p; }
    catch (e) { console.error("abduct rate", e.message); await redis("SET", "ab:r:" + norm(p), "1", "EX", "21600"); return null; }
  }));
  return made.filter(Boolean);
}
// answers Claude okayed that weren't on the list, kept per prompt so they're recognized (and spell-checked) next time
const extraKey = prompt => "ab:extra:" + norm(prompt);
async function extrasFor(prompt) { const a = (await redis("HGETALL", extraKey(prompt))) || [], o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = Number(a[i + 1]); return o; }
// the closest known answer to a misspelling (only if it's close enough to be a typo, not a different answer)
function osa(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
function suggestFor(names, raw) {
  const k = norm(raw); if (k.length < 3) return "";
  const max = Math.max(1, Math.min(4, Math.round(k.length * 0.34)));
  let best = "", bestD = max + 1;
  for (const entry of names) for (const alias of String(entry).split("|")) {
    const a = norm(alias); if (!a || Math.abs(a.length - k.length) > max) continue;
    const d = osa(a, k); if (d < bestD) { bestD = d; best = entry.split("|")[0]; }
  }
  return best;
}
// Claude's verdict on an answer, cached; if another request is already asking, wait for its result instead of asking twice
const vkey = (prompt, raw) => `ab:v:${norm(prompt)}:${norm(raw)}`;
async function verdict(prompt, raw, req, cached) {
  const vk = vkey(prompt, raw), pk = "ab:vp:" + vk.slice(5);
  let v = cached === undefined ? await getJSON(vk) : cached; if (v) return v;
  if (!(await redis("SET", pk, "1", "NX", "EX", "8"))) {
    for (let i = 0; i < 50 && !v; i++) { await new Promise(r => setTimeout(r, 120)); v = await getJSON(vk); }
    if (v) return v;
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 64) || "x", ik = `ab:ip:${today()}:${ip}`;
  const ni = await redis("INCR", ik); if (ni === 1) await redis("EXPIRE", ik, "172800");
  if (ni > 2500) { const e = new Error("Too many guesses from here today."); e.status = 429; throw e; }
  try { v = await judge(prompt, raw); } finally { if (!v) await redis("DEL", pk); }
  await redis("SET", vk, JSON.stringify(v), "EX", String(30 * 86400));
  return v;
}
async function listFor(prompt) {
  const [v, r] = await Promise.all([redis("HGET", BANK, prompt), redis("HGET", RARE, prompt)]);
  const list = v ? JSON.parse(v) : []; list.rare = r ? JSON.parse(r) : null; return list;
}
// how rare answer k on a list is: its rating if the list has been rated, otherwise its position on the list
const tierAt = (list, k) => list.rare && Number.isFinite(list.rare[k]) ? rareTier(list.rare[k]) : scoreFromRank(k, list.length).tier;

/* ----- game helpers ----- */
function fuseRange(round, level = 0) { const f = Math.pow(0.95, round - 1), bonus = [0, 1000, 2500][level] || 0; return [Math.max(8500, Math.round(14500 * f)) + bonus, Math.max(12000, Math.round(22000 * f)) + bonus]; }
function event(room, e) { room.seq = (room.seq || 0) + 1; room.event = { seq: room.seq, ...e, at: Date.now() }; }
const inGame = p => p.alive && !p.left;
function nextAlive(room, from) { const n = room.players.length; for (let s = 1; s <= n; s++) { const i = (from + s) % n; if (inGame(room.players[i])) return i; } return from; }
function newBeam(room) { const [a, b] = fuseRange(room.round || 1, room.level || 0), t = a + crypto.randomInt(b - a + 1), start = Math.max(Date.now(), room.reveal || 0); room.beam = { start, total: t, deadline: start + t }; }
// which difficulty the next prompt should be: easy at first, mixing in medium, then hard as the rounds go up
function wantLevel(round) {
  const r = Math.random();
  if (round <= 2) return 0;
  if (round <= 4) return r < 0.6 ? 1 : 0;
  if (round <= 6) return r < 0.7 ? 1 : r < 0.9 ? 2 : 0;
  return r < 0.65 ? 2 : 1;
}
function nextPrompt(room) {
  room.seen = room.seen || [];
  const lv = wantLevel(room.round || 1), fresh = room.pool.filter(p => p !== room.prompt && !room.seen.includes(p));
  let cands = fresh.filter(p => levelOf(p) === lv);
  for (let d = 1; !cands.length && d <= 2; d++) cands = fresh.filter(p => Math.abs(levelOf(p) - lv) === d); // nearest level that's left
  if (!cands.length) { room.seen = []; cands = room.pool.filter(p => p !== room.prompt); }
  room.prompt = cands.length ? cands[crypto.randomInt(cands.length)] : room.pool[0];
  room.seen.push(room.prompt); room.level = levelOf(room.prompt);
  room.used = []; room.reveal = Date.now() + REVEAL;
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
const held = (room, pend) => !!pend && room.status === "playing" && pend.turnId === room.turnId && pend.at <= room.beam.deadline + GRACE && Date.now() < pend.at + HOLD_MS;
function tick(room, pend) {
  if (room.status !== "playing" || Date.now() < room.beam.deadline || held(room, pend)) return false;
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
    accept(room, i, { key: "i:" + plan.k, answer: plan.text, tier: tierAt(list, plan.k) });
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

function view(room, me, typing, pend) {
  const mi = room.players.findIndex(p => p.id === me), playing = room.status === "playing";
  return {
    code: room.code, status: room.status, me: mi, host: mi === 0,
    players: room.players.map((p, i) => ({ name: p.name, lives: p.lives ?? START_LIVES, power: p.power || 0, alive: p.alive !== false, left: !!p.left, last: p.last || null, best: p.best || null, answers: p.answers || 0, bot: p.bot || null, me: i === mi })),
    turn: room.turn ?? 0, turnId: room.turnId || 0, prompt: room.prompt || null, round: room.round || 1, level: room.level || 0, usedCount: (room.used || []).length,
    // the beam: when it started (ms from now, negative once running), how long it lasts, how much checking time was given back, and whether an answer is being checked
    beamIn: playing ? room.beam.start - Date.now() : 0, beamMs: playing ? room.beam.total : 0, fz: playing ? room.beam.frozen || 0 : 0, hold: held(room, pend),
    revealIn: room.status === "playing" ? Math.max(0, (room.reveal || 0) - Date.now()) : 0, promptLeft: room.promptLeft || 0,
    botType: botView(room), winner: room.winner ?? null, event: room.event || null, seq: room.seq || 0, game: room.game || 1,
    typing: typing && typing.turnId === room.turnId && room.status === "playing" ? { text: typing.text || "", bad: typing.bad || null } : null,
    maxLives: MAX_LIVES, preparing: !!room.preparing,
  };
}
async function save(room) { await redis("SET", key(room.code), JSON.stringify(room), "EX", String(TTL)); }
async function setTyping(room, text, bad) { await redis("SET", tkey(room.code), JSON.stringify({ turnId: room.turnId, text: String(text).slice(0, 40), bad: bad || null }), "EX", String(TTL)); }
const UNLOCK = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0";
async function withLock(code, fn) {
  const lk = `ab:${code}:lock`, tok = crypto.randomBytes(6).toString("hex");
  let got = false;
  for (let i = 0; i < 40 && !got; i++) { got = !!(await redis("SET", lk, tok, "NX", "PX", "5000")); if (!got) await sleep(50); }
  if (!got) throw Object.assign(new Error("The room is busy. Try again."), { status: 503 });
  try { return await fn(); } finally { await redis("EVAL", UNLOCK, "1", lk, tok).catch(() => {}); }
}
const parse = v => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
// gives back the time an answer spent being checked (when it turned out wrong), so checking never eats the clock
async function giveBack(code, turnId, at, dur) {
  try {
    if (dur > 120) await withLock(code, async () => {
      const r = await getJSON(key(code));
      if (!r || r.status !== "playing" || r.turnId !== turnId || at > r.beam.deadline + GRACE) return;
      const add = Math.min(dur, FREEZE_MAX - (r.beam.frozen || 0));
      if (add > 0) { r.beam.start += add; r.beam.deadline += add; r.beam.frozen = (r.beam.frozen || 0) + add; await save(r); }
    });
  } finally { await redis("DEL", pkey(code)).catch(() => {}); }
}
const pidOf = req => { const id = String(req.headers["x-moo-player"] || "").toLowerCase(); return /^[a-f0-9]{32}$/.test(id) ? id : null; };

export default async function handler(req, res) {
  try {
    const id = pidOf(req), noName = () => res.status(401).json({ error: "Pick a name to play.", code: "name" });
    if (!id) return noName();

    if (req.method === "GET") { // the room poll: one trip to the database
      const code = clean(req.query?.code);
      const got = await pipeline([["GET", `moo:pid:${id}`], ["GET", key(code)], ["GET", tkey(code)], ["GET", pkey(code)]]);
      if (!parse(got[0])?.name) return noName();
      let room = parse(got[1]), typing = parse(got[2]), pend = parse(got[3]);
      if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      if (room.status === "playing" && ((Date.now() >= room.beam.deadline && !held(room, pend)) || botNeeds(room))) {
        const list = await listFor(room.prompt);
        room = await withLock(code, async () => {
          const [rr, pp] = await pipeline([["GET", key(code)], ["GET", pkey(code)]]), r = parse(rr); if (!r) return r;
          pend = parse(pp);
          let changed = tick(r, pend);
          changed = botStep(r, r.prompt === room.prompt ? list : await listFor(r.prompt)) || changed;
          if (changed) await save(r);
          return r;
        });
        if (!room) return res.status(404).json({ error: "That room doesn't exist anymore." });
      } else if (room.status !== "playing" && req.query?.grow) { // a side request from the lobby: add a few prompts to the shared bank
        const have = await bankPrompts();
        await growBank(have, 3); // makes missing lists, then deepens short ones, then rates them
      }
      return res.status(200).json({ room: view(room, id, typing, pend) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Not allowed" });
    const { action } = req.body || {}, code = clean(req.body?.code);
    const first = await pipeline([["GET", `moo:pid:${id}`], ["GET", key(code || "-")]]);
    const me = { id, name: parse(first[0])?.name }, room0 = parse(first[1]);
    if (!me.name) return noName();

    if (action === "create") {
      let code = "";
      for (let t = 0; t < 8; t++) { code = Array.from(crypto.randomBytes(5), b => LETTERS[b % LETTERS.length]).join(""); if (!(await redis("EXISTS", key(code)))) break; }
      const room = { code, status: "lobby", players: [{ id, name: me.name }], game: 1, seq: 0, used: [] };
      await save(room);
      return res.status(200).json({ room: view(room, id) });
    }

    if (action === "type") {
      const room = room0;
      if (!room) return res.status(404).json({ error: "No room with that code." });
      const mi = room.players.findIndex(p => p.id === id);
      if (room.status === "playing" && mi === room.turn && req.body.turnId === room.turnId) await setTyping(room, String(req.body.text || "").slice(0, 40));
      return res.status(200).json({ ok: true });
    }

    // checks what someone is typing as soon as they pause, so the answer is already judged when they press Enter
    if (action === "check") {
      const room = room0;
      if (!room || room.status !== "playing" || !room.players.some(p => p.id === id) || Date.now() < (room.reveal || 0)) return res.status(200).json({ ok: false });
      const raw = String(req.body.text || "").replace(/\s+/g, " ").trim().slice(0, 50);
      if (raw.length < 3) return res.status(200).json({ ok: false });
      const list = await listFor(room.prompt);
      if (findInList(list, raw) >= 0) return res.status(200).json({ ok: true });
      try { const v = await verdict(room.prompt, raw, req); return res.status(200).json({ ok: true, valid: !!v.valid }); } catch { return res.status(200).json({ ok: false }); }
    }

    // an answer is checked before taking the room lock (checking a new answer with Claude can take a second)
    let checked = null;
    if (action === "answer") {
      const at = Date.now();
      if (!room0) return res.status(404).json({ error: "No room with that code." });
      const mi = room0.players.findIndex(p => p.id === id), turnId = room0.turnId;
      if (room0.status !== "playing" || mi !== room0.turn) return res.status(400).json({ error: "It's not your turn." });
      if (at < (room0.reveal || 0)) return res.status(400).json({ error: "Wait for the new prompt!", code: "wait" });
      const raw = String(req.body.answer || "").replace(/\s+/g, " ").trim().slice(0, 50);
      if (raw.length < 2) return res.status(400).json({ error: "Type an answer first." });
      if (at > room0.beam.deadline + GRACE) checked = { late: true };
      else {
        // one trip: the answer list, its ratings, extra accepted answers, any saved verdict, and the "answer in the air" marker that holds the turn
        const got = await pipeline([["HGET", BANK, room0.prompt], ["HGET", RARE, room0.prompt], ["HGETALL", extraKey(room0.prompt)], ["GET", vkey(room0.prompt, raw)],
          ["SET", pkey(code), JSON.stringify({ turnId, at }), "EX", "20"]]);
        const list = parse(got[0]) || [], extras = {}, nk = norm(raw); list.rare = parse(got[1]);
        for (let i = 0; i < (got[2] || []).length; i += 2) extras[got[2][i]] = Number(got[2][i + 1]);
        const wrong = async (status, body) => { // not accepted: hand back the checking time, then show the room as it is now
          await giveBack(code, turnId, at, Date.now() - at);
          const [rr, tt] = await pipeline([["GET", key(code)], ["GET", tkey(code)]]), r = parse(rr);
          return res.status(status).json(r ? { ...body, room: view(r, id, parse(tt)) } : body);
        };
        const onList = k => { const name = list[k].split("|")[0]; return { key: "i:" + k, alts: ["n:" + norm(name), "n:" + nk], answer: name, tier: tierAt(list, k) }; };
        const xs = Object.keys(extras), k = findInList(list, raw), x = k < 0 ? findInList(xs, raw) : -1;
        if (k >= 0) checked = onList(k);
        else if (x >= 0) checked = { key: "n:" + norm(xs[x]), alts: ["n:" + nk], answer: xs[x], tier: rareTier(extras[xs[x]]) };
        else {
          let v;
          try { v = await verdict(room0.prompt, raw, req, parse(got[3])); }
          catch (e) { return wrong(e.status || 503, { error: e.status ? e.message : "Couldn't check that answer. Try again!" }); }
          if (!v.valid) {
            await setTyping(room0, raw, "bad");
            let sug = suggestFor([...list, ...xs], raw) || v.suggest || "";
            if (norm(sug) === nk) sug = "";
            return wrong(400, { error: sug ? "Hmm, that's not quite it." : v.why || "That doesn't fit the prompt.", code: "invalid", suggest: sug });
          }
          const k2 = findInList(list, v.name); // Claude knew a nickname for something on the list
          if (k2 >= 0) checked = onList(k2);
          else {
            checked = { key: "n:" + norm(v.name || raw), alts: ["n:" + nk], answer: v.name || raw, tier: rareTier(v.obscurity), note: v.why };
            if (norm(v.name)) await redis("HSET", extraKey(room0.prompt), v.name, String(v.obscurity));
          }
        }
      }
      checked.at = at; checked.turnId = turnId;
    }

    const out = await withLock(code, async () => {
      const room = await getJSON(key(code));
      if (!room) return [404, { error: "No room with that code. Check it and try again." }];
      const mi = room.players.findIndex(p => p.id === id);
      const reply = async (status, extra = {}) => { // (an answer's "in the air" marker is cleared here too: by now it has been dealt with)
        const [t] = await pipeline(action === "answer" ? [["GET", tkey(code)], ["DEL", pkey(code)]] : [["GET", tkey(code)]]);
        return [status, { ...extra, room: view(room, id, parse(t)) }];
      };

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
        room.pool = pool; room.deck = []; room.seen = []; room.level = 0;
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
        // the answer counts if it arrived before the beam finished, however long checking it took
        if (room.turnId !== checked.turnId || room.turn !== mi || checked.late) { tick(room); await save(room); return reply(400, { error: "Too slow! 🛸", code: "abducted" }); }
        if ([checked.key, ...checked.alts].some(u => room.used.includes(u))) return reply(400, { error: "Someone already said that!", code: "used" });
        room.used.push(...checked.alts);
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
