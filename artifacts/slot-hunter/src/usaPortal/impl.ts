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
  
  try {
    if (!username || !password) {
      console.error("[usa] Identifiants portail manquants dans hunterConfig");
      result = "error";
      return result;
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
    const preCheck = await preScanCheck(username, job.id);
    if (!preCheck.proceed) {
      console.log(`[zero-risk] ⚠️ Scan bloqué: ${preCheck.reason}`);
      
      if (preCheck.waitMs && preCheck.waitMs > 0) {
        const waitMinutes = Math.round(preCheck.waitMs / 60000);
        console.log(`[zero-risk] ⏳ Attente recommandée: ${waitMinutes} min`);
        
        // Si l'attente est > 5 min, on skip complètement
        if (preCheck.waitMs > 5 * 60 * 1000) {
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
    const orchestratorCheck = scanOrchestrator.canScanNow(username);
    if (!orchestratorCheck.canScan) {
      console.log(`[zero-risk] 🎯 Orchestrateur: ${orchestratorCheck.reason}`);
      
      if (orchestratorCheck.waitMs && orchestratorCheck.waitMs > 0) {
        const waitMinutes = Math.round(orchestratorCheck.waitMs / 60000);
        console.log(`[zero-risk] ⏳ Fenêtre de scan: attente ${waitMinutes} min`);
        
        if (orchestratorCheck.waitMs > 10 * 60 * 1000) { // > 10 min
          await sendHeartbeat({
            applicationId: job.id,
            result: "not_found",
            errorMessage: `Fenêtre de scan: ${orchestratorCheck.reason}`,
          });
          return "not_found";
        }
      }
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
      botLog({ applicationId: job.id, step: "restriction_skip", status: "warn", data: { username, remainMin } });
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
    // NOUVELLE LOGIQUE :
    //   - Début de pause : entre 22h30 et 01h30 (variable par jour + compte)
    //   - Durée de pause : entre 2h et 5h (variable par jour + compte)
    //   - Total : couverture 19-22h/jour selon les jours
    //   - Déterministe par (jour + username) = même comportement si le bot redémarre le même jour
    const todayStr = now.toISOString().slice(0, 10); // "2026-05-15"
    // ── Pause nocturne PER-DOSSIER (pas seulement per-username) ─────────────
    // PROBLÈME: Si plusieurs dossiers partagent le même embassyUsername,
    // ils dormaient et se réveillaient au MÊME moment → burst de re-logins au réveil.
    // FIX: Ajouter le job.id dans le seed pour décaler chaque dossier individuellement.
    // Résultat: Dossier A dort 23h15-03h45, Dossier B dort 23h30-04h10, etc.
    const nightSeed = `${todayStr}:${username.toLowerCase()}:${job.id}:night-v3`;
    let nightHash = 0;
    for (const ch of nightSeed) nightHash = (nightHash * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    
    // Début entre 22h30 et 01h30 (180 min de plage)
    // 22h30 = 1350 minutes depuis 00h00
    const nightStartBase = 1350; // 22h30
    const nightStartVariation = nightHash % 180; // 0-179 minutes
    const nightStartMinutes = (nightStartBase + nightStartVariation) % 1440;
    
    // Durée entre 2h et 5h (120-300 min)
    const nightDurationMin = 120 + ((nightHash >> 8) % 181); // 120-300 minutes
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
    // FIX: Chaque dossier attend un délai UNIQUE (0 à 15 min) après la fin de la pause
    // nocturne avant son premier scan. Déterministe par job.id pour stabilité.
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
        console.log(`[usa] 🌅 Stagger réveil: ${username} attend encore ${waitMin} min (dossier démarre à +${wakeUpDelayMin}min après réveil)`);
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
          errorMessage: `Stagger réveil — démarrage dans ${waitMin} min`,
        });
        return "not_found";
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
        
        // Calculer pause variable (15-45 min) — MINIMUM 15 min pour éviter le session-cycling
        const pauseDuration = 15 * 60 * 1000 + Math.random() * (MAX_SESSION_BREAK_MS - 15 * 60 * 1000);
        const pauseMinutes = Math.round(pauseDuration / 60000);
        console.log(`[usa] ☕ Pause inter-session: ${pauseMinutes}min (sans logout — JWT expire naturellement)`);
        
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
    // ── SÉLECTION PROXY RÉSIDENTIEL AVEC FAILOVER (BrightData > iProyal > direct) ──
    // Le JWT est lié à l'IP → le proxy doit rester le même pendant toute la session.
    // Priorité : BrightData (sticky session + keep-alive) > iProyal > connexion directe.
    // FAILOVER : Si le proxy prioritaire échoue au pre-flight, on essaie le suivant
    // AVANT de créer le JWT (donc pas de changement d'IP mid-session).
    const adminWantsProxy = job.hunterConfig.useResidentialProxy === true;
    if (adminWantsProxy) {
      const hasBrightData = !!process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL;
      const hasIproyal = !!process.env.IPROYAL_PROXY_URL;

      if (hasBrightData) {
        // Tenter BrightData en premier
        const bdStickyUrl = makeBrightDataStickyUrl(process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL!, username);
        const bdHealth = await preFlightProxyCheck(bdStickyUrl, job.id);

        if (bdHealth.healthy) {
          sessionProxy = bdStickyUrl;
          startBrightDataKeepAlive(bdStickyUrl, username);
          console.log(`[usa] 🌐 BrightData résidentiel OK (${bdHealth.latencyMs}ms) — sticky + keep-alive auto`);
        } else {
          // BrightData DOWN → fallback iProyal si disponible
          console.warn(`[usa] ⚠️ BrightData pre-flight FAILED: ${bdHealth.error} — tentative fallback...`);

          if (hasIproyal) {
            const ipStickyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 60, username);
            const ipHealth = await preFlightProxyCheck(ipStickyUrl, job.id);

            if (ipHealth.healthy) {
              sessionProxy = ipStickyUrl;
              console.log(`[usa] 🌐 FALLBACK iProyal OK (${ipHealth.latencyMs}ms) — sticky 60min`);
            } else {
              // Les deux proxies sont down → connexion directe (Railway IP fixe)
              console.warn(`[usa] ⚠️ iProyal aussi DOWN: ${ipHealth.error} — fallback connexion directe`);
              sessionProxy = undefined;
              console.log(`[usa] 🔌 FALLBACK connexion directe Railway (les 2 proxies down)`);
            }
          } else {
            // Pas d'iProyal configuré → connexion directe
            sessionProxy = undefined;
            console.log(`[usa] 🔌 BrightData DOWN + pas d'iProyal — connexion directe Railway`);
          }
        }
      } else if (hasIproyal) {
        // Pas de BrightData configuré → iProyal directement
        const ipStickyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 60, username);
        const ipHealth = await preFlightProxyCheck(ipStickyUrl, job.id);

        if (ipHealth.healthy) {
          sessionProxy = ipStickyUrl;
          console.log(`[usa] 🌐 iProyal résidentiel OK (${ipHealth.latencyMs}ms) — sticky 60min`);
        } else {
          // iProyal DOWN → connexion directe
          console.warn(`[usa] ⚠️ iProyal pre-flight FAILED: ${ipHealth.error} — connexion directe`);
          sessionProxy = undefined;
          console.log(`[usa] 🔌 iProyal DOWN — fallback connexion directe Railway`);
        }
      } else {
        sessionProxy = undefined;
        console.log(`[usa] 🔌 Proxy demandé mais aucun configuré — connexion directe Railway`);
      }
    } else {
      sessionProxy = undefined;
      console.log(`[usa] 🔌 Proxy DÉSACTIVÉ pour USA — connexion directe Railway`);
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
  // Le pre-flight est maintenant intégré dans la sélection proxy avec failover (ci-dessus).
  // On initialise juste le proxy guard mid-session si un proxy a été sélectionné.
  if (sessionProxy) {
    // Vérifier la latence une dernière fois (le proxy a déjà passé le pre-flight dans le failover)
    // et initialiser le mid-session proxy guard avec l'IP de sortie connue.
    const proxyHealth = await preFlightProxyCheck(sessionProxy, job.id);
    if (!proxyHealth.healthy) {
      // Cas rare : proxy est tombé entre la sélection et ici (quelques ms)
      console.error(`[usa] ❌ Proxy tombé juste après sélection — session avortée`);
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
    initProxyGuard(username, sessionProxy!, proxyHealth.exitIp ?? undefined);
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
  console.log("[zero-risk] 👤 Préparation scan avec comportement humain...");
  await simulateFullHumanBehavior();
  
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
  await simulateFullHumanBehavior();
  
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
      } else {
        // Session trop longue → supprimer le cache (pas de logout explicite)
        tokenCache.delete(maintainCacheKey);
        proxyPool.releaseStickyProxy(username);
        stopBrightDataKeepAlive(username);
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

