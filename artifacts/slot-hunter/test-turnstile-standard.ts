import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveTurnstileWithProxyInjection } from "./src/captcha.js";

async function testTurnstileStandard() {
  console.log("Test de la méthode de proxy injection pour Turnstile standard...");
  
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
    proxySource: "auto",
  });
  
  try {
    // Utiliser la page de démo Cloudflare Turnstile (Turnstile standard, pas Managed Challenge)
    const testUrl = "https://demo.turnstile.cloudflare.com/";
    console.log(`Navigation vers: ${testUrl}`);
    
    await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Vérifier le titre
    const title = await page.title();
    console.log(`Titre de la page: "${title}"`);
    
    // Attendre un peu pour que la page charge
    console.log("Attente de 5 secondes pour que la page charge...");
    await new Promise(r => setTimeout(r, 5000));
    
    // Vérifier si Turnstile est présent
    const hasTurnstile = await page.evaluate(() => {
      return !!(window as any).turnstile || !!document.querySelector('.cf-turnstile');
    });
    
    if (!hasTurnstile) {
      console.log("❌ Turnstile non détecté sur cette page");
      await browser.close();
      return;
    }
    
    console.log("✅ Turnstile détecté, tentative de résolution avec proxy injection...");
    
    // Tester la nouvelle méthode
    const result = await solveTurnstileWithProxyInjection(page, anticaptchaKey);
    
    console.log(`Résultat: ${result}`);
    
    if (result === "solved") {
      console.log("✅ SUCCÈS - Turnstile résolu avec proxy injection!");
      
      // Attendre un peu et vérifier la page
      await new Promise(r => setTimeout(r, 3000));
      
      // Prendre une capture d'écran
      await page.screenshot({ path: "test-turnstile-standard-success.png", fullPage: true });
      console.log("Capture d'écran sauvegardée: test-turnstile-standard-success.png");
      
    } else {
      console.log("❌ Échec de la résolution avec proxy injection");
      
      // Prendre une capture d'écran pour debug
      await page.screenshot({ path: "test-turnstile-standard-failed.png", fullPage: true });
      console.log("Capture d'écran sauvegardée: test-turnstile-standard-failed.png");
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
testTurnstileStandard().catch(console.error);