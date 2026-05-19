// Build trigger 19/05/2026 09:47
import * as dotenv from "dotenv";
dotenv.config();

import { getActiveJobs, sendHeartbeat, getPendingBotTest, type HunterJob, loadCevBookingConfig, getBotConfigValue } from "./convexClient.js";
import { runHunterSession, runBotTestSession, type SessionResult } from "./navigator.js";
import { runCevCheck } from "./cevBooking.js";
import { setCevDiscoveredConfig } from "./cevHttpBooking.js";
import { proxyPool } from "./browser.js";
import { detectPublicIp } from "./proxyPool.js";
import { autoWhitelistIp } from "./ip-whitelist.js";
import { runSpainSession } from "./spainPortal.js";

// ─── Extracted modules ──────────────────────────────────────────────────────
import { startCevSetupLoop } from "./loops/cev-setup-loop.js";
import { startCevPollingLoop } from "./loops/cev-polling-loop.js";
import { startSpainWatcherLoop } from "./loops/spain-watcher-loop.js";
import { startV3Loop } from "./loops/v3-loop.js";
import { initParallelWatchers, startParallelReloginLoop } from "./loops/parallel-loop.js";
import { checkPortalBundleKey } from "./bundle-check.js";

import {
  log,
  isParallelMode,
  isV3Mode,
  setIsV3Mode,
  formatMs,
  isRushHour,
  generateIntervalMs,
  shouldSkipCycle,
  staggerInitialSchedules,
  findNextDueJob,
  findNextDueJobSoon,
  getNextCheckDue,
  getTimeUntilNextDue,
  SILENCE_RADIO_MIN_MS,
  SILENCE_RADIO_MAX_MS,
  SILENCE_RADIO_SAME_TIER_MIN_MS,
  SILENCE_RADIO_SAME_TIER_MAX_MS,
  RUSH_SILENCE_MIN_MS,
  RUSH_SILENCE_MAX_MS,
  MAX_LOGIN_FAILURES,
} from "./scheduler-utils.js";

import {
  pausedJobs,
  scheduledNextDue,
  syncAdminResets,
  handleResult,
  applyRadioSilence,
} from "./scheduler-state.js";

// ─── Main orchestrator ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const convexUrl = process.env.CONVEX_SITE_URL;
  const hunterKey = process.env.HUNTER_API_KEY;

  log("INFO", "=== Joventy Hunter démarrage (Joventy Shuffle v2) ===");
  log("INFO", `Mode: ${dryRun ? "DRY RUN" : "PRODUCTION"}`);
  log("INFO", `Convex: ${convexUrl ? "configuré" : "MANQUANT"}`);
  log("INFO", `Hunter API Key: ${hunterKey ? "configurée" : "MANQUANTE"}`);

  // Lancer les boucles background
  startCevSetupLoop().catch((err) => {
    console.error("[CEV-SETUP] Boucle crashée:", err);
  });

  startCevPollingLoop().catch((err) => {
    console.error("[CEV-POLL] Boucle crashée:", err);
  });

  startSpainWatcherLoop().catch((err) => {
    console.error("[SPAIN-WATCHER] Boucle crashée:", err);
  });

  // ─── Auto-config CEV ─────
  try {
    const savedConfig = await loadCevBookingConfig();
    if (savedConfig) {
      setCevDiscoveredConfig(savedConfig);
      log("INFO", `CEV auto-config chargée ✅ — endpoint=${savedConfig.submitEndpoint} successCount=${savedConfig.successCount}`);
    } else {
      log("INFO", "CEV auto-config: aucune config sauvegardée — discovery complète au premier booking");
    }
  } catch (err) {
    log("WARN", `CEV auto-config: chargement échoué (non bloquant) — ${err}`);
  }

  // Détection IP + initialisation ProxyPool
  const serverIp = await detectPublicIp();
  if (serverIp) {
    log("INFO", `IP serveur (Railway): ${serverIp}`);

    const whitelistResult = await autoWhitelistIp(serverIp);
    if (whitelistResult.iproyal.ok) {
      log("INFO", `IPRoyal whitelist: ✅ ${whitelistResult.iproyal.message}`);
    } else {
      log("WARN", `IPRoyal whitelist: ❌ ${whitelistResult.iproyal.message}`);
    }
    if (whitelistResult.twocaptcha.ok) {
      log("INFO", `2Captcha whitelist: ✅ ${whitelistResult.twocaptcha.message}`);
    } else {
      log("WARN", `2Captcha whitelist: ❌ ${whitelistResult.twocaptcha.message}`);
    }

    if (process.env.TWOCAPTCHA_API_KEY) {
      await proxyPool.initialize(serverIp);
    }
  } else {
    log("WARN", "IP serveur: indéterminée (ipify.org inaccessible)");
  }

  const brightdataStatus = process.env.BRIGHTDATA_PROXY_URL ? "BrightData ✅ (CEV belge)" : null;
  const iproyalStatus    = process.env.IPROYAL_PROXY_URL    ? "iProyal ✅ (Espagne)"      : null;
  const fallbackStatus   = proxyPool.isConfigured
    ? `2captcha gateway ✅ (eu.proxy.2captcha.com:2334 — auth user:pass, region=cd)`
    : process.env.PROXY_URL
      ? "statique (PROXY_URL)"
      : "aucun ⚠️ — IP fixe Railway exposée";
  const proxyStatus = [brightdataStatus, iproyalStatus, fallbackStatus].filter(Boolean).join(" | ");
  log("INFO", `Proxy: ${proxyStatus}`);
  log("INFO", "Intervalles tier — tres_urgent:5-10m (rush:3-4m)  urgent:15-20m  prioritaire:25-35m  standard:45-60m");
  log("INFO", `Silence radio: normal ${formatMs(SILENCE_RADIO_MIN_MS)}–${formatMs(SILENCE_RADIO_MAX_MS)} | stagger ${formatMs(SILENCE_RADIO_SAME_TIER_MIN_MS)}–${formatMs(SILENCE_RADIO_SAME_TIER_MAX_MS)} | rush ${formatMs(RUSH_SILENCE_MIN_MS)}–${formatMs(RUSH_SILENCE_MAX_MS)}`);
  log("INFO", `Rush windows Kinshasa (UTC+1): 00h-02h | 07h-09h | 12h-14h — actif maintenant: ${isRushHour() ? "OUI ⚡" : "non"}`);
  log("INFO", `Auto-pause après: ${MAX_LOGIN_FAILURES} login_failed consécutifs`);

  if (isParallelMode) {
    log("INFO", `═══════════════════════════════════════════════════════════════`);
    log("INFO", `🔀 MODE PARALLÈLE DÉTECTÉ (PARALLEL_WATCHER_MODE=1)`);
    log("INFO", `   → Scheduler séquentiel: CEV + Espagne + bundle check UNIQUEMENT`);
    log("INFO", `   → Jobs USA: polling délégué au OFC Watcher partagé`);
    log("INFO", `   → Stagger désactivé (inutile avec watcher centralisé)`);
    log("INFO", `═══════════════════════════════════════════════════════════════`);
  }

  // ─── Statut solveurs hCaptcha CEV ────────────────────────────────────────
  const antiCaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const capsolverKey   = process.env.CAPSOLVER_API_KEY;
  const twoCaptchaKey  = process.env.TWOCAPTCHA_API_KEY;
  
  log("INFO", [
    "CEV hCaptcha solveurs:",
    antiCaptchaKey ? "AntiCaptcha ✅" : "AntiCaptcha ❌ (ANTICAPTCHA_API_KEY absent — REQUIS pour domaines gov)",
    capsolverKey   ? "CapSolver ✅ (sitekey gov blacklistée en 2026-04 — peut échouer)" : "CapSolver ❌",
    twoCaptchaKey  ? "2captcha ✅ (hCaptcha non supporté sur ce compte)" : "2captcha ❌",
  ].join(" | "));

  if (!convexUrl || !hunterKey) {
    log("ERROR", "CONVEX_SITE_URL et HUNTER_API_KEY sont requis — arrêt");
    process.exit(1);
  }

  // ─── MODE SELECTION : V3 > Parallèle > Séquentiel ──────────────────────────
  let v3Mode = false;
  let parallelMode = false;

  try {
    const v3Value = await getBotConfigValue("v3_mode");
    v3Mode = v3Value === "1";
    setIsV3Mode(v3Mode);
    if (v3Mode) {
      log("INFO", "[v3] ✅ Mode V3 Chasseur activé via bot-config Convex (v3_mode=1)");
    }
  } catch {
    // Convex inaccessible
  }

  // ── Redis: restaurer les sessions persistées ──
  const { initTokenCacheRedis, disconnectRedis } = await import("./usaPortal/token-cache-redis.js");
  const restoredSessions = await initTokenCacheRedis();
  if (restoredSessions > 0) {
    log("INFO", `[redis-cache] 🔑 ${restoredSessions} session(s) restaurée(s) — re-login évité`);
  }

  const { initRestrictionRedis } = await import("./usaPortal/account-restriction.js");
  const restoredRestrictions = await initRestrictionRedis();
  if (restoredRestrictions > 0) {
    log("INFO", `[redis-cache] 🔒 ${restoredRestrictions} restriction(s) restaurée(s) — re-login évité pour comptes restreints`);
  }

  // ── V3 Chasseur init ──
  const { initV3 } = await import("./v3/index.js");
  await initV3(convexUrl, hunterKey);

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    log("INFO", `[shutdown] Signal ${signal} reçu — flush Redis...`);
    await disconnectRedis();
    process.exit(0);
  };
  process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });
  process.on("SIGINT", () => { gracefulShutdown("SIGINT"); });

  if (!v3Mode) {
    try {
      const convexValue = await getBotConfigValue("parallel_watcher_mode");
      parallelMode = convexValue === "1";
      if (parallelMode) {
        log("INFO", "[parallel] Mode parallèle activé via bot-config Convex (parallel_watcher_mode=1)");
      } else {
        parallelMode = process.env.PARALLEL_WATCHER_MODE === "1";
        if (parallelMode) {
          log("INFO", "[parallel] Mode parallèle activé via env PARALLEL_WATCHER_MODE=1 (fallback)");
        }
      }
    } catch {
      parallelMode = process.env.PARALLEL_WATCHER_MODE === "1";
      if (parallelMode) {
        log("WARN", "[parallel] Convex inaccessible — fallback sur env PARALLEL_WATCHER_MODE=1");
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE V3 CHASSEUR
  // ═══════════════════════════════════════════════════════════════════════════
  if (v3Mode) {
    log("INFO", "═══════════════════════════════════════════════════════════════");
    log("INFO", "🎯 MODE V3 CHASSEUR ACTIVÉ (v3_mode=1)");
    log("INFO", "   → runScanSession complet : login → preflight → multi-mois → booking → discovery");
    log("INFO", "   → Intervalles pilotés par scan-orchestrator (rush/standard/night/burst)");
    log("INFO", "═══════════════════════════════════════════════════════════════");

    startV3Loop(convexUrl!, hunterKey!).catch(err => {
      log("ERROR", `[v3-loop] Fatal: ${err}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE PARALLÈLE
  // ═══════════════════════════════════════════════════════════════════════════
  if (parallelMode && !v3Mode) {
    log("INFO", "═══════════════════════════════════════════════════════════════");
    log("INFO", "🚀 MODE PARALLÈLE ACTIVÉ (PARALLEL_WATCHER_MODE=1)");
    log("INFO", "   → OFC Watcher partagé + Booking Race + Keep-Alive per-account");
    log("INFO", "═══════════════════════════════════════════════════════════════");

    const alreadyRegisteredUsernames = new Set<string>();

    const doInitParallelWatchers = async () => {
      await initParallelWatchers(convexUrl!, hunterKey!, alreadyRegisteredUsernames);
    };

    doInitParallelWatchers().catch(err => {
      log("ERROR", `[parallel] Erreur initialisation watchers: ${err}`);
    });

    startParallelReloginLoop(convexUrl!, hunterKey!, alreadyRegisteredUsernames, doInitParallelWatchers).catch(err => {
      log("ERROR", `[parallel-relogin] Fatal: ${err}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEGACY SCHEDULER LOOP
  // ═══════════════════════════════════════════════════════════════════════════
  while (true) {
    try {
      const pendingTest = await getPendingBotTest();
      if (pendingTest) {
        log("INFO", `🧪 Test bot détecté — ${pendingTest.destination} (${pendingTest.portalUrl})`);
        try {
          await runBotTestSession(pendingTest);
          log("INFO", `🧪 Test bot terminé — ${pendingTest.destination}`);
        } catch (err) {
          log("ERROR", `Erreur test bot ${pendingTest.destination}: ${err}`);
        }
        continue;
      }
    } catch (err) {
      log("WARN", `Vérification pending tests échouée (non critique): ${err}`);
    }

    let jobs: HunterJob[];
    try {
      jobs = await getActiveJobs();
    } catch (err) {
      log("ERROR", `Échec récupération jobs: ${err} — retry dans 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }

    syncAdminResets(jobs);

    if (!isParallelMode && !isV3Mode) {
      staggerInitialSchedules(jobs);
    }

    await checkPortalBundleKey(jobs);

    const legacyJobs = (parallelMode || v3Mode)
      ? jobs.filter(j => j.destination !== "usa")
      : jobs;

    const due = findNextDueJob(legacyJobs);

    if (!due) {
      const waitMs = getTimeUntilNextDue(jobs);
      const usaExcluded = isParallelMode || isV3Mode;
      const activeCount = jobs.filter((j) =>
        !pausedJobs.has(j.id) && j.hunterConfig?.isActive &&
        !(usaExcluded && (j.destination === "usa" || (!j.destination || j.destination === "")))
      ).length;

      if (activeCount === 0) {
        if (v3Mode) {
          log("INFO", "Scheduler séquentiel idle — jobs USA gérés par V3 Chasseur — polling dans 90s");
        } else if (isParallelMode) {
          log("INFO", "Scheduler séquentiel idle — jobs USA gérés par OFC Watcher — polling dans 90s");
        } else {
          log("INFO", "Aucun dossier actif — polling dans 90s");
        }
      } else {
        const tierCounts = jobs
          .filter((j) =>
            !pausedJobs.has(j.id) && j.hunterConfig?.isActive &&
            !(usaExcluded && (j.destination === "usa" || (!j.destination || j.destination === "")))
          )
          .reduce<Record<string, number>>((acc, j) => {
            acc[j.urgencyTier] = (acc[j.urgencyTier] ?? 0) + 1;
            return acc;
          }, {});
        const tierStr = Object.entries(tierCounts).map(([t, n]) => `${n}×${t}`).join(", ");
        log("INFO", `Aucun dossier dû (${tierStr}) — prochain check dans ${formatMs(waitMs)}`);
      }

      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const overdueMs = Date.now() - getNextCheckDue(due);
    const overdueStr = overdueMs > 0 ? ` (+${formatMs(overdueMs)} de retard)` : "";
    log("INFO", `▶ [${due.applicantName}] Check ${due.urgencyTier}${overdueStr}`);

    if (shouldSkipCycle(due.urgencyTier)) {
      log("INFO", `[${due.applicantName}] 💭 Skip aléatoire (humain distrait) — cycle ignoré`);
      const skipInterval = generateIntervalMs(due.urgencyTier);
      scheduledNextDue.set(due.id, Date.now() + skipInterval);
      log("INFO", `[${due.applicantName}] Prochain check dans ${formatMs(skipInterval)}`);
      await new Promise((r) => setTimeout(r, 5_000 + Math.random() * 10_000));
      continue;
    }

    let result: SessionResult;
    try {
      if (due.destination === "schengen") {
        const cevResult = await runCevCheck(due);
        result = cevResult === "slot_found" ? "slot_found"
               : cevResult === "error"      ? "error"
               : "not_found";
      } else if (due.destination === "spain" || due.destination === "espagne" || due.destination === "es") {
        const spainUrl = due.portalUrl ?? (due.hunterConfig as { scheduleUrl?: string } | undefined)?.scheduleUrl ?? "";
        if (!spainUrl) {
          log("WARN", `[${due.applicantName}] ⚠️ Espagne — URL Bookitit manquante. Renseignez-la dans la config Hunter admin.`);
          await sendHeartbeat({ applicationId: due.id, result: "error", errorMessage: "URL Bookitit Espagne manquante — configurez scheduleUrl dans le panneau admin" });
          result = "error";
        } else {
          log("INFO", `[${due.applicantName}] 🇪🇸 Espagne → ${spainUrl}`);
          result = await runSpainSession(due);
        }
      } else {
        result = await runHunterSession(due);
      }
    } catch (err) {
      result = "error";
      log("ERROR", `[${due.applicantName}] Erreur session non capturée: ${err}`);
    }

    await handleResult(due, result);

    if (result !== "slot_found") {
      const nextJob = findNextDueJobSoon(jobs, due.urgencyTier);
      const sameTierNext = !!nextJob;
      applyRadioSilence(due.id, sameTierNext);
    }

    await new Promise((r) => setTimeout(r, 5_000));
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
