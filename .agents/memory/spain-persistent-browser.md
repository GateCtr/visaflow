---
name: Spain persistent-browser mode
description: CF/impit asymmetry, session rules, cf_clearance deletion fix, Chromium path, full install + Saopola e2e test confirmed 2026-07-30.
---

# Spain persistent-browser mode

## Rule: NEVER delete cf_clearance before clicking Continuar

**Why:** CF ≥ 2026-07 fires a spontaneous JSD oneshot immediately when cf_clearance is deleted (even before Continuar is clicked). This JSD gives a "cookie fantôme" (CF validates the session without re-emitting cf_clearance). When the widget's JS then calls `/main/` via XHR, cf_clearance is absent from the browser cookies → CF returns 200 text/html 0B silently.

The old deletion logic was intended to force a fresh cf_clearance via the POST Continuar JSD, but CF now fires JSD spontaneously on deletion instead of after POST.

**Fix applied:** Removed the `cfClearedBeforeClick` deletion block (lines ~1339-1351 pre-fix). The cf_clearance obtained during the initial JSD navigation is already fresh and valid — no need to delete it.

**How to apply:** Do NOT add back any `page.deleteCookie({ name: "cf_clearance" })` call between the JSD solve and the Continuar click. If `/main/` returns 0B again, check if cf_clearance is present in the browser at the moment the widget calls it.

## Rule: /main/ MUST go through Chrome (not impit)

CF validates `/main/` based on the TLS fingerprint + cf_clearance combination. impit cannot replicate this — only Chrome's actual XHR/fetch triggers CF acceptance. The scan captures `/main/` via CDP Network.loadingFinished (listening to the XHR the widget JS makes naturally after Continuar is clicked).

**Why impit fails for /main/:** CF ties the cf_clearance to the Chrome TLS fingerprint established during the JSD solve. impit has a different TLS fingerprint → CF returns 0B even with a valid cf_clearance cookie.

## CF JSD flow (2026-07+)

1. Chrome navigates to citaconsular.es → CF challenge
2. JSD natif runs → cf_clearance emitted (fresh, tied to our Chromium TLS)
3. Click Continuar (cf_clearance still present — do NOT delete it)
4. POST Continuar → CF may fire JSD oneshot spontaneously (cookie fantôme or real re-emission)
5. Widget JS calls /main/ as XHR — CDP captures via Network.loadingFinished
6. cf_clearance is present → CF returns JSONP content

## Interceptor behavior

- If no spontaneous JSD before Continuar: Fetch interceptor armed, waits for JSD POST (8s timeout). On timeout, cf_clearance is still in browser → /main/ returns content after release.
- If JSD fired before Continuar (jsdOneShotAt > 0): interceptor NOT armed, /main/ captured freely via Network.loadingFinished.

## Chromium path

After `playwright install chromium`:
```
/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
```
Reinstall if cache purged: `cd artifacts/slot-hunter && node_modules/.bin/playwright install chromium`

## Saopola e2e test (confirmed working 2026-07-30)

```bash
redis-server --daemonize yes --logfile /tmp/redis.log
cd artifacts/slot-hunter && node_modules/.bin/tsx src/test-saopola-live.ts
```

Expected: `✅ Scan: found` + `✅ Booking: signin_failed` (wrong credentials rejected = success).
Typical timing: Scan ~52s, Booking ~60s.
