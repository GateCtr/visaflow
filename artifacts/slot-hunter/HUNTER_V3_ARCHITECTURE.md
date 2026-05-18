# 🏗️ HUNTER BOT V3 "CHASSEUR" — Architecture & Spécifications

> Document de référence pour l'implémentation. Basé sur les tests du 18/05/2026 et l'analyse complète du système V2.

---

## 📋 DONNÉES CONFIRMÉES PAR TEST (18/05/2026)

| Donnée | Valeur | Source |
|--------|--------|--------|
| Limite logins/jour/compte | **10** (11ème → restriction) | Test encoraplus@gmail.com |
| Reset restriction | **00:00 UTC** | Code account-restriction.ts |
| Token lifetime | **60 min** (Cognito JWT) | Décodage JWT |
| Refresh token | **INTERDIT** — tue ANCIEN + NOUVEAU token | Test confirmé |
| CSRF token | **Jamais renvoyé** par le serveur — booking passe SANS | Captures + test |
| Login accepte IP datacenter | Oui (Identity service) | Test 54.224.93.129 |
| API métier + IP datacenter | **401 systématique** | Test confirmé |
| API métier + IP résidentielle | **200** (token original) | Test 2captcha gateway |
| Endpoint `getallbyuser` | 401 même avec token valide (admin-only?) | Test confirmé |
| Endpoint `getUserHistoryApplicantPaymentStatus` | **200** OK | Test confirmé |

---

## 🔴 RÈGLES ABSOLUES (JAMAIS ENFREINDRE)

1. **JAMAIS de POST /refreshToken** — tue la session entière
2. **JAMAIS de POST /logout** — le JWT expire naturellement (60 min)
3. **MAX 9 logins/jour/compte** (marge 1 vs limite 10)
4. **1 IP = 1 session complète** — si IP change, token = mort
5. **`/appointments/search` est OBLIGATOIRE** avant tout scan — fournit les vrais IDs

---

## 📐 ARCHITECTURE MODULAIRE V3

### Principe : 1 fichier = 1 responsabilité, < 300 lignes

```
src/v3/
├── core/
│   ├── session-pool.ts          # Gestion budget login (9/jour), allocation rush vs standard
│   ├── proxy-cascade.ts         # 3-way failover (iProyal → BrightData → 2captcha)
│   ├── token-store.ts           # Cache tokens + Redis persistence
│   └── types.ts                 # Interfaces communes V3
│
├── scan/
│   ├── scan-orchestrator.ts     # Décide QUAND scanner (chrono + prediction)
│   ├── scan-session.ts          # 1 session de scan (login → getFirstAvailable → ... → fin)
│   ├── scan-months.ts           # Navigation multi-mois (calendrier)
│   ├── scan-slots.ts            # getSlotDates + getSlotTime pour 1 mois
│   └── scan-preflight.ts        # Warm-up, /search, transform, ofc-list
│
├── booking/
│   ├── booking-direct.ts        # PUT /schedule ou /reschedule (flow normal)
│   ├── booking-blind.ts         # Blind booking cross-account (via Convex PubSub)
│   ├── booking-retry.ts         # Retry 409 (créneau pris par concurrent)
│   └── booking-payload.ts       # Construction payload 10 champs (schedule vs reschedule)
│
├── intelligence/
│   ├── prediction-heatmap.ts    # Early Bird — quand les slots apparaissent
│   ├── competition-tracker.ts   # Durée de vie des slots → concurrence
│   ├── discovery-enrichment.ts  # Dates captées → Convex → calendrier admin
│   └── rush-planner.ts          # Fenêtres rush dynamiques (config admin)
│
├── anti-detection/
│   ├── fingerprint.ts           # UA cycling, Accept headers, Sec-CH-UA
│   ├── human-timing.ts          # Pauses gaussiennes, jitter réseau
│   ├── keep-alive.ts            # Ping 8-12 min pour maintenir session
│   └── stealth-alternation.ts   # 1/3 getLandingPage, 2/3 getFirstAvailableMonth
│
├── admin/
│   ├── config-schema.ts         # Validation hunterConfig V3
│   ├── bot-log.ts               # Logs clés (5 types seulement)
│   └── stats-reporter.ts       # Stats Convex (budget, couverture, prédiction)
│
└── index.ts                     # Point d'entrée V3 (remplace ou wrappe l'ancien)
```

---

## 🔧 MODULE : SESSION POOL (core/session-pool.ts)

### Budget Login Allocator

```typescript
interface LoginBudget {
  maxPerDay: 9;               // Hard cap (marge 1 vs limite réelle 10)
  used: number;               // Compteur 24h glissant
  resetAt: number;            // 00:00 UTC prochain
  
  // Allocation par phase (configurable admin)
  allocation: {
    rush: number;             // Logins réservés aux rush hours (défaut: 4)
    standard: number;         // Logins pour couverture standard (défaut: 3)
    emergency: number;        // Réserve proxy crash (défaut: 2)
  };
  
  // Tracking
  loginTimestamps: number[];  // Historique pour le 24h glissant
  lastLoginAt: number;
  proxyDeathCount: number;    // Morts proxy aujourd'hui (diagnostic)
}
```

### Règles :
- Un login rush ne peut PAS être consommé en standard (et vice-versa)
- Si emergency est épuisé et proxy meurt → compte dort jusqu'au prochain rush
- Le cap est GLOBAL (inclut les logins de `getUsaSession()` ET de `accounts-keep-alive`)

---

## 🔧 MODULE : SCAN MONTHS (scan/scan-months.ts)

### Navigation multi-mois (MANQUANTE dans V2)

Le portail Angular affiche un calendrier mensuel. L'utilisateur clique ">" pour naviguer au mois suivant. Chaque clic déclenche un nouveau `getSlotDates` avec `fromDate/toDate` du mois cible.

```typescript
/**
 * Scanne plusieurs mois consécutifs jusqu'à trouver un slot dans la fenêtre admin.
 * Simule la navigation humaine entre les mois du calendrier.
 * 
 * Flow par mois :
 *   1. getSlotDates({fromDate: 1er du mois, toDate: dernier du mois, ...})
 *   2. Si dates trouvées dans fenêtre → getSlotTime sur la première date
 *   3. Si slot horaire trouvé → return SlotFound
 *   4. Sinon → pause 1-3s (simule clic flèche ">") → mois suivant
 * 
 * Limite : max 3 mois scannés par session (anti-détection)
 */
async function scanMultipleMonths(config: MonthScanConfig): Promise<SlotFound | null>;
```

### Important pour la Discovery :
- Chaque mois scanné enrichit le calendrier Convex (dates trouvées/ignorées)
- Même si une date est hors fenêtre admin, elle est reportée comme "discovered" pour le dashboard

---

## 🔧 MODULE : BOOKING PAYLOAD (booking/booking-payload.ts)

### Deux modes distincts :

```typescript
// === SCHEDULE (nouveau booking) ===
// PUT /appointments/schedule
// Body = OBJET simple
{
  appointmentId: number,          // depuis /appointments/search ou getApplicationDetails
  applicantUUID: number,          // idem
  appointmentLocationType: "OFC" | "POST",  // type du bureau cible
  appointmentStatus: "SCHEDULED",
  slotId: string,                 // alphanumérique 30 chars depuis getSlotTime
  appointmentDt: "2026-09-15",   // YYYY-MM-DD depuis getSlotDates
  appointmentTime: "9:00 AM",    // format 12h AM/PM (formatUItime)
  postUserId: number,            // OFC bureau cible
  applicantId: string | number,  // GSS ID depuis /search ou getTransformData
  applicationId: string,         // portalApplicationId
}

// === RESCHEDULE (reporter un RDV existant) ===
// PUT /appointments/reschedule
// Body = ARRAY [objet] ← DIFFÉRENCE CRITIQUE
[{
  ...mêmes 10 champs que schedule...,
  rescheduleType: "POST" | "OFC",  // type du RDV EXISTANT (pas celui qu'on veut)
}]
```

### Headers booking (les deux modes) :
```typescript
{
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  "Referer": reschedule 
    ? "https://www.usvisaappt.com/visaapplicantui/home/dashboard/manage-appointment"
    : "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment",
  "Cookie": `APP_ID_TOBE=${applicationId}; missionId=${missionId}`,
  // CSRF envoyé mais VIDE (le serveur l'ignore — jamais renvoyé)
  "CookieName": "XSRF-TOKEN=",
  "X-XSRF-TOKEN": "",
}
```

---

## 🔧 MODULE : RUSH PLANNER (intelligence/rush-planner.ts)

### Fenêtres Rush V3 (Kinshasa WAT = UTC+1)

| Phase | Heures WAT | Jours | Intervalle Scan | Logins alloués |
|-------|-----------|-------|----------------|----------------|
| **RUSH Matin** | 07:00–09:30 | Lun-Ven | 20-60s | 2 |
| **RUSH Midi** | 12:00–14:00 | Lun-Ven | 30-90s | 1 |
| **RUSH Vendredi** | Ven 14:00–17:00 | Ven | 20-60s | 1 (extra) |
| **Standard** | 09:30–12:00 / 14:00–22:00 | Tous | 60-180s | 3 |
| **Nuit** | 22:00–07:00 | Tous | 5-8 min | 1 (minimal) |
| **Lundi Matin Boost** | Lun 07:00–09:00 | Lun | 15-40s | 1 (extra) |

### Configurable admin (bot-config Convex) :
```
"rush_windows": '[{"start":7,"end":9.5,"days":[1,2,3,4,5]},{"start":12,"end":14},{"start":14,"end":17,"days":[5]}]'
"night_mode": "minimal"
"scan_intensity": "aggressive"
"monday_boost": "true"
```

### Intelligence ajoutée :
- Si prediction heatmap score > 0.6 HORS rush → activer burst temporaire (2 min)
- Si competition extreme (slot lifespan < 30s) → override intervalle à 15-20s
- Si logins restants < 3 → passer en mode "conservation" (intervalles doublés)

---

## 🔧 MODULE : DISCOVERY ENRICHMENT (intelligence/discovery-enrichment.ts)

### Ce qui est reporté à Convex (pour le calendrier admin) :

```typescript
interface DiscoveryEvent {
  // Quand une date est trouvée (getSlotDates retourne des dates)
  applicationId: string;
  office: string;
  dateFound: string;        // "2026-09-15"
  timeFound?: string;       // "9:00 AM" (si getSlotTime réussi)
  outcome: "captured" | "ignored" | "discovered";
  reason?: string;          // "after_deadline" | "before_from" | "no_time_slots" | "booked" | "blind_shared"
  mode: "schedule" | "reschedule";
  
  // NOUVEAU V3 : enrichissement pour le calendrier
  monthScanned: string;     // "2026-09" — quel mois a été scanné
  allDatesInMonth: string[]; // Toutes les dates disponibles ce mois-là
  scanSource: "eclaireur" | "confine" | "direct";
}
```

### Pour le Blind Booking :
Quand un éclaireur découvre des dates, il publie :
```typescript
// Convex PubSub
{
  type: "slot_broadcast",
  sourceAccount: "eclaireur@email.com",
  office: "Kinshasa",
  dates: ["2026-09-04", "2026-09-11", "2026-09-18"],
  slotIds: ["hHPzm1VQ...", "kJmN2oP...", ...],  // Si getSlotTime a été fait
  discoveredAt: timestamp,
}
```

---

## 🔧 MODULE : BOT LOG (admin/bot-log.ts)

### 5 types de logs UNIQUEMENT (pas de spam) :

```typescript
// 1. Session
botLog("session_lifecycle", { 
  event: "login" | "expire" | "proxy_death",
  username, loginNumber, budgetRemaining, ip, proxy 
});

// 2. Slot détecté
botLog("slot_event", {
  event: "detected" | "booked" | "lost" | "blind_shared",
  ofc, date, time, slotId, latencyMs, competition, window
});

// 3. Budget (toutes les 10 min)
botLog("budget_status", {
  logins: { used, remaining, nextRushIn },
  prediction: { window, score, nextHot },
  competition: { level, medianLifespan },
  coverage: { todayMinutes, gapMinutes }
});

// 4. Discovery batch (fin de scan)
botLog("discovery_batch", {
  monthsScanned, datesFound, datesIgnored, blindShared, reasons
});

// 5. Erreur critique
botLog("critical_error", {
  type: "restriction" | "all_proxy_down" | "budget_exhausted",
  username, details, recoveryAction
});
```

---

## 🔧 SÉQUENCE D'APPELS OBLIGATOIRE (scan complet)

### Mode SCHEDULE (nouveau booking) :
```
1. POST /identity/user/login          → accessToken + refreshToken (IGNORÉ)
2. GET  /getUserHistoryApplicantPaymentStatus  → applicationId, pendingAppoStatus
3. POST /appointments/search           → visaType, visaClass, applicantId, appointmentId ⭐ OBLIGATOIRE
4. GET  /workflow/getTransformData/{appId} → stateCode, appointmentPriority, visaCategoryKey
5. GET  /lookupcdt/wizard/getpost       → OFC list (postUserId, officeType)
6. POST /modifyslot/getFirstAvailableMonth → present?, date du premier mois dispo
7. POST /modifyslot/getSlotDates        → dates[] dans le mois (format objet ou string ISO)
   [7b. Naviguer mois suivant si aucun slot dans fenêtre — répéter 7 max 3 fois]
8. POST /modifyslot/getSlotTime         → timeSlots[] (slotId, startTime, endTime)
9. PUT  /appointments/schedule          → booking (payload objet 10 champs)
```

### Mode RESCHEDULE (reporter RDV existant) :
```
1-6. Identique
6b. Referer = /home/appointment/slot?type=POST&appUUID=xxx&applicantId=xxx&ofcAppointmentDate=
7. getSlotDates                    → format string ISO ["2026-09-04T00:00:00.000+00:00", ...]
8. getSlotTime                     → identique
9. PUT /appointments/reschedule     → payload ARRAY [{...10 champs + rescheduleType}]
   Referer = manage-appointment
```

### Différences clés entre les modes :
| Aspect | Schedule | Reschedule |
|--------|----------|------------|
| Endpoint booking | `/appointments/schedule` | `/appointments/reschedule` |
| Body format | Objet `{}` | Array `[{}]` |
| Champ extra | — | `rescheduleType: "POST"` |
| getSlotDates format réponse | `[{date, slotsAvailable}]` | `["2026-09-04T00:00:00.000+00:00"]` |
| Referer scan | `/create-appointment` | `/home/appointment/slot?type=...` |
| Referer booking | `/create-appointment` | `/manage-appointment` |
| locationType payload slots | `ofc.officeType ?? "OFC"` | `appDetails.appointmentLocationType ?? "POST"` |

---

## 📊 ADMIN CONFIG V3 (hunterConfig étendu)

```typescript
interface HunterConfigV3 {
  // === Existants (conservés) ===
  embassyUsername: string;
  embassyPassword: string;
  isActive: boolean;
  portalApplicationId?: string;
  slotDateFrom?: string;
  slotDateDeadline?: string;
  rescheduleMode?: boolean;
  rescheduleExistingDate?: string;
  useResidentialProxy?: boolean;
  
  // === NOUVEAUX V3 ===
  accountRole?: "eclaireur" | "confine" | "hybride";  // Rôle dans la stratégie
  currentAppointmentDate?: string;  // Date RDV actuel (détermine éclaireur/confiné)
  maxLoginsPerDay?: number;         // Override budget (défaut: 9)
  blindBookingEnabled?: boolean;    // Activer blind booking cross-account
  slotPriorityDates?: string[];     // Dates préférées ["2026-09-*", "2026-10-*"]
  maxMonthsToScan?: number;         // Combien de mois naviguer (défaut: 3)
  preferredProxy?: string;          // "iproyal" | "brightdata" | "2captcha"
  nightModeEnabled?: boolean;       // Scanner la nuit (1 login/nuit)
  rushWindowsOverride?: string;     // JSON fenêtres rush personnalisées
}
```

---

## 🔄 MIGRATION V2 → V3

### Approche : Wrapper progressif (pas de big bang)

1. **Phase 1** : Créer `src/v3/` avec les nouveaux modules
2. **Phase 2** : `src/v3/index.ts` wrappe l'ancien `impl.ts` en ajoutant :
   - Le budget global (compteur login cross-module)
   - La navigation multi-mois
   - Les rush windows améliorés
3. **Phase 3** : Migrer progressivement chaque module de `usaPortal/` vers `v3/`
4. **Phase 4** : Supprimer l'ancien code quand tout est migré

### Ce qui est CONSERVÉ tel quel :
- `usa-http.ts` (impit, fingerprint TLS) — fonctionne bien
- `usa-auth.ts` (login AES chiffré + CAPTCHA) — fonctionne bien  
- `proxy-session-guard.ts` — protection mid-session
- `token-cache-redis.ts` — persistance Redis
- `account-restriction.ts` — tracking restriction (ajuster durée)

### Ce qui est REMPLACÉ :
- `impl.ts` (1083 lignes) → split en `scan-session.ts` + `scan-preflight.ts`
- `continuous-refresh.ts` (700+ lignes) → simplifié dans `scan-orchestrator.ts`
- `accounts-keep-alive.ts` (700+ lignes) → `session-pool.ts` + `keep-alive.ts`
- `config.ts` (230 lignes de constantes) → `config-schema.ts` (validé + admin-pilotable)

---

## ⚡ IDÉES INTELLIGENCE V3

### 1. "Canary Login" (Pré-positionnement rush)
- 5 min AVANT chaque rush window → login préventif
- Le token est prêt au moment exact où les slots apparaissent
- Coût : 1 login "early bird" par rush (inclus dans allocation rush)

### 2. "Fast-Track Booking" (Compétition extrême)
Si durée vie slots < 30s ET slot détecté par getFirstAvailableMonth :
- Skip getSlotDates → aller directement getSlotTime avec `fromDate=date, toDate=date`
- Économise 1 requête = 2-4s gagnées
- Risque : slotDate pourrait être hors fenêtre → vérifier APRÈS

### 3. "Cross-Account CSRF Sharing" 
- ~~Le csrf est obtenu au refresh~~ → LE CSRF N'EXISTE PAS (jamais renvoyé)
- Le booking passe avec csrf VIDE → aucune action requise
- **Supprimé de l'architecture**

### 4. "Smart Night Mode"
- 1 login à 02:00 UTC (maintenance serveur batch)
- Scan toutes les 5 min pendant 60 min
- Si slot → book immédiatement (pas de blind booking la nuit)
- Coût : 1 login sur le budget "emergency"

### 5. "Prediction-Driven Burst"
Quand le heatmap prédit un slot avec score > 0.7 :
- Réduire l'intervalle à 15s pendant 5 min
- Si rien après 5 min → revenir à l'intervalle normal
- Max 2 bursts par heure (anti-détection)

### 6. "Discovery Calendar View"
Chaque scan enrichit le calendrier admin Convex avec :
- Toutes les dates trouvées (même hors fenêtre)
- La dernière heure vue pour chaque date
- Le nombre de fois qu'une date a été vue (stabilité)
- Corrélation avec les prédictions heatmap

---

## 📈 ESTIMATION PERFORMANCE V3 vs V2

| Métrique | V2 Actuel | V3 Chasseur |
|----------|-----------|-------------|
| Logins/jour utilisés | 5-8 (souvent gaspillés) | **9 max, alloués intelligemment** |
| Couverture rush (4h/j) | ~60% | **95%** (canary login) |
| Couverture 24h (1 compte) | ~10h | **10h optimisées sur les rush** |
| Couverture 24h (3 comptes) | ~18h (gaps) | **22h** (relais + night mode) |
| Temps réaction slot → book | 5-15s (getSlotDates + getSlotTime) | **3-8s** (fast-track si compétition extrême) |
| Mois scannés par session | **1 seul** | **Jusqu'à 3** (navigation calendrier) |
| Blind booking cross-account | ❌ | ✅ (via Convex PubSub) |
| Prédiction exploitée | Partiellement (multiplier passif) | **Active** (drive les bursts) |
| Discovery → Action | Fire-and-forget | **Calendrier enrichi + blind booking** |
| Maintenance code | Impossible (fichiers 700-1000 lignes) | **< 300 lignes/fichier** |
