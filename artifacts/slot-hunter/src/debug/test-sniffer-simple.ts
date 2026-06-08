/**
 * Test simple du sniffer CEV
 * Pour vérifier que les listeners réseau fonctionnent
 */

import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

async function testSniffer() {
  console.log('🔬 Test du sniffer CEV...');
  
  let browser: Browser | null = null;
  try {
    // 1. Lancer le navigateur
    browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized'],
    });
    
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    
    const page = await context.newPage();
    
    // 2. Ajouter des listeners de debug
    let requestCount = 0;
    let responseCount = 0;
    
    page.on('request', (request) => {
      requestCount++;
      console.log(`📤 REQUEST #${requestCount}: ${request.method()} ${request.url()}`);
    });
    
    page.on('response', (response) => {
      responseCount++;
      console.log(`📥 RESPONSE #${responseCount}: ${response.status()} ${response.url()}`);
    });
    
    // 3. Naviguer vers un site de test simple
    console.log('🌐 Navigation vers example.com (test rapide)...');
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // 4. Attendre un peu pour voir les requêtes
    console.log('⏳ Attente de 5 secondes pour observer les requêtes...');
    await page.waitForTimeout(5000);
    
    // 5. Résultats
    console.log(`\n📊 RÉSULTATS DU TEST:`);
    console.log(`   Total requêtes : ${requestCount}`);
    console.log(`   Total réponses : ${responseCount}`);
    
    if (requestCount === 0 || responseCount === 0) {
      console.log('\n❌ ÉCHEC : Aucune requête interceptée !');
      console.log('   Problèmes possibles :');
      console.log('   - Playwright installé correctement ?');
      console.log('   - Navigateur accessible ?');
      console.log('   - Firewall bloque les connexions ?');
    } else {
      console.log('\n✅ SUCCÈS : Les listeners réseau fonctionnent !');
      console.log('   Le problème est ailleurs dans le sniffer CEV.');
    }
    
  } catch (error) {
    console.error('❌ ERREUR pendant le test:', error);
  } finally {
    if (browser) {
      await browser.close();
    }
    console.log('\n🔚 Test terminé.');
  }
}

// Exécuter le test
testSniffer().catch(console.error);