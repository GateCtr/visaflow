---
name: Mécanisme du challenge Cloudflare chl_page interactif (recherche)
description: Comment fonctionne le challenge chl_page de citaconsular.es et pistes pour le franchir en HTTP-pur
---

# Challenge Cloudflare chl_page interactif — fonctionnement et pistes

Date : 2026-10-08. Portail São Paulo : widgetdefault/2d01502f12dc08400e22aea87fb00ae34.
Fingerprint observé : `cType:'interactive'`, `cFPWv:'g'`, orchestrate `chl_page/v1`,
PAS de `__CF$cv$params`, PAS de sitekey Turnstile dans le HTML initial.

## Flux réel du managed/chl_page challenge (reverse-eng, source scaredos/cfresearch)
Base URL : `/cdn-cgi/challenge-platform/h/g` (ou `/h/b`).
1. GET  `{BASE}/orchestrate/chl_page/v1?ray={rayid}` → renvoie du JS qui génère le
   challenge-id et prépare la requête suivante.
2. POST `{BASE}/flow/ov1/{x}:{epoch}:{y}/{ray}/{chl-id}` body `v_{rayid}=<payload chiffré>`,
   header `cf-challenge` → réponse avec header `Cf-Chl-Gen`.
3-6. (si Turnstile) échanges avec `challenges.cloudflare.com` (if/ov2/..., flow/ov1/...).
7. POST **vers l'URL cible** body `md=`(analytics) `sh=` `aw=` `cf_ch_cp_return=` →
   **c'est CE POST qui pose le nouveau `cf_clearance`**.
Note cfresearch : timeout ~60s après lequel le clearance Turnstile est parfois accordé auto.

## Deux cookies, pas un (source captchaai session-flow)
- `__cf_bm` : posé DÈS la 1re réponse 403 (bot management). Doit accompagner cf_clearance.
- `cf_clearance` : posé à l'étape 7 (preuve de passage).
- Cause classique de "redirect loop / 403 après solve" = cf_clearance pas renvoyé OU
  domaine/SameSite incorrects OU `__cf_bm` manquant.

## Ce que notre code faisait (et le probable défaut)
- `solveSpainCloudflare` (spain-soax-solver.ts l.538) lit `solution.cookies` de CapSolver.
- Logs de prod observés : `cookies reçus: cf_clearance(len=959)` → **CapSolver ne renvoie
  QUE cf_clearance, PAS __cf_bm**.
- cf_clearance de CapSolver = lié à SA session (TLS + __cf_bm internes). Le POST étape 7 est
  fait DANS le contexte CapSolver → le cf_clearance rendu n'est pas rejouable seul par impit.

## Pistes à tester (par ordre de coût croissant)
A. **Renvoyer __cf_bm + cf_clearance ensemble** : capturer __cf_bm du GET initial (impit, avant
   solve) et le combiner au cf_clearance de CapSolver sur le GET post-solve, même IP. Rapide.
B. **Garder la session TLS vivante** (connexion réutilisée) entre solve et GET.
C. **Rejouer le flux 1→7 nous-mêmes** (payloads v_{rayid}/md/sh/aw) — très dur (VM JS obfusquée CF).
D. **Browser one-shot** : headless résout 1→7 (vrai JS CF), on extrait TOUT le jar
   (cf_clearance + __cf_bm + autres) + même profil TLS + même IP → GET HTTP rapide. Le plus fiable.

## Verdict nuancé (corrige le "mur infranchissable")
Ce n'est PAS prouvé impossible. Prouvé seulement : rejouer le SEUL cf_clearance de CapSolver
via impit/Go-uTLS (profils 131/133/146/150/152) → 403. Variables NON encore isolées :
présence de __cf_bm, réutilisation de la connexion TLS, jar complet. À tester avant de conclure.


## Résultat PISTE A (2026-10-08, debug-cfbm-jar.ts, São Paulo, IPs 8888+)
Hypothèse "__cf_bm manquant" → **ÉCARTÉE**. Faits mesurés sur 3 IPs :
- GET initial (impit) → 403, **Set-Cookie: (aucun)** — le chl_page ne pose AUCUN cookie,
  pas de __cf_bm du tout à ce stade.
- CapSolver AntiCloudflareTask → rend UNIQUEMENT `cf_clearance` (len 959), jamais __cf_bm.
- GET post-solve `cf_clearance` SEUL vs `jar complet` → **identique : 403, token absent**.
Donc le blocage n'est pas un cookie manquant. Le cf_clearance de CapSolver est généré par
le POST final (étape 7) DANS le navigateur de CapSolver (son TLS/JA3/JA4 + son exécution JS)
→ non valide pour notre impit. La variable déterminante = **empreinte TLS/JS du contexte qui a
généré le clearance**, pas l'IP ni les cookies annexes.

Conséquence : les pistes "cookies" (A) et probablement "connexion TLS vivante" (B, car impit
ne reproduit pas le JA3 du solveur) ne suffiront pas. Restent réalistes :
- D. Browser one-shot (le navigateur qui résout EST celui dont on réutilise cookies+TLS) ;
- Variante : solveur qui exécute dans NOTRE contexte TLS (CapSolver avec html le fait censément
  mais rend un clearance non rejouable ici → à confirmer si un autre type de tâche/solveur
  renvoie un clearance lié à l'IP seule, utilisable par n'importe quel client).


## Résultat VOIE D (2026-10-08, test-pb-clearance-lifetime.ts, São Paulo, IP Decodo ES)
Le navigateur persistant (Chromium) FRANCHIT CF parfaitement :
- Session prête en 25s | cookies: _ga, **cf_clearance (597B)**, **PHPSESSID**, **cf_chl_rc_ni**, _ga_F3TYSDL945
- 128 KB de widget APIs préfetchées DANS le navigateur : getwidgetconfigurations 370B,
  getservices 852B, getagendas 175B, datetime/2026-10 87B ({"Slots":[],"maxDays":...}).
- Note : apparition d'un cookie **cf_chl_rc_ni** (challenge record) absent du flux impit/CapSolver.

MAIS le hand-off vers HTTP pur ÉCHOUE **dès T+0** (pas une question de durée) :
- GET impit (MÊME IP Decodo, jar complet cf_clearance+PHPSESSID+cf_chl_rc_ni) → 403 encoreCF
  à T+0, +10, +30, +60, +120, +300s. REJET IMMÉDIAT.
Donc le cf_clearance de CE portail est lié à l'**empreinte TLS/JA3 de l'agent** qui l'a obtenu.
impit (browser:"chrome") ≠ JA3 Chromium → rejet transport-layer. Ni IP, ni cookies, ni TTL.

## CONCLUSION STRATÉGIQUE
- HTTP-pur (impit/Go-uTLS + clearance externe) = **définitivement non viable** pour São Paulo
  chl_page interactif. Prouvé sous tous les angles (CapSolver, cookies, __cf_bm, uTLS 131-152,
  hand-off navigateur→HTTP). Le clearance n'est jamais détaché de son contexte TLS.
- CE QUI MARCHE : **tout faire DANS le navigateur** (scan inclus). Le PB lit déjà services +
  agendas + datetime en ~25s au 1er solve, puis les scans suivants réutilisent la page
  (cf_clearance vit dans le contexte browser, PAS besoin de le rejouer en HTTP).
- La contrainte "<40s/créneau" doit donc se résoudre par un navigateur CHAUD réutilisé qui
  rescanne datetime/ in-page (pas un hand-off HTTP). Reste à mesurer la latence d'un rescan
  datetime/ in-page sur browser déjà chaud (vs 1er solve 25s).


## Test RACCOURCI datetime in-page (2026-10-08, test-pb-datetime-shortcut.ts)
Idée : navigateur chaud + appeler datetime/ in-page directement avec IDs connus São Paulo
(serviceId=bkt853215, agendaId=bkt301070 depuis KNOWN_PORTAL_IDS), sans cfg/svc/getagendas.
Via callBookititViaJQueryInPage(url) avec URL construite à la main (ordre strict params).

Résultat : TOUS les appels datetime/ renvoient **22B** puis `__ERR_EVALUATE_TIMEOUT` (26s).
Même après un getagendas/ direct d'amorçage. 22B = réponse quasi vide → le callback JSONP ne
se résout jamais. Donc l'URL datetime/ fabriquée à la main NE reproduit PAS ce que le widget
envoie réellement (le flux natif via clic service capturait bien datetime/2026-10 → 87B
{"Slots":[],"maxDays":...} dans test-pb-clearance-lifetime).

Hypothèses du 22B : callback mal formé pour le path script-tag de callBookititViaJQueryInPage,
OU params manquants/ordre que seul le widget Backbone connaît (ex. un token/état interne), OU
l'appel JSONP manuel hors du cycle widget n'a pas le bon Referer/état PHP.

CONCLUSION : le raccourci ne doit PAS reconstruire l'URL à la main. Bonne direction = piloter
le WIDGET lui-même (il a déjà les bons params en session) mais sauter le clic lent de 8s en
déclenchant programmatiquement la navigation vers la vue datetime (ex. Backbone router /
window.location hash du widget, ou appeler la méthode interne qui charge l'agenda). À explorer :
comment le widget construit son datetime/ (intercepter la vraie requête réseau émise au clic,
la rejouer à l'identique), plutôt que deviner les params.


## ✅ SOLUTION TROUVÉE (2026-10-08) — raccourci datetime in-page via jQuery natif
Idée utilisateur : se baser sur le FORMAT d'URL du scanner HTTP prod, mais émettre l'appel
IN-PAGE via jQuery natif (dataType:'jsonp') au lieu d'inventer le callback.

Pourquoi les tentatives précédentes donnaient 22B : elles fabriquaient un callback
`jQuery21109{ts}_{rand}` DIFFÉRENT à chaque appel + script-tag manuel. jQuery natif
(dataType:'jsonp', jsonp:'callback') génère ET gère son propre callback → Bookitit répond
correctement. Params passés en objet `data` (jQuery sérialise services[]/agendas[] en
`services[]=...&agendas[]=...`), ordre géré par jQuery, toléré par Bookitit.

Helper qui marche (test-pb-datetime-shortcut.ts) : page.evaluate d'un
jq.ajax({ url: srvsrc+'/onlinebookings/'+endpoint, dataType:'jsonp', jsonp:'callback',
data:{type,publickey,lang,version,src,srvsrc, 'services[]':svc, 'agendas[]':agenda, start,end,
selectedPeople:'1'} }).

RÉSULTATS São Paulo (navigateur chaud, IDs connus bkt853215/bkt301070) :
- getagendas/ in-page : 416ms → {"Agendas":[{"id":"bkt301070","name":"Pasaportes"}]} ✅
- datetime/2026-10 : 430ms Slots=0 ; 2026-11 : 707ms **Slots=30** (13631B) ; 2026-12 : 964ms Slots=31
- rescan datetime/ mois courant ×5 : moy **496ms** (min 462 / max 584).

ARCHITECTURE RETENUE :
- Solve CF initial via navigateur persistant = 26-31s, payé 1× (navigateur CHAUD maintenu).
- Chaque scan de créneau = datetime/ in-page jQuery natif ≈ 0,5s → 50× plus rapide que 25s,
  très en dessous de la contrainte <40s/créneau.
- Pas de hand-off HTTP (impossible, cf plus haut). Tout reste dans le navigateur chaud.
- getagendas/ in-page (1×, 0,4s) amorce l'agenda dans la session PHP avant les datetime/.

PROCHAINE ÉTAPE : intégrer ce raccourci dans le vrai flux de scan prod (callBookititViaWidgetNativeJsonp
accepte déjà un endpoint ; il faut une variante acceptant des params custom data{} pour
getagendas/ + datetime/ multi-mois avec IDs connus), piloté par getKnownIdsForPortal().


## ✅✅ FULLCHAIN in-page VALIDÉE (2026-10-08, test-pb-fullchain-saopolo.ts, São Paulo)
Chaîne complète conforme prod, in-page via jQuery natif, navigateur chaud :
- getagendas/ → 446ms ✅ 118B
- datetime/2026-11 → 13631B → VRAI slot 2026-11-03 09:00 ✅
- getsigninfields/ → 437ms ✅ 13760B → logintypes ["document"]
- signin/ (credentials factices, gct="") → 687ms ✅ 180B →
  {"Client":{"errors":[{"message":"Usuario o contraseña incorrectos"...}]}}
  → nonce bien armé, endpoint répond, rejet creds attendu. Avec vrais creds → bktToken → summary/.
- summary/ JAMAIS appelé (SPAIN_TEST_NO_BOOKING=1). Logintype confirmé "document".

### datetime/ parallèle in-page : OK À CONDITION de reproduire le JITTER prod
CORRECTION d'une conclusion hâtive. 1er test : Promise.all SIMULTANÉ (sans jitter) → le 2e mois
revenait 0B. MAIS la prod (spain-dossier-worker.ts l.1224-1233) ne lance PAS les mois
simultanément : mois index 0 immédiat, mois index 1+ avec un JITTER (DATETIME_MONTH_JITTER_MAX_MS,
défaut 200ms, baseDelay=index*75 + random) + RETRY ciblé sur 0B (DATETIME_MONTH_ZERO_MAX_RETRIES=3).
Re-test in-page AVEC jitter 200ms + retry 0B → **les 2 mois répondent correctement en parallèle** :
datetime/2026-10 (35B, 0 slot) + datetime/2026-11 (13520B → slot 2026-11-03 09:00), total 879ms.
→ CONCLUSION CORRIGÉE : le scan datetime/ parallèle 2 mois SE TRANSPOSE au navigateur, exactement
comme la prod, à condition d'appliquer le même jitter (≥75-200ms entre mois) + retry sur 0B.
Ne PAS lancer un Promise.all strictement simultané in-page (collision JSONP sur le 2e). Avec jitter
c'est conforme prod et plus rapide que séquentiel (879ms vs ~1,3s).


## Isolation N-dossiers São Paulo (2026-10-08, test-pb-multidossier-isolation.ts)
Objectif : 1 navigateur partagé (CF franchi 1×) + N contextes incognito isolés (1/dossier),
chacun avec son PHPSESSID, scan datetime/ in-page concurrent.

RÉSULTATS :
- ✅ Isolation PHPSESSID : 3/3 (puis 2/2) PHPSESSID DISTINCTS par contexte incognito. L'isolation
  fonctionne (createBrowserContext + proxy auth via page.authenticate).
- ❌ MAIS chaque contexte incognito frais RETOMBE SUR LE CHALLENGE CF : title "Just a moment...",
  scripts = chl_page/v1?ray=... → window.jQuery absent → scan datetime/ impossible (__ERR_NO_JQUERY).

CAUSE : le cf_clearance injecté (via CDP Network.setCookie) ne suffit PAS dans un contexte
incognito NEUF — CF re-challenge chaque nouveau contexte car le clearance est lié au contexte
TLS/JS qui l'a généré (cohérent avec tous les tests précédents). Un contexte incognito ≠ le
contexte qui a résolu CF → re-challenge.

IMPLICATION MULTI-DOSSIERS : on ne peut PAS cloner le cf_clearance dans N contextes incognito et
espérer un widget prêt. Options à évaluer :
  (1) Chaque contexte incognito résout CF LUI-MÊME (N solves ~26s chacun — coûteux mais isolé).
  (2) UNE SEULE page widget (contexte principal, déjà CF-franchi + jQuery) partagée pour TOUS les
      dossiers : on y fait les appels datetime/getsigninfields/signin SÉQUENTIELLEMENT par dossier,
      en changeant le PHPSESSID par dossier au niveau du jar/cookie avant chaque appel. Risque :
      Bookitit lie la session PHP au cookie → faisable si on pilote le cookie PHPSESSID par appel.
  (3) N navigateurs séparés (userDataDir distinct) chacun CF-franchi — vrai parallélisme mais N×
      coût mémoire + N× solve. C'est ce que "plusieurs navigateurs selon horloge murale" suggère.
Note prod createDossierSession : fait pareil (incognito + inject cf sans PHPSESSID + /main/) MAIS
pour le flux HTTP (récupère juste le PHPSESSID, referme le contexte) — PAS pour scanner in-page.
Donc en HTTP le re-challenge n'importe pas (impit refait le GET) ; en navigateur in-page, si.


## Test N ONGLETS self-solve (2026-10-08, test-pb-ntabs-selfsolve.ts, São Paulo, N=3)
Idée : 1 navigateur + N onglets, chaque onglet franchit CF lui-même (plus léger que N navigateurs).
RÉSULTAT :
- ✅ CF franchi 3/3. TAB-1 solve 17,6s (vrai), TAB-2/3 ~3s (profitent du cf_clearance du profil partagé).
- ❌ PHPSESSID IDENTIQUE sur les 3 onglets (i9-vd0hYoY… partout) → 1/3 distincts → PAS d'isolation.
- ❌ jQuery absent → scan datetime/ échoue (timing widget, secondaire).
CAUSE : les onglets d'un MÊME profil navigateur PARTAGENT le cookie store → même PHPSESSID.
Impossible d'isoler des dossiers indépendants avec de simples onglets. C'est précisément pourquoi
la prod utilise des CONTEXTES INCOGNITO (cookie store isolé), pas des onglets.

## SYNTHÈSE options multi-dossiers indépendants (navigateur) — São Paulo
Contrainte : chaque dossier a besoin d'un cf_clearance (OK, partageable au niveau profil) MAIS d'un
PHPSESSID ISOLÉ (sinon signin/summary croisés). Options :
- Onglets même profil : ❌ PHPSESSID partagé.
- Contexte incognito héritant du cf_clearance : ❌ re-challenge CF (clearance lié au contexte TLS/JS).
- Contexte incognito résolvant CF lui-même : à tester (chaque contexte = cookie jar isolé + son solve).
- N navigateurs séparés (userDataDir distinct) : ✅ isolation totale, mais ~300Mo × N (Railway Pro 32Go OK).
Le PHPSESSID isolé est le vrai critère. Railway Pro (32Go) rend les N navigateurs viables pour N=10.

## Test N CONTEXTES incognito self-solve (2026-10-08, test-pb-ncontexts-selfsolve.ts, São Paulo)
Résultat : CF "franchi" 2-3/3 (solveCfChallenge success:true), PHPSESSID ISOLÉS ✅ 3/3 distincts.
MAIS jQuery jamais chargé → scan datetime/ échoue. Diagnostic post-solve + re-nav :
title reste "Just a moment..." (hasJq:false, hasBkt:false) → le contexte incognito RE-CHALLENGE
CF à chaque navigation, malgré le solve. Le cf_clearance obtenu dans un contexte incognito
éphémère NE TIENT PAS pour la navigation suivante (clearance lié au contexte de façon stricte).
solveCfChallenge success:true est optimiste (challenge disparu transitoirement) mais widget jamais prêt.

→ CONCLUSION : les contextes incognito (même self-solve) ne donnent PAS un widget stable sur ce
portail. SEUL le contexte PRINCIPAL avec profil persistant (userDataDir) franchit CF ET charge le
widget durablement (prouvé par ensureSpainPersistentBrowserSession : 128KB prefetch, jQuery OK,
scan datetime OK). Donc pour N dossiers indépendants isolés : il faut N NAVIGATEURS SÉPARÉS
(userDataDir distinct chacun), pas des contextes/onglets d'un navigateur partagé. Railway Pro
32Go le permet (~300Mo × 10 = 3Go). C'est l'architecture retenue pour 10 dossiers.


## Test N NAVIGATEURS séparés (2026-10-08, test-pb-nbrowsers-parallel.ts, São Paulo, N=3)
RÉSULTATS :
- ✅ 3 Chromium indépendants (userDataDir distincts + ports Decodo 8888-8890) coexistent.
- ✅ PHPSESSID ISOLÉS 3/3 distincts (isolation par navigateur séparé = parfaite).
- ✅ RAM mesurée : ~261 Mo/navigateur → **~2,6 Go pour 10** (très OK sur Railway Pro 32Go).
- ✅ CF franchi 3/3 (solveCfChallenge success).
- ❌ jQuery=❌ 3/3 → scan datetime/ échoue.

CAUSE RACINE identifiée (lecture _legacy_spain-persistent-browser.ts étape 5+, l.2440+) :
solveCfChallenge franchit le challenge MAIS ne charge PAS le widget. Le vrai ensureSession fait
APRÈS le solve une chorégraphie que mes scripts de test ne reproduisent pas :
  1. clic "Continuar" (humanLikeCdpClick, trajectoire Bézier isTrusted)
  2. attente signal RUM POST /cdn-cgi/rum (= LCP widget rendu)
  3. capture /main/ via XHR listener CDP (CF bloque la NAV top-level vers /main/ → 0B, mais laisse
     passer le XHR /main/ déclenché par le JS du portail APRÈS le clic Continuar)
  4. le widget charge alors jQuery + s'initialise → scan datetime/ possible.
Mes tests autonomes appelaient solveCfChallenge puis attendaient jQuery → widget jamais chargé.

CONCLUSION FERME :
- L'architecture "N navigateurs séparés" est VALIDE (isolation ✅, RAM ✅ ~2,6Go/10, CF ✅). Le
  jQuery=❌ n'est PAS un échec d'archi, c'est que mes scripts ne font pas la chorégraphie post-solve.
- Le VRAI ensureSpainPersistentBrowserSession charge bien jQuery + scanne (prouvé tests antérieurs :
  128KB prefetch, datetime OK). MAIS il est écrit en SINGLETON (1 navigateur / 1 userDataDir).
- INTÉGRATION REQUISE : rendre le manager multi-instances (N navigateurs, chacun son userDataDir +
  port Decodo + session), réutiliser la chorégraphie ensureSession existante par instance, puis
  le raccourci datetime in-page validé (jQuery natif + IDs connus KNOWN_PORTAL_IDS) +
  getsigninfields/signin/summary + prewarm hCaptcha + fenêtre horaire. C'est le plan d'intégration.


## Test GCT in-page Cuba (2026-10-08, test-pb-cuba-gct.ts)
Cuba (captchaRequired:true) se comporte comme São Paulo pour la chaîne in-page :
- CF franchi ✅ | datetime/2026-11 → 18755B, VRAI slot 2026-11-03 09:00 ✅ | getsigninfields/ 13516B ✅.
Donc scan + nonce in-page OK sur Cuba aussi (même code, même mécanisme que São Paulo — confirmé).
BLOQUÉ sur gct : CapSolver refuse le hCaptcha citaconsular ("We don't support this service"),
et NONECAP_API_KEY / ANTICAPTCHA_API_KEY ABSENTS du .env sandbox (seul CAPSOLVER_API_KEY présent).
→ Impossible de tester l'injection gct dans signin/ in-page SANS une clé NoneCap (le seul solveur
qui résout ce sitekey en prod). Risque résiduel FAIBLE : gct = 1 param de plus dans le même appel
JSONP data{} déjà validé ; jQuery le sérialise comme les autres. À valider en prod (NoneCap présent)
ou dès qu'une clé NoneCap est fournie au sandbox.
