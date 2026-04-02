# Rapport de Comparaison Bundle ↔ Bot

**Date :** 2026-04-02
**Bundle :** `main.dc91e3f7b5f67caa.js`
**Bot :** `usaPortal.ts` (2093 lignes)

## Résumé global

| Statut | Nombre | Description |
|--------|--------|-------------|
| ✅ Conforme | 54 | Comportement identique au bundle |
| ⚠️ Différence mineure | 3 | Écart non-critique mais à surveiller |
| ❌ Divergence critique | 0 | Peut causer un 4xx/5xx ou un comportement incorrect |
| ❓ Non vérifié | 0 | Contexte insuffisant pour confirmer |

---

## Index des endpoints

| ID | Endpoint | Méthode | ✅ | ⚠️ | ❌ | ❓ |
|----|----------|---------|---|---|---|---|
| 01 | 🟡 login | `POST` | 9 | 2 | 0 | 0 |
| 02 | 🟢 httpInterceptor | `ALL` | 5 | 0 | 0 | 0 |
| 03 | 🟡 paymentStatus | `GET` | 4 | 1 | 0 | 0 |
| 04 | 🟢 getApplicationDetails | `GET` | 6 | 0 | 0 | 0 |
| 05 | 🟢 ofcList | `GET` | 7 | 0 | 0 | 0 |
| 06 | 🟢 getFirstAvailableMonth | `POST` | 3 | 0 | 0 | 0 |
| 07 | 🟢 getSlotDates | `POST` | 2 | 0 | 0 | 0 |
| 08 | 🟢 getSlotTime | `POST` | 5 | 0 | 0 | 0 |
| 09 | 🟢 bookSlot | `PUT` | 11 | 0 | 0 | 0 |
| 10 | 🟢 cryptoAES | `N/A` | 2 | 0 | 0 | 0 |

---

## [01] 🟡 login

**Méthode :** `POST`  **URL :** `/identity/user/login`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| URL endpoint | ✅ | `${authenticationURL}/login` | ${USA_BASE}/identity/user/login | Même chemin /login sous le même host d'auth |
| Méthode HTTP | ✅ | POST | POST | Confirmé |
| Corps (body) — champ `authorization` | ✅ | `{authorization: "Basic " + encrypt(user:pass)}` | `{authorization: "Basic ${encryptPortalCredentials(...)}"}` | Credentials AES dans le body JSON, pas en header |
| Headers CORS non-standard (Access-Control-Allow-*) | ⚠️ | `{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Credentials":"true","A… | (non envoyé — risque faible, serveur ignore ces headers) | Angular envoie ces 4 headers par erreur (ils sont normalemen… |
| Extraction JWT — header `Authorization` de la réponse | ✅ | `F.headers.get("Authorization")` → saveToken (sessionStorage "AuthToken") | `response.headers.get("authorization")` | Headers HTTP case-insensitive → OK |
| Extraction refreshToken — header `refreshtoken` de la réponse | ✅ | `F.headers.get("refreshtoken")` | `response.headers.get("refreshtoken")` | Lowercase — OK |
| Extraction csrfToken — header `Csrftoken` de la réponse | ✅ | `F.headers.get("Csrftoken")` → localStorage "CSRFTOKEN" | `response.headers.get("csrftoken")` | Case-insensitive → OK |
| Champ `userID` (maj D) dans la réponse | ✅ | `JSON.parse(loggedInApplicantUser).userID` (capital D) | `data.userID` | Attention : .userID (capital D), pas .userId |
| Détection flag `mfa` dans la réponse | ✅ | `1 == j.body?.mfa` → MFA dialog, token invalide | `if (data.mfa) throw MFA error` | Sans détection : le bot continue avec un token invalide |
| Détection flag `firstTimeLogin` | ✅ | `j.body?.firstTimeLogin` → redirect vers reset password | `if (data.firstTimeLogin) throw error` | Compte neuf → portail force changement mot de passe |
| `window.sessionStorage.clear()` avant login | ⚠️ | `loginUser(H) { window.sessionStorage.clear(); ... }` | Le bot ne vide pas de sessionStorage (il n'en a pas — géré via tokenCache) | Le bot utilise une Map en mémoire — comportement équivalent … |

---

## [02] 🟢 httpInterceptor

**Méthode :** `ALL`  **URL :** `Intercepteur global (toutes requêtes authentifiées)`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| Header `Authorization: Bearer {token}` | ✅ | `Authorization: `Bearer ${Ce}`` (Ce = sessionStorage "AuthToken") | `Authorization: Bearer ${accessToken}` | Ajouté sur toutes les requêtes sauf /login, /refreshToken, c… |
| Header `Content-Type: application/json` (requêtes avec body) | ✅ | `Content-Type: application/json` (sauf upload fichiers) | `"Content-Type": "application/json"` si withBody=true | Ajouté automatiquement via withBody param |
| Header `LanguageId` (UNIQUEMENT sur /getLandingPageDeatils et /generatewizardtemplate) | ✅ | `LanguageId: localStorage("LanguageId")` → UNIQUEMENT sur ces 2 URLs | `"LanguageId": "1"` dans callLandingPage() uniquement | Présent sur les mauvaises requêtes = fingerprint incorrect |
| Headers Sec-Fetch-* (Dest, Mode, Site) | ✅ | Ajoutés automatiquement par le navigateur (non présents dans le code Angular dir… | `Sec-Fetch-Dest: empty, Sec-Fetch-Mode: cors, Sec-Fetch-Site: same-origin` | Normalement ajoutés par le navigateur — le bot les simule ma… |
| Header `Accept-Encoding: gzip, deflate, br, zstd` (Chrome 123+) | ✅ | Chrome 123+ envoie automatiquement zstd | `Accept-Encoding: gzip, deflate, br, zstd` | Fingerprint JA4H différent sans zstd |

---

## [03] 🟡 paymentStatus

**Méthode :** `GET`  **URL :** `/workflow/getUserHistoryApplicantPaymentStatus`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| URL endpoint | ✅ | `visaWorkFlowURL + /workflow/getUserHistoryApplicantPaymentStatus` | ${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus | Aucun param dans l'URL (pas de ?userId=) |
| Méthode HTTP | ✅ | GET | GET | Confirmé |
| Champ réponse `pendingAppoStatus` | ✅ | `data.pendingAppoStatus` (0=no_request, 1=scheduled, 2+=pending) | `data.pendingAppoStatus` | 0=no_request, 1=scheduled, ≥2=pending (à scanner) |
| Champ réponse `applicationId` | ✅ | `JSON.parse(Ce.body).applicationId` | `data.applicationId` | Propagé dans session.applicationId |
| Champs `appointmentId` et `applicantUUID` dans la réponse | ⚠️ | Non confirmés dans getUserHistoryApplicantPaymentStatus (viennent de getApplicat… | Extraits avec fallback undefined si absents | CRITIQUE : la source principale de ces champs est getApplica… |

---

## [04] 🟢 getApplicationDetails

**Méthode :** `GET`  **URL :** `/appointments/getApplicationDetails?applicationId={}&applicantId={}`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| URL — ordre des params (applicationId EN PREMIER, puis applicantId) | ✅ | `?applicationId=w&applicantId=y` (applicationId first) | `?applicationId=${applicationId}&applicantId=${applicantId}` | Ordre des queryString params confirmé |
| Réponse = TABLEAU (pas un objet unique) | ✅ | `let z = [...Ee]` puis `.filter(B => "NEW" == B.appointmentStatus)` | `Array.isArray(raw) ? raw : [raw]` | CRITIQUE : lire comme objet unique retourne les propriétés i… |
| Filtre `appointmentStatus === "NEW"` sur le tableau | ✅ | `z.filter(B => "NEW" == B.appointmentStatus)` | `list.filter(item => item.appointmentStatus === "NEW")` | Sans filtre : données d'un RDV passé/annulé pourraient être … |
| Champ `appointmentId` dans chaque item du tableau | ✅ | `relatedAppList[0].appointmentId` → sessionStorage("appointmentId") | `data.appointmentId` extrait et propagé vers session | CRITIQUE pour le payload de booking |
| Champ `applicantUUID` dans chaque item du tableau | ✅ | `relatedAppList[0].applicantUUID` → sessionStorage("applicantUUID") | `data.applicantUUID` extrait et propagé vers session | CRITIQUE pour le payload de booking |
| Champ `appointmentLocationType` dans chaque item | ✅ | `relatedAppList[0].appointmentLocationType` → ofcOrPost ("OFC" | "POST") | Présent dans UsaAppDetails | Détermine si on book en OFC ou POST |

---

## [05] 🟢 ofcList

**Méthode :** `GET`  **URL :** `/lookupcdt/wizard/getpost?visaClass=...&missionId=...`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| Endpoint booking flow — `/lookupcdt/wizard/getpost?visaClass=...&missionId=...` | ✅ | `slotBookingService.getFilteredOfcPostList(De)` → GET `/lookupcdt/wizard/getpost… | `USA_OFC_LIST_URL(missionId, visaClass, visaCategory)` → `/lookupcdt/wizard/getp… | W4 CORRIGÉ — endpoint booking flow unifié avec le bundle Ang… |
| Params query — `visaClass`, `visaCategory`, `stateCode`, `priority`, `missionId` | ✅ | `visaCategory?` + `visaClass?` + `stateCode?` + `priority?` + `missionId` (ordre… | `URLSearchParams` avec visaCategory + visaClass + stateCode + priority + mission… | stateCode et priority viennent de getTransformData — ajoutés… |
| Appel préalable `getTransformData` pour enrichir stateCode + appointmentPriority | ✅ | `renderService.getTransformData(applicationId)` → [0].stateCode + [0].appointmen… | `getUsaTransformData(session, applicationId)` → session.stateCode + session.appo… | W7 CORRIGÉ — getTransformData appelé à l'étape 2a avant la l… |
| Params transmis depuis `effectiveDetails` + session au call site `getUsaOfcList(...)` | ✅ | `selectedSlotDetails.visaClass` + `selectedSlotDetails.visaCategory` + `this.sta… | `effectiveDetails.visaClass, effectiveDetails.visaType, session.stateCode, sessi… | Toutes les données de session propagées correctement vers ge… |
| Filtre `officeType === "OFC"` (Étape 1) | ✅ | `je.filter(B => B.officeType === this.ofcOrPost)` (ofcOrPost="OFC") | `list.filter(o => o.officeType === "OFC")` | Filtre correct — évite de scanner les POST locations |
| Filtre OFCs autorisés du compte — `loggedInApplicantUser.ofc` (Étape 2) | ✅ | `S = JSON.parse(loggedInApplicantUser).ofc` → `ofcList.filter(B => S.some(se => … | `data.ofc` extrait au login → `session.allowedOfcs` → `filtered.filter(o => allo… | W6 CORRIGÉ — filtre appliqué si le compte a des OFCs restrei… |
| Persistance `allowedOfcs` dans le cache token (CachedToken) | ✅ | `loggedInApplicantUser` stocké dans localStorage (persist entre pages Angular) | `allowedOfcs` stocké dans CachedToken + restauré sur cache hit et refresh | Évite de rescanner tous les OFCs à chaque refresh de token |

---

## [06] 🟢 getFirstAvailableMonth

**Méthode :** `POST`  **URL :** `/modifyslot/getFirstAvailableMonth`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| Payload — 6 champs (sans fromDate/toDate) | ✅ | `{postUserId, applicantId, visaType, visaClass, locationType, applicationId}` | `{...basePayload}` — basePayload contient ces 6 champs | Confirmé — PAS de fromDate/toDate ici (contrairement à getSl… |
| Champ `locationType` dans le payload | ✅ | `locationType: this.ofcOrPost` ("OFC") | `locationType: "OFC"` via basePayload | Présent et correct |
| Réponse — champs `present` et `date` | ✅ | `{present: boolean, date: "YYYY-MM-DD"}` | `firstMonth.present`, `firstMonth.date` |  |

---

## [07] 🟢 getSlotDates

**Méthode :** `POST`  **URL :** `/modifyslot/getSlotDates`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| Payload getSlotDates — 8 champs (avec locationType, fromDate, toDate, SANS slotDate) | ✅ | `{fromDate, toDate, postUserId, applicantId, visaType, visaClass, locationType, … | `{ ...basePayload, fromDate, toDate }` (basePayload contient locationType) | Confirmé — locationType présent, slotDate absent |
| Champs `fromDate` et `toDate` présents | ✅ | Présents — début/fin de la fenêtre de scanning | Ajoutés via `{ ...basePayload, fromDate, toDate }` |  |

---

## [08] 🟢 getSlotTime

**Méthode :** `POST`  **URL :** `/modifyslot/getSlotTime`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| Payload getSlotTime — 8 champs (avec slotDate, fromDate, toDate, SANS locationType) | ✅ | `{fromDate, toDate, postUserId, applicantId, slotDate, visaType, visaClass, appl… | `{fromDate, toDate, postUserId, applicantId, slotDate, visaType, visaClass, appl… | DIFFÉRENCE CLÉ vs getSlotDates: a slotDate+fromDate+toDate, … |
| Champs `fromDate` et `toDate` présents (même fenêtre que getSlotDates) | ✅ | Présents — `Ee = setFromOrToDate(1)`, `toDate = setFromOrToDate(0)` | `fromDate` et `toDate` inclus dans slotTimePayload | Erreur session 1 corrigée en session 2 |
| Champ `locationType` ABSENT du payload getSlotTime | ✅ | Absent (uniquement dans getSlotDates/getFirstAvailableMonth) | Absent (retiré) | locationType est dans getSlotDates, PAS dans getSlotTime |
| Champ `slotDate` présent (date cible pour les horaires) | ✅ | `slotDate: je` (je = date formatée en yyyy-MM-dd) | `slotDate: targetDate` | Spécifique à getSlotTime — absent de getSlotDates |
| Réponse — champ `UItime` et conversion 24h→12h AM/PM | ✅ | `setUItime()` → convertit startTime vers format "H:MM AM/PM" | `formatUItime()` reproduit `setUItime()` du bundle | CRITIQUE : booking avec format 24h → rejeté par le serveur |

---

## [09] 🟢 bookSlot

**Méthode :** `PUT`  **URL :** `/appointments/schedule`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| Payload exact — 10 champs (ni plus, ni moins) | ✅ | `{appointmentId, applicantUUID, appointmentLocationType, appointmentStatus, slot… | Interface `UsaBookingPayload` — 10 champs | PAS de visaType, visaClass, locationType, startTime, endTime |
| Champ `appointmentId` — source et valeur | ✅ | `selectedSlotDetails.appointmentId || parseInt(sessionStorage("appointmentId"))` | `session.appointmentId` (propagé depuis getApplicationDetails) | Critique — sans appointmentId le serveur rejette le booking |
| Champ `applicantUUID` — source et valeur | ✅ | `parseInt(selectedSlotDetails.applicantUUID)` ou `parseInt(sessionStorage("appli… | `session.applicantUUID` (propagé depuis getApplicationDetails) | parseInt → le serveur attend un nombre |
| Champ `appointmentDt` = slotDate (pas "date" ni "startTime") | ✅ | `appointmentDt: this.selectedSlot.slotDate` | `appointmentDt: slotRaw.slotDate ?? found.date` | CRITIQUE : champ clé pour le calendrier de réservation |
| Champ `appointmentTime` — format "H:MM AM" (12h, pas 24h) | ✅ | `appointmentTime: this.selectedSlot.UItime` (ex: "9:00 AM") | `formatUItime(slot.startTime)` → "H:MM AM/PM" | CRITIQUE : format incorrect → rejet par le serveur |
| Champ `appointmentLocationType: "OFC"` | ✅ | `appointmentLocationType: this.ofcOrPost` ("OFC") | `appointmentLocationType: "OFC"` |  |
| Champ `appointmentStatus: "SCHEDULED"` | ✅ | `appointmentStatus: "SCHEDULED"` | `appointmentStatus: "SCHEDULED"` |  |
| Champ `postUserId` = OFC sélectionné (ajouté par initBookSlot) | ✅ | `De.postUserId = this.selectedOfc` | `postUserId: basePayload.postUserId` |  |
| Champ `applicantId` = selectedSlotDetails.applicantId (ajouté par initBookSlot) | ✅ | `De.applicantId = selectedSlotDetails.applicantId || sessionStorage("applicantId… | `applicantId: basePayload.applicantId` |  |
| Champ `applicationId` = applicationId courant (ajouté par initBookSlot) | ✅ | `De.applicationId = this.applicationId` | `applicationId: basePayload.applicationId` |  |
| CSRF sur PUT — headers `CookieName: XSRF-TOKEN={csrfToken}` et `X-XSRF-TOKEN` | ✅ | Angular HttpClient envoie automatiquement `X-XSRF-TOKEN` depuis le cookie XSRF-T… | `CookieName: XSRF-TOKEN={csrfToken}` + `X-XSRF-TOKEN: {csrfToken}` | Double mécanisme : cookie interceptor + custom header |

---

## [10] 🟢 cryptoAES

**Méthode :** `N/A`  **URL :** `Chiffrement AES-256-CBC des credentials`

| Point de vérification | Statut | Bundle Angular | Bot actuel | Note |
|-----------------------|--------|---------------|------------|------|
| Algorithme PBKDF2(SHA1, 1000 iter, 32 bytes) | ✅ | PBKDF2-SHA1, 1000 iterations, 256 bits (32 bytes) | Implémenté |  |
| Format sortie — `salt_hex(32) + iv_hex(32) + base64(ciphertext)` | ✅ | salt encodé en hex + iv encodé en hex + ciphertext en base64 | Implémenté |  |

---
