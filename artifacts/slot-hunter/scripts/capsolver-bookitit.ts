/**
 * Script pour obtenir un cookie cf_clearance valide avec Capsolver
 * et tester l'API Bookitit
 */

import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "../src/browser.js";
import { extractTurnstileSitekey, detectAndSolveTurnstile } from "../src/captcha.js";
import { BookititApiClient } from "../src/spain/bookitit-client.js";

async function getCfClearanceWithCapsolver() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔐 OBTENTION COOKIE CF_CLEARANCE AVEC CAPSOLVER');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Vérifier la clé API Capsolver
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const proxyUrl = process.env.IPROYAL_PROXY_URL || process.env.BRIGHTDATA_PROXY_URL;
  
  console.log(`🔑 Capsolver API Key: ${capsolverKey ? 'CONFIGURÉE' : 'NON CONFIGURÉE'}`);
  console.log(`🌐 Proxy: ${proxyUrl ? 'DISPONIBLE' : 'NON DISPONIBLE'}`);
  
  if (!capsolverKey) {
    console.error('❌ ERREUR: CAPSOLVER_API_KEY non configurée dans .env');
    return null;
  }
  
  if (!proxyUrl) {
    console.warn('de AVERTISSEMENT: Aucun proxy configuré, Capsolver peut échouer');
  }
  
  // Lancer le navigateur avec proxy
  console.log('\n🚀 Lancement du navigateur...');
  const { browser, page } = await launchBrowser({
    headless: false, // Garder visible pour le debug
    proxySource: "iproyal", // ou "brightdata"
  });
  
  let cfClearanceCookie: string | null = null;
  
  try {
    // Accéder au portail Espagne
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`🌍 Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // Vérifier si Cloudflare est présent
    const title = await page.title();
    console.log(`📄 Titre initial: "${title}"`);
    
    // Attendre que Cloudflare charge
    console.log('⏳ Attente de 10 secondes pour Cloudflare...');
    await new Promise(r => setTimeout(r, 10000));
    
    // Extraire le sitekey
    console.log('🔍 Extraction du sitekey Turnstile...');
    const sitekeyResult = await extractTurnstileSitekey(page);
    
    if (!sitekeyResult) {
      console.log('❌ Aucun sitekey trouvé - Cloudflare peut être déjà passé');
      
      // Vérifier si on a déjà accès
      const currentTitle = await page.title();
      const hasAccess = !/un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i.test(currentTitle);
      
      if (hasAccess) {
        console.log('✅ Accès direct au portail (pas de Cloudflare)');
      } else {
        console.log('❌ Cloudflare présent mais sitekey non détecté');
        await browser.close();
        return null;
      }
    } else {
      console.log(`✅ Sitekey trouvé: ${sitekeyResult.sitekey}`);
      console.log(`   Type: ${sitekeyResult.isCfChallenge ? "Cloudflare Managed Challenge" : "Turnstile standard"}`);
      
      // Résoudre avec Capsolver
      console.log('\n🧩 Résolution du challenge avec Capsolver...');
      
      const result = await detectAndSolveTurnstile(
        page,
        process.env.TWOCAPTCHA_API_KEY, // twoCaptchaApiKey
        capsolverKey, // capsolverApiKey
        proxyUrl, // proxyUrl
        process.env.ANTICAPTCHA_API_KEY, // anticaptchaApiKey
      );
      
      console.log(`📊 Résultat Capsolver: ${result}`);
      
      if (result !== "solved") {
        console.log('❌ Échec de la résolution Capsolver');
        await browser.close();
        return null;
      }
      
      console.log('✅ SUCCÈS - Cloudflare résolu!');
      
      // Attendre que la page se charge complètement
      console.log('⏳ Attente de 5 secondes pour le chargement...');
      await new Promise(r => setTimeout(r, 5000));
    }
    
    // Vérifier l'accès au portail
    const finalTitle = await page.title();
    console.log(`📄 Titre final: "${finalTitle}"`);
    
    const hasAccess = !/un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i.test(finalTitle);
    
    if (!hasAccess) {
      console.log('❌ Cloudflare toujours présent après résolution');
      await browser.close();
      return null;
    }
    
    console.log('✅ ACCÈS AU PORTAL OBTENU!');
    
    // Récupérer les cookies
    const cookies = await page.context().cookies();
    const cfClearance = cookies.find(c => c.name === "cf_clearance");
    
    if (!cfClearance) {
      console.log('❌ Cookie cf_clearance non trouvé');
      await browser.close();
      return null;
    }
    
    cfClearanceCookie = cfClearance.value;
    console.log(`🍪 Cookie cf_clearance obtenu: ${cfClearanceCookie.substring(0, 50)}...`);
    console.log(`📏 Longueur: ${cfClearanceCookie.length} caractères`);
    
    // Prendre une capture d'écran
    await page.screenshot({ path: "capsolver-success.png", fullPage: true });
    console.log('📸 Capture d\'écran sauvegardée: capsolver-success.png');
    
    // Tester l'API Bookitit avec le cookie
    console.log('\n🧪 Test de l\'API Bookitit avec le nouveau cookie...');
    
    const client = new BookititApiClient({
      publickey: '25028fcd7126544630b8da0c6e60722b5',
      widgetId: '25028fcd7126544630b8da0c6e60722b5',
      lang: 'es',
      cfClearance: cfClearanceCookie
    });
    
    try {
      const services = await client.getServices();
      console.log(`✅ API Bookitit fonctionne! Services trouvés: ${services.length}`);
      
      if (services.length > 0) {
        services.forEach((service, index) => {
          const name = service.name ? service.name.replace(/<[^>]*>/g, '').trim() : 'Hidden service';
          console.log(`   ${index + 1}. ${service.id}: ${name}`);
        });
        
        // Tester aussi la configuration du widget
        const config = await client.getWidgetConfiguration();
        if (config) {
          console.log(`⚙️  Configuration du widget: registration_type=${config.registration_type}`);
        }
      }
      
    } catch (apiError) {
      const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
      console.error(`❌ Erreur API Bookitit: ${errorMessage}`);
      console.log('⚠️  Le cookie peut être valide pour le navigateur mais pas pour les requêtes API directes');
    }
    
    // Attendre que l'utilisateur complète le flow manuellement si nécessaire
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
    console.error('❌ Erreur pendant l\'exécution:', error);
  } finally {
    // Fermer le navigateur
    if (browser && browser.isConnected()) {
      await browser.close();
      console.log('🔒 Navigateur fermé');
    }
  }
  
  return cfClearanceCookie;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🎯 SCRIPT CAPSOLVER POUR BOOKITIT ESPAÑA');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    const cookie = await getCfClearanceWithCapsolver();
    
    if (cookie) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('🎉 SUCCÈS - COOKIE OBTENU!');
      console.log('═══════════════════════════════════════════════════════════════\n');
      
      console.log('🍪 Cookie cf_clearance:');
      console.log(cookie);
      
      console.log('\n💡 Utilisation:');
      console.log('   Copiez ce cookie dans le client BookititApiClient');
      console.log('   Durée de vie: ~20 minutes à 2 heures');
      console.log('   Renouvelez avec ce script quand expiré');
      
      // Sauvegarder le cookie dans un fichier
      const fs = await import('fs');
      const cookieData = {
        cookie: cookie,
        timestamp: new Date().toISOString(),
        source: 'capsolver',
        url: 'https://www.citaconsular.es'
      };
      
      fs.writeFileSync(
        'cf_clearance_capsolver.json',
        JSON.stringify(cookieData, null, 2)
      );
      
      console.log('\n💾 Cookie sauvegardé dans: cf_clearance_capsolver.json');
      
    } else {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('❌ ÉCHEC - COOKIE NON OBTENU');
      console.log('═══════════════════════════════════════════════════════════════\n');
      
      console.log('🔧 Vérifiez:');
      console.log('   1. La clé API Capsolver dans .env');
      console.log('   2. La connexion proxy (iProyal/BrightData)');
      console.log('   3. Que Capsolver a des crédits disponibles');
      console.log('   4. Que le site n\'a pas changé');
    }
    
  } catch (error) {
    console.error('❌ Erreur fatale:', error);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🏁 SCRIPT TERMINÉ');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

// Exécuter le script
main().catch(console.error);