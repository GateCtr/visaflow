/**
 * background.js — CEV Slot Hunter v4.0
 *
 * Nouveautés v4 :
 *   • Round-robin multi-dossiers — liste tous les dossiers actifs VOWINT en mémoire,
 *     scanne chacun à tour de rôle ; aucun dossier cible = mode automatique
 *   • Intervalle 1 min + jitter log-normal humain (≈1:00–2:30, concentré ~1:10)
 *   • Détection page VOWINT via content script (LOGIN_PAGE, APPS_PAGE, UNKNOWN)
 *   • Sync bouton démarrer/arrêter robuste (SW keepalive + re-wake detect)
 *   • Anti-shadow-ban : shadowban counter par dossier, rotation forcée si bloqué
 *
 * Réaction erreurs :
 *   RATE_LIMITED  (429, 403 WAF, body keywords) → Pause 60 min ancrée (1er hit)
 *   SERVER_ERROR  down (5xx)                    → Pause 10 min
 *   SERVER_ERROR  timeout (504, réseau)          → Pause 5 min
 *   SERVER_ERROR  session (401, 410)             → Re-login VOWINT
 *   SERVER_ERROR  conflict (409)                 → Continuer (slot pris)
 *   Consécutives ≥3 en 10 min                   → Pause 20 min (storm)
 */

'use strict';

// ─── Constantes ──────────────────────────────────────────────────────────────

const RATE_LIMIT_PAUSE_MS     = 60 * 60_000;   // 60 min
const SERVER_DOWN_PAUSE_MS    = 10 * 60_000;   // 10 min
const SERVER_TIMEOUT_PAUSE_MS =  5 * 60_000;   //  5 min
const SERVER_STORM_PAUSE_MS   = 20 * 60_000;   // 20 min
const SERVER_STORM_THRESHOLD  = 3;
const SERVER_STORM_WINDOW_MS  = 10 * 60_000;

const SHADOWBAN_WARN_THRESHOLD = 3;   // consecutiveNoUrl avant warn
const SHADOWBAN_STOP_THRESHOLD = 6;   // consecutiveNoUrl avant stop

// Intervalle entre scans : 1 min base + jitter log-normal
const SCAN_BASE_INTERVAL_MS = 60_000;  // 1 min

// ─── État ────────────────────────────────────────────────────────────────────

let state = {
  running:          false,
  phase:            'idle',
  attempts:         0,
  captchasSolved:   0,
  lastAttemptTs:    null,
  activeCevTabId:   null,
  logs:             [],
  nextRetryIn:      null,
  applicationId:    null,   // dossier cible fixe (null = round-robin auto)
  consecutiveNoUrl: 0,      // nombre de cycles consécutifs sans URL CEV
  slotFound:        null,
  alarmActive:      false,

  // ── Round-robin pool ──
  dossierPool:      [],     // [{ appId, ref, label }] — tous les dossiers VOWINT
  rrIndex:          0,      // index courant dans le pool
  currentDossier:   null,   // { appId, ref, label } — dossier en cours de scan

  // ── Gestion erreurs ──
  rateLimitStartTs:       null,
  rateLimitReason:        null,
  serverErrorTs:          [],
  lastServerErrorCategory:null,
  serverPauseUntil:       null,   // timestamp fin de pause serveur (5/10/20 min)
};

// Restaurer l'état depuis le storage au démarrage du SW
chrome.storage.local.get(['cevState'], (d) => {
  if (d.cevState) {
    state = { ...state, ...d.cevState };
    if (state.running) {
      state.running    = false;
      state.phase      = 'idle';
      state.activeCevTabId = null;
      state.alarmActive = false;
      addLog('warn', '⚠️ Watcher interrompu (SW redémarré) — relancer manuellement');
    }
    if (state.rateLimitStartTs) {
      const rem = RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs);
      if (rem <= 0) { state.rateLimitStartTs = null; state.rateLimitReason = null; }
      else addLog('warn', `⏸ Rate-limit encore actif — ${Math.ceil(rem / 60_000)} min restantes`);
    }
  }
});

function persistState() {
  chrome.storage.local.set({ cevState: state });
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function addLog(level, msg) {
  state.logs.unshift({ ts: Date.now(), level, msg });
  if (state.logs.length > 200) state.logs.length = 200;
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
    const level = phase === 'slot_found'  ? 'ok'
                : ['retry','rate_limited','server_error'].includes(phase) ? 'warn'
                : 'info';
    addLog(level, logMsg);
  }
  broadcastState();
  updateStatusNotification();
}

// ─── Rate-limit ───────────────────────────────────────────────────────────────

function applyRateLimit(reason) {
  const now = Date.now();
  if (!state.rateLimitStartTs) {
    state.rateLimitStartTs = now;
    state.rateLimitReason  = reason;
    error(`🚫 RATE-LIMIT — pause 60 min | ${reason}`);
    notify('🚫 CEV : trop de tentatives', `Pause 60 min. ${reason.slice(0, 80)}`);
  } else {
    const rem = RATE_LIMIT_PAUSE_MS - (now - state.rateLimitStartTs);
    if (rem <= 0) {
      state.rateLimitStartTs = now;
      state.rateLimitReason  = reason;
      error(`🚫 RATE-LIMIT (nouveau cycle) — 60 min | ${reason}`);
      notify('🚫 CEV : nouveau rate-limit', `Pause 60 min. ${reason.slice(0, 60)}`);
    } else {
      warn(`⏸ RATE-LIMIT déjà actif — ${Math.ceil(rem / 60_000)} min restantes`);
    }
  }
  broadcastState();
  return Math.max(0, RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs));
}

function getRateLimitRemaining() {
  if (!state.rateLimitStartTs) return 0;
  const rem = RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs);
  if (rem <= 0) {
    state.rateLimitStartTs = null;
    state.rateLimitReason  = null;
    broadcastState();
    return 0;
  }
  return rem;
}

// ─── Storm detection ──────────────────────────────────────────────────────────

function classifyServerErrorResponse(category) {
  const now = Date.now();
  state.serverErrorTs = (state.serverErrorTs || []).filter(t => now - t < SERVER_STORM_WINDOW_MS);
  state.serverErrorTs.push(now);
  state.lastServerErrorCategory = category;

  if (state.serverErrorTs.length >= SERVER_STORM_THRESHOLD) {
    error(`🌩️ Storm serveur — ${state.serverErrorTs.length} erreurs → pause ${SERVER_STORM_PAUSE_MS / 60_000} min`);
    notify('🌩️ CEV instable', `${state.serverErrorTs.length} erreurs — pause ${SERVER_STORM_PAUSE_MS/60_000} min`);
    state.serverErrorTs = [];
    return { type: 'storm', pauseMs: SERVER_STORM_PAUSE_MS };
  }

  const pauseMs = category === 'timeout' ? SERVER_TIMEOUT_PAUSE_MS : SERVER_DOWN_PAUSE_MS;
  warn(`⚠️ Erreur serveur [${category}] — pause ${pauseMs / 60_000} min`);
  return { type: category, pauseMs };
}

// ─── Audio / Offscreen ───────────────────────────────────────────────────────

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

// ─── Alarme slot ──────────────────────────────────────────────────────────────

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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'slot_reminder' && state.alarmActive) {
    await sendOffscreen('ALARM_PING');
    const slot = state.slotFound;
    chrome.notifications.create(`slot_alert_${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: '🚨 CRÉNEAU CEV DISPONIBLE !',
      message: slot
        ? `📅 ${slot.date || '?'} ${slot.time || ''} — Acquitte dans l'extension.`
        : 'Créneau disponible — acquitte dans l\'extension.',
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

// ─── Notification statut persistante ─────────────────────────────────────────

const STATUS_NOTIF_ID = 'cev_live_status';

function fmtMs(ms) {
  if (ms <= 0) return '0s';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function buildStatusContent() {
  const phase = state.phase || 'idle';
  const dossierInfo = state.currentDossier
    ? ` [${state.currentDossier.ref || state.currentDossier.appId.slice(0,8)}]`
    : '';

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

  if (phase === 'rate_limited' && state.rateLimitStartTs) {
    const rem = RATE_LIMIT_PAUSE_MS - (Date.now() - state.rateLimitStartTs);
    return {
      title:   '🚫 CEV Slot Hunter — Pause rate-limit',
      message: `⏳ Reprise dans ${fmtMs(rem)}\n🔍 ${state.attempts} scans`,
      iconUrl: 'icons/icon48.png',
    };
  }

  if (!state.running || phase === 'idle') {
    return {
      title:   '⏸ CEV Slot Hunter — Inactif',
      message: `${state.attempts > 0 ? `🔍 ${state.attempts} scans · ` : ''}Appuie ▶ pour relancer`,
      iconUrl: 'icons/icon48.png',
    };
  }

  if (phase === 'server_error') {
    const wait = state.nextRetryIn ? `Reprise dans ${fmtMs(state.nextRetryIn * 1000)}` : 'Reprise bientôt…';
    return {
      title:   '⚠️ CEV Slot Hunter — Erreur serveur',
      message: `${wait}\n🔍 ${state.attempts} scans · 🔒 ${state.captchasSolved} captchas`,
      iconUrl: 'icons/icon48.png',
    };
  }

  const phaseLabel = {
    clicking:        `🖱 Récupération URL CEV${dossierInfo}…`,
    captcha_solving: '🔒 Résolution captcha…',
    waiting_result:  '🔍 Scan disponibilités…',
    retry: state.nextRetryIn
      ? `⏱ Prochain scan dans ${fmtMs(state.nextRetryIn * 1000)}${dossierInfo}`
      : '⏱ Pause humaine…',
  }[phase] || `🔄 ${phase}`;

  const poolInfo = state.dossierPool.length > 1
    ? ` · ${state.dossierPool.length} dossiers` : '';
  const hhmm = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  return {
    title:   '🎯 CEV Slot Hunter — En cours',
    message: `${phaseLabel}\n🔍 ${state.attempts} scans · 🔒 ${state.captchasSolved} captchas${poolInfo} · ${hhmm}`,
    iconUrl: 'icons/icon48.png',
  };
}

function updateStatusNotification() {
  if (!state.running && state.phase === 'idle' && state.attempts === 0) {
    chrome.notifications.clear(STATUS_NOTIF_ID, () => {});
    return;
  }
  const { title, message, iconUrl } = buildStatusContent();
  chrome.notifications.update(STATUS_NOTIF_ID, { type: 'basic', iconUrl, title, message, priority: 1 },
    (wasUpdated) => {
      if (!wasUpdated) {
        chrome.notifications.create(STATUS_NOTIF_ID, {
          type: 'basic', iconUrl, title, message, priority: 1, isClickable: true,
        });
      }
    });
}

function startStatusAlarm() {
  chrome.alarms.create('cev_status', { periodInMinutes: 0.5 });
  updateStatusNotification();
}

function stopStatusAlarm() {
  chrome.alarms.clear('cev_status');
  chrome.notifications.clear(STATUS_NOTIF_ID, () => {});
}

function notify(title, message) {
  chrome.notifications.create(`notif_${Date.now()}`, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title, message, priority: 2,
  });
}

// ─── Round-Robin dossier pool ─────────────────────────────────────────────────

/**
 * Met à jour le pool de dossiers depuis la réponse content-vowint.
 * `dossiers` = [{ appId, ref, label }]
 */
function updateDossierPool(dossiers) {
  if (!Array.isArray(dossiers) || !dossiers.length) return;

  const prev = state.dossierPool.length;
  // Fusionner : conserver les entrées existantes (pour garder le rrIndex stable)
  // Ajouter les nouvelles, supprimer les disparues
  const newPool = dossiers.filter(d => d.appId);
  if (newPool.length === 0) return;

  state.dossierPool = newPool;
  // Ajuster rrIndex si hors bornes
  if (state.rrIndex >= state.dossierPool.length) state.rrIndex = 0;

  if (prev !== newPool.length) {
    log(`📋 Pool dossiers mis à jour : ${newPool.length} dossier(s) — ${newPool.map(d => d.ref || d.appId.slice(0,8)).join(', ')}`);
  }
}

/**
 * Retourne le prochain dossier à scanner (round-robin).
 * Si un dossier cible est fixé (state.applicationId), le retourne à la place.
 */
function pickNextDossier() {
  // Mode cible fixe
  if (state.applicationId) {
    // Chercher dans le pool
    const target = state.dossierPool.find(d =>
      d.ref === state.applicationId ||
      d.appId === state.applicationId ||
      (d.ref && state.applicationId.includes(d.ref)) ||
      (d.ref && d.ref.includes(state.applicationId))
    );
    if (target) return target;
    // Pas encore dans le pool — on laisse content-vowint sélectionner par ref
    return null;
  }

  // Mode round-robin automatique
  if (!state.dossierPool.length) return null;
  const dossier = state.dossierPool[state.rrIndex % state.dossierPool.length];
  state.rrIndex = (state.rrIndex + 1) % state.dossierPool.length;
  return dossier;
}

// ─── Délai humain log-normal ──────────────────────────────────────────────────

/**
 * Délai entre scans : 1 min base + jitter log-normal.
 * Distribution : μ~1:10, max ~2:30, concentrée sur 1:00-1:30.
 * Simule un humain qui attend la fin de la page puis agit.
 */
function humanLikeRetryDelay() {
  // Box-Muller → distribution normale → log-normale
  const u1 = Math.max(1e-10, Math.random());
  const u2  = Math.random();
  const normal    = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const lognormal = Math.exp(0.4 + 0.55 * normal); // μ=0.4, σ=0.55
  const jitter    = Math.min(Math.round(lognormal * 18_000), 90_000); // max 90s
  return SCAN_BASE_INTERVAL_MS + jitter; // 1:00 → ~2:30
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
    const res = await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const result = await res.json();
    if (result.errorId !== 0) throw new Error(`Anti-Captcha: ${result.errorCode}`);
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const m = url.match(/visaonweb\.diplomatie\.be\/([a-z]{2})\//i);
  if (m) {
    const lang = m[1].toLowerCase();
    if (['fr', 'en', 'nl'].includes(lang)) return lang;
  }
  const rm = url.match(/[?&]ReturnUrl=(?:%2F|\/)(en|fr|nl)/i);
  if (rm) return rm[1].toLowerCase();
  return null;
}

function getApplicationsUrl(lang = 'en') {
  return `https://visaonweb.diplomatie.be/${lang}/VisaApplication/IndexByUserId`;
}

function saveVowintLang(lang) { chrome.storage.local.set({ vowintLang: lang }); }

function getStoredVowintLang() {
  return new Promise(resolve => {
    chrome.storage.local.get(['vowintLang'], d => resolve(d.vowintLang || 'en'));
  });
}

async function resolveVowintLang(url) {
  const detected = detectVowintLang(url);
  if (detected) { saveVowintLang(detected); return detected; }
  return await getStoredVowintLang();
}

function isVowintApplicationsPage(url) {
  return !!url && url.toLowerCase().includes('/visaapplication/indexbyuserid');
}

async function navigateToApplicationsPage(tabId, lang) {
  const resolvedLang = lang || await getStoredVowintLang();
  const targetUrl    = getApplicationsUrl(resolvedLang);
  log(`🗂 Navigation Mes Applications (${resolvedLang})`);
  setPhase('clicking', `🗂 Navigation vers Mes Applications…`);
  await new Promise(resolve => chrome.tabs.update(tabId, { url: targetUrl }, () => resolve()));
  await waitForTabLoad(tabId, 25_000);
  await sleep(randDelay(2_000, 3_500));
}


function isVowintLoginPage(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (u.includes('/account/') || u.includes('/login') || u.includes('returnurl')) return true;
  const isKnownRoute = u.includes('/visaapplication') || u.includes('/en/') || u.includes('/fr/') || u.includes('/nl/');
  const isRoot = new URL(url).pathname.replace(/\//g, '').length < 3;
  return !isKnownRoute && isRoot;
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
    chrome.tabs.sendMessage(tabId,
      { type: 'AUTO_LOGIN', email: creds.email, password: creds.password },
      resp => {
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

// ─── Sonde dossiers (pré-scan) ────────────────────────────────────────────────

/**
 * S'assure que content-vowint.js est bien injecté dans l'onglet.
 * Si le ping échoue ("Receiving end does not exist"), injecte le script
 * via chrome.scripting et attend qu'il soit prêt (max 5s).
 */
async function ensureContentScript(tabId) {
  const ping = () => new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, resp => {
      resolve(!chrome.runtime.lastError && resp?.ok);
    });
  });

  if (await ping()) return true;

  // Content script absent → injection programmatique
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ['content-vowint.js'],
    });
  } catch (e) {
    warn(`⚠️ Injection content script échouée : ${e.message}`);
    return false;
  }

  // Attendre jusqu'à 5s qu'il soit prêt
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (await ping()) { ok('✅ Content script injecté'); return true; }
  }
  warn('⚠️ Content script injecté mais pas de réponse au ping');
  return false;
}

/**
 * Demande au content-vowint de lister tous les appIds sans déclencher de scan.
 * Met à jour le pool si la réponse contient des dossiers.
 */
async function probeDossierPool(tabId) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'LIST_DOSSIERS' }, resp => {
      if (chrome.runtime.lastError || !resp?.ok) { resolve(false); return; }
      if (resp.dossiers?.length) {
        updateDossierPool(resp.dossiers);
      }
      resolve(true);
    });
    setTimeout(() => resolve(false), 15_000);
  });
}

// ─── Boucle principale ────────────────────────────────────────────────────────

let pendingCevResultResolver = null;

async function runLoop() {
  chrome.alarms.create('sw_keepalive', { periodInMinutes: 1 });

  while (state.running) {

    // ── Sonnerie active → attendre acquittement ───────────────────────────────
    if (state.alarmActive) { await sleep(5_000); continue; }

    // ── Pause serveur active (5/10/20 min) ───────────────────────────────────
    if (state.serverPauseUntil) {
      const rem = state.serverPauseUntil - Date.now();
      if (rem > 0) {
        const mins = Math.ceil(rem / 60_000);
        setPhase('server_error', `⚠️ Pause serveur — reprise dans ${mins} min`);
        await countdownWait(rem);
        if (!state.running) break;
        state.serverPauseUntil = null;
        ok('✅ Pause serveur terminée — reprise');
        broadcastState();
        continue;
      } else {
        state.serverPauseUntil = null;
      }
    }

    // ── Rate-limit actif ──────────────────────────────────────────────────────
    const rlRemaining = getRateLimitRemaining();
    if (rlRemaining > 0) {
      const reason = state.rateLimitReason || 'trop de tentatives';
      const mins   = Math.ceil(rlRemaining / 60_000);
      setPhase('rate_limited', `🚫 Rate-limit CEV (${reason.slice(0, 50)}) — pause ${mins} min`);
      await countdownWait(rlRemaining);
      if (!state.running) break;
      ok('✅ Pause rate-limit terminée — reprise');
      state.rateLimitStartTs = null;
      state.rateLimitReason  = null;
      broadcastState();
      continue;
    }

    // ── Délai humain entre scans ──────────────────────────────────────────────
    if (state.attempts > 0) {
      const delay = humanLikeRetryDelay();
      const dMin  = Math.floor(delay / 60_000);
      const dSec  = Math.round((delay % 60_000) / 1000);

      // Indiquer le prochain dossier dans le message de pause
      const nextD = state.dossierPool.length > 0
        ? state.dossierPool[state.rrIndex % state.dossierPool.length]
        : null;
      const nextLabel = nextD ? ` → ${nextD.ref || nextD.appId.slice(0,8)}` : '';

      setPhase('retry',
        `⏱ Pause ${dMin}m${String(dSec).padStart(2,'0')}s${nextLabel} (humaine)`);
      await countdownWait(delay);
      if (!state.running) break;
    }
    if (!state.running) break;

    // ── Session VOWINT ────────────────────────────────────────────────────────
    const vowintTab = await ensureVowintSession();
    if (!vowintTab || !state.running) break;

    // ── S'assurer que le content script est actif (injection si besoin) ───────
    const csReady = await ensureContentScript(vowintTab.id);
    if (!csReady) {
      error('❌ Content script VOWINT introuvable — onglet non compatible ?');
      state.running = false; state.phase = 'idle'; broadcastState(); break;
    }

    // ── Sonde le pool de dossiers si vide ou premier scan ─────────────────────
    if (state.dossierPool.length === 0 || state.attempts === 0) {
      await probeDossierPool(vowintTab.id);
    }

    // ── Sélection du prochain dossier ─────────────────────────────────────────
    const targetDossier = pickNextDossier();
    state.currentDossier = targetDossier;
    broadcastState();

    const dossierLabel = targetDossier
      ? `[${targetDossier.ref || targetDossier.appId.slice(0,8)}]`
      : '[auto]';

    // ── Pause "lecture" avant action ──────────────────────────────────────────
    const readPause = randDelay(1_200, 3_000);
    setPhase('clicking', `👁 Lecture VOWINT ${dossierLabel}… (${Math.round(readPause/1000)}s)`);
    await sleep(readPause);
    if (!state.running) break;

    // ── Fetch URL CEV via XHR ─────────────────────────────────────────────────
    state.attempts++;
    state.lastAttemptTs = Date.now();
    setPhase('clicking', `🔗 Essai #${state.attempts} ${dossierLabel} — récupération URL CEV…`);

    const fetchResp = await new Promise(resolve => {
      chrome.tabs.sendMessage(
        vowintTab.id,
        {
          type:        'CLICK_RDV_BUTTON',
          vowintRef:   state.applicationId || null,
          targetAppId: targetDossier?.appId || null,
        },
        resp => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: 'Pas de réponse du content script' });
        }
      );
      setTimeout(() => resolve({ ok: false, error: 'Content script timeout (60s)' }), 60_000);
    });

    // Mettre à jour le pool si le content script a retourné des dossiers
    if (fetchResp?.dossiers?.length) {
      updateDossierPool(fetchResp.dossiers);
    }

    if (!fetchResp?.ok || !fetchResp?.cevUrl) {
      state.consecutiveNoUrl = (state.consecutiveNoUrl || 0) + 1;
      broadcastState();
      const errMsg = fetchResp?.error || 'URL CEV non obtenue';

      if (state.consecutiveNoUrl >= SHADOWBAN_STOP_THRESHOLD) {
        error(`🚫 Shadowban probable — ${state.consecutiveNoUrl}× sans URL CEV — arrêt`);
        notify('🚫 Shadowban VOWINT',
          `${state.consecutiveNoUrl} tentatives sans résultat. Attends 30-60 min.`);
        state.running = false; state.phase = 'idle'; broadcastState(); break;
      }
      if (state.consecutiveNoUrl >= SHADOWBAN_WARN_THRESHOLD) {
        warn(`⚠️ ${state.consecutiveNoUrl}× sans URL CEV : ${errMsg}`);
        notify('⚠️ Aucune URL CEV',
          `${state.consecutiveNoUrl} fois — ${errMsg.slice(0, 60)}`);
      } else {
        error(`❌ URL CEV non obtenue (${state.consecutiveNoUrl}/${SHADOWBAN_STOP_THRESHOLD}): ${errMsg}`);
      }
      continue;
    }

    state.consecutiveNoUrl = 0;
    log(`🌐 URL CEV → ouverture onglet ${dossierLabel}`);
    setPhase('captcha_solving', `🔒 Onglet CEV ${dossierLabel} — captcha…`);

    // ── Ouvrir l'onglet CEV ───────────────────────────────────────────────────
    const cevTab = await new Promise(resolve => {
      chrome.tabs.create({ url: fetchResp.cevUrl, active: false }, tab => {
        if (chrome.runtime.lastError || !tab) { resolve(null); return; }
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
      error('❌ Impossible d\'ouvrir l\'onglet CEV');
      continue;
    }

    state.activeCevTabId = cevTab.id;
    setPhase('captcha_solving', `🔒 Onglet CEV ouvert ${dossierLabel} — captcha…`);

    const result = await waitForCevResult(cevTab.id);
    state.activeCevTabId = null;

    if (result === 'slot_found') {
      setPhase('slot_found', `🚨 SLOT DÉTECTÉ ${dossierLabel} ! (essai #${state.attempts})`);
    } else if (result === 'rate_limited') {
      // applyRateLimit déjà appelé
    } else if (result === 'server_error') {
      // traité via SERVER_ERROR message
    } else if (['no_availability', 'tab_closed', 'timeout'].includes(result)) {
      setPhase('retry', `❌ Essai #${state.attempts} ${dossierLabel} : aucune dispo`);
    } else {
      warn(`⚠️ Résultat: ${result}`);
    }
  }

  chrome.alarms.clear('sw_keepalive');
  if (!state.running && state.phase !== 'slot_found') {
    setPhase('idle', '⏹ Watcher arrêté');
  }
}

// ─── Attente résultat CEV ─────────────────────────────────────────────────────

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
      if (msg.applicationId !== undefined) {
        state.applicationId = msg.applicationId || null;
      }
      if (!state.running) {
        state.running     = true;
        state.phase       = 'idle';
        state.alarmActive = false;
        state.slotFound   = null;
        startStatusAlarm();
        runLoop();
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'STOP': {
      state.running     = false;
      state.phase       = 'idle';
      state.nextRetryIn = null;
      state.currentDossier = null;
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

    case 'RATE_LIMITED': {
      const reason = `[${msg.source}] ${msg.reason}`;
      applyRateLimit(reason);
      setPhase('rate_limited', `🚫 Rate-limit — ${reason.slice(0, 80)}`);
      if (pendingCevResultResolver) {
        pendingCevResultResolver('rate_limited');
        pendingCevResultResolver = null;
      }
      sendResponse({ ok: true });
      break;
    }

    case 'SERVER_ERROR': {
      const { source, status, category } = msg;

      if (category === 'conflict') {
        warn(`⚠️ Conflit 409 [${source}] — slot pris, on continue`);
        sendResponse({ ok: true }); break;
      }

      if (category === 'session') {
        warn(`🔓 Session invalide [${source}] HTTP ${status} — relance`);
        if (pendingCevResultResolver) {
          pendingCevResultResolver('session_error');
          pendingCevResultResolver = null;
        }
        sendResponse({ ok: true }); break;
      }

      const { type: sType, pauseMs } = classifyServerErrorResponse(category || 'down');
      const pauseMin = Math.round(pauseMs / 60_000);
      setPhase('server_error',
        `⚠️ Erreur serveur ${status} [${source}] ${sType} — pause ${pauseMin} min`);

      // Stocker l'heure de fin de pause — runLoop() la respecte au prochain tour
      state.serverPauseUntil = Date.now() + pauseMs;

      if (pendingCevResultResolver) {
        pendingCevResultResolver('server_error');
        pendingCevResultResolver = null;
      }

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

    case 'VOWINT_PAGE_TYPE': {
      // Signalé par content-vowint au chargement de page
      const { pageType, dossiers } = msg;
      if (dossiers?.length) updateDossierPool(dossiers);
      if (!state.running && pageType === 'login') {
        addLog('warn', '🔓 Session VOWINT expirée — configure identifiants et lance ▶');
      }
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
      state.attempts         = 0;
      state.captchasSolved   = 0;
      state.logs             = [];
      state.consecutiveNoUrl = 0;
      state.slotFound        = null;
      state.rateLimitStartTs = null;
      state.rateLimitReason  = null;
      state.serverErrorTs    = [];
      state.serverPauseUntil = null;
      state.dossierPool      = [];
      state.rrIndex          = 0;
      state.currentDossier   = null;
      stopAlarm();
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'CLEAR_RATE_LIMIT': {
      state.rateLimitStartTs = null;
      state.rateLimitReason  = null;
      if (state.phase === 'rate_limited') {
        state.phase = state.running ? 'retry' : 'idle';
      }
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'SET_APPLICATION_ID': {
      state.applicationId = msg.applicationId || null;
      broadcastState();
      sendResponse({ ok: true });
      break;
    }
  }
});

log('CEV Slot Hunter v4.0 — round-robin multi-dossiers · 1 min jitter · anti-shadowban');
