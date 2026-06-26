/**
 * popup.js — CEV Slot Hunter v4.0
 *
 * Nouveautés v4 :
 *   • Section "Dossiers détectés" avec indicateur round-robin (dossier en cours)
 *   • statDossiers — nombre de dossiers dans le pool
 *   • Synchronisation bouton start/stop robuste (SW endormi détecté)
 *   • Countdown rate-limit précis (mise à jour 1s)
 */

'use strict';

const els = {
  statusDot:        document.getElementById('statusDot'),
  phaseIcon:        document.getElementById('phaseIcon'),
  phaseLabel:       document.getElementById('phaseLabel'),
  phaseSub:         document.getElementById('phaseSub'),
  statAttempts:     document.getElementById('statAttempts'),
  statCaptcha:      document.getElementById('statCaptcha'),
  statNext:         document.getElementById('statNext'),
  statDossiers:     document.getElementById('statDossiers'),
  vowintEmail:      document.getElementById('vowintEmail'),
  vowintPassword:   document.getElementById('vowintPassword'),
  vowintStatus:     document.getElementById('vowintStatus'),
  btnToggleVowint:  document.getElementById('btnToggleVowint'),
  apiKey:           document.getElementById('apiKey'),
  keyStatus:        document.getElementById('keyStatus'),
  btnToggle:        document.getElementById('btnToggle'),
  btnStart:         document.getElementById('btnStart'),
  btnStop:          document.getElementById('btnStop'),
  btnSave:          document.getElementById('btnSave'),
  btnReset:         document.getElementById('btnReset'),
  btnClear:         document.getElementById('btnClear'),
  btnCopy:          document.getElementById('btnCopy'),
  btnAck:           document.getElementById('btnAck'),
  btnForceResume:   document.getElementById('btnForceResume'),
  dossierId:        document.getElementById('dossierId'),
  dossierStatus:    document.getElementById('dossierStatus'),
  dossierSection:   document.getElementById('dossierSection'),
  dossierList:      document.getElementById('dossierList'),
  rrBadge:          document.getElementById('rrBadge'),
  logContainer:     document.getElementById('logContainer'),
  slotAlert:        document.getElementById('slotAlert'),
  slotAlertDetail:  document.getElementById('slotAlertDetail'),
  rateLimitAlert:   document.getElementById('rateLimitAlert'),
  rateLimitReason:  document.getElementById('rateLimitReason'),
  rateLimitCountdown: document.getElementById('rateLimitCountdown'),
  steps: {
    click:   document.getElementById('step-click'),
    captcha: document.getElementById('step-captcha'),
    scan:    document.getElementById('step-scan'),
    alert:   document.getElementById('step-alert'),
  },
};

function send(msg) {
  return new Promise(r => chrome.runtime.sendMessage(msg, r));
}

// ─── Phases ───────────────────────────────────────────────────────────────────

const PHASE_CONFIG = {
  idle:            { dot: 'idle',    icon: '⏸',  label: 'Inactif',              sub: 'Appuie ▶ pour démarrer',                  active: [] },
  clicking:        { dot: 'running', icon: '🖱',  label: 'Récupération URL CEV', sub: 'XHR GetEAppointmentUrl…',                 active: ['click'] },
  captcha_solving: { dot: 'solving', icon: '🔒',  label: 'Résolution captcha…',  sub: 'Anti-Captcha en cours (30–90s)',           active: ['click', 'captcha'] },
  waiting_result:  { dot: 'running', icon: '⏳',  label: 'Scan en cours…',       sub: 'Vérification des disponibilités…',         active: ['click', 'captcha', 'scan'] },
  retry:           { dot: 'idle',    icon: '🔄',  label: 'Pause humaine',         sub: 'Prochain scan dans…',                     active: [] },
  slot_found:      { dot: 'booked',  icon: '🚨',  label: 'CRÉNEAU DÉTECTÉ !',    sub: 'Sonnerie active — acquitte dans ce popup', active: ['click', 'captcha', 'scan', 'alert'] },
  rate_limited:    { dot: 'paused',  icon: '🚫',  label: 'Pause rate-limit',     sub: 'Trop de tentatives — pause 60 min',        active: [] },
  server_error:    { dot: 'paused',  icon: '⚠️',  label: 'Erreur serveur CEV',   sub: 'Pause automatique avant nouvelle tentative', active: [] },
};

const RATE_LIMIT_PAUSE_MS = 60 * 60_000;

function fmtCountdown(ms) {
  if (ms <= 0) return '0m00s';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

// ─── Dossiers round-robin ─────────────────────────────────────────────────────

function renderDossierPool(dossiers, currentDossier, rrIndex) {
  if (!dossiers || !dossiers.length) {
    els.dossierSection.style.display = 'none';
    return;
  }

  els.dossierSection.style.display = '';
  els.rrBadge.textContent = dossiers.length;
  els.statDossiers.textContent = dossiers.length;

  const currentAppId = currentDossier?.appId;

  els.dossierList.innerHTML = dossiers.map((d, i) => {
    const isCurrent = d.appId === currentAppId;
    const ref   = d.ref   || `#${i + 1}`;
    const label = d.label || '';
    const appShort = d.appId.slice(0, 8) + '…';

    // L'index "next" dans le pool (round-robin)
    const isNext = !currentAppId && i === (rrIndex % dossiers.length);

    return `<div class="dossier-item ${isCurrent ? 'dossier-current' : ''} ${isNext && !isCurrent ? 'dossier-next' : ''}">
      <span class="dossier-dot">${isCurrent ? '▶' : (isNext ? '○' : '·')}</span>
      <span class="dossier-ref">${esc(ref)}</span>
      ${label ? `<span class="dossier-label">${esc(label)}</span>` : ''}
      <span class="dossier-id">${appShort}</span>
    </div>`;
  }).join('');
}

// ─── State → UI ───────────────────────────────────────────────────────────────

function applyState(st) {
  if (!st) return;

  const cfg = PHASE_CONFIG[st.phase] || PHASE_CONFIG.idle;

  els.statusDot.className = `status-dot ${cfg.dot}`;
  els.phaseIcon.textContent  = cfg.icon;
  els.phaseLabel.textContent = cfg.label;

  // Sous-titre enrichi avec le dossier courant
  if ((st.phase === 'retry' || st.phase === 'server_error') && st.nextRetryIn) {
    const m = Math.floor(st.nextRetryIn / 60);
    const s = st.nextRetryIn % 60;
    const nextLabel = st.dossierPool?.length > 0
      ? ` → ${st.dossierPool[st.rrIndex % st.dossierPool.length]?.ref || '?'}`
      : '';
    els.phaseSub.textContent = `Prochain scan dans ${m > 0 ? m + 'm' : ''}${String(s).padStart(2,'0')}s${nextLabel}`;
  } else if (st.currentDossier && ['clicking', 'captcha_solving', 'waiting_result'].includes(st.phase)) {
    const ref = st.currentDossier.ref || st.currentDossier.appId.slice(0,8);
    els.phaseSub.textContent = `${cfg.sub} [${ref}]`;
  } else {
    els.phaseSub.textContent = cfg.sub;
  }

  els.statAttempts.textContent = st.attempts ?? 0;
  els.statCaptcha.textContent  = st.captchasSolved ?? 0;
  els.statNext.textContent     = st.nextRetryIn
    ? `${Math.floor(st.nextRetryIn / 60)}m${String(st.nextRetryIn % 60).padStart(2,'0')}s`
    : '—';
  els.statDossiers.textContent = st.dossierPool?.length || '—';

  // Flow steps
  const active = new Set(cfg.active);
  Object.entries(els.steps).forEach(([key, el]) => {
    if (!el) return;
    el.classList.toggle('active', active.has(key));
    el.classList.toggle('done',   st.phase === 'slot_found');
  });

  // Boutons start/stop
  const isRunning = st.running || st.phase === 'captcha_solving';
  els.btnStart.classList.toggle('hidden', isRunning);
  els.btnStop.classList.toggle('hidden',  !isRunning);

  // Bannière slot
  const hasSlot = st.phase === 'slot_found' || st.alarmActive;
  els.slotAlert.classList.toggle('hidden', !hasSlot);
  if (hasSlot && st.slotFound) {
    const s = st.slotFound;
    els.slotAlertDetail.textContent =
      `📅 ${s.date || '?'}${s.time ? ' à ' + s.time : ''}` +
      `${s.count > 1 ? ' — ' + s.count + ' créneaux disponibles' : ''}`;
  } else if (hasSlot) {
    els.slotAlertDetail.textContent = 'Ouvre le portail CEV maintenant !';
  }

  // Bannière rate-limit
  const isRL = st.phase === 'rate_limited' && st.rateLimitStartTs;
  els.rateLimitAlert.classList.toggle('hidden', !isRL);
  if (isRL) {
    const rem = RATE_LIMIT_PAUSE_MS - (Date.now() - st.rateLimitStartTs);
    els.rateLimitCountdown.textContent = `⏳ Reprise dans ${fmtCountdown(rem)}`;
    const shortReason = (st.rateLimitReason || '').replace(/^\[.*?\]\s*/, '').slice(0, 100);
    els.rateLimitReason.textContent = shortReason || 'Détecté par le serveur CEV';
  }

  // Dossier pool
  renderDossierPool(st.dossierPool, st.currentDossier, st.rrIndex);

  renderLogs(st.logs || []);
}

// Mise à jour countdown rate-limit toutes les secondes
setInterval(() => {
  const rl = els.rateLimitAlert;
  if (!rl || rl.classList.contains('hidden')) return;
  send({ type: 'GET_STATE' }).then(r => {
    if (!r?.state?.rateLimitStartTs) return;
    const rem = RATE_LIMIT_PAUSE_MS - (Date.now() - r.state.rateLimitStartTs);
    els.rateLimitCountdown.textContent = rem > 0
      ? `⏳ Reprise dans ${fmtCountdown(rem)}`
      : '✅ Pause terminée — reprise en cours…';
  });
}, 1000);

// ─── Logs ─────────────────────────────────────────────────────────────────────

let _lastLogs = [];

function renderLogs(logs) {
  _lastLogs = logs || [];
  if (!logs.length) {
    els.logContainer.innerHTML = '<div class="log-empty">Aucun événement</div>';
    return;
  }
  els.logContainer.innerHTML = logs.slice(0, 80).map(({ ts, level, msg }) => {
    const t   = new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : level === 'error' ? 'error' : '';
    return `<div class="log-entry ${cls}"><span class="log-time">${t}</span><span class="log-msg">${esc(msg)}</span></div>`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function copyLogs() {
  if (!_lastLogs.length) return;
  const text = _lastLogs.slice(0, 80).map(({ ts, level, msg }) => {
    const t   = new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const lvl = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : level === 'error' ? '❌' : '·';
    return `[${t}] ${lvl} ${msg}`;
  }).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    els.btnCopy.textContent = '✓';
    els.btnCopy.classList.add('copied');
    setTimeout(() => { els.btnCopy.textContent = '📋'; els.btnCopy.classList.remove('copied'); }, 1800);
  }).catch(() => {});
}

// ─── Config ───────────────────────────────────────────────────────────────────

function normalizeDossierId(raw) {
  const v = raw.trim().toUpperCase();
  if (!v) return '';
  return v.startsWith('VOWINT') ? v : 'VOWINT' + v;
}

function saveDossierId() {
  const raw = els.dossierId.value.trim();
  const id  = normalizeDossierId(raw);
  chrome.storage.local.set({ vowintDossierId: id }, () => {
    if (id) {
      els.dossierId.value = id;
      els.dossierStatus.textContent = `✓ Cible fixe : ${id}`;
      els.dossierStatus.className = 'field-hint ok';
    } else {
      els.dossierStatus.textContent = 'Vide = round-robin automatique sur tous les dossiers';
      els.dossierStatus.className = 'field-hint';
    }
    setTimeout(() => { els.dossierStatus.className = 'field-hint'; }, 2500);
    // Sync avec le background
    send({ type: 'SET_APPLICATION_ID', applicationId: id || null });
  });
}

function loadConfig() {
  chrome.storage.local.get(['anticaptchaKey', 'vowintDossierId', 'vowintEmail', 'vowintPassword'], d => {
    if (d.anticaptchaKey) { els.apiKey.value = d.anticaptchaKey; showKeyStatus('✓ Clé sauvegardée', 'ok'); }
    if (d.vowintDossierId) {
      els.dossierId.value = d.vowintDossierId;
      els.dossierStatus.textContent = `✓ Cible fixe : ${d.vowintDossierId}`;
      els.dossierStatus.className = 'field-hint ok';
    }
    if (d.vowintEmail)    els.vowintEmail.value    = d.vowintEmail;
    if (d.vowintPassword) els.vowintPassword.value = d.vowintPassword;
    if (d.vowintEmail && d.vowintPassword) {
      els.vowintStatus.textContent = `✓ Compte : ${d.vowintEmail}`;
      els.vowintStatus.className = 'field-hint ok';
    }
  });
}

function saveConfig() {
  saveDossierId();
  saveVowintCredentials();
  const k = els.apiKey.value.trim();
  if (!k || k.length < 10) {
    showKeyStatus('⚠ Clé Anti-Captcha invalide ou trop courte', 'error');
    return;
  }
  chrome.storage.local.set({ anticaptchaKey: k }, () => showKeyStatus('✓ Tout sauvegardé', 'ok'));
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

// ─── Démarrer / Arrêter / Acquitter ──────────────────────────────────────────

async function start() {
  const key = els.apiKey.value.trim() || await getKey();
  if (!key) { showKeyStatus('⚠ Entre ta clé Anti-Captcha d\'abord', 'error'); return; }
  chrome.storage.local.set({ anticaptchaKey: key });

  const rawId = els.dossierId.value.trim();
  const applicationId = rawId ? normalizeDossierId(rawId) : null;
  if (rawId && applicationId) saveDossierId();

  await send({ type: 'START', applicationId });
}

async function stop() { await send({ type: 'STOP' }); }
async function acknowledgeSlot() { await send({ type: 'ACKNOWLEDGE_SLOT' }); }

function getKey() {
  return new Promise(r => chrome.storage.local.get(['anticaptchaKey'], d => r(d.anticaptchaKey || '')));
}

// ─── Listeners ────────────────────────────────────────────────────────────────

els.btnSave.addEventListener('click', saveConfig);
els.btnStart.addEventListener('click', start);
els.btnStop.addEventListener('click', stop);
els.btnAck.addEventListener('click', acknowledgeSlot);
els.btnClear.addEventListener('click', () => send({ type: 'CLEAR_LOGS' }));
els.btnCopy.addEventListener('click', copyLogs);
els.btnReset.addEventListener('click', () => send({ type: 'RESET' }));
els.btnForceResume.addEventListener('click', async () => {
  await send({ type: 'CLEAR_RATE_LIMIT' });
  els.rateLimitAlert.classList.add('hidden');
});

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
els.dossierId.addEventListener('blur',         () => { if (els.dossierId.value.trim() !== undefined) saveDossierId(); });
els.vowintEmail.addEventListener('blur',       () => { if (els.vowintEmail.value.trim()) saveVowintCredentials(); });
els.vowintPassword.addEventListener('keydown', e => { if (e.key === 'Enter') saveVowintCredentials(); });

// Messages push du background
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'STATE_UPDATE') applyState(msg.state);
});

// Polling de sécurité toutes les 2s (SW peut être endormi)
setInterval(async () => {
  const r = await send({ type: 'GET_STATE' });
  if (r?.state) applyState(r.state);
}, 2000);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  loadConfig();

  els.phaseLabel.textContent = '…';
  els.phaseSub.textContent   = 'Chargement…';

  // Tentatives multiples si le SW met du temps à répondre
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await send({ type: 'GET_STATE' });
    if (r?.state) break;
    await new Promise(res => setTimeout(res, 500));
  }

  if (r?.state) {
    applyState(r.state);
  } else {
    // SW inactif
    els.btnStart.classList.remove('hidden');
    els.btnStop.classList.add('hidden');
    els.phaseLabel.textContent = 'Inactif';
    els.phaseSub.textContent   = 'Configure la clé puis démarre';
  }
}

init();
