/*
 * background.js
 *
 * Searchyroll background service worker / event page. Owns the single shared
 * 'searchyroll' IndexedDB catalog on the extension origin and routes messages
 * from content scripts (and the popup) to it.
 *
 * This file is SELF-CONTAINED (vanilla JS, no build step). The IndexedDB layer
 * that previously lived in db.js is inlined here so the same single file works
 * in both Chrome (service_worker) and Firefox (scripts array) — Firefox's
 * scripts array runs in a window/event-page scope where importScripts() does
 * not exist.
 *
 * All operations are wrapped so they resolve/reject cleanly and never throw to
 * a caller. Writes are fire-and-forget from the content-script side.
 */

"use strict";

/* ===========================================================================
 * SearchyrollDB — IndexedDB catalog layer
 * ========================================================================= */

(function () {
  if (globalThis.SearchyrollDB) {
    return;
  }

  const DB_NAME = "searchyroll";
  const DB_VERSION = 2;
  const STORE = "titles";
  const KEY_PATH = "platformKey";

  let dbPromise = null;

  const openDB = () => {
    if (dbPromise) {
      return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        // v1: DB opened but store creation was gated by a stale objectStoreNames
        // check in some runs, leaving an empty DB with no 'titles' store.
        // v2 bump forces onupgradeneeded to fire again and create it.
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: KEY_PATH });
          store.createIndex("platform", "platform", { unique: false });
          store.createIndex("anilistId", "anilistId", { unique: false });
          store.createIndex("enriched", "enriched", { unique: false });
          store.createIndex("anilistStatus", "anilistStatus", { unique: false });
          store.createIndex("studio", "studio", { unique: false });
          store.createIndex("seriesGroupId", "seriesGroupId", { unique: false });
        }
      };
      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = (event) =>
        reject(event.target.error || new Error("IndexedDB open failed"));
      request.onblocked = () => {
        // Swallowed; a blocked open is not fatal for fire-and-forget writes.
      };
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
    return dbPromise;
  };

  const platformKeyOf = (record) => {
    const platform = record && record.platform ? String(record.platform) : "";
    const id = record && record.id !== undefined && record.id !== null ? String(record.id) : "";
    return platform + ":" + id;
  };

  const nonNullCount = (record) => {
    if (!record || typeof record !== "object") {
      return 0;
    }
    let count = 0;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value !== null && value !== undefined && value !== "") {
        count += 1;
      } else if (Array.isArray(value) && value.length > 0) {
        count += 1;
      }
    }
    return count;
  };

  const shouldOverwrite = (existing, incoming) => {
    if (!existing) {
      return true;
    }
    const existingEnriched = existing.enriched === true;
    const incomingEnriched = incoming.enriched === true;
    if (incomingEnriched && !existingEnriched) {
      return true; // series-name join / upgrade
    }
    if (incomingEnriched && existingEnriched) {
      const existingAt = new Date(existing.enrichedAt || 0).getTime();
      const incomingAt = new Date(incoming.enrichedAt || 0).getTime();
      return incomingAt > existingAt;
    }
    if (!incomingEnriched && existingEnriched) {
      return false; // never downgrade an enriched record
    }
    // both unenriched: keep the richer record
    return nonNullCount(incoming) > nonNullCount(existing);
  };

  const upsertTitle = async (record) => {
    const normalized = Object.assign({}, record);
    if (normalized.platformKey === undefined) {
      normalized.platformKey = platformKeyOf(normalized);
    }
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        let transaction;
        try {
          transaction = db.transaction(STORE, "readwrite");
        } catch (_e) {
          resolve(null);
          return;
        }
        const store = transaction.objectStore(STORE);
        const getRequest = store.get(normalized.platformKey);
        getRequest.onsuccess = () => {
          const existing = getRequest.result || null;
          if (shouldOverwrite(existing, normalized)) {
            try {
              store.put(normalized);
            } catch (_e) {
              transaction.abort();
              resolve(null);
              return;
            }
          }
          transaction.oncomplete = () => resolve(normalized);
          transaction.onerror = () => resolve(null);
          transaction.onabort = () => resolve(null);
        };
        getRequest.onerror = () => {
          try {
            transaction.abort();
          } catch (_e) {}
          resolve(null);
        };
      });
    } catch (_e) {
      return null;
    }
  };

  const getTitle = async (platformKey) => {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        let transaction;
        try {
          transaction = db.transaction(STORE, "readonly");
        } catch (_e) {
          resolve(null);
          return;
        }
        const request = transaction.objectStore(STORE).get(platformKey);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    } catch (_e) {
      return null;
    }
  };

  const getAllTitles = async () => {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        let transaction;
        try {
          transaction = db.transaction(STORE, "readonly");
        } catch (_e) {
          resolve([]);
          return;
        }
        const request = transaction.objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
      });
    } catch (_e) {
      return [];
    }
  };

  const matchesFilter = (record, filters) => {
    if (!filters) {
      return true;
    }
    if (filters.platform !== undefined && filters.platform !== null && filters.platform !== record.platform) {
      return false;
    }
    if (filters.anilistStatus !== undefined && filters.anilistStatus !== null && filters.anilistStatus !== record.anilistStatus) {
      return false;
    }
    if (filters.isSubbed !== undefined && filters.isSubbed !== null && !!filters.isSubbed !== !!record.isSubbed) {
      return false;
    }
    if (filters.isDubbed !== undefined && filters.isDubbed !== null && !!filters.isDubbed !== !!record.isDubbed) {
      return false;
    }
    if (filters.studio !== undefined && filters.studio !== null && filters.studio !== record.studio) {
      return false;
    }
    if (filters.genre !== undefined && filters.genre !== null) {
      const genres = Array.isArray(record.anilistGenres) ? record.anilistGenres : [];
      if (genres.indexOf(filters.genre) === -1) {
        return false;
      }
    }
    if (filters.tag !== undefined && filters.tag !== null) {
      const tags = Array.isArray(record.anilistTags) ? record.anilistTags : [];
      if (tags.indexOf(filters.tag) === -1) {
        return false;
      }
    }
    if (filters.enriched !== undefined && filters.enriched !== null) {
      const want = filters.enriched === true;
      if ((record.enriched === true) !== want) {
        return false;
      }
    }
    return true;
  };

  const queryTitles = async (filters) => {
    const all = await getAllTitles();
    return all.filter((record) => matchesFilter(record, filters || {}));
  };

  globalThis.SearchyrollDB = {
    openDB,
    upsertTitle,
    getTitle,
    queryTitles,
    getAllTitles,
    platformKeyOf
  };
})();

/* ===========================================================================
 * SearchyrollEnrich — AniList enrichment client
 *
 * Runs on the EXTENSION origin (background SW / event page) instead of the
 * page context. AniList queries previously fired from a content script on
 * crunchyroll.com / hidive.com returned HTTP 404 (page-origin/CORS context),
 * which silently stored every title as enriched:false and left the genre
 * filter empty. Fetching from the extension origin resolves that. Supersedes
 * the former anilist.js content-script module (retired).
 * ========================================================================= */

(function () {
  if (globalThis.SearchyrollEnrich) {
    return;
  }

  const API_URL = "https://searchyroll-n9zn7imo2-shadowforge-heavy-industries.vercel.app/graphql";
  const MIN_INTERVAL_MS = 700;
  const BISECT_INTERVAL_MS = 1200;
  const MAX_ALIASES = 10;
  const MAX_TAGS = 5;

  const normalizeTitle = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ");

  const sanitize = (value) => String(value || "").trim();

  const normalizeSearchArg = (value) =>
    String(value || "")
      .replace(/[\u2018\u2019\u02BC\u201A]/g, "'")
      .replace(/[\u201C\u201D\u201E]/g, "\"")
      .replace(/[\u2013\u2014\u2212\uFF0D]/g, "-")
      .replace(/[\u00A0\u2009\u202F\u3000]+/g, " ")
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, " ")
      .trim();

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
      console.warn(label, "AniList network error:", String(err));
      return { ok: false, status: 0 };
    }
    lastRequestAt = Date.now();
    if (!response) {
      return { ok: false, status: 0 };
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch (_e) {}
      console.warn(label, "AniList responded with status", response.status, "body:", detail ? detail.slice(0, 500) : "(no body)");
      return { ok: false, status: response.status };
    }
    try {
      const json = await response.json();
      if (json && json.errors) {
        console.warn(label, "GraphQL returned errors:", JSON.stringify(json.errors).slice(0, 800));
        return { ok: false, status: response.status };
      }
      return { ok: true, data: (json && json.data) || null };
    } catch (_e) {
      return { ok: false, status: response.status };
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
    relations {
      edges {
        node { id }
        relationType
      }
    }
  }`;

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
      const matched = searchTokens.filter((tok) => candTokens.indexOf(tok) !== -1).length;
      const ratio = matched / searchTokens.length;
      if (ratio < 0.6) {
        continue;
      }
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

  const MAX_GROUP_HOPS = 3;

  const relationIdOf = (media, relationType) => {
    const edges = (media && media.relations && media.relations.edges) || [];
    for (const edge of edges) {
      if (edge && edge.relationType === relationType && edge.node && edge.node.id) {
        return edge.node.id;
      }
    }
    return null;
  };

  const seriesGroupIdFor = (mediaId, mediaById) => {
    let current = mediaById[mediaId];
    if (!current) {
      return mediaId;
    }
    let root = mediaId;
    for (let hop = 0; hop < MAX_GROUP_HOPS; hop++) {
      const prequelId = relationIdOf(current, "PREQUEL");
      if (prequelId === null) {
        break;
      }
      const prequel = mediaById[prequelId];
      if (!prequel) {
        root = prequelId;
        break;
      }
      root = prequelId;
      current = prequel;
    }
    return root;
  };

  const buildEnriched = (record, media, seriesGroupId) => ({
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
    seriesGroupId,
    enriched: true,
    enrichedAt: new Date().toISOString()
  });

  const singleLookup = async (item) => {
    const wrapped = `query ($title0query: String) { ${item.alias}: Media(search: $title0query, type: ANIME) ${MEDIA_FIELDS}\n }`;
    const result = await postAnilist(wrapped, { title0query: item.searchArg });
    return result && result.ok && result.data ? result.data[item.alias] || null : null;
  };

  const drain = async () => {
    draining = true;
    while (queue.length > 0) {
      const wave = queue.splice(0, MAX_ALIASES);
      let query = "";
      let varDecls = "";
      const variables = {};
      wave.forEach((item, i) => {
        item.alias = "media" + i;
        item.searchArg = normalizeSearchArg(item.record.title);
        query = query + `${item.alias}: Media(search: $title${i}query, type: ANIME) ${MEDIA_FIELDS}\n`;
        variables["title" + i + "query"] = item.searchArg;
        varDecls = varDecls + (i === 0 ? "" : ", ") + `$title${i}query: String`;
      });
      const wrapped = `query (${varDecls}) { ${query} }`;
      let data = null;
      try {
        const result = await postAnilist(wrapped, variables);
        if (result && result.ok) {
          data = result.data;
        } else if (result && result.status === 404 && wave.length > 1) {
          console.warn(label, "AniList batch 404; retrying", wave.length, "titles individually");
          const bisected = {};
          let prevDispatchAt = Date.now();
          for (const item of wave) {
            const wait = BISECT_INTERVAL_MS - (Date.now() - prevDispatchAt);
            if (wait > 0) {
              await sleep(wait);
            }
            prevDispatchAt = Date.now();
            try {
              bisected[item.alias] = await singleLookup(item);
            } catch (_e) {
              bisected[item.alias] = null;
            }
          }
          data = bisected;
        }
      } catch (_e) {
        data = null;
      }
      const mediaById = {};
      for (const item of wave) {
        const media = data && data[item.alias];
        if (media && media.id) {
          mediaById[media.id] = media;
        }
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
        const seriesGroupId = seriesGroupIdFor(media.id, mediaById);
        item.resolve(buildEnriched(item.record, media, seriesGroupId));
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

  globalThis.SearchyrollEnrich = {
    enrichRecord
  };
})();

/* ===========================================================================
 * Message router — content scripts + popup -> SearchyrollDB / SearchyrollEnrich
 * ========================================================================= */

const DEBUG = false;
const label = "[Searchyroll]";

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "bad message" });
    return false;
  }
  const action = message.action;
  if (action === "upsertTitle") {
    SearchyrollDB.upsertTitle(message.record)
      .then((result) => {
        if (DEBUG) {
          console.log(label, "upserted", (message.record && message.record.platformKey) || "", result);
        }
        sendResponse({ ok: true, record: result || null });
      })
      .catch(() => sendResponse({ ok: false, error: "upsert failed" }));
    return true; // keep message channel open for async response
  }
  if (action === "getTitle") {
    SearchyrollDB.getTitle(message.platformKey)
      .then((record) => sendResponse({ ok: true, record: record || null }))
      .catch(() => sendResponse({ ok: false, error: "get failed" }));
    return true;
  }
  if (action === "queryTitles") {
    SearchyrollDB.queryTitles(message.filters || {})
      .then((records) => sendResponse({ ok: true, records: records }))
      .catch(() => sendResponse({ ok: false, error: "query failed" }));
    return true;
  }
  if (action === "getAllTitles") {
    SearchyrollDB.getAllTitles()
      .then((records) => sendResponse({ ok: true, records: records }))
      .catch(() => sendResponse({ ok: false, error: "getAll failed" }));
    return true;
  }
  if (action === "enrichTitle") {
    SearchyrollEnrich.enrichRecord(message.record || null)
      .then((record) => sendResponse({ ok: true, record: record || null }))
      .catch(() => sendResponse({ ok: false, error: "enrich failed" }));
    return true;
  }
  if (action === "openWelcome") {
    try {
      browser.tabs.create({ url: browser.runtime.getURL("welcome.html") });
    } catch (_e) {}
    sendResponse({ ok: true });
    return true;
  }
  sendResponse({ ok: false, error: "unknown action" });
  return false;
});

browser.commands.onCommand.addListener((command) => {
  if (command !== "toggle-search") {
    return;
  }
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id !== undefined && tab.id !== null) {
      browser.tabs.sendMessage(tab.id, { action: "toggleSearch" }).catch(() => {});
    }
  }).catch(() => {});
});

browser.runtime.onInstalled.addListener((details) => {
  console.log("[Searchyroll] Installed");
  if (details && details.reason === "install") {
    try {
      browser.tabs.create({ url: browser.runtime.getURL("welcome.html") });
    } catch (_e) {}
  }
});
