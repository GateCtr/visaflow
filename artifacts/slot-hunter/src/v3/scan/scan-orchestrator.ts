/**
 * Scan Orchestrator V3 — Décide QUAND scanner et à quel intervalle.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Retourner l'intervalle optimal (ms) entre deux scans pour un compte donné,
 *   en combinant : phase rush × rôle compte × prédiction heatmap × compétition.
 *
 * NE FAIT PAS :
 *   - Le scan lui-même (c'est scan-session.ts)
 *   - Le login (c'est session-pool.ts)
 *   - La navigation calendrier (c'est scan-months.ts)
 *
 * RÈGLES :
 *   - Éclaireur : scanne activement (intervalles courts en rush)
 *   - Confiné : NE SCANNE JAMAIS (reçoit via blind booking)
 *   - Hybride : scanne pour lui-même uniquement
 *   - Compétition extrême (slots < 30s) → override TOUT à 20s
 *   - Heatmap score > 0.6 hors rush → burst temporaire (2 min à 15-20s)
 *   - Lundi matin 07-09h → rush augmenté (×0.7 sur l'intervalle)
 *
 * ADMIN CONFIG (bot-config Convex) :
 *   "night_mode": "off" | "minimal" | "full"
 *   "scan_intensity": "conservative" | "normal" | "aggressive"
 */

import type { AccountRole, RushWindow } from "../core/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Décision de scan retournée par l'orchestrateur. */
export interface ScanDecision {
  /** Doit-on scanner maintenant ? */
  shouldScan: boolean;
  /** Intervalle recommandé avant le prochain scan (ms). */
  intervalMs: number;
  /** Raison de la décision (pour les logs). */
  reason: string;
  /** Phase active au moment de la décision. */
  phase: "rush" | "standard" | "night" | "burst";
  /** Le compte est-il en mode confiné (skip scan) ? */
  isConfined: boolean;
}

/** Intensité de scan (admin-pilotable). */
export type ScanIntensity = "conservative" | "normal" | "aggressive";

/** Mode nuit (admin-pilotable). */
export type NightMode = "off" | "minimal" | "full";

/** Contexte externe fourni à l'orchestrateur. */
export interface OrchestratorContext {
  /** Rôle du compte. */
  accountRole: AccountRole;
  /** Score heatmap Early Bird (0-1). 0 = pas de données. */
  predictionScore: number;
  /** Durée de vie médiane des slots (ms). 0 = pas de données. */
  competitionMedianMs: number;
  /** Nombre de logins restants aujourd'hui. */
  loginsRemaining: number;
  /** Le token est-il actuellement valide ? */
  hasValidToken: boolean;
  /** Intensité configurée par admin. */
  scanIntensity: ScanIntensity;
  /** Mode nuit configuré. */
  nightMode: NightMode;
}

// ─── Intervalles de base (ms) par phase ─────────────────────────────────────

const INTERVALS = {
  rush: { min: 20_000, max: 60_000 },        // 20-60s pendant rush
  standard: { min: 60_000, max: 180_000 },    // 1-3 min en standard
  night_minimal: { min: 180_000, max: 300_000 }, // 3-5 min (1 login/nuit)
  night_full: { min: 120_000, max: 180_000 },    // 2-3 min (3 logins/nuit)
  burst: { min: 15_000, max: 20_000 },        // 15-20s (burst temporaire)
} as const;

/** Multiplicateur par intensité admin. */
const INTENSITY_MULTIPLIER: Record<ScanIntensity, number> = {
  conservative: 1.5,  // 50% plus lent
  normal: 1.0,
  aggressive: 0.7,   // 30% plus rapide
};

/** Seuil compétition extrême (slots disparaissent en < 30s). */
const COMPETITION_EXTREME_MS = 30_000;

/** Seuil heatmap pour activer le burst hors rush. */
const HEATMAP_BURST_THRESHOLD = 0.6;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Heure Kinshasa (UTC+1) en décimal. */
function getKinshasaHour(): number {
  const now = new Date();
  return ((now.getUTCHours() + 1) % 24) + now.getUTCMinutes() / 60;
}

/** Jour de la semaine Kinshasa (1=Lun ... 7=Dim). */
function getKinshasaDay(): number {
  const now = new Date();
  let day = now.getUTCDay();
  if (now.getUTCHours() >= 23) day = (day + 1) % 7;
  return day === 0 ? 7 : day;
}

/** Vérifie si c'est lundi matin (boost accumulé week-end). */
function isMondayMorningBoost(): boolean {
  const day = getKinshasaDay();
  const hour = getKinshasaHour();
  return day === 1 && hour >= 7 && hour < 9;
}

/** Détermine la phase temporelle actuelle. */
function getCurrentTimePhase(): "rush" | "standard" | "night" {
  const hour = getKinshasaHour();
  const day = getKinshasaDay();

  // Nuit : 22h-07h
  if (hour >= 22 || hour < 7) return "night";

  // Rush Matin : 07h-09h30 (Lun-Ven)
  if (hour >= 7 && hour < 9.5 && day >= 1 && day <= 5) return "rush";

  // Rush Midi : 12h-14h (tous jours)
  if (hour >= 12 && hour < 14) return "rush";

  // Rush Vendredi : 14h-17h (Ven seulement)
  if (day === 5 && hour >= 14 && hour < 17) return "rush";

  // Standard : tout le reste
  return "standard";
}

/** Génère un intervalle gaussien entre min et max. */
function gaussianInterval(min: number, max: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const center = (min + max) / 2;
  const stddev = (max - min) * 0.25;
  return Math.max(min, Math.min(max, Math.round(center + z * stddev)));
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Détermine si un compte doit scanner et à quel intervalle.
 *
 * Appelé par le scheduler avant chaque cycle de scan.
 * Combine : phase temporelle × rôle × prediction × compétition × config admin.
 */
export function getNextScanDecision(ctx: OrchestratorContext): ScanDecision {
  // ── Règle 1 : Les confinés ne scannent JAMAIS ──
  if (ctx.accountRole === "confine") {
    return {
      shouldScan: false,
      intervalMs: 60_000, // Check toutes les 60s si un blind booking arrive
      reason: "Compte confiné — pas de scan (attend blind booking)",
      phase: "standard",
      isConfined: true,
    };
  }

  // ── Règle 2 : Pas de token → pas de scan ──
  if (!ctx.hasValidToken) {
    return {
      shouldScan: false,
      intervalMs: 30_000, // Recheck dans 30s
      reason: "Pas de token valide — attente login",
      phase: "standard",
      isConfined: false,
    };
  }

  // ── Règle 3 : Budget épuisé → pas de scan (token va expirer, pas de re-login possible) ──
  if (ctx.loginsRemaining <= 0 && !ctx.hasValidToken) {
    return {
      shouldScan: false,
      intervalMs: 300_000, // 5 min
      reason: "Budget logins épuisé + pas de token",
      phase: "standard",
      isConfined: false,
    };
  }

  // ── Déterminer la phase temporelle ──
  const timePhase = getCurrentTimePhase();

  // ── Règle 4 : Mode nuit ──
  if (timePhase === "night") {
    if (ctx.nightMode === "off") {
      return {
        shouldScan: false,
        intervalMs: 600_000, // 10 min check
        reason: "Mode nuit OFF — pas de scan nocturne",
        phase: "night",
        isConfined: false,
      };
    }

    const nightCfg = ctx.nightMode === "full" ? INTERVALS.night_full : INTERVALS.night_minimal;
    const interval = gaussianInterval(nightCfg.min, nightCfg.max);
    return {
      shouldScan: true,
      intervalMs: Math.round(interval * INTENSITY_MULTIPLIER[ctx.scanIntensity]),
      reason: `Nuit (${ctx.nightMode}) — scan lent`,
      phase: "night",
      isConfined: false,
    };
  }

  // ── Règle 5 : Compétition extrême → override TOUT à 15-20s ──
  if (ctx.competitionMedianMs > 0 && ctx.competitionMedianMs < COMPETITION_EXTREME_MS) {
    const interval = gaussianInterval(INTERVALS.burst.min, INTERVALS.burst.max);
    return {
      shouldScan: true,
      intervalMs: interval, // Pas de multiplicateur intensity — compétition override tout
      reason: `Compétition EXTRÊME (slots < 30s, médiane=${Math.round(ctx.competitionMedianMs / 1000)}s) — BURST`,
      phase: "burst",
      isConfined: false,
    };
  }

  // ── Règle 6 : Heatmap burst (score > 0.6 HORS rush) ──
  if (timePhase === "standard" && ctx.predictionScore > HEATMAP_BURST_THRESHOLD) {
    const interval = gaussianInterval(INTERVALS.burst.min, INTERVALS.burst.max);
    return {
      shouldScan: true,
      intervalMs: interval,
      reason: `Heatmap BURST (score=${ctx.predictionScore.toFixed(2)} > ${HEATMAP_BURST_THRESHOLD}) — slot imminent prédit`,
      phase: "burst",
      isConfined: false,
    };
  }

  // ── Règle 7 : Phase rush ──
  if (timePhase === "rush") {
    let interval = gaussianInterval(INTERVALS.rush.min, INTERVALS.rush.max);

    // Lundi matin boost (×0.7 = 30% plus rapide)
    if (isMondayMorningBoost()) {
      interval = Math.round(interval * 0.7);
    }

    // Appliquer l'intensité admin
    interval = Math.round(interval * INTENSITY_MULTIPLIER[ctx.scanIntensity]);

    return {
      shouldScan: true,
      intervalMs: interval,
      reason: `Rush${isMondayMorningBoost() ? " (lundi boost ×0.7)" : ""} — scan rapide`,
      phase: "rush",
      isConfined: false,
    };
  }

  // ── Règle 8 : Phase standard ──
  let interval = gaussianInterval(INTERVALS.standard.min, INTERVALS.standard.max);

  // Appliquer le multiplicateur prediction (0.3-1.5 selon heatmap)
  if (ctx.predictionScore > 0) {
    // Score > 0.4 → accélérer, score < 0.2 → ralentir
    const predMultiplier = ctx.predictionScore >= 0.4
      ? 0.5 + (1 - ctx.predictionScore) * 0.5  // 0.5-0.8
      : 1.2 + (0.2 - ctx.predictionScore) * 2;  // 1.2-1.6
    interval = Math.round(interval * predMultiplier);
  }

  // Appliquer l'intensité admin
  interval = Math.round(interval * INTENSITY_MULTIPLIER[ctx.scanIntensity]);

  // Clamp final
  interval = Math.max(INTERVALS.rush.min, Math.min(interval, 300_000));

  return {
    shouldScan: true,
    intervalMs: interval,
    reason: `Standard (pred=${ctx.predictionScore.toFixed(2)}, intensity=${ctx.scanIntensity})`,
    phase: "standard",
    isConfined: false,
  };
}

/**
 * Helper : retourne la phase temporelle actuelle (pour les logs/stats).
 */
export function getCurrentPhaseLabel(): "rush" | "standard" | "night" {
  return getCurrentTimePhase();
}

/**
 * Helper : vérifie si on est en rush lundi matin (pour les logs).
 */
export function isMondayBoostActive(): boolean {
  return isMondayMorningBoost() && getCurrentTimePhase() === "rush";
}
