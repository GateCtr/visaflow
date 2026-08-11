# Implementation Plan: Spain HTTP-Pure Multi-Portal Scanner

## Overview

Migration du scanner Espagne vers une architecture 100% HTTP-pure multi-portail. Le travail est découpé en 3 phases alignées avec le design : création du module principal, mise à jour de la priorité proxy, et intégration dans la watcher loop existante. Chaque phase est incrémentale et non-breaking.

## Tasks

- [ ] 1. Phase 1 — Module principal `spain-http-multiportal-scanner.ts`
  - [ ] 1.1 Créer les interfaces et types de données
    - Créer `artifacts/slot-hunter/src/spain-http-multiportal-scanner.ts`
    - Définir les interfaces : `BookititService`, `BookititAgenda`, `DatetimeScanResult`, `PortalScanOutcome`, `MultiPortalScanResult`, `BandwidthStats`
    - Définir les constantes de timeout (`TIMEOUTS` object du design)
    - Exporter le type `SpainDossier` (ou le réimporter depuis convexClient)
    - _Requirements: 3.1, 3.3, 8.3, 10.5_

  - [ ] 1.2 Implémenter la classe `BookititPortalSession` — cycle de vie et état
    - Constructeur avec `portalUrl`, `publickey`, session state (phpSessionId, jqueryCallback, requestCounter, srvsrc, version, createdAt)
    - Flags de cache : `services`, `agendas`, `widgetConfig`, `mainHtml`, `getagendasCalled`
    - Méthodes `isExpired()` (TTL 30 min), `needsFullInit()`, `needsDatetimeOnly()`
    - Méthode `invalidate()` pour reset la session
    - _Requirements: 5.4, 5.5, 6.5, 6.6_

  - [ ] 1.3 Implémenter `buildJsonpUrl()` — construction URL avec ordre de paramètres strict
    - Ordre exact : `callback` → `type` → `publickey` → `lang` → `services[]` → `agendas[]` → `version` → `src` → `srvsrc` → extras restants → `_`
    - `srvsrc` inclus sur TOUS les endpoints SAUF `main/`
    - Callback identique pour toute la session, `_` incrémenté à chaque appel
    - Référence : `test-bookitit-dynamic.ts` fonction `makeUrl()`
    - _Requirements: 11.1, 11.2, 11.3, 11.8_

  - [ ] 1.4 Implémenter `initialize()` — séquence d'init 3 étapes HTTP
    - Étape 1 : GET widget URL → extraire token (`name="token" value="..."`) + PHPSESSID
    - Étape 2 : POST token (form-urlencoded) → extraire `srvsrc` et `version` depuis la réponse
    - Étape 3 : GET `/main/` via JSONP → valider body > 1000B → stocker `mainHtml`
    - Gestion des erreurs : throw si body vide ou HTTP error → invalidate session
    - _Requirements: 5.1, 5.2, 5.3, 5.6_

  - [ ] 1.5 Implémenter la chaîne JSONP d'auto-découverte (getwidgetconfigurations → getservices → getagendas)
    - `getwidgetconfigurations/` → extraire `registration_type` dans widgetConfig
    - `getservices/` → parser services, sélectionner le premier avec nom non-vide (strip HTML)
    - `getagendas/` → appeler UNE SEULE FOIS par session, marquer `getagendasCalled=true`
    - Headers JSONP obligatoires : `Accept`, `X-Requested-With`, `Sec-Fetch-*`, `Referer`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 11.4, 11.5, 11.6, 11.9_

  - [ ] 1.6 Implémenter `scanDatetime()` — navigation multi-mois dynamique
    - Algorithme 2 du design : scan minimum 2 mois, stop basé sur `maxDays`, max 12 mois, stop après 3 mois vides consécutifs sans maxDays
    - Construire `start=YYYY-MM-01` et `end=YYYY-MM-{lastDay}` (pas month/year)
    - Parser les slots : itérer `Slots[].times{}` → vérifier `freeSlots > 0`
    - Extraire `maxDays` de chaque réponse et tracker le plus élevé
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 11.7, 12.2, 12.3, 12.4, 12.7_

  - [ ] 1.7 Implémenter `parseJsonp()` et `classifyEmptyResponse()`
    - `parseJsonp()` : strip callback wrapper (`firstParen` → `lastParen`) → JSON.parse
    - `classifyEmptyResponse()` : `/main/` → `proxy_burned`, `getagendas/` → `portal_closed`, `getservices/`|`datetime/` → `session_expired`
    - _Requirements: 12.1, 12.5, 12.6_

  - [ ] 1.8 Implémenter `runMultiPortalScan()` — orchestration multi-portail
    - Grouper les dossiers par `portalUrl`
    - Pour chaque portail unique (séquentiellement) : get/create session → init ou datetime-only → scan
    - Appliquer inter-portal delay (2000ms ± 500ms jitter)
    - Agréger résultats dans `MultiPortalScanResult`
    - Tracker bandwidth (bytes reçus par portail et par cycle)
    - Gestion des erreurs : un portail en échec ne bloque pas les autres
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 7.1, 7.2, 7.3, 7.5_

  - [ ] 1.9 Implémenter le tracking de bande passante et l'intervalle adaptatif
    - `BandwidthStats` : sessionTotalBytes, dailyTotalBytes, dailyCfSolves, thresholdExceeded
    - Reset daily à minuit UTC
    - Si `dailyTotalBytes > SPAIN_BANDWIDTH_LIMIT_MB * 1024 * 1024` → doubler l'intervalle effectif
    - Logger la consommation toutes les 10 cycles
    - Exporter `getBandwidthStats()` et `getEffectiveScanInterval()`
    - _Requirements: 7.3, 7.4, 7.6, 10.3_

  - [ ] 1.10 Implémenter le suivi des échecs consécutifs par portail
    - Map `portalFailureCount<portalUrl, number>` — reset à 0 sur succès
    - Émettre alerte Convex au seuil de 5 échecs consécutifs
    - _Requirements: 10.6_

- [ ] 2. Checkpoint — Vérifier compilation et cohérence du module
  - Ensure all tests pass, ask the user if questions arise.
  - `cd artifacts/slot-hunter && npx tsc --noEmit` doit passer sans erreur
  - Vérifier que le module s'importe correctement depuis spain-watcher-loop.ts

- [ ] 3. Phase 2 — Mise à jour priorité proxy dans `spain-soax-solver.ts`
  - [ ] 3.1 Ajouter la priorité `SPAIN_RESIDENTIAL_PROXY_URL` dans `getSpainProxyUrl()`
    - Quand `SPAIN_SESSION_MODE=capsolver-residential` : prendre `SPAIN_RESIDENTIAL_PROXY_URL` en premier
    - Puis fallback existant : Decodo → SOAX → Oxylabs
    - Logger l'URL proxy (masquée) à la création de session
    - _Requirements: 2.1, 2.2, 2.5_

- [ ] 4. Phase 3 — Intégration dans `spain-watcher-loop.ts`
  - [ ] 4.1 Ajouter la branche mode `capsolver-residential` dans le dispatch de scan
    - Détecter `SPAIN_SESSION_MODE === "capsolver-residential"` → `runMultiPortalScan()`
    - Appeler `ensureSpainCfSession()` avant le scan multi-portail
    - Passer les dossiers actifs groupés + la CF session au scanner
    - _Requirements: 8.1, 8.2_

  - [ ] 4.2 Câbler le reporting Convex et le booking par portail
    - Itérer les résultats par portail → `reportSpainWatcherScan()` per-portal
    - Si slot trouvé → `executeHttpBooking()` avec session CF + mainHtml du cache portail
    - Si `registration_type=2` → fallback browser pour le booking uniquement
    - Émettre `reportSlotFound`, `reportSlotDiscoveryBatch` comme le système actuel
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 9.1, 9.2, 9.3, 9.4, 9.5, 3.7_

  - [ ] 4.3 Intégrer le Redis lock et les heartbeats
    - Acquérir/relâcher `acquireSpainScannerLock` / `releaseSpainScannerLock` autour du scan
    - Envoyer heartbeats à la fréquence existante
    - Utiliser `getEffectiveScanInterval()` pour l'intervalle entre cycles
    - _Requirements: 8.6, 8.7, 10.5_

  - [ ] 4.4 Ajouter le logging d'observabilité `[SPAIN-HTTP-MULTI]`
    - Log au démarrage : mode, type proxy, nombre de portails, intervalle, seuil bandwidth
    - Log par cycle : durée, portails scannés, slots trouvés, bandwidth
    - Log lors d'un CF solve : durée, coût ($0.003)
    - Log si réponse inattendue : status, headers, body length
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 5. Checkpoint — Compilation complète et test d'intégration manuelle
  - Ensure all tests pass, ask the user if questions arise.
  - `npx tsc --noEmit` doit passer avec les 3 fichiers modifiés/créés
  - Vérifier que les 3 modes (persistent-browser, HTTP-mode, capsolver-residential) coexistent sans régression

- [ ] 6. Tests property-based et unitaires
  - [ ] 6.1 Setup du fichier de test et fixtures
    - Créer `artifacts/slot-hunter/src/__tests__/spain-multiportal-scanner.test.ts`
    - Créer le répertoire `fixtures/` avec les fichiers JSONP de test (getservices, getagendas, datetime avec slots, datetime vide)
    - Importer `fast-check` et `vitest`
    - _Requirements: 11.10_

  - [ ]* 6.2 Property test — Month Navigation Correctness (Property 1)
    - **Property 1: Month Navigation Correctness**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6**
    - Générer des séquences aléatoires de réponses datetime/ (slots count + maxDays optionnel)
    - Vérifier : `monthsScanned >= 2`, `monthsScanned <= 12`, stop correct sur maxDays, stop après 3 mois vides sans maxDays

  - [ ]* 6.3 Property test — JSONP URL Construction Correctness (Property 2)
    - **Property 2: JSONP URL Construction Correctness**
    - **Validates: Requirements 5.4, 5.5, 11.1, 11.2**
    - Générer des combinaisons aléatoires endpoint + extras
    - Vérifier : ordre des paramètres, srvsrc absent sur main/, callback identique intra-session, `_` strictement croissant

  - [ ]* 6.4 Property test — JSONP Parsing Round-Trip (Property 3)
    - **Property 3: JSONP Parsing Round-Trip**
    - **Validates: Requirements 12.1**
    - Générer des valeurs JSON arbitraires, wrapper dans un callback JSONP
    - Vérifier : `parseJsonp(wrap(json))` ≡ `json` (deep equality)

  - [ ]* 6.5 Property test — Empty Response Endpoint Classification (Property 4)
    - **Property 4: Empty Response Endpoint Classification**
    - **Validates: Requirements 12.5**
    - Générer des noms d'endpoint aléatoires (incluant les 3 catégories)
    - Vérifier : classification correcte selon les règles (main/ → proxy_burned, getagendas/ → portal_closed, getservices/|datetime/ → session_expired)

  - [ ]* 6.6 Property test — Dossier Grouping Preserves All Entries (Property 5)
    - **Property 5: Dossier Grouping Preserves All Entries**
    - **Validates: Requirements 3.1, 3.2**
    - Générer des listes de dossiers avec portalUrls variés
    - Vérifier : somme des tailles de groupes = longueur originale, chaque dossier dans le bon groupe, un groupe par portalUrl distinct

  - [ ]* 6.7 Tests unitaires — session lifecycle et bandwidth
    - Tester `isExpired()` avec différents timestamps
    - Tester le seuil de 105 minutes pour CF session reuse
    - Tester le calcul d'intervalle effectif quand le threshold est dépassé
    - Tester le jitter d'inter-portal delay (1500–2500ms range)
    - _Requirements: 1.5, 7.4_

- [ ] 7. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - `cd artifacts/slot-hunter && npx vitest --run src/__tests__/spain-multiportal-scanner.test.ts`
  - `npx tsc --noEmit` sans erreurs

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Le fichier de référence canonique est `src/scripts/test-bookitit-dynamic.ts` — toute déviation doit être justifiée
- La migration est non-breaking : les modes existants (`persistent-browser`, `HTTP-mode`) restent fonctionnels
- Rollback instantané via `SPAIN_SESSION_MODE=persistent-browser`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.7"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["1.4", "1.5"] },
    { "id": 4, "tasks": ["1.6"] },
    { "id": 5, "tasks": ["1.8", "1.9", "1.10"] },
    { "id": 6, "tasks": ["3.1"] },
    { "id": 7, "tasks": ["4.1"] },
    { "id": 8, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 9, "tasks": ["6.1"] },
    { "id": 10, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6", "6.7"] }
  ]
}
```
