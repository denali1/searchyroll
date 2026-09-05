#!/usr/bin/env node
"use strict";

/*
 * scripts/build-catalog.js
 *
 * Phase 6 — GitHub catalog artifact build.
 *
 * Standalone Node.js script (built-ins only: fs, path, zlib, global fetch).
 * Queries AniList for the top N anime by popularity (paginated Page queries,
 * perPage 50, ~1100ms spacing to respect the 60/min anonymous limit) and
 * produces:
 *   catalog/catalog.json.gz          gzipped JSON artifact (release asset)
 *   catalog/catalog-version.json     version manifest (committed to repo)
 *
 * LEGAL: the artifact contains ONLY AniList-derived data — AniList metadata
 * plus streaming URLs taken from AniList externalLinks. No CR/Hidive
 * proprietary catalog data and no platform-specific fields ever enter it.
 *
 * Modes:
 *   default   live AniList (via https://graphql.anilist.co, or --proxy URL / ANILIST_PROXY_URL)
 *   --fixture <file>   offline: reads a JSON array of raw media nodes (the exact
 *                      shape the Page query returns) from a file and runs the full
 *                      transformation pipeline without any network. Used for
 *                      code-verification while AniList is unavailable.
 *
 * Flags:
 *   --top <N>        how many title records to collect (default 5000)
 *   --min <N>        minimum records required (default 1) — abort with non-zero
 *                    exit if fewer were collected (guards scheduled builds
 *                    against a partial catalog when AniList is down)
 *   --out <dir>      output directory (default ./catalog)
 *   --version <v>    catalog version stamp, semver (default 1.0.0)
 *   --date <ISO>     catalog date stamp (default today, yyyy-mm-dd)
 *   --proxy <url>    POST AniList queries to a passthrough proxy instead of direct
 *   (env ANILIST_PROXY_URL works the same as --proxy)
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DEFAULT_ANILIST_URL = "https://graphql.anilist.co";
const PER_PAGE = 50;
const INTERVAL_MS = 1100;
const MAX_GENRE_TAGS = 10;
const MAX_GROUP_HOPS = 3;
const MAX_429_RETRIES = 5;
const RETRY_BACKOFF_MS = 5000;

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const OUT_DIR = path.resolve(argValue("--out") || "catalog");
const TOP = Math.max(1, Number(argValue("--top")) || 5000);
const MIN = Math.max(1, Number(argValue("--min")) || 1);
const VERSION = argValue("--version") || "1.0.0";
const DATE = argValue("--date") || new Date().toISOString().slice(0, 10);
const FIXTURE = argValue("--fixture");

const anilistUrl = () => {
  const proxy = argValue("--proxy") || (process.env.ANILIST_PROXY_URL || null);
  return proxy || DEFAULT_ANILIST_URL;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (msg) => console.log("[build-catalog] " + msg);
const warn = (msg) => console.warn("[build-catalog] " + msg);

class PageError extends Error {}

const MEDIA_FIELDS = `
    id
    idMal
    title { romaji english native }
    format
    status
    episodes
    season
    seasonYear
    genres
    tags { name rank isMediaSpoiler isGeneralSpoiler }
    studios { nodes { name isAnimationStudio } }
    externalLinks { site url type }
    averageScore
    popularity
    isAdult
    relations { edges { node { id } relationType } }`;

const pageQuery = (page) =>
  `query { Page(page: ${page}, perPage: ${PER_PAGE}) { pageInfo { hasNextPage } media(type: ANIME, sort: POPULARITY_DESC) { ${MEDIA_FIELDS} } } }`;

async function postPage(url, query, attempt) {
  attempt = attempt || 1;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ query })
    });
  } catch (err) {
    throw new PageError("network error: " + String(err.message || err));
  }
  if (res.status === 429) {
    if (attempt < MAX_429_RETRIES) {
      const backoff = RETRY_BACKOFF_MS * attempt;
      warn("AniList 429 — backing off " + backoff + "ms (attempt " + attempt + "/" + MAX_429_RETRIES + ")");
      await sleep(backoff);
      return postPage(url, query, attempt + 1);
    }
    throw new PageError("HTTP 429 after " + MAX_429_RETRIES + " retries");
  }
  let text = "";
  try {
    text = await res.text();
  } catch (_e) {}
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_e) {}
  if (!res.ok) {
    const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || ("HTTP " + res.status);
    throw new PageError(msg);
  }
  if (json && json.errors) {
    throw new PageError((json.errors[0] && json.errors[0].message) || "GraphQL error");
  }
  return (json && json.data) || null;
}

/* ---------------------------------------------------------------------------
 * Pipeline shared by live and fixture modes
 * ------------------------------------------------------------------------- */

const relationIdOf = (media, relationType) => {
  const edges = (media && media.relations && media.relations.edges) || [];
  for (const edge of edges) {
    if (edge && edge.relationType === relationType && edge.node && edge.node.id) {
      return edge.node.id;
    }
  }
  return null;
};

// Cross-page prequel chain traversal (script has the full dataset, so this is
// strictly better than the extension's in-batch-only rule).
const computeSeriesGroupIds = (mediaAll) => {
  const byId = new Map();
  for (const media of mediaAll) {
    if (media && media.id !== undefined && media.id !== null) {
      byId.set(String(media.id), media);
    }
  }
  const groupOf = (mediaId) => {
    let current = byId.get(String(mediaId));
    if (!current) {
      return mediaId;
    }
    let root = mediaId;
    for (let hop = 0; hop < MAX_GROUP_HOPS; hop++) {
      const prequelId = relationIdOf(current, "PREQUEL");
      if (prequelId === null) {
        break;
      }
      const prequel = byId.get(String(prequelId));
      root = prequelId;
      if (!prequel) {
        break;
      }
      current = prequel;
    }
    return root;
  };
  const groups = new Map();
  for (const media of mediaAll) {
    if (media && media.id !== undefined && media.id !== null) {
      groups.set(media.id, groupOf(media.id));
    }
  }
  return groups;
};

const primaryStudio = (media) => {
  const nodes = (media && media.studios && media.studios.nodes) || [];
  const animation = nodes.find((n) => n && n.isAnimationStudio && n.name);
  return animation ? animation.name : null;
};

const topTags = (media) => {
  const tags = (media && Array.isArray(media.tags)) ? media.tags : [];
  return tags
    .filter((t) => t && !t.isMediaSpoiler && !t.isGeneralSpoiler)
    .sort((a, b) => (b.rank || 0) - (a.rank || 0))
    .slice(0, MAX_GENRE_TAGS)
    .map((t) => t.name);
};

const streamingLinkFor = (media, siteMatcher) => {
  const links = (media && Array.isArray(media.externalLinks)) ? media.externalLinks : [];
  const site = links.find((l) => l && l.url && l.site && siteMatcher(l.site));
  if (site) {
    return String(site.url);
  }
  const host = links.find((l) => {
    if (!l || !l.url) {
      return false;
    }
    try {
      return siteMatcher(new URL(l.url).hostname);
    } catch (_e) {
      return false;
    }
  });
  return host ? String(host.url) : null;
};

const externalLinksOf = (media) => ({
  crunchyroll: streamingLinkFor(media, (s) => /crunchyroll/i.test(s)),
  hidive: streamingLinkFor(media, (s) => /hidive/i.test(s))
});

const buildRecords = (mediaAll, groups) => {
  const records = [];
  for (const media of mediaAll) {
    if (!media || media.id === undefined || media.id === null) {
      continue;
    }
    const romaji = (media.title && media.title.romaji) || null;
    const english = (media.title && media.title.english) || null;
    records.push({
      anilistId: media.id,
      malId: media.idMal || null,
      title: romaji || english || null,
      titleEnglish: english || null,
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
      seriesGroupId: groups.get(media.id),
      externalLinks: externalLinksOf(media),
      catalogVersion: VERSION,
      catalogDate: DATE
    });
  }
  return records;
};

const writeOutputs = (records) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify({ version: VERSION, date: DATE, count: records.length, records });
  const gzPath = path.join(OUT_DIR, "catalog.json.gz");
  const gz = zlib.gzipSync(Buffer.from(json, "utf8"));
  fs.writeFileSync(gzPath, gz);
  const manifestPath = path.join(OUT_DIR, "catalog-version.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ version: VERSION, date: DATE, count: records.length }, null, 2) + "\n");
  const withGenres = records.filter((r) => Array.isArray(r.anilistGenres) && r.anilistGenres.length > 0).length;
  log("wrote " + gzPath + " (" + gz.length + " bytes raw, " + json.length + " uncompressed)");
  log("wrote " + manifestPath);
  log("records: " + records.length + ", with populated anilistGenres: " + withGenres);
};

/* ---------------------------------------------------------------------------
 * Live fetch path
 * ------------------------------------------------------------------------- */

async function fetchAllMedia(url) {
  const mediaAll = [];
  let page = 1;
  let skipped = 0;
  while (mediaAll.length < TOP) {
    if (page > 1) {
      await sleep(INTERVAL_MS);
    }
    let data = null;
    try {
      data = await postPage(url, pageQuery(page), 1);
    } catch (err) {
      skipped += 1;
      if (err instanceof PageError) {
        warn("page " + page + " failed: " + err.message + (page === 1 ? " — aborting (unable to build without the first page)" : " — stopping pagination"));
      } else {
        warn("page " + page + " unexpected error: " + String(err));
      }
      if (page === 1) {
        throw err;
      }
      break;
    }
    const info = data && data.Page && data.Page.pageInfo;
    const list = (data && data.Page && Array.isArray(data.Page.media)) ? data.Page.media : [];
    if (list.length === 0) {
      break;
    }
    mediaAll.push.apply(mediaAll, list);
    log("page " + page + ": fetched " + list.length + " titles — " + mediaAll.length + " collected");
    if (!info || !info.hasNextPage) {
      break;
    }
    page += 1;
  }
  if (skipped > 0) {
    warn(skipped + " page(s) skipped");
  }
  return mediaAll;
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */

(async () => {
  let mediaAll = [];
  if (FIXTURE) {
    const raw = fs.readFileSync(path.resolve(FIXTURE), "utf8");
    const parsed = JSON.parse(raw);
    mediaAll = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.media) ? parsed.media : []);
    log("fixture mode: loaded " + mediaAll.length + " raw media nodes from " + FIXTURE);
  } else {
    const url = anilistUrl();
    log("fetching top " + TOP + " titles by popularity from " + url);
    mediaAll = await fetchAllMedia(url);
  }

  if (mediaAll.length === 0) {
    warn("no media collected — nothing to build");
    process.exit(1);
  }
  if (mediaAll.length < MIN) {
    warn("only " + mediaAll.length + " titles collected — below the required minimum of " + MIN + " (AniList down or pagination degraded)");
    process.exit(1);
  }

  log("computing cross-page series groups for " + mediaAll.length + " titles");
  const groups = computeSeriesGroupIds(mediaAll);
  const records = buildRecords(mediaAll, groups);
  writeOutputs(records);
  log("done — version " + VERSION + ", date " + DATE);
})().catch((err) => {
  console.error("[build-catalog] FATAL: " + String(err && err.message ? err.message : err));
  process.exit(1);
});