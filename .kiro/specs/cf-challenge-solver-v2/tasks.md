# Plan d'implémentation : cf-challenge-solver-v2

## Vue d'ensemble

Réécriture in-place de `artifacts/slot-hunter/src/cf-challenge-solver.ts` pour y intégrer
cinq composants améliorés : SessionCache TTL, ChallengeDetector révisé, StealthManager
enrichi (SeleniumBase UC Mode), TurnstileClickSolver avec trajectoire Bézier, et
CfSolverOrchestrator avec retry + rotation IP Decodo.

Le fichier reste un **module TypeScript unique** pour préserver la compatibilité des imports.
Les tests property-based nécessitent l'installation préalable de vitest et fast-check.

---

## Tâches

- [x] 1. Configurer l'environnement de test (vitest + fast-check)
  - Ajouter `vitest` et `fast-check` dans `devDependencies` de `artifacts/slot-hunter/package.json`
  - Ajouter un script `"test": "vitest run"` dans `package.json`
  - Étendre `tsconfig.json` pour inclure `src/__tests__/**/*` dans `include`
  - Créer le répertoire `artifacts/slot-hunter/src/__tests__/` s'il n'existe pas
  - _Requirements: 9.1_

- [x] 2. Types et interfaces v2
  - [x] 2.1 Ajouter les nouvelles interfaces au début de `cf-challenge-solver.ts`
    - Ajouter `CfSession { cfClearance, cookies, obtainedAt, expiresAt }`
    - Ajouter `CachedSessionResult { session, isValid, nearExpiry, ttlRemainingMs }`
    - Ajouter `CacheMetrics { totalSolves, cacheHits, cacheMisses, averageSolveDurationMs }`
    - Ajouter `CfPageSignals` (interface interne pour le retour de `page.evaluate`)
    - Ajouter `geoTimezone?: string` dans `CfSolveOptions`
    - Conserver tous les types v1 existants sans modification de leurs champs obligatoires
    - _Requirements: 7.1, 7.2, 9.2_

- [x] 3. SessionCache singleton
  - [x] 3.1 Implémenter le SessionCache en mémoire avec TTL
    - Déclarer `const _sessionCache = new Map<string, CfSession>()` au niveau module
    - Implémenter `getCachedSession(domain)` : retourne `null` si expiré ou absent, `{ isValid, nearExpiry, ttlRemainingMs }` sinon
    - Seuil `nearExpiry` : `expiresAt - Date.now() < 5 * 60 * 1000`
    - Purger l'entrée expirée dans `getCachedSession` (lazy eviction)
    - Implémenter `setCachedSession(domain, session)`, `invalidateSession(domain)`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 3.2 Implémenter les métriques et la persistence disque optionnelle
    - Déclarer `_metrics: CacheMetrics` + accumulateur `_totalSolveDurationMs`
    - Implémenter `getCacheMetrics()` retournant une copie défensive
    - Implémenter `_recordSolve(durationMs)`, `_recordCacheHit()`, `_recordCacheMiss()`
    - Implémenter `_persistCacheToDisk()` : `fs.writeFileSync` si `CF_SESSION_CACHE_FILE` défini, no-op sinon
    - Implémenter `_loadCacheFromDisk()` : chargé une seule fois au démarrage, filtre entrées expirées, erreurs I/O → `console.warn` uniquement
    - Appeler `_loadCacheFromDisk()` dans le corps du module (top-level)
    - _Requirements: 5.7, 5.8, 8.5_

  - [x] 3.3 Tests unitaires et property tests du SessionCache
    - **Property 4 : Invariants TTL** — pour tout `expiresAt` aléatoire : `isValid`, `null` si expiré, `nearExpiry` correct
    - **Validates : Requirements 5.2, 5.3, 5.4**
    - **Property 10 : Exactitude des métriques** — pour N appels dont M cache hits, vérifier `totalSolves`, `cacheHits`, `cacheMisses`, `averageSolveDurationMs`
    - **Validates : Requirements 5.7, 8.5**
    - Test unitaire : `invalidateSession` supprime immédiatement l'entrée
    - Test unitaire : disk cache — `CF_SESSION_CACHE_FILE` défini → persisté et rechargé
    - _Requirements: 5.1–5.8_

- [x] 4. ChallengeDetector réécrit
  - [x] 4.1 Réécrire `detectChallengeType` avec ordre de priorité strict et `CfPageSignals`
    - Un seul appel `page.evaluate()` retournant un objet `CfPageSignals` typé `unknown` validé par type guard
    - Ordre de priorité strict : `blocked` → `none` → `iuam` → `turnstile` → `managed` → `jsd` → `unknown`
    - `blocked` : titre contient "Access Denied" / "Error 1015" / "Error 1020" (priorité absolue, même si `_cf_chl_opt` présent)
    - `none` : `cf_clearance` présent ET aucun signal CF actif ET `hasContent`
    - `iuam` : `#cf-please-wait` présent OU titre "Under Attack"/"ddos" ET pas d'iframe Turnstile ET pas `_cf_chl_opt.cType === "managed"`
    - `turnstile` : iframe `src` contient `challenges.cloudflare.com` OU `_cf_chl_opt.cType === "interactive"`
    - `managed` : `_cf_chl_opt.cType === "managed"`
    - `jsd` : `_cf_chl_opt.cType === "non-interactive"` ou `"jsd"` OU titre "Just a moment"/"Checking" OU `.cf-challenge-running`
    - `unknown` : aucun signal, pas de contenu substantiel
    - _Requirements: 1.1–1.9, 9.2_

  - [x] 4.2 Tests unitaires et property tests de la détection
    - **Property 1 : Soundness** — aucun signal CF → `"none"` pour tout titre/bodyLength arbitraires
    - **Validates : Requirements 1.1, 1.9**
    - **Property 2 : Completeness cType** — mapping `{ managed, interactive, non-interactive, jsd }` → type CF correct
    - **Validates : Requirements 1.2, 1.3, 1.8**
    - **Property 3 : Priorité blocked** — `"blocked"` même si `_cf_chl_opt` + titre "Just a moment" co-présents
    - **Validates : Requirements 1.5**
    - Test unitaire : `"iuam"` quand `#cf-please-wait` sans iframe Turnstile
    - Test unitaire : `"none"` quand `cf_clearance` présent et aucun signal actif
    - _Requirements: 1.1–1.9_

- [x] 5. StealthManager enrichi (patches v2)
  - [x] 5.1 Ajouter les nouveaux patches dans `preparePageStealth`
    - Patcher `navigator.webdriver` via `Object.defineProperty` avec getter retournant `undefined` (Proxy-trap pattern)
    - Générer un `sessionSalt = Math.floor(Math.random() * 1000)` dans `evaluateOnNewDocument`
    - Patcher `AudioBuffer.prototype.getChannelData` et `AnalyserNode.prototype.getFloatFrequencyData` avec bruit déterministe basé sur `sessionSalt`
    - Patcher `HTMLCanvasElement.prototype.toDataURL` : modifier 1 pixel via `sessionSalt` avant retour
    - Exposer `navigator.getBattery` → `Promise<{ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 }>`
    - Définir `navigator.connection` → `{ effectiveType: "4g", downlink: 10, rtt: 50, saveData: false }`
    - Conserver tous les patches v1 (webdriver, plugins, mimeTypes, WebGL, window.chrome, permissions, Client Hints CDP, TURNSTILE_INTERCEPT_SCRIPT, dialog handler)
    - _Requirements: 2.1–2.7_

  - [x] 5.2 Ajouter le support timezone via `geoTimezone`
    - Accepter `geoTimezone?: string` dans la signature `preparePageStealth(page, ua?, geoTimezone?)`
    - Si `geoTimezone` fourni : patcher `Intl.DateTimeFormat` et `Date.prototype.getTimezoneOffset` dans `evaluateOnNewDocument`
    - Rendre `preparePageStealth` idempotent : si appelé deux fois, aucune exception, patches cohérents
    - _Requirements: 2.6, 2.8_

  - [x] 5.3 Ajouter `page.bringToFront()` dans `solveCfChallenge`
    - Appeler `page.bringToFront()` au début de `solveCfChallenge`, avant `detectChallengeType`
    - Ne pas l'appeler dans `preparePageStealth` (qui peut être appelé à n'importe quel moment)
    - _Requirements: 2.9_

  - [x] 5.4 Tests unitaires du StealthManager
    - **Property 7 : Idempotence de preparePageStealth** — appeler deux fois ne lève pas d'exception et les scripts `evaluateOnNewDocument` sont les mêmes
    - **Validates : Requirements 2.8**
    - Test unitaire : `navigator.getBattery` mock — retourne `{ charging: true, level: 1.0 }`
    - Test unitaire : `navigator.connection.effectiveType` → `"4g"`
    - _Requirements: 2.1–2.9_

- [x] 6. Trajectoire Bézier et TurnstileClickSolver mis à jour
  - [x] 6.1 Implémenter `cubicBezier` et `generateBezierTrajectory`
    - Implémenter `cubicBezier(p0, p1, p2, p3, t)` selon la formule `B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3`
    - Implémenter `generateBezierTrajectory(targetX, targetY)` :
      - P0 : `(400 ± 200, 300 ± 200)` ; P1 : `P0 + (±300, ±200)` ; P2 : `target + (±100, ±100)` ; P3 : `target`
      - N points : `floor(20 + random() * 20)` (entre 20 et 40)
      - Délai par point : `2 + (1 - sin(t * π)) * 16` ms (2 ms au milieu, 18 ms aux extrémités)
    - _Requirements: 3.1, 3.2_

  - [x] 6.2 Mettre à jour `humanLikeCdpClick` avec la trajectoire Bézier
    - Remplacer la trajectoire ease-out cubic v1 par `generateBezierTrajectory`
    - Dispatcher chaque point via `Input.dispatchMouseEvent` type `mouseMoved` avec le délai calculé
    - Délai pré-clic : `80 + random() * 170` ms (80–250 ms)
    - Délai clic maintenu : `40 + random() * 110` ms (40–150 ms)
    - Jitter `mouseReleased` : `±3 px` sur X et Y (resserré de ±1px vs v1)
    - _Requirements: 3.2, 3.4, 3.5, 3.6_

  - [x] 6.3 Ajouter scroll pré-clic et délai post-navigation dans `solveTurnstileByClick`
    - Ajouter délai post-navigation variable : `1500 + random() * 2000` ms avant détection de l'iframe
    - Avant le clic : vérifier si l'iframe est visible dans le viewport (`getBoundingClientRect`)
    - Si hors-écran : appeler `window.scrollBy` pour l'amener dans le viewport
    - _Requirements: 3.3, 3.7_

  - [x] 6.4 Tests unitaires et property tests du mouvement Bézier
    - **Property 9 : Continuité de la trajectoire Bézier** — premier point dans rayon 500 px autour de (400, 300), dernier point à < 5 px de la cible, N entre 20 et 40
    - **Validates : Requirements 3.1**
    - Test unitaire : `generateBezierTrajectory(100, 200)` — dernier point ≈ (100, 200)
    - Test unitaire : délais monotones aux extrémités (plus lents qu'au milieu)
    - _Requirements: 3.1, 3.2_

- [x] 7. CfSolverOrchestrator — cascade de stratégies et intégration cache
  - [x] 7.1 Mettre à jour `solveCfChallenge` avec check cache et enregistrement métriques
    - En entrée de `solveCfChallenge` : appeler `getCachedSession(domain)` avant `page.bringToFront()`
    - Si cache hit valide : logger `💾 Cache hit — domaine: <domain> — TTL restant: <N>s`, appeler `_recordCacheHit()`, retourner `{ success: true, solvedBy: "already_cleared", ... }`
    - Si cache miss : appeler `_recordCacheMiss()`
    - Après succès de résolution : construire `CfSession { cfClearance, cookies, obtainedAt, expiresAt }` et appeler `setCachedSession(domain, session)`
    - En fin de `solveCfChallenge` (succès ou échec) : appeler `_recordSolve(durationMs)`
    - _Requirements: 4.6, 5.1, 8.4, 8.5_

  - [x] 7.2 Mettre à jour la cascade de stratégies dans `solveCfChallenge`
    - Appliquer les timeouts JSD passifs : `jsd=65s`, `iuam=45s`, `managed=30s`, `unknown=65s`
    - Après timeout JSD passif : re-détecter le type, escalader vers `solveTurnstileByClick` si turnstile ou jsd/unknown
    - Pour `"turnstile"` : appliquer directement `solveTurnstileByClick` sans attente JSD
    - Pour `"blocked"` : retour immédiat `success: false` sans tentative
    - Pour `"none"` : retour immédiat `success: true` sans traitement
    - Fallback CapSolver conditionnel à `CAPSOLVER_API_KEY` défini
    - Champ `solvedBy` : `"already_cleared"` | `"jsd_passive"` | `"iuam_wait"` | `"turnstile_cdp"` | `"capsolver_fallback"`
    - _Requirements: 4.1–4.7_

  - [x] 7.3 Tests unitaires du CfSolverOrchestrator
    - Test unitaire : `challengeType: "none"` → `success: true` immédiatement, aucun appel au solver
    - Test unitaire : `challengeType: "blocked"` → `success: false` immédiatement
    - Test unitaire : cache hit → `solvedBy: "already_cleared"`, pas de navigation
    - Test unitaire : log masquage `cf_clearance` — valeur loggée ≤ 30 premiers caractères
    - _Requirements: 4.5, 4.6, 8.3_

- [x] 8. Checkpoint — vérification intermédiaire
  - Vérifier que les sections SessionCache, ChallengeDetector, StealthManager, et Bézier compilent sans erreur via `tsc --noEmit --strict`
  - Corriger les éventuelles erreurs de type `any` ou `unknown` non gardés
  - S'assurer que tous les imports `import type` sont utilisés correctement
  - Demander à l'utilisateur si des questions se posent avant de continuer

- [x] 9. `solveCfChallengeWithRetry` — retry et rotation IP
  - [x] 9.1 Mettre à jour la boucle retry avec backoff exponentiel borné
    - Implémenter backoff : `Math.min(Math.pow(2, attempt - 1) * 2000, 20000)` ms
    - Respecter strictement `maxRetries` (≤ N tentatives quelle que soit la séquence d'échecs)
    - Logger chaque tentative : `🔄 Tentative N/maxRetries — proxy: <masked_url>`
    - _Requirements: 6.1, 6.2, 6.5_

  - [x] 9.2 Mettre à jour la rotation IP Decodo
    - Appeler `rotateDecodoUrl()` si `isDecodoMultiPool()` (pool multi-URLs)
    - Sinon : générer un nouveau `sessionid` de 8 caractères aléatoires dans le username (`-sessionid-XXXXXXXX`)
    - Appeler `buildRotatedProxyUrl` avant chaque nouvelle tentative (sauf la première)
    - `purgeCfStaleData` + `navigateWithCacheBust` avant chaque tentative
    - _Requirements: 6.3, 6.4, 6.6, 6.7_

  - [x] 9.3 Tests unitaires et property tests du retry
    - **Property 5 : Borne stricte du retry** — pour tout `maxRetries` ∈ [1, 10], le nombre de tentatives ≤ `maxRetries`
    - **Validates : Requirements 6.1**
    - **Property 6 : Monotonie et borne du backoff** — `delays[i+1] >= delays[i]` et aucun délai > 20 000 ms
    - **Validates : Requirements 6.2**
    - **Property 8 : Unicité des sessionids** — 10 appels consécutifs à `buildRotatedProxyUrl` → 10 sessionids distincts
    - **Validates : Requirements 6.4**
    - Test unitaire : `buildRotatedProxyUrl` sur URL sans credentials → retourne URL originale
    - _Requirements: 6.1–6.8_

- [x] 10. Exports rétrocompatibles et nouvelles exports
  - [x] 10.1 Vérifier et compléter les exports du module
    - Conserver les exports v1 : `solveCfChallenge`, `solveCfChallengeWithRetry`, `preparePageStealth`, `detectChallengeType`
    - Conserver les exports utilitaires v1 : `findTurnstileIframe`, `computeTurnstileClickCoords`, `humanLikeCdpClick`, `waitForClearance`, `isTurnstileResolved`, `getClearanceValue`, `getAllCookies`, `buildRotatedProxyUrl`
    - Conserver les exports de types v1 : `CfChallengeType`, `CfSolveResult`, `CfSolveOptions`, `CfSolveWithRetryOptions`
    - Ajouter les nouveaux exports du SessionCache : `getCachedSession`, `setCachedSession`, `invalidateSession`, `getCacheMetrics`
    - Ajouter les nouveaux exports de types : `CfSession`, `CachedSessionResult`, `CacheMetrics`
    - Exporter `generateBezierTrajectory` et `cubicBezier` pour les tests
    - Ajouter également `monitorAndSolveChallenges` (déjà présent en v1, à conserver)
    - _Requirements: 7.1–7.5_

- [x] 11. Intégration finale et câblage
  - [x] 11.1 Câbler tous les composants dans `cf-challenge-solver.ts`
    - Vérifier que `solveCfChallenge` appelle bien dans l'ordre : cache check → `bringToFront` → `detectChallengeType` → JSD passif → re-detect → `solveTurnstileByClick` → CapSolver → cache set → métriques
    - Vérifier que `solveCfChallengeWithRetry` appelle `preparePageStealth` une seule fois avant la boucle
    - Vérifier que tous les logs respectent le format `[cf-solver] <emoji> <message>` (Req 8.1)
    - S'assurer qu'aucune valeur de `cf_clearance`, token ou mot de passe n'est loggée au-delà de 30 caractères (Req 8.3)
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 11.2 Tests d'intégration du flux complet
    - Test unitaire : flux `jsd` → timeout → re-detect → `turnstile_cdp` → succès → session mise en cache
    - Test unitaire : `solveCfChallengeWithRetry` avec `maxRetries: 2` → exactement 2 tentatives puis échec
    - _Requirements: 4.1, 4.2, 6.1_

- [x] 12. Vérification TypeScript strict et compilation
  - Exécuter `cd artifacts/slot-hunter && npx tsc --noEmit --strict`
  - Corriger toute erreur de compilation : `any` implicite, return types manquants, imports incorrects
  - Vérifier qu'aucun `any` explicite n'est présent (utiliser `unknown` + type guards)
  - _Requirements: 9.1–9.4_

- [x] 13. Checkpoint final — tous les tests passent
  - Exécuter `cd artifacts/slot-hunter && npx vitest run` (si vitest installé)
  - Corriger les tests qui échouent
  - S'assurer que les 10 propriétés property-based passent avec `numRuns: 100`
  - Demander à l'utilisateur si des questions se posent

---

## Notes

- Les tâches marquées `*` sont optionnelles et peuvent être passées pour un MVP plus rapide
- Le module reste un fichier TypeScript unique (`cf-challenge-solver.ts`) — pas de split
- La réécriture est in-place : le fichier existant est remplacé dans sa totalité
- Aucune dépendance npm supplémentaire sauf `vitest` et `fast-check` pour les tests
- Les 10 propriétés de correction du design sont couvertes par les sous-tâches de test marquées `*`
- `fast-check` doit être importé avec `import fc from "fast-check"` + `import { describe, it, expect } from "vitest"`
- Le `tsconfig.json` doit inclure `src/__tests__/**/*` pour que les tests compilent

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["3.1", "4.1"] },
    { "id": 2, "tasks": ["3.2", "4.2", "5.1", "6.1"] },
    { "id": 3, "tasks": ["3.3", "5.2", "5.3", "6.2", "6.3"] },
    { "id": 4, "tasks": ["5.4", "6.4", "7.1"] },
    { "id": 5, "tasks": ["7.2", "9.1"] },
    { "id": 6, "tasks": ["7.3", "9.2"] },
    { "id": 7, "tasks": ["9.3", "10.1"] },
    { "id": 8, "tasks": ["11.1"] },
    { "id": 9, "tasks": ["11.2"] }
  ]
}
```
