# Analyse de la logique de suspension temporaire - Portail USA

## Résumé de l'analyse

### 1. Logique actuelle dans `usaPortal.ts`

La fonction `isRestrictedBody()` détecte les suspensions temporaires via les patterns suivants :
- `"temporarily"`
- `"restricted"`
- `"access denied"`
- `"account locked"`
- `"too many"`
- `"rate limit"`

**Problème identifié** : La recherche de `"account locked"` est trop stricte et ne détecte pas des variations comme `"account is locked"` ou `"your account has been locked"`.

### 2. Analyse du bundle USA

Le bundle téléchargé (`main.1672fe230dcb2db1.js`) ne contient **pas** de messages d'erreur spécifiques de suspension de compte codés en dur. Les occurrences trouvées sont :

1. **"temporarily"** (1 occurrence) : Dans un message de maintenance
   - `"This application is currently undergoing updates and is temporarily unavailable. Please check back later"`

2. **"restricted"** (4 occurrences) : Contexte technique (PDF rendering)
   - `"hasRestrictedScaling"` - propriété technique

3. **"suspended"** (14 occurrences) : Contexte technique (PDF rendering)
   - `"suspendedCtx"` - contexte suspendu pour le rendu PDF

4. **"try again"** (14 occurrences) : Message générique d'erreur
   - `"Something went wrong. please try again later."`

### 3. Implications

1. **Les messages de suspension viennent probablement du backend** : Ils ne sont pas codés en dur dans le bundle frontend.

2. **La détection actuelle est basée sur des patterns génériques** : La fonction `isRestrictedBody()` cherche des mots-clés dans le corps de la réponse HTTP.

3. **Manque d'exemples concrets** : Aucune capture de réponse 401 avec message de suspension n'a été trouvée dans les logs analysés.

## Recommandations d'amélioration

### 1. Améliorer la fonction `isRestrictedBody()`

```typescript
/** Teste si un corps de réponse 401 indique une restriction temporaire vs un token expiré. */
function isRestrictedBody(body: string): boolean {
  const lower = body.toLowerCase();
  
  // Patterns améliorés
  return (
    // Patterns existants
    lower.includes("temporarily") ||
    lower.includes("restricted") ||
    lower.includes("access denied") ||
    lower.includes("too many") ||
    lower.includes("rate limit") ||
    
    // Patterns améliorés
    lower.includes("account") && lower.includes("locked") || // "account" ET "locked"
    lower.includes("account") && lower.includes("suspended") || // "account" ET "suspended"
    lower.includes("account") && lower.includes("blocked") || // "account" ET "blocked"
    lower.includes("try again") || // Déjà partiellement couvert
    lower.includes("please wait") || // Nouveau pattern
    lower.includes("cooldown") || // Nouveau pattern
    lower.includes("cool down") || // Nouveau pattern
    lower.includes("temporary block") || // Nouveau pattern
    lower.includes("temporary restriction") // Nouveau pattern
  );
}
```

### 2. Ajouter une logique de détection basée sur les headers

```typescript
/** Teste si une réponse HTTP indique une restriction temporaire */
function isRestrictedResponse(response: Response, body: string): boolean {
  // Vérifier le status code
  if (response.status !== 401 && response.status !== 403 && response.status !== 429) {
    return false;
  }
  
  // Vérifier les headers spécifiques
  const retryAfter = response.headers.get("retry-after");
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  
  // Si Retry-After est présent, c'est probablement une restriction temporaire
  if (retryAfter && parseInt(retryAfter) > 0) {
    return true;
  }
  
  // Si rate limit est épuisé avec un reset time
  if (rateLimitRemaining === "0" && rateLimitReset) {
    return true;
  }
  
  // Fallback sur l'analyse du corps
  return isRestrictedBody(body);
}
```

### 3. Améliorer la gestion des restrictions

```typescript
/** Marque un compte comme restreint avec durée dynamique */
function markAccountRestricted(username: string, response?: Response, body?: string): void {
  let durationMs = 25 * 60 * 1000; // 25 minutes par défaut
  
  // Essayer d'extraire la durée depuis les headers
  if (response) {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = parseInt(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        durationMs = seconds * 1000;
      }
    }
    
    // Essayer d'extraire depuis X-RateLimit-Reset
    const rateLimitReset = response.headers.get("x-ratelimit-reset");
    if (rateLimitReset) {
      const resetTime = parseInt(rateLimitReset);
      if (!isNaN(resetTime) && resetTime > 0) {
        const now = Math.floor(Date.now() / 1000);
        durationMs = Math.max((resetTime - now) * 1000, 60000); // Au moins 1 minute
      }
    }
  }
  
  // Analyser le corps pour des indications de durée
  if (body) {
    const lowerBody = body.toLowerCase();
    if (lowerBody.includes("15 minutes") || lowerBody.includes("15 min")) {
      durationMs = 15 * 60 * 1000;
    } else if (lowerBody.includes("30 minutes") || lowerBody.includes("30 min")) {
      durationMs = 30 * 60 * 1000;
    } else if (lowerBody.includes("1 hour") || lowerBody.includes("60 minutes")) {
      durationMs = 60 * 60 * 1000;
    }
  }
  
  const until = Date.now() + durationMs;
  accountRestrictedUntil.set(username.toLowerCase(), until);
  const endTime = new Date(until).toISOString().slice(11, 16);
  console.warn(`[usa] 🔒 Compte ${username} marqué "restreint" jusqu'à ${endTime} UTC (~${Math.round(durationMs / 60000)} min)`);
}
```

### 4. Ajouter un système de collecte d'exemples

```typescript
// Pour déboguer et améliorer la détection
const restrictionExamples = new Map<string, { body: string; headers: Record<string, string>; timestamp: number }>();

function collectRestrictionExample(response: Response, body: string) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  const example = {
    body: body.substring(0, 1000), // Limiter la taille
    headers,
    timestamp: Date.now()
  };
  
  // Garder seulement les 10 derniers exemples
  const key = `${response.status}-${Date.now()}`;
  restrictionExamples.set(key, example);
  
  if (restrictionExamples.size > 10) {
    const firstKey = Array.from(restrictionExamples.keys())[0];
    restrictionExamples.delete(firstKey);
  }
  
  console.log(`[usa] 📝 Exemple de restriction collecté (${response.status})`);
}
```

## Facteurs déclenchant la suspension

Basé sur l'analyse du code et des patterns, les facteurs probables sont :

### 1. Patterns comportementaux détectables
- **Fréquence trop élevée** des requêtes
- **Absence de variabilité** dans les intervalles
- **Timing prédictible** (ex: toutes les 55 minutes exactement)

### 2. Fingerprinting incomplet
- **Ordre des headers incorrect**
- **Headers CORS manquants**
- **X-Correlation-key absent ou incorrect**
- **User-Agent non cohérent**

### 3. Patterns de requêtes
- **Flow API identique** à chaque cycle
- **Absence de requêtes "bruit"** (landingPage, sanityCheck, checkFcs)
- **Timing trop régulier** entre les requêtes

## Stratégies d'évitement

### 1. Améliorer le fingerprinting
```typescript
// Ajouter plus de variabilité dans les headers
function getEnhancedBrowserHeaders() {
  const baseHeaders = getBrowserHeaders();
  
  // Ajouter des headers optionnels de manière aléatoire
  const extraHeaders: Record<string, string> = {};
  
  if (Math.random() > 0.5) {
    extraHeaders["Sec-Fetch-Dest"] = "document";
    extraHeaders["Sec-Fetch-Mode"] = "navigate";
    extraHeaders["Sec-Fetch-Site"] = "same-origin";
  }
  
  if (Math.random() > 0.3) {
    extraHeaders["Accept-Encoding"] = "gzip, deflate, br";
  }
  
  return { ...baseHeaders, ...extraHeaders };
}
```

### 2. Ajouter de la variabilité comportementale
```typescript
// Jitter aléatoire sur les intervalles
function getJitteredDelay(baseDelayMs: number, jitterPercent = 0.2): number {
  const jitter = baseDelayMs * jitterPercent;
  return baseDelayMs + (Math.random() * 2 * jitter - jitter);
}

// Varier l'ordre des requêtes dans un cycle
async function executeWithVariability(operations: Array<() => Promise<any>>) {
  // Mélanger aléatoirement l'ordre des opérations (sans affecter la logique)
  const shuffled = [...operations];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  // Exécuter dans l'ordre mélangé (si l'ordre n'est pas critique)
  for (const op of shuffled) {
    await op();
  }
}
```

### 3. Gestion intelligente des sessions
```typescript
// Rotation intelligente des comptes
class AccountRotationManager {
  private accounts: Array<{ username: string; lastUsed: number; restrictionUntil?: number }> = [];
  
  constructor(accounts: string[]) {
    this.accounts = accounts.map(username => ({ username, lastUsed: 0 }));
  }
  
  getNextAvailableAccount(): string | null {
    const now = Date.now();
    
    // Filtrer les comptes non restreints
    const available = this.accounts.filter(acc => 
      !acc.restrictionUntil || acc.restrictionUntil < now
    );
    
    if (available.length === 0) {
      return null;
    }
    
    // Prendre le compte le moins récemment utilisé
    available.sort((a, b) => a.lastUsed - b.lastUsed);
    const selected = available[0];
    selected.lastUsed = now;
    
    return selected.username;
  }
  
  markAccountRestricted(username: string, durationMs: number) {
    const account = this.accounts.find(acc => acc.username === username);
    if (account) {
      account.restrictionUntil = Date.now() + durationMs;
    }
  }
}
```

## Conclusion

La logique de suspension temporaire dans le portail USA est principalement gérée côté backend avec des réponses HTTP 401/403/429 contenant des messages textuels. La fonction `isRestrictedBody()` actuelle est un bon point de départ mais peut être améliorée pour :

1. **Détecter plus de patterns** (comme "account is locked")
2. **Utiliser les headers HTTP** (Retry-After, X-RateLimit-*)
3. **Extraire dynamiquement la durée** de restriction
4. **Collecter des exemples** pour améliorer continuellement la détection

Les suspensions semblent être déclenchées par des patterns comportementaux détectables plutôt que par des signatures techniques spécifiques, ce qui suggère qu'une approche plus humaine (variabilité, jitter, fingerprinting complet) est la clé pour les éviter.