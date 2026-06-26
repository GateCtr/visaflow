/**
 * content-cev.js — appointment.cloud.diplomatie.be  v4.0
 *
 * MODE DÉTECTION UNIQUEMENT — Réaction intelligente aux erreurs serveur.
 *
 * Améliorations v4 :
 *   • Priority: u=1, i  sur tous les XHR (aligné Burp Chrome 146)
 *   • Accept-Language fr-BE cohérent
 *   • handleUnknownPage() : réévaluation toutes les 2s jusqu'à 20s (au lieu de 3s fixe)
 *   • Délai de fermeture onglet légèrement aléatoire (humain)
 *   • Détection rate-limit renforcée sur body AngularJS chargé tardivement
 *
 * Signaux remontés au background :
 *   RATE_LIMITED  — 429, 403 WAF, URL /Error/*, mots-clés body
 *   SERVER_ERROR  — 5xx avec classification (down, timeout, conflict, session)
 *   CEV_RESULT    — no_availability, slot_found, captcha_*
 *   SLOT_FOUND    — créneau disponible
 */

'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function bg(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }
function log(msg, level = 'info') { bg({ type: 'LOG', level, msg }); }

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';
const SITEKEY  = '5f64399c-14a8-415e-ad1a-7ebccdc4943a';

// ─── Rate-limit patterns ──────────────────────────────────────────────────────

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

function containsRateLimitSignal(text) {
  if (!text) return false;
  return RATE_LIMIT_PATTERNS.some(re => re.test(text));
}

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

async function reportRateLimit(source, reason) {
  log(`🚫 RATE-LIMIT [${source}] — ${reason}`, 'error');
  await bg({ type: 'RATE_LIMITED', source, reason });
}

async function reportServerError(source, status, category, reason) {
  log(`⚠️ ERREUR SERVEUR ${status} [${source}] ${category} — ${reason}`, 'error');
  await bg({ type: 'SERVER_ERROR', source, status, category, reason });
}

// ─── Classification HTTP ──────────────────────────────────────────────────────

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
  if (status >= 500)                 return { label: `${status} Erreur serveur`, category: 'down'    };
  return { label: `HTTP ${status}`, category: 'generic' };
}

// ─── Helpers XHR avec Priority header ────────────────────────────────────────

/**
 * Headers XHR alignés Burp Chrome 146 — Priority: u=1, i sur tous les XHR.
 */
function xhrHeaders(extra = {}) {
  return {
    'X-Requested-With':  'XMLHttpRequest',
    'Accept-Language':   'fr-BE,fr;q=0.9,en-US;q=0.8',
    'Priority':          'u=1, i',
    ...extra,
  };
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
  const widget = document.querySelector('[data-callback]');
  const cbName = widget?.getAttribute('data-callback');
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
      headers: xhrHeaders({
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept':       '*/*',
      }),
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

  // Vérifier rate-limit dans le body
  const pageBody = document.body?.innerText || '';
  if (containsRateLimitSignal(pageBody)) {
    await reportRateLimit('captcha-page-body', pageBody.slice(0, 120).trim());
    bg({ type: 'CEV_RESULT', result: 'rate_limited' });
    setTimeout(() => { try { window.close(); } catch {} }, rand(800, 1400));
    return;
  }

  let captcha = detectHcaptchaWidget();
  let waited  = 0;
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
  log(`${callbackTriggered ? '✅ Callback natif déclenché' : '⚠️ Pas de callback — POST direct'}`);

  if (callbackTriggered) {
    await sleep(rand(1200, 2800));
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
    bg({ type: 'CEV_RESULT', result: result.rateLimited ? 'rate_limited' : 'session_error' });
    setTimeout(() => { try { window.close(); } catch {} }, rand(600, 1000));
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
  setTimeout(() => { try { window.close(); } catch {} }, rand(1200, 2000));
}

// ─── 3. RATE LIMIT PAGE ───────────────────────────────────────────────────────

async function handleRateLimitPage(reason) {
  log(`🚫 Page de blocage CEV — ${reason}`, 'error');
  await reportRateLimit('error-page', reason);
  bg({ type: 'CEV_RESULT', result: 'rate_limited' });
  setTimeout(() => { try { window.close(); } catch {} }, rand(800, 1400));
}

// ─── 4. SELECT SLOT ───────────────────────────────────────────────────────────

async function fetchFirstAvailableSlot() {
  const now  = new Date();
  const body = JSON.stringify({ month: now.getMonth() + 1, year: now.getFullYear() });
  try {
    const resp = await fetch(`${CEV_BASE}/Home/AvailableTimeSlots`, {
      method: 'POST',
      credentials: 'include',
      headers: xhrHeaders({
        'Content-Type': 'application/json',
        'Accept':       'application/json, text/javascript, */*; q=0.01',
      }),
      body,
    });

    const cls = classifyStatus(resp.status);
    if (cls) {
      if (cls.category === 'rate_limited') {
        await reportRateLimit('AvailableTimeSlots', cls.label); return { rateLimited: true };
      }
      if (cls.category === 'session') {
        await reportServerError('AvailableTimeSlots', resp.status, 'session', cls.label); return { sessionError: true };
      }
      if (cls.category === 'conflict') {
        log('⚠️ 409 Conflict — slot pris entre-temps', 'warn'); return null;
      }
      await reportServerError('AvailableTimeSlots', resp.status, cls.category, cls.label);
      return { serverError: true, category: cls.category };
    }

    const data = await resp.json().catch(() => null);
    if (!data) { log('⚠️ AvailableTimeSlots : réponse JSON vide', 'warn'); return null; }

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
      date:  first.date  ?? first.Date  ?? first.day  ?? first.Day   ?? '',
      time:  first.time  ?? first.Time  ?? first.hour ?? first.Hour  ?? first.startTime ?? '',
      id:    first.id    ?? first.Id    ?? first.slotId ?? first.appointmentId ?? null,
      count: available.length,
    };
  } catch (err) {
    await reportServerError('AvailableTimeSlots', 0, 'timeout', `Réseau: ${err}`);
    return { serverError: true, category: 'timeout' };
  }
}

async function handleSelectSlotPage() {
  log('🔍 SelectSlot — scan disponibilités');
  await sleep(rand(700, 1400));

  // Rate-limit sur la page avant requête
  const pageBody = document.body?.innerText || '';
  if (containsRateLimitSignal(pageBody)) {
    await handleRateLimitPage(pageBody.slice(0, 120).trim()); return;
  }

  log('📡 POST /Home/AvailableTimeSlots');
  const slot = await fetchFirstAvailableSlot();

  if (!slot) {
    log('❌ Aucun créneau disponible', 'warn');
    bg({ type: 'CEV_RESULT', result: 'no_availability' });
    setTimeout(() => { try { window.close(); } catch {} }, rand(1200, 2000));
    return;
  }

  if (slot.rateLimited || slot.serverError || slot.sessionError) {
    const result = slot.rateLimited  ? 'rate_limited'
                 : slot.sessionError ? 'session_error'
                 : 'server_error';
    bg({ type: 'CEV_RESULT', result });
    setTimeout(() => { try { window.close(); } catch {} }, rand(700, 1100));
    return;
  }

  log(`🚨 SLOT TROUVÉ: ${slot.date} ${slot.time} (${slot.count} dispo, id=${slot.id})`, 'ok');
  await bg({
    type: 'SLOT_FOUND',
    slot: { date: slot.date, time: slot.time, id: slot.id, count: slot.count },
  });
  setTimeout(() => { try { window.close(); } catch {} }, rand(900, 1400));
}

// ─── 5. SESSION EXPIRÉE ───────────────────────────────────────────────────────

function handleSessionExpiredPage() {
  log('⏱ Session CEV expirée', 'warn');
  bg({ type: 'CEV_RESULT', result: 'session_expired' });
  setTimeout(() => { try { window.close(); } catch {} }, rand(1000, 1600));
}

// ─── Routeur ──────────────────────────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname.toLowerCase();
  const body = document.body?.innerText?.toLowerCase() || '';

  if (isRateLimitUrl(window.location.href) || containsRateLimitSignal(body))
    return 'rate_limited';

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
  await sleep(rand(600, 1300));

  const type = detectPageType();
  log(`📄 CEV [${type}] @ ${window.location.pathname.slice(0, 60)}`);

  switch (type) {
    case 'rate_limited':    await handleRateLimitPage(`URL: ${window.location.pathname}`); break;
    case 'captcha':         await handleCaptchaPage();       break;
    case 'no_availability':      handleNoAvailabilityPage(); break;
    case 'select_slot':     await handleSelectSlotPage();    break;
    case 'session_expired':      handleSessionExpiredPage(); break;
    default: {
      // Réévaluer toutes les 2s jusqu'à 20s (JS peut charger tardivement)
      let tries = 0;
      const MAX_TRIES = 10;
      const retry = async () => {
        await sleep(2_000);
        tries++;
        const type2 = detectPageType();
        if (type2 !== 'unknown') {
          log(`📄 CEV [${type2}] détecté après ${tries * 2}s`);
          init();
        } else if (tries < MAX_TRIES) {
          retry();
        } else {
          log('❓ Type CEV inconnu après 20s — abandon', 'warn');
        }
      };
      retry();
    }
  }
}

if (document.readyState === 'complete') { init(); }
else { window.addEventListener('load', init, { once: true }); }
