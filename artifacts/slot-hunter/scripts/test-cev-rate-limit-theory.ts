/**
 * test-cev-rate-limit-theory.ts — Test de la théorie de limitation CEV
 * 
 * Théorie : Le compteur de 5 clics/heure est basé sur :
 *   1. Session cookie (PHPSESSID ou ASP.NET_SessionId)
 *   2. Adresse IP publique
 * 
 * Si on change les deux (nouvelle session + nouvelle IP), on peut contourner la limite.
 * 
 * Ce script teste cette hypothèse en :
 *   1. Faisant 3 clics avec la même session/IP (devrait fonctionner)
 *   2. Changeant de session et d'IP
 *   3. Faisant 4 clics supplémentaires (devrait aussi fonctionner si la théorie est correcte)
 * 
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-cev-rate-limit-theory.ts
 */

import { setupCevSessionHttp, invalidateVowintCache } from '../src/cevHttpSetup.js';
import { botLog } from '../src/convexClient.js';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const VOWINT_EMAIL = process.env.VOWINT_TEST_EMAIL || "screentapinc@gmail.com";
const VOWINT_PASSWORD = process.env.VOWINT_TEST_PASSWORD || "Akollad@2026";
const CLIENT_ID = "test-cev-rate-limit-" + Date.now();

// Proxies disponibles
const PROXIES = [
  // Proxy iProyal (Congo - Kinshasa) - déjà configuré
  {
    name: "iproyal-cd",
    url: process.env.IPROYAL_PROXY_URL || "http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa@geo.iproyal.com:12321"
  },
  // Proxy BrightData (France - IP fixe)
  {
    name: "brightdata-fr",
    url: process.env.BRIGHTDATA_PROXY_URL || "http://brd-customer-hl_f0e9b823-zone-datacenter_proxy1-country-fr-ip-212.81.41.27:85jymkmfp0e6@brd.superproxy.io:33335"
  }
];

interface TestResult {
  attempt: number;
  proxy: string;
  sessionReset: boolean;
  success: boolean;
  error?: string;
  timestamp: string;
  responseTimeMs: number;
}

async function testCevClick(proxyUrl: string | null, sessionReset: boolean): Promise<TestResult> {
  const startTime = Date.now();
  
  if (sessionReset) {
    // Invalider le cache pour forcer un nouveau login
    invalidateVowintCache(VOWINT_EMAIL);
    console.log(`[TEST] Session reset pour ${VOWINT_EMAIL}`);
  }
  
  // Configurer le proxy si fourni
  let originalHttpProxy = process.env.HTTP_PROXY;
  let originalHttpsProxy = process.env.HTTPS_PROXY;
  
  if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    console.log(`[TEST] Utilisation proxy: ${proxyUrl.split('@')[0]}...`);
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    console.log(`[TEST] Pas de proxy (IP directe)`);
  }
  
  try {
    const result = await setupCevSessionHttp(
      VOWINT_EMAIL,
      VOWINT_PASSWORD,
      CLIENT_ID,
      CLIENT_ID
    );
    
    const responseTime = Date.now() - startTime;
    
    if (result.success) {
      console.log(`[TEST] ✅ Succès - Session: ${result.sessionCookie?.slice(0, 20)}..., Slots: ${result.slotsAvailable ? 'OUI' : 'NON'}`);
      return {
        attempt: 0, // sera mis à jour par l'appelant
        proxy: proxyUrl ? proxyUrl.split('@')[1]?.split(':')[0] || 'unknown' : 'direct',
        sessionReset,
        success: true,
        timestamp: new Date().toISOString(),
        responseTimeMs: responseTime
      };
    } else {
      console.log(`[TEST] ❌ Échec - Erreur: ${result.error}`);
      return {
        attempt: 0,
        proxy: proxyUrl ? proxyUrl.split('@')[1]?.split(':')[0] || 'unknown' : 'direct',
        sessionReset,
        success: false,
        error: result.error,
        timestamp: new Date().toISOString(),
        responseTimeMs: responseTime
      };
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.log(`[TEST] 💥 Exception: ${error instanceof Error ? error.message : String(error)}`);
    return {
      attempt: 0,
      proxy: proxyUrl ? proxyUrl.split('@')[1]?.split(':')[0] || 'unknown' : 'direct',
      sessionReset,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
      responseTimeMs: responseTime
    };
  } finally {
    // Restaurer les variables d'environnement originales
    if (originalHttpProxy) {
      process.env.HTTP_PROXY = originalHttpProxy;
    } else {
      delete process.env.HTTP_PROXY;
    }
    
    if (originalHttpsProxy) {
      process.env.HTTPS_PROXY = originalHttpsProxy;
    } else {
      delete process.env.HTTPS_PROXY;
    }
  }
}

async function runTest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST THÉORIE LIMITATION CEV - 5 clics/heure');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Théorie à tester :');
  console.log('  - Limite basée sur session cookie + adresse IP');
  console.log('  - Changement session + IP = contournement possible');
  console.log('');
  console.log(`Email VOWINT: ${VOWINT_EMAIL}`);
  console.log(`Proxies disponibles: ${PROXIES.length}`);
  console.log('');
  
  const results: TestResult[] = [];
  
  // PHASE 1 : 3 clics avec même session/IP (proxy iProyal)
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║ PHASE 1 : 3 clics avec même session/IP (proxy iProyal)   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- Clic ${i}/3 (même session/IP) ---`);
    
    const result = await testCevClick(PROXIES[0].url, false);
    result.attempt = i;
    results.push(result);
    
    // Attendre 2 secondes entre les clics
    if (i < 3) {
      console.log(`[TEST] Attente 2s avant prochain clic...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // PHASE 2 : Changement session + IP, puis 4 clics supplémentaires
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║ PHASE 2 : Changement session + IP (proxy BrightData)     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  console.log('\n[TEST] 🔄 Changement de session + IP...');
  
  for (let i = 1; i <= 4; i++) {
    console.log(`\n--- Clic ${i}/4 (nouvelle session/IP) ---`);
    
    // Pour les clics 1 et 3, on reset la session
    // Pour les clics 2 et 4, on garde la même session (mais IP différente)
    const sessionReset = i === 1 || i === 3;
    
    const result = await testCevClick(PROXIES[1].url, sessionReset);
    result.attempt = 3 + i; // Continuer la numérotation
    results.push(result);
    
    // Attendre 2 secondes entre les clics
    if (i < 4) {
      console.log(`[TEST] Attente 2s avant prochain clic...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // ANALYSE DES RÉSULTATS
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ANALYSE DES RÉSULTATS');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const totalAttempts = results.length;
  const successfulAttempts = results.filter(r => r.success).length;
  const failedAttempts = results.filter(r => !r.success).length;
  
  console.log(`Total tentatives: ${totalAttempts}`);
  console.log(`Succès: ${successfulAttempts}`);
  console.log(`Échecs: ${failedAttempts}`);
  
  // Analyser par phase
  const phase1Results = results.slice(0, 3);
  const phase2Results = results.slice(3);
  
  console.log('\n--- Phase 1 (même session/IP) ---');
  console.log(`Succès: ${phase1Results.filter(r => r.success).length}/3`);
  
  console.log('\n--- Phase 2 (changement session/IP) ---');
  console.log(`Succès: ${phase2Results.filter(r => r.success).length}/4`);
  
  // Vérifier la théorie
  const phase1AllSuccess = phase1Results.every(r => r.success);
  const phase2AllSuccess = phase2Results.every(r => r.success);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  CONCLUSION THÉORIE');
  console.log('═══════════════════════════════════════════════════════════════');
  
  if (phase1AllSuccess && phase2AllSuccess) {
    console.log('✅ THÉORIE CONFIRMÉE !');
    console.log('La limite de 5 clics/heure est basée sur session + IP.');
    console.log('Changer les deux permet de contourner la limite.');
  } else if (!phase1AllSuccess && phase2AllSuccess) {
    console.log('✅ THÉORIE PARTIELLEMENT CONFIRMÉE');
    console.log('La Phase 1 a échoué (limite atteinte) mais la Phase 2 a réussi.');
    console.log('Cela suggère que le changement session/IP contourne la limite.');
  } else if (phase1AllSuccess && !phase2AllSuccess) {
    console.log('❌ THÉORIE INFIRMÉE');
    console.log('La Phase 1 a réussi mais la Phase 2 a échoué.');
    console.log('La limite pourrait être basée sur autre chose (compte email, etc.).');
  } else {
    console.log('❓ RÉSULTATS INCONCLUANTS');
    console.log('Les deux phases ont eu des échecs.');
    console.log('Cela pourrait être dû à d\'autres facteurs (proxies, captcha, etc.).');
  }
  
  // Sauvegarder les résultats
  const outputFile = path.join(__dirname, '..', 'cev-rate-limit-test-results.json');
  const outputData = {
    testDate: new Date().toISOString(),
    theory: "Limite 5 clics/heure basée sur session cookie + adresse IP",
    email: VOWINT_EMAIL,
    results: results.map((r, idx) => ({
      ...r,
      phase: idx < 3 ? 'phase1_same_session_ip' : 'phase2_new_session_ip'
    })),
    summary: {
      totalAttempts,
      successfulAttempts,
      failedAttempts,
      phase1Success: phase1Results.filter(r => r.success).length,
      phase2Success: phase2Results.filter(r => r.success).length,
      theoryConfirmed: phase1AllSuccess && phase2AllSuccess
    }
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
  console.log(`\n📁 Résultats sauvegardés dans: ${outputFile}`);
  
  // Afficher les erreurs détaillées
  const errors = results.filter(r => r.error);
  if (errors.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ERREURS DÉTAILLÉES');
    console.log('═══════════════════════════════════════════════════════════════');
    errors.forEach((error, idx) => {
      console.log(`\nErreur ${idx + 1} (tentative ${error.attempt}):`);
      console.log(`  Proxy: ${error.proxy}`);
      console.log(`  Session reset: ${error.sessionReset}`);
      console.log(`  Erreur: ${error.error}`);
    });
  }
}

// Gestion des erreurs globales
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

// Exécuter le test
runTest().catch(error => {
  console.error('💥 Erreur lors de l\'exécution du test:', error);
  process.exit(1);
});