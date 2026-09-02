/*
 * anilist.js
 *
 * AniList enrichment client. Loaded in the ISOLATED world before content-cr.js
 * / content-hidive.js (see manifest.json) so enrichRecord is available to both.
 *
 * Queries https://graphql.anilist.co (anonymous, CORS-enabled: the API sends
 * Access-Control-Allow-Origin: *). Titles are batched into one GraphQL POST
 * using aliases, spaced >=700ms apart, staying well under the 90 req/min limit.
 *
 * enrichRecord NEVER throws: enrichment failure returns the original record
 * with enriched:false. It never blocks the interception pipeline.
 */

"use strict";

(function () {
  const API_URL = "https://graphql.anilist.co";
  const MIN_INTERVAL_MS = 700;
  const MAX_ALIASES = 10;
  const MAX_TAGS = 5;
  const LOG = "[Searchyroll AniList]";

  const normalizeTitle = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ");

  const sanitize = (value) => String(value || "").trim();

  /* ---- request queue ---- */

  const queue = [];
  let draining = false;
  let lastRequestAt = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const postAnilist = async (query, variables) => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (err) {
      console.warn(LOG, "network error (may be a CORS-less rate-limit response):", String(err));
      return null;
    }
    lastRequestAt = Date.now();
    if (!response) {
      return null;
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch (_e) {}
      console.warn(LOG, "AniList responded with status", response.status, "body:", detail ? detail.slice(0, 500) : "(no body)");
      return null;
    }
    try {
      const json = await response.json();
      if (json && json.errors) {
        console.warn(LOG, "GraphQL returned errors:", JSON.stringify(json.errors).slice(0, 800));
        return null;
      }
      return (json && json.data) || null;
    } catch (_e) {
      return null;
    }
  };

  const MEDIA_FIELDS = `{
    id
    idMal
    title { romaji english native }
    type
    format
    status
    episodes
    season
    seasonYear
    genres
    tags { name rank isMediaSpoiler }
    studios { nodes { name isAnimationStudio } }
    externalLinks { site url type }
    averageScore
    popularity
    isAdult
  }`;

  /* ---- matching / confidence ---- */

  const streamingUrlFor = (media) => {
    const links = (media && Array.isArray(media.externalLinks)) ? media.externalLinks : [];
    for (const link of links) {
      const url = link && link.url ? String(link.url) : "";
      if (!url) {
        continue;
      }
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch (_e) {
        continue;
      }
      if (/crunchyroll/.test(host) || /hidive/.test(host)) {
        return url;
      }
    }
    return null;
  };

  /* rejects Hidive-init style stubs like "Season 1" / "Episode 2" / "Part 3"
     that carry no real series name and would otherwise fuzzy-match junk */
  const isPlaceholderTitle = (raw) =>
    /^(season|episode|part|vol|volume|chapter|ovas?|specials?)\s*([0-9]+)?$/i.test(String(raw || "").trim());

  const titleTokens = (raw) =>
    normalizeTitle(raw)
      .split(/\s+/)
      .filter((tok) => tok.length >= 2 && /[a-z]/.test(tok));

  const titleSimilarity = (searched, media) => {
    if (isPlaceholderTitle(searched)) {
      return false;
    }
    const wanted = normalizeTitle(searched);
    if (!wanted) {
      return false;
    }
    const searchTokens = titleTokens(searched);
    if (searchTokens.length === 0) {
      return false;
    }
    const candidates = [(media.title || {}).romaji, (media.title || {}).english, (media.title || {}).native]
      .map(normalizeTitle)
      .filter(Boolean);
    for (const candidate of candidates) {
      const candTokens = titleTokens(candidate);
      if (candTokens.length === 0) {
        continue;
      }
      // token-membership ratio: how many of the search tokens appear in the candidate
      const matched = searchTokens.filter((tok) => candTokens.indexOf(tok) !== -1).length;
      const ratio = matched / searchTokens.length;
      if (ratio < 0.6) {
        continue;
      }
      // guard against substring-absorb into a much longer, otherwise-unrelated title
      if (candidate.indexOf(wanted) !== -1 && candTokens.length >= searchTokens.length * 2) {
        continue;
      }
      return true;
    }
    return false;
  };

  const episodesMismatch = (record, media) => {
    const ours = Number(record && record.episodeCount);
    const theirs = Number(media && media.episodes);
    if (!Number.isFinite(ours) || ours <= 0 || !Number.isFinite(theirs) || theirs <= 0) {
      return false;
    }
    return Math.abs(ours - theirs) / theirs > 0.15;
  };

  const primaryStudio = (media) => {
    const nodes = (media && media.studios && media.studios.nodes) || [];
    const animation = nodes.find((n) => n && n.isAnimationStudio && n.name);
    return animation ? animation.name : null;
  };

  const topTags = (media) => {
    const tags = (media && Array.isArray(media.tags)) ? media.tags : [];
    return tags
      .filter((t) => t && !t.isMediaSpoiler)
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .slice(0, MAX_TAGS)
      .map((t) => t.name);
  };

  const buildEnriched = (record, media) => ({
    ...record,
    anilistId: media.id,
    malId: media.idMal || null,
    anilistTitle: (media.title && media.title.romaji) || null,
    anilistStatus: media.status || null,
    anilistFormat: media.format || null,
    anilistEpisodes: Number.isFinite(media.episodes) ? media.episodes : null,
    anilistSeason: media.season || null,
    anilistSeasonYear: media.seasonYear || null,
    anilistGenres: Array.isArray(media.genres) ? media.genres : [],
    anilistTags: topTags(media),
    studio: primaryStudio(media),
    averageScore: Number.isFinite(media.averageScore) ? media.averageScore : null,
    isAdult: !!media.isAdult,
    anilistUrl: streamingUrlFor(media),
    enriched: true,
    enrichedAt: new Date().toISOString()
  });

  /* ---- drain loop ---- */

  const drain = async () => {
    draining = true;
    while (queue.length > 0) {
      const wave = queue.splice(0, MAX_ALIASES);
      let query = "";
      let varDecls = "";
      const variables = {};
      wave.forEach((item, i) => {
        item.alias = "media" + i;
        query = query + `${item.alias}: Media(search: $title${i}query, type: ANIME) ${MEDIA_FIELDS}\n`;
        variables["title" + i + "query"] = item.record.title;
        varDecls = varDecls + (i === 0 ? "" : ", ") + `$title${i}query: String`;
      });
      const wrapped = `query (${varDecls}) { ${query} }`;
      let data = null;
      try {
        data = await postAnilist(wrapped, variables);
      } catch (_e) {
        data = null;
      }
      for (const item of wave) {
        const media = data && data[item.alias];
        if (!media || !media.id) {
          item.resolve({ ...item.record, enriched: false, enrichedAt: new Date().toISOString() });
          continue;
        }
        if (!titleSimilarity(item.record.title, media)) {
          item.resolve({ ...item.record, enriched: false, enrichedAt: new Date().toISOString() });
          continue;
        }
        if (episodesMismatch(item.record, media)) {
          item.resolve({ ...item.record, enriched: false, enrichedAt: new Date().toISOString() });
          continue;
        }
        item.resolve(buildEnriched(item.record, media));
      }
    }
    draining = false;
  };

  const enqueue = (record) =>
    new Promise((resolve) => {
      queue.push({ record, resolve });
      if (!draining) {
        drain();
      }
    });

  /* ---- public API ---- */

  const enrichRecord = (record) => {
    try {
      if (!record || typeof record !== "object") {
        return Promise.resolve(record);
      }
      if (record.title === undefined || record.title === null || sanitize(record.title) === "") {
        return Promise.resolve({ ...record, enriched: false });
      }
      return enqueue({ ...record });
    } catch (_e) {
      return Promise.resolve(record);
    }
  };

  if (typeof window !== "undefined") {
    window.enrichRecord = enrichRecord;
  } else if (typeof globalThis !== "undefined") {
    globalThis.enrichRecord = enrichRecord;
  }
})();