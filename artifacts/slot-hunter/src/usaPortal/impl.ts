import { proxyPool } from "../browser.js";
import { sendHeartbeat, botLog, type HunterJob } from "../convexClient.js";
import {
  logHumanBehaviorStart,
  logHumanBehaviorEnd,
} from "../humanBehavior.js";
import { preFlightProxyCheck } from "./proxy-health-check.js";
import { initProxyGuard, releaseProxyGuard } from "./proxy-session-guard.js";

import {
  tokenCache,
  setUsaSessionProxy,
  USA_UA_POOL,
  setActiveSessionUaFromPoolIndex,
  isCachedTokenValid,
  isSessionApproachingExpiry,
  isSessionInCooldown,
  sendKeepAliveIfNeeded,
  getActiveSessionUaLogLabel,
  usaFetch,
  authHeaders,
  getStickyUaForAccount,
  setAccountFingerprint,
  makeIproyalStickyUrl,
  rotateIproyalSession,
  initSessionHeaders,
} from "./usa-http.js";
import {
  makeBrightDataStickyUrl,
  rotateBrightDataSession,
  startBrightDataKeepAlive,
  stopBrightDataKeepAlive,
} from "./brightdata-proxy.js";
import {
  startBackgroundKeepAlive,
  stopBackgroundKeepAlive,
} from "./background-keep-alive.js";
import { scanUsaSlotsViaAPI } from "./scan-slot-booking.js";
import {
  checkUsaAppointmentRequestStatus,
  fetchCancellableSessionIds,
} from "./appointments-api.js";
import { logoutUsaPortal } from "./usa-auth.js";
import { getUsaSession } from "./usa-session.js";
import { registerDossierRefresh, unregisterDossierRefresh, setKnownProxyLatency } from "./continuous-refresh.js";
import { recordSlotObservation, logPredictionSummary } from "./slot-prediction.js";
import { logCompetitionIntelligence } from "./competitive-intelligence.js";

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
  SCAN_CUTOFF_BEFORE_EXPIRY_MS,
  MIN_COOLDOWN_AFTER_EXPIRY_MS,
  MAX_COOLDOWN_AFTER_EXPIRY_MS,
  MIN_SCANS_PER_SESSION,
  MAX_SCANS_PER_SESSION,
} from "./config.js";

// Stratégie Zero-Risk
import {
  initializeZeroRiskStrategy,
  preScanCheck,
  postScanUpdate,
  simulateFullHumanBehavior,
  getRandomSessionDuration,
  getFingerprintForToday,
  anomalyDetector,
  gracefulDegradation,
  scanOrchestrator,
} from "./zero-risk-strategy.js";

/**
 * Extrait le header Sec-CH-UA depuis un User-Agent string.
 * Chrome envoie "Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"
 * Edge envoie "Chromium";v="136", "Microsoft Edge";v="136", "Not-A.Brand";v="8"
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

export async function runUsaApiSession(job: HunterJob): Promise<SessionResult> {
  const { embassyUsername: username, embassyPassword: password, twoCaptchaApiKey } = job.hunterConfig;
  const sessionStartTime = Date.now();
  let result: SessionResult = "error";

  // Log le début du comportement humain
  logHumanBehaviorStart(job.id, `USA Portal - ${username}`);

  // ── Arrêter le keep-alive background (le scan prend le relais) ──────────
  // Le timer envoyait des pings entre les cycles pour maintenir la session.
  // Maintenant que le scan démarre, il n'est plus nécessaire.
  stopBackgroundKeepAlive(username);
  
  try {
    if (!username || !password) {
      console.error("[usa] Identifiants portail manquants dans hunterConfig");
      botLog({ applicationId: job.id, step: "session_skip", status: "fail", data: { reason: "Identifiants portail manquants dans la configuration Hunter", label: "❌ Config incomplète", username: username || "(vide)" } });
      result = "error";
      return result;
    }

    // ── FIX 4 : Proxy expiré → skip immédiat AVANT tout (pré-flight, Zero-Risk, etc.) ──
    // PROBLÈME : Le bot entre dans le cycle complet (init Zero-Risk, pre-flight proxy, etc.)
    // pour finalement détecter proxyExpiresAt < now et retourner en 2.5s avec login_failed.
    // SOLUTION : Vérifier tokenCache AVANT tout. Si proxy expiré → retourner immédiatement
    // avec "not_found" + reschedule dans 8 min. Économise le CAPTCHA, le pre-flight, et le CPU.
    const earlyCheckCacheKey = username.toLowerCase();
    const earlyCheckCached = tokenCache.get(earlyCheckCacheKey);
    if (earlyCheckCached?.proxyExpiresAt && Date.now() >= earlyCheckCached.proxyExpiresAt) {
      const expiredAgoMs = Date.now() - earlyCheckCached.proxyExpiresAt;
      const expiredAgoMin = Math.round(expiredAgoMs / 60000);
      // Cooldown minimum de 8 min avant re-login avec nouvelle IP
      const MIN_COOLDOWN_PROXY_EXPIRED_MS = 8 * 60_000;
      const timeSinceExpiry = expiredAgoMs;
      if (timeSinceExpiry < MIN_COOLDOWN_PROXY_EXPIRED_MS) {
        const remainMs = MIN_COOLDOWN_PROXY_EXPIRED_MS - timeSinceExpiry;
        const remainMin = Math.round(remainMs / 60000);
        console.log(`[usa] 🔒 FIX4: Proxy expiré il y a ${expiredAgoMin}min — skip immédiat (cooldown ${remainMin}min restant)`);
        botLog({ applicationId: job.id, step: "session_skip", status: "warn", data: { reason: "Proxy expiré — cooldown avant re-login", label: "⏳ Proxy expiré", remainMin, expiredAgoMin, username } });
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
          errorMessage: `Proxy expiré — cooldown ${remainMin}min avant re-login`,
        });
        logHumanBehaviorEnd(job.id, `USA Portal - ${username} (proxy expired skip)`, 0);
        return "not_found";
      }
      // Cooldown terminé → supprimer le cache et laisser continuer (nouveau login)
      console.log(`[usa] ✅ FIX4: Cooldown proxy terminé (expiré ${expiredAgoMin}min ago) — re-login autorisé`);
      tokenCache.delete(earlyCheckCacheKey);
    }

    // ── Initialisation stratégie Zero-Risk ─────────────────────────────────
    // IMPORTANT: Doit être fait AVANT toute autre vérification
    console.log("[zero-risk] 🛡️ Initialisation stratégie Zero-Risk...");
    
    // 1. Initialiser la stratégie pour ce compte
    // Utiliser le nombre de comptes actuellement en cache comme approximation.
    // tokenCache contient les tokens de TOUS les comptes USA actifs sur cette instance.
    // +1 pour le compte courant qui n'est peut-être pas encore en cache (premier login).
    const totalAccounts = Math.max(tokenCache.size + 1, 2);
    initializeZeroRiskStrategy(username, totalAccounts);
    
    // 2. Appliquer le fingerprint cycling pour aujourd'hui
    const fingerprint = getFingerprintForToday(username);
    // Adapter le fingerprint au format attendu par setAccountFingerprint
    // CORRECTION: générer le Sec-CH-UA depuis le UA (pas le UA string brut)
    const adaptedFingerprint = {
      ua: fingerprint.ua,
      chUa: extractSecChUaFromUserAgent(fingerprint.ua),
      platform: `"${fingerprint.platform === "Windows" ? "Windows" : "macOS"}"`,
    };
    setAccountFingerprint(username, adaptedFingerprint);
    console.log(`[zero-risk] 🆔 Fingerprint appliqué: ${fingerprint.platform}, ${fingerprint.timezone}, ${fingerprint.acceptLanguage.split(',')[0]}`);
    
    // 3. Vérifier toutes les conditions avant de continuer
    const preCheck = await preScanCheck(username, job.id, job.urgencyTier);
    if (!preCheck.proceed) {
      console.log(`[zero-risk] ⚠️ Scan bloqué: ${preCheck.reason}`);
      
      if (preCheck.waitMs && preCheck.waitMs > 0) {
        const waitMinutes = Math.round(preCheck.waitMs / 60000);
        console.log(`[zero-risk] ⏳ Attente recommandée: ${waitMinutes} min`);
        
        // Si l'attente est > 5 min, on skip complètement
        if (preCheck.waitMs > 5 * 60 * 1000) {
          botLog({ applicationId: job.id, step: "session_skip", status: "warn", data: { reason: `Zero-Risk: ${preCheck.reason}`, label: "🛡️ Protection Zero-Risk", waitMinutes, username } });
          await sendHeartbeat({
            applicationId: job.id,
            result: "not_found",
            errorMessage: `Zero-Risk: ${preCheck.reason} (attente ${waitMinutes}min)`,
          });
          return "not_found";
        }
        
        // Petite attente si < 5 min
        console.log(`[zero-risk] ⏳ Attente de ${Math.round(preCheck.waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, preCheck.waitMs!));
      } else {
        // Pas d'attente spécifiée, on skip
        botLog({ applicationId: job.id, step: "session_skip", status: "warn", data: { reason: `Zero-Risk: ${preCheck.reason}`, label: "🛡️ Protection Zero-Risk", username } });
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
          errorMessage: `Zero-Risk: ${preCheck.reason}`,
        });
        return "not_found";
      }
    }
    
    console.log("[zero-risk] ✅ Tous les checks passés, continuation...");
    
    // 4. Vérifier la fenêtre de scan via l'orchestrateur
    // Bypass pour urgent/tres_urgent (déjà géré par le stagger du scheduler)
    const bypassOrchestratorWindow = job.urgencyTier === "urgent" || job.urgencyTier === "tres_urgent";
    if (!bypassOrchestratorWindow) {
      const orchestratorCheck = scanOrchestrator.canScanNow(username);
      if (!orchestratorCheck.canScan) {
        console.log(`[zero-risk] 🎯 Orchestrateur: ${orchestratorCheck.reason}`);
        
        if (orchestratorCheck.waitMs && orchestratorCheck.waitMs > 0) {
          const waitMinutes = Math.round(orchestratorCheck.waitMs / 60000);
          console.log(`[zero-risk] ⏳ Fenêtre de scan: attente ${waitMinutes} min`);
          
          if (orchestratorCheck.waitMs > 10 * 60 * 1000) { // > 10 min
            botLog({ applicationId: job.id, step: "session_skip", status: "warn", data: { reason: `Fenêtre de scan: ${orchestratorCheck.reason}`, label: "🎯 Hors fenêtre de scan", waitMinutes, username } });
            await sendHeartbeat({
              applicationId: job.id,
              result: "not_found",
              errorMessage: `Fenêtre de scan: ${orchestratorCheck.reason}`,
            });
            return "not_found";
          }
        }
      }
    } else {
      console.log(`[zero-risk] 🎯 Orchestrateur: bypass (tier=${job.urgencyTier})`);
    }

    // ── Guard restriction compte (AVANT toute action) ──────────────────────
    // Si le compte est déjà marqué restreint par un cycle précédent,
    // NE RIEN FAIRE du tout — pas de proxy check, pas de log "session démarrée",
    // juste retourner immédiatement. Économise le pre-flight check et évite le
    // faux log "Aucun créneau disponible" / "not_found" qui pollue les stats.
    if (isAccountRestricted(username)) {
      const until = getAccountRestrictionDeadline(username.toLowerCase())!;
      const remainMin = Math.round((until - Date.now()) / 60000);
      console.log(`[usa] 🔒 ${username} en restriction — ${remainMin} min restantes. Cycle SKIP total.`);
      botLog({ applicationId: job.id, step: "session_skip", status: "warn", data: { reason: `Compte restreint par le portail — ${remainMin} min restantes`, label: "🔒 Compte restreint", remainMin, username } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Compte restreint — skip total (${remainMin} min restantes)`,
      });
      // Ne PAS logger "Fin session comportement humain" ni "not_found" comme résultat
      // — on retourne directement sans passer par le finally block normal
      logHumanBehaviorEnd(job.id, `USA Portal - ${username} (restriction skip)`, 0);
      return "not_found";
    }

    // ── Initialiser les headers de session (fixés pour toute la durée) ──────
    // Un vrai Chrome envoie les mêmes Accept-Encoding/Language pendant toute sa session.
    // Randomiser par requête = signal bot. On fixe une fois au début.
    initSessionHeaders(username);

    // ── Délai variable entre les scans pour éviter la détection Cognito ──────
    // AWS Cognito détecte les patterns trop réguliers et les sessions simultanées.
    // Après votre test manuel, nous savons que 2 sessions simultanées = restriction.
    // Solution : intervalles variables et plus longs.
    const delayCacheKey = username.toLowerCase();
    const delayCached = tokenCache.get(delayCacheKey);
    
    // Intervalles variables selon le tier (mais plus variables)
    let MIN_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes minimum
    let MAX_SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes maximum
    
    // Ajuster selon le tier du job
    const tier = job.urgencyTier;
    if (tier === "tres_urgent") {
      MIN_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5-10 min pour très urgent (réduit de 3-8 → 5-10 pour sécurité)
      MAX_SCAN_INTERVAL_MS = 10 * 60 * 1000;
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
    
    if (delayCached?.lastScanTime) {
      const timeSinceLastScan = Date.now() - delayCached.lastScanTime;
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
    if (delayCached?.lastActivityAt) {
      const timeSinceLastActivity = Date.now() - delayCached.lastActivityAt;
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
    
    // 1. Vérifier pause nocturne variable
    // ── Pause nocturne VARIABLE par jour ET par compte (16/05/2026) ─────────────
    // PROBLÈME: L'ancienne logique avait une pause fixe 00h30-04h00 ±30min.
    // Le pattern quotidien était identifiable : toujours ~3.5h de silence à la même heure.
    // Un humain a des horaires de sommeil VARIABLES (parfois 22h, parfois 2h).
    //
    // FIX 10 : Pause nocturne APRÈS la rush hour 00-02h.
    // PROBLÈME ORIGINAL: Start range 22h30-01h30 → les dossiers manquaient TOUTE
    // la rush hour 00:00-02:00 (la plus productive pour les libérations de créneaux).
    // NOUVELLE LOGIQUE :
    //   - Début de pause : entre 02h30 et 04h30 (APRÈS la rush 00-02h)
    //   - Durée de pause : entre 2h et 4h (réduit pour maximiser la couverture)
    //   - Total : dossiers dorment de ~03:00 à ~06:00 (après la rush 00-02h)
    //   - Déterministe par (jour + username + jobId) = même comportement si le bot redémarre le même jour
    const todayStr = now.toISOString().slice(0, 10); // "2026-05-15"
    // ── Pause nocturne PER-DOSSIER (pas seulement per-username) ─────────────
    const nightSeed = `${todayStr}:${username.toLowerCase()}:${job.id}:night-v4`;
    let nightHash = 0;
    for (const ch of nightSeed) nightHash = (nightHash * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    
    // FIX 10: Début entre 02h30 et 04h30 (120 min de plage) — APRÈS rush 00-02h
    // 02h30 = 150 minutes depuis 00h00
    const nightStartBase = 150; // 02h30
    const nightStartVariation = nightHash % 120; // 0-119 minutes (plage 02h30-04h30)
    const nightStartMinutes = nightStartBase + nightStartVariation;
    
    // FIX 10: Durée réduite entre 2h et 4h (120-240 min) au lieu de 2-5h
    const nightDurationMin = 120 + ((nightHash >> 8) % 121); // 120-240 minutes
    const nightEndMinutes = (nightStartMinutes + nightDurationMin) % 1440;
    
    let isNightTime = false;
    if (nightStartMinutes < nightEndMinutes) {
      // Pause ne traverse pas minuit (rare avec start à 22h30+)
      isNightTime = currentTotalMinutes >= nightStartMinutes && currentTotalMinutes < nightEndMinutes;
    } else {
      // Pause traverse minuit (cas normal : ex 23h15-03h45)
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
      
      console.log(`[usa] 🌙 Pause nocturne activée (${currentStr}) — ${nightStartStr} à ${nightEndStr} (durée ${Math.round(nightDurationMin / 60 * 10) / 10}h)`);
      botLog({ applicationId: job.id, step: "session_skip", status: "warn", data: { reason: `Pause nocturne ${nightStartStr}-${nightEndStr}`, label: "🌙 Pause nocturne", nightStartStr, nightEndStr, username } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Pause nocturne ${nightStartStr}-${nightEndStr} — cycle ignoré`,
      });
      return "not_found";
    }
    
    // ── Stagger de réveil post-pause nocturne ────────────────────────────────
    // PROBLÈME: Au réveil, si 3 dossiers du même tier sont "dûs", ils font
    // tous un re-login en burst (30-60s entre eux) = 3 logins en 2 min = restriction.
    // FIX 2: Au lieu de return "not_found" (qui gaspille un cycle + ajoute l'intervalle normal),
    // on fait un await sleep() interne du temps restant puis on continue le cycle normalement.
    // Résultat: Dossier A démarre à +0 min, B à +5 min, C à +11 min après le réveil.
    const timeSinceWakeUp = currentTotalMinutes - nightEndMinutes;
    // timeSinceWakeUp peut être négatif si nightEnd traverse minuit — normaliser
    const normalizedTimeSinceWakeUp = timeSinceWakeUp >= 0 ? timeSinceWakeUp : timeSinceWakeUp + 1440;
    
    // Seulement appliquer dans les 20 premières minutes après le réveil
    if (normalizedTimeSinceWakeUp < 20) {
      // Délai de réveil unique par dossier (0 à 15 min)
      const wakeUpSeed = `${todayStr}:${job.id}:wakeup-stagger`;
      let wakeHash = 0;
      for (const ch of wakeUpSeed) wakeHash = (wakeHash * 31 + ch.charCodeAt(0)) & 0x7fffffff;
      const wakeUpDelayMin = wakeHash % 16; // 0-15 minutes
      
      if (normalizedTimeSinceWakeUp < wakeUpDelayMin) {
        const waitMin = wakeUpDelayMin - normalizedTimeSinceWakeUp;
        const waitMs = waitMin * 60_000;
        console.log(`[usa] 🌅 Stagger réveil: ${username} attend ${waitMin} min (dossier démarre à +${wakeUpDelayMin}min après réveil) — sleep interne`);
        // FIX 2: Sleep interne au lieu de return "not_found"
        // Le cycle continue normalement après l'attente — pas de gaspillage d'intervalle
        await new Promise(r => setTimeout(r, waitMs));
        console.log(`[usa] 🌅 Stagger réveil terminé pour ${username} — continuation du cycle`);
      }
    }
    
    // 2. Vérifier durée session (30-120 minutes aléatoire par session)
    if (delayCached?.sessionStartedAt) {
      const sessionDuration = Date.now() - delayCached.sessionStartedAt;
      // Déterminer une durée de session aléatoire pour cette session spécifique
      // Stockée dans le cache pour cohérence
      let targetSessionDuration = delayCached.targetSessionDuration;
      if (!targetSessionDuration) {
        // Nouvelle session : déterminer une durée aléatoire avec stratégie Zero-Risk
        targetSessionDuration = getRandomSessionDuration(username);
        delayCached.targetSessionDuration = targetSessionDuration;
        const targetMinutes = Math.round(targetSessionDuration / 60000);
        console.log(`[zero-risk] ⏰ Nouvelle session: durée cible ${targetMinutes}min`);
      }
      
      if (sessionDuration >= targetSessionDuration) {
        const sessionMinutes = Math.round(sessionDuration / 60000);
        const targetMinutes = Math.round(targetSessionDuration / 60000);
        console.log(`[usa] ⏰ Session terminée (${sessionMinutes}min ≥ ${targetMinutes}min) — PAS de logout (anti-restriction Cognito)`);
        
        // ── STRATÉGIE ANTI-RESTRICTION : NE PAS LOGOUT ──────────────────────
        // Le pattern logout→re-login rapide est le TRIGGER #1 des restrictions Cognito.
        // Au lieu de logout, on supprime simplement le cache token pour forcer un
        // re-login AU PROCHAIN CYCLE (après la pause). Le JWT expirera naturellement
        // côté serveur (~60 min) — c'est le comportement d'un humain qui ferme
        // son navigateur sans cliquer "déconnexion" (très courant).
        tokenCache.delete(delayCacheKey);
        proxyPool.releaseStickyProxy(username);
        stopBrightDataKeepAlive(username);
        stopBackgroundKeepAlive(username);
        
        // Calculer pause variable (15-45 min) — MINIMUM 15 min pour éviter le session-cycling
        const pauseDuration = 15 * 60 * 1000 + Math.random() * (MAX_SESSION_BREAK_MS - 15 * 60 * 1000);
        const pauseMinutes = Math.round(pauseDuration / 60000);
        console.log(`[usa] ☕ Pause inter-session: ${pauseMinutes}min (sans logout — JWT expire naturellement)`);
        
        botLog({ applicationId: job.id, step: "session_skip", status: "warn", data: { reason: `Session trop longue (${sessionMinutes}min ≥ ${targetMinutes}min) — pause ${pauseMinutes}min`, label: "⏰ Session expirée (durée max)", sessionMinutes, targetMinutes, pauseMinutes, username } });
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
          errorMessage: `Pause inter-session (${pauseMinutes}min) — cycle ignoré`,
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
  const stickyCacheKey = username.toLowerCase();
  const stickyCached = tokenCache.get(stickyCacheKey);
  const hasStickyCache = stickyCached !== undefined && isCachedTokenValid(stickyCached);

  let sessionProxy: string | undefined;
  let sessionUaIdx: number;
  let preFlightExitIp: string | undefined; // IP de sortie du pre-flight (évite un 2ème check pour les nouvelles sessions)

  if (hasStickyCache && stickyCached) {
    sessionProxy  = stickyCached.proxyUrl;
    sessionUaIdx  = stickyCached.uaIndex ?? Math.floor(Math.random() * USA_UA_POOL.length);
    const maskedProxy = sessionProxy ? sessionProxy.replace(/:([^:@]+)@/, ":***@") : "aucun (direct)";
    console.log(`[usa] Token en cache → proxy sticky: ${maskedProxy} | UA idx ${sessionUaIdx}`);
    
    // Appliquer l'UA sticky pour ce compte
    setActiveSessionUaFromPoolIndex(sessionUaIdx);
  } else {
    // Nouvelle session → définir un UA sticky pour ce compte
    sessionUaIdx = getStickyUaForAccount(username);
    // Appliquer l'UA
    setActiveSessionUaFromPoolIndex(sessionUaIdx);
    // ── SÉLECTION PROXY RÉSIDENTIEL AVEC FAILOVER (iProyal > BrightData > 2captcha) ──
    // Le JWT est lié à l'IP → le proxy doit rester le même pendant toute la session.
    // Priorité : iProyal (sticky 12h) > BrightData (sticky + keep-alive, KYC requis) > 2captcha rotatif.
    // FAILOVER : Si le proxy prioritaire échoue au pre-flight, on essaie le suivant
    // AVANT de créer le JWT (donc pas de changement d'IP mid-session).
    // NOTE: BrightData requiert une vérification KYC pour les POST sur les sites .gov.
    //       Une fois le KYC complété, inverser la priorité (BrightData > iProyal).
    const adminWantsProxy = job.hunterConfig.useResidentialProxy === true;
    if (adminWantsProxy) {
      const hasBrightData = !!process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL;
      const hasIproyal = !!process.env.IPROYAL_PROXY_URL;

      // ── FIX 8 : Proxy provider alternation inter-comptes ──────────────────
      // PROBLÈME: Tous les comptes partagent le même provider → si iProyal a un
      // problème global, tous tombent en même temps.
      // SOLUTION: Alterner la priorité entre comptes via hunterConfig.preferredProxy
      //   - "brightdata" → BrightData prioritaire, iProyal fallback
      //   - "iproyal" (ou absent) → iProyal prioritaire, BrightData fallback
      const preferredProxy: string = (job.hunterConfig as Record<string, unknown>).preferredProxy as string ?? "iproyal";
      const preferIproyal = preferredProxy !== "brightdata";
      
      if (preferIproyal) {
        console.log(`[usa] 🎯 FIX8: Proxy préféré = iProyal (compte ${username})`);
      } else {
        console.log(`[usa] 🎯 FIX8: Proxy préféré = BrightData (compte ${username})`);
      }

      // ── Provider primaire selon la préférence du compte ──
      const primaryIsIproyal = preferIproyal && hasIproyal;
      const primaryIsBrightData = !preferIproyal && hasBrightData;

      if (primaryIsIproyal || (hasIproyal && !hasBrightData)) {
        // Tenter iProyal en premier (sticky 12h, pas de KYC requis)
        const ipStickyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 720, username);
        const ipHealth = await preFlightProxyCheck(ipStickyUrl, job.id);

        if (ipHealth.healthy) {
          sessionProxy = ipStickyUrl;
          preFlightExitIp = ipHealth.exitIp ?? undefined;
          console.log(`[usa] 🌐 iProyal résidentiel OK (${ipHealth.latencyMs}ms) — sticky 12h`);
          setKnownProxyLatency(ipHealth.latencyMs ?? 0); // FIX 9
        } else {
          // iProyal DOWN → fallback BrightData si disponible
          console.warn(`[usa] ⚠️ iProyal pre-flight FAILED: ${ipHealth.error} — tentative fallback...`);

          if (hasBrightData) {
            const bdStickyUrl = makeBrightDataStickyUrl(process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL!, username);
            const bdHealth = await preFlightProxyCheck(bdStickyUrl, job.id);

            if (bdHealth.healthy) {
              sessionProxy = bdStickyUrl;
              preFlightExitIp = bdHealth.exitIp ?? undefined;
              startBrightDataKeepAlive(bdStickyUrl, username);
              console.log(`[usa] 🌐 FALLBACK BrightData OK (${bdHealth.latencyMs}ms) — sticky + keep-alive`);
            } else {
              // iProyal + BrightData DOWN → fallback 2captcha rotatif
              console.warn(`[usa] ⚠️ BrightData aussi DOWN: ${bdHealth.error} — tentative 2captcha...`);
              if (proxyPool.isConfigured) {
                const poolResult = await proxyPool.getProxy();
                if (poolResult?.proxy) {
                  sessionProxy = poolResult.proxy;
                  console.log(`[usa] 🌐 FALLBACK 2captcha rotatif (iProyal + BrightData down)`);
                } else {
                  console.error(`[usa] ❌ TOUS LES PROXIES DOWN (iProyal + BD + 2captcha) — ABORT session`);
                  await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Tous les proxies down — session avortée pour protéger l'IP" });
                  result = "error";
                  return result;
                }
              } else {
                console.error(`[usa] ❌ iProyal + BD DOWN + 2captcha non configuré — ABORT session`);
                await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Tous les proxies down — session avortée" });
                result = "error";
                return result;
              }
            }
          } else {
            // Pas de BrightData configuré → fallback 2captcha directement
            console.warn(`[usa] ⚠️ iProyal DOWN + pas de BrightData — tentative 2captcha...`);
            if (proxyPool.isConfigured) {
              const poolResult = await proxyPool.getProxy();
              if (poolResult?.proxy) {
                sessionProxy = poolResult.proxy;
                console.log(`[usa] 🌐 FALLBACK 2captcha rotatif (iProyal down, pas de BD)`);
              } else {
                console.error(`[usa] ❌ iProyal DOWN + 2captcha pool vide — ABORT session`);
                await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Tous les proxies down — session avortée" });
                result = "error";
                return result;
              }
            } else {
              console.error(`[usa] ❌ iProyal DOWN + aucun fallback — ABORT session`);
              await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Proxy down et pas de fallback — session avortée" });
              result = "error";
              return result;
            }
          }
        }
      } else if (primaryIsBrightData || (hasBrightData && !hasIproyal)) {
        // FIX 8: BrightData prioritaire pour ce compte, iProyal en fallback
        const bdStickyUrl = makeBrightDataStickyUrl(process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL!, username);
        const bdHealth = await preFlightProxyCheck(bdStickyUrl, job.id);

        if (bdHealth.healthy) {
          sessionProxy = bdStickyUrl;
          preFlightExitIp = bdHealth.exitIp ?? undefined;
          startBrightDataKeepAlive(bdStickyUrl, username);
          console.log(`[usa] 🌐 BrightData résidentiel OK (${bdHealth.latencyMs}ms) — sticky + keep-alive`);
          setKnownProxyLatency(bdHealth.latencyMs ?? 0); // FIX 9
        } else {
          // BrightData DOWN → fallback iProyal si disponible
          console.warn(`[usa] ⚠️ BrightData pre-flight FAILED: ${bdHealth.error} — tentative fallback iProyal...`);

          if (hasIproyal) {
            const ipStickyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 720, username);
            const ipHealth = await preFlightProxyCheck(ipStickyUrl, job.id);

            if (ipHealth.healthy) {
              sessionProxy = ipStickyUrl;
              preFlightExitIp = ipHealth.exitIp ?? undefined;
              console.log(`[usa] 🌐 FALLBACK iProyal OK (${ipHealth.latencyMs}ms) — sticky 12h`);
            } else {
              // BrightData + iProyal DOWN → fallback 2captcha rotatif
              console.warn(`[usa] ⚠️ iProyal aussi DOWN: ${ipHealth.error} — tentative 2captcha...`);
              if (proxyPool.isConfigured) {
                const poolResult = await proxyPool.getProxy();
                if (poolResult?.proxy) {
                  sessionProxy = poolResult.proxy;
                  console.log(`[usa] 🌐 FALLBACK 2captcha rotatif (BrightData + iProyal down)`);
                } else {
                  console.error(`[usa] ❌ TOUS LES PROXIES DOWN (BD + iProyal + 2captcha) — ABORT session`);
                  await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Tous les proxies down — session avortée pour protéger l'IP" });
                  result = "error";
                  return result;
                }
              } else {
                console.error(`[usa] ❌ BD + iProyal DOWN + 2captcha non configuré — ABORT session`);
                await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Tous les proxies down — session avortée" });
                result = "error";
                return result;
              }
            }
          } else {
            // Pas d'iProyal configuré → fallback 2captcha directement
            console.warn(`[usa] ⚠️ BrightData DOWN + pas d'iProyal — tentative 2captcha...`);
            if (proxyPool.isConfigured) {
              const poolResult = await proxyPool.getProxy();
              if (poolResult?.proxy) {
                sessionProxy = poolResult.proxy;
                console.log(`[usa] 🌐 FALLBACK 2captcha rotatif (BD down, pas d'iProyal)`);
              } else {
                console.error(`[usa] ❌ BrightData DOWN + 2captcha pool vide — ABORT session`);
                await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Tous les proxies down — session avortée" });
                result = "error";
                return result;
              }
            } else {
              console.error(`[usa] ❌ BrightData DOWN + aucun fallback — ABORT session`);
              await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Proxy down et pas de fallback — session avortée" });
              result = "error";
              return result;
            }
          }
        }
      } else if (hasBrightData) {
        // Ni BrightData ni iProyal → utiliser 2captcha rotatif
        const poolResult = await proxyPool.getProxy();
        if (poolResult?.proxy) {
          sessionProxy = poolResult.proxy;
          console.log(`[usa] 🌐 2captcha résidentiel rotatif (seul proxy configuré)`);
        } else {
          console.error(`[usa] ❌ 2captcha pool vide — ABORT session (IP Railway jamais exposée)`);
          await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Pool 2captcha vide — session avortée" });
          result = "error";
          return result;
        }
      } else {
        // AUCUN proxy configuré → ABORT (ne JAMAIS exposer l'IP Railway)
        console.error(`[usa] ❌ AUCUN proxy configuré (useResidentialProxy=true mais 0 provider) — ABORT`);
        await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Aucun proxy configuré — session avortée pour protéger l'IP Railway" });
        result = "error";
        return result;
      }
    } else {
      // useResidentialProxy = false → connexion directe autorisée par l'admin
      sessionProxy = undefined;
      console.log(`[usa] 🔌 Proxy DÉSACTIVÉ par admin — connexion directe Railway`);
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
  if (hasStickyCache && stickyCached) {
    const keepAliveOk = await sendKeepAliveIfNeeded(stickyCached, username);
    if (!keepAliveOk) {
      // Session morte côté serveur — supprimer le cache et forcer un re-login
      console.warn(`[usa] ⚠️ Session morte (keep-alive 401) — suppression cache, re-login au prochain cycle`);
      tokenCache.delete(stickyCacheKey);
      proxyPool.releaseStickyProxy(username);
      stopBrightDataKeepAlive(username);
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

  // ── PILLAR 1 : Pre-Flight Proxy Health Check ────────────────────────────────
  // Le pre-flight est intégré dans la sélection proxy avec failover (ci-dessus).
  // On initialise le proxy guard mid-session SANS refaire un check (déjà fait au failover).
  // L'IP de sortie est déjà connue depuis le pre-flight initial.
  if (sessionProxy) {
    if (hasStickyCache) {
      // Session réutilisée → vérifier que le proxy est toujours vivant + obtenir IP actuelle.
      const proxyHealth = await preFlightProxyCheck(sessionProxy, job.id);
      if (!proxyHealth.healthy) {
        console.error(`[usa] ❌ Proxy mort mid-cache — session avortée`);
        rotateIproyalSession(username);
        rotateBrightDataSession(username);
        stopBrightDataKeepAlive(username);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `Proxy instable (${proxyHealth.error}) — session avortée, rotation IP programmée`,
        });
        result = "error";
        return result;
      }
      console.log(`[usa] ✅ Proxy confirmé — latency ${proxyHealth.latencyMs}ms, exit IP: ${proxyHealth.exitIp}`);
      // FIX 9: Store proxy latency for server health scoring separation
      setKnownProxyLatency(proxyHealth.latencyMs ?? 0);
      initProxyGuard(username, sessionProxy!, proxyHealth.exitIp ?? undefined);
    } else {
      // Nouveau token → le pre-flight a DÉJÀ été fait dans le failover ci-dessus.
      // On réutilise l'IP connue → économie de ~2-5s par cycle (pas de 2ème HTTP call).
      console.log(`[usa] ✅ Proxy guard initialisé (IP pre-flight: ${preFlightExitIp ?? "inconnue"})`);
      initProxyGuard(username, sessionProxy!, preFlightExitIp);
      // FIX 9: Pre-flight latency was recorded during the failover — use last known value
      // (already set during ipHealth/bdHealth checks above if applicable)
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  let session: UsaSession | null = null;
  try {
    session = await getUsaSession(username, password, twoCaptchaApiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] getUsaSession échoué: ${msg}`);
    
    // ── Tracking erreur pour anomaly detection ──────────────────────────────
    anomalyDetector.recordMetric(username, 'error', 1);
    anomalyDetector.recordMetric(username, 'responseTime', 10000); // 10s pour erreur
    
    // Si erreur réseau (proxy 504, tunnel rejeté) → forcer rotation IP au prochain login
    if (msg.includes("Proxy") || msg.includes("tunnel") || msg.includes("504") || msg.includes("Réseau")) {
      rotateIproyalSession(username);
      rotateBrightDataSession(username);
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
    const freshEntry = tokenCache.get(stickyCacheKey);
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
        // On utilise 11h30 comme expiration effective (marge de sécurité de 30 min sur 12h).
        const IPROYAL_EFFECTIVE_LIFETIME_MS = 11.5 * 60 * 60 * 1000;
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

  // ── Vérifier si la session approche de l'expiration (algorithme "Session-First, Login-Last") ──
  const sessionCacheKey = username.toLowerCase();
  const sessionCached = tokenCache.get(sessionCacheKey);
  if (sessionCached) {
    // Vérifier si on doit arrêter les scans (cutoff avant expiration)
    if (isSessionApproachingExpiry(sessionCached)) {
      const timeToExpiry = sessionCached.expiresAt - Date.now();
      const cutoffMinutes = Math.round(timeToExpiry / 60000);
      console.log(`[usa] ⏰ CUTOFF ACTIVÉ — token expire dans ${cutoffMinutes} min (< 8 min) — arrêt des scans`);
      console.log(`[usa] ⏳ Phase de repos: ${Math.round((SCAN_CUTOFF_BEFORE_EXPIRY_MS - timeToExpiry) / 60000)} min avant expiration, puis cooldown 5-8 min`);
      
      botLog({
        applicationId: job.id,
        step: "scan_cutoff",
        status: "warn",
        data: {
          username,
          timeToExpiryMs: timeToExpiry,
          cutoffMinutes,
          action: "Arrêt des scans — phase de repos avant re-login"
        }
      });
      
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Cutoff activé — token expire dans ${cutoffMinutes} min — arrêt des scans, re-login après cooldown`
      });
      
      // Supprimer le cache pour forcer un re-login au prochain cycle
      tokenCache.delete(sessionCacheKey);
      return "not_found";
    }
    
    // Vérifier si on est en phase de cooldown
    if (isSessionInCooldown(sessionCached)) {
      const timeSinceExpiry = Date.now() - sessionCached.expiresAt;
      const cooldownDuration = sessionCached.cooldownDurationMs ?? 
        (MIN_COOLDOWN_AFTER_EXPIRY_MS + Math.random() * (MAX_COOLDOWN_AFTER_EXPIRY_MS - MIN_COOLDOWN_AFTER_EXPIRY_MS));
      const remainingCooldown = Math.max(0, cooldownDuration - timeSinceExpiry);
      const remainingMinutes = Math.round(remainingCooldown / 60000);
      
      console.log(`[usa] ⏳ COOLDOWN ACTIF — ${remainingMinutes} min avant prochain login`);
      console.log(`[usa] 📊 Statistiques: session ${Math.round((Date.now() - sessionCached.sessionStartedAt) / 60000)} min, scans ${sessionCached.scanCount || 0}`);
      
      botLog({
        applicationId: job.id,
        step: "cooldown",
        status: "warn",
        data: {
          username,
          remainingCooldownMs: remainingCooldown,
          remainingMinutes,
          sessionDurationMs: Date.now() - sessionCached.sessionStartedAt,
          scanCount: sessionCached.scanCount || 0
        }
      });
      
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Cooldown actif — ${remainingMinutes} min avant prochain login`
      });
      
      return "not_found";
    }
  }

  // ── Simulation comportement humain avant scan ──────────────────────────────
  // FIX 7: Removed first simulateFullHumanBehavior() call here.
  // A human doesn't "think" twice before clicking. Only one call needed (after scan cap check).
  
  // ── Vérifier le cap de scans par session ──────────────────────────────────
  // Un humain ne fait pas 40 F5 en 2h. Il fait 8-15 checks puis part.
  // Si le cap est atteint, terminer la session (sans logout) et forcer une pause.
  const scanCapCacheKey = username.toLowerCase();
  const scanCapCached = tokenCache.get(scanCapCacheKey);
  if (scanCapCached) {
    const currentScanCount = (scanCapCached.scanCount ?? 0) + 1;
    scanCapCached.scanCount = currentScanCount;
    
    // Calculer le cap pour cette session (randomisé une fois, persisté dans le cache)
    let sessionScanCap = scanCapCached.sessionScanCap;
    if (!sessionScanCap) {
      sessionScanCap = MIN_SCANS_PER_SESSION + Math.floor(Math.random() * (MAX_SCANS_PER_SESSION - MIN_SCANS_PER_SESSION + 1));
      scanCapCached.sessionScanCap = sessionScanCap;
      console.log(`[anti-detect] 📊 Cap scans cette session: ${sessionScanCap}`);
    }
    
    if (currentScanCount >= sessionScanCap) {
      console.log(`[anti-detect] 🛑 CAP SCANS ATTEINT (${currentScanCount}/${sessionScanCap}) — fin de session forcée`);
      
      // Supprimer le cache et forcer une pause inter-session
      tokenCache.delete(scanCapCacheKey);
      proxyPool.releaseStickyProxy(username);
      stopBrightDataKeepAlive(username);
      
      const pauseDuration = 15 * 60 * 1000 + Math.random() * (MAX_SESSION_BREAK_MS - 15 * 60 * 1000);
      const pauseMinutes = Math.round(pauseDuration / 60000);
      console.log(`[anti-detect] ☕ Pause post-cap: ${pauseMinutes}min (humain découragé)`);
      
      botLog({
        applicationId: job.id,
        step: "scan_cap_reached",
        status: "warn",
        data: { username, scanCount: currentScanCount, scanCap: sessionScanCap, pauseMinutes },
      });
      
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Cap scans atteint (${currentScanCount}/${sessionScanCap}) — pause ${pauseMinutes}min`,
      });
      
      result = "not_found";
      return result;
    }
    
    if (currentScanCount > 1) {
      console.log(`[anti-detect] 📊 Scan #${currentScanCount}/${sessionScanCap} cette session`);
    }
  }
  // FIX 7: Single simulateFullHumanBehavior() call (was duplicated before)
  console.log("[zero-risk] 👤 Préparation scan avec comportement humain...");
  await simulateFullHumanBehavior();
  
  // ── Early Bird #1 — Log prédiction courante pour le dashboard ─────────────
  logPredictionSummary(username, job.id);

  // ── Obtenir les paramètres adaptés à la santé du serveur ──────────────────
  const scanParams = gracefulDegradation.getScanParameters();
  console.log(`[zero-risk] 🏥 Niveau serveur: ${scanParams.level}`);
  console.log(`[zero-risk] ⚙️ Paramètres: interval=${Math.round(scanParams.intervalMs/60000)}min, timeout=${Math.round(scanParams.timeoutMs/1000)}s, retries=${scanParams.retries}`);

  try {
    // Mesurer le temps de réponse du scan
    const scanStartTime = Date.now();
    let hadError = false;
    let hadCaptcha = false;
    
    try {
      const slotResult = await scanUsaSlotsViaAPI(job, session);
      result = slotResult;
      
      // ── Early Bird #1 — Enregistrer l'observation si slot trouvé ──
      if (result === "slot_found") {
        recordSlotObservation(username);
        logPredictionSummary(username, job.id);
        logCompetitionIntelligence(job.id);
      }
      
      // Détecter les erreurs basées sur le résultat
      if (result === "error" || result === "login_failed") {
        hadError = true;
      }
      
      // TODO: Détecter les captchas (à implémenter dans scanUsaSlotsViaAPI)
      // hadCaptcha = slotResult.hadCaptcha || false;
      
    } catch (scanError) {
      hadError = true;
      console.error("[zero-risk] ❌ Erreur pendant le scan:", scanError);
      
      // Si l'erreur vient du proxy-session-guard (503 PROXY_DEAD_MID_SESSION),
      // forcer l'expiration du proxy dans le cache pour que le cooldown s'applique.
      const scanErrMsg = scanError instanceof Error ? scanError.message : String(scanError);
      if (scanErrMsg.includes("PROXY_DEAD") || scanErrMsg.includes("session frozen")) {
        const frozenCached = tokenCache.get(username.toLowerCase());
        if (frozenCached && frozenCached.proxyExpiresAt && Date.now() < frozenCached.proxyExpiresAt) {
          // Forcer l'expiration à maintenant pour déclencher le cooldown
          frozenCached.proxyExpiresAt = Date.now();
          console.log(`[usa] 🔒 proxyExpiresAt forcé à maintenant — cooldown s'appliquera au prochain cycle`);
        }
      }
      
      result = "error";
    }
    
    const responseTime = Date.now() - scanStartTime;
    
    // Mettre à jour les métriques post-scan avec les données réelles
    postScanUpdate(username, responseTime, hadError, hadCaptcha);
    
    // Log détaillé des métriques
    console.log(`[zero-risk] 📊 Métriques scan: ${responseTime}ms, erreur=${hadError}, captcha=${hadCaptcha}`);
    
    return result;
  } finally {
    setUsaSessionProxy(undefined);
    // Note: NE PAS libérer le sticky proxy ici — on le garde pour le prochain cycle
    // du même compte. Le proxy sera automatiquement libéré après expiration (30 min).
    // proxyPool.releaseStickyProxy(username) → seulement si logout explicite.
  }
} catch (error) {
  console.error("[usa] Erreur inattendue dans runUsaApiSession:", error);
  
  // ── Tracking erreur pour anomaly detection ──────────────────────────────
  if (username) {
    anomalyDetector.recordMetric(username, 'error', 1);
    anomalyDetector.recordMetric(username, 'responseTime', 15000); // 15s pour erreur grave
  }
  
  result = "error";
} finally {
  // ── POLITIQUE COHÉRENTE : NE JAMAIS LOGOUT (16/05/2026) ────────────────────
  // 
  // RAISON : Un humain qui utilise un portail administratif ferme son navigateur
  // sans cliquer "Déconnexion" dans 95% des cas. Le JWT expire naturellement
  // côté serveur (~60 min). Le pattern logout→re-login est le TRIGGER #1 des
  // restrictions Cognito car il crée un cycle détectable.
  //
  // L'ancien code faisait des logouts conditionnels (erreur, session longue) ce
  // qui créait un pattern BINAIRE : certaines sessions avec logout, d'autres sans
  // → corrélable par le portail.
  //
  // NOUVELLE RÈGLE UNIQUE : Ne JAMAIS appeler POST /identity/user/logout.
  // Si erreur → supprimer le cache token, le JWT expire seul côté serveur.
  // Si session trop longue → supprimer le cache, pas de logout explicite.
  //
  // Seule action : supprimer le cache local si le token est invalide.
  const logoutCacheKey = username.toLowerCase();
  
  if (result === "login_failed" || result === "error") {
    // ── IMPORTANT: Ne PAS supprimer le cache si le proxy était actif et est mort ──
    // Si on supprime le cache, le prochain cycle ne verra pas le proxyExpiresAt
    // et fera un re-login IMMÉDIAT (sans cooldown) = trigger restriction.
    // Solution: garder le cache avec proxyExpiresAt pour que usa-session.ts
    // applique le guard proxy-expiry cooldown au prochain cycle.
    const errorCached = tokenCache.get(logoutCacheKey);
    const proxyWasDead = errorCached?.proxyExpiresAt && Date.now() >= errorCached.proxyExpiresAt;
    
    if (proxyWasDead) {
      // Proxy mort → garder le cache (le guard proxy-expiry cooldown s'appliquera)
      // Juste libérer le sticky proxy pour rotation IP au prochain login
      proxyPool.releaseStickyProxy(username);
      stopBrightDataKeepAlive(username);
      console.log(`[usa] 🔒 Cache CONSERVÉ (proxy mort) — cooldown ${Math.round(MIN_COOLDOWN_AFTER_EXPIRY_MS / 60000)}-${Math.round(MAX_COOLDOWN_AFTER_EXPIRY_MS / 60000)} min avant re-login`);
    } else {
      // Autre erreur (credentials, réseau, 401 non-proxy) → supprimer le cache
      tokenCache.delete(logoutCacheKey);
      proxyPool.releaseStickyProxy(username);
      stopBrightDataKeepAlive(username);
      console.log(`[usa] 🗑️ Cache supprimé (${result}) — JWT expirera naturellement côté serveur`);
    }
  } else if (username) {
    // Maintenir la session seulement si pas trop longue
    const maintainCacheKey = username.toLowerCase();
    const maintainCached = tokenCache.get(maintainCacheKey);
    
    if (maintainCached?.sessionStartedAt) {
      const sessionDuration = Date.now() - maintainCached.sessionStartedAt;
      const sessionMinutes = Math.round(sessionDuration / 60000);
      const targetDuration = maintainCached.targetSessionDuration || getRandomSessionDuration(username);
      const remainingMinutes = Math.round((targetDuration - sessionDuration) / 60000);
      
      if (remainingMinutes > 0) {
        const targetTotalMinutes = Math.round(targetDuration / 60000);
        console.log(`[usa] 🔄 Session maintenue (${sessionMinutes}/${targetTotalMinutes}min)`);
        
        // Mettre à jour lastActivityAt et lastScanTime
        maintainCached.lastActivityAt = Date.now();
        maintainCached.lastScanTime = Date.now();

        // ── Démarrer le keep-alive background entre les cycles ──────────────
        // Le scheduler va dormir 8-20+ min avant le prochain cycle.
        // Sans ce timer, le serveur kill la session après 15 min d'inactivité.
        // Le timer envoie un ping toutes les 8-12 min pour garder la session active.
        startBackgroundKeepAlive(username, job.id);
      } else {
        // Session trop longue → supprimer le cache (pas de logout explicite)
        tokenCache.delete(maintainCacheKey);
        proxyPool.releaseStickyProxy(username);
        stopBrightDataKeepAlive(username);
        stopBackgroundKeepAlive(username);
        console.log(`[usa] ⏰ Session expirée naturellement (${sessionMinutes}min) — cache supprimé, pas de logout`);
      }
    } else {
      console.log(`[usa] 🔄 Nouvelle session démarrée`);
    }
  }

  // Libérer le proxy guard mid-session
  releaseProxyGuard(username);

  // Log la fin du comportement humain
  const sessionDuration = Date.now() - sessionStartTime;
  logHumanBehaviorEnd(job.id, `USA Portal - ${username}`, sessionDuration);
}
return result;
}

