# Bug : CF re-solve à chaque cycle de scan (12/13 workers)

## Symptôme observé
- Dashboard montre `cfCached=false` + temps de solve (20-37s) à CHAQUE scan (toutes les ~10s)
- Le solde CapSolver se décrémente à chaque cycle
- 1 seul worker sur 13 (ISSEKAMA) montre `cfCached=true 2.4s`
- Les 12 autres font un solve CapSolver à chaque cycle

## Ce qui a été testé
1. `test-cf-clearance-persistence.ts` — clearance réutilisable (5 GET OK avec même clearance) ✅
2. `test-worker-scan-loop.ts` — `refreshSessionAndScan` en boucle locale : PAS de re-solve (4.5s/cycle) ✅
3. Nouveau impit avec même clearance : OK ✅

## Contradiction
- Le test local utilise les MÊMES fonctions que la prod (`initWorkerSession` + `refreshSessionAndScan`) et ça ne re-solve pas
- En prod, les workers re-solvent à chaque cycle

## Hypothèses à vérifier
1. **Le worker est détruit et recréé par l'orchestrateur à chaque cycle** (pas un cycle de scan dans la boucle while, mais un vrai redémarrage du worker)
2. **Le dashboard affiche les données d'init (constantes) à chaque scan report** — et ce qu'on voit comme "re-solve" est juste le label de l'init initial
3. **L'exit IP Decodo change** entre les requêtes sur Railway (sticky instable sur longue durée) → clearance invalidée → cf_expired → re-solve

## Preuve manquante
- Timestamps précis de 3 cycles consécutifs du même dossier
  - Si espacés de ~30s (20s solve + 10s scan) → vrai re-solve
  - Si espacés de ~10s → juste l'affichage

## Action requise
- Lancer `runDossierWorker` directement en local (test de 15 min) et observer les logs de la boucle de scan
- Ou ajouter un log spécifique dans le handler `cf_expired` pour compter les occurrences par fenêtre

## Date : 2026-08-24
