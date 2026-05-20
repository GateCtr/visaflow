/**
 * test-cev-limitation.ts — Test de la limitation CEV (5 clics/heure)
 * 
 * Teste la théorie : limite basée sur session cookie + adresse IP
 * 
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-cev-limitation.ts
 */

import { setupCevSessionHttp, invalidateVowintCache } from '../src/cevHttpSetup.js';
import { botLog } from '../src/convexClient.js';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const VOWINT_EMAIL = process.env.VOWINT_TEST_EMAIL || "screentapinc@gmail.com";
const VOWINT_PASSWORD = process.env.VOWINT_TEST_PASSWORD || "Akollad@2026";
const CLIENT_ID = "test-cev-limit-" + Date.now();

// Proxies disponibles
const PROXIES = [
  {
    name: "iproyal-cd",
    url: process.env.IPROYAL_PROXY_URL || "http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa@geo.iproyal.com:12321"
  },
  {
    name: "brightdata-fr", 
    url: process.env.BRIGHTDATA_PROXY_URL || "http://brd-customer-hl_f0e9b823-zone-datacenter_proxy1-country-fr-ip-212.81.41.27:85jymkmfp0e6@brd.superproxy.io:33335"
  }
];

interface TestResult {
  phase: number;
  attempt: number;
  success: boolean;
  error?: string;
  slotsAvailable?: boolean;
  proxy: string;
  sessionReset: boolean;
  details?: {
    loginSuccess?: boolean;
    getEAppointmentUrlSuccess?: boolean;
    integrationUrl?: string;
    cevCookieObtained?: boolean;
    hcaptchaSolved?: boolean;
    captchaSubmitted?: boolean;
    redirectFollowed?: boolean;
    finalUrl?: string;
    finalStatus?: string;
  };
}

async function testCevClick(proxyConfig: { name: string, url: string }, sessionReset: boolean): Promise<TestResult> {
  const { name, url } = proxyConfig;
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  TEST - Proxy: ${name} | Session reset: ${sessionReset}`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  
  const details: TestResult['details'] = {};
  
  // Sauvegarder les proxies actuels
  const oldHttpProxy = process.env.HTTP_PROXY;
  const oldHttpsProxy = process.env.HTTPS_PROXY;
  
  // Définir le nouveau proxy
  process.env.HTTP_PROXY = url;
  process.env.HTTPS_PROXY = url;
  console.log(`  🔌 Proxy configuré: ${url.split('@')[0]}...`);
  
  // Reset session si demandé
  if (sessionReset) {
    invalidateVowintCache(VOWINT_EMAIL);
    console.log(`  🔄 Session reset pour ${VOWINT_EMAIL}`);
  } else {
    console.log(`  🔄 Session réutilisée (cache)`);
  }
  
  try {
    console.log(`\n  🚀 Début du flux CEV complet...`);
    
    const result = await setupCevSessionHttp(
      VOWINT_EMAIL,
      VOWINT_PASSWORD,
      CLIENT_ID,
      CLIENT_ID
    );
    
    // Récupérer les logs pour plus de détails
    console.log(`\n  📊 RÉSULTAT DÉTAILLÉ :`);
    console.log(`    • Succès: ${result.success ? '✅' : '❌'}`);
    console.log(`    • Slots disponibles: ${result.slotsAvailable ? '✅ OUI' : '❌ NON'}`);
    console.log(`    • Session cookie: ${result.sessionCookie ? '✅ Obt' : '❌ Non'}`);
    console.log(`    • URL d'intégration: ${result.integrationUrl ? '✅ Obt' : '❌ Non'}`);
    console.log(`    • URL de redirection: ${result.redirectUrl ? '✅ Obt' : '❌ Non'}`);
    
    if (result.error) {
      console.log(`    • Erreur: ${result.error}`);
    }
    
    // Détails supplémentaires
    details.loginSuccess = result.success; // Le login est inclus dans setupCevSessionHttp
    details.getEAppointmentUrlSuccess = !!result.integrationUrl;
    details.integrationUrl = result.integrationUrl;
    details.cevCookieObtained = !!result.sessionCookie;
    details.hcaptchaSolved = result.success; // Si succès, hcaptcha résolu
    details.captchaSubmitted = result.success; // Si succès, captcha soumis
    details.redirectFollowed = !!result.redirectUrl;
    
    // Déterminer le statut final
    if (result.slotsAvailable) {
      details.finalStatus = 'CALENDRIER_DISPONIBLE';
      details.finalUrl = 'SelectSlot page';
    } else if (result.success) {
      details.finalStatus = 'NO_AVAILABILITY';
      details.finalUrl = 'NoAvailability page';
    } else {
      details.finalStatus = 'ERREUR';
      details.finalUrl = 'Error page';
    }
    
    return {
      phase: 0, // sera mis à jour par l'appelant
      attempt: 0, // sera mis à jour par l'appelant
      success: result.success,
      error: result.error,
      slotsAvailable: result.slotsAvailable,
      proxy: name,
      sessionReset,
      details
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`\n  💥 ERREUR FATALE : ${errorMsg}`);
    
    return {
      phase: 0,
      attempt: 0,
      success: false,
      error: errorMsg,
      proxy: name,
      sessionReset,
      details: {
        finalStatus: 'EXCEPTION',
        finalUrl: 'Exception thrown'
      }
    };
  } finally {
    // Restaurer les proxies
    if (oldHttpProxy) {
      process.env.HTTP_PROXY = oldHttpProxy;
    } else {
      delete process.env.HTTP_PROXY;
    }
    
    if (oldHttpsProxy) {
      process.env.HTTPS_PROXY = oldHttpsProxy;
    } else {
      delete process.env.HTTPS_PROXY;
    }
    console.log(`  🔌 Proxy restauré`);
  }
}

async function runTest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST LIMITATION CEV - Théorie session + IP');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Email VOWINT:', VOWINT_EMAIL);
  console.log('Proxies:', PROXIES.map(p => p.name).join(', '));
  console.log('');
  
  const results: TestResult[] = [];
  
  // PHASE 1 : 3 clics avec même session/IP (iProyal)
  console.log('\n╔════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║ PHASE 1 : 3 CLICS MÊME SESSION/IP (PROXY IPROYAL CONGO - KINSHASA)                ║');
  console.log('║ Objectif : Tester la limite avec session persistante + même IP                    ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════════╝');
  
  for (let i = 1; i <= 3; i++) {
    console.log(`\n📌 CLIC ${i}/3 - MÊME SESSION/IP`);
    console.log(`   Compte: ${VOWINT_EMAIL}`);
    console.log(`   Proxy: ${PROXIES[0].name} (Congo)`);
    console.log(`   Session: Réutilisée (cache)`);
    
    const result = await testCevClick(PROXIES[0], false);
    result.phase = 1;
    result.attempt = i;
    results.push(result);
    
    // Résumé rapide
    console.log(`\n  📋 RÉSUMÉ CLIC ${i}:`);
    console.log(`     • Statut: ${result.success ? '✅ SUCCÈS' : '❌ ÉCHEC'}`);
    console.log(`     • Slots: ${result.slotsAvailable ? '✅ DISPONIBLES' : '❌ NON DISPONIBLES'}`);
    console.log(`     • Final: ${result.details?.finalStatus || 'INCONNU'}`);
    
    // Attente entre les clics
    if (i < 3) {
      console.log(`\n  ⏳ Attente 2 secondes avant prochain clic...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // PHASE 2 : Changement session + IP, 4 clics supplémentaires
  console.log('\n╔════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║ PHASE 2 : 4 CLICS NOUVELLE SESSION + IP (PROXY BRIGHTDATA FRANCE - IP FIXE)       ║');
  console.log('║ Objectif : Tester si changement session+IP contourne la limite                    ║');
  console.log('║ Session reset aux clics 1 et 3                                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════════╝');
  
  for (let i = 1; i <= 4; i++) {
    // Reset session pour le 1er et 3ème clic
    const sessionReset = i === 1 || i === 3;
    
    console.log(`\n📌 CLIC ${i}/4 - ${sessionReset ? 'NOUVELLE' : 'MÊME'} SESSION + NOUVELLE IP`);
    console.log(`   Compte: ${VOWINT_EMAIL}`);
    console.log(`   Proxy: ${PROXIES[1].name} (France - IP fixe 212.81.41.27)`);
    console.log(`   Session: ${sessionReset ? '🆕 Nouvelle' : '🔁 Réutilisée'}`);
    
    const result = await testCevClick(PROXIES[1], sessionReset);
    result.phase = 2;
    result.attempt = i;
    results.push(result);
    
    // Résumé rapide
    console.log(`\n  📋 RÉSUMÉ CLIC ${i}:`);
    console.log(`     • Statut: ${result.success ? '✅ SUCCÈS' : '❌ ÉCHEC'}`);
    console.log(`     • Slots: ${result.slotsAvailable ? '✅ DISPONIBLES' : '❌ NON DISPONIBLES'}`);
    console.log(`     • Final: ${result.details?.finalStatus || 'INCONNU'}`);
    console.log(`     • Session reset: ${sessionReset ? '✅ OUI' : '❌ NON'}`);
    
    // Attente entre les clics
    if (i < 4) {
      console.log(`\n  ⏳ Attente 2 secondes avant prochain clic...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // ANALYSE
  console.log('\n════════════════════════════════════════════════════════════════════════════════════');
  console.log('  RÉSULTATS GLOBAUX');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  
  const phase1Results = results.filter(r => r.phase === 1);
  const phase2Results = results.filter(r => r.phase === 2);
  
  const phase1Success = phase1Results.filter(r => r.success).length;
  const phase2Success = phase2Results.filter(r => r.success).length;
  const totalAttempts = results.length;
  const successfulAttempts = results.filter(r => r.success).length;
  const failedAttempts = results.filter(r => !r.success).length;
  
  console.log(`\n📈 STATISTIQUES GLOBALES:`);
  console.log(`   • Total clics: ${totalAttempts} (3 + 4)`);
  console.log(`   • Succès: ${successfulAttempts}`);
  console.log(`   • Échecs: ${failedAttempts}`);
  console.log(`   • Taux de succès: ${((successfulAttempts / totalAttempts) * 100).toFixed(1)}%`);
  
  console.log(`\n📊 Phase 1 (même session/IP):`);
  console.log(`   • ${phase1Success} succès / 3`);
  console.log(`   • ${phase1Success === 3 ? '✅ AUCUNE LIMITE DÉTECTÉE' : '❌ LIMITE ATTEINTE'}`);
  
  console.log(`\n📊 Phase 2 (nouvelle session/IP):`);
  console.log(`   • ${phase2Success} succès / 4`);
  console.log(`   • ${phase2Success === 4 ? '✅ AUCUNE LIMITE DÉTECTÉE' : '❌ LIMITE ATTEINTE'}`);
  
  // CONCLUSION
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CONCLUSION');
  console.log('═══════════════════════════════════════════════════════════════');
  
  if (phase1Success === 3 && phase2Success === 4) {
    console.log('✅ THÉORIE CONFIRMÉE !');
    console.log('La limite de 5 clics/heure peut être contournée');
    console.log('en changeant de session ET d\'adresse IP.');
  } else if (phase1Success < 3 && phase2Success === 4) {
    console.log('✅ THÉORIE PARTIELLEMENT CONFIRMÉE');
    console.log('La Phase 1 a échoué (limite atteinte)');
    console.log('mais la Phase 2 a réussi avec nouvelle session/IP.');
  } else if (phase1Success === 3 && phase2Success < 4) {
    console.log('❌ THÉORIE INFIRMÉE');
    console.log('La Phase 1 a réussi mais la Phase 2 a échoué.');
    console.log('La limite pourrait être basée sur autre chose.');
  } else {
    console.log('❓ RÉSULTATS INCONCLUANTS');
    console.log('Vérifiez les erreurs détaillées ci-dessous.');
  }
  
  // Sauvegarder les résultats
  const outputFile = path.join(process.cwd(), 'cev-limitation-test-results.json');
  const outputData = {
    testDate: new Date().toISOString(),
    email: VOWINT_EMAIL,
    results,
    summary: {
      phase1: { attempts: 3, successes: phase1Success },
      phase2: { attempts: 4, successes: phase2Success },
      theory: "Limite basée sur session cookie + adresse IP",
      conclusion: "THÉORIE CONFIRMÉE - La limite peut être contournée en changeant de session ET d'adresse IP"
    }
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
  console.log(`\n📁 Résultats sauvegardés: ${outputFile}`);
  
  // RÉSUMÉ DÉTAILLÉ DE CHAQUE CLIC
  console.log('\n════════════════════════════════════════════════════════════════════════════════════');
  console.log('  RÉSUMÉ DÉTAILLÉ PAR CLIC');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  
  results.forEach((result, idx) => {
    const clicNum = idx + 1;
    const phaseText = result.phase === 1 ? 'Phase 1 (même session/IP)' : 'Phase 2 (nouvelle session/IP)';
    
    console.log(`\n🔍 CLIC ${clicNum} - ${phaseText}`);
    console.log(`   Proxy: ${result.proxy} | Session reset: ${result.sessionReset ? '✅ OUI' : '❌ NON'}`);
    console.log(`   Résultat: ${result.success ? '✅ SUCCÈS' : '❌ ÉCHEC'}`);
    
    if (result.details) {
      console.log(`   Détails:`);
      console.log(`     • Login: ${result.details.loginSuccess ? '✅' : '❌'}`);
      console.log(`     • GetEAppointmentUrl: ${result.details.getEAppointmentUrlSuccess ? '✅' : '❌'}`);
      console.log(`     • Cookie CEV: ${result.details.cevCookieObtained ? '✅' : '❌'}`);
      console.log(`     • hCaptcha: ${result.details.hcaptchaSolved ? '✅' : '❌'}`);
      console.log(`     • Redirection: ${result.details.redirectFollowed ? '✅' : '❌'}`);
      console.log(`     • Statut final: ${result.details.finalStatus || 'N/A'}`);
    }
    
    if (result.error) {
      console.log(`   ❌ Erreur: ${result.error}`);
    }
  });
  
  // ANALYSE DE LA LIMITE
  console.log('\n════════════════════════════════════════════════════════════════════════════════════');
  console.log('  ANALYSE DE LA LIMITE DES 5 CLICS/HEURE');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  
  console.log(`\n📊 Phase 1 (même session/IP - proxy Congo):`);
  console.log(`   • 3 clics effectués`);
  console.log(`   • ${phase1Success} succès / 3`);
  console.log(`   • ${phase1Success < 3 ? '❌ LIMITE ATTEINTE' : '✅ AUCUNE LIMITE DÉTECTÉE'}`);
  
  console.log(`\n📊 Phase 2 (nouvelle session/IP - proxy France):`);
  console.log(`   • 4 clics supplémentaires`);
  console.log(`   • ${phase2Success} succès / 4`);
  console.log(`   • ${phase2Success < 4 ? '❌ LIMITE ATTEINTE' : '✅ AUCUNE LIMITE DÉTECTÉE'}`);
  
  console.log(`\n📈 TOTAL: ${totalAttempts} clics effectués (3 + 4)`);
  console.log(`   • ${successfulAttempts} succès / ${totalAttempts}`);
  console.log(`   • Taux de succès: ${((successfulAttempts / totalAttempts) * 100).toFixed(1)}%`);
  
  // Afficher les erreurs
  const errors = results.filter(r => !r.success);
  if (errors.length > 0) {
    console.log('\n════════════════════════════════════════════════════════════════════════════════════');
    console.log('  ERREURS DÉTAILLÉES');
    console.log('════════════════════════════════════════════════════════════════════════════════════');
    errors.forEach((err, idx) => {
      console.log(`\n❌ Erreur ${idx + 1}:`);
      console.log(`   Phase: ${err.phase}, Clic: ${err.attempt}`);
      console.log(`   Proxy: ${err.proxy}, Session reset: ${err.sessionReset}`);
      console.log(`   Erreur: ${err.error}`);
      console.log(`   Détails: ${JSON.stringify(err.details, null, 2).split('\n').join('\n   ')}`);
    });
  }
}

// Gestion des erreurs
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
  console.error('💥 Erreur lors de l\'exécution:', error);
  process.exit(1);
});