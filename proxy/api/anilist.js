const ANILIST_API_URL = process.env.ANILIST_API_URL || "https://graphql.anilist.co";

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.status(204).end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!req.body || typeof req.body.query !== "string") {
    return res.status(400).json({ error: "GraphQL query is required" });
  }

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  try {
    const upstream = await fetch(ANILIST_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: req.body.query,
        variables: req.body.variables,
      }),
    });
    const body = await upstream.text();
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.status(upstream.status).send(body);
  } catch (error) {
    res.status(502).json({ error: "Upstream request failed" });
  }
};