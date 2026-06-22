/**
 * background.js — CEV Slot Hunter v3.1
 *
 * Réaction intelligente aux erreurs serveur :
 *
 *   RATE_LIMITED  (429, 403 WAF, body keywords)
 *     → Pause 60 min ancrée sur le PREMIER timestamp de détection.
 *       Reprises consécutives dans la fenêtre n'allongent pas le chrono.
 *
 *   SERVER_ERROR  down (5xx)
 *     → Pause 10 min, retentative automatique.
 *
 *   SERVER_ERROR  timeout (504, réseau)
 *     → Pause 5 min, retentative automatique.
 *
 *   SERVER_ERROR  session (401, 410)
 *     → Re-login automatique VOWINT.
 *
 *   SERVER_ERROR  conflict (409)
 *     → Continuer immédiatement (slot pris entre-temps, pas grave).
 *
 *   Consécutives server down (≥3 en 10 min)
 *     → Pause 20 min, notification "serveur CEV instable".
 */

'use strict';

const MAX_CLICKS_PER_HOUR     = 4;
const RATE_LIMIT_PAUSE_MS     = 60 * 60_000;   // 60 min pause rate-limit
const SERVER_DOWN_PAUSE_MS    = 10 * 60_000;   // 10 min pause 5xx
const SERVER_TIMEOUT_PAUSE_MS =  5 * 60_000;   //  5 min pause timeout
const SERVER_STORM_PAUSE_MS   = 20 * 60_000;   // 20 min si ≥3 erreurs serveur en 10 min
const SERVER_STORM_THRESHOLD  = 3;             // nbre d'erreurs serveur avant "storm"
const SERVER_STORM_WINDOW_MS  = 10 * 60_000;   // fenêtre de détection storm

const SHADOWBAN_WARN_THRESHOLD = 3;
const SHADOWBAN_STOP_THRESHOLD = 6;

// ─── État ────────────────────────────────────────────────────────────────────

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
  applicationId: null,
  consecutiveNoTab: 0,
  slotFound: null,
  alarmActive: false,

  // ── Gestion erreurs ──
  rateLimitStartTs: null,       // timestamp du PREMIER rate-limit détecté (ancre 60 min)
  rateLimitReason: null,        // raison lisible du rate-limit
  serverErrorTs: [],            // timestamps des erreurs serveur (storm detection)
  lastServerErrorCategory: null,
};

// Restaurer l'état depuis le storage au démarrage du SW
chrome.storage.local.get(['cevState'], (d) => {
  if (d.cevState) {
    state = { ...state, ...d.cevState };
    if (state.running) {
      state.running = false;
      state.phase = 'idle';
      state.activeCevTabId = null;
      state.alarmActive = false;
      addLog('warn', '⚠️ Watcher interrompu (service worker redémarré) — relancer manuellement');
    }
    // Vérifier si le rate-limit est encore actif
    if (state.rateLimitStartTs) {
      const remaining = RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs);
      if (remaining <= 0) {
        state.rateLimitStartTs = null;
        state.rateLimitReason  = null;
      } else {
        addLog('warn', `⏸ Rate-limit encore actif — ${Math.ceil(remaining / 60_000)} min restantes`);
      }
    }
  }
});

function persistState() {
  chrome.storage.local.set({ cevState: state });
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
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

function setPhase(phase, logMsg) {
  state.phase = phase;
  if (logMsg) {
    const level = phase === 'slot_found' ? 'ok'
                : (phase === 'retry' || phase === 'rate_limited' || phase === 'server_error') ? 'warn'
                : 'info';
    addLog(level, logMsg);
  }
  broadcastState();
  // Rafraîchir immédiatement la notification statut sur tout changement significatif
  updateStatusNotification();
}

// ─── Rate-limit — pause 60 min ancrée sur premier hit ────────────────────────

/**
 * Démarre ou prolonge la pause rate-limit.
 * Le PREMIER hit pose l'ancre — les hits suivants dans la fenêtre ne changent rien.
 * Retourne le nombre de ms restantes à attendre.
 */
function applyRateLimit(reason) {
  const now = Date.now();

  if (!state.rateLimitStartTs) {
    // Premier hit → poser l'ancre
    state.rateLimitStartTs = now;
    state.rateLimitReason  = reason;
    error(`🚫 RATE-LIMIT — pause 60 min depuis maintenant | raison: ${reason}`);
    notify('🚫 CEV : trop de tentatives détectées',
      `Pause automatique 60 min. Raison: ${reason.slice(0, 80)}`);
  } else {
    const remaining = RATE_LIMIT_PAUSE_MS - (now - state.rateLimitStartTs);
    if (remaining <= 0) {
      // Fenêtre écoulée → nouveau cycle, reposer l'ancre
      state.rateLimitStartTs = now;
      state.rateLimitReason  = reason;
      error(`🚫 RATE-LIMIT (nouveau cycle) — pause 60 min | raison: ${reason}`);
      notify('🚫 CEV : nouveau rate-limit détecté', `Pause 60 min. ${reason.slice(0, 60)}`);
    } else {
      warn(`⏸ RATE-LIMIT déjà actif — ${Math.ceil(remaining / 60_000)} min restantes`);
    }
  }

  broadcastState();
  return Math.max(0, RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs));
}

/**
 * Vérifie si un rate-limit est actif et retourne le ms restant (0 = libre).
 */
function getRateLimitRemaining() {
  if (!state.rateLimitStartTs) return 0;
  const remaining = RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs);
  if (remaining <= 0) {
    state.rateLimitStartTs = null;
    state.rateLimitReason  = null;
    broadcastState();
    return 0;
  }
  return remaining;
}

// ─── Server error storm detection ────────────────────────────────────────────

/**
 * Enregistre une erreur serveur et vérifie si un "storm" est détecté.
 * Retourne 'storm' | 'down' | 'timeout' | 'generic' avec la durée de pause.
 */
function classifyServerErrorResponse(category) {
  const now = Date.now();
  state.serverErrorTs = (state.serverErrorTs || []).filter(t => now - t < SERVER_STORM_WINDOW_MS);
  state.serverErrorTs.push(now);
  state.lastServerErrorCategory = category;

  if (state.serverErrorTs.length >= SERVER_STORM_THRESHOLD) {
    error(`🌩️ Storm serveur détecté — ${state.serverErrorTs.length} erreurs en ${SERVER_STORM_WINDOW_MS / 60_000} min → pause ${SERVER_STORM_PAUSE_MS / 60_000} min`);
    notify('🌩️ CEV serveur instable',
      `${state.serverErrorTs.length} erreurs en ${SERVER_STORM_WINDOW_MS/60_000} min — pause ${SERVER_STORM_PAUSE_MS/60_000} min`);
    state.serverErrorTs = []; // reset après storm
    return { type: 'storm', pauseMs: SERVER_STORM_PAUSE_MS };
  }

  const pauseMs = category === 'timeout' ? SERVER_TIMEOUT_PAUSE_MS : SERVER_DOWN_PAUSE_MS;
  warn(`⚠️ Erreur serveur [${category}] — pause ${pauseMs / 60_000} min (${state.serverErrorTs.length}/${SERVER_STORM_THRESHOLD})`);
  return { type: category, pauseMs };
}

// ─── Offscreen (sonnerie audio) ───────────────────────────────────────────────

async function ensureOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument().catch(() => false);
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Sonnerie alerte slot',
      });
    }
  } catch (_) {}
}

async function sendOffscreen(type) {
  await ensureOffscreen();
  try { chrome.runtime.sendMessage({ type }); } catch (_) {}
}

// ─── Sonnerie répétée (slot trouvé) ──────────────────────────────────────────

async function startAlarm(slot) {
  state.alarmActive = true;
  state.slotFound   = slot;
  broadcastState();
  await sendOffscreen('ALARM_START');
  chrome.notifications.create('slot_alert', {
    type: 'basic', iconUrl: 'icons/icon128.png',
    title: '🚨 CRÉNEAU CEV DISPONIBLE !',
    message: slot
      ? `📅 ${slot.date || '?'} ${slot.time || ''} — Ouvre CEV maintenant !`
      : 'Un créneau est disponible — agis vite !',
    priority: 2, requireInteraction: true,
  });
  chrome.alarms.create('slot_reminder', { periodInMinutes: 0.5 });
}

async function stopAlarm() {
  state.alarmActive = false;
  broadcastState();
  chrome.alarms.clear('slot_reminder');
  await sendOffscreen('ALARM_STOP');
  chrome.notifications.clear('slot_alert', () => {});
}

// Alarmes périodiques
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'slot_reminder' && state.alarmActive) {
    await sendOffscreen('ALARM_PING');
    const slot = state.slotFound;
    chrome.notifications.create(`slot_alert_${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: '🚨 CRÉNEAU CEV DISPONIBLE !',
      message: slot
        ? `📅 ${slot.date || '?'} ${slot.time || ''} — Appuie "Acquitter" dans l\'extension.`
        : 'Créneau disponible — acquitte l\'alerte dans l\'extension.',
      priority: 2, requireInteraction: true,
    });
  }
  if (alarm.name === 'sw_keepalive' && state.running) {
    chrome.runtime.getPlatformInfo(() => {});
  }
  if (alarm.name === 'cev_status') {
    updateStatusNotification();
  }
});

// ─── Notification statut persistante (barre de notifications / écran verrouillé) ──

const STATUS_NOTIF_ID = 'cev_live_status';

/**
 * Formate un nombre de secondes en "4m32s" ou "58m00s".
 */
function fmtMs(ms) {
  if (ms <= 0) return '0s';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Construit le contenu de la notification statut selon l'état courant.
 * Retourne { title, message, iconUrl }.
 */
function buildStatusContent() {
  const phase = state.phase || 'idle';

  // ── Slot trouvé — priorité absolue ────────────────────────────────────────
  if (phase === 'slot_found' || state.alarmActive) {
    const s = state.slotFound;
    return {
      title:   '🚨 CRÉNEAU CEV DISPONIBLE !',
      message: s
        ? `📅 ${s.date || '?'}${s.time ? ' à ' + s.time : ''}${s.count > 1 ? ' · ' + s.count + ' créneaux' : ''}\nOuvre CEV et réserve maintenant !`
        : 'Ouvre le portail CEV immédiatement !',
      iconUrl: 'icons/icon128.png',
    };
  }

  // ── Rate-limit ─────────────────────────────────────────────────────────────
  if (phase === 'rate_limited' && state.rateLimitStartTs) {
    const remaining = RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs);
    return {
      title:   '🚫 CEV Slot Hunter — Pause rate-limit',
      message: `⏳ Reprise dans ${fmtMs(remaining)}\n` +
               `🔍 ${state.attempts} scans effectués`,
      iconUrl: 'icons/icon48.png',
    };
  }

  // ── Extension arrêtée ──────────────────────────────────────────────────────
  if (!state.running || phase === 'idle') {
    return {
      title:   '⏸ CEV Slot Hunter — Inactif',
      message: `${state.attempts > 0 ? `🔍 ${state.attempts} scans · ` : ''}Appuie ▶ pour relancer`,
      iconUrl: 'icons/icon48.png',
    };
  }

  // ── Erreur serveur ─────────────────────────────────────────────────────────
  if (phase === 'server_error') {
    const wait = state.nextRetryIn ? `Reprise dans ${fmtMs(state.nextRetryIn * 1000)}` : 'Reprise bientôt…';
    return {
      title:   '⚠️ CEV Slot Hunter — Erreur serveur',
      message: `${wait}\n🔍 ${state.attempts} scans · 🔒 ${state.captchasSolved} captchas`,
      iconUrl: 'icons/icon48.png',
    };
  }

  // ── En cours de scan ───────────────────────────────────────────────────────
  const phaseLabel = {
    clicking:        '🖱 Clic "Prendre rendez-vous"…',
    captcha_solving: '🔒 Résolution captcha…',
    waiting_result:  '🔍 Scan des disponibilités…',
    retry:           state.nextRetryIn
                       ? `⏱ Prochain scan dans ${fmtMs(state.nextRetryIn * 1000)}`
                       : '⏱ Pause entre scans…',
  }[phase] || `🔄 ${phase}`;

  const now   = new Date();
  const hhmm  = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  return {
    title:   '🎯 CEV Slot Hunter — En cours',
    message: `${phaseLabel}\n` +
             `🔍 ${state.attempts} scans · 🔒 ${state.captchasSolved} captchas · ${hhmm}`,
    iconUrl: 'icons/icon48.png',
  };
}

/**
 * Crée ou met à jour la notification statut.
 * Appelée toutes les 30 secondes via l'alarme 'cev_status'
 * et à chaque changement d'état significatif.
 */
function updateStatusNotification() {
  if (!state.running && state.phase === 'idle' && state.attempts === 0) {
    chrome.notifications.clear(STATUS_NOTIF_ID, () => {});
    return;
  }

  const { title, message, iconUrl } = buildStatusContent();

  // Tenter de mettre à jour d'abord, créer si elle n'existe pas
  chrome.notifications.update(STATUS_NOTIF_ID, {
    type: 'basic',
    iconUrl,
    title,
    message,
    priority: 1,
  }, (wasUpdated) => {
    if (!wasUpdated) {
      chrome.notifications.create(STATUS_NOTIF_ID, {
        type: 'basic',
        iconUrl,
        title,
        message,
        priority: 1,
        // requireInteraction: false → la notification reste dans la barre
        // sans bloquer l'écran, mais visible sur l'écran de verrouillage
        isClickable: true,
      });
    }
  });
}

/**
 * Démarre l'alarme de mise à jour de la notification statut (toutes les 30s).
 */
function startStatusAlarm() {
  chrome.alarms.create('cev_status', { periodInMinutes: 0.5 }); // 30 secondes
  updateStatusNotification(); // mise à jour immédiate
}

/**
 * Arrête l'alarme et efface la notification statut.
 */
function stopStatusAlarm() {
  chrome.alarms.clear('cev_status');
  chrome.notifications.clear(STATUS_NOTIF_ID, () => {});
}

// ─── Notifications ponctuelles ────────────────────────────────────────────────

function notify(title, message) {
  chrome.notifications.create(`notif_${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title, message, priority: 2,
  });
}

// ─── Rate-limit interne (self) ────────────────────────────────────────────────

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

// ─── Délai humain non-linéaire ────────────────────────────────────────────────

function humanLikeRetryDelay() {
  const BASE  = 2 * 60_000;
  // Humain paressé : distribution non-uniforme 0-50s, concentrée vers les valeurs basses
  // Math.pow(r, 1.8) → majorité < 20s, max ~50s
  const extra = Math.pow(Math.random(), 1.8) * 50_000;
  return Math.round(BASE + extra);  // 2:00 → 2:50, majorité ~2:00-2:20
}

// ─── Anti-Captcha ─────────────────────────────────────────────────────────────

async function solveHcaptcha(sitekey, siteUrl, apiKey) {
  log(`🔒 Anti-Captcha | sitekey=${sitekey.slice(0, 10)}…`);
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
  log(`📋 Tâche Anti-Captcha: taskId=${taskId}`);

  const deadline = Date.now() + 120_000;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await sleep(pollCount === 0 ? 8_000 : 5_000);
    pollCount++;
    const res    = await fetch('https://api.anti-captcha.com/getTaskResult', {
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
    if (pollCount % 3 === 0) log(`⏳ Anti-Captcha poll #${pollCount}`);
  }
  throw new Error('Anti-Captcha timeout (>120s)');
}

// ─── Helpers SW ──────────────────────────────────────────────────────────────

async function sleep(ms) {
  const CHUNK = 20_000;
  let remaining = ms;
  while (remaining > 0) {
    const wait = Math.min(CHUNK, remaining);
    await new Promise(r => setTimeout(r, wait));
    remaining -= wait;
    if (remaining > 0) await new Promise(r => chrome.runtime.getPlatformInfo(r));
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

async function getTabUrl(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(tab?.url || null);
    });
  });
}

function detectVowintLang(url) {
  if (!url) return null;
  const pathMatch = url.match(/visaonweb\.diplomatie\.be\/([a-z]{2})\//i);
  if (pathMatch) {
    const lang = pathMatch[1].toLowerCase();
    if (['fr', 'en', 'nl'].includes(lang)) return lang;
  }
  const returnMatch = url.match(/[?&]ReturnUrl=(?:%2F|\/)(en|fr|nl)/i);
  if (returnMatch) return returnMatch[1].toLowerCase();
  return null;
}

function getApplicationsUrl(lang = 'en') {
  return `https://visaonweb.diplomatie.be/${lang}/VisaApplication/IndexByUserId`;
}

function saveVowintLang(lang) { chrome.storage.local.set({ vowintLang: lang }); }

function getStoredVowintLang() {
  return new Promise(resolve => {
    chrome.storage.local.get(['vowintLang'], (d) => resolve(d.vowintLang || 'en'));
  });
}

async function resolveVowintLang(url) {
  const detected = detectVowintLang(url);
  if (detected) { saveVowintLang(detected); return detected; }
  const stored = await getStoredVowintLang();
  log(`🌐 Langue mémorisée : ${stored}`);
  return stored;
}

function isVowintApplicationsPage(url) {
  return !!url && url.toLowerCase().includes('/visaapplication/indexbyuserid');
}

async function navigateToApplicationsPage(tabId, lang) {
  const resolvedLang = lang || await getStoredVowintLang();
  const targetUrl    = getApplicationsUrl(resolvedLang);
  log(`🗂 Navigation Mes Applications (${resolvedLang})`);
  setPhase('clicking', `🗂 Navigation vers Mes Applications…`);
  await new Promise(resolve => { chrome.tabs.update(tabId, { url: targetUrl }, () => resolve()); });
  await waitForTabLoad(tabId, 25_000);
  await sleep(randDelay(1_800, 3_200));
}

/**
 * Rafraîchit la page Mes Applications VOWINT.
 * Si tabId est fourni, recharge ce tab. Sinon cherche le tab VOWINT actif.
 * Utilisé : juste après un scan sans slot (avant la pause)
 *           et juste après la fin de la pause (avant le prochain scan).
 */
async function refreshMesApplications(context, tabId) {
  try {
    let id = tabId;
    if (!id) {
      const tab = await getVowintTab();
      if (!tab) { log(`🔄 Rafraîchissement [${context}] : aucun onglet VOWINT trouvé`); return; }
      id = tab.id;
    }
    log(`🔄 Rafraîchissement Mes Applications [${context}]…`);
    const lang = await getStoredVowintLang();
    const targetUrl = getApplicationsUrl(lang);
    await new Promise(resolve => chrome.tabs.update(id, { url: targetUrl }, () => resolve()));
    await waitForTabLoad(id, 20_000);
    await sleep(randDelay(800, 1_500));
    log(`✅ Mes Applications rechargée [${context}]`);
  } catch (err) {
    warn(`⚠️ Rafraîchissement [${context}] échoué : ${err}`);
  }
}

function isVowintLoginPage(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (u.includes('/account/') || u.includes('/login') || u.includes('returnurl')) return true;
  const isKnownRoute = u.includes('/visaapplication') || u.includes('/en/') || u.includes('/fr/') || u.includes('/nl/');
  const isRoot = new URL(url).pathname.replace(/\//g, '').length < 3;
  return !isKnownRoute && isRoot;
}

async function reloadAndWaitVowintTab(tabId) {
  return new Promise(resolve => {
    function onUpdated(updTabId, changeInfo) {
      if (updTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      if (chrome.runtime.lastError) { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(false); return; }
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(false); }, 30_000);
    });
  });
}

async function openVowintTab() {
  return new Promise(resolve => {
    chrome.tabs.create({ url: 'https://visaonweb.diplomatie.be', active: false }, tab => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      function onLoad(tabId, changeInfo) {
        if (tabId !== tab.id || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onLoad);
        resolve(tab);
      }
      chrome.tabs.onUpdated.addListener(onLoad);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(onLoad); resolve(tab); }, 30_000);
    });
  });
}

async function waitForTabLoad(tabId, timeoutMs = 25_000) {
  return new Promise(resolve => {
    function onUpdated(updTabId, changeInfo) {
      if (updTabId !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(false); }, timeoutMs);
  });
}

async function getStoredCredentials() {
  return new Promise(resolve => {
    chrome.storage.local.get(['vowintEmail', 'vowintPassword'], d => {
      resolve({ email: d.vowintEmail || '', password: d.vowintPassword || '' });
    });
  });
}

async function performAutoLogin(tabId, creds) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'AUTO_LOGIN', email: creds.email, password: creds.password }, resp => {
      if (chrome.runtime.lastError || !resp?.ok) {
        error(`❌ Login auto échoué: ${chrome.runtime.lastError?.message || resp?.error || '?'}`);
        resolve(false); return;
      }
      resolve(true);
    });
  });
}

async function ensureVowintSession() {
  let vowintTab = await getVowintTab();
  if (!vowintTab) {
    log('🌐 Ouverture onglet VOWINT (arrière-plan)…');
    setPhase('clicking', '🌐 Ouverture onglet VOWINT…');
    vowintTab = await openVowintTab();
    if (!vowintTab) { error('❌ Impossible d\'ouvrir l\'onglet VOWINT'); return null; }
    await sleep(1_500);
  } else {
    setPhase('clicking', '🔄 Rechargement VOWINT…');
    const reloaded = await reloadAndWaitVowintTab(vowintTab.id);
    if (reloaded) await sleep(randDelay(2_000, 4_500));
    else warn('⚠️ Rechargement timeout — tentative sans refresh');
  }
  if (!state.running) return null;

  const currentUrl = await getTabUrl(vowintTab.id);
  if (!isVowintLoginPage(currentUrl)) {
    if (!isVowintApplicationsPage(currentUrl)) {
      const lang = await resolveVowintLang(currentUrl);
      await navigateToApplicationsPage(vowintTab.id, lang);
      if (!state.running) return null;
    }
    return vowintTab;
  }

  const creds = await getStoredCredentials();
  if (!creds.email || !creds.password) {
    error('🔓 Session expirée — configure email + mot de passe VOWINT');
    notify('🔓 Session VOWINT expirée', 'Entre tes identifiants dans le popup.');
    state.running = false; state.phase = 'idle'; broadcastState(); return null;
  }
  log(`🔐 Connexion VOWINT (${creds.email})…`);
  setPhase('clicking', `🔐 Connexion VOWINT…`);
  const loginOk = await performAutoLogin(vowintTab.id, creds);
  if (!loginOk) { state.running = false; state.phase = 'idle'; broadcastState(); return null; }

  setPhase('clicking', '⏳ Redirection post-login…');
  await waitForTabLoad(vowintTab.id, 25_000);
  await sleep(randDelay(1_500, 2_500));
  const postLoginUrl = await getTabUrl(vowintTab.id);
  if (isVowintLoginPage(postLoginUrl)) {
    error('❌ Login VOWINT échoué — identifiants incorrects ?');
    notify('❌ Login VOWINT échoué', 'Vérifie email + mot de passe.');
    state.running = false; state.phase = 'idle'; broadcastState(); return null;
  }
  ok('✅ Connecté à VOWINT');
  if (!isVowintApplicationsPage(postLoginUrl)) {
    const lang = await resolveVowintLang(postLoginUrl);
    await navigateToApplicationsPage(vowintTab.id, lang);
    if (!state.running) return null;
  }
  return await getVowintTab() || vowintTab;
}

// ─── Boucle principale ────────────────────────────────────────────────────────

// Signal interne : le handler de message RATE_LIMITED / SERVER_ERROR
// pose ces promesses pour interrompre countdownWait proprement
let _rateLimitSignal = null;
let _serverErrorSignal = null;

async function runLoop() {
  chrome.alarms.create('sw_keepalive', { periodInMinutes: 1 });

  while (state.running) {

    // ── Sonnerie slot active → attendre acquittement ──────────────────────────
    if (state.alarmActive) { await sleep(5_000); continue; }

    // ── Rate-limit actif : attendre le temps restant ──────────────────────────
    const rlRemaining = getRateLimitRemaining();
    if (rlRemaining > 0) {
      const reason = state.rateLimitReason || 'trop de tentatives';
      const mins   = Math.ceil(rlRemaining / 60_000);
      setPhase('rate_limited',
        `🚫 Rate-limit CEV (${reason.slice(0, 50)}) — pause ${mins} min`);
      await countdownWait(rlRemaining, 'rate_limited');
      if (!state.running) break;
      ok('✅ Pause rate-limit terminée — reprise des scans');
      state.rateLimitStartTs = null;
      state.rateLimitReason  = null;
      broadcastState();
      continue;
    }

    // ── Rate-limit interne (self, nb clics/h) ─────────────────────────────────
    if (!canAttempt()) {
      const oldestClick = state.clickTimestamps[0];
      const waitUntil   = oldestClick + 60 * 60_000;
      const waitSec     = Math.ceil((waitUntil - Date.now()) / 1000);
      setPhase('retry', `⚠️ Limite ${MAX_CLICKS_PER_HOUR} scans/h — attente ${Math.round(waitSec/60)} min`);
      await countdownWait(waitSec * 1000);
      continue;
    }

    // ── Délai humain entre scans (sauf premier) ───────────────────────────────
    if (state.attempts > 0) {
      const delay  = humanLikeRetryDelay();
      const dMin   = Math.floor(delay / 60_000);
      const dSec   = Math.round((delay % 60_000) / 1000);
      setPhase('retry',
        `⏱ Prochain scan dans ${dMin}m${String(dSec).padStart(2,'0')}s (pause humaine)`);
      await countdownWait(delay);
      if (!state.running) break;
      // ── Rafraîchir Mes Applications après la pause ─────────────────────────
      await refreshMesApplications('après pause');
    }
    if (!state.running) break;

    // ── Session VOWINT ────────────────────────────────────────────────────────
    const vowintTab = await ensureVowintSession();
    if (!vowintTab || !state.running) break;

    // ── Pause "lecture" avant clic ────────────────────────────────────────────
    const readPause = randDelay(1_500, 3_500);
    setPhase('clicking', `👁 Scan arrière-plan… (${Math.round(readPause/1000)}s)`);
    await sleep(readPause);
    if (!state.running) break;

    // ── Fetch URL CEV via XHR (bypass window.open — fix Orion/WebKit iOS) ────────
    state.attempts++;
    state.lastAttemptTs = Date.now();
    recordAttempt();
    setPhase('clicking', `🔗 Essai #${state.attempts} — récupération URL CEV…`);

    // Le content script fait lui-même le XHR GetEAppointmentUrl et retourne l'URL
    const fetchResp = await new Promise(resolve => {
      chrome.tabs.sendMessage(
        vowintTab.id,
        { type: 'CLICK_RDV_BUTTON', vowintRef: state.vowintRef || null },
        resp => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'Pas de réponse du content script' });
        }
      );
      // Timeout si le content script ne répond pas
      // 35s = 12s attente Angular + humanPageScan + délai humain + XHR GetEAppointmentUrl
      setTimeout(() => resolve({ ok: false, error: 'Content script timeout (35s)' }), 35_000);
    });

    if (!fetchResp?.ok || !fetchResp?.cevUrl) {
      state.consecutiveNoTab = (state.consecutiveNoTab || 0) + 1;
      broadcastState();
      const errMsg = fetchResp?.error || 'URL CEV non obtenue';

      if (state.consecutiveNoTab >= SHADOWBAN_STOP_THRESHOLD) {
        error(`🚫 Shadowban probable — ${state.consecutiveNoTab} cycles sans URL CEV`);
        notify('🚫 Shadowban VOWINT', `${state.consecutiveNoTab} tentatives sans résultat. Attends 30-60 min.`);
        state.running = false; state.phase = 'idle'; broadcastState(); break;
      }
      if (state.consecutiveNoTab >= SHADOWBAN_WARN_THRESHOLD) {
        warn(`⚠️ ${state.consecutiveNoTab}× sans URL CEV : ${errMsg}`);
        notify('⚠️ Aucune URL CEV', `${state.consecutiveNoTab} fois de suite — ${errMsg.slice(0, 60)}`);
      } else {
        error(`❌ URL CEV non obtenue (${state.consecutiveNoTab}/${SHADOWBAN_STOP_THRESHOLD}): ${errMsg}`);
      }
      continue;
    }

    state.consecutiveNoTab = 0;
    log(`🌐 URL CEV obtenue → ouverture onglet (chrome.tabs.create)`);
    setPhase('captcha_solving', '🔒 Ouverture onglet CEV — captcha en cours…');

    // Ouvrir l'onglet CEV via chrome.tabs.create — pas de window.open → pas de popup blocker
    const cevTab = await new Promise(resolve => {
      chrome.tabs.create({ url: fetchResp.cevUrl, active: false }, tab => {
        if (chrome.runtime.lastError || !tab) { resolve(null); return; }
        // Attendre que l'onglet soit chargé (le content-cev.js s'injecte à document_idle)
        function onLoad(tabId, changeInfo) {
          if (tabId !== tab.id || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(onLoad);
          resolve(tab);
        }
        chrome.tabs.onUpdated.addListener(onLoad);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(onLoad); resolve(tab); }, 20_000);
      });
    });

    if (!cevTab) {
      error('❌ Impossible d\'ouvrir l\'onglet CEV via chrome.tabs.create');
      continue;
    }

    state.activeCevTabId = cevTab.id;
    setPhase('captcha_solving', '🔒 Onglet CEV ouvert — captcha en cours…');

    const result = await waitForCevResult(cevTab.id);
    state.activeCevTabId = null;

    if (result === 'slot_found') {
      setPhase('slot_found', `🚨 SLOT DÉTECTÉ — alerte active ! (essai #${state.attempts})`);
    } else if (result === 'rate_limited') {
      // applyRateLimit déjà appelé via le message RATE_LIMITED
    } else if (result === 'server_error') {
      // déjà traité via SERVER_ERROR message
    } else if (result === 'no_availability' || result === 'tab_closed' || result === 'timeout') {
      setPhase('retry', `❌ Essai #${state.attempts} : aucune dispo`);
      // ── Rafraîchir Mes Applications immédiatement avant la pause ───────────
      if (vowintTab) await refreshMesApplications('après scan', vowintTab.id);
    } else {
      warn(`⚠️ Résultat: ${result}`);
    }
  }

  chrome.alarms.clear('sw_keepalive');
  if (!state.running && state.phase !== 'slot_found') {
    setPhase('idle', '⏹ Watcher arrêté');
  }
}

// ─── Attente onglet CEV ───────────────────────────────────────────────────────

function waitForNewCevTab(timeoutMs) {
  return new Promise(resolve => {
    let resolved = false;
    const timer = setTimeout(() => { cleanup(); if (!resolved) { resolved = true; resolve(null); } }, timeoutMs);
    function cleanup() {
      chrome.tabs.onCreated.removeListener(createdListener);
      chrome.tabs.onUpdated.removeListener(updatedListener);
    }
    function createdListener(tab) {
      if (tab.url && tab.url.includes('appointment.cloud.diplomatie.be')) {
        clearTimeout(timer); cleanup(); if (!resolved) { resolved = true; resolve(tab); }
      }
    }
    function updatedListener(tabId, changeInfo) {
      if (changeInfo.url && changeInfo.url.includes('appointment.cloud.diplomatie.be')) {
        clearTimeout(timer); cleanup();
        if (!resolved) { resolved = true; chrome.tabs.get(tabId, t => resolve(t)); }
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
      if (url.includes('noavailability') || url.includes('no-availability') || url.includes('error'))
        done('no_availability');
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

async function countdownWait(ms, phase = 'retry') {
  const step = 5_000;
  let remaining = ms;
  while (remaining > 0 && state.running) {
    state.nextRetryIn = Math.ceil(remaining / 1000);
    broadcastState();
    await sleep(Math.min(step, remaining));
    remaining -= step;

    // Re-vérifier si un rate-limit est arrivé pendant le countdown
    // (message reçu asynchronement) — on laisse le runLoop le gérer au prochain tour
  }
  state.nextRetryIn = null;
}

// ─── Messages entrants ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'START': {
      if (msg.applicationId !== undefined) {
        state.applicationId = msg.applicationId || null;
        state.vowintRef     = msg.applicationId || null; // alias utilisé par content-vowint
      }
      if (!state.running) {
        state.running    = true;
        state.phase      = 'idle';
        state.alarmActive = false;
        state.slotFound  = null;
        startStatusAlarm();
        runLoop();
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'STOP': {
      state.running      = false;
      state.phase        = 'idle';
      state.nextRetryIn  = null;
      if (state.activeCevTabId) {
        chrome.tabs.remove(state.activeCevTabId, () => {});
        state.activeCevTabId = null;
      }
      stopAlarm();
      stopStatusAlarm();
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'ACKNOWLEDGE_SLOT': {
      stopAlarm().then(() => {
        state.slotFound = null;
        state.phase = state.running ? 'retry' : 'idle';
        broadcastState();
      });
      sendResponse({ ok: true });
      break;
    }

    // ── Rate-limit signalé par content-cev.js ───────────────────────────────
    case 'RATE_LIMITED': {
      const reason = `[${msg.source}] ${msg.reason}`;
      applyRateLimit(reason);
      setPhase('rate_limited', `🚫 Rate-limit — ${reason.slice(0, 80)}`);
      // Signaler la fin du résultat CEV en attente
      if (pendingCevResultResolver) {
        pendingCevResultResolver('rate_limited');
        pendingCevResultResolver = null;
      }
      sendResponse({ ok: true });
      break;
    }

    // ── Erreur serveur signalée par content-cev.js ───────────────────────────
    case 'SERVER_ERROR': {
      const { source, status, category, reason } = msg;

      if (category === 'conflict') {
        // 409 : normal, le slot était peut-être pris — ne pas interrompre
        warn(`⚠️ Conflit 409 [${source}] — slot pris entre-temps, on continue`);
        sendResponse({ ok: true });
        break;
      }

      if (category === 'session') {
        warn(`🔓 Session invalide [${source}] HTTP ${status} — relance session`);
        if (pendingCevResultResolver) {
          pendingCevResultResolver('session_error');
          pendingCevResultResolver = null;
        }
        sendResponse({ ok: true });
        break;
      }

      // down / timeout / storm
      const { type: sType, pauseMs } = classifyServerErrorResponse(category || 'down');
      const pauseMin = Math.round(pauseMs / 60_000);

      setPhase('server_error',
        `⚠️ Erreur serveur ${status} [${source}] ${sType} — pause ${pauseMin} min`);

      if (pendingCevResultResolver) {
        pendingCevResultResolver('server_error');
        pendingCevResultResolver = null;
      }

      // Démarrer la pause directement (hors boucle) pour ce cycle
      // La boucle reprendra après la fin de countdownWait via CEV_RESULT 'server_error'
      // puis humanLikeRetryDelay sera ajouté normalement
      state._serverPausePending = { pauseMs };
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'SOLVE_CAPTCHA': {
      const { sitekey, siteUrl } = msg;
      chrome.storage.local.get(['anticaptchaKey'], async ({ anticaptchaKey }) => {
        if (!anticaptchaKey) { sendResponse({ ok: false, error: 'Clé Anti-Captcha manquante' }); return; }
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

    case 'VOWINT_LOGIN_PAGE': {
      if (!state.running) addLog('warn', '🔓 Session VOWINT expirée — configure identifiants et lance ▶');
      break;
    }

    case 'SLOT_FOUND': {
      const slot = msg.slot || null;
      ok(`🚨 Slot: ${slot?.date || '?'} ${slot?.time || ''}`);
      startAlarm(slot);
      if (pendingCevResultResolver) {
        pendingCevResultResolver('slot_found');
        pendingCevResultResolver = null;
      }
      sendResponse({ ok: true });
      break;
    }

    case 'CEV_RESULT': {
      log(`📩 CEV result: ${msg.result}`);
      if (!['slot_found', 'rate_limited', 'server_error'].includes(msg.result)) {
        if (pendingCevResultResolver) {
          pendingCevResultResolver(msg.result);
          pendingCevResultResolver = null;
        }
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
      state.consecutiveNoTab = 0;
      state.slotFound = null;
      state.rateLimitStartTs = null;
      state.rateLimitReason = null;
      state.serverErrorTs = [];
      stopAlarm();
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'CLEAR_RATE_LIMIT': {
      // Forcer la levée manuelle du rate-limit (bouton dans popup)
      state.rateLimitStartTs = null;
      state.rateLimitReason  = null;
      if (state.phase === 'rate_limited') {
        state.phase = state.running ? 'retry' : 'idle';
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }
  }
});

log('CEV Slot Hunter v3.1 — réaction intelligente aux erreurs serveur');
