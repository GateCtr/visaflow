import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";

// Fonction pour parser l'URL iProyal au format CapSolver
function parseIproyalProxy(proxyUrl: string): string {
  // Format: http://user:pass@host:port
  try {
    const url = new URL(proxyUrl);
    const auth = url.username && url.password 
      ? `${url.username}:${url.password}`
      : '';
    const host = url.hostname;
    const port = url.port;
    
    // Format CapSolver: host:port:user:pass
    if (auth) {
      return `${host}:${port}:${url.username}:${url.password}`;
    } else {
      return `${host}:${port}`;
    }
  } catch (error) {
    console.error("Erreur parsing proxy URL:", error);
    return proxyUrl;
  }
}

async function testCapSolverIproyal() {
  console.log("Test CapSolver AntiCloudflareTask avec iProyal...");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const iproyalProxy = process.env.IPROYAL_PROXY_URL;
  
  if (!capsolverKey) {
    console.error("ERREUR: CAPSOLVER_API_KEY non configurée!");
    return;
  }
  
  if (!iproyalProxy) {
    console.error("ERREUR: IPROYAL_PROXY_URL non configurée!");
    return;
  }
  
  // Parser le proxy pour CapSolver
  const capsolverProxy = parseIproyalProxy(iproyalProxy);
  
  console.log(`CapSolver: ${capsolverKey.slice(0, 10)}...`);
  console.log(`iProyal proxy original: ${iproyalProxy.split('@')[0]}...@...`);
  console.log(`iProyal proxy pour CapSolver: ${capsolverProxy}`);
  
  // Lancer le navigateur avec iProyal
  console.log("\nLancement navigateur avec iProyal...");
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
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
      console.log("✅ Cloudflare non détecté");
      return;
    }
    
    console.log("❌ Cloudflare détecté - début résolution avec CapSolver...");
    
    // Prendre une capture avant
    await page.screenshot({ path: "before-capsolver-iproyal.png" });
    console.log("Capture avant: before-capsolver-iproyal.png");
    
    // Utiliser CapSolver AntiCloudflareTask avec iProyal
    console.log("\n=== DÉBUT RÉSOLUTION CAPSOLVER ===");
    console.log("Task type: AntiCloudflareTask");
    console.log("Proxy: iProyal (format CapSolver)");
    console.log("Proxy format:", capsolverProxy);
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(page, capsolverKey, capsolverProxy);
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\nRésultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (temps: ${elapsedTime}ms)`);
    
    if (success) {
      // Vérifier le résultat
      const finalTitle = await page.title();
      console.log(`Titre final: "${finalTitle}"`);
      
      const finalIsCloudflare = /un instant|just a moment|verifying/i.test(finalTitle);
      
      if (!finalIsCloudflare) {
        console.log("✅ Cloudflare résolu avec succès!");
        
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
            console.log("✅ Navigation réussie!");
          }
        } catch (error) {
          console.log("Navigation test:", error instanceof Error ? error.message : error);
        }
      } else {
        console.log("❌ Cloudflare toujours présent");
      }
    } else {
      console.log("\n=== ANALYSE DE L'ÉCHEC ===");
      console.log("Problèmes possibles:");
      console.log("1. Proxy iProyal peut aussi avoir IP dynamique");
      console.log("2. Cloudflare Managed Challenge très strict");
      console.log("3. Format proxy incorrect pour CapSolver");
      console.log("\nSolutions à essayer:");
      console.log("1. Utiliser un proxy résidentiel avec IP fixe");
      console.log("2. Vérifier le format proxy exact requis par CapSolver");
      console.log("3. Contacter le support CapSolver pour configuration");
    }
    
    // Prendre une capture après
    await page.screenshot({ path: "after-capsolver-iproyal.png" });
    console.log("\nCapture après: after-capsolver-iproyal.png");
    
  } catch (error) {
    console.error("Erreur pendant le test:", error);
  } finally {
    await browser.close();
    console.log("\nTest terminé.");
  }
}

testCapSolverIproyal().catch(console.error);