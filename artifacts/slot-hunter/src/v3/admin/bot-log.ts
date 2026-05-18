/**
 * Bot Log V3 — 5 types de logs ESSENTIELS uniquement (pas de spam).
 *
 * RESPONSABILITÉ :
 *   Encapsuler les 5 types de botLog V3 avec des interfaces typées.
 *   L'appelant ne construit plus le payload manuellement.
 *
 * TYPES :
 *   1. session_lifecycle — login/expire/proxy_death
 *   2. slot_event — detected/booked/lost/blind_shared
 *   3. budget_status — toutes les 10 min
 *   4. discovery_batch — fin de scan
 *   5. critical_error — restriction/proxy_down/budget_exhausted
 */

import { botLog } from "../../convexClient.js";

// ─── 1. Session Lifecycle ───────────────────────────────────────────────────

export function logSessionStart(jobId: string, data: {
  username: string;
  loginNumber: number;
  budgetRemaining: number;
  proxy: string;
  ip: string;
}): void {
  botLog({
    applicationId: jobId,
    step: "session_lifecycle",
    status: "ok",
    data: { event: "login", ...data },
  });
}

export function logSessionExpire(jobId: string, data: {
  username: string;
  sessionDurationMin: number;
  scanCount: number;
}): void {
  botLog({
    applicationId: jobId,
    step: "session_lifecycle",
    status: "ok",
    data: { event: "expire", ...data },
  });
}

export function logProxyDeath(jobId: string, data: {
  username: string;
  proxy: string;
  reason: string;
}): void {
  botLog({
    applicationId: jobId,
    step: "session_lifecycle",
    status: "warn",
    data: { event: "proxy_death", ...data },
  });
}

// ─── 2. Slot Event ──────────────────────────────────────────────────────────

export function logSlotDetected(jobId: string, data: {
  ofc: string;
  date: string;
  time: string;
  lifespanSec?: number;
  competition: string;
  window: string;
}): void {
  botLog({
    applicationId: jobId,
    step: "slot_event",
    status: "ok",
    data: { event: "detected", ...data },
  });
}

export function logBookingResult(jobId: string, data: {
  success: boolean;
  slotId: string | number;
  method: "direct" | "blind";
  latencyMs: number;
  error?: string;
}): void {
  botLog({
    applicationId: jobId,
    step: "slot_event",
    status: data.success ? "ok" : "fail",
    data: { event: "booking_result", ...data },
  });
}

export function logSlotLost(jobId: string, data: {
  ofc: string;
  date: string;
  reason: string;
}): void {
  botLog({
    applicationId: jobId,
    step: "slot_event",
    status: "warn",
    data: { event: "lost", ...data },
  });
}

// ─── 3. Budget Status (toutes les 10 min) ──────────────────────────────────

export function logBudgetStatus(jobId: string, data: {
  used: number;
  remaining: number;
  nextRushIn: number; // minutes
  prediction: { window: string; score: number };
  competition: { level: string; medianSec: number };
}): void {
  botLog({
    applicationId: jobId,
    step: "budget_status",
    status: "ok",
    data,
  });
}

// ─── 4. Discovery Batch (fin de scan) ───────────────────────────────────────

export function logDiscoveryBatch(jobId: string, data: {
  datesFound: number;
  datesIgnored: number;
  datesCaptured: number;
  reasons: Record<string, number>;
  monthsScanned: number;
  blindShared: number;
}): void {
  botLog({
    applicationId: jobId,
    step: "discovery_batch",
    status: "ok",
    data,
  });
}

// ─── 5. Critical Error ──────────────────────────────────────────────────────

export function logCriticalError(jobId: string, data: {
  type: "restriction" | "all_proxy_down" | "budget_exhausted" | "token_expired";
  username: string;
  details: string;
  recoveryAction: string;
}): void {
  botLog({
    applicationId: jobId,
    step: "critical_error",
    status: "fail",
    data,
  });
}
