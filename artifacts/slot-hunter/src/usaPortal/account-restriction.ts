/**
 * Account Restriction Tracking — Gestion des comptes restreints par le portail USA.
 *
 * FIX-20: Persistance Redis pour survivre aux redéploiements.
 * Le portail USA débloque TOUS les comptes à 00:00 UTC.
 * Sans persistance, un redeploy efface les restrictions en mémoire →
 * le système re-tente immédiatement → nouvelle restriction → boucle infinie.
 *
 * Avec Redis :
 * - Les restrictions survivent aux restarts/redéploiements
 * - Le système ne tente PAS un login sur un compte encore restreint
 * - La deadline est plafonnée à 00:00 UTC (le portail débloque à minuit)
 */

import { createClient, type RedisClientType } from "redis";
import { proxyPool } from "../browser.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const REDIS_RESTRICTION_PREFIX = "visaflow:restriction:";

// ─── État mémoire (source de vérité runtime) ────────────────────────────────

const accountRestrictedUntil = new Map<string, number>();
const accountRestrictionAttempts = new Map<string, number>();
const accountLastRestrictionAt = new Map<string, number>();

// ─── Redis client (réutilise la connexion globale si possible) ──────────────

let redisClient: RedisClientType | null = null;
let redisReady = false;

/**
 * Initialise la persistance Redis pour les restrictions.
 * Appelé par initTokenCacheRedis() ou au démarrage.
 * Si Redis n'est pas disponible → fonctionnement sans persistance (graceful).
 */
export async function initRestrictionRedis(): Promise<number> {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUsername = process.env.REDIS_USERNAME || "default";

  if (!redisUrl && !redisHost) {
    return 0;
  }

  try {
    if (redisUrl) {
      redisClient = createClient({ url: redisUrl }) as RedisClientType;
    } else {
      redisClient = createClient({
        socket: { host: redisHost, port: parseInt(redisPort || "6379") },
        username: redisUsername,
        password: redisPassword,
      }) as RedisClientType;
    }

    redisClient.on("error", (err: Error) => {
      console.warn(`[restriction-redis] Redis error: ${err.message}`);
    });

    await redisClient.connect();
    redisReady = true;

    // Restaurer les restrictions existantes
    const keys = await redisClient.keys(`${REDIS_RESTRICTION_PREFIX}*`);
    let restored = 0;
    const now = Date.now();

    for (const key of keys) {
      try {
        const data = await redisClient.get(key);
        if (!data) continue;

        const parsed = JSON.parse(data) as {
          username: string;
          restrictedUntil: number;
          attempts: number;
          lastRestrictionAt: number;
        };

        // Vérifier si la restriction est encore active
        if (parsed.restrictedUntil > now) {
          const username = parsed.username.toLowerCase();
          accountRestrictedUntil.set(username, parsed.restrictedUntil);
          accountRestrictionAttempts.set(username, parsed.attempts);
          accountLastRestrictionAt.set(username, parsed.lastRestrictionAt);
          restored++;

          const remainingMin = Math.round((parsed.restrictedUntil - now) / 60_000);
          console.log(`[restriction-redis] 🔒 Restauré: ${username.slice(0, 12)}… (restreint encore ${remainingMin}min)`);
        } else {
          // Restriction expirée → nettoyer Redis
          await redisClient.del(key);
        }
      } catch { /* skip corrupted entries */ }
    }

    if (restored > 0) {
      console.log(`[restriction-redis] ✅ ${restored} restriction(s) restaurée(s) depuis Redis`);
    }
    return restored;
  } catch (err) {
    console.warn(`[restriction-redis] ⚠️ Redis indisponible — restrictions en mémoire seulement: ${err}`);
    return 0;
  }
}

// ─── Helpers internes ───────────────────────────────────────────────────────

/**
 * Calcule le timestamp de 00:00 UTC du PROCHAIN jour.
 * Le portail USA débloque tous les comptes à minuit UTC.
 */
function getNextMidnightUtc(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return tomorrow.getTime();
}

/**
 * Sync une restriction vers Redis (fire-and-forget).
 */
function syncToRedis(username: string): void {
  if (!redisReady || !redisClient) return;
  const key = username.toLowerCase();
  const until = accountRestrictedUntil.get(key);
  if (!until) return;

  const data = JSON.stringify({
    username: key,
    restrictedUntil: until,
    attempts: accountRestrictionAttempts.get(key) ?? 1,
    lastRestrictionAt: accountLastRestrictionAt.get(key) ?? Date.now(),
  });

  const ttlMs = until - Date.now();
  if (ttlMs <= 0) return;

  const ttlSec = Math.ceil(ttlMs / 1000);

  redisClient.set(`${REDIS_RESTRICTION_PREFIX}${key}`, data, { EX: ttlSec }).catch((err) => {
    console.warn(`[restriction-redis] Erreur sync: ${err}`);
  });
}

/**
 * Supprime une restriction de Redis.
 */
function removeFromRedis(username: string): void {
  if (!redisReady || !redisClient) return;
  redisClient.del(`${REDIS_RESTRICTION_PREFIX}${username.toLowerCase()}`).catch(() => {});
}

// ─── API publique ───────────────────────────────────────────────────────────

export function isAccountRestricted(username: string): boolean {
  const until = accountRestrictedUntil.get(username.toLowerCase());
  if (until === undefined) return false;
  if (Date.now() >= until) {
    // Restriction expirée → nettoyer
    accountRestrictedUntil.delete(username.toLowerCase());
    accountRestrictionAttempts.delete(username.toLowerCase());
    accountLastRestrictionAt.delete(username.toLowerCase());
    removeFromRedis(username);
    return false;
  }
  return true;
}

/** Timestamp fin de restriction (ms), si le compte est encore restreint. */
export function getAccountRestrictionDeadline(username: string): number | undefined {
  const until = accountRestrictedUntil.get(username.toLowerCase());
  if (until && Date.now() < until) return until;
  return undefined;
}

/** Temps restant en ms avant la fin de restriction. 0 si pas restreint. */
export function getRestrictionTimeRemaining(username: string): number {
  const until = accountRestrictedUntil.get(username.toLowerCase());
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

function getRestrictionAttemptCount(username: string): number {
  return accountRestrictionAttempts.get(username.toLowerCase()) || 0;
}

function incrementRestrictionAttempt(username: string): void {
  const key = username.toLowerCase();
  const current = getRestrictionAttemptCount(username);
  accountRestrictionAttempts.set(key, current + 1);
}

function resetRestrictionAttempts(username: string): void {
  accountRestrictionAttempts.delete(username.toLowerCase());
}

function calculateRestrictionDuration(attemptCount: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  // FIX-20: Le portail USA débloque à 00:00 UTC.
  // Durée de base : 3h, avec backoff exponentiel.
  // Mais JAMAIS au-delà de minuit UTC (le portail reset à ce moment).
  const baseDuration = 3 * 60 * 60 * 1000; // 3h
  const maxDuration = 24 * 60 * 60 * 1000;

  if (attemptCount <= 0) {
    return baseDuration;
  }

  const exponentialDuration = baseDuration * Math.pow(2, attemptCount - 1);
  return Math.min(exponentialDuration, maxDuration);
}

export function markAccountRestricted(username: string, durationMs?: number, retryAfterHeader?: string): void {
  const key = username.toLowerCase();

  incrementRestrictionAttempt(username);
  const attemptCount = getRestrictionAttemptCount(username);

  const calculatedDuration = durationMs ?? calculateRestrictionDuration(attemptCount, retryAfterHeader);

  let until = Date.now() + calculatedDuration;

  // FIX-20: Plafonner la restriction à 00:00 UTC (le portail débloque à minuit).
  // Si la durée calculée dépasse minuit, ramener à minuit UTC exactement.
  const nextMidnight = getNextMidnightUtc();
  if (until > nextMidnight) {
    until = nextMidnight;
    console.log(`[usa] 🕛 Restriction plafonnée à 00:00 UTC (portail débloque à minuit)`);
  }

  accountRestrictedUntil.set(key, until);
  accountLastRestrictionAt.set(key, Date.now());

  const endTime = new Date(until).toISOString().slice(11, 16);
  const durationMinutes = Math.round((until - Date.now()) / 60_000);
  const attemptInfo = attemptCount > 1 ? ` (tentative ${attemptCount}, backoff exponentiel)` : "";

  console.warn(`[usa] 🔒 Compte ${username} marqué "restreint" jusqu'à ${endTime} UTC (~${durationMinutes} min${attemptInfo})`);

  // Persister dans Redis
  syncToRedis(key);

  // Libérer le proxy sticky (nouvelle IP au prochain cycle)
  proxyPool.releaseStickyProxy(username);
  console.log(`[usa] 🔄 Sticky proxy libéré pour ${username} — nouvelle IP au prochain cycle`);

  // Auto-cleanup quand la restriction expire
  const timeoutMs = until - Date.now();
  if (timeoutMs > 0) {
    setTimeout(() => {
      if (!isAccountRestricted(username)) {
        resetRestrictionAttempts(username);
        removeFromRedis(username);
        console.log(`[usa] ✅ Compte ${username} : restriction expirée, compteur réinitialisé`);
      }
    }, timeoutMs + 1000);
  }
}

/**
 * Efface la restriction d'un compte (reset manuel ou déblocage détecté).
 */
export function clearAccountRestriction(username: string): void {
  const key = username.toLowerCase();
  accountRestrictedUntil.delete(key);
  accountRestrictionAttempts.delete(key);
  accountLastRestrictionAt.delete(key);
  removeFromRedis(username);
  console.log(`[usa] ✅ Restriction effacée pour ${username}`);
}

export function isRestrictedBody(body: string): boolean {
  const lower = body.toLowerCase();

  const patterns = [
    /temporarily/i,
    /restricted/i,
    /access denied/i,
    /account (is |has been )?locked/i,
    /too many/i,
    /rate limit/i,
    /suspended/i,
    /try again later/i,
    /cooldown/i,
    /wait.*minutes/i,
    /please wait/i,
    /temporary block/i,
    /security measure/i,
    /excessive attempts/i,
    /multiple failed/i,
  ];

  return patterns.some((pattern) => pattern.test(lower));
}
