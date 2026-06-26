---
name: CEV Extension v4.0 architecture
description: Round-robin multi-dossier, server-error backoff, anti-detection, page detection — design decisions worth preserving.
---

## Version
4.0.0 — implemented 2026-06-26

## Round-Robin dossier pool

- `state.dossierPool = [{ appId, ref, label }]` — live in background.js state, persisted to storage.
- `state.rrIndex` — monotonically incremented, taken mod pool length.
- `pickNextDossier()` — if `state.applicationId` (fixed target): search pool by ref/appId, return null if not in pool yet (content script will match by vowintRef). If no fixed target: pure round-robin.
- Pool updated on every `CLICK_RDV_BUTTON` response (`fetchResp.dossiers`) AND on `LIST_DOSSIERS` probe before first scan.
- content-vowint.js also probes and sends `VOWINT_PAGE_TYPE` with `dossiers[]` on page load.

## selectDossier() strict mode (content-vowint.js)

- If `targetAppId` or `vowintRef` is explicitly provided but NOT found → returns `{ __notFound: true, ... }` sentinel.
- Caller in CLICK_RDV_BUTTON handler checks sentinel and returns `ok: false` with descriptive error.
- This prevents silently scanning the wrong dossier when a fixed target is configured.
- Only falls back to `dossiers[0]` when NO constraint is given (pure round-robin mode).

## Server-error backoff (critical fix)

- `SERVER_ERROR` handler stores `state.serverPauseUntil = Date.now() + pauseMs`.
- `runLoop()` checks at the TOP of each iteration: if `serverPauseUntil > now`, blocks via `countdownWait(rem)`.
- Old approach (detached `sleep(...).then(...)`) was a no-op because it didn't block the loop.
- `serverPauseUntil` is reset by RESET handler and cleared when the countdown expires.

**Why:** Detached async sleep in a message handler does not pause the event loop. The loop continued immediately, bypassing 5/10/20 min server-error pauses.

## Human-like delay between scans

- Base: 60,000ms (1 min).
- Jitter: Box-Muller → log-normal(μ=0.4, σ=0.55) × 18,000ms, capped at 90,000ms.
- Effective range: 1:00 → ~2:30, concentrated at ~1:08.
- No more `MAX_CLICKS_PER_HOUR` hard cap — replaced by organic round-robin + interval.

## Anti-detection headers (extension)

- `Priority: u=1, i` added to ALL XHR fetch calls in content-vowint.js and content-cev.js.
- `Cache-Control: max-age=0` + `If-Modified-Since: 0` on `GetEAppointmentUrl` (AngularJS $http pattern, Burp confirmed).
- `Referer` set to the actual VOWINT applications page URL (with detected lang).

## Page detection (content-vowint.js)

- `detectVowintPageType()` classifies: `login | applications | authenticated | unknown`.
- On `applications` page: auto-extracts dossiers, waits up to 8s for AngularJS render.
- Sends `VOWINT_PAGE_TYPE { pageType, dossiers, url }` to background on every page load.
- background.js updates pool from `dossiers[]` in this message (passive, no scan triggered).

## Popup v4

- `dossierSection` shows pool with round-robin indicator (▶ current, ○ next, · others).
- `statDossiers` 4th stat box (was 3 columns → now 4).
- `SET_APPLICATION_ID` message syncs fixed-target changes from popup without restart.
- Init retries `GET_STATE` 3× (500ms gap) to handle slow SW wake.
