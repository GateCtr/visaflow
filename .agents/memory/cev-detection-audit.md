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
- `"Google Chrome";v="149"` brand present in Chrome 149 entries ✓
- No `Connection` header sent (impit uses HTTP/2 properly) ✓
- `getCevBrowserHeaders` document mode already includes `Sec-Fetch-User: ?1` + `Upgrade-Insecure-Requests: 1` ✓
- SetCaptchaToken first call: `Accept: "*/*"` is default for XHR mode ✓
- `mergeCookies` accumulates all Set-Cookie including OSOnline ✓
- `OSOnline` (OutSystems JWT) + `ServerId` cookies captured during login redirect chain ✓
- `sec-ch-ua-mobile` defaults to `"?0"` (line 157 cev-shared-impit.ts) — always sent, correct for desktop ✓
- `Accept-Encoding` rotates between `"gzip, deflate, br, zstd"` and `"gzip, deflate, br"` — both valid Chrome 149 ✓
- `PreferredCulture=en-US` cookie on CEV is correct — CEV portal defaults to English ✓
- UA/sec-ch-ua consistency: `getCevBrowserHeaders` uses `_sessionUa.chUa` matching `_sessionUa.ua` — no mismatch ✓

## Fixes applied (session 2026-06-08)
- **FIX 1**: `GetEAppointmentUrl` Accept header: `"application/json, text/html, */*"` → `"application/json, text/plain, */*"` (AngularJS `$http` default)
- **FIX 2**: `GetEAppointmentUrl` missing headers: added `"Cache-Control": "max-age=0"` + `"If-Modified-Since": "0"` (AngularJS anti-304-cache headers, confirmed in real capture)
- **FIX 3**: SetCaptchaToken retry in `cevHttpSetup.ts`: removed erroneous `referer: ${CEV_BASE}/Captcha` (real capture has NO Referer on SetCaptchaToken)
- **FIX 4**: Redirect chain post-captcha: removed `currentReferer` variable, now uses `fetchSite: "same-origin"` explicit without Referer (real capture: none of Integration/VOW / SelectSlot / NoAvailability navigate requests have a Referer header)
- **FIX A-F** (`cevPolling.ts`): ALL 4 polling functions (`fetchManual`, `pollViaApi`, `captureSelectSlotWithoutRedirect`, `resolveEntryUrl`) migrated from raw header objects to `getCevBrowserHeaders()` calls — eliminates missing `sec-ch-ua*`, wrong Accept, spurious `Cache-Control/Pragma`.

## Fixes applied (session 2026-06-09) — cevHttpSetup.ts (HTTP-pur VOWINT path)
- **FIX H1** (`cevHttpSetup.ts`): DataTables + MyList + resolveFirstAppIdFromMyList (3 occurrences): `accept: "application/json, */*"` → `"application/json, text/javascript, */*; q=0.01"`. Ground truth HAR `17-14-59-raw.har` : `/VisaApplication/DataTables` et `/VisaApplication/MyList` envoient l'Accept jQuery-DataTables natif. Différent de AngularJS `$http` (`text/plain, */*`) — ces 2 endpoints sont appelés par jQuery DataTables qui hard-code `text/javascript`.
- **FIX H2** (`cevHttpSetup.ts` login redirect hops): Boucle GET `/` → GET `/en` après login POST : ajout `"Cache-Control": "max-age=0"` dans les headers. HAR : Chrome propage ce header sur toute la chaîne de redirections d'un form-submit.
- **FIX H3** (`cevHttpSetup.ts` login POST): POST `/en/Account/Login` : ajout `"Cache-Control": "max-age=0"`. HAR : Chrome l'envoie sur le form-submit lui-même.

## Fixes applied (session 2026-06-09) — cevPortal.ts
- **FIX P1** (`cevPortal.ts` `completeCevCaptcha`): Removed `referer: ${CEV_BASE}/Captcha` on SetCaptchaToken POST — ground truth confirms NO Referer on this call (Referrer-Policy: no-referrer).
- **FIX P2** (`cevPortal.ts` `completeCevCaptcha`): Removed `accept: 'application/json, text/javascript, */*; q=0.01'` override on SetCaptchaToken POST — real capture confirms `accept: "*/*"`.
- **FIX P3** (`cevPortal.ts` `completeCevCaptcha`): Redirect probe GET: removed truncated Accept string; now uses default document Accept from `getCevBrowserHeaders`. Added `fetchSite: "same-origin"`.

## Fixes applied (session 2026-06-10) — timing + UA pool
- **FIX T1** (`cevHttpSetup.ts`): Login form typing delay — 2-8s random sleep between GET login page and POST login (simulates human typing time). Before: POST arrived ~100ms after GET → WAF trigger.
- **FIX T2** (`cevHttpSetup.ts`): List-read dwell delay — 1-4s random sleep between MyList response and GetEAppointmentUrl call (simulates user reading their dossier list before clicking). Before: 0ms gap after MyList.
- **FIX UA1** (`cev-shared-impit.ts`): Added Chrome 149.0.7827.55 (Win×2, macOS×1) entries to CEV_UA_POOL. Chrome 149 is current stable as of 2026-06-10. Pool now: 149 Win/Mac/Win-patch, 148 Win/Mac, Edge 148, 147 Win.
- **FIX UA2** (`browser.ts`): Replaced all fake `.0.0.0` build numbers with real builds. Added Chrome 149. Removed Linux Chrome (no Linux in CEV per memory rules). Firefox/Safari kept for non-CEV Playwright portals.
- **FIX UA3** (`cevPolling.ts`): Replaced `randomUserAgent()` (from browser.ts — includes Firefox/Safari/Linux) with `getCevSessionUa()` in all 2 call sites. Before: `getEffectiveUa()` fallback could return Firefox UA → sec-ch-ua Chrome mismatch.
- **FIX UA4** (`cevHttpBooking.ts`): Replaced `randomUserAgent()` fallback with `getCevSessionUa()`. Same risk as UA3.

## Earlier fixes (previous sessions)
- **FIX #2**: isFormPost flag for login POST headers
- **FIX #3**: Redis version:2 scheme invalidates old sessions
- **FIX #4**: explicit captchaSolved===false check
- **FIX #5**: redirect:"manual" loop for resolveFirstAppIdFromMyList
- **FIX #6**: "Google Chrome";v="148" third brand + parseUserAgentForSecCh updated
- **FIX #7**: Chrome 147 entries updated to real build `147.0.7231.96` + "Google Chrome";v="147" brand; Linux replaced by macOS Chrome 147
- **FIX #8**: Edge UA updated to real build `Edg/148.0.2849.68`
- **FIX #9**: redirect:"manual" boucle avec chaîne tracée pour détecter NoAvailability avant SessionExpired
- **FIX OSOnline**: mergeCookies sur SetCaptchaToken response + chaque hop redirect

## Remaining observations (low priority)
- Real captures use 2-brand `sec-ch-ua` (`"Not/A)Brand";v="99", "Chromium";v="148"`) — from Playwright sniffer. Bot uses 3-brand (stable Chrome). More accurate for production, not a risk.
- `_sessionAcceptLang` default is long-form; real capture captured short `"fr-BE"`. Bot rotates to short form on UA rotation. Minor.
- Pre-existing TS errors in `navigator.ts` (broadcastVisaClass) and `spain-http-booking.ts` (Referer spelling) — unrelated to CEV.
- No timing jitter between individual hops in the redirect chain (GET / → GET /en → login page). Browser rendering adds 10-50ms between hops. Very low detection risk for step-by-step redirect chains.

**Why:** Real AngularJS `$http` always sends `text/plain` not `text/html` in Accept, and always adds Cache-Control + If-Modified-Since anti-cache headers. SetCaptchaToken is a plain form POST via jQuery, not `dataType:"json"` → Accept=`*/*`. Navigate requests in Chrome don't send Referer when navigated via JS window.location from a same-origin captcha widget.
