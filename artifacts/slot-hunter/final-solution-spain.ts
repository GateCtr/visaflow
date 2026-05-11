import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { cookieManager, ensureCloudflareCookie, captureCurrentCookies } from "./src/cookie-manager.js";
import { bypassCloudflare, recommendStrategy } from "./src/cloudflare-solver.js";

/**
 * SOLUTION COMPLÈTE POUR LE PORTAL ESPAGNE
 * 
 * Cette solution combine plusieurs approches:
 * 1. Utilisation de cookies capturés manuellement (fonctionne immédiatement)
 * 2. Fallback automatique avec Anti-Captcha si cookie expiré
 * 3. Gestion intelligente du pool de cookies
 * 
 * Étapes:
 * 1. Capturer manuellement un cookie cf_clearance (déjà fait)
 * 2. Utiliser ce cookie pour automatiser les sessions
 * 3. Renouveler périodiquement les cookies
 */

async function testCompleteSolution() {
  console.log("=== SOLUTION COMPLÈTE PORTAL ESPAGNE ===\n");
  
  // 1. Initialiser le gestionnaire de cookies
  console.log("1. Initialisation du gestionnaire de cookies...");
  cookieManager.loadManualCookies();
  cookieManager.cleanupExpiredCookies();
  
  const stats = cookieManager.getStats();
  console.log("   Statistiques cookies:");
  console.log(`   - Total: ${stats.total}`);
  console.log(`   - Valides: ${stats.valid}`);
  console.log(`   - Expirés: ${stats.expired}`);
  console.log(`   - Par source:`, stats.bySource);
  
  if (stats.valid === 0) {
    console.log("   ⚠️ Aucun cookie valide trouvé!");
    console.log("   Veuillez capturer manuellement un cookie cf_clearance.");
    console.log("   Instructions:");
    console.log("   1. Lancer le navigateur manuellement");
    console.log("   2. Résoudre le Cloudflare Challenge");
    console.log("   3. Exporter les cookies dans cloudflare-capture/cookies.json");
    return;
  }
  
  // 2. Lancer le navigateur avec cookie pré-appliqué
  console.log("\n2. Lancement du navigateur avec cookie...");
  const { browser, page, context } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    // Appliquer le cookie
    const cookieApplied = await ensureCloudflareCookie(context, 'citaconsular.es');
    
    if (!cookieApplied) {
      console.log("   ❌ Échec application cookie, tentative de résolution automatique...");
      
      // Fallback: résolution automatique
      const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
      const capsolverKey = process.env.CAPSOLVER_API_KEY;
      const iproyalProxy = process.env.IPROYAL_PROXY_URL;
      
      const success = await bypassCloudflare(page, anticaptchaKey, capsolverKey, iproyalProxy);
      
      if (!success) {
        console.log("   ❌ Échec résolution automatique");
        console.log("   Solution: Capturer manuellement un nouveau cookie");
        return;
      }
      
      // Capturer le nouveau cookie
      await captureCurrentCookies(context);
    }
    
    // 3. Naviguer vers le portail
    console.log("\n3. Navigation vers le portail...");
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`   URL: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // 4. Vérifier si Cloudflare est contourné
    const title = await page.title();
    console.log(`   Titre: "${title}"`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (isCloudflare) {
      console.log("   ❌ Cloudflare toujours présent");
      console.log("   Le cookie a peut-être expiré ou est invalide");
      
      // Essayer de résoudre automatiquement
      console.log("   Tentative de résolution automatique...");
      const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
      const capsolverKey = process.env.CAPSOLVER_API_KEY;
      const iproyalProxy = process.env.IPROYAL_PROXY_URL;
      
      const success = await bypassCloudflare(page, anticaptchaKey, capsolverKey, iproyalProxy);
      
      if (success) {
        // Capturer le nouveau cookie
        await captureCurrentCookies(context);
        console.log("   ✅ Nouveau cookie capturé!");
      } else {
        console.log("   ❌ Échec résolution automatique");
        console.log("   Veuillez capturer manuellement un nouveau cookie");
        return;
      }
    } else {
      console.log("   ✅ Cloudflare contourné avec succès!");
    }
    
    // 5. Vérifier l'accès au widget Bookitit
    console.log("\n4. Vérification du widget Bookitit...");
    
    const hasBookitit = await page.evaluate(() => {
      return !!document.querySelector('#idBktWidgetDefaultBodyContainer') || 
             !!document.querySelector('[class*="bkt"]');
    });
    
    if (hasBookitit) {
      console.log("   ✅ Widget Bookitit détecté!");
      console.log("   🎉 SUCCÈS COMPLET! Le portail est accessible.");
      
      // Prendre une capture d'écran
      await page.screenshot({ path: "spain-portal-accessible.png" });
      console.log("   Capture: spain-portal-accessible.png");
      
      // Tester la navigation
      console.log("\n5. Test de navigation dans le portail...");
      
      try {
        // Essayer d'accéder à la sélection des services
        await page.goto(`${portalUrl}#selectservices`, {
          waitUntil: "domcontentloaded",
          timeout: 15000
        });
        
        const servicesTitle = await page.title();
        console.log(`   Page services: "${servicesTitle}"`);
        
        if (!/un instant|just a moment|verifying/i.test(servicesTitle)) {
          console.log("   ✅ Navigation réussie!");
          
          // Vérifier les services disponibles
          const hasServices = await page.evaluate(() => {
            return !!document.querySelector('.clsDivServiceItem, [class*="service"]');
          });
          
          console.log(`   Services disponibles: ${hasServices ? "✅" : "❌"}`);
        }
      } catch (error) {
        console.log("   Navigation test:", error instanceof Error ? error.message : error);
      }
    } else {
      console.log("   ❌ Widget Bookitit non détecté");
      console.log("   Le portail peut avoir changé ou le cookie est invalide");
    }
    
    // 6. Afficher les informations de session
    console.log("\n6. Informations de session:");
    
    const cookies = await context.cookies();
    const cfClearance = cookies.find(c => c.name === 'cf_clearance');
    
    if (cfClearance) {
      console.log(`   Cookie cf_clearance: ${cfClearance.value.slice(0, 20)}...`);
      console.log(`   Longueur: ${cfClearance.value.length} caractères`);
      console.log(`   Expire: ${new Date(cfClearance.expires * 1000).toLocaleString()}`);
      
      // Durée de vie restante
      const now = Math.floor(Date.now() / 1000);
      const remaining = cfClearance.expires - now;
      const hours = Math.floor(remaining / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      
      console.log(`   Durée restante: ${hours}h ${minutes}m`);
    }
    
    // 7. Recommandations pour la production
    console.log("\n7. RECOMMANDATIONS POUR LA PRODUCTION:");
    console.log("\n   APPROCHE RECOMMANDÉE:");
    console.log("   1. Utiliser le système de gestion de cookies");
    console.log("   2. Capturer périodiquement de nouveaux cookies manuellement");
    console.log("   3. Stocker les cookies dans une base de données");
    console.log("   4. Implémenter une rotation automatique des cookies");
    
    console.log("\n   PLAN D'ACTION:");
    console.log("   Phase 1 (immédiate):");
    console.log("     - Utiliser les cookies capturés manuellement");
    console.log("     - Automatiser le slot-hunter avec ces cookies");
    console.log("     - Durée: 2 heures par cookie");
    
    console.log("\n   Phase 2 (court terme):");
    console.log("     - Développer un système de capture semi-automatique");
    console.log("     - Tester différents proxies résidentiels");
    console.log("     - Évaluer CapSolver avec proxy fixe");
    
    console.log("\n   Phase 3 (long terme):");
    console.log("     - Implémenter la résolution complètement automatique");
    console.log("     - Utiliser un pool de proxies résidentiels");
    console.log("     - Intégrer avec Anti-Captcha/CapSolver");
    
  } catch (error) {
    console.error("Erreur pendant le test:", error);
  } finally {
    await browser.close();
    console.log("\nTest terminé.");
  }
}

/**
 * Fonction pour capturer un nouveau cookie manuellement
 */
async function captureNewCookie() {
  console.log("=== CAPTURE MANUELLE DE COOKIE ===\n");
  console.log("Instructions:");
  console.log("1. Un navigateur va s'ouvrir");
  console.log("2. Résolvez manuellement le Cloudflare Challenge");
  console.log("3. Attendez que le portail soit accessible");
  console.log("4. Le cookie sera automatiquement capturé");
  console.log("\nAppuyez sur Entrée pour continuer...");
  
  // Attendre l'entrée utilisateur
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });
  
  const { browser, page, context } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    console.log("\nNavigation vers le portail...");
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    console.log("\n✅ Navigateur ouvert!");
    console.log("Veuillez résoudre manuellement le Cloudflare Challenge.");
    console.log("Une fois résolu, appuyez sur Entrée pour capturer le cookie...");
    
    // Attendre que l'utilisateur résolve le challenge
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
    
    // Capturer les cookies
    const captured = await captureCurrentCookies(context);
    
    if (captured) {
      console.log("\n✅ Cookie capturé avec succès!");
      
      // Afficher les statistiques
      const stats = cookieManager.getStats();
      console.log("Nouvelle statistique:", stats);
      
      // Tester le cookie
      const remaining = cookieManager.getRemainingLifetime('citaconsular.es');
      const hours = Math.floor(remaining / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      
      console.log(`Durée de vie: ${hours}h ${minutes}m`);
    } else {
      console.log("\n❌ Aucun cookie Cloudflare capturé");
      console.log("Assurez-vous d'avoir résolu le challenge");
    }
    
  } finally {
    await browser.close();
    console.log("\nCapture terminée.");
  }
}

/**
 * Menu principal
 */
async function main() {
  console.log("=== MENU PRINCIPAL - SOLUTION ESPAGNE ===\n");
  console.log("1. Tester la solution complète");
  console.log("2. Capturer un nouveau cookie manuellement");
  console.log("3. Afficher les statistiques des cookies");
  console.log("4. Quitter");
  console.log("\nChoisissez une option (1-4): ");
  
  const choice = await new Promise<string>(resolve => {
    process.stdin.once('data', data => {
      resolve(data.toString().trim());
    });
  });
  
  switch (choice) {
    case '1':
      await testCompleteSolution();
      break;
    case '2':
      await captureNewCookie();
      break;
    case '3':
      const stats = cookieManager.getStats();
      console.log("\nStatistiques des cookies:");
      console.log(JSON.stringify(stats, null, 2));
      break;
    case '4':
      console.log("Au revoir!");
      process.exit(0);
      break;
    default:
      console.log("Option invalide");
  }
  
  // Revenir au menu
  console.log("\nAppuyez sur Entrée pour revenir au menu...");
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });
  
  await main();
}

// Démarrer le programme
if (process.argv.includes('--capture')) {
  captureNewCookie().catch(console.error);
} else if (process.argv.includes('--test')) {
  testCompleteSolution().catch(console.error);
} else {
  main().catch(console.error);
}