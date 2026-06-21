/**
 * content.js — Script injecté sur appointment.cloud.diplomatie.be
 *
 * Responsabilités :
 *  1. Détection et résolution automatique du hCaptcha via Anti-Captcha
 *  2. Polling /Home/AvailableTimeSlots avec délais aléatoires anti-détection
 *  3. Simulation comportement humain (mouse events, scroll, pauses)
 *  4. Booking automatique quand créneaux détectés
 *  5. Gestion des sessions (pause forcée après 90min, repos 45min)
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';

/** Délai entre chaque poll (ms) — aléatoire 3 à 5 minutes */
const POLL_MIN_MS = 3 * 60_000;
const POLL_MAX_MS = 5 * 60_000;

/** Durée max d'une session avant pause forcée (90 min) */
const SESSION_MAX_MS = 90 * 60_000;

/** Durée de la pause forcée (45 min) */
const SESSION_PAUSE_MS = 45 * 60_000;

/** Limite de clics par heure (sécurité serveur : max 5, on reste à 4) */
const MAX_CLICKS_PER_HOUR = 4;

// ─── État local ───────────────────────────────────────────────────────────────

let running = false;
let sessionStartTs = 0;
let clickTimestamps = [];
let pollCount = 0;
let captchaPending = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
    } catch {
      resolve(null);
    }
  });
}

function statusLog(msg, level = 'info') {
  sendToBackground({ type: 'STATUS_UPDATE', status: 'running', log: msg, logLevel: level });
}

// ─── Anti-détection : Simulation comportement humain ─────────────────────────

/**
 * Simule un mouvement de souris réaliste vers un élément avant de cliquer.
 * Déclenche mouseover → mousemove → mouseenter → mousedown → mouseup → click
 * avec un délai humain entre chaque event.
 */
async function humanClick(element) {
  if (!element) return;

  const rect = element.getBoundingClientRect();
  // Point de clic légèrement aléatoire dans l'élément (pas exactement le centre)
  const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
  const y = rect.top  + rect.height * (0.3 + Math.random() * 0.4);

  const evtInit = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    screenX: x + window.screenX,
    screenY: y + window.screenY,
    button: 0,
    buttons: 1,
  };

  // 1. Arrivée de la souris
  element.dispatchEvent(new MouseEvent('mouseover', evtInit));
  element.dispatchEvent(new MouseEvent('mouseenter', evtInit));
  await sleep(randomDelay(40, 120));

  // 2. Mouvement sur l'élément
  element.dispatchEvent(new MouseEvent('mousemove', evtInit));
  await sleep(randomDelay(20, 80));

  // 3. Appui
  element.dispatchEvent(new MouseEvent('mousedown', evtInit));
  await sleep(randomDelay(60, 150));

  // 4. Relâchement + clic
  element.dispatchEvent(new MouseEvent('mouseup', evtInit));
  await sleep(randomDelay(10, 40));
  element.dispatchEvent(new MouseEvent('click', evtInit));
}

/**
 * Simule un petit scroll aléatoire (bruit humain).
 * Un humain ne reste pas immobile sur la page.
 */
async function injectScrollNoise() {
  const scrollAmount = randomDelay(80, 300);
  window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
  await sleep(randomDelay(800, 2000));
  window.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
  await sleep(randomDelay(500, 1500));
}

/**
 * Simule une pause "lecture" sur la page (l'humain lit les infos).
 */
async function humanReadingPause() {
  const pauseMs = randomDelay(2_000, 7_000);
  await sleep(pauseMs);
}

// ─── Extraction du token anti-forgery ────────────────────────────────────────

function extractAntiForgeryToken() {
  // Depuis DOM d'abord (plus fiable)
  const input = document.querySelector('input[name="__RequestVerificationToken"]');
  if (input) return input.value;

  // Fallback regex sur le HTML
  const html = document.documentElement.innerHTML;
  const patterns = [
    /__RequestVerificationToken"[^>]*value="([^"]+)"/i,
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
    /value="([^"]+)"[^>]*name="__RequestVerificationToken"/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractHiddenInputs() {
  const inputs = document.querySelectorAll('input[type="hidden"]');
  const result = {};
  inputs.forEach(el => {
    if (el.name) result[el.name] = el.value || '';
  });
  return result;
}

// ─── Rate-limit checker ───────────────────────────────────────────────────────

function canClickNow() {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60_000;
  // Purge les vieux timestamps
  clickTimestamps = clickTimestamps.filter(ts => ts > oneHourAgo);
  return clickTimestamps.length < MAX_CLICKS_PER_HOUR;
}

function recordClick() {
  clickTimestamps.push(Date.now());
}

// ─── hCaptcha : Détection et résolution ──────────────────────────────────────

function detectHcaptcha() {
  // Cherche le widget hCaptcha sur la page
  const widget = document.querySelector('div.h-captcha[data-sitekey], div[class*="h-captcha"][data-sitekey]');
  if (widget) {
    const sitekey = widget.getAttribute('data-sitekey');
    if (sitekey) return { found: true, sitekey, element: widget };
  }

  // Cherche via l'iframe hcaptcha
  const iframes = document.querySelectorAll('iframe[src*="hcaptcha.com"]');
  for (const iframe of iframes) {
    const src = iframe.src;
    const match = src.match(/[?&]sitekey=([^&]+)/);
    if (match) return { found: true, sitekey: match[1], element: iframe };
  }

  return { found: false };
}

/**
 * Injecte le token hCaptcha résolu dans la page.
 * Méthode 1 : remplir le textarea caché + déclencher les callbacks hCaptcha
 * Méthode 2 : appeler window.hcaptcha.execute() si disponible
 */
function injectCaptchaToken(token) {
  // Méthode 1 : textarea standard
  const textarea = document.querySelector('textarea[name="h-captcha-response"]');
  if (textarea) {
    // Setter natif React/Angular pour bypasser les event listeners virtuels
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(textarea, token);
    } else {
      textarea.value = token;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Méthode 2 : callback hCaptcha global
  if (window.hcaptcha) {
    try {
      // Cherche le widget ID
      const widget = document.querySelector('[data-hcaptcha-widget-id]');
      const widgetId = widget?.getAttribute('data-hcaptcha-widget-id');
      if (widgetId !== null && widgetId !== undefined) {
        // Déclenche le callback de succès hCaptcha
        const callback = window.hcaptcha.getResponse ? null : null;
      }
    } catch (e) {
      // Silencieux — la méthode textarea suffit généralement
    }
  }

  // Méthode 3 : déclencher les callbacks globaux enregistrés (data-callback)
  const widget = document.querySelector('[data-callback]');
  if (widget) {
    const callbackName = widget.getAttribute('data-callback');
    if (callbackName && typeof window[callbackName] === 'function') {
      try {
        window[callbackName](token);
      } catch (e) {
        // Silencieux
      }
    }
  }
}

/**
 * Détecte, résout et injecte un hCaptcha si présent sur la page.
 * @returns {Promise<boolean>} true si captcha résolu
 */
async function handleCaptchaIfPresent() {
  const captcha = detectHcaptcha();
  if (!captcha.found) return false;

  if (captchaPending) {
    statusLog('⏳ Captcha en cours de résolution…');
    return false;
  }

  statusLog(`🔒 hCaptcha détecté | sitekey=${captcha.sitekey.slice(0, 12)}…`);
  captchaPending = true;

  try {
    const resp = await sendToBackground({
      type: 'SOLVE_CAPTCHA',
      sitekey: captcha.sitekey,
      siteUrl: window.location.href,
    });

    if (!resp?.ok) {
      statusLog(`❌ Résolution captcha échouée: ${resp?.error || 'inconnu'}`, 'error');
      captchaPending = false;
      return false;
    }

    statusLog('✅ Token captcha injecté');
    injectCaptchaToken(resp.token);
    await sleep(randomDelay(800, 1500));
    captchaPending = false;
    return true;
  } catch (err) {
    statusLog(`❌ Erreur captcha: ${err.message}`, 'error');
    captchaPending = false;
    return false;
  }
}

// ─── Polling des créneaux ─────────────────────────────────────────────────────

/**
 * Vérifie les créneaux disponibles via POST /Home/AvailableTimeSlots.
 * Utilise les cookies du navigateur automatiquement (même session que l'utilisateur).
 * @returns {Promise<{available: boolean, slots: any[], month: number, year: number}>}
 */
async function checkAvailableSlots() {
  const now = new Date();
  const results = [];

  // Vérifier le mois courant et les 2 mois suivants
  for (let offset = 0; offset < 3; offset++) {
    const checkDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const month = checkDate.getMonth() + 1;
    const year = checkDate.getFullYear();

    try {
      const rvt = extractAntiForgeryToken();
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Origin': CEV_BASE,
        'Referer': window.location.href,
      };
      if (rvt) headers['RequestVerificationToken'] = rvt;

      const body = new URLSearchParams({ month: String(month), year: String(year) });
      if (rvt) body.set('__RequestVerificationToken', rvt);

      const resp = await fetch(`${CEV_BASE}/Home/AvailableTimeSlots`, {
        method: 'POST',
        headers,
        body: body.toString(),
        credentials: 'include',
      });

      if (!resp.ok) {
        if (resp.status === 403 || resp.status === 401) {
          statusLog(`⚠️ Session expirée (${resp.status}) — actualise la page manuellement`, 'warn');
          return { available: false, slots: [], expired: true };
        }
        continue;
      }

      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // Réponse HTML = probablement page de captcha
        if (text.includes('hcaptcha') || text.includes('h-captcha')) {
          statusLog('🔒 Captcha détecté dans la réponse AJAX');
        }
        continue;
      }

      // Parse les slots — le format CEV retourne un tableau de dates/objets
      const slots = parseSlots(data, month, year);
      if (slots.length > 0) {
        results.push({ month, year, slots });
      }
    } catch (err) {
      statusLog(`⚠️ Erreur check mois ${month}/${year}: ${err.message}`, 'warn');
    }

    // Petit délai entre les checks de mois (naturel)
    if (offset < 2) await sleep(randomDelay(500, 1500));
  }

  const totalSlots = results.reduce((acc, r) => acc + r.slots.length, 0);
  return { available: totalSlots > 0, slots: results, count: totalSlots };
}

/**
 * Parse la réponse JSON de AvailableTimeSlots.
 * CEV retourne généralement un tableau de { date, timeSlotId } ou un objet avec des dates.
 */
function parseSlots(data, month, year) {
  if (!data) return [];

  // Format tableau direct : [{date: "2025-08-15", ...}, ...]
  if (Array.isArray(data)) {
    return data.filter(item => item && (item.date || item.Date || item.timeSlotId || item.TimeSlotId));
  }

  // Format objet avec clé "slots" ou "availableSlots"
  if (data.slots && Array.isArray(data.slots)) return data.slots;
  if (data.availableSlots && Array.isArray(data.availableSlots)) return data.availableSlots;
  if (data.Slots && Array.isArray(data.Slots)) return data.Slots;

  // Format booléen simple : { available: true }
  if (data.available === true || data.Available === true) {
    return [{ date: `${year}-${String(month).padStart(2, '0')}-01`, synthetic: true }];
  }

  // Format avec données imbriquées
  if (data.data && Array.isArray(data.data)) return data.data;

  return [];
}

// ─── Booking automatique ──────────────────────────────────────────────────────

/**
 * Tente de réserver le premier créneau disponible.
 * Stratégie 1 : POST HTTP direct (plus rapide).
 * Stratégie 2 : Click UI simulé (fallback).
 */
async function bookFirstAvailableSlot(slotsData) {
  if (!canClickNow()) {
    statusLog(`⚠️ Rate-limit atteint (${MAX_CLICKS_PER_HOUR} clics/h) — attente…`, 'warn');
    return { success: false, error: 'rate_limit' };
  }

  const firstResult = slotsData.slots?.[0];
  if (!firstResult?.slots?.length) return { success: false, error: 'no_slots' };

  const slot = firstResult.slots[0];
  statusLog(`🎯 Tentative de booking: ${slot.date || JSON.stringify(slot)}`);

  recordClick();

  // ── Stratégie 1 : POST HTTP direct ────────────────────────────────────────
  const httpResult = await tryHttpBooking(slot);
  if (httpResult.success) return httpResult;

  statusLog('⚠️ Booking HTTP échoué, tentative UI…', 'warn');

  // ── Stratégie 2 : Click UI simulé ─────────────────────────────────────────
  return await tryUiBooking(slot);
}

async function tryHttpBooking(slot) {
  try {
    const rvt = extractAntiForgeryToken();
    const hiddenInputs = extractHiddenInputs();

    // Construit le form data avec toutes les données nécessaires
    const formData = new URLSearchParams();
    if (rvt) formData.set('__RequestVerificationToken', rvt);

    // Ajoute tous les champs cachés (state ASP.NET MVC)
    Object.entries(hiddenInputs).forEach(([k, v]) => {
      if (k !== '__RequestVerificationToken') formData.set(k, v);
    });

    // Données du slot
    if (slot.timeSlotId) formData.set('timeSlotId', String(slot.timeSlotId));
    if (slot.TimeSlotId) formData.set('TimeSlotId', String(slot.TimeSlotId));
    if (slot.appointmentId) formData.set('appointmentId', String(slot.appointmentId));
    if (slot.date) formData.set('date', slot.date);
    if (slot.Date) formData.set('Date', slot.Date);

    // Endpoints possibles (découverts via bundle scanning du bot)
    const endpoints = [
      '/Home/SelectSlot',
      '/Home/BookAppointment',
      '/Home/ConfirmSlot',
      '/Home/CreateAppointment',
    ];

    // Récupère l'action du form sur la page si disponible
    const formEl = document.querySelector('form[method="post"]');
    if (formEl?.action) {
      const action = formEl.action.replace(CEV_BASE, '');
      endpoints.unshift(action);
    }

    for (const endpoint of endpoints) {
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': CEV_BASE,
        'Referer': window.location.href,
      };
      if (rvt) headers['RequestVerificationToken'] = rvt;

      const resp = await fetch(`${CEV_BASE}${endpoint}`, {
        method: 'POST',
        headers,
        body: formData.toString(),
        credentials: 'include',
      });

      if (resp.ok || resp.redirected) {
        const html = await resp.text();
        const confirmCode = extractConfirmationCode(html);

        if (confirmCode || html.includes('confirm') || html.includes('success') || resp.redirected) {
          return { success: true, confirmationCode: confirmCode, endpoint };
        }
      }
    }

    return { success: false, error: 'Aucun endpoint de booking n\'a répondu positivement' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function tryUiBooking(slot) {
  try {
    // Cherche le bouton de sélection du slot dans l'UI
    const slotSelectors = [
      `[data-slot-id="${slot.timeSlotId}"]`,
      `[data-time-slot-id="${slot.timeSlotId}"]`,
      `button[onclick*="${slot.timeSlotId}"]`,
      '.available-slot:first-child',
      '.time-slot.available:first-child',
      'button.slot-btn:first-child',
    ];

    let slotBtn = null;
    for (const sel of slotSelectors) {
      slotBtn = document.querySelector(sel);
      if (slotBtn) break;
    }

    if (!slotBtn) {
      // Cherche le premier lien/bouton de créneau visible
      slotBtn = document.querySelector('a.slot, button.slot, .calendar-slot a, td.slot a');
    }

    if (!slotBtn) {
      return { success: false, error: 'Bouton de slot non trouvé dans l\'UI' };
    }

    // Simulation comportement humain
    await injectScrollNoise();
    await humanReadingPause();
    await humanClick(slotBtn);
    await sleep(randomDelay(1500, 3000));

    // Cherche le bouton de confirmation
    const confirmBtns = [
      document.querySelector('button[type="submit"]'),
      document.querySelector('input[type="submit"]'),
      document.querySelector('button.confirm-btn'),
      document.querySelector('#btnConfirm'),
      document.querySelector('button[id*="confirm"]'),
    ].filter(Boolean);

    if (confirmBtns.length > 0) {
      await humanClick(confirmBtns[0]);
      await sleep(randomDelay(2000, 4000));
    }

    // Vérifie si une confirmation est apparue
    const confirmCode = extractConfirmationCode(document.body.innerHTML);
    return { success: !!confirmCode || document.body.innerText.includes('confirm'), confirmationCode: confirmCode };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function extractConfirmationCode(html) {
  const patterns = [
    /confirmation[^\w]*:?\s*([A-Z0-9\-]{6,20})/i,
    /code[^\w]*:?\s*([A-Z0-9\-]{6,20})/i,
    /réservation[^\w]*([A-Z0-9\-]{6,20})/i,
    /booking[^\w]*ref[^\w]*([A-Z0-9\-]{6,20})/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── Gestion de session (pause forcée) ───────────────────────────────────────

async function checkSessionPause() {
  const sessionAge = Date.now() - sessionStartTs;
  if (sessionAge >= SESSION_MAX_MS) {
    statusLog(`⏸ Pause forcée après ${Math.round(sessionAge / 60_000)}min de session (anti shadow-ban)`);
    await sleep(SESSION_PAUSE_MS);
    sessionStartTs = Date.now(); // Reset timer de session
    statusLog('▶️ Reprise après pause forcée');
  }
}

// ─── Boucle principale de polling ────────────────────────────────────────────

async function startPollingLoop() {
  running = true;
  sessionStartTs = Date.now();
  statusLog('▶️ Boucle de polling démarrée');

  while (running) {
    try {
      // 1. Vérifier si pause de session nécessaire
      await checkSessionPause();
      if (!running) break;

      // 2. Gérer le captcha si présent sur la page
      const captchaResolved = await handleCaptchaIfPresent();
      if (captchaResolved) {
        // Petit délai post-captcha avant de continuer
        await sleep(randomDelay(1500, 3000));
      }

      // 3. Injection de bruit humain (scroll aléatoire)
      if (Math.random() < 0.3) {
        await injectScrollNoise();
      }

      // 4. Pause "lecture" humaine avant l'action
      await humanReadingPause();

      // 5. Vérifier les créneaux
      pollCount++;
      statusLog(`🔍 Check #${pollCount} — ${new Date().toLocaleTimeString()}`);
      const result = await checkAvailableSlots();

      if (result.expired) {
        statusLog('⚠️ Session CEV expirée — actualise la page manuellement', 'warn');
        await sendToBackground({
          type: 'CHECK_DONE',
          slotsAvailable: false,
          slotsCount: 0,
          expired: true,
        });
        // Attendre plus longtemps si session expirée
        await sleep(randomDelay(60_000, 120_000));
        continue;
      }

      await sendToBackground({
        type: 'CHECK_DONE',
        slotsAvailable: result.available,
        slotsCount: result.count || 0,
      });

      if (result.available) {
        statusLog(`🟢 ${result.count} créneau(x) disponible(s) ! Booking en cours…`, 'ok');

        // 6. Tenter le booking
        const bookingResult = await bookFirstAvailableSlot(result);

        await sendToBackground({
          type: 'BOOKING_RESULT',
          success: bookingResult.success,
          confirmationCode: bookingResult.confirmationCode,
          error: bookingResult.error,
        });

        if (bookingResult.success) {
          statusLog(`✅ Rendez-vous réservé ! Code: ${bookingResult.confirmationCode || 'voir la page'}`, 'ok');
          running = false;
          break;
        } else {
          statusLog(`⚠️ Booking échoué: ${bookingResult.error}`, 'warn');
        }
      }

      // 7. Attendre le prochain cycle avec délai aléatoire anti-détection
      if (!running) break;
      const delay = randomDelay(POLL_MIN_MS, POLL_MAX_MS);
      statusLog(`⏱ Prochain check dans ${Math.round(delay / 1000)}s`);
      await sleep(delay);

    } catch (err) {
      statusLog(`❌ Erreur boucle: ${err.message}`, 'error');
      await sleep(randomDelay(10_000, 30_000));
    }
  }

  statusLog('⏹ Boucle de polling arrêtée');
}

// ─── Écoute des messages du background ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'START_POLLING': {
      if (!running) {
        startPollingLoop();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Déjà en cours' });
      }
      break;
    }
    case 'STOP_POLLING': {
      running = false;
      sendResponse({ ok: true });
      break;
    }
    case 'GET_CONTENT_STATUS': {
      sendResponse({ running, pollCount });
      break;
    }
  }
});

// ─── Détection automatique de la page ────────────────────────────────────────

/**
 * Détecte automatiquement si on est sur une page pertinente CEV.
 * Page SelectSlot ou page de captcha → on peut démarrer le polling.
 */
function detectCevPage() {
  const path = window.location.pathname.toLowerCase();
  const isSelectSlot = path.includes('selectslot') || path.includes('home') || path.includes('integration');
  const isCaptchaPage = path.includes('captcha') || document.querySelector('.h-captcha, [data-sitekey]');

  if (isSelectSlot || isCaptchaPage) {
    return 'cev';
  }
  return null;
}

// ─── Init : vérifier si le watcher est actif ─────────────────────────────────

async function init() {
  const pageType = detectCevPage();
  if (!pageType) return;

  // Informe le background qu'on est sur une page CEV
  sendToBackground({ type: 'STATUS_UPDATE', status: 'page_ready', log: `Page CEV détectée: ${window.location.pathname}` });

  // Vérifier si le watcher était actif (persist entre navigations)
  chrome.storage.local.get(['hunterRunning'], ({ hunterRunning }) => {
    if (hunterRunning) {
      statusLog('▶️ Reprise automatique du watcher (page rechargée)');
      startPollingLoop();
    } else {
      // Gérer automatiquement le captcha si présent même en mode pause
      setInterval(async () => {
        if (!running && !captchaPending) {
          const captcha = detectHcaptcha();
          if (captcha.found) {
            statusLog('🔒 Captcha détecté sur la page (mode passif)');
            await handleCaptchaIfPresent();
          }
        }
      }, 5_000);
    }
  });
}

init();
