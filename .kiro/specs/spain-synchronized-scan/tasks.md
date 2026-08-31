# Implementation Plan: spain-synchronized-scan

## Overview

Cette implémentation transforme l'essaim de workers Espagne (Bookitit) en un ensemble synchronisé sur une grille d'horloge murale absolue. L'approche est incrémentale et orientée code :

1. D'abord les **fonctions pures testables** (`WallClockGrid`, `classify`) accompagnées de leurs tests unitaires et property-based (fast-check) — c'est le socle vérifiable sans réseau.
2. Ensuite la **machine à états worker** (ARMED / SCANNING / RECOVERING) et son intégration au tri des échecs.
3. Puis le **pool de réserve** (`ReservePoolManager`) et le **contrôleur preflight** (`PreflightController`), réutilisant l'infra existante (`initWorkerSession`, `rotateDecodoUrl`, `flagDecodoIp`, `initPhpState`).
4. Enfin l'**intégration** dans la boucle de scan du worker (remplacer le sleep relatif) et dans l'orchestrateur, suivie des **tests d'intégration end-to-end** (harnais orchestrateur, workers mockés, `SPAIN_BYPASS_WINDOW`).

Cible : package `artifacts/slot-hunter` (TypeScript strict, Node+tsx, impit, Decodo/SOAX, CapSolver, Redis, Convex). Tests : `vitest` + `fast-check` (déjà installés). Toutes les fonctions exportées ont un type de retour explicite, aucun `any`, logs préfixés `[module]`, secrets en env, `try/catch` autour des appels réseau. On réutilise sans réécrire : `refreshSessionAndScan`, `initPhpState`, `publishSlotSnapshot`, `initWorkerSession`, `rotateDecodoUrl`/`flagDecodoIp`, `tryAcquireBookingSlot`/`MAX_CONCURRENT_BOOKERS`.

## Tasks

- [x] 1. Types partagés et chargement de configuration de grille
  - [x] 1.1 Créer le module de types et de config `src/spain/spain-grid-config.ts`
    - Définir les types exportés : `ScanPhase` (`"preflight" | "hunt" | "late"`), `GridConfig`, `WorkerState`, `FailureKind`, `WorkerRuntimeState`, `RecoveryContext` (interfaces telles que dans le design, `interface` pour objets, `type` pour unions).
    - Implémenter `loadGridConfig(env?: NodeJS.ProcessEnv): GridConfig` qui lit `SPAIN_HUNT_TICK_MS`, `SPAIN_LATE_TICK_MS`, `SPAIN_GRID_JITTER_PCT`, `SPAIN_WINDOW_START_MIN`, `SPAIN_HUNT_START_MIN`, `SPAIN_LATE_WINDOW_START_MIN`, `SPAIN_WINDOW_END_MIN` avec parsing entier/décimal, bornage `huntTickMs`/`lateTickMs` dans `[1000, 3600000]`, `jitterPct` borné à `[0, 0.5]`, minutes bornées à `[0, 59]`, et valeurs par défaut (10000, 60000, 0.2, 5, 13, 17, 25) avec `console.warn("[spain-grid] ...")` nommant la variable + défaut appliqué.
    - Valider l'ordre strict `windowStartMin < huntStartMin < lateStartMin < windowEndMin` ; si violé, conserver les 4 défauts (5,13,17,25) et `console.error("[spain-grid] ...")` indiquant la contrainte violée.
    - Implémenter `hashSeed(dossierId: string): number` déterministe (dérivé du `dossierId`, ex. via `createHash`), retour entier stable.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 2.4, 10.3_

  - [x] 1.2 Tests unitaires + property-based pour `loadGridConfig` et `hashSeed`
    - Table de cas env : valeurs valides, absentes, vides, non numériques, hors bornes → asserter défauts + warning ; ordre invalide → défauts + error.
    - **Property 6 (fast-check) : Plancher de tick** — `∀ config valide, huntTickMs >= 2700`. **Validates: Requirements 10.3, 11.1**
    - Property (fast-check) : déterminisme de `hashSeed` — même `dossierId` ⟹ même seed au bit près. **Validates: Requirements 2.4**
    - _Requirements: 11.1, 11.2, 11.5, 11.8, 11.9, 2.4, 10.3_

- [x] 2. WallClockGrid — fonctions pures de grille
  - [x] 2.1 Implémenter `createGridResolver` dans `src/spain/spain-wallclock-grid.ts`
    - Exporter `createGridResolver(config: GridConfig): GridResolver` retournant `currentPhase`, `effectiveTickMs`, `msUntilNextTick` (types de retour explicites).
    - `currentPhase(nowMs)`: dériver la minute-dans-l'heure en fuseau `Europe/Madrid`, retourner `preflight`/`hunt`/`late` selon les fenêtres, `preflight` par défaut hors `[windowStartMin, windowEndMin[` et sur config fenêtre invalide.
    - `effectiveTickMs(phase, slotEverSeen)`: `late && !slotEverSeen ⟹ lateTickMs`, sinon `huntTickMs` ; jamais `< huntTickMs`.
    - `msUntilNextTick(nowMs, tick, workerSeed)`: front de base `Math.ceil(nowMs/tick)*tick`, jitter déterministe `jitterMax = floor(jitterPct*tick)`, `jitter = (workerSeed mod (2*jitterMax+1)) - jitterMax`, viser le front suivant si `target <= nowMs`, retour entier ms dans `[0, tick + jitterMax)`. Rejeter (indication d'erreur, valeur précédente inchangée) si `nowMs` non numérique, `tick <= 0`/non entier, ou `jitterPct` hors `[0,0.5]`.
    - Borner le tick effectif utilisé pour le calcul à `[1000, 3600000]`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 2.1, 2.2, 2.3, 2.5, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.6, 12.4, 12.6_

  - [x] 2.2 Property test — alignement de grille et jitter borné
    - **Property 1 : Alignement de grille** — `∀ w1,w2` même `tick`/`nowMs`, `nextFront` identique au bit près (avant jitter). **Validates: Requirements 1.2**
    - **Property 2 : Jitter borné** — `∀ workerSeed, |jitter| <= jitterPct*tick` et `msUntilNextTick ∈ [0, tick + jitterMax)`. **Validates: Requirements 2.1, 2.3**
    - Property : déterminisme du jitter — même `(workerSeed, tick, index)` ⟹ même valeur. **Validates: Requirements 2.2**
    - Générer `nowMs` aléatoires, `tick ∈ [2700, 60000]`, `workerSeed` aléatoires (fast-check).
    - _Requirements: 1.2, 2.1, 2.2, 2.3_

  - [x] 2.3 Property test — phases et ralentissement tardif conditionnel
    - **Property 4 : Ralentissement tardif conditionnel** — `∀ t ∈ [lateStartMin, windowEndMin[ : slotEverSeen === true ⟹ effectiveTickMs === huntTickMs`. **Validates: Requirements 8.3, 8.6**
    - Tests unitaires de `currentPhase` aux bornes de fenêtre (preflight/hunt/late + hors fenêtre → preflight), avec mock du fuseau `Europe/Madrid`.
    - Vérifier `effectiveTickMs` : `late && !slotEverSeen ⟹ lateTickMs`, tous autres cas ⟹ `huntTickMs`, jamais `< huntTickMs`.
    - _Requirements: 7.1, 7.4, 8.1, 8.2, 8.3, 8.6, 12.4_

  - [x] 2.4 Tests unitaires — cas d'erreur et invariance sur entrées invalides
    - Front cible `<= nowMs` ⟹ front suivant (Req 1.4) ; lecture horloge non numérique ⟹ rejet + indication d'erreur, aucun réveil planifié (Req 1.7) ; `tick`/`jitterPct` invalides ⟹ rejet + valeur précédente conservée (Req 2.5).
    - _Requirements: 1.4, 1.7, 2.5_

- [x] 3. Classifier — tri strict des échecs
  - [x] 3.1 Implémenter `classify` dans `src/spain/spain-worker-state-machine.ts`
    - Exporter `classify(scan: WorkerScanResult): FailureKind` : `proxy_error → proxy_dead`, `cf_expired → cf_expired`, `session_dead → session_dead`, `not_found → agenda_empty`, `error` avec code HTTP 500–599 → `http_5xx` sinon `proxy_dead`, statut inconnu/nul/absent/vide → `proxy_dead` + `console.warn("[spain-classify] ...")` nommant le statut reçu.
    - Implémenter le helper interne `isHttp5xx(errorMessage?: string): boolean` (extraction 500–599). Retour en < 100 ms (pur, synchrone).
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9_

  - [x] 3.2 Property + unit tests pour `classify`
    - **Property 7 : Classification totale** — `∀ scan : classify(scan) ∈ FailureKind` (jamais `undefined`), un seul kind par scan (fast-check sur statuts + codes arbitraires). **Validates: Requirements 4.1**
    - Table de cas exhaustive `status → FailureKind` couvrant tous les statuts + `error` 5xx/non-5xx + statut inconnu → `proxy_dead` + warning. **Validates: Requirements 4.2–4.7, 4.9**
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9_

- [x] 4. Checkpoint — socle pur vérifié
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. WorkerStateMachine — transitions d'état
  - [x] 5.1 Implémenter `transition` et helpers d'état dans `src/spain/spain-worker-state-machine.ts`
    - Exporter `transition(rt: WorkerRuntimeState, event: FailureKind | "scan_ok" | "recovered"): WorkerState` (ne lance jamais) : `agenda_empty`/`scan_ok` ⟹ `ARMED` (sans incrément compteur d'erreur pour `agenda_empty`), `{proxy_dead, http_5xx, session_dead, cf_expired}` ⟹ `RECOVERING`, `recovered` ⟹ `ARMED`. Garantir `state ∈ {ARMED, SCANNING, RECOVERING}`, jamais nul/indéfini.
    - Exporter un helper d'initialisation `createRuntimeState(...)` produisant un `WorkerRuntimeState` valide (état `ARMED`, `gridSeed = hashSeed(dossierId)`, `slotEverSeen: false`).
    - _Requirements: 3.1, 3.2, 3.3, 4.8_

  - [x] 5.2 Tests unitaires — matrice état × événement
    - Vérifier chaque transition, l'invariant `state` toujours valide, `agenda_empty` maintient `ARMED` sans incrément d'erreur (Req 4.8), causes de l'ensemble fermé ⟹ `RECOVERING`.
    - _Requirements: 3.1, 3.2, 3.3, 4.8_

- [x] 6. ReservePoolManager — pool de sessions de réserve
  - [x] 6.1 Implémenter `createReservePool` dans `src/spain/spain-reserve-pool.ts`
    - Exporter `createReservePool(opts: { targetSize: number }): ReservePoolManager` avec `targetSize` (lu via `SPAIN_RESERVE_POOL_SIZE`, borné `[1, 100]`, défaut 4), `warmUp`, `borrow`, `replenishAsync`, `size`.
    - `warmUp(capsolverKey, portalUrl)`: pré-solver jusqu'à `targetSize` sessions via `initWorkerSession` (réutilisé), chacune sur une IP Decodo distincte via `rotateDecodoUrl` (réutilisé), jamais une IP blacklistée ni partagée.
    - `borrow(nowMs)`: retourner une `ReserveSession` avec `cf_clearance` non expiré (retire du pool), sinon `null`.
    - `replenishAsync(capsolverKey, portalUrl)`: reconstitution en tâche de fond (fire-and-forget) sur une nouvelle IP distincte, retry jusqu'à 3 tentatives, backoff exponentiel base 2000 ms ×2, sur échec `console.warn` sans interrompre les réserves existantes ; ne bloque jamais le chemin du swap.
    - `size()`: compte des réserves avec `cf_clearance` non expiré, dans `[0, targetSize]`.
    - Blacklist IP via `flagDecodoIp` (réutilisé) et exclusion des IP mortes de toute sélection.
    - Tous les appels réseau enveloppés dans `try/catch` avec message contextuel préfixé `[spain-reserve-pool]`. `cf_clearance` jamais loggé en clair (tronqué).
    - _Requirements: 5.1, 5.3, 5.5, 5.6, 5.7, 11.7, 13.5_

  - [x] 6.2 Tests unitaires — pool avec solver/pool mockés
    - Mock `initWorkerSession`/`rotateDecodoUrl`/`flagDecodoIp` : `warmUp` atteint `targetSize` sur IP distinctes ; `borrow` ignore les réserves `cf_clearance` expiré et retourne `null` si vide ; `size` compte correctement ; `replenishAsync` retry 3× avec backoff puis warn ; IP mortes exclues.
    - _Requirements: 5.1, 5.3, 5.5, 5.6, 5.7, 11.7_

- [x] 7. Récupération asynchrone non bloquante
  - [x] 7.1 Implémenter `enterRecoveryAsync` dans `src/spain/spain-worker-recovery.ts`
    - Exporter `enterRecoveryAsync(rt: WorkerRuntimeState, kind: FailureKind, deps: RecoveryDeps): void` (fire-and-forget, retourne immédiatement, ne lance jamais).
    - `cf_expired` ⟹ `initWorkerSession` re-solve CF même IP (garde exit IP) ; `session_dead` ⟹ `initPhpState` nouveau PHPSESSID (garde IP+CF) ; `http_5xx` ⟹ short retry (2–3 tentatives backoff ~2 s ×2) même IP, escalade `proxy_dead` si persiste ; `proxy_dead` ⟹ `reservePool.borrow` d'abord (swap ~0 s, `flagDecodoIp` sur l'IP morte, `replenishAsync`), sinon `rotateDecodoUrl` + `initWorkerSession` (re-solve obligatoire au changement d'IP).
    - Sur succès `rt.state ← ARMED` ; backoff 5000 ms entre tentatives, max 10 tentatives, `console.error("[spain-recovery] ...")` à chaque échec ; épuisement des 10 tentatives ⟹ reste `RECOVERING` terminal + log d'abandon identifiant worker + cause. Pool épuisé (borrow null + rotation échouée) ⟹ reste `RECOVERING` non terminal, retentera au tick.
    - Rejeter tout `cf_clearance` obtenu sur une exit IP différente de l'IP courante et déclencher un re-solve sur l'IP courante avant émission.
    - _Requirements: 3.2, 3.4, 3.5, 3.6, 3.7, 5.2, 5.4, 10.4, 10.5, 10.6, 10.7, 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x] 7.2 Property + unit tests pour la récupération
    - **Property 8 : Swap réserve prioritaire sur re-solve** — `∀ recovery proxy_dead : size()>0 au swap ⟹ aucun initWorkerSession synchrone bloquant dans le chemin du swap`. **Validates: Requirements 5.2**
    - Unit : transition `SCANNING → RECOVERING` en < 100 ms (Req 3.2) ; `session_dead` garde IP+CF (Req 10.6) ; `cf_expired` garde PHPSESSID (Req 10.7) ; backoff/retry max 10 puis terminal (Req 3.6, 3.7) ; pool épuisé reste RECOVERING non terminal (Req 14.1, 14.4).
    - _Requirements: 3.2, 3.6, 3.7, 5.2, 10.6, 10.7, 14.1, 14.4_

- [x] 8. PreflightController — armement et vérification anticipée
  - [x] 8.1 Implémenter `createPreflightController` dans `src/spain/spain-preflight-controller.ts`
    - Exporter `createPreflightController(deps: PreflightDeps): PreflightController` avec `isPreflightWindow(nowMs)`, `armAll(dossiers)`, `verifyAndRepair(nowMs)`.
    - `isPreflightWindow`: `true` si minute-dans-l'heure ∈ `[windowStartMin, huntStartMin[` (fuseau `Europe/Madrid`).
    - `armAll`: armer exactement une session par dossier non armé via `initWorkerSession` (réutilisé), max 30 s/dossier, chaque échec consigné sans interrompre les autres dossiers.
    - `verifyAndRepair`: probe `cf_clearance` de chaque session armée, résultat enregistré au plus tard 60 s avant `huntStartMin` ; session invalide ⟹ swap réserve (< 5 s) + `replenishAsync` en fond ; réserve indisponible ⟹ re-solve immédiat + indication d'échec de swap identifiant le dossier ; session non valide à `huntStartMin` ⟹ marquer dossier non prêt + log d'échec preflight identifiant le dossier, sans interrompre les autres.
    - `try/catch` réseau, logs `[spain-preflight]`, secrets manquants ⟹ interrompre l'init de la session concernée + indication d'erreur nommant la variable (sans valeur).
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 13.3, 13.4_

  - [x] 8.2 Tests unitaires — preflight avec deps mockées
    - `isPreflightWindow` aux bornes ; `armAll` arme 1 session/dossier, isole les échecs ; `verifyAndRepair` swap sur invalidité, re-solve si réserve vide, marque non prêt à `huntStartMin`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 9. Checkpoint — composants unitaires vérifiés
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Intégration dans la boucle de scan du worker
  - [x] 10.1 Remplacer le sleep relatif par la grille dans `src/spain-dossier-worker.ts`
    - Instancier `createGridResolver(loadGridConfig())` et `createRuntimeState(...)` en tête de la boucle `while (Date.now() < windowEnd)`.
    - Boucle : `phase = currentPhase(now)`, `tick = effectiveTickMs(phase, rt.slotEverSeen)` ; si `RECOVERING`, dormir jusqu'au prochain front sans scanner (`continue`) ; sinon `SCANNING` → `refreshSessionAndScan` (réutilisé) → `classify`. `agenda_empty` ⟹ `ARMED` ; échec de l'ensemble fermé ⟹ `enterRecoveryAsync` (non bloquant) + `RECOVERING`.
    - Remplacer le sleep final par `msUntilNextTick(now, tick, rt.gridSeed)`, plafonner pour que le réveil soit `<= windowEnd` ; ne planifier aucun scan si `Date.now() >= windowEnd` (aucun appel réseau).
    - Exposer un état de réveil observable (worker id + front atteint) et `rt.lastScanAtMs`.
    - _Requirements: 1.3, 1.5, 1.6, 3.3, 8.4, 8.5, 10.1, 10.2, 12.1, 12.2, 12.3, 13.1, 13.2_

  - [x] 10.2 Câbler le mode RACE (détection découplée du booking)
    - Sur `status === "found"` avec capacité libre ≥ 1 : positionner `rt.slotEverSeen = true` (≤ 500 ms), appeler `publishSlotSnapshot` (réutilisé) avec agendaId, serviceId, slots, capacité libre par créneau + horodatage (≤ 500 ms, retry 3× backoff 2000 ms, échec signalé sans perdre `slotEverSeen`).
    - Implémenter `attemptBookingRace(rt, scan)` : consommer un snapshot daté < 60 s (ignorer/signaler expiré si ≥ 60 s) ; si somme des capacités libres ≥ seuil (`SPAIN_RACE_BYPASS_THRESHOLD`, `[1,10000]`, défaut 5) contourner `tryAcquireBookingSlot`/`MAX_CONCURRENT_BOOKERS` (réutilisés), sinon respecter le sémaphore.
    - Garantir la monotonie de `slotEverSeen` (jamais `true → false`).
    - _Requirements: 8.4, 8.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 10.3 Property + unit tests pour la boucle worker et le mode RACE
    - **Property 5 : Monotonie de slotEverSeen** — `∀ transitions : slotEverSeen ne passe jamais true → false`. **Validates: Requirements 8.5, 9.1**
    - **Property 9 : Borne de fenêtre** — `∀ itération : aucun scan si Date.now() >= windowEnd`. **Validates: Requirements 12.1, 12.3**
    - Unit : snapshot < 60 s ⟹ booking, ≥ 60 s ⟹ ignoré/expiré (Req 9.3, 9.4) ; somme capacités ≥ seuil ⟹ bypass sémaphore (Req 9.5) ; retry publication 3× (Req 9.6).
    - _Requirements: 8.5, 9.1, 9.3, 9.4, 9.5, 9.6, 12.1, 12.3_

- [x] 11. Intégration dans l'orchestrateur
  - [x] 11.1 Câbler preflight + pool de réserve dans `src/spain-worker-orchestrator.ts`
    - Instancier `createReservePool` et `createPreflightController` ; en fenêtre preflight : `armAll(dossiers)` → `reservePool.warmUp(...)` → `verifyAndRepair(...)`.
    - Superviser la récupération : exclure les workers `RECOVERING` du calcul de cadence commune (dérive ≤ 50 ms pour les autres) ; s'abstenir de tout scan hors `[windowStartMin, windowEndMin[` ou sur config fenêtre invalide.
    - Étendre la `Map<string, RunningWorker>` existante avec `WorkerRuntimeState` (state + phase), sans casser l'API existante.
    - Logs `[spain-orchestrator]`, `try/catch` réseau, secrets en env uniquement.
    - _Requirements: 3.4, 6.1, 12.5, 12.6, 13.3_

  - [x] 11.2 Test d'intégration — recovery non bloquant
    - **Property 3 : Non-blocage de la récupération** — mocker un `proxy_dead` (recovery ~30 s) sur `w_i`, asserter que `w_j` scanne bien à son tick (cadence indépendante, dérive ≤ 50 ms). **Validates: Requirements 3.4**
    - _Requirements: 3.4_

- [x] 12. Tests d'intégration end-to-end (harnais orchestrateur)
  - [x] 12.1 Harnais orchestrateur avec workers mockés + `SPAIN_BYPASS_WINDOW`
    - Mock `refreshSessionAndScan` : injecter une publication à l'instant T ; asserter que ≥ 2/3 workers détectent dans la même fenêtre de tick (Property 1 end-to-end).
    - Mode `SPAIN_BYPASS_WINDOW=1` pour tester hors fenêtre horaire réelle ; vérifier phases preflight/hunt/late et le ralentissement tardif conditionnel bout-en-bout.
    - _Requirements: 1.2, 6.1, 7.1, 8.2, 8.3_

- [x] 13. Validation finale
  - [x] 13.1 Vérifier la compilation TypeScript stricte sur les fichiers touchés
    - Exécuter `npx tsc --noEmit` dans `artifacts/slot-hunter` : 0 erreur obligatoire. Corriger tout `any` résiduel, imports manquants, types de retour implicites.
    - Exécuter `vitest run` sur les tests créés (unitaires + PBT non optionnels) et confirmer qu'ils passent.
    - _Requirements: (transverse — normes de codage TS strict)_

## Notes

- Les tâches marquées `*` sont optionnelles (tests unitaires, property-based, intégration lourde) et peuvent être différées pour un MVP plus rapide ; les tâches du chemin critique (implémentations + validation TS finale) ne sont jamais optionnelles.
- Chaque tâche référence des sous-exigences granulaires (format `Requirements X.Y`) pour la traçabilité.
- Les 9 correctness properties du design sont couvertes : P1 (2.2, 12.1), P2 (2.2), P3 (11.2), P4 (2.3), P5 (10.3), P6 (1.2), P7 (3.2), P8 (7.2), P9 (10.3).
- Réutilisation stricte de l'existant : `refreshSessionAndScan`, `initPhpState`, `publishSlotSnapshot`, `initWorkerSession`, `rotateDecodoUrl`/`flagDecodoIp`, `tryAcquireBookingSlot`/`MAX_CONCURRENT_BOOKERS`. Les nouveaux composants vivent dans `src/spain/`.
- Les checkpoints (tâches 4, 9) valident le socle incrémental avant d'intégrer.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "5.1", "6.1"] },
    { "id": 3, "tasks": ["5.2", "6.2", "7.1", "8.1"] },
    { "id": 4, "tasks": ["7.2", "8.2", "10.1"] },
    { "id": 5, "tasks": ["10.2", "11.1"] },
    { "id": 6, "tasks": ["10.3", "11.2"] },
    { "id": 7, "tasks": ["12.1"] },
    { "id": 8, "tasks": ["13.1"] }
  ]
}
```
