# Spain Saopolo — Capsolver + Impit Progress

## Date: 2026-08-11

## Ce qui fonctionne (confirmé)
- Capsolver `AntiCloudflareTask` résout le challenge CF interactif en ~15s
- Le `cf_clearance` de Capsolver passe CF sur `/es/hosteds/widgetdefault/` (GET + POST)
- GET portail → HTTP 200, 2681B, token extrait ✅
- POST token → HTTP 200, 2502B (session Bookitit initialisée) ✅
- Le PHPSESSID est posé au GET et conservé au POST (pas de rotation)

## Ce qui ne fonctionne PAS
- GET `/onlinebookings/main/` → HTTP 200, 0B (content-type: text/html)
- Serveur = cloudflare, cf-ray présent → CF qui bloque ou Bookitit qui retourne vide

## Insights clés
1. **Même un vrai navigateur** obtient parfois 0B sur `/main/` (spinner infini)
   - Fix dans le browser : retour arrière + re-POST form → `/main/` fonctionne
   - Ça suggère un problème de TIMING/SESSION, pas de TLS
   
2. **Le challenge CF sur citaconsular.es est "interactive" (pas JSD passif)**
   - `cType: 'interactive'` dans `window._cf_chl_opt`
   - Le JSD solver local ne peut PAS le résoudre (format 2026 externalisé)
   - Seul Capsolver ou un browser peuvent le résoudre

3. **rebrowser-puppeteer-core** élimine la fuite `Runtime.Enable`
   - Avec rebrowser, CF montre le challenge JSD normal (pas "Extension incompatible")
   - Chrome/151 via `channel: "chrome"` fonctionne

4. **impers (curl_cffi Node.js)** ne fonctionne PAS sur Windows (lib native manquante)

## Pistes à explorer
1. **Retry POST+/main/** : si `/main/` retourne 0B, re-GET portail (nouveau token) + re-POST + re-GET `/main/`
2. **Le 0B est peut-être Bookitit** (pas CF) : le content-type devrait être `application/javascript` si Bookitit répond — `text/html` = CF intercepte
3. **Tester sur Linux** avec `impers` (JA3 exact Chrome) pour confirmer si c'est le TLS
4. **Comparer les headers** envoyés par Impit vs un vrai Chrome (TLS fingerprint via tls.peet.ws)
5. **Scope du cf_clearance** : peut-être le cookie est scopé à `/es/hosteds/` et pas au domaine entier

## Fichiers modifiés cette session
- `src/scripts/test-saopolo-capsolver-impit.ts` — script Capsolver + Impit
- `src/scripts/test-saopolo-browser-e2e.ts` — modifié pour laisser widget charger /main/ naturellement
- `src/scripts/test-impit-full-flow.ts` — modifié pour rebrowser-puppeteer-core
- `src/cf-challenge-solver.ts` — Chrome/151 UA
- Tous les fichiers src/ — Chrome 136→151 UA update
- `src/securityCheck.ts` — CURRENT_CHROME_STABLE=151
- Installé: `rebrowser-puppeteer-core`, `impers` (ne fonctionne pas Win)
