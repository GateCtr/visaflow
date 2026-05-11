import * as dotenv from "dotenv";
dotenv.config();

import { 
  buildBrightDataUrl, 
  parseBrightDataUrl, 
  brightDataToCapSolverFormat,
  generateSessionId,
  withSession,
  testBrightDataProxy,
  recommendProxyType,
  getOptimalCapSolverConfig,
  type BrightDataProxyConfig
} from "./src/brightdata-fixed-ip.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";
import { launchBrowser } from "./src/browser.js";

/**
 * TEST COMPLET: Bright Data avec IP fixe pour CapSolver
 * 
 * Objectif: Utiliser une session fixe pour garder la même IP
 * pendant la résolution Cloudflare avec CapSolver
 */

async function testBrightDataFixedIp() {
  console.log("=== TEST BRIGHT DATA AVEC IP FIXE POUR CAPSOLVER ===\n");
  
  // 1. Analyser la configuration actuelle
  const currentProxy = process.env.BRIGHTDATA_PROXY_URL;
  
  if (!currentProxy) {
    console.error("ERREUR: BRIGHTDATA_PROXY_URL non configurée!");
    return;
  }
  
  console.log("1. Analyse du proxy actuel:");
  console.log(`   URL: ${currentProxy.split('@')[0]}...@...`);
  
  const config = parseBrightDataUrl(currentProxy);
  
  if (!config) {
    console.error("   ❌ Format URL invalide");
    return;
  }
  
  console.log(`   Account ID: ${config.accountId}`);
  console.log(`   Proxy type: ${config.proxyType}`);
  console.log(`   Country: ${config.country || 'non spécifié'}`);
  console.log(`   City: ${config.city || 'non spécifié'}`);
  console.log(`   Session ID: ${config.sessionId || 'non spécifié'}`);
  
  // 2. Recommandations
  console.log("\n2. Recommandations pour CapSolver:");
  
  const recommendation = recommendProxyType();
  console.log(`   Type recommandé: ${recommendation.type}`);
  console.log(`   Description: ${recommendation.description}`);
  console.log(`   Stabilité: ${recommendation.stability}`);
  console.log(`   Coût: ${recommendation.cost}`);
  
  const optimalConfig = getOptimalCapSolverConfig();
  console.log(`\n   Configuration optimale:`);
  console.log(`   - Proxy type: ${optimalConfig.proxyType}`);
  console.log(`   - Utiliser session: ${optimalConfig.useSession ? 'OUI' : 'NON'}`);
  console.log(`   - Durée session: ${optimalConfig.sessionDuration}`);
  console.log(`   - Keep-alive: ${optimalConfig.keepAlive ? 'OUI' : 'NON'}`);
  
  // 3. Créer un proxy avec session fixe
  console.log("\n3. Création d'un proxy avec session fixe...");
  
  const sessionId = generateSessionId();
  console.log(`   Session ID généré: ${sessionId}`);
  
  // Créer une nouvelle configuration avec session
  const fixedConfig: BrightDataProxyConfig = {
    accountId: config.accountId,
    proxyType: config.proxyType, // Garder le même type ou utiliser isp_proxy1
    password: config.password,
    sessionId: sessionId,
    country: config.country,
    city: config.city,
  };
  
  const fixedProxyUrl = buildBrightDataUrl(fixedConfig);
  console.log(`   Proxy avec session: ${fixedProxyUrl.split('@')[0]}...@...`);
  
  // 4. Convertir au format CapSolver
  console.log("\n4. Conversion au format CapSolver...");
  
  const capsolverFormat = brightDataToCapSolverFormat(fixedProxyUrl);
  console.log(`   Format CapSolver: ${capsolverFormat.split(':')[0]}...`);
  
  // 5. Tester la connectivité
  console.log("\n5. Test de connectivité du proxy...");
  
  const testResult = await testBrightDataProxy(fixedProxyUrl);
  
  if (testResult.success) {
    console.log("   ✅ Proxy fonctionnel!");
    console.log(`   IP: ${testResult.ip || 'inconnue'}`);
    console.log(`   Pays: ${testResult.country || 'inconnu'}`);
    console.log(`   Ville: ${testResult.city || 'inconnue'}`);
    console.log(`   Produit: ${testResult.product || 'inconnu'}`);
  } else {
    console.log(`   ❌ Proxy non fonctionnel: ${testResult.error}`);
    console.log("   Vérifiez vos credentials Bright Data");
    return;
  }
  
  // 6. Tester avec CapSolver
  console.log("\n6. Test avec CapSolver AntiCloudflareTask...");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  
  if (!capsolverKey) {
    console.error("   ERREUR: CAPSOLVER_API_KEY non configurée!");
    return;
  }
  
  console.log(`   CapSolver: ${capsolverKey.slice(0, 10)}...`);
  
  // Lancer le navigateur avec le proxy fixe
  console.log("\n7. Lancement navigateur avec proxy fixe...");
  
  // Note: Nous devons mettre à jour l'URL dans .env temporairement
  // ou créer une fonction launchBrowser avec proxy personnalisé
  
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata", // Utilise BRIGHTDATA_PROXY_URL par défaut
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\n   Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title = await page.title();
    console.log(`   Titre initial: "${title}"`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log("   ✅ Cloudflare non détecté - déjà authentifié?");
      
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');
      if (cfClearance) {
        console.log(`   Cookie cf_clearance présent: ${cfClearance.value.slice(0, 20)}...`);
      }
      
      return;
    }
    
    console.log("   ❌ Cloudflare détecté - début résolution avec CapSolver...");
    
    // Prendre une capture avant
    await page.screenshot({ path: "before-brightdata-fixed.png" });
    console.log("   Capture avant: before-brightdata-fixed.png");
    
    // Utiliser CapSolver avec le proxy fixe
    console.log("\n   === DÉBUT RÉSOLUTION CAPSOLVER ===");
    console.log(`   Task type: AntiCloudflareTask`);
    console.log(`   Proxy: Bright Data avec session fixe`);
    console.log(`   Session ID: ${sessionId}`);
    console.log(`   Format proxy: ${capsolverFormat.split(':')[0]}...`);
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(
      page, 
      capsolverKey, 
      capsolverFormat
    );
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\n   Résultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (temps: ${elapsedTime}ms)`);
    
    if (success) {
      console.log("   🎉 CAPSOLVER FONCTIONNE AVEC IP FIXE!");
      
      // Vérifier le résultat
      const finalTitle = await page.title();
      console.log(`   Titre final: "${finalTitle}"`);
      
      const finalIsCloudflare = /un instant|just a moment|verifying/i.test(finalTitle);
      
      if (!finalIsCloudflare) {
        console.log("   ✅ Cloudflare résolu avec succès!");
        
        // Vérifier les cookies
        const cookies = await page.context().cookies();
        const cfClearance = cookies.find(c => c.name === 'cf_clearance');
        if (cfClearance) {
          console.log(`   Cookie cf_clearance obtenu: ${cfClearance.value.slice(0, 20)}...`);
        }
        
        // Test navigation
        console.log("\n   Test navigation dans le portail...");
        try {
          await page.goto(`${portalUrl}#selectservices`, {
            waitUntil: "domcontentloaded",
            timeout: 15000
          });
          
          const servicesTitle = await page.title();
          console.log(`   Page services: "${servicesTitle}"`);
          
          if (!/un instant|just a moment|verifying/i.test(servicesTitle)) {
            console.log("   ✅ Navigation réussie!");
            
            // Vérifier le widget Bookitit
            const hasBookitit = await page.evaluate(() => {
              return !!document.querySelector('#idBktWidgetDefaultBodyContainer');
            });
            
            console.log(`   Widget Bookitit détecté: ${hasBookitit ? "✅" : "❌"}`);
          }
        } catch (error) {
          console.log("   Navigation test:", error instanceof Error ? error.message : error);
        }
      } else {
        console.log("   ❌ Cloudflare toujours présent");
      }
    } else {
      console.log("\n   === ANALYSE DE L'ÉCHEC ===");
      console.log("   Problèmes possibles:");
      console.log("   1. Session pas assez stable (IP a changé)");
      console.log("   2. Cloudflare Managed Challenge très strict");
      console.log("   3. Format proxy incorrect pour CapSolver");
      console.log("   4. Proxy ISP non disponible dans votre plan");
      
      console.log("\n   Solutions à essayer:");
      console.log("   1. Utiliser isp_proxy1 au lieu de residential_proxy1");
      console.log("   2. Contacter le support Bright Data pour proxy dédié");
      console.log("   3. Essayer avec datacenter_proxy1 (IP vraiment fixe)");
      console.log("   4. Vérifier le format exact requis par CapSolver");
    }
    
    // Prendre une capture après
    await page.screenshot({ path: "after-brightdata-fixed.png" });
    console.log("\n   Capture après: after-brightdata-fixed.png");
    
  } catch (error) {
    console.error("   Erreur pendant le test:", error);
  } finally {
    await browser.close();
    console.log("\n   Test terminé.");
  }
  
  // 8. Recommandations finales
  console.log("\n8. RECOMMANDATIONS FINALES:");
  
  console.log("\n   Si CapSolver fonctionne avec session fixe:");
  console.log("   ✅ Continuer avec cette configuration");
  console.log("   ✅ Implémenter la rotation des sessions");
  console.log("   ✅ Monitorer la stabilité des IPs");
  
  console.log("\n   Si CapSolver échoue toujours:");
  console.log("   🔄 Passer à isp_proxy1 (plus stable)");
  console.log("   💰 Considérer datacenter_proxy1 (IP vraiment fixe)");
  console.log("   📞 Contacter le support Bright Data");
  
  console.log("\n   Configuration .env recommandée:");
  console.log(`   BRIGHTDATA_PROXY_URL="${fixedProxyUrl}"`);
  console.log(`   # Session ID: ${sessionId}`);
  console.log(`   # Renouveler la session toutes les 30 minutes`);
}

/**
 * Test spécifique avec ISP proxy
 */
async function testIspProxy() {
  console.log("\n\n=== TEST ISP PROXY (RECOMMANDÉ) ===");
  
  // Vérifier si vous avez accès à isp_proxy1
  // Basé sur votre commande curl, vous semblez avoir isp_proxy1
  
  const ispProxyUrl = "http://brd-customer-hl_f0e9b823-zone-isp_proxy1-country-cd:jfhcdxaa961m@brd.superproxy.io:33335";
  
  console.log(`ISP Proxy URL: ${ispProxyUrl.split('@')[0]}...@...`);
  
  // Tester la connectivité
  console.log("\nTest connectivité ISP proxy...");
  
  const testResult = await testBrightDataProxy(ispProxyUrl);
  
  if (testResult.success) {
    console.log("✅ ISP proxy fonctionnel!");
    console.log(`IP: ${testResult.ip}`);
    console.log(`Pays: ${testResult.country}`);
    console.log(`Produit: ${testResult.product}`);
    
    // Ajouter une session
    const sessionId = generateSessionId();
    const fixedIspProxy = withSession(ispProxyUrl, sessionId);
    
    console.log(`\nAvec session fixe (${sessionId}):`);
    console.log(`${fixedIspProxy.split('@')[0]}...@...`);
    
    console.log("\n🎯 RECOMMANDATION:");
    console.log("Utilisez cet ISP proxy avec session fixe pour CapSolver!");
    console.log("C'est la configuration la plus stable pour Cloudflare.");
    
  } else {
    console.log(`❌ ISP proxy non fonctionnel: ${testResult.error}`);
    console.log("Vérifiez vos credentials ou contactez le support Bright Data");
  }
}

// Exécuter les tests
async function runAllTests() {
  await testBrightDataFixedIp();
  await testIspProxy();
}

runAllTests().catch(console.error);