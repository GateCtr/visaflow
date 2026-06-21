/**
 * content-vowint.js — Script sur visaonweb.diplomatie.be
 *
 * Rôle unique : trouver et cliquer le bouton "Prendre rendez-vous"
 * de la bonne demande quand le background le demande.
 *
 * Le bouton ouvre un nouveau onglet avec l'URL d'intégration CEV éphémère.
 */

'use strict';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Simulation clic humain ───────────────────────────────────────────────────

async function humanClick(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width  * (0.35 + Math.random() * 0.3);
  const y = rect.top  + rect.height * (0.35 + Math.random() * 0.3);

  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new MouseEvent('mouseover',  opts));
  await sleep(40 + Math.random() * 80);
  el.dispatchEvent(new MouseEvent('mousemove',  opts));
  await sleep(20 + Math.random() * 60);
  el.dispatchEvent(new MouseEvent('mousedown',  opts));
  await sleep(60 + Math.random() * 120);
  el.dispatchEvent(new MouseEvent('mouseup',    opts));
  await sleep(10 + Math.random() * 30);
  el.dispatchEvent(new MouseEvent('click',      opts));
}

// ─── Recherche du bouton RDV ──────────────────────────────────────────────────

/**
 * Cherche le bouton "Prendre rendez-vous" sur la page.
 * Si applicationId est fourni, cible le bouton de la demande correspondante.
 * Sinon, prend le premier bouton visible.
 */
function findRdvButton(applicationId) {
  const allBtns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));

  // Textes attendus (FR / NL / EN)
  const rdvTexts = [
    'prendre rendez-vous',
    'rendez-vous',
    'afspraak',
    'appointment',
    'make appointment',
    'book',
    'réserver',
  ];

  const candidates = allBtns.filter(el => {
    const txt = (el.textContent || el.value || el.title || el.getAttribute('aria-label') || '').toLowerCase().trim();
    return rdvTexts.some(t => txt.includes(t));
  });

  if (!candidates.length) return null;

  // Si applicationId fourni : cherche dans le contexte de la bonne demande
  if (applicationId) {
    for (const btn of candidates) {
      // Cherche un ancêtre contenant l'ID de la demande
      let el = btn;
      for (let i = 0; i < 8; i++) {
        if (!el) break;
        const text = el.textContent || '';
        const dataId = el.getAttribute('data-id') || el.getAttribute('data-application-id') || '';
        if (text.includes(applicationId) || dataId === applicationId) {
          return btn;
        }
        el = el.parentElement;
      }
    }
  }

  // Sinon, premier bouton visible
  return candidates.find(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) || candidates[0];
}

// ─── Écoute des messages du background ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CLICK_RDV_BUTTON') return;

  const btn = findRdvButton(msg.applicationId);

  if (!btn) {
    const btns = Array.from(document.querySelectorAll('a, button')).map(e => e.textContent?.trim().slice(0, 30));
    sendResponse({
      ok: false,
      error: `Bouton "Prendre rendez-vous" introuvable. Boutons sur la page: ${btns.slice(0, 10).join(' | ')}`,
    });
    return;
  }

  // Scroll vers le bouton + clic humain
  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  sleep(300 + Math.random() * 400).then(async () => {
    await humanClick(btn);
    sendResponse({ ok: true, buttonText: btn.textContent?.trim().slice(0, 50) });
  });

  return true; // async
});

// Signaler au background que la page VOWINT est prête
chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg: '📄 Page VOWINT détectée — prêt' });
