---
name: Plan d'intégration — mode navigateur São Paulo (chl_page) dans slot-hunter
description: Comment greffer le scan+booking in-page (1 navigateur/dossier) sur le flux prod HTTP sans le casser
---

# Plan d'intégration — mode navigateur par dossier pour São Paulo

## 0. Contexte & objectif
São Paulo sert un challenge Cloudflare `chl_page` interactif. Prouvé : l'HTTP-pur
(impit + CapSolver AntiCloudflareTask) NE PEUT PAS franchir ce GET (cf_clearance non
rejouable hors du contexte TLS/JS qui l'a généré). Seul un vrai navigateur franchit CF
ET charge le widget. Validé par tests (voir cf-chl-page-mechanism-research.md) :
- 1 navigateur franchit CF (~26s) puis scanne datetime/ in-page (~0,5s), chaîne complète
  getagendas→datetime(parallèle 2 mois, jitter)→getsigninfields→signin OK.
- Isolation : contextes incognito/onglets partagent ou re-challengent → KO ; seul
  **1 navigateur séparé (userDataDir distinct) par dossier** donne CF+widget+PHPSESSID isolé.
- RAM mesurée ~261 Mo/navigateur → ~2,6 Go pour 10 dossiers (OK Railway Pro 32 Go).

Objectif : pour les portails chl_page (São Paulo d'abord), remplacer UNIQUEMENT la couche
"session + transport des appels Bookitit" par un navigateur dédié au dossier, en gardant
INTACT tout le reste du worker (scan logic, booking, sémaphore, fenêtre, prewarm hCaptcha,
reporting, SPAIN_TEST_NO_BOOKING).

## 1. État des lieux prod (vérifié)
- Entrée : `startSpainWorkerOrchestrator()` → boucle spawn → `runDossierWorker(config, reservePool)`
  (1 worker/dossier, aucune limite de concurrence ; garde `isInScanWindow()`).
- Worker (`runDossierWorker`, spain-dossier-worker.ts:2121) :
  1. gardes fenêtre (windowEndEarly, WINDOW_END_MIN=18) ;
  2. `pickDedicatedProxy` (IP Decodo réservée Redis NX) ;
  3. **session via `initWorkerSessionWithDirectRescan` → `initWorkerSession`** (HTTP capsolver-residential),
     JAMAIS `ensureSpainCfSession`. Produit `SpainCfSession { source:"capsolver", _ownImpit, bookititState }` ;
  4. `initPhpState` (getwidgetconfigurations/getservices/getagendas via `callDirect`) ;
  5. boucle scan : `refreshSessionAndScan` (ou `scanViaSnapshot` si meute) → datetime/ ;
  6. booking : getsigninfields/ → signin/ → summary/ via `callDirect`.
- **Transport réel des appels Bookitit = `callDirect` (spain-bookitit-direct.ts:689)** qui fait
  `ds.impit.fetch(url)` DIRECTEMENT (+ le scan cycle complet fait aussi des `impit.fetch` inline).
  Le worker NE passe PAS par `spainCfFetch`.
- Indirection navigateur existante MAIS inutilisée par le worker : `spainCfFetch` route vers
  `_spainPageFetcher` (page Chromium) quand `session.source==="playwright"`. Câblé par
  `registerSpainPageFetcher(callBookititEndpointViaBrowser)` dans _legacy_ (singleton, mono-instance).
- Routage par portail : `getKnownIdsForPortal` / `portalRequiresCaptcha` (spain-portals.ts),
  consultés PAR DOSSIER. São Paulo = `SAOPOLO_WIDGET_KEY 2d01502f…`, serviceId bkt853215,
  agendaId bkt301070, captchaRequired:false.
- `SPAIN_SESSION_MODE` est GLOBAL et sans effet sur le chemin worker (worker court-circuite).

## 2. Décision d'architecture
- **1 navigateur Chromium par dossier** (userDataDir dérivé de config.id), franchit CF via le
  vrai flux `ensureSession` (clic Continuar + capture XHR /main/), garde la page chaude.
- Le worker reste identique ; on route **les appels Bookitit** du dossier São Paulo vers SA page.
- Mécanisme de routage : passer par l'indirection existante `session.source==="playwright"` + un
  **page-fetcher PAR SESSION** (pas le `_spainPageFetcher` global mono-instance).

## 3. Travaux (ordre d'implémentation)

### T1 — Manager navigateur multi-instances (le gros morceau)
Extraire/transformer `SpainPersistentBrowserManager` pour permettre N instances :
- `userDataDir` paramétré par instance (ex. `${tmpdir}/spain-cf-<dossierId>`).
- Pas de dépendance à `_activeCfSession`/`get/setActiveSpainCfSession` (slot global unique).
- Conserver la chorégraphie `ensureSession` (solve CF + clic Continuar + XHR /main/ + prefetch).
- Chaque instance expose : `ensureSession(portalUrl)`, `getActivePage()`, `callBookititInPage(url)`,
  `create/close`, `isExpiringSoon()`.
Option de moindre risque : NE PAS réécrire le legacy. Créer un NOUVEAU fichier
`spain-browser-pool.ts` qui gère une `Map<dossierId, BrowserInstance>` où chaque BrowserInstance
encapsule son propre puppeteer.launch (args anti-détection repris de buildLaunchArgs) + page +
solveCfChallenge + la chorégraphie post-solve (clic Continuar + capture /main/ via CDP),
réutilisant les helpers existants (solveCfChallenge, humanLikeCdpClick) sans toucher au singleton.

### T2 — Fetcher Bookitit in-page PAR SESSION
- Ajouter à `SpainCfSession` un champ optionnel `_ownPageFetcher?: (url:string)=>Promise<string|null>`
  (comme `_ownImpit` est déjà par-session).
- Le worker São Paulo crée la session avec `source:"playwright"` + `_ownPageFetcher` lié à SA page.
- L'appel in-page réutilise la recette VALIDÉE : jQuery natif `jq.ajax({dataType:'jsonp',jsonp:'callback',data})`
  (PAS reconstruire l'URL ni inventer le callback — c'est ce qui donnait 22B). Convertir l'URL
  Bookitit (query string) en objet `data` pour jQuery, ou exécuter le fetch script-tag comme
  callBookititViaJQueryInPage. Datetime parallèle 2 mois AVEC jitter 200ms + retry 0B (conforme prod).

### T3 — Router callDirect + scan vers le fetcher par session
Dans `spain-bookitit-direct.ts` `callDirect` (~l.714), AVANT `ds.impit.fetch` :
```
if (ds.session?.source === "playwright" && ds.session._ownPageFetcher) {
   const body = await ds.session._ownPageFetcher(url);
   if (body) { mergeResponseCookies via page cookies; return parse(body); }
}
```
(DynamicSession porte déjà `session`.) Et dans `refreshSessionAndScan`/`scanViaWidgetDatetime`
(les `impit.fetch` inline du scan), même garde — OU faire passer ces scans par `callDirect`/un
helper commun routable. Préférer un helper unique `bookititFetch(session, url)` que les deux
chemins (scan + booking) utilisent, qui route page vs impit selon `source`.

### T4 — Branchement par portail dans runDossierWorker
Après `portalUrlNoFrag` (~l.2245), AVANT la boucle init session :
```
const useBrowser = isBrowserPortal(portalUrlNoFrag); // ex. publickey ∈ BROWSER_SESSION_PORTALS (São Paulo)
if (useBrowser) {
   session = await createBrowserDossierSession(config.id, portalUrlNoFrag, proxyUrl); // T1+T2
   // session.source="playwright", _ownPageFetcher lié à la page, bookititState rempli (publickey/srvsrc/version/widgetUrl)
} else {
   // ... boucle initWorkerSession HTTP existante inchangée ...
}
```
`BROWSER_SESSION_PORTALS` = set gated par env (ex. `SPAIN_BROWSER_PORTALS=2d01502f…`), défaut
contient São Paulo. Tout autre portail → chemin HTTP actuel INCHANGÉ.

### T5 — initPhpState / IDs connus
En mode navigateur : sauter getwidgetconfigurations/getservices/getagendas (IDs connus
via getKnownIdsForPortal) ou les faire in-page une fois. Réutiliser le raccourci validé
(getagendas/ in-page 1× pour amorcer l'agenda, puis datetime/ direct).

### CAPTCHA (Kinshasa/Cuba) — AUCUN code à écrire, 100% réutilisé
Décision confirmée : le captcha prod est DÉJÀ implémenté dans spain-dossier-worker.ts (~l.3326) :
```
if (captchaNeeded) {
  const prewarmed = takeDossierToken(config.id);     // prewarm hCaptcha (NoneCap)
  gctToken = prewarmed ?? await solveSpainHcaptcha(sitekey, portalUrl); // fallback
  if (!gctToken) break;                               // pas de gct → pas de signin (0B garanti)
}
signinRaw = await callDirect(ds, "signin/", { ...bookExtra, logintype, login, password, comments:"", gct: gctToken });
```
Tout le captcha transite par `callDirect(ds, "signin/", {..., gct})`. Donc dès que T3 route
callDirect vers la page quand source==="playwright", le gct part in-page AUTOMATIQUEMENT comme
simple param JSONP (data{..., gct}) — rien à copier/réécrire. captchaNeeded vient de
portalRequiresCaptcha (Kinshasa/Cuba true, São Paulo false). prewarm hCaptcha orchestrateur
inchangé. Validé partiellement : chaîne in-page Cuba OK jusqu'à getsigninfields (slot réel trouvé),
seul le solve hCaptcha n'a pu tourner dans le sandbox (NoneCap absent) — non bloquant, c'est le
même param dans le même appel déjà validé.

### T6 — Nettoyage cycle de vie
- Fermer le navigateur du dossier quand le worker se termine (finally de runDossierWorker).
- Pool borné (ex. SPAIN_BROWSER_MAX, défaut 12) pour éviter l'explosion si beaucoup de dossiers.
- Renouvellement CF avant expiration (navigateur chaud, ~115 min) sans tuer la page.

## 4. Invariants à préserver (NE PAS casser)
- `SPAIN_TEST_NO_BOOKING=1` : garde avant summary/ (déjà dans le worker — rien à changer si on
  garde le booking via callDirect routé).
- Sémaphore `tryAcquireBookingSlot`/`MAX_CONCURRENT_BOOKERS` avant signin/summary.
- Fenêtre horaire (WINDOW_END_MIN, isWindowOpen) + spawn (isInScanWindow).
- Prewarm hCaptcha (registerDossierCaptcha/takeDossierToken) — INCHANGÉ, le gct entre dans signin/.
- Reporting, claim Redis, rotation IP : inchangés (le navigateur utilise le même proxy Decodo réservé).
- Portails NON navigateur (Kinshasa, Cuba, autres) : chemin HTTP capsolver-residential STRICTEMENT inchangé.

## 5. Risques / points de vigilance
- callDirect route par session : bien récupérer les Set-Cookie côté page (page.cookies) pour
  mergeResponseCookies (PHPSESSID peut tourner).
- Le scan cycle complet (refreshSessionAndScan) contourne callDirect → prévoir le helper commun.
- Datetime parallèle in-page = OK seulement avec jitter (sans jitter → 2e mois 0B).
- Chaque navigateur = 1 port Decodo distinct (déjà géré par pickDedicatedProxy) ; proxy auth via
  page.authenticate (les contextes/navigateurs héritent du --proxy-server mais pas des creds).
- Mémoire : borne SPAIN_BROWSER_MAX + fermeture en fin de worker.

## 6. Plan de test (avant/après chaque T)
- Reprendre les scripts validés (test-pb-fullchain-saopolo, test-pb-nbrowsers-parallel) comme base.
- E2E : runDossierWorker sur São Paulo avec SPAIN_TEST_NO_BOOKING=1 → doit atteindre signin/
  (rejet creds factices), jamais summary/.
- Non-régression : un dossier Kinshasa/Cuba doit continuer en HTTP capsolver-residential inchangé.

## 7. Branche & PR
Modif sensible du cœur du bot → branche dédiée + PR, pas de commit direct main. Gater tout le
nouveau comportement derrière SPAIN_BROWSER_PORTALS (vide par défaut = prod HTTP inchangée),
activable progressivement.
