import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { extractTurnstileSitekey, detectAndSolveTurnstile } from "./src/captcha.js";

async function testCapsolverSpain() {
  console.log("Test de CapSolver avec le portail Espagne...");
  
  // Vérifier les clés API
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const twoCaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  
  console.log(`Clé CapSolver: ${capsolverKey ? "OUI" : "NON"}`);
  console.log(`Clé Anti-Captcha: ${anticaptchaKey ? "OUI" : "NON"}`);
  console.log(`Clé 2captcha: ${twoCaptchaKey ? "OUI" : "NON"}`);
  
  if (!capsolverKey) {
    console.error("ERREUR: CAPSOLVER_API_KEY n'est pas configurée!");
    return;
  }
  
  // Lancer le navigateur
  console.log("Lancement du navigateur avec proxy iProyal...");
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
    
    // Extraire le sitekey
    console.log("Extraction du sitekey...");
    const sitekeyResult = await extractTurnstileSitekey(page);
    
    if (!sitekeyResult) {
      console.log("❌ Aucun sitekey trouvé");
      await browser.close();
      return;
    }
    
    console.log(`✅ Sitekey trouvé: ${sitekeyResult.sitekey}`);
    console.log(`   Type: ${sitekeyResult.isCfChallenge ? "CF Managed Challenge" : "Turnstile standard"}`);
    
    if (sitekeyResult.isCfChallenge) {
      console.log("⚠️  C'est un Cloudflare Managed Challenge - CapSolver AntiCloudflareTask requis");
      console.log("   Cette tâche nécessite un proxy (iProyal) et peut prendre 30-60 secondes");
    } else {
      console.log("✅ C'est un Turnstile standard - CapSolver AntiTurnstileTaskProxyLess peut être utilisé");
    }
    
    // Tester CapSolver
    console.log("\nTest de résolution avec CapSolver...");
    
    const result = await detectAndSolveTurnstile(
      page,
      twoCaptchaKey, // twoCaptchaApiKey
      capsolverKey,  // capsolverApiKey
      process.env.IPROYAL_PROXY_URL, // proxyUrl
      anticaptchaKey, // anticaptchaApiKey
    );
    
    console.log(`Résultat CapSolver: ${result}`);
    
    if (result === "solved") {
      console.log("✅ SUCCÈS - Cloudflare résolu avec CapSolver!");
      
      // Attendre un peu et vérifier la page
      await new Promise(r => setTimeout(r, 5000));
      
      const finalTitle = await page.title();
      console.log(`Titre final: "${finalTitle}"`);
      
      // Vérifier si on a accès au portail
      const hasAccess = !/un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i.test(finalTitle);
      
      if (hasAccess) {
        console.log("✅ ACCÈS AU PORTAL OBTENU!");
        
        // Vérifier les cookies
        const cookies = await page.context().cookies();
        const cfClearance = cookies.find(c => c.name === "cf_clearance");
        
        if (cfClearance) {
          console.log(`✅ Cookie cf_clearance présent: ${cfClearance.value.slice(0, 20)}...`);
        }
        
        // Essayer d'accéder au widget Bookitit
        console.log("Tentative d'accès au widget Bookitit...");
        
        // Attendre un peu pour voir le contenu
        await new Promise(r => setTimeout(r, 3000));
        
        // Vérifier le contenu de la page
        const pageContent = await page.content();
        const hasBookitit = pageContent.includes("bookitit") || pageContent.includes("bkt_");
        
        if (hasBookitit) {
          console.log("✅ Widget Bookitit détecté!");
        } else {
          console.log("⚠️  Widget Bookitit non détecté dans le HTML");
        }
        
      } else {
        console.log("❌ Cloudflare toujours présent après résolution");
      }
      
      // Prendre une capture d'écran
      await page.screenshot({ path: "test-capsolver-success.png", fullPage: true });
      console.log("Capture d'écran sauvegardée: test-capsolver-success.png");
      
    } else if (result === "no_key") {
      console.log("❌ Aucune clé captcha disponible");
    } else {
      console.log("❌ Échec de la résolution");
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
testCapsolverSpain().catch(console.error);