import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";

// Fonction pour tester différents formats de proxy
function testProxyFormats(originalUrl: string): string[] {
  const formats: string[] = [];
  
  try {
    const url = new URL(originalUrl);
    const host = url.hostname;
    const port = url.port || "12321"; // Port par défaut pour iProyal
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    
    // Format 1: host:port:user:pass (standard CapSolver)
    formats.push(`${host}:${port}:${username}:${password}`);
    
    // Format 2: http://user:pass@host:port (format URL complet)
    formats.push(originalUrl);
    
    // Format 3: user:pass@host:port (sans protocol)
    formats.push(`${username}:${password}@${host}:${port}`);
    
    // Format 4: host:port (sans auth - pour tester si auth est le problème)
    formats.push(`${host}:${port}`);
    
    // Format 5: Avec session ID sticky
    const sessionId = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "");
    const stickyUser = `${username}_session-${sessionId}`;
    formats.push(`${host}:${port}:${stickyUser}:${password}`);
    
  } catch (error) {
    console.error("Erreur parsing proxy URL:", error);
  }
  
  return formats;
}

async function testAllProxyFormats() {
  console.log("Test de tous les formats de proxy pour CapSolver...\n");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const iproyalProxy = process.env.IPROYAL_PROXY_URL;
  const brightdataProxy = process.env.BRIGHTDATA_PROXY_URL;
  
  if (!capsolverKey) {
    console.error("ERREUR: CAPSOLVER_API_KEY non configurée!");
    return;
  }
  
  console.log(`CapSolver API: ${capsolverKey.slice(0, 10)}...\n`);
  
  // Tester iProyal
  if (iproyalProxy) {
    console.log("=== TEST IPROYAL ===");
    const iproyalFormats = testProxyFormats(iproyalProxy);
    
    console.log(`Proxy original: ${iproyalProxy.split('@')[0]}...@...`);
    console.log(`Formats générés: ${iproyalFormats.length}\n`);
    
    for (let i = 0; i < iproyalFormats.length; i++) {
      console.log(`\nFormat ${i + 1}: ${iproyalFormats[i]}`);
      
      // Lancer navigateur avec iProyal
      const { browser, page } = await launchBrowser({
        headless: false,
        proxySource: "iproyal",
      });
      
      try {
        const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
        console.log(`Navigation vers: ${portalUrl}`);
        
        await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        
        const title = await page.title();
        const isCloudflare = /un instant|just a moment|verifying/i.test(title);
        
        if (!isCloudflare) {
          console.log("✅ Cloudflare non détecté - déjà authentifié?");
          await browser.close();
          continue;
        }
        
        console.log("❌ Cloudflare détecté - test CapSolver...");
        
        const startTime = Date.now();
        const success = await solveAndApplyCloudflareChallenge(page, capsolverKey, iproyalFormats[i]);
        const elapsedTime = Date.now() - startTime;
        
        console.log(`Résultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (temps: ${elapsedTime}ms)`);
        
        if (success) {
          console.log(`\n🎉 FORMAT ${i + 1} FONCTIONNE!`);
          console.log(`Format: ${iproyalFormats[i]}`);
          
          // Vérifier
          const finalTitle = await page.title();
          console.log(`Titre final: "${finalTitle}"`);
          
          // Sauvegarder le format qui fonctionne
          const fs = await import('fs');
          fs.writeFileSync('working-proxy-format.txt', iproyalFormats[i]);
          console.log(`Format sauvegardé dans working-proxy-format.txt`);
          
          await browser.close();
          return;
        }
        
      } catch (error) {
        console.error(`Erreur format ${i + 1}:`, error instanceof Error ? error.message : error);
      } finally {
        await browser.close();
      }
    }
  }
  
  // Tester Bright Data
  if (brightdataProxy) {
    console.log("\n\n=== TEST BRIGHT DATA ===");
    const brightdataFormats = testProxyFormats(brightdataProxy);
    
    console.log(`Proxy original: ${brightdataProxy.split('@')[0]}...@...`);
    console.log(`Formats générés: ${brightdataFormats.length}\n`);
    
    for (let i = 0; i < brightdataFormats.length; i++) {
      console.log(`\nFormat ${i + 1}: ${brightdataFormats[i]}`);
      
      // Lancer navigateur avec Bright Data
      const { browser, page } = await launchBrowser({
        headless: false,
        proxySource: "brightdata",
      });
      
      try {
        const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
        console.log(`Navigation vers: ${portalUrl}`);
        
        await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        
        const title = await page.title();
        const isCloudflare = /un instant|just a moment|verifying/i.test(title);
        
        if (!isCloudflare) {
          console.log("✅ Cloudflare non détecté - déjà authentifié?");
          await browser.close();
          continue;
        }
        
        console.log("❌ Cloudflare détecté - test CapSolver...");
        
        const startTime = Date.now();
        const success = await solveAndApplyCloudflareChallenge(page, capsolverKey, brightdataFormats[i]);
        const elapsedTime = Date.now() - startTime;
        
        console.log(`Résultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (temps: ${elapsedTime}ms)`);
        
        if (success) {
          console.log(`\n🎉 FORMAT ${i + 1} FONCTIONNE!`);
          console.log(`Format: ${brightdataFormats[i]}`);
          
          // Vérifier
          const finalTitle = await page.title();
          console.log(`Titre final: "${finalTitle}"`);
          
          // Sauvegarder le format qui fonctionne
          const fs = await import('fs');
          fs.writeFileSync('working-proxy-format.txt', brightdataFormats[i]);
          console.log(`Format sauvegardé dans working-proxy-format.txt`);
          
          await browser.close();
          return;
        }
        
      } catch (error) {
        console.error(`Erreur format ${i + 1}:`, error instanceof Error ? error.message : error);
      } finally {
        await browser.close();
      }
    }
  }
  
  console.log("\n\n=== CONCLUSION ===");
  console.log("Aucun format de proxy n'a fonctionné avec CapSolver AntiCloudflareTask.");
  console.log("\nProblèmes possibles:");
  console.log("1. Les proxies ont des IPs dynamiques (DNS dynamique pour Bright Data)");
  console.log("2. Cloudflare Managed Challenge est trop strict");
  console.log("3. CapSolver AntiCloudflareTask nécessite un proxy avec IP fixe");
  console.log("\nSolutions à explorer:");
  console.log("1. Trouver un proxy résidentiel avec IP fixe");
  console.log("2. Utiliser une autre méthode pour Cloudflare Managed Challenge");
  console.log("3. Contacter le support CapSolver pour configuration spécifique");
}

testAllProxyFormats().catch(console.error);