/**
 * spain-cuba-capture.ts — Capture réseau complète Espagne & Cuba (citaconsular.es)
 *
 * STRATÉGIE :
 *   Playwright ouvre un navigateur RÉEL (headless=false) avec HAR recording natif.
 *   L'utilisateur navigue manuellement jusqu'à la dernière étape (booking confirmé ou bloqué).
 *   À la fermeture du navigateur (ou ENTER), tout est sauvegardé dans dump/capture/.
 *
 * CAPTURÉ :
 *   ✅ Challenge Cloudflare / Turnstile (headers CF, cf_clearance, jsd extraction)
 *   ✅ GET /es/hosteds/widgetdefault/{key}/   → page hôte + scripts Bookitit
 *   ✅ GET /main/                              → JSONP initial Bookitit
 *   ✅ JSONP getwidgetconfigurations/          → config widget + server URL
 *   ✅ JSONP getservices/                      → liste des services disponibles
 *   ✅ JSONP getagendas/                       → agendas par service
 *   ✅ JSONP datetime/                         → créneaux disponibles
 *   ✅ JSONP signup / signupfirstappointment   → création RDV (si tenté)
 *   ✅ JSONP signin / signedin / summary       → flow authentification + résumé
 *   ✅ JSONP freetempevent/                    → libération slot temporaire
 *   ✅ Tous les cookies à chaque étape (PHPSESSID, cf_clearance, bktToken, etc.)
 *   ✅ Headers complets (Sec-Fetch-*, Accept, Priority, CH hints)
 *   ✅ Payloads POST complets
 *   ✅ Réponses complètes (body + status + Set-Cookie)
 *   ✅ Contenu HTML rendu des pages clés
 *   ✅ Console JS du navigateur (erreurs, logs Bookitit)
 *
 * UTILISATION :
 *   cd artifacts/slot-hunter
 *   pnpm exec tsx src/debug/spain-cuba-capture.ts
 *
 *   → Naviguer sur citaconsular.es (Spain puis Cuba si possible)
 *   → Passer le challenge CF
 *   → Aller jusqu'au booking (ou aussi loin que possible)
 *   → Fermer le navigateur OU appuyer ENTER dans ce terminal
 *   → Les fichiers sont sauvegardés dans dump/capture/
 *
 * PORTALS :
 *   Spain : https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/
 *   Cuba  : même portail citaconsular.es, widget différent (sera détecté automatiquement)
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── Configuration ─────────────────────────────────────────────────────────

const WINDOW_WIDTH  = 1440;
const WINDOW_HEIGHT = 900;

// Démarrer sur le portail Spain — l'utilisateur peut naviguer vers Cuba ensuite
const START_URL = process.env.START_URL
  ?? 'https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/';

// Dossier de sortie : dump/capture/ à la racine du projet
const PROJECT_ROOT   = path.resolve(process.cwd(), '..', '..');
const DUMP_DIR       = path.join(PROJECT_ROOT, 'dump', 'capture');

// ─── Types HAR ─────────────────────────────────────────────────────────────

interface HarNameValue { name: string; value: string }
interface HarContent   { mimeType: string; text?: string; size: number }
interface HarResponse  {
  status: number; statusText: string;
  headers: HarNameValue[]; content: HarContent; redirectURL: string;
}
interface HarRequest {
  method: string; url: string;
  headers: HarNameValue[]; postData?: { mimeType: string; text: string };
  cookies: HarNameValue[];
}
interface HarEntry {
  startedDateTime: string; time: number;
  request: HarRequest; response: HarResponse;
}
interface Har { log: { entries: HarEntry[] } }

// ─── Types dump structuré ──────────────────────────────────────────────────

interface CapturedRequest {
  ts: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestHeadersOrder: string[];
  requestCookies: HarNameValue[];
  requestBody?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseSetCookies: string[];
  responseBody?: string;
  durationMs: number;
  category: string;
}

interface SpainCaptureDump {
  description: string;
  generatedAt: string;
  startUrl: string;
  summary: {
    totalRequests: number;
    cfChallengeDetected: boolean;
    cfClearanceCookiePresent: boolean;
    bookititServerUrl: string | null;
    widgetsDetected: string[];
    bookingAttempted: boolean;
    bookingSucceeded: boolean;
    signupPayloads: number;
    categoryCounts: Record<string, number>;
  };
  consoleLogs: Array<{ ts: string; type: string; text: string }>;
  cfChallenge?: {
    challengeUrl: string;
    cfRayHeader?: string;
    cfClearanceCookie?: string;
    jsdNonce?: string;
    challengePageHtml?: string;
  };
  widgetInit?: {
    hostPageUrl: string;
    hostPageHtmlPreview: string;
    mainJsonpUrl?: string;
    mainJsonpBody?: string;
    widgetKey?: string;
    bookititServerUrl?: string;
  };
  bookititFlow: CapturedRequest[];
  allRequests: CapturedRequest[];
  cookieSnapshot: Array<{ name: string; value: string; domain: string; path: string }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function headersToMap(headers: HarNameValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

function getHeader(headers: HarNameValue[], name: string): string | undefined {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function getAllSetCookies(headers: HarNameValue[]): string[] {
  return headers.filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value);
}

function categorize(url: string, method: string): string {
  if (url.includes('cdn-cgi/challenge') || url.includes('challenges.cloudflare') || url.includes('/turnstile/')) return 'cf_challenge';
  if (url.includes('/main/') && url.includes('bookitit')) return 'bookitit_main';
  if (url.includes('getwidgetconfigurations')) return 'bookitit_config';
  if (url.includes('getservices')) return 'bookitit_getservices';
  if (url.includes('getagendas')) return 'bookitit_getagendas';
  if (url.includes('datetime')) return 'bookitit_datetime';
  if (url.includes('signup') && !url.includes('signout')) return 'bookitit_signup';
  if (url.includes('signin') || url.includes('signedin')) return 'bookitit_signin';
  if (url.includes('summary')) return 'bookitit_summary';
  if (url.includes('freetempevent')) return 'bookitit_freetempevent';
  if (url.includes('confirmclient')) return 'bookitit_confirm';
  if (url.includes('bookitit.com') || url.includes('/onlinebookings/')) return 'bookitit_other';
  if (url.includes('citaconsular.es')) return 'citaconsular_portal';
  if (url.includes('cloudflare') || url.includes('cf-')) return 'cloudflare';
  if (method === 'POST') return 'post_other';
  return 'other';
}

function extractWidgetKey(url: string): string | undefined {
  const m = url.match(/widgetdefault\/([a-f0-9]+)/);
  return m?.[1];
}

function extractBookititServer(text: string): string | null {
  // Bookitit server URL est souvent du type https://<subdomain>.bookitit.com/onlinebookings/
  const m = text.match(/https?:\/\/[a-z0-9-]+\.bookitit\.com\/[a-zA-Z0-9_/-]+\//);
  return m?.[0] ?? null;
}

function extractJsdNonce(html: string): string | undefined {
  // CF JSD nonce : apparaît comme data-ray ou data-cf-settings ou dans un script inline
  const m = html.match(/([0-9]+\.[0-9]+:[0-9]+)/);
  return m?.[1];
}

// ─── Reconstruction du dump depuis le HAR ──────────────────────────────────

function buildDump(
  har: Har,
  consoleLogs: Array<{ ts: string; type: string; text: string }>,
  cookieSnapshot: Array<{ name: string; value: string; domain: string; path: string }>,
): SpainCaptureDump {
  const entries = har.log.entries;
  const allRequests: CapturedRequest[] = [];
  const bookititFlow: CapturedRequest[] = [];

  let cfChallengeDetected = false;
  let cfClearanceCookiePresent = false;
  let bookititServerUrl: string | null = null;
  const widgetsDetected: string[] = [];
  let bookingAttempted = false;
  let bookingSucceeded = false;
  let signupPayloads = 0;
  const categoryCounts: Record<string, number> = {};

  let cfChallenge: SpainCaptureDump['cfChallenge'] | undefined;
  let widgetInit: SpainCaptureDump['widgetInit'] | undefined;

  for (const e of entries) {
    const url = e.request.url;
    const method = e.request.method;
    const cat = categorize(url, method);
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;

    const reqHeaders = headersToMap(e.request.headers);
    const resHeaders = headersToMap(e.response.headers);
    const resSetCookies = getAllSetCookies(e.response.headers);
    const resBody = e.response.content.text;

    const captured: CapturedRequest = {
      ts: e.startedDateTime,
      method,
      url,
      requestHeaders: reqHeaders,
      requestHeadersOrder: e.request.headers.map(h => h.name),
      requestCookies: e.request.cookies,
      requestBody: e.request.postData?.text,
      responseStatus: e.response.status,
      responseHeaders: resHeaders,
      responseSetCookies: resSetCookies,
      responseBody: resBody ? resBody.slice(0, 20_000) : undefined,
      durationMs: Math.round(e.time),
      category: cat,
    };

    allRequests.push(captured);

    // ── CF Challenge ────────────────────────────────────────────────────────
    if (cat === 'cf_challenge' || (url.includes('citaconsular.es') && e.response.status === 403)) {
      cfChallengeDetected = true;
    }

    // Détecter cf_clearance dans les Set-Cookie de n'importe quelle réponse
    for (const sc of resSetCookies) {
      if (sc.includes('cf_clearance')) {
        cfClearanceCookiePresent = true;
        if (!cfChallenge) {
          cfChallenge = {
            challengeUrl: url,
            cfRayHeader: reqHeaders['cf-ray'] ?? resHeaders['cf-ray'],
            cfClearanceCookie: sc,
          };
        } else {
          cfChallenge.cfClearanceCookie = sc;
        }
      }
    }

    // Page challenge HTML (403 ou page CF interactive)
    if (
      url.includes('citaconsular.es') &&
      (e.response.status === 403 || (resBody ?? '').includes('challenges.cloudflare')) &&
      resBody
    ) {
      cfChallengeDetected = true;
      if (!cfChallenge) cfChallenge = { challengeUrl: url };
      cfChallenge.challengePageHtml = resBody.slice(0, 10_000);
      cfChallenge.jsdNonce = extractJsdNonce(resBody);
    }

    // ── Widget host page ────────────────────────────────────────────────────
    if (url.includes('citaconsular.es') && url.includes('widgetdefault') && method === 'GET') {
      const key = extractWidgetKey(url);
      if (key && !widgetsDetected.includes(key)) widgetsDetected.push(key);

      if (!widgetInit) {
        widgetInit = {
          hostPageUrl: url,
          hostPageHtmlPreview: (resBody ?? '').slice(0, 5_000),
          widgetKey: key,
        };
      }
    }

    // ── /main/ JSONP ────────────────────────────────────────────────────────
    if (cat === 'bookitit_main' && widgetInit) {
      widgetInit.mainJsonpUrl = url;
      widgetInit.mainJsonpBody = (resBody ?? '').slice(0, 5_000);
      if (resBody) {
        const srv = extractBookititServer(resBody);
        if (srv) {
          widgetInit.bookititServerUrl = srv;
          bookititServerUrl = srv;
        }
      }
    }

    // ── Bookitit server URL depuis getwidgetconfigurations ──────────────────
    if (cat === 'bookitit_config' && resBody && !bookititServerUrl) {
      bookititServerUrl = extractBookititServer(resBody);
      if (widgetInit && bookititServerUrl) widgetInit.bookititServerUrl = bookititServerUrl;
    }

    // ── Requêtes Bookitit pertinentes ───────────────────────────────────────
    if (cat.startsWith('bookitit_') || cat.startsWith('citaconsular_')) {
      bookititFlow.push(captured);
    }

    // ── Signup / booking ────────────────────────────────────────────────────
    if (cat === 'bookitit_signup') {
      bookingAttempted = true;
      signupPayloads++;
      if (e.response.status === 200 && resBody?.includes('"ok"')) {
        bookingSucceeded = true;
      }
    }
  }

  // Enrichir cfChallenge avec les cookies capturés en fin de session
  if (cfChallenge) {
    const clearanceCookie = cookieSnapshot.find(c => c.name === 'cf_clearance');
    if (clearanceCookie) {
      cfChallenge.cfClearanceCookie = `cf_clearance=${clearanceCookie.value}`;
      cfClearanceCookiePresent = true;
    }
  }

  return {
    description: 'Capture réseau manuelle Spain/Cuba — citaconsular.es (Bookitit)',
    generatedAt: new Date().toISOString(),
    startUrl: START_URL,
    summary: {
      totalRequests: allRequests.length,
      cfChallengeDetected,
      cfClearanceCookiePresent,
      bookititServerUrl,
      widgetsDetected,
      bookingAttempted,
      bookingSucceeded,
      signupPayloads,
      categoryCounts,
    },
    consoleLogs,
    cfChallenge,
    widgetInit,
    bookititFlow,
    allRequests,
    cookieSnapshot,
  };
}

// ─── Affichage terminal ─────────────────────────────────────────────────────

function printSummary(dump: SpainCaptureDump): void {
  const s = dump.summary;
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║         RÉSUMÉ CAPTURE SPAIN / CUBA — citaconsular.es           ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`\n📊 Requêtes totales  : ${s.totalRequests}`);
  console.log(`🛡️  CF Challenge      : ${s.cfChallengeDetected ? '✅ détecté' : '❌ non vu'}`);
  console.log(`🍪 cf_clearance      : ${s.cfClearanceCookiePresent ? '✅ capturé' : '❌ absent'}`);
  console.log(`🌐 Bookitit server   : ${s.bookititServerUrl ?? '(non extrait)'}`);
  console.log(`🔑 Widgets détectés  : ${s.widgetsDetected.join(', ') || '(aucun)'}`);
  console.log(`📅 Booking tenté     : ${s.bookingAttempted ? '✅' : '❌'}`);
  console.log(`✅ Booking réussi    : ${s.bookingSucceeded ? '✅' : '❌'}`);

  console.log('\n📂 Catégories :');
  for (const [cat, count] of Object.entries(s.categoryCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${cat.padEnd(35)} ${count}`);
  }

  if (dump.cfChallenge) {
    console.log('\n🛡️  CF Challenge :');
    console.log(`   URL          : ${dump.cfChallenge.challengeUrl.slice(0, 80)}`);
    console.log(`   cf-ray       : ${dump.cfChallenge.cfRayHeader ?? '(absent)'}`);
    console.log(`   jsd nonce    : ${dump.cfChallenge.jsdNonce ?? '(non extrait)'}`);
    console.log(`   clearance    : ${dump.cfChallenge.cfClearanceCookie?.split(';')[0].slice(0, 60) ?? '(absent)'}…`);
  }

  if (dump.widgetInit) {
    console.log('\n🧩 Widget Bookitit :');
    console.log(`   Host URL     : ${dump.widgetInit.hostPageUrl.slice(0, 80)}`);
    console.log(`   Widget key   : ${dump.widgetInit.widgetKey ?? '(non extrait)'}`);
    console.log(`   Server URL   : ${dump.widgetInit.bookititServerUrl ?? '(non extrait)'}`);
    console.log(`   /main/ URL   : ${dump.widgetInit.mainJsonpUrl ?? '(non capturé)'}`);
  }

  console.log('\n📋 Flow Bookitit (' + dump.bookititFlow.length + ' requêtes) :');
  for (const r of dump.bookititFlow.slice(0, 30)) {
    const body = r.requestBody ? ` [body: ${r.requestBody.slice(0, 60)}]` : '';
    const cookies = r.requestCookies.map(c => c.name).join(', ');
    console.log(`   [${r.method}] ${r.responseStatus} ${r.url.slice(0, 80)}`);
    if (body) console.log(`      ↳ ${body}`);
    if (cookies) console.log(`      🍪 ${cookies}`);
  }
  if (dump.bookititFlow.length > 30) {
    console.log(`   … +${dump.bookititFlow.length - 30} autres`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════\n');
}

// ─── Sauvegarde ─────────────────────────────────────────────────────────────

let isSaving = false;

async function saveAll(
  harPath: string,
  consoleLogs: Array<{ ts: string; type: string; text: string }>,
  page: Page | null,
): Promise<void> {
  if (isSaving) { console.log('\n⚠️  Déjà en cours de sauvegarde...'); return; }
  isSaving = true;

  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });

    if (!fs.existsSync(harPath)) {
      console.error(`❌ Fichier HAR introuvable : ${harPath}`);
      return;
    }

    // Snapshot des cookies depuis la page active
    let cookieSnapshot: Array<{ name: string; value: string; domain: string; path: string }> = [];
    if (page) {
      try {
        const ctx = page.context();
        const allCookies = await ctx.cookies();
        cookieSnapshot = allCookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
        }));
      } catch { /* page déjà fermée */ }
    }

    const harRaw = fs.readFileSync(harPath, 'utf-8');
    const har: Har = JSON.parse(harRaw);
    console.log(`\n📦 HAR chargé : ${har.log.entries.length} entrées`);

    const dump = buildDump(har, consoleLogs, cookieSnapshot);
    printSummary(dump);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // ── 1. HAR brut ─────────────────────────────────────────────────────────
    const harDest = path.join(DUMP_DIR, `${ts}-raw.har`);
    fs.copyFileSync(harPath, harDest);
    console.log(`✅ HAR brut              : ${harDest}`);

    // ── 2. Dump complet (allRequests + flow + cookies + console) ────────────
    const fullDest = path.join(DUMP_DIR, `${ts}-full-capture.json`);
    fs.writeFileSync(fullDest, JSON.stringify(dump, null, 2));
    console.log(`✅ Capture complète      : ${fullDest}`);

    // ── 3. Flow Bookitit seul (plus léger, facile à analyser) ───────────────
    const flowDest = path.join(DUMP_DIR, `${ts}-bookitit-flow.json`);
    fs.writeFileSync(flowDest, JSON.stringify({
      description: 'Flow Bookitit extrait — Spain/Cuba citaconsular.es',
      generatedAt: new Date().toISOString(),
      summary: dump.summary,
      cfChallenge: dump.cfChallenge,
      widgetInit: dump.widgetInit,
      flow: dump.bookititFlow,
    }, null, 2));
    console.log(`✅ Flow Bookitit         : ${flowDest}`);

    // ── 4. Cookies snapshot ─────────────────────────────────────────────────
    const cookieDest = path.join(DUMP_DIR, `${ts}-cookies.json`);
    fs.writeFileSync(cookieDest, JSON.stringify({
      description: 'Snapshot cookies fin de session',
      capturedAt: new Date().toISOString(),
      cookies: cookieSnapshot,
    }, null, 2));
    console.log(`✅ Cookies snapshot      : ${cookieDest}`);

    // ── 5. Logs console navigateur ──────────────────────────────────────────
    if (consoleLogs.length > 0) {
      const logsDest = path.join(DUMP_DIR, `${ts}-console-logs.json`);
      fs.writeFileSync(logsDest, JSON.stringify({
        description: 'Logs console navigateur',
        count: consoleLogs.length,
        logs: consoleLogs,
      }, null, 2));
      console.log(`✅ Console logs         : ${logsDest}`);
    }

    // ── 6. Résumé lisible ───────────────────────────────────────────────────
    const summaryDest = path.join(DUMP_DIR, `${ts}-summary.json`);
    fs.writeFileSync(summaryDest, JSON.stringify({
      description: 'Résumé capture Spain/Cuba',
      ...dump.summary,
      cfChallenge: dump.cfChallenge ? {
        url: dump.cfChallenge.challengeUrl,
        cfRay: dump.cfChallenge.cfRayHeader,
        clearanceCookiePresent: !!dump.cfChallenge.cfClearanceCookie,
        jsdNonce: dump.cfChallenge.jsdNonce,
      } : null,
      widgetInit: dump.widgetInit ? {
        url: dump.widgetInit.hostPageUrl,
        widgetKey: dump.widgetInit.widgetKey,
        bookititServerUrl: dump.widgetInit.bookititServerUrl,
        mainJsonpUrl: dump.widgetInit.mainJsonpUrl,
      } : null,
    }, null, 2));
    console.log(`✅ Résumé               : ${summaryDest}`);

  } catch (err) {
    console.error('❌ Erreur sauvegarde :', err);
  } finally {
    isSaving = false;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔬 SPAIN / CUBA CAPTURE — citaconsular.es (Bookitit)');
  console.log('   Capture HAR complète : CF challenge + flow Bookitit complet');
  console.log('═══════════════════════════════════════════════════════════════\n');

  fs.mkdirSync(DUMP_DIR, { recursive: true });

  const harPath = path.join(DUMP_DIR, '_playwright_recording.har');
  const consoleLogs: Array<{ ts: string; type: string; text: string }> = [];

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let activePage: Page | null = null;

  try {
    console.log('🚀 Lancement du navigateur Chrome...');
    browser = await chromium.launch({
      headless: false,
      channel: 'chromium',  // utiliser Chromium bundlé Playwright
      args: [
        `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    // ── Context avec HAR recording natif ──────────────────────────────────
    context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      recordHar: {
        path: harPath,
        mode: 'full',
        content: 'embed',
        urlFilter: /.*/,
      },
      // Headers additionnels pour ressembler à Chrome réel
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });

    // ── Logs console navigateur ────────────────────────────────────────────
    context.on('page', (newPage: Page) => {
      console.log(`\n📑 [NOUVEL ONGLET] ${newPage.url() || '(en cours de chargement)'}`);
      newPage.on('console', (msg) => {
        const text = msg.text();
        // Filtrer les logs utiles seulement
        const useful = text.includes('bookitit') || text.includes('bkt') || text.includes('widget')
          || text.includes('error') || text.includes('Error') || msg.type() === 'error';
        if (useful) {
          consoleLogs.push({ ts: new Date().toISOString(), type: msg.type(), text: text.slice(0, 500) });
          if (msg.type() === 'error') {
            console.log(`  💬 [console.error] ${text.slice(0, 120)}`);
          }
        }
      });
    });

    // ── Listener temps réel ────────────────────────────────────────────────
    context.on('response', async (response) => {
      try {
        const url = response.url();
        const status = response.status();
        const cat = categorize(url, response.request().method());

        // Afficher les cibles intéressantes en temps réel
        const isInteresting = cat !== 'other' && cat !== 'cloudflare';
        if (isInteresting) {
          const method = response.request().method();
          const emoji = cat.startsWith('bookitit_') ? '🎯' : cat.startsWith('cf_') ? '🛡️ ' : '🌐';
          console.log(`${emoji} [${method}] HTTP ${status} — ${url.slice(0, 100)}`);

          // Si c'est une étape de booking, alerter
          if (cat === 'bookitit_signup') {
            console.log('  🎉 SIGNUP/BOOKING DÉTECTÉ !');
          }
          if (cat === 'bookitit_summary') {
            console.log('  📋 SUMMARY DÉTECTÉ !');
          }
          if (cat === 'bookitit_freetempevent') {
            console.log('  🕐 FREETEMPEVENT (libération slot temp) DÉTECTÉ !');
          }
        }

        // CF clearance
        if (url.includes('citaconsular.es')) {
          const setCookieHeader = response.headers()['set-cookie'];
          if (setCookieHeader?.includes('cf_clearance')) {
            console.log('  ✅ cf_clearance capturé !');
          }
        }
      } catch { /* page déjà fermée */ }
    });

    const page = await context.newPage();
    activePage = page;

    // Capturer les logs de la page principale aussi
    page.on('console', (msg) => {
      const text = msg.text();
      const useful = text.includes('bookitit') || text.includes('bkt') || text.includes('widget')
        || msg.type() === 'error';
      if (useful) {
        consoleLogs.push({ ts: new Date().toISOString(), type: msg.type(), text: text.slice(0, 500) });
      }
    });

    const ua = await page.evaluate(() => navigator.userAgent).catch(() => '(inconnu)');
    console.log(`[UA] ${ua}\n`);

    // Naviguer vers le portail Spain
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // ── Instructions utilisateur ───────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('🔍 NAVIGATEUR PRÊT — Instructions :');
    console.log('');
    console.log('  SPAIN (citaconsular.es) :');
    console.log('  1. Passer le challenge Cloudflare si présent');
    console.log('  2. Sélectionner le service visa (ex: RDC → Espagne)');
    console.log('  3. Choisir une agenda/consulat');
    console.log('  4. Sélectionner une date et un horaire');
    console.log('  5. Remplir le formulaire signup si disponible');
    console.log('  6. Aller jusqu\'au summary / confirmation');
    console.log('');
    console.log('  CUBA (même portail) :');
    console.log('  → Naviguer vers un widget Cuba si vous avez l\'URL');
    console.log('  → Répéter le même flow');
    console.log('');
    console.log('  CIBLES SURVEILLÉES EN TEMPS RÉEL :');
    console.log('  🛡️  CF challenge (challenges.cloudflare.com)');
    console.log('  🌐 Portal citaconsular.es');
    console.log('  🎯 Bookitit : getwidgetconfigurations, getservices,');
    console.log('     getagendas, datetime, signup, signin, summary, freetempevent');
    console.log('');
    console.log('  ► Fermer le navigateur OU appuyer ENTER pour terminer');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // ── Attente fermeture navigateur ou ENTER ──────────────────────────────
    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      rl.on('line', () => {
        console.log('\n⏸️  ENTER détecté — sauvegarde...');
        rl.close();
        resolve();
      });

      browser!.on('disconnected', () => {
        console.log('\n⚠️  Navigateur fermé — sauvegarde...');
        rl.close();
        resolve();
      });

      process.on('SIGINT', () => {
        console.log('\n⚠️  Ctrl+C — sauvegarde...');
        rl.close();
        resolve();
      });
    });

    // ── Fermer le context pour écrire le HAR ──────────────────────────────
    console.log('\n💾 Fermeture du contexte (écriture HAR sur disque)...');
    const pageBeforeClose = activePage;
    try { await context.close(); } catch { /* ignore */ }
    context = null;

    // Laisser Playwright finir l'écriture du HAR
    await new Promise(r => setTimeout(r, 1_500));

    await saveAll(harPath, consoleLogs, pageBeforeClose);

  } catch (err) {
    console.error('\n❌ Erreur :', err);
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
    try { await saveAll(harPath, consoleLogs, activePage); } catch { /* ignore */ }
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    console.log(`\n✅ Capture terminée. Fichiers dans : ${DUMP_DIR}`);
    process.exit(0);
  }
}

main().catch(console.error);
