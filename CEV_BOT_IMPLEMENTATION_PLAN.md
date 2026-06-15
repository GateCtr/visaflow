# Plan d'Implémentation Complet — Bot CEV Anti-Shadow-Ban
> Version: 2.0 FINAL — 2026-06-15  
> Basé sur : analyse captures réelles debug-dumps (2026-06-08/09), réponses Amazon Q, code source complet du bot  
> Objectif : Éliminer le shadow ban, rendre le bot indétectable, prêt pour comptes CEV Kinshasa

---

## 📋 RÉSUMÉ EXÉCUTIF

Le bot CEV est actuellement **shadow-banné au niveau du compte VOWINT email**, pas seulement par IP. Le système de détection est F5 BIG-IP + OutSystems Behavioral Analytics, et non Cloudflare. La cause racine est une **rupture comportementale massive** entre la phase Puppeteer (capture cookie F5) et la phase impit HTTP (polling) — deux empreintes TLS/comportementales totalement différentes sur la même session authentifiée.

**Preuve directe des captures réelles** : la capture Playwright (2026-06-09) montre `"HeadlessChrome"` dans `sec-ch-ua`, immédiatement détectable. Les captures humaines montrent `"Chromium";v="148"` avec `"Not/A)Brand"` — format différent.

**Solution architecture** : Étendre Puppeteer pour couvrir le flow complet (login → MyList → GetEAppointmentUrl → captcha → /Captcha/SetCaptchaToken), puis utiliser impit uniquement pour le polling haute fréquence. Zéro rupture de session.

---

## 🔬 ANALYSE ROOT CAUSE — PREUVES DES CAPTURES RÉELLES

### Preuve #1 : HeadlessChrome dans sec-ch-ua (CRITIQUE)

**Capture réelle `2026-06-09T03-56-05-vowint-api.json` ligne 12 :**
```json
"sec-ch-ua": "\"Not:A-Brand\";v=\"99\", \"HeadlessChrome\";v=\"145\", \"Chromium\";v=\"145\""
```

**Ce que voit un vrai Chrome 148 (`2026-06-08T17-14-59-targets.json`) :**
```json
"sec-ch-ua": "\"Not/A)Brand\";v=\"99\", \"Chromium\";v=\"148\""
```

→ **Deux problèmes simultanés** :
1. `HeadlessChrome` est présent → détection immédiate (confiance 0.95 Amazon Q)
2. Format `"Not:A-Brand"` vs `"Not/A)Brand"` — différence subtile mais fingerprinted
3. Version v145 vs v148 — le UA dit Chrome/148 mais sec-ch-ua dit Chromium/145

### Preuve #2 : Cookies manquants dans le bot vs humain (CRITIQUE)

**Cookies présents sur GetEAppointmentUrl réel (`2026-06-08T17-14-59-targets.json`) :**
```
__RequestVerificationToken  (httpOnly, Lax, visaonweb.diplomatie.be)
ServerId                    (httpOnly, Lax, visaonweb.diplomatie.be)  ← bot ne capture pas
TS0110ceb4                  (F5 BIG-IP, NOT httpOnly, .visaonweb.diplomatie.be)
OSOnline                    (OutSystems session, visaonweb.diplomatie.be)
_culture                    (en-US, visaonweb.diplomatie.be)          ← bot ne capture pas
```

**Cookie hCaptcha présent sur js.hcaptcha.com (`2026-06-08T12-01-52-06_captcha.json`) :**
```
__cf_bm  (Cloudflare Bot Management, .hcaptcha.com, httpOnly, Secure, SameSite=None)
```

→ **Le bot ne transmet pas `ServerId` ni `_culture`** dans ses requêtes HTTP. F5 détecte l'absence de `ServerId` (cookie de persistance serveur) qui est normalement toujours présent après login.

### Preuve #3 : Sec-Fetch-Site incorrect pour navigation cross-domain (CRITIQUE)

**Navigation humaine vers Integration/VOW (`2026-06-08T17-14-59-targets.json`) :**
```json
"sec-fetch-site": "same-site"    ← visaonweb → appointment.cloud (même domaine diplomatie.be)
"sec-fetch-mode": "navigate"
"sec-fetch-user": "?1"           ← indique interaction utilisateur
```

**Ce que fait le bot dans cevHttpSetup.ts :**
```typescript
"Sec-Fetch-Site": "same-origin"  ← FAUX pour une navigation cross-domain
```

→ Un navigateur envoie `same-site` car visaonweb.diplomatie.be et appointment.cloud.diplomatie.be partagent le TLD+1 `.diplomatie.be`. Le bot envoie `same-origin` qui est détectable.

### Preuve #4 : Ordre des headers incorrect (IMPORTANT)

**Ordre réel pour GetEAppointmentUrl (AJAX) depuis HAR :**
```
Accept, Accept-Encoding, Accept-Language, Cache-Control, Connection,
Cookie, Host, If-Modified-Since, Referer, Sec-Fetch-Dest, Sec-Fetch-Mode,
Sec-Fetch-Site, User-Agent, X-Requested-With, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform
```

**Ordre réel pour SetCaptchaToken (POST AJAX) depuis HAR :**
```
Accept, Accept-Encoding, Accept-Language, Connection, Content-Length,
Content-Type, Cookie, Host, Origin, Sec-Fetch-Dest, Sec-Fetch-Mode,
Sec-Fetch-Site, User-Agent, X-Requested-With, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform
```

→ **Key observation** : `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` sont en **minuscules** et en **fin de liste** dans Chrome réel. L'objet TypeScript actuel les place différemment.

### Preuve #5 : Telemetry LogRenderingClientTime manquante (MOYEN)

**Requête automatique du site (`2026-06-09T03-56-05-vowint-api.json`) :**
```json
{
  "method": "POST",
  "url": "https://visaonweb.diplomatie.be/Common/LogRenderingClientTime?actionName=getVisaApplication&time=334",
  "x-requested-with": "XMLHttpRequest"
}
```

→ L'application OutSystems envoie automatiquement le temps de rendu. **Un navigateur sans JS ne l'envoie jamais** — F5 peut détecter l'absence de cette telemetry pour classer la session comme headless/bot.

### Preuve #6 : Rupture comportementale Puppeteer→impit (CRITIQUE)

**Ce que F5 observe** (Amazon Q, Threat Modeling Avancé) :
- Phase 1 (Puppeteer) : TLS JA4 = Chrome 122, ressources CSS/JS chargées, mouse events, scroll events
- Phase 2 (impit HTTP) : TLS JA4 = Chrome configuré via impit, ZÉRO ressource statique, ZÉRO event comportemental

→ `TGT_ML_CoordinatedActivity` et `TGT_SessionConsistency` détectent la rupture. Le score composite dépasse le seuil → shadow ban niveau 3 (LEVEL_3_HARD_BAN, 1 jour, 80% data filtering).

### Preuve #7 : navigator.webdriver non masqué en Puppeteer (CRITIQUE)

**Amazon Q — Détection Puppeteer/Playwright :**
```javascript
if (window.navigator.webdriver === true) → confiance 0.95
if (navigator.plugins.length === 0) → confiance 0.75
if (webglRenderer.includes('SwiftShader')) → confiance 0.70
```

→ puppeteer-extra-plugin-stealth est dans le code (`cev-dossier-loop.ts` utilise `addExtra`) mais potentiellement mal configuré (viewport non défini, args manquants).

---

## 📊 CATALOGUE COMPLET DES VECTEURS DE DÉTECTION

| # | Vecteur | Sévérité | Source | Statut |
|---|---------|----------|--------|--------|
| V01 | HeadlessChrome dans sec-ch-ua Puppeteer | 🔴 CRITIQUE | Capture réelle 2026-06-09 | À corriger |
| V02 | Rupture TLS JA4 entre phases Puppeteer→impit | 🔴 CRITIQUE | Amazon Q + Rapport Comparatif | À corriger |
| V03 | Cookie ServerId manquant dans requêtes bot | 🔴 CRITIQUE | Capture réelle 2026-06-08 | À corriger |
| V04 | Sec-Fetch-Site wrong (same-origin vs same-site) | 🔴 CRITIQUE | HAR 2026-06-08 | À corriger |
| V05 | Zéro sous-ressource après login (resource_pattern) | 🔴 CRITIQUE | Rapport Comparatif + Amazon Q | À corriger |
| V06 | navigator.webdriver non masqué | 🔴 CRITIQUE | Amazon Q Puppeteer Detection | À corriger |
| V07 | Ordre des headers non conforme Chrome réel | 🟠 IMPORTANT | HAR 2026-06-08 | À corriger |
| V08 | Jitter Math.random() distribution uniforme | 🟠 IMPORTANT | Rapport Comparatif | À corriger |
| V09 | hCaptcha token résolu sans proxy → IP jump | 🟠 IMPORTANT | Code source cevHttpSetup.ts | À corriger |
| V10 | SOAX sticky sessions rotate 00h/12h UTC coordonné | 🟠 IMPORTANT | Code source cev-shared-impit.ts | À corriger |
| V11 | Telemetry LogRenderingClientTime absente | 🟡 MOYEN | Capture réelle 2026-06-09 | À corriger |
| V12 | ignoreTlsErrors: true dans impit | 🟡 MOYEN | cev-shared-impit.ts ligne ~45 | À corriger |
| V13 | Cookie _culture manquant dans requêtes | 🟡 MOYEN | Capture réelle 2026-06-08 | À corriger |
| V14 | Cache VOWINT session 24h partagé multi-IPs | 🟡 MOYEN | Code source cevHttpSetup.ts | À corriger |
| V15 | Format sec-ch-ua "Not:A-Brand" vs "Not/A)Brand" | 🟡 MOYEN | Comparaison captures | À corriger |

---

## 🏗️ ARCHITECTURE CIBLE

### Architecture Actuelle (Shadow-Bannable)
```
Puppeteer (Chrome headless)
  → Login visaonweb (capture TS cookie uniquement)
  → Ferme Puppeteer ✗

impit HTTP (TLS spoof)
  → Login visaonweb (NOUVELLE session HTTP, autre TLS)
  → MyList → GetEAppointmentUrl
  → Navigate Integration/VOW
  → Solve hCaptcha (SANS proxy = IP différente du login)
  → SetCaptchaToken
  → Poll /Home/AvailableTimeSlots

Résultat : 2 sessions distinctes, rupture comportementale, shadow ban
```

### Architecture Cible (Undetectable)
```
Puppeteer (Chrome réel, stealth complet, avec proxy SOAX)
  → Login visaonweb (interaction humaine simulée)
  → Charger IndexByUserId (CSS/JS/images = comportement normal)
  → Déclencher MyList AJAX (capturer appIds)
  → Déclencher GetEAppointmentUrl AJAX
  → Navigation cross-domain Integration/VOW (Sec-Fetch-Site: same-site)
  → Charger /Captcha (obtenir ASP.NET_SessionId)
  → Charger hCaptcha iframe (via Puppeteer, MÊME proxy)
  → Solve hCaptcha via Anti-Captcha (proxy = même IP que session)
  → POST SetCaptchaToken (dans le contexte Puppeteer)
  → Extraire TOUS les cookies + session data
  → Rester ouvert ou fermer proprement

impit HTTP (TLS Chrome, MÊME proxy SOAX sticky)
  → Poll /Home/AvailableTimeSlots uniquement
  → Si 401/session expirée → relancer flow Puppeteer complet

Résultat : Une seule session cohérente, TLS homogène, comportement humain
```

---

## 📁 FICHIERS À MODIFIER/CRÉER

### Fichier 1 : `cev-dossier-loop.ts` — Refonte complète du flow Puppeteer

**Objectif** : Remplacer `captureF5CookieForAccount()` par `captureFullSessionForAccount()` qui fait le flow complet jusqu'à SetCaptchaToken.

#### 1.1 Launch args Puppeteer (anti-détection)

```typescript
// REMPLACER la configuration puppeteer actuelle par :
const PUPPETEER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',  // CRITIQUE: masque webdriver
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--window-size=1920,1080',
  '--start-maximized',
  '--disable-infobars',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-popup-blocking',
  '--disable-translate',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--metrics-recording-only',
  '--no-report-upload',
  '--disable-crash-reporter',
  // Proxy SOAX si activé
  // --proxy-server= sera ajouté dynamiquement
];

// User-Agent Chrome réel (pas HeadlessChrome)
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// sec-ch-ua Chrome 148 RÉEL (format avec "Not/A)Brand" PAS "Not:A-Brand")
const CHROME_SEC_CH_UA = '"Not/A)Brand";v="99", "Chromium";v="148"';
const CHROME_SEC_CH_UA_FULL = '"Not/A)Brand";v="99.0.0.0", "Chromium";v="148.0.0.0"';
```

#### 1.2 Configuration page Puppeteer (stealth complet)

```typescript
async function setupStealthPage(page: Page, proxy?: SoaxProxy): Promise<void> {
  // 1. Masquer webdriver (CRITIQUE - confiance 0.95)
  await page.evaluateOnNewDocument(() => {
    // Supprimer navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
    
    // Ajouter plugins réalistes (confiance 0.75 si absent)
    const makePluginArray = () => {
      const plugins = ['Chrome PDF Plugin', 'Chrome PDF Viewer', 'Native Client'];
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = plugins.map((name, i) => ({ 
            name, description: name, filename: `${name.toLowerCase().replace(/ /g,'-')}.so`, length: 1 
          }));
          Object.setPrototypeOf(arr, PluginArray.prototype);
          return arr;
        }
      });
    };
    makePluginArray();
    
    // Fixer WebGL renderer (pas SwiftShader - confiance 0.70)
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';  // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'Intel Iris OpenGL Engine';  // UNMASKED_RENDERER_WEBGL
      return getParam.call(this, param);
    };
    
    // Chrome runtime (éviter cdp_debugger detection)
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        get: () => ({
          app: { isInstalled: false },
          webstore: { onInstallStageChanged: {}, onDownloadProgress: {} },
          runtime: { PlatformOs: { MAC: 'mac', WIN: 'win' } },
        })
      });
    }
    
    // Permissions API (confiance 0.70 si denied sans interaction)
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (params: any) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission } as any);
      }
      return originalQuery(params);
    };
  });
  
  // 2. User-Agent et viewport (CRITIQUE - HeadlessChrome détecté)
  await page.setUserAgent(CHROME_USER_AGENT);
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  
  // 3. Extra headers Chrome (cohérence avec UA)
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': CHROME_SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  });
  
  // 4. Intercepter les requêtes pour corriger sec-ch-ua (HeadlessChrome → Chromium)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const headers = req.headers();
    // Remplacer HeadlessChrome par Chromium dans tous les headers
    if (headers['sec-ch-ua']?.includes('HeadlessChrome')) {
      headers['sec-ch-ua'] = CHROME_SEC_CH_UA;
      headers['sec-ch-ua-full-version-list'] = CHROME_SEC_CH_UA_FULL;
    }
    req.continue({ headers });
  });
}
```

#### 1.3 Simulation comportement humain

```typescript
// Timing humain : distribution log-normale (pas uniforme)
function humanDelay(minMs: number, maxMs: number): Promise<void> {
  // Distribution log-normale centrée sur (min+max)/2 avec variance naturelle
  const mu = Math.log((minMs + maxMs) / 2);
  const sigma = 0.3;
  const u1 = Math.random(), u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const lognormal = Math.exp(mu + sigma * normal);
  const delay = Math.max(minMs, Math.min(maxMs * 2, lognormal));
  return new Promise(r => setTimeout(r, delay));
}

// Frappe réaliste (avec micro-erreurs occasionnelles)
async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.focus(selector);
  await humanDelay(200, 500);  // délai avant frappe
  for (const char of text) {
    await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
    // 2% chance de micro-pause (humain réfléchit)
    if (Math.random() < 0.02) await humanDelay(300, 800);
  }
}

// Scroll naturel
async function naturalScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalScroll = 0;
      const maxScroll = 200 + Math.random() * 300;
      const scrollInterval = setInterval(() => {
        const step = 20 + Math.random() * 40;
        window.scrollBy(0, step);
        totalScroll += step;
        if (totalScroll >= maxScroll) {
          clearInterval(scrollInterval);
          resolve();
        }
      }, 60 + Math.random() * 80);
    });
  });
}
```

#### 1.4 Flow Puppeteer complet — nouvelle fonction `captureFullSessionForAccount()`

```typescript
interface FullCevSession {
  // Cookies VOWINT (visaonweb.diplomatie.be)
  requestVerificationToken: string;
  serverId: string;
  tsF5Cookie: string;       // TS0110ceb4
  osOnline: string;
  culture: string;
  
  // Session CEV (appointment.cloud.diplomatie.be)
  aspNetSessionId: string;
  preferredCulture: string;
  
  // Données fonctionnelles
  integrationUrl: string;
  appId: string;
  proxyUsed: string | null;
  
  // Métadonnées
  capturedAt: number;
  userAgent: string;
  secChUa: string;
}

async function captureFullSessionForAccount(
  email: string,
  password: string,
  appId: string,
  config: HunterConfig
): Promise<FullCevSession> {
  
  const proxy = config.cev_use_proxy ? await getSoaxStickyProxy(email) : null;
  
  const launchArgs = [...PUPPETEER_LAUNCH_ARGS];
  if (proxy) {
    launchArgs.push(`--proxy-server=${proxy.host}:${proxy.port}`);
  }
  
  const browser = await puppeteerExtra.launch({
    headless: true,  // ou 'new' pour Chrome 112+
    args: launchArgs,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  
  try {
    const page = await browser.newPage();
    await setupStealthPage(page, proxy);
    
    if (proxy?.username) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }
    
    // ── ÉTAPE 1 : Login VOWINT ──────────────────────────────────────────
    await page.goto('https://visaonweb.diplomatie.be/en/Account/Login', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    
    // Simuler lecture de la page
    await naturalScroll(page);
    await humanDelay(1500, 3500);
    
    // Remplir formulaire
    await humanType(page, '#Email', email);
    await humanDelay(300, 700);
    await humanType(page, '#Password', password);
    await humanDelay(500, 1200);
    
    // Clic login (avec petite pause avant)
    await humanDelay(200, 600);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
    
    // Vérifier login réussi
    if (!page.url().includes('/VisaApplication/') && !page.url().includes('/en')) {
      throw new Error(`Login failed for ${email}: redirected to ${page.url()}`);
    }
    
    // ── ÉTAPE 2 : IndexByUserId (charger sous-ressources = comportement humain) ──
    await page.goto('https://visaonweb.diplomatie.be/en/VisaApplication/IndexByUserId', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    
    // CRITIQUE : Attendre le chargement des DataTables (MyList AJAX)
    await page.waitForResponse(
      r => r.url().includes('/VisaApplication/MyList'),
      { timeout: 15000 }
    );
    
    // Simuler lecture de la liste
    await naturalScroll(page);
    await humanDelay(2000, 4000);
    
    // ── ÉTAPE 3 : GetEAppointmentUrl (AJAX depuis le contexte Puppeteer) ──
    // Déclencher en naviguant vers la page qui appelle GetEAppointmentUrl,
    // ou en l'appelant directement dans le contexte de la page Puppeteer
    const integrationUrlResult = await page.evaluate(async (appId: string) => {
      const resp = await fetch(
        `/Common/GetEAppointmentUrl?id=${appId}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'Cache-Control': 'max-age=0',
            'If-Modified-Since': '0',
          },
          credentials: 'same-origin',
        }
      );
      return resp.json();
    }, appId);
    
    if (!integrationUrlResult?.url) {
      throw new Error(`GetEAppointmentUrl failed for appId ${appId}`);
    }
    
    const integrationUrl: string = integrationUrlResult.url;
    
    // ── ÉTAPE 4 : Navigation vers Integration/VOW (cross-domain) ──────────
    // CRITIQUE : Utiliser page.goto() → Puppeteer génère sec-fetch-site: same-site
    // car les deux domaines sont sous .diplomatie.be
    await page.goto(integrationUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    
    // Le serveur redirect vers /Captcha
    // Attendre que l'URL soit sur appointment.cloud.diplomatie.be/Captcha
    await page.waitForFunction(
      () => window.location.pathname === '/Captcha',
      { timeout: 10000 }
    );
    
    // ── ÉTAPE 5 : Résolution hCaptcha (même session, même proxy) ──────────
    // Récupérer le sitekey depuis la page Captcha
    const sitekey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]') as HTMLElement | null;
      return el?.dataset.sitekey ?? null;
    });
    
    if (!sitekey) {
      throw new Error('hCaptcha sitekey not found on /Captcha page');
    }
    
    // Simuler temps de lecture de la page captcha (humain regarde le captcha)
    await humanDelay(3000, 8000);
    
    // Résoudre hCaptcha via Anti-Captcha AVEC proxy si activé
    // CRITIQUE : utiliser le MÊME proxy que la session pour éviter IP jump
    const hcaptchaToken = await solveHcaptchaWithProxy({
      sitekey,
      siteUrl: 'https://appointment.cloud.diplomatie.be/Captcha',
      proxy: proxy ? {
        type: proxy.type ?? 'HTTP',
        address: proxy.host,
        port: proxy.port,
        login: proxy.username,
        password: proxy.password,
      } : undefined,
    });
    
    // Simuler temps de résolution humain (10-30s)
    await humanDelay(10000, 20000);
    
    // ── ÉTAPE 6 : POST SetCaptchaToken (dans le contexte Puppeteer) ────────
    const setTokenResult = await page.evaluate(async (token: string) => {
      const resp = await fetch('/Captcha/SetCaptchaToken', {
        method: 'POST',
        headers: {
          'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Origin': 'https://appointment.cloud.diplomatie.be',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'same-origin',
        body: `captcha=${encodeURIComponent(token)}`,
      });
      return { status: resp.status, ok: resp.ok };
    }, hcaptchaToken);
    
    if (!setTokenResult.ok) {
      throw new Error(`SetCaptchaToken failed: HTTP ${setTokenResult.status}`);
    }
    
    // ── ÉTAPE 7 : Extraire TOUS les cookies ────────────────────────────────
    const allCookies = await page.cookies(
      'https://visaonweb.diplomatie.be',
      'https://appointment.cloud.diplomatie.be'
    );
    
    const getCookieValue = (name: string) =>
      allCookies.find(c => c.name === name)?.value ?? '';
    
    return {
      requestVerificationToken: getCookieValue('__RequestVerificationToken'),
      serverId:                 getCookieValue('ServerId'),
      tsF5Cookie:               getCookieValue('TS0110ceb4'),
      osOnline:                 getCookieValue('OSOnline'),
      culture:                  getCookieValue('_culture') || 'en-US',
      aspNetSessionId:          getCookieValue('ASP.NET_SessionId'),
      preferredCulture:         getCookieValue('PreferredCulture') || 'en-US',
      integrationUrl,
      appId,
      proxyUsed:                proxy ? `${proxy.host}:${proxy.port}` : null,
      capturedAt:               Date.now(),
      userAgent:                CHROME_USER_AGENT,
      secChUa:                  CHROME_SEC_CH_UA,
    };
    
  } finally {
    await browser.close();
  }
}
```

---

### Fichier 2 : `cev-shared-impit.ts` — Corrections headers et TLS

#### 2.1 Corriger sec-ch-ua format (V15)

```typescript
// AVANT (incorrect) :
// "Not:A-Brand" (deux-points)

// APRÈS (correct Chrome 148) :
const SEC_CH_UA_CHROME_148 = '"Not/A)Brand";v="99", "Chromium";v="148"';
const SEC_CH_UA_FULL_CHROME_148 = '"Not/A)Brand";v="99.0.0.0", "Chromium";v="148.0.0.0"';
// Note : le format "Not/A)Brand" avec parenthèse fermante est intentionnel dans Chrome 98+
// pour dérouter les parsers qui cherchent une liste cohérente

// Retirer ignoreTlsErrors (V12) :
// AVANT :
const impit = new Impit({ browser: "chrome", ignoreTlsErrors: true } as any);
// APRÈS :
const impit = new Impit({ browser: "chrome" } as any);
// Si nécessaire pour dev local uniquement :
const impit = new Impit({ 
  browser: "chrome",
  ...(process.env.NODE_ENV !== 'production' ? { ignoreTlsErrors: true } : {})
} as any);
```

#### 2.2 Corriger l'ordre des headers (V07)

**Ordre Chrome réel confirmé par captures pour requêtes AJAX (XHR/fetch) :**

```typescript
// Nouvelle fonction buildCevAjaxHeaders() avec ordre EXACT Chrome 148
function buildCevAjaxHeaders(params: {
  referer: string;
  cookie: string;
  accept?: string;
  contentType?: string;
  origin?: string;
  ifModifiedSince?: boolean;
}): Record<string, string> {
  // IMPORTANT : impit respecte l'ordre d'insertion des propriétés d'objet en JS
  // On utilise un tableau de tuples puis Object.fromEntries pour garantir l'ordre
  
  const entries: [string, string][] = [];
  
  // 1. Accept (premier)
  entries.push(['Accept', params.accept ?? 'application/json, text/javascript, */*; q=0.01']);
  
  // 2. Accept-Encoding
  entries.push(['Accept-Encoding', 'gzip, deflate, br, zstd']);
  
  // 3. Accept-Language
  entries.push(['Accept-Language', 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7']);
  
  // 4. Cache-Control (si présent)
  if (params.ifModifiedSince) {
    entries.push(['Cache-Control', 'max-age=0']);
  }
  
  // 5. Connection (keep-alive sur HTTP/1.1, absent sur HTTP/2)
  // NOTE : impit en HTTP/2 n'envoie pas Connection, c'est correct
  
  // 6. Content-Type (si POST)
  if (params.contentType) {
    entries.push(['Content-Type', params.contentType]);
  }
  
  // 7. Cookie
  entries.push(['Cookie', params.cookie]);
  
  // 8. Host → géré automatiquement par impit
  
  // 9. If-Modified-Since
  if (params.ifModifiedSince) {
    entries.push(['If-Modified-Since', '0']);
  }
  
  // 10. Origin (si POST avec CORS)
  if (params.origin) {
    entries.push(['Origin', params.origin]);
  }
  
  // 11. Referer
  entries.push(['Referer', params.referer]);
  
  // 12. Sec-Fetch-Dest
  entries.push(['Sec-Fetch-Dest', 'empty']);
  
  // 13. Sec-Fetch-Mode
  entries.push(['Sec-Fetch-Mode', 'cors']);
  
  // 14. Sec-Fetch-Site
  entries.push(['Sec-Fetch-Site', 'same-origin']);
  
  // 15. User-Agent
  entries.push(['User-Agent', CHROME_USER_AGENT]);
  
  // 16. X-Requested-With
  entries.push(['X-Requested-With', 'XMLHttpRequest']);
  
  // 17. sec-ch-ua (MINUSCULE, en fin) — conforme Chrome 148
  entries.push(['sec-ch-ua', SEC_CH_UA_CHROME_148]);
  entries.push(['sec-ch-ua-mobile', '?0']);
  entries.push(['sec-ch-ua-platform', '"Windows"']);
  
  return Object.fromEntries(entries);
}

// Pour navigation cross-domain (Integration/VOW) — sec-fetch-site: same-site
function buildCevNavigateHeaders(params: {
  referer: string;
  cookie?: string;
}): Record<string, string> {
  return Object.fromEntries([
    ['Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'],
    ['Accept-Encoding', 'gzip, deflate, br, zstd'],
    ['Accept-Language', 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7'],
    ...(params.cookie ? [['Cookie', params.cookie] as [string,string]] : []),
    ['Referer', params.referer],
    ['Sec-Fetch-Dest', 'document'],
    ['Sec-Fetch-Mode', 'navigate'],
    ['Sec-Fetch-Site', 'same-site'],  // CRITIQUE : same-site pas same-origin
    ['Sec-Fetch-User', '?1'],
    ['Upgrade-Insecure-Requests', '1'],
    ['User-Agent', CHROME_USER_AGENT],
    ['sec-ch-ua', SEC_CH_UA_CHROME_148],
    ['sec-ch-ua-mobile', '?0'],
    ['sec-ch-ua-platform', '"Windows"'],
  ]);
}
```

#### 2.3 Corriger le jitter temporel (V08)

```typescript
// AVANT : distribution uniforme Math.random()
// await new Promise(r => setTimeout(r, 30 + Math.random() * 170));

// APRÈS : distribution log-normale (plus proche comportement humain)
function logNormalDelay(medianMs: number, sigmaFactor: number = 0.4): number {
  const mu = Math.log(medianMs);
  const u1 = Math.random(), u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const result = Math.exp(mu + sigmaFactor * normal);
  // Clamper entre 20ms et 3x median
  return Math.max(20, Math.min(medianMs * 3, result));
}

// Usage :
await new Promise(r => setTimeout(r, logNormalDelay(150)));  // médiane 150ms
```

#### 2.4 Corriger la transmission complète des cookies (V03, V13)

```typescript
// Dans buildCookieString() (ou équivalent) — s'assurer de transmettre TOUS les cookies
function buildVowintCookieString(session: FullCevSession): string {
  const parts: string[] = [];
  
  // Ordre conforme capture réelle
  if (session.requestVerificationToken) {
    parts.push(`__RequestVerificationToken=${session.requestVerificationToken}`);
  }
  if (session.serverId) {              // ← AJOUT (manquait)
    parts.push(`ServerId=${session.serverId}`);
  }
  if (session.tsF5Cookie) {
    parts.push(`TS0110ceb4=${session.tsF5Cookie}`);
  }
  if (session.osOnline) {
    parts.push(`OSOnline=${session.osOnline}`);
  }
  if (session.culture) {               // ← AJOUT (manquait)
    parts.push(`_culture=${session.culture}`);
  }
  
  return parts.join('; ');
}

function buildCevCookieString(session: FullCevSession): string {
  const parts: string[] = [];
  if (session.aspNetSessionId) {
    parts.push(`ASP.NET_SessionId=${session.aspNetSessionId}`);
  }
  parts.push(`PreferredCulture=${session.preferredCulture || 'en-US'}`);
  return parts.join('; ');
}
```

---

### Fichier 3 : `cevHttpSetup.ts` — Adaptation au nouveau système de session

#### 3.1 Signature de fonction — accepter FullCevSession

```typescript
// AVANT :
export async function setupCevSessionHttp(
  email: string,
  password: string,
  appId: string,
  config: HunterConfig
): Promise<CevSetupResult>

// APRÈS :
// setupCevSessionHttp() est SUPPRIMÉE pour le flow principal
// Elle est remplacée par deux fonctions séparées :

// 1. setupCevPollingSession() — prend une FullCevSession déjà capturée
export async function setupCevPollingSession(
  session: FullCevSession,
  config: HunterConfig
): Promise<CevPollingReadySession>

// 2. refreshCevSession() — relance le flow Puppeteer complet si session expirée
export async function refreshCevSession(
  email: string,
  password: string,
  appId: string,
  config: HunterConfig
): Promise<FullCevSession>
// → appelle captureFullSessionForAccount() de cev-dossier-loop.ts
```

#### 3.2 Conserver le mode no-proxy (V: no-proxy local mode preserved)

```typescript
// Le mode no-proxy est préservé intégralement :
if (!config.cev_use_proxy) {
  // Launch Puppeteer sans proxy
  // Résoudre hCaptcha ProxyLess (Anti-Captcha HCaptchaTaskProxyless)
  // Tout le reste identique
}
```

#### 3.3 Ajouter telemetry LogRenderingClientTime (V11)

```typescript
// Après avoir obtenu une session CEV fonctionnelle, envoyer la telemetry
// (le site OutSystems l'envoie automatiquement après rendu AngularJS)
async function sendRenderingTelemetry(session: FullCevSession): Promise<void> {
  try {
    const renderTime = 250 + Math.floor(logNormalDelay(100));  // temps réaliste
    await cevImpitFetch(
      `https://visaonweb.diplomatie.be/Common/LogRenderingClientTime?actionName=getVisaApplication&time=${renderTime}`,
      {
        method: 'POST',
        headers: buildCevAjaxHeaders({
          referer: 'https://visaonweb.diplomatie.be/en/VisaApplication/Create',
          cookie: buildVowintCookieString(session),
        }),
      }
    );
  } catch {
    // Non-critique, ignorer les erreurs
  }
}
```

---

### Fichier 4 : `cevPolling.ts` — Corrections mineures

#### 4.1 Utiliser buildCevAjaxHeaders() corrigé

```typescript
// Remplacer les appels à getCevBrowserHeaders() pour /Home/AvailableTimeSlots
// par buildCevAjaxHeaders() avec :
// - cookie = buildCevCookieString(session) (ASP.NET_SessionId + PreferredCulture)
// - referer = 'https://appointment.cloud.diplomatie.be/Home'
// - sec-fetch-site = 'same-origin' (correct pour polling sur même domaine)

// Détecter expiration session → relancer captureFullSessionForAccount()
if (response.status === 401 || response.status === 302) {
  logger.warn(`CEV session expired for ${session.appId}, relaunching Puppeteer flow`);
  const newSession = await refreshCevSession(email, password, appId, config);
  // Mettre à jour la session et reprendre le polling
}
```

#### 4.2 Jitter polling log-normal (V08)

```typescript
// AVANT : intervalle fixe ou distribution uniforme
// APRÈS : varier l'intervalle entre polls avec distribution log-normale
const pollInterval = logNormalDelay(config.pollIntervalMs || 60000, 0.3);
// Résultat : intervalles qui ressemblent à un humain qui regarde sa montre
```

---

### Fichier 5 : `cev-f5-cookie-manager.ts` — Obsolète partiel

La fonction `captureF5CookieForAccount()` devient **obsolète** — elle est remplacée par `captureFullSessionForAccount()`. Le F5CookieManager conserve son rôle de **cache en mémoire** mais stocke désormais une `FullCevSession` complète au lieu d'un simple cookie F5.

```typescript
// Renommer : F5CookieManager → CevSessionManager
// Stocker : FullCevSession (pas seulement tsF5Cookie)
// TTL : réduire de 24h à 4h (sessions CEV expirent plus vite)
// Invalider : sur HTTP 401 OU sur 3 tentatives consécutives "no slots"
```

---

### Fichier 6 (NOUVEAU) : `src/cev-session-manager.ts`

```typescript
/**
 * CevSessionManager — gestionnaire de sessions CEV complètes
 * Remplace F5CookieManager avec stockage FullCevSession
 */

interface CachedCevSession {
  session: FullCevSession;
  expiresAt: number;
  noSlotsCount: number;  // compteur "no slots" pour détecter shadow ban
}

class CevSessionManager {
  private cache = new Map<string, CachedCevSession>();
  private readonly SESSION_TTL_MS = 4 * 60 * 60 * 1000;   // 4h (était 24h)
  private readonly SHADOW_BAN_THRESHOLD = 15;               // 15 "no slots" → refresh session
  
  async getOrCreate(
    accountKey: string,
    email: string,
    password: string,
    appId: string,
    config: HunterConfig
  ): Promise<FullCevSession> {
    const cached = this.cache.get(accountKey);
    
    if (cached && Date.now() < cached.expiresAt) {
      return cached.session;
    }
    
    // Lancer le flow Puppeteer complet
    const session = await captureFullSessionForAccount(email, password, appId, config);
    
    this.cache.set(accountKey, {
      session,
      expiresAt: Date.now() + this.SESSION_TTL_MS,
      noSlotsCount: 0,
    });
    
    return session;
  }
  
  recordNoSlots(accountKey: string): boolean {
    const cached = this.cache.get(accountKey);
    if (!cached) return false;
    
    cached.noSlotsCount++;
    
    // Si trop de "no slots" → possible shadow ban → invalider session
    if (cached.noSlotsCount >= this.SHADOW_BAN_THRESHOLD) {
      logger.warn(`[CevSessionManager] Account ${accountKey} hit shadow ban threshold (${cached.noSlotsCount} no-slots), invalidating session`);
      this.cache.delete(accountKey);
      return true;  // indique que la session a été invalidée
    }
    
    return false;
  }
  
  invalidate(accountKey: string): void {
    this.cache.delete(accountKey);
  }
  
  invalidateAll(): void {
    this.cache.clear();
  }
}

export const cevSessionManager = new CevSessionManager();
```

---

### Fichier 7 (NOUVEAU) : `src/cev-hcaptcha.ts` — Solver unifié avec proxy

```typescript
/**
 * Solver hCaptcha unifié pour CEV
 * Supporte : Anti-Captcha avec proxy, Anti-Captcha ProxyLess
 * Note : CapSolver blacklisté depuis 2026-04 pour sitekey CEV
 */

interface HCaptchaProxyParams {
  type?: 'HTTP' | 'HTTPS' | 'SOCKS4' | 'SOCKS5';
  address: string;
  port: number;
  login?: string;
  password?: string;
}

interface SolveHcaptchaParams {
  sitekey: string;
  siteUrl: string;
  proxy?: HCaptchaProxyParams;
  timeoutMs?: number;
}

export async function solveHcaptchaWithProxy(
  params: SolveHcaptchaParams
): Promise<string> {
  const { sitekey, siteUrl, proxy, timeoutMs = 120000 } = params;
  
  const apiKey = process.env.ANTICAPTCHA_KEY;
  if (!apiKey) throw new Error('ANTICAPTCHA_KEY not set');
  
  // Choisir le type de tâche selon la présence d'un proxy
  const taskBody = proxy ? {
    type: 'HCaptchaTask',  // AVEC proxy (même IP que la session)
    websiteURL: siteUrl,
    websiteKey: sitekey,
    proxyType: proxy.type ?? 'HTTP',
    proxyAddress: proxy.address,
    proxyPort: proxy.port,
    proxyLogin: proxy.login,
    proxyPassword: proxy.password,
  } : {
    type: 'HCaptchaTaskProxyless',  // Sans proxy
    websiteURL: siteUrl,
    websiteKey: sitekey,
  };
  
  // Créer la tâche
  const createResp = await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task: taskBody }),
  });
  const { taskId, errorId, errorCode } = await createResp.json();
  
  if (errorId !== 0) {
    throw new Error(`Anti-Captcha createTask failed: ${errorCode}`);
  }
  
  // Polling résultat
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));  // poll toutes les 5s
    
    const resultResp = await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const result = await resultResp.json();
    
    if (result.status === 'ready') {
      return result.solution.gRecaptchaResponse;  // token hCaptcha
    }
    if (result.errorId !== 0) {
      throw new Error(`Anti-Captcha task error: ${result.errorCode}`);
    }
  }
  
  throw new Error(`Anti-Captcha timeout after ${timeoutMs}ms`);
}
```

---

### Fichier 8 : `cev-dossier-loop.ts` — Refonte du loop principal

#### 8.1 Rotation SOAX — éviter la rotation synchronisée (V10)

```typescript
// PROBLÈME ACTUEL : toutes les sessions SOAX tournent au même moment (00h/12h UTC)
// → F5 détecte des milliers de changements d'IP simultanés → pattern coordonné

// SOLUTION : introduire un offset aléatoire par compte pour désynchroniser
function getSessionRotationOffset(accountIndex: number): number {
  // Répartir les comptes sur 12h (720 minutes) avec jitter
  const baseOffset = (accountIndex % 12) * 60 * 60 * 1000; // toutes les heures
  const jitter = (Math.random() - 0.5) * 30 * 60 * 1000;   // ±15 min
  return baseOffset + jitter;
}

// Dans le manager SOAX sticky sessions :
// Forcer un refresh de session à des moments décalés par compte
// (pas à 00h/12h UTC pour tous en même temps)
```

#### 8.2 Multi-dossier round-robin — éviter race condition session (V14)

```typescript
// PROBLÈME : plusieurs dossiers du même compte VOWINT partagent le cache session
// → la session peut être invalidée par un dossier pendant qu'un autre l'utilise

// SOLUTION : verrou par compte (pas par dossier)
const accountLocks = new Map<string, Promise<void>>();

async function withAccountLock<T>(
  accountEmail: string,
  fn: () => Promise<T>
): Promise<T> {
  // Attendre que le verrou précédent soit libéré
  const current = accountLocks.get(accountEmail) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  accountLocks.set(accountEmail, next);
  
  await current;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

// Usage dans le loop :
for (const dossier of dossiers) {
  // Sérialiser par compte pour éviter race condition
  await withAccountLock(dossier.vowintEmail, async () => {
    const session = await cevSessionManager.getOrCreate(...);
    await pollAndBook(session, dossier);
  });
}
```

---

## 🔧 VARIABLES D'ENVIRONNEMENT REQUISES

```bash
# Existantes à conserver
ANTICAPTCHA_KEY=...
SOAX_USERNAME=...
SOAX_PASSWORD=...
CONVEX_URL=...

# Nouvelles / modifiées
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable  # ou chromium selon environnement
CEV_PUPPETEER_HEADLESS=true                              # true/false pour debug
CEV_SESSION_TTL_HOURS=4                                  # durée vie session (défaut 4h)
CEV_SHADOW_BAN_THRESHOLD=15                              # no-slots avant refresh session
CEV_POLL_INTERVAL_SECONDS=90                             # intervalle polling (secondes)
CEV_POLL_JITTER_FACTOR=0.3                               # variance du jitter (0.0-1.0)
```

---

## ✅ CHECKLIST D'IMPLÉMENTATION (dans cet ordre)

### Phase 0 — Prérequis (1h)
- [ ] Vérifier que puppeteer-extra et puppeteer-extra-plugin-stealth sont installés
- [ ] Vérifier la version Chrome disponible dans l'environnement (doit être ≥ v120)
- [ ] Confirmer que ANTICAPTCHA_KEY est configuré et fonctionne
- [ ] Lire `debug_dumps/VOWINT-CEV-FORM-FIELDS.md` pour mapping champs formulaire

### Phase 1 — Stealth Puppeteer (4-6h) — CRITIQUE
- [ ] Créer `src/cev-puppeteer-stealth.ts` avec `setupStealthPage()`, `humanDelay()`, `humanType()`, `naturalScroll()`
- [ ] Corriger args launch Puppeteer : `--disable-blink-features=AutomationControlled`
- [ ] Corriger User-Agent : `Chrome/148.0.0.0` (pas HeadlessChrome)
- [ ] Corriger `sec-ch-ua` : `"Not/A)Brand";v="99", "Chromium";v="148"` (pas `Not:A-Brand`)
- [ ] Ajouter intercepteur request pour remplacer HeadlessChrome dans sec-ch-ua
- [ ] Masquer `navigator.webdriver` via `evaluateOnNewDocument`
- [ ] Fixer plugins array (pas vide)
- [ ] Fixer WebGL renderer (pas SwiftShader)
- [ ] Fixer Chrome runtime (pas CDP debugger visible)
- [ ] Viewport 1920×1080 (pas défaut 800×600)
- [ ] Tester avec https://bot.sannysoft.com — doit tout passer au vert

### Phase 2 — Flow Puppeteer complet (6-8h) — CRITIQUE
- [ ] Créer `captureFullSessionForAccount()` dans `cev-dossier-loop.ts`
- [ ] Login VOWINT avec simulation frappe humaine
- [ ] Navigation IndexByUserId avec scroll + pause
- [ ] Déclencher GetEAppointmentUrl dans contexte page (fetch avec credentials: same-origin)
- [ ] Navigation cross-domain Integration/VOW (page.goto → génère sec-fetch-site: same-site)
- [ ] Capture ASP.NET_SessionId depuis /Captcha
- [ ] Résolution hCaptcha via `solveHcaptchaWithProxy()` avec MÊME proxy que session
- [ ] POST SetCaptchaToken dans contexte Puppeteer
- [ ] Extraction cookies complets (ServerId, _culture inclus)
- [ ] Fermeture propre du browser

### Phase 3 — Corrections HTTP impit (3-4h) — IMPORTANT
- [ ] Corriger `sec-ch-ua` format dans `cev-shared-impit.ts`
- [ ] Supprimer `ignoreTlsErrors: true`
- [ ] Créer `buildCevAjaxHeaders()` avec ordre headers exact Chrome réel
- [ ] Créer `buildCevNavigateHeaders()` avec sec-fetch-site: same-site
- [ ] Corriger `buildVowintCookieString()` : ajouter ServerId + _culture
- [ ] Remplacer `Math.random()` jitter par `logNormalDelay()`
- [ ] Ajouter `sendRenderingTelemetry()` après setup session

### Phase 4 — Session Manager (2-3h) — IMPORTANT
- [ ] Créer `src/cev-session-manager.ts`
- [ ] Remplacer F5CookieManager par CevSessionManager dans le code
- [ ] Réduire TTL cache à 4h
- [ ] Implémenter compteur no-slots avec seuil shadow ban
- [ ] Implémenter verrou par compte (anti-race condition)
- [ ] Offset rotation SOAX par compte (désynchronisation)

### Phase 5 — hCaptcha solver (1-2h) — IMPORTANT
- [ ] Créer `src/cev-hcaptcha.ts` avec `solveHcaptchaWithProxy()`
- [ ] Supporter HCaptchaTask (avec proxy) ET HCaptchaTaskProxyless
- [ ] Retirer CapSolver (blacklisté depuis 2026-04 pour sitekeys CEV)
- [ ] Ajouter délai artificiel post-résolution (10-20s)

### Phase 6 — Tests et validation (2-3h)
- [ ] Test stealth : lancer Puppeteer sur https://bot.sannysoft.com
- [ ] Test flow complet no-proxy : un dossier, un cycle login→polling
- [ ] Test flow complet avec proxy SOAX : un dossier, un cycle login→polling
- [ ] Vérifier dans les logs que sec-ch-ua ne contient plus HeadlessChrome
- [ ] Vérifier que ServerId et _culture sont transmis dans les requêtes impit
- [ ] Test multi-dossiers : 3 dossiers en parallèle, vérifier pas de race condition
- [ ] Surveiller 48h : les comptes reçoivent-ils toujours "no slots" ?

---

## ⚠️ CONTRAINTES ET GARDE-FOUS

### Ce qu'on NE change PAS
- Mode no-proxy (`cev_use_proxy=0`) : entièrement préservé, HCaptchaTaskProxyless
- Structure de données Convex : aucun changement de schéma requis
- Architecture monorepo pnpm : aucun changement
- Stack Redis pour état distributé : aucun changement
- Logique round-robin multi-dossiers : préservée, juste sérialisée par compte

### Risques connus
1. **Puppeteer + proxy en production** : tester d'abord le timeout (proxy SOAX peut être lent, augmenter timeout navigation à 45s)
2. **hCaptcha sitekey changement** : le sitekey `5f64399c-14a8-415e-ad1a-7ebccdc4943a` (GDPR) et le sitekey de `/Captcha` doivent être extraits dynamiquement de la page, pas hardcodés
3. **OutSystems MFA** : si CEV active une MFA (email OTP), le flow Puppeteer doit être préparé à l'intercepter (non observé dans les captures actuelles)
4. **Durée de vie session** : l'ASP.NET_SessionId de appointment.cloud peut expirer en 20-30min — si polling dure plus longtemps, prévoir refresh via un nouveau GET /Captcha dans impit
5. **Détection par volume** : même avec un bot parfaitement furtif, des milliers de polls/heure d'une seule IP restent détectables. Le backoff exponentiel sur les périodes de no-slots est recommandé.

---

## 📊 MÉTRIQUES DE SUCCÈS

| Métrique | Avant correction | Cible après correction |
|---|---|---|
| Taux "no slots" systématique | ~100% | < 30% (limité par vraie disponibilité) |
| Durée avant détection | < 1h | > 72h |
| Score F5 behavioral | > seuil shadow ban | < seuil monitoring |
| HeadlessChrome dans headers | Oui | Non |
| Cookies ServerId transmis | Non | Oui |
| sec-ch-ua format correct | Non | Oui |
| hCaptcha résolu avec proxy | Non (ProxyLess) | Oui (HCaptchaTask) |

---

## 🗓️ PLANNING ESTIMÉ

| Phase | Effort | Priorité |
|---|---|---|
| Phase 0 — Prérequis | 1h | P0 |
| Phase 1 — Stealth Puppeteer | 4-6h | P0 CRITIQUE |
| Phase 2 — Flow Puppeteer complet | 6-8h | P0 CRITIQUE |
| Phase 3 — Corrections HTTP impit | 3-4h | P1 IMPORTANT |
| Phase 4 — Session Manager | 2-3h | P1 IMPORTANT |
| Phase 5 — hCaptcha solver | 1-2h | P1 IMPORTANT |
| Phase 6 — Tests et validation | 2-3h | P0 |
| **TOTAL** | **~20-27h** | |

---

## 📚 RÉFÉRENCES ET FICHIERS SOURCES

| Fichier | Rôle |
|---|---|
| `debug_dumps/2026-06-08T17-14-59-targets.json` | Headers/cookies réels GetEAppointmentUrl + SetCaptchaToken |
| `debug_dumps/2026-06-08T17-14-59-integration_flow.json` | Flow integration CEV complet (HAR) |
| `debug_dumps/2026-06-09T03-56-05-vowint-api.json` | API calls réels avec HeadlessChrome détecté |
| `debug_dumps/2026-06-08T12-01-52-06_captcha.json` | Cookies hCaptcha (__cf_bm) et headers captcha |
| `debug_dumps/VOWINT-CEV-INTEGRATION-PLAN.md` | Plan VOWINT existant (phases 1-6) |
| `debug_dumps/VOWINT-CEV-FORM-FIELDS.md` | 80 champs formulaire VOWINT |
| `artifacts/slot-hunter/debug_dumps/RAPPORT_COMPARATIF_HUMAIN_VS_BOT.md` | Analyse humain vs bot |
| `attached_assets/Pasted--Threat-Modeling-...1781510977640.txt` | Amazon Q — threat modeling avancé APBs |
| `attached_assets/Pasted--Analyse-Compl-te-...1781511014922.txt` | Amazon Q — shadow ban dynamique temporelle |
| `attached_assets/Pasted--Cette-r-ponse-...1781511053960.txt` | Amazon Q — contre-mesures niveau 5 |
| `attached_assets/Pasted--Cette-r-ponse-...1781511080718.txt` | Amazon Q — F5 cookies + device fingerprinting |
| `attached_assets/Pasted--Cette-r-ponse-...1781511093680.txt` | Amazon Q — détection Puppeteer/Playwright |

---

*Généré le 2026-06-15 — Basé sur analyse complète des captures réelles et des réponses Amazon Q*
