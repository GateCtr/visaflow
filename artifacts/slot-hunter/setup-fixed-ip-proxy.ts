import * as dotenv from "dotenv";
import fs from 'fs';
import path from 'path';
import {
  parseBrightDataUrl,
  buildBrightDataUrl,
  generateSessionId,
  withSession,
  brightDataToCapSolverFormat,
  type BrightDataProxyConfig
} from "./src/brightdata-fixed-ip.js";

/**
 * SCRIPT DE CONFIGURATION: IP FIXE POUR CAPSOLVER
 * 
 * Ce script:
 * 1. Lit votre configuration .env actuelle
 * 2. Ajoute une session fixe au proxy Bright Data
 * 3. Met à jour le fichier .env
 * 4. Génère la configuration pour CapSolver
 */

async function setupFixedIpProxy() {
  console.log("=== CONFIGURATION IP FIXE POUR CAPSOLVER ===\n");
  
  const envPath = path.join(process.cwd(), '.env');
  
  // 1. Lire le fichier .env
  if (!fs.existsSync(envPath)) {
    console.error("❌ Fichier .env non trouvé!");
    return;
  }
  
  const envContent = fs.readFileSync(envPath, 'utf8');
  console.log("1. Lecture du fichier .env...");
  
  // 2. Extraire les URLs proxy
  const brightdataMatch = envContent.match(/BRIGHTDATA_PROXY_URL="([^"]+)"/);
  const iproyalMatch = envContent.match(/IPROYAL_PROXY_URL="([^"]+)"/);
  
  if (!brightdataMatch) {
    console.error("❌ BRIGHTDATA_PROXY_URL non trouvée dans .env");
    return;
  }
  
  const currentBrightDataUrl = brightdataMatch[1];
  console.log(`   Bright Data URL actuelle: ${currentBrightDataUrl.split('@')[0]}...@...`);
  
  if (iproyalMatch) {
    console.log(`   iProyal URL: ${iproyalMatch[1].split('@')[0]}...@...`);
  }
  
  // 3. Analyser la configuration Bright Data
  const config = parseBrightDataUrl(currentBrightDataUrl);
  
  if (!config) {
    console.error("❌ Format URL Bright Data invalide");
    return;
  }
  
  console.log("\n2. Analyse de la configuration:");
  console.log(`   Account ID: ${config.accountId}`);
  console.log(`   Proxy type: ${config.proxyType}`);
  console.log(`   Pays: ${config.country || 'non spécifié'}`);
  console.log(`   Ville: ${config.city || 'non spécifié'}`);
  
  // 4. Vérifier le type de proxy
  console.log("\n3. Vérification du type de proxy:");
  
  const isResidential = config.proxyType.includes('residential');
  const isIsp = config.proxyType.includes('isp');
  const isDatacenter = config.proxyType.includes('datacenter');
  
  console.log(`   Type détecté: ${config.proxyType}`);
  console.log(`   Residential: ${isResidential ? '✅' : '❌'}`);
  console.log(`   ISP: ${isIsp ? '✅' : '❌'}`);
  console.log(`   Datacenter: ${isDatacenter ? '✅' : '❌'}`);
  
  if (isResidential) {
    console.log("   ⚠️  Residential proxy: IPs dynamiques par défaut");
    console.log("   💡 Recommandation: Utiliser -session- pour IP collante");
  }
  
  if (isIsp) {
    console.log("   ✅ ISP proxy: Plus stable que residential");
    console.log("   💡 Bon choix pour Cloudflare!");
  }
  
  if (isDatacenter) {
    console.log("   ✅ Datacenter proxy: IP vraiment fixe");
    console.log("   💡 Meilleur choix pour CapSolver!");
  }
  
  // 5. Demander à l'utilisateur
  console.log("\n4. Options de configuration:");
  console.log("   [1] Ajouter une session fixe au proxy actuel");
  console.log("   [2] Utiliser ISP proxy (si disponible)");
  console.log("   [3] Configurer un nouveau proxy dédié");
  console.log("   [4] Quitter");
  
  // Pour l'automatisation, choisissons l'option 1
  const choice = '1'; // Option par défaut
  
  let newProxyUrl = currentBrightDataUrl;
  let sessionId = generateSessionId();
  
  if (choice === '1') {
    // Ajouter une session fixe
    console.log(`\n   Option 1: Ajout d'une session fixe`);
    console.log(`   Session ID: ${sessionId}`);
    
    newProxyUrl = withSession(currentBrightDataUrl, sessionId);
    console.log(`   Nouvelle URL: ${newProxyUrl.split('@')[0]}...@...`);
    
  } else if (choice === '2') {
    // Utiliser ISP proxy
    console.log("\n   Option 2: Utilisation d'ISP proxy");
    
    // Vérifier si vous avez un ISP proxy
    if (config.proxyType !== 'isp_proxy1') {
      console.log("   ⚠️  Vous n'avez pas de proxy ISP configuré");
      console.log("   Vérifiez votre compte Bright Data pour isp_proxy1");
      
      // Demander les credentials ISP
      console.log("\n   Entrez vos credentials ISP proxy:");
      console.log("   Format: brd-customer-{accountId}-zone-isp_proxy1-country-{country}:{password}");
      
      // Pour l'instant, utilisons la session fixe
      newProxyUrl = withSession(currentBrightDataUrl, sessionId);
    } else {
      newProxyUrl = withSession(currentBrightDataUrl, sessionId);
    }
    
  } else if (choice === '3') {
    console.log("\n   Option 3: Configuration manuelle requise");
    console.log("   Contactez le support Bright Data pour un proxy dédié");
    return;
  } else {
    console.log("\n   Opération annulée");
    return;
  }
  
  // 6. Convertir au format CapSolver
  console.log("\n5. Configuration pour CapSolver:");
  
  const capsolverFormat = brightDataToCapSolverFormat(newProxyUrl);
  console.log(`   Format CapSolver: ${capsolverFormat}`);
  
  // 7. Mettre à jour le fichier .env
  console.log("\n6. Mise à jour du fichier .env...");
  
  let newEnvContent = envContent;
  
  // Remplacer l'URL Bright Data
  newEnvContent = newEnvContent.replace(
    /BRIGHTDATA_PROXY_URL="[^"]+"/,
    `BRIGHTDATA_PROXY_URL="${newProxyUrl}"`
  );
  
  // Ajouter un commentaire avec la session
  if (!newEnvContent.includes('BRIGHTDATA_SESSION_ID')) {
    newEnvContent += `\n\n# Session fixe pour CapSolver (générée le ${new Date().toISOString()})\n`;
    newEnvContent += `BRIGHTDATA_SESSION_ID="${sessionId}"\n`;
    newEnvContent += `BRIGHTDATA_CAPSOLVER_FORMAT="${capsolverFormat}"\n`;
  } else {
    // Mettre à jour les valeurs existantes
    newEnvContent = newEnvContent.replace(
      /BRIGHTDATA_SESSION_ID="[^"]*"/,
      `BRIGHTDATA_SESSION_ID="${sessionId}"`
    );
    newEnvContent = newEnvContent.replace(
      /BRIGHTDATA_CAPSOLVER_FORMAT="[^"]*"/,
      `BRIGHTDATA_CAPSOLVER_FORMAT="${capsolverFormat}"`
    );
  }
  
  // Sauvegarder le fichier
  fs.writeFileSync(envPath, newEnvContent, 'utf8');
  console.log("   ✅ Fichier .env mis à jour!");
  
  // 8. Créer un fichier de configuration CapSolver
  console.log("\n7. Création du fichier de configuration CapSolver...");
  
  const capsolverConfig = {
    proxy: {
      url: newProxyUrl,
      capsolverFormat: capsolverFormat,
      sessionId: sessionId,
      type: config.proxyType,
      generatedAt: new Date().toISOString(),
    },
    capsolver: {
      apiKey: process.env.CAPSOLVER_API_KEY ? `${process.env.CAPSOLVER_API_KEY.slice(0, 10)}...` : 'NON_CONFIGURÉ',
      taskType: 'AntiCloudflareTask',
      websiteURL: 'https://www.citaconsular.es',
      notes: 'Configuration pour Cloudflare Managed Challenge',
    },
    instructions: [
      '1. Utiliser BRIGHTDATA_CAPSOLVER_FORMAT dans les appels CapSolver',
      '2. La session reste valide 10-30 minutes',
      '3. Régénérer une nouvelle session après expiration',
      '4. Pour une IP vraiment fixe, utiliser datacenter_proxy1',
    ]
  };
  
  const configPath = path.join(process.cwd(), 'capsolver-config.json');
  fs.writeFileSync(configPath, JSON.stringify(capsolverConfig, null, 2), 'utf8');
  
  console.log(`   ✅ Configuration sauvegardée dans: ${configPath}`);
  
  // 9. Instructions finales
  console.log("\n8. INSTRUCTIONS POUR UTILISATION:");
  console.log("\n   A. Dans vos scripts CapSolver:");
  console.log(`      const proxy = process.env.BRIGHTDATA_CAPSOLVER_FORMAT;`);
  console.log(`      // Ou: "${capsolverFormat}"`);
  
  console.log("\n   B. Dans le slot-hunter:");
  console.log(`      // Le proxy sera automatiquement utilisé`);
  console.log(`      // avec la session fixe`);
  
  console.log("\n   C. Pour renouveler la session:");
  console.log(`      npm run cloudflare:setup  // Re-exécuter ce script`);
  console.log(`      // Ou manuellement: changer le sessionId`);
  
  console.log("\n   D. Surveillance:");
  console.log(`      - Vérifiez la durée de vie de la session (10-30min)`);
  console.log(`      - Surveillez les erreurs "proxy changed"`);
  console.log(`      - Régénérez la session si nécessaire`);
  
  console.log("\n9. PROCHAINES ÉTAPES:");
  console.log("\n   a) Tester la configuration:");
  console.log(`      npm run cloudflare:test-brightdata`);
  
  console.log("\n   b) Si échec, essayer ISP proxy:");
  console.log(`      // Mettez à jour .env avec votre ISP proxy`);
  console.log(`      BRIGHTDATA_PROXY_URL="http://brd-customer-...-zone-isp_proxy1-...@brd.superproxy.io:33335"`);
  
  console.log("\n   c) Pour une IP vraiment fixe:");
  console.log(`      Contactez Bright Data pour datacenter_proxy1`);
  
  console.log("\n✅ CONFIGURATION TERMINÉE!");
  console.log(`\nSession ID: ${sessionId}`);
  console.log(`Expire dans: ~30 minutes`);
  console.log(`Renouvellement: Exécutez ce script à nouveau`);
}

// Ajouter un script npm dans package.json
function updatePackageJson() {
  const packagePath = path.join(process.cwd(), 'package.json');
  
  if (!fs.existsSync(packagePath)) {
    return;
  }
  
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  
  if (!packageJson.scripts) {
    packageJson.scripts = {};
  }
  
  // Ajouter le script si absent
  if (!packageJson.scripts['cloudflare:setup']) {
    packageJson.scripts['cloudflare:setup'] = 'tsx setup-fixed-ip-proxy.ts';
    
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2), 'utf8');
    console.log("\n📦 Script npm ajouté: 'npm run cloudflare:setup'");
  }
}

// Exécuter
async function main() {
  await setupFixedIpProxy();
  updatePackageJson();
  
  console.log("\n🎯 POUR TESTER:");
  console.log("npm run cloudflare:test-brightdata");
  console.log("\n🔄 POUR RENOUVELER LA SESSION:");
  console.log("npm run cloudflare:setup");
}

main().catch(console.error);