/**
 * content-cev.js — appointment.cloud.diplomatie.be
 *
 * v3.0 — MODE DÉTECTION UNIQUEMENT
 *  - Aucune réservation automatique.
 *  - Lorsqu'un slot disponible est détecté → SLOT_FOUND envoyé au background.
 *  - Le background déclenche la sonnerie + notification répétée.
 *  - Après captcha : détection complète des erreurs serveur et 4xx/5xx.
 *  - Fonctionne en arrière-plan (onglet invisible ou navigateur minimisé).
 */

'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function bg(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }
function log(msg, level = 'info') { bg({ type: 'LOG', level, msg }); }

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';
const SITEKEY  = '5f64399c-14a8-415e-ad1a-7ebccdc4943a';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Classifie une réponse HTTP en catégorie d'erreur.
 * Retourne null si la réponse est OK.
 */
function classifyHttpError(status) {
  if (status >= 200 && status < 300) return null;
  if (status === 400) return '400 Bad Request — paramètre invalide';
  if (status === 401) return '401 Unauthorized — session expirée ou token invalide';
  if (status === 403) return '403 Forbidden — accès refusé (WAF ou session CEV révoquée)';
  if (status === 404) return '404 Not Found — endpoint introuvable';
  if (status === 408) return '408 Request Timeout — serveur CEV lent';
  if (status === 409) return '409 Conflict — slot déjà pris entre-temps';
  if (status === 410) return '410 Gone — session CEV expirée définitivement';
  if (status === 422) return '422 Unprocessable — données de captcha rejetées';
  if (status === 429) return '429 Too Many Requests — rate-limit CEV atteint';
  if (status >= 400 && status < 500) return `${status} Erreur client`;
  if (status === 500) return '500 Internal Server Error — panne serveur CEV';
  if (status === 502) return '502 Bad Gateway — infrastructure CEV temporairement down';
  if (status === 503) return '503 Service Unavailable — maintenance ou surcharge CEV';
  if (status === 504) return '504 Gateway Timeout — timeout serveur CEV';
  if (status >= 500) return `${status} Erreur serveur CEV`;
  return `HTTP ${status} inattendu`;
}

/**
 * POST /Captcha/SetCaptchaToken avec détection complète des erreurs serveur et 4xx/5xx.
 */
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

    // Détecter toutes les erreurs HTTP avant de traiter la réponse
    const httpError = classifyHttpError(resp.status);
    if (httpError) {
      log(`❌ SetCaptchaToken — ${httpError}`, 'error');
      return { ok: false, error: httpError, status: resp.status };
    }

    if (resp.redirected) {
      return { ok: true, redirectUrl: resp.url };
    }

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/javascript')) {
      const data = await resp.json().catch(() => null);
      if (!data) {
        return { ok: false, error: 'Réponse JSON vide ou malformée' };
      }
      if (data?.redirectUrl) return { ok: true, redirectUrl: data.redirectUrl };
      if (data?.url)         return { ok: true, redirectUrl: data.url };
      if (data?.error || data?.message) {
        return { ok: false, error: `Serveur: ${data.error || data.message}` };
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
    if (msg.includes('fetch')) log(`❌ SetCaptchaToken réseau: ${msg}`, 'error');
    return { ok: false, error: msg };
  }
}

// ─── 1. PAGE CAPTCHA ──────────────────────────────────────────────────────────

async function handleCaptchaPage() {
  log('🔒 Page captcha CEV — attente widget hCaptcha…');

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

  if (!result.ok || !result.redirectUrl) {
    const errDetail = result.error || `HTTP ${result.status || '?'} — pas de redirectUrl`;
    log(`❌ SetCaptchaToken échoué: ${errDetail}`, 'error');

    // Erreurs récupérables : relancer depuis le début
    if (result.status === 429 || result.status === 503 || result.status === 502) {
      log(`⚠️ Erreur temporaire (${result.status}) — le background relancera`, 'warn');
    }
    // Erreurs de session : signaler explicitement
    if (result.status === 401 || result.status === 403 || result.status === 410) {
      log(`⚠️ Session CEV invalide (${result.status}) — recaptcha nécessaire`, 'warn');
    }

    bg({ type: 'CEV_RESULT', result: 'captcha_post_failed' });
    return;
  }

  log(`🔀 Redirection vers: ${result.redirectUrl.slice(0, 80)}`);
  window.location.href = result.redirectUrl;
}

// ─── 2. NO AVAILABILITY ───────────────────────────────────────────────────────

function handleNoAvailabilityPage() {
  log('❌ NoAvailability — aucun créneau pour ce compte');
  bg({ type: 'CEV_RESULT', result: 'no_availability' });
  setTimeout(() => { try { window.close(); } catch {} }, 1500);
}

// ─── 3. SELECT SLOT — DÉTECTION UNIQUEMENT, PAS DE RÉSERVATION ───────────────

/**
 * POST /Home/AvailableTimeSlots avec détection complète des erreurs.
 */
async function fetchFirstAvailableSlot() {
  const now = new Date();
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

    const httpError = classifyHttpError(resp.status);
    if (httpError) {
      log(`⚠️ AvailableTimeSlots — ${httpError}`, 'warn');
      // 409 = slot pris entre-temps, 429 = rate-limit → signaler mais ne pas planter
      if (resp.status === 409) log('⚠️ Conflit : slot peut-être déjà pris', 'warn');
      if (resp.status === 429) log('⚠️ Rate-limit CEV — pause nécessaire', 'warn');
      return null;
    }

    const data = await resp.json().catch(() => null);
    if (!data) {
      log('⚠️ AvailableTimeSlots : réponse JSON vide ou malformée', 'warn');
      return null;
    }

    const items = Array.isArray(data)                  ? data
                : Array.isArray(data.slots)             ? data.slots
                : Array.isArray(data.availableSlots)    ? data.availableSlots
                : [];

    const available = items.filter(s =>
      s.available !== false && s.Available !== false && s.isAvailable !== false
    );
    if (!available.length) return null;

    const first = available[0];
    return {
      date:  first.date  ?? first.Date  ?? first.day   ?? first.Day   ?? '',
      time:  first.time  ?? first.Time  ?? first.hour  ?? first.Hour  ?? first.startTime ?? '',
      id:    first.id    ?? first.Id    ?? first.slotId ?? first.appointmentId ?? null,
      count: available.length,
      raw:   first,
    };
  } catch (err) {
    log(`⚠️ AvailableTimeSlots réseau: ${err}`, 'warn');
    return null;
  }
}

/**
 * Scan les créneaux via l'API et le DOM.
 * En cas de slot trouvé → notifie le background, ferme l'onglet CEV.
 * Ne tente JAMAIS de réserver.
 */
async function handleSelectSlotPage() {
  log('🔍 Page SelectSlot — scan des disponibilités (mode détection uniquement)');
  await sleep(rand(800, 1500));

  // ── Stratégie 1 : API /Home/AvailableTimeSlots ────────────────────────────
  log('📡 POST /Home/AvailableTimeSlots');
  const slot = await fetchFirstAvailableSlot();

  if (slot) {
    log(`🚨 SLOT TROUVÉ via API: ${slot.date} ${slot.time} (${slot.count} dispo, id=${slot.id})`, 'ok');
    await bg({
      type: 'SLOT_FOUND',
      slot: { date: slot.date, time: slot.time, id: slot.id, count: slot.count },
    });
    // Fermer l'onglet CEV — la sonnerie s'en charge côté background
    setTimeout(() => { try { window.close(); } catch {} }, 1000);
    return;
  }

  // ── Stratégie 2 : scan DOM du calendrier ─────────────────────────────────
  log('🔍 API vide — scan DOM calendrier');
  const domSlotFound = await scanCalendarDom();

  if (domSlotFound) {
    log(`🚨 SLOT TROUVÉ via DOM calendrier`, 'ok');
    await bg({
      type: 'SLOT_FOUND',
      slot: { date: domSlotFound.date, time: null, id: null, count: 1 },
    });
    setTimeout(() => { try { window.close(); } catch {} }, 1000);
    return;
  }

  log('❌ Aucun créneau disponible cette fois', 'warn');
  bg({ type: 'CEV_RESULT', result: 'no_availability' });
  setTimeout(() => { try { window.close(); } catch {} }, 1500);
}

/**
 * Scanne le DOM du calendrier pour détecter un jour disponible.
 * Retourne { date } si trouvé, null sinon.
 * Ne clique sur rien.
 */
async function scanCalendarDom() {
  const daySelectors = [
    'td.available a', 'td.open a', '.calendar-day.available a',
    '[data-available="true"] a', '.fc-day:not(.fc-day-disabled) a',
    'td:not(.disabled):not(.unavailable):not(.empty):not(.weekend) a',
    'td.selectable a', 'td.day:not(.disabled) a',
  ];

  for (const sel of daySelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const dateText = el.textContent?.trim()
                    || el.getAttribute('data-date')
                    || el.closest('td')?.getAttribute('data-date')
                    || '?';
      return { date: dateText, selector: sel };
    }
  }

  // Essayer le mois suivant (sans cliquer, juste vérifier si un "suivant" existe)
  const nextBtn = document.querySelector('.next, .btn-next, [aria-label*="next"], .fc-next-button');
  if (nextBtn) {
    log('⏭ Bouton mois suivant détecté — note pour futur scan');
  }

  return null;
}

// ─── 4. SESSION EXPIRÉE ───────────────────────────────────────────────────────

function handleSessionExpiredPage() {
  log('⏱ Session CEV expirée — signalement background', 'warn');
  bg({ type: 'CEV_RESULT', result: 'session_expired' });
  setTimeout(() => { try { window.close(); } catch {} }, 1200);
}

// ─── Routeur ──────────────────────────────────────────────────────────────────

function detectPageType() {
  const path = window.location.pathname.toLowerCase();
  const body = document.body?.innerText?.toLowerCase() || '';

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
