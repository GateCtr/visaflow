/**
 * Prediction Engine V3 — Unifie heatmap + competition + discovery en un seul module.
 *
 * MERGE des modules V2 existants :
 *   - slot-prediction.ts (Early Bird heatmap)
 *   - competitive-intelligence.ts (durée de vie slots)
 *   + NOUVEAU : SlotPattern agrégé + bestDays + blindBookingSuccessRate
 *
 * RESPONSABILITÉ :
 *   Fournir un SlotPattern complet pour piloter le scan-orchestrator et les stats admin.
 *   Ne fait PAS de scan, ne fait PAS de booking — juste de l'intelligence.
 *
 * USAGE :
 *   const pattern = getSlotPattern(username);
 *   const decision = getNextScanDecision({ predictionScore: pattern.currentScore, ... });
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Pattern complet de slots observé — alimenté par les scans + bookings. */
export interface SlotPattern {
  /** Fenêtres de libération observées (heatmap 7j glissant, 48 tranches/jour). */
  hotWindows: HotWindowEntry[];
  /** Jours de la semaine les plus productifs (0=Dim ... 6=Sam). */
  bestDays: { day: number; slotsFound: number }[];
  /** Niveau de compétition estimé. */
  competitionLevel: "extreme" | "high" | "moderate" | "low" | "unknown";
  /** Durée de vie médiane des slots (secondes). 0 = pas assez de données. */
  medianLifespanSec: number;
  /** Taux de succès du blind booking (0-1). -1 = pas de données. */
  blindBookingSuccessRate: number;
  /** Dates les plus fréquemment libérées (top 5 mois). */
  topDatesFrequency: { month: string; count: number }[];
  /** Score actuel de la heatmap (0-1) pour la tranche horaire en cours. */
  currentScore: number;
  /** La fenêtre actuelle est-elle "hot" (score > 0.4) ? */
  isHotNow: boolean;
  /** Total d'observations (slots détectés). */
  totalObservations: number;
}

export interface HotWindowEntry {
  /** Heure de début (0-23.5, tranches de 30 min). */
  hour: number;
  /** Score normalisé (0-1). */
  score: number;
  /** Durée de vie moyenne des slots dans cette tranche (secondes). */
  avgLifespanSec: number;
}

// ─── État (en mémoire, per-account) ─────────────────────────────────────────

interface PredictionState {
  /** Timestamps de chaque slot détecté (7j glissant). */
  slotTimestamps: number[];
  /** Durées de vie mesurées (ms) des slots (24h glissant). */
  lifespans: number[];
  /** Slots actifs (détectés mais pas encore disparus). */
  activeSlots: Map<string, { firstSeen: number; office: string; date: string }>;
  /** Blind booking tentatives/succès. */
  blindAttempts: number;
  blindSuccesses: number;
  /** Discovery : compteur par mois (ex: "2026-09" → 5). */
  monthFrequency: Map<string, number>;
  /** Compteur par jour de la semaine (0-6). */
  dayOfWeekCounts: number[];
}

const states = new Map<string, PredictionState>();

const MAX_HISTORY_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const MAX_LIFESPAN_RECORDS = 100;
const SLOTS_PER_DAY = 48; // Tranches de 30 min
const HOT_THRESHOLD = 0.4;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getState(username: string): PredictionState {
  const key = username.toLowerCase();
  if (!states.has(key)) {
    states.set(key, {
      slotTimestamps: [],
      lifespans: [],
      activeSlots: new Map(),
      blindAttempts: 0,
      blindSuccesses: 0,
      monthFrequency: new Map(),
      dayOfWeekCounts: [0, 0, 0, 0, 0, 0, 0],
    });
  }
  return states.get(key)!;
}

function timestampToSlotIndex(ts: number): number {
  const d = new Date(ts);
  return d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0);
}

function pruneOld(state: PredictionState): void {
  const cutoff = Date.now() - MAX_HISTORY_MS;
  state.slotTimestamps = state.slotTimestamps.filter(ts => ts >= cutoff);
  // Lifespans : garder les 100 derniers seulement
  if (state.lifespans.length > MAX_LIFESPAN_RECORDS) {
    state.lifespans = state.lifespans.slice(-MAX_LIFESPAN_RECORDS);
  }
}

function buildHeatmap(timestamps: number[]): number[] {
  const counts = new Array(SLOTS_PER_DAY).fill(0);
  for (const ts of timestamps) {
    counts[timestampToSlotIndex(ts)]++;
  }
  const max = Math.max(...counts, 1);
  return counts.map(c => c / max);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── API publique : Recording ───────────────────────────────────────────────

/** Enregistre la détection d'un slot (appelé quand getFirstAvailableMonth retourne present=true). */
export function recordSlotDetected(username: string, office: string, date: string): void {
  const state = getState(username);
  const now = Date.now();
  state.slotTimestamps.push(now);
  state.dayOfWeekCounts[new Date(now).getDay()]++;

  // Tracker le mois
  const month = date.slice(0, 7); // "2026-09"
  state.monthFrequency.set(month, (state.monthFrequency.get(month) ?? 0) + 1);

  // Tracker le slot actif (pour mesurer sa durée de vie)
  const slotKey = `${office}|${date}`;
  if (!state.activeSlots.has(slotKey)) {
    state.activeSlots.set(slotKey, { firstSeen: now, office, date });
  }

  pruneOld(state);
}

/** Enregistre la disparition d'un slot (n'est plus dans les résultats). */
export function recordSlotGone(username: string, office: string, date: string): void {
  const state = getState(username);
  const slotKey = `${office}|${date}`;
  const active = state.activeSlots.get(slotKey);
  if (active) {
    const lifespan = Date.now() - active.firstSeen;
    state.lifespans.push(lifespan);
    state.activeSlots.delete(slotKey);
  }
}

/** Enregistre tous les slots comme disparus pour un OFC (calendrier vide). */
export function recordAllSlotsGone(username: string, office: string): void {
  const state = getState(username);
  const now = Date.now();
  for (const [key, slot] of state.activeSlots) {
    if (slot.office === office) {
      state.lifespans.push(now - slot.firstSeen);
      state.activeSlots.delete(key);
    }
  }
}

/** Enregistre un résultat de blind booking (pour le taux de succès). */
export function recordBlindBookingResult(username: string, success: boolean): void {
  const state = getState(username);
  state.blindAttempts++;
  if (success) state.blindSuccesses++;
}

/** Injecte des observations historiques (bootstrap depuis Convex au démarrage). */
export function injectHistorical(username: string, timestamps: number[]): void {
  const state = getState(username);
  const cutoff = Date.now() - MAX_HISTORY_MS;
  for (const ts of timestamps) {
    if (ts >= cutoff) {
      state.slotTimestamps.push(ts);
      state.dayOfWeekCounts[new Date(ts).getDay()]++;
    }
  }
  pruneOld(state);
}

// ─── API publique : Reading ─────────────────────────────────────────────────

/** Retourne le SlotPattern complet pour un compte. */
export function getSlotPattern(username: string): SlotPattern {
  const state = getState(username);
  pruneOld(state);

  // Heatmap
  const heatmap = buildHeatmap(state.slotTimestamps);
  const currentSlotIdx = timestampToSlotIndex(Date.now());
  const currentScore = heatmap[currentSlotIdx] ?? 0;

  // Hot windows (score > 0.2)
  const hotWindows: HotWindowEntry[] = [];
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    if (heatmap[i] > 0.2) {
      hotWindows.push({
        hour: i / 2,
        score: heatmap[i],
        avgLifespanSec: state.lifespans.length > 0 ? Math.round(median(state.lifespans) / 1000) : 0,
      });
    }
  }

  // Best days
  const bestDays = state.dayOfWeekCounts
    .map((count, day) => ({ day, slotsFound: count }))
    .filter(d => d.slotsFound > 0)
    .sort((a, b) => b.slotsFound - a.slotsFound);

  // Competition
  const medianMs = median(state.lifespans);
  const medianSec = Math.round(medianMs / 1000);
  let competitionLevel: SlotPattern["competitionLevel"] = "unknown";
  if (state.lifespans.length >= 3) {
    if (medianMs < 30_000) competitionLevel = "extreme";
    else if (medianMs < 120_000) competitionLevel = "high";
    else if (medianMs < 300_000) competitionLevel = "moderate";
    else competitionLevel = "low";
  }

  // Blind booking success rate
  const blindRate = state.blindAttempts > 0
    ? state.blindSuccesses / state.blindAttempts
    : -1;

  // Top dates frequency (par mois, top 5)
  const topDates = [...state.monthFrequency.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    hotWindows,
    bestDays,
    competitionLevel,
    medianLifespanSec: medianSec,
    blindBookingSuccessRate: blindRate,
    topDatesFrequency: topDates,
    currentScore,
    isHotNow: currentScore >= HOT_THRESHOLD,
    totalObservations: state.slotTimestamps.length,
  };
}

/** Retourne le score heatmap actuel (pour le scan-orchestrator). */
export function getCurrentPredictionScore(username: string): number {
  const state = getState(username);
  if (state.slotTimestamps.length === 0) return 0;
  const heatmap = buildHeatmap(state.slotTimestamps);
  return heatmap[timestampToSlotIndex(Date.now())] ?? 0;
}

/** Retourne la durée de vie médiane des slots (pour le scan-orchestrator). */
export function getCompetitionMedianMs(username: string): number {
  const state = getState(username);
  if (state.lifespans.length < 3) return 0;
  return median(state.lifespans);
}

/** Reset (pour les tests). */
export function _resetForTesting(): void {
  states.clear();
}
