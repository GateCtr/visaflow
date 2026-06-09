---
name: CEV bot detection audit
description: Complete analysis of real Chrome 148 traffic dumps (2026-06-08) vs. bot implementation — what's safe, what was fixed, what remains.
---

## Dumps analysed
- `2026-06-08T12-01-52-01_initial.json` — 96 VOWINT requests (Chrome 148 Playwright, full cookies/timing)
- `2026-06-08T17-14-59-targets.json` — 20 real CEV requests (complete flow, captcha solved → NoAvailability)
- `_playwright_recording.har` — Playwright HAR for replay reference

## Ground-truth CEV flow (17-14-59, confirmed working)
1. `GET GetEAppointmentUrl` → JSON `{"url":"https://appointment.cloud.diplomatie.be/Integration/VOW/..."}`
2. `GET Integration/VOW/...` → cookies=[] → 302 `/Captcha` + `ASP.NET_SessionId` set
3. `GET /Captcha` → 200 hCaptcha page (cookies: ASP.NET_SessionId + PreferredCulture)
4. `POST /Captcha/SetCaptchaToken` → 200 `{captchaSolved:true, redirectUrl:...}` — **NO Referer**
5. `GET redirectUrl (Integration/VOW/...)` → 302 `/Integration/VOW/SelectSlot` — **NO Referer**, sec-fetch-site=same-origin
6. `GET /Integration/VOW/SelectSlot` → 302 `/Integration/Error/NoAvailability` — same navigate headers
7. `GET /Integration/Error/NoAvailability` → 200 (no slots — NOT an error)

## Confirmed SAFE (matches real traffic exactly)
- Header order for document GET: Accept → AE → AL → Sec-Fetch-Dest → Sec-Fetch-Mode → Sec-Fetch-Site → Sec-Fetch-User → Upgrade-Insecure-Requests → User-Agent → sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform → [Cookie]
- Header order for AJAX/XHR (cors): Accept → AE → AL → [Content-Type] → [Cookie] → [Referer] → [Origin] → Sec-Fetch-Dest → Sec-Fetch-Mode → Sec-Fetch-Site → [Sec-Fetch-Storage-Access] → User-Agent → [X-Requested-With] → sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform
- `Sec-Fetch-Storage-Access: active` present only on cross-site sub-resources ✓
- `Sec-Fetch-Site: same-site` on VOWINT → CEV integration URL hop (first Integration/VOW GET) ✓
- Cookie domain isolation: `fullCevCookie` contains only CEV cookies, not VOWINT cookies ✓
- `TS0110ceb4` F5 WAF cookie captured via redirect:"manual" loop ✓
- `isFormPost=true` on login POST ✓
- `"Google Chrome";v="148"` brand present in Chrome 148 entries ✓
- No `Connection` header sent (impit uses HTTP/2 properly) ✓
- `getCevBrowserHeaders` document mode already includes `Sec-Fetch-User: ?1` + `Upgrade-Insecure-Requests: 1` ✓
- SetCaptchaToken first call: `Accept: "*/*"` is default for XHR mode ✓
- `mergeCookies` accumulates all Set-Cookie including OSOnline ✓
- `OSOnline` (OutSystems JWT) + `ServerId` cookies captured during login redirect chain ✓

## Fixes applied (session 2026-06-08)
- **FIX 1**: `GetEAppointmentUrl` Accept header: `"application/json, text/html, */*"` → `"application/json, text/plain, */*"` (AngularJS `$http` default)
- **FIX 2**: `GetEAppointmentUrl` missing headers: added `"Cache-Control": "max-age=0"` + `"If-Modified-Since": "0"` (AngularJS anti-304-cache headers, confirmed in real capture)
- **FIX 3**: SetCaptchaToken retry in `cevHttpSetup.ts`: removed erroneous `referer: ${CEV_BASE}/Captcha` (real capture has NO Referer on SetCaptchaToken)
- **FIX 4**: Redirect chain post-captcha: removed `currentReferer` variable, now uses `fetchSite: "same-origin"` explicit without Referer (real capture: none of Integration/VOW / SelectSlot / NoAvailability navigate requests have a Referer header)
- **FIX A-F** (`cevPolling.ts`): ALL 4 polling functions (`fetchManual`, `pollViaApi`, `captureSelectSlotWithoutRedirect`, `resolveEntryUrl`) migrated from raw header objects to `getCevBrowserHeaders()` calls — eliminates missing `sec-ch-ua*`, wrong Accept, spurious `Cache-Control/Pragma`.

## Fixes applied (session 2026-06-09) — cevPortal.ts
- **FIX P1** (`cevPortal.ts` `completeCevCaptcha`): Removed `referer: ${CEV_BASE}/Captcha` on SetCaptchaToken POST — ground truth `17-14-59-integration_flow.json` confirms NO Referer on this call (Referrer-Policy: no-referrer on all appointment.cloud.diplomatie.be responses).
- **FIX P2** (`cevPortal.ts` `completeCevCaptcha`): Removed `accept: 'application/json, text/javascript, */*; q=0.01'` override on SetCaptchaToken POST — real capture confirms `accept: "*/*"` (plain jQuery without dataType:"json"). Default XHR mode of `getCevBrowserHeaders` is already correct.
- **FIX P3** (`cevPortal.ts` `completeCevCaptcha`): Redirect probe GET: removed truncated Accept string `'text/html,application/xhtml+xml,*/*'` (was missing `image/avif, image/webp, ...` Chrome 148 tail) — now uses default document Accept from `getCevBrowserHeaders`. Added `fetchSite: "same-origin"` (probe navigates within appointment.cloud.diplomatie.be).

## Earlier fixes (previous sessions)
- **FIX #2**: isFormPost flag for login POST headers
- **FIX #3**: Redis version:2 scheme invalidates old sessions
- **FIX #4**: explicit captchaSolved===false check
- **FIX #5**: redirect:"manual" loop for resolveFirstAppIdFromMyList
- **FIX #6**: "Google Chrome";v="148" third brand + parseUserAgentForSecCh updated
- **FIX #7**: Chrome 147 entries updated to real build `147.0.7231.96` + added "Google Chrome";v="147" brand; Linux entry replaced by macOS Chrome 147 profile
- **FIX #8**: Edge UA updated to real build `Edg/148.0.2849.68`
- **FIX #9**: redirect:"manual" boucle avec chaîne tracée pour détecter NoAvailability avant SessionExpired
- **FIX OSOnline**: mergeCookies sur SetCaptchaToken response + chaque hop redirect

## Remaining observations (low priority)
- Real captures use 2-brand `sec-ch-ua` (`"Not/A)Brand";v="99", "Chromium";v="148"`) — from Playwright sniffer. Bot uses 3-brand (stable Chrome). More accurate for production, not a risk.
- `_sessionAcceptLang` default is long-form; real capture captured short `"fr-BE"`. Bot rotates to short form on UA rotation. Minor.
- Pre-existing TS errors in `navigator.ts` (broadcastVisaClass) and `spain-http-booking.ts` (Referer spelling) — unrelated to CEV.

**Why:** Real AngularJS `$http` always sends `text/plain` not `text/html` in Accept, and always adds Cache-Control + If-Modified-Since anti-cache headers. SetCaptchaToken is a plain form POST via jQuery, not `dataType:"json"` → Accept=`*/*`. Navigate requests in Chrome don't send Referer when navigated via JS window.location from a same-origin captcha widget.
