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
  // Appel natif : garantit le déclenchement du ng-click AngularJS
  el.click();
}

// ─── Recherche du bouton RDV ──────────────────────────────────────────────────

/**
 * Cherche le bouton "Prendre rendez-vous" sur la page.
 * Si applicationId est fourni, cible le bouton de la demande correspondante.
 * Sinon, prend le premier bouton visible.
 */
function findRdvButton(applicationId) {
  // ── Stratégie 1 : sélecteur AngularJS direct (portail VOWINT réel) ──────────
  // Le bouton réel utilise ng-click="groupVAEapp(...)" sur le portail VOWINT
  const ngClickCandidates = Array.from(
    document.querySelectorAll('[ng-click*="groupVAEapp"], [ng-click*="rdv"], [ng-click*="appointment"]')
  );

  if (ngClickCandidates.length) {
    // Si applicationId fourni, chercher dans le contexte de la bonne demande
    if (applicationId) {
      for (const btn of ngClickCandidates) {
        let el = btn;
        for (let i = 0; i < 8; i++) {
          if (!el) break;
          if ((el.textContent || '').includes(applicationId) ||
              el.getAttribute('data-id') === applicationId ||
              el.getAttribute('data-application-id') === applicationId) {
            return btn;
          }
          el = el.parentElement;
        }
      }
    }
    // Premier visible
    const visible = ngClickCandidates.find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (visible) return visible;
  }

  // ── Stratégie 2 : recherche par texte (fallback générique) ──────────────────
  const allBtns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));

  const rdvTexts = [
    'prendre rendez-vous',
    'rendez-vous',
    'afspraak',
    'appointment',
    'make appointment',
    'book',
    'réserver',
    'calendar',
    'calendrier',
  ];

  const candidates = allBtns.filter(el => {
    const txt = (el.textContent || el.value || el.title || el.getAttribute('aria-label') || '').toLowerCase().trim();
    return rdvTexts.some(t => txt.includes(t));
  });

  if (!candidates.length) return null;

  // Si applicationId fourni : cherche dans le contexte de la bonne demande
  if (applicationId) {
    for (const btn of candidates) {
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

// ─── Détection login page ─────────────────────────────────────────────────────

/**
 * Vérifie si on est sur la page de login VOWINT (session expirée).
 * Cherche les éléments propres au formulaire de login.
 */
function isLoginPage() {
  // Formulaire de connexion VOWINT : champs UserName + Password
  if (document.querySelector('#UserName') && document.querySelector('#Password')) return true;
  // Champ email login alternatif
  if (document.querySelector('input[name="UserName"], input[name="Email"], input[type="email"]') &&
      document.querySelector('input[type="password"]')) {
    // Vérifier qu'on n'est PAS sur une page VisaApplication (qui pourrait avoir des champs)
    const isAppPage = document.querySelector('[ng-click*="groupVAEapp"]') ||
                      document.querySelector('[ng-repeat*="vaeGroup"]') ||
                      document.querySelector('[ng-controller]');
    if (!isAppPage) return true;
  }
  return false;
}

// Signaler l'état de la page au background dès le chargement
if (isLoginPage()) {
  chrome.runtime.sendMessage({ type: 'VOWINT_LOGIN_PAGE' });
  // Ne pas continuer — inutile de logger "prêt" si on est déconnecté
} else {
  chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg: '📄 Page VOWINT détectée — prêt' });
}
