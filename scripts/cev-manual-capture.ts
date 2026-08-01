/**
 * cev-manual-capture.ts — Capture manuelle complète pour CEV (Belgique)
 *
 * Ouvre un navigateur Playwright VISIBLE; vous vous connectez, naviguez,
 * résolvez les captchas et pouvez effectuer une réservation. Le script capture :
 *  - TOUTES les requêtes/réponses réseau (méthode, URL, en-têtes, corps texte)
 *  - Les cookies à chaque navigation
 *  - Les pages HTML (snapshots) après chargement
 *  - Les logs console
 *  - Un résumé des endpoints API
 *
 * À la fermeture du navigateur, tout est automatiquement sauvegardé dans
 *   scripts/../captured/cev/capture-<timestamp>.json
 * et un résumé dans
 *   scripts/../captured/cev/api-summary-<timestamp>.json
 *
 * Usage:
 *   - npx tsx scripts/cev-manual-capture.ts
 *   - Variables facultatives:
 *       TARGET_URL=https://appointment.cloud.diplomatie.be/
 *       CEV_CAPTURE_ALL=true  (pour capturer tous les domaines)
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
  timing: { startMs: number; endMs: number; durationMs: number };
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

const MAX_BODY_SIZE = 800_000; // 800KB max par body texte
const CAPTURE_DOMAINS = [
  'appointment.cloud.diplomatie.be',
  'cloud.diplomatie.be',
  'diplomatie.be',
  'microsoftonline.com',
  'live.com',
  'msauth',
  'aadcdn.msftauth.net',
  'office365.com',
];

function shouldCapture(url: string): boolean {
  if (process.env.CEV_CAPTURE_ALL === 'true') return true;
  return CAPTURE_DOMAINS.some(d => url.includes(d));
}

function isApiCall(url: string): boolean {
  return url.includes('/api/') || url.includes('/Home/') || url.includes('microsoftonline.com');
}

const OUTPUT_DIR = path.join(__dirname, '..', 'captured', 'cev');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `capture-${Date.now()}.json`);
const BUNDLES_DIR = path.join(OUTPUT_DIR, `bundles-${Date.now()}`);

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(BUNDLES_DIR)) {
  fs.mkdirSync(BUNDLES_DIR, { recursive: true });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CEV Manual Capture — Playwright Network Inspector');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log("  Le navigateur va s'ouvrir. Faites le flow manuellement :");
  console.log('    1. Connexion (si nécessaire)');
  console.log('    2. Résolution des captchas');
  console.log('    3. Affichage des rendez-vous et tentative de réservation');
  console.log('    4. Fermez le navigateur quand vous avez terminé');
  console.log('');
  console.log('  IMPORTANT : Laissez le navigateur ouvert pendant vos actions.');
  console.log('');
  console.log(`  Sortie : ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  const TARGET_URL = process.env.TARGET_URL || 'https://appointment.cloud.diplomatie.be/';

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

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    timezoneId: 'Africa/Kinshasa',
    ignoreHTTPSErrors: true,
  });

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
      console.log(`  → [${id}] ${req.method()} ${url.slice(0, 140)}`);
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
        const isText =
          contentType.includes('text') ||
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

            if (isApiCall(url)) {
              capture.apiCalls.push({
                url,
                method: req.method(),
                status: res.status(),
                timestamp: new Date().toISOString(),
                requestHeaders: req.headers(),
                responseHeaders: res.headers(),
                bodyPreview: rawBody.slice(0, 800),
              });
              console.log(`  🔍 API CALL: ${req.method()} ${url} → ${res.status()}`);
            }
          }
        }
      } catch {
        // ignore
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
        timing: { startMs, endMs, durationMs: endMs - startMs },
      };

      capture.responses.push(captured);
      console.log(`  ← [${reqId}] ${res.status()} ${url.slice(0, 140)} (${endMs - startMs}ms)`);
    });

    page.on('console', (msg) => {
      const t = msg.type();
      const text = msg.text();
      if (/(api|xhr|fetch|error|warn)/i.test(text)) {
        console.log(`  [CONSOLE ${t}] ${text}`);
      }
    });

    page.on('load', async () => {
      await snapshotCookies(context, `page_load:${page.url()}`, capture);
    });

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
            html: html.slice(0, 1_500_000), // 1.5MB max
          });
          console.log(`  📄 Page snapshot: ${title} (${url.slice(0, 100)})`);

          // Tenter de sauvegarder les bundles JS référencés par la page
          await saveBundlesFromPage(page).catch(() => {});
        }
      } catch {
        // ignore
      }
    });

    page.on('dialog', async (dialog) => {
      console.log(`  ⚠️  DIALOG: ${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });
  }

  let pageCounter = 0;
  context.on('page', (newPage: Page) => {
    pageCounter++;
    const label = `tab_${pageCounter}`;
    capture.pages.push({ url: newPage.url(), openedAt: new Date().toISOString() });
    console.log(`\n  🆕 Nouvel onglet: ${label} → ${newPage.url()}`);
    attachPageListeners(newPage, label);

    newPage.on('close', () => {
      const entry = capture.pages.find((p) => p.url === newPage.url() && !p.closedAt);
      if (entry) entry.closedAt = new Date().toISOString();
      console.log(`  ❌ Onglet fermé: ${label}`);
    });
  });

  const page = await context.newPage();
  pageCounter++;
  const mainLabel = `tab_${pageCounter}`;
  capture.pages.push({ url: TARGET_URL, openedAt: new Date().toISOString() });
  attachPageListeners(page, mainLabel);

  console.log(`  🌐 Navigation vers ${TARGET_URL}...\n`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {});

  await snapshotCookies(context, 'initial', capture);

  console.log('\n  ⏳ En attente... Fermez le navigateur quand vous avez terminé.\n');
  console.log('  Astuce: laissez cet onglet actif pendant vos actions.');
  console.log('');

  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => resolve());
  });

  capture.endedAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(capture, null, 2), 'utf-8');

  const apiSummary = {
    totalRequests: capture.requests.length,
    totalResponses: capture.responses.length,
    totalApiCalls: capture.apiCalls.length,
    apis: capture.apiCalls.map((api) => ({
      url: api.url,
      method: api.method,
      status: api.status,
      endpoint: api.url.split('?')[0],
      domain: (() => { try { return new URL(api.url).hostname; } catch { return ''; } })(),
      timestamp: api.timestamp,
    })),
    uniqueEndpoints: [...new Set(capture.apiCalls.map((api) => api.url.split('?')[0]))],
    captureTime: capture.startedAt,
    endTime: capture.endedAt,
  };

  const summaryFile = path.join(OUTPUT_DIR, `api-summary-${Date.now()}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(apiSummary, null, 2), 'utf-8');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ✅ Capture CEV terminée !');
  console.log(`  📁 Fichier principal : ${OUTPUT_FILE}`);
  console.log(`  📁 Résumé API : ${summaryFile}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

async function snapshotCookies(context: BrowserContext, trigger: string, capture: CaptureData) {
  try {
    const cookies = await context.cookies();
    const relevant = cookies.filter((c) =>
      c.domain.includes('diplomatie.be') ||
      c.domain.includes('microsoftonline.com') ||
      c.domain.includes('live.com')
    );
    if (relevant.length > 0) {
      capture.cookieSnapshots.push({
        timestamp: new Date().toISOString(),
        trigger,
        cookies: relevant.map((c) => ({
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
  } catch {
    // ignore
  }
}

async function saveBundlesFromPage(page: Page) {
  const pageUrl = page.url();
  let srcs: string[] = [];
  try {
    srcs = await page.evaluate(() => Array.from(document.scripts)
      .map(s => (s as HTMLScriptElement).src)
      .filter(Boolean) as string[]);
  } catch {
    srcs = [];
  }

  if (!srcs.length) return;

  const toAbs = (u: string) => {
    try { return new URL(u, pageUrl).toString(); } catch { return u; }
  };

  let saved = 0;
  for (const raw of srcs) {
    const url = toAbs(raw);
    if (!shouldCapture(url)) continue;
    try {
      const resp = await page.request.get(url);
      const ct = resp.headers()['content-type'] || '';
      const isText = /(javascript|text|json|xml|html)/i.test(ct);
      if (!isText) continue;
      const body = await resp.text();
      const u = new URL(url);
      const nameBase = (u.pathname.split('/').pop() || 'bundle.js').replace(/[^a-zA-Z0-9._-]/g, '_');
      const stamp = Date.now();
      const filePath = path.join(BUNDLES_DIR, `${stamp}-${nameBase}`);
      fs.writeFileSync(filePath, body, 'utf-8');
      saved++;
    } catch {
      // ignore per-bundle errors
    }
  }
  if (saved > 0) {
    console.log(`  📦 Bundles JS sauvegardés depuis la page: ${saved}`);
  }
}

main().catch((err) => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
