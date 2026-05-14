/**
 * Test du proxy iProyal avec login USA
 * Usage: npx tsx test-proxy-login.ts
 */

import "dotenv/config";
import { loginUsaPortal, checkUsaAppointmentRequestStatus, setUsaSessionProxy } from "./src/usaPortal.js";
import { makeIproyalStickyUrl } from "./src/usaPortal/usa-http.js";

const EMAIL = process.env.USA_EMAIL || "screentapinc@gmail.com";
const PASSWORD = process.env.USA_PASSWORD || "Akollad@2026";

async function testIproyalProxy() {
  console.log("=".repeat(60));
  console.log(" TEST PROXY IPROYAL - USA PORTAL");
  console.log("=".repeat(60));
  console.log(`Email: ${EMAIL}`);
  console.log(`iProyal URL: ${process.env.IPROYAL_PROXY_URL ? "✅ configuré" : "❌ absent"}`);
  
  if (!process.env.IPROYAL_PROXY_URL) {
    console.error("❌ IPROYAL_PROXY_URL non configuré dans .env");
    process.exit(1);
  }

  // 1. Créer URL proxy sticky
  console.log("\n[1/3] Création URL proxy sticky...");
  const stickyProxyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL, 30);
  const maskedUrl = stickyProxyUrl.replace(/:([^:@]+)@/, ":***@");
  console.log(`   URL proxy: ${maskedUrl}`);
  
  // 2. Configurer le proxy
  console.log("\n[2/3] Configuration du proxy pour usaFetch...");
  setUsaSessionProxy(stickyProxyUrl);
  
  // 3. Tester le login
  console.log("\n[3/3] Test de login avec proxy iProyal...");
  console.log("   (Si 401, problème de token-IP binding)");
  console.log("   (Si restriction, problème Cognito)");
  console.log("   (Si succès, proxy fonctionne!)");
  
  try {
    const session = await loginUsaPortal(EMAIL, PASSWORD);
    
    if (!session) {
      console.error("❌ Login échoué — session null");
      return;
    }
    
    console.log("\n✅ LOGIN RÉUSSI AVEC PROXY IPROYAL!");
    console.log(`   Nom: ${session.fullName}`);
    console.log(`   UserID: ${session.userID}`);
    console.log(`   Token: ${session.accessToken?.slice(0, 30)}...`);
    
    // 4. Tester une requête API avec le même proxy
    console.log("\n[4/4] Test requête API avec proxy...");
    const status = await checkUsaAppointmentRequestStatus(session, undefined);
    
    console.log("\n✅ REQUÊTE API RÉUSSIE AVEC PROXY!");
    console.log(`   Statut: ${status.status}`);
    console.log(`   ApplicationId: ${status.applicationId}`);
    console.log(`   Message: ${status.message}`);
    
    console.log("\n" + "=".repeat(60));
    console.log(" RÉSULTAT: PROXY IPROYAL FONCTIONNE!");
    console.log("=".repeat(60));
    console.log("\nLe proxy iProyal résout les problèmes:");
    console.log("1. ✅ Format user:pass@host:port (compatible undici)");
    console.log("2. ✅ Session sticky (même IP pour login + requêtes)");
    console.log("3. ✅ Pas de 401 token-IP binding");
    
  } catch (error: any) {
    console.error("\n❌ ERREUR:", error.message);
    
    if (error.message.includes("401")) {
      console.log("\nProblème: 401 - Token-IP binding");
      console.log("Cause: JWT lié à IP différente");
      console.log("Solution: Vérifier que setUsaSessionProxy() est appelé AVANT login");
    } else if (error.message.includes("restricted") || error.message.includes("restreint")) {
      console.log("\nProblème: Compte restreint par Cognito");
      console.log("Cause: Trop de logins, sessions simultanées");
      console.log("Solution: Attendre 60 min, éviter sessions simultanées");
    } else {
      console.log("\nErreur inconnue, vérifier:");
      console.log("1. Proxy iProyal actif");
      console.log("2. Credentials corrects");
      console.log("3. Compte non restreint");
    }
  } finally {
    setUsaSessionProxy(undefined);
  }
}

testIproyalProxy().catch(console.error);