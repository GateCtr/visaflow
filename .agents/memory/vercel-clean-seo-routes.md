---
name: Vercel clean SEO routes
description: Contrainte de sortie statique pour que Vercel serve les métadonnées propres aux routes Joventy.
---

Les pages pré-rendues accessibles par une URL sans extension doivent être générées sous la forme `route/index.html`. Un fichier `route.html` n'est pas sélectionné avant le fallback SPA actuel.

**Why:** En production, les URLs publiques renvoyaient toutes `index.html` et le canonical de l'accueil malgré l'existence de fichiers HTML pré-rendus portant le nom du slug.

**How to apply:** Toute extension du générateur SEO doit passer par le même mécanisme d'écriture des routes. Après le build, vérifier l'arborescence de sortie et lire title, description et canonical depuis chaque URL sans extension.