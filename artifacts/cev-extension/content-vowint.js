/**
 * content-vowint.js — visaonweb.diplomatie.be  v4.0
 *
 * Nouveautés v4 :
 *   • LIST_DOSSIERS  — liste tous les dossiers actifs sans déclencher de scan
 *   • CLICK_RDV_BUTTON — accepte targetAppId pour le round-robin BG
 *   • Retourne toujours allDossiers dans la réponse (pool mis à jour côté BG)
 *   • Détection page précise → VOWINT_PAGE_TYPE envoyé au background
 *   • Priority: u=1, i  sur tous les XHR (aligné Burp Chrome 146)
 *   • Cache-Control + If-Modified-Since sur GetEAppointmentUrl (déjà correct,
 *     confirmé Burp — conservé explicitement)
 *   • humanPageScan() enrichi (scroll + mouse + micro-pauses réalistes)
 */

'use strict';

const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Détection de la page ─────────────────────────────────────────────────────

function detectVowintPageType() {
  const path = window.location.pathname.toLowerCase();
  const url  = window.location.href.toLowerCase();

  // Page login
  if (
    path.includes('/account/') ||
    path.includes('/login')    ||
    url.includes('returnurl')  ||
    (document.querySelector('#UserName') && document.querySelector('#Password'))
  ) return 'login';

  // Page Mes Applications (liste des dossiers)
  if (path.includes('/visaapplication/indexbyuserid')) return 'applications';

  // Autres pages VOWINT authentifiées
  if (path.includes('/en/') || path.includes('/fr/') || path.includes('/nl/')) return 'authenticated';

  return 'unknown';
}

// ─── Extraction appIds ────────────────────────────────────────────────────────

/**
 * Cherche TOUS les UUIDs d'application dans le HTML de la page.
 * Retourne [{ appId, ref, label }] — ref = numéro VOWINT, label = texte affiché.
 */
function extractAllDossiers() {
  const html  = document.documentElement.innerHTML;
  const htmlL = html.toLowerCase();
  // Map uuid_lowercase → position dans html (première occurrence significative)
  const seen  = new Map();

  // 1. GetEAppointmentUrl?id= dans attributs / scripts
  for (const m of html.matchAll(/GetEAppointmentUrl\?id=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi)) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) seen.set(id, m.index + m[0].length - id.length);
  }

  // 2. ng-click="groupVAEapp('uuid')" ou pattern similaire
  for (const m of html.matchAll(/ng-click="[^"]*\('([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})'/gi)) {
    const id = m[1].toLowerCase();
    if (!seen.has(id)) seen.set(id, m.index + m[0].length - id.length);
  }

  // 3. data-id / data-app-id / data-application-id
  for (const el of document.querySelectorAll('[data-id],[data-app-id],[data-application-id]')) {
    const raw = el.getAttribute('data-id') ||
                el.getAttribute('data-app-id') ||
                el.getAttribute('data-application-id') || '';
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-/i.test(raw)) {
      const id  = raw.toLowerCase();
      if (!seen.has(id)) seen.set(id, htmlL.indexOf(id));
    }
  }

  if (!seen.size) return [];

  // Enrichir chaque appId : ref VOWINT LA PLUS PROCHE de l'UUID (pas le 1er match)
  const enriched = [...seen.entries()].map(([appId, idx]) => {
    const ctxStart     = Math.max(0, idx - 800);
    const ctxEnd       = Math.min(html.length, idx + 800);
    const ctx          = idx !== -1 ? html.slice(ctxStart, ctxEnd) : '';
    const uuidPosInCtx = idx - ctxStart;

    let closestRef = null;
    let minDist    = Infinity;
    for (const m of ctx.matchAll(/VOWINT(\d{6,10})/gi)) {
      const dist = Math.abs(m.index - uuidPosInCtx);
      if (dist < minDist) { minDist = dist; closestRef = m; }
    }
    const ref = closestRef ? `VOWINT${closestRef[1]}` : null;

    let label = '';
    if (idx !== -1) {
      const stripped = ctx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const labelMatch = stripped.match(/\b([A-Z][a-zÀ-ÿ]{3,}\s+[a-zÀ-ÿA-Z ]{2,30})\b/);
      if (labelMatch) label = labelMatch[1].trim().slice(0, 40);
    }

    return { appId, ref, label, _refDist: minDist };
  });

  // Dédupliquer par ref : si deux UUIDs ont le même ref VOWINT, garder
  // celui dont l'UUID est physiquement le plus proche du ref (= le vrai bouton)
  const refMap = new Map();
  for (const d of enriched) {
    if (!d.ref) continue;
    const existing = refMap.get(d.ref);
    if (!existing || d._refDist < existing._refDist) refMap.set(d.ref, d);
  }
  const noRef = enriched.filter(d => !d.ref);

  return [...refMap.values(), ...noRef].map(({ appId, ref, label }) => ({ appId, ref, label }));
}

/**
 * Sélectionne le dossier cible selon la priorité :
 *   1. targetAppId (round-robin BG) → match exact UUID
 *   2. vowintRef (dossier fixe)     → match HTML + ref extraites
 *   3. Aucune contrainte            → premier de la liste (round-robin libre)
 *
 * Retourne null si une cible explicite est demandée mais introuvable —
 * le background doit alors skipper le scan, PAS utiliser un autre dossier.
 */
function selectDossier(dossiers, vowintRef, targetAppId) {
  if (!dossiers.length) return null;

  // ── Priorité 1 : UUID exact fourni par le BG (round-robin) ────────────────
  if (targetAppId) {
    const found = dossiers.find(d => d.appId === targetAppId);
    if (found) return found;
    // targetAppId fourni mais introuvable → refus strict (pas de fallback)
    return { __notFound: true, targetAppId };
  }

  // ── Priorité 2 : ref VOWINT fixe (ex : VOWINT5903406) ────────────────────
  if (vowintRef) {
    const html    = document.documentElement.innerHTML;
    const refNorm = vowintRef.toUpperCase().replace(/\s+/g, '');
    const idx     = html.indexOf(refNorm);

    if (idx !== -1) {
      const ctx = html.slice(Math.max(0, idx - 1000), idx + 1000);
      const m   = ctx.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
      if (m) {
        const found = dossiers.find(d => d.appId === m[0]);
        if (found) return found;
      }
    }

    // Chercher dans les refs extraites
    const byRef = dossiers.find(d =>
      d.ref && (d.ref === refNorm || d.ref.includes(vowintRef) || vowintRef.includes(d.ref))
    );
    if (byRef) return byRef;

    // vowintRef fourni mais introuvable → refus strict
    return { __notFound: true, vowintRef };
  }

  // ── Priorité 3 : round-robin libre (pas de contrainte) ───────────────────
  return dossiers[0];
}

// ─── XHR GetEAppointmentUrl ───────────────────────────────────────────────────

/**
 * Reproduit exactement le XHR que le bouton "Prendre rendez-vous" déclencherait.
 * Headers alignés sur capture Burp Chrome 146 (audit 2026-06-26) :
 *   - X-Requested-With: XMLHttpRequest
 *   - Accept: application/json, text/plain, *‌/*
 *   - Cache-Control: max-age=0 (AngularJS $http anti-304)
 *   - If-Modified-Since: 0
 *   - Priority: u=1, i  (Chrome 117+ XHR feature)
 */
async function getEAppointmentUrl(appId, lang) {
  const referer = `${VOWINT_BASE}/${lang || 'en'}/VisaApplication/IndexByUserId`;
  const url     = `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${appId}`;

  const resp = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'X-Requested-With':  'XMLHttpRequest',
      'Accept':            'application/json, text/plain, */*',
      'Cache-Control':     'max-age=0',
      'If-Modified-Since': '0',
      'Accept-Language':   'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer':           referer,
      'Priority':          'u=1, i',
    },
  });

  if (!resp.ok) throw new Error(`GetEAppointmentUrl HTTP ${resp.status}`);

  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('json') || ct.includes('javascript')) {
    const data = await resp.json().catch(() => null);
    if (typeof data === 'string') return data;
    if (data?.url)            return data.url;
    if (data?.redirectUrl)    return data.redirectUrl;
    if (data?.integrationUrl) return data.integrationUrl;
    for (const v of Object.values(data || {})) {
      if (typeof v === 'string' && v.includes('appointment.cloud.diplomatie.be')) return v;
    }
    return null;
  }

  const text = (await resp.text()).trim();
  if (text.startsWith('http')) return text;
  const m = text.match(/https?:\/\/appointment\.cloud\.diplomatie\.be[^\s"'<>]+/);
  return m?.[0] || null;
}

// ─── Comportement humain ──────────────────────────────────────────────────────

/**
 * Simule un humain qui lit la page avant d'agir :
 *   - Scroll partiel (2-4 pas, vitesse variable)
 *   - Mouvements souris aléatoires (4-7)
 *   - Micro-pauses entre chaque action
 *   - Durée totale : 1.2-3.5 s (concentrée ~1.8 s)
 */
async function humanPageScan() {
  const docH = Math.max(document.body?.scrollHeight || 800, 800);

  // Scroll initial rapide (découvrir la page)
  const scrollSteps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrollSteps; i++) {
    const target = Math.floor(Math.random() * docH * 0.6);
    window.scrollTo({ top: target, behavior: 'smooth' });
    await sleep(250 + Math.random() * 350);
  }
  // Revenir vers le haut (comme un humain qui cherche le bouton)
  window.scrollTo({ top: Math.floor(Math.random() * 200), behavior: 'smooth' });
  await sleep(200 + Math.random() * 300);

  // Mouvements souris
  const mouseMoves = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < mouseMoves; i++) {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 60 + Math.random() * (window.innerWidth  - 120),
      clientY: 60 + Math.random() * (window.innerHeight - 120),
    }));
    await sleep(60 + Math.random() * 180);
  }

  // Pause finale avant action (simule le temps de lecture)
  await sleep(500 + Math.random() * 900);
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
    await sleep(30 + Math.random() * 100);
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur',   { bubbles: true }));
}

// ─── Détection langue de la page ─────────────────────────────────────────────

function detectLang() {
  const m = window.location.pathname.match(/\/([a-z]{2})\//i);
  if (m && ['fr', 'en', 'nl'].includes(m[1].toLowerCase())) return m[1].toLowerCase();
  return document.documentElement.lang?.slice(0, 2).toLowerCase() || 'en';
}

// ─── Messages entrants ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Ping (détection content script actif) ─────────────────────────────────
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }

  // ── Login automatique ──────────────────────────────────────────────────────
  if (msg.type === 'AUTO_LOGIN') {
    const emailIn = document.querySelector('#UserName, input[name="UserName"], input[type="email"]:not([readonly])');
    const passIn  = document.querySelector('#Password, input[name="Password"], input[type="password"]');
    const submit  = document.querySelector('button[type="submit"], input[type="submit"], .btn-primary[type="submit"]');

    if (!emailIn || !passIn) {
      sendResponse({ ok: false, error: 'Champs login introuvables' });
      return;
    }
    (async () => {
      try {
        await humanFill(emailIn, msg.email);
        await sleep(280 + Math.random() * 450);
        await humanFill(passIn,  msg.password);
        await sleep(380 + Math.random() * 600);
        if (submit) submit.click();
        else if (passIn.form) passIn.form.submit();
        else passIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        sendResponse({ ok: true });
      } catch (err) { sendResponse({ ok: false, error: err.message }); }
    })();
    return true;
  }

  // ── Lister les dossiers sans scan (sonde pool) ───────────────────────────
  if (msg.type === 'LIST_DOSSIERS') {
    (async () => {
      let dossiers = extractAllDossiers();
      if (!dossiers.length) {
        // Attendre le rendu AngularJS (jusqu'à 10s)
        let waited = 0;
        while (!dossiers.length && waited < 10_000) {
          await sleep(400);
          waited += 400;
          dossiers = extractAllDossiers();
        }
      }
      sendResponse({ ok: true, dossiers });
    })();
    return true;
  }

  // ── Déclenchement scan (round-robin ou cible fixe) ───────────────────────
  if (msg.type === 'CLICK_RDV_BUTTON' || msg.type === 'FETCH_CEV_URL') {
    (async () => {
      try {
        // Comportement humain avant d'agir
        await humanPageScan();

        // Attendre le rendu AngularJS (jusqu'à 12s)
        let dossiers = extractAllDossiers();
        if (!dossiers.length) {
          chrome.runtime.sendMessage({ type: 'LOG', level: 'info', msg: '⏳ Attente rendu AngularJS (jusqu\'à 12s)…' });
          let waited = 0;
          while (!dossiers.length && waited < 12_000) {
            await sleep(400);
            waited += 400;
            dossiers = extractAllDossiers();
          }
        }

        if (!dossiers.length) {
          // Debug : dump UUIDs bruts
          const anyUuids = [...document.documentElement.innerHTML
            .matchAll(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi)]
            .map(m => m[0]);
          chrome.runtime.sendMessage({
            type: 'LOG', level: 'warn',
            msg: `⚠️ Aucun appId après 12s. UUIDs bruts: [${[...new Set(anyUuids)].slice(0,5).join(', ')}]`,
          });
          sendResponse({ ok: false, error: 'Aucun dossier trouvé après 12s — Mes Applications VOWINT chargée ?' });
          return;
        }

        // Sélection du dossier cible
        const dossier = selectDossier(dossiers, msg.vowintRef, msg.targetAppId);
        if (!dossier) {
          sendResponse({ ok: false, error: 'Aucun dossier trouvé', dossiers });
          return;
        }
        // Cible explicite demandée mais introuvable → refus strict (pas de scan sur mauvais dossier)
        if (dossier.__notFound) {
          const what = dossier.targetAppId
            ? `appId ${dossier.targetAppId.slice(0, 8)}…`
            : `ref ${dossier.vowintRef}`;
          sendResponse({ ok: false, error: `Dossier cible [${what}] introuvable sur la page — pool mis à jour`, dossiers });
          return;
        }

        chrome.runtime.sendMessage({
          type: 'LOG', level: 'info',
          msg: `🔗 Dossier: ${dossier.ref || dossier.appId.slice(0,8)} (${dossiers.length} total) — XHR GetEAppointmentUrl…`,
        });

        // Délai "clic humain" (temps de pointer le bouton)
        await sleep(350 + Math.random() * 700);

        const lang   = detectLang();
        const cevUrl = await getEAppointmentUrl(dossier.appId, lang);

        if (!cevUrl) {
          sendResponse({ ok: false, error: 'GetEAppointmentUrl n\'a pas retourné d\'URL CEV', dossiers });
          return;
        }

        chrome.runtime.sendMessage({
          type: 'LOG', level: 'info',
          msg: `🌐 URL CEV obtenue → ${cevUrl.slice(0, 60)}…`,
        });

        sendResponse({ ok: true, cevUrl, appId: dossier.appId, dossiers });

      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // async
  }
});

// ─── Init — détection page + signalement au background ───────────────────────

(async () => {
  await sleep(400 + Math.random() * 300);

  const pageType = detectVowintPageType();

  // Sur la page Mes Applications, extraire les dossiers et les signaler
  let dossiers = [];
  if (pageType === 'applications') {
    dossiers = extractAllDossiers();
    if (!dossiers.length) {
      // Attendre le rendu AngularJS
      let waited = 0;
      while (!dossiers.length && waited < 8_000) {
        await sleep(400);
        waited += 400;
        dossiers = extractAllDossiers();
      }
    }
  }

  chrome.runtime.sendMessage({
    type: 'VOWINT_PAGE_TYPE',
    pageType,
    dossiers,
    url: window.location.href,
  });

  if (pageType === 'login') {
    chrome.runtime.sendMessage({ type: 'VOWINT_LOGIN_PAGE' });
  }

  if (pageType === 'applications' && dossiers.length) {
    chrome.runtime.sendMessage({
      type: 'LOG', level: 'info',
      msg: `📋 VOWINT prêt — ${dossiers.length} dossier(s): ${dossiers.map(d => d.ref || d.appId.slice(0,8)).join(', ')}`,
    });
  } else {
    chrome.runtime.sendMessage({
      type: 'LOG', level: 'info',
      msg: `📄 VOWINT [${pageType}] @ ${window.location.pathname.slice(0, 60)}`,
    });
  }
})();
