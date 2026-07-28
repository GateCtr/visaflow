---
name: Spain persistent-browser mode
description: Implementation details and quirks for SPAIN_SESSION_MODE=persistent-browser; Puppeteer + CapSolver fallback + skipPortalFlow fix.
---

## Architecture

`SpainPersistentBrowserManager.ensureSession()` flow:
1. Launch Puppeteer Chromium with Decodo proxy + `userDataDir=/tmp/spain-cf-profile`
2. Navigate to portal URL — poll 90s for `cf_clearance`
3. If not obtained → CapSolver `AntiCloudflareTask` fallback (inject cookie, re-navigate, poll 15s for post-JSD upgrade)
4. Navigate to `/onlinebookings/main/` in main browser page to get a **fresh PHPSESSID** (critical — without this, the old profile PHPSESSID may be expired and /main/ returns empty body)
5. Extract all cookies → build `SpainCfSession { source: "playwright" }`
6. Call `setActiveSpainCfSession(session)` so `runSpainHttpProbe` finds it

## CF protection asymmetry (confirmed 2026-07-28)

The portal HTML page (`/es/hosteds/widgetdefault/...`) blocks impit with **HTTP 403** even with a valid `cf_clearance`. The JSONP API (`/onlinebookings/main/`) accepts the same clearance (HTTP 200).

This means `scanViaMainEndpoint` can never GET the portal URL reliably via impit for a Playwright session.

## skipPortalFlow fix (spain-http-scanner.ts)

When `isCloudflareInteractiveChallenge(403)` fires AND `session.source === "playwright"` AND `phpSessId` is pre-set:
- Set `skipPortalFlow = true` instead of returning `cf_blocked`
- Skip Steps 1 (portal GET result processing), 2 (POST Continue), 2b (JSD Oneshot)
- `widgetHtml1 = ""` → `jsdOneshotPathMatch` is null → Step 2b block is skipped automatically
- Step 3 (JSONP `/main/`) runs with the pre-set PHPSESSID

**Why:** The browser already navigated `/main/` during `ensureSession()` → PHPSESSID is server-side valid → `/main/` returns content without the portal flow.

**Result:** On the first `/main/` call it may return empty body if the PHPSESSID is stale → session invalidated → retry falls through to CapSolver which does a full portal solve (HTTP 200 + token + POST widget) → probe succeeds.

## Chrome binary

Puppeteer requires Chrome to be installed. If version mismatch:
```
npx puppeteer browsers install chrome
```
Cache path: `/home/runner/.cache/puppeteer`

## Test

```
cd artifacts/slot-hunter && node_modules/.bin/tsx test-spain-persistent-browser.ts
```
Expected: all 5 steps ✅. Step 5 takes ~20s on retry path (CapSolver solve).
