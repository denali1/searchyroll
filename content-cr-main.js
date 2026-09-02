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

(async () => {
  const isHit = (urlString) =>
    /^https?:\/\/[^/]*\/content\/v2\/cms\/objects\/[^?]*(?:\?|$)/i.test(urlString);

  const markText = "--searchyroll-cr-interception--";
  const target = () => document.body || document.documentElement;

  const relayHit = (textOrJson) => {
    let data;
    try {
      data = JSON.parse(typeof textOrJson === "string" ? textOrJson : JSON.stringify(textOrJson));
    } catch (_e) {
      target().setAttribute("data-searchyroll-cr", markText);
      return;
    }
    const found = Array.isArray(data && data.data) ? data.data : [];
    if (found.length > 0) {
      target().setAttribute("data-searchyroll-cr", JSON.stringify(found));
    }
  };

  /* ---- fetch patch ---- */
  let nativeFetch;
  try {
    nativeFetch = window.fetch.bind(window);
  } catch (_err) {
    nativeFetch = null;
  }
  if (typeof nativeFetch === "function") {
    const interceptingFetch = async (...args) => {
      let response;
      try {
        response = await nativeFetch(...args);
      } catch (_err) {
        throw _err;
      }
      try {
        if (response && typeof response.clone === "function" && isHit(String(args[0]) || "")) {
          const text = await response.clone().text();
          relayHit(text);
        }
      } catch (_ignored) {
        /* never throw, never break the page */
      }
      return response;
    };
    try {
      window.fetch = interceptingFetch;
    } catch (_err) {}
  }

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
        try {
          if (this.status >= 200 && this.status < 300 && isHit(String(this.__searchyrollUrl || ""))) {
            relayHit(this.responseText);
          }
        } catch (_ignored) {
          /* never throw, never break the page */
        }
      });
      return origSend.apply(this, sendArgs);
    };
  }
})();