/**
 * Recherche du premier créneau disponible pour un OFC (mois → dates → heures).
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

  // 2. Dates disponibles dans ce mois
  const monthStart = new Date(firstMonth.date);
  monthStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  // fromDate = max(demain, début du mois, date minimum admin si définie)
  let fromDate = monthStart > tomorrow ? toYMD(monthStart) : toYMD(tomorrow);
  if (dateFrom && dateFrom > fromDate) {
    console.log(`[usa] 📅 Date minimum admin appliquée : ${dateFrom} (remplace ${fromDate})`);
    fromDate = dateFrom;
  }

  // toDate = fin du mois (plafonné à dateDeadline si définie)
  let toDate = lastDayOfMonth(monthStart);
  if (dateDeadline && dateDeadline < toDate) {
    toDate = dateDeadline;
    console.log(`[usa] 📅 Date limite admin appliquée : toDate → ${toDate}`);
  }

  // Si fromDate dépasse toDate après application des filtres, aucun créneau possible ce mois
  if (fromDate > toDate) {
    console.log(`[usa] Aucune date dans la fenêtre autorisée pour ${ofc.postName} (${fromDate} → ${toDate})`);
    return null;
  }

  let slotDates: UsaSlotDate[];
  try {
    const res = await usaFetch(USA_SLOT_DATES_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ ...basePayload, fromDate, toDate }),
    });
    if (!await checkSlotResponse(res, "getSlotDates")) return null;
    const raw = await res.json();
    // Parsing adaptatif : le portail peut retourner deux formats selon le mode :
    //   A) Tableau d'objets : [{date: "...", slotsAvailable: N}] (nouveau booking)
    //   B) Tableau de strings ISO : ["2026-09-04T00:00:00.000+00:00", ...] (reschedule)
    // Capture réseau 13/05/2026 : format B confirmé en mode reschedule.
    if (Array.isArray(raw) && raw.length > 0) {
      if (typeof raw[0] === "string") {
        // Format B : tableau de strings ISO → convertir en UsaSlotDate[]
        slotDates = (raw as string[]).map(dateStr => ({
          date: dateStr.split("T")[0],  // "2026-09-04T00:00:00.000+00:00" → "2026-09-04"
          slotsAvailable: 1,            // au moins 1 créneau disponible (le serveur ne donne pas le compte)
        }));
        console.log(`[usa] getSlotDates: format string[] détecté (${slotDates.length} dates) — parsing adaptatif`);
      } else {
        // Format A : tableau d'objets (format historique)
        slotDates = raw as UsaSlotDate[];
      }
    } else {
      slotDates = [];
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] getSlotDates erreur: ${err}`);
    return null;
  }

  // Filtrer les dates hors fenêtre (dateFrom et dateDeadline)
  if (dateFrom || dateDeadline) {
    const before = slotDates.length;
    const ignoredDates: string[] = [];
    slotDates = slotDates.filter(d => {
      if (dateFrom && d.date < dateFrom) {
        ignoredDates.push(d.date);
        return false;
      }
      if (dateDeadline && d.date > dateDeadline) {
        ignoredDates.push(d.date);
        return false;
      }
      return true;
    });
    if (slotDates.length < before) {
      console.log(`[usa] 📊 Filtre fenêtre : ${before - slotDates.length} date(s) hors plage ignorée(s) → ${ignoredDates.join(", ")}`);
      // Enregistrer chaque date ignorée par le filtre de fenêtre
      for (const ignoredDate of ignoredDates) {
        const reason = (dateFrom && ignoredDate < dateFrom) ? "before_from_date" : "after_deadline";
        discoveryEvents?.push({
          applicationId: appDetails.applicationId,
          destination: "usa",
          office: ofc.postName,
          dateFound: ignoredDate.split("T")[0],
          outcome: "ignored",
          reason,
          context: { dateFrom, dateDeadline, window: `${fromDate} → ${toDate}` },
          mode: rescheduleYN ? "reschedule" : "schedule",
        });
      }
    }
  }

  if (slotDates.length === 0) {
    console.log(`[usa] Aucune date disponible pour ${ofc.postName} dans la fenêtre ${fromDate} → ${toDate}`);
    return null;
  }

  console.log(`[usa] 📆 ${slotDates.length} date(s) avec créneaux pour ${ofc.postName}: ${slotDates.slice(0, 3).map(d => d.date).join(", ")}`);
  console.log(`[usa] 📊 [DISCOVERY] ${slotDates.length} date(s) dans la fenêtre pour ${ofc.postName} — vérification horaires...`);
  // 3. Horaires pour la première date disponible
  const targetDate = slotDates[0].date;
  let timeSlots: UsaTimeSlot[];
  try {
    // Bundle Angular (filterSlots) — payload getSlotTime : 8 champs.
    // Source : Oe = {fromDate, toDate, postUserId, applicantId, slotDate, visaType, visaClass, applicationId}
    //
    // DIFFÉRENCES CLÉS vs getSlotDates :
    //   ✅ getSlotTime inclut "slotDate" (la date précise pour laquelle on veut les horaires)
    //   ✅ getSlotTime inclut fromDate et toDate (même fenêtre que getSlotDates)
    //   ❌ getSlotTime N'inclut PAS "locationType" (uniquement dans getSlotDates)
    //
    // Le champ "locationType" est dans getSlotDates via basePayload.locationType = "OFC".
    // Il n'est PAS envoyé dans getSlotTime — différence subtile mais vérifiable côté serveur.
    const slotTimePayload = {
      fromDate,
      toDate,
      postUserId: basePayload.postUserId,
      applicantId: basePayload.applicantId,
      slotDate: targetDate,
      visaType: basePayload.visaType,
      visaClass: basePayload.visaClass,
      applicationId: basePayload.applicationId,
      // NB : pas de "locationType" ici (uniquement dans getSlotDates/getFirstAvailableMonth)
    };
    const res = await usaFetch(USA_SLOT_TIMES_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(slotTimePayload),
    });
    if (!await checkSlotResponse(res, "getSlotTime")) return null;
    const raw = await res.json();
    timeSlots = Array.isArray(raw) ? raw as UsaTimeSlot[] : [];
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] getSlotTime erreur: ${err}`);
    return null;
  }

  if (timeSlots.length === 0) {
    console.log(`[usa] 📊 [DISCOVERY] Date captée: ${targetDate} | Statut: IGNORÉE | Raison: aucun horaire disponible`);
    console.log(`[usa] Aucun horaire disponible pour ${ofc.postName} le ${targetDate}`);
    discoveryEvents?.push({
      applicationId: appDetails.applicationId,
      destination: "usa",
      office: ofc.postName,
      dateFound: targetDate.split("T")[0],
      outcome: "ignored",
      reason: "no_time_slots",
      context: { dateFrom, dateDeadline },
      mode: rescheduleYN ? "reschedule" : "schedule",
    });
    return null;
  }

  const slot = timeSlots[0];
  const rawTime = slot.startTime ?? "";
  const time = rawTime.includes("T") ? rawTime.split("T")[1].slice(0, 5) : rawTime.slice(0, 5);

  console.log(`[usa] 🎯 CRÉNEAU TROUVÉ — ${ofc.postName} le ${targetDate} à ${time} (slotId=${slot.slotId})`);
  console.log(`[usa] 📊 [DISCOVERY] Date captée: ${targetDate} à ${time} | Statut: RETENUE pour booking | OFC: ${ofc.postName}`);
  discoveryEvents?.push({
    applicationId: appDetails.applicationId,
    destination: "usa",
    office: ofc.postName,
    dateFound: targetDate.split("T")[0],
    timeFound: time,
    outcome: "captured",
    context: { slotId: slot.slotId, totalTimeSlotsAvailable: timeSlots.length },
    mode: rescheduleYN ? "reschedule" : "schedule",
  });
  return {
    date: targetDate,
    time,
    slotId: slot.slotId,
    ofcName: ofc.postName,
    slot,           // objet complet UsaTimeSlot pour le booking
    bookingBase: basePayload as Record<string, unknown>,  // champs communs au booking
  };
}
