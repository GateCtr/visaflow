# Directives du projet VisaFlow / Slot-Hunter

## Vue d'ensemble
Ce projet est un système de chasse aux créneaux de rendez-vous visa (USA, Espagne, etc.) qui automatise la recherche et la réservation de créneaux sur les portails officiels.

## Normes de codage

### TypeScript
- **Strict mode**: Toujours activé
- **Types explicites**: Éviter `any`, utiliser `unknown` pour les données non vérifiées
- **Interfaces vs Types**: Préférer les interfaces pour les objets, les types pour les unions et tuples
- **Documentation**: Commenter les fonctions complexes et les décisions importantes
- **Gestion d'erreurs**: Utiliser `try/catch` avec des messages d'erreur explicites
- **Logging**: Utiliser `console.log` avec préfixes `[module]` pour le débogage

### Structure de code
```typescript
// Bon exemple
interface UserSession {
  userId: string;
  accessToken: string;
  missionId?: number;
}

// Mauvais exemple
const user = {}; // any implicite
```

### Conventions de nommage
- **Variables**: `camelCase`
- **Types/Interfaces**: `PascalCase` 
- **Constantes**: `UPPER_SNAKE_CASE`
- **Fonctions**: `camelCase` avec verbes d'action (`getUserData`, `validateInput`)
- **Fichiers**: `kebab-case.ts` pour les fichiers, `PascalCase.ts` pour les composants

## Décisions architecturales

### 1. Séparation des responsabilités
- **src/**: Code source principal
- **scripts/**: Scripts utilitaires et d'analyse
- **captured/**: Données capturées pour analyse
- **bundle-analysis/**: Analyse des bundles des portails cibles

### 2. Gestion des sessions
- Les sessions doivent être isolées par utilisateur
- Tokens d'accès stockés de manière sécurisée
- Cookies et headers gérés de manière cohérente

### 3. Communication avec les APIs
- Utiliser `fetch` avec wrappers personnalisés (`usaFetch`, `spainFetch`)
- Headers standardisés pour chaque portail
- Gestion des retries et timeouts
- Validation des réponses JSON

### 4. Analyse des bundles
- Télécharger et analyser les bundles des portails cibles
- Extraire la logique métier réelle (ex: `pendingAppoStatus`)
- Ne pas se fier aux commentaires du code, vérifier le bundle

## Bibliothèques préférées

### Dépendances principales
- **TypeScript**: Pour la sécurité des types
- **Puppeteer**: Pour l'automatisation navigateur (si nécessaire)
- **Node-fetch**: Pour les requêtes HTTP
- **Date-fns**: Pour la manipulation des dates

### Dépendances de développement
- **ESLint**: Pour la qualité du code
- **Prettier**: Pour le formatage
- **Jest**: Pour les tests
- **TS-node**: Pour exécuter TypeScript directement

## Formats de messages de commit

### Convention
```
type(scope): description concise

[corps optionnel]
[footer optionnel]
```

### Types de commits
- `feat`: Nouvelle fonctionnalité
- `fix`: Correction de bug
- `docs`: Documentation
- `style`: Formatage, point-virgule manquant, etc.
- `refactor`: Refactorisation du code
- `test`: Ajout ou modification de tests
- `chore`: Tâches de maintenance, dépendances

### Exemples
```
feat(usa): ajout de la détection des RDV annulables (cancellable)

- Détection basée sur pendingAppoStatus=0 + applicationId
- Logique alignée avec l'analyse du bundle
- Tests pour les cas edge
```

```
fix(spain): correction du timeout des requêtes API

Augmente le timeout de 10s à 30s pour les requêtes longues
Ajoute des retries automatiques sur les erreurs réseau
```

```
refactor(shared): extraction des helpers de validation

- Crée validation.ts avec validateEmail, validatePhone
- Réutilise dans usaPortal.ts et spainPortal.ts
- Améliore la couverture de tests
```

## Workflow de développement

### 1. Analyse préalable
- Lire le code existant avant de modifier
- Analyser les bundles des portails cibles
- Comprendre la logique métier réelle

### 2. Implémentation
- Suivre les normes de codage
- Tester avec des comptes réels
- Vérifier les logs pour le débogage

### 3. Validation
- Vérifier la compilation TypeScript
- Tester les cas edge
- Documenter les changements

### 4. Déploiement
- Messages de commit clairs
- Revue de code si possible
- Monitoring après déploiement

## Directives spécifiques au projet

### 1. Priorité à l'analyse du bundle
- **Ne jamais se fier uniquement aux commentaires du code**
- **Toujours vérifier le bundle réel du portail**
- **Télécharger et analyser les bundles régulièrement**
- **Extraire la logique métier réelle**

### 2. Gestion des erreurs
- Loguer les erreurs avec contexte
- Ne pas exposer d'informations sensibles dans les logs
- Gérer les timeouts et les retries
- Fournir des messages d'erreur utiles aux utilisateurs

### 3. Sécurité
- Ne pas commettre de tokens ou clés API
- Valider toutes les entrées utilisateur
- Utiliser des variables d'environnement pour les secrets
- Vérifier les permissions avant les opérations sensibles

### 4. Performance
- Minimiser les requêtes réseau
- Mettre en cache les données stables
- Utiliser des timeouts appropriés
- Surveiller l'utilisation mémoire

## Références
- #[[file:artifacts/slot-hunter/package.json]]
- #[[file:artifacts/slot-hunter/tsconfig.json]]
- #[[file:artifacts/slot-hunter/src/usaPortal.ts]]
- #[[file:artifacts/slot-hunter/bundle-analysis/download-bundle.js]]

---

*Dernière mise à jour: 12 mai 2026*
*Mainteneur: Équipe VisaFlow*

## Processus de développement rigoureux

### Avant toute modification ou création
1. **Lire le contexte existant**
   - Examiner le code autour de la zone à modifier
   - Comprendre les dépendances et impacts
   - Vérifier les tests existants

2. **Vérifier la conformité avec les bundles**
   - **Toujours** analyser le bundle du portail cible avant de modifier la logique
   - Si le bundle n'existe pas localement, exécuter les scripts de téléchargement:
     ```bash
     cd artifacts/slot-hunter
     node bundle-analysis/download-bundle.js
     ```
   - Extraire la logique métier réelle du bundle (ex: `pendingAppoStatus`, endpoints API)
   - **Ne jamais se fier uniquement aux commentaires ou au code existant**

3. **Objectifs des modifications**
   Toute modification ou création de code pour les différents portails doit:
   - **Rendre le hunter plus efficace**: Améliorer la détection, la réservation
   - **Améliorer les performances**: Réduire les requêtes, optimiser le code
   - **Rester indétectable**: Respecter les patterns du portail, éviter le throttling
   - **Être conforme au bundle**: Suivre la logique réelle du portail

### Validation avant commit
1. **Compiler le code**
   ```bash
   cd artifacts/slot-hunter
   npx tsc --noEmit
   ```
   - Résoudre toutes les erreurs TypeScript avant de continuer
   - Vérifier les warnings importants

2. **Tester localement**
   - Exécuter des tests avec des comptes de test
   - Vérifier les logs pour les erreurs
   - S'assurer que la logique fonctionne comme attendu

3. **Créer un commit propre**
   - Suivre le format de message de commit défini
   - Inclure les références aux analyses de bundle
   - Documenter les décisions importantes

4. **Pull Request (si applicable)**
   - Inclure une description claire des changements
   - Référencer les analyses de bundle pertinentes
   - Inclure des captures d'écran ou logs si nécessaire
   - Attendre la revue de code avant merge

### Checklist avant chaque modification
- [ ] Bundle analysé et à jour
- [ ] Logique alignée avec le bundle réel
- [ ] Code compilé sans erreurs
- [ ] Tests exécutés localement
- [ ] Logs vérifiés pour le débogage
- [ ] Impact sur les performances évalué
- [ ] Mesures d'indétectabilité respectées

### Scripts de téléchargement de bundles
Des scripts existent pour chaque portail:
- **USA**: `bundle-analysis/download-bundle.js`
- **Autres portails**: Créer des scripts similaires si nécessaire

**Règle d'or**: Si tu modifies la logique d'un portail sans avoir analysé son bundle récent, tu risques d'introduire des bugs ou de rendre le hunter détectable.