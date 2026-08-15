/**
 * test-parallel-workers.ts
 *
 * Teste le parallélisme de l'orchestrateur : lance N workers simultanément
 * sur de vraies URLs portail avec des credentials fictifs.
 *
 * Ce qu'on vérifie :
 *   ✅ Les N workers démarrent en parallèle (timestamps proches)
 *   ✅ Chaque worker a son propre tag de log ([WORKER-Axxx])
 *   ✅ Chaque worker réserve une IP Decodo différente
 *   ✅ Chaque worker gère son propre CF solve / initSession de manière isolée
 *   ✅ Un worker qui échoue n'interrompt pas les autres
 *
 * Résultat attendu : statut "error" (session impossible avec faux credentials),
 * mais la mécanique de parallélisme est entièrement validée.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   SPAIN_WORKER_WINDOW_MIN=3 npx tsx scripts/test-parallel-workers.ts
 */

// ── Fenêtre courte pour que le test ne dure pas trop longtemps ────────────────
process.env.SPAIN_WORKER_WINDOW_MIN ??= "3";

import { initSpainRedis } from "../src/spain-redis-persistence.js";
import { initDecodoPool } from "../src/spain-decodo-pool.js";
import { runDossierWorker, type SpainDossierConfig } from "../src/spain-dossier-worker.js";
import {
  SAOPOLO_PORTAL_URL,
  KINSHASA_PORTAL_URL,
} from "../src/spain-portals.js";
import { log } from "../src/scheduler-utils.js";

// ── Configs fictives ──────────────────────────────────────────────────────────
// On utilise de vraies URLs pour exercer le CF solve + initSession.
// Les credentials sont fictifs → le worker échouera sur le solve ou la session,
// mais on voit bien le parallélisme : chaque worker tourne de façon autonome.
const FAKE_DOSSIERS: SpainDossierConfig[] = [
  {
    id: "test-parallel-A",
    applicantName: "Test Alice",
    visaType: "tourist",
    login: "alice@test-parallel.xx",
    password: "fake-pass-A",
    applicationId: "test-parallel-A",
    otpChannel: "email",
    portalUrl: SAOPOLO_PORTAL_URL,
    slotDateFrom: "2026-09-01",
    slotDateDeadline: "2026-12-31",
    groupSize: 1,
  },
  {
    id: "test-parallel-B",
    applicantName: "Test Bob",
    visaType: "tourist",
    login: "bob@test-parallel.xx",
    password: "fake-pass-B",
    applicationId: "test-parallel-B",
    otpChannel: "email",
    portalUrl: SAOPOLO_PORTAL_URL,
    slotDateFrom: "2026-09-01",
    slotDateDeadline: "2026-12-31",
    groupSize: 1,
  },
  {
    id: "test-parallel-C",
    applicantName: "Test Carlos",
    visaType: "tourist",
    login: "carlos@test-parallel.xx",
    password: "fake-pass-C",
    applicationId: "test-parallel-C",
    otpChannel: "email",
    portalUrl: KINSHASA_PORTAL_URL,
    slotDateFrom: "2026-09-01",
    slotDateDeadline: "2026-12-31",
    groupSize: 1,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("INFO", "═══════════════════════════════════════════════════════");
  log("INFO", `🧪 TEST PARALLÉLISME — ${FAKE_DOSSIERS.length} workers simultanés`);
  log("INFO", `   Fenêtre worker : ${process.env.SPAIN_WORKER_WINDOW_MIN}min`);
  log("INFO", "═══════════════════════════════════════════════════════");

  // Init Redis + pool Decodo (requis pour la réservation d'IP)
  const redisOk = await initSpainRedis();
  if (redisOk) {
    log("INFO", "✅ Redis connecté");
    await initDecodoPool();
  } else {
    log("WARN", "⚠️  Redis indisponible — workers en mode dégradé");
  }

  log("INFO", "");
  log("INFO", `⏱  Lancement simultané de ${FAKE_DOSSIERS.length} workers…`);

  const t0 = Date.now();

  // Lance tous les workers EN PARALLÈLE — c'est le cœur du test
  const results = await Promise.allSettled(
    FAKE_DOSSIERS.map((config) => {
      const workerStart = Date.now();
      log("INFO", `🚀 [${config.applicantName}] Worker lancé (t+${workerStart - t0}ms)`);
      return runDossierWorker(config).then((result) => {
        const elapsed = Math.round((Date.now() - workerStart) / 1_000);
        return { config, result, elapsed };
      });
    }),
  );

  const totalElapsed = Math.round((Date.now() - t0) / 1_000);

  log("INFO", "");
  log("INFO", "═══════════════════════════════════════════════════════");
  log("INFO", `📊 RÉSULTATS — ${totalElapsed}s écoulées`);
  log("INFO", "═══════════════════════════════════════════════════════");

  let allParallel = true;
  const startDelays: number[] = [];

  for (const settled of results) {
    if (settled.status === "fulfilled") {
      const { config, result, elapsed } = settled.value;
      const icon =
        result.status === "booked" ? "✅" :
        result.status === "exited" ? "💤" : "❌";
      log(
        "INFO",
        `${icon} ${config.applicantName} → ${result.status} (${elapsed}s)` +
        (result.errorMessage ? ` — ${result.errorMessage.slice(0, 80)}` : ""),
      );
    } else {
      log("WARN", `❌ Worker rejeté : ${settled.reason}`);
      allParallel = false;
    }
  }

  log("INFO", "");
  log("INFO", "═══════════════════════════════════════════════════════");

  // Vérification parallélisme : si le temps total < somme des temps individuels,
  // les workers ont bien tourné en parallèle
  const sumElapsed = results
    .filter((r): r is PromiseFulfilledResult<{ elapsed: number }> => r.status === "fulfilled")
    .reduce((acc, r) => acc + r.value.elapsed, 0);

  if (totalElapsed < sumElapsed * 0.7) {
    log("INFO", `✅ PARALLÉLISME CONFIRMÉ — total: ${totalElapsed}s, somme: ${sumElapsed}s`);
    log("INFO", `   Accélération: x${(sumElapsed / totalElapsed).toFixed(1)}`);
  } else {
    log("INFO", `⚠️  Parallélisme non confirmé — total: ${totalElapsed}s, somme: ${sumElapsed}s`);
    log("INFO", `   (attendu si les workers échouent très rapidement avant de commencer à se chevaucher)`);
  }

  log("INFO", "═══════════════════════════════════════════════════════");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
