/**
 * Booking / reschedule + helpers (format UI time, batch discovery).
 */
import type { UsaSession } from "./types.js";
import type { UsaTimeSlot } from "./usa-scan-types.js";
import type { SlotDiscoveryEvent } from "../convexClient.js";
import { reportSlotDiscoveryBatch } from "../convexClient.js";
import {
  USA_SCHEDULE_URL,
  USA_RESCHEDULE_URL,
  REFERER_MANAGE_APT,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { usaFetch, sessionHeaders } from "./usa-http.js";

export interface UsaBookingPayload {
  appointmentId: number | undefined;
  applicantUUID: number | undefined;
  appointmentLocationType: "OFC" | "POST";
  appointmentStatus: "SCHEDULED";
  slotId: number | string;  // string alphanumérique (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
  appointmentDt: string;
  appointmentTime: string;
  postUserId: number;
  applicantId: number | string;
  applicationId: string;
}

export interface UsaBookingEntry {
  responseMsg?: string;
  appointmentId?: number;
  [key: string]: unknown;
}

export type UsaBookingResponse = UsaBookingEntry[];

export interface UsaBookingResult {
  success: boolean;
  appointmentId?: number;
  responseMsg?: string;
  error?: string;
  statusCode?: number;
}

function formatUItime(startTime: string): string {
  // Extraire "HH:mm" depuis une ISO ou une string "HH:mm:ss" / "HH:mm"
  let timePart: string;
  if (startTime.includes("T")) {
    timePart = startTime.split("T")[1].slice(0, 5); // "09:00"
  } else {
    timePart = startTime.slice(0, 5);               // "09:00"
  }

  const match = timePart.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) return timePart; // fallback si format inattendu

  const hour24 = parseInt(match[1], 10);
  const minutes = match[2];
  const hour12  = hour24 % 12 || 12;      // 0 → 12, 13 → 1, 12 → 12
  const suffix  = hour24 < 12 ? " AM" : " PM";

  return `${hour12}:${minutes}${suffix}`;  // ex. "9:00 AM", "2:00 PM"
}

export function reportSlotDiscovery_batch(events: SlotDiscoveryEvent[], jobId: string): void {
  // Overrider applicationId avec le jobId Convex (les events ont le portalApplicationId)
  const eventsWithJobId = events.map(e => ({ ...e, applicationId: jobId }));
  reportSlotDiscoveryBatch(eventsWithJobId);
}

export async function bookUsaSlot(
  session: UsaSession,
  found: { slot: UsaTimeSlot; bookingBase: Record<string, unknown>; date: string; time: string }
): Promise<UsaBookingResult> {
  // ─── Reconstruction du payload PUT /appointments/schedule (10 champs exacts du bundle) ───
  //
  // Le bundle Angular (bookSlot() + initBookSlot()) construit le payload en deux étapes :
  //
  // Étape 1 — bookSlot() : objet `se` avec 7 champs
  //   se = {
  //     appointmentId:          selectedSlotDetails.appointmentId || parseInt(sessionStorage("appointmentId")),
  //     applicantUUID:          selectedSlotDetails.applicantUUID || parseInt(sessionStorage("applicantUUID")),
  //     appointmentLocationType: this.ofcOrPost,             // "OFC"
  //     appointmentStatus:       "SCHEDULED",
  //     slotId:                  this.selectedSlot.slotId,
  //     appointmentDt:           this.selectedSlot.slotDate, // pas "date", pas "startTime"
  //     appointmentTime:         this.selectedSlot.UItime,   // "9:00 AM" (pas "09:00")
  //   }
  //
  // Étape 2 — initBookSlot(se) : 3 champs ajoutés par mutation directe sur se
  //   se.postUserId    = this.selectedOfc              (postUserId du bureau OFC sélectionné)
  //   se.applicantId   = selectedSlotDetails.applicantId
  //   se.applicationId = this.applicationId
  //
  // Total : 10 champs. PAS de visaType, visaClass, locationType, startTime, endTime, date, time.
  // Ces champs sont UNIQUEMENT dans les payloads getSlotDates/getSlotTime, JAMAIS dans le booking.

  const slotRaw = found.slot as Record<string, unknown>;
  const slotDate = slotRaw.slotDate as string | undefined ?? found.date;
  const appointmentTime = formatUItime(found.slot.startTime ?? found.time);

  const payload: UsaBookingPayload = {
    // ── 7 champs de bookSlot() ──
    appointmentId:          session.appointmentId,
    applicantUUID:          session.applicantUUID,
    // Bundle : appointmentLocationType = this.ofcOrPost (type du bureau sélectionné)
    // Pour Kinshasa (POST) → "POST", pour les bureaux OFC → "OFC"
    appointmentLocationType: (found.bookingBase.locationType as "OFC" | "POST") ?? "OFC",
    appointmentStatus:       "SCHEDULED",
    slotId:                  found.slot.slotId,
    appointmentDt:           slotDate,
    appointmentTime,          // format 12h AM/PM via formatUItime() = setUItime() Angular

    // ── 3 champs ajoutés par initBookSlot() ──
    postUserId:    found.bookingBase.postUserId   as number,
    applicantId:   found.bookingBase.applicantId  as number | string,
    applicationId: found.bookingBase.applicationId as string,
  };

  console.log(
    `[usa] 📝 Tentative de booking — slotId=${payload.slotId}, appointmentDt=${slotDate}, ` +
    `appointmentTime=${appointmentTime}, appointmentId=${session.appointmentId ?? "N/A"}, ` +
    `OFC postUserId=${payload.postUserId}`
  );

  try {
    // L'intercepteur Angular ajoute sur TOUS les PUT deux mécanismes CSRF :
    //   1. CookieName: XSRF-TOKEN={csrfToken}  (localStorage["CSRFTOKEN"] — custom interceptor Angular)
    //   2. X-XSRF-TOKEN: {csrfToken}           (cookie XSRF-TOKEN → HttpClient built-in Angular)
    // Source : bundle Angular, intercepteur HTTP, clause "PUT"==v.method + HttpClientXsrfModule.
    const bookingHeaders = {
      ...sessionHeaders(session.accessToken, payload.applicationId, session.missionId),
      "CookieName": `XSRF-TOKEN=${session.csrfToken}`,
      "X-XSRF-TOKEN": session.csrfToken,
    };
    const res = await usaFetch(USA_SCHEDULE_URL, {
      method: "PUT",
      headers: bookingHeaders,
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      let arr: UsaBookingResponse = [];
      try { arr = await res.json() as UsaBookingResponse; } catch { /* body vide */ }
      const msg = arr[0]?.responseMsg ?? "Booking confirmé";
      const appointmentId = arr[0]?.appointmentId;
      console.log(`[usa] ✅ BOOKING RÉUSSI — "${msg}" (appointmentId=${appointmentId})`);
      return { success: true, appointmentId, responseMsg: msg };
    }

    // Circuit-breakers : ces erreurs pendant le booking stoppent tout le scan
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      throw new RateLimitError(USA_SCHEDULE_URL, waitMs);
    }
    if (res.status === 403) {
      throw new AccountBlockedError(USA_SCHEDULE_URL);
    }
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }

    // 409 = créneau déjà pris par un autre usager (race entre hunters)
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Créneau déjà pris (conflit 409)";
      console.warn(`[usa] ⚠️ Conflit 409 — ${msg}`);
      return { success: false, error: msg, statusCode: 409 };
    }

    // 502 = erreur serveur temporaire
    if (res.status === 502) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Erreur serveur 502";
      console.warn(`[usa] ⚠️ Serveur 502 — ${msg}`);
      return { success: false, error: msg, statusCode: 502 };
    }

    const text = await res.text();
    console.warn(`[usa] ⚠️ Booking échoué HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { success: false, error: `HTTP ${res.status}`, statusCode: res.status };

  } catch (err) {
    // Re-lancer les erreurs circuit-breaker pour qu'elles remontent jusqu'à scanUsaSlotsViaAPI
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] Booking erreur réseau: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function rescheduleUsaSlot(
  session: UsaSession,
  found: { slot: UsaTimeSlot; bookingBase: Record<string, unknown>; date: string; time: string }
): Promise<UsaBookingResult> {
  const slotRaw = found.slot as Record<string, unknown>;
  const slotDate = slotRaw.slotDate as string | undefined ?? found.date;
  const appointmentTime = formatUItime(found.slot.startTime ?? found.time);

  // rescheduleType = type de localisation de l'appointment EXISTANT (POST = ambassade)
  // Bundle : se.rescheduleType = reschedProps.appointmentLocationType
  const rescheduleType: "POST" | "OFC" = (found.bookingBase.locationType as "POST" | "OFC") ?? "POST";

  // Payload identique au booking schedule + rescheduleType (array wrapper)
  const payload: UsaBookingPayload & { rescheduleType: "POST" | "OFC" } = {
    appointmentId:          session.appointmentId,
    applicantUUID:          session.applicantUUID,
    // Bundle : appointmentLocationType = this.ofcOrPost (type du bureau cible)
    appointmentLocationType: (found.bookingBase.locationType as "OFC" | "POST") ?? "OFC",
    appointmentStatus:       "SCHEDULED",
    slotId:                  found.slot.slotId,
    appointmentDt:           slotDate,
    appointmentTime,

    postUserId:    found.bookingBase.postUserId   as number,
    applicantId:   found.bookingBase.applicantId  as number | string,
    applicationId: found.bookingBase.applicationId as string,

    rescheduleType,
  };

  console.log(
    `[usa] ♻️ Tentative RESCHEDULE — slotId=${payload.slotId}, appointmentDt=${slotDate}, ` +
    `appointmentTime=${appointmentTime}, existingApptId=${session.appointmentId ?? "N/A"}, ` +
    `OFC postUserId=${payload.postUserId}, rescheduleType=${rescheduleType}`
  );

  try {
    const bookingHeaders = {
      ...sessionHeaders(session.accessToken, payload.applicationId, session.missionId, REFERER_MANAGE_APT),
      "CookieName":    `XSRF-TOKEN=${session.csrfToken}`,
      "X-XSRF-TOKEN":  session.csrfToken,
    };
    // Le portail envoie le payload en TABLEAU (initRescheduleAPI reçoit appointmentPayload qui est [])
    const res = await usaFetch(USA_RESCHEDULE_URL, {
      method: "PUT",
      headers: bookingHeaders,
      body: JSON.stringify([payload]),
    });

    if (res.ok) {
      let arr: UsaBookingResponse = [];
      try { arr = await res.json() as UsaBookingResponse; } catch { /* body vide */ }
      const msg = arr[0]?.responseMsg ?? "Reschedule confirmé";
      const appointmentId = arr[0]?.appointmentId;
      console.log(`[usa] ✅ RESCHEDULE RÉUSSI — "${msg}" (appointmentId=${appointmentId})`);
      return { success: true, appointmentId, responseMsg: msg };
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      throw new RateLimitError(USA_RESCHEDULE_URL, waitMs);
    }
    if (res.status === 403) throw new AccountBlockedError(USA_RESCHEDULE_URL);
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Créneau déjà pris (conflit 409)";
      console.warn(`[usa] ⚠️ Reschedule conflit 409 — ${msg}`);
      return { success: false, error: msg, statusCode: 409 };
    }
    if (res.status === 502) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Erreur serveur 502";
      console.warn(`[usa] ⚠️ Reschedule serveur 502 — ${msg}`);
      return { success: false, error: msg, statusCode: 502 };
    }
    const text = await res.text();
    console.warn(`[usa] ⚠️ Reschedule échoué HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { success: false, error: `HTTP ${res.status}`, statusCode: res.status };

  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] Reschedule erreur réseau: ${msg}`);
    return { success: false, error: msg };
  }
}
