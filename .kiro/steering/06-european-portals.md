# Portails européens — CEV Belgique, Espagne, Suisse

## Vue d'ensemble

Le hunter gère 3 portails européens distincts, chacun avec sa propre stack et ses défenses anti-bot.

| Portail | Domaine | Protection | Captcha | Session |
|---------|---------|-----------|---------|---------|
| **CEV Belgique** | `appointment.cloud.diplomatie.be` | F5 BIG-IP | hCaptcha | `ASP.NET_SessionId` |
| **Espagne** | `citaconsular.es` (Bookitit) | Cloudflare Managed Challenge | Turnstile | Cookies CF |
| **Suisse** | `swiss-visa.ch/ivis2` | XSRF Angular + captcha image | Image serveur | Cookie `XSRF-TOKEN` + `Token` header |

---

## 1. CEV Belgique (Schengen) — Portail principal

### Architecture

- **VOWINT** (`visaonweb.diplomatie.be`) : portail de demande (AngularJS + ASP.NET)
- **CEV** (`appointment.cloud.diplomatie.be`) : système de RDV (jQuery + ASP.NET MVC)
- Le flux va de VOWINT → blob POST → CEV (session cookie posé)

### Fichiers source

| Fichier | Rôle |
|---------|------|
| `src/cevPortal.ts` | Session captcha, polling `/Home/AvailableTimeSlots` |
| `src/cevBooking.ts` | Booking complet via Playwright (fallback) |
| `src/cevHttpBooking.ts` | Booking HTTP pur (~5-10s, sans Playwright) |
| `src/cevHttpSetup.ts` | Setup session HTTP : VOWINT login → CEV cookie → hCaptcha |
| `src/cevPolling.ts` | Polling optimisé (50ms/check, zéro Playwright) |
| `src/cev_discovery.ts` | Script d'exploration/reverse engineering |

### Fichiers VOWINT reverse-engineered

| Fichier | Contenu |
|---------|---------|
| `src/vowint-reverse/README.md` | Documentation complète du reverse VOWINT |
| `src/vowint-reverse/app.js` | Bootstrap AngularJS (`osOnline`) + constantes ACTOR |
| `src/vowint-reverse/commonController.js` | Contrôleur commun, baseUrl, GDPR endpoints |

### Analyses de bundle

| Fichier | Contenu |
|---------|---------|
| `EU_VISA_SYSTEM_ANALYSIS.md` | Analyse complète du système CEV (endpoints, flux, stratégie) |
| `bundle-analysis/download-cev-bundle.js` | Script de téléchargement du bundle CEV |
| `bundle-analysis/analyze-cev.mjs` | Extraction endpoints/fonctions du bundle |
| `bundle-analysis/cev-bundle.js` | Bundle JS capturé (minifié) |
| `eu_visa_system_bundle/` | Bundle complet (HTML + CSS + JS + images) |

### Flux de polling CEV (stratégie optimale)

```
1. Login VOWINT → cookies session
2. GET /Common/GetEAppointmentUrl?id={appId} → URL intégration (= 1 clic, max 5/h)
3. GET {integrationUrl} → cookie ASP.NET_SessionId CEV
4. Résoudre hCaptcha (Anti-Captcha $0.003/solve)
5. POST /Captcha/SetCaptchaToken {captcha: token} → {validUntil, redirectUrl}
6. POLLING (tant que session valide, ~15-20 min) :
   POST /Home/AvailableTimeSlots {month, year} → JSON slots
   Coût : ~50ms/requête, zéro captcha, zéro Playwright
7. Si slot trouvé → booking HTTP pur (cevHttpBooking.ts)
8. Si session expirée → retour étape 2 (1 clic supplémentaire)
```

### Contraintes critiques

- **Limite 5 clics/heure** par AppId sur VOWINT (le bot garde 1 de marge → max 4)
- **hCaptcha sitekey** : `5f64399c-14a8-415e-ad1a-7ebccdc4943a` (blacklistée par CapSolver → utiliser Anti-Captcha)
- **Headers obligatoires** : `X-Requested-With: XMLHttpRequest`, `Cookie`, `Referer`
- **Session CEV** : ~15-20 min de validité après captcha résolu
- `redirectUrl` contient `NoAvailability` → pas de slots ; sinon → slots disponibles

### Endpoints API confirmés

```
POST /Captcha/SetCaptchaToken          → form-urlencoded {captcha: <token>} → {validUntil, redirectUrl}
POST /Home/AvailableTimeSlots          → JSON {month, year} → slots[]
POST /Shared/DoCancelRequestAppointment → form-urlencoded {uniqueToken, cultureCode}
GET  /Integration/VOW/SelectSlot/...   → page calendrier (server-rendered)
GET  /Integration/Error/NoAvailability → aucun créneau
GET  /Integration/Error/SessionExpired → session expirée
```

---

## 2. Espagne (CitaConsular / Bookitit)

### Architecture

- **CitaConsular.es** : portail officiel (Cloudflare protégé)
- **Bookitit** : système de réservation sous-jacent (API REST)
- Protection Cloudflare Managed Challenge (Turnstile)

### Fichiers source

| Fichier | Rôle |
|---------|------|
| `src/spainPortal.ts` | Portail complet Espagne (Playwright + cache) |
| `src/citaconsularBookitit.ts` | Client API Bookitit |
| `src/citaconsularDiscovery.ts` | Script d'exploration |
| `src/spain/bookitit-client.ts` | Client Bookitit typé |
| `src/reverse-spain.ts` | Reverse engineering du portail |
| `src/cloudflare-strategies.ts` | Stratégies bypass Cloudflare |
| `src/cloudflare-solver.ts` | Résolution Cloudflare (Capsolver) |

### Scripts de test Cloudflare

| Script | Usage |
|--------|-------|
| `test-cloudflare-strategies.ts` | Tests bypass Cloudflare |
| `final-solution-spain.ts` | Solution finale Cloudflare cookies |
| `capture-manual-cookie.ts` | Capture manuelle cookies CF |
| `test-web-unlocker.ts` | Tests BrightData Web Unlocker |

### Stratégie

1. Obtenir `cf_clearance` cookie (via Capsolver Turnstile ou cookie manuel)
2. Appeler API Bookitit avec cookies CF valides
3. Détecter créneaux disponibles
4. Booking via Playwright (OTP email/SMS peut être requis)

### Contraintes

- Cloudflare Managed Challenge = le plus dur à bypasser
- Proxy résidentiel/ISP obligatoire (IP France/Espagne)
- Cookie `cf_clearance` expire après ~30 min
- Timezone `Europe/Madrid` + locale `es-ES` obligatoires

---

## 3. Suisse (swiss-visa.ch/ivis2)

### Architecture

- **Angular 17** + webpack (bundle `main.js` 6.7 MB)
- **Backend** : `swiss-visa.ch/ivis2/rest/` (same-origin API)
- **Captcha** : image personnalisée serveur (pas hCaptcha/reCAPTCHA)
- **Auth** : Token par email (`benutzerSessionId`) → header `Token: {id}`

### Fichiers d'analyse

| Fichier | Contenu |
|---------|---------|
| `swiss_bundle/ANALYSE_CH.md` | Analyse exhaustive (endpoints, flux, DTOs, captcha) |
| `swiss_bundle/` | Bundle Angular complet capturé |

### Flux spécifique Suisse

```
Phase 1 — Inscription (une seule fois) :
  1. GET /ivis2/ → cookie XSRF-TOKEN
  2. GET /ivis2/rest/zav/getZAVbyLandCode/{code} → trouver ZAV avec internetTerminVerwaltung=true
  3. GET /ivis2/rest/captcha/create/{sessionId}/{timestamp} → image captcha
  4. Résoudre captcha (OCR ou service externe)
  5. POST /ivis2/rest/benutzer/session/create/{sessionId}/{btoa(captcha)}
  6. Email envoyé → extraire benutzerSessionId du lien

Phase 2 — Polling / détection :
  1. PUT /ivis2/rest/benutzer/session/login → Token obtenu
  2. POST /ivis2/rest/antrag/create/{lang} → déclenche assignation slot
  3. GET /ivis2/rest/termin/find/user/{benutzerSessionId} → slots assignés ?
  4. Si slot → PUT /ivis2/rest/termin/confirm
```

### Particularité critique

> **Le serveur ASSIGNE le créneau automatiquement.** Il n'y a PAS de sélection par l'utilisateur.
> `POST /antrag/create` déclenche l'assignation. `GET /termin/find/user` révèle le résultat.

### Headers requis

```http
X-XSRF-TOKEN: <valeur du cookie XSRF-TOKEN>   # Sur POST/PUT/DELETE uniquement
Token: <benutzerSessionId>                      # Après login
Cookie: XSRF-TOKEN=<uuid>                      # Toujours
```

---

## 4. Routing dans le bot principal

Le dispatcher dans `src/index.ts` route selon `job.destination` :

```typescript
if (due.destination === "schengen") {
  result = await runCevCheck(due);     // → cevBooking.ts / cevHttpSetup.ts
} else if (due.destination === "spain" || due.destination === "espagne") {
  result = await runSpainSession(due); // → spainPortal.ts
} else {
  result = await runHunterSession(due); // USA / autres
}
```

---

## 5. Variables d'environnement spécifiques EU

```bash
# CEV Belgique
VOWINT_TEST_PASSWORD=...           # Mot de passe compte test VOWINT
ANTICAPTCHA_API_KEY=...            # Anti-Captcha (hCaptcha CEV)
CAPSOLVER_API_KEY=...              # CapSolver (Cloudflare Espagne)
HCAPTCHA_ACCESSIBILITY_COOKIE=...  # Cookie accessibilité hCaptcha (gratuit, fallback)

# Proxies
IPROYAL_PROXY_URL=...              # Proxy IPRoyal pour polling CEV
BRIGHTDATA_PROXY_URL=...           # BrightData pour Espagne (IP France/Espagne)
```

---

## 6. Checklist avant modification d'un portail européen

- [ ] Bundle correspondant téléchargé et à jour (< 1 semaine)
- [ ] Endpoints vérifiés dans le bundle (pas juste dans le code existant)
- [ ] Headers/cookies conformes au bundle réel
- [ ] Limites de rate respectées (5 clics/h CEV, rotation IP Espagne)
- [ ] Timezone et locale corrects (`Europe/Madrid`, `Europe/Brussels`, `Europe/Zurich`)
- [ ] Tests avec compte réel avant commit

## Références

- #[[file:artifacts/slot-hunter/EU_VISA_SYSTEM_ANALYSIS.md]]
- #[[file:artifacts/slot-hunter/swiss_bundle/ANALYSE_CH.md]]
- #[[file:artifacts/slot-hunter/src/cevPortal.ts]]
- #[[file:artifacts/slot-hunter/src/cevBooking.ts]]
- #[[file:artifacts/slot-hunter/src/cevHttpSetup.ts]]
- #[[file:artifacts/slot-hunter/src/cevPolling.ts]]
- #[[file:artifacts/slot-hunter/src/spainPortal.ts]]
- #[[file:artifacts/slot-hunter/src/cloudflare-strategies.ts]]
- #[[file:artifacts/slot-hunter/src/vowint-reverse/README.md]]
- #[[file:artifacts/slot-hunter/bundle-analysis/download-cev-bundle.js]]
- #[[file:artifacts/slot-hunter/bundle-analysis/analyze-cev.mjs]]
