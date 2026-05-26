// ─── Spain Watcher Loop — veille créneaux Espagne ────────────────────────────
// Extracted from index.ts
// Boucle indépendante, tourne en background.
//
// MODES :
//   - SPAIN_HTTP_MODE=1 → scan HTTP pur (impit + SOAX + CapSolver CF cookie)
//     ✅ 10x plus rapide, 0 RAM browser, scan toutes les 30-60s
//     Prérequis : SOAX_PROXY_URL + CAPSOLVER_API_KEY
//   - SPAIN_HTTP_MODE=0 (défaut) → Playwright stealth (ancien mode)

import { getSpainWatcherConfig, uploadFile, reportSpainWatcherScan } from "../convexClient.js";
import { runSpainWatcherProbe } from "../spainPortal.js";
import { runSpainHttpProbe } from "../spain-http-scanner.js";
import { isSpainCfSessionExpiringSoon, ensureSpainCfSession, getActiveSpainCfSession, restoreSpainSoaxStateFromRedis } from "../spain-soax-solver.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { executeHttpBooking, type SpainBookingConfig } from "../spain-http-booking.js";
import { log } from "../scheduler-utils.js";

const SPAIN_HTTP_MODE = process.env.SPAIN_HTTP_MODE === "1";
const SPAIN_AUTO_BOOK = process.env.SPAIN_AUTO_BOOK === "1";

export async function startSpainWatcherLoop(): Promise<void> {
  log("INFO", `[SPAIN-WATCHER] Boucle démarrée (mode: ${SPAIN_HTTP_MODE ? "HTTP-ONLY 🚀" : "Playwright"})`);

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
    // Get config first to use the actual portal URL for CF solve
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

      // En mode HTTP : intervalle fixe 30s (ignore config Convex qui est calibrée pour Playwright)
      // En mode Playwright : utilise config.intervalMin (défaut 3min)
      const intervalMs = SPAIN_HTTP_MODE
        ? 30_000 // 30s — scan ultra-rapide, coût CF nul (1 solve = 2h)
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

      // ─── AUTO-BOOKING HTTP-ONLY ─────────────────────────────────────────
      // Si créneau détecté + SPAIN_AUTO_BOOK=1 + credentials configurés
      // → tenter le booking immédiatement via HTTP (pas de Playwright)
      if (
        SPAIN_HTTP_MODE &&
        SPAIN_AUTO_BOOK &&
        result.status === "found" &&
        (result as any)._mainHtml
      ) {
        const bookLogin = process.env.SPAIN_BOOK_LOGIN ?? "";
        const bookPassword = process.env.SPAIN_BOOK_PASSWORD ?? "";

        if (bookLogin && bookPassword) {
          log("INFO", "[SPAIN-WATCHER] 🚀 AUTO-BOOKING DÉCLENCHÉ — créneau détecté !");

          const cfSession = getActiveSpainCfSession();
          if (cfSession) {
            const bookingConfig: SpainBookingConfig = {
              login: bookLogin,
              password: bookPassword,
              applicationId: process.env.SPAIN_BOOK_APP_ID,
              otpChannel: (process.env.SPAIN_OTP_CHANNEL as "email" | "sms" | "manual") ?? "email",
            };

            try {
              const bookingResult = await executeHttpBooking(
                cfSession,
                config.portalUrl,
                (result as any)._mainHtml,
                bookingConfig,
              );

              log("INFO", `[SPAIN-WATCHER] 📋 Booking result: ${bookingResult.status}${bookingResult.locator ? ` — locator: ${bookingResult.locator}` : ""}${bookingResult.errorMessage ? ` (${bookingResult.errorMessage})` : ""} (${bookingResult.durationMs}ms)`);

              if (bookingResult.status === "booked") {
                // Override slotInfo with booking confirmation
                result.slotInfo = `✅ BOOKING CONFIRMÉ ! Locator: ${bookingResult.locator ?? "N/A"} | ${result.slotInfo}`;
              }
            } catch (bookErr) {
              log("WARN", `[SPAIN-WATCHER] ❌ Auto-booking erreur: ${bookErr}`);
            }
          } else {
            log("WARN", "[SPAIN-WATCHER] Auto-booking impossible — pas de session CF active");
          }
        } else {
          log("INFO", "[SPAIN-WATCHER] ⚠️ Créneau trouvé mais SPAIN_BOOK_LOGIN/PASSWORD non configurés — alerte seule");
        }
      }

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
