/**
 * CEV Network Sniffer v2 — Capture complète via HAR recording natif Playwright
 *
 * STRATÉGIE :
 *   Playwright enregistre un fichier HAR (HTTP Archive) nativement — il capture
 *   TOUT : POST bodies, Set-Cookie, redirects 302, headers exacts, timing.
 *   Plus fiable que l'interception manuelle d'événements (pas de race condition,
 *   pas de timing issue, pas de perte lors des recharges de page).
 *
 * FLUX CAPTURÉ :
 *   ✅ GET  /GetEAppointmentUrl                    → URL d'intégration (visaonweb)
 *   ✅ GET  /Integration/VOW/{orgId}/{...}          → fetch URL intégration (appointment)
 *   ✅ POST /Captcha/SetCaptchaToken                → payload token + réponse JSON (redirectUrl)
 *   ✅ Set-Cookie OSOnline                         → cookie OutSystems posé sur la réponse du POST
 *   ✅ GET  /Integration/VOW/SelectSlot (via 302)   → chaîne redirection post-captcha
 *   ✅ GET  /Integration/Error/NoAvailability        → verdict "pas de créneaux"
 *   ✅ GET  /Integration/Error/SessionExpired        → verdict "session expirée"
 *
 * NOUVEAUTÉS v2 :
 *   - recordHar() natif Playwright : POST body + Set-Cookie complets, zéro perte
 *   - Auto-save déclenché 5s après réception du POST SetCaptchaToken (+ redirects)
 *   - ENTER reste disponible pour terminer manuellement à tout moment
 *   - Reconstruction du flux depuis le HAR (plus fiable que les événements)
 *   - Dump dédié "integration_flow.json" avec cookies OSOnline mis en évidence
 *
 * UTILISATION :
 *   pnpm --filter @workspace/slot-hunter exec tsx src/debug/cev-network-sniffer.ts
 *   → Naviguer manuellement sur le site CEV
 *   → Le sniffer sauvegarde automatiquement après le POST captcha
 *   → Ou appuyer sur ENTER dans le terminal pour terminer manuellement
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── Configuration ────────────────────────────────────────────────────────────

const WINDOW_WIDTH  = 1366;
const WINDOW_HEIGHT = 768;

const PROJECT_ROOT   = path.join(process.cwd(), '..', '..');
const DEBUG_DUMP_DIR = path.join(PROJECT_ROOT, 'debug_dumps');

/** Délai (ms) après réception du SetCaptchaToken avant de sauvegarder.
 *  Permet de capturer la chaîne de redirections post-captcha dans le HAR. */
const POST_CAPTCHA_SAVE_DELAY_MS = 6_000;

// ─── Types HAR (subset utilisé) ──────────────────────────────────────────────

interface HarNameValue  { name: string; value: string }
interface HarContent    { mimeType: string; text?: string; size: number }
interface HarResponse {
  status: number;
  statusText: string;
  headers: HarNameValue[];
  content: HarContent;
  redirectURL: string;
}
interface HarRequest {
  method: string;
  url: string;
  headers: HarNameValue[];
  postData?: { mimeType: string; text: string };
  cookies: HarNameValue[];
}
interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
}
interface HarLog { entries: HarEntry[] }
interface Har    { log: HarLog }

// ─── Flux integration reconstruit ────────────────────────────────────────────

interface HopInfo {
  url: string;
  status: number;
  locationHeader?: string;
  setCookieHeaders?: string[];
  bodyPreview?: string;
  duration?: number;
}

interface IntegrationFlow {
  getEAppointmentUrl?: {
    url: string;
    responseBody: string;
    integrationUrl: string | null;
    timestamp: string;
  };
  integrationVowFetch?: {
    url: string;
    requestHeaders: Record<string, string>;
    requestCookies: HarNameValue[];
    responseStatus: number;
    locationHeader?: string;
    timestamp: string;
  };
  captchaPageLoad?: {
    url: string;
    responseStatus: number;
    aspNetSessionId?: string;
    timestamp: string;
  };
  setCaptchaToken?: {
    url: string;
    requestHeaders: Record<string, string>;
    requestHeadersOrder: string[];
    requestCookies: HarNameValue[];
    requestBody: string;
    responseStatus: number;
    responseBody: string;
    responseJson?: {
      captchaSolved?: boolean;
      validUntil?: string | null;
      redirectUrl?: string | null;
    };
    /** Cookies posés dans la réponse du POST — chercher OSOnline ici */
    responseSetCookies: string[];
    /** Cookie OSOnline extrait (la pièce critique) */
    osOnlineCookie?: string;
    timestamp: string;
  };
  postCaptchaRedirectChain?: {
    startUrl: string;
    hops: HopInfo[];
    finalUrl: string;
    verdict: 'slots_available' | 'no_availability' | 'session_expired' | 'multi_session' | 'error' | 'unknown';
  };
  verdict?: string;
  verdictUrl?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function headersToMap(headers: HarNameValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

function getHeader(headers: HarNameValue[], name: string): string | undefined {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function getAllHeaders(headers: HarNameValue[], name: string): string[] {
  return headers.filter(h => h.name.toLowerCase() === name.toLowerCase()).map(h => h.value);
}

function classifyVerdict(urls: string[]): IntegrationFlow['postCaptchaRedirectChain'] extends undefined ? never : NonNullable<IntegrationFlow['postCaptchaRedirectChain']>['verdict'] {
  const joined = urls.join(' ');
  if (joined.includes('NoAvailability'))      return 'no_availability';
  if (joined.includes('MultiSessionNotAllowed')) return 'multi_session';
  if (joined.includes('SessionExpired'))      return 'session_expired';
  if (joined.includes('/Error/'))             return 'error';
  if (joined.includes('SelectSlot'))          return 'slots_available';
  return 'unknown';
}

function resolveUrl(maybeRelative: string, base = 'https://appointment.cloud.diplomatie.be'): string {
  if (maybeRelative.startsWith('http')) return maybeRelative;
  if (maybeRelative.startsWith('/'))    return `${base}${maybeRelative}`;
  return `${base}/${maybeRelative}`;
}

// ─── Reconstruction du flux depuis le HAR ─────────────────────────────────────

function buildIntegrationFlowFromHar(har: Har): IntegrationFlow {
  const flow: IntegrationFlow = {};
  const entries = har.log.entries;

  // ── 1. GetEAppointmentUrl ──────────────────────────────────────────────────
  const eAppEntry = entries.find(e =>
    e.request.url.includes('GetEAppointmentUrl') ||
    e.request.url.includes('GetEAppointment')
  );
  if (eAppEntry) {
    const body = eAppEntry.response.content.text ?? '';
    let integrationUrl: string | null = null;
    try {
      const parsed = JSON.parse(body);
      integrationUrl = parsed?.url || parsed?.Url || (typeof parsed === 'string' ? parsed : null);
    } catch {
      const m = body.match(/https?:\/\/appointment\.cloud\.diplomatie\.be[^\s"']*/);
      integrationUrl = m?.[0] ?? null;
    }
    flow.getEAppointmentUrl = {
      url: eAppEntry.request.url,
      responseBody: body,
      integrationUrl,
      timestamp: eAppEntry.startedDateTime,
    };
  }

  // ── 2. GET /Integration/VOW/{...} (premier appel) ─────────────────────────
  const integEntry = entries.find(e =>
    e.request.url.includes('appointment.cloud.diplomatie.be') &&
    e.request.url.includes('/Integration/VOW/') &&
    e.request.method === 'GET' &&
    !e.request.url.includes('/Integration/VOW/SelectSlot')
  );
  if (integEntry) {
    flow.integrationVowFetch = {
      url: integEntry.request.url,
      requestHeaders: headersToMap(integEntry.request.headers),
      requestCookies: integEntry.request.cookies,
      responseStatus: integEntry.response.status,
      locationHeader: getHeader(integEntry.response.headers, 'location'),
      timestamp: integEntry.startedDateTime,
    };

    // ── 3. Page /Captcha ────────────────────────────────────────────────────
    const captchaEntry = entries.find(e =>
      e.request.url.includes('appointment.cloud.diplomatie.be') &&
      (e.request.url.endsWith('/Captcha') || e.request.url.includes('/Captcha?')) &&
      e.request.method === 'GET' &&
      !e.request.url.includes('SetCaptchaToken')
    );
    if (captchaEntry) {
      const aspNet = captchaEntry.request.cookies.find(c => c.name === 'ASP.NET_SessionId');
      flow.captchaPageLoad = {
        url: captchaEntry.request.url,
        responseStatus: captchaEntry.response.status,
        aspNetSessionId: aspNet?.value,
        timestamp: captchaEntry.startedDateTime,
      };
    }
  }

  // ── 4. POST /Captcha/SetCaptchaToken ──────────────────────────────────────
  const captchaPostEntry = entries.find(e =>
    e.request.url.includes('SetCaptchaToken') && e.request.method === 'POST'
  );
  if (captchaPostEntry) {
    const responseBody = captchaPostEntry.response.content.text ?? '';
    let responseJson: IntegrationFlow['setCaptchaToken'] extends undefined ? never : NonNullable<IntegrationFlow['setCaptchaToken']>['responseJson'];
    try { responseJson = JSON.parse(responseBody); } catch { /* non-JSON */ }

    const setCookies = getAllHeaders(captchaPostEntry.response.headers, 'set-cookie');
    const osOnlineRaw = setCookies.find(c => c.toLowerCase().startsWith('asonline=') || c.toLowerCase().startsWith('asonline;') || c.toLowerCase().includes('asonline') || c.includes('OSOnline'));
    // Also look for any large cookie (OSOnline values are very long)
    const osOnlineCookie = setCookies.find(c =>
      c.toLowerCase().includes('asonline') ||
      // OSOnline values are very long (100+ chars before the first ;)
      (c.split(';')[0]?.length > 100 && !c.toLowerCase().includes('ts0'))
    ) ?? osOnlineRaw;

    flow.setCaptchaToken = {
      url: captchaPostEntry.request.url,
      requestHeaders: headersToMap(captchaPostEntry.request.headers),
      requestHeadersOrder: captchaPostEntry.request.headers.map(h => h.name),
      requestCookies: captchaPostEntry.request.cookies,
      requestBody: captchaPostEntry.request.postData?.text ?? '',
      responseStatus: captchaPostEntry.response.status,
      responseBody,
      responseJson,
      responseSetCookies: setCookies,
      osOnlineCookie,
      timestamp: captchaPostEntry.startedDateTime,
    };

    // ── 5. Chaîne de redirections post-captcha ─────────────────────────────
    const startUrl = responseJson?.redirectUrl
      ? resolveUrl(responseJson.redirectUrl)
      : null;

    if (startUrl) {
      // Construire la chaîne en suivant les entrées HAR par ordre chronologique
      const chainUrls: string[] = [startUrl];
      const hops: HopInfo[] = [];
      let currentUrl = startUrl;

      for (let i = 0; i < 15; i++) {
        const entry = entries.find(e =>
          e.request.url === currentUrl ||
          e.request.url.startsWith(currentUrl.split('?')[0])
        );
        if (!entry) break;

        const location = getHeader(entry.response.headers, 'location');
        const setCookiesInHop = getAllHeaders(entry.response.headers, 'set-cookie');

        hops.push({
          url: entry.request.url,
          status: entry.response.status,
          locationHeader: location,
          setCookieHeaders: setCookiesInHop.length > 0 ? setCookiesInHop : undefined,
          bodyPreview: entry.response.content.text?.slice(0, 300),
          duration: entry.time,
        });

        if (!location || entry.response.status < 300 || entry.response.status >= 400) break;

        const next = resolveUrl(location);
        if (chainUrls.includes(next)) break;
        chainUrls.push(next);
        currentUrl = next;
      }

      const verdict = classifyVerdict(chainUrls);
      flow.postCaptchaRedirectChain = {
        startUrl,
        hops,
        finalUrl: chainUrls[chainUrls.length - 1],
        verdict,
      };
      flow.verdict    = verdict;
      flow.verdictUrl = chainUrls[chainUrls.length - 1];
    }
  }

  return flow;
}

// ─── Affichage terminal du flux ───────────────────────────────────────────────

function printFlowSummary(flow: IntegrationFlow): void {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           RÉSUMÉ DU FLUX INTEGRATION CEV                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  if (flow.getEAppointmentUrl) {
    console.log(`\n1️⃣  GetEAppointmentUrl → ${flow.getEAppointmentUrl.integrationUrl?.slice(0, 80) ?? '(non extrait)'}`);
  } else {
    console.log('\n1️⃣  GetEAppointmentUrl : ❌ non capturé');
  }

  if (flow.integrationVowFetch) {
    const st = flow.integrationVowFetch.responseStatus;
    console.log(`\n2️⃣  GET /Integration/VOW/... → HTTP ${st}${flow.integrationVowFetch.locationHeader ? ` → ${flow.integrationVowFetch.locationHeader.slice(0, 60)}` : ''}`);
  } else {
    console.log('\n2️⃣  GET /Integration/VOW/... : ❌ non capturé');
  }

  if (flow.captchaPageLoad) {
    console.log(`\n3️⃣  /Captcha chargé → HTTP ${flow.captchaPageLoad.responseStatus}`);
    console.log(`   ASP.NET_SessionId : ${flow.captchaPageLoad.aspNetSessionId ?? '(absent)'}`);
  } else {
    console.log('\n3️⃣  /Captcha : ❌ non capturé');
  }

  if (flow.setCaptchaToken) {
    const s = flow.setCaptchaToken;
    console.log(`\n4️⃣  POST SetCaptchaToken → HTTP ${s.responseStatus}`);
    console.log(`   captchaSolved : ${s.responseJson?.captchaSolved ?? '(absent)'}`);
    console.log(`   validUntil    : ${s.responseJson?.validUntil ?? '(null)'}`);
    console.log(`   redirectUrl   : ${s.responseJson?.redirectUrl ?? '(null)'}`);
    console.log(`   Set-Cookie count : ${s.responseSetCookies.length}`);
    if (s.osOnlineCookie) {
      const preview = s.osOnlineCookie.split(';')[0].slice(0, 80);
      console.log(`   ✅ OSOnline TROUVÉ : ${preview}…`);
    } else {
      console.log(`   ❌ OSOnline : non détecté dans les Set-Cookie`);
      if (s.responseSetCookies.length > 0) {
        console.log(`   Set-Cookies présents :`);
        s.responseSetCookies.forEach(c => console.log(`     • ${c.slice(0, 100)}`));
      }
    }
    console.log(`   Request cookies envoyés : ${s.requestCookies.map(c => c.name).join(', ')}`);
    console.log(`   Header order (${s.requestHeadersOrder.length}) : ${s.requestHeadersOrder.join(' | ')}`);
  } else {
    console.log('\n4️⃣  POST SetCaptchaToken : ❌ non capturé');
  }

  if (flow.postCaptchaRedirectChain) {
    const c = flow.postCaptchaRedirectChain;
    console.log(`\n5️⃣  Chaîne post-captcha (${c.hops.length} hops)`);
    c.hops.forEach((hop, i) => {
      const arrow = i < c.hops.length - 1 ? '→' : '●';
      const loc = hop.locationHeader ? ` [→ ${hop.locationHeader.slice(0, 50)}]` : '';
      const cookies = hop.setCookieHeaders?.length ? ` 🍪 ${hop.setCookieHeaders.length} Set-Cookie` : '';
      console.log(`   ${arrow} [${hop.status || '?'}] ${hop.url.slice(0, 80)}${loc}${cookies}`);
    });
    const emoji: Record<string, string> = {
      slots_available: '🟢', no_availability: '🔴', session_expired: '🟠',
      multi_session: '🔵', error: '⚠️', unknown: '❓',
    };
    console.log(`\n   Verdict : ${emoji[c.verdict] ?? '❓'} ${c.verdict.toUpperCase()}`);
  } else {
    console.log('\n5️⃣  Chaîne de redirections : ❌ non reconstruite');
  }

  console.log('\n══════════════════════════════════════════════════════════════════\n');
}

// ─── Sauvegarde ───────────────────────────────────────────────────────────────

let isSaving = false;

async function saveAll(harPath: string): Promise<void> {
  if (isSaving) { console.log('\n⚠️  Déjà en cours de sauvegarde...'); return; }
  isSaving = true;

  try {
    if (!fs.existsSync(DEBUG_DUMP_DIR)) {
      fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
    }

    // Lire le HAR écrit par Playwright
    if (!fs.existsSync(harPath)) {
      console.error(`❌ Fichier HAR introuvable : ${harPath}`);
      return;
    }

    const harRaw = fs.readFileSync(harPath, 'utf-8');
    const har: Har = JSON.parse(harRaw);
    const entries = har.log.entries;

    console.log(`\n📦 HAR chargé : ${entries.length} entrées`);

    // Reconstruire le flux integration depuis le HAR
    const flow = buildIntegrationFlowFromHar(har);
    printFlowSummary(flow);

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Copier le HAR brut
    const harDest = path.join(DEBUG_DUMP_DIR, `${ts}-raw.har`);
    fs.copyFileSync(harPath, harDest);
    console.log(`✅ HAR brut      : ${harDest}`);

    // Dump du flux integration
    const flowDest = path.join(DEBUG_DUMP_DIR, `${ts}-integration_flow.json`);
    fs.writeFileSync(flowDest, JSON.stringify({
      description: 'Flux integration CEV reconstruit depuis HAR (v2 — enregistrement natif Playwright)',
      generatedAt: new Date().toISOString(),
      flow,
    }, null, 2));
    console.log(`✅ Flux intégration : ${flowDest}`);

    // Dump filtré des requêtes cibles uniquement (lisible rapidement)
    const targets = entries.filter(e =>
      e.request.url.includes('appointment.cloud.diplomatie.be') ||
      e.request.url.includes('GetEAppointmentUrl') ||
      e.request.url.includes('SetCaptchaToken') ||
      e.request.url.includes('AvailableTimeSlots')
    );
    const targetsDest = path.join(DEBUG_DUMP_DIR, `${ts}-targets.json`);
    fs.writeFileSync(targetsDest, JSON.stringify({
      description: 'Requêtes cibles CEV extraites du HAR',
      count: targets.length,
      entries: targets.map(e => ({
        timestamp: e.startedDateTime,
        method: e.request.method,
        url: e.request.url,
        requestCookies: e.request.cookies,
        requestHeaders: headersToMap(e.request.headers),
        requestHeadersOrder: e.request.headers.map(h => h.name),
        requestBody: e.request.postData?.text,
        responseStatus: e.response.status,
        responseSetCookies: getAllHeaders(e.response.headers, 'set-cookie'),
        responseLocation: getHeader(e.response.headers, 'location'),
        responseBody: e.response.content.text?.slice(0, 5000),
      })),
    }, null, 2));
    console.log(`✅ Cibles seules : ${targetsDest}`);

  } catch (err) {
    console.error('❌ Erreur sauvegarde :', err);
  } finally {
    isSaving = false;
  }
}

// ─── Auto-save après SetCaptchaToken ─────────────────────────────────────────

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let terminateFn: (() => void) | null = null;

function scheduleAutoSave(harPath: string): void {
  if (autoSaveTimer) return; // déjà planifié
  console.log(`\n🎯 SetCaptchaToken détecté ! Sauvegarde automatique dans ${POST_CAPTCHA_SAVE_DELAY_MS / 1000}s (pour capturer les redirects)...`);
  console.log('   Appuyer sur ENTER maintenant pour sauvegarder immédiatement.\n');
  autoSaveTimer = setTimeout(async () => {
    console.log('\n⏰ Délai écoulé — sauvegarde automatique...');
    if (terminateFn) terminateFn();
  }, POST_CAPTCHA_SAVE_DELAY_MS);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔬 CEV NETWORK SNIFFER v2 — HAR recording natif Playwright');
  console.log('   Capture : SetCaptchaToken + OSOnline + redirects complets');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(DEBUG_DUMP_DIR)) {
    fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
  }

  const harPath = path.join(DEBUG_DUMP_DIR, '_playwright_recording.har');

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    console.log('🚀 Lancement du navigateur...');
    browser = await chromium.launch({
      headless: false,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    // ── Context avec HAR recording activé ─────────────────────────────────
    // recordHar capture TOUT : POST bodies, Set-Cookie, redirects 302, headers exacts.
    // C'est la méthode officielle Playwright — aucune perte lors des recharges.
    context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      locale: 'fr-BE',
      timezoneId: 'Europe/Brussels',
      recordHar: {
        path: harPath,
        mode: 'full',          // capture les corps de réponse
        content: 'embed',      // inclut le contenu inline (pas de fichiers séparés)
        urlFilter: /.*/,       // tout capturer
      },
    });

    // ── Listener temps réel pour l'auto-save ─────────────────────────────
    // (en complément du HAR — pour déclencher la sauvegarde automatique)
    context.on('response', async (response) => {
      try {
        const url = response.url();
        const isTarget = (
          url.includes('SetCaptchaToken') ||
          url.includes('Integration/VOW') ||
          url.includes('GetEAppointmentUrl') ||
          url.includes('appointment.cloud.diplomatie.be/Captcha') ||
          url.includes('Integration/Error') ||
          url.includes('AvailableTimeSlots')
        );
        if (isTarget) {
          const status = response.status();
          const isPost = response.request().method() === 'POST';
          console.log(`🎯 [${response.request().method()}] HTTP ${status} — ${url.slice(0, 100)}`);
          if (url.includes('SetCaptchaToken') && isPost && status === 200) {
            scheduleAutoSave(harPath);
          }
        }
      } catch { /* page déjà fermée */ }
    });

    // ── Ouvrir les nouvelles pages/popups ─────────────────────────────────
    context.on('page', (newPage: Page) => {
      console.log(`\n🚨 [NOUVEL ONGLET] ${newPage.url() || '(en cours de chargement)'}`);
    });

    const page = await context.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    console.log(`[UA] ${ua}\n`);

    await page.goto('https://visaonweb.diplomatie.be', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // ── Afficher les instructions ─────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('🔍 NAVIGATEUR PRÊT — Suivez ce flux pour capturer toutes les cibles :');
    console.log('');
    console.log('   1. Connectez-vous à visaonweb.diplomatie.be');
    console.log('   2. Naviguez vers votre dossier');
    console.log('   3. Cliquez sur "Prendre rendez-vous"');
    console.log('      → L\'onglet appointment.cloud.diplomatie.be/Captcha s\'ouvre');
    console.log('   4. Résolvez le captcha et cliquez "Vérifier"');
    console.log('      → Le sniffer détecte le POST et sauvegarde automatiquement');
    console.log('         6s après pour laisser les redirects se compléter');
    console.log('   5. Attendez le message "sauvegarde automatique" dans ce terminal');
    console.log('');
    console.log('   CIBLES SURVEILLÉES EN TEMPS RÉEL (🎯) :');
    console.log('   • GET  /GetEAppointmentUrl');
    console.log('   • GET  /Integration/VOW/{...}');
    console.log('   • GET  appointment.cloud.diplomatie.be/Captcha');
    console.log('   • POST /Captcha/SetCaptchaToken  ← déclenche l\'auto-save');
    console.log('   • GET  /Integration/Error/NoAvailability');
    console.log('   • GET  /Integration/Error/SessionExpired');
    console.log('   • GET  /Integration/VOW/SelectSlot');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\n⏳ [ENTER] pour terminer manuellement à tout moment\n');

    // ── Attente utilisateur / auto-save ───────────────────────────────────
    await new Promise<void>((resolve) => {
      terminateFn = resolve;

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('line', () => {
        console.log('\n⏸️  ENTER détecté — sauvegarde...');
        rl.close();
        if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
        resolve();
      });

      if (browser) {
        browser.on('disconnected', () => {
          console.log('\n⚠️  Navigateur fermé manuellement.');
          rl.close();
          if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
          resolve();
        });
      }

      process.on('SIGINT', () => {
        console.log('\n⚠️  Ctrl+C détecté.');
        rl.close();
        if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
        resolve();
      });
    });

    // ── Fermer le context pour écrire le HAR sur disque ───────────────────
    console.log('\n💾 Fermeture du contexte Playwright (écriture HAR sur disque)...');
    await context.close();
    context = null;

    // Laisser Playwright finir l'écriture
    await new Promise(r => setTimeout(r, 1_000));

    await saveAll(harPath);

  } catch (err) {
    console.error('\n❌ Erreur :', err);
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
    try { await saveAll(harPath); } catch { /* ignore */ }
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    console.log('\n✅ Sniffer terminé. Les fichiers sont dans :', DEBUG_DUMP_DIR);
    process.exit(0);
  }
}

main().catch(console.error);
