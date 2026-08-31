# Requirements Document

## Introduction

Le worker Espagne (Bookitit / CitaConsular) exécute aujourd'hui ~13 workers parallèles mais NON synchronisés. Chaque worker fait `scan → sleep relatif → scan`, ce qui crée une dérive de phase : à l'instant exact de publication des créneaux (fenêtre ~60 s), les workers sont dispersés sur -11 s à -43 s depuis leur dernier scan. La détection devient une loterie (forensic 2026-08-31 : 12 workers sains, seuls 4 ont vu les créneaux, 3 ont booké).

Cette feature transforme l'essaim de workers en un ensemble synchronisé sur une **grille d'horloge murale absolue** : chaque worker dort jusqu'au prochain front de tick `ceil(now/tick)*tick` au lieu d'un sleep relatif. L'horloge devient une barrière commune sans coordination centrale. Le système ajoute : un **jitter par worker borné** pour l'indétectabilité sans casser l'alignement, une **machine à états worker** (ARMED / SCANNING / RECOVERING) avec récupération asynchrone non bloquante, un **tri strict des échecs**, un **pool de sessions de réserve pré-solvées** (swap instantané en cas de mort proxy), une **phase preflight** (HH:05→HH:13) qui pré-arme et vérifie les sessions tôt, une **phase chasse** (HH:13→HH:17, tick 10 s), un **ralentissement tardif conditionnel** (HH:17→HH:25, tick 60 s uniquement si l'agenda est resté vide), et un **mode RACE** découplant détection et booking. Le tout respecte les contraintes physiques prouvées du portail (cycle complet imposé, PHPSESSID neuf par scan, cf_clearance lié à l'exit IP) et reste configurable via variables d'environnement.

L'objectif métier est de maximiser le taux de booking de créneaux visa Espagne pendant les publications courtes en garantissant qu'un maximum de workers regardent l'endpoint `datetime/` dans la même fenêtre de tick.

## Glossary

- **Grid_System**: Le système de synchronisation sur grille d'horloge murale (composant WallClockGrid) qui calcule le prochain front de tick absolu.
- **Worker_System**: Un worker de dossier Espagne exécutant la boucle de scan synchronisée et la machine à états.
- **Orchestrator_System**: L'orchestrateur (spain-worker-orchestrator) qui pilote le preflight, le pool de réserve et la supervision de récupération.
- **Reserve_Pool_System**: Le gestionnaire de pool de sessions de réserve pré-solvées (ReservePoolManager).
- **Preflight_System**: Le contrôleur de la phase preflight (PreflightController).
- **Classifier_System**: La fonction de tri strict des échecs (classify) qui transforme un résultat de scan en cause classifiée.
- **tick**: Intervalle de grille en millisecondes. `huntTickMs` en phase chasse (défaut 10000), `lateTickMs` en phase tardive (défaut 60000).
- **front de grille** (nextFront): Instant absolu `ceil(nowMs / tick) * tick`, commun à tous les workers, servant de barrière de synchronisation.
- **jitter**: Décalage déterministe par worker, borné à `±jitterPct · tick`, appliqué au front de grille pour casser le pattern régulier tout en restant dans la même fenêtre de tick.
- **ARMED**: État worker prêt à scanner, session valide, en attente du prochain front de tick.
- **SCANNING**: État worker en cours d'exécution d'un cycle complet de scan.
- **RECOVERING**: État worker en cours de récupération asynchrone après un échec ; ne scanne pas mais ne bloque pas les autres workers.
- **preflight** (phase preflight): Fenêtre HH:05→HH:13 dédiée à l'armement des sessions et à leur vérification de validité.
- **phase chasse** (hunt): Fenêtre HH:13→HH:17 où la grille tourne à tick plein (10 s).
- **phase tardive** (late): Fenêtre HH:17→HH:25 où le tick peut ralentir à 60 s si l'agenda est resté vide.
- **mode RACE**: Mode où la détection d'un créneau est découplée du booking : le premier worker qui voit publie un snapshot, tous les workers foncent booker à partir de ce snapshot.
- **pool de réserve** (Reserve_Pool): Ensemble de N sessions pré-solvées, chacune sur sa propre IP, disponibles pour un swap instantané en cas de mort proxy.
- **cf_clearance**: Cookie Cloudflare lié à l'exit IP ; invalide dès que l'IP change (re-solve obligatoire).
- **PHPSESSID**: Cookie de session PHP du portail Bookitit ; doit être neuf à chaque scan (getagendas autorisé 1 seule fois par PHPSESSID).
- **agenda actif**: État du portail où des créneaux sont publiés et réservables (publication en cours).
- **agenda vide**: État du portail où aucun créneau n'est publié ; signal normal, pas une erreur.
- **slotEverSeen**: Drapeau monotone passant à `true` dès qu'un créneau a été vu au moins une fois pendant la fenêtre, bloquant le ralentissement tardif.
- **cycle complet**: Séquence imposée `gettoken → POST token → main → getservices → getagendas → datetime` exécutée avec un PHPSESSID neuf ; durée plancher ~2.7 s sans créneau.
- **FailureKind**: Cause classifiée d'un échec de cycle : `proxy_dead`, `http_5xx`, `session_dead`, `cf_expired`, `agenda_empty`.
- **windowEnd**: Instant absolu de fin de fenêtre (minute `SPAIN_WINDOW_END_MIN` dans l'heure) au-delà duquel aucun scan n'est lancé.

## Requirements

### Requirement 1: Synchronisation sur grille d'horloge murale

**User Story:** En tant qu'opérateur du hunter Espagne, je veux que tous les workers s'alignent sur une grille d'horloge murale absolue, afin qu'un maximum d'entre eux regardent l'endpoint de publication dans la même fenêtre de tick.

#### Acceptance Criteria

1. WHEN un worker ARMED termine son cycle de scan, THE Grid_System SHALL calculer le prochain front de grille comme `ceil(nowMs / tick) * tick`, où `nowMs` est lu depuis la référence d'horloge murale partagée exprimée en millisecondes epoch.
2. THE Grid_System SHALL calculer un front de grille de base identique au bit près pour tous les workers utilisant le même `tick` et lisant la même référence d'horloge murale partagée au même instant.
3. WHEN un worker doit attendre le prochain scan, THE Worker_System SHALL dormir jusqu'au front de grille absolu retourné par le Grid_System au lieu d'un intervalle relatif, la valeur de tick effective étant bornée à l'intervalle `[1000, 3600000]` millisecondes.
4. IF le front cible calculé est inférieur ou égal à `nowMs`, THEN THE Grid_System SHALL viser le front de grille suivant en ajoutant un `tick`.
5. WHEN un worker se réveille au front de grille visé, THE Worker_System SHALL déclencher un nouveau cycle de scan et exposer un état de réveil observable identifiant le worker et le front de grille atteint.
6. WHEN un worker se réveille, THE Worker_System SHALL garantir que l'écart absolu entre l'instant de réveil effectif et le front de grille visé, hors jitter appliqué, est inférieur ou égal à 50 millisecondes.
7. IF la lecture de la référence d'horloge murale échoue ou retourne une valeur non numérique, THEN THE Grid_System SHALL rejeter le calcul du front de grille et produire une indication d'erreur identifiant l'échec de lecture d'horloge sans planifier de réveil.

### Requirement 2: Jitter par worker borné

**User Story:** En tant qu'opérateur soucieux d'indétectabilité, je veux un jitter par worker borné, afin de casser le pattern régulier introduit par l'alignement sans faire sortir les workers de leur fenêtre de tick commune.

#### Acceptance Criteria

1. WHEN un front de grille est calculé, THE Grid_System SHALL appliquer un jitter dont la valeur absolue est inférieure ou égale à `jitterMax`, où `jitterMax = floor(jitterPct · tick)`, avec `tick` exprimé en millisecondes, `jitterPct` un réel borné dans l'intervalle `[0.0, 0.5]`, et `jitterMax` exprimé en millisecondes.
2. WHEN le jitter est calculé deux fois ou plus pour un même `workerSeed`, un même `dossierId` et un même index de tick, THE Grid_System SHALL retourner à chaque calcul une valeur de jitter identique au bit près.
3. WHEN un délai d'attente est retourné, THE Grid_System SHALL garantir que sa valeur est un entier de millisecondes compris dans l'intervalle `[0, tick + jitterMax)`, borne supérieure exclue.
4. WHEN le `gridSeed` d'un worker est dérivé, THE Worker_System SHALL produire, pour un même `dossierId`, une valeur de `gridSeed` identique au bit près à chaque dérivation.
5. IF `jitterPct` est absent, non numérique, ou hors de l'intervalle `[0.0, 0.5]`, ou si `tick` est absent, non entier, ou inférieur ou égal à 0, THEN THE Grid_System SHALL rejeter le calcul, conserver inchangée toute valeur de délai précédemment retournée, et produire une indication d'erreur signalant le paramètre invalide.

### Requirement 3: Machine à états worker et récupération non bloquante

**User Story:** En tant qu'opérateur, je veux une machine à états worker avec récupération asynchrone, afin qu'un worker qui tombe ne perturbe jamais la cadence des autres workers.

#### Acceptance Criteria

1. THE Worker_System SHALL maintenir chaque worker dans exactement un état parmi `ARMED`, `SCANNING`, `RECOVERING`, sans jamais laisser l'état à une valeur nulle ou indéfinie.
2. WHEN un cycle de scan échoue avec une cause appartenant à l'ensemble fermé `{proxy_dead, http_5xx, session_dead, cf_expired}`, THE Worker_System SHALL lancer la récupération en tâche de fond et effectuer une transition explicite `SCANNING → RECOVERING` en moins de 100 millisecondes, sans attendre la fin de la récupération.
3. IF un cycle de scan échoue avec une cause n'appartenant pas à l'ensemble fermé `{proxy_dead, http_5xx, session_dead, cf_expired}`, THEN THE Worker_System SHALL maintenir le worker en état `ARMED` sans déclencher de récupération.
4. WHILE un worker est en état `RECOVERING`, THE Worker_System SHALL calculer le délai d'attente des autres workers jusqu'à leur prochain front de grille avec une dérive de tick inférieure ou égale à 50 millisecondes et en excluant tout worker en état `RECOVERING` du calcul de cadence commune.
5. WHEN une récupération en tâche de fond rétablit une session valide, THE Worker_System SHALL effectuer une transition explicite `RECOVERING → ARMED` afin que le worker rejoigne la grille au prochain front de tick.
6. IF une récupération en tâche de fond échoue, THEN THE Worker_System SHALL réessayer la récupération avec un backoff de 5000 millisecondes jusqu'à un maximum de 10 tentatives, en maintenant le worker en état `RECOVERING` et en journalisant chaque échec avec un préfixe de module.
7. IF le nombre maximal de 10 tentatives de récupération est épuisé sans succès, THEN THE Worker_System SHALL maintenir le worker en état `RECOVERING` terminal, cesser de nouvelles tentatives, et journaliser un événement d'abandon de récupération identifiant le worker et la cause.

### Requirement 4: Tri strict des échecs

**User Story:** En tant que développeur, je veux un tri strict et total des échecs de cycle, afin que chaque résultat de scan reçoive une réponse de récupération déterministe et appropriée.

#### Acceptance Criteria

1. WHEN un résultat de scan est classifié, THE Classifier_System SHALL retourner exactement un `FailureKind` en moins de 100 millisecondes.
2. WHEN un résultat de scan a le statut `proxy_error`, THE Classifier_System SHALL retourner `proxy_dead`.
3. WHEN un résultat de scan a le statut `error` accompagné d'un code HTTP compris dans l'intervalle 500 à 599 inclus, THE Classifier_System SHALL retourner `http_5xx`.
4. WHEN un résultat de scan a le statut `error` sans code HTTP compris dans l'intervalle 500 à 599, THE Classifier_System SHALL retourner de façon déterministe `proxy_dead`.
5. WHEN un résultat de scan a le statut `session_dead`, THE Classifier_System SHALL retourner `session_dead`.
6. WHEN un résultat de scan a le statut `cf_expired`, THE Classifier_System SHALL retourner `cf_expired`.
7. WHEN un résultat de scan a le statut `not_found`, THE Classifier_System SHALL retourner `agenda_empty`.
8. WHILE le `FailureKind` classifié est `agenda_empty`, THE Worker_System SHALL maintenir le worker en état `ARMED` sans incrémenter de compteur d'erreur.
9. IF un résultat de scan a un statut non reconnu, nul, absent, ou vide, THEN THE Classifier_System SHALL retourner `proxy_dead` par défaut et émettre un avertissement non fatal identifiant le statut reçu.

### Requirement 5: Pool de sessions de réserve et swap instantané

**User Story:** En tant qu'opérateur, je veux un pool de sessions de réserve pré-solvées, afin de remplacer instantanément une session dont le proxy est mort sans payer le coût d'un re-solve en pleine chasse.

#### Acceptance Criteria

1. WHEN la phase preflight démarre, THE Reserve_Pool_System SHALL pré-solver des sessions de réserve jusqu'à atteindre `targetSize` (valeur entière configurable comprise entre 1 et 20, défaut 4), chaque session étant établie sur une IP distincte non partagée avec une autre session de réserve ou active.
2. WHEN une récupération de cause `proxy_dead` survient ET au moins une session de réserve avec un cookie `cf_clearance` non expiré est disponible, THE Worker_System SHALL emprunter cette session et l'assigner au worker sans exécuter d'appel de solve synchrone dans le chemin du swap, l'assignation devant se terminer en moins de 500 ms.
3. WHEN une session de réserve est empruntée, THE Reserve_Pool_System SHALL déclencher en tâche de fond un re-solve sur une nouvelle IP distincte afin de reconstituer la réserve manquante jusqu'à revenir à `targetSize`, sans bloquer le chemin du swap.
4. IF une récupération de cause `proxy_dead` survient ET aucune session de réserve avec `cf_clearance` non expiré n'est disponible, THEN THE Worker_System SHALL effectuer une rotation d'IP puis un re-solve pour établir une nouvelle session, et signaler l'indisponibilité de réserve à l'appelant.
5. IF un re-solve de reconstitution en tâche de fond échoue, THEN THE Reserve_Pool_System SHALL réessayer sur une IP distincte jusqu'à 3 tentatives avec backoff exponentiel (base 2 000 ms, facteur x2), et au-delà signaler l'échec de reconstitution sans interrompre les sessions de réserve existantes.
6. WHEN un proxy est déclaré mort, THE Worker_System SHALL marquer l'IP correspondante comme blacklistée et exclure cette IP de toute sélection ultérieure pour une session de réserve ou active.
7. WHEN le nombre de réserves prêtes est demandé, THE Reserve_Pool_System SHALL retourner le compte entier des sessions de réserve disposant d'un cookie `cf_clearance` non expiré, valeur comprise entre 0 et `targetSize`.

### Requirement 6: Phase preflight — armement et vérification anticipée

**User Story:** En tant qu'opérateur, je veux une phase preflight qui arme et vérifie les sessions tôt, afin de disposer du temps nécessaire pour un swap ou re-solve avant le début de la phase chasse.

#### Acceptance Criteria

1. WHILE l'heure courante est dans la fenêtre preflight (`[windowStartMin, huntStartMin[`), THE Preflight_System SHALL armer exactement une session par dossier pour chaque dossier non encore armé, dans un délai maximum de 30 secondes par dossier.
2. WHEN une session est armée, THE Preflight_System SHALL vérifier sa validité et enregistrer le résultat de vérification (valide ou invalide) au plus tard 60 secondes avant `huntStartMin`.
3. IF une session armée est vérifiée invalide, THEN THE Preflight_System SHALL effectuer un swap vers une session de réserve prête dans un délai maximum de 5 secondes et déclencher une reconstitution de réserve en tâche de fond sans bloquer la phase preflight.
4. IF aucune session de réserve prête n'est disponible lors d'un swap requis, THEN THE Preflight_System SHALL déclencher un re-solve immédiat de la session et consigner une indication d'échec de swap identifiant le dossier concerné, en conservant l'état des autres sessions armées.
5. IF une session armée n'a pas atteint un résultat de vérification valide au moment de `huntStartMin`, THEN THE Preflight_System SHALL marquer le dossier concerné comme non prêt et consigner une indication d'échec de preflight identifiant le dossier, sans interrompre le traitement des autres dossiers.

### Requirement 7: Phase chasse — grille pleine

**User Story:** En tant qu'opérateur, je veux une phase chasse à grille pleine, afin que tous les workers scannent à la cadence maximale alignée pendant la fenêtre de publication attendue.

#### Acceptance Criteria

1. WHILE la minute-dans-l'heure courante (0 à 59, dérivée de l'horodatage courant modulo 60 minutes) est supérieure ou égale à `huntStartMin` et strictement inférieure à `lateStartMin` (intervalle `[huntStartMin, lateStartMin[`), THE Grid_System SHALL retourner la valeur de phase `hunt`.
2. WHILE la phase courante retournée est `hunt`, THE Grid_System SHALL utiliser la valeur `huntTickMs` comme intervalle de tick effectif, avec une tolérance d'alignement de plus ou moins 50 millisecondes par rapport à la grille alignée.
3. WHILE la phase courante est `hunt`, THE Grid_System SHALL aligner chaque tick sur une frontière multiple de `huntTickMs` calculée depuis le début de l'heure courante (minute 0, seconde 0).
4. IF la minute-dans-l'heure courante est strictement inférieure à `huntStartMin` ou supérieure ou égale à `lateStartMin`, THEN THE Grid_System SHALL retourner une valeur de phase autre que `hunt` et ne pas appliquer `huntTickMs`.
5. IF `huntStartMin` est supérieur ou égal à `lateStartMin`, ou si l'une des bornes est en dehors de l'intervalle 0 à 59, THEN THE Grid_System SHALL rejeter la configuration au démarrage avec une indication d'erreur signalant une fenêtre chasse invalide.

### Requirement 8: Ralentissement tardif conditionnel

**User Story:** En tant qu'opérateur soucieux de la consommation proxy, je veux un ralentissement tardif conditionnel, afin d'économiser du trafic uniquement quand aucun créneau n'a été vu, tout en restant réactif aux annulations si un créneau a été observé.

#### Acceptance Criteria

1. WHILE la minute-dans-l'heure courante (0 à 59, dérivée de l'horodatage courant dans le fuseau `Europe/Madrid` modulo 60 minutes) satisfait `lateStartMin <= minuteDansHeure < windowEndMin`, THE Grid_System SHALL retourner la phase `late`.
2. WHILE la phase courante est `late` ET `slotEverSeen` est `false`, THE Grid_System SHALL utiliser `lateTickMs` comme tick effectif avec une tolérance d'alignement de plus ou moins 1000 millisecondes.
3. WHILE la phase courante est `late` ET `slotEverSeen` est `true`, THE Grid_System SHALL utiliser `huntTickMs` comme tick effectif avec une tolérance d'alignement de plus ou moins 1000 millisecondes.
4. WHEN un scan observe au moins un créneau disponible dans l'agenda, THE Worker_System SHALL positionner `slotEverSeen` à `true` avant le prochain tick.
5. THE Worker_System SHALL maintenir `slotEverSeen` de façon monotone de sorte qu'après être passé à `true`, sa valeur reste `true` pour toute lecture ultérieure jusqu'à la fin de la fenêtre (`windowEndMin`), sans jamais repasser à `false`.
6. IF la minute-dans-l'heure courante est hors de la fenêtre tardive (`minuteDansHeure < lateStartMin` OU `minuteDansHeure >= windowEndMin`), THEN THE Grid_System SHALL retourner une phase autre que `late` et utiliser `huntTickMs` comme tick effectif.

### Requirement 9: Mode RACE — détection découplée du booking

**User Story:** En tant qu'opérateur, je veux découpler la détection du booking, afin que dès qu'un worker voit un créneau, tous les workers foncent booker à partir d'un snapshot partagé.

#### Acceptance Criteria

1. WHEN un worker détecte un agenda actif contenant au moins un créneau avec une capacité libre supérieure ou égale à 1, THE Worker_System SHALL passer l'indicateur `slotEverSeen` à `true` dans un délai maximal de 500 ms après la détection.
2. WHEN un worker détecte un agenda actif contenant au moins un créneau avec une capacité libre supérieure ou égale à 1, THE Worker_System SHALL publier un snapshot contenant l'identifiant d'agenda, la liste des créneaux détectés, la capacité libre par créneau et un horodatage de détection, diffusé à l'ensemble des workers actifs dans un délai maximal de 500 ms après la détection.
3. WHEN un snapshot de créneaux dont l'horodatage de détection est daté de moins de 60 secondes est disponible pour un worker, THE Worker_System SHALL lancer une tentative de booking à partir de ce snapshot sans attendre son propre cycle de détection.
4. IF un snapshot disponible a un horodatage de détection daté de 60 secondes ou plus, THEN THE Worker_System SHALL ignorer ce snapshot, s'abstenir de lancer une tentative de booking à partir de ce snapshot, et signaler le snapshot comme expiré.
5. WHERE la somme des capacités libres des créneaux du snapshot est supérieure ou égale au seuil configuré (valeur entière comprise entre 1 et 10 000, valeur par défaut 5), THE Worker_System SHALL contourner le sémaphore de concurrence de booking et autoriser tous les workers actifs à lancer leur tentative de booking simultanément.
6. IF la publication du snapshot échoue, THEN THE Worker_System SHALL conserver l'indicateur `slotEverSeen` déjà positionné, réessayer la publication jusqu'à un maximum de 3 tentatives espacées d'un backoff exponentiel de base 2 000 ms, et signaler un échec de publication après épuisement des tentatives.

### Requirement 10: Respect des contraintes portail prouvées

**User Story:** En tant que développeur, je veux respecter les contraintes physiques prouvées du portail Bookitit, afin de ne pas invalider les sessions ni déclencher de blocage.

#### Acceptance Criteria

1. WHEN un worker démarre un scan, THE Worker_System SHALL exécuter la séquence complète et ordonnée `gettoken → POST token → main → getservices → getagendas → datetime` en utilisant un PHPSESSID nouvellement généré pour ce scan.
2. WHILE un PHPSESSID donné reste actif, THE Worker_System SHALL n'émettre l'appel `getagendas` qu'une seule fois pour ce PHPSESSID.
3. THE Grid_System SHALL fixer `huntTickMs` à une valeur supérieure ou égale à 2700 ms.
4. WHEN une récupération modifie l'exit IP d'un worker, THE Worker_System SHALL obtenir un nouveau cf_clearance lié à la nouvelle exit IP avant tout appel Bookitit suivant.
5. IF une requête utiliserait un cf_clearance obtenu sur une exit IP différente de l'exit IP courante, THEN THE Worker_System SHALL rejeter l'usage de ce cf_clearance et déclencher un re-solve sur l'exit IP courante avant d'émettre la requête.
6. WHEN une récupération de cause `session_dead` survient, THE Worker_System SHALL générer un nouveau PHPSESSID tout en conservant l'exit IP et le cf_clearance courants, puis ré-exécuter la séquence complète du critère 1.
7. WHEN une récupération de cause `cf_expired` survient, THE Worker_System SHALL obtenir un nouveau cf_clearance sur la même exit IP courante sans changer le PHPSESSID courant.

### Requirement 11: Configurabilité via variables d'environnement

**User Story:** En tant qu'opérateur, je veux configurer le comportement de la grille et du pool via des variables d'environnement, afin d'ajuster les paramètres sans modifier le code.

#### Acceptance Criteria

1. WHEN le Grid_System s'initialise, THE Grid_System SHALL lire `huntTickMs` depuis la variable d'environnement `SPAIN_HUNT_TICK_MS`, interprétée comme un entier en millisecondes contraint à l'intervalle [1000, 3600000].
2. IF `SPAIN_HUNT_TICK_MS` est absent, vide, non numérique, ou hors de l'intervalle [1000, 3600000], THEN THE Grid_System SHALL utiliser la valeur par défaut 10000 millisecondes et émettre un message d'avertissement indiquant le nom de la variable et la valeur par défaut appliquée.
3. WHEN le Grid_System s'initialise, THE Grid_System SHALL lire `lateTickMs` depuis `SPAIN_LATE_TICK_MS`, interprétée comme un entier en millisecondes contraint à l'intervalle [1000, 3600000], et utiliser la valeur par défaut 60000 si absent/vide/non numérique/hors intervalle.
4. WHEN le Grid_System s'initialise, THE Grid_System SHALL lire `jitterPct` depuis `SPAIN_GRID_JITTER_PCT`, interprétée comme un nombre décimal, et utiliser 0.2 par défaut si absent/vide/non numérique.
5. IF la valeur lue pour `jitterPct` est inférieure à 0 ou supérieure à 0.5, THEN THE Grid_System SHALL borner la valeur à l'intervalle [0, 0.5].
6. WHEN le Grid_System s'initialise, THE Grid_System SHALL lire `windowStartMin` depuis `SPAIN_WINDOW_START_MIN`, `huntStartMin` depuis `SPAIN_HUNT_START_MIN`, `lateStartMin` depuis `SPAIN_LATE_WINDOW_START_MIN`, et `windowEndMin` depuis `SPAIN_WINDOW_END_MIN`, chacune interprétée comme un entier de minutes-dans-l'heure contraint à l'intervalle [0, 59], en utilisant respectivement les valeurs par défaut 5, 13, 17, et 25 si absent/vide/non numérique/hors intervalle.
7. WHEN le Reserve_Pool_System s'initialise, THE Reserve_Pool_System SHALL lire `targetSize` depuis `SPAIN_RESERVE_POOL_SIZE`, interprétée comme un entier contraint à l'intervalle [1, 100], et utiliser 4 par défaut si absent/vide/non numérique/hors intervalle.
8. THE Grid_System SHALL vérifier que les valeurs effectives satisfont l'ordre strict `windowStartMin < huntStartMin < lateStartMin < windowEndMin`.
9. IF l'ordre strict n'est pas satisfait, THEN THE Grid_System SHALL rejeter la configuration, conserver les quatre valeurs par défaut (5, 13, 17, 25), et émettre un message d'erreur indiquant la contrainte d'ordre violée.

### Requirement 12: Borne de fenêtre horaire

**User Story:** En tant qu'opérateur, je veux que les workers respectent strictement la fin de fenêtre, afin de ne jamais lancer de scan hors de la plage horaire prévue.

#### Acceptance Criteria

1. IF l'instant courant `Date.now()` (millisecondes epoch) est supérieur ou égal à `windowEnd` (millisecondes epoch), THEN THE Worker_System SHALL s'abstenir de démarrer tout nouveau scan et retourner le contrôle sans effectuer d'appel réseau de scan.
2. WHEN un scan en cours se termine et que la fenêtre est fermée à l'instant courant, THE Worker_System SHALL ne planifier aucun scan suivant.
3. WHEN le délai d'attente calculé porterait l'instant de réveil à un moment supérieur ou égal à `windowEnd`, THE Worker_System SHALL plafonner la durée de sommeil de sorte que l'instant de réveil soit inférieur ou égal à `windowEnd`.
4. WHILE la minute-dans-l'heure courante (0 à 59, fuseau `Europe/Madrid`) est en dehors de l'intervalle `[windowStartMin, windowEndMin[`, THE Grid_System SHALL retourner la phase `preflight` par défaut.
5. WHILE la minute-dans-l'heure courante est en dehors de `[windowStartMin, windowEndMin[`, THE Orchestrator_System SHALL s'abstenir de démarrer tout nouveau scan.
6. IF `windowStartMin` ou `windowEndMin` est absent, non entier, hors [0, 59], ou si `windowStartMin >= windowEndMin`, THEN THE Grid_System SHALL retourner la phase `preflight` par défaut, THE Orchestrator_System SHALL s'abstenir de démarrer tout scan, et produire une indication d'erreur de configuration de fenêtre invalide.

### Requirement 13: Indétectabilité et sécurité

**User Story:** En tant qu'opérateur, je veux préserver l'indétectabilité et la sécurité des secrets, afin que l'essaim se comporte comme un utilisateur légitime et ne fuite aucune donnée sensible.

#### Acceptance Criteria

1. WHEN un worker planifie une requête sur une grille alignée, THE Worker_System SHALL appliquer un décalage aléatoire (jitter) de ±jitterPct de l'intervalle de base, recalculé de façon déterministe par worker, de sorte que le pattern global ne soit pas strictement régulier.
2. WHEN une session worker est initialisée, THE Worker_System SHALL sélectionner une valeur de User-Agent et réutiliser cette même valeur pour la totalité des requêtes de cette session sans la modifier jusqu'à la fin de la session.
3. THE Worker_System SHALL lire les secrets (`CAPSOLVER_API_KEY`, `NONECAP_API_KEY`, URLs proxy) exclusivement depuis les variables d'environnement, et ne jamais les inscrire dans le code source ni dans aucune sortie journalisée.
4. IF une variable d'environnement de secret requise est absente ou vide au démarrage, THEN THE Worker_System SHALL interrompre l'initialisation de la session concernée et émettre une indication d'erreur identifiant la variable manquante par son nom sans en révéler la valeur.
5. WHEN un log inclut une valeur `cf_clearance`, THE Worker_System SHALL tronquer la valeur pour ne conserver qu'un maximum de 8 à 40 caractères de tête suivis d'un marqueur de troncature, de sorte que la valeur complète n'apparaisse jamais dans la sortie journalisée.

### Requirement 14: Résilience du pool épuisé

**User Story:** En tant qu'opérateur, je veux que le système survive à un épuisement du pool de proxies pendant la chasse, afin de ne pas perdre définitivement un worker au moment critique.

#### Acceptance Criteria

1. IF une tentative de récupération échoue à emprunter un proxy de réserve ET échoue à obtenir une nouvelle IP par rotation, THEN THE Worker_System SHALL maintenir le worker en état `RECOVERING` sans transition vers un état terminal ou d'erreur fatale.
2. WHILE le worker est en état `RECOVERING` suite à un pool épuisé, THE Worker_System SHALL retenter l'acquisition d'un proxy (réserve puis rotation) au prochain tick de chasse.
3. WHEN une nouvelle tentative d'acquisition de proxy réussit alors que le worker est en état `RECOVERING`, THE Worker_System SHALL faire transiter le worker vers l'état actif et reprendre le scan.
4. WHEN le pool de proxies est détecté comme épuisé pendant la chasse, THE Worker_System SHALL journaliser un événement d'épuisement identifiant le worker et la cause sans émettre d'erreur fatale ni terminer le processus.
5. WHILE le worker est en état `RECOVERING` suite à un pool épuisé, THE Worker_System SHALL retenter à chaque tick tant que la chasse est active, préservant l'état et le contexte du worker entre les tentatives.
