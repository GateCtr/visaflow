/**
 * OFC Watcher — Refresh continu PARTAGÉ par OFC (Kinshasa = 1 seul OFC).
 *
 * CONCEPT :
 *   Au lieu que chaque dossier fasse son propre continuous refresh (42 min bloquant),
 *   UN SEUL watcher par OFC fait le refresh pour TOUS les dossiers.
 *   Quand un slot est détecté → broadcast à tous les dossiers → booking race parallèle.
 *
 * AVANTAGES :
 *   - Fréquence de check : 1× / 30-60s (au lieu de 1× / 42 min par dossier en série)
 *   - Temps de réaction : < 5s (broadcast immédiat vs attendre son tour)
 *   - Parallélisme booking : N dossiers tentent simultanément (premier qui book gagne)
 *
 * ARCHITECTURE :
 *   - 1 watcher par OFC (Map<ofcKey, OfcWatcher>)
 *   - Le watcher utilise le fetcher du compte "élu" (premier tres_urgent avec proxy healthy)
 *   - Les subscribers sont notifiés via callback quand un slot est détecté
 *   - Si le watcher tombe (proxy mort, 401), un nouveau est élu automatiquement
 *
 * INTÉGRATION :
 *   - Lancé par la boucle principale (index.ts) APRÈS le login initial de chaque dossier
 *   - Coexiste avec l'ancien mode séquentiel (migration progressive)
 *   - Les dossiers inscrits au watcher SKIP le continuous refresh individuel
 */

import { createSessionFetcher, type UsaFetcher } from "./usa-fetcher.js";
import { tokenCache, authHeaders, resetCorrelationOnAction } from "./usa-http.js";
import { USA_FIRST_AVAILABLE_MONTH_URL, USA_LANDING_PAGE_URL, REFERER_DASHBOARD } from "./config.js";
import { botLog } from "../convexClient.js";
import { recordSlotObservation, getCurrentPredictionScore, getRefreshMultiplier, injectHistoricalObservations, getObservationCount } from "./slot-prediction.js";
import { recordSlotAppearance, recordAllSlotsGone, getCompetitionRefreshMultiplier } from "./competitive-intelligence.js";
import { getSlotObservationTimestamps } from "../convexClient.js";
import type { UsaOfc, UsaAppDetails } from "./usa-scan-types.js";
import type { HunterJob } from "../convexClient.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OfcWatcherSubscriber {
  /** Job ID (dossier). */
  jobId: string;
  /** Username du compte (pour le booking race). */
  username: string;
  /** Proxy URL pour ce compte. */
  proxyUrl?: string;
  /** Job complet (pour le booking). */
  job: HunterJob;
  /** Détails application (pour le booking). */
  appDetails: UsaAppDetails;
  /** Mode reschedule. */
  rescheduleYN?: boolean;
  /** Date from admin. */
  dateFrom?: string;
  /** Date deadline admin. */
  dateDeadline?: string;
}

export interface SlotDetectedEvent {
  /** Nom de l'OFC (ex: "Kinshasa"). */
  ofcName: string;
  /** Premier mois disponible (YYYY-MM-DD). */
  firstAvailableMonth: string;
  /** Timestamp de la détection. */
  detectedAt: number;
  /** Username du watcher qui a détecté. */
  watcherUsername: string;
}

/** Callback appelé quand un slot est détecté par le watcher. */
export type SlotDetectedCallback = (event: SlotDetectedEvent, subscribers: OfcWatcherSubscriber[]) => Promise<void>;

interface OfcWatcherState {
  /** Clé unique de l'OFC (ex: "usa:Kinshasa:323"). */
  ofcKey: string;
  /** OFC surveillé. */
  ofc: UsaOfc;
  /** Mission ID. */
  missionId: number;
  /** Username du compte watcher actif. */
  watcherUsername: string;
  /** Fetcher du watcher. */
  fetcher: UsaFetcher;
  /** Subscribers (dossiers inscrits à cet OFC). */
  subscribers: Map<string, OfcWatcherSubscriber>;
  /** Timer du loop. */
  loopTimer: ReturnType<typeof setTimeout> | null;
  /** Flag d'arrêt. */
  stopped: boolean;
  /** Nombre total de refreshes. */
  totalRefreshes: number;
  /** Dernière latence. */
  lastLatencyMs: number;
  /** Nombre d'erreurs consécutives. */
  consecutiveErrors: number;
  /** Callback de notification slot. */
  onSlotDetected: SlotDetectedCallback;
}

// ─── Registry global des watchers actifs ────────────────────────────────────

const activeWatchers = new Map<string, OfcWatcherState>();

// ─── Configuration ──────────────────────────────────────────────────────────

/** Intervalle de base entre deux refreshes (ms). */
const WATCHER_BASE_INTERVAL_MS = 45_000; // 45s

/** Intervalle minimum (fenêtre chaude + compétition extrême). */
const WATCHER_MIN_INTERVAL_MS = 20_000; // 20s

/** Intervalle maximum (fenêtre froide + serveur stressé). */
const WATCHER_MAX_INTERVAL_MS = 120_000; // 2 min

/** Nombre d'erreurs consécutives avant failover du watcher. */
const MAX_WATCHER_ERRORS = 3;

/** Ratio de requêtes getLandingPage pour l'alternance anti-pattern (#6 Stealthy Alternation).
 * Un humain ne fait pas QUE des POST getFirstAvailableMonth — il navigue aussi sur le dashboard.
 * 1/4 des requêtes = GET getLandingPage (léger, pattern varié). */
const WATCHER_LANDING_PAGE_RATIO = 0.25;

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Génère la clé unique d'un OFC (pour le registry).
 */
export function makeOfcKey(destination: string, ofcName: string, missionId: number): string {
  return `${destination}:${ofcName}:${missionId}`;
}

/**
 * Démarre un watcher pour un OFC.
 * Si un watcher existe déjà pour cet OFC, ne fait rien (idempotent).
 *
 * @param ofcKey - Clé unique de l'OFC
 * @param ofc - Données OFC (postUserId, postName, officeType)
 * @param missionId - Mission ID (323 pour USA)
 * @param watcherUsername - Compte qui fait les requêtes de refresh
 * @param watcherProxyUrl - Proxy du compte watcher
 * @param onSlotDetected - Callback de notification quand slot détecté
 */
export function startOfcWatcher(
  ofcKey: string,
  ofc: UsaOfc,
  missionId: number,
  watcherUsername: string,
  watcherProxyUrl: string | undefined,
  onSlotDetected: SlotDetectedCallback,
): void {
  if (activeWatchers.has(ofcKey)) {
    console.log(`[ofc-watcher] ⚠️ Watcher déjà actif pour ${ofcKey} — skip`);
    return;
  }

  const fetcher = createSessionFetcher({
    proxyUrl: watcherProxyUrl,
    username: watcherUsername,
    label: `watcher:${ofc.postName}`,
  });

  const state: OfcWatcherState = {
    ofcKey,
    ofc,
    missionId,
    watcherUsername,
    fetcher,
    subscribers: new Map(),
    loopTimer: null,
    stopped: false,
    totalRefreshes: 0,
    lastLatencyMs: 0,
    consecutiveErrors: 0,
    onSlotDetected,
  };

  activeWatchers.set(ofcKey, state);
  console.log(`[ofc-watcher] 🚀 Watcher démarré pour ${ofc.postName} (compte: ${watcherUsername.slice(0, 12)}…)`);

  // FIX-20: botLog enrichi — watcher démarré (visible dans le dashboard admin)
  const cachedToken = tokenCache.get(watcherUsername.toLowerCase());
  botLog({
    applicationId: "watcher",
    step: "ofc_watcher_started",
    status: "ok",
    data: {
      ofcName: ofc.postName,
      ofcKey,
      watcherAccount: watcherUsername,
      subscriberCount: 0, // sera mis à jour après inscription
      tokenExpiresAt: cachedToken?.expiresAt ? new Date(cachedToken.expiresAt).toISOString() : null,
      tokenExpiresInMin: cachedToken ? Math.round((cachedToken.expiresAt - Date.now()) / 60_000) : null,
      proxyUrl: watcherProxyUrl ? "configured" : "direct",
      startedAt: new Date().toISOString(),
    },
  });

  // Lancer la boucle
  runWatcherLoop(state);
}

/**
 * Arrête le watcher d'un OFC.
 */
export function stopOfcWatcher(ofcKey: string): void {
  const state = activeWatchers.get(ofcKey);
  if (!state) return;

  state.stopped = true;
  if (state.loopTimer) clearTimeout(state.loopTimer);
  state.fetcher.dispose();
  activeWatchers.delete(ofcKey);
  console.log(`[ofc-watcher] 🛑 Watcher arrêté pour ${state.ofc.postName}`);

  // FIX-20: botLog session terminée (visible dans dashboard)
  botLog({
    applicationId: "watcher",
    step: "ofc_watcher_session_end",
    status: "warn",
    data: {
      ofcName: state.ofc.postName,
      reason: "stopped",
      totalChecks: state.totalRefreshes,
      lastLatencyMs: state.lastLatencyMs,
      stoppedAt: new Date().toISOString(),
    },
  });
}

/**
 * Inscrit un dossier comme subscriber d'un watcher OFC.
 * Le dossier sera notifié quand un slot est détecté.
 */
export function subscribeToOfcWatcher(ofcKey: string, subscriber: OfcWatcherSubscriber): void {
  const state = activeWatchers.get(ofcKey);
  if (!state) {
    console.warn(`[ofc-watcher] subscribeToOfcWatcher: pas de watcher actif pour ${ofcKey}`);
    return;
  }
  state.subscribers.set(subscriber.jobId, subscriber);
  console.log(`[ofc-watcher] 📋 [${state.ofc.postName}] +subscriber ${subscriber.username.slice(0, 12)}… (total: ${state.subscribers.size})`);
}

/**
 * Désinscrit un dossier d'un watcher OFC.
 */
export function unsubscribeFromOfcWatcher(ofcKey: string, jobId: string): void {
  const state = activeWatchers.get(ofcKey);
  if (!state) return;
  state.subscribers.delete(jobId);
  console.log(`[ofc-watcher] 📋 [${state.ofc.postName}] -subscriber (total: ${state.subscribers.size})`);

  // Si plus aucun subscriber → arrêter le watcher
  if (state.subscribers.size === 0) {
    console.log(`[ofc-watcher] 📋 [${state.ofc.postName}] Aucun subscriber restant — arrêt watcher`);
    stopOfcWatcher(ofcKey);
  }
}

/**
 * Vérifie si un watcher est actif pour un OFC donné.
 */
export function hasActiveWatcher(ofcKey: string): boolean {
  return activeWatchers.has(ofcKey);
}

/**
 * Retourne l'état du watcher pour debug/logging.
 */
export function getWatcherStatus(ofcKey: string): {
  active: boolean;
  watcherUsername?: string;
  subscriberCount?: number;
  totalRefreshes?: number;
  lastLatencyMs?: number;
} {
  const state = activeWatchers.get(ofcKey);
  if (!state) return { active: false };
  return {
    active: true,
    watcherUsername: state.watcherUsername,
    subscriberCount: state.subscribers.size,
    totalRefreshes: state.totalRefreshes,
    lastLatencyMs: state.lastLatencyMs,
  };
}

/**
 * Effectue un failover : remplace le watcher par un autre subscriber.
 * Appelé quand le watcher actuel a trop d'erreurs (proxy mort, token expiré).
 * FIX: Valide le proxy du nouveau watcher avant de l'utiliser. Si le proxy du
 * subscriber est aussi mort, tente BrightData comme fallback.
 */
export async function failoverWatcher(ofcKey: string): Promise<boolean> {
  const state = activeWatchers.get(ofcKey);
  if (!state) return false;

  const { preFlightProxyCheck } = await import("./proxy-health-check.js");
  const { makeBrightDataStickyUrl, startBrightDataKeepAlive } = await import("./brightdata-proxy.js");
  const { makeIproyalStickyUrl } = await import("./usa-http.js");

  // Trouver un subscriber avec un token valide et un proxy fonctionnel
  for (const [jobId, sub] of state.subscribers) {
    if (sub.username === state.watcherUsername) continue; // skip le watcher actuel
    const cached = tokenCache.get(sub.username.toLowerCase());
    if (!cached || Date.now() >= cached.expiresAt) continue; // token expiré

    // Résoudre un proxy fonctionnel pour ce subscriber
    let newProxy: string | undefined;

    // Tenter iProyal
    if (process.env.IPROYAL_PROXY_URL) {
      const ipUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL, 720, sub.username);
      const ipHealth = await preFlightProxyCheck(ipUrl, sub.job.id);
      if (ipHealth.healthy) {
        newProxy = ipUrl;
      }
    }

    // Fallback BrightData
    if (!newProxy && process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL) {
      const bdUrl = makeBrightDataStickyUrl(process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL, sub.username);
      const bdHealth = await preFlightProxyCheck(bdUrl, sub.job.id);
      if (bdHealth.healthy) {
        newProxy = bdUrl;
        startBrightDataKeepAlive(bdUrl, sub.username);
      }
    }

    // Si aucun proxy ne marche, on utilise direct (mieux que rien — le watcher continue)
    // Nouveau watcher trouvé!
    console.log(`[ofc-watcher] 🔄 FAILOVER ${state.ofc.postName}: ${state.watcherUsername.slice(0, 12)}… → ${sub.username.slice(0, 12)}… (proxy: ${newProxy ? "OK" : "direct"})`);

    // Disposer l'ancien fetcher
    state.fetcher.dispose();

    // Créer un nouveau fetcher avec le nouveau compte + proxy validé
    state.watcherUsername = sub.username;
    sub.proxyUrl = newProxy; // mettre à jour le subscriber aussi
    state.fetcher = createSessionFetcher({
      proxyUrl: newProxy,
      username: sub.username,
      label: `watcher:${state.ofc.postName}`,
    });
    state.consecutiveErrors = 0;

    return true;
  }

  // Aucun subscriber avec token valide — tenter de re-résoudre le proxy du watcher actuel
  // (peut-être que le proxy était iProyal et maintenant BrightData marche)
  if (process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL) {
    const bdUrl = makeBrightDataStickyUrl(process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL, state.watcherUsername);
    const bdHealth = await preFlightProxyCheck(bdUrl);
    if (bdHealth.healthy) {
      console.log(`[ofc-watcher] 🔄 FAILOVER ${state.ofc.postName}: même compte ${state.watcherUsername.slice(0, 12)}… mais proxy → BrightData`);
      state.fetcher.dispose();
      startBrightDataKeepAlive(bdUrl, state.watcherUsername);
      state.fetcher = createSessionFetcher({
        proxyUrl: bdUrl,
        username: state.watcherUsername,
        label: `watcher:${state.ofc.postName}`,
      });
      state.consecutiveErrors = 0;
      return true;
    }
  }

  console.warn(`[ofc-watcher] ⚠️ FAILOVER impossible pour ${state.ofc.postName} — aucun subscriber éligible + BrightData dead`);
  return false;
}

// ─── Boucle de refresh interne ──────────────────────────────────────────────

async function runWatcherLoop(state: OfcWatcherState): Promise<void> {
  if (state.stopped) return;

  // Bootstrap Early Bird si nécessaire
  if (getObservationCount(state.watcherUsername) === 0) {
    try {
      const historicalTs = await getSlotObservationTimestamps("usa", state.ofc.postName);
      if (historicalTs.length > 0) {
        injectHistoricalObservations(state.watcherUsername, historicalTs, state.ofc.postName);
        console.log(`[ofc-watcher] 📊 Bootstrap: ${historicalTs.length} observations historiques pour ${state.ofc.postName}`);
      }
    } catch { /* non-bloquant */ }
  }

  // Lancer la boucle
  console.log(`[ofc-watcher] 🔄 Boucle de refresh démarrée pour ${state.ofc.postName} (compte: ${state.watcherUsername.slice(0, 12)}…)`);
  while (!state.stopped) {
    try {
      console.log(`[ofc-watcher] 📡 Refresh #${state.totalRefreshes + 1} en cours...`);
      await doWatcherRefresh(state);
      console.log(`[ofc-watcher] ✅ Refresh #${state.totalRefreshes} terminé (${state.lastLatencyMs}ms)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ofc-watcher] ❌ Erreur refresh #${state.totalRefreshes + 1} ${state.ofc.postName}: ${errMsg}`);
      state.consecutiveErrors++;
      console.error(`[ofc-watcher]    Erreurs consécutives: ${state.consecutiveErrors}/${MAX_WATCHER_ERRORS}`);

      if (state.consecutiveErrors >= MAX_WATCHER_ERRORS) {
        console.error(`[ofc-watcher] 🔄 Tentative failover...`);
        const didFailover = await failoverWatcher(state.ofcKey);
        if (!didFailover) {
          console.error(`[ofc-watcher] 🛑 Watcher ${state.ofc.postName} arrêté — trop d'erreurs + failover impossible`);
          stopOfcWatcher(state.ofcKey);
          return;
        }
      }
    }

    // Intervalle adaptatif
    const interval = computeWatcherInterval(state);
    console.log(`[ofc-watcher] ⏳ Prochain refresh dans ${Math.round(interval / 1000)}s`);

    // FIX-20: Summary botLog toutes les 5 itérations (~5 min) pour le dashboard
    if (state.totalRefreshes > 0 && state.totalRefreshes % 5 === 0) {
      const summaryToken = tokenCache.get(state.watcherUsername.toLowerCase());
      const summaryTokenMin = summaryToken ? Math.round((summaryToken.expiresAt - Date.now()) / 60_000) : null;
      botLog({
        applicationId: "watcher",
        step: "ofc_watcher_summary",
        status: "ok",
        data: {
          ofcName: state.ofc.postName,
          watcherAccount: state.watcherUsername,
          totalChecks: state.totalRefreshes,
          lastLatencyMs: state.lastLatencyMs,
          subscriberCount: state.subscribers.size,
          tokenExpiresInMin: summaryTokenMin,
          nextRefreshInSec: Math.round(interval / 1000),
          consecutiveErrors: state.consecutiveErrors,
          uptimeMin: Math.round((Date.now() - (summaryToken?.lastActivityAt ?? Date.now())) / 60_000),
        },
      });
    }

    await new Promise(r => setTimeout(r, interval));
  }
}

async function doWatcherRefresh(state: OfcWatcherState): Promise<void> {
  const { fetcher, watcherUsername, ofc } = state;

  // FIX-20: Ne plus bloquer sur le token du watcher global.
  // Chaque groupe utilise son propre token. On vérifie ici seulement pour le GET getLandingPage.
  // Si le token watcher est expiré, on skip le landing page mais on continue vers les groupes
  // (qui ont chacun leur propre findGroupScanner).
  const cached = tokenCache.get(watcherUsername.toLowerCase());
  const watcherTokenValid = cached && Date.now() < cached.expiresAt;

  // ── Stealthy Alternation: 1/4 des requêtes = GET getLandingPage ──────────
  // Un humain ne fait pas 100% de POST getFirstAvailableMonth. Il navigue
  // parfois sur le dashboard entre ses vérifications → pattern plus naturel.
  const useLandingPage = Math.random() < WATCHER_LANDING_PAGE_RATIO;

  if (useLandingPage && watcherTokenValid && cached) {
    // GET getLandingPage — requête légère, simule navigation dashboard
    console.log(`[ofc-watcher] 📡 [${ofc.postName}] GET getLandingPage (alternation)`);
    resetCorrelationOnAction(REFERER_DASHBOARD, watcherUsername);
    const hdrs = authHeaders(cached.accessToken, REFERER_DASHBOARD, false, watcherUsername);
    // Ajouter LanguageId comme le fait le vrai intercepteur Angular pour cette route
    hdrs["LanguageId"] = "1";

    const reqStart = Date.now();
    const res = await fetcher.fetch(USA_LANDING_PAGE_URL, {
      method: "GET",
      headers: hdrs,
    });
    state.lastLatencyMs = Date.now() - reqStart;
    state.totalRefreshes++;
    console.log(`[ofc-watcher] 📡 [${ofc.postName}] GET → HTTP ${res.status} (${state.lastLatencyMs}ms)`);

    if (res.status === 401) {
      // Token watcher expiré — non-fatal, on continue sans throw
      console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] GET landing 401 — token watcher expiré, skip alternation`);
    } else if (res.status === 429 || res.status === 403) {
      throw new Error(`HTTP_${res.status}`);
    } else if (res.status === 503) {
      throw new Error("PROXY_DEAD");
    } else {
      // Reset erreurs sur succès
      if (res.ok || res.status < 500) {
        state.consecutiveErrors = 0;
      }
    }

    // Log périodique
    if (state.totalRefreshes % 5 === 0) {
      console.log(`[ofc-watcher] 🔄 #${state.totalRefreshes} ${ofc.postName} [landing] | latency=${state.lastLatencyMs}ms`);
    }
    return; // Pas de détection de slot via getLandingPage
  } else if (useLandingPage && !watcherTokenValid) {
    // Token watcher expiré — skip le landing page, passer directement au scan par groupe
    console.log(`[ofc-watcher] 📡 [${ofc.postName}] Skip getLandingPage — token watcher expiré, passage au scan`);
  }

  // ── POST getFirstAvailableMonth — le vrai check de disponibilité ──────────
  // FIX-20: Chaque groupe doit scanner avec le token ET l'applicationId du MÊME compte.
  // Le serveur USA lie le Bearer token à l'applicationId du compte connecté.
  // On ne peut PAS utiliser le token de compte A pour scanner l'applicationId de compte B.
  // Solution : pour chaque groupe, trouver un subscriber qui a un token valide dans tokenCache,
  // puis utiliser SON token + SON applicationId pour la requête de scan.
  // Les autres membres du groupe sont alertés si un slot est trouvé (booking race avec leur propre token).

  // Grouper les subscribers valides par locationType effectif
  const validSubs = [...state.subscribers.values()].filter(
    sub => sub.appDetails.applicationId && sub.appDetails.applicationId !== "0"
  );

  if (validSubs.length === 0) {
    console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] Aucun subscriber avec applicationId valide — skip`);
    return;
  }

  // Grouper : reschedule (SCHEDULED) vs new (NEW)
  const rescheduleGroup = validSubs.filter(s => s.rescheduleYN);
  const newGroup = validSubs.filter(s => !s.rescheduleYN);

  // FIX-20: Helper — trouver le meilleur scanner pour un groupe.
  // Le scanner doit avoir un token valide dans tokenCache (son token correspond à son applicationId).
  const findGroupScanner = (groupSubs: OfcWatcherSubscriber[]): OfcWatcherSubscriber | null => {
    for (const sub of groupSubs) {
      const subToken = tokenCache.get(sub.username.toLowerCase());
      if (subToken && Date.now() < subToken.expiresAt) {
        return sub;
      }
    }
    return null;
  };

  // Scanner chaque groupe qui a au moins 1 subscriber avec un token valide
  const groups: Array<{ label: string; scanner: OfcWatcherSubscriber; locationType: string; scannerToken: string }> = [];

  if (newGroup.length > 0) {
    const scanner = findGroupScanner(newGroup);
    if (scanner) {
      const loc = scanner.appDetails.locationType ?? scanner.appDetails.appointmentLocationType ?? ofc.officeType ?? "OFC";
      const scannerToken = tokenCache.get(scanner.username.toLowerCase())!.accessToken;
      groups.push({ label: "NEW", scanner, locationType: loc, scannerToken });
    } else {
      console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] Groupe NEW: aucun subscriber avec token valide — skip`);
    }
  }
  if (rescheduleGroup.length > 0) {
    const scanner = findGroupScanner(rescheduleGroup);
    if (scanner) {
      const loc = scanner.appDetails.appointmentLocationType ?? scanner.appDetails.locationType ?? ofc.officeType ?? "POST";
      const scannerToken = tokenCache.get(scanner.username.toLowerCase())!.accessToken;
      groups.push({ label: "RESCHEDULE", scanner, locationType: loc, scannerToken });
    } else {
      console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] Groupe RESCHEDULE: aucun subscriber avec token valide — skip`);
    }
  }

  if (groups.length === 0) {
    // FIX-20: Aucun subscriber n'a de token valide (tous en re-login/cooldown).
    // Ne PAS compter comme erreur — le watcher attend que le captcha/login se termine.
    console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] Aucun groupe avec scanner valide — attente re-login (non-fatal)`);
    return;
  }

  console.log(`[ofc-watcher] 📡 [${ofc.postName}] POST getFirstAvailableMonth (groupes: ${groups.map(g => `${g.label}[${g.locationType}]→${g.scanner.username.slice(0, 12)}…`).join(" + ")})`);

  for (const group of groups) {
    const { scanner: groupScanner, locationType, label, scannerToken } = group;

    // FIX-22: Renouveler le X-Correlation-key du scanner AVANT le POST.
    // Sans ça, le scanner peut avoir un correlation key stale (ex: "dashboard" du GET alternation)
    // et le serveur retourne 404. Le mode séquentiel faisait resetCorrelationOnAction("ofc-selection")
    // avant chaque getFirstAvailableMonth. Le watcher doit faire pareil PER-SCANNER.
    resetCorrelationOnAction("schedule-appointment/ofc-selection", groupScanner.username);

    // FIX-20: Utiliser le token du scanner du groupe (pas le token du watcher global)
    // et l'username du scanner pour les headers (correlation, UA sticky, etc.)
    const hdrs = authHeaders(scannerToken, "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment", true, groupScanner.username);

    // FIX-20: Le payload utilise l'applicationId/applicantId du scanner (même compte que le token)
    const payload: Record<string, unknown> = {
      postUserId: ofc.postUserId,
      applicantId: groupScanner.appDetails.applicantId,
      visaType: (groupScanner.appDetails as unknown as Record<string, unknown>).visaTypeKey ?? groupScanner.appDetails.visaType,
      visaClass: groupScanner.appDetails.visaClass,
      locationType,
      applicationId: groupScanner.appDetails.applicationId,
    };

    const reqStart = Date.now();

    const res = await fetcher.fetch(USA_FIRST_AVAILABLE_MONTH_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(payload),
    });

    state.lastLatencyMs = Date.now() - reqStart;
    state.totalRefreshes++;
    console.log(`[ofc-watcher] 📡 [${ofc.postName}] POST[${label}] → HTTP ${res.status} (${state.lastLatencyMs}ms) | scanner: ${groupScanner.username.slice(0, 12)}… | refresh #${state.totalRefreshes}`);

    // Erreurs critiques → throw pour déclencher le error handling + failover
    if (res.status === 429 || res.status === 403) {
      throw new Error(`HTTP_${res.status}`);
    }
    if (res.status === 401) {
      // FIX-20: Token du scanner de ce groupe expiré — non-fatal, skip ce groupe
      console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] POST[${label}] 401 — token scanner ${groupScanner.username.slice(0, 12)}… expiré, skip groupe`);
      continue;
    }
    if (res.status === 503) {
      throw new Error("PROXY_DEAD");
    }
    if (!res.ok) {
      // 404 non-fatal pour ce groupe — l'autre groupe peut réussir
      console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] POST[${label}] HTTP ${res.status} — non-fatal, groupe skip`);
      continue;
    }

    // Reset erreurs sur succès
    state.consecutiveErrors = 0;

    const data = await res.json() as { present?: boolean; date?: string };

    // Log périodique
    const pred = getCurrentPredictionScore(groupScanner.username);
    if (state.totalRefreshes % 5 === 0 || state.totalRefreshes <= 3) {
      console.log(
        `[ofc-watcher] 🔄 #${state.totalRefreshes} ${ofc.postName} [${label}] | scanner: ${groupScanner.username.slice(0, 12)}… | pred=${pred.window} | ` +
        `latency=${state.lastLatencyMs}ms | subscribers=${state.subscribers.size}`,
      );
    }

    // botLog uniquement quand slot détecté (pas à chaque scan — le summary toutes les 5 min suffit)

    if (data.present && data.date) {
      // 🚨 SLOT DÉTECTÉ!
      console.log(`[ofc-watcher] 🚨🚨🚨 SLOT DÉTECTÉ sur ${ofc.postName} [${label}]! date=${data.date} (scanner: ${groupScanner.username.slice(0, 12)}…, refresh #${state.totalRefreshes})`);

      // Enregistrer l'observation (Early Bird + competitive intelligence)
      recordSlotObservation(groupScanner.username, ofc.postName);
      recordSlotAppearance(ofc.postName, data.date);

      // FIX-19: Filtrer les subscribers du MÊME GROUPE (NEW ou RESCHEDULE)
      // Un slot détecté via locationType=POST ne concerne que les dossiers RESCHEDULE.
      // Un slot détecté via locationType=OFC ne concerne que les dossiers NEW.
      const groupSubs = label === "RESCHEDULE" ? rescheduleGroup : newGroup;
      const eligibleSubscribers = groupSubs.filter(sub => {
        if (sub.dateDeadline && data.date! > sub.dateDeadline) return false;
        if (sub.dateFrom && data.date! < sub.dateFrom) return false;
        return true;
      });

      if (eligibleSubscribers.length > 0) {
        // BROADCAST → booking race parallèle
        const event: SlotDetectedEvent = {
          ofcName: ofc.postName,
          firstAvailableMonth: data.date,
          detectedAt: Date.now(),
          watcherUsername: groupScanner.username,
        };

        botLog({
          applicationId: groupScanner.jobId,
          step: "ofc_watcher_slot_detected",
          status: "ok",
          data: {
            ofcName: ofc.postName,
            date: data.date,
            group: label,
            scanner: groupScanner.username,
            refreshNumber: state.totalRefreshes,
            subscriberCount: eligibleSubscribers.length,
            latencyMs: state.lastLatencyMs,
          },
        });

        // Appeler le callback de notification (booking race dans index.ts)
        try {
          await state.onSlotDetected(event, eligibleSubscribers);
        } catch (err) {
          console.error(`[ofc-watcher] ❌ Erreur callback onSlotDetected:`, err);
        }
      } else {
        console.log(`[ofc-watcher] ⚠️ Slot détecté [${label}] mais aucun subscriber éligible (deadline/dateFrom)`);
      }
    } else {
      // Pas de slot pour ce groupe → enregistrer (competitive intelligence)
      recordAllSlotsGone(ofc.postName);
    }

    // Petite pause entre les deux requêtes de groupe (anti-burst)
    if (groups.length > 1 && group !== groups[groups.length - 1]) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
    }
  } // fin boucle groups
}

// ─── Intervalle adaptatif ───────────────────────────────────────────────────

function computeWatcherInterval(state: OfcWatcherState): number {
  let interval = WATCHER_BASE_INTERVAL_MS;

  // Multiplicateur Early Bird (fenêtre chaude/froide)
  const predMultiplier = getRefreshMultiplier(state.watcherUsername);
  interval *= predMultiplier;

  // Multiplicateur compétition
  const compMultiplier = getCompetitionRefreshMultiplier();
  interval *= compMultiplier;

  // Si latence élevée → ralentir
  if (state.lastLatencyMs > 5000) {
    interval *= 1.5;
  } else if (state.lastLatencyMs > 3000) {
    interval *= 1.2;
  }

  // Clamp
  interval = Math.max(WATCHER_MIN_INTERVAL_MS, Math.min(interval, WATCHER_MAX_INTERVAL_MS));

  // Jitter gaussien ±15%
  const jitter = 1.0 + (Math.random() - 0.5) * 0.3;
  interval *= jitter;

  return Math.round(Math.max(WATCHER_MIN_INTERVAL_MS, Math.min(interval, WATCHER_MAX_INTERVAL_MS)));
}

// ─── Utilitaires ────────────────────────────────────────────────────────────

/**
 * Arrête TOUS les watchers actifs (cleanup au shutdown).
 */
export function stopAllWatchers(): void {
  for (const ofcKey of [...activeWatchers.keys()]) {
    stopOfcWatcher(ofcKey);
  }
}

/**
 * Retourne le nombre de watchers actifs.
 */
export function getActiveWatcherCount(): number {
  return activeWatchers.size;
}
