/**
 * Germany Redis Persistence — Sauvegarde/restauration de l'état de la boucle RK-Termin.
 *
 * MOTIVATION :
 *   Le germany-loop stocke tout en mémoire (completedJobs, pausedJobs, consecutiveErrors…).
 *   À chaque redémarrage :
 *   - completedJobs vide → risque de re-scanner (et potentiellement double-booker) un dossier déjà réservé
 *   - pausedJobs vide → un job en pause reprend immédiatement, même s'il venait de planter 3× d'affilée
 *   - Pas de lock distribué → Railway + Replit scannent simultanément le même portail
 *
 *   Avec Redis :
 *   - completedJobs restaurés → pas de double-scan post-restart
 *   - pausedJobs restaurés → les cooldowns sont respectés même après un crash
 *   - Lock distribué (SET NX) → une seule instance scanne à la fois
 *
 * ARCHITECTURE :
 *   - Clés préfixées "visaflow:germany:"
 *   - Graceful degradation si Redis indisponible (fonctionnement en mémoire seule)
 *   - Sync fire-and-forget (non-bloquant pour la boucle principale)
 *   - Réutilise les mêmes variables d'env que CEV/Spain Redis
 */

import { createClient, type RedisClientType } from "redis";

// ─── Configuration ──────────────────────────────────────────────────────────

const REDIS_GERMANY_COMPLETED_KEY = "visaflow:germany:completed-jobs";
const REDIS_GERMANY_COMPLETED_TTL_SEC = 7 * 24 * 60 * 60; // 7 jours (RDV réservé reste valide longtemps)

const REDIS_GERMANY_PAUSED_KEY = "visaflow:germany:paused-jobs";
const REDIS_GERMANY_PAUSED_TTL_SEC = 24 * 60 * 60; // 24h (les pauses les plus longues durent 30min)

const REDIS_GERMANY_LOCK_KEY = "visaflow:germany:scanner-lock";
const REDIS_GERMANY_LOCK_TTL_SEC = 120; // 2 min max par cycle (captcha + multi-mois + booking)

/** Identifiant unique de cette instance (Railway vs Replit, etc.). */
export const GERMANY_INSTANCE_ID = (
  process.env.RAILWAY_REPLICA_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.INSTANCE_ID ||
  `local-${process.pid}`
);

// ─── Types sérialisables ────────────────────────────────────────────────────

export interface SerializablePausedJob {
  until: number;   // timestamp ms (Infinity sérialisé en -1)
  reason: string;
}

export interface SerializableGermanyState {
  completedJobIds: string[];
  pausedJobs: Record<string, SerializablePausedJob>;
  savedAt: number;
}

// ─── État Redis ─────────────────────────────────────────────────────────────

let redisClient: RedisClientType | null = null;
let redisReady = false;
let connectionAttempted = false;

// ─── Connexion ───────────────────────────────────────────────────────────────

/**
 * Initialise la connexion Redis pour la persistance Germany.
 * Appeler au démarrage de startGermanyLoop().
 * Si Redis indisponible → fonctionne en mémoire seule (graceful).
 */
export async function initGermanyRedis(): Promise<boolean> {
  if (connectionAttempted) return redisReady;
  connectionAttempted = true;

  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUsername = process.env.REDIS_USERNAME || "default";

  if (!redisUrl && !redisHost) {
    console.log("[germany-redis] ⚠️ Pas de Redis configuré — persistance Germany désactivée");
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
        console.warn(`[germany-redis] ⚠️ Erreur Redis (non-fatal): ${err.message}`);
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
    console.log(`[germany-redis] ✅ Redis connecté (instance: ${GERMANY_INSTANCE_ID})`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[germany-redis] ⚠️ Connexion échouée (non-fatal): ${msg}`);
    redisClient = null;
    redisReady = false;
    return false;
  }
}

export function isGermanyRedisReady(): boolean {
  return redisReady;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ÉTAT DE LA BOUCLE (completedJobs + pausedJobs)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde l'état courant de la boucle Germany dans Redis.
 * Fire-and-forget — non-bloquant.
 *
 * @param completedJobs  Set des jobIds déjà bookés
 * @param pausedJobs     Map jobId → {until, reason}
 */
export function syncGermanyStateToRedis(
  completedJobs: Set<string>,
  pausedJobs: Map<string, { until: number; reason: string }>,
): void {
  if (!redisReady || !redisClient) return;

  const serialized: SerializableGermanyState = {
    completedJobIds: [...completedJobs],
    pausedJobs: Object.fromEntries(
      [...pausedJobs.entries()].map(([id, p]) => [
        id,
        { until: p.until === Infinity ? -1 : p.until, reason: p.reason },
      ])
    ),
    savedAt: Date.now(),
  };

  // Deux clés distinctes avec leurs propres TTL
  const state = JSON.stringify(serialized);

  redisClient
    .set(REDIS_GERMANY_COMPLETED_KEY, JSON.stringify({ ids: serialized.completedJobIds, savedAt: serialized.savedAt }), {
      EX: REDIS_GERMANY_COMPLETED_TTL_SEC,
    })
    .catch((err: Error) => {
      console.warn(`[germany-redis] completedJobs sync échouée: ${err.message}`);
    });

  redisClient
    .set(REDIS_GERMANY_PAUSED_KEY, JSON.stringify({ paused: serialized.pausedJobs, savedAt: serialized.savedAt }), {
      EX: REDIS_GERMANY_PAUSED_TTL_SEC,
    })
    .catch((err: Error) => {
      console.warn(`[germany-redis] pausedJobs sync échouée: ${err.message}`);
    });

  void state; // évite l'avertissement "variable inutilisée"
}

/**
 * Restaure les jobs complétés depuis Redis.
 * Retourne un Set vide si Redis indisponible ou aucune donnée.
 */
export async function restoreCompletedJobsFromRedis(): Promise<Set<string>> {
  if (!redisReady || !redisClient) return new Set();

  try {
    const data = await redisClient.get(REDIS_GERMANY_COMPLETED_KEY);
    if (!data) return new Set();

    const parsed = JSON.parse(data) as { ids: string[]; savedAt: number };
    const ageMin = Math.round((Date.now() - parsed.savedAt) / 60_000);
    console.log(`[germany-redis] ✅ completedJobs restaurés: ${parsed.ids.length} job(s) (âge: ${ageMin}min)`);
    return new Set(parsed.ids);
  } catch (err) {
    console.warn(`[germany-redis] ⚠️ Restauration completedJobs échouée: ${err instanceof Error ? err.message : err}`);
    return new Set();
  }
}

/**
 * Restaure les jobs en pause depuis Redis.
 * Filtre automatiquement les pauses expirées.
 * Retourne une Map vide si Redis indisponible ou aucune donnée.
 */
export async function restorePausedJobsFromRedis(): Promise<Map<string, { until: number; reason: string }>> {
  if (!redisReady || !redisClient) return new Map();

  try {
    const data = await redisClient.get(REDIS_GERMANY_PAUSED_KEY);
    if (!data) return new Map();

    const parsed = JSON.parse(data) as { paused: Record<string, SerializablePausedJob>; savedAt: number };
    const now = Date.now();
    const result = new Map<string, { until: number; reason: string }>();

    for (const [id, p] of Object.entries(parsed.paused)) {
      const until = p.until === -1 ? Infinity : p.until;
      // Ne restaurer que les pauses encore actives (ou les pauses définitives)
      if (until === Infinity || until > now) {
        result.set(id, { until, reason: p.reason });
      }
      // Les pauses expirées sont simplement ignorées → le job reprend naturellement
    }

    const ageMin = Math.round((Date.now() - parsed.savedAt) / 60_000);
    console.log(`[germany-redis] ✅ pausedJobs restaurés: ${result.size} actif(s) (âge: ${ageMin}min)`);
    return result;
  } catch (err) {
    console.warn(`[germany-redis] ⚠️ Restauration pausedJobs échouée: ${err instanceof Error ? err.message : err}`);
    return new Map();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISTRIBUTED LOCK (évite deux instances qui scannent simultanément)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Essaie d'acquérir le verrou de scan Germany (Redis SET NX).
 *
 * @returns true si le verrou est acquis par cette instance, false si une autre
 *          instance scanne déjà (→ skip ce cycle).
 *
 * Si Redis est indisponible, retourne toujours true (pas de coordination
 * possible → chaque instance scanne indépendamment).
 */
export async function acquireGermanyScannerLock(): Promise<boolean> {
  if (!redisReady || !redisClient) return true;

  try {
    const result = await redisClient.set(REDIS_GERMANY_LOCK_KEY, GERMANY_INSTANCE_ID, {
      NX: true,
      EX: REDIS_GERMANY_LOCK_TTL_SEC,
    });
    return result === "OK";
  } catch {
    return true; // erreur transiente → pas de lock
  }
}

/**
 * Libère le verrou Germany uniquement si cette instance l'a acquis (Lua atomique).
 */
export async function releaseGermanyScannerLock(): Promise<void> {
  if (!redisReady || !redisClient) return;

  try {
    await (redisClient as any).eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      { keys: [REDIS_GERMANY_LOCK_KEY], arguments: [GERMANY_INSTANCE_ID] },
    );
  } catch {
    // Non-fatal : TTL auto-libère le verrou
  }
}

// ─── Déconnexion propre ──────────────────────────────────────────────────────

export async function disconnectGermanyRedis(): Promise<void> {
  if (redisClient) {
    try { await redisClient.quit(); } catch { /* ignore */ }
    redisClient = null;
    redisReady = false;
    console.log("[germany-redis] 🛑 Redis Germany déconnecté");
  }
}
