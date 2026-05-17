/**
 * Token Cache Redis Persistence — Sauvegarde/restauration des sessions USA dans Redis.
 *
 * MOTIVATION :
 *   Le tokenCache (Map en mémoire) est perdu à chaque redémarrage du process.
 *   Résultat : re-login de TOUS les comptes à chaque deploy/restart/crash.
 *   Trop de re-logins = restriction Cognito.
 *
 *   Avec Redis, les sessions survivent aux restarts :
 *   - Au démarrage : on restore les tokens valides depuis Redis → 0 re-login inutile
 *   - À chaque set/delete sur tokenCache : on sync vers Redis en background
 *   - Les tokens expirés sont auto-nettoyés via TTL Redis
 *
 * ARCHITECTURE :
 *   Ce module NE remplace PAS tokenCache (Map). Il ajoute une couche de
 *   synchronisation transparente :
 *   1. `initTokenCacheRedis()` → connecte à Redis, restore les sessions valides
 *   2. `syncTokenToRedis(key, token)` → appelé après chaque tokenCache.set()
 *   3. `removeTokenFromRedis(key)` → appelé après chaque tokenCache.delete()
 *   4. Les appelants existants n'ont PAS besoin de changer (backward-compat)
 *
 * SÉCURITÉ :
 *   - Les tokens sont stockés dans Redis avec un TTL = temps restant avant expiration
 *   - Redis Cloud (pas self-hosted) avec authentification
 *   - Si Redis est down → fallback sur le comportement normal (Map seule, pas de crash)
 */

import { createClient, type RedisClientType } from "redis";
import { tokenCache, isCachedTokenValid } from "./usa-http.js";
import type { CachedToken } from "./types.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const REDIS_PREFIX = "visaflow:token:"; // Préfixe pour les clés Redis
const REDIS_CONNECT_TIMEOUT_MS = 5_000; // Timeout de connexion
const SYNC_DEBOUNCE_MS = 500; // Debounce pour éviter les écritures trop fréquentes

// ─── État ───────────────────────────────────────────────────────────────────

let redisClient: RedisClientType | null = null;
let isConnected = false;
let connectionAttempted = false;

// Debounce map pour éviter les écritures Redis trop fréquentes
const pendingSyncs = new Map<string, ReturnType<typeof setTimeout>>();

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Initialise la connexion Redis et restore les sessions existantes dans tokenCache.
 * Appelé UNE FOIS au démarrage du process (dans index.ts ou le main entrypoint).
 *
 * Si Redis n'est pas configuré ou indisponible, le système fonctionne normalement
 * sans persistance (graceful degradation).
 *
 * Branche automatiquement les hooks set/delete sur tokenCache pour que TOUTE
 * écriture/suppression soit synchronisée vers Redis sans changement dans le code existant.
 *
 * @returns Nombre de sessions restaurées depuis Redis.
 */
export async function initTokenCacheRedis(): Promise<number> {
  if (connectionAttempted) return 0;
  connectionAttempted = true;

  const redisUrl = process.env.REDIS_URL;
  // Support aussi les variables séparées (comme fournies par l'utilisateur)
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUsername = process.env.REDIS_USERNAME || "default";

  if (!redisUrl && !redisHost) {
    console.log("[redis-cache] ⚠️ Pas de config Redis (REDIS_URL ou REDIS_HOST) — persistance désactivée");
    return 0;
  }

  try {
    if (redisUrl) {
      redisClient = createClient({ url: redisUrl }) as RedisClientType;
    } else {
      redisClient = createClient({
        username: redisUsername,
        password: redisPassword,
        socket: {
          host: redisHost!,
          port: parseInt(redisPort || "6379", 10),
          connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        },
      }) as RedisClientType;
    }

    redisClient.on("error", (err) => {
      if (isConnected) {
        console.warn(`[redis-cache] ⚠️ Erreur Redis (non-fatal):`, err.message);
      }
      isConnected = false;
    });

    redisClient.on("reconnecting", () => {
      console.log("[redis-cache] 🔄 Reconnexion Redis en cours...");
    });

    redisClient.on("ready", () => {
      isConnected = true;
    });

    // Connexion avec timeout
    const connectPromise = redisClient.connect();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis connect timeout")), REDIS_CONNECT_TIMEOUT_MS)
    );

    await Promise.race([connectPromise, timeoutPromise]);
    isConnected = true;
    console.log("[redis-cache] ✅ Redis connecté — restauration des sessions...");

    // Brancher les hooks sur tokenCache (PersistentTokenCache)
    // Chaque set() et delete() sera automatiquement synchronisé.
    tokenCache._setRedisHooks(
      (key, token) => syncTokenToRedis(key, token),
      (key) => removeTokenFromRedis(key),
    );

    // Restaurer les sessions valides
    const restored = await restoreTokensFromRedis();
    console.log(`[redis-cache] ✅ ${restored} session(s) restaurée(s) depuis Redis`);
    return restored;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[redis-cache] ⚠️ Connexion Redis échouée (non-fatal): ${msg}`);
    console.log("[redis-cache] Le système fonctionne sans persistance (re-login au prochain cycle)");
    redisClient = null;
    isConnected = false;
    return 0;
  }
}

/**
 * Synchronise un token vers Redis après un tokenCache.set().
 * Appelé en fire-and-forget (ne bloque pas le flow principal).
 * Debounced pour éviter les écritures trop fréquentes (lastActivityAt change souvent).
 */
export function syncTokenToRedis(key: string, token: CachedToken): void {
  if (!isConnected || !redisClient) return;

  // Debounce: si une sync est déjà planifiée pour cette clé, la remplacer
  const existing = pendingSyncs.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingSyncs.delete(key);
    _doSyncToken(key, token).catch((err) => {
      console.warn(`[redis-cache] Sync échouée pour ${key.slice(0, 12)}…:`, err.message);
    });
  }, SYNC_DEBOUNCE_MS);

  pendingSyncs.set(key, timer);
}

/**
 * Synchronise immédiatement un token vers Redis (sans debounce).
 * Utilisé pour les opérations critiques (login réussi).
 */
export async function syncTokenToRedisImmediate(key: string, token: CachedToken): Promise<void> {
  if (!isConnected || !redisClient) return;

  // Annuler tout debounce en cours
  const existing = pendingSyncs.get(key);
  if (existing) {
    clearTimeout(existing);
    pendingSyncs.delete(key);
  }

  await _doSyncToken(key, token);
}

/**
 * Supprime un token de Redis après un tokenCache.delete().
 * Fire-and-forget.
 */
export function removeTokenFromRedis(key: string): void {
  if (!isConnected || !redisClient) return;

  // Annuler tout debounce en cours
  const existing = pendingSyncs.get(key);
  if (existing) {
    clearTimeout(existing);
    pendingSyncs.delete(key);
  }

  redisClient.del(REDIS_PREFIX + key).catch((err) => {
    console.warn(`[redis-cache] Delete échoué pour ${key.slice(0, 12)}…:`, err.message);
  });
}

/**
 * Force la sauvegarde de TOUS les tokens actuels dans Redis.
 * Utile avant un shutdown graceful.
 */
export async function flushAllTokensToRedis(): Promise<void> {
  if (!isConnected || !redisClient) return;

  const promises: Promise<void>[] = [];
  for (const [key, token] of tokenCache) {
    promises.push(_doSyncToken(key, token));
  }

  await Promise.allSettled(promises);
  console.log(`[redis-cache] ✅ ${promises.length} token(s) flush vers Redis`);
}

/**
 * Déconnecte proprement Redis.
 * Appelé au shutdown du process.
 */
export async function disconnectRedis(): Promise<void> {
  // Flush avant de déconnecter
  await flushAllTokensToRedis();

  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      // Ignorer les erreurs de déconnexion
    }
    redisClient = null;
    isConnected = false;
    console.log("[redis-cache] 🛑 Redis déconnecté proprement");
  }
}

/**
 * Retourne true si Redis est connecté et opérationnel.
 */
export function isRedisConnected(): boolean {
  return isConnected;
}

// ─── Logique interne ────────────────────────────────────────────────────────

async function _doSyncToken(key: string, token: CachedToken): Promise<void> {
  if (!redisClient || !isConnected) return;

  // Calculer le TTL = temps restant avant expiration du token
  const now = Date.now();
  const ttlMs = token.expiresAt - now;

  // Ne pas sauvegarder les tokens déjà expirés
  if (ttlMs <= 0) {
    await redisClient.del(REDIS_PREFIX + key);
    return;
  }

  // Sérialiser le token (exclure les champs non-sérialisables)
  const serializable: SerializableCachedToken = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    csrfToken: token.csrfToken,
    expiresAt: token.expiresAt,
    userID: token.userID,
    fullName: token.fullName,
    sessionStartedAt: token.sessionStartedAt,
    uaIndex: token.uaIndex,
    proxyUrl: token.proxyUrl,
    proxyExpiresAt: token.proxyExpiresAt,
    jitterMs: token.jitterMs,
    lastActivityAt: token.lastActivityAt,
    lastScanTime: token.lastScanTime,
    allowedOfcs: token.allowedOfcs,
    targetSessionDuration: token.targetSessionDuration,
    keepAliveInterval: token.keepAliveInterval,
    cooldownDurationMs: token.cooldownDurationMs,
    scanCount: token.scanCount,
    sessionScanCap: token.sessionScanCap,
  };

  const ttlSec = Math.ceil(ttlMs / 1000);
  await redisClient.setEx(REDIS_PREFIX + key, ttlSec, JSON.stringify(serializable));
}

async function restoreTokensFromRedis(): Promise<number> {
  if (!redisClient || !isConnected) return 0;

  let restoredCount = 0;

  try {
    // Scanner toutes les clés avec notre préfixe
    const keys: string[] = [];
    for await (const key of redisClient.scanIterator({ MATCH: REDIS_PREFIX + "*", COUNT: 100 })) {
      if (Array.isArray(key)) {
        keys.push(...key);
      } else {
        keys.push(key as string);
      }
    }

    if (keys.length === 0) {
      console.log("[redis-cache] Aucune session en cache Redis");
      return 0;
    }

    // Récupérer tous les tokens
    const values = await Promise.all(keys.map(k => redisClient!.get(k)));

    for (let i = 0; i < keys.length; i++) {
      const redisKey = keys[i];
      const value = values[i];
      if (!value) continue;

      const cacheKey = redisKey.slice(REDIS_PREFIX.length); // Retirer le préfixe

      try {
        const parsed = JSON.parse(value) as SerializableCachedToken;

        // Reconstruire le CachedToken
        const token: CachedToken = {
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          csrfToken: parsed.csrfToken,
          expiresAt: parsed.expiresAt,
          userID: parsed.userID,
          fullName: parsed.fullName,
          sessionStartedAt: parsed.sessionStartedAt,
          uaIndex: parsed.uaIndex,
          proxyUrl: parsed.proxyUrl,
          proxyExpiresAt: parsed.proxyExpiresAt,
          jitterMs: parsed.jitterMs,
          lastActivityAt: parsed.lastActivityAt,
          lastScanTime: parsed.lastScanTime,
          allowedOfcs: parsed.allowedOfcs,
          targetSessionDuration: parsed.targetSessionDuration,
          keepAliveInterval: parsed.keepAliveInterval,
          cooldownDurationMs: parsed.cooldownDurationMs,
          scanCount: parsed.scanCount,
          sessionScanCap: parsed.sessionScanCap,
        };

        // Vérifier que le token est encore valide
        if (isCachedTokenValid(token)) {
          tokenCache.set(cacheKey, token);
          restoredCount++;
          const expiresInMin = Math.round((token.expiresAt - Date.now()) / 60_000);
          console.log(`[redis-cache] 🔑 Restauré: ${cacheKey.slice(0, 12)}… (expire dans ${expiresInMin}min)`);
        } else {
          // Token expiré → supprimer de Redis aussi
          await redisClient.del(redisKey);
          console.log(`[redis-cache] 🗑️ Token expiré supprimé: ${cacheKey.slice(0, 12)}…`);
        }
      } catch (parseErr) {
        console.warn(`[redis-cache] ⚠️ Parse échoué pour ${cacheKey.slice(0, 12)}…:`, parseErr);
        await redisClient.del(redisKey); // Nettoyer la donnée corrompue
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[redis-cache] ⚠️ Erreur lors de la restauration: ${msg}`);
  }

  return restoredCount;
}

// ─── Type sérialisable ──────────────────────────────────────────────────────

interface SerializableCachedToken {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  expiresAt: number;
  userID: number;
  fullName: string;
  sessionStartedAt: number;
  uaIndex?: number;
  proxyUrl?: string;
  proxyExpiresAt?: number;
  jitterMs: number;
  lastActivityAt: number;
  lastScanTime?: number;
  allowedOfcs?: Array<{ postUserId: number }>;
  targetSessionDuration?: number;
  keepAliveInterval?: number;
  cooldownDurationMs?: number;
  scanCount?: number;
  sessionScanCap?: number;
}
