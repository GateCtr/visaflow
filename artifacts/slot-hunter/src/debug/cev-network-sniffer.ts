/**
 * CEV Network Sniffer - Capture complète du trafic réseau humain vs bot
 *
 * OBJECTIF :
 *   Lancer un navigateur Playwright en mode visible, intercepter TOUTES les requêtes réseau
 *   pendant une navigation humaine, puis sauvegarder les données pour analyse comparative.
 *
 * FONCTIONNALITÉS :
 *   - Navigateur Playwright visible (headless: false), centré, 1366x768
 *   - Key-listener terminal pour attendre ENTER (fin de navigation)
 *   - Interception complète réseau (y compris iframes, popups, hCaptcha)
 *   - Capture détaillée : URL, méthode, initiateur, headers (ordre exact), cookies, payloads, réponses
 *   - Reconstruction explicite des chaînes de redirections (302 → 302 → 200)
 *   - Dump dédié "integration_flow.json" : GetEAppointmentUrl → SetCaptchaToken → redirections → verdict
 *   - Sauvegarde chronologique en JSON dans debug_dumps/
 *
 * UTILISATION :
 *   npx tsx src/debug/cev-network-sniffer.ts
 *   -> Naviguer manuellement sur le site CEV
 *   -> Appuyer sur ENTER dans le terminal pour terminer
 *   -> Les données sont sauvegardées dans artifacts/slot-hunter/debug_dumps/
 *
 * CIBLES DE CAPTURE (spécifiques à l'analyse CEV) :
 *   ✅ GET  /GetEAppointmentUrl                    → URL d'intégration (visaonweb)
 *   ✅ GET  /Integration/VOW/{orgId}/{...}          → fetch URL intégration (appointment)
 *   ✅ POST /Captcha/SetCaptchaToken                → payload token + réponse JSON (redirectUrl)
 *   ✅ GET  /Integration/VOW/SelectSlot (via 302)   → chaîne redirection post-captcha
 *   ✅ GET  /Integration/Error/NoAvailability        → verdict "pas de créneaux"
 *   ✅ GET  /Integration/Error/SessionExpired        → verdict "session expirée"
 */

import { chromium, type Browser, type Page, type BrowserContext, type Request, type Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Variables globales pour gérer l'état du script
let isSaving = false;
let isTerminating = false;

// ─── Configuration ───────────────────────────────────────────────────────────────

const WINDOW_WIDTH = 1366;
const WINDOW_HEIGHT = 768;

const PROJECT_ROOT = path.join(process.cwd(), '..', '..');
const DEBUG_DUMP_DIR = path.join(PROJECT_ROOT, 'debug_dumps');

// ─── Types pour la capture réseau ───────────────────────────────────────────────

interface NetworkRequest {
  id: string;
  timestamp: number;
  url: string;
  method: string;
  initiator?: string;
  resourceType: string;
  frameId?: string;
  frameUrl?: string;
  parentFrameUrl?: string;
  isPopup?: boolean;
  isIframe?: boolean;

  // Headers
  requestHeaders: Record<string, string>;
  requestHeadersOrder: string[];

  // Cookies
  requestCookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number | -1;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;

  // Payload
  requestBody?: string;
  requestBodyType?: 'string' | 'formData' | 'json';

  // Response
  responseStatus: number;
  responseStatusText: string;
  responseHeaders: Record<string, string>;
  responseHeadersOrder: string[];
  responseHeadersText?: string;
  responseBody?: string;
  responseSize?: number;

  // Redirections — FIX: extraire explicitement Location header + flag isRedirect
  locationHeader?: string;   // Valeur du header Location pour les 302
  isRedirect?: boolean;      // true si status 3xx avec un Location
  redirectChainIndex?: number; // position dans la chaîne (0 = départ)

  // Timing
  timing?: {
    requestStartTime: number;
    responseStartTime: number;
    endTime: number;
    duration: number;
  };

  // Security
  securityDetails?: {
    protocol: string;
    subjectName: string;
    issuer: string;
    validFrom: number;
    validTo: number;
  };
}

// Représentation d'une chaîne de redirections reconstruite
interface RedirectChain {
  id: string;
  startUrl: string;
  hops: Array<{
    url: string;
    status: number;
    locationHeader?: string;
    duration?: number;
    responseBodyPreview?: string;
  }>;
  finalUrl: string;
  verdict: 'slots_available' | 'no_availability' | 'session_expired' | 'multi_session' | 'error' | 'unknown';
}

interface CaptureSession {
  sessionId: string;
  startTime: number;
  endTime: number;
  userAgent: string;
  viewport: { width: number; height: number };
  requests: NetworkRequest[];
  // Section dédiée au flux integration (ajout)
  integrationFlow?: IntegrationFlow;
  summary: {
    totalRequests: number;
    byMethod: Record<string, number>;
    byResourceType: Record<string, number>;
    byDomain: Record<string, number>;
    captchaRequests: string[];
    f5Cookies: string[];
    aspNetSessionCookies: string[];
  };
}

// Résumé structuré du flux integration/captcha pour analyse bot
interface IntegrationFlow {
  // Étape 1 : GetEAppointmentUrl (visaonweb → appointment URL)
  getEAppointmentUrl?: {
    requestUrl: string;
    responseBody: string;
    integrationUrl: string | null; // URL extraite de la réponse
    timestamp: number;
  };

  // Étape 2 : GET /Integration/VOW/{...} (premier appel vers appointment)
  integrationVowFetch?: {
    url: string;
    requestHeaders: Record<string, string>;
    requestHeadersOrder: string[];
    requestCookies: NetworkRequest['requestCookies'];
    responseStatus: number;
    responseBody?: string;
    locationHeader?: string;
    timestamp: number;
  };

  // Étape 3 : Page /Captcha (chargement)
  captchaPageLoad?: {
    url: string;
    responseStatus: number;
    aspNetSessionId?: string;
    timestamp: number;
  };

  // Étape 4 : POST /Captcha/SetCaptchaToken
  setCaptchaToken?: {
    url: string;
    requestHeaders: Record<string, string>;
    requestHeadersOrder: string[];
    requestBody: string;
    requestCookies: NetworkRequest['requestCookies'];
    responseStatus: number;
    responseBody: string;
    responseJson?: {
      captchaSolved?: boolean;
      validUntil?: string | null;
      redirectUrl?: string | null;
      defaultTimeout?: number;
    };
    timestamp: number;
  };

  // Étape 5 : Chaîne de redirections post-captcha (reconstructée)
  postCaptchaRedirectChain?: RedirectChain;

  // Verdict final
  verdict?: 'slots_available' | 'no_availability' | 'session_expired' | 'multi_session' | 'error' | 'unknown';
  verdictUrl?: string;
}

// ─── État global de la capture ─────────────────────────────────────────────────

let captureSession: CaptureSession = {
  sessionId: '',
  startTime: 0,
  endTime: 0,
  userAgent: '',
  viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
  requests: [],
  summary: {
    totalRequests: 0,
    byMethod: {},
    byResourceType: {},
    byDomain: {},
    captchaRequests: [],
    f5Cookies: [],
    aspNetSessionCookies: [],
  },
};

let requestCounter = 0;
let browser: Browser | null = null;
let context: BrowserContext | null = null;

// Map pour stocker les données de capture par ID de requête
const requestCaptureMap = new Map<string, NetworkRequest>();

// FIX — Map pour reconstruction de chaînes de redirections :
// key = URL de la requête, value = Location header de sa réponse 302
const redirectChainMap = new Map<string, string>();
// key = URL, value = NetworkRequest.id (pour lookup rapide)
const urlToRequestId = new Map<string, string>();

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generateRequestId(): string {
  return `req_${Date.now()}_${++requestCounter}`;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function isCaptchaRequest(url: string): boolean {
  const captchaPatterns = [
    'hcaptcha.com',
    'h-captcha',
    'SetCaptchaToken',
    'captcha',
    'api.js',
    'challenge.js',
  ];
  return captchaPatterns.some(pattern => url.toLowerCase().includes(pattern.toLowerCase()));
}

function isF5Cookie(cookieName: string): boolean {
  return cookieName.startsWith('TS') || cookieName.startsWith('BIGip');
}

function isAspNetSessionCookie(cookieName: string): boolean {
  return cookieName === 'ASP.NET_SessionId';
}

/** Résout une URL relative en absolute en utilisant la base CEV */
function resolveUrl(maybeRelative: string, base = 'https://appointment.cloud.diplomatie.be'): string {
  if (maybeRelative.startsWith('http')) return maybeRelative;
  if (maybeRelative.startsWith('/')) return `${base}${maybeRelative}`;
  return `${base}/${maybeRelative}`;
}

/**
 * Reconstruit la chaîne de redirections à partir d'une URL de départ.
 * Utilise redirectChainMap (url → location) pour suivre les sauts.
 */
function buildRedirectChainFrom(startUrl: string): string[] {
  const chain: string[] = [startUrl];
  let current = startUrl;
  for (let i = 0; i < 15; i++) {
    const next = redirectChainMap.get(current);
    if (!next) break;
    const resolved = resolveUrl(next);
    if (chain.includes(resolved)) break; // éviter les boucles infinies
    chain.push(resolved);
    current = resolved;
  }
  return chain;
}

/** Classifie l'URL finale d'une chaîne en verdict */
function classifyChainVerdict(chain: string[]): RedirectChain['verdict'] {
  const allUrls = chain.join(' ');
  if (allUrls.includes('NoAvailability')) return 'no_availability';
  if (allUrls.includes('MultiSessionNotAllowed')) return 'multi_session';
  if (allUrls.includes('SessionExpired')) return 'session_expired';
  if (allUrls.includes('/Error/')) return 'error';
  if (allUrls.includes('SelectSlot')) return 'slots_available';
  return 'unknown';
}

// ─── Reconstruction du flux integration ─────────────────────────────────────────

/**
 * Construit la section `integrationFlow` de la session à partir des requêtes capturées.
 * Appelé juste avant la sauvegarde.
 */
function buildIntegrationFlow(): IntegrationFlow {
  const flow: IntegrationFlow = {};
  const requests = captureSession.requests;

  // ── Étape 1 : GetEAppointmentUrl ──────────────────────────────────────────
  const getEAppReq = requests.find(r =>
    r.url.includes('GetEAppointmentUrl') ||
    r.url.includes('GetEAppointment')
  );
  if (getEAppReq) {
    let integrationUrl: string | null = null;
    try {
      const parsed = JSON.parse(getEAppReq.responseBody || '{}');
      integrationUrl = parsed?.url || parsed?.Url || parsed?.integrationUrl || null;
      if (!integrationUrl && typeof parsed === 'string') integrationUrl = parsed;
    } catch {
      // réponse non-JSON — chercher une URL dans le texte brut
      const match = getEAppReq.responseBody?.match(/https?:\/\/appointment\.cloud\.diplomatie\.be[^\s"']*/);
      integrationUrl = match?.[0] ?? null;
    }
    flow.getEAppointmentUrl = {
      requestUrl: getEAppReq.url,
      responseBody: getEAppReq.responseBody || '',
      integrationUrl,
      timestamp: getEAppReq.timestamp,
    };
  }

  // ── Étape 2 : GET /Integration/VOW/{...} ─────────────────────────────────
  const integrationVowReq = requests.find(r =>
    r.url.includes('appointment.cloud.diplomatie.be') &&
    r.url.includes('/Integration/VOW/') &&
    r.method === 'GET' &&
    !r.url.includes('/Integration/VOW/SelectSlot')
  );
  if (integrationVowReq) {
    const aspNetCookie = integrationVowReq.requestCookies.find(c => c.name === 'ASP.NET_SessionId');
    flow.integrationVowFetch = {
      url: integrationVowReq.url,
      requestHeaders: integrationVowReq.requestHeaders,
      requestHeadersOrder: integrationVowReq.requestHeadersOrder,
      requestCookies: integrationVowReq.requestCookies,
      responseStatus: integrationVowReq.responseStatus,
      responseBody: integrationVowReq.responseBody,
      locationHeader: integrationVowReq.locationHeader,
      timestamp: integrationVowReq.timestamp,
    };

    // ── Étape 3 : page /Captcha ────────────────────────────────────────────
    const captchaPageReq = requests.find(r =>
      r.url.includes('appointment.cloud.diplomatie.be') &&
      (r.url.endsWith('/Captcha') || r.url.includes('/Captcha?') || r.url.includes('/Captcha/'))
      && r.method === 'GET'
      && !r.url.includes('SetCaptchaToken')
    );
    if (captchaPageReq) {
      const aspNet = captchaPageReq.requestCookies.find(c => c.name === 'ASP.NET_SessionId');
      flow.captchaPageLoad = {
        url: captchaPageReq.url,
        responseStatus: captchaPageReq.responseStatus,
        aspNetSessionId: aspNet?.value,
        timestamp: captchaPageReq.timestamp,
      };
    }
  }

  // ── Étape 4 : POST /Captcha/SetCaptchaToken ───────────────────────────────
  const setCaptchaReq = requests.find(r =>
    r.url.includes('SetCaptchaToken') && r.method === 'POST'
  );
  if (setCaptchaReq) {
    let responseJson: IntegrationFlow['setCaptchaToken'] extends undefined ? never : NonNullable<IntegrationFlow['setCaptchaToken']>['responseJson'] = undefined;
    try {
      responseJson = JSON.parse(setCaptchaReq.responseBody || '{}');
    } catch { /* non-JSON */ }

    flow.setCaptchaToken = {
      url: setCaptchaReq.url,
      requestHeaders: setCaptchaReq.requestHeaders,
      requestHeadersOrder: setCaptchaReq.requestHeadersOrder,
      requestBody: setCaptchaReq.requestBody || '',
      requestCookies: setCaptchaReq.requestCookies,
      responseStatus: setCaptchaReq.responseStatus,
      responseBody: setCaptchaReq.responseBody || '',
      responseJson,
      timestamp: setCaptchaReq.timestamp,
    };

    // ── Étape 5 : Chaîne de redirections post-captcha ──────────────────────
    const startUrl = responseJson?.redirectUrl
      ? resolveUrl(responseJson.redirectUrl)
      : null;

    if (startUrl) {
      const chainUrls = buildRedirectChainFrom(startUrl);
      const verdict = classifyChainVerdict(chainUrls);

      const hops = chainUrls.map(url => {
        const reqId = urlToRequestId.get(url);
        const req = reqId ? captureSession.requests.find(r => r.id === reqId) : undefined;
        return {
          url,
          status: req?.responseStatus ?? 0,
          locationHeader: req?.locationHeader,
          duration: req?.timing?.duration,
          responseBodyPreview: req?.responseBody?.slice(0, 300),
        };
      });

      flow.postCaptchaRedirectChain = {
        id: `chain_${Date.now()}`,
        startUrl,
        hops,
        finalUrl: chainUrls[chainUrls.length - 1],
        verdict,
      };

      flow.verdict = verdict;
      flow.verdictUrl = chainUrls[chainUrls.length - 1];
    }
  }

  return flow;
}

// ─── Handlers partagés requête / réponse ────────────────────────────────────────

/**
 * Traite une requête entrante (appelé depuis context OU page listener).
 * La déduplication est assurée par __captureId attaché à l'objet request.
 */
async function handleRequest(request: Request, sourcePage?: Page): Promise<void> {
  if ((request as any).__captureId) return;

  try {
    const requestId = generateRequestId();
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();

    const isTarget = (
      url.includes('SetCaptchaToken') ||
      url.includes('Integration/VOW') ||
      url.includes('Integration/Error') ||
      url.includes('Integration/SelectSlot') ||
      url.includes('GetEAppointmentUrl') ||
      url.includes('AvailableTimeSlots') ||
      url.includes('appointment.cloud.diplomatie.be/Captcha')
    );

    if (isTarget) {
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`🎯 [CIBLE REQUEST] ${method} ${url}`);
    } else {
      console.log(`[REQUEST] [${resourceType.toUpperCase()}] ${method} ${url.slice(0, 80)}`);
    }

    let headersOrder: string[] = [];
    let headersMap: Record<string, string> = {};
    try {
      const headersArray = await request.headersArray();
      headersOrder = headersArray.map((h: any) => h.name);
      headersArray.forEach((h: any) => { headersMap[h.name.toLowerCase()] = h.value; });
    } catch {
      try {
        const fallbackHeaders = request.headers();
        headersOrder = Object.keys(fallbackHeaders);
        Object.keys(fallbackHeaders).forEach(k => { headersMap[k.toLowerCase()] = fallbackHeaders[k]; });
      } catch { /* page morte */ }
    }

    let requestCookies: NetworkRequest['requestCookies'] = [];
    try {
      const cookies = await context?.cookies() || [];
      requestCookies = cookies.map((c: any) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite as any,
      }));
    } catch { /* navigateur fermé */ }

    let requestBody: string | undefined;
    let requestBodyType: 'string' | 'formData' | 'json' | undefined;
    try {
      const postData = request.postData();
      if (postData) {
        requestBody = postData;
        requestBodyType = 'string';
        try { JSON.parse(postData); requestBodyType = 'json'; } catch {}
        if (postData.includes('=') && (postData.includes('&') || postData.includes('captcha='))) requestBodyType = 'formData';
      }
    } catch { /* postData indisponible */ }

    if (isTarget) {
      console.log(`   Headers (${headersOrder.length}): ${headersOrder.join(' | ')}`);
      const cookie = headersMap['cookie'];
      if (cookie) console.log(`   Cookie: ${cookie.slice(0, 200)}`);
      if (requestBody) console.log(`   Body: ${requestBody.slice(0, 500)}`);
    }

    const frame = request.frame();
    const networkRequest: NetworkRequest = {
      id: requestId,
      timestamp: Date.now(),
      url, method, resourceType,
      frameUrl: frame?.url(),
      parentFrameUrl: frame?.parentFrame()?.url(),
      isIframe: (frame?.parentFrame() ?? null) !== null,
      isPopup: sourcePage ? sourcePage.mainFrame() !== frame && !frame?.parentFrame() : false,
      requestHeaders: headersMap,
      requestHeadersOrder: headersOrder,
      requestCookies,
      requestBody,
      requestBodyType,
      responseStatus: 0,
      responseStatusText: 'pending',
      responseHeaders: {},
      responseHeadersOrder: [],
    } as any;

    requestCaptureMap.set(requestId, networkRequest);
    (request as any).__captureId = requestId;

    // Enregistrer url → requestId pour lookup dans buildIntegrationFlow
    urlToRequestId.set(url, requestId);
  } catch (error) {
    console.log(`[REQUEST-ERROR] ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Traite une réponse (appelé depuis context OU page listener).
 */
async function handleResponse(response: Response): Promise<void> {
  try {
    const request = response.request();
    const captureId = (request as any).__captureId;
    let captureData: NetworkRequest | undefined;

    if (captureId) {
      captureData = requestCaptureMap.get(captureId);
    }
    if (!captureData) {
      const url = response.url();
      const method = request.method();
      for (const [, req] of requestCaptureMap) {
        if (req.url === url && req.method === method && req.responseStatus === 0) {
          captureData = req;
          break;
        }
      }
    }
    if (!captureData) return;

    const url = response.url();
    const status = response.status();

    const isTarget = (
      url.includes('SetCaptchaToken') ||
      url.includes('Integration/VOW') ||
      url.includes('Integration/Error') ||
      url.includes('Integration/SelectSlot') ||
      url.includes('GetEAppointmentUrl') ||
      url.includes('AvailableTimeSlots') ||
      url.includes('appointment.cloud.diplomatie.be/Captcha')
    );

    let responseHeadersOrder: string[] = [];
    let responseHeadersMap: Record<string, string> = {};
    try {
      const arr = await response.headersArray();
      responseHeadersOrder = arr.map((h: any) => h.name);
      arr.forEach((h: any) => { responseHeadersMap[h.name.toLowerCase()] = h.value; });
    } catch {
      try {
        const fb = response.headers();
        responseHeadersOrder = Object.keys(fb);
        Object.keys(fb).forEach(k => { responseHeadersMap[k.toLowerCase()] = fb[k]; });
      } catch {}
    }

    // FIX — Extraire explicitement Location pour les 302 + chaîne de redirections
    const locationHeader = responseHeadersMap['location'];
    const isRedirect = status >= 300 && status < 400 && !!locationHeader;
    if (isRedirect && locationHeader) {
      captureData.locationHeader = locationHeader;
      captureData.isRedirect = true;
      // Enregistrer dans la map de reconstruction de chaîne
      redirectChainMap.set(url, locationHeader);
    }

    let responseBody: string | undefined;
    let responseSize: number | undefined;
    try {
      const buffer = await response.body();
      responseSize = buffer.length;
      const ct = responseHeadersMap['content-type'] || '';
      // FIX — capturer le body pour TOUTES les réponses des URLs cibles,
      // pas seulement selon le content-type (SetCaptchaToken retourne JSON
      // mais le content-type peut varier selon la config IIS)
      if (isTarget || ct.includes('json') || ct.includes('text') || ct.includes('form')) {
        responseBody = buffer.toString('utf-8');
      }
    } catch { /* buffer indisponible */ }

    captureData.responseStatus = status;
    captureData.responseStatusText = status.toString();
    captureData.responseHeaders = responseHeadersMap;
    captureData.responseHeadersOrder = responseHeadersOrder;
    captureData.responseHeadersText = JSON.stringify(responseHeadersMap, null, 2);
    captureData.responseBody = responseBody;
    captureData.responseSize = responseSize;
    captureData.timing = {
      requestStartTime: captureData.timestamp,
      responseStartTime: Date.now(),
      endTime: Date.now(),
      duration: Date.now() - captureData.timestamp,
    };

    captureSession.requests.push(captureData);
    captureSession.summary.totalRequests++;
    captureSession.summary.byMethod[captureData.method] = (captureSession.summary.byMethod[captureData.method] || 0) + 1;
    captureSession.summary.byResourceType[captureData.resourceType] = (captureSession.summary.byResourceType[captureData.resourceType] || 0) + 1;

    const domain = extractDomain(url);
    captureSession.summary.byDomain[domain] = (captureSession.summary.byDomain[domain] || 0) + 1;
    if (isCaptchaRequest(url)) captureSession.summary.captchaRequests.push(url);

    captureData.requestCookies.forEach(cookie => {
      if (isF5Cookie(cookie.name) && !captureSession.summary.f5Cookies.includes(cookie.name))
        captureSession.summary.f5Cookies.push(cookie.name);
      if (isAspNetSessionCookie(cookie.name) && !captureSession.summary.aspNetSessionCookies.includes(cookie.value))
        captureSession.summary.aspNetSessionCookies.push(cookie.value);
    });

    if (captureId) requestCaptureMap.delete(captureId);

    // Log prioritaire pour les requêtes cibles
    if (isTarget) {
      const redirectInfo = isRedirect ? ` → Location: ${locationHeader}` : '';
      console.log(`✅ [CIBLE RÉPONSE] ${status}${redirectInfo} ${url}`);
      if (responseBody) {
        try {
          const parsed = JSON.parse(responseBody);
          console.log(`   JSON: ${JSON.stringify(parsed, null, 2).slice(0, 600)}`);
        } catch {
          console.log(`   Body: ${responseBody.slice(0, 300)}`);
        }
      }
      console.log(`${'═'.repeat(70)}\n`);
    } else {
      const redirectInfo = isRedirect ? ` [302→${locationHeader?.slice(0, 60)}]` : '';
      console.log(`[RESPONSE] ${status}${redirectInfo} ${url.slice(0, 80)} (${captureData.timing?.duration || 0}ms)`);
    }
  } catch (error) {
    console.log(`[RESPONSE-ERROR] ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Capture au niveau CONTEXT (attrape toutes les pages + popups) ───────────────

function setupContextInterception(ctx: BrowserContext): void {
  console.log('[DEBUG] Attachement listeners context-level (toutes pages + popups)');

  ctx.on('request', async (request: Request) => {
    await handleRequest(request);
  });

  ctx.on('response', async (response: Response) => {
    await handleResponse(response);
  });
}

// ─── Capture par page (fallback / logs page-level) ──────────────────────────────

async function setupNetworkInterception(page: Page): Promise<void> {
  console.log(`[DEBUG] Setup page-level interception: ${page.url() || 'new page'}`);

  page.on('request', async (request: Request) => {
    await handleRequest(request, page);
  });

  page.on('response', async (response: Response) => {
    await handleResponse(response);
  });
}

// ─── Sauvegarde des données ─────────────────────────────────────────────────────

async function saveCaptureData(): Promise<void> {
  if (isSaving) {
    console.log('\n⚠️  Déjà en train de sauvegarder les données...');
    return;
  }

  isSaving = true;

  try {
    captureSession.endTime = Date.now();

    // Construire le flux integration avant de sauvegarder
    captureSession.integrationFlow = buildIntegrationFlow();

    // Afficher le résumé du flux integration dans le terminal
    printIntegrationFlowSummary(captureSession.integrationFlow);

    if (!fs.existsSync(DEBUG_DUMP_DIR)) {
      fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `cev-capture-${timestamp}.json`;
    const filepath = path.join(DEBUG_DUMP_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(captureSession, null, 2));

    console.log(`\n✅ Capture complète sauvegardée : ${filepath}`);
    console.log(`   Total requêtes : ${captureSession.summary.totalRequests}`);
    console.log(`   Requêtes captcha : ${captureSession.summary.captchaRequests.length}`);
    console.log(`   Cookies F5 : ${captureSession.summary.f5Cookies.length}`);
    console.log(`   Cookies ASP.NET : ${captureSession.summary.aspNetSessionCookies.length}`);

    await saveChronologicalDumps(timestamp);

  } catch (error) {
    console.error('\n❌ Erreur lors de la sauvegarde :', error);
    throw error;
  } finally {
    isSaving = false;
  }
}

/**
 * Affiche un résumé visuel du flux integration dans le terminal.
 */
function printIntegrationFlowSummary(flow: IntegrationFlow): void {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║         RÉSUMÉ DU FLUX INTEGRATION CEV                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  if (flow.getEAppointmentUrl) {
    console.log(`\n1️⃣  GetEAppointmentUrl`);
    console.log(`   URL: ${flow.getEAppointmentUrl.requestUrl}`);
    console.log(`   Integration URL extraite: ${flow.getEAppointmentUrl.integrationUrl || '(non trouvée)'}`);
  } else {
    console.log(`\n1️⃣  GetEAppointmentUrl : ❌ non capturé`);
  }

  if (flow.integrationVowFetch) {
    console.log(`\n2️⃣  GET /Integration/VOW/...`);
    console.log(`   URL: ${flow.integrationVowFetch.url}`);
    console.log(`   Status: ${flow.integrationVowFetch.responseStatus}`);
    if (flow.integrationVowFetch.locationHeader) {
      console.log(`   → Location: ${flow.integrationVowFetch.locationHeader}`);
    }
    const aspNet = flow.integrationVowFetch.requestCookies.find(c => c.name === 'ASP.NET_SessionId');
    console.log(`   ASP.NET_SessionId: ${aspNet?.value || '(absent)'}`);
  } else {
    console.log(`\n2️⃣  GET /Integration/VOW/... : ❌ non capturé`);
  }

  if (flow.captchaPageLoad) {
    console.log(`\n3️⃣  Page /Captcha chargée`);
    console.log(`   URL: ${flow.captchaPageLoad.url}`);
    console.log(`   Status: ${flow.captchaPageLoad.responseStatus}`);
    console.log(`   ASP.NET_SessionId: ${flow.captchaPageLoad.aspNetSessionId || '(absent)'}`);
  } else {
    console.log(`\n3️⃣  Page /Captcha : ❌ non capturé`);
  }

  if (flow.setCaptchaToken) {
    console.log(`\n4️⃣  POST /Captcha/SetCaptchaToken`);
    console.log(`   URL: ${flow.setCaptchaToken.url}`);
    console.log(`   Request Body: ${flow.setCaptchaToken.requestBody.slice(0, 100)}`);
    console.log(`   Headers (${flow.setCaptchaToken.requestHeadersOrder.length}): ${flow.setCaptchaToken.requestHeadersOrder.join(' | ')}`);
    console.log(`   Response Status: ${flow.setCaptchaToken.responseStatus}`);
    if (flow.setCaptchaToken.responseJson) {
      const j = flow.setCaptchaToken.responseJson;
      console.log(`   captchaSolved: ${j.captchaSolved}`);
      console.log(`   validUntil: ${j.validUntil || '(null)'}`);
      console.log(`   redirectUrl: ${j.redirectUrl || '(null)'}`);
    } else {
      console.log(`   Response Body: ${flow.setCaptchaToken.responseBody.slice(0, 300)}`);
    }
  } else {
    console.log(`\n4️⃣  POST /Captcha/SetCaptchaToken : ❌ non capturé`);
  }

  if (flow.postCaptchaRedirectChain) {
    const chain = flow.postCaptchaRedirectChain;
    console.log(`\n5️⃣  Chaîne de redirections post-captcha (${chain.hops.length} hops)`);
    chain.hops.forEach((hop, i) => {
      const arrow = i < chain.hops.length - 1 ? '→' : '●';
      const loc = hop.locationHeader ? ` [→ ${hop.locationHeader.slice(0, 60)}]` : '';
      console.log(`   ${arrow} [${hop.status || '?'}] ${hop.url}${loc}`);
    });
    const verdictEmoji = {
      slots_available: '🟢',
      no_availability: '🔴',
      session_expired: '🟠',
      multi_session: '🔵',
      error: '⚠️',
      unknown: '❓',
    }[chain.verdict];
    console.log(`\n   Verdict : ${verdictEmoji} ${chain.verdict.toUpperCase()}`);
  } else {
    console.log(`\n5️⃣  Chaîne de redirections : ❌ non reconstruite`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════\n');
}

async function saveChronologicalDumps(baseTimestamp: string): Promise<void> {
  const steps = [
    {
      name: '01_initial',
      filter: (r: NetworkRequest) => r.url.includes('visaonweb.diplomatie.be') && !r.url.includes('GetEAppointmentUrl'),
    },
    {
      name: '02_login',
      filter: (r: NetworkRequest) => r.url.includes('Login') || r.url.includes('Account'),
    },
    {
      name: '03_mylist',
      filter: (r: NetworkRequest) => r.url.includes('MyList') || r.url.includes('IndexByUserId'),
    },
    {
      name: '04_geteappointment',
      filter: (r: NetworkRequest) => r.url.includes('GetEAppointmentUrl') || r.url.includes('GetEAppointment'),
    },
    {
      // FIX — inclure les 302 (isRedirect) dans le dump integration
      name: '05_integration_vow',
      filter: (r: NetworkRequest) =>
        r.url.includes('appointment.cloud.diplomatie.be') &&
        r.url.includes('/Integration/VOW/') &&
        !r.url.includes('SetCaptchaToken'),
    },
    {
      name: '06_captcha_page',
      filter: (r: NetworkRequest) =>
        r.url.includes('appointment.cloud.diplomatie.be/Captcha') &&
        !r.url.includes('SetCaptchaToken') ||
        isCaptchaRequest(r.url),
    },
    {
      name: '07_setcaptchatoken',
      filter: (r: NetworkRequest) => r.url.includes('SetCaptchaToken'),
    },
    {
      // FIX — capturer les redirections post-captcha (302 vers SelectSlot/NoAvailability/SessionExpired)
      name: '08_post_captcha_redirects',
      filter: (r: NetworkRequest) =>
        r.url.includes('appointment.cloud.diplomatie.be') && (
          r.url.includes('/Integration/Error/') ||
          r.url.includes('/Integration/VOW/SelectSlot') ||
          r.isRedirect === true
        ),
    },
    {
      name: '09_availabletimeslots',
      filter: (r: NetworkRequest) => r.url.includes('AvailableTimeSlots'),
    },
    {
      name: '10_final',
      filter: (_r: NetworkRequest) => true,
    },
  ];

  let processedRequests = new Set<string>();

  for (const step of steps) {
    const stepRequests = captureSession.requests.filter(r =>
      !processedRequests.has(r.id) && step.filter(r)
    );

    if (stepRequests.length > 0) {
      const stepFilename = `${baseTimestamp}-${step.name}.json`;
      const stepFilepath = path.join(DEBUG_DUMP_DIR, stepFilename);

      const stepData = {
        stepName: step.name,
        timestamp: Date.now(),
        requestCount: stepRequests.length,
        requests: stepRequests,
      };

      fs.writeFileSync(stepFilepath, JSON.stringify(stepData, null, 2));
      console.log(`   Étape sauvegardée : ${stepFilename} (${stepRequests.length} requêtes)`);

      stepRequests.forEach(r => processedRequests.add(r.id));
    }
  }

  // FIX — Dump dédié "integration_flow" : structure reconstruite (SetCaptchaToken + redirections)
  if (captureSession.integrationFlow) {
    const flowFilename = `${baseTimestamp}-integration_flow.json`;
    const flowFilepath = path.join(DEBUG_DUMP_DIR, flowFilename);
    fs.writeFileSync(flowFilepath, JSON.stringify({
      description: 'Flux integration CEV reconstruit : GetEAppointmentUrl → Integration/VOW → Captcha → SetCaptchaToken → redirections → verdict',
      generatedAt: new Date().toISOString(),
      flow: captureSession.integrationFlow,
      redirectChainMap: Object.fromEntries(redirectChainMap),
    }, null, 2));
    console.log(`   Flux integration sauvegardé : ${flowFilename}`);
  }
}

// ─── Fonction pour terminer proprement la capture ─────────────────────────────

async function terminateCapture(): Promise<void> {
  if (isTerminating) return;

  isTerminating = true;

  console.log('\n🛑 Terminaison de la capture en cours...');

  try {
    await saveCaptureData();
  } catch (error) {
    console.error('\n❌ Erreur lors de la sauvegarde finale :', error);
  }

  try {
    if (browser) await browser.close();
  } catch (error) {
    console.error('\n❌ Erreur lors de la fermeture du navigateur :', error);
  }

  console.log('\n✅ Capture terminée avec succès !');
  process.exit(0);
}

// ─── Key Listener pour attendre ENTER ─────────────────────────────────────────────

async function waitForUserAction(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🔍 NAVIGATEUR PRÊT - Navigation humaine en cours...');
  console.log('');
  console.log('   FLUX À SUIVRE POUR CAPTURER LES CIBLES :');
  console.log('   1. Connectez-vous à visaonweb.diplomatie.be');
  console.log('   2. Naviguez vers votre dossier');
  console.log('   3. Cliquez sur "Prendre rendez-vous"');
  console.log('      → Un onglet appointment.cloud.diplomatie.be/Captcha s\'ouvre');
  console.log('   4. Résolvez le captcha (puzzle visuel) et cliquez "Vérifier"');
  console.log('      → Le POST /Captcha/SetCaptchaToken sera capturé avec le token');
  console.log('      → La chaîne de redirections sera tracée automatiquement');
  console.log('   5. Attendez la réponse finale (NoAvailability ou SelectSlot)');
  console.log('');
  console.log('   CIBLES SURVEILLÉES EN TEMPS RÉEL (🎯 dans les logs) :');
  console.log('   • GET  /GetEAppointmentUrl');
  console.log('   • GET  /Integration/VOW/{...}');
  console.log('   • appointment.cloud.diplomatie.be/Captcha');
  console.log('   • POST /Captcha/SetCaptchaToken');
  console.log('   • GET  /Integration/Error/NoAvailability');
  console.log('   • GET  /Integration/Error/SessionExpired');
  console.log('   • GET  /Integration/VOW/SelectSlot');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('\n⏳ Options de terminaison :');
  console.log('   • Appuyez sur [ENTER] dans ce terminal');
  console.log('   • Fermez manuellement la fenêtre du navigateur');
  console.log('   • Appuyez sur [Ctrl+C] dans le terminal');
  console.log('\nLa capture sera automatiquement sauvegardée.\n');

  if (browser) {
    browser.on('disconnected', async () => {
      console.log('\n⚠️  Navigateur fermé manuellement. Sauvegarde des données...');
      rl.close();
      await terminateCapture();
    });
  }

  return new Promise((resolve) => {
    rl.on('line', () => {
      console.log('\n⏸️  Entrée utilisateur détectée. Sauvegarde des données...');
      rl.close();
      resolve();
    });

    const sigintHandler = async () => {
      console.log('\n⚠️  Signal SIGINT (Ctrl+C) détecté. Sauvegarde des données...');
      process.removeListener('SIGINT', sigintHandler);
      rl.close();
      await terminateCapture();
    };

    process.on('SIGINT', sigintHandler);
  });
}

// ─── Fonction principale ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🔬 CEV NETWORK SNIFFER - Capture réseau complète');
  console.log('   Cibles : GetEAppointmentUrl + Integration/VOW + SetCaptchaToken + redirections');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    captureSession.sessionId = `session_${Date.now()}`;
    captureSession.startTime = Date.now();

    console.log('🚀 Lancement du navigateur Playwright...');
    browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized'],
    });

    context = await browser.newContext({
      viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      locale: 'fr-BE',
      timezoneId: 'Europe/Brussels',
    });

    // Context-level interception — attrape TOUTES les requêtes de toutes les pages/popups
    // y compris les onglets qui s'ouvrent pour appointment.cloud.diplomatie.be
    setupContextInterception(context);

    context.on('page', async (newPage: Page) => {
      console.log(`\n🚨 [POPUP] Nouvel onglet : ${newPage.url() || '(en cours de chargement)'}`);
      await setupNetworkInterception(newPage);
    });

    const page = await context.newPage();

    console.log('[DEBUG] Attachement listeners page principale...');
    await setupNetworkInterception(page);

    captureSession.userAgent = await page.evaluate(() => navigator.userAgent);
    console.log(`[DEBUG] User-Agent: ${captureSession.userAgent}`);

    console.log('🌐 Navigation vers visaonweb.diplomatie.be...');

    await page.goto('https://visaonweb.diplomatie.be', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log('✅ Navigation terminée. La capture réseau est active.');

    await waitForUserAction();

    await terminateCapture();

  } catch (error) {
    console.error('\n❌ Erreur lors de la capture :', error);

    try {
      console.log('\n⚠️  Tentative de sauvegarde malgré l\'erreur...');
      await saveCaptureData();
    } catch (saveError) {
      console.error('❌ Impossible de sauvegarder après l\'erreur :', saveError);
    }

    try {
      if (browser) await browser.close();
    } catch (closeError) {
      console.error('❌ Erreur lors de la fermeture du navigateur :', closeError);
    }

    process.exit(1);
  }
}

// ─── Exécution ─────────────────────────────────────────────────────────────────

main().catch(console.error);
