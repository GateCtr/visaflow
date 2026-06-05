import * as dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";

// Force local stealth mode
process.env.USE_LOCAL_STEALTH = "true";

import { ensureSpainCfSession } from "./src/spain-soax-solver.js";
import { cookieManager } from "./src/cookie-manager.js";

async function runTest() {
  console.log("=== TEST SOLVEUR CLOUDFLARE LOCAL STEALTH ===");

  // Sauvegarder temporairement le pool de cookies existant pour forcer un nouveau solve
  const poolPath = path.join("./cookies", "cf-cookie-pool.json");
  let backupContent: string | null = null;
  if (fs.existsSync(poolPath)) {
    console.log("💾 Sauvegarde temporaire du pool de cookies existant...");
    backupContent = fs.readFileSync(poolPath, "utf8");
    fs.unlinkSync(poolPath);
    // Vider le cache interne
    (cookieManager as any).pool = { cookies: [], lastUpdated: Date.now(), version: 1 };
  }

  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`🚀 Appel de ensureSpainCfSession pour : ${portalUrl}`);
    
    const session = await ensureSpainCfSession(portalUrl);

    if (session) {
      console.log("\n🎉 SUCCÈS ! Session obtenue gratuitement en local !");
      console.log(`   cf_clearance : ${session.cfClearance.slice(0, 30)}...`);
      console.log(`   User-Agent : ${session.userAgent}`);
      console.log(`   Proxy SOAX : ${session.soaxProxyUrl || "Aucun (Direct)"}`);
      console.log(`   Expire : ${new Date(session.expiresAt).toLocaleString()}`);
    } else {
      console.error("\n❌ ÉCHEC : Impossible d'obtenir la session.");
    }
  } catch (error) {
    console.error("\n❌ Erreur pendant le test :", error);
  } finally {
    // Restaurer le backup
    if (backupContent) {
      console.log("\n🔄 Restauration du pool de cookies sauvegardé...");
      fs.writeFileSync(poolPath, backupContent, "utf8");
    }
  }
}

runTest().catch(console.error);
