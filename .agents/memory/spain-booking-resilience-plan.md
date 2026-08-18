# Plan — Algorithme "Meute" — Résilience Booking Espagne

## Contexte

Publication créneaux 18/08/2026 à 10:16 UTC sur Kinshasa (25028fcd).
10 workers parallèles, 9 créneaux publiés le 23 septembre.
Résultats : 1 booking confirmé (NKUNGU), 9 échecs évitables.

## Problèmes identifiés (par ordre de priorité)

### P1 — Retry sur "seleccionada por otra persona"

**Cas** : YENGE tente `2026-09-23 08:30` → serveur dit "créneau pris par un autre".
**Comportement actuel** : `signin_failed` → worker sort du booking → cycle suivant.
**Fix** : Détecter le message espagnol → passer immédiatement au slot suivant dans `eligible[]` sans quitter le booking inline.

**Fichier** : `spain-dossier-worker.ts` — boucle `signinPayload` après extraction `signinErrors`.
**Détection** : `errorMessage.includes("seleccionada por otra persona") || errorMessage.includes("elegida")`
**Action** : `continue` dans la boucle `for (const candidate of eligible)` au lieu de `break`.

---

### P2 — Retry summary/ sur 504 ou null

**Cas** : RANIA obtient `bktToken` ✅ mais `summary/ → HTTP 504` → `null` → `booking_failed`.
**Comportement actuel** : 1 seul appel summary/ → si fail = booking perdu.
**Fix** :
1. Retry summary/ 2× (délai 3s, 6s) si 504 ou null.
2. Si toujours null après retries → passer au slot suivant (nouveau cycle gsf → signin → summary).

**Fichier** : `spain-dossier-worker.ts` — section `📝 summary/`.

---

### P3 — Retry 504 dans callDirect

**Cas** : `datetime/ → HTTP 504`, `getwidgetconfigurations/ → HTTP 504`, `getagendas/ → HTTP 504` fréquents sous charge.
**Comportement actuel** : 504 retourne `null` → mois vide → créneaux manqués.
**Fix** : Dans `callDirect()`, si `res.status === 502 || 503 || 504` → retry 1-2× avec backoff 2s/4s avant de retourner null.

**Fichier** : `spain-bookitit-direct.ts` — fonction `callDirect`.

---

### P4 — Algorithme de distribution intelligente à 3 niveaux

**Problème** : Tous les dossiers tombent sur le même créneau (08:30 free=2), se font concurrence entre eux ET avec les humains.

**Pré-requis** : Le scan retourne un tableau multi-dates :
```
eligible[] = [
  { date: "2026-09-23", time: "08:30", free: 2, agendaId: "bkt391787" },
  { date: "2026-09-23", time: "09:00", free: 1, agendaId: "bkt391787" },
  { date: "2026-09-23", time: "09:30", free: 1, agendaId: "bkt391787" },
  ...
  { date: "2026-09-24", time: "08:30", free: 3, agendaId: "bkt391787" },
  { date: "2026-09-24", time: "09:00", free: 2, agendaId: "bkt391787" },
  ...
]
```

---

#### Niveau 1 — Dates avec au moins un créneau `free ≥ 2` (prioritaires)

```
Filtrer les dates qui ont AU MOINS un créneau avec free ≥ 2
→ Ces dates sont "sûres" (moins de risque "seleccionada")
→ Chaque dossier prend UNE date différente parmi celles-ci
→ Sur sa date, il commence par le créneau qui a free ≥ 2
→ Si un humain prend la place (seleccionada) → fallback heure éloignée sur la même date
```

**Exemple** : 3 dates avec free≥2, 6 dossiers
```
Date 23 sept (free≥2 sur 08:30)  → Dossier 0 + Dossier 3 (round-robin)
Date 24 sept (free≥2 sur 08:30, 09:00) → Dossier 1 + Dossier 4
Date 25 sept (free≥2 sur 10:00) → Dossier 2 + Dossier 5
```

---

#### Niveau 2 — Fallback : toutes les dates n'ont que des `free = 1`

```
Aucune date n'a de free ≥ 2
→ Distribuer les dossiers sur des dates DIFFÉRENTES (1 dossier par date max)
→ Sur sa date, chaque dossier commence par l'heure la plus éloignée (13:30, 12:50...)
→ Raison : un humain ouvre la page et clique 08:30 en premier
→ Redis empêche 2 de nos dossiers sur la même date/heure
```

**Exemple** : 5 dates (toutes free=1), 6 dossiers
```
Date 23 sept → Dossier 0 commence à 12:30
Date 24 sept → Dossier 1 commence à 13:00
Date 25 sept → Dossier 2 commence à 11:30
Date 28 sept → Dossier 3 commence à 12:00
Date 29 sept → Dossier 4 commence à 13:30
Date 23 sept → Dossier 5 commence à 11:30 (round-robin, 2ème heure)
```

---

#### Niveau 3 — Fallback ultime : une seule date avec que des `free = 1`

```
UNE seule date disponible (cas Kinshasa 18/08/2026 — 23 sept uniquement)
→ Tous les dossiers sur la même date (pas le choix)
→ MAIS chacun sur une heure DIFFÉRENTE
→ Distribution : dossier 0 → 12:30, dossier 1 → 12:00, dossier 2 → 11:30...
→ Heures éloignées en premier (les humains prennent les premières heures)
→ Redis empêche 2 dossiers sur la même heure
```

**Exemple** : 1 date (23 sept), 9 heures (toutes free=1), 10 dossiers
```
Dossier 0 → 12:30 (Redis claim OK)
Dossier 1 → 12:00 (Redis claim OK)
Dossier 2 → 11:30 (Redis claim OK)
Dossier 3 → 11:00 (Redis claim OK)
Dossier 4 → 10:30 (Redis claim OK)
Dossier 5 → 10:00 (Redis claim OK)
Dossier 6 → 09:30 (Redis claim OK)
Dossier 7 → 09:00 (Redis claim OK)
Dossier 8 → 08:30 (Redis claim OK) ← le créneau que les humains veulent
Dossier 9 → AUCUN restant (9 créneaux pour 10 dossiers)
```

---

#### Fallback cascade pendant le booking

Après la distribution initiale Redis, chaque dossier lance le booking.
Si le serveur répond "seleccionada por otra persona" (un humain a pris) :

```
Dossier 0 tentait 12:30 → "seleccionada" (un humain rapide)
  → Dossier 0 tente 12:00 (si pas claimé par un autre de nos dossiers)
    → Redis vérifie → si libre → claim + booking
    → si pris (dossier 1 est dessus) → tente 11:30
      → ... cascade jusqu'à trouver un créneau libre
```

**Le fallback est illimité** — le dossier descend dans tout le tableau trié jusqu'à :
- Succès (booking confirmé)
- Épuisement du tableau (tous les créneaux pris par nous OU par les humains)

---

#### Atomicité Redis — comment ça marche en parallèle

Redis est **single-threaded**. Même si 10 workers appellent `tryClaimSlot` au même instant :

```
T=0ms  Worker 0 → Redis: "claim 12:30 pour NKUNGU"  → clé vide → OK ✅
T=0ms  Worker 1 → Redis: "claim 12:30 pour RANIA"   → Redis file d'attente
T=1ms  Worker 1 → Redis traite: clé existe (NKUNGU) → REFUSÉ ❌
T=1ms  Worker 1 → code: tente 12:00 → Redis: "claim 12:00 pour RANIA" → OK ✅
```

Le claim prend ~1ms. Les 10 dossiers sont distribués en ~10-20ms.
Ensuite chaque worker a SON créneau et lance le booking en parallèle = 0 collision.

**La collision avec les humains** reste possible (Redis ne contrôle pas Bookitit) → c'est pour ça que le fallback cascade existe. Si le serveur dit "pris", le dossier descend au prochain créneau automatiquement.

---

#### Booking groupe (groupSize=2)

Un dossier avec `groupSize=2` = 2 personnes qui doivent aller au consulat ensemble (même date, heures proches).

**Principe** : le dossier groupe ne claim pas 1 créneau mais **2 créneaux adjacents** sur la même date.

```
Dossier "Famille NKUNGU" (groupSize=2, contient NKUNGU-A et NKUNGU-B) :

1. Chercher une date avec AU MOINS 2 créneaux libres adjacents
2. Redis claim atomique (Lua) : vérifier que les 2 sont libres → claimer les 2 d'un coup
   → tryClaimPair("2026-09-23", "12:30", "12:00", "familleNkungu") → OK ou REFUSÉ
3. Si OK :
   → NKUNGU-A booke 12:30 (selectedPeople=1)
   → NKUNGU-B booke 12:00 (selectedPeople=1)
4. Si REFUSÉ (un des deux est pris) → essayer la paire suivante (11:30 + 11:00)
```

**Priorité pour un groupe** :
```
1. Date avec créneau free≥2 → les 2 dossiers du groupe sur LE MÊME créneau
   (le serveur accepte 2 bookings sur un créneau avec 2 places)
2. Date avec 2 créneaux adjacents free=1 → chacun le sien (heures proches)
3. Fallback : 2 heures non-adjacentes sur la même date
4. Dernier fallback : 2 dates différentes (pas idéal mais mieux que rien)
```

**Redis Lua pour les groupes** :
```lua
-- tryClaimPair : claim atomique de 2 slots pour un groupe
local slot1_key = KEYS[1]  -- "spain:slot:2026-09-23:12:30:bkt391787"
local slot2_key = KEYS[2]  -- "spain:slot:2026-09-23:12:00:bkt391787"
local dossierId = ARGV[1]

-- Vérifier que les 2 sont libres
local s1 = redis.call("GET", slot1_key)
local s2 = redis.call("GET", slot2_key)
if s1 ~= false or s2 ~= false then
  return 0  -- au moins un est déjà pris → REFUSÉ
end

-- Claimer les 2 d'un coup (TTL 90s)
redis.call("SET", slot1_key, dossierId, "EX", 90)
redis.call("SET", slot2_key, dossierId, "EX", 90)
return 1  -- OK
```

---

#### Pourquoi c'est mieux qu'aujourd'hui

| Situation | Aujourd'hui | Avec l'algorithme |
|-----------|-------------|-------------------|
| 1 date, 9 créneaux, 10 dossiers | 10 dossiers sur 08:30 → 1 booking | 9 dossiers × 9 heures différentes → 9 bookings |
| 5 dates, 50 créneaux, 6 dossiers | 6 dossiers sur date1 08:30 → 1-2 bookings | 6 dossiers × 5 dates → 6 bookings |
| Humain prend notre créneau | Worker sort en signin_failed | Worker descend au créneau suivant → booking |

**Fichiers** :
- `spain-dossier-worker.ts` — nouvelle fonction `buildSlotAssignment(dossierId, eligible[], claimedByOthers)`
- `spain-slot-coordinator.ts` — Lua `tryClaimSlot` (existant, pas de changement)
- `spain-redis-persistence.ts` — `publishSlotSnapshot` (déjà fait)

---

### P5 — getsigninfields/ 0B sur HTTP 504 serveur

**Cas** : MUTENDI — `getsigninfields/ → 0B` car le serveur était surchargé (504 sous-jacent non détecté).
**Comportement actuel** : callDirect retourne `null` (HTTP non-ok) → code voit 0B → retry signin 3× mais gsf jamais retried.
**Fix** : Si `gsfPayload === null`, retry getsigninfields/ 1× après 2s avant de continuer vers signin/.

**Fichier** : `spain-dossier-worker.ts` — section `🔑 getsigninfields/`.

---

### P6 — Email admin + slotInfo montre TOUTES les dates/heures

**Cas** : L'email "Créneau Espagne Disponible" affiche `2026-09-23 à 08:30 (9 places)` — on dirait 9 places sur un seul créneau. En réalité c'est 9 créneaux différents (08:30, 09:00, 09:30... 12:30).
**Comportement actuel** : `slotInfo = eligible[0].date + eligible[0].time + eligible.length` → montre seulement le premier slot.
**Fix** :
- `slotInfo` doit lister toutes les dates uniques + plage horaire + total places
- Format : `"23 sept (08:30-12:30, 9 créneaux, 12 places)"` ou multi-dates : `"23 sept (9 crén.), 24 sept (6 crén.)"`
- Le `detectedSlots` (déjà format `{d, n, c}`) est envoyé à Convex — l'email doit l'utiliser pour le détail

**Fichier** : `spain-dossier-worker.ts` — construction de `slotInfo` dans `reportSpainWatcherScan`.
**Fichier email** : template email admin dans Convex ou le service d'envoi.

---

### P7 — Dossier avec credentials LUKUSA incorrects bloquait tout

**Cas** : LUKUSA a des credentials faux → `signin_failed: Usuario o contraseña incorrectos`.
**Statut** : ✅ **DÉJÀ CORRIGÉ** dans cette session — sortie immédiate sur erreur credentials permanente.

---

## Architecture cible

```
                         ┌─────────────────────────────────────┐
                         │         scanDatetimeDirect           │
                         │   (scan 3 mois → 200+ slots)        │
                         └─────────────┬───────────────────────┘
                                       │
                         ┌─────────────▼───────────────────────┐
                         │      publishSlotSnapshot(Redis)      │
                         │   (tous les slots avec freeslots)    │
                         └─────────────┬───────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
    ┌─────────▼─────────┐  ┌──────────▼──────────┐  ┌──────────▼──────────┐
    │  Worker NKUNGU     │  │  Worker RANIA       │  │  Worker YENGE       │
    │  tryClaimSlot(0)   │  │  tryClaimSlot(1)    │  │  tryClaimSlot(2)    │
    │  → slot 08:30 ✅   │  │  → slot 09:00 ✅    │  │  → slot 09:30 ✅    │
    └────────┬───────────┘  └────────┬────────────┘  └────────┬────────────┘
             │                       │                         │
    gsf → signin → summary  gsf → signin → summary   gsf → signin → summary
             │                       │                         │
    Si "seleccionada"        Si summary 504           Si OK
    → try slot 09:00         → retry 1×              → booked ✅
    → try slot 09:30         → si null → slot +1
```

## Ordre d'implémentation

1. **P1** (15 min) — retry slot sur "seleccionada" — impact immédiat sur le taux de booking
2. **P2** (15 min) — retry summary/ sur 504 — sauve les bookings presque confirmés (cas RANIA)
3. **P3** (20 min) — retry 504 dans callDirect — réduit les faux "0 créneau" sous charge
4. **P5** (10 min) — retry getsigninfields/ si null — cas MUTENDI
5. **P6** (20 min) — email admin avec tableau complet des dates/heures
6. **P4** (30 min) — pré-distribution Redis — élimine les collisions à la source

## Métriques de succès

- **Avant** : 1 booking sur 10 workers (10% taux de conversion)
- **Après P1+P2** : 3-4 bookings attendus (les 3 qui avaient un bktToken + retry)
- **Après P4** : 6+ bookings (chaque dossier sur un slot différent dès le départ)

## Fichiers impactés

| Fichier | Fixes |
|---------|-------|
| `spain-dossier-worker.ts` | P1, P2, P4, P5 |
| `spain-bookitit-direct.ts` | P3 |
| `spain-slot-coordinator.ts` / `spain-redis-persistence.ts` | P4 (Lua script) |


---

## P8 — Mode Sentinelle + Burst ("Meute")

**Nom** : Algorithme Meute
**Principe** : Une sentinelle repère. Elle claim + booke en premier. La meute se réveille et se disperse.

### Architecture

**IMPORTANT** : Chaque worker fait son propre scan complet (pas de skip). Le scan construit la session PHP nécessaire pour `getsigninfields/`. Redis sert uniquement de tableau de coordination — pas de raccourci technique.

```
┌─────────────────────────────────────────────────────────────────────┐
│  HH:05 → HH:25 (fenêtre publication)                                │
│                                                                      │
│  SENTINELLE (1 worker en avance, rotation par tour)                  │
│  • Scanne intensif toutes les 5-10s (refreshSessionAndScan)          │
│  • Si agenda=(vide) → dormir 5s → re-scan                           │
│  • Si créneaux détectés :                                            │
│    1. Publie snapshot Redis (tous les slots trouvés)                 │
│    2. Claim Redis slot #1 (le meilleur selon algo 3 niveaux)         │
│    3. Signal Redis PUB/SUB "BURST:kinshasa"                         │
│    4. Enchaîne IMMÉDIATEMENT getsigninfields/ → signin/ → summary/  │
│                                                                      │
│  MEUTE (9 workers en attente signal)                                 │
│  • SUB Redis "BURST:kinshasa" → réveil                              │
│  • Chaque worker lance SON PROPRE refreshSessionAndScan complet      │
│    (GET widget → POST token → /main/ → cfg → svc → agenda → dt/)    │
│  • Avec le résultat de SON scan :                                    │
│    - Lire Redis claims existants (sentinelle + workers plus rapides) │
│    - Comparer SON eligible[] avec les claims Redis                   │
│    - Claim atomique sur le meilleur slot NON DÉJÀ PRIS              │
│    - Booking (gsf → signin → summary)                                │
│                                                                      │
│  Le scan complet est OBLIGATOIRE — sans lui getsigninfields/ → 0B   │
│  Redis ne remplace PAS le scan — il coordonne les choix de slots     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Flux détaillé d'un worker (sentinelle ou meute)

```
1. refreshSessionAndScan() → résultat = SON propre eligible[]
   (GET widget → POST token → /main/ → cfg → svc → agenda → datetime/ 3 mois)
   → eligible[] = [{date, time, free, agendaId}, ...]

2. Lire Redis : quels slots sont déjà claimés par d'autres ?
   → claimedSlots = Redis GET "spain:claims:kinshasa:*"

3. Comparer : eligible[] - claimedSlots = availableForMe[]
   (filtrer les slots de SON scan qui ne sont pas déjà pris dans Redis)

4. Appliquer l'algorithme 3 niveaux sur availableForMe[] :
   - Niveau 1 : dates avec free≥2, heure éloignée
   - Niveau 2 : dates différentes, heure éloignée
   - Niveau 3 : même date, heures différentes

5. tryClaimSlot Redis (atomique Lua) sur le meilleur candidat
   → Si OK → booking
   → Si REFUSÉ (un autre worker a été plus rapide) → candidat suivant → retry étape 5

6. Booking : getsigninfields/ → signin/ → summary/
   → Si "seleccionada" → release claim → retry étape 5 avec candidat suivant
   → Si summary/ timeout → retry summary/ 1× puis candidat suivant
   → Si succès → BOOKÉ ✅
```

### Rotation sentinelle

La sentinelle change à chaque fenêtre HH:05 :
```
Heure 10:05 → Dossier NKUNGU est sentinelle
Heure 11:05 → Dossier RANIA est sentinelle
Heure 12:05 → Dossier YENGE est sentinelle
...
```
Round-robin par index = `Math.floor(hourOfDay) % dossiers.length`

### Avantage timing (sentinelle vs meute)

```
T=0.0s  Sentinelle scanne → 9 créneaux détectés
T=0.0s  Sentinelle publie snapshot + claim slot #1 + signal BURST
T=0.1s  Sentinelle lance getsigninfields/ (0 attente — session PHP déjà prête)
T=0.5s  Meute reçoit signal → lance refreshSessionAndScan (5-8s nécessaires)
T=1.5s  Sentinelle termine signin/ (bktToken obtenu)
T=3.0s  Sentinelle termine summary/ → BOOKÉ ✅
T=6.0s  Workers meute terminent refreshSessionAndScan → lisent Redis claims
T=6.0s  Workers voient slot #1 pris → claim slot #2, #3, ... (1ms chacun via Redis)
T=6.5s  Workers lancent 9× getsigninfields/ en parallèle
T=9.0s  Workers terminent 9× summary/ → 9 BOOKÉS ✅
```

**Gain sentinelle** : 3s d'avance (elle a déjà sa session PHP prête du scan).
**Les autres** : ~6s pour leur propre scan + 3s pour le booking = 9s total.
**Tous les bookings terminés en ~9 secondes.** Un humain n'a pas encore fini de lire la page.

### Hors fenêtre (HH:25 → HH:05)

```
• Tous les workers dorment (sleep)
• Aucun scan, aucune requête
• Keep-alive Decodo (HEAD httpbin toutes les 30s pour garder l'IP)
• À HH:05 → la sentinelle se réveille
```

### Fichiers

- `spain-worker-orchestrator.ts` — gestion sentinelle/meute, rotation, PUB/SUB
- `spain-dossier-worker.ts` — mode sentinelle (scan + burst) vs mode meute (attente + burst)
- `spain-redis-persistence.ts` — canaux PUB/SUB, snapshot publish
