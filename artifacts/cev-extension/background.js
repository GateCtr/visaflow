/**
 * background.js — CEV Slot Hunter v2.1 (Manifest V3 / Service Worker)
 *
 * MV3 : background script = service worker (pas de page persistante).
 * L'état est stocké dans chrome.storage.session pour survivre aux redémarrages SW.
 * Le sleep() touche l'API Chrome toutes les 20s pour éviter l'extinction idle du SW.
 */

'use strict';

const MAX_CLICKS_PER_HOUR = 4;

// ─── État en mémoire + persisté dans chrome.storage.session ───────────────────

let state = {
  running: false,
  phase: 'idle',
  attempts: 0,
  captchasSolved: 0,
  lastAttemptTs: null,
  activeCevTabId: null,
  logs: [],
  nextRetryIn: null,
  clickTimestamps: [],
};

// Restaurer l'état depuis la session au démarrage du SW
chrome.storage.session.get(['cevState'], (d) => {
  if (d.cevState) {
    state = d.cevState;
    // Si le SW a été tué pendant une exécution → signaler et réinitialiser
    if (state.running) {
      state.running = false;
      state.phase = 'idle';
      state.activeCevTabId = null;
      addLog('warn', '⚠️ Watcher interrompu (service worker redémarré) — relancer manuellement');
    }
  }
});

function persistState() {
  chrome.storage.session.set({ cevState: state });
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function addLog(level, msg) {
  state.logs.unshift({ ts: Date.now(), level, msg });
  if (state.logs.length > 150) state.logs.length = 150;
  broadcastState();
}

const log   = msg => { console.log('[BG]',   msg); addLog('info',  msg); };
const warn  = msg => { console.warn('[BG]',  msg); addLog('warn',  msg); };
const error = msg => { console.error('[BG]', msg); addLog('error', msg); };
const ok    = msg => { console.log('[BG] ✅', msg); addLog('ok',   msg); };

function broadcastState() {
  persistState();
  try {
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }, () => {
      void chrome.runtime.lastError; // consume silencieusement (popup fermé = normal)
    });
  } catch (_) {}
}

function setPhase(phase, logMsg) {
  state.phase = phase;
  if (logMsg) addLog(phase === 'success' ? 'ok' : phase === 'retry' ? 'warn' : 'info', logMsg);
  broadcastState();
}

// ─── Notifications ────────────────────────────────────────────────────────────

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon48.png',
    title, message, priority: 2,
  });
}

// ─── Rate-limit ───────────────────────────────────────────────────────────────

function canAttempt() {
  const now = Date.now();
  const windowStart = now - 60 * 60_000;
  state.clickTimestamps = (state.clickTimestamps || []).filter(t => t > windowStart);
  return state.clickTimestamps.length < MAX_CLICKS_PER_HOUR;
}

function recordAttempt() {
  if (!state.clickTimestamps) state.clickTimestamps = [];
  state.clickTimestamps.push(Date.now());
}

// ─── Anti-Captcha ─────────────────────────────────────────────────────────────

async function solveHcaptcha(sitekey, siteUrl, apiKey) {
  log(`🔒 Anti-Captcha: création tâche | sitekey=${sitekey.slice(0, 10)}…`);

  const createResp = await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: 'HCaptchaTaskProxyless', websiteURL: siteUrl, websiteKey: sitekey },
    }),
  });
  const created = await createResp.json();
  if (created.errorId !== 0) throw new Error(`Anti-Captcha: ${created.errorCode}`);

  const taskId = created.taskId;
  log(`📋 Tâche Anti-Captcha créée: taskId=${taskId}`);

  const deadline = Date.now() + 120_000;
  let pollCount = 0;

  while (Date.now() < deadline) {
    await sleep(pollCount === 0 ? 8_000 : 5_000);
    pollCount++;

    const res = await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const result = await res.json();

    if (result.errorId !== 0) throw new Error(`Anti-Captcha task: ${result.errorCode}`);
    if (result.status === 'ready') {
      const token = result.solution?.gRecaptchaResponse ?? result.solution?.token;
      if (!token) throw new Error('Anti-Captcha: token vide');
      state.captchasSolved++;
      ok(`hCaptcha résolu en ~${pollCount * 5}s`);
      return token;
    }
    if (pollCount % 3 === 0) log(`⏳ Anti-Captcha en cours… (poll #${pollCount})`);
  }
  throw new Error('Anti-Captcha timeout (>120s)');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sleep compatible service worker MV3 :
 * touche l'API Chrome toutes les 20s pour éviter l'extinction idle du SW.
 */
async function sleep(ms) {
  const CHUNK = 20_000;
  let remaining = ms;
  while (remaining > 0) {
    const wait = Math.min(CHUNK, remaining);
    await new Promise(r => setTimeout(r, wait));
    remaining -= wait;
    if (remaining > 0) {
      // Toucher l'API Chrome → réinitialise le timer idle du service worker
      await new Promise(r => chrome.runtime.getPlatformInfo(r));
    }
  }
}

function randDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function getVowintTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://visaonweb.diplomatie.be/*' }, tabs => {
      resolve(tabs?.[0] || null);
    });
  });
}

// ─── Boucle principale ────────────────────────────────────────────────────────

async function runLoop() {
  while (state.running) {
    // ── Rate-limit ───────────────────────────────────────────────────────────
    if (!canAttempt()) {
      const oldestClick = state.clickTimestamps[0];
      const waitUntil = oldestClick + 60 * 60_000;
      const waitSec = Math.ceil((waitUntil - Date.now()) / 1000);
      setPhase('retry', `⚠️ Rate-limit atteint (${MAX_CLICKS_PER_HOUR}/h) — attente ${Math.round(waitSec/60)}min`);
      await countdownWait(waitSec * 1000);
      continue;
    }

    // ── Délai entre essais (sauf premier) ───────────────────────────────────
    if (state.attempts > 0) {
      const delay = randDelay(3 * 60_000, 5 * 60_000);
      const delaySec = Math.round(delay / 1000);
      setPhase('retry', `⏱ Prochain essai dans ${Math.round(delaySec/60)}m${delaySec%60}s`);
      await countdownWait(delay);
    }
    if (!state.running) break;

    // ── Trouver l'onglet VOWINT ──────────────────────────────────────────────
    const vowintTab = await getVowintTab();
    if (!vowintTab) {
      warn('⚠️ Aucun onglet VOWINT ouvert — navigue sur visaonweb.diplomatie.be');
      await sleep(15_000);
      continue;
    }

    // ── Déclencher le clic ───────────────────────────────────────────────────
    state.attempts++;
    state.lastAttemptTs = Date.now();
    recordAttempt();
    setPhase('clicking', `🖱 Essai #${state.attempts} — clic "Prendre rendez-vous"`);

    chrome.tabs.sendMessage(vowintTab.id, { type: 'CLICK_RDV_BUTTON' }, resp => {
      if (chrome.runtime.lastError || !resp?.ok) {
        error(`❌ Clic échoué: ${chrome.runtime.lastError?.message || resp?.error || 'inconnu'}`);
      }
    });

    // ── Attendre l'onglet CEV ─────────────────────────────────────────────────
    const cevTab = await waitForNewCevTab(15_000);
    if (!cevTab) {
      error('❌ Aucun onglet CEV ouvert après clic — VOWINT sur la bonne page ?');
      continue;
    }

    state.activeCevTabId = cevTab.id;
    setPhase('captcha_solving', '🔒 Onglet CEV ouvert — attente captcha…');

    const result = await waitForCevResult(cevTab.id);
    state.activeCevTabId = null;

    if (result === 'success') {
      setPhase('success', '✅ Rendez-vous réservé avec succès !');
      notify('✅ RENDEZ-VOUS RÉSERVÉ !', 'Le créneau a été confirmé sur le portail CEV.');
      state.running = false;
      break;
    } else if (result === 'no_availability') {
      setPhase('retry', `❌ Essai #${state.attempts} : aucune disponibilité — on réessaie`);
    } else {
      warn(`⚠️ Résultat inattendu: ${result} — on réessaie`);
    }
  }

  if (!state.running && state.phase !== 'success') {
    setPhase('idle', '⏹ Watcher arrêté');
  }
}

// ─── Attente onglet CEV ───────────────────────────────────────────────────────

function waitForNewCevTab(timeoutMs) {
  return new Promise(resolve => {
    let resolved = false;

    function cleanup() {
      chrome.tabs.onCreated.removeListener(createdListener);
      chrome.tabs.onUpdated.removeListener(updatedListener);
    }

    const timer = setTimeout(() => {
      cleanup();
      if (!resolved) { resolved = true; resolve(null); }
    }, timeoutMs);

    function createdListener(tab) {
      if (tab.url && tab.url.includes('appointment.cloud.diplomatie.be')) {
        clearTimeout(timer);
        cleanup();
        if (!resolved) { resolved = true; resolve(tab); }
      }
    }

    function updatedListener(tabId, changeInfo) {
      if (changeInfo.url && changeInfo.url.includes('appointment.cloud.diplomatie.be')) {
        clearTimeout(timer);
        cleanup();
        if (!resolved) {
          resolved = true;
          chrome.tabs.get(tabId, t => resolve(t));
        }
      }
    }

    chrome.tabs.onCreated.addListener(createdListener);
    chrome.tabs.onUpdated.addListener(updatedListener);
  });
}

// ─── Attente résultat CEV ─────────────────────────────────────────────────────

let pendingCevResultResolver = null;

function waitForCevResult(tabId) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(urlListener);
      chrome.tabs.onRemoved.removeListener(closedListener);
      resolve('timeout');
    }, 3 * 60_000);

    function urlListener(changedTabId, changeInfo) {
      if (changedTabId !== tabId || !changeInfo.url) return;
      const url = changeInfo.url.toLowerCase();
      if (url.includes('noavailability') || url.includes('no-availability') || url.includes('error')) {
        done('no_availability');
      }
    }

    function closedListener(closedTabId) {
      if (closedTabId !== tabId) return;
      done('tab_closed');
    }

    function done(result) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(urlListener);
      chrome.tabs.onRemoved.removeListener(closedListener);
      resolve(result);
    }

    pendingCevResultResolver = done;
    chrome.tabs.onUpdated.addListener(urlListener);
    chrome.tabs.onRemoved.addListener(closedListener);
  });
}

// ─── Countdown ────────────────────────────────────────────────────────────────

async function countdownWait(ms) {
  const step = 5_000;
  let remaining = ms;
  while (remaining > 0 && state.running) {
    state.nextRetryIn = Math.ceil(remaining / 1000);
    broadcastState();
    await sleep(Math.min(step, remaining));
    remaining -= step;
  }
  state.nextRetryIn = null;
}

// ─── Messages entrants ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'START': {
      if (!state.running) {
        state.running = true;
        state.phase = 'idle';
        runLoop();
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'STOP': {
      state.running = false;
      state.phase = 'idle';
      state.nextRetryIn = null;
      if (state.activeCevTabId) {
        chrome.tabs.remove(state.activeCevTabId, () => {});
        state.activeCevTabId = null;
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'SOLVE_CAPTCHA': {
      const { sitekey, siteUrl } = msg;
      chrome.storage.local.get(['anticaptchaKey'], async ({ anticaptchaKey }) => {
        if (!anticaptchaKey) {
          sendResponse({ ok: false, error: 'Clé Anti-Captcha non configurée' });
          return;
        }
        try {
          const token = await solveHcaptcha(sitekey, siteUrl, anticaptchaKey);
          sendResponse({ ok: true, token });
        } catch (err) {
          error(`Captcha échoué: ${err.message}`);
          sendResponse({ ok: false, error: err.message });
        }
      });
      return true; // async
    }

    case 'CEV_RESULT': {
      log(`📩 Résultat CEV reçu: ${msg.result}`);
      if (pendingCevResultResolver) {
        pendingCevResultResolver(msg.result);
        pendingCevResultResolver = null;
      }
      if (msg.result === 'success') {
        ok(`Réservé ! Code: ${msg.confirmationCode || '(voir la page)'}`);
      }
      sendResponse({ ok: true });
      break;
    }

    case 'LOG': {
      addLog(msg.level || 'info', msg.msg);
      sendResponse({ ok: true });
      break;
    }

    case 'GET_STATE': {
      sendResponse({ state });
      break;
    }

    case 'CLEAR_LOGS': {
      state.logs = [];
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'RESET': {
      state.attempts = 0;
      state.captchasSolved = 0;
      state.logs = [];
      state.clickTimestamps = [];
      broadcastState();
      sendResponse({ ok: true });
      break;
    }
  }
});

log('CEV Slot Hunter v2.1 démarré (MV3 service worker)');
