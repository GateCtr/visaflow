/**
 * spain-preflight-controller — PreflightController : armement et vérification
 * anticipée des sessions worker (feature spain-synchronized-scan, Component 4).
 *
 * Rôle : pendant la fenêtre preflight (`[windowStartMin, huntStartMin[`, fuseau
 * Europe/Madrid), armer exactement une session par dossier (via `initWorkerSession`
 * réutilisé), puis vérifier tôt (au plus tard 60 s avant `huntStartMin`) la validité
 * de chaque session armée. Toute session invalide déclenche un swap vers une réserve
 * pré-solvée (swap < 5 s) suivi d'une reconstitution en tâche de fond ; si aucune
 * réserve n'est disponible, un re-solve immédiat est tenté et un échec de swap est
 * consigné pour le dossier concerné. Une session toujours invalide au moment de
 * `huntStartMin` marque le dossier comme non prêt, sans interrompre les autres.
 *
 * Le contrôleur gère les états armés en interne dans une `Map<dossierId,
 * WorkerRuntimeState>` (réutilise `createRuntimeState`/`transition`) et l'expose via
 * `getArmedStates()` pour l'orchestrateur (task 11.1).
 *
 * Sonde de validité (`cf_clearance`) : contrôle léger, sans appel réseau — session
 * présente + `cfClearance` non vide + non expiré (`session.expiresAt > nowMs`). Une
 * re-validation réseau complète n'est PAS dans le périmètre de cette tâche ; le point
 * d'extension est documenté sur `isSessionValid`.
 *
 * Contraintes de codage : strict mode, aucun `any`, types de retour explicites sur
 * toutes les fonctions exportées, secrets exclusivement via env, `try/catch` autour
 * de tous les appels réseau, logs préfixés `[spain-preflight]`, `cf_clearance` jamais
 * journalisé en clair (tronqué).
 *
 * Réutilise sans réécrire :
 *   - `initWorkerSession`  (spain-soax-solver)          — armement/re-solve d'une session
 *   - `rotateDecodoUrl`    (spain-decodo-pool)          — IP distincte pour un re-solve
 *   - `createRuntimeState` (spain-worker-state-machine) — état runtime initial
 *   - `transition`         (spain-worker-state-machine) — transitions d'état worker
 *   - `ReservePoolManager` (spain-reserve-pool)         — swap réserve + replenish async
 *
 * _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 13.3, 13.4_
 */

import type { GridConfig, WorkerRuntimeState } from "./spain-grid-config.js";
import type { ReservePoolManager } from "./spain-reserve-pool.js";
import type { SpainCfSession } from "../spain-soax-solver.js";
import { initWorkerSession } from "../spain-soax-solver.js";
import { rotateDecodoUrl } from "../spain-decodo-pool.js";
import type { SpainDossierConfig } from "../spain-dossier-worker.js";
import { createRuntimeState, transition } from "./spain-worker-state-machine.js";

// ─── Constantes ──────────────────────────────────────────────────────────────

/** Nombre de millisecondes par minute (dérivation de la minute-dans-l'heure). */
const MS_PER_MINUTE = 60_000;

/** Budget maximal d'armement par dossier (Requirement 6.1). */
const ARM_TIMEOUT_MS = 30_000;

/**
 * Marge avant `huntStartMin` à laquelle la vérification doit être terminée
 * (Requirement 6.2). Purement documentaire ici : `verifyAndRepair` doit être
 * appelée par l'orchestrateur au plus tard à cet instant.
 */
const VERIFY_DEADLINE_BEFORE_HUNT_MS = 60_000;

/** Longueur de tête conservée lors de la troncature du cf_clearance (Req 13.5). */
const CF_LOG_HEAD_LEN = 8;

/** Nom de la variable d'environnement du secret CapSolver (pour les messages). */
const CAPSOLVER_ENV_VAR = "CAPSOLVER_API_KEY";

// ─── Interfaces publiques ────────────────────────────────────────────────────

/** Dépendances injectées du contrôleur preflight. */
export interface PreflightDeps {
  /** Configuration de grille validée (fenêtres en minutes-dans-l'heure). */
  config: GridConfig;
  /** Pool de sessions de réserve pré-solvées (swap instantané). */
  reservePool: ReservePoolManager;
  /** Clé CapSolver (secret via env uniquement ; jamais journalisée). */
  capsolverKey: string;
  /** URL du portail Bookitit ciblé (sans fragment). */
  portalUrl: string;
}

/** Résultat de vérification d'une session armée. */
export type PreflightVerifyResult = "valid" | "invalid" | "unverified";

/** Contrôleur de la phase preflight (design.md, Component 4). */
export interface PreflightController {
  /** true si l'heure courante est dans la fenêtre preflight `[windowStartMin, huntStartMin[`. */
  isPreflightWindow(nowMs: number): boolean;
  /** Arme (init session) chaque dossier non encore armé, en isolant les échecs. */
  armAll(dossiers: SpainDossierConfig[]): Promise<void>;
  /** Vérifie chaque session armée ; swap/re-solve si invalide ; marque non prêt à huntStartMin. */
  verifyAndRepair(nowMs: number): Promise<void>;
  /** États runtime armés indexés par dossierId (consommés par l'orchestrateur). */
  getArmedStates(): Map<string, WorkerRuntimeState>;
  /** Ensemble des dossiers marqués non prêts (échec preflight à huntStartMin). */
  getUnreadyDossiers(): ReadonlySet<string>;
}

// ─── Helpers internes ──────────────────────────────────────────────────────

/**
 * Dérive la minute-dans-l'heure (0–59) pour un instant donné, dans le fuseau
 * `Europe/Madrid`. Réplique volontaire (et minimale) de l'approche employée dans
 * `spain-wallclock-grid.ts` afin de garder chaque module autonome et testable sans
 * dépendance circulaire. En cas d'échec ICU inattendu, repli déterministe UTC (les
 * minutes sont invariantes par décalage horaire entier).
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
      "[spain-preflight] Dérivation de minute Europe/Madrid impossible, repli UTC:",
      error instanceof Error ? error.message : error,
    );
  }
  return Math.floor(nowMs / MS_PER_MINUTE) % 60;
}

/** Tronque un cf_clearance pour le journal (jamais en clair — Requirement 13.5). */
function truncCf(cfClearance: string | undefined): string {
  if (!cfClearance) return "<vide>";
  return `${cfClearance.slice(0, CF_LOG_HEAD_LEN)}…(${cfClearance.length}c)`;
}

/**
 * Sonde légère de validité d'une session CF (Requirement 6.2).
 *
 * Critères : session présente + `cfClearance` non vide + non expiré à `nowMs`
 * (`session.expiresAt > nowMs`). Ce contrôle est purement local (aucun appel réseau),
 * suffisant pour le périmètre de cette tâche.
 *
 * Point d'extension : une re-validation réseau réelle (GET widget → 200 vs 403)
 * viendrait ici ; elle nécessiterait de rendre `isSessionValid`/`verifyAndRepair`
 * asynchrones et d'envelopper l'appel dans un `try/catch` `[spain-preflight]`.
 */
function isSessionValid(session: SpainCfSession | undefined, nowMs: number): boolean {
  if (session === undefined) return false;
  if (!session.cfClearance) return false;
  return session.expiresAt > nowMs;
}

/**
 * Applique une session de réserve empruntée (ou re-solvée) à un état runtime :
 * met à jour la session et l'IP, puis fait transiter le worker vers `ARMED`.
 */
function applyReserveToState(
  rt: WorkerRuntimeState,
  session: SpainCfSession,
  proxyUrl: string,
): void {
  rt.session = session;
  rt.proxyUrl = proxyUrl;
  transition(rt, "recovered");
}

// ─── Concurrence d'armement ─────────────────────────────────────────────────

/** Concurrence par défaut de l'armement preflight (vagues de solve CF parallèles). */
const DEFAULT_PREFLIGHT_CONCURRENCY = 5;
/** Bornes de la concurrence d'armement. */
const PREFLIGHT_CONCURRENCY_MIN = 1;
const PREFLIGHT_CONCURRENCY_MAX = 20;

/**
 * Lit la concurrence d'armement depuis `SPAIN_PREFLIGHT_CONCURRENCY`, bornée à
 * [1, 20] (défaut 5). Une concurrence trop élevée re-déclencherait le rate limit
 * CapSolver ; trop basse rallongerait le preflight au-delà de la fenêtre. Absent/
 * invalide → défaut, sans interrompre l'armement.
 */
function readPreflightConcurrency(): number {
  const raw = process.env.SPAIN_PREFLIGHT_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PREFLIGHT_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    console.warn(
      `[spain-preflight] SPAIN_PREFLIGHT_CONCURRENCY non entier ("${raw}"), défaut ${DEFAULT_PREFLIGHT_CONCURRENCY}.`,
    );
    return DEFAULT_PREFLIGHT_CONCURRENCY;
  }
  return Math.max(PREFLIGHT_CONCURRENCY_MIN, Math.min(PREFLIGHT_CONCURRENCY_MAX, parsed));
}

// ─── Fabrique du contrôleur ────────────────────────────────────────────────

/**
 * Construit un `PreflightController` à partir de ses dépendances.
 *
 * Le contrôleur maintient en interne une `Map<dossierId, WorkerRuntimeState>` des
 * sessions armées et un `Set<dossierId>` des dossiers non prêts. `getArmedStates` et
 * `getUnreadyDossiers` exposent ces structures à l'orchestrateur (task 11.1).
 *
 * @param deps dépendances (config grille, pool de réserve, clé CapSolver, URL portail).
 * @returns un `PreflightController` prêt pour `isPreflightWindow` / `armAll` / `verifyAndRepair`.
 */
export function createPreflightController(deps: PreflightDeps): PreflightController {
  const { config, reservePool, capsolverKey, portalUrl } = deps;

  /** États runtime armés, indexés par dossierId. */
  const armedStates = new Map<string, WorkerRuntimeState>();
  /** Dossiers marqués non prêts (échec preflight à huntStartMin). */
  const unreadyDossiers = new Set<string>();

  /**
   * true si `nowMs` (minute-dans-l'heure Europe/Madrid) est dans la fenêtre preflight
   * `[windowStartMin, huntStartMin[`. Requirement 6.1.
   */
  function isPreflightWindow(nowMs: number): boolean {
    const minute = minuteOfHourInMadrid(nowMs);
    return minute >= config.windowStartMin && minute < config.huntStartMin;
  }

  /**
   * Arme un seul dossier : `initWorkerSession` sur une IP Decodo, plafonné à
   * `ARM_TIMEOUT_MS` (Requirement 6.1). Isole tout échec (réseau, timeout, secret
   * manquant) : consigné `[spain-preflight]` puis retourné `false`, sans lancer.
   */
  async function armOne(dossier: SpainDossierConfig): Promise<boolean> {
    // Secret manquant (Requirement 13.4) : interrompre l'init de CE dossier, nommer
    // la variable manquante SANS révéler sa valeur, ne pas propager d'exception.
    if (!capsolverKey || capsolverKey.trim() === "") {
      console.error(
        `[spain-preflight] Secret requis absent (${CAPSOLVER_ENV_VAR}) — init de la session ` +
          `du dossier ${dossier.id} interrompue. Aucune valeur de secret n'est journalisée.`,
      );
      return false;
    }

    // Sélection d'une IP Decodo distincte (rotateDecodoUrl saute déjà les IP blacklistées).
    const proxyUrl = rotateDecodoUrl();
    if (proxyUrl === undefined) {
      console.warn(
        `[spain-preflight] Aucune IP Decodo disponible pour armer le dossier ${dossier.id} — échec isolé.`,
      );
      return false;
    }

    // Course entre l'armement et un timeout de 30 s (Requirement 6.1).
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(null), ARM_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        initWorkerSession(proxyUrl, portalUrl, capsolverKey),
        timeoutPromise,
      ]);

      if (result === null) {
        console.warn(
          `[spain-preflight] Armement échoué/dépassé (>${ARM_TIMEOUT_MS}ms) pour ${dossier.id} — échec isolé.`,
        );
        return false;
      }

      const { session } = result;
      if (!session.cfClearance) {
        console.warn(
          `[spain-preflight] Session armée sans cf_clearance pour ${dossier.id} — échec isolé.`,
        );
        return false;
      }

      const rt = createRuntimeState({ dossierId: dossier.id, proxyUrl, session });
      armedStates.set(dossier.id, rt);
      unreadyDossiers.delete(dossier.id);
      console.log(
        `[spain-preflight] ✅ Dossier ${dossier.id} armé — cf=${truncCf(session.cfClearance)} | ` +
          `exp=${new Date(session.expiresAt).toISOString()}`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[spain-preflight] Erreur réseau à l'armement du dossier ${dossier.id}: ${message} — échec isolé.`,
      );
      return false;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Arme exactement une session par dossier non encore armé. Chaque échec est isolé
   * (consigné, sans interrompre les autres dossiers) — Requirement 6.1.
   *
   * Parallélisme BORNÉ (concurrence configurable) : chaque solve CF dure ~20-40 s ;
   * armer 20 dossiers EN SÉRIE prendrait 7-13 min et déborderait la fenêtre preflight
   * (`[windowStartMin, huntStartMin[`, ~8 min par défaut). On arme donc par vagues de
   * `SPAIN_PREFLIGHT_CONCURRENCY` (défaut 5, borné [1, 20]) : 20 dossiers / 5 ≈ 4 vagues
   * ≈ 2 min, ce qui tient largement dans la marge avant `huntStartMin`. La concurrence
   * reste bornée pour ne PAS re-déclencher le rate limit CapSolver (le getBalance
   * bloquant a par ailleurs été retiré du chemin de solve). L'isolation des échecs est
   * préservée : `armOne` ne lance jamais (try/catch interne → false).
   */
  async function armAll(dossiers: SpainDossierConfig[]): Promise<void> {
    console.log(`[spain-preflight] 🔫 armAll — ${dossiers.length} dossier(s) à traiter.`);

    // Ne conserver que les dossiers PAS encore armés (session absente).
    const pending = dossiers.filter((d) => {
      const existing = armedStates.get(d.id);
      return existing === undefined || existing.session === undefined;
    });
    const alreadyArmed = dossiers.length - pending.length;

    const concurrency = readPreflightConcurrency();
    let armed = alreadyArmed;

    // Traitement par vagues de taille `concurrency` : chaque vague arme en parallèle,
    // on attend la fin de la vague avant d'entamer la suivante (concurrence bornée).
    for (let i = 0; i < pending.length; i += concurrency) {
      const wave = pending.slice(i, i + concurrency);
      const results = await Promise.all(wave.map((dossier) => armOne(dossier)));
      armed += results.filter((ok) => ok).length;
    }

    console.log(
      `[spain-preflight] 🔫 armAll terminé — ${armed}/${dossiers.length} dossier(s) armé(s) ` +
        `(concurrence ${concurrency}, ${alreadyArmed} déjà armé(s)).`,
    );
  }

  /**
   * Re-solve immédiat d'une session pour un dossier (réserve indisponible). Utilise
   * une IP distincte via `rotateDecodoUrl` + `initWorkerSession`. Retourne la session
   * ou `null` (échec isolé, journalisé). Enveloppe l'appel réseau dans `try/catch`.
   */
  async function reSolveOne(
    rt: WorkerRuntimeState,
    dossierId: string,
  ): Promise<boolean> {
    if (!capsolverKey || capsolverKey.trim() === "") {
      console.error(
        `[spain-preflight] Secret requis absent (${CAPSOLVER_ENV_VAR}) — re-solve du dossier ` +
          `${dossierId} interrompu. Aucune valeur de secret n'est journalisée.`,
      );
      return false;
    }

    const proxyUrl = rotateDecodoUrl();
    if (proxyUrl === undefined) {
      console.warn(
        `[spain-preflight] Aucune IP Decodo disponible pour re-solve du dossier ${dossierId}.`,
      );
      return false;
    }

    try {
      const result = await initWorkerSession(proxyUrl, portalUrl, capsolverKey);
      if (result === null || !result.session.cfClearance) {
        console.warn(
          `[spain-preflight] Re-solve échoué (session/cf_clearance absent) pour ${dossierId}.`,
        );
        return false;
      }
      applyReserveToState(rt, result.session, proxyUrl);
      console.log(
        `[spain-preflight] ♻️ Re-solve immédiat OK pour ${dossierId} — cf=${truncCf(result.session.cfClearance)}.`,
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[spain-preflight] Erreur réseau au re-solve du dossier ${dossierId}: ${message}.`,
      );
      return false;
    }
  }

  /**
   * Répare une session armée invalide : swap réserve prioritaire (< 5 s, sans solve
   * synchrone dans le chemin du swap) + `replenishAsync` en fond (Requirement 6.3) ;
   * réserve indisponible ⟹ re-solve immédiat + indication d'échec de swap nommant le
   * dossier (Requirement 6.4).
   */
  async function repairOne(
    rt: WorkerRuntimeState,
    dossierId: string,
    nowMs: number,
  ): Promise<void> {
    const reserve = reservePool.borrow(nowMs);
    if (reserve !== null) {
      applyReserveToState(rt, reserve.session, reserve.proxyUrl);
      // Reconstitution en tâche de fond, jamais bloquante (Requirement 6.3).
      reservePool.replenishAsync(capsolverKey, portalUrl);
      console.log(
        `[spain-preflight] 🔁 Swap réserve OK pour ${dossierId} — cf=${truncCf(reserve.session.cfClearance)}.`,
      );
      return;
    }

    // Réserve indisponible : re-solve immédiat + indication d'échec de swap (Req 6.4).
    console.warn(
      `[spain-preflight] ⚠️ Échec de swap: aucune réserve prête pour le dossier ${dossierId} — ` +
        `re-solve immédiat.`,
    );
    await reSolveOne(rt, dossierId);
  }

  /**
   * Vérifie chaque session armée (sonde `cf_clearance`) et répare les invalides.
   * Session toujours invalide à `huntStartMin` ⟹ dossier marqué non prêt + log
   * d'échec preflight, sans interrompre les autres (Requirement 6.5).
   *
   * @param nowMs instant courant (ms epoch). Devrait être appelé au plus tard
   *   `VERIFY_DEADLINE_BEFORE_HUNT_MS` avant `huntStartMin` (Requirement 6.2).
   */
  async function verifyAndRepair(nowMs: number): Promise<void> {
    const minute = minuteOfHourInMadrid(nowMs);
    const atHuntStart = minute >= config.huntStartMin;
    if (!atHuntStart) {
      const marginMin = config.huntStartMin - minute;
      if (marginMin * MS_PER_MINUTE < VERIFY_DEADLINE_BEFORE_HUNT_MS) {
        console.warn(
          `[spain-preflight] verifyAndRepair proche de huntStartMin (${marginMin} min restante(s)) — ` +
            `marge de réparation réduite.`,
        );
      }
    }

    console.log(
      `[spain-preflight] 🔎 verifyAndRepair — ${armedStates.size} session(s) armée(s) à vérifier.`,
    );

    for (const [dossierId, rt] of armedStates) {
      if (isSessionValid(rt.session, nowMs)) {
        continue;
      }

      console.warn(`[spain-preflight] Session invalide détectée pour ${dossierId} — réparation.`);
      await repairOne(rt, dossierId, nowMs);

      // Réévaluer après réparation.
      if (!isSessionValid(rt.session, nowMs)) {
        if (atHuntStart) {
          // Session toujours invalide à huntStartMin : dossier non prêt (Requirement 6.5).
          unreadyDossiers.add(dossierId);
          console.error(
            `[spain-preflight] ❌ Échec preflight: dossier ${dossierId} non prêt à huntStartMin ` +
              `(session invalide après réparation). Traitement des autres dossiers poursuivi.`,
          );
        } else {
          console.warn(
            `[spain-preflight] Dossier ${dossierId} toujours invalide après réparation — retentera ` +
              `avant huntStartMin.`,
          );
        }
      } else {
        // Réparation réussie : le dossier n'est plus non prêt.
        unreadyDossiers.delete(dossierId);
      }
    }

    console.log(
      `[spain-preflight] 🔎 verifyAndRepair terminé — ${armedStates.size - unreadyDossiers.size}/` +
        `${armedStates.size} session(s) prête(s), ${unreadyDossiers.size} non prête(s).`,
    );
  }

  function getArmedStates(): Map<string, WorkerRuntimeState> {
    return armedStates;
  }

  function getUnreadyDossiers(): ReadonlySet<string> {
    return unreadyDossiers;
  }

  return {
    isPreflightWindow,
    armAll,
    verifyAndRepair,
    getArmedStates,
    getUnreadyDossiers,
  };
}
