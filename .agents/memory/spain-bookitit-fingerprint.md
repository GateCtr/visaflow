---
name: Spain Bookitit fingerprint fixes
description: Audit Burp Chrome 146 vs bot — 5 classes de bugs corrigés + RUM beacons ajoutés; ground truth citaconsular.es.
---

## Audit date
2026-06-25 — Source: Burp Suite embedded browser (Chromium 146) navigating citaconsular.es/Bookitit.

## Bug S1 — JSONP Sec-Fetch-Mode/Dest (CRITICAL)
**Fichiers**: `spain-http-booking.ts` (callBookititEndpoint), `spain-slot-explorer.ts` (callJsonp), `spain-http-scanner.ts` (callBookititJsonp × 2)

Tous les endpoints `/onlinebookings/*` sont appelés par jQuery $.ajax via XHR — pas via `<script>` tag injection.

| | Était (bot) | Doit être (réel) |
|---|---|---|
| Sec-Fetch-Mode | `no-cors` | `cors` |
| Sec-Fetch-Dest | `script` | `empty` |
| Accept | `*/*` | `text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01` |

**Why:** jQuery's JSONP (dataType:"jsonp") crée un XHR, pas un vrai script tag, sur same-origin. CF inspecte ces headers.

## Bug S2 — Missing high-entropy sec-ch-ua hints (CRITICAL)
**Fichier**: `spain-soax-solver.ts` (spainCfFetch base headers)

Cloudflare envoie `Accept-CH` pour citaconsular.es — Chrome répond avec des valeurs vides `""` mais **envoie quand même les 6 headers**.

Headers ajoutés (valeurs vides, comme Chrome):
- `Sec-Ch-Ua-Platform-Version: ""`
- `Sec-Ch-Ua-Full-Version: ""`
- `Sec-Ch-Ua-Full-Version-List: ""`
- `Sec-Ch-Ua-Arch: ""`
- `Sec-Ch-Ua-Bitness: ""`
- `Sec-Ch-Ua-Model: ""`

**Why:** Absence totale = fingerprint hole détecté par CF. Chrome les envoie toujours en réponse à Accept-CH, même vides.

## Bug S3 — Sec-Ch-Ua brand string (MEDIUM)
Bot envoyait: `"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"`
Corrigé en: `"Not/A)Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`

Ordre réel Chrome = Not-brand FIRST, puis Chromium, puis Google Chrome.
Format "Not(X)Brand" change à chaque version — Chrome 136 utilise `"Not/A)Brand";v="8"`.

**Note**: Burp browser (Chromium sans Google keys) = `"Not-A.Brand";v="24", "Chromium";v="146"` sans Google Chrome brand — artifact Burp. Bot (CapSolver) utilise Chrome officiel → garde Google Chrome brand. Correct.

## Bug S4 — Companion JSONP calls manquants
**Fichier**: `spain-http-scanner.ts` (scanViaMainEndpoint)

Le vrai navigateur fire 3 JSONP en séquence — pas 1 seul :
- `GET /onlinebookings/main/` → t+0 (immédiat)
- `GET /onlinebookings/getwidgetconfigurations/` → t+3046ms (déclenchée par GTM callback)
- `GET /onlinebookings/getservices/` → t+3633ms (9ms après getwidgetconfs/)

**Why:** Les companions arrivent ~3s après main/ (pas simultanément) car GTM doit se charger en premier. Implémenté via fire-and-forget avec délai 2800-3600ms + URLSearchParams frais avec `tNow` correct.

## Bug S5 — CF RUM beacons absents (SHADOW-BAN RISK)
**Fichier**: `spain-http-scanner.ts` (helper `fireRumBeacon` ajouté)

Cloudflare injecte `__cfBeacon` dans toutes ses pages protégées. Ce script fire POST `/cdn-cgi/rum?` après chaque chargement de ressource. Un bot HTTP qui ne fire jamais ces beacons = signal "JavaScript non exécuté" → shadow-ban progressif.

Pattern Burp observé (5 beacons sur 22 requêtes) :
| # Burp | Timing | Corrélation | transferSize |
|---|---|---|---|
| #20 | t+3.6s après POST widget | DOMContentLoaded render | 3676b |
| #24 | t+4.3s après POST widget | JSD oneshot trigger | 678b |
| **#29** | **t+3ms après GET main/** | **← CRITIQUE (direct corrélation)** | 124917b |
| #109 | t+578ms après getwidgetconfs/ | companion loaded | 1170b |
| #114 | t+6.7s après main/ | navigation fin | 680b |

Implémenté : `buildRumBody()` génère JSON avec performance.timing réalistes (jitter), `fireRumBeacon()` fire-and-forget avec délais précis.
- Beacon #20 : après POST token, délai 3400-3800ms
- Beacon #29 : après GET main/, délai 3-11ms ← le plus critique
- Beacon #109 : après companions, délai 500-650ms

**Why:** CF corrèle directement la présence du beacon avec l'exécution JS. Shadow-ban progressif si absent → pas de 403 immédiat mais dégradation lente du bot score.

## Séquence complète Burp (22 requêtes, Chrome 146)
```
#1   GET  widget 403                → CF challenge déclenché
#2   GET  orchestrate script        → CF flow init
#4   POST flow/706703871            → CF citaconsular.es
#6   GET  turnstile iframe          → challenges.cloudflare.com
#8   POST flow/3067715313           → CF challenges.cf.com  
#9   GET  pat/...                   → 401 PAT (normal)
#11  POST flow/3067715313           → CF flow
#12  POST flow/3067715313           → CF HTML
#13  POST flow/706703871            → SET cf_clearance #1    ← CapSolver
#14  POST widget/ (binary body)     → 200 widget render      ← CapSolver  
#20  POST /cdn-cgi/rum?             → 204 RUM #1
#22  POST jsd/oneshot               → SET cf_clearance #2    ← CapSolver
#23  POST widget/ token=a5a8d...    → 200 widget final       ← BOT Step 2
#24  POST /cdn-cgi/rum?             → 204 RUM #2
#27  GET  /onlinebookings/main/     → 200 124917b            ← BOT Step 3a
#29  POST /cdn-cgi/rum?             → 204 RUM #29 CRITIQUE   ← BOT fireRumBeacon
#103 GET  /gtag/js (GTM)            → 200 472kb (ignoré)
#108 GET  /onlinebookings/getwidgetconfigurations/ → 200     ← BOT Step 3b (+3s)
#109 POST /cdn-cgi/rum?             → 204 RUM #109           ← BOT fireRumBeacon
#110 GET  /onlinebookings/getservices/ → 200                 ← BOT Step 3b (+9ms)
#113 POST /g/collect (Analytics)    → ignoré
#114 POST /cdn-cgi/rum?             → 204 RUM #5             (non implémenté, moins critique)
```

## Bug S6 — JSONP parser : préfixe `callback=` non géré (2026-07-30)
**Fichier** : `artifacts/slot-hunter/src/spain/bookitit-client.ts` (`parseJsonpResponse`)

Bookitit retourne parfois :
```
callback=jQuery21103198788804851487_1785413467100({"Client":{...}});
```
L'ancien regex `/^[a-zA-Z0-9_]+\((.*)\);?$/s` ne matchait pas ce format car il ne gérait pas le préfixe `callback=`.

**Fix appliqué :**
```typescript
const jsonpMatch = body.match(/^(?:callback=)?[a-zA-Z0-9_$.]+\((.*)\);?$/s);
```

**Why :** Le préfixe `callback=` est une variante de sérialisation JSONP utilisée par certains endpoints Bookitit (notamment `signin/` via DOM form submit → `waitForResponse`). Sans ce fix, `parseJsonpResponse` tombait sur le fallback JSON-only et échouait avec "Response is not valid JSON or JSONP".

## Autres observations (non-critiques)
- `Accept-Encoding`: Burp = `gzip, deflate, br` (pas zstd) mais artifact Burp — Chrome 120+ supporte zstd, ne pas changer.
- `Accept-Language`: Burp = `fr-FR` (locale user). Bot = `es-ES`. CF cookie lié à session CapSolver — laisser comme est.
- `Priority` header: Chrome 117+ feature (`u=0, i` document, `u=1, i` XHR). Non-critique pour CF bypass.
- RUM #114 (t+6.7s, navigation fin) — non implémenté car très tardif et moins corrélé à une action bot spécifique.
