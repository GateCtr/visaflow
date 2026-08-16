/**
 * test-worker-parallel.ts
 *
 * Lance N workers Cuba en parallèle sur le MÊME agenda (bkt316096).
 * Objectif : valider que :
 *   1. Chaque worker tente de clamer un créneau différent (pas de collision)
 *   2. Si worker A clame 2026-09-16 13:30, worker B passe à 2026-09-16 13:40, etc.
 *   3. La coordination Redis (tryClaimSlot) fonctionne sous charge parallèle
 *   4. Les messages serveur (getsigninfields, signin, Usuario o contraseña) s'affichent
 *
 * Usage :
 *   # 3 workers simultanés (défaut) :
 *   SPAIN_WORKER_WINDOW_MIN=3 SPAIN_HTTP_SCAN_INTERVAL_SEC=999 \
 *     node_modules/.bin/tsx src/scripts/test-worker-parallel.ts
 *
 *   # 5 workers :
 *   SPAIN_WORKER_WINDOW_MIN=3 SPAIN_HTTP_SCAN_INTERVAL_SEC=999 \
 *     node_modules/.bin/tsx src/scripts/test-worker-parallel.ts 5
 */
import "dotenv/config";
import { initSpainRedis }   from "../spain-redis-persistence.js";
import { initDecodoPool }   from "../spain-decodo-pool.js";
import { runDossierWorker, type SpainDossierConfig } from "../spain-dossier-worker.js";
import { CUBA_LMD_PORTAL_URL } from "../spain-portals.js";

const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const N  = Math.max(2, Math.min(8, parseInt(process.argv[2] ?? "3", 10)));

// ─── couleurs ANSI pour distinguer les workers ────────────────────────────────
const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m", "\x1b[34m", "\x1b[91m", "\x1b[93m", "\x1b[96m"];
const RESET  = "\x1b[0m";

function banner(msg: string) {
  console.log(`\n${"═".repeat(72)}\n  ${msg}\n${"═".repeat(72)}`);
}

async function main() {
  banner(`test-worker-parallel — ${N} workers Cuba en parallèle`);
  console.log(`[${ts()}] Window  : ${process.env.SPAIN_WORKER_WINDOW_MIN ?? "25"} min`);
  console.log(`[${ts()}] Interval: ${process.env.SPAIN_HTTP_SCAN_INTERVAL_SEC ?? "10"} s`);
  console.log(`[${ts()}] Portal  : ${CUBA_LMD_PORTAL_URL}`);
  console.log(`[${ts()}] Workers : ${N}\n`);

  // ── 1. Init Redis + Decodo ──────────────────────────────────────────────────
  console.log(`[${ts()}] ▶  Init Redis…`);
  try {
    await initSpainRedis();
    console.log(`[${ts()}] ✅ Redis OK`);
  } catch (e) {
    console.warn(`[${ts()}] ⚠️  Redis: ${e} (dégradé)`);
  }

  console.log(`[${ts()}] ▶  Init Decodo pool…`);
  try {
    await initDecodoPool();
    console.log(`[${ts()}] ✅ Decodo pool OK`);
  } catch (e) {
    console.warn(`[${ts()}] ⚠️  Decodo: ${e}`);
  }

  // ── 2. Construire N configs ─────────────────────────────────────────────────
  // Identifiants factices — les workers iront jusqu'à signin/ et obtiendront
  // "Usuario o contraseña incorrectos" du serveur, ce qui prouve la coordination.
  const configs: SpainDossierConfig[] = Array.from({ length: N }, (_, i) => ({
    id:            `test-cuba-par-${String(i + 1).padStart(2, "0")}`,
    applicantName: `CUBA PARALLEL ${i + 1}`,
    visaType:      "visa" as const,
    login:         `LOGIN_PAR_${i + 1}`,
    password:      `PASS_PAR_${i + 1}`,
    applicationId: `test-cuba-par-${String(i + 1).padStart(2, "0")}`,
    otpChannel:    "email" as const,
    portalUrl:     CUBA_LMD_PORTAL_URL,
    groupSize:     1,
  }));

  // ── 3. Lancer en parallèle ──────────────────────────────────────────────────
  banner("Lancement parallèle — les logs de chaque worker sont entrelacés");

  const colorFor = (i: number) => COLORS[i % COLORS.length]!;

  const promises = configs.map((cfg, i) => {
    const color = colorFor(i);
    const label = `[W${i + 1}:${cfg.id}]`;
    // Petit décalage de démarrage pour rendre les logs plus lisibles
    const delay = i * 150;
    return new Promise<{ worker: number; status: string }>((resolve) => {
      setTimeout(async () => {
        console.log(`${color}[${ts()}] ${label} 🚀 démarrage…${RESET}`);
        try {
          const result = await runDossierWorker(cfg);
          console.log(`${color}[${ts()}] ${label} 🏁 terminé — status: ${result.status}${
            result.errorMessage ? ` | ${result.errorMessage}` : ""
          }${RESET}`);
          resolve({ worker: i + 1, status: result.status });
        } catch (e) {
          console.error(`${color}[${ts()}] ${label} 💥 exception: ${e}${RESET}`);
          resolve({ worker: i + 1, status: "error" });
        }
      }, delay);
    });
  });

  const results = await Promise.all(promises);

  // ── 4. Résumé ───────────────────────────────────────────────────────────────
  banner("Résumé");
  for (const r of results) {
    const color = colorFor(r.worker - 1);
    console.log(`${color}  Worker ${r.worker} → ${r.status}${RESET}`);
  }

  const booked  = results.filter((r) => r.status === "booked").length;
  const exited  = results.filter((r) => r.status === "exited").length;
  const errors  = results.filter((r) => r.status === "error").length;
  console.log(`\n  Total : ${booked} booked | ${exited} exited | ${errors} error`);
  console.log(`  Durée : ${ts()}\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
