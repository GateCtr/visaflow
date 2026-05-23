# Analyse Portail RK-Termin — Ambassades d'Allemagne

## Vue d'ensemble

Le système **RK-Termin** (version 1.3.0.4) est le portail officiel de prise de rendez-vous du Ministère fédéral des Affaires étrangères allemand (Auswärtiges Amt). Il est utilisé par toutes les ambassades et consulats allemands dans le monde pour gérer les rendez-vous visa (Schengen C et National D), passeports, et services consulaires.

**URL racine** : `https://service2.diplo.de/rktermin/extern/`

---

## Architecture Technique

### Stack
- **Backend** : Java (Struts2 / Webwork framework)
- **Serveur** : Apache/2.4.67 (Debian)
- **Session** : JSESSIONID (HttpOnly cookie)
- **Frontend** : jQuery 1.6.2 + jQuery UI 1.11.4
- **Protection** : Captcha image inline (base64 JPEG)
- **Anti-bot** : Cookie KEKS (valeurs TERMINA/TERMINB/TERMINC selon le load balancer)

### Cookies
| Cookie | Valeur | Scope |
|--------|--------|-------|
| `JSESSIONID` | Alphanumérique 32 chars | `/rktermin; HttpOnly` |
| `KEKS` | `TERMINA` / `TERMINB` / `TERMINC` | `/` (sticky routing LB) |

---


## Flux de Navigation (URL Flow)

Le système suit un parcours linéaire en 5 à 6 étapes :

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PARCOURS RK-TERMIN                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. choose_realmList.do ──► Choix du domaine (Visa, Passeport, etc.)   │
│         ↓                                                               │
│  2. choose_categoryList.do ──► Choix de la catégorie de visa           │
│         ↓                                                               │
│  3. choose_category.do ──► Détails catégorie + lien "Weiter"           │
│         ↓                                                               │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  VARIANTE A (calendrier)          VARIANTE B (waitlist)      │       │
│  │                                                              │       │
│  │  4a. appointment_showMonth.do     4b. appointment_showForm   │       │
│  │      → Captcha avant calendrier       → Formulaire direct   │       │
│  │      → POST captchaText               avec captcha intégré  │       │
│  │      → Calendrier mensuel                                    │       │
│  │         ↓                                                    │       │
│  │  5a. appointment_showDay.do                                  │       │
│  │      → Créneaux horaires                                    │       │
│  │         ↓                                                    │       │
│  │  6a. appointment_showForm.do                                 │       │
│  │      → Formulaire personnel                                  │       │
│  └──────────────────────────────────────────────────────────────┘       │
│         ↓                                                               │
│  7. appointment_addAppointment.do ──► Soumission finale                │
│         ↓                                                               │
│  8. Confirmation (email envoyé)                                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---


## Endpoints Détaillés

### 1. `choose_realmList.do` — Choix du domaine

**URL** : `GET /rktermin/extern/choose_realmList.do`

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `locationCode` | string | Code ambassade/consulat (4 chars) | `lago`, `kins`, `kamp`, `buda` |
| `request_locale` | string | Langue de l'interface | `en`, `de`, `fr`, `en_GB` |

**Réponse** : Page HTML avec liste de "realms" (domaines), chacun étant un lien vers `choose_categoryList.do`.

---

### 2. `choose_categoryList.do` — Choix de la catégorie

**URL** : `GET /rktermin/extern/choose_categoryList.do`

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `locationCode` | string | Code ambassade | `lago` |
| `realmId` | int | ID du domaine sélectionné | `347`, `1526` |
| `request_locale` | string | Langue (optionnel) | `en` |

**Réponse** : Liste de catégories (types de visa), liens vers `choose_category.do`.

---

### 3. `choose_category.do` — Détails catégorie

**URL** : `GET /rktermin/extern/choose_category.do`

| Paramètre | Type | Description | Exemple |
|-----------|------|-------------|---------|
| `locationCode` | string | Code ambassade | `lago` |
| `realmId` | int | ID du domaine | `347` |
| `categoryId` | int | ID de la catégorie de visa | `1675`, `3759` |

**Réponse** : Informations détaillées sur la catégorie + bouton "Weiter" (Continuer) qui mène soit à :
- `appointment_showMonth.do` (mode calendrier — l'utilisateur choisit une date)
- `appointment_showForm.do` (mode waitlist — inscription directe sur liste d'attente)

---


### 4a. `appointment_showMonth.do` — Captcha + Calendrier (Mode calendrier)

**URL** : `GET/POST /rktermin/extern/appointment_showMonth.do`

**Phase 1 — GET** : Affiche le captcha à résoudre avant d'accéder au calendrier.

**Phase 2 — POST** : Soumet le captcha et affiche le calendrier mensuel.

| Paramètre POST | Type | Description |
|----------------|------|-------------|
| `captchaText` | string | Texte du captcha résolu |
| `locationCode` | string | Code ambassade |
| `realmId` | int | ID du domaine |
| `categoryId` | int | ID catégorie |
| `openingPeriodId` | string | Période d'ouverture (vide initialement) |
| `date` | string | Date (vide initialement) |
| `dateStr` | string | Date formatée (vide initialement) |
| `rebooking` | string | Vide sauf rebooking |
| `token` | string | Token rebooking (vide) |
| `lastname` | string | Nom (vide sauf rebooking) |
| `firstname` | string | Prénom (vide sauf rebooking) |
| `email` | string | Email (vide sauf rebooking) |

**Boutons submit** :
- `action:appointment_showMonth` → Valider le captcha et charger le calendrier
- `action:appointment_refreshCaptchamonth` → Recharger une nouvelle image captcha
- `action:choose_category` → Annuler / retour

**Captcha** : Image JPEG encodée en base64 inline dans un `<div>` avec `background: url('data:image/jpg;base64,...')`. Taille 350×50px.

---

### 4b. `appointment_showForm.do` — Formulaire direct (Mode waitlist)

**URL** : `GET /rktermin/extern/appointment_showForm.do`

| Paramètre | Type | Description |
|-----------|------|-------------|
| `locationCode` | string | Code ambassade |
| `realmId` | int | ID du domaine |
| `categoryId` | int | ID catégorie |

**Formulaire POST** vers `appointment_addAppointment.do` avec :

| Champ | Type | Description |
|-------|------|-------------|
| `lastname` | text | Nom de famille |
| `firstname` | text | Prénom |
| `email` | text | Adresse email |
| `emailrepeat` | text | Confirmation email (paste désactivé) |
| `fields[0].content` | text | Champ dynamique (ex: Numéro de passeport) |
| `fields[0].definitionId` | hidden | ID de définition du champ |
| `fields[0].index` | hidden | Index du champ |
| `fields[1].content` | hidden | Champ dynamique (ex: Date de naissance YYYY-MM-DD) |
| `fields[1].definitionId` | hidden | ID de définition |
| `fields[1].index` | hidden | Index |
| `captchaText` | text | Texte du captcha |
| `locationCode` | hidden | Code ambassade |
| `realmId` | hidden | ID domaine |
| `categoryId` | hidden | ID catégorie |
| `openingPeriodId` | hidden | ID période d'ouverture |
| `date` | hidden | Date (vide en mode waitlist) |
| `dateStr` | hidden | Date formatée (vide) |

---


### 5a. `appointment_showDay.do` — Créneaux horaires

**URL** : `GET /rktermin/extern/appointment_showDay.do`

| Paramètre | Type | Description |
|-----------|------|-------------|
| `locationCode` | string | Code ambassade |
| `realmId` | int | ID domaine |
| `categoryId` | int | ID catégorie |
| `dateStr` | string | Date sélectionnée (`dd.MM.yyyy`) |

**Réponse** : Liste des créneaux horaires disponibles pour la date sélectionnée.

---

### 6a. `appointment_showForm.do` — Formulaire de données personnelles

Après sélection d'un créneau horaire, le même endpoint `appointment_showForm.do` est appelé mais cette fois avec les paramètres `date` et `dateStr` préremplis.

---

### 7. `appointment_addAppointment.do` — Soumission finale

**URL** : `POST /rktermin/extern/appointment_addAppointment.do`

Soumission du formulaire complet (données personnelles + captcha + date/heure sélectionnés).

---

### Autres endpoints

| Endpoint | Description |
|----------|-------------|
| `appointment_refreshCaptcha` | Recharger l'image captcha (form submit) |
| `appointment_refreshCaptchamonth` | Recharger captcha de la page mois |
| `dsgvo.do` | Page RGPD / mentions légales |

---


## Captcha — Analyse Technique

### Format
- **Type** : Image text captcha (pas reCaptcha, pas hCaptcha)
- **Format** : JPEG encodé en base64
- **Taille** : 350×50 pixels
- **Intégration** : Inline CSS `background: url('data:image/jpg;base64,...')`
- **Contenu** : Texte alphanumérique déformé (5-6 caractères typiquement)

### Extraction
```javascript
// Extraire le base64 du captcha depuis le HTML
const captchaDiv = document.querySelector('captcha > div');
const style = captchaDiv.getAttribute('style');
const base64Match = style.match(/base64,([^']+)/);
const captchaBase64 = base64Match[1];
```

### Résolution
Le captcha est un simple text-captcha (pas de token JS complexe). Compatible avec :
- **2Captcha** : `method=base64`, type `ImageToText`
- **CapSolver** : `ImageToTextTask`
- **Anti-Captcha** : `ImageToTextTask`

**Coût estimé** : ~$0.001–0.003 par résolution (image captcha simple).

### Points d'attention
1. Le captcha n'apparaît qu'une seule fois (avant le calendrier ou dans le formulaire)
2. Si le captcha est incorrect, la page se recharge avec un nouveau captcha
3. La session JSESSIONID doit être maintenue entre la résolution et la soumission

---


## Codes Ambassades Identifiés (locationCode)

| Code | Ambassade/Consulat | Pays cible |
|------|-------------------|------------|
| `kins` | Ambassade Kinshasa | RDC |
| `lago` | Consulat Général Lagos | Nigeria |
| `kamp` | Ambassade Kampala | Ouganda |
| `buda` | Ambassade Budapest | Hongrie/Belarus |
| `kath` | Ambassade Kathmandu | Népal |
| `addi` | Ambassade Addis Abeba | Éthiopie/Djibouti |
| `erbi` | Consulat Général Erbil | Irak (Kurdistan) |
| `riga` | Ambassade Riga | Lettonie |
| `king` | Ambassade Kingston | Jamaïque |
| `doha` | Ambassade Doha | Qatar |
| `toky` | Ambassade Tokyo | Japon |
| `osak` | Consulat Général Osaka | Japon |
| `cheng` | Consulat Général Chengdu | Chine |

---

## Structure Kinshasa (`locationCode=kins`)

### Realms (Domaines)
| realmId | Domaine |
|---------|---------|
| 731 | Nationale Visa für kongolesische Staatsangehörige |
| 1505 | Nationale Visa für Drittstaatsangehörige |
| 1276 | Schengenvisum |
| 733 | Beglaubigungen (Légalisations) |
| 735 | Deutscher Reisepass und Personalausweis |

### Catégories pertinentes (à explorer)
- `realmId=731` → Visa National pour congolais (études, travail, regroupement familial)
- `realmId=1276` → Visa Schengen court séjour

---


## Diagramme de Séquence — Bot Slot Hunter

```
┌─────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────┐
│   Bot   │     │  RK-Termin   │     │  2Captcha /   │     │  Convex  │
│ Worker  │     │  service2    │     │  CapSolver    │     │  Backend │
└────┬────┘     └──────┬───────┘     └───────┬───────┘     └─────┬────┘
     │                  │                     │                    │
     │ 1. GET choose_realmList               │                    │
     │─────────────────▶│                     │                    │
     │  HTML + cookies   │                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 2. GET choose_categoryList             │                    │
     │─────────────────▶│                     │                    │
     │  HTML categories  │                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 3. GET choose_category                 │                    │
     │─────────────────▶│                     │                    │
     │  HTML + "Weiter"  │                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 4. GET appointment_showMonth           │                    │
     │─────────────────▶│                     │                    │
     │  HTML + captcha   │                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 5. Extraire base64 captcha            │                    │
     │────────────────────────────────────────▶│                    │
     │                  │   Résoudre image     │                    │
     │◀────────────────────────────────────────│                    │
     │  captchaText      │                     │                    │
     │                  │                     │                    │
     │ 6. POST appointment_showMonth (captcha)│                    │
     │─────────────────▶│                     │                    │
     │  HTML calendrier  │                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 7. Parser les jours disponibles        │                    │
     │───────────────────────────────────────────────────────────▶│
     │                  │                     │ recordSlotDiscovery │
     │                  │                     │                    │
     │ [Si créneau trouvé]                    │                    │
     │                  │                     │                    │
     │ 8. GET appointment_showDay             │                    │
     │─────────────────▶│                     │                    │
     │  HTML time slots  │                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 9. GET appointment_showForm            │                    │
     │─────────────────▶│                     │                    │
     │  HTML form+captcha│                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 10. Résoudre 2e captcha               │                    │
     │────────────────────────────────────────▶│                    │
     │◀────────────────────────────────────────│                    │
     │                  │                     │                    │
     │ 11. POST appointment_addAppointment    │                    │
     │─────────────────▶│                     │                    │
     │  Confirmation     │                     │                    │
     │◀─────────────────│                     │                    │
     │                  │                     │                    │
     │ 12. Notifier admin + client            │                    │
     │───────────────────────────────────────────────────────────▶│
     │                  │                     │   markSlotFound    │
     │                  │                     │                    │
```

---


## Champs Dynamiques (fields[])

Les formulaires ont des champs personnalisables par ambassade via `fields[n].definitionId` :

### Lagos — realmId 347, categoryId 1675
| Index | definitionId | Label | Format |
|-------|-------------|-------|--------|
| 0 | 5418 | Passnummer (Numéro de passeport) | Texte libre |
| 1 | 5419 | Geburtsdatum (Date de naissance) | `YYYY-MM-DD` (hidden), affiché `dd.mm.yyyy` |

### Notes sur les champs
- Les `definitionId` sont **spécifiques à chaque ambassade/catégorie**
- Le champ date utilise jQuery UI Datepicker avec conversion `dd.mm.yy` → `YYYY-MM-DD`
- D'autres ambassades peuvent avoir des champs supplémentaires (ex: numéro de dossier, adresse)

---

## Variantes de Fonctionnement

### Mode A — Calendrier avec sélection de date
Utilisé quand des créneaux sont disponibles à court/moyen terme.
- L'utilisateur résout un captcha PUIS accède au calendrier
- Le calendrier montre les jours avec des créneaux libres (highlight vert)
- Après sélection d'un jour → choix de l'heure → formulaire

### Mode B — Liste d'attente (Waitlist)
Utilisé quand la demande dépasse l'offre (ex: Lagos, temps d'attente > 1 an).
- Pas de calendrier visible
- L'utilisateur remplit directement le formulaire avec ses données
- Le portail assigne un créneau par email ~4 semaines avant le RDV
- Un email de confirmation avec référence est envoyé dans les 120 minutes

### Mode C — Aucun créneau
Quand il n'y a aucun créneau disponible, la page peut :
- Afficher "Leider sind aktuell keine Termine frei" (Pas de créneau disponible)
- Rediriger vers la page de catégorie

---


## Faisabilité Automatisation

| Aspect | Statut | Notes |
|--------|--------|-------|
| Accès HTTP direct | ✅ | Pas de Cloudflare, pas de WAF détecté |
| Session cookie | ✅ | JSESSIONID standard Java |
| Captcha | ⚠️ | Image text simple — résolvable via 2Captcha ($0.001-0.003/solve) |
| Rate limiting | ⚠️ | Non documenté — tester prudemment |
| Anti-bot JS | ❌ | Aucun JS anti-bot détecté (pas de fingerprinting) |
| API REST | ❌ | Pas d'API — tout est HTML form-based |
| Load balancer sticky | ⚠️ | Cookie KEKS pour routing — respecter |

### Avantages
1. **Stack ancienne** : jQuery 1.6.2, pas de SPA moderne → scraping HTML classique fiable
2. **Captcha simple** : Image text JPEG, pas de token JavaScript → coût très bas
3. **Pas de Cloudflare** : Accès direct sans tunnel/proxy spécial
4. **Session stable** : JSESSIONID standard, pas d'expiration rapide observée
5. **Pas de rate limit visible** : Les requêtes passent sans blocage

### Risques
1. **IP banning** : Possible si trop de requêtes depuis la même IP
2. **Session invalidation** : Si navigation trop rapide ou incohérente
3. **Changement de structure** : Le HTML peut changer sans préavis
4. **Champs dynamiques** : Les `definitionId` varient par ambassade

---


## Architecture Recommandée — Bot Worker

```typescript
// Pseudo-code du module RK-Termin

interface RKTerminConfig {
  locationCode: string;        // "kins", "lago", etc.
  realmId: number;             // ID du domaine
  categoryId: number;          // ID de la catégorie
  locale: string;              // "en" ou "de"
  captchaProvider: "2captcha" | "capsolver" | "anticaptcha";
  captchaApiKey: string;
}

interface RKTerminSession {
  jsessionId: string;
  keks: string;                // TERMINA/B/C
  baseUrl: string;
}

interface RKTerminSlot {
  date: string;                // "dd.MM.yyyy"
  time: string;                // "HH:mm"
  available: boolean;
}

// 1. Initialiser la session
async function initSession(config: RKTerminConfig): Promise<RKTerminSession>

// 2. Naviguer jusqu'au captcha
async function navigateToMonth(
  session: RKTerminSession, 
  config: RKTerminConfig
): Promise<{ captchaBase64: string; formAction: string }>

// 3. Résoudre le captcha
async function solveCaptcha(
  base64: string, 
  provider: string, 
  apiKey: string
): Promise<string>

// 4. Soumettre le captcha et parser le calendrier
async function submitCaptchaAndGetCalendar(
  session: RKTerminSession,
  config: RKTerminConfig,
  captchaText: string
): Promise<{ availableDates: string[]; monthHtml: string }>

// 5. Obtenir les créneaux d'un jour
async function getDaySlots(
  session: RKTerminSession,
  config: RKTerminConfig,
  dateStr: string
): Promise<RKTerminSlot[]>

// 6. Remplir et soumettre le formulaire de réservation
async function bookSlot(
  session: RKTerminSession,
  config: RKTerminConfig,
  slot: RKTerminSlot,
  applicant: ApplicantData
): Promise<{ success: boolean; confirmationCode?: string }>
```

---


## Parsing HTML — Patterns Clés

### Extraire les realms
```javascript
// Regex pour extraire les liens realmId depuis choose_realmList
const realmPattern = /choose_categoryList\.do\?locationCode=(\w+)&realmId=(\d+)/g;
```

### Extraire les catégories
```javascript
// Regex pour extraire les liens categoryId depuis choose_categoryList
const categoryPattern = /choose_category\.do\?locationCode=(\w+)&realmId=(\d+)&categoryId=(\d+)/g;
```

### Extraire le captcha base64
```javascript
// Le captcha est dans un div avec style inline contenant le base64
const captchaPattern = /background:white url\('data:image\/jpg;base64,([^']+)'\)/;
```

### Détecter le mode (calendrier vs waitlist)
```javascript
// Si le lien "Weiter" pointe vers appointment_showMonth → mode calendrier
const isCalendarMode = html.includes('appointment_showMonth.do');
// Si "appointment_showForm" est le lien direct → mode waitlist
const isWaitlistMode = html.includes('appointment_showForm.do');
```

### Extraire les dates disponibles du calendrier
```javascript
// Les jours disponibles sont des liens <a> dans le calendrier HTML
// Pattern attendu (à confirmer après résolution captcha réelle) :
const dayLinkPattern = /appointment_showDay\.do[^"]*dateStr=([^"&]+)/g;
```

### Détecter "pas de créneau"
```javascript
const noSlotsPatterns = [
  /keine Termine/i,
  /no.*appointment/i,
  /Unfortunately.*no.*free/i,
  /Leider.*aktuell.*keine/i,
];
```

---


## Comparaison avec les Autres Portails Joventy

| Critère | USA (AVITS) | Espagne (Bookitit) | Schengen (CEV) | **Allemagne (RK-Termin)** |
|---------|-------------|-------------------|----------------|---------------------------|
| Type | REST API | JSONP API | Web app + API | **HTML forms** |
| Auth | AWS Cognito JWT | Token Bookitit | ASP.NET Session + hCaptcha | **JSESSIONID + image captcha** |
| Protection | Cloudflare | Cloudflare (HTML only) | hCaptcha + rate limit | **Image captcha simple** |
| Coût captcha | N/A (JWT) | N/A (API directe) | ~$0.02/solve (hCaptcha) | **~$0.002/solve (image)** |
| Complexité | Moyenne | Faible | Haute | **Faible-Moyenne** |
| Stabilité | API versionnée | API stable | Sessions fragiles | **HTML peut changer** |

---

## Stratégie de Polling Recommandée

| Contexte | Intervalle | Justification |
|----------|------------|---------------|
| Scan normal (pas de créneau attendu) | 30-60 min | Économise les résolutions captcha |
| Période connue de libération | 5-10 min | Les créneaux sont libérés par batch |
| Créneau détecté (booking mode) | Immédiat | Capturer avant les autres |
| Après échec captcha | +30s retry | Nouveau captcha, nouvelle tentative |

### Coût estimé par dossier
- 1 scan = 1 résolution captcha = ~$0.002
- 48 scans/jour (toutes les 30 min) = ~$0.10/jour
- Mode intensif (5 min) = ~$0.60/jour

---


## Configuration Kinshasa (Cible Principale)

### Accès
```
URL: https://service2.diplo.de/rktermin/extern/choose_realmList.do?locationCode=kins&request_locale=en
```

### Realms pertinents pour Joventy
1. **realmId=731** — Visa National (congolais) : études, travail, regroupement familial
2. **realmId=1276** — Visa Schengen court séjour
3. **realmId=1505** — Visa National (ressortissants tiers)

### Intégration hunterConfig
```typescript
// Exemple de configuration hunter pour un dossier Allemagne
hunterConfig: {
  embassyUsername: "", // Non utilisé (pas de login portail)
  embassyPassword: "", // Non utilisé
  isActive: true,
  twoCaptchaApiKey: "xxx",
  scheduleUrl: "https://service2.diplo.de/rktermin/extern/choose_realmList.do?locationCode=kins",
  // Paramètres spécifiques RK-Termin
  // → à stocker dans un champ dédié ou en JSON dans scheduleUrl
}
```

### Données applicant nécessaires
- Nom (lastname)
- Prénom (firstname)
- Email
- Numéro de passeport (fields[0])
- Date de naissance (fields[1], format YYYY-MM-DD)
- Éventuels champs supplémentaires selon la catégorie

---

## Prochaines Étapes

1. **Explorer les catégories Kinshasa** : Lister les categoryId disponibles pour realmId 731/1276
2. **Tester la résolution captcha** : Vérifier que 2Captcha/CapSolver résout correctement ces images
3. **Parser le calendrier post-captcha** : Identifier le format HTML des dates disponibles
4. **Implémenter le module bot** : Créer `rktermin-checker.ts` dans le worker Railway
5. **Ajouter la destination "germany"** dans `VISA_PRICING` (constants.ts)
6. **Tester en conditions réelles** : Boucle complète init → captcha → calendar → slot detection

---

## Références

- Portail RK-Termin : https://service2.diplo.de/rktermin/extern/
- Version : 1.3.0.4
- Ambassade Kinshasa : https://kinshasa.diplo.de/
- GitHub (repos communautaires analysés) :
  - iduseev/rk-termin-appointment-helper
  - Nathius262/appointment-booking-bot
  - Amirmoradi94/appointment_bot

---

*Document généré le 23 mai 2026 — Analyse du portail RK-Termin (service2.diplo.de) v1.0*
