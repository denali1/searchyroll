# Searchyroll — Roadmap

> Local planning doc — agent reference.

---

## Phase 0 — Repo scaffold and documentation ← CURRENT

- [x] README.md
- [x] CONTRIBUTING.md
- [x] ROADMAP.md
- [x] AGENTS.md
- [x] PRIVACY.md
- [x] LICENSE (MIT)
- [ ] manifest.json stub
- [ ] .gitignore
- [ ] Initial commit to GitHub

---

## Phase 1 — Extension scaffold

- [ ] Manifest V3 structure (Firefox + Chrome compatible)
- [ ] Service worker stub (`background.js`)
- [ ] Content script stubs (`content-cr.js`, `content-hidive.js`)
- [ ] Popup stub (`popup.html`, `popup.js`)
- [ ] Icon assets (placeholder)
- [ ] `browser.*` namespace throughout — no `chrome.*`-specific code

---

## Phase 2 — API interception

**Crunchyroll:**
- [ ] Identify internal browse/catalog API endpoints via DevTools
- [ ] Service worker fetch interceptor for CR API calls
- [ ] Parser for CR API response shape → normalized title record
- [ ] Graceful handling of API shape changes

**Hidive:**
- [ ] Identify internal browse/catalog API endpoints via DevTools
- [ ] Service worker fetch interceptor for Hidive API calls
- [ ] Parser for Hidive API response shape → normalized title record
- [ ] Graceful handling of API shape changes

**Shared:**
- [ ] Normalized title record schema (title, platform, slug, dub/sub flags, etc.)

---

## Phase 3 — AniList enrichment

- [ ] AniList GraphQL client (no auth — public read only)
- [ ] Title match query (search by name + year)
- [ ] Extract: genres, tags, studio, airing status, episode count
- [ ] Extract: `externalLinks` → resolve CR and Hidive watch page URLs
- [ ] Rate limit compliance (90 req/min — per-user browser context, not server)
- [ ] Fuzzy match fallback for title name discrepancies

---

## Phase 4 — Local index

- [ ] IndexedDB schema design
- [ ] Write pipeline: intercepted record + AniList enrichment → IndexedDB
- [ ] Query layer: multi-filter search (genre, dub/sub, status, studio, episode count, platform)
- [ ] Cold-start detection — trigger catalog bootstrap download on first install

---

## Phase 5 — Injected search UI

- [ ] Search overlay component (injected into CR and Hidive pages)
- [ ] Filter controls: genre (multi-select), dub/sub, completion status, platform, studio
- [ ] Results display: title card, platform badge(s), direct watch link
- [ ] Keyboard navigation
- [ ] Styling that respects each platform's dark/light theme

---

## Phase 6 — GitHub catalog artifact

- [ ] Script to build versioned catalog JSON from AniList bulk query
- [ ] Compressed JSON format (gzip)
- [ ] GitHub Actions workflow: rebuild catalog on schedule, publish as release artifact
- [ ] Extension bootstrap: download catalog artifact on first install
- [ ] Version check: compare local catalog version against latest release on startup

**Legal note:** catalog artifact contains AniList-derived data only. No CR or Hidive proprietary data is included. CR/Hidive data remains local to each user's browser.

---

## Phase 7 — Delta update layer

- [ ] Evaluate: Neon DB vs. Cloudflare Worker + KV for delta storage
- [ ] Delta record schema: new titles, updated metadata, deprecated slugs
- [ ] Extension delta check on schedule (weekly or on browser start)
- [ ] Merge deltas into local IndexedDB without full catalog rebuild

---

## Phase 8 — MAL API v2 integration

- [ ] MAL API v2 OAuth client (for optional user-authenticated features)
- [ ] Supplemental metadata pull: MAL score, rank, popularity
- [ ] Cross-reference MAL ID ↔ AniList ID for deduplication
- [ ] Surface MAL score in search results (optional display)

---

## Phase 9 — Polish and store submission

- [ ] Welcome page (first install)
- [ ] Settings page (update frequency, display preferences)
- [ ] AMO submission (Firefox)
- [ ] Chrome Web Store submission
- [ ] README: installation instructions, store badges

---

## Ongoing backlog

- Hidive-exclusive filter ("show me titles not on CR")
- CR-exclusive filter ("show me titles not on Hidive")
- "Available on both" filter
- Seasonal browse view (currently airing simulcasts)
- User watchlist integration (mark as watched, want to watch)
- Shareable search URL

---

## Infrastructure

- Extension repo: Denali1/searchyroll
- Neon org: org-nameless-fog-47633986 (Shadowforge Heavy Industries)
- Catalog artifact: GitHub releases on this repo
- Delta endpoint: TBD (Neon or Cloudflare Worker)
