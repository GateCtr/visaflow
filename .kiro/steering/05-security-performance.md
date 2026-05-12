# Sécurité, performance et indétectabilité

## Sécurité

### Règles absolues

- **Jamais** de tokens, clés API, ou secrets dans le code source
- Utiliser `.env` + `dotenv` — fichier `.env.example` en template
- Variables sensibles : `ACCESS_TOKEN`, `CAPSOLVER_KEY`, `PROXY_URL`, `CLERK_SECRET_KEY`
- Vérifier avant chaque commit : `git diff --cached | grep -iE "(token|key|secret|password)"`

### Validation des entrées

- Valider toute donnée venant d'une API externe avec Zod ou type guards
- Ne jamais faire confiance aux réponses des portails sans validation
- Sanitiser les données avant de les stocker (Convex, logs)

### Logs sécurisés

```typescript
// BON : masquer les données sensibles
console.log("[usaPortal] Session active for user:", userId.slice(0, 8) + "...");

// MAUVAIS : exposer le token
console.log("[usaPortal] Token:", accessToken); // JAMAIS
```

## Performance

### Minimiser les requêtes réseau

- Ne pas re-fetch ce qui n'a pas changé (caching intelligent)
- Grouper les requêtes quand l'API le permet
- Utiliser des intervalles de polling adaptatifs (augmenter si pas de slots)

### Timeouts et retries

```typescript
const TIMEOUT_MS = 30_000;        // 30s max par requête
const MAX_RETRIES = 3;            // 3 tentatives max
const RETRY_BACKOFF_MS = 2_000;   // Backoff exponentiel x2

// Pattern standard
async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) return response;
      if (response.status >= 500) throw new Error(`Server error: ${response.status}`);
      return response; // 4xx = ne pas retry
    } catch (error) {
      if (attempt === MAX_RETRIES - 1) throw error;
      await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw new Error("Unreachable");
}
```

### Mémoire

- Nettoyer les références aux gros objets (bundles, pages HTML capturées)
- Utiliser des streams pour les téléchargements volumineux
- Fermer les pages Playwright dès qu'elles ne sont plus nécessaires

## Indétectabilité

### Principes

Le hunter doit se comporter **exactement** comme un humain utilisant le portail légitime.

### Headers HTTP

- User-Agent réaliste et cohérent par session
- Referer correct (page précédente logique)
- Accept, Accept-Language, Accept-Encoding standards
- Pas de headers révélateurs (`X-Automated`, etc.)

### Timing

- **Délais aléatoires** entre les requêtes (pas de patterns réguliers)
- Temps de réflexion humain entre les étapes (1-5s)
- Jitter sur les intervalles de polling (±20%)

```typescript
// BON : délai humain avec jitter
const baseDelay = 2000;
const jitter = Math.random() * 1000 - 500; // ±500ms
await sleep(baseDelay + jitter);

// MAUVAIS : délai fixe détectable
await sleep(2000); // Pattern régulier = bot
```

### Rotation des proxies

- Utiliser des proxies résidentiels/ISP (pas datacenter pour les portails sensibles)
- Rotation douce : garder la même IP pendant une session complète
- Changer d'IP uniquement entre sessions ou après un blocage
- Pool géolocalisé (IP du pays du portail cible)

### Fingerprinting navigateur

- Playwright + stealth plugin activé
- Résolution d'écran réaliste
- WebGL, Canvas, AudioContext non patchés de manière suspecte
- Timezone cohérente avec la géolocalisation du proxy

### Anti-détection Cloudflare

- Résoudre les challenges Turnstile via Capsolver
- Cookie `cf_clearance` maintenu et réutilisé
- Ne pas re-résoudre si le cookie est encore valide
- Respecter le `__cf_bm` et le cycle de renouvellement

## Références

- #[[file:artifacts/slot-hunter/src/humanBehavior.ts]]
- #[[file:artifacts/slot-hunter/src/proxyPool.ts]]
- #[[file:artifacts/slot-hunter/src/cloudflare-solver.ts]]
- #[[file:artifacts/slot-hunter/.env.example]]
