---
name: Spain per-dossier worker session init
description: initWorkerSession() — fonction standalone qui établit une session Bookitit complète, utilisée par runDossierWorker en remplacement de l'ancienne séquence cassée.
---

## Règle

Utiliser `initWorkerSession(stickyProxyUrl, targetUrl, capsolverKey)` de `spain-soax-solver.ts`
pour établir la session dans les workers — jamais recréer la séquence probe/solve/portail manuellement.

## Pourquoi ça fonctionne

Le bloc `capsolver-residential` de `ensureSpainImpitSession` est la seule implémentation
prouvée qui passe le CF HTML de citaconsular.es via les IPs `es.decodo.com` CSV pool.
La clé : **un seul impit pour toute la séquence** (probe → solve → GET portail → POST token → /main/).
Séparer ces étapes en fonctions différentes (ancienne approche) casse la cohérence TLS.

**Spécificités confirmées :**
- UA fixe `Chrome/151` (WORKER_UA) pour probe ET GET portail ET POST token
- Headers probe : `User-Agent + Accept` SEULEMENT (pas de Sec-Fetch-*)  
- CapSolver `AntiCloudflareTask` : html + proxy + userAgent = Chrome/151
- Port 10001 (index 0) est une IP qui passe CF HTML — les ports >~10011 étaient bloqués lors des tests

## Isolation per-dossier

- Chaque appel `initWorkerSession` crée son propre `Impit` local → zéro globals
- Sticky session ID aléatoire par worker → exit IP différente
- `session._ownImpit === impit` du probe → cohérence TLS pour tout le cycle de scan

## Blacklist

- `pickDedicatedProxy` = réservation atomique Redis (SET NX + TTL) → max 1 worker par IP
- Échec `initWorkerSession` → `flagDecodoIp(proxyUrl, "init-session-failed")` → TTL 45min
- Les anciens flags (ancienne approche cassée) étaient des faux négatifs → del `spain:decodo:pool:state` pour reset

## Comment appliquer

```typescript
// Dans runDossierWorker :
const stickyId = Math.random().toString(36).slice(2, 10);
const stickyProxy = addStickySession(proxyUrl, stickyId);
const result = await initWorkerSession(stickyProxy, portalUrlNoFrag, capsolverKey);
if (!result) { flagDecodoIp(proxyUrl, "init-session-failed"); /* rotate */ }
const { session } = result; // session._ownImpit = impit du probe
```
