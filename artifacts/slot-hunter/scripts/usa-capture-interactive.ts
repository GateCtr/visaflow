/**
 * USA Portal - Interactive Capture with CDP (Chrome DevTools Protocol)
 * 
 * Ce script lance Chromium avec un port CDP exposé pour que tu puisses
 * te connecter au navigateur à distance via chrome://inspect ou DevTools.
 * 
 * TOUT le trafic est capturé automatiquement pendant ta navigation.
 * 
 * Quand tu as fini, appuie sur Ctrl+C et tout sera sauvegardé.
 * 
 * Usage: npx tsx scripts/usa-capture-interactive.ts
 */

import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// === Configuration ===
const USA_PORTAL_URL = 'https://ais.usvisa-info.com/fr-ma/niv/users/sign_in';
const OUTPUT_DIR = path.resolve(import.meta.dirname, '..', 'usa-fixe');
const HAR_FILE = path.resolve(OUTPUT_DIR, 'usa-session.har');
const CDP_PORT = 9222;

// === Types ===
interface CapturedRequest {
  timestamp: string;
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  resourceType: string;
  frameUrl: string;
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
  timing: number;
}

// === State ===
let requestCounter = 0;
const capturedRequests: CapturedRequest[] = [];
const capturedResponses: CapturedResponse[] = [];
const capturedWebSockets: Array<{ timestamp: string; url: string; direction: string; data: string }> = [];
const capturedConsoleLogs: Array<{ timestamp: string; type: string; text: string }> = [];
const capturedCookies: Array<{ timestamp: string; cookies: unknown[] }> = [];
const navigationHistory: Array<{ timestamp: string; url: string; title: string }> = [];
let screenshotCounter = 0;

// === Helpers ===
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ts(): string {
  return new Date().toISOString();
}

function sanitizeFn(url: string): string {
  return url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 80);
}

function isApiCall(url: string): boolean {
  return url.includes('/api/') ||
    url.includes('.json') ||
    url.includes('schedule') ||
    url.includes('appointment') ||
    url.includes('available_appointments') ||
    url.includes('days.json') ||
    url.includes('times.json') ||
    url.includes('facilities') ||
    url.includes('payment');
}

// === Capture setup ===
function setupCapture(page: Page): void {
  const requestTimings = new Map<string, number>();

  page.on('request', (request: Request) => {
    requestCounter++;
    const id = requestCounter;
    requestTimings.set(request.url() + request.method(), Date.now());

    const captured: CapturedRequest = {
      timestamp: ts(),
      id,
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postData: request.postData(),
      resourceType: request.resourceType(),
      frameUrl: request.frame()?.url() || '',
    };
    capturedRequests.push(captured);

    // Log API calls prominently
    if (isApiCall(request.url()) || request.method() !== 'GET') {
      console.log(`\n🔵 [REQ #${id}] ${request.method()} ${request.url()}`);
      if (request.postData()) {
        console.log(`   📤 Body: ${request.postData()?.substring(0, 200)}`);
      }
    }

    // Save POST/PUT bodies
    if (request.postData()) {
      const bodyFile = path.resolve(OUTPUT_DIR, 'request-bodies', `req-${id}-${request.method()}-${sanitizeFn(request.url())}.txt`);
      ensureDir(path.dirname(bodyFile));
      fs.writeFileSync(bodyFile, request.postData()!);
    }
  });

  page.on('response', async (response: Response) => {
    const request = response.request();
    const key = request.url() + request.method();
    const startTime = requestTimings.get(key) || Date.now();
    const timing = Date.now() - startTime;
    requestTimings.delete(key);

    const matchReq = capturedRequests.findLast(r => r.url === request.url() && r.method === request.method());
    const reqId = matchReq?.id || 0;
    
    const contentType = response.headers()['content-type'] || null;
    let body: string | null = null;
    let bodySize = 0;

    try {
      const buffer = await response.body();
      bodySize = buffer.length;
      
      // Capture text-based responses
      if (contentType && (
        contentType.includes('json') || 
        contentType.includes('text') || 
        contentType.includes('javascript') ||
        contentType.includes('html') ||
        contentType.includes('xml')
      )) {
        body = buffer.toString('utf-8');
      }
    } catch {
      // Body not available
    }

    const captured: CapturedResponse = {
      timestamp: ts(),
      requestId: reqId,
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      headers: response.headers(),
      body,
      bodySize,
      contentType,
      timing,
    };
    capturedResponses.push(captured);

    // Log API responses prominently
    if (isApiCall(response.url()) || response.status() >= 400) {
      const emoji = response.status() >= 400 ? '🔴' : '🟢';
      console.log(`${emoji} [RESP #${reqId}] ${response.status()} ${response.url()} [${timing}ms, ${bodySize}B]`);
      
      // Save JSON responses separately
      if (body && (body.startsWith('{') || body.startsWith('['))) {
        const jsonFile = path.resolve(OUTPUT_DIR, 'json-responses', `resp-${reqId}-${sanitizeFn(response.url())}.json`);
        ensureDir(path.dirname(jsonFile));
        try {
          fs.writeFileSync(jsonFile, JSON.stringify(JSON.parse(body), null, 2));
        } catch {
          fs.writeFileSync(jsonFile, body);
        }
        // Log JSON preview for API calls
        if (isApiCall(response.url())) {
          const preview = body.substring(0, 500);
          console.log(`   📥 JSON: ${preview}${body.length > 500 ? '...' : ''}`);
        }
      }
    }
  });

  // WebSocket capture
  page.on('websocket', ws => {
    console.log(`\n🔌 [WS] WebSocket: ${ws.url()}`);
    ws.on('framesent', d => {
      const payload = typeof d.payload === 'string' ? d.payload : '<binary>';
      capturedWebSockets.push({ timestamp: ts(), url: ws.url(), direction: 'sent', data: payload });
      console.log(`   ➡️ WS SENT: ${payload.substring(0, 100)}`);
    });
    ws.on('framereceived', d => {
      const payload = typeof d.payload === 'string' ? d.payload : '<binary>';
      capturedWebSockets.push({ timestamp: ts(), url: ws.url(), direction: 'received', data: payload });
    });
  });

  // Console capture
  page.on('console', msg => {
    capturedConsoleLogs.push({ timestamp: ts(), type: msg.type(), text: msg.text() });
  });

  // Navigation tracking with screenshots
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      const url = frame.url();
      const title = await page.title().catch(() => '');
      navigationHistory.push({ timestamp: ts(), url, title });
      console.log(`\n🧭 [NAV] ${url}`);
      console.log(`   📄 Title: ${title}`);

      // Screenshot
      screenshotCounter++;
      const ssFile = path.resolve(OUTPUT_DIR, 'screenshots', `${String(screenshotCounter).padStart(3, '0')}-${sanitizeFn(url)}.png`);
      ensureDir(path.dirname(ssFile));
      try {
        await new Promise(r => setTimeout(r, 1000)); // Wait for render
        await page.screenshot({ path: ssFile });
      } catch { /* page might not be ready */ }
    }
  });
}

// === Save all data ===
function saveAllData(): void {
  console.log('\n\n' + '═'.repeat(60));
  console.log('  💾 SAUVEGARDE DES DONNÉES CAPTURÉES');
  console.log('═'.repeat(60));

  ensureDir(OUTPUT_DIR);

  // Requests
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'all-requests.json'),
    JSON.stringify(capturedRequests, null, 2)
  );

  // Responses (without full body in main file)
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'all-responses.json'),
    JSON.stringify(capturedResponses.map(r => ({ ...r, body: undefined })), null, 2)
  );

  // API-only responses with full body
  const apiResps = capturedResponses.filter(r => isApiCall(r.url) || (r.contentType && r.contentType.includes('json')));
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'api-calls.json'),
    JSON.stringify(apiResps, null, 2)
  );

  // Cookies
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'cookies.json'),
    JSON.stringify(capturedCookies, null, 2)
  );

  // WebSockets
  if (capturedWebSockets.length > 0) {
    fs.writeFileSync(
      path.resolve(OUTPUT_DIR, 'websockets.json'),
      JSON.stringify(capturedWebSockets, null, 2)
    );
  }

  // Console
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'console-logs.json'),
    JSON.stringify(capturedConsoleLogs, null, 2)
  );

  // Navigation history
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'navigation-history.json'),
    JSON.stringify(navigationHistory, null, 2)
  );

  // Headers analysis
  const headersByEndpoint: Record<string, Record<string, string>> = {};
  capturedRequests
    .filter(r => r.url.includes('usvisa-info.com'))
    .forEach(r => {
      try {
        const url = new URL(r.url);
        const key = `${r.method} ${url.pathname}`;
        if (!headersByEndpoint[key]) {
          headersByEndpoint[key] = r.headers;
        }
      } catch { /* ignore */ }
    });
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'headers-by-endpoint.json'),
    JSON.stringify(headersByEndpoint, null, 2)
  );

  // Summary
  const summary = {
    captureDate: ts(),
    duration: `${Math.round((Date.now() - startTime) / 1000)} seconds`,
    stats: {
      totalRequests: capturedRequests.length,
      totalResponses: capturedResponses.length,
      apiCalls: apiResps.length,
      webSocketFrames: capturedWebSockets.length,
      consoleLogs: capturedConsoleLogs.length,
      navigations: navigationHistory.length,
      screenshots: screenshotCounter,
      cookieSnapshots: capturedCookies.length,
    },
    navigationFlow: navigationHistory,
    apiEndpoints: [...new Set(apiResps.map(r => {
      try { return `${r.status} ${new URL(r.url).pathname}`; } catch { return r.url; }
    }))],
    errors: capturedResponses.filter(r => r.status >= 400).map(r => ({
      status: r.status,
      url: r.url,
      body: r.body?.substring(0, 200),
    })),
  };
  fs.writeFileSync(
    path.resolve(OUTPUT_DIR, 'capture-summary.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log(`\n  📊 Statistiques:`);
  console.log(`     Requêtes: ${capturedRequests.length}`);
  console.log(`     Réponses: ${capturedResponses.length}`);
  console.log(`     API calls: ${apiResps.length}`);
  console.log(`     WebSocket frames: ${capturedWebSockets.length}`);
  console.log(`     Navigations: ${navigationHistory.length}`);
  console.log(`     Screenshots: ${screenshotCounter}`);
  console.log(`\n  📁 Dossier: ${OUTPUT_DIR}`);
  console.log('═'.repeat(60));
}

// === Main ===
const startTime = Date.now();

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  🇺🇸 USA VISA PORTAL - INTERACTIVE CAPTURE');
  console.log('═'.repeat(60));
  console.log('');
  console.log('  Ce script capture TOUT le trafic réseau pendant ta navigation.');
  console.log('  Le navigateur tourne en headless dans le sandbox.');
  console.log('');
  console.log('  📌 Le script va:');
  console.log('     1. Ouvrir le portail USA');
  console.log('     2. Capturer le trafic initial (page login)');
  console.log('     3. Attendre indéfiniment (Ctrl+C pour arrêter)');
  console.log('');
  console.log('  💡 Pour une session avec login, utilise:');
  console.log('     usa-capture-with-cookies.ts (avec tes cookies)');
  console.log('');

  ensureDir(OUTPUT_DIR);
  ensureDir(path.resolve(OUTPUT_DIR, 'json-responses'));
  ensureDir(path.resolve(OUTPUT_DIR, 'request-bodies'));
  ensureDir(path.resolve(OUTPUT_DIR, 'screenshots'));

  // Launch browser
  console.log('⏳ Lancement du navigateur...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    recordHar: { path: HAR_FILE, mode: 'full', content: 'embed' },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'fr-FR',
    timezoneId: 'Africa/Casablanca',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const page = await context.newPage();
  setupCapture(page);

  // Cookie capture every 15s
  const cookieTimer = setInterval(async () => {
    try {
      const cookies = await context.cookies();
      capturedCookies.push({ timestamp: ts(), cookies });
    } catch { /* context closed */ }
  }, 15000);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\n🛑 Arrêt en cours...');
    clearInterval(cookieTimer);
    
    // Final captures
    try {
      const cookies = await context.cookies();
      capturedCookies.push({ timestamp: ts(), cookies });
      screenshotCounter++;
      await page.screenshot({ 
        path: path.resolve(OUTPUT_DIR, 'screenshots', `final-${screenshotCounter}.png`),
        fullPage: true 
      });
    } catch { /* ignore */ }

    await context.close(); // This saves the HAR file
    saveAllData();
    await browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Navigate to portal
  console.log(`\n🌐 Navigation vers ${USA_PORTAL_URL}...`);
  try {
    await page.goto(USA_PORTAL_URL, { waitUntil: 'networkidle', timeout: 60000 });
    console.log(`✅ Page chargée: ${page.url()}`);
    console.log(`📄 Titre: ${await page.title()}`);
  } catch (err) {
    console.log(`⚠️ Chargement avec timeout (normal si Cloudflare): ${(err as Error).message?.substring(0, 100)}`);
    console.log(`📄 URL actuelle: ${page.url()}`);
  }

  // Initial cookie capture
  const cookies = await context.cookies();
  capturedCookies.push({ timestamp: ts(), cookies });

  console.log('\n' + '─'.repeat(60));
  console.log('  ✅ CAPTURE EN COURS - En attente...');
  console.log('  Appuie sur Ctrl+C pour arrêter et sauvegarder.');
  console.log('─'.repeat(60));

  // Keep alive indefinitely
  await new Promise(() => {}); // Never resolves - wait for SIGINT
}

main().catch(err => {
  console.error('[FATAL]', err);
  saveAllData();
  process.exit(1);
});
