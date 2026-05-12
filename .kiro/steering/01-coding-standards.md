# Normes de codage TypeScript

## Règles strictes

- TypeScript **strict mode** toujours activé
- **Jamais** de `any` — utiliser `unknown` + type guards pour les données non vérifiées
- Préférer `interface` pour les objets, `type` pour les unions/tuples/utilitaires
- Chaque fonction exportée doit avoir un type de retour explicite
- `try/catch` obligatoire autour des appels réseau avec message d'erreur contextuel

## Conventions de nommage

| Élément | Convention | Exemple |
|---------|-----------|---------|
| Variables | `camelCase` | `slotDate`, `accessToken` |
| Types/Interfaces | `PascalCase` | `UserSession`, `SlotResult` |
| Constantes | `UPPER_SNAKE_CASE` | `MAX_RETRIES`, `API_BASE_URL` |
| Fonctions | `camelCase` + verbe | `fetchSlots`, `validateSession` |
| Fichiers modules | `kebab-case.ts` | `usa-portal.ts`, `proxy-pool.ts` |
| Fichiers composants | `PascalCase.tsx` | `SlotCard.tsx` |

## Logging

Toujours préfixer les logs avec le nom du module entre crochets :
```typescript
console.log("[usaPortal] Checking available slots...");
console.error("[proxyPool] Proxy rotation failed:", error.message);
```

## Structure des interfaces

```typescript
// Bon : interface typée, propriétés optionnelles marquées
interface UserSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  missionId?: number;
  expiresAt: Date;
}

// Mauvais : objet vide ou any
const user = {}; // NON
const data: any = response.json(); // NON
```

## Imports

- Grouper par : (1) node built-ins, (2) packages externes, (3) modules internes
- Utiliser les imports de type (`import type { ... }`) quand possible
- Pas d'imports wildcard (`import * as`)

## Gestion d'erreurs

```typescript
try {
  const response = await portalFetch(url, options);
  if (!response.ok) {
    throw new Error(`[usaPortal] HTTP ${response.status}: ${response.statusText}`);
  }
  return await response.json() as SlotResponse;
} catch (error) {
  console.error(`[usaPortal] Slot fetch failed:`, error instanceof Error ? error.message : error);
  throw error; // Re-throw pour que l'appelant gère
}
```

## Références

- #[[file:artifacts/slot-hunter/tsconfig.json]]
- #[[file:tsconfig.base.json]]
