/**
 * Recherche du premier créneau disponible pour un OFC (mois → dates → heures).
 *
 * V3 : Intégration scan multi-mois via scanMultipleMonths().
 * Après getFirstAvailableMonth, la navigation multi-mois prend le relais
 * (itère getSlotDates + getSlotTime sur max N mois consécutifs).
 */
import type { UsaSession } from "./types.js";
import type { SlotDiscoveryEvent } from "../convexClient.js";
import type {
  UsaOfc,
  UsaAppDetails,
  UsaFirstAvailableMonthResponse,
  UsaSlotDate,
  UsaTimeSlot,
  SlotFound,
} from "./usa-scan-types.js";
import { toYMD, lastDayOfMonth } from "./usa-scan-types.js";
import {
  USA_FIRST_AVAILABLE_MONTH_URL,
  USA_SLOT_DATES_URL,
  USA_SLOT_TIMES_URL,
  REFERER_CREATE_APT,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { usaFetch, authHeaders, sessionHeaders } from "./usa-http.js";
import { scanMultipleMonths } from "../v3/scan/scan-months.js";

export async function findFirstSlotForOfc(
  session: UsaSession,
  ofc: UsaOfc,
  appDetails: UsaAppDetails,
  dateFrom?: string,
  dateDeadline?: string,
  rescheduleYN?: boolean,
  referer?: string,
  discoveryEvents?: SlotDiscoveryEvent[]
): Promise<SlotFound | null> {
  const basePayload: Record<string, unknown> = {
    postUserId: ofc.postUserId,
    applicantId: appDetails.applicantId,
    // visaType dans les payloads slot : utiliser visaTypeKey ("NIV") si disponible, sinon visaType
    // Le portail Angular envoie visaTypekey (ex: "NIV") dans getFirstAvailableMonth/getSlotDates/getSlotTime
    visaType: (appDetails as unknown as Record<string, unknown>).visaTypeKey ?? appDetails.visaType,
    visaClass: appDetails.visaClass,
    // locationType : déterminé par le portail Angular via this.ofcOrPost.
    // Capture réseau 13/05/2026 (nouveau booking Baze, compte sabowaryan@gmail.com) :
    //   Le navigateur envoie locationType: "POST" pour Kinshasa (officeType="POST") → 200 OK.
    // Le bot envoyait "POST" aussi mais recevait 404 "applicant not found" — la différence
    // venait des COOKIES (APP_ID_TOBE/missionId) qui perturbaient la résolution côté serveur.
    // Fix : ne PAS envoyer les cookies de session pour getFirstAvailableMonth (voir hdrs ci-dessous).
    //
    // En mode reschedule, le portail utilise l'appointmentLocationType du RDV existant (ex: "POST").
    locationType: rescheduleYN
      ? (appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
      : (ofc.officeType ?? "OFC"),
    applicationId: appDetails.applicationId,
  };
  // Bundle Angular : applicationDetails.applicantUUID est inclus dans le payload de booking
  if (appDetails.applicantUUID) basePayload.applicantUUID = appDetails.applicantUUID;
  // Capture réseau 13/05/2026 : en mode reschedule, le payload NE contient PAS rescheduleYN.
  // Seuls 6 champs : postUserId, applicantId, visaType, visaClass, locationType, applicationId.
  // Le champ applicantUUID n'est PAS dans le payload de slot non plus (seulement dans le booking).

  // Referer en mode reschedule : URL dynamique avec les paramètres du RDV existant.
  // Capture réseau : /home/appointment/slot?type=POST&appUUID=xxx&applicantId=RQUP3HHVQHOD&ofcAppointmentDate=
  // En mode normal : /home/dashboard/create-appointment
  let slotReferer: string;
  if (rescheduleYN && session.appointmentUUID) {
    const locType = appDetails.appointmentLocationType ?? ofc.officeType ?? "POST";
    const appUUID = session.appointmentUUID;
    const applId = typeof appDetails.applicantId === "string" ? appDetails.applicantId : String(appDetails.applicantId);
    slotReferer = `https://www.usvisaappt.com/visaapplicantui/home/appointment/slot?type=${locType}&appUUID=${appUUID}&applicantId=${applId}&ofcAppointmentDate=`;
  } else {
    slotReferer = referer ?? REFERER_CREATE_APT;
  }

  // Capture réseau 13/05/2026 : en mode reschedule, PAS de cookies APP_ID_TOBE/missionId.
  // Le portail n'envoie que les cookies GA. Seul le Bearer token authentifie la requête.
  // IMPORTANT: Capture 13/05/2026 (nouveau booking Baze) confirme que le navigateur
  // N'ENVOIE PAS non plus APP_ID_TOBE/missionId pour un nouveau booking !
  // Le serveur retourne 404 "applicant not found" quand ces cookies sont présents
  // car ils perturbent la résolution de l'applicant côté serveur.
  // → Utiliser authHeaders (Bearer seulement) pour TOUS les modes de getFirstAvailableMonth/getSlotDates/getSlotTime.
  const hdrs = authHeaders(session.accessToken, slotReferer, true);

  /**
   * Vérifie le status HTTP et lève une erreur circuit-breaker si critique.
   * 429 → RateLimitError, 403 → AccountBlockedError,
   * 401 restricted → AccountRestrictedError, 401 autre → TokenExpiredError.
   * Retourne false si le statut est une erreur non-critique (scan de cet OFC abandonne).
   */
  async function checkSlotResponse(res: Response, endpoint: string): Promise<boolean> {
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
      console.error(`[usa] ⛔ RATE LIMIT (429) sur ${endpoint} — abandon scan complet`);
      throw new RateLimitError(endpoint, retryAfter * 1000);
    }
    if (res.status === 403) {
      console.error(`[usa] ⛔ ACCÈS REFUSÉ (403) sur ${endpoint} — compte potentiellement bloqué`);
      throw new AccountBlockedError(endpoint);
    }
    if (res.status === 401) {
      const body401 = await res.text().catch(() => "");
      if (isRestrictedBody(body401)) {
        console.error(`[usa] ⛔ COMPTE RESTREINT (401) sur ${endpoint} — pause avec backoff exponentiel`);
        throw new AccountRestrictedError(undefined, undefined);
      }
      console.error(`[usa] ⛔ TOKEN EXPIRÉ (401) sur ${endpoint} — arrêt scan`);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.log(`[usa] ${endpoint} HTTP ${res.status} pour OFC ${ofc.postName} — body: ${errBody.slice(0, 300)}`);
      return false;
    }
    return true;
  }

  // 1. Premier mois disponible
  let firstMonth: UsaFirstAvailableMonthResponse;
  try {
    const res = await usaFetch(USA_FIRST_AVAILABLE_MONTH_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(basePayload),
    });
    if (!await checkSlotResponse(res, "getFirstAvailableMonth")) return null;
    firstMonth = await res.json() as UsaFirstAvailableMonthResponse;
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] getFirstAvailableMonth erreur: ${err}`);
    return null;
  }

  if (!firstMonth.present || !firstMonth.date) {
    console.log(`[usa] Aucun créneau disponible pour OFC ${ofc.postName}`);
    return null;
  }

  console.log(`[usa] 📅 Premier mois disponible pour ${ofc.postName}: ${firstMonth.date}`);

  // Vérification immédiate : si le premier mois disponible dépasse la date limite, inutile de continuer
  if (dateDeadline && firstMonth.date > dateDeadline) {
    console.log(`[usa] ⏭ OFC ${ofc.postName} IGNORÉ — premier mois (${firstMonth.date}) après date limite (${dateDeadline})`);
    console.log(`[usa] 📊 [DISCOVERY] Date captée: ${firstMonth.date} | Statut: IGNORÉE | Raison: après deadline (${dateDeadline})`);
    // Enregistrer l'événement de découverte
    discoveryEvents?.push({
      applicationId: appDetails.applicationId,
      destination: "usa",
      office: ofc.postName,
      dateFound: firstMonth.date.split("T")[0],
      outcome: "ignored",
      reason: "after_deadline",
      context: { deadline: dateDeadline, firstAvailableMonth: firstMonth.date },
      mode: rescheduleYN ? "reschedule" : "schedule",
    });
    return null;
  }

  // ── V3 : Scan multi-mois (remplace la logique mono-mois V2) ────────────────
  // Itère getSlotDates + getSlotTime sur max 3 mois consécutifs avec pause humaine.
  // Toutes les dates découvertes sont reportées dans discoveryEvents.
  return scanMultipleMonths({
    basePayload: basePayload as Record<string, unknown>,
    headers: hdrs,
    firstMonthDate: firstMonth.date,
    dateFrom,
    dateDeadline,
    ofcName: ofc.postName,
    rescheduleMode: rescheduleYN,
    applicationId: appDetails.applicationId,
    maxMonths: 3, // TODO: lire depuis hunterConfig.maxMonthsToScan
    discoveryEvents,
  });
}
