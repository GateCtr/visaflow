import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { HybridCloudflareSolver } from "./src/hybrid-solution.js";

async function testHybridSolution() {
  console.log("=== TEST SOLUTION HYBRIDE CLOUDFLARE ===\n");
  
  // Créer le solver avec configuration pour Espagne
  const solver = HybridCloudflareSolver.createForSpainPortal();
  
  // Afficher les recommandations
  console.log("=== RECOMMANDATIONS ===\n");
  const recommendations = solver.getRecommendations();
  recommendations.forEach(rec => console.log(rec));
  console.log("");
  
  // Statistiques des cookies
  const stats = solver.getCookieStats();
  console.log("=== STATISTIQUES COOKIES ===\n");
  console.log(`Total: ${stats.total}`);
  console.log(`Valides: ${stats.valid}`);
  console.log(`Expirés: ${stats.expired}`);
  
  if (stats.bestCookie) {
    console.log(`\nMeilleur cookie:`);
    console.log(`  Valeur: ${stats.bestCookie.value.slice(0, 30)}...`);
    console.log(`  Source: ${stats.bestCookie.source}`);
    console.log(`  Expire: ${new Date(stats.bestCookie.expires * 1000).toLocaleString()}`);
    console.log(`  Capturé: ${new Date(stats.bestCookie.capturedAt).toLocaleString()}`);
  }
  console.log("");
  
  // Lancer le navigateur
  console.log("=== LANCEMENT NAVIGATEUR ===\n");
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal", // Utiliser iProyal pour CapSolver
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}\n`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Prendre screenshot avant
    await page.screenshot({ path: "before-hybrid.png" });
    
    // Appliquer la solution hybride
    console.log("=== APPLICATION SOLUTION HYBRIDE ===\n");
    
    const result = await solver.solveCloudflare(page, portalUrl);
    
    console.log(`\n=== RÉSULTAT ===\n`);
    console.log(`Succès: ${result.success ? "✅ OUI" : "❌ NON"}`);
    console.log(`Méthode: ${result.method}`);
    console.log(`Message: ${result.message}`);
    console.log(`Durée: ${result.duration}ms\n`);
    
    if (result.success) {
      console.log("🎉 CLOUDFLARE CONTOURNÉ AVEC SUCCÈS!\n");
      
      // Prendre screenshot après
      await page.screenshot({ path: "after-hybrid.png" });
      
      // Vérifier Bookitit
      const hasBookitit = await page.evaluate(() => {
        return !!document.querySelector('#idBktWidgetDefaultBodyContainer');
      });
      
      console.log(`Widget Bookitit: ${hasBookitit ? "✅ DÉTECTÉ" : "❌ NON DÉTECTÉ"}\n`);
      
      if (hasBookitit) {
        console.log("🚀 PRÊT POUR LA RECHERCHE DE SLOTS!\n");
        
        // Vérifier les cookies
        const cookies = await page.context().cookies();
        const cfClearance = cookies.find(c => c.name === 'cf_clearance');
        console.log(`Cookie cf_clearance: ${cfClearance ? "✅ PRÉSENT" : "❌ ABSENT"}`);
        if (cfClearance) {
          console.log(`Valeur: ${cfClearance.value.slice(0, 30)}...\n`);
          console.log(`Expire: ${new Date(cfClearance.expires * 1000).toLocaleString()}\n`);
        }
        
        // Attendre pour voir la page
        await page.waitForTimeout(5000);
        
        // Tester la recherche de slots
        console.log("=== TEST RECHERCHE SLOTS ===\n");
        try {
          // Vérifier si le formulaire est présent
          const hasForm = await page.evaluate(() => {
            return !!document.querySelector('form, #bktContainer, [id*="widget"]');
          });
          
          console.log(`Formulaire détecté: ${hasForm ? "✅ OUI" : "❌ NON"}`);
          
          if (hasForm) {
            // Prendre screenshot du formulaire
            await page.screenshot({ path: "form-detected.png" });
            console.log("📁 Screenshot du formulaire sauvegardé: form-detected.png");
          }
          
        } catch (error) {
          console.log("Test formulaire échoué:", error);
        }
      }
    } else {
      console.log("\n=== PLAN D'ACTION ===\n");
      console.log("1. Capturez manuellement un cookie:");
      console.log("   npm run cloudflare:capture-manual");
      console.log("");
      console.log("2. Vérifiez les configurations:");
      console.log("   - .env: CAPSOLVER_API_KEY, ANTICAPTCHA_API_KEY, IPROYAL_PROXY_URL");
      console.log("   - Solde CapSolver: https://dashboard.capsolver.com/passport/");
      console.log("   - Solde Anti-Captcha: https://anti-captcha.com/panel");
      console.log("");
      console.log("3. Essayez avec un autre proxy:");
      console.log("   - Modifiez proxySource dans launchBrowser");
      console.log("   - Testez avec Bright Data Residential");
      console.log("");
      console.log("4. Contactez le support:");
      console.log("   - Bright Data: https://brightdata.com/");
      console.log("   - CapSolver: https://capsolver.com/");
      console.log("   - Anti-Captcha: https://anti-captcha.com/");
      console.log("");
    }
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("\n=== FIN DU TEST ===\n");
    console.log("Pour capturer un cookie manuellement:");
    console.log("  npm run cloudflare:capture-manual");
    console.log("\nPour réessayer:");
    console.log("  npx tsx test-hybrid-solution.ts");
  }
}

testHybridSolution().catch(console.error);