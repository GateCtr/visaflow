// ─── Parallel Mode Loop — OFC Watcher partagé + keep-alive per-account ──────
// Extracted from index.ts

import { getActiveJobs, getBotConfigValue, type HunterJob } from "../convexClient.js";
import { log, URGENCY_ORDER } from "../scheduler-utils.js";
import { pausedJobs, completedJobs } from "../scheduler-state.js";

/**
 * Initialize the parallel watchers: register accounts for keep-alive,
 * bootstrap OFC data, and start the OFC Watcher.
 */
export async function initParallelWatchers(
  convexUrl: string,
  hunterKey: string,
  alreadyRegisteredUsernames: Set<string>,
): Promise<boolean> {
  const { startOfcWatcher, subscribeToOfcWatcher, makeOfcKey } = await import("../usaPortal/ofc-watcher.js");
  const { runBookingRace } = await import("../usaPortal/booking-race.js");
  const { registerAccountForKeepAlive, startAccountsMonitor, getReadyAccountCount, getAccountsStatus, setRotationPeerCountFn } = await import("../usaPortal/accounts-keep-alive.js");

  setRotationPeerCountFn((_username: string) => {
    const readyCount = getReadyAccountCount();
    return Math.max(0, readyCount - 1);
  });

  startAccountsMonitor();

  let jobs: HunterJob[];
  try {
    jobs = await getActiveJobs();
  } catch (err) {
    log("ERROR", `[parallel] Échec récupération jobs: ${err} — retry dans 30s`);
    return false;
  }

  const usaJobs = jobs.filter(j =>
    j.destination === "usa" &&
    j.hunterConfig?.isActive === true &&
    !pausedJobs.has(j.id) &&
    !completedJobs.has(j.id) &&
    !!j.portalUrl,
  );

  if (usaJobs.length === 0) {
    log("INFO", "[parallel] Aucun dossier USA actif — mode legacy uniquement");
    return false;
  }

  log("INFO", `[parallel] ${usaJobs.length} dossier(s) USA actif(s) — inscription keep-alive...`);

  // 1. Inscrire chaque compte pour le keep-alive permanent
  for (const job of usaJobs) {
    await registerAccountForKeepAlive(job);
    alreadyRegisteredUsernames.add(job.hunterConfig.embassyUsername.toLowerCase());
  }

  const readyCount = getReadyAccountCount();
  log("INFO", `[parallel] ${readyCount}/${usaJobs.length} comptes prêts (token valide)`);

  // 2. Démarrer le watcher OFC
  const sortedByTier = [...usaJobs].sort((a, b) => {
    const ta = URGENCY_ORDER[a.urgencyTier] ?? 3;
    const tb = URGENCY_ORDER[b.urgencyTier] ?? 3;
    return ta - tb;
  });

  const ofcKey = makeOfcKey("usa", "Kinshasa", 323);

  const onSlotDetected = async (event: any, subscribers: any[]) => {
    log("INFO", `[parallel] 🚨 SLOT BROADCAST → ${subscribers.length} participants en course!`);
    const raceResult = await runBookingRace(event, subscribers);
    if (raceResult.successCount > 0) {
      log("INFO", `[parallel] 🏆 BOOKING RÉUSSI par ${raceResult.winnerJobId?.slice(-6)} en ${Math.round(raceResult.durationMs / 1000)}s`);
      if (raceResult.winnerJobId) {
        completedJobs.add(raceResult.winnerJobId);
        pausedJobs.add(raceResult.winnerJobId);
      }
    } else {
      log("WARN", `[parallel] ❌ Booking race échouée — slot expiré ou tous les participants en erreur`);
    }
  };

  // ── Bootstrap ────
  const { bootstrapAccountData } = await import("../usaPortal/parallel-bootstrap.js");

  let watcherJob: HunterJob | null = null;
  let watcherUsername = "";
  let bootstrapResult: Awaited<ReturnType<typeof bootstrapAccountData>> | null = null;

  const { isAccountRestricted: isRestricted } = await import("../usaPortal/account-restriction.js");

  for (const candidateJob of sortedByTier) {
    const candidateUsername = candidateJob.hunterConfig.embassyUsername;

    if (isRestricted(candidateUsername)) {
      log("WARN", `[parallel] Skip bootstrap ${candidateUsername.slice(0, 12)}… — compte RESTREINT`);
      continue;
    }

    log("INFO", `[parallel] Tentative bootstrap: ${candidateUsername.slice(0, 12)}…`);
    const result = await bootstrapAccountData(candidateJob, candidateUsername);
    if (result.success && result.ofcList.length > 0) {
      watcherJob = candidateJob;
      watcherUsername = candidateUsername;
      bootstrapResult = result;
      break;
    }
    log("WARN", `[parallel] Bootstrap échoué pour ${candidateUsername.slice(0, 12)}… — ${result.error ?? "aucun OFC"} — essai suivant...`);
  }

  if (!watcherJob || !bootstrapResult) {
    log("ERROR", `[parallel] Bootstrap échoué pour TOUS les comptes (${sortedByTier.length}) — watcher non démarré`);
    log("ERROR", `[parallel] Attente re-login — le relogin loop relancera le watcher`);
    return false;
  }

  // Résoudre le proxy du watcher élu
  let watcherProxy: string | undefined;
  if (watcherJob.hunterConfig.useResidentialProxy) {
    const { resolveProxyWithFailover } = await import("../usaPortal/accounts-keep-alive.js");
    watcherProxy = await resolveProxyWithFailover(watcherUsername, watcherJob.id, watcherJob.hunterConfig);

    if (!watcherProxy) {
      log("ERROR", `[parallel] ❌ TOUS LES PROXIES DOWN — watcher NON démarré (pas de mode direct)`);
      return false;
    }
    log("INFO", `[parallel] Watcher proxy résolu via resolveProxyWithFailover`);
  }

  const resolvedOfc = bootstrapResult.ofcList[0];
  log("INFO", `[parallel] Bootstrap OK — OFC: ${resolvedOfc.postName} (postUserId: ${resolvedOfc.postUserId})`);

  startOfcWatcher(
    ofcKey,
    resolvedOfc,
    323,
    watcherUsername,
    watcherProxy,
    onSlotDetected,
  );

  // 3. Inscrire TOUS les dossiers comme subscribers
  for (const job of usaJobs) {
    const username = job.hunterConfig.embassyUsername;

    const { tokenCache: tc } = await import("../usaPortal/usa-http.js");
    const subCached = tc.get(username.toLowerCase());
    const subHasToken = subCached && Date.now() < subCached.expiresAt;

    let subProxy: string | undefined;
    if (subHasToken && job.hunterConfig.useResidentialProxy) {
      const { resolveProxyWithFailover } = await import("../usaPortal/accounts-keep-alive.js");
      subProxy = await resolveProxyWithFailover(username, job.id, job.hunterConfig);
    }

    let subAppDetails = bootstrapResult.appDetails;
    if (subHasToken && username.toLowerCase() !== watcherUsername.toLowerCase()) {
      const subBootstrap = await bootstrapAccountData(job, username);
      if (subBootstrap.appDetails) {
        subAppDetails = subBootstrap.appDetails;
      }
    } else if (!subHasToken && username.toLowerCase() !== watcherUsername.toLowerCase()) {
      subAppDetails = null;
    }

    subscribeToOfcWatcher(ofcKey, {
      jobId: job.id,
      username,
      proxyUrl: subProxy,
      job,
      appDetails: subAppDetails ?? {
        applicantId: bootstrapResult.appDetails?.applicantId ?? "0",
        applicationId: "",
        visaType: bootstrapResult.visaType,
        visaClass: bootstrapResult.visaClass,
      },
      rescheduleYN: job.hunterConfig.rescheduleMode,
      dateFrom: job.hunterConfig.slotDateFrom,
      dateDeadline: job.hunterConfig.slotDateDeadline,
    });
  }

  log("INFO", `[parallel] ✅ Watcher OFC Kinshasa démarré — ${usaJobs.length} subscriber(s)`);
  log("INFO", `[parallel] Status comptes: ${JSON.stringify(getAccountsStatus())}`);
  return true;
}

/**
 * The parallel relogin loop: inscribes new dossiers and re-logins dormant accounts.
 */
export async function startParallelReloginLoop(
  convexUrl: string,
  hunterKey: string,
  alreadyRegisteredUsernames: Set<string>,
  initParallelWatchersFn: () => Promise<void>,
): Promise<void> {
  const { isAccountReadyForRelogin, performScheduledRelogin, getRestTimeRemaining, getSessionsRemainingToday, registerAccountForKeepAlive: registerAccount, getIndependentCooldownRemaining } = await import("../usaPortal/accounts-keep-alive.js");
  const { subscribeToOfcWatcher: subscribeLate, makeOfcKey: makeKey, hasActiveWatcher } = await import("../usaPortal/ofc-watcher.js");

  const lastReloginAttemptAt = new Map<string, number>();
  const MIN_RELOGIN_INTERVAL_MS = 10 * 60_000;

  const registeredUsernames = alreadyRegisteredUsernames;

  while (true) {
    const checkInterval = 3 * 60_000 + Math.random() * 2 * 60_000;
    await new Promise(r => setTimeout(r, checkInterval));

    try {
      // Re-check parallel_watcher_mode
      const currentParallelSetting = await getBotConfigValue("parallel_watcher_mode");
      if (currentParallelSetting !== "1") {
        log("INFO", `[parallel-relogin] ⛔ Mode parallèle désactivé via bot-config (parallel_watcher_mode=${currentParallelSetting ?? "null"}) — arrêt de la boucle.`);
        const stopOfcKey = makeKey("usa", "Kinshasa", 323);
        if (hasActiveWatcher(stopOfcKey)) {
          const { stopOfcWatcher } = await import("../usaPortal/ofc-watcher.js");
          stopOfcWatcher(stopOfcKey);
          log("INFO", `[parallel-relogin] 🛑 OFC Watcher arrêté.`);
        }
        break;
      }

      // Auto-retry watcher
      const watcherOfcKey = makeKey("usa", "Kinshasa", 323);
      if (!hasActiveWatcher(watcherOfcKey)) {
        log("INFO", `[parallel-relogin] 🔄 Pas de watcher actif — retenter initParallelWatchers...`);
        await initParallelWatchersFn();
        if (hasActiveWatcher(watcherOfcKey)) {
          log("INFO", `[parallel-relogin] ✅ Watcher démarré avec succès au retry`);
        }
      }

      const jobs = await getActiveJobs();
      const usaJobs = jobs.filter(j =>
        j.destination === "usa" &&
        j.hunterConfig?.isActive === true &&
        !pausedJobs.has(j.id) &&
        !completedJobs.has(j.id) &&
        !!j.portalUrl
      );

      for (const job of usaJobs) {
        const username = job.hunterConfig.embassyUsername;
        const key = username.toLowerCase();

        // ── Auto-inscription ──
        if (!registeredUsernames.has(key)) {
          log("INFO", `[parallel-relogin] 🆕 Nouveau dossier détecté: ${username.slice(0, 12)}… — inscription keep-alive + watcher`);
          const registered = await registerAccount(job);
          if (registered) {
            registeredUsernames.add(key);
            const ofcKey = makeKey("usa", "Kinshasa", 323);
            if (hasActiveWatcher(ofcKey)) {
              let subProxy: string | undefined;
              if (job.hunterConfig.useResidentialProxy) {
                const { resolveProxyWithFailover } = await import("../usaPortal/accounts-keep-alive.js");
                subProxy = await resolveProxyWithFailover(username, job.id, job.hunterConfig);
              }

              const { bootstrapAccountData } = await import("../usaPortal/parallel-bootstrap.js");
              const bootResult = await bootstrapAccountData(job, username);

              subscribeLate(ofcKey, {
                jobId: job.id,
                username,
                proxyUrl: subProxy,
                job,
                appDetails: bootResult.appDetails ?? {
                  applicantId: "0",
                  applicationId: "",
                  visaType: bootResult.visaType || "NIV",
                  visaClass: bootResult.visaClass || "",
                },
                rescheduleYN: job.hunterConfig.rescheduleMode,
                dateFrom: job.hunterConfig.slotDateFrom,
                dateDeadline: job.hunterConfig.slotDateDeadline,
              });
              log("INFO", `[parallel-relogin] ✅ ${username.slice(0, 12)}… inscrit au watcher OFC Kinshasa`);
            } else {
              log("INFO", `[parallel-relogin] 🚀 Aucun watcher actif — lancement avec ${username.slice(0, 12)}…`);
              await initParallelWatchersFn();
            }
          }
          continue;
        }

        // ── Rotation + re-login ────────────
        const restTime = getRestTimeRemaining(username);
        const sessionsLeft = getSessionsRemainingToday(username);
        
        if (restTime > 0) {
          continue;
        }
        
        if (sessionsLeft <= 0) {
          continue;
        }

        if (isAccountReadyForRelogin(username)) {
          const lastAttempt = lastReloginAttemptAt.get(key) ?? 0;
          const timeSinceLastAttempt = Date.now() - lastAttempt;
          if (timeSinceLastAttempt < MIN_RELOGIN_INTERVAL_MS) {
            const waitMin = Math.round((MIN_RELOGIN_INTERVAL_MS - timeSinceLastAttempt) / 60_000);
            log("INFO", `[parallel-relogin] ⏱️ ${username.slice(0, 12)}… — safety net: attente ${waitMin}min (min 10min entre tentatives)`);
            continue;
          }

          lastReloginAttemptAt.set(key, Date.now());

          log("INFO", `[parallel-relogin] 🔑 ${username.slice(0, 12)}… prêt pour re-login (cooldown terminé, ${sessionsLeft} sessions restantes)`);
          const success = await performScheduledRelogin(username);
          if (success) {
            log("INFO", `[parallel-relogin] ✅ ${username.slice(0, 12)}… re-login réussi`);

            const ofcKey = makeKey("usa", "Kinshasa", 323);
            if (!hasActiveWatcher(ofcKey)) {
              log("INFO", `[parallel-relogin] 🚀 Aucun watcher actif — lancement avec ${username.slice(0, 12)}… (post re-login)`);
              await initParallelWatchersFn();
            } else if (hasActiveWatcher(ofcKey)) {
              try {
                const { bootstrapAccountData } = await import("../usaPortal/parallel-bootstrap.js");
                const bootResult = await bootstrapAccountData(job, username);
                if (bootResult.success && bootResult.appDetails) {
                  let rebootProxy: string | undefined;
                  if (job.hunterConfig.useResidentialProxy) {
                    const { resolveProxyWithFailover } = await import("../usaPortal/accounts-keep-alive.js");
                    rebootProxy = await resolveProxyWithFailover(username, job.id, job.hunterConfig);
                  }
                  subscribeLate(ofcKey, {
                    jobId: job.id,
                    username,
                    proxyUrl: rebootProxy,
                    job,
                    appDetails: bootResult.appDetails,
                    rescheduleYN: job.hunterConfig.rescheduleMode,
                    dateFrom: job.hunterConfig.slotDateFrom,
                    dateDeadline: job.hunterConfig.slotDateDeadline,
                  });
                  log("INFO", `[parallel-relogin] 🔄 ${username.slice(0, 12)}… re-bootstrap OK — subscriber mis à jour`);
                }
              } catch (bootErr) {
                log("WARN", `[parallel-relogin] ⚠️ Re-bootstrap échoué pour ${username.slice(0, 12)}…: ${bootErr}`);
              }
            }
          } else {
            log("WARN", `[parallel-relogin] ⏳ ${username.slice(0, 12)}… re-login refusé (cooldown/restriction en cours)`);
          }
          // Radio silence entre re-logins
          const silence = 2 * 60_000 + Math.random() * 2 * 60_000;
          await new Promise(r => setTimeout(r, silence));
        }
      }
    } catch (err) {
      log("WARN", `[parallel-relogin] Erreur: ${err}`);
    }
  }
}
