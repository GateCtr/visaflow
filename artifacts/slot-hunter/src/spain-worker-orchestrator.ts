/**
 * spain-worker-orchestrator.ts — Orchestrateur de workers autonomes Espagne (Task #52)
 *
 * Remplace startSpainWatcherLoop() tres.
 *
 * COMPORTEMENT :
 *   1. Vérifie SPAIN_SCAN_DISABLED=1 (si actif → exit silencieux, Railway gère)
 *   2. Acquiert le lock Redis distribué (empêche une deuxième instance Replit de tourner)
 *   3. Récupère les dossiers actifs Espagne depuis Convex (getActiveJobs)
 *   4. Pour chaque dossier sans worker en cours → lance runDossierWorker()
 *   5. Quand un worker se termine :
 *        - "booked"  → attend RESTART_AFTER_BOOKING_MS avant de re-vérifier (le dossier
 *                       n'est probablement plus actif dans Convex)
 *        - "exited"  → relance immédiatement (fenêtre expirée = nouveau CF solve)
 *        - "error"   → attend RESTART_AFTER_ERROR_MS avant de relancer
 *   6. Boucle : re-poll Convex toutes les POLL_INTERVAL_MS pour capter les nouveaux dossiers
 *
 * INVARIANTS PRÉSERVÉS depuis le watcher legacy :
 *   - SPAIN_SCAN_DISABLED=1 → aucun scan (Railway actif)
 *   - Distributed Redis scanner lock (TTL 50 s, renewal automatique)
 *   - Reporting Convex (discovery, heartbeat, slot found) géré par chaque worker
 *   - initDecodoPool() + initSpainRedis() appelés avant le premier cycle
 */

import {
  initSpainRedis,
  acquireSpainScannerLock,
  renewSpainScannerLock,
  releaseSpainScannerLock,
  SPAIN_INSTANCE_ID,
  getLastStickyForDossier,
  getLastProxyForDossier,
  deleteLastStickyForDossier,
  saveLastStickyForDossier,
  saveLastProxyForDossier,
  deleteWorkerCfClearance,
  saveWorkerCfClearance,
} from "./spain-redis-persistence.js";
import { initDecodoPool, flagDecodoIp, rotateDecodoUrl } from "./spain-decodo-pool.js";
import { getActiveJobs, type HunterJob } from "./convexClient.js";
import { runDossierWorker, type SpainDossierConfig, type WorkerResult } from "./spain-dossier-worker.js";
import { initWorkerSession } from "./spain-soax-solver.js";
import { log } from "./scheduler-utils.js";
// spain-synchronized-scan (task 11.1) : preflight + pool de réserve partagé.
import { loadGridConfig, type GridConfig, type WorkerRuntimeState } from "./spain/spain-grid-config.js";
import { createReservePool, type ReservePoolManager } from "./spain/spain-reserve-pool.js";
import { createPreflightController, type PreflightController } from "./spain/spain-preflight-controller.js";

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Intervalle de re-poll Convex pour détecter de nouveaux dossiers ou fermetures */
const POLL_INTERVAL_MS = ((): number => {
  const v = Number(process.env.SPAIN_ORCHESTRATOR_POLL_SEC ?? "120");
  return Math.max(30, Number.isFinite(v) ? v : 120) * 1_000;
})();

/** Délai avant restart après booking réussi (le dossier peut avoir disparu de Convex) */
const RESTART_AFTER_BOOKING_MS = ((): number => {
  const v = Number(process.env.SPAIN_RESTART_AFTER_BOOKING_MIN ?? "5");
  return Math.max(1, Number.isFinite(v) ? v : 5) * 60_000;
})();

/** Délai avant restart après erreur (CF solve échec, IP bloquée…) */
const RESTART_AFTER_ERROR_MS = ((): number => {
  const v = Number(process.env.SPAIN_RESTART_AFTER_ERROR_MIN ?? "3");
  return Math.max(0.5, Number.isFinite(v) ? v : 3) * 60_000;
})();

/** Renouvellement du lock Redis (doit être < TTL lock = 50 s) */
const LOCK_RENEWAL_MS = 30_000;

/**
 * Fenêtre de publication des créneaux Bookitit.
 * Le portail publie généralement entre la 5ème et la 25ème minute de chaque heure.
 * On se réveille à WINDOW_START_MIN (défaut: 4) pour être prêt, et on laisse le
 * worker tourner pendant WORKER_WINDOW_MS (25 min dans spain-dossier-worker.ts).
 * Hors fenêtre → l'orchestrateur ne lance pas de nouveau worker.
 *
 * Override via env : SPAIN_WINDOW_START_MIN (0-59)
 */
const WINDOW_START_MIN = ((): number => {
  const v = Number(process.env.SPAIN_WINDOW_START_MIN ?? "5");
  return Math.max(0, Math.min(59, Number.isFinite(v) ? Math.round(v) : 5));
})();

/**
 * Durée de la fenêtre active (minutes). Utilisée uniquement pour le guard spawn de
 * l'orchestrateur (empêche de lancer un worker après la fin de fenêtre).
 * La borne de fin réelle dans le worker est WINDOW_END_MIN (absolu).
 * Override via env : SPAIN_WINDOW_DURATION_MIN
 */
const WINDOW_DURATION_MIN = ((): number => {
  const v = Number(process.env.SPAIN_WINDOW_DURATION_MIN ?? "20");
  return Math.max(1, Number.isFinite(v) ? Math.round(v) : 20);
})();

// ─── État interne ─────────────────────────────────────────────────────────────

interface RunningWorker {
  promise: Promise<WorkerResult>;
  config: SpainDossierConfig;
  startedAt: number;
  /** Timer avant lequel l'orchestrateur ne relancera pas ce dossier */
  cooldownUntil: number;
  /**
   * true = ce "worker" est un placeholder de cooldown (sleep + resolve "exited").
   * Il ne correspond pas à un worker réel — quand il se résout, l'orchestrateur
   * doit simplement retirer l'entrée de la map SANS appliquer de nouveau cooldown.
   * Cela évite le bug "fenêtre manquée" : sans ce flag, le cooldown placeholder
   * qui se résout exactement à HH:WINDOW_START_MIN serait traité comme une vraie
   * fin de fenêtre → nouveau cooldown de 60 min → worker jamais lancé ce cycle.
   */
  isCooldownPlaceholder?: boolean;
  /**
   * spain-synchronized-scan (task 11.1) : miroir léger de l'état runtime du worker
   * (state + phase) pour la supervision de récupération côté orchestrateur.
   *
   * NOTE : le `WorkerRuntimeState` réel (session, phpState, transitions) vit DANS le
   * worker (`spain-dossier-worker.ts`, task 10.1) ; cette copie n'est qu'un miroir
   * observable servant à exclure les workers `RECOVERING` du calcul de cadence
   * commune (Requirement 3.4). Optionnel → n'altère jamais l'API existante ni le
   * comportement des placeholders de cooldown.
   */
  runtimeState?: WorkerRuntimeState;
}

// ─── Entrée publique ──────────────────────────────────────────────────────────

/**
 * Lance l'orchestrateur de workers Espagne.
 * Remplace startSpainWatcherLoop() dans src/index.ts.
 * Tourne indéfiniment jusqu'à un signal externe (SIGTERM / SIGINT).
 */
export async function startSpainWorkerOrchestrator(): Promise<void> {
  // ── Guard SPAIN_SCAN_DISABLED ────────────────────────────────────────────────
  if (process.env.SPAIN_SCAN_DISABLED === "1") {
    log(
      "INFO",
      "[SPAIN-ORCH] ⏸️ SPAIN_SCAN_DISABLED=1 — orchestrateur Spain désactivé sur cette instance",
    );
    log(
      "INFO",
      "[SPAIN-ORCH]    → Retirer SPAIN_SCAN_DISABLED pour activer si Railway tombe",
    );
    return;
  }

  log(
    "INFO",
    `[SPAIN-ORCH] ▶ Orchestrateur démarré (instance: ${SPAIN_INSTANCE_ID}) — mode: agents autonomes par dossier`,
  );

  // ── Init Redis + Decodo pool ─────────────────────────────────────────────────
  const redisOk = await initSpainRedis();
  if (redisOk) {
    log("INFO", "[SPAIN-ORCH] ✅ Redis Spain connecté");
    await initDecodoPool();
  } else {
    log(
      "WARN",
      "[SPAIN-ORCH] ⚠️ Redis Spain indisponible — workers en mode dégradé (sans réservation IP)",
    );
  }

  // ── Distributed lock renewal ─────────────────────────────────────────────────
  // IMPORTANT : acquireSpainScannerLock utilise SET NX — il retourne toujours false si
  // la clé existe, même si CETTE instance la détient. Pour renouveler le TTL sans
  // perdre le lock, on utilise renewSpainScannerLock (Lua GET+EXPIRE propriétaire).
  let lockHeld = false;
  let lockLost = false; // signal pour interrompre la boucle principale
  const lockRenewalTimer = setInterval(async () => {
    if (!lockHeld) return;
    const renewed = await renewSpainScannerLock();
    if (!renewed) {
      log("WARN", "[SPAIN-ORCH] ⚠️ Lock Redis perdu — une autre instance a pris le relai → arrêt du spawn de nouveaux workers");
      lockHeld = false;
      lockLost = true;
    }
  }, LOCK_RENEWAL_MS);

  // ── Acquire initial lock ─────────────────────────────────────────────────────
  lockHeld = await acquireSpainScannerLock();
  if (!lockHeld) {
    log(
      "INFO",
      "[SPAIN-ORCH] 🔒 Lock Redis pris par une autre instance — cette instance attend…",
    );
    // Réessayer périodiquement jusqu'à obtenir le lock
    while (!lockHeld) {
      await sleep(LOCK_RENEWAL_MS);
      lockHeld = await acquireSpainScannerLock();
      if (lockHeld) {
        log("INFO", "[SPAIN-ORCH] 🔓 Lock Redis acquis — orchestrateur actif");
      }
    }
  } else {
    log("INFO", "[SPAIN-ORCH] 🔓 Lock Redis acquis");
  }

  // ── Map des workers actifs ───────────────────────────────────────────────────
  const workers = new Map<string, RunningWorker>();

  // ── spain-synchronized-scan (task 11.1) : grille + pool de réserve + preflight ──
  // La grille valide la config de fenêtre (ordre strict windowStartMin < huntStartMin
  // < lateStartMin < windowEndMin ; sinon défauts 5/13/17/25 réappliqués + erreur
  // journalisée par loadGridConfig). Requirements 12.5, 12.6.
  const gridConfig: GridConfig = loadGridConfig();
  // Pool de réserve PARTAGÉ : pré-solvé en preflight (warmUp), emprunté par les
  // workers pour un swap ~0 s en cas de proxy mort (injecté dans runDossierWorker).
  // targetSize dérive de SPAIN_RESERVE_POOL_SIZE côté pool (borné [1,100], défaut 4).
  const reservePool: ReservePoolManager = createReservePool({
    targetSize: readReservePoolSize(),
  });
  // Clé CapSolver : secret via env uniquement (jamais journalisée). Requirement 13.3.
  const capsolverKey = resolveCapsolverKey();
  // Contrôleur preflight instancié plus tard (portalUrl dépend des dossiers) — cf.
  // ensurePreflightController(). Requirement 6.1.
  let preflight: PreflightController | undefined;
  /**
   * Garde d'exécution unique du preflight par fenêtre horaire. On mémorise le début
   * de fenêtre (epoch ms tronqué à l'heure) déjà traité pour ne PAS relancer
   * armAll → warmUp → verifyAndRepair à chaque itération de la boucle.
   */
  let preflightDoneForWindowKey: number | null = null;

  // ── Boucle principale ─────────────────────────────────────────────────────────
  let iteration = 0;
  try {
    while (true) {
      iteration++;

      // Guard lock-loss : si le lock a été perdu (détecté par le timer renewal),
      // arrêter de spawner de nouveaux workers. Les workers existants continuent
      // jusqu'à la fin de leur fenêtre (on ne les interrompt pas en plein booking).
      if (lockLost) {
        log(
          "WARN",
          "[SPAIN-ORCH] 🔒 Lock Redis perdu — boucle arrêtée, workers existants terminent naturellement",
        );
        // Attendre que tous les workers finissent avant de quitter
        if (workers.size > 0) {
          await Promise.allSettled([...workers.values()].map((w) => w.promise));
        }
        break;
      }

      // 1. Nettoyer les workers terminés
      await harvestFinishedWorkers(workers);

      // 2. Récupérer les dossiers actifs depuis Convex
      const dossiers = await fetchActiveDossiers();
      const activeIds = new Set(dossiers.map((d) => d.id));

      // 3. Annuler (gracieusement) les workers dont le dossier n'est plus actif
      for (const [id, w] of workers) {
        if (!activeIds.has(id)) {
          log(
            "INFO",
            `[SPAIN-ORCH] Dossier ${w.config.applicantName} retiré de Convex — worker sera nettoyé au prochain harvest`,
          );
          // Pas d'annulation forcée : le worker sort naturellement à la fin de sa fenêtre
        }
      }

      // 3.5 spain-synchronized-scan (task 11.1) : phase preflight (armement +
      //     pré-solve du pool de réserve + vérification anticipée). S'exécute une
      //     seule fois par fenêtre horaire, uniquement pendant `isPreflightWindow`.
      //     Requirements 6.1, 12.5, 12.6.
      await runPreflightIfDue({
        dossiers,
        reservePool,
        gridConfig,
        capsolverKey,
        getController: (portalUrl) => {
          if (preflight === undefined) {
            preflight = createPreflightController({
              config: gridConfig,
              reservePool,
              capsolverKey,
              portalUrl,
            });
          }
          return preflight;
        },
        isDoneForWindow: (key) => preflightDoneForWindowKey === key,
        markDoneForWindow: (key) => {
          preflightDoneForWindowKey = key;
        },
      });

      // 4. Démarrer un worker pour chaque dossier sans worker en cours
      // ── V2 : check sommeil post-détection (DÉSACTIVÉ — annulations arrivent à tout moment) ──
      {
        for (const config of dossiers) {
        const existing = workers.get(config.id);

        if (existing) {
          // Worker actif → skip
          continue;
        }

        // Vérifier le cooldown (délai après booking/erreur/fenêtre)
        const cooldown = getCooldownRemaining(config.id, workers);
        if (cooldown > 0) {
          log(
            "INFO",
            `[SPAIN-ORCH] Dossier ${config.applicantName} : cooldown ${Math.ceil(cooldown / 60_000)}min — skip`,
          );
          continue;
        }

        // Guard fenêtre horaire : ne lancer un worker que si on est dans la fenêtre
        // de publication des créneaux [HH:WINDOW_START_MIN … HH:WINDOW_START_MIN+WINDOW_DURATION_MIN[
        if (!isInScanWindow()) {
          const waitMs = msUntilNextWindowStart();
          const nextWakeMin = String(WINDOW_START_MIN).padStart(2, "0");
          log(
            "INFO",
            `[SPAIN-ORCH] ⏰ Hors fenêtre — ${config.applicantName} : prochain scan dans ` +
            `${Math.round(waitMs / 60_000)}min (HH:${nextWakeMin})`,
          );
          continue;
        }

        log(
          "INFO",
          `[SPAIN-ORCH] 🚀 Lancement worker — ${config.applicantName} (${config.portalUrl.slice(-36)})`,
        );

        // spain-synchronized-scan (task 11.1) : injecter le pool de réserve PARTAGÉ
        // comme 2ᵉ argument de runDossierWorker (signature : runDossierWorker(config,
        // reservePool?)). Les workers empruntent ainsi la même réserve pour la
        // récupération (swap ~0 s en cas de proxy mort) — Requirement 3.4 / 5.2.
        const promise = runDossierWorker(
          {
            ...config,
            activeDossierCount: dossiers.length,
            dossierIndex: dossiers
              .sort((a, b) => {
                // Dossiers avec spainPriorityIndex en premier (triés par index croissant)
                // Dossiers sans index après, triés par ID alphabétique
                const aIdx = (a as { spainPriorityIndex?: number }).spainPriorityIndex;
                const bIdx = (b as { spainPriorityIndex?: number }).spainPriorityIndex;
                if (aIdx != null && bIdx != null) return aIdx - bIdx;
                if (aIdx != null) return -1;
                if (bIdx != null) return 1;
                return a.id.localeCompare(b.id);
              })
              .findIndex((d) => d.id === config.id),
          },
          reservePool,
        ).then((result) => {
          return result;
        }).catch((err) => {
          log("WARN", `[SPAIN-ORCH] Worker ${config.applicantName} exception non gérée: ${err}`);
          return {
            dossierId: config.id,
            status: "error" as const,
            errorMessage: String(err),
          };
        });

        // Miroir léger de l'état runtime pour la supervision (task 11.1). Le rt réel
        // vit dans le worker ; ici on initialise un état ARMED observable. La session
        // armée en preflight (si disponible) est reprise pour tracer l'exit IP.
        const armedMirror = preflight?.getArmedStates().get(config.id);
        const runtimeState: WorkerRuntimeState = {
          dossierId: config.id,
          state: "ARMED",
          gridSeed: armedMirror?.gridSeed ?? 0,
          session: armedMirror?.session,
          proxyUrl: armedMirror?.proxyUrl ?? "",
          slotEverSeen: false,
          lastScanAtMs: 0,
        };

        workers.set(config.id, {
          promise,
          config,
          startedAt: Date.now(),
          cooldownUntil: 0,
          runtimeState,
        });
        }
      } // end dossier launch block

      // 5. Logging état des workers
      if (iteration % 5 === 1 || workers.size > 0) {
        const active = [...workers.entries()].map(
          ([id, w]) =>
            `${w.config.applicantName}(${Math.round((Date.now() - w.startedAt) / 60_000)}min)`,
        );
        // spain-synchronized-scan (task 11.1) : nombre de workers sur la cadence de
        // grille commune (exclut les workers RECOVERING — Requirement 3.4).
        const cadenceCount = countCadenceWorkers(workers);
        log(
          "INFO",
          `[SPAIN-ORCH] Itération #${iteration} — workers actifs: ${active.length > 0 ? active.join(", ") : "aucun"} | ` +
            `cadence commune: ${cadenceCount} | dossiers Convex: ${dossiers.length}`,
        );
      }

      // 6. Attendre le prochain poll ou qu'un worker se termine
      // IMPORTANT : quand workers est vide, waitForAnyWorker() retourne une Promise
      // résolue → Promise.race() repartirait immédiatement sans dormir (busy-loop).
      // On n'inclut le race que s'il y a des workers actifs.
      if (workers.size > 0) {
        await Promise.race([
          sleep(POLL_INTERVAL_MS),
          waitForAnyWorker(workers),
        ]);
      } else {
        await sleep(POLL_INTERVAL_MS);
      }

      // 7. Second harvest après sleep (pour récupérer les résultats)
      await harvestFinishedWorkers(workers);
    }
  } finally {
    clearInterval(lockRenewalTimer);
    if (lockHeld) {
      await releaseSpainScannerLock().catch(() => {});
    }
    log("INFO", "[SPAIN-ORCH] 🛑 Orchestrateur arrêté");
  }
}

// ─── Harvest des workers terminés ────────────────────────────────────────────

/**
 * Vérifie tous les workers et récupère ceux qui sont terminés.
 * Met à jour `cooldownUntil` selon le statut.
 */
async function harvestFinishedWorkers(
  workers: Map<string, RunningWorker>,
): Promise<void> {
  const finished: Array<[string, RunningWorker, WorkerResult]> = [];

  for (const [id, w] of workers) {
    // Vérifier si la Promise est déjà résolue (sans await bloquant)
    const settled = await Promise.race([w.promise, Promise.resolve(null)]);
    if (settled !== null) {
      finished.push([id, w, settled as WorkerResult]);
    }
  }

  for (const [id, w, result] of finished) {
    const elapsed = Math.round((Date.now() - w.startedAt) / 60_000);

    // ── Placeholder de cooldown expiré ─────────────────────────────────────────
    // Ce n'est pas un vrai worker mais un sleep() pour bloquer le restart prématuré.
    // On retire simplement l'entrée de la map — aucun nouveau cooldown appliqué.
    // L'orchestrateur lancera le vrai worker au prochain cycle si isInScanWindow().
    if (w.isCooldownPlaceholder) {
      log(
        "INFO",
        `[SPAIN-ORCH] ⏰ ${w.config.applicantName} cooldown expiré — prêt à scanner si fenêtre ouverte`,
      );
      workers.delete(id);
      continue;
    }

    log(
      "INFO",
      `[SPAIN-ORCH] Worker ${w.config.applicantName} terminé en ${elapsed}min — statut: ${result.status}` +
      (result.errorMessage ? ` (${result.errorMessage})` : ""),
    );

    // Appliquer le cooldown selon le statut
    let cooldownMs = 0;
    switch (result.status) {
      case "booked":
        cooldownMs = RESTART_AFTER_BOOKING_MS;
        log(
          "INFO",
          `[SPAIN-ORCH] ✅ ${w.config.applicantName} BOOKÉÉ — cooldown ${cooldownMs / 60_000}min avant re-vérification`,
        );
        break;
      case "exited": {
        // Fenêtre expirée → dormir jusqu'au prochain HH:WINDOW_START_MIN
        // (le portail publie entre la 5ème et la 25ème minute — inutile de scanner hors fenêtre)
        cooldownMs = msUntilNextWindowStart();
        const nextWakeMin = String(WINDOW_START_MIN).padStart(2, "0");
        log(
          "INFO",
          `[SPAIN-ORCH] 💤 ${w.config.applicantName} fenêtre terminée — prochain scan dans ` +
          `${Math.round(cooldownMs / 60_000)}min (prochaine fenêtre HH:${nextWakeMin})`,
        );
        // Pas de keep-alive/pre-warm hors fenêtre : maintenir une session sticky Decodo
        // pendant la pause est inutile (la clearance CF et l'exit IP sessionduration-60
        // expirent avant la prochaine fenêtre) et coûteux (solve CapSolver + IP grillée
        // hors fenêtre). Le worker resolve CF à froid dès HH:WINDOW_START_MIN — la marge
        // avant la détection (~HH:13-14) suffit largement à un solve (~15-17s).
        break;
      }
      case "error":
        cooldownMs = RESTART_AFTER_ERROR_MS;
        break;
    }

    workers.delete(id);

    // Si cooldown > 0, réinscrire un placeholder pour bloquer le restart prématuré.
    // IMPORTANT : isCooldownPlaceholder=true pour distinguer ce placeholder d'un vrai worker.
    // Quand ce placeholder se résout (à HH:WINDOW_START_MIN), harvestFinishedWorkers le retire
    // simplement de la map SANS appliquer de nouveau cooldown → l'orchestrateur peut lancer
    // le vrai worker immédiatement si la fenêtre est ouverte.
    if (cooldownMs > 0) {
      const cooldownPromise = sleep(cooldownMs).then(() => ({
        dossierId: id,
        status: "exited" as const,
      }));
      workers.set(id, {
        promise: cooldownPromise,
        config: w.config,
        startedAt: Date.now(),
        cooldownUntil: Date.now() + cooldownMs,
        isCooldownPlaceholder: true,
      });
    }
  }
}

// ─── Cooldown helper ──────────────────────────────────────────────────────────

function getCooldownRemaining(
  dossierId: string,
  workers: Map<string, RunningWorker>,
): number {
  const w = workers.get(dossierId);
  if (!w) return 0;
  return Math.max(0, w.cooldownUntil - Date.now());
}

// ─── Wait for any worker ──────────────────────────────────────────────────────

async function waitForAnyWorker(
  workers: Map<string, RunningWorker>,
): Promise<void> {
  if (workers.size === 0) return;
  await Promise.race([...workers.values()].map((w) => w.promise));
}

// ─── Fetch dossiers Convex ────────────────────────────────────────────────────

async function fetchActiveDossiers(): Promise<SpainDossierConfig[]> {
  try {
    const jobs = await getActiveJobs();

    const spainDestinations = ["spain", "espagne", "es"];
    const spainJobs = jobs
      .filter((j: HunterJob) => spainDestinations.includes(j.destination))
      .filter((j: HunterJob) => j.hunterConfig?.isActive === true)
      .filter(
        (j: HunterJob) =>
          !!j.hunterConfig.embassyUsername && !!j.hunterConfig.embassyPassword,
      )
      .filter(
        (j: HunterJob) =>
          !!(j.portalUrl ?? (j.hunterConfig as { scheduleUrl?: string }).scheduleUrl),
      );

    if (spainJobs.length === 0 && jobs.length > 0) {
      // Log diagnostic uniquement en cas de problème inattendu (tous les cycles)
      const dests = [
        ...new Set(jobs.map((j: HunterJob) => j.destination)),
      ].join(", ");
      log(
        "INFO",
        `[SPAIN-ORCH] Diagnostic: ${jobs.length} job(s) total, 0 Espagne — destinations: [${dests}]`,
      );
    }

    return spainJobs.map((j: HunterJob) => ({
      id: j.id,
      applicantName: j.applicantName,
      visaType: j.visaType,
      login: j.hunterConfig.embassyUsername,
      password: j.hunterConfig.embassyPassword,
      applicationId: j.id,
      otpChannel: (j.spainOtpConfig?.channel ?? "email") as
        | "email"
        | "sms"
        | "manual",
      slotDateFrom: j.hunterConfig.slotDateFrom,
      slotDateDeadline: j.hunterConfig.slotDateDeadline,
      portalUrl:
        j.portalUrl ??
        (j.hunterConfig as { scheduleUrl?: string }).scheduleUrl ??
        "",
      groupSize: j.hunterConfig.groupSize,
      spainPriorityIndex: (j.hunterConfig as { spainPriorityIndex?: number }).spainPriorityIndex,
    }));
  } catch (err) {
    log("WARN", `[SPAIN-ORCH] Échec récupération dossiers: ${err}`);
    return [];
  }
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Calcule le nombre de ms jusqu'à la prochaine occurrence de HH:WINDOW_START_MIN:00.
 * Exemple : si WINDOW_START_MIN=4 et qu'il est 10h29, on attend 35 min jusqu'à 11h04.
 */
function msUntilNextWindowStart(): number {
  const now = new Date();
  // Position actuelle dans l'heure (en minutes décimales)
  const minInHour = now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60_000;

  let minutesUntil: number;
  if (minInHour < WINDOW_START_MIN) {
    // Avant le début de la fenêtre de cette heure
    minutesUntil = WINDOW_START_MIN - minInHour;
  } else {
    // Après le début → attendre la prochaine heure
    minutesUntil = 60 - minInHour + WINDOW_START_MIN;
  }

  return Math.round(minutesUntil * 60_000);
}

/**
 * Retourne true si on est actuellement dans la fenêtre de publication des créneaux :
 * [WINDOW_START_MIN, WINDOW_START_MIN + WINDOW_DURATION_MIN[
 */
function isInScanWindow(): boolean {
  const now = new Date();
  const minInHour = now.getMinutes() + now.getSeconds() / 60;
  return minInHour >= WINDOW_START_MIN && minInHour < WINDOW_START_MIN + WINDOW_DURATION_MIN;
}

// ═══════════════════════════════════════════════════════════════════════════════
// spain-synchronized-scan (task 11.1) — Preflight + pool de réserve + supervision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lit la taille cible du pool de réserve depuis `SPAIN_RESERVE_POOL_SIZE`
 * (borné [1, 100], défaut 4). Le bornage/validation final est refait dans
 * `createReservePool` ; on fournit ici une valeur de départ raisonnable.
 * Requirement 11.7.
 */
function readReservePoolSize(): number {
  const raw = process.env.SPAIN_RESERVE_POOL_SIZE;
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 4;
  return Math.max(1, Math.min(100, parsed));
}

/**
 * Résout la clé CapSolver depuis l'environnement UNIQUEMENT (jamais en dur, jamais
 * journalisée). Requirements 13.3, 13.4. Retourne une chaîne vide si absente ;
 * `armOne`/`warmUp` isolent alors l'échec en nommant la variable sans révéler la
 * valeur.
 */
function resolveCapsolverKey(): string {
  return process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
}

/**
 * Sélectionne une URL de portail représentative pour le warmUp/preflight du pool de
 * réserve (qui nécessitent un unique portalUrl).
 *
 * CHOIX documenté : on prend le portail du PREMIER dossier (ordre Convex). Le
 * cf_clearance étant lié à l'exit IP (pas au portail Bookitit, qui partage la même
 * protection Cloudflare pour toutes les consulats Espagne), une réserve pré-solvée
 * sur ce portail est réutilisable pour les autres dossiers Espagne.
 *
 * LIMITATION : si les dossiers ciblent des portails Cloudflare hétérogènes, la
 * réserve pré-solvée pourrait ne pas être directement valide pour un portail
 * différent. Dans ce cas, le worker re-solvera au besoin (chemin de récupération).
 * On journalise le portail retenu (tronqué) sans exposer de secret.
 */
function pickRepresentativePortalUrl(dossiers: SpainDossierConfig[]): string | undefined {
  for (const d of dossiers) {
    const url = (d.portalUrl ?? "").split("#")[0];
    if (url && url.trim() !== "") return url;
  }
  return undefined;
}

/** Dépendances de l'exécution preflight (injectées depuis la boucle principale). */
interface PreflightRunDeps {
  dossiers: SpainDossierConfig[];
  reservePool: ReservePoolManager;
  gridConfig: GridConfig;
  capsolverKey: string;
  /** Fabrique paresseuse du contrôleur (portalUrl connu seulement au runtime). */
  getController: (portalUrl: string) => PreflightController;
  isDoneForWindow: (windowKey: number) => boolean;
  markDoneForWindow: (windowKey: number) => void;
}

/**
 * Exécute la séquence preflight `armAll → warmUp → verifyAndRepair` UNE SEULE FOIS
 * par fenêtre horaire, uniquement lorsque l'heure courante est dans la fenêtre
 * preflight (`[windowStartMin, huntStartMin[`, fuseau Europe/Madrid).
 *
 * S'abstient totalement si aucun dossier ou si aucun portail exploitable
 * (Requirement 12.5/12.6 : pas de scan/travail hors fenêtre ou sur config invalide).
 * Tous les appels réseau sont enveloppés dans un `try/catch` `[SPAIN-ORCH]` ; les
 * secrets restent en env.
 */
async function runPreflightIfDue(deps: PreflightRunDeps): Promise<void> {
  const { dossiers, reservePool, capsolverKey } = deps;
  const nowMs = Date.now();

  // Portail représentatif requis pour instancier le contrôleur + warmUp.
  const portalUrl = pickRepresentativePortalUrl(dossiers);
  if (dossiers.length === 0 || portalUrl === undefined) {
    return; // rien à pré-armer — abstention.
  }

  const controller = deps.getController(portalUrl);

  // Hors fenêtre preflight → ne rien faire (Requirement 6.1 / 12.5).
  if (!controller.isPreflightWindow(nowMs)) {
    return;
  }

  // Clé de fenêtre = début de l'heure courante (ms epoch). Une seule exécution par
  // fenêtre horaire, même si la boucle itère plusieurs fois pendant le preflight.
  const windowKey = Math.floor(nowMs / 3_600_000);
  if (deps.isDoneForWindow(windowKey)) {
    return;
  }
  deps.markDoneForWindow(windowKey);

  log(
    "INFO",
    `[SPAIN-ORCH] 🛫 Preflight — fenêtre HH:${String(deps.gridConfig.windowStartMin).padStart(2, "0")}` +
      ` → HH:${String(deps.gridConfig.huntStartMin).padStart(2, "0")} | ${dossiers.length} dossier(s) | ` +
      `portail ${portalUrl.slice(-36)}`,
  );

  try {
    await controller.armAll(dossiers);
    await reservePool.warmUp(capsolverKey, portalUrl);
    await controller.verifyAndRepair(Date.now());

    const unready = controller.getUnreadyDossiers();
    log(
      "INFO",
      `[SPAIN-ORCH] 🛫 Preflight terminé — réserves prêtes: ${reservePool.size()}/${reservePool.targetSize}` +
        `${unready.size > 0 ? ` | dossiers non prêts: ${unready.size}` : ""}`,
    );
  } catch (err) {
    // Un échec preflight ne doit jamais interrompre l'orchestrateur : les workers
    // re-solveront au démarrage si nécessaire. On journalise sans exposer de secret.
    log(
      "WARN",
      `[SPAIN-ORCH] 🛫 Preflight échoué (non fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Compte les workers activement synchronisés sur la cadence de grille commune, en
 * EXCLUANT tout worker en état `RECOVERING` (Requirement 3.4 : la dérive ≤ 50 ms
 * s'évalue sur les workers non en récupération ; un worker qui répare ne perturbe
 * pas et n'est pas compté dans la cadence commune).
 *
 * Fonction de supervision/observabilité — le calcul de cadence lui-même est réalisé
 * par la grille dans chaque worker (task 10.1).
 */
function countCadenceWorkers(workers: Map<string, RunningWorker>): number {
  let count = 0;
  for (const w of workers.values()) {
    if (w.isCooldownPlaceholder) continue;
    if (w.runtimeState?.state === "RECOVERING") continue;
    count++;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════════
// (Keep-alive / pre-warm inter-fenêtre SUPPRIMÉ)
//
// Maintenir une session sticky Decodo « chaude » entre les fenêtres était inutile :
// la clearance CF et l'exit IP (sessionduration-60) expirent avant la fenêtre
// suivante, et le ping déclenchait un solve CapSolver + une rotation d'IP hors
// fenêtre — coût sec sans gain. Chaque worker resolve désormais CF à froid dès
// HH:WINDOW_START_MIN ; la marge avant la détection (~HH:13-14) absorbe le solve.
// ═══════════════════════════════════════════════════════════════════════════════

// (fonctions startKeepAlive / stopKeepAlive / stopAllKeepAlives supprimées)
