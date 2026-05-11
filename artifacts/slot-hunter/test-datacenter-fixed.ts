import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";

async function testDatacenterFixedIp() {
  console.log("=== TEST DATACENTER PROXY AVEC IP FIXE ===\n");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const capsolverFormat = process.env.BRIGHTDATA_CAPSOLVER_FORMAT;
  
  console.log(`CapSolver API: ${capsolverKey?.slice(0, 10)}...\n`);
  console.log(`Proxy format: ${capsolverFormat?.split(':')[0]}...\n`);
  
  console.log(`IP FIXE: 212.81.41.27 (France)\n`);
  console.log(`✅ CETTE IP EST DÉDIÉE ET FIXE!\n`);
  console.log(`🎯 CAPSOLVER DEVRAIT FONCTIONNER!\n`);
  
  // Lancer le navigateur
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata",
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}\n`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title = await page.title();
    console.log(`Titre: "${title}"\n`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log("✅ Cloudflare non détecté");
      return;
    }
    
    console.log("❌ Cloudflare détecté - début résolution CapSolver...\n");
    
    // Prendre screenshot avant
    await page.screenshot({ path: "before-datacenter-fixed.png" });
    
    // Utiliser CapSolver
    console.log("=== DÉBUT CAPSOLVER ANTI-CLOUDFLARE ===\n");
    console.log(`Task: AntiCloudflareTask\n`);
    console.log(`Proxy: Datacenter avec IP fixe 212.81.41.27\n`);
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(
      page,
      capsolverKey!,
      capsolverFormat!
    );
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\nRésultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (${elapsedTime}ms)\n`);
    
    if (success) {
      console.log("🎉 CAPSOLVER FONCTIONNE AVEC IP FIXE!\n");
      console.log("🚀 CLOUDFLARE EST RÉSOLU AUTOMATIQUEMENT!\n");
      
      // Prendre screenshot après
      await page.screenshot({ path: "after-datacenter-fixed.png" });
      
      // Vérifier
      const finalTitle = await page.title();
      console.log(`Titre final: "${finalTitle}"\n`);
      
      if (!/un instant|just a moment|verifying/i.test(finalTitle)) {
        console.log("✅ Cloudflare contourné avec succès!\n");
        
        // Vérifier Bookitit
        const hasBookitit = await page.evaluate(() => {
          return !!document.querySelector('#idBktWidgetDefaultBodyContainer');
        });
        
        console.log(`Widget Bookitit: ${hasBookitit ? "✅ DÉTECTÉ" : "❌ NON DÉTECTÉ"}\n`);
      }
    } else {
      console.log("\n=== ANALYSE ÉCHEC ===\n");
      console.log("Même avec IP fixe, CapSolver échoue.\n");
      console.log("Raisons possibles:\n");
      console.log("1. Cloudflare Managed Challenge trop avancé");
      console.log("2. Problème avec l'API CapSolver");
      console.log("3. Le portail a changé sa configuration\n");
      console.log("Solution: Utiliser le fallback cookies manuels\n");
    }
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("\nTest terminé.");
  }
}

testDatacenterFixedIp().catch(console.error);