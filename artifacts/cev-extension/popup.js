/**
 * popup.js — Interface CEV Slot Hunter
 */

'use strict';

// ─── Éléments DOM ─────────────────────────────────────────────────────────────

const els = {
  statusDot:   document.getElementById('statusDot'),
  statusLabel: document.getElementById('statusLabel'),
  statusSub:   document.getElementById('statusSub'),
  statChecks:  document.getElementById('statChecks'),
  statSlots:   document.getElementById('statSlots'),
  statCaptcha: document.getElementById('statCaptcha'),
  statSession: document.getElementById('statSession'),
  apiKey:      document.getElementById('apiKey'),
  apiKeyStatus:document.getElementById('apiKeyStatus'),
  btnToggleKey:document.getElementById('btnToggleKey'),
  btnStart:    document.getElementById('btnStart'),
  btnStop:     document.getElementById('btnStop'),
  btnSave:     document.getElementById('btnSave'),
  btnClearLogs:document.getElementById('btnClearLogs'),
  logContainer:document.getElementById('logContainer'),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, r));
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2,'0')}`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2,'0')}s`;
  return `${s}s`;
}

// ─── Rendu de l'état ──────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  idle:           { dot: 'idle',    label: 'Inactif',              sub: 'Appuie sur Démarrer sur la page CEV ouverte' },
  running:        { dot: 'running', label: 'En surveillance…',     sub: 'Polling des créneaux en cours' },
  solving_captcha:{ dot: 'solving', label: 'Résolution captcha…',  sub: 'Anti-Captcha en cours (30-90s)' },
  booked:         { dot: 'booked',  label: '✅ Réservé !',         sub: 'Rendez-vous confirmé — watcher arrêté' },
  page_ready:     { dot: 'idle',    label: 'Page CEV détectée',    sub: 'Prêt à démarrer' },
};

function applyState(state) {
  if (!state) return;

  // Statut dot + label
  const cfg = STATUS_CONFIG[state.status] || STATUS_CONFIG.idle;
  els.statusDot.className = `status-dot ${cfg.dot}`;
  els.statusLabel.textContent = cfg.label;
  els.statusSub.textContent = cfg.sub;

  // Stats
  els.statChecks.textContent  = state.checksCount ?? 0;
  els.statSlots.textContent   = state.slotsFound ?? 0;
  els.statCaptcha.textContent = state.captchasSolved ?? 0;

  // Durée session
  if (state.sessionStart && state.running) {
    const dur = Date.now() - state.sessionStart;
    els.statSession.textContent = fmtDuration(dur);
  } else {
    els.statSession.textContent = '—';
  }

  // Boutons Start / Stop
  if (state.running || state.status === 'solving_captcha') {
    els.btnStart.classList.add('hidden');
    els.btnStop.classList.remove('hidden');
  } else {
    els.btnStart.classList.remove('hidden');
    els.btnStop.classList.add('hidden');
  }

  // Logs
  renderLogs(state.logs || []);
}

// ─── Rendu des logs ───────────────────────────────────────────────────────────

function renderLogs(logs) {
  if (!logs.length) {
    els.logContainer.innerHTML = '<div class="log-empty">Aucun événement</div>';
    return;
  }

  els.logContainer.innerHTML = logs.slice(0, 50).map(entry => {
    const time = fmtTime(entry.ts);
    const cls  = entry.level === 'ok' ? 'ok' : entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : '';
    const msg  = escapeHtml(entry.msg);
    return `<div class="log-entry ${cls}">
      <span class="log-time">${time}</span>
      <span class="log-msg">${msg}</span>
    </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Sauvegarde / chargement config ──────────────────────────────────────────

function loadConfig() {
  chrome.storage.local.get(['anticaptchaKey'], ({ anticaptchaKey }) => {
    if (anticaptchaKey) {
      els.apiKey.value = anticaptchaKey;
      showKeyStatus('✓ Clé sauvegardée', 'ok');
    }
  });
}

function saveConfig() {
  const key = els.apiKey.value.trim();
  if (!key) {
    showKeyStatus('⚠ Entre ta clé Anti-Captcha', 'error');
    return;
  }
  if (key.length < 10) {
    showKeyStatus('⚠ Clé trop courte — vérifie-la', 'error');
    return;
  }
  chrome.storage.local.set({ anticaptchaKey: key }, () => {
    showKeyStatus('✓ Clé sauvegardée avec succès', 'ok');
  });
}

function showKeyStatus(msg, type = '') {
  els.apiKeyStatus.textContent = msg;
  els.apiKeyStatus.className = `field-hint ${type}`;
  if (type === 'ok') {
    setTimeout(() => {
      if (els.apiKeyStatus.textContent === msg) {
        els.apiKeyStatus.textContent = '';
        els.apiKeyStatus.className = 'field-hint';
      }
    }, 3000);
  }
}

// ─── Démarrer / arrêter ───────────────────────────────────────────────────────

async function startHunter() {
  const key = els.apiKey.value.trim() || await getStoredKey();
  if (!key) {
    showKeyStatus('⚠ Configure la clé Anti-Captcha d\'abord', 'error');
    return;
  }

  // Sauvegarder la clé si pas encore fait
  chrome.storage.local.set({ anticaptchaKey: key, hunterRunning: true });

  // Notifier le background
  await send({ type: 'START' });

  // Injecter le démarrage dans le content script de l'onglet CEV actif
  const tabs = await getCevTabs();
  if (tabs.length === 0) {
    els.statusSub.textContent = 'Aucune page CEV ouverte — navigue sur le portail d\'abord';
    return;
  }

  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'START_POLLING' }, (resp) => {
      if (chrome.runtime.lastError) return;
    });
  }
}

async function stopHunter() {
  chrome.storage.local.set({ hunterRunning: false });
  await send({ type: 'STOP' });

  const tabs = await getCevTabs();
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP_POLLING' }, () => {});
  }
}

function getStoredKey() {
  return new Promise(r => {
    chrome.storage.local.get(['anticaptchaKey'], ({ anticaptchaKey }) => r(anticaptchaKey || ''));
  });
}

function getCevTabs() {
  return new Promise(r => {
    chrome.tabs.query({ url: 'https://appointment.cloud.diplomatie.be/*' }, tabs => r(tabs || []));
  });
}

// ─── Timer rafraîchissement session ──────────────────────────────────────────

setInterval(async () => {
  const resp = await send({ type: 'GET_STATE' });
  if (resp?.state) applyState(resp.state);
}, 2000);

// ─── Écoute des mises à jour en temps réel ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') applyState(msg.state);
});

// ─── Événements UI ────────────────────────────────────────────────────────────

els.btnSave.addEventListener('click', saveConfig);

els.btnStart.addEventListener('click', startHunter);

els.btnStop.addEventListener('click', stopHunter);

els.btnToggleKey.addEventListener('click', () => {
  const isPass = els.apiKey.type === 'password';
  els.apiKey.type = isPass ? 'text' : 'password';
  els.btnToggleKey.textContent = isPass ? '🔒' : '👁';
});

els.btnClearLogs.addEventListener('click', () => send({ type: 'CLEAR_LOGS' }));

els.apiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveConfig();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  loadConfig();
  const resp = await send({ type: 'GET_STATE' });
  if (resp?.state) applyState(resp.state);
}

init();
