# Analyse du bundle VFS Global UK — `atlantis-abs-uk.vfsglobal.com`

> Reverse-engineering complet du bundle Angular (`main.js` 1.8 MB) capturé depuis le portail UK Visas & Immigration de VFS Global.

---

## 1. Identité de l'application

| Champ | Valeur |
|-------|--------|
| **URL frontend** | `https://atlantis-abs-uk.vfsglobal.com` |
| **URL API backend** | `https://atlantis-absapi-uk.vfsglobal.com/` |
| **Framework** | Angular (bundle Webpack, lazy-loaded modules) |
| **Tenant** | `UKVI` |
| **Mission code** | `GBR` (défaut) |
| **GTM** | `GTM-KCT7T5SV` |
| **Environnement** | `prod` |

---

## 2. Authentification — AWS Cognito

L'app utilise **AWS Amplify JS** avec Cognito. Aucun identifiant de pool n'est hardcodé dans le bundle (ils sont chargés dynamiquement depuis Contentful CMS). Trois flux sont supportés :

### Flux SRP (défaut)
```
authFlowType: "USER_SRP_AUTH"
Challenges: SRP_A → PASSWORD_VERIFIER
```

### Flux password direct
```
authFlowType: "USER_PASSWORD_AUTH"
```

### Flux custom SRP
```
authFlowType: "CUSTOM_WITH_SRP"
```

### Token storage
- Tokens stockés dans **localStorage** via Amplify (clés préfixées `CognitoIdentityServiceProvider.<userPoolClientId>`)
- `sessionStorage.accessToken` — copie de l'access token utilisée par les appels API
- Clé `LastAuthUser` : `CognitoIdentityServiceProvider.<userPoolClientId>.LastAuthUser`

### Keycloak (fallback pour Russie/Biélorussie)
```javascript
// Uniquement pour RUS / blrURL
POST <keycloakUrl>
Content-Type: application/x-www-form-urlencoded
Body: grant_type=password&client_id=...&username=<email.toLowerCase()>&password=<pwd.toLowerCase()>
// → Response: { access_token }
// Stocké dans sessionStorage.accessToken
```

---

## 3. CAPTCHA — Cloudflare Turnstile

| Champ | Valeur |
|-------|--------|
| **Type** | Cloudflare Turnstile |
| **Site key** | `0x4AAAAAAAZRJT8YvAW5mxao` |
| **Script URL** | `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` |
| **Mode** | `explicit` (intégré manuellement dans l'app Angular) |

> ⚠️ Turnstile est présent sur la page de connexion. Il faudra le résoudre via **CapSolver** (`TurnstileTaskProxyLess`) ou **2captcha** avant chaque login.

---

## 4. Routes Angular (lazy-loaded)

| Path | Module | Description |
|------|--------|-------------|
| `/sign-in` | `SignInModule` | Page de connexion |
| `/handshake` | `LandingModule` | Page d'accueil post-login |
| `/appointment-booking` | `AppointmentBookingModule` | Sélection de date/créneau |
| `/dashboard` | `DashboardModule` | Tableau de bord applicant |
| `/track-status` | `TrackStatusModule` | Suivi de statut |
| `/dashboard/cancel-appointment-confirm` | inline | Annulation RDV |
| `/maintenance` | `MaintenanceModule` | Page maintenance |
| `/accessibility` | `AccessibilityModule` | Accessibilité |

---

## 5. Endpoints API (base : `https://atlantis-absapi-uk.vfsglobal.com/`)

### 5.1 Handshake / Navigation (flux principal)

```
POST v1/applications/handshake
  → Initialise la session applicant

POST v1/applications/handshake/token
  → Variante avec token de handshake

POST v1/applications/navigation
  Headers: Authorization: Bearer <accessToken>
  Body: { missionId, missionCode, gWFNumber }   ← CHIFFRÉ (RSA "payment")
  → Retourne les données de navigation/AppData

POST v1/applications/handshakeconsent
  → Soumettre le consentement

POST v1/applications/saveconsent
  → Enregistrer le consentement

POST v1/applications/consent/check
  → Vérifier le statut du consentement

DELETE v1/applications/payload
  Body: { payloadReference: "..." }
  → Supprimer un payload en attente
```

### 5.2 Identité / Logout

```
POST v1/identity/invalidateToken
  Headers: Authorization: Bearer <accessToken>
  Body: { missionId, missionCode, gWFNumber }
  → Invalider le token (cas général)

POST v1/keycloakidentity/invalidateToken
  Headers: Authorization: Bearer <accessToken>
  → Invalider le token Keycloak (RUS)
```

### 5.3 Prise de RDV (AppointmentBooking module — lazy loaded)

La route `/appointment-booking` charge un module séparé (chunk 338). Les endpoints de disponibilité des créneaux sont dans ce chunk **non inclus dans main.js**. À intercepter en live via proxy.

### 5.4 Documents / Orchestration

```
POST orchestration/fetch-document-list
  Headers: Authorization: Bearer <accessToken>

POST orchestration/document-upload
  Headers: Authorization: Bearer <accessToken>

POST orchestration/ScanDocument
  Headers: Authorization: Bearer <accessToken>

DELETE orchestration/delete-document
  Headers: Authorization: Bearer <accessToken>, Content-Type: application/json

POST orchestration/doc-verification/doc-preview
POST orchestration/getappointmentletter   ← CHIFFRÉ (RSA "appointment")
POST v1/applications/geteicr              ← CHIFFRÉ (RSA "appointment")
POST v1/applications/doc-verification/document-list
POST v1/applications/doc-verification/status
  Headers: Content-Type: application/json
```

### 5.5 Paiement

```
POST v1/applications/payment/consulatefee   ← CHIFFRÉ (RSA "payment")
POST v1/applications/payment/process        ← CHIFFRÉ (RSA "payment")
POST v1/applications/payment/tracking       ← CHIFFRÉ (RSA "payTrack")
```

### 5.6 Service Level / Pre-SO

```
POST v1/ac-application/application/SearchServiceLevelPaymentPreSO
  Headers: x-api-key: <JWT interne>

POST /v1/ac-application/application/SavePreSOFeeDetails
  Headers: x-api-key: <JWT interne>
```

### 5.7 Config

```
GET v1/admin/configs/language
  → Récupérer la config langue
```

---

## 6. Chiffrement des payloads

Certains endpoints **chiffrent le body** avant envoi via un intercepteur Angular HTTP :

### Algorithme
1. Générer clé AES-128 aléatoire + IV 96-bit
2. Chiffrer le body JSON avec **AES-GCM**
3. Chiffrer la clé AES avec **RSA-OAEP (SHA-256)**
4. Envoyer : `{ encryptedPayload, token1 (AES key RSA-wrapped), token2 (IV), authTag }`

### Clés RSA publiques

**`payment`** (endpoints navigation, payment/process, payment/consulatefee) :
```
Modulus: xDkCER3dgOzU97uuH9iVrQGhoudFphBc7IbJqMVkW2AEXUNwVQ...
Exponent: AQAB
```

**`appointment`** (getappointmentletter, geteicr) :
```
Modulus: uv7+8AJ26cbr+AXGKSACtEmUT5NElPNMSO92C/fTStYRDb4KWbP...
Exponent: AQAB
```

**`payTrack`** (payment/tracking) :
```
Modulus: vR5iwPZ68rPm1VG89xV9EbyqIA8NjW1vz3r90iOPfwWAfSdGn...
Exponent: AQAB
```

---

## 7. Structure sessionStorage

Après login et navigation, les clés suivantes sont utilisées :

| Clé | Contenu |
|-----|---------|
| `accessToken` | Token Cognito (Bearer) |
| `landingScreenValue` | JSON complet `{ LandingPageData[0].AppData, LandingPageData[1].MCVData }` |
| `selectedServiceLevelValue` | Niveau de service sélectionné (`{ code, ... }`) |
| `selectedVacValue` | VAC sélectionné (`{ code, id, name }`) |
| `SelectedLanguage` | Langue (`"en-GB"`) |
| `choosedLanguage` | Langue choisie (court : `"en"`) |
| `languageName` | Nom langue |
| `locale_Form` | Locale formulaire |
| `params` | Paramètres URL |
| `selfUploadButton` | Flag upload |
| `sessionCleared` | Flag session nettoyée |
| `changeDirection` | Direction RTL/LTR |
| `hasLoggedIn` | Flag de connexion |

### Structure `AppData` (dans `landingScreenValue`)

```json
{
  "LandingPageData": [{
    "AppData": {
      "MissionCode": "GBR",
      "MissionId": 61,
      "CountryCode": "IND",
      "VacCode": "BKC",
      "VacId": 21,
      "GWFNumber": "GWF...",
      "ApplicantId": "...",
      "ApplicantEmail": "...",
      "GivenName": "...",
      "LastName": "...",
      "PhoneNumber": "...",
      "Nationality": "...",
      "VisaSubType": "...",
      "PostalCode": "...",
      "ServiceLevel": "...",
      "ServiceLevelCode": "...",
      "PaymentStatus": "...",
      "AppointmentScheduled": false,
      "DisplayFeedbackSection": false
    }
  }, {
    "MCVData": {
      "country": [{ "vac": [{ "vacName": "..." }] }]
    }
  }]
}
```

---

## 8. Clés API internes (hardcodées dans le bundle)

Deux **JWTs internes** sont hardcodés — utilisés uniquement pour les endpoints Pre-SO (`SearchServiceLevelPaymentPreSO`, `SavePreSOFeeDetails`, `getApplicantData`) :

### JWT 1 — VAC Mumbai BKC
```json
{
  "email": "DXC_APP_ArathiG@Vfsglobal.com",
  "userId": "32",
  "missionCode": "GBR",
  "countryOfOperationsCode": "IND",
  "vacCode": "BKC",
  "vacId": 21,
  "tenant": "UKVI",
  "roleCode": "SPVR,SSVR,SUOF,BIOF,DIOF,DOCV",
  "vacTimeZone": "+05:30",
  "vacType": "AC",
  "iat": 1770117973,
  "exp": 1770146773
}
```

### JWT 2 — VAC Bangkok CJB
```json
{
  "email": "DXC_APP_ArathiG@Vfsglobal.com",
  "userId": "32",
  "missionCode": "GBR",
  "countryOfOperationsCode": "IND",
  "vacCode": "CJB",
  "vacisocode4": "FIBK",
  "vacId": 306,
  "tenant": "UKVI",
  "roleCode": "SPVR,SSVR,ADOF,SUOF,BIOF,DIOF,DOCV",
  "iat": 1770105079,
  "exp": 1770133879
}
```

> ⚠️ Ces JWTs sont **expirés** (émis en ~2026, durée 8h). Ils servent d'empreinte pour connaître la structure des tokens internes VFS.

---

## 9. CMS — Contentful

| Champ | Valeur |
|-------|--------|
| **Space** | `xxg4p8gt3sg6` |
| **Access token** | `5-eABDj_OU_DJAXxsU2tXGFDk6yozcQbKbNnV-6rS8M` |
| **Environment** | `master` |

Utilisé pour les textes UI, les médias et la configuration des VACs/pays.

---

## 10. Flux complet pour le slot hunter

### Étape 1 — Résoudre Turnstile
```
CapSolver: TurnstileTaskProxyLess
siteKey: 0x4AAAAAAAZRJT8YvAW5mxao
pageURL: https://atlantis-abs-uk.vfsglobal.com/sign-in
```

### Étape 2 — Login Cognito (SRP)
```
Via AWS Amplify signIn({ username: email, password })
→ authFlowType: USER_SRP_AUTH
→ Tokens stockés dans localStorage + sessionStorage.accessToken
```

### Étape 3 — Navigation / Handshake
```
POST v1/applications/handshake
  Body: { token de handshake depuis l'URL ou params }

POST v1/applications/navigation   (body CHIFFRÉ avec clé RSA "payment")
  Body: { missionId, missionCode, gWFNumber }
  Headers: Authorization: Bearer <accessToken>
  → Réponse : AppData (structure landingScreenValue)
```

### Étape 4 — Vérifier disponibilité créneaux
```
→ Module /appointment-booking (chunk lazy-loaded 338, non présent dans main.js)
→ Endpoint(s) à intercepter via proxy réseau lors d'une vraie session
```

### Étape 5 — Logout
```
POST v1/identity/invalidateToken
  Body: { missionId, missionCode, gWFNumber }
  Headers: Authorization: Bearer <accessToken>
```

---

## 11. Points critiques pour l'implémentation

| # | Point | Détail |
|---|-------|--------|
| 1 | **Turnstile obligatoire** | Présent sur le sign-in. Utiliser CapSolver `TurnstileTaskProxyLess` |
| 2 | **Slot endpoints inconnus** | Le module `AppointmentBookingModule` est lazy-loaded (chunk 338) — non inclus dans main.js. À capturer via une vraie session avec proxy |
| 3 | **Chiffrement payload** | Les endpoints navigation/payment/geteicr chiffrent leur body AES-GCM + RSA-OAEP. Reproduire la logique en TypeScript avec `node-forge` (déjà utilisé dans le bundle) |
| 4 | **Cognito SRP** | Implémenter via `aws-amplify` ou le SDK `amazon-cognito-identity-js` — les pool IDs sont chargés dynamiquement depuis Contentful |
| 5 | **landingScreenValue** | Toute la session tourne autour de ce JSON — GWFNumber, VacCode, MissionCode sont indispensables |
| 6 | **Pas de CSRF token** | Pas de protection CSRF détectée — uniquement Bearer token + x-api-key selon l'endpoint |
