import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { bypassCloudflare, recommendStrategy, hasFixedIpProxy } from "./src/cloudflare-solver.js";

async function testCloudflareIntegration() {
  console.log("=== TEST INTÉGRATION CLOUDFLARE SOLVER ===\n");
  
  // Configuration
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const iproyalProxy = process.env.IPROYAL_PROXY_URL;
  const brightdataProxy = process.env.BRIGHTDATA_PROXY_URL;
  
  console.log("Configuration disponible:");
  console.log(`- Anti-Captcha: ${anticaptchaKey ? "✅" : "❌"}`);
  console.log(`- CapSolver: ${capsolverKey ? "✅" : "❌"}`);
  console.log(`- iProyal: ${iproyalProxy ? "✅" : "❌"}`);
  console.log(`- Bright Data: ${brightdataProxy ? "✅" : "❌"}`);
  
  // Vérifier les proxies
  if (iproyalProxy) {
    const iproyalFixed = hasFixedIpProxy(iproyalProxy);
    console.log(`- iProyal IP fixe: ${iproyalFixed ? "✅" : "❌ (dynamique)"}`);
  }
  
  if (brightdataProxy) {
    const brightdataFixed = hasFixedIpProxy(brightdataProxy);
    console.log(`- Bright Data IP fixe: ${brightdataFixed ? "✅" : "❌ (dynamique)"}`);
  }
  
  // Recommander une stratégie
  const recommended = recommendStrategy({
    anticaptchaApiKey: anticaptchaKey,
    capsolverApiKey: capsolverKey,
    capsolverProxyUrl: iproyalProxy,
  });
  
  console.log(`\n🎯 Stratégie recommandée: ${recommended}`);
  
  // Tester avec le portail Espagne
  console.log("\n=== TEST PORTAL ESPAGNE ===\n");
  
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title = await page.title();
    console.log(`Titre initial: "${title}"`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log("✅ Cloudflare non détecté - déjà authentifié?");
      
      // Vérifier les cookies
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');
      if (cfClearance) {
        console.log(`Cookie cf_clearance présent: ${cfClearance.value.slice(0, 20)}...`);
      }
      
      return;
    }
    
    console.log("❌ Cloudflare détecté - début résolution intelligente...");
    
    // Prendre une capture avant
    await page.screenshot({ path: "before-cloudflare-solver.png" });
    console.log("Capture avant: before-cloudflare-solver.png");
    
    // Utiliser le solveur intelligent
    const startTime = Date.now();
    const success = await bypassCloudflare(
      page,
      anticaptchaKey,
      capsolverKey,
      iproyalProxy
    );
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\nRésultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (temps: ${elapsedTime}ms)`);
    
    if (success) {
      // Vérifier le résultat
      const finalTitle = await page.title();
      console.log(`Titre final: "${finalTitle}"`);
      
      const finalIsCloudflare = /un instant|just a moment|verifying/i.test(finalTitle);
      
      if (!finalIsCloudflare) {
        console.log("✅ Cloudflare résolu avec succès!");
        
        // Vérifier les cookies
        const cookies = await page.context().cookies();
        const cfClearance = cookies.find(c => c.name === 'cf_clearance');
        if (cfClearance) {
          console.log(`Cookie cf_clearance obtenu: ${cfClearance.value.slice(0, 20)}...`);
        }
        
        // Test navigation
        console.log("\nTest navigation dans le portail...");
        try {
          await page.goto(`${portalUrl}#selectservices`, {
            waitUntil: "domcontentloaded",
            timeout: 15000
          });
          
          const servicesTitle = await page.title();
          console.log(`Page services: "${servicesTitle}"`);
          
          if (!/un instant|just a moment|verifying/i.test(servicesTitle)) {
            console.log("✅ Navigation réussie!");
            
            // Vérifier le contenu Bookitit
            const hasBookitit = await page.evaluate(() => {
              return !!document.querySelector('#idBktWidgetDefaultBodyContainer') || 
                     !!document.querySelector('[class*="bkt"]');
            });
            
            console.log(`Widget Bookitit détecté: ${hasBookitit ? "✅" : "❌"}`);
          }
        } catch (error) {
          console.log("Navigation test:", error instanceof Error ? error.message : error);
        }
      } else {
        console.log("❌ Cloudflare toujours présent");
      }
    } else {
      console.log("\n=== ANALYSE DE L'ÉCHEC ===");
      console.log("Problèmes possibles:");
      console.log("1. Cloudflare Managed Challenge très strict");
      console.log("2. Anti-Captcha ne supporte pas Managed Challenge");
      console.log("3. Proxy iProyal a IP dynamique (incompatible CapSolver)");
      console.log("\nSolutions à explorer:");
      console.log("1. Obtenir un proxy résidentiel avec IP fixe");
      console.log("2. Utiliser l'approche manuelle avec cookie capturé");
      console.log("3. Contacter le support Anti-Captcha pour Managed Challenge");
    }
    
    // Prendre une capture après
    await page.screenshot({ path: "after-cloudflare-solver.png" });
    console.log("\nCapture après: after-cloudflare-solver.png");
    
  } catch (error) {
    console.error("Erreur pendant le test:", error);
  } finally {
    await browser.close();
    console.log("\nTest terminé.");
  }
}

// Fonction pour tester avec cookie capturé
async function testCookieReuse() {
  console.log("\n\n=== TEST RÉUTILISATION COOKIE ===\n");
  
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    // Charger le cookie capturé
    const fs = await import('fs');
    const cookiesPath = './cloudflare-capture/cookies.json';
    
    if (!fs.existsSync(cookiesPath)) {
      console.error("Fichier cookies.json non trouvé");
      return;
    }
    
    const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
    const cfClearanceCookie = cookiesData.find((c: any) => c.name === 'cf_clearance');
    
    if (!cfClearanceCookie) {
      console.error("Cookie cf_clearance non trouvé");
      return;
    }
    
    console.log(`Cookie capturé: ${cfClearanceCookie.value.slice(0, 20)}...`);
    console.log(`Expire: ${new Date(cfClearanceCookie.expires * 1000).toLocaleString()}`);
    
    // Ajouter le cookie
    await page.context().addCookies([{
      name: 'cf_clearance',
      value: cfClearanceCookie.value,
      domain: cfClearanceCookie.domain || '.citaconsular.es',
      path: cfClearanceCookie.path || '/',
      expires: cfClearanceCookie.expires || Math.floor(Date.now() / 1000) + 7200,
      httpOnly: cfClearanceCookie.httpOnly || true,
      secure: cfClearanceCookie.secure !== false,
      sameSite: cfClearanceCookie.sameSite || 'None',
    }]);
    
    console.log("Cookie ajouté au navigateur");
    
    // Naviguer
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title = await page.title();
    console.log(`Titre: "${title}"`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log("✅ Cloudflare contourné avec cookie capturé!");
      
      // Vérifier le widget Bookitit
      const hasBookitit = await page.evaluate(() => {
        return !!document.querySelector('#idBktWidgetDefaultBodyContainer');
      });
      
      console.log(`Widget Bookitit détecté: ${hasBookitit ? "✅" : "❌"}`);
      
      if (hasBookitit) {
        console.log("\n🎉 SUCCÈS COMPLET! Le cookie capturé fonctionne.");
        console.log("Cette approche peut être utilisée pour:");
        console.log("1. Automatiser la résolution manuelle");
        console.log("2. Réutiliser les sessions valides");
        console.log("3. Éviter les providers de captcha");
      }
    } else {
      console.log("❌ Cookie expiré ou invalide");
    }
    
  } catch (error) {
    console.error("Erreur test cookie:", error);
  } finally {
    await browser.close();
  }
}

// Exécuter les tests
async function runAllTests() {
  await testCloudflareIntegration();
  await testCookieReuse();
  
  console.log("\n\n=== RECOMMANDATIONS FINALES ===");
  console.log("\nBasé sur les tests, voici la meilleure approche:");
  console.log("\n1. APPROCHE IMMÉDIATE (fonctionne):");
  console.log("   - Utiliser le cookie cf_clearance capturé manuellement");
  console.log("   - Durée de vie: ~2 heures");
  console.log("   - Avantage: Pas besoin de résoudre captcha");
  console.log("   - Inconvénient: Nécessite résolution manuelle périodique");
  
  console.log("\n2. APPROCHE AUTOMATIQUE (à développer):");
  console.log("   - Obtenir un proxy résidentiel avec IP fixe");
  console.log("   - Utiliser CapSolver AntiCloudflareTask");
  console.log("   - Avantage: Complètement automatique");
  console.log("   - Inconvénient: Coût proxy fixe + service CapSolver");
  
  console.log("\n3. APPROCHE HYBRIDE (recommandée):");
  console.log("   - Utiliser cookie capturé pour les sessions courtes");
  console.log("   - Développer un système de rotation de cookies");
  console.log("   - Capturer périodiquement de nouveaux cookies manuellement");
  console.log("   - Stocker les cookies valides dans une base de données");
  
  console.log("\n📋 Prochaines étapes:");
  console.log("1. Implémenter la rotation de cookies dans le slot-hunter");
  console.log("2. Tester différents proxies résidentiels avec IP fixe");
  console.log("3. Contacter le support Anti-Captcha pour Managed Challenge");
}

runAllTests().catch(console.error);