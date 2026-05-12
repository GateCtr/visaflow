/**
 * USA Portal - Capture avec cookies de session
 * 
 * Ce script utilise des cookies/headers d'une session RÉELLE pour:
 * 1. Se connecter au portail USA
 * 2. Naviguer vers la page de rendez-vous
 * 3. Chercher les créneaux disponibles
 * 4. Capturer TOUT le trafic
 * 
 * USAGE:
 *   1. Connecte-toi au portail USA dans ton navigateur
 *   2. Copie les cookies depuis DevTools > Application > Cookies
 *   3. Mets-les dans le fichier usa-fixe/session-input.json
 *   4. Lance: npx tsx scripts/usa-capture-with-cookies.ts
 * 
 * FORMAT du fichier session-input.json:
 * {
 *   "cookies": [
 *     { "name": "_yatri_session", "value": "...", "domain": ".usvisa-info.com" },
 *     { "name": "__cf_bm", "value": "...", "domain": ".usvisa-info.com" }
 *   ],
 *   "scheduleId": "YOUR_SCHEDULE_ID",
 *   "csrfToken": "YOUR_CSRF_TOKEN_FROM_META_TAG"
 * }
 * 
 * OU simplement les headers:
 * {
 *   "headers": {
 *     "cookie": "_yatri_session=xxx; __cf_bm=yyy",
 *     "x-csrf-token": "zzz"
 *   },
 *   "scheduleId": "YOUR_SCHEDULE_ID"
 * }
 */

import { chromium, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// === Config ===
const OUTPUT_DIR = path.resolve(import.meta.dirname, '..', 'usa-fixe');
const SESSION_FILE = path.resolve(OUTPUT_DIR, 'session-input.json');
const BASE_URL = 'https://ais.usvisa-info.com';
const COUNTRY_PATH = '/fr-ma/niv'; // Maroc

// === State ===
let requestCounter = 0;
const allRequests: Array<{
  id: number;
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: string | null;
  resourceType: string;
}> = [];

const allResponses: Array<{
  requestId: number;
  timestamp: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  contentType: string | null;
  timing: number;
}> = [];

const startTime = Date.now();

// === Helpers ===
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ts(): string {
  return new Date().toISOString();
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 60);
}

// === Capture ===
function setupCapture(page: Page): void {
  const timings = new Map<string, number>();

  page.on('request', req => {
    requestCounter++;
    timings.set(req.url(), Date.now());
    
    allRequests.push({
      id: requestCounter,
      timestamp: ts(),
      method: req.method(),
      url: req.url(),
      headers: req.headers(),
      postData: req.postData(),
      resourceType: req.resourceType(),
    });

    if (req.url().includes('usvisa-info.com')) {
      console.log(`  → [${requestCounter}] ${req.method()} ${req.url().replace(BASE_URL, '')}`);
    }
  });

  page.on('response', async resp => {
    const startT = timings.get(resp.url()) || Date.now();
    const timing = Date.now() - startT;
    const req = resp.request();
    const matchReq = allRequests.findLast(r => r.url === req.url());
    const reqId = matchReq?.id || 0;
    
    const contentType = resp.headers()['content-type'] || null;
    let body: string | null = null;

    try {
      if (contentType && (contentType.includes('json') || contentType.includes('text') || contentType.includes('html'))) {
        body = await resp.text();
      }
    } catch { /* not available */ }

    allResponses.push({
      requestId: reqId,
      timestamp: ts(),
      url: resp.url(),
      status: resp.status(),
      headers: resp.headers(),
      body,
      contentType,
      timing,
    });

    if (resp.url().includes('usvisa-info.com')) {
      const status = resp.status();
      const icon = status >= 400 ? '❌' : status >= 300 ? '↩️' : '✅';
      console.log(`  ← [${reqId}] ${icon} ${status} ${resp.url().replace(BASE_URL, '')} (${timing}ms)`);
      
      if (body && (body.startsWith('{') || body.startsWith('['))) {
        // Save JSON immediately
        const jsonDir = path.resolve(OUTPUT_DIR, 'json-responses');
        ensureDir(jsonDir);
        const filename = `${reqId}-${sanitize(new URL(resp.url()).pathname)}.json`;
        try {
          fs.writeFileSync(path.resolve(jsonDir, filename), JSON.stringify(JSON.parse(body), null, 2));
        } catch {
          fs.writeFileSync(path.resolve(jsonDir, filename), body);
        }
      }
    }
  });
}

// === Save ===
function saveAll(): void {
  console.log('\n═══════════════════════════════════════');
  console.log('💾 SAUVEGARDE...');
  
  ensureDir(OUTPUT_DIR);
  
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'all-requests.json'), JSON.stringify(allRequests, null, 2));
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'all-responses.json'), JSON.stringify(allResponses, null, 2));
  
  // API-specific
  const apiCalls = allResponses.filter(r => 
    r.url.includes('.json') || 
    r.url.includes('/api/') ||
    (r.contentType && r.contentType.includes('json'))
  );
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'api-calls.json'), JSON.stringify(apiCalls, null, 2));

  // Endpoints summary
  const endpoints = [...new Set(allRequests
    .filter(r => r.url.includes('usvisa-info.com'))
    .map(r => {
      try { return `${r.method} ${new URL(r.url).pathname}`; } catch { return r.url; }
    })
  )];
  
  const summary = {
    captureDate: ts(),
    duration: `${Math.round((Date.now() - startTime) / 1000)}s`,
    totalRequests: allRequests.length,
    totalResponses: allResponses.length,
    apiCalls: apiCalls.length,
    endpoints,
    errors: allResponses.filter(r => r.status >= 400).map(r => ({ status: r.status, url: r.url })),
  };
  fs.writeFileSync(path.resolve(OUTPUT_DIR, 'capture-summary.json'), JSON.stringify(summary, null, 2));

  console.log(`  📊 ${allRequests.length} requêtes, ${allResponses.length} réponses, ${apiCalls.length} API calls`);
  console.log(`  📁 ${OUTPUT_DIR}`);
  console.log('═══════════════════════════════════════\n');
}

// === Main ===
async function main(): Promise<void> {
  console.log('═══════════════════════════════════════');
  console.log('🇺🇸 USA PORTAL - CAPTURE WITH SESSION');
  console.log('═══════════════════════════════════════\n');

  // Check session file
  if (!fs.existsSync(SESSION_FILE)) {
    console.log('⚠️  Fichier session-input.json non trouvé!');
    console.log('');
    console.log('📋 Crée le fichier: usa-fixe/session-input.json');
    console.log('   avec le format suivant:');
    console.log('');
    console.log('   {');
    console.log('     "cookies": [');
    console.log('       { "name": "_yatri_session", "value": "...", "domain": ".usvisa-info.com", "path": "/" }');
    console.log('     ],');
    console.log('     "scheduleId": "XXXXX"');
    console.log('   }');
    console.log('');
    console.log('   OU avec headers bruts:');
    console.log('');
    console.log('   {');
    console.log('     "headers": {');
    console.log('       "cookie": "_yatri_session=...; __cf_bm=..."');
    console.log('     },');
    console.log('     "scheduleId": "XXXXX"');
    console.log('   }');
    console.log('');
    
    // Create template
    const template = {
      _comment: "Remplis ce fichier avec tes données de session",
      cookies: [
        { name: "_yatri_session", value: "COLLE_TA_VALEUR_ICI", domain: ".usvisa-info.com", path: "/" },
        { name: "__cf_bm", value: "COLLE_TA_VALEUR_ICI", domain: ".usvisa-info.com", path: "/" },
      ],
      scheduleId: "TON_SCHEDULE_ID",
      csrfToken: "TON_CSRF_TOKEN_OPTIONNEL",
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(template, null, 2));
    console.log(`✅ Template créé: ${SESSION_FILE}`);
    console.log('   Remplis-le et relance le script.');
    return;
  }

  const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  const scheduleId = sessionData.scheduleId;

  if (!scheduleId || scheduleId === 'TON_SCHEDULE_ID') {
    console.error('❌ scheduleId manquant ou pas rempli dans session-input.json');
    return;
  }

  console.log(`📋 Schedule ID: ${scheduleId}`);
  console.log('⏳ Lancement du navigateur...\n');

  ensureDir(path.resolve(OUTPUT_DIR, 'json-responses'));
  ensureDir(path.resolve(OUTPUT_DIR, 'screenshots'));

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    recordHar: { path: path.resolve(OUTPUT_DIR, 'session.har'), mode: 'full', content: 'embed' },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'fr-FR',
    timezoneId: 'Africa/Casablanca',
  });

  // Set cookies
  if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
    const cookies = sessionData.cookies.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.usvisa-info.com',
      path: c.path || '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite || 'None' as const,
    }));
    await context.addCookies(cookies);
    console.log(`🍪 ${cookies.length} cookies chargés`);
  } else if (sessionData.headers?.cookie) {
    // Parse cookie header string
    const cookieStr = sessionData.headers.cookie;
    const cookies = cookieStr.split(';').map((c: string) => {
      const [name, ...valueParts] = c.trim().split('=');
      return {
        name: name.trim(),
        value: valueParts.join('=').trim(),
        domain: '.usvisa-info.com',
        path: '/',
        secure: true,
        sameSite: 'None' as const,
      };
    });
    await context.addCookies(cookies);
    console.log(`🍪 ${cookies.length} cookies parsés depuis le header`);
  }

  const page = await context.newPage();
  setupCapture(page);

  // Graceful shutdown
  let done = false;
  const shutdown = async () => {
    if (done) return;
    done = true;
    console.log('\n🛑 Arrêt...');
    try {
      await page.screenshot({ path: path.resolve(OUTPUT_DIR, 'screenshots', 'final.png'), fullPage: true });
    } catch {}
    await context.close();
    saveAll();
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // === Navigation séquentielle ===
  const urls = [
    // 1. Page d'accueil du groupe (vérifie la session)
    `${BASE_URL}${COUNTRY_PATH}/groups/${scheduleId}`,
    // 2. Page de rendez-vous
    `${BASE_URL}${COUNTRY_PATH}/schedule/${scheduleId}/appointment`,
    // 3. Jours disponibles (API JSON) - Casablanca facility_id=70
    `${BASE_URL}${COUNTRY_PATH}/schedule/${scheduleId}/appointment/days/70.json?appointments[expedite]=false`,
    // 4. Si des jours sont disponibles, chercher les heures pour le premier jour
    // (sera fait dynamiquement)
  ];

  for (const url of urls) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🌐 Navigation: ${url.replace(BASE_URL, '')}`);
    console.log('─'.repeat(50));
    
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`  Status: ${response?.status()}`);
      console.log(`  URL finale: ${page.url().replace(BASE_URL, '')}`);
      
      // Screenshot
      const ssFile = path.resolve(OUTPUT_DIR, 'screenshots', `step-${sanitize(new URL(url).pathname)}.png`);
      await page.screenshot({ path: ssFile });

      // Si c'est la page appointment, extraire le CSRF token et les données
      if (url.includes('/appointment') && !url.includes('.json')) {
        const csrfToken = await page.$eval('meta[name="csrf-token"]', el => el.getAttribute('content')).catch(() => null);
        if (csrfToken) {
          console.log(`  🔑 CSRF Token: ${csrfToken.substring(0, 20)}...`);
          fs.writeFileSync(path.resolve(OUTPUT_DIR, 'csrf-token.txt'), csrfToken);
        }

        // Extraire les facility IDs depuis le HTML
        const html = await page.content();
        fs.writeFileSync(path.resolve(OUTPUT_DIR, 'appointment-page.html'), html);
        console.log(`  📄 HTML sauvegardé (${html.length} bytes)`);
      }

      // Si c'est un .json, capturer directement
      if (url.includes('.json')) {
        const content = await page.textContent('body');
        if (content) {
          console.log(`  📥 JSON Response: ${content.substring(0, 300)}`);
        }
      }

      await page.waitForTimeout(2000); // Petite pause entre navigations
    } catch (err) {
      console.log(`  ⚠️ Erreur: ${(err as Error).message?.substring(0, 150)}`);
      // Continue anyway
    }
  }

  // === Essayer d'autres facilities ===
  const facilities = [
    { id: 70, name: 'Casablanca' },
    { id: 71, name: 'Rabat' },
  ];

  for (const facility of facilities) {
    const daysUrl = `${BASE_URL}${COUNTRY_PATH}/schedule/${scheduleId}/appointment/days/${facility.id}.json?appointments[expedite]=false`;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🏛️ Facility: ${facility.name} (ID: ${facility.id})`);
    console.log('─'.repeat(50));

    try {
      const resp = await page.goto(daysUrl, { waitUntil: 'networkidle', timeout: 15000 });
      const text = await page.textContent('body');
      console.log(`  Status: ${resp?.status()}`);
      console.log(`  Réponse: ${text?.substring(0, 500)}`);
      
      // Si on a des jours disponibles, chercher les heures
      if (text && text.startsWith('[') && text.length > 2) {
        try {
          const days = JSON.parse(text);
          if (days.length > 0) {
            console.log(`  🎉 ${days.length} jours disponibles!`);
            const firstDay = days[0].date;
            const timesUrl = `${BASE_URL}${COUNTRY_PATH}/schedule/${scheduleId}/appointment/times/${facility.id}.json?date=${firstDay}&appointments[expedite]=false`;
            console.log(`  ⏰ Recherche des heures pour ${firstDay}...`);
            
            const timesResp = await page.goto(timesUrl, { waitUntil: 'networkidle', timeout: 15000 });
            const timesText = await page.textContent('body');
            console.log(`  Times status: ${timesResp?.status()}`);
            console.log(`  Times: ${timesText?.substring(0, 500)}`);
          } else {
            console.log(`  ℹ️ Aucun jour disponible pour ${facility.name}`);
          }
        } catch {
          console.log(`  ⚠️ Impossible de parser la réponse JSON`);
        }
      }

      await page.waitForTimeout(1500);
    } catch (err) {
      console.log(`  ⚠️ Erreur: ${(err as Error).message?.substring(0, 100)}`);
    }
  }

  console.log('\n\n✅ Capture terminée!');
  await shutdown();
}

main().catch(err => {
  console.error('[FATAL]', err);
  saveAll();
  process.exit(1);
});
