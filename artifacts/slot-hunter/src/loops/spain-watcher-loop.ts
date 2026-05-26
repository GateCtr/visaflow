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
import { isSpainCfSessionExpiringSoon, ensureSpainCfSession, restoreSpainSoaxStateFromRedis } from "../spain-soax-solver.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { log } from "../scheduler-utils.js";

const SPAIN_HTTP_MODE = process.env.SPAIN_HTTP_MODE === "1";

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

      // En mode HTTP : intervalle beaucoup plus court (30-60s vs 3min)
      const defaultIntervalMin = SPAIN_HTTP_MODE ? 0.5 : 3; // 30s en HTTP, 3min en Playwright
      const intervalMs = (config.intervalMin ?? defaultIntervalMin) * 60_000;
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
