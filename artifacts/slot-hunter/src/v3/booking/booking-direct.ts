/**
 * Booking Direct V3 — PUT /schedule ou /reschedule après détection de slot.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Effectuer le booking HTTP (PUT) après qu'un slot a été détecté par le scan.
 *   Construit le payload via booking-payload.ts et fait l'appel réseau.
 *
 * DIFFÉRENCE avec booking-blind.ts :
 *   - Direct : le compte a lui-même scanné et trouvé le slot
 *   - Blind : le compte reçoit un slot broadcast par un éclaireur
 *
 * FLOW :
 *   1. preBookingPause() (simule hésitation humaine)
 *   2. buildBookingRequest() → payload + headers
 *   3. PUT /schedule ou /reschedule
 *   4. Parser la réponse → BookingOutcome
 *
 * USAGE :
 *   const outcome = await bookSlotDirect(config);
 *   if (outcome.success) { // slot capturé }
 */

import { buildBookingRequest, type BookingPayloadConfig, type BookingRequest } from "./booking-payload.js";
import { usaFetch } from "../../usaPortal/usa-http.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "../../usaPortal/errors.js";
import { isRestrictedBody } from "../../usaPortal/account-restriction.js";
import { preBookingPause } from "../anti-detection/human-timing.js";
import type { UsaTimeSlot, SlotFound } from "../../usaPortal/usa-scan-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Résultat d'un booking direct. */
export interface BookingOutcome {
  /** Le booking a-t-il réussi ? */
  success: boolean;
  /** ID du rendez-vous créé (si succès). */
  appointmentId?: number;
  /** Message serveur (ex: "Appointment Scheduled Successfully"). */
  responseMsg?: string;
  /** Code HTTP de la réponse. */
  statusCode: number;
  /** Erreur (si échec). */
  error?: string;
  /** Latence totale (ms) incluant la pause humaine. */
  totalLatencyMs: number;
  /** Le slot est-il pris par un concurrent (409) ? */
  slotTaken: boolean;
}

/** Configuration pour un booking direct. */
export interface DirectBookingConfig {
  /** Slot trouvé par le scan. */
  slotFound: SlotFound;
  /** applicationId du dossier. */
  applicationId: string;
  /** applicantId GSS (ex: "RQUP3HHVQHOD"). */
  applicantId: string | number;
  /** appointmentId existant. */
  appointmentId?: number;
  /** applicantUUID. */
  applicantUUID?: number;
  /** Mode : nouveau booking ou reschedule. */
  mode: "schedule" | "reschedule";
  /** Token d'accès. */
  accessToken: string;
  /** missionId (323 pour USA Kinshasa). */
  missionId: number;
  /** CSRF token (vide — le serveur l'ignore). */
  csrfToken?: string;
  /** Type du bureau cible ("OFC" | "POST"). */
  targetLocationType: "OFC" | "POST";
  /** Type du RDV existant (pour reschedule). */
  existingLocationType?: "OFC" | "POST";
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Effectue un booking direct après détection de slot par le scan.
 *
 * Inclut une pause humaine pré-booking (1.5-4s) pour anti-détection.
 * Lève RateLimitError / AccountBlockedError / TokenExpiredError si critique.
 */
export async function bookSlotDirect(config: DirectBookingConfig): Promise<BookingOutcome> {
  const startMs = Date.now();

  // Pause humaine avant booking (un humain hésite avant de cliquer "Confirmer")
  await preBookingPause();

  // Construire le payload
  const payloadConfig: BookingPayloadConfig = {
    mode: config.mode,
    slot: config.slotFound.slot,
    slotDate: config.slotFound.date,
    applicationId: config.applicationId,
    applicantId: config.applicantId,
    postUserId: config.slotFound.bookingBase.postUserId as number,
    appointmentId: config.appointmentId,
    applicantUUID: config.applicantUUID,
    targetLocationType: config.targetLocationType,
    accessToken: config.accessToken,
    missionId: config.missionId,
    csrfToken: config.csrfToken ?? "",
    existingLocationType: config.existingLocationType,
  };

  const request: BookingRequest = buildBookingRequest(payloadConfig);

  console.log(
    `[booking-direct] 📋 PUT ${config.mode} — ` +
    `slot=${config.slotFound.slotId} date=${config.slotFound.date} time=${config.slotFound.time} ` +
    `ofc=${config.slotFound.ofcName}`
  );

  try {
    const res = await usaFetch(request.endpoint, {
      method: "PUT",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(20_000), // 20s timeout pour un booking
    });

    const totalLatencyMs = Date.now() - startMs;

    // ── Succès (200/201) ──
    if (res.ok) {
      let responseData: Array<{ responseMsg?: string; appointmentId?: number }> = [];
      try { responseData = await res.json() as typeof responseData; } catch { /* body vide */ }
      const msg = responseData[0]?.responseMsg ?? "Booking confirmé";
      const aptId = responseData[0]?.appointmentId;

      console.log(`[booking-direct] ✅ BOOKING RÉUSSI en ${totalLatencyMs}ms — "${msg}"`);

      return {
        success: true,
        appointmentId: aptId,
        responseMsg: msg,
        statusCode: res.status,
        totalLatencyMs,
        slotTaken: false,
      };
    }

    // ── Circuit-breakers ──
    if (res.status === 429) {
      throw new RateLimitError(request.endpoint, 60_000);
    }
    if (res.status === 403) {
      throw new AccountBlockedError(request.endpoint);
    }
    if (res.status === 401) {
      const body = await res.text().catch(() => "");
      if (isRestrictedBody(body)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }

    // ── 409 = slot pris par un concurrent ──
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Slot déjà pris (409)";
      console.log(`[booking-direct] ⚠️ 409 — ${msg} (latence: ${totalLatencyMs}ms)`);
      return {
        success: false,
        responseMsg: msg,
        statusCode: 409,
        error: msg,
        totalLatencyMs,
        slotTaken: true,
      };
    }

    // ── Autre erreur ──
    const errText = await res.text().catch(() => "");
    console.warn(`[booking-direct] ❌ HTTP ${res.status}: ${errText.slice(0, 200)}`);
    return {
      success: false,
      statusCode: res.status,
      error: `HTTP ${res.status}: ${errText.slice(0, 100)}`,
      totalLatencyMs,
      slotTaken: false,
    };

  } catch (err) {
    const totalLatencyMs = Date.now() - startMs;
    // Re-throw circuit-breakers
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[booking-direct] ❌ Exception: ${msg}`);
    return {
      success: false,
      statusCode: 0,
      error: msg,
      totalLatencyMs,
      slotTaken: false,
    };
  }
}
