import { botLog, type HunterJob } from "../convexClient.js";
import {
  tokenCache,
  usaFetch,
  authHeaders,
  sessionHeaders,
  getBrowserHeaders,
  rotateIproyalSession,
} from "./usa-http.js";
import type { UsaSession, UsaAppointmentRequest } from "./types.js";
import {
  USA_PAYMENT_STATUS_URL,
  USA_APPT_REQUESTS_URL,
  USA_MISSION_ID,
  USA_SHOW_RESCHEDULE_BUTTON_URL,
  USA_SCHEDULED_INFO_URL,
  USA_LANDING_PAGE_URL,
  USA_SEARCH_URL,
  REFERER_REQUESTS,
  REFERER_DASHBOARD,
} from "./config.js";
import { markAccountRestricted, isRestrictedBody } from "./account-restriction.js";
import {
  getPaymentStatusFromCache,
  setPaymentStatusCache,
} from "./scan-behavior.js";

export async function checkUsaAppointmentRequestStatus(
  session: UsaSession,
  portalApplicationId?: string,
): Promise<{
  /**
   * pendingAppoStatus=0 + cancellable=true → "cancellable" (RDV existant, peut être reporté)
   * pendingAppoStatus=0 + applicationId (sans cancellable) → "cancellable" (demande annulable)
   * pendingAppoStatus=0 sans applicationId ni cancellable → "no_request" (aucune demande active)
   * pendingAppoStatus !== 0 (1, 2, 3...) → "pending" (demande active, calendrier ouvert, scan créneaux)
   *
   * NOTE: Le bundle Angular ne distingue PAS les valeurs 1/2/3. Il fait uniquement
   *       `0 !== pendingAppoStatus` → redirect vers appointment/create.
   */
  status: "payment_required" | "no_request" | "pending" | "error" | "cancellable";
  applicationId: string | null;
  pendingAppoStatus: number | null;
  primaryApplicant: string | null;
  message: string;
  /** missionId tel que retourné par le serveur — à propager dans session.missionId */
  missionId: number;
  /** applicantId interne retourné par le serveur — à propager dans session.applicantId.
   * Utilisé à la place de session.userID dans le call ?applicantId= de getApplicationDetails.
   * Peut être number ou string GSS (ex: "ODXJKHXJQMZH"). */
  applicantId?: number | string;
  /** appointmentId interne — à propager dans session.appointmentId.
   * Obligatoire dans le payload PUT /appointments/schedule (bundle: selectedSlotDetails.appointmentId). */
  appointmentId?: number;
  /** applicantUUID interne — à propager dans session.applicantUUID.
   * Obligatoire dans le payload PUT /appointments/schedule (bundle: selectedSlotDetails.applicantUUID). */
  applicantUUID?: number;
}> {
  const headers = authHeaders(session.accessToken, REFERER_REQUESTS, false);
  let data: UsaAppointmentRequest | null = null;

  // ── CORRECTION ANTI-DÉTECTION #1 : Cache TTL 5 min ──────────────────────
  // Le bot appelait cette API ~40 fois en 126s. Un humain la déclenche 1-2 fois.
  // On cache le résultat pour éviter le polling excessif détectable.
  const cacheUsername = [...tokenCache.entries()].find(([, v]) => v.accessToken === session.accessToken)?.[0] ?? "";
  const cached = getPaymentStatusFromCache(cacheUsername);
  if (cached && cached.applicationId) {
    console.log(`[usa] ♻️ paymentStatus depuis cache (évite polling excessif)`);
    // Reconstruire la réponse depuis le cache
    const cachedData = cached.data as UsaAppointmentRequest;
    if (cachedData) {
      data = cachedData;
      // Skip le fetch réseau — utiliser directement les données cachées
      const appId = data.applicationId ?? null;
      const appoStatus = data.pendingAppoStatus ?? null;
      const applicant = data.primaryApplicant ?? null;
      const serverApplicantId: number | string | undefined =
        typeof data.applicantId === "number" ? data.applicantId :
        (typeof data.applicantId === "string" && data.applicantId.length > 0 ? data.applicantId : undefined);
      const serverAppointmentId: number | undefined =
        typeof data.appointmentId === "number" ? data.appointmentId : undefined;
      const serverApplicantUUID: number | undefined =
        typeof data.applicantUUID === "number" ? data.applicantUUID : undefined;
      const serverMissionId = typeof data.missionId === "number" && data.missionId > 0
        ? data.missionId
        : USA_MISSION_ID;

      if (appoStatus === 0 || appoStatus === null) {
        if (data.cancellable === true || appId) {
          return { status: "cancellable", applicationId: appId, pendingAppoStatus: 0, primaryApplicant: applicant, message: `Demande annulable (cache)`, missionId: serverMissionId, applicantId: serverApplicantId, appointmentId: serverAppointmentId, applicantUUID: serverApplicantUUID };
        }
        return { status: "no_request", applicationId: appId, pendingAppoStatus: appoStatus, primaryApplicant: applicant, message: `Aucune demande active (cache)`, missionId: serverMissionId, applicantId: serverApplicantId, appointmentId: serverAppointmentId, applicantUUID: serverApplicantUUID };
      }
      return { status: "pending", applicationId: appId, pendingAppoStatus: appoStatus, primaryApplicant: applicant, message: `Demande active (cache, status=${appoStatus})`, missionId: serverMissionId, applicantId: serverApplicantId, appointmentId: serverAppointmentId, applicantUUID: serverApplicantUUID };
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  try {
    const res = await usaFetch(USA_PAYMENT_STATUS_URL, { method: "GET", headers });
    if (!res.ok) {
      console.error(`[usa] Appointment status HTTP ${res.status}`);
      if (res.status === 401 || res.status === 403) {
        const errBody = await res.text().catch(() => "");
        // Distinction cruciale : "temporarily restricted" ≠ token expiré.
        // Si restreint → NE PAS vider le cache (le JWT reste valide) → juste retourner "error".
        // Le guard isAccountRestricted() dans getUsaSession bloquera les prochains cycles.
        if (res.status === 401 && isRestrictedBody(errBody)) {
          const username = [...tokenCache.entries()].find(([, v]) => v.accessToken === session.accessToken)?.[0] ?? "";
          if (username) markAccountRestricted(username, undefined, undefined);
          console.warn(`[usa] Compte temporairement restreint (401 sur appointment status) — cycles ignorés avec backoff exponentiel`);
          return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: `Compte restreint (401)`, missionId: USA_MISSION_ID };
        }
        // Vraie expiration de token ou 403 : vider le cache pour forcer reconnexion
        const cacheKey = session.accessToken
          ? [...tokenCache.entries()].find(([, v]) => v.accessToken === session.accessToken)?.[0]
          : undefined;
        if (cacheKey) {
          console.warn(`[usa] ${res.status} sur appointment status — cache token vidé pour reconnexion`);
          tokenCache.delete(cacheKey);
          // Forcer rotation IP iProyal : le proxy a probablement expiré ou l'IP est brûlée
          rotateIproyalSession(cacheKey);
        }
      }
      return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: `HTTP ${res.status}`, missionId: USA_MISSION_ID };
    }
    const raw = await res.json();
    if (!raw || typeof raw !== "object") {
      return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Aucune demande de RDV trouvée", missionId: USA_MISSION_ID };
    }

    // ── Sélection de l'application active parmi un tableau potentiel ──────────
    // Le serveur peut retourner un tableau quand le compte a plusieurs dossiers.
    // Priorité de sélection :
    //   1. portalApplicationId fourni → chercher cet ID exactement (cas multi-dossiers)
    //   2. Premier dossier avec pendingAppoStatus > 0 (paiement confirmé, actif)
    //   3. Fallback : raw[0] (comportement original)
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Tableau vide — aucune demande de RDV", missionId: USA_MISSION_ID };
      }
      const list = raw as UsaAppointmentRequest[];

      if (portalApplicationId) {
        // Priorité 1 : l'admin a ciblé un dossier spécifique
        const targeted = list.find((r) => r.applicationId === portalApplicationId);
        if (targeted) {
          console.log(`[usa] 🎯 portalApplicationId trouvé dans le tableau (${list.length} dossier(s)) : ${portalApplicationId}`);
          data = targeted;
        } else {
          console.warn(`[usa] ⚠️ portalApplicationId "${portalApplicationId}" introuvable dans le tableau de ${list.length} dossier(s). IDs disponibles : ${list.map((r) => r.applicationId).join(", ")}`);
          data = list[0];
        }
      } else {
        // Priorité 2 : premier dossier actif (paiement confirmé)
        const active = list.find((r) => typeof r.pendingAppoStatus === "number" && r.pendingAppoStatus > 0);
        if (active) {
          if (list.length > 1) {
            console.log(`[usa] 📋 Compte multi-dossiers (${list.length}) — dossier actif sélectionné : ${active.applicationId} (pendingAppoStatus=${active.pendingAppoStatus})`);
          }
          data = active;
        } else {
          // Fallback : aucun dossier avec paiement confirmé — prendre le premier
          data = list[0];
        }
      }
    } else {
      data = raw as UsaAppointmentRequest;
    }

    if (!data) {
      return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Aucune application sélectionnable", missionId: USA_MISSION_ID };
    }
  } catch (err) {
    console.error("[usa] Erreur appel appointment status:", err);
    return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: String(err), missionId: USA_MISSION_ID };
  }

  const appId = data.applicationId ?? null;
  const appoStatus = data.pendingAppoStatus ?? null;
  const applicant = data.primaryApplicant ?? null;
  // applicantId interne (bundle : selectedSlotDetails.applicantId) — peut être absent de la réponse.
  // IMPORTANT: le portail peut retourner un number (ex: 6012807) OU une string GSS (ex: "ODXJKHXJQMZH")
  // selon la mission. Les deux formes sont valides et doivent être propagées telles quelles.
  const serverApplicantId: number | string | undefined =
    typeof data.applicantId === "number" ? data.applicantId :
    (typeof data.applicantId === "string" && data.applicantId.length > 0 ? data.applicantId : undefined);
  // appointmentId — CRITIQUE pour le payload de booking (bundle: selectedSlotDetails.appointmentId).
  const serverAppointmentId: number | undefined =
    typeof data.appointmentId === "number" ? data.appointmentId : undefined;
  // applicantUUID — requis dans le payload de booking (bundle: selectedSlotDetails.applicantUUID).
  const serverApplicantUUID: number | undefined =
    typeof data.applicantUUID === "number" ? data.applicantUUID : undefined;

  // ── CORRECTION ANTI-DÉTECTION #1 : Mise en cache ────────────────────────
  if (cacheUsername && data) {
    setPaymentStatusCache(cacheUsername, data, appId);
  }
  // ────────────────────────────────────────────────────────────────────────────

  console.log(`[usa] pendingAppoStatus=${appoStatus} applicationId=${appId} applicant=${applicant}${serverApplicantId !== undefined ? ` applicantId=${serverApplicantId}` : ""}${serverAppointmentId !== undefined ? ` appointmentId=${serverAppointmentId}` : ""}${serverApplicantUUID !== undefined ? ` applicantUUID=${serverApplicantUUID}` : ""}`);

  // Interprétation de pendingAppoStatus — tirée du bundle Angular (getAppIdByUserId) :
  //
  // Le bundle ne fait qu'un seul test : `0 !== pendingAppoStatus`
  //   - Si pendingAppoStatus !== 0 (1, 2, 3, etc.) → navigate to appointment/create
  //     = l'utilisateur a une demande active, le calendrier est ouvert, prêt à sélectionner un créneau
  //   - Si pendingAppoStatus === 0 → "The Application has been completed successfully"
  //     = pas de demande active OU demande terminée, appel synchronizeAccount()
  //
  // IL N'Y A PAS de distinction entre 1, 2, 3 dans le bundle.
  // pendingAppoStatus=1 NE signifie PAS "créneau déjà bookté" — c'est simplement
  // une valeur non-nulle qui indique que la demande est active et le scan est possible.
  //
  // Pour détecter un créneau réellement bookté, il faut interroger showRescheduleButton
  // ou scheduledappointmentInfo qui retournent les RDV actifs avec appointmentId.

  // missionId retourné par le serveur (dans la réponse JSON) — fait office de cookie "missionId" du portail.
  const serverMissionId = typeof data.missionId === "number" && data.missionId > 0
    ? data.missionId
    : USA_MISSION_ID;

  if (appoStatus === 0 || appoStatus === null) {
    // pendingAppoStatus=0 signifie "aucune demande active ou paiement non confirmé"
    // D'après le bundle: 0 !== pendingAppoStatus → redirection vers création de RDV
    // Donc pendingAppoStatus=0 → pas de redirection

    // CAS 1 : pendingAppoStatus=0 + cancellable=true (avec ou sans applicationId)
    // La réponse API peut être simplement {"pendingAppoStatus":0,"cancellable":true}
    // sans applicationId — le portail Angular considère ce cas comme un RDV existant
    // qui peut être reporté (affiche le bouton "Reschedule").
    // L'applicationId sera résolu via showRescheduleButton / scheduledappointmentInfo.
    if (data.cancellable === true || appId) {
      const reason = data.cancellable === true
        ? `cancellable=true${appId ? ` + applicationId=${appId}` : " (sans applicationId — sera résolu via API)"}`
        : `applicationId=${appId} présent`;
      console.log(`[usa] ⚠️ pendingAppoStatus=0 mais ${reason} → demande annulable/reschedule`);
      return {
        status: "cancellable",
        applicationId: appId,
        pendingAppoStatus: 0,
        primaryApplicant: applicant,
        message: `Demande annulable (pendingAppoStatus=0, ${reason})`,
        missionId: serverMissionId,
        applicantId: serverApplicantId,
        appointmentId: serverAppointmentId,
        applicantUUID: serverApplicantUUID,
      };
    }

    console.log(`[usa] pendingAppoStatus=${appoStatus} → aucune demande active ou paiement non confirmé`);
    return {
      status: "no_request",
      applicationId: appId,
      pendingAppoStatus: appoStatus,
      primaryApplicant: applicant,
      message: `Aucune demande active ou paiement non confirmé (pendingAppoStatus: ${appoStatus})`,
      missionId: serverMissionId,
      applicantId: serverApplicantId,
      appointmentId: serverAppointmentId,
      applicantUUID: serverApplicantUUID,
    };
  }

  // Toute valeur non-nulle (1, 2, 3, etc.) = demande active, calendrier ouvert → scanner les créneaux
  // Le bundle Angular ne distingue pas les valeurs : `0 !== pendingAppoStatus` → appointment/create
  return {
    status: "pending",
    applicationId: appId,
    pendingAppoStatus: appoStatus,
    primaryApplicant: applicant,
    message: `Demande active (status=${appoStatus}) — scan créneaux pour ${applicant}`,
    missionId: serverMissionId,
    applicantId: serverApplicantId,
    appointmentId: serverAppointmentId,
    applicantUUID: serverApplicantUUID,
  };
}

export async function getUsaAppointmentRequests(session: UsaSession): Promise<UsaAppointmentRequest[]> {
  // visauserapi requiert le cookie missionId (comme tous les endpoints de slot).
  // On utilise sessionHeaders avec applicationId vide si non résolu — seul missionId compte ici.
  // Referer = page "Requests" du dashboard (REFERER_MANAGE_APT → 401 sur visauserapi).
  const appIdForCookie = session.applicationId ?? "";
  const headers = sessionHeaders(session.accessToken, appIdForCookie, session.missionId, REFERER_REQUESTS, false);

  try {
    const res = await usaFetch(USA_APPT_REQUESTS_URL, { method: "GET", headers });
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { /* ignore */ }
      console.error(`[usa] Appointment requests HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
      return [];
    }
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : [raw];
    return list as UsaAppointmentRequest[];
  } catch (err) {
    console.error("[usa] Erreur appel appointment requests:", err);
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// RÉSOLUTION "CANCELLABLE" — API-first (remplace Playwright)
//
// Quand le workflow est terminé (pendingAppoStatus=0, cancellable=true), le portail
// Angular affiche un bouton "Reschedule". L'applicationId ne vient pas de
// getUserHistoryApplicantPaymentStatus dans cet état.
//
// Stratégie API-first (3 endpoints du bundle Angular, Bearer seulement) :
//  1. GET /appointments/scheduledappointmentInfo  → liste des RDV planifiés
//  2. GET /appointments/getLandingPageDeatils      → fallback données dashboard
//  3. POST /appointments/search                    → détails complets si appId trouvé
//
// Met à jour session.applicationId, session.appointmentId, session.applicantId,
// session.applicantUUID si trouvés.
// Retourne "proceed" (→ scan), "not_found" (→ skip), "error".
// ────────────────────────────────────────────────────────────────────────────

/**
 * Génère un X-Correlation-key de 15 chars alphanumériques (même algo que generateCorrelationId()
 * dans l'intercepteur Angular du bundle).
 */
function corrId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 15; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Utilisé par `runUsaApiSession` pour le flux cancellable + reschedule. */
export async function fetchCancellableSessionIds(
  session: UsaSession,
  job: HunterJob,
): Promise<"proceed" | "not_found" | "error"> {
  const token = session.accessToken;
  console.log("[cancellable] Tentative API-first pour récupérer applicationId/appointmentId...");

  // Headers standards Angular (l'intercepteur injecte X-Correlation-key + Authorization)
  const stdH: Record<string, string> = {
    ...getBrowserHeaders(),
    "Authorization":     `Bearer ${token}`,
    "Content-Type":      "application/json",
    "Accept":            "application/json",
    "X-Correlation-key": corrId(),
    "Referer":           REFERER_DASHBOARD,
  };

  // ── Étape 0 (PRIORITÉ) : GET showRescheduleButton ──────────────────────────
  // Découvert via capture Playwright du flux réel Angular.
  // C'est l'endpoint que le portail appelle sur la page "Mes rendez-vous" pour
  // déterminer quel dossier peut être reschedule. Il retourne le BON applicationId
  // (celui avec le RDV actif), contrairement à scheduledappointmentInfo qui peut
  // retourner un ancien dossier.
  // Retourne : [{applicationId, appointmentId, showRescheduleButton, rescheduleLimit, showCancelButton}]
  let foundViaRescheduleBtn = false;
  try {
    console.log("[cancellable] GET showRescheduleButton...");
    const res = await usaFetch(USA_SHOW_RESCHEDULE_BUTTON_URL, { method: "GET", headers: stdH });
    console.log(`[cancellable] showRescheduleButton → HTTP ${res.status}`);
    if (res.ok) {
      const raw = await res.text();
      console.log(`[cancellable] showRescheduleButton réponse: ${raw.slice(0, 500)}`);
      let data: unknown;
      try { data = JSON.parse(raw); } catch { /* non-JSON */ }

      const items: Record<string, unknown>[] = Array.isArray(data) ? data as Record<string, unknown>[] :
        (data && typeof data === "object" ? [data as Record<string, unknown>] : []);

      // Chercher l'entrée avec showRescheduleButton=true
      for (const item of items) {
        if (item.showRescheduleButton !== true) continue;

        const appId = typeof item.applicationId === "string" ? item.applicationId : null;
        const apptId = typeof item.appointmentId === "number" ? item.appointmentId :
          (typeof item.appointmentId === "string" ? parseInt(item.appointmentId as string, 10) : undefined);
        // appointmentUUID est une string UUID — nécessaire pour le Referer dynamique du reschedule
        const apptUUID = typeof item.appointmentUUID === "string" ? item.appointmentUUID : undefined;

        if (appId) {
          session.applicationId = appId;
          foundViaRescheduleBtn = true;
          console.log(`[cancellable] ✅ applicationId depuis showRescheduleButton: ${appId}`);
        }
        if (apptId !== undefined && !isNaN(apptId)) {
          session.appointmentId = apptId;
          console.log(`[cancellable] ✅ appointmentId depuis showRescheduleButton: ${apptId}`);
        }
        if (apptUUID) {
          session.appointmentUUID = apptUUID;
          console.log(`[cancellable] ✅ appointmentUUID depuis showRescheduleButton: ${apptUUID}`);
        }
        if (foundViaRescheduleBtn) break;
      }
    } else {
      const errBody = await res.text().catch(() => "");
      console.warn(`[cancellable] showRescheduleButton HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[cancellable] showRescheduleButton erreur réseau: ${err}`);
  }

  // Si showRescheduleButton a donné les IDs, on peut skip les étapes suivantes
  if (foundViaRescheduleBtn && session.applicationId && session.appointmentId !== undefined) {
    console.log(`[cancellable] ✅ Résolution via showRescheduleButton — applicationId=${session.applicationId} appointmentId=${session.appointmentId}`);
    botLog({
      applicationId: job.id,
      step: "scan",
      status: "ok",
      data: {
        flow: "usa",
        phase: "cancellable_api_ok",
        source: "showRescheduleButton",
        applicationId: session.applicationId,
        appointmentId: session.appointmentId,
        applicantId: session.applicantId,
      },
    });
    return "proceed";
  }

  // ── Étape 1 (fallback) : GET scheduledappointmentInfo ──────────────────────
  // Retourne la liste des RDV "scheduled" de l'utilisateur connecté.
  // Ce tableau contient applicationId + appointmentId + appointmentUUID.
  let foundViaInfo = false;
  try {
    console.log("[cancellable] GET scheduledappointmentInfo...");
    const res = await usaFetch(USA_SCHEDULED_INFO_URL, { method: "GET", headers: stdH });
    console.log(`[cancellable] scheduledappointmentInfo → HTTP ${res.status}`);
    if (res.ok) {
      const raw = await res.text();
      console.log(`[cancellable] scheduledappointmentInfo réponse: ${raw.slice(0, 500)}`);
      let data: unknown;
      try { data = JSON.parse(raw); } catch { /* non-JSON */ }

      const items: Record<string, unknown>[] = Array.isArray(data) ? data as Record<string, unknown>[] :
        (data && typeof data === "object" ? [data as Record<string, unknown>] : []);

      for (const item of items) {
        const appId = typeof item.applicationId === "string" ? item.applicationId : null;
        const apptId = typeof item.appointmentId === "number" ? item.appointmentId :
          (typeof item.appointmentId === "string" ? parseInt(item.appointmentId, 10) : undefined);
        const applicantId = typeof item.applicantId === "number" ? item.applicantId :
          (typeof item.applicantId === "string" ? parseInt(item.applicantId, 10) : undefined);
        const applicantUUID = typeof item.applicantUUID === "number" ? item.applicantUUID :
          (typeof item.applicantUUID === "string" ? parseInt(item.applicantUUID, 10) : undefined);
        const appointmentUUID = typeof item.appointmentUUID === "string" ? item.appointmentUUID : undefined;

        if (appId) {
          session.applicationId = appId;
          foundViaInfo = true;
          console.log(`[cancellable] ✅ applicationId depuis scheduledappointmentInfo: ${appId}`);
        }
        if (apptId !== undefined && !isNaN(apptId)) {
          session.appointmentId = apptId;
          console.log(`[cancellable] ✅ appointmentId depuis scheduledappointmentInfo: ${apptId}`);
        }
        if (applicantId !== undefined && !isNaN(applicantId)) {
          session.applicantId = applicantId;
        }
        if (applicantUUID !== undefined && !isNaN(applicantUUID)) {
          session.applicantUUID = applicantUUID;
        }
        if (appointmentUUID) {
          session.appointmentUUID = appointmentUUID;
          console.log(`[cancellable] ✅ appointmentUUID depuis scheduledappointmentInfo: ${appointmentUUID}`);
        }
        if (foundViaInfo) break;
      }
    } else {
      const errBody = await res.text().catch(() => "");
      console.warn(`[cancellable] scheduledappointmentInfo HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[cancellable] scheduledappointmentInfo erreur réseau: ${err}`);
  }

  // ── Étape 2 : GET getLandingPageDeatils (fallback) ──────────────────────────
  // Dashboard data — retourne les infos de la demande en cours incluant applicationId.
  // Nécessite le header LanguageId (cf. intercepteur Angular dans le bundle).
  if (!session.applicationId) {
    try {
      console.log("[cancellable] Fallback GET getLandingPageDeatils...");
      const landingH = {
        ...stdH,
        "X-Correlation-key": corrId(),
        "LanguageId": "1",
      };
      const res = await usaFetch(USA_LANDING_PAGE_URL, { method: "GET", headers: landingH });
      console.log(`[cancellable] getLandingPageDeatils → HTTP ${res.status}`);
      if (res.ok) {
        const raw = await res.text();
        console.log(`[cancellable] getLandingPageDeatils réponse: ${raw.slice(0, 500)}`);
        // Chercher applicationId dans la réponse JSON (quel que soit le format)
        const appIdMatch = raw.match(/"applicationId"\s*:\s*"([^"]+)"/);
        if (appIdMatch) {
          session.applicationId = appIdMatch[1];
          console.log(`[cancellable] ✅ applicationId depuis getLandingPageDeatils: ${session.applicationId}`);
        }
        const apptIdMatch = raw.match(/"appointmentId"\s*:\s*(\d+)/);
        if (apptIdMatch && session.appointmentId === undefined) {
          session.appointmentId = parseInt(apptIdMatch[1], 10);
          console.log(`[cancellable] ✅ appointmentId depuis getLandingPageDeatils: ${session.appointmentId}`);
        }
      }
    } catch (err) {
      console.warn(`[cancellable] getLandingPageDeatils erreur: ${err}`);
    }
  }

  if (!session.applicationId) {
    console.warn("[cancellable] ❌ applicationId introuvable via les 2 endpoints dashboard");
    botLog({ applicationId: job.id, step: "scan", status: "warn", data: { flow: "usa", phase: "cancellable_api_no_appid" } });
    return "not_found";
  }

  // ── Étape 3 : POST /appointments/search — détails complets du RDV ────────────
  // Si on a l'applicationId, on appelle /search pour récupérer appointmentId exact +
  // applicantId + applicantUUID (correspondant à l'entrée "SCHEDULED"/"RESCHEDULED").
  if (session.appointmentId === undefined || session.applicantId === undefined) {
    try {
      console.log(`[cancellable] POST /appointments/search (applicationId=${session.applicationId})...`);
      // Capture réseau : le portail filtre par applicationId ET appointmentUUID quand disponible
      const searchObjects: Array<Record<string, string>> = [
        { key: "applicationId", value: session.applicationId, feildType: "STRING", operation: "EQUAL" },
      ];
      if (session.appointmentUUID) {
        searchObjects.push({ key: "appointmentUUID", value: session.appointmentUUID, feildType: "STRING", operation: "EQUAL" });
      }
      const searchPayload = { operation: "AND", searchObjects };
      const searchH = {
        ...stdH,
        "X-Correlation-key": corrId(),
        "Cookie": `APP_ID_TOBE=${session.applicationId}; missionId=${session.missionId}`,
      };
      const res = await usaFetch(USA_SEARCH_URL, {
        method: "POST",
        headers: searchH,
        body: JSON.stringify(searchPayload),
      });
      console.log(`[cancellable] /appointments/search → HTTP ${res.status}`);
      if (res.ok) {
        const raw = await res.text();
        console.log(`[cancellable] /appointments/search réponse: ${raw.slice(0, 600)}`);
        let rows: Record<string, unknown>[] = [];
        try { rows = JSON.parse(raw) as Record<string, unknown>[]; } catch { /* non-JSON */ }

        // Filtrer SCHEDULED ou RESCHEDULED + type POST (RDV ambassade) ou OFC
        const scheduled = rows.filter(r =>
          (r.appointmentStatus === "SCHEDULED" || r.appointmentStatus === "RESCHEDULED") &&
          (r.appointmentLocationType === "POST" || r.appointmentLocationType === "OFC")
        );
        const target = scheduled[0] ?? rows[0];

        if (target) {
          if (typeof target.appointmentId === "number" && session.appointmentId === undefined) {
            session.appointmentId = target.appointmentId;
            console.log(`[cancellable] ✅ appointmentId depuis /search: ${session.appointmentId}`);
          }
          if (typeof target.applicantId === "number" && session.applicantId === undefined) {
            session.applicantId = target.applicantId;
            console.log(`[cancellable] ✅ applicantId depuis /search: ${session.applicantId}`);
          }
          // applicantId peut aussi être une string GSS (ex: "RQUP3HHVQHOD")
          if (typeof target.applicantId === "string" && target.applicantId.length > 0 && session.applicantId === undefined) {
            session.applicantId = target.applicantId;
            console.log(`[cancellable] ✅ applicantId (GSS) depuis /search: ${session.applicantId}`);
          }
          const uuid = target.applicantUUID ?? target.appointmentUUID;
          if (typeof uuid === "number" && session.applicantUUID === undefined) {
            session.applicantUUID = uuid;
            console.log(`[cancellable] ✅ applicantUUID depuis /search: ${uuid}`);
          }
          // appointmentUUID est une string UUID (ex: "0cbcba2c-a420-4d74-b99a-d7431aaa6897")
          if (typeof target.appointmentUUID === "string" && !session.appointmentUUID) {
            session.appointmentUUID = target.appointmentUUID;
            console.log(`[cancellable] ✅ appointmentUUID depuis /search: ${session.appointmentUUID}`);
          }
        }
      } else {
        console.warn(`[cancellable] /appointments/search HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[cancellable] /appointments/search erreur: ${err}`);
    }
  }

  console.log(
    `[cancellable] ✅ Résolution API terminée — applicationId=${session.applicationId} ` +
    `appointmentId=${session.appointmentId ?? "N/A"} applicantId=${session.applicantId ?? "N/A"}`
  );
  botLog({
    applicationId: job.id,
    step: "scan",
    status: "ok",
    data: {
      flow: "usa",
      phase: "cancellable_api_ok",
      applicationId: session.applicationId,
      appointmentId: session.appointmentId,
      applicantId: session.applicantId,
    },
  });
  return "proceed";
}
