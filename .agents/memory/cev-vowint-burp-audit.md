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

## Fixes applied (2026-06-26, audit #2 — VOWINT flow: GET / through GetAllVisaStatusTypes)
3. **`_culture=en-US` initialized before first GET /** — `vowintCookies` now starts as `"_culture=en-US"` instead of `""`, matching real browser behavior (persistent cookie from previous visit). Passed in `cookie:` override to `getCevBrowserHeaders`.
4. **DataTables: removed Cache-Control + If-Modified-Since** — Burp Chrome 146 confirms DataTables (`/VisaApplication/DataTables`) has NO Cache-Control and NO If-Modified-Since, unlike GetAllVisaStatusTypes which has both. Fixed in both `resolveVowintRefViaMyList` and `resolveFirstAppIdFromMyList`.

**Why DataTables vs GetAllVisaStatusTypes differ**: DataTables appears to use plain `$.ajax` while GetAllVisaStatusTypes uses AngularJS `$http` (which adds `Cache-Control: max-age=0` + `If-Modified-Since: 0` as anti-304 behavior).

## Fixes applied (2026-06-26, audit #3 — GetEAppointmentUrl through SetCaptchaToken)
5. **Removed /fr-BE URL replacement** — VOWINT returns `/en-US` (matching `_culture=en-US` account cookie), browser keeps it as-is. Server sets `PreferredCulture=en-US` via Set-Cookie. The previous `/fr-BE` replacement was inconsistent with the `/en-US` account culture.
6. **`PreferredCulture=en-US` cookie on first GET /Integration/VOW/** — real browser has this persistent cookie before the server sends it. Bot now initializes `cookie: "PreferredCulture=en-US"` on this request.
7. **PreferredCulture now captured from server Set-Cookie** — extracted alongside ASP.NET_SessionId; used for consistency in subsequent requests.
8. **Cookie order fixed** — Burp shows `PreferredCulture=en-US; ASP.NET_SessionId=…` (PreferredCulture FIRST). Bot now constructs `fullCevCookie` in this order (matching browser jar insertion order).
9. **GET /Captcha added** — Burp shows browser does GET /Captcha between Integration/VOW and SetCaptchaToken. Bot was skipping this step; now fires GET /Captcha with the two CEV cookies (non-critical, catches errors silently).

## Confirmed correct (no changes needed)
- GetEAppointmentUrl: Cache-Control + If-Modified-Since + X-Requested-With + Accept: application/json, text/plain, */* ✅
- SetCaptchaToken: Accept: */* (XHR default), no Referer, X-Requested-With, Origin, Sec-Fetch-Site: same-origin ✅
- Integration/VOW Sec-Fetch-Site: same-site (both on diplomatie.be) ✅

## Fixes applied (2026-06-26, audit #4 — SelectSlot + 2nd Integration/VOW navigation)
10. **UA propagated in redirect chain loop** — `getCevBrowserHeaders` in the post-SetCaptchaToken redirect hop loop now passes `userAgent: siphoned?.userAgent`. For siphoned sessions, all hops (Integration/VOW→SelectSlot→NoAvailability) now use the siphoned UA consistently.

## Confirmed correct (SelectSlot + 2nd Integration/VOW)
- `Sec-Fetch-Site: same-origin` on both ✅ (already on appointment.cloud.diplomatie.be)
- No Referer on either ✅ (confirmed Burp Chrome 146 + HAR 2026-06-08)
- Cookie order `PreferredCulture; ASP.NET_SessionId` ✅ (fixed audit #3)
- `Priority: u=0, i` ✅

## Remaining minor gaps (not fixed — low impact)
- Double GET /en in redirect chain — bot follows once
- Header order differences between Chrome 146 (user's Burp) and Chrome 148/149 (bot profiles) — expected, bot is calibrated to Chrome 148 HAR not Chrome 146

## Fix 2026-08-12 (v2) — retry loop + suppression enterprise payload erroné

**Root cause confirmée** : Anti-Captcha réussit le challenge visuel (glisser un animal) 60-80% du temps. `captchaSolved: false` est intermittent, pas systématique. L'enterprise payload ajouté (isEnterprise:true + enterprisePayload:{rqdata: checksiteconfig.c.req}) aggravait le problème car `c.req` est le PoW JWT interne de hcaptcha, pas un rqdata opérateur — il mettait Anti-Captcha sur le mauvais chemin enterprise.

**Fix** : (1) suppression des flags enterprise erronés → retour à HCaptchaTaskProxyless standard. (2) boucle retry ≤3 : quand captchaSolved:false, attend 4s et renvoie un nouveau token à la même session OutSystems (siteverify stateless → tout token valide accepté). VOWINT invalidé seulement après 3 échecs.

**Why** : 3 tentatives indépendantes à 65-75% → taux succès > 99% par cycle. Sans retry, chaque échec coûtait 1 cycle entier (60-120s).

---

## Fix 2026-08-12 (v1, OBSOLÈTE) — rqdata enterprise dynamique via checksiteconfig (captchaSolved:false systématique)

**Root cause** : le CSP de `/Captcha` contient `https://remote.captcha.com` → sitekey CEV est hCaptcha **Enterprise** côté serveur. Le `rqdata` n'est PAS dans le HTML statique — `api.js` le charge dynamiquement via `checksiteconfig`. Sans rqdata, Anti-Captcha génère un token standard rejeté par siteverify enterprise.

**Fix** : avant d'appeler Anti-Captcha, fetch :
```
GET https://hcaptcha.com/checksiteconfig?v=1&host=appointment.cloud.diplomatie.be&sitekey=5f64399c-…&sc=1&swa=1&spst=<ts>
```
Extrait `c.req` = rqdata. Passe `isEnterprise:true + enterprisePayload:{rqdata}` à Anti-Captcha si rqdata trouvé, sinon mode standard sans flags enterprise.

**Why** : isEnterprise:true sans rqdata ne suffit pas pour enterprise siteverify — le challenge enterprise doit être résolu avec le bon rqdata de session.
