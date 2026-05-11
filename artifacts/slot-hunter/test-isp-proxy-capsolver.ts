import * as dotenv from "dotenv";
import fs from 'fs';
import path from 'path';
import {
  buildBrightDataUrl,
  generateSessionId,
  brightDataToCapSolverFormat,
  type BrightDataProxyConfig
} from "./src/brightdata-fixed-ip.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";
import { launchBrowser } from "./src/browser.js";

/**
 * TEST SPÉCIFIQUE: ISP PROXY POUR CAPSOLVER
 * 
 * Votre ISP proxy est plus stable que residential.
 * Format: brd-customer-hl_f0e9b823-zone-isp_proxy1-country-cd:jfhcdxaa961m
 */

async function testIspProxyWithCapSolver() {
  console.log("=== TEST ISP PROXY POUR CAPSOLVER ===\n");
  
  // 1. Configuration ISP proxy (d'après votre commande curl)
  const ispConfig: BrightDataProxyConfig = {
    accountId: "hl_f0e9b823",
    proxyType: "isp_proxy1",  // ISP au lieu de residential
    password: "jfhcdxaa961m", // Mot de passe ISP
    country: "cd",
    sessionId: generateSessionId(), // Session fixe
  };
  
  console.log("1. Configuration ISP proxy:");
  console.log(`   Account ID: ${ispConfig.accountId}`);
  console.log(`   Proxy type: ${ispConfig.proxyType} (✅ PLUS STABLE)`);
  console.log(`   Pays: ${ispConfig.country}`);
  console.log(`   Session ID: ${ispConfig.sessionId}`);
  
  // 2. Construire l'URL
  const ispProxyUrl = buildBrightDataUrl(ispConfig);
  console.log(`\n2. URL ISP proxy avec session fixe:`);
  console.log(`   ${ispProxyUrl.split('@')[0]}...@...`);
  
  // 3. Format CapSolver
  const capsolverFormat = brightDataToCapSolverFormat(ispProxyUrl);
  console.log(`\n3. Format pour CapSolver:`);
  console.log(`   ${capsolverFormat.split(':')[0]}...`);
  
  // 4. Mettre à jour .env temporairement
  console.log("\n4. Mise à jour temporaire du .env...");
  
  const envPath = path.join(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  
  // Sauvegarder l'original
  const originalBrightDataUrl = process.env.BRIGHTDATA_PROXY_URL;
  
  // Remplacer temporairement
  envContent = envContent.replace(
    /BRIGHTDATA_PROXY_URL="[^"]+"/,
    `BRIGHTDATA_PROXY_URL="${ispProxyUrl}"`
  );
  
  envContent = envContent.replace(
    /BRIGHTDATA_CAPSOLVER_FORMAT="[^"]+"/,
    `BRIGHTDATA_CAPSOLVER_FORMAT="${capsolverFormat}"`
  );
  
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log("   ✅ .env mis à jour temporairement");
  
  // Recharger les variables d'environnement
  // Pour ES modules, on recharge directement depuis le fichier
  const envData = fs.readFileSync(envPath, 'utf8');
  const lines = envData.split('\n');
  
  for (const line of lines) {
    const match = line.match(/^([^=]+)="([^"]*)"$/);
    if (match) {
      const key = match[1];
      const value = match[2];
      process.env[key] = value;
    }
  }
  
  // 5. Tester avec CapSolver
  console.log("\n5. Test avec CapSolver AntiCloudflareTask...");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  
  if (!capsolverKey) {
    console.error("   ❌ CAPSOLVER_API_KEY non configurée!");
    // Restaurer l'original
    restoreOriginalEnv(originalBrightDataUrl!);
    return;
  }
  
  console.log(`   CapSolver: ${capsolverKey.slice(0, 10)}...`);
  
  // 6. Lancer le navigateur
  console.log("\n6. Lancement navigateur avec ISP proxy...");
  
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata", // Utilisera le proxy ISP mis à jour
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
      
      // Restaurer l'original
      restoreOriginalEnv(originalBrightDataUrl!);
      return;
    }
    
    console.log("   ❌ Cloudflare détecté - début résolution avec CapSolver...");
    
    // Prendre une capture avant
    await page.screenshot({ path: "before-isp-capsolver.png" });
    console.log("   Capture avant: before-isp-capsolver.png");
    
    // Utiliser CapSolver avec ISP proxy
    console.log("\n   === DÉBUT RÉSOLUTION CAPSOLVER ===");
    console.log(`   Task type: AntiCloudflareTask`);
    console.log(`   Proxy: ISP avec session fixe`);
    console.log(`   Session ID: ${ispConfig.sessionId}`);
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(
      page, 
      capsolverKey, 
      capsolverFormat
    );
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\n   Résultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (temps: ${elapsedTime}ms)`);
    
    if (success) {
      console.log("   🎉 CAPSOLVER FONCTIONNE AVEC ISP PROXY!");
      console.log("   🚀 C'EST LA SOLUTION IDÉALE!");
      
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
            
            if (hasBookitit) {
              console.log("\n   🎯 RECOMMANDATION FINALE:");
              console.log("   Utilisez CETTE configuration ISP proxy pour la production!");
              console.log("   Elle est plus stable que residential.");
              
              // Sauvegarder la configuration réussie
              saveSuccessfulConfig(ispConfig, ispProxyUrl, capsolverFormat);
            }
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
      console.log("   1. ISP proxy non actif dans votre compte");
      console.log("   2. Credentials ISP incorrects");
      console.log("   3. Cloudflare Managed Challenge trop strict");
      
      console.log("\n   Vérifiez votre ISP proxy avec:");
      console.log(`   curl -i --proxy brd.superproxy.io:33335 --proxy-user "brd-customer-${ispConfig.accountId}-zone-${ispConfig.proxyType}-country-${ispConfig.country}:${ispConfig.password}" "https://geo.brdtest.com/welcome.txt"`);
    }
    
    // Prendre une capture après
    await page.screenshot({ path: "after-isp-capsolver.png" });
    console.log("\n   Capture après: after-isp-capsolver.png");
    
  } catch (error) {
    console.error("   Erreur pendant le test:", error);
  } finally {
    await browser.close();
    
    // Restaurer l'original
    restoreOriginalEnv(originalBrightDataUrl!);
    console.log("\n   ✅ Configuration .env restaurée");
    console.log("\n   Test terminé.");
  }
}

/**
 * Restaure la configuration .env originale
 */
function restoreOriginalEnv(originalUrl: string): void {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  
  // Restaurer BRIGHTDATA_PROXY_URL
  const currentMatch = envContent.match(/BRIGHTDATA_PROXY_URL="([^"]+)"/);
  if (currentMatch) {
    envContent = envContent.replace(
      currentMatch[0],
      `BRIGHTDATA_PROXY_URL="${originalUrl}"`
    );
  }
  
  // Recalculer le format CapSolver pour l'original
  const originalCapsolverFormat = brightDataToCapSolverFormat(originalUrl);
  
  // Restaurer BRIGHTDATA_CAPSOLVER_FORMAT
  const capsolverMatch = envContent.match(/BRIGHTDATA_CAPSOLVER_FORMAT="([^"]+)"/);
  if (capsolverMatch) {
    envContent = envContent.replace(
      capsolverMatch[0],
      `BRIGHTDATA_CAPSOLVER_FORMAT="${originalCapsolverFormat}"`
    );
  }
  
  fs.writeFileSync(envPath, envContent, 'utf8');
}

/**
 * Sauvegarde la configuration réussie
 */
function saveSuccessfulConfig(
  config: BrightDataProxyConfig,
  proxyUrl: string,
  capsolverFormat: string
): void {
  const successConfig = {
    ispProxy: {
      config,
      url: proxyUrl,
      capsolverFormat,
      testedAt: new Date().toISOString(),
      success: true,
    },
    instructions: [
      "Cette configuration ISP proxy fonctionne avec CapSolver!",
      "Utilisez-la pour la production.",
      "Renouvelez la session toutes les 30-60 minutes.",
    ],
    envExample: `BRIGHTDATA_PROXY_URL="${proxyUrl}"
BRIGHTDATA_CAPSOLVER_FORMAT="${capsolverFormat}"`,
  };
  
  const configPath = path.join(process.cwd(), 'isp-proxy-success.json');
  fs.writeFileSync(configPath, JSON.stringify(successConfig, null, 2), 'utf8');
  
  console.log(`\n   📁 Configuration réussie sauvegardée: ${configPath}`);
}

// Exécuter le test
testIspProxyWithCapSolver().catch(async (error) => {
  console.error("Erreur globale:", error);
  
  // Essayer de restaurer .env en cas d'erreur
  try {
    const envPath = path.join(process.cwd(), '.env');
    const envContent = fs.readFileSync(envPath, 'utf8');
    
    // Trouver l'URL originale (avant ISP)
    const originalMatch = envContent.match(/BRIGHTDATA_PROXY_URL="([^"]+-zone-residential_proxy1[^"]+)"/);
    if (originalMatch) {
      restoreOriginalEnv(originalMatch[1]);
    }
  } catch (e) {
    console.error("Erreur restauration .env:", e);
  }
});