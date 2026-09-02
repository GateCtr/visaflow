# Analyse du bundle — Portail visas nationaux France (consulat.gouv.fr / Troov)

**Date d'analyse :** 2026-08-31
**Portail cible :** `https://consulat.gouv.fr/ambassade-de-france-a-kinshasa/rendez-vous?name=Service%20des%20Visas`
**Éditeur :** Troov S.A.S (solution white-label pour le MEAE — Ministère de l'Europe et des Affaires étrangères)

> Analyse fondée sur les **source maps publiques** (`.js.map`, HTTP 200) → code source Vue/JS
> **non minifié** reconstruit. Fait foi sur les endpoints et le flux. À re-valider avant
> toute modification (règle 03-bundle-analysis) : les hash de chunks et la sitekey Turnstile
> changent à chaque déploiement.

---

## 1. Stack technique

| Couche | Technologie |
|--------|-------------|
| Front | **Nuxt.js** (Vue 2 SSR, `data-n-head="ssr"`, `window.__NUXT__`) |
| CDN front | `consulat.gouv.fr` — **nginx** (pas de Cloudflare sur le front) |
| API | `https://api.consulat.gouv.fr/api` (REST) |
| Auth | Bearer token (admin/agent) ; **anonyme** pour le parcours RDV public |
| Anti-bot API | Handshake maison Troov (`x-gouv-*`) + **HTTP 418 "teapot"** si absent |
| Captcha | **Cloudflare Turnstile** (standard, render explicit) |
| Libs | jQuery 3.6, Bootstrap 4.6, vue-treeselect, chartist, dayjs |

### Config runtime (`window.__NUXT__.$config`)
- `API_HOST` = `https://api.consulat.gouv.fr/api`
- `turnstile.sitekey` = `0x4AAAAAAAc-bWzy0zJTmAqs` *(runtime, non hardcodée dans le JS)*
- `handshakeHeader` = `x-gouv-handshake`
- `googleMaps.id`, `API_ROOT`, `browserBaseURL`

---

## 2. Protection anti-bot — Handshake Troov (CRITIQUE)

Un appel direct à l'API **sans handshake** renvoie :
```
HTTP 418  {"name":"ImATeapotError","type":"IM_A_TEAPOT_ERROR_418","status":418,"message":"¯\\_(ツ)_/¯ 😅"}
```

### Bootstrap obligatoire (avant TOUT appel, même « public »)
1. `HEAD /handshake` → réponse `200` avec headers :
   - `x-gouv-handshake: <token>` → le **`x-csrf-token`** à rejouer sur les POST
   - `x-gouv-app-id: fr.gouv$+<id>-meae-ttc` → l'app-id (rejoué en header `x-gouv-app-id`)
   - `Access-Control-Expose-Headers: x-gouv-ck, x-gouv-csrf, x-gouv-limit, x-gouv-app-id, x-gouv-handshake`
   - `x-gouv-limit` → rate limiting côté serveur
2. `GET /captcha?locale=fr` → headers `x-gouv-csrf` (uui) + `x-gouv-ck` (value) [ancien captcha image, gardé pour compat]

### Headers requis (intercepteur axios `onRequest`)
```
x-csrf-token: <x-gouv-handshake du HEAD>        # sur POST/PUT sensibles
x-gouv-app-id: fr.gouv$+<id>-meae-ttc
Authorization: Bearer <token>                    # UNIQUEMENT admin/agent (query.token ou user.token)
```
`paramsSerializer` = `qs.stringify(params, { arrayFormat: 'comma', encode: false })`.

---

## 3. Endpoints API (source non minifiée — fait foi)

Base : `https://api.consulat.gouv.fr/api`

### Public / bootstrap
| Méthode | Endpoint | Notes |
|---------|----------|-------|
| `HEAD` | `/handshake` | Pose le token handshake + app-id (obligatoire) |
| `GET` | `/captcha?locale=fr` | Captcha image legacy (headers csrf) |
| `GET` | `/teams?lang=fr&name=` | Liste des consulats (teams) |
| `GET` | `/team/{id}?lang=fr` | Détail d'un consulat |
| `POST` | `/test-turnstile` `{captcha}` | Validation d'un token Turnstile |

### Session de réservation (parcours anonyme)
| Méthode | Endpoint | Body / params |
|---------|----------|---------------|
| `POST` | `/team/{team}/reservations-session` | `{standaloneServiceName, sessionId, captcha}` + header `x-csrf-token` |
| `GET` | `/team/{team}/reservations-session` | `?sessionId=&standaloneServiceName=` |
| `POST` | `/team/{team}/reservations-session/{id}/update-step-value` | `{key, value, stepIndex, dynamicStepIndex}` |
| `POST` | `/team/{team}/reservations-session/{id}/update-dynamic-steps` | `{key, steps}` |

### Résolution du consulat (slug → team)
| Méthode | Endpoint | Notes |
|---------|----------|-------|
| `GET` | `/team/slug/{slug}?lang=fr` | Résout le slug d'URL en team complète (`getPublicTeamBySlug`) |

**Vérifié en live (2026-08-31) — Ambassade de France à Kinshasa :**
- slug : `ambassade-de-france-a-kinshasa`
- **teamId : `6230a987df141cedfef4a188`**
- timezone : **`Africa/Kinshasa`** | `enable_only_reservation=false` | `has_paid_reservation=false`
- Services (`reservations_shop_availabilty[].openings`, jours 1-4 = lun-jeu) :

| Service | serviceId | Horaires |
|---------|-----------|----------|
| ADF - Registre / CNI / passeport / déclaration | `6346e242c47b29722d5f5f4e` | 08h30-13h00 |
| ADF - Dépôt des Légalisations | `6346e242c47b29722d5f5f50` | 08h00-08h30 |
| État civil | `6346e242c47b29722d5f5f51` | 08h00-12h30 |
| **Visas** (cible finale) | `6346e242c47b29722d5f5f52` | 08h00-11h15 |

### SCAN — disponibilités (CŒUR DU HUNTER) — VALIDÉ EN LIVE
```
GET /team/{teamId}/reservations/availability
  ?name=<NOM TEXTUEL COMPLET du service, url-encodé>   # PAS le serviceId
  &date=YYYY-MM-DD                                       # OBLIGATOIRE — 1 jour par requête
  &places=1
  &matching=
  &maxCapacity=1
  &sessionId=<sessionId>
```
Headers : `x-gouv-app-id`, `x-gouv-web: fr.gouv.consulat`, `x-csrf-token` (handshake).

**DTO réponse (array de créneaux du jour) — confirmé live 2026-08-31 :**
```json
[
  {"time":"08:30","rate":"0.00","capacity":1},
  {"time":"09:00","rate":"0.00","capacity":1},
  ...
]
```
- `time` = "HH:MM", `capacity` = places libres, `rate` = tarif ("0.00" si gratuit).
- `[]` = **aucun créneau ce jour** (ex. week-end / jour fermé).
- Le scan porte sur **UN jour** → pour balayer, itérer `date` sur N jours.
- **Preuve live** (service ADF Kinshasa) : 11 jours/21 avec créneaux (lun-jeu 08:30→12:30, jusqu'à 9/j), 0 le ven/we — cohérent avec les `openings` j1-j4.

### Bornage du scan — `get-interval` + `exclude-days` (VALIDÉS EN LIVE)

**`GET /team/{teamId}/reservations/get-interval?serviceId={serviceId}`** → fenêtre à scanner :
```json
{"start":"2026-09-01","end":"2026-10-29"}
```
> ⚠️ Ici `serviceId` = l'**`_id`** du service (ex. `6346e242c47b29722d5f5f4e`), PAS le nom.
> C'est la fenêtre officielle calculée serveur (ADF : ~59 jours) → évite de deviner J+1→J+30.

**`POST /team/{teamId}/reservations/exclude-days`** → jours fermés/exclus :
```jsonc
// body
{ "session": { "6346e242c47b29722d5f5f4e": true }, "sessionId": "<sessionId>" }
// réponse (array de dates YYYY-MM-DD à NE PAS scanner)
["2025-12-25","2026-01-01",…,"2026-08-31","2026-09-04","2026-09-05","2026-09-06","2026-09-11",…]
```
> Le body `session` est un dictionnaire `{serviceId: true}`. La réponse combine fériés +
> week-ends + jours sans ouverture. Sur ADF : les ven/sam/dim sont exclus (cohérent openings j1-j4).

**STRATÉGIE DE SCAN OPTIMALE (comme le frontend) :**
1. `get-interval` → `[start, end]`
2. `exclude-days` → set des jours fermés
3. Itérer `availability?date=…` UNIQUEMENT sur les jours ∈ [start,end] ET ∉ exclude-days
   → réduit drastiquement le nombre de requêtes (ex. ~24 jours ouvrables au lieu de 59).

**✅ VALIDÉ END-TO-END EN LIVE (2026-08-31, service ADF) :**
- get-interval → `2026-09-01 → 2026-10-30` (60 jours)
- exclude-days → 38 jours exclus (fériés + ven/sam/dim)
- Scan ciblé → **35 jours ouvrables** (25 requêtes évitées, -42%)
- Résultat : **35 jours avec créneaux, 301 créneaux au total** (`{time,rate,capacity}`)
- Flux complet handshake→Turnstile→session→get-interval→exclude-days→availability opérationnel.

| Autre | |
|---|---|
| `GET /team/{teamId}/reservations/remaing` | `mode, name, date, places, matching, source` *(typo serveur)* |

> **CONTRAINTE CONFIRMÉE EN LIVE** : sans `sessionId` valide → `HTTP 404
> {"message":"SESSION_ERROR"}`. Sans `date` → `[]` (array vide). Le scan exige donc :
> (1) une session active (`POST /reservations-session`, coûte 1 Turnstile), (2) un `date`.
> Conséquence archi : maintenir la session vivante + itérer sur les jours à surveiller.
> Le param `name` = le **nom textuel complet** du service (ex. « ADF - Demande
> d'inscription… »), pas l'`_id`.

> **TTL SESSION = 30 MINUTES** (confirmé live via UI) : « Votre session de réservation a
> expiré — Vous avez dépassé la durée limite de 30 minutes pour finaliser votre réservation. »
> Une session (donc 1 Turnstile) est valable ~30 min pour poller + booker. Au-delà →
> tout recommencer (handshake + Turnstile + session). Le hunter doit donc : (a) renouveler
> la session avant 30 min s'il poll longtemps, (b) avoir un Turnstile #2 prêt pour booker
> instantanément dès qu'un créneau apparaît.

### Flux validé de bout en bout (live 2026-08-31)
1. `HEAD /handshake` → x-gouv-handshake + x-gouv-app-id ✅
2. `GET /team/slug/ambassade-de-france-a-kinshasa` → teamId `6230a987df141cedfef4a188` ✅
3. Turnstile résolu via CapSolver (sitekey `0x4AAAAAAAc-bWzy0zJTmAqs`) ✅
4. `POST /team/{teamId}/reservations-session` `{standaloneServiceName, captcha}` → sessionId ✅
5. `GET .../availability?name=…&date=…&sessionId=…` → créneaux `{time,rate,capacity}` ✅

### BOOKING final — `POST /team/{team}/reservations/family`
Header : `x-csrf-token: <handshake>`. Body (source `addFamilyReservations`) :
```jsonc
{
  "reservations": { /* = getReservationsForApi(), voir ci-dessous */ },
  "language": "fr",
  "captcha": "<token Turnstile #2>",
  "sessionId": "<sessionId>"
}
```

**`reservations` = `getReservationsForApi()`** (source `family-reservation` mixin) :
```jsonc
{
  "mainUser":  { /* contact principal, cf. UserForApi */ },
  "secondaryUsers": [ /* si numberOfApplicants > 1 */ ],
  "sessionId": "<sessionId>",
  "team": "<teamId>"
}
```

**UserForApi** (`setupUserForApi`) — le `birthdate` est transformé en objet, mois **0-indexé** :
```jsonc
{
  "firstname": "...", "lastname": "...", "email": "...", "mobile": "...",
  "birthdate": { "month": 8, "day": 15, "year": 1990 },   // dayjs.month() → 0-indexé (janv=0) ; "" si invalide
  "services": [ /* ServiceForApi[] */ ]
}
```

**ServiceForApi** (`setupServiceForApi`) :
```jsonc
{
  /* ...champs de la zone/service... */
  "customFields": [ { "key": "...", "values": ["..."] } ],   // depuis zone.custom_fields
  "slotsToKeep": [
    {
      "slotValue": "slot-adf-...-2026-09-01t08-30-00-000z-08-30",  // cf. formule ci-dessous
      "date": "2026-09-01T08:30:00",                               // "YYYY-MM-DDTHH:MM:00" (date + time combinés)
      "time": "08:30",
      "serviceName": "ADF - Demande d'inscription..."
      /* month, day, hour, minute, id également présents */
    }
  ]
}
```

**Formule `slotValue`** (helper `getSlotValueForFamilyReservations`, `src/helpers/index.js`) :
```js
slotValue = slugify(`slot-${service.name}-${new Date(slot.date).toISOString()}-${slot.time}`, false).toLowerCase()
```
> Ne garder QUE les slots cochés : `slots.filter(s => checkboxesSlots.includes(s.slotValue))`.

**Réponse booking** → `data.qrCodes` (QR codes de confirmation par personne/service) → `SET_RESERVATION_SUMMARY`.

| Autres | |
|--------|--|
| `POST /team/{team}/reservations/family/already-reserved-by-users` | dédup (évite double booking d'un même user) |
| `GET /team/{team}/reservations/family/{id}/ics` | fichier .ics (responseType blob) |

### Prérequis d'un booking réussi (résumé)
1. Session active + service sélectionné (via `update-step-value` sur `servicesStep`).
2. Contacts renseignés (`mainContactDetailsStep` : nom, prénom, email, mobile, birthdate valide).
3. Slot(s) choisi(s) → `slotValue` calculé + `date` ISO combinée.
4. **2ᵉ token Turnstile** (welcome = session, confirmation = booking).
5. Header `x-csrf-token` (handshake courant, renouvelé à chaque POST session).
6. Custom fields du service remplis si `zone.custom_fields` non vide.

---

## 8. Service VISAS — config & formulaire multistep (teamId Kinshasa)

**serviceId : `6346e242c47b29722d5f5f52`** | name : `Visas` | office_type : `visa`

### Contraintes du service (depuis `reservations_shop_availabilty[]`)
| Champ | Valeur | Impact hunter |
|-------|--------|---------------|
| `openings` | lun-jeu 08:00-11:15 | jours/heures scannables |
| `dynamic_calendar` | begin J+1, end J+30 | **fenêtre de scan : demain → J+30** |
| `session_duration` | 10 min | pas des créneaux |
| `reservation_people_max` | 1 | 1 personne par RDV |
| `session_people_max` | 2 | max 2 dans une session |
| `reservation_delay_hours` | 0 | pas de délai minimum |
| `closed_days` | 25/12, 01/01, 16/01, 06/04, 01/05, 08/05, 14/05, 25/05, 30/06, 11/11, 31/12… | jours à exclure |
| `enable_prerequest` | false | **pas** d'étape pré-demande |
| `enable_timbre_electronic` | false | **pas** d'étape timbre |
| `is_open` | true | service ouvert |

### Champs exigés par le formulaire Visas
- **Contact** (`mainContactDetailsStep`, requis) : `firstname`, `lastname`, `email`, `mobile`, `birthdate {month(0-idx),day,year}`.
- **Custom field OBLIGATOIRE** — `Motif` (`key:"54cfd964c63f3386"`, type `checkbox`, `required:true`).
  Valeurs autorisées : `Regroupement familial`, `Visa retour`, `Reunification familial`,
  `Stagiaire associé`, `Conjoint de Français - Installation`, `Etudiant`, `Autres`.
  → dans le body : `customFields:[{ key:"54cfd964c63f3386", values:["<motif choisi>"] }]`.

### Étapes du formulaire multistep (persistées via `update-step-value`)
| # | Étape (stepType) | Visas ? | Contenu |
|---|------------------|---------|---------|
| 1 | welcome-step | ✅ | Turnstile #1 → `createReservationsSession` |
| 2 | services-step | ✅ | choix service + `numberOfApplicants` |
| 3 | pre-request-step | ❌ skip | `enable_prerequest=false` |
| 4 | important-information-step | ✅ | note « convocation… » (readInformations=true) |
| 5 | slots-step | ✅ | sélection créneau(x) → `slotValue` |
| 6 | main-contact-details-step | ✅ | nom, prénom, email, mobile, birthdate |
| 7 | secondary-contacts-details-step | ⤵ si >1 | contacts additionnels |
| 8 | timbre-step | ❌ skip | `enable_timbre_electronic=false` |
| 9 | custom-fields (Motif) | ✅ | motif (obligatoire) |
| 10 | ask-confirmation-step | ✅ | **Checkbox CGU + confidentialité** (obligatoire) + **Turnstile #2** (« Je ne suis pas un robot ») → `addFamilyReservations` |

> **Avant-dernière étape confirmée live (UI)** : récap RDV (date, personne, service) +
> case « J'ai lu et j'accepte les conditions d'utilisation ainsi que la politique de
> confidentialité » (doit être cochée) + widget Turnstile Cloudflare. Le clic final
> déclenche `POST /reservations/family`. La barre de progression compte ~8 étapes.

> Parcours minimal Visas (1 demandeur) : welcome → services → important-info → slots →
> contact → motif → confirmation. Chaque étape : `POST /reservations-session/{id}/update-step-value
> {key:<stepType>, value:<données>, stepIndex}`. Le booking final envoie l'agrégat via
> `reservations/family`.

### Pré-demande ANTS — NE concerne PAS le service Visas (piège)
Le champ « Pré-demande ANTS » (composant `prerequest-input.vue`) n'apparaît QUE sur les
services avec `enable_prerequest: true`. Config Kinshasa :

| Service | enable_prerequest | Motif |
|---------|-------------------|-------|
| ADF (CNI/passeport/registre) | **true** → champ ANTS affiché | ✅ |
| ADF Légalisations | false | — |
| État civil | false | ✅ |
| **Visas** | **false** → PAS de champ ANTS | ✅ |

- Le champ ANTS attend **exactement 10 caractères, en MAJUSCULES** (`minlength=maxlength=10`,
  `value.toUpperCase()`), et pointe vers `passeport.ants.gouv.fr` → c'est un numéro de
  pré-demande de **titre d'identité français** (CNI/passeport), pertinent pour le service ADF.
- **Le service Visas n'a PAS ce champ.** Le n° de référence **France-Visas** (ex.
  `FRA1IH20267004873`, 17 car.), le n° de passeport et le nom mentionnés dans la note
  proviennent du **système France-Visas amont** (`cd.ambafrance.org/Bienvenue-sur-France-Visas`),
  PAS du formulaire de RDV Troov. Ils ne font PAS partie du body `reservations/family`.
- **Conséquence hunter Visas** : le booking n'exige que le contact + le Motif. Aucun numéro
  ANTS/France-Visas à injecter dans le POST.

### ⚠️ État actuel & signature « PAS DE CRÉNEAU » (validé live 2026-08-31)

Le service **Visas** (`6346e242c47b29722d5f5f52`) retourne **0 créneau** actuellement.
Comparaison live Visas vs ADF (même consulat) :

| | Visas (vide) | ADF (créneaux) |
|---|---|---|
| serviceId | `6346e242c47b29722d5f5f52` | `6346e242c47b29722d5f5f4e` |
| get-interval | `2026-09-01 → 2026-09-29` (29 j) | `2026-09-01 → 2026-10-30` (60 j) |
| exclude-days | **41 jours exclus** (quasi tout) | 38 exclus |
| jours ouvrables restants | **1** | 35 |
| availability sur jour restant | **`[]`** (HTTP 200) | 3-9 créneaux |

**SIGNATURE « pas de créneau » (à ne PAS traiter comme erreur) :**
1. `exclude-days` exclut **presque tous** les jours (y compris des jours théoriquement
   ouvrables) → il reflète l'**état réel de l'agenda**, pas seulement fériés/week-ends.
2. `availability` renvoie **`[]` + HTTP 200** sur les rares jours restants.

> Donc « agenda vide » = `HTTP 200 [] ` (jamais une erreur), analogue au « 0B normal » Espagne.
> Le hunter détecte une **publication** quand : (a) `exclude-days` se rétracte (des jours
> ouvrables réapparaissent), et/ou (b) `availability` renvoie un array non vide.
> **Le service ADF** (`6346e242c47b29722d5f5f4e`) a des créneaux → banc de test du flux de scan.

---

## 4. Flux Turnstile (Cloudflare)

- **Loader** : `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onloadTurnstileCallback`
- **Rendu** :
  ```js
  window.turnstile.render("#turnstile-element", {
    sitekey: $config.turnstile.sitekey,        // 0x4AAAAAAAc-bWzy0zJTmAqs
    callback: e => this.$emit("on-token", e)
  })
  ```
- **2 points d'injection** (2 tokens par parcours) :
  1. `welcome-step.vue` → `handleTurnstileToken` → `createReservationsSession` (captcha dans le body)
  2. `ask-confirmation-step.vue` → `handleTurnstileToken` → `addFamilyReservations` = `POST /reservations/family` (captcha dans le body)
- **Résolution** : CapSolver (`AntiTurnstileTaskProxyLess` / `TurnstileTask`) — cf. `src/capsolver-turnstile.ts` existant.

---

## 5. Flux complet du hunter (proposé)

```
1. HEAD /handshake            → x-gouv-handshake (csrf) + x-gouv-app-id
2. Résoudre Turnstile #1 (CapSolver, sitekey 0x4AAAAAAAc-bWzy0zJTmAqs)
3. POST /team/{teamId}/reservations-session {standaloneServiceName:"Service des Visas", captcha} + x-csrf-token
   → sessionId (_id) + nouveau handshake header
4. POLLING (cœur) :
   GET /team/{teamId}/reservations/availability?places=1&sessionId={sid}&name=... → créneaux
   (+ exclude-days pour filtrer les jours fermés)
5. Si créneau trouvé :
   - update-step-value (services, contacts, dates)
   - Résoudre Turnstile #2
   - POST /team/{teamId}/reservations/family {reservations, captcha, sessionId} + x-csrf-token → booking
```

---

## 6. Contraintes & points de vigilance

- **HTTP 418** systématique sans handshake → le bootstrap est non négociable.
- **`x-gouv-limit`** = rate limiting serveur → prévoir backoff + rotation IP (proxy FR/RDC selon géo).
- **2 résolutions Turnstile** par parcours (session + booking) → coût CapSolver ×2.
- **Sitekey & hash de chunks** changent à chaque déploiement → re-télécharger le bundle (< 1 semaine) avant modif.
- **teamId Kinshasa** : à récupérer dynamiquement via `GET /teams?name=Kinshasa` (après handshake) — ne pas hardcoder.
- Timezone/locale : `Europe/Paris` côté serveur, `lang=fr`.
- Pas de Cloudflare sur le front nginx, mais Turnstile côté API : protection plus légère qu'Espagne (pas de cf_clearance à maintenir).

---

## 7. Scripts d'analyse (bundle-analysis/)

| Script | Rôle |
|--------|------|
| `download-france-bundle.js` | Télécharge la page + tous les chunks `/app/*.js` (extraction dynamique des hash) |
| `extract-france-sources.js` | Récupère les `.js.map` et reconstruit les sources Vue/JS non minifiées dans `france-bundle/sources/` |
| `find-turnstile-sitekey.mjs` | Localise la sitekey + le contexte de rendu Turnstile dans le bundle concaténé |

Sorties : `france-bundle/` (chunks + `sources/` + `page.html` + `api-paths.txt`), `france-bundle.js` (concaténé).

## Références sources clés (france-bundle/sources/)
- `src/plugins/axios/onRequest/index.js` — headers (Bearer, x-csrf-token, x-gouv-app-id)
- `src/store/user/actions.js` — `handshake()`, `getCaptcha()`
- `src/store/reservationsSession/actions.js` — session + `addFamilyReservations` (booking)
- `src/store/reservation/actions.js` — `getAvailableTimeByTeamReservation` (scan)
- `src/store/public/actions.js` — `getPublicTeams`, `getPublicTeam`
- `src/components/security/turnstile.vue` + `src/helpers/captchaMixins.js` — captcha
- `src/components/reservation/forms/steps/{welcome,services,slots,ask-confirmation}-step.vue` — étapes
