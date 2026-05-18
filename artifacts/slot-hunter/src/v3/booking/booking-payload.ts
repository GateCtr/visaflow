/**
 * Booking Payload V3 — Construction des payloads PUT /schedule et /reschedule.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Construire le payload exact (10 champs schedule, 11 champs reschedule)
 *   et les headers CSRF associés. Aucune logique réseau ici.
 *
 * RÈGLES CONFIRMÉES (captures réseau 13/05/2026 + code bundle Angular) :
 *   - Schedule : Body = objet simple {}
 *   - Reschedule : Body = ARRAY [{}] + champ rescheduleType
 *   - appointmentTime : format 12h AM/PM (ex: "9:00 AM", "2:00 PM")
 *   - appointmentDt : YYYY-MM-DD (depuis slotDate ou date du getSlotDates)
 *   - locationType dans payload = type du bureau CIBLE (pas le RDV existant)
 *   - rescheduleType = type du RDV EXISTANT (pas celui qu'on veut)
 *   - CSRF : envoyé VIDE (le serveur ne le vérifie jamais — confirmé par test)
 *   - Pas de cookies APP_ID_TOBE dans les headers slot, MAIS OUI dans le booking
 *
 * USAGE :
 *   const { body, headers, endpoint } = buildBookingRequest(config);
 *   const res = await usaFetch(endpoint, { method: "PUT", headers, body });
 */

import type { UsaTimeSlot } from "../../usaPortal/usa-scan-types.js";
import {
  USA_SCHEDULE_URL,
  USA_RESCHEDULE_URL,
  REFERER_CREATE_APT,
  REFERER_MANAGE_APT,
} from "../../usaPortal/config.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration pour construire un payload de booking. */
export interface BookingPayloadConfig {
  /** Mode : nouveau booking ou reporter un RDV existant. */
  mode: "schedule" | "reschedule";

  // ── Données du slot trouvé ──
  slot: UsaTimeSlot;
  /** Date du slot (YYYY-MM-DD). */
  slotDate: string;

  // ── Données du dossier ──
  applicationId: string;
  applicantId: number | string;
  postUserId: number;
  appointmentId?: number;
  applicantUUID?: number;

  // ── Données du bureau ──
  /** Type du bureau CIBLE ("OFC" ou "POST"). */
  targetLocationType: "OFC" | "POST";

  // ── Session ──
  accessToken: string;
  missionId: number;
  csrfToken: string; // Envoyé vide — le serveur l'ignore

  // ── Reschedule only ──
  /** Type du RDV EXISTANT (pour rescheduleType). */
  existingLocationType?: "OFC" | "POST";
}

/** Résultat de la construction du payload. */
export interface BookingRequest {
  /** URL de l'endpoint (schedule ou reschedule). */
  endpoint: string;
  /** Body sérialisé en JSON (prêt pour fetch). */
  body: string;
  /** Headers complets (Authorization + CSRF + Cookie + Content-Type). */
  headers: Record<string, string>;
  /** Payload brut (pour les logs). */
  payload: Record<string, unknown>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convertit un startTime en format 12h AM/PM (comme le bundle Angular setUItime).
 * "09:00" → "9:00 AM", "14:30" → "2:30 PM", "00:00" → "12:00 AM"
 */
export function formatUItime(startTime: string): string {
  let timePart: string;
  if (startTime.includes("T")) {
    timePart = startTime.split("T")[1].slice(0, 5);
  } else {
    timePart = startTime.slice(0, 5);
  }

  const match = timePart.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) return timePart;

  const hour24 = parseInt(match[1], 10);
  const minutes = match[2];
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 < 12 ? " AM" : " PM";

  return `${hour12}:${minutes}${suffix}`;
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Construit le payload + headers + endpoint pour un booking (schedule ou reschedule).
 *
 * Retourne tout ce qu'il faut pour faire le PUT — l'appelant n'a qu'à fetch.
 */
export function buildBookingRequest(config: BookingPayloadConfig): BookingRequest {
  const appointmentTime = formatUItime(config.slot.startTime ?? "");
  const appointmentDt = (config.slot as Record<string, unknown>).slotDate as string
    ?? config.slotDate;

  // ── Payload commun (10 champs) ──
  const payload: Record<string, unknown> = {
    // 7 champs de bookSlot()
    appointmentId: config.appointmentId,
    applicantUUID: config.applicantUUID,
    appointmentLocationType: config.targetLocationType,
    appointmentStatus: "SCHEDULED",
    slotId: config.slot.slotId,
    appointmentDt,
    appointmentTime,
    // 3 champs de initBookSlot()
    postUserId: config.postUserId,
    applicantId: config.applicantId,
    applicationId: config.applicationId,
  };

  // ── Mode-specific ──
  let endpoint: string;
  let body: string;
  let referer: string;

  if (config.mode === "reschedule") {
    // Reschedule : ajouter rescheduleType + wrapper en array
    payload.rescheduleType = config.existingLocationType ?? "POST";
    endpoint = USA_RESCHEDULE_URL;
    body = JSON.stringify([payload]); // ARRAY — différence critique
    referer = REFERER_MANAGE_APT;
  } else {
    // Schedule : objet simple
    endpoint = USA_SCHEDULE_URL;
    body = JSON.stringify(payload);
    referer = REFERER_CREATE_APT;
  }

  // ── Headers ──
  // Le bundle Angular ajoute sur les PUT :
  //   - Cookie: APP_ID_TOBE={applicationId}; missionId={missionId}
  //   - CookieName: XSRF-TOKEN={csrfToken}  (custom interceptor)
  //   - X-XSRF-TOKEN: {csrfToken}           (HttpClientXsrfModule)
  // Le csrfToken est TOUJOURS vide (jamais renvoyé par le serveur) — le booking passe quand même.
  const token = config.accessToken.trim().replace(/^Bearer\s+/i, "").trim();
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Referer": referer,
    "Cookie": `APP_ID_TOBE=${config.applicationId}; missionId=${config.missionId}`,
    "CookieName": `XSRF-TOKEN=${config.csrfToken}`,
    "X-XSRF-TOKEN": config.csrfToken,
  };

  return { endpoint, body, headers, payload };
}

/**
 * Helper : log le payload de booking de manière concise (pour botLog).
 */
export function summarizeBookingPayload(config: BookingPayloadConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    slotId: config.slot.slotId,
    date: config.slotDate,
    time: formatUItime(config.slot.startTime ?? ""),
    ofc: config.postUserId,
    applicantId: config.applicantId,
    applicationId: config.applicationId,
    appointmentId: config.appointmentId ?? null,
    locationType: config.targetLocationType,
    ...(config.mode === "reschedule" ? { rescheduleType: config.existingLocationType ?? "POST" } : {}),
  };
}
