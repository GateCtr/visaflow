/**
 * Parallel Bootstrap — Résout les données nécessaires après le login en mode parallèle.
 *
 * En mode séquentiel, `usa-scan-main.ts` faisait :
 *   1. getTransformData() → paymentStatus, visaClass, visaCategory, applicantId
 *   2. getApplicationDetails() / /appointments/search → applicantId, visaType, appointmentId
 *   3. getUsaOfcList() → postUserId des OFCs
 *
 * En mode parallèle, le login est fait par `accounts-keep-alive.ts` mais ces étapes
 * étaient SKIPPÉES → le watcher recevait postUserId:0 et ne pouvait pas scanner.
 *
 * Ce module expose `bootstrapAccountData()` qui :
 *   - Résout toutes les données manquantes après le login
 *   - Émet les botLogs (session_start, login, proxy_health_check, ofc_list)
 *   - Retourne les données pour que le watcher les utilise
 */

import type { UsaSession } from "./types.js";
import type { UsaOfc, UsaAppDetails } from "./usa-scan-types.js";
import type { HunterJob } from "../convexClient.js";
import { botLog } from "../convexClient.js";
import { tokenCache, authHeaders } from "./usa-http.js";
import { getUsaTransformData, getUsaOfcList, getUsaApplicationDetails } from "./usa-scan-details.js";
import { USA_MISSION_ID } from "./config.js";

export interface BootstrapResult {
  success: boolean;
  /** Les OFCs résolus avec le vrai postUserId. */
  ofcList: UsaOfc[];
  /** Les détails de l'application (applicantId, visaType, etc.). */
  appDetails: UsaAppDetails | null;
  /** Le visaClass résolu. */
  visaClass: string;
  /** Le visaType résolu. */
  visaType: string;
  /** Le visaCategory pour les requêtes OFC. */
  visaCategory: string;
  /** Erreur si échec. */
  error?: string;
}

/**
 * Résout les données nécessaires pour le scan en mode parallèle.
 * Appelé APRÈS un login réussi pour un compte.
 * Émet les botLogs pour la visibilité dans le dashboard admin.
 */
export async function bootstrapAccountData(
  job: HunterJob,
  username: string,
): Promise<BootstrapResult> {
  const key = username.toLowerCase();
  const cached = tokenCache.get(key);

  if (!cached || Date.now() >= cached.expiresAt) {
    return { success: false, ofcList: [], appDetails: null, visaClass: "", visaType: "", visaCategory: "", error: "TOKEN_EXPIRED" };
  }

  // Construire une session minimale pour les appels API
  const session: UsaSession = {
    accessToken: cached.accessToken,
    refreshToken: cached.refreshToken,
    csrfToken: cached.csrfToken,
    userID: cached.userID,
    fullName: cached.fullName,
    applicationId: null,
    pendingAppoStatus: null,
    missionId: USA_MISSION_ID,
    allowedOfcs: cached.allowedOfcs ?? [],
  };

  // ── Émettre le botLog login ──────────────────────────────────────────────
  botLog({
    applicationId: job.id,
    step: "login",
    status: "ok",
    data: {
      flow: "usa",
      username,
      fullName: cached.fullName,
      userID: cached.userID,
      missionId: USA_MISSION_ID,
      csrfToken: cached.csrfToken ? "présent" : "ABSENT",
    },
  });

  // ── Émettre session_start ────────────────────────────────────────────────
  botLog({
    applicationId: job.id,
    step: "session_start",
    status: "ok",
    data: {
      portal: `USA Portal - ${username}`,
      startedAt: new Date().toISOString(),
    },
  });

  // ── 1. getTransformData → paymentStatus, visaClass, visaCategory ─────────
  let visaClass = "B1/B2";
  let visaType = "NIV";
  let visaCategory = "VisitorVisas";
  let applicantId: string = cached.userID;

  // On utilise l'applicationId du hunterConfig si disponible
  const applicationId = job.hunterConfig.portalApplicationId ?? "";

  if (applicationId) {
    session.applicationId = applicationId;

    try {
      const transformData = await getUsaTransformData(session, applicationId);
      if (transformData) {
        if (transformData.visaClass) visaClass = transformData.visaClass;
        if (transformData.visaCategoryKey) visaCategory = transformData.visaCategoryKey;
        else if (transformData.visaCategory) visaCategory = transformData.visaCategory;
        if (transformData.visaTypeKey) visaType = transformData.visaTypeKey;
        if (transformData.applicantId) applicantId = transformData.applicantId;

        if (transformData.paymentStatus === "VERIFIED") {
          console.log(`[bootstrap] ✅ ${username.slice(0, 12)}… paiement MRV vérifié`);
        } else {
          console.warn(`[bootstrap] ⚠️ ${username.slice(0, 12)}… paiement MRV: ${transformData.paymentStatus ?? "inconnu"}`);
          botLog({
            applicationId: job.id,
            step: "payment_check",
            status: "warn",
            data: { flow: "usa", paymentStatus: transformData.paymentStatus ?? "inconnu" },
          });
        }
      }
    } catch (err) {
      console.warn(`[bootstrap] getTransformData échoué pour ${username.slice(0, 12)}…: ${err}`);
    }
  }

  // ── 2. getApplicationDetails → applicantId, appointmentId ────────────────
  let appDetails: UsaAppDetails | null = null;
  if (applicationId) {
    try {
      appDetails = await getUsaApplicationDetails(session, applicationId);
      if (appDetails) {
        if (appDetails.applicantId) applicantId = appDetails.applicantId;
        if (appDetails.visaType && appDetails.visaType !== "NIV") visaType = appDetails.visaType;
        if (appDetails.visaClass && appDetails.visaClass !== "B1/B2") visaClass = appDetails.visaClass;
        console.log(`[bootstrap] ✅ ${username.slice(0, 12)}… appDetails: applicantId=${applicantId}, visaType=${visaType}, visaClass=${visaClass}`);
      }
    } catch (err) {
      console.warn(`[bootstrap] getApplicationDetails échoué pour ${username.slice(0, 12)}…: ${err}`);
    }
  }

  // Construire les appDetails finales
  if (!appDetails) {
    appDetails = {
      applicantId,
      applicationId,
      visaType,
      visaClass,
      visaCategory,
      locationType: "OFC",
    };
  }

  // ── 3. getUsaOfcList → postUserId ────────────────────────────────────────
  let ofcList: UsaOfc[] = [];
  try {
    ofcList = await getUsaOfcList(session, USA_MISSION_ID, visaClass, visaCategory);

    botLog({
      applicationId: job.id,
      step: "ofc_list",
      status: ofcList.length > 0 ? "ok" : "warn",
      data: {
        flow: "usa",
        count: ofcList.length,
        offices: ofcList.map(o => ({ name: o.postName, postUserId: o.postUserId })),
        visaClass,
        visaType,
      },
    });

    if (ofcList.length > 0) {
      console.log(`[bootstrap] ✅ ${username.slice(0, 12)}… OFCs: ${ofcList.map(o => `${o.postName}(${o.postUserId})`).join(", ")}`);
    } else {
      console.warn(`[bootstrap] ⚠️ ${username.slice(0, 12)}… aucun OFC trouvé`);
    }
  } catch (err) {
    console.warn(`[bootstrap] getOfcList échoué pour ${username.slice(0, 12)}…: ${err}`);
    botLog({
      applicationId: job.id,
      step: "ofc_list",
      status: "fail",
      data: { flow: "usa", error: String(err).slice(0, 200) },
    });
  }

  return {
    success: ofcList.length > 0,
    ofcList,
    appDetails,
    visaClass,
    visaType,
    visaCategory,
    error: ofcList.length === 0 ? "NO_OFC_FOUND" : undefined,
  };
}
