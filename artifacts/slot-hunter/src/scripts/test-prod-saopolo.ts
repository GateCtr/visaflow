/**
 * test-prod-saopolo.ts — Exécute runDossierWorker (code PROD exact) sur São Paulo
 *
 * Appelle directement la fonction de production sans rien réécrire.
 * Le pool Decodo lit automatiquement decodo-proxies.csv.
 * Faux identifiants → traverser le flux jusqu'à booking_failed → exited.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-prod-saopolo.ts
 */

import "dotenv/config";
import { runDossierWorker, type SpainDossierConfig } from "../spain-dossier-worker.js";
import { SAOPOLO_PORTAL_URL } from "../spain-portals.js";

// Mode test :
// - SPAIN_BYPASS_WINDOW=1 : fenêtre relative à now (pas HH:25)
// - SPAIN_WORKER_WINDOW_MIN=2 : fenêtre de 2 min — 1 seul cycle + sortie rapide
process.env.SPAIN_BYPASS_WINDOW    = "1";
process.env.SPAIN_WORKER_WINDOW_MIN = "2";

const config: SpainDossierConfig = {
  id:               "test-prod-saopolo",
  applicantName:    "TEST PROD SAOPOLO",
  visaType:         "schengen",
  login:            process.env.TEST_SPAIN_LOGIN    ?? "TESTPASSPORT123",
  password:         process.env.TEST_SPAIN_PASSWORD ?? "testpass123",
  applicationId:    "TEST-APP-PROD-000",
  otpChannel:       "manual",
  portalUrl:        SAOPOLO_PORTAL_URL,
  slotDateFrom:     process.env.TEST_SLOT_DATE_FROM     ?? undefined,
  slotDateDeadline: process.env.TEST_SLOT_DATE_DEADLINE ?? undefined,
  groupSize:        Number(process.env.TEST_GROUP_SIZE  ?? "1"),
};

console.log(`\n${"═".repeat(70)}`);
console.log(`  TEST PROD — runDossierWorker São Paulo (code production exact)`);
console.log(`${"═".repeat(70)}`);
console.log(`  Portail  : ${SAOPOLO_PORTAL_URL}`);
console.log(`  Login    : ${config.login} | Password: ${config.password}`);
console.log(`  Fenêtre  : 2 min (1 cycle)`);
console.log(`  Attendu  : exited après booking_failed (faux identifiants)`);
console.log(`${"═".repeat(70)}\n`);

runDossierWorker(config).then(result => {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  RÉSULTAT runDossierWorker`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  status       : ${result.status}`);
  if (result.errorMessage) console.log(`  errorMessage : ${result.errorMessage}`);
  console.log(`${"═".repeat(70)}\n`);

  if (result.status === "exited") {
    console.log("✅ Worker sorti normalement — flux prod complet traversé sans crash");
    console.log("   (booking_failed avec faux identifiants → cycles → fenêtre expirée)");
  } else if (result.status === "error") {
    console.log(`⚠️  Erreur : "${result.errorMessage}"`);
    console.log("   Vérifier proxy CSV / CAPSOLVER_API_KEY / portail accessible");
  } else if (result.status === "booked") {
    console.log("🚨 BOOKING RÉEL avec faux identifiants — ANNULER IMMÉDIATEMENT");
    process.exit(1);
  }
}).catch(e => { console.error("[FATAL]", e); process.exit(1); });
