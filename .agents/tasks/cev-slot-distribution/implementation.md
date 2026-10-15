# Implémentation — cev-slot-distribution (anti-collision interne CEV)

Objectif : éliminer les collisions internes (SLOT_TAKEN évitables) entre dossiers d'un même
compte CEV réveillés en parallèle, tant que #créneaux ≥ #dossiers réveillés.

## (A) Allocation entrelacée — RÉALISÉ

Fichier : `src/cev-slot-assignment.ts`, fonction `buildCevSlotAssignment`.

- Remplacement du **décalage cyclique** (`slice(startPos)+slice(0,startPos)`, qui faisait de la
  liste de chaque compte une simple rotation de la même séquence → cascades de retry convergentes)
  par un **entrelacement par pas de N** (= `totalAccounts`) :
  - le rang `start` (= `myIndex mod N`) visite d'abord ses créneaux dédiés `sorted[start]`,
    `sorted[start+N]`, `sorted[start+2N]`… ;
  - puis la liste est complétée par tous les autres créneaux dans l'ordre trié → **permutation
    complète** conservée pour une cascade de fallback complète.
- Propriété garantie : tant que `sorted.length ≥ N`, les premiers choix de deux comptes distincts
  ne se recouvrent jamais, et les k-ièmes choix divergent au maximum.
- **Conservés** : signature publique inchangée (`accountId, eligible, groupSize, totalAccounts,
  accountIndex?, maxDate?` → `CevSlotCandidate[]`), tri d'attractivité (date proche → fits groupSize
  → free → heure) et filtre `maxDate` appliqués AVANT l'entrelacement.
- Tests dédiés : `src/__tests__/cev-slot-assignment.test.ts` (13 tests).

## (B) Claim Redis par créneau dans le chemin de réveil parallèle — RÉALISÉ

Fichier : `src/loops/cev-dossier-loop.ts`, bloc `bookingTasks` (`Promise.allSettled`).

- Chaque dossier réveillé reçoit désormais une **cible distincte** calculée via
  `buildCevSlotAssignment`, avec son **rang 0-based parmi les réveillés** (`wakeIndex`) comme
  `accountIndex` et le **nombre de réveillés** (`selectedRefs.length`) comme `totalAccounts` — et
  ce dans le cas nominal, pas seulement sous `detectorBlockedByDeadline`.
- Avant soumission, un **claim Redis par dossier** est posé via `tryClaimCevSlot(date, time,
  vowintRef, free)`. Sur échec de claim → passage au **créneau suivant** de la liste entrelacée du
  dossier (pas de soumission). Sur échec de booking → `releaseCevSlot(date, time, vowintRef)`.
- **Clé par dossier (`vowintRef`)**, PAS par compte (`applicationId`) : évite que l'idempotence du
  claim neutralise l'anti-collision entre dossiers d'un même compte.
- **Mode RACE préservé** : quand `raceMode` est actif (`distinctSlotCount ≤ CEV_RACE_MODE_SLOT_THRESHOLD`),
  aucun claim n'est posé (on fonce, le serveur CEV arbitre), exactement comme le détecteur.
- **Mode dégradé sans Redis préservé** : `tryClaimCevSlot` renvoie `true` → comportement actuel.
- Cas HTML absent (orderedForRef vide) : une seule passe sans claim avec `targetSlot=undefined`,
  `bookDossierIsolated` re-scanne/choisit (comportement historique).

## (C) Plafonner le parallélisme — RÉALISÉ

Fichier : `src/loops/cev-dossier-loop.ts`, calcul de `dossiersToWake`.

- Ajout d'une borne supplémentaire par le **nombre de créneaux distincts distribuables** :
  `dossiersToWake = min(remainingFree, otherRefsWithinDeadline.length, distinctDistributableSlots)`
  avec `distinctDistributableSlots = inlineSlots.length` (fallback `remainingFree` si HTML absent).
- Garantit qu'on ne réveille jamais plus de dossiers que de cibles uniques → l'entrelacement peut
  donner un premier choix distinct à chacun.

## Fichiers touchés

- `src/cev-slot-assignment.ts` (A : entrelacement + doc).
- `src/loops/cev-dossier-loop.ts` (B : claim par vowintRef + cible entrelacée par réveillé ; C : borne).
- `src/__tests__/cev-slot-assignment.test.ts` (nouveau : 13 tests).
- `.agents/tasks/cev-slot-distribution/verification.md`, `implementation.md` (docs).

## Décision sur `spain-slot-assignment.ts`

**Non modifié.** Il présente la même rotation cyclique, mais : (1) il alimente un orchestrateur
Spain distinct (modes meute/éclaireur/scout) avec sa propre coordination Redis et sa propre suite de
tests ; (2) le changer élargirait le risque hors du périmètre CEV de cette tâche. Conformément à la
consigne « dans le doute, le laisser et le mentionner », il est laissé en l'état et signalé ici.

## Contraintes transverses respectées

- Endpoints/payloads de soumission (`submitSlotSelection`) inchangés.
- Comptage de clics / `MAX_CLICKS_PER_HOUR` inchangés.
- Garde `validUntil` et correction transitoire récente inchangés.
- Chemin du détecteur séquentiel inchangé (hors ajustement `dossiersToWake` partagé).
- Mode dégradé sans Redis fonctionnel.

## Vérification

- `npx tsc --noEmit` → OK (0 erreur).
- `npx vitest run src/__tests__/cev-slot-assignment.test.ts` → 13/13 passés.
