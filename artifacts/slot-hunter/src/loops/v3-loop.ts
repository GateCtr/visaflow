// ─── V3 Loop — Boucle principale du mode V3 Chasseur ────────────────────────
// Extracted from index.ts

import { getActiveJobs, sendHeartbeat, getBotConfigValue, reportSlotFound, uploadFile, type HunterJob } from "../convexClient.js";
import { log, URGENCY_ORDER } from "../scheduler-utils.js";
import { pausedJobs, completedJobs } from "../scheduler-state.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

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

      if (outcome === "slot_captured") {
        completedJobs.add(job.id);
        pausedJobs.add(job.id);
        await sendHeartbeat({ applicationId: job.id, result: "slot_found" as any });
      } else if (outcome === "restricted") {
        pausedJobs.add(job.id);
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
        log("INFO", `[v3-loop] ⚡ Skip waitMs (${Math.round(waitMs / 1000)}s) — ${blindBookingJobs.length} confiné(s)/hybride(s) en attente, PASSE 2 immédiate`);
      } else if (postScanTokenValid && waitMs > INTER_SCAN_PING_INTERVAL_MS * 0.8) {
        const { startKeepAlive: startInterScanKA } = await import("../v3/anti-detection/keep-alive.js");
        const interScanKA = startInterScanKA(
          { accessToken: postScanCache!.accessToken, applicationId: cachedEntry?.applicationId ?? null, missionId: 323 } as any,
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

          // 2. Preflight UNE SEULE FOIS
          let confAppDetails: { applicantId: string | number; applicationId: string; appointmentId?: number; applicantUUID?: number | string } | null = null;
          let useReschedule = false;
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
          } catch (preflightErr) {
            log("ERROR", `[v3-loop] ${job.applicantName} (${jobRole}) — preflight échoué: ${preflightErr} — blind booking impossible`);
            continue;
          }

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
