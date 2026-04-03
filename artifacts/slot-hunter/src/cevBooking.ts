import { chromium, BrowserContext, Page, Request, Response } from 'playwright';
import { botLog, uploadScreenshot } from './convexClient';
import { completeCevCaptcha, pollCevSlots, isCevSessionValid, CevSession } from './cevPortal';

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
        const entry = capturedCalls.findLast(c => c.url === res.url() && !c.responseStatus);
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
    const hcaptchaToken = await solveHcaptcha(config.twoCaptchaApiKey, config.clientId);
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
 * Établit la session CEV en interceptant le POST depuis le bouton VOWINT.
 * Retourne les cookies de session ou null si échec.
 */
async function establishCevSession(
  page: Page,
  context: BrowserContext,
  config: CevBookingConfig,
  capturedCalls: CapturedNetworkCall[]
): Promise<{ cookies: string } | null> {
  let cevSessionCookies: string | null = null;

  // Intercepter la réponse de /Captcha pour capturer les cookies de session
  context.on('response', async (res: Response) => {
    if (
      res.url().startsWith(`${CEV_BASE}/Captcha`) &&
      res.request().method() === 'POST'
    ) {
      const setCookieHeader = res.headers()['set-cookie'];
      if (setCookieHeader && !cevSessionCookies) {
        // Normaliser les cookies en une seule string
        const cookies = Array.isArray(setCookieHeader)
          ? setCookieHeader.map(c => c.split(';')[0]).join('; ')
          : setCookieHeader.split(';')[0];
        cevSessionCookies = cookies;
        botLog({
          applicationId: config.clientId,
          step: 'cev_session_cookie_captured',
          status: 'ok',
          data: { cookieLen: cookies.length },
        });
      }
    }
  });

  try {
    // Naviguer vers la page de demande VOWINT (AppointmentUrl stockée en Convex)
    await page.goto(config.vowintAppointmentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Attendre le bouton "Prendre rendez-vous"
    const btnSelector = 'a[href*="appointment"], button:has-text("rendez-vous"), a:has-text("rendez-vous")';
    await page.waitForSelector(btnSelector, { timeout: 15_000 });

    // Écouter l'ouverture d'un nouvel onglet (blob: URL)
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15_000 }),
      page.click(btnSelector),
    ]);

    // Attendre que la page CEV charge (elle sera redirigée vers /Captcha)
    await newPage.waitForLoadState('domcontentloaded', { timeout: 20_000 });

    // Attendre max 5s que les cookies soient capturés
    const deadline = Date.now() + 5_000;
    while (!cevSessionCookies && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }

    if (!cevSessionCookies) {
      botLog({ applicationId: config.clientId, step: 'cev_session_cookie_missing', status: 'fail' });
      return null;
    }

    return { cookies: cevSessionCookies };

  } catch (err) {
    botLog({ applicationId: config.clientId, step: 'cev_session_establish_error', status: 'fail', data: { error: String(err) } });
    return null;
  }
}

/**
 * Complète le booking via l'UI Playwright une fois que les créneaux sont disponibles.
 * Capture tous les appels réseau pour reverse engineering (Option B).
 *
 * Le flux typique ASP.NET MVC de ce type de système :
 *  1. Calendrier → cliquer une date disponible
 *  2. Sélection de l'heure → cliquer un créneau
 *  3. Formulaire de confirmation → soumettre
 *  4. Page de succès → extraire le code de confirmation
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

    // === Sélectionner la première date disponible ===
    // Les dates disponibles ont généralement une classe "available", "enabled", ou similaire
    // On essaie plusieurs sélecteurs communs pour les calendriers ASP.NET MVC
    const dateCandidates = [
      'td.available a',
      'td:not(.disabled):not(.unavailable) a[data-date]',
      '.day.available',
      'a.available-day',
      'td.enabled a',
      '[class*="available"]:not([class*="un"])',
    ];

    let dateClicked = false;
    let bookedDate = '';

    for (const sel of dateCandidates) {
      const dateEl = await page.$(sel);
      if (dateEl) {
        bookedDate = await dateEl.getAttribute('data-date') ?? await dateEl.innerText().catch(() => '');
        await dateEl.click();
        dateClicked = true;
        botLog({ applicationId: config.clientId, step: 'cev_date_selected', status: 'ok', data: { selector: sel, date: bookedDate } });
        break;
      }
    }

    if (!dateClicked) {
      // Screenshot pour debug si aucun sélecteur ne marche
      const screenshotB64 = await page.screenshot({ encoding: 'base64' }).catch(() => null);
      const storageId = screenshotB64 ? await uploadScreenshot(screenshotB64) : null;
      botLog({ applicationId: config.clientId, step: 'cev_no_date_found', status: 'fail', data: { screenshotStorageId: storageId ?? '' } });
      return { success: false, error: 'NO_DATE_SELECTOR_MATCHED', screenshotStorageId: storageId ?? undefined };
    }

    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    // === Sélectionner le premier créneau horaire ===
    const timeCandidates = [
      'input[type="radio"][name*="time"]',
      'button.time-slot',
      'a.time-slot',
      '[data-time]',
      'li.available-slot a',
      'td.time-available a',
    ];

    let timeClicked = false;
    let bookedTime = '';

    for (const sel of timeCandidates) {
      const timeEl = await page.$(sel);
      if (timeEl) {
        bookedTime = await timeEl.getAttribute('data-time') ?? await timeEl.innerText().catch(() => '');
        await timeEl.click();
        timeClicked = true;
        botLog({ applicationId: config.clientId, step: 'cev_time_selected', status: 'ok', data: { selector: sel, time: bookedTime } });
        break;
      }
    }

    if (timeClicked) {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    }

    // === Cliquer le bouton de confirmation final ===
    const confirmCandidates = [
      'button[type="submit"]:has-text("Confirm")',
      'button[type="submit"]:has-text("Confirmer")',
      'input[type="submit"]',
      'button.btn-primary:has-text("Book")',
      'button.btn-success',
      '#btnConfirm',
      '.btnConfirm',
    ];

    for (const sel of confirmCandidates) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        botLog({ applicationId: config.clientId, step: 'cev_confirm_clicked', status: 'ok', data: { selector: sel } });
        break;
      }
    }

    await page.waitForLoadState('networkidle', { timeout: 20_000 });

    // === Screenshot de confirmation ===
    const screenshotB64 = await page.screenshot({ encoding: 'base64', fullPage: true }).catch(() => null);
    const screenshotStorageId = screenshotB64 ? await uploadScreenshot(screenshotB64) : undefined;

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
    const screenshotB64 = await page.screenshot({ encoding: 'base64' }).catch(() => null);
    const screenshotStorageId = screenshotB64 ? await uploadScreenshot(screenshotB64) : undefined;
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
 * Résout un hCaptcha via l'API 2captcha.
 * Le siteKey est fixe pour appointment.cloud.diplomatie.be.
 */
async function solveHcaptcha(apiKey: string, clientId: string): Promise<string | null> {
  const HCAPTCHA_SITE_KEY = 'ce876cf6-0a3d-4a8b-b840-74e89bfded93'; // site key CEV
  const PAGE_URL = `${CEV_BASE}/Captcha`;

  botLog({ applicationId: clientId, step: 'cev_hcaptcha_solve_start', status: 'ok' });

  try {
    // Soumettre le captcha à 2captcha
    const submitRes = await fetch('http://2captcha.com/in.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        key: apiKey,
        method: 'hcaptcha',
        sitekey: HCAPTCHA_SITE_KEY,
        pageurl: PAGE_URL,
        json: '1',
      }).toString(),
    });

    const submitData = await submitRes.json() as { status: number; request: string };
    if (submitData.status !== 1) {
      botLog({ applicationId: clientId, step: 'cev_hcaptcha_submit_fail', status: 'fail', data: { response: String(submitData.request) } });
      return null;
    }

    const captchaId = submitData.request;

    // Poller jusqu'à résolution (max 120s)
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5_000));

      const pollRes = await fetch(
        `http://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`
      );
      const pollData = await pollRes.json() as { status: number; request: string };

      if (pollData.status === 1) {
        botLog({ applicationId: clientId, step: 'cev_hcaptcha_solved', status: 'ok', data: { attempts: i + 1 } });
        return pollData.request;
      }

      if (pollData.request !== 'CAPCHA_NOT_READY') {
        botLog({ applicationId: clientId, step: 'cev_hcaptcha_poll_error', status: 'fail', data: { response: pollData.request } });
        return null;
      }
    }

    botLog({ applicationId: clientId, step: 'cev_hcaptcha_timeout', status: 'fail' });
    return null;

  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_hcaptcha_exception', status: 'fail', data: { error: String(err) } });
    return null;
  }
}

/**
 * Boucle de polling CEV — à appeler depuis le bot principal.
 * Gère la limite 5 clics/heure et réutilise la session CEV tant qu'elle est valide.
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

    // Si session active et valide → poller directement sans recliquer
    if (activeSession && isCevSessionValid(activeSession)) {
      const pollResult = await pollCevSlots(activeSession, config.clientId);

      if (pollResult.error === 'SESSION_EXPIRED') {
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
