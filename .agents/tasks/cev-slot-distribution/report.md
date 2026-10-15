# Rapport — Distribution/coordination multi-comptes CEV Belgique & SLOT_TAKEN

Investigation **lecture seule** du mécanisme de booking parallèle CEV dans `artifacts/slot-hunter`.
Objectif : expliquer pourquoi beaucoup de créneaux reviennent `SLOT_TAKEN`
(`/Integration/Error/TimeSlotNoLongerAvailable`) quand plusieurs dossiers bookent en
parallèle, et recommander une stratégie de distribution.

Toutes les affirmations citent fichier + lignes. Les points non déterminables par lecture
sont signalés explicitement.

---

## 0. Résumé exécutif (réponse directe)

Le pic de `SLOT_TAKEN` observé (18 créneaux `free:1`, 10 dossiers, décision `BOOK_PARALLEL_ALL`)
vient d'une **collision interne** entre nos propres dossiers, pas (principalement) de
concurrents externes. Deux failles structurelles cumulées :

1. **La coordination par créneau est quasi inexistante dans le chemin qui s'active réellement.**
   Avec 18 créneaux > seuil RACE (5), on n'est PAS en mode RACE — mais le claim Redis
   `tryClaimCevSlot` n'est appliqué QUE sur le chemin du **dossier détecteur**
   (`cev-dossier-loop.ts` ~l.1894-1901). Les **autres dossiers réveillés** (le gros du lot,
   9 sur 10 dans l'exemple) sont bookés via `Promise.allSettled` **sans aucun claim** et,
   dans le cas nominal, **sans créneau cible** (`targetForRef = undefined`,
   `cev-dossier-loop.ts` ~l.2028-2045). Chacun refait alors indépendamment dans
   `bookCevViaHttp` le tri `free décroissant` et prend `candidateSlots[0]` — **le même
   "meilleur" créneau pour tout le monde** (`cevHttpBooking.ts` ~l.1061-1065, 1091-1096).
   → collision frontale garantie dès le 1er essai sur un seul et même créneau.

2. **Sur le chemin détecteur, l'allocation par `accountIndex` est une ROTATION cyclique**
   (`cev-slot-assignment.ts` ~l.100-103) : chaque compte vise un créneau de départ distinct,
   mais les cascades de retry **convergent** — compte[i] après échec tombe sur le créneau que
   compte[i+1] vise. (Nuance importante : ce chemin détecteur n'implique en pratique **qu'un
   seul compte détecteur à la fois**, donc l'effet de convergence inter-comptes y est limité ;
   la vraie collision de masse est au point 1.)

La pièce manquante déterminante est **(B) un claim Redis par créneau effectif dans le chemin
de réveil multi-dossier** (actuellement il n'y en a aucun), complété par **(A) un ordre de
retry entrelacé** au lieu de la rotation. (D) le micro-jitter est cosmétique.

---

## 1. Architecture réelle (indispensable pour interpréter le log)

Point clé souvent mal lu : `accountIndex` / `totalAccounts` = nombre de **comptes/jobs CEV
actifs** (`destination=schengen`), PAS le nombre de dossiers d'un pool.

- `startCevDossierLoop` récupère les jobs CEV, les trie de façon stable et lance **une loop par
  compte** avec un index fixe (`cev-dossier-loop.ts` l.2176-2182) :
  ```
  const sortedJobs = [...cevJobs].sort((a,b) => String(a.id).localeCompare(String(b.id)));
  const totalAccounts = sortedJobs.length;
  const loopPromises = sortedJobs.map((job, accountIndex) => runAccountLoop(job, accountIndex, totalAccounts));
  ```
- **À l'intérieur d'un compte**, un pool de dossiers (`cevDossierPool`) est scanné en
  round-robin. Quand un dossier (le « détecteur ») voit des créneaux, `handleSlotFoundMulti`
  (l.1709+) booke le détecteur puis **réveille les autres dossiers du même pool** (`eligibleRefs`).

Le log `{ eligibleDossiers: 10, decision: BOOK_PARALLEL_ALL }` correspond donc à
`eligibleRefs.length = 10` **dossiers d'un même compte** (`cev-dossier-loop.ts` l.1797-1806 :
`decision = totalFree < eligibleRefs.length ? BOOK_FIRST_THEN_OTHERS : BOOK_PARALLEL_ALL`,
ici 18 ≥ 10 → `BOOK_PARALLEL_ALL`). C'est le chemin **multi-dossier d'un compte**, pas une
course inter-comptes. Cette distinction est centrale pour Q3/Q4.

---

## 2. Q1 — Parallèle réel ou séquentiel ?

**Les 10 dossiers ne sont PAS tous traités de la même façon : 1 détecteur en séquentiel, puis
jusqu'à N autres en parallèle réel.**

- **Détecteur** : booké en premier, en **séquentiel**, par une boucle `for … of candidates`
  (`cev-dossier-loop.ts` l.1891-1946). `candidates = orderedSlots` (sa rotation) ou `[null]`.
- **Autres dossiers** : réveillés en **parallèle réel** via `Promise.allSettled`
  (`cev-dossier-loop.ts` l.2026-2065) :
  ```
  const bookingTasks = selectedRefs.map((vowintRef) => { ... return bookDossierIsolated(...); });
  const results = await Promise.allSettled(bookingTasks);
  ```
  Chaque tâche ouvre sa **propre session isolée** (`bookDossierIsolated`, l.1587+) — pas de
  partage de session. Donc oui, booking parallèle authentique pour les secondaires.
- Nombre réveillé : `dossiersToWake = min(remainingFree, otherRefsWithinDeadline.length)`
  (l.1998-2001). Avec `remainingFree = 18 - 1 = 17` et 9 autres éligibles → **les 9 foncent en
  parallèle**.

---

## 3. Q2 — Créneau de départ distinct ? Cascades convergentes ?

**Chemin détecteur (séquentiel) :** oui, créneau de départ distinct par `accountIndex`, MAIS
cascade de retry convergente par construction.

- `buildCevSlotAssignment` trie identiquement pour tous puis applique un **décalage cyclique**
  (`cev-slot-assignment.ts` l.100-103) :
  ```
  const startPos = ((myIndex % sorted.length) + sorted.length) % sorted.length;
  return [...sorted.slice(startPos), ...sorted.slice(0, startPos)];
  ```
  → la liste de chaque compte est une **rotation** de la même séquence. Au 1er essai les points
  de départ diffèrent ; mais `orderedSlots` étant parcouru dans l'ordre
  (`sorted[i], sorted[i+1], …`), **compte[i] après échec vise exactement le créneau que
  compte[i+1] a comme départ** → convergence des cascades. L'analyse de la brief est
  **confirmée** par le code.
  (Rappel Q1 : ce chemin ne concerne qu'un détecteur à la fois, donc cet effet inter-comptes est
  surtout théorique ici ; il devient réel si plusieurs **comptes** détectent au même instant.)

**Chemin réveil multi-dossier (parallèle, le gros du lot) :** NON, pas de créneau distinct dans
le cas nominal.

- `targetForRef` n'est renseigné **que si `detectorBlockedByDeadline`** (détecteur bloqué par SA
  propre deadline) — `cev-dossier-loop.ts` l.2028-2045 :
  ```
  let targetForRef: { date: string; time: string } | undefined;
  if (detectorBlockedByDeadline) { const ordered = buildCevSlotAssignment(...); if (ordered.length>0) targetForRef = {date, time}; }
  return bookDossierIsolated(..., targetForRef, refDeadline);
  ```
  Dans le cas nominal (détecteur a pu booker ou n'était pas bloqué par deadline),
  **`targetForRef = undefined`**.
- Avec `targetSlot = undefined`, `bookCevViaHttp` ne réduit pas la liste et sélectionne
  `candidateSlots[0]` après tri `free décroissant` (`cevHttpBooking.ts` l.1061-1065, 1091-1096) :
  ```
  availableSlots.sort((a,b) => (b.free ?? 1) - (a.free ?? 1));
  const candidateSlots = slotsWithMinFree.length > 0 ? slotsWithMinFree : availableSlots;
  let slot = candidateSlots[0];
  ```
  Comme tous les créneaux sont `free:1`, le tri est quasi stable → **tous les dossiers réveillés
  convergent sur le même premier créneau**. Puis la boucle `maxSlotAttempts = min(5, N)`
  (l.1072) les fait tous descendre dans **le même ordre** `candidateSlots[1], [2], …` →
  convergence totale, à chaque étape de retry.

---

## 4. Q3 — Claim atomique par créneau appliqué dans ce chemin ?

**NON dans le chemin qui compte (réveil multi-dossier). OUI uniquement pour le détecteur.**

- La primitive existe et est correcte : `tryClaimCevSlot` (SET NX via script Lua, clé globale
  `visaflow:cev-slot-claim:{date}:{time}`, TTL 90 s) + `releaseCevSlot`
  (`cev-redis-persistence.ts` l.~300-420).
- Elle est appelée **seulement** dans la boucle du **détecteur**, et **seulement hors mode RACE**
  (`cev-dossier-loop.ts` l.1894-1901) :
  ```
  if (candidate && !raceMode) {
    const claimed = await tryClaimCevSlot(candidate.date, candidate.time, String(applicationId), candidate.free);
    if (!claimed) { ...continue; }
  }
  ```
  avec libération sur échec l.1940-1942 (`releaseCevSlot`).
- **Le bloc `Promise.allSettled` des dossiers réveillés (l.2026-2065) n'appelle JAMAIS
  `tryClaimCevSlot`.** Aucune réservation par créneau n'est posée avant que les 9 sessions
  soumettent leur POST. C'est **la pièce manquante** : les secondaires n'ont ni cible distincte
  ni claim.
- Détail aggravant côté identifiant : même sur le chemin détecteur, le claim utilise
  `String(applicationId)` = l'**ID du compte**, pas du dossier (l.1895). Idempotence par compte :
  si deux dossiers du même compte passaient par un claim sur le même créneau, le 2e serait
  considéré « déjà claim par moi » et accepté — l'anti-collision inter-dossiers intra-compte
  serait neutralisé. (Non déterminant ici puisque les secondaires ne claim pas du tout, mais à
  corriger si on étend le claim : utiliser une clé par **dossier**.)

Pourquoi des SLOT_TAKEN subsistent même quand un claim existe (détecteur) : (a) mode RACE
court-circuite le claim quand `distinctSlotCount ≤ 5` (l.1818) ; (b) le claim ne protège que
contre nos comptes, pas contre l'extérieur ; (c) fenêtre TOCTOU résiduelle entre claim et POST.

---

## 5. Q4 — Part interne vs externe des SLOT_TAKEN

Raisonnement structurel (pas de données prod requises), scénario du log : 18 créneaux `free:1`,
10 dossiers d'un compte, `BOOK_PARALLEL_ALL`, non-RACE (18 > 5).

- 1 détecteur booke sa rotation avec claim → prend ~1 créneau proprement.
- 9 dossiers réveillés en parallèle, **sans cible et sans claim** → tri identique → **les 9
  visent le même créneau `candidateSlots[0]`**. Au mieux **1 gagne, 8 reçoivent SLOT_TAKEN**,
  puis tous retombent ensemble sur `candidateSlots[1]` (1 gagne, 7 SLOT_TAKEN), etc. jusqu'à
  `maxSlotAttempts = min(5, N) = 5`.
- Attendu purement interne : grosso modo `8 + 7 + 6 + 5 + 4 ≈ 30` réponses SLOT_TAKEN pour
  ~5 bookings réussis — **alors qu'il y a 18 créneaux libres pour 10 dossiers**, soit largement
  de quoi servir tout le monde sans collision.

**Conclusion : la très grande majorité des SLOT_TAKEN de ce scénario est INTERNE** (nos propres
dossiers convergent). La preuve logique : l'offre (18) dépasse la demande (10) ; un système sans
collision interne produirait ~0 SLOT_TAKEN interne. La part externe est le bruit résiduel
(concurrents hors système prenant un créneau entre notre lecture et notre POST), structurellement
minoritaire ici. Chiffrage précis non déterminable par lecture seule (dépend des logs
`cev_http_slot_taken_retry` réels).

---

## 6. Q5 — Recommandation priorisée

Objectif : zéro collision interne tant que `#créneaux ≥ #dossiers réveillés`. Priorité aux
corrections **structurelles** (A, B) ; (C) et (D) en complément.

### P0 — (B) Claim Redis par créneau dans le chemin de réveil + (A) cible distincte entrelacée  — CORRECTIF STRUCTUREL
C'est la correction qui élimine la cause racine. Deux sous-actions indissociables :

- **(A) Donner une cible distincte à CHAQUE dossier réveillé**, pas seulement sous
  `detectorBlockedByDeadline`. Remplacer la rotation cyclique par un **entrelacement par pas de
  N** : dossier de rang `r` (0-based parmi les réveillés) vise `sorted[r], sorted[r+N], sorted[r+2N], …`
  (N = nombre de dossiers réveillés). Ainsi les listes ne se **recouvrent jamais** avant épuisement
  de l'offre → les cascades de retry ne convergent plus. Toujours passer `targetForRef` (= 1er
  élément de la liste entrelacée) à `bookDossierIsolated`.
  - Fichiers/fonctions : `cev-dossier-loop.ts` bloc `bookingTasks` (l.2026-2045) ;
    `cev-slot-assignment.ts` `buildCevSlotAssignment` (remplacer `slice/concat` cyclique par un
    parcours entrelacé `for (k=myIndex; k<len; k+=N)` puis complément). Mêmes retouches
    souhaitables côté `spain-slot-assignment.ts` (même faille de rotation).
- **(B) Appliquer `tryClaimCevSlot` avant soumission pour les dossiers réveillés**, exactement
  comme le détecteur (l.1894-1901), avec `releaseCevSlot` sur échec. Utiliser une clé de claim
  **par dossier** (`vowintRef`), pas par compte, pour que l'idempotence ne neutralise pas
  l'anti-collision intra-compte.
  - Fichiers/fonctions : `cev-dossier-loop.ts` dans le `.map` de `bookingTasks` (l.2026) ;
    primitives déjà prêtes dans `cev-redis-persistence.ts` (`tryClaimCevSlot` / `releaseCevSlot`).
  - Attention au **mode RACE** : il court-circuite le claim quand `distinctSlotCount ≤ 5`
    (l.1818). Avec cible entrelacée distincte, le claim redevient peu coûteux ; garder RACE
    uniquement pour les très faibles counts si justifié.
- **Impact** : élimine ~la totalité des SLOT_TAKEN internes du scénario. **Risque** : faible
  (primitives existantes, TTL court 90 s auto-nettoyant ; en mode dégradé sans Redis,
  `tryClaimCevSlot` renvoie `true` → comportement actuel conservé). **Effort** : moyen (logique
  d'entrelacement + brancher le claim ; tests sur `cev-slot-assignment`).

### P1 — (C) Plafonner le parallélisme à min(dossiers, créneaux)
Déjà partiellement en place : `dossiersToWake = min(remainingFree, otherRefsWithinDeadline.length)`
(l.1998-2001). À renforcer en bornant aussi par le nombre de **créneaux distincts réellement
distribuables** après entrelacement, pour ne jamais réveiller plus de dossiers que de cibles
uniques.
- Fichier : `cev-dossier-loop.ts` l.1998-2001. **Impact** : moyen (évite le sur-réveil résiduel).
  **Risque** : très faible. **Effort** : faible.

### P2 — (D) Micro-jitter temporel entre soumissions  — COSMÉTIQUE
Désynchroniser les POST de ~20-150 ms réduit la fenêtre TOCTOU mais **ne corrige pas** la
convergence (ils visent toujours le même créneau sans A/B). À n'ajouter qu'en complément de A/B.
- Fichier : `cev-dossier-loop.ts` autour du `.map` des `bookingTasks` (l.2026). **Impact** : faible.
  **Risque** : faible. **Effort** : trivial. **Nature** : cosmétique (ne touche pas la faille racine).

### Verdict
- **Corrige la faille structurelle : (A) + (B)** — cible distincte entrelacée **et** claim Redis
  dans le chemin de réveil parallèle (l.2026-2065). C'est là qu'est le trou aujourd'hui.
- **Complément utile : (C)**. **Cosmétique : (D)**.

---

## 7. Références de code (synthèse)

| Sujet | Fichier | Lignes |
|---|---|---|
| 1 loop par compte, accountIndex/totalAccounts | `src/loops/cev-dossier-loop.ts` | 2176-2182 |
| Seuil RACE (défaut 5) | `src/loops/cev-dossier-loop.ts` | 796-801 |
| `raceMode = count ≤ seuil` | `src/loops/cev-dossier-loop.ts` | 1818 |
| Décision BOOK_PARALLEL_ALL | `src/loops/cev-dossier-loop.ts` | 1797-1806 |
| Allocation détecteur `buildCevSlotAssignment` | `src/loops/cev-dossier-loop.ts` | 1825-1833 |
| Boucle détecteur + claim/release | `src/loops/cev-dossier-loop.ts` | 1891-1946 |
| `dossiersToWake = min(remainingFree, …)` | `src/loops/cev-dossier-loop.ts` | 1998-2001 |
| Réveil parallèle `Promise.allSettled`, `targetForRef` conditionnel | `src/loops/cev-dossier-loop.ts` | 2026-2065 |
| Rotation cyclique (slice+concat) | `src/cev-slot-assignment.ts` | 100-103 |
| `targetSlot` réduit availableSlots à [matched] | `src/cevHttpBooking.ts` | 1016-1030 |
| Tri free desc + `candidateSlots[0]` + retry min(5,N) | `src/cevHttpBooking.ts` | 1061-1096 |
| `tryClaimCevSlot` / `releaseCevSlot` (SET NX Lua, TTL 90 s) | `src/cev-redis-persistence.ts` | ~300-420 |
| Référence Spain : même rotation cyclique | `src/spain-slot-assignment.ts` | ~78-85 |

---

## 8. Limites de l'analyse (lecture seule)

- Les numéros de ligne de `cev-redis-persistence.ts` sont approximatifs (fichier lu en entier,
  fonctions `tryClaimCevSlot`/`releaseCevSlot` présentes et correctes).
- La part exacte interne/externe des SLOT_TAKEN est un raisonnement structurel ; le chiffrage
  réel exigerait l'analyse des botLogs `cev_http_slot_taken_retry` / `cev_multi_booking_fail`.
- Je n'ai pas exécuté le bot ni de requête réseau (contrainte respectée). Aucun fichier source
  modifié : seul ce rapport a été écrit.
