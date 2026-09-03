/*
 * search-overlay.js
 *
 * Self-contained Searchyroll search overlay UI for Crunchyroll and Hidive.
 *
 * Runs in the ISOLATED world (loaded by content-cr.js / content-hidive.js via
 * the manifest content_scripts array). Injects a Shadow DOM host into the page
 * `document.body` so Searchyroll's styles are fully isolated from the host
 * page and the host page's styles cannot leak in. Purely additive — it never
 * modifies, removes, or wraps any existing page element.
 *
 * Exposed as globalThis.SearchyrollOverlay with init(platform). Content scripts
 * call init(platform) and relay the background's {action:'toggleSearch'} message
 * into handleToggle().
 *
 * Disclaimer gating: until the disclaimer acknowledgement flag is set in
 * browser.storage.local, the overlay and floating button stay hidden. Triggering
 * the shortcut shows a non-intrusive toast with a link to the welcome page
 * instead. browser.storage.onChanged makes a freshly-set acknowledgement take
 * effect live (no page reload needed).
 */

"use strict";

(function () {
  if (globalThis.SearchyrollOverlay) {
    return;
  }

  const ACK_KEY = "searchyrollDisclaimerAck";
  const STYLE_ID = "syr-overlay-style";
  const HOST_ID = "syr-overlay-host";
  const DEBUG = false;

  const CSS = `
    .syr-host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #ffffff;
    }
    .syr-host * { box-sizing: border-box; }

    /* Floating trigger button (bottom-right) */
    .syr-btn {
      position: fixed;
      right: 24px;
      bottom: 24px;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #e85d04;
      color: #ffffff;
      font-weight: 700;
      font-size: 12px;
      border: none;
      cursor: pointer;
      pointer-events: auto;
      z-index: 2147483647;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1.1;
      text-align: center;
    }
    .syr-btn:hover, .syr-btn:focus {
      background: #f06a12;
    }

    /* Backdrop */
    .syr-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 2147483646;
      pointer-events: auto;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .syr-backdrop.syr-open {
      display: flex;
    }

    /* Overlay modal */
    .syr-modal {
      width: 640px;
      max-width: 92vw;
      max-height: 80vh;
      background: #1a1a2e;
      color: #ffffff;
      border-radius: 10px;
      border: 1px solid #3a3a5a;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .syr-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid #3a3a5a;
    }
    .syr-header h2 {
      margin: 0;
      font-size: 18px;
      color: #e85d04;
    }
    .syr-close {
      background: transparent;
      color: #b8b8d0;
      border: none;
      font-size: 22px;
      cursor: pointer;
      line-height: 1;
      padding: 4px 8px;
    }
    .syr-close:hover { color: #ffffff; }

    .syr-search {
      padding: 12px 18px;
      border-bottom: 1px solid #3a3a5a;
    }
    .syr-search input {
      width: 100%;
      padding: 10px 12px;
      font-size: 15px;
      color: #ffffff;
      background: #241f2e;
      border: 1px solid #4a4a6a;
      border-radius: 6px;
      outline: none;
    }
    .syr-search input:focus {
      border-color: #e85d04;
    }

    .syr-filters {
      padding: 10px 18px;
      border-bottom: 1px solid #3a3a5a;
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      align-items: center;
    }
    .syr-filter-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: #9a9ab8;
    }
    .syr-filter-group .syr-radio-row {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 13px;
      color: #ffffff;
    }
    .syr-filter-group label { cursor: pointer; }
    .syr-filter-group select {
      padding: 6px 8px;
      color: #ffffff;
      background: #241f2e;
      border: 1px solid #4a4a6a;
      border-radius: 6px;
      font-size: 13px;
      max-width: 220px;
    }

    .syr-results-wrap {
      flex: 1;
      overflow-y: auto;
      padding: 12px 18px;
      max-height: 48vh;
    }

    .syr-state {
      padding: 24px;
      text-align: center;
      color: #9a9ab8;
      font-size: 14px;
    }

    .syr-spinner {
      margin: 0 auto 12px;
      width: 28px;
      height: 28px;
      border: 3px solid #3a3a5a;
      border-top-color: #e85d04;
      border-radius: 50%;
      animation: syr-spin 0.8s linear infinite;
    }
    @keyframes syr-spin {
      to { transform: rotate(360deg); }
    }

    .syr-card {
      padding: 12px;
      margin-bottom: 10px;
      background: #241f2e;
      border: 1px solid #3a3a5a;
      border-radius: 8px;
    }
    .syr-card-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .syr-card-title {
      font-size: 15px;
      font-weight: 600;
      color: #ffffff;
      text-decoration: none;
    }
    .syr-card-title:hover { color: #e85d04; }
    .syr-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
      color: #ffffff;
    }
    .syr-badge-cr { background: #f47521; }
    .syr-badge-hidive { background: #3b7dd8; }
    .syr-badge-status {
      background: #4a4a6a;
      font-weight: 600;
    }
    .syr-card-meta {
      font-size: 12px;
      color: #b8b8d0;
      margin: 3px 0;
    }
    .syr-card-meta .syr-label { color: #9a9ab8; }
    .syr-genres {
      margin-top: 6px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .syr-genre {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: #2a2a44;
      color: #e0c3a0;
      border: 1px solid #4a4a6a;
    }

    /* Toast / disclaimer notice */
    .syr-toast {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 24px;
      background: #241f2e;
      color: #ffffff;
      border: 1px solid #e85d04;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 14px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .syr-toast button {
      background: transparent;
      color: #e85d04;
      border: none;
      text-decoration: underline;
      cursor: pointer;
      font-size: 14px;
      padding: 0;
    }
  `;

  const state = {
    platform: null,
    host: null,
    root: null,
    acked: false,
    open: false,
    toastTimer: null,
    searchTimer: null,
    genreOptions: []
  };

  const ensureHost = () => {
    if (state.host && state.host.isConnected) {
      return state.host;
    }
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
      (document.body || document.documentElement).appendChild(host);
    }
    state.host = host;
    if (!host.shadowRoot) {
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);
      state.root = root;
    } else {
      state.root = host.shadowRoot;
    }
    return host;
  };

  const readAck = () => {
    try {
      browser.storage.local.get(ACK_KEY).then((result) => {
        state.acked = (result && result[ACK_KEY]) === true;
        syncButton();
      }).catch(() => {});
    } catch (_e) {}
  };

  const syncButton = () => {
    if (!state.root) {
      return;
    }
    let btn = state.root.getElementById("syr-btn");
    if (state.acked) {
      if (!btn) {
        injectButton();
      }
    } else if (btn) {
      btn.remove();
    }
  };

  const injectButton = () => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "syr-btn";
    btn.className = "syr-btn";
    btn.textContent = "Search";
    btn.title = "Open Searchyroll search";
    btn.addEventListener("click", toggle);
    state.root.appendChild(btn);
  };

  const showToast = () => {
    if (!state.root) {
      return;
    }
    let toast = state.root.getElementById("syr-toast");
    if (toast) {
      toast.remove();
    }
    toast = document.createElement("div");
    toast.id = "syr-toast";
    toast.className = "syr-toast";
    const text = document.createElement("span");
    text.textContent = "Searchyroll: Please read and acknowledge the disclaimer before use.";
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = "Open disclaimer";
    link.addEventListener("click", () => {
      openWelcome();
      hideToast();
    });
    toast.appendChild(text);
    toast.appendChild(link);
    state.root.appendChild(toast);
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
    }
    state.toastTimer = setTimeout(hideToast, 8000);
  };

  const hideToast = () => {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    if (state.root) {
      const toast = state.root.getElementById("syr-toast");
      if (toast) {
        toast.remove();
      }
    }
  };

  const openWelcome = () => {
    try {
      browser.runtime.sendMessage({ action: "openWelcome" }).catch(() => {});
    } catch (_e) {}
  };

  const toggle = () => {
    if (!state.acked) {
      showToast();
      return;
    }
    if (state.open) {
      closeOverlay();
    } else {
      openOverlay();
    }
  };

  const openOverlay = () => {
    ensureHost();
    state.open = true;
    let backdrop = state.root.getElementById("syr-backdrop");
    if (!backdrop) {
      const modalHtml = `
        <div class="syr-modal" role="dialog" aria-modal="true" aria-label="Searchyroll search">
          <div class="syr-header">
            <h2>Searchyroll</h2>
            <button type="button" class="syr-close" id="syr-close" aria-label="Close">×</button>
          </div>
          <div class="syr-search">
            <input id="syr-search-input" type="text" placeholder="Search titles by name..." autocomplete="off">
          </div>
          <div class="syr-filters">
            <div class="syr-filter-group">
              <span>Platform</span>
              <div class="syr-radio-row">
                <label><input type="radio" name="syr-platform" value="" data-filter="platform"> All</label>
                <label><input type="radio" name="syr-platform" value="crunchyroll"> Crunchyroll</label>
                <label><input type="radio" name="syr-platform" value="hidive"> Hidive</label>
              </div>
            </div>
            <div class="syr-filter-group">
              <span>Status</span>
              <div class="syr-radio-row">
                <label><input type="radio" name="syr-status" value=""> All</label>
                <label><input type="radio" name="syr-status" value="FINISHED"> Finished</label>
                <label><input type="radio" name="syr-status" value="RELEASING"> Releasing</label>
              </div>
            </div>
            <div class="syr-filter-group">
              <span>Dub / Sub</span>
              <div class="syr-radio-row">
                <label><input type="radio" name="syr-dubsub" value=""> Any</label>
                <label><input type="radio" name="syr-dubsub" value="dubbed"> Dubbed</label>
                <label><input type="radio" name="syr-dubsub" value="subbed"> Subbed</label>
              </div>
            </div>
            <div class="syr-filter-group">
              <span>Genre</span>
              <select id="syr-genre" multiple>
              </select>
            </div>
          </div>
          <div class="syr-results-wrap" id="syr-results"></div>
        </div>`;
      backdrop = document.createElement("div");
      backdrop.id = "syr-backdrop";
      backdrop.className = "syr-backdrop";
      backdrop.innerHTML = modalHtml;
      state.root.appendChild(backdrop);
    }
    backdrop.classList.add("syr-open");
    const input = state.root.getElementById("syr-search-input");
    if (input) {
      input.focus();
    }
    wireOverlayEvents();
    if (state.platform) {
      const pradio = state.root.querySelector('input[name="syr-platform"][value="' + state.platform + '"]');
      if (pradio) {
        pradio.checked = true;
      }
    }
    loadGenres();
    runQuery();
  };

  const closeOverlay = () => {
    if (!state.root) {
      return;
    }
    const backdrop = state.root.getElementById("syr-backdrop");
    if (backdrop) {
      backdrop.classList.remove("syr-open");
      backdrop.remove();
    }
    state.open = false;
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
  };

  const runFilterQuery = () => {
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
      state.searchTimer = null;
    }
    runQuery();
  };

  const onRadioChange = (event) => {
    const target = event.target;
    if (!target || !target.name) {
      return;
    }
    if (target.name !== "syr-platform" &&
        target.name !== "syr-status" &&
        target.name !== "syr-dubsub") {
      return;
    }
    if (DEBUG) {
      console.log("[Searchyroll] radio change", target.name, target.value);
    }
    if (DEBUG) {
      console.log("[Searchyroll] filters now:", JSON.stringify(currentFilters()));
    }
    runFilterQuery();
  };

  const onRadioClickFallback = () => {
    if (DEBUG) {
      console.log("[Searchyroll] radio click fallback -> re-query");
    }
    setTimeout(runQuery, 0);
  };

  const onGenreChange = () => {
    if (DEBUG) {
      console.log("[Searchyroll] genre change", JSON.stringify(currentFilters()));
    }
    runFilterQuery();
  };

  const wireOverlayEvents = () => {
    if (!state.root) {
      return;
    }
    const backdrop = state.root.getElementById("syr-backdrop");
    if (backdrop && !backdrop.dataset.wired) {
      backdrop.dataset.wired = "1";
      backdrop.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          closeOverlay();
        }
      });
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) {
          closeOverlay();
        }
      });
    }
    const close = state.root.getElementById("syr-close");
    if (close && !close.dataset.wired) {
      close.dataset.wired = "1";
      close.addEventListener("click", closeOverlay);
    }
    const input = state.root.getElementById("syr-search-input");
    if (input && !input.dataset.wired) {
      input.dataset.wired = "1";
      input.addEventListener("input", () => {
        if (state.searchTimer) {
          clearTimeout(state.searchTimer);
        }
        state.searchTimer = setTimeout(runQuery, 300);
      });
    }
    const radios = state.root.querySelectorAll("input[type=radio]");
    for (const radio of radios) {
      radio.addEventListener("change", onRadioChange);
      radio.addEventListener("click", onRadioClickFallback);
    }
    const genre = state.root.getElementById("syr-genre");
    if (genre) {
      genre.addEventListener("change", onGenreChange);
    }
  };

  const currentFilters = () => {
    const filters = {};
    if (!state.root) {
      return filters;
    }
    const platform = state.root.querySelector('input[name="syr-platform"]:checked');
    if (platform && platform.value) {
      filters.platform = platform.value;
    }
    const status = state.root.querySelector('input[name="syr-status"]:checked');
    if (status && status.value) {
      filters.anilistStatus = status.value;
    }
    const dubsub = state.root.querySelector('input[name="syr-dubsub"]:checked');
    if (dubsub && dubsub.value === "dubbed") {
      filters.isDubbed = true;
    } else if (dubsub && dubsub.value === "subbed") {
      filters.isSubbed = true;
    }
    const genre = state.root.getElementById("syr-genre");
    if (genre) {
      const selected = [].slice.call(genre.selectedOptions || []).map((o) => o.value);
      if (selected.length > 0) {
        filters.genre = selected[0];
      }
    }
    return filters;
  };

  const resultsEl = () => (state.root ? state.root.getElementById("syr-results") : null);

  const setLoading = () => {
    const el = resultsEl();
    if (!el) {
      return;
    }
    el.innerHTML = '<div class="syr-state"><div class="syr-spinner"></div>Searching...</div>';
  };

  const isEmptyState = (query, count) => {
    if (count === 0 && query) {
      return '<div class="syr-state">No results match "' + escapeHtml(query) + '".</div>';
    }
    if (count === 0) {
      return '<div class="syr-state">No results — try browsing more titles to build your catalog.</div>';
    }
    return null;
  };

  const escapeHtml = (str) => String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);

  const filterByQuery = (records, query) => {
    if (!query) {
      return records;
    }
    const q = String(query).toLowerCase();
    return records.filter((r) => {
      const title = String(r.title || "");
      const alt = String(r.anilistTitle || "");
      return title.toLowerCase().indexOf(q) !== -1 || alt.toLowerCase().indexOf(q) !== -1;
    });
  };

  const platformLabel = (p) => (p === "crunchyroll" ? "Crunchyroll" : p === "hidive" ? "Hidive" : String(p || ""));

  const cardHtml = (record) => {
    const platform = record.platform === "crunchyroll" ? "CR" : platformLabel(record.platform);
    const platformCls = record.platform === "crunchyroll" ? "syr-badge-cr" : "syr-badge-hidive";
    const status = record.anilistStatus || null;
    const genres = Array.isArray(record.anilistGenres) ? record.anilistGenres : [];
    const parts = [];
    if (record.isSubbed) {
      parts.push("Sub");
    }
    if (record.isDubbed) {
      parts.push("Dub");
    }
    const dubsub = parts.length > 0 ? parts.join(" · ") : null;
    const watchUrl = record.url || "#";
    let html = '<div class="syr-card">';
    html += '<div class="syr-card-title-row">';
    html += '<a class="syr-card-title" href="' + escapeHtml(watchUrl) + '">' + escapeHtml(record.title) + "</a>";
    html += '<span class="syr-badge ' + platformCls + '">' + escapeHtml(platform) + "</span>";
    if (status) {
      html += '<span class="syr-badge syr-badge-status">' + escapeHtml(status) + "</span>";
    }
    html += "</div>";
    if (record.studio) {
      html += '<div class="syr-card-meta"><span class="syr-label">Studio:</span> ' + escapeHtml(record.studio) + "</div>";
    }
    if (dubsub) {
      html += '<div class="syr-card-meta"><span class="syr-label">Audio:</span> ' + escapeHtml(dubsub) + "</div>";
    }
    if (genres.length > 0) {
      html += '<div class="syr-genres">' + genres.map((g) => '<span class="syr-genre">' + escapeHtml(g) + "</span>").join("") + "</div>";
    }
    html += "</div>";
    return html;
  };

  const queryTitles = (filters) =>
    new Promise((resolve) => {
      try {
        browser.runtime.sendMessage({ action: "queryTitles", filters: filters || {} }).then((res) => {
          resolve((res && res.ok && Array.isArray(res.records)) ? res.records : []);
        }).catch(() => resolve([]));
      } catch (_e) {
        resolve([]);
      }
    });

  const runQuery = () => {
    if (!state.open) {
      return;
    }
    setLoading();
    const input = state.root.getElementById("syr-search-input");
    const query = (input && input.value) || "";
    const filters = currentFilters();
    queryTitles(filters).then((records) => {
      const matched = filterByQuery(records, query);
      const el = resultsEl();
      if (!el) {
        return;
      }
      const empty = isEmptyState(query, matched.length);
      if (empty) {
        el.innerHTML = empty;
        return;
      }
      el.innerHTML = matched.map(cardHtml).join("");
    });
  };

  const loadGenres = () => {
    queryTitles({}).then((records) => {
      const set = new Set();
      for (const r of records) {
        if (Array.isArray(r.anilistGenres)) {
          for (const g of r.anilistGenres) {
            set.add(g);
          }
        }
      }
      const options = [].slice.call(set).sort();
      state.genreOptions = options;
      const genre = state.root.getElementById("syr-genre");
      if (genre) {
        genre.innerHTML = "";
        for (const g of options) {
          const opt = document.createElement("option");
          opt.value = g;
          opt.textContent = g;
          genre.appendChild(opt);
        }
      }
    });
  };

  const init = (platform) => {
    state.platform = platform || null;
    ensureHost();
    readAck();
    try {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes && changes[ACK_KEY]) {
          state.acked = changes[ACK_KEY].newValue === true;
          syncButton();
        }
      });
    } catch (_e) {}
  };

  const handleToggle = () => {
    ensureHost();
    readAck();
    toggle();
  };

  globalThis.SearchyrollOverlay = {
    init,
    handleToggle
  };
})();
