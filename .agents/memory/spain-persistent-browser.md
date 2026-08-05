---
name: Spain persistent-browser mode
description: CF/impit asymmetry, session rules, cf_clearance deletion fix, Chromium path, full install + Saopola e2e test confirmed 2026-07-30.
---

# Spain persistent-browser mode

## Rule: NEVER delete cf_clearance before clicking Continuar

**Why:** CF ≥ 2026-07 fires a spontaneous JSD oneshot immediately when cf_clearance is deleted (even before Continuar is clicked). This JSD gives a "cookie fantôme" (CF validates the session without re-emitting cf_clearance). When the widget's JS then calls `/main/` via XHR, cf_clearance is absent from the browser cookies → CF returns 200 text/html 0B silently.

The old deletion logic was intended to force a fresh cf_clearance via the POST Continuar JSD, but CF now fires JSD spontaneously on deletion instead of after POST.

**Fix applied:** Removed the `cfClearedBeforeClick` deletion block (lines ~1339-1351 pre-fix). The cf_clearance obtained during the initial JSD navigation is already fresh and valid — no need to delete it.

**How to apply:** Do NOT add back any `page.deleteCookie({ name: "cf_clearance" })` call between the JSD solve and the Continuar click. If `/main/` returns 0B again, check if cf_clearance is present in the browser at the moment the widget calls it.

## Rule: /main/ MUST go through Chrome (not impit)

CF validates `/main/` based on the TLS fingerprint + cf_clearance combination. impit cannot replicate this — only Chrome's actual XHR/fetch triggers CF acceptance. The scan captures `/main/` via CDP Network.loadingFinished (listening to the XHR the widget JS makes naturally after Continuar is clicked).

**Why impit fails for /main/:** CF ties the cf_clearance to the Chrome TLS fingerprint established during the JSD solve. impit has a different TLS fingerprint → CF returns 0B even with a valid cf_clearance cookie.

## Rule: JSONP endpoints en mode PB → browser direct (pas impit-first), même avec IPs fixes

Testé en live 2026-08-04 : impit retourne 0B systématiquement pour getwidgetconfigurations/ et getservices/ même quand `session.soaxProxyUrl` = exact port Decodo utilisé par Chromium (même IP fixe).

**Cause racine :** Le PHPSESSID est lié à la **session TLS Chromium** (JA3/JA4), pas seulement à l'IP. impit simule Chrome TLS mais diverge sur les détails fin (cipher suite order, ticket session) → serveur Bookitit rejette avec 0B silencieux.

**Comportement correct (actuel) :** `callBookititEndpointViaBrowser` d'abord → sert depuis le cache CDP capturé pendant le solve (370B getwidgetconfigurations, 852B getservices) → aucun réseau live. Très rapide.

**Ne pas faire :** Inverser la priorité (impit first) → ajoute un aller-retour réseau inutile (impit 0B) avant le hit cache. Testé et revert fait.

## CF JSD flow (2026-07+)

1. Chrome navigates to citaconsular.es → CF challenge
2. JSD natif runs → cf_clearance emitted (fresh, tied to our Chromium TLS)
3. Click Continuar (cf_clearance still present — do NOT delete it)
4. POST Continuar → CF may fire JSD oneshot spontaneously (cookie fantôme or real re-emission)
5. Widget JS calls /main/ as XHR — CDP captures via Network.loadingFinished
6. cf_clearance is present → CF returns JSONP content

## Interceptor behavior

- If no spontaneous JSD before Continuar: Fetch interceptor armed, waits for JSD POST (8s timeout). On timeout, cf_clearance is still in browser → /main/ returns content after release.
- If JSD fired before Continuar (jsdOneShotAt > 0): interceptor NOT armed, /main/ captured freely via Network.loadingFinished.

## Chromium path

After `playwright install chromium`:
```
/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
```
Reinstall if cache purged: `cd artifacts/slot-hunter && node_modules/.bin/playwright install chromium`

## Rule: closeAndInvalidate() MUST delete the Redis key

**Why:** `closeAndInvalidate()` resets `_cachedSession = null` but without deleting the Redis key, `ensureSession()` on the very next cycle restores the same broken session (prefetch: 0B, `_page null`) → `/main/ browser → 0B` → `closeAndInvalidate` → Redis restore → infinite loop. Confirmed on Railway 2026-07-30.

**Fix applied:** `closeAndInvalidate()` now calls `removeSpainCfSessionFromRedis()` before closing the browser.

## Rule: never restore a Redis session with prefetch: 0B

**Why:** A session stored with no `prefetchedMainHtml` requires an active `_page` (browser) to call `/main/` via browser. After a redeploy, `_page` is null. Restoring such a session → `callBookititEndpointViaBrowser` → `_page null` → 0B → same loop.

**Fix applied:** `ensureSession()` checks `prefetchedMainHtml.length > 0` before restoring from Redis; if 0B, deletes the key and falls through to a full CF solve.

## Rule: cookie fantôme + /main/ 0B → reset PHPSESSID uniquement + re-navigation

**Root cause (confirmed 2026-07-31):** La nonce JSD est time-windowed et liée au PHPSESSID Bookitit. Le JSD natif la consomme pendant le CF Managed Challenge initial. Le widget JS tente la même nonce post-Continuar → CF répond "cookie fantôme" (nonce déjà utilisée, pas de nouveau cf_clearance). Bookitit exige que le JSD post-Continuar émette un cf_clearance frais → `/main/` retourne 0B. Ce problème survient SYSTÉMATIQUEMENT lors de la création/renouvellement de session (chaque solve consomme la nonce via JSD natif).

**Fix appliqué:** Après cookie fantôme + 0B, block "retry" entre le finally et le fetch direct :
1. Supprimer UNIQUEMENT PHPSESSID (pas cf_clearance) + purger localStorage/IndexedDB → Bookitit crée une nouvelle session PHP → CF génère une nonce fraîche liée à ce nouveau PHPSESSID
2. Re-naviguer vers le widget → CF ne re-challenge PAS (cf_clearance valide) → pas de JSD natif → nonce préservée
3. Nouveau Continuar → widget JSD consomme la nonce fraîche EN PREMIER → cf_clearance réémis → `/main/` retourne 124KB

**How to apply:** Ne jamais supprimer cf_clearance dans ce retry. La suppression cf_clearance déclencherait un nouveau CF challenge → JSD natif consommerait la nouvelle nonce → même problème. Seul PHPSESSID doit être purgé.

## Rule: Chrome 96+ cookies path — Default/Network/Cookies, pas Default/Cookies

**Root cause (confirmed 2026-07-31):** Depuis Chrome 96, les cookies sont stockés dans `Default/Network/Cookies` (sous-répertoire Network), pas `Default/Cookies`. Le purge disque pré-lancement ciblait `Default/Cookies` → fichier inexistant → cf_clearance stale survit → Chrome démarre avec l'ancienne session → CF sert la même nonce morte → JSD oneshot → cookie fantôme → `/main/` 0B systématique.

Symptôme caractéristique : `✅ cf_clearance obtenu via JSD natif (1s)` — un vrai solve prend 10-40s, 1s = cookie chargé depuis disque non purgé.

**Fix appliqué:** `purgeProfileCacheOnDisk()` purge maintenant `"Default/Cookies"` ET `"Default/Network"` (couvre les deux générations de Chromium).

**How to apply:** Si le solve prend <3s, c'est un cf_clearance récupéré du profil, pas un vrai JSD solve. Vérifier que `Default/Network/Cookies` est bien absent du profil avant le lancement.

## Rule: IP de confiance CF (fast-track) → Round 2 TOUJOURS tenté, jsdSolveMs ne doit PAS bypasser Round 2

**Diagnostic corrigé (2026-08-04):** L'hypothèse "IPs DC = fast-track systématique = Round 2 inutile" était fausse. Même avec des IPs DC (dc.decodo.com), CF ne fast-tracke pas toujours, et le problème du phantom cookie est lié à la nonce PHPSESSID, pas à l'IP. Round 2 (reset PHPSESSID uniquement) fonctionne avec les IPs DC.

**Root cause réelle du phantom cookie :** La nonce JSD est liée au PHPSESSID côté serveur. Le JSD natif consomme la nonce lors du solve initial. Le widget tente la même nonce post-Continuar → phantom. Le reset PHPSESSID crée un nouveau PHPSESSID → nouvelle nonce → Round 2 résout le problème INDÉPENDAMMENT du type d'IP.

**Ancien code incorrect (supprimé) :** `if (jsdSolveMs < 3000ms) { skip Round 2; }` et `if (jsdSolveMs < 3000ms) { closeAndInvalidate(); return null; }`. Ces deux bypasses basés sur `jsdSolveMs` ont été retirés.

**Fix appliqué (2026-08-04):** Round 2 s'exécute TOUJOURS quand `prefetchedMainHtml < 100B && jsdOneShotAt > 0 && !jsdOneShotAccepted`, sans condition sur `jsdSolveMs`. La détection fast-track `isFastTrack` reste pour le choix de l'intercepteur Fetch (si fast-track, pas d'intercepteur POST Continuar car CF ne refirerait pas de JSD POST), mais ne saute plus Round 2.

**Résultat confirmé en live (2026-08-04):** Avec dc.decodo.com:10002, cf_clearance obtenu en 1s (fast-track), JSD phantom, Round 2 exécuté → `/main/` retourne 124117B ✅. Scanner tourne toutes les 10s avec session réutilisée sur 115min.

**How to apply:** Ne jamais utiliser `jsdSolveMs` pour bypasser Round 2. Si Round 2 échoue aussi (0B), ne pas `closeAndInvalidate` immédiatement — laisser le scanner HTTP gérer les retries.

**Tableau comportements CF (corrigé):**
| Scénario | JSD solve time | JSD post-Continuar | Round 2 | /main/ |
|---|---|---|---|---|
| IP inconnue | 10-40s → vrai cf_clearance | nouveau cf_clearance ✅ | non nécessaire | 124KB ✅ |
| IP DC fast-track | ~1s → phantom | phantom ❌ | reset PHPSESSID → nonce fraîche → 124KB ✅ | 124KB ✅ |

## Rule: nonce age > 50min → skip Round 2, closeAndInvalidate directement

**Root cause:** Quand la nonce JSD encode un timestamp > 50min, la fenêtre temporelle CF entière est expirée. CF force un re-challenge complet sur toutes les requêtes, même avec localStorage intact. Round 2 (reset PHPSESSID seul) ne peut pas régénérer la fenêtre CF.

**Fix appliqué (2026-08-05):** `nonceAgeRef: { ms: number }` déclaré dans `_resolveWithTurnstileInjection` et passé à `setupPageProxyAuth` (4ème arg). Avant Round 2, guard: si `nonceAgeRef.ms > 50 * 60_000` → warn + skip Round 2, laisser le prochain cycle faire un solve frais. Sinon, Round 2 tourne normalement.

**How to apply:** Ne jamais baser la décision Round 2 sur `jsdSolveMs`. Seul l'âge de la nonce (encodé dans le script JSD) détermine si la fenêtre CF est encore valide.

## Rule: decodo-proxies.csv credentials — vérifier avant utilisation

**Root cause (2026-08-05):** Le CSV `dc.decodo.com` avec user `sp8zzigoui` était expiré → Chrome `ERR_TOO_MANY_RETRIES` sur toutes les IPs → tous les scans Spain bloqués. `getCurrentDecodoUrl()` prend la priorité sur `DECODO_PROXY_URL` — si le CSV a des credentials invalides, tout échoue silencieusement.

**Fix:** Mettre à jour `decodo-proxies.csv` avec les nouveaux credentials. Pour bypasser le CSV temporairement: `DECODO_PROXY_FILE=/nonexistent` → tombe sur `DECODO_PROXY_URL`. Pour tester la connectivité proxy: `curl --proxy "http://user:pass@dc.decodo.com:10001" https://ip.decodo.com/json`.

**How to apply:** Si Spain watcher retourne `cf_blocked` en <3s avec `ERR_TOO_MANY_RETRIES`, vérifier les credentials CSV en premier (proxy auth échoue → Chrome boucle sur 407 → abandonne).

## Saopola e2e test (confirmed working 2026-08-05)

```bash
redis-server --daemonize yes --logfile /tmp/redis.log
cd artifacts/slot-hunter && node_modules/.bin/tsx src/test-saopola-live.ts
```

Expected: `✅ Scan: found` + `✅ Booking: signin_failed` (wrong credentials rejected = success).
Typical timing: Scan ~50s, Booking ~10s.
Note: si `cf_blocked` en <3s → credentials CSV expirés (voir rule ci-dessus).
