"use strict";

browser.runtime.sendMessage({ action: 'getAllTitles' }).then((res) => {
  if (!res || !res.ok) {
    console.warn('[Searchyroll] getAllTitles failed:', res && res.error);
    return;
  }
  const records = res.records;
  console.log('[Searchyroll] Catalog record count:', records.length);
  console.table(records);
}).catch(err => {
  console.warn('[Searchyroll] getAllTitles failed:', err);
});