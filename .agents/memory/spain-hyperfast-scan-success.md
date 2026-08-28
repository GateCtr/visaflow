# Spain — Scan hyper-rapide (HH:12) + booking RACE réussi

## Contexte

Optimisation du worker Spain (`spain-dossier-worker.ts`) pour réduire le délai de
détection et gagner les créneaux face aux concurrents sur le portail Kinshasa
(citaconsular.es, publickey `25028fcd7126544630b8da0c6e60722b5`).

## Changements appliqués (commit `08e9cab`)

### 1. Scan adaptatif hyper-rapide à HH:12

Nouvelle phase dans `getAdaptiveScanInterval()` :

| Phase       | Fenêtre (UTC)   | Intervalle | Raison                          |
|-------------|-----------------|------------|---------------------------------|
| Warm-up     | HH:05 → HH:10   | 60s        | init PHP, CF cache chaud        |
| Normal      | HH:10 → HH:12   | 10s        | attente publication             |
| **Hyperfast** | **HH:12+**    | **1s**     | pic de publication, scan max    |
| Fast        | après détection | 2.5s       | attente sémaphore booking       |

Constantes : `SCAN_HYPERFAST_INTERVAL_MS = 1_000`, `HYPERFAST_START_MINUTE = 12`.

Le calcul est start-to-start (`wait = adaptiveInterval - elapsed`). Comme un cycle
complet (`refreshSessionAndScan`) prend ~2.6-3.8s avec cache CF chaud, l'intervalle
1s donne `wait = max(0, 1000 - 2600) = 0` → **cycles enchaînés sans pause**.

Résultat : à HH:12, un scan toutes les ~3s au lieu de ~13s (10s pause + 3s cycle).
Gain de détection ~4x sur la fenêtre critique.

### 2. Clarification du log `signin/ → 0B`

Le commentaire disait "serveur surchargé". En réalité, quand `getsigninfields/`
réussit mais `signin/` retourne 0B juste après, ça signifie le plus souvent que
le créneau a été capturé par un concurrent (mode RACE, slot freeSlots=1).
Log passé de `signin/ 0B (surcharge)` à `signin/ 0B (slot déjà pris ou surcharge)`.

Note : le serveur peut aussi répondre explicitement
`La hora elegida ha sido seleccionada por otra persona` → géré par `🏁 Race perdue`.

## Preuve de succès (prod, 2026-08-28 18:13 UTC)

Créneau `2026-09-28 10:45` (freeSlots=1) sur Kinshasa. 4 workers en RACE.

**Timeline mesurée :**
- `18:13:08.120` — slot DÉTECTÉ dans datetime/ (mois 2026-09) par GRACE
- `18:13:09.559` — décision booking (+1.4s)
- `18:13:10.482` — getsigninfields/ → 13739B ✅ (+0.9s)
- `18:13:11.550` — signin/ OK → summary/ (bktToken)
- `18:13:13.709` — ✅ Booking confirmé (state=1) (+2.2s)

**Délai détection → booking confirmé : ~5.6 secondes.**

GRACE a gagné la RACE. Les 3 autres workers (JEAN MARIE, KAKA, Mr Nkumu) ont perdu
avec `La hora elegida ha sido seleccionada por otra persona` → fallback propre.

## Note Kinshasa

- Booking confirmé sans locator (`locator: state1-2026-09-28`) — comportement normal Kinshasa.
- getservices/ peut retourner 0B (2B) ponctuellement → scan=error → le worker rebondit au cycle suivant (résilience OK).
- Mode RACE activé automatiquement quand ≤ 5 créneaux (pas de lock Redis, tous foncent).
