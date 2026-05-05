# Analyse du Portail Visa Suisse — swiss-visa.ch/ivis2
**Bundle:** `main.js` 6.7 MB · Angular 17 + webpack · Build du 18 fév 2026
**URL de base:** `https://www.swiss-visa.ch/ivis2/`
**API backend (same-origin):** `https://www.swiss-visa.ch/ivis2/rest/`

---

## 1. Infrastructure & Sécurité

### Headers serveur (réponse initiale)
| Header | Valeur |
|--------|--------|
| `Set-Cookie` | `XSRF-TOKEN=<uuid>; Path=/ivis2; Secure` |
| `ejpd-app-client-hash` | `1490300692` (intégrité bundle côté serveur) |
| `Cache-Control` | `no-cache, no-store, max-age=0, must-revalidate` |
| `Content-Security-Policy` | `connect-src 'self'` — tout trafic XHR/fetch limité au même domaine |
| `X-Frame-Options` | `SAMEORIGIN` |

### Mécanisme XSRF (Angular standard)
- Cookie `XSRF-TOKEN` posé par le serveur sur le **premier GET** de `/ivis2/`
- Angular lit ce cookie et ajoute l'header `X-XSRF-TOKEN: <valeur>` à **tous les POST/PUT/DELETE**
- Les GET/HEAD sont exemptés (pas d'header XSRF)

### AuthInterceptor (HTTP Angular)
Chaque requête est clonée avec :
```typescript
req.clone({ withCredentials: true })  // cookies de session envoyés
// Si token disponible (après login) :
req.clone({ headers: req.headers.set('Token', sessionService.getToken()) })
```
- Avant login : uniquement `withCredentials: true`
- Après login : `Token: {benutzerSessionId}` + `withCredentials: true`

### Session ID (côté client, pour captcha)
Généré **localement** au démarrage de l'app :
```typescript
const array = new Uint32Array(1);
const random = window.crypto.getRandomValues(array);
this.sessionId = String(Date.now()) + random[0];
```
Ce `sessionId` n'est **pas** le token d'authentification — il sert uniquement à identifier la session de captcha.

### Token d'authentification (`benutzerSessionId`)
- Attribué par le serveur après `POST rest/benutzer/session/create/...`
- Transmis à l'utilisateur **par email** (lien de connexion)
- Stocké dans `this.token` du `SessionService` via `setToken(id)`
- Envoyé ensuite sur toutes les requêtes comme `Token: {benutzerSessionId}`

---

## 2. Captcha

**Type :** Image personnalisée côté serveur (pas Cloudflare, hCaptcha, ni reCAPTCHA)

**Endpoint d'image :**
```
GET /ivis2/rest/captcha/create/{sessionId}/{timestamp}
```
- `sessionId` = identifiant client généré localement (`Date.now() + crypto.random`)
- `timestamp` = `Date.now()` au moment du rechargement (cache-busting)
- Retourne une image PNG/JPEG directement (src d'un `<img>`)
- **Pas de cookie ni token nécessaire** pour obtenir l'image

**Soumission de la réponse captcha :**
```typescript
btoa(this.captchaInput)   // base64-encode de la saisie utilisateur
```
Envoyé comme segment de chemin URL dans le POST de registration.

**Rechargement :** Bouton "generate_captcha" → rappelle `createCaptcha(sessionId)` avec nouveau `Date.now()`

---

## 3. Flux de l'application (screens)

```
i210-select-country          ← choix nationalité (GET rest/codes/landCodes)
  ↓
i230-select-representation   ← choix ambassade/consulat (GET rest/zav/getZAVbyLandCode/{code})
  ↓  (si pas de représentation : i231-select-no-representation → fin)
i240-select-communication    ← choix canal : en ligne ou sur rendez-vous direct
  ├─ [zav.internetAntrag=true]        → flux normal (i250)
  ├─ [zav.terminVerwaltungDirekt=true] → i241 (confirme RDV direct voulu)
  └─ [ni URL ni internet ni termin]   → information seulement
i241-select-communication-direct-reservation  ← set direktTerminWanted=true
  ↓
i250-register                ← formulaire d'inscription (+ captcha image)
  ↓ POST rest/benutzer/session/create/{sessionId}/{btoa(captcha)}
i260-register-complete       ← "Email envoyé, vérifiez votre boîte" (efface sessionStorage)
  ↓ ... utilisateur clique lien email ...
i410-login-start             ← via URL: /ivis2/#/login/login.action?id={benutzerSessionId}
                               PUT rest/benutzer/session/login → reçoit UserIdentityDto
  ↓ (selon status : PRE_CREATED/NEW/IN_ERFASSUNG → i420 | ERFASST → i570 | DIREKT_TERMIN → ...)
i420-local-storage           ← consentement localStorage
i440-personendaten           ← données personnelles
i450-gesetzlicher-vertreter  ← représentant légal (mineurs)
i460-reisedokument-wohnanschrift ← document de voyage + adresse
i470-beschaeftigung          ← emploi/formation
i480-geplante-reise-visa-einreise ← voyage prévu + visa précédents
i490-gastgeber-unterkunft    ← hébergement/hébergeur
i500-reise-lebenshaltungskosten  ← frais de séjour
i510-familienangehoerige     ← membres de la famille
i520-gruppe / i521-groupe-no-list ← groupe de voyage
i540-summary-confirm         ← confirmation récapitulatif
i550-application-summary     ← résumé PDF (window.open)
i560-pdf-confirm             ← confirmation PDF + envoi
  ↓ PUT rest/antrag/validate/antrag → POST rest/antrag/create/{lang}
i570-termin                  ← SEULEMENT si zav.internetTerminVerwaltung=true
  ↓ GET rest/termin/find/user/{benutzerSessionId}
  ↓ PUT rest/termin/confirm OU reject
i580-end                     ← fin du parcours
```

---

## 4. Carte complète des endpoints REST

**Base URL :** `https://www.swiss-visa.ch/ivis2/rest/`

### ConfigService (`rest/config/`)
| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `app` | Config de l'application (PDF URLs, etc.) |

### CodeService (`rest/codes/`)
| Méthode | Chemin |
|---------|--------|
| GET | `landCodes` — liste des pays |
| GET | `landCode/{id}` |
| GET | `amtsstelleCode/{id}` |
| GET | `gruppentypCodes` |
| GET | `gruppentypCode/{id}` |
| GET | `nationalitaetCodes` |
| GET | `nationalitaetCode/{id}` |
| GET | `geschlechtCodes` — genres |
| GET | `geschlechtCode/{id}` |
| GET | `zivilstandCodes` — état civil |
| GET | `yesNoCodes` |
| GET | `verwandtschaftsgradCodes` — liens de parenté |
| GET | `rufnummerCodes` — types de numéros de tél |
| GET | `reisedokumentTypCodes` — types de doc de voyage |
| GET | `berufCodes` — professions |
| GET | `arbeitgeberArtCodes` — types d'employeurs |
| GET | `reisezweckCodes` — buts du voyage |
| GET | `territoriumCodes` |
| GET | `anzahlEinreisenCodes` — nombre d'entrées |
| GET | `einladendeArtCodes` — types d'invitants |
| GET | `kostentraegerCodes` — responsables des frais |
| GET | `dienstleistungCodes` |
| GET | `waehrungCodes` — devises |

### ZAV Service (`rest/zav/`)
| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `getZAVbyLandCode/{landCode}` | Retourne liste ambassades/consulats pour un pays |
| GET | `findById/{id}` | Détails d'une représentation par ID |

**ZAV DTO (champs clés) :**
```typescript
{
  url: string,                      // URL externe de la représentation
  internetAntrag: boolean,          // Accepte demandes en ligne
  internetTerminVerwaltung: boolean, // Gestion des RDV en ligne
  terminVerwaltungDirekt: boolean,  // RDV direct (pas de formulaire)
}
```

### BenutzerSession Service (`rest/benutzer/session/`)
| Méthode | Chemin | Corps | Description |
|---------|--------|-------|-------------|
| POST | `create/{sessionId}/{captchaBase64}` | `BenutzerSessionDto` | Inscription → déclenche envoi email |
| PUT | `login` | `benutzerSessionId (string)` | Login via lien email → retourne `UserIdentityDto` |
| GET | `auth` | — | Vérification que la session est encore valide |
| PUT | `push/antrag` | `AntragDto` | Pousse le formulaire vers le serveur |
| PUT | `pop/antrag` | `id` | Récupère un antrag |
| PUT | `info` | `benutzerSessionId` | Infos utilisateur |

**BenutzerSessionDto (POST body) :**
```typescript
{
  vertretung: ZavDto,          // ambassade sélectionnée
  direktTerminwanted: boolean, // si l'utilisateur veut RDV direct
  name: string,                // nom de famille
  vorname: string,             // prénom
  geburtsdatum: string,        // date de naissance (format à déterminer)
  telefonnummer: string,       // téléphone
  email: string,               // email (reçoit le lien de connexion)
  language: string,            // 'de' | 'fr' | 'it' | 'en' (toLowerCase)
}
```

### Captcha (`rest/captcha/`)
| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `create/{sessionId}/{timestamp}` | Retourne image captcha (pas d'auth requise) |

### Antrag Service (`rest/antrag/`)
| Méthode | Chemin | Corps |
|---------|--------|-------|
| PUT | `next/nr` | null |
| PUT | `validate/antrag` | `AntragDto` |
| PUT | `validate/personendaten` | `PersonendatenDto` |
| PUT | `validate/minderjaehrig` | `geburtsdatum` |
| PUT | `validate/familienangehoerige` | `FamilienangehoerigeDto` |
| PUT | `validate/gesetzlicherVertreter` | `GesetzlicherVertreterDto` |
| PUT | `validate/reisedokumentWohnanschrift` | `ReisedokumentWohnanschriftDto` |
| PUT | `validate/beschaeftigung` | `BeschaeftigungDto` |
| PUT | `validate/geplanteReiseVisaEinreise` | `GeplanteReiseVisaEinreiseDto` |
| PUT | `validate/gastgeberUnterkunft` | `GastgeberUnterkunftDto` |
| PUT | `validate/reiseLebenshaltungskosten` | `ReiseLebenshaltungskostenDto` |
| POST | `create/{lang}` | `AntragDto` |

### Termin Service (`rest/termin/`)
| Méthode | Chemin | Corps | Description |
|---------|--------|-------|-------------|
| GET | `find/user/{benutzerSessionId}` | — | Retourne liste des TerminDto assignés |
| PUT | `confirm` | `benutzerSessionId` | Confirme TOUS les rendez-vous |
| PUT | `reject` | `benutzerSessionId` | Rejette TOUS les rendez-vous |

### Report Service (`rest/report/`)
| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET (window.open) | `generate/summary/{id}/{lang}` | Génère PDF récapitulatif |

### Swiss Place Service (`rest/place`)
| Méthode | Chemin |
|---------|--------|
| GET | `/list` |

### Infrastructure (`rest/appinfo/`, `rest/jfa/`, `rest/clientlogging`)
| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `appinfo/infos` | Infos version/build (CommonService) |
| GET | `jfa/token` | Token JWT pour système JFA (5 min TTL) |
| GET | `jfa/token/refresh` | Rafraîchissement token JFA |
| POST | `clientlogging` | Logs d'erreur côté client |
| GET | `i18n` | Traductions i18n |

---

## 5. Énumérations d'état

### SessionStatusType
```typescript
enum SessionStatusType {
  PRE_CREATED = "PRE_CREATED",
  NEW = "NEW",
  IN_ERFASSUNG = "IN_ERFASSUNG",  // en cours de saisie
  ERFASST = "ERFASST",            // saisie complète → vers i570 Termin
  DIREKT_TERMIN = "DIREKT_TERMIN",
  COMPLETED = "COMPLETED",
  CONFIRM_MAIL_NEEDED = "CONFIRM_MAIL_NEEDED",
}
```

### SpecialStatusType
```typescript
enum SpecialStatusType {
  NONE = "NONE",
  BACK_FORBIDDEN = "BACK_FORBIDDEN",
}
```

---

## 6. Stockage client

| Storage | Clé | Contenu |
|---------|-----|---------|
| `sessionStorage` | `Termin` | `boolean` — si RDV voulu |
| `sessionStorage` | `Token` | `benutzerSessionId` |
| `localStorage` | `{benutzerSessionId}-{applicationId}-...` | Données formulaire |
| Mémoire Angular | `SessionService.sessionId` | ID de session captcha |
| Mémoire Angular | `SessionService.token` | = `benutzerSessionId` |

---

## 7. Analyse du slot-hunter — Comment ça fonctionne

### Point critique : le termin est ASSIGNÉ par le serveur
Le flux i570 ne présente **pas** une liste de créneaux au choix. Le serveur assigne automatiquement un créneau lors de la création de l'antrag (`POST rest/antrag/create/{lang}`). L'utilisateur peut uniquement **confirmer** ou **rejeter** ce créneau.

Cela signifie que le portail Suisse fonctionne différemment du VFS UK :
- Pas de sélection de slot par l'utilisateur
- Le serveur alloue le prochain créneau disponible à la représentation (ZAV)
- Si `zav.internetTerminVerwaltung = false` → pas de RDV en ligne, l'utilisateur est redirigé vers i580 directement

### Stratégie slot-hunter possible

```
Phase 1 - Préinscription (unique, manuelle) :
  1. GET /ivis2/ → obtenir XSRF-TOKEN cookie
  2. GET /ivis2/rest/zav/getZAVbyLandCode/{CODE_PAYS} → trouver ZAVs avec internetTerminVerwaltung=true
  3. Résoudre captcha (OCR ou solver) → obtenir image de /rest/captcha/create/{sessionId}/{ts}
  4. POST /ivis2/rest/benutzer/session/create/{sessionId}/{btoa(captcha)} body: BenutzerSessionDto
  5. Attendre email → extraire benutzerSessionId du lien

Phase 2 - Polling / détection de slot (automatisé) :
  1. PUT /ivis2/rest/benutzer/session/login {benutzerSessionId} → obtenir Token
  2. GET /ivis2/rest/benutzer/session/auth → vérifier que session est valide
  3. POST /ivis2/rest/antrag/create/{lang} {AntragDto} → soumettre demande (déclenche assignation slot)
  4. GET /ivis2/rest/termin/find/user/{benutzerSessionId} → vérifier si slot assigné
  5. Si liste vide → réessayer (noter : le serveur assigne seulement quand des créneaux sont disponibles)
  6. Si slot trouvé → PUT /ivis2/rest/termin/confirm {benutzerSessionId}

Note : Chaque tentative nécessite probablement un nouveau benutzerSessionId (nouvelle inscription).
```

### Défi majeur : Captcha image sur l'inscription
- L'image captcha est servie sans authentification
- Format : image générée côté serveur
- La réponse est transmise en base64 dans l'URL
- **Option 1 :** OCR (Tesseract) si le captcha est textuel simple
- **Option 2 :** Service de résolution captcha (2captcha, Anti-Captcha)
- **Option 3 :** Playwright pour afficher l'image + résolution humaine

---

## 8. DTOs principaux (structures de données)

### AntragDto
```typescript
class AntragDto {
  applications: ApplicationDto[] = [];
  benutzerSessionId: string;
  valid: boolean;  // retourné par le serveur
}
```

### ApplicationDto (par personne)
Contient : `applicationId`, `personendaten`, `gesetzlicherVertreter`, `reisedokumentWohnanschrift`, `beschaeftigung`, `geplanteReiseVisaEinreise`, `gastgeberUnterkunft`, `reiseLebenshaltungskosten`, `familienangehoerige`

### PersonendatenDto
```typescript
{ fruehereNamenList: [], otherNationalities: [], vormund: boolean, geburtsdatum: string, ... }
```

### UserIdentityDto (retourné par login)
```typescript
{
  benutzerSessionId: string,
  status: SessionStatusType,
  specialStatus: SpecialStatusType,
  direktTerminWanted: boolean,
  zav: ZavDto  // représentation consulaire
}
```

---

## 9. Sources TypeScript identifiées dans le bundle

```
./src/app/service/antrag.service.ts
./src/app/service/auth-guard.service.ts
./src/app/service/benutzer-session.service.ts
./src/app/service/code.service.ts
./src/app/service/config.service.ts
./src/app/service/ivis-i18n.service.ts
./src/app/service/local-storage.service.ts
./src/app/service/report.service.ts
./src/app/service/session.service.ts
./src/app/service/swiss-place.service.ts
./src/app/service/termin.service.ts
./src/app/service/zustaendige-ausland-vertretung.service.ts
```

---

*Analyse générée le 05/05/2026 — bundle du 18/02/2026 (ejpd-app-client-hash: 1490300692)*
