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

## Rule: IP de confiance CF (fast-track) → Round 2 inutile, skip directement

**Root cause (2026-07-31):** Certains ports Decodo sont reconnus par CF comme "fiables" → CF émet cf_clearance en ~1s SANS JSD complet. Quand le widget Bookitit tire son JSD post-Continuar, CF répond "phantom" (déjà valide) → `/main/` = 0B. Le Round 2 (reset PHPSESSID uniquement, garder cf_clearance) échoue également : CF réutilise le **même challenge token** (même timestamp dans `/cdn-cgi/challenge-platform/h/b/…`) → JSD oneshot encore phantom → 0B garanti.

**Pourquoi Round 2 ne peut pas aider pour les IPs de confiance :** CF lie le challenge à l'IP, pas au PHPSESSID. Un reset PHPSESSID ne crée pas une nouvelle session CF pour une IP déjà connue.

**Fix appliqué (2026-07-31):** `jsdSolveMs` mesuré au moment où cf_clearance apparaît. Dans le bloc Round 2 : si `jsdSolveMs < 3000ms` (IP de confiance détectée) → skip Round 2, log explicite, tomber directement dans le fallback fetch puis `closeAndInvalidate` → rotation vers le port Decodo suivant (qui sera peut-être inconnu de CF → JSD complet 10-40s → vrai cf_clearance).

**How to apply:** Si dans les logs on voit `✅ cf_clearance obtenu via JSD natif (1s) ⚡ IP de confiance CF` + JSD phantom → c'est ce scénario. Le fix skip automatiquement Round 2. La vraie résolution est la rotation IP (`closeAndInvalidate` → port suivant).

**Tableau comportements CF:**
| Scénario | JSD solve | JSD post-Continuar | /main/ |
|---|---|---|---|
| IP inconnue | 10-40s → vrai cf_clearance | nouveau cf_clearance ✅ | 124KB ✅ |
| IP de confiance | 1s → phantom | phantom ❌ | 0B ❌ |

## Saopola e2e test (confirmed working 2026-07-30)

```bash
redis-server --daemonize yes --logfile /tmp/redis.log
cd artifacts/slot-hunter && node_modules/.bin/tsx src/test-saopola-live.ts
```

Expected: `✅ Scan: found` + `✅ Booking: signin_failed` (wrong credentials rejected = success).
Typical timing: Scan ~52s, Booking ~60s.
