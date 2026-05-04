/**
 * CEV DISCOVERY SCRIPT
 * Exploration complète du flux CEV appointment.cloud.diplomatie.be
 * Capture : URLs, APIs, cookies, headers, anti-bot, formulaires, screenshots
 */
import { chromium, BrowserContext, Page, Request, Response } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';

const VOWINT_USER = 'screentapinc@gmail.com';
const VOWINT_PASS = process.env.VOWINT_TEST_PASSWORD?.trim();
if (!VOWINT_PASS) {
  console.error('[FATAL] VOWINT_TEST_PASSWORD manquant dans les variables d\'environnement');
  process.exit(1);
}
// Anti-Captcha en priorité (supporte les domaines gouvernementaux)
// CapSolver blackliste la sitekey CEV 5f64399c-14a8-415e-ad1a-7ebccdc4943a
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY?.trim() ?? '';
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY?.trim() ?? '';
const CEV_BASE = 'https://appointment.cloud.diplomatie.be';
const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const SCREENSHOTS_DIR = join(tmpdir(), 'cev_screenshots');
const OUTPUT_FILE = resolve(homedir(), 'CEV_DISCOVERY.md');

if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ==================== STRUCTURES DE CAPTURE ====================

interface NetworkCall {
  t: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  setCookie?: string;
}

const allCalls: NetworkCall[] = [];
const screenshots: { label: string; path: string }[] = [];
const discoveries: string[] = [];

function note(title: string, content: string) {
  const entry = `\n### ${title}\n${content}`;
  discoveries.push(entry);
  log(`[DISCOVERY] ${title}`);
}

async function takeScreenshot(page: Page, label: string) {
  const filename = `${Date.now()}_${label.replace(/[^a-z0-9]/gi, '_')}.jpg`;
  const path = join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path, type: 'jpeg', quality: 80, fullPage: true }).catch(() => {});
  screenshots.push({ label, path });
  log(`[SCREENSHOT] ${label} → ${path}`);
  return path;
}

// ==================== SOLVE HCAPTCHA (Anti-Captcha → CapSolver fallback) ====================

async function solveHcaptchaViaService(
  serviceLabel: string,
  apiBase: string,
  apiKey: string,
  sitekey: string,
  pageUrl: string,
): Promise<string | null> {
  log(`[${serviceLabel}] Soumission hCaptcha HCaptchaTaskProxyless...`);

  const createRes = await fetch(`${apiBase}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: sitekey },
    }),
  });

  const createData = await createRes.json() as { errorId: number; taskId?: string; errorCode?: string; errorDescription?: string };
  log(`[${serviceLabel}] createTask → errorId=${createData.errorId} taskId=${createData.taskId ?? 'N/A'}`);

  if (createData.errorId !== 0 || !createData.taskId) {
    note(`${serviceLabel} Erreur création task`, `errorId=${createData.errorId}\ncode=${createData.errorCode}\ndesc=${createData.errorDescription}`);
    return null;
  }

  const taskId = createData.taskId;
  note(`hCaptcha soumis via ${serviceLabel}`, `TaskID: ${taskId}\nSitekey: ${sitekey}\nPage: ${pageUrl}`);

  // Poll jusqu'à 120s (24 × 5s)
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const pollRes = await fetch(`${apiBase}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    const pollData = await pollRes.json() as {
      errorId: number;
      status: string;
      solution?: { gRecaptchaResponse?: string; userAgent?: string };
      errorDescription?: string;
    };

    if (pollData.errorId !== 0) {
      note(`${serviceLabel} Erreur poll`, `errorId=${pollData.errorId} desc=${pollData.errorDescription}`);
      return null;
    }

    if (pollData.status === 'ready' && pollData.solution?.gRecaptchaResponse) {
      const token = pollData.solution.gRecaptchaResponse;
      log(`[${serviceLabel}] Résolu en ${(i + 1) * 5}s — token: ${token.slice(0, 50)}...`);
      note(`hCaptcha résolu via ${serviceLabel} ✅`, `Tentatives: ${i + 1} (${(i + 1) * 5}s)\nToken (60 chars): ${token.slice(0, 60)}...\nUserAgent: ${pollData.solution.userAgent ?? 'N/A'}`);
      return token;
    }

    log(`[${serviceLabel}] status=${pollData.status} — attente ${(i + 1) * 5}s...`);
  }

  note(`${serviceLabel} Timeout`, 'hCaptcha non résolu en 120s');
  return null;
}

async function solveHcaptcha(sitekey: string, pageUrl: string): Promise<string | null> {
  // Priorité 1 : Anti-Captcha (anti-captcha.com) — supporte les domaines gouvernementaux
  if (ANTICAPTCHA_KEY) {
    log('[DISCOVERY] Tentative Anti-Captcha (priorité 1)...');
    const token = await solveHcaptchaViaService('Anti-Captcha', 'https://api.anti-captcha.com', ANTICAPTCHA_KEY, sitekey, pageUrl);
    if (token) return token;
    log('[DISCOVERY] Anti-Captcha échoué — fallback CapSolver...');
  } else {
    log('[DISCOVERY] ANTICAPTCHA_API_KEY absent — skip Anti-Captcha');
  }

  // Priorité 2 : CapSolver (blackliste sitekey CEV, mais on essaie quand même)
  if (CAPSOLVER_KEY) {
    log('[DISCOVERY] Tentative CapSolver (fallback)...');
    const token = await solveHcaptchaViaService('CapSolver', 'https://api.capsolver.com', CAPSOLVER_KEY, sitekey, pageUrl);
    if (token) return token;
    log('[DISCOVERY] CapSolver échoué.');
  }

  note('ÉCHEC résolution hCaptcha', 'CapSolver blackliste la sitekey CEV (5f64399c-...).\nConfigurer ANTICAPTCHA_API_KEY via anti-captcha.com.');
  return null;
}

// ==================== MAIN ====================

log('=== CEV Discovery Script démarrage ===');
log(`Credentials: ${VOWINT_USER}`);
log(`Anti-Captcha key: ${ANTICAPTCHA_KEY ? ANTICAPTCHA_KEY.slice(0, 6) + '...' : 'ABSENT ⚠️ (recommandé)'}`);
log(`CapSolver key: ${CAPSOLVER_KEY ? CAPSOLVER_KEY.slice(0, 6) + '...' : 'ABSENT'} (note: sitekey CEV blacklistée)`);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
  ],
});

// Context avec profil réaliste
const context: BrowserContext = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  locale: 'fr-BE',
  timezoneId: 'Africa/Kinshasa',
  viewport: { width: 1280, height: 800 },
  screen: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  extraHTTPHeaders: {
    'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  },
});

// Injecter le cookie d'accessibilité hCaptcha si configuré (bypass gratuit, priorité absolue)
const ACCESSIBILITY_COOKIE = process.env.HCAPTCHA_ACCESSIBILITY_COOKIE?.trim() ?? '';
if (ACCESSIBILITY_COOKIE) {
  await context.addCookies([{
    name: 'hc_accessibility',
    value: ACCESSIBILITY_COOKIE,
    domain: '.hcaptcha.com',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'None' as const,
  }]);
  log(`[DISCOVERY] Cookie hc_accessibility injecté (accessibilité bypass) ✅`);
} else {
  log(`[DISCOVERY] HCAPTCHA_ACCESSIBILITY_COOKIE absent — bypass accessibilité désactivé`);
}

// ==================== CAPTURE RÉSEAU GLOBALE ====================

context.on('request', (req: Request) => {
  const entry: NetworkCall = {
    t: Date.now(),
    method: req.method(),
    url: req.url(),
    requestHeaders: req.headers(),
    requestBody: req.postData() ?? undefined,
  };
  allCalls.push(entry);

  if (req.url().includes('diplomatie.be') || req.url().includes('hcaptcha') || req.url().includes('captcha')) {
    log(`[REQ] ${req.method()} ${req.url().slice(0, 100)}`);
  }
});

context.on('response', async (res: Response) => {
  const entry = [...allCalls].reverse().find(c => c.url === res.url() && !c.status);
  if (entry) {
    entry.status = res.status();
    entry.responseHeaders = res.headers();
    entry.setCookie = res.headers()['set-cookie'];
    try {
      const ct = res.headers()['content-type'] ?? '';
      if ((ct.includes('json') || ct.includes('text')) && !res.url().includes('css') && !res.url().includes('font')) {
        entry.responseBody = await res.text().catch(() => '[unreadable]');
      }
    } catch { /* ignore */ }
  }

  if (res.url().includes('diplomatie.be')) {
    const sc = res.headers()['set-cookie'];
    log(`[RES] ${res.status()} ${res.url().slice(0, 100)}${sc ? ` | set-cookie: ${sc.slice(0, 60)}` : ''}`);
  }
});

const page: Page = await context.newPage();

// Désactiver la détection webdriver via script
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  (window as any).chrome = { runtime: {} };
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['fr-BE', 'fr', 'en-US'] });
});

async function getHcaptchaSitekey(currentPage: Page): Promise<string | null> {
  return currentPage.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="hcaptcha"]') as HTMLIFrameElement | null;
    if (iframe) return iframe.src.match(/sitekey=([^&]+)/)?.[1] ?? null;
    const keyed = document.querySelector('[data-sitekey]') as HTMLElement | null;
    if (keyed) return keyed.getAttribute('data-sitekey');
    return null;
  }).catch(() => null);
}

async function injectHcaptchaToken(currentPage: Page, token: string) {
  await currentPage.evaluate((tok: string) => {
    const fields = document.querySelectorAll('textarea[name="h-captcha-response"], input[name="h-captcha-response"], input[name="HCaptchaToken"]');
    fields.forEach((field: Element) => {
      (field as HTMLInputElement).value = tok;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, token).catch(() => {});
}

async function attemptVowintLogin(currentPage: Page, targetUrl: string, label: string): Promise<boolean> {
  log(`[LOGIN] Tentative ${label} → ${targetUrl}`);
  await currentPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await takeScreenshot(currentPage, `01_vowint_login_${label}`);
  note(`VOWINT Login Page (${label})`, `URL: ${currentPage.url()}\nTitre: ${await currentPage.title()}`);

  await currentPage.fill('input#UserName', VOWINT_USER);
  await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
  await currentPage.fill('input#Password', VOWINT_PASS!);
  await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

  const sitekey = await getHcaptchaSitekey(currentPage);
  if (sitekey) {
    note(`hCaptcha détecté (login ${label})`, `Sitekey: ${sitekey}`);
    const token = await solveHcaptcha(sitekey, currentPage.url());
    if (token) {
      await injectHcaptchaToken(currentPage, token);
      note(`hCaptcha injecté (login ${label})`, `Token injecté (60 chars): ${token.slice(0, 60)}...`);
    } else {
      note(`hCaptcha non résolu (login ${label})`, 'Soumission login tentée sans token.');
    }
  }

  await currentPage.click('button[type="submit"]');
  await currentPage.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await takeScreenshot(currentPage, `02_vowint_after_login_${label}`);

  const finalUrl = currentPage.url();
  const loginError = await currentPage.locator('.validation-summary-errors, .field-validation-error, [class*="alert"]').first().textContent().catch(() => null);
  const loggedIn = !/\/Account\/Login/i.test(finalUrl);

  note(`VOWINT Après Login (${label})`, `URL: ${finalUrl}\nTitre: ${await currentPage.title()}\nSuccès: ${loggedIn ? 'oui' : 'non'}${loginError ? `\nMessage: ${loginError.trim()}` : ''}`);
  return loggedIn;
}

// ==================== ÉTAPE 1 : LOGIN VOWINT ====================

log('\n=== ÉTAPE 1 : Login VOWINT ===');
const loginTargets = [
  { url: VOWINT_BASE, label: 'home' },
  { url: `${VOWINT_BASE}/en/Account/Login?ReturnUrl=%2Fen%2FVisaApplication%2FIndexByUserId`, label: 'en_return' },
];

let loggedIn = false;
for (const target of loginTargets) {
  loggedIn = await attemptVowintLogin(page, target.url, target.label);
  if (loggedIn) break;
}

if (!loggedIn) {
  note('ERREUR LOGIN VOWINT', 'Impossible de se connecter après plusieurs tentatives (avec gestion hCaptcha).');
  await browser.close();
  process.exit(1);
}

// Vérifier les cookies VOWINT
const vowintCookies = await context.cookies();
note('Cookies VOWINT après login', vowintCookies.map(c =>
  `- ${c.name}=${c.value.slice(0, 30)}... | domain=${c.domain} | httpOnly=${c.httpOnly} | secure=${c.secure} | sameSite=${c.sameSite}`
).join('\n'));

// ==================== ÉTAPE 2 : MY APPLICATIONS ====================

log('\n=== ÉTAPE 2 : My Applications ===');
await page.goto(`${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
if (/\/Account\/Login/i.test(page.url())) {
  await page.goto(`${VOWINT_BASE}/fr/VisaApplication/IndexByUserId`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
}
if (/\/Account\/Login/i.test(page.url())) {
  note('ERREUR SESSION VOWINT', `Redirection persistante vers login: ${page.url()}`);
  await takeScreenshot(page, '03_vowint_session_lost');
  await browser.close();
  process.exit(1);
}
await new Promise(r => setTimeout(r, 3000)); // attendre AngularJS
await takeScreenshot(page, '03_vowint_my_applications');

// Capturer le HTML du tableau
const tableHtml = await page.$eval('table#vaMyList', (t: any) => t.outerHTML).catch(() => 'non trouvé');
note('VOWINT My Applications — Tableau', `HTML du tableau :\n\`\`\`html\n${tableHtml.slice(0, 2000)}\n\`\`\``);

// Lister tous les dossiers
const rows = await page.$$eval('table#vaMyList tbody tr', (trs: any[]) =>
  trs.map(tr => {
    const cells = tr.querySelectorAll('td');
    const btns = tr.querySelectorAll('button[ng-click]');
    return {
      internetNum: cells[0]?.innerText,
      appNum: cells[1]?.innerText,
      name: cells[2]?.innerText,
      status: cells[3]?.innerText,
      ngClicks: Array.from(btns as NodeListOf<Element>).map((b: any) => b.getAttribute('ng-click')),
    };
  })
).catch(() => []);

note('Dossiers VOWINT', JSON.stringify(rows, null, 2));

// ==================== ÉTAPE 3 : CLIC BOUTON RDV ====================

log('\n=== ÉTAPE 3 : Clic bouton calendrier RDV ===');

const rdvBtn = await page.$('[ng-click*="groupVAEapp"]');
if (!rdvBtn) {
  note('ERREUR', 'Bouton groupVAEapp non trouvé!');
  await browser.close();
  process.exit(1);
}

const rdvNgClick = await rdvBtn.getAttribute('ng-click');
note('Bouton RDV cliqué', `ng-click="${rdvNgClick}"`);

const [cevPage] = await Promise.all([
  context.waitForEvent('page', { timeout: 15000 }),
  rdvBtn.click(),
]);

await cevPage.waitForLoadState('domcontentloaded', { timeout: 20000 });
await new Promise(r => setTimeout(r, 3000));
await takeScreenshot(cevPage, '04_cev_captcha_page');

const cevUrl = cevPage.url();
const cevTitle = await cevPage.title();
log(`[CEV] Page ouverte: ${cevUrl}`);
note('CEV Captcha Page', `URL: ${cevUrl}\nTitre: ${cevTitle}`);

// Capturer HTML de la page captcha
const cevHtml = await cevPage.content().catch(() => '');
note('CEV Captcha HTML (500 chars)', `\`\`\`html\n${cevHtml.slice(0, 2000)}\n\`\`\``);

// Cookies CEV après ouverture du tab
await new Promise(r => setTimeout(r, 2000));
const cevCookies = (await context.cookies()).filter(c => c.domain.includes('appointment.cloud'));
note('Cookies CEV après ouverture', cevCookies.map(c =>
  `- ${c.name}=${c.value.slice(0, 40)} | httpOnly=${c.httpOnly} | secure=${c.secure} | sameSite=${c.sameSite}`
).join('\n'));

const cevCookieHeader = cevCookies.map(c => `${c.name}=${c.value}`).join('; ');
log(`[CEV] Session cookie: ${cevCookieHeader}`);

// Chercher le sitekey hCaptcha dans la page
const hcaptchaSitekey = await cevPage.evaluate(() => {
  const iframe = document.querySelector('iframe[src*="hcaptcha"]') as HTMLIFrameElement;
  if (iframe) return iframe.src.match(/sitekey=([^&]+)/)?.[1];
  const div = document.querySelector('[data-sitekey]') as HTMLElement;
  if (div) return div.getAttribute('data-sitekey');
  const script = document.querySelector('script[src*="hcaptcha"]') as HTMLScriptElement;
  return script ? 'dans script' : null;
}).catch(() => null);

note('hCaptcha Sitekey', `Depuis DOM: ${hcaptchaSitekey}\nConfirmé: 5f64399c-14a8-415e-ad1a-7ebccdc4943a`);

// ==================== ÉTAPE 4 : RÉSOUDRE HCAPTCHA ====================

log('\n=== ÉTAPE 4 : Résolution hCaptcha ===');
const HCAPTCHA_SITEKEY = '5f64399c-14a8-415e-ad1a-7ebccdc4943a';
let hcaptchaToken: string | null = null;

// Priorité 0 : Accessibilité bypass (cookie hc_accessibility → hCaptcha auto-résout en DOM)
if (ACCESSIBILITY_COOKIE) {
  log('[DISCOVERY] Tentative bypass accessibilité (priorité 0)...');
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const domToken = await cevPage.evaluate(() => {
      const textarea = document.querySelector('textarea[name="h-captcha-response"]') as HTMLTextAreaElement | null;
      const input = document.querySelector('input[name="h-captcha-response"]') as HTMLInputElement | null;
      return (textarea?.value || input?.value) ?? null;
    }).catch(() => null);
    log(`  [Accessibilité ${(i+1)*5}s] token DOM: ${domToken ? domToken.slice(0, 30) + '...' : 'vide'}`);
    if (domToken && domToken.length > 20) {
      hcaptchaToken = domToken;
      note('hCaptcha résolu via Accessibilité ✅ (GRATUIT)', `Bypass cookie hc_accessibility\nTentatives: ${i+1} (${(i+1)*5}s)\nToken (60 chars): ${domToken.slice(0, 60)}...\nLongueur: ${domToken.length}`);
      break;
    }
  }
  if (!hcaptchaToken) {
    log('[DISCOVERY] Accessibilité bypass échoué — cookie expiré ou inactif');
    note('Accessibilité bypass ÉCHEC', 'Cookie hc_accessibility injecté mais aucun token DOM détecté.\nVérifier : accounts.hcaptcha.com → "Always pass accessibility mode" activé.');
  }
}

// Fallback : services API (Anti-Captcha → CapSolver)
if (!hcaptchaToken) {
  hcaptchaToken = await solveHcaptcha(HCAPTCHA_SITEKEY, cevUrl);
}

if (!hcaptchaToken) {
  note('hCaptcha ÉCHEC — TOUTES les méthodes épuisées', [
    'Options :',
    '1. [GRATUIT] Configurer HCAPTCHA_ACCESSIBILITY_COOKIE (accounts.hcaptcha.com)',
    '2. [PAYANT] Recharger ANTICAPTCHA_API_KEY (anti-captcha.com) — $5 = ~2500 résolutions',
  ].join('\n'));
  await browser.close();
  process.exit(1);
}

// ==================== ÉTAPE 5 : POST SetCaptchaToken ====================

log('\n=== ÉTAPE 5 : POST /Captcha/SetCaptchaToken ===');

// Via fetch depuis la page CEV (même contexte, cookies automatiques via credentials:include)
// Body URL-encoded avec le champ "captcha" (reverse-engineered du bundle JS)
const captchaResult = await cevPage.evaluate(async ({ token, cookieStr }: { token: string; cookieStr: string }) => {
  const body = new URLSearchParams({ captcha: token }).toString();

  const res = await fetch('/Captcha/SetCaptchaToken', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
    credentials: 'include',
  });

  const text = await res.text();
  return {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body: text,
    url: res.url,
  };
}, { token: hcaptchaToken, cookieStr: cevCookieHeader });

log(`[CEV] SetCaptchaToken → status=${captchaResult.status} body=${captchaResult.body.slice(0, 200)}`);
note('POST /Captcha/SetCaptchaToken', `Status: ${captchaResult.status}\nBody: ${captchaResult.body}\nHeaders: ${JSON.stringify(captchaResult.headers, null, 2)}`);

// Parser le JSON de réponse
let captchaJson: { validUntil?: string; redirectUrl?: string; error?: string } = {};
try {
  captchaJson = JSON.parse(captchaResult.body);
  note('SetCaptchaToken JSON parsé', JSON.stringify(captchaJson, null, 2));
} catch {
  note('SetCaptchaToken corps non-JSON', captchaResult.body);
}

await takeScreenshot(cevPage, '05_after_captcha_submit');

if (!captchaJson.redirectUrl) {
  note('ERREUR — Pas de redirectUrl', `Response: ${captchaResult.body}\nCookies CEV actuels: ${cevCookieHeader}`);

  // Tenter Option B: Formulaire HTML natif
  log('[CEV] Tentative via formulaire HTML natif...');
  await cevPage.evaluate((token: string) => {
    const textarea = document.querySelector('textarea[name="h-captcha-response"]') as HTMLTextAreaElement;
    if (textarea) textarea.value = token;
    const input = document.querySelector('input[name="HCaptchaToken"]') as HTMLInputElement;
    if (input) input.value = token;
    (window as any).hcaptcha?.close();
  }, hcaptchaToken);

  const formEl = await cevPage.$('form');
  if (formEl) {
    await formEl.evaluate((f: any, token: string) => {
      const field = f.querySelector('[name="HCaptchaToken"], [name="h-captcha-response"]');
      if (field) field.value = token;
      f.submit();
    }, hcaptchaToken);
    await cevPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await takeScreenshot(cevPage, '05b_after_form_submit');
    note('Après soumission formulaire HTML', `URL: ${cevPage.url()}\nTitre: ${await cevPage.title()}`);
  }
}

// ==================== ÉTAPE 6 : PAGE DES CRÉNEAUX ====================

if (captchaJson.redirectUrl) {
  log(`\n=== ÉTAPE 6 : Navigation vers créneaux → ${captchaJson.redirectUrl} ===`);

  await cevPage.goto(captchaJson.redirectUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await takeScreenshot(cevPage, '06_slots_page');

  note('Page Créneaux', `URL: ${cevPage.url()}\nTitre: ${await cevPage.title()}`);

  const slotsHtml = await cevPage.content();
  note('Page Créneaux HTML (2000 chars)', `\`\`\`html\n${slotsHtml.slice(0, 3000)}\n\`\`\``);

  const slotsText = await cevPage.evaluate(() => document.body.innerText);
  note('Page Créneaux texte', slotsText.replace(/\s+/g, ' ').trim().slice(0, 1000));

  // Analyser la structure de sélection de dates
  const calendarInfo = await cevPage.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button') as NodeListOf<Element>).map((e: any) => ({
      tag: e.tagName,
      text: e.textContent?.trim().slice(0, 50),
      href: e.href,
      onclick: e.getAttribute('onclick'),
      classes: e.className,
      id: e.id,
    }));

    const inputs = Array.from(document.querySelectorAll('input, select') as NodeListOf<Element>).map((e: any) => ({
      type: e.type || e.tagName,
      name: e.name,
      id: e.id,
      value: e.value,
    }));

    const forms = Array.from(document.querySelectorAll('form') as NodeListOf<Element>).map((f: any) => ({
      action: f.action,
      method: f.method,
      id: f.id,
    }));

    return { links: links.filter((l: any) => l.text), inputs, forms };
  });

  note('Structure page créneaux', JSON.stringify(calendarInfo, null, 2));

  // Chercher des créneaux disponibles
  const availableSlots = await cevPage.$$eval(
    '.available, .slot-available, td.enabled, a[data-date], button[data-date], td:not(.disabled):not(.past)',
    (els: any[]) => els.slice(0, 20).map(e => ({
      tag: e.tagName,
      text: e.textContent?.trim().slice(0, 30),
      data: Object.fromEntries(Array.from(e.attributes as NamedNodeMap).map((a: Attr) => [a.name, a.value]).filter((a: any[]) => a[0].startsWith('data-'))),
      href: e.href,
    }))
  ).catch(() => []);

  note('Créneaux disponibles trouvés', availableSlots.length > 0
    ? JSON.stringify(availableSlots, null, 2)
    : 'Aucun créneau disponible avec les sélecteurs testés'
  );

  // Mois/Années disponibles
  const monthLinks = await cevPage.$$eval('a[href*="month"], a[href*="Month"], .calendar-nav a, .month-nav a', (els: any[]) =>
    els.map(e => ({ text: e.textContent?.trim(), href: e.href }))
  ).catch(() => []);
  note('Navigation calendrier', JSON.stringify(monthLinks, null, 2));
}

// ==================== ANALYSE RÉSEAU COMPLÈTE ====================

log('\n=== ANALYSE RÉSEAU ===');

const cevCalls = allCalls.filter(c => c.url.includes('diplomatie.be'));
note('Tous les appels réseau CEV/VOWINT', cevCalls.map(c =>
  `**${c.method} ${c.url}**\n` +
  `- Status: ${c.status ?? '?'}\n` +
  `- Set-Cookie: ${c.setCookie ? c.setCookie.split(';')[0] : 'none'}\n` +
  (c.requestBody ? `- Body: ${c.requestBody.slice(0, 200)}\n` : '') +
  (c.responseBody ? `- Response: ${c.responseBody.slice(0, 300)}\n` : '')
).join('\n---\n'));

// Headers importants utilisés
const importantHeaders = new Set<string>();
for (const call of cevCalls) {
  for (const key of Object.keys(call.requestHeaders)) {
    if (['cookie', 'authorization', 'x-csrf-token', '__requestverificationtoken', 'x-requested-with', 'referer', 'origin'].includes(key.toLowerCase())) {
      importantHeaders.add(`${key}: ${call.requestHeaders[key].slice(0, 80)}`);
    }
  }
}
note('Headers sécurité importants', Array.from(importantHeaders).join('\n'));

// Cookies finaux
const finalCookies = await context.cookies();
note('Tous les cookies finaux', finalCookies.map(c =>
  `- ${c.domain} | ${c.name}=${c.value.slice(0, 40)} | httpOnly=${c.httpOnly} | secure=${c.secure} | sameSite=${c.sameSite} | expires=${c.expires === -1 ? 'session' : new Date(c.expires * 1000).toISOString()}`
).join('\n'));

// ==================== ÉCRITURE DU FICHIER DE DÉCOUVERTE ====================

const timestamp = new Date().toISOString();
const md = `# CEV Discovery — Flux Complet
_Généré le ${timestamp} par cev_discovery.ts_

## Compte test
- VOWINT: ${VOWINT_USER}
- Application: VOWINT5903406 — NGOBI ESTHER

## Screenshots capturés
${screenshots.map(s => `- **${s.label}** → \`${s.path}\``).join('\n')}

## Appels réseau total capturés
- **Diplomatie.be**: ${cevCalls.length}
- **Total**: ${allCalls.length}

${discoveries.join('\n\n---\n')}

## Configuration finale du bot

\`\`\`typescript
// Sélecteurs validés
const VOWINT_SELECTORS = {
  username: 'input#UserName',
  password: 'input#Password',
  submit: 'button[type="submit"]',
  myApplications: '/en/VisaApplication/IndexByUserId',
  rdvButton: '[ng-click*="groupVAEapp"]',
};

const CEV_CONFIG = {
  base: 'https://appointment.cloud.diplomatie.be',
  captchaPage: '/Captcha',
  setCaptchaToken: '/Captcha/SetCaptchaToken',
  hcaptchaSitekey: '5f64399c-14a8-415e-ad1a-7ebccdc4943a',
};

// Méthode extraction cookie
// → context.cookies() filtré par domain 'appointment.cloud.diplomatie.be'
// → Chercher ASP.NET_SessionId
\`\`\`
`;

writeFileSync(OUTPUT_FILE, md, 'utf-8');
log(`\n=== DISCOVERY TERMINÉ → ${OUTPUT_FILE} ===`);
log(`Screenshots: ${screenshots.length} captures dans ${SCREENSHOTS_DIR}`);
log(`Appels réseau capturés: ${allCalls.length} total, ${cevCalls.length} CEV/VOWINT`);

await browser.close();
