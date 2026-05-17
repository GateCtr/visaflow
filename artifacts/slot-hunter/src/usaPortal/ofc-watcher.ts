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
 */
export function failoverWatcher(ofcKey: string): boolean {
  const state = activeWatchers.get(ofcKey);
  if (!state) return false;

  // Trouver un subscriber avec un token valide et un proxy
  for (const [jobId, sub] of state.subscribers) {
    if (sub.username === state.watcherUsername) continue; // skip le watcher actuel
    const cached = tokenCache.get(sub.username.toLowerCase());
    if (!cached || Date.now() >= cached.expiresAt) continue; // token expiré

    // Nouveau watcher trouvé!
    console.log(`[ofc-watcher] 🔄 FAILOVER ${state.ofc.postName}: ${state.watcherUsername.slice(0, 12)}… → ${sub.username.slice(0, 12)}…`);

    // Disposer l'ancien fetcher
    state.fetcher.dispose();

    // Créer un nouveau fetcher avec le nouveau compte
    state.watcherUsername = sub.username;
    state.fetcher = createSessionFetcher({
      proxyUrl: sub.proxyUrl,
      username: sub.username,
      label: `watcher:${state.ofc.postName}`,
    });
    state.consecutiveErrors = 0;

    return true;
  }

  console.warn(`[ofc-watcher] ⚠️ FAILOVER impossible pour ${state.ofc.postName} — aucun subscriber éligible`);
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
        const didFailover = failoverWatcher(state.ofcKey);
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
    await new Promise(r => setTimeout(r, interval));
  }
}

async function doWatcherRefresh(state: OfcWatcherState): Promise<void> {
  const { fetcher, watcherUsername, ofc } = state;

  // Vérifier que le token du watcher est valide
  const cached = tokenCache.get(watcherUsername.toLowerCase());
  if (!cached || Date.now() >= cached.expiresAt) {
    console.error(`[ofc-watcher] ⚠️ Token invalide/expiré pour ${watcherUsername.slice(0, 12)}…`);
    throw new Error("TOKEN_EXPIRED");
  }

  // ── Stealthy Alternation: 1/4 des requêtes = GET getLandingPage ──────────
  // Un humain ne fait pas 100% de POST getFirstAvailableMonth. Il navigue
  // parfois sur le dashboard entre ses vérifications → pattern plus naturel.
  const useLandingPage = Math.random() < WATCHER_LANDING_PAGE_RATIO;

  if (useLandingPage) {
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

    if (res.status === 401) throw new Error("TOKEN_EXPIRED");
    if (res.status === 429 || res.status === 403) throw new Error(`HTTP_${res.status}`);
    if (res.status === 503) throw new Error("PROXY_DEAD");

    // Reset erreurs sur succès
    if (res.ok || res.status < 500) {
      state.consecutiveErrors = 0;
    }

    // Log périodique
    if (state.totalRefreshes % 5 === 0) {
      console.log(`[ofc-watcher] 🔄 #${state.totalRefreshes} ${ofc.postName} [landing] | latency=${state.lastLatencyMs}ms`);
    }
    return; // Pas de détection de slot via getLandingPage
  }

  // ── POST getFirstAvailableMonth — le vrai check de disponibilité ──────────
  console.log(`[ofc-watcher] 📡 [${ofc.postName}] POST getFirstAvailableMonth (compte: ${watcherUsername.slice(0, 12)}…)`);
  // Construire le payload — utiliser un subscriber avec des données valides
  // (skip ceux dont le bootstrap a échoué = applicationId vide)
  let firstSub: OfcWatcherSubscriber | undefined;
  for (const sub of state.subscribers.values()) {
    if (sub.appDetails.applicationId && sub.appDetails.applicationId !== "0") {
      firstSub = sub;
      break;
    }
  }
  if (!firstSub) {
    // Aucun subscriber avec des données valides → skip ce cycle
    console.warn(`[ofc-watcher] ⚠️ [${ofc.postName}] Aucun subscriber avec applicationId valide — skip`);
    return;
  }

  const hdrs = authHeaders(cached.accessToken, "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment", true, watcherUsername);

  const payload: Record<string, unknown> = {
    postUserId: ofc.postUserId,
    applicantId: firstSub.appDetails.applicantId,
    visaType: (firstSub.appDetails as unknown as Record<string, unknown>).visaTypeKey ?? firstSub.appDetails.visaType,
    visaClass: firstSub.appDetails.visaClass,
    locationType: firstSub.rescheduleYN
      ? (firstSub.appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
      : (ofc.officeType ?? "OFC"),
    applicationId: firstSub.appDetails.applicationId,
  };

  const reqStart = Date.now();

  const res = await fetcher.fetch(USA_FIRST_AVAILABLE_MONTH_URL, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify(payload),
  });

  state.lastLatencyMs = Date.now() - reqStart;
  state.totalRefreshes++;
  console.log(`[ofc-watcher] 📡 [${ofc.postName}] POST → HTTP ${res.status} (${state.lastLatencyMs}ms) | refresh #${state.totalRefreshes}`);

  // Erreurs critiques → throw pour déclencher le error handling + failover
  if (res.status === 429 || res.status === 403) {
    throw new Error(`HTTP_${res.status}`);
  }
  if (res.status === 401) {
    // Token expiré ou compte restreint
    throw new Error("TOKEN_EXPIRED");
  }
  if (res.status === 503) {
    // Proxy mort (réponse du proxy guard)
    throw new Error("PROXY_DEAD");
  }
  if (!res.ok) {
    state.consecutiveErrors++;
    return; // Erreur non-fatale
  }

  // Reset erreurs sur succès
  state.consecutiveErrors = 0;

  const data = await res.json() as { present?: boolean; date?: string };

  // Log périodique
  const pred = getCurrentPredictionScore(watcherUsername);
  if (state.totalRefreshes % 5 === 0 || state.totalRefreshes <= 3) {
    console.log(
      `[ofc-watcher] 🔄 #${state.totalRefreshes} ${ofc.postName} | compte: ${watcherUsername.slice(0, 12)}… | pred=${pred.window} | ` +
      `latency=${state.lastLatencyMs}ms | subscribers=${state.subscribers.size}`,
    );
  }

  // botLog pour visibilité dans l'interface admin (chaque scan)
  botLog({
    applicationId: firstSub.jobId,
    step: "ofc_watcher_scan",
    status: data.present ? "ok" : "warn",
    data: {
      ofcName: ofc.postName,
      scanAccount: watcherUsername,
      refreshNumber: state.totalRefreshes,
      result: data.present ? `SLOT ${data.date}` : "Pas de créneau",
      latencyMs: state.lastLatencyMs,
      subscriberCount: state.subscribers.size,
      predictionWindow: pred.window,
    },
  });

  if (data.present && data.date) {
    // 🚨 SLOT DÉTECTÉ!
    console.log(`[ofc-watcher] 🚨🚨🚨 SLOT DÉTECTÉ sur ${ofc.postName}! date=${data.date} (refresh #${state.totalRefreshes})`);

    // Enregistrer l'observation (Early Bird + competitive intelligence)
    recordSlotObservation(watcherUsername, ofc.postName);
    recordSlotAppearance(ofc.postName, data.date);

    // Filtrer les subscribers selon leur deadline
    const eligibleSubscribers = [...state.subscribers.values()].filter(sub => {
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
        watcherUsername,
      };

      botLog({
        applicationId: eligibleSubscribers[0].jobId,
        step: "ofc_watcher_slot_detected",
        status: "ok",
        data: {
          ofcName: ofc.postName,
          date: data.date,
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
      console.log(`[ofc-watcher] ⚠️ Slot détecté mais aucun subscriber éligible (deadline/dateFrom)`);
    }
  } else {
    // Pas de slot → enregistrer (competitive intelligence)
    recordAllSlotsGone(ofc.postName);
  }
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
