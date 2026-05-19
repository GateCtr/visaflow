/**
 * Blind Booking V3 — Cross-account slot sharing via Convex.
 *
 * CONCEPT :
 *   L'éclaireur (compte avec RDV proche → calendrier ouvert) détecte des slots.
 *   Il broadcast les données (slotId, date, time, OFC) via Convex.
 *   Le confiné (compte avec RDV lointain → calendrier vide) reçoit le broadcast
 *   et tente un PUT /schedule ou /reschedule DIRECTEMENT avec le slotId reçu,
 *   SANS avoir fait de scan (pas de getFirstAvailableMonth ni getSlotDates).
 *
 * FLOW :
 *   1. Éclaireur scanne → slot détecté
 *   2. Éclaireur appelle broadcastSlotDiscovery() → POST vers Convex
 *   3. Éclaireur tente son propre booking (5s timeout)
 *   4. Confinés écoutent via pollBlindBookingEvents() → GET depuis Convex
 *   5. Confiné reçoit l'événement → appelle attemptBlindBooking()
 *   6. attemptBlindBooking() construit le payload et fait le PUT directement
 *
 * CONTRAINTES :
 *   - Le confiné DOIT avoir un token valide (login fait avant)
 *   - Le confiné DOIT avoir fait le preflight (/appointments/search) pour obtenir
 *     ses propres appointmentId, applicantId, applicantUUID
 *   - Le slotId est CROSS-ACCOUNT (le serveur ne vérifie pas qui l'a "vu")
 *   - Le booking peut échouer (409 = slot pris, 401 = token expiré)
 *
 * QUESTION OUVERTE (à valider par test) :
 *   Est-ce que le serveur accepte un PUT /schedule avec un slotId que le compte
 *   n'a jamais vu via getSlotDates/getSlotTime ? → Si oui = blind booking confirmé.
 *   Si non → le confiné devra faire getSlotTime juste avant le PUT.
 */

import { buildBookingRequest, type BookingPayloadConfig } from "./booking-payload.js";
import { usaFetch } from "../../usaPortal/usa-http.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "../../usaPortal/errors.js";
import { isRestrictedBody } from "../../usaPortal/account-restriction.js";
import type { UsaTimeSlot } from "../../usaPortal/usa-scan-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Événement de slot broadcast par un éclaireur. */
export interface SlotBroadcastEvent {
  /** ID unique de l'événement (généré par Convex). */
  eventId?: string;
  /** Compte éclaireur qui a détecté le slot. */
  sourceUsername: string;
  /** Bureau (OFC/POST). */
  office: string;
  /** postUserId du bureau. */
  postUserId: number;
  /** Date du slot (YYYY-MM-DD). */
  date: string;
  /** Heure formatée (ex: "9:00 AM"). */
  time: string;
  /** slotId brut (alphanumérique 30 chars). */
  slotId: string | number;
  /** startTime brut du slot (pour reconstruire le payload). */
  startTime: string;
  /** Timestamp de la découverte. */
  discoveredAt: number;
  /** L'éclaireur a-t-il déjà booké ce slot ? */
  sourceBooked: boolean;
}

/** Contexte du compte confiné qui tente le blind booking. */
export interface BlindBookingContext {
  /** Token d'accès valide du confiné. */
  accessToken: string;
  /** applicationId du dossier confiné. */
  applicationId: string;
  /** applicantId GSS du confiné (ex: "ODXJKHXJQMZH"). */
  applicantId: string | number;
  /** appointmentId existant du confiné (pour le payload). */
  appointmentId?: number;
  /** applicantUUID du confiné. */
  applicantUUID?: number;
  /** missionId (323 pour USA Kinshasa). */
  missionId: number;
  /** Mode booking du confiné. */
  mode: "schedule" | "reschedule";
  /** Type du RDV existant (pour reschedule). */
  existingLocationType?: "OFC" | "POST";
  /** CSRF token (vide — le serveur l'ignore). */
  csrfToken: string;
}

/** Résultat d'un blind booking. */
export interface BlindBookingResult {
  success: boolean;
  appointmentId?: number;
  responseMsg?: string;
  error?: string;
  statusCode?: number;
  /** Temps écoulé entre la détection (éclaireur) et le booking (confiné). */
  reactionTimeMs: number;
}

// ─── Broadcast (côté éclaireur) ─────────────────────────────────────────────

/**
 * Broadcast un slot détecté vers Convex pour les confinés.
 *
 * CHANGEMENT 19/05/2026 : rendu async + log du résultat HTTP.
 * Avant : fire-and-forget (fetch sans await) → échecs SILENCIEUX.
 * Après : await + log du status → diagnostic possible.
 *
 * L'éclaireur appelle cette fonction après avoir détecté un slot.
 * L'appelant (scan-slots.ts) n'attend PAS le résultat car il boucle
 * sur les timeSlots — mais le broadcast est maintenant observable dans les logs.
 */
export function broadcastSlotDiscovery(
  event: SlotBroadcastEvent,
  convexSiteUrl: string,
  hunterApiKey: string,
): void {
  const url = `${convexSiteUrl}/hunter/slot-broadcast`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": hunterApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000), // timeout 15s pour ne pas bloquer indéfiniment
  }).then((res) => {
    if (res.ok) {
      console.log(`[blind-booking] ✅ Broadcast OK → Convex (${event.date} ${event.time} slotId=${String(event.slotId).slice(0,10)}…)`);
    } else {
      res.text().then(body => {
        console.error(`[blind-booking] ❌ Broadcast REJETÉ par Convex — HTTP ${res.status}: ${body.slice(0, 200)}`);
      }).catch(() => {
        console.error(`[blind-booking] ❌ Broadcast REJETÉ par Convex — HTTP ${res.status} (body illisible)`);
      });
    }
  }).catch((err) => {
    console.error(`[blind-booking] ❌ Broadcast ÉCHOUÉ (réseau/timeout): ${err}`);
  });
}

// ─── Réception (côté confiné) ───────────────────────────────────────────────

/**
 * Récupère les événements de blind booking non traités depuis Convex.
 * Appelé périodiquement par le confiné (toutes les 5-10s).
 *
 * Retourne les événements récents (< 5 min) non encore traités par ce compte.
 */
export async function pollBlindBookingEvents(
  username: string,
  convexSiteUrl: string,
  hunterApiKey: string,
): Promise<SlotBroadcastEvent[]> {
  const url = `${convexSiteUrl}/hunter/slot-broadcast/pending?username=${encodeURIComponent(username)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Hunter-Key": hunterApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { events?: SlotBroadcastEvent[] };
    return data.events ?? [];
  } catch {
    return [];
  }
}

// ─── Booking direct (côté confiné) ──────────────────────────────────────────

/**
 * Tente un blind booking avec les données reçues d'un éclaireur.
 *
 * Le confiné N'A PAS fait de scan — il utilise directement le slotId broadcast.
 * Il doit cependant avoir fait le preflight (/appointments/search) pour obtenir
 * ses propres IDs (appointmentId, applicantId, applicantUUID).
 *
 * @param event - Slot broadcast reçu de l'éclaireur
 * @param ctx - Contexte du compte confiné
 * @returns Résultat du booking
 */
export async function attemptBlindBooking(
  event: SlotBroadcastEvent,
  ctx: BlindBookingContext,
): Promise<BlindBookingResult> {
  const reactionStart = Date.now();

  console.log(
    `[blind-booking] 🎯 Tentative blind booking — ` +
    `slot=${event.slotId} date=${event.date} time=${event.time} ` +
    `source=${event.sourceUsername.slice(0, 12)}… ` +
    `délai=${Math.round((Date.now() - event.discoveredAt) / 1000)}s depuis détection`
  );

  // Construire un UsaTimeSlot minimal depuis l'événement broadcast
  const slot: UsaTimeSlot = {
    slotId: event.slotId,
    startTime: event.startTime,
    endTime: "",  // Non requis pour le booking
    slotDate: event.date,
  };

  // Construire le payload via le module booking-payload
  const payloadConfig: BookingPayloadConfig = {
    mode: ctx.mode,
    slot,
    slotDate: event.date,
    applicationId: ctx.applicationId,
    applicantId: ctx.applicantId,
    postUserId: event.postUserId,
    appointmentId: ctx.appointmentId,
    applicantUUID: ctx.applicantUUID,
    targetLocationType: "POST", // Kinshasa = POST (ambassade)
    accessToken: ctx.accessToken,
    missionId: ctx.missionId,
    csrfToken: ctx.csrfToken, // Vide — le serveur l'ignore
    existingLocationType: ctx.existingLocationType,
  };

  const { endpoint, body, headers } = buildBookingRequest(payloadConfig);

  try {
    const res = await usaFetch(endpoint, {
      method: "PUT",
      headers,
      body,
      signal: AbortSignal.timeout(15_000), // 15s max pour un booking
    });

    const reactionTimeMs = Date.now() - reactionStart;

    if (res.ok) {
      let arr: Array<{ responseMsg?: string; appointmentId?: number }> = [];
      try { arr = await res.json() as typeof arr; } catch { /* body vide */ }
      const msg = arr[0]?.responseMsg ?? "Booking confirmé";
      const appointmentId = arr[0]?.appointmentId;
      console.log(`[blind-booking] ✅ BLIND BOOKING RÉUSSI en ${reactionTimeMs}ms — "${msg}" (appointmentId=${appointmentId})`);
      return { success: true, appointmentId, responseMsg: msg, reactionTimeMs };
    }

    // Circuit-breakers
    if (res.status === 429) {
      throw new RateLimitError(endpoint, 60000);
    }
    if (res.status === 403) {
      throw new AccountBlockedError(endpoint);
    }
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }

    // 409 = slot déjà pris (l'éclaireur ou un autre confiné l'a eu)
    if (res.status === 409) {
      const respBody = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = respBody.responseMsg ?? "Créneau déjà pris (409)";
      console.log(`[blind-booking] ⚠️ Slot déjà pris (409) — ${msg} (réaction: ${reactionTimeMs}ms)`);
      return { success: false, error: msg, statusCode: 409, reactionTimeMs };
    }

    const text = await res.text();
    console.warn(`[blind-booking] ❌ HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { success: false, error: `HTTP ${res.status}`, statusCode: res.status, reactionTimeMs };

  } catch (err) {
    const reactionTimeMs = Date.now() - reactionStart;
    // Re-throw circuit-breakers
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[blind-booking] ❌ Erreur: ${msg}`);
    return { success: false, error: msg, reactionTimeMs };
  }
}

/**
 * Marque un événement comme traité par ce compte (dans Convex).
 * Empêche le même confiné de retenter le même slot.
 * Fire-and-forget.
 */
export function markEventProcessed(
  eventId: string,
  username: string,
  result: "booked" | "failed" | "expired",
  convexSiteUrl: string,
  hunterApiKey: string,
): void {
  const url = `${convexSiteUrl}/hunter/slot-broadcast/ack`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": hunterApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ eventId, username, result, processedAt: Date.now() }),
  }).catch(() => { /* fire-and-forget */ });
}
