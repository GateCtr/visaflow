/**
 * Détails demande, transform data, liste OFC.
 */
import type { UsaSession } from "./types.js";
import type { UsaAppDetails, UsaOfc, UsaOfcRaw } from "./usa-scan-types.js";
import { normalizeOfc } from "./usa-scan-types.js";
import {
  USA_APP_DETAILS_URL,
  USA_TRANSFORM_DATA_URL,
  USA_OFC_LIST_URL,
  REFERER_CREATE_APT,
  REFERER_REQUESTS,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { usaFetch, authHeaders, sessionHeaders } from "./usa-http.js";

/**
 * Récupère les détails de la demande (applicantId, visaType, visaClass)
 * depuis GET /visaappointmentapi/appointments/getApplicationDetails
 */
export async function getUsaApplicationDetails(
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
export async function getUsaTransformData(
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

export async function getUsaOfcList(
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
