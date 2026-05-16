/**
 * Early Bird — Prédiction des fenêtres de libération de créneaux.
 *
 * CONCEPT :
 *   Le portail USA libère les créneaux selon des patterns temporels récurrents
 *   (batch releases quotidiennes, souvent à des heures fixes ±30min).
 *   En analysant l'historique des timestamps `slot_found`, on peut prédire
 *   les prochaines fenêtres chaudes et adapter la fréquence de refresh.
 *
 * DONNÉES :
 *   - Stocke les timestamps de chaque slot détecté (via botLog "slot_found")
 *   - Agrège par tranche horaire (30 min) sur 7 jours glissants
 *   - Calcule un score de probabilité par tranche (0-1)
 *
 * UTILISATION :
 *   - `isHotWindow()` → true si on est dans une fenêtre à haute probabilité
 *   - `getRefreshMultiplier()` → multiplicateur 0.3-2.0 pour l'intervalle de refresh
 *   - `getNextHotWindow()` → timestamp de la prochaine fenêtre chaude prédite
 */

import { botLog } from "../convexClient.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Nombre de jours d'historique à conserver. */
const HISTORY_DAYS = 7;

/** Nombre de tranches par jour (48 = tranches de 30 min). */
const SLOTS_PER_DAY = 48;

/** Seuil pour considérer une tranche comme "chaude". */
const HOT_THRESHOLD = 0.4;

/** Seuil pour considérer une tranche comme "tiède". */
const WARM_THRESHOLD = 0.2;

/** Nombre minimum d'observations pour que la prédiction soit fiable. */
const MIN_OBSERVATIONS = 3;

/** Fenêtre de tolérance autour d'une tranche chaude (±1 tranche = ±30 min). */
const HOT_WINDOW_TOLERANCE_SLOTS = 1;

/** Durée max de stockage en mémoire (7 jours en ms). */
const MAX_HISTORY_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlotObservation {
  /** Timestamp de la détection du slot (Date.now()). */
  timestamp: number;
  /** Bureau (OFC) concerné. */
  office?: string;
  /** Jour de la semaine (0=dim, 6=sam). */
  dayOfWeek: number;
  /** Index de la tranche horaire (0-47, tranches de 30 min). */
  slotIndex: number;
}

export interface HotWindowPrediction {
  /** Index de la tranche horaire (0-47). */
  slotIndex: number;
  /** Score de probabilité (0-1). */
  score: number;
  /** Heure de début (ex: "08:30"). */
  startTime: string;
  /** Heure de fin (ex: "09:00"). */
  endTime: string;
  /** Nombre d'observations dans cette tranche. */
  observations: number;
}

export interface PredictionState {
  /** Historique des observations. */
  history: SlotObservation[];
  /** Heatmap : score par tranche (index 0-47). */
  heatmap: number[];
  /** Nombre d'observations par tranche. */
  counts: number[];
  /** Dernière mise à jour du heatmap. */
  lastComputed: number;
  /** Total d'observations. */
  totalObservations: number;
}

// ─── Stockage en mémoire (par username) ─────────────────────────────────────

const predictionStates = new Map<string, PredictionState>();

/** Obtient ou crée l'état de prédiction pour un compte. */
function getState(username: string): PredictionState {
  const key = username.toLowerCase();
  let state = predictionStates.get(key);
  if (!state) {
    state = {
      history: [],
      heatmap: new Array(SLOTS_PER_DAY).fill(0),
      counts: new Array(SLOTS_PER_DAY).fill(0),
      lastComputed: 0,
      totalObservations: 0,
    };
    predictionStates.set(key, state);
  }
  return state;
}

// ─── Fonctions utilitaires ──────────────────────────────────────────────────

/** Convertit un timestamp en index de tranche horaire (0-47). */
function timestampToSlotIndex(ts: number): number {
  const date = new Date(ts);
  const hours = date.getHours();
  const minutes = date.getMinutes();
  return hours * 2 + (minutes >= 30 ? 1 : 0);
}

/** Convertit un index de tranche en label heure (ex: "08:30"). */
function slotIndexToTimeLabel(index: number): string {
  const hours = Math.floor(index / 2);
  const minutes = (index % 2) * 30;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

/** Nettoie les observations trop anciennes (> 7 jours). */
function pruneHistory(state: PredictionState): void {
  const cutoff = Date.now() - MAX_HISTORY_MS;
  const before = state.history.length;
  state.history = state.history.filter(obs => obs.timestamp >= cutoff);
  if (state.history.length < before) {
    // Recalculer le heatmap après pruning
    recomputeHeatmap(state);
  }
}

/** Recalcule le heatmap depuis l'historique. */
function recomputeHeatmap(state: PredictionState): void {
  state.heatmap = new Array(SLOTS_PER_DAY).fill(0);
  state.counts = new Array(SLOTS_PER_DAY).fill(0);

  for (const obs of state.history) {
    state.counts[obs.slotIndex]++;
  }

  state.totalObservations = state.history.length;

  // Normaliser les scores (0-1) — le max count = score 1.0
  const maxCount = Math.max(...state.counts, 1);
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    state.heatmap[i] = state.counts[i] / maxCount;
  }

  // Appliquer un lissage gaussien (fenêtre de 3) pour réduire le bruit
  const smoothed = new Array(SLOTS_PER_DAY).fill(0);
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const prev = state.heatmap[(i - 1 + SLOTS_PER_DAY) % SLOTS_PER_DAY];
    const curr = state.heatmap[i];
    const next = state.heatmap[(i + 1) % SLOTS_PER_DAY];
    smoothed[i] = prev * 0.2 + curr * 0.6 + next * 0.2;
  }
  state.heatmap = smoothed;
  state.lastComputed = Date.now();
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Enregistre une observation de slot trouvé.
 * À appeler chaque fois qu'un slot est détecté (dans le flow de booking ou refresh).
 */
export function recordSlotObservation(username: string, office?: string): void {
  const state = getState(username);
  const now = Date.now();
  const date = new Date(now);

  const observation: SlotObservation = {
    timestamp: now,
    office,
    dayOfWeek: date.getDay(),
    slotIndex: timestampToSlotIndex(now),
  };

  state.history.push(observation);
  state.totalObservations++;

  // Mettre à jour le heatmap incrémentalement
  state.counts[observation.slotIndex]++;
  const maxCount = Math.max(...state.counts, 1);
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    state.heatmap[i] = state.counts[i] / maxCount;
  }

  // Pruner périodiquement (toutes les 10 observations)
  if (state.totalObservations % 10 === 0) {
    pruneHistory(state);
  }

  console.log(
    `[early-bird] 📝 Observation enregistrée: ${slotIndexToTimeLabel(observation.slotIndex)} ` +
    `(jour ${observation.dayOfWeek}, office=${office ?? "global"}) — total: ${state.history.length}`,
  );
}

/**
 * Injecte des observations historiques (ex: depuis Convex au démarrage).
 * Permet d'initialiser le modèle sans attendre 7 jours de données.
 */
export function injectHistoricalObservations(
  username: string,
  timestamps: number[],
  office?: string,
): void {
  const state = getState(username);
  const cutoff = Date.now() - MAX_HISTORY_MS;

  for (const ts of timestamps) {
    if (ts < cutoff) continue; // Ignorer les observations trop anciennes
    const date = new Date(ts);
    state.history.push({
      timestamp: ts,
      office,
      dayOfWeek: date.getDay(),
      slotIndex: timestampToSlotIndex(ts),
    });
  }

  state.totalObservations = state.history.length;
  recomputeHeatmap(state);

  console.log(
    `[early-bird] 📊 ${timestamps.length} observations historiques injectées pour ${username} ` +
    `(${state.history.length} retenues après pruning)`,
  );
}

/**
 * Détermine si le moment actuel est dans une fenêtre "chaude" (haute probabilité de slot).
 */
export function isHotWindow(username: string): boolean {
  const state = getState(username);
  if (state.totalObservations < MIN_OBSERVATIONS) return false;

  const currentSlot = timestampToSlotIndex(Date.now());

  // Vérifier la tranche courante et les tranches adjacentes (tolérance ±30 min)
  for (let offset = -HOT_WINDOW_TOLERANCE_SLOTS; offset <= HOT_WINDOW_TOLERANCE_SLOTS; offset++) {
    const idx = (currentSlot + offset + SLOTS_PER_DAY) % SLOTS_PER_DAY;
    if (state.heatmap[idx] >= HOT_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/**
 * Détermine si le moment actuel est dans une fenêtre "tiède" (probabilité modérée).
 */
export function isWarmWindow(username: string): boolean {
  const state = getState(username);
  if (state.totalObservations < MIN_OBSERVATIONS) return false;

  const currentSlot = timestampToSlotIndex(Date.now());

  for (let offset = -HOT_WINDOW_TOLERANCE_SLOTS; offset <= HOT_WINDOW_TOLERANCE_SLOTS; offset++) {
    const idx = (currentSlot + offset + SLOTS_PER_DAY) % SLOTS_PER_DAY;
    if (state.heatmap[idx] >= WARM_THRESHOLD) {
      return true;
    }
  }
  return false;
}

/**
 * Retourne un multiplicateur d'intervalle de refresh basé sur la prédiction.
 *
 * - Fenêtre chaude → 0.3 (refresh 3× plus rapide)
 * - Fenêtre tiède → 0.6 (refresh 1.7× plus rapide)
 * - Fenêtre froide → 1.5 (refresh plus lent, économie de requêtes)
 * - Pas assez de données → 1.0 (neutre, pas de modification)
 */
export function getRefreshMultiplier(username: string): number {
  const state = getState(username);
  if (state.totalObservations < MIN_OBSERVATIONS) return 1.0;

  const currentSlot = timestampToSlotIndex(Date.now());

  // Score maximum dans la fenêtre de tolérance
  let maxScore = 0;
  for (let offset = -HOT_WINDOW_TOLERANCE_SLOTS; offset <= HOT_WINDOW_TOLERANCE_SLOTS; offset++) {
    const idx = (currentSlot + offset + SLOTS_PER_DAY) % SLOTS_PER_DAY;
    maxScore = Math.max(maxScore, state.heatmap[idx]);
  }

  if (maxScore >= HOT_THRESHOLD) {
    // Fenêtre chaude → refresh agressif (0.3-0.5)
    return 0.3 + (1 - maxScore) * 0.2;
  }
  if (maxScore >= WARM_THRESHOLD) {
    // Fenêtre tiède → refresh modéré (0.6-0.8)
    return 0.6 + (HOT_THRESHOLD - maxScore) * 1.0;
  }
  // Fenêtre froide → ralentir (1.2-1.8)
  return 1.2 + (WARM_THRESHOLD - maxScore) * 3.0;
}

/**
 * Retourne la prochaine fenêtre chaude prédite.
 * Utile pour décider s'il vaut mieux attendre ou scanner maintenant.
 */
export function getNextHotWindow(username: string): {
  minutesUntil: number;
  slotIndex: number;
  score: number;
  timeLabel: string;
} | null {
  const state = getState(username);
  if (state.totalObservations < MIN_OBSERVATIONS) return null;

  const currentSlot = timestampToSlotIndex(Date.now());
  const now = new Date();
  const currentMinuteInSlot = now.getMinutes() % 30;

  // Chercher la prochaine tranche chaude (dans les 24 prochaines heures)
  for (let offset = 1; offset < SLOTS_PER_DAY; offset++) {
    const idx = (currentSlot + offset) % SLOTS_PER_DAY;
    if (state.heatmap[idx] >= HOT_THRESHOLD) {
      // Calculer les minutes jusqu'à cette tranche
      const minutesUntil = offset * 30 - currentMinuteInSlot;
      return {
        minutesUntil: Math.max(0, minutesUntil),
        slotIndex: idx,
        score: state.heatmap[idx],
        timeLabel: slotIndexToTimeLabel(idx),
      };
    }
  }

  return null;
}

/**
 * Retourne les top-N fenêtres chaudes pour le logging/dashboard.
 */
export function getHotWindows(username: string, topN: number = 5): HotWindowPrediction[] {
  const state = getState(username);
  if (state.totalObservations < MIN_OBSERVATIONS) return [];

  const predictions: HotWindowPrediction[] = [];
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    if (state.heatmap[i] >= WARM_THRESHOLD) {
      predictions.push({
        slotIndex: i,
        score: state.heatmap[i],
        startTime: slotIndexToTimeLabel(i),
        endTime: slotIndexToTimeLabel((i + 1) % SLOTS_PER_DAY),
        observations: state.counts[i],
      });
    }
  }

  // Trier par score décroissant
  predictions.sort((a, b) => b.score - a.score);
  return predictions.slice(0, topN);
}

/**
 * Retourne le score actuel pour le logging.
 */
export function getCurrentPredictionScore(username: string): {
  score: number;
  window: "hot" | "warm" | "cold" | "unknown";
  totalObservations: number;
  multiplier: number;
} {
  const state = getState(username);
  if (state.totalObservations < MIN_OBSERVATIONS) {
    return { score: 0, window: "unknown", totalObservations: state.totalObservations, multiplier: 1.0 };
  }

  const currentSlot = timestampToSlotIndex(Date.now());
  const score = state.heatmap[currentSlot];
  const multiplier = getRefreshMultiplier(username);

  let window: "hot" | "warm" | "cold";
  if (score >= HOT_THRESHOLD) window = "hot";
  else if (score >= WARM_THRESHOLD) window = "warm";
  else window = "cold";

  return { score, window, totalObservations: state.totalObservations, multiplier };
}

/**
 * Log le résumé de la prédiction dans Convex (pour le dashboard admin).
 */
export function logPredictionSummary(username: string, applicationId: string): void {
  const state = getState(username);
  if (state.totalObservations < MIN_OBSERVATIONS) return;

  const current = getCurrentPredictionScore(username);
  const hotWindows = getHotWindows(username, 3);
  const nextHot = getNextHotWindow(username);

  botLog({
    applicationId,
    step: "early_bird_prediction",
    status: "ok",
    data: {
      username,
      currentWindow: current.window,
      currentScore: Math.round(current.score * 100) / 100,
      multiplier: Math.round(current.multiplier * 100) / 100,
      totalObservations: current.totalObservations,
      topHotWindows: hotWindows.map(w => `${w.startTime}-${w.endTime} (${Math.round(w.score * 100)}%)`),
      nextHotWindow: nextHot ? `${nextHot.timeLabel} dans ${nextHot.minutesUntil}min` : null,
    },
  });
}

/**
 * Réinitialise l'état de prédiction pour un compte (utile pour les tests).
 */
export function resetPredictionState(username: string): void {
  predictionStates.delete(username.toLowerCase());
}

/**
 * Retourne le nombre total d'observations pour un compte.
 */
export function getObservationCount(username: string): number {
  return getState(username).totalObservations;
}
