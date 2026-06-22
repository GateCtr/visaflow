/**
 * popup.js — Interface CEV Slot Hunter v2
 */

'use strict';

const els = {
  statusDot:   document.getElementById('statusDot'),
  phaseIcon:   document.getElementById('phaseIcon'),
  phaseLabel:  document.getElementById('phaseLabel'),
  phaseSub:    document.getElementById('phaseSub'),
  statAttempts:document.getElementById('statAttempts'),
  statCaptcha: document.getElementById('statCaptcha'),
  statNext:    document.getElementById('statNext'),
  vowintEmail:      document.getElementById('vowintEmail'),
  vowintPassword:   document.getElementById('vowintPassword'),
  vowintStatus:     document.getElementById('vowintStatus'),
  btnToggleVowint:  document.getElementById('btnToggleVowint'),
  apiKey:      document.getElementById('apiKey'),
  keyStatus:   document.getElementById('keyStatus'),
  btnToggle:   document.getElementById('btnToggle'),
  btnStart:    document.getElementById('btnStart'),
  btnStop:     document.getElementById('btnStop'),
  btnSave:     document.getElementById('btnSave'),
  btnReset:      document.getElementById('btnReset'),
  btnClear:      document.getElementById('btnClear'),
  btnCopy:       document.getElementById('btnCopy'),
  dossierId:     document.getElementById('dossierId'),
  dossierStatus: document.getElementById('dossierStatus'),
  logContainer:  document.getElementById('logContainer'),
  steps: {
    click:   document.getElementById('step-click'),
    captcha: document.getElementById('step-captcha'),
    result:  document.getElementById('step-result'),
    book:    document.getElementById('step-book'),
  },
};

function send(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, r));
}

// ─── Phases ───────────────────────────────────────────────────────────────────

const PHASE_CONFIG = {
  idle:            { dot: 'idle',    icon: '⏸',  label: 'Inactif',               sub: 'Appuie sur Démarrer sur la page VOWINT ouverte',  active: [] },
  clicking:        { dot: 'running', icon: '🖱',  label: 'Clic en cours…',        sub: 'Clic sur "Prendre rendez-vous"',                  active: ['click'] },
  captcha_solving: { dot: 'solving', icon: '🔒',  label: 'Résolution captcha…',   sub: 'Anti-Captcha en cours (30–90s)',                  active: ['click', 'captcha'] },
  waiting_result:  { dot: 'running', icon: '⏳',  label: 'Attente de la réponse', sub: 'Redirection en cours…',                          active: ['click', 'captcha', 'result'] },
  retry:           { dot: 'idle',    icon: '🔄',  label: 'Aucune disponibilité',  sub: 'Prochain essai dans…',                           active: [] },
  success:         { dot: 'booked',  icon: '🎉',  label: 'Rendez-vous réservé !', sub: 'Confirmation confirmée — watcher arrêté',         active: ['click', 'captcha', 'result', 'book'] },
  calendar_empty:  { dot: 'idle',    icon: '📅',  label: 'Calendrier vide',       sub: 'SelectSlot ouvert mais aucune date disponible',   active: ['click', 'captcha', 'result'] },
};

function applyState(state) {
  if (!state) return;

  const cfg = PHASE_CONFIG[state.phase] || PHASE_CONFIG.idle;

  // Dot couleur
  els.statusDot.className = `status-dot ${cfg.dot}`;

  // Phase card
  els.phaseIcon.textContent  = cfg.icon;
  els.phaseLabel.textContent = cfg.label;

  // Sub text : intégrer le countdown si disponible
  if (state.phase === 'retry' && state.nextRetryIn) {
    const m = Math.floor(state.nextRetryIn / 60);
    const s = state.nextRetryIn % 60;
    els.phaseSub.textContent = `Prochain essai dans ${m > 0 ? m + 'm' : ''}${String(s).padStart(2, '0')}s`;
  } else {
    els.phaseSub.textContent = cfg.sub;
  }

  // Stats
  els.statAttempts.textContent = state.attempts ?? 0;
  els.statCaptcha.textContent  = state.captchasSolved ?? 0;
  els.statNext.textContent     = state.nextRetryIn
    ? `${Math.floor(state.nextRetryIn / 60)}m${String(state.nextRetryIn % 60).padStart(2,'0')}s`
    : '—';

  // Flow steps
  const active = new Set(cfg.active);
  Object.entries(els.steps).forEach(([key, el]) => {
    el.classList.toggle('active',  active.has(key));
    el.classList.toggle('done', state.phase === 'success');
  });

  // Boutons
  const isRunning = state.running || state.phase === 'captcha_solving';
  els.btnStart.classList.toggle('hidden', isRunning);
  els.btnStop.classList.toggle('hidden', !isRunning);

  renderLogs(state.logs || []);
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

function renderLogs(logs) {
  _lastLogs = logs || [];
  if (!logs.length) {
    els.logContainer.innerHTML = '<div class="log-empty">Aucun événement</div>';
    return;
  }
  els.logContainer.innerHTML = logs.slice(0, 60).map(({ ts, level, msg }) => {
    const t   = new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : level === 'error' ? 'error' : '';
    return `<div class="log-entry ${cls}"><span class="log-time">${t}</span><span class="log-msg">${esc(msg)}</span></div>`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Copier les logs ───────────────────────────────────────────────────────────

let _lastLogs = [];

function copyLogs() {
  if (!_lastLogs.length) return;

  const text = _lastLogs.slice(0, 60).map(({ ts, level, msg }) => {
    const t = new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const lvl = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : level === 'error' ? '❌' : '·';
    return `[${t}] ${lvl} ${msg}`;
  }).join('\n');

  navigator.clipboard.writeText(text).then(() => {
    els.btnCopy.textContent = '✓';
    els.btnCopy.classList.add('copied');
    setTimeout(() => {
      els.btnCopy.textContent = '📋';
      els.btnCopy.classList.remove('copied');
    }, 1800);
  }).catch(() => {
    // Fallback textarea pour les navigateurs sans clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    els.btnCopy.textContent = '✓';
    els.btnCopy.classList.add('copied');
    setTimeout(() => {
      els.btnCopy.textContent = '📋';
      els.btnCopy.classList.remove('copied');
    }, 1800);
  });
}

// ─── Config & Dossier ─────────────────────────────────────────────────────────

function normalizeDossierId(raw) {
  const v = raw.trim().toUpperCase();
  if (!v) return '';
  // Accepter avec ou sans préfixe VOWINT
  return v.startsWith('VOWINT') ? v : 'VOWINT' + v;
}

function saveDossierId() {
  const raw = els.dossierId.value.trim();
  const id  = normalizeDossierId(raw);
  chrome.storage.local.set({ vowintDossierId: id }, () => {
    if (id) {
      els.dossierId.value = id;
      els.dossierStatus.textContent = `✓ Cible : ${id}`;
      els.dossierStatus.className = 'field-hint ok';
      setTimeout(() => { els.dossierStatus.className = 'field-hint'; }, 2500);
    } else {
      els.dossierStatus.textContent = 'Optionnel — cible le bon bouton si plusieurs dossiers sur la page';
      els.dossierStatus.className = 'field-hint';
    }
  });
}

function loadConfig() {
  chrome.storage.local.get(['anticaptchaKey', 'vowintDossierId', 'vowintEmail', 'vowintPassword'], d => {
    if (d.anticaptchaKey) {
      els.apiKey.value = d.anticaptchaKey;
      showKeyStatus('✓ Clé sauvegardée', 'ok');
    }
    if (d.vowintDossierId) {
      els.dossierId.value = d.vowintDossierId;
      els.dossierStatus.textContent = `✓ Cible : ${d.vowintDossierId}`;
      els.dossierStatus.className = 'field-hint ok';
    }
    if (d.vowintEmail) {
      els.vowintEmail.value = d.vowintEmail;
    }
    if (d.vowintPassword) {
      els.vowintPassword.value = d.vowintPassword;
    }
    if (d.vowintEmail && d.vowintPassword) {
      els.vowintStatus.textContent = `✓ Compte : ${d.vowintEmail}`;
      els.vowintStatus.className = 'field-hint ok';
    }
  });
}

function saveConfig() {
  const k = els.apiKey.value.trim();
  if (!k || k.length < 10) { showKeyStatus('⚠ Clé invalide ou trop courte', 'error'); return; }
  saveDossierId();
  saveVowintCredentials();
  chrome.storage.local.set({ anticaptchaKey: k }, () => showKeyStatus('✓ Clé sauvegardée', 'ok'));
}

function saveVowintCredentials() {
  const email    = els.vowintEmail.value.trim();
  const password = els.vowintPassword.value;
  if (!email && !password) return;
  chrome.storage.local.set({ vowintEmail: email, vowintPassword: password }, () => {
    if (email) {
      els.vowintStatus.textContent = `✓ Compte : ${email}`;
      els.vowintStatus.className = 'field-hint ok';
      setTimeout(() => { els.vowintStatus.className = 'field-hint'; }, 2500);
    }
  });
}

function showKeyStatus(msg, type = '') {
  els.keyStatus.textContent = msg;
  els.keyStatus.className = `field-hint ${type}`;
  if (type === 'ok') setTimeout(() => { els.keyStatus.textContent = ''; els.keyStatus.className = 'field-hint'; }, 2500);
}

// ─── Démarrer / Arrêter ───────────────────────────────────────────────────────

async function start() {
  const key = els.apiKey.value.trim() || await getKey();
  if (!key) { showKeyStatus('⚠ Entre ta clé Anti-Captcha d\'abord', 'error'); return; }
  chrome.storage.local.set({ anticaptchaKey: key });
  const rawId = els.dossierId.value.trim();
  const applicationId = rawId ? normalizeDossierId(rawId) : null;
  if (rawId && applicationId) saveDossierId();
  await send({ type: 'START', applicationId });
}

async function stop() {
  await send({ type: 'STOP' });
}

function getKey() {
  return new Promise(r => chrome.storage.local.get(['anticaptchaKey'], d => r(d.anticaptchaKey || '')));
}

// ─── Listeners ────────────────────────────────────────────────────────────────

els.btnSave.addEventListener('click', saveConfig);
els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);
els.btnClear.addEventListener('click', () => send({ type: 'CLEAR_LOGS' }));
els.btnCopy.addEventListener('click', copyLogs);
els.btnReset.addEventListener('click', () => send({ type: 'RESET' }));

els.btnToggle.addEventListener('click', () => {
  const isPw = els.apiKey.type === 'password';
  els.apiKey.type = isPw ? 'text' : 'password';
  els.btnToggle.textContent = isPw ? '🔒' : '👁';
});

els.btnToggleVowint.addEventListener('click', () => {
  const isPw = els.vowintPassword.type === 'password';
  els.vowintPassword.type = isPw ? 'text' : 'password';
  els.btnToggleVowint.textContent = isPw ? '🔒' : '👁';
});

els.apiKey.addEventListener('keydown',         e => { if (e.key === 'Enter') saveConfig(); });
els.dossierId.addEventListener('keydown',      e => { if (e.key === 'Enter') saveDossierId(); });
els.dossierId.addEventListener('blur',         () => { if (els.dossierId.value.trim()) saveDossierId(); });
els.vowintEmail.addEventListener('blur',       () => { if (els.vowintEmail.value.trim()) saveVowintCredentials(); });
els.vowintPassword.addEventListener('keydown', e => { if (e.key === 'Enter') saveVowintCredentials(); });

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'STATE_UPDATE') applyState(msg.state);
});

// Rafraîchir l'état toutes les 2s (pour le countdown)
setInterval(async () => {
  const r = await send({ type: 'GET_STATE' });
  if (r?.state) applyState(r.state);
}, 2000);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  loadConfig();
  const r = await send({ type: 'GET_STATE' });
  if (r?.state) applyState(r.state);
}

init();
