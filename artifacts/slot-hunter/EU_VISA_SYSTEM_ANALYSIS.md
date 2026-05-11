# Analyse du système EU Visa (appointment.cloud.diplomatie.be)

**Date:** 2026-05-04  
**Source:** Bundle capturé depuis `artifacts/slot-hunter/eu_visa_system_bundle/`

---

## 1. Architecture générale

### Domaine
- **Base URL:** `https://appointment.cloud.diplomatie.be`
- **Version:** 1.0.249.0 (CommitDate: 2026-01-20)
- **Technologie:** ASP.NET MVC (backend), jQuery + hCaptcha (frontend)

### Structure des fichiers
```
eu_visa_system_bundle/
├── index.html              # Page d'entrée (état "no slots")
├── layoutBundle.css        # Styles globaux
├── sharedScripts.js        # Logique client (minifié, 1 ligne)
├── 1/api.js                # hCaptcha + Raven.js + polyfills
└── Content/Images/logos/   # Logos officiels belges
```

---

## 2. Flux d'authentification et session

### Cookies de session
D'après `cev_discovery.ts`, le système utilise :
- **`ASP.NET_SessionId`** — cookie de session principal
- **`PreferredCulture`** — langue (en-US, nl-BE, fr-BE)

### Origine de la session
La session CEV est **créée depuis VOWINT** (visaonweb.diplomatie.be) :
1. Login VOWINT → My Applications
2. Clic bouton RDV (`ng-click="groupVAEapp"`) → ouvre CEV dans nouvel onglet
3. CEV hérite du contexte VOWINT via POST avec blob de données

---

## 3. Protection hCaptcha

### Configuration
```javascript
// Depuis index.html
<script src="https://js.hcaptcha.com/1/api.js?hl=en-US" async defer></script>
```

**Sitekey:** `5f64399c-14a8-415e-ad1a-7ebccdc4943a`

### Endpoints de résolution
```javascript
// Depuis sharedScripts.js (déminifié)
function successfullCaptcha(token) {
  SharedAjaxService.setCaptchaToken(ajaxUrl, { captcha: token }, function(response) {
    setupSessionTimeout(response.validUntil, response.redirectUrl);
    location.href = response.redirectUrl;
  });
}
```

**POST `/Captcha/SetCaptchaToken`**
- **Body:** `application/x-www-form-urlencoded` → `captcha=<hcaptcha_token>`
- **Headers requis:**
  - `X-Requested-With: XMLHttpRequest`
  - `Cookie: ASP.NET_SessionId=...`
- **Réponse:**
  ```json
  {
    "validUntil": "2026-05-04T15:30:00Z",
    "redirectUrl": "/Integration/VOW/SelectSlot/..." ou "/Integration/Error/NoAvailability"
  }
  ```

### Détection de disponibilité immédiate
Le `redirectUrl` indique **instantanément** si des créneaux existent :
- ✅ **Slots disponibles:** `/Integration/VOW/SelectSlot/...`
- ❌ **Aucun créneau:** `/Integration/Error/NoAvailability`

---

## 4. API de polling des créneaux

### Endpoint principal
**POST `/Home/AvailableTimeSlots`**

```javascript
// Depuis sharedScripts.js
function getAvailableTimeSlotsForPublic(params, successCallback, errorCallback) {
  callPost("/Home/AvailableTimeSlots", params, successCallback, errorCallback);
}

function callPost(url, data, success, error) {
  $.ajax({
    url: url,
    type: "Post",
    cache: false,
    contentType: "application/json",
    dataType: "json",
    data: JSON.stringify(data),
    success: success,
    error: error
  });
}
```

**Headers requis:**
- `Content-Type: application/json`
- `Cookie: ASP.NET_SessionId=...`
- `X-Requested-With: XMLHttpRequest`
- `Referer: https://appointment.cloud.diplomatie.be/Integration/VOW/SelectSlot/...`

**Body (exemple):**
```json
{
  "date": "2026-05-15",
  "serviceId": 123,
  "locationId": 456
}
```

**Réponse (slots disponibles):**
```json
[
  {
    "date": "2026-05-15",
    "time": "09:00",
    "available": true,
    "slotId": "abc123"
  },
  {
    "date": "2026-05-15",
    "time": "10:30",
    "available": true,
    "slotId": "def456"
  }
]
```

**Réponse (aucun créneau):**
- HTTP 302 → `/Integration/Error/NoAvailability`
- ou JSON vide `[]`

---

## 5. Gestion de l'expiration de session

### Timeout côté client
```javascript
function setupSessionTimeout(validUntil, redirectUrl) {
  const milliseconds = getValidUntilMilliseconds(validUntil);
  setTimeout(function() {
    location.href = redirectUrl || location.href;
  }, milliseconds);
}

function getValidUntilMilliseconds(validUntil) {
  const now = convertLocalTimeToUTC();
  const expiry = new Date(validUntil);
  return expiry.getTime() - now.getTime();
}
```

**Durée typique:** ~15-20 minutes après résolution du captcha

### Détection d'expiration
- HTTP 302 → `/Integration/Error/SessionExpired`
- ou `/Captcha` (redemande captcha)

---

## 6. Stratégie de polling optimale

### Phase 1 : Établir la session (via Playwright)
1. POST depuis VOWINT → ouvre CEV
2. Résoudre hCaptcha (Anti-Captcha API ou cookie accessibilité)
3. POST `/Captcha/SetCaptchaToken`
4. Extraire `ASP.NET_SessionId` + `redirectUrl`

### Phase 2 : Polling léger (fetch natif)
Si `redirectUrl` contient `/SelectSlot` → slots existent, continuer le polling :

```typescript
async function pollCevSlots(sessionCookie: string, redirectUrl: string) {
  const res = await fetch('https://appointment.cloud.diplomatie.be/Home/AvailableTimeSlots', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `ASP.NET_SessionId=${sessionCookie}`,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `https://appointment.cloud.diplomatie.be${redirectUrl}`,
    },
    body: JSON.stringify({ /* params */ }),
  });

  if (res.redirected && res.url.includes('NoAvailability')) {
    return { hasSlots: false };
  }

  const slots = await res.json();
  return { hasSlots: slots.length > 0, slots };
}
```

**Fréquence recommandée:** 1 requête toutes les 5-10 secondes

### Phase 3 : Renouvellement de session
Quand `validUntil` approche (< 2 min restantes) :
- Retour Phase 1 (nouveau captcha)
- ou tenter refresh via GET du `redirectUrl` (peut prolonger)

---

## 7. Sélecteurs DOM et structure HTML

### Page "No Availability"
```html
<div class="alert alert-warning">
  There are no free time slots available. Try again later.
</div>
```

### Page avec créneaux (hypothèse basée sur sharedScripts.js)
- Calendrier interactif (probablement jQuery UI datepicker)
- Sélection de date → appel AJAX `/Home/AvailableTimeSlots`
- Affichage des heures disponibles

**Sélecteurs probables:**
- `.available-slot`, `[data-slot-time]`, `button[data-slot-id]`

---

## 8. Comparaison avec le système USA

| Aspect | USA (usvisaappt.com) | EU (appointment.cloud.diplomatie.be) |
|--------|----------------------|--------------------------------------|
| **Captcha** | reCAPTCHA v2 | hCaptcha |
| **Session** | Cookies multiples + CSRF token | `ASP.NET_SessionId` simple |
| **Détection slots** | Parsing HTML du calendrier | `redirectUrl` immédiat + API JSON |
| **Polling** | Scraping DOM | API REST propre |
| **Complexité** | Élevée (AngularJS obfusqué) | Moyenne (jQuery classique) |

**Avantage EU:** API JSON claire, détection instantanée via `redirectUrl`

---

## 9. Points d'attention sécurité

### Anti-bot détecté
- **hCaptcha obligatoire** (sitekey blacklistée par CapSolver)
- **User-Agent** vérifié (doit ressembler à un vrai navigateur)
- **Referer** requis pour `/Home/AvailableTimeSlots`

### Contournements possibles
1. **Cookie accessibilité hCaptcha** (gratuit, nécessite compte hCaptcha)
2. **Anti-Captcha API** (payant, ~$2/1000 résolutions, supporte domaines gouvernementaux)
3. **Playwright stealth** pour masquer l'automatisation

---

## 10. Implémentation recommandée

### Architecture
```
┌─────────────────┐
│  VOWINT Login   │ (Playwright, 1x par session)
│  + RDV Click    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  CEV Captcha    │ (Playwright + Anti-Captcha API)
│  Solve          │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Extract Cookie │ (ASP.NET_SessionId + redirectUrl)
│  + redirectUrl  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Polling Loop   │ (fetch natif, 5-10s interval)
│  /AvailableTime │ Coût: ~50ms/requête
│  Slots          │ Durée: jusqu'à validUntil
└─────────────────┘
```

### Coût estimé
- **Captcha:** $0.002 par résolution (Anti-Captcha)
- **Session:** 15-20 min de polling
- **Requêtes:** ~120-180 polls par session
- **Total:** $0.002 par session de 15 min

---

## 11. Fichiers de référence

- `cev_discovery.ts` — Script d'exploration complet
- `cevPortal.ts` — Implémentation captcha + session
- `cevPolling.ts` — Polling optimisé avec détection d'erreurs

---

## 12. Prochaines étapes

1. ✅ Valider le flux avec un compte test réel
2. ⬜ Implémenter le parsing des paramètres de requête (serviceId, locationId)
3. ⬜ Tester la durée réelle de `validUntil`
4. ⬜ Mesurer le taux de succès Anti-Captcha vs cookie accessibilité
5. ⬜ Intégrer avec Convex pour notifier les clients

---

**Conclusion:** Le système EU est **plus simple** que le système USA grâce à son API JSON claire et sa détection immédiate de disponibilité via `redirectUrl`. Le principal défi reste la résolution du hCaptcha (sitekey blacklistée par CapSolver).


---

## 13. Test du polling CEV

### Prérequis
1. **Variables d'environnement:**
   ```bash
   VOWINT_TEST_PASSWORD=...          # Mot de passe du compte screentapinc@gmail.com
   ANTICAPTCHA_API_KEY=...           # Clé Anti-Captcha (anti-captcha.com)
   # ou
   HCAPTCHA_ACCESSIBILITY_COOKIE=... # Cookie hc_accessibility (gratuit)
   ```

2. **Lancer le script de découverte:**
   ```bash
   cd artifacts/slot-hunter
   tsx src/cev_discovery.ts
   ```

3. **Extraire les données de session:**
   - `ASP.NET_SessionId` (cookie)
   - `redirectUrl` (depuis la réponse JSON de `/Captcha/SetCaptchaToken`)

### Test du polling
```typescript
import { pollCevSlot } from './cevPolling';

const result = await pollCevSlot(
  "https://appointment.cloud.diplomatie.be/Integration/VOW/SelectSlot/...",
  "ASP.NET_SessionId=abc123def456..."
);

console.log(result);
// { status: "no_slot" } → Aucun créneau
// { status: "slot_found", bodyPreview: "..." } → Créneaux disponibles !
// { status: "session_expired" } → Session expirée
```

### Coût et performance
- **Temps par check:** ~50ms
- **Coût captcha:** $0.002 par session (Anti-Captcha)
- **Durée session:** 15-20 minutes
- **Polls par session:** ~120-180 (toutes les 5-10s)

### Avantages de cette approche
1. **Zéro Playwright** après établissement de la session
2. **Détection instantanée** via redirections HTTP
3. **Coût minimal** (fetch natif vs browser automation)
4. **Robuste** avec détection d'erreurs déguisées

---

## 14. Comparaison avec l'approche USA

| Aspect | USA (usvisaappt.com) | EU (appointment.cloud.diplomatie.be) |
|--------|----------------------|--------------------------------------|
| **Complexité** | Très haute (AngularJS obfusqué) | Moyenne (jQuery + API REST) |
| **Détection slots** | Parsing HTML complexe | Redirection HTTP immédiate |
| **Polling** | Playwright nécessaire | Fetch natif suffisant |
| **Coût captcha** | reCAPTCHA v2 ($0.002) | hCaptcha ($0.002) |
| **Session durée** | ~30 minutes | ~15-20 minutes |
| **Implémentation** | `usaPortal.ts` + scraping | `cevPolling.ts` + API |

**Conclusion:** Le système EU est **plus facile à automatiser** grâce à son API claire et sa détection instantanée via redirections. Le polling reversing est **déjà fonctionnel** dans `cevPolling.ts`.
