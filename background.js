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

  const BULK_CHUNK = 250;

  // Bulk import for the cold-start catalog (Phase 6). Chunked into bounded
  // transactions; each record still goes through shouldOverwrite so catalog
  // data can never downgrade a richer existing record. Returns the number of
  // records processed.
  const bulkUpsert = async (records) => {
    if (!Array.isArray(records) || records.length === 0) {
      return 0;
    }
    const db = await openDB().catch(() => null);
    if (!db) {
      return 0;
    }
    let processed = 0;
    for (let i = 0; i < records.length; i += BULK_CHUNK) {
      const chunk = records.slice(i, i + BULK_CHUNK);
      processed += await new Promise((resolve) => {
        let transaction;
        try {
          transaction = db.transaction(STORE, "readwrite");
        } catch (_e) {
          resolve(0);
          return;
        }
        const store = transaction.objectStore(STORE);
        let done = 0;
        for (const record of chunk) {
          const normalized = Object.assign({}, record);
          if (normalized.platformKey === undefined) {
            normalized.platformKey = platformKeyOf(normalized);
          }
          const getRequest = store.get(normalized.platformKey);
          getRequest.onsuccess = () => {
            const existing = getRequest.result || null;
            if (shouldOverwrite(existing, normalized)) {
              try {
                store.put(normalized);
              } catch (_e) {}
            }
            done += 1;
          };
          getRequest.onerror = () => {
            done += 1;
          };
        }
        transaction.oncomplete = () => resolve(done);
        transaction.onerror = () => resolve(done);
        transaction.onabort = () => resolve(done);
      });
    }
    return processed;
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
    bulkUpsert,
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
 * SearchyrollCatalog — cold-start bootstrap (Phase 6)
 *
 * Downloads the gzipped catalog artifact published to GitHub releases, and on
 * a fresh install (or when the published catalog version advances) materializes
 * each AniList-derived title into platform records and bulk-imports them into
 * the shared IndexedDB. The search overlay then works immediately — no need to
 * browse CR or Hidive first.
 *
 * LEGAL (Phase 6 brief): the artifact contains ONLY AniList-derived data
 * (AniList metadata + streaming URLs from externalLinks). CR/Hidive proprietary
 * catalog data and platform-specific fields (isSubbed, isDubbed, isSimulcast,
 * audioLocales, subtitleLocales) never enter it — those fields are null on
 * materialized records.
 *
 * All stages are fire-and-forget and individually guarded: any failure leaves
 * the extension fully functional with an empty index. The version check is
 * memoized per SW instance (checkPromise) and throttled to once per 24h
 * (catalogCheckedAt in browser.storage.local) so SW revival never hammers
 * GitHub.
 * ========================================================================= */

(function () {
  if (globalThis.SearchyrollCatalog) {
    return;
  }

  const DEBUG = false;
  const label = "[Searchyroll]";

  const CATALOG_OWNER = "denali1";
  const CATALOG_REPO = "searchyroll";
  const RAW_MANIFEST_URL =
    "https://raw.githubusercontent.com/" + CATALOG_OWNER + "/" + CATALOG_REPO + "/HEAD/catalog/catalog-version.json";
  const catalogAssetUrlFor = (version) =>
    "https://github.com/" + CATALOG_OWNER + "/" + CATALOG_REPO + "/releases/download/catalog-v" + version + "/catalog.json.gz";

  const STORAGE_VERSION_KEY = "catalogVersion";
  const STORAGE_CHECKED_KEY = "catalogCheckedAt";
  const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000;

  let checkPromise = null;
  let importBusy = false;

  const readStorage = async (keys) => {
    try {
      const obj = await browser.storage.local.get(keys);
      return obj || {};
    } catch (_e) {
      return {};
    }
  };

  const writeStorage = async (obj) => {
    try {
      await browser.storage.local.set(obj);
    } catch (_e) {}
  };

  // Materialize catalog records into platform records for IndexedDB.
  // Keys are namespaced as platform:c-<anilistId> so they can never collide
  // with live records (which are keyed by CR/Hidive numeric series ids).
  const materializeCatalogRecords = (records) => {
    if (!Array.isArray(records)) {
      return [];
    }
    const out = [];
    for (const rec of records) {
      if (!rec || rec.anilistId === undefined || rec.anilistId === null) {
        continue;
      }
      const base = {
        id: "c-" + String(rec.anilistId),
        title: rec.title || rec.titleEnglish || "",
        titleEnglish: rec.titleEnglish || null,
        anilistId: rec.anilistId,
        malId: rec.malId || null,
        anilistTitle: rec.title || null,
        anilistStatus: rec.anilistStatus || null,
        anilistFormat: rec.anilistFormat || null,
        anilistEpisodes: rec.anilistEpisodes || null,
        anilistSeason: rec.anilistSeason || null,
        anilistSeasonYear: rec.anilistSeasonYear || null,
        anilistGenres: Array.isArray(rec.anilistGenres) ? rec.anilistGenres : [],
        anilistTags: Array.isArray(rec.anilistTags) ? rec.anilistTags : [],
        studio: rec.studio || null,
        averageScore: rec.averageScore || null,
        isAdult: !!rec.isAdult,
        seriesGroupId: rec.seriesGroupId || null,
        type: "anime",
        enriched: true,
        enrichedAt: new Date().toISOString(),
        isSubbed: null,
        isDubbed: null,
        isSimulcast: null,
        audioLocales: null,
        subtitleLocales: null,
        catalogVersion: rec.catalogVersion || null,
        catalogDate: rec.catalogDate || null,
        url: null
      };
      const links = (rec.externalLinks && typeof rec.externalLinks === "object") ? rec.externalLinks : {};
      const targets = [];
      if (links.crunchyroll) {
        targets.push({ platform: "crunchyroll", url: String(links.crunchyroll) });
      }
      if (links.hidive) {
        targets.push({ platform: "hidive", url: String(links.hidive) });
      }
      if (targets.length === 0) {
        targets.push({ platform: "catalog", url: null });
      }
      for (const target of targets) {
        out.push(Object.assign({}, base, { platform: target.platform, url: target.url }));
      }
    }
    return out;
  };

  const gzipToText = async (bytes) => {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  };

  const downloadAndImportCatalog = async (url) => {
    if (importBusy) {
      return false;
    }
    importBusy = true;
    try {
      let response;
      try {
        response = await fetch(url);
      } catch (err) {
        console.warn(label, "catalog download network error:", String(err));
        return false;
      }
      if (!response || !response.ok) {
        console.warn(label, "catalog download failed: HTTP", response && response.status);
        return false;
      }
      let payload = null;
      try {
        const bytes = await response.arrayBuffer();
        const text = await gzipToText(bytes);
        payload = JSON.parse(text);
      } catch (err) {
        console.warn(label, "catalog decompress/parse failed:", String(err));
        return false;
      }
      const records = (payload && Array.isArray(payload.records)) ? payload.records : [];
      const version = (payload && typeof payload.version === "string") ? payload.version : null;
      if (records.length === 0) {
        console.warn(label, "catalog payload empty — skipped");
        return false;
      }
      const materialized = materializeCatalogRecords(records);
      const stored = await SearchyrollDB.bulkUpsert(materialized);
      if (DEBUG) {
        console.log(label, "catalog import:", stored, "records processed (materialized", materialized.length + ")");
      }
      if (version) {
        await writeStorage({ [STORAGE_VERSION_KEY]: version });
      }
      return true;
    } catch (err) {
      console.warn(label, "catalog bootstrap error:", String(err));
      return false;
    } finally {
      importBusy = false;
    }
  };

  const checkCatalogVersion = async () => {
    const now = Date.now();
    const st = await readStorage([STORAGE_VERSION_KEY, STORAGE_CHECKED_KEY]);
    const checkedAt = Number(st[STORAGE_CHECKED_KEY] || 0);
    if (checkedAt && (now - checkedAt) < CHECK_THROTTLE_MS) {
      return false; // throttled — checked recently
    }
    let manifest = null;
    try {
      const res = await fetch(RAW_MANIFEST_URL);
      if (!res || !res.ok) {
        throw new Error("HTTP " + (res && res.status));
      }
      manifest = await res.json();
    } catch (err) {
      console.warn(label, "catalog version check failed:", String(err));
      await writeStorage({ [STORAGE_CHECKED_KEY]: now });
      return false;
    }
    // Record the check regardless so SW revival doesn't hammer GitHub.
    await writeStorage({ [STORAGE_CHECKED_KEY]: now });
    if (!manifest || typeof manifest.version !== "string") {
      return false;
    }
    if (typeof manifest.count !== "number" || manifest.count <= 0) {
      return false; // placeholder / artifact not published yet — nothing to download
    }
    const current = st[STORAGE_VERSION_KEY] || null;
    if (current === manifest.version) {
      await writeStorage({ [STORAGE_VERSION_KEY]: current });
      return false; // already current
    }
    return await downloadAndImportCatalog(catalogAssetUrlFor(manifest.version));
  };

  const bootstrap = () => {
    if (!checkPromise) {
      checkPromise = checkCatalogVersion().catch(() => {
        checkPromise = null;
      });
    }
    return checkPromise;
  };

  globalThis.SearchyrollCatalog = {
    bootstrap,
    materializeCatalogRecords,
    catalogAssetUrlFor
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
  // Kick the catalog bootstrap (memoized — no-op if the startup check already ran).
  SearchyrollCatalog.bootstrap();
});

// Cold-start catalog bootstrap: runs on every SW wake, memoized per instance
// and throttled to once per 24h via the stored catalogCheckedAt timestamp.
SearchyrollCatalog.bootstrap();
