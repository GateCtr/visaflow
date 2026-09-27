---
name: Spain système éclaireur — partage de créneaux + parallélisme multi-IP
description: Preuves mesurées (Cuba/São Paulo, capsolver-residential) qui fondent le système éclaireur/meute Espagne — lock signin/ par IP, chemin court sans main/services/agendas, décorrélation getsigninfields/signin, partage Redis validé 3/3.
---

## Contexte

Investigation menée sur le portail Bookitit (citaconsular.es) en mode `capsolver-residential`,
via le vrai worker `runDossierWorker` et des scripts de test dédiés. Objectif : savoir si un
modèle **éclaireur → meute** (une sentinelle détecte les créneaux et les partage, des workers
consommateurs bookent directement) est viable, et à quelles conditions.

Tous les tests utilisent des identifiants factices → `signin/` renvoie
`{"Client":{"errors":[…"Usuario o contraseña incorrectos"…]}}` (raw ≈ 236B). Cette **erreur
métier = preuve que le chemin `signin/` a abouti** (le portail a traité la requête). `signin/`
à 0B = requête rejetée/non traitée.

## Faits confirmés (mesurés)

### 1. Le lock serveur `signin/` est PAR IP / cf_clearance — pas par agenda ni par créneau

- **Même IP + même cf_clearance partagés** entre N dossiers (via `cloneSpainCfSessionForDossier`,
  même en donnant un `_ownImpit` dédié par dossier) : **1 seul `signin/` sur 4 aboutit** par salve.
  Les 3 autres → `signin/` 0B, quel que soit le créneau visé (testé avec créneaux DISTINCTS à
  freeSlots≥2, donc sans collision possible).
- **IP distinctes** (1 IP Decodo + 1 solve CF + 1 impit par worker, comme `runDossierWorker`) :
  **3-4 `signin/` aboutissent EN PARALLÈLE** sur des créneaux différents.
- Conclusion : ni l'isolation TLS/PHPSESSID, ni le créneau distinct, ni `datetime/` ne lèvent la
  contention mono-IP. **Seule 1 IP + 1 cf_clearance par dossier débloque le parallélisme.**

### 2. `getsigninfields/` n'est NI nécessaire NI suffisant pour `signin/`

- Cas vus : `getsigninfields/` = 0B ET `signin/` répond quand même une erreur métier (P4, C1/C2/C3).
- Cas inverse : `getsigninfields/` armé (13516B) MAIS `signin/` = 0B (P2).
- Les deux endpoints sont **décorrélés**. On peut sauter `getsigninfields/`.
- ⚠️ Ceci **nuance** la note `spain-getsigninfields-required.md` : cette règle valait en contexte
  mono-session ; en multi-IP/worker, `signin/` aboutit sans armement `getsigninfields/`.

### 3. Chemin court : sauter POST token / `main/` / `getservices/` / `getagendas/`

- Avec `serviceId` + `agendaId` connus (`getKnownIdsForPortal`), `datetime/` répond les MÊMES
  créneaux qu'après le cycle complet. La variante `WITH_MAIN` ne change RIEN au résultat.
- `getsigninfields/` s'arme et `signin/` aboutit sur ce chemin court.
- ~~`ensureSpainCfSession`/`initWorkerSession` conservent leur POST token + `main/` initiaux~~
  **NUANCÉ (2026-09-27, voir §8)** : POST token + `main/` ne sont PAS intrinsèques au solve CF.
  Le solve (probe + CapSolver) + GET widget (token + PHPSESSID) suffisent. `initWorkerSession`
  accepte désormais `skipTokenAndMain` pour sauter POST token + `main/` DÈS l'établissement
  (meute + éclaireur shortscan). Prouvé E2E.

### 4. Partage Redis découvreur → consommateurs : VALIDÉ 3/3

Test `test-worker-shared-slots.ts` (Cuba, Redis local, IP distinctes) :
- **Découvreur** (IP #0) : `initWorkerSession` → `getservices/`+`getagendas/`+`datetime/` → 71 créneaux
  → `publishSlotSnapshot(agendaId, serviceId, slots)`.
- **3 consommateurs** (IP #1,2,3) : session avec cf_clearance établi → **lecture du snapshot Redis**
  → `tryClaimSlot` (créneau distinct) → `getsigninfields/` + `signin/`.
- Résultat : **3/3 `signin/` = erreur métier (236B)**.

### Ce qui prime réellement une session Bookitit (prouvé, test-saopolo-datetime-hardcoded.ts)

Sur une session CLONÉE (`cloneSpainCfSessionForDossier` = cf_clearance conservé, PHPSESSID retiré) :
- un simple **GET widget** (qui pose un PHPSESSID frais via Set-Cookie) **suffit** à primer la session.
- Puis `datetime/` direct → 114 créneaux, `getsigninfields/` armé, `signin/` aboutit — le tout
  **SANS POST token, SANS `/main/`, SANS `getwidgetconfigurations/`, SANS getservices/getagendas**.

> **Ce qui prime la session = cf_clearance (établi UNE fois au solve) + GET widget (PHPSESSID frais).**
> POST token et `/main/` ne servent QU'À établir le cf_clearance initial ; ils ne sont PAS requis à
> chaque booking. `getwidgetconfigurations/`, `getservices/`, `getagendas/`, `datetime/` sont tous
> sautables pour un consommateur qui reçoit le créneau via le snapshot Redis.

### Modèle éclaireur/meute (formulation validée)

- **TOUS** les workers commencent par : solve CF (si pas de cf_clearance valide) → GET widget.
- **Éclaireur** : enchaîne `datetime/` (via getservices/getagendas ou IDs connus) pour DÉTECTER,
  publie le snapshot (`publishSlotSnapshot`) + BURST.
- **Meute** : réveillée par le BURST/snapshot → solve si nécessaire → GET widget → **SAUTE
  `datetime/`** (et getwidgetconfigurations/getservices/getagendas) → `tryClaimSlot` →
  `getsigninfields/` → `signin/` → `summary/`.

### Précisions (corrections d'extrapolations)

- **`getsigninfields/` : appelé mais NON bloquant pour la meute.** getsigninfields/ nécessite un
  `datetime/` préalable sur la même session (le serveur "sélectionne" le créneau) ; la meute ne
  faisant PAS datetime/, son getsigninfields/ renvoie **toujours 0B** — c'est NORMAL, la session
  n'est PAS morte. Prouvé E2E (test-worker-parallel meute, 2026-09-27) : la meute TENTE signin/
  malgré getsigninfields/ 0B → **236B "Usuario o contraseña incorrectos" = chemin OK**. Le
  re-cycle §9 (session morte) ne s'applique QU'AUX workers normaux (après datetime/).

## 6. IMPLÉMENTATION MODE MEUTE (2026-09-27) — validée E2E via runDossierWorker

Code prod (gated par flag, OFF par défaut → comportement historique inchangé) :
- `readSlotSnapshot(agendaId, serviceId)` (spain-redis-persistence.ts) — lecture du snapshot.
- Orchestrateur `SPAIN_MEUTE_MODE=1` : `assignRoles()` désigne 1 éclaireur/portail via
  `claimSentinelRole` (NX TTL 30min), les autres = meute. `role` passé au config worker.
- `runDossierWorker` avec `config.role==="meute"` :
  - skip initPhpState (getwidgetconfigurations/services/agendas).
  - à chaque cycle : `scanViaSnapshot` → `readSlotSnapshot` ; snapshot présent → `primeMeuteSession`
    (**GET widget SEUL** — PHPSESSID frais ; PAS de POST token, PAS de /main/) → booking direct ;
    vide → not_found → pause grille.
  - **canAttemptSignin = true pour la meute** (tente signin/ malgré getsigninfields/ 0B).
  - **skip re-cycle §9** pour la meute (gsf 0B normal, pas session morte).
  - `releaseSentinelRole` en fin de fenêtre (éclaireur) pour rotation.
- Test E2E (Cuba, Redis local, 1 éclaireur + 2 meute, IP distinctes) : éclaireur trouve 459
  créneaux + publie snapshot ; les 2 meute lisent le snapshot, SAUTENT datetime/, tentent signin/
  malgré gsf 0B → **3/3 signin/ = 236B (chemin OK)**. Fichiers test : test-worker-parallel.ts
  (TEST_MEUTE=1), test-worker-single-dossier.ts (SPAIN_WORKER_ROLE=meute).
- ⚠️ Le "court-circuit" saute getwidgetconfigurations/getservices/getagendas/datetime — TOUS
  confirmés sautables pour la meute. Ne PAS ré-ajouter getwidgetconfigurations/ (testé inutile).

### primeMeuteSession = GET widget SEUL (correction 2026-09-27)

Prouvé (mémoire fait #3) : cf_clearance (déjà établi à l'init) + GET widget (PHPSESSID frais via
Set-Cookie) SUFFISENT à primer la session. `primeMeuteSession` fait donc UNIQUEMENT le GET widget ;
srvsrc/version prennent leurs valeurs par défaut (baseHost, "4") ; hCaptcha détecté depuis
`session.prefetchedMainHtml` (capturé à l'init). PAS de POST token, PAS de /main/, PAS de
getwidgetconfigurations. Mesuré (Cuba, runDossierWorker) : mise en session meute ~0,6 s vs cycle
complet éclaireur ~8,6 s.

## 7. CHEMIN COURT ÉCLAIREUR (2026-09-27) — gated SPAIN_ECLAIREUR_SHORTSCAN=1

Problème du code prod EXISTANT : `refreshSessionAndScan` (appelé à CHAQUE cycle de scan) refait
tout — GET widget + POST token + /main/ + getwidgetconfigurations/ + getservices/ + getagendas/ +
datetime/ (~8,6 s/cycle) — alors que `scanDatetimeDirect` (datetime/ seul) existe mais n'était plus
utilisé dans la boucle. L'éclaireur ne faisait donc PAS "GET widget → datetime/" comme il le devrait.

Correction : `scanViaWidgetDatetime(session, config, tag)` dans spain-dossier-worker.ts, branché en
tête de `refreshSessionAndScan` sous flag `SPAIN_ECLAIREUR_SHORTSCAN` (OFF par défaut → cycle complet
inchangé). Quand IDs connus (`getKnownIdsForPortal`) : GET widget SEUL (PHPSESSID frais) → build ds
(srvsrc/version défaut, agendaConfirmed=false) → `scanDatetimeDirect` (datetime/ direct). Fallback
cycle complet si pas d'IDs connus / GET widget KO (retourne null).

Mesuré (Cuba, runDossierWorker, SPAIN_ECLAIREUR_SHORTSCAN=1) : cycle scan **~1,8 s** (GET widget →
datetime/ 390 créneaux → found) vs **~8,6 s** cycle complet. signin/ aboutit (236B). Gain ~6,8 s/cycle.

## 8. INIT RÉDUIT `initWorkerSession(skipTokenAndMain)` (2026-09-27) — validé E2E

Prouvé (`test-noinit-solve-widget-datetime`, puis E2E via runDossierWorker) : pour faire un solve
CF utile, on n'a besoin **ni de POST token, ni de `/main/`**. Le solve = probe (UA+Accept) +
CapSolver (html+proxy+UA) → GET widget (pose token + PHPSESSID via Set-Cookie). Les étapes POST
token (srvsrc+version) et GET `/main/` sont SÉPARÉES et supprimables ; `datetime/` +
`getsigninfields/` + `signin/` fonctionnent sans elles.

Implémentation (spain-soax-solver.ts) : `initWorkerSession(stickyProxyUrl, targetUrl, capsolverKey,
onSetCookie?, onFailure?, skipTokenAndMain = false)`. Si `skipTokenAndMain=true`, court-circuit
APRÈS le GET widget (étape 3) : construit une session courte (srvsrc=baseHost, version="4",
prefetchedMainHtml="") et retourne AVANT le POST token (étape 4). Défaut `false` → comportement
historique complet intact (prod inchangée).

Branchement (spain-dossier-worker.ts) : `initWorkerSessionWithDirectRescan(..., skipTokenAndMain=false)`
propage le flag à `initWorkerSession`. Dans `runDossierWorker`, `workerIsMeute` + `shortscanNoPhpInit`
sont calculés AVANT la boucle de session init ; `skipTokenAndMainInit = workerIsMeute ||
shortscanNoPhpInit` est passé à l'appel INITIAL uniquement. Les 3 appels recovery
(server_overload retry, session_dead réinit, rotateWorkerIp) restent en init complet car ils sont
suivis de `initPhpState` (chemin PROD non-meute/shortscan) qui a besoin de `/main/`.

Logs de preuve : `⚡ Init RÉDUIT activé (meute|shortscan) — solve + GET widget seul` (worker) +
`⚡ Init RÉDUIT — POST token + /main/ SAUTÉS (shortscan/meute)` (solver) + `✅ Session établie —
PHPSESSID ✅ | /main/ 0B`. Testé 2026-09-27 : éclaireur shortscan Cuba (found, signin 236B),
Kinshasa (datetime 0B → not_found, pas session_dead), meute parallèle 3 workers (éclaireur publie
snapshot, 2 meute lisent + SAUTENT datetime/ → 3/3 signin/ 236B). `tsc --noEmit` exit 0.

## 9. DÉTECTION hCaptcha PAR PORTAIL CONNU (2026-09-27) — corrige régression init réduit

Problème introduit par les chemins réduits (meute + éclaireur shortscan) : la détection hCaptcha
du worker repose sur `detectHcaptcha([{ text: session.prefetchedMainHtml }])` — or ces chemins
SAUTENT le GET /main/ (init réduit `skipTokenAndMain` → `prefetchedMainHtml=""`). Donc
`detectHcaptcha("")` → `present=false` → `captchaRequired=false` → **signin/ envoyé SANS gct**.
Sur Kinshasa (captcha OBLIGATOIRE, fait établi) et Cuba (captcha présent malgré
WidgetConfiguration.captcha=0), ça garantit l'échec du signin/.

Correction (option B) : flag `captchaRequired` par portail connu dans `spain-portals.ts` +
fonction `portalRequiresCaptcha(portalUrl): boolean | null` (true=captcha obligatoire,
false=confirmé sans, null=portail inconnu → laisser /main/ décider). Kinshasa=true, Cuba=true,
São Paulo=false. Le worker fait désormais `captchaRequired = portalRequiresCaptcha(url) ?? cap.present`
dans les 2 chemins réduits (`scanViaSnapshot` meute, `scanViaWidgetDatetime` shortscan). Le chemin
legacy `executeHttpBooking` (spain-http-booking.ts) applique le même override sur le flag
WidgetConfiguration non fiable.

Enregistrement PROACTIF prewarm (orchestrateur) : en mode réduit, le worker n'appelait
`registerDossierCaptcha` qu'au scan (trop tard pour le pic). L'orchestrateur enregistre maintenant
tout dossier `portalRequiresCaptcha===true` dès qu'il est actif (boucle principale, avant le
timer prewarm) → la réserve de tokens se remplit avant HH:13-14. `scanViaSnapshot` appelle aussi
`markDossierSlotSeen` (la meute voit le créneau via snapshot → burst prewarm).

Prouvé 2026-09-27 : Kinshasa shortscan → log `⚡ hCaptcha requis (portail connu=true, main=false)
→ gct au signin/` (le flag portail rattrape main=false). Cuba meute → signin/ avec `&gct=[REDACTED]`
(éclaireur ET meute), fallback à chaud si réserve vide + prewarm alimente en parallèle. `tsc` exit 0.

⚠️ WidgetConfiguration.captcha est NON fiable (Cuba=0 mais hCaptcha réel). Ne JAMAIS s'y fier seul.

## Flags prod (tous OFF par défaut → comportement historique intact)

- `SPAIN_MEUTE_MODE=1` (orchestrateur) : attribue rôles éclaireur/meute par portail.
- `SPAIN_ECLAIREUR_SHORTSCAN=1` (worker) : cycles de scan via GET widget → datetime/ direct (IDs connus).
- Test harness : `SPAIN_WORKER_ROLE=eclaireur|meute` (single), `TEST_MEUTE=1` (parallel), Redis local
  (REDIS_HOST/PORT/USERNAME/PASSWORD + neutraliser REDIS_URL), `SPAIN_BYPASS_WINDOW=1`, `SPAIN_TEST_NO_BOOKING=1`.

- **`datetime/` 0B — comportement prod (dans refreshSessionAndScan/scanDatetimeDirect) :**
  - 0B avec agenda de **fallback** (`agendaConfirmed=false`, ex. Kinshasa) → `not_found` = NORMAL
    (pas de créneau), le worker rescanne au prochain tick. Retry ciblé si un mois répond et un
    autre est 0B (faux négatif), sauf jours de publication sur le mois courant.
  - 0B avec agenda **confirmé** par getagendas/ (`agendaConfirmed=true`) sur TOUS les mois →
    `session_dead` : retry vague complète (`DATETIME_ALLZERO_MAX_RETRIES`) puis réinit PHPSESSID.
  - **Impact meute** : la meute ne fait PAS datetime/, donc ne rencontre JAMAIS ce 0B. Elle
    découvre l'indisponibilité par l'ÉCHEC du signin/ (0B ou "seleccionada por otra persona")
    → applique le repli (A: bascule sur datetime/ ; B: créneau suivant du snapshot en cycle court).
  - Seul l'ÉCLAIREUR gère le 0B datetime/ comme aujourd'hui — rien ne change pour lui.

## Primitives prod déjà en place

- `publishSlotSnapshot(agendaId, serviceId, slots[], ttlSec)` — clé Redis
  `spain:slot_snap:{agendaId}:{serviceId}`, TTL 2 min, payload `{d,t,a,n}[]` (max 500).
  **Écriture seulement** — AUCUNE fonction de lecture exportée en prod (à ajouter).
- `tryClaimSlot(date, time, agendaId, dossierId, groupSize, freeSlots, observedAtMs)` — Lua SETNX
  atomique avec capacité ; plusieurs dossiers peuvent claim le même créneau si `freeSlots > 1`.
- `reserveWorkerIp` / `isIpReservedByOther` / `rotateDecodoUrl` — 1 IP distincte par worker.
- `initWorkerSession(stickyProxy, url, capsolverKey)` → `{ session, impit, cfFromCache }` (session
  a `_ownImpit` + `bookititState`).
- `buildDynamicSession(session)` + `callDirect(ds, endpoint, extra, tag)` — appels JSONP worker.
- `getKnownIdsForPortal(portalUrl)` → `{ serviceId, agendaId }` (Cuba, São Paulo, Kinshasa…).

## Architecture éclaireur/meute (fondation)

```
ÉCLAIREUR (1 IP dédiée, scanne en continu) :
  initWorkerSession → getservices/getagendas/datetime → si créneaux :
    publishSlotSnapshot(agendaId, serviceId, slots)   # partage Redis
    (option) BURST pub/sub pour réveiller la meute immédiatement

MEUTE (N workers, CHACUN sa propre IP + cf_clearance) :
  initWorkerSession (IP distincte)
  readSlotSnapshot(agendaId, serviceId)               # à AJOUTER (lecture)
  tryClaimSlot(...) → créneau distinct (capacité gérée)
  signin/ DIRECT (datetime/ ET getsigninfields/ optionnels)  # chemin court
  → 1 signin/ concurrent par IP ; N IP = N bookings parallèles
```

**Why:** Le parallélisme réel des bookings Espagne est plafonné par une contention serveur
**par IP/cf_clearance** (1 `signin/` concurrent par IP). Le partage de créneaux et le saut de
`datetime/`/`getsigninfields/` accélèrent chaque consommateur mais NE contournent PAS cette limite.

**How to apply:**
- Pour paralléliser N bookings simultanés : N IP Decodo distinctes + N solves CF (c'est déjà ce que
  fait `runDossierWorker`). Ne jamais partager IP/cf_clearance entre dossiers qui bookent en même temps.
- Pour un système éclaireur : ajouter une fonction de **lecture** de `spain:slot_snap:*`
  (symétrique de `publishSlotSnapshot`) ; les workers meute lisent le snapshot, `tryClaimSlot`,
  puis `signin/` direct en sautant `datetime/` (et éventuellement `getsigninfields/`).
- Tester le partage en local : Redis avec `--requirepass`, forcer `REDIS_HOST`/`REDIS_PORT` et
  **neutraliser `REDIS_URL`** APRÈS le chargement dotenv (sinon l'URL Railway interne du .env
  écrase et timeout).

## 5. Collision par créneau : le "0B" n'était PAS une collision — c'était la contention IP

Test `test-worker-slot-collision.ts` : 3 workers, IP DISTINCTES, TOUS forcés sur le MÊME
créneau (freeSlots=1), `signin/` synchronisés par barrière (dispersion mesurée : **1ms**), SANS
`tryClaimSlot` (collision brute), faux credentials.

- Résultat : **3/3 → erreur métier `credentials` (180B/236B), 0 en 0B.**
- Donc, sur des IP distinctes, viser le MÊME créneau ne produit **aucun 0B** au niveau `signin/`.
  Le "0B" des tests mono-IP était donc bien la **contention IP** (fait n°1), PAS une collision de
  créneau.

### Pourquoi `signin/` ne révèle pas la collision de capacité — flux réel Bookitit

Séquence booking prod (spain-http-booking.ts) :
```
signin/  (login+password+gct)  → bktToken  (si creds valides)  OU  errors[] (si invalides)
   → si validate: confirmclient/ (bktToken + code OTP)
   → summary/  (bktToken + params)  → locator  # = createAppointment = RÉSERVATION RÉELLE
```
- **`signin/` = authentification seulement.** Avec faux credentials, il s'arrête à `errors[]` et ne
  renvoie jamais de `bktToken` → on n'atteint jamais la réservation.
- **La capacité du créneau est engagée à `summary/`** (createAppointment), deux étapes après `signin/`.
- Conséquence : **la collision de capacité (2 dossiers valides sur freeSlots=1) ne peut se mesurer
  qu'avec de VRAIS credentials** qui vont jusqu'à `summary/`. Un test à faux credentials est
  structurellement incapable de l'observer (freeSlots=1 vs 2 donne le même résultat : tous s'arrêtent
  à l'étape credentials).

### Comment ÉVITER la collision de capacité (garde-fous, sans dépendre du serveur)

- **`tryClaimSlot`** (Lua atomique, TTL 90s, capacité = freeSlots) : empêche que plus de `freeSlots`
  dossiers visent le même créneau. C'est LE garde-fou prod. Confirmé : dans `test-worker-shared-slots`,
  deux consommateurs sur un créneau freeSlots=2 sont autorisés, un 3e serait refusé.
- **Attribution par index distinct** côté meute (chacun un créneau différent du snapshot partagé).
- Ne PAS compter sur la réponse serveur à `summary/` pour arbitrer — prévenir en amont via claim.

**⚠️ Non testé en live volontairement** : le double-booking réel (2 comptes valides, même créneau
freeSlots=1, jusqu'à `summary/`) créerait de VRAIS rendez-vous. À ne tester qu'avec des comptes de
test dédiés et l'accord explicite. En l'absence, la prévention repose sur `tryClaimSlot` + attribution
distincte (garde-fous prouvés).

## Scripts de test (référence, hors flux prod)

Les harnais réutilisables prouvent le mode meute via le VRAI `runDossierWorker` (code prod, non réécrit) :
- `src/scripts/test-worker-parallel.ts` — N `runDossierWorker` en parallèle, 1 IP/worker.
  Preuve du parallélisme multi-IP (3-4 `signin/` OK simultanés). `TEST_MEUTE=1` → 1 éclaireur +
  reste meute (partage snapshot Redis, saut datetime/).
- `src/scripts/test-worker-single-dossier.ts` — 1 worker Cuba/Kinshasa/São Paulo. `SPAIN_WORKER_ROLE=
  eclaireur|meute` force le rôle ; `SPAIN_ECLAIREUR_SHORTSCAN=1` teste le chemin court éclaireur.

Les scripts d'hypothèse one-shot de l'investigation (test-worker-shared-slots, test-worker-slot-collision,
test-meute-e2e, test-saopolo-datetime-hardcoded / -signin-without-datetime / -parallel-shortcycle /
-datetime-only / -skip-agenda) ont été SUPPRIMÉS après implémentation : leurs preuves sont consignées
ci-dessus (§1-8). Ne pas les recréer — réutiliser les deux harnais prod ci-dessus.
