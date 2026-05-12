/**
 * spain-manual-capture.ts — Script de capture réseau manuelle pour l'Espagne
 *
 * Lance un navigateur Playwright VISIBLE (non-headless) et capture
 * TOUTES les requêtes/réponses réseau vers citaconsular.es et bookitit.com
 *
 * Usage :
 *   npx tsx scripts/spain-manual-capture.ts
 *
 * Flux :
 *   1. Le navigateur s'ouvre sur citaconsular.es
 *   2. Tu passes le challenge Cloudflare manuellement
 *   3. Tu cliques sur l'alerte "Welcome / Bienvenido"
 *   4. Tu cliques sur "continuer/continuar"
 *   5. Tu attends le spinner et la redirection #services
 *   6. Tu vois le message "No hay horas disponibles"
 *   7. Quand tu fermes le navigateur → tout est sauvé dans captured/spain/
 *
 * Le fichier capture contient :
 *   - Toutes les requêtes (method, url, headers, body)
 *   - Toutes les réponses (status, headers, body)
 *   - Les cookies à chaque étape
 *   - Les redirections
 *   - Le timing de chaque requête
 *   - Les pages HTML complètes aux moments clés
 */

import { chromium, BrowserContext, Page, Request, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CapturedRequest {
  id: number;
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData: string | null;
  resourceType: string;
  isNavigationRequest: boolean;
  frame: string;
  page: string;
}

interface CapturedResponse {
  id: number;
  timestamp: string;
  requestId: number;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  bodyTruncated: boolean;
  timing: {
    startMs: number;
    endMs: number;
    durationMs: number;
  };
}

interface CapturedCookieSnapshot {
  timestamp: string;
  trigger: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: string;
    expires: number;
  }>;
}

interface CapturedPageSnapshot {
  timestamp: string;
  trigger: string;
  url: string;
  title: string;
  html: string;
}

interface CaptureData {
  startedAt: string;
  endedAt: string;
  targetUrl: string;
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  cookieSnapshots: CapturedCookieSnapshot[];
  pageSnapshots: CapturedPageSnapshot[];
  pages: Array<{ url: string; openedAt: string; closedAt?: string }>;
  apiCalls: Array<{
    url: string;
    method: string;
    status: number;
    timestamp: string;
    requestHeaders: Record<string, string>;
    responseHeaders: Record<string, string>;
    bodyPreview: string;
  }>;
}

const MAX_BODY_SIZE = 500_000; // 500KB max par body de réponse
const CAPTURE_DOMAINS = [
  'citaconsular.es',
  'bookitit.com',
  'cloudflare.com',
  'api.bookitit.com',
  'www.citaconsular.es'
];

function shouldCapture(url: string): boolean {
  return CAPTURE_DOMAINS.some(d => url.includes(d));
}

function isApiCall(url: string): boolean {
  return url.includes('api.bookitit.com') || url.includes('/api/');
}

const OUTPUT_DIR = path.join(__dirname, '..', 'captured', 'spain');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `capture-${Date.now()}.json`);

// Créer le dossier de sortie
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ESPAÑA Manual Capture — Playwright Network Inspector');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Le navigateur va s\'ouvrir. Fais le flow manuellement :');
  console.log('    1. Passe le challenge Cloudflare (case à cocher)');
  console.log('    2. Clique sur l\'alerte "Welcome / Bienvenido" (OK)');
  console.log('    3. Clique sur "continuer/continuar"');
  console.log('    4. Attends le spinner et la redirection #services');
  console.log('    5. Tu verras "No hay horas disponibles"');
  console.log('    6. Ferme le navigateur quand tu as fini');
  console.log('');
  console.log('  IMPORTANT : Laisse le navigateur ouvert pendant ta navigation');
  console.log('');
  console.log(`  Sortie : ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  const TARGET_URL = 'https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5';

  const capture: CaptureData = {
    startedAt: new Date().toISOString(),
    endedAt: '',
    targetUrl: TARGET_URL,
    requests: [],
    responses: [],
    cookieSnapshots: [],
    pageSnapshots: [],
    pages: [],
    apiCalls: [],
  };

  let requestCounter = 0;
  const requestIdMap = new Map<Request, number>();
  const requestStartTimes = new Map<number, number>();

  // Lancer le navigateur en mode VISIBLE
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ],
  });

  const context = await browser.newContext({
    viewport: null, // plein écran
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    timezoneId: 'Africa/Kinshasa',
    ignoreHTTPSErrors: true,
  });

  // ── Intercepter TOUTES les requêtes sur TOUTES les pages ──────────────────
  function attachPageListeners(page: Page, pageLabel: string) {
    page.on('request', (req: Request) => {
      const url = req.url();
      if (!shouldCapture(url)) return;

      requestCounter++;
      const id = requestCounter;
      requestIdMap.set(req, id);
      requestStartTimes.set(id, Date.now());

      const captured: CapturedRequest = {
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url,
        headers: req.headers(),
        postData: req.postData() ?? null,
        resourceType: req.resourceType(),
        isNavigationRequest: req.isNavigationRequest(),
        frame: req.frame()?.url() ?? '',
        page: pageLabel,
      };

      capture.requests.push(captured);
      console.log(`  → [${id}] ${req.method()} ${url.slice(0, 120)}`);
    });

    page.on('response', async (res: Response) => {
      const url = res.url();
      if (!shouldCapture(url)) return;

      const req = res.request();
      const reqId = requestIdMap.get(req) ?? 0;
      const startMs = requestStartTimes.get(reqId) ?? Date.now();
      const endMs = Date.now();

      let body: string | null = null;
      let bodyTruncated = false;

      try {
        const contentType = res.headers()['content-type'] ?? '';
        // Ne pas capturer les binaires (images, fonts, etc.)
        const isText = contentType.includes('text') ||
          contentType.includes('json') ||
          contentType.includes('javascript') ||
          contentType.includes('xml') ||
          contentType.includes('html') ||
          contentType.includes('form');

        if (isText) {
          const rawBody = await res.text().catch(() => null);
          if (rawBody) {
            if (rawBody.length > MAX_BODY_SIZE) {
              body = rawBody.slice(0, MAX_BODY_SIZE);
              bodyTruncated = true;
            } else {
              body = rawBody;
            }

            // Extraire les appels API spécifiques
            if (isApiCall(url)) {
              capture.apiCalls.push({
                url,
                method: req.method(),
                status: res.status(),
                timestamp: new Date().toISOString(),
                requestHeaders: req.headers(),
                responseHeaders: res.headers(),
                bodyPreview: rawBody.slice(0, 500)
              });
              console.log(`  🔍 API CALL: ${req.method()} ${url} → ${res.status()}`);
            }
          }
        }
      } catch {
        // Certaines réponses ne sont pas lisibles (streaming, etc.)
      }

      const captured: CapturedResponse = {
        id: capture.responses.length + 1,
        timestamp: new Date().toISOString(),
        requestId: reqId,
        url,
        status: res.status(),
        statusText: res.statusText(),
        headers: res.headers(),
        body,
        bodyTruncated,
        timing: {
          startMs,
          endMs,
          durationMs: endMs - startMs,
        },
      };

      capture.responses.push(captured);
      console.log(`  ← [${reqId}] ${res.status()} ${url.slice(0, 120)} (${endMs - startMs}ms)`);
    });

    // Capturer les logs console
    page.on('console', msg => {
      if (msg.text().includes('bookitit') || msg.text().includes('bkt') || msg.text().includes('api')) {
        console.log(`  [CONSOLE ${msg.type()}] ${msg.text()}`);
      }
    });

    // Snapshot cookies après chaque navigation
    page.on('load', async () => {
      await snapshotCookies(context, `page_load:${page.url()}`, capture);
    });

    // Snapshot HTML après chaque navigation complète
    page.on('load', async () => {
      try {
        const url = page.url();
        if (shouldCapture(url)) {
          const html = await page.content().catch(() => '');
          const title = await page.title().catch(() => '');
          capture.pageSnapshots.push({
            timestamp: new Date().toISOString(),
            trigger: 'page_load',
            url,
            title,
            html: html.slice(0, 1_000_000), // 1MB max
          });
          console.log(`  📄 Page snapshot: ${title} (${url.slice(0, 80)})`);
        }
      } catch { /* ignore */ }
    });

    // Capturer les dialogues d'alerte
    page.on('dialog', async dialog => {
      console.log(`  ⚠️  ALERTE: ${dialog.message()}`);
      await dialog.accept(); // Accepter automatiquement les alertes
    });
  }

  // ── Écouter les nouveaux onglets ──────────────────────────────────────────
  let pageCounter = 0;
  context.on('page', (newPage: Page) => {
    pageCounter++;
    const label = `tab_${pageCounter}`;
    capture.pages.push({ url: newPage.url(), openedAt: new Date().toISOString() });
    console.log(`\n  🆕 Nouvel onglet ouvert: ${label} → ${newPage.url()}`);
    attachPageListeners(newPage, label);

    newPage.on('close', () => {
      const entry = capture.pages.find(p => p.url === newPage.url() && !p.closedAt);
      if (entry) entry.closedAt = new Date().toISOString();
      console.log(`  ❌ Onglet fermé: ${label}`);
    });
  });

  // ── Page principale ───────────────────────────────────────────────────────
  const page = await context.newPage();
  pageCounter++;
  const mainLabel = `tab_${pageCounter}`;
  capture.pages.push({ url: TARGET_URL, openedAt: new Date().toISOString() });
  attachPageListeners(page, mainLabel);

  // Naviguer vers le widget España
  console.log(`  🌐 Navigation vers ${TARGET_URL}...\n`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Snapshot initial des cookies
  await snapshotCookies(context, 'initial', capture);

  // ── Attendre que l'utilisateur ferme le navigateur ────────────────────────
  console.log('\n  ⏳ En attente... Ferme le navigateur quand tu as terminé.\n');
  console.log('  💡 Rappel des étapes à faire manuellement:');
  console.log('     1. Passer le challenge Cloudflare');
  console.log('     2. Cliquer sur l\'alerte "Welcome / Bienvenido"');
  console.log('     3. Cliquer sur "continuer/continuar"');
  console.log('     4. Attendre la redirection #services');
  console.log('     5. Voir le message final');
  console.log('');

  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => resolve());
  });

  // ── Sauvegarder la capture ────────────────────────────────────────────────
  capture.endedAt = new Date().toISOString();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(capture, null, 2), 'utf-8');

  // Sauvegarder aussi un résumé des APIs
  const apiSummary = {
    totalRequests: capture.requests.length,
    totalResponses: capture.responses.length,
    totalApiCalls: capture.apiCalls.length,
    apis: capture.apiCalls.map(api => ({
      url: api.url,
      method: api.method,
      status: api.status,
      endpoint: api.url.split('?')[0].split('/').pop(),
      domain: new URL(api.url).hostname,
      timestamp: api.timestamp
    })),
    uniqueEndpoints: [...new Set(capture.apiCalls.map(api => 
      api.url.split('?')[0].split('/').pop()
    ))],
    captureTime: capture.startedAt,
    endTime: capture.endedAt
  };

  const summaryFile = path.join(OUTPUT_DIR, `api-summary-${Date.now()}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(apiSummary, null, 2), 'utf-8');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Capture terminée !`);
  console.log(`  📁 Fichier principal : ${OUTPUT_FILE}`);
  console.log(`  📁 Résumé API : ${summaryFile}`);
  console.log(`  📊 Stats :`);
  console.log(`     - ${capture.requests.length} requêtes capturées`);
  console.log(`     - ${capture.responses.length} réponses capturées`);
  console.log(`     - ${capture.apiCalls.length} appels API Bookitit`);
  console.log(`     - ${capture.cookieSnapshots.length} snapshots cookies`);
  console.log(`     - ${capture.pageSnapshots.length} snapshots HTML`);
  console.log(`     - ${capture.pages.length} onglets ouverts`);
  console.log('═══════════════════════════════════════════════════════════════');
}

async function snapshotCookies(context: BrowserContext, trigger: string, capture: CaptureData) {
  try {
    const cookies = await context.cookies();
    const relevant = cookies.filter(c =>
      c.domain.includes('citaconsular.es') ||
      c.domain.includes('bookitit.com') ||
      c.domain.includes('cloudflare.com')
    );
    if (relevant.length > 0) {
      capture.cookieSnapshots.push({
        timestamp: new Date().toISOString(),
        trigger,
        cookies: relevant.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expires: c.expires,
        })),
      });
    }
  } catch { /* ignore */ }
}

main().catch((err) => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});