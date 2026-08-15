/**
 * test-worker-single-dossier.ts
 *
 * Lance runDossierWorker() pour UN SEUL dossier Espagne actif.
 *
 * Objectif : vérifier que le nouveau flux dynamic (initPhpState + scanDatetimeDirect)
 * arrive bien jusqu'à getsigninfields/ → signin/ sans bloquer sur getagendas/ 0B.
 *
 * Usage :
 *   # Premier dossier actif automatique (Kinshasa) :
 *   SPAIN_WORKER_WINDOW_MIN=5 SPAIN_HTTP_SCAN_INTERVAL_SEC=30 \
 *     node_modules/.bin/tsx src/scripts/test-worker-single-dossier.ts
 *
 *   # Forcer un dossier spécifique par nom (substring) :
 *   SPAIN_WORKER_WINDOW_MIN=5 SPAIN_HTTP_SCAN_INTERVAL_SEC=30 \
 *     node_modules/.bin/tsx src/scripts/test-worker-single-dossier.ts "Dupont"
 *
 *   # Mode Cuba — portail hardcodé, proxy CSV, pas de Convex :
 *   SPAIN_WORKER_WINDOW_MIN=5 SPAIN_HTTP_SCAN_INTERVAL_SEC=30 \
 *     node_modules/.bin/tsx src/scripts/test-worker-single-dossier.ts cuba
 */
import "dotenv/config";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { initDecodoPool } from "../spain-decodo-pool.js";
import { getActiveJobs, type HunterJob } from "../convexClient.js";
import { runDossierWorker, type SpainDossierConfig } from "../spain-dossier-worker.js";
import { CUBA_LMD_PORTAL_URL } from "../spain-portals.js";

const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function L(level: string, msg: string) {
  const icon: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶ " };
  console.log(`[${ts()}] ${icon[level] ?? "  "} ${msg}`);
}

const ARG = process.argv[2]?.toLowerCase() ?? "";
const CUBA_MODE = ARG === "cuba";
const NAME_FILTER = CUBA_MODE ? "" : ARG;

async function main() {
  L("STEP", "=== test-worker-single-dossier.ts ===");
  L("INFO", `Window: ${process.env.SPAIN_WORKER_WINDOW_MIN ?? "25"} min | Interval: ${process.env.SPAIN_HTTP_SCAN_INTERVAL_SEC ?? "10"} s`);

  // ── 1. Init Redis + Decodo pool ─────────────────────────────────────────────
  L("STEP", "1 — Init Redis + Decodo pool");
  try {
    await initSpainRedis();
    L("OK", "Redis OK");
  } catch (e) {
    L("WARN", `Redis: ${e} (on continue sans Redis)`);
  }

  try {
    await initDecodoPool();
    L("OK", "Decodo pool OK");
  } catch (e) {
    L("WARN", `Decodo pool: ${e}`);
  }

  // ── 2. Construire le config du dossier cible ───────────────────────────────
  let config: SpainDossierConfig;

  if (CUBA_MODE) {
    // Mode Cuba : portail hardcodé, credentials factices (on teste PHP init seulement)
    L("STEP", "2 — Mode Cuba (portail hardcodé, proxy CSV)");
    config = {
      id:            "test-cuba-001",
      applicantName: "TEST CUBA",
      visaType:      "visa",
      login:         "TESTLOGIN",
      password:      "TESTPASSWORD",
      applicationId: "test-cuba-001",
      otpChannel:    "email",
      portalUrl:     CUBA_LMD_PORTAL_URL,
      groupSize:     1,
    };
    L("OK", `Portal : ${CUBA_LMD_PORTAL_URL}`);
    L("INFO", "Proxy  : pool CSV (es.decodo.com)");
  } else {
    L("STEP", "2 — Récupération dossiers Espagne actifs depuis Convex");
    let jobs: HunterJob[] = [];
    try {
      jobs = await getActiveJobs();
      L("OK", `${jobs.length} job(s) actifs au total`);
    } catch (e) {
      L("ERR", `getActiveJobs échoué: ${e}`);
      process.exit(1);
    }

    const spainDestinations = ["spain", "espagne", "es"];
    let spainJobs = jobs
      .filter((j: HunterJob) => spainDestinations.includes(j.destination))
      .filter((j: HunterJob) => j.hunterConfig?.isActive === true)
      .filter((j: HunterJob) => !!j.hunterConfig.embassyUsername && !!j.hunterConfig.embassyPassword)
      .filter((j: HunterJob) => !!(j.portalUrl ?? (j.hunterConfig as any).scheduleUrl));

    if (NAME_FILTER) {
      spainJobs = spainJobs.filter((j: HunterJob) =>
        j.applicantName.toLowerCase().includes(NAME_FILTER)
      );
      L("INFO", `Filtre nom "${NAME_FILTER}" → ${spainJobs.length} dossier(s)`);
    }

    if (spainJobs.length === 0) {
      const allDests = [...new Set(jobs.map((j: HunterJob) => j.destination))].join(", ");
      L("ERR", `Aucun dossier Espagne actif. Destinations disponibles: [${allDests}]`);
      process.exit(1);
    }

    const targetJob = spainJobs[0];
    config = {
      id:            targetJob.id,
      applicantName: targetJob.applicantName,
      visaType:      targetJob.visaType,
      login:         targetJob.hunterConfig.embassyUsername,
      password:      targetJob.hunterConfig.embassyPassword,
      applicationId: targetJob.id,
      otpChannel:    (targetJob.spainOtpConfig?.channel ?? "email") as "email" | "sms" | "manual",
      slotDateFrom:  targetJob.hunterConfig.slotDateFrom,
      slotDateDeadline: targetJob.hunterConfig.slotDateDeadline,
      portalUrl:     targetJob.portalUrl ?? (targetJob.hunterConfig as any).scheduleUrl ?? "",
      groupSize:     targetJob.hunterConfig.groupSize,
    };

    L("OK", "Dossier sélectionné :");
    L("INFO", `  Nom          : ${config.applicantName}`);
    L("INFO", `  Login        : ${config.login}`);
    L("INFO", `  Portal URL   : ${config.portalUrl}`);
    L("INFO", `  groupSize    : ${config.groupSize ?? 1}`);
    L("INFO", `  Dates        : ${config.slotDateFrom ?? "?"} → ${config.slotDateDeadline ?? "?"}`);
    L("INFO", `  applicationId: ${config.applicationId}`);
    L("INFO", `  Autres dossiers disponibles: ${spainJobs.slice(1).map(j => j.applicantName).join(", ") || "(aucun)"}`);
  }

  // ── 3. Lancer runDossierWorker ──────────────────────────────────────────────
  L("STEP", "3 — runDossierWorker (nouveau flux dynamic)");
  L("INFO", "Les logs suivants sont émis par le worker lui-même…");
  console.log("─".repeat(70));

  const result = await runDossierWorker(config);

  console.log("─".repeat(70));
  L("STEP", "4 — Résultat");
  L(result.status === "booked" ? "OK" : result.status === "error" ? "ERR" : "INFO",
    `Status: ${result.status}${result.errorMessage ? ` | ${result.errorMessage}` : ""}`
  );

  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
