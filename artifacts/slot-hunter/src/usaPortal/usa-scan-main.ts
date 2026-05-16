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
import { handle409Retry, type Retry409Context } from "./retry-409-logic.js";
import type { UsaOfc, UsaAppDetails, SlotFound } from "./usa-scan-types.js";
import { toYMD } from "./usa-scan-types.js";
import { getUsaApplicationDetails, getUsaTransformData, getUsaOfcList } from "./usa-scan-details.js";
import { findFirstSlotForOfc } from "./usa-scan-find.js";
import { bookUsaSlot, rescheduleUsaSlot, reportSlotDiscovery_batch } from "./usa-scan-book.js";
import type { UsaBookingResult } from "./usa-scan-book.js";
import { downloadUsaConfirmationPdf } from "./usa-scan-confirmation.js";
import {
  selectOfcsToScan,
  isFirstScanOfSession,
  markFirstScanDone,
  sendGaPageView,
  parallelBurst,
  burstInterStepPause,
} from "./scan-behavior.js";
import { runContinuousRefresh } from "./continuous-refresh.js";

/**
 * Phase principale du scan : contexte demande, flow anti-détection, liste OFC, sélection imprévisible, booking.
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

  // CORRECTION #3 : Envoyer un événement GA page_view au début du scan
  // (simule la navigation vers la page de création de RDV)
  await sendGaPageView(
    "AVITS Appointment",
    "/visaapplicantui/home/dashboard/create-appointment",
    undefined,
    job.id,
  );

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

  // ── VÉRIFICATION PAIEMENT MRV ─────────────────────────────────────────────
  // Le portail USA n'autorise la recherche de créneaux que si le paiement MRV est confirmé.
  // D'après le bundle Angular et les captures réseau, paymentStatus="VERIFIED" signifie
  // que le MRV receipt est validé et le calendrier est accessible.
  // Sans paiement, les endpoints getSlotDates/getSlotTime retournent des tableaux vides
  // (pas d'erreur HTTP, juste aucun créneau) → gaspillage de requêtes + pattern bot.
  //
  // Stratégie :
  //   - paymentStatus === "VERIFIED" → OK, continuer le scan
  //   - earlyTransformData === null → getTransformData a complètement échoué (réseau/401),
  //     on laisse passer (grace) car l'échec peut être temporaire
  //   - paymentStatus absent/undefined/""/autre → paiement non fait, bloquer le scan
  if (earlyTransformData !== null) {
    const ps = earlyTransformData?.paymentStatus;
    if (ps === "VERIFIED") {
      console.log(`[usa] ✅ Paiement MRV vérifié (paymentStatus="VERIFIED") — scan autorisé`);
    } else {
      // paymentStatus est undefined (champ absent du JSON = pas de paiement fait)
      // ou une valeur autre que "VERIFIED" (ex: "", "PENDING", etc.)
      const displayStatus = ps ?? "(absent)";
      console.warn(`[usa] 💳 Paiement MRV non confirmé (paymentStatus=${displayStatus}) — scan bloqué`);
      botLog({
        applicationId: job.id,
        step: "payment_check",
        status: "warn",
        data: {
          flow: "usa",
          paymentStatus: displayStatus,
          applicationId: session.applicationId,
          message: "Paiement MRV non vérifié — scan bloqué",
        },
      });
      await sendHeartbeat({
        applicationId: job.id,
        result: "payment_required",
        errorMessage: `Paiement MRV non confirmé (paymentStatus=${displayStatus}) — l'utilisateur doit effectuer le paiement sur usvisaappt.com`,
      });
      return "payment_required";
    }
  } else {
    // getTransformData a échoué complètement (null) — on ne peut pas vérifier le paiement.
    // Laisser passer le scan (grace) car l'échec peut être temporaire (réseau, 500, etc.)
    console.log(`[usa] ⚠️ paymentStatus inconnu (getTransformData échoué) — scan autorisé par défaut (grace)`);
  }
  // ──────────────────────────────────────────────────────────────────────────

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
          // No-op — noise requests supprimées (15/05/2026)
          // Un humain qui cherche un créneau ne consulte pas /help ou /faq
          await randomInterStepPause(300, 800, job.id);
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

  // 3. Scanner les OFCs avec sélection IMPRÉVISIBLE (correction #4)
  //    L'ancien round-robin parfait (cursor+1 % N) était un signal de bot détectable.
  //    Un humain peut re-scanner le même bureau, sauter un bureau, ou en scanner 2 d'un coup.
  const isFirstScan = isFirstScanOfSession(session.applicationId!);
  const ofcToScan = selectOfcsToScan(session.applicationId!, ofcList, isFirstScan);
  if (isFirstScan) {
    markFirstScanDone(session.applicationId!);
  }
  if (ofcList.length > 1) {
    console.log(`[usa] 🎯 OFCs sélectionnés : ${ofcToScan.map(o => o.postName).join(", ")} (${ofcToScan.length}/${ofcList.length})`);
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
        // PILLAR 3 : Retry intelligent — chercher les slots restants au lieu d'abandonner
        if (!booking.success && booking.statusCode === 409) {
          console.log("[usa] ⚠️ Conflit 409 — lancement retry intelligent (slots restants + dates alternatives)...");
          botLog({ applicationId: job.id, step: "booking_fail", status: "warn", data: { flow: "usa", reason: "Conflit 409 — retry intelligent activé", ofc: found.ofcName, date: found.date } });

          // Construire le contexte pour le retry
          const retryCtx: Retry409Context = {
            session,
            basePayload: found.bookingBase,
            originalDate: found.date,
            failedSlotId: found.slotId,
            availableDates: [], // sera rempli par les dates déjà découvertes si disponibles
            isReschedule: rescheduleMode || session.isReschedule === true,
            ofcName: found.ofcName,
            jobId: job.id,
            slotHeaders: authHeaders(session.accessToken, rescheduleMode ? REFERER_MANAGE_APT : REFERER_CREATE_APT, true),
            fromDate: slotDateFrom ?? new Date().toISOString().slice(0, 10),
            toDate: slotDateDeadline ?? new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10),
          };

          const retryResult = await handle409Retry(retryCtx);
          if (retryResult) {
            // Booking réussi via retry !
            const retryBooking = retryResult.bookingResult;
            let pdfStorageId: string | undefined;
            botLog({
              applicationId: job.id,
              step: "booking_success",
              status: "ok",
              data: { flow: "usa", ofc: retryResult.ofcName, date: retryResult.date, time: retryResult.time, appointmentId: retryBooking.appointmentId, via: "409_retry" },
            });

            const pdf = await downloadUsaConfirmationPdf(session, session.applicationId!, retryBooking.appointmentId);
            if (pdf) {
              const b64 = pdf.toString("base64");
              pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
            }

            await reportSlotFound({
              applicationId: job.id,
              date: retryResult.date,
              time: retryResult.time,
              location: `${retryResult.ofcName} — Ambassade USA (slotId=${retryResult.slotId}, via 409-retry)`,
              confirmationCode: retryBooking.appointmentId?.toString(),
              screenshotStorageId: pdfStorageId,
            });
            // Envoyer les découvertes collectées avant le return
            if (scanDiscoveryEvents.length > 0) {
              reportSlotDiscovery_batch(scanDiscoveryEvents, job.id);
            }
            return "slot_found";
          }
          // Retry exhausté — continuer vers l'OFC suivante
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

        // ── 4. Envoyer les événements de découverte collectés pendant ce cycle ──
        // IMPORTANT: Ce batch doit être envoyé AVANT le return pour que les dates
        // découvertes (outcome="captured") soient visibles dans le calendrier admin.
        if (scanDiscoveryEvents.length > 0) {
          reportSlotDiscovery_batch(scanDiscoveryEvents, job.id);
        }

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

  console.log(`[usa] Aucun créneau disponible sur ${ofcList.length} OFC(s) — lancement refresh continu...`);

  // ── Résumé des découvertes de dates pour le scan initial ──
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
    console.log(`[usa] 📊 [SCAN STATS] Dates découvertes (scan initial): ${scanDiscoveryEvents.length} | Retenues: ${captured} | Ignorées: ${ignored} (${reasonStr})`);
    // Envoyer le batch vers Convex pour analyse de fréquence
    reportSlotDiscovery_batch(scanDiscoveryEvents, job.id);
  } else {
    console.log(`[usa] 📊 [SCAN STATS] Aucune date découverte sur le scan initial (portail vide ou erreur API)`);
  }

  // ── REFRESH CONTINU : rester sur la "page" et rafraîchir à intervalles humains ──
  // Au lieu de retourner "not_found" immédiatement et attendre 5-15 min,
  // on simule un humain qui reste sur la page des créneaux et rafraîchit périodiquement.
  // Cela maximise la couverture temporelle : ~60% du temps au lieu de ~6%.
  const refreshUsername = job.hunterConfig.embassyUsername ?? "";
  const refreshReferer = rescheduleMode ? REFERER_MANAGE_APT : REFERER_CREATE_APT;

  const refreshResult = await runContinuousRefresh({
    session,
    job,
    ofcs: ofcList, // Tous les OFCs, pas seulement ceux du scan initial
    appDetails: effectiveDetails,
    referer: refreshReferer,
    username: refreshUsername,
    rescheduleYN: rescheduleMode,
    dateFrom: slotDateFrom,
    dateDeadline: slotDateDeadline,
  });

  if (refreshResult.slotDetected) {
    // Un slot a été détecté pendant le refresh continu !
    // On doit maintenant faire le scan COMPLET (dates + times + booking) pour ce slot.
    console.log(`[refresh] 🚨 Slot détecté pendant refresh continu — lancement scan complet pour booking...`);
    
    // Re-scanner les OFCs pour trouver le slot et le booker
    // On utilise la même logique que le scan initial mais maintenant on SAIT qu'il y a un slot
    for (const ofc of ofcList) {
      let found: SlotFound | null;
      try {
        found = await findFirstSlotForOfc(
          session, ofc, effectiveDetails, slotDateFrom, slotDateDeadline,
          rescheduleMode,
          rescheduleMode ? REFERER_MANAGE_APT : undefined,
          scanDiscoveryEvents
        );
      } catch (err) {
        if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) {
          console.error(`[refresh] ⛔ Erreur critique pendant booking post-refresh: ${(err as Error).constructor.name}`);
          await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Erreur lors du booking post-refresh: ${(err as Error).message}` });
          return "error";
        }
        continue;
      }

      if (found) {
        botLog({
          applicationId: job.id,
          step: "slots_found",
          status: "ok",
          data: { flow: "usa", phase: "continuous_refresh_booking", ofc: found.ofcName, date: found.date, time: found.time, slotId: found.slotId, refreshCount: refreshResult.totalRefreshes },
        });

        // Booking
        const useReschedule = rescheduleMode || session.isReschedule === true;
        let booking: UsaBookingResult;
        try {
          booking = useReschedule
            ? await rescheduleUsaSlot(session, found)
            : await bookUsaSlot(session, found);
        } catch (bookErr) {
          if (bookErr instanceof RateLimitError || bookErr instanceof AccountBlockedError || bookErr instanceof TokenExpiredError || bookErr instanceof AccountRestrictedError) {
            await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Erreur booking post-refresh: ${(bookErr as Error).message}` });
            return "error";
          }
          const msg = bookErr instanceof Error ? bookErr.message : String(bookErr);
          console.error(`[refresh] Erreur booking: ${msg}`);
          booking = { success: false, error: msg };
        }

        if (booking.success) {
          let pdfStorageId: string | undefined;
          botLog({ applicationId: job.id, step: "booking_success", status: "ok", data: { flow: "usa", ofc: found.ofcName, date: found.date, time: found.time, appointmentId: booking.appointmentId, via: "continuous_refresh" } });

          const pdf = await downloadUsaConfirmationPdf(session, session.applicationId!, booking.appointmentId);
          if (pdf) {
            const b64 = pdf.toString("base64");
            pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
          }

          await reportSlotFound({
            applicationId: job.id,
            date: found.date,
            time: found.time,
            location: `${found.ofcName} — Ambassade USA (slotId=${found.slotId}, via continuous_refresh #${refreshResult.totalRefreshes})`,
            confirmationCode: booking.appointmentId?.toString(),
            screenshotStorageId: pdfStorageId,
          });

          if (scanDiscoveryEvents.length > 0) {
            reportSlotDiscovery_batch(scanDiscoveryEvents, job.id);
          }
          return "slot_found";
        } else {
          console.error(`[refresh] ❌ Booking échoué post-refresh: ${booking.error}`);
          await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Booking échoué post-refresh: ${booking.error}` });
          return "error";
        }
      }
    }

    // Slot détecté par refresh mais disparu avant qu'on puisse le booker (race condition)
    console.warn(`[refresh] ⚠️ Slot détecté par refresh mais introuvable lors du scan complet (pris par quelqu'un d'autre)`);
    botLog({ applicationId: job.id, step: "refresh_slot_lost", status: "warn", data: { flow: "usa", firstAvailableMonth: refreshResult.firstAvailableMonth, totalRefreshes: refreshResult.totalRefreshes } });
  }

  // Résumé final du refresh continu
  const coverageMin = Math.round(refreshResult.totalDurationMs / 60000);
  console.log(`[refresh] 📊 Résumé: ${refreshResult.totalRefreshes} refreshes, ${refreshResult.windowsCompleted} fenêtres, ${coverageMin} min de couverture, arrêt: ${refreshResult.stopReason}`);

  botLog({ applicationId: job.id, step: "not_found", status: "warn", data: { flow: "usa", ofcCount: ofcList.length, offices: ofcList.map((o) => o.postName), discoveryCount: scanDiscoveryEvents.length, discoveredIgnored: scanDiscoveryEvents.filter(e => e.outcome === "ignored").length, continuousRefresh: { totalRefreshes: refreshResult.totalRefreshes, windowsCompleted: refreshResult.windowsCompleted, durationMin: coverageMin, stopReason: refreshResult.stopReason } } });
  await sendHeartbeat({ applicationId: job.id, result: "not_found" });
  return "not_found";
}
