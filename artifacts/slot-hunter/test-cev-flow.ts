#!/usr/bin/env node
import "dotenv/config";
import { setupCevSessionHttp } from "./src/cevHttpSetup.js";

console.log("[TEST] Démarrage test flux CEV...");
console.log("[TEST] VOWINT_EMAIL:", process.env.VOWINT_EMAIL);
console.log("[TEST] ANTICAPTCHA_API_KEY:", process.env.ANTICAPTCHA_API_KEY ? "OK" : "MANQUANT");
console.log("[TEST] SOAX_PROXY_URL:", process.env.SOAX_PROXY_URL ? "OK" : "MANQUANT");

async function main() {
  if (!process.env.VOWINT_EMAIL) {
    console.error("[TEST] ERREUR: VOWINT_EMAIL manquant");
    process.exit(1);
  }
  if (!process.env.VOWINT_TEST_PASSWORD) {
    console.error("[TEST] ERREUR: VOWINT_TEST_PASSWORD manquant");
    process.exit(1);
  }
  if (!process.env.ANTICAPTCHA_API_KEY) {
    console.error("[TEST] ERREUR: ANTICAPTCHA_API_KEY manquant");
    process.exit(1);
  }

  const vowintEmail = process.env.VOWINT_EMAIL;
  const vowintPassword = process.env.VOWINT_TEST_PASSWORD;
  const applicationId = "test-app-id-123";
  const vowsintRef = "VOWINT6088178"; // Un dossier de test

  console.log(`[TEST] Début setup CEV pour ${vowsintRef}...`);
  const result = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    applicationId,
    vowsintRef
  );

  console.log("\n[TEST] Résultat setup CEV:");
  console.log(result);

  if (result.success) {
    console.log("\n✅ SUCCÈS ! Flux CEV fonctionne !");
    console.log("   Slots disponibles:", result.slotsAvailable);
  } else {
    console.error("\n❌ ÉCHEC ! Erreur:", result.error);
  }
}

main().catch((err) => {
  console.error("[TEST] ERREUR GLOBALE:", err);
  process.exit(1);
});
