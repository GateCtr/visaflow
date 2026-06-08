/**
 * CEV Network Sniffer - Capture complète du trafic réseau humain vs bot
 *
 * OBJECTIF :
 *   Lancer un navigateur Playwright en mode visible, intercepter TOUTES les requêtes réseau
 *   pendant une navigation humaine, puis sauvegarder les données pour analyse comparative.
 *
 * FONCTIONNALITÉS :
 *   - Navigateur Playwright visible (headless: false), centré, 1366x768
 *   - Key-listener terminal pour attendre ENTER (fin de navigation)
 *   - Interception complète réseau (y compris iframes, popups, hCaptcha)
 *   - Capture détaillée : URL, méthode, initiateur, headers (ordre exact), cookies, payloads, réponses
 *   - Sauvegarde chronologique en JSON dans debug_dumps/
 *
 * UTILISATION :
 *   npx tsx src/debug/cev-network-sniffer.ts
 *   -> Naviguer manuellement sur le site CEV
 *   -> Appuyer sur ENTER dans le terminal pour terminer
 *   -> Les données sont sauvegardées dans artifacts/slot-hunter/debug_dumps/
 */

import { chromium, type Browser, type Page, type BrowserContext, type Request, type Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Variables globales pour gérer l'état du script
let isSaving = false;
let isTerminating = false;

// ─── Configuration ───────────────────────────────────────────────────────────────

const WINDOW_WIDTH = 1366;
const WINDOW_HEIGHT = 768;

// Calculer le répertoire de debug de manière dynamique
// Utilisation de process.cwd() qui fonctionne avec tsx et CommonJS
const PROJECT_ROOT = path.join(process.cwd(), '..', '..');
const DEBUG_DUMP_DIR = path.join(PROJECT_ROOT, 'debug_dumps');

// ─── Types pour la capture réseau ───────────────────────────────────────────────

interface NetworkRequest {
  id: string;
  timestamp: number;
  url: string;
  method: string;
  initiator?: string;
  resourceType: string;
  frameId?: string;
  frameUrl?: string;
  parentFrameUrl?: string;
  isPopup?: boolean;
  isIframe?: boolean;
  
  // Headers
  requestHeaders: Record<string, string>;
  requestHeadersOrder: string[];
  
  // Cookies
  requestCookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number | -1;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  
  // Payload
  requestBody?: string;
  requestBodyType?: 'string' | 'formData' | 'json';
  
  // Response
  responseStatus: number;
  responseStatusText: string;
  responseHeaders: Record<string, string>;
  responseHeadersOrder: string[];
  responseHeadersText?: string;
  responseBody?: string;
  responseSize?: number;
  
  // Timing
  timing?: {
    requestStartTime: number;
    responseStartTime: number;
    endTime: number;
    duration: number;
  };
  
  // Security
  securityDetails?: {
    protocol: string;
    subjectName: string;
    issuer: string;
    validFrom: number;
    validTo: number;
  };
}

interface CaptureSession {
  sessionId: string;
  startTime: number;
  endTime: number;
  userAgent: string;
  viewport: { width: number; height: number };
  requests: NetworkRequest[];
  summary: {
    totalRequests: number;
    byMethod: Record<string, number>;
    byResourceType: Record<string, number>;
    byDomain: Record<string, number>;
    captchaRequests: string[];
    f5Cookies: string[];
    aspNetSessionCookies: string[];
  };
}

// ─── État global de la capture ─────────────────────────────────────────────────

let captureSession: CaptureSession = {
  sessionId: '',
  startTime: 0,
  endTime: 0,
  userAgent: '',
  viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
  requests: [],
  summary: {
    totalRequests: 0,
    byMethod: {},
    byResourceType: {},
    byDomain: {},
    captchaRequests: [],
    f5Cookies: [],
    aspNetSessionCookies: [],
  },
};

let requestCounter = 0;
let browser: Browser | null = null;
let context: BrowserContext | null = null;

// Map pour stocker les données de capture par ID de requête
const requestCaptureMap = new Map<string, NetworkRequest>();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generateRequestId(): string {
  return `req_${Date.now()}_${++requestCounter}`;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function isCaptchaRequest(url: string): boolean {
  const captchaPatterns = [
    'hcaptcha.com',
    'h-captcha',
    'captcha',
    'api.js',
    'challenge.js',
  ];
  return captchaPatterns.some(pattern => url.toLowerCase().includes(pattern));
}

function isF5Cookie(cookieName: string): boolean {
  return cookieName.startsWith('TS') || cookieName.startsWith('BIGip');
}

function isAspNetSessionCookie(cookieName: string): boolean {
  return cookieName === 'ASP.NET_SessionId';
}

// ─── Handlers partagés requête / réponse ────────────────────────────────────────

/**
 * Traite une requête entrante (appelé depuis context OU page listener).
 * La déduplication est assurée par __captureId attaché à l'objet request.
 */
async function handleRequest(request: Request, sourcePage?: Page): Promise<void> {
  // Déduplication : si cet objet request a déjà été traité, on skip
  if ((request as any).__captureId) return;

  try {
    const requestId = generateRequestId();
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();

    console.log(`[REQUEST] [${resourceType.toUpperCase()}] ${method} ${url.slice(0, 80)}`);

    let headersOrder: string[] = [];
    let headersMap: Record<string, string> = {};
    try {
      const headersArray = await request.headersArray();
      headersOrder = headersArray.map((h: any) => h.name);
      headersArray.forEach((h: any) => { headersMap[h.name.toLowerCase()] = h.value; });
    } catch {
      try {
        const fallbackHeaders = request.headers();
        headersOrder = Object.keys(fallbackHeaders);
        Object.keys(fallbackHeaders).forEach(k => { headersMap[k.toLowerCase()] = fallbackHeaders[k]; });
      } catch { /* page morte */ }
    }

    let requestCookies: NetworkRequest['requestCookies'] = [];
    try {
      const cookies = await context?.cookies() || [];
      requestCookies = cookies.map((c: any) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite as any,
      }));
    } catch { /* navigateur fermé */ }

    let requestBody: string | undefined;
    let requestBodyType: 'string' | 'formData' | 'json' | undefined;
    try {
      const postData = request.postData();
      if (postData) {
        requestBody = postData;
        requestBodyType = 'string';
        try { JSON.parse(postData); requestBodyType = 'json'; } catch {}
        if (postData.includes('=') && postData.includes('&') || postData.includes('captcha=')) requestBodyType = 'formData';
      }
    } catch { /* postData indisponible */ }

    const frame = request.frame();
    const networkRequest: NetworkRequest = {
      id: requestId,
      timestamp: Date.now(),
      url, method, resourceType,
      frameUrl: frame?.url(),
      parentFrameUrl: frame?.parentFrame()?.url(),
      isIframe: (frame?.parentFrame() ?? null) !== null,
      isPopup: sourcePage ? sourcePage.mainFrame() !== frame && !frame?.parentFrame() : false,
      requestHeaders: headersMap,
      requestHeadersOrder: headersOrder,
      requestCookies,
      requestBody,
      requestBodyType,
      responseStatus: 0,
      responseStatusText: 'pending',
      responseHeaders: {},
      responseHeadersOrder: [],
    } as any;

    requestCaptureMap.set(requestId, networkRequest);
    (request as any).__captureId = requestId;

    // Log prioritaire pour les requêtes cibles (diff analyse)
    if (url.includes('SetCaptchaToken') || url.includes('Integration/VOW') || url.includes('Integration/Error')) {
      console.log(`\n🎯 [CIBLE] ${method} ${url}`);
      console.log(`   Headers order: ${headersOrder.join(', ')}`);
      if (requestBody) console.log(`   Body: ${requestBody.slice(0, 200)}`);
    }
  } catch (error) {
    console.log(`[REQUEST-ERROR] ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Traite une réponse (appelé depuis context OU page listener).
 */
async function handleResponse(response: Response): Promise<void> {
  try {
    const request = response.request();
    const captureId = (request as any).__captureId;
    let captureData: NetworkRequest | undefined;

    if (captureId) {
      captureData = requestCaptureMap.get(captureId);
    }
    if (!captureData) {
      const url = response.url();
      const method = request.method();
      for (const [, req] of requestCaptureMap) {
        if (req.url === url && req.method === method && req.responseStatus === 0) {
          captureData = req;
          break;
        }
      }
    }
    if (!captureData) return;

    const url = response.url();
    const status = response.status();

    let responseHeadersOrder: string[] = [];
    let responseHeadersMap: Record<string, string> = {};
    try {
      const arr = await response.headersArray();
      responseHeadersOrder = arr.map((h: any) => h.name);
      arr.forEach((h: any) => { responseHeadersMap[h.name.toLowerCase()] = h.value; });
    } catch {
      try {
        const fb = response.headers();
        responseHeadersOrder = Object.keys(fb);
        Object.keys(fb).forEach(k => { responseHeadersMap[k.toLowerCase()] = fb[k]; });
      } catch {}
    }

    let responseBody: string | undefined;
    let responseSize: number | undefined;
    try {
      const buffer = await response.body();
      responseSize = buffer.length;
      const ct = responseHeadersMap['content-type'] || '';
      if (ct.includes('json') || ct.includes('text') || ct.includes('form')) {
        responseBody = buffer.toString('utf-8');
      }
    } catch { /* buffer indisponible */ }

    captureData.responseStatus = status;
    captureData.responseStatusText = status.toString();
    captureData.responseHeaders = responseHeadersMap;
    captureData.responseHeadersOrder = responseHeadersOrder;
    captureData.responseHeadersText = JSON.stringify(responseHeadersMap, null, 2);
    captureData.responseBody = responseBody;
    captureData.responseSize = responseSize;
    captureData.timing = {
      requestStartTime: captureData.timestamp,
      responseStartTime: Date.now(),
      endTime: Date.now(),
      duration: Date.now() - captureData.timestamp,
    };

    captureSession.requests.push(captureData);
    captureSession.summary.totalRequests++;
    captureSession.summary.byMethod[captureData.method] = (captureSession.summary.byMethod[captureData.method] || 0) + 1;
    captureSession.summary.byResourceType[captureData.resourceType] = (captureSession.summary.byResourceType[captureData.resourceType] || 0) + 1;

    const domain = extractDomain(url);
    captureSession.summary.byDomain[domain] = (captureSession.summary.byDomain[domain] || 0) + 1;
    if (isCaptchaRequest(url)) captureSession.summary.captchaRequests.push(url);

    captureData.requestCookies.forEach(cookie => {
      if (isF5Cookie(cookie.name) && !captureSession.summary.f5Cookies.includes(cookie.name))
        captureSession.summary.f5Cookies.push(cookie.name);
      if (isAspNetSessionCookie(cookie.name) && !captureSession.summary.aspNetSessionCookies.includes(cookie.value))
        captureSession.summary.aspNetSessionCookies.push(cookie.value);
    });

    if (captureId) requestCaptureMap.delete(captureId);

    // Log prioritaire pour les requêtes cibles
    if (url.includes('SetCaptchaToken') || url.includes('Integration/VOW') || url.includes('Integration/Error')) {
      console.log(`\n✅ [CIBLE RÉPONSE] ${status} ${url}`);
      if (responseBody) console.log(`   Body: ${responseBody.slice(0, 300)}`);
    }

    console.log(`[RESPONSE] ${status} ${url.slice(0, 80)} (${captureData.timing?.duration || 0}ms)`);
  } catch (error) {
    console.log(`[RESPONSE-ERROR] ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Capture au niveau CONTEXT (attrape toutes les pages + popups) ───────────────

/**
 * Attache les listeners request/response au niveau du BrowserContext.
 * Cela garantit que SetCaptchaToken, Integration/VOW et toutes les requêtes
 * émises depuis les popups AVANT setupNetworkInterception sont capturées.
 */
function setupContextInterception(ctx: BrowserContext): void {
  console.log('[DEBUG] Attachement listeners context-level (toutes pages + popups)');

  ctx.on('request', async (request: Request) => {
    await handleRequest(request);
  });

  ctx.on('response', async (response: Response) => {
    await handleResponse(response);
  });
}

// ─── Capture par page (fallback / logs page-level) ──────────────────────────────

async function setupNetworkInterception(page: Page): Promise<void> {
  console.log(`[DEBUG] Setup page-level interception: ${page.url() || 'new page'}`);

  // Les listeners context-level capturent déjà tout — on ajoute ici uniquement
  // les listeners page-level pour éviter les doublons via la déduplication __captureId.
  page.on('request', async (request: Request) => {
    await handleRequest(request, page);
  });

  page.on('response', async (response: Response) => {
    await handleResponse(response);
  });
}

// ─── Sauvegarde des données ─────────────────────────────────────────────────────

async function saveCaptureData(): Promise<void> {
  if (isSaving) {
    console.log('\n⚠️  Déjà en train de sauvegarder les données...');
    return;
  }
  
  isSaving = true;
  
  try {
    captureSession.endTime = Date.now();
    
    // Créer le répertoire de dump si nécessaire
    if (!fs.existsSync(DEBUG_DUMP_DIR)) {
      fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
    }
    
    // Nom de fichier avec timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `cev-capture-${timestamp}.json`;
    const filepath = path.join(DEBUG_DUMP_DIR, filename);
    
    // Sauvegarder la session complète
    fs.writeFileSync(filepath, JSON.stringify(captureSession, null, 2));
    
    console.log(`\n✅ Capture sauvegardée dans : ${filepath}`);
    console.log(`   Total requêtes : ${captureSession.summary.totalRequests}`);
    console.log(`   Requêtes captcha : ${captureSession.summary.captchaRequests.length}`);
    console.log(`   Cookies F5 : ${captureSession.summary.f5Cookies.length}`);
    console.log(`   Cookies ASP.NET : ${captureSession.summary.aspNetSessionCookies.length}`);
    
    // Sauvegarder aussi des fichiers séparés par étape (chronologiquement)
    await saveChronologicalDumps(timestamp);
    
  } catch (error) {
    console.error('\n❌ Erreur lors de la sauvegarde :', error);
    throw error;
  } finally {
    isSaving = false;
  }
}

async function saveChronologicalDumps(baseTimestamp: string): Promise<void> {
  const steps = [
    { name: '01_initial', filter: (r: NetworkRequest) => r.url.includes('visaonweb.diplomatie.be') && r.url.includes('/') },
    { name: '02_login', filter: (r: NetworkRequest) => r.url.includes('Login') || r.url.includes('Account') },
    { name: '03_mylist', filter: (r: NetworkRequest) => r.url.includes('MyList') || r.url.includes('IndexByUserId') },
    { name: '04_geteappointment', filter: (r: NetworkRequest) => r.url.includes('GetEAppointmentUrl') },
    { name: '05_integration', filter: (r: NetworkRequest) => r.url.includes('appointment.cloud.diplomatie.be') && r.url.includes('Integration') },
    { name: '06_captcha', filter: (r: NetworkRequest) => isCaptchaRequest(r.url) },
    { name: '07_setcaptchatoken', filter: (r: NetworkRequest) => r.url.includes('SetCaptchaToken') },
    { name: '08_selectslot', filter: (r: NetworkRequest) => r.url.includes('SelectSlot') },
    { name: '09_availabletimeslots', filter: (r: NetworkRequest) => r.url.includes('AvailableTimeSlots') },
    { name: '10_final', filter: (r: NetworkRequest) => true }, // Toutes les requêtes restantes
  ];
  
  let processedRequests = new Set<string>();
  
  for (const step of steps) {
    const stepRequests = captureSession.requests.filter(r => 
      !processedRequests.has(r.id) && step.filter(r)
    );
    
    if (stepRequests.length > 0) {
      const stepFilename = `${baseTimestamp}-${step.name}.json`;
      const stepFilepath = path.join(DEBUG_DUMP_DIR, stepFilename);
      
      const stepData = {
        stepName: step.name,
        timestamp: Date.now(),
        requestCount: stepRequests.length,
        requests: stepRequests,
      };
      
      fs.writeFileSync(stepFilepath, JSON.stringify(stepData, null, 2));
      console.log(`   Étape sauvegardée : ${stepFilename} (${stepRequests.length} requêtes)`);
      
      stepRequests.forEach(r => processedRequests.add(r.id));
    }
  }
}

// ─── Fonction pour terminer proprement la capture ─────────────────────────────

async function terminateCapture(): Promise<void> {
  if (isTerminating) {
    return;
  }
  
  isTerminating = true;
  
  console.log('\n🛑 Terminaison de la capture en cours...');
  
  try {
    await saveCaptureData();
  } catch (error) {
    console.error('\n❌ Erreur lors de la sauvegarde finale :', error);
  }
  
  try {
    if (browser) {
      await browser.close();
    }
  } catch (error) {
    console.error('\n❌ Erreur lors de la fermeture du navigateur :', error);
  }
  
  console.log('\n✅ Capture terminée avec succès !');
  process.exit(0);
}

// ─── Key Listener pour attendre ENTER ─────────────────────────────────────────────

async function waitForUserAction(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🔍 NAVIGATEUR PRÊT - Navigation humaine en cours...');
  console.log('   1. Connectez-vous à visaonweb.diplomatie.be');
  console.log('   2. Naviguez vers votre dossier');
  console.log('   3. Cliquez sur "Prendre rendez-vous"');
  console.log('   4. Résolvez le captcha');
  console.log('   5. Attendez la réponse finale');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('\n⏳ Options de terminaison :');
  console.log('   • Appuyez sur [ENTER] dans ce terminal');
  console.log('   • Fermez manuellement la fenêtre du navigateur');
  console.log('   • Appuyez sur [Ctrl+C] dans le terminal');
  console.log('\nLa capture sera automatiquement sauvegardée.\n');
  
  // Écouter la fermeture du navigateur
  if (browser) {
    browser.on('disconnected', async () => {
      console.log('\n⚠️  Navigateur fermé manuellement. Sauvegarde des données...');
      rl.close();
      await terminateCapture();
    });
  }
  
  return new Promise((resolve) => {
    rl.on('line', () => {
      console.log('\n⏸️  Entrée utilisateur détectée. Sauvegarde des données...');
      rl.close();
      resolve();
    });
    
    // Gérer SIGINT (Ctrl+C) - une seule fois
    const sigintHandler = async () => {
      console.log('\n⚠️  Signal SIGINT (Ctrl+C) détecté. Sauvegarde des données...');
      // Retirer le handler pour éviter les doubles appels
      process.removeListener('SIGINT', sigintHandler);
      rl.close();
      await terminateCapture();
    };
    
    process.on('SIGINT', sigintHandler);
  });
}

// ─── Fonction principale (CORRIGÉE) ───────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔬 CEV NETWORK SNIFFER - Capture réseau complète');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    captureSession.sessionId = `session_${Date.now()}`;
    captureSession.startTime = Date.now();
    
    console.log('🚀 Lancement du navigateur Playwright...');
    browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized'], // Pas de Blink-features pour l'humain
    });
    
    context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      locale: 'fr-BE',
      timezoneId: 'Europe/Brussels',
    });

    // ── Context-level interception (prioritaire) ──────────────────────────────
    // Attrape TOUTES les requêtes de toutes les pages/popups dès leur création,
    // y compris le POST /Captcha/SetCaptchaToken qui est émis avant que les
    // listeners page-level aient le temps de s'attacher sur le nouvel onglet.
    setupContextInterception(context);

    // Écouter les nouveaux onglets pour les logs page-level (déduplication via __captureId)
    context.on('page', async (newPage: Page) => {
      console.log(`\n🚨 [POPUP] Nouvel onglet : ${newPage.url() || '(en cours de chargement)'}`);
      await setupNetworkInterception(newPage);
    });

    const page = await context.newPage();

    console.log('[DEBUG] Attachement listeners page principale...');
    await setupNetworkInterception(page);
    
    // Récupérer l'user-agent après avoir attaché les listeners
    captureSession.userAgent = await page.evaluate(() => navigator.userAgent);
    console.log(`[DEBUG] User-Agent: ${captureSession.userAgent}`);
    
    console.log('🌐 Navigation vers visaonweb.diplomatie.be...');
    
    // Utiliser 'domcontentloaded' au lieu de 'networkidle' qui peut bloquer indéfiniment
    await page.goto('https://visaonweb.diplomatie.be', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    
    console.log('✅ Navigation terminée. La capture réseau est active.');
    
    // Attendre une action de l'utilisateur
    await waitForUserAction();
    
    // Terminer proprement la capture
    await terminateCapture();
    
  } catch (error) {
    console.error('\n❌ Erreur lors de la capture :', error);
    
    // Essayer de sauvegarder même en cas d'erreur
    try {
      console.log('\n⚠️  Tentative de sauvegarde malgré l\'erreur...');
      await saveCaptureData();
    } catch (saveError) {
      console.error('❌ Impossible de sauvegarder après l\'erreur :', saveError);
    }
    
    try {
      if (browser) {
        await browser.close();
      }
    } catch (closeError) {
      console.error('❌ Erreur lors de la fermeture du navigateur :', closeError);
    }
    
    process.exit(1);
  }
}

// ─── Exécution ─────────────────────────────────────────────────────────────────

// Exécuter main si le fichier est exécuté directement
main().catch(console.error);
