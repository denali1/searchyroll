# Contributing to Searchyroll

## The most common contribution: AniList tag and genre mapping corrections

AniList's tag taxonomy is deep and occasionally inconsistent. When a tag maps poorly to what users expect, or a genre is miscategorized in the local index, it can be fixed without a new extension release by updating the catalog artifact in this repo.

### How the catalog update system works

The extension downloads a versioned catalog artifact (JSON) from this repo's releases on install and checks for updates on a configurable schedule. Every installed copy updates automatically — no reinstall, no new release needed. This is the same pattern used by uBlock Origin's filter lists.

If the remote fetch fails for any reason (network down, malformed JSON, GitHub outage), the extension silently falls back to the locally cached catalog.

### Fixing a bad genre or tag mapping

1. Identify the title and the incorrect mapping
2. Verify the correct genre/tag via [AniList's GraphQL explorer](https://anilist.co/graphiql)
3. Open a pull request with the correction and a note on how you verified it

---

## Platform selector updates

Crunchyroll and Hidive occasionally change their internal API response shapes or frontend DOM structure without notice. When this happens, the extension's interception layer may stop capturing metadata correctly.

### Diagnosing a broken interception

1. Open DevTools Network tab on a CR or Hidive browse page
2. Filter for XHR/Fetch requests
3. Identify the API calls the frontend is making for catalog data
4. Compare the response shape against what the extension's parser expects

### Submitting a fix

Open a pull request with:
- Which platform broke (CR or Hidive)
- What changed in the API response shape
- Your updated parser logic
- How you tested it

---

## Other contributions

### New filter types

The filter set is intentionally limited in v1.x to what AniList reliably provides. If you want to propose a new filter dimension, open an issue first with:
- What the filter would be
- What data source provides it reliably
- Whether it requires new API calls or is derivable from existing data

### MAL API v2 integration

MAL v2 provides supplemental metadata and community scores. If you want to work on this integration, see the roadmap in `ROADMAP.md` for the planned approach and open an issue to coordinate before starting.

### Chrome / Firefox compatibility

The extension targets a single Manifest V3 codebase using the `browser.*` WebExtensions API throughout — no `chrome.*`-specific code, no polyfill needed. If you hit a browser-specific bug, open an issue with your browser version and a description of the failure.

---

## Code style

- Vanilla JS only — no build step, no bundler, no frameworks
- `"use strict"` in every file
- Comments explain *why*, not *what*
- Catalog data and selector patterns are data, not code — keep them in config files, not scattered through source
- No GPL-licensed dependencies — MIT, Apache 2.0, or BSD only
