// ─── V3 Loop — Boucle principale du mode V3 Chasseur ────────────────────────
// Extracted from index.ts

import { getActiveJobs, sendHeartbeat, getBotConfigValue, reportSlotFound, uploadFile, botLog, type HunterJob } from "../convexClient.js";
import { log, URGENCY_ORDER } from "../scheduler-utils.js";
import { pausedJobs, completedJobs } from "../scheduler-state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── FIX #2: Preflight Cache for Confinés (19/05/2026) ───────────────────────
// PROBLEM: Each blind booking event triggered a FULL preflight (6 requests + 5 pauses = 10-13s).
//          Slots at Kinshasa disappear in <3s. The confiné NEVER caught them.
// FIX: Cache preflight results per account (TTL 15 min). IDs rarely change mid-session.
//      When an event arrives → use cached data → PUT direct in <2s.
interface ConfinedPreflightEntry {
  applicantId: string | number;
  applicationId: string;
  appointmentId?: number;
  applicantUUID?: number | string;
  mode: "schedule" | "reschedule";
  cachedAt: number;
}
const confinedPreflightCache = new Map<string, ConfinedPreflightEntry>();
const PREFLIGHT_CACHE_TTL_MS = 15 * 60_000; // 15 min

function getConfinedPreflight(username: string): ConfinedPreflightEntry | null {
  const key = username.toLowerCase();
  const entry = confinedPreflightCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > PREFLIGHT_CACHE_TTL_MS) {
    confinedPreflightCache.delete(key);
    return null;
  }
  return entry;
}

function setConfinedPreflight(username: string, entry: Omit<ConfinedPreflightEntry, "cachedAt">): void {
  confinedPreflightCache.set(username.toLowerCase(), { ...entry, cachedAt: Date.now() });
}

// ── Throttle pour les logs pack_status (1x / 10 min par dossier) ─────────────
const packStatusTimestamps = new Map<string, number>();

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the V3 Chasseur loop.
 * Runs continuously for active USA dossiers — scan-session complet:
 * login → preflight → multi-mois → booking → discovery.
 */
export async function startV3Loop(convexUrl: string, hunterKey: string): Promise<void> {
  let runScanSession: any, getNextScanDecision: any, getCurrentPredictionScore: any, getCompetitionMedianMs: any, resolveAccountRole: any, extractBudgetFromConfig: any, getRemainingLogins: any, tokenCache: any, setUsaSessionProxy: any, getUsaSession: any, pollBlindBookingEvents: any, attemptBlindBooking: any;
  try {
    ({ runScanSession } = await import("../v3/scan/scan-session.js"));
    ({ getNextScanDecision } = await import("../v3/scan/scan-orchestrator.js"));
    ({ getCurrentPredictionScore, getCompetitionMedianMs } = await import("../v3/intelligence/prediction-engine.js"));
    ({ resolveAccountRole, extractBudgetFromConfig } = await import("../v3/admin/config-schema.js"));
    ({ getRemainingLogins } = await import("../v3/core/session-pool.js"));
    ({ tokenCache, setUsaSessionProxy } = await import("../usaPortal/usa-http.js"));
    ({ getUsaSession } = await import("../usaPortal/usa-session.js"));
    ({ pollBlindBookingEvents, attemptBlindBooking } = await import("../v3/booking/booking-blind.js"));
    var { reportSlotDiscovery } = await import("../convexClient.js");
  } catch (importErr) {
    log("ERROR", `[v3] ❌ CRASH à l'import des modules V3: ${importErr}`);
    log("ERROR", `[v3] Stack: ${importErr instanceof Error ? importErr.stack : String(importErr)}`);
    log("ERROR", `[v3] V3 mode désactivé — fallback mode séquentiel`);
    return;
  }

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
      !!j.hunterConfig.embassyUsername
    );

    if (usaJobs.length === 0) {
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

    const rolesStr = sortedJobs.map(j => `${j.applicantName}(${resolveAccountRole(j.hunterConfig as any)})`).join(", ");
    log("INFO", `[v3-loop] ${sortedJobs.length} job(s) USA actifs: ${rolesStr}`);

    // ── PACK STATUS LOG — informer chaque dossier de son rôle dans la meute ──
    // Throttle: 1x toutes les 10 min par dossier (évite la pollution de la timeline admin)
    const PACK_STATUS_INTERVAL_MS = 10 * 60_000;
    for (const job of sortedJobs) {
      const jobUsername = job.hunterConfig.embassyUsername;
      if (!jobUsername) continue;
      const lastPackLog = (packStatusTimestamps.get(jobUsername.toLowerCase()) ?? 0);
      if (Date.now() - lastPackLog < PACK_STATUS_INTERVAL_MS) continue;
      packStatusTimestamps.set(jobUsername.toLowerCase(), Date.now());

      const jobRole = resolveAccountRole(job.hunterConfig as any);
      const packMembers = sortedJobs.filter(j => j.broadcastVisaClass === job.broadcastVisaClass).length;
      botLog({
        applicationId: job.id,
        step: "pack_status",
        status: "ok",
        data: {
          role: jobRole,
          visaClass: job.broadcastVisaClass ?? "B1/B2",
          packSize: packMembers,
          members: sortedJobs.filter(j => j.broadcastVisaClass === job.broadcastVisaClass).map(j => j.applicantName),
          phase: "scanning",
        },
      });
    }

    // ── RESET BUDGET ADMIN ──────────────────────────────────────────────
    for (const job of sortedJobs) {
      const uname = job.hunterConfig.embassyUsername;
      if (!uname) continue;
      try {
        const resetVal = await getBotConfigValue(`reset_budget:${uname}`).catch(() => null);
        if (resetVal && resetVal !== "done") {
          const newMax = parseInt(resetVal, 10) || 7;
          const { resetBudget } = await import("../v3/core/session-pool.js");
          resetBudget(uname, newMax);
          log("INFO", `[v3-loop] 🔄 Budget reset à ${newMax} pour ${uname} (demande admin)`);
          try {
            await fetch(`${convexUrl}/hunter/bot-config`, {
              method: "POST",
              headers: { "X-Hunter-Key": hunterKey, "Content-Type": "application/json" },
              body: JSON.stringify({ key: `reset_budget:${uname}`, value: "done" }),
            });
          } catch { /* non-bloquant */ }
        }
      } catch { /* non-bloquant */ }
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEUX PASSES — éclaireurs d'abord, confinés ensuite.
    // ═══════════════════════════════════════════════════════════════════

    const eclaireurJobs = sortedJobs.filter(j => resolveAccountRole(j.hunterConfig as any) !== "confine");
    const blindBookingJobs = sortedJobs.filter(j => {
      const role = resolveAccountRole(j.hunterConfig as any);
      return role === "confine" || role === "hybride";
    });

    // ── RELAY SYSTEM ──
    {
      const { shouldHandoff, requestHandoff } = await import("../v3/relay/relay-client.js");
      const meuteEclaireurs = new Map<string, typeof eclaireurJobs[0]>();
      for (const job of eclaireurJobs) {
        const vc = job.broadcastVisaClass;
        if (!vc) continue;
        const role = resolveAccountRole(job.hunterConfig as any);
        if (role === "eclaireur") {
          meuteEclaireurs.set(vc, job);
        }
      }

      for (const [visaClass, job] of meuteEclaireurs) {
        const username = job.hunterConfig.embassyUsername;
        const cachedEntry = tokenCache.get(username.toLowerCase());
        const hasValidToken = !!(cachedEntry && Date.now() < cachedEntry.expiresAt);
        const isRestricted = pausedJobs.has(job.id);

        const packSize = sortedJobs.filter(j => j.broadcastVisaClass === visaClass).length;

        const relayState = await import("../v3/relay/relay-client.js").then(m =>
          m.getRelayState(convexUrl, hunterKey, visaClass)
        );
        const shiftStartedAt = relayState?.activeeSince ?? Date.now() - 30 * 60_000;

        const decision = shouldHandoff(username, shiftStartedAt, isRestricted, hasValidToken, packSize);

        if (decision.shouldRelay) {
          log("INFO", `[relay] 🔄 ${job.applicantName} (${visaClass}) → relais demandé : ${decision.reason}`);
          const result = await requestHandoff(convexUrl, hunterKey, visaClass, username, decision.reason);
          if (result.ok) {
            log("INFO", `[relay] ✅ Relais accepté : ${result.applicantName} (${result.newEclaireur}) prend le relais`);
          } else {
            log("WARN", `[relay] ⚠️ Relais impossible pour ${visaClass} : ${result.reason ?? "aucun successeur"}`);
          }
        }
      }
    }

    // ── PASSE 1 : ÉCLAIREURS (scan + broadcast) ──────────────────────
    let scannedOne = false;
    for (const job of eclaireurJobs) {
      const username = job.hunterConfig.embassyUsername;
      const role = resolveAccountRole(job.hunterConfig as any);

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
        nightMode: (job.hunterConfig as any).nightModeEnabled ? "minimal" : "off",
      });

      if (!decision.shouldScan) {
        if (!hasValidToken && remaining > 0) {
          log("INFO", `[v3-loop] 🔑 ${job.applicantName} — pas de token mais budget disponible (${remaining} logins restants) → forcer login`);
        } else {
          continue;
        }
      }

      log("INFO", `[v3-loop] ▶ ${job.applicantName} — ${decision.reason} (phase: ${decision.phase}, interval: ${Math.round(decision.intervalMs / 1000)}s)`);

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
        getSession: async (proxyUrl: any) => {
          setUsaSessionProxy(proxyUrl ?? undefined);
          const session = await getUsaSession(
            job.hunterConfig.embassyUsername,
            job.hunterConfig.embassyPassword,
            job.hunterConfig.twoCaptchaApiKey,
          );
          setUsaSessionProxy(undefined);
          return session;
        },
        convexSiteUrl: convexUrl,
        hunterApiKey: hunterKey,
        visaClass: job.broadcastVisaClass ?? undefined,
      });

      log("INFO", `[v3-loop] ✅ ${job.applicantName} — résultat: ${outcome}`);

      // ── RELAY CONFIRM ──
      if (outcome !== "restricted" && outcome !== "payment_required" && job.broadcastVisaClass) {
        const postScanCached = tokenCache.get(username.toLowerCase());
        const postScanValid = !!(postScanCached && Date.now() < postScanCached.expiresAt);
        if (postScanValid && role === "eclaireur") {
          try {
            const { confirmRelay } = await import("../v3/relay/relay-client.js");
            await confirmRelay(convexUrl, hunterKey, job.broadcastVisaClass, username);
          } catch { /* non-bloquant */ }
        }
      }

      // ── HEARTBEAT pour l'éclaireur — alimente lastCheckAt + checkCount dans le panneau admin ──
      // Sans ça, le panneau affiche "Dernier: 17 mai" et "Tentatives: 85" figés.
      if (outcome === "no_slot" || outcome === "token_expired" || outcome === "error" || outcome === "proxy_down") {
        sendHeartbeat({ applicationId: job.id, result: "not_found" }).catch(() => {});
      }

      if (outcome === "slot_captured") {
        completedJobs.add(job.id);
        pausedJobs.add(job.id);
        await sendHeartbeat({ applicationId: job.id, result: "slot_found" as any });
      } else if (outcome === "restricted") {
        pausedJobs.add(job.id);
        sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Compte restreint par le portail" }).catch(() => {});
      } else if (outcome === "payment_required") {
        pausedJobs.add(job.id);
        await sendHeartbeat({ applicationId: job.id, result: "payment_required", errorMessage: "Paiement MRV non vérifié" });
      } else if (outcome === "budget_exhausted") {
        // ── FIX: Attendre au lieu de spammer des critical errors ──
        // Le budget ne se reset qu'à minuit UTC. Sans backoff, le bot re-teste
        // toutes les quelques secondes et spam des critical errors inutilement.
        const { canLogin } = await import("../v3/core/session-pool.js");
        const budgetDecision = canLogin(username);
        const budgetWaitMs = budgetDecision.waitMs ?? 0;
        // Cap le wait à 30 min max par tick — on re-vérifiera après
        // (permet de réagir si admin fait un reset_budget entretemps)
        const cappedWaitMs = Math.min(budgetWaitMs, 30 * 60_000);
        const effectiveWait = Math.max(cappedWaitMs, 5 * 60_000); // minimum 5 min
        log("INFO", `[v3-loop] 💤 ${job.applicantName} — budget épuisé, attente ${Math.round(effectiveWait / 60_000)} min (reset dans ${Math.round(budgetWaitMs / 60_000)} min)`);
        await new Promise(r => setTimeout(r, effectiveWait));
        scannedOne = true;
        break; // Pas besoin de tester les autres jobs du même compte
      }

      // ── KEEP-ALIVE ENTRE LES SCANS ──
      const waitMs = Math.max(decision.intervalMs, 30_000);
      const INTER_SCAN_PING_INTERVAL_MS = 8 * 60_000 + Math.random() * 4 * 60_000;

      const postScanCache = tokenCache.get(username.toLowerCase());
      const postScanTokenValid = !!(postScanCache && Date.now() < postScanCache.expiresAt);

      if (blindBookingJobs.length > 0) {
        // ── FIX #1 (19/05/2026): MICRO-WAIT ADAPTATIF au lieu de skip total ──
        // AVANT : skip complet du waitMs → 5 scans/min → burst détectable par Akamai.
        // APRÈS : appliquer 30-50% de l'intervalle calculé par l'orchestrator.
        // Casse le pattern "burst 5 scans/60s" tout en restant réactif pour les confinés.
        // En mode rush/burst (intervalle < 30s), on applique un minimum de 15s.
        const microWaitFactor = 0.3 + Math.random() * 0.2; // 30-50% de l'intervalle original
        const microWaitMs = Math.max(15_000, Math.round(waitMs * microWaitFactor));
        log("INFO", `[v3-loop] ⏳ Micro-wait ${Math.round(microWaitMs / 1000)}s (${Math.round(microWaitFactor * 100)}% de ${Math.round(waitMs / 1000)}s) — ${blindBookingJobs.length} confiné(s)/hybride(s) en attente`);

        // ── PRIORITY 2 (19/05/2026): WARM STANDBY — Proactive preflight during micro-wait ──
        // PROBLEM: First blind booking event for a confiné takes 5-10s (full preflight).
        //          Slots disappear in <3s → confinés NEVER catch the first event of a session.
        // FIX: During the micro-wait (dead time anyway), run a lightweight
        //      checkUsaAppointmentRequestStatus + runPreflight for confinés that have a
        //      valid token but NO cache entry. This pre-fills the cache BEFORE any event.
        //      Next event → cache HIT → blind booking in <200ms.
        //
        // CONSTRAINTS:
        //   - Only warm up confinés with valid tokens (don't waste logins)
        //   - Only if no cache exists yet (don't re-preflight needlessly)
        //   - Run in background (don't block the micro-wait timer)
        //   - Max 1 confiné per tick (avoid burst of preflight requests)
        //   - Non-blocking: if preflight fails, just log and move on
        const warmStandbyPromise = (async () => {
          // Find the first confiné/hybride with a valid token but no preflight cache
          for (const confJob of blindBookingJobs) {
            const confUsername = confJob.hunterConfig.embassyUsername;
            if (!confUsername) continue;

            // Skip if already cached
            const existing = getConfinedPreflight(confUsername);
            if (existing) continue;

            // Check token validity
            const confCached = tokenCache.get(confUsername.toLowerCase());
            const confHasToken = !!(confCached && Date.now() < confCached.expiresAt);
            if (!confHasToken) continue;

            // Found a candidate → run lightweight preflight in background
            const confRole = resolveAccountRole(confJob.hunterConfig as any);
            log("INFO", `[v3-loop] 🔥 Warm standby: pré-chauffage ${confJob.applicantName} (${confRole}) pendant micro-wait`);

            try {
              const { checkUsaAppointmentRequestStatus, fetchCancellableSessionIds } = await import("../usaPortal/appointments-api.js");
              const { runPreflight: runPreflightWarm } = await import("../v3/scan/scan-preflight.js");

              const warmSession = {
                accessToken: confCached!.accessToken,
                refreshToken: confCached!.refreshToken,
                csrfToken: confCached!.csrfToken ?? "",
                userID: confCached!.userID,
                fullName: confCached!.fullName,
                applicationId: null as string | null,
                pendingAppoStatus: null,
                missionId: 323,
                allowedOfcs: confCached!.allowedOfcs ?? [],
              } as any;

              const reqStatus = await checkUsaAppointmentRequestStatus(warmSession, undefined);
              let warmApplicationId = reqStatus.applicationId ?? "";
              let warmMode: "schedule" | "reschedule" = "schedule";

              if (reqStatus.status === "cancellable") {
                warmMode = "reschedule";
                await fetchCancellableSessionIds(warmSession, { id: confJob.id, hunterConfig: confJob.hunterConfig } as any);
                warmApplicationId = warmSession.applicationId ?? warmApplicationId;
              }

              if (!warmApplicationId) {
                log("WARN", `[v3-loop] 🔥 Warm standby: ${confJob.applicantName} — applicationId introuvable, skip`);
                break; // Don't try other confinés this tick
              }

              const preflight = await runPreflightWarm(warmSession, warmApplicationId, 323);

              // Store in cache (same format as Fix #2)
              setConfinedPreflight(confUsername, {
                applicantId: preflight.appDetails.applicantId,
                applicationId: warmApplicationId,
                appointmentId: preflight.appDetails.appointmentId,
                applicantUUID: preflight.appDetails.applicantUUID as number | undefined,
                mode: warmMode,
              });

              log("INFO", `[v3-loop] 🔥 ✅ Warm standby OK: ${confJob.applicantName} — cache rempli (mode=${warmMode}, appId=${warmApplicationId.slice(-8)}…)`);
            } catch (warmErr) {
              // Non-blocking — just log and move on
              log("WARN", `[v3-loop] 🔥 Warm standby échoué pour ${confJob.applicantName}: ${warmErr}`);
            }
            break; // Max 1 confiné par tick (avoid burst)
          }
        })();

        // Run warm standby IN PARALLEL with the micro-wait timer
        // The micro-wait is the constraint — if warm standby takes longer, it's abandoned
        await Promise.all([
          new Promise(r => setTimeout(r, microWaitMs)),
          warmStandbyPromise.catch(() => {}), // Never let warm standby failure block the loop
        ]);
      } else if (postScanTokenValid && waitMs > INTER_SCAN_PING_INTERVAL_MS * 0.8) {
        const { startKeepAlive: startInterScanKA } = await import("../v3/anti-detection/keep-alive.js");
        // FIX #4: Pass resolved applicationId to keep-alive (not null from cachedEntry).
        // The scan-session resolves applicationId dynamically — store it for inter-scan pings.
        // Without this, keep-alive never pings (guard: if (!session.applicationId) return false).
        const resolvedAppId = postScanCache!.applicationId ?? cachedEntry?.applicationId ?? null;
        const interScanKA = startInterScanKA(
          { accessToken: postScanCache!.accessToken, applicationId: resolvedAppId, missionId: 323 } as any,
          job.id,
          { minIntervalMs: 8 * 60_000, maxIntervalMs: 12 * 60_000 },
        );
        await new Promise(r => setTimeout(r, waitMs));
        interScanKA.stop();
      } else {
        await new Promise(r => setTimeout(r, waitMs));
      }

      scannedOne = true;
      break; // Un seul éclaireur par tick
    }

    // ── PASSE 2 : CONFINÉS + HYBRIDES (poll blind booking events) ─────
    if (scannedOne && blindBookingJobs.length > 0) {
      await new Promise(r => setTimeout(r, 5_000));
      log("INFO", `[v3-loop] 📡 PASSE 2 — polling ${blindBookingJobs.length} confiné(s)/hybride(s) après scan éclaireur`);
    } else if (blindBookingJobs.length > 0) {
      log("INFO", `[v3-loop] 📡 PASSE 2 — polling ${blindBookingJobs.length} confiné(s)/hybride(s) (éclaireur non éligible ce tick)`);
    }

    for (const job of blindBookingJobs) {
      const username = job.hunterConfig.embassyUsername;
      const jobRole = resolveAccountRole(job.hunterConfig as any);
      try {
        const events = await pollBlindBookingEvents(username, convexUrl, hunterKey, job.broadcastVisaClass ?? "B1/B2");
        log("INFO", `[v3-loop] 🔍 ${job.applicantName} (${jobRole}) poll → ${events.length} event(s) pending`);

        // ── HEARTBEAT confiné — prouve à l'admin que ce dossier est en veille active ──
        // Sans ça, lastCheckAt reste figé et l'admin croit que le bot est mort pour ce dossier.
        sendHeartbeat({ applicationId: job.id, result: "not_found" }).catch(() => {});

        if (events.length > 0) {
          log("INFO", `[v3-loop] 📡 ${job.applicantName} (${jobRole}) — ${events.length} blind booking(s) reçu(s)`);

          // 1. Token check + réveil d'urgence
          let cachedConf = tokenCache.get(username.toLowerCase());
          let hasToken = !!(cachedConf && Date.now() < cachedConf.expiresAt);

          if (!hasToken) {
            const budgetRemaining = getRemainingLogins(username);
            if (budgetRemaining <= 0) {
              log("WARN", `[v3-loop] ${job.applicantName} (${jobRole}) — SLOT DÉTECTÉ mais budget épuisé (0 logins restants) — impossible de réveiller`);
              continue;
            }
            log("INFO", `[v3-loop] ⚡ ${job.applicantName} (${jobRole}) — RÉVEIL D'URGENCE ! Slot détecté, login immédiat (budget: ${budgetRemaining} restants)`);
            try {
              setUsaSessionProxy(undefined);
              const freshSession = await getUsaSession(
                job.hunterConfig.embassyUsername,
                job.hunterConfig.embassyPassword,
                job.hunterConfig.twoCaptchaApiKey,
              );
              setUsaSessionProxy(undefined);
              if (freshSession) {
                const { recordLogin } = await import("../v3/core/session-pool.js");
                recordLogin(username, "emergency");
                cachedConf = tokenCache.get(username.toLowerCase());
                hasToken = !!(cachedConf && Date.now() < cachedConf.expiresAt);
                log("INFO", `[v3-loop] ✅ ${job.applicantName} (${jobRole}) — réveil réussi en urgence, token valide`);
              } else {
                log("WARN", `[v3-loop] ${job.applicantName} (${jobRole}) — réveil échoué (login null) — slot perdu`);
                continue;
              }
            } catch (loginErr) {
              log("ERROR", `[v3-loop] ${job.applicantName} (${jobRole}) — réveil échoué: ${loginErr} — slot perdu`);
              continue;
            }
          }

          if (!hasToken || !cachedConf) {
            log("WARN", `[v3-loop] ${job.applicantName} (${jobRole}) — token toujours invalide après réveil — skip`);
            continue;
          }

          // 2. Preflight — USE CACHE if available (FIX #2: 13s → 1-2s)
          let confAppDetails: { applicantId: string | number; applicationId: string; appointmentId?: number; applicantUUID?: number | string } | null = null;
          let useReschedule = false;

          // ── FIX #2: Check preflight cache first ──
          const cachedPreflight = getConfinedPreflight(username);
          if (cachedPreflight) {
            confAppDetails = {
              applicantId: cachedPreflight.applicantId,
              applicationId: cachedPreflight.applicationId,
              appointmentId: cachedPreflight.appointmentId,
              applicantUUID: cachedPreflight.applicantUUID,
            };
            useReschedule = cachedPreflight.mode === "reschedule";
            const cacheAgeS = Math.round((Date.now() - cachedPreflight.cachedAt) / 1000);
            log("INFO", `[v3-loop] ⚡ ${job.applicantName} (${jobRole}) — preflight CACHE HIT (age: ${cacheAgeS}s) → skip 6 requêtes, booking DIRECT`);
          } else {
            // Cache miss → full preflight (slow path)
            try {
            const { checkUsaAppointmentRequestStatus, fetchCancellableSessionIds } = await import("../usaPortal/appointments-api.js");
            const { runPreflight } = await import("../v3/scan/scan-preflight.js");

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

            if (reqStatus.status === "cancellable") {
              useReschedule = true;
              await fetchCancellableSessionIds(confSession, { id: job.id, hunterConfig: job.hunterConfig } as any);
              confApplicationId = confSession.applicationId ?? confApplicationId;
              log("INFO", `[v3-loop] ${job.applicantName} (${jobRole}) — status=cancellable → mode RESCHEDULE`);
            } else if (reqStatus.status === "pending") {
              useReschedule = false;
              log("INFO", `[v3-loop] ${job.applicantName} (${jobRole}) — status=pending (pendingAppoStatus=${reqStatus.pendingAppoStatus}) → mode SCHEDULE`);
            } else {
              useReschedule = !!job.hunterConfig.rescheduleMode;
              log("WARN", `[v3-loop] ${job.applicantName} (${jobRole}) — status=${reqStatus.status} — fallback hunterConfig.rescheduleMode=${useReschedule}`);
            }

            if (!confApplicationId) {
              log("WARN", `[v3-loop] ${job.applicantName} (${jobRole}) — applicationId introuvable — blind booking impossible`);
              continue;
            }

            const preflight = await runPreflight(confSession, confApplicationId, 323);
            confAppDetails = {
              applicantId: preflight.appDetails.applicantId,
              applicationId: confApplicationId,
              appointmentId: preflight.appDetails.appointmentId,
              applicantUUID: preflight.appDetails.applicantUUID as number | undefined,
            };
            log("INFO", `[v3-loop] ✅ ${job.applicantName} (${jobRole}) — preflight OK: applicantId=${confAppDetails.applicantId} appId=${confApplicationId} mode=${useReschedule ? "reschedule" : "schedule"}`);

            // ── FIX #2: Store in cache for next events (TTL 15 min) ──
            setConfinedPreflight(username, {
              applicantId: confAppDetails.applicantId,
              applicationId: confAppDetails.applicationId,
              appointmentId: confAppDetails.appointmentId,
              applicantUUID: confAppDetails.applicantUUID,
              mode: useReschedule ? "reschedule" : "schedule",
            });
          } catch (preflightErr) {
            log("ERROR", `[v3-loop] ${job.applicantName} (${jobRole}) — preflight échoué: ${preflightErr} — blind booking impossible`);
            continue;
          }
          } // end cache miss

          // 3. Filtrer les events trop vieux (> 60s)
          const MAX_EVENT_AGE_MS = 60_000;
          const freshEvents = events.filter((e: any) => (Date.now() - (e.discoveredAt ?? 0)) <= MAX_EVENT_AGE_MS);
          const staleCount = events.length - freshEvents.length;
          if (staleCount > 0) {
            log("INFO", `[v3-loop] 🗑️ ${job.applicantName} (${jobRole}) — ${staleCount} event(s) ignoré(s) (> 60s) — ${freshEvents.length} frais`);
          }
          if (freshEvents.length === 0) {
            log("INFO", `[v3-loop] ${job.applicantName} (${jobRole}) — aucun event frais (tous > 60s) — skip`);
            continue;
          }

          // 4. Boucle sur les events FRAIS
          let rateLimited = false;
          for (const event of freshEvents) {
            let blindResult: Awaited<ReturnType<typeof attemptBlindBooking>>;
            try {
              blindResult = await attemptBlindBooking(event, {
                accessToken: cachedConf!.accessToken,
                applicationId: confAppDetails.applicationId,
                applicantId: confAppDetails.applicantId,
                appointmentId: confAppDetails.appointmentId,
                applicantUUID: confAppDetails.applicantUUID as number | undefined,
                missionId: 323,
                mode: useReschedule ? "reschedule" : "schedule",
                csrfToken: cachedConf!.csrfToken ?? "",
                existingLocationType: useReschedule ? "POST" : undefined,
              });
            } catch (bookingErr: any) {
              if (bookingErr?.name === "RateLimitError" || bookingErr?.constructor?.name === "RateLimitError") {
                log("WARN", `[v3-loop] ⚠️ ${job.applicantName} (${jobRole}) — 429 rate-limit (thrown) — arrêt tentatives`);
                rateLimited = true;
                break;
              }
              if (bookingErr?.name === "TokenExpiredError" || bookingErr?.constructor?.name === "TokenExpiredError") {
                log("WARN", `[v3-loop] ⚠️ ${job.applicantName} (${jobRole}) — token expiré — arrêt tentatives`);
                break;
              }
              log("WARN", `[v3-loop] ⚠️ ${job.applicantName} (${jobRole}) — erreur booking: ${bookingErr?.message ?? bookingErr} — tentative suivante`);
              continue;
            }
            if (blindResult.success) {
              log("INFO", `[v3-loop] 🎉 BLIND BOOKING RÉUSSI — ${job.applicantName} (${jobRole}) — ${event.date} ${event.time}`);

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
                const pdf = await (await import("../usaPortal/usa-scan-confirmation.js")).downloadUsaConfirmationPdf(session, confAppDetails.applicationId, blindResult.appointmentId);
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
              await sendHeartbeat({ applicationId: job.id, result: "slot_found" as any });
              break;
            }
            if (blindResult.statusCode === 409) {
              log("INFO", `[v3-loop] ⚠️ ${job.applicantName} (${jobRole}) — slot ${event.slotId?.toString().slice(0, 10)}… pris (409) — tentative suivante...`);
            } else if (blindResult.statusCode === 429) {
              log("WARN", `[v3-loop] ⚠️ ${job.applicantName} (${jobRole}) — 429 rate-limit — arrêt tentatives (${freshEvents.indexOf(event) + 1}/${freshEvents.length} tentés)`);
              break;
            } else if (blindResult.statusCode === 500) {
              log("WARN", `[v3-loop] ⚠️ ${job.applicantName} (${jobRole}) — HTTP 500: ${blindResult.error?.slice(0, 100)} — arrêt tentatives`);
              break;
            }
          }
        }
      } catch (pollErr) {
        log("WARN", `[v3-loop] Erreur polling confiné ${username.slice(0,8)}…: ${pollErr}`);
      }
    }

    // Si aucun job n'était éligible ce tick
    if (!scannedOne && blindBookingJobs.length === 0) {
      await new Promise(r => setTimeout(r, 30_000));
    } else if (!scannedOne) {
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
}
