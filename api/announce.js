import { getJSON, getAuth } from "./_lib.js";

// the announcement an admin posted, shown to everyone at the top of the chat
export default async function handler(req, res) {
  try {
    const auth = await getAuth(req);
    if (!auth) return res.status(401).json({ error: "Please log in again." });
    return res.status(200).json({ announce: await getJSON("announce") });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
}
