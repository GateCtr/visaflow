/**
 * background.js — CEV Slot Hunter v3.0 (Manifest V3 / Service Worker)
 *
 * CHANGEMENTS v3 :
 *  - Mode détection uniquement : aucune réservation automatique.
 *    Dès qu'un slot est trouvé → sonnerie répétée + notifications jusqu'à acquittement.
 *  - Délai entre scans : 2 min base + pause non-linéaire aléatoire (simulation humain paresseux).
 *  - Fonctionne en arrière-plan : plus besoin que l'onglet soit actif/visible.
 *  - Détection complète des erreurs serveur et 4xx après captcha.
 *  - Alarme chrome.alarms pour réveiller le SW même si le navigateur est minimisé.
 */

'use strict';

const MAX_CLICKS_PER_HOUR = 4;

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
  slotFound: null,        // { date, time, id } du dernier slot détecté
  alarmActive: false,     // sonnerie en cours
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
    const level = phase === 'success' || phase === 'slot_found' ? 'ok'
                : phase === 'retry' ? 'warn'
                : 'info';
    addLog(level, logMsg);
  }
  broadcastState();
}

// ─── Offscreen (sonnerie audio) ───────────────────────────────────────────────

async function ensureOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument().catch(() => false);
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Sonnerie d\'alerte slot disponible',
      });
    }
  } catch (_) {}
}

async function sendOffscreen(type) {
  await ensureOffscreen();
  try {
    chrome.runtime.sendMessage({ type });
  } catch (_) {}
}

// ─── Sonnerie répétée (slot trouvé) ───────────────────────────────────────────

async function startAlarm(slot) {
  state.alarmActive = true;
  state.slotFound = slot;
  broadcastState();

  await sendOffscreen('ALARM_START');

  // Notification initiale
  chrome.notifications.create('slot_alert', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '🚨 CRÉNEAU CEV DISPONIBLE !',
    message: slot
      ? `📅 ${slot.date || '?'} ${slot.time || ''} — Ouvre le portail CEV maintenant !`
      : 'Un créneau est disponible — agis vite !',
    priority: 2,
    requireInteraction: true,
  });

  // Alarme chrome.alarms pour ré-alerter toutes les 30s même si le SW dort
  chrome.alarms.create('slot_reminder', { periodInMinutes: 0.5 });
}

async function stopAlarm() {
  state.alarmActive = false;
  broadcastState();
  chrome.alarms.clear('slot_reminder');
  await sendOffscreen('ALARM_STOP');
  chrome.notifications.clear('slot_alert', () => {});
}

// Gestionnaire des alarmes périodiques
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'slot_reminder' && state.alarmActive) {
    // Répéter la sonnerie audio
    await sendOffscreen('ALARM_PING');

    // Répéter la notification
    const slot = state.slotFound;
    chrome.notifications.create(`slot_alert_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '🚨 CRÉNEAU CEV DISPONIBLE !',
      message: slot
        ? `📅 ${slot.date || '?'} ${slot.time || ''} — Appuie sur "Acquitter" dans l\'extension.`
        : 'Un créneau est disponible ! Acquitte l\'alerte dans l\'extension.',
      priority: 2,
      requireInteraction: true,
    });
  }

  if (alarm.name === 'sw_keepalive' && state.running) {
    // Toucher l'API pour maintenir le SW actif
    chrome.runtime.getPlatformInfo(() => {});
  }
});

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

// ─── Délai humain non-linéaire ────────────────────────────────────────────────
/**
 * Calcule un délai de 2 min base + composante non-linéaire aléatoire.
 *
 * Distribution :
 *  - Base fixe : 2 min (jamais moins)
 *  - Extra : courbe puissance biaisée vers le haut (humain parfois rapide, parfois long)
 *  - Jitter sinusoïdal basé sur le temps : casse le pattern périodique statique
 *
 * Résultat typique : 2–6 min, pic vers 3–4 min, queue longue rare.
 */
function humanLikeRetryDelay() {
  const BASE    = 2 * 60_000;                           // 2 min incompressibles
  const r       = Math.random();
  // r^0.55 biaise vers des valeurs élevées (paresseux qui tarde souvent)
  const extra   = Math.pow(r, 0.55) * 4 * 60_000;      // 0 – 4 min extra
  // Jitter sinusoïdal non-statique (période ~97s, amplitude ±20s)
  const jitter  = Math.sin(Date.now() / 97_000) * 20_000;
  const total   = Math.max(BASE, BASE + extra + jitter);
  return Math.round(total);
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
 * Sleep compatible service worker MV3.
 * Touche l'API Chrome toutes les 20s pour éviter l'extinction idle du SW.
 */
async function sleep(ms) {
  const CHUNK = 20_000;
  let remaining = ms;
  while (remaining > 0) {
    const wait = Math.min(CHUNK, remaining);
    await new Promise(r => setTimeout(r, wait));
    remaining -= wait;
    if (remaining > 0) {
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

/**
 * Retourne l'URL courante d'un onglet.
 */
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

function saveVowintLang(lang) {
  chrome.storage.local.set({ vowintLang: lang });
}

function getStoredVowintLang() {
  return new Promise(resolve => {
    chrome.storage.local.get(['vowintLang'], (d) => resolve(d.vowintLang || 'en'));
  });
}

async function resolveVowintLang(url) {
  const detected = detectVowintLang(url);
  if (detected) {
    saveVowintLang(detected);
    return detected;
  }
  const stored = await getStoredVowintLang();
  log(`🌐 Langue non lisible dans l'URL — langue mémorisée : ${stored}`);
  return stored;
}

function isVowintApplicationsPage(url) {
  if (!url) return false;
  return url.toLowerCase().includes('/visaapplication/indexbyuserid');
}

async function navigateToApplicationsPage(tabId, lang) {
  const resolvedLang = lang || await getStoredVowintLang();
  const targetUrl = getApplicationsUrl(resolvedLang);
  log(`🗂 Navigation vers Mes Applications (${resolvedLang}) → ${targetUrl}`);
  setPhase('clicking', `🗂 Navigation vers Mes Applications (${resolvedLang})…`);
  await new Promise(resolve => {
    chrome.tabs.update(tabId, { url: targetUrl }, () => resolve());
  });
  const loaded = await waitForTabLoad(tabId, 25_000);
  if (!loaded) warn('⚠️ Navigation vers Mes Applications : timeout');
  await sleep(randDelay(1_800, 3_200));
}

function isVowintLoginPage(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (u.includes('/account/')) return true;
  if (u.includes('/login'))    return true;
  if (u.includes('returnurl')) return true;
  const isKnownRoute = u.includes('/visaapplication') || u.includes('/en/') || u.includes('/fr/') || u.includes('/nl/');
  const isRoot = new URL(url).pathname.replace(/\//g, '').length < 3;
  if (!isKnownRoute && isRoot) return true;
  return false;
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
      if (chrome.runtime.lastError) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(false);
        return;
      }
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(false);
      }, 30_000);
    });
  });
}

async function openVowintTab() {
  return new Promise(resolve => {
    // active: false → onglet en arrière-plan, pas besoin d'être visible
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
        error(`❌ Login auto échoué : ${chrome.runtime.lastError?.message || resp?.error || 'inconnu'}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * Assure une session VOWINT active en arrière-plan.
 * L'onglet n'est jamais mis au premier plan — fonctionne même navigateur minimisé.
 */
async function ensureVowintSession() {
  let vowintTab = await getVowintTab();

  if (!vowintTab) {
    log('🌐 Ouverture onglet VOWINT (arrière-plan)…');
    setPhase('clicking', '🌐 Ouverture onglet VOWINT…');
    vowintTab = await openVowintTab();
    if (!vowintTab) {
      error('❌ Impossible d\'ouvrir l\'onglet VOWINT');
      return null;
    }
    await sleep(1_500);
  } else {
    setPhase('clicking', '🔄 Rechargement VOWINT (anti-restriction)…');
    const reloaded = await reloadAndWaitVowintTab(vowintTab.id);
    if (reloaded) {
      await sleep(randDelay(2_000, 4_500));
    } else {
      warn('⚠️ Rechargement timeout — tentative sans refresh');
    }
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

  // Session expirée → auto-login
  const creds = await getStoredCredentials();
  if (!creds.email || !creds.password) {
    error('🔓 Session expirée — configure email + mot de passe VOWINT');
    notify('🔓 Session VOWINT expirée', 'Entre tes identifiants VOWINT dans le popup.');
    state.running = false;
    state.phase = 'idle';
    broadcastState();
    return null;
  }

  log(`🔐 Connexion automatique VOWINT (${creds.email})…`);
  setPhase('clicking', `🔐 Connexion VOWINT (${creds.email})…`);

  const loginOk = await performAutoLogin(vowintTab.id, creds);
  if (!loginOk) {
    state.running = false;
    state.phase = 'idle';
    broadcastState();
    return null;
  }

  setPhase('clicking', '⏳ Redirection après connexion…');
  await waitForTabLoad(vowintTab.id, 25_000);
  await sleep(randDelay(1_500, 2_500));

  const postLoginUrl = await getTabUrl(vowintTab.id);
  if (isVowintLoginPage(postLoginUrl)) {
    error('❌ Login VOWINT échoué — identifiants incorrects ?');
    notify('❌ Login VOWINT échoué', 'Vérifie email + mot de passe dans le popup.');
    state.running = false;
    state.phase = 'idle';
    broadcastState();
    return null;
  }

  ok('✅ Connecté à VOWINT');

  if (!isVowintApplicationsPage(postLoginUrl)) {
    const lang = await resolveVowintLang(postLoginUrl);
    await navigateToApplicationsPage(vowintTab.id, lang);
    if (!state.running) return null;
  } else {
    const lang = await resolveVowintLang(postLoginUrl);
    ok(`✅ Déjà sur Mes Applications (${lang})`);
  }

  return await getVowintTab() || vowintTab;
}

// ─── Boucle principale ────────────────────────────────────────────────────────

async function runLoop() {
  // Alarme keepalive : réveille le SW toutes les minutes
  chrome.alarms.create('sw_keepalive', { periodInMinutes: 1 });

  while (state.running) {

    // Si une alarme slot est active → pause : ne pas scanner pendant l'alerte
    if (state.alarmActive) {
      await sleep(5_000);
      continue;
    }

    // ── Rate-limit ────────────────────────────────────────────────────────────
    if (!canAttempt()) {
      const oldestClick = state.clickTimestamps[0];
      const waitUntil = oldestClick + 60 * 60_000;
      const waitSec = Math.ceil((waitUntil - Date.now()) / 1000);
      setPhase('retry', `⚠️ Rate-limit (${MAX_CLICKS_PER_HOUR}/h) — attente ${Math.round(waitSec/60)}min`);
      await countdownWait(waitSec * 1000);
      continue;
    }

    // ── Délai humain non-linéaire (sauf premier essai) ────────────────────────
    if (state.attempts > 0) {
      const delay    = humanLikeRetryDelay();
      const delaySec = Math.round(delay / 1000);
      const delayMin = Math.floor(delaySec / 60);
      const delaySec2 = delaySec % 60;
      setPhase('retry', `⏱ Prochain scan dans ${delayMin}m${String(delaySec2).padStart(2,'0')}s (pause humaine)`);
      await countdownWait(delay);
    }
    if (!state.running) break;

    // ── Session VOWINT en arrière-plan ────────────────────────────────────────
    const vowintTab = await ensureVowintSession();
    if (!vowintTab || !state.running) break;

    // ── Pause "lecture" avant clic (anti-détection) ───────────────────────────
    // L'onglet reste en arrière-plan — pas de focusVowintTab
    const readPause = randDelay(1_500, 3_500);
    setPhase('clicking', `👁 Scan arrière-plan… (${Math.round(readPause/1000)}s)`);
    await sleep(readPause);
    if (!state.running) break;

    // ── Déclenchement du clic ────────────────────────────────────────────────
    state.attempts++;
    state.lastAttemptTs = Date.now();
    recordAttempt();
    setPhase('clicking', `🖱 Essai #${state.attempts} — clic "Prendre rendez-vous"`);

    chrome.tabs.sendMessage(
      vowintTab.id,
      { type: 'CLICK_RDV_BUTTON', applicationId: state.applicationId || null },
      resp => { void chrome.runtime.lastError; }
    );

    // ── Attendre l'onglet CEV ─────────────────────────────────────────────────
    const cevTab = await waitForNewCevTab(22_000);

    if (!cevTab) {
      state.consecutiveNoTab = (state.consecutiveNoTab || 0) + 1;
      broadcastState();

      if (state.consecutiveNoTab >= SHADOWBAN_STOP_THRESHOLD) {
        error(`🚫 Shadowban détecté — ${state.consecutiveNoTab} cycles sans onglet CEV. Arrêt.`);
        notify('🚫 Possible shadowban VOWINT',
          `${state.consecutiveNoTab} tentatives sans résultat. Attends 30-60 min.`);
        state.running = false;
        state.phase = 'idle';
        broadcastState();
        break;
      }

      if (state.consecutiveNoTab >= SHADOWBAN_WARN_THRESHOLD) {
        warn(`⚠️ ${state.consecutiveNoTab} cycles sans onglet CEV`);
        notify('⚠️ Aucun onglet CEV', `${state.consecutiveNoTab} fois de suite.`);
      } else {
        error(`❌ Aucun onglet CEV (${state.consecutiveNoTab}/${SHADOWBAN_STOP_THRESHOLD})`);
      }
      continue;
    }

    state.consecutiveNoTab = 0;
    state.activeCevTabId = cevTab.id;
    setPhase('captcha_solving', '🔒 Onglet CEV ouvert — résolution captcha…');

    const result = await waitForCevResult(cevTab.id);
    state.activeCevTabId = null;

    if (result === 'slot_found') {
      // Slot détecté → alerte uniquement, pas de réservation
      setPhase('slot_found', `🚨 SLOT DISPONIBLE — alerte active ! (essai #${state.attempts})`);
      // startAlarm() est appelé par le handler SLOT_FOUND du content script
    } else if (result === 'no_availability') {
      setPhase('retry', `❌ Essai #${state.attempts} : aucune dispo — on réessaie`);
    } else {
      warn(`⚠️ Résultat: ${result} — prochain essai`);
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
        clearTimeout(timer); cleanup();
        if (!resolved) { resolved = true; resolve(tab); }
      }
    }

    function updatedListener(tabId, changeInfo) {
      if (changeInfo.url && changeInfo.url.includes('appointment.cloud.diplomatie.be')) {
        clearTimeout(timer); cleanup();
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
      if (msg.applicationId !== undefined) {
        state.applicationId = msg.applicationId || null;
      }
      if (!state.running) {
        state.running = true;
        state.phase = 'idle';
        state.alarmActive = false;
        state.slotFound = null;
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
      stopAlarm();
      broadcastState();
      sendResponse({ ok: true });
      break;
    }

    case 'ACKNOWLEDGE_SLOT': {
      // L'utilisateur a vu l'alerte → arrêter la sonnerie, reprendre le scan
      stopAlarm().then(() => {
        state.slotFound = null;
        if (state.running) {
          state.phase = 'retry';
        } else {
          state.phase = 'idle';
        }
        broadcastState();
      });
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

    case 'VOWINT_LOGIN_PAGE': {
      if (!state.running) {
        addLog('warn', '🔓 Page VOWINT : session expirée — configure identifiants et lance ▶');
      }
      break;
    }

    case 'SLOT_FOUND': {
      // Content script a détecté un slot disponible → alerte sans réserver
      const slot = msg.slot || null;
      ok(`🚨 Slot détecté: ${slot?.date || '?'} ${slot?.time || ''} — alerte déclenchée`);
      startAlarm(slot);
      if (pendingCevResultResolver) {
        pendingCevResultResolver('slot_found');
        pendingCevResultResolver = null;
      }
      sendResponse({ ok: true });
      break;
    }

    case 'CEV_RESULT': {
      log(`📩 Résultat CEV: ${msg.result}`);
      if (msg.result !== 'slot_found') { // slot_found géré via SLOT_FOUND
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
      stopAlarm();
      broadcastState();
      sendResponse({ ok: true });
      break;
    }
  }
});

log('CEV Slot Hunter v3.0 — mode détection uniquement, fonctionnement en arrière-plan');
