/**
 * VOWINT Bundle Sniffer — Capture des bundles JS/CSS du portail VOWINT
 * (visaonweb.diplomatie.be) depuis le flux de création d'application CEV.
 *
 * STRATÉGIE :
 *   Playwright enregistre un HAR complet. Le script peut fonctionner en deux modes :
 *
 *   MODE AUTO (si VOWINT_EMAIL + VOWINT_PASSWORD sont fournis en env) :
 *     → Login automatique → navigation vers IndexByUserId → clic "Nouvelle demande"
 *     → capture de tous les bundles de la page de création + sauvegarde auto.
 *
 *   MODE MANUEL (défaut — aucun credential requis) :
 *     → Browser headed s'ouvre sur visaonweb.diplomatie.be
 *     → L'utilisateur se connecte manuellement et navigue vers la création
 *     → Le script détecte automatiquement les pages cibles et sauvegarde les bundles
 *     → Appuyer ENTER pour forcer la sauvegarde immédiate
 *
 * PAGES CIBLES CAPTURÉES :
 *   - /en/VisaApplication/IndexByUserId  — liste des dossiers (bundles AngularJS principaux)
 *   - /en/VisaApplication/Create         — formulaire de création d'application
 *   - Tout endpoint API appelé par le formulaire (DataTables, MyList, etc.)
 *
 * UTILISATION :
 *   # Mode manuel (browser visible) :
 *   pnpm --filter @workspace/slot-hunter exec tsx src/debug/vowint-bundle-sniffer.ts
 *
 *   # Mode auto (credentials via env) :
 *   VOWINT_EMAIL=xxx VOWINT_PASSWORD=yyy \
 *   pnpm --filter @workspace/slot-hunter exec tsx src/debug/vowint-bundle-sniffer.ts
 *
 * OUTPUT :
 *   debug_dumps/bundles/vowint/       — fichiers JS/CSS téléchargés
 *   debug_dumps/<ts>-vowint-har.json  — HAR brut complet
 *   debug_dumps/<ts>-vowint-flow.json — flux reconstruit (endpoints + champs formulaire)
 *   debug_dumps/<ts>-vowint-api.json  — tous les appels API XHR capturés
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── Configuration ────────────────────────────────────────────────────────────

const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const VOWINT_EMAIL    = process.env.VOWINT_EMAIL    ?? '';
const VOWINT_PASSWORD = process.env.VOWINT_PASSWORD ?? '';
const AUTO_MODE = !!(VOWINT_EMAIL && VOWINT_PASSWORD);

const WINDOW_WIDTH  = 1366;
const WINDOW_HEIGHT = 768;

const PROJECT_ROOT   = path.resolve(process.cwd(), '..', '..');
const DEBUG_DUMP_DIR = path.join(PROJECT_ROOT, 'debug_dumps');
const BUNDLE_DIR     = path.join(DEBUG_DUMP_DIR, 'bundles', 'vowint');

/** Délai (ms) après détection de la page de création avant sauvegarde auto. */
const CREATE_PAGE_SAVE_DELAY_MS = 8_000;

/** URLs contenant ces patterns → page cible détectée */
const TARGET_URL_PATTERNS = [
  '/VisaApplication/Create',
  '/VisaApplication/New',
  '/VisaApplication/Add',
  '/Application/Create',
  '/Application/New',
  '/VisaApp/Create',
];

/** URLs XHR à capturer (endpoint API de la page de création) */
const API_URL_PATTERNS = [
  'DataTables',
  'MyList',
  'GetCountries',
  'GetNationalities',
  'GetVisaTypes',
  'GetPurposes',
  'GetEmbassies',
  'GetConsulates',
  'GetEAppointmentUrl',
  'VisaApplication',
  'Application',
  '/api/',
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface BundleEntry {
  url: string;
  filename: string;
  type: 'js' | 'css' | 'font' | 'other';
  size: number;
  savedAt: string;
}

interface ApiCall {
  timestamp: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseStatus: number;
  responseBody?: string;
  responseHeaders: Record<string, string>;
}

interface VowintFlow {
  capturedAt: string;
  mode: 'auto' | 'manual';
  pagesVisited: string[];
  bundles: BundleEntry[];
  apiCalls: ApiCall[];
  formFields?: FormField[];
  createPageDetected: boolean;
  createPageUrl?: string;
}

interface FormField {
  name: string;
  type: string;
  label?: string;
  options?: string[];
  required?: boolean;
  placeholder?: string;
  ngModel?: string;
  apiSource?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function bundleFilename(url: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    // Ex: /Scripts/angularApp?v=abc → angularApp.js
    const base = pathname.split('/').pop() ?? 'bundle';
    const isJs  = url.includes('/Scripts/') || url.endsWith('.js')  || pathname.includes('script') || pathname.includes('Script');
    const isCss = url.includes('/Content/') || url.endsWith('.css') || pathname.includes('css')    || pathname.includes('style');
    const ext   = isJs ? 'js' : isCss ? 'css' : 'bin';
    // Inclure un hash court de la version pour identifier l'exact build
    const vParam = u.searchParams.get('v') ?? '';
    const vSuffix = vParam ? `-${vParam.slice(0, 8)}` : '';
    return `${base}${vSuffix}.${ext}`;
  } catch {
    return `bundle-${Date.now()}.bin`;
  }
}

function isBundleUrl(url: string): boolean {
  if (!url.startsWith(VOWINT_BASE)) return false;
  return (
    url.includes('/Scripts/') ||
    url.includes('/Content/') ||
    url.includes('/Fonts/')   ||
    url.includes('/bundles/') ||
    url.endsWith('.js')       ||
    url.endsWith('.css')
  );
}

function isApiUrl(url: string): boolean {
  return API_URL_PATTERNS.some(p => url.includes(p));
}

function isCreatePage(url: string): boolean {
  return TARGET_URL_PATTERNS.some(p => url.includes(p));
}

function headersToMap(headers: Array<{name: string; value: string}>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

// ─── Extraction des champs de formulaire depuis le HTML ────────────────────────

function extractFormFields(html: string): FormField[] {
  const fields: FormField[] = [];

  // Inputs/selects avec leur label associé
  const inputRe = /<(input|select|textarea)[^>]*>/gi;
  let m: RegExpExecArray | null;

  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    const nameM   = tag.match(/name="([^"]+)"/);
    const typeM   = tag.match(/type="([^"]+)"/);
    const idM     = tag.match(/id="([^"]+)"/);
    const ngM     = tag.match(/ng-model="([^"]+)"/);
    const reqM    = tag.match(/required|ng-required/);
    const phM     = tag.match(/placeholder="([^"]+)"/);
    const ngOpts  = tag.match(/ng-options="([^"]+)"/);

    if (!nameM && !ngM) continue;
    if (tag.includes('__RequestVerificationToken')) continue;
    if (tag.includes('type="hidden"') && !ngM) continue;

    const field: FormField = {
      name:        nameM?.[1] ?? ngM?.[1] ?? 'unknown',
      type:        m[1] === 'select' ? 'select' : m[1] === 'textarea' ? 'textarea' : typeM?.[1] ?? 'text',
      required:    !!reqM,
      placeholder: phM?.[1],
      ngModel:     ngM?.[1],
    };

    // Chercher le label correspondant par id
    if (idM) {
      const labelRe = new RegExp(`<label[^>]*for="${idM[1]}"[^>]*>([^<]+)`, 'i');
      const lm = html.match(labelRe);
      if (lm) field.label = lm[1].trim();
    }

    // ng-options → source de données API
    if (ngOpts) field.apiSource = ngOpts[1];

    fields.push(field);
  }

  return fields;
}

// ─── Session Playwright ────────────────────────────────────────────────────────

async function runSniffer(): Promise<void> {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });

  const timestamp = ts();
  const harPath  = path.join(DEBUG_DUMP_DIR, `${timestamp}-vowint-har.json`);
  const flowPath = path.join(DEBUG_DUMP_DIR, `${timestamp}-vowint-flow.json`);
  const apiPath  = path.join(DEBUG_DUMP_DIR, `${timestamp}-vowint-api.json`);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  VOWINT Bundle Sniffer');
  console.log(`  Mode : ${AUTO_MODE ? '🤖 AUTO' : '👤 MANUEL'}`);
  console.log(`  Timestamp : ${timestamp}`);
  console.log(`${'═'.repeat(60)}\n`);

  if (!AUTO_MODE) {
    console.log('📌 INSTRUCTIONS :');
    console.log('  1. Le browser va s\'ouvrir sur visaonweb.diplomatie.be');
    console.log('  2. Connectez-vous avec vos credentials VOWINT');
    console.log('  3. Naviguez vers "Nouvelle demande" (création d\'application)');
    console.log('  4. Remplissez les premiers champs pour voir les options de dropdown');
    console.log('  5. Le sniffer sauvegarde automatiquement après détection de la page');
    console.log('  → Appuyez sur ENTER dans ce terminal pour forcer la sauvegarde\n');
  }

  const browser: Browser = await chromium.launch({
    headless: AUTO_MODE,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  // HAR recording natif Playwright
  const context: BrowserContext = await browser.newContext({
    viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    locale: 'fr-BE',
    recordHar: {
      path: harPath,
      mode: 'full',
      content: 'embed',
    },
  });

  const flow: VowintFlow = {
    capturedAt: new Date().toISOString(),
    mode: AUTO_MODE ? 'auto' : 'manual',
    pagesVisited: [],
    bundles: [],
    apiCalls: [],
    createPageDetected: false,
  };

  const downloadedBundles = new Set<string>();
  const capturedApiCalls: ApiCall[] = [];
  let createPageDetected = false;
  let createPageHtml = '';
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const page: Page = await context.newPage();

  // ── Intercepter les réponses pour capturer bundles + API ──────────────────
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();

    // Track pages visitées
    if (response.request().resourceType() === 'document' && status < 400) {
      if (!flow.pagesVisited.includes(url)) {
        flow.pagesVisited.push(url);
        console.log(`📄 Page : ${url.replace(VOWINT_BASE, '')}`);
      }

      // Détecter la page de création
      if (isCreatePage(url) && !createPageDetected) {
        createPageDetected = true;
        flow.createPageDetected = true;
        flow.createPageUrl = url;
        console.log(`\n🎯 PAGE DE CRÉATION DÉTECTÉE : ${url}`);
        console.log(`   Sauvegarde automatique dans ${CREATE_PAGE_SAVE_DELAY_MS / 1000}s...`);

        // Capturer le HTML de la page pour extraire les champs
        try {
          createPageHtml = await response.text();
        } catch { /* ignore */ }

        // Déclencher sauvegarde automatique après délai
        if (!autoSaveTimer) {
          autoSaveTimer = setTimeout(() => {
            console.log('\n⏰ Délai écoulé — sauvegarde en cours...');
            save().catch(console.error);
          }, CREATE_PAGE_SAVE_DELAY_MS);
        }
      }
    }

    // Télécharger les bundles JS/CSS
    if (isBundleUrl(url) && !downloadedBundles.has(url)) {
      downloadedBundles.add(url);
      try {
        const body = await response.body();
        const filename = bundleFilename(url);
        const outPath  = path.join(BUNDLE_DIR, filename);
        fs.writeFileSync(outPath, body);

        const entry: BundleEntry = {
          url,
          filename,
          type: filename.endsWith('.js') ? 'js' : filename.endsWith('.css') ? 'css' : 'other',
          size: body.length,
          savedAt: new Date().toISOString(),
        };
        flow.bundles.push(entry);
        console.log(`📦 Bundle : ${filename} (${Math.round(body.length / 1024)}KB)`);
      } catch { /* response body gone — will be in HAR */ }
    }

    // Capturer les appels API XHR
    if (isApiUrl(url) && response.request().resourceType() === 'xhr') {
      try {
        const reqBody  = response.request().postData() ?? undefined;
        const respBody = await response.text().catch(() => undefined);
        const apiCall: ApiCall = {
          timestamp: new Date().toISOString(),
          method: response.request().method(),
          url,
          requestHeaders: response.request().headers(),
          requestBody: reqBody,
          responseStatus: status,
          responseBody: respBody && respBody.length < 50_000 ? respBody : `[${respBody?.length ?? 0} chars — truncated]`,
          responseHeaders: response.headers(),
        };
        capturedApiCalls.push(apiCall);
        console.log(`🔌 API : [${response.request().method()}] ${url.replace(VOWINT_BASE, '')} → ${status}`);
      } catch { /* ignore */ }
    }
  });

  // ── Fonction de sauvegarde ─────────────────────────────────────────────────
  async function save(): Promise<void> {
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }

    console.log('\n💾 Sauvegarde en cours...');

    // Extraire champs formulaire si HTML capturé
    if (createPageHtml) {
      flow.formFields = extractFormFields(createPageHtml);
      console.log(`   → ${flow.formFields.length} champs formulaire extraits`);
    }

    // Mettre à jour les API calls
    flow.apiCalls = capturedApiCalls;
    console.log(`   → ${flow.bundles.length} bundles capturés`);
    console.log(`   → ${flow.apiCalls.length} appels API capturés`);

    // Fermer le contexte pour finaliser le HAR
    await context.close();
    await browser.close();

    // Sauvegarder les fichiers
    fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2));
    fs.writeFileSync(apiPath,  JSON.stringify(capturedApiCalls, null, 2));

    console.log('\n✅ Fichiers sauvegardés :');
    console.log(`   HAR brut   : ${harPath}`);
    console.log(`   Flux       : ${flowPath}`);
    console.log(`   API calls  : ${apiPath}`);
    console.log(`   Bundles    : ${BUNDLE_DIR}/`);

    // Lister les bundles téléchargés
    const downloaded = fs.readdirSync(BUNDLE_DIR);
    console.log(`\n📦 Bundles dans ${BUNDLE_DIR} :`);
    for (const f of downloaded.sort()) {
      const size = fs.statSync(path.join(BUNDLE_DIR, f)).size;
      console.log(`   ${f.padEnd(40)} ${Math.round(size / 1024)}KB`);
    }
    console.log('');

    process.exit(0);
  }

  // ── ENTER pour sauvegarde manuelle ────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', () => {
    console.log('\n⌨️  ENTER pressé — sauvegarde forcée');
    save().catch(console.error);
  });

  // ── Navigation ────────────────────────────────────────────────────────────
  try {
    if (AUTO_MODE) {
      // Mode automatique : login + navigation
      console.log(`🤖 Login automatique avec : ${VOWINT_EMAIL}`);
      await page.goto(`${VOWINT_BASE}/`, { waitUntil: 'networkidle', timeout: 30_000 });

      // Remplir le formulaire de login
      await page.fill('#UserName', VOWINT_EMAIL);
      await page.waitForTimeout(500 + Math.random() * 500);
      await page.fill('#Password', VOWINT_PASSWORD);
      await page.waitForTimeout(300 + Math.random() * 400);

      // FIX: Promise.all évite la race condition "navigation déjà terminée avant waitForNavigation"
      const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 }),
        submitBtn.click(),
      ]);
      console.log(`   → Connecté : ${page.url()}`);

      // Naviguer vers IndexByUserId
      await page.goto(`${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(2000);
      console.log(`   → IndexByUserId chargé`);

      // Dump HTML pour debug sélecteurs
      const indexHtml = await page.content();
      console.log(`   → HTML IndexByUserId (500 chars) : ${indexHtml.slice(0, 500).replace(/\n/g, ' ')}`);

      // Chemin réel HAR : IndexByUserId → "New application" → /en/VisaApplication/Gdpr → /en/VisaApplication/Create
      // Le bouton "New application" est un lien AngularJS rendu hors viewport (invisible au clic Playwright).
      // Navigation directe vers /en/VisaApplication/Gdpr — plus robuste que le clic SPA.
      console.log(`   → Navigation directe vers GDPR…`);
      // networkidle ne se termine jamais à cause de hCaptcha (connexions permanentes) — domcontentloaded suffit
      await page.goto(`${VOWINT_BASE}/en/VisaApplication/Gdpr`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      console.log(`   → URL GDPR : ${page.url()}`);
      await page.waitForTimeout(3000); // laisser AngularJS rendre le formulaire

      // ── GDPR → CreateGdprNewWithAutoNumber → Edit/{VACoreId} ─────────────────
      // Flow découvert depuis gdprController.js :
      //   1. POST /en/VisaApplication/CreateGdprNewWithAutoNumber  { Approval: 1, RecaptchaResponse: "" }
      //   2. Réponse JSON { Success: true, VACoreId: "xxx" }
      //   3. Redirection vers /en/VisaApplication/Edit/{VACoreId}
      //
      // On POST directement depuis page.evaluate() pour utiliser les cookies authentifiés du browser.
      // On extrait aussi le __RequestVerificationToken depuis la page GDPR.
      console.log(`   → POST CreateGdprNewWithAutoNumber via page.evaluate()…`);

      const gdprResult = await page.evaluate(async () => {
        // Chercher le token CSRF si présent dans le DOM
        const tokenEl = document.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement | null;
        const token = tokenEl?.value ?? '';

        const params = new URLSearchParams({
          Approval: '1',
          RecaptchaResponse: '',
          ...(token ? { __RequestVerificationToken: token } : {}),
        });

        const resp = await fetch('/en/VisaApplication/CreateGdprNewWithAutoNumber', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        const text = await resp.text();
        let json: Record<string, unknown> | null = null;
        try { json = JSON.parse(text); } catch { /* pas du JSON */ }

        return {
          status: resp.status,
          url: resp.url,
          text: text.slice(0, 500),
          json,
          redirected: resp.redirected,
        };
      });

      console.log(`   → Réponse GDPR POST: status=${gdprResult.status} redirected=${gdprResult.redirected}`);
      console.log(`   → JSON: ${JSON.stringify(gdprResult.json)}`);
      if (gdprResult.text && !gdprResult.json) {
        console.log(`   → text: ${gdprResult.text.slice(0, 200)}`);
      }

      // Extraire le VACoreId et naviguer vers Edit
      const vaCoreId = (gdprResult.json as any)?.VACoreId ?? (gdprResult.json as any)?.vaCoreId ?? null;
      if (vaCoreId) {
        const editUrl = `${VOWINT_BASE}/en/VisaApplication/Edit/${vaCoreId}`;
        console.log(`   → VACoreId=${vaCoreId} — navigation vers ${editUrl}`);
        await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(4000); // laisser AngularJS rendre le formulaire
        console.log(`   → URL Edit : ${page.url()}`);
      } else if (gdprResult.redirected && gdprResult.url.includes('Edit')) {
        // Le fetch a suivi une redirection vers Edit
        const redirectUrl = gdprResult.url;
        console.log(`   → Redirection directe vers : ${redirectUrl}`);
        await page.goto(redirectUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(4000);
        console.log(`   → URL : ${page.url()}`);
      } else {
        // Fallback : tenter navigation directe vers Create
        console.log(`   ⚠️  VACoreId absent — tentative navigation directe vers Create`);
        await page.goto(`${VOWINT_BASE}/en/VisaApplication/Create`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(3000);
        console.log(`   → URL fallback : ${page.url()}`);
      }

      console.log(`   → Page finale : ${page.url()}`);

      // Attendre que les bundles de la page de création se chargent
      await page.waitForTimeout(CREATE_PAGE_SAVE_DELAY_MS);
      await save();

    } else {
      // Mode manuel : ouvrir le browser, attendre interaction
      await page.goto(`${VOWINT_BASE}/`, { waitUntil: 'domcontentloaded' });
      console.log(`\n🌐 Browser ouvert sur ${VOWINT_BASE}/`);
      console.log('   Connectez-vous manuellement, puis naviguez vers la création d\'application.\n');

      // Attendre indéfiniment (ENTER ou détection auto)
      await new Promise<void>(() => { /* résolu par save() */ });
    }
  } catch (err) {
    console.error('\n❌ Erreur :', err);
    await save().catch(() => process.exit(1));
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
runSniffer().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
