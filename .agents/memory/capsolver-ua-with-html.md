---
name: CapSolver userAgent obligatoire avec html
description: AntiCloudflareTask avec le champ html exige aussi userAgent — sinon l'API retourne ERROR_INVALID_TASK_DATA.
---

## La règle

Quand `AntiCloudflareTask` reçoit le champ `html` (HTML du challenge CF pré-fetché par impit), CapSolver exige aussi `userAgent` dans la même tâche.

**Why:** CapSolver a besoin de l'UA pour simuler correctement le browser-context correspondant au challenge HTML. Sans UA, l'API rejette la tâche avec `invalid task data: the userAgent is also required since you sent html`.

**How to apply:** Dans `solveSpainCloudflare()` (spain-soax-solver.ts), le paramètre `userAgent` optionnel doit être fourni par l'appelant (capsolver-residential block passe `UA_RESIDENTIAL`). Un fallback Windows Chrome 151 est codé dans la fonction si userAgent est omis.

## Ce qui NE pose pas de problème

- Tâche AntiCloudflareTask SANS html → pas de userAgent requis (CapSolver fetche la page lui-même)
- Le test-bookitit-dynamic.ts a sa propre implémentation CapSolver qui inclut UA → n'est pas affecté
