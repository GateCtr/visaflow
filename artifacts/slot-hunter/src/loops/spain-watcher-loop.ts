// ─── Spain Watcher Loop — veille créneaux Espagne ────────────────────────────
// Extracted from index.ts
// Boucle indépendante, tourne en background.

import { getSpainWatcherConfig, uploadFile, reportSpainWatcherScan } from "../convexClient.js";
import { runSpainWatcherProbe } from "../spainPortal.js";
import { log } from "../scheduler-utils.js";

export async function startSpainWatcherLoop(): Promise<void> {
  log("INFO", "[SPAIN-WATCHER] Boucle démarrée");
  while (true) {
    try {
      const config = await getSpainWatcherConfig();

      if (!config || !config.isActive) {
        await new Promise((r) => setTimeout(r, 2 * 60_000));
        continue;
      }

      const intervalMs = (config.intervalMin ?? 15) * 60_000;
      log("INFO", `[SPAIN-WATCHER] Probe → ${config.portalUrl} (intervalle: ${config.intervalMin ?? 15} min)`);

      const result = await runSpainWatcherProbe(config.portalUrl);
      log(
        "INFO",
        `[SPAIN-WATCHER] Résultat: ${result.status}${result.slotInfo ? ` — ${result.slotInfo}` : ""}${result.errorMessage ? ` (${result.errorMessage})` : ""}`,
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
      log("WARN", `[SPAIN-WATCHER] Erreur boucle: ${err} — retry dans 5 min`);
      await new Promise((r) => setTimeout(r, 5 * 60_000));
    }
  }
}
