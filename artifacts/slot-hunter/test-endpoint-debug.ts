/**
 * Debug de l'endpoint /workflow/getUserHistoryApplicantPaymentStatus
 */

import "dotenv/config";
import { loginUsaPortal, setUsaSessionProxy } from "./src/usaPortal.js";
import { usaFetch, authHeaders } from "./src/usaPortal/usa-http.js";
import { makeIproyalStickyUrl } from "./src/usaPortal/usa-http.js";

const EMAIL = process.env.USA_EMAIL || "screentapinc@gmail.com";
const PASSWORD = process.env.USA_PASSWORD || "Akollad@2026";
const USA_PAYMENT_STATUS_URL = "https://www.usvisaappt.com/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus";

async function debugEndpoint() {
  console.log("=".repeat(60));
  console.log(" DEBUG ENDPOINT 401");
  console.log("=".repeat(60));
  
  // 1. Login avec proxy
  const stickyProxyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 30);
  console.log(`Proxy: ${stickyProxyUrl.replace(/:([^:@]+)@/, ":***@")}`);
  
  setUsaSessionProxy(stickyProxyUrl);
  
  console.log("\n[1] Login...");
  const session = await loginUsaPortal(EMAIL, PASSWORD);
  
  if (!session) {
    console.error("❌ Login failed");
    return;
  }
  
  console.log(`✅ Login réussi: ${session.fullName}`);
  console.log(`   Token: ${session.accessToken?.slice(0, 30)}...`);
  console.log(`   Token length: ${session.accessToken?.length}`);
  
  // 2. Préparer la requête
  const headers = authHeaders(session.accessToken, "https://www.usvisaappt.com/visaapplicantui/login", false);
  
  console.log("\n[2] Headers envoyés:");
  Object.entries(headers).forEach(([key, value]) => {
    if (key === "Authorization") {
      console.log(`   ${key}: ${value.slice(0, 30)}...`);
    } else {
      console.log(`   ${key}: ${value}`);
    }
  });
  
  // 3. Faire la requête avec logging détaillé
  console.log("\n[3] Requête vers:", USA_PAYMENT_STATUS_URL);
  
  try {
    const res = await usaFetch(USA_PAYMENT_STATUS_URL, { 
      method: "GET", 
      headers 
    });
    
    console.log(`\n✅ Réponse reçue: HTTP ${res.status}`);
    
    // Afficher les headers de réponse
    console.log("\nHeaders de réponse:");
    res.headers.forEach((value, key) => {
      console.log(`   ${key}: ${value}`);
    });
    
    // Lire le body
    const bodyText = await res.text();
    console.log(`\nBody (${bodyText.length} chars):`);
    console.log(bodyText.slice(0, 500) + (bodyText.length > 500 ? "..." : ""));
    
    if (res.status === 401) {
      console.log("\n🔍 Analyse du 401:");
      console.log("1. Token valide? Oui, vient d'être obtenu");
      console.log("2. Proxy actif? Oui, même proxy que login");
      console.log("3. Headers complets? Voir ci-dessus");
      console.log("4. Possible problème: csrfToken manquant");
      console.log("5. Possible problème: cookies manquants");
      console.log("6. Possible problème: endpoint nécessite missionId dans les cookies");
    }
    
  } catch (error: any) {
    console.error(`\n❌ Erreur: ${error.message}`);
    console.error(error);
  } finally {
    setUsaSessionProxy(undefined);
  }
}

debugEndpoint().catch(console.error);