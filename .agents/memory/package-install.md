---
name: Monorepo package installation
description: Reinstall all workspace dependencies without altering individual manifests or the root package configuration.
---

## Rule

Pour restaurer les dépendances du projet, utiliser le workspace pnpm à la racine avec le lockfile existant (`pnpm install --frozen-lockfile`). Ne pas installer les dépendances d’un artifact via npm dans le package racine.

**Why:** Le dépôt contient plusieurs workspaces et des lockfiles distincts pour certains services. Une installation npm ciblée peut déplacer les dépendances dans le package racine et modifier ses manifests, tandis que pnpm restaure les 11 workspaces avec les versions verrouillées.

**How to apply:** Vérifier ensuite les binaires critiques des services (`tsx`, `vite`, Playwright/Chromium) et redémarrer les workflows. Le typecheck global peut encore révéler des erreurs applicatives indépendantes des dépendances.