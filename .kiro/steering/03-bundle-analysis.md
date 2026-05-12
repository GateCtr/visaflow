# Analyse des bundles — Règle d'or du projet

## Principe fondamental

> **Ne JAMAIS modifier la logique d'un portail sans avoir analysé son bundle JavaScript récent.**

Les portails changent leur logique côté client sans prévenir. Les commentaires dans le code existant peuvent être obsolètes. Seul le bundle actuel fait foi.

## Pourquoi c'est critique

1. **Détection d'endpoints** : Les URLs d'API sont souvent construites dynamiquement dans le bundle
2. **Logique métier** : Ex: `pendingAppoStatus === 0` + `applicationId` = RDV annulable (extrait du bundle AIS)
3. **Indétectabilité** : Reproduire les mêmes patterns que le frontend légitime
4. **Prévention des bugs** : Éviter d'appeler des endpoints dépréciés ou changés

## Processus obligatoire avant modification d'un portail

### 1. Télécharger le bundle

```bash
cd artifacts/slot-hunter
node bundle-analysis/download-bundle.js        # USA (AIS)
# Ajouter des scripts similaires pour d'autres portails si nécessaire
```

### 2. Analyser les éléments clés

Chercher dans le bundle :
- **Endpoints API** : URLs de fetch/axios/XMLHttpRequest
- **Logique de statut** : Conditions sur les codes de statut (ex: `pendingAppoStatus`)
- **Headers requis** : Tokens, clés API, headers custom
- **Paramètres de requête** : Format des body/query params
- **Gestion d'erreurs** : Comment le portail traite les erreurs API

### 3. Documenter les découvertes

Stocker les résultats dans `bundle-analysis/` avec le format :
```
bundle-analysis/
├── download-bundle.js          # Script de téléchargement
├── usa-bundle-YYYY-MM-DD.md    # Analyse datée
└── spain-bundle-YYYY-MM-DD.md  # Analyse datée
```

## Scripts existants

| Script | Usage |
|--------|-------|
| `bundle-analysis/download-bundle.js` | Télécharge le bundle USA/AIS |
| `check-portal-bundle.sh` | Vérifie les changements de bundle |
| `deep-analyze-bundle.mjs` | Analyse approfondie des patterns |
| `analyze-bundle-errors.mjs` | Extraction des codes d'erreur |

## Checklist avant toute modification de portail

- [ ] Bundle téléchargé (< 24h si possible)
- [ ] Endpoints vérifiés dans le bundle
- [ ] Logique de statut extraite et comprise
- [ ] Headers/params alignés avec le bundle
- [ ] Code du hunter mis à jour pour refléter le bundle

## Références

- #[[file:artifacts/slot-hunter/bundle-analysis/download-bundle.js]]
- #[[file:artifacts/slot-hunter/src/usaPortal.ts]]
- #[[file:artifacts/slot-hunter/src/spainPortal.ts]]
