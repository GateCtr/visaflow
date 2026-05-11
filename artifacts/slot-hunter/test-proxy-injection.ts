import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveTurnstileWithProxyInjection } from "./src/captcha.js";

async function testProxyInjection() {
  console.log("Test de la méthode de proxy injection pour Cloudflare Turnstile...");
  
  // Vérifier les clés API
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  
  console.log(`Clé Anti-Captcha: ${anticaptchaKey ? "OUI" : "NON"}`);
  
  if (!anticaptchaKey) {
    console.error("ERREUR: ANTICAPTCHA_API_KEY n'est pas configurée!");
    return;
  }
  
  // Lancer le navigateur
  console.log("Lancement du navigateur...");
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    // Accéder au portail Espagne
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Vérifier si Cloudflare est présent
    const title = await page.title();
    console.log(`Titre de la page: "${title}"`);
    
    // Attendre un peu pour que Cloudflare charge
    console.log("Attente de 10 secondes pour que Cloudflare charge...");
    await new Promise(r => setTimeout(r, 10000));
    
    // Vérifier à nouveau le titre
    const newTitle = await page.title();
    console.log(`Titre après attente: "${newTitle}"`);
    
    // Vérifier si on est toujours sur Cloudflare
    const cfPattern = /un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i;
    const isCloudflare = cfPattern.test(newTitle);
    
    if (!isCloudflare) {
      console.log("✅ Cloudflare déjà résolu automatiquement!");
      await browser.close();
      return;
    }
    
    console.log("❌ Cloudflare toujours présent, tentative de résolution avec proxy injection...");
    
    // Tester la nouvelle méthode
    const result = await solveTurnstileWithProxyInjection(page, anticaptchaKey);
    
    console.log(`Résultat: ${result}`);
    
    if (result === "solved") {
      console.log("✅ SUCCÈS - Cloudflare résolu avec proxy injection!");
      
      // Attendre un peu et vérifier la page
      await new Promise(r => setTimeout(r, 5000));
      
      const finalTitle = await page.title();
      console.log(`Titre final: "${finalTitle}"`);
      
      // Vérifier les cookies
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === "cf_clearance");
      
      if (cfClearance) {
        console.log(`✅ Cookie cf_clearance présent: ${cfClearance.value.slice(0, 20)}...`);
      } else {
        console.log("⚠️  Aucun cookie cf_clearance trouvé");
      }
      
      // Prendre une capture d'écran
      await page.screenshot({ path: "test-proxy-injection-success.png", fullPage: true });
      console.log("Capture d'écran sauvegardée: test-proxy-injection-success.png");
      
    } else {
      console.log("❌ Échec de la résolution avec proxy injection");
      
      // Prendre une capture d'écran pour debug
      await page.screenshot({ path: "test-proxy-injection-failed.png", fullPage: true });
      console.log("Capture d'écran sauvegardée: test-proxy-injection-failed.png");
    }
    
  } catch (error) {
    console.error("Erreur pendant le test:", error);
  } finally {
    // Fermer le navigateur
    await browser.close();
    console.log("Test terminé.");
  }
}

// Exécuter le test
testProxyInjection().catch(console.error);