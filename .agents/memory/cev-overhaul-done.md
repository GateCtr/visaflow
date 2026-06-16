---
name: CEV anti-shadow-ban overhaul
description: Files created/modified for the full Puppeteer session flow — what was done, what activates it, what remains.
---

## What was implemented

### New files
- `artifacts/slot-hunter/src/cev-hcaptcha.ts` — Anti-Captcha solver (HCaptchaTask with proxy OR HCaptchaTaskProxyless). CapSolver blacklisted for CEV sitekeys since 2026-04 — use ANTI_CAPTCHA_API_KEY only.
- `artifacts/slot-hunter/src/cev-session-manager.ts` — Session cache (TTL=4h, shadow ban threshold=15 consecutive no-slots per account).

### Modified files
- `artifacts/slot-hunter/src/loops/cev-dossier-loop.ts`:
  - `applyStealthToPage()` — 6 stealth fixes: viewport 1920×1080, UA Chrome 149, navigator.webdriver, plugins, WebGL, Chrome runtime, request interception for HeadlessChrome→sec-ch-ua.
  - `captureF5CookieForAccount()` — now uses full stealth.
  - `captureFullSessionForAccount()` — NEW: full Puppeteer flow (login→IndexByUserId→GetEAppointmentUrl→Integration/VOW→/Captcha→hCaptcha→SetCaptchaToken→cookies).
  - `performScan()` — shortcut when `siphonedCreds.isFullSession=true` → poll direct, no HTTP setup.
  - `runAccountLoop()` — reads `cev_full_puppeteer_mode` botConfig; calls captureFullSessionForAccount when=1; `no_slot_poll` case (no click consumed); log-normal scan interval jitter.
- `artifacts/slot-hunter/src/cev-shared-impit.ts`:
  - Removed `ignoreTlsErrors: true` from both impit instances (was leaking TLS deviation).
  - Jitter: `Math.random()` → log-normal Box-Muller (centred 80ms, range 20-400ms).
- `artifacts/slot-hunter/src/cevHttpSetup.ts`:
  - VOWINT_SESSION_MAX_AGE_MS: 24h → 4h.

## How to activate

In Convex bot-config, set:
```
cev_full_puppeteer_mode = "1"
```

When enabled, `captureFullSessionForAccount()` runs every 4h per account and consumes 1 GetEAppointmentUrl click (vs 5/h in legacy). Polls are unlimited (no VOWINT clicks consumed). Shadow ban auto-detected at 15 consecutive no-slots.

**Why:** The root cause of shadow bans is the behavioral discontinuity between Puppeteer (only homepage) and impit HTTP (login+captcha). The new flow keeps everything in the same Puppeteer browser session, matching the fingerprint a real user would produce.

## Detection vectors addressed (13/15)

1. ✅ HeadlessChrome in sec-ch-ua (request interception)
2. ✅ navigator.webdriver (evaluateOnNewDocument)
3. ✅ Missing plugins (evaluateOnNewDocument)
4. ✅ WebGL renderer SwiftShader (evaluateOnNewDocument)
5. ✅ Chrome runtime absent (evaluateOnNewDocument)
6. ✅ Viewport 800×600 (setViewport 1920×1080)
7. ✅ ServerId/OSOnline/OSIframeGuid cookies missing (FullCevSession captures all)
8. ✅ Jitter uniform Math.random() → log-normal
9. ✅ hCaptcha solved without proxy (proxy params passed to Anti-Captcha)
10. ✅ ignoreTlsErrors TLS deviation (removed)
11. ✅ Session TTL too long (4h)
12. ✅ Shadow ban detection (15 no-slots threshold)
13. ✅ Captcha retry resilience (preserved from existing code)
14. ✅ LogRenderingClientTime telemetry absent — added in 2 places: `cevHttpSetup.ts` (fire-and-forget via cevImpitFetch after login) + `captureFullSessionForAccount()` (page.evaluate for headless safety)

Remaining:
- SOAX per-account rotation offset (partially handled by existing rotation logic)
