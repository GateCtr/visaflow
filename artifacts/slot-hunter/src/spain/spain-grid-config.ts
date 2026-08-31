/**
 * spain-grid-config — Types partagés et chargement de configuration de la grille
 * d'horloge murale synchronisée (feature spain-synchronized-scan).
 *
 * Ce module est le socle de types réutilisé par WallClockGrid, la machine à états
 * worker, le pool de réserve et l'orchestrateur. Il expose également le chargement
 * de configuration depuis les variables d'environnement (avec bornage + défauts) et
 * la dérivation déterministe du seed de jitter par dossier.
 *
 * Contraintes de codage : strict mode, aucun `any`, types de retour explicites sur
 * toutes les fonctions exportées, secrets exclusivement via env, logs préfixés
 * `[spain-grid]`.
 */

import { createHash } from "node:crypto";

import type { SpainCfSession } from "../spain-soax-solver.js";
import type { WorkerPhpState } from "../spain-dossier-worker.js";

// ─── Types de phase et d'état ────────────────────────────────────────────────

/** Phase de la fenêtre horaire courante. */
export type ScanPhase = "preflight" | "hunt" | "late";

/** État d'un worker dans la machine à états (jamais nul/indéfini). */
export type WorkerState = "ARMED" | "SCANNING" | "RECOVERING";

/**
 * Cause classifiée d'un échec de cycle (tri strict).
 * `agenda_empty` est un signal NORMAL, pas une erreur.
 */
export type FailureKind =
  | "proxy_dead" // token/main 0B, timeout, ECONNREFUSED -> rotation IP + re-solve
  | "http_5xx" // 502/503/504 -> retry court puis rotation
  | "session_dead" // datetime 0B tous mois + agenda actif -> nouveau PHPSESSID (garde IP+CF)
  | "cf_expired" // GET widget 403 -> CF re-solve (garde IP)
  | "agenda_empty"; // NORMAL -> reste ARMED, pas une erreur

// ─── Configuration de la grille ──────────────────────────────────────────────

/** Configuration de la grille d'horloge murale, adossée aux variables d'environnement. */
export interface GridConfig {
  /** Tick de la phase chasse en ms (SPAIN_HUNT_TICK_MS, défaut 10000). */
  huntTickMs: number;
  /** Tick de la phase tardive en ms (SPAIN_LATE_TICK_MS, défaut 60000). */
  lateTickMs: number;
  /** Amplitude max du jitter en fraction du tick (SPAIN_GRID_JITTER_PCT, défaut 0.2). */
  jitterPct: number;
  /** Minute de début de fenêtre (SPAIN_WINDOW_START_MIN, défaut 5). */
  windowStartMin: number;
  /** Minute de début de la phase chasse (SPAIN_HUNT_START_MIN, défaut 13). */
  huntStartMin: number;
  /** Minute de début de la phase tardive (SPAIN_LATE_WINDOW_START_MIN, défaut 17). */
  lateStartMin: number;
  /** Minute de fin absolue de fenêtre (SPAIN_WINDOW_END_MIN, défaut 25). */
  windowEndMin: number;
}

// ─── État runtime du worker ──────────────────────────────────────────────────

/** Contexte de récupération asynchrone d'un worker en cours de réparation. */
export interface RecoveryContext {
  kind: FailureKind;
  startedAtMs: number;
  /** true si un swap réserve a déjà été tenté pour ce cycle de recovery. */
  swapAttempted: boolean;
}

/** État runtime complet d'un worker de dossier Espagne. */
export interface WorkerRuntimeState {
  dossierId: string;
  state: WorkerState;
  /** Seed stable pour le jitter de grille (dérivé du dossierId). */
  gridSeed: number;
  /** Session CF active (undefined tant que non armé). */
  session?: SpainCfSession;
  phpState?: WorkerPhpState;
  proxyUrl: string;
  /** true dès qu'un créneau a été vu (bloque le ralentissement tardif). */
  slotEverSeen: boolean;
  /** Instant du dernier scan effectué (pour diagnostic de dérive). */
  lastScanAtMs: number;
  recovery?: RecoveryContext;
}

// ─── Bornes et valeurs par défaut ────────────────────────────────────────────

/** Plancher/plafond de tick effectif imposés (ms). */
const TICK_MIN_MS = 1000;
const TICK_MAX_MS = 3_600_000;

/** Bornes de jitter (fraction du tick). */
const JITTER_PCT_MIN = 0;
const JITTER_PCT_MAX = 0.5;

/** Bornes des minutes-dans-l'heure. */
const MINUTE_MIN = 0;
const MINUTE_MAX = 59;

/** Valeurs par défaut (Requirements 11.2, 11.3, 11.4, 11.6, 11.9). */
// huntTickMs = 10 s. En phase chasse, le cf_clearance est DÉJÀ en cache (armé au
// preflight, TTL ~30 min) → un cycle de scan nominal (main → getservices → getagendas
// → datetime, imposé par le portail à chaque scan, SANS re-solve CF) dure ~4-5 s.
// 10 s ≈ 2× le scan nominal : assez large pour absorber un scan lent occasionnel (~7 s)
// sans déborder le front suivant, et assez serré pour scanner fréquemment pendant la
// courte fenêtre de publication. NB : une mesure brute peut afficher un p95 ~10 s, mais
// elle est gonflée par les cycles de RÉCUPÉRATION (re-solve CF ~20 s sur cf_expired) et
// les proxies dégradés — non représentatifs du régime chasse à CF caché. Override via
// SPAIN_HUNT_TICK_MS. Le ralentissement tardif conditionnel utilise lateTickMs.
const DEFAULT_HUNT_TICK_MS = 10_000;
const DEFAULT_LATE_TICK_MS = 60_000;
const DEFAULT_JITTER_PCT = 0.2;
const DEFAULT_WINDOW_START_MIN = 5;
const DEFAULT_HUNT_START_MIN = 13;
const DEFAULT_LATE_START_MIN = 17;
const DEFAULT_WINDOW_END_MIN = 25;

// ─── Helpers de parsing ──────────────────────────────────────────────────────

/**
 * Lit un entier borné depuis une variable d'environnement. Applique le défaut et
 * journalise un avertissement `[spain-grid]` nommant la variable si absent, vide,
 * non numérique, ou hors bornes.
 */
function parseIntEnv(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
  defaultValue: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    console.warn(`[spain-grid] ${name} absent/vide, valeur par défaut appliquée: ${defaultValue}`);
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    console.warn(`[spain-grid] ${name} non entier ("${raw}"), valeur par défaut appliquée: ${defaultValue}`);
    return defaultValue;
  }
  if (parsed < min || parsed > max) {
    console.warn(
      `[spain-grid] ${name}=${parsed} hors bornes [${min}, ${max}], valeur par défaut appliquée: ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * Lit un nombre décimal depuis l'environnement, puis le borne dans [min, max].
 * Applique le défaut si absent/vide/non numérique (avec avertissement `[spain-grid]`),
 * borne sinon (avec avertissement si hors intervalle).
 */
function parseFloatBoundedEnv(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
  defaultValue: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    console.warn(`[spain-grid] ${name} absent/vide, valeur par défaut appliquée: ${defaultValue}`);
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[spain-grid] ${name} non numérique ("${raw}"), valeur par défaut appliquée: ${defaultValue}`);
    return defaultValue;
  }
  if (parsed < min) {
    console.warn(`[spain-grid] ${name}=${parsed} < ${min}, borné à ${min}`);
    return min;
  }
  if (parsed > max) {
    console.warn(`[spain-grid] ${name}=${parsed} > ${max}, borné à ${max}`);
    return max;
  }
  return parsed;
}

// ─── Chargement de configuration ─────────────────────────────────────────────

/**
 * Charge la configuration de grille depuis les variables d'environnement, en
 * bornant chaque valeur et en appliquant les défauts avec avertissement lorsqu'une
 * variable est absente/vide/non numérique/hors bornes.
 *
 * L'ordre strict `windowStartMin < huntStartMin < lateStartMin < windowEndMin` est
 * vérifié : s'il est violé, les quatre minutes sont réinitialisées aux défauts
 * (5, 13, 17, 25) et un `console.error("[spain-grid] ...")` indique la contrainte
 * violée (Requirements 11.8, 11.9).
 *
 * @param env source des variables d'environnement (défaut : `process.env`).
 * @returns configuration de grille validée et bornée.
 */
export function loadGridConfig(env: NodeJS.ProcessEnv = process.env): GridConfig {
  const huntTickMs = parseIntEnv(
    "SPAIN_HUNT_TICK_MS",
    env.SPAIN_HUNT_TICK_MS,
    TICK_MIN_MS,
    TICK_MAX_MS,
    DEFAULT_HUNT_TICK_MS,
  );
  const lateTickMs = parseIntEnv(
    "SPAIN_LATE_TICK_MS",
    env.SPAIN_LATE_TICK_MS,
    TICK_MIN_MS,
    TICK_MAX_MS,
    DEFAULT_LATE_TICK_MS,
  );
  const jitterPct = parseFloatBoundedEnv(
    "SPAIN_GRID_JITTER_PCT",
    env.SPAIN_GRID_JITTER_PCT,
    JITTER_PCT_MIN,
    JITTER_PCT_MAX,
    DEFAULT_JITTER_PCT,
  );

  let windowStartMin = parseIntEnv(
    "SPAIN_WINDOW_START_MIN",
    env.SPAIN_WINDOW_START_MIN,
    MINUTE_MIN,
    MINUTE_MAX,
    DEFAULT_WINDOW_START_MIN,
  );
  let huntStartMin = parseIntEnv(
    "SPAIN_HUNT_START_MIN",
    env.SPAIN_HUNT_START_MIN,
    MINUTE_MIN,
    MINUTE_MAX,
    DEFAULT_HUNT_START_MIN,
  );
  let lateStartMin = parseIntEnv(
    "SPAIN_LATE_WINDOW_START_MIN",
    env.SPAIN_LATE_WINDOW_START_MIN,
    MINUTE_MIN,
    MINUTE_MAX,
    DEFAULT_LATE_START_MIN,
  );
  let windowEndMin = parseIntEnv(
    "SPAIN_WINDOW_END_MIN",
    env.SPAIN_WINDOW_END_MIN,
    MINUTE_MIN,
    MINUTE_MAX,
    DEFAULT_WINDOW_END_MIN,
  );

  // Ordre strict windowStartMin < huntStartMin < lateStartMin < windowEndMin.
  const orderValid =
    windowStartMin < huntStartMin && huntStartMin < lateStartMin && lateStartMin < windowEndMin;
  if (!orderValid) {
    console.error(
      `[spain-grid] Ordre de fenêtre invalide: exige windowStartMin(${windowStartMin}) < ` +
        `huntStartMin(${huntStartMin}) < lateStartMin(${lateStartMin}) < windowEndMin(${windowEndMin}); ` +
        `réinitialisation aux défauts (5, 13, 17, 25).`,
    );
    windowStartMin = DEFAULT_WINDOW_START_MIN;
    huntStartMin = DEFAULT_HUNT_START_MIN;
    lateStartMin = DEFAULT_LATE_START_MIN;
    windowEndMin = DEFAULT_WINDOW_END_MIN;
  }

  return {
    huntTickMs,
    lateTickMs,
    jitterPct,
    windowStartMin,
    huntStartMin,
    lateStartMin,
    windowEndMin,
  };
}

// ─── Seed de jitter déterministe ─────────────────────────────────────────────

/**
 * Dérive un seed entier déterministe et stable à partir d'un `dossierId`. Utilisé
 * comme `gridSeed` pour le jitter par worker : un même `dossierId` produit toujours
 * la même valeur (au bit près), garantissant un décalage de grille reproductible
 * entre redémarrages (Requirement 2.4).
 *
 * @param dossierId identifiant du dossier worker.
 * @returns entier non négatif stable (32 bits) dérivé du hash SHA-256 du dossierId.
 */
export function hashSeed(dossierId: string): number {
  const digest = createHash("sha256").update(dossierId, "utf8").digest();
  // Lit les 4 premiers octets en entier non signé 32 bits (déterministe et stable).
  return digest.readUInt32BE(0);
}
