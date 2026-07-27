---
name: Spain persistent-browser mode
description: Puppeteer persistent Chromium profile for Spain CF session — architecture, activation, and integration points.
---

# Spain persistent-browser mode

## Rule
When `SPAIN_SESSION_MODE=persistent-browser` is set, the Spain watcher uses a long-lived Chromium process (Puppeteer + StealthPlugin) with `userDataDir` instead of CapSolver to obtain `cf_clearance`. Scanning itself remains HTTP-only (impit).

**Why:** Persistent profile keeps CF cookies + localStorage + cache → CF sees a returning user, not a bot fingerprint mismatch. No CapSolver cost for CF solve.

**How to apply:** Set env var `SPAIN_SESSION_MODE=persistent-browser`. Optionally set `SPAIN_CF_PROFILE_DIR` (default `/tmp/spain-cf-profile`). Requires `DECODO_PROXY_URL` or `SOAX_PROXY_URL`.

## Key files
- `artifacts/slot-hunter/src/spain-persistent-browser.ts` — new module: `SpainPersistentBrowserManager` class, singleton `spainPersistentBrowser`, exports `ensureSpainPersistentBrowserSession`, `isSpainPersistentBrowserSessionExpiringSoon`, `getActiveSpainPersistentBrowserSession`, `createSpainPersistentBrowserDossierSession`.
- `artifacts/slot-hunter/src/loops/spain-watcher-loop.ts` — added `SPAIN_PERSISTENT_BROWSER` constant, three wrapper functions (`isActiveSessionExpiringSoon`, `ensureActiveSession`, `getActiveSession`), mode branches throughout.

## Per-dossier isolation
`createSpainPersistentBrowserDossierSession(cfSession, portalUrl)` uses `browser.createIncognitoBrowserContext()` — isolated cookie store per dossier — navigates to `/main/` to get a fresh PHPSESSID, then closes the incognito context. The booking flow (impit HTTP) reuses the returned session.

## Session persistence
CF session is persisted to Redis via `syncSpainCfSessionToRedis` after each successful solve, exactly like the existing HTTP mode.
