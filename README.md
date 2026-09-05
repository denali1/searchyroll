# Searchyroll

A Firefox and Chrome extension that adds a unified, advanced search layer across Crunchyroll and Hidive — the two dominant legal anime streaming platforms, each with titles the other doesn't carry.

![Platforms: Crunchyroll + Hidive](https://img.shields.io/badge/platforms-Crunchyroll%20%26%20Hidive-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Firefox + Chrome](https://img.shields.io/badge/browser-Firefox%20%26%20Chrome-blue)

> **⚠️ IMPORTANT:** Searchyroll is an independent, open-source project. It is not affiliated with, endorsed by, or approved by Crunchyroll, Sony, Hidive, or AMC Global Media. Use of this extension may technically conflict with the Terms of Service of Crunchyroll and/or Hidive. While no users have been known to face account action for using browser extensions on these platforms, we cannot guarantee this will never occur. BY INSTALLING THIS EXTENSION, YOU ACCEPT FULL RESPONSIBILITY FOR ANY CONSEQUENCES TO YOUR ACCOUNTS. USE AT YOUR OWN RISK.

---

## The problem

Both Crunchyroll and Hidive have weak native search. You can't filter by genre combinations, dub/sub availability, completion status, studio, or episode count. You can't search across both platforms at once. If a title is exclusive to one platform, you have to already know it exists to find it.

## What Searchyroll does

- **Unified cross-platform search** — query Crunchyroll and Hidive simultaneously in one interface
- **Deep genre and tag filtering** — powered by AniList's tag taxonomy, far richer than either platform's native categories
- **Multi-filter combinations** — AND logic across genre + dub/sub + completion status + studio + episode count
- **Platform availability inline** — every result shows which platform(s) carry it and links directly to the watch page
- **Injected UI** — the search interface lives inside the CR and Hidive pages you're already on

---

## How it works

### Data pipeline

1. **API interception** — the extension watches network requests the CR and Hidive frontends make to their own internal APIs, capturing catalog metadata as the user browses. This data stays local to the user's browser.

2. **AniList enrichment** — each title is cross-referenced against the [AniList GraphQL API](https://docs.anilist.co/) to pull genres, tags, studio, airing status, episode count, and streaming platform URLs (via `externalLinks`). AniList data is redistributable under its terms.

3. **Local index** — enriched metadata is stored in IndexedDB, giving the extension a queryable local catalog that works without network access.

4. **Bootstrapped catalog** — a versioned catalog artifact (JSON/SQLite) is distributed via this repo's releases, giving new installs a full starting index without needing to browse first.

5. **Delta updates** — new titles and corrections flow through a lightweight update endpoint, keeping the catalog current without requiring a full download.

### Why the CR/Hidive data stays local

Crunchyroll and Hidive's catalog data is proprietary. Distributing a centrally-scraped copy of it would create legal exposure. The extension captures data from each user's own authenticated session — the user already has lawful access to this information. AniList metadata has no such restriction.

---

## Data sources

| Source | What it provides | License / terms |
|---|---|---|
| Crunchyroll internal API | Catalog availability, dub/sub, regional access | User's own session — stays local |
| Hidive internal API | Catalog availability, dub/sub, regional access | User's own session — stays local |
| [AniList GraphQL API](https://anilist.co) | Genres, tags, studio, airing status, episode count, streaming URLs | Permissive read access, no auth required |
| [MAL API v2](https://myanimelist.net/apiconfig/references/api/v2) | Supplemental metadata, community scores | Free tier, OAuth for user data |

---

## Installation

*Not yet available in browser stores — under active development.*

### Developer install

```bash
git clone https://github.com/Denali1/searchyroll.git
```

**Firefox:** `about:debugging` → Load Temporary Add-on → select `manifest.json`

**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select the cloned folder

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Privacy

All catalog indexing runs locally in your browser. No browsing history, watch history, or personal data is transmitted anywhere. See [PRIVACY.md](PRIVACY.md) for full details.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Support a Good Cause

Searchyroll is free and always will be. If you'd like to give something back, please consider donating to one of these organizations that matter to the people who built this:

- **[Dolly Parton's Imagination Library](https://imaginationlibrary.com)** — puts free books in the hands of children from birth to age five, no matter where they live or their family's income.
- **[Lou Ruvo Center for Brain Health — Cleveland Clinic](https://my.clevelandclinic.org/departments/neurological/depts/lou-ruvo-center-for-brain-health)** — research and care for patients with brain diseases including Alzheimer's, Huntington's, and Parkinson's. A cause that means something personal to us: **Tim Curry**, who lit up our childhoods, survived a massive 2012 stroke and spent the rest of his years — until his passing in August 2026 — navigating brain-disease recovery with the same wit he always had on screen.
- **[Wounded Warrior Project](https://www.woundedwarriorproject.org)** — programs and services for post-9/11 veterans and their families. This one's for **Peter Cullen**: the voice of Optimus Prime, a hero who was modeled on the strength and gentleness of his own Marine veteran brother — a piece of our childhoods born from the veteran community.
