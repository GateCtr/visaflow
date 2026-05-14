import type { SessionResult, UsaSession } from "./types.js";
import type { HunterJob, SlotDiscoveryEvent } from "../convexClient.js";
import {
  reportSlotFound,
  sendHeartbeat,
  uploadFile,
  botLog,
} from "../convexClient.js";
import { randomDelay } from "../browser.js";
import {
  USA_SEARCH_URL,
  REFERER_CREATE_APT,
  REFERER_MANAGE_APT,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { markAccountRestricted } from "./account-restriction.js";
import { usaFetch, authHeaders, tokenCache } from "./usa-http.js";
import {
  randomInterStepPause,
  sendAntiDetectionNoise,
  ofcCursor,
} from "./anti-detection.js";
import type { UsaOfc, UsaAppDetails, SlotFound } from "./usa-scan-types.js";
import { toYMD } from "./usa-scan-types.js";
import { getUsaApplicationDetails, getUsaTransformData, getUsaOfcList } from "./usa-scan-details.js";
import { findFirstSlotForOfc } from "./usa-scan-find.js";
import { bookUsaSlot, rescheduleUsaSlot, reportSlotDiscovery_batch } from "./usa-scan-book.js";
import type { UsaBookingResult } from "./usa-scan-book.js";
import { downloadUsaConfirmationPdf } from "./usa-scan-confirmation.js";

/**
 * Phase principale du scan : contexte demande, flow anti-détection, liste OFC, round-robin, booking.
 */
export async function runUsaSlotScanMain(
  job: HunterJob,
  session: UsaSession,
  selectedFlow: string[],
): Promise<SessionResult> {
  if (!session.applicationId) {
    console.error("[usa] applicationId manquant — runUsaSlotScanMain");
    await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "applicationId manquant" });
    return "error";
  }

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
}
