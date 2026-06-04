/**
 * CEV Redis Persistence — Sauvegarde/restauration de l'état du dossier loop + sessions VOWINT.
 *
 * MOTIVATION :
 *   Le CevDossierPool (currentIndex, clickTimestamps) et le vowintSessionCache (cookies login)
 *   sont perdus à chaque redémarrage. Conséquences :
 *   - currentIndex repart à 0 → le bot re-scanne un dossier déjà rate-limité côté serveur
 *   - clickTimestamps vides → le bot dépasse les 5 clics/h → rate-limit immédiat
 *   - vowintSessionCache vide → re-login inutile → gaspille le budget login
 *
 *   Avec Redis :
 *   - Le pool reprend exactement où il s'était arrêté
 *   - Les clics récents sont restaurés → pas de double rate-limit
 *   - La session VOWINT est restaurée → pas de re-login inutile
 *
 * ARCHITECTURE :
 *   - Clés préfixées "visaflow:cev-pool:" et "visaflow:cev-vowint:"
 *   - TTL adaptés (pool: 2h car basé sur fenêtre 1h, vowint: 25h car session longue)
 *   - Sync fire-and-forget (non-bloquant pour le loop principal)
 *   - Graceful degradation si Redis indisponible
 */

import { createClient, type RedisClientType } from "redis";

// ─── Configuration ──────────────────────────────────────────────────────────

const REDIS_CEV_POOL_KEY = "visaflow:cev-pool:state";
const REDIS_CEV_POOL_TTL_SEC = 2 * 60 * 60; // 2h (la fenêtre de clics est 1h, on garde de la marge)

const REDIS_CEV_VOWINT_PREFIX = "visaflow:cev-vowint:";
const REDIS_CEV_VOWINT_TTL_SEC = 25 * 60 * 60; // 25h (session VOWINT dure ~24h)

// ─── Types sérialisables ────────────────────────────────────────────────────

export interface SerializablePoolState {
  currentIndex: number;
  slots: Array<{
    vowintRef: string;
    clickTimestamps: number[];
    totalScans: number;
    rateLimitCount: number;
  }>;
  savedAt: number; // timestamp de la dernière sauvegarde
  scanCount?: number; // compteur global de scans (persisté pour survivre aux redémarrages)
}

export interface SerializableVowintSession {
  cookies: string;
  appId: string;
  ua: string;
  lastUsedAt: number;
}

// ─── État Redis ─────────────────────────────────────────────────────────────

let redisClient: RedisClientType | null = null;
let redisReady = false;
let connectionAttempted = false;

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Initialise la connexion Redis pour la persistance CEV.
 * Appeler au démarrage du dossier loop.
 * Si Redis est indisponible → fonctionne en mémoire seule (graceful).
 */
export async function initCevRedis(): Promise<boolean> {
  if (connectionAttempted) return redisReady;
  connectionAttempted = true;

  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUsername = process.env.REDIS_USERNAME || "default";

  if (!redisUrl && !redisHost) {
    console.log("[cev-redis] ⚠️ Pas de Redis configuré — persistance CEV désactivée");
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
        console.warn(`[cev-redis] ⚠️ Erreur Redis (non-fatal): ${err.message}`);
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
    console.log("[cev-redis] ✅ Redis connecté pour persistance CEV");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cev-redis] ⚠️ Connexion échouée (non-fatal): ${msg}`);
    redisClient = null;
    redisReady = false;
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POOL STATE (currentIndex + clickTimestamps)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde l'état complet du pool dans Redis.
 * Fire-and-forget — n'interrompt pas le loop en cas d'erreur.
 */
export function syncPoolStateToRedis(state: SerializablePoolState): void {
  if (!redisReady || !redisClient) return;

  const data = JSON.stringify({ ...state, savedAt: Date.now() });
  redisClient.set(REDIS_CEV_POOL_KEY, data, { EX: REDIS_CEV_POOL_TTL_SEC }).catch((err: Error) => {
    console.warn(`[cev-redis] Pool sync échouée: ${err.message}`);
  });
}

/**
 * Restaure l'état du pool depuis Redis.
 * Retourne null si rien en cache ou si Redis est indisponible.
 * Filtre automatiquement les clickTimestamps > 1h (expirés).
 */
export async function restorePoolStateFromRedis(): Promise<SerializablePoolState | null> {
  if (!redisReady || !redisClient) return null;

  try {
    const data = await redisClient.get(REDIS_CEV_POOL_KEY);
    if (!data) return null;

    const parsed = JSON.parse(data) as SerializablePoolState;
    const now = Date.now();
    const CLICK_WINDOW_MS = 60 * 60 * 1000; // 1h — même valeur que dans le dossier loop

    // Purger les clickTimestamps expirés (> 1h)
    for (const slot of parsed.slots) {
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
    }

    const age = now - parsed.savedAt;
    const ageMin = Math.round(age / 60_000);
    console.log(`[cev-redis] ✅ Pool state restauré (sauvé il y a ${ageMin}min, ${parsed.slots.length} dossiers, index=${parsed.currentIndex})`);

    // Log détaillé par dossier
    for (const slot of parsed.slots) {
      if (slot.clickTimestamps.length > 0) {
        console.log(`[cev-redis]   ${slot.vowintRef}: ${slot.clickTimestamps.length} clics actifs, ${slot.totalScans} scans total, ${slot.rateLimitCount} RL`);
      }
    }

    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cev-redis] ⚠️ Restauration pool échouée: ${msg}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VOWINT SESSION (login cookies)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde une session VOWINT dans Redis.
 * Appelé après un login réussi ou un cache hit (pour rafraîchir le TTL).
 * Fire-and-forget.
 */
export function syncVowintSessionToRedis(email: string, session: SerializableVowintSession): void {
  if (!redisReady || !redisClient) return;

  const key = `${REDIS_CEV_VOWINT_PREFIX}${email.toLowerCase()}`;
  const data = JSON.stringify(session);
  redisClient.set(key, data, { EX: REDIS_CEV_VOWINT_TTL_SEC }).catch((err: Error) => {
    console.warn(`[cev-redis] Vowint session sync échouée: ${err.message}`);
  });
}

/**
 * Restaure une session VOWINT depuis Redis.
 * Retourne null si pas de session en cache ou expirée.
 */
export async function restoreVowintSessionFromRedis(email: string): Promise<SerializableVowintSession | null> {
  if (!redisReady || !redisClient) return null;

  try {
    const key = `${REDIS_CEV_VOWINT_PREFIX}${email.toLowerCase()}`;
    const data = await redisClient.get(key);
    if (!data) return null;

    const parsed = JSON.parse(data) as SerializableVowintSession;

    // Vérifier que la session n'est pas trop vieille (24h max)
    const age = Date.now() - parsed.lastUsedAt;
    if (age > 24 * 60 * 60_000) {
      console.log(`[cev-redis] Session VOWINT ${email.slice(0, 8)}… expirée (${Math.round(age / 3600_000)}h) — ignorée`);
      await redisClient.del(key);
      return null;
    }

    const ageMin = Math.round(age / 60_000);
    console.log(`[cev-redis] ✅ Session VOWINT restaurée: ${email.slice(0, 8)}… (âge: ${ageMin}min, appId: ${parsed.appId.slice(0, 8)}…)`);
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cev-redis] ⚠️ Restauration VOWINT échouée: ${msg}`);
    return null;
  }
}

/**
 * Supprime une session VOWINT de Redis (appelé quand la session est invalidée).
 */
export function removeVowintSessionFromRedis(email: string): void {
  if (!redisReady || !redisClient) return;

  const key = `${REDIS_CEV_VOWINT_PREFIX}${email.toLowerCase()}`;
  redisClient.del(key).catch((err: Error) => {
    console.warn(`[cev-redis] Delete VOWINT échouée: ${err.message}`);
  });
}

/**
 * Restaure TOUTES les sessions VOWINT depuis Redis.
 * Retourne une Map<email, session>.
 */
export async function restoreAllVowintSessionsFromRedis(): Promise<Map<string, SerializableVowintSession>> {
  const result = new Map<string, SerializableVowintSession>();
  if (!redisReady || !redisClient) return result;

  try {
    const keys: string[] = [];
    for await (const key of redisClient.scanIterator({ MATCH: `${REDIS_CEV_VOWINT_PREFIX}*`, COUNT: 50 })) {
      if (Array.isArray(key)) keys.push(...key);
      else keys.push(key as string);
    }

    if (keys.length === 0) return result;

    for (const redisKey of keys) {
      const email = redisKey.slice(REDIS_CEV_VOWINT_PREFIX.length);
      const session = await restoreVowintSessionFromRedis(email);
      if (session) {
        result.set(email, session);
      }
    }

    if (result.size > 0) {
      console.log(`[cev-redis] ✅ ${result.size} session(s) VOWINT restaurée(s) depuis Redis`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cev-redis] ⚠️ Restauration all VOWINT échouée: ${msg}`);
  }

  return result;
}

/**
 * Vérifie si Redis est connecté.
 */
export function isCevRedisReady(): boolean {
  return redisReady;
}

/**
 * Déconnecte Redis proprement (shutdown).
 */
export async function disconnectCevRedis(): Promise<void> {
  if (redisClient) {
    try { await redisClient.quit(); } catch { /* ignore */ }
    redisClient = null;
    redisReady = false;
    console.log("[cev-redis] 🛑 Redis CEV déconnecté");
  }
}
