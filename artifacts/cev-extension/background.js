/**
 * background.js — CEV Slot Hunter v2.1 (Manifest V3 / Service Worker)
 *
 * MV3 : background script = service worker (pas de page persistante).
 * L'état est stocké dans chrome.storage.local pour survivre aux redémarrages SW.
 * Le sleep() touche l'API Chrome toutes les 20s pour éviter l'extinction idle du SW.
 */

'use strict';

const MAX_CLICKS_PER_HOUR = 4;

// ─── État en mémoire + persisté dans chrome.storage.local ────────────────────

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
};

// Restaurer l'état depuis le storage au démarrage du SW
chrome.storage.local.get(['cevState'], (d) => {
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

/**
 * Détecte la langue de l'interface VOWINT depuis une URL.
 * Retourne la langue ('fr'|'en'|'nl') si détectable, ou null sinon.
 *
 * Deux sources de langue dans les URLs VOWINT :
 *
 * 1. Préfixe dans le chemin (pages connectées) :
 *    https://visaonweb.diplomatie.be/en/VisaApplication/… → 'en'
 *    https://visaonweb.diplomatie.be/fr/VisaApplication/… → 'fr'
 *    https://visaonweb.diplomatie.be/nl/…                 → 'nl'
 *
 * 2. Paramètre ReturnUrl sur la page de login :
 *    …/Account/Login?ReturnUrl=%2Fen  → 'en'  (navigateur en anglais)
 *    …/Account/Login?ReturnUrl=%2Ffr  → 'fr'
 *    …/Account/Login                  → null  (langue choisie manuellement,
 *                                              pas encodée dans l'URL)
 */
function detectVowintLang(url) {
  if (!url) return null;

  // Cas 1 : préfixe de langue dans le chemin → /en/, /fr/, /nl/
  const pathMatch = url.match(/visaonweb\.diplomatie\.be\/([a-z]{2})\//i);
  if (pathMatch) {
    const lang = pathMatch[1].toLowerCase();
    if (['fr', 'en', 'nl'].includes(lang)) return lang;
  }

  // Cas 2 : page de login avec ReturnUrl encodé → ?ReturnUrl=%2Fen ou %2Ffr
  const returnMatch = url.match(/[?&]ReturnUrl=(?:%2F|\/)(en|fr|nl)/i);
  if (returnMatch) return returnMatch[1].toLowerCase();

  // Langue non détectable depuis l'URL (ex. /Account/Login sans ReturnUrl)
  return null;
}

/**
 * Construit l'URL de la page des demandes pour une langue donnée.
 */
function getApplicationsUrl(lang = 'en') {
  return `https://visaonweb.diplomatie.be/${lang}/VisaApplication/IndexByUserId`;
}

/**
 * Persiste la langue VOWINT confirmée dans chrome.storage.local.
 */
function saveVowintLang(lang) {
  chrome.storage.local.set({ vowintLang: lang });
}

/**
 * Lit la langue VOWINT stockée. Retourne 'en' si aucune langue n'a encore été sauvegardée.
 */
function getStoredVowintLang() {
  return new Promise(resolve => {
    chrome.storage.local.get(['vowintLang'], (d) => resolve(d.vowintLang || 'en'));
  });
}

/**
 * Résout la langue VOWINT à utiliser pour naviguer.
 *
 * Priorité :
 *   1. Détection depuis l'URL (chemin /en/ /fr/ /nl/ OU ReturnUrl=%2Fen…)
 *      → si trouvée, sauvegarde et retourne.
 *   2. Langue stockée dans chrome.storage.local (mémorisée lors d'un cycle précédent).
 *   3. Fallback ultime : 'en'.
 *
 * Cas couverts :
 *   /Account/Login?ReturnUrl=%2Fen → 'en' (détecté via ReturnUrl)
 *   /Account/Login?ReturnUrl=%2Ffr → 'fr'
 *   /Account/Login (sans ReturnUrl) → langue choisie manuellement → stockage
 *   /en/VisaApplication/…          → 'en' (détecté via chemin)
 */
async function resolveVowintLang(url) {
  const detected = detectVowintLang(url);
  if (detected) {
    saveVowintLang(detected);
    return detected;
  }
  // Langue non détectable (ex. /Account/Login sans ReturnUrl) → langue mémorisée
  const stored = await getStoredVowintLang();
  log(`🌐 Langue non lisible dans l'URL — langue mémorisée : ${stored}`);
  return stored;
}

/**
 * Détecte si l'URL est la page des demandes (là où les boutons RDV apparaissent).
 */
function isVowintApplicationsPage(url) {
  if (!url) return false;
  return url.toLowerCase().includes('/visaapplication/indexbyuserid');
}

/**
 * Navigue vers la page des demandes VOWINT dans la bonne langue et attend que l'AngularJS soit prêt.
 * @param {number} tabId
 * @param {string} [lang] — langue (fr/en/nl). Si omis, `resolveVowintLang` est appelé.
 */
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
  // Attendre que AngularJS rende le tableau des demandes
  await sleep(randDelay(1_800, 3_200));
}

/**
 * Détecte si l'URL VOWINT est une page de login (session expirée).
 * Indicateurs fiables :
 *   - URL contient /Account/   (ex. /Account/Login)
 *   - URL contient /login      (insensible à la casse)
 *   - URL contient ReturnUrl=  (redirect vers login avec retour)
 *   - URL ne contient PAS /VisaApplication/ ni /en/ ni /fr/
 *     (toutes les pages authentifiées passent par ces paths)
 */
function isVowintLoginPage(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (u.includes('/account/')) return true;
  if (u.includes('/login'))    return true;
  if (u.includes('returnurl')) return true;
  // Si l'URL est juste la racine ou ne contient aucune route connue → probablement login
  const isKnownRoute = u.includes('/visaapplication') || u.includes('/en/') || u.includes('/fr/') || u.includes('/nl/');
  const isRoot = new URL(url).pathname.replace(/\//g, '').length < 3;
  if (!isKnownRoute && isRoot) return true;
  return false;
}

/**
 * Recharge l'onglet VOWINT et attend que la page soit fully loaded.
 * Stratégie anti-restriction découverte expérimentalement :
 *   mobile = déconnexion auto après inactivité → session fraîche → pas de restriction
 *   PC = session longue durée → token vieilli → restriction si clic sans refresh
 * Solution : simuler le comportement mobile en rechargant la page avant chaque clic.
 *
 * Timeout 30s. Retourne true si OK, false si timeout.
 */
async function reloadAndWaitVowintTab(tabId) {
  return new Promise(resolve => {
    const deadline = Date.now() + 30_000;

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
      // Sécurité : timeout au cas où l'événement complete ne vient pas
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(Date.now() < deadline); // vrai si on est encore dans le délai
      }, 30_000);
    });
  });
}

// ─── Auto-login VOWINT ────────────────────────────────────────────────────────

/**
 * Ouvre un nouvel onglet VOWINT et attend que la page soit chargée.
 * Retourne le tab ou null si échec.
 */
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

/**
 * Attend que l'onglet soit entièrement chargé (status=complete).
 */
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

/**
 * Lit les identifiants VOWINT depuis chrome.storage.local.
 */
async function getStoredCredentials() {
  return new Promise(resolve => {
    chrome.storage.local.get(['vowintEmail', 'vowintPassword'], d => {
      resolve({ email: d.vowintEmail || '', password: d.vowintPassword || '' });
    });
  });
}

/**
 * Envoie le message AUTO_LOGIN au content script et attend la réponse.
 */
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
 * Assure une session VOWINT active avant chaque tentative de clic.
 * Gère 3 cas :
 *   1. Aucun onglet VOWINT → ouvre un nouvel onglet
 *   2. Onglet existant → recharge (anti-restriction)
 *   3. Session expirée → login automatique avec les identifiants sauvegardés
 *
 * Retourne le tab VOWINT prêt, ou null si impossible de continuer.
 */
async function ensureVowintSession() {
  // ── Étape 1 : trouver ou ouvrir l'onglet ────────────────────────────────
  let vowintTab = await getVowintTab();

  if (!vowintTab) {
    log('🌐 Ouverture de l\'onglet VOWINT…');
    setPhase('clicking', '🌐 Ouverture de l\'onglet VOWINT…');
    vowintTab = await openVowintTab();
    if (!vowintTab) {
      error('❌ Impossible d\'ouvrir l\'onglet VOWINT');
      return null;
    }
    await sleep(1_500); // attente initialisation content script
  } else {
    // ── Étape 2 : recharger (anti-restriction) ───────────────────────────
    setPhase('clicking', '🔄 Rechargement VOWINT (anti-restriction)…');
    const reloaded = await reloadAndWaitVowintTab(vowintTab.id);
    if (reloaded) {
      await sleep(randDelay(2_000, 4_500));
    } else {
      warn('⚠️ Rechargement timeout — tentative sans refresh');
    }
  }

  if (!state.running) return null;

  // ── Étape 3 : détecter l'état de la page actuelle ────────────────────────
  const currentUrl = await getTabUrl(vowintTab.id);

  if (!isVowintLoginPage(currentUrl)) {
    // Session active — mais on est peut-être sur la mauvaise page
    if (!isVowintApplicationsPage(currentUrl)) {
      const lang = await resolveVowintLang(currentUrl);
      log(`📍 Page actuelle (${lang}) : ${currentUrl || '?'} → navigation vers Mes Applications`);
      await navigateToApplicationsPage(vowintTab.id, lang);
      if (!state.running) return null;
    }
    return vowintTab; // session active, sur la bonne page
  }

  // ── Étape 4 : page de login → auto-login ─────────────────────────────────
  const creds = await getStoredCredentials();
  if (!creds.email || !creds.password) {
    error('🔓 Session expirée — configure email + mot de passe VOWINT dans l\'extension');
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

  // ── Étape 5 : attendre la redirection post-login ─────────────────────────
  setPhase('clicking', '⏳ Redirection après connexion…');
  await waitForTabLoad(vowintTab.id, 25_000);
  await sleep(randDelay(1_500, 2_500)); // laisser VOWINT finir son init

  // ── Étape 6 : vérifier que la session est bien établie ───────────────────
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

  // ── Étape 7 : naviguer vers Mes Applications si ce n'est pas déjà le cas ─
  // Après le login VOWINT redirige souvent vers une page d'accueil générale
  // (ex. /en/ ou /fr/). On force la navigation vers IndexByUserId dans la
  // langue détectée depuis l'URL de redirection.
  if (!isVowintApplicationsPage(postLoginUrl)) {
    const lang = await resolveVowintLang(postLoginUrl);
    log(`📍 Post-login (${lang}) sur : ${postLoginUrl || '?'} → navigation vers Mes Applications`);
    await navigateToApplicationsPage(vowintTab.id, lang);
    if (!state.running) return null;

    // Vérification finale
    const finalUrl = await getTabUrl(vowintTab.id);
    if (!isVowintApplicationsPage(finalUrl)) {
      warn(`⚠️ Navigation Mes Applications a abouti sur : ${finalUrl || '?'} — on tente quand même`);
    } else {
      ok(`✅ Page Mes Applications (${lang}) chargée`);
    }
  } else {
    // Déjà sur la bonne page → on profite pour sauvegarder la langue détectée
    const lang = await resolveVowintLang(postLoginUrl);
    ok(`✅ Déjà sur Mes Applications (${lang})`);
  }

  return await getVowintTab() || vowintTab;
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

    // ── Préparer la session VOWINT ───────────────────────────────────────────
    // ensureVowintSession() gère tout : ouvre l'onglet si besoin, recharge
    // (anti-restriction), détecte la page de login et se reconnecte auto.
    const vowintTab = await ensureVowintSession();
    if (!vowintTab || !state.running) break;

    // ── Déclencher le clic ───────────────────────────────────────────────────
    state.attempts++;
    state.lastAttemptTs = Date.now();
    recordAttempt();
    setPhase('clicking', `🖱 Essai #${state.attempts} — clic "Prendre rendez-vous"`);

    chrome.tabs.sendMessage(vowintTab.id, { type: 'CLICK_RDV_BUTTON', applicationId: state.applicationId || null }, resp => {
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
      if (msg.applicationId !== undefined) {
        state.applicationId = msg.applicationId || null;
      }
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

    case 'VOWINT_LOGIN_PAGE': {
      // Le content script signale que la page est une page de login.
      // ensureVowintSession() gère la reconnexion automatique dans la boucle.
      // On log seulement si le bot ne tourne pas (info passive).
      if (!state.running) {
        addLog('warn', '🔓 Page VOWINT : session expirée — configure tes identifiants et lance ▶');
      }
      break;
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
