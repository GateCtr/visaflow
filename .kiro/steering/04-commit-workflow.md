# Workflow de développement et commits

## Format des commits

```
type(scope): description concise en français

[corps optionnel — détails, contexte]
[footer optionnel — breaking changes, refs]
```

### Types

| Type | Usage |
|------|-------|
| `feat` | Nouvelle fonctionnalité |
| `fix` | Correction de bug |
| `refactor` | Refactorisation sans changement de comportement |
| `docs` | Documentation uniquement |
| `style` | Formatage, semicolons, whitespace |
| `test` | Ajout/modification de tests |
| `chore` | Maintenance, dépendances, CI |
| `perf` | Amélioration des performances |

### Scopes principaux

| Scope | Package/Zone |
|-------|-------------|
| `usa` | `artifacts/slot-hunter` — portail USA |
| `spain` | `artifacts/slot-hunter` — portail Espagne |
| `canada` | `artifacts/slot-hunter` — portail Canada |
| `hunter` | `artifacts/slot-hunter` — logique générale |
| `captcha` | `artifacts/captcha-service` |
| `proxy` | `artifacts/proxy-service` |
| `api` | `lib/api-spec`, `lib/api-zod` |
| `db` | `lib/db` |
| `infra` | Dockerfile, railway, vercel, cloudflare |
| `shared` | Code partagé multi-packages |

### Exemples

```
feat(usa): détection des RDV annulables via pendingAppoStatus

- Logique extraite du bundle AIS v2.4
- pendingAppoStatus=0 + applicationId présent = annulable
- Ajout du retry si la réponse est vide

fix(spain): timeout augmenté pour les requêtes longues

Le portail répond parfois après 25s sur certaines missions.
Timeout passé de 10s à 35s avec retry exponentiel.

chore(infra): migration vers pnpm 10 + cleanup postinstall
```

## Validation avant commit

### 1. Compilation TypeScript

```bash
cd artifacts/slot-hunter && npx tsc --noEmit
```
Zéro erreur obligatoire.

### 2. Vérification lint (si configuré)

```bash
pnpm run lint          # root
pnpm run build         # dans le package modifié
```

### 3. Test local rapide

Vérifier que le module modifié s'exécute sans crash :
```bash
cd artifacts/slot-hunter && pnpm run start
```

## Checklist pré-commit

- [ ] Code compilé sans erreurs TS
- [ ] Pas de tokens/secrets dans le diff (`git diff --cached | grep -i token`)
- [ ] Logique alignée avec le bundle (si modification portail)
- [ ] Message de commit conforme au format
- [ ] Pas de `console.log` de debug oubliés (sauf logs avec préfixe `[module]`)

## Pull Requests

- Titre = message du commit principal
- Description : résumé des changements + contexte métier
- Référencer l'analyse de bundle si modification de portail
- Screenshots/logs si changement UI ou comportement observable
