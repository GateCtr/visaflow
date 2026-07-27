---
name: CapSolver Decodo HTTP test
description: Résultat du test réel du watcher Espagne HTTP-only avec Decodo et CapSolver
---

Le mode Spain HTTP-only démarre correctement avec `DECODO_PROXY_URL` et `CAPSOLVER_API_KEY`. Decodo a obtenu directement une session Cloudflare valide, avec PHPSESSID, sans appeler CapSolver. Le test explicite CapSolver a créé une tâche mais chaque polling a renvoyé `ERROR_INVALID_TASK_DATA`; le détail réel est dans `errorDescription`, qui doit être journalisé.

**Pourquoi:** Le bypass direct Decodo masque le chemin CapSolver en fonctionnement normal; le fallback doit donc être testé séparément. La documentation CapSolver indique que `AntiCloudflareTask` exige `type`, `websiteURL` et `proxy`; `userAgent` et `html` sont optionnels mais peuvent être nécessaires selon le challenge. `ERROR_INVALID_TASK_DATA` reste générique sans `errorDescription`.

**Comment appliquer:** Pour les futurs tests, distinguer le succès Decodo direct du succès CapSolver fallback et ne pas annoncer le scan Bookitit complet tant qu’un dossier Espagne actif n’a pas déclenché `runSpainHttpProbe`.