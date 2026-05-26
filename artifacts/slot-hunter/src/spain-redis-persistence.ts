/**
 * Spain Redis Persistence — Sauvegarde/restauration de la session CF Espagne + état SOAX.
 *
 * MOTIVATION :
 *   La session CF (cf_clearance + proxy SOAX sticky) est perdue à chaque redéploiement.
 *   Conséquences sans persistance :
 *   - Re-solve CapSolver à chaque restart (~$0.005 + 7-10s de latence)
 *   - Si le cf_clearance était encore valide (~2h), c'est du gaspillage
 *   - Le rotation counter SOAX repart à 0 → même session ID → conflit IP potentiel
 *
 *   Avec Redis :
 *   - La session CF est restaurée si encore valide → 0 latence au redémarrage
 *   - Le rotation counter est préservé → pas de collision de session SOAX
 *   - Le bookitit config cache est restauré → scan immédiat sans re-fetch
 *
 * ARCHITECTURE :
 *   - Clés préfixées "visaflow:spain-cf:" et "visaflow:spain-soax:"
 *   - TTL aligné sur la durée du cf_clearance (~2h)
 *   - Sync fire-and-forget (non-bloquant)
 *   - Graceful degradation si Redis indisponible
 *   - Réutilise la connexion Redis CEV si disponible, sinon crée la sienne
 */

import { createClient, type RedisClientType } from "redis";

// ─── Configuration ──────────────────────────────────────────────────────────

const REDIS_SPAIN_CF_KEY = "visaflow:spain-cf:session";
const REDIS_SPAIN_CF_TTL_SEC = 2 * 60 * 60; // 2h (aligné sur cf_clearance TTL)

const REDIS_SPAIN_SOAX_KEY = "visaflow:spain-soax:rotation";
const REDIS_SPAIN_SOAX_TTL_SEC = 12 * 60 * 60; // 12h (rotation est basée sur demi-journée)

const REDIS_SPAIN_BOOKITIT_PREFIX = "visaflow:spain-bookitit:";
const REDIS_SPAIN_BOOKITIT_TTL_SEC = 30 * 60; // 30min (aligné sur PHPSESSID)

// ─── Types sérialisables ────────────────────────────────────────────────────

export interface SerializableSpainCfSession {
  cfClearance: string;
  cfDomain: string;
  soaxProxyUrl: string;
  userAgent: string;
  createdAt: number;
  expiresAt: number;
  allCookies: Array<{ name: string; value: string }>;
  extraHeaders: Record<string, string>;
}

export interface SerializableSoaxRotation {
  rotationCounts: Record<string, number>; // identifier → count
  savedAt: number;
}

export interface SerializableBookititConfig {
  baseUrl: string;
  initParams: Record<string, string>;
  services: string[];
  agendas: string[];
  referer: string;
  extractedAt: number;
}

// ─── État Redis ─────────────────────────────────────────────────────────────

let redisClient: RedisClientType | null = null;
let redisReady = false;
let connectionAttempted = false;

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Initialise la connexion Redis pour la persistance Spain.
 * Réutilise les mêmes variables d'environnement que CEV Redis.
 * Si Redis indisponible → fonctionne en mémoire seule (graceful).
 */
export async function initSpainRedis(): Promise<boolean> {
  if (connectionAttempted) return redisReady;
  connectionAttempted = true;

  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUsername = process.env.REDIS_USERNAME || "default";

  if (!redisUrl && !redisHost) {
    console.log("[spain-redis] ⚠️ Pas de Redis configuré — persistance Spain désactivée");
    return false;
  }

  try {
    if (redisUrl) {
      redisClient = createClient({ url: redisUrl }) as RedisClientType;
    } else {
      redisClient = createClient({
        socket: { host: redisHost!, port: parseInt(redisPort || "6379"), connectTimeout: 5000 },
        username: redisUsername,
        password: redisPassword,
      }) as RedisClientType;
    }

    redisClient.on("error", (err: Error) => {
      if (redisReady) {
        console.warn(`[spain-redis] ⚠️ Erreur Redis (non-fatal): ${err.message}`);
      }
      redisReady = false;
    });

    redisClient.on("ready", () => { redisReady = true; });

    const connectPromise = redisClient.connect();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis connect timeout")), 5000)
    );
    await Promise.race([connectPromise, timeoutPromise]);

    redisReady = true;
    console.log("[spain-redis] ✅ Redis connecté pour persistance Spain CF");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spain-redis] ⚠️ Connexion échouée (non-fatal): ${msg}`);
    redisClient = null;
    redisReady = false;
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CF SESSION (cf_clearance + SOAX proxy URL + cookies)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde la session CF Spain dans Redis.
 * Fire-and-forget — n'interrompt pas le scan en cas d'erreur.
 */
export function syncSpainCfSessionToRedis(session: SerializableSpainCfSession): void {
  if (!redisReady || !redisClient) return;

  // TTL dynamique : on calcule le temps restant avant expiration
  const remainingSec = Math.max(
    60, // minimum 1min de TTL
    Math.floor((session.expiresAt - Date.now()) / 1000)
  );

  const data = JSON.stringify(session);
  redisClient.set(REDIS_SPAIN_CF_KEY, data, { EX: remainingSec }).catch((err: Error) => {
    console.warn(`[spain-redis] CF session sync échouée: ${err.message}`);
  });
}

/**
 * Restaure la session CF Spain depuis Redis.
 * Retourne null si :
 *   - Pas de session en cache
 *   - Session expirée (expiresAt < now)
 *   - Redis indisponible
 */
export async function restoreSpainCfSessionFromRedis(): Promise<SerializableSpainCfSession | null> {
  if (!redisReady || !redisClient) return null;

  try {
    const data = await redisClient.get(REDIS_SPAIN_CF_KEY);
    if (!data) return null;

    const parsed = JSON.parse(data) as SerializableSpainCfSession;

    // Vérifier que la session n'est pas expirée
    if (Date.now() >= parsed.expiresAt) {
      console.log(`[spain-redis] Session CF expirée en cache — ignorée`);
      await redisClient.del(REDIS_SPAIN_CF_KEY);
      return null;
    }

    // Vérifier qu'il reste au moins 5min de validité (sinon autant re-solve)
    const remainMin = Math.round((parsed.expiresAt - Date.now()) / 60_000);
    if (remainMin < 5) {
      console.log(`[spain-redis] Session CF presque expirée (${remainMin}min) — ignorée`);
      await redisClient.del(REDIS_SPAIN_CF_KEY);
      return null;
    }

    const ageMin = Math.round((Date.now() - parsed.createdAt) / 60_000);
    console.log(`[spain-redis] ✅ Session CF restaurée (âge: ${ageMin}min, reste: ${remainMin}min, proxy: ${parsed.soaxProxyUrl.slice(0, 40)}…)`);
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spain-redis] ⚠️ Restauration CF échouée: ${msg}`);
    return null;
  }
}

/**
 * Supprime la session CF de Redis (appelé quand invalidée manuellement).
 */
export function removeSpainCfSessionFromRedis(): void {
  if (!redisReady || !redisClient) return;

  redisClient.del(REDIS_SPAIN_CF_KEY).catch((err: Error) => {
    console.warn(`[spain-redis] Delete CF session échouée: ${err.message}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOAX ROTATION STATE (rotation counts par identifier)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde l'état de rotation SOAX dans Redis.
 * Fire-and-forget.
 */
export function syncSoaxRotationToRedis(rotationCounts: Map<string, number>): void {
  if (!redisReady || !redisClient) return;

  const serializable: SerializableSoaxRotation = {
    rotationCounts: Object.fromEntries(rotationCounts),
    savedAt: Date.now(),
  };

  const data = JSON.stringify(serializable);
  redisClient.set(REDIS_SPAIN_SOAX_KEY, data, { EX: REDIS_SPAIN_SOAX_TTL_SEC }).catch((err: Error) => {
    console.warn(`[spain-redis] SOAX rotation sync échouée: ${err.message}`);
  });
}

/**
 * Restaure l'état de rotation SOAX depuis Redis.
 * Retourne null si pas de données ou Redis indisponible.
 */
export async function restoreSoaxRotationFromRedis(): Promise<Map<string, number> | null> {
  if (!redisReady || !redisClient) return null;

  try {
    const data = await redisClient.get(REDIS_SPAIN_SOAX_KEY);
    if (!data) return null;

    const parsed = JSON.parse(data) as SerializableSoaxRotation;
    const ageMin = Math.round((Date.now() - parsed.savedAt) / 60_000);

    const map = new Map<string, number>(Object.entries(parsed.rotationCounts));
    console.log(`[spain-redis] ✅ SOAX rotation restaurée (âge: ${ageMin}min, ${map.size} identifiers)`);
    return map;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spain-redis] ⚠️ Restauration SOAX rotation échouée: ${msg}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKITIT CONFIG CACHE (paramètres widget extractibles)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde la config Bookitit pour un portalUrl dans Redis.
 * Fire-and-forget.
 */
export function syncBookititConfigToRedis(portalUrl: string, config: SerializableBookititConfig): void {
  if (!redisReady || !redisClient) return;

  // Normaliser la clé
  const key = `${REDIS_SPAIN_BOOKITIT_PREFIX}${encodeURIComponent(portalUrl)}`;
  const data = JSON.stringify(config);
  redisClient.set(key, data, { EX: REDIS_SPAIN_BOOKITIT_TTL_SEC }).catch((err: Error) => {
    console.warn(`[spain-redis] Bookitit config sync échouée: ${err.message}`);
  });
}

/**
 * Restaure la config Bookitit depuis Redis.
 * Retourne null si pas en cache, expirée, ou Redis indisponible.
 */
export async function restoreBookititConfigFromRedis(portalUrl: string): Promise<SerializableBookititConfig | null> {
  if (!redisReady || !redisClient) return null;

  try {
    const key = `${REDIS_SPAIN_BOOKITIT_PREFIX}${encodeURIComponent(portalUrl)}`;
    const data = await redisClient.get(key);
    if (!data) return null;

    const parsed = JSON.parse(data) as SerializableBookititConfig;

    // Vérifier le TTL local (30min)
    const age = Date.now() - parsed.extractedAt;
    if (age > 30 * 60_000) {
      console.log(`[spain-redis] Bookitit config expirée (${Math.round(age / 60_000)}min) — ignorée`);
      return null;
    }

    console.log(`[spain-redis] ✅ Bookitit config restaurée (base: ${parsed.baseUrl}, services: ${parsed.services.length})`);
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spain-redis] ⚠️ Restauration Bookitit échouée: ${msg}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Vérifie si Redis Spain est connecté.
 */
export function isSpainRedisReady(): boolean {
  return redisReady;
}

/**
 * Déconnecte Redis proprement (shutdown).
 */
export async function disconnectSpainRedis(): Promise<void> {
  if (redisClient) {
    try { await redisClient.quit(); } catch { /* ignore */ }
    redisClient = null;
    redisReady = false;
    console.log("[spain-redis] 🛑 Redis Spain déconnecté");
  }
}
