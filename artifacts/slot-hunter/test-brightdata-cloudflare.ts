import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { extractTurnstileSitekey } from "./src/captcha.js";

async function testBrightDataCloudflare() {
  console.log("Test Cloudflare avec Bright Data proxy...");
  
  // Vérifier les clés
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  
  console.log(`CapSolver: ${capsolverKey ? "OUI" : "NON"}`);
  console.log(`Anti-Captcha: ${anticaptchaKey ? "OUI" : "NON"}`);
  
  // Test 1: Bright Data proxy
  console.log("\n=== TEST 1: Bright Data Proxy ===");
  const { browser: browser1, page: page1 } = await launchBrowser({
    headless: false,
    proxySource: "brightdata", // Utiliser Bright Data
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation avec Bright Data...`);
    
    await page1.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title1 = await page1.title();
    console.log(`Titre: "${title1}"`);
    
    const isCloudflare1 = /un instant|just a moment|verifying/i.test(title1);
    console.log(`Cloudflare: ${isCloudflare1 ? "PRÉSENT" : "ABSENT"}`);
    
    if (isCloudflare1) {
      // Essayer d'extraire le sitekey
      const sitekeyResult = await extractTurnstileSitekey(page1);
      if (sitekeyResult) {
        console.log(`Sitekey: ${sitekeyResult.sitekey}`);
        console.log(`Type: ${sitekeyResult.isCfChallenge ? "CF Managed" : "Turnstile standard"}`);
      }
    }
    
    await page1.screenshot({ path: "brightdata-test.png" });
    console.log("Capture: brightdata-test.png");
    
  } catch (error) {
    console.error("Erreur Bright Data:", error);
  } finally {
    await browser1.close();
  }
  
  // Test 2: iProyal proxy (pour comparaison)
  console.log("\n=== TEST 2: iProyal Proxy (comparaison) ===");
  const { browser: browser2, page: page2 } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation avec iProyal...`);
    
    await page2.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title2 = await page2.title();
    console.log(`Titre: "${title2}"`);
    
    const isCloudflare2 = /un instant|just a moment|verifying/i.test(title2);
    console.log(`Cloudflare: ${isCloudflare2 ? "PRÉSENT" : "ABSENT"}`);
    
    await page2.screenshot({ path: "iproyal-test.png" });
    console.log("Capture: iproyal-test.png");
    
    // Comparaison
    console.log("\n=== COMPARAISON ===");
    console.log("Bright Data vs iProyal:");
    console.log("- Bright Data: proxy résidentiel de haute qualité");
    console.log("- iProyal: proxy datacenter (plus facilement détecté)");
    console.log("\nRecommandation: Utiliser Bright Data pour Cloudflare");
    
  } catch (error) {
    console.error("Erreur iProyal:", error);
  } finally {
    await browser2.close();
  }
  
  // Test 3: Essayer CapSolver avec Bright Data
  if (capsolverKey) {
    console.log("\n=== TEST 3: CapSolver avec Bright Data ===");
    
    // Note: Nous devrions implémenter l'intégration CapSolver
    // Pour l'instant, juste un test de connexion
    console.log("Test de connexion CapSolver...");
    
    try {
      const response = await fetch("https://api.capsolver.com/getBalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: capsolverKey }),
        signal: AbortSignal.timeout(10000),
      });
      
      const data = await response.json();
      console.log("Réponse CapSolver:", data);
      
      if (data.errorId === 0) {
        console.log(`✅ CapSolver valide! Balance: ${data.balance || "N/A"}`);
        
        // CapSolver a AntiCloudflareTask pour Cloudflare
        console.log("\nCapSolver supporte AntiCloudflareTask pour Cloudflare!");
        console.log("Task types disponibles:");
        console.log("- AntiCloudflareTask: Pour Cloudflare Challenge");
        console.log("- AntiTurnstileTask: Pour Turnstile standard");
        console.log("- HCaptchaTask: Pour hCaptcha");
        
      } else {
        console.log(`❌ Erreur CapSolver: ${data.errorDescription || data.errorId}`);
      }
    } catch (error) {
      console.error("Erreur connexion CapSolver:", error);
    }
  }
  
  console.log("\n=== STRATÉGIE RECOMMANDÉE ===");
  console.log("1. Utiliser Bright Data proxy (meilleure réputation IP)");
  console.log("2. Implémenter CapSolver AntiCloudflareTask");
  console.log("3. Combiner avec une bonne configuration navigateur");
  console.log("4. Gérer les cookies cf_clearance correctement");
}

testBrightDataCloudflare().catch(console.error);