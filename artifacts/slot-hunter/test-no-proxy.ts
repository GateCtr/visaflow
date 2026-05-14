/**
 * Test SANS proxy pour confirmer que l'endpoint fonctionne
 */

import "dotenv/config";
import { loginUsaPortal, checkUsaAppointmentRequestStatus, setUsaSessionProxy } from "./src/usaPortal.js";

// Utiliser les credentials du .env
const EMAIL = process.env.USA_EMAIL || "screentapinc@gmail.com";
const PASSWORD = process.env.USA_PASSWORD || "Akollad@2026";

async function testNoProxy() {
  console.log("=".repeat(60));
  console.log(" TEST SANS PROXY");
  console.log("=".repeat(60));
  console.log(`Email: ${EMAIL}`);
  console.log("Proxy: ❌ DÉSACTIVÉ (direct connection)");
  
  // Désactiver le proxy
  setUsaSessionProxy(undefined);
  
  console.log("\n[1] Login SANS proxy...");
  const session = await loginUsaPortal(EMAIL, PASSWORD);
  
  if (!session) {
    console.error("❌ Login failed");
    return;
  }
  
  console.log(`✅ Login réussi: ${session.fullName}`);
  console.log(`   Token: ${session.accessToken?.slice(0, 30)}...`);
  
  console.log("\n[2] Test endpoint SANS proxy...");
  const status = await checkUsaAppointmentRequestStatus(session, undefined);
  
  console.log("\n" + "=".repeat(60));
  console.log(" RÉSULTAT SANS PROXY");
  console.log("=".repeat(60));
  console.log(`Status: ${status.status}`);
  console.log(`HTTP Error? ${status.status === "error" ? "OUI (401)" : "NON"}`);
  console.log(`Message: ${status.message}`);
  
  if (status.status !== "error") {
    console.log("\n✅ CONFIRMÉ: Sans proxy, l'endpoint fonctionne!");
    console.log(`   ApplicationId: ${status.applicationId}`);
    console.log(`   pendingAppoStatus: ${status.pendingAppoStatus}`);
  } else {
    console.log("\n❌ Même sans proxy, erreur 401");
    console.log("   Le problème n'est pas le proxy, mais autre chose");
  }
}

testNoProxy().catch(console.error);