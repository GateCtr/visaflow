/**
 * Competitive Intelligence — Estimation de la concurrence via la durée de vie des slots.
 *
 * CONCEPT :
 *   En loguant le moment où un slot est détecté pour la première fois et le moment
 *   où il disparaît (refresh suivant = slot absent), on obtient la "durée de vie" du slot.
 *   Cette durée de vie est un indicateur direct de la concurrence :
 *     - Slot qui dure < 30s → concurrence extrême (nombreux bots/humains actifs)
 *     - Slot qui dure 1-5 min → concurrence modérée
 *     - Slot qui dure > 10 min → faible concurrence (peut ralentir le refresh)
 *
 * UTILISATION :
 *   - `recordSlotAppearance()` → log quand un slot est détecté
 *   - `recordSlotDisappearance()` → log quand un slot n'est plus disponible
 *   - `getCompetitionLevel()` → estimation du niveau de concurrence
 *   - `getRecommendedUrgency()` → multiplicateur de vitesse pour le booking
 */

import { botLog } from "../convexClient.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Nombre max de mesures de durée de vie à conserver. */
const MAX_LIFESPAN_RECORDS = 100;

/** Durée de validité des mesures (24h). */
const LIFESPAN_VALIDITY_MS = 24 * 60 * 60 * 1000;

/** Seuils de durée de vie pour qualifier la concurrence. */
const COMPETITION_THRESHOLDS = {
  EXTREME: 30 * 1000,       // < 30s → concurrence extrême
  HIGH: 2 * 60 * 1000,      // < 2 min → concurrence haute
  MODERATE: 5 * 60 * 1000,  // < 5 min → concurrence modérée
  LOW: 10 * 60 * 1000,      // < 10 min → concurrence faible
  // > 10 min → concurrence très faible
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export type CompetitionLevel = "extreme" | "high" | "moderate" | "low" | "very_low" | "unknown";

export interface SlotLifespanRecord {
  /** Identifiant unique du slot (office + date + heure). */
  slotKey: string;
  /** Timestamp de première détection. */
  firstSeen: number;
  /** Timestamp de disparition (null si encore actif). */
  lastSeen: number | null;
  /** Durée de vie calculée (ms). Null si encore actif. */
  lifespanMs: number | null;
  /** Bureau concerné. */
  office: string;
  /** Date du slot (YYYY-MM-DD). */
  slotDate: string;
  /** Heure du slot (optionnelle). */
  slotTime?: string;
}

export interface CompetitionStats {
  /** Niveau de concurrence estimé. */
  level: CompetitionLevel;
  /** Durée de vie médiane des derniers slots (ms). */
  medianLifespanMs: number;
  /** Durée de vie moyenne (ms). */
  averageLifespanMs: number;
  /** Durée de vie minimum observée (ms). */
  minLifespanMs: number;
  /** Durée de vie maximum observée (ms). */
  maxLifespanMs: number;
  /** Nombre de mesures. */
  sampleSize: number;
  /** Recommandation de vitesse pour le booking (0.5-2.0). */
  bookingSpeedMultiplier: number;
  /** Fenêtre de temps recommandée pour réagir (ms). */
  reactionWindowMs: number;
}

export interface ActiveSlotTracker {
  /** Slots actuellement actifs (détectés mais pas encore disparus). */
  activeSlots: Map<string, { firstSeen: number; office: string; slotDate: string; slotTime?: string }>;
  /** Historique des durées de vie mesurées. */
  lifespanHistory: SlotLifespanRecord[];
  /** Statistiques calculées. */
  stats: CompetitionStats | null;
  /** Dernière mise à jour des stats. */
  lastStatsUpdate: number;
}

// ─── Stockage en mémoire (global, pas par username) ─────────────────────────

const tracker: ActiveSlotTracker = {
  activeSlots: new Map(),
  lifespanHistory: [],
  stats: null,
  lastStatsUpdate: 0,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Génère une clé unique pour un slot. */
function makeSlotKey(office: string, date: string, time?: string): string {
  return `${office}|${date}|${time ?? "any"}`;
}

/** Calcule la médiane d'un tableau de nombres. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Nettoie les enregistrements trop anciens. */
function pruneHistory(): void {
  const cutoff = Date.now() - LIFESPAN_VALIDITY_MS;
  tracker.lifespanHistory = tracker.lifespanHistory.filter(
    r => r.firstSeen >= cutoff,
  );

  // Nettoyer aussi les slots actifs trop anciens (probablement des orphelins)
  const orphanCutoff = Date.now() - 60 * 60 * 1000; // 1h max pour un slot "actif"
  for (const [key, slot] of tracker.activeSlots) {
    if (slot.firstSeen < orphanCutoff) {
      tracker.activeSlots.delete(key);
    }
  }
}

/** Recalcule les statistiques de concurrence. */
function recomputeStats(): void {
  const completedRecords = tracker.lifespanHistory.filter(r => r.lifespanMs !== null);
  if (completedRecords.length === 0) {
    tracker.stats = null;
    return;
  }

  const lifespans = completedRecords.map(r => r.lifespanMs!);
  const medianMs = median(lifespans);
  const averageMs = lifespans.reduce((a, b) => a + b, 0) / lifespans.length;
  const minMs = Math.min(...lifespans);
  const maxMs = Math.max(...lifespans);

  // Déterminer le niveau de concurrence
  let level: CompetitionLevel;
  if (medianMs < COMPETITION_THRESHOLDS.EXTREME) {
    level = "extreme";
  } else if (medianMs < COMPETITION_THRESHOLDS.HIGH) {
    level = "high";
  } else if (medianMs < COMPETITION_THRESHOLDS.MODERATE) {
    level = "moderate";
  } else if (medianMs < COMPETITION_THRESHOLDS.LOW) {
    level = "low";
  } else {
    level = "very_low";
  }

  // Multiplicateur de vitesse de booking basé sur la concurrence
  // Plus la concurrence est forte, plus il faut booker vite
  let bookingSpeedMultiplier: number;
  switch (level) {
    case "extreme": bookingSpeedMultiplier = 0.3; break; // Booking ultra-rapide
    case "high": bookingSpeedMultiplier = 0.5; break;
    case "moderate": bookingSpeedMultiplier = 0.8; break;
    case "low": bookingSpeedMultiplier = 1.2; break;
    case "very_low": bookingSpeedMultiplier = 1.5; break;
    default: bookingSpeedMultiplier = 1.0;
  }

  // Fenêtre de réaction recommandée (basée sur le percentile 25 de la durée de vie)
  const sortedLifespans = [...lifespans].sort((a, b) => a - b);
  const p25Index = Math.floor(sortedLifespans.length * 0.25);
  const reactionWindowMs = Math.max(5000, sortedLifespans[p25Index] * 0.5); // 50% du P25

  tracker.stats = {
    level,
    medianLifespanMs: medianMs,
    averageLifespanMs: averageMs,
    minLifespanMs: minMs,
    maxLifespanMs: maxMs,
    sampleSize: completedRecords.length,
    bookingSpeedMultiplier,
    reactionWindowMs,
  };
  tracker.lastStatsUpdate = Date.now();
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Enregistre l'apparition d'un slot (première détection).
 * À appeler quand getFirstAvailableMonth ou getSlotDates retourne un nouveau créneau.
 */
export function recordSlotAppearance(
  office: string,
  slotDate: string,
  slotTime?: string,
): void {
  const key = makeSlotKey(office, slotDate, slotTime);

  // Si le slot est déjà tracké, ne rien faire (pas une nouvelle apparition)
  if (tracker.activeSlots.has(key)) return;

  tracker.activeSlots.set(key, {
    firstSeen: Date.now(),
    office,
    slotDate,
    slotTime,
  });

  console.log(
    `[competitive-intel] 🟢 Slot apparu: ${office} ${slotDate}${slotTime ? " " + slotTime : ""} ` +
    `(${tracker.activeSlots.size} actifs)`,
  );
}

/**
 * Enregistre la disparition d'un slot (n'est plus disponible au refresh suivant).
 * À appeler quand un slot précédemment détecté ne figure plus dans les résultats.
 */
export function recordSlotDisappearance(
  office: string,
  slotDate: string,
  slotTime?: string,
): void {
  const key = makeSlotKey(office, slotDate, slotTime);
  const activeSlot = tracker.activeSlots.get(key);

  if (!activeSlot) return; // Slot inconnu, probablement déjà traité

  const lifespanMs = Date.now() - activeSlot.firstSeen;
  tracker.activeSlots.delete(key);

  // Enregistrer la durée de vie
  const record: SlotLifespanRecord = {
    slotKey: key,
    firstSeen: activeSlot.firstSeen,
    lastSeen: Date.now(),
    lifespanMs,
    office: activeSlot.office,
    slotDate: activeSlot.slotDate,
    slotTime: activeSlot.slotTime,
  };

  tracker.lifespanHistory.push(record);

  // Limiter la taille de l'historique
  if (tracker.lifespanHistory.length > MAX_LIFESPAN_RECORDS) {
    tracker.lifespanHistory = tracker.lifespanHistory.slice(-MAX_LIFESPAN_RECORDS);
  }

  // Recalculer les stats
  recomputeStats();

  const lifespanSec = Math.round(lifespanMs / 1000);
  console.log(
    `[competitive-intel] 🔴 Slot disparu: ${office} ${slotDate}${slotTime ? " " + slotTime : ""} ` +
    `— durée de vie: ${lifespanSec}s (${tracker.lifespanHistory.filter(r => r.lifespanMs !== null).length} mesures)`,
  );
}

/**
 * Marque tous les slots d'un OFC comme disparus (quand le refresh montre "pas de slot").
 * À appeler quand getFirstAvailableMonth retourne present=false pour un bureau.
 */
export function recordAllSlotsGone(office: string): void {
  const now = Date.now();
  const keysToRemove: string[] = [];

  for (const [key, slot] of tracker.activeSlots) {
    if (slot.office === office) {
      keysToRemove.push(key);
      const lifespanMs = now - slot.firstSeen;
      tracker.lifespanHistory.push({
        slotKey: key,
        firstSeen: slot.firstSeen,
        lastSeen: now,
        lifespanMs,
        office: slot.office,
        slotDate: slot.slotDate,
        slotTime: slot.slotTime,
      });
    }
  }

  for (const key of keysToRemove) {
    tracker.activeSlots.delete(key);
  }

  if (keysToRemove.length > 0) {
    // Limiter la taille
    if (tracker.lifespanHistory.length > MAX_LIFESPAN_RECORDS) {
      tracker.lifespanHistory = tracker.lifespanHistory.slice(-MAX_LIFESPAN_RECORDS);
    }
    recomputeStats();
    console.log(
      `[competitive-intel] 🔴 ${keysToRemove.length} slots de ${office} disparus d'un coup`,
    );
  }
}

/**
 * Retourne le niveau de concurrence actuel.
 */
export function getCompetitionLevel(): CompetitionLevel {
  pruneHistory();
  if (!tracker.stats) return "unknown";
  return tracker.stats.level;
}

/**
 * Retourne les statistiques complètes de concurrence.
 */
export function getCompetitionStats(): CompetitionStats | null {
  pruneHistory();
  if (tracker.stats && Date.now() - tracker.lastStatsUpdate > 5 * 60 * 1000) {
    recomputeStats(); // Recalculer toutes les 5 min
  }
  return tracker.stats;
}

/**
 * Retourne un multiplicateur pour l'intervalle de refresh basé sur la concurrence.
 * - Concurrence extrême → 0.5 (refresh 2× plus rapide)
 * - Concurrence haute → 0.7
 * - Concurrence modérée → 1.0 (normal)
 * - Concurrence faible → 1.3 (plus lent)
 * - Concurrence très faible → 1.8 (beaucoup plus lent)
 */
export function getCompetitionRefreshMultiplier(): number {
  const stats = getCompetitionStats();
  if (!stats) return 1.0;

  switch (stats.level) {
    case "extreme": return 0.5;
    case "high": return 0.7;
    case "moderate": return 1.0;
    case "low": return 1.3;
    case "very_low": return 1.8;
    default: return 1.0;
  }
}

/**
 * Retourne le temps de réaction recommandé pour le booking (ms).
 * Basé sur le percentile 25 de la durée de vie des slots.
 */
export function getRecommendedReactionTime(): number {
  const stats = getCompetitionStats();
  if (!stats) return 30000; // 30s par défaut
  return stats.reactionWindowMs;
}

/**
 * Log les statistiques de concurrence dans Convex.
 */
export function logCompetitionIntelligence(applicationId: string): void {
  const stats = getCompetitionStats();
  if (!stats) return;

  botLog({
    applicationId,
    step: "competitive_intelligence",
    status: "ok",
    data: {
      level: stats.level,
      medianLifespanSec: Math.round(stats.medianLifespanMs / 1000),
      averageLifespanSec: Math.round(stats.averageLifespanMs / 1000),
      minLifespanSec: Math.round(stats.minLifespanMs / 1000),
      maxLifespanSec: Math.round(stats.maxLifespanMs / 1000),
      sampleSize: stats.sampleSize,
      bookingSpeedMultiplier: Math.round(stats.bookingSpeedMultiplier * 100) / 100,
      reactionWindowMs: Math.round(stats.reactionWindowMs),
      activeSlots: tracker.activeSlots.size,
    },
  });
}

/**
 * Retourne les slots actuellement actifs (pour monitoring).
 */
export function getActiveSlots(): Array<{ key: string; office: string; slotDate: string; ageSec: number }> {
  const now = Date.now();
  const result: Array<{ key: string; office: string; slotDate: string; ageSec: number }> = [];
  for (const [key, slot] of tracker.activeSlots) {
    result.push({
      key,
      office: slot.office,
      slotDate: slot.slotDate,
      ageSec: Math.round((now - slot.firstSeen) / 1000),
    });
  }
  return result;
}

/**
 * Réinitialise le tracker (utile pour les tests).
 */
export function resetCompetitionTracker(): void {
  tracker.activeSlots.clear();
  tracker.lifespanHistory = [];
  tracker.stats = null;
  tracker.lastStatsUpdate = 0;
}
