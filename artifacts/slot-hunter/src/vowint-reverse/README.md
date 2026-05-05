# VOWINT Reverse Engineering — visaonweb.diplomatie.be

Reverse engineering du portail belge VOWINT (Visa On Web International) pour construction du bot CEV Kinshasa.
Capturé le 2026-04-03.

## 🔑 DÉCOUVERTE MAJEURE — Domaine du système de RDV (2026-04-03)

Le système de rendez-vous CEV N'EST PAS sur `cev-kin.eu` ni `schengenhouse.eu`.
C'est un service cloud belge distinct :

```
https://appointment.cloud.diplomatie.be/
```

### Flux complet confirmé par test manuel :
1. Remplir formulaire VOWINT sur `visaonweb.diplomatie.be`
2. Cliquer "Soumettre" → bouton **"Prise de rendez-vous"** apparaît
3. Cliquer ce bouton → ouvre `https://appointment.cloud.diplomatie.be/Captcha`
4. Résoudre captcha humain
5. Redirect vers `https://appointment.cloud.diplomatie.be/Integration/Error/NoAvailability`
   → Message: "Aucun créneau horaire n'est disponible. Veuillez réessayer ultérieurement."

### Endpoints confirmés sur `appointment.cloud.diplomatie.be` :
```
GET  /Captcha                          → page captcha avant accès au calendrier
GET  /Integration/Error/NoAvailability → aucun créneau disponible (à poller)
GET  /Integration/...                  → (à découvrir) calendrier / créneaux disponibles
```

### Version du système : 1.0.249.0

### Ce que le bot doit faire :
- Poller `appointment.cloud.diplomatie.be` (probablement `/Integration/Slots` ou similaire)
- Détecter quand la réponse n'est plus `NoAvailability` → créneau disponible
- Résoudre le captcha une seule fois pour confirmer la réservation

### Mécanisme d'ouverture confirmé : blob: URL (POST caché)

```
blob:https://appointment.cloud.diplomatie.be/971c50d9-c5e5-4a52-82ef-3190ce4ff473
Referrer-Policy: no-referrer
```

**Ce que ça signifie :**
VOWINT ne redirige PAS via URL query string. Il crée un `Blob` HTML en mémoire
avec un formulaire caché qui se soumet en POST vers `/Captcha`.

```javascript
// Ce que VOWINT fait en interne (approximatif) :
var html = '<form method="POST" action="https://appointment.cloud.diplomatie.be/Captcha">'
         + '<input type="hidden" name="token" value="..." />'
         + '<input type="hidden" name="AppId" value="..." />'
         + '</form><script>document.forms[0].submit()</scr' + 'ipt>';
var blob = new Blob([html], {type: 'text/html'});
window.open(URL.createObjectURL(blob));
```

**Implication pour le bot :**
Les paramètres de session (token, AppId, etc.) sont dans le HTML du Blob —
invisibles dans l'URL. Le bot Playwright doit **intercepter le Blob** ou
**capturer la requête POST** vers `/Captcha` pour extraire ces tokens.

### Stratégie bot révisée :
```
Playwright.on('request', req => {
  if (req.url().includes('appointment.cloud.diplomatie.be/Captcha')) {
    const postData = req.postData(); // ← tokens ici
  }
});
```

### ⚠️ Rate limit confirmé : 5 clics/heure par demande
```
"Vous avez cliqué plus de 5 fois sur le bouton « Prendre rendez-vous »
au cours de cette heure pour cette demande (ou ce groupe de demandes).
Votre compte est bloqué pendant 60 minutes."
```
- Limite : **5 tentatives par heure** par AppId/compte
- Blocage : **60 minutes** sur le compte VOWINT
- Périmètre : par demande individuelle ou groupe de demandes

**Impact sur la stratégie bot :**
- Le bot NE DOIT PAS cliquer le bouton de RDV en boucle de polling
- Il faut d'abord détecter la disponibilité via une route API légère (sans clic bouton)
- Le clic final n'est fait QU'UNE FOIS quand un créneau est confirmé disponible
- Utiliser des AppId/comptes distincts par client pour éviter le blocage croisé

### hCaptcha sitekey CEV — confirmée :
```
5f64399c-14a8-415e-ad1a-7ebccdc4943a
```
Page : `https://appointment.cloud.diplomatie.be/Captcha`

### Stack du système appointment.cloud.diplomatie.be :
- **JSZip v3.10.1** (génération de documents ZIP/PDF de confirmation)
- **loglevel** (logging)
- ASP.NET MVC + jQuery (même stack que VOWINT)
- Un seul bundle JS : `/bundles/scripts/sharedScripts`

### API endpoints complets (reverse engineered depuis le bundle) :

```
BASE = https://appointment.cloud.diplomatie.be/

POST BASE/Captcha                       ← POST depuis blob VOWINT, établit la session (cookie)
POST BASE/Captcha/SetCaptchaToken       ← form-urlencoded: captcha=<token> → {validUntil, redirectUrl}
POST BASE/Home/AvailableTimeSlots       ← JSON body: {month,year} → créneaux disponibles (POLLING ENDPOINT)
POST BASE/Shared/DoCancelRequestAppointment ← form-urlencoded: {uniqueToken,cultureCode} → annulation
```

### Analyse complète du bundle JS (2026-05-05, v1.0.249.0)

**Bundle unique :** `/bundles/scripts/sharedScripts` (419KB, minifié)
**13 fonctions nommées** (pas de logique booking inline — tout est server-rendered) :
```
FilterOutDuplicates, callPost, convertLocalTimeToUTC, getAvailableTimeSlotsForPublic,
getModal, getValidUntilMilliseconds, resetValidation, setModalBody, setupSessionTimeout,
showModal, showModalToSendCancelLink, successfullCaptcha, toggleModalMenu
```

**SharedAjaxService (objet global) :**
```javascript
SharedAjaxService = {
  ajaxGet:   function(url, data, success, err)  // GET, traditional:true (form-urlencoded)
  ajaxPost:  function(url, data, success, err)  // POST, traditional:true (form-urlencoded)
  setCaptchaToken:          // → POST BASE/Captcha/SetCaptchaToken (form-urlencoded)
  appointmentCancelRequest: // → POST BASE/Shared/DoCancelRequestAppointment (form-urlencoded)
}
```

**callPost (fonction globale) — DIFFÉRENT de ajaxPost :**
```javascript
function callPost(url, data, success, err) {
  $.ajax({
    url: url, type: "Post", cache: false,
    contentType: "application/json",  // ← JSON, PAS form-urlencoded
    dataType: "json",
    data: JSON.stringify(data),
    success: success, error: err
  });
}
function getAvailableTimeSlotsForPublic(ajaxUrl, data, success, err) {
  callPost("/Home/AvailableTimeSlots", data, success, err);  // JSON body
}
```

**Flux successfullCaptcha (callback hCaptcha) :**
```javascript
function successfullCaptcha(token) {
  // 1. Cacher le widget, afficher loader
  SharedAjaxService.setCaptchaToken(ajaxUrl, {captcha: token}, function(response) {
    // 2. Configurer timeout de session (validUntil)
    setupSessionTimeout(response.validUntil, response.redirectUrl);
    // 3. Rediriger vers la page de slots (ou NoAvailability)
    location.href = response.redirectUrl;
  });
}
```

**ajaxUrl injecté inline dans chaque page :**
```javascript
var ajaxUrl = currentLocation.protocol + '//' + 'appointment.cloud.diplomatie.be' + '/';
```
→ La session est gérée par **cookie** (établi lors du POST initial au /Captcha)

**Architecture :** ASP.NET MVC + Bootstrap 3 + jQuery — **PAS AngularJS**
→ La page SelectSlot est **server-rendered HTML** (pas SPA)
→ Le JS de sélection de slots est injecté **inline** dans la page (pas de bundle séparé)
→ Le booking complet se fait via **soumission de formulaires HTML** (Playwright requis)

### Architecture de session — CONFIRMÉE PAR TEST MANUEL :
1. VOWINT génère un blob HTML → POST vers `appointment.cloud.diplomatie.be/Captcha` → cookie de session posé
2. Bot résout hCaptcha (2captcha/capsolver) → POST `Captcha/SetCaptchaToken` avec token hCaptcha
3. Serveur répond immédiatement : `{validUntil: "...", redirectUrl: "..."}`
4. **Le `redirectUrl` indique DIRECTEMENT la disponibilité :**
   - `redirectUrl` contient `"NoAvailability"` → aucun créneau disponible ✗
   - `redirectUrl` pointe vers `/Home/...` ou calendrier → **créneaux disponibles ✓**
5. Quand disponible : suivre `redirectUrl` pour accéder au calendrier et confirmer

### Stratégie de polling optimale (respecte la limite 5 clics/heure) :
```
[Session CEV valide = validUntil - now > 60s]
    ↓ Si session valide :
        → poller /Home/AvailableTimeSlots avec cookie existant (aucun clic VOWINT)
    ↓ Si session expirée (ou pas encore de session) :
        → 1 clic "Prendre rendez-vous" sur VOWINT (utilise 1 des 5 clics/heure)
        → intercepter cookie de session CEV
        → résoudre hCaptcha ($0.003)
        → POST SetCaptchaToken → lire redirectUrl
        → si NoAvailability : conserver session + poller /Home/AvailableTimeSlots
        → si disponible : procéder à la réservation immédiatement
```
→ Au maximum 5 solves hCaptcha/heure par application, polling illimité entre les solves

---

## Stack technique identifiée

| Composant | Valeur |
|---|---|
| Frontend | AngularJS (app module: `osOnline`) |
| Backend | ASP.NET MVC |
| Serveur | 193.191.208.217 (gouvernement belge) |
| Protection | F5 BIG-IP (cookie `TS0110ceb4`) — PAS de Cloudflare |
| Session | `ASP.NET_SessionId` + `OSOnline` |
| CSRF | `__RequestVerificationToken` (cookie + champ caché) |

## Endpoints confirmés

```
GET  /fr/VisaApplication/Create                    → créer nouvelle demande → AppId
GET  /common/getVisaApplication?AppId={uuid}       → lire état du formulaire
POST /fr/VisaApplication/Edit/{uuid}               → sauvegarder données demandeur
POST /Common/SetSessionVariable                    → session serveur (menu, etc.) — ignoré
GET  /VisaApplication/PrintGdpr?gdprApproval=1     → GDPR court séjour
GET  /VisaApplication/PrintGdpr?gdprApproval=2     → GDPR long séjour
```

## Headers obligatoires pour le bot

```http
X-Requested-With: XMLHttpRequest
If-Modified-Since: 0
Cookie: ASP.NET_SessionId=...; __RequestVerificationToken=...; TS0110ceb4=...; OSOnline=...
```

## Identifiants clés d'une demande

```
AppId   → UUID (ex: e978b2fd-472f-f111-a3ae-00505691de06) — utilisé dans toutes les URLs
VOWId   → Référence humaine (ex: VOWINT5903406) — sur lettre de convocation
VacId   → 1 = "VOW Internet" (notre mode)
```

## Flux bot (2 étapes)

```
ÉTAPE 1 — VOWINT
  1. GET /fr/VisaApplication/Create → cookies + AppId
  2. POST /fr/VisaApplication/Edit/{AppId} → données demandeur
  3. GET /common/getVisaApplication?AppId={uuid}
     → vérifier canTakeAppointment = true
     → extraire CompanyList[0].AppointmentUrl → lien CEV

ÉTAPE 2 — CEV Calendar (cev-kin.eu / schengenhouse.eu)
  4. GET {AppointmentUrl} → calendrier CEV
  5. POLL toutes les 5 min → scraper créneaux libres
  6. Créneau trouvé → POST confirmation → extraire référence
```

## ⚠️ Obstacles détectés (mis à jour 2026-04-03)

| Obstacle | Impact | Solution |
|---|---|---|
| **hCaptcha** sur `/fr/VisaApplication/Gdpr` | Bloque la création HTTP pure | Playwright + service anticaptcha (2captcha / capsolver) |
| **Script bot-detection** (`__scdn__done`) | Fingerprinting navigateur | Playwright avec stealth plugin (`playwright-extra`) |
| **Session F5 BIG-IP** (`TS0110ceb4`) | Sticky session, doit être conservée | Ne jamais réinitialiser les cookies en cours de session |

## Flux bot CORRIGÉ (3 étapes — après analyse HTML page)

```
ÉTAPE 0 — Création demande VOWINT (Playwright obligatoire à cause hCaptcha)
  1. GET  /fr/VisaApplication/Gdpr    → page GDPR consent + hCaptcha
  2. Résoudre hCaptcha (2captcha / capsolver ~0.003$)
  3. POST GDPR accept                 → redirect → /fr/VisaApplication/Edit/{AppId}
  4. Extraire AppId depuis l'URL de redirection → stocker dans Convex

ÉTAPE 1 — Remplissage VOWINT (HTTP pur suffisant après AppId obtenu)
  5. GET  /common/getVisaApplication?AppId={uuid}
  6. POST /fr/VisaApplication/Edit/{AppId} → sauvegarder données demandeur
  7. Re-GET /common/getVisaApplication → canTakeAppointment = true
     → extraire CompanyList[0].AppointmentUrl → stocker dans Convex

ÉTAPE 2 — CEV Calendar (cev-kin.eu / schengenhouse.eu)
  8. GET {AppointmentUrl} → calendrier CEV
  9. POLL toutes les 5 min → détecter créneaux libres
  10. Créneau trouvé → réserver → stocker référence RDV dans Convex
```

### Stratégie optimale
**Étapes 0-1 : une seule fois par client** (Playwright, ~30 secondes).
Stocker `AppId` + `AppointmentUrl` dans Convex (table `applications`).
**Étape 2 : polling léger en boucle** — HTTP pur, pas de Playwright, très rapide.

### Rôles compte VOWINT nécessaires
```
Applications_CanTakeAppointment       ← CRITIQUE pour accéder au calendrier CEV
Applications_CanCreateNewApplicationVOW
Applications_CanClickSubmit
Applications_CanViewMyList
```

## Champs formulaire VOWINT (données demandeur)

| Champ API | Description | Valeur type (DRC) |
|---|---|---|
| `Personal_Data_LastName` | Nom de famille | — |
| `Personal_Data_FirstName` | Prénom | — |
| `Personal_Data_BirthDate` | Date naissance | DD/MM/YYYY |
| `Personal_Data_NationalityId` | Nationalité | **58** = CONGO (Rep Dem) |
| `Personal_Data_GenderId` | Genre | 1=Masc, 2=Fém |
| `Personal_Data_Email` | Email | — |
| `Personal_Data_Mobilenumber` | Mobile | — |
| `TravelDocument_DocumentNumber` | N° passeport | — |
| `TravelDocument_ValidUntil` | Expiration passeport | — |
| `TravelDocument_DocumentTypeId` | Type doc | 1=Ordinaire |
| `Application_MemberStateOfDestinationId` | Pays destination | 32=BE, 86=FR... |
| `Application_VisaTypeRequestedId` | Type visa | 2=C (court séjour) |
| `Application_IntendedDateOfArrival` | Date d'arrivée prévue | — |
| `Application_DurationOfIntendedStay` | Durée séjour (jours) | — |
| `IsTravellerGroupQuestion` | Groupe? | 0=?, 1=Non, 2=Oui |
| `Application_GdprApproval` | GDPR accepté | 1 |

## ACTOR types (pour membres du groupe)

```javascript
TYPES:    { APPLICANT: 1, GUARDIAN: 2, OCCUPATION: 3, ACCOMODATION: 4, REFERENCEPERSON: 5 }
SUBTYPES: { VISAAPPLICANT: 1, PARENTALAUTHORITY: 2, LEGALGUARDIAN: 3, OCCUPATIONEMPLOYER: 4 }
```

## Fichiers capturés

| Fichier | Contenu |
|---|---|
| `app.js` | Bootstrap AngularJS, config $http, directives, constantes ACTOR |
| `commonController.js` | Contrôleur commun, baseUrl, endpoints menu/GDPR |
| *(à venir)* | `visaApplicationController.js` — logique formulaire principal |
| *(à venir)* | `appointmentController.js` — logique calendrier CEV |

## Pays Schengen couverts par le CEV Kinshasa (VacTypes)

Allemagne, Autriche, Belgique, Estonie, Finlande, France, Grèce, Hongrie, Italie,
Lettonie, Lituanie, Luxembourg, Pays-Bas, Portugal, République tchèque, Slovaquie, Slovénie
