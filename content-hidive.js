/*
 * content-hidive.js
 *
 * Runs in the ISOLATED world on Hidive. Consumes the hit buckets that
 * content-hidive-main.js drops into the page DOM, normalizes into Searchyroll
 * canonical title records, and logs them. All WebExtension API access,
 * if any is needed later, belongs here (not in the MAIN-world script).
 */

"use strict";

const DEBUG = false;
const HIT_ATTR = "data-searchyroll-hidive";
const label = "[Searchyroll Hidive]";
const seen = new Set();
const platformKeyOf = (record) =>
  (record && record.platform ? String(record.platform) : "") + ":" + (record && record.id !== undefined && record.id !== null ? String(record.id) : "");

const readHit = (el) => {
  let raw;
  try {
    raw = el.getAttribute(HIT_ATTR);
  } catch (_e) {
    return null;
  }
  return raw;
};
const tagsFor = (item, key) => {
  const out = [];
  if (Array.isArray(item && item.displayableTags)) {
    for (const t of item.displayableTags) {
      if (t && t.key === key && typeof t.value === "string") {
        out.push(t.value);
      }
    }
  }
  return out;
};
const oneTag = (item, key) => {
  const v = tagsFor(item, key);
  return v.length > 0 ? v[0] : null;
};
const mask = (kind, raw) => {
  if (raw === "--searchyroll-hidive-non200--") {
    if (DEBUG) {
      console.warn(label, "Hidive API call returned a non-200 response; nothing to parse", { kind, href: location.href });
    }
    return true;
  }
  if (raw === "--searchyroll-hidive-related--" || raw === "--searchyroll-hidive-init--") {
    if (DEBUG) {
      console.info(label, "hit captured but body was not the expected shape", { kind, href: location.href });
    }
    return true;
  }
  return false;
};
const persistTitle = (record) => {
  try {
    browser.runtime.sendMessage({ action: "upsertTitle", record }).catch(() => {});
  } catch (_e) {}
};
const handleRecord = (record) => {
  const key = platformKeyOf(record);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  if (DEBUG) {
    console.log(label, record);
  }
  if (typeof enrichRecord === "function") {
    enrichRecord(record).then((enriched) => {
      persistTitle(enriched);
      if (DEBUG) {
        console.log("[Searchyroll Hidive enriched]", enriched);
      }
    }).catch(() => {});
  } else {
    persistTitle(record);
  }
};
const normalizeRelated = (item) => ({
  platform: "hidive",
  id: item.id,
  title: item.title,
  type: item.type,
  url: `https://www.hidive.com/season/${encodeURIComponent(item.id)}`,
  genres: tagsFor(item, "Genres"),
  audioSet: oneTag(item, "AudioSet"),
  subtitleSet: oneTag(item, "SubtitlesSet"),
  originalPremiere: oneTag(item, "Original Premiere"),
  rating: (item.rating && typeof item.rating.rating === "string") ? item.rating.rating : null,
  seasonCount: Number.isFinite(item.seasonCount) ? item.seasonCount : null,
  source: "hidive-related"
});
const normalizeInitItem = (item) => ({
  platform: "hidive",
  id: item.id,
  title: item.title,
  type: item.type,
  url: `https://www.hidive.com/season/${encodeURIComponent(item.id)}`,
  genres: [],
  audioSet: null,
  subtitleSet: null,
  originalPremiere: null,
  rating: null,
  seasonCount: null,
  source: "hidive-init"
});
const consume = (el) => {
  const raw = readHit(el);
  if (!raw) {
    return;
  }
  if (mask("init", raw)) {
    el.removeAttribute(HIT_ATTR);
    return;
  }
  const parsed = (() => {
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  })();
  if (!parsed || !parsed.found) {
    el.removeAttribute(HIT_ATTR);
    return;
  }
  if (parsed.kind === "related") {
    const items = parsed.found.filter((item) => item && item.type === "SERIES");
    for (const item of items) {
      try {
        handleRecord(normalizeRelated(item));
      } catch (_e) {}
    }
  } else if (parsed.kind === "init") {
    for (const bucket of parsed.found) {
      const list = bucket && bucket.contentList;
      if (!Array.isArray(list)) {
        continue;
      }
      const items = list.filter((item) => item && item.type === "PLAYLIST");
      for (const item of items) {
        try {
          handleRecord(normalizeInitItem(item));
        } catch (_e) {}
      }
    }
  }
  el.removeAttribute(HIT_ATTR);
};
const scan = () => {
  const el = document.body || document.documentElement;
  if (el) {
    consume(el);
  }
};
setInterval(scan, 1500);
setTimeout(scan, 0);
new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "attributes" && m.attributeName === HIT_ATTR) {
      consume(m.target);
    }
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: [HIT_ATTR], subtree: true });