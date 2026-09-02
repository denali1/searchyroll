/*
 * content-cr-main.js
 *
 * Runs in the MAIN world (via the "world": "MAIN" content_scripts entry on
 * Crunchyroll). It is implemented as an eagerly-evaluated async IIFE so that,
 * whatever wrapper the page's own code installs before this runs, the page's
 * fetch calls still pass through the underlying native window.fetch we retain
 * here. We read a clone of the response, drop the parsed title data into the
 * page DOM for the isolated-world content-cr.js to pick up, and hand the
 * untouched response back to the page. We never throw and never modify
 * anything the page observes.
 *
 * The MAIN world has no access to any WebExtension API (Firefox 128+, Chrome
 * 111+), so all browser.* work happens in content-cr.js.
 */

"use strict";

console.log("[Searchyroll CR-MAIN] script loaded");

(async () => {
  const isHit = (urlString) =>
    /^https?:\/\/[^/]*\/content\/v2\/cms\/objects\/[^?]*(?:\?|$)/i.test(urlString);

  const markText = "--searchyroll-cr-interception--";
  const target = () => document.body || document.documentElement;

  let nativeFetch;
  try {
    nativeFetch = window.fetch.bind(window);
  } catch (_err) {
    return;
  }
  if (typeof nativeFetch !== "function") {
    return;
  }

  const interceptingFetch = async (...args) => {
    console.log("[Searchyroll CR-MAIN] fetch called:", String(args[0] || ""));
    let response;
    try {
      response = await nativeFetch(...args);
    } catch (_err) {
      throw _err;
    }

    try {
      if (response && typeof response.clone === "function" && isHit(String(args[0]) || "")) {
        const clone = response.clone();
        const text = await clone.text();
        const data = JSON.parse(text);

        const found = Array.isArray(data && data.data) ? data.data : [];
        if (found.length > 0) {
          target().setAttribute("data-searchyroll-cr", JSON.stringify(found));
        }
      }
    } catch (_ignored) {
      /* JSON not our expected shape; mark for tuning and move on. */
      try {
        target().setAttribute("data-searchyroll-cr", markText);
      } catch (_ignored2) {}
    }

    return response;
  };

  try {
    window.fetch = interceptingFetch;
  } catch (_err) {
    return;
  }
})();