---
name: Spain multi-dossier parallel booking
description: Two bugs found and fixed for concurrent booking (Promise.all) in persistent-browser mode; test confirmed working 2026-07-30.
---

# Spain multi-dossier parallel booking

## Bug 1 — Mutex trop étroit (TargetCloseError / detached Frame)

**Rule:** `acquireBrowserBookingLock()` doit sérialiser TOUT le flow browser (getagendas → datetime → signin → summary), pas seulement `submitSigninFormViaDOM`.

**Why:** `callBookititEndpointBrowser` et `jQueryAjax` utilisent aussi `this._page` (singleton Chromium). Deux dossiers en Promise.all se marchaient dessus dès le premier appel JSONP → TargetCloseError / detached Frame.

**Fix:** `acquireBrowserBookingLock()` dans `spain-persistent-browser.ts` (chain de promesses). Acquis dans `executeHttpBooking` juste avant le flow complet (ligne ~563), libéré dans le `finally` de la fonction.

**How to apply:** Si `TargetCloseError` ou `detached Frame` réapparaît en mode browser, vérifier que le lock est acquis AVANT tout appel `callBookititEndpointBrowser` / `jQueryAjax`.

---

## Bug 2 — `invalidateSpainCfSession()` au lieu de `closeAndInvalidate()` sur /main/ 0B

**Rule:** Quand `callBookititEndpointViaBrowser` retourne 0B pour `/main/` dans le scanner, appeler `spainPersistentBrowser.closeAndInvalidate()` — PAS `invalidateSpainCfSession()`.

**Why:** `invalidateSpainCfSession()` invalide seulement Redis mais laisse le browser Chromium ouvert sur la même IP Decodo. La prochaine tentative de scan utilise donc la même IP (déjà bloquée) → 0B à nouveau. `closeAndInvalidate()` ferme le browser, force `rotateDecodoUrl()` au prochain lancement → nouvelle IP → CF répond normalement.

**Fix applied:** `spain-http-scanner.ts` ligne ~1868 — remplacé `invalidateSpainCfSession()` par `await spainPersistentBrowser.closeAndInvalidate()` + ajout de `spainPersistentBrowser` à l'import de `spain-persistent-browser.js`.

**How to apply:** Toute branche qui détecte un `/main/ 0B` en mode Playwright doit appeler `closeAndInvalidate()` et non `invalidateSession`. `invalidateSession` est réservé aux cas où l'IP est saine mais la session Redis est périmée.

---

## Pool Decodo — comportement de rotation

`_index = 0` au démarrage → premier `rotateDecodoUrl()` incrémente à 1 → toujours `[2/10]` (port 10002) au premier run. Ce n'est pas un bug : la rotation fonctionne correctement après chaque `closeAndInvalidate()`. Le port 10002 peut donner `/main/ 0B` ponctuellement, mais après rotation (port 10003+) les réponses sont normales.

---

## Test multi-dossier confirmé (2026-07-30)

```bash
redis-server --daemonize yes --logfile /tmp/redis.log
cd artifacts/slot-hunter && SAOPOLA_N=2 SAOPOLA_MAX_CYCLES=5 npx tsx src/test-saopola-multidossier.ts
```

Durée totale : ~5min (scan 2 cycles ~100s + 2 bookings sérialisés ~120s chacun).  
Attendu : `✅ Scan: found` + chaque dossier → `signin_failed` (credentials faux rejetés).  
Confirmé : lock acquis/libéré sans TargetCloseError, selecttime navigué, signin DOM submit → 244B response.
