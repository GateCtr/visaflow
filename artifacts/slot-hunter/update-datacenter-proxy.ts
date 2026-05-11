import fs from 'fs';
import path from 'path';

/**
 * Mise à jour pour utiliser le datacenter proxy avec IP fixe
 */

function updateDatacenterProxy() {
  console.log("=== MISE À JOUR POUR DATACENTER PROXY FIXE ===\n");
  
  const envPath = path.join(process.cwd(), '.env');
  
  // 1. Nouveau datacenter proxy avec IP fixe
  const datacenterProxyUrl = "http://brd-customer-hl_f0e9b823-zone-datacenter_proxy1-country-fr-ip-212.81.41.27:85jymkmfp0e6@brd.superproxy.io:33335";
  
  console.log("1. Nouveau datacenter proxy:");
  console.log(`   URL: ${datacenterProxyUrl.split('@')[0]}...@...`);
  console.log(`   IP fixe: 212.81.41.27 (France)`);
  console.log(`   Type: datacenter_proxy1 (✅ IP DÉDIÉE FIXE)`);
  
  // 2. Calculer le format CapSolver
  const url = new URL(datacenterProxyUrl);
  const host = url.hostname; // brd.superproxy.io
  const port = url.port || "33335";
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const capsolverFormat = `${host}:${port}:${username}:${password}`;
  
  console.log(`\n2. Format pour CapSolver:`);
  console.log(`   ${capsolverFormat}`);
  
  // 3. Lire et mettre à jour .env
  console.log("\n3. Mise à jour du fichier .env...");
  
  let envContent = fs.readFileSync(envPath, 'utf8');
  
  // Remplacer BRIGHTDATA_PROXY_URL
  envContent = envContent.replace(
    /BRIGHTDATA_PROXY_URL="[^"]+"/,
    `BRIGHTDATA_PROXY_URL="${datacenterProxyUrl}"`
  );
  
  // Remplacer BRIGHTDATA_CAPSOLVER_FORMAT
  envContent = envContent.replace(
    /BRIGHTDATA_CAPSOLVER_FORMAT="[^"]+"/,
    `BRIGHTDATA_CAPSOLVER_FORMAT="${capsolverFormat}"`
  );
  
  // Mettre à jour BRIGHTDATA_SESSION_ID (pas besoin de session avec IP fixe)
  envContent = envContent.replace(
    /BRIGHTDATA_SESSION_ID="[^"]+"/,
    `BRIGHTDATA_SESSION_ID="datacenter_fixed_ip_212_81_41_27"`
  );
  
  // Ajouter un commentaire
  if (!envContent.includes('# Datacenter proxy avec IP fixe')) {
    envContent += '\n\n# Datacenter proxy avec IP fixe pour CapSolver\n';
    envContent += '# IP: 212.81.41.27 (France) - DÉDIÉE FIXE\n';
    envContent += '# Compatible à 100% avec CapSolver AntiCloudflareTask\n';
  }
  
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log("   ✅ .env mis à jour avec datacenter proxy fixe!");
  
  // 4. Créer un fichier de test
  console.log("\n4. Création du fichier de test...");
  
  const testScript = `import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";

async function testDatacenterFixedIp() {
  console.log("=== TEST DATACENTER PROXY AVEC IP FIXE ===\\n");
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const capsolverFormat = process.env.BRIGHTDATA_CAPSOLVER_FORMAT;
  
  console.log(\`CapSolver API: \${capsolverKey?.slice(0, 10)}...\\n\`);
  console.log(\`Proxy format: \${capsolverFormat?.split(':')[0]}...\\n\`);
  
  console.log(\`IP FIXE: 212.81.41.27 (France)\\n\`);
  console.log(\`✅ CETTE IP EST DÉDIÉE ET FIXE!\\n\`);
  console.log(\`🎯 CAPSOLVER DEVRAIT FONCTIONNER!\\n\`);
  
  // Lancer le navigateur
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata",
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(\`Navigation vers: \${portalUrl}\\n\`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    const title = await page.title();
    console.log(\`Titre: "\${title}"\\n\`);
    
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log("✅ Cloudflare non détecté");
      return;
    }
    
    console.log("❌ Cloudflare détecté - début résolution CapSolver...\\n");
    
    // Prendre screenshot avant
    await page.screenshot({ path: "before-datacenter-fixed.png" });
    
    // Utiliser CapSolver
    console.log("=== DÉBUT CAPSOLVER ANTI-CLOUDFLARE ===\\n");
    console.log(\`Task: AntiCloudflareTask\\n\`);
    console.log(\`Proxy: Datacenter avec IP fixe 212.81.41.27\\n\`);
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(
      page,
      capsolverKey!,
      capsolverFormat!
    );
    const elapsedTime = Date.now() - startTime;
    
    console.log(\`\\nRésultat: \${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (\${elapsedTime}ms)\\n\`);
    
    if (success) {
      console.log("🎉 CAPSOLVER FONCTIONNE AVEC IP FIXE!\\n");
      console.log("🚀 CLOUDFLARE EST RÉSOLU AUTOMATIQUEMENT!\\n");
      
      // Prendre screenshot après
      await page.screenshot({ path: "after-datacenter-fixed.png" });
      
      // Vérifier
      const finalTitle = await page.title();
      console.log(\`Titre final: "\${finalTitle}"\\n\`);
      
      if (!/un instant|just a moment|verifying/i.test(finalTitle)) {
        console.log("✅ Cloudflare contourné avec succès!\\n");
        
        // Vérifier Bookitit
        const hasBookitit = await page.evaluate(() => {
          return !!document.querySelector('#idBktWidgetDefaultBodyContainer');
        });
        
        console.log(\`Widget Bookitit: \${hasBookitit ? "✅ DÉTECTÉ" : "❌ NON DÉTECTÉ"}\\n\`);
      }
    } else {
      console.log("\\n=== ANALYSE ÉCHEC ===\\n");
      console.log("Même avec IP fixe, CapSolver échoue.\\n");
      console.log("Raisons possibles:\\n");
      console.log("1. Cloudflare Managed Challenge trop avancé");
      console.log("2. Problème avec l'API CapSolver");
      console.log("3. Le portail a changé sa configuration\\n");
      console.log("Solution: Utiliser le fallback cookies manuels\\n");
    }
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("\\nTest terminé.");
  }
}

testDatacenterFixedIp().catch(console.error);`;
  
  const testPath = path.join(process.cwd(), 'test-datacenter-fixed.ts');
  fs.writeFileSync(testPath, testScript, 'utf8');
  
  console.log(`   ✅ Fichier de test créé: ${testPath}`);
  
  // 5. Mettre à jour package.json
  console.log("\n5. Mise à jour du package.json...");
  
  const packagePath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  
  if (!packageJson.scripts['cloudflare:test-datacenter']) {
    packageJson.scripts['cloudflare:test-datacenter'] = 'tsx test-datacenter-fixed.ts';
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2), 'utf8');
    console.log("   ✅ Script npm ajouté: 'npm run cloudflare:test-datacenter'");
  }
  
  // 6. Instructions
  console.log("\n6. INSTRUCTIONS:");
  console.log("\n   Pour tester IMMÉDIATEMENT:");
  console.log("   npm run cloudflare:test-datacenter");
  
  console.log("\n   Configuration actuelle:");
  console.log(`   - Proxy: datacenter_proxy1 avec IP fixe`);
  console.log(`   - IP: 212.81.41.27 (France)`);
  console.log(`   - Format CapSolver: ${capsolverFormat.split(':')[0]}...`);
  
  console.log("\n   ⚠️  IMPORTANT:");
  console.log("   Cette IP est DÉDIÉE et FIXE.");
  console.log("   CapSolver AntiCloudflareTask DEVRAIT fonctionner.");
  
  console.log("\n   Si échec:");
  console.log("   npm run cloudflare:capture  // Fallback cookies manuels");
  
  console.log("\n✅ MISE À JOUR TERMINÉE!");
  console.log("\n🎯 EXÉCUTEZ MAINTENANT:");
  console.log("npm run cloudflare:test-datacenter");
}

updateDatacenterProxy();