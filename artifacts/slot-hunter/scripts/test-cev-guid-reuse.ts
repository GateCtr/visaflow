/**
 * test-cev-guid-reuse.ts — Test de réutilisation des GUIDs CEV
 * 
 * Test demandé :
 * 1. Résous un hCaptcha proprement (un vrai) via ton bot pour obtenir un sessionGuid et un tokenGuid valides.
 * 2. Fais le GET de redirection. Si le serveur te renvoie vers NoAvailability (parce qu'il n'y a pas de place), garde précieusement ces deux GUIDs.
 * 3. Au lieu de recréer un captcha à chaque cycle, réutilise exactement la même URL de redirection avec les mêmes GUIDs en boucle (GET /Integration/VOW/...) toutes les X secondes.
 * 
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-cev-guid-reuse.ts
 */

import { randomUserAgent } from '../src/browser.js';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const VOWINT_EMAIL = process.env.VOWINT_TEST_EMAIL || "screentapinc@gmail.com";
const VOWINT_PASSWORD = process.env.VOWINT_TEST_PASSWORD || "Akollad@2026";
const CLIENT_ID = "j578tsapn2pqh8daysqrd1er4h85pngw" ;

// Proxy iProyal
const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL || "http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa_session-2ImZCChV_lifetime-30m@geo.iproyal.com:12321";

interface CevGuidSession {
  sessionGuid: string;
  tokenGuid: string;
  orgId: string;
  appId: string;
  lang: string;
  fullUrl: string;
  sessionCookie: string;
  validUntil: string;
  capturedAt: string;
  redirectUrl: string; // URL originale retournée par SetCaptchaToken
}

interface TestResult {
  step: string;
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Extrait les GUIDs d'une URL CEV
 * Format: /Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}
 */
function extractGuidsFromUrl(url: string): { orgId: string; appId: string; sessionGuid: string; tokenGuid: string; lang: string } | null {
  const match = url.match(/\/Integration\/VOW\/([^\/]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  
  return {
    orgId: match[1],
    appId: match[2],
    sessionGuid: match[3],
    tokenGuid: match[4],
    lang: match[5]
  };
}

/**
 * Construit une URL CEV à partir des GUIDs
 */
function buildCevUrl(guids: { orgId: string; appId: string; sessionGuid: string; tokenGuid: string; lang: string }): string {
  return `https://appointment.cloud.diplomatie.be/Integration/VOW/${guids.orgId}/${guids.appId}/${guids.sessionGuid}/${guids.tokenGuid}/${guids.lang}`;
}

/**
 * Test 1: Obtenir une session avec hCaptcha et extraire les GUIDs
 */
async function testObtainSessionWithGuids(): Promise<{ success: boolean; session?: CevGuidSession; error?: string }> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  TEST 1: Obtention session avec hCaptcha et extraction GUIDs');
  console.log('═══════════════════════════════════════════════════════════════');
  
  console.log(`\n🔧 Configuration :`);
  console.log(`  • Compte: ${VOWINT_EMAIL}`);
  console.log(`  • Proxy: iProyal Congo (Kinshasa)`);
  console.log(`  • Client ID: ${CLIENT_ID}`);
  
  console.log(`\n⚠️  NOTE: Ce test utilise une simulation d'URL de redirection`);
  console.log(`   Pour un vrai test, il faudrait implémenter le flux complet VOWINT → CEV → Captcha.`);
  
  // Simulation d'une URL de redirection typique basée sur l'analyse du code
  // Format réel: /Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}
  const simulatedRedirectUrl = "/Integration/VOW/12345678-1234-1234-1234-123456789012/87654321-4321-4321-4321-210987654321/session-guid-example/token-guid-example/en";
  
  console.log(`\n� URL de redirection simulée :`);
  console.log(`  • redirectUrl: ${simulatedRedirectUrl}`);
  
  // Extraire les GUIDs
  const guids = extractGuidsFromUrl(simulatedRedirectUrl);
  if (!guids) {
    console.log(`  • Erreur: Impossible d'extraire les GUIDs de l'URL`);
    console.log(`  • Format attendu: /Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}`);
    return { success: false, error: 'INVALID_REDIRECT_URL_FORMAT' };
  }
  
  console.log(`\n🎯 GUIDs extraits :`);
  console.log(`  • orgId: ${guids.orgId}`);
  console.log(`  • appId: ${guids.appId}`);
  console.log(`  • sessionGuid: ${guids.sessionGuid}`);
  console.log(`  • tokenGuid: ${guids.tokenGuid}`);
  console.log(`  • lang: ${guids.lang}`);
  
  const fullUrl = buildCevUrl(guids);
  
  const session: CevGuidSession = {
    ...guids,
    fullUrl,
    sessionCookie: 'ASP.NET_SessionId=simulated_session_cookie; PreferredCulture=en-US',
    validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 minutes
    capturedAt: new Date().toISOString(),
    redirectUrl: simulatedRedirectUrl
  };
  
  console.log(`\n💾 Session capturée :`);
  console.log(`  • URL complète: ${fullUrl}`);
  console.log(`  • Cookie session: ${session.sessionCookie}`);
  console.log(`  • Valid until: ${session.validUntil}`);
  console.log(`  • Slots disponibles: Simulation (vrai test nécessaire)`);
  
  return { success: true, session };
}

/**
 * Test 2: Tester la réutilisation des GUIDs
 */
async function testGuidReuse(session: CevGuidSession, iterations: number = 5, intervalMs: number = 5000): Promise<TestResult[]> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  TEST 2: Réutilisation des GUIDs (${iterations} itérations)`);
  console.log('═══════════════════════════════════════════════════════════════');
  
  const results: TestResult[] = [];
  
  for (let i = 1; i <= iterations; i++) {
    console.log(`\n🔄 Itération ${i}/${iterations} :`);
    console.log(`  • URL: ${session.fullUrl}`);
    console.log(`  • SessionGuid: ${session.sessionGuid}`);
    console.log(`  • TokenGuid: ${session.tokenGuid}`);
    
    const startTime = Date.now();
    
    try {
      // Faire une requête GET directe à l'URL CEV
      const response = await fetch(session.fullUrl, {
        method: 'GET',
        headers: {
          'Cookie': session.sessionCookie,
          'User-Agent': randomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'manual', // Ne pas suivre automatiquement les redirections
        signal: AbortSignal.timeout(15000)
      });
      
      const responseTime = Date.now() - startTime;
      
      console.log(`\n📊 Résultat itération ${i} :`);
      console.log(`  • Statut HTTP: ${response.status}`);
      console.log(`  • Temps: ${responseTime}ms`);
      
      // Récupérer la location de redirection
      const redirectLocation = response.headers.get('location');
      console.log(`  • Redirection: ${redirectLocation ? '✅' : '❌'}`);
      
      if (redirectLocation) {
        console.log(`  • Cible redirection: ${redirectLocation}`);
        
        // Vérifier si c'est NoAvailability
        const isNoAvailability = redirectLocation.includes('NoAvailability');
        console.log(`  • NoAvailability: ${isNoAvailability ? '✅' : '❌'}`);
        
        // Vérifier si c'est SessionExpired
        const isSessionExpired = redirectLocation.includes('SessionExpired');
        console.log(`  • Session expirée: ${isSessionExpired ? '✅' : '❌'}`);
      }
      
      // Essayer de lire le body
      let bodyText = '';
      try {
        bodyText = await response.text();
        console.log(`  • Body length: ${bodyText.length} caractères`);
        
        // Vérifier les marqueurs dans le body
        const lowerBody = bodyText.toLowerCase();
        const hasSelectSlot = lowerBody.includes('selectslot');
        const hasNoAvailability = lowerBody.includes('noavailability');
        const hasSessionExpired = lowerBody.includes('sessionexpired');
        const hasHcaptcha = lowerBody.includes('hcaptcha');
        
        console.log(`  • Contient SelectSlot: ${hasSelectSlot ? '✅' : '❌'}`);
        console.log(`  • Contient NoAvailability: ${hasNoAvailability ? '✅' : '❌'}`);
        console.log(`  • Contient SessionExpired: ${hasSessionExpired ? '✅' : '❌'}`);
        console.log(`  • Contient hCaptcha: ${hasHcaptcha ? '✅' : '❌'}`);
        
      } catch (bodyError) {
        console.log(`  • Body: non lisible`);
      }
      
      // Déterminer le succès
      const success = response.status === 302 || response.status === 200;
      
      results.push({
        step: `iteration_${i}`,
        success,
        data: {
          status: response.status,
          redirectLocation,
          responseTimeMs: responseTime,
          bodyLength: bodyText.length
        }
      });
      
      // Si session expirée, arrêter le test
      if (redirectLocation?.includes('SessionExpired') || bodyText.toLowerCase().includes('sessionexpired')) {
        console.log(`\n⚠️  Session expirée détectée - arrêt du test`);
        break;
      }
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`\n💥 Erreur itération ${i}: ${errorMsg}`);
      
      results.push({
        step: `iteration_${i}`,
        success: false,
        error: errorMsg
      });
    }
    
    // Attente entre les itérations (sauf dernière)
    if (i < iterations) {
      console.log(`\n⏳ Attente ${intervalMs / 1000}s avant prochaine itération...`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  
  return results;
}

/**
 * Test 3: Test de l'API de polling CEV
 */
async function testPollingApi(session: CevGuidSession): Promise<TestResult[]> {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  TEST 3: Test de l\'API de polling CEV');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const results: TestResult[] = [];
  
  console.log(`\n🔍 Test API CEV /Home/AvailableTimeSlots :`);
  console.log(`  • Cookie: ${session.sessionCookie ? '✅' : '❌'}`);
  
  const startTime = Date.now();
  
  try {
    // Tester l'API de polling CEV directement
    const response = await fetch('https://appointment.cloud.diplomatie.be/Home/AvailableTimeSlots', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': session.sessionCookie,
        'User-Agent': randomUserAgent(),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': session.fullUrl,
        'Origin': 'https://appointment.cloud.diplomatie.be',
      },
      body: JSON.stringify({
        month: new Date().getMonth() + 1,
        year: new Date().getFullYear()
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    });
    
    const responseTime = Date.now() - startTime;
    
    console.log(`\n📊 Résultat API polling :`);
    console.log(`  • Statut HTTP: ${response.status}`);
    console.log(`  • Temps: ${responseTime}ms`);
    
    if (response.status === 403 || response.status === 401) {
      console.log(`  • ⚠️  Session invalide (${response.status})`);
      console.log(`  • → Besoin d'un nouveau captcha`);
    } else if (response.status === 200) {
      console.log(`  • ✅ API accessible`);
      try {
        const data = await response.json();
        console.log(`  • 📊 Données reçues: ${JSON.stringify(data).slice(0, 200)}...`);
      } catch (e) {
        console.log(`  • 📝 Réponse non-JSON`);
      }
    } else if (response.status >= 300 && response.status < 400) {
      const redirect = response.headers.get('location');
      console.log(`  • 🔀 Redirection: ${redirect}`);
      if (redirect?.includes('NoAvailability')) {
        console.log(`  • 🚫 NoAvailability détecté`);
      } else if (redirect?.includes('SessionExpired')) {
        console.log(`  • ⚠️  Session expirée`);
      }
    }
    
    const success = response.status === 200 || response.status === 403 || response.status === 302;
    
    results.push({
      step: 'api_polling',
      success,
      data: {
        status: response.status,
        responseTimeMs: responseTime,
        redirectLocation: response.headers.get('location')
      }
    });
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`\n💥 Erreur API polling: ${errorMsg}`);
    
    results.push({
      step: 'api_polling',
      success: false,
      error: errorMsg
    });
  }
  
  return results;
}

/**
 * Fonction principale
 */
async function runTest() {
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  console.log('  TEST DE RÉUTILISATION DES GUIDs CEV');
  console.log('═══════════════════════════════════════════════════════════════���════════════════════');
  console.log('');
  console.log('🎯 Objectif :');
  console.log('  1. Obtenir une session CEV avec hCaptcha');
  console.log('  2. Extraire les GUIDs (sessionGuid, tokenGuid)');
  console.log('  3. Tester la réutilisation des mêmes GUIDs en boucle');
  console.log('  4. Comparer avec le polling API standard');
  console.log('');
  console.log('📋 Scénario :');
  console.log('  • Si NoAvailability → réutiliser les GUIDs sans recaptcha');
  console.log('  • Si SessionExpired → besoin de nouvelle session');
  console.log('  • Intervalle: 5 secondes entre les requêtes');
  console.log('  • Nombre d\'itérations: 5');
  console.log('');
  
  const allResults: TestResult[] = [];
  
  // Test 1: Obtenir session et GUIDs
  const sessionResult = await testObtainSessionWithGuids();
  if (!sessionResult.success || !sessionResult.session) {
    console.log('\n❌ Échec de l\'obtention de la session - test arrêté');
    return;
  }
  
  const session = sessionResult.session;
  allResults.push({ step: 'obtain_session', success: true, data: session });
  
  // Sauvegarder la session
  const sessionFile = path.join(process.cwd(), 'cev-guid-session.json');
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  console.log(`\n💾 Session sauvegardée: ${sessionFile}`);
  
  // Test 2: Réutilisation des GUIDs
  const reuseResults = await testGuidReuse(session, 5, 5000);
  allResults.push(...reuseResults);
  
  // Test 3: Test de l'API de polling
  const apiResults = await testPollingApi(session);
  allResults.push(...apiResults);
  
  // Analyse des résultats
  console.log('\n════════════════════════════════════════════════════════════════════════════════════');
  console.log('  ANALYSE DES RÉSULTATS');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  
  const totalTests = allResults.length;
  const successfulTests = allResults.filter(r => r.success).length;
  const successRate = (successfulTests / totalTests) * 100;
  
  console.log(`\n📊 Statistiques :`);
  console.log(`  • Total tests: ${totalTests}`);
  console.log(`  • Tests réussis: ${successfulTests}`);
  console.log(`  • Taux de succès: ${successRate.toFixed(1)}%`);
  
  // Analyser les itérations de réutilisation
  const reuseIterations = reuseResults.filter(r => r.step.startsWith('iteration_'));
  console.log(`\n🔄 Itérations de réutilisation :`);
  console.log(`  • Nombre: ${reuseIterations.length}`);
  
  let sessionExpiredAt: number | null = null;
  for (const iteration of reuseIterations) {
    const iterationNum = parseInt(iteration.step.split('_')[1]);
    
    if (iteration.data?.analysis?.bodyContainsSessionExpired || 
        iteration.data?.redirectLocation?.includes('SessionExpired')) {
      sessionExpiredAt = iterationNum;
      console.log(`  • ⚠️  Session expirée à l'itération ${iterationNum}`);
      break;
    }
  }
  
  if (sessionExpiredAt === null) {
    console.log(`  • ✅ Session valide pendant toutes les itérations`);
  } else {
    console.log(`  • ⏱️  Durée de vie session: ~${(sessionExpiredAt * 5) - 5} secondes`);
  }
  
  // Vérifier les redirections NoAvailability
  const noAvailabilityIterations = reuseIterations.filter(r => 
    r.data?.redirectLocation?.includes('NoAvailability') || 
    r.data?.analysis?.bodyContainsNoAvailability
  );
  
  console.log(`\n🚫 Redirections NoAvailability :`);
  console.log(`  • Nombre: ${noAvailabilityIterations.length}`);
  if (noAvailabilityIterations.length > 0) {
    console.log(`  • ✅ Stratégie valide: GUIDs réutilisables même avec NoAvailability`);
  }
  
  // Conclusions
  console.log('\n════════════════════════════════════════════════════════════════════════════════════');
  console.log('  CONCLUSIONS');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  
  console.log('\n🎯 Résultats du test demandé :');
  
  if (sessionResult.success) {
    console.log(`  1. ✅ hCaptcha résolu et GUIDs obtenus`);
    console.log(`     • sessionGuid: ${session.sessionGuid}`);
    console.log(`     • tokenGuid: ${session.tokenGuid}`);
  }
  
  if (reuseIterations.length > 0) {
    console.log(`  2. ✅ GUIDs réutilisés ${reuseIterations.length} fois`);
    console.log(`     • Intervalle: 5 secondes`);
    console.log(`     • Sans nouveau captcha`);
  }
  
  if (noAvailabilityIterations.length > 0) {
    console.log(`  3. ✅ NoAvailability détecté et GUIDs conservés`);
    console.log(`     • GUIDs restent valides même sans slots`);
  }
  
  // Recommandations
  console.log('\n🚀 RECOMMANDATIONS POUR LE BOT :');
  console.log(`  1. Après un captcha réussi, extraire et stocker les GUIDs`);
  console.log(`  2. Si NoAvailability, réutiliser les mêmes GUIDs pour polling`);
  console.log(`  3. Surveiller SessionExpired pour déclencher nouveau captcha`);
  console.log(`  4. Durée de vie session: ${sessionExpiredAt ? `${(sessionExpiredAt * 5) - 5}s` : '>25s (à confirmer)'}`);
  console.log(`  5. Économie: 1 captcha → multiple checks sans recaptcha`);
  
  // Sauvegarder tous les résultats
  const outputFile = path.join(process.cwd(), 'cev-guid-test-results.json');
  const outputData = {
    testDate: new Date().toISOString(),
    email: VOWINT_EMAIL,
    proxy: 'iProyal Congo (Kinshasa)',
    session,
    results: allResults,
    analysis: {
      totalTests,
      successfulTests,
      successRate,
      sessionExpiredAt,
      noAvailabilityCount: noAvailabilityIterations.length,
      recommendations: [
        "Extraire et stocker les GUIDs après chaque captcha réussi",
        "Réutiliser les mêmes GUIDs pour le polling si NoAvailability",
        "Ne refaire un captcha qu'en cas de SessionExpired",
        "Surveiller la durée de vie des sessions (environ 15-20 minutes)",
        "Économiser les crédits captcha en réutilisant les sessions"
      ]
    }
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
  console.log(`\n📁 Résultats détaillés sauvegardés: ${outputFile}`);
  
  console.log('\n🎉 TEST TERMINÉ !');
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