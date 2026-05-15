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
  rotateIproyalSession,
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
  MIN_HUMAN_SESSION_MS,
  MAX_HUMAN_SESSION_MS,
  MIN_SESSION_BREAK_MS,
  MAX_SESSION_BREAK_MS,
  NIGHT_PAUSE_START_HOUR,
  NIGHT_PAUSE_START_MINUTE,
  NIGHT_PAUSE_END_HOUR,
  NIGHT_PAUSE_END_MINUTE,
  HUMAN_ACTIVE_START_HOUR,
  HUMAN_ACTIVE_END_HOUR,
  MIN_KEEP_ALIVE_INTERVAL_MS,
  MAX_KEEP_ALIVE_INTERVAL_MS,
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

    // ── Délai variable entre les scans pour éviter la détection Cognito ──────
    // AWS Cognito détecte les patterns trop réguliers et les sessions simultanées.
    // Après votre test manuel, nous savons que 2 sessions simultanées = restriction.
    // Solution : intervalles variables et plus longs.
    const cacheKey = username.toLowerCase();
    const cached = tokenCache.get(cacheKey);
    
    // Intervalles variables selon le tier (mais plus variables)
    let MIN_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes minimum
    let MAX_SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes maximum
    
    // Ajuster selon le tier du job
    const tier = job.urgencyTier;
    if (tier === "tres_urgent") {
      MIN_SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3-8 min pour très urgent
      MAX_SCAN_INTERVAL_MS = 8 * 60 * 1000;
    } else if (tier === "urgent") {
      MIN_SCAN_INTERVAL_MS = 8 * 60 * 1000; // 8-15 min pour urgent
      MAX_SCAN_INTERVAL_MS = 15 * 60 * 1000;
    } else if (tier === "prioritaire") {
      MIN_SCAN_INTERVAL_MS = 12 * 60 * 1000; // 12-20 min pour prioritaire
      MAX_SCAN_INTERVAL_MS = 20 * 60 * 1000;
    } else {
      MIN_SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15-30 min pour standard
      MAX_SCAN_INTERVAL_MS = 30 * 60 * 1000;
    }
    
    if (cached?.lastScanTime) {
      const timeSinceLastScan = Date.now() - cached.lastScanTime;
      // Déterminer un intervalle variable pour ce scan spécifique
      const minWaitTime = MIN_SCAN_INTERVAL_MS + Math.random() * (MAX_SCAN_INTERVAL_MS - MIN_SCAN_INTERVAL_MS);
      
      if (timeSinceLastScan < minWaitTime) {
        const waitTime = minWaitTime - timeSinceLastScan;
        const waitSeconds = Math.round(waitTime / 1000);
        const waitMinutes = Math.round(waitTime / 60000);
        console.log(`[usa] ⏱️ Délai ANTI-RESTRICTION: attente ${waitMinutes}min (${waitSeconds}s) avant prochain scan`);
        
        // Ajouter de petites pauses aléatoires pendant l'attente (comportement humain)
        const totalWait = waitTime;
        const chunkSize = 30_000 + Math.random() * 60_000; // 30-90 secondes par chunk
        let remaining = totalWait;
        
        while (remaining > 0) {
          const chunk = Math.min(chunkSize, remaining);
          await new Promise(r => setTimeout(r, chunk));
          remaining -= chunk;
          
          // Petite activité aléatoire (log) pour simuler un humain
          if (remaining > 0 && Math.random() > 0.7) {
            console.log(`[usa] ⏳ En attente... ${Math.round(remaining/1000)}s restantes`);
          }
        }
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
    // ── Jitter quotidien sur la pause nocturne ─────────────────────────────────
    // Un humain ne commence pas et ne finit pas à la même heure exacte chaque jour.
    // Variation ±30 min sur start ET end, déterministe par jour (même valeur toute la journée).
    // Résultat : un jour le bot dort 00h15-03h45, un autre 00h50-04h20, etc.
    // La couverture reste à 19-21h/jour (variation totale = ±30min sur chaque borne).
    const todayStr = now.toISOString().slice(0, 10); // "2026-05-15"
    let dayHash = 0;
    for (const ch of todayStr) dayHash = (dayHash * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    const nightStartJitterMin = (dayHash % 61) - 30; // -30 à +30 minutes
    const nightEndJitterMin = ((dayHash >> 7) % 61) - 30; // -30 à +30 minutes (valeur différente)
    
    const nightStartMinutes = (NIGHT_PAUSE_START_HOUR * 60 + NIGHT_PAUSE_START_MINUTE + nightStartJitterMin + 1440) % 1440;
    const nightEndMinutes = (NIGHT_PAUSE_END_HOUR * 60 + NIGHT_PAUSE_END_MINUTE + nightEndJitterMin + 1440) % 1440;
    
    let isNightTime = false;
    if (nightStartMinutes < nightEndMinutes) {
      // Pause normale (ex: 00h15-04h20)
      isNightTime = currentTotalMinutes >= nightStartMinutes && currentTotalMinutes < nightEndMinutes;
    } else {
      // Pause qui traverse minuit (ex: 23h50-04h00)
      isNightTime = currentTotalMinutes >= nightStartMinutes || currentTotalMinutes < nightEndMinutes;
    }
    
    if (isNightTime) {
      const nightStartH = Math.floor(nightStartMinutes / 60);
      const nightStartM = nightStartMinutes % 60;
      const nightEndH = Math.floor(nightEndMinutes / 60);
      const nightEndM = nightEndMinutes % 60;
      const nightStartStr = `${nightStartH.toString().padStart(2, '0')}:${nightStartM.toString().padStart(2, '0')}`;
      const nightEndStr = `${nightEndH.toString().padStart(2, '0')}:${nightEndM.toString().padStart(2, '0')}`;
      const currentStr = `${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')}`;
      
      console.log(`[usa] 🌙 Pause nocturne activée (${currentStr}) — reprise à ${nightEndStr} (jitter: start${nightStartJitterMin >= 0 ? "+" : ""}${nightStartJitterMin}min, end${nightEndJitterMin >= 0 ? "+" : ""}${nightEndJitterMin}min)`);
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Pause nocturne ${nightStartStr}-${nightEndStr} — cycle ignoré`,
      });
      return "not_found";
    }
    
    // 2. Vérifier durée session (30-120 minutes aléatoire par session)
    if (cached?.sessionStartedAt) {
      const sessionDuration = Date.now() - cached.sessionStartedAt;
      // Déterminer une durée de session aléatoire pour cette session spécifique
      // Stockée dans le cache pour cohérence
      let targetSessionDuration = cached.targetSessionDuration;
      if (!targetSessionDuration) {
        // Nouvelle session : déterminer une durée aléatoire
        targetSessionDuration = MIN_HUMAN_SESSION_MS + Math.random() * (MAX_HUMAN_SESSION_MS - MIN_HUMAN_SESSION_MS);
        cached.targetSessionDuration = targetSessionDuration;
        const targetMinutes = Math.round(targetSessionDuration / 60000);
        console.log(`[usa] ⏰ Nouvelle session humaine: durée cible ${targetMinutes}min`);
      }
      
      if (sessionDuration >= targetSessionDuration) {
        const sessionMinutes = Math.round(sessionDuration / 60000);
        const targetMinutes = Math.round(targetSessionDuration / 60000);
        console.log(`[usa] ⏰ Session terminée (${sessionMinutes}min ≥ ${targetMinutes}min) — logout forcé + pause`);
        
        // Logout propre
        try {
          await logoutUsaPortal(username);
          console.log(`[usa] ✅ Logout forcé après session humaine`);
        } catch (logoutErr) {
          console.warn(`[usa] Logout échoué (non bloquant): ${logoutErr}`);
        }
        
        // Supprimer cache
        tokenCache.delete(cacheKey);
        proxyPool.releaseStickyProxy(username);
        
        // Calculer pause variable (5-45 min)
        const pauseDuration = MIN_SESSION_BREAK_MS + Math.random() * (MAX_SESSION_BREAK_MS - MIN_SESSION_BREAK_MS);
        const pauseMinutes = Math.round(pauseDuration / 60000);
        console.log(`[usa] ☕ Pause humaine variable: ${pauseMinutes}min avant prochaine session`);
        
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
    // ── DÉSACTIVATION PROXY POUR USA (cause 401) ──────────────────────────
    // Le proxy iProyal cause des 401 sur les endpoints API USA.
    // Sans proxy, les endpoints fonctionnent (testé manuellement).
    // On utilise donc la connexion directe (IP Railway fixe).
    // 
    // ⚠️ SAUF si l'admin active useResidentialProxy dans la config hunter.
    // Dans ce cas, on utilise un proxy sticky 60 min via iProyal.
    // Le JWT est lié à l'IP → le proxy doit rester le même pendant toute la session.
    const adminWantsProxy = job.hunterConfig.useResidentialProxy === true;
    if (adminWantsProxy && process.env.IPROYAL_PROXY_URL) {
      const stickyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL, 60, username);
      sessionProxy = stickyUrl;
      console.log(`[usa] 🌐 Proxy résidentiel ACTIVÉ par admin (sticky 60min)`);
    } else {
      sessionProxy = undefined;
      console.log(`[usa] 🔌 Proxy DÉSACTIVÉ pour USA (cause 401) — connexion directe Railway`);
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
    // Si erreur réseau (proxy 504, tunnel rejeté) → forcer rotation IP iProyal au prochain login
    if (msg.includes("Proxy") || msg.includes("tunnel") || msg.includes("504") || msg.includes("Réseau")) {
      rotateIproyalSession(username);
    }
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
      } else if (sessionProxy) {
        // ── iProyal sticky direct (pas via proxyPool) : calculer l'expiration manuellement ──
        // Le lifetime iProyal est de 60 min depuis la création de la session sticky.
        // On utilise 55 min comme expiration effective (marge de sécurité de 5 min).
        const IPROYAL_EFFECTIVE_LIFETIME_MS = 55 * 60 * 1000;
        freshEntry.proxyExpiresAt = Date.now() + IPROYAL_EFFECTIVE_LIFETIME_MS;
        const proxyExpMin = Math.round(IPROYAL_EFFECTIVE_LIFETIME_MS / 60000);
        const jwtExpMin = Math.round((freshEntry.expiresAt - Date.now()) / 60000);
        console.log(`[usa] ⏱ Proxy iProyal expire dans ${proxyExpMin} min (JWT: ${jwtExpMin} min) — token invalidé avant expiration proxy`);
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
      const targetDuration = cached.targetSessionDuration || MAX_HUMAN_SESSION_MS;
      const remainingMinutes = Math.round((targetDuration - sessionDuration) / 60000);
      
      if (remainingMinutes > 0) {
        const targetTotalMinutes = Math.round(targetDuration / 60000);
        console.log(`[usa] 🔄 Session maintenue (${sessionMinutes}/${targetTotalMinutes}min)`);
        
        // Mettre à jour lastActivityAt et lastScanTime
        cached.lastActivityAt = Date.now();
        cached.lastScanTime = Date.now();
        
        // Simuler une activité humaine aléatoire (log occasionnel)
        if (Math.random() > 0.8) {
          const activities = [
            "📊 Session active",
            "👤 Utilisateur connecté", 
            "🔄 Maintien session",
            "⏳ Prochain scan bientôt",
            "📱 Activité normale"
          ];
          const randomActivity = activities[Math.floor(Math.random() * activities.length)];
          console.log(`[usa] ${randomActivity} — ${remainingMinutes}min restantes`);
        }
      } else {
        console.log(`[usa] ⏰ Session atteint limite humaine (${Math.round(targetDuration/60000)}min) — sera logout au prochain cycle`);
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

