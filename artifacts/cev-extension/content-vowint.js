/**
 * content-vowint.js — visaonweb.diplomatie.be
 *
 * FIX ORION/iOS : WebKit bloque window.open() depuis des MouseEvent synthétiques.
 * Solution : on ne clique JAMAIS le bouton.
 * À la place :
 *   1. On extrait l'appId depuis le HTML de la page
 *   2. On fait nous-mêmes le XHR GET /Common/GetEAppointmentUrl?id={appId}
 *      (c'est exactement ce que le bouton ferait — même cookies, même session)
 *   3. On envoie l'URL CEV au background → chrome.tabs.create() → aucun popup bloqué
 *
 * Sur Firefox PC l'ancien clic fonctionnait, mais cette approche marche partout
 * et est aussi plus fiable (pas de dépendance au DOM du bouton).
 */

'use strict';

const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Extraction appId depuis le HTML ──────────────────────────────────────────

/**
 * Cherche l'appId (UUID) dans le HTML de la page.
 * VOWINT embed les UUIDs dans les attributs ng-click, data-*, href ou
 * directement dans les scripts inline.
 *
 * Depuis cevHttpSetup.ts ligne 421 :
 *   html.match(/GetEAppointmentUrl\?id=([a-f0-9-]+)/i)
 */
function extractAppIds() {
  const html = document.documentElement.innerHTML;
  const ids = new Set();

  // 1. GetEAppointmentUrl?id= dans les attributs/scripts
  for (const m of html.matchAll(/GetEAppointmentUrl\?id=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi)) {
    ids.add(m[1]);
  }

  // 2. ng-click="groupVAEapp('uuid')" ou ng-click="...('uuid',...)"
  for (const m of html.matchAll(/ng-click="[^"]*\('([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})'/gi)) {
    ids.add(m[1]);
  }

  // 3. data-id="uuid" ou data-app-id="uuid"
  for (const el of document.querySelectorAll('[data-id], [data-app-id], [data-application-id]')) {
    const id = el.getAttribute('data-id') || el.getAttribute('data-app-id') || el.getAttribute('data-application-id') || '';
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-/i.test(id)) ids.add(id);
  }

  return [...ids];
}

/**
 * Sélectionne l'appId correspondant à une demande VOWINT précise (par numéro ex: VOWINT6085888).
 * Fallback : premier appId disponible.
 */
function selectAppId(appIds, vowintRef) {
  if (!appIds.length) return null;
  if (!vowintRef || appIds.length === 1) return appIds[0];

  // Chercher dans le HTML le numéro VOWINT près de l'UUID correspondant
  const html = document.documentElement.innerHTML;
  const refNorm = vowintRef.toUpperCase().replace(/\s+/g, '');
  const refMatch = html.indexOf(refNorm);
  if (refMatch !== -1) {
    // Chercher un UUID dans un rayon de 2000 chars autour du numéro VOWINT
    const window = html.slice(Math.max(0, refMatch - 1000), refMatch + 1000);
    const uuidMatch = window.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (uuidMatch && appIds.includes(uuidMatch[0])) return uuidMatch[0];
  }

  return appIds[0];
}

// ─── XHR GetEAppointmentUrl ───────────────────────────────────────────────────

/**
 * Fait le vrai appel XHR que le bouton déclencherait.
 * Retourne l'URL d'intégration CEV ou null.
 *
 * Headers reproduits depuis capture-1780347172859.json (req 227) :
 *   X-Requested-With: XMLHttpRequest
 *   Accept: application/json, text/plain, *‌/*
 *   If-Modified-Since: 0
 *   Referer: .../en/VisaApplication/IndexByUserId
 */
async function getEAppointmentUrl(appId) {
  const url = `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${appId}`;

  const resp = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
      'If-Modified-Since': '0',
      'Referer': `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
      'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8',
    },
  });

  if (!resp.ok) throw new Error(`GetEAppointmentUrl HTTP ${resp.status}`);

  // La réponse peut être :
  //  - une URL directe (string)       "https://appointment.cloud.diplomatie.be/Integration/..."
  //  - un objet JSON { url: "..." }
  //  - un objet JSON { redirectUrl: "..." }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('json') || ct.includes('javascript')) {
    const data = await resp.json().catch(() => null);
    if (typeof data === 'string') return data;
    if (data?.url)         return data.url;
    if (data?.redirectUrl) return data.redirectUrl;
    if (data?.integrationUrl) return data.integrationUrl;
    // Si l'objet contient une propriété qui ressemble à une URL CEV
    for (const v of Object.values(data || {})) {
      if (typeof v === 'string' && v.includes('appointment.cloud.diplomatie.be')) return v;
    }
    return null;
  }

  // Réponse texte brut = URL directe
  const text = (await resp.text()).trim();
  if (text.startsWith('http')) return text;

  // Parfois c'est du HTML avec une meta refresh ou une URL dans le corps
  const m = text.match(/https?:\/\/appointment\.cloud\.diplomatie\.be[^\s"'<>]+/);
  return m?.[0] || null;
}

// ─── Comportement humain avant le scan ────────────────────────────────────────

async function humanPageScan() {
  const docH = Math.max(document.body.scrollHeight, 800);
  const scrollSteps = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < scrollSteps; i++) {
    window.scrollTo({ top: Math.floor(Math.random() * docH * 0.5), behavior: 'smooth' });
    await sleep(300 + Math.random() * 500);
  }
  // Mouvement souris aléatoire
  for (let i = 0; i < 3 + Math.floor(Math.random() * 3); i++) {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 80 + Math.random() * (window.innerWidth  - 160),
      clientY: 80 + Math.random() * (window.innerHeight - 160),
    }));
    await sleep(80 + Math.random() * 200);
  }
  await sleep(600 + Math.random() * 1200);
}

// ─── Frappe humaine (login) ───────────────────────────────────────────────────

async function humanFill(input, text) {
  input.focus();
  input.value = '';
  input.dispatchEvent(new Event('focus', { bubbles: true }));
  for (const char of String(text)) {
    input.value += char;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: char }));
    await sleep(35 + Math.random() * 90);
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur',   { bubbles: true }));
}

// ─── Messages du background ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Login automatique ────────────────────────────────────────────────────
  if (msg.type === 'AUTO_LOGIN') {
    const emailInput    = document.querySelector('#UserName, input[name="UserName"], input[type="email"]:not([readonly])');
    const passwordInput = document.querySelector('#Password, input[name="Password"], input[type="password"]');
    const submitBtn     = document.querySelector('button[type="submit"], input[type="submit"], .btn-primary[type="submit"]');

    if (!emailInput || !passwordInput) {
      sendResponse({ ok: false, error: 'Champs login introuvables' });
      return;
    }
    (async () => {
      try {
        await humanFill(emailInput, msg.email);
        await sleep(300 + Math.random() * 500);
        await humanFill(passwordInput, msg.password);
        await sleep(400 + Math.random() * 700);
        if (submitBtn) submitBtn.click();
        else if (passwordInput.form) passwordInput.form.submit();
        else passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        sendResponse({ ok: true });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  // ── Déclenchement du scan (remplace l'ancien CLICK_RDV_BUTTON) ──────────
  if (msg.type === 'CLICK_RDV_BUTTON' || msg.type === 'FETCH_CEV_URL') {
    (async () => {
      try {
        // Comportement humain avant d'agir
        await humanPageScan();

        // Attendre que AngularJS ait rendu la liste des dossiers.
        // La page /VisaApplication/IndexByUserId passe à status="complete" dès le HTML
        // initial, mais les UUIDs (GetEAppointmentUrl / ng-click) sont injectés par XHR
        // AngularJS 200-3000ms plus tard. Sans cette attente, extractAppIds() trouve 0 id.
        let appIds = extractAppIds();
        if (!appIds.length) {
          chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg: '⏳ Mes Applications — attente rendu AngularJS (jusqu\'à 12s)…' });
          let waited = 0;
          while (!appIds.length && waited < 12_000) {
            await sleep(400);
            waited += 400;
            appIds = extractAppIds();
          }
        }

        if (!appIds.length) {
          // Debug : dumper le HTML de la page pour identifier le bon pattern
          const bodySnippet = document.body ? document.body.innerHTML.slice(0, 3000) : '(body vide)';
          // Chercher toute occurrence d'UUID dans le DOM (pattern large)
          const anyUuids = [...document.documentElement.innerHTML.matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)].map(m => m[0]);
          chrome.runtime.sendMessage({
            type: 'LOG', level: 'warn',
            msg: `⚠️ Aucun appId après 12s. UUIDs bruts trouvés: [${[...new Set(anyUuids)].slice(0, 5).join(', ')}] — DOM aperçu: ${bodySnippet.slice(0, 500).replace(/\s+/g, ' ')}`,
          });
          sendResponse({ ok: false, error: 'Aucun appId trouvé après 12s — vérifie que la page "Mes applications" VOWINT est chargée et que des dossiers sont visibles' });
          return;
        }

        const appId = selectAppId(appIds, msg.vowintRef);
        chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg: `🔗 appId sélectionné: ${appId.slice(0, 8)}… (${appIds.length} trouvé(s))` });

        // Délai humain avant l'appel (simule le temps pour "viser" le bouton)
        await sleep(400 + Math.random() * 800);

        // XHR GetEAppointmentUrl — équivalent exact du clic bouton
        const cevUrl = await getEAppointmentUrl(appId);

        if (!cevUrl) {
          sendResponse({ ok: false, error: 'GetEAppointmentUrl n\'a pas retourné d\'URL CEV valide' });
          return;
        }

        chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg: `🌐 URL CEV obtenue → ${cevUrl.slice(0, 60)}…` });

        // Envoyer l'URL au background pour ouverture via chrome.tabs.create
        // (pas de window.open → pas de popup blocker sur Orion/WebKit)
        sendResponse({ ok: true, cevUrl, appId });

      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // async
  }
});

// ─── Détection login page ─────────────────────────────────────────────────────

function isLoginPage() {
  if (document.querySelector('#UserName') && document.querySelector('#Password')) return true;
  const hasEmail = document.querySelector('input[name="UserName"], input[name="Email"], input[type="email"]');
  const hasPass  = document.querySelector('input[type="password"]');
  if (hasEmail && hasPass) {
    const isAppPage = document.querySelector('[ng-click*="groupVAEapp"], [ng-repeat], [ng-controller]');
    if (!isAppPage) return true;
  }
  return false;
}

if (isLoginPage()) {
  chrome.runtime.sendMessage({ type: 'VOWINT_LOGIN_PAGE' });
} else {
  chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg: '📄 VOWINT prêt — extraction appId disponible' });
}
