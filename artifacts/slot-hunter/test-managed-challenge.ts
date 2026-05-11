import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveCloudflareManagedChallenge } from "./src/cf-managed-injection.js";

async function testManagedChallenge() {
  console.log("Test de la méthode adaptée pour Cloudflare Managed Challenge...");
  
  // Vérifier les clés API
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  
  console.log(`Clé Anti-Captcha: ${anticaptchaKey ? "OUI" : "NON"}`);
  console.log(`Clé CapSolver: ${capsolverKey ? "OUI" : "NON"}`);
  
  if (!anticaptchaKey) {
    console.error("ERREUR: ANTICAPTCHA_API_KEY n'est pas configurée!");
    return;
  }
  
  // Lancer le navigateur
  console.log("Lancement du navigateur avec proxy...");
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
    
    // Attendre que Cloudflare charge
    await new Promise(r => setTimeout(r, 5000));
    
    // Vérifier les cookies avant résolution
    const initialCookies = await page.context().cookies();
    const initialCfClearance = initialCookies.find(c => c.name === "cf_clearance");
    console.log(`Cookie cf_clearance initial: ${initialCfClearance ? "PRÉSENT" : "ABSENT"}`);
    
    if (initialCfClearance) {
      console.log(`  Valeur: ${initialCfClearance.value.slice(0, 20)}...`);
      console.log(`  Expire: ${new Date(initialCfClearance.expires * 1000).toISOString()}`);
    }
    
    // Utiliser la méthode adaptée pour Managed Challenge
    console.log("\nUtilisation de solveCloudflareManagedChallenge...");
    
    const startTime = Date.now();
    const result = await solveCloudflareManagedChallenge(
      page,
      anticaptchaKey,
      capsolverKey,
      undefined // twoCaptchaApiKey
    );
    
    const elapsedTime = Date.now() - startTime;
    console.log(`Résultat: ${result} (temps: ${elapsedTime}ms)`);
    
    // Vérifier les cookies après résolution
    const finalCookies = await page.context().cookies();
    const finalCfClearance = finalCookies.find(c => c.name === "cf_clearance");
    
    console.log(`\nCookie cf_clearance final: ${finalCfClearance ? "PRÉSENT" : "ABSENT"}`);
    if (finalCfClearance) {
      console.log(`  Valeur: ${finalCfClearance.value.slice(0, 20)}...`);
      console.log(`  Expire: ${new Date(finalCfClearance.expires * 1000).toISOString()}`);
      console.log(`  Longueur: ${finalCfClearance.value.length} caractères`);
      
      // Comparer avec le cookie initial
      if (initialCfClearance && finalCfClearance.value !== initialCfClearance.value) {
        console.log("  ✅ Nouveau cookie obtenu!");
      } else if (!initialCfClearance) {
        console.log("  ✅ Cookie créé avec succès!");
      } else {
        console.log("  ⚠️  Même cookie qu'avant");
      }
    }
    
    // Vérifier si la page a changé (redirection après succès)
    const finalUrl = page.url();
    console.log(`\nURL finale: ${finalUrl}`);
    
    if (finalUrl !== portalUrl) {
      console.log("✅ Redirection détectée - probablement succès!");
    }
    
    // Vérifier le contenu de la page
    const finalTitle = await page.title();
    console.log(`Titre final: "${finalTitle}"`);
    
    // Chercher des indicateurs de succès
    const pageContent = await page.content();
    const successIndicators = [
      "Embajada de España",
      "VISADOS", 
      "Servicios disponibles",
      "No hay horas disponibles",
      "bookitit",
      "widgetdefault"
    ];
    
    console.log("\nIndicateurs dans la page:");
    for (const indicator of successIndicators) {
      const found = pageContent.includes(indicator);
      console.log(`  ${indicator}: ${found ? "✅" : "❌"}`);
    }
    
    // Prendre une capture d'écran
    await page.screenshot({ path: "test-managed-challenge.png", fullPage: true });
    console.log("\nCapture d'écran sauvegardée: test-managed-challenge.png");
    
    // Si succès, tester la navigation dans le portail
    if (result === "solved" || finalCfClearance) {
      console.log("\nTest de navigation avec le cookie cf_clearance...");
      
      // Essayer d'accéder à une autre page du portail
      try {
        await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5#selectservices", {
          waitUntil: "domcontentloaded",
          timeout: 15000
        });
        
        const servicesTitle = await page.title();
        console.log(`Page services titre: "${servicesTitle}"`);
        
        // Vérifier si on voit les services
        const servicesContent = await page.content();
        if (servicesContent.includes("Servicios disponibles") || servicesContent.includes("No hay horas disponibles")) {
          console.log("✅ Accès au portail réussi avec cf_clearance!");
        } else {
          console.log("⚠️  Accès au portail, mais contenu différent");
        }
      } catch (error) {
        console.log("❌ Erreur navigation: ", error instanceof Error ? error.message : error);
      }
    }
    
  } catch (error) {
    console.error("Erreur pendant le test:", error);
  } finally {
    // Fermer le navigateur
    await browser.close();
    console.log("\nTest terminé.");
  }
}

// Exécuter le test
testManagedChallenge().catch(console.error);