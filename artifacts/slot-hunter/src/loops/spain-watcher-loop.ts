// ─── Spain Watcher Loop — veille créneaux Espagne ────────────────────────────
// Extracted from index.ts
// Boucle indépendante, tourne en background.
//
// MODES :
//   - SPAIN_HTTP_MODE=1 → scan HTTP pur (impit + proxy + CapSolver CF cookie)
//     ✅ 10x plus rapide, 0 RAM browser, scan toutes les 30-60s
//     Prérequis : DECODO_PROXY_URL (ou SOAX_PROXY_URL) + CAPSOLVER_API_KEY
//   - SPAIN_HTTP_MODE=0 (défaut) → Playwright stealth (ancien mode)
//
// AUTO-BOOKING :
//   Quand un créneau est détecté :
//   1. Interroge Convex pour les dossiers Espagne actifs (destination="spain", hunterConfig.isActive=true)
//   2. Pour chaque dossier, mappe le visaType au service Bookitit via spain-service-mapping
//   3. Exécute le booking HTTP pour chaque dossier éligible
//   → Pas de env vars SPAIN_BOOK_LOGIN/PASSWORD — tout vient de Convex (comme le bot USA)

import { getSpainWatcherConfig, getActiveJobs, uploadFile, reportSpainWatcherScan, reportSlotFound, sendHeartbeat, attachConfirmationDoc, reportSlotDiscoveryBatch, type HunterJob, type SlotDiscoveryEvent } from "../convexClient.js";
import { runSpainWatcherProbe } from "../spainPortal.js";
import { runSpainHttpProbe } from "../spain-http-scanner.js";
import { isSpainCfSessionExpiringSoon, ensureSpainCfSession, getActiveSpainCfSession, restoreSpainSoaxStateFromRedis } from "../spain-soax-solver.js";
import {
  ensureSpainPersistentBrowserSession,
  isSpainPersistentBrowserSessionExpiringSoon,
  getActiveSpainPersistentBrowserSession,
} from "../spain-persistent-browser.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { executeHttpBooking, extractServicesFromHtml, type SpainBookingConfig } from "../spain-http-booking.js";
import { matchServiceForVisa } from "../spain-service-mapping.js";
import { exploreAvailableSlots, formatExplorationForLogs, serializeExplorationForConvex, type SlotExplorationResult } from "../spain-slot-explorer.js";
import { log } from "../scheduler-utils.js";

const SPAIN_HTTP_MODE = process.env.SPAIN_HTTP_MODE === "1";
const SPAIN_HTTP_SCAN_INTERVAL_SEC = (() => {
  const configured = Number(process.env.SPAIN_HTTP_SCAN_INTERVAL_SEC ?? "60");
  if (!Number.isFinite(configured) || configured < 10) return 60;
  return Math.round(configured);
})();

// ─── Mode persistent-browser ──────────────────────────────────────────────────
// SPAIN_SESSION_MODE=persistent-browser → Chromium persistant + profil disque
//   Avantages : vrai fingerprint TLS/HTTP2, localStorage/cache conservés,
//               pas de coût CapSolver pour résoudre CF
//   Prérequis : DECODO_PROXY_URL (ou SOAX_PROXY_URL)
// Toutes les autres valeurs → comportement HTTP-only existant (capsolver / playwright)
const SPAIN_PERSISTENT_BROWSER = process.env.SPAIN_SESSION_MODE === "persistent-browser";

/** Abstraction de isSpainCfSessionExpiringSoon selon le mode actif. */
function isActiveSessionExpiringSoon(): boolean {
  return SPAIN_PERSISTENT_BROWSER
    ? isSpainPersistentBrowserSessionExpiringSoon()
    : isSpainCfSessionExpiringSoon();
}

/** Abstraction de ensureSpainCfSession selon le mode actif. */
async function ensureActiveSession(portalUrl: string) {
  return SPAIN_PERSISTENT_BROWSER
    ? ensureSpainPersistentBrowserSession(portalUrl)
    : ensureSpainCfSession(portalUrl);
}

/** Abstraction de getActiveSpainCfSession selon le mode actif. */
function getActiveSession() {
  return SPAIN_PERSISTENT_BROWSER
    ? getActiveSpainPersistentBrowserSession()
    : getActiveSpainCfSession();
}

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
  /** URL Bookitit du dossier — portalUrl ou hunterConfig.scheduleUrl */
  portalUrl: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Récupère les dossiers Espagne actifs depuis Convex (via getActiveJobs).
 * Filtre : destination="spain"|"espagne"|"es", hunterConfig.isActive=true, credentials présents.
 */
async function getActiveSpainDossiers(): Promise<SpainDossier[]> {
  try {
    const jobs = await getActiveJobs();

    // ─── Diagnostic : décompose chaque étape du filtre ────────────────────────
    const spainDestinations = ["spain", "espagne", "es"];
    const byDestination = jobs.filter((j: HunterJob) => spainDestinations.includes(j.destination));
    const byActive      = byDestination.filter((j: HunterJob) => j.hunterConfig?.isActive === true);
    const byCreds       = byActive.filter((j: HunterJob) => !!j.hunterConfig.embassyUsername && !!j.hunterConfig.embassyPassword);

    if (byDestination.length === 0 && jobs.length > 0) {
      const dests = [...new Set(jobs.map((j: HunterJob) => j.destination))].join(", ");
      log("INFO", `[SPAIN-WATCHER] 🔍 Diagnostic dossiers: ${jobs.length} job(s) total, 0 Espagne — destinations trouvées: [${dests}]`);
    } else if (byDestination.length > 0 && byActive.length === 0) {
      log("INFO", `[SPAIN-WATCHER] 🔍 Diagnostic dossiers: ${byDestination.length} dossier(s) Espagne trouvé(s) mais hunterConfig.isActive=false pour tous`);
    } else if (byActive.length > 0 && byCreds.length === 0) {
      log("INFO", `[SPAIN-WATCHER] 🔍 Diagnostic dossiers: ${byActive.length} dossier(s) Espagne actifs mais sans credentials (embassyUsername/embassyPassword vides) — dossiers: ${byActive.map((j: HunterJob) => j.applicantName).join(", ")}`);
    }
    // ──────────────────────────────────────────────────────────────────────────

    return byCreds
      .filter((j: HunterJob) => !!(j.portalUrl || (j.hunterConfig as { scheduleUrl?: string }).scheduleUrl))
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
        portalUrl: j.portalUrl ?? (j.hunterConfig as { scheduleUrl?: string }).scheduleUrl ?? "",
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

/**
 * Construit des SlotDiscoveryEvents à partir du résultat d'exploration.
 * Chaque slot exploré = 1 event par dossier actif, groupé par service (office = serviceName).
 * Les dossiers actifs déterminent si un slot est "captured" (dans la fenêtre) ou "ignored" (hors fenêtre).
 * Si aucun dossier actif → pas d'events (pas d'applicationId valide pour Convex).
 */
function buildDiscoveryEventsFromExploration(
  exploration: SlotExplorationResult,
  dossiers: SpainDossier[],
): SlotDiscoveryEvent[] {
  if (dossiers.length === 0) return [];

  const events: SlotDiscoveryEvent[] = [];

  for (const service of exploration.services) {
    for (const slot of service.slots) {
      for (const dossier of dossiers) {
        const inWindow = isSlotInDateWindow(slot.date, dossier);
        events.push({
          applicationId: dossier.applicationId,
          destination: "spain",
          office: service.serviceName || `service_${service.serviceId}`,
          dateFound: slot.date,
          timeFound: slot.time || undefined,
          outcome: inWindow ? "captured" : "ignored",
          reason: inWindow ? undefined : getDateWindowReason(slot.date, dossier),
          context: { serviceId: service.serviceId, freeSlots: slot.freeSlots, applicant: dossier.applicantName },
          mode: "schedule",
        });
      }
    }
  }

  return events;
}

/**
 * Détermine la raison d'ignorement pour un slot hors fenêtre.
 */
function getDateWindowReason(slotDate: string, dossier: SpainDossier): string {
  const slot = new Date(slotDate);
  if (isNaN(slot.getTime())) return "invalid_date";

  if (dossier.slotDateFrom) {
    const from = new Date(dossier.slotDateFrom);
    if (!isNaN(from.getTime()) && slot < from) return "before_from_date";
  }
  if (dossier.slotDateDeadline) {
    const deadline = new Date(dossier.slotDateDeadline);
    if (!isNaN(deadline.getTime()) && slot > deadline) return "after_deadline";
  }
  return "out_of_window";
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

export async function startSpainWatcherLoop(): Promise<void> {
  const modeLabel = SPAIN_PERSISTENT_BROWSER ? "persistent-browser 🌐" : (SPAIN_HTTP_MODE ? "HTTP-ONLY 🚀" : "Playwright");
  log("INFO", `[SPAIN-WATCHER] Boucle démarrée (mode: ${modeLabel}, auto-booking: Convex dossiers)`);
  if (SPAIN_HTTP_MODE) {
    const decodoConfigured = Boolean(process.env.DECODO_PROXY_URL);
    const soaxConfigured = Boolean(process.env.SOAX_PROXY_URL);
    log(
      "INFO",
      `[SPAIN-WATCHER] HTTP proxy: ` +
      `${decodoConfigured ? "Decodo ISP ✅" : "Decodo ISP ❌ (DECODO_PROXY_URL absent)"}` +
      `${!decodoConfigured && soaxConfigured ? " | SOAX fallback ✅" : ""}`,
    );
  }

  // En mode HTTP ou persistent-browser : initialiser Redis avant le pre-warm
  if (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) {
    // 1. Connecter Redis (persistence CF session + SOAX rotation)
    const redisOk = await initSpainRedis().catch((e) => {
      log("WARN", `[SPAIN-WATCHER] Redis init échoué (non-fatal): ${e}`);
      return false;
    });
    if (redisOk) {
      log("INFO", "[SPAIN-WATCHER] ✅ Redis Spain connecté — session CF persistée entre redéploiements");
    }

    // 2. Restaurer le rotation count SOAX (seulement en mode HTTP-only, pas persistent-browser)
    if (SPAIN_HTTP_MODE && !SPAIN_PERSISTENT_BROWSER) {
      await restoreSpainSoaxStateFromRedis().catch((e) => {
        log("WARN", `[SPAIN-WATCHER] Restauration SOAX rotation échouée (non-fatal): ${e}`);
      });
    }

    // 3. Pre-warm la session CF uniquement si un dossier Espagne peut réellement
    // déclencher un booking. On se base directement sur les dossiers actifs —
    // plus de dépendance au singleton spainWatcher (comme la CEV dossier loop).
    const preWarmDossiers = await getActiveSpainDossiers();
    if (preWarmDossiers.length === 0) {
      log("INFO", "[SPAIN-WATCHER] Pre-warm CF différé — aucun dossier Espagne actif avec identifiants (voir diagnostic ci-dessus)");
    } else {
      const preWarmUrl = preWarmDossiers[0].portalUrl;
      const preWarmLabel = SPAIN_PERSISTENT_BROWSER ? "Chromium persistant" : "proxy Espagne + CapSolver";
      log("INFO", `[SPAIN-WATCHER] Pre-warm session CF pour ${preWarmDossiers.length} dossier(s) → ${preWarmUrl} (${preWarmLabel})…`);
      const session = await ensureActiveSession(preWarmUrl).catch((e) => {
        log("WARN", `[SPAIN-WATCHER] Pre-warm CF échoué: ${e} — retry au prochain cycle`);
        return null;
      });
      if (session) {
        log("INFO", `[SPAIN-WATCHER] ✅ Session CF prête (expire: ${new Date(session.expiresAt).toISOString()})`);
      }
    }
  }

  while (true) {
    try {
      const cycleStartedAt = Date.now();

      // Aucun dossier actif = aucun besoin de scanner ni de résoudre Cloudflare.
      // On se base directement sur les dossiers actifs comme la CEV dossier loop —
      // plus de dépendance au singleton spainWatcher.isActive pour démarrer.
      const activeDossiers = await getActiveSpainDossiers();
      if (activeDossiers.length === 0) {
        log("INFO", "[SPAIN-WATCHER] Aucun dossier Espagne actif — probe différé de 2 min");
        await new Promise((r) => setTimeout(r, 2 * 60_000));
        continue;
      }

      // portalUrl = premier dossier actif (tous partagent la même ambassade)
      const portalUrl = activeDossiers[0].portalUrl;

      // Intervalle : singleton spainWatcher optionnel pour override, sinon env var
      const singletonConfig = await getSpainWatcherConfig().catch(() => null);
      const configuredHttpIntervalSec = singletonConfig?.intervalSec ?? SPAIN_HTTP_SCAN_INTERVAL_SEC;
      const intervalMs = (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER)
        ? Math.max(30, configuredHttpIntervalSec) * 1000
        : (singletonConfig?.intervalMin ?? 3) * 60_000;

      const cycleModeLabel = SPAIN_PERSISTENT_BROWSER ? "PB" : (SPAIN_HTTP_MODE ? "HTTP" : "PW");
      log("INFO", `[SPAIN-WATCHER] [${cycleModeLabel}] Probe → ${portalUrl} | ${activeDossiers.length} dossier(s) actif(s) | intervalle: ${Math.round(intervalMs / 1000)}s`);

      // Proactive re-solve si le cookie CF expire bientôt
      if ((SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) && isActiveSessionExpiringSoon()) {
        log("INFO", "[SPAIN-WATCHER] ⏰ Cookie CF expire bientôt → re-solve proactif");
        await ensureActiveSession(portalUrl).catch((e) => {
          log("WARN", `[SPAIN-WATCHER] Re-solve proactif échoué: ${e}`);
        });
      }

      // Exécuter le probe selon le mode
      // persistent-browser utilise le même probe HTTP que SPAIN_HTTP_MODE
      // (la session CF vient du Chromium persistant mais les scans restent HTTP-only)
      const result = (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER)
        ? await runSpainHttpProbe(portalUrl)
        : await runSpainWatcherProbe(portalUrl);

      log(
        "INFO",
        `[SPAIN-WATCHER] [${cycleModeLabel}] Résultat: ${result.status}${result.slotInfo ? ` — ${result.slotInfo}` : ""}${result.errorMessage ? ` (${result.errorMessage})` : ""}`,
      );

      // ─── DIAGNOSTIC: quand found, toujours extraire et logger les services ──
      // Permet de vérifier si c'est un vrai créneau (services rendus) ou un faux positif
      let detectedServicesJson: string | undefined;
      let detectedSlotsJson: string | undefined;
      if (
        (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) &&
        result.status === "found" &&
        (result as any)._mainHtml
      ) {
        const mainHtml = (result as any)._mainHtml as string;

        // Extraction diagnostic — toujours logué, même sans dossier actif
        const diagServices = extractServicesFromHtml(mainHtml);
        if (diagServices.length > 0) {
          detectedServicesJson = JSON.stringify(diagServices.map(s => ({ serviceId: s.serviceId, serviceName: s.serviceName })));
          log("INFO", `[SPAIN-WATCHER] ✅ CRÉNEAU CONFIRMÉ — ${diagServices.length} service(s) rendu(s) dans le HTML :`);
          for (const svc of diagServices) {
            log("INFO", `[SPAIN-WATCHER]    🎯 "${svc.serviceName}" → serviceId: ${svc.serviceId}`);
          }

          // ─── EXPLORATION: naviguer les dates/heures exactes pour chaque service ──
          const cfSessionExplore = getActiveSession();
          if (cfSessionExplore) {
            try {
              const exploration = await exploreAvailableSlots(cfSessionExplore, portalUrl, diagServices);
              detectedSlotsJson = serializeExplorationForConvex(exploration);
              const logLines = formatExplorationForLogs(exploration);
              for (const line of logLines) {
                log("INFO", line);
              }

              // ─── SLOT DISCOVERY REPORTING: émettre les événements vers Convex ──
              if (exploration.totalSlots > 0) {
                const discoveryEvents = buildDiscoveryEventsFromExploration(exploration, activeDossiers);
                if (discoveryEvents.length > 0) {
                  reportSlotDiscoveryBatch(discoveryEvents);
                  log("INFO", `[SPAIN-WATCHER] 📊 ${discoveryEvents.length} slot discovery event(s) reporté(s) (${discoveryEvents.filter(e => e.outcome === "captured").length} captured, ${discoveryEvents.filter(e => e.outcome === "ignored").length} ignored)`);
                }
              }
            } catch (exploreErr) {
              log("WARN", `[SPAIN-WATCHER] ⚠️ Exploration slots échouée (non-fatal): ${exploreErr}`);
            }
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

        const cfSession = getActiveSession();

        if (!cfSession) {
          log("WARN", "[SPAIN-WATCHER] ❌ Auto-booking impossible — pas de session CF active");
        } else {
          // 1. Récupérer les dossiers Espagne actifs depuis Convex
            const dossiers = activeDossiers;

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
                  portalUrl,
                  mainHtml,
                  bookingConfig,
                );

                log(
                  "INFO",
                  `[SPAIN-WATCHER] 📋 ${dossier.applicantName}: ${bookingResult.status}${bookingResult.locator ? ` — locator: ${bookingResult.locator}` : ""}${bookingResult.errorMessage ? ` (${bookingResult.errorMessage})` : ""} (${bookingResult.durationMs}ms)`,
                );

                if (bookingResult.status === "booked") {
                  // ── 0. Report slot discovery outcome: BOOKED ──
                  reportSlotDiscoveryBatch([{
                    applicationId: dossier.applicationId,
                    destination: "spain",
                    office: matched.serviceName,
                    dateFound: result.slotInfo?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? new Date().toISOString().slice(0, 10),
                    outcome: "captured",
                    context: { locator: bookingResult.locator, serviceId: matched.serviceId },
                    mode: "schedule",
                  }]);

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
                  // ── Report slot discovery outcome: FAILED ──
                  reportSlotDiscoveryBatch([{
                    applicationId: dossier.applicationId,
                    destination: "spain",
                    office: matched.serviceName,
                    dateFound: new Date().toISOString().slice(0, 10),
                    outcome: "ignored",
                    reason: `booking_failed_${bookingResult.status}`,
                    context: { errorMessage: bookingResult.errorMessage, serviceId: matched.serviceId },
                    mode: "schedule",
                  }]);

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
        detectedServices: detectedServicesJson,
        detectedSlots: detectedSlotsJson,
      });

      // L'intervalle désigne le temps entre deux débuts de probe, pas le délai
      // ajouté après la fin du probe. Sinon un probe de 35s produisait un cycle
      // réel de 95s malgré le log "intervalle: 60s".
      const nextWaitMs = Math.max(0, intervalMs - (Date.now() - cycleStartedAt));
      log("INFO", `[SPAIN-WATCHER] Prochain probe dans ${Math.ceil(nextWaitMs / 1000)}s (cadence départ-à-départ)`);
      await new Promise((r) => setTimeout(r, nextWaitMs));
    } catch (err) {
      log("WARN", `[SPAIN-WATCHER] Erreur boucle: ${err} — retry dans ${SPAIN_HTTP_MODE ? "1" : "5"} min`);
      await new Promise((r) => setTimeout(r, SPAIN_HTTP_MODE ? 60_000 : 5 * 60_000));
    }
  }
}
