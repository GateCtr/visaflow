/**
 * Scan Session V3 — Orchestre 1 cycle complet de scan.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Gérer le lifecycle complet d'une session de scan :
 *     1. Vérifier le budget login (canLogin)
 *     2. Résoudre un proxy (resolveProxy)
 *     3. Login (via getUsaSession existant)
 *     4. Preflight (scan-preflight.ts)
 *     5. Scan slots (scan-slots.ts)
 *     6. Booking direct si slot trouvé (booking-direct.ts)
 *     7. Retry si 409 (booking-retry.ts)
 *     8. Discovery enrichment + broadcast blind
 *     9. Keep-alive management
 *    10. Stats reporting
 *
 * NE FAIT PAS :
 *   - Le scheduling (quand lancer la session) → scan-orchestrator.ts
 *   - La boucle infinie (continuous refresh) → appelant externe
 *   - Le login HTTP direct → usa-auth.ts existant
 *
 * INTÉGRATION :
 *   Appelé par le scheduler principal (continuous-refresh ou le nouveau V3 loop).
 *   Retourne un SessionOutcome pour que l'appelant décide du next step.
 */

import type { UsaSession } from "../../usaPortal/types.js";
import type { HunterConfigV3, AccountRole } from "../core/types.js";
import { canLogin, recordLogin } from "../core/session-pool.js";
import { resolveProxy, type ProxyCascadeConfig } from "../core/proxy-cascade.js";
import { extractBudgetFromConfig, resolveAccountRole } from "../admin/config-schema.js";
import { runPreflight, type PreflightResult, PreflightError } from "./scan-preflight.js";
import { scanAllOfcs, type ScanSlotsResult } from "./scan-slots.js";
import { bookSlotDirect, type BookingOutcome } from "../booking/booking-direct.js";
import { createRetryTracker, isRetryableError } from "../booking/booking-retry.js";
import { startKeepAlive, type KeepAliveHandle } from "../anti-detection/keep-alive.js";
import { startStatsReporter, type StatsReporterHandle } from "../admin/stats-reporter.js";
import { createDiscoveryCollector } from "../intelligence/discovery-enrichment.js";
import { recordSlotDetected } from "../intelligence/prediction-engine.js";
import {
  logSessionStart, logSessionExpire, logSlotDetected,
  logBookingResult, logDiscoveryBatch, logCriticalError,
} from "../admin/bot-log.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Résultat d'une session de scan. */
export type SessionOutcome =
  | "slot_captured"      // Booking réussi — dossier terminé
  | "no_slot"            // Scan terminé sans slot (normal)
  | "budget_exhausted"   // Plus de logins disponibles
  | "token_expired"      // Token expiré naturellement (60 min)
  | "restricted"         // Compte restreint par le portail
  | "proxy_down"         // Tous les proxies sont down
  | "payment_required"   // Paiement MRV non vérifié
  | "error";             // Erreur inattendue

/** Configuration pour une session de scan. */
export interface ScanSessionConfig {
  /** Job ID Convex (applicationId). */
  jobId: string;
  /** Configuration V3 du hunter. */
  hunterConfig: Partial<HunterConfigV3>;
  /** Session USA (peut être pré-existante si token encore valide). */
  existingSession?: UsaSession;
  /** Fonction pour obtenir une session (login). L'appelant fournit sa propre logique. */
  getSession: (proxyUrl: string | null) => Promise<UsaSession | null>;
  /** Convex URL + API key (pour blind booking + discovery). */
  convexSiteUrl: string;
  hunterApiKey: string;
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Exécute un cycle complet de scan (1 session = 1 token = max 60 min).
 *
 * Retourne le SessionOutcome pour que le scheduler décide quoi faire ensuite.
 */
export async function runScanSession(config: ScanSessionConfig): Promise<SessionOutcome> {
  const { jobId, hunterConfig, convexSiteUrl, hunterApiKey } = config;
  const username = hunterConfig.embassyUsername ?? "unknown";
  const applicationId = hunterConfig.portalApplicationId ?? "";

  // ── Déterminer le rôle et le budget ──
  const role: AccountRole = resolveAccountRole(hunterConfig);
  const budget = extractBudgetFromConfig(hunterConfig);

  // Les confinés ne scannent JAMAIS
  if (role === "confine") {
    console.log(`[scan-session] ⏸ Compte confiné — pas de scan (attend blind booking)`);
    return "no_slot";
  }

  let keepAlive: KeepAliveHandle | null = null;
  let statsReporter: StatsReporterHandle | null = null;
  let session: UsaSession | null = config.existingSession ?? null;

  try {
    // ── 1. Vérifier le budget login (si pas de session existante) ──
    if (!session) {
      const decision = canLogin(username, budget);
      if (!decision.allowed) {
        console.log(`[scan-session] 🚫 Budget épuisé: ${decision.reason}`);
        logCriticalError(jobId, {
          type: "budget_exhausted",
          username,
          details: decision.reason ?? "Budget login épuisé",
          recoveryAction: `Attente ${Math.round(decision.waitMs / 60_000)} min`,
        });
        return "budget_exhausted";
      }

      // ── 2. Résoudre un proxy ──
      const proxyConfig: ProxyCascadeConfig = {
        username,
        jobId,
        priority: hunterConfig.preferredProxy
          ? [hunterConfig.preferredProxy]
          : undefined,
      };
      const proxy = await resolveProxy(proxyConfig);
      if (!proxy) {
        logCriticalError(jobId, {
          type: "all_proxy_down",
          username,
          details: "Tous les proxies sont down",
          recoveryAction: "Retry dans 5 min",
        });
        return "proxy_down";
      }

      // ── 3. Login ──
      session = await config.getSession(proxy.url);
      if (!session) {
        return "error";
      }

      // Enregistrer le login
      recordLogin(username, decision.phase);
      logSessionStart(jobId, {
        username,
        loginNumber: budget.maxPerDay - decision.remaining,
        budgetRemaining: decision.remaining,
        proxy: proxy.provider,
        ip: proxy.exitIp ?? "unknown",
      });
    }

    // ── 4. Démarrer keep-alive + stats reporter ──
    keepAlive = startKeepAlive(session, jobId, {
      onTokenExpired: () => {
        console.log(`[scan-session] 🔒 Token expiré détecté par keep-alive`);
      },
    });
    statsReporter = startStatsReporter(jobId, username);

    // ── 5. Preflight ──
    let preflight: PreflightResult;
    try {
      preflight = await runPreflight(session, applicationId, session.missionId);
    } catch (err) {
      if (err instanceof PreflightError) {
        console.error(`[scan-session] Preflight échoué (${err.stage}): ${err.message}`);
        return "error";
      }
      throw err; // Circuit-breaker → propagé
    }

    // Vérifier paiement MRV
    if (!preflight.paymentVerified) {
      console.warn(`[scan-session] 💳 Paiement MRV non vérifié — scan bloqué`);
      return "payment_required";
    }

    // ── 6. Scan slots (avec retry) ──
    const retryTracker = createRetryTracker();

    while (retryTracker.shouldRetry()) {
      const scanResult: ScanSlotsResult = await scanAllOfcs({
        session,
        appDetails: preflight.appDetails,
        ofcList: preflight.ofcList,
        applicationId,
        dateFrom: hunterConfig.slotDateFrom,
        dateDeadline: hunterConfig.slotDateDeadline,
        rescheduleMode: hunterConfig.rescheduleMode,
        maxMonthsToScan: hunterConfig.maxMonthsToScan ?? 3,
        username,
        accountRole: role,
        blindBookingEnabled: hunterConfig.blindBookingEnabled,
        convexSiteUrl,
        hunterApiKey,
      });

      // Reporter discovery
      if (scanResult.discoveryEvents.length > 0) {
        logDiscoveryBatch(jobId, {
          datesFound: scanResult.discoveryEvents.length,
          datesIgnored: scanResult.discoveryEvents.filter(e => e.outcome === "ignored").length,
          datesCaptured: scanResult.discoveryEvents.filter(e => e.outcome === "captured").length,
          reasons: {},
          monthsScanned: scanResult.totalMonthsScanned,
          blindShared: 0,
        });
      }

      // Pas de slot → fin normale
      if (!scanResult.slotFound) {
        return "no_slot";
      }

      // ── 7. Slot trouvé → Booking direct (sauf éclaireur pur) ──
      const slot = scanResult.slotFound;
      recordSlotDetected(username, slot.ofcName, slot.date);
      logSlotDetected(jobId, {
        ofc: slot.ofcName,
        date: slot.date,
        time: slot.time,
        competition: "unknown",
        window: hunterConfig.slotDateFrom && hunterConfig.slotDateDeadline
          ? `${hunterConfig.slotDateFrom} → ${hunterConfig.slotDateDeadline}`
          : "open",
      });

      // Éclaireur pur : scanne + broadcast MAIS ne book PAS pour lui-même
      // Le slot est broadcasté aux confinés via discovery-enrichment (déjà fait dans scanAllOfcs)
      if (role === "eclaireur" && hunterConfig.blindBookingEnabled) {
        console.log(
          `[scan-session] 📡 Éclaireur pur — slot ${slot.date} ${slot.time} broadcasté aux confinés (pas de booking pour soi)`
        );
        return "no_slot"; // Du point de vue de CE compte, pas de booking
      }

      const bookingOutcome: BookingOutcome = await bookSlotDirect({
        slotFound: slot,
        applicationId,
        applicantId: preflight.appDetails.applicantId,
        appointmentId: preflight.appDetails.appointmentId,
        applicantUUID: preflight.appDetails.applicantUUID as number | undefined,
        mode: hunterConfig.rescheduleMode ? "reschedule" : "schedule",
        accessToken: session.accessToken,
        missionId: session.missionId ?? 323,
        targetLocationType: (preflight.ofcList[0]?.officeType ?? "POST") as "OFC" | "POST",
        existingLocationType: hunterConfig.rescheduleMode ? "POST" : undefined,
      });

      logBookingResult(jobId, {
        success: bookingOutcome.success,
        slotId: slot.slotId,
        method: "direct",
        latencyMs: bookingOutcome.totalLatencyMs,
        error: bookingOutcome.error,
      });

      if (bookingOutcome.success) {
        console.log(`[scan-session] 🎉 BOOKING RÉUSSI — ${slot.ofcName} ${slot.date} ${slot.time}`);
        return "slot_captured";
      }

      // 409 → retry
      if (bookingOutcome.slotTaken && isRetryableError(bookingOutcome.statusCode)) {
        retryTracker.recordAttempt();
        await retryTracker.waitBeforeRetry();
        continue; // Re-scan
      }

      // Autre erreur de booking → abandon
      return "error";
    }

    // Max retries atteint
    return "no_slot";

  } catch (err: unknown) {
    // Circuit-breakers
    const errName = err instanceof Error ? err.constructor.name : "";
    if (errName === "TokenExpiredError") {
      logSessionExpire(jobId, { username, sessionDurationMin: 60, scanCount: 0 });
      return "token_expired";
    }
    if (errName === "AccountRestrictedError") {
      logCriticalError(jobId, {
        type: "restriction",
        username,
        details: "Compte restreint par le portail",
        recoveryAction: "Attente backoff exponentiel",
      });
      return "restricted";
    }
    if (errName === "RateLimitError" || errName === "AccountBlockedError") {
      return "restricted";
    }

    console.error(`[scan-session] Erreur inattendue: ${err}`);
    return "error";

  } finally {
    // Cleanup
    keepAlive?.stop();
    statsReporter?.stop();
  }
}
