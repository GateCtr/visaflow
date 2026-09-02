# Implementation Plan: France Visa Hunter

## Overview

Ce plan implémente le module **France Visa Hunter** dans `artifacts/slot-hunter/src/france/` (fichiers kebab-case, TypeScript strict, logs préfixés `[franceHunter]`, secrets via `.env`). Chaque tâche construit sur la précédente et se termine par le câblage au dispatcher `src/index.ts`, sans code orphelin.

Les tests property-based utilisent `vitest` + `fast-check` (≥ 100 itérations via `{ numRuns: 100 }`), chacun annoté `// Feature: france-visa-hunter, Property N: ...`. Les 32 propriétés du design portent sur les fonctions pures ; les comportements réseau sont couverts par tests d'intégration/exemple à base de mocks (`vi.mock` sur `france-http` / `solveTurnstileToken`). On réutilise `src/capsolver-turnstile.ts`, `proxyPool.ts`, `humanBehavior.ts`.

## Tasks

- [x] 1. Poser les fondations : types partagés et configuration
  - [x] 1.1 Créer `src/france/france-types.ts`
    - Définir les interfaces/types : `FranceServiceTarget`, `FranceJobConfig`, `FranceSlot`, `GetIntervalResponse`, `ExcludeDaysResponse`, `ExcludeDaysBody`, `BookingContact`, `CustomField`, `SlotToKeep`, `ServiceForApi`, `UserForApi`, `ReservationsFamilyBody`, `ReservationsFamilyResponse`, `SlotPublication`, `BookingResult`, `ValidationResult`, `ScanWindow`, `ReservationSession`, `FranceAuthState`, `FranceHttpResult`, `FranceHttpHeadResult`, `FranceRequestOptions`, `TurnstilePurpose`, `BookingContext`, `FranceEnvConfig`
    - TypeScript strict : aucun `any`, propriétés optionnelles marquées, `type` pour unions
    - _Requirements: 13.3, 14.1, 14.2_
  - [x] 1.2 Créer `src/france/france-config.ts`
    - Constantes `FRANCE_API_BASE`, `FRANCE_TURNSTILE_SITEKEY`, `FRANCE_GOUV_WEB`, `FRANCE_TIMEOUT_MS`, `FRANCE_MAX_RETRIES`, `FRANCE_RETRY_BACKOFF_MS`, `FRANCE_SESSION_TTL_MS`, `FRANCE_SESSION_RENEW_MS`, `FRANCE_MOTIF_KEY`, `FRANCE_ALLOWED_MOTIFS` (+ type `FranceMotif`)
    - `loadFranceEnv(): FranceEnvConfig` lisant les clés/secrets depuis l'environnement (`.env`/dotenv), aucune valeur en dur
    - _Requirements: 3.1, 6.1, 8.4, 10.6, 11.6, 12.1, 14.2_
  - [x] 1.3 Écrire les tests unitaires de config
    - Vérifier que `FRANCE_ALLOWED_MOTIFS` contient exactement les 7 motifs, `loadFranceEnv` lève une erreur explicite si une clé requise manque (jamais de secret en dur)
    - _Requirements: 12.1, 10.6_

- [x] 2. Implémenter le client HTTP bas niveau (`france-http.ts`)
  - [x] 2.1 Écrire les helpers purs de calcul réseau
    - Dans `src/france/france-http.ts` : `computeBackoffMs(attempt)` = `2000 * 2^attempt`, `buildRequestHeaders(auth, method)` injectant `x-gouv-app-id`, `x-gouv-web: fr.gouv.consulat` et `x-csrf-token` sur POST/PUT, `maskSecret(value)` (≤ 8 premiers caractères + `...`)
    - _Requirements: 1.6, 1.7, 1.10, 11.5, 12.4_
  - [x] 2.2 Écrire le test property-based du backoff
    - **Property 3: Backoff exponentiel déterministe** — pour tout `attempt ≥ 0`, délai = `2000 * 2^attempt`
    - **Validates: Requirements 1.10, 4.5, 5.5, 11.5, 11.6**
  - [x] 2.3 Écrire les tests property-based des headers
    - **Property 4: Headers anti-bot toujours présents** — `x-gouv-app-id` = `authState.appId` et `x-gouv-web` = `fr.gouv.consulat`
    - **Property 5: x-csrf-token sur les requêtes POST/PUT** — `x-csrf-token` = `handshakeToken` courant
    - **Validates: Requirements 1.6, 1.7**
  - [x] 2.4 Écrire le test property-based du masquage
    - **Property 30: Masquage des données sensibles** — `maskSecret` ne révèle jamais plus que 8 caractères + `...`
    - **Validates: Requirements 12.4**
  - [x] 2.5 Implémenter `createFranceHttpClient` et `fetchWithRetry`
    - Méthodes `get`, `post`, `head`, `updateCsrf`, `authState` ; `fetchWithRetry` (timeout 30 s via `AbortController`, `MAX_RETRIES=3`, backoff ×2, retry sur erreur réseau/statut ≥ 500, pas de retry sur 4xx hors 418)
    - Gestion HTTP 418 → `onRehandshake()` puis rejeu (max 3 handshakes), HTTP 404 `SESSION_ERROR` → `sessionError: true`, `x-gouv-limit` → backoff avant requête suivante, routage via `proxyPool.ts`, `try/catch` contextuel `[franceHunter]`
    - _Requirements: 1.8, 8.5, 11.3, 11.5, 11.6, 12.5_
  - [x] 2.6 Implémenter les validateurs de DTO défensifs
    - `parseSlots`, `parseExcludeDays`, `isValidWindow`, `isValidTeamId`, `isValidSessionId` : rejeter (`null`/`invalid`) toute réponse non conforme, ne propager aucune donnée non validée
    - _Requirements: 12.2_
  - [x] 2.7 Écrire le test property-based de validation défensive
    - **Property 31: Validation défensive des réponses externes** — toute réponse non conforme est rejetée sans propagation
    - **Validates: Requirements 12.2**

- [x] 3. Checkpoint - Types, config et client HTTP
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implémenter le handshake et la résolution consulat (`france-handshake.ts`)
  - [x] 4.1 Écrire les helpers purs de handshake
    - `parseHandshakeHeaders(headers): FranceAuthState`, `isHandshakeValid(headers): boolean`
    - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - [x] 4.2 Écrire les tests property-based du parse handshake
    - **Property 1: Parse du handshake extrait les deux jetons** — `handshakeToken` = `x-gouv-handshake`, `appId` = `x-gouv-app-id`
    - **Property 2: Validité du handshake ssi les deux jetons non vides**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5**
  - [x] 4.3 Implémenter `performHandshake` et `resolveTeam`
    - `performHandshake(proxyUrl)` : `HEAD /handshake`, retries backoff (max 3), retour `null` après échec ; `resolveTeam(http, slug)` : `GET /team/slug/{slug}?lang=fr`, validation `teamId` non vide
    - Log `[franceHunter]` + contexte (Job/slug) en cas d'échec, abandon sans mutation d'état
    - _Requirements: 1.1, 1.8, 1.9, 1.10, 2.1, 2.2, 2.3, 2.4_
  - [x] 4.4 Écrire le test property-based de validation teamId
    - **Property 6: Validation du teamId** — `isValidTeamId` true ssi `teamId` chaîne non vide
    - **Validates: Requirements 2.2**
  - [x] 4.5 Écrire les tests d'intégration handshake/résolution (mocks)
    - Handshake absent → retry ; HTTP 418 → re-handshake + rejeu (max 3) ; slug introuvable → abandon
    - _Requirements: 1.1, 1.8, 2.1, 2.3_

- [x] 5. Implémenter le wrapper Turnstile (`france-turnstile.ts`)
  - [x] 5.1 Implémenter `solveFranceTurnstile`
    - Wrapper autour de `solveTurnstileToken` (proxyless, sitekey `0x4AAAAAAAc-bWzy0zJTmAqs`), retries 3× backoff ×2, retour `null` si échec ; helper pur plaçant le token dans le champ `captcha`
    - _Requirements: 3.1, 3.2, 3.4_
  - [x] 5.2 Écrire le test property-based du placement du token
    - **Property 7: Le token Turnstile est placé dans le champ captcha**
    - **Validates: Requirements 3.2**
  - [x] 5.3 Écrire le test property-based des tokens distincts
    - **Property 8: Deux tokens Turnstile distincts par parcours** — un `session` + un `booking`, distincts
    - **Validates: Requirements 3.3**

- [x] 6. Implémenter la session et le TTL (`france-session.ts`)
  - [x] 6.1 Écrire les fonctions pures de TTL
    - `shouldRenewSession(session, nowMs)` (≥ 25 min), `isSessionExpired(session, nowMs)` (≥ 30 min) avec temps injecté
    - _Requirements: 4.4, 5.1, 5.2_
  - [x] 6.2 Écrire les tests property-based du TTL
    - **Property 11: Expiration de session à 30 minutes exactement**
    - **Property 12: Renouvellement anticipé à 25 minutes**
    - **Validates: Requirements 4.4, 5.1, 5.2**
  - [x] 6.3 Implémenter `openSession` et la mise à jour du csrf
    - `POST /team/{teamId}/reservations-session` avec Turnstile #1, validation `sessionId` non vide, mise à jour `x-csrf-token` depuis la réponse via `http.updateCsrf`, retries backoff (max 3), détection `SESSION_ERROR`
    - Renouvellement anticipé : ouverture d'une nouvelle session en chevauchement, bascule du `sessionId` sans perte du contexte de scan
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 5.3, 5.4, 5.5_
  - [x] 6.4 Écrire le test property-based du sessionId et du csrf
    - **Property 9: Validation du sessionId** — `isValidSessionId` true ssi chaîne non vide
    - **Property 10: Mise à jour du x-csrf-token depuis la réponse de session**
    - **Validates: Requirements 4.2, 4.3**
  - [x] 6.5 Écrire les tests d'intégration session (mocks)
    - Ouverture KO → 3 retries puis abandon ; 404 `SESSION_ERROR` → re-bootstrap complet en préservant window/excludeDays
    - _Requirements: 4.1, 4.6, 5.3, 5.4_

- [x] 7. Checkpoint - Handshake, Turnstile et session
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implémenter le scanner (`france-scanner.ts`)
  - [x] 8.1 Écrire les fonctions pures de scan
    - `computeScannableDays(window, excludeDays)` (dates ∈ [start,end] ∧ ∉ excludeDays, triées), `detectPublication(prevExcluded, currExcluded, window, daySlots)`, construction d'URL séparant `serviceId` (`get-interval`) et `serviceName` (`availability`)
    - _Requirements: 6.3, 7.4, 8.4, 9.1, 9.2, 14.2_
  - [x] 8.2 Écrire les tests property-based de fenêtre et jours scannables
    - **Property 13: Validation de la fenêtre de scan** — `isValidWindow` true ssi format `YYYY-MM-DD` et `start ≤ end`
    - **Property 14: Jours scannables strictement dans la fenêtre et hors jours exclus**
    - **Property 15: Parse des jours exclus ne conserve que des dates valides**
    - **Validates: Requirements 6.2, 6.3, 7.2, 7.3, 7.4**
  - [x] 8.3 Écrire les tests property-based des slots et de la séparation id/nom
    - **Property 16: Parse des créneaux préserve les slots valides**
    - **Property 17: Séparation stricte identifiant `_id` / nom textuel**
    - **Validates: Requirements 8.2, 8.4, 14.2**
  - [x] 8.4 Écrire les tests property-based de détection de publication
    - **Property 19: Publication signalée sur créneaux disponibles**
    - **Property 20: Publication signalée sur rétraction des jours exclus**
    - **Validates: Requirements 9.1, 9.2**
  - [x] 8.5 Implémenter `getInterval`, `getExcludeDays` et le polling
    - `getInterval` (validation start/end/format/ordre), `getExcludeDays` (`POST exclude-days`, parse dates), `scanAvailabilityForDay` (`[]` = cas normal, pas erreur), boucle de polling avec jitter ±20 % via `humanBehavior.ts`, un jour en erreur n'interrompt pas le scan global
    - _Requirements: 6.1, 6.2, 6.4, 7.1, 7.2, 7.3, 7.5, 8.1, 8.2, 8.3, 8.5, 9.3, 9.4_
  - [x] 8.6 Écrire le test property-based de résilience et de jitter
    - **Property 18: Un jour en erreur n'interrompt pas le scan global**
    - **Property 21: Intervalle de polling borné par le jitter** — effectif ∈ [base×0.8, base×1.2]
    - **Validates: Requirements 8.5, 9.4**
  - [x] 8.7 Écrire les tests d'intégration scanner (mocks)
    - `get-interval` invalide → interruption ; `exclude-days` non-tableau → interruption ; agenda `[]` → poursuite normale
    - _Requirements: 6.4, 7.5, 8.3_

- [x] 9. Checkpoint - Scanner
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implémenter le booking (`france-booking.ts`)
  - [x] 10.1 Écrire les fonctions pures de booking
    - `computeSlotValue(serviceName, isoDate, time)` (slugify lowercase), `validateContact(contact)` (bornes), `validateMotif(motif)` (appartenance liste), `buildReservations(ctx)` (structure `{mainUser, secondaryUsers:[], sessionId, team}`), `interpretBookingResponse(res)` (succès ssi `data.qrCodes` non vide)
    - _Requirements: 10.4, 10.6, 10.8, 10.10, 10.11_
  - [x] 10.2 Écrire les tests property-based du contact et du motif
    - **Property 23: Validation des bornes du contact**
    - **Property 24: Validation du motif par appartenance à la liste**
    - **Validates: Requirements 10.4, 10.6**
  - [x] 10.3 Écrire les tests property-based du slotValue et des reservations
    - **Property 25: slotValue déterministe et en minuscules**
    - **Property 26: Structure des reservations bien formée pour Visas**
    - **Property 27: Succès du booking conditionné à qrCodes non vide**
    - **Validates: Requirements 10.8, 10.10, 10.11**
  - [x] 10.4 Implémenter `runBookingFlow`
    - Persistance des 7 étapes via `update-step-value` dans l'ordre welcome→services→important-info→slots→contact→motif→confirmation (`stepIndex` 0..6), validations contact/motif en amont, `POST reservations/family` avec Turnstile #2 + `x-csrf-token`, interruption sans envoi final si étape/validation en erreur, préservation de session, aucune nouvelle tentative auto en cas d'échec final
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 10.7, 10.9, 10.12_
  - [x] 10.5 Écrire le test property-based de l'ordre des étapes
    - **Property 22: Ordre des étapes et stepIndex du parcours Visas**
    - **Validates: Requirements 10.2**
  - [x] 10.6 Écrire les tests d'intégration booking (mocks)
    - Étape en erreur → interruption sans `reservations/family` ; contact invalide/motif hors liste → arrêt ; `qrCodes` absent → échec + session préservée
    - _Requirements: 10.3, 10.5, 10.7, 10.12_

- [x] 11. Checkpoint - Booking
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Orchestrer et câbler au dispatcher (`france-hunter.ts`)
  - [x] 12.1 Implémenter `runFranceJob`
    - Orchestration handshake → resolveTeam → Turnstile #1 → openSession → boucle scan (renouvellement à 25 min) → détection → Turnstile #2 → booking, isolation totale par Job (sessionId/x-csrf-token/IP proxy distincts), retour `SessionResult` (`"slot_found" | "not_found" | "error"`)
    - UA cohérent sur toute la session, délai inter-requêtes borné (base 2000 ms, ±500 ms) via `humanBehavior.ts`, proxy résidentiel FR stable (timezone `Europe/Paris`)
    - _Requirements: 9.3, 11.1, 11.2, 11.3, 11.4, 13.2, 13.3, 14.3_
  - [x] 12.2 Câbler le dispatcher `src/index.ts`
    - Ajouter le branch `else if (due.destination === "france") { result = await runFranceJob(due); }` dans la logique de routage existante
    - _Requirements: 13.1_
  - [x] 12.3 Écrire les tests property-based d'anti-détection et d'isolation
    - **Property 28: User-Agent cohérent sur toute la session**
    - **Property 29: Délai inter-requêtes borné** — ∈ [1500 ms, 2500 ms]
    - **Property 32: Isolation des Jobs** — pas de partage sessionId/csrf/IP entre Jobs
    - **Validates: Requirements 11.1, 11.2, 14.3**
  - [x] 12.4 Écrire les tests d'intégration d'orchestration + dispatcher (mocks)
    - `destination === "france"` route vers `runFranceJob` ; parcours nominal renvoie `slot_found` ; échec renvoie `error` avec état Job inchangé
    - _Requirements: 13.1, 13.2_

- [x] 13. Vérification finale
  - Exécuter `npx tsc --noEmit` (strict, zéro erreur, aucun `any`) et la suite `vitest` sur les fichiers `src/france/**` ; corriger toute régression
  - _Requirements: 12.1, 13.3_

## Notes

- Les tâches marquées `*` sont optionnelles (tests) et peuvent être ignorées pour un MVP rapide ; les tâches d'implémentation cœur ne le sont jamais.
- Chaque test property-based utilise `fast-check` avec `{ numRuns: 100 }` et l'annotation `// Feature: france-visa-hunter, Property N: ...`.
- Le temps (`nowMs`) est injecté dans les fonctions de session/polling pour des tests déterministes.
- Aucun booking réel en test : `reservations/family` validé par mocks uniquement.
- Chaque tâche référence des requirements/propriétés précis pour la traçabilité ; les checkpoints garantissent une validation incrémentale.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "2.6"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.7"] },
    { "id": 4, "tasks": ["4.1", "5.1", "6.1", "8.1", "10.1"] },
    { "id": 5, "tasks": ["4.2", "5.2", "5.3", "6.2", "8.2", "8.3", "8.4", "10.2", "10.3"] },
    { "id": 6, "tasks": ["4.3", "6.3", "8.5", "10.4"] },
    { "id": 7, "tasks": ["4.4", "4.5", "6.4", "6.5", "8.6", "8.7", "10.5", "10.6"] },
    { "id": 8, "tasks": ["12.1"] },
    { "id": 9, "tasks": ["12.2"] },
    { "id": 10, "tasks": ["12.3", "12.4"] }
  ]
}
```
