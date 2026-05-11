import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveCloudflareWithAllStrategies, getRecommendedConfig } from "./src/cloudflare-strategies.js";

async function testUnifiedCloudflare() {
  console.log("=== TEST SOLUTION UNIFIÉE CLOUDFLARE ===\n");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const iproyalProxy = process.env.IPROYAL_PROXY_URL;
  
  console.log("Configuration détectée:");
  console.log(`- CapSolver: ${capsolverKey ? "✅" : "❌"}`);
  console.log(`- Anti-Captcha: ${anticaptchaKey ? "✅" : "❌"}`);
  console.log(`- iProyal Proxy: ${iproyalProxy ? "✅" : "❌"}`);
  console.log("");
  
  // Test portail Espagne
  const portalConfig = getRecommendedConfig('spain');
  if (!portalConfig) {
    console.error("❌ Configuration portail non trouvée");
    return;
  }
  
  console.log(`=== TEST PORTAL: ${portalConfig.name} ===\n`);
  console.log(`URL: ${portalConfig.url}`);
  console.log(`Stratégie recommandée: ${portalConfig.recommendedStrategy}`);
  console.log(`Notes: ${portalConfig.notes}`);
  console.log("");
  
  // Lancer le navigateur
  console.log("=== LANCEMENT NAVIGATEUR ===\n");
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal", // Utiliser iProyal pour CapSolver
  });
  
  try {
    console.log(`Navigation vers: ${portalConfig.url}\n`);
    await page.goto(portalConfig.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Prendre screenshot avant
    await page.screenshot({ path: "before-unified.png" });
    
    // Appliquer la solution unifiée
    console.log("=== APPLICATION SOLUTION UNIFIÉE ===\n");
    
    const result = await solveCloudflareWithAllStrategies(
      page,
      portalConfig.url,
      capsolverKey,
      anticaptchaKey,
      iproyalProxy
    );
    
    console.log(`\n=== RÉSULTAT FINAL ===\n`);
    console.log(`Succès: ${result.success ? "✅ OUI" : "❌ NON"}`);
    console.log(`Stratégie utilisée: ${result.strategy}`);
    console.log(`Message: ${result.message}`);
    console.log("");
    
    if (result.success) {
      console.log("🎉 CLOUDFLARE CONTOURNÉ AVEC SUCCÈS!\n");
      
      // Prendre screenshot après
      await page.screenshot({ path: "after-unified.png" });
      
      // Vérifier Bookitit
      const hasBookitit = await page.evaluate(() => {
        return !!document.querySelector('#idBktWidgetDefaultBodyContainer');
      });
      
      console.log(`Widget Bookitit: ${hasBookitit ? "✅ DÉTECTÉ" : "❌ NON DÉTECTÉ"}\n`);
      
      if (hasBookitit) {
        console.log("🚀 PRÊT POUR LA RECHERCHE DE SLOTS!\n");
        
        // Attendre un peu pour voir la page
        await page.waitForTimeout(3000);
        
        // Vérifier les cookies
        const cookies = await page.context().cookies();
        const cfClearance = cookies.find(c => c.name === 'cf_clearance');
        console.log(`Cookie cf_clearance: ${cfClearance ? "✅ PRÉSENT" : "❌ ABSENT"}`);
        if (cfClearance) {
          console.log(`Valeur: ${cfClearance.value.slice(0, 30)}...\n`);
          console.log(`Expire: ${new Date(cfClearance.expires * 1000).toLocaleString()}\n`);
        }
      }
    } else {
      console.log("\n=== SOLUTIONS DE SECOURS ===\n");
      console.log("1. Capturer manuellement un cookie:");
      console.log("   - Ouvrir le portail dans un navigateur normal");
      console.log("   - Résoudre le captcha manuellement");
      console.log("   - Exporter le cookie cf_clearance");
      console.log("   - L'ajouter au cookie-manager\n");
      
      console.log("2. Vérifier les configurations:");
      console.log("   - Solde CapSolver: https://dashboard.capsolver.com/passport/");
      console.log("   - Solde Anti-Captcha: https://anti-captcha.com/panel");
      console.log("   - Proxy iProyal: tester la connexion\n");
      
      console.log("3. Essayer avec un autre proxy:");
      console.log("   - Bright Data Residential");
      console.log("   - Autre fournisseur proxy\n");
    }
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("\nTest terminé.");
  }
}

testUnifiedCloudflare().catch(console.error);