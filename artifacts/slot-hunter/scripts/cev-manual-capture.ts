/**
 * cev-manual-capture.ts — Script de capture réseau manuelle CEV
 *
 * Lance un navigateur Playwright VISIBLE (non-headless) et capture
 * TOUTES les requêtes/réponses réseau vers diplomatie.be et hcaptcha.
 *
 * Usage :
 *   npx tsx scripts/cev-manual-capture.ts
 *
 * Flux :
 *   1. Le navigateur s'ouvre sur visaonweb.diplomatie.be
 *   2. Tu te connectes manuellement
 *   3. Tu navigues vers "Mes demandes" / "My Applications"
 *   4. Tu cliques sur "Prendre rendez-vous" (bouton calendrier)
 *   5. Un nouvel onglet s'ouvre → page captcha CEV
 *   6. Tu résous le hCaptcha manuellement
 *   7. Le flow continue (calendrier, sélection date/heure, confirmation)
 *   8. Quand tu fermes le navigateur → tout est sauvé dans capture.json
 *
 * Le fichier capture.json contient :
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
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  cookieSnapshots: CapturedCookieSnapshot[];
  pageSnapshots: CapturedPageSnapshot[];
  pages: Array<{ url: string; openedAt: string; closedAt?: string }>;
}

const MAX_BODY_SIZE = 500_000; // 500KB max par body de réponse
const CAPTURE_DOMAINS = [
  'diplomatie.be',
  'appointment.cloud',
  'hcaptcha.com',
  'newassets.hcaptcha.com',
];

function shouldCapture(url: string): boolean {
  return CAPTURE_DOMAINS.some(d => url.includes(d));
}

const OUTPUT_FILE = path.join(__dirname, '..', 'capture.json');

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CEV Manual Capture — Playwright Network Inspector');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Le navigateur va s\'ouvrir. Fais le flow manuellement :');
  console.log('    1. Connecte-toi sur visaonweb.diplomatie.be');
  console.log('    2. Va dans "Mes demandes" / "My Applications"');
  console.log('    3. Clique sur le bouton calendrier "Prendre rendez-vous"');
  console.log('    4. Résous le hCaptcha dans le nouvel onglet');
  console.log('    5. Continue le flow (calendrier → date → heure → confirmer)');
  console.log('    6. Ferme le navigateur quand tu as fini');
  console.log('');
  console.log(`  Sortie : ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  const capture: CaptureData = {
    startedAt: new Date().toISOString(),
    endedAt: '',
    requests: [],
    responses: [],
    cookieSnapshots: [],
    pageSnapshots: [],
    pages: [],
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
    ],
  });

  const context = await browser.newContext({
    viewport: null, // plein écran
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'fr-BE',
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
  capture.pages.push({ url: 'https://visaonweb.diplomatie.be', openedAt: new Date().toISOString() });
  attachPageListeners(page, mainLabel);

  // Naviguer vers VOWINT
  console.log('  🌐 Navigation vers visaonweb.diplomatie.be...\n');
  await page.goto('https://visaonweb.diplomatie.be', { waitUntil: 'domcontentloaded' });

  // Snapshot initial des cookies
  await snapshotCookies(context, 'initial', capture);

  // ── Attendre que l'utilisateur ferme le navigateur ────────────────────────
  console.log('\n  ⏳ En attente... Ferme le navigateur quand tu as terminé.\n');

  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => resolve());
  });

  // ── Sauvegarder la capture ────────────────────────────────────────────────
  capture.endedAt = new Date().toISOString();

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(capture, null, 2), 'utf-8');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Capture terminée !`);
  console.log(`  📁 Fichier : ${OUTPUT_FILE}`);
  console.log(`  📊 Stats :`);
  console.log(`     - ${capture.requests.length} requêtes capturées`);
  console.log(`     - ${capture.responses.length} réponses capturées`);
  console.log(`     - ${capture.cookieSnapshots.length} snapshots cookies`);
  console.log(`     - ${capture.pageSnapshots.length} snapshots HTML`);
  console.log(`     - ${capture.pages.length} onglets ouverts`);
  console.log('═══════════════════════════════════════════════════════════════');
}

async function snapshotCookies(context: BrowserContext, trigger: string, capture: CaptureData) {
  try {
    const cookies = await context.cookies();
    const relevant = cookies.filter(c =>
      c.domain.includes('diplomatie.be') ||
      c.domain.includes('appointment.cloud') ||
      c.domain.includes('hcaptcha')
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
