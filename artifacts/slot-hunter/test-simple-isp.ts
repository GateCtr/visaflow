import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";

/**
 * TEST SIMPLE: ISP Proxy pour CapSolver
 * Test direct sans modifications complexes
 */

async function testSimpleIspProxy() {
  console.log("=== TEST SIMPLE ISP PROXY ===\n");
  
  // 1. Configuration ISP proxy (d'après votre curl)
  const ispProxyUrl = "http://brd-customer-hl_f0e9b823-zone-isp_proxy1-country-cd:jfhcdxaa961m@brd.superproxy.io:33335";
  
  console.log("1. Configuration ISP proxy:");
  console.log(`   URL: ${ispProxyUrl.split('@')[0]}...@...`);
  
  // 2. Convertir au format CapSolver
  function toCapSolverFormat(proxyUrl: string): string {
    try {
      const url = new URL(proxyUrl);
      const host = url.hostname; // brd.superproxy.io
      const port = url.port || "33335";
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      
      return `${host}:${port}:${username}:${password}`;
    } catch (error) {
      console.error("Erreur conversion:", error);
      return proxyUrl;
    }
  }
  
  const capsolverFormat = toCapSolverFormat(ispProxyUrl);
  console.log(`\n2. Format pour CapSolver:`);
  console.log(`   ${capsolverFormat.split(':')[0]}...`);
  
  // 3. Vérifier CapSolver API key
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  
  if (!capsolverKey) {
    console.error("❌ ERREUR: CAPSOLVER_API_KEY non configurée dans .env!");
    console.log("Vérifiez que CAPSOLVER_API_KEY est dans votre fichier .env");
    return;
  }
  
  console.log(`\n3. CapSolver API key: ${capsolverKey.slice(0, 10)}...`);
  
  // 4. Lancer le navigateur AVEC ISP proxy
  console.log("\n4. Lancement navigateur avec ISP proxy...");
  
  // Nous devons créer une fonction launchBrowser avec proxy personnalisé
  // Pour l'instant, testons d'abord la connectivité
  
  console.log("\n5. Test de connectivité ISP proxy...");
  
  // Test simple avec fetch
  try {
    const testUrl = "https://httpbin.org/ip";
    const proxy = `http://${ispProxyUrl.split('://')[1]}`;
    
    console.log(`   Test URL: ${testUrl}`);
    console.log(`   Via proxy: ${proxy.split('@')[0]}...@...`);
    
    // Note: Cette partie nécessite un environnement Node.js avec support proxy
    // Pour l'instant, passons directement au test CapSolver
    
  } catch (error) {
    console.log("   Test connectivité:", error instanceof Error ? error.message : error);
  }
  
  // 5. Test DIRECT avec CapSolver
  console.log("\n6. Test DIRECT avec CapSolver...");
  
  // Lancer un navigateur normal d'abord
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata", // Utilise BRIGHTDATA_PROXY_URL (residential)
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\n   Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title = await page.title();
    console.log(`   Titre: "${title}"`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log("   ✅ Cloudflare non détecté");
      return;
    }
    
    console.log("   ❌ Cloudflare détecté");
    
    // 6. Essayer CapSolver avec ISP proxy
    console.log("\n7. Essai CapSolver avec ISP proxy...");
    console.log(`   API Key: ${capsolverKey.slice(0, 10)}...`);
    console.log(`   Proxy: ${capsolverFormat.split(':')[0]}...`);
    
    const startTime = Date.now();
    
    try {
      const success = await solveAndApplyCloudflareChallenge(
        page,
        capsolverKey,
        capsolverFormat
      );
      
      const elapsedTime = Date.now() - startTime;
      
      console.log(`\n   Résultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (${elapsedTime}ms)`);
      
      if (success) {
        console.log("   🎉 CAPSOLVER FONCTIONNE AVEC ISP PROXY!");
        console.log("   🚀 VOTRE SOLUTION EST PRÊTE!");
        
        // Vérifier
        const finalTitle = await page.title();
        console.log(`   Titre final: "${finalTitle}"`);
        
        if (!/un instant|just a moment|verifying/i.test(finalTitle)) {
          console.log("   ✅ Cloudflare résolu!");
          
          // Prendre screenshot
          await page.screenshot({ path: "isp-capsolver-success.png" });
          console.log("   Screenshot: isp-capsolver-success.png");
        }
      } else {
        console.log("\n   ❌ CapSolver a échoué avec ISP proxy");
        console.log("   Raisons possibles:");
        console.log("   1. ISP proxy non actif dans votre compte");
        console.log("   2. Credentials incorrects");
        console.log("   3. Cloudflare Managed Challenge trop strict");
        
        console.log("\n   VÉRIFIEZ VOTRE ISP PROXY:");
        console.log(`   curl -i --proxy brd.superproxy.io:33335 --proxy-user "brd-customer-hl_f0e9b823-zone-isp_proxy1-country-cd:jfhcdxaa961m" "https://geo.brdtest.com/welcome.txt"`);
      }
      
    } catch (capsolverError) {
      console.error("   Erreur CapSolver:", capsolverError instanceof Error ? capsolverError.message : capsolverError);
      
      console.log("\n   DÉPANNAGE:");
      console.log("   1. Vérifiez que CapSolver API key est valide");
      console.log("   2. Testez le proxy ISP avec curl (voir ci-dessus)");
      console.log("   3. Contactez le support Bright Data si proxy ne fonctionne pas");
    }
    
  } catch (error) {
    console.error("   Erreur navigation:", error);
  } finally {
    await browser.close();
    console.log("\n   Test terminé.");
  }
  
  // 7. Recommandations
  console.log("\n8. RECOMMANDATIONS:");
  
  console.log("\n   Si CapSolver fonctionne:");
  console.log("   ✅ Utilisez cette configuration ISP proxy");
  console.log("   ✅ Mettez à jour .env avec l'URL ISP");
  console.log("   ✅ Implémentez la rotation des sessions");
  
  console.log("\n   Si CapSolver échoue:");
  console.log("   🔄 Testez d'abord avec curl (voir ci-dessus)");
  console.log("   📞 Contactez le support Bright Data");
  console.log("   💡 Utilisez le fallback cookies manuels");
  
  console.log("\n   Fallback disponible:");
  console.log("   npm run cloudflare:capture  // Cookies manuels");
  console.log("   npm run cloudflare:solution // Solution complète");
}

// Exécuter
testSimpleIspProxy().catch(console.error);