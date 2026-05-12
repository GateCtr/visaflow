/**
 * USA Portal - Full Capture (non-headless via Xvfb)
 * 
 * Lance le vrai navigateur Chromium (pas headless shell) via Xvfb
 * pour éviter la détection anti-bot. Capture tout le trafic réseau.
 * 
 * Usage: npx tsx scripts/usa-capture-full.ts
 * 
 * Options:
 *   --url=URL      URL de départ (défaut: page de login)
 *   --wait=SECS    Temps d'attente avant arrêt (défaut: 60s, 0=infini)
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// === Config ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.resolve(__dirname, '..', 'usa-fixe');
const SESSION_FILE = path.resolve(OUTPUT_DIR, 'session-input.json');
const BASE_URL = 'https://www.usvisaappt.com';

// Parse args
const args = process.argv.slice(2);
const getArg = (name: string, defaultVal: string): string => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : defaultVal;
};

const START_URL = getArg('url', `${BASE_URL}/visaapplicantui/`);
const WAIT_SECS = parseInt(getArg('wait', '60'));

// === State ===
let reqCounter = 0;
const requests: Array<any> = [];
const responses: Array<any> = [];
const startTime = Date.now();

// === Helpers ===
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ts(): string { return new Date().toISOString(); }

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 80);
}

// === Setup Xvfb (Linux only) ===
function startXvfb(): string {
  const display = ':99';
  try {
    execSync(`Xvfb ${display} -screen 0 1920x1080x24 -nolisten tcp &`, { stdio: 'ignore' });
    // Wait for Xvfb to start
    execSync('sleep 1');
  } catch {
    console.log('⚠️ Xvfb déjà démarré ou erreur (ignorée)');
  }
  return display;
}

// === Capture ===
function setupCapture(page: Page): void {
  page.on('request', req => {
    reqCounter++;
    const entry = {
      id: reqCounter,
      timestamp: ts(),
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      postData: req.postData(),
      resourceType: req.resourceType(),
    };
    requests.push(entry);

    // Log prominently for API/important requests
    const url = req.url();
    if (url.includes('usvisaappt.com') && (
      req.resourceType() === 'document' || 
      req.resourceType() === 'xhr' || 
      req.resourceType() === 'fetch' ||
      url.includes('.json') ||
      url.includes('/api/')
    )) {
      console.log(`  → [${reqCounter}] ${req.method()} ${url.replace(BASE_URL, '')}`);
      if (req.postData()) {
        console.log(`    📤 ${req.postData()?.substring(0, 200)}`);
      }
    }
  });

  page.on('response', async resp => {
    const req = resp.request();
    const matchReq = requests.findLast((r: any) => r.url === req.url() && r.method === req.method());
    const reqId = matchReq?.id || 0;
    
    const contentType = resp.headers()['content-type'] || '';
    let body: string | null = null;

    try {
      if (contentType.includes('json') || contentType.includes('text') || contentType.includes('html') || contentType.includes('javascript')) {
        body = await resp.text();
      }
    } catch { /* unavailable */ }

    const entry = {
      requestId: reqId,
      timestamp: ts(),
      url: resp.url(),
      status: resp.status(),
      statusText: resp.statusText(),
      headers: resp.headers(),
      contentType,
      body,
      bodyLength: body?.length || 0,
    };
    responses.push(entry);

    // Log important responses
    const url = resp.url();
    if (url.includes('usvisaappt.com') && (
      contentType.includes('json') || 
      resp.status() >= 400 ||
      url.includes('.json') ||
      req.resourceType() === 'document'
    )) {
      const icon = resp.status() >= 400 ? '❌' : resp.status() >= 300 ? '↩️' : '✅';
      console.log(`  ← [${reqId}] ${icon} ${resp.status()} ${url.replace(BASE_URL, '')}`);
      if (body && (body.startsWith('{') || body.startsWith('['))) {
        console.log(`    📥 ${body.substring(0, 300)}`);
        // Save JSON
        const jsonDir = path.resolve(OUTPUT_DIR, 'json-responses');
        ensureDir(jsonDir);
        try {
          fs.writeFileSync(
            path.resolve(jsonDir, `${reqId}-${sanitize(new URL(url).pathname)}.json`),
            JSON.stringify(JSON.parse(body), null, 2)
          );
        } catch {
          fs.writeFileSync(
            path.resolve(jsonDir, `${reqId}-${sanitize(new URL(url).pathname)}.json`),
            body
          );
        }
      }
    }
  });
}

// === Save ===
function saveAll(): void {
  ensureDir(OUTPUT_DIR);
  
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'all-requests.json'), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'all-responses.json'), JSON.stringify(responses.map(r => ({ ...r, body: undefined })), null, 2));
  
  // API responses with body
  const apiResps = responses.filter((r: any) => 
    r.contentType?.includes('json') || r.url.includes('.json') || r.url.includes('/api/')
  );
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'api-calls.json'), JSON.stringify(apiResps, null, 2));

  // Summary
  const summary = {
    captureDate: ts(),
    startUrl: START_URL,
    duration: `${Math.round((Date.now() - startTime) / 1000)}s`,
    stats: {
      totalRequests: requests.length,
      totalResponses: responses.length,
      apiCalls: apiResps.length,
      errors: responses.filter((r: any) => r.status >= 400).length,
    },
    endpoints: [...new Set(requests
      .filter((r: any) => r.url.includes('usvisaappt.com'))
      .map((r: any) => { try { return `${r.method} ${new URL(r.url).pathname}`; } catch { return r.url; } })
    )],
    errors: responses.filter((r: any) => r.status >= 400).map((r: any) => ({
      status: r.status, url: r.url, body: r.body?.substring(0, 200)
    })),
  };
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'capture-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n═══════════════════════════════════════');
  console.log(`💾 Sauvegardé: ${requests.length} req, ${responses.length} resp, ${apiResps.length} API`);
  console.log(`📁 ${OUTPUT_DIR}`);
  console.log('═══════════════════════════════════════');
}

// === Main ===
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('🇺🇸 USA PORTAL - FULL CHROMIUM CAPTURE');
  console.log('═══════════════════════════════════════════');
  console.log(`  URL: ${START_URL}`);
  console.log(`  Wait: ${WAIT_SECS}s (0=infini)`);
  console.log('');

  ensureDir(OUTPUT_DIR);
  ensureDir(path.resolve(OUTPUT_DIR, 'json-responses'));
  ensureDir(path.resolve(OUTPUT_DIR, 'screenshots'));

  // Start Xvfb for non-headless mode (Linux only)
  let display = '';
  if (process.platform === 'linux') {
    display = startXvfb();
    process.env.DISPLAY = display;
    console.log(`🖥️  Xvfb démarré sur ${display} (Linux)`);
  } else {
    console.log(`🖥️  Windows - pas de Xvfb nécessaire`);
  }

  // Load session cookies if available
  let sessionCookies: any[] = [];
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      if (session.cookies) {
        sessionCookies = session.cookies;
        console.log(`🍪 ${sessionCookies.length} cookies trouvés dans session-input.json`);
      }
    } catch { /* ignore */ }
  }

  // Launch REAL Chromium (not headless shell)
  console.log('⏳ Lancement de Chromium (non-headless)...');
  const launchOptions: any = {
    headless: false, // REAL browser!
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  };
  
  // Set executable path for Linux if needed
  if (process.platform === 'linux') {
    launchOptions.executablePath = '/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
  }
  
  const browser = await chromium.launch(launchOptions);

  const context = await browser.newContext({
    recordHar: { path: path.resolve(OUTPUT_DIR, 'session.har'), mode: 'full', content: 'embed' },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'fr-FR',
    timezoneId: 'Africa/Casablanca',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // Set cookies if available
  if (sessionCookies.length > 0) {
    const cookies = sessionCookies.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.usvisaappt.com',
      path: c.path || '/',
      secure: c.secure ?? true,
      sameSite: (c.sameSite || 'None') as 'None' | 'Lax' | 'Strict',
    }));
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  setupCapture(page);

  // Shutdown handler
  let done = false;
  const shutdown = async () => {
    if (done) return;
    done = true;
    console.log('\n🛑 Arrêt...');
    try {
      await page.screenshot({ path: path.resolve(OUTPUT_DIR, 'screenshots', 'final.png'), fullPage: true });
      const cookies = await context.cookies();
      fs.writeFileSync(path.resolve(OUTPUT_DIR, 'final-cookies.json'), JSON.stringify(cookies, null, 2));
    } catch {}
    await context.close();
    saveAll();
    await browser.close();
    // Kill Xvfb (Linux only)
    if (process.platform === 'linux') {
      try { execSync('pkill -f "Xvfb :99"', { stdio: 'ignore' }); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Navigate
  console.log(`\n🌐 Navigation: ${START_URL}`);
  console.log('─'.repeat(50));
  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log(`✅ URL: ${page.url()}`);
    console.log(`📄 Title: ${await page.title()}`);
    
    // Screenshot
    await page.screenshot({ path: path.resolve(OUTPUT_DIR, 'screenshots', '001-initial.png') });
    
    // Save page HTML
    const html = await page.content();
    fs.writeFileSync(path.resolve(OUTPUT_DIR, 'initial-page.html'), html);
    console.log(`📄 HTML sauvegardé (${html.length} bytes)`);
  } catch (err) {
    console.log(`⚠️ ${(err as Error).message?.substring(0, 150)}`);
  }

  // Wait
  if (WAIT_SECS > 0) {
    console.log(`\n⏳ Attente ${WAIT_SECS}s...`);
    await page.waitForTimeout(WAIT_SECS * 1000);
    await shutdown();
  } else {
    console.log('\n♾️ Mode infini - Ctrl+C pour arrêter');
    await new Promise(() => {});
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  saveAll();
  process.exit(1);
});
