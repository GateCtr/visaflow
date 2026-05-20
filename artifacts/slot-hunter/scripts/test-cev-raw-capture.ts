/**
 * test-cev-raw-capture.ts — Capture brute des réponses HTTP CEV
 * 
 * Intercepte les réponses HTTP pour capturer les vrais messages de rate limiting
 * et identifier exactement quelle URL/étape déclenche le blocage.
 * 
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-cev-raw-capture.ts
 */

import { invalidateVowintCache } from '../src/cevHttpSetup.js';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const VOWINT_EMAIL = process.env.VOWINT_TEST_EMAIL || "screentapinc@gmail.com";
const VOWINT_PASSWORD = process.env.VOWINT_TEST_PASSWORD || "Akollad@2026";
const CLIENT_ID = "test-cev-raw-" + Date.now();

// Proxy iProyal
const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL || "http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa@geo.iproyal.com:12321";

// URLs importantes
const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";

interface HttpCapture {
  timestamp: string;
  step: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  responseBodyPreview?: string;
  error?: string;
  durationMs: number;
}

interface TestResult {
  success: boolean;
  error?: string;
  captures: HttpCapture[];
  rateLimitDetected: boolean;
  rateLimitStep?: string;
  rateLimitUrl?: string;
  rateLimitResponse?: string;
}

async function makeRawRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    step: string;
  }
): Promise<HttpCapture> {
  const startTime = Date.now();
  const capture: HttpCapture = {
    timestamp: new Date().toISOString(),
    step: options.step,
    url,
    method: options.method || 'GET',
    requestHeaders: options.headers || {},
    requestBody: options.body,
    responseStatus: 0,
    responseHeaders: {},
    durationMs: 0
  };

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      redirect: 'manual', // Ne pas suivre les redirections automatiquement
      signal: AbortSignal.timeout(60000)
    });

    capture.responseStatus = response.status;
    
    // Capturer les headers de réponse
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    capture.responseHeaders = headers;
    
    // Capturer le body de réponse
    try {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text') || contentType.includes('json') || contentType.includes('html')) {
        const text = await response.text();
        capture.responseBody = text;
        capture.responseBodyPreview = text.slice(0, 500) + (text.length > 500 ? '...' : '');
      }
    } catch (bodyError) {
      capture.error = `Body read error: ${bodyError}`;
    }
    
  } catch (error) {
    capture.error = error instanceof Error ? error.message : String(error);
  } finally {
    capture.durationMs = Date.now() - startTime;
  }
  
  return capture;
}

async function executeCevFlowWithCapture(): Promise<TestResult> {
  const captures: HttpCapture[] = [];
  let currentCookies = '';
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CAPTURE BRUTE DU FLUX CEV');
  console.log('═══════════════════════════════════════════════════════════════');
  
  try {
    // ÉTAPE 1: Page de login VOWINT (pour CSRF token et détecter la langue)
    console.log('\n🔍 ÉTAPE 1: Page login VOWINT');
    const loginPageCapture = await makeRawRequest(`${VOWINT_BASE}/`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      step: 'vowint_login_page'
    });
    captures.push(loginPageCapture);
    
    // Extraire CSRF token et détecter la langue du formulaire
    let csrfToken = '';
    let loginActionUrl = '/en/Account/Login'; // Par défaut anglais
    
    if (loginPageCapture.responseBody) {
      // Chercher le token CSRF
      const tokenMatch = loginPageCapture.responseBody.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
      if (tokenMatch) csrfToken = tokenMatch[1];
      
      // Détecter l'URL d'action du formulaire
      const actionMatch = loginPageCapture.responseBody.match(/<form[^>]*action="([^"]*Account\/Login[^"]*)"/i);
      if (actionMatch) {
        loginActionUrl = actionMatch[1];
        console.log(`  • Formulaire détecté: ${loginActionUrl}`);
      }
    }
    
    // Extraire cookies initiaux
    const setCookie = loginPageCapture.responseHeaders['set-cookie'];
    if (setCookie) {
      currentCookies = setCookie.split(';')[0];
    }
    
    console.log(`  • Status: ${loginPageCapture.responseStatus}`);
    console.log(`  • CSRF Token: ${csrfToken ? '✅ Trouvé' : '❌ Non trouvé'}`);
    console.log(`  • Cookies: ${currentCookies ? '✅ Obt' : '❌ Non'}`);
    console.log(`  • URL Login: ${loginActionUrl}`);
    
    if (!csrfToken) {
      return {
        success: false,
        error: 'CSRF_TOKEN_NOT_FOUND',
        captures,
        rateLimitDetected: false
      };
    }
    
    // ÉTAPE 2: Login VOWINT
    console.log('\n🔍 ÉTAPE 2: Login VOWINT');
    const loginBody = new URLSearchParams({
      __RequestVerificationToken: csrfToken,
      UserName: VOWINT_EMAIL,
      Password: VOWINT_PASSWORD,
    }).toString();
    
    // Construire l'URL complète pour le login
    const fullLoginUrl = loginActionUrl.startsWith('http') 
      ? loginActionUrl 
      : `${VOWINT_BASE}${loginActionUrl}`;
    
    const loginCapture = await makeRawRequest(fullLoginUrl, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': currentCookies,
        'Referer': `${VOWINT_BASE}/`,
        'Origin': VOWINT_BASE,
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      body: loginBody,
      step: 'vowint_login_submit'
    });
    captures.push(loginCapture);
    
    // Mettre à jour les cookies
    if (loginCapture.responseHeaders['set-cookie']) {
      currentCookies = loginCapture.responseHeaders['set-cookie'].split(';')[0];
    }
    
    console.log(`  • Status: ${loginCapture.responseStatus}`);
    console.log(`  • Location: ${loginCapture.responseHeaders['location'] || 'Aucune'}`);
    console.log(`  • Cookies mis à jour: ${currentCookies ? '✅' : '❌'}`);
    
    // Vérifier si login a réussi (302 redirect)
    if (loginCapture.responseStatus !== 302) {
      // Analyser la réponse pour comprendre l'échec
      let errorReason = 'LOGIN_FAILED_UNKNOWN';
      if (loginCapture.responseBody?.includes('rate limit') || loginCapture.responseBody?.includes('trop de tentatives')) {
        errorReason = 'RATE_LIMIT_LOGIN';
      } else if (loginCapture.responseBody?.includes('Invalid credentials') || loginCapture.responseBody?.includes('identifiants incorrects')) {
        errorReason = 'INVALID_CREDENTIALS';
      }
      
      return {
        success: false,
        error: errorReason,
        captures,
        rateLimitDetected: errorReason === 'RATE_LIMIT_LOGIN',
        rateLimitStep: 'vowint_login_submit',
        rateLimitUrl: fullLoginUrl,
        rateLimitResponse: loginCapture.responseBodyPreview
      };
    }
    
    // ÉTAPE 3: Suivre la redirection post-login
    console.log('\n🔍 ÉTAPE 3: Redirection post-login');
    const redirectUrl = loginCapture.responseHeaders['location'];
    if (redirectUrl) {
      const fullRedirectUrl = redirectUrl.startsWith('http') ? redirectUrl : `${VOWINT_BASE}${redirectUrl}`;
      
      const redirectCapture = await makeRawRequest(fullRedirectUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'Cookie': currentCookies,
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'Referer': fullLoginUrl,
        },
        step: 'vowint_post_login_redirect'
      });
      captures.push(redirectCapture);
      
      // Mettre à jour les cookies
      if (redirectCapture.responseHeaders['set-cookie']) {
        currentCookies = redirectCapture.responseHeaders['set-cookie'].split(';')[0];
      }
      
      console.log(`  • Status: ${redirectCapture.responseStatus}`);
      console.log(`  • Final URL: ${redirectCapture.url}`);
    }
    
    // ÉTAPE 4: Page "Mes demandes" pour trouver appId
    console.log('\n🔍 ÉTAPE 4: Page Mes demandes (IndexByUserId)');
    const myAppsCapture = await makeRawRequest(`${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Cookie': currentCookies,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Referer': fullLoginUrl,
        'Upgrade-Insecure-Requests': '1',
      },
      step: 'vowint_my_applications'
    });
    captures.push(myAppsCapture);
    
    // Extraire appId de la page
    let appId = '';
    if (myAppsCapture.responseBody) {
      const appIdMatch = myAppsCapture.responseBody.match(/GetEAppointmentUrl\?id=([a-f0-9-]+)/i);
      if (appIdMatch) appId = appIdMatch[1];
    }
    
    console.log(`  • Status: ${myAppsCapture.responseStatus}`);
    console.log(`  • AppId: ${appId ? `✅ ${appId}` : '❌ Non trouvé'}`);
    
    if (!appId) {
      return {
        success: false,
        error: 'APP_ID_NOT_FOUND',
        captures,
        rateLimitDetected: false
      };
    }
    
    // ÉTAPE 5: GetEAppointmentUrl (LE CLIC CRITIQUE)
    console.log('\n🔍 ÉTAPE 5: GetEAppointmentUrl (LE CLIC)');
    const eAppointmentUrl = `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${appId}`;
    
    const clickCapture = await makeRawRequest(eAppointmentUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Cookie': currentCookies,
        'Accept': 'application/json, text/html, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'If-Modified-Since': '0',
        'Referer': `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
      },
      step: 'vowint_get_eappointment_url'
    });
    captures.push(clickCapture);
    
    console.log(`  • Status: ${clickCapture.responseStatus}`);
    console.log(`  • URL: ${eAppointmentUrl}`);
    
    // Analyser la réponse pour le rate limiting
    let integrationUrl = '';
    let rateLimitDetected = false;
    
    if (clickCapture.responseBody) {
      // Vérifier les patterns de rate limiting
      const rateLimitPatterns = [
        /5\s*fois/i, /5\s*times/i, /bloqu[ée]\s*pendant/i, /blocked\s*for/i,
        /too\s*many\s*attempts/i, /ErrorTooManyAttempts/i, /rate.?limit/i,
        /maximum.*tentatives/i, /maximum.*attempts/i,
        /veuillez\s*r[ée]essayer/i, /please\s*try\s*again\s*later/i,
      ];
      
      rateLimitDetected = rateLimitPatterns.some(p => p.test(clickCapture.responseBody!));
      
      if (rateLimitDetected) {
        console.log(`  • ⚠️ RATE LIMIT DÉTECTÉ DANS LA RÉPONSE!`);
        
        return {
          success: false,
          error: 'RATE_LIMIT_VOWINT_5_CLICKS',
          captures,
          rateLimitDetected: true,
          rateLimitStep: 'vowint_get_eappointment_url',
          rateLimitUrl: eAppointmentUrl,
          rateLimitResponse: clickCapture.responseBodyPreview
        };
      }
      
      // Essayer d'extraire l'URL d'intégration
      try {
        const data = JSON.parse(clickCapture.responseBody) as { url?: string; error?: string } | string;
        if (typeof data === 'string' && data.includes('/Integration/VOW/')) {
          integrationUrl = data.trim().replace(/^"|"$/g, '');
        } else if (typeof data === 'object' && data?.url) {
          integrationUrl = data.url;
        }
      } catch {
        // Pas du JSON
        if (clickCapture.responseBody.includes('/Integration/VOW/')) {
          integrationUrl = clickCapture.responseBody.trim().replace(/^"|"$/g, '');
        }
      }
    }
    
    console.log(`  • Integration URL: ${integrationUrl ? '✅ Trouvée' : '❌ Non trouvée'}`);
    
    if (!integrationUrl) {
      return {
        success: false,
        error: 'NO_INTEGRATION_URL',
        captures,
        rateLimitDetected: false
      };
    }
    
    // Si nous arrivons ici, le clic a réussi
    return {
      success: true,
      captures,
      rateLimitDetected: false
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`\n💥 ERREUR GLOBALE: ${errorMsg}`);
    
    return {
      success: false,
      error: errorMsg,
      captures,
      rateLimitDetected: false
    };
  }
}

async function runTest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TEST: Capture brute des messages de rate limiting');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Objectif: Identifier exactement:');
  console.log('  1. Quelle URL déclenche le rate limiting');
  console.log('  2. Quelle réponse exacte est retournée');
  console.log('  3. À quelle étape du flux');
  console.log('');
  console.log(`Compte: ${VOWINT_EMAIL}`);
  console.log(`Proxy: iProyal Congo`);
  console.log('');
  
  // Configurer le proxy
  const oldHttpProxy = process.env.HTTP_PROXY;
  const oldHttpsProxy = process.env.HTTPS_PROXY;
  process.env.HTTP_PROXY = IPROYAL_PROXY_URL;
  process.env.HTTPS_PROXY = IPROYAL_PROXY_URL;
  
  const allResults: TestResult[] = [];
  
  try {
    // Premier test: état actuel (peut-être déjà en limite)
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║ TEST 1: État actuel (sans reset)                         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    
    const result1 = await executeCevFlowWithCapture();
    allResults.push(result1);
    
    console.log(`\n📊 RÉSULTAT TEST 1:`);
    console.log(`  • Succès: ${result1.success ? '✅' : '❌'}`);
    console.log(`  • Rate limit: ${result1.rateLimitDetected ? '✅ DÉTECTÉ' : '❌ NON DÉTECTÉ'}`);
    if (result1.rateLimitDetected) {
      console.log(`  • Étape: ${result1.rateLimitStep}`);
      console.log(`  • URL: ${result1.rateLimitUrl}`);
      console.log(`  • Réponse: ${result1.rateLimitResponse?.slice(0, 200)}...`);
    }
    
    // Attendre 30s
    console.log('\n⏳ Attente 30 secondes...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Deuxième test: avec reset de session
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║ TEST 2: Avec reset de session                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    
    invalidateVowintCache(VOWINT_EMAIL);
    console.log('  🔄 Session resetée');
    
    const result2 = await executeCevFlowWithCapture();
    allResults.push(result2);
    
    console.log(`\n📊 RÉSULTAT TEST 2:`);
    console.log(`  • Succès: ${result2.success ? '✅' : '❌'}`);
    console.log(`  • Rate limit: ${result2.rateLimitDetected ? '✅ DÉTECTÉ' : '❌ NON DÉTECTÉ'}`);
    if (result2.rateLimitDetected) {
      console.log(`  • Étape: ${result2.rateLimitStep}`);
      console.log(`  • URL: ${result2.rateLimitUrl}`);
      console.log(`  • Réponse: ${result2.rateLimitResponse?.slice(0, 200)}...`);
    }
    
    // ANALYSE COMPARATIVE
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ANALYSE COMPARATIVE');
    console.log('═══════════════════════════════════════════════════════════════');
    
    const test1RateLimit = result1.rateLimitDetected;
    const test2RateLimit = result2.rateLimitDetected;
    
    console.log('\n🔍 COMPARAISON:');
    console.log(`  • Test 1 (sans reset): ${test1RateLimit ? 'RATE LIMIT' : 'PAS DE LIMITE'}`);
    console.log(`  • Test 2 (avec reset): ${test2RateLimit ? 'RATE LIMIT' : 'PAS DE LIMITE'}`);
    
    if (test1RateLimit && !test2RateLimit) {
      console.log('\n🎯 CONCLUSION: Le rate limiting est lié à la SESSION');
      console.log('   → Reset de session contourne la limite');
    } else if (!test1RateLimit && test2RateLimit) {
      console.log('\n🎯 CONCLUSION: Le rate limiting est lié au COMPTE');
      console.log('   → Reset de session déclenche la limite');
    } else if (test1RateLimit && test2RateLimit) {
      console.log('\n🎯 CONCLUSION: Le rate limiting est GLOBAL (compte)');
      console.log('   → Limite active dans les deux cas');
    } else {
      console.log('\n🎯 CONCLUSION: Pas de rate limiting détecté');
      console.log('   → Le compteur était probablement vide');
    }
    
    // Sauvegarder les captures détaillées
    const outputFile = path.join(process.cwd(), 'cev-raw-captures.json');
    const outputData = {
      testDate: new Date().toISOString(),
      email: VOWINT_EMAIL,
      results: allResults.map((result, idx) => ({
        testNumber: idx + 1,
        success: result.success,
        error: result.error,
        rateLimitDetected: result.rateLimitDetected,
        rateLimitStep: result.rateLimitStep,
        rateLimitUrl: result.rateLimitUrl,
        rateLimitResponse: result.rateLimitResponse,
        captureCount: result.captures.length
      })),
      detailedCaptures: allResults.flatMap((result, idx) => 
        result.captures.map(capture => ({
          testNumber: idx + 1,
          ...capture
        }))
      )
    };
    
    fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
    console.log(`\n📁 Captures brutes sauvegardées: ${outputFile}`);
    
    // Afficher un résumé des URLs testées
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  URLs TESTÉES');
    console.log('═══════════════════════════════════════════════════════════════');
    
    const allCaptures = allResults.flatMap(r => r.captures);
    const uniqueUrls = [...new Set(allCaptures.map(c => c.url))];
    
    uniqueUrls.forEach((url, idx) => {
      console.log(`\n${idx + 1}. ${url}`);
      const capturesForUrl = allCaptures.filter(c => c.url === url);
      const statuses = capturesForUrl.map(c => c.responseStatus).join(', ');
      console.log(`   • Appels: ${capturesForUrl.length}`);
      console.log(`   • Status: ${statuses}`);
    });
    
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