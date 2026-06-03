# Initialisation de la configuration CEV Proxy

## Contexte
Le système CEV a été modifié pour permettre la désactivation du proxy via la clé `cev_use_proxy` dans botConfig. Cette configuration permet d'activer/désactiver dynamiquement l'utilisation du proxy sans re-déployer l'application.

## Modifications effectuées

### 1. Interface admin (BotSettings.tsx)
- Ajout de la clé `cev_use_proxy` dans l'interface admin
- Catégorie: "Mode"
- Type: toggle (0 = désactivé, 1 = activé)
- Description: "Activer/désactiver l'utilisation du proxy pour les sessions CEV. 0 = désactivé (mode direct), 1 = activé (utilise proxy configuré). Désactiver pour tester en mode direct sans proxy."
- Valeur par défaut: "0" (désactivé)

### 2. Code Slot Hunter
#### cev-shared-impit.ts
- Ajout de la fonction `shouldUseProxy()` qui vérifie botConfig avant d'utiliser le proxy
- Cache TTL de 60 secondes pour éviter de surcharger Convex
- Fallback: `true` (utiliser proxy) si Convex inaccessible

#### sessionWorker.ts
- Ajout de la fonction `shouldUseProxyForSessionWorker()` avec la même logique
- Modification de `getProxyUrl()` pour être asynchrone et vérifier botConfig

### 3. Initialisation de la clé

## Instructions d'initialisation

### Option 1: Via le script d'initialisation
1. Configurez les variables d'environnement:
   ```bash
   export CONVEX_SITE_URL="https://votre-site.convex.site"
   export HUNTER_API_KEY="votre-clé-api-hunter"
   ```

2. Exécutez le script:
   ```bash
   cd artifacts/joventy
   node init-cev-proxy-config.js
   ```

### Option 2: Manuellement via l'interface admin
1. Accédez à l'interface admin: `/admin/bot-settings`
2. Trouvez la section "Mode" (catégorie)
3. Recherchez "CEV Utilisation Proxy"
4. La valeur par défaut "0" sera affichée si la clé n'existe pas encore
5. Cliquez sur le toggle pour activer (1) ou laissez désactivé (0)
6. La clé sera automatiquement créée avec la valeur sélectionnée

## Comportement attendu

### Quand `cev_use_proxy = "0"` (désactivé)
- `cevImpitFetch` retournera une URL vide (mode direct)
- `sessionWorker.getProxyUrl()` retournera une chaîne vide
- Les requêtes CEV se feront directement sans proxy
- Log: "[CEV-PROXY-CONFIG] 🔄 Proxy désactivé via botConfig (cev_use_proxy=0)"

### Quand `cev_use_proxy = "1"` (activé)
- Le proxy sera utilisé normalement selon la configuration existante
- `IPROYAL_PROXY_URL` sera utilisé si configuré
- Log: "[CEV-PROXY-CONFIG] 🔄 Proxy activé via botConfig (cev_use_proxy=1)"

### Quand clé non configurée ou autre valeur
- Comportement par défaut: utiliser le proxy s'il est configuré
- Log: "[CEV-PROXY-CONFIG] 🔄 Proxy par défaut (cev_use_proxy non configuré ou ≠ 0/1)"

## Tests recommandés

1. **Test mode direct:**
   - Définir `cev_use_proxy = "0"`
   - Exécuter une session CEV
   - Vérifier que les requêtes passent directement (pas via proxy)

2. **Test mode proxy:**
   - Définir `cev_use_proxy = "1"`
   - S'assurer que `IPROYAL_PROXY_URL` est configuré
   - Exécuter une session CEV
   - Vérifier que les requêtes passent via proxy

3. **Test bascule dynamique:**
   - Lancer une session avec proxy activé
   - Changer la valeur à "0" pendant l'exécution
   - Le changement sera effectif après 60 secondes (TTL du cache)
   - Ou forcer le rechargement avec `forceReloadCevProxyConfig()`

## Notes importantes

- Le cache de 60 secondes évite de surcharger Convex avec des requêtes fréquentes
- En cas d'erreur Convex, le système utilise la valeur en cache ou `true` par défaut
- La fonction `forceReloadCevProxyConfig()` force le rechargement immédiat (utile pour les tests)
- Cette configuration affecte TOUTES les sessions CEV (stealth loop, dossier loop, etc.)
- Le proxy reste utilisé pour les autres portails (USA, Espagne) selon leur propre configuration

## Support technique

En cas de problème:
1. Vérifier les logs "[CEV-PROXY-CONFIG]" dans la console
2. Vérifier que la clé existe dans botConfig (`/admin/bot-settings`)
3. Vérifier la connectivité à Convex
4. Tester avec `forceReloadCevProxyConfig()` pour contourner le cache