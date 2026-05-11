import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { 
  solveAndApplyCloudflareChallengeFixed,
  debugBrightDataFormat,
  isBrightDataCompatible,
  checkCapSolverBalance
} from "./src/capsolver-fixed.js";

async function testCapSolverFixedFormat() {
  console.log("=== TEST CAPSOLVER AVEC FORMAT CORRIGÉ ===\n");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const proxyUrl = process.env.BRIGHTDATA_PROXY_URL;
  
  if (!capsolverKey || !proxyUrl) {
    console.error("❌ Variables d'environnement manquantes");
    console.log("CAPSOLVER_API_KEY:", capsolverKey ? "✅" : "❌");
    console.log("BRIGHTDATA_PROXY_URL:", proxyUrl ? "✅" : "❌");
    return;
  }
  
  console.log(`CapSolver API: ${capsolverKey.slice(0, 10)}...\n`);
  console.log(`Proxy URL: ${proxyUrl.split('@')[0]}...@${proxyUrl.split('@')[1]}\n`);
  
  // 1. Vérifier le format Bright Data
  console.log("=== VÉRIFICATION FORMAT BRIGHT DATA ===\n");
  console.log(debugBrightDataFormat(proxyUrl));
  
  const isCompatible = isBrightDataCompatible(proxyUrl);
  console.log(`\nCompatible avec format corrigé: ${isCompatible ? "✅ OUI" : "❌ NON"}\n`);
  
  if (!isCompatible) {
    console.error("❌ Format incompatible. Le username doit contenir -ip-{ip}");
    return;
  }
  
  // 2. Vérifier le solde CapSolver
  console.log("=== VÉRIFICATION SOLDE CAPSOLVER ===\n");
  const balance = await checkCapSolverBalance(capsolverKey);
  
  if (balance === null) {
    console.error("❌ Erreur vérification solde");
    return;
  }
  
  console.log(`Solde CapSolver: ${balance} USD\n`);
  
  if (balance <= 0) {
    console.error("❌ Solde insuffisant");
    return;
  }
  
  // 3. Lancer le navigateur
  console.log("=== LANCEMENT NAVIGATEUR ===\n");
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
    
    console.log("❌ Cloudflare détecté - début résolution CapSolver (format corrigé)...\n");
    
    // Prendre screenshot avant
    await page.screenshot({ path: "before-capsolver-fixed.png" });
    
    // 4. Utiliser CapSolver avec format corrigé
    console.log("=== DÉBUT CAPSOLVER ANTI-CLOUDFLARE (FORMAT CORRIGÉ) ===\n");
    console.log("Task: AntiCloudflareTask\n");
    console.log("Format: proxy=IP:PORT, proxyLogin=username, proxyPassword=password\n");
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallengeFixed(
      page,
      capsolverKey,
      proxyUrl
    );
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\nRésultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (${elapsedTime}ms)\n`);
    
    if (success) {
      console.log("🎉 CAPSOLVER FONCTIONNE AVEC FORMAT CORRIGÉ!\n");
      console.log("🚀 CLOUDFLARE EST RÉSOLU AUTOMATIQUEMENT!\n");
      
      // Prendre screenshot après
      await page.screenshot({ path: "after-capsolver-fixed.png" });
      
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
        
        // Vérifier les cookies
        const cookies = await page.context().cookies();
        const cfClearance = cookies.find(c => c.name === 'cf_clearance');
        console.log(`Cookie cf_clearance: ${cfClearance ? "✅ PRÉSENT" : "❌ ABSENT"}`);
        if (cfClearance) {
          console.log(`Valeur: ${cfClearance.value.slice(0, 30)}...\n`);
        }
      }
    } else {
      console.log("\n=== ANALYSE ÉCHEC ===\n");
      console.log("Même avec format corrigé, CapSolver échoue.\n");
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

testCapSolverFixedFormat().catch(console.error);