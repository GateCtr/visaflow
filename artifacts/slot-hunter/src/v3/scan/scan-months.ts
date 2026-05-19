/**
 * Scan Multi-Mois — Navigation calendrier comme un humain.
 *
 * PROBLÈME RÉSOLU :
 *   Le code V2 (usa-scan-find.ts) ne scanne QU'UN seul mois (le premier retourné
 *   par getFirstAvailableMonth). Si ce mois a des dates hors fenêtre admin mais que
 *   le mois SUIVANT en a → elles sont ratées.
 *
 * SOLUTION :
 *   Après getFirstAvailableMonth, itérer getSlotDates mois par mois (comme un humain
 *   qui clique la flèche ">" sur le calendrier Angular). Arrêter dès qu'un slot est
 *   trouvé OU que le maxMonths est atteint OU que dateDeadline est dépassée.
 *
 * FLOW :
 *   1. getFirstAvailableMonth → premier mois dispo (ex: 2026-09)
 *   2. getSlotDates(mois 1) → dates[] → filtre fenêtre → getSlotTime si match
 *   3. Si pas de slot ce mois → pause 1-3s → getSlotDates(mois 2) → idem
 *   4. Répéter jusqu'à maxMonths (défaut: 3) ou slot trouvé
 *
 * ANTI-DÉTECTION :
 *   - Pause gaussienne 1-3s entre chaque navigation de mois (simule clic flèche)
 *   - Toutes les dates découvertes sont reportées dans discoveryEvents (même hors fenêtre)
 *   - Max 3 mois par session par défaut (configurable admin via maxMonthsToScan)
 *
 * INTÉGRATION :
 *   Ce module REMPLACE la logique "scan 1 mois" de findFirstSlotForOfc().
 *   Il est appelé à la place, avec la même signature de retour (SlotFound | null).
 *   Il réutilise les mêmes helpers (checkSlotResponse, basePayload, hdrs) via params.
 */

import type { SlotDiscoveryEvent } from "../../convexClient.js";
import type { UsaSlotDate, UsaTimeSlot, SlotFound } from "../../usaPortal/usa-scan-types.js";
import { toYMD, lastDayOfMonth } from "../../usaPortal/usa-scan-types.js";
import { USA_SLOT_DATES_URL, USA_SLOT_TIMES_URL } from "../../usaPortal/config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "../../usaPortal/errors.js";
import { isRestrictedBody } from "../../usaPortal/account-restriction.js";
import { usaFetch } from "../../usaPortal/usa-http.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration pour le scan multi-mois. */
export interface MultiMonthScanConfig {
  /** Payload de base pour les requêtes slot (postUserId, applicantId, visaType, etc.) */
  basePayload: Record<string, unknown>;
  /** Headers HTTP (Bearer token + referer). */
  headers: Record<string, string>;
  /** Premier mois détecté par getFirstAvailableMonth (YYYY-MM-DD). */
  firstMonthDate: string;
  /** Date minimum admin (optionnel). */
  dateFrom?: string;
  /** Date limite admin (optionnel). */
  dateDeadline?: string;
  /** Nom de l'OFC (pour les logs). */
  ofcName: string;
  /** Mode reschedule ? */
  rescheduleMode?: boolean;
  /** applicationId du dossier (pour discovery events). */
  applicationId: string;
  /** Nombre max de mois à scanner (défaut: 3). */
  maxMonths?: number;
  /** Collecteur d'événements de découverte. */
  discoveryEvents?: SlotDiscoveryEvent[];
}

/** Résultat du scan d'un mois individuel. */
interface MonthScanResult {
  /** Slot trouvé (null si aucun dans ce mois). */
  slotFound: SlotFound | null;
  /** Toutes les dates disponibles découvertes ce mois (pour discovery). */
  datesDiscovered: string[];
  /** Dates dans la fenêtre admin mais sans horaires disponibles. */
  datesNoTimeSlots: string[];
  /** Erreur critique levée (propagée à l'appelant). */
  criticalError?: Error;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Pause gaussienne entre 1 et 3 secondes (simule clic flèche calendrier). */
function humanMonthNavigationPause(): Promise<void> {
  // Box-Muller pour distribution naturelle centrée sur 2s
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = Math.max(1000, Math.min(3000, 2000 + z * 500));
  return new Promise(r => setTimeout(r, ms));
}

/** Calcule le premier jour du mois suivant. */
function nextMonthStart(currentMonthDate: string): Date {
  const d = new Date(currentMonthDate);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/** Vérifie les réponses HTTP (lève les erreurs circuit-breaker). */
async function checkResponse(res: Response, endpoint: string, ofcName: string): Promise<boolean> {
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    throw new RateLimitError(endpoint, retryAfter * 1000);
  }
  if (res.status === 403) {
    throw new AccountBlockedError(endpoint);
  }
  if (res.status === 401) {
    const body = await res.text().catch(() => "");
    if (isRestrictedBody(body)) throw new AccountRestrictedError(undefined, undefined);
    throw new TokenExpiredError();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.log(`[scan-months] ${endpoint} HTTP ${res.status} pour ${ofcName} — ${body.slice(0, 200)}`);
    return false;
  }
  return true;
}

/** Parse adaptatif de getSlotDates (format objet ou string ISO).
 * FIX #3: Also validates response structure to detect soft-ban honeypots. */
function parseSlotDatesResponse(raw: unknown, ofcName?: string): UsaSlotDate[] {
  // FIX #3: Detect honeypot responses (non-array payloads that shouldn't happen)
  if (raw === null || raw === undefined) {
    console.warn(`[scan-months] ⚠️ SOFT-BAN? getSlotDates retourné null/undefined pour ${ofcName ?? "?"}`);
    return [];
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    // Object instead of array = probable Akamai challenge page parsed as JSON
    console.warn(`[scan-months] ⚠️ SOFT-BAN? getSlotDates retourné un objet au lieu d'un array pour ${ofcName ?? "?"}: ${JSON.stringify(raw).slice(0, 100)}`);
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) return [];

  if (typeof raw[0] === "string") {
    // Format reschedule : ["2026-09-04T00:00:00.000+00:00", ...]
    return (raw as string[]).map(dateStr => ({
      date: dateStr.split("T")[0],
      slotsAvailable: 1,
    }));
  }
  // Format schedule : [{date: "2026-09-04", slotsAvailable: 3}, ...]
  return raw as UsaSlotDate[];
}

// ─── Scan d'un mois individuel ──────────────────────────────────────────────

async function scanSingleMonth(
  config: MultiMonthScanConfig,
  monthDate: Date,
): Promise<MonthScanResult> {
  const { basePayload, headers, dateFrom, dateDeadline, ofcName, applicationId, rescheduleMode, discoveryEvents } = config;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  // fromDate = max(demain, début du mois, dateFrom admin)
  let fromDate = monthDate > tomorrow ? toYMD(monthDate) : toYMD(tomorrow);
  if (dateFrom && dateFrom > fromDate) fromDate = dateFrom;

  // toDate = fin du mois (plafonné à dateDeadline)
  let toDate = lastDayOfMonth(monthDate);
  if (dateDeadline && dateDeadline < toDate) toDate = dateDeadline;

  // Si fromDate > toDate → aucun créneau possible ce mois
  if (fromDate > toDate) {
    return { slotFound: null, datesDiscovered: [], datesNoTimeSlots: [] };
  }

  // ── getSlotDates ──
  let slotDates: UsaSlotDate[];
  try {
    const res = await usaFetch(USA_SLOT_DATES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...basePayload, fromDate, toDate }),
    });
    if (!await checkResponse(res, "getSlotDates", ofcName)) {
      return { slotFound: null, datesDiscovered: [], datesNoTimeSlots: [] };
    }
    slotDates = parseSlotDatesResponse(await res.json(), ofcName);
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) {
      return { slotFound: null, datesDiscovered: [], datesNoTimeSlots: [], criticalError: err as Error };
    }
    console.warn(`[scan-months] getSlotDates erreur mois ${toYMD(monthDate)}: ${err}`);
    return { slotFound: null, datesDiscovered: [], datesNoTimeSlots: [] };
  }

  // Toutes les dates brutes (pour discovery — même hors fenêtre)
  const allDatesRaw = slotDates.map(d => d.date);

  // Filtrer dans la fenêtre admin
  const filteredDates = slotDates.filter(d => {
    if (dateFrom && d.date < dateFrom) return false;
    if (dateDeadline && d.date > dateDeadline) return false;
    return true;
  });

  // Reporter les dates ignorées dans discovery
  const ignoredDates = slotDates.filter(d => !filteredDates.includes(d));
  for (const ignored of ignoredDates) {
    const reason = (dateFrom && ignored.date < dateFrom) ? "before_from_date" : "after_deadline";
    discoveryEvents?.push({
      applicationId,
      destination: "usa",
      office: ofcName,
      dateFound: ignored.date.split("T")[0],
      outcome: "ignored",
      reason,
      context: { dateFrom, dateDeadline, month: toYMD(monthDate) },
      mode: rescheduleMode ? "reschedule" : "schedule",
    });
  }

  if (filteredDates.length === 0) {
    console.log(`[scan-months] Mois ${toYMD(monthDate)} — ${allDatesRaw.length} dates brutes, 0 dans fenêtre`);
    return { slotFound: null, datesDiscovered: allDatesRaw, datesNoTimeSlots: [] };
  }

  console.log(`[scan-months] Mois ${toYMD(monthDate)} — ${filteredDates.length} date(s) dans fenêtre: ${filteredDates.slice(0, 3).map(d => d.date).join(", ")}`);

  // ── getSlotTime sur la première date dans la fenêtre ──
  const targetDate = filteredDates[0].date;
  let timeSlots: UsaTimeSlot[];
  try {
    const slotTimePayload = {
      fromDate,
      toDate,
      postUserId: basePayload.postUserId,
      applicantId: basePayload.applicantId,
      slotDate: targetDate,
      visaType: basePayload.visaType,
      visaClass: basePayload.visaClass,
      applicationId: basePayload.applicationId,
      // PAS de locationType dans getSlotTime (confirmé par captures réseau)
    };
    const res = await usaFetch(USA_SLOT_TIMES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(slotTimePayload),
    });
    if (!await checkResponse(res, "getSlotTime", ofcName)) {
      return { slotFound: null, datesDiscovered: allDatesRaw, datesNoTimeSlots: [targetDate] };
    }
    const raw = await res.json();
    timeSlots = Array.isArray(raw) ? raw as UsaTimeSlot[] : [];
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) {
      return { slotFound: null, datesDiscovered: allDatesRaw, datesNoTimeSlots: [], criticalError: err as Error };
    }
    console.warn(`[scan-months] getSlotTime erreur ${targetDate}: ${err}`);
    return { slotFound: null, datesDiscovered: allDatesRaw, datesNoTimeSlots: [targetDate] };
  }

  if (timeSlots.length === 0) {
    console.log(`[scan-months] ${targetDate} — aucun horaire disponible`);
    discoveryEvents?.push({
      applicationId,
      destination: "usa",
      office: ofcName,
      dateFound: targetDate,
      outcome: "ignored",
      reason: "no_time_slots",
      context: { month: toYMD(monthDate) },
      mode: rescheduleMode ? "reschedule" : "schedule",
    });
    return { slotFound: null, datesDiscovered: allDatesRaw, datesNoTimeSlots: [targetDate] };
  }

  // ── SLOT TROUVÉ ──
  const slot = timeSlots[0];
  const rawTime = slot.startTime ?? "";
  const time = rawTime.includes("T") ? rawTime.split("T")[1].slice(0, 5) : rawTime.slice(0, 5);

  console.log(`[scan-months] 🎯 CRÉNEAU — ${ofcName} le ${targetDate} à ${time} (slotId=${slot.slotId})`);

  discoveryEvents?.push({
    applicationId,
    destination: "usa",
    office: ofcName,
    dateFound: targetDate,
    timeFound: time,
    outcome: "captured",
    context: { slotId: slot.slotId, totalTimeSlots: timeSlots.length, month: toYMD(monthDate) },
    mode: rescheduleMode ? "reschedule" : "schedule",
  });

  return {
    slotFound: {
      date: targetDate,
      time,
      slotId: slot.slotId,
      ofcName,
      slot,
      bookingBase: basePayload,
    },
    datesDiscovered: allDatesRaw,
    datesNoTimeSlots: [],
  };
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Scanne plusieurs mois consécutifs à partir du premier mois disponible.
 * Retourne le premier slot trouvé dans la fenêtre admin, ou null.
 *
 * Simule la navigation humaine (pause 1-3s entre les mois).
 * Reporte TOUTES les dates découvertes dans discoveryEvents (enrichissement calendrier).
 */
export async function scanMultipleMonths(config: MultiMonthScanConfig): Promise<SlotFound | null> {
  const maxMonths = config.maxMonths ?? 3;
  const { firstMonthDate, dateDeadline, ofcName } = config;

  let currentMonthDate = new Date(firstMonthDate);
  currentMonthDate.setDate(1); // Normaliser au 1er du mois

  console.log(`[scan-months] 📅 Début scan multi-mois pour ${ofcName} — max ${maxMonths} mois à partir de ${toYMD(currentMonthDate)}`);

  for (let monthIdx = 0; monthIdx < maxMonths; monthIdx++) {
    const monthLabel = toYMD(currentMonthDate);

    // Vérifier si ce mois dépasse la deadline
    if (dateDeadline) {
      const monthStart = toYMD(currentMonthDate);
      if (monthStart > dateDeadline) {
        console.log(`[scan-months] ⏭ Mois ${monthLabel} après deadline (${dateDeadline}) — arrêt`);
        break;
      }
    }

    // Scanner ce mois
    const result = await scanSingleMonth(config, currentMonthDate);

    // Erreur critique → propager
    if (result.criticalError) {
      throw result.criticalError;
    }

    // Slot trouvé → retourner
    if (result.slotFound) {
      console.log(`[scan-months] ✅ Slot trouvé au mois #${monthIdx + 1} (${monthLabel})`);
      return result.slotFound;
    }

    // Pas de slot ce mois → naviguer au mois suivant
    if (monthIdx < maxMonths - 1) {
      console.log(`[scan-months] ➡️ Mois ${monthLabel}: ${result.datesDiscovered.length} dates brutes, 0 slot — navigation mois suivant...`);
      // Pause humaine (simule clic flèche ">" sur le calendrier)
      await humanMonthNavigationPause();
    }

    // Avancer au mois suivant
    currentMonthDate = nextMonthStart(toYMD(currentMonthDate));
  }

  console.log(`[scan-months] 📅 Fin scan multi-mois pour ${ofcName} — aucun slot trouvé en ${maxMonths} mois`);
  return null;
}
