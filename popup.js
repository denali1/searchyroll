"use strict";

const SETTINGS_KEY = "searchyrollSettings";
const statusEl = document.getElementById("syr-status");

const setStatus = (text) => {
  if (statusEl) {
    statusEl.textContent = text;
  }
};

const isPlatformURL = (url) =>
  /^https?:\/\/([^/]*\.)?(crunchyroll\.com|hidive\.com)(\/|$)/i.test(String(url || ""));

const openSettingsTab = () => {
  try {
    browser.tabs.create({ url: browser.runtime.getURL("settings.html") });
  } catch (_e) {}
};

// Debug dump, gated by the searchyrollSettings.debugMode flag. Kept so catalog
// verification (before/after clear and reset) can be driven from the popup.
const maybeDumpCatalog = () => {
  try {
    browser.storage.local.get(SETTINGS_KEY).then((obj) => {
      const s = (obj && obj[SETTINGS_KEY]) || {};
      if (s.debugMode !== true) {
        return;
      }
      browser.runtime.sendMessage({ action: "getAllTitles" }).then((res) => {
        if (!res || !res.ok) {
          console.warn("[Searchyroll] getAllTitles failed:", res && res.error);
          return;
        }
        const records = res.records;
        console.log("[Searchyroll] Catalog record count:", records.length);
        console.table(records);
      }).catch((err) => {
        console.warn("[Searchyroll] getAllTitles failed:", err);
      });
    }).catch(() => {});
  } catch (_e) {}
};

const route = () => {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id === undefined || tab.id === null) {
      openSettingsTab();
      window.close();
      return;
    }
    const url = String(tab.url || "");
    const settingsURL = browser.runtime.getURL("settings.html");
    if (url === settingsURL) {
      // Already on the settings page — nothing to do.
      window.close();
      return;
    }
    if (isPlatformURL(url)) {
      setStatus("Opening Searchyroll…");
      browser.tabs.sendMessage(tab.id, { action: "toggleSearch" })
        .catch(() => {})
        .then(() => window.close());
      return;
    }
    setStatus("Opening settings…");
    openSettingsTab();
    window.close();
  }).catch(() => {
    openSettingsTab();
    window.close();
  });
};

maybeDumpCatalog();
route();