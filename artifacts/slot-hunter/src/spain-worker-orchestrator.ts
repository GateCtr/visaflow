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
  const v = Number(process.env.SPAIN_WINDOW_DURATION_MIN ?? "15");
  return Math.max(1, Number.isFinite(v) ? Math.round(v) : 15);
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

      // 4. Démarrer un worker pour chaque dossier sans worker en cours
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

        // Arrêter le keep-alive Decodo — le worker prend le relai sur ce proxy
        stopKeepAlive(config.id);

        const promise = runDossierWorker({
          ...config,
          activeDossierCount: dossiers.length,
          dossierIndex: dossiers.sort((a, b) => a.id.localeCompare(b.id)).findIndex((d) => d.id === config.id),
        }).then((result) => {
          return result;
        }).catch((err) => {
          log("WARN", `[SPAIN-ORCH] Worker ${config.applicantName} exception non gérée: ${err}`);
          return {
            dossierId: config.id,
            status: "error" as const,
            errorMessage: String(err),
          };
        });

        workers.set(config.id, {
          promise,
          config,
          startedAt: Date.now(),
          cooldownUntil: 0,
        });
      }

      // 5. Logging état des workers
      if (iteration % 5 === 1 || workers.size > 0) {
        const active = [...workers.entries()].map(
          ([id, w]) =>
            `${w.config.applicantName}(${Math.round((Date.now() - w.startedAt) / 60_000)}min)`,
        );
        log(
          "INFO",
          `[SPAIN-ORCH] Itération #${iteration} — workers actifs: ${active.length > 0 ? active.join(", ") : "aucun"} | dossiers Convex: ${dossiers.length}`,
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
    stopAllKeepAlives();
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
        // Démarrer le keep-alive Decodo pour maintenir l'exit IP pendant la pause
        // Récupérer le stickyId et baseProxy depuis Redis (sauvegardés par le worker dans finally)
        getLastStickyForDossier(id).then(async (stickyId) => {
          if (!stickyId) return;
          const baseProxy = await getLastProxyForDossier(id);
          if (!baseProxy) return;
          startKeepAlive(id, baseProxy, stickyId, w.config.portalUrl);
        }).catch(() => {});
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
// DECODO KEEP-ALIVE — Maintient les sessions sticky actives entre les fenêtres
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Intervalle entre les pings keep-alive (ms).
 * Decodo sessionduration-60 a un idle timeout ~10-15min sur les résidentiels.
 * 12 min entre pings garantit qu'on reste sous le seuil d'inactivité.
 */
const KEEPALIVE_INTERVAL_MS = 12 * 60_000; // 12 min

/** Map dossierId → intervalId pour annuler les keep-alive au redémarrage du worker */
const activeKeepAlives = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Injecte un sticky session ID dans l'URL proxy Decodo (copie simplifiée de addStickySession).
 */
function addStickyToUrl(baseUrl: string, sid: string): string {
  try {
    const u = new URL(baseUrl);
    const user = decodeURIComponent(u.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    u.username = encodeURIComponent(stickyUser);
    return u.toString();
  } catch { return baseUrl; }
}

/**
 * Démarre un keep-alive périodique pour un dossier en pause inter-fenêtre.
 * Envoie un HEAD request à httpbin via le même proxy+sticky pour maintenir
 * la session Decodo active (même exit IP) → cf_clearance valide au prochain démarrage.
 *
 * Si le ping échoue (timeout/proxy mort) :
 *   1. Blackliste le port actuel
 *   2. Invalide stickyId + cf_clearance en Redis
 *   3. Prend un nouveau port (rotation)
 *   4. Solve CF sur le nouveau port → sauvegarde en Redis
 *   5. Met à jour lastProxy/lastSticky → le worker démarre à 0s
 */
function startKeepAlive(dossierId: string, baseProxy: string, stickyId: string, portalUrl: string): void {
  // Annuler un éventuel keep-alive précédent
  stopKeepAlive(dossierId);

  let currentBaseProxy = baseProxy;
  let currentStickyId = stickyId;
  let currentStickyUrl = addStickyToUrl(baseProxy, stickyId);
  let preWarmInProgress = false;

  const masked = () => currentStickyUrl.replace(/:([^:@/]+)@/, ":***@").slice(0, 50);

  log("INFO", `[SPAIN-ORCH] 🏓 Keep-alive démarré — ${dossierId.slice(0, 8)}… via ${masked()}… (toutes les ${KEEPALIVE_INTERVAL_MS / 60_000}min)`);

  const ping = async (): Promise<void> => {
    if (preWarmInProgress) return; // éviter le chevauchement ping + pre-warm

    try {
      const { Impit } = await import("impit");
      const impit = new Impit({ browser: "chrome", proxyUrl: currentStickyUrl, timeout: 10_000 } as any);
      const r = await (impit.fetch("https://httpbin.org/status/200", {
        method: "HEAD",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0" },
      } as any) as unknown as Promise<Response>);

      if (r.status >= 500) {
        // 503 = httpbin surchargé mais le proxy a routé la requête → session maintenue
        log("INFO", `[SPAIN-ORCH] 🏓 Keep-alive OK (${r.status}) — ${dossierId.slice(0, 8)}… (proxy: ${masked()}…)`);
      } else {
        log("INFO", `[SPAIN-ORCH] 🏓 Keep-alive OK — ${dossierId.slice(0, 8)}… HTTP ${r.status} (proxy: ${masked()}…)`);
      }
    } catch (err) {
      // ── PING FAIL — pre-warm : blacklister + rotation + solve CF ────────────
      log("WARN", `[SPAIN-ORCH] 🏓 Keep-alive FAIL — ${dossierId.slice(0, 8)}…: ${err instanceof Error ? err.message : err}`);
      preWarmInProgress = true;

      try {
        // 1. Blacklister le port actuel
        flagDecodoIp(currentBaseProxy, "keepalive-timeout");
        log("INFO", `[SPAIN-ORCH] 🏓 Port blacklisté: ${currentBaseProxy.slice(-20)}`);

        // 2. Invalider stickyId + cf_clearance en Redis
        await deleteLastStickyForDossier(dossierId);
        deleteWorkerCfClearance(currentStickyUrl);

        // 3. Prendre un nouveau port
        const newBaseProxy = rotateDecodoUrl();
        if (!newBaseProxy) {
          log("WARN", `[SPAIN-ORCH] 🏓 Pre-warm impossible — pool Decodo épuisé`);
          return;
        }

        // 4. Solve CF sur le nouveau port
        const newStickyId = Math.random().toString(36).slice(2, 10);
        const newStickyUrl = addStickyToUrl(newBaseProxy, newStickyId);
        const capsolverKey = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";

        if (!capsolverKey) {
          log("WARN", `[SPAIN-ORCH] 🏓 Pre-warm impossible — CAPSOLVER_API_KEY absent`);
          return;
        }

        log("INFO", `[SPAIN-ORCH] 🏓 Pre-warm CF — ${dossierId.slice(0, 8)}… nouveau port: ${newBaseProxy.slice(-20)} sid=${newStickyId}`);
        const targetUrl = portalUrl.split("#")[0];
        const result = await initWorkerSession(newStickyUrl, targetUrl, capsolverKey);

        if (result) {
          // 5. Sauvegarder en Redis pour que le worker démarre à 0s
          const cfExpiresAt = Date.now() + (115 * 60_000);
          saveWorkerCfClearance(newStickyUrl, result.session.cfClearance, cfExpiresAt);
          await saveLastStickyForDossier(dossierId, newStickyId);
          await saveLastProxyForDossier(dossierId, newBaseProxy);

          // Mettre à jour le keep-alive pour le nouveau port
          currentBaseProxy = newBaseProxy;
          currentStickyId = newStickyId;
          currentStickyUrl = newStickyUrl;

          log("INFO", `[SPAIN-ORCH] 🏓 ✅ Pre-warm réussi — ${dossierId.slice(0, 8)}… cf_clearance prêt sur ${newBaseProxy.slice(-20)}`);
        } else {
          // Solve échoué aussi sur le nouveau port → on laisse le worker solve au démarrage
          log("WARN", `[SPAIN-ORCH] 🏓 Pre-warm CF échoué — ${dossierId.slice(0, 8)}… (worker solvera au démarrage)`);
          // Sauver quand même le nouveau port/sticky (le worker solve dessus)
          await saveLastStickyForDossier(dossierId, newStickyId);
          await saveLastProxyForDossier(dossierId, newBaseProxy);
          currentBaseProxy = newBaseProxy;
          currentStickyId = newStickyId;
          currentStickyUrl = newStickyUrl;
        }
      } catch (preWarmErr) {
        log("WARN", `[SPAIN-ORCH] 🏓 Pre-warm exception: ${preWarmErr instanceof Error ? preWarmErr.message : preWarmErr}`);
      } finally {
        preWarmInProgress = false;
      }
    }
  };

  // Premier ping décalé de 30s
  setTimeout(() => { ping().catch(() => {}); }, 30_000);

  const intervalId = setInterval(() => { ping().catch(() => {}); }, KEEPALIVE_INTERVAL_MS);
  activeKeepAlives.set(dossierId, intervalId);
}

/**
 * Arrête le keep-alive pour un dossier (appelé quand le worker redémarre).
 */
function stopKeepAlive(dossierId: string): void {
  const existing = activeKeepAlives.get(dossierId);
  if (existing) {
    clearInterval(existing);
    activeKeepAlives.delete(dossierId);
    log("INFO", `[SPAIN-ORCH] 🏓 Keep-alive arrêté — ${dossierId.slice(0, 8)}…`);
  }
}

/**
 * Arrête tous les keep-alive actifs (cleanup à l'arrêt de l'orchestrateur).
 */
function stopAllKeepAlives(): void {
  for (const [id, interval] of activeKeepAlives) {
    clearInterval(interval);
  }
  if (activeKeepAlives.size > 0) {
    log("INFO", `[SPAIN-ORCH] 🏓 ${activeKeepAlives.size} keep-alive(s) arrêté(s)`);
  }
  activeKeepAlives.clear();
}
