# Spain — forensic publication 2026-08-31 03:13 (analyse en cours)

Publication de 26 créneaux (durée <1 min), 13 dossiers actifs, 3 bookings réussis.
Log source: `artifacts/slot-hunter/src/dianos.txt`. Chronologie triée ms-par-ms
reconstruite dans `artifacts/slot-hunter/src/chronologie.txt` (686 lignes, actions
normalisées + légende).

## Instant de publication ancré
Première détection `scan=found` = **MAKOLA MALUNGU MIR à 03:13:29.537**. C'est la
ligne de partage "avant / après publication".

Détections found (les 4 seuls workers qui ont VU les créneaux) :
- 03:13:29.537 MAKOLA   → book 2026-10-06 11:30
- 03:13:35.177 ISSEKAMA → book 2026-10-06 08:45
- 03:13:43.742 PIVALI   → book 2026-10-06 09:15
- 03:13:46.716 MAYALIWA → book 2026-10-06 09:00 (signin FAILED = mauvais mot de passe, pas race perdue)
Résultat: 3 BOOKED (MAKOLA, ISSEKAMA, PIVALI), 1 signin_failed (MAYALIWA).

## DÉCOUVERTE CLÉ #1 — état des 12 workers AVANT la publication
Sur les 12 workers actifs avant 03:13:29.537 :
- **12/12 en `scan=not_found` SAIN** (agenda vide = normal, pas encore de créneaux)
- **0/12 en erreur** : zéro session_dead, zéro proxy_error, zéro 0B, zéro err réseau, zéro rotation

=> La cause des échecs n'est PAS des erreurs pré-existantes. Hypothèse "session_dead/0B
avant publication" ÉLIMINÉE. Les session_dead observés (MOKOBI 03:13:50, levis 03:15:11)
sont POSTÉRIEURS à la publication → ce sont des conséquences, pas des causes.

## DÉCOUVERTE CLÉ #2 — dispersion des derniers scans avant publi
À l'instant T (03:13:29.5), le dernier scan de chaque worker datait de -11s à -43s :
levis -43.5s, KAKA -35.7s, tabitha -35.3s, MAPANZOLA -32.5s, BILADY -30.3s,
MAKOLA -27.9s, ISSEKAMA -25.0s, PIVALI -17.6s, MOKOBI -16.6s, MAYALIWA -14.2s,
diana -13.3s, Mr Nkumu -11.5s.
Écart énorme et très dispersé → les workers ne sont PAS synchronisés sur leur cycle.

## Hypothèses ÉLIMINÉES (ne pas y revenir)
- Cycle datetime-direct vs refreshSessionAndScan : mauvaise piste. Kinshasa a l'agenda
  VIDE tant qu'il n'y a pas de créneau → le cycle DOIT repasser par getagendas/ à chaque
  tour (sinon aveugle à la publication). scanDatetimeDirect fige l'agenda du démarrage =
  bug. Fix tenté puis ANNULÉ (fichier spain-dossier-worker.ts remis à HEAD).
- "Serveur bafouille 0B sous charge" comme cause première : pas soutenu par les faits
  avant publication (0 erreur). À ne rétablir que si prouvé après-coup.

## Méthode validée
Reconstruire la chronologie factuelle triée AVANT toute hypothèse. L'user pilote
l'analyse par questions ciblées ; ne pas spéculer ni coder tant que la cause n'est pas
prouvée par le log.

## À creuser (prochaine étape)
Pourquoi seuls 4/12 workers ont vu les créneaux alors que tous étaient sains ? Le
différenciateur est dans la fenêtre 03:13:29 → 03:14:00 (timing d'entrée dans le cycle
au moment T, pas un état d'erreur préalable).


## Bundle Bookitit — contraintes de cycle confirmées (2026-08-31)
Source: `artifacts/slot-hunter/debug_dumps/bookitit-network-capture-*.json` (bundle JS + réseau réel) et `bundle-analysis/bundle.js`.

Faits établis (pas d'hypothèse) :
- Le SEUL passage qui révèle les créneaux = `getagendas/` puis `datetime/`. `history/` ne
  sonde PAS la dispo (confirmé par user + bundle).
- On ne peut PAS appeler `datetime/` sans passer par `getagendas/` avant.
- Le portail EXIGE le cycle complet gettoken→POST token→main→getservices→getagendas→datetime
  à chaque cycle de scan HTTP. Pas de raccourci "getagendas seul".
- Modèles Backbone: `Agendas` (url += "getagendas/") et Datetime (url += "datetime/") ont
  un `sync` surchargé en JSONP ("pass over Same Origin Policy").
- **Méta-refresh page = `<meta http-equiv="refresh" content="360">`** : le front légitime
  recharge TOUTE la page toutes les 360s (refait le pèlerinage complet). AUCUN polling
  rapide de datetime côté front. `refreshSlots` ne se déclenche que sur action user
  (`change #idSelNumberOfPeopleDatime`). => le concurrent rapide n'utilise donc PAS le
  front tel quel, il a son propre client HTTP.
- Navigation Backbone (`Backbone.history.navigate('agendas'/'services')`) = routage
  client-side (hashchange) qui réaffiche une vue et redéclenche ses JSONP, en réutilisant
  le PHPSESSID (POST token fait une seule fois au chargement de page). C'est le "naviguer
  main<->history sans re-token" décrit par user : le token n'est pas rejoué tant que la
  session vit ; seuls les JSONP (getagendas/datetime) sont refaits.

Règle session (navigateur, décrite par user) :
- session vivante + CF valide → naviguer sans rejouer token.
- session morte + CF valide → refaire welcome→POST token→main→…
- CF mort → re-résoudre le challenge.

## Direction stratégie (validée avec user, pas encore codée)
Rendre les workers VRAIMENT synchrones (pas "parallèle" en apparence) :
- Grille d'horloge murale absolue : chaque worker dort jusqu'au prochain tick
  `ceil(now/TICK)*TICK` (pas sleep relatif). Aligne tous les workers sur la même seconde,
  sans coordination (l'horloge = barrière commune). Cible fenêtre HH:13→HH:17.
- Solver = 1x/fenêtre (cache), donc le scan récurrent est "léger" au sens session-réutilisée
  MAIS reste le cycle token→…→datetime imposé par le portail (mesurer sa durée réelle pour
  fixer TICK réaliste, probablement > 1s).
- Superviseur de récupération: worker tombé (504/0B/proxy_error/session_dead) passe en
  RECOVERING, se répare en tâche de fond SANS bloquer les autres, rejoint la grille au tick
  suivant.
- Détection découplée du booking (MODE RACE renforcé): 1er worker qui voit l'agenda actif
  broadcast → tous foncent booker sans attendre leur propre getagendas.
Objectif: sur 13 dossiers, passer de 3 bookings à ~7 (détection quasi simultanée + booking
en rafale). Avantage prouvé: même désynchro, on détecte pile à la seconde de publication.


## CORRECTION CRITIQUE (2026-08-31) — getagendas = 1x par PHPSESSID
User rappelle la règle §9 : `getagendas/` ne peut être appelé qu'UNE FOIS par PHPSESSID.
Le rappeler sur le même PHPSESSID => le portail exige le renvoi du formulaire (repost,
"confirmer le nouvel envoi du formulaire" sur navigateur).

=> Mon idée "session chaude réutilisée, re-scanner sans re-token" est FAUSSE. Chaque
nouveau scan EXIGE un PHPSESSID neuf, donc le cycle complet POST token→main→getservices→
getagendas→datetime à chaque tour. Seul le cf_clearance (solver) est réutilisable en cache
sur toute la fenêtre.

CONSÉQUENCE sur la stratégie de grille synchrone :
- On NE PEUT PAS scanner plus vite qu'un cycle complet (~4-5s observé). Le TICK ne peut
  pas être < durée d'un cycle. C'est le plancher physique imposé par le portail, pas un
  défaut de code.
- La synchro d'horloge murale reste valable MAIS le tick = durée cycle complet (ex 5s),
  pas 1s. L'alignement sert à ce que TOUS les workers finissent leur cycle et regardent
  datetime dans la MÊME fenêtre, pas à scanner plus souvent.
- Piste alternative à explorer : préparer le PHPSESSID+agenda À L'AVANCE (pré-armer le
  cycle jusqu'à juste avant datetime), de sorte qu'au tick de publication il ne reste QUE
  l'appel datetime (rapide) à lancer. MAIS attention: getagendas 1x/PHPSESSID => si on
  pré-arme getagendas quand l'agenda est encore VIDE, on obtient agendaId="" et il faut un
  nouveau PHPSESSID pour re-tenter. Donc pré-armer ne marche que si getagendas renvoie déjà
  l'agenda actif — impossible avant publication. À creuser avec user.


## Stratégie FINALE validée avec user (2026-08-31) — grille 10s + preflight
Faits calage :
- Cycle complet SANS créneau = ~2.7s moyenne. Fenêtre HH:05→HH:25. Créneaux apparaissent
  HH:13→HH:17 (jusqu'à 16-17 certains dimanches). Agenda connu d'avance mais NON servi tant
  que 0 créneau (absence = signal "pas de créneau").
- TICK = 10s (comme avant). Le gain n'est PAS la fréquence mais que le MAX de workers voient
  à l'instant T aligné → booking en rafale → taux réussite élevé.

Architecture:
- HH:05→HH:13 = PHASE PREFLIGHT (préparation, pas chasse): vérifier proxy vivant + cf valide
  + session prête pour CHAQUE worker. Réparer AVANT HH:13. Contrainte: proxy mort + re-solve
  sur nouvelle IP ≈ 66s → la vérif doit se faire assez tôt (~HH:11-12) pour finir à temps.
- HH:13→HH:25 = PHASE CHASSE: grille horloge murale alignée `ceil(now/10000)*10000`. Tous
  scannent au même front (HH:13:00, :10, :20…). Worker tombé → RECOVERING async → rejoint au
  tick suivant sans bloquer les autres.
- Machine à états worker: ARMED / SCANNING / RECOVERING. Boucles autonomes (pas de Promise.all
  bloquant). Tri strict des échecs: proxy mort→rotation IP | 504→retry court puis rotation |
  datetime 0B tous mois + agenda actif→session_dead→nouveau PHPSESSID | widget 403→CF re-solve |
  agenda vide→NORMAL (pas erreur, reste ARMED).

## PISTE MAJEURE à vérifier — changer d'IP SANS re-solve (coût proxy mort 66s→~3s)
User observe: sur navigateur il change d'IP mais on lui redemande RAREMENT le challenge.
Explication: cf_clearance n'est pas lié qu'à l'IP mais surtout au fingerprint TLS(JA3/JA4)+
HTTP/2 + UA-CH. Tant que le fingerprint reste cohérent (vrai Chrome) et l'IP de bonne
réputation, CF tolère le changement d'IP. NOUS on est re-challengés car JA3 impit ≠ JA3 du
solve CapSolver (bug déjà connu: TLS mismatch→0B, fix solveViaImpit) + IP proxy réputation
faible.
=> SI on garde le MÊME impit (JA3 constant) en changeant juste l'exit IP du proxy, le
cf_clearance pourrait survivre → réparer un proxy mort coûterait ~3s au lieu de 66s.
À PROUVER: script test-cf-clearance-persistence.ts teste déjà la survie du clearance
cross-impit / cross-IP. Mémoire existante dit "cf_clearance lié à l'instance impit" → à
reconfirmer: survit-il à un changement d'IP proxy sur le MÊME impit ? Réponse = décide si
le preflight peut réparer vite.


## PROUVÉ (2026-08-31) — cf_clearance lié à l'EXIT IP, PAS à l'impit
Test: `artifacts/slot-hunter/src/scripts/test-cf-ip-change-persistence.ts` (Kinshasa,
proxies data(7).csv es.decodo.com). Solve sur IP-A puis 3 sondes GET widget:
- Phase 2 (MÊME impit, IP-A)     → ✅ OK 200 (654ms)
- Phase 3 (impit NEUF, IP-B)     → ❌ CF CHALLENGE 403 (6228B)
- Phase 4 (impit NEUF, IP-A)     → ✅ OK 200 (2153ms)

CONCLUSIONS (prouvées, pas hypothèse):
1. cf_clearance N'EST PAS lié à l'instance impit → Phase 4 (impit neuf, même IP) marche.
   Corrige l'ancienne note "cf_clearance lié à l'instance impit" : depuis le fix solveViaImpit
   (createTask AntiCloudflareTask WITH html + userAgent, cf lié à la TLS impit chrome), le
   clearance est transférable entre impits chrome (JA3 déterministe identique).
2. cf_clearance EST lié à l'EXIT IP → Phase 3 (seul changement = IP) casse en 403.
   => Changer d'IP = re-solve OBLIGATOIRE (~28s ici, jusqu'à ~66s sous charge). Pas de contournement.

Réponse à "pourquoi le navigateur change d'IP sans re-challenge": le navigateur garde en
général la MÊME IP (même WiFi) ou une IP résidentielle de très bonne réputation. Decodo =
IP différente par port, sans historique → CF re-challenge systématiquement.

## IMPACT STRATÉGIE — sur-provisionnement obligatoire
Puisque réparer un proxy mort = re-solve (~28-66s), on NE PEUT PAS réparer dans l'urgence à
HH:12:5x. Solution: pendant preflight HH:05→HH:13, maintenir un POOL DE SESSIONS DE RÉSERVE
déjà solvées (chacune sur sa propre IP). Worker mort → swap instantané vers une session de
réserve prête (~0s) ; le re-solve pour reconstituer la réserve se fait en tâche de fond
APRÈS HH:13. Dimensionnement réserve: prévoir marge (ex 13 actifs + N réserve selon taux de
mortalité proxy observé).


## OPTIMISATION — arrêt anticipé si agenda toujours vide (économie GB proxy)
Question user: fenêtre expire HH:25, mais si à HH:17-18 l'agenda est TOUJOURS vide,
faut-il continuer à scanner et gaspiller le GB de trafic proxy ?

Fait: les publications observées tombent HH:13→HH:17 (parfois HH:16-17 le dimanche).
Au-delà de ~HH:17-18, proba de publication très faible.

Coût du gaspillage: chaque cycle sans créneau = ~2.7s + /main/ ~121-124kB PAR worker.
Avec 13 workers × tick 10s de HH:18 à HH:25 (7 min = 42 ticks) = 13×42×~124kB ≈ 68 MB
gaspillés par jour sans publication tardive. Non négligeable sur un pool proxy facturé au GB.

DÉCISION À TRANCHER (options):
- Option A (agressif éco): arrêt du scan à HH:18 si agenda resté vide sur toute la fenêtre
  HH:13→HH:18. Risque: rater une publication très tardive (rare mais possible dimanche).
- Option B (prudent): continuer jusqu'à HH:25 (comportement actuel). Zéro risque de rater,
  coût GB max.
- Option C (adaptatif, recommandé): scan plein tarif HH:13→HH:17, puis au-delà de HH:17 si
  toujours vide, RALENTIR la cadence (ex tick 30-60s au lieu de 10s) jusqu'à HH:25 au lieu
  d'arrêter net. Garde une couverture des publications tardives à coût réduit (~1/3 à 1/6 du GB).
  Cutoff configurable via env (SPAIN_LATE_WINDOW_START_MIN=17, SPAIN_LATE_TICK_MS=30000).

DÉCISION TRANCHÉE (user 2026-08-31): Option C retenue, tick lent = **60s**.
- HH:13→HH:17 : grille pleine 10s (phase chasse).
- HH:17→HH:25 : si agenda resté vide sur toute la phase chasse, RALENTIR à tick 60s
  (au lieu d'arrêter). Couvre les publications tardives (dimanche HH:16-17) à ~1/6 du GB.
- Env: SPAIN_LATE_WINDOW_START_MIN=17, SPAIN_LATE_TICK_MS=60000.
- Note: si un créneau EST détecté puis épuisé, on reste en cadence pleine (annulations
  possibles) — le ralentissement ne s'active que si RIEN n'est jamais apparu.
