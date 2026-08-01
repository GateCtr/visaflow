/**
 * Test accès direct Germany RK-Termin (sans proxy).
 * Vérifie : connexion → JSESSIONID → captcha image présente.
 */
import { initSession } from "./src/germanyPortal/rktermin-session.js";
import { scanMonth } from "./src/germanyPortal/rktermin-scan.js";
import { KINSHASA_CATEGORIES } from "./src/germanyPortal/config.js";
import type { RKTerminConfig } from "./src/germanyPortal/types.js";

const config: RKTerminConfig = {
  locationCode: "kins",
  realmId: KINSHASA_CATEGORIES.familyReunification.realmId,
  categoryId: KINSHASA_CATEGORIES.familyReunification.categoryId,
  locale: "en",
  applicantLastname: "TEST",
  applicantFirstname: "Test",
  applicantEmail: "test@test.com",
  dynamicFields: [],
};

console.log("=== TEST Germany Direct Access ===");
console.log(`Portail : https://service2.diplo.de/rktermin/extern`);
console.log(`Config  : ${config.locationCode} realm=${config.realmId} cat=${config.categoryId}`);
console.log("");

// ÉTAPE 1 : init session (GET appointment_showMonth → cookies)
console.log("▶ Étape 1 : initSession (GET appointment_showMonth)...");
const t0 = Date.now();
try {
  const { session, html } = await initSession(config);
  const ms = Date.now() - t0;
  console.log(`✅ Session OK en ${ms}ms`);
  console.log(`   JSESSIONID : ${session.jsessionId.slice(0, 12)}...`);
  console.log(`   KEKS       : ${session.keks}`);
  console.log(`   HTML size  : ${html.length} bytes`);

  // Vérifier présence du captcha
  const hasCaptcha = /data:image\/jpg;base64/.test(html);
  const hasNoSlots = /keine Termine|no appointments/i.test(html);
  const hasCalendar = /appointment_showDay/.test(html);
  console.log(`   Captcha image : ${hasCaptcha ? "✅ présent" : "❌ absent"}`);
  console.log(`   Calendrier    : ${hasCalendar ? "✅ dates cliquables" : "— non affiché"}`);
  console.log(`   Pas de créneaux explicite : ${hasNoSlots ? "oui" : "non"}`);

  // ÉTAPE 2 : scan complet (résolution captcha)
  if (hasCaptcha) {
    console.log("");
    console.log("▶ Étape 2 : scanMonth (résolution captcha + parsing calendrier)...");
    const t1 = Date.now();
    const { result } = await scanMonth(config);
    const ms2 = Date.now() - t1;
    console.log(`   Status       : ${result.status}`);
    console.log(`   Mois affiché : ${result.displayedMonth ?? "?"}`);
    console.log(`   Dates dispo  : ${result.availableDates.length}`);
    if (result.availableDates.length > 0) {
      console.log(`   Dates        : ${result.availableDates.slice(0, 5).join(", ")}${result.availableDates.length > 5 ? "..." : ""}`);
    }
    console.log(`   Mois suivants: ${(result.nextMonthDateStrs ?? []).join(", ") || "aucun"}`);
    console.log(`   Durée scan   : ${ms2}ms`);

    if (result.status === "captcha_failed") {
      console.log("⚠️  Captcha non résolu — vérifier ANTICAPTCHA_API_KEY ou CAPSOLVER_API_KEY");
    } else if (result.status === "error") {
      console.log(`❌ Erreur : ${result.errorMessage}`);
    } else {
      console.log("");
      console.log("✅ Scan terminé avec succès — accès direct diplo.de confirmé.");
    }
  } else {
    console.log("⚠️  Aucune image captcha trouvée dans la page — structure inattendue.");
    console.log("   Extrait HTML :", html.slice(0, 500));
  }
} catch (err) {
  const ms = Date.now() - t0;
  console.log(`❌ Échec en ${ms}ms : ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.message.includes("ECONNREFUSED")) {
    console.log("   → Connexion refusée : vérifier l'accès réseau depuis Replit");
  }
  if (err instanceof Error && err.message.includes("ECONNRESET")) {
    console.log("   → Connexion reset : diplo.de bloque peut-être l'IP Replit");
  }
}
