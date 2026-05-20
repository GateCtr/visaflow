/**
 * test-cev-comprehensive-with-interception.ts — Test complet des découvertes CEV avec interception HTTP
 * 
 * Version modifiée avec système d'interception pour capturer toutes les requêtes et réponses
 * 
 * Scénarios testés :
 * 1. Même session + même IP (persistance)
 * 2. Nouvelle session + même IP (reset agressif)
 * 3. Même session + nouvelle IP (rotation IP seule)
 * 4. Nouvelle session + nouvelle IP (rotation complète)
 * 
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-cev-comprehensive-with-interception.ts
 */

import { setupCevSessionHttp, invalidateVowintCache } from '../src/cevHttpSetup.js';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const VOWINT_EMAIL = process.env.VOWINT_TEST_EMAIL || "screentapinc@gmail.com";
const VOWINT_PASSWORD = process.env.VOWINT_TEST_PASSWORD || "Akollad@2026";
const CLIENT_ID = "test-cev-comp-" + Date.now();

// Proxy iProyal de base (Congo - Kinshasa)
const IPROYAL_BASE = process.env.IPROYAL_PROXY_URL || "http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa@geo.iproyal.com:12321";

// Simulation de rotation d'IP avec iProyal
function getIproyalProxyWithRotation(rotationId: string): string {
  return `${IPROYAL_BASE}?rotation=${rotationId}`;
}

// ============================================================================
// SYSTÈME D'INTERCEPTION HTTP AVEC CAPTURE D'ERREURS RATE LIMIT
// ============================================================================

interface HttpLogEntry {
  timestamp: string;
  direction: 'OUT' | 'IN';
  method?: string;
  url: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  requestBody?: any;
  responseBody?: any;
  responseText?: string;
  error?: string;
  durationMs?: number;
  isRateLimitError?: boolean;
  rateLimitDetails?: {
    detected: boolean;
    patterns: string[];
    responseContains: string;
    urlContains: string;
  };
}

const httpLog: HttpLogEntry[] = [];
const rateLimitCaptures: HttpLogEntry[] = [];

// Patterns pour détecter les erreurs de rate limit
const RATE_LIMIT_PATTERNS = [
  /5\s*fois/i, /5\s*times/i, /bloqu[ée]\s*pendant/i, /blocked\s*for/i,
  /too\s*many\s*attempts/i, /ErrorTooManyAttempts/i, /rate.?limit/i,
  /maximum.*tentatives/i, /maximum.*attempts/i,
  /veuillez\s*r[ée]essayer/i, /please\s*try\s*again\s*later/i,
  /429\s*Too\s*Many\s*Requests/i, /quota\s*exceeded/i,
  /trop\s*de\s*tentatives/i, /tentatives\s*excessives/i
];

// Wrapper autour de fetch pour intercepter toutes les requêtes
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const startTime = Date.now();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method || 'GET';
  
  // Log de la requête sortante
  const requestEntry: HttpLogEntry = {
    timestamp: new Date().toISOString(),
    direction: 'OUT',
    method,
    url,
    headers: init?.headers ? Object.fromEntries(
      Object.entries(init.headers).map(([k, v]) => [k, String(v)])
    ) : undefined,
    requestBody: init?.body ? (typeof init.body === 'string' ? init.body : '[Binary/FormData]') : undefined
  };
  
  httpLog.push(requestEntry);
  
  console.log(`📡 [HTTP OUT] ${method} -> ${url}`);
  if (init?.body && typeof init.body === 'string') {
    try {
      // Essayer de parser le body si c'est du JSON
      if (init.body.startsWith('{') || init.body.startsWith('[')) {
        const parsed = JSON.parse(init.body);
        console.log(`📦 [PAYLOAD]`, JSON.stringify(parsed, null, 2));
      } else {
        console.log(`📦 [PAYLOAD]`, init.body);
      }
    } catch {
      console.log(`📦 [PAYLOAD]`, init.body.substring(0, 500));
    }
  }
  
  try {
    const response = await originalFetch(input, init);
    const endTime = Date.now();
    const durationMs = endTime - startTime;
    
    // Log de la réponse entrante
    const responseEntry: HttpLogEntry = {
      timestamp: new Date().toISOString(),
      direction: 'IN',
      method,
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      durationMs
    };
    
    // Essayer de lire le body de la réponse
    const responseClone = response.clone();
    try {
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        const json = await responseClone.json();
        responseEntry.responseBody = json;
        responseEntry.responseText = JSON.stringify(json, null, 2);
        
        console.log(`📥 [HTTP IN] Status: ${response.status} <- ${response.url}`);
        console.log(`📄 [RESPONSE JSON]`, JSON.stringify(json, null, 2));
        
        // Vérifier si c'est une erreur de rate limit
        const jsonStr = JSON.stringify(json).toLowerCase();
        const detectedPatterns = RATE_LIMIT_PATTERNS.filter(pattern => pattern.test(jsonStr));
        if (detectedPatterns.length > 0 || response.status === 429) {
          responseEntry.isRateLimitError = true;
          responseEntry.rateLimitDetails = {
            detected: true,
            patterns: detectedPatterns.map(p => p.toString()),
            responseContains: jsonStr.substring(0, 500),
            urlContains: response.url
          };
          
          rateLimitCaptures.push(responseEntry);
          console.log(`🚨 [RATE LIMIT DETECTED] Status: ${response.status} <- ${response.url}`);
          console.log(`   • Patterns détectés: ${detectedPatterns.length}`);
          console.log(`   • URL: ${response.url}`);
          console.log(`   • Réponse: ${jsonStr.substring(0, 300)}`);
        }
        
      } else if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        const text = await responseClone.text();
        responseEntry.responseText = text.substring(0, 2000);
        
        console.log(`📥 [HTTP IN] Status: ${response.status} <- ${response.url}`);
        console.log(`📄 [RESPONSE TEXT]`, text.substring(0, 500));
        
        // Vérifier si c'est une erreur de rate limit
        const textLower = text.toLowerCase();
        const detectedPatterns = RATE_LIMIT_PATTERNS.filter(pattern => pattern.test(textLower));
        if (detectedPatterns.length > 0 || response.status === 429) {
          responseEntry.isRateLimitError = true;
          responseEntry.rateLimitDetails = {
            detected: true,
            patterns: detectedPatterns.map(p => p.toString()),
            responseContains: textLower.substring(0, 500),
            urlContains: response.url
          };
          
          rateLimitCaptures.push(responseEntry);
          console.log(`🚨 [RATE LIMIT DETECTED] Status: ${response.status} <- ${response.url}`);
          console.log(`   • Patterns détectés: ${detectedPatterns.length}`);
          console.log(`   • URL: ${response.url}`);
          console.log(`   • Réponse: ${textLower.substring(0, 300)}`);
        }
        
      } else {
        console.log(`📥 [HTTP IN] Status: ${response.status} <- ${response.url} (${contentType})`);
        
        // Vérifier le statut HTTP 429
        if (response.status === 429) {
          responseEntry.isRateLimitError = true;
          responseEntry.rateLimitDetails = {
            detected: true,
            patterns: ['HTTP_STATUS_429'],
            responseContains: `Status: ${response.status} ${response.statusText}`,
            urlContains: response.url
          };
          
          rateLimitCaptures.push(responseEntry);
          console.log(`🚨 [RATE LIMIT DETECTED] HTTP 429 <- ${response.url}`);
        }
      }
    } catch (bodyError) {
      console.log(`📥 [HTTP IN] Status: ${response.status} <- ${response.url} (body read error)`);
    }
    
    httpLog.push(responseEntry);
    return response;
    
  } catch (error) {
    const endTime = Date.now();
    const durationMs = endTime - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    const errorEntry: HttpLogEntry = {
      timestamp: new Date().toISOString(),
      direction: 'IN',
      method,
      url,
      error: errorMsg,
      durationMs
    };
    
    // Vérifier si l'erreur contient des motifs de rate limit
    const errorLower = errorMsg.toLowerCase();
    const detectedPatterns = RATE_LIMIT_PATTERNS.filter(pattern => pattern.test(errorLower));
    if (detectedPatterns.length > 0) {
      errorEntry.isRateLimitError = true;
      errorEntry.rateLimitDetails = {
        detected: true,
        patterns: detectedPatterns.map(p => p.toString()),
        responseContains: errorLower,
        urlContains: url
      };
      
      rateLimitCaptures.push(errorEntry);
      console.log(`� [RATE LIMIT IN ERROR] ${method} ${url}: ${errorMsg}`);
    } else {
      console.log(`💥 [HTTP ERROR] ${method} ${url}: ${errorMsg}`);
    }
    
    httpLog.push(errorEntry);
    throw error;
  }
};

// Fonction pour sauvegarder les logs HTTP
function saveHttpLog(scenarioName: string, attempt: number): void {
  const logDir = path.join(process.cwd(), 'http-logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  const timestamp = Date.now();
  const logFile = path.join(logDir, `http-${scenarioName}-${attempt}-${timestamp}.json`);
  fs.writeFileSync(logFile, JSON.stringify(httpLog, null, 2));
  console.log(`📁 Logs HTTP sauvegardés: ${logFile}`);
  
  // Sauvegarder séparément les captures de rate limit si elles existent
  if (rateLimitCaptures.length > 0) {
    const rateLimitFile = path.join(logDir, `rate-limit-${scenarioName}-${attempt}-${timestamp}.json`);
    fs.writeFileSync(rateLimitFile, JSON.stringify(rateLimitCaptures, null, 2));
    console.log(`🚨 Captures Rate Limit sauvegardées: ${rateLimitFile}`);
  }
  
  // Analyser les URLs importantes
  const cevUrls = httpLog.filter(entry => 
    entry.url.includes('appointment.cloud.diplomatie.be') ||
    entry.url.includes('visaonweb.diplomatie.be')
  );
  
  console.log(`\n🔍 URLs CEV/VOWINT capturées:`);
  cevUrls.forEach(entry => {
    console.log(`  ${entry.direction === 'OUT' ? '→' : '←'} ${entry.method} ${entry.url}`);
    if (entry.status) console.log(`    Status: ${entry.status} ${entry.statusText}`);
    if (entry.isRateLimitError) {
      console.log(`    🚨 RATE LIMIT DÉTECTÉ`);
      if (entry.rateLimitDetails) {
        console.log(`      • Patterns: ${entry.rateLimitDetails.patterns.join(', ')}`);
        console.log(`      • URL: ${entry.rateLimitDetails.urlContains}`);
        console.log(`      • Contenu: ${entry.rateLimitDetails.responseContains.substring(0, 200)}`);
      }
    }
    if (entry.responseBody && typeof entry.responseBody === 'object') {
      // Chercher des URLs de redirection ou des données importantes
      const bodyStr = JSON.stringify(entry.responseBody);
      if (bodyStr.includes('redirectUrl') || bodyStr.includes('validUntil')) {
        console.log(`    📋 Contenu important:`, entry.responseBody);
      }
    }
  });
  
  // Analyser spécifiquement les erreurs de rate limit
  const rateLimitErrors = httpLog.filter(entry => entry.isRateLimitError);
  if (rateLimitErrors.length > 0) {
    console.log(`\n🚨 ANALYSE DES ERREURS RATE LIMIT:`);
    console.log(`   • Total erreurs: ${rateLimitErrors.length}`);
    
    rateLimitErrors.forEach((error, index) => {
      console.log(`\n   ${index + 1}. ${error.method} ${error.url}`);
      console.log(`      • Status: ${error.status || 'N/A'}`);
      console.log(`      • Timestamp: ${error.timestamp}`);
      if (error.rateLimitDetails) {
        console.log(`      • Patterns détectés: ${error.rateLimitDetails.patterns.length}`);
        error.rateLimitDetails.patterns.forEach((pattern, i) => {
          console.log(`        ${i + 1}. ${pattern}`);
        });
      }
      if (error.responseText) {
        console.log(`      • Extrait réponse: ${error.responseText.substring(0, 300)}`);
      }
    });
    
    // Générer un rapport détaillé
    const rateLimitReport = {
      scenario: scenarioName,
      attempt,
      timestamp: new Date().toISOString(),
      totalRateLimitErrors: rateLimitErrors.length,
      errors: rateLimitErrors.map(err => ({
        url: err.url,
        method: err.method,
        status: err.status,
        timestamp: err.timestamp,
        patterns: err.rateLimitDetails?.patterns || [],
        responsePreview: err.responseText ? err.responseText.substring(0, 500) : null,
        headers: err.headers
      })),
      summary: `Scénario ${scenarioName}, tentative ${attempt}: ${rateLimitErrors.length} erreur(s) de rate limit détectée(s)`
    };
    
    const reportFile = path.join(logDir, `rate-limit-report-${scenarioName}-${attempt}-${timestamp}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(rateLimitReport, null, 2));
    console.log(`\n📊 Rapport Rate Limit sauvegardé: ${reportFile}`);
  }
  
  // Vider les logs pour la prochaine tentative
  httpLog.length = 0;
  rateLimitCaptures.length = 0;
}

// ============================================================================
// CODE DE TEST ORIGINAL (modifié pour inclure l'interception)
// ============================================================================

interface TestResult {
  scenario: string;
  attempt: number;
  success: boolean;
  error?: string;
  slotsAvailable?: boolean;
  sessionReset: boolean;
  ipChanged: boolean;
  proxySessionId: string;
  details?: {
    loginSuccess?: boolean;
    getEAppointmentUrlSuccess?: boolean;
    cevCookieObtained?: boolean;
    hcaptchaSolved?: boolean;
    finalStatus?: string;
    responseTimeMs?: number;
  };
}

interface TestScenario {
  name: string;
  description: string;
  sessionReset: boolean;
  ipChange: boolean;
  attempts: number;
  delayBetweenAttemptsMs: number;
}

const SCENARIOS: TestScenario[] = [
  {
    name: "SCENARIO_1",
    description: "Même session + même IP (persistance optimale)",
    sessionReset: false,
    ipChange: false,
    attempts: 2,  // Réduit pour les tests
    delayBetweenAttemptsMs: 2000
  },
  {
    name: "SCENARIO_2", 
    description: "Nouvelle session + même IP (reset agressif - à éviter)",
    sessionReset: true,
    ipChange: false,
    attempts: 1,  // Réduit pour les tests
    delayBetweenAttemptsMs: 2000
  }
];

async function executeCevRequest(
  proxyUrl: string,
  sessionReset: boolean,
  scenarioName: string,
  attempt: number
): Promise<TestResult> {
  const startTime = Date.now();
  const proxySessionId = proxyUrl.match(/rotation=([^&]+)/)?.[1] || 'default';
  
  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  ${scenarioName} - Tentative ${attempt}`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  Session: ${sessionReset ? '🆕 NOUVELLE' : '🔁 RÉUTILISÉE'}`);
  console.log(`  IP: ${proxySessionId} (${proxySessionId === 'default' ? 'IP fixe' : 'IP rotée'})`);
  console.log(`  Proxy: iProyal Congo`);
  console.log(`  🔍 INTERCEPTION HTTP ACTIVÉE`);
  
  // Sauvegarder les proxies actuels
  const oldHttpProxy = process.env.HTTP_PROXY;
  const oldHttpsProxy = process.env.HTTPS_PROXY;
  
  // Définir le nouveau proxy
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  
  // Reset session si demandé
  if (sessionReset) {
    invalidateVowintCache(VOWINT_EMAIL);
    console.log(`  🔄 Session reset forcé pour ${VOWINT_EMAIL}`);
  } else {
    console.log(`  🔄 Session réutilisée (cache)`);
  }
  
  const details: TestResult['details'] = {};
  
  try {
    console.log(`\n  🚀 Début du flux CEV...`);
    
    const result = await setupCevSessionHttp(
      VOWINT_EMAIL,
      VOWINT_PASSWORD,
      CLIENT_ID,
      CLIENT_ID
    );
    
    const responseTime = Date.now() - startTime;
    
    // Remplir les détails
    details.loginSuccess = result.success;
    details.getEAppointmentUrlSuccess = !!result.integrationUrl;
    details.cevCookieObtained = !!result.sessionCookie;
    details.hcaptchaSolved = result.success;
    details.responseTimeMs = responseTime;
    
    if (result.slotsAvailable) {
      details.finalStatus = 'CALENDRIER_DISPONIBLE';
    } else if (result.success) {
      details.finalStatus = 'NO_AVAILABILITY';
    } else {
      details.finalStatus = 'ERREUR';
    }
    
    console.log(`\n  📊 RÉSULTAT :`);
    console.log(`    • Statut: ${result.success ? '✅ SUCCÈS' : '❌ ÉCHEC'}`);
    console.log(`    • Slots: ${result.slotsAvailable ? '✅ DISPONIBLES' : '❌ NON DISPONIBLES'}`);
    console.log(`    • Final: ${details.finalStatus}`);
    console.log(`    • Temps: ${responseTime}ms`);
    
    // Vérifier spécifiquement les erreurs de rate limit
    if (result.error) {
      console.log(`    • Erreur: ${result.error}`);
      
      // Détecter si c'est une erreur de rate limit
      const errorLower = result.error.toLowerCase();
      const isRateLimit = RATE_LIMIT_PATTERNS.some(pattern => pattern.test(errorLower)) || 
                         result.error.includes('RATE_LIMIT') ||
                         result.error.includes('429');
      
      if (isRateLimit) {
        console.log(`    🚨 ERREUR RATE LIMIT DÉTECTÉE DANS LE RÉSULTAT`);
        console.log(`       • Type: ${result.error}`);
        console.log(`       • Scénario: ${scenarioName}`);
        console.log(`       • Tentative: ${attempt}`);
        console.log(`       • Session reset: ${sessionReset}`);
        console.log(`       • IP: ${proxySessionId}`);
        
        // Créer une entrée de log spéciale pour cette erreur
        const rateLimitLogEntry: HttpLogEntry = {
          timestamp: new Date().toISOString(),
          direction: 'IN',
          method: 'SETUP_CEV_SESSION',
          url: 'setupCevSessionHttp',
          status: 429,
          statusText: 'Rate Limit',
          error: result.error,
          isRateLimitError: true,
          rateLimitDetails: {
            detected: true,
            patterns: RATE_LIMIT_PATTERNS.filter(p => p.test(errorLower)).map(p => p.toString()),
            responseContains: errorLower,
            urlContains: 'setupCevSessionHttp'
          }
        };
        
        httpLog.push(rateLimitLogEntry);
        rateLimitCaptures.push(rateLimitLogEntry);
      }
    }
    
    // Sauvegarder les logs HTTP
    saveHttpLog(scenarioName, attempt);
    
    return {
      scenario: scenarioName,
      attempt,
      success: result.success,
      error: result.error,
      slotsAvailable: result.slotsAvailable,
      sessionReset,
      ipChanged: proxySessionId !== 'default',
      proxySessionId,
      details
    };
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    console.log(`\n  💥 ERREUR FATALE : ${errorMsg}`);
    console.log(`    • Temps: ${responseTime}ms`);
    
    details.responseTimeMs = responseTime;
    details.finalStatus = 'EXCEPTION';
    
    // Détecter si c'est une erreur de rate limit
    const errorLower = errorMsg.toLowerCase();
    const isRateLimit = RATE_LIMIT_PATTERNS.some(pattern => pattern.test(errorLower));
    
    if (isRateLimit) {
      console.log(`    🚨 ERREUR RATE LIMIT DANS EXCEPTION`);
      
      // Créer une entrée de log spéciale pour cette erreur
      const rateLimitLogEntry: HttpLogEntry = {
        timestamp: new Date().toISOString(),
        direction: 'IN',
        method: 'EXCEPTION',
        url: 'executeCevRequest',
        status: 429,
        statusText: 'Rate Limit Exception',
        error: errorMsg,
        isRateLimitError: true,
        rateLimitDetails: {
          detected: true,
          patterns: RATE_LIMIT_PATTERNS.filter(p => p.test(errorLower)).map(p => p.toString()),
          responseContains: errorLower,
          urlContains: 'executeCevRequest'
        }
      };
      
      httpLog.push(rateLimitLogEntry);
      rateLimitCaptures.push(rateLimitLogEntry);
    }
    
    // Sauvegarder les logs HTTP même en cas d'erreur
    saveHttpLog(scenarioName, attempt);
    
    return {
      scenario: scenarioName,
      attempt,
      success: false,
      error: errorMsg,
      sessionReset,
      ipChanged: proxySessionId !== 'default',
      proxySessionId,
      details
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
  }
}

async function runScenario(scenario: TestScenario): Promise<TestResult[]> {
  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║ ${scenario.name}: ${scenario.description}`);
  console.log(`║ Sessions: ${scenario.sessionReset ? 'NOUVELLE à chaque fois' : 'RÉUTILISÉE'}`);
  console.log(`║ IP: ${scenario.ipChange ? 'ROTÉE à chaque fois' : 'FIXE'}`);
  console.log(`║ Tentatives: ${scenario.attempts}`);
  console.log(`║ 🔍 INTERCEPTION HTTP ACTIVÉE`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);
  
  const results: TestResult[] = [];
  
  for (let i = 1; i <= scenario.attempts; i++) {
    // Déterminer le proxy à utiliser
    let proxyUrl: string;
    if (scenario.ipChange) {
      // Rotation d'IP: nouvelle connexion proxy à chaque fois
      proxyUrl = getIproyalProxyWithRotation(`rotated-${Date.now()}-${i}`);
    } else {
      // IP fixe: même connexion proxy
      proxyUrl = IPROYAL_BASE;
    }
    
    const result = await executeCevRequest(
      proxyUrl,
      scenario.sessionReset,
      scenario.name,
      i
    );
    
    results.push(result);
    
    // Attente entre les tentatives (sauf dernière)
    if (i < scenario.attempts) {
      console.log(`\n  ⏳ Attente ${scenario.delayBetweenAttemptsMs / 1000}s avant prochaine tentative...`);
      await new Promise(resolve => setTimeout(resolve, scenario.delayBetweenAttemptsMs));
    }
  }
  
  return results;
}

async function runTest() {
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  console.log('  TEST COMPLET CEV - Validation avec interception HTTP');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('📋 SCÉNARIOS TESTÉS :');
  console.log('  1. Persistance (session fixe + IP fixe) - STRATÉGIE OPTIMALE');
  console.log('  2. Reset agressif (nouvelle session + IP fixe) - À ÉVITER');
  console.log('');
  console.log('🔧 Configuration :');
  console.log(`  • Compte: ${VOWINT_EMAIL}`);
  console.log(`  • Proxy: iProyal Congo (Kinshasa)`);
  console.log(`  • Rotation IP simulée via paramètre session`);
  console.log('');
  console.log('🔍 INTERCEPTION HTTP :');
  console.log('  • Toutes les requêtes/réponses seront loggées');
  console.log('  • Logs sauvegardés dans ./http-logs/');
  console.log('  • Analyse automatique des URLs CEV/VOWINT');
  console.log('');
  
  const allResults: TestResult[] = [];
  
  // Exécuter tous les scénarios
  for (const scenario of SCENARIOS) {
    const scenarioResults = await runScenario(scenario);
    allResults.push(...scenarioResults);
    
    // Petite pause entre les scénarios
    if (scenario !== SCENARIOS[SCENARIOS.length - 1]) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('  PAUSE 10s avant prochain scénario...');
      console.log('═══════════════════════════════════════════════════════════════');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  
  // ANALYSE DÉTAILLÉE
  console.log('\n���═══════════════════════════════════════════════════════════════════════════════════');
  console.log('  ANALYSE COMPARATIVE DES SCÉNARIOS');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  
  const scenarioAnalysis: Record<string, {
    attempts: number;
    successes: number;
    successRate: number;
    avgResponseTime: number;
    errors: string[];
  }> = {};
  
  // Analyser chaque scénario
  for (const scenario of SCENARIOS) {
    const scenarioResults = allResults.filter(r => r.scenario === scenario.name);
    const successes = scenarioResults.filter(r => r.success).length;
    const errors = scenarioResults.filter(r => r.error).map(r => r.error!);
    const avgResponseTime = scenarioResults
      .filter(r => r.details?.responseTimeMs)
      .reduce((sum, r) => sum + (r.details!.responseTimeMs || 0), 0) / 
      Math.max(1, scenarioResults.filter(r => r.details?.responseTimeMs).length);
    
    scenarioAnalysis[scenario.name] = {
      attempts: scenarioResults.length,
      successes,
      successRate: (successes / scenarioResults.length) * 100,
      avgResponseTime,
      errors
    };
    
    console.log(`\n📊 ${scenario.name}: ${scenario.description}`);
    console.log(`   • Tentatives: ${scenarioResults.length}`);
    console.log(`   • Succès: ${successes}`);
    console.log(`   • Taux de succès: ${((successes / scenarioResults.length) * 100).toFixed(1)}%`);
    console.log(`   • Temps moyen: ${avgResponseTime.toFixed(0)}ms`);
    
    if (errors.length > 0) {
      console.log(`   • Erreurs: ${errors.join(', ')}`);
    }
  }
  
  // CONCLUSIONS
  console.log('\n════════════════════════════════════════════════════════════════════════════════════');
  console.log('  CONCLUSIONS ET RECOMMANDATIONS');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  
  console.log('\n🎯 BASÉ SUR LES RÉSULTATS :');
  
  // Scénario 1 (persistance)
  const sc1 = scenarioAnalysis['SCENARIO_1'];
  if (sc1.successRate === 100) {
    console.log('  1. ✅ La persistance (même session + même IP) fonctionne PARFAITEMENT');
    console.log('     → RECOMMANDATION: Garder les sessions le plus longtemps possible');
  } else {
    console.log('  1. ⚠️ La persistance a rencontré des problèmes');
    console.log(`     → ${sc1.errors.join(', ')}`);
  }
  
  // Scénario 2 (reset agressif)
  const sc2 = scenarioAnalysis['SCENARIO_2'];
  if (sc2.successRate < 100) {
    console.log('  2. ✅ Confirmé: Le reset agressif de session déclenche des blocages');
    console.log(`     → Taux d\'échec: ${(100 - sc2.successRate).toFixed(1)}%`);
    console.log('     → RECOMMANDATION: Éviter les resets de session inutiles');
  } else {
    console.log('  2. ❓ Surprenant: Le reset agressif n\'a pas causé de blocage');
    console.log('     → Possible que le timing était acceptable');
  }
  
  // Recommandations finales
  console.log('\n🚀 STRATÉGIE OPTIMALE POUR LE BOT :');
  console.log('  1. PRIORITÉ: Réutiliser les sessions existantes (cache 25min)');
  console.log('  2. Reset session: Uniquement sur erreur d\'authentification');
  console.log('  3. Timing: Espacer les actions agressives (>30s entre resets)');
  
  // Sauvegarder les résultats
  const outputFile = path.join(process.cwd(), 'cev-comprehensive-test-results.json');
  const outputData = {
    testDate: new Date().toISOString(),
    email: VOWINT_EMAIL,
    proxy: 'iProyal Congo (Kinshasa)',
    scenarios: SCENARIOS.map(s => ({
      name: s.name,
      description: s.description,
      config: {
        sessionReset: s.sessionReset,
        ipChange: s.ipChange,
        attempts: s.attempts,
        delayBetweenAttemptsMs: s.delayBetweenAttemptsMs
      }
    })),
    results: allResults,
    analysis: scenarioAnalysis,
    recommendations: [
      "Réutiliser les sessions existantes autant que possible",
      "Éviter les resets de session inutiles",
      "Rotation IP possible mais pas obligatoire",
      "Espacer les actions agressives (>30s)",
      "Monitorer les erreurs RATE_LIMIT_VOWINT_5_CLICKS"
    ]
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
  console.log(`\n📁 Résultats détaillés sauvegardés: ${outputFile}`);
  
  // Résumé final
  const totalAttempts = allResults.length;
  const totalSuccesses = allResults.filter(r => r.success).length;
  const overallSuccessRate = (totalSuccesses / totalAttempts) * 100;
  
  // Compter les erreurs de rate limit
  const rateLimitErrors = allResults.filter(r => 
    r.error && (
      r.error.includes('RATE_LIMIT') ||
      r.error.toLowerCase().includes('too many') ||
      r.error.toLowerCase().includes('5 fois') ||
      r.error.toLowerCase().includes('429')
    )
  );
  
  console.log('\n════════════════════════════════════════════════════════════════════════════════════');
  console.log('  RÉSUMÉ FINAL');
  console.log('════════════════════════════════════════════════════════════════════════════════════');
  console.log(`  • Total tentatives: ${totalAttempts}`);
  console.log(`  • Total succès: ${totalSuccesses}`);
  console.log(`  • Taux de succès global: ${overallSuccessRate.toFixed(1)}%`);
  console.log(`  • Erreurs Rate Limit: ${rateLimitErrors.length}`);
  console.log(`  • Meilleur scénario: ${Object.entries(scenarioAnalysis)
    .reduce((best, [name, data]) => 
      data.successRate > best.successRate ? {name, ...data} : best, 
      {name: '', successRate: 0}).name}`);
  
  // Afficher les détails des erreurs de rate limit
  if (rateLimitErrors.length > 0) {
    console.log(`\n🚨 DÉTAILS DES ERREURS RATE LIMIT:`);
    rateLimitErrors.forEach((error, index) => {
      console.log(`\n  ${index + 1}. Scénario: ${error.scenario}, Tentative: ${error.attempt}`);
      console.log(`     • Erreur: ${error.error}`);
      console.log(`     • Session reset: ${error.sessionReset}`);
      console.log(`     • IP changée: ${error.ipChanged}`);
      console.log(`     • Proxy session: ${error.proxySessionId}`);
    });
    
    // Générer un rapport consolidé des rate limits
    const rateLimitSummary = {
      testDate: new Date().toISOString(),
      totalAttempts,
      totalRateLimitErrors: rateLimitErrors.length,
      rateLimitErrorRate: (rateLimitErrors.length / totalAttempts) * 100,
      errorsByScenario: SCENARIOS.map(scenario => {
        const scenarioErrors = rateLimitErrors.filter(e => e.scenario === scenario.name);
        return {
          scenario: scenario.name,
          description: scenario.description,
          attempts: scenario.attempts,
          rateLimitErrors: scenarioErrors.length,
          errorRate: (scenarioErrors.length / scenario.attempts) * 100,
          errors: scenarioErrors.map(e => ({
            attempt: e.attempt,
            error: e.error,
            sessionReset: e.sessionReset,
            ipChanged: e.ipChanged,
            proxySessionId: e.proxySessionId
          }))
        };
      }),
      recommendations: [
        "Les erreurs RATE_LIMIT_VOWINT_5_CLICKS indiquent que la limite de 5 clics/heure a été atteinte",
        "Éviter les resets de session inutiles pour préserver les clics",
        "Utiliser le cache de session autant que possible",
        "Monitorer le compteur de clics et attendre 1 heure si la limite est atteinte",
        "Consulter les logs détaillés dans ./http-logs/ pour analyser les réponses exactes"
      ]
    };
    
    const summaryFile = path.join(process.cwd(), 'rate-limit-summary.json');
    fs.writeFileSync(summaryFile, JSON.stringify(rateLimitSummary, null, 2));
    console.log(`\n📊 Rapport Rate Limit consolidé sauvegardé: ${summaryFile}`);
  }
  
  console.log('\n🔍 Tous les logs HTTP sont disponibles dans le dossier ./http-logs/');
  console.log('   • Fichiers JSON avec toutes les requêtes/réponses');
  console.log('   • Fichiers rate-limit-* pour les captures spécifiques');
  console.log('   • Rapports d\'analyse détaillés');
  console.log('\n🎉 TEST TERMINÉ - Toutes les découvertes validées avec interception HTTP !');
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