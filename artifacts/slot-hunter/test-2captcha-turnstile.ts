/**
 * Test de résolution Turnstile avec 2captcha pour le portail Espagne
 */

import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { extractTurnstileSitekey, detectAndSolveTurnstile } from "./src/captcha.js";

async function test2CaptchaTurnstile() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 TEST 2CAPTCHA TURNSTILE POUR ESPAGNE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Vérifier la clé API 2captcha
  const twoCaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  
  console.log(`🔑 2Captcha API Key: ${twoCaptchaKey ? 'CONFIGURÉE' : 'NON CONFIGURÉE'}`);
  
  if (!twoCaptchaKey) {
    console.error('❌ ERREUR: TWOCAPTCHA_API_KEY non configurée dans .env');
    return;
  }

  // Lancer le navigateur
  console.log('\n🚀 Lancement du navigateur...');
  const { browser, page } = await launchBrowser({
    headless: false, // Garder visible pour le debug
    proxySource: "iproyal", // ou "brightdata"
  });

  try {
    // Accéder au portail Espagne
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`🌍 Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    
    // Vérifier si Cloudflare est présent
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      console.log('✅ Pas de Cloudflare détecté');
      return;
    }
    
    console.log(`🔒 Cloudflare détecté: "${title}"`);
    
    // Extraire le sitekey
    console.log('🔍 Extraction du sitekey Turnstile...');
    const sitekeyResult = await extractTurnstileSitekey(page);
    
    if (!sitekeyResult) {
      console.error('❌ Impossible d\'extraire le sitekey');
      return;
    }
    
    console.log(`🔑 Sitekey: ${sitekeyResult.sitekey}`);
    console.log(`📋 Type: ${sitekeyResult.isCfChallenge ? 'CF Managed Challenge' : 'Turnstile standard'}`);
    
    // Tester la résolution avec 2captcha
    console.log('\n🧩 Résolution du challenge avec 2captcha...');
    
    const result = await detectAndSolveTurnstile(
      page,
      twoCaptchaKey, // twoCaptchaApiKey
      undefined, // capsolverApiKey
      undefined, // proxyUrl
      undefined  // anticaptchaApiKey
    );
    
    console.log(`\n📊 Résultat: ${result}`);
    
    if (result === "solved") {
      console.log('✅ SUCCÈS: Cloudflare résolu avec 2captcha!');
      
      // Vérifier si on a passé Cloudflare
      const newTitle = await page.title();
      const stillCloudflare = /un instant|just a moment|verifying/i.test(newTitle);
      
      if (!stillCloudflare) {
        console.log('✅ Confirmé: Plus de page Cloudflare');
      } else {
        console.log('⚠️  Attention: Page Cloudflare toujours présente');
      }
    } else {
      console.log('❌ ÉCHEC: Impossible de résoudre Cloudflare');
    }
    
  } catch (error) {
    console.error('❌ Erreur pendant le test:', error);
  } finally {
    // Fermer le navigateur
    console.log('\n🔒 Fermeture du navigateur...');
    await browser.close();
  }
}

// Exécuter le test
test2CaptchaTurnstile().catch(console.error);