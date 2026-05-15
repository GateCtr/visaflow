/**
 * Orchestration du scan de créneaux USA (API directe) + rapport Convex.
 * Logique métier détaillée : usa-scan-main (scan), preflight, confirmation (réexport).
 */
import type { SessionResult, UsaSession } from "./types.js";
import type { HunterJob } from "../convexClient.js";
import { sendHeartbeat } from "../convexClient.js";
import {
  humanPause,
  shouldSimulateNetworkError,
  simulateNetworkTimeout,
  simulatePageRefresh,
} from "../humanBehavior.js";
import { WARMUP_INTERVAL_MS } from "./config.js";
import { updateSessionActivity } from "./usa-http.js";
import {
  randomInterStepPause,
  selectRandomFlow,
  executeWithHumanVariability,
  shouldDoWarmup,
  warmupLastCalledAt,
} from "./anti-detection.js";
import { callLandingPage, callSanityCheck } from "./usa-scan-preflight.js";
import { downloadUsaConfirmationPdf } from "./usa-scan-confirmation.js";
import { runUsaSlotScanMain } from "./usa-scan-main.js";

export { downloadUsaConfirmationPdf };

/**
 * Scan direct des créneaux USA via API — sans Playwright.
 * Utilise les endpoints découverts dans le bundle Angular du portail :
 *  - getFirstAvailableMonth → getSlotDates → getSlotTime
 * Remplace scanUsaSlotsWithBrowser (fragile, lent, consomme Chromium).
 */
export async function scanUsaSlotsViaAPI(job: HunterJob, session: UsaSession): Promise<SessionResult> {
  try {
    if (!session.applicationId) {
      console.error("[usa] applicationId manquant dans la session — impossible de scanner");
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "applicationId manquant" });
      return "error";
    }

  // ── Mise à jour activité session — chaque appel à scanUsaSlotsViaAPI maintient la session vivante ──
  const scanUsername = job.hunterConfig.embassyUsername;
  if (scanUsername) {
    updateSessionActivity(scanUsername);
  }

  // ── Sélection du flow aléatoire pour variabilité anti-détection ───────────
  const selectedFlow = selectRandomFlow();
  console.log(`[anti-detection] 🧠 Flow sélectionné pour cette session: ${selectedFlow.join(" → ")}`);
  
  // Pause initiale aléatoire
  await randomInterStepPause(300, 1500, job.id);

  // ── Anti-détection : warm-up throttlé (max 1×/8 min) ────────────────────────
  // Le portail appelle ces 3 endpoints à chaque ouverture de la page de booking.
  // Throttle à WARMUP_INTERVAL_MS pour éviter le flood : en tres_urgent (3-5 min),
  // sans throttle = 36-60 appels warm-up/heure supplémentaires → restriction account.
  const doWarmup = shouldDoWarmup(session.applicationId);
  if (doWarmup) {
    warmupLastCalledAt.set(session.applicationId, Date.now());
    console.log("[human] 🔥 Warm-up avec variabilité humaine...");

    // Simuler occasionnellement une erreur réseau (2% du temps)
    if (shouldSimulateNetworkError()) {
      console.log("[human] ⚡ Simulation d'erreur réseau pendant warm-up");
      await simulateNetworkTimeout(1500 + Math.random() * 2000);
    }

    // Exécuter le warm-up avec variabilité humaine
    await executeWithHumanVariability([
      {
        name: "Landing Page",
        execute: async () => await callLandingPage(session),
        critical: true
      },
      {
        name: "Sanity Check", 
        execute: async () => await callSanityCheck(session),
        critical: true
      },
      // NOTE: checkFcsPayment retiré du warm-up (mai 2026).
      // Le portail Angular actuel ne l'appelle plus dans le flux de booking
      // (absent des captures réseau 12-13/05/2026). L'endpoint retourne 401
      // systématiquement — probablement migré ou supprimé côté serveur.
      // Le paiement est déjà vérifié via getUserHistoryApplicantPaymentStatus
      // (pendingAppoStatus !== 0 ↔ paiement confirmé).
      {
        name: "Page Refresh",
        execute: async () => await simulatePageRefresh(job.id),
        critical: false
      }
    ], "warm-up ", job.id);

  } else {
    const lastWarmup = warmupLastCalledAt.get(session.applicationId) ?? 0;
    const nextIn = Math.round((WARMUP_INTERVAL_MS - (Date.now() - lastWarmup)) / 60000);
    console.log(`[usa] Warm-up ignoré (prochain dans ~${nextIn} min) — économie 3 appels API`);
    
    // Même sans warm-up, ajouter un peu de variabilité
    if (Math.random() < 0.4) {
      await humanPause(500, "démarrage ", job.id);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  return await runUsaSlotScanMain(job, session, selectedFlow);
  } catch (error) {
    // Check if this is the FCS payment check failed error
    if (error instanceof Error && error.message === "FCS payment check failed") {
      console.warn("[usa] FCS payment check failed — paiement non confirmé");
      return "payment_required";
    }
    
    console.error(`[usa] Erreur inattendue dans scanUsaSlotsViaAPI:`, error);
    await sendHeartbeat({ 
      applicationId: job.id, 
      result: "error", 
      errorMessage: `Erreur inattendue: ${error instanceof Error ? error.message : String(error)}` 
    });
    return "error";
  }
}
