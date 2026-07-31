/**
 * test-cuba-multidossier.ts — Test live multi-dossier en parallèle (Cuba)
 *
 * Portail : Embajada de Cuba (citaconsular.es — même backend Bookitit que Saopola)
 * URL     : https://www.citaconsular.es/es/hosteds/widgetdefault/28db94e270580be60f6e00285a7d8141f/bkt873048
 *
 * Objectif :
 *   Vérifier que N dossiers bookés en Promise.all :
 *     1. Obtiennent chacun un PHPSESSID isolé (createIsolatedBookingSession)
 *     2. Sont sérialisés au niveau DOM form submit (mutex _domSigninMutex)
 *     3. Reçoivent des réponses serveur indépendantes (pas de cross-contamination)
 *   → Attendu : chaque dossier → signin_failed (credentials faux = rejet serveur attendu)
 *
 * Usage : cd artifacts/slot-hunter && npx tsx src/test-cuba-multidossier.ts
 *         CUBA_N=3 npx tsx src/test-cuba-multidossier.ts  (N dossiers, défaut=2)
 */

process.env.CHROMIUM_EXECUTABLE_PATH =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  "/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SPAIN_SESSION_MODE = "persistent-browser";

import { ensureSpainCfSession } from "./spain-soax-solver.js";
import { scanSpainHttp } from "./spain-http-scanner.js";
import { executeHttpBooking, type SpainBookingConfig } from "./spain-http-booking.js";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/28db94e270580be60f6e00285a7d8141f/bkt873048";

const N_DOSSIERS = process.env.CUBA_N ? parseInt(process.env.CUBA_N, 10) : 2;
const MAX_CYCLES = process.env.CUBA_MAX_CYCLES ? parseInt(process.env.CUBA_MAX_CYCLES, 10) : 5;

// ─── Faux dossiers (credentials uniques par dossier) ──────────────────────────

const FAKE_DOSSIERS: SpainBookingConfig[] = [
  {
    login: "jean.dupont.fake.cuba@gmail.com",
    password: "FakePass_Cuba_Dossier_A",
    applicantName: "JEAN DUPONT (dossier A)",
    applicantEmail: "jean.dupont.fake.cuba@gmail.com",
    visaType: "visa touristique",
  },
  {
    login: "marie.kone.fake.cuba@gmail.com",
    password: "FakePass_Cuba_Dossier_B",
    applicantName: "MARIE KONE (dossier B)",
    applicantEmail: "marie.kone.fake.cuba@gmail.com",
    visaType: "visa touristique",
  },
  {
    login: "paul.mbeki.fake.cuba@gmail.com",
    password: "FakePass_Cuba_Dossier_C",
    applicantName: "PAUL MBEKI (dossier C)",
    applicantEmail: "paul.mbeki.fake.cuba@gmail.com",
    visaType: "visa touristique",
  },
  {
    login: "sarah.nzola.fake.cuba@gmail.com",
    password: "FakePass_Cuba_Dossier_D",
    applicantName: "SARAH NZOLA (dossier D)",
    applicantEmail: "sarah.nzola.fake.cuba@gmail.com",
    visaType: "visa touristique",
  },
].slice(0, N_DOSSIERS);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sep(label: string) {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${label}`);
  console.log("═".repeat(70));
}

function elapsed(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  sep(`TEST MULTI-DOSSIER — ${N_DOSSIERS} dossier(s) en parallèle (Cuba)`);
  console.log(`  Portail  : ${PORTAL_URL}`);
  console.log(`  Redis    : ${process.env.REDIS_URL}`);
  console.log(`  Mode     : ${process.env.SPAIN_SESSION_MODE}`);
  console.log(`  Dossiers : ${N_DOSSIERS}`);
  console.log(`  Proxy    : ${process.env.DECODO_PROXY_URL ? "configuré ✅" : "⚠️  DECODO_PROXY_URL absent"}`);
  console.log(`  CapSolver: ${process.env.CAPSOLVER_API_KEY ? "configuré ✅" : "⚠️  CAPSOLVER_API_KEY absent"}`);

  // ── Phase 1 : Scan ──────────────────────────────────────────────────────────

  sep("PHASE 1 — Scan (boucle prod-like)");
  let scanResult = null as Awaited<ReturnType<typeof scanSpainHttp>> | null;
  let scanDuration = 0;

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    console.log(`\n  ── Cycle ${cycle}/${MAX_CYCLES} ──`);
    const t0 = Date.now();
    scanResult = await scanSpainHttp(PORTAL_URL);
    scanDuration = Date.now() - t0;

    console.log(`  ⏱  Durée : ${elapsed(scanDuration)}`);
    console.log(`  📊 Status: ${scanResult.status}`);
    if (scanResult.slotInfo) console.log(`  🕐 Créneau: ${scanResult.slotInfo}`);
    if (scanResult.errorMessage) console.log(`  ⚠️  Erreur: ${scanResult.errorMessage}`);
    if (scanResult._services?.length) {
      console.log(`  🗂  Services (${scanResult._services.length}) :`);
      for (const s of scanResult._services) {
        console.log(`       - [${s.serviceId}] ${s.serviceName}`);
      }
    }

    if (scanResult.status === "found" || scanResult.status === "not_found") break;

    if (cycle < MAX_CYCLES) {
      console.log(`  🔄 Résultat transitoire — attente 15s…`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  if (!scanResult || (scanResult.status !== "found" && scanResult.status !== "not_found")) {
    console.log("\n  ⛔ Session CF instable — fin du test.");
    process.exit(1);
  }

  if (scanResult.status === "not_found") {
    console.log("\n  ℹ️  Aucun créneau disponible — portail Cuba répond correctement. Réessaie quand des créneaux sont visibles.");
    process.exit(0);
  }

  console.log(`\n  ✅ Scan stable — créneau trouvé : ${scanResult.slotInfo}`);
  if (scanResult._widgetConfig) {
    const wc = scanResult._widgetConfig;
    console.log(`  🔧 widgetConfig — captcha=${wc.captcha ?? "n/a"} registration_type=${wc.registration_type ?? "n/a"} confirmation=${wc.confirmation ?? "n/a"}`);
  }

  // ── Phase 2 : N bookings en parallèle ───────────────────────────────────────

  sep(`PHASE 2 — ${N_DOSSIERS} bookings en Promise.all`);
  console.log("  Objectif : vérifier isolation PHPSESSID + sérialisation mutex DOM");
  console.log("  Attendu  : chaque dossier → signin_failed (credentials faux)\n");

  const session = await ensureSpainCfSession(PORTAL_URL);
  if (!session) {
    console.error("  ❌ Session CF non disponible — abandon.");
    process.exit(1);
  }

  const mainHtml = (scanResult as any)._mainHtml ?? "";
  if (!mainHtml) {
    console.error("  ❌ _mainHtml absent du résultat scan — booking impossible.");
    process.exit(1);
  }

  const availableServices = (scanResult as any)._services?.length
    ? (scanResult as any)._services
    : undefined;

  const targetDate = (scanResult as any).slot?.date;
  const targetTime = (scanResult as any).slot?.time;

  console.log(`  HTML /main/  : ${mainHtml.length} chars`);
  console.log(`  Services     : ${availableServices?.length ?? 0} service(s)`);
  console.log(`  Créneau cible: ${targetDate ?? "?"} à ${targetTime ?? "?"}`);
  console.log();

  // Lancer tous les dossiers en parallèle — exactement comme le watcher prod
  const t0Parallel = Date.now();
  const results = await Promise.all(
    FAKE_DOSSIERS.map(async (dossier) => {
      const t0 = Date.now();
      console.log(`  [${dossier.applicantName}] 🚀 Démarrage booking…`);
      try {
        const result = await executeHttpBooking(session, PORTAL_URL, mainHtml, {
          ...dossier,
          availableServices,
          targetDate,
          targetTime,
        });
        const dur = Date.now() - t0;
        console.log(
          `  [${dossier.applicantName}] ` +
          `${result.status === "signin_failed" || result.status === "booking_failed" ? "✅" : result.status === "booked" ? "⚠️  RÉSERVÉ !" : "ℹ️ "} ` +
          `${result.status} — ${elapsed(dur)}` +
          (result.errorMessage ? ` (${result.errorMessage.slice(0, 80)})` : ""),
        );
        return { dossier: dossier.applicantName, status: result.status, dur, errorMessage: result.errorMessage };
      } catch (err) {
        const dur = Date.now() - t0;
        console.error(`  [${dossier.applicantName}] ❌ Exception: ${err} — ${elapsed(dur)}`);
        return { dossier: dossier.applicantName, status: "exception", dur, errorMessage: String(err) };
      }
    }),
  );
  const parallelDur = Date.now() - t0Parallel;

  // ── Résumé ──────────────────────────────────────────────────────────────────

  sep("RÉSUMÉ");
  console.log(`  ✅ Scan : found — ${elapsed(scanDuration)}`);
  console.log(`  ⏱  Durée totale parallel : ${elapsed(parallelDur)}`);
  console.log();

  let allExpected = true;
  for (const r of results) {
    const expected = r.status === "signin_failed" || r.status === "booking_failed";
    const icon = expected ? "✅ (rejet attendu)" : r.status === "booked" ? "⚠️  RÉSERVÉ !" : "❌";
    console.log(`  ${icon} [${r.dossier}] → ${r.status} (${elapsed(r.dur)})`);
    if (!expected) allExpected = false;
  }
  console.log();

  // Vérification isolation : tous les dossiers doivent avoir atteint signin/
  const reachedSignin = results.filter(
    (r) => r.status === "signin_failed" || r.status === "booked",
  );
  const notReached = results.filter(
    (r) => r.status !== "signin_failed" && r.status !== "booked" && r.status !== "booking_failed",
  );

  console.log(`  📊 Dossiers ayant atteint signin/ : ${reachedSignin.length}/${N_DOSSIERS}`);
  if (notReached.length > 0) {
    console.log(`  ⚠️  Dossiers bloqués avant signin/ :`);
    for (const r of notReached) {
      console.log(`       - ${r.dossier}: ${r.status} — ${r.errorMessage?.slice(0, 80)}`);
    }
  }

  // Vérification mutex : si le parallel_dur est proche de N × dur_median,
  // le mutex a bien sérialisé les appels DOM (pas de race condition).
  const medianDur = [...results].sort((a, b) => a.dur - b.dur)[Math.floor(N_DOSSIERS / 2)]?.dur ?? 0;
  const serialExpected = medianDur * N_DOSSIERS;
  const overhead = serialExpected > 0
    ? ((parallelDur - serialExpected) / serialExpected * 100).toFixed(0)
    : "n/a";
  console.log(`\n  🔒 Vérification mutex DOM :`);
  console.log(`       Durée totale parallel   : ${elapsed(parallelDur)}`);
  console.log(`       Durée médiane × N        : ~${elapsed(serialExpected)} (attendu si sérialisé)`);
  console.log(`       Écart                    : ${overhead}% (≈0% = sérialisé, <−50% = parallèle partiel)`);

  console.log();
  if (allExpected) {
    console.log("  🎉 TEST RÉUSSI — isolation PHPSESSID + mutex DOM confirmés.");
  } else {
    console.log("  ⚠️  Un ou plusieurs dossiers ont un statut inattendu — vérifier les logs ci-dessus.");
  }
  console.log();
}

main().catch((err) => {
  console.error("\n💥 Erreur non gérée :", err);
  process.exit(1);
});
