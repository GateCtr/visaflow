// ─── Spain Watcher Loop — veille créneaux Espagne ────────────────────────────
// Extracted from index.ts
// Boucle indépendante, tourne en background.
//
// MODES :
//   - SPAIN_HTTP_MODE=1 → scan HTTP pur (impit + SOAX + CapSolver CF cookie)
//     ✅ 10x plus rapide, 0 RAM browser, scan toutes les 30-60s
//     Prérequis : SOAX_PROXY_URL + CAPSOLVER_API_KEY
//   - SPAIN_HTTP_MODE=0 (défaut) → Playwright stealth (ancien mode)
//
// AUTO-BOOKING :
//   Quand un créneau est détecté :
//   1. Interroge Convex pour les dossiers Espagne actifs (destination="spain", hunterConfig.isActive=true)
//   2. Pour chaque dossier, mappe le visaType au service Bookitit via spain-service-mapping
//   3. Exécute le booking HTTP pour chaque dossier éligible
//   → Pas de env vars SPAIN_BOOK_LOGIN/PASSWORD — tout vient de Convex (comme le bot USA)

import { getSpainWatcherConfig, getActiveJobs, uploadFile, reportSpainWatcherScan, reportSlotFound, sendHeartbeat, attachConfirmationDoc, type HunterJob } from "../convexClient.js";
import { runSpainWatcherProbe } from "../spainPortal.js";
import { runSpainHttpProbe } from "../spain-http-scanner.js";
import { isSpainCfSessionExpiringSoon, ensureSpainCfSession, getActiveSpainCfSession, restoreSpainSoaxStateFromRedis } from "../spain-soax-solver.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { executeHttpBooking, extractServicesFromHtml, type SpainBookingConfig } from "../spain-http-booking.js";
import { matchServiceForVisa } from "../spain-service-mapping.js";
import { log } from "../scheduler-utils.js";

const SPAIN_HTTP_MODE = process.env.SPAIN_HTTP_MODE === "1";

// ─── Types internes ──────────────────────────────────────────────────────────

interface SpainDossier {
  id: string;
  applicantName: string;
  visaType: string;
  login: string;
  password: string;
  applicationId: string;
  otpChannel: "email" | "sms" | "manual";
  slotDateFrom?: string;
  slotDateDeadline?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Récupère les dossiers Espagne actifs depuis Convex (via getActiveJobs).
 * Filtre : destination="spain", hunterConfig.isActive=true, credentials présents.
 */
async function getActiveSpainDossiers(): Promise<SpainDossier[]> {
  try {
    const jobs = await getActiveJobs();
    return jobs
      .filter((j: HunterJob) =>
        j.destination === "spain" &&
        j.hunterConfig?.isActive === true &&
        !!j.hunterConfig.embassyUsername &&
        !!j.hunterConfig.embassyPassword
      )
      .map((j: HunterJob) => ({
        id: j.id,
        applicantName: j.applicantName,
        visaType: j.visaType,
        login: j.hunterConfig.embassyUsername,
        password: j.hunterConfig.embassyPassword,
        applicationId: j.id,
        otpChannel: (j.spainOtpConfig?.channel ?? "email") as "email" | "sms" | "manual",
        slotDateFrom: j.hunterConfig.slotDateFrom,
        slotDateDeadline: j.hunterConfig.slotDateDeadline,
      }));
  } catch (err) {
    log("WARN", `[SPAIN-WATCHER] Échec récupération dossiers Espagne: ${err}`);
    return [];
  }
}

/**
 * Vérifie si un créneau est dans la fenêtre de dates acceptable pour un dossier.
 */
function isSlotInDateWindow(slotDate: string, dossier: SpainDossier): boolean {
  if (!slotDate) return true; // Pas de date connue → on tente quand même

  const slot = new Date(slotDate);
  if (isNaN(slot.getTime())) return true;

  if (dossier.slotDateFrom) {
    const from = new Date(dossier.slotDateFrom);
    if (!isNaN(from.getTime()) && slot < from) {
      log("INFO", `[SPAIN-WATCHER] ⏭️ ${dossier.applicantName}: créneau ${slotDate} avant slotDateFrom ${dossier.slotDateFrom} — skip`);
      return false;
    }
  }

  if (dossier.slotDateDeadline) {
    const deadline = new Date(dossier.slotDateDeadline);
    if (!isNaN(deadline.getTime()) && slot > deadline) {
      log("INFO", `[SPAIN-WATCHER] ⏭️ ${dossier.applicantName}: créneau ${slotDate} après deadline ${dossier.slotDateDeadline} — skip`);
      return false;
    }
  }

  return true;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

export async function startSpainWatcherLoop(): Promise<void> {
  log("INFO", `[SPAIN-WATCHER] Boucle démarrée (mode: ${SPAIN_HTTP_MODE ? "HTTP-ONLY 🚀" : "Playwright"}, auto-booking: Convex dossiers)`);

  // En mode HTTP : initialiser Redis + restaurer l'état SOAX avant le pre-warm
  if (SPAIN_HTTP_MODE) {
    // 1. Connecter Redis (persistence CF session + SOAX rotation)
    const redisOk = await initSpainRedis().catch((e) => {
      log("WARN", `[SPAIN-WATCHER] Redis init échoué (non-fatal): ${e}`);
      return false;
    });
    if (redisOk) {
      log("INFO", "[SPAIN-WATCHER] ✅ Redis Spain connecté — session CF persistée entre redéploiements");
    }

    // 2. Restaurer le rotation count SOAX (évite collisions session ID)
    await restoreSpainSoaxStateFromRedis().catch((e) => {
      log("WARN", `[SPAIN-WATCHER] Restauration SOAX rotation échouée (non-fatal): ${e}`);
    });

    // 3. Pre-warm la session CF (Redis restore tenté automatiquement dans ensureSpainCfSession)
    log("INFO", "[SPAIN-WATCHER] Pre-warm session CF (SOAX + CapSolver)…");
    const preWarmConfig = await getSpainWatcherConfig().catch(() => null);
    const preWarmUrl = preWarmConfig?.portalUrl || undefined;
    const session = await ensureSpainCfSession(preWarmUrl).catch((e) => {
      log("WARN", `[SPAIN-WATCHER] Pre-warm CF échoué: ${e} — retry au prochain cycle`);
      return null;
    });
    if (session) {
      log("INFO", `[SPAIN-WATCHER] ✅ Session CF prête (expire: ${new Date(session.expiresAt).toISOString()})`);
    }
  }

  while (true) {
    try {
      const config = await getSpainWatcherConfig();

      if (!config || !config.isActive) {
        await new Promise((r) => setTimeout(r, 2 * 60_000));
        continue;
      }

      // En mode HTTP : intervalle fixe 30s (ignore config Convex calibrée pour Playwright)
      const intervalMs = SPAIN_HTTP_MODE
        ? 30_000
        : (config.intervalMin ?? 3) * 60_000;
      const modeLabel = SPAIN_HTTP_MODE ? "HTTP" : "PW";
      log("INFO", `[SPAIN-WATCHER] [${modeLabel}] Probe → ${config.portalUrl} (intervalle: ${Math.round(intervalMs / 1000)}s)`);

      // Proactive re-solve si le cookie CF expire bientôt (mode HTTP)
      if (SPAIN_HTTP_MODE && isSpainCfSessionExpiringSoon()) {
        log("INFO", "[SPAIN-WATCHER] ⏰ Cookie CF expire bientôt → re-solve proactif");
        await ensureSpainCfSession(config.portalUrl).catch((e) => {
          log("WARN", `[SPAIN-WATCHER] Re-solve proactif échoué: ${e}`);
        });
      }

      // Exécuter le probe selon le mode
      const result = SPAIN_HTTP_MODE
        ? await runSpainHttpProbe(config.portalUrl)
        : await runSpainWatcherProbe(config.portalUrl);

      log(
        "INFO",
        `[SPAIN-WATCHER] [${modeLabel}] Résultat: ${result.status}${result.slotInfo ? ` — ${result.slotInfo}` : ""}${result.errorMessage ? ` (${result.errorMessage})` : ""}`,
      );

      // ─── DIAGNOSTIC: quand found, toujours extraire et logger les services ──
      // Permet de vérifier si c'est un vrai créneau (services rendus) ou un faux positif
      if (
        SPAIN_HTTP_MODE &&
        result.status === "found" &&
        (result as any)._mainHtml
      ) {
        const mainHtml = (result as any)._mainHtml as string;

        // Extraction diagnostic — toujours logué, même sans dossier actif
        const diagServices = extractServicesFromHtml(mainHtml);
        if (diagServices.length > 0) {
          log("INFO", `[SPAIN-WATCHER] ✅ CRÉNEAU CONFIRMÉ — ${diagServices.length} service(s) rendu(s) dans le HTML :`);
          for (const svc of diagServices) {
            log("INFO", `[SPAIN-WATCHER]    🎯 "${svc.serviceName}" → serviceId: ${svc.serviceId}`);
          }
        } else {
          log("WARN", `[SPAIN-WATCHER] ⚠️ FAUX POSITIF PROBABLE — 'No hay horas' masqué MAIS aucun service rendu (0 liens #selectservice dans le HTML)`);
          // Log un extrait du HTML pour diagnostic
          const renderedHtml = mainHtml.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");
          const containerMatch = renderedHtml.match(/idDivBktServicesContainer[^>]*>([\s\S]{0,500})/i);
          if (containerMatch) {
            log("INFO", `[SPAIN-WATCHER]    Container preview: ${containerMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`);
          }
        }

        const cfSession = getActiveSpainCfSession();

        if (!cfSession) {
          log("WARN", "[SPAIN-WATCHER] ❌ Auto-booking impossible — pas de session CF active");
        } else {
          // 1. Récupérer les dossiers Espagne actifs depuis Convex
          const dossiers = await getActiveSpainDossiers();

          if (dossiers.length === 0) {
            log("INFO", "[SPAIN-WATCHER] ⚠️ Créneau trouvé mais aucun dossier Espagne actif dans Convex — alerte email seule");
          } else {
            log("INFO", `[SPAIN-WATCHER] 🚀 AUTO-BOOKING DÉCLENCHÉ — ${dossiers.length} dossier(s) actif(s) à traiter`);

            // 2. Extraire les services disponibles du HTML
            const services = extractServicesFromHtml(mainHtml);
            log("INFO", `[SPAIN-WATCHER]    Services Bookitit disponibles: ${services.map((s) => `"${s.serviceName}" (${s.serviceId})`).join(", ") || "aucun"}`);

            // 3. Pour chaque dossier, matcher le service et tenter le booking
            for (const dossier of dossiers) {
              const matched = matchServiceForVisa(services, dossier.visaType);

              if (!matched) {
                log("WARN", `[SPAIN-WATCHER] ⚠️ ${dossier.applicantName}: aucun service ne matche "${dossier.visaType}" — skip`);
                await sendHeartbeat({
                  applicationId: dossier.applicationId,
                  result: "not_found",
                  errorMessage: `Créneau détecté mais aucun service Bookitit ne correspond au visa "${dossier.visaType}"`,
                }).catch(() => {});
                continue;
              }

              log("INFO", `[SPAIN-WATCHER] 📋 ${dossier.applicantName}: booking "${matched.serviceName}" (${matched.serviceId}) pour "${dossier.visaType}"`);

              const bookingConfig: SpainBookingConfig = {
                login: dossier.login,
                password: dossier.password,
                applicationId: dossier.applicationId,
                otpChannel: dossier.otpChannel,
                applicantName: dossier.applicantName,
                targetServiceId: matched.serviceId,
                visaType: dossier.visaType,
              };

              try {
                const bookingResult = await executeHttpBooking(
                  cfSession,
                  config.portalUrl,
                  mainHtml,
                  bookingConfig,
                );

                log(
                  "INFO",
                  `[SPAIN-WATCHER] 📋 ${dossier.applicantName}: ${bookingResult.status}${bookingResult.locator ? ` — locator: ${bookingResult.locator}` : ""}${bookingResult.errorMessage ? ` (${bookingResult.errorMessage})` : ""} (${bookingResult.durationMs}ms)`,
                );

                if (bookingResult.status === "booked") {
                  // ── 1. Upload + attach PDF de confirmation ──
                  let pdfStorageId: string | undefined;
                  if (bookingResult.confirmationPdf) {
                    try {
                      const b64 = bookingResult.confirmationPdf.toString("base64");
                      pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
                      if (pdfStorageId) {
                        await attachConfirmationDoc({
                          applicationId: dossier.applicationId,
                          storageId: pdfStorageId,
                          docKey: "booking_confirmation_pdf",
                          label: "Confirmation de rendez-vous Espagne (PDF)",
                        });
                        log("INFO", `[SPAIN-WATCHER] 📄 ${dossier.applicantName}: PDF confirmation uploadé et attaché au dossier`);
                      }
                    } catch (pdfErr) {
                      log("WARN", `[SPAIN-WATCHER] ⚠️ ${dossier.applicantName}: PDF upload/attach échoué (non-fatal): ${pdfErr}`);
                    }
                  }

                  // ── 2. Report slot found to Convex (marque le dossier comme "slot_found") ──
                  await reportSlotFound({
                    applicationId: dossier.applicationId,
                    date: result.slotInfo ?? "unknown",
                    time: "",
                    location: "Ambassade d'Espagne Kinshasa",
                    confirmationCode: bookingResult.locator,
                    screenshotStorageId: undefined,
                  }).catch((e) => log("WARN", `[SPAIN-WATCHER] reportSlotFound error: ${e}`));

                  // Override slotInfo with booking confirmation
                  result.slotInfo = `✅ BOOKING CONFIRMÉ pour ${dossier.applicantName} ! Locator: ${bookingResult.locator ?? "N/A"} | ${result.slotInfo}`;
                } else {
                  // Report heartbeat with error
                  await sendHeartbeat({
                    applicationId: dossier.applicationId,
                    result: "error",
                    errorMessage: `Booking échoué: ${bookingResult.status} — ${bookingResult.errorMessage ?? ""}`,
                  }).catch(() => {});
                }
              } catch (bookErr) {
                log("WARN", `[SPAIN-WATCHER] ❌ ${dossier.applicantName}: booking erreur: ${bookErr}`);
                await sendHeartbeat({
                  applicationId: dossier.applicationId,
                  result: "error",
                  errorMessage: `Exception booking: ${bookErr}`,
                }).catch(() => {});
              }
            }
          }
        }
      }

      // ─── Report scan result to Convex ──────────────────────────────────
      let screenshotStorageId: string | undefined;
      if ((result.status === "found" || result.status === "not_found") && result.screenshotBase64) {
        screenshotStorageId = await uploadFile(result.screenshotBase64, "image/png") ?? undefined;
      }

      await reportSpainWatcherScan({
        status: result.status,
        slotInfo: result.slotInfo,
        screenshotStorageId,
        errorMessage: result.errorMessage,
      });

      await new Promise((r) => setTimeout(r, intervalMs));
    } catch (err) {
      log("WARN", `[SPAIN-WATCHER] Erreur boucle: ${err} — retry dans ${SPAIN_HTTP_MODE ? "1" : "5"} min`);
      await new Promise((r) => setTimeout(r, SPAIN_HTTP_MODE ? 60_000 : 5 * 60_000));
    }
  }
}
