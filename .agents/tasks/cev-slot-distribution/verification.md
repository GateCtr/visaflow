# Vérification — cev-slot-distribution

Commandes exactes lancées depuis `d:\dev\visaflow\artifacts\slot-hunter` :

## 1. Type-check TypeScript strict

```
npx tsc --noEmit
```

Résultat : **OK, zéro erreur** (exit code 0).

## 2. Tests d'allocation (vitest, single-run)

```
npx vitest run src/__tests__/cev-slot-assignment.test.ts
```

Résultat : **13 tests passés / 13** (exit code 0), fichier
`src/__tests__/cev-slot-assignment.test.ts`.

Couverture des exigences vérifiables :
- (1) zéro recouvrement des premiers choix entre comptes quand #créneaux ≥ #comptes
  (18 créneaux / 10 comptes ; cas limite #créneaux == #comptes ; divergence des k-ièmes choix).
- (2) chaque compte obtient une permutation complète des créneaux éligibles (aucun créneau perdu,
  aucun doublon, même cardinalité).
- (3) filtre maxDate : écarte les créneaux hors deadline, deadline incluse (égalité date conservée),
  tout hors deadline → liste vide, deadline mal formée ignorée.
- (4) fallback #comptes > #créneaux : wrap-around sans crash, permutation complète par compte,
  liste éligible vide → liste vide.
- Tri d'attractivité conservé AVANT entrelacement (date la plus proche visée en premier par le rang 0).

Le reviewer peut se fier à ce fichier au lieu de relancer les suites.
