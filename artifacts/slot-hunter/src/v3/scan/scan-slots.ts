/**
 * Scan Slots V3 — Wrapper haut-niveau coordonnant scan-months + orchestrator.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Itérer sur la liste d'OFCs, appeler scanMultipleMonths pour chacun,
 *   enrichir les discovery events, et retourner le premier slot trouvé.
 *   Respecte les décisions de l'orchestrator (intervalle, burst, skip confiné).
 *
 * FLOW :
 *   1. Pour chaque OFC de la liste :
 *      a. getFirstAvailableMonth → premier mois dispo
 *      b. scanMultipleMonths(config) → SlotFound | null
 *      c. Si slot → return
 *      d. Sinon → pause anti-détection → OFC suivant
 *   2. Reporter discovery batch en fin de scan
 *
 * INTÉGRATION :
 *   Appelé par scan-session.ts après le preflight.
 *   Utilise les données du PreflightResult (appDetails, ofcList).
 */

import type { UsaOfc, UsaAppDetails, SlotFound } from "../../usaPortal/usa-scan-types.js";
import type { SlotDiscoveryEvent } from "../../convexClient.js";
import type { UsaSession } from "../../usaPortal/types.js";
import { USA_FIRST_AVAILABLE_MONTH_URL, REFERER_CREATE_APT } from "../../usaPortal/config.js";
import { usaFetch, authHeaders } from "../../usaPortal/usa-http.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "../../usaPortal/errors.js";
import { isRestrictedBody } from "../../usaPortal/account-restriction.js";
import { scanMultipleMonths, type MultiMonthScanConfig } from "./scan-months.js";
import { interStepPause, maybeDistraction } from "../anti-detection/human-timing.js";
import { pickNextEndpoint, resetAlternation } from "../anti-detection/stealth-alternation.js";
import { isRushHour } from "../core/session-pool.js";
import { broadcastSlotDiscovery, type SlotBroadcastEvent } from "../booking/booking-blind.js";
import { formatUItime } from "../booking/booking-payload.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration pour le scan de slots. */
export interface ScanSlotsConfig {
  /** Session active avec token valide. */
  session: UsaSession;
  /** Détails de l'applicant (depuis preflight). */
  appDetails: UsaAppDetails;
  /** Liste des OFCs à scanner. */
  ofcList: UsaOfc[];
  /** applicationId du dossier. */
  applicationId: string;
  /** Date minimum admin. */
  dateFrom?: string;
  /** Date limite admin. */
  dateDeadline?: string;
  /** Mode reschedule ? */
  rescheduleMode?: boolean;
  /** Nombre max de mois à scanner par OFC (défaut: 3). */
  maxMonthsToScan?: number;
  /** Username (pour l'alternance anti-détection). */
  username: string;
  /** Rôle du compte (pour décider du broadcast). */
  accountRole?: "eclaireur" | "confine" | "hybride";
  /** Blind booking activé (éclaireur → broadcast). */
  blindBookingEnabled?: boolean;
  /** Convex URL (pour le broadcast). */
  convexSiteUrl?: string;
  /** Hunter API key (pour le broadcast). */
  hunterApiKey?: string;
}

/** Résultat du scan de slots. */
export interface ScanSlotsResult {
  /** Slot trouvé (null si aucun). */
  slotFound: SlotFound | null;
  /** Événements discovery collectés pendant le scan. */
  discoveryEvents: SlotDiscoveryEvent[];
  /** Nombre d'OFCs scannés. */
  ofcsScanned: number;
  /** Nombre de mois scannés au total. */
  totalMonthsScanned: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface FirstAvailableResult {
  present: boolean;
  date: string;
}

async function getFirstAvailableMonth(
  session: UsaSession,
  ofc: UsaOfc,
  appDetails: UsaAppDetails,
  rescheduleMode?: boolean,
): Promise<FirstAvailableResult | null> {
  const payload: Record<string, unknown> = {
    postUserId: ofc.postUserId,
    applicantId: appDetails.applicantId,
    visaType: appDetails.visaTypeKey ?? appDetails.visaType,
    visaClass: appDetails.visaClass,
    locationType: rescheduleMode
      ? (appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
      : (ofc.officeType ?? "OFC"),
    applicationId: appDetails.applicationId,
  };

  const hdrs = authHeaders(session.accessToken, REFERER_CREATE_APT, true);

  try {
    const res = await usaFetch(USA_FIRST_AVAILABLE_MONTH_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(payload),
    });

    if (res.status === 429) throw new RateLimitError("getFirstAvailableMonth", 60_000);
    if (res.status === 403) throw new AccountBlockedError("getFirstAvailableMonth");
    if (res.status === 401) {
      const body = await res.text().catch(() => "");
      if (isRestrictedBody(body)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      console.log(`[scan-slots] getFirstAvailableMonth HTTP ${res.status} pour ${ofc.postName}`);
      return null;
    }

    return await res.json() as FirstAvailableResult;
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[scan-slots] getFirstAvailableMonth erreur pour ${ofc.postName}: ${err}`);
    return null;
  }
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Scanne tous les OFCs de la liste et retourne le premier slot trouvé.
 *
 * Pour chaque OFC :
 *   1. Stealth alternation (1/3 du temps → skip et faire un landing page call)
 *   2. getFirstAvailableMonth
 *   3. Si present → scanMultipleMonths (navigation calendrier)
 *   4. Discovery events collectés tout au long
 *
 * Lève les erreurs circuit-breaker si critique.
 */
export async function scanAllOfcs(config: ScanSlotsConfig): Promise<ScanSlotsResult> {
  const {
    session, appDetails, ofcList, applicationId,
    dateFrom, dateDeadline, rescheduleMode,
    maxMonthsToScan, username,
  } = config;

  const discoveryEvents: SlotDiscoveryEvent[] = [];
  let ofcsScanned = 0;
  let totalMonthsScanned = 0;

  // Reset l'alternance pour ce cycle de scan
  resetAlternation(username);

  for (const ofc of ofcList) {
    // ── Stealth alternation : 1/3 du temps → skip (simule navigation dashboard) ──
    const endpoint = pickNextEndpoint(username);
    if (endpoint === "landingPage") {
      // Simuler un appel landing page (déjà fait dans le keep-alive, on skip juste)
      console.log(`[scan-slots] 🔀 Alternation: skip ${ofc.postName} (landing page cycle)`);
      await interStepPause();
      continue;
    }

    // ── Distraction aléatoire (5% hors rush) ──
    await maybeDistraction(isRushHour());

    // ── getFirstAvailableMonth ──
    const firstMonth = await getFirstAvailableMonth(session, ofc, appDetails, rescheduleMode);

    if (!firstMonth || !firstMonth.present) {
      console.log(`[scan-slots] ${ofc.postName}: pas de mois disponible`);
      discoveryEvents.push({
        applicationId,
        destination: "usa",
        office: ofc.postName,
        dateFound: "",
        outcome: "ignored",
        reason: "no_month_available",
        mode: rescheduleMode ? "reschedule" : "schedule",
      });
      await interStepPause();
      continue;
    }

    console.log(`[scan-slots] ${ofc.postName}: premier mois dispo = ${firstMonth.date}`);
    ofcsScanned++;

    // ── Scan multi-mois ──
    const scanConfig: MultiMonthScanConfig = {
      basePayload: {
        postUserId: ofc.postUserId,
        applicantId: appDetails.applicantId,
        visaType: appDetails.visaTypeKey ?? appDetails.visaType,
        visaClass: appDetails.visaClass,
        locationType: rescheduleMode
          ? (appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
          : (ofc.officeType ?? "OFC"),
        applicationId: appDetails.applicationId,
      },
      headers: authHeaders(session.accessToken, REFERER_CREATE_APT, true),
      firstMonthDate: firstMonth.date,
      dateFrom,
      dateDeadline,
      ofcName: ofc.postName,
      rescheduleMode,
      applicationId,
      maxMonths: maxMonthsToScan ?? 3,
      discoveryEvents,
    };

    const slotFound = await scanMultipleMonths(scanConfig);
    totalMonthsScanned += (maxMonthsToScan ?? 3); // Approximation

    if (slotFound) {
      console.log(`[scan-slots] 🎯 SLOT TROUVÉ — ${ofc.postName} ${slotFound.date} ${slotFound.time}`);

      // Si éclaireur + blind booking → broadcast aux confinés
      if (config.accountRole === "eclaireur" && config.blindBookingEnabled && config.convexSiteUrl && config.hunterApiKey) {
        const broadcastEvent: SlotBroadcastEvent = {
          sourceUsername: username,
          office: ofc.postName,
          postUserId: ofc.postUserId,
          date: slotFound.date,
          time: slotFound.time,
          slotId: String(slotFound.slotId),
          startTime: slotFound.slot.startTime ?? "",
          discoveredAt: Date.now(),
          sourceBooked: false,
        };
        broadcastSlotDiscovery(broadcastEvent, config.convexSiteUrl, config.hunterApiKey);
        console.log(`[scan-slots] 📡 Slot broadcasté aux confinés`);
      }

      return { slotFound, discoveryEvents, ofcsScanned, totalMonthsScanned };
    }

    // Pause entre OFCs
    await interStepPause();
  }

  console.log(`[scan-slots] Fin scan — ${ofcsScanned} OFC(s) scannés, aucun slot`);
  return { slotFound: null, discoveryEvents, ofcsScanned, totalMonthsScanned };
}
