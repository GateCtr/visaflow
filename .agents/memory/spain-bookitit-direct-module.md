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

## Résultat confirmé (test live 2026-08-16)

Worker RANIA GHOUL, Kinshasa portal :
- `getservices/` → 2 services ✅ (dont "TRAMITACIÓN DE VISADOS" bkt1181774)
- `getagendas/` → agenda=(vide) ✅ (normal, portail hors publication)
- `datetime/` → 0B correct ✅ (pas de créneaux publiés — comportement attendu)
- Boucle 30s/cycle tourne → "exited" proprement en fin de fenêtre
