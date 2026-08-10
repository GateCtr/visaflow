---
name: Spain impit TLS session reuse
description: Pourquoi impit retourne 0B sur citaconsular.es/Bookitit, et comment le fixer.
---

## La règle

**La même instance impit qui a résolu le CF challenge DOIT être utilisée pour tous les appels JSONP/main suivants.** Une nouvelle instance ouvre une nouvelle session TLS → CF/Bookitit retourne 0B silencieux.

## Pourquoi AntiCloudflareTask = 0B garanti

`AntiCloudflareTask` fait ouvrir une connexion Chrome par CapSolver. CF lie `cf_clearance` au fingerprint TLS **de CapSolver**, pas au nôtre. Quand impit appelle ensuite `/main/` avec ce cookie, CF voit une TLS différente → rejette → 0B.

## Le bon flow 100% HTTP

1. Probe GET via `probeImpit` (notre instance)
2. Si pas de CF : stocker `probeImpit` dans `_spainImpit` → même TLS pour JSONP ✅
3. Si CF challenge : `solveViaImpit(url, proxy)` → extrait sitekey → CapSolver `AntiTurnstileTaskProxyLess` (token seulement, CapSolver n'ouvre pas de connexion) → POST solution via le même `probeImpit` → CF lie `cf_clearance` à notre TLS ✅
4. Stocker l'instance solvante : `_spainImpit = getSpainImpitInstance()`

**Why:** CF vérifie la cohérence entre la TLS session qui a POSTé la solution et les TLS sessions suivantes. Chaque `new Impit()` crée une nouvelle session TLS → mismatch → 0B.

**How to apply:**
- Ne jamais appeler `AntiCloudflareTask` pour citaconsular.es (TLS mismatch)
- Toujours synchroniser `_spainImpit` avec `getSpainImpitInstance()` après `solveViaImpit()`
- Le chemin `SPAIN_SESSION_MODE=impit` nécessite la même synchronisation (déjà corrigé)
- Script de diagnostic : `scripts/test-spain-impit-tls.ts` — confirme l'hypothèse avec same-impit vs new-impit

## Fichiers concernés

- `spain-soax-solver.ts` : `getSpainImpit()`, `ensureSpainCfSession()` (probe direct + CF path)
- `spain-impit-session.ts` : `solveViaImpit()`, `getSpainImpitInstance()`, `_sessionImpit`
- `spain-http-scanner.ts` : utilise `spainCfFetch` → `getSpainImpit()` → doit retourner l'instance solvante
