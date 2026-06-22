/**
 * content-cev.js — appointment.cloud.diplomatie.be  v3.1
 *
 * MODE DÉTECTION UNIQUEMENT — Réaction intelligente aux erreurs serveur.
 *
 * Signaux détectés et remontés au background :
 *   RATE_LIMITED  — 429, 403 WAF, corps de page avec mots-clés "trop de tentatives",
 *                   URL /Error/TooManyAttempts, /Error/Blocked, /Error/AccessDenied
 *   SERVER_ERROR  — 5xx avec classification (down, timeout, conflit)
 *   SESSION_ERROR — 401 / 410 / session expirée
 *   CEV_RESULT    — no_availability, slot_found, captcha_*
 *   SLOT_FOUND    — créneau disponible détecté
 */

'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function bg(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }
function log(msg, level = 'info') { bg({ type: 'LOG', level, msg }); }

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';
const SITEKEY  = '5f64399c-14a8-415e-ad1a-7ebccdc4943a';

// ─── Détection Too Many Attempts / Rate-limit ─────────────────────────────────

/**
 * Mots-clés indiquant un rate-limit ou blocage (FR / EN / NL).
 * Cherchés dans le corps de la page ET dans les corps de réponse JSON.
 */
const RATE_LIMIT_PATTERNS = [
  /trop de tentatives/i,
  /too many attempts/i,
  /too many requests/i,
  /te veel pogingen/i,
  /rate.?limit/i,
  /vous avez été bloqué/i,
  /you have been blocked/i,
  /access denied/i,
  /accès refusé/i,
  /please try again later/i,
  /réessayez plus tard/i,
  /veuillez patienter/i,
  /temporarily blocked/i,
  /temporairement bloqué/i,
  /maximum.*attempt/i,
  /quota.*exceeded/i,
  /suspicious activity/i,
  /activité suspecte/i,
];

/**
 * Vérifie si un texte contient un signal de rate-limit.
 */
function containsRateLimitSignal(text) {
  if (!text) return false;
  return RATE_LIMIT_PATTERNS.some(re => re.test(text));
}

/**
 * Vérifie si l'URL courante indique une page de blocage CEV.
 */
function isRateLimitUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    u.includes('/error/toomanyrequests')  ||
    u.includes('/error/toomanyattempts')  ||
    u.includes('/error/blocked')          ||
    u.includes('/error/accessdenied')     ||
    u.includes('/error/forbidden')        ||
    u.includes('toomany')                 ||
    u.includes('ratelimit')               ||
    u.includes('blocked')
  );
}

/**
 * Signale un rate-limit au background avec source et raison.
 */
async function reportRateLimit(source, reason) {
  log(`🚫 RATE-LIMIT détecté [${source}] — ${reason}`, 'error');
  await bg({ type: 'RATE_LIMITED', source, reason });
}

/**
 * Signale une erreur serveur au background.
 * `category` : 'down' | 'timeout' | 'conflict' | 'session' | 'generic'
 */
async function reportServerError(source, status, category, reason) {
  log(`⚠️ ERREUR SERVEUR ${status} [${source}] ${category} — ${reason}`, 'error');
  await bg({ type: 'SERVER_ERROR', source, status, category, reason });
}

// ─── Classification HTTP ──────────────────────────────────────────────────────

/**
 * Classifie un code HTTP retourné par CEV.
 * Retourne { label, category } ou null si 2xx.
 *
 * categories :
 *   rate_limited  → pause 60min
 *   session       → re-login
 *   conflict      → continuer (slot pris entre-temps)
 *   down          → pause 10min (serveur down)
 *   timeout       → pause 5min  (timeout réseau)
 *   generic       → pause 5min  (autre 4xx/5xx)
 */
function classifyStatus(status) {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return { label: '429 Too Many Requests',          category: 'rate_limited' };
  if (status === 403) return { label: '403 Forbidden (WAF)',            category: 'rate_limited' };
  if (status === 401) return { label: '401 Unauthorized',               category: 'session'      };
  if (status === 410) return { label: '410 Gone — session révoquée',    category: 'session'      };
  if (status === 409) return { label: '409 Conflict — slot déjà pris',  category: 'conflict'     };
  if (status === 400) return { label: '400 Bad Request',                category: 'generic'      };
  if (status === 404) return { label: '404 Not Found',                  category: 'generic'      };
  if (status === 408) return { label: '408 Request Timeout',            category: 'timeout'      };
  if (status === 422) return { label: '422 Unprocessable',              category: 'generic'      };
  if (status === 500) return { label: '500 Internal Server Error',      category: 'down'         };
  if (status === 502) return { label: '502 Bad Gateway',                category: 'down'         };
  if (status === 503) return { label: '503 Service Unavailable',        category: 'down'         };
  if (status === 504) return { label: '504 Gateway Timeout',            category: 'timeout'      };
  if (status >= 400 && status < 500) return { label: `${status} Erreur client`, category: 'generic' };
  if (status >= 500) return { label: `${status} Erreur serveur`,        category: 'down'         };
  return { label: `HTTP ${status}`, category: 'generic' };
}

// ─── Helpers captcha ──────────────────────────────────────────────────────────

function detectHcaptchaWidget() {
  const widget = document.querySelector(`[data-sitekey="${SITEKEY}"], [data-sitekey]`);
  if (widget) return { found: true, sitekey: widget.getAttribute('data-sitekey'), widget };
  for (const iframe of document.querySelectorAll('iframe')) {
    const m = (iframe.src || '').match(/[?&]sitekey=([^&]+)/);
    if (m && iframe.src.includes('hcaptcha.com')) return { found: true, sitekey: m[1], widget: iframe };
  }
  return { found: false };
}

function triggerNativeCallback(token) {
  for (const name of ['h-captcha-response', 'g-recaptcha-response', 'captcha']) {
    const ta = document.querySelector(`textarea[name="${name}"]`);
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, token); else ta.value = token;
      ta.dispatchEvent(new Event('input',  { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  const widget  = document.querySelector('[data-callback]');
  const cbName  = widget?.getAttribute('data-callback');
  if (cbName && typeof window[cbName] === 'function') {
    try { window[cbName](token); return true; } catch {}
  }
  if (window.hcaptcha) {
    try {
      const widgetId = document.querySelector('[data-hcaptcha-widget-id]')
                         ?.getAttribute('data-hcaptcha-widget-id');
      if (widgetId) { window.hcaptcha.execute(widgetId, { token }); return true; }
    } catch {}
  }
  return false;
}

// ─── POST /Captcha/SetCaptchaToken ────────────────────────────────────────────

async function postSetCaptchaToken(token) {
  try {
    const resp = await fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': '*/*',
        'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8',
      },
      body: `captcha=${encodeURIComponent(token)}`,
    });

    const cls = classifyStatus(resp.status);
    if (cls) {
      if (cls.category === 'rate_limited') {
        await reportRateLimit('SetCaptchaToken', cls.label);
        return { ok: false, rateLimited: true, error: cls.label };
      }
      if (cls.category === 'session') {
        await reportServerError('SetCaptchaToken', resp.status, 'session', cls.label);
        return { ok: false, sessionError: true, error: cls.label };
      }
      if (cls.category !== 'conflict') {
        await reportServerError('SetCaptchaToken', resp.status, cls.category, cls.label);
      }
      return { ok: false, error: cls.label, status: resp.status, category: cls.category };
    }

    if (resp.redirected) return { ok: true, redirectUrl: resp.url };

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/javascript')) {
      const data = await resp.json().catch(() => null);
      if (!data) return { ok: false, error: 'JSON vide ou malformé' };

      // Chercher signal rate-limit dans le corps JSON
      const bodyText = JSON.stringify(data);
      if (containsRateLimitSignal(bodyText)) {
        await reportRateLimit('SetCaptchaToken-body', `Corps JSON: ${bodyText.slice(0, 80)}`);
        return { ok: false, rateLimited: true, error: 'Rate-limit dans corps JSON' };
      }

      if (data?.redirectUrl) return { ok: true, redirectUrl: data.redirectUrl };
      if (data?.url)         return { ok: true, redirectUrl: data.url };
      if (data?.error || data?.message) {
        const errMsg = data.error || data.message;
        if (containsRateLimitSignal(errMsg)) {
          await reportRateLimit('SetCaptchaToken-msg', errMsg);
          return { ok: false, rateLimited: true, error: errMsg };
        }
        return { ok: false, error: `Serveur: ${errMsg}` };
      }
    }

    const loc = resp.headers.get('location');
    if (loc) return { ok: true, redirectUrl: loc.startsWith('http') ? loc : `${CEV_BASE}${loc}` };
    return {
      ok: resp.ok,
      redirectUrl: resp.url !== `${CEV_BASE}/Captcha/SetCaptchaToken` ? resp.url : null,
    };
  } catch (err) {
    const msg = String(err);
    await reportServerError('SetCaptchaToken', 0, 'timeout', `Réseau: ${msg}`);
    return { ok: false, error: msg, category: 'timeout' };
  }
}

// ─── 1. PAGE CAPTCHA ──────────────────────────────────────────────────────────

async function handleCaptchaPage() {
  log('🔒 Page captcha CEV — attente widget hCaptcha…');

  // Vérifier d'abord si la page elle-même signale un rate-limit
  const pageBody = document.body?.innerText || '';
  if (containsRateLimitSignal(pageBody)) {
    await reportRateLimit('captcha-page-body', pageBody.slice(0, 120).trim());
    bg({ type: 'CEV_RESULT', result: 'rate_limited' });
    setTimeout(() => { try { window.close(); } catch {} }, 1000);
    return;
  }

  let captcha = detectHcaptchaWidget();
  let waited = 0;
  while (!captcha.found && waited < 15_000) {
    await sleep(500); waited += 500;
    captcha = detectHcaptchaWidget();
  }

  if (!captcha.found) {
    log('⚠️ Widget hCaptcha introuvable', 'warn');
    bg({ type: 'CEV_RESULT', result: 'captcha_not_found' });
    return;
  }

  log(`📤 Résolution captcha | sitekey=${captcha.sitekey.slice(0, 12)}…`);
  const resp = await bg({ type: 'SOLVE_CAPTCHA', sitekey: captcha.sitekey, siteUrl: window.location.href });

  if (!resp?.ok) {
    log(`❌ Résolution échouée: ${resp?.error || 'inconnu'}`, 'error');
    bg({ type: 'CEV_RESULT', result: 'captcha_failed' });
    return;
  }

  const token = resp.token;
  log('✅ Token captcha reçu — callback natif…');

  const callbackTriggered = triggerNativeCallback(token);
  log(`${callbackTriggered ? '✅ Callback natif déclenché' : '⚠️ Pas de callback natif — POST direct'}`);

  if (callbackTriggered) {
    await sleep(rand(1500, 3000));
    const newPath = window.location.pathname.toLowerCase();
    if (!newPath.includes('integration/vow/') || newPath.includes('selectslot') || newPath.includes('noavail')) {
      log(`🔀 Redirection naturelle → ${window.location.pathname}`);
      return;
    }
    log('⚠️ Pas de redirection après callback — POST direct', 'warn');
  }

  log('📬 POST /Captcha/SetCaptchaToken');
  const result = await postSetCaptchaToken(token);

  if (result.rateLimited || result.sessionError) {
    // Déjà signalé au background via reportRateLimit / reportServerError
    bg({ type: 'CEV_RESULT', result: result.rateLimited ? 'rate_limited' : 'session_error' });
    setTimeout(() => { try { window.close(); } catch {} }, 800);
    return;
  }

  if (!result.ok || !result.redirectUrl) {
    log(`❌ SetCaptchaToken échoué: ${result.error || '?'}`, 'error');
    bg({ type: 'CEV_RESULT', result: 'captcha_post_failed' });
    return;
  }

  log(`🔀 Redirection → ${result.redirectUrl.slice(0, 80)}`);
  window.location.href = result.redirectUrl;
}

// ─── 2. NO AVAILABILITY ───────────────────────────────────────────────────────

function handleNoAvailabilityPage() {
  log('❌ NoAvailability — aucun créneau');
  bg({ type: 'CEV_RESULT', result: 'no_availability' });
  setTimeout(() => { try { window.close(); } catch {} }, 1500);
}

// ─── 3. RATE LIMIT / BLOCKED PAGE ────────────────────────────────────────────

async function handleRateLimitPage(reason) {
  log(`🚫 Page de blocage CEV détectée — ${reason}`, 'error');
  await reportRateLimit('error-page', reason);
  bg({ type: 'CEV_RESULT', result: 'rate_limited' });
  setTimeout(() => { try { window.close(); } catch {} }, 1000);
}

// ─── 4. SELECT SLOT — DÉTECTION UNIQUEMENT ────────────────────────────────────

async function fetchFirstAvailableSlot() {
  const now  = new Date();
  const body = JSON.stringify({ month: now.getMonth() + 1, year: now.getFullYear() });
  try {
    const resp = await fetch(`${CEV_BASE}/Home/AvailableTimeSlots`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'fr-BE,fr;q=0.9',
      },
      body,
    });

    const cls = classifyStatus(resp.status);
    if (cls) {
      if (cls.category === 'rate_limited') {
        await reportRateLimit('AvailableTimeSlots', cls.label);
        return { rateLimited: true };
      }
      if (cls.category === 'session') {
        await reportServerError('AvailableTimeSlots', resp.status, 'session', cls.label);
        return { sessionError: true };
      }
      if (cls.category === 'conflict') {
        log('⚠️ 409 Conflict — slot pris entre-temps, on continue', 'warn');
        return null;
      }
      await reportServerError('AvailableTimeSlots', resp.status, cls.category, cls.label);
      return { serverError: true, category: cls.category };
    }

    const data = await resp.json().catch(() => null);
    if (!data) {
      log('⚠️ AvailableTimeSlots : réponse JSON vide', 'warn');
      return null;
    }

    // Chercher signal rate-limit dans le corps
    const bodyStr = JSON.stringify(data);
    if (containsRateLimitSignal(bodyStr)) {
      await reportRateLimit('AvailableTimeSlots-body', bodyStr.slice(0, 120));
      return { rateLimited: true };
    }

    const items = Array.isArray(data)               ? data
                : Array.isArray(data.slots)          ? data.slots
                : Array.isArray(data.availableSlots) ? data.availableSlots
                : [];

    const available = items.filter(s =>
      s.available !== false && s.Available !== false && s.isAvailable !== false
    );
    if (!available.length) return null;

    const first = available[0];
    return {
      date:  first.date  ?? first.Date  ?? first.day       ?? first.Day   ?? '',
      time:  first.time  ?? first.Time  ?? first.hour       ?? first.Hour  ?? first.startTime ?? '',
      id:    first.id    ?? first.Id    ?? first.slotId     ?? first.appointmentId ?? null,
      count: available.length,
    };
  } catch (err) {
    await reportServerError('AvailableTimeSlots', 0, 'timeout', `Réseau: ${err}`);
    return { serverError: true, category: 'timeout' };
  }
}

async function handleSelectSlotPage() {
  log('🔍 SelectSlot — scan disponibilités (détection uniquement)');
  await sleep(rand(800, 1500));

  // Vérifier rate-limit sur la page avant toute requête
  const pageBody = document.body?.innerText || '';
  if (containsRateLimitSignal(pageBody)) {
    await handleRateLimitPage(pageBody.slice(0, 120).trim());
    return;
  }

  log('📡 POST /Home/AvailableTimeSlots');
  const slot = await fetchFirstAvailableSlot();

  if (!slot) {
    // null = pas de slot, pas d'erreur
    log('❌ Aucun créneau disponible', 'warn');
    bg({ type: 'CEV_RESULT', result: 'no_availability' });
    setTimeout(() => { try { window.close(); } catch {} }, 1500);
    return;
  }

  // Erreurs remontées au background via reportRateLimit/reportServerError — fermer l'onglet
  if (slot.rateLimited || slot.serverError || slot.sessionError) {
    const result = slot.rateLimited ? 'rate_limited'
                 : slot.sessionError ? 'session_error'
                 : 'server_error';
    bg({ type: 'CEV_RESULT', result });
    setTimeout(() => { try { window.close(); } catch {} }, 800);
    return;
  }

  // Slot trouvé !
  log(`🚨 SLOT TROUVÉ: ${slot.date} ${slot.time} (${slot.count} dispo, id=${slot.id})`, 'ok');
  await bg({
    type: 'SLOT_FOUND',
    slot: { date: slot.date, time: slot.time, id: slot.id, count: slot.count },
  });
  setTimeout(() => { try { window.close(); } catch {} }, 1000);
}

// ─── 5. SESSION EXPIRÉE ───────────────────────────────────────────────────────

function handleSessionExpiredPage() {
  log('⏱ Session CEV expirée', 'warn');
  bg({ type: 'CEV_RESULT', result: 'session_expired' });
  setTimeout(() => { try { window.close(); } catch {} }, 1200);
}

// ─── Routeur ──────────────────────────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname.toLowerCase();
  const body = document.body?.innerText?.toLowerCase() || '';

  // Rate-limit / blocage — priorité haute
  if (isRateLimitUrl(window.location.href) || containsRateLimitSignal(body)) {
    return 'rate_limited';
  }

  if (path.includes('/integration/error/sessionexpired') || path.includes('expired'))
    return 'session_expired';

  if (path.includes('/integration/error/noavail') ||
      path.includes('noavailability') ||
      /aucune\s+disponibilit|no\s+availability|geen\s+beschikbaar/.test(body))
    return 'no_availability';

  if (path.includes('/integration/vow/selectslot') ||
      path.includes('selectslot') || path.includes('select-slot') ||
      path.includes('calendar') || path.includes('calendrier') ||
      document.querySelector('table.calendar, .fc-view, [class*="calendar"]'))
    return 'select_slot';

  if ((path.includes('/integration/vow/') && !path.includes('/selectslot') && !path.includes('/error/')) ||
      path.includes('/captcha/') ||
      document.querySelector(`[data-sitekey="${SITEKEY}"], [data-sitekey], iframe[src*="hcaptcha.com"]`))
    return 'captcha';

  return 'unknown';
}

async function init() {
  await sleep(rand(700, 1500));

  const type = detectPageType();
  log(`📄 CEV ${type} @ ${window.location.pathname.slice(0, 60)}`);

  switch (type) {
    case 'rate_limited':    await handleRateLimitPage(`URL: ${window.location.pathname}`); break;
    case 'captcha':         await handleCaptchaPage();       break;
    case 'no_availability':      handleNoAvailabilityPage(); break;
    case 'select_slot':     await handleSelectSlotPage();    break;
    case 'session_expired':      handleSessionExpiredPage(); break;
    default:
      log('❓ Type inconnu — réévaluation dans 3s');
      await sleep(3000);
      const type2 = detectPageType();
      if (type2 !== 'unknown') init();
  }
}

if (document.readyState === 'complete') { init(); }
else { window.addEventListener('load', init, { once: true }); }
