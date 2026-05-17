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
import { tokenCache, authHeaders } from "./usa-http.js";
import { USA_FIRST_AVAILABLE_MONTH_URL } from "./config.js";
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
 * Met à jour les appDetails et l'OFC d'un subscriber après un scan initial réussi.
 * Appelé par le scheduler séquentiel après le premier runHunterSession d'un job USA.
 */
export function updateSubscriberAppDetails(
  ofcKey: string,
  jobId: string,
  appDetails: UsaAppDetails,
): void {
  const state = activeWatchers.get(ofcKey);
  if (!state) return;
  const sub = state.subscribers.get(jobId);
  if (!sub) return;
  sub.appDetails = appDetails;
  console.log(`[ofc-watcher] 📝 [${state.ofc.postName}] appDetails mis à jour pour ${sub.username.slice(0, 12)}… (applicantId=${appDetails.applicantId})`);
}

/**
 * Met à jour l'OFC (postUserId) du watcher après résolution par le scan initial.
 */
export function updateWatcherOfc(ofcKey: string, ofc: UsaOfc): void {
  const state = activeWatchers.get(ofcKey);
  if (!state) return;
  if (state.ofc.postUserId === 0 && ofc.postUserId !== 0) {
    state.ofc = ofc;
    console.log(`[ofc-watcher] 📝 [${state.ofc.postName}] postUserId résolu → ${ofc.postUserId}`);
  }
}

/**
 * Vérifie si le watcher a des appDetails résolus (applicantId != 0).
 * Le watcher ne devrait commencer à poll que quand au moins un subscriber a des données valides.
 */
export function hasResolvedAppDetails(ofcKey: string): boolean {
  const state = activeWatchers.get(ofcKey);
  if (!state) return false;
  for (const sub of state.subscribers.values()) {
    if (sub.appDetails.applicantId !== 0) return true;
  }
  return false;
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
  while (!state.stopped) {
    try {
      await doWatcherRefresh(state);
    } catch (err) {
      console.error(`[ofc-watcher] ❌ Erreur refresh ${state.ofc.postName}:`, err);
      state.consecutiveErrors++;

      if (state.consecutiveErrors >= MAX_WATCHER_ERRORS) {
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
    await new Promise(r => setTimeout(r, interval));
  }
}

async function doWatcherRefresh(state: OfcWatcherState): Promise<void> {
  const { fetcher, watcherUsername, ofc } = state;

  // Vérifier que le token du watcher est valide
  const cached = tokenCache.get(watcherUsername.toLowerCase());
  if (!cached || Date.now() >= cached.expiresAt) {
    throw new Error("TOKEN_EXPIRED");
  }

  // Construire le payload (identique à doFirstAvailableMonthRefresh)
  // On a besoin d'un appDetails du premier subscriber pour le payload
  // Trouver un subscriber avec des appDetails résolus (applicantId != 0)
  let activeSub: OfcWatcherSubscriber | undefined;
  for (const sub of state.subscribers.values()) {
    if (sub.appDetails.applicantId !== 0) {
      activeSub = sub;
      break;
    }
  }
  if (!activeSub) {
    // Aucun subscriber n'a encore fait son scan initial → attendre
    if (state.totalRefreshes === 0) {
      console.log(`[ofc-watcher] ⏳ [${ofc.postName}] En attente du scan initial (appDetails non résolus) — retry dans 30s`);
    }
    return;
  }

  const hdrs = authHeaders(cached.accessToken, "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment", true);

  const payload: Record<string, unknown> = {
    postUserId: ofc.postUserId,
    applicantId: activeSub.appDetails.applicantId,
    visaType: (activeSub.appDetails as unknown as Record<string, unknown>).visaTypeKey ?? activeSub.appDetails.visaType,
    visaClass: activeSub.appDetails.visaClass,
    locationType: activeSub.rescheduleYN
      ? (activeSub.appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
      : (ofc.officeType ?? "OFC"),
    applicationId: activeSub.appDetails.applicationId,
  };

  const reqStart = Date.now();

  const res = await fetcher.fetch(USA_FIRST_AVAILABLE_MONTH_URL, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify(payload),
  });

  state.lastLatencyMs = Date.now() - reqStart;
  state.totalRefreshes++;

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
    console.warn(`[ofc-watcher] ⚠️ ${ofc.postName} HTTP ${res.status} (non-fatal, erreur #${state.consecutiveErrors})`);
    return; // Erreur non-fatale
  }

  // Reset erreurs sur succès
  state.consecutiveErrors = 0;

  const data = await res.json() as { present?: boolean; date?: string };

  // Log périodique
  const pred = getCurrentPredictionScore(watcherUsername);
  if (state.totalRefreshes % 5 === 0 || state.totalRefreshes <= 3) {
    console.log(
      `[ofc-watcher] 🔄 #${state.totalRefreshes} ${ofc.postName} | pred=${pred.window} | ` +
      `latency=${state.lastLatencyMs}ms | subscribers=${state.subscribers.size}`,
    );
  }

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
