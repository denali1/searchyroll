/*
 * content-hidive-main.js
 *
 * Runs in the MAIN world (via the "world": "MAIN" content_scripts entry on
 * Hidive). Same design as content-cr-main.js: keep a pristine bound reference
 * to the native window.fetch in an eager IIFE, wrap it, drop a clone's
 * contents (or a hit/non-200 marker) into the page DOM for the
 * isolated-world content-hidive.js to consume, and hand the original response
 * straight back to the page — page behavior is never altered.
 */

"use strict";

(async () => {
  const API_ORIGIN = "https://dce-frontoffice.imggaming.com";

  const isApiSecondParty = (urlString) => {
    try {
      return new URL(urlString).origin === API_ORIGIN;
    } catch (_e) {
      return false;
    }
  };
  const isRelated = (urlString) => /^\/api\/v4\/season\/[\d]+\/related(?:\?|$)/i.test(new URL(urlString).pathname);
  const isInit = (urlString) => /^\/api\/v1\/init\/?(?:\?|$)/i.test(new URL(urlString).pathname);

  const marking = {
    related: "--searchyroll-hidive-related--",
    init: "--searchyroll-hidive-init--",
    non200: "--searchyroll-hidive-non200--"
  };

  const pubmark = (text) => {
    (document.body || document.documentElement).setAttribute("data-searchyroll-hidive", text);
  };

  let nativeFetch;
  try {
    nativeFetch = window.fetch.bind(window);
  } catch (_err) {
    return;
  }
  if (typeof nativeFetch !== "function") {
    return;
  }

  const classify = async (response) => {
    let text = "";
    try {
      text = await response.clone().text();
    } catch (_e) {
      return null;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (_e) {
      return null;
    }
    if (Array.isArray(json && json.contentItems)) {
      return json.contentItems;
    }
    if (json && typeof json === "object" && Array.isArray(json.content && json.content.buckets)) {
      return json.content.buckets;
    }
    return null;
  };

  const interceptingFetch = async (...args) => {
    let response;
    try {
      response = await nativeFetch(...args);
    } catch (_err) {
      throw _err;
    }

    try {
      if (!(response && typeof response.clone === "function")) {
        return response;
      }
      const urlString = String(args[0] || "");
      if (!isApiSecondParty(urlString)) {
        return response;
      }

      if (isRelated(urlString)) {
        const items = await classify(response);
        if (Array.isArray(items)) {
          pubmark(JSON.stringify({ kind: "related", found: items }));
        } else {
          pubmark(marking.related);
        }
      } else if (isInit(urlString)) {
        const buckets = await classify(response);
        if (Array.isArray(buckets)) {
          pubmark(JSON.stringify({ kind: "init", found: buckets }));
        } else {
          pubmark(marking.init);
        }
      } else if (!response.ok) {
        pubmark(marking.non200);
      }
    } catch (_ignored) {
      /* never throw, never break the page */
    }

    return response;
  };

  try {
    window.fetch = interceptingFetch;
  } catch (_err) {
    return;
  }
})();