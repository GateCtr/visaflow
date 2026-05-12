/**
 * USA Portal - Session Capture Script
 * 
 * Ce script lance un navigateur Playwright avec capture complète du trafic réseau.
 * Il ouvre le portail USA (ais.usvisa-info.com) et te laisse naviguer manuellement.
 * 
 * TOUT est capturé :
 * - Requêtes HTTP (URL, method, headers, body)
 * - Réponses HTTP (status, headers, body JSON/text)
 * - Cookies
 * - WebSocket frames
 * - Console logs du navigateur
 * - Screenshots à chaque navigation
 * 
 * Les données sont sauvegardées dans: artifacts/slot-hunter/usa-fixe/
 * 
 * Usage: npx tsx scripts/usa-capture-session.ts
 */

import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// === Configuration ===
const USA_PORTAL_URL = 'https://ais.usvisa-info.com/fr-ma/niv/users/sign_in';
const OUTPUT_DIR = path.resolve(import.meta.dirname, '..', 'usa-fixe');
const SESSION_DIR = path.resolve(OUTPUT_DIR, 'session-data');
const HAR_FILE = path.resolve(OUTPUT_DIR, 'usa-session.har');

// === Types ===
interface CapturedRequest {
  timestamp: string;
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  resourceType: string;
}

interface CapturedResponse {
  timestamp: string;
  requestId: number;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  bodySize: number;
  contentType: string | null;
}

interface CapturedWebSocket {
  timestamp: string;
  url: string;
  direction: 'sent' | 'received';
  data: string;
}

interface CapturedConsole {
  timestamp: string;
  type: string;
  text: string;
  location: string;
}

// === State ===
let requestCounter = 0;
const capturedRequests: CapturedRequest[] = [];
const capturedResponses: CapturedResponse[] = [];
const capturedWebSockets: CapturedWebSocket[] = [];
const capturedConsoleLogs: CapturedConsole[] = [];
const capturedCookies: Array<{ timestamp: string; cookies: unknown[] }> = [];
let screenshotCounter = 0;

// === Helpers ===
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function sanitizeFilename(url: string): string {
  return url
    .replace(/https?:\/\//, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .substring(0, 100);
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.includes('application/json') || contentType.includes('+json');
}

function shouldCaptureBody(contentType: string | null, url: string): boolean {
  if (!contentType) return true; // Capturer par défaut
  // Capturer JSON, HTML, text, JavaScript, CSS
  const captureTypes = ['json', 'text', 'html', 'javascript', 'css', 'xml'];
  return captureTypes.some(t => contentType.includes(t));
}

// === Setup capture handlers ===
function setupRequestCapture(page: Page): void {
  page.on('request', (request: Request) => {
    requestCounter++;
    const captured: CapturedRequest = {
      timestamp: timestamp(),
      id: requestCounter,
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData(),
      resourceType: request.resourceType(),
    };
    capturedRequests.push(captured);

    // Log en temps réel
    const shortUrl = request.url().substring(0, 120);
    console.log(`[REQ #${requestCounter}] ${request.method()} ${shortUrl}`);

    // Si c'est un POST avec body, sauvegarder séparément
    if (request.postData()) {
      const bodyFile = path.resolve(OUTPUT_DIR, 'bodies', `req-${requestCounter}-body.txt`);
      ensureDir(path.dirname(bodyFile));
      fs.writeFileSync(bodyFile, request.postData()!);
    }
  });

  page.on('response', async (response: Response) => {
    const request = response.request();
    const matchingReq = capturedRequests.find(r => r.url === request.url() && r.method === request.method());
    const reqId = matchingReq?.id || 0;
    
    const contentType = response.headers()['content-type'] || null;
    let body: string | null = null;
    let bodySize = 0;

    try {
      if (shouldCaptureBody(contentType, response.url())) {
        const buffer = await response.body();
        bodySize = buffer.length;
        body = buffer.toString('utf-8');

        // Sauvegarder les réponses JSON séparément pour analyse facile
        if (isJsonContentType(contentType) || body.startsWith('{') || body.startsWith('[')) {
          const jsonFile = path.resolve(OUTPUT_DIR, 'json-responses', `resp-${reqId}-${sanitizeFilename(response.url())}.json`);
          ensureDir(path.dirname(jsonFile));
          try {
            const parsed = JSON.parse(body);
            fs.writeFileSync(jsonFile, JSON.stringify(parsed, null, 2));
          } catch {
            fs.writeFileSync(jsonFile, body);
          }
        }
      }
    } catch {
      // Body not available (redirect, etc.)
    }

    const captured: CapturedResponse = {
      timestamp: timestamp(),
      requestId: reqId,
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      headers: response.headers(),
      body: body?.substring(0, 50000) || null, // Limiter pour le log principal
      bodySize,
      contentType,
    };
    capturedResponses.push(captured);

    // Log en temps réel
    const shortUrl = response.url().substring(0, 100);
    const emoji = response.status() >= 400 ? '❌' : response.status() >= 300 ? '↩️' : '✅';
    console.log(`[RESP #${reqId}] ${emoji} ${response.status()} ${shortUrl} [${bodySize} bytes]`);
  });

  // Capture WebSocket
  page.on('websocket', ws => {
    console.log(`[WS] WebSocket ouvert: ${ws.url()}`);
    
    ws.on('framesent', data => {
      capturedWebSockets.push({
        timestamp: timestamp(),
        url: ws.url(),
        direction: 'sent',
        data: typeof data.payload === 'string' ? data.payload : '<binary>',
      });
    });

    ws.on('framereceived', data => {
      capturedWebSockets.push({
        timestamp: timestamp(),
        url: ws.url(),
        direction: 'received',
        data: typeof data.payload === 'string' ? data.payload : '<binary>',
      });
    });
  });

  // Capture console du navigateur
  page.on('console', msg => {
    const log: CapturedConsole = {
      timestamp: timestamp(),
      type: msg.type(),
      text: msg.text(),
      location: msg.location()?.url || '',
    };
    capturedConsoleLogs.push(log);
  });

  // Screenshot sur chaque navigation
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      screenshotCounter++;
      const screenshotFile = path.resolve(OUTPUT_DIR, 'screenshots', `nav-${screenshotCounter}-${sanitizeFilename(frame.url())}.png`);
      ensureDir(path.dirname(screenshotFile));
      try {
        await page.screenshot({ path: screenshotFile, fullPage: false });
        console.log(`[SCREENSHOT] #${screenshotCounter} sauvegardé`);
      } catch {
        // Page may not be ready
      }
    }
  });
}

// === Periodic cookie capture ===
async function captureCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    capturedCookies.push({
      timestamp: timestamp(),
      cookies,
    });
  } catch {
    // Context may be closed
  }
}

// === Save all captured data ===
function saveAllData(): void {
  console.log('\n' + '='.repeat(60));
  console.log('[SAVE] Sauvegarde de toutes les données capturées...');
  console.log('='.repeat(60));

  ensureDir(OUTPUT_DIR);

  // 1. Toutes les requêtes
  const requestsFile = path.resolve(OUTPUT_DIR, 'all-requests.json');
  fs.writeFileSync(requestsFile, JSON.stringify(capturedRequests, null, 2));
  console.log(`  ✅ ${capturedRequests.length} requêtes → all-requests.json`);

  // 2. Toutes les réponses (sans body pour le fichier principal)
  const responsesFile = path.resolve(OUTPUT_DIR, 'all-responses.json');
  const responsesWithoutBody = capturedResponses.map(r => ({
    ...r,
    body: r.body ? `[${r.bodySize} bytes - voir json-responses/]` : null,
  }));
  fs.writeFileSync(responsesFile, JSON.stringify(responsesWithoutBody, null, 2));
  console.log(`  ✅ ${capturedResponses.length} réponses → all-responses.json`);

  // 3. Réponses complètes (avec body) pour les API calls importants
  const apiResponses = capturedResponses.filter(r => 
    r.url.includes('/api/') || 
    r.url.includes('.json') || 
    isJsonContentType(r.contentType) ||
    r.url.includes('schedule') ||
    r.url.includes('appointment') ||
    r.url.includes('days') ||
    r.url.includes('times') ||
    r.url.includes('available')
  );
  const apiFile = path.resolve(OUTPUT_DIR, 'api-responses-full.json');
  fs.writeFileSync(apiFile, JSON.stringify(apiResponses, null, 2));
  console.log(`  ✅ ${apiResponses.length} réponses API → api-responses-full.json`);

  // 4. WebSockets
  if (capturedWebSockets.length > 0) {
    const wsFile = path.resolve(OUTPUT_DIR, 'websockets.json');
    fs.writeFileSync(wsFile, JSON.stringify(capturedWebSockets, null, 2));
    console.log(`  ✅ ${capturedWebSockets.length} frames WebSocket → websockets.json`);
  }

  // 5. Console logs
  if (capturedConsoleLogs.length > 0) {
    const consoleFile = path.resolve(OUTPUT_DIR, 'console-logs.json');
    fs.writeFileSync(consoleFile, JSON.stringify(capturedConsoleLogs, null, 2));
    console.log(`  ✅ ${capturedConsoleLogs.length} console logs → console-logs.json`);
  }

  // 6. Cookies
  if (capturedCookies.length > 0) {
    const cookiesFile = path.resolve(OUTPUT_DIR, 'cookies.json');
    fs.writeFileSync(cookiesFile, JSON.stringify(capturedCookies, null, 2));
    console.log(`  ✅ ${capturedCookies.length} snapshots de cookies → cookies.json`);
  }

  // 7. Résumé du flux
  const summary = {
    captureDate: timestamp(),
    portalUrl: USA_PORTAL_URL,
    stats: {
      totalRequests: capturedRequests.length,
      totalResponses: capturedResponses.length,
      apiCalls: apiResponses.length,
      webSocketFrames: capturedWebSockets.length,
      consoleLogs: capturedConsoleLogs.length,
      cookieSnapshots: capturedCookies.length,
      screenshots: screenshotCounter,
    },
    uniqueEndpoints: [...new Set(capturedRequests.map(r => {
      try {
        const url = new URL(r.url);
        return `${r.method} ${url.pathname}`;
      } catch {
        return `${r.method} ${r.url}`;
      }
    }))],
    apiEndpoints: [...new Set(apiResponses.map(r => {
      try {
        const url = new URL(r.url);
        return `${r.status} ${url.pathname}`;
      } catch {
        return `${r.status} ${r.url}`;
      }
    }))],
  };
  const summaryFile = path.resolve(OUTPUT_DIR, 'capture-summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  console.log(`  ✅ Résumé → capture-summary.json`);

  // 8. Headers uniques (pour reproduire les requêtes)
  const headerSets = capturedRequests
    .filter(r => r.url.includes('usvisa-info.com'))
    .reduce((acc, r) => {
      const key = `${r.method} ${r.resourceType}`;
      if (!acc[key]) {
        acc[key] = r.headers;
      }
      return acc;
    }, {} as Record<string, Record<string, string>>);
  const headersFile = path.resolve(OUTPUT_DIR, 'unique-headers.json');
  fs.writeFileSync(headersFile, JSON.stringify(headerSets, null, 2));
  console.log(`  ✅ Headers uniques → unique-headers.json`);

  console.log('\n' + '='.repeat(60));
  console.log(`[DONE] Toutes les données sauvegardées dans: ${OUTPUT_DIR}`);
  console.log('='.repeat(60));
}

// === Main ===
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  USA VISA PORTAL - SESSION CAPTURE');
  console.log('  Portail: ais.usvisa-info.com');
  console.log('='.repeat(60));
  console.log('');
  console.log('📋 Ce script va:');
  console.log('  1. Lancer un navigateur Chromium');
  console.log('  2. Ouvrir la page de connexion du portail USA');
  console.log('  3. Capturer TOUT le trafic réseau');
  console.log('  4. Attendre que tu navigues (mode interactif)');
  console.log('  5. Sauvegarder les données dans usa-fixe/');
  console.log('');
  console.log('⏳ Lancement du navigateur...');
  console.log('');

  ensureDir(OUTPUT_DIR);
  ensureDir(path.resolve(OUTPUT_DIR, 'json-responses'));
  ensureDir(path.resolve(OUTPUT_DIR, 'bodies'));
  ensureDir(path.resolve(OUTPUT_DIR, 'screenshots'));
  ensureDir(SESSION_DIR);

  let browser: Browser;

  try {
    // Lancer le navigateur avec HAR recording
    browser = await chromium.launch({
      headless: true, // Headless car pas de display dans le sandbox
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-headless-mode', // Empêche la détection headless
      ],
    });
  } catch (err) {
    console.error('[ERROR] Impossible de lancer le navigateur:', err);
    process.exit(1);
  }

  // Créer un contexte avec enregistrement HAR
  const context = await browser.newContext({
    recordHar: {
      path: HAR_FILE,
      mode: 'full',
      content: 'embed',
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'fr-FR',
    timezoneId: 'Africa/Casablanca',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const page = await context.newPage();

  // Setup all captures
  setupRequestCapture(page);

  // Cookie capture interval
  const cookieInterval = setInterval(() => captureCookies(context), 10000);

  // Navigate to portal
  console.log(`[NAV] Ouverture de ${USA_PORTAL_URL}...`);
  
  try {
    await page.goto(USA_PORTAL_URL, { 
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    console.log(`[NAV] ✅ Page chargée: ${page.url()}`);
    console.log(`[NAV] Titre: ${await page.title()}`);
  } catch (err) {
    console.error(`[NAV] ⚠️ Timeout ou erreur de chargement (ce n'est pas bloquant):`, (err as Error).message);
  }

  // Capture initial cookies
  await captureCookies(context);

  console.log('');
  console.log('='.repeat(60));
  console.log('  🎯 MODE CAPTURE ACTIF');
  console.log('  Le navigateur est en headless - tout le trafic est capturé.');
  console.log('');
  console.log('  Pour une session interactive, tu dois utiliser ce script');
  console.log('  avec les cookies/tokens d\'une session réelle.');
  console.log('');
  console.log('  ⏳ Attente de 30 secondes pour capturer le trafic initial...');
  console.log('  (Appuie sur Ctrl+C pour arrêter et sauvegarder)');
  console.log('='.repeat(60));

  // Handle graceful shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log('\n[SHUTDOWN] Arrêt en cours...');
    clearInterval(cookieInterval);
    
    // Final cookie capture
    await captureCookies(context);
    
    // Final screenshot
    try {
      screenshotCounter++;
      await page.screenshot({ 
        path: path.resolve(OUTPUT_DIR, 'screenshots', `final-${screenshotCounter}.png`),
        fullPage: true,
      });
    } catch { /* ignore */ }
    
    // Close HAR recording
    await context.close();
    
    // Save all data
    saveAllData();
    
    await browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Attendre 30 secondes puis sauvegarder
  await page.waitForTimeout(30000);
  
  // Auto-shutdown après la capture initiale
  await shutdown();
}

main().catch(err => {
  console.error('[FATAL]', err);
  saveAllData();
  process.exit(1);
});
