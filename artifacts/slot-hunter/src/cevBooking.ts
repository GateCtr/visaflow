import type { Page } from 'puppeteer';
import type { PuppeteerContextAdapter } from './browser.js';
import type { HunterJob } from './convexClient';
import { botLog, uploadScreenshot, recordCevClick, activateCevSession, persistCevLoopSession, restoreCevLoopSession } from './convexClient';
import { resolveAnticaptchaKey, resolveNonecapKey, resolveTwocaptchaKey } from './cevHttpSetup.js';
import { completeCevCaptcha, pollCevSlots, pollCevSlotsMultiMonth, isCevSessionValid, CevSession } from './cevPortal';
import { launchBrowser, randomDelay, humanType, humanClick, humanScroll } from './browser.js';
import { attachNetCapture } from './netCapture.js';

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';
const VOWINT_BASE = 'https://visaonweb.diplomatie.be';

// Nombre max de clics "Prendre rendez-vous" par heure (limite CEV)
// Serveur CEV : 5 clics/h par AppId (confirme en prod : blocage a 5). Marge de 1 -> 4.
const MAX_CLICKS_PER_HOUR = 4; // limite serveur 5/h, marge de 1
const CLICK_WINDOW_MS = 60 * 60 * 1000;

// Intervalle de poll quand session CEV est active (sans recliquer)
const POLL_INTERVAL_MS = 30_000; // 30s

export interface CevBookingConfig {
  clientId: string;
  vowintUsername: string;
  vowintPassword: string;
  vowintAppointmentUrl: string; // URL complète du bouton "Prendre rendez-vous" sur VOWINT
  twoCaptchaApiKey: string;
  capsolverApiKey?: string;    // CapSolver API key (préféré pour hCaptcha)
  hcaptchaSiteKey?: string;    // sitekey hCaptcha sur appointment.cloud.diplomatie.be
}

export interface CapturedNetworkCall {
  timestamp: number;
  method: string;
  url: string;
  requestBody?: string;
  responseStatus?: number;
  responseBody?: string;
}

export interface BookingResult {
  success: boolean;
  confirmationCode?: string;
  bookedDate?: string;
  bookedTime?: string;
  screenshotStorageId?: string;
  capturedCalls: CapturedNetworkCall[]; // tous les appels réseau capturés
  error?: string;
}

/**
 * Flux complet de réservation CEV via Playwright (Option A).
 *
 * Ce que ça fait :
 *  1. Ouvre VOWINT avec les credentials → navigue vers la page de demande
 *  2. Intercepte le POST VOWINT → appointment.cloud.diplomatie.be/Captcha
 *     → récupère les cookies de session CEV
 *  3. Résout le hCaptcha via 2captcha
 *  4. Vérifie la disponibilité via redirectUrl
 *  5. Si créneaux disponibles → Playwright complète le booking via UI
 *     → capture TOUS les appels réseau en temps réel (pour construire Option B)
 *  6. Prend un screenshot de confirmation
 *  7. Retourne le résultat + les appels réseau capturés
 */
export async function runCevBookingSession(
  config: CevBookingConfig
): Promise<BookingResult> {
  const capturedCalls: CapturedNetworkCall[] = [];
  let browser = null;

  botLog({ applicationId: config.clientId, step: 'cev_booking_start', status: 'ok' });

  try {
    // ── Lancement stealth : iProyal (BrightData blackliste diplomatie.be), StealthPlugin, UA rotation ──
    const launched = await launchBrowser({ locale: 'fr-BE', timezoneId: 'Africa/Kinshasa', proxySource: 'iproyal' });
    browser = launched.browser;
    const context = launched.context;

    // Injecter le cookie d'accessibilité hCaptcha si configuré (bypass gratuit)
    const accessibilityCookie = process.env.HCAPTCHA_ACCESSIBILITY_COOKIE?.trim();
    if (accessibilityCookie) {
      await context.addCookies([{
        name: 'hc_accessibility',
        value: accessibilityCookie,
        domain: '.hcaptcha.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'None',
      }]);
      botLog({ applicationId: config.clientId, step: 'cev_hcaptcha_accessibility_cookie_injected', status: 'ok' });
    }

    // === CAPTURE RÉSEAU COMPLÈTE : VOWINT + CEV (style mitmproxy) ===
    // Capture TOUT le trafic visaonweb.diplomatie.be + appointment.cloud.diplomatie.be
    // → chaque requête/réponse loguée dans Convex (step: net_request / net_response)
    // → permet de voir la réponse serveur quand la limite 20 clics/h est atteinte
    const netCapture = attachNetCapture(context, config.clientId);

    // === ÉTAPE 1 : Ouvrir VOWINT et naviguer vers la page de demande ===
    const page = launched.page;
    const cevSession = await establishCevSession(page, context, config, capturedCalls);

    if (!cevSession) {
      await browser.close();
      return { success: false, error: 'CEV_SESSION_FAILED', capturedCalls };
    }

    // === ÉTAPE 2 : Résoudre hCaptcha ===
    // Priorité 0 : Mode accessibilité hCaptcha (cookie hc_accessibility, gratuit)
    let hcaptchaToken: string | null = null;
    if (accessibilityCookie && cevSession.cevPage) {
      hcaptchaToken = await solveHcaptchaViaAccessibility(cevSession.cevPage, config.clientId);
    }
    // Fallback : services externes (Anti-Captcha → CapSolver → 2captcha)
    if (!hcaptchaToken) {
      hcaptchaToken = await solveHcaptcha(config.twoCaptchaApiKey, config.clientId, config.capsolverApiKey);
    }
    if (!hcaptchaToken) {
      await browser.close();
      return { success: false, error: 'HCAPTCHA_FAILED', capturedCalls };
    }

    // === ÉTAPE 3 : Vérifier disponibilité via SetCaptchaToken ===
    const captchaResult = await completeCevCaptcha(cevSession.cookies, hcaptchaToken, config.clientId);

    if (captchaResult.status === 'no_availability') {
      await browser.close();
      return { success: false, error: 'NO_AVAILABILITY', capturedCalls };
    }

    if (captchaResult.status === 'session_error') {
      await browser.close();
      return { success: false, error: captchaResult.error, capturedCalls };
    }

    // === ÉTAPE 4 : Créneaux disponibles → Playwright complète le booking via UI ===
    const session = captchaResult.session;
    botLog({ applicationId: config.clientId, step: 'cev_booking_slots_found', status: 'ok', data: { redirectUrl: session.redirectUrl } });

    const result = await completebookingViaUI(page, session, config, capturedCalls);

    netCapture.dump();
    await browser.close();
    return { ...result, capturedCalls };

  } catch (err) {
    botLog({ applicationId: config.clientId, step: 'cev_booking_crash', status: 'fail', data: { error: String(err) } });
    try { if (browser) await (browser as { close(): Promise<void> }).close(); } catch { /* ignore */ }
    return { success: false, error: String(err), capturedCalls };
  }
}

/**
 * Établit la session CEV via VOWINT (visaonweb.diplomatie.be).
 *
 * Flux réel (découvert par inspection live du portail) :
 *  1. Login VOWINT via formulaire #UserName / button[type="submit"]
 *  2. Naviguer vers "My Applications" (/en/VisaApplication/IndexByUserId)
 *     OU vers l'URL spécifique si vowintAppointmentUrl est fourni
 *  3. Cliquer [ng-click*="groupVAEapp"] = bouton calendrier AngularJS (icône calendrier)
 *  4. Nouveau onglet s'ouvre → appointment.cloud.diplomatie.be/Captcha
 *  5. Extraire ASP.NET_SessionId depuis le jar du navigateur (context.cookies())
 */
async function establishCevSession(
  page: Page,
  context: PuppeteerContextAdapter,
  config: CevBookingConfig,
  _capturedCalls: CapturedNetworkCall[]
): Promise<{ cookies: string; cevPage: Page; integrationUrl: string | null } | null> {
  try {
    // === ÉTAPE 0 : Login VOWINT ===
    botLog({ applicationId: config.clientId, step: 'cev_vowint_login_start', status: 'ok', data: { user: config.vowintUsername } });

    // Listener réseau : détecte BrightData 402 sur N'IMPORTE quelle requête diplomatie.be.
    // Couvre à la fois le GET initial ET le POST /en/Account/Login.
    // x-luminati-error header = signature BrightData "Residential Failed (bad_endpoint)".
    let brightData402Detected = false;
    const onResponse = (response: any) => {
      if (!response.url().includes('diplomatie.be')) return;
      if (response.status() !== 402) return;
      const hdrs = response.headers();
      if (hdrs['x-luminati-error'] || hdrs['x-lpm-error'] || hdrs['x-brd-error']) {
        brightData402Detected = true;
        console.warn(`[CEV] ⚡ BrightData 402 détecté sur ${response.request().method()} ${response.url()}`);
      }
    };
    page.on('response', onResponse);

    await page.goto('https://visaonweb.diplomatie.be', { waitUntil: 'load', timeout: 90_000 });
    // Attendre que le DOM soit suffisamment chargé pour interagir (best-effort)
    await (page as any).waitForNavigation?.({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

    // BrightData peut retourner HTTP 402 "bad_endpoint" pour visaonweb.diplomatie.be.
    // Le listener ci-dessus couvre le GET initial ; on vérifie aussi le contenu de la page.
    const isVowintPage = await page.evaluate(() => {
      const body = (document.body?.textContent ?? '').toLowerCase();
      const hasLoginForm = !!document.querySelector('input#UserName');
      const hasVowintContent = document.location.hostname.includes('diplomatie.be')
        || body.includes('visa') || body.includes(' visa application');
      const isBrightDataError = body.includes('luminati') || body.includes('bad_endpoint')
        || body.includes('residential failed') || body.includes('not available');
      return hasLoginForm || (hasVowintContent && !isBrightDataError);
    }).catch(() => true);
    if (!isVowintPage || brightData402Detected) {
      throw new Error('ERR_PROXY_BAD_ENDPOINT: BrightData a bloqué visaonweb.diplomatie.be (402 GET) — retry sans proxy');
    }

    const loginTitle = await page.title().catch(() => "");
    const loginUrl = page.url();
    const isLoginPage = loginTitle.toLowerCase().includes('login') ||
      loginTitle.toLowerCase().includes('connexion') ||
      loginUrl.toLowerCase().includes('account/login');

    console.log(`[CEV] page VOWINT chargée — titre="${loginTitle}" url=${loginUrl} isLoginPage=${isLoginPage}`);

    if (isLoginPage) {
      // Comportement humain : délais naturels entre chaque champ
      await randomDelay(600, 1_200);
      await humanType(page, 'input#UserName', config.vowintUsername);
      await randomDelay(400, 900);
      await humanType(page, 'input#Password', config.vowintPassword);
      await randomDelay(300, 700);
      await humanClick(page, 'button[type="submit"]');
      // Utiliser domcontentloaded (networkidle peut ne jamais se stabiliser sur VOWINT/AngularJS)
      await (page as any).waitForNavigation?.({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await randomDelay(1_000, 2_000); // laisser le redirect s'établir

      // Vérifier BrightData 402 sur le POST login AVANT d'analyser l'URL
      if (brightData402Detected) {
        console.warn('[CEV] BrightData 402 sur POST login — lancement retry forceNoProxy');
        throw new Error('ERR_PROXY_BAD_ENDPOINT: BrightData a bloqué POST /Account/Login (402) — retry sans proxy');
      }

      const afterUrl = page.url();
      // page.title() peut lever "Execution context was destroyed" si BrightData renvoie
      // une réponse 402 au POST login qui déclenche une navigation d'erreur.
      const afterTitle = await page.title().catch(async () => {
        await new Promise(r => setTimeout(r, 600));
        return page.title().catch(() => "");
      });
      const stillLogin = afterUrl.toLowerCase().includes('account/login') ||
        afterTitle.toLowerCase().includes('login') ||
        afterTitle.toLowerCase().includes('connexion');

      console.log(`[CEV] après login — url=${afterUrl} stillLogin=${stillLogin}`);

      if (stillLogin) {
        // Capturer le message d'erreur précis + présence hCaptcha
        const errMsg = await page.$eval(
          '.validation-summary-errors, .alert, .field-validation-error, [class*="error"], [class*="Error"]',
          (el: any) => el.innerText?.trim() ?? ''
        ).catch(() => '');
        const hasHcaptcha = await page.$('iframe[src*="hcaptcha"]').then(el => !!el).catch(() => false);
        const hasHcaptchaScript = await page.$('script[src*="hcaptcha"]').then(el => !!el).catch(() => false);
        console.error(`[CEV] ❌ Login VOWINT échoué — url=${afterUrl} errMsg="${errMsg}" hcaptcha=${hasHcaptcha || hasHcaptchaScript}`);
        botLog({ applicationId: config.clientId, step: 'cev_vowint_login_failed', status: 'fail', data: { afterUrl, afterTitle, errMsg, hasHcaptcha } });
        return null;
      }
      botLog({ applicationId: config.clientId, step: 'cev_vowint_login_ok', status: 'ok', data: { afterUrl } });
    }

    // === ÉTAPE 1 : Naviguer vers la page des dossiers ===
    // Si une URL spécifique est fournie et commence par https://, l'utiliser.
    // Sinon → page "My Applications" par défaut.
    const targetUrl = (config.vowintAppointmentUrl &&
      config.vowintAppointmentUrl !== 'https://visaonweb.diplomatie.be' &&
      config.vowintAppointmentUrl.startsWith('https://'))
      ? config.vowintAppointmentUrl
      : 'https://visaonweb.diplomatie.be/en/VisaApplication/IndexByUserId';

    // domcontentloaded d'abord, puis on attend networkidle en best-effort
    // AngularJS fait du XHR polling — networkidle peut ne jamais se stabiliser
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await (page as any).waitForNavigation?.({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await (page as any).waitForNavigation?.({ waitUntil: 'networkidle0', timeout: 15_000 }).catch(() => {});
    // Attendre le rendu AngularJS (lazy-loaded) + micro-pause humaine avant interaction
    await randomDelay(2_000, 4_000);
    await humanScroll(page); // scroll naturel — évite le pattern "goto → clic immédiat"

    console.log(`[CEV] page dossiers chargée — url=${page.url()}`);
    botLog({ applicationId: config.clientId, step: 'cev_vowint_apps_page', status: 'ok', data: { url: page.url() } });

    // === ÉTAPE 2 : Trouver le bouton calendrier "Prendre rendez-vous" ===
    // VOWINT AngularJS : ng-click="groupVAEapp(...)" = bouton RDV (icône calendrier .fa-calendar)
    const rdvBtn = await page.$('[ng-click*="groupVAEapp"]') ??
                   await page.$('button:has(.fa-calendar)') ??
                   await page.$('[ng-click*="appointment"]');

    if (!rdvBtn) {
      // Vérifier si c'est la limite de clics/heure (message VOWINT visible sur la page)
      // Serveur : "plus de 5 fois dans l'heure" (limite reelle confirmee en prod).
      // On garde aussi "20 fois" par securite au cas ou un autre seuil apparaisse.
      const pageText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      const isRateLimited = pageText.includes('5 fois') || pageText.includes('5 times') ||
        pageText.includes('20 fois') || pageText.includes('20 times') ||
        pageText.includes('bloqué pendant') || pageText.includes('blocked for');

      const allNgClicks = await page.$$eval('[ng-click]', (els: any[]) =>
        els.map(e => e.getAttribute('ng-click'))
      ).catch(() => []);

      if (isRateLimited) {
        console.warn(`[CEV] ⏳ Limite 5 clics/heure atteinte — pas un échec de login`);
        botLog({ applicationId: config.clientId, step: 'cev_rdv_rate_limited', status: 'warn', data: { pageText: pageText.slice(0, 300) } });
        // Retourner null avec un marqueur spécial pour que le caller ne compte pas ça comme login_fail
        return null;
      }

      console.error(`[CEV] ❌ Bouton RDV introuvable — ng-clicks disponibles: ${JSON.stringify(allNgClicks)}`);
      botLog({ applicationId: config.clientId, step: 'cev_rdv_btn_not_found', status: 'fail', data: { allNgClicks } });
      return null;
    }

    console.log(`[CEV] ✅ Bouton RDV trouvé — clic dans 1-2.5s...`);
    botLog({ applicationId: config.clientId, step: 'cev_rdv_btn_found', status: 'ok' });

    // Micro-pause humaine avant clic — évite le pattern "login → clic immédiat" (détectable)
    await randomDelay(1_000, 2_500);

    // === ÉTAPE 3 : Cliquer et attendre le nouvel onglet CEV ===
    // Capture l'URL d'intégration dès l'ouverture de l'onglet (avant le redirect /Captcha)
    let capturedIntegrationUrl: string | null = null;
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }).then(pg => {
        // Capturer les requêtes de navigation ET les réponses de redirection
        pg.on('request', (req) => {
          if (!capturedIntegrationUrl && req.isNavigationRequest() && req.url().includes('/Integration/VOW/')) {
            capturedIntegrationUrl = req.url();
          }
        });
        // Fallback: capturer l'URL depuis les redirections (302) dans les réponses
        pg.on('response', (res) => {
          if (!capturedIntegrationUrl) {
            const resUrl = res.url();
            if (resUrl.includes('/Integration/VOW/')) {
              capturedIntegrationUrl = resUrl;
            }
            // Si la réponse est un redirect, vérifier le header Location
            if (res.status() >= 300 && res.status() < 400) {
              const loc = res.headers()['location'];
              if (loc && loc.includes('/Integration/VOW/')) {
                capturedIntegrationUrl = loc.startsWith('http') ? loc : `https://appointment.cloud.diplomatie.be${loc}`;
              }
            }
          }
        });
        return pg;
      }),
      rdvBtn.click(),
    ]);

    await (newPage as any).waitForNavigation?.({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await randomDelay(1_500, 3_000); // laisser les cookies s'établir dans le jar

    // Fallback 1 : si le premier event de navigation était déjà /Captcha, essayer l'URL courante
    if (!capturedIntegrationUrl) {
      const tabUrl = newPage.url();
      if (tabUrl.includes('/Integration/VOW/')) capturedIntegrationUrl = tabUrl;
    }

    // Fallback 2 : extraire l'URL d'intégration depuis la page /Captcha elle-même
    // La page Captcha de CEV contient souvent un lien/form-action vers /Integration/VOW/...
    if (!capturedIntegrationUrl) {
      try {
        const pageContent = await newPage.content();
        const vowMatch = pageContent.match(/https?:\/\/appointment\.cloud\.diplomatie\.be\/Integration\/VOW\/[^\s"'<>]+/i);
        if (vowMatch) {
          capturedIntegrationUrl = vowMatch[0];
        }
      } catch { /* ignore - page may not be ready */ }
    }

    // Fallback 3 : construire l'URL depuis le VOWINT redirect (si on a le GetEAppointmentUrl)
    // En dernier recours, on peut récupérer l'URL depuis l'historique de navigation du page
    if (!capturedIntegrationUrl) {
      try {
        // Vérifier si la page originale (VOWINT) a un lien GetEAppointmentUrl visible
        const mainFrameUrl = newPage.mainFrame().url();
        // Chercher dans les frames de la page principale
        const allFrames = newPage.frames();
        for (const frame of allFrames) {
          const fUrl = frame.url();
          if (fUrl.includes('/Integration/VOW/')) {
            capturedIntegrationUrl = fUrl;
            break;
          }
        }
      } catch { /* ignore */ }
    }

    const newPageUrl = newPage.url();
    botLog({ applicationId: config.clientId, step: 'cev_new_tab_opened', status: 'ok', data: { url: newPageUrl } });

    console.log(`[CEV] nouvel onglet — url=${newPageUrl} integrationUrl=${capturedIntegrationUrl ?? 'non_capturee'}`);

    if (!newPageUrl.includes('appointment.cloud.diplomatie.be')) {
      console.error(`[CEV] ❌ Mauvais onglet — attendu appointment.cloud.diplomatie.be, obtenu: ${newPageUrl}`);
      botLog({ applicationId: config.clientId, step: 'cev_wrong_tab', status: 'fail', data: { url: newPageUrl } });
      return null;
    }

    // === ÉTAPE 4 : Extraire ASP.NET_SessionId depuis le jar navigateur ===
    const allCookies = await context.cookies();
    const cevCookies = allCookies.filter(c =>
      (c.domain ?? '').includes('appointment.cloud.diplomatie.be')
    );

    if (cevCookies.length === 0) {
      botLog({ applicationId: config.clientId, step: 'cev_session_cookie_missing', status: 'fail' });
      return null;
    }

    const cookieString = cevCookies.map(c => `${c.name}=${c.value}`).join('; ');
    botLog({
      applicationId: config.clientId,
      step: 'cev_session_cookie_captured',
      status: 'ok',
      data: { cookieLen: cookieString.length, names: cevCookies.map(c => c.name).join(', ') },
    });

    botLog({
      applicationId: config.clientId,
      step: 'cev_integration_url_captured',
      status: capturedIntegrationUrl ? 'ok' : 'warn',
      data: { integrationUrl: capturedIntegrationUrl ?? 'not_captured' },
    });

    return { cookies: cookieString, cevPage: newPage, integrationUrl: capturedIntegrationUrl };

  } catch (err) {
    const errStr = String(err);
    // Les erreurs proxy/tunnel doivent remonter au caller pour que sa boucle retry
    // (forceNoProxy=true) puisse se déclencher — ne pas absorber ici.
    const isProxyOrTunnel = errStr.includes('ERR_TUNNEL_CONNECTION_FAILED')
      || errStr.includes('ERR_PROXY_CONNECTION_FAILED')
      || errStr.includes('PROXY_CONNECTION_FAILED')
      || errStr.includes('TUNNEL_CONNECTION_FAILED')
      || errStr.includes('ERR_PROXY_BAD_ENDPOINT'); // BrightData 402 bad_endpoint
    if (isProxyOrTunnel) throw err;
    console.error(`[CEV] ❌ establishCevSession crash: ${errStr}`);
    botLog({ applicationId: config.clientId, step: 'cev_session_establish_error', status: 'fail', data: { error: errStr.slice(0, 400) } });
    return null;
  }
}

/**
 * Complète le booking via l'UI Playwright une fois que les créneaux sont disponibles.
 * Capture tous les appels réseau pour reverse engineering.
 *
 * Architecture CEV confirmée (analyse bundle sharedScripts v1.0.249.0) :
 *  - CEV = ASP.NET MVC + Bootstrap + jQuery — PAS AngularJS
 *  - Page SelectSlot : server-rendered HTML + inline JS appelant getAvailableTimeSlotsForPublic()
 *  - Flux calendrier :
 *    1. Page calendrier Bootstrap → appel AJAX POST /Home/AvailableTimeSlots (JSON) → dates dispo
 *    2. Cliquer une date → chargement des créneaux horaires (probablement AJAX)
 *    3. Sélectionner un créneau → formulaire de confirmation
 *    4. Soumettre → page de succès avec code de référence
 *  - Le bouton "Annuler" utilise SharedAjaxService.appointmentCancelRequest
 *    avec {uniqueToken, cultureCode} vers Shared/DoCancelRequestAppointment
 */
async function completebookingViaUI(
  page: Page,
  session: CevSession,
  config: CevBookingConfig,
  capturedCalls: CapturedNetworkCall[]
): Promise<Omit<BookingResult, 'capturedCalls'>> {
  try {
    const calendarUrl = `${CEV_BASE}${session.redirectUrl}`;

    // ── Intercepter /Home/AvailableTimeSlots AVANT la navigation ────────────
    // waitForResponse doit être enregistré avant goto() pour ne pas rater l'appel.
    const slotsResponsePromise = page.waitForResponse(
      (r) => r.url().includes('/Home/AvailableTimeSlots'),
      { timeout: 12_000 },
    ).catch(() => null);

    await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    botLog({ applicationId: config.clientId, step: 'cev_calendar_loaded', status: 'ok', data: { url: calendarUrl } });

    // Laisser le calendrier Bootstrap se charger (appel AJAX /Home/AvailableTimeSlots)
    await randomDelay(2_500, 4_500);

    // ── Dump /Home/AvailableTimeSlots (requête + réponse exactes) ────────────
    const slotsResp = await slotsResponsePromise;
    if (slotsResp) {
      try {
        const reqBody  = slotsResp.request().postData() ?? null;
        const resBody  = await slotsResp.text().catch(() => null);
        const resCT    = slotsResp.headers()['content-type'] ?? '';
        botLog({
          applicationId: config.clientId,
          step: 'cev_available_timeslots_dump',
          status: 'ok',
          data: {
            url:             slotsResp.url().replace(CEV_BASE, ''),
            httpStatus:      slotsResp.status(),
            requestBody:     reqBody,
            responseContentType: resCT,
            responsePreview: resBody?.slice(0, 2000) ?? null,
            responseType:    (() => {
              try { const p = JSON.parse(resBody ?? 'null'); return Array.isArray(p) ? 'array' : typeof p; } catch { return 'non-json'; }
            })(),
            responseKeys:    (() => {
              try { const p = JSON.parse(resBody ?? 'null'); return (p && typeof p === 'object' && !Array.isArray(p)) ? Object.keys(p) : null; } catch { return null; }
            })(),
          },
        });
      } catch { /* ne pas bloquer le booking */ }
    } else {
      // Aucun appel capturé — loguer le HTML de la page pour comprendre la structure
      const pageHtml = await page.content().catch(() => '');
      botLog({
        applicationId: config.clientId,
        step: 'cev_available_timeslots_not_captured',
        status: 'warn',
        data: {
          hint: 'Aucun appel /Home/AvailableTimeSlots intercepté — page peut être statique ou utiliser un autre endpoint',
          pageHtmlPreview: pageHtml.slice(0, 3000),
          pageUrl: page.url(),
        },
      });
    }

    // ── Dump du HTML complet de la page calendrier ────────────────────────
    // Permet d'identifier les sélecteurs CSS réels des dates/créneaux.
    const calendarHtml = await page.content().catch(() => '');
    botLog({
      applicationId: config.clientId,
      step: 'cev_calendar_html_dump',
      status: 'ok',
      data: { htmlPreview: calendarHtml.slice(0, 4000) },
    });

    // === Sélectionner la première date disponible ===
    // CEV utilise Bootstrap + jQuery datepicker/calendrier maison.
    // Les dates disponibles sont des <td> ou <a> avec classes Bootstrap spécifiques.
    // L'appel AJAX /Home/AvailableTimeSlots retourne les dates dispo — rendu côté client.
    const dateCandidates = [
      // Bootstrap table calendrier — cellule disponible (pas disabled, pas unavailable)
      'td.available:not(.disabled) a',
      'td.available:not(.disabled)',
      'td:not(.disabled):not(.unavailable):not(.past) a[data-date]',
      'td:not(.disabled):not(.grey):not(.old) a',
      // Calendrier maison CEV possible
      'a[data-date]:not([disabled])',
      '[data-date]:not(.disabled):not(.unavailable)',
      // Fallback générique Bootstrap
      '.day:not(.disabled):not(.old):not(.new):not(.unavailable)',
      'td.enabled a',
      '[class*="available"]:not([class*="un"])',
    ];

    let dateClicked = false;
    let bookedDate = '';

    for (const sel of dateCandidates) {
      const dateEl = await page.$(sel);
      if (dateEl) {
        bookedDate = await (dateEl as any).evaluate((el: any) =>
          el.getAttribute('data-date') ?? el.getAttribute('data-value') ?? el.innerText ?? ''
        ).catch(() => '');

        // ── Intercepter les appels POST déclenchés par le clic sur la date ──
        // C'est ici qu'on découvrira l'endpoint de chargement des créneaux horaires.
        const afterDateCallsSnapLen = capturedCalls.length;
        const timeSlotResponsePromise = page.waitForResponse(
          (r) => r.url().includes('appointment.cloud.diplomatie.be') && r.request().method() === 'POST',
          { timeout: 8_000 },
        ).catch(() => null);

        await humanClick(page, sel);
        dateClicked = true;
        botLog({ applicationId: config.clientId, step: 'cev_date_selected', status: 'ok', data: { selector: sel, date: bookedDate } });

        // ── Dump du premier appel POST déclenché après la sélection de date ──
        const timeSlotResp = await timeSlotResponsePromise;
        if (timeSlotResp) {
          try {
            const tsReqBody = timeSlotResp.request().postData() ?? null;
            const tsResBody = await timeSlotResp.text().catch(() => null);
            botLog({
              applicationId: config.clientId,
              step: 'cev_post_date_click_call',
              status: 'ok',
              data: {
                url:             timeSlotResp.url().replace(CEV_BASE, ''),
                httpStatus:      timeSlotResp.status(),
                requestBody:     tsReqBody,
                responsePreview: tsResBody?.slice(0, 2000) ?? null,
                responseType:    (() => {
                  try { const p = JSON.parse(tsResBody ?? 'null'); return Array.isArray(p) ? 'array' : typeof p; } catch { return 'non-json'; }
                })(),
                responseKeys:    (() => {
                  try { const p = JSON.parse(tsResBody ?? 'null'); return (p && typeof p === 'object' && !Array.isArray(p)) ? Object.keys(p) : null; } catch { return null; }
                })(),
                newCallsSinceDate: capturedCalls.length - afterDateCallsSnapLen,
              },
            });
          } catch { /* ne pas bloquer */ }
        } else {
          botLog({
            applicationId: config.clientId,
            step: 'cev_post_date_click_no_ajax',
            status: 'warn',
            data: { hint: 'Aucun POST intercepté après clic date — chargement peut être synchrone (page reload) ou délai trop court' },
          });
        }

        break;
      }
    }

    if (!dateClicked) {
      // Screenshot pour debug si aucun sélecteur ne marche
      const screenshotBuf = await page.screenshot().catch(() => null);
      const screenshotB64 = screenshotBuf ? Buffer.from(screenshotBuf).toString('base64') : null;
      const storageId = screenshotB64 ? await uploadScreenshot(screenshotB64) : null;
      const pageUrl = page.url();
      const pageText = await page.$eval('body', (el: any) => el.innerText).catch(() => '');
      botLog({ applicationId: config.clientId, step: 'cev_no_date_found', status: 'fail', data: { screenshotStorageId: storageId ?? '', pageUrl, pageTextPreview: pageText.slice(0, 300) } });
      return { success: false, error: 'NO_DATE_SELECTOR_MATCHED', screenshotStorageId: storageId ?? undefined };
    }

    // Attendre le chargement des créneaux horaires (AJAX probable après sélection date)
    await (page as any).waitForNavigation?.({ waitUntil: 'networkidle0', timeout: 15_000 }).catch(() => {});
    await randomDelay(1_200, 2_500);

    // ── Dump HTML de la page après sélection de date (structure créneaux horaires) ──
    const afterDateHtml = await page.content().catch(() => '');
    botLog({
      applicationId: config.clientId,
      step: 'cev_after_date_html_dump',
      status: 'ok',
      data: { htmlPreview: afterDateHtml.slice(0, 4000) },
    });

    // === Sélectionner le premier créneau horaire ===
    // CEV affiche des boutons radio ou des liens pour les créneaux.
    // Le formulaire utilise Bootstrap + jQuery — noms de champs à découvrir.
    const timeCandidates = [
      // Radio buttons classiques ASP.NET MVC
      'input[type="radio"][name*="slot"]:not([disabled])',
      'input[type="radio"][name*="time"]:not([disabled])',
      'input[type="radio"][name*="hour"]:not([disabled])',
      'input[type="radio"]:not([disabled])',
      // Liens/boutons Bootstrap
      'a.time-slot:not(.disabled)',
      'button.time-slot:not([disabled])',
      'li.available-slot a',
      'li.slot-item:not(.disabled) a',
      // Attributs data
      '[data-slot-time]:not(.disabled)',
      '[data-time]:not(.disabled)',
      // Tableau de créneaux
      'td.slot-available a',
      'td.time-available a',
      // Sélecteur générique Bootstrap
      '.list-group-item.active ~ .list-group-item:not(.disabled)',
      '.btn-group .btn:not(.disabled):not(.btn-default)',
    ];

    let timeClicked = false;
    let bookedTime = '';

    for (const sel of timeCandidates) {
      const timeEl = await page.$(sel);
      if (timeEl) {
        bookedTime = await (timeEl as any).evaluate((el: any) =>
          el.getAttribute('data-slot-time') ?? el.getAttribute('data-time') ?? el.getAttribute('value') ?? el.innerText ?? ''
        ).catch(() => '');
        await humanClick(page, sel);
        timeClicked = true;
        botLog({ applicationId: config.clientId, step: 'cev_time_selected', status: 'ok', data: { selector: sel, time: bookedTime } });
        break;
      }
    }

    if (timeClicked) {
      await (page as any).waitForNavigation?.({ waitUntil: 'networkidle0', timeout: 15_000 }).catch(() => {});
      await randomDelay(800, 1_800);
    }

    // === Cliquer le bouton de confirmation final ===
    // CEV : bouton submit Bootstrap, probablement btn-primary ou btn-success.
    // SharedAjaxService.appointmentCancelRequest prouve qu'il y a un bouton #btnConfirm.
    const confirmCandidates = [
      '#btnConfirm',
      '.btnConfirm',
      'button[type="submit"].btn-primary',
      'button[type="submit"].btn-success',
      'input[type="submit"].btn-primary',
      'input[type="submit"].btn-success',
      'button[type="submit"]:has-text("Confirm")',
      'button[type="submit"]:has-text("Confirmer")',
      'button[type="submit"]:has-text("Réserver")',
      'button[type="submit"]:has-text("Book")',
      'input[type="submit"]',
      'button[type="submit"]',
    ];

    for (const sel of confirmCandidates) {
      const btn = await page.$(sel);
      if (btn) {
        await humanClick(page, sel);
        botLog({ applicationId: config.clientId, step: 'cev_confirm_clicked', status: 'ok', data: { selector: sel } });
        break;
      }
    }

    await (page as any).waitForNavigation?.({ waitUntil: 'networkidle0', timeout: 20_000 }).catch(() => {});

    // === Screenshot de confirmation ===
    const screenshotBuf2 = await page.screenshot({ fullPage: true }).catch(() => null);
    const screenshotB64 = screenshotBuf2 ? Buffer.from(screenshotBuf2).toString('base64') : null;
    const screenshotStorageId = (screenshotB64 ? await uploadScreenshot(screenshotB64) : null) ?? undefined;

    // === Extraire le code de confirmation ===
    const confirmationCode = await extractConfirmationCode(page);
    const finalUrl = page.url();

    const success = !finalUrl.includes('Error') && !finalUrl.includes('SessionExpired');

    botLog({
      applicationId: config.clientId,
      step: success ? 'cev_booking_confirmed' : 'cev_booking_uncertain',
      status: success ? 'ok' : 'warn',
      data: { finalUrl, confirmationCode: confirmationCode ?? '', date: bookedDate, time: bookedTime, capturedCallsCount: capturedCalls.length },
    });

    // ── Dump complet de tous les appels CEV capturés pendant la session ──────
    // Enregistré en Convex pour analyse offline — permet de reconstruire
    // le flux HTTP complet sans relancer Playwright.
    _dumpCapturedCalls(config.clientId, capturedCalls);

    return {
      success,
      confirmationCode: confirmationCode ?? undefined,
      bookedDate,
      bookedTime,
      screenshotStorageId,
    };

  } catch (err) {
    const screenshotBuf3 = await page.screenshot().catch(() => null);
    const screenshotStorageId3 = screenshotBuf3 ? await uploadScreenshot(Buffer.from(screenshotBuf3).toString('base64')) : undefined;
    const screenshotStorageId = screenshotStorageId3 ?? undefined;
    // Dump même en cas d'erreur — les appels déjà capturés sont précieux
    _dumpCapturedCalls(config.clientId, capturedCalls);
    botLog({ applicationId: config.clientId, step: 'cev_booking_ui_error', status: 'fail', data: { error: String(err) } });
    return { success: false, error: String(err), screenshotStorageId };
  }
}

/**
 * Envoie un dump de tous les appels réseau CEV capturés vers Convex (fire-and-forget).
 * Chaque appel est loggé séparément pour éviter de dépasser la limite de taille des logs.
 * Focus sur les appels avec un corps JSON (requête ou réponse) pour le reverse engineering.
 */
function _dumpCapturedCalls(clientId: string, calls: CapturedNetworkCall[]): void {
  if (calls.length === 0) return;

  // Log de synthèse : liste de toutes les URLs capturées
  botLog({
    applicationId: clientId,
    step: 'cev_network_calls_summary',
    status: 'ok',
    data: {
      totalCalls: calls.length,
      urls: calls.map(c => `${c.method} ${c.url.replace('https://appointment.cloud.diplomatie.be', '')} → ${c.responseStatus ?? '?'}`),
    },
  });

  // Log détaillé : un entry par appel avec corps req/res (limités à 1500 chars chacun)
  calls.forEach((c, idx) => {
    const path = c.url.replace('https://appointment.cloud.diplomatie.be', '');
    // Ne loguer en détail que les appels avec du contenu exploitable
    const hasBody = !!c.requestBody || !!c.responseBody;
    if (!hasBody) return;
    botLog({
      applicationId: clientId,
      step: 'cev_network_call_detail',
      status: 'ok',
      data: {
        idx,
        method:      c.method,
        path,
        reqBody:     c.requestBody?.slice(0, 1500) ?? null,
        resStatus:   c.responseStatus ?? null,
        resBody:     c.responseBody?.slice(0, 1500) ?? null,
        resType:     (() => {
          try { const p = JSON.parse(c.responseBody ?? 'null'); return Array.isArray(p) ? 'array' : typeof p; } catch { return 'non-json'; }
        })(),
        resKeys:     (() => {
          try { const p = JSON.parse(c.responseBody ?? 'null'); return (p && typeof p === 'object' && !Array.isArray(p)) ? Object.keys(p) : null; } catch { return null; }
        })(),
      },
    });
  });
}

/**
 * Extrait le code de confirmation depuis la page finale.
 * Cherche des patterns communs : numéro de référence, code, ID.
 */
async function extractConfirmationCode(page: Page): Promise<string | null> {
  const patterns = [
    '[id*="confirm"] strong',
    '[class*="confirm"] strong',
    '[class*="reference"]',
    '[class*="booking-id"]',
    '#confirmationCode',
    '.confirmation-number',
    'strong:has-text("Reference")',
    'strong:has-text("Référence")',
    'strong:has-text("Confirmation")',
  ];

  for (const sel of patterns) {
    try {
      const el = await page.$(sel);
      if (el) {
        const text = await (el as any).evaluate((e: any) => e.innerText ?? '').catch(() => '');
        if (text && text.trim().length > 0) return text.trim();
      }
    } catch { /* continue */ }
  }

  // Fallback : cherche un pattern alphanumérique dans le body (code RDV belge)
  const bodyText = await page.$eval('body', (el: any) => el.innerText).catch(() => '');
  const match = bodyText.match(/\b([A-Z]{2,4}[-\s]?\d{4,10})\b/);
  return match ? match[1] : null;
}

/**
 * Bypass hCaptcha via le mode accessibilité officiel de hCaptcha.
 * Requiert le cookie hc_accessibility injecté dans le context browser avant navigation.
 * Gratuit, pas de service tiers — hCaptcha auto-résout visuellement en ~5-10s.
 *
 * Activation : créer un compte sur accounts.hcaptcha.com, activer "Always pass
 * accessibility mode", copier la valeur du cookie hc_accessibility et la placer
 * dans HCAPTCHA_ACCESSIBILITY_COOKIE.
 */
async function solveHcaptchaViaAccessibility(cevPage: Page, clientId: string): Promise<string | null> {
  botLog({ applicationId: clientId, step: 'cev_hcaptcha_accessibility_start', status: 'ok' });
  try {
    // Attendre max 30s que hCaptcha auto-remplisse le champ caché
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5_000));

      const token = await cevPage.evaluate(() => {
        const textarea = document.querySelector('textarea[name="h-captcha-response"]') as HTMLTextAreaElement | null;
        const input = document.querySelector('input[name="h-captcha-response"]') as HTMLInputElement | null;
        return (textarea?.value || input?.value) ?? null;
      });

      if (token && token.length > 20) {
        botLog({ applicationId: clientId, step: 'cev_hcaptcha_accessibility_solved', status: 'ok', data: { attempts: i + 1, tokenLen: token.length } });
        return token;
      }

      botLog({ applicationId: clientId, step: 'cev_hcaptcha_accessibility_waiting', status: 'ok', data: { elapsed: (i + 1) * 5 } });
    }

    botLog({ applicationId: clientId, step: 'cev_hcaptcha_accessibility_timeout', status: 'warn', data: { hint: 'Cookie hc_accessibility peut être expiré — vérifier accounts.hcaptcha.com' } });
    return null;
  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_accessibility_exception', status: 'fail', data: { error: String(err) } });
    return null;
  }
}

/**
 * Résout un hCaptcha pour appointment.cloud.diplomatie.be via services externes.
 *
 * Ordre de priorité :
 *  1. NoneCap       (NONECAP_API_KEY)      — prioritaire pour sitekey CEV
 *  2. Anti-Captcha (ANTICAPTCHA_API_KEY) — supporte les domaines gouvernementaux
 *  3. CapSolver    (CAPSOLVER_API_KEY)    — note: sitekey CEV blacklistée en 2026-04
 *  4. 2captcha     (twoCaptchaApiKey)     — note: compte actuel ne supporte pas hCaptcha
 *
 * Priorité absolue (avant cette fonction) : solveHcaptchaViaAccessibility() si
 * HCAPTCHA_ACCESSIBILITY_COOKIE est configuré.
 */
async function solveHcaptcha(
  twoCaptchaApiKey: string,
  clientId: string,
  capsolverApiKey?: string,
): Promise<string | null> {
  const HCAPTCHA_SITE_KEY = '5f64399c-14a8-415e-ad1a-7ebccdc4943a'; // site key CEV — confirmée 2026-04
  const PAGE_URL = `${CEV_BASE}/Captcha`;

  botLog({ applicationId: clientId, step: 'cev_hcaptcha_solve_start', status: 'ok' });

  // ─── Ordre priorité CEV : NoneCap → 2Captcha → Anti-Captcha (dernier recours) ──

  // Tentative 1 : NoneCap (prioritaire)
  const nonecapKey = await resolveNonecapKey();
  if (nonecapKey) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_nonecap_start', status: 'ok' });
    const { solveHcaptchaViaNonecap } = await import('./nonecap.js');
    const token = await solveHcaptchaViaNonecap(nonecapKey, HCAPTCHA_SITE_KEY, PAGE_URL, '[cevBooking]');
    if (token) return token;
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_nonecap_fail_fallback', status: 'warn', data: { hint: 'NoneCap échoué — fallback 2Captcha' } });
  }

  // Tentative 2 : 2Captcha
  const twoKey = await resolveTwocaptchaKey();
  const twoKey2 = twoKey || twoCaptchaApiKey; // fallback sur le paramètre passé à la fonction
  if (twoKey2) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_2captcha_start', status: 'ok' });
    const token = await solveHcaptchaVia2captcha(twoKey2, HCAPTCHA_SITE_KEY, PAGE_URL, clientId);
    if (token) return token;
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_2captcha_fail_fallback', status: 'warn', data: { hint: '2Captcha échoué — fallback Anti-Captcha' } });
  }

  // Tentative 3 : Anti-Captcha (dernier recours)
  const antiKey = await resolveAnticaptchaKey();
  if (antiKey) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_anticaptcha_start', status: 'ok' });
    const token = await solveHcaptchaViaAntiCaptcha(antiKey, HCAPTCHA_SITE_KEY, PAGE_URL, clientId);
    if (token) return token;
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_anticaptcha_fail_fallback', status: 'warn' });
  }

  botLog({ applicationId: clientId, step: 'cev_hcaptcha_all_failed', status: 'fail', data: { hint: 'Tous les solveurs hCaptcha ont échoué (NoneCap → 2Captcha → Anti-Captcha). Vérifier solde et clés API.' } });
  return null;
}

/**
 * Résolution hCaptcha via Anti-Captcha (https://anti-captcha.com).
 * API identique à CapSolver. Supporte les domaines gouvernementaux.
 * ~30-60s pour une résolution. Coût ~0.002 $ par résolution.
 */
async function solveHcaptchaViaAntiCaptcha(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  clientId: string,
): Promise<string | null> {
  try {
    const createRes = await fetch('https://api.anti-captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'HCaptchaTaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
    });

    const createData = await createRes.json() as { errorId: number; errorCode?: string; taskId?: number };
    if (createData.errorId !== 0 || !createData.taskId) {
      botLog({ applicationId: clientId, step: 'cev_anticaptcha_create_fail', status: 'fail', data: { error: createData.errorCode ?? createData.errorId } });
      return null;
    }

    const taskId = createData.taskId;
    botLog({ applicationId: clientId, step: 'cev_anticaptcha_task_created', status: 'ok', data: { taskId } });

    // Poller jusqu'à résolution (max 120s, intervalle 5s)
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5_000));

      const pollRes = await fetch('https://api.anti-captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });

      const pollData = await pollRes.json() as {
        errorId: number;
        status: 'processing' | 'ready';
        solution?: { gRecaptchaResponse?: string };
        errorCode?: string;
      };

      if (pollData.errorId !== 0) {
        botLog({ applicationId: clientId, step: 'cev_anticaptcha_poll_fail', status: 'fail', data: { error: pollData.errorCode ?? pollData.errorId } });
        return null;
      }

      if (pollData.status === 'ready' && pollData.solution?.gRecaptchaResponse) {
        botLog({ applicationId: clientId, step: 'cev_anticaptcha_solved', status: 'ok', data: { attempts: i + 1, tokenLen: pollData.solution.gRecaptchaResponse.length } });
        return pollData.solution.gRecaptchaResponse;
      }
    }

    botLog({ applicationId: clientId, step: 'cev_anticaptcha_timeout', status: 'fail' });
    return null;

  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_anticaptcha_exception', status: 'fail', data: { error: String(err) } });
    return null;
  }
}

/**
 * Résolution hCaptcha via CapSolver (https://capsolver.com).
 *
 * Variantes testées dans l'ordre (leçons apprises 2025-2026) :
 *   1. HCaptchaTaskProxyLess + isEnterprise:true  SANS userAgent  ← le plus fiable CapSolver 2025+
 *   2. HCaptchaTaskProxyLess SANS isEnterprise, SANS userAgent    ← fallback minimaliste
 *   3. HCaptchaTaskProxyLess + isEnterprise:true  AVEC userAgent  ← certains workers l'acceptent
 *
 * Chaque variant est retenté MAX_RETRIES fois avant de passer au suivant.
 * ERROR_INVALID_TASK_DATA = CapSolver rejette le format (souvent transitoire) → retry aide.
 * HCaptchaEnterpriseTaskProxyLess SUPPRIMÉ : déprécié, toujours ERROR_INVALID_TASK_DATA.
 */
async function solveHcaptchaViaCapsolver(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  clientId: string,
): Promise<string | null> {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
  const MAX_RETRIES = 3; // tentatives par variant avant de passer au suivant

  const taskVariants: Array<{ label: string; task: Record<string, unknown> }> = [
    {
      // Variant 1 : méthode principale 2025+ — SANS userAgent (cause principale ERROR_INVALID_TASK_DATA)
      label: 'HCaptchaTaskProxyLess+isEnterprise+noUA',
      task: {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        isEnterprise: true,
      },
    },
    {
      // Variant 2 : payload minimal — aucun champ optionnel
      label: 'HCaptchaTaskProxyLess+minimal',
      task: {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey,
      },
    },
    {
      // Variant 3 : avec userAgent — certains workers CapSolver l'acceptent encore
      label: 'HCaptchaTaskProxyLess+isEnterprise+UA',
      task: {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        isEnterprise: true,
        userAgent: ua,
      },
    },
  ];

  for (const variant of taskVariants) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        botLog({ applicationId: clientId, step: 'cev_capsolver_try_type', status: 'ok', data: { taskType: variant.label, attempt, maxRetries: MAX_RETRIES } });

        const createRes = await fetch('https://api.capsolver.com/createTask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, task: variant.task }),
        });

        const createData = await createRes.json() as { errorId: number; errorCode?: string; errorDescription?: string; taskId?: number };

        if (createData.errorId !== 0 || !createData.taskId) {
          const isTransient = createData.errorCode === 'ERROR_INVALID_TASK_DATA';
          botLog({
            applicationId: clientId,
            step: 'cev_capsolver_create_fail',
            status: 'fail',
            data: {
              taskType: variant.label,
              attempt,
              error: createData.errorCode ?? createData.errorId,
              description: createData.errorDescription ?? null,
              willRetry: isTransient && attempt < MAX_RETRIES,
            },
          });
          if (isTransient && attempt < MAX_RETRIES) {
            // Délai progressif avant retry : 3s, 5s
            await new Promise(r => setTimeout(r, attempt === 1 ? 3_000 : 5_000));
            continue;
          }
          break; // erreur non-transiente ou retries épuisés → variant suivant
        }

        const taskId = createData.taskId;
        botLog({ applicationId: clientId, step: 'cev_capsolver_task_created', status: 'ok', data: { taskType: variant.label, attempt, taskId } });

        // Poller jusqu'à résolution (max 120s, intervalle 5s)
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 5_000));

          const pollRes = await fetch('https://api.capsolver.com/getTaskResult', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: apiKey, taskId }),
          });

          const pollData = await pollRes.json() as {
            errorId: number;
            status: 'idle' | 'processing' | 'ready' | 'failed';
            solution?: { gRecaptchaResponse?: string };
            errorCode?: string;
          };

          if (pollData.errorId !== 0 || pollData.status === 'failed') {
            botLog({ applicationId: clientId, step: 'cev_capsolver_poll_fail', status: 'fail', data: { taskType: variant.label, attempt, error: pollData.errorCode ?? pollData.status } });
            break;
          }

          if (pollData.status === 'ready' && pollData.solution?.gRecaptchaResponse) {
            botLog({ applicationId: clientId, step: 'cev_capsolver_solved', status: 'ok', data: { taskType: variant.label, attempt, totalPolls: i + 1, tokenLen: pollData.solution.gRecaptchaResponse.length } });
            return pollData.solution.gRecaptchaResponse;
          }
        }

        botLog({ applicationId: clientId, step: 'cev_capsolver_timeout', status: 'fail', data: { taskType: variant.label, attempt } });
        break; // timeout → pas la peine de retenter ce variant, passer au suivant

      } catch (err) {
        botLog({ applicationId: clientId, step: 'cev_capsolver_exception', status: 'fail', data: { taskType: variant.label, attempt, error: String(err) } });
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 3_000));
      }
    }
  }

  botLog({ applicationId: clientId, step: 'cev_capsolver_all_types_failed', status: 'fail', data: { hint: 'Toutes variantes CapSolver épuisées (3× chacune). Vérifier solde CapSolver ou ajouter ANTICAPTCHA_API_KEY (anti-captcha.com) pour résolution gouvernementale fiable.' } });
  return null;
}

/**
 * Résolution hCaptcha via 2captcha (fallback).
 * Note : HCaptchaTaskProxyless peut ne pas être disponible sur tous les comptes.
 */
async function solveHcaptchaVia2captcha(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  clientId: string,
): Promise<string | null> {
  try {
    // Essai 1 : nouvelle API JSON (v2)
    const createRes = await fetch('https://api.2captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'HCaptchaTaskProxyless',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
    });
    const createData = await createRes.json() as { errorId: number; errorCode?: string; taskId?: number };

    if (createData.errorId !== 0 || !createData.taskId) {
      // Essai 2 : ancienne API form-encoded
      const submitRes = await fetch('http://2captcha.com/in.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key: apiKey, method: 'hcaptcha', sitekey: siteKey, pageurl: pageUrl, json: '1' }).toString(),
      });
      const submitData = await submitRes.json() as { status: number; request: string };
      if (submitData.status !== 1) {
        botLog({ applicationId: clientId, step: 'cev_2captcha_submit_fail', status: 'fail', data: { response: submitData.request } });
        return null;
      }
      // Poller via ancienne API
      const captchaId = submitData.request;
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5_000));
        const pollRes = await fetch(`http://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`);
        const pollData = await pollRes.json() as { status: number; request: string };
        if (pollData.status === 1) {
          botLog({ applicationId: clientId, step: 'cev_2captcha_solved_v1', status: 'ok', data: { attempts: i + 1 } });
          return pollData.request;
        }
        if (pollData.request !== 'CAPCHA_NOT_READY') {
          botLog({ applicationId: clientId, step: 'cev_2captcha_poll_fail', status: 'fail', data: { response: pollData.request } });
          return null;
        }
      }
      return null;
    }

    const taskId = createData.taskId;
    // Poller via nouvelle API
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const pollRes = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const pollData = await pollRes.json() as { errorId: number; status: string; solution?: { gRecaptchaResponse?: string } };
      if (pollData.errorId !== 0) {
        botLog({ applicationId: clientId, step: 'cev_2captcha_poll_fail_v2', status: 'fail', data: { errorId: pollData.errorId } });
        return null;
      }
      if (pollData.status === 'ready' && pollData.solution?.gRecaptchaResponse) {
        botLog({ applicationId: clientId, step: 'cev_2captcha_solved_v2', status: 'ok', data: { attempts: i + 1 } });
        return pollData.solution.gRecaptchaResponse;
      }
    }

    botLog({ applicationId: clientId, step: 'cev_2captcha_timeout', status: 'fail' });
    return null;

  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_2captcha_exception', status: 'fail', data: { error: String(err) } });
    return null;
  }
}

/**
 * Phase 1 du cycle CEV : établit une session VOWINT + résout hCaptcha via SetCaptchaToken.
 * Ne fait PAS le booking — retourne uniquement la CevSession pour le polling ultérieur.
 *
 * Avantage clé : un seul clic VOWINT par fenêtre de session (~30-60 min), puis polling
 * HTTP pur sans Playwright pendant toute la durée de vie du cookie.
 *
 * Retourne :
 *  - {session, hasSlots: true}  → créneaux immédiatement disponibles (redirectUrl != NoAvailability)
 *  - {session, hasSlots: false} → aucun créneau mais session active → poller
 *  - null                       → échec (VOWINT login, hCaptcha, réseau)
 */
async function establishCevSessionOnly(
  config: CevBookingConfig,
): Promise<{ session: CevSession; hasSlots: boolean } | null> {
  let browser = null;
  botLog({ applicationId: config.clientId, step: 'cev_session_only_start', status: 'ok' });

  try {
    // ── Lancement stealth : iProyal (BrightData blackliste diplomatie.be), StealthPlugin, UA rotation ──
    const launched = await launchBrowser({ locale: 'fr-BE', timezoneId: 'Africa/Kinshasa', proxySource: 'iproyal' });
    browser = launched.browser;
    const context = launched.context;
    const page = launched.page;

    const accessibilityCookie = process.env.HCAPTCHA_ACCESSIBILITY_COOKIE?.trim();
    if (accessibilityCookie) {
      await context.addCookies([{
        name: 'hc_accessibility',
        value: accessibilityCookie,
        domain: '.hcaptcha.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'None',
      }]);
    }

    // Capture réseau complète : VOWINT + CEV
    const netCapture = attachNetCapture(context, config.clientId);

    const cevSession = await establishCevSession(page, context, config, []);

    if (!cevSession) {
      netCapture.dump();
      await browser.close();
      return null;
    }

    // Résoudre hCaptcha
    let hcaptchaToken: string | null = null;
    if (accessibilityCookie && cevSession.cevPage) {
      hcaptchaToken = await solveHcaptchaViaAccessibility(cevSession.cevPage, config.clientId);
    }
    if (!hcaptchaToken) {
      hcaptchaToken = await solveHcaptcha(config.twoCaptchaApiKey, config.clientId, config.capsolverApiKey);
    }
    if (!hcaptchaToken) {
      netCapture.dump();
      await browser.close();
      botLog({ applicationId: config.clientId, step: 'cev_session_only_hcaptcha_fail', status: 'fail' });
      return null;
    }

    // SetCaptchaToken → obtenir session + disponibilité immédiate
    const captchaResult = await completeCevCaptcha(cevSession.cookies, hcaptchaToken, config.clientId);
    netCapture.dump();
    await browser.close();

    if (captchaResult.status === 'session_error') {
      botLog({ applicationId: config.clientId, step: 'cev_session_only_captcha_error', status: 'fail', data: { error: captchaResult.error } });
      return null;
    }

    // no_availability → session active mais aucun créneau actuellement
    // ready           → créneaux disponibles immédiatement
    return {
      session: captchaResult.session,
      hasSlots: captchaResult.status === 'ready',
    };

  } catch (err) {
    botLog({ applicationId: config.clientId, step: 'cev_session_only_crash', status: 'fail', data: { error: String(err) } });
    try { if (browser) await (browser as { close(): Promise<void> }).close(); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Boucle de polling CEV — à appeler depuis le bot principal.
 *
 * Architecture deux phases :
 *
 * Phase 1 — VOWINT click (consomme 1 clic/18 max par heure) :
 *   establishCevSessionOnly() → cookie + validUntil + redirectUrl
 *   → persister en Convex (survie aux crashs/redémarrages Railway)
 *   → si hasSlots immédiat → runCevBookingSession() (booking UI Playwright)
 *
 * Phase 2 — Polling HTTP pur (0 clic VOWINT, 0 captcha) :
 *   pollCevSlotsMultiMonth() toutes les 30s pendant ~30-60 min
 *   → si créneaux → runCevBookingSession()
 *   → si SESSION_EXPIRED → retour en Phase 1
 *
 * Au démarrage : restoreCevLoopSession() tente de récupérer la session
 *   persistée en Convex → skip Phase 1 si le cookie est encore valide.
 */
export async function cevPollingLoop(
  config: CevBookingConfig,
  onSlotsFound: (result: BookingResult) => Promise<void>
): Promise<void> {
  const clickTimestamps: number[] = [];
  let activeSession: CevSession | null = null;

  botLog({ applicationId: config.clientId, step: 'cev_poll_loop_start', status: 'ok' });

  // ─── Restauration au démarrage ────────────────────────────────────────────
  // Si une session valide est déjà persistée en Convex (bot redémarré pendant
  // une session active), on la réutilise directement sans consommer un clic VOWINT.
  try {
    const restored = await restoreCevLoopSession(config.clientId);
    if (restored && isCevSessionValid(restored)) {
      activeSession = restored;
      botLog({
        applicationId: config.clientId,
        step: 'cev_poll_session_restored',
        status: 'ok',
        data: { validUntil: restored.validUntil },
      });
    } else if (restored) {
      botLog({ applicationId: config.clientId, step: 'cev_poll_session_restored_expired', status: 'warn', data: { validUntil: restored.validUntil } });
    }
  } catch (err) {
    botLog({ applicationId: config.clientId, step: 'cev_poll_restore_error', status: 'warn', data: { error: String(err) } });
  }

  while (true) {
    const now = Date.now();

    // ─── Phase 2 : session active → poll multi-mois sans recliquer ───────
    if (activeSession && isCevSessionValid(activeSession)) {
      const pollResult = await pollCevSlotsMultiMonth(activeSession, config.clientId);

      if (pollResult.error === 'SESSION_EXPIRED') {
        botLog({ applicationId: config.clientId, step: 'cev_poll_session_expired_in_loop', status: 'warn' });
        activeSession = null;
        continue;
      }

      if (pollResult.hasSlots) {
        botLog({ applicationId: config.clientId, step: 'cev_poll_slots_found', status: 'ok' });
        const bookingResult = await runCevBookingSession(config);
        await onSlotsFound(bookingResult);
        return;
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // Session absente ou expirée → passer en Phase 1
    activeSession = null;

    // ─── Phase 1 : vérifier la limite de clics avant d'ouvrir VOWINT ─────
    const recentClicks = clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
    if (recentClicks.length >= MAX_CLICKS_PER_HOUR) {
      const oldestClick = Math.min(...recentClicks);
      const waitMs = CLICK_WINDOW_MS - (now - oldestClick) + 5_000;
      botLog({ applicationId: config.clientId, step: 'cev_rate_limit_wait', status: 'warn', data: { waitMs, clicksInWindow: recentClicks.length } });
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // ─── Phase 1 : établir une nouvelle session via VOWINT + hCaptcha ─────
    clickTimestamps.push(now);
    botLog({ applicationId: config.clientId, step: 'cev_vowint_click', status: 'ok', data: { clicksInWindow: recentClicks.length + 1 } });

    const sessionResult = await establishCevSessionOnly(config);

    if (!sessionResult) {
      botLog({ applicationId: config.clientId, step: 'cev_session_establish_failed', status: 'fail' });
      await new Promise(r => setTimeout(r, 10_000));
      continue;
    }

    activeSession = sessionResult.session;

    // Persister en Convex (fire-and-forget) → survie aux crashs/redémarrages
    persistCevLoopSession(config.clientId, activeSession);

    // Créneaux immédiatement disponibles → booking Playwright complet
    if (sessionResult.hasSlots) {
      botLog({ applicationId: config.clientId, step: 'cev_session_slots_immediate', status: 'ok' });
      const bookingResult = await runCevBookingSession(config);
      await onSlotsFound(bookingResult);
      return;
    }

    // Pas de créneaux → conserver la session et démarrer le polling (Phase 2)
    botLog({ applicationId: config.clientId, step: 'cev_session_ready_polling', status: 'ok', data: { validUntil: activeSession.validUntil } });
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ─── Adaptateur single-shot pour le main loop du bot ───────────────────────
// Effectue un seul cycle VOWINT + hCaptcha pour le job Schengen donné.
// La limite de 5 clics/heure (serveur, marge 1 → 4) est gérée côté main loop
// via un intervalle minimum de ~900s (3600s / 4) entre chaque clic par AppId.
const CEV_HCAPTCHA_SITEKEY = '5f64399c-14a8-415e-ad1a-7ebccdc4943a';

export type SchengenSessionResult = 'slot_found' | 'not_found' | 'rate_limited' | 'error';

export async function runCevCheck(job: HunterJob): Promise<SchengenSessionResult> {
  const hc = job.hunterConfig;
  const twoCaptchaApiKey = hc.twoCaptchaApiKey ?? process.env.TWOCAPTCHA_API_KEY ?? '';

  if (!twoCaptchaApiKey) {
    botLog({ applicationId: job.id, step: 'cev_check_no_captcha_key', status: 'warn', data: { note: '2captcha key absent — check ignoré' } });
    return 'error';
  }

  // Vérifier la limite de clics: max 4 clics/heure par application (serveur: 5/h, marge 1)
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000;
  const windowStart = hc.cevClickWindowStart ?? 0;
  
  // Réinitialiser le compteur si la fenêtre est expirée (> 1h)
  const clickCount = (now - windowStart >= WINDOW_MS) ? 0 : (hc.cevClickCount ?? 0);

  if (clickCount >= MAX_CLICKS_PER_HOUR) {
    const waitRemaining = WINDOW_MS - (now - windowStart);
    botLog({ applicationId: job.id, step: 'cev_rate_limit', status: 'warn', data: { clickCount, waitRemaining } });
    return 'rate_limited';
  }

  botLog({ applicationId: job.id, step: 'cev_check_start', status: 'ok', data: { clickCount: clickCount + 1 } });

  // Si vowintAppId est une URL complète (ex: https://visaonweb.diplomatie.be/Application/Detail/12345),
  // l'utiliser directement. Sinon on démarre depuis la racine VOWINT et on browse le dashboard.
  const vowintAppointmentUrl = hc.vowintAppId?.startsWith('https://')
    ? hc.vowintAppId
    : 'https://visaonweb.diplomatie.be';

  const capsolverApiKey = hc.capsolverApiKey ?? process.env.CAPSOLVER_API_KEY ?? '';

  let result: BookingResult;
  try {
    result = await runCevBookingSession({
      clientId: job.id,
      vowintUsername: hc.embassyUsername,
      vowintPassword: hc.embassyPassword,
      vowintAppointmentUrl,
      twoCaptchaApiKey,
      capsolverApiKey: capsolverApiKey || undefined,
      hcaptchaSiteKey: CEV_HCAPTCHA_SITEKEY,
    });
  } catch (err) {
    botLog({ applicationId: job.id, step: 'cev_check_exception', status: 'fail', data: { error: String(err) } });
    return 'error';
  }

  // Tracker le clic CEV si la session a été établie (bouton calendrier cliqué)
  // CEV_SESSION_FAILED = aucun clic, pas de comptage
  if (result.error !== 'CEV_SESSION_FAILED') {
    const newCount = clickCount + 1;
    const newWindowStart = (clickCount === 0 || now - windowStart >= WINDOW_MS) ? now : windowStart;
    recordCevClick({ applicationId: job.id, windowStart: newWindowStart, clickCount: newCount });
  }

  if (result.success) {
    botLog({ applicationId: job.id, step: 'cev_slot_captured', status: 'ok', data: { confirmationCode: result.confirmationCode, date: result.bookedDate, time: result.bookedTime } });
    return 'slot_found';
  }

  if (result.error === 'NO_AVAILABILITY') {
    botLog({ applicationId: job.id, step: 'cev_no_availability', status: 'ok' });
    return 'not_found';
  }

  botLog({ applicationId: job.id, step: 'cev_check_error', status: 'warn', data: { error: result.error } });
  return 'error';
}

// ─── Direct URL session setup (pas de VOWINT — URL Integration/VOW directe) ──

export interface CevDirectSetupResult {
  success: boolean;
  sessionCookie?: string;
  validUntilMs?: number;
  error?: string;
}

/**
 * Établit une session CEV à partir d'une URL directe Integration/VOW sans passer
 * par VOWINT. Utilisé quand le client fournit son lien direct appointment.cloud.
 *
 * Flux :
 *  1. Playwright navigue vers l'URL VOW → redirect vers /Captcha
 *  2. /Captcha pose le cookie ASP.NET_SessionId dans le jar navigateur
 *  3. Résout hCaptcha (accessibility cookie → Anti-Captcha → CapSolver → 2captcha)
 *  4. POST /Captcha/SetCaptchaToken → obtient { validUntil, redirectUrl }
 *  5. Retourne le cookie et la validité pour stockage dans Convex
 *
 * Le cookie est valide ~30-60 min. Le bot re-lance ce setup automatiquement
 * quand la session expire (status: "expired" → "needs_setup" via admin UI).
 */
/**
 * Mode credentials VOWINT (nouveau, recommandé) :
 *   Le bot se connecte à VOWINT → clique RDV → capture session CEV → résout hCaptcha → stocke.
 *   L'URL d'intégration est découverte automatiquement ; les credentials sont réutilisables.
 *
 * Mode URL directe (legacy, compatibilité) :
 *   Navigue vers l'URL fournie → extrait le cookie → résout hCaptcha → stocke.
 */
export async function runCevDirectSessionSetup(
  credentialsOrUrl: { vowintEmail: string; vowintPassword: string; vowintAppUrl?: string } | string,
  sessionId: string,
  clientId: string,
): Promise<CevDirectSetupResult> {
  const isCredMode = typeof credentialsOrUrl !== 'string';
  botLog({
    applicationId: clientId,
    step: 'cev_direct_setup_start',
    status: 'ok',
    data: { mode: isCredMode ? 'vowint-credentials' : 'url-direct' },
  });

  // Retry loop : tentative 1 avec proxy (si PROXY_URL configuré), tentative 2 sans proxy
  // si ERR_PROXY_CONNECTION_FAILED (proxy Railway mort ou inaccessible depuis la session en cours).
  for (const forceNoProxy of [false, true]) {
  let browser = null;
  try {
    // ── Lancement stealth : iProyal (BrightData blackliste visaonweb.diplomatie.be), StealthPlugin, UA rotation ──
    const launched = await launchBrowser({ locale: 'fr-BE', timezoneId: 'Africa/Kinshasa', proxySource: 'iproyal', forceNoProxy });
    browser = launched.browser;
    const context = launched.context;
    const page = launched.page;

    // Injecter le cookie d'accessibilité hCaptcha si configuré (bypass gratuit)
    const accessibilityCookie = process.env.HCAPTCHA_ACCESSIBILITY_COOKIE?.trim();
    if (accessibilityCookie) {
      await context.addCookies([{
        name: 'hc_accessibility',
        value: accessibilityCookie,
        domain: '.hcaptcha.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'None',
      }]);
      botLog({ applicationId: clientId, step: 'cev_direct_accessibility_cookie_injected', status: 'ok' });
    }

    // Capture réseau complète : VOWINT + CEV
    const netCapture = attachNetCapture(context, clientId);

    let cookieString: string;
    let captchaPage: Page;
    let discoveredIntegrationUrl: string | undefined;

    if (isCredMode) {
      // ── Mode credentials VOWINT : login → RDV click → session CEV ──────────
      const creds = credentialsOrUrl as { vowintEmail: string; vowintPassword: string; vowintAppUrl?: string };
      const config: CevBookingConfig = {
        clientId,
        vowintUsername: creds.vowintEmail,
        vowintPassword: creds.vowintPassword,
        vowintAppointmentUrl: creds.vowintAppUrl ?? 'https://visaonweb.diplomatie.be',
        twoCaptchaApiKey: process.env.TWOCAPTCHA_API_KEY ?? '',
        capsolverApiKey: process.env.CAPSOLVER_API_KEY,
      };

      const cevSession = await establishCevSession(page, context, config, []);
      if (!cevSession) {
        netCapture.dump();
        await browser.close();
        return { success: false, error: 'CEV_VOWINT_SESSION_FAILED' };
      }

      cookieString = cevSession.cookies;
      captchaPage = cevSession.cevPage;
      discoveredIntegrationUrl = cevSession.integrationUrl ?? undefined;

    } else {
      // ── Mode URL directe (legacy) : naviguer → extraire cookie ──────────────
      const integrationUrl = credentialsOrUrl as string;
      await page.goto(integrationUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await randomDelay(1_500, 2_500); // laisser les cookies s'établir

      const currentUrl = page.url();
      botLog({ applicationId: clientId, step: 'cev_direct_navigation_done', status: 'ok', data: { currentUrl } });

      const allCookies = await context.cookies();
      const cevCookies = allCookies.filter(c => (c.domain ?? '').includes('appointment.cloud.diplomatie.be'));

      if (cevCookies.length === 0) {
        botLog({ applicationId: clientId, step: 'cev_direct_no_cookie', status: 'fail', data: { currentUrl } });
        netCapture.dump();
        await browser.close();
        return { success: false, error: 'NO_SESSION_COOKIE_AFTER_NAVIGATION' };
      }

      cookieString = cevCookies.map(c => `${c.name}=${c.value}`).join('; ');
      captchaPage = page;
      botLog({
        applicationId: clientId,
        step: 'cev_direct_cookie_captured',
        status: 'ok',
        data: { names: cevCookies.map(c => c.name).join(', ') },
      });
    }

    // === ÉTAPE 2 : Résoudre hCaptcha ===
    let hcaptchaToken: string | null = null;

    if (accessibilityCookie) {
      hcaptchaToken = await solveHcaptchaViaAccessibility(captchaPage, clientId);
    }
    if (!hcaptchaToken) {
      hcaptchaToken = await solveHcaptcha(
        process.env.TWOCAPTCHA_API_KEY ?? '',
        clientId,
        process.env.CAPSOLVER_API_KEY,
      );
    }

    if (!hcaptchaToken) {
      netCapture.dump();
      await browser.close();
      botLog({ applicationId: clientId, step: 'cev_direct_captcha_failed', status: 'fail' });
      return { success: false, error: 'HCAPTCHA_FAILED' };
    }

    // === ÉTAPE 3 : POST SetCaptchaToken avec le cookie de session ===
    const captchaResult = await completeCevCaptcha(cookieString, hcaptchaToken, clientId);

    if (captchaResult.status === 'session_error') {
      netCapture.dump();
      await browser.close();
      return { success: false, error: captchaResult.error };
    }

    // === ÉTAPE 3b : Créneaux disponibles → tenter la réservation immédiate ===
    // Le captchaResult contient un redirectUrl vers la page de sélection de créneaux.
    // Si ce redirectUrl n'est PAS une page "NoAvailability", des créneaux existent MAINTENANT.
    // On utilise le même browser context (session déjà valide) pour naviguer et tenter la réservation.
    const immediateRedirectUrl = captchaResult.status === 'ready' ? captchaResult.session.redirectUrl : undefined;
    const slotsAvailableNow = immediateRedirectUrl && !immediateRedirectUrl.includes('NoAvailability');

    if (slotsAvailableNow && immediateRedirectUrl) {
      botLog({
        applicationId: clientId,
        step: 'cev_direct_slots_now_booking',
        status: 'ok',
        data: { redirectUrl: immediateRedirectUrl.slice(0, 120) },
      });
      try {
        // completebookingViaUI attend un path relatif (elle préfixe CEV_BASE elle-même)
        const redirectPath = immediateRedirectUrl.startsWith('http')
          ? new URL(immediateRedirectUrl).pathname + new URL(immediateRedirectUrl).search
          : immediateRedirectUrl;

        const sessionForBooking: CevSession = {
          cookies: cookieString,
          validUntil: captchaResult.session.validUntil,
          redirectUrl: redirectPath,
        };
        const bookConfig: CevBookingConfig = {
          clientId,
          vowintUsername: '',
          vowintPassword: '',
          vowintAppointmentUrl: '',
          twoCaptchaApiKey: '',
        };
        // completebookingViaUI navigue vers l'URL, dump le HTML de la page de créneaux,
        // et tente la sélection date → heure → confirmation via UI Playwright.
        const bookingResult = await completebookingViaUI(captchaPage, sessionForBooking, bookConfig, []);
        botLog({
          applicationId: clientId,
          step: 'cev_direct_immediate_booking_result',
          status: bookingResult.success ? 'ok' : 'fail',
          data: { success: bookingResult.success, error: bookingResult.error ?? null },
        });
      } catch (navErr) {
        botLog({
          applicationId: clientId,
          step: 'cev_direct_immediate_booking_error',
          status: 'fail',
          data: { error: String(navErr).slice(0, 300) },
        });
      }
    }

    netCapture.dump();
    await browser.close();

    // === ÉTAPE 4 : Persister la session dans Convex ===
    const validUntilMs = captchaResult.status === 'ready'
      ? new Date(captchaResult.session.validUntil.endsWith('Z') 
          ? captchaResult.session.validUntil 
          : captchaResult.session.validUntil + 'Z').getTime()
      : undefined;

    // Extraire uniquement la valeur ASP.NET_SessionId (suffisant pour le polling)
    const aspNetMatch = cookieString.match(/ASP\.NET_SessionId=([^;]+)/);
    const cookieForStorage = aspNetMatch ? aspNetMatch[1] : cookieString;

    // L'URL d'intégration peut venir de deux sources :
    //  1. La capture réseau Playwright (attachNetCapture) — priorité
    //  2. Le redirectUrl retourné par SetCaptchaToken — fallback fiable
    // Sans cette URL, pollCevSlot reçoit "pending" et échoue immédiatement.
    const captchaRedirectUrl = captchaResult.status === 'ready'
      ? captchaResult.session.redirectUrl
      : undefined;
    const integrationUrlToStore = discoveredIntegrationUrl ?? captchaRedirectUrl;

    const activated = await activateCevSession(sessionId, cookieForStorage, validUntilMs, integrationUrlToStore);
    if (!activated) {
      botLog({ applicationId: clientId, step: 'cev_direct_activate_failed', status: 'fail' });
      return { success: false, error: 'CONVEX_ACTIVATE_FAILED', sessionCookie: cookieForStorage, validUntilMs };
    }

    botLog({
      applicationId: clientId,
      step: 'cev_direct_setup_complete',
      status: 'ok',
      data: {
        mode: isCredMode ? 'vowint-credentials' : 'url-direct',
        result: captchaResult.status,
        validUntilMs: validUntilMs ?? 0,
        cookiePreview: cookieForStorage.slice(0, 4) + '…',
        integrationUrlSource: discoveredIntegrationUrl ? 'net_capture' : captchaRedirectUrl ? 'captcha_redirect' : 'none',
        integrationUrl: integrationUrlToStore ?? 'not_stored',
      },
    });

    return { success: true, sessionCookie: cookieForStorage, validUntilMs };

  } catch (err) {
    const errStr = String(err);
    try { if (browser) await (browser as { close(): Promise<void> }).close(); } catch { /* ignore */ }

    // Si le proxy a causé l'erreur et qu'on ne l'a pas encore bypassé → retry sans proxy.
    // ERR_PROXY_CONNECTION_FAILED = proxy injoignable.
    // ERR_TUNNEL_CONNECTION_FAILED = proxy joignable mais tunnel vers la destination échoue
    //   (BrightData bloqué sur ce domaine ou BrightData down).
    const isProxyErr = errStr.includes('ERR_PROXY_CONNECTION_FAILED')
      || errStr.includes('PROXY_CONNECTION_FAILED')
      || errStr.includes('ERR_TUNNEL_CONNECTION_FAILED')
      || errStr.includes('TUNNEL_CONNECTION_FAILED')
      || errStr.includes('ERR_PROXY_BAD_ENDPOINT'); // BrightData 402 bad_endpoint
    if (!forceNoProxy && isProxyErr) {
      botLog({
        applicationId: clientId,
        step: 'cev_vowint_proxy_fail_retry_direct',
        status: 'warn',
        data: { error: errStr.slice(0, 200), hint: 'Proxy/tunnel error — relance sans proxy (direct)' },
      });
      continue; // retry avec forceNoProxy = true
    }

    botLog({ applicationId: clientId, step: 'cev_direct_setup_crash', status: 'fail', data: { error: errStr } });
    return { success: false, error: errStr };
  }
  } // end for (forceNoProxy loop)
  return { success: false, error: 'PROXY_RETRY_EXHAUSTED' };
}

/**
 * Réservation CEV avec une session déjà établie (ASP.NET_SessionId existant).
 *
 * Utilisé par le polling loop quand `pollCevSlot` retourne `slot_found` :
 *  → réutilise le cookie valide existant (pas de re-login VOWINT, pas de captcha)
 *  → navigue directement vers l'URL d'intégration CEV
 *  → dump le HTML de la page SelectSlot pour reverse-engineering des sélecteurs
 *  → tente de compléter la réservation via UI
 *
 * @param integrationUrl  URL complète ou path CEV (ex: https://appointment.cloud.diplomatie.be/Integration/VOW/...)
 * @param sessionCookie   Valeur brute de ASP.NET_SessionId (sans le nom)
 * @param clientId        applicationId Convex (pour les logs botLog)
 */
export async function bookWithExistingSession(
  integrationUrl: string,
  sessionCookie: string,
  clientId: string,
): Promise<BookingResult> {
  const capturedCalls: CapturedNetworkCall[] = [];
  let browser = null;

  botLog({
    applicationId: clientId,
    step: 'cev_book_existing_session_start',
    status: 'ok',
    data: { integrationUrlPreview: integrationUrl.slice(0, 80) },
  });

  try {
    // ── Lancement stealth : iProyal (BrightData blackliste diplomatie.be), StealthPlugin, UA rotation ──
    const launched = await launchBrowser({ locale: 'fr-BE', timezoneId: 'Africa/Kinshasa', proxySource: 'iproyal' });
    browser = launched.browser;
    const context = launched.context;
    const page = launched.page;

    // Injecter directement le cookie de session (captcha déjà résolu lors du setup)
    await context.addCookies([
      {
        name: 'ASP.NET_SessionId',
        value: sessionCookie,
        domain: 'appointment.cloud.diplomatie.be',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
      {
        name: 'PreferredCulture',
        value: 'en-US',
        domain: 'appointment.cloud.diplomatie.be',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'Lax',
      },
    ]);

    botLog({ applicationId: clientId, step: 'cev_book_existing_session_cookie_injected', status: 'ok' });

    // Attacher la capture réseau pour reverse engineering (filtrée XHR/fetch/document)
    const netCapture = attachNetCapture(context, clientId);

    // Normaliser l'URL : construire l'URL complète pour la navigation
    const fullUrl = integrationUrl.startsWith('http')
      ? integrationUrl
      : `${CEV_BASE}${integrationUrl}`;

    // Naviguer vers l'URL d'intégration avec le cookie injecté
    // Le serveur va vérifier la session et rediriger vers SelectSlot (ou NoAvailability)
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await (page as any).waitForNavigation?.({ waitUntil: 'networkidle0', timeout: 15_000 }).catch(() => {});

    const currentUrl = page.url();
    botLog({
      applicationId: clientId,
      step: 'cev_book_existing_session_navigated',
      status: 'ok',
      data: { currentUrl, expectedBase: fullUrl.slice(0, 80) },
    });

    // Dump HTML immédiat — même avant la vérification d'erreur
    // Permet de voir la structure de la page (SelectSlot, NoAvailability, SessionExpired…)
    const pageHtml = await page.content().catch(() => '');
    botLog({
      applicationId: clientId,
      step: 'cev_book_existing_session_page_html',
      status: 'ok',
      data: { currentUrl, htmlPreview: pageHtml.slice(0, 4000) },
    });

    // Vérifier les états d'erreur connus
    if (currentUrl.includes('NoAvailability') || pageHtml.includes('NoAvailability')) {
      netCapture.dump();
      await browser.close();
      botLog({ applicationId: clientId, step: 'cev_book_existing_session_no_slot', status: 'warn', data: { currentUrl } });
      return { success: false, error: 'NO_AVAILABILITY_ON_NAVIGATE', capturedCalls };
    }

    if (
      currentUrl.includes('SessionExpired') ||
      currentUrl.includes('/Captcha') ||
      currentUrl.toLowerCase().includes('login') ||
      pageHtml.includes('Session has expired') ||
      pageHtml.includes('session expired')
    ) {
      netCapture.dump();
      await browser.close();
      botLog({ applicationId: clientId, step: 'cev_book_existing_session_expired', status: 'warn', data: { currentUrl } });
      return { success: false, error: 'SESSION_EXPIRED_ON_NAVIGATE', capturedCalls };
    }

    // Construire une CevSession depuis le cookie injecté + URL courante
    const session: CevSession = {
      cookies: `ASP.NET_SessionId=${sessionCookie}; PreferredCulture=en-US`,
      validUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      redirectUrl: new URL(currentUrl).pathname + new URL(currentUrl).search,
    };

    // Construire un config minimal (VOWINT non requis — session déjà établie)
    const config: CevBookingConfig = {
      clientId,
      vowintUsername: '',
      vowintPassword: '',
      vowintAppointmentUrl: '',
      twoCaptchaApiKey: '',
    };

    // Compléter la réservation via UI (sélection date → heure → confirmation)
    const result = await completebookingViaUI(page, session, config, capturedCalls);

    netCapture.dump();
    await browser.close();
    return { ...result, capturedCalls };

  } catch (err) {
    botLog({
      applicationId: clientId,
      step: 'cev_book_existing_session_crash',
      status: 'fail',
      data: { error: String(err) },
    });
    try { if (browser) await (browser as { close(): Promise<void> }).close(); } catch { /* ignore */ }
    return { success: false, error: String(err), capturedCalls };
  }
}
