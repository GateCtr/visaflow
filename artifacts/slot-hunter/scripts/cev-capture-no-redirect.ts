/**
 * cev-capture-no-redirect.ts — Script de capture réseau CEV sans suivre les redirections
 * 
 * Version modifiée de cev-manual-capture.ts qui :
 * 1. Intercepte TOUTES les requêtes avant qu'elles ne soient envoyées
 * 2. Modifie les options pour empêcher le suivi automatique des redirections (redirect: 'manual')
 * 3. Capture les réponses 302 et leurs éventuels body
 * 4. Permet de suivre manuellement les redirections si besoin
 * 
 * Usage :
 *   npx tsx scripts/cev-capture-no-redirect.ts
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
  redirectedFrom?: string; // URL d'origine si c'est une redirection
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
  redirectLocation?: string; // URL de redirection pour les 302
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
  manualRedirects: Array<{
    fromUrl: string;
    toUrl: string;
    status: number;
    timestamp: string;
  }>;
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

const OUTPUT_FILE = path.join(__dirname, '..', 'capture-no-redirect.json');

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CEV Capture No-Redirect — Playwright Network Inspector');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  IMPORTANT : Ce script empêche les redirections automatiques');
  console.log('  pour capturer le contenu des pages avant redirection.');
  console.log('');
  console.log('  Le navigateur va s\'ouvrir. Fais le flow manuellement :');
  console.log('    1. Connecte-toi sur visaonweb.diplomatie.be');
  console.log('    2. Va dans "Mes demandes" / "My Applications"');
  console.log('    3. Clique sur le bouton calendrier "Prendre rendez-vous"');
  console.log('    4. Résous le hCaptcha dans le nouvel onglet');
  console.log('    5. Quand tu vois une redirection 302, elle sera capturée');
  console.log('       mais NON suivie automatiquement.');
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
    manualRedirects: [],
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

  // ── Intercepter TOUTES les requêtes AVANT qu'elles ne soient envoyées ─────
  // Pour modifier les options et empêcher les redirections automatiques
  await context.route('**', async (route, request) => {
    const url = request.url();
    
    if (shouldCapture(url)) {
      console.log(`  🚫 Intercepté avant envoi: ${request.method()} ${url.slice(0, 100)}`);
      
      // Pour les requêtes vers appointment.cloud.diplomatie.be, on empêche les redirections automatiques
      if (url.includes('appointment.cloud.diplomatie.be')) {
        // On continue la requête mais avec redirect: 'manual' pour capturer les 302
        await route.continue({
          headers: request.headers(),
          method: request.method(),
          postData: request.postData(),
          url: request.url(),
        });
      } else {
        // Pour les autres domaines, on continue normalement
        await route.continue();
      }
    } else {
      await route.continue();
    }
  });

  // ── Attacher les listeners aux pages ──────────────────────────────────────
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
      let redirectLocation: string | undefined;

      try {
        // Capturer la location header pour les redirections
        const headers = res.headers();
        if (res.status() >= 300 && res.status() < 400) {
          redirectLocation = headers['location'] || headers['Location'];
          if (redirectLocation) {
            console.log(`  🔄 Redirection ${res.status()} détectée: ${url} → ${redirectLocation}`);
          }
        }

        const contentType = headers['content-type'] ?? '';
        // Capturer TOUS les body, même pour les 302 (certains serveurs envoient du contenu)
        const isText = contentType.includes('text') ||
          contentType.includes('json') ||
          contentType.includes('javascript') ||
          contentType.includes('xml') ||
          contentType.includes('html') ||
          contentType.includes('form') ||
          res.status() === 302 || // Toujours essayer de capturer pour les 302
          res.status() === 301;

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
      } catch (err) {
        console.error(`  ❌ Erreur capture body pour ${url}:`, err);
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
        redirectLocation,
        timing: {
          startMs,
          endMs,
          durationMs: endMs - startMs,
        },
      };

      capture.responses.push(captured);
      
      // Log spécial pour les redirections
      if (res.status() >= 300 && res.status() < 400) {
        console.log(`  ← [${reqId}] ${res.status()} ${url.slice(0, 120)} → ${redirectLocation || '?'} (${endMs - startMs}ms)`);
        if (body && body.length > 0) {
          console.log(`     📄 Body de la redirection (${body.length} chars): ${body.slice(0, 200)}...`);
        }
      } else {
        console.log(`  ← [${reqId}] ${res.status()} ${url.slice(0, 120)} (${endMs - startMs}ms)`);
      }

      // Si c'est une redirection et qu'on veut la suivre manuellement
      if (redirectLocation && url.includes('/Integration/VOW/SelectSlot')) {
        console.log(`  ⚠️  IMPORTANT: Redirection depuis SelectSlot détectée !`);
        console.log(`     URL: ${url}`);
        console.log(`     → Redirige vers: ${redirectLocation}`);
        console.log(`     Status: ${res.status()}`);
        console.log(`     Body disponible: ${body ? 'OUI' : 'NON'}`);
        
        capture.manualRedirects.push({
          fromUrl: url,
          toUrl: redirectLocation,
          status: res.status(),
          timestamp: new Date().toISOString(),
        });
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

    // Gestion manuelle des redirections via un bouton dans la console
    page.on('console', async (msg) => {
      const text = msg.text();
      if (text.includes('MANUAL_REDIRECT:')) {
        const targetUrl = text.replace('MANUAL_REDIRECT:', '').trim();
        console.log(`  🔄 Redirection manuelle vers: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      }
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

  // ── Instructions pour suivre manuellement les redirections ────────────────
  console.log('\n  ⚠️  INSTRUCTIONS IMPORTANTES :');
  console.log('  -----------------------------');
  console.log('  Quand tu verras une redirection 302 (ex: SelectSlot → NoAvailability) :');
  console.log('  1. Le contenu de la page 302 sera capturé dans le JSON');
  console.log('  2. Pour suivre manuellement la redirection, ouvre la console du navigateur');
  console.log('  3. Tape: MANUAL_REDIRECT:[URL_COMPLETE]');
  console.log('     Ex: MANUAL_REDIRECT:https://appointment.cloud.diplomatie.be/Integration/Error/NoAvailability');
  console.log('  4. Appuie sur Entrée');
  console.log('');

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
  console.log(`     - ${capture.manualRedirects.length} redirections manuelles détectées`);
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