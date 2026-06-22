'use strict';

let alarmInterval = null;
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Joue une sonnerie d'alerte distinctive (3 bips rapides puis pause).
 * Inspirée des alertes médicales urgentes.
 */
function playAlarmBeep() {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;

  const pattern = [
    { freq: 880, start: 0.00, dur: 0.12 },
    { freq: 660, start: 0.15, dur: 0.08 },
    { freq: 880, start: 0.26, dur: 0.12 },
    { freq: 660, start: 0.41, dur: 0.08 },
    { freq: 1100, start: 0.52, dur: 0.20 },
  ];

  pattern.forEach(({ freq, start, dur }) => {
    const osc   = ctx.createOscillator();
    const gain  = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type      = 'square';
    osc.frequency.setValueAtTime(freq, now + start);

    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.35, now + start + 0.01);
    gain.gain.linearRampToValueAtTime(0.35, now + start + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0,   now + start + dur);

    osc.start(now + start);
    osc.stop(now  + start + dur + 0.01);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ALARM_START') {
    playAlarmBeep();
    if (!alarmInterval) {
      alarmInterval = setInterval(playAlarmBeep, 4000);
    }
  } else if (msg.type === 'ALARM_STOP') {
    clearInterval(alarmInterval);
    alarmInterval = null;
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  } else if (msg.type === 'ALARM_PING') {
    playAlarmBeep();
  }
});
