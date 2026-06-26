---
name: CEV VOWINT Burp audit Chrome 146
description: Forensic comparison of real Burp Suite Chrome 146 capture vs bot HTTP implementation for VOWINT→CEV flow. 2 gaps fixed.
---

## Source
Burp Suite intercept on real Chrome 146 Windows, screentapinc@gmail.com, 2026-06-26.

## Full flow confirmed (Burp row order)

### VOWINT (visaonweb.diplomatie.be)
1. GET / → Cookie: _culture=en-US → 200 (sets __RequestVerificationToken, ServerId, TS0110ceb4)
2. POST /en/Account/Login → Cookie: _culture=en-US; __RequestVerificationToken; ServerId; TS0110ceb4 → 302 (sets OSOnline)
3. GET / → 302
4. GET /en → 200
5. GET /en → 200 (second — duplicate redirect)
6. GET /en/VisaApplication/IndexByUserId → 200
7. GET /VisaApplication/DataTables → XHR (X-Requested-With, cors, Priority: u=1, i)
8. GET /Common/GetAllVisaStatusTypes → XHR (Cache-Control: max-age=0, If-Modified-Since: 0) ← **BETWEEN DataTables and MyList**
9. GET /VisaApplication/MyList?draw=1&... → XHR (full DataTables params)
10. GET /Common/GetEAppointmentUrl?id=... → XHR (Cache-Control: max-age=0, If-Modified-Since: 0)

### CEV (appointment.cloud.diplomatie.be)
11. GET /Integration/VOW/{orgId}/{appId}/{sessionId}/{tokenId}/en-US → Cookie: PreferredCulture=en-US → 302 (sets ASP.NET_SessionId)
12. GET /Captcha → Cookie: PreferredCulture=en-US; ASP.NET_SessionId=... → 200
13. hCaptcha resolution (browser-side)
14. POST /Captcha/SetCaptchaToken → Cookie: PreferredCulture=en-US; ASP.NET_SessionId=..., X-Requested-With → 200
15. GET /Integration/VOW/{tokenId}/en-US → Cookie: PreferredCulture=en-US (NO ASP.NET_SessionId!) → 302
16. GET /Integration/VOW/SelectSlot → 302
17. GET /Integration/Error/NoAvailability → 200

## Sec-Ch-Ua in Chrome 146
`"Not-A.Brand";v="24", "Chromium";v="146"` (only 2 brands — no Google Chrome, different GREASE format vs 148/149)

**Why:** The GREASE brand name and version number change across Chrome versions. "Not-A.Brand";v="24" is Chrome 146, "Not/A)Brand";v="99" is Chrome 148/149. Bot uses 147-149 profiles which is correct for its declared UA.

## Priority header (Chrome 146+)
- Navigate: `Priority: u=0, i`
- XHR/AJAX: `Priority: u=1, i`
Appears after Accept-Encoding in Chrome's header list.

## Fixes applied (2026-06-26, audit #1)
1. **GetAllVisaStatusTypes added** to cevHttpSetup.ts in `resolveVowintRefViaMyList` and `resolveFirstAppIdFromMyList` fallback — inserted between DataTables and MyList calls.
2. **Priority header added** to all 3 branches of `getCevBrowserHeaders` in cev-shared-impit.ts:
   - Form POST branch: `"Priority": "u=0, i"`
   - Document navigate branch: `"Priority": "u=0, i"`
   - XHR/AJAX branch: `"Priority": "u=1, i"`

## Fixes applied (2026-06-26, audit #2 — second Burp session)
3. **`_culture=en-US` initialized before first GET /** — `vowintCookies` now starts as `"_culture=en-US"` instead of `""`, matching real browser behavior (persistent cookie from previous visit). Passed in `cookie:` override to `getCevBrowserHeaders`.
4. **DataTables: removed Cache-Control + If-Modified-Since** — Burp Chrome 146 confirms DataTables (`/VisaApplication/DataTables`) has NO Cache-Control and NO If-Modified-Since, unlike GetAllVisaStatusTypes which has both. Fixed in both `resolveVowintRefViaMyList` and `resolveFirstAppIdFromMyList`.

**Why DataTables vs GetAllVisaStatusTypes differ**: DataTables appears to use plain `$.ajax` while GetAllVisaStatusTypes uses AngularJS `$http` (which adds `Cache-Control: max-age=0` + `If-Modified-Since: 0` as anti-304 behavior).

## Remaining minor gaps (not fixed — low impact)
- Double GET /en in redirect chain — bot follows once
- Post-SetCaptchaToken probe: browser drops ASP.NET_SessionId, bot sends both — server uses URL token for auth anyway
- Header order differences between Chrome 146 (user's Burp) and Chrome 148/149 (bot profiles) — expected, bot is calibrated to Chrome 148 HAR not Chrome 146
