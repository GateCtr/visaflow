import { chromium, BrowserContext, Page, Request, Response } from 'playwright';
import type { HunterJob } from './convexClient';
import { botLog, uploadScreenshot, recordCevClick, activateCevSession } from './convexClient';
import { completeCevCaptcha, pollCevSlots, pollCevSlotsMultiMonth, isCevSessionValid, CevSession } from './cevPortal';

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';
const VOWINT_BASE = 'https://visaonweb.diplomatie.be';

// Nombre max de clics "Prendre rendez-vous" par heure (limite CEV)
const MAX_CLICKS_PER_HOUR = 4; // on garde 1 de marge
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
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'fr-BE',
      timezoneId: 'Africa/Kinshasa',
    });

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

    // === CAPTURE RÉSEAU : intercepte TOUS les appels sur appointment.cloud.diplomatie.be ===
    context.on('request', (req: Request) => {
      if (req.url().includes('appointment.cloud.diplomatie.be')) {
        const entry: CapturedNetworkCall = {
          timestamp: Date.now(),
          method: req.method(),
          url: req.url(),
          requestBody: req.postData() ?? undefined,
        };
        capturedCalls.push(entry);
        botLog({
          applicationId: config.clientId,
          step: 'cev_network_request',
          status: 'ok',
          data: { method: req.method(), url: req.url(), body: req.postData() ?? '' },
        });
      }
    });

    context.on('response', async (res: Response) => {
      if (res.url().includes('appointment.cloud.diplomatie.be')) {
        const entry = [...capturedCalls].reverse().find((c: CapturedNetworkCall) => c.url === res.url() && !c.responseStatus);
        if (entry) {
          entry.responseStatus = res.status();
          try {
            const ct = res.headers()['content-type'] ?? '';
            if (ct.includes('json') || ct.includes('text')) {
              entry.responseBody = await res.text().catch(() => '[unreadable]');
            }
          } catch { /* ignore */ }
        }
        botLog({
          applicationId: config.clientId,
          step: 'cev_network_response',
          status: 'ok',
          data: { status: res.status(), url: res.url() },
        });
      }
    });

    // === ÉTAPE 1 : Ouvrir VOWINT et naviguer vers la page de demande ===
    const page = await context.newPage();
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

    await browser.close();
    return { ...result, capturedCalls };

  } catch (err) {
    botLog({ applicationId: config.clientId, step: 'cev_booking_crash', status: 'fail', data: { error: String(err) } });
    try { if (browser) await (browser as Awaited<ReturnType<typeof chromium.launch>>).close(); } catch { /* ignore */ }
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
  context: BrowserContext,
  config: CevBookingConfig,
  _capturedCalls: CapturedNetworkCall[]
): Promise<{ cookies: string; cevPage: Page } | null> {
  try {
    // === ÉTAPE 0 : Login VOWINT ===
    botLog({ applicationId: config.clientId, step: 'cev_vowint_login_start', status: 'ok', data: { user: config.vowintUsername } });
    await page.goto('https://visaonweb.diplomatie.be', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const loginTitle = await page.title();
    const loginUrl = page.url();
    const isLoginPage = loginTitle.toLowerCase().includes('login') ||
      loginTitle.toLowerCase().includes('connexion') ||
      loginUrl.toLowerCase().includes('account/login');

    if (isLoginPage) {
      await page.fill('input#UserName', config.vowintUsername);
      await page.fill('input#Password', config.vowintPassword);
      await page.click('button[type="submit"]');
      await page.waitForLoadState('networkidle', { timeout: 15_000 });

      const afterUrl = page.url();
      const afterTitle = await page.title();
      const stillLogin = afterUrl.toLowerCase().includes('account/login') ||
        afterTitle.toLowerCase().includes('login') ||
        afterTitle.toLowerCase().includes('connexion');

      if (stillLogin) {
        botLog({ applicationId: config.clientId, step: 'cev_vowint_login_failed', status: 'fail', data: { afterUrl, afterTitle } });
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

    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    // Attendre le rendu AngularJS (lazy-loaded)
    await new Promise(r => setTimeout(r, 2_500));

    botLog({ applicationId: config.clientId, step: 'cev_vowint_apps_page', status: 'ok', data: { url: page.url() } });

    // === ÉTAPE 2 : Trouver le bouton calendrier "Prendre rendez-vous" ===
    // VOWINT AngularJS : ng-click="groupVAEapp(...)" = bouton RDV (icône calendrier .fa-calendar)
    const rdvBtn = await page.$('[ng-click*="groupVAEapp"]') ??
                   await page.$('button:has(.fa-calendar)') ??
                   await page.$('[ng-click*="appointment"]');

    if (!rdvBtn) {
      const allNgClicks = await page.$$eval('[ng-click]', (els: any[]) =>
        els.map(e => e.getAttribute('ng-click'))
      ).catch(() => []);
      botLog({ applicationId: config.clientId, step: 'cev_rdv_btn_not_found', status: 'fail', data: { allNgClicks } });
      return null;
    }

    botLog({ applicationId: config.clientId, step: 'cev_rdv_btn_found', status: 'ok' });

    // === ÉTAPE 3 : Cliquer et attendre le nouvel onglet CEV ===
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      rdvBtn.click(),
    ]);

    await newPage.waitForLoadState('domcontentloaded', { timeout: 20_000 });
    await new Promise(r => setTimeout(r, 2_000)); // laisser les cookies s'établir dans le jar

    const newPageUrl = newPage.url();
    botLog({ applicationId: config.clientId, step: 'cev_new_tab_opened', status: 'ok', data: { url: newPageUrl } });

    if (!newPageUrl.includes('appointment.cloud.diplomatie.be')) {
      botLog({ applicationId: config.clientId, step: 'cev_wrong_tab', status: 'fail', data: { url: newPageUrl } });
      return null;
    }

    // === ÉTAPE 4 : Extraire ASP.NET_SessionId depuis le jar navigateur ===
    const allCookies = await context.cookies();
    const cevCookies = allCookies.filter(c =>
      c.domain.includes('appointment.cloud.diplomatie.be')
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

    return { cookies: cookieString, cevPage: newPage };

  } catch (err) {
    botLog({ applicationId: config.clientId, step: 'cev_session_establish_error', status: 'fail', data: { error: String(err) } });
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
    await page.goto(calendarUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    botLog({ applicationId: config.clientId, step: 'cev_calendar_loaded', status: 'ok', data: { url: calendarUrl } });

    // Laisser le calendrier Bootstrap se charger (appel AJAX /Home/AvailableTimeSlots)
    await new Promise(r => setTimeout(r, 3_000));

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
        bookedDate = await dateEl.getAttribute('data-date') ??
                     await dateEl.getAttribute('data-value') ??
                     await dateEl.innerText().catch(() => '');
        await dateEl.click();
        dateClicked = true;
        botLog({ applicationId: config.clientId, step: 'cev_date_selected', status: 'ok', data: { selector: sel, date: bookedDate } });
        break;
      }
    }

    if (!dateClicked) {
      // Screenshot pour debug si aucun sélecteur ne marche
      const screenshotBuf = await page.screenshot().catch(() => null);
      const screenshotB64 = screenshotBuf ? screenshotBuf.toString('base64') : null;
      const storageId = screenshotB64 ? await uploadScreenshot(screenshotB64) : null;
      const pageUrl = page.url();
      const pageText = await page.innerText('body').catch(() => '');
      botLog({ applicationId: config.clientId, step: 'cev_no_date_found', status: 'fail', data: { screenshotStorageId: storageId ?? '', pageUrl, pageTextPreview: pageText.slice(0, 300) } });
      return { success: false, error: 'NO_DATE_SELECTOR_MATCHED', screenshotStorageId: storageId ?? undefined };
    }

    // Attendre le chargement des créneaux horaires (AJAX probable après sélection date)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1_500));

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
        bookedTime = await timeEl.getAttribute('data-slot-time') ??
                     await timeEl.getAttribute('data-time') ??
                     await timeEl.getAttribute('value') ??
                     await timeEl.innerText().catch(() => '');
        await timeEl.click();
        timeClicked = true;
        botLog({ applicationId: config.clientId, step: 'cev_time_selected', status: 'ok', data: { selector: sel, time: bookedTime } });
        break;
      }
    }

    if (timeClicked) {
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1_000));
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
        await btn.click();
        botLog({ applicationId: config.clientId, step: 'cev_confirm_clicked', status: 'ok', data: { selector: sel } });
        break;
      }
    }

    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    // === Screenshot de confirmation ===
    const screenshotBuf2 = await page.screenshot({ fullPage: true }).catch(() => null);
    const screenshotB64 = screenshotBuf2 ? screenshotBuf2.toString('base64') : null;
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

    return {
      success,
      confirmationCode: confirmationCode ?? undefined,
      bookedDate,
      bookedTime,
      screenshotStorageId,
    };

  } catch (err) {
    const screenshotBuf3 = await page.screenshot().catch(() => null);
    const screenshotStorageId3 = screenshotBuf3 ? await uploadScreenshot(screenshotBuf3.toString('base64')) : undefined;
    const screenshotStorageId = screenshotStorageId3 ?? undefined;
    botLog({ applicationId: config.clientId, step: 'cev_booking_ui_error', status: 'fail', data: { error: String(err) } });
    return { success: false, error: String(err), screenshotStorageId };
  }
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
        const text = await el.innerText();
        if (text && text.trim().length > 0) return text.trim();
      }
    } catch { /* continue */ }
  }

  // Fallback : cherche un pattern alphanumérique dans le body (code RDV belge)
  const bodyText = await page.innerText('body').catch(() => '');
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
 *  1. Anti-Captcha (ANTICAPTCHA_API_KEY) — supporte les domaines gouvernementaux
 *  2. CapSolver    (CAPSOLVER_API_KEY)    — note: sitekey CEV blacklistée en 2026-04
 *  3. 2captcha     (twoCaptchaApiKey)     — note: compte actuel ne supporte pas hCaptcha
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

  // ─── Tentative 1 : Anti-Captcha (priorité — domaines gouvernementaux supportés) ──
  const antiKey = process.env.ANTICAPTCHA_API_KEY ?? '';
  if (antiKey) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_anticaptcha_start', status: 'ok' });
    const token = await solveHcaptchaViaAntiCaptcha(antiKey, HCAPTCHA_SITE_KEY, PAGE_URL, clientId);
    if (token) return token;
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_anticaptcha_fail_fallback', status: 'warn' });
  }

  // ─── Tentative 2 : CapSolver ─────────────────────────────────────────────
  // Note : sitekey CEV blacklistée par CapSolver en 2026-04 — fallback seulement
  const capKey = capsolverApiKey ?? process.env.CAPSOLVER_API_KEY ?? '';
  if (capKey) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_capsolver_start', status: 'ok' });
    const token = await solveHcaptchaViaCapsolver(capKey, HCAPTCHA_SITE_KEY, PAGE_URL, clientId);
    if (token) return token;
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_capsolver_fail_fallback', status: 'warn' });
  }

  // ─── Tentative 3 : 2captcha HCaptchaTaskProxyless ────────────────────────
  if (twoCaptchaApiKey) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_2captcha_start', status: 'ok' });
    const token = await solveHcaptchaVia2captcha(twoCaptchaApiKey, HCAPTCHA_SITE_KEY, PAGE_URL, clientId);
    if (token) return token;
  }

  botLog({ applicationId: clientId, step: 'cev_hcaptcha_all_failed', status: 'fail', data: { hint: 'Configurer ANTICAPTCHA_API_KEY (anti-captcha.com) — CapSolver blackliste cette sitekey; 2captcha ne supporte pas hCaptcha sur ce compte' } });
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
 * Supporte hCaptcha proxyless nativement. ~30-60s pour une résolution.
 * Note : sitekey CEV (5f64399c-...) blacklistée par CapSolver en 2026-04.
 */
async function solveHcaptchaViaCapsolver(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  clientId: string,
): Promise<string | null> {
  try {
    const createRes = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'HCaptchaTaskProxyLess',
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
    });

    const createData = await createRes.json() as { errorId: number; errorCode?: string; taskId?: number };
    if (createData.errorId !== 0 || !createData.taskId) {
      botLog({ applicationId: clientId, step: 'cev_capsolver_create_fail', status: 'fail', data: { error: createData.errorCode ?? createData.errorId } });
      return null;
    }

    const taskId = createData.taskId;
    botLog({ applicationId: clientId, step: 'cev_capsolver_task_created', status: 'ok', data: { taskId } });

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
        solution?: { gRecaptchaResponse?: string; userAgent?: string };
        errorCode?: string;
      };

      if (pollData.errorId !== 0 || pollData.status === 'failed') {
        botLog({ applicationId: clientId, step: 'cev_capsolver_poll_fail', status: 'fail', data: { error: pollData.errorCode ?? pollData.status } });
        return null;
      }

      if (pollData.status === 'ready' && pollData.solution?.gRecaptchaResponse) {
        botLog({ applicationId: clientId, step: 'cev_capsolver_solved', status: 'ok', data: { attempts: i + 1, tokenLen: pollData.solution.gRecaptchaResponse.length } });
        return pollData.solution.gRecaptchaResponse;
      }
    }

    botLog({ applicationId: clientId, step: 'cev_capsolver_timeout', status: 'fail' });
    return null;

  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_capsolver_exception', status: 'fail', data: { error: String(err) } });
    return null;
  }
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
 * Boucle de polling CEV — à appeler depuis le bot principal.
 * Gère la limite 5 clics/heure et réutilise la session CEV tant qu'elle est valide.
 *
 * Phase "session active" : poll multi-mois (mois courant + suivant) sans recliquer.
 * → Maximise la détection de créneaux quand le mois courant est complet.
 * → 0 clic VOWINT consommé pendant toute la durée de validité de la session (~30-60 min).
 */
export async function cevPollingLoop(
  config: CevBookingConfig,
  onSlotsFound: (result: BookingResult) => Promise<void>
): Promise<void> {
  const clickTimestamps: number[] = [];
  let activeSession: CevSession | null = null;

  botLog({ applicationId: config.clientId, step: 'cev_poll_loop_start', status: 'ok' });

  while (true) {
    const now = Date.now();

    // Si session active et valide → poller directement sans recliquer (multi-mois)
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

    // Session expirée ou inexistante → vérifier la limite de clics
    const recentClicks = clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
    if (recentClicks.length >= MAX_CLICKS_PER_HOUR) {
      const oldestClick = Math.min(...recentClicks);
      const waitMs = CLICK_WINDOW_MS - (now - oldestClick) + 5_000;
      botLog({ applicationId: config.clientId, step: 'cev_rate_limit_wait', status: 'warn', data: { waitMs } });
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Lancer un nouveau cycle : Playwright + hCaptcha
    clickTimestamps.push(now);
    const result = await runCevBookingSession(config);

    if (result.success) {
      await onSlotsFound(result);
      return;
    }

    if (result.error === 'NO_AVAILABILITY') {
      // Pas de créneaux — attendre avant de réessayer
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // Erreur technique — pause courte puis retry
    botLog({ applicationId: config.clientId, step: 'cev_poll_loop_error', status: 'warn', data: { error: result.error } });
    await new Promise(r => setTimeout(r, 10_000));
  }
}

// ─── Adaptateur single-shot pour le main loop du bot ───────────────────────
// Effectue un seul cycle VOWINT + hCaptcha pour le job Schengen donné.
// La limite de 5 clics/heure est gérée côté main loop via un intervalle minimum de 15 min.
const CEV_HCAPTCHA_SITEKEY = '5f64399c-14a8-415e-ad1a-7ebccdc4943a';

export type SchengenSessionResult = 'slot_found' | 'not_found' | 'rate_limited' | 'error';

export async function runCevCheck(job: HunterJob): Promise<SchengenSessionResult> {
  const hc = job.hunterConfig;
  const twoCaptchaApiKey = hc.twoCaptchaApiKey ?? process.env.TWOCAPTCHA_API_KEY ?? '';

  if (!twoCaptchaApiKey) {
    botLog({ applicationId: job.id, step: 'cev_check_no_captcha_key', status: 'warn', data: { note: '2captcha key absent — check ignoré' } });
    return 'error';
  }

  // Vérifier la limite de clics: max 4 clics/heure par application
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000;
  const windowStart = hc.cevClickWindowStart ?? 0;
  const clickCount = (now - windowStart < WINDOW_MS) ? (hc.cevClickCount ?? 0) : 0;

  if (clickCount >= 4) {
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
export async function runCevDirectSessionSetup(
  integrationUrl: string,
  sessionId: string,
  clientId: string,
): Promise<CevDirectSetupResult> {
  botLog({ applicationId: clientId, step: 'cev_direct_setup_start', status: 'ok', data: { integrationUrl } });

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'fr-BE',
      timezoneId: 'Africa/Kinshasa',
    });

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

    const page = await context.newPage();

    // === ÉTAPE 1 : Naviguer vers l'URL directe → redirect vers /Captcha ===
    await page.goto(integrationUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise(r => setTimeout(r, 2_000)); // laisser les cookies s'établir

    const currentUrl = page.url();
    botLog({ applicationId: clientId, step: 'cev_direct_navigation_done', status: 'ok', data: { currentUrl } });

    // === ÉTAPE 2 : Extraire les cookies CEV depuis le jar navigateur ===
    const allCookies = await context.cookies();
    const cevCookies = allCookies.filter(c =>
      c.domain.includes('appointment.cloud.diplomatie.be')
    );

    if (cevCookies.length === 0) {
      botLog({ applicationId: clientId, step: 'cev_direct_no_cookie', status: 'fail', data: { currentUrl } });
      await browser.close();
      return { success: false, error: 'NO_SESSION_COOKIE_AFTER_NAVIGATION' };
    }

    const cookieString = cevCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const aspNetCookie = cevCookies.find(c => c.name === 'ASP.NET_SessionId');

    botLog({
      applicationId: clientId,
      step: 'cev_direct_cookie_captured',
      status: 'ok',
      data: { names: cevCookies.map(c => c.name).join(', '), hasAspNet: !!aspNetCookie },
    });

    // === ÉTAPE 3 : Résoudre hCaptcha ===
    let hcaptchaToken: string | null = null;

    // Priorité 0 : Mode accessibilité (cookie hc_accessibility — gratuit)
    if (accessibilityCookie) {
      hcaptchaToken = await solveHcaptchaViaAccessibility(page, clientId);
    }

    // Fallback : services externes
    if (!hcaptchaToken) {
      const twoCaptchaApiKey = process.env.TWOCAPTCHA_API_KEY ?? '';
      hcaptchaToken = await solveHcaptcha(twoCaptchaApiKey, clientId);
    }

    if (!hcaptchaToken) {
      await browser.close();
      botLog({ applicationId: clientId, step: 'cev_direct_captcha_failed', status: 'fail' });
      return { success: false, error: 'HCAPTCHA_FAILED' };
    }

    // === ÉTAPE 4 : POST SetCaptchaToken avec le cookie de session ===
    const captchaResult = await (await import('./cevPortal.js')).completeCevCaptcha(
      cookieString, hcaptchaToken, clientId
    );

    await browser.close();

    if (captchaResult.status === 'session_error') {
      return { success: false, error: captchaResult.error };
    }

    // === ÉTAPE 5 : Extraire validUntil et persister la session dans Convex ===
    const validUntilMs = captchaResult.status === 'ready'
      ? new Date(captchaResult.session.validUntil).getTime()
      : undefined;

    // La valeur ASP.NET_SessionId seule suffit pour le polling (cevPolling.ts attend juste la valeur)
    const cookieForStorage = aspNetCookie?.value ?? cookieString;

    // Activer la session dans Convex
    const activated = await activateCevSession(sessionId, cookieForStorage, validUntilMs);
    if (!activated) {
      botLog({ applicationId: clientId, step: 'cev_direct_activate_failed', status: 'fail' });
      return { success: false, error: 'CONVEX_ACTIVATE_FAILED', sessionCookie: cookieForStorage, validUntilMs };
    }

    botLog({
      applicationId: clientId,
      step: 'cev_direct_setup_complete',
      status: 'ok',
      data: {
        result: captchaResult.status,
        validUntilMs: validUntilMs ?? 0,
        cookiePreview: cookieForStorage.slice(0, 4) + '…',
      },
    });

    return { success: true, sessionCookie: cookieForStorage, validUntilMs };

  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_direct_setup_crash', status: 'fail', data: { error: String(err) } });
    try { if (browser) await (browser as Awaited<ReturnType<typeof chromium.launch>>).close(); } catch { /* ignore */ }
    return { success: false, error: String(err) };
  }
}
