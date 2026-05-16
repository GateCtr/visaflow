/**
 * Continuous Refresh v2 — Smart Refresh avec prédiction, alternance et coordination.
 *
 * AMÉLIORATIONS v2 :
 *   #5 Smart Refresh Interval — 20-180s adaptatif (fenêtre chaude/froide + santé serveur)
 *   #6 Stealthy Alternation — 1/3 getLandingPage, 2/3 getFirstAvailableMonth
 *   #7 Dual-Dossier Coverage — coordination inter-dossiers même tier pour zéro gap
 *
 * CONCEPT ORIGINAL (conservé) :
 *   Après le scan initial, on entre en "mode refresh" avec des fenêtres de 4-8 min
 *   et des pauses humaines entre elles. Budget total ~42 min.
 */

import type { UsaSession } from "./types.js";
import type { HunterJob, SlotDiscoveryEvent } from "../convexClient.js";
import { botLog } from "../convexClient.js";
import {
  USA_FIRST_AVAILABLE_MONTH_URL,
  USA_LANDING_PAGE_URL,
  SCAN_CUTOFF_BEFORE_EXPIRY_MS,
} from "./config.js";
import { usaFetch, authHeaders, tokenCache, updateSessionActivity } from "./usa-http.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { checkProxyLiveness, isSessionFrozen } from "./proxy-session-guard.js";
import type { UsaOfc, UsaAppDetails } from "./usa-scan-types.js";
import { getRefreshMultiplier, isHotWindow, getCurrentPredictionScore } from "./slot-prediction.js";
import {
  getCompetitionRefreshMultiplier,
  recordSlotAppearance,
  recordAllSlotsGone,
  logCompetitionIntelligence,
} from "./competitive-intelligence.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Durée minimale d'une fenêtre de refresh (ms). */
const REFRESH_WINDOW_MIN_MS = 4 * 60 * 1000; // 4 min

/** Durée maximale d'une fenêtre de refresh (ms). */
const REFRESH_WINDOW_MAX_MS = 8 * 60 * 1000; // 8 min

/** Pause minimale entre les fenêtres (ms). */
const BREAK_MIN_MS = 1.5 * 60 * 1000; // 1.5 min

/** Pause maximale entre les fenêtres (ms). */
const BREAK_MAX_MS = 3.5 * 60 * 1000; // 3.5 min

/** Intervalle MINIMUM entre deux refreshes (ms) — Smart Refresh #5. */
const SMART_REFRESH_MIN_MS = 20 * 1000; // 20s (fenêtre chaude)

/** Intervalle MAXIMUM entre deux refreshes (ms) — Smart Refresh #5. */
const SMART_REFRESH_MAX_MS = 180 * 1000; // 3 min (fenêtre froide)

/** Intervalle de base (centre) avant application des multiplicateurs. */
const SMART_REFRESH_BASE_MS = 60 * 1000; // 60s

/** Budget total maximum pour le refresh continu (ms). */
const TOTAL_REFRESH_BUDGET_MS = 42 * 60 * 1000; // 42 min

/** Nombre maximum de fenêtres par session. */
const MAX_WINDOWS = 6;

/** Nombre maximum de refreshes au total (protection anti-abus). */
const MAX_TOTAL_REFRESHES = 45;

/** Ratio endpoint alternation — Stealthy Alternation #6.
 * 1/3 = getLandingPage (léger, pas de payload), 2/3 = getFirstAvailableMonth (réel check). */
const LANDING_PAGE_RATIO = 0.33;

/** Seuil de latence pour considérer le serveur "stressed" (ms). */
const SERVER_STRESSED_LATENCY_MS = 5000;

/** Seuil de latence pour considérer le serveur "degraded" (ms). */
const SERVER_DEGRADED_LATENCY_MS = 3000;

// ─── Dual-Dossier Coverage #7 — Coordination inter-dossiers ────────────────

/**
 * Registry global des fenêtres de refresh actives par tier.
 * Permet à chaque dossier de connaître les périodes couvertes par les autres.
 */
interface DossierRefreshSlot {
  jobId: string;
  username: string;
  tier: string;
  /** Début de la fenêtre de refresh actuelle. */
  windowStart: number;
  /** Fin estimée de la fenêtre (start + windowDuration). */
  windowEnd: number;
  /** Début de la prochaine pause. */
  breakStart: number | null;
  /** Fin estimée de la prochaine pause. */
  breakEnd: number | null;
  /** Dernière mise à jour. */
  lastUpdate: number;
}

const dossierRegistry = new Map<string, DossierRefreshSlot>();

/** Enregistre un dossier dans le registry de coordination. */
export function registerDossierRefresh(
  jobId: string,
  username: string,
  tier: string,
  windowStart: number,
  windowDurationMs: number,
): void {
  dossierRegistry.set(jobId, {
    jobId,
    username,
    tier,
    windowStart,
    windowEnd: windowStart + windowDurationMs,
    breakStart: null,
    breakEnd: null,
    lastUpdate: Date.now(),
  });
}

/** Met à jour la pause d'un dossier dans le registry. */
function updateDossierBreak(jobId: string, breakStart: number, breakEnd: number): void {
  const slot = dossierRegistry.get(jobId);
  if (slot) {
    slot.breakStart = breakStart;
    slot.breakEnd = breakEnd;
    slot.lastUpdate = Date.now();
  }
}

/** Supprime un dossier du registry (fin de session). */
export function unregisterDossierRefresh(jobId: string): void {
  dossierRegistry.delete(jobId);
}

/**
 * Calcule la pause optimale pour un dossier en tenant compte des autres dossiers du même tier.
 * Objectif : quand un dossier est en pause, un autre du même tier est en refresh → zéro gap.
 */
function getCoordinatedBreakDuration(
  jobId: string,
  tier: string,
  defaultBreakMs: number,
): number {
  // Trouver les autres dossiers du même tier qui sont actifs
  const sameTierDossiers: DossierRefreshSlot[] = [];
  const now = Date.now();
  const staleThreshold = 10 * 60 * 1000; // 10 min sans update = considéré mort

  for (const [id, slot] of dossierRegistry) {
    if (id === jobId) continue;
    if (slot.tier !== tier) continue;
    if (now - slot.lastUpdate > staleThreshold) continue; // Stale entry
    sameTierDossiers.push(slot);
  }

  if (sameTierDossiers.length === 0) {
    // Aucun autre dossier du même tier → pause normale
    return defaultBreakMs;
  }

  // Vérifier si un autre dossier est actuellement en refresh (couvre la période)
  const otherIsRefreshing = sameTierDossiers.some(d => {
    return now >= d.windowStart && now <= d.windowEnd;
  });

  if (otherIsRefreshing) {
    // Un autre dossier couvre → on peut prendre une pause plus longue (save requests)
    return defaultBreakMs * 1.3;
  }

  // Aucun autre ne couvre → raccourcir notre pause pour minimiser le gap
  const otherNextWindowStart = sameTierDossiers
    .filter(d => d.breakEnd !== null && d.breakEnd > now)
    .map(d => d.breakEnd!)
    .sort((a, b) => a - b)[0];

  if (otherNextWindowStart) {
    // Un autre dossier va reprendre bientôt → on peut étendre un peu notre pause
    const timeUntilOtherResumes = otherNextWindowStart - now;
    if (timeUntilOtherResumes < defaultBreakMs) {
      // L'autre reprend avant la fin de notre pause → pause raccourcie OK
      return Math.max(30000, timeUntilOtherResumes * 0.8);
    }
  }

  // Par défaut : raccourcir la pause de 40% pour maximiser la couverture
  return Math.max(30000, defaultBreakMs * 0.6);
}

// ─── Server Health Tracking ─────────────────────────────────────────────────

interface ServerHealthState {
  /** Latences des N dernières requêtes (ms). */
  latencies: number[];
  /** Nombre d'erreurs récentes. */
  recentErrors: number;
  /** Timestamp de la dernière erreur. */
  lastErrorAt: number;
  /** Score de santé (0-1). */
  healthScore: number;
}

const serverHealth: ServerHealthState = {
  latencies: [],
  recentErrors: 0,
  lastErrorAt: 0,
  healthScore: 1.0,
};

/** Met à jour la santé serveur après une requête. */
function updateServerHealth(latencyMs: number, isError: boolean): void {
  // Garder les 20 dernières latences
  serverHealth.latencies.push(latencyMs);
  if (serverHealth.latencies.length > 20) {
    serverHealth.latencies.shift();
  }

  if (isError) {
    serverHealth.recentErrors++;
    serverHealth.lastErrorAt = Date.now();
  } else {
    // Décroître les erreurs avec le temps
    if (Date.now() - serverHealth.lastErrorAt > 60000) {
      serverHealth.recentErrors = Math.max(0, serverHealth.recentErrors - 1);
    }
  }

  // Calculer le score de santé
  const avgLatency = serverHealth.latencies.reduce((a, b) => a + b, 0) / serverHealth.latencies.length;
  const latencyScore = avgLatency < SERVER_DEGRADED_LATENCY_MS ? 1.0
    : avgLatency < SERVER_STRESSED_LATENCY_MS ? 0.6
    : 0.3;

  const errorScore = Math.max(0, 1.0 - serverHealth.recentErrors * 0.2);
  serverHealth.healthScore = latencyScore * 0.6 + errorScore * 0.4;
}

/**
 * Retourne un multiplicateur de santé serveur pour l'intervalle de refresh.
 * Serveur sain → 1.0, dégradé → 1.5, stressé → 2.5
 */
function getServerHealthMultiplier(): number {
  if (serverHealth.healthScore >= 0.8) return 1.0;
  if (serverHealth.healthScore >= 0.5) return 1.5;
  if (serverHealth.healthScore >= 0.3) return 2.0;
  return 2.5;
}



// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContinuousRefreshResult {
  /** Résultat : slot trouvé ou pas. */
  slotDetected: boolean;
  /** Nombre total de refreshes effectués. */
  totalRefreshes: number;
  /** Nombre de fenêtres complétées. */
  windowsCompleted: number;
  /** Durée totale du refresh continu (ms). */
  totalDurationMs: number;
  /** Raison de l'arrêt. */
  stopReason: "slot_found" | "budget_exhausted" | "token_expiring" | "proxy_dead" | "error" | "max_refreshes" | "max_windows";
  /** Données du premier mois disponible si slot détecté. */
  firstAvailableMonth?: string;
}

export interface ContinuousRefreshConfig {
  /** Session USA active. */
  session: UsaSession;
  /** Job hunter associé. */
  job: HunterJob;
  /** OFC(s) à surveiller. */
  ofcs: UsaOfc[];
  /** Détails de l'application. */
  appDetails: UsaAppDetails;
  /** Referer pour les requêtes. */
  referer: string;
  /** Username pour le cache token. */
  username: string;
  /** Mode reschedule ? */
  rescheduleYN?: boolean;
  /** Date minimum admin. */
  dateFrom?: string;
  /** Date limite admin. */
  dateDeadline?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Génère un intervalle gaussien entre min et max (centré au milieu). */
function gaussianInterval(min: number, max: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const center = (min + max) / 2;
  const stddev = (max - min) * 0.25;
  const raw = center + z * stddev;
  return Math.max(min, Math.min(raw, max));
}

/** Vérifie si le token approche de l'expiration. */
function isTokenApproachingExpiry(username: string): boolean {
  const cached = tokenCache.get(username.toLowerCase());
  if (!cached) return true;
  const timeToExpiry = cached.expiresAt - Date.now();
  return timeToExpiry < SCAN_CUTOFF_BEFORE_EXPIRY_MS;
}

/**
 * Smart Refresh Interval (#5) — Calcule l'intervalle adaptatif.
 * Combine : prédiction Early Bird + santé serveur + intelligence compétitive.
 * Résultat final clamped entre 20s et 180s.
 */
function computeSmartInterval(username: string): number {
  // Base interval
  let interval = SMART_REFRESH_BASE_MS;

  // Multiplicateur Early Bird (fenêtre chaude/froide)
  const predictionMultiplier = getRefreshMultiplier(username);
  interval *= predictionMultiplier;

  // Multiplicateur santé serveur
  const healthMultiplier = getServerHealthMultiplier();
  interval *= healthMultiplier;

  // Multiplicateur concurrence (si données disponibles)
  const competitionMultiplier = getCompetitionRefreshMultiplier();
  interval *= competitionMultiplier;

  // Clamp entre les limites absolues
  interval = Math.max(SMART_REFRESH_MIN_MS, Math.min(interval, SMART_REFRESH_MAX_MS));

  // Ajouter une variance gaussienne (±15%) pour éviter les patterns
  const variance = 1.0 + (Math.random() - 0.5) * 0.3;
  interval *= variance;

  return Math.max(SMART_REFRESH_MIN_MS, Math.min(Math.round(interval), SMART_REFRESH_MAX_MS));
}



// ─── Fonction principale ────────────────────────────────────────────────────

/**
 * Exécute le refresh continu après un scan initial sans résultat.
 * v2 : intervalles adaptatifs, alternance endpoints, coordination dossiers.
 */
export async function runContinuousRefresh(config: ContinuousRefreshConfig): Promise<ContinuousRefreshResult> {
  const { session, job, ofcs, appDetails, referer, username, rescheduleYN, dateFrom, dateDeadline } = config;
  const startTime = Date.now();
  let totalRefreshes = 0;
  let windowsCompleted = 0;
  let landingPageCount = 0;
  let firstAvailableMonthCount = 0;

  // Prediction state pour le logging
  const predState = getCurrentPredictionScore(username);

  console.log(
    `[refresh] 🔄 Démarrage refresh continu v2 — budget ${Math.round(TOTAL_REFRESH_BUDGET_MS / 60000)} min, ` +
    `max ${MAX_WINDOWS} fenêtres | prediction=${predState.window} (×${predState.multiplier.toFixed(2)}) | ` +
    `server_health=${serverHealth.healthScore.toFixed(2)}`,
  );

  botLog({
    applicationId: job.id,
    step: "continuous_refresh_start",
    status: "ok",
    data: {
      version: "v2",
      budgetMin: Math.round(TOTAL_REFRESH_BUDGET_MS / 60000),
      maxWindows: MAX_WINDOWS,
      ofcCount: ofcs.length,
      offices: ofcs.map(o => o.postName),
      predictionWindow: predState.window,
      predictionMultiplier: predState.multiplier,
      serverHealth: serverHealth.healthScore,
      tier: job.urgencyTier,
    },
  });

  // Enregistrer ce dossier dans le registry de coordination (#7)
  const tier = job.urgencyTier ?? "standard";

  // Boucle des fenêtres de refresh
  for (let windowIdx = 0; windowIdx < MAX_WINDOWS; windowIdx++) {
    // ── Vérifications de sécurité avant chaque fenêtre ──
    const elapsed = Date.now() - startTime;
    if (elapsed >= TOTAL_REFRESH_BUDGET_MS) {
      console.log(`[refresh] ⏱ Budget temps épuisé (${Math.round(elapsed / 60000)} min) — arrêt`);
      unregisterDossierRefresh(job.id);
      return makeResult("budget_exhausted", totalRefreshes, windowsCompleted, elapsed);
    }
    if (isTokenApproachingExpiry(username)) {
      console.log(`[refresh] ⏰ Token approche expiration — arrêt refresh`);
      unregisterDossierRefresh(job.id);
      return makeResult("token_expiring", totalRefreshes, windowsCompleted, elapsed);
    }
    if (totalRefreshes >= MAX_TOTAL_REFRESHES) {
      console.log(`[refresh] 🛑 Max refreshes atteint (${totalRefreshes}) — arrêt`);
      unregisterDossierRefresh(job.id);
      return makeResult("max_refreshes", totalRefreshes, windowsCompleted, elapsed);
    }

    // ── Durée de cette fenêtre (variable) ──
    const windowDuration = gaussianInterval(REFRESH_WINDOW_MIN_MS, REFRESH_WINDOW_MAX_MS);
    const windowDurationMin = Math.round(windowDuration / 60000 * 10) / 10;

    // Enregistrer la fenêtre dans le registry (#7)
    registerDossierRefresh(job.id, username, tier, Date.now(), windowDuration);

    console.log(
      `[refresh] 📺 Fenêtre #${windowIdx + 1} — durée cible ${windowDurationMin} min | ` +
      `hot=${isHotWindow(username)} | interval_base=${Math.round(computeSmartInterval(username) / 1000)}s`,
    );

    const windowStart = Date.now();
    let windowRefreshes = 0;

    // ── Boucle de refresh dans la fenêtre ──
    while (Date.now() - windowStart < windowDuration) {
      // Vérifications rapides
      if (isTokenApproachingExpiry(username)) {
        unregisterDossierRefresh(job.id);
        return makeResult("token_expiring", totalRefreshes, windowsCompleted, Date.now() - startTime);
      }
      if (isSessionFrozen(username)) {
        unregisterDossierRefresh(job.id);
        return makeResult("proxy_dead", totalRefreshes, windowsCompleted, Date.now() - startTime);
      }

      // ── Stealthy Alternation #6 — Choisir l'endpoint ──
      const useLandingPage = Math.random() < LANDING_PAGE_RATIO;

      // ── Exécuter le refresh ──
      const reqStart = Date.now();
      let refreshResult: LightRefreshResult;

      if (useLandingPage) {
        refreshResult = await doLandingPageRefresh(config);
        landingPageCount++;
      } else {
        refreshResult = await doFirstAvailableMonthRefresh(config);
        firstAvailableMonthCount++;
      }

      const reqLatency = Date.now() - reqStart;
      updateServerHealth(reqLatency, refreshResult.error ?? false);

      totalRefreshes++;
      windowRefreshes++;

      // Mettre à jour l'activité de session
      updateSessionActivity(username);

      if (refreshResult.slotDetected) {
        const totalElapsed = Date.now() - startTime;
        console.log(
          `[refresh] 🚨 SLOT DÉTECTÉ au refresh #${totalRefreshes} (fenêtre #${windowIdx + 1}, ` +
          `${Math.round(totalElapsed / 1000)}s) | endpoint=${useLandingPage ? "landing" : "firstAvail"}`,
        );

        // Log competitive intelligence
        logCompetitionIntelligence(job.id);

        botLog({
          applicationId: job.id,
          step: "continuous_refresh_slot_detected",
          status: "ok",
          data: {
            refreshNumber: totalRefreshes,
            windowNumber: windowIdx + 1,
            windowRefreshes,
            totalElapsedSec: Math.round(totalElapsed / 1000),
            firstAvailableMonth: refreshResult.firstAvailableMonth,
            ofc: refreshResult.ofcName,
            endpoint: useLandingPage ? "getLandingPage" : "getFirstAvailableMonth",
            smartIntervalMs: computeSmartInterval(username),
            landingPageCount,
            firstAvailableMonthCount,
          },
        });

        unregisterDossierRefresh(job.id);
        return {
          slotDetected: true,
          totalRefreshes,
          windowsCompleted: windowIdx,
          totalDurationMs: totalElapsed,
          stopReason: "slot_found",
          firstAvailableMonth: refreshResult.firstAvailableMonth,
        };
      }

      if (refreshResult.error) {
        unregisterDossierRefresh(job.id);
        return makeResult("error", totalRefreshes, windowsCompleted, Date.now() - startTime);
      }

      // ── Smart Refresh Interval #5 — Pause adaptative ──
      const smartInterval = computeSmartInterval(username);
      const jitter = (Math.random() - 0.5) * 4000; // ±2s de jitter humain
      const finalInterval = Math.max(5000, smartInterval + jitter);

      // Log discret (pas à chaque refresh)
      if (windowRefreshes % 3 === 0 || windowRefreshes === 1) {
        const predNow = getCurrentPredictionScore(username);
        console.log(
          `[refresh] 🔄 #${totalRefreshes} (W${windowIdx + 1}) — ${useLandingPage ? "landing" : "firstAvail"} ` +
          `| next=${Math.round(finalInterval / 1000)}s | pred=${predNow.window} | health=${serverHealth.healthScore.toFixed(2)} ` +
          `| latency=${reqLatency}ms`,
        );
      }

      await new Promise(r => setTimeout(r, finalInterval));

      // Vérification budget global
      if (Date.now() - startTime >= TOTAL_REFRESH_BUDGET_MS) break;
      if (totalRefreshes >= MAX_TOTAL_REFRESHES) break;
    }

    // Fenêtre complétée
    windowsCompleted++;
    const windowElapsed = Math.round((Date.now() - windowStart) / 1000);
    console.log(
      `[refresh] ✅ Fenêtre #${windowIdx + 1} terminée — ${windowRefreshes} refreshes en ${windowElapsed}s ` +
      `(landing=${landingPageCount}, firstAvail=${firstAvailableMonthCount})`,
    );
    botLog({
      applicationId: job.id,
      step: "continuous_refresh_window_done",
      status: "ok",
      data: {
        windowNumber: windowIdx + 1,
        windowRefreshes,
        windowDurationSec: windowElapsed,
        totalRefreshes,
        totalElapsedMin: Math.round((Date.now() - startTime) / 60000),
        landingPageCount,
        firstAvailableMonthCount,
        serverHealth: serverHealth.healthScore,
      },
    });

    // ── Pause entre les fenêtres — coordonnée avec les autres dossiers (#7) ──
    if (windowIdx < MAX_WINDOWS - 1) {
      const rawBreakDuration = gaussianInterval(BREAK_MIN_MS, BREAK_MAX_MS);
      const coordBreakDuration = getCoordinatedBreakDuration(job.id, tier, rawBreakDuration);
      const breakSec = Math.round(coordBreakDuration / 1000);

      // Mettre à jour le registry avec la pause
      updateDossierBreak(job.id, Date.now(), Date.now() + coordBreakDuration);

      console.log(
        `[refresh] ☕ Pause inter-fenêtre: ${breakSec}s ` +
        `(raw=${Math.round(rawBreakDuration / 1000)}s, coordinated=${Math.round(coordBreakDuration / 1000)}s)`,
      );

      // Pendant la pause, vérifier périodiquement le proxy
      const breakStart = Date.now();
      while (Date.now() - breakStart < coordBreakDuration) {
        const chunk = Math.min(30000, coordBreakDuration - (Date.now() - breakStart));
        await new Promise(r => setTimeout(r, chunk));
        if (isSessionFrozen(username)) {
          unregisterDossierRefresh(job.id);
          return makeResult("proxy_dead", totalRefreshes, windowsCompleted, Date.now() - startTime);
        }
      }
    }
  }

  // Toutes les fenêtres épuisées
  const totalElapsed = Date.now() - startTime;
  console.log(
    `[refresh] 🏁 Refresh continu v2 terminé — ${totalRefreshes} refreshes en ${Math.round(totalElapsed / 60000)} min, ` +
    `${windowsCompleted} fenêtres (landing=${landingPageCount}, firstAvail=${firstAvailableMonthCount})`,
  );
  botLog({
    applicationId: job.id,
    step: "continuous_refresh_end",
    status: "ok",
    data: {
      version: "v2",
      totalRefreshes,
      windowsCompleted,
      totalDurationMin: Math.round(totalElapsed / 60000),
      stopReason: "max_windows",
      landingPageCount,
      firstAvailableMonthCount,
      finalServerHealth: serverHealth.healthScore,
    },
  });

  unregisterDossierRefresh(job.id);
  return makeResult("max_windows", totalRefreshes, windowsCompleted, totalElapsed);
}



// ─── Refresh endpoints ──────────────────────────────────────────────────────

interface LightRefreshResult {
  slotDetected: boolean;
  firstAvailableMonth?: string;
  ofcName?: string;
  error?: boolean;
}

/**
 * Stealthy Alternation #6 — Endpoint 1/3 : getLandingPageDeatils.
 * Requête GET légère sans payload. Simule un humain qui navigue sur le dashboard.
 * Ne détecte pas directement les slots mais maintient la session + pattern varié.
 * NOTE : Peut quand même détecter un slot si la réponse contient des infos de RDV.
 */
async function doLandingPageRefresh(config: ContinuousRefreshConfig): Promise<LightRefreshResult> {
  const { session, referer } = config;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${session.accessToken}`,
    "Accept": "application/json, text/plain, */*",
    "Referer": referer,
    "LanguageId": "1", // L'intercepteur Angular l'envoie pour getLandingPageDeatils
  };

  try {
    const res = await usaFetch(USA_LANDING_PAGE_URL, {
      method: "GET",
      headers,
    });

    if (res.status === 429) {
      throw new RateLimitError("getLandingPage/refresh", 60000);
    }
    if (res.status === 403) {
      throw new AccountBlockedError("getLandingPage/refresh");
    }
    if (res.status === 401) {
      const body = await res.text().catch(() => "");
      if (isRestrictedBody(body)) {
        throw new AccountRestrictedError();
      }
      throw new TokenExpiredError();
    }

    // getLandingPage ne retourne pas directement de slot info exploitable
    // mais contribue au pattern d'alternance et au keep-alive de session
    return { slotDetected: false };
  } catch (err) {
    if (
      err instanceof RateLimitError ||
      err instanceof AccountBlockedError ||
      err instanceof TokenExpiredError ||
      err instanceof AccountRestrictedError
    ) {
      console.error(`[refresh] ⛔ Erreur critique (landing): ${err.constructor.name}`);
      return { slotDetected: false, error: true };
    }
    // Erreur réseau → non fatal
    console.warn(`[refresh] ⚠️ Erreur landing page refresh: ${err}`);
    return { slotDetected: false };
  }
}

/**
 * Stealthy Alternation #6 — Endpoint 2/3 : getFirstAvailableMonth.
 * Le vrai check de disponibilité — POST avec payload OFC.
 * Détecte les slots disponibles.
 */
async function doFirstAvailableMonthRefresh(config: ContinuousRefreshConfig): Promise<LightRefreshResult> {
  const { session, ofcs, appDetails, referer, rescheduleYN, dateDeadline } = config;

  const hdrs = authHeaders(session.accessToken, referer, true);

  for (const ofc of ofcs) {
    const payload: Record<string, unknown> = {
      postUserId: ofc.postUserId,
      applicantId: appDetails.applicantId,
      visaType: (appDetails as unknown as Record<string, unknown>).visaTypeKey ?? appDetails.visaType,
      visaClass: appDetails.visaClass,
      locationType: rescheduleYN
        ? (appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
        : (ofc.officeType ?? "OFC"),
      applicationId: appDetails.applicationId,
    };

    try {
      const res = await usaFetch(USA_FIRST_AVAILABLE_MONTH_URL, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        throw new RateLimitError("getFirstAvailableMonth/refresh", 60000);
      }
      if (res.status === 403) {
        throw new AccountBlockedError("getFirstAvailableMonth/refresh");
      }
      if (res.status === 401) {
        const body = await res.text().catch(() => "");
        if (isRestrictedBody(body)) {
          throw new AccountRestrictedError();
        }
        throw new TokenExpiredError();
      }

      if (!res.ok) continue;

      const data = await res.json() as { present?: boolean; date?: string };

      if (data.present && data.date) {
        // Enregistrer l'apparition du slot (competitive intelligence #9)
        recordSlotAppearance(ofc.postName, data.date);

        // Vérifier la fenêtre autorisée
        if (dateDeadline && data.date > dateDeadline) continue;

        return {
          slotDetected: true,
          firstAvailableMonth: data.date,
          ofcName: ofc.postName,
        };
      } else {
        // Pas de slot → enregistrer la disparition (competitive intelligence #9)
        recordAllSlotsGone(ofc.postName);
      }
    } catch (err) {
      if (
        err instanceof RateLimitError ||
        err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError ||
        err instanceof AccountRestrictedError
      ) {
        console.error(`[refresh] ⛔ Erreur critique pendant refresh: ${err.constructor.name}`);
        return { slotDetected: false, error: true };
      }
      console.warn(`[refresh] ⚠️ Erreur refresh OFC ${ofc.postName}: ${err}`);
    }
  }

  return { slotDetected: false };
}

// ─── Helper résultat ────────────────────────────────────────────────────────

function makeResult(
  stopReason: ContinuousRefreshResult["stopReason"],
  totalRefreshes: number,
  windowsCompleted: number,
  totalDurationMs: number,
): ContinuousRefreshResult {
  return { slotDetected: false, totalRefreshes, windowsCompleted, totalDurationMs, stopReason };
}
