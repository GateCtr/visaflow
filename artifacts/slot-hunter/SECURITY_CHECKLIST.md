# Joventy Hunter — Security Checklist & Threat Model

> **À mettre à jour :** après chaque changement de bundle portail, chaque mise à jour Chrome majeure (tous les ~4 mois), et après tout incident de ban.
>
> **Script automatisé :** `npx tsx src/securityCheck.ts` (full : `FULL_CHECK=true npx tsx src/securityCheck.ts`)

---

## Comment lire ce document

| Symbole | Signification |
|---------|---------------|
| ✅ COUVERT | Implémenté et fonctionnel |
| ⚠️ PARTIEL | Partiellement couvert — amélioration recommandée |
| ❌ MANQUANT | Non implémenté — risque actif |
| 🔍 SURVEY | À surveiller — aucun impact actuel mais peut évoluer |
| 🔁 RÉCURRENT | À re-vérifier régulièrement |

---

## 1. Bundle Integrity (quotidien)

### 1.1 Clé AES du portail
- **Risque :** Le portail change la clé AES → tous les logins échouent (credentials mal chiffrés).
- **Vecteur 2026 :** Angular CLI produit un nouveau hash de bundle à chaque déploiement. La clé peut changer sans avertissement lors d'une mise à jour de dépendances.
- **Statut :** ✅ COUVERT — `checkPortalBundleKey()` dans `index.ts`, 1x/24h, pause auto + alerte si clé absente.
- **Clé actuelle :** `OuoCdl8xQh/OX6LbmgLEtZxZrvnOmrubsMhPW1VPRjk=`
- **Action si changement :** Mettre à jour `USA_ENC_SEC_KEY` dans `usaPortal.ts`, rebuild, redéployer.

### 1.2 Endpoints API
- **Risque :** Changement d'URL ou de méthode HTTP sur un des 11 endpoints critiques.
- **Statut :** ⚠️ PARTIEL — le check bundle vérifie `/identity/user/login` et `/appointments/schedule` mais pas les 9 autres.
- **Action :** Lancer `FULL_CHECK=true npx tsx src/securityCheck.ts` après chaque mise à jour du portail.

### 1.3 Mécanisme CSRF
- **Risque :** Le portail change le nom du header CSRF (`CookieName` → autre chose) → tous les PUT échouent.
- **Statut :** ✅ COUVERT — `checkPortalBundleKey()` vérifie la présence de `CookieName` et `XSRF-TOKEN` dans le bundle.
- **Mécanisme actuel :**
  - Login → header réponse `Csrftoken` → stocké dans `session.csrfToken`
  - Tous les PUT → header `CookieName: XSRF-TOKEN={csrfToken}`
  - Angular built-in → `X-XSRF-TOKEN` depuis le cookie (non-reproduit — voir §3.8)

### 1.4 Algorithme de chiffrement
- **Risque :** Le portail change PBKDF2 → AES pour autre algorithme.
- **Statut :** 🔍 SURVEY — stable depuis 2023. Check bundle quotidien détecte l'absence de `PBKDF2`/`AES`.

### 1.5 reCAPTCHA sitekey
- **Sitekey actuelle :** `6LcpAXklAAAAAFUYDDE8NlsuSb69b5GbXg3sEmaZ`
- **Statut :** ✅ COUVERT — check bundle vérifie la sitekey quotidiennement.
- **Si changement :** La sitekey change → 2captcha ne peut plus résoudre → mettre à jour `EXPECTED_CAPTCHA_SITEKEY` dans `securityCheck.ts`.

---

## 2. Fingerprint Réseau & TLS

### 2.1 JA3 / JA4 TLS Fingerprint
- **Risque :** Les serveurs identifient les clients par leur "empreinte TLS" (cipher suites proposés, ordre des extensions TLS). Node.js/undici produit une empreinte différente de Chrome.
- **Détecteurs 2026 :** Cloudflare Bot Management, Akamai Bot Manager, Kasada, DataDome.
- **Statut :** ⚠️ PARTIEL — Aucun WAF commercial détecté dans le bundle portail (pas d'Akamai/CF/DataDome). Risque actuel FAIBLE.
- **Mitigation si WAF détecté :** Migrer vers un navigateur headless (Playwright) pour toutes les requêtes (y compris USA API) — le navigateur produit le bon fingerprint TLS.

### 2.2 HTTP/2 Frame Fingerprint
- **Risque :** Cloudflare et Akamai analysent les frames HTTP/2 `SETTINGS` (window size, header table, max streams). Node.js envoie des valeurs différentes de Chrome.
- **Statut :** ⚠️ PARTIEL — Risque FAIBLE (pas de WAF H2 détecté actuellement).
- **Mitigation :** Idem 2.1 — impossible à corriger sans patcher undici/Node.js nativement.

### 2.3 JA4H (HTTP Header Fingerprint)
- **Risque 2026 NOUVEAU :** JA4H analyse l'ordre, la présence et les valeurs des headers HTTP (pas TLS). Détectable même avec un bon UA.
- **Headers analysés :** Ordre de User-Agent, Accept, Accept-Language, Accept-Encoding, Connection, etc.
- **Statut :** ⚠️ PARTIEL — Nos headers sont dans un ordre raisonnable mais `Accept-Encoding` ne contient pas `zstd` (voir §3.2).
- **Action :** Vérifier l'ordre exact des headers que Chrome 135+ envoie pour les XHR CORS.

### 2.4 IP Reputation
- **Risque :** IP datacenter Railway → détectée comme bot source.
- **Statut :** ✅ COUVERT (si TWOCAPTCHA_API_KEY configurée) — ProxyPool 2captcha avec IPs résidentielles.
- **Fallback :** PROXY_URL statique (⚠️ toujours mieux que l'IP Railway directe).
- **Si pas de proxy :** ❌ IP Railway exposée — risque de ban élevé.

### 2.5 Proxy Sticky sur Durée JWT
- **Risque :** Même JWT vu depuis N IPs différentes en 55 min = fingerprint bot.
- **Statut :** ✅ COUVERT — `proxyUrl` + `uaIndex` stockés dans `CachedToken`, restaurés à chaque cache hit.

### 2.6 DNS Leak
- **Risque :** undici résout les DNS via le serveur Railway même en mode proxy → le portail voit l'IP du serveur Railway dans les requêtes DNS.
- **Statut :** ⚠️ PARTIEL — `ProxyAgent` undici en mode HTTP tunnel devrait résoudre les DNS via le proxy. À vérifier sur Railway.
- **Action :** Ajouter `connect: { rejectUnauthorized: false }` et vérifier que les DNS passent bien par le proxy (`HTTPS_PROXY` env var).

### 2.7 IPv6 Leak
- **Risque :** Si Railway expose une adresse IPv6 et que le proxy ne tunnèle que IPv4, le portail peut voir l'IPv6 directe.
- **Statut :** 🔍 SURVEY — Vérifier `NODE_OPTIONS=--dns-result-order=ipv4first` sur Railway.

---

## 3. HTTP Headers & Fingerprint Applicatif

### 3.1 User-Agent (Chrome/Edge uniquement pour USA)
- **Statut :** ✅ COUVERT — `USA_UA_POOL` contient Chrome 134-136 + Edge 136 sur Windows/macOS uniquement.
- **Règle :** Jamais Firefox/Safari/Opera dans le pool USA — le portail Angular est conçu pour Chrome.
- 🔁 **À mettre à jour :** quand Chrome dépasse +10 versions (actuellement Chrome 136 → max Chrome 126 toléré).

### 3.2 Accept-Encoding : zstd manquant ❌
- **Problème :** Chrome 123+ envoie `gzip, deflate, br, zstd`. undici n'envoie que `gzip, deflate, br`.
- **Impact :** Fingerprint JA4H différent — identifiable par un WAF analysant les headers.
- **Action :** Ajouter dans `getBrowserHeaders()` : `"Accept-Encoding": "gzip, deflate, br, zstd"`
- **Statut :** ✅ CORRIGÉ dans cette version.

### 3.3 Accept-Language
- **Valeur :** `fr-CD,fr;q=0.9,en-US;q=0.6,en;q=0.5`
- **Statut :** ✅ OK — Locale légitime pour des ressortissants congolais. Compatible avec des IPs résidentielles européennes/US.

### 3.4 Sec-CH-UA (Client Hints)
- **Statut :** ✅ COUVERT — `chUa` dans `USA_UA_POOL` correspond exactement à la version Chrome.
- **Cohérence :** `Chrome/136` → `"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"` ✅

### 3.5 Sec-Fetch-* headers
- **Statut :** ✅ COUVERT — `Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`, `Sec-Fetch-Site: same-origin` dans `getBrowserHeaders()`.

### 3.6 Origin et Referer par étape
- **Statut :** ✅ COUVERT — 4 referers distincts selon l'étape de navigation (`REFERER_LOGIN`, `REFERER_DASHBOARD`, `REFERER_REQUESTS`, `REFERER_CREATE_APT`).

### 3.7 LanguageId header manquant ⚠️
- **Problème :** Le bundle Angular envoie `LanguageId: 1` (ou autre) sur toutes les requêtes authentifiées. Son absence crée une différence structurelle avec le vrai portail.
- **Action :** Ajouter `"LanguageId": "1"` dans `getBrowserHeaders()`.
- **Statut :** ✅ CORRIGÉ dans cette version.

### 3.8 X-XSRF-TOKEN header (Angular HttpClient built-in)
- **Problème :** Angular HttpClient envoie automatiquement `X-XSRF-TOKEN: {csrfToken}` (depuis le cookie `XSRF-TOKEN`) sur toutes les requêtes. Notre bot envoie uniquement `CookieName: XSRF-TOKEN=…` (custom interceptor).
- **Impact :** Si le backend valide les deux, nos PUT échoueraient avec 403.
- **Statut :** ⚠️ PARTIEL — Si PUT `/schedule` retourne 403 sans raison → ajouter `"X-XSRF-TOKEN": csrfToken` dans le header.
- **Action si problème :** Dans `scheduleUsaAppointment()`, ajouter `"X-XSRF-TOKEN": session.csrfToken` aux headers PUT.

### 3.9 Cookie header
- **Problème :** Un vrai navigateur envoie les cookies accumulés (session, analytics, XSRF-TOKEN). Notre bot ne gère pas les cookies.
- **Statut :** ⚠️ PARTIEL — Le portail ne semble pas valider les cookies analytics (pas de cookie check visible dans le bundle). Si 401 inexpliqué → ajouter gestion cookies.

---

## 4. Authentification & Gestion des Tokens

### 4.1 Chiffrement des credentials
- **Algorithme :** PBKDF2(SHA1, 1000 iter, 32 bytes) → AES-256-CBC
- **Format :** `salt_hex(32) + iv_hex(32) + base64(ciphertext)`
- **Statut :** ✅ COUVERT — `encryptPortalCredentials()` dans `usaPortal.ts`.

### 4.2 Cache JWT (55 minutes)
- **Statut :** ✅ COUVERT — `tokenCache` Map, invalidation via `isCachedTokenValid()` avec buffer de 5 min.
- **Sticky :** ✅ proxyUrl + uaIndex liés à la durée du token.

### 4.3 Refresh Token
- **Payload requis :** `{ refreshToken, username }` (le `username` est requis — bug corrigé).
- **Statut :** ✅ COUVERT.

### 4.4 applicantUUID dans le payload de réservation
- **Statut :** ✅ COUVERT — ajouté dans `UsaAppDetails` + `basePayload`.

### 4.5 CSRF sur PUT
- **Statut :** ✅ COUVERT — `CookieName: XSRF-TOKEN={csrfToken}` sur tous les PUT.
- **Voir aussi :** §3.8 pour `X-XSRF-TOKEN`.

---

## 5. Patterns Comportementaux

### 5.1 Ordre de navigation
- **Séquence obligatoire (portail Angular) :**
  1. `callLandingPage`
  2. `callSanityCheck(slotBooking)`
  3. `checkFcsPayment`
  4. `getApplicationDetails`
  5. `getOfcList`
  6. `getFirstAvailableMonth` (pre-scan)
  7. `getSlotDates`
  8. `getSlotTime`
  9. PUT `/appointments/schedule`
  10. `callSanityCheck(appointmentLetter)`
  11. POST `/appointmentLetter`
- **Statut :** ✅ COUVERT — ordre respecté dans `runUsaApiSession()`.

### 5.6 Analyse Bundle → Bot (audit complet 2026-04-02, session 1)
Analyse exhaustive du bundle Angular (`main.dc91e3f7b5f67caa.js`) comparée au code du bot. **3 bugs trouvés et corrigés** :

| # | Composante | Bug | Correction |
|---|---|---|---|
| B1 | `getSlotTime` payload | Bot envoyait `fromDate`+`toDate` absents du bundle (bundle: `{postUserId, applicantId, slotDate, visaType, visaClass, applicationId}` uniquement) | `slotTimePayload` déduit — sans `fromDate`/`toDate` |
| B2 | `getallbyuser` URL | `?type=GROUPREQUEST` manquant (bundle: `"/appointmentrequest/getallbyuser?type=GROUPREQUEST"`) | Param ajouté à `USA_APPT_REQUESTS_URL` |
| B3 | `getApplicationDetails` param `applicantId=` | Bot envoyait `session.userID` (ID login) au lieu de l'`applicantId` interne. Bundle: paramètre = `selectedSlotDetails.applicantId` | `session.applicantId` propagé depuis `getUserHistoryApplicantPaymentStatus`; fallback `userID` si absent |

**Points confirmés conformes au bundle :**
- `RANDOME_ID` = routing Angular client-side uniquement (`/principal/{n}/appointment...`) — jamais envoyé au serveur ✅
- `getUserHistoryApplicantPaymentStatus` : retourne `pendingAppoStatus`, `applicationId`, `missionId` — logique bot correcte ✅
- `APP_ID_TOBE` + `missionId` cookies : définis via `setCookieByDeleteOld` après login — reproduit dans `sessionHeaders` ✅
- `getFirstAvailableMonth` payload = `{postUserId, applicantId, visaType, visaClass, locationType, applicationId}` ✅
- `getSlotDates` payload = `{...base, fromDate, toDate}` ✅
- PUT `/appointments/schedule` = `bookSlot(h)` ✅
- `locationType: "OFC"` forcé dans payload ✅

### 5.7 Analyse Bundle → Bot (audit complet 2026-04-02, session 2)
Suite de l'audit du bundle. **5 bugs supplémentaires trouvés et corrigés** :

| # | Composante | Bug | Correction |
|---|---|---|---|
| B4 | `getSlotTime` payload (correction session 1 erronée) | La session 1 avait **retiré** `fromDate`/`toDate` de `getSlotTime` — le bundle confirme qu'ils sont **présents** (`filterSlots() → let Oe = {fromDate, toDate, slotDate, ...}`). De plus, `locationType` était inclus à tort (uniquement dans `getSlotDates`). | Payload reconstruit : `{fromDate, toDate, postUserId, applicantId, slotDate, visaType, visaClass, applicationId}` — sans `locationType` |
| B5 | Détection MFA login | `UsaLoginResponse` ne contenait pas le champ `mfa`. Si le serveur retourne `mfa: 1`, le bot continue avec un token invalide. | `mfa?: number \| boolean` ajouté à l'interface; throw `MFA error` si truthy avant validation `isActive` |
| B6 | Détection `firstTimeLogin` | `UsaLoginResponse` ne contenait pas `firstTimeLogin`. Si présent, le portail force un changement de mot de passe. | `firstTimeLogin?: boolean` ajouté; throw erreur explicite |
| B7 | `getApplicationDetails` — réponse tableau non parsée | Le bot lisait la réponse comme un objet unique (`as UsaAppDetails`) alors que le bundle confirme que c'est un **tableau**. Angular filtre par `appointmentStatus === "NEW"` et prend `[0]`. | Parse `raw` en tableau, filtre sur `"NEW"`, `fallback` au premier si aucun "NEW" |
| B8 | `appointmentId`/`applicantUUID` — mauvaise source | Ces champs viennent de `getApplicationDetails` (bundle: `selectedSlotDetails = relatedAppList[0]`), pas de `getUserHistoryApplicantPaymentStatus`. Interface `UsaAppDetails` manquait `appointmentId`. | Ajout `appointmentId?`, `appointmentStatus?`, `appointmentLocationType?` dans `UsaAppDetails`; propagation vers `session.appointmentId`/`session.applicantUUID` après `getUsaApplicationDetails()` |

**Points confirmés conformes au bundle (session 2) :**
- Login body = `{authorization: "Basic <AES_encrypted>"}` en JSON (pas dans les headers) ✅
- Login headers = 4 headers CORS-like non-standard (`Access-Control-Allow-*` envoyés en request) — serveur les ignore; bas risque ✅
- `userID` (majuscule D) = champ exact dans la réponse login body ✅
- `loginUser()` : `window.sessionStorage.clear()` avant login — compatible avec le reset de session du bot ✅
- `getApplicationDetails` URL = `?applicationId={appId}&applicantId={applicantId}` (applicationId EN PREMIER) ✅
- `getFirstAvailableMonth` payload = sans `fromDate`/`toDate` — uniquement `{postUserId, applicantId, visaType, visaClass, locationType, applicationId}` ✅
- `getSlotDates` payload = avec `locationType` + `fromDate`/`toDate` ✅
- OFC list items ont les champs `postUserId`, `ofcName`, `officeType` ✅

### 5.2 Délais inter-requêtes
- **Statut :** ✅ COUVERT — `randomDelay()` avec paramètres min/max variables entre chaque appel.
- **Risque 2026 :** Les WAF ML analysent la distribution statistique des délais. Si les délais sont toujours dans une fourchette trop étroite, le pattern est détectable.
- **Amélioration :** Varier la durée totale de session (parfois naviguer vers un OFC inexistant, ou lire les détails du dossier avant le scan).

### 5.3 Fréquence de login
- **Risque :** Logins toujours à intervalles de 55 min (JWT cache expiry) → pattern détectable.
- **Mitigation :** `TOKEN_REFRESH_BUFFER_MS = 5 min` ajoute une légère variation. Ajouter un jitter de ±5 min.

### 5.4 Rush Mode
- **Fenêtres :** 00h-02h, 07h-09h, 12h-14h (Kinshasa UTC+1).
- **Intervalle tres_urgent :** 1-2 min planifié, effectif ~3 min (session ~2 min + silence ~67s).
- **Statut :** ✅ COUVERT.

### 5.5 Silence Radio
- **Normal :** 2-3 min | **Rush :** 45-90s.
- **Statut :** ✅ COUVERT — cooldown entre sessions pour éviter la détection de fréquence.

---

## 6. Anti-Bot Libraries (WAF)

### 6.1 Présents dans le bundle actuel
| Library | Présente | Gérée |
|---------|---------|-------|
| Google reCAPTCHA v2 | ✅ OUI | ✅ 2captcha |
| Cloudflare Bot Management | ❌ Non | N/A |
| Akamai Bot Manager | ❌ Non | N/A |
| Kasada | ❌ Non | N/A |
| DataDome | ❌ Non | N/A |
| PerimeterX / HUMAN | ❌ Non | N/A |
| Imperva / Incapsula | ❌ Non | N/A |
| Shape / F5 | ❌ Non | N/A |
| AWS WAF | ❌ Non | N/A |
| Arkose Labs | ❌ Non | N/A |

🔁 **À vérifier :** Si le portail migre vers Cloudflare (signe : challenge JS dans le HTML, cookie `cf_clearance`), la stratégie doit changer radicalement (Playwright via Cloudflare bypass ou service anti-Cloudflare).

### 6.2 Signaux reCAPTCHA
- **Sitekey :** `6LcpAXklAAAAAFUYDDE8NlsuSb69b5GbXg3sEmaZ`
- **Type :** reCAPTCHA v2 invisible (vérifie le comportement utilisateur, challenge si suspect).
- **Gestion :** 2captcha résout le token → envoyé dans le payload de login.
- **Risque 2026 :** Google renforce la détection des résolveurs automatiques. Si le taux d'échec 2captcha augmente, envisager noCAPTCHA/CapSolver/CapMonster comme alternatives.

---

## 7. Vecteurs Émergents 2026

### 7.1 Fingerprinting ML-based
- **Cloudflare / Akamai ML :** Analyse de 100+ signaux combinés : délais entre requêtes, ordre des headers, TLS cipher suite, mouse entropy, etc.
- **Mitigation :** Nos délais aléatoires + sticky proxy + UA cohérent couvrent les signaux les plus basiques. Si détection ML → migrer vers un vrai navigateur headless pour tous les appels.

### 7.2 Device Integrity Signals (2026)
- **Problème :** Certains portails commencent à vérifier des signaux d'intégrité matérielle (WebAuthn, Secure Enclave, Device Fingerprint). Non applicable à ce portail actuellement.
- **Statut :** 🔍 SURVEY.

### 7.3 Server-Side Request Validation
- **HTTP/2 Push :** Le serveur peut pousser des ressources supplémentaires que le bot ne demande pas, puis vérifier leur chargement. Non détecté actuellement.
- **Statut :** 🔍 SURVEY.

### 7.4 Behavioral Graph Analysis
- **Risque 2026 :** Systèmes qui construisent un graphe de comportement sur plusieurs sessions et identifient les comptes qui partagent un pattern (même timing, même IP, même UA au fil du temps).
- **Mitigation :** Sticky proxy par JWT limite l'exposition. Varier les sessions normales (parfois ajouter un délai de lecture du tableau de bord).

---

## 8. Circuit Breakers & Auto-Protection

| Scénario | Seuil | Comportement | Statut |
|----------|-------|-------------|--------|
| Login échoué (mauvais credentials/portail KO) | 3 consécutifs | Auto-pause + heartbeat Convex | ✅ |
| Erreur transitoire (429/403/réseau) | 5 consécutifs | Auto-pause + heartbeat Convex | ✅ |
| 429 (rate limit) | 1 | RateLimitError → arrêt session immédiat | ✅ |
| 403 (banned) | 1 | AccountBlockedError → arrêt session | ✅ |
| 401 en cours de scan | 1 | TokenExpiredError → refresh → retry | ✅ |
| Clé AES changée | 1/24h | Pause tous les jobs USA + log ERROR | ✅ |
| Session timeout Playwright | 3-5 min | withTimeout → error | ✅ |
| Session timeout USA API | 8 min | withTimeout → error | ✅ |

---

## 9. Actions Recommandées (Priorité)

### Critique (blocker)
- [x] ~~Configurer `TWOCAPTCHA_API_KEY` sur Railway~~ ✅ configuré
- [x] ~~Configurer `CONVEX_SITE_URL` sur Railway~~ ✅ configuré
- [x] ~~Configurer `HUNTER_API_KEY` sur Railway~~ ✅ configuré
- [ ] Whitélister l'IP Railway sur 2captcha.com/proxy

### Haute priorité (amélioration sécurité)
- [x] ~~Add `Accept-Encoding: gzip, deflate, br, zstd`~~ ✅ corrigé
- [x] ~~`LanguageId` sur tous les appels~~ ✅ **BUG CORRIGÉ** (2026-04-02) — Le header ne doit être présent que sur `/getLandingPageDeatils` et `/generatewizardtemplate`. Il était dans `getBrowserHeaders()` (= toutes les requêtes). Retiré de `getBrowserHeaders()`, ajouté exclusivement dans `callLandingPage()`.
- [x] ~~`appointmentId` absent du payload de booking~~ ✅ **BUG CORRIGÉ** (2026-04-02) — `appointmentId` (bundle: `selectedSlotDetails.appointmentId`) était absent du PUT `/appointments/schedule`. Ajouté dans `UsaAppointmentRequest`, `UsaSession`, propagé depuis `checkUsaAppointmentRequestStatus()`, injecté dans `bookUsaSlot()`.
- [x] ~~`appointmentTime` en format 24h~~ ✅ **BUG CORRIGÉ** (2026-04-02) — Le portail envoie le format 12h AM/PM `"9:00 AM"` (via `setUItime()`). Le bot envoyait `"09:00"` (24h brut). Fonction `formatUItime()` ajoutée, reproduit exactement `setUItime()` du bundle Angular.
- [x] ~~Ajouter `X-XSRF-TOKEN: {csrfToken}` aux headers PUT~~ ✅ corrigé — `bookUsaSlot()` envoie maintenant `CookieName` + `X-XSRF-TOKEN`
- [x] ~~Ajouter jitter ±5 min sur `TOKEN_REFRESH_BUFFER_MS`~~ ✅ corrigé — `CachedToken.jitterMs` [−300s, +300s] par compte

### Surveillance régulière (mensuel)
- [ ] Mettre à jour Chrome dans `USA_UA_POOL` (max +10 versions derrière stable)
- [ ] Relancer `npx tsx src/securityCheck.ts` après chaque mise à jour du portail
- [ ] Vérifier les logs Railway pour patterns 403/429 répétés

### Long terme (si portail se durcit)
- [ ] Si WAF commercial détecté → migrer USA vers Playwright complet (TLS correct)
- [ ] Si reCAPTCHA v3 ajouté → adapter la résolution 2captcha (token `action`)
- [ ] Si Cloudflare ajouté → service de bypass CF ou Playwright + cf_clearance

---

## 10. Infrastructure d'Analyse Bundle (2026-04-02)

### Structure des fichiers

```
bundle-analysis/
  bundle.js                       # Bundle Angular local (2MB, gitignore)
  extract-bundle.ts               # Extraction bundle → 20 sections JSON
  extract-bot.ts                  # Extraction bot → 16 sections JSON
  compare.ts                      # Comparaison bundle ↔ bot → rapport MD + JSON
  sections/                       # 20 JSON sections du bundle (gitignore)
  bot-sections/                   # 16 JSON sections du bot (gitignore)
  reports/
    bundle-summary.md             # Rapport d'extraction bundle complet
    comparison.md                 # Rapport de comparaison final
    divergences.json              # Divergences critiques en JSON
```

### Comment regénérer l'analyse complète

```bash
# 1. Télécharger le bundle (si changement de hash)
cd artifacts/slot-hunter
FULL_CHECK=true npx tsx src/securityCheck.ts
cp /tmp/bundle.js bundle-analysis/bundle.js

# 2. Extraire les sections
npx tsx bundle-analysis/extract-bundle.ts
npx tsx bundle-analysis/extract-bot.ts

# 3. Générer le rapport de comparaison
npx tsx bundle-analysis/compare.ts
```

### Résultats de l'analyse 2026-04-02

| Statut | Nombre | Endpoints |
|--------|--------|-----------|
| ✅ Conforme | 48 | Tous |
| ⚠️ Mineure | 6 | login, paymentStatus, ofcList |
| ❌ Critique | **0** | — |
| ❓ Non vérifié | 0 | — |

**Bot actuellement 100% sans divergences critiques.**

### Warnings en cours (non-bloquants)

| # | Endpoint | Warning | Statut |
|---|---------|---------|--------|
| W1 | login | 4 headers CORS non-standard non envoyés (serveur les ignore) | 🔍 Risque faible — à ajouter si fingerprint détecté |
| W2 | login | `sessionStorage.clear()` vs tokenCache en mémoire | ✅ Comportement équivalent — aucune action |
| W3 | paymentStatus | `appointmentId`/`applicantUUID` confirmés depuis `getApplicationDetails` | ✅ Correct par design |
| W4 | ofcList | Endpoint `/ofcuser/ofclist` vs `/lookupcdt/wizard/getpost` en booking | ✅ **CORRIGÉ** (2026-04-02) — bot utilise `/lookupcdt/wizard/getpost?visaCategory=&visaClass=&stateCode=&priority=&missionId=` |
| W5 | ofcList | `officeType === "OFC"` filtre | ✅ Implémenté |
| W6 | ofcList | Filtre OFCs autorisés du compte (`loggedInApplicantUser.ofc`) | ✅ **CORRIGÉ** (2026-04-02) — `data.ofc` extrait au login → `session.allowedOfcs` → filtre appliqué dans `getUsaOfcList` |
| W7 | ofcList | `stateCode` et `appointmentPriority` manquants dans l'URL OFC list | ✅ **CORRIGÉ** (2026-04-02) — `getTransformData(applicationId)` appelé à l'étape 2a → `session.stateCode` + `session.appointmentPriority` → passés comme `?stateCode=&priority=` |

### Sections couvertes par l'analyse

| ID | Endpoint | Méthode | URL |
|----|---------|---------|-----|
| 01 | login | POST | `/identity/user/login` |
| 02 | verifyMfa | POST | `/identity/verifyMfa` |
| 03 | refreshToken | POST | `/identity/refreshToken` |
| 04 | logout | POST | `/identity/logout` |
| 05 | paymentStatus | GET | `/workflow/getUserHistoryApplicantPaymentStatus` |
| 06 | getApplicationDetails | GET | `/appointments/getApplicationDetails?applicationId=&applicantId=` |
| 07 | getLandingPage | GET | `/appointment/getLandingPageDeatils` |
| 08 | ofcList | GET | `/ofcuser/ofclist/{missionId}` |
| 09 | getFirstAvailableMonth | POST | `/modifyslot/getFirstAvailableMonth` |
| 10 | getSlotDates | POST | `/modifyslot/getSlotDates` |
| 11 | getSlotTime | POST | `/modifyslot/getSlotTime` |
| 12 | bookSlot | PUT | `/appointments/schedule` |
| 13 | rescheduleAppointment | PUT | `/appointments/reschedule` |
| 14 | httpInterceptor | ALL | Intercepteur global |
| 15 | sanityCheck | GET | FCS + workflow check |
| 16 | appointmentLetter | POST | `/template/appointmentLetter` |
| 17 | csrfAndCookies | N/A | Mécanique XSRF-TOKEN |
| 18 | cryptoEncryption | N/A | AES-256-CBC |
| 19 | bookSlotPayloadConstruction | N/A | Construction payload |
| 20 | tokenStorage | N/A | SessionStorage |

---

## 11. Historique des Checks

| Date | Bundle Hash | AES Key | CAPTCHA Key | Résultat |
|------|------------|---------|-------------|---------|
| 2026-04-02 | `main.dc91e3f7b5f67caa.js` | `OuoCdl...` (inchangée) | `6LcpAXkl...` (inchangée) | ✅ PASS |

> Mettre à jour cette table à chaque vérification manuelle ou incident.
