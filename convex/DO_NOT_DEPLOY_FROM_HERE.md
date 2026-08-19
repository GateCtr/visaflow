# ⚠️ NE PAS DÉPLOYER DEPUIS CE DOSSIER

Ce dossier `convex/` à la racine ne contient que les types auto-générés (`_generated/`)
utilisés par `artifacts/slot-hunter` pour les imports `@convex/_generated`.

## Le vrai code Convex est dans :
```
artifacts/joventy/convex/
```

## Pour déployer :
```powershell
.\scripts\deploy-convex.ps1
```

## ❌ NE JAMAIS faire :
```powershell
npx convex deploy    # depuis la racine → CASSE LA PROD (supprime tous les indexes)
```
