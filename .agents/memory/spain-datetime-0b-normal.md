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
- `getservices/` → 0B/0 service ou erreur réseau est une anomalie d'initialisation et force une rotation IP immédiate; ne pas appliquer la tolérance du premier `proxy_error`.
- Les cycles avec 0B sont logués `⏸ Cycle N: aucun créneau — next` et le worker continue jusqu'à la fin de la fenêtre de 25 min.
- Décision : suppression complète de `allMonthsDead`, `consecutiveDeadCycles`, `MAX_DEAD_CYCLES_BEFORE_ROTATE` et de `rotateWorkerIp` depuis la boucle de scan.
- Exception : si tous les mois sont 0B et qu'un burst de créneaux très récent est confirmé par un autre worker du même portail, traiter le résultat comme une anomalie proxy/session et faire tourner l'IP immédiatement.

**Why:** Un 0B isolé est normal sur Kinshasa, mais l'analyse de la publication du 31 août 2026 a montré qu'un dossier pouvait recevoir 0B pendant que d'autres dossiers du même portail voyaient et réservaient des créneaux. La preuve inter-workers évite de confondre ces deux situations.

**How to apply:** Publier un signal Redis court lorsqu'un worker trouve des créneaux. Pour un `0B` sur tous les mois, attendre brièvement ce signal avant de conclure `not_found`; s'il existe, bypasser la tolérance du premier `proxy_error` et changer de proxy sans réinitialisation PHP sur la même IP.

## Distinction callDirect → null

`callDirect` retourne `null` pour DEUX cas sans les distinguer :
1. HTTP 200 + body vide → normal (pas de créneau)
2. Erreur réseau/timeout → vrai problème

Ne pas utiliser null comme signal d'erreur dans la boucle de scan.
