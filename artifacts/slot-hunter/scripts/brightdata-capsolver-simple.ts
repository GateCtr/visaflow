/**
 * Script simplifié pour obtenir cf_clearance avec BrightData IP fixe + Capsolver
 */

import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "../src/browser.js";
import { solveAndApplyCloudflareChallenge } from "../src/capsolver.js";

async function getCfClearanceWithBrightData() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔐 OBTENTION CF_CLEARANCE AVEC BRIGHTDATA IP FIXE + CAPSOLVER');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Vérifier les configurations
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const brightdataProxy = process.env.BRIGHTDATA_PROXY_URL;
  const capsolverFormat = process.env.BRIGHTDATA_CAPSOLVER_FORMAT;
  
  console.log('🔍 Vérification des configurations:');
  console.log(`   Capsolver API Key: ${capsolverKey ? '✅' : '❌'}`);
  console.log(`   BrightData Proxy: ${brightdataProxy ? '✅' : '❌'}`);
  console.log(`   Capsolver Format: ${capsolverFormat ? '✅' : '❌'}`);
  
  if (!capsolverKey || !brightdataProxy || !capsolverFormat) {
    console.error('❌ Configuration manquante. Vérifiez le fichier .env');
    return null;
  }
  
  console.log(`\n🌐 Proxy BrightData (IP fixe):`);
  console.log(`   ${brightdataProxy.split('@')[0]}...@...`);
  console.log(`   Format Capsolver: ${capsolverFormat.substring(0, 50)}...`);
  
  // Lancer le navigateur avec BrightData proxy
  console.log('\n🚀 Lancement du navigateur avec proxy BrightData...');
  
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata", // Utilise BRIGHTDATA_PROXY_URL
  });
  
  let cfClearanceCookie: string | null = null;
  
  try {
    // Accéder au portail Espagne
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\n🌍 Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // Vérifier le titre
    const title = await page.title();
    console.log(`📄 Titre: "${title}"`);
    
    // Vérifier si Cloudflare est présent
    const isCloudflare = /un instant|just a moment|verifying|comprobando/i.test(title);
    
    if (!isCloudflare) {
      console.log('✅ Cloudflare non détecté - peut-être déjà authentifié');
      
      // Vérifier les cookies
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');
      
      if (cfClearance) {
        cfClearanceCookie = cfClearance.value;
        console.log(`🍪 Cookie cf_clearance trouvé: ${cfClearanceCookie.substring(0, 50)}...`);
        return cfClearanceCookie;
      } else {
        console.log('❌ Cookie cf_clearance non trouvé');
      }
    }
    
    console.log('🛡️ Cloudflare détecté - début résolution avec Capsolver...');
    
    // Prendre capture avant
    await page.screenshot({ path: "before-capsolver-brightdata.png" });
    console.log('📸 Capture avant: before-capsolver-brightdata.png');
    
    // Résoudre Cloudflare avec Capsolver
    console.log('\n🧩 Résolution Cloudflare avec Capsolver...');
    console.log(`   Task: AntiCloudflareTask`);
    console.log(`   Proxy: BrightData IP fixe (France)`);
    console.log(`   Format: ${capsolverFormat.substring(0, 30)}...`);
    
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(
      page,
      capsolverKey,
      capsolverFormat
    );
    const elapsedTime = Date.now() - startTime;
    
    console.log(`\n📊 Résultat: ${success ? '✅ SUCCÈS' : '❌ ÉCHEC'} (${elapsedTime}ms)`);
    
    if (!success) {
      console.log('❌ Capsolver a échoué');
      await browser.close();
      return null;
    }
    
    console.log('🎉 Cloudflare résolu avec succès!');
    
    // Attendre le chargement
    console.log('⏳ Attente de 5 secondes pour le chargement...');
    await new Promise(r => setTimeout(r, 5000));
    
    // Vérifier le résultat
    const finalTitle = await page.title();
    console.log(`📄 Titre final: "${finalTitle}"`);
    
    const stillCloudflare = /un instant|just a moment|verifying|comprobando/i.test(finalTitle);
    
    if (stillCloudflare) {
      console.log('❌ Cloudflare toujours présent après résolution');
      await browser.close();
      return null;
    }
    
    console.log('✅ Accès au portail obtenu!');
    
    // Récupérer les cookies
    const cookies = await page.context().cookies();
    const cfClearance = cookies.find(c => c.name === 'cf_clearance');
    
    if (!cfClearance) {
      console.log('❌ Cookie cf_clearance non trouvé');
      await browser.close();
      return null;
    }
    
    cfClearanceCookie = cfClearance.value;
    console.log(`🍪 Cookie cf_clearance obtenu: ${cfClearanceCookie.substring(0, 50)}...`);
    console.log(`📏 Longueur: ${cfClearanceCookie.length} caractères`);
    
    // Prendre capture après
    await page.screenshot({ path: "after-capsolver-brightdata.png" });
    console.log('📸 Capture après: after-capsolver-brightdata.png');
    
    // Instructions pour l'utilisateur
    console.log('\n👤 Étapes manuelles à compléter:');
    console.log('   1. Cliquer sur l\'alerte "Welcome / Bienvenido" (OK)');
    console.log('   2. Cliquer sur "continuer/continuar"');
    console.log('   3. Attendre la redirection #services');
    console.log('   4. Voir "No hay horas disponibles"');
    console.log('   5. Fermer le navigateur quand terminé');
    
    console.log('\n⏳ En attente de la navigation manuelle...');
    
    // Attendre que l'utilisateur ferme le navigateur
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(async () => {
        if (browser && !browser.isConnected()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
    
    console.log('✅ Navigation manuelle terminée');
    
  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close();
      console.log('🔒 Navigateur fermé');
    }
  }
  
  return cfClearanceCookie;
}

async function testBookititApi(cookie: string) {
  console.log('\n🧪 Test de l\'API Bookitit avec le cookie...');
  
  try {
    const { BookititApiClient } = await import('../src/spain/bookitit-client.js');
    
    const client = new BookititApiClient({
      publickey: '25028fcd7126544630b8da0c6e60722b5',
      widgetId: '25028fcd7126544630b8da0c6e60722b5',
      lang: 'es',
      cfClearance: cookie
    });
    
    const services = await client.getServices();
    console.log(`✅ API Bookitit fonctionne! Services: ${services.length}`);
    
    if (services.length > 0) {
      services.forEach((service, index) => {
        const name = service.name ? service.name.replace(/<[^>]*>/g, '').trim() : 'Hidden service';
        console.log(`   ${index + 1}. ${service.id}: ${name}`);
      });
      
      // Tester la configuration
      const config = await client.getWidgetConfiguration();
      if (config) {
        console.log(`⚙️  Widget config: registration_type=${config.registration_type}`);
      }
      
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error(`❌ Erreur API: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🎯 BRIGHTDATA + CAPSOLVER POUR BOOKITIT ESPAÑA');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    const cookie = await getCfClearanceWithBrightData();
    
    if (cookie) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('🎉 COOKIE OBTENU AVEC SUCCÈS!');
      console.log('═══════════════════════════════════════════════════════════════\n');
      
      console.log('🍪 Cookie cf_clearance:');
      console.log(cookie);
      
      // Tester l'API
      console.log('\n🔍 Test de l\'API Bookitit...');
      const apiWorks = await testBookititApi(cookie);
      
      if (apiWorks) {
        console.log('\n✅ TOUT FONCTIONNE!');
        console.log('   - Cookie cf_clearance valide');
        console.log('   - API Bookitit accessible');
        console.log('   - Prêt pour l\'automatisation');
      } else {
        console.log('\n⚠️  Cookie obtenu mais API non accessible');
        console.log('   Le cookie fonctionne dans le navigateur mais pas en API directe');
        console.log('   Cela peut être normal - testez avec le navigateur manuel');
      }
      
      // Sauvegarder le cookie
      const fs = await import('fs');
      const cookieData = {
        cookie: cookie,
        timestamp: new Date().toISOString(),
        source: 'brightdata_capsolver',
        proxy: 'datacenter_proxy1 (IP fixe 212.81.41.27)',
        url: 'https://www.citaconsular.es'
      };
      
      fs.writeFileSync(
        'cf_clearance_brightdata.json',
        JSON.stringify(cookieData, null, 2)
      );
      
      console.log('\n💾 Cookie sauvegardé: cf_clearance_brightdata.json');
      console.log('\n💡 Durée de vie estimée: 20 minutes à 2 heures');
      console.log('   Renouvelez avec ce script quand expiré');
      
    } else {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('❌ ÉCHEC - COOKIE NON OBTENU');
      console.log('═══════════════════════════════════════════════════════════════\n');
      
      console.log('🔧 Problèmes possibles:');
      console.log('   1. Capsolver n\'a pas de crédits');
      console.log('   2. Proxy BrightData non fonctionnel');
      console.log('   3. Cloudflare a changé sa protection');
      console.log('   4. Format proxy incorrect pour Capsolver');
      
      console.log('\n🔄 Solutions à essayer:');
      console.log('   1. Vérifier les crédits Capsolver');
      console.log('   2. Tester le proxy BrightData avec curl');
      console.log('   3. Essayer avec un autre type de proxy');
      console.log('   4. Contacter le support Capsolver');
    }
    
  } catch (error) {
    console.error('❌ Erreur fatale:', error);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🏁 SCRIPT TERMINÉ');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

// Exécuter
main().catch(console.error);