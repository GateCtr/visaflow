# Requirements Document

## Introduction

Réécriture et amélioration du module `cf-challenge-solver.ts` pour contourner les protections Cloudflare des portails consulaires (principalement `citaconsular.es` Espagne, et futurs portails). Le module doit détecter plus finement le type de challenge CF, résoudre plus rapidement et de manière plus furtive grâce à des techniques inspirées de SeleniumBase UC Mode / CDP Mode, mettre en cache les sessions `cf_clearance` avec TTL, et orchestrer les tentatives avec rotation d'IP Decodo.

## Glossaire

- **Solver** : le module `cf-challenge-solver.ts` réécrit (v2)
- **ChallengeDetector** : composant de détection du type de challenge CF
- **StealthManager** : composant de patches navigateur + timing humain
- **TurnstileClickSolver** : composant de résolution Turnstile par clic CDP humanisé
- **SessionCache** : composant de mise en cache TTL des sessions `cf_clearance`
- **CfSolverOrchestrator** : composant d'orchestration retry + rotation IP
- **cf_clearance** : cookie Cloudflare prouvant qu'un challenge a été résolu pour une IP/TLS donnée
- **JSD** : Cloudflare JavaScript Detection — challenge passif (Proof-of-Work + fingerprint)
- **Managed Challenge** : challenge CF où CF décide dynamiquement entre JSD et Turnstile
- **Turnstile** : widget CAPTCHA CF interactif (checkbox visible) ou invisible (PoW silencieux)
- **IUAM** : Under Attack Mode — page "Checking your browser…" avec compte à rebours 5s
- **CapSolver** : service externe de résolution captcha (fallback uniquement)
- **Decodo** : fournisseur de proxies résidentiels/ISP (pool via `spain-decodo-pool.ts`)
- **CDP** : Chrome DevTools Protocol — API bas niveau pour contrôler Chromium
- **Bezier** : courbe de Bézier cubique utilisée pour simuler une trajectoire de souris humaine
- **TTL** : Time To Live — durée de validité d'une entrée en cache
- **Page** : instance Puppeteer (`import type { Page } from "puppeteer"`)

---

## Requirements

### Requirement 1 : Détection fine du type de challenge CF

**User Story:** En tant que développeur du Solver, je veux détecter précisément le type de challenge Cloudflare présent sur une page, afin d'appliquer la stratégie de résolution optimale sans tentatives inutiles.

#### Acceptance Criteria

1. WHEN `detectChallengeType` est appelé sur une page ne contenant aucun signal Cloudflare (pas de `_cf_chl_opt`, pas de titre "Just a moment", pas d'éléments DOM CF, pas d'URL `/cdn-cgi/`), THE ChallengeDetector SHALL retourner `"none"`.

2. WHEN `detectChallengeType` est appelé sur une page dont `window._cf_chl_opt.cType === "managed"`, THE ChallengeDetector SHALL retourner `"managed"`.

3. WHEN `detectChallengeType` est appelé sur une page dont `window._cf_chl_opt.cType === "non-interactive"` ou `"jsd"`, THE ChallengeDetector SHALL retourner `"jsd"`.

4. WHEN `detectChallengeType` est appelé sur une page contenant une iframe dont l'attribut `src` inclut `challenges.cloudflare.com` et dont le titre inclut "Just a moment", THE ChallengeDetector SHALL retourner `"turnstile"`.

5. WHEN `detectChallengeType` est appelé sur une page dont le titre contient "Access Denied", "Error 1015", ou "Error 1020", THE ChallengeDetector SHALL retourner `"blocked"`.

6. WHEN `detectChallengeType` est appelé sur une page dont le titre contient "Under Attack" ou dont l'élément `#cf-please-wait` est présent sans iframe Turnstile, THE ChallengeDetector SHALL retourner `"iuam"`.

7. THE ChallengeDetector SHALL distinguer `"managed"` (présence de `_cf_chl_opt` sans iframe visible) de `"iuam"` (présence de `#cf-please-wait` sans `_cf_chl_opt.cType === "managed"`).

8. WHEN `detectChallengeType` est appelé sur une page dont `window._cf_chl_opt.cType === "interactive"`, THE ChallengeDetector SHALL retourner `"turnstile"`.

9. WHEN le cookie `cf_clearance` est déjà présent dans la page et qu'aucun signal de challenge n'est détecté, THE ChallengeDetector SHALL retourner `"none"`.

---

### Requirement 2 : Patches stealth enrichis (SeleniumBase UC Mode)

**User Story:** En tant que développeur du Solver, je veux que chaque session Chromium soit patché de manière exhaustive avant toute navigation, afin que Cloudflare ne puisse pas identifier le navigateur comme automatisé.

#### Acceptance Criteria

1. THE StealthManager SHALL patcher `navigator.webdriver` via `Object.defineProperty` avec un `Proxy` trap pour retourner `undefined`, de sorte que la propriété ne soit ni `true` ni détectable comme étant définie.

2. THE StealthManager SHALL simuler un `AudioContext` cohérent en patchant `AudioBuffer.getChannelData` et `AnalyserNode.getFloatFrequencyData` pour retourner des données légèrement bruitées de manière déterministe par session (même valeur à chaque appel dans la même session).

3. THE StealthManager SHALL patcher `HTMLCanvasElement.toDataURL` pour ajouter un bruit de pixel déterministe par session, de sorte que l'empreinte canvas ne corresponde pas à celle d'un headless Chrome générique.

4. THE StealthManager SHALL exposer une API `navigator.getBattery()` qui retourne un objet `{ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 }`.

5. THE StealthManager SHALL définir `navigator.connection.effectiveType` à `"4g"` et `navigator.connection.downlink` à `10`.

6. WHEN une `proxyGeoTimezone` est fournie aux options du StealthManager, THE StealthManager SHALL aligner `Intl.DateTimeFormat().resolvedOptions().timeZone` et `Date.prototype.getTimezoneOffset` avec la timezone fournie.

7. THE StealthManager SHALL appliquer les patches `navigator.plugins`, `navigator.mimeTypes`, `WebGLRenderingContext.getParameter`, et `window.chrome` déjà présents dans la v1.

8. WHEN `preparePageStealth` est appelé deux fois successivement sur la même instance `Page`, THE StealthManager SHALL ne pas lever d'exception et SHALL produire des propriétés `navigator` observables identiques au second appel.

9. THE StealthManager SHALL appeler `page.bringToFront()` avant chaque résolution de challenge pour simuler un onglet au premier plan.

---

### Requirement 3 : Mouvement de souris humanisé (Bezier + scroll)

**User Story:** En tant que développeur du TurnstileClickSolver, je veux simuler des mouvements de souris et du scroll humains avant de cliquer sur un widget Turnstile, afin que le comportement ne soit pas détecté comme automatisé.

#### Acceptance Criteria

1. WHEN le TurnstileClickSolver doit cliquer sur le widget Turnstile, THE TurnstileClickSolver SHALL générer une trajectoire de souris via une courbe de Bézier cubique entre une position de départ aléatoire et la cible, avec entre 20 et 40 points intermédiaires.

2. THE TurnstileClickSolver SHALL dispatcher chaque point intermédiaire comme un événement CDP `Input.dispatchMouseEvent` de type `mouseMoved`, avec un délai entre 2ms et 18ms entre les points (distribution non uniforme, plus lente au début et à la fin).

3. THE TurnstileClickSolver SHALL effectuer un scroll naturel vers l'iframe Turnstile via `window.scrollBy` avant d'initier la trajectoire de souris, si l'iframe n'est pas visible dans le viewport.

4. THE TurnstileClickSolver SHALL appliquer un délai de 80ms à 250ms entre le dernier `mouseMoved` et le `mousePressed` (temps de réflexion humain).

5. THE TurnstileClickSolver SHALL appliquer un délai de 40ms à 150ms entre `mousePressed` et `mouseReleased` (durée de clic humain).

6. WHEN le clic est effectué, THE TurnstileClickSolver SHALL ajouter un jitter de ±3px sur les coordonnées X et Y du `mouseReleased` par rapport au `mousePressed`.

7. THE TurnstileClickSolver SHALL attendre entre 1.5s et 3.5s après la navigation initiale avant d'initier la détection du type de challenge (délai post-navigation variable).

---

### Requirement 4 : Résolution par stratégies en cascade

**User Story:** En tant que développeur du Solver, je veux que le Solver tente les stratégies de résolution dans un ordre optimal (passive d'abord, puis interactive, puis fallback externe), afin de maximiser le taux de succès tout en minimisant le temps de résolution et le coût.

#### Acceptance Criteria

1. WHEN le type de challenge est `"jsd"`, `"managed"`, ou `"iuam"`, THE CfSolverOrchestrator SHALL d'abord attendre passivement que le cookie `cf_clearance` apparaisse (JSD natif Chromium) pendant au maximum 65s pour `"jsd"`, 45s pour `"iuam"`, et 30s pour `"managed"`.

2. WHEN l'attente passive dépasse son timeout sans succès et que le type est `"managed"` ou `"unknown"`, THE CfSolverOrchestrator SHALL re-détecter le type de challenge et escalader vers `TurnstileClickSolver` si une iframe Turnstile est désormais présente.

3. WHEN le type de challenge est `"turnstile"`, THE CfSolverOrchestrator SHALL appliquer directement `TurnstileClickSolver` sans attente JSD passive.

4. WHEN toutes les stratégies natives (JSD passif + clic Turnstile) ont échoué et que la variable d'environnement `CAPSOLVER_API_KEY` est définie, THE CfSolverOrchestrator SHALL tenter le fallback CapSolver via `solveTurnstileInPage` de `capsolver-turnstile.ts`.

5. WHEN le type de challenge est `"blocked"`, THE CfSolverOrchestrator SHALL retourner immédiatement `{ success: false, challengeType: "blocked" }` sans tenter de résolution.

6. WHEN le type de challenge est `"none"`, THE CfSolverOrchestrator SHALL retourner immédiatement `{ success: true, cfClearance: <valeur ou undefined> }` sans aucun traitement supplémentaire.

7. THE CfSolverOrchestrator SHALL inclure dans chaque résultat le champ `solvedBy` indiquant la stratégie qui a réussi parmi : `"already_cleared"`, `"jsd_passive"`, `"iuam_wait"`, `"turnstile_cdp"`, `"capsolver_fallback"`.

---

### Requirement 5 : Cache TTL des sessions cf_clearance

**User Story:** En tant que développeur du Solver, je veux mettre en cache les sessions `cf_clearance` par domaine avec un TTL basé sur l'expiration réelle du cookie, afin d'éviter de re-résoudre des challenges inutilement et de réduire la latence pour les portails déjà clearés.

#### Acceptance Criteria

1. THE SessionCache SHALL stocker les sessions indexées par domaine (`string`) dans une `Map` en mémoire, chaque entrée contenant au minimum `{ cfClearance: string, cookies: Array<{name: string, value: string}>, obtainedAt: number, expiresAt: number }`.

2. WHEN `getCachedSession(domain)` est appelé avant l'expiration (`Date.now() < expiresAt`), THE SessionCache SHALL retourner l'entrée avec `isValid: true`.

3. WHEN `getCachedSession(domain)` est appelé après l'expiration (`Date.now() >= expiresAt`), THE SessionCache SHALL retourner `null` (ou `undefined`).

4. WHEN `getCachedSession(domain)` est appelé avec un `expiresAt` tel que `expiresAt - Date.now() < 5 * 60 * 1000` (moins de 5 minutes avant expiration), THE SessionCache SHALL retourner l'entrée avec le flag `nearExpiry: true` pour permettre un renouvellement proactif.

5. THE SessionCache SHALL exposer une fonction `invalidateSession(domain: string): void` qui supprime immédiatement l'entrée pour le domaine donné.

6. THE SessionCache SHALL exposer une fonction `setCachedSession(domain: string, session: CfSession): void` pour stocker ou mettre à jour une session.

7. THE SessionCache SHALL exposer des métriques accessibles via `getCacheMetrics()` retournant `{ totalSolves: number, cacheHits: number, cacheMisses: number, averageSolveDurationMs: number }`.

8. WHERE la variable d'environnement `CF_SESSION_CACHE_FILE` est définie, THE SessionCache SHALL persister le cache sur disque (JSON) à chaque mise à jour et le recharger au démarrage du process.

---

### Requirement 6 : Orchestration retry avec rotation IP Decodo

**User Story:** En tant que développeur du Solver, je veux que `solveWithRetry` orchestre plusieurs tentatives avec rotation d'IP Decodo et backoff exponentiel, afin de surmonter les blocages d'IP et les challenges persistants.

#### Acceptance Criteria

1. THE CfSolverOrchestrator SHALL accepter un paramètre `maxRetries` (défaut : 5) et ne SHALL jamais exécuter plus de `maxRetries` tentatives au total.

2. WHEN une tentative échoue, THE CfSolverOrchestrator SHALL attendre `2^(attempt-1) * 2000ms` (backoff exponentiel : 2s, 4s, 8s, 16s…) plafonné à 20s avant la prochaine tentative.

3. WHEN une tentative échoue et que le pool Decodo contient plusieurs IPs, THE CfSolverOrchestrator SHALL appeler `rotateDecodoUrl()` de `spain-decodo-pool.ts` pour avancer vers l'IP suivante avant la tentative suivante.

4. WHEN une tentative échoue et que le proxy est une URL unique (pool mono-entrée), THE CfSolverOrchestrator SHALL générer un nouveau `sessionid` aléatoire dans le username du proxy (`-sessionid-{random8chars}`) pour chaque tentative.

5. THE CfSolverOrchestrator SHALL logger l'URL Decodo utilisée pour chaque tentative (en masquant le mot de passe) avec le format `[cf-solver] 🔄 Tentative N/maxRetries — proxy: <masked_url>`.

6. THE CfSolverOrchestrator SHALL purger les données CF stales (cookies `cf_clearance`, `PHPSESSID`, localStorage CF, ServiceWorkers) avant chaque tentative via `purgeCfStaleData`.

7. THE CfSolverOrchestrator SHALL naviguer vers la cible avec cache-bust CDN (`?_cb=<timestamp>` + headers `Cache-Control: no-cache`) avant chaque tentative pour garantir des nonces JSD fraîches.

8. WHEN toutes les tentatives sont épuisées, THE CfSolverOrchestrator SHALL retourner `{ success: false, error: "Échec après N tentatives avec rotation IP: <lastError>" }`.

---

### Requirement 7 : Compatibilité et exports rétrocompatibles

**User Story:** En tant que développeur des portails espagnol et autres, je veux que les exports publics du module v2 soient identiques à ceux de la v1, afin de ne pas avoir à modifier les modules appelants lors de la migration.

#### Acceptance Criteria

1. THE Solver SHALL exporter les fonctions `solveCfChallenge(page, options)`, `solveCfChallengeWithRetry(page, browser, options)`, `preparePageStealth(page, ua?)`, et `detectChallengeType(page)` avec les mêmes signatures qu'en v1.

2. THE Solver SHALL exporter les types `CfChallengeType`, `CfSolveResult`, `CfSolveOptions`, et `CfSolveWithRetryOptions` avec les mêmes champs qu'en v1 (ajouts de champs optionnels autorisés, suppressions interdites).

3. THE Solver SHALL exporter les utilitaires internes `findTurnstileIframe`, `computeTurnstileClickCoords`, `humanLikeCdpClick`, `waitForClearance`, `isTurnstileResolved`, `getClearanceValue`, `getAllCookies`, et `buildRotatedProxyUrl` pour ne pas casser les imports existants.

4. THE Solver SHALL exporter les nouvelles fonctions `getCachedSession`, `invalidateSession`, `setCachedSession`, et `getCacheMetrics` du SessionCache.

5. THE Solver SHALL ne pas introduire de dépendances npm supplémentaires sauf justification explicite dans les commentaires du code.

---

### Requirement 8 : Logging standardisé et métriques

**User Story:** En tant que développeur opérant le hunter en production, je veux des logs clairs et des métriques de performance, afin de diagnostiquer rapidement les échecs et d'optimiser les stratégies.

#### Acceptance Criteria

1. THE Solver SHALL préfixer tous les messages de log avec `[cf-solver]` suivi d'un emoji contextuel : `🚀` démarrage, `✅` succès, `❌` échec, `⚠️` avertissement non fatal, `🔄` retry/rotation, `⏳` attente, `🔍` détection, `🛡️` stealth, `💾` cache.

2. THE Solver SHALL logger le type de challenge détecté, la stratégie appliquée, et la durée totale de résolution en ms pour chaque appel à `solveCfChallenge`.

3. THE Solver SHALL ne jamais logger la valeur complète de `cf_clearance`, d'un token CapSolver, ou d'un mot de passe proxy — seulement les 30 premiers caractères ou une version masquée.

4. WHEN une session est servie depuis le cache, THE Solver SHALL logger `[cf-solver] 💾 Cache hit — domaine: <domain> — TTL restant: <N>s`.

5. THE Solver SHALL exposer via `getCacheMetrics()` les compteurs `totalSolves`, `cacheHits`, `cacheMisses`, et `averageSolveDurationMs` incrémentés à chaque appel.

---

### Requirement 9 : Conformité TypeScript strict

**User Story:** En tant que développeur du monorepo VisaFlow, je veux que le module v2 compile sans erreur en mode TypeScript strict, afin de maintenir la qualité du code et d'éviter les bugs de type à l'exécution.

#### Acceptance Criteria

1. THE Solver SHALL compiler sans erreur avec `tsc --noEmit --strict` dans le contexte du `tsconfig.json` de `artifacts/slot-hunter`.

2. THE Solver SHALL n'utiliser aucun type `any` — les données inconnues (réponses d'API browser, `page.evaluate`, CDP) SHALL être typées via `unknown` et validées par type guards ou assertions explicites.

3. THE Solver SHALL typer le retour de toutes les fonctions exportées de manière explicite (pas d'inférence implicite sur les exports).

4. IF une dépendance externe est utilisée, THEN THE Solver SHALL importer uniquement ses types avec `import type { ... }` lorsque possible.
