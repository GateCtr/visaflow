---
name: Spain booking cycle session
description: DynamicSession à conserver entre le scan datetime et le booking Bookitit.
---

## Règle

Après `refreshSessionAndScan()`, le booking doit utiliser le `DynamicSession` retourné dans le résultat du cycle pour `getsigninfields/`, `signin/` et `summary/`. Ne pas reconstruire la session depuis les cookies initiaux ni reprendre l’état PHP créé avant le refresh.

**Pourquoi:** Bookitit peut renouveler `PHPSESSID` pendant la création du cycle ou le scan. Un appel `getsigninfields/` avec l’ancien jar peut répondre `0B` même lorsqu’un créneau réel vient d’être trouvé. Le chemin correct a été confirmé sur Saopolo: `getsigninfields/` répond normalement, puis `signin/` renvoie le rejet métier attendu avec de faux identifiants.

**Comment appliquer:** les tests E2E doivent reproduire `initWorkerSession()` puis `refreshSessionAndScan()`, sélectionner un créneau réel, et chaîner tout le booking avec `scan.ds` dans le même contexte TLS et le même jar.

## Créneau partagé entre sessions

Sur Saopolo, un utilisateur A a trouvé un créneau réel via `datetime/`, puis un utilisateur B a reçu un nouveau `PHPSESSID` et a utilisé ce créneau sans refaire `datetime/`. Sur B, `getsigninfields/` a répondu HTTP 200 avec 0B, mais `signin/` a tout de même atteint la validation métier et renvoyé « Usuario o contraseña incorrectos » avec de faux identifiants.

**Pourquoi:** cela confirme que le serveur peut traiter `signin/` avec un créneau découvert dans une autre session, mais ne prouve pas qu’un compte valide pourrait réserver. Aucun `bktToken` n’a été obtenu et `summary/` n’a pas été appelé.

**Comment appliquer:** pour les diagnostics de créneau partagé, garder un vrai slot de A, créer un PHPSESSID frais pour B, ne pas appeler `datetime/` sur B, puis distinguer `getsigninfields/` vide d’une réponse métier de `signin/`. Ne jamais extrapoler ce résultat à une réservation réussie.

## Rotation des cookies

Le jar manuel de `DynamicSession` doit fusionner les `Set-Cookie` reçus par `getsigninfields/`, `signin/` et `summary/` avant l'appel suivant, puis resynchroniser `session.allCookies`. Les valeurs ne doivent jamais apparaître dans les logs.

**Pourquoi:** Bookitit peut renouveler `PHPSESSID` pendant le booking; ignorer ce header envoie ensuite un identifiant de session obsolète et peut produire une réponse `0B` malgré un créneau valide.

**Comment appliquer:** tracer seulement l'état, le nom, la longueur et une empreinte non réversible; traiter les valeurs vides comme des suppressions et réutiliser le jar mis à jour pour toute l'étape suivante.