/**
 * content-cev.js — appointment.cloud.diplomatie.be
 *
 * Basé sur les captures HTTP réelles (capture-1780347172859.json + cevHttpSetup.ts + cevHttpBooking.ts).
 *
 * Flux réel :
 *  1. /Integration/VOW/{ids}/en-US → page avec hCaptcha (sitekey 5f64399c…)
 *  2. Anti-Captcha résout → token P1_eyJ…
 *  3. POST /Captcha/SetCaptchaToken  { captcha: token }  (XHR, x-requested-with: XMLHttpRequest)
 *     → JSON { redirectUrl, validUntil } → navigate vers redirectUrl
 *  4. /Integration/VOW/SelectSlot → calendrier → POST /Home/AvailableTimeSlots → book
 *     /Integration/Error/NoAvailability → signaler → fermer l'onglet
 *
 * La page a son propre callback hCaptcha (data-callback) qui fait le POST SetCaptchaToken.
 * On essaie d'abord de déclencher ce callback natif ; si absent, on fait le fetch nous-mêmes.
 */

'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function bg(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }
function log(msg, level = 'info') { bg({ type: 'LOG', level, msg }); }

const CEV_BASE     = 'https://appointment.cloud.diplomatie.be';
const SITEKEY      = '5f64399c-14a8-415e-ad1a-7ebccdc4943a'; // hardcodé, confirmé dans cevHttpSetup.ts

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function humanClick(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(rand(300, 600));
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, button: 0,
    clientX: rect.left + rect.width  * (0.3 + Math.random() * 0.4),
    clientY: rect.top  + rect.height * (0.3 + Math.random() * 0.4),
  };
  el.dispatchEvent(new MouseEvent('mouseover',  opts));
  await sleep(rand(40, 80));
  el.dispatchEvent(new MouseEvent('mousedown',  opts));
  await sleep(rand(60, 130));
  el.dispatchEvent(new MouseEvent('mouseup',    opts));
  await sleep(rand(10, 30));
  el.click();
}

// ─── 1. PAGE CAPTCHA  (/Integration/VOW/{ids} ou /Captcha/) ──────────────────

function detectHcaptchaWidget() {
  const widget = document.querySelector(`[data-sitekey="${SITEKEY}"], [data-sitekey]`);
  if (widget) return { found: true, sitekey: widget.getAttribute('data-sitekey'), widget };

  for (const iframe of document.querySelectorAll('iframe')) {
    const m = (iframe.src || '').match(/[?&]sitekey=([^&]+)/);
    if (m && iframe.src.includes('hcaptcha.com')) return { found: true, sitekey: m[1], widget: iframe };
  }
  return { found: false };
}

/**
 * Injecte le token dans la textarea standard ET essaie de déclencher
 * le callback natif de la page (qui fera lui-même le POST SetCaptchaToken).
 */
function triggerNativeCallback(token) {
  // 1. Textarea standard
  for (const name of ['h-captcha-response', 'g-recaptcha-response', 'captcha']) {
    const ta = document.querySelector(`textarea[name="${name}"]`);
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, token); else ta.value = token;
      ta.dispatchEvent(new Event('input',  { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // 2. data-callback sur le widget
  const widget = document.querySelector('[data-callback]');
  const cbName = widget?.getAttribute('data-callback');
  if (cbName && typeof window[cbName] === 'function') {
    try { window[cbName](token); return true; } catch {}
  }

  // 3. hcaptcha global
  if (window.hcaptcha) {
    try {
      const widgetId = document.querySelector('[data-hcaptcha-widget-id]')?.getAttribute('data-hcaptcha-widget-id');
      if (widgetId) { window.hcaptcha.execute(widgetId, { token }); return true; }
    } catch {}
  }
  return false;
}

/**
 * POST direct à /Captcha/SetCaptchaToken — identique au vrai flux navigateur.
 * Retourne { ok, redirectUrl } ou { ok: false, error }.
 *
 * Headers reproduits depuis capture-1780347172859.json (req 249) :
 *  - Content-Type: application/x-www-form-urlencoded
 *  - X-Requested-With: XMLHttpRequest
 *  - Accept: *‌/*
 */
async function postSetCaptchaToken(token) {
  try {
    const resp = await fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: 'POST',
      credentials: 'include',      // envoie automatiquement ASP.NET_SessionId + F5 cookie
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': '*/*',
        'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8',
      },
      body: `captcha=${encodeURIComponent(token)}`,
    });

    // La réponse peut être un JSON {redirectUrl, validUntil} ou une redirection 302
    if (resp.redirected) {
      return { ok: true, redirectUrl: resp.url };
    }

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/javascript')) {
      const data = await resp.json().catch(() => null);
      if (data?.redirectUrl) return { ok: true, redirectUrl: data.redirectUrl };
      if (data?.url)         return { ok: true, redirectUrl: data.url };
    }

    // Fallback : le serveur a pu nous rediriger dans le Location header
    const loc = resp.headers.get('location');
    if (loc) return { ok: true, redirectUrl: loc.startsWith('http') ? loc : `${CEV_BASE}${loc}` };

    // Dernier recours : inspecter l'URL finale si redirect:follow
    return { ok: resp.ok, redirectUrl: resp.url !== `${CEV_BASE}/Captcha/SetCaptchaToken` ? resp.url : null };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function handleCaptchaPage() {
  log('🔒 Page captcha CEV détectée — attente du widget hCaptcha…');

  // Attendre que le widget soit chargé (max 15s)
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

  log(`📤 Envoi résolution | sitekey=${captcha.sitekey.slice(0, 12)}… | url=${window.location.href.slice(0, 60)}`);
  const resp = await bg({ type: 'SOLVE_CAPTCHA', sitekey: captcha.sitekey, siteUrl: window.location.href });

  if (!resp?.ok) {
    log(`❌ Résolution échouée: ${resp?.error || 'inconnu'}`, 'error');
    bg({ type: 'CEV_RESULT', result: 'captcha_failed' });
    return;
  }

  const token = resp.token;
  log('✅ Token reçu — tentative callback natif');

  const callbackTriggered = triggerNativeCallback(token);
  log(`${callbackTriggered ? '✅ Callback natif déclenché' : '⚠️ Pas de callback natif — POST direct'}`);

  if (callbackTriggered) {
    // Attendre la redirection naturelle (max 12s)
    await sleep(rand(1500, 3000));
    const newPath = window.location.pathname.toLowerCase();
    if (!newPath.includes('integration/vow/') || newPath.includes('selectslot') || newPath.includes('noavail')) {
      log(`🔀 Redirection naturelle → ${window.location.pathname}`);
      return; // la page se redirigeait déjà → les autres handlers prendront le relais
    }
    log('⚠️ Pas de redirection après callback — POST direct en fallback', 'warn');
  }

  // POST direct SetCaptchaToken
  log('📬 POST /Captcha/SetCaptchaToken');
  const result = await postSetCaptchaToken(token);

  if (!result.ok || !result.redirectUrl) {
    log(`❌ SetCaptchaToken échoué: ${result.error || 'pas de redirectUrl'}`, 'error');
    bg({ type: 'CEV_RESULT', result: 'captcha_post_failed' });
    return;
  }

  log(`🔀 Redirection vers: ${result.redirectUrl.slice(0, 80)}`);
  window.location.href = result.redirectUrl;
  // La page va se recharger — les handlers suivants s'occuperont du reste
}

// ─── 2. NO AVAILABILITY  (/Integration/Error/NoAvailability) ─────────────────

function handleNoAvailabilityPage() {
  log('❌ NoAvailability — aucun créneau pour ce compte à cette heure');
  bg({ type: 'CEV_RESULT', result: 'no_availability' });
  setTimeout(() => { try { window.close(); } catch {} }, 1500);
}

// ─── 3. SELECT SLOT  (/Integration/VOW/SelectSlot) ───────────────────────────

/**
 * Appelle POST /Home/AvailableTimeSlots — endpoint découvert dans cevHttpBooking.ts.
 * Retourne le premier slot disponible ou null.
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
    if (!resp.ok) { log(`⚠️ AvailableTimeSlots HTTP ${resp.status}`, 'warn'); return null; }
    const data = await resp.json().catch(() => null);
    if (!data) return null;

    // La réponse peut être tableau direct ou { slots: [...] }
    const items = Array.isArray(data) ? data
      : Array.isArray(data.slots)     ? data.slots
      : Array.isArray(data.availableSlots) ? data.availableSlots
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
      raw:   first,
    };
  } catch (err) {
    log(`⚠️ fetchFirstAvailableSlot erreur: ${err}`, 'warn');
    return null;
  }
}

/**
 * Extrait les champs cachés du form SelectSlot (anti-forgery token, etc.)
 */
function extractHiddenInputs() {
  const out = {};
  document.querySelectorAll('input[type="hidden"]').forEach(el => {
    if (el.name) out[el.name] = el.value || '';
  });
  return out;
}

async function handleSelectSlotPage() {
  log('🟢 Page SelectSlot — recherche des créneaux disponibles');
  await sleep(rand(1000, 2000));

  // ── Stratégie 1 : POST /Home/AvailableTimeSlots (HTTP pur, le plus fiable) ──
  log('📡 POST /Home/AvailableTimeSlots');
  const slot = await fetchFirstAvailableSlot();

  if (slot) {
    log(`📅 Slot trouvé: ${slot.date} ${slot.time} (id=${slot.id})`);

    // Chercher le form de sélection sur la page
    const form = document.querySelector('form[method="post"], form[method="POST"]');
    if (form) {
      const csrf    = extractHiddenInputs();
      const action  = form.action || `${CEV_BASE}/Integration/VOW/SelectSlot`;

      // Remplir les champs du slot dans le form
      const dateFields = ['selectedDate', 'SelectedDate', 'date', 'Date', 'appointmentDate'];
      const timeFields = ['selectedTime', 'SelectedTime', 'time', 'Time', 'timeSlotId', 'slotId', 'appointmentId'];

      for (const fname of dateFields) {
        const input = form.querySelector(`[name="${fname}"]`);
        if (input) { input.value = slot.date; break; }
      }
      for (const fname of timeFields) {
        const input = form.querySelector(`[name="${fname}"]`);
        if (input) { input.value = slot.id ?? slot.time; break; }
      }

      await sleep(rand(800, 1800)); // pause "lecture" humaine
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]')
                     || document.querySelector('#btnConfirm, .btn-confirm, .btn-primary[type="submit"]');
      if (submitBtn) {
        log('🖱 Clic confirmation (form submit)');
        await humanClick(submitBtn);
        await sleep(rand(2000, 4000));
        extractAndReportConfirmation();
        return;
      }
    }

    // Fallback : essai DOM classique (clic sur créneau visible)
    await handleSelectSlotByDomClick();
    return;
  }

  // ── Stratégie 2 : clic DOM si API ne répond pas / créneau nul ──
  log('⚠️ Pas de slot via API — tentative clic calendrier DOM', 'warn');
  await handleSelectSlotByDomClick();
}

async function handleSelectSlotByDomClick() {
  // Sélecteurs de jour dispo (ordre de fiabilité décroissante)
  const daySelectors = [
    'td.available a', 'td.open a', '.calendar-day.available a',
    '[data-available="true"] a', '.fc-day:not(.fc-day-disabled) a',
    'td:not(.disabled):not(.unavailable):not(.empty):not(.weekend) a',
    'td.selectable a', 'td.day:not(.disabled) a',
  ];

  let dayEl = null;
  for (const sel of daySelectors) {
    dayEl = document.querySelector(sel);
    if (dayEl) { log(`📅 Jour DOM via: ${sel}`); break; }
  }

  if (!dayEl) {
    // Essayer le mois suivant
    const nextBtn = document.querySelector('.next, .btn-next, [aria-label*="next"], [aria-label*="suivant"], .fc-next-button');
    if (nextBtn) {
      log('⏭ Essai mois suivant…');
      await humanClick(nextBtn);
      await sleep(rand(1500, 2500));
      for (const sel of daySelectors) {
        dayEl = document.querySelector(sel);
        if (dayEl) break;
      }
    }
  }

  if (!dayEl) {
    log('❌ Calendrier vide — aucun jour disponible visible', 'error');
    bg({ type: 'CEV_RESULT', result: 'calendar_empty' });
    return;
  }

  await humanClick(dayEl);
  await sleep(rand(1200, 2000));

  // Sélectionner un horaire
  const timeSelectors = [
    '.time-slot:not(.disabled)', '.slot-time:not(.disabled)',
    'input[type="radio"]:not([disabled])', 'li.available-time',
    '[data-time]:not([disabled])', 'button.time-btn:not([disabled])',
    'a.time-slot', 'select[name*="time"] option:not([disabled])',
  ];
  let timeEl = null;
  for (const sel of timeSelectors) {
    timeEl = document.querySelector(sel);
    if (timeEl) { log(`⏰ Horaire DOM via: ${sel}`); break; }
  }
  if (timeEl) {
    if (timeEl.tagName === 'OPTION') {
      timeEl.selected = true;
      timeEl.closest('select')?.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (timeEl.type === 'radio') {
      timeEl.checked = true;
      timeEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      await humanClick(timeEl);
    }
    await sleep(rand(800, 1500));
  }

  await sleep(rand(1500, 3500));

  // Confirmer
  const confirmSelectors = [
    '#btnConfirm', 'button.btn-confirm', 'button[id*="confirm"]',
    'button.btn-primary', 'button[type="submit"]', 'input[type="submit"]',
    'a.btn-confirm', '.confirm-button',
  ];
  let confirmBtn = null;
  for (const sel of confirmSelectors) {
    confirmBtn = document.querySelector(sel);
    if (confirmBtn) break;
  }
  if (!confirmBtn) {
    for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
      const t = (btn.textContent || btn.value || '').toLowerCase();
      if (['confirm','valider','book','réserver','submit','bevestig','selectionner','sélectionner'].some(k => t.includes(k))) {
        confirmBtn = btn; break;
      }
    }
  }

  if (confirmBtn) {
    log('🖱 Clic confirmation');
    await humanClick(confirmBtn);
    await sleep(rand(2000, 4000));
    extractAndReportConfirmation();
  } else {
    log('❌ Bouton confirmation introuvable', 'error');
    bg({ type: 'CEV_RESULT', result: 'confirm_btn_not_found' });
  }
}

function extractAndReportConfirmation() {
  const bodyText = document.body.innerText;
  // Codes de confirmation typiques : REF-XXXXXX, YYYYMMDD-NNN, UUID, etc.
  const codeMatch = bodyText.match(/(?:référence|reference|code|confirmation)[^\n:]*[:\s]+([A-Z0-9\-]{6,25})/i)
                 || bodyText.match(/\b([A-Z]{2,4}[-_]?\d{5,10})\b/)
                 || bodyText.match(/\b([A-Z0-9]{8}-[A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  const confirmCode = codeMatch?.[1] || null;

  const confirmed = /confirm|success|réserv|booking|congratu|appointment confirmed/i.test(document.body.innerHTML);
  log(`${confirmed ? '🎉 Réservation confirmée !' : '⚠️ Page résultat ambiguë'} | code=${confirmCode || 'non trouvé'}`, confirmed ? 'ok' : 'warn');
  bg({ type: 'CEV_RESULT', result: 'success', confirmationCode: confirmCode });
}

// ─── 4. SESSION EXPIRÉE ───────────────────────────────────────────────────────

function handleSessionExpiredPage() {
  log('⏱ Session CEV expirée (15 min écoulées) — signalement au background', 'warn');
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

  // Page captcha : URL d'intégration (/Integration/VOW/{ids}) OU la page VOWINT avec hCaptcha
  if (path.includes('/integration/vow/') && !path.includes('/selectslot') && !path.includes('/error/') ||
      path.includes('/captcha/') ||
      document.querySelector(`[data-sitekey="${SITEKEY}"], [data-sitekey], iframe[src*="hcaptcha.com"]`))
    return 'captcha';

  return 'unknown';
}

async function init() {
  await sleep(rand(700, 1500)); // attente rendu page

  const type = detectPageType();
  log(`📄 CEV ${type} @ ${window.location.pathname.slice(0, 60)}`);

  switch (type) {
    case 'captcha':        await handleCaptchaPage();        break;
    case 'no_availability':     handleNoAvailabilityPage();  break;
    case 'select_slot':    await handleSelectSlotPage();     break;
    case 'session_expired':     handleSessionExpiredPage();  break;
    default:
      // Peut arriver sur la page d'intégration avant redirection — réessayer dans 3s
      log(`❓ Type inconnu — réévaluation dans 3s`);
      await sleep(3000);
      const type2 = detectPageType();
      if (type2 !== 'unknown') { init(); }
  }
}

if (document.readyState === 'complete') { init(); }
else { window.addEventListener('load', init, { once: true }); }
