/*
 * db.js
 *
 * IndexedDB wrapper for the Searchyroll catalog. Runs in the BACKGROUND
 * service worker context (extension origin), where it owns the single shared
 * 'searchyroll' database. Content scripts never touch IndexedDB directly;
 * they message background.js, which calls into the API exposed here as
 * globalThis.SearchyrollDB.
 *
 * All operations are wrapped so they resolve/reject cleanly and never throw
 * to a caller. Writes are fire-and-forget from the content-script side.
 *
 * Uses only the `browser.*` where needed (none here); this file is pure
 * IndexedDB + Promise logic with zero web extension API surface.
 */

"use strict";

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
