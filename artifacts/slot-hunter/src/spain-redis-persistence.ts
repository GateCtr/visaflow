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

const REDIS_SPAIN_GA_KEY = "visaflow:spain-ga:profile";
const REDIS_SPAIN_GA_TTL_SEC = 30 * 24 * 60 * 60; // 30 jours

/**
 * Clé du verrou distribué : une seule instance scanne à la fois.
 * TTL = durée max d'un cycle complet (CF solve 20s + scan 10s + marge).
 */
const REDIS_SPAIN_LOCK_KEY = "visaflow:spain-scanner:lock";
const REDIS_SPAIN_LOCK_TTL_SEC = 50; // libéré automatiquement si l'instance crashe

/**
 * Identifiant unique de cette instance (Railway vs Replit, etc.).
 * Permet de ne libérer que son propre verrou.
 */
export const SPAIN_INSTANCE_ID = (
  process.env.RAILWAY_REPLICA_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.INSTANCE_ID ||
  `local-${process.pid}`
);

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
  source?: "playwright" | "capsolver" | "direct";
  /**
   * Contenu JSONP pré-fetchée de /onlinebookings/main/ via le browser Chromium.
   * Persisté dans Redis pour que les sessions persistent-browser survivent aux
   * redéploiements — évite de retomber dans le JSD cookie-fantôme loop au restart.
   * ~100-120 KB ; TTL aligné sur cf_clearance (~2h).
   */
  prefetchedMainHtml?: string;
}

export interface SerializableSoaxRotation {
  rotationCounts: Record<string, number>; // identifier → count
  savedAt: number;
}

/**
 * Profil GA long-terme (30 jours).
 * _ga = client ID stable (représente "le même visiteur" pour GA Analytics + CF).
 * sessionCount = compteur de sessions (champ $oN dans _ga_F3TYSDL945) — s'incrémente
 *   à chaque nouveau solve CF pour simuler un visiteur récurrent.
 */
export interface SerializableGaProfile {
  /** Valeur complète du cookie _ga : "GA1.1.<clientRnd>.<firstVisitTs>" */
  ga: string;
  /** Nombre de sessions depuis la création du profil. Utilisé pour $oN dans _ga_F3. */
  sessionCount: number;
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
// DISTRIBUTED LOCK (évite deux instances qui scannent simultanément)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Essaie d'acquérir le verrou de scan exclusif (Redis SET NX).
 *
 * @returns true si le verrou a été acquis par cette instance, false si une
 *          autre instance le détient déjà (→ skip ce cycle).
 *
 * Si Redis est indisponible, retourne toujours true (pas de coordination
 * possible → chaque instance scanne de façon indépendante, comportement
 * identique à l'état actuel).
 */
export async function acquireSpainScannerLock(): Promise<boolean> {
  if (!redisReady || !redisClient) return true; // Redis absent → pas de lock

  try {
    // SET NX EX : réussit seulement si la clé n'existe pas déjà
    const result = await redisClient.set(REDIS_SPAIN_LOCK_KEY, SPAIN_INSTANCE_ID, {
      NX: true,
      EX: REDIS_SPAIN_LOCK_TTL_SEC,
    });
    return result === "OK";
  } catch {
    return true; // Redis erreur transiente → pas de lock
  }
}

/**
 * Libère le verrou uniquement si cette instance l'a acquis.
 * Utilise un script Lua pour garantir l'atomicité check+delete.
 */
export async function releaseSpainScannerLock(): Promise<void> {
  if (!redisReady || !redisClient) return;

  try {
    // Lua : DEL seulement si la valeur correspond à notre instanceId
    await (redisClient as any).eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      { keys: [REDIS_SPAIN_LOCK_KEY], arguments: [SPAIN_INSTANCE_ID] },
    );
  } catch {
    // Non-fatal : le TTL auto-libère le verrou de toute façon
  }
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
// GA PROFILE (client ID stable 30 jours — profil visiteur récurrent)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sauvegarde le profil GA dans Redis avec un TTL de 30 jours.
 * Fire-and-forget.
 */
export function syncGaProfileToRedis(profile: SerializableGaProfile): void {
  if (!redisReady || !redisClient) return;
  redisClient
    .set(REDIS_SPAIN_GA_KEY, JSON.stringify(profile), { EX: REDIS_SPAIN_GA_TTL_SEC })
    .catch((err: Error) => {
      console.warn(`[spain-redis] GA profile sync échouée: ${err.message}`);
    });
}

/**
 * Restaure le profil GA depuis Redis.
 * Retourne null si absent ou Redis indisponible.
 */
export async function restoreGaProfileFromRedis(): Promise<SerializableGaProfile | null> {
  if (!redisReady || !redisClient) return null;
  try {
    const data = await redisClient.get(REDIS_SPAIN_GA_KEY);
    if (!data) return null;
    return JSON.parse(data) as SerializableGaProfile;
  } catch (err) {
    console.warn(`[spain-redis] GA profile restore échouée: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Applique un profil GA stable (30 jours) sur les cookies de session.
 *
 * Logique :
 *   1. Tente de restaurer le profil depuis Redis (TTL 30j).
 *   2. Si trouvé → réutilise le même ga client ID + incrémente sessionCount.
 *   3. Si absent → utilise le _ga capturé par Playwright (currentAllCookies)
 *      OU génère un _ga synthétique stable basé sur sessionCreatedAt.
 *   4. Reconstruit _ga_F3TYSDL945 avec les timestamps courants + sessionCount.
 *   5. Persiste le profil mis à jour dans Redis (TTL réinitialisé à 30j).
 *   6. Retourne le tableau allCookies avec _ga et _ga_F3TYSDL945 mis à jour.
 *
 * POURQUOI _ga_F3TYSDL945 n'est PAS persisté 30 jours :
 *   C'est un cookie de session GA4 (timestamps courants, durée de session…).
 *   Un vrai navigateur le régénère à chaque visite — persister une valeur figée
 *   serait un signal bot. On persiste uniquement le client ID (_ga) et sessionCount.
 */
export async function applyStableGaProfile(
  currentAllCookies: Array<{ name: string; value: string }>,
  sessionCreatedAt: number,
): Promise<Array<{ name: string; value: string }>> {
  const nowSec = Math.floor(Date.now() / 1000);

  // ─── 1. Restaurer ou créer le profil ────────────────────────────────────
  const existing = await restoreGaProfileFromRedis();

  let gaValue: string;
  let sessionCount: number;

  if (existing) {
    // Visiteur connu — même client ID, session suivante
    gaValue = existing.ga;
    sessionCount = existing.sessionCount + 1;
    const ageDays = Math.round((Date.now() - existing.savedAt) / 86_400_000);
    console.log(
      `[spain-redis] ♻️ Profil GA restauré (${ageDays}j) | client: ${gaValue.slice(0, 25)}… | session #${sessionCount}`
    );
  } else {
    // Nouveau profil — priorité au _ga capturé par le navigateur Playwright
    const playwrightGa = currentAllCookies.find((c) => c.name === "_ga")?.value;
    if (playwrightGa) {
      gaValue = playwrightGa;
      console.log(`[spain-redis] 🆕 Nouveau profil GA depuis Playwright: ${gaValue.slice(0, 25)}…`);
    } else {
      // Fallback synthétique — seed sur sessionCreatedAt pour reproductibilité
      const clientRnd = 100_000_000 + (sessionCreatedAt % 900_000_000);
      // firstVisitTs = "15 à 45 jours avant le premier solve" → visiteur avec historique
      const firstVisitTs = Math.floor(sessionCreatedAt / 1000) - (15 + (sessionCreatedAt % 30)) * 86_400;
      gaValue = `GA1.1.${clientRnd}.${firstVisitTs}`;
      console.log(`[spain-redis] 🆕 Nouveau profil GA synthétique (seed session): ${gaValue.slice(0, 25)}…`);
    }
    sessionCount = 1;
  }

  // ─── 2. Reconstruire _ga_F3TYSDL945 avec timestamps courants ────────────
  // Format Burp confirmé : GS2.1.s<sessionTs>$o<N>$g0$t<ts>$j60$l0$h0
  // s<sessionTs> = début de cette session (maintenant)
  // $o<N>        = numéro de session (1, 2, 3… comme un vrai visiteur récurrent)
  // $t<ts>       = timestamp courant (identique à s<sessionTs> au premier load)
  const gaF3Value = `GS2.1.s${nowSec}$o${sessionCount}$g0$t${nowSec}$j60$l0$h0`;

  // ─── 3. Persister le profil mis à jour (TTL réinitialisé à 30j) ─────────
  syncGaProfileToRedis({ ga: gaValue, sessionCount, savedAt: Date.now() });

  // ─── 4. Mettre à jour allCookies — remplacer _ga et _ga_F3TYSDL945 ──────
  const filtered = currentAllCookies.filter(
    (c) => c.name !== "_ga" && c.name !== "_ga_F3TYSDL945"
  );
  return [
    { name: "_ga", value: gaValue },
    { name: "_ga_F3TYSDL945", value: gaF3Value },
    ...filtered,
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// API PREFETCH CACHE (getwidgetconfigurations/ + getservices/ + getagendas/ + datetime/)
// ═══════════════════════════════════════════════════════════════════════════════

const REDIS_SPAIN_API_CACHE_KEY = "visaflow:spain-api-cache:v1";
/**
 * TTL aligné sur le cf_clearance (~2h) — le cache est valide tant que la session CF l'est.
 * getwidgetconfigurations/ et getservices/ ne dépendent pas du PHPSESSID donc ils survivent
 * au-delà des 30min du bookitit config.
 */
const REDIS_SPAIN_API_CACHE_TTL_SEC = 2 * 60 * 60; // 2h

export interface SerializableApiPrefetchCache {
  entries: Record<string, string>; // cacheKey → raw JSONP response
  savedAt: number;
}

/**
 * Sauvegarde le cache API prefetch dans Redis.
 * Fire-and-forget — n'interrompt pas le scan.
 */
export function syncApiPrefetchCacheToRedis(cache: Map<string, string>): void {
  if (!redisReady || !redisClient || cache.size === 0) return;

  const serializable: SerializableApiPrefetchCache = {
    entries: Object.fromEntries(cache),
    savedAt: Date.now(),
  };

  redisClient
    .set(REDIS_SPAIN_API_CACHE_KEY, JSON.stringify(serializable), { EX: REDIS_SPAIN_API_CACHE_TTL_SEC })
    .catch((err: Error) => {
      console.warn(`[spain-redis] API prefetch cache sync échouée: ${err.message}`);
    });
}

/**
 * Restaure le cache API prefetch depuis Redis.
 * Retourne null si absent ou Redis indisponible.
 */
export async function restoreApiPrefetchCacheFromRedis(): Promise<Map<string, string> | null> {
  if (!redisReady || !redisClient) return null;

  try {
    const data = await redisClient.get(REDIS_SPAIN_API_CACHE_KEY);
    if (!data) return null;

    const parsed = JSON.parse(data) as SerializableApiPrefetchCache;
    const ageMin = Math.round((Date.now() - parsed.savedAt) / 60_000);
    const map = new Map<string, string>(Object.entries(parsed.entries));

    // Filtrer les entrées vides
    for (const [k, v] of map) {
      if (!v || v.length === 0) map.delete(k);
    }

    if (map.size === 0) return null;

    console.log(`[spain-redis] ✅ API prefetch cache restauré (âge: ${ageMin}min, ${map.size} entrées)`);
    return map;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spain-redis] ⚠️ Restauration API prefetch cache échouée: ${msg}`);
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
