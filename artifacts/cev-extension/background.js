/**
 * background.js — Service background CEV Slot Hunter
 *
 * Responsabilités :
 *  - Appels API Anti-Captcha (createTask + polling getTaskResult)
 *  - Gestion des notifications système
 *  - Relais de messages entre content script et popup
 *  - Stockage de l'état global (running, stats, logs)
 */

'use strict';

// ─── État global ──────────────────────────────────────────────────────────────

const state = {
  running: false,
  status: 'idle',
  lastCheck: null,
  slotsFound: 0,
  checksCount: 0,
  captchasSolved: 0,
  sessionStart: null,
  logs: [],
};

// ─── Logging ──────────────────────────────────────────────────────────────────

function addLog(level, msg) {
  const entry = { ts: Date.now(), level, msg };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.length = 200;
  broadcastState();
}

function log(msg)   { console.log('[CEV-BG]', msg);   addLog('info', msg); }
function warn(msg)  { console.warn('[CEV-BG]', msg);  addLog('warn', msg); }
function error(msg) { console.error('[CEV-BG]', msg); addLog('error', msg); }
function ok(msg)    { console.log('[CEV-BG] ✅', msg); addLog('ok', msg); }

// ─── Broadcast état vers popup ────────────────────────────────────────────────

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
}

// ─── Notifications ────────────────────────────────────────────────────────────

function notify(title, message, isAlert = false) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
    priority: isAlert ? 2 : 1,
  });
}

// ─── Anti-Captcha API ─────────────────────────────────────────────────────────

/**
 * Résout un hCaptcha via Anti-Captcha.
 * @param {string} sitekey  - La sitekey hCaptcha extraite de la page
 * @param {string} siteUrl  - L'URL de la page contenant le captcha
 * @param {string} apiKey   - La clé API Anti-Captcha
 * @returns {Promise<string>} - Le token de résolution
 */
async function solveHcaptcha(sitekey, siteUrl, apiKey) {
  log(`🔒 Anti-Captcha: création tâche | sitekey=${sitekey.slice(0, 12)}…`);

  const createResp = await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'HCaptchaTaskProxyless',
        websiteURL: siteUrl,
        websiteKey: sitekey,
      },
    }),
  });

  const createData = await createResp.json();
  if (createData.errorId !== 0) {
    throw new Error(`Anti-Captcha createTask failed: ${createData.errorCode} (id=${createData.errorId})`);
  }

  const taskId = createData.taskId;
  log(`📋 Anti-Captcha: tâche créée taskId=${taskId}`);

  // ── Polling résultat (max 120s) ──────────────────────────────────────────────
  const deadline = Date.now() + 120_000;
  let pollCount = 0;

  while (Date.now() < deadline) {
    const waitMs = pollCount === 0 ? 8_000 : 5_000;
    await sleep(waitMs);
    pollCount++;

    const resultResp = await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    const result = await resultResp.json();
    if (result.errorId !== 0) {
      throw new Error(`Anti-Captcha task error: ${result.errorCode} (id=${result.errorId})`);
    }

    if (result.status === 'ready') {
      const token = result.solution?.gRecaptchaResponse ?? result.solution?.token;
      if (!token) throw new Error('Anti-Captcha: token vide dans la solution');
      state.captchasSolved++;
      ok(`hCaptcha résolu en ${pollCount * 5}s~`);
      return token;
    }

    if (pollCount % 4 === 0) {
      log(`⏳ Anti-Captcha en cours… (poll #${pollCount}, ${Math.round((deadline - Date.now()) / 1000)}s restantes)`);
    }
  }

  throw new Error('Anti-Captcha timeout (>120s)');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Délai aléatoire entre min et max ms */
function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// ─── Réception des messages ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    // ── Démarrer / arrêter le watcher ───────────────────────────────────────
    case 'START': {
      state.running = true;
      state.status = 'running';
      state.sessionStart = Date.now();
      ok('Watcher démarré');
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'STOP': {
      state.running = false;
      state.status = 'idle';
      warn('Watcher arrêté manuellement');
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    // ── Demande de résolution captcha depuis content script ──────────────────
    case 'SOLVE_CAPTCHA': {
      const { sitekey, siteUrl } = msg;
      chrome.storage.local.get(['anticaptchaKey'], async ({ anticaptchaKey }) => {
        if (!anticaptchaKey) {
          error('Clé Anti-Captcha non configurée');
          sendResponse({ ok: false, error: 'Clé API Anti-Captcha manquante' });
          return;
        }
        try {
          state.status = 'solving_captcha';
          broadcastState();
          const token = await solveHcaptcha(sitekey, siteUrl, anticaptchaKey);
          state.status = 'running';
          broadcastState();
          sendResponse({ ok: true, token });
        } catch (err) {
          error(`Captcha résolution échouée: ${err.message}`);
          state.status = 'running';
          broadcastState();
          sendResponse({ ok: false, error: err.message });
        }
      });
      return true; // async
    }

    // ── Rapport de vérification depuis content script ────────────────────────
    case 'CHECK_DONE': {
      state.checksCount++;
      state.lastCheck = Date.now();
      if (msg.slotsAvailable) {
        state.slotsFound++;
        notify(
          '🟢 CRÉNEAUX DISPONIBLES !',
          `${msg.slotsCount} créneau(x) trouvé(s) sur le portail CEV !`,
          true
        );
        ok(`Créneau trouvé ! ${msg.slotsCount} slot(s) disponible(s)`);
      } else {
        log(`Check #${state.checksCount}: aucun créneau`);
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    // ── Rapport de booking depuis content script ─────────────────────────────
    case 'BOOKING_RESULT': {
      if (msg.success) {
        notify(
          '✅ RENDEZ-VOUS RÉSERVÉ !',
          `Confirmation: ${msg.confirmationCode || 'voir la page'}`,
          true
        );
        ok(`Rendez-vous réservé ! Code: ${msg.confirmationCode}`);
        state.status = 'booked';
        state.running = false;
      } else {
        error(`Booking échoué: ${msg.error}`);
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    // ── Sync état depuis content script ─────────────────────────────────────
    case 'STATUS_UPDATE': {
      state.status = msg.status;
      if (msg.log) addLog(msg.logLevel || 'info', msg.log);
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    // ── Demande état depuis popup ────────────────────────────────────────────
    case 'GET_STATE': {
      sendResponse({ state });
      break;
    }

    // ── Effacer les logs ─────────────────────────────────────────────────────
    case 'CLEAR_LOGS': {
      state.logs = [];
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    // ── Reset stats ──────────────────────────────────────────────────────────
    case 'RESET_STATS': {
      state.checksCount = 0;
      state.slotsFound = 0;
      state.captchasSolved = 0;
      state.sessionStart = null;
      broadcastState();
      sendResponse({ ok: true });
      break;
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

log('CEV Slot Hunter background démarré');
