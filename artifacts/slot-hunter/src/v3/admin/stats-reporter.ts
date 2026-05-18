/**
 * Stats Reporter V3 — Rapporte le budget_status toutes les 10 min vers Convex.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Émettre périodiquement un log "budget_status" avec l'état global :
 *     - Logins utilisés/restants
 *     - Score prédiction heatmap
 *     - Niveau compétition
 *     - Phase actuelle
 *
 * USAGE :
 *   const reporter = startStatsReporter(jobId, username);
 *   // ... scan en cours ...
 *   reporter.stop();
 *   reporter.reportNow(); // Force un report immédiat
 */

import { getBudgetSnapshot, isRushHour } from "../core/session-pool.js";
import { getCurrentPredictionScore, getCompetitionMedianMs, getSlotPattern } from "../intelligence/prediction-engine.js";
import { getCurrentPhaseLabel } from "../scan/scan-orchestrator.js";
import { logBudgetStatus } from "./bot-log.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Handle pour contrôler le reporter. */
export interface StatsReporterHandle {
  /** Arrête le reporting périodique. */
  stop(): void;
  /** Force un report immédiat. */
  reportNow(): void;
  /** Le reporter est-il actif ? */
  readonly isRunning: boolean;
  /** Nombre de reports envoyés. */
  readonly reportCount: number;
}

/** Configuration du reporter. */
export interface StatsReporterConfig {
  /** Intervalle entre les reports (ms). Défaut: 10 min. */
  intervalMs?: number;
  /** Report immédiat au démarrage ? Défaut: true. */
  reportOnStart?: boolean;
}

// ─── Constantes ─────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 10 * 60_000; // 10 min

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Calcule le temps (en minutes) avant la prochaine rush window. */
function minutesUntilNextRush(): number {
  if (isRushHour()) return 0;

  // Estimation simple : la prochaine rush est dans ~30 min max en moyenne
  // (on ne peut pas calculer exactement sans importer les rush windows)
  const now = new Date();
  const hour = (now.getUTCHours() + 1) % 24; // Kinshasa UTC+1

  // Rush windows : 07-09:30, 12-14, 14-17 (Ven)
  if (hour < 7) return (7 - hour) * 60;
  if (hour >= 9.5 && hour < 12) return (12 - hour) * 60;
  if (hour >= 14 && hour < 22) return (24 - hour + 7) * 60; // Demain matin
  if (hour >= 22) return (24 - hour + 7) * 60;
  return 60; // Fallback ~1h
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Démarre le reporting périodique des stats vers Convex (botLog budget_status).
 *
 * @param jobId - Job Convex ID (applicationId)
 * @param username - Username du compte (pour lire le budget)
 * @param config - Configuration optionnelle
 */
export function startStatsReporter(
  jobId: string,
  username: string,
  config?: StatsReporterConfig,
): StatsReporterHandle {
  const intervalMs = config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const reportOnStart = config?.reportOnStart ?? true;

  let running = true;
  let reportCount = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function doReport(): void {
    if (!running) return;

    try {
      const budget = getBudgetSnapshot(username);
      const predScore = getCurrentPredictionScore(username);
      const competitionMs = getCompetitionMedianMs(username);
      const pattern = getSlotPattern(username);
      const phase = getCurrentPhaseLabel();
      const nextRushMin = minutesUntilNextRush();

      logBudgetStatus(jobId, {
        used: budget.totalUsed,
        remaining: budget.remaining,
        nextRushIn: Math.round(nextRushMin),
        prediction: {
          window: phase,
          score: Math.round(predScore * 100) / 100,
        },
        competition: {
          level: pattern.competitionLevel,
          medianSec: pattern.medianLifespanSec,
        },
      });

      reportCount++;
    } catch (err) {
      console.warn(`[stats-reporter] Erreur report: ${err}`);
    }
  }

  // Report initial
  if (reportOnStart) {
    doReport();
  }

  // Intervalle périodique
  intervalId = setInterval(doReport, intervalMs);
  console.log(`[stats-reporter] 📊 Démarré — report toutes les ${Math.round(intervalMs / 60_000)} min`);

  return {
    stop() {
      running = false;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      console.log(`[stats-reporter] 🔴 Arrêté (${reportCount} reports envoyés)`);
    },

    reportNow() {
      doReport();
    },

    get isRunning() { return running; },
    get reportCount() { return reportCount; },
  };
}
