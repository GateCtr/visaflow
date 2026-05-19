// ─── Scheduler State — Shared mutable state for the scheduler ───────────────
// Extracted from index.ts — state that is shared across multiple modules.

import type { HunterJob } from "./convexClient.js";
import { sendHeartbeat } from "./convexClient.js";
import {
  log,
  generateIntervalMs,
  formatMs,
  coordinateSiblings,
  isRushHour,
  MAX_LOGIN_FAILURES,
  MAX_CONSECUTIVE_ERRORS,
  SILENCE_RADIO_MIN_MS,
  SILENCE_RADIO_MAX_MS,
  SILENCE_RADIO_SAME_TIER_MIN_MS,
  SILENCE_RADIO_SAME_TIER_MAX_MS,
  RUSH_SILENCE_MIN_MS,
  RUSH_SILENCE_MAX_MS,
} from "./scheduler-utils.js";
import type { SessionResult } from "./navigator.js";

// ─── Shared mutable state ───────────────────────────────────────────────────
export const pausedJobs = new Set<string>();
export const completedJobs = new Set<string>();
export const consecutiveLoginFailures = new Map<string, number>();
export const consecutiveErrors = new Map<string, number>();
export const scheduledNextDue = new Map<string, number>();
export const staggerOffsets = new Map<string, number>();
export const radioSilenceUntil = new Map<string, number>();

// ─── Vérification bundle portail USA ────────────────────────────────────────
export const BUNDLE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export let lastBundleCheckAt = 0;
export function setLastBundleCheckAt(val: number): void {
  lastBundleCheckAt = val;
}

/** Vérifie si un dossier est encore en période de silence radio. */
export function isInRadioSilence(jobId: string): boolean {
  const until = radioSilenceUntil.get(jobId);
  if (!until) return false;
  if (Date.now() >= until) {
    radioSilenceUntil.delete(jobId);
    return false;
  }
  return true;
}

/** Applique un silence radio per-dossier après un cycle. */
export function applyRadioSilence(jobId: string, sameTierNext: boolean): void {
  let silenceMs: number;
  if (isRushHour()) {
    silenceMs = Math.round(RUSH_SILENCE_MIN_MS + Math.random() * (RUSH_SILENCE_MAX_MS - RUSH_SILENCE_MIN_MS));
  } else if (sameTierNext) {
    silenceMs = Math.round(SILENCE_RADIO_SAME_TIER_MIN_MS + Math.random() * (SILENCE_RADIO_SAME_TIER_MAX_MS - SILENCE_RADIO_SAME_TIER_MIN_MS));
  } else {
    silenceMs = Math.round(SILENCE_RADIO_MIN_MS + Math.random() * (SILENCE_RADIO_MAX_MS - SILENCE_RADIO_MIN_MS));
  }
  radioSilenceUntil.set(jobId, Date.now() + silenceMs);
  const silenceType = isRushHour() ? "rush" : sameTierNext ? "stagger" : "normal";
  log("INFO", `📻 [${jobId.slice(-6)}] Silence radio per-dossier ${formatMs(silenceMs)} (${silenceType})`);
}

export function syncAdminResets(freshJobs: HunterJob[]): void {
  const freshJobIds = new Set(freshJobs.map((j) => j.id));

  for (const jobId of pausedJobs) {
    if (!freshJobIds.has(jobId)) {
      pausedJobs.delete(jobId);
      completedJobs.delete(jobId);
      consecutiveLoginFailures.delete(jobId);
      consecutiveErrors.delete(jobId);
      scheduledNextDue.delete(jobId);
      radioSilenceUntil.delete(jobId);
      continue;
    }
    if (completedJobs.has(jobId)) {
      continue;
    }
    const freshJob = freshJobs.find((j) => j.id === jobId);
    if (freshJob && freshJob.hunterConfig.isActive) {
      log("INFO", `[${freshJob.applicantName}] Admin reset détecté — reprise`);
      pausedJobs.delete(jobId);
      consecutiveLoginFailures.delete(jobId);
      consecutiveErrors.delete(jobId);
      scheduledNextDue.delete(jobId);
      radioSilenceUntil.delete(jobId);
    }
  }

  for (const jobId of completedJobs) {
    if (!freshJobIds.has(jobId)) completedJobs.delete(jobId);
  }

  for (const jobId of consecutiveLoginFailures.keys()) {
    if (!freshJobIds.has(jobId)) consecutiveLoginFailures.delete(jobId);
  }
  for (const jobId of consecutiveErrors.keys()) {
    if (!freshJobIds.has(jobId)) consecutiveErrors.delete(jobId);
  }
  for (const jobId of scheduledNextDue.keys()) {
    if (!freshJobIds.has(jobId)) scheduledNextDue.delete(jobId);
  }
  for (const jobId of staggerOffsets.keys()) {
    if (!freshJobIds.has(jobId)) staggerOffsets.delete(jobId);
  }
  for (const jobId of radioSilenceUntil.keys()) {
    if (!freshJobIds.has(jobId)) radioSilenceUntil.delete(jobId);
  }
}

export async function handleResult(job: HunterJob, result: SessionResult): Promise<void> {
  log("INFO", `[${job.applicantName}] Résultat: ${result}`);

  switch (result) {
    case "slot_found":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      pausedJobs.add(job.id);
      completedJobs.add(job.id);
      log("INFO", `[${job.applicantName}] ✅ CRÉNEAU TROUVÉ — dossier retiré de la file`);
      return;

    case "login_failed": {
      consecutiveErrors.delete(job.id);
      const loginFails = (consecutiveLoginFailures.get(job.id) ?? 0) + 1;
      consecutiveLoginFailures.set(job.id, loginFails);
      log("WARN", `[${job.applicantName}] Échec login #${loginFails}/${MAX_LOGIN_FAILURES}`);

      if (loginFails >= MAX_LOGIN_FAILURES) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] ${MAX_LOGIN_FAILURES} échecs consécutifs — auto-pause`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${loginFails} login failures consécutives — vérifier les identifiants`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Heartbeat pause échoué: ${err}`);
        }
        return;
      }
      break;
    }

    case "error": {
      consecutiveLoginFailures.delete(job.id);
      const errCount = (consecutiveErrors.get(job.id) ?? 0) + 1;
      consecutiveErrors.set(job.id, errCount);
      log("WARN", `[${job.applicantName}] Erreur transitoire #${errCount}/${MAX_CONSECUTIVE_ERRORS} — prochain cycle selon tier`);

      if (errCount >= MAX_CONSECUTIVE_ERRORS) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] ${MAX_CONSECUTIVE_ERRORS} erreurs consécutives — auto-pause (compte potentiellement bloqué)`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${errCount} erreurs transitoires consécutives — vérifier statut portail`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Heartbeat pause échoué: ${err}`);
        }
        return;
      }
      break;
    }

    case "captcha":
      log("WARN", `[${job.applicantName}] Bloqué par CAPTCHA — prochain cycle prévu selon tier`);
      break;

    case "payment_required":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      pausedJobs.add(job.id);
      log("WARN", `[${job.applicantName}] 💳 Paiement MRV non confirmé — auto-pause (reprendra après reset admin)`);
      try {
        await sendHeartbeat({
          applicationId: job.id,
          result: "payment_required",
          errorMessage: "Paiement MRV non confirmé (paymentStatus ≠ VERIFIED) — bot en pause. Effectuez le paiement sur usvisaappt.com puis relancez.",
          shouldPause: true,
        });
      } catch (err) {
        log("WARN", `[${job.applicantName}] Heartbeat pause payment échoué: ${err}`);
      }
      return;

    case "not_found":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      log("INFO", `[${job.applicantName}] Aucun créneau disponible`);
      break;
  }

  const baseIntervalMs = generateIntervalMs(job.urgencyTier);
  const perDossierJitter = (Math.random() * 0.3 - 0.15) * baseIntervalMs;
  const intervalMs = Math.max(60_000, Math.round(baseIntervalMs + perDossierJitter));
  const nextDue = Date.now() + intervalMs;
  scheduledNextDue.set(job.id, nextDue);
  log("INFO", `[${job.applicantName}] Prochain check dans ${formatMs(intervalMs)} (${new Date(nextDue).toLocaleTimeString("fr-CD")})`);

  coordinateSiblings(job);
}
