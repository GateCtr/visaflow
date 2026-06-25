---
name: Spain Bookitit fingerprint fixes
description: Audit Burp Chrome 146 vs bot — 3 classes de bugs corrigés dans les 4 callers JSONP Spain; ground truth citaconsular.es.
---

## Audit date
2026-06-25 — Source: Burp Suite embedded browser (Chromium 146) navigating citaconsular.es/Bookitit.

## Bug S1 — JSONP Sec-Fetch-Mode/Dest (CRITICAL)
**Fichiers**: `spain-http-booking.ts` (callBookititEndpoint), `spain-slot-explorer.ts` (callJsonp), `spain-http-scanner.ts` (callBookititJsonp × 2)

Tous les endpoints `/onlinebookings/*` (main/, getwidgetconfigurations/, getservices/, getagendas/, datetime/, signin/, summary/) sont appelés par jQuery $.ajax via XHR — pas via `<script>` tag injection.

| | Était (bot) | Doit être (réel) |
|---|---|---|
| Sec-Fetch-Mode | `no-cors` | `cors` |
| Sec-Fetch-Dest | `script` | `empty` |
| Accept | `*/*` | `text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01` |

**Why:** jQuery's JSONP (dataType:"jsonp") crée un XHR, pas un vrai script tag, sur same-origin. CF inspecte ces headers.

## Bug S2 — Missing high-entropy sec-ch-ua hints (CRITICAL)
**Fichier**: `spain-soax-solver.ts` (spainCfFetch base headers)

Cloudflare envoie `Accept-CH` pour citaconsular.es qui demande les hints high-entropy. Chrome y répond avec des valeurs vides `""` mais **envoie quand même les headers**. Le bot ne les envoyait pas du tout.

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

L'ordre réel Chrome = Not-brand FIRST, puis Chromium, puis Google Chrome.
Le format "Not(X)Brand" change à chaque version — Chrome 136 utilise `"Not/A)Brand";v="8"`.

**Note**: Le Burp browser (Chromium sans Google keys) envoie `"Not-A.Brand";v="24", "Chromium";v="146"` sans Google Chrome brand — c'est spécifique à Chromium non-officiel. Le bot (CapSolver) utilise Chrome officiel → garde Google Chrome brand. Le format corrigé `"Not/A)Brand"` est correct pour Chrome 136.

## Autres observations (non-critiques)
- `Accept-Encoding`: Burp montre `gzip, deflate, br` (pas zstd) mais c'est un artifact Burp — Chrome 120+ supporte zstd, ne pas changer.
- `Accept-Language`: Burp = `fr-FR,fr;q=0.9` (locale user). Bot = `es-ES,...`. CF cookie lié à la session CapSolver qui a sa propre locale — laisser comme est, ou prendre depuis session.extraHeaders si CapSolver le fournit.
- `Priority` header: Chrome 117+ feature (`u=0, i` pour document, `u=1, i` pour XHR). Non-critique pour CF bypass.

## Fichiers modifiés
- `spain-soax-solver.ts` → `spainCfFetch()` base headers: sec-ch-ua hints + Sec-Ch-Ua brand fix
- `spain-http-booking.ts` → `callBookititEndpoint()`: Sec-Fetch + Accept
- `spain-slot-explorer.ts` → `callJsonp()`: Sec-Fetch + Accept  
- `spain-http-scanner.ts` → `callBookititJsonp()` (×2): Sec-Fetch + Accept
