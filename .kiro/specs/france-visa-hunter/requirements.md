# Requirements Document

## Introduction

Le **France Visa Hunter** est un nouveau module du monorepo VisaFlow (`artifacts/slot-hunter`) qui surveille et réserve automatiquement les créneaux de rendez-vous des visas nationaux France sur le portail `consulat.gouv.fr` (solution white-label Troov pour le MEAE). Il s'ajoute aux hunters existants (USA, Espagne, Canada/CEV, Suisse) et s'intègre au dispatcher central (`src/index.ts`) via le routage par `job.destination`.

Le portail impose un handshake anti-bot maison (HTTP 418 « teapot » sans bootstrap), une protection Cloudflare Turnstile (2 résolutions par parcours), et des sessions de réservation à durée limitée (TTL 30 minutes). Le hunter doit reproduire fidèlement le flux du frontend légitime pour rester indétectable : bootstrap handshake, résolution Turnstile via CapSolver, ouverture de session, scan optimal des disponibilités (get-interval + exclude-days + availability), détection de publication, puis booking multistep complet.

Le comportement est fondé sur le reverse-engineering validé en live documenté dans `bundle-analysis/france-bundle-2026-08-31.md` (source de vérité). Le service cible de référence est « Visas » du consulat de Kinshasa (`teamId=6230a987df141cedfef4a188`, `serviceId=6346e242c47b29722d5f5f52`), mais le hunter doit être généralisable à d'autres consulats via le slug d'URL.

## Glossary

- **France_Hunter**: Le module hunter France Visa, cœur de cette spec, exécuté dans `artifacts/slot-hunter`. Responsable du bootstrap, scan, détection et booking.
- **Dispatcher**: Le routeur central `src/index.ts` qui aiguille chaque `Job` vers le hunter approprié selon `job.destination`.
- **Job**: Une unité de travail planifiée décrivant un dossier à traiter (consulat cible, service, contact, motif).
- **Handshake_Service**: La logique de bootstrap anti-bot qui appelle `HEAD /handshake` pour obtenir le token `x-gouv-handshake` (rejoué en `x-csrf-token`) et le `x-gouv-app-id`.
- **Turnstile_Solver**: La logique de résolution du captcha Cloudflare Turnstile, réutilisant `src/capsolver-turnstile.ts` (fonction `solveTurnstileToken`, proxyless) avec la sitekey `0x4AAAAAAAc-bWzy0zJTmAqs`.
- **Reservation_Session**: Une session de réservation ouverte via `POST /team/{teamId}/reservations-session`, identifiée par un `sessionId`, avec un TTL de 30 minutes.
- **Session_TTL**: La durée de validité d'une Reservation_Session, égale à 30 minutes à partir de son ouverture.
- **Scanner**: La logique de scan des disponibilités combinant `get-interval`, `exclude-days` et `availability`.
- **Scan_Window**: L'intervalle `{start, end}` de dates à scanner, retourné par `GET /team/{teamId}/reservations/get-interval?serviceId={_id}`.
- **Excluded_Days**: L'ensemble des dates fermées (fériés, week-ends, jours sans disponibilité réelle) retourné par `POST /team/{teamId}/reservations/exclude-days`.
- **Scannable_Day**: Une date appartenant à la Scan_Window et n'appartenant pas aux Excluded_Days.
- **Slot**: Un créneau de rendez-vous disponible, DTO `{time: "HH:MM", rate: "0.00", capacity: N}`.
- **Availability_Response**: La réponse de `GET /team/{teamId}/reservations/availability`, un tableau de Slot (vide `[]` si aucun créneau).
- **Slot_Publication**: L'événement où des créneaux deviennent disponibles, détecté quand les Excluded_Days se rétractent et/ou une Availability_Response devient non vide.
- **Booking_Flow**: La séquence multistep de réservation (welcome → services → important-info → slots → contact → motif → confirmation) persistée via `update-step-value`, finalisée par `POST /team/{team}/reservations/family`.
- **Motif**: Le custom field obligatoire du service Visas (`key=54cfd964c63f3386`, type checkbox) dont la valeur doit appartenir à la liste autorisée.
- **Slot_Value**: L'identifiant slugifié d'un créneau, calculé par `slugify("slot-" + serviceName + "-" + ISOdate + "-" + time).toLowerCase()`.
- **Proxy_Pool**: Le pool de proxies résidentiels utilisé pour l'anti-détection et la rotation d'IP.
- **Rate_Limit_Header**: Le header `x-gouv-limit` renvoyé par l'API indiquant le rate limiting serveur.

## Requirements

### Requirement 1: Bootstrap anti-bot (handshake)

**User Story:** En tant qu'opérateur du hunter, je veux que le module effectue le handshake anti-bot avant tout appel API, afin d'éviter le rejet HTTP 418 « teapot » et d'obtenir les jetons nécessaires.

#### Acceptance Criteria

1. WHEN une session de travail démarre pour un Job France, THE Handshake_Service SHALL envoyer une requête `HEAD /handshake` à `https://api.consulat.gouv.fr/api` avant tout autre appel API, avec un timeout maximal de 30 000 ms.
2. WHEN la réponse du handshake est reçue avec le statut HTTP 200, THE Handshake_Service SHALL extraire le header `x-gouv-handshake` et le conserver comme valeur `x-csrf-token`.
3. IF la réponse du handshake est reçue avec le statut HTTP 200 mais que le header `x-gouv-handshake` est absent ou vide, THEN THE Handshake_Service SHALL considérer le handshake comme échoué et déclencher une nouvelle tentative dans la limite de 3 tentatives maximum.
4. WHEN la réponse du handshake est reçue avec le statut HTTP 200, THE Handshake_Service SHALL extraire le header `x-gouv-app-id` et le conserver pour les requêtes suivantes.
5. IF la réponse du handshake est reçue avec le statut HTTP 200 mais que le header `x-gouv-app-id` est absent ou vide, THEN THE Handshake_Service SHALL considérer le handshake comme échoué et déclencher une nouvelle tentative dans la limite de 3 tentatives maximum.
6. WHEN une requête API est envoyée après le handshake, THE France_Hunter SHALL inclure les headers `x-gouv-app-id` et `x-gouv-web: fr.gouv.consulat`.
7. WHEN une requête POST ou PUT sensible est envoyée, THE France_Hunter SHALL inclure le header `x-csrf-token` avec la valeur du handshake courant.
8. IF une réponse API renvoie le statut HTTP 418, THEN THE France_Hunter SHALL considérer le handshake comme absent ou invalide et relancer le Handshake_Service avant de réessayer la requête d'origine, dans la limite de 3 tentatives de handshake maximum.
9. IF le handshake échoue après 3 tentatives, THEN THE France_Hunter SHALL enregistrer une erreur préfixée `[franceHunter]` incluant le contexte (identifiant du Job et cause de l'échec) et abandonner le traitement du Job courant en conservant l'état du Job inchangé.
10. WHILE des tentatives de handshake successives sont exécutées, THE Handshake_Service SHALL appliquer un délai de backoff exponentiel initialisé à 2 000 ms et doublé à chaque nouvelle tentative.

### Requirement 2: Résolution du consulat via slug

**User Story:** En tant qu'opérateur, je veux résoudre dynamiquement un consulat à partir de son slug d'URL, afin de généraliser le hunter au-delà de Kinshasa sans identifiant codé en dur.

#### Acceptance Criteria

1. WHEN un Job spécifie un slug de consulat, THE France_Hunter SHALL appeler `GET /team/slug/{slug}?lang=fr` avec un timeout maximal de 30 000 ms et un maximum de 3 tentatives avec backoff exponentiel (base 2 000 ms, doublé à chaque tentative) en cas d'échec réseau ou de réponse de statut serveur (>= 500).
2. WHEN la réponse de résolution est reçue avec le statut HTTP 200, THE France_Hunter SHALL valider que le champ `teamId` est présent et est une chaîne non vide avant utilisation.
3. IF la résolution du slug ne retourne pas de `teamId` valide (champ absent, vide, ou statut HTTP >= 400), THEN THE France_Hunter SHALL enregistrer une erreur préfixée `[franceHunter]` incluant le slug concerné et abandonner le traitement du Job courant en conservant l'état du Job inchangé.
4. THE France_Hunter SHALL utiliser le `teamId` résolu pour toutes les requêtes ultérieures relatives au consulat pendant toute la durée du traitement du Job.

### Requirement 3: Résolution Turnstile

**User Story:** En tant qu'opérateur, je veux que le hunter résolve le captcha Cloudflare Turnstile via CapSolver, afin de franchir la protection anti-bot du portail.

#### Acceptance Criteria

1. WHEN un token Turnstile est requis, THE Turnstile_Solver SHALL invoquer la fonction `solveTurnstileToken` de `src/capsolver-turnstile.ts` avec la sitekey `0x4AAAAAAAc-bWzy0zJTmAqs` et un timeout maximal de 30 000 ms.
2. WHEN un token Turnstile non vide est obtenu, THE France_Hunter SHALL transmettre ce token dans le champ `captcha` du corps de la requête concernée.
3. THE France_Hunter SHALL résoudre exactement un token Turnstile distinct pour l'ouverture de session et exactement un autre token Turnstile distinct pour le booking final.
4. IF la résolution Turnstile échoue après 3 tentatives (base de backoff 2 000 ms, doublée à chaque tentative), THEN THE France_Hunter SHALL enregistrer une erreur préfixée `[franceHunter]` incluant le contexte (étape concernée et cause de l'échec) et abandonner l'étape en cours en conservant l'état de session inchangé.

### Requirement 4: Ouverture de session de réservation

**User Story:** En tant qu'opérateur, je veux ouvrir une session de réservation valide, afin de pouvoir scanner les disponibilités et réserver.

#### Acceptance Criteria

1. WHEN un token Turnstile de session est disponible, THE France_Hunter SHALL envoyer `POST /team/{teamId}/reservations-session` avec le corps contenant `standaloneServiceName`, `sessionId` et `captcha`, le header `x-csrf-token`, un timeout maximal de 30 000 ms et un maximum de 3 tentatives avec backoff exponentiel (base 2 000 ms) en cas d'échec réseau ou de réponse de statut serveur (>= 500).
2. WHEN la réponse d'ouverture de session est reçue avec le statut HTTP 200, THE France_Hunter SHALL valider que le `sessionId` retourné est présent et est une chaîne non vide avant de poursuivre.
3. WHEN une nouvelle valeur de handshake est fournie dans la réponse de session, THE France_Hunter SHALL mettre à jour la valeur `x-csrf-token` utilisée pour les requêtes suivantes.
4. THE Reservation_Session SHALL être considérée valide pendant exactement 30 minutes à compter de son ouverture.
5. IF l'ouverture de session ne retourne pas de `sessionId` valide (champ absent, vide, ou statut HTTP >= 400), THEN THE France_Hunter SHALL enregistrer une erreur préfixée `[franceHunter]` indiquant la cause et réessayer dans la limite de 3 tentatives maximum avec backoff exponentiel (base 2 000 ms).
6. IF les 3 tentatives d'ouverture de session échouent, THEN THE France_Hunter SHALL enregistrer une erreur préfixée `[franceHunter]` et abandonner le traitement du Job courant en conservant l'état du Job inchangé.

### Requirement 5: Gestion du TTL de session

**User Story:** En tant qu'opérateur, je veux que le hunter renouvelle la session avant son expiration, afin de maintenir un scan continu sans interruption due à l'expiration.

#### Acceptance Criteria

1. WHILE une Reservation_Session est active, THE France_Hunter SHALL suivre le temps écoulé depuis l'ouverture de la session, le Session_TTL étant de 30 minutes exactement.
2. WHEN le temps écoulé depuis l'ouverture de la Reservation_Session atteint 25 minutes, THE France_Hunter SHALL ouvrir une nouvelle Reservation_Session (impliquant une résolution Turnstile d'ouverture) et maintenir la session courante active jusqu'à confirmation d'ouverture de la nouvelle session, de sorte que le chevauchement n'interrompe pas le scan en cours.
3. IF une requête retourne le statut HTTP 404 avec le message `SESSION_ERROR`, THEN THE France_Hunter SHALL traiter la session comme expirée et relancer le bootstrap complet (handshake, résolution Turnstile d'ouverture, ouverture de session) dans la limite de 3 tentatives.
4. WHEN une nouvelle Reservation_Session est ouverte avec succès pour cause de renouvellement, THE France_Hunter SHALL reprendre le scan avec le nouveau `sessionId` sans perte du contexte de scan (Scan_Window et Excluded_Days courants).
5. IF le renouvellement de session échoue après 3 tentatives, THEN THE France_Hunter SHALL enregistrer une erreur préfixée `[franceHunter]` indiquant la cause et abandonner le traitement du Job courant.

### Requirement 6: Détermination de la fenêtre de scan

**User Story:** En tant qu'opérateur, je veux que le hunter détermine la fenêtre officielle de scan, afin de ne balayer que les dates pertinentes.

#### Acceptance Criteria

1. WHEN un scan démarre, THE Scanner SHALL appeler `GET /team/{teamId}/reservations/get-interval?serviceId={serviceId}` en utilisant l'identifiant `_id` du service, avec un timeout maximal de 30 000 ms et un maximum de 3 tentatives avec backoff exponentiel (base 2 000 ms) en cas d'échec réseau ou de réponse de statut serveur (>= 500).
2. WHEN la réponse `get-interval` est reçue avec le statut HTTP 200, THE Scanner SHALL valider que les champs `start` et `end` sont présents, non vides et au format `YYYY-MM-DD`, avec `start` inférieur ou égal à `end`.
3. THE Scanner SHALL définir la Scan_Window comme l'intervalle inclusif entre `start` et `end`.
4. IF la réponse `get-interval` ne contient pas de `start` et `end` valides (champs absents, vides, format invalide, `start` postérieur à `end`, ou statut HTTP >= 400), THEN THE Scanner SHALL enregistrer une erreur préfixée `[franceHunter]` indiquant la cause et interrompre le scan courant en conservant l'état de session inchangé.

### Requirement 7: Détermination des jours exclus

**User Story:** En tant qu'opérateur, je veux que le hunter identifie les jours fermés, afin de réduire le nombre de requêtes de disponibilité.

#### Acceptance Criteria

1. WHEN la Scan_Window est déterminée, THE Scanner SHALL envoyer `POST /team/{teamId}/reservations/exclude-days` avec le corps `{session: {[serviceId]: true}, sessionId}`, le header `x-csrf-token`, un timeout maximal de 30 000 ms et un maximum de 3 tentatives avec backoff exponentiel (base 2 000 ms) en cas d'échec réseau ou de réponse de statut serveur (>= 500).
2. WHEN la réponse `exclude-days` est reçue avec le statut HTTP 200, THE Scanner SHALL valider que la réponse est un tableau dont chaque élément est une date au format `YYYY-MM-DD`.
3. THE Scanner SHALL constituer l'ensemble des Excluded_Days à partir des éléments valides de la réponse.
4. THE Scanner SHALL calculer les Scannable_Day comme les dates appartenant à la Scan_Window et n'appartenant pas aux Excluded_Days.
5. IF la réponse `exclude-days` n'est pas un tableau valide de dates ou retourne un statut HTTP >= 400 (hors 404 `SESSION_ERROR` traité par le Requirement 5), THEN THE Scanner SHALL enregistrer une erreur préfixée `[franceHunter]` indiquant la cause et interrompre le scan courant en conservant l'état de session inchangé.

### Requirement 8: Scan des disponibilités par jour

**User Story:** En tant qu'opérateur, je veux que le hunter récupère les créneaux jour par jour sur les jours ouvrables, afin de détecter les disponibilités réelles.

#### Acceptance Criteria

1. WHEN les Scannable_Day sont déterminés, THE Scanner SHALL appeler `GET /team/{teamId}/reservations/availability` pour chaque Scannable_Day avec les paramètres `name` (nom textuel complet du service), `date` (format `YYYY-MM-DD`), `places=1`, `matching=` (vide), `maxCapacity=1` et `sessionId`, en respectant un timeout maximal de 30 000 ms et un maximum de 3 tentatives avec backoff exponentiel (base 2 000 ms) par jour en cas d'échec réseau ou de réponse de statut serveur (>= 500).
2. WHEN une Availability_Response est reçue avec le statut HTTP 200 et un tableau non vide, THE Scanner SHALL interpréter chaque élément comme un Slot `{time: "HH:MM", rate: "0.00", capacity: N}` où `time` est au format `HH:MM`, `rate` est une chaîne décimale à deux décimales et `capacity` est un entier positif.
3. WHEN une Availability_Response est reçue avec le statut HTTP 200 et un tableau vide `[]`, THE Scanner SHALL interpréter ce résultat comme « agenda vide, aucun créneau ce jour » (cas normal) sans le traiter comme une erreur.
4. THE Scanner SHALL utiliser le nom textuel complet du service dans le paramètre `name` de `availability` et l'identifiant `_id` du service dans le paramètre `serviceId` de `get-interval`.
5. IF une Availability_Response retourne un statut HTTP différent de 200 (hors 404 `SESSION_ERROR` traité par le Requirement 5) ou un corps non conforme au DTO attendu après épuisement des 3 tentatives, THEN THE Scanner SHALL enregistrer une erreur préfixée `[franceHunter]` incluant le jour concerné et poursuivre le scan des jours restants sans interrompre le scan global.

### Requirement 9: Détection de publication de créneaux

**User Story:** En tant qu'opérateur, je veux que le hunter détecte l'apparition de nouveaux créneaux, afin de déclencher immédiatement une réservation.

#### Acceptance Criteria

1. WHEN une Availability_Response non vide (au moins un Slot) est reçue pour un Scannable_Day, THE France_Hunter SHALL signaler une Slot_Publication pour ce jour.
2. WHEN l'ensemble des Excluded_Days se rétracte par rapport au scan précédent en révélant au moins un jour ouvrable supplémentaire, THE France_Hunter SHALL signaler une Slot_Publication.
3. WHEN une Slot_Publication est signalée pour un Job avec réservation automatique activée, THE France_Hunter SHALL déclencher le Booking_Flow pour le premier Slot correspondant aux critères du Job, dans un délai maximal de 30 000 ms après la détection.
4. WHILE aucune Slot_Publication n'est détectée, THE France_Hunter SHALL poursuivre le polling selon l'intervalle de scan configuré, en appliquant un jitter de ±20 % sur cet intervalle.

### Requirement 10: Booking multistep

**User Story:** En tant qu'opérateur, je veux que le hunter complète le formulaire multistep et finalise la réservation, afin de réserver un créneau détecté.

#### Acceptance Criteria

1. WHEN un Booking_Flow démarre, THE France_Hunter SHALL persister chaque étape du formulaire via `POST /team/{teamId}/reservations-session/{sessionId}/update-step-value` avec le corps `{key, value, stepIndex}`, en respectant un timeout de 30 secondes par requête et un maximum de 3 tentatives avec backoff exponentiel (base 2 secondes) en cas d'échec réseau ou de réponse de statut serveur (>= 500).
2. THE France_Hunter SHALL exécuter les étapes du parcours Visas dans l'ordre exact welcome, services, important-info, slots, contact, motif, confirmation, en persistant chaque étape avec `stepIndex` incrémenté de 0 à 6 correspondant à cet ordre.
3. IF une étape de persistance renvoie un statut d'erreur (>= 400) ou échoue après le maximum de tentatives, THEN THE France_Hunter SHALL interrompre le Booking_Flow sans envoyer la réservation finale et enregistrer une erreur préfixée `[franceHunter]` identifiant l'étape ayant échoué et son `stepIndex`.
4. WHEN l'étape de contact est renseignée, THE France_Hunter SHALL fournir les champs non vides `firstname` (longueur 1 à 100 caractères), `lastname` (longueur 1 à 100 caractères), `email` (contenant un `@` et un domaine), `mobile` (longueur 6 à 20 caractères) et `birthdate` au format `{month, day, year}` où `month` est un entier de 0 à 11 (indexé à partir de 0, convention dayjs), `day` un entier de 1 à 31 et `year` un entier de 1900 à l'année courante.
5. IF un champ requis de l'étape de contact est manquant, vide ou hors des bornes définies, THEN THE France_Hunter SHALL interrompre le Booking_Flow sans envoyer la réservation finale et enregistrer une erreur préfixée `[franceHunter]` indiquant le champ invalide.
6. WHEN l'étape motif est renseignée, THE France_Hunter SHALL fournir le custom field `{key: "54cfd964c63f3386", values: [motif]}` où `motif` appartient exactement à la liste autorisée : Regroupement familial, Visa retour, Reunification familial, Stagiaire associé, Conjoint de Français - Installation, Etudiant, Autres.
7. IF le `motif` fourni n'appartient pas à la liste autorisée, THEN THE France_Hunter SHALL interrompre le Booking_Flow sans envoyer la réservation finale et enregistrer une erreur préfixée `[franceHunter]` indiquant le motif rejeté.
8. WHEN un Slot est sélectionné, THE France_Hunter SHALL calculer le `slotValue` par `slugify("slot-" + serviceName + "-" + ISOdate + "-" + time).toLowerCase()` et fournir un objet `slotsToKeep` contenant `slotValue`, `date` au format `YYYY-MM-DDTHH:MM:00`, `time` et `serviceName`.
9. WHEN toutes les étapes sont persistées avec succès et qu'un token Turnstile de booking est disponible, THE France_Hunter SHALL envoyer `POST /team/{teamId}/reservations/family` avec le corps `{reservations, language, captcha, sessionId}` où `language` vaut `"fr"`, et le header `x-csrf-token`, en respectant un timeout de 30 secondes.
10. THE France_Hunter SHALL construire `reservations` avec la structure `{mainUser, secondaryUsers, sessionId, team}` où `mainUser.services` contient `customFields` et `slotsToKeep`, et où `secondaryUsers` est une collection vide (reservation_people_max = 1 pour le parcours Visas).
11. WHEN la réponse de booking est reçue avec un statut de succès, THE France_Hunter SHALL valider la présence d'un champ `data.qrCodes` non vide et enregistrer la confirmation ; IF `data.qrCodes` est absent ou vide, THEN THE France_Hunter SHALL traiter le booking comme échoué.
12. IF le booking échoue, THEN THE France_Hunter SHALL enregistrer une erreur préfixée `[franceHunter]` incluant le contexte de l'échec (condition déclenchante), le résultat de l'étape ayant échoué, et SHALL préserver l'état de session sans effectuer de nouvelle tentative automatique de réservation finale.

### Requirement 11: Anti-détection

**User Story:** En tant qu'opérateur, je veux que le hunter se comporte comme un humain légitime, afin d'éviter la détection et le blocage.

#### Acceptance Criteria

1. THE France_Hunter SHALL utiliser un User-Agent réaliste et identique pour toute la durée d'une même session.
2. WHEN plusieurs requêtes sont enchaînées, THE France_Hunter SHALL introduire entre deux requêtes consécutives un délai aléatoire de base 2 000 ms avec un jitter de ±500 ms.
3. THE France_Hunter SHALL router ses requêtes via le Proxy_Pool résidentiel avec une IP géolocalisée cohérente avec la timezone `Europe/Paris`.
4. WHILE une session complète est active, THE France_Hunter SHALL conserver la même IP proxy et ne changer d'IP qu'entre deux sessions distinctes ou après un blocage.
5. IF le Rate_Limit_Header `x-gouv-limit` indique une limite atteinte, THEN THE France_Hunter SHALL appliquer un backoff exponentiel initialisé à 2 000 ms et doublé à chaque nouvelle requête concernée, dans la limite de 3 tentatives, avant la requête suivante.
6. WHEN une requête réseau est effectuée, THE France_Hunter SHALL appliquer un timeout de 30 000 ms et un maximum de 3 tentatives avec backoff exponentiel (base 2 000 ms, doublé à chaque tentative).

### Requirement 12: Sécurité et validation

**User Story:** En tant que responsable sécurité, je veux que le hunter ne stocke aucun secret en dur et valide toutes les réponses externes, afin de protéger les données et la fiabilité.

#### Acceptance Criteria

1. THE France_Hunter SHALL lire toutes les clés et secrets depuis les variables d'environnement via `.env` sans aucune valeur codée en dur dans le code source.
2. WHEN une réponse d'API externe est reçue, THE France_Hunter SHALL valider sa structure (présence et type des champs attendus) avant tout traitement, et IF la structure est invalide, THEN THE France_Hunter SHALL rejeter la réponse et enregistrer une erreur préfixée `[franceHunter]` sans propager de donnée non validée.
3. WHEN un message de log est émis, THE France_Hunter SHALL préfixer le message par `[franceHunter]`.
4. WHEN une donnée sensible (token, clé, cookie, `x-csrf-token`, PII) doit être journalisée, THE France_Hunter SHALL masquer la valeur et n'en journaliser qu'une forme tronquée (au plus 8 premiers caractères suivis de `...`) ou uniquement le nom de la clé.
5. WHEN un appel réseau est effectué, THE France_Hunter SHALL encadrer l'appel d'un `try/catch` produisant un message d'erreur contextuel préfixé `[franceHunter]`.

### Requirement 13: Intégration au dispatcher

**User Story:** En tant qu'opérateur, je veux que le hunter France soit routé par le dispatcher central, afin qu'il s'exécute pour les Jobs de destination France.

#### Acceptance Criteria

1. WHEN le Dispatcher traite un Job dont `destination` vaut `france`, THE Dispatcher SHALL invoquer la fonction d'exécution du France_Hunter.
2. WHEN le France_Hunter termine le traitement d'un Job (succès ou échec), THE France_Hunter SHALL retourner au Dispatcher un résultat structuré indiquant l'issue (statut de succès ou d'échec) et le contexte associé.
3. THE France_Hunter SHALL exposer une fonction d'exécution avec un type de retour explicite conforme à l'interface de résultat des autres hunters, sans usage de `any`.

### Requirement 14: Support multi-consulat et multi-service

**User Story:** En tant qu'opérateur, je veux configurer le consulat et le service cibles par Job, afin de traiter plusieurs dossiers et destinations.

#### Acceptance Criteria

1. WHERE un Job fournit un slug de consulat, THE France_Hunter SHALL résoudre et cibler ce consulat sans identifiant codé en dur.
2. WHERE un Job fournit un service cible, THE France_Hunter SHALL utiliser l'`_id` du service pour `get-interval` et le nom textuel complet du service pour `availability`, sans mélange entre les deux identifiants.
3. THE France_Hunter SHALL traiter chaque Job avec une Reservation_Session isolée, sans partage de `sessionId`, de `x-csrf-token` ni d'IP proxy entre deux Jobs distincts.
