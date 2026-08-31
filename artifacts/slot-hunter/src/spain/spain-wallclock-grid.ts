/**
 * spain-wallclock-grid — WallClockGrid : fonctions pures de grille d'horloge murale
 * synchronisée (feature spain-synchronized-scan).
 *
 * Ce module remplace le sleep relatif de la boucle de scan par un alignement sur une
 * grille d'horloge murale absolue : chaque worker dort jusqu'au prochain front de tick
 * `ceil(now / tick) * tick`, ce qui transforme l'horloge en barrière commune sans
 * coordination centrale. Un jitter déterministe par worker (±jitterPct·tick) casse le
 * pattern régulier tout en gardant l'alignement global.
 *
 * Toutes les fonctions sont pures (aucun `Date.now()`, aucun effet réseau) : `nowMs`
 * est toujours injecté par l'appelant, ce qui les rend testables sans horloge réelle.
 *
 * Contraintes de codage : strict mode, aucun `any`, types de retour explicites sur
 * toutes les fonctions exportées, logs préfixés `[spain-grid]`.
 */

import type { GridConfig, ScanPhase } from "./spain-grid-config.js";

// ─── Bornes du tick effectif utilisé pour le calcul (Requirement 12.4) ───────

/** Plancher/plafond du tick effectif employé dans les calculs de grille (ms). */
const TICK_FLOOR_MS = 1000;
const TICK_CEIL_MS = 3_600_000;

/** Bornes autorisées pour `jitterPct` (fraction du tick). */
const JITTER_PCT_MIN = 0;
const JITTER_PCT_MAX = 0.5;

/** Nombre de millisecondes par minute (dérivation de la minute-dans-l'heure). */
const MS_PER_MINUTE = 60_000;

/**
 * Indication d'erreur renvoyée par `msUntilNextTick` sur entrée invalide.
 *
 * Choix de conception : `msUntilNextTick` est une fonction PURE, elle ne peut donc pas
 * « conserver la valeur précédente » par elle-même. Elle renvoie le sentinelle `-1`
 * (valeur impossible pour un délai de sommeil réel, toujours `>= 0`) et journalise via
 * `console.error("[spain-grid] ...")`. La boucle worker consommatrice (task 10.1) doit
 * traiter `-1` comme « ne pas replanifier de réveil » : elle conserve alors son délai de
 * sommeil précédent, ce qui réalise l'invariance « valeur précédente inchangée » exigée
 * (Requirements 1.7, 2.5). Ce contrat est stable et vérifiable par les tests.
 */
export const MS_UNTIL_NEXT_TICK_ERROR = -1;

// ─── Interface publique ──────────────────────────────────────────────────────

/**
 * Résolveur de grille : décide de la phase courante, du tick effectif et du délai
 * jusqu'au prochain front de grille.
 */
export interface GridResolver {
  /** Retourne la phase courante d'après la minute-dans-l'heure (fuseau Europe/Madrid). */
  currentPhase(nowMs: number): ScanPhase;
  /** Tick effectif pour la phase (huntTickMs ou lateTickMs). Jamais `< huntTickMs`. */
  effectiveTickMs(phase: ScanPhase, slotEverSeen: boolean): number;
  /**
   * ms à dormir jusqu'au prochain front de grille absolu, jitter déterministe inclus.
   * Renvoie `MS_UNTIL_NEXT_TICK_ERROR` (-1) sur entrée invalide (voir sa doc).
   */
  msUntilNextTick(nowMs: number, tick: number, workerSeed: number): number;
}

// ─── Helpers internes ────────────────────────────────────────────────────────

/** Borne une valeur dans l'intervalle fermé [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Dérive la minute-dans-l'heure (0–59) pour un instant donné, dans le fuseau
 * `Europe/Madrid`. Utilise `Intl.DateTimeFormat` pour appliquer correctement l'heure
 * légale espagnole (DST). En cas d'échec inattendu (environnement sans ICU), retombe
 * sur une dérivation UTC afin de ne jamais lancer.
 */
function minuteOfHourInMadrid(nowMs: number): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      hour12: false,
      minute: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(nowMs));
    const minutePart = parts.find((p) => p.type === "minute");
    if (minutePart !== undefined) {
      const minute = Number(minutePart.value);
      if (Number.isFinite(minute)) {
        return minute;
      }
    }
  } catch (error) {
    console.error(
      "[spain-grid] Dérivation de minute Europe/Madrid impossible, repli UTC:",
      error instanceof Error ? error.message : error,
    );
  }
  // Repli déterministe : minute-dans-l'heure en UTC (les minutes sont invariantes par
  // décalage horaire entier, ce qui reste correct pour l'Espagne).
  return Math.floor(nowMs / MS_PER_MINUTE) % 60;
}

// ─── Fabrique du résolveur ───────────────────────────────────────────────────

/**
 * Construit un `GridResolver` à partir d'une `GridConfig` déjà validée/bornée
 * (typiquement issue de `loadGridConfig`).
 *
 * @param config configuration de grille (ticks, jitter, bornes de fenêtre).
 * @returns résolveur exposant `currentPhase`, `effectiveTickMs` et `msUntilNextTick`.
 */
export function createGridResolver(config: GridConfig): GridResolver {
  const { huntTickMs, lateTickMs, jitterPct, windowStartMin, huntStartMin, lateStartMin, windowEndMin } =
    config;

  /**
   * Phase courante selon la minute-dans-l'heure `m` (fuseau Europe/Madrid) :
   * `[windowStartMin, huntStartMin[ → preflight`, `[huntStartMin, lateStartMin[ → hunt`,
   * `[lateStartMin, windowEndMin[ → late`, hors fenêtre → `preflight` par défaut.
   * Si la config de fenêtre est invalide (ordre non strict), retourne `preflight`.
   */
  function currentPhase(nowMs: number): ScanPhase {
    const orderValid =
      windowStartMin < huntStartMin && huntStartMin < lateStartMin && lateStartMin < windowEndMin;
    if (!orderValid) {
      return "preflight";
    }

    const minute = minuteOfHourInMadrid(nowMs);
    if (minute < windowStartMin || minute >= windowEndMin) {
      return "preflight";
    }
    if (minute < huntStartMin) {
      return "preflight";
    }
    if (minute < lateStartMin) {
      return "hunt";
    }
    return "late";
  }

  /**
   * Tick effectif : `late && !slotEverSeen ⟹ lateTickMs`, sinon `huntTickMs`.
   * Garantit un retour jamais `< huntTickMs` (le tick lent n'est que plus grand).
   */
  function effectiveTickMs(phase: ScanPhase, slotEverSeen: boolean): number {
    if (phase === "late" && !slotEverSeen) {
      // lateTickMs est déjà >= huntTickMs par construction (loadGridConfig), mais on
      // garantit l'invariant « jamais < huntTickMs » quoi qu'il arrive.
      return Math.max(lateTickMs, huntTickMs);
    }
    return huntTickMs;
  }

  /**
   * Délai en ms jusqu'au prochain front de grille absolu, jitter déterministe inclus.
   *
   * Algorithme (design §Algorithmic Pseudocode) :
   *   1. `effTick = clamp(tick, [1000, 3600000])` — tick effectif borné (Req 12.4).
   *   2. `nextFront = ceil(nowMs / effTick) * effTick` — front commun à tous les workers.
   *   3. `jitterMax = floor(jitterPct * effTick)`,
   *      `jitter = (workerSeed mod (2*jitterMax+1)) - jitterMax` ∈ [-jitterMax, +jitterMax].
   *   4. `target = nextFront + jitter` ; si `target <= nowMs`, viser le front suivant.
   *   5. Retour = `target - nowMs`, entier dans `[0, effTick + jitterMax)`.
   *
   * Rejet (retour `MS_UNTIL_NEXT_TICK_ERROR`) si `nowMs` non numérique, `tick <= 0` ou
   * non entier, ou `jitterPct` hors `[0, 0.5]`.
   */
  function msUntilNextTick(nowMs: number, tick: number, workerSeed: number): number {
    // Validation stricte des entrées → indication d'erreur, aucun réveil planifié.
    if (!Number.isFinite(nowMs)) {
      console.error(`[spain-grid] msUntilNextTick: nowMs non numérique (${String(nowMs)}), rejet.`);
      return MS_UNTIL_NEXT_TICK_ERROR;
    }
    if (!Number.isInteger(tick) || tick <= 0) {
      console.error(`[spain-grid] msUntilNextTick: tick invalide (${String(tick)}), rejet.`);
      return MS_UNTIL_NEXT_TICK_ERROR;
    }
    if (!Number.isFinite(jitterPct) || jitterPct < JITTER_PCT_MIN || jitterPct > JITTER_PCT_MAX) {
      console.error(
        `[spain-grid] msUntilNextTick: jitterPct hors [${JITTER_PCT_MIN}, ${JITTER_PCT_MAX}] (${String(
          jitterPct,
        )}), rejet.`,
      );
      return MS_UNTIL_NEXT_TICK_ERROR;
    }

    // 1. Tick effectif borné pour le calcul (Requirement 12.4).
    const effTick = clamp(tick, TICK_FLOOR_MS, TICK_CEIL_MS);

    // 2. Front de grille absolu, commun à tous les workers (barrière).
    const nextFront = Math.ceil(nowMs / effTick) * effTick;

    // 3. Jitter déterministe par worker, borné à ±jitterMax.
    const jitterMax = Math.floor(jitterPct * effTick);
    // workerSeed peut être négatif/non entier : on le normalise en index non négatif.
    const seedInt = Math.abs(Math.trunc(workerSeed));
    const jitter = (seedInt % (2 * jitterMax + 1)) - jitterMax;

    // 4. Cible + réajustement si le jitter négatif nous place dans le passé.
    let target = nextFront + jitter;
    if (target <= nowMs) {
      target = nextFront + effTick + jitter;
    }

    // 5. Délai entier non négatif.
    return Math.max(0, Math.round(target - nowMs));
  }

  return { currentPhase, effectiveTickMs, msUntilNextTick };
}
