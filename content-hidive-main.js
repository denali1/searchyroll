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
    nativeFetch = null;
  }

  const classify = async (response) => {
    let json;
    if (response && typeof response.clone === "function") {
      let text;
      try {
        text = await response.clone().text();
      } catch (_e) {
        return null;
      }
      try {
        json = JSON.parse(text);
      } catch (_e) {
        return null;
      }
    } else {
      json = response;
    }
    if (Array.isArray(json && json.contentItems)) {
      return json.contentItems;
    }
    if (json && typeof json === "object" && Array.isArray(json.content && json.content.buckets)) {
      return json.content.buckets;
    }
    return null;
  };

  const handleSecondParty = async (urlString, response) => {
    try {
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
      } else if (response && typeof response === "object" && response.status >= 400 && response.status < 600) {
        pubmark(marking.non200);
      }
    } catch (_ignored) {
      /* never throw, never break the page */
    }
  };

  const interceptingFetch = async (...args) => {
    let response;
    try {
      response = await nativeFetch(...args);
    } catch (_err) {
      throw _err;
    }
    const urlString = String(args[0] || "");
    if (isApiSecondParty(urlString)) {
      handleSecondParty(urlString, response);
    }
    return response;
  };

  try {
    if (typeof nativeFetch === "function") {
      window.fetch = interceptingFetch;
    }
  } catch (_err) {}

  /* ---- XHR patch (fallback for page calls that use XMLHttpRequest) ---- */
  if (window.XMLHttpRequest) {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__searchyrollUrl = String(url || "");
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (...sendArgs) {
      this.addEventListener("load", () => {
        const urlString = String(this.__searchyrollUrl || "");
        if (!isApiSecondParty(urlString)) {
          return;
        }
        let parsed = null;
        if (this.status >= 200 && this.status < 300) {
          try {
            parsed = JSON.parse(this.responseText);
          } catch (_e) {
            parsed = null;
          }
        }
        handleSecondParty(urlString, this.status >= 200 && this.status < 300 ? parsed : { status: this.status });
      });
      return origSend.apply(this, sendArgs);
    };
  }
})();