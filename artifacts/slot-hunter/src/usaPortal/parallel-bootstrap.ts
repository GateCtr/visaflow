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
  console.log(`[bootstrap] 🆔 Fingerprint: ${fingerprint.platform}, Chrome/${fingerprint.ua.match(/Chrome\/(\d+)/)?.[1] ?? "?"}`);

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 3 : X-Correlation-key — Simuler une navigation Angular
  // ══════════════════════════════════════════════════════════════════════════
  // L'intercepteur Angular génère un X-Correlation-key au chargement de page
  // et le réutilise pour TOUTES les requêtes de la même navigation.
  // Sans ce header, le portail voit des requêtes "orphelines" = bot.
  resetCorrelationOnAction("schedule-appointment/appointment");
  console.log(`[bootstrap] 🔑 X-Correlation-key initialisé`);

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
    console.log(`[bootstrap] ✅ Proxy OK (${healthResult.latencyMs}ms, IP: ${healthResult.exitIp})`);

    // ════════════════════════════════════════════════════════════════════════
    // ÉTAPE 5 : Proxy guard mid-bootstrap — Surveillance pendant les appels
    // ════════════════════════════════════════════════════════════════════════
    // Si le proxy tombe PENDANT le bootstrap (entre getTransformData et getOfcList),
    // les requêtes suivantes risquent de passer en direct → IP Railway exposée.
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

  // ── ÉTAPE 6 : Pause humaine entre les appels API ──────────────────────────
  await humanDelay();

  // ── 2. getApplicationDetails → applicantId, appointmentId ────────────────
  let appDetails: UsaAppDetails | null = null;
  if (applicationId) {
    try {
      appDetails = await getUsaApplicationDetails(session, applicationId);
      if (appDetails) {
        if (appDetails.applicantId) applicantId = String(appDetails.applicantId);
        if (appDetails.visaType && appDetails.visaType !== "NIV") visaType = appDetails.visaType;
        if (appDetails.visaClass && appDetails.visaClass !== "B1/B2") visaClass = appDetails.visaClass;
        console.log(`[bootstrap] ✅ ${username.slice(0, 12)}… appDetails: applicantId=${applicantId}, visaType=${visaType}, visaClass=${visaClass}`);
      }
    } catch (err) {
      console.warn(`[bootstrap] getApplicationDetails échoué pour ${username.slice(0, 12)}…: ${err}`);
    }
  }

  // Pause humaine avant le prochain appel
  await humanDelay();

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
  // Nouveau referer = nouvelle "page" Angular → renouveler le correlation key
  resetCorrelationOnAction("schedule-appointment/ofc-selection");

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
  // ÉTAPE 7 : Libérer le proxy guard
  // ══════════════════════════════════════════════════════════════════════════
  if (proxyUrl) {
    releaseProxyGuard(username);
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
