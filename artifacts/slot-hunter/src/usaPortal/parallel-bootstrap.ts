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
 *   - Initialise les headers de session (Accept-Encoding/Language fixés)
 *   - Applique le fingerprint cycling (cohérence UA avec le login)
 *   - Génère le X-Correlation-key (anti-détection critique)
 *   - Vérifie la santé du proxy avant les appels API
 *   - Active le proxy guard mid-bootstrap
 *   - Résout toutes les données manquantes après le login
 *   - Émet les botLogs (session_start, login, proxy_health_check, ofc_list)
 *   - Retourne les données pour que le watcher les utilise
 */

import type { UsaSession } from "./types.js";
import type { UsaOfc, UsaAppDetails } from "./usa-scan-types.js";
import type { HunterJob } from "../convexClient.js";
import { botLog } from "../convexClient.js";
import {
  tokenCache,
  initSessionHeaders,
  resetCorrelationOnAction,
  setAccountFingerprint,
  updateSessionActivity,
  setUsaSessionProxy,
} from "./usa-http.js";
import { getUsaTransformData, getUsaOfcList, getUsaApplicationDetails } from "./usa-scan-details.js";
import { preFlightProxyCheck } from "./proxy-health-check.js";
import { initProxyGuard, releaseProxyGuard } from "./proxy-session-guard.js";
import { getFingerprintForToday } from "./zero-risk-strategy.js";
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
 * Extrait le header Sec-CH-UA depuis un User-Agent string.
 * Chrome envoie "Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"
 */
function extractSecChUaFromUserAgent(ua: string): string {
  const edgeMatch = ua.match(/Edg\/(\d+)/);
  if (edgeMatch) {
    return `"Chromium";v="${edgeMatch[1]}", "Microsoft Edge";v="${edgeMatch[1]}", "Not-A.Brand";v="8"`;
  }
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const version = chromeMatch?.[1] ?? "136";
  return `"Chromium";v="${version}", "Google Chrome";v="${version}", "Not-A.Brand";v="8"`;
}

/**
 * Pause aléatoire entre les appels API pour simuler un comportement humain.
 * Un vrai navigateur ne fait pas 3 requêtes en 50ms — il y a des rendus,
 * des pauses de lecture, des animations Angular entre les pages.
 */
function humanDelay(): Promise<void> {
  const delay = 800 + Math.random() * 1200; // 800-2000ms
  return new Promise(r => setTimeout(r, delay));
}

/**
 * Résout les données nécessaires pour le scan en mode parallèle.
 * Appelé APRÈS un login réussi pour un compte.
 * Reproduit fidèlement les étapes anti-détection de impl.ts (mode séquentiel)
 * mais sans les mécanismes de timing gérés par le scheduler parallèle.
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

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 1 : initSessionHeaders — Fixer Accept-Encoding/Language pour la session
  // ══════════════════════════════════════════════════════════════════════════
  // Un vrai Chrome envoie TOUJOURS les mêmes Accept-Encoding et Accept-Language
  // pendant toute sa session. Randomiser par requête = signal bot détectable par
  // un WAF qui corrèle "même JWT mais Accept-Language change toutes les 3min".
  initSessionHeaders(username);

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 2 : Fingerprint cycling — Cohérence UA avec le login
  // ══════════════════════════════════════════════════════════════════════════
  // Le login (accounts-keep-alive.ts) applique un fingerprint cyclé par jour.
  // Le bootstrap doit utiliser le MÊME fingerprint pour que le JWT et les requêtes
  // aient un UA cohérent. Sans ça: même JWT, deux UA différents = signal bot.
  const fingerprint = getFingerprintForToday(username);
  const adaptedFingerprint = {
    ua: fingerprint.ua,
    chUa: extractSecChUaFromUserAgent(fingerprint.ua),
    platform: `"${fingerprint.platform === "Windows" ? "Windows" : "macOS"}"`,
  };
  setAccountFingerprint(username, adaptedFingerprint);

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 3 : X-Correlation-key — Simuler une navigation Angular
  // ══════════════════════════════════════════════════════════════════════════
  resetCorrelationOnAction("schedule-appointment/appointment", username);

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 4 : Pre-flight proxy health check
  // ══════════════════════════════════════════════════════════════════════════
  // Si le proxy est mort, les appels API vont timeout silencieusement et le
  // bootstrap retournera NO_OFC_FOUND alors que c'est un problème réseau.
  const proxyUrl = cached.proxyUrl;
  if (proxyUrl) {
    const healthResult = await preFlightProxyCheck(proxyUrl, job.id);
    if (!healthResult.healthy) {
      console.error(`[bootstrap] ❌ Proxy mort avant bootstrap: ${healthResult.error}`);
      botLog({
        applicationId: job.id,
        step: "bootstrap_proxy_check",
        status: "fail",
        data: {
          flow: "usa",
          username,
          latencyMs: healthResult.latencyMs,
          error: healthResult.error,
        },
      });
      return {
        success: false,
        ofcList: [],
        appDetails: null,
        visaClass: "",
        visaType: "",
        visaCategory: "",
        error: `PROXY_DEAD: ${healthResult.error}`,
      };
    }
    console.log(`[bootstrap] ✅ Proxy OK (${healthResult.latencyMs}ms)`);
    initProxyGuard(username, proxyUrl, healthResult.exitIp ?? undefined);
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

  // ── Activer le proxy du compte pour usaFetch() (legacy global singleton) ──
  // Les appels API (getUsaTransformData, etc.) utilisent usaFetch() qui route
  // via _usaProxyUrl. Sans ça, les requêtes partent sans proxy ou avec un proxy stale.
  setUsaSessionProxy(proxyUrl);

  // ── Activer ce compte comme session courante pour getBrowserHeaders() ────
  // Sans ça, getSessionAcceptHeaders() et getStickyCorrelationId() utilisent
  // le fallback global au lieu des valeurs per-account qu'on vient d'initialiser.
  updateSessionActivity(username);

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

  // ══════════════════════════════════════════════════════════════════════════
  // APPELS API — avec pauses humaines entre chaque étape
  // ══════════════════════════════════════════════════════════════════════════

  // ── 1. getTransformData → paymentStatus, visaClass, visaCategory ─────────
  let visaClass = "B1/B2";
  let visaType = "NIV";
  let visaCategory = "VisitorVisas";
  let applicantId: string = String(cached.userID);

  // ── 0. Résoudre applicationId ─────────────────────────────────────────────
  // Stratégie en 3 étapes :
  //   1. portalApplicationId (config admin explicite)
  //   2. checkUsaAppointmentRequestStatus (dossiers en attente, pendingAppoStatus!=0)
  //   3. fetchCancellableSessionIds/showRescheduleButton (dossiers avec RDV existant, pendingAppoStatus=0)
  // L'étape 3 est CRITIQUE pour les comptes en mode reschedule (cancellable=true).
  const { checkUsaAppointmentRequestStatus, fetchCancellableSessionIds } = await import("./appointments-api.js");
  let applicationId = job.hunterConfig.portalApplicationId ?? "";

  if (!applicationId) {
    // Étape 2 : appointmentRequestStatus (marche si pendingAppoStatus != 0)
    try {
      const requestStatus = await checkUsaAppointmentRequestStatus(session, undefined);
      if (requestStatus.applicationId) {
        applicationId = requestStatus.applicationId;
        session.applicationId = applicationId;
        console.log(`[bootstrap] ✅ ${username.slice(0, 12)}… applicationId résolu via appointmentRequestStatus: ${applicationId}`);
      }
    } catch (err) {
      console.warn(`[bootstrap] checkUsaAppointmentRequestStatus échoué pour ${username.slice(0, 12)}…: ${err}`);
    }
  } else {
    session.applicationId = applicationId;
  }

  // Étape 3 : fetchCancellableSessionIds (marche si pendingAppoStatus=0, cancellable=true)
  // Appelle showRescheduleButton + scheduledappointmentInfo + /appointments/search
  if (!applicationId) {
    console.log(`[bootstrap] 🔄 ${username.slice(0, 12)}… applicationId non trouvé via appointmentRequestStatus — tentative showRescheduleButton/search...`);
    try {
      const result = await fetchCancellableSessionIds(session, job);
      if (result === "proceed" && session.applicationId) {
        applicationId = session.applicationId;
        console.log(`[bootstrap] ✅ ${username.slice(0, 12)}… applicationId résolu via fetchCancellableSessionIds: ${applicationId}`);
      } else {
        console.warn(`[bootstrap] fetchCancellableSessionIds retourné: ${result} (applicationId=${session.applicationId ?? "null"})`);
        // Dernière tentative : si session.applicationId a été peuplé même avec result != "proceed"
        if (session.applicationId) {
          applicationId = session.applicationId;
        }
      }
    } catch (err) {
      console.warn(`[bootstrap] fetchCancellableSessionIds échoué pour ${username.slice(0, 12)}…: ${err}`);
    }
  }

  if (!applicationId) {
    console.error(`[bootstrap] ❌ ${username.slice(0, 12)}… applicationId introuvable (3 stratégies épuisées) — bootstrap impossible`);
    setUsaSessionProxy(undefined);
    if (proxyUrl) releaseProxyGuard(username);
    return { success: false, ofcList: [], appDetails: null, visaClass: "", visaType: "", visaCategory: "", error: "NO_APPLICATION_ID" };
  }

  // ── 1. getTransformData → paymentStatus, visaClass, visaCategory, applicantId GSS
  if (applicationId) {
    try {
      const transformData = await getUsaTransformData(session, applicationId);
      if (transformData) {
        if (transformData.visaClass) visaClass = transformData.visaClass;
        if (transformData.visaCategoryKey) visaCategory = transformData.visaCategoryKey;
        else if (transformData.visaCategory) visaCategory = transformData.visaCategory;
        if (transformData.visaTypeKey) visaType = transformData.visaTypeKey;
        if (transformData.applicantId) {
          applicantId = transformData.applicantId;
          session.applicantId = transformData.applicantId;
        }

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

  // ── ÉTAPE 6 : Pause humaine entre les appels API ──────────────────────────
  await humanDelay();

  // ── 2. /appointments/search → applicantId, visaType, visaClass, appointmentId
  // C'est l'appel CRITIQUE que l'ancien système faisait AVANT getFirstAvailableMonth.
  // Sans lui, le payload du scan contient des valeurs invalides (applicantId numérique
  // au lieu du format GSS string, visaType/Class incorrects).
  const { USA_SEARCH_URL } = await import("./config.js");
  let searchDetails: {
    visaType?: string;
    visaClass?: string;
    applicantId?: string;
    appointmentId?: number;
    appointmentLocationType?: string;
    visaCategory?: string;
  } | null = null;

  if (applicationId) {
    try {
      const searchPayload = {
        operation: "AND",
        searchObjects: [
          { key: "applicationId", value: applicationId, feildType: "STRING", operation: "EQUAL" },
        ],
      };
      const { authHeaders: getAuthHeaders } = await import("./usa-http.js");
      const searchHeaders = getAuthHeaders(cached.accessToken, "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment", true, username);
      const { usaFetch } = await import("./usa-http.js");
      const searchRes = await usaFetch(USA_SEARCH_URL, {
        method: "POST",
        headers: searchHeaders,
        body: JSON.stringify(searchPayload),
      });
      if (searchRes.ok) {
        const searchRaw = await searchRes.text();
        let searchRows: Record<string, unknown>[] = [];
        try { searchRows = JSON.parse(searchRaw) as Record<string, unknown>[]; } catch { /* non-JSON */ }
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
          if (searchDetails.applicantId) applicantId = searchDetails.applicantId;
          if (searchDetails.visaType) visaType = searchDetails.visaType;
          if (searchDetails.visaClass) visaClass = searchDetails.visaClass;
          if (searchDetails.visaCategory) visaCategory = searchDetails.visaCategory;
          console.log(`[bootstrap] ✅ ${username.slice(0, 12)}… search: ${searchDetails.applicantId} ${searchDetails.visaClass} ${searchDetails.appointmentLocationType ?? "OFC"}`);
        }
      }
    } catch (err) {
      console.warn(`[bootstrap] /appointments/search échoué pour ${username.slice(0, 12)}…: ${err}`);
    }
  }

  await humanDelay();

  // ── 3. getApplicationDetails → enrichissement (mais search reste la source de vérité)
  let appDetailsRaw: UsaAppDetails | null = null;
  if (applicationId) {
    try {
      appDetailsRaw = await getUsaApplicationDetails(session, applicationId);
      if (appDetailsRaw) {
        // FIX-22: Si getApplicationDetails retourne des undefined partout (dossier NEW sans RDV),
        // NE PAS l'utiliser — le search est la source fiable.
        // Le 404 sur getFirstAvailableMonth vient du fait qu'on utilisait un objet avec
        // applicantId=undefined au lieu des vraies valeurs du search.
        const hasUsableData = appDetailsRaw.applicantId && appDetailsRaw.visaType;
        if (hasUsableData) {
          if (appDetailsRaw.applicantId && !searchDetails?.applicantId) applicantId = String(appDetailsRaw.applicantId);
          if (appDetailsRaw.visaType && appDetailsRaw.visaType !== "NIV" && !searchDetails?.visaType) visaType = appDetailsRaw.visaType;
          if (appDetailsRaw.visaClass && appDetailsRaw.visaClass !== "B1/B2" && !searchDetails?.visaClass) visaClass = appDetailsRaw.visaClass;
        } else {
          appDetailsRaw = null; // Forcer le fallback search
        }
      }
    } catch (err) {
      console.warn(`[bootstrap] getApplicationDetails échoué pour ${username.slice(0, 12)}…: ${err}`);
    }
  }

  // Pause humaine avant le prochain appel
  await humanDelay();

  // Construire les appDetails finales — TOUJOURS depuis le search + enrichissement getApplicationDetails
  let appDetails: UsaAppDetails;
  if (appDetailsRaw && appDetailsRaw.applicantId) {
    // getApplicationDetails a retourné des données exploitables — les utiliser comme base
    appDetails = appDetailsRaw;
    // Propager les valeurs du search si manquantes dans appDetails
    if (searchDetails?.appointmentLocationType && !appDetails.locationType) {
      appDetails.locationType = searchDetails.appointmentLocationType;
    }
    if (searchDetails?.appointmentLocationType && !appDetails.appointmentLocationType) {
      appDetails.appointmentLocationType = searchDetails.appointmentLocationType;
    }
  } else {
    // getApplicationDetails absent ou inutilisable → construire depuis le search
    appDetails = {
      applicantId,
      applicationId,
      visaType,
      visaClass,
      visaCategory,
      locationType: searchDetails?.appointmentLocationType ?? "OFC",
      appointmentLocationType: searchDetails?.appointmentLocationType,
      appointmentId: searchDetails?.appointmentId,
    };
  }

  // ── 3. getUsaOfcList → postUserId ────────────────────────────────────────
  // Nouveau referer = nouvelle "page" Angular → renouveler le correlation key
  resetCorrelationOnAction("schedule-appointment/ofc-selection", username);

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

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 7 : Libérer le proxy guard + reset proxy global
  // ══════════════════════════════════════════════════════════════════════════
  if (proxyUrl) {
    releaseProxyGuard(username);
  }
  // Reset le proxy global pour ne pas polluer d'autres flows (mode séquentiel coexistant)
  setUsaSessionProxy(undefined);

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
