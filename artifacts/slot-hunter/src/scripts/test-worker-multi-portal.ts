/**
 * test-worker-multi-portal.ts
 *
 * Lance N workers Espagne en parallèle via le VRAI runDossierWorker (code prod exact),
 * avec le VRAI pool de réserve partagé (createReservePool, injecté comme dans
 * l'orchestrateur task 11.1). Aucune logique métier n'est réimplémentée : en cas
 * d'échec, la trace pointe directement le code qui part en prod. Sert à valider
 * bout-en-bout les hypothèses du spec `spain-synchronized-scan` sur des portails réels :
 *   - scan synchronisé sur grille d'horloge murale (fronts communs + jitter),
 *   - mode RACE (détection découplée du booking, publication snapshot),
 *   - récupération asynchrone non bloquante (proxy mort / cf_expired / session morte),
 *   - ralentissement tardif conditionnel.
 *
 * Mode test :
 *   - SPAIN_BYPASS_WINDOW=1  : fenêtre relative à `now` (pas HH:05→HH:25), pour tourner
 *                              hors de la fenêtre horaire réelle.
 *   - identifiants FACTICES  : les workers traversent le flux jusqu'au rejet signin/
 *                              ("Usuario o contraseña incorrectos") — aucun booking réel.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   # Kinshasa (fermé / 0 créneau attendu), 20 dossiers, fenêtre 3 min :
 *   npx tsx src/scripts/test-worker-multi-portal.ts kinshasa 20 3
 *   # São Paulo (créneaux attendus), 20 dossiers, fenêtre 3 min :
 *   npx tsx src/scripts/test-worker-multi-portal.ts saopolo 20 3
 *
 * Arguments (positionnels) :
 *   1. portail        : "kinshasa" | "saopolo" | "cuba"   (défaut: kinshasa)
 *   2. nbWorkers      : entier 1..30                       (défaut: 20)
 *   3. fenêtre (min)  : entier                             (défaut: 3)
 */
import "dotenv/config";

// ─── Arguments ────────────────────────────────────────────────────────────────

const PORTAL_ARG = (process.argv[2] ?? "kinshasa").toLowerCase();
const N = Math.max(1, Math.min(30, parseInt(process.argv[3] ?? "20", 10)));
const WINDOW_MIN = Math.max(1, parseInt(process.argv[4] ?? "3", 10));

// ─── Mode test : fenêtre relative à now (hors fenêtre horaire réelle) ─────────
// IMPORTANT : ces variables DOIVENT être posées AVANT tout import des modules prod.
// `WORKER_WINDOW_MS` (spain-dossier-worker.ts) est une constante évaluée au CHARGEMENT
// du module ; si on l'importe statiquement, la fenêtre est figée au défaut (25 min)
// avant même que ce set n'ait lieu. On utilise donc des imports DYNAMIQUES plus bas.
process.env.SPAIN_BYPASS_WINDOW = "1";
process.env.SPAIN_WORKER_WINDOW_MIN = String(WINDOW_MIN);

// ─── Imports dynamiques des exports PROD (après le set env ci-dessus) ─────────
// Aucune réimplémentation : on charge exactement le code qui part en prod.
const { initSpainRedis } = await import("../spain-redis-persistence.js");
const { initDecodoPool } = await import("../spain-decodo-pool.js");
const { runDossierWorker } = await import("../spain-dossier-worker.js");
type SpainDossierConfig = import("../spain-dossier-worker.js").SpainDossierConfig;
type WorkerResult = import("../spain-dossier-worker.js").WorkerResult;
// Pool de réserve partagé injecté dans runDossierWorker, comme l'orchestrateur (task 11.1).
const { createReservePool } = await import("../spain/spain-reserve-pool.js");
type ReservePoolManager = import("../spain/spain-reserve-pool.js").ReservePoolManager;
const { KINSHASA_PORTAL_URL, SAOPOLO_PORTAL_URL, CUBA_LMD_PORTAL_URL } = await import(
  "../spain-portals.js"
);

interface PortalChoice {
  readonly label: string;
  readonly url: string;
  readonly expectation: string;
}

function resolvePortal(arg: string): PortalChoice {
  switch (arg) {
    case "saopolo":
    case "saopaulo":
    case "sao":
      return { label: "São Paulo", url: SAOPOLO_PORTAL_URL, expectation: "créneaux disponibles (~331 sept.)" };
    case "cuba":
    case "lmd":
      return { label: "Cuba / LMD", url: CUBA_LMD_PORTAL_URL, expectation: "créneaux disponibles (~4193)" };
    case "kinshasa":
    case "rdc":
    default:
      return { label: "Kinshasa (RDC)", url: KINSHASA_PORTAL_URL, expectation: "fermé / 0 créneau" };
  }
}

const PORTAL = resolvePortal(PORTAL_ARG);

// ─── Helpers d'affichage ──────────────────────────────────────────────────────

const T0 = Date.now();
const ts = (): string => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const COLORS = [
  "\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m", "\x1b[34m", "\x1b[91m",
  "\x1b[93m", "\x1b[96m", "\x1b[92m", "\x1b[95m",
];
const RESET = "\x1b[0m";
const colorFor = (i: number): string => COLORS[i % COLORS.length] ?? RESET;

function banner(msg: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${msg}\n${"═".repeat(72)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner(`test-worker-multi-portal — ${N} workers sur ${PORTAL.label}`);
  console.log(`[${ts()}] Portail  : ${PORTAL.url}`);
  console.log(`[${ts()}] Attendu  : ${PORTAL.expectation}`);
  console.log(`[${ts()}] Workers  : ${N}`);
  console.log(`[${ts()}] Fenêtre  : ${WINDOW_MIN} min (SPAIN_BYPASS_WINDOW=1)`);
  console.log(`[${ts()}] Ident.   : FACTICES → rejet signin/, aucun booking réel\n`);

  // ── 1. Init Redis + Decodo (identique à test-worker-parallel) ────────────────
  console.log(`[${ts()}] ▶  Init Redis…`);
  try {
    await initSpainRedis();
    console.log(`[${ts()}] ✅ Redis OK`);
  } catch (e) {
    console.warn(`[${ts()}] ⚠️  Redis: ${e} (mode dégradé — la coordination Redis sera limitée)`);
  }

  console.log(`[${ts()}] ▶  Init Decodo pool…`);
  try {
    await initDecodoPool();
    console.log(`[${ts()}] ✅ Decodo pool OK`);
  } catch (e) {
    console.warn(`[${ts()}] ⚠️  Decodo: ${e}`);
  }

  // ── 1b. Pool de réserve PARTAGÉ (export prod createReservePool) ──────────────
  // Injecté dans chaque runDossierWorker comme le fait l'orchestrateur (task 11.1) :
  // couvre le chemin de récupération par swap de réserve (~0 s) en cas de proxy mort.
  // targetSize borné [1,100] par le pool (défaut 4, override SPAIN_RESERVE_POOL_SIZE).
  const reservePool: ReservePoolManager = createReservePool({
    targetSize: Number(process.env.SPAIN_RESERVE_POOL_SIZE ?? "4"),
  });
  console.log(`[${ts()}] ✅ Reserve pool partagé (targetSize=${reservePool.targetSize})`);

  // ── 1c. Preflight : warmUp du pool (export prod, comme l'orchestrateur task 11.1) ──
  // Pré-solve les réserves EN AVANCE pour que les swaps de récupération ne repartent
  // pas sur un CF solve à froid. Séquentiel côté pool → n'aggrave pas le rate limit.
  // Désactivable via SPAIN_TEST_SKIP_WARMUP=1 (utile pour les runs de PREUVE de synchro :
  // le warmUp retarde le démarrage de ~160s et étale l'init, masquant la convergence).
  const capsolverKey = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
  if (process.env.SPAIN_TEST_SKIP_WARMUP === "1") {
    console.log(`[${ts()}] ⏭️  warmUp SKIP (SPAIN_TEST_SKIP_WARMUP=1) — démarrage direct des workers`);
  } else {
    console.log(`[${ts()}] ▶  Preflight warmUp du pool de réserve…`);
    try {
      await reservePool.warmUp(capsolverKey, PORTAL.url);
      console.log(`[${ts()}] ✅ Pool réchauffé : ${reservePool.size()}/${reservePool.targetSize} réserve(s) prête(s)`);
    } catch (e) {
      console.warn(`[${ts()}] ⚠️  warmUp: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── 2. Construire N configs à identifiants factices ──────────────────────────
  const configs: SpainDossierConfig[] = Array.from({ length: N }, (_, i) => ({
    id: `test-${PORTAL_ARG}-${String(i + 1).padStart(2, "0")}`,
    applicantName: `${PORTAL.label.toUpperCase()} ${i + 1}`,
    visaType: "schengen" as const,
    login: `LOGIN_${PORTAL_ARG.toUpperCase()}_${i + 1}`,
    password: `PASS_${i + 1}`,
    applicationId: `test-${PORTAL_ARG}-${String(i + 1).padStart(2, "0")}`,
    otpChannel: "manual" as const,
    portalUrl: PORTAL.url,
    groupSize: 1,
  }));

  // ── 3. Lancer en parallèle (démarrages échelonnés pour lisser CapSolver) ─────
  banner(`Lancement parallèle — ${N} workers (logs entrelacés)`);

  const promises = configs.map((cfg, i) => {
    const color = colorFor(i);
    const label = `[W${String(i + 1).padStart(2, "0")}:${cfg.id}]`;
    // Décalage de démarrage : lisse la charge CapSolver/Decodo au boot (CapSolver
    // rate-limite les createTask/getBalance simultanés). La grille d'horloge murale
    // resynchronise ensuite les workers sur des fronts communs. Override via
    // SPAIN_TEST_STAGGER_MS (défaut 1200 ms → ~24 s d'étalement pour 20 workers).
    const staggerMs = Number(process.env.SPAIN_TEST_STAGGER_MS ?? "1200");
    const delay = i * (Number.isFinite(staggerMs) ? staggerMs : 1200);
    return new Promise<{ worker: number; status: string; error?: string }>((resolve) => {
      setTimeout(() => {
        console.log(`${color}[${ts()}] ${label} 🚀 démarrage…${RESET}`);
        // Export PROD exact : runDossierWorker(config, reservePool) — même signature
        // que l'appel de l'orchestrateur. Aucune logique métier réimplémentée ici.
        runDossierWorker(cfg, reservePool)
          .then((result: WorkerResult) => {
            console.log(
              `${color}[${ts()}] ${label} 🏁 terminé — status: ${result.status}` +
                `${result.errorMessage ? ` | ${result.errorMessage}` : ""}${RESET}`,
            );
            resolve({ worker: i + 1, status: result.status, error: result.errorMessage });
          })
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`${color}[${ts()}] ${label} 💥 exception: ${msg}${RESET}`);
            resolve({ worker: i + 1, status: "error", error: msg });
          });
      }, delay);
    });
  });

  const results = await Promise.all(promises);

  // ── 4. Résumé ────────────────────────────────────────────────────────────────
  banner("Résumé");
  for (const r of results) {
    const color = colorFor(r.worker - 1);
    console.log(`${color}  Worker ${String(r.worker).padStart(2, "0")} → ${r.status}${r.error ? ` (${r.error})` : ""}${RESET}`);
  }

  const count = (s: string): number => results.filter((r) => r.status === s).length;
  const booked = count("booked");
  console.log(
    `\n  Total : ${booked} booked | ${count("exited")} exited | ${count("booking_failed")} booking_failed | ${count("error")} error`,
  );
  console.log(`  Portail : ${PORTAL.label} | Workers : ${N} | Durée : ${ts()}\n`);

  if (booked > 0) {
    console.log("🚨 BOOKING(S) avec identifiants factices — vérifier / annuler immédiatement.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
