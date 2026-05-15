/**
 * Pillar 3 — Logique de Retry Horaire sur 409 Conflict
 *
 * Quand un booking échoue avec HTTP 409 (créneau volé au dernier moment par un
 * autre utilisateur), au lieu de quitter le cycle et attendre le prochain scan :
 *
 * 1. Récupérer les slots RESTANTS pour la même date (fenêtre 7h00-9h00)
 * 2. Tenter immédiatement le slot suivant
 * 3. Si la date est épuisée, basculer sur la prochaine date disponible du mois
 *    (max 4 jours/mois à Kinshasa — le consulat ne libère que 4 dates)
 *
 * Stratégie : ne JAMAIS quitter un cycle de scan quand un 409 indique que des
 * créneaux existent encore. Le 409 est une PREUVE qu'il y a de l'activité.
 */

import type { UsaSession } from "./types.js";
import type { UsaTimeSlot, UsaSlotDate, SlotFound } from "./usa-scan-types.js";
import { botLog } from "../convexClient.js";
import { usaFetch, authHeaders } from "./usa-http.js";
import { USA_SLOT_DATES_URL, USA_SLOT_TIMES_URL, REFERER_CREATE_APT } from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { bookUsaSlot, rescheduleUsaSlot } from "./usa-scan-book.js";
import type { UsaBookingResult } from "./usa-scan-book.js";
import { randomInterStepPause } from "./anti-detection.js";

/** Nombre max de retries sur 409 avant d'abandonner (anti-boucle infinie). */
const MAX_409_RETRIES = 5;

/** Fenêtre horaire prioritaire pour les retries (Kinshasa: 7h00-9h00 locales). */
const RUSH_HOUR_START = "07:00";
const RUSH_HOUR_END = "09:00";

/** Max dates alternatives à essayer dans le mois (Kinshasa ≈ 4 dates/mois). */
const MAX_ALTERNATE_DATES = 4;

export interface Retry409Context {
  session: UsaSession;
  /** Payload de base pour les requêtes slot (postUserId, applicantId, etc.) */
  basePayload: Record<string, unknown>;
  /** Date originale du slot qui a reçu le 409 */
  originalDate: string;
  /** Slot ID qui a reçu le 409 (pour ne pas le retenter) */
  failedSlotId: number | string;
  /** Toutes les dates disponibles pour ce mois (déjà récupérées) */
  availableDates: UsaSlotDate[];
  /** Mode reschedule (true = PUT /reschedule au lieu de PUT /schedule) */
  isReschedule: boolean;
  /** Nom de l'OFC pour le logging */
  ofcName: string;
  /** Job ID Convex pour le logging */
  jobId: string;
  /** Headers pour les requêtes slot (Bearer + referer) */
  slotHeaders: Record<string, string>;
  /** fromDate pour les requêtes getSlotTime */
  fromDate: string;
  /** toDate pour les requêtes getSlotTime */
  toDate: string;
}

/**
 * Gère un 409 Conflict en tentant les slots restants de la même date,
 * puis les dates suivantes du mois.
 *
 * @returns Le résultat du booking si réussi, null si tous les retries ont échoué.
 */
export async function handle409Retry(ctx: Retry409Context): Promise<SlotFound & { bookingResult: UsaBookingResult } | null> {
  let retriesDone = 0;
  const triedSlotIds = new Set<string | number>([ctx.failedSlotId]);

  console.log(`[409-retry] 🔄 409 détecté sur ${ctx.ofcName} — lancement retry intelligent`);
  botLog({
    applicationId: ctx.jobId,
    step: "409_retry_start",
    status: "ok",
    data: {
      ofc: ctx.ofcName,
      originalDate: ctx.originalDate,
      failedSlotId: ctx.failedSlotId,
      availableDatesCount: ctx.availableDates.length,
    },
  });

  // ── Phase 1 : Slots restants sur la MÊME date ─────────────────────────────
  console.log(`[409-retry] Phase 1 — Slots restants pour ${ctx.originalDate}...`);

  const sameDateTime = await fetchTimeSlotsForDate(ctx, ctx.originalDate);
  if (sameDateTime && sameDateTime.length > 0) {
    // Filtrer les slots déjà tentés et prioriser la fenêtre 7h-9h
    const remainingSlots = sameDateTime
      .filter((s) => !triedSlotIds.has(s.slotId))
      .sort((a, b) => prioritizeRushHour(a.startTime, b.startTime));

    console.log(`[409-retry] ${remainingSlots.length} slot(s) restant(s) sur ${ctx.originalDate}`);

    for (const slot of remainingSlots) {
      if (retriesDone >= MAX_409_RETRIES) break;

      // Pause humaine entre les tentatives (500-1500ms)
      await randomInterStepPause(500, 1500, ctx.jobId);

      const result = await attemptBookSlot(ctx, slot, ctx.originalDate);
      retriesDone++;
      triedSlotIds.add(slot.slotId);

      if (result) {
        console.log(`[409-retry] ✅ Booking réussi après ${retriesDone} retry(s) — ${ctx.originalDate} ${slot.startTime}`);
        return result;
      }
      // Si le retry retourne aussi un 409, on continue avec le slot suivant
    }
  }

  // ── Phase 2 : Dates alternatives dans le mois ─────────────────────────────
  if (retriesDone >= MAX_409_RETRIES) {
    console.log(`[409-retry] ⚠️ Max retries (${MAX_409_RETRIES}) atteint — abandon`);
    return null;
  }

  // Filtrer les dates futures après la date originale (ne pas revenir en arrière)
  const alternateDates = ctx.availableDates
    .filter((d) => d.date > ctx.originalDate)
    .slice(0, MAX_ALTERNATE_DATES);

  if (alternateDates.length === 0) {
    console.log(`[409-retry] Aucune date alternative disponible après ${ctx.originalDate}`);
    botLog({
      applicationId: ctx.jobId,
      step: "409_retry_exhausted",
      status: "warn",
      data: { ofc: ctx.ofcName, retriesDone, reason: "no_alternate_dates" },
    });
    return null;
  }

  console.log(`[409-retry] Phase 2 — ${alternateDates.length} date(s) alternative(s): ${alternateDates.map((d) => d.date).join(", ")}`);

  for (const altDate of alternateDates) {
    if (retriesDone >= MAX_409_RETRIES) break;

    // Pause humaine entre les dates (1-3s — simuler navigation calendrier)
    await randomInterStepPause(1000, 3000, ctx.jobId);

    const timeSlots = await fetchTimeSlotsForDate(ctx, altDate.date);
    if (!timeSlots || timeSlots.length === 0) {
      console.log(`[409-retry] Aucun horaire pour ${altDate.date} — date suivante...`);
      continue;
    }

    // Prioriser fenêtre rush (7h-9h)
    const prioritized = timeSlots
      .sort((a, b) => prioritizeRushHour(a.startTime, b.startTime));

    for (const slot of prioritized) {
      if (retriesDone >= MAX_409_RETRIES) break;

      await randomInterStepPause(500, 1200, ctx.jobId);

      const result = await attemptBookSlot(ctx, slot, altDate.date);
      retriesDone++;
      triedSlotIds.add(slot.slotId);

      if (result) {
        console.log(`[409-retry] ✅ Booking réussi sur date alternative ${altDate.date} après ${retriesDone} retry(s)`);
        return result;
      }
    }
  }

  console.log(`[409-retry] ❌ Tous les retries épuisés (${retriesDone} tentatives)`);
  botLog({
    applicationId: ctx.jobId,
    step: "409_retry_exhausted",
    status: "warn",
    data: { ofc: ctx.ofcName, retriesDone, triedSlotIds: [...triedSlotIds] },
  });

  return null;
}

/**
 * Récupère les créneaux horaires pour une date donnée.
 */
async function fetchTimeSlotsForDate(ctx: Retry409Context, date: string): Promise<UsaTimeSlot[] | null> {
  try {
    const payload = {
      fromDate: ctx.fromDate,
      toDate: ctx.toDate,
      postUserId: ctx.basePayload.postUserId,
      applicantId: ctx.basePayload.applicantId,
      slotDate: date,
      visaType: ctx.basePayload.visaType,
      visaClass: ctx.basePayload.visaClass,
      applicationId: ctx.basePayload.applicationId,
    };

    const res = await usaFetch(USA_SLOT_TIMES_URL, {
      method: "POST",
      headers: ctx.slotHeaders,
      body: JSON.stringify(payload),
    });

    if (res.status === 429) throw new RateLimitError("getSlotTime(409retry)", parseInt(res.headers.get("retry-after") ?? "60", 10) * 1000);
    if (res.status === 403) throw new AccountBlockedError("getSlotTime(409retry)");
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError();
      throw new TokenExpiredError();
    }
    if (!res.ok) return null;

    const raw = await res.json();
    return Array.isArray(raw) ? raw as UsaTimeSlot[] : [];
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[409-retry] Erreur récupération slots pour ${date}: ${err}`);
    return null;
  }
}

/**
 * Tente un booking pour un slot spécifique.
 * Retourne le SlotFound + BookingResult si réussi, null si 409 ou échec.
 */
async function attemptBookSlot(
  ctx: Retry409Context,
  slot: UsaTimeSlot,
  date: string,
): Promise<(SlotFound & { bookingResult: UsaBookingResult }) | null> {
  const rawTime = slot.startTime ?? "";
  const time = rawTime.includes("T") ? rawTime.split("T")[1].slice(0, 5) : rawTime.slice(0, 5);
  const slotDate = (slot as Record<string, unknown>).slotDate as string | undefined ?? date;

  console.log(`[409-retry] Tentative: ${date} ${time} (slotId=${slot.slotId})`);

  const found: SlotFound = {
    date,
    time,
    slotId: slot.slotId,
    ofcName: ctx.ofcName,
    slot,
    bookingBase: ctx.basePayload,
  };

  let booking: UsaBookingResult;
  try {
    booking = ctx.isReschedule
      ? await rescheduleUsaSlot(ctx.session, found)
      : await bookUsaSlot(ctx.session, found);
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[409-retry] Erreur booking: ${err}`);
    return null;
  }

  if (booking.success) {
    botLog({
      applicationId: ctx.jobId,
      step: "409_retry_success",
      status: "ok",
      data: { ofc: ctx.ofcName, date, time, slotId: slot.slotId, appointmentId: booking.appointmentId },
    });
    return { ...found, bookingResult: booking };
  }

  if (booking.statusCode === 409) {
    console.log(`[409-retry] Encore un 409 sur slotId=${slot.slotId} — slot suivant...`);
    return null;
  }

  // Autre erreur (502, etc.) — ne pas continuer les retries, c'est un problème serveur
  console.warn(`[409-retry] Erreur non-409 (HTTP ${booking.statusCode}): ${booking.error} — arrêt retries`);
  return null;
}

/**
 * Prioritise les slots dans la fenêtre rush (7h00-9h00).
 * Les slots dans la fenêtre sont triés en premier, les autres après.
 */
function prioritizeRushHour(timeA: string, timeB: string): number {
  const inRushA = isInRushWindow(timeA);
  const inRushB = isInRushWindow(timeB);

  if (inRushA && !inRushB) return -1;
  if (!inRushA && inRushB) return 1;
  // Les deux sont dans la même catégorie — trier par heure
  return extractTimeMinutes(timeA) - extractTimeMinutes(timeB);
}

function isInRushWindow(time: string): boolean {
  const minutes = extractTimeMinutes(time);
  const rushStart = 7 * 60; // 7h00
  const rushEnd = 9 * 60;   // 9h00
  return minutes >= rushStart && minutes < rushEnd;
}

function extractTimeMinutes(time: string): number {
  const clean = time.includes("T") ? time.split("T")[1].slice(0, 5) : time.slice(0, 5);
  const [h, m] = clean.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
