---
name: Spain booking cycle session
description: DynamicSession à conserver entre le scan datetime et le booking Bookitit.
---

## Règle

Après `refreshSessionAndScan()`, le booking doit utiliser le `DynamicSession` retourné dans le résultat du cycle pour `getsigninfields/`, `signin/` et `summary/`. Ne pas reconstruire la session depuis les cookies initiaux ni reprendre l’état PHP créé avant le refresh.

**Pourquoi:** Bookitit peut renouveler `PHPSESSID` pendant la création du cycle ou le scan. Un appel `getsigninfields/` avec l’ancien jar peut répondre `0B` même lorsqu’un créneau réel vient d’être trouvé. Le chemin correct a été confirmé sur Saopolo: `getsigninfields/` répond normalement, puis `signin/` renvoie le rejet métier attendu avec de faux identifiants.

**Comment appliquer:** les tests E2E doivent reproduire `initWorkerSession()` puis `refreshSessionAndScan()`, sélectionner un créneau réel, et chaîner tout le booking avec `scan.ds` dans le même contexte TLS et le même jar.