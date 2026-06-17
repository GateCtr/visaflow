---
name: CEV One-Shot (Predator) strategy
description: Dossier loop v4 design decisions — why the 5-click/h limit was removed and how session reuse works.
---

## Rule
The CEV server no longer enforces the 5-clicks/hour-per-dossier limit.
Use the **One-Shot (Predator)** strategy: wake every ~2 min, click once per dossier (round-robin), sleep, repeat.

## Key decisions

### Session reuse
`setupCevSessionHttp` → `getVowintSession` already checks `vowintSessionCache` (Redis-backed, 4h TTL in `cevHttpSetup.ts` line 113 `VOWINT_SESSION_MAX_AGE_MS`).
- Cache hit → reuse cookies, skip re-login/captcha → direct click
- Cache miss → full login + captcha + click
No new session-alive logic needed in the loop.

### Pool
`CevDossierPool.getNextAvailable()` is now **pure round-robin** — skips only paused dossiers (those where a slot was already found and booking is in progress). No quota counter checked.

### Removed from dossier loop
- `MAX_CLICKS_PER_SESSION = 5` — removed
- `MAX_CLICKS_PER_DOSSIER_PER_HOUR = 5` — removed
- `globalSessionClicks` counter and preventive re-login — removed
- F5 cookie capture / full-session Puppeteer capture block — removed
- `siphonedCreds` management in main loop — removed (pass `undefined` to `performScan`)
- Dynamic interval formula (`3600 / (N × 5) / 0.8`) — removed

### Kept
- `pausedDossiers` set — dossier paused after slot found (still needed)
- `logNormalJitter` on sleep (anti-shadow-ban)
- `invalidateVowintCache` on error/rate-limit
- `performScan` full-session shortcut path (dead code in One-Shot but harmless)
- `recordClick` on pool slots (stats only, no quota enforcement)

### Interval
`DEFAULT_INTERVAL_SEC = 120` (2 min). Configurable via `cevScanIntervalSec` job config.
Sleep = `max(60s, intervalMs ± logNormalJitter(20s, σ=0.35))`.

**Why:** User confirmed server no longer blocks at 5 clicks/h; new cadence is 1 click every 2-3 min per dossier pool. Simpler loop = fewer bugs, easier to reason about.
