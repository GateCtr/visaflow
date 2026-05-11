import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";

async function testCapSolverCloudflare() {
  console.log("Test CapSolver AntiCloudflareTask avec Bright Data...");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const brightdataProxy = process.env.BRIGHTDATA_PROXY_URL;
  
  if (!capsolverKey) {
    console.error("ERREUR: CAPSOLVER_API_KEY non configurée!");
    return;
  }
  
  if (!brightdataProxy) {
    console.error("ERREUR: BRIGHTDATA_PROXY_URL non configurée!");
    return;
  }
  
  console.log(`CapSolver: ${capsolverKey.slice(0, 10)}...`);
  console.log(`Bright Data proxy: ${brightdataProxy.split('@')[0]}...@...`);
  
  // Lancer le navigateur avec Bright Data
  console.log("\nLancement navigateur avec Bright Data...");
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata",
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\nNavigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Vérifier Cloudflare
    const title = await page.title();
    console.log(`Titre initial: "${title}"`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log("✅ Cloudflare non détecté - déjà authentifié?");
      
      // Vérifier les cookies
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');
      if (cfClearance) {
        console.log(`Cookie cf_clearance présent: ${cfClearance.value.slice(0, 20)}...`);
      }
      
      return;
    }
    
    console.log("❌ Cloudflare détecté - début résolution avec CapSolver...");
    
    // Prendre une capture avant
    await page.screenshot({ path: "before-capsolver.png" });
    console.log("Capture avant: before-capsolver.png");
    
    // Utiliser CapSolver AntiCloudflareTask
    console.log("\n=== DÉBUT RÉSOLUTION CAPSOLVER ===");
    console.log("Task type: AntiCloudflareTask");
    console.log("Proxy: Bright Data");
    console.log("URL:", portalUrl);
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(page, capsolverKey, brightdataProxy);
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\nRésultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (temps: ${elapsedTime}ms)`);
    
    if (success) {
      // Vérifier le résultat
      const finalTitle = await page.title();
      console.log(`Titre final: "${finalTitle}"`);
      
      const finalIsCloudflare = /un instant|just a moment|verifying/i.test(finalTitle);
      
      if (!finalIsCloudflare) {
        console.log("✅ Cloudflare résolu avec succès!");
        
        // Vérifier le contenu
        const pageContent = await page.content();
        const indicators = [
          "Embajada de España",
          "VISADOS",
          "Servicios disponibles",
          "No hay horas disponibles"
        ];
        
        console.log("\nIndicateurs dans la page:");
        for (const indicator of indicators) {
          const found = pageContent.includes(indicator);
          console.log(`  ${indicator}: ${found ? "✅" : "❌"}`);
        }
        
        // Test navigation
        console.log("\nTest navigation dans le portail...");
        try {
          await page.goto(`${portalUrl}#selectservices`, {
            waitUntil: "domcontentloaded",
            timeout: 15000
          });
          
          const servicesTitle = await page.title();
          console.log(`Page services: "${servicesTitle}"`);
          
          if (!/un instant|just a moment|verifying/i.test(servicesTitle)) {
            console.log("✅ Navigation réussie avec cf_clearance!");
          }
        } catch (error) {
          console.log("Navigation test:", error instanceof Error ? error.message : error);
        }
      } else {
        console.log("❌ Cloudflare toujours présent");
      }
    }
    
    // Prendre une capture après
    await page.screenshot({ path: "after-capsolver.png" });
    console.log("\nCapture après: after-capsolver.png");
    
    // Vérifier les cookies
    const finalCookies = await page.context().cookies();
    const finalCfClearance = finalCookies.find(c => c.name === 'cf_clearance');
    
    console.log("\n=== COOKIES FINAUX ===");
    console.log(`Cookie cf_clearance: ${finalCfClearance ? "PRÉSENT" : "ABSENT"}`);
    if (finalCfClearance) {
      console.log(`  Valeur: ${finalCfClearance.value.slice(0, 20)}...`);
      console.log(`  Longueur: ${finalCfClearance.value.length} caractères`);
    }
    
    // Afficher tous les cookies Cloudflare
    const cfCookies = finalCookies.filter(c => c.name.startsWith('cf_'));
    console.log(`Autres cookies Cloudflare: ${cfCookies.length}`);
    cfCookies.forEach(c => {
      console.log(`  ${c.name}: ${c.value.slice(0, 30)}...`);
    });
    
  } catch (error) {
    console.error("Erreur pendant le test:", error);
  } finally {
    await browser.close();
    console.log("\nTest terminé.");
  }
}

testCapSolverCloudflare().catch(console.error);