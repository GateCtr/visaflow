import type { SessionResult, UsaSession } from "./types.js";
import type { HunterJob, SlotDiscoveryEvent } from "../convexClient.js";
import {
  reportSlotFound,
  sendHeartbeat,
  uploadFile,
  botLog,
  reportSlotDiscovery,
  reportSlotDiscoveryBatch,
} from "../convexClient.js";
import {
  humanLikeDelay,
  humanPause,
  shouldSimulateNetworkError,
  simulateNetworkTimeout,
  shuffleArray,
  randomSubset,
  simulateMenuClick,
  simulatePageRefresh,
  estimateExecutionTime,
  printExecutionTimeReport,
} from "../humanBehavior.js";
import { randomDelay, proxyPool, launchBrowser } from "../browser.js";
import {
  USA_BASE,
  USA_ADMIN_URL,
  USA_APPOINTMENT_URL,
  USA_NOTIFICATION_URL,
  USA_PAYMENT_URL,
  USA_WORKFLOW_URL,
  USA_APPLICANT_API_URL,
  USA_OFC_LIST_URL,
  USA_TRANSFORM_DATA_URL,
  USA_FIRST_AVAILABLE_MONTH_URL,
  USA_SLOT_DATES_URL,
  USA_SLOT_TIMES_URL,
  USA_APP_DETAILS_URL,
  USA_CONFIRMATION_LETTER_URL,
  USA_SCHEDULE_URL,
  USA_RESCHEDULE_URL,
  USA_SEARCH_URL,
  USA_SCHEDULED_INFO_URL,
  USA_SHOW_RESCHEDULE_BUTTON_URL,
  USA_LANDING_PAGE_URL,
  USA_SANITY_CHECK_URL,
  USA_FCS_CHECK_URL,
  USA_MISSION_ID,
  REFERER_DASHBOARD,
  REFERER_REQUESTS,
  REFERER_CREATE_APT,
  REFERER_MANAGE_APT,
  WARMUP_INTERVAL_MS,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody, markAccountRestricted } from "./account-restriction.js";
import {
  usaFetch,
  authHeaders,
  sessionHeaders,
  updateSessionActivity,
  tokenCache,
} from "./usa-http.js";
import {
  randomInterStepPause,
  selectRandomFlow,
  sendAntiDetectionNoise,
  executeWithHumanVariability,
  shouldDoWarmup,
  warmupLastCalledAt,
  ofcCursor,
} from "./anti-detection.js";

// ─────────────────────────────────────────────────────────────
// Types pour les réponses des endpoints de slot (bundle Angular)
// ─────────────────────────────────────────────────────────────

interface UsaOfc {
  postUserId: number;
  postName: string;
  officeType: string;  // "OFC" | "POST"
  postCode?: string;
}

/** Réponse brute de l'API /lookupcdt/wizard/getpost — champs réels du serveur.
 * Le portail renvoie `ofcName` et `code`, pas `postName`/`postCode`. */
interface UsaOfcRaw {
  postUserId: number;
  missionId?: number;
  ofcName?: string;
  postName?: string;  // Certaines missions renvoient postName au lieu de ofcName
  ofcAddress?: string;
  countryCode?: string;
  stateCode?: string;
  city?: string;
  officeType: string;
  code?: string;
  status?: string;
}

/** Normalise la réponse brute de l'API OFC en UsaOfc interne. */
function normalizeOfc(raw: UsaOfcRaw): UsaOfc {
  return {
    postUserId: raw.postUserId,
    postName: raw.ofcName ?? raw.postName ?? raw.city ?? `OFC-${raw.postUserId}`,
    officeType: raw.officeType,
    postCode: raw.code,
  };
}

interface UsaAppDetails {
  applicantId: number | string;
  applicationId: string;
  /** visaType envoyé dans les payloads slot (getFirstAvailableMonth, getSlotDates, etc.)
   * Ex: "NIV" (Non-Immigrant Visa). Différent de visaCategory! */
  visaType: string;
  visaClass: string;
  /** visaCategory envoyé dans l'URL getpost (OFC list).
   * Ex: "VisitorVisas". Le portail Angular l'envoie comme param ?visaCategory= dans getFilteredOfcPostList.
   * Distinct de visaType ("NIV") qui va dans les payloads de slot. */
  visaCategory?: string;
  locationType?: string;
  /** appointmentStatus — bundle Angular filtre sur "NEW" pour obtenir selectedSlotDetails. */
  appointmentStatus?: string;
  /** appointmentLocationType — "OFC" | "POST" */
  appointmentLocationType?: string;
  /** appointmentId — obligatoire dans le payload de booking (bundle Angular : selectedSlotDetails.appointmentId).
   * Vient de la réponse tableau de getApplicationDetails, filtrée sur appointmentStatus === "NEW". */
  appointmentId?: number;
  /** UUID de l'applicant — inclus dans le payload de booking (bundle Angular : selectedSlotDetails.applicantUUID).
   * Peut être string (sessionStorage) ou number (parseInt). On stocke string, parseInt au booking. */
  applicantUUID?: string | number;
  /** visaTypeKey — short code format from /appointments/search (e.g. "NIV", "IV").
   * Used directly in slot payloads (getFirstAvailableMonth, getSlotDates, etc.). */
  visaTypeKey?: string;
}

interface UsaFirstAvailableMonthResponse {
  present: boolean;
  date: string;  // "YYYY-MM-DD"
}

interface UsaSlotDate {
  date: string;        // "YYYY-MM-DD"
  slotsAvailable: number;
  [key: string]: unknown;
}

interface UsaTimeSlot {
  slotId: number | string;  // Le portail retourne un string alphanumérique (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
  date?: string;       // peut être absent si l'API retourne slotDate à la place
  slotDate?: string;   // champ retourné par getSlotTime (utilisé comme appointmentDt au booking)
  startTime: string;   // "HH:mm" ou "YYYY-MM-DDTHH:mm:ss"
  endTime: string;
  slotsAvailable?: number;
  [key: string]: unknown;
}


/**
 * Warm-up : appelé par le portail Angular dès l'ouverture du tableau de bord.
 * Reproduire cet appel rend le robot indiscernable d'un utilisateur légitime.
 * Erreurs ignorées silencieusement (non bloquant).
 */
async function callLandingPage(session: UsaSession): Promise<void> {
  if (!session.applicationId) return;
  // GET depuis le dashboard — pas de Content-Type, Referer = dashboard parent
  // Bundle intercepteur : /getLandingPageDeatils reçoit LanguageId:{Ue} en plus des headers standards.
  // Toutes les AUTRES requêtes NE reçoivent PAS LanguageId — c'est une condition explicite dans l'intercepteur.
  const headers = {
    ...sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_DASHBOARD, false),
    "LanguageId": "1",
  };
  try {
    const res = await usaFetch(USA_LANDING_PAGE_URL, { method: "GET", headers });
    console.log(`[usa] getLandingPageDeatils → HTTP ${res.status}`);
  } catch (err) {
    console.warn("[usa] getLandingPageDeatils ignoré :", err);
  }
}

/**
 * Sanity check : POST /visaintegrationapi/visa/sanitycheck/{appId}?stepType=slotBooking
 * Appelé par le portail Angular à chaque init de page de booking.
 * Fire-and-forget (n'attend pas la réponse pour continuer).
 */
async function callSanityCheck(session: UsaSession): Promise<void> {
  if (!session.applicationId) return;
  const url = USA_SANITY_CHECK_URL(session.applicationId, "slotBooking");
  // POST sans corps — le portail envoie Content-Type mais pas de body
  const headers = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_CREATE_APT, true);
  try {
    const res = await usaFetch(url, { method: "POST", headers });
    console.log(`[usa] sanityCheck(slotBooking) → HTTP ${res.status}`);
  } catch (err) {
    console.warn("[usa] sanityCheck ignoré :", err);
  }
}

/**
 * Vérification du paiement FCS : GET /visapaymentapi/v1/feecollection/checkFcs/{appId}
 * Appelé par le portail avant la réservation de créneau.
 * Retourne true si le paiement est confirmé côté FCS.
 * En cas d'erreur réseau, on laisse le scan continuer (bénéfice du doute).
 */
async function checkFcsPayment(session: UsaSession): Promise<boolean> {
  if (!session.applicationId) return true; // laisser passer si pas d'appId
  const url = USA_FCS_CHECK_URL(session.applicationId);
  // GET — pas de Content-Type
  const headers = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_CREATE_APT, false);
  try {
    const res = await usaFetch(url, { method: "GET", headers });
    if (!res.ok) {
      console.warn(`[usa] checkFcs → HTTP ${res.status} — scan maintenu par prudence`);
      return true; // scan quand même
    }
    const data = await res.json() as { fcsStatus?: string; isPaid?: boolean; paymentStatus?: string };
    const paid = data.isPaid === true
      || data.fcsStatus === "1"
      || data.fcsStatus === "paid"
      || data.paymentStatus === "paid";
    console.log(`[usa] checkFcs → ${JSON.stringify(data)} → paid=${paid}`);
    return paid !== false; // tolérant si le format change
  } catch (err) {
    console.warn("[usa] checkFcs erreur réseau — scan maintenu :", err);
    return true;
  }
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(d: Date): string {
  return toYMD(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * Récupère les détails de la demande (applicantId, visaType, visaClass)
 * depuis GET /visaappointmentapi/appointments/getApplicationDetails
 */
async function getUsaApplicationDetails(
  session: UsaSession,
  applicationId: string
): Promise<UsaAppDetails | null> {
  // Bundle Angular : getappointmentByApplicationId(y, w) → ?applicationId=w&applicantId=y
  // y = applicantId interne (selectedSlotDetails.applicantId) ≠ userID de login dans la plupart des cas.
  // On utilise session.applicantId (propagé depuis getUserHistoryApplicantPaymentStatus) si disponible,
  // sinon session.userID comme fallback (le serveur peut l'accepter pour auth ou lookup).
  const applicantIdParam = session.applicantId ?? session.userID;
  const url = USA_APP_DETAILS_URL(applicationId, applicantIdParam);
  try {
    // GET — pas de Content-Type, Referer = page de création de RDV
    const res = await usaFetch(url, {
      headers: sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_CREATE_APT, false),
    });
    if (!res.ok) {
      console.warn(`[usa] getApplicationDetails HTTP ${res.status}`);
      return null;
    }
    // Bundle Angular : la réponse est un TABLEAU d'objets UsaAppDetails.
    // Angular fait : let z = [...Ee] puis filtre sur "NEW" == B.appointmentStatus.
    // selectedSlotDetails = relatedAppList[0] (premier item avec appointmentStatus "NEW").
    // appointmentId et applicantUUID viennent de ce même objet.
    const raw = await res.json();

    // La réponse peut avoir deux formats (selon le endpoint/version du portail) :
    //   A) Tableau plat d'objets UsaAppDetails (historique)
    //   B) Objet unique avec gssApplicants[0].appointmentDetails[0] (format actuel capturé)
    // Le format B a les champs visaType/visaClass/appointmentId dans appointmentDetails,
    // pas au top-level de l'objet.
    let list: UsaAppDetails[];

    if (Array.isArray(raw)) {
      // Format A : tableau d'objets
      list = raw;
    } else if (raw && typeof raw === "object" && raw.gssApplicants?.length > 0) {
      // Format B : objet avec gssApplicants (format capturé dans la vraie session)
      const apptDetails = raw.gssApplicants[0]?.appointmentDetails;
      if (Array.isArray(apptDetails) && apptDetails.length > 0) {
        // Extraire les détails depuis appointmentDetails imbriqué
        list = apptDetails.map((ad: Record<string, unknown>) => ({
          applicantId: ad.applicantId ?? raw.gssApplicants[0]?.applicantId,
          applicationId: ad.applicationId ?? raw.applicationId,
          visaType: ad.visaType ?? "NIV",
          visaClass: (ad.visaClassCode ?? ad.visaClass) as string,
          visaCategory: (ad.visaCategoryCode ?? ad.visaCategory) as string,
          locationType: ad.appointmentLocationType,
          appointmentStatus: ad.appointmentStatus,
          appointmentLocationType: ad.appointmentLocationType,
          appointmentId: ad.appointmentId as number | undefined,
          applicantUUID: ad.applicantUUID ?? ad.appointmentUUID,
        })) as UsaAppDetails[];
        console.log(`[usa] getApplicationDetails: format gssApplicants détecté (${list.length} appointment(s))`);
      } else {
        // Pas d'appointmentDetails — traiter l'objet comme un UsaAppDetails direct
        list = [raw as unknown as UsaAppDetails];
      }
    } else {
      list = [raw as unknown as UsaAppDetails];
    }

    // Filtrer pour obtenir uniquement les demandes en statut "NEW" (en attente de créneau)
    const newItems = list.filter(item => item.appointmentStatus === "NEW");
    // En mode reschedule, les RDV existants sont en statut "SCHEDULED" — les inclure aussi
    const scheduledItems = list.filter(item => item.appointmentStatus === "SCHEDULED");
    const data = newItems.length > 0 ? newItems[0] : (scheduledItems.length > 0 ? scheduledItems[0] : list[0]);  // fallback au premier si pas de "NEW" ni "SCHEDULED"
    if (!data) {
      console.warn(`[usa] getApplicationDetails: réponse vide ou inattendue (longueur=${list.length})`);
      return null;
    }
    console.log(
      `[usa] App details: applicantId=${data.applicantId}, visaType=${data.visaType}, visaClass=${data.visaClass}` +
      `${data.appointmentId !== undefined ? `, appointmentId=${data.appointmentId}` : ""}` +
      `${data.applicantUUID !== undefined ? `, applicantUUID=${data.applicantUUID}` : ""}` +
      ` (param applicantId=${applicantIdParam}, status=${data.appointmentStatus}, total=${list.length})`
    );
    return data;
  } catch (err) {
    console.warn(`[usa] getApplicationDetails erreur: ${err}`);
    return null;
  }
}

/**
 * Récupère la liste des OFCs disponibles pour une mission, filtrée par visa et OFCs autorisés.
 *
 * Bundle Angular (booking flow) :
 *   slotBookingService.getFilteredOfcPostList(De)
 *   → GET /lookupcdt/wizard/getpost?visaClass=...&missionId=...
 *   1. Filtre par officeType === "OFC" (ofcOrPost)
 *   2. Filtre par loggedInApplicantUser.ofc (si non vide)
 *
 * Différent de getOfcListByMissionId (admin) → GET /ofcuser/ofclist/{missionId}
 */

// ─────────────────────────────────────────────────────────────────────────────
// getUsaTransformData — récupère stateCode + appointmentPriority pour l'URL OFC
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /visaworkflowprocessor/workflow/getTransformData/{applicationId}
 *
 * Bundle Angular : renderService.getTransformData(applicationId, applicantId)
 *   Appelé sur la page /home/dashboard/requests ET dans le booking flow OFC step
 *   quand this.ofcOrPost/this.appointmentType/this.stateCode ne sont pas encore définis.
 *
 * Retourne un tableau. [0].transformData est un JSON stringifié contenant (entre autres) :
 *   - stateCode          → param ?stateCode= de l'URL OFC list
 *   - appointmentPriority → param ?priority= de l'URL OFC list (si présent)
 *   - visaClass, visaTypekey, paymentStatus, missionId, etc.
 *
 * Note bundle : malgré la signature JS getTransformData(y, w), seul y (applicationId)
 * est utilisé dans l'URL — w (applicantId) n'est pas transmis au serveur.
 */
async function getUsaTransformData(
  session: UsaSession,
  applicationId: string,
): Promise<{ stateCode?: string; appointmentPriority?: string; paymentStatus?: string; visaClass?: string; visaCategory?: string; visaCategoryKey?: string; applicantId?: string; visaTypeKey?: string } | null> {
  const url = USA_TRANSFORM_DATA_URL(applicationId);
  const hdrs = sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_REQUESTS, false);
  try {
    const res = await usaFetch(url, { headers: hdrs });
    if (res.status === 429) throw new RateLimitError("getTransformData", parseInt(res.headers.get("retry-after") ?? "60", 10) * 1000);
    if (res.status === 403) throw new AccountBlockedError("getTransformData");
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      console.warn(`[usa] getTransformData HTTP ${res.status} — ignoré (params OFC non enrichis)`);
      return null;
    }
    const raw = await res.json();
    const arr = Array.isArray(raw) ? raw : [];
    if (arr.length === 0) return null;

    // Bundle : B.stepTransformData = JSON.parse(B.transformData)
    // On parse le JSON stringifié dans .transformData
    let td: Record<string, unknown> = {};
    try {
      td = JSON.parse(arr[0].transformData as string) as Record<string, unknown>;
    } catch {
      console.warn("[usa] getTransformData: impossible de parser .transformData");
    }

    const stateCode        = typeof td.stateCode        === "string" ? td.stateCode        : undefined;
    const appointmentPriority = typeof td.appointmentPriority === "string" ? td.appointmentPriority : undefined;
    const paymentStatus    = typeof td.paymentStatus    === "string" ? td.paymentStatus    : undefined;
    // visaClass et visaCategory — nécessaires pour l'URL OFC list quand getApplicationDetails échoue
    // (cas "cancellable" : le dossier est terminé, getApplicationDetails filtre par appointmentStatus=NEW → vide)
    const visaClass        = typeof td.visaClass        === "string" ? td.visaClass        : undefined;
    const visaCategory     = typeof td.visaCategory     === "string" ? td.visaCategory     :
                             (typeof td.visaCategoryCode === "string" ? td.visaCategoryCode : undefined);
    // visaCategorykey (ex: "StudentsandExchangeVisitors") — c'est le CODE que le portail Angular
    // envoie dans l'URL lookupcdt/wizard/getpost?visaCategory=... 
    // DIFFÉRENT de visaCategory (label: "Students and Exchange Visitors") qui cause un 404.
    // Fallback: on tente aussi visaCategoryCode (champ du search response) et enfin on strip les espaces du label.
    const visaCategoryKey  = typeof td.visaCategorykey  === "string" ? td.visaCategorykey  :
                             (typeof td.visaCategoryCode === "string" ? td.visaCategoryCode :
                             (typeof td.visaCategory === "string" ? td.visaCategory.replace(/\s+/g, "") : undefined));
    // applicantId GSS (ex: "RQUP3HHVQHOD") — utilisé dans les payloads slot si getApplicationDetails échoue
    const applicantId      = typeof td.applicantid      === "string" ? td.applicantid      :
                             (typeof td.applicantId      === "string" ? td.applicantId      : undefined);
    // visaTypekey (ex: "NIV") — c'est ce que le portail envoie dans les payloads slot, PAS visaType ("Non-immigrant Visa")
    const visaTypeKey      = typeof td.visaTypekey      === "string" ? td.visaTypekey      : undefined;

    console.log(`[usa] getTransformData: stateCode=${stateCode ?? "(vide)"} priority=${appointmentPriority ?? "(vide)"} visaClass=${visaClass ?? "(vide)"} visaCategory=${visaCategory ?? "(vide)"} visaCategoryKey=${visaCategoryKey ?? "(vide)"} applicantId=${applicantId ?? "(vide)"} paymentStatus=${paymentStatus ?? "?"}`);
    return { stateCode, appointmentPriority, paymentStatus, visaClass, visaCategory, visaCategoryKey, applicantId, visaTypeKey };
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) throw err;
    console.warn(`[usa] getTransformData erreur: ${err} — ignoré`);
    return null;
  }
}

async function getUsaOfcList(
  session: UsaSession,
  missionId: number,
  visaClass?: string,
  visaCategory?: string,
  stateCode?: string,
  priority?: string,
): Promise<UsaOfc[]> {
  const url = USA_OFC_LIST_URL(missionId, visaClass, visaCategory, stateCode, priority);
  // GET — pas de Content-Type; les cookies applicationId+missionId doivent être présents
  const hdrs = session.applicationId
    ? sessionHeaders(session.accessToken, session.applicationId, missionId, REFERER_CREATE_APT, false)
    : authHeaders(session.accessToken, REFERER_CREATE_APT, false);
  try {
    const res = await usaFetch(url, { headers: hdrs });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
      throw new RateLimitError("getOfcList", retryAfter * 1000);
    }
    if (res.status === 403) {
      throw new AccountBlockedError("getOfcList");
    }
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      console.warn(`[usa] getOfcList HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    // L'API retourne des champs `ofcName`/`code` (pas `postName`/`postCode`) — normaliser.
    const rawList = Array.isArray(data) ? data as UsaOfcRaw[] : [];
    const list: UsaOfc[] = rawList.map(normalizeOfc);

    // Étape 1 : filtre par officeType — bundle: je.filter(B => B.officeType === this.ofcOrPost)
    // Le portail Angular utilise `this.ofcOrPost` qui vaut "OFC" par défaut (nouveau booking)
    // ou "POST" (reschedule d'un RDV POST, ex: Kinshasa où il n'y a PAS de bureau OFC séparé).
    // Pour les missions sans bureau OFC (ex: Kinshasa missionId=323 → un seul bureau officeType="POST"),
    // il faut inclure les bureaux POST sinon la liste est vide et le scan échoue.
    let filtered = list.filter(o => o.officeType === "OFC");

    // Fallback : si aucun OFC trouvé, utiliser les bureaux POST (cas Kinshasa, etc.)
    if (filtered.length === 0 && list.length > 0) {
      filtered = list.filter(o => o.officeType === "POST");
      if (filtered.length > 0) {
        console.log(`[usa] ⚠️ Aucun bureau OFC — fallback sur ${filtered.length} bureau(x) POST: ${filtered.map(o => o.postName).join(", ")}`);
      }
    }

    // Étape 2 : filtre par OFCs autorisés (loggedInApplicantUser.ofc)
    // Bundle : S?.length>0 && (ofcList = ofcList.filter(B => S.some(se => se.postUserId===B.postUserId)))
    const allowed = session.allowedOfcs ?? [];
    if (allowed.length > 0) {
      const allowedIds = new Set(allowed.map(o => o.postUserId));
      const before = filtered.length;
      filtered = filtered.filter(o => allowedIds.has(o.postUserId));
      console.log(`[usa] Filtre OFCs autorisés du compte: ${before} → ${filtered.length} OFC(s)`);
    }

    const paramStr = [
      visaClass    ? `visaClass=${visaClass}`   : null,
      visaCategory ? `cat=${visaCategory}`      : null,
      stateCode    ? `state=${stateCode}`        : null,
      priority     ? `priority=${priority}`      : null,
    ].filter(Boolean).join(" ");
    console.log(`[usa] OFCs (mission ${missionId}${paramStr ? ` ${paramStr}` : ""}): ${filtered.map(o => o.postName).join(", ") || "aucun"}`);
    return filtered;
  } catch (err) {
    // Re-lancer les erreurs circuit-breaker — elles doivent remonter jusqu'à scanUsaSlotsViaAPI.
    // Les avaler ici ferait continuer le scan silencieusement avec une liste vide, sans heartbeat.
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) {
      throw err;
    }
    console.warn(`[usa] getOfcList erreur: ${err}`);
    return [];
  }
}

/**
 * Pour un OFC donné, cherche le premier mois avec des créneaux disponibles,
 * puis les dates et horaires dans ce mois.
 * Retourne le premier créneau trouvé ou null.
 */
interface SlotFound {
  date: string;
  time: string;
  slotId: number | string;  // string alphanumérique retourné par le portail (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
  ofcName: string;
  slot: UsaTimeSlot;
  bookingBase: Record<string, unknown>;
}

async function findFirstSlotForOfc(
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

// ─────────────────────────────────────────────────────────────
// Conversion temps 24h → format UItime Angular (12h AM/PM)
// ─────────────────────────────────────────────────────────────

/**
 * Envoie le batch d'événements de découverte avec l'applicationId du job.
 * Les événements dans findFirstSlotForOfc utilisent le portalApplicationId,
 * mais pour Convex on a besoin du job.id (= Convex application _id).
 */
function reportSlotDiscovery_batch(events: SlotDiscoveryEvent[], jobId: string): void {
  // Overrider applicationId avec le jobId Convex (les events ont le portalApplicationId)
  const eventsWithJobId = events.map(e => ({ ...e, applicationId: jobId }));
  reportSlotDiscoveryBatch(eventsWithJobId);
}

/**
 * Reproduit exactement setUItime() du bundle Angular (portail US Visa).
 *
 * Angular reçoit startTime en ISO (ex. "2026-05-15T09:00:00.000Z"),
 * extrait la partie temps via datePipe("hh:mm") en 12h ET l'heure 24h brute,
 * puis appelle setUItime(display12h, hour24raw) pour produire le label "9:00 AM".
 *
 * Format de sortie : H:mm AM/PM (sans zéro initial sur l'heure).
 *   "09:00" → "9:00 AM"
 *   "14:00" → "2:00 PM"
 *   "12:00" → "12:00 PM"
 *   "00:00" → "12:00 AM"
 *
 * Ce format est envoyé tel quel dans le payload PUT /appointments/schedule
 * en tant que `appointmentTime`.  Envoyer le format 24h ("14:00") serait incorrect.
 */
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

// ─────────────────────────────────────────────────────────────
// Types & fonction de booking automatique
// ─────────────────────────────────────────────────────────────

/**
 * Payload exact envoyé par Angular dans PUT /appointments/schedule (OFC individuel).
 * 10 champs — ni plus, ni moins.  Source : bundle Angular, méthode bookSlot() + initBookSlot().
 *
 * Champs du bundle :
 *   se = { appointmentId, applicantUUID, appointmentLocationType, appointmentStatus,
 *           slotId, appointmentDt, appointmentTime }       ← 7 champs base (bookSlot())
 *   + De.postUserId = this.selectedOfc                     ← ajouté par initBookSlot()
 *   + De.applicantId = selectedSlotDetails.applicantId     ← ajouté par initBookSlot()
 *   + De.applicationId = this.applicationId                ← ajouté par initBookSlot()
 *
 * NE PAS inclure : visaType, visaClass, locationType, startTime, endTime, date, time.
 * Ces champs sont dans les payloads getSlotDates/getSlotTime/getFirstAvailableMonth, PAS dans le booking.
 */
interface UsaBookingPayload {
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

interface UsaBookingEntry {
  responseMsg?: string;
  appointmentId?: number;
  [key: string]: unknown;
}

type UsaBookingResponse = UsaBookingEntry[];

interface UsaBookingResult {
  success: boolean;
  appointmentId?: number;
  responseMsg?: string;
  error?: string;
  statusCode?: number;
}

/**
 * Réserve automatiquement un créneau trouvé par findFirstSlotForOfc.
 * PUT /visaappointmentapi/appointments/schedule
 *
 * Codes d'erreur connus (extraits du bundle Angular) :
 *   409 → créneau déjà pris par un autre usager (conflit)
 *   502 → erreur serveur temporaire
 *
 * Réponse succès : Array<{ responseMsg, appointmentId, ... }>
 */
async function bookUsaSlot(
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

/**
 * Reporter un RDV existant vers un nouveau créneau.
 * PUT /visaappointmentapi/appointments/reschedule
 *
 * Source bundle Angular : initRescheduleSlot(se) → initRescheduleAPI([se])
 *   se est identique au payload de schedule + rescheduleType = reschedProps.appointmentLocationType
 *   Le payload est envoyé en TABLEAU même pour un seul applicant.
 *
 * La valeur de appointmentId dans le payload = l'ID du RDV EXISTANT à reporter
 * (session.appointmentId, récupéré depuis /scheduledappointmentInfo ou /search).
 * rescheduleType = "POST" = type de l'appointment existant (ambassade = POST location).
 *
 * Codes d'erreur identiques à bookUsaSlot (409 = conflit, 429 = rate limit, etc.)
 */
async function rescheduleUsaSlot(
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

/**
 * Télécharge la lettre de confirmation de RDV au format PDF.
 * POST /visanotificationapi/template/appointmentLetter
 *
 * Séquence Angular (capture réseau 13/05/2026) :
 *   1. POST sanityCheck(appId, "appointmentLetter")  → fire-and-forget, body vide, Content-Length: 0
 *   2. POST /template/appointmentLetter              → blob PDF
 *   3. createObjectURL(blob) + a.download            → téléchargement navigateur
 *
 * Payload réel capturé : { languageId: 1, applicationId, applicantId }
 *   - languageId: 1 (anglais)
 *   - applicationId: format court "fa68-6780-e96e-c8eb"
 *   - applicantId: format GSS string "RQUP3HHVQHOD"
 *   - PAS de missionId ni appointmentId dans le payload (contrairement à ce qu'on pensait)
 *
 * Referer réel : /visaapplicantui/home/dashboard/requests (pas create-appointment)
 * Headers : Accept: application/pdf  +  cookies missionId/APP_ID_TOBE via sessionHeaders.
 * Retourne le contenu PDF en Buffer, ou null en cas d'erreur.
 */
export async function downloadUsaConfirmationPdf(
  session: UsaSession,
  applicationId: string,
  _appointmentId?: number | string
): Promise<Buffer | null> {
  console.log(`[usa] Téléchargement confirmation PDF — applicationId=${applicationId}, applicantId=${session.applicantId ?? "n/a"}...`);

  // Étape 1 : sanityCheck avec stepType="appointmentLetter" (fire-and-forget, comme le bundle Angular)
  // Le portail l'appelle juste avant de générer la lettre, sans attendre la réponse.
  // Capture réseau : POST avec Content-Length: 0 (pas de body), Referer = dashboard/requests
  if (session.applicationId) {
    const sanityUrl = USA_SANITY_CHECK_URL(session.applicationId, "appointmentLetter");
    const sanityHeaders = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_REQUESTS, true);
    usaFetch(sanityUrl, { method: "POST", headers: sanityHeaders })
      .then(r => console.log(`[usa] sanityCheck(appointmentLetter) → HTTP ${r.status}`))
      .catch(e => console.warn("[usa] sanityCheck(appointmentLetter) ignoré:", e));
  }

  // Étape 2 : POST appointmentLetter → blob PDF
  // Payload aligné sur la capture réseau réelle (13/05/2026) :
  //   { "languageId": 1, "applicationId": "fa68-6780-e96e-c8eb", "applicantId": "RQUP3HHVQHOD" }
  // Content-Length capturé : 83 bytes — correspond exactement à ce payload.
  const letterPayload: Record<string, unknown> = {
    languageId: 1,
    applicationId,
    applicantId: session.applicantId ?? session.userID,
  };

  try {
    const res = await usaFetch(USA_CONFIRMATION_LETTER_URL, {
      method: "POST",
      // Referer = dashboard/requests (pas create-appointment) — capturé dans les logs réseau.
      // Accept: application/pdf écrase le "application/json" de sessionHeaders.
      headers: {
        ...sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_REQUESTS),
        "Accept": "application/pdf",
      },
      body: JSON.stringify(letterPayload),
    });

    if (!res.ok) {
      console.warn(`[usa] downloadConfirmationPdf HTTP ${res.status}`);
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
      const text = await res.text();
      console.warn(`[usa] Réponse inattendue (non-PDF): ${text.slice(0, 200)}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    console.log(`[usa] Confirmation PDF téléchargée: ${buf.length} bytes`);
    return buf;
  } catch (err) {
    console.warn(`[usa] downloadConfirmationPdf erreur: ${err}`);
    return null;
  }
}

/**
 * Scan direct des créneaux USA via API — sans Playwright.
 * Utilise les endpoints découverts dans le bundle Angular du portail :
 *  - getFirstAvailableMonth → getSlotDates → getSlotTime
 * Remplace scanUsaSlotsWithBrowser (fragile, lent, consomme Chromium).
 */
export async function scanUsaSlotsViaAPI(job: HunterJob, session: UsaSession): Promise<SessionResult> {
  try {
    if (!session.applicationId) {
      console.error("[usa] applicationId manquant dans la session — impossible de scanner");
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "applicationId manquant" });
      return "error";
    }

  // ── Mise à jour activité session — chaque appel à scanUsaSlotsViaAPI maintient la session vivante ──
  const scanUsername = job.hunterConfig.embassyUsername;
  if (scanUsername) {
    updateSessionActivity(scanUsername);
  }

  // ── Sélection du flow aléatoire pour variabilité anti-détection ───────────
  const selectedFlow = selectRandomFlow();
  console.log(`[anti-detection] 🧠 Flow sélectionné pour cette session: ${selectedFlow.join(" → ")}`);
  
  // Pause initiale aléatoire
  await randomInterStepPause(300, 1500, job.id);

  // ── Anti-détection : warm-up throttlé (max 1×/8 min) ────────────────────────
  // Le portail appelle ces 3 endpoints à chaque ouverture de la page de booking.
  // Throttle à WARMUP_INTERVAL_MS pour éviter le flood : en tres_urgent (3-5 min),
  // sans throttle = 36-60 appels warm-up/heure supplémentaires → restriction account.
  const doWarmup = shouldDoWarmup(session.applicationId);
  if (doWarmup) {
    warmupLastCalledAt.set(session.applicationId, Date.now());
    console.log("[human] 🔥 Warm-up avec variabilité humaine...");

    // Simuler occasionnellement une erreur réseau (2% du temps)
    if (shouldSimulateNetworkError()) {
      console.log("[human] ⚡ Simulation d'erreur réseau pendant warm-up");
      await simulateNetworkTimeout(1500 + Math.random() * 2000);
    }

    // Exécuter le warm-up avec variabilité humaine
    await executeWithHumanVariability([
      {
        name: "Landing Page",
        execute: async () => await callLandingPage(session),
        critical: true
      },
      {
        name: "Sanity Check", 
        execute: async () => await callSanityCheck(session),
        critical: true
      },
      // NOTE: checkFcsPayment retiré du warm-up (mai 2026).
      // Le portail Angular actuel ne l'appelle plus dans le flux de booking
      // (absent des captures réseau 12-13/05/2026). L'endpoint retourne 401
      // systématiquement — probablement migré ou supprimé côté serveur.
      // Le paiement est déjà vérifié via getUserHistoryApplicantPaymentStatus
      // (pendingAppoStatus !== 0 ↔ paiement confirmé).
      {
        name: "Menu Navigation",
        execute: async () => await simulateMenuClick(session, job.id)
      },
      {
        name: "Page Refresh",
        execute: async () => await simulatePageRefresh(job.id)
      }
    ], "warm-up ", job.id);

  } else {
    const lastWarmup = warmupLastCalledAt.get(session.applicationId) ?? 0;
    const nextIn = Math.round((WARMUP_INTERVAL_MS - (Date.now() - lastWarmup)) / 60000);
    console.log(`[usa] Warm-up ignoré (prochain dans ~${nextIn} min) — économie 3 appels API`);
    
    // Même sans warm-up, ajouter un peu de variabilité
    if (Math.random() < 0.4) {
      await humanPause(500, "démarrage ", job.id);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  // 0. Récupérer d'abord getTransformData pour obtenir le bon applicantId (GSS string)
  //    Le portail Angular fait la même chose : getTransformData AVANT getApplicationDetails.
  //    Sans ça, getApplicationDetails est appelé avec userID (2720819) au lieu de "RQUP3HHVQHOD"
  //    et retourne 404 en mode cancellable/reschedule.
  let earlyTransformData: { stateCode?: string; appointmentPriority?: string; paymentStatus?: string; visaClass?: string; visaCategory?: string; visaCategoryKey?: string; applicantId?: string; visaTypeKey?: string } | null = null;
  try {
    earlyTransformData = await getUsaTransformData(session, session.applicationId);
    if (earlyTransformData) {
      if (earlyTransformData.stateCode) session.stateCode = earlyTransformData.stateCode;
      if (earlyTransformData.appointmentPriority) session.appointmentPriority = earlyTransformData.appointmentPriority;
      // Propager applicantId GSS dans la session pour que getApplicationDetails l'utilise
      if (earlyTransformData.applicantId && !session.applicantId) {
        session.applicantId = earlyTransformData.applicantId;
        console.log(`[usa] applicantId GSS depuis getTransformData (early): ${earlyTransformData.applicantId}`);
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] getTransformData early ignoré: ${err}`);
  }

  // 1. Récupérer les détails de la demande (applicantId, visaType, visaClass, appointmentId, applicantUUID)
  // ── NEW: appeler /appointments/search AVANT getApplicationDetails ──────────
  // Le vrai navigateur utilise cette API pour obtenir visaType, visaClass, applicantId, appointmentId
  // avec des valeurs fiables et plates (pas de nesting gssApplicants).
  let searchDetails: {
    visaType?: string;
    visaClass?: string;
    applicantId?: string;
    appointmentId?: number;
    appointmentLocationType?: string;
    visaCategory?: string;
  } | null = null;
  try {
    const searchPayload = {
      operation: "AND",
      searchObjects: [
        { key: "applicationId", value: session.applicationId, feildType: "STRING", operation: "EQUAL" },
      ],
    };
    const searchHeaders = authHeaders(session.accessToken, REFERER_CREATE_APT, true);
    const searchRes = await usaFetch(USA_SEARCH_URL, {
      method: "POST",
      headers: searchHeaders,
      body: JSON.stringify(searchPayload),
    });
    console.log(`[usa] /appointments/search → HTTP ${searchRes.status}`);
    if (searchRes.ok) {
      const searchRaw = await searchRes.text();
      console.log(`[usa] /appointments/search réponse: ${searchRaw.slice(0, 600)}`);
      let searchRows: Record<string, unknown>[] = [];
      try { searchRows = JSON.parse(searchRaw) as Record<string, unknown>[]; } catch { /* non-JSON */ }
      // Filter for appointmentStatus === "NEW" entries (same as Angular bundle logic)
      const newEntries = searchRows.filter(r => r.appointmentStatus === "NEW");
      const target = newEntries[0] ?? searchRows[0];
      if (target) {
        searchDetails = {
          visaType: typeof target.visaType === "string" ? target.visaType : undefined,
          visaClass: typeof target.visaClass === "string" ? target.visaClass : undefined,
          applicantId: typeof target.applicantId === "string" ? target.applicantId : undefined,
          appointmentId: typeof target.appointmentId === "number" ? target.appointmentId : undefined,
          appointmentLocationType: typeof target.appointmentLocationType === "string" ? target.appointmentLocationType : undefined,
          visaCategory: typeof target.visaCategory === "string" ? target.visaCategory : undefined,
        };
        console.log(`[usa] ✅ searchDetails: visaType=${searchDetails.visaType}, visaClass=${searchDetails.visaClass}, applicantId=${searchDetails.applicantId}, appointmentId=${searchDetails.appointmentId}, locationType=${searchDetails.appointmentLocationType}, visaCategory=${searchDetails.visaCategory}`);
        // Propagate applicantId GSS into session early
        if (searchDetails.applicantId && !session.applicantId) {
          session.applicantId = searchDetails.applicantId;
          console.log(`[usa] applicantId GSS depuis /appointments/search: ${searchDetails.applicantId}`);
        }
      }
    } else {
      console.warn(`[usa] /appointments/search HTTP ${searchRes.status} — will fallback to getApplicationDetails`);
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] /appointments/search ignoré: ${err}`);
  }

  // Fallback: getApplicationDetails (may return nested gssApplicants format with undefined fields)
  const appDetails = await getUsaApplicationDetails(session, session.applicationId);
  if (!appDetails) {
    console.warn("[usa] getApplicationDetails échoué — tentative avec userID comme applicantId");
  }

  let effectiveDetails: UsaAppDetails = appDetails ?? {
    // Préférer session.applicantId (GSS string comme "ODXJKHXJQMZH") si disponible,
    // sinon fallback sur session.userID (number du login).
    applicantId: session.applicantId ?? session.userID,
    applicationId: session.applicationId,
    // FALLBACK UNIQUEMENT si getApplicationDetails échoue.
    // Ces valeurs seront TOUJOURS écrasées par getTransformData (appelé dans le flow OFC).
    // Si les deux APIs échouent, ces défauts permettent quand même de tenter un scan.
    // NOTE: "NIV" = Non-Immigrant Visa. Pour les Immigrant Visas (IV), getTransformData
    // retournera la bonne valeur (ex: visaTypekey="IV", visaClass="IR1", visaCategory="ImmigrantVisas").
    // Le bot ne code JAMAIS le type de visa en dur pour le booking — il vient toujours de l'API.
    visaType: earlyTransformData?.visaCategory ?? "NIV",
    visaClass: earlyTransformData?.visaClass ?? "B1/B2",
    visaCategory: earlyTransformData?.visaCategoryKey ?? "VisitorVisas",
    locationType: "OFC",
  };

  // ── Override effectiveDetails with searchDetails (priority: search > appDetails > defaults) ──
  if (searchDetails) {
    if (searchDetails.visaType) {
      effectiveDetails.visaType = searchDetails.visaType;
      effectiveDetails.visaTypeKey = searchDetails.visaType;
    }
    if (searchDetails.visaClass) effectiveDetails.visaClass = searchDetails.visaClass;
    if (searchDetails.applicantId) effectiveDetails.applicantId = searchDetails.applicantId;
    if (searchDetails.appointmentId !== undefined) effectiveDetails.appointmentId = searchDetails.appointmentId;
    if (searchDetails.appointmentLocationType) effectiveDetails.appointmentLocationType = searchDetails.appointmentLocationType;
    if (searchDetails.visaCategory) effectiveDetails.visaCategory = searchDetails.visaCategory;
    // Set locationType from search's appointmentLocationType for slot payloads
    if (searchDetails.appointmentLocationType) effectiveDetails.locationType = searchDetails.appointmentLocationType;
    console.log(`[usa] effectiveDetails enrichi depuis /appointments/search: visaType=${effectiveDetails.visaType}, visaClass=${effectiveDetails.visaClass}, applicantId=${effectiveDetails.applicantId}, locationType=${effectiveDetails.locationType}`);
  }

  // Propager appointmentId et applicantUUID depuis getApplicationDetails → session.
  // Source bundle : selectedSlotDetails = relatedAppList[0] (filtrée "NEW")
  //   selectedSlotDetails.appointmentId → appointmentId dans bookSlot()
  //   selectedSlotDetails.applicantUUID → applicantUUID dans bookSlot()
  // Ces champs peuvent aussi venir de getUserHistoryApplicantPaymentStatus (propagés plus tôt).
  // On préfère la valeur de getApplicationDetails car c'est ce que le portail Angular utilise en priorité.
  if (appDetails?.appointmentId !== undefined) {
    console.log(`[usa] appointmentId depuis getApplicationDetails : ${appDetails.appointmentId}${session.appointmentId !== undefined ? ` (remplace session.appointmentId=${session.appointmentId})` : ""}`);
    session.appointmentId = appDetails.appointmentId;
  }
  if (appDetails?.applicantUUID !== undefined) {
    const uuidNum = typeof appDetails.applicantUUID === "number"
      ? appDetails.applicantUUID
      : parseInt(String(appDetails.applicantUUID), 10);
    if (!isNaN(uuidNum)) {
      console.log(`[usa] applicantUUID depuis getApplicationDetails : ${uuidNum}${session.applicantUUID !== undefined ? ` (remplace session.applicantUUID=${session.applicantUUID})` : ""}`);
      session.applicantUUID = uuidNum;
    }
  }

  // ── Exécution du flow aléatoire ───────────────────────────────────────────
  // Suivre la séquence définie par selectedFlow pour varier les patterns
  console.log(`[anti-detection] 🚀 Début exécution du flow: ${selectedFlow.join(" → ")}`);
  
  // Variables pour stocker les résultats des étapes
  let transformDataResult: any = earlyTransformData;
  let ofcListResult: UsaOfc[] = [];
  let scanResult: SessionResult = "not_found";
  
  // Exécuter chaque étape du flow avec pauses aléatoires
  for (const step of selectedFlow) {
    console.log(`[anti-detection] Étape: ${step}`);
    
    try {
      switch (step) {
        case "login":
          // Déjà fait avant cette fonction
          await randomInterStepPause(300, 1200, job.id);
          break;
          
        case "status":
          // Déjà fait avant cette fonction
          await randomInterStepPause(300, 1200, job.id);
          break;
          
        case "warmup":
          // Warm-up déjà géré au début de la fonction
          await randomInterStepPause(500, 1500, job.id);
          break;
          
        case "noise":
          // Envoyer des requêtes bruit anti-détection
          await sendAntiDetectionNoise(session, job.id);
          await randomInterStepPause(800, 2000, job.id);
          break;
          
        case "ofc":
          // Récupérer la liste des OFCs
          if (!transformDataResult && session.applicationId) {
            // Essayer d'abord getTransformData si pas encore fait
            try {
              transformDataResult = await getUsaTransformData(session, session.applicationId);
              if (transformDataResult) {
                if (transformDataResult.stateCode) session.stateCode = transformDataResult.stateCode;
                if (transformDataResult.appointmentPriority) session.appointmentPriority = transformDataResult.appointmentPriority;
                // Enrichir effectiveDetails si getApplicationDetails avait échoué (cas cancellable/reschedule)
                if (transformDataResult.visaClass && effectiveDetails.visaClass === "B1/B2") {
                  console.log(`[usa] visaClass enrichi depuis getTransformData: ${transformDataResult.visaClass} (remplace défaut "B1/B2")`);
                  effectiveDetails.visaClass = transformDataResult.visaClass;
                }
                if (transformDataResult.visaCategory && (!effectiveDetails.visaType || effectiveDetails.visaType === "NIV" || effectiveDetails.visaType.includes(" "))) {
                  // Le portail Angular envoie visaTypekey (ex: "NIV") dans les payloads slot, PAS le label
                  // long comme "Non-immigrant Visa". getTransformData retourne le bon code court.
                  console.log(`[usa] visaType/Category enrichi depuis getTransformData: ${transformDataResult.visaCategory} (remplace "${effectiveDetails.visaType}")`);
                  effectiveDetails.visaType = transformDataResult.visaCategory;
                }
                if (transformDataResult.applicantId && (effectiveDetails.applicantId === session.userID || effectiveDetails.applicantId === (session.applicantId ?? session.userID))) {
                  console.log(`[usa] applicantId enrichi depuis getTransformData: ${transformDataResult.applicantId} (remplace ${effectiveDetails.applicantId})`);
                  effectiveDetails.applicantId = transformDataResult.applicantId;
                }
              }
            } catch (err) {
              console.warn(`[usa] getTransformData ignoré avant OFC list: ${err}`);
            }
          }
          
          // Utiliser les données de getTransformData en priorité (plus fiables que getApplicationDetails
          // pour les cas cancellable/reschedule où appointmentStatus n'est plus "NEW")
          const ofcVisaClass = transformDataResult?.visaClass ?? effectiveDetails.visaClass;
          // visaCategory pour l'URL getpost — DOIT être le code clé (ex: "StudentsandExchangeVisitors")
          // PAS le label humain (ex: "Students and Exchange Visitors") qui retourne 404.
          // Priorité : visaCategorykey > visaCategoryCode (effectiveDetails) > fallback strip espaces
          const ofcVisaCategory = transformDataResult?.visaCategoryKey ?? effectiveDetails.visaCategory ?? effectiveDetails.visaType;

          // Bundle : appointmentPriority "group" + reschedule → "regular" (bot = pas de reschedule donc on envoie tel quel)
          const ofcPriority = session.appointmentPriority;
          ofcListResult = await getUsaOfcList(
            session,
            session.missionId,
            ofcVisaClass,
            ofcVisaCategory,
            session.stateCode,
            ofcPriority,
          );
          
          botLog({
            applicationId: job.id,
            step: "ofc_list",
            status: "ok",
            data: {
              flow: "usa",
              count: ofcListResult.length,
              offices: ofcListResult.map((o) => ({ name: o.postName, postUserId: o.postUserId })),
              visaClass: effectiveDetails.visaClass,
              visaType: effectiveDetails.visaType,
            },
          });
          
          if (ofcListResult.length === 0) {
            console.warn("[usa] Aucun OFC trouvé — vérifier missionId ou droits d'accès");
            botLog({ applicationId: job.id, step: "ofc_list", status: "warn", data: { flow: "usa", count: 0, missionId: session.missionId } });
            await sendHeartbeat({
              applicationId: job.id,
              result: "not_found",
              errorMessage: `Aucun OFC disponible pour mission ${session.missionId}`,
            });
            return "not_found";
          }
          
          await randomInterStepPause(1000, 2500, job.id);
          break;
          
        case "dates":
          // Cette étape est intégrée dans le scan des OFCs
          // Juste une pause pour simuler la navigation
          await randomInterStepPause(800, 1800, job.id);
          break;
          
        case "times":
          // Cette étape est intégrée dans le scan des OFCs  
          // Juste une pause pour simuler la navigation
          await randomInterStepPause(800, 1800, job.id);
          break;
          
        case "transform":
          // getTransformData
          if (session.applicationId) {
            try {
              transformDataResult = await getUsaTransformData(session, session.applicationId);
              if (transformDataResult) {
                if (transformDataResult.stateCode) session.stateCode = transformDataResult.stateCode;
                if (transformDataResult.appointmentPriority) session.appointmentPriority = transformDataResult.appointmentPriority;
                
                // Enrichir effectiveDetails
                if (transformDataResult.visaClass && effectiveDetails.visaClass === "B1/B2") {
                  console.log(`[usa] visaClass enrichi depuis getTransformData: ${transformDataResult.visaClass} (remplace défaut "B1/B2")`);
                  effectiveDetails.visaClass = transformDataResult.visaClass;
                }
                if (transformDataResult.visaCategory && (!effectiveDetails.visaType || effectiveDetails.visaType === "NIV" || effectiveDetails.visaType.includes(" "))) {
                  // Le portail Angular envoie visaTypekey (ex: "NIV") dans les payloads slot, PAS le label
                  // long comme "Non-immigrant Visa". getTransformData retourne le bon code court.
                  console.log(`[usa] visaType/Category enrichi depuis getTransformData: ${transformDataResult.visaCategory} (remplace "${effectiveDetails.visaType}")`);
                  effectiveDetails.visaType = transformDataResult.visaCategory;
                }
                if (transformDataResult.applicantId && (effectiveDetails.applicantId === session.userID || effectiveDetails.applicantId === (session.applicantId ?? session.userID))) {
                  console.log(`[usa] applicantId enrichi depuis getTransformData: ${transformDataResult.applicantId} (remplace ${effectiveDetails.applicantId})`);
                  effectiveDetails.applicantId = transformDataResult.applicantId;
                }
              }
            } catch (err) {
              console.warn(`[usa] getTransformData ignoré: ${err}`);
            }
          }
          await randomInterStepPause(600, 1500, job.id);
          break;
          
        default:
          // This should never happen, but TypeScript wants us to handle all cases
          console.warn(`[usa] Étape inattendue dans le flow: ${step}`);
          await randomInterStepPause(300, 1000, job.id);
          break;
      }
      
      // Pause entre les étapes
      if (Math.random() < 0.3) {
        await randomInterStepPause(300, 1000, job.id);
      }
      
    } catch (err) {
      // Gestion des erreurs circuit-breaker
      if (err instanceof RateLimitError) {
        const waitSec = Math.round((err.retryAfterMs ?? 60000) / 1000);
        console.error(`[usa] ⛔ RATE LIMIT détecté — scan interrompu (retry-after: ${waitSec}s)`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "rate_limit", endpoint: step, retryAfterMs: err.retryAfterMs, waitSec } });
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `Rate limit (429) — ${err.message}. Reprendre dans ~${waitSec}s.`,
        });
        return "error";
      }
      if (err instanceof AccountBlockedError) {
        console.error(`[usa] ⛔ COMPTE POTENTIELLEMENT BLOQUÉ — ${err.message}`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "blocked", endpoint: step, error: (err as Error).message } });
        const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
        if (cacheKey) tokenCache.delete(cacheKey);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `Compte bloqué (403) — ${err.message}`,
        });
        return "error";
      }
      if (err instanceof AccountRestrictedError) {
        const username = job.hunterConfig.embassyUsername ?? "";
        if (username) markAccountRestricted(username, err.retryAfterMs, err.retryAfterHeader);
        console.warn(`[usa] 🔒 Compte restreint — pause avec backoff exponentiel (cache préservé)`);
        botLog({ applicationId: job.id, step: "error", status: "warn", data: { flow: "usa", phase: "restricted", error: err.message } });
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
          errorMessage: `Compte restreint — cycles ignorés ~60 min`,
        });
        return "not_found";
      }
      if (err instanceof TokenExpiredError) {
        console.error(`[usa] ⛔ TOKEN EXPIRÉ — arrêt, reconnexion au prochain cycle`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "token_expired", error: "Token JWT expiré" } });
        const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
        if (cacheKey) tokenCache.delete(cacheKey);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: "Token JWT expiré — reconnexion requise",
        });
        return "error";
      }
      
      // Erreur non-critique, continuer avec l'étape suivante
      console.warn(`[usa] Erreur non-critique à l'étape ${step}: ${err}`);
    }
  }
  
  // Si ofcList n'a pas été récupérée dans le flow, la récupérer maintenant
  if (ofcListResult.length === 0 && session.applicationId) {
    try {
      const ofcPriority = session.appointmentPriority;
      // Utiliser visaCategoryKey (code) en priorité pour éviter le 404 avec le label humain
      const fallbackVisaCategory = transformDataResult?.visaCategoryKey ?? effectiveDetails.visaCategory ?? effectiveDetails.visaType;
      ofcListResult = await getUsaOfcList(
        session,
        session.missionId,
        effectiveDetails.visaClass,
        fallbackVisaCategory,
        session.stateCode,
        ofcPriority,
      );
    } catch (err) {
      console.error(`[usa] Impossible de récupérer OFC list: ${err}`);
      return "error";
    }
  }
  
  if (ofcListResult.length === 0) {
    console.warn("[usa] Aucun OFC trouvé après exécution du flow");
    return "not_found";
  }

  // Utiliser la liste des OFCs récupérée
  const ofcList = ofcListResult;

  // Fenêtre de réservation définie par l'admin (optionnel)
  const slotDateFrom = job.hunterConfig.slotDateFrom;
  let slotDateDeadline = job.hunterConfig.slotDateDeadline;
  const rescheduleMode = job.hunterConfig.rescheduleMode;
  const rescheduleExistingDate = job.hunterConfig.rescheduleExistingDate;

  // Mode reporter : forcer dateDeadline à la veille du RDV existant
  if (rescheduleMode && rescheduleExistingDate) {
    const existingDateObj = new Date(rescheduleExistingDate + "T12:00:00");
    existingDateObj.setDate(existingDateObj.getDate() - 1);
    const computedDeadline = toYMD(existingDateObj);
    // Prendre la plus restrictive des deux deadlines
    if (!slotDateDeadline || computedDeadline < slotDateDeadline) {
      slotDateDeadline = computedDeadline;
    }
    console.log(`[usa] ♻️ Mode reporter : deadline forcée à ${slotDateDeadline} (veille du RDV existant ${rescheduleExistingDate})`);
    // Bundle : rescheduleYN && appointmentPriority==="group" → "regular"
    if (session.appointmentPriority === "group") {
      console.log(`[usa] ♻️ Mode reporter : appointmentPriority "group" → "regular"`);
      session.appointmentPriority = "regular";
    }
  }

  if (slotDateFrom || slotDateDeadline) {
    console.log(`[usa] 📅 Fenêtre admin : ${slotDateFrom ?? "illimitée"} → ${slotDateDeadline ?? "illimitée"}`);
  }

  // 3. Scanner les OFCs en round-robin (1 OFC par cycle) pour réduire le nombre
  //    d'appels API par cycle. Avec N OFCs, chaque OFC est vérifiée toutes les N×(3-5) min
  //    au lieu de scanner toutes les N à chaque cycle (économie : (N-1)×3 appels/cycle).
  //    Accepté car les créneaux n'apparaissent pas à la seconde — 10-15 min de latence OK.
  const cursorKey = session.applicationId;
  const cursor = ofcCursor.get(cursorKey) ?? 0;
  const ofcToScan = ofcList.length > 1
    ? [ofcList[cursor % ofcList.length]]
    : ofcList;
  ofcCursor.set(cursorKey, (cursor + 1) % ofcList.length);
  if (ofcList.length > 1) {
    console.log(`[usa] 🔄 Round-robin OFC : scanning ${ofcToScan[0].postName} (${cursor % ofcList.length + 1}/${ofcList.length})`);
  }

  // Collecteur d'événements de découverte de dates (pour stats et analyse de fréquence)
  const scanDiscoveryEvents: SlotDiscoveryEvent[] = [];

  try {
    for (const ofc of ofcToScan) {
      console.log(`[usa] Scan OFC: ${ofc.postName} (postUserId=${ofc.postUserId})`);
      botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "ofc_scanning", ofc: ofc.postName } });
      // Délai humain entre OFCs — un vrai utilisateur prend 1.5-4s pour passer d'un bureau à l'autre
      await randomDelay(1500, 4000);

      let found: SlotFound | null;
      try {
        found = await findFirstSlotForOfc(
          session, ofc, effectiveDetails, slotDateFrom, slotDateDeadline,
          rescheduleMode,
          rescheduleMode ? REFERER_MANAGE_APT : undefined,
          scanDiscoveryEvents
        );
      } catch (err) {
        // Gestion des erreurs pour findFirstSlotForOfc
        if (err instanceof RateLimitError) {
          const waitSec = Math.round((err.retryAfterMs ?? 60000) / 1000);
          console.error(`[usa] ⛔ RATE LIMIT détecté — scan interrompu (retry-after: ${waitSec}s)`);
          botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "rate_limit", endpoint: `findFirstSlotForOfc/${ofc.postName}`, retryAfterMs: err.retryAfterMs, waitSec } });
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Rate limit (429) — ${err.message}. Reprendre dans ~${waitSec}s.`,
          });
          return "error";
        }
        if (err instanceof AccountBlockedError) {
          console.error(`[usa] ⛔ COMPTE POTENTIELLEMENT BLOQUÉ — ${err.message}`);
          botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "blocked", endpoint: `findFirstSlotForOfc/${ofc.postName}`, error: (err as Error).message } });
          const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
          if (cacheKey) tokenCache.delete(cacheKey);
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Compte bloqué (403) — ${err.message}`,
          });
          return "error";
        }
        if (err instanceof AccountRestrictedError) {
          const username = job.hunterConfig.embassyUsername ?? "";
          if (username) markAccountRestricted(username, err.retryAfterMs, err.retryAfterHeader);
          console.warn(`[usa] 🔒 Compte restreint pendant le scan OFC ${ofc.postName} — pause avec backoff exponentiel (cache préservé)`);
          botLog({ applicationId: job.id, step: "error", status: "warn", data: { flow: "usa", phase: "restricted", ofc: ofc.postName, error: err.message } });
          await sendHeartbeat({
            applicationId: job.id,
            result: "not_found",
            errorMessage: `Compte restreint — cycles ignorés ~60 min`,
          });
          return "not_found";
        }
        if (err instanceof TokenExpiredError) {
          console.error(`[usa] ⛔ TOKEN EXPIRÉ en cours de scan — arrêt, reconnexion au prochain cycle`);
          botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "token_expired", error: "Token JWT expiré", ofc: ofc.postName } });
          const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
          if (cacheKey) tokenCache.delete(cacheKey);
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: "Token JWT expiré en cours de scan — reconnexion requise",
          });
          return "error";
        }
        // Erreur inattendue — loguer et continuer sur le prochain OFC
        const unexpectedMsg = err instanceof Error ? err.message : String(err);
        console.error(`[usa] Erreur inattendue sur OFC ${ofc.postName}: ${err}`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "scan", ofc: ofc.postName, error: unexpectedMsg.slice(0, 300) } });
        continue;
      }
      
      if (found) {
        botLog({
          applicationId: job.id,
          step: "slots_found",
          status: "ok",
          data: {
            flow: "usa",
            phase: "scan",
            ofc: found.ofcName,
            date: found.date,
            time: found.time,
            slotId: found.slotId,
          },
        });

        // Le booking et le téléchargement du PDF sont dans un try/catch séparé :
        // les erreurs circuit-breaker (RateLimit, Blocked, TokenExpired) doivent
        // stopper le scan et déclencher un heartbeat d'alerte, pas crasher silencieusement.
        let booking: UsaBookingResult;
        botLog({
          applicationId: job.id,
          step: "booking_attempt",
          status: "ok",
          data: { flow: "usa", ofc: found.ofcName, date: found.date, time: found.time, slotId: found.slotId },
        });
        try {
          // ── 1. Booking ou Reschedule automatique ─────────────
          // En mode reschedule (cancellable ou scheduled+rescheduleMode), le portail Angular
          // utilise PUT /appointments/reschedule au lieu de PUT /appointments/schedule.
          // Les deux cas (cancellable et scheduled+rescheduleMode) aboutissent au même
          // endpoint avec le même payload + rescheduleType:"POST".
          const useReschedule = rescheduleMode || session.isReschedule === true;

          booking = useReschedule
            ? await rescheduleUsaSlot(session, found)
            : await bookUsaSlot(session, found);
        } catch (bookErr) {
          if (bookErr instanceof RateLimitError) {
            const waitSec = Math.round((bookErr.retryAfterMs ?? 60000) / 1000);
            console.error(`[usa] ⛔ RATE LIMIT lors du booking — scan interrompu (retry: ${waitSec}s)`);
            botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "rate_limit", endpoint: "booking", retryAfterMs: bookErr.retryAfterMs, waitSec } });
            await sendHeartbeat({
              applicationId: job.id,
              result: "error",
              errorMessage: `Rate limit (429) lors du booking — ${bookErr.message}. Reprendre dans ~${waitSec}s.`,
            });
            return "error";
          }
          if (bookErr instanceof AccountBlockedError) {
            console.error(`[usa] ⛔ COMPTE BLOQUÉ lors du booking — ${bookErr.message}`);
            botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "blocked", endpoint: "booking", error: (bookErr as Error).message } });
            const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
            if (cacheKey) tokenCache.delete(cacheKey);
            await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Compte bloqué (403) lors du booking` });
            return "error";
          }
          if (bookErr instanceof AccountRestrictedError) {
            const username = job.hunterConfig.embassyUsername ?? "";
            if (username) markAccountRestricted(username, bookErr.retryAfterMs, bookErr.retryAfterHeader);
            console.warn(`[usa] 🔒 Compte restreint lors du booking — pause avec backoff exponentiel (cache préservé)`);
            botLog({ applicationId: job.id, step: "error", status: "warn", data: { flow: "usa", phase: "restricted", error: "Compte restreint lors du booking" } });
            await sendHeartbeat({ applicationId: job.id, result: "not_found", errorMessage: `Compte restreint lors du booking — pause 60 min` });
            return "not_found";
          }
          if (bookErr instanceof TokenExpiredError) {
            console.error(`[usa] ⛔ TOKEN EXPIRÉ lors du booking — reconnexion au prochain cycle`);
            botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "token_expired", error: "Token JWT expiré lors du booking" } });
            const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
            if (cacheKey) tokenCache.delete(cacheKey);
            await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Token JWT expiré lors du booking` });
            return "error";
          }
          // Erreur réseau inattendue — traiter comme booking échoué et continuer
          const msg = bookErr instanceof Error ? bookErr.message : String(bookErr);
          console.error(`[usa] Erreur inattendue lors du booking: ${msg}`);
          botLog({ applicationId: job.id, step: "booking_fail", status: "fail", data: { flow: "usa", error: msg.slice(0, 300), ofc: found.ofcName, date: found.date } });
          booking = { success: false, error: msg };
        }

        await randomDelay(1000, 2000);

        // 409 = créneau pris en concurrence AVANT notre booking.
        // Ne pas signaler le slot comme trouvé (on ne l'a pas obtenu) — scanner le prochain OFC.
        if (!booking.success && booking.statusCode === 409) {
          console.log("[usa] Conflit 409 — le créneau a été pris avant nous. Poursuite du scan...");
          botLog({ applicationId: job.id, step: "booking_fail", status: "warn", data: { flow: "usa", reason: "Conflit 409 — créneau pris par un autre utilisateur", ofc: found.ofcName, date: found.date } });
          continue;
        }

        // Tout autre échec de booking (502, erreur réseau, réponse inattendue) :
        // NE PAS reporter slot_found — ce serait un faux positif. Reporter une erreur et arrêter.
        if (!booking.success) {
          const errMsg = `Booking échoué (HTTP ${booking.statusCode ?? "err"}) sur ${found.ofcName} — ${booking.error}. Créneau NON confirmé.`;
          console.error(`[usa] ❌ ${errMsg}`);
          botLog({
            applicationId: job.id,
            step: "booking_fail",
            status: "fail",
            data: { flow: "usa", ofc: found.ofcName, date: found.date, time: found.time, slotId: found.slotId, statusCode: booking.statusCode, error: booking.error },
          });
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: errMsg,
          });
          return "error";
        }

        // ── 2. Télécharger le PDF de confirmation ───────────────
        // Uniquement si le booking a réussi : le portail ne génère la lettre que sur un RDV confirmé.
        let pdfStorageId: string | undefined;
        botLog({
          applicationId: job.id,
          step: "booking_success",
          status: "ok",
          data: {
            flow: "usa",
            ofc: found.ofcName,
            date: found.date,
            time: found.time,
            appointmentId: booking.appointmentId,
            responseMsg: booking.responseMsg,
          },
        });
        const pdf = await downloadUsaConfirmationPdf(session, session.applicationId, booking.appointmentId);
        if (pdf) {
          console.log(`[usa] 📄 Confirmation PDF (${pdf.length} bytes) — upload vers Convex...`);
          const b64 = pdf.toString("base64");
          pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
          if (pdfStorageId) {
            console.log(`[usa] ✅ PDF uploadé → storageId: ${pdfStorageId}`);
            botLog({
              applicationId: job.id,
              step: "confirmation_letter",
              status: "ok",
              data: { flow: "usa", pdfSizeBytes: pdf.length, storageId: pdfStorageId, appointmentId: booking.appointmentId },
            });
          }
        }

        // ── 3. Rapport vers Convex — booking réellement confirmé ──
        await reportSlotFound({
          applicationId: job.id,
          date: found.date,
          time: found.time,
          location: `${found.ofcName} — Ambassade USA (slotId=${found.slotId}, appointmentId=${booking.appointmentId})`,
          confirmationCode: booking.appointmentId?.toString(),
          screenshotStorageId: pdfStorageId,
        });

        return "slot_found";
      }
      // Aucun créneau pour cette OFC lors de ce cycle
      botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "ofc_no_slot", ofc: ofc.postName } });
    }
  } catch (error) {
    // Catch any unexpected errors in the OFC scanning try block
    console.error(`[usa] Erreur inattendue dans le scan OFC:`, error);
    await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Erreur inattendue: ${error instanceof Error ? error.message : String(error)}` });
    return "error";
  }

  console.log(`[usa] Aucun créneau disponible sur ${ofcList.length} OFC(s)`);

  // ── Résumé des découvertes de dates pour ce cycle ──
  if (scanDiscoveryEvents.length > 0) {
    const captured = scanDiscoveryEvents.filter(e => e.outcome === "captured").length;
    const ignored = scanDiscoveryEvents.filter(e => e.outcome === "ignored").length;
    const reasons = scanDiscoveryEvents
      .filter(e => e.outcome === "ignored")
      .reduce<Record<string, number>>((acc, e) => {
        acc[e.reason ?? "unknown"] = (acc[e.reason ?? "unknown"] ?? 0) + 1;
        return acc;
      }, {});
    const reasonStr = Object.entries(reasons).map(([r, n]) => `${r}:${n}`).join(", ");
    console.log(`[usa] 📊 [SCAN STATS] Dates découvertes: ${scanDiscoveryEvents.length} | Retenues: ${captured} | Ignorées: ${ignored} (${reasonStr})`);
    // Envoyer le batch vers Convex pour analyse de fréquence
    reportSlotDiscovery_batch(scanDiscoveryEvents, job.id);
  } else {
    console.log(`[usa] 📊 [SCAN STATS] Aucune date découverte sur ce cycle (portail vide ou erreur API)`);
  }

  botLog({ applicationId: job.id, step: "not_found", status: "warn", data: { flow: "usa", ofcCount: ofcList.length, offices: ofcList.map((o) => o.postName), discoveryCount: scanDiscoveryEvents.length, discoveredIgnored: scanDiscoveryEvents.filter(e => e.outcome === "ignored").length } });
  await sendHeartbeat({ applicationId: job.id, result: "not_found" });
  return "not_found";
  } catch (error) {
    // Check if this is the FCS payment check failed error
    if (error instanceof Error && error.message === "FCS payment check failed") {
      console.warn("[usa] FCS payment check failed — paiement non confirmé");
      return "payment_required";
    }
    
    console.error(`[usa] Erreur inattendue dans scanUsaSlotsViaAPI:`, error);
    await sendHeartbeat({ 
      applicationId: job.id, 
      result: "error", 
      errorMessage: `Erreur inattendue: ${error instanceof Error ? error.message : String(error)}` 
    });
    return "error";
  }
}



