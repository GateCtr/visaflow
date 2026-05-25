/**
 * Session Pool — Budget Login Allocator global.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Décider si un compte a le DROIT de faire un login, et dans quelle phase.
 *   Compter chaque login consommé. Bloquer au-delà du budget journalier.
 *
 * RÈGLE ABSOLUE :
 *   Max 9 logins/jour/compte (limite portail = 10, marge = 1).
 *   Le 10ème login est RÉSERVÉ — il n'est jamais consommé par le bot.
 *   Si un humain se connecte manuellement, le compte ne sera pas restreint.
 *
 * INTÉGRATION :
 *   - Appelé par getUsaSession() AVANT tout POST /login
 *   - Appelé par accounts-keep-alive performScheduledRelogin()
 *   - Aucun autre chemin ne doit faire de login sans passer par ici
 *
 * PATTERN :
 *   1. canLogin(username) → LoginDecision (check budget + phase + cooldown)
 *   2. recordLogin(username) → void (après login réussi — MAJ compteur)
 *   3. recordProxyDeath(username) → void (diagnostic — pas de login consommé)
 */

import type {
  LoginBudgetConfig,
  LoginBudgetState,
  LoginPhase,
  LoginDecision,
  LoginConsumedEvent,
  LoginDeniedEvent,
  RushWindow,
  SessionPoolConfig,
} from "./types.js";
import { recordRelogin } from "../../daily-stats.js";

// ─── Configuration par défaut ───────────────────────────────────────────────

const DEFAULT_CONFIG: SessionPoolConfig = {
  defaultBudget: {
    maxPerDay: 9,
    allocation: { rush: 4, standard: 3, emergency: 2 },
  },
  resetHourUtc: 0,    // Minuit UTC (confirmé par test 18/05/2026)
  minInterLoginMs: 10 * 60_000,  // 10 min minimum entre deux logins
  nightModeEnabled: true,
};

// ─── Redis persistence ──────────────────────────────────────────────────────
// Persiste les compteurs de login dans Redis pour survivre aux redéploiements.
// Sans ça : redéploiement mid-day → compteur à 0 → logins en trop → restriction.
// Format clé : "visaflow:login-budget:{username}" → JSON LoginBudgetState
// TTL : 25h (couvre le reset à 00:00 UTC + marge)

import { createClient, type RedisClientType } from "redis";

const REDIS_BUDGET_PREFIX = "visaflow:login-budget:";
const REDIS_BUDGET_TTL_SEC = 25 * 60 * 60; // 25h

let redisClient: RedisClientType | null = null;
let redisReady = false;

/** Fenêtres rush par défaut — Kinshasa WAT (UTC+1). */
const DEFAULT_RUSH_WINDOWS: RushWindow[] = [
  { start: 7, end: 9.5, days: [1, 2, 3, 4, 5] },     // Lun-Ven 07:00-09:30
  { start: 12, end: 14 },                              // Tous jours 12:00-14:00
  { start: 14, end: 17, days: [5] },                   // Vendredi 14:00-17:00
];

// ─── État global (singleton) ────────────────────────────────────────────────

/** Budget par compte (clé = username lowercase). */
const budgets = new Map<string, LoginBudgetState>();

/** Config active (mutable — peut être mise à jour via admin). */
let activeConfig: SessionPoolConfig = { ...DEFAULT_CONFIG };

/** Rush windows actives (mutables — configurables admin). */
let rushWindows: RushWindow[] = [...DEFAULT_RUSH_WINDOWS];

/** Listeners pour les événements (logging/stats). */
type LoginEventListener = (event: LoginConsumedEvent | LoginDeniedEvent) => void;
const listeners: LoginEventListener[] = [];

// ─── Helpers internes ───────────────────────────────────────────────────────

/** Retourne l'heure actuelle à Kinshasa (UTC+1) en format décimal. */
function getKinshasaHourDecimal(): number {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  return ((utcH + 1) % 24) + utcM / 60;
}

/** Retourne le jour de la semaine à Kinshasa (1=Lun ... 7=Dim). */
function getKinshasaDayOfWeek(): number {
  const now = new Date();
  // getUTCDay() → 0=Dim, 1=Lun... On veut 1=Lun, 7=Dim
  const utcDay = now.getUTCDay();
  // Ajuster pour UTC+1 (si on est entre 23h-00h UTC, on est déjà demain à Kinshasa)
  const kinshasaHour = (now.getUTCHours() + 1) % 24;
  let adjustedDay = utcDay;
  if (now.getUTCHours() >= 23) {
    adjustedDay = (utcDay + 1) % 7;
  }
  // Convertir : 0=Dim → 7, 1=Lun → 1, etc.
  return adjustedDay === 0 ? 7 : adjustedDay;
}

/** Vérifie si on est actuellement dans une fenêtre rush. */
function isInRushWindow(): boolean {
  const hour = getKinshasaHourDecimal();
  const day = getKinshasaDayOfWeek();

  return rushWindows.some(w => {
    const hourMatch = hour >= w.start && hour < w.end;
    if (!hourMatch) return false;
    if (!w.days || w.days.length === 0) return true;
    return w.days.includes(day);
  });
}

/** Détermine la phase courante (rush, standard, ou emergency fallback). */
function getCurrentPhase(): LoginPhase {
  return isInRushWindow() ? "rush" : "standard";
}

/** Calcule le timestamp de 00:00 UTC du jour courant. */
function getTodayResetTimestamp(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), activeConfig.resetHourUtc, 0, 0, 0);
}

/** Nettoie les logins antérieurs au reset d'aujourd'hui. */
function pruneOldLogins(state: LoginBudgetState): void {
  const resetTs = getTodayResetTimestamp();
  // Si le reset est dans le futur (ex: il est 23h UTC et resetHour=0), prendre hier
  const effectiveReset = resetTs <= Date.now() ? resetTs : resetTs - 24 * 60 * 60_000;

  const before = state.loginTimestamps.length;
  state.loginTimestamps = state.loginTimestamps.filter(ts => ts >= effectiveReset);

  if (state.loginTimestamps.length < before) {
    // Recalculer totalUsed depuis les timestamps restants
    state.totalUsed = state.loginTimestamps.length;
    // Note: usedByPhase ne peut pas être recalculé précisément après pruning
    // (on ne sait plus quelle phase chaque ancien login avait). On reset.
    state.usedByPhase = { rush: 0, standard: 0, emergency: 0 };
  }
}

/** Obtient ou crée le budget d'un compte. */
function getOrCreateBudget(username: string): LoginBudgetState {
  const key = username.toLowerCase();
  let state = budgets.get(key);

  if (!state) {
    state = {
      totalUsed: 0,
      usedByPhase: { rush: 0, standard: 0, emergency: 0 },
      loginTimestamps: [],
      lastLoginAt: 0,
      proxyDeathCount: 0,
    };
    budgets.set(key, state);
  }

  // Toujours nettoyer les vieux logins (après minuit UTC)
  pruneOldLogins(state);
  return state;
}

/** Émet un événement vers tous les listeners. */
function emit(event: LoginConsumedEvent | LoginDeniedEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch { /* non-bloquant */ }
  }
}

/** Sync un budget vers Redis (fire-and-forget). */
function syncBudgetToRedis(username: string): void {
  if (!redisReady || !redisClient) return;
  const key = username.toLowerCase();
  const state = budgets.get(key);
  if (!state) return;

  const data = JSON.stringify(state);
  redisClient.set(`${REDIS_BUDGET_PREFIX}${key}`, data, { EX: REDIS_BUDGET_TTL_SEC }).catch((err) => {
    console.warn(`[session-pool-redis] Erreur sync: ${err}`);
  });
}

/**
 * Initialise la persistence Redis pour les budgets login.
 * Restaure les compteurs existants depuis Redis (survie aux redéploiements).
 * Si Redis est indisponible → fonctionnement en mémoire seule (graceful).
 *
 * Appeler au démarrage du bot (après initTokenCacheRedis).
 */
export async function initSessionPoolRedis(): Promise<number> {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;
  const redisPort = process.env.REDIS_PORT;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisUsername = process.env.REDIS_USERNAME || "default";

  if (!redisUrl && !redisHost) {
    console.log("[session-pool-redis] Pas de Redis configuré — budgets en mémoire seule");
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

    redisClient.on("error", (err) => {
      console.warn(`[session-pool-redis] Redis error: ${err.message}`);
    });

    await redisClient.connect();
    redisReady = true;

    // Restaurer les budgets existants
    const keys = await redisClient.keys(`${REDIS_BUDGET_PREFIX}*`);
    let restored = 0;

    for (const redisKey of keys) {
      try {
        const data = await redisClient.get(redisKey);
        if (!data) continue;

        const state = JSON.parse(data) as LoginBudgetState;
        const username = redisKey.replace(REDIS_BUDGET_PREFIX, "");

        // Nettoyer les vieux logins avant de restaurer
        const resetTs = getTodayResetTimestamp();
        const effectiveReset = resetTs <= Date.now() ? resetTs : resetTs - 24 * 60 * 60_000;
        state.loginTimestamps = state.loginTimestamps.filter(ts => ts >= effectiveReset);
        state.totalUsed = state.loginTimestamps.length;

        if (state.totalUsed > 0) {
          budgets.set(username, state);
          restored++;
          console.log(
            `[session-pool-redis] 🔑 Restauré: ${username.slice(0, 12)}… ` +
            `(${state.totalUsed} logins aujourd'hui, ${activeConfig.defaultBudget.maxPerDay - state.totalUsed} restants)`
          );
        }
      } catch { /* skip corrupted entries */ }
    }

    if (restored > 0) {
      console.log(`[session-pool-redis] ✅ ${restored} budget(s) restauré(s) depuis Redis`);
    } else {
      console.log(`[session-pool-redis] ✅ Redis connecté — aucun budget à restaurer`);
    }
    return restored;
  } catch (err) {
    console.warn(`[session-pool-redis] ⚠️ Redis indisponible — budgets en mémoire seule: ${err}`);
    return 0;
  }
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Vérifie si un compte est autorisé à faire un login MAINTENANT.
 *
 * Vérifie dans l'ordre :
 *   1. Budget global non épuisé (< 9 logins aujourd'hui)
 *   2. Intervalle minimum respecté (10 min depuis dernier login)
 *   3. Phase courante a encore du budget
 *   4. Fallback emergency si phase courante épuisée
 *
 * NE CONSOMME PAS de login. Appeler recordLogin() après un login RÉUSSI.
 */
export function canLogin(username: string, budgetOverride?: LoginBudgetConfig): LoginDecision {
  const state = getOrCreateBudget(username);
  const budget = budgetOverride ?? activeConfig.defaultBudget;
  const now = Date.now();

  // 1. Budget global épuisé ?
  if (state.totalUsed >= budget.maxPerDay) {
    const resetTs = getTodayResetTimestamp() + 24 * 60 * 60_000; // Prochain reset
    const waitMs = Math.max(0, resetTs - now);
    const decision: LoginDecision = {
      allowed: false,
      phase: getCurrentPhase(),
      reason: `Budget épuisé: ${state.totalUsed}/${budget.maxPerDay} logins utilisés aujourd'hui`,
      waitMs,
      remaining: 0,
    };
    emit({
      username: username.toLowerCase(),
      phase: decision.phase,
      reason: decision.reason!,
      timestamp: now,
      totalUsedToday: state.totalUsed,
      waitMs,
    } as LoginDeniedEvent);
    return decision;
  }

  // 2. Intervalle minimum (10 min entre deux logins du même compte)
  if (state.lastLoginAt > 0) {
    const elapsed = now - state.lastLoginAt;
    if (elapsed < activeConfig.minInterLoginMs) {
      const waitMs = activeConfig.minInterLoginMs - elapsed;
      return {
        allowed: false,
        phase: getCurrentPhase(),
        reason: `Intervalle minimum: ${Math.round(waitMs / 60_000)} min avant prochain login`,
        waitMs,
        remaining: budget.maxPerDay - state.totalUsed,
      };
    }
  }

  // 3. Déterminer la phase et vérifier l'allocation
  const phase = getCurrentPhase();
  const phaseAlloc = budget.allocation[phase];
  const phaseUsed = state.usedByPhase[phase];

  if (phaseUsed < phaseAlloc) {
    // Phase courante a du budget → autorisé
    return {
      allowed: true,
      phase,
      waitMs: 0,
      remaining: budget.maxPerDay - state.totalUsed - 1,
    };
  }

  // 4. Phase courante épuisée → fallback sur emergency
  const emergencyUsed = state.usedByPhase.emergency;
  const emergencyAlloc = budget.allocation.emergency;

  if (emergencyUsed < emergencyAlloc) {
    return {
      allowed: true,
      phase: "emergency",
      waitMs: 0,
      remaining: budget.maxPerDay - state.totalUsed - 1,
    };
  }

  // 5. Tout épuisé pour cette phase — peut-on emprunter sur une autre ?
  // Si on est en standard et que le rush n'est pas épuisé → on peut emprunter
  // (le rush est passé, les logins non utilisés sont "libérés")
  if (phase === "standard") {
    const rushUsed = state.usedByPhase.rush;
    const rushAlloc = budget.allocation.rush;
    if (rushUsed < rushAlloc) {
      return {
        allowed: true,
        phase: "rush", // Décompté du pot rush (emprunt)
        waitMs: 0,
        remaining: budget.maxPerDay - state.totalUsed - 1,
      };
    }
  }

  // Tout est épuisé
  const resetTs = getTodayResetTimestamp() + 24 * 60 * 60_000;
  const waitMs = Math.max(0, resetTs - now);
  const decision: LoginDecision = {
    allowed: false,
    phase,
    reason: `Phase "${phase}" épuisée (${phaseUsed}/${phaseAlloc}) + emergency épuisé (${emergencyUsed}/${emergencyAlloc})`,
    waitMs,
    remaining: budget.maxPerDay - state.totalUsed,
  };
  emit({
    username: username.toLowerCase(),
    phase,
    reason: decision.reason!,
    timestamp: now,
    totalUsedToday: state.totalUsed,
    waitMs,
  } as LoginDeniedEvent);
  return decision;
}

/**
 * Enregistre un login RÉUSSI. Incrémente le compteur.
 * À appeler UNIQUEMENT après que POST /login a retourné 200 + token valide.
 */
export function recordLogin(username: string, phase?: LoginPhase): void {
  const state = getOrCreateBudget(username);
  const now = Date.now();
  const effectivePhase = phase ?? getCurrentPhase();

  state.totalUsed++;
  state.usedByPhase[effectivePhase]++;
  state.loginTimestamps.push(now);
  state.lastLoginAt = now;

  const budget = activeConfig.defaultBudget;
  const remaining = budget.maxPerDay - state.totalUsed;

  console.log(
    `[session-pool] 🔑 Login #${state.totalUsed} enregistré pour ${username.slice(0, 12)}… ` +
    `(phase=${effectivePhase}, restant=${remaining}/${budget.maxPerDay})`
  );

  // ─── Daily stats : tracker le re-login ─────────────────────────────────────
  const reloginType = effectivePhase === "emergency" ? "emergency"
    : state.totalUsed === 1 ? "preventive"
    : "reactive";
  recordRelogin("", username, reloginType);

  // Persister dans Redis (fire-and-forget)
  syncBudgetToRedis(username);

  emit({
    username: username.toLowerCase(),
    phase: effectivePhase,
    timestamp: now,
    totalUsedToday: state.totalUsed,
    remainingToday: remaining,
  } as LoginConsumedEvent);
}

/**
 * Enregistre une mort de proxy (diagnostic — ne consomme PAS de login).
 * Utilisé pour tracker combien de logins sont "gaspillés" par des proxies instables.
 */
export function recordProxyDeath(username: string): void {
  const state = getOrCreateBudget(username);
  state.proxyDeathCount++;
  console.log(
    `[session-pool] 💀 Proxy mort pour ${username.slice(0, 12)}… ` +
    `(total morts aujourd'hui: ${state.proxyDeathCount})`
  );
  syncBudgetToRedis(username);
}

// ─── Getters / Stats ────────────────────────────────────────────────────────

/** Retourne le nombre de logins restants aujourd'hui pour un compte. */
export function getRemainingLogins(username: string): number {
  const state = getOrCreateBudget(username);
  return activeConfig.defaultBudget.maxPerDay - state.totalUsed;
}

/** Retourne le nombre total de logins utilisés aujourd'hui. */
export function getUsedLogins(username: string): number {
  return getOrCreateBudget(username).totalUsed;
}

/** Retourne le nombre de morts proxy aujourd'hui (diagnostic). */
export function getProxyDeathCount(username: string): number {
  return getOrCreateBudget(username).proxyDeathCount;
}

/** Retourne true si on est actuellement en rush hour. */
export function isRushHour(): boolean {
  return isInRushWindow();
}

/** Retourne l'état complet du budget (pour le dashboard admin). */
export function getBudgetSnapshot(username: string): {
  totalUsed: number;
  maxPerDay: number;
  remaining: number;
  usedByPhase: Record<LoginPhase, number>;
  proxyDeaths: number;
  lastLoginAt: number;
  isRush: boolean;
  currentPhase: LoginPhase;
} {
  const state = getOrCreateBudget(username);
  const budget = activeConfig.defaultBudget;
  return {
    totalUsed: state.totalUsed,
    maxPerDay: budget.maxPerDay,
    remaining: budget.maxPerDay - state.totalUsed,
    usedByPhase: { ...state.usedByPhase },
    proxyDeaths: state.proxyDeathCount,
    lastLoginAt: state.lastLoginAt,
    isRush: isInRushWindow(),
    currentPhase: getCurrentPhase(),
  };
}

/** Retourne les snapshots de TOUS les comptes gérés. */
export function getAllBudgetSnapshots(): Map<string, ReturnType<typeof getBudgetSnapshot>> {
  const result = new Map<string, ReturnType<typeof getBudgetSnapshot>>();
  for (const [key] of budgets) {
    result.set(key, getBudgetSnapshot(key));
  }
  return result;
}

// ─── Configuration runtime ──────────────────────────────────────────────────

/** Met à jour la config (appelé depuis bot-config Convex ou au démarrage). */
export function updateConfig(partial: Partial<SessionPoolConfig>): void {
  activeConfig = { ...activeConfig, ...partial };
  if (partial.defaultBudget) {
    activeConfig.defaultBudget = { ...DEFAULT_CONFIG.defaultBudget, ...partial.defaultBudget };
  }
  console.log(`[session-pool] ⚙️ Config mise à jour: maxPerDay=${activeConfig.defaultBudget.maxPerDay}, minInterLogin=${activeConfig.minInterLoginMs / 60_000}min`);
}

/** Met à jour les fenêtres rush (depuis bot-config Convex). */
export function updateRushWindows(windows: RushWindow[]): void {
  rushWindows = windows;
  console.log(`[session-pool] ⚙️ Rush windows: ${windows.length} fenêtre(s) configurée(s)`);
}

/** Retourne la config active (lecture seule). */
export function getActiveConfig(): Readonly<SessionPoolConfig> {
  return activeConfig;
}

/** Retourne les rush windows actives. */
export function getActiveRushWindows(): readonly RushWindow[] {
  return rushWindows;
}

// ─── Event listeners ────────────────────────────────────────────────────────

/** Ajoute un listener pour les événements login (consumed/denied). */
export function onLoginEvent(listener: LoginEventListener): void {
  listeners.push(listener);
}

/** Supprime tous les listeners (pour les tests). */
export function clearListeners(): void {
  listeners.length = 0;
}

// ─── Reset (pour les tests) ─────────────────────────────────────────────────

/** Reset complet de l'état (UNIQUEMENT pour les tests unitaires). */
export function _resetForTesting(): void {
  budgets.clear();
  activeConfig = { ...DEFAULT_CONFIG };
  rushWindows = [...DEFAULT_RUSH_WINDOWS];
  listeners.length = 0;
  // Ne PAS reset Redis (les tests unitaires n'ont pas Redis)
}

// ─── Reset budget admin ─────────────────────────────────────────────────────

/**
 * Remet le budget login d'un compte à une valeur donnée (demande admin).
 * Efface l'état en mémoire ET dans Redis.
 * Le compte pourra immédiatement refaire des logins.
 *
 * @param username - Identifiant du compte (email portail)
 * @param newMax - Nouveau budget max (défaut: 7, laisse 2 de marge sur la limite portail de 10)
 */
export function resetBudget(username: string, newMax?: number): void {
  const key = username.toLowerCase();
  const max = newMax ?? activeConfig.defaultBudget.maxPerDay;

  // Effacer l'état en mémoire
  budgets.delete(key);

  // Effacer dans Redis (fire-and-forget)
  if (redisReady && redisClient) {
    redisClient.del(`${REDIS_BUDGET_PREFIX}${key}`).catch((err) => {
      console.warn(`[session-pool] resetBudget Redis del error: ${err}`);
    });
  }

  console.log(`[session-pool] 🔄 Budget reset à ${max} pour ${key} (demande admin)`);
}
