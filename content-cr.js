/*
 * content-cr.js
 *
 * Runs in the ISOLATED world on Crunchyroll (see manifest.json). Listens for
 * the hit records that content-cr-main.js drops into the page DOM, normalizes
 * each into the Searchyroll canonical title record, and logs it.
 */

"use strict";

const HIT_ATTR = "data-searchyroll-cr";
const label = "[Searchyroll CR]";
const seriesUrl = (id, slug) => `https://www.crunchyroll.com/series/${encodeURIComponent(id)}/${encodeURIComponent(slug)}`;
const readHitAttr = (el) => {
  let raw;
  try {
    raw = el.getAttribute(HIT_ATTR);
  } catch (_e) {
    return null;
  }
  if (raw === "--searchyroll-cr-interception--") {
    return { mark: true };
  }
  if (!raw) {
    return null;
  }
  try {
    return { data: JSON.parse(raw) };
  } catch (_e) {
    return null;
  }
};
const normalizeCr = (item) => {
  const sm = item.series_metadata || {};
  return {
    platform: "crunchyroll",
    id: item.id,
    title: item.title,
    slug: item.slug_title,
    type: item.type,
    url: seriesUrl(item.id, item.slug_title),
    genres: Array.isArray(sm.tenant_categories) ? sm.tenant_categories : [],
    isSubbed: !!sm.is_subbed,
    isDubbed: !!sm.is_dubbed,
    isSimulcast: !!sm.is_simulcast,
    episodeCount: Number.isFinite(sm.episode_count) ? sm.episode_count : null,
    seasonCount: Number.isFinite(sm.season_count) ? sm.season_count : null,
    launchYear: Number.isFinite(sm.series_launch_year) ? sm.series_launch_year : null,
    audioLocales: Array.isArray(sm.audio_locales) ? sm.audio_locales : [],
    subtitleLocales: Array.isArray(sm.subtitle_locales) ? sm.subtitle_locales : [],
    availabilityStatus: sm.availability_status || null,
    dateUpdated: sm.date_updated || null,
    source: "cr-api"
  };
};
const consumeHit = (el) => {
  const hit = readHitAttr(el);
  if (hit === null) {
    return;
  }
  if (hit.mark) {
    console.warn(label, "intercepted a /content/v2/cms/objects hit without a parseable data[] body", { href: location.href });
    el.removeAttribute(HIT_ATTR);
    return;
  }
  const items = hit.data;
  for (const item of items) {
    try {
      console.log(label, normalizeCr(item));
    } catch (_e) {}
  }
  el.removeAttribute(HIT_ATTR);
};
const scan = () => {
  const el = document.body || document.documentElement;
  if (el && el.hasAttribute(HIT_ATTR)) {
    consumeHit(el);
  }
};
setInterval(scan, 1500);
setTimeout(scan, 0);
new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "attributes" && m.attributeName === HIT_ATTR) {
      consumeHit(m.target);
    }
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: [HIT_ATTR], subtree: true });