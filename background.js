"use strict";

// Chrome uses a single service_worker entry, so load db.js here via
// importScripts (Firefox loads it from the background "scripts" array; the
// SearchyrollDB guard in db.js makes double-loading safe).
importScripts("db.js");

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
  sendResponse({ ok: false, error: "unknown action" });
  return false;
});

browser.runtime.onInstalled.addListener(() => {
  console.log("[Searchyroll] Installed");
});
