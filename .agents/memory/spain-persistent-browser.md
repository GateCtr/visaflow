---
name: Spain persistent-browser mode
description: Implementation details, quirks and confirmed fixes for SPAIN_SESSION_MODE=persistent-browser (SpainPersistentBrowserManager).
---

## Architecture

`SpainPersistentBrowserManager._resolveWithTurnstileInjection()` flow (une seule navigation) :
1. `buildRotatedProxyUrl()` — ajoute `-sessionid-XXXX` aléatoire au username Decodo (force nouvelle IP sticky)
2. Purge profil disque (`Default/Cache`, `Default/Code Cache`, `Default/Local Storage`, `Default/IndexedDB`, `Default/Session Storage`, `Default/Service Worker`, `Default/Cache Storage`, **`Default/Cookies`**)
3. Lance Chromium Puppeteer + `userDataDir=/tmp/spain-cf-profile`
4. `page.setCacheEnabled(false)` — désactive cache HTTP pour toutes les navigations
5. CDP : supprime **cf_clearance ET PHPSESSID** (`.citaconsular.es` + `www.citaconsular.es`)
6. **Navigation UNIQUE** `goto(targetUrl, { waitUntil: "load", timeout: 70s })` — CF challenge + widget Bookitit se chargent en parallèle
7. Poll cf_clearance max 65s
8. Arme intercepteur CDP Fetch sur `/onlinebookings/main/*` — attend JSD oneshot max 6s puis **laisse toujours passer** (ne pas annuler)
9. Boucle Continuar (max 60s) : attend que titre ≠ "Un instant…" avant clic
10. Capture body /main/ via CDP `Network.getResponseBody`

## Règles critiques confirmées (2026-07-30)

### Une seule navigation (jamais de 2ème goto vers targetUrl)
Un 2ème `goto(targetUrl)` re-déclenche un challenge CF qui génère un JSD token lié à la SESSION de la 1ère navigation (déjà périmée). Le JSD oneshot est alors refusé même avec une IP fraîche.

**Pourquoi :** CF génère le script `b0da9f4911ba/main.js` (avec son nonce HMAC) lié à la session TLS/IP. Ce nonce a ~15min de validité. La 2ème navigation recharge ce script avec le nonce de la 1ère session → déjà périmé.

### Laisser passer /main/ même si JSD oneshot refusé
CF répond 200 avec le body JSONP complet même si `new-cf_clearance` n'est pas réémis dans le JSD oneshot. Annuler la requête via `Fetch.failRequest` était contre-productif.

**Pourquoi :** Le cf_clearance de base (obtenu lors du JSD natif initial) est suffisant pour `/onlinebookings/main/`. Le js_detection.passed=true n'est pas obligatoire pour cette route.

### Rotation IP Decodo obligatoire
Le port sticky Decodo (`10001`) garde la même IP → CF épingle le même nonce périmé à cette IP. Ajouter `-sessionid-XXXX` (aléatoire 8 chars) au username force Decodo à attribuer une nouvelle IP sticky.

**Pourquoi :** CF associe le nonce JSD à la session IP. Même IP = même nonce périmé quel que soit l'état du profil disque.

### Supprimer PHPSESSID via CDP (pas seulement cf_clearance)
CF lie le challenge Cloudflare au PHPSESSID côté serveur PHP. Sans suppression du PHPSESSID, citaconsular.es renvoie le même nonce périmé dans le HTML de la page.

### Supprimer cf_clearance AVANT le premier clic Continuar
`page.deleteCookie({ name: "cf_clearance", domain: ".citaconsular.es" })` est appelé une seule fois (guard `cfClearedBeforeClick`) juste avant le premier clic Continuar, dans le `else` du guard CF-still-running.

**Pourquoi :** Le cf_clearance obtenu lors du JSD natif initial est "fantôme" — il est lié à la session de navigation initiale. CF n'en émet pas de nouveau si un clearance valide est déjà présent. En le supprimant, CF ne trouve plus de token → le JSD oneshot déclenché par le POST Continuar en émet un nouveau lié à CETTE session POST → /main/ reçoit du contenu réel.

**Important :** Même si le log `new-cf_clearance=❌ non — cookie fantôme` persiste au JSD oneshot, le DOM form submit + `waitForResponse` contourne le problème — la réponse signin/ (242B) est bien capturée. Le cookie fantôme n'empêche pas le flow de fonctionner end-to-end.

### Guard "Un instant…" avant clic Continuar
Ne jamais cliquer Continuar si `document.title` contient "instant"/"moment"/"checking" ou si une iframe `/cdn-cgi/` est encore active. Cliquer trop tôt provoque /main/ = 0B.

## CF protection asymmetry

La page portail (`/es/hosteds/widgetdefault/...`) bloque impit (HTTP 403) même avec cf_clearance valide. Le JSONP API (`/onlinebookings/main/`) accepte ce même cf_clearance (HTTP 200 + body complet).

## Chrome binary

Playwright Chromium (installé via `node_modules/.bin/playwright install chromium`) :
```
/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome
```
Le test-saopola-live.ts lit `CHROMIUM_EXECUTABLE_PATH` ou utilise ce chemin par défaut.

## Installation complète (premier démarrage Replit)

```bash
# 1. Dépendances JS
cd artifacts/slot-hunter && npm install
cd artifacts/captcha-service && npm install
cd artifacts/proxy-service && npm install
cd artifacts/joventy && pnpm install

# 2. Chromium Puppeteer
cd artifacts/slot-hunter && node_modules/.bin/playwright install chromium

# 3. Redis
redis-server --daemonize yes --logfile /tmp/redis.log
```

## Test end-to-end (Saopola live) — confirmé 2026-07-30

```bash
cd artifacts/slot-hunter && node_modules/.bin/tsx src/test-saopola-live.ts
```

Résultat attendu :
- Phase 1 `✅ Scan: found` (~50s)
- Phase 2 `✅ Booking: signin_failed` (~25s) — "Usuario o contraseña incorrectos" avec faux credentials = succès.
