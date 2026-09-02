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

export const REDIS_CEV_POOL_KEY = "visaflow:cev-pool:state";
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
    lastDailyReset?: number;
  }>;
  pausedDossiers: string[]; // Dossiers en pause (après slot trouvé)
  savedAt: number; // timestamp de la dernière sauvegarde
  scanCount?: number; // compteur global de scans (persisté pour survivre aux redémarrages)
}

export interface SerializableVowintSession {
  cookies: string;
  appId: string;
  ua: string;
  lastUsedAt: number;
  /**
   * FIX #3 : Version du schéma de session.
   * v2 : inclut le cookie F5 TS0110ceb4 (ajouté 2026-06-08).
   * Tout enregistrement sans version ou version < 2 est invalidé à la restauration
   * pour forcer une reconnexion complète avec un jar propre.
   */
  version?: number;
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
export function syncPoolStateToRedis(state: SerializablePoolState, customKey?: string): void {
  if (!redisReady || !redisClient) return;

  const key = customKey || REDIS_CEV_POOL_KEY;
  const data = JSON.stringify({ ...state, savedAt: Date.now() });
  redisClient.set(key, data, { EX: REDIS_CEV_POOL_TTL_SEC }).catch((err: Error) => {
    console.warn(`[cev-redis] Pool sync échouée: ${err.message}`);
  });
}

/**
 * Restaure l'état du pool depuis Redis.
 * Retourne null si rien en cache ou si Redis est indisponible.
 * Filtre automatiquement les clickTimestamps > 1h (expirés).
 * AU DÉMARRAGE FRAIS: vide tous les clics pour éviter les pauses persistantes.
 */
export async function restorePoolStateFromRedis(customKey?: string, freshStart: boolean = false): Promise<SerializablePoolState | null> {
  if (!redisReady || !redisClient) return null;

  try {
    const key = customKey || REDIS_CEV_POOL_KEY;
    const data = await redisClient.get(key);
    if (!data) return null;

    const parsed = JSON.parse(data) as SerializablePoolState;
    const now = Date.now();
    const CLICK_WINDOW_MS = 60 * 60 * 1000; // 1h — même valeur que dans le dossier loop

    // Si freshStart=true, vider tous les clics (démarrage frais)
    if (freshStart) {
      for (const slot of parsed.slots) {
        slot.clickTimestamps = [];
      }
      console.log(`[cev-redis] 🔄 Démarrage frais — tous les clics vidés`);
    } else {
      // Sinon, purger seulement les clickTimestamps expirés (> 1h)
      for (const slot of parsed.slots) {
        slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
      }
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
  // FIX #3: Toujours écrire version: 2 pour invalider les anciens enregistrements sans cookie F5.
  const data = JSON.stringify({ ...session, version: 2 });
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

    // FIX #3: Invalider les sessions sans version ou version < 2 (antérieures au cookie F5 TS0110ceb4).
    // Ces enregistrements corrompent les requêtes actives — forcer une reconnexion complète.
    if (!parsed.version || parsed.version < 2) {
      console.log(`[cev-redis] Session VOWINT ${email.slice(0, 8)}… invalidée (version=${parsed.version ?? "absente"} < 2, antérieure au cookie F5) — reconnexion requise`);
      await redisClient.del(key);
      return null;
    }

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

// ═══════════════════════════════════════════════════════════════════════════════
// DISTRIBUTED SCAN LOCK (anti-double-instance Replit + Railway)
// ═══════════════════════════════════════════════════════════════════════════════

const REDIS_CEV_SCAN_LOCK_PREFIX = "visaflow:cev-scan-lock:";
/** Durée max d'un scan CEV complet (login → captcha → selectSlot). */
const REDIS_CEV_SCAN_LOCK_TTL_SEC = 90;

/**
 * Tente d'acquérir un lock exclusif pour scanner ce dossier.
 *
 * Utilise SET NX EX (Redis atomic) : si la clé n'existe pas → "OK" (lock acquis).
 * Si elle existe déjà → null (une autre instance est en cours sur ce dossier).
 *
 * Sans Redis : retourne toujours true (pas de protection, comportement d'origine).
 *
 * @param dossierId - Référence VOWINT du dossier (ex: "VOWINT6278574")
 * @returns true si le lock est acquis, false si une autre instance l'a déjà.
 */
export async function acquireCevScanLock(dossierId: string): Promise<boolean> {
  if (!redisReady || !redisClient) return true; // pas de Redis → pas de lock
  try {
    const key = `${REDIS_CEV_SCAN_LOCK_PREFIX}${dossierId}`;
    const result = await redisClient.set(key, "1", { NX: true, EX: REDIS_CEV_SCAN_LOCK_TTL_SEC });
    return result === "OK";
  } catch {
    return true; // erreur Redis → pas de blocage
  }
}

/**
 * Libère le lock de scan pour ce dossier.
 * Toujours appeler dans un finally pour garantir la libération.
 */
export async function releaseCevScanLock(dossierId: string): Promise<void> {
  if (!redisReady || !redisClient) return;
  try {
    const key = `${REDIS_CEV_SCAN_LOCK_PREFIX}${dossierId}`;
    await redisClient.del(key);
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLOT CLAIM ATOMIQUE PAR CRÉNEAU (coordination inter-comptes / inter-instances)
//
// Problème : plusieurs comptes CEV scannent en parallèle. À l'instant de publication,
// ils voient les mêmes créneaux (souvent 1 place par jour). Sans coordination, ils
// visent tous le PREMIER créneau → collision → un seul gagne, les autres gaspillent
// leur clic ("rendez-vous déjà atteint" / "multiple session").
//
// Solution (calquée sur Spain tryClaimWorkerSlot) : un claim atomique NON BLOQUANT
// par couple (date, heure). Redis sérialise les commandes, donc même si N comptes
// appellent au même instant T, un seul crée la clé et gagne ; les autres reçoivent 0
// et passent IMMÉDIATEMENT au créneau suivant (cascade fallback, aucune attente).
//
// La clé est globale (date:time), tous comptes confondus → répartit naturellement
// les comptes sur des jours/créneaux distincts.
// ═══════════════════════════════════════════════════════════════════════════════

const REDIS_CEV_SLOT_CLAIM_PREFIX = "visaflow:cev-slot-claim:";
/** TTL court — les créneaux CEV se réservent en quelques secondes. */
const REDIS_CEV_SLOT_CLAIM_TTL_SEC = 90;

/**
 * Tentative atomique de réservation d'une place dans un créneau (date, heure).
 *
 * Script Lua : GET → créer (si absent) ou vérifier capacité restante → SET.
 * Valeur JSON : { free: N, booked: M, claimedBy: { accountId: 1 } }
 *
 * NON BLOQUANT : retourne true si ce compte a pu réserver, false sinon (créneau plein).
 * Idempotent : un compte qui a déjà claim ce créneau reçoit true sans double comptage.
 * Mode dégradé (Redis absent ou erreur) : retourne true (on laisse tenter — pas de blocage).
 *
 * @param date      Date du créneau (ex: "2026-09-15")
 * @param time      Heure du créneau (ex: "10:15")
 * @param accountId Identifiant du compte réservant (application CEV)
 * @param freeSlots Places libres connues pour ce créneau (souvent 1)
 * @returns true si la réservation est accordée, false si le créneau est déjà plein.
 */
export async function tryClaimCevSlot(
  date: string,
  time: string,
  accountId: string,
  freeSlots: number,
): Promise<boolean> {
  if (!redisReady || !redisClient) return true; // dégradé → laisser tenter

  const key = `${REDIS_CEV_SLOT_CLAIM_PREFIX}${date}:${time}`;
  const lua = `
    local key     = KEYS[1]
    local account = ARGV[1]
    local free    = tonumber(ARGV[2])
    local ttl     = tonumber(ARGV[3])
    local raw     = redis.call("GET", key)
    if raw == false then
      local val = cjson.encode({free=free, booked=1, claimedBy={[account]=1}})
      redis.call("SET", key, val, "EX", ttl)
      return 1
    end
    local data = cjson.decode(raw)
    if data.claimedBy and data.claimedBy[account] ~= nil then return 1 end
    if (data.booked or 0) + 1 <= (data.free or free) then
      data.booked = (data.booked or 0) + 1
      if not data.claimedBy then data.claimedBy = {} end
      data.claimedBy[account] = 1
      redis.call("SET", key, cjson.encode(data), "EX", ttl)
      return 1
    end
    return 0
  `;
  try {
    const result = await (redisClient as unknown as {
      eval: (script: string, opts: { keys: string[]; arguments: string[] }) => Promise<unknown>;
    }).eval(lua, {
      keys: [key],
      arguments: [accountId, String(Math.max(1, freeSlots)), String(REDIS_CEV_SLOT_CLAIM_TTL_SEC)],
    });
    return result === 1;
  } catch (e) {
    console.warn(`[cev-redis] tryClaimCevSlot: ${e instanceof Error ? e.message : e}`);
    return true; // dégradé
  }
}

/**
 * Libère la réservation d'un compte sur un créneau (date, heure) de façon atomique.
 *
 * Appelé quand un booking échoue APRÈS un claim réussi, pour qu'un autre compte
 * puisse tenter ce créneau. Ne supprime que la réservation du compte appelant ;
 * la clé n'est détruite que s'il ne reste plus aucun claim.
 *
 * @param date      Date du créneau
 * @param time      Heure du créneau
 * @param accountId Identifiant du compte dont on libère la réservation
 */
export async function releaseCevSlot(
  date: string,
  time: string,
  accountId: string,
): Promise<void> {
  if (!redisReady || !redisClient) return;
  const key = `${REDIS_CEV_SLOT_CLAIM_PREFIX}${date}:${time}`;
  const lua = `
    local key     = KEYS[1]
    local account = ARGV[1]
    local ttl     = tonumber(ARGV[2])
    local raw     = redis.call("GET", key)
    if raw == false then return 0 end
    local data = cjson.decode(raw)
    if not data.claimedBy or data.claimedBy[account] == nil then return 0 end
    data.booked = math.max(0, (data.booked or 0) - 1)
    data.claimedBy[account] = nil
    local remaining = 0
    for _ in pairs(data.claimedBy) do remaining = remaining + 1 end
    if remaining == 0 then
      redis.call("DEL", key)
    else
      redis.call("SET", key, cjson.encode(data), "EX", ttl)
    end
    return 1
  `;
  try {
    await (redisClient as unknown as {
      eval: (script: string, opts: { keys: string[]; arguments: string[] }) => Promise<unknown>;
    }).eval(lua, {
      keys: [key],
      arguments: [accountId, String(REDIS_CEV_SLOT_CLAIM_TTL_SEC)],
    });
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RÉSERVATION D'IP PROXY PAR COMPTE (isolation IP inter-comptes, façon Spain)
//
// Problème : sans réservation, deux comptes peuvent tomber sur la même IP Decodo
// (hash collision ou #comptes > #IP) → même exit IP → association de comptes
// détectable côté serveur. Spain résout ça avec un SET NX sur host:port.
//
// Clé normalisée sur host:port (ignore le sticky session id dans le username) :
// un compte qui passe une URL base et un autre une URL sticky du même port
// physique génèrent la MÊME clé → une seule réservation par IP physique.
// ═══════════════════════════════════════════════════════════════════════════════

const REDIS_CEV_IP_RESERVE_PREFIX = "visaflow:cev-ip-reserved:";
const REDIS_CEV_IP_RESERVE_TTL_SEC = 30 * 60; // 30 min — durée d'une fenêtre compte

/** Normalise une URL proxy en clé de réservation stable "prefix:host:port". */
function cevProxyToReserveKey(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    return `${REDIS_CEV_IP_RESERVE_PREFIX}${u.hostname}:${u.port}`;
  } catch {
    return `${REDIS_CEV_IP_RESERVE_PREFIX}${proxyUrl.slice(-40).replace(/[^a-zA-Z0-9:._-]/g, "_")}`;
  }
}

/**
 * Réserve une IP proxy pour un compte (SET NX : échoue si déjà réservée par un autre).
 * Retourne true si la réservation a réussi (ou en mode dégradé sans Redis).
 */
export async function reserveCevIp(proxyUrl: string, accountId: string): Promise<boolean> {
  if (!redisReady || !redisClient) return true; // dégradé → laisser passer
  const key = cevProxyToReserveKey(proxyUrl);
  try {
    const res = await redisClient.set(key, accountId, { NX: true, EX: REDIS_CEV_IP_RESERVE_TTL_SEC });
    if (res === "OK") return true;
    // Déjà réservée : true seulement si c'est CE compte (idempotent / renouvellement).
    const owner = await redisClient.get(key);
    if (owner === accountId) {
      await redisClient.expire(key, REDIS_CEV_IP_RESERVE_TTL_SEC); // renouveler le TTL
      return true;
    }
    return false;
  } catch (e) {
    console.warn(`[cev-redis] reserveCevIp: ${e instanceof Error ? e.message : e}`);
    return true; // dégradé
  }
}

/** Vérifie si une IP est déjà réservée par un AUTRE compte. */
export async function isCevIpReservedByOther(proxyUrl: string, accountId: string): Promise<boolean> {
  if (!redisReady || !redisClient) return false;
  const key = cevProxyToReserveKey(proxyUrl);
  try {
    const val = await redisClient.get(key);
    return val !== null && val !== accountId;
  } catch {
    return false;
  }
}

/**
 * Libère la réservation IP d'un compte avec vérification d'appartenance (Lua atomique).
 * Seul le compte qui détient la réservation peut la libérer.
 */
export async function releaseCevIp(proxyUrl: string, accountId: string): Promise<void> {
  if (!redisReady || !redisClient) return;
  const key = cevProxyToReserveKey(proxyUrl);
  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      redis.call("DEL", KEYS[1])
      return 1
    end
    return 0
  `;
  try {
    await (redisClient as unknown as {
      eval: (script: string, opts: { keys: string[]; arguments: string[] }) => Promise<unknown>;
    }).eval(lua, { keys: [key], arguments: [accountId] });
  } catch { /* ignore */ }
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
