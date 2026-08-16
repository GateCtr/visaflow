---
name: Spain Bookitit direct module
description: getservices/ one-response-per-PHPSESSID rule; fix via spain-bookitit-direct.ts using impit.fetch directly
---

## Règle critique : getservices/ one-response-per-PHPSESSID

`getservices/` (comme `getagendas/`) ne retourne une réponse valide qu'UNE SEULE FOIS par PHPSESSID. Tout appel suivant avec le même PHPSESSID retourne 0B.

**Symptôme :** `callBookititEndpoint` → `spainCfFetch` → `impit.fetch` pour `getservices/` retourne 0B, alors qu'un appel direct `impit.fetch(url, { headers: cookieHeader() })` fonctionne — MAIS uniquement en tant que premier appel.

**Cause racine :** `callBookititEndpoint`/`spainCfFetch` ajoutent des headers supplémentaires (`Accept-Language`, `Accept-Encoding`, `Sec-Ch-Ua`, etc.) absents du dynamic test. Cela constitue une requête "différente" aux yeux du serveur Bookitit, et peut déclencher un comportement de déduplication différent. Le diagnostic a prouvé que la première vraie requête via `impit.fetch` avec les headers exacts du dynamic test fonctionne.

## Fix : spain-bookitit-direct.ts

Module créé pour encapsuler exactement les fonctions du dynamic test :
- `buildDynamicSession(session)` → `DynamicSession` (impit + jar + jqCallback + reqCounter)
- `callDirect(ds, endpoint, extra?)` → même appel que `impit.fetch(makeUrl(...), { headers: cookieHeader() })`
- `makeDirectUrl(ds, endpoint, extra?)` → ordre des params identique au dynamic test
- `makeDirectHeaders(ds)` → headers minimaux du dynamic test (sans Sec-Ch-Ua, Accept-Language, etc.)

**Why:** Le dynamic test a prouvé son fonctionnement depuis le début. `callBookititEndpoint`/`spainCfFetch` était une réimplémentation qui introduisait des différences de headers causant 0B sur les endpoints à réponse unique.

**How to apply:**
- `initPhpState` : utiliser `buildDynamicSession` + `callDirect` pour `getwidgetconfigurations/`, `getservices/`, `getagendas/`
- `scanDatetimeDirect` : utiliser `phpState.ds` (DynamicSession stocké dans WorkerPhpState) + `callDirect` pour `datetime/`
- Ne JAMAIS appeler `callBookititEndpoint`/`spainCfFetch` pour ces 4 endpoints dans le worker
- `callBookititEndpoint` reste valable pour le booking (signin/, summary/, selectservice/, etc.)

## WorkerPhpState

Contient maintenant `ds: DynamicSession` — le DynamicSession doit être partagé entre `initPhpState` et `scanDatetimeDirect` pour maintenir le `reqCounter` cohérent.

## Résultats confirmés (tests live 2026-08-16)

Worker RANIA GHOUL, Kinshasa portal :
- `getservices/` → 2 services ✅ (dont "TRAMITACIÓN DE VISADOS" bkt1181774)
- `getagendas/` → agenda=(vide) ✅ (normal, portail hors publication)
- `datetime/` → 0B correct ✅ (pas de créneaux publiés — comportement attendu)

Worker TEST CUBA, portail Cuba LMD, proxy es.decodo.com index 5419 :
- `getservices/` → 2 services ✅ (dont "PRESENTACIÓN DE DOCUMENTACIÓN LEY MEMORIA DEMOCRÁTICA" bkt897578)
- `getagendas/` → agenda=bkt316096 ✅
- `datetime/` → 225 créneaux sept, 207 oct ✅ — booking déclenché sur 2026-09-01 09:00
- `getsigninfields/` → ✅ nonce amorcé (réponse non-0B)
- `signin/` → ✅ "Usuario o contraseña incorrectos" — serveur a bien traité la requête (faux identifiants attendus)
- ISP proxies (`es.decodo.com`) fonctionnent pour Cuba aux indices > 5419 — les premiers indices (0-10) étaient brûlés
- Fix pickDedicatedProxy : démarre à `getDecodoCurrentIndex()` (index Redis persisté) plutôt qu'à 0
- Fix booking : suppression du `refreshPhpsessidForCapsolver` + re-init PHP ; getsigninfields/signin/summary utilisent `callDirect(phpState.ds)` sur le même PHPSESSID
- Post-signin, `2026-08` retourne toujours `0 (0B)` le cycle suivant (comportement serveur, 1 mois seulement → n'est pas allMonthsDead)
- 3-worker parallel confirmé stable (indices 5432-5434) : tous init OK, 214 créneaux, signin → "Usuario o contraseña incorrectos"
- Dead-session rotation : consecutiveDeadCycles >= 2 → rotateWorkerIp + re-initPhpState automatique (évite spinning sur proxy brûlé)
