import { proxyPool } from "../browser.js";
import { sendHeartbeat, botLog, type HunterJob } from "../convexClient.js";
import {
  logHumanBehaviorStart,
  logHumanBehaviorEnd,
} from "../humanBehavior.js";

import {
  tokenCache,
  setUsaSessionProxy,
  USA_UA_POOL,
  setActiveSessionUaFromPoolIndex,
  isCachedTokenValid,
  sendKeepAliveIfNeeded,
  getActiveSessionUaLogLabel,
  usaFetch,
  authHeaders,
  getStickyUaForAccount,
  makeIproyalStickyUrl,
} from "./usa-http.js";
import { scanUsaSlotsViaAPI } from "./scan-slot-booking.js";
import {
  checkUsaAppointmentRequestStatus,
  fetchCancellableSessionIds,
} from "./appointments-api.js";
import { logoutUsaPortal } from "./usa-auth.js";
import { getUsaSession } from "./usa-session.js";

import type { SessionResult, UsaSession } from "./types.js";
import {
  isAccountRestricted,
  getAccountRestrictionDeadline,
} from "./account-restriction.js";
import {
  MAX_HUMAN_SESSION_MS,
  MIN_SESSION_BREAK_MS,
  MAX_SESSION_BREAK_MS,
  NIGHT_PAUSE_START_HOUR,
  NIGHT_PAUSE_START_MINUTE,
  NIGHT_PAUSE_END_HOUR,
  NIGHT_PAUSE_END_MINUTE,
  HUMAN_ACTIVE_START_HOUR,
  HUMAN_ACTIVE_END_HOUR,
} from "./config.js";

export async function runUsaApiSession(job: HunterJob): Promise<SessionResult> {
  const { embassyUsername: username, embassyPassword: password, twoCaptchaApiKey } = job.hunterConfig;
  const sessionStartTime = Date.now();
  let result: SessionResult = "error";

  // Log le début du comportement humain
  logHumanBehaviorStart(job.id, `USA Portal - ${username}`);
  
  try {
    if (!username || !password) {
      console.error("[usa] Identifiants portail manquants dans hunterConfig");
      result = "error";
      return result;
    }

    // ── Délai minimum entre les scans pour éviter la détection Cognito ──────
    // AWS Cognito détecte les patterns trop réguliers et les sessions simultanées.
    // Après votre test manuel, nous savons que 2 sessions simultanées = restriction.
    // Solution : augmenter drastiquement les délais entre les scans.
    const cacheKey = username.toLowerCase();
    const cached = tokenCache.get(cacheKey);
    const MIN_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes minimum
    const MAX_SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes maximum
    
    if (cached?.lastScanTime) {
      const timeSinceLastScan = Date.now() - cached.lastScanTime;
      const minWaitTime = MIN_SCAN_INTERVAL_MS + Math.random() * (MAX_SCAN_INTERVAL_MS - MIN_SCAN_INTERVAL_MS);
      
      if (timeSinceLastScan < minWaitTime) {
        const waitTime = minWaitTime - timeSinceLastScan;
        const waitSeconds = Math.round(waitTime / 1000);
        console.log(`[usa] ⏱️ Délai ANTI-RESTRICTION: attente ${waitSeconds}s (5-10min) avant prochain scan`);
        await new Promise(r => setTimeout(r, waitTime));
      }
    }

    // ── AVERTISSEMENT : Éviter les sessions manuelles simultanées ───────────
    // VOTRE TEST A MONTRÉ : 2 navigateurs connectés en même temps = restriction
    // Conseil utilisateur : NE PAS se connecter manuellement pendant que le bot tourne
    // Attendre au moins 5-10 min après la dernière activité du bot
    if (cached?.lastActivityAt) {
      const timeSinceLastActivity = Date.now() - cached.lastActivityAt;
      if (timeSinceLastActivity < 10 * 60 * 1000) { // 10 minutes
        console.log(`[usa] ⚠️ AVERTISSEMENT : Bot actif il y a ${Math.round(timeSinceLastActivity/60000)}min`);
        console.log(`[usa] ⚠️ Évitez de vous connecter manuellement pour ne pas déclencher de restriction`);
      }
    }

    // ── GESTION DES SESSIONS HUMAINES (anti-détection 24h/24) ───────────────
    // Un humain ne reste pas connecté 24h/24. Pattern détectable: session continue.
    // Stratégie: sessions courtes (30-90min) avec pauses (10-30min) + pause nocturne réduite.
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTotalMinutes = currentHour * 60 + currentMinute;
    
    // 1. Vérifier pause nocturne réduite (00h30-04h00)
    const nightStartMinutes = NIGHT_PAUSE_START_HOUR * 60 + NIGHT_PAUSE_START_MINUTE; // 0*60 + 30 = 30
    const nightEndMinutes = NIGHT_PAUSE_END_HOUR * 60 + NIGHT_PAUSE_END_MINUTE; // 4*60 + 0 = 240
    
    let isNightTime = false;
    if (nightStartMinutes < nightEndMinutes) {
      // Pause normale (00h30-04h00)
      isNightTime = currentTotalMinutes >= nightStartMinutes && currentTotalMinutes < nightEndMinutes;
    } else {
      // Pause qui traverse minuit (ex: 22h-08h)
      isNightTime = currentTotalMinutes >= nightStartMinutes || currentTotalMinutes < nightEndMinutes;
    }
    
    if (isNightTime) {
      const nightStartStr = `${NIGHT_PAUSE_START_HOUR.toString().padStart(2, '0')}:${NIGHT_PAUSE_START_MINUTE.toString().padStart(2, '0')}`;
      const nightEndStr = `${NIGHT_PAUSE_END_HOUR.toString().padStart(2, '0')}:${NIGHT_PAUSE_END_MINUTE.toString().padStart(2, '0')}`;
      const currentStr = `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`;
      
      console.log(`[usa] 🌙 Pause nocturne réduite activée (${currentStr}) — reprise à ${nightEndStr}`);
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Pause nocturne ${nightStartStr}-${nightEndStr} — cycle ignoré`,
      });
      return "not_found";
    }
    
    // 2. Vérifier durée session (max 90 minutes)
    if (cached?.sessionStartedAt) {
      const sessionDuration = Date.now() - cached.sessionStartedAt;
      if (sessionDuration >= MAX_HUMAN_SESSION_MS) {
        const sessionMinutes = Math.round(sessionDuration / 60000);
        console.log(`[usa] ⏰ Session trop longue (${sessionMinutes}min > 90min) — logout forcé + pause`);
        
        // Logout propre
        try {
          await logoutUsaPortal(username);
          console.log(`[usa] ✅ Logout forcé après session longue`);
        } catch (logoutErr) {
          console.warn(`[usa] Logout échoué (non bloquant): ${logoutErr}`);
        }
        
        // Supprimer cache
        tokenCache.delete(cacheKey);
        proxyPool.releaseStickyProxy(username);
        
        // Calculer pause (10-30 min)
        const pauseDuration = MIN_SESSION_BREAK_MS + Math.random() * (MAX_SESSION_BREAK_MS - MIN_SESSION_BREAK_MS);
        const pauseMinutes = Math.round(pauseDuration / 60000);
        console.log(`[usa] ☕ Pause humaine: ${pauseMinutes}min avant prochaine session`);
        
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
          errorMessage: `Pause session humaine (${pauseMinutes}min) — cycle ignoré`,
        });
        return "not_found";
      }
    }

  // ── Proxy + UA sticky sur la durée du JWT ────────────────────────────────
  // Principe : un même JWT doit toujours être présenté depuis la même IP et avec
  // le même User-Agent. Changer d'IP ou d'UA en cours de token = empreinte bot.
  //
  //  • Cache hit (token valide) → réutiliser le proxy et l'UA du cache
  //  • Nouveau token (login ou expiry) → assigner un nouveau proxy + UA,
  //    puis les stocker dans le cache juste après le login réussi.
  const cacheKeySticky = username.toLowerCase();
  const cachedSticky = tokenCache.get(cacheKeySticky);
  const hasStickyCache = cachedSticky !== undefined && isCachedTokenValid(cachedSticky);

  let sessionProxy: string | undefined;
  let sessionUaIdx: number;

  if (hasStickyCache && cachedSticky) {
    sessionProxy  = cachedSticky.proxyUrl;
    sessionUaIdx  = cachedSticky.uaIndex ?? Math.floor(Math.random() * USA_UA_POOL.length);
    const maskedProxy = sessionProxy ? sessionProxy.replace(/:([^:@]+)@/, ":***@") : "aucun (direct)";
    console.log(`[usa] Token en cache → proxy sticky: ${maskedProxy} | UA idx ${sessionUaIdx}`);
    
    // Appliquer l'UA sticky pour ce compte
    setActiveSessionUaFromPoolIndex(sessionUaIdx);
  } else {
    // Nouvelle session → définir un UA sticky pour ce compte
    sessionUaIdx = getStickyUaForAccount(username);
    // Appliquer l'UA
    setActiveSessionUaFromPoolIndex(sessionUaIdx);
    // ── Proxy résidentiel iProyal (OBLIGATOIRE pour USA) ──────────────────
    // Les IPs résidentielles iProyal sont STABLES avec session sticky (30-60 min)
    // Le serveur USA lie le JWT à l'IP du login → on utilise makeIproyalStickyUrl()
    // pour assigner UNE IP fixe par compte sur toute la durée du token.
    //
    // ⚠️ JAMAIS de fallback Railway direct — l'IP fixe Railway se fait restricter
    // après quelques logins.
    const IPROYAL_BASE_URL = process.env.IPROYAL_PROXY_URL;
    
    if (!IPROYAL_BASE_URL) {
      console.error(`[usa] 🚫 IPROYAL_PROXY_URL non configuré dans .env.local — cycle AVORTÉ`);
      botLog({ applicationId: job.id, step: "proxy", status: "fail", data: { username, error: "IPROYAL_PROXY_URL non configuré" } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: "IPROYAL_PROXY_URL non configuré — cycle avorté",
      });
      result = "not_found";
      return result;
    }

    // Créer une URL proxy sticky avec session unique pour ce compte
    // Durée: 30 minutes (cohérent avec la durée de vie du proxy)
    const stickyProxyUrl = makeIproyalStickyUrl(IPROYAL_BASE_URL, 30);
    
    if (stickyProxyUrl) {
      sessionProxy = stickyProxyUrl;
      const maskedProxy = stickyProxyUrl.replace(/:([^:@]+)@/, ":***@");
      console.log(`[usa] Nouveau token → proxy iProyal sticky: ${maskedProxy}`);
      
      // DEBUG: Vérifier le format du proxy
      if (stickyProxyUrl.includes("@")) {
        console.log(`[usa] 🔍 Format proxy: http://user:pass@host:port (OK pour undici)`);
      } else {
        console.log(`[usa] ⚠️ Format proxy: host:port seulement (PAS user:pass - peut causer 401)`);
      }
    } else {
      // Échec création URL proxy → ABORTER le cycle
      console.error(`[usa] 🚫 Impossible de créer URL proxy iProyal — cycle AVORTÉ`);
      botLog({ applicationId: job.id, step: "proxy", status: "fail", data: { username, error: "Impossible de créer URL proxy iProyal" } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: "Impossible de créer URL proxy iProyal — cycle avorté",
      });
      result = "not_found";
      return result;
    }
    sessionUaIdx = Math.floor(Math.random() * USA_UA_POOL.length);
  }

  // Activer le proxy et l'UA choisis pour TOUTE cette session
  setActiveSessionUaFromPoolIndex(sessionUaIdx);
  console.log(`[usa] UA: ${getActiveSessionUaLogLabel()}`);
  setUsaSessionProxy(sessionProxy);
  // ──────────────────────────────────────────────────────────────────────────

  // ── Keep-alive : si on réutilise une session cachée, vérifier qu'elle est active ─
  // Le portail tue les sessions après ~15 min d'inactivité. Si le dernier scan
  // remonte à > 8 min, on envoie un ping léger AVANT de tenter quoi que ce soit.
  if (hasStickyCache && cachedSticky) {
    const keepAliveOk = await sendKeepAliveIfNeeded(cachedSticky, username);
    if (!keepAliveOk) {
      // Session morte côté serveur — supprimer le cache et forcer un re-login
      console.warn(`[usa] ⚠️ Session morte (keep-alive 401) — suppression cache, re-login au prochain cycle`);
      tokenCache.delete(cacheKeySticky);
      proxyPool.releaseStickyProxy(username);
      botLog({ applicationId: job.id, step: "keep_alive", status: "fail", data: { username, error: "Session expirée côté serveur — re-login nécessaire" } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "error",
        errorMessage: "Session expirée côté serveur (inactivité ~15 min) — re-login au prochain cycle",
      });
      result = "error";
      return result;
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  let session: UsaSession | null = null;
  try {
    session = await getUsaSession(username, password, twoCaptchaApiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] getUsaSession échoué: ${msg}`);
    botLog({ applicationId: job.id, step: "login", status: "fail", data: { username, error: msg.slice(0, 300) } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: msg.slice(0, 300),
    });
    result = "login_failed";
    return result;
  }
  if (!session) {
    // null peut vouloir dire : compte temporairement restreint (isAccountRestricted() = true)
    // ou identifiants incorrects. On distingue les deux pour éviter l'auto-pause inutile.
    if (isAccountRestricted(username)) {
      const until = getAccountRestrictionDeadline(username.toLowerCase())!;
      const remainMin = Math.round((until - Date.now()) / 60000);
      botLog({ applicationId: job.id, step: "login", status: "warn", data: { username, error: `Compte restreint — ${remainMin} min restantes` } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Compte restreint — cycle ignoré (${remainMin} min restantes)`,
      });
      result = "not_found";
      return result;  // "not_found" = pas de panique, on réessaie plus tard
    }
    botLog({ applicationId: job.id, step: "login", status: "fail", data: { username, error: "Identifiants incorrects ou portail indisponible" } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: "Connexion API USA échouée — identifiants incorrects ou portail indisponible",
    });
    result = "login_failed";
    return result;
  }

  // ── Sticky proxy/UA : injecter dans le cache si nouveau token ────────────
  // getUsaSession() a créé une nouvelle entrée cache sans proxy ni UA.
  // On les injecte maintenant pour que les sessions suivantes (cache hit)
  // réutilisent exactement la même identité réseau.
  if (!hasStickyCache) {
    const freshEntry = tokenCache.get(cacheKeySticky);
    if (freshEntry) {
      freshEntry.proxyUrl = sessionProxy;
      freshEntry.uaIndex  = sessionUaIdx;
      // Synchroniser la durée de vie du token avec celle du proxy.
      // Le JWT ne peut pas survivre à son IP — on prend le min(JWT exp, proxy exp).
      const proxyInfo = proxyPool.getStickyProxyInfo(username);
      if (proxyInfo) {
        freshEntry.proxyExpiresAt = proxyInfo.expiresAt;
        // Si le proxy expire avant le JWT, ajuster expiresAt effectif
        if (proxyInfo.expiresAt < freshEntry.expiresAt) {
          console.log(`[usa] ⏱ Token expirera avec le proxy dans ${Math.round((proxyInfo.expiresAt - Date.now()) / 60000)} min (avant JWT ${Math.round((freshEntry.expiresAt - Date.now()) / 60000)} min)`);
        }
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Log login réussi dans Convex (visible dans botLogs du panneau admin) ──
  botLog({
    applicationId: job.id,
    step: "login",
    status: "ok",
    data: {
      flow: "usa",
      username,
      fullName: session.fullName,
      userID: session.userID,
      csrfToken: session.csrfToken ? "present" : "ABSENT",
      missionId: session.missionId,
    },
  });

  // ── Résolution du dossier actif ────────────────────────────────────────────
  // Le portail peut retourner plusieurs dossiers si le compte en gère plusieurs.
  // portalApplicationId (admin) → sélection exacte ; sinon → premier avec paiement confirmé.
  const requestStatus = await checkUsaAppointmentRequestStatus(session, job.hunterConfig.portalApplicationId);
  session.applicationId = requestStatus.applicationId;
  session.pendingAppoStatus = requestStatus.pendingAppoStatus;
  // Priorité au missionId serveur (équivalent au cookie "missionId" que le portail Angular lit).
  session.missionId = requestStatus.missionId;
  // applicantId interne (bundle : selectedSlotDetails.applicantId) — propagé si le serveur le retourne.
  if (requestStatus.applicantId !== undefined) {
    session.applicantId = requestStatus.applicantId;
  }
  // appointmentId interne — OBLIGATOIRE dans le payload de booking.
  // Bundle Angular : this.selectedSlotDetails.appointmentId → envoyé dans le PUT /appointments/schedule.
  if (requestStatus.appointmentId !== undefined) {
    session.appointmentId = requestStatus.appointmentId;
  }
  // applicantUUID interne — requis dans le payload de booking.
  if (requestStatus.applicantUUID !== undefined) {
    session.applicantUUID = requestStatus.applicantUUID;
  }

  if (requestStatus.status === "error") {
    console.error(`[usa] Erreur lecture statut demande : ${requestStatus.message}`);
    botLog({ applicationId: job.id, step: "appointment_status", status: "fail", data: { flow: "usa", status: "error", message: requestStatus.message } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: requestStatus.message,
    });
    result = "error";
    return result;
  }

  if (requestStatus.status === "no_request") {
    console.warn(`[usa] Aucune demande soumise : ${requestStatus.message}`);
    botLog({ applicationId: job.id, step: "appointment_status", status: "warn", data: { flow: "usa", status: "no_request", pendingAppoStatus: requestStatus.pendingAppoStatus, message: requestStatus.message, action: "L'utilisateur doit effectuer le paiement sur usvisaappt.com" } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "not_found",
      errorMessage: requestStatus.message,
    });
    result = "not_found";
    return result;
  }

  // ── Cas "cancellable" : demande avec applicationId mais pendingAppoStatus=0 (annulable) ──
  // Exemple : demande créée mais paiement non effectué, peut être annulée
  if (requestStatus.status === "cancellable") {
    const rescheduleMode = job.hunterConfig.rescheduleMode;
    if (!rescheduleMode) {
      console.log(`[usa] ♻️ Demande annulable (cancellable) — rescheduleMode non activé dans l'admin. Passage ignoré.`);
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: "cancellable: rescheduleMode non activé",
      });
      return "not_found";
    }

    console.log(`[usa] ♻️ Demande cancellable — résolution applicationId/appointmentId via API...`);
    botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "cancellable_api_start" } });

    const apiResult = await fetchCancellableSessionIds(session, job);
    if (apiResult === "error") {
      console.error("[usa] ❌ Résolution cancellable API échouée");
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Résolution cancellable API échouée" });
      return "error";
    }
    if (apiResult === "not_found") {
      console.warn("[usa] ⚠️ Résolution cancellable : aucun ID trouvé — skip");
      await sendHeartbeat({ applicationId: job.id, result: "not_found", errorMessage: "applicationId/appointmentId non trouvés via API dashboard" });
      return "not_found";
    }
    // apiResult = "proceed" : session.applicationId et session.appointmentId sont à jour
    console.log(`[usa] ✅ Résolution cancellable terminée — applicationId=${session.applicationId} appointmentId=${session.appointmentId}`);
    botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "cancellable_api_proceed", applicationId: session.applicationId, appointmentId: session.appointmentId } });
    // Marquer la session pour utiliser PUT /appointments/reschedule lors du booking
    session.isReschedule = true;
    // Laisser tomber vers le scan de créneaux (ne pas return ici)
  }

  // Note: Le statut "scheduled" n'existe plus. Si un RDV est déjà bookté,
  // il sera détecté via showRescheduleButton dans le flow cancellable (pendingAppoStatus=0 + cancellable=true).
  // Si pendingAppoStatus !== 0 → demande active, on scanne directement.

  console.log(`[usa] ${requestStatus.message} — lancement scan créneaux via API directe...`);
  botLog({
    applicationId: job.id,
    step: "login",
    status: "ok",
    data: {
      username,
      applicationId: session.applicationId,
      missionId: session.missionId,
      allowedOfcs: session.allowedOfcs?.map((o) => o.postUserId) ?? [],
    },
  });

  try {
    const slotResult = await scanUsaSlotsViaAPI(job, session);
    result = slotResult;
    return result;
  } finally {
    setUsaSessionProxy(undefined);
    // Note: NE PAS libérer le sticky proxy ici — on le garde pour le prochain cycle
    // du même compte. Le proxy sera automatiquement libéré après expiration (30 min).
    // proxyPool.releaseStickyProxy(username) → seulement si logout explicite.
  }
} catch (error) {
  console.error("[usa] Erreur inattendue dans runUsaApiSession:", error);
  result = "error";
} finally {
  // ── LOGOUT STRATÉGIQUE (anti-détection 24h/24) ─────────────────────────────
  // Ancienne logique: NE JAMAIS LOGOUT (évite pattern login→logout→repeat)
  // Nouvelle logique: logout périodique pour simuler comportement humain
  //
  // On logout dans 3 cas:
  //   1. Erreur de login (login_failed) → session invalide
  //   2. Erreur système (error) → besoin de repartir proprement  
  //   3. Session trop longue (>2h) → simuler humain qui se déconnecte
  //
  // MAIS: on évite les logout trop fréquents (<30 min entre sessions)
  const cacheKey = username.toLowerCase();
  const cached = tokenCache.get(cacheKey);
  
  let shouldLogout = result === "login_failed" || result === "error";
  
  // Vérifier si session trop longue (déjà géré plus tôt, mais double-check)
  if (cached?.sessionStartedAt) {
    const sessionDuration = Date.now() - cached.sessionStartedAt;
    if (sessionDuration >= MAX_HUMAN_SESSION_MS) {
      console.log(`[usa] ⏰ Fin de session humaine (${Math.round(sessionDuration/60000)}min) — logout planifié`);
      shouldLogout = true;
    }
  }
  
  if (username && shouldLogout) {
    try {
      // Petite pause avant logout (un humain ne clique pas "déconnexion" instantanément)
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
      await logoutUsaPortal(username);
      botLog({
        applicationId: job.id,
        step: "logout",
        status: "ok",
        data: { username, sessionDurationMs: Date.now() - sessionStartTime, result },
      });
    } catch (logoutErr) {
      // Logout échoué — non bloquant, le token expirera naturellement
      console.warn(`[usa] Logout échoué (non bloquant): ${logoutErr}`);
    }
  } else if (username) {
    // Maintenir la session seulement si pas trop longue
    const cacheKey = username.toLowerCase();
    const cached = tokenCache.get(cacheKey);
    
    if (cached?.sessionStartedAt) {
      const sessionDuration = Date.now() - cached.sessionStartedAt;
      const sessionMinutes = Math.round(sessionDuration / 60000);
      const remainingMinutes = Math.round((MAX_HUMAN_SESSION_MS - sessionDuration) / 60000);
      
      if (remainingMinutes > 0) {
        console.log(`[usa] 🔄 Session maintenue (${sessionMinutes}min écoulées, ${remainingMinutes}min restantes)`);
        
        // Mettre à jour lastActivityAt et lastScanTime
        cached.lastActivityAt = Date.now();
        cached.lastScanTime = Date.now();
        console.log(`[usa] 📊 Activité mise à jour: ${new Date(cached.lastActivityAt).toISOString()}`);
      } else {
        console.log(`[usa] ⏰ Session atteint limite humaine (90min) — sera logout au prochain cycle`);
      }
    } else {
      console.log(`[usa] 🔄 Nouvelle session démarrée`);
    }
  }

  // Log la fin du comportement humain
  const sessionDuration = Date.now() - sessionStartTime;
  logHumanBehaviorEnd(job.id, `USA Portal - ${username}`, sessionDuration);
}
return result;
}

