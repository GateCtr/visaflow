---
name: Spain Bookitit datetime 0B normal
description: Sur le portail Kinshasa citaconsular.es, datetime/ retourne 0B (body vide) quand aucun créneau n'est disponible ce mois — c'est un comportement normal serveur, PAS une session morte.
---

## Règle

`datetime/` → 0B (payload=null) **≠** session morte sur citaconsular.es Kinshasa.

Bookitit retourne un body vide HTTP 200 quand aucun créneau n'existe pour la plage demandée.
Traiter 0B comme session morte déclenche rotation IP + nouveau solve CapSolver inutile.

**Why:** Bug découvert en production (2026-08-16). 3 workers en boucle de rotation infinie (solve toutes les 20s, 40 IPs blacklistées inutilement) car `allMonthsDead` confondait "pas de créneau" et "IP brûlée". /main/ retournait 124110B (session valide), mais datetime/ retournait 0B (normal = pas de slot).

**How to apply:**
- Ne jamais déclencher de rotation/réinit PHP sur 0B de datetime/ seul.
- La vraie mort de session se détecte à `initWorkerSession` (probe /main/ échoue) ou `initPhpState` (getservices/ → 0 services).
- Les cycles avec 0B sont logués `⏸ Cycle N: aucun créneau — next` et le worker continue jusqu'à la fin de la fenêtre de 25 min.
- Décision : suppression complète de `allMonthsDead`, `consecutiveDeadCycles`, `MAX_DEAD_CYCLES_BEFORE_ROTATE` et de `rotateWorkerIp` depuis la boucle de scan.

## Distinction callDirect → null

`callDirect` retourne `null` pour DEUX cas sans les distinguer :
1. HTTP 200 + body vide → normal (pas de créneau)
2. Erreur réseau/timeout → vrai problème

Ne pas utiliser null comme signal d'erreur dans la boucle de scan.
