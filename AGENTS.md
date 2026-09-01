# Guardrails

1. No deleting files without explicit, direct permission — implied permission is not sufficient.

2. Every session is narrow and deep — one function, one concern, full attention. No scope creep.

3. Every session ends with ALL of the following — no exceptions, no partial compliance:
   - `.opencode/session-log.md` — append a session entry: decisions made, rationale, what was ruled out, assumptions baked into the code, the last file/line worked on, and a sitrep for the next session
   - `AGENTS.md` — update roadmap phase status if any phase was completed or advanced this session
   - All modified and new files committed to git before session close — no dirty working tree, no untracked project files left behind
   - Commit hash reported to Denali before session close — not optional. Format: "Commit hash: [hash]". No hash, session is not closed.

4. No refactoring during a build session — flag it in the changelog and schedule it as its own dedicated session. Exception: a minor fix required to unblock the current task may be folded in without a separate scout/go-ahead cycle, provided it does not require rewriting an entire file. Log it explicitly as a scope exception rather than folding it in silently.

5. Scout discipline — scout pass is required before implementation regardless of confidence level. Scout findings MUST be reported to Denali and explicit go-ahead received before any implementation begins. Scouting and then acting before the report lands is a guardrail violation. Explicit go-ahead must be stated separately and explicitly, even when it immediately follows question answers in the same message or turn.

---

## Current Roadmap Phase Status

- [ ] Phase 0 — Repo scaffold and documentation
- [ ] Phase 1 — Extension scaffold (Manifest V3, content scripts, service worker)
- [ ] Phase 2 — API interception (Crunchyroll + Hidive network request capture)
- [ ] Phase 3 — AniList enrichment (GraphQL metadata + externalLinks URL resolution)
- [ ] Phase 4 — Local index (IndexedDB catalog build and query layer)
- [ ] Phase 5 — Injected search UI (in-page search overlay on CR and Hidive)
- [ ] Phase 6 — GitHub catalog artifact (versioned JSON/SQLite export for cold-start seeding)
- [ ] Phase 7 — Delta update layer (Neon DB or Cloudflare Worker for new title deltas)
- [ ] Phase 8 — MAL API v2 integration (supplemental metadata and scores)
- [ ] Phase 9 — Polish and store submission
