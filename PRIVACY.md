# Privacy Policy — Searchyroll

*Last updated: September 1, 2026*

---

## Overview

Searchyroll is a browser extension that adds advanced search across Crunchyroll and Hidive. This policy explains what data the extension processes, how it is stored, and what leaves your browser.

---

## What stays in your browser

### Catalog index

As you browse Crunchyroll and Hidive, the extension captures metadata from your authenticated sessions — the same data the platform frontends request from their own internal APIs. This data is:

- Stored in your browser's local IndexedDB storage
- Never transmitted to any external server
- Yours — it reflects your own lawful access to the platforms you subscribe to

This is functionally the same as your browser caching a webpage you visited. The extension simply organizes that cache into a searchable index.

### AniList enrichment

To enrich titles with genres, tags, and other metadata, the extension queries the [AniList public GraphQL API](https://docs.anilist.co/). These requests:

- Contain only anime title names or AniList IDs — no personal information
- Are made directly from your browser to AniList's servers
- Are subject to [AniList's own privacy policy](https://anilist.co/terms)

### Catalog artifact download

On first install, the extension downloads a versioned catalog file from this repository's GitHub releases. This is a static file download — no personal data is sent to GitHub beyond what a normal file download entails (your IP address as part of network routing). GitHub's privacy policy governs that interaction.

---

## What is never collected

- Your identity or any personally identifiable information
- Your Crunchyroll or Hidive account credentials or account details
- Your watch history or viewing habits
- Your location
- Any data that could identify you as an individual

---

## External network requests

The extension makes the following external requests:

| Destination | Purpose | Contains personal data? |
|---|---|---|
| `graphql.anilist.co` | Genre/tag enrichment | No — title names and IDs only |
| GitHub releases | Catalog artifact download | No — static file download |
| Delta update endpoint (TBD) | New title deltas | No — version check only |
| MAL API v2 (optional, future) | Supplemental scores | Only if you opt in and authenticate |

---

## Your choices

- **No account required** — there is no registration, login, or user profile in Searchyroll itself
- **Uninstalling the extension** removes all locally stored index data and stops all network activity
- The local catalog index can be cleared at any time from the extension settings

---

## Changes to this policy

If this policy changes materially, the updated version will be committed to this repository with an updated date.

---

## Contact

Questions about this privacy policy can be directed to the GitHub repository:

[https://github.com/Denali1/searchyroll](https://github.com/Denali1/searchyroll)
