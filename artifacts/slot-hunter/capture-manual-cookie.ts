import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { cookieManager, captureCurrentCookies } from "./src/cookie-manager.js";

async function captureManualCookie() {
  console.log("=== CAPTURE MANUELLE DE COOKIE CLOUDFLARE ===\n");
  console.log("Instructions:");
  console.log("1. Le navigateur va s'ouvrir");
  console.log("2. Résolvez MANUELLEMENT le captcha Cloudflare");
  console.log("3. Attendez que la page se charge complètement");
  console.log("4. Le cookie sera automatiquement capturé");
  console.log("5. Fermez le navigateur quand c'est fait\n");
  
  console.log("Appuyez sur Entrée pour commencer...");
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });
  
  // Lancer le navigateur SANS proxy pour faciliter la résolution manuelle
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "none", // Pas de proxy pour faciliter
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\nNavigation vers: ${portalUrl}\n`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    console.log("=== INSTRUCTIONS POUR L'UTILISATEUR ===\n");
    console.log("1. Résolvez le captcha Cloudflare qui apparaît");
    console.log("2. Attendez que la page du portail se charge complètement");
    console.log("3. Une fois la page chargée, appuyez sur Entrée dans ce terminal");
    console.log("\nLe cookie sera alors capturé automatiquement.\n");
    
    // Attendre que l'utilisateur résolve le captcha
    console.log("Appuyez sur Entrée APRÈS avoir résolu le captcha...");
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
    
    // Capturer les cookies
    console.log("\nCapture des cookies en cours...\n");
    const context = page.context();
    const captured = await captureCurrentCookies(context);
    
    if (captured) {
      console.log("✅ Cookie capturé avec succès!\n");
      
      // Afficher les statistiques
      const stats = cookieManager.getStats();
      console.log("Statistiques du pool de cookies:");
      console.log(`- Total: ${stats.total}`);
      console.log(`- Valides: ${stats.valid}`);
      console.log(`- Expirés: ${stats.expired}`);
      console.log(`- Par source:`, stats.bySource);
      console.log(`- Par domaine:`, stats.byDomain);
      console.log("");
      
      // Exporter le cookie pour vérification
      const domain = "citaconsular.es";
      const cookies = cookieManager.exportForDomain(domain);
      
      if (cookies.length > 0) {
        console.log(`Cookies disponibles pour ${domain}:`);
        cookies.forEach((cookie, index) => {
          console.log(`\n[${index + 1}] ${cookie.name}:`);
          console.log(`  Valeur: ${cookie.value.slice(0, 30)}...`);
          console.log(`  Domaine: ${cookie.domain}`);
          console.log(`  Expire: ${new Date(cookie.expires * 1000).toLocaleString()}`);
          console.log(`  Source: ${cookie.source}`);
          console.log(`  Capturé: ${new Date(cookie.capturedAt).toLocaleString()}`);
        });
        
        console.log("\n🎉 Le cookie est prêt à être utilisé!");
        console.log("Vous pouvez maintenant exécuter:");
        console.log("  npm run cloudflare:test-unified");
        console.log("pour tester avec le nouveau cookie.\n");
      }
    } else {
      console.log("❌ Aucun cookie Cloudflare capturé.");
      console.log("Vérifiez que:");
      console.log("1. Vous avez bien résolu le captcha");
      console.log("2. La page s'est chargée complètement");
      console.log("3. Le cookie cf_clearance est présent\n");
    }
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("\nNavigateur fermé.");
    console.log("Pour tester le cookie capturé, exécutez:");
    console.log("  npm run cloudflare:test-unified\n");
  }
}

captureManualCookie().catch(console.error);