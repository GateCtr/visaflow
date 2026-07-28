// Build trigger 25/05/2026 03:15 — CEV Dossier v3 + getActiveCevSessions fix
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config();
if (fs.existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: true });
}
const subEnv = path.join("artifacts", "slot-hunter", ".env");
if (fs.existsSync(subEnv)) {
  dotenv.config({ path: subEnv, override: true });
}
const subEnvLocal = path.join("artifacts", "slot-hunter", ".env.local");
if (fs.existsSync(subEnvLocal)) {
  dotenv.config({ path: subEnvLocal, override: true });
}

import { getActiveJobs, sendHeartbeat, getPendingBotTest, type HunterJob, loadCevBookingConfig, getBotConfigValue, uploadFile, reportSlotFound, reportSlotDiscovery } from "./convexClient.js";
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
import { startCevStealthLoop } from "./loops/cev-stealth-loop.js";
import { startCevDossierLoop } from "./loops/cev-dossier-loop.js";
import { startSpainWatcherLoop } from "./loops/spain-watcher-loop.js";
import { startGermanyLoop } from "./loops/germany-loop.js";
import { startV3Loop } from "./loops/v3-loop.js";
import { initParallelWatchers, startParallelReloginLoop } from "./loops/parallel-loop.js";
import { checkPortalBundleKey } from "./bundle-check.js";
import { startDailyReportLoop } from "./daily-report.js";
import { startSessionWorker } from "./sessionWorker.js";

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
  completedJobs,
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
  // ─── MODE CEV : priorité Dossier v3 > Stealth v2 > classique ───
  let cevDossierMode = false;
  let cevStealthMode = false;
  try {
    const dossierValue = await getBotConfigValue("cev_dossier_mode");
    cevDossierMode = dossierValue === "1";
    if (!cevDossierMode) {
      const stealthValue = await getBotConfigValue("cev_stealth_mode");
      cevStealthMode = stealthValue === "1";
    }
  } catch { /* Convex inaccessible — fallback normal */ }

  // ─── SESSION WORKER (F5 Cookie Siphon) : DESACTIVÉ, capturé par chaque compte!
  if (cevDossierMode || cevStealthMode) {
    // PAS DE SESSION WORKER — chaque compte capture ses propres cookies!
    log("INFO", "═══ PAS DE SESSION WORKER (cookies par compte) ═══");
    log("INFO", "   → Chaque compte capture ses propres cookies F5");
    log("INFO", "   → Cookies stockés dans hunterConfig de chaque application");
    
    if (cevDossierMode) {
      log("INFO", "═══ CEV DOSSIER MODE v3 ACTIF ═══");
      log("INFO", "   → Multi-comptes via Applications ");
      log("INFO", "   → Stealth v2 et loops classiques DESACTIVES");
      log("INFO", "   → Cookies frais capturés par chaque compte, toutes les 30min");
      log("INFO", "   → Desactiver: bot-config Convex cev_dossier_mode = 0");
      startCevDossierLoop().catch((err) => {
        console.error("[CEV-DOSSIER-v3] Boucle crashée:", err);
      });
    } else if (cevStealthMode) {
      log("INFO", "═══ CEV STEALTH MODE v2 ACTIF ═══");
      log("INFO", "   → Loops CEV classiques (setup + polling) DESACTIVES");
      log("INFO", "   → Strategie: Login → 3 checks (30s) → destroy → sleep 3-4 min → repeat");
      log("INFO", "   → Desactiver: bot-config Convex cev_stealth_mode = 0");
      startCevStealthLoop().catch((err) => {
        console.error("[CEV-STEALTH] Boucle crashée:", err);
      });
    }
  } else {
    // Mode classique (pas de sessionWorker)
    startCevSetupLoop().catch((err) => {
      console.error("[CEV-SETUP] Boucle crashée:", err);
    });

    startCevPollingLoop().catch((err) => {
      console.error("[CEV-POLL] Boucle crashée:", err);
    });
  }

  startSpainWatcherLoop().catch((err) => {
    console.error("[SPAIN-WATCHER] Boucle crashée:", err);
  });

  startGermanyLoop().catch((err) => {
    console.error("[GERMANY-RKTERMIN] Boucle crashée:", err);
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
  const decodoStatus     = process.env.DECODO_PROXY_URL     ? "Decodo ✅ (Espagne HTTP)"  : null;
  const fallbackStatus   = proxyPool.isConfigured
    ? `2captcha gateway ✅ (eu.proxy.2captcha.com:2334 — auth user:pass, region=cd)`
    : process.env.PROXY_URL
      ? "statique (PROXY_URL)"
      : "aucun ⚠️ — IP fixe Railway exposée";
  const proxyStatus = [brightdataStatus, iproyalStatus, decodoStatus, fallbackStatus].filter(Boolean).join(" | ");
  log("INFO", `Proxy: ${proxyStatus}`);
  log("INFO", "Intervalles tier — tres_urgent:5-10m (rush:3-4m)  urgent:15-20m  prioritaire:25-35m  standard:45-60m");
  log("INFO", `Silence radio: normal ${formatMs(SILENCE_RADIO_MIN_MS)}–${formatMs(SILENCE_RADIO_MAX_MS)} | stagger ${formatMs(SILENCE_RADIO_SAME_TIER_MIN_MS)}–${formatMs(SILENCE_RADIO_SAME_TIER_MAX_MS)} | rush ${formatMs(RUSH_SILENCE_MIN_MS)}–${formatMs(RUSH_SILENCE_MAX_MS)}`);
  log("INFO", `Rush windows Kinshasa (UTC+1): 00h-02h | 07h-09h | 12h-14h — actif maintenant: ${isRushHour() ? "OUI ⚡" : "non"}`);
  log("INFO", `Auto-pause après: ${MAX_LOGIN_FAILURES} login_failed consécutifs`);

  // ─── Rapport quotidien automatique (23h00 Kinshasa) ────────────────────────
  startDailyReportLoop();

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

    let runScanSession: any, getNextScanDecision: any, getCurrentPredictionScore: any, getCompetitionMedianMs: any, resolveAccountRole: any, extractBudgetFromConfig: any, getRemainingLogins: any, tokenCache: any, setUsaSessionProxy: any, getUsaSession: any, pollBlindBookingEvents: any, attemptBlindBooking: any;
    try {
      ({ runScanSession } = await import("./v3/scan/scan-session.js"));
      ({ getNextScanDecision } = await import("./v3/scan/scan-orchestrator.js"));
      ({ getCurrentPredictionScore, getCompetitionMedianMs } = await import("./v3/intelligence/prediction-engine.js"));
      ({ resolveAccountRole, extractBudgetFromConfig } = await import("./v3/admin/config-schema.js"));
      ({ getRemainingLogins } = await import("./v3/core/session-pool.js"));
      ({ tokenCache, setUsaSessionProxy } = await import("./usaPortal/usa-http.js"));
      ({ getUsaSession } = await import("./usaPortal/usa-session.js"));
      ({ pollBlindBookingEvents, attemptBlindBooking } = await import("./v3/booking/booking-blind.js"));
    } catch (importErr) {
      log("ERROR", `[v3] ❌ CRASH à l'import des modules V3: ${importErr}`);
      log("ERROR", `[v3] Stack: ${importErr instanceof Error ? importErr.stack : String(importErr)}`);
      log("ERROR", `[v3] V3 mode désactivé — fallback mode séquentiel`);
      v3Mode = false;
      setIsV3Mode(false);
    }

    // Boucle V3 — tourne en continu pour les dossiers USA actifs
    const v3Loop = async () => {
      while (true) {
        // Re-check v3_mode à chaque cycle (admin peut désactiver à chaud)
        const currentV3Setting = await getBotConfigValue("v3_mode").catch(() => null);
        if (currentV3Setting !== "1") {
          log("INFO", "[v3-loop] ⛔ v3_mode désactivé via bot-config — arrêt de la boucle V3.");
          break;
        }

        let jobs: HunterJob[];
        try {
          jobs = await getActiveJobs();
        } catch (err) {
          log("ERROR", `[v3-loop] Échec récupération jobs: ${err} — retry dans 30s`);
          await new Promise(r => setTimeout(r, 30_000));
          continue;
        }

        const usaJobs = jobs.filter(j =>
          j.destination === "usa" &&
          j.hunterConfig?.isActive === true &&
          !pausedJobs.has(j.id) &&
          !completedJobs.has(j.id) &&
          !!j.hunterConfig.embassyUsername  // USA n'a pas de portalUrl (URL fixe usvisaappt.com)
        );

        if (usaJobs.length === 0) {
          // DEBUG: Loguer pourquoi aucun job n'est trouvé
          const allUsaRaw = jobs.filter(j => j.destination === "usa");
          const reasons = allUsaRaw.map(j => {
            if (!j.hunterConfig?.isActive) return `${j.applicantName}: inactive`;
            if (pausedJobs.has(j.id)) return `${j.applicantName}: paused`;
            if (completedJobs.has(j.id)) return `${j.applicantName}: completed`;
            if (!j.hunterConfig.embassyUsername) return `${j.applicantName}: no embassyUsername`;
            return `${j.applicantName}: SHOULD BE ACTIVE (?)`;
          });
          log("INFO", `[v3-loop] Aucun dossier USA actif — polling dans 60s (total USA bruts: ${allUsaRaw.length}, raisons: ${reasons.join(" | ")})`);
          await new Promise(r => setTimeout(r, 60_000));
          continue;
        }

        // Trier par urgence
        const sortedJobs = [...usaJobs].sort((a, b) => {
          const tiers: Record<string, number> = { tres_urgent: 0, urgent: 1, prioritaire: 2, standard: 3 };
          return (tiers[a.urgencyTier] ?? 3) - (tiers[b.urgencyTier] ?? 3);
        });

        // Log les jobs trouvés et leurs rôles à chaque tick
        const rolesStr = sortedJobs.map(j => `${j.applicantName}(${resolveAccountRole(j.hunterConfig as any)})`).join(", ");
        log("INFO", `[v3-loop] ${sortedJobs.length} job(s) USA actifs: ${rolesStr}`);

        // ── RESET BUDGET ADMIN ──────────────────────────────────────────────
        // Vérifie si l'admin a demandé un reset de budget pour un des comptes actifs.
        // Clé bot-config : "reset_budget:<username>" = "7" (valeur = nouveau budget max)
        // Après reset : écrase la clé avec "done" pour signaler la consommation.
        for (const job of sortedJobs) {
          const uname = job.hunterConfig.embassyUsername;
          if (!uname) continue;
          try {
            const resetVal = await getBotConfigValue(`reset_budget:${uname}`).catch(() => null);
            if (resetVal && resetVal !== "done") {
              const newMax = parseInt(resetVal, 10) || 7;
              const { resetBudget } = await import("./v3/core/session-pool.js");
              resetBudget(uname, newMax);
              log("INFO", `[v3-loop] 🔄 Budget reset à ${newMax} pour ${uname} (demande admin)`);
              // Marquer comme consommé via POST bot-config
              try {
                await fetch(`${convexUrl}/hunter/bot-config`, {
                  method: "POST",
                  headers: { "X-Hunter-Key": hunterKey!, "Content-Type": "application/json" },
                  body: JSON.stringify({ key: `reset_budget:${uname}`, value: "done" }),
                });
              } catch { /* non-bloquant */ }
            }
          } catch { /* non-bloquant */ }
        }

        // ═══════════════════════════════════════════════════════════════════
        // FIX: DEUX PASSES — éclaireurs d'abord, confinés ensuite.
        //
        // Problème résolu :
        //   Avant ce fix, la boucle unique triée par urgence traitait les confinés
        //   AVANT l'éclaireur (si plus urgents). Les confinés faisaient pollBlindBookingEvents
        //   → 0 events (le broadcast n'avait pas eu lieu car l'éclaireur n'avait pas scanné).
        //   Au tick suivant (5-10 min plus tard), les events Convex avaient expiré (TTL < 5 min).
        //
        // Solution :
        //   PASSE 1 : Éclaireurs scannent → broadcastSlotDiscovery() émet les events
        //   PASSE 2 : Confinés poll → reçoivent les events fraîchement broadcastés
        // ═══════════════════════════════════════════════════════════════════

        const eclaireurJobs = sortedJobs.filter(j => resolveAccountRole(j.hunterConfig as any) !== "confine");
        const confineJobs = sortedJobs.filter(j => resolveAccountRole(j.hunterConfig as any) === "confine");

        // ── PASSE 1 : ÉCLAIREURS (scan + broadcast) ──────────────────────
        let scannedOne = false;
        for (const job of eclaireurJobs) {
          const username = job.hunterConfig.embassyUsername;
          const role = resolveAccountRole(job.hunterConfig as any);

          // Demander à l'orchestrateur si on doit scanner maintenant
          const cachedEntry = tokenCache.get(username.toLowerCase());
          const hasValidToken = !!(cachedEntry && Date.now() < cachedEntry.expiresAt);
          const remaining = getRemainingLogins(username);

          const decision = getNextScanDecision({
            accountRole: role,
            predictionScore: getCurrentPredictionScore(username),
            competitionMedianMs: getCompetitionMedianMs(username),
            loginsRemaining: remaining,
            hasValidToken,
            scanIntensity: "normal",
            nightMode: job.hunterConfig.nightModeEnabled ? "minimal" : "off",
          });

          if (!decision.shouldScan) {
            // FIX: Deadlock — si pas de token MAIS budget login disponible,
            // forcer le scan pour que runScanSession puisse faire le login.
            // Sans ça: pas de token → shouldScan=false → pas de login → pas de token → ∞
            if (!hasValidToken && remaining > 0) {
              log("INFO", `[v3-loop] 🔑 ${job.applicantName} — pas de token mais budget disponible (${remaining} logins restants) → forcer login`);
            } else {
              continue;
            }
          }

          log("INFO", `[v3-loop] ▶ ${job.applicantName} — ${decision.reason} (phase: ${decision.phase}, interval: ${Math.round(decision.intervalMs / 1000)}s)`);

          // Lancer la session V3 complète
          const outcome = await runScanSession({
            jobId: job.id,
            hunterConfig: job.hunterConfig as any,
            existingSession: hasValidToken ? {
              accessToken: cachedEntry!.accessToken,
              refreshToken: cachedEntry!.refreshToken,
              csrfToken: cachedEntry!.csrfToken,
              userID: cachedEntry!.userID,
              fullName: cachedEntry!.fullName,
              applicationId: null,
              pendingAppoStatus: null,
              missionId: 323,
              allowedOfcs: cachedEntry!.allowedOfcs ?? [],
            } : undefined,
            getSession: async (proxyUrl: string | null) => {
              setUsaSessionProxy(proxyUrl ?? undefined);
              const session = await getUsaSession(
                job.hunterConfig.embassyUsername,
                job.hunterConfig.embassyPassword,
                job.hunterConfig.twoCaptchaApiKey,
              );
              setUsaSessionProxy(undefined);
              return session;
            },
            convexSiteUrl: convexUrl!,
            hunterApiKey: hunterKey!,
          });

          log("INFO", `[v3-loop] ✅ ${job.applicantName} — résultat: ${outcome}`);

          if (outcome === "slot_captured") {
            completedJobs.add(job.id);
            pausedJobs.add(job.id);
            await sendHeartbeat({ applicationId: job.id, result: "slot_found" });
          } else if (outcome === "restricted") {
            pausedJobs.add(job.id);
          } else if (outcome === "payment_required") {
            pausedJobs.add(job.id);
            await sendHeartbeat({ applicationId: job.id, result: "payment_required", errorMessage: "Paiement MRV non vérifié" });
          }

          // ── KEEP-ALIVE ENTRE LES SCANS ──────────────────────────────────────
          // Le portail déconnecte après 15 min d'inactivité. L'intervalle entre scans
          // est de 5-10 min (standard) — 2 cycles consécutifs sans activité = 10-20 min = disconnect.
          // Solution : pendant l'attente, pinger getLandingPageDeatils toutes les 8-12 min.
          //
          // FIX 19/05/2026: Si des confinés sont en attente, SKIP le long waitMs pour que
          // PASSE 2 démarre immédiatement après le scan. Le délai de 219s entre détection
          // et tentative venait de ce waitMs (144s) + 5s propagation. Maintenant: 5s seulement.
          // Le keep-alive est maintenu uniquement si PAS de confinés (ou scan sans broadcast).
          const waitMs = Math.max(decision.intervalMs, 30_000);
          const INTER_SCAN_PING_INTERVAL_MS = 8 * 60_000 + Math.random() * 4 * 60_000; // 8-12 min

          // Vérifier si le token est encore valide — si oui, lancer un keep-alive temporaire
          const postScanCache = tokenCache.get(username.toLowerCase());
          const postScanTokenValid = !!(postScanCache && Date.now() < postScanCache.expiresAt);

          // Si des confinés attendent des broadcasts → skip le wait long (PASSE 2 immédiate)
          if (confineJobs.length > 0) {
            // Pas de wait — les confinés doivent tenter le blind booking ASAP
            // Le keep-alive n'est pas nécessaire car le prochain scan sera dans ~30s après PASSE 2
            log("INFO", `[v3-loop] ⚡ Skip waitMs (${Math.round(waitMs / 1000)}s) — ${confineJobs.length} confiné(s) en attente, PASSE 2 immédiate`);
          } else if (postScanTokenValid && waitMs > INTER_SCAN_PING_INTERVAL_MS * 0.8) {
            // L'attente est assez longue pour risquer un timeout portail — pinger
            const { startKeepAlive: startInterScanKA } = await import("./v3/anti-detection/keep-alive.js");
            const interScanKA = startInterScanKA(
              { accessToken: postScanCache!.accessToken, applicationId: cachedEntry?.applicationId ?? null, missionId: 323 } as any,
              job.id,
              { minIntervalMs: 8 * 60_000, maxIntervalMs: 12 * 60_000 },
            );
            // Attendre l'intervalle puis arrêter le keep-alive
            await new Promise(r => setTimeout(r, waitMs));
            interScanKA.stop();
          } else {
            // Attente courte ou pas de token → simple sleep
            await new Promise(r => setTimeout(r, waitMs));
          }

          scannedOne = true;
          break; // Un seul éclaireur par tick (radio silence entre les dossiers)
        }

        // ── PASSE 2 : CONFINÉS (poll blind booking events) ───────────────
        // Exécutée APRÈS la passe éclaireur, donc les events broadcastés sont disponibles.
        // IMPORTANT: On poll TOUJOURS les confinés, même si l'éclaireur n'a pas scanné ce tick.
        // Un broadcast d'un tick précédent peut encore être pending (TTL 5 min dans Convex).
        if (scannedOne && confineJobs.length > 0) {
          // Délai pour laisser le broadcast Convex se propager (fire-and-forget → mutation → commit)
          // 5s pour couvrir la latence réseau + exécution mutation Convex
          await new Promise(r => setTimeout(r, 5_000));
          log("INFO", `[v3-loop] 📡 PASSE 2 — polling ${confineJobs.length} confiné(s) après scan éclaireur`);
        } else if (confineJobs.length > 0) {
          // Pas de scan éclaireur ce tick, mais on poll quand même (events d'un tick précédent)
          log("INFO", `[v3-loop] 📡 PASSE 2 — polling ${confineJobs.length} confiné(s) (éclaireur non éligible ce tick)`);
        }

        for (const job of confineJobs) {
          const username = job.hunterConfig.embassyUsername;
          try {
            const events = await pollBlindBookingEvents(username, convexUrl!, hunterKey!);
            log("INFO", `[v3-loop] 🔍 ${job.applicantName} (confiné) poll → ${events.length} event(s) pending`);
            if (events.length > 0) {
              log("INFO", `[v3-loop] 📡 ${job.applicantName} (confiné) — ${events.length} blind booking(s) reçu(s)`);

              // ── FIX 19/05/2026: PREFLIGHT UNE SEULE FOIS avant la boucle des events ──
              // Avant : le preflight (resolveApplicationId + runPreflight) était fait pour CHAQUE
              // slotId dans la boucle → 6-12 appels API inutiles, +30s de latence.
              // Après : fait UNE FOIS avant la boucle, réutilisé pour tous les events.

              // 1. Token check + réveil d'urgence (une seule fois)
              let cachedConf = tokenCache.get(username.toLowerCase());
              let hasToken = !!(cachedConf && Date.now() < cachedConf.expiresAt);

              if (!hasToken) {
                const budgetRemaining = getRemainingLogins(username);
                if (budgetRemaining <= 0) {
                  log("WARN", `[v3-loop] ${job.applicantName} (confiné) — SLOT DÉTECTÉ mais budget épuisé (0 logins restants) — impossible de réveiller`);
                  continue;
                }
                log("INFO", `[v3-loop] ⚡ ${job.applicantName} (confiné) — RÉVEIL D'URGENCE ! Slot détecté, login immédiat (budget: ${budgetRemaining} restants)`);
                try {
                  setUsaSessionProxy(undefined);
                  const freshSession = await getUsaSession(
                    job.hunterConfig.embassyUsername,
                    job.hunterConfig.embassyPassword,
                    job.hunterConfig.twoCaptchaApiKey,
                  );
                  setUsaSessionProxy(undefined);
                  if (freshSession) {
                    const { recordLogin } = await import("./v3/core/session-pool.js");
                    recordLogin(username, "emergency");
                    cachedConf = tokenCache.get(username.toLowerCase());
                    hasToken = !!(cachedConf && Date.now() < cachedConf.expiresAt);
                    log("INFO", `[v3-loop] ✅ ${job.applicantName} (confiné) — réveil réussi en urgence, token valide`);
                  } else {
                    log("WARN", `[v3-loop] ${job.applicantName} (confiné) — réveil échoué (login null) — slot perdu`);
                    continue;
                  }
                } catch (loginErr) {
                  log("ERROR", `[v3-loop] ${job.applicantName} (confiné) — réveil échoué: ${loginErr} — slot perdu`);
                  continue;
                }
              }

              if (!hasToken || !cachedConf) {
                log("WARN", `[v3-loop] ${job.applicantName} (confiné) — token toujours invalide après réveil — skip`);
                continue;
              }

              // 2. Preflight UNE SEULE FOIS (résoudre applicantId GSS, applicationId, appointmentId)
              let confAppDetails: { applicantId: string | number; applicationId: string; appointmentId?: number; applicantUUID?: number | string } | null = null;
              try {
                const { checkUsaAppointmentRequestStatus, fetchCancellableSessionIds } = await import("./usaPortal/appointments-api.js");
                const { runPreflight } = await import("./v3/scan/scan-preflight.js");

                const confSession = {
                  accessToken: cachedConf!.accessToken,
                  refreshToken: cachedConf!.refreshToken,
                  csrfToken: cachedConf!.csrfToken ?? "",
                  userID: cachedConf!.userID,
                  fullName: cachedConf!.fullName,
                  applicationId: null as string | null,
                  pendingAppoStatus: null,
                  missionId: 323,
                  allowedOfcs: cachedConf!.allowedOfcs ?? [],
                } as any;

                const reqStatus = await checkUsaAppointmentRequestStatus(confSession, undefined);
                let confApplicationId = reqStatus.applicationId ?? "";

                if (!confApplicationId && reqStatus.status === "cancellable") {
                  await fetchCancellableSessionIds(confSession, { id: job.id, hunterConfig: job.hunterConfig } as any);
                  confApplicationId = confSession.applicationId ?? "";
                }

                if (!confApplicationId) {
                  log("WARN", `[v3-loop] ${job.applicantName} (confiné) — applicationId introuvable — blind booking impossible`);
                  continue;
                }

                const preflight = await runPreflight(confSession, confApplicationId, 323);
                confAppDetails = {
                  applicantId: preflight.appDetails.applicantId,
                  applicationId: confApplicationId,
                  appointmentId: preflight.appDetails.appointmentId,
                  applicantUUID: preflight.appDetails.applicantUUID as number | undefined,
                };
                log("INFO", `[v3-loop] ✅ ${job.applicantName} (confiné) — preflight OK: applicantId=${confAppDetails.applicantId} appId=${confApplicationId}`);
              } catch (preflightErr) {
                log("ERROR", `[v3-loop] ${job.applicantName} (confiné) — preflight échoué: ${preflightErr} — blind booking impossible`);
                continue;
              }

              // 3. Boucle sur les events — tenter chaque slotId sans refaire le preflight
              for (const event of events) {
                const blindResult = await attemptBlindBooking(event, {
                  accessToken: cachedConf!.accessToken,
                  applicationId: confAppDetails.applicationId,
                  applicantId: confAppDetails.applicantId,
                  appointmentId: confAppDetails.appointmentId,
                  applicantUUID: confAppDetails.applicantUUID as number | undefined,
                  missionId: 323,
                  mode: job.hunterConfig.rescheduleMode ? "reschedule" : "schedule",
                  csrfToken: cachedConf!.csrfToken ?? "",
                  existingLocationType: job.hunterConfig.rescheduleMode ? "POST" : undefined,
                });
                if (blindResult.success) {
                  log("INFO", `[v3-loop] 🎉 BLIND BOOKING RÉUSSI — ${job.applicantName} (confiné) — ${event.date} ${event.time}`);

                  reportSlotDiscovery({
                    applicationId: job.id,
                    destination: "usa",
                    office: event.office,
                    dateFound: event.date,
                    timeFound: event.time,
                    outcome: "captured",
                    context: { slotId: event.slotId, via: "blind_booking", sourceUsername: event.sourceUsername },
                    mode: job.hunterConfig.rescheduleMode ? "reschedule" : "schedule",
                  });

                  try {
                    const session = { accessToken: cachedConf!.accessToken, applicationId: confAppDetails.applicationId, missionId: 323, applicantId: confAppDetails.applicantId } as any;
                    const pdf = await (await import("./usaPortal/usa-scan-confirmation.js")).downloadUsaConfirmationPdf(session, confAppDetails.applicationId, blindResult.appointmentId);
                    let pdfStorageId: string | undefined;
                    if (pdf) {
                      pdfStorageId = (await uploadFile(pdf.toString("base64"), "application/pdf")) ?? undefined;
                    }
                    await reportSlotFound({
                      applicationId: job.id,
                      date: event.date,
                      time: event.time,
                      location: `${event.office} — Ambassade USA (blind booking via ${event.sourceUsername.slice(0, 8)}…)`,
                      confirmationCode: blindResult.appointmentId?.toString(),
                      screenshotStorageId: pdfStorageId,
                    });
                  } catch (postErr) {
                    log("WARN", `[v3-loop] ⚠️ Post-booking confiné échoué (non-bloquant): ${postErr}`);
                  }
                  completedJobs.add(job.id);
                  pausedJobs.add(job.id);
                  await sendHeartbeat({ applicationId: job.id, result: "slot_found" });
                  break;
                }
                // Slot pris (409) ou autre échec → tenter le prochain slotId broadcasté
                if (blindResult.statusCode === 409) {
                  log("INFO", `[v3-loop] ⚠️ ${job.applicantName} (confiné) — slot ${event.slotId?.toString().slice(0, 10)}… pris (409) — tentative suivante...`);
                }
              }
            }
          } catch (pollErr) {
            log("WARN", `[v3-loop] Erreur polling confiné ${username.slice(0,8)}…: ${pollErr}`);
          }
        }

        // Si aucun job n'était éligible ce tick
        if (!scannedOne && confineJobs.length === 0) {
          await new Promise(r => setTimeout(r, 30_000));
        } else if (!scannedOne) {
          // Éclaireur pas éligible mais confinés ont été traités — attente courte
          await new Promise(r => setTimeout(r, 15_000));
        }
      }
    };

    // Lancer la boucle V3 en background (non-bloquant — le scheduler séquentiel continue pour CEV/Espagne)
    if (v3Mode) {
      v3Loop().catch(err => {
        log("ERROR", `[v3-loop] Fatal: ${err}`);
      });
    }
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

    // Exclure les jobs Schengen si le mode dossier CEV est activé (éviter conflit)
    const cevDossierModeEnabled = await getBotConfigValue("cev_dossier_mode").catch(() => "0") === "1";
    // Exclure les jobs Espagne si le Spain Watcher HTTP est actif (SPAIN_HTTP_MODE=1)
    // → le watcher gère lui-même le scan + auto-booking pour tous les dossiers Espagne actifs.
    // Laisser le scheduler séquentiel traiter Espagne en parallèle crée une collision :
    // deux implémentations (HTTP watcher vs Playwright runSpainSession) concourent pour
    // le même créneau au même moment.
    const spainWatcherActive = process.env.SPAIN_HTTP_MODE === "1";
    const isSpainDossier = (j: HunterJob) =>
      j.destination === "spain" || j.destination === "espagne" || j.destination === "es";

    const filteredLegacyJobs = legacyJobs.filter(j => {
      if (cevDossierModeEnabled && j.destination === "schengen") return false;
      if (spainWatcherActive && isSpainDossier(j)) return false;
      return true;
    });

    const due = findNextDueJob(filteredLegacyJobs);

    if (!due) {
      const waitMs = getTimeUntilNextDue(jobs);
      const usaExcluded = isParallelMode || isV3Mode;
      const schengenExcluded = cevDossierModeEnabled;
      const activeCount = jobs.filter((j) =>
        !pausedJobs.has(j.id) && j.hunterConfig?.isActive &&
        !(usaExcluded && (j.destination === "usa" || (!j.destination || j.destination === ""))) &&
        !(schengenExcluded && j.destination === "schengen") &&
        !(spainWatcherActive && isSpainDossier(j))
      ).length;

      if (activeCount === 0) {
        if (v3Mode) {
          log("INFO", "Scheduler séquentiel idle — jobs USA gérés par V3 Chasseur — polling dans 90s");
        } else if (isParallelMode) {
          log("INFO", "Scheduler séquentiel idle — jobs USA gérés par OFC Watcher — polling dans 90s");
        } else if (cevDossierModeEnabled && spainWatcherActive) {
          log("INFO", "Scheduler séquentiel idle — jobs Schengen gérés par CEV Dossier Loop, jobs Espagne gérés par Spain Watcher — polling dans 90s");
        } else if (cevDossierModeEnabled) {
          log("INFO", "Scheduler séquentiel idle — jobs Schengen gérés par CEV Dossier Loop — polling dans 90s");
        } else if (spainWatcherActive) {
          log("INFO", "Scheduler séquentiel idle — jobs Espagne gérés par Spain Watcher HTTP — polling dans 90s");
        } else {
          log("INFO", "Aucun dossier actif — polling dans 90s");
        }
      } else {
        const tierCounts = jobs
          .filter((j) =>
            !pausedJobs.has(j.id) && j.hunterConfig?.isActive &&
            !(usaExcluded && (j.destination === "usa" || (!j.destination || j.destination === ""))) &&
            !(schengenExcluded && j.destination === "schengen") &&
            !(spainWatcherActive && isSpainDossier(j))
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
