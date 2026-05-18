/**
 * V3 Entry Point — Initialisation et export de tous les modules V3.
 *
 * RESPONSABILITÉ :
 *   Point d'entrée unique pour le système V3.
 *   Initialise Redis, charge les rush windows depuis Convex,
 *   et exporte les fonctions clés pour l'intégration dans index.ts.
 *
 * INTÉGRATION :
 *   Dans index.ts (main), APRÈS initTokenCacheRedis et initRestrictionRedis :
 *     import { initV3 } from "./v3/index.js";
 *     await initV3();
 *
 *   Le reste du code existant fonctionne inchangé —
 *   les hooks sont dans usa-session.ts (canLogin/recordLogin) et
 *   usa-scan-find.ts (scanMultipleMonths) — déjà intégrés.
 */

import { initSessionPoolRedis, updateRushWindows, updateConfig, onLoginEvent } from "./core/session-pool.js";
import { parseRushWindowsFromBotConfig } from "./admin/config-schema.js";
import { logSessionStart, logCriticalError } from "./admin/bot-log.js";
import type { LoginConsumedEvent, LoginDeniedEvent } from "./core/types.js";

// ─── Initialisation ─────────────────────────────────────────────────────────

/**
 * Initialise le système V3.
 * À appeler au démarrage du bot APRÈS Redis et Convex sont prêts.
 *
 * @param convexSiteUrl - URL du site Convex (pour charger les rush windows)
 * @param hunterApiKey - Clé API Hunter
 */
export async function initV3(convexSiteUrl?: string, hunterApiKey?: string): Promise<void> {
  console.log("[v3] ═══════════════════════════════════════════════════════");
  console.log("[v3] 🚀 Hunter V3 Chasseur — Initialisation...");
  console.log("[v3] ═══════════════════════════════════════════════════════");

  // 1. Restaurer les budgets login depuis Redis
  const restoredBudgets = await initSessionPoolRedis();
  if (restoredBudgets > 0) {
    console.log(`[v3] 🔑 ${restoredBudgets} budget(s) login restauré(s) depuis Redis`);
  }

  // 2. Charger les rush windows depuis Convex (si disponible)
  if (convexSiteUrl && hunterApiKey) {
    try {
      const res = await fetch(`${convexSiteUrl}/hunter/bot-config?key=rush_windows`, {
        headers: { "X-Hunter-Key": hunterApiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as { value: string | null };
        if (data.value) {
          const windows = parseRushWindowsFromBotConfig(data.value);
          if (windows) {
            updateRushWindows(windows);
            console.log(`[v3] ⏰ Rush windows chargées depuis Convex: ${windows.length} fenêtre(s)`);
          }
        }
      }
    } catch {
      console.log("[v3] ⚠️ Rush windows Convex inaccessible — défaut Kinshasa utilisé");
    }

    // 3. Charger scan_intensity et night_mode
    try {
      const res = await fetch(`${convexSiteUrl}/hunter/bot-config?key=scan_intensity`, {
        headers: { "X-Hunter-Key": hunterApiKey },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as { value: string | null };
        if (data.value) {
          console.log(`[v3] ⚙️ scan_intensity depuis Convex: ${data.value}`);
        }
      }
    } catch { /* non-bloquant */ }
  }

  // 4. Enregistrer un listener pour les événements login (logs admin)
  onLoginEvent((event) => {
    if ("remainingToday" in event) {
      // LoginConsumedEvent
      const e = event as LoginConsumedEvent;
      console.log(
        `[v3] 📊 Login consumed: ${e.username.slice(0, 12)}… ` +
        `#${e.totalUsedToday} (phase=${e.phase}, remaining=${e.remainingToday})`
      );
    } else {
      // LoginDeniedEvent
      const e = event as LoginDeniedEvent;
      console.warn(
        `[v3] 🚫 Login denied: ${e.username.slice(0, 12)}… — ${e.reason}`
      );
    }
  });

  console.log("[v3] ✅ Hunter V3 Chasseur initialisé");
  console.log("[v3]    Budget: 9 logins/jour, rush allocation 4+3+2");
  console.log("[v3]    Scan: multi-mois (3), orchestrator chrono");
  console.log("[v3]    Booking: direct + blind cross-account");
  console.log("[v3]    Proxy: cascade 3-way avec budget protection");
  console.log("[v3] ═══════════════════════════════════════════════════════");
}

// ─── Re-exports (pour que l'ancien code puisse importer depuis v3/) ─────────

// Core
export { canLogin, recordLogin, recordProxyDeath, getRemainingLogins, getUsedLogins, getBudgetSnapshot, isRushHour, getAllBudgetSnapshots } from "./core/session-pool.js";
export { resolveProxy, parseProxyPriority } from "./core/proxy-cascade.js";
export type { ProxyResolution, ProxyCascadeConfig } from "./core/proxy-cascade.js";
export type { LoginDecision, LoginPhase, HunterConfigV3, AccountRole, RushWindow } from "./core/types.js";

// Admin
export { extractBudgetFromConfig, resolveAccountRole, validateConfigV3, matchesPriorityDate, parseRushWindowsFromBotConfig } from "./admin/config-schema.js";
export { logSessionStart, logSessionExpire, logProxyDeath, logSlotDetected, logBookingResult, logSlotLost, logBudgetStatus, logDiscoveryBatch, logCriticalError } from "./admin/bot-log.js";

// Scan
export { getNextScanDecision, getCurrentPhaseLabel, isMondayBoostActive } from "./scan/scan-orchestrator.js";
export type { ScanDecision, OrchestratorContext, ScanIntensity, NightMode } from "./scan/scan-orchestrator.js";
export { scanMultipleMonths } from "./scan/scan-months.js";
export type { MultiMonthScanConfig } from "./scan/scan-months.js";

// Booking
export { buildBookingRequest, formatUItime, summarizeBookingPayload } from "./booking/booking-payload.js";
export type { BookingPayloadConfig, BookingRequest } from "./booking/booking-payload.js";
export { broadcastSlotDiscovery, pollBlindBookingEvents, attemptBlindBooking, markEventProcessed } from "./booking/booking-blind.js";
export type { SlotBroadcastEvent, BlindBookingContext, BlindBookingResult } from "./booking/booking-blind.js";

// Intelligence
export { getSlotPattern, getCurrentPredictionScore, getCompetitionMedianMs, recordSlotDetected, recordSlotGone, recordAllSlotsGone, recordBlindBookingResult, injectHistorical } from "./intelligence/prediction-engine.js";
export type { SlotPattern } from "./intelligence/prediction-engine.js";
export { createDiscoveryCollector } from "./intelligence/discovery-enrichment.js";
export type { DiscoveryCollector, DiscoveryCollectorConfig } from "./intelligence/discovery-enrichment.js";

// Anti-detection
export { getFingerprintForToday, setFingerprint, clearFingerprint, buildHeadersFromFingerprint } from "./anti-detection/fingerprint.js";
export type { BrowserFingerprint } from "./anti-detection/fingerprint.js";
export { humanPause, networkJitter, interStepPause, monthNavigationPause, preBookingPause, maybeDistraction, gaussianInterval, sleep } from "./anti-detection/human-timing.js";
export type { PauseType } from "./anti-detection/human-timing.js";
export { pickNextEndpoint, resetAlternation, getAlternationStats } from "./anti-detection/stealth-alternation.js";
export type { ScanEndpoint } from "./anti-detection/stealth-alternation.js";
export { startKeepAlive } from "./anti-detection/keep-alive.js";
export type { KeepAliveHandle, KeepAliveConfig } from "./anti-detection/keep-alive.js";

// Scan (extended)
export { runPreflight, PreflightError } from "./scan/scan-preflight.js";
export type { PreflightResult } from "./scan/scan-preflight.js";
export { scanAllOfcs } from "./scan/scan-slots.js";
export type { ScanSlotsConfig, ScanSlotsResult } from "./scan/scan-slots.js";
export { runScanSession } from "./scan/scan-session.js";
export type { SessionOutcome, ScanSessionConfig } from "./scan/scan-session.js";

// Booking (extended)
export { bookSlotDirect } from "./booking/booking-direct.js";
export type { BookingOutcome, DirectBookingConfig } from "./booking/booking-direct.js";
export { createRetryTracker, isRetryableError } from "./booking/booking-retry.js";
export type { RetryTracker, RetryConfig } from "./booking/booking-retry.js";

// Admin (extended)
export { startStatsReporter } from "./admin/stats-reporter.js";
export type { StatsReporterHandle, StatsReporterConfig } from "./admin/stats-reporter.js";
