import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveManagedChallengeWithAdaptedInjection } from "./src/cf-managed-injection.js";

async function testSimpleManaged() {
  console.log("Test simple de la méthode adaptée pour Managed Challenge...");
  
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  if (!anticaptchaKey) {
    console.error("ANTICAPTCHA_API_KEY non configurée");
    return;
  }
  
  console.log("Clé Anti-Captcha valide détectée");
  
  // Lancer le navigateur
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Attendre le chargement
    await new Promise(r => setTimeout(r, 5000));
    
    // Vérifier le titre
    const title = await page.title();
    console.log(`Titre: "${title}"`);
    
    // Vérifier si Cloudflare est présent
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    console.log(`Cloudflare détecté: ${isCloudflare ? "OUI" : "NON"}`);
    
    if (!isCloudflare) {
      console.log("Cloudflare non détecté, vérification des cookies...");
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === "cf_clearance");
      if (cfClearance) {
        console.log(`Cookie cf_clearance déjà présent: ${cfClearance.value.slice(0, 20)}...`);
        console.log("Test terminé - déjà authentifié");
        return;
      }
    }
    
    // Utiliser la méthode adaptée
    console.log("\nDébut de la résolution avec méthode adaptée...");
    const result = await solveManagedChallengeWithAdaptedInjection(page, anticaptchaKey);
    
    console.log(`Résultat: ${result}`);
    
    if (result === "solved") {
      console.log("✅ Managed Challenge résolu avec succès!");
      
      // Vérifier le cookie
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === "cf_clearance");
      if (cfClearance) {
        console.log(`Cookie cf_clearance obtenu: ${cfClearance.value.slice(0, 20)}...`);
        console.log(`Expire: ${new Date(cfClearance.expires * 1000).toISOString()}`);
      }
      
      // Prendre une capture
      await page.screenshot({ path: "simple-managed-success.png" });
      console.log("Capture sauvegardée: simple-managed-success.png");
    } else {
      console.log("❌ Échec de la résolution");
      
      // Prendre une capture pour debug
      await page.screenshot({ path: "simple-managed-failed.png", fullPage: true });
      console.log("Capture de debug: simple-managed-failed.png");
      
      // Afficher le HTML pour debug
      const html = await page.content();
      console.log("\nExtrait HTML (500 chars):");
      console.log(html.slice(0, 500));
    }
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("Test terminé.");
  }
}

testSimpleManaged().catch(console.error);