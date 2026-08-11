/**
 * CEV Dossier Loop v4 — One-Shot (Predator)
 *
 * STRATÉGIE :
 *   La limite 5 clics/heure par dossier n'existe plus côté serveur.
 *   → Réveil toutes les ~2 min → 1 clic par dossier (round-robin) → sleep → répéter.
 *   → La session VOWINT est réutilisée si elle est encore valide (cache 4h dans cevHttpSetup).
 *   → Si session expirée → re-login + captcha automatique, puis clic.
 *   → Pas de gestion F5 / full-session / quota par dossier.
 *
 * ARCHITECTURE :
 *   - 1 seule IP proxy (SOAX Kinshasa, sticky session 5min)
 *   - N dossiers VOWINT (configurés via bot-config "cev_dossier_pool")
 *   - Round-robin pur (pas de quota)
 *   - Session VOWINT réutilisée via cache Redis 4h (dans setupCevSessionHttp)
 *   - Quand un dossier détecte un slot → booking immédiat + pause de CE dossier
 *
 * CONFIG Convex (bot-config) :
 *   cev_dossier_mode = "1"                  → activer ce loop
 *   cev_dossier_pool = "VOWINT6085888,VOWINT6085889,VOWINT6085890"
 *   cev_dossier_interval_sec = "120"        → pause entre chaque scan (défaut: 120s = 2 min)
 *   cev_booking_target_pool = "VOWINT6085888,VOWINT6085889"
 *                                           → si défini, seuls CES dossiers tentent le booking
 *                                             quand un créneau est détecté (session isolée par dossier)
 *                                           → si vide/absent → TOUS les dossiers du pool concourent
 *
 * IMPORTANT : MUTUELLEMENT EXCLUSIF avec cev-stealth-loop (v2 IP pool).
 */

import { setupCevSessionHttp, invalidateVowintCache, invalidateAnticaptchaCache, resolveFirstAppIdFromMyList } from "../cevHttpSetup.js";
import { cancelCevAppointment } from "../cevHttpCancel.js";
import { bookCevViaHttp, extractInlineSlotsFromHtml } from "../cevHttpBooking.js";
import { pollCevSlot } from "../cevPolling.js";
import {
  initCevProxyGuard,
  releaseCevProxyGuard,
  isCevSessionFrozen,
  checkCevProxyLiveness,
  resetCevImpitInstances,
  makeCevProxyStickyUrl,
  initCevProxyGuardWithExitIp,
  setCevExternalUserAgent,
  getCevExternalUserAgent,
  shouldUseProxy,
  getCevBrowserHeaders,
  getCevSessionUa,
  cevImpitFetch,
} from "../cev-shared-impit.js";
import {
  getPendingCevSetups,
  getActiveCevSessions,
  getCevCredentials,
  recordCevSessionCheck,
  reportSlotFound,
  botLog,
  getBotConfigValue,
  getActiveJobs,
  resetCevClickCount,
  injectApplicationF5Cookies,
} from "../convexClient.js";
import {
  initCevRedis,
  syncPoolStateToRedis,
  restorePoolStateFromRedis,
  type SerializablePoolState,
} from "../cev-redis-persistence.js";
import { recordScan, recordSlotFound, recordRateLimit, recordRelogin, recordPause } from "../daily-stats.js";
import { createLogger } from "../logger.js";
import { cevSessionManager, fullSessionToSiphoned, type FullCevSession } from "../cev-session-manager.js";
import { solveHcaptchaWithProxy, parseProxyForAnticaptcha } from "../cev-hcaptcha.js";

// ─── Constantes stealth Puppeteer ─────────────────────────────────────────────

/** UA Chrome 149 Windows — cohérent avec le pool UA de cev-shared-impit.ts */
const STEALTH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

/** sec-ch-ua corrigé (sans HeadlessChrome, format exact navigateur réel) */
const STEALTH_CH_UA =
  '"Not/A)Brand";v="8", "Chromium";v="149", "Google Chrome";v="149"';

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const CEV_CAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const FULL_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4h

// ─── Helpers stealth ──────────────────────────────────────────────────────────

/** Configure une page Puppeteer avec toutes les corrections anti-détection */
async function applyStealthToPage(page: any, logger: ReturnType<typeof createLogger>): Promise<void> {
  // Viewport réaliste (1920×1080 — jamais headless 800×600)
  await page.setViewport({ width: 1920, height: 1080 });

  // User-Agent Chrome 149 sans HeadlessChrome
  await page.setUserAgent(STEALTH_UA);

  // Masquer navigator.webdriver, ajouter Chrome runtime, corriger plugins
  await page.evaluateOnNewDocument(() => {
    // FIX: navigator.webdriver indétectable
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // FIX: Chrome runtime (absent en headless → signal bot)
    // @ts-ignore
    if (!window.chrome) {
      // @ts-ignore
      window.chrome = {
        runtime: {
          onMessage: { addListener: () => {}, removeListener: () => {} },
          connect: () => ({}),
        },
        loadTimes: () => ({}),
        csi: () => ({}),
      };
    }

    // FIX: Plugins non vides (headless = [] → signal bot)
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1, item: () => null, namedItem: () => null },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "", length: 0, item: () => null, namedItem: () => null },
        { name: "Native Client", filename: "internal-nacl-plugin", description: "", length: 2, item: () => null, namedItem: () => null },
      ],
    });

    // FIX: Languages cohérentes avec Accept-Language headers CEV
    Object.defineProperty(navigator, "languages", { get: () => ["fr-BE", "fr", "en-GB", "en"] });

    // FIX: WebGL renderer réaliste (headless retourne "SwiftShader" → signal bot)
    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return "Google Inc. (NVIDIA)";
      if (parameter === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
      return getParam.call(this, parameter);
    };

    // FIX: deviceMemory (undefined en headless → signal bot — Chrome réel retourne 4 ou 8)
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

    // FIX: mimeTypes cohérents avec les plugins déclarés (vide en headless → signal bot)
    const fakeMimeTypes = [
      { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
      { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
    ];
    Object.defineProperty(navigator, "mimeTypes", {
      get: () => Object.assign(fakeMimeTypes, {
        length: fakeMimeTypes.length,
        item: (i: number) => fakeMimeTypes[i] ?? null,
        namedItem: (name: string) => fakeMimeTypes.find(m => m.type === name) ?? null,
      }),
    });
  });

  // FIX: Request interception — corriger HeadlessChrome dans sec-ch-ua
  await page.setRequestInterception(true);
  page.on("request", (req: any) => {
    const headers = { ...req.headers() };
    if (headers["sec-ch-ua"]?.includes("HeadlessChrome")) {
      headers["sec-ch-ua"] = STEALTH_CH_UA;
      headers["sec-ch-ua-mobile"] = "?0";
      headers["sec-ch-ua-platform"] = '"Windows"';
    }
    // Toujours continuer
    req.continue({ headers }).catch(() => { /* page peut être fermée */ });
  });

  logger.info("🛡️ Stealth Puppeteer appliqué (webdriver, plugins, WebGL, sec-ch-ua, viewport)");
}

/** Retourne PROXY_URL + parsed components pour Puppeteer + Anti-Captcha */
function resolvePuppeteerProxy(accountId: string, hunterConfig?: { cevUseProxy?: boolean }): {
  proxyUrl: string;
  proxyHost: string;
  proxyPort: number;
  proxyUser: string;
  proxyPass: string;
} | null {
  const useProxy = hunterConfig?.cevUseProxy ?? true;
  if (!useProxy) return null;

  let rawUrl = "";
  if (process.env.SOAX_PROXY_URL) {
    rawUrl = makeCevProxyStickyUrl("soax", undefined, `cev-dossier-${accountId}`);
  } else if (process.env.IPROYAL_PROXY_URL) {
    rawUrl = makeCevProxyStickyUrl("iproyal", undefined, `cev-dossier-${accountId}`);
  } else if (process.env.PROXY_URL) {
    rawUrl = process.env.PROXY_URL;
  }

  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl.startsWith("http") ? rawUrl : `http://${rawUrl}`);
    return {
      proxyUrl: rawUrl,
      proxyHost: parsed.hostname,
      proxyPort: parseInt(parsed.port || "3128", 10),
      proxyUser: decodeURIComponent(parsed.username),
      proxyPass: decodeURIComponent(parsed.password),
    };
  } catch {
    return null;
  }
}

// ─── Jitter humain ────────────────────────────────────────────────────────────

/**
 * Jitter log-normal centré sur mu (ms) — distribution réaliste du temps humain.
 * Remplace Math.random() * N (distribution uniforme trop mécanique).
 */
function logNormalJitter(muMs: number, sigmaFrac = 0.35): number {
  const u1 = Math.random();
  const u2 = Math.random();
  // Box-Muller
  const z = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
  const sigma = Math.log(1 + sigmaFrac * sigmaFrac);
  const mu = Math.log(muMs) - sigma / 2;
  return Math.max(50, Math.exp(mu + Math.sqrt(sigma) * z));
}

/** Saisie clavier humaine (délai log-normal entre caractères) */
async function humanType(page: any, selector: string, text: string): Promise<void> {
  await page.focus(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: logNormalJitter(90, 0.4) });
  }
}

/**
 * Déplace la souris en trajectoire courbe Bézier vers l'élément puis clique.
 * Génère un vrai signal d'entropy souris (contra bare page.click() qui n'envoie
 * aucun mouseenter/mousemove et est détectable par mouse-movement entropy analysis).
 */
async function humanClick(page: any, selector: string): Promise<void> {
  try {
    const el = await page.$(selector);
    if (!el) { await page.click(selector); return; }
    const box = await el.boundingBox();
    if (!box) { await page.click(selector); return; }

    // Point de départ aléatoire dans la moitié supérieure de l'écran
    const startX = 150 + Math.random() * 700;
    const startY = 60 + Math.random() * 250;
    // Point cible au centre de l'élément avec offset aléatoire
    const targetX = box.x + box.width  * (0.25 + Math.random() * 0.50);
    const targetY = box.y + box.height * (0.25 + Math.random() * 0.50);

    await page.mouse.move(startX, startY);
    const steps = 10 + Math.floor(Math.random() * 8);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // Bruit perpendiculaire qui s'annule en début et fin (sin(π·t))
      const noise = (Math.random() - 0.5) * 28 * Math.sin(Math.PI * t);
      await page.mouse.move(
        startX + (targetX - startX) * t + noise,
        startY + (targetY - startY) * t + noise * 0.45,
      );
      await new Promise(r => setTimeout(r, 10 + Math.random() * 22));
    }
    await page.mouse.click(targetX, targetY);
  } catch {
    // Fallback silencieux si l'élément disparaît
    await page.click(selector).catch(() => {});
  }
}

// ─── Fonction pour capturer le cookie F5 (TS01) ──────────────────────────────

async function captureF5CookieForAccount(
  accountId: string, 
  logger: ReturnType<typeof createLogger>,
  hunterConfig?: { cevUseProxy?: boolean }
): Promise<{ f5CookieValue: string, f5CookieName: string, userAgent: string } | null> {
  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer-extra");
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteer.default.use(StealthPlugin());
  } catch (err) {
    logger.error(`puppeteer-extra or puppeteer-extra-plugin-stealth not installed: ${err}`);
    return null;
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--window-size=1920,1080",   // screen.width/height réalistes (headless défaut → 0)
    "--lang=fr-BE,fr",           // Accept-Language cohérent avec navigator.languages
  ];

  const proxyInfo = resolvePuppeteerProxy(accountId, hunterConfig);
  if (proxyInfo) {
    launchArgs.push(`--proxy-server=${proxyInfo.proxyHost}:${proxyInfo.proxyPort}`);
    logger.info(`Proxy F5 capture: ${proxyInfo.proxyHost}:${proxyInfo.proxyPort}`);
  }

  let browser: any = null;

  try {
    logger.info(`Lancement du navigateur pour capture cookie F5...`);
    browser = await puppeteer.default.launch({ headless: "new", args: launchArgs });

    const page = await browser.newPage();

    // Authentification proxy
    if (proxyInfo?.proxyUser) {
      await page.authenticate({ username: proxyInfo.proxyUser, password: proxyInfo.proxyPass });
    }

    // Stealth complet
    await applyStealthToPage(page, logger);

    // Navigation VOWINT homepage
    logger.info(`Navigating to VOWINT homepage pour TS cookie…`);
    await page.goto(VOWINT_BASE, { waitUntil: "networkidle2", timeout: 60_000 });
    const waitMs = logNormalJitter(9000, 0.3);
    logger.info(`Attente comportementale ${Math.round(waitMs)}ms sur homepage…`);
    await new Promise(r => setTimeout(r, waitMs));

    let cookies = await page.cookies();
    logger.info(`${cookies.length} cookie(s): ${cookies.map((c: any) => c.name).join(", ")}`);

    let f5Cookie = cookies.find((c: any) => c.name.startsWith("TS"));
    if (!f5Cookie) {
      logger.warn(`F5 cookie (TS*) introuvable — rechargement…`);
      await page.goto(VOWINT_BASE, { waitUntil: "networkidle2", timeout: 60_000 });
      await new Promise(r => setTimeout(r, 10_000));
      const cookies2 = await page.cookies();
      f5Cookie = cookies2.find((c: any) => c.name.startsWith("TS"));
      if (!f5Cookie) {
        logger.error("F5 cookie toujours manquant après reload!");
        return null;
      }
    }

    logger.info(`✅ Cookie F5: ${f5Cookie.name}=${f5Cookie.value.slice(0, 20)}…`);
    return { f5CookieValue: f5Cookie.value, f5CookieName: f5Cookie.name, userAgent: STEALTH_UA };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Erreur Puppeteer capture cookie F5: ${msg}`);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// ─── Flow Puppeteer complet (login → captcha → session CEV) ──────────────────

/**
 * Capture une session CEV complète via Puppeteer :
 *   Login VOWINT → IndexByUserId → GetEAppointmentUrl → Integration/VOW
 *   → /Captcha → solve hCaptcha → SetCaptchaToken → extraction cookies
 *
 * Retourne une FullCevSession avec TOUS les cookies nécessaires au polling.
 * La session est valide 4h et peut être réutilisée sans consommer de clics VOWINT.
 *
 * @param dossierRef - Référence VOWINT (ex: "VOWINT6085888") ou UUID direct
 */
async function captureFullSessionForAccount(
  accountId: string,
  vowintEmail: string,
  vowintPassword: string,
  dossierRef: string,
  logger: ReturnType<typeof createLogger>,
  hunterConfig?: { cevUseProxy?: boolean },
): Promise<FullCevSession | null> {
  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer-extra");
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteer.default.use(StealthPlugin());
  } catch (err) {
    logger.error(`puppeteer-extra non disponible: ${err}`);
    return null;
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--window-size=1920,1080",   // screen.width/height réalistes (headless défaut → 0)
    "--lang=fr-BE,fr",           // Accept-Language cohérent avec navigator.languages
  ];

  const proxyInfo = resolvePuppeteerProxy(accountId, hunterConfig);
  if (proxyInfo) {
    launchArgs.push(`--proxy-server=${proxyInfo.proxyHost}:${proxyInfo.proxyPort}`);
    logger.info(`Full session proxy: ${proxyInfo.proxyHost}:${proxyInfo.proxyPort}`);
  }

  let browser: any = null;

  try {
    logger.info(`🚀 Capture session complète CEV — dossier: ${dossierRef}`);
    browser = await puppeteer.default.launch({ headless: "new", args: launchArgs });
    const page = await browser.newPage();

    // Proxy auth
    if (proxyInfo?.proxyUser) {
      await page.authenticate({ username: proxyInfo.proxyUser, password: proxyInfo.proxyPass });
    }

    // Stealth complet
    await applyStealthToPage(page, logger);

    // ── ÉTAPE 1 : Homepage VOWINT (F5 cookie) ───────────────────────────────
    logger.info(`[1/7] Homepage VOWINT…`);
    await page.goto(VOWINT_BASE, { waitUntil: "networkidle2", timeout: 60_000 });
    await new Promise(r => setTimeout(r, logNormalJitter(4000, 0.35)));

    const allCookiesHome = await page.cookies();
    const f5Cookie = allCookiesHome.find((c: any) => c.name.startsWith("TS"));
    if (!f5Cookie) {
      logger.warn(`F5 cookie manquant après homepage — rechargement`);
      await page.reload({ waitUntil: "networkidle2", timeout: 30_000 });
      await new Promise(r => setTimeout(r, 6_000));
    }

    // ── ÉTAPE 2 : Login VOWINT ───────────────────────────────────────────────
    logger.info(`[2/7] Login VOWINT (${vowintEmail.slice(0, 15)}…)…`);
    await page.goto(`${VOWINT_BASE}/en/Account/Login`, { waitUntil: "networkidle2", timeout: 45_000 });
    await new Promise(r => setTimeout(r, logNormalJitter(2500, 0.3)));

    // Saisie username
    try {
      await page.waitForSelector('#UserName, [name="UserName"], input[type="email"]', { timeout: 15_000 });
      await humanType(page, '#UserName, [name="UserName"], input[type="email"]', vowintEmail);
      await new Promise(r => setTimeout(r, logNormalJitter(800, 0.3)));
      await humanType(page, '#Password, [name="Password"], input[type="password"]', vowintPassword);
      await new Promise(r => setTimeout(r, logNormalJitter(1200, 0.3)));

      // Soumission
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45_000 }),
        humanClick(page, '[type="submit"], button[type="submit"], input[value="Login"], input[value="Log in"]'),
      ]);
    } catch (loginErr) {
      logger.error(`Erreur login VOWINT: ${loginErr}`);
      return null;
    }

    const currentUrl = page.url();
    logger.info(`Après login: ${currentUrl.slice(0, 80)}`);

    // Vérifier succès login (redirection vers IndexByUserId ou home)
    if (currentUrl.includes("Account/Login") || currentUrl.includes("login")) {
      // Peut être un échec de login ou une page GDPR
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300));
      logger.warn(`Login peut avoir échoué — URL: ${currentUrl.slice(0, 80)}, texte: ${pageText.slice(0, 100)}`);
      // Continuer quand même — VOWINT redirige parfois vers la home avant IndexByUserId
    }

    // ── ÉTAPE 3 : IndexByUserId (chargement des ressources comportementales) ─
    logger.info(`[3/7] IndexByUserId…`);
    if (!currentUrl.includes("IndexByUserId")) {
      await page.goto(`${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, { waitUntil: "networkidle2", timeout: 45_000 });
    }

    // ── Telemetry OutSystems LogRenderingClientTime (V11) ─────────────────────
    // Le framework JS OutSystems envoie automatiquement ce POST après rendu de page.
    // En Puppeteer headless le PerformanceObserver peut ne pas déclencher — on
    // s'assure de l'envoyer explicitement pour correspondre au comportement Chrome réel.
    // Source HAR réel 2026-06-09: POST /Common/LogRenderingClientTime?actionName=getVisaApplication&time=334
    await page.evaluate(async () => {
      const u1 = Math.random(), u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
      const renderTimeMs = Math.max(120, Math.min(1100, Math.round(Math.exp(5.94 + 0.38 * z))));
      try {
        await (window as unknown as { fetch: typeof fetch }).fetch(
          `/Common/LogRenderingClientTime?actionName=getVisaApplication&time=${renderTimeMs}`,
          { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" },
        );
      } catch { /* non-critique */ }
    }).catch(() => {}); // ignorer erreur evaluate (page fermée, etc.)

    // Délai "lecture de liste" comportemental (1-4s comme un utilisateur réel)
    await new Promise(r => setTimeout(r, logNormalJitter(2500, 0.5)));

    // ── ÉTAPE 4 : GetEAppointmentUrl ─────────────────────────────────────────
    logger.info(`[4/7] GetEAppointmentUrl pour dossier ${dossierRef}…`);

    // Chercher le lien GetEAppointmentUrl correspondant au dossierRef
    let integrationUrl: string | null = null;
    let foundAppId: string | null = null;

    try {
      // D'abord essayer de trouver le lien sur la page (via attribut href)
      const links = await page.evaluate((ref: string) => {
        const anchors = Array.from(document.querySelectorAll("a[href*='GetEAppointmentUrl']"));
        // Chercher un lien proche du dossierRef dans le DOM
        const allLinks = anchors.map((a: any) => ({ href: a.href, text: a.closest("tr")?.innerText ?? "" }));
        const matching = allLinks.find(l => l.text.includes(ref));
        return matching ? [matching] : allLinks;
      }, dossierRef);

      if (links && links.length > 0) {
        const targetLink = links[0];
        const urlObj = new URL(targetLink.href);
        foundAppId = urlObj.searchParams.get("id");
        logger.info(`UUID trouvé via DOM: ${foundAppId?.slice(0, 16)}…`);
      }
    } catch { /* fallback via AJAX */ }

    // Fallback : appel AJAX MyList si DOM n'a pas donné l'UUID
    if (!foundAppId) {
      try {
        const myListResult = await page.evaluate(async (ref: string) => {
          const resp = await (window as any).fetch("/VisaApplication/MyList?draw=1&start=0&length=20", {
            headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/javascript, */*; q=0.01" },
            credentials: "same-origin",
          });
          if (!resp.ok) return null;
          const data = await resp.json();
          const dossiers = data?.data ?? data?.aaData ?? [];
          const match = dossiers.find((d: any) => {
            const dossierId = d.VOWId ?? d.ApplicationId ?? d.Id ?? "";
            return dossierId.toString().includes(ref.replace("VOWINT", ""));
          });
          return match ? { id: match.Id ?? match.ApplicationId, ref: match.VOWId } : (dossiers[0] ? { id: dossiers[0].Id ?? dossiers[0].ApplicationId } : null);
        }, dossierRef);

        if (myListResult?.id) {
          foundAppId = myListResult.id;
          logger.info(`UUID via MyList AJAX: ${foundAppId?.slice(0, 16)}…`);
        }
      } catch (ajaxErr) {
        logger.warn(`MyList AJAX échoué: ${ajaxErr}`);
      }
    }

    if (!foundAppId) {
      logger.error(`Impossible de trouver l'UUID pour dossier ${dossierRef}`);
      return null;
    }

    // Appel GetEAppointmentUrl via page.evaluate (cookies automatiques, même referer)
    const eAppResult = await page.evaluate(async (appId: string) => {
      const url = `/Common/GetEAppointmentUrl?id=${encodeURIComponent(appId)}`;
      const resp = await (window as any).fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          "Cache-Control": "max-age=0",
          "If-Modified-Since": "0",
        },
        credentials: "same-origin",
      });
      const text = await resp.text();
      return { status: resp.status, body: text };
    }, foundAppId);

    logger.info(`GetEAppointmentUrl → HTTP ${eAppResult.status}, body: ${eAppResult.body.slice(0, 120)}`);

    if (eAppResult.status !== 200 || !eAppResult.body) {
      if (eAppResult.body?.toLowerCase().includes("rate") || eAppResult.body?.includes("5 fois") || eAppResult.body?.includes("5 times")) {
        logger.warn(`Rate-limit VOWINT détecté dans GetEAppointmentUrl`);
      } else {
        logger.error(`GetEAppointmentUrl échoué: ${eAppResult.status}`);
      }
      return null;
    }

    // Parser la réponse JSON ou URL brute
    try {
      const parsed = JSON.parse(eAppResult.body);
      if (typeof parsed === "string" && parsed.includes("/Integration/VOW/")) {
        integrationUrl = parsed;
      } else if (parsed?.url) {
        integrationUrl = parsed.url;
      }
    } catch {
      if (eAppResult.body.includes("/Integration/VOW/")) {
        integrationUrl = eAppResult.body.trim().replace(/^"|"$/g, "");
      }
    }

    if (!integrationUrl) {
      logger.error(`Impossible d'extraire l'integration URL depuis: ${eAppResult.body.slice(0, 100)}`);
      return null;
    }

    // Cohérence culture: fr-BE (comme cevHttpSetup.ts)
    if (integrationUrl.endsWith("/en-US")) {
      integrationUrl = integrationUrl.slice(0, -6) + "/fr-BE";
    }

    logger.info(`Integration URL: ${integrationUrl.slice(0, 80)}…`);

    // ── ÉTAPE 5 : Naviguer vers Integration/VOW (CEV) ────────────────────────
    logger.info(`[5/7] Navigation Integration/VOW…`);
    await page.goto(integrationUrl, { waitUntil: "networkidle2", timeout: 45_000 });
    await new Promise(r => setTimeout(r, logNormalJitter(3000, 0.4)));

    // ── ÉTAPE 6 : Résoudre hCaptcha ──────────────────────────────────────────
    logger.info(`[6/7] Résolution hCaptcha…`);

    // Extraire le sitekey dynamiquement depuis la page
    let sitekey = CEV_CAPTCHA_SITEKEY;
    try {
      const extractedKey = await page.evaluate(() => {
        const el = document.querySelector("[data-sitekey]");
        return el ? (el as any).dataset.sitekey : null;
      });
      if (extractedKey && extractedKey.length > 10) {
        sitekey = extractedKey;
        logger.info(`Sitekey extrait dynamiquement: ${sitekey.slice(0, 12)}…`);
      }
    } catch { /* utiliser la valeur par défaut */ }

    // Si on n'est pas encore sur la page Captcha, naviguer explicitement
    const currentPageUrl = page.url();
    if (!currentPageUrl.includes("/Captcha")) {
      logger.info(`Navigation explicite vers ${CEV_BASE}/Captcha…`);
      await page.goto(`${CEV_BASE}/Captcha`, { waitUntil: "networkidle2", timeout: 30_000 });
      await new Promise(r => setTimeout(r, logNormalJitter(2000, 0.3)));
    }

    // Extraire ASP.NET_SessionId avant de résoudre le captcha
    const cevCookiesBefore = await page.cookies();
    const aspNetCookie = cevCookiesBefore.find((c: any) => c.name === "ASP.NET_SessionId");
    if (!aspNetCookie) {
      logger.error(`ASP.NET_SessionId manquant sur la page Captcha`);
      return null;
    }
    logger.info(`ASP.NET_SessionId: ${aspNetCookie.value.slice(0, 12)}…`);

    // Résoudre hCaptcha via Anti-Captcha (avec même proxy que Puppeteer = pas de IP jump)
    const acProxy = proxyInfo ? parseProxyForAnticaptcha(proxyInfo.proxyUrl) : undefined;
    let hcaptchaToken: string;
    try {
      hcaptchaToken = await solveHcaptchaWithProxy({
        sitekey,
        siteUrl: `${CEV_BASE}/Captcha`,
        proxy: acProxy ?? undefined,
        timeoutMs: 120_000,
        logPrefix: `[CEV-FullSession:${accountId.slice(0, 8)}]`,
      });
    } catch (captchaErr) {
      logger.error(`hCaptcha échoué: ${captchaErr}`);
      return null;
    }

    // ── ÉTAPE 7 : POST SetCaptchaToken (dans le contexte browser) ────────────
    logger.info(`[7/7] POST SetCaptchaToken…`);

    const setCaptchaResult = await page.evaluate(async (token: string) => {
      try {
        const resp = await (window as any).fetch("/Captcha/SetCaptchaToken", {
          method: "POST",
          headers: {
            "Accept": "*/*",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          credentials: "same-origin",
          body: `captcha=${encodeURIComponent(token)}`,
        });
        const body = await resp.text();
        return { status: resp.status, ok: resp.ok, body };
      } catch (e) {
        return { status: 0, ok: false, body: String(e) };
      }
    }, hcaptchaToken);

    logger.info(`SetCaptchaToken → HTTP ${setCaptchaResult.status}, body: ${setCaptchaResult.body.slice(0, 120)}`);

    if (!setCaptchaResult.ok) {
      logger.error(`SetCaptchaToken échoué: ${setCaptchaResult.status}`);
      return null;
    }

    // Vérifier que captchaSolved !== false
    try {
      const captchaData = JSON.parse(setCaptchaResult.body) as { captchaSolved?: boolean; validUntil?: string };
      if (captchaData.captchaSolved === false) {
        logger.error(`Captcha rejeté par le serveur (captchaSolved=false)`);
        return null;
      }
    } catch { /* body non-JSON → OK */ }

    // ── Extraire TOUS les cookies finaux ─────────────────────────────────────
    const finalCookies = await page.cookies();
    logger.info(`Cookies finaux (${finalCookies.length}): ${finalCookies.map((c: any) => c.name).join(", ")}`);

    const getCookieVal = (name: string): string => {
      const c = finalCookies.find((c: any) => c.name === name);
      return c?.value ?? "";
    };
    const getStartWith = (prefix: string): { name: string; value: string } | null => {
      const c = finalCookies.find((c: any) => c.name.startsWith(prefix));
      return c ? { name: c.name, value: c.value } : null;
    };

    // Construire la FullCevSession
    const f5Final = getStartWith("TS");
    const now = Date.now();

    const fullSession: FullCevSession = {
      f5CookieName: f5Final?.name ?? "",
      f5CookieValue: f5Final?.value ?? "",
      serverId: getCookieVal("ServerId"),
      osOnline: getCookieVal("OSOnline"),
      culture: getCookieVal("_culture"),
      requestVerificationToken: getCookieVal("__RequestVerificationToken"),
      aspNetSessionId: getCookieVal("ASP.NET_SessionId") || aspNetCookie.value,
      preferredCulture: getCookieVal("PreferredCulture") || "fr-BE",
      integrationUrl,
      appId: foundAppId,
      userAgent: STEALTH_UA,
      proxyUsed: proxyInfo ? `${proxyInfo.proxyHost}:${proxyInfo.proxyPort}` : null,
      capturedAt: now,
      validUntil: now + FULL_SESSION_TTL_MS,
      isFullSession: true,
      // TOUS les cookies Puppeteer — BIGipServer, LastMRH_Session, rd, TS*, ServerId, OSOnline, etc.
      // Permet à buildFullSessionCookieStr d'envoyer l'exact ensemble de cookies qu'un vrai navigateur enverrait.
      rawCookies: finalCookies.map((c: any) => `${c.name}=${c.value}`),
    };

    logger.info(`✅ Session complète capturée — expire dans 4h | aspNet=${fullSession.aspNetSessionId.slice(0, 10)}… | integrationUrl=${integrationUrl.slice(0, 60)}…`);
    return fullSession;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Erreur captureFullSessionForAccount: ${msg}`);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

// ── One-Shot (Predator) — la limite 5 clics/h n'existe plus ────────────────
// Stratégie : 1 réveil toutes les 2 min → 1 clic par dossier → fermeture → sleep
// Session VOWINT réutilisée si encore valide (cache 4h dans cevHttpSetup)
const DEFAULT_INTERVAL_SEC = 120; // 2 min par défaut (configurable via cevScanIntervalSec)
const CLICK_WINDOW_MS = 60 * 60 * 1000; // fenêtre stats uniquement (plus de limite quota)

// ─── Dossier Slot (état de chaque dossier) ──────────────────────────────────

interface DossierSlot {
  /** Index dans le pool (0-based) */
  index: number;
  /** Numéro VOWINT (ex: "VOWINT6085888") */
  vowintRef: string;
  /** Timestamps des clics GetEAppointmentUrl effectués */
  clickTimestamps: number[];
  /** Nombre total de scans réussis */
  totalScans: number;
  /** Nombre de rate-limits rencontrés */
  rateLimitCount: number;
  /** Date du dernier reset quotidien (timestamp) */
  lastDailyReset?: number;
}

class CevDossierPool {
  private slots: DossierSlot[] = [];
  private currentIndex = 0;
  private logger: ReturnType<typeof createLogger>;

  constructor(logger: ReturnType<typeof createLogger>) {
    this.logger = logger;
  }

  /** Initialise le pool avec les numéros VOWINT */
  initialize(vowintRefs: string[]): void {
    const now = Date.now();
    this.slots = vowintRefs.map((ref, i) => ({
      index: i,
      vowintRef: ref.trim().toUpperCase(),
      clickTimestamps: [],
      totalScans: 0,
      rateLimitCount: 0,
      lastDailyReset: now,
    }));
    this.currentIndex = 0;
    this.logger.info(`Pool initialisé: ${this.slots.length} dossiers`);
    this.slots.forEach((s, i) => this.logger.info(`  #${i}: ${s.vowintRef}`));
  }

  /** Retourne le prochain dossier (One-Shot: round-robin pur, pas de quota) */
  getNextAvailable(): DossierSlot | null {
    if (this.slots.length === 0) return null;
    const startIndex = this.currentIndex;

    for (let attempts = 0; attempts < this.slots.length; attempts++) {
      const idx = (startIndex + attempts) % this.slots.length;
      const slot = this.slots[idx];

      if (pausedDossiers.has(slot.vowintRef)) {
        this.logger.info(`  ⏸️ #${slot.index} ${slot.vowintRef} en PAUSE (slot trouvé) — skip`);
        continue;
      }
      this.currentIndex = (idx + 1) % this.slots.length;
      return slot;
    }

    return null; // Tous les dossiers sont en pause
  }

  /** Enregistre un clic sur un dossier (pour les stats uniquement) */
  recordClick(slot: DossierSlot): void {
    slot.clickTimestamps.push(Date.now());
    slot.totalScans++;
  }

  /** Toujours 0 (One-Shot: pas de quota) */
  getNextAvailableIn(): number { return 0; }

  /** Stats du pool */
  getStats(): { total: number; available: number; exhausted: number; totalScans: number } {
    let totalScans = 0;
    for (const slot of this.slots) totalScans += slot.totalScans;
    const active = this.slots.length - pausedDossiers.size;
    return { total: this.slots.length, available: active, exhausted: pausedDossiers.size, totalScans };
  }

  /** Reset quotidien de tous les compteurs */
  checkDailyReset(): void {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    let resetCount = 0;

    for (const slot of this.slots) {
      if (!slot.lastDailyReset || (now - slot.lastDailyReset) > oneDayMs) {
        const oldTotal = slot.totalScans;
        slot.totalScans = 0;
        slot.lastDailyReset = now;
        resetCount++;
        this.logger.info(`📅 Reset quotidien ${slot.vowintRef}: ${oldTotal} scans → 0`);
      }
    }

    if (resetCount > 0) {
      this.logger.info(`📅 Reset quotidien terminé: ${resetCount} dossier(s) réinitialisé(s)`);
    }
  }

  get size(): number { return this.slots.length; }

  /** Retourne une copie de tous les dossiers du pool */
  getAllDossiers(): DossierSlot[] { return [...this.slots]; }

  /** Exporte l'état complet du pool pour persistance Redis */
  exportState(): SerializablePoolState {
    return {
      currentIndex: this.currentIndex,
      slots: this.slots.map(s => ({
        vowintRef: s.vowintRef,
        clickTimestamps: [...s.clickTimestamps],
        totalScans: s.totalScans,
        rateLimitCount: s.rateLimitCount,
        lastDailyReset: s.lastDailyReset,
      })),
      pausedDossiers: Array.from(pausedDossiers),
      savedAt: Date.now(),
    };
  }

  /** Restaure l'état depuis Redis (merge avec les dossiers configurés) */
  restoreState(saved: SerializablePoolState): void {
    // Créer un index rapide par vowintRef
    const savedMap = new Map(saved.slots.map(s => [s.vowintRef, s]));
    const now = Date.now();

    for (const slot of this.slots) {
      const savedSlot = savedMap.get(slot.vowintRef);
      if (savedSlot) {
        slot.clickTimestamps = savedSlot.clickTimestamps;
        slot.totalScans = savedSlot.totalScans;
        slot.rateLimitCount = savedSlot.rateLimitCount;
        slot.lastDailyReset = savedSlot.lastDailyReset || now;
      } else {
        slot.lastDailyReset = now;
      }
    }

    // Restaurer currentIndex seulement s'il est valide
    if (saved.currentIndex >= 0 && saved.currentIndex < this.slots.length) {
      this.currentIndex = saved.currentIndex;
    }

    // Restaurer les dossiers en pause (backward compatibility: champ peut être undefined)
    if (saved.pausedDossiers) {
      saved.pausedDossiers.forEach(vowintRef => pausedDossiers.add(vowintRef));
    }

    this.logger.info(`Pool restauré depuis Redis (index=${this.currentIndex}, paused=${saved.pausedDossiers?.length || 0})`);
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

interface LoopState {
  scanCount: number;
  slotsFound: number;
  rateLimits: number;
  errors: number;
  isRunning: boolean;
  startedAt: number;
}

const state: LoopState = {
  scanCount: 0,
  slotsFound: 0,
  rateLimits: 0,
  errors: 0,
  isRunning: false,
  startedAt: 0,
};

// Temporary log function for legacy use
function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] [CEV-DOSSIER-LEGACY] [${level}] ${msg}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Core: un scan avec un dossier spécifique ───────────────────────────────

interface ScanResult {
  status: "no_slot" | "slot_found" | "rate_limited" | "error" | "no_slot_poll" | "limit_reached" | "probe_error";
  sessionCookie?: string;
  integrationUrl?: string;
  /** URL finale SelectSlot capturée lors du setup (à usage unique — utiliser pour booking) */
  selectSlotUrl?: string;
  /** HTML complet de la page SelectSlot capturé lors du setup (évite une 2ème requête) */
  selectSlotHtml?: string;
  /** Cookie string complet du setup (inclut __RequestVerificationToken anti-CSRF ASP.NET) */
  selectSlotCookies?: string;
  /** HTML brut de la page Overview — présent uniquement si status='limit_reached' */
  overviewHtml?: string;
  /** URL de la page Overview — présent uniquement si status='limit_reached' */
  overviewUrl?: string;
}

// ─── Type étendu pour siphonedCreds (full session + legacy F5) ───────────────

interface SiphonedCreds {
  f5CookieValue?: string;
  f5CookieName?: string;
  aspNetSessionId?: string;
  userAgent?: string;
  validUntil?: number;
  siphonedAt?: number;
  // Full session mode (cev_full_puppeteer_mode=1)
  isFullSession?: boolean;
  integrationUrl?: string;
  preferredCulture?: string;
  serverId?: string;
  osOnline?: string;
  culture?: string;
  // Tous les cookies bruts capturés par Puppeteer — inclut BIGipServer, LastMRH_Session, rd, etc.
  rawCookies?: string[];
}

/** Construit le cookie header complet depuis les données de session.
 *
 * Mode full session (Puppeteer) : utilise rawCookies — TOUS les cookies
 * capturés par le navigateur réel, incluant BIGipServer, LastMRH_Session,
 * rd et autres cookies F5/WAF normalement invisibles au HTTP bot.
 *
 * Mode legacy (impit) : reconstruit à partir des champs nommés connus.
 */
function buildFullSessionCookieStr(s: SiphonedCreds): string {
  if (s.rawCookies && s.rawCookies.length > 0) {
    return s.rawCookies.join("; ");
  }
  const parts: string[] = [];
  if (s.f5CookieName && s.f5CookieValue) parts.push(`${s.f5CookieName}=${s.f5CookieValue}`);
  if (s.aspNetSessionId) parts.push(`ASP.NET_SessionId=${s.aspNetSessionId}`);
  parts.push(`PreferredCulture=${s.preferredCulture ?? "fr-BE"}`);
  if (s.serverId) parts.push(`ServerId=${s.serverId}`);
  if (s.osOnline) parts.push(`OSOnline=${s.osOnline}`);
  return parts.join("; ");
}

async function performScan(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
  applicationId: string,
  siphoned?: SiphonedCreds,
  _hcaptchaRetry = 0,
  logger?: ReturnType<typeof createLogger>,
): Promise<ScanResult> {
  const logFn = logger || { 
    info: (msg: string) => log("INFO", msg), 
    warn: (msg: string) => log("WARN", msg), 
    error: (msg: string) => log("ERROR", msg) 
  };

  // ── Shortcut mode full session : skip setupCevSessionHttp, polling direct ──
  // Quand une FullCevSession est disponible (capturée par captureFullSessionForAccount),
  // on n'a pas besoin de re-login + re-captcha. On poll directement.
  // Avantage : aucun clic VOWINT consommé (limite 5/h préservée pour la capture initiale).
  if (
    siphoned?.isFullSession &&
    siphoned.integrationUrl &&
    siphoned.aspNetSessionId &&
    siphoned.validUntil &&
    Date.now() < siphoned.validUntil
  ) {
    const cookieStr = buildFullSessionCookieStr(siphoned);
    const pollResult = await pollCevSlot(siphoned.integrationUrl, cookieStr, siphoned);

    if (pollResult.status === "slot_found") {
      return {
        status: "slot_found",
        sessionCookie: cookieStr,
        integrationUrl: siphoned.integrationUrl,
      };
    }
    // Session expirée côté serveur → forcer refresh
    if (pollResult.status === "session_expired") {
      logFn.warn(`  Session CEV expirée côté serveur — invalidation`);
      return { status: "error" };
    }
    // Pas de créneau — status spécial pour que le loop ne compte pas ce poll comme un clic
    return { status: "no_slot_poll", sessionCookie: cookieStr, integrationUrl: siphoned.integrationUrl };
  }

  // ── Mode legacy : setupCevSessionHttp (login + captcha via HTTP/impit) ──────
  const result = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    applicationId,
    applicationId,
    dossier.vowintRef,
    siphoned,
  );

  if (!result.success) {
    if (result.error?.includes("RATE_LIMIT")) {
      return { status: "rate_limited" };
    }
    const isCaptchaError = result.error === "HCAPTCHA_FAILED" || 
                           result.error?.includes("CAPTCHA") ||
                           result.error?.includes("CAPTCHA_RETRY");
    if (isCaptchaError && _hcaptchaRetry < 2) {
      logFn.warn(`  ⟳ ${result.error} — retry ${_hcaptchaRetry + 1}/2 avec clé fraîche dans 5s…`);
      invalidateAnticaptchaCache();
      await sleep(5_000);
      return performScan(vowintEmail, vowintPassword, dossier, applicationId, siphoned, _hcaptchaRetry + 1, logger);
    }
    logFn.warn(`  Erreur setup: ${result.error}`);
    return { status: "error" };
  }

  if (result.slotsAvailable) {
    return {
      status: "slot_found",
      sessionCookie: result.sessionCookie,
      integrationUrl: result.integrationUrl,
      selectSlotUrl: result.selectSlotUrl,
      selectSlotHtml: result.selectSlotHtml,
      selectSlotCookies: result.selectSlotCookies,
    };
  }

  // CAS 2 OVERVIEW — Limite de RDV atteinte pour ce dossier
  if (result.overviewState === 'limit_reached') {
    return {
      status: "limit_reached",
      sessionCookie: result.sessionCookie,
      overviewHtml: result.overviewHtml,
      overviewUrl: result.overviewUrl,
    };
  }

  // Poll rapide si on a un cookie de session
  if (result.sessionCookie) {
    const pollResult = await pollCevSlot(
      result.integrationUrl ?? "",
      result.sessionCookie,
      siphoned,
    );
    if (pollResult.status === "slot_found") {
      return {
        status: "slot_found",
        sessionCookie: result.sessionCookie,
        integrationUrl: result.integrationUrl,
      };
    }
  }

  // Probe échouée (timeout/503/504/réseau) → signaler pour retry immédiat
  if (result.probeError) {
    return { status: "probe_error" };
  }

  return { status: "no_slot" };
}

// ─── Booking ────────────────────────────────────────────────────────────────

import { sendSlotDetectedEmail, type SlotBookingEmailData } from "../cev-slot-discovery.js";

/** Dossiers en pause (après slot_found) — ne pas re-scanner */
const pausedDossiers = new Set<string>();

async function handleSlotFound(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
  applicationId: string,
  existingSessionCookie?: string,
  existingIntegrationUrl?: string,
  siphoned?: {
    f5CookieValue?: string;
    f5CookieName?: string;
    aspNetSessionId?: string;
    userAgent?: string;
    validUntil?: number;
  },
  logger?: ReturnType<typeof createLogger>,
  /** HTML SelectSlot pré-capturé lors du setup (URL à usage unique — ne pas refaire la requête) */
  existingSelectSlotHtml?: string,
  /** URL finale SelectSlot capturée lors du setup */
  existingSelectSlotUrl?: string,
  /** Nombre minimum de places libres requises (groupSize) */
  groupSize?: number,
  /** Cookie string complet du setup (inclut __RequestVerificationToken anti-CSRF ASP.NET) */
  existingSelectSlotCookies?: string,
): Promise<void> {
  const logFn = logger || { 
    info: (msg: string) => log("INFO", msg), 
    warn: (msg: string) => log("WARN", msg), 
    error: (msg: string) => log("ERROR", msg) 
  };
  logFn.info(`🚨 SLOT DÉTECTÉ sur dossier #${dossier.index} ${dossier.vowintRef} — DISCOVERY + BOOKING`);
  state.slotsFound++;

  // ── PAUSE immédiate du dossier (ne plus le re-scanner) ──
  pausedDossiers.add(dossier.vowintRef);
  logFn.info(`  ⏸️ Dossier #${dossier.index} ${dossier.vowintRef} mis en PAUSE`);

  botLog({
    applicationId,
    step: "cev_dossier_slot_found",
    status: "ok",
    data: {
      dossier: dossier.vowintRef,
      dossierIndex: dossier.index,
      scanCount: state.scanCount,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
      hasExistingSession: !!existingSessionCookie,
      paused: true,
    },
  });

  // ── BOOKING IMMÉDIAT avec la session existante ──
  // CRITIQUE : ne pas faire de discovery ni d'email AVANT le booking.
  // CEV invalide la session dès qu'on navigue ailleurs que SelectSlot.
  const sessionCookie = existingSessionCookie;
  const integrationUrl = existingIntegrationUrl;

  if (sessionCookie && integrationUrl) {
    // Tenter le booking HTTP immédiatement
    logFn.info(`  🎯 BOOKING IMMÉDIAT avec session existante${existingSelectSlotHtml ? " (HTML pré-capturé)" : ""}...`);
    try {
      const httpResult = await bookCevViaHttp(
        integrationUrl, sessionCookie!, applicationId, siphoned, undefined,
        existingSelectSlotHtml, existingSelectSlotUrl, existingSelectSlotCookies, groupSize,
      );
      if (httpResult.success) {
        logFn.info(`  ✅ BOOKING RÉUSSI! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
        await reportSlotFound({
          applicationId,
          date: httpResult.bookedDate ?? "",
          time: httpResult.bookedTime ?? "",
          location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
          confirmationCode: httpResult.confirmationCode,
        });
        return;
      }
      // Si NO_AVAILABILITY → le slot est pris, on s'arrête
      if (httpResult.error === "NO_AVAILABILITY" || httpResult.error === "NO_SLOTS_IN_RESPONSE") {
        logFn.info(`  ❌ Slot disparu (${httpResult.error}) — pas de retry`);
        return;
      }
      // SessionExpired ou autre erreur → le slot existe peut-être encore → retry avec re-login
      logFn.info(`  ⚠️ Booking HTTP échoué: ${httpResult.error} — retry avec re-login...`);
    } catch (err) {
      logFn.warn(`  ⚠️ Booking HTTP crash: ${err} — retry avec re-login...`);
    }
  }

  // ── RETRY : re-login + nouveau setup (session morte mais slot peut-être encore là) ──
  logFn.info(`  🔄 Re-login pour retry...`);
  const session = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    applicationId,
    applicationId,
    dossier.vowintRef,
    siphoned,
  );

  if (!session.success || !session.sessionCookie || !session.integrationUrl) {
    logFn.error(`  ❌ Re-setup échoué: ${session.error ?? "unknown"}`);
    return;
  }

  // Tenter le booking avec la session fraîche
  try {
    const httpResult = await bookCevViaHttp(
      session.integrationUrl!, session.sessionCookie!, applicationId, siphoned, undefined,
      session.selectSlotHtml, session.selectSlotUrl, session.selectSlotCookies, groupSize,
    );
    if (httpResult.success) {
      logFn.info(`  ✅ BOOKING RÉUSSI (re-login)! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
      await reportSlotFound({
        applicationId,
        date: httpResult.bookedDate ?? "",
        time: httpResult.bookedTime ?? "",
        location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
        confirmationCode: httpResult.confirmationCode,
      });
    } else {
      logFn.error(`  ❌ Booking HTTP (re-login) échoué: ${httpResult.error}`);
    }
  } catch (err) {
    logFn.error(`  💥 Crash booking: ${err}`);
  }
}

// ─── Booking isolé par dossier ───────────────────────────────────────────────
//
// Chaque appel ouvre SA PROPRE session HTTP (cookie jar distinct).
// Cela évite l'erreur "multiple session" du portail CEV qui se déclenche
// quand le même navigateur/session clique "prendre rendez-vous" deux fois.

async function bookDossierIsolated(
  vowintEmail: string,
  vowintPassword: string,
  vowintRef: string,
  applicationId: string,
  groupSize?: number,
  /** Session déjà ouverte par le dossier qui vient de détecter le slot */
  existingSession?: {
    sessionCookie: string;
    integrationUrl: string;
    selectSlotHtml?: string;
    selectSlotUrl?: string;
    selectSlotCookies?: string;
  },
  logger?: ReturnType<typeof createLogger>,
): Promise<{
  success: boolean;
  confirmationCode?: string;
  bookedDate?: string;
  bookedTime?: string;
  screenshotStorageId?: string;
  error?: string;
}> {
  const logFn = logger ?? {
    info:  (m: string) => log("INFO",  m),
    warn:  (m: string) => log("WARN",  m),
    error: (m: string) => log("ERROR", m),
  };

  // ── Chemin rapide : session existante du dossier détecteur ──────────────
  if (existingSession?.sessionCookie && existingSession?.integrationUrl) {
    logFn.info(`  [${vowintRef}] 🔗 Tentative booking HTTP session existante...`);
    try {
      const res = await bookCevViaHttp(
        existingSession.integrationUrl,
        existingSession.sessionCookie,
        applicationId,
        undefined, undefined,
        existingSession.selectSlotHtml,
        existingSession.selectSlotUrl,
        existingSession.selectSlotCookies,
        groupSize,
      );
      if (res.success) {
        logFn.info(`  [${vowintRef}] ✅ BOOKING RÉUSSI (session existante)! code=${res.confirmationCode}`);
        return { success: true, confirmationCode: res.confirmationCode, bookedDate: res.bookedDate, bookedTime: res.bookedTime };
      }
      logFn.warn(`  [${vowintRef}] ⚠️ Session existante insuffisante: ${res.error} → re-login isolé`);
    } catch (err) {
      logFn.warn(`  [${vowintRef}] ⚠️ Crash session existante: ${err} → re-login isolé`);
    }
  }

  // ── Re-login isolé (cache keyed par vowintRef = session indépendante) ───
  logFn.info(`  [${vowintRef}] 🔑 Ouverture session isolée (re-login)...`);
  // Invalider le cache pour ce dossier spécifique afin de forcer un login frais
  invalidateVowintCache(vowintEmail);

  let session: Awaited<ReturnType<typeof setupCevSessionHttp>>;
  try {
    session = await setupCevSessionHttp(
      vowintEmail,
      vowintPassword,
      vowintRef,   // accountId isolé par dossier
      applicationId,
      vowintRef,
      undefined,
    );
  } catch (err) {
    logFn.error(`  [${vowintRef}] ❌ Re-login crash: ${err}`);
    return { success: false, error: `re-login crash: ${err}` };
  }

  if (!session.success || !session.sessionCookie || !session.integrationUrl) {
    logFn.error(`  [${vowintRef}] ❌ Re-login échoué: ${session.error ?? 'unknown'}`);
    return { success: false, error: `re-login failed: ${session.error ?? 'unknown'}` };
  }

  // ── Booking HTTP avec session fraîche ───────────────────────────────────
  try {
    const res = await bookCevViaHttp(
      session.integrationUrl,
      session.sessionCookie,
      applicationId,
      undefined, undefined,
      session.selectSlotHtml,
      session.selectSlotUrl,
      session.selectSlotCookies,
      groupSize,
    );
    if (res.success) {
      logFn.info(`  [${vowintRef}] ✅ BOOKING RÉUSSI (re-login)! code=${res.confirmationCode}`);
      return { success: true, confirmationCode: res.confirmationCode, bookedDate: res.bookedDate, bookedTime: res.bookedTime };
    }
    logFn.warn(`  [${vowintRef}] ⚠️ HTTP échoué: ${res.error}`);
    return { success: false, error: res.error ?? "HTTP booking failed" };
  } catch (err) {
    logFn.warn(`  [${vowintRef}] ⚠️ HTTP crash: ${err}`);
    return { success: false, error: `http crash: ${err}` };
  }
}

// ─── Booking multi-dossier avec sessions isolées ─────────────────────────────
//
// Quand un créneau est détecté :
//   1. Si cev_booking_target_pool est configuré → seuls ces dossiers tentent le booking
//   2. Sinon → tous les dossiers du pool concourent
//   3. Chaque dossier ouvre sa propre session HTTP (isolation totale, pas de multi-session)
//   4. Exécution en parallèle (Promise.allSettled)

async function handleSlotFoundMulti(
  vowintEmail: string,
  vowintPassword: string,
  detectingDossier: DossierSlot,
  allPoolDossiers: DossierSlot[],
  applicationId: string,
  existingSessionCookie?: string,
  existingIntegrationUrl?: string,
  logger?: ReturnType<typeof createLogger>,
  existingSelectSlotHtml?: string,
  existingSelectSlotUrl?: string,
  groupSize?: number,
  existingSelectSlotCookies?: string,
  /** CSV de VOWINT refs (cev_booking_target_pool). Vide = tous les dossiers du pool. */
  bookingTargetPoolStr?: string,
): Promise<void> {
  const logFn = logger ?? {
    info:  (m: string) => log("INFO",  m),
    warn:  (m: string) => log("WARN",  m),
    error: (m: string) => log("ERROR", m),
  };

  logFn.info(`🚨 SLOT DÉTECTÉ sur ${detectingDossier.vowintRef} — BOOKING MULTI-DOSSIER ISOLÉ`);
  state.slotsFound++;

  // ── Déterminer les dossiers éligibles ────────────────────────────────────
  let eligibleRefs: string[];
  if (bookingTargetPoolStr?.trim()) {
    eligibleRefs = bookingTargetPoolStr
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    logFn.info(`  🎯 Pool cible configuré (cev_booking_target_pool): [${eligibleRefs.join(", ")}]`);
  } else {
    eligibleRefs = allPoolDossiers.map(d => d.vowintRef);
    logFn.info(`  🎯 Aucun pool cible → tous les ${eligibleRefs.length} dossier(s) du pool participent`);
  }

  // Garantir que le dossier détecteur est toujours mis en pause (qu'il soit éligible ou non)
  pausedDossiers.add(detectingDossier.vowintRef);
  eligibleRefs.forEach(ref => pausedDossiers.add(ref));
  logFn.info(`  ⏸️ ${eligibleRefs.length} dossier(s) mis en PAUSE immédiatement`);

  botLog({
    applicationId,
    step: "cev_dossier_slot_found",
    status: "ok",
    data: {
      detectingDossier: detectingDossier.vowintRef,
      eligibleDossiers: eligibleRefs,
      targetPoolConfigured: !!bookingTargetPoolStr?.trim(),
      scanCount: state.scanCount,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
    },
  });

  // ── Analyser les slots IMMÉDIATEMENT depuis le HTML pré-capturé ─────────
  // CRITIQUE : ne pas perdre la session sur des opérations inutiles.
  // CEV invalide la session dès qu'on fait autre chose que soumettre le form SelectSlot.
  let totalFree = 0;
  if (existingSelectSlotHtml && existingSelectSlotHtml.length > 500) {
    const inlineSlots = extractInlineSlotsFromHtml(existingSelectSlotHtml);
    totalFree = inlineSlots.reduce((sum, s) => sum + (s.free ?? 1), 0);
    logFn.info(`  📊 Slots inline détectés: ${inlineSlots.length} créneau(x), totalFree=${totalFree}`);
    botLog({
      applicationId,
      step: "cev_multi_slot_analysis",
      status: "ok",
      data: {
        inlineSlotCount: inlineSlots.length,
        totalFree,
        eligibleDossiers: eligibleRefs.length,
        slots: inlineSlots.slice(0, 5).map(s => ({ date: s.date, time: s.time, free: s.free ?? 1 })),
        decision: totalFree <= 1 ? "BOOK_IMMEDIATELY_SINGLE" : totalFree < eligibleRefs.length ? "BOOK_FIRST_THEN_OTHERS" : "BOOK_PARALLEL_ALL",
      },
    });
  } else {
    // Pas de HTML pré-capturé — on suppose free limité, booker immédiatement
    totalFree = 1;
    logFn.info(`  ⚠️ Pas de HTML pré-capturé — booking immédiat (hypothèse free=1)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATÉGIE : BOOKER LE DOSSIER DÉTECTEUR EN PREMIER — TOUJOURS
  // La session CEV expire dès qu'on fait autre chose que soumettre le SelectSlot.
  // Pas de discovery, pas d'email, pas de wake multi-dossier AVANT le booking.
  // ═══════════════════════════════════════════════════════════════════════════

  let detectingBookingResult: Awaited<ReturnType<typeof bookDossierIsolated>> | null = null;

  if (existingSessionCookie && existingIntegrationUrl) {
    logFn.info(`  🎯 BOOKING IMMÉDIAT — ${detectingDossier.vowintRef} (session existante, pas de discovery)...`);
    try {
      detectingBookingResult = await bookDossierIsolated(
        vowintEmail, vowintPassword,
        detectingDossier.vowintRef, applicationId,
        groupSize,
        {
          sessionCookie: existingSessionCookie,
          integrationUrl: existingIntegrationUrl,
          selectSlotHtml: existingSelectSlotHtml,
          selectSlotUrl: existingSelectSlotUrl,
          selectSlotCookies: existingSelectSlotCookies,
        },
        logger,
      );

      if (detectingBookingResult.success) {
        logFn.info(`  ✅ ${detectingDossier.vowintRef} → BOOKING RÉUSSI! code=${detectingBookingResult.confirmationCode} date=${detectingBookingResult.bookedDate}`);
        await reportSlotFound({
          applicationId,
          date: detectingBookingResult.bookedDate ?? "",
          time: detectingBookingResult.bookedTime ?? "",
          location: `CEV Belgique (${detectingDossier.vowintRef})`,
          confirmationCode: detectingBookingResult.confirmationCode,
        });
        botLog({ applicationId, step: "cev_multi_booking_success", status: "ok", data: { vowintRef: detectingDossier.vowintRef, confirmationCode: detectingBookingResult.confirmationCode, strategy: "immediate" } });
      } else {
        logFn.warn(`  ⚠️ ${detectingDossier.vowintRef} → Booking session existante échoué: ${detectingBookingResult.error}`);
      }
    } catch (err) {
      logFn.error(`  💥 ${detectingDossier.vowintRef} → Booking crash: ${err}`);
    }
  }

  // ── Décision multi-dossier basée sur le free RESTANT après le détecteur ────
  // Si free=3 et le détecteur a réussi → il reste 2 places → réveiller max 2 autres.
  // Si free=1 → pas de multi. Si détecteur a échoué (session expired) → le slot est peut-être pris par un humain → pas de multi non plus.
  const freeConsumedByDetector = detectingBookingResult?.success ? 1 : 0;
  const remainingFree = totalFree - freeConsumedByDetector;
  const otherRefs = eligibleRefs.filter(ref => ref !== detectingDossier.vowintRef);
  // Ne réveiller que min(remainingFree, otherRefs.length) dossiers — pas plus que de places disponibles
  const dossiersToWake = Math.min(remainingFree, otherRefs.length);
  const skipMulti = dossiersToWake <= 0;

  if (skipMulti) {
    if (detectingBookingResult?.success && remainingFree <= 0) {
      logFn.info(`  🏁 Booking réussi pour ${detectingDossier.vowintRef} — aucune place restante (free=${totalFree})`);
    } else if (totalFree <= 1) {
      logFn.info(`  🏁 totalFree=${totalFree} — pas de multi-dossier`);
    } else {
      logFn.info(`  🏁 Pas de multi-dossier (remainingFree=${remainingFree}, autres=${otherRefs.length})`);
    }
  } else {
    // ── Multi-dossier : booker les AUTRES dossiers en parallèle ─────────────
    // Le détecteur a déjà tenté. On réveille seulement le nombre de dossiers = places restantes.
    // Chaque dossier re-login isolé → le serveur leur montre le availability[] mis à jour.
    const selectedRefs = otherRefs.slice(0, dossiersToWake);
    logFn.info(`  🚀 remainingFree=${remainingFree} — lancement ${selectedRefs.length} dossier(s) secondaire(s) [${selectedRefs.join(", ")}]...`);

    const bookingTasks = selectedRefs.map(vowintRef =>
      bookDossierIsolated(
        vowintEmail, vowintPassword,
        vowintRef, applicationId,
        groupSize, undefined, logger,
      ).then(result => ({ vowintRef, ...result }))
    );

    const results = await Promise.allSettled(bookingTasks);

    for (const settled of results) {
      if (settled.status === "rejected") {
        logFn.error(`  💥 Booking task crash: ${settled.reason}`);
        continue;
      }
      const r = settled.value;
      if (r.success) {
        logFn.info(`  ✅ ${r.vowintRef} → BOOKING RÉUSSI! code=${r.confirmationCode} date=${r.bookedDate}`);
        await reportSlotFound({
          applicationId,
          date: r.bookedDate ?? "",
          time: r.bookedTime ?? "",
          location: `CEV Belgique (${r.vowintRef})`,
          confirmationCode: r.confirmationCode,
          screenshotStorageId: r.screenshotStorageId,
        });
        botLog({ applicationId, step: "cev_multi_booking_success", status: "ok", data: { vowintRef: r.vowintRef, confirmationCode: r.confirmationCode, strategy: "parallel" } });
      } else {
        logFn.warn(`  ❌ ${r.vowintRef} → Booking échoué: ${r.error}`);
        botLog({ applicationId, step: "cev_multi_booking_fail", status: "fail", data: { vowintRef: r.vowintRef, error: r.error } });
      }
    }
  }

  // ── Email admin avec le RÉSULTAT du booking (pas de discovery inutile) ────
  // Envoie les infos utiles : slots détectés, résultat, code confirmation.
  void (async () => {
    try {
      let inlineSlots: Array<{ date: string; time: string; free: number }> = [];
      if (existingSelectSlotHtml && existingSelectSlotHtml.length > 500) {
        inlineSlots = extractInlineSlotsFromHtml(existingSelectSlotHtml).map(s => ({
          date: s.date, time: s.time, free: s.free ?? 1,
        }));
      }
      const emailData: SlotBookingEmailData = {
        vowintRef: detectingDossier.vowintRef,
        detectedAt: Date.now(),
        slots: inlineSlots,
        totalFree,
        bookingResult: detectingBookingResult?.success ? "success" : "failed",
        confirmationCode: detectingBookingResult?.confirmationCode,
        bookedDate: detectingBookingResult?.bookedDate,
        bookedTime: detectingBookingResult?.bookedTime,
        error: detectingBookingResult?.success ? undefined : detectingBookingResult?.error,
        eligibleDossiers: eligibleRefs,
        strategy: skipMulti ? "immediate_single" : "parallel_multi",
      };
      await sendSlotDetectedEmail(detectingDossier.vowintRef, emailData);
    } catch (err) {
      logFn.warn(`  ⚠️ Email post-booking (non bloquant): ${err}`);
    }
  })();
}

// ─── Loop Principal v3 ──────────────────────────────────────────────────────

export async function startCevDossierLoop(): Promise<void> {
  const logger = createLogger("CEV-DOSSIER-v3");
  logger.info("═══ CEV Dossier Loop v3 — Multi-comptes via Applications ═══");

  // Vérifier si le mode est activé
  const enabled = await getBotConfigValue("cev_dossier_mode");
  if (enabled !== "1") {
    logger.info("Mode dossier désactivé (cev_dossier_mode != 1) — attente...");
    while (true) {
      await sleep(60_000);
      const check = await getBotConfigValue("cev_dossier_mode");
      if (check === "1") {
        logger.info("Mode dossier activé → démarrage!");
        break;
      }
    }
  }

  // Récupérer les applications CEV actives via getActiveJobs() (comme le bot USA)
  const jobs = await getActiveJobs();
  const cevJobs = jobs.filter((j: any) => 
    j.destination === "schengen" && 
    j.hunterConfig?.isActive === true &&
    (j.hunterConfig.cevDossierPool || j.hunterConfig.vowintAppId)
  );

  if (cevJobs.length === 0) {
    logger.warn("Aucune application CEV active trouvée (destination=schengen + hunterConfig.isActive=true)");
    logger.info("Attente configuration...");
    while (true) {
      await sleep(60_000);
      const checkJobs = await getActiveJobs();
      const checkCevJobs = checkJobs.filter((j: any) => 
        j.destination === "schengen" && 
        j.hunterConfig?.isActive === true &&
        (j.hunterConfig.cevDossierPool || j.hunterConfig.vowintAppId)
      );
      if (checkCevJobs.length > 0) {
        logger.info(`Applications CEV trouvées: ${checkCevJobs.length}`);
        break;
      }
    }
  }

  logger.info(`═══ ${cevJobs.length} compte(s) CEV actif(s) ═══`);
  cevJobs.forEach((job: any, i: number) => {
    const dossierPool = job.hunterConfig.cevDossierPool || job.hunterConfig.vowintAppId;
    logger.info(`  Compte #${i + 1}: ${job.applicantName} (${job.id})`);
    logger.info(`    Dossiers: ${dossierPool}`);
    logger.info(`    Proxy: ${job.hunterConfig.cevUseProxy ? 'activé' : 'désactivé'}`);
  });

  // Lancer une loop par compte (application)
  const loopPromises = cevJobs.map((job: any) => 
    runAccountLoop(job)
  );

  await Promise.all(loopPromises);
}

// ─── Loop par compte (application) ────────────────────────────────────────────

async function runAccountLoop(job: any): Promise<void> {
  const accountId = job.id;
  const applicantName = job.applicantName;
  const hunterConfig = job.hunterConfig;
  const logger = createLogger(`CEV-Account:${applicantName}`);
  
  // Récupérer les credentials VOWINT depuis hunterConfig
  let vowintEmail = hunterConfig.embassyUsername;
  let vowintPassword = hunterConfig.embassyPassword;
  
  // Déterminer le pool de dossiers
  let dossierPoolStr = hunterConfig.cevDossierPool;
  let dossiers: string[];
  
  if (!dossierPoolStr) {
    // Mode automatique: naviguer vers My Applications pour trouver les dossiers
    logger.info( "  → Aucun dossier fourni, navigation automatique vers My Applications...");
    try {
      const authResult = await setupCevSessionHttp(vowintEmail, vowintPassword, accountId, accountId);
      if (authResult.success && authResult.sessionCookie) {
        const firstDossier = await resolveFirstAppIdFromMyList(authResult.sessionCookie);
        if (firstDossier) {
          dossiers = [firstDossier];
          logger.info(`  → Dossier automatique trouvé: ${firstDossier}`);
        } else {
          logger.warn( "  → Aucun dossier trouvé via navigation automatique");
          dossiers = [];
        }
      } else {
        logger.warn( "  → Échec de l'authentification pour navigation automatique");
        dossiers = [];
      }
    } catch (err) {
      logger.error(`  → Erreur navigation automatique: ${err}`);
      dossiers = [];
    }
  } else {
    dossiers = dossierPoolStr.split(",").map((s: string) => s.trim()).filter(Boolean);
  }

  // Filtrer les dossiers exclus (cevDossierExclude = liste CSV de VOWINT refs à ignorer)
  const excludeStr: string = hunterConfig.cevDossierExclude ?? "";
  if (excludeStr.trim()) {
    const excluded = new Set(excludeStr.split(",").map((s: string) => s.trim()).filter(Boolean));
    const before = dossiers.length;
    dossiers = dossiers.filter((d: string) => !excluded.has(d));
    if (dossiers.length < before) {
      logger.info(`  → ${before - dossiers.length} dossier(s) exclu(s) du pool: ${[...excluded].join(", ")}`);
    }
  }

  // Créer un pool local pour ce compte
  const localPool = new CevDossierPool(logger);
  localPool.initialize(dossiers);
  
  // Clé Redis spécifique à ce compte
  const redisKey = `visaflow:cev-pool:${accountId}`;
  
  // Intervalle de scan
  const intervalSec = hunterConfig.cevScanIntervalSec || DEFAULT_INTERVAL_SEC;
  const intervalMs = intervalSec * 1000;
  
  // Proxy config
  const useProxy = hunterConfig.cevUseProxy ?? await shouldUseProxy();
  
  logger.info(`═══ Compte: ${applicantName} (${dossiers.length} dossiers) ═══`);
  logger.info(`  Intervalle: ${intervalSec}s`);
  logger.info(`  Proxy: ${useProxy ? 'activé' : 'désactivé'}`);
  
  // ─── Redis: restaurer l'état du pool ────────────────────────────────────────
  await initCevRedis();
  const savedPoolState = await restorePoolStateFromRedis(redisKey, false); // freshStart=false pour préserver les clics
  let savedScanCount = 0;
  if (savedPoolState) {
    localPool.restoreState(savedPoolState);
    savedScanCount = savedPoolState.scanCount || 0;
    // Restaurer les dossiers en pause depuis Redis (backward compatibility: champ peut être undefined)
    if (savedPoolState.pausedDossiers) {
      savedPoolState.pausedDossiers.forEach(vowintRef => pausedDossiers.add(vowintRef));
    }
    logger.info(`Pool state restauré depuis Redis — reprend à index=${savedPoolState.currentIndex}, scanCount=${savedScanCount}, paused=${savedPoolState.pausedDossiers?.length || 0}`);
  } else {
    logger.info( "Pas de pool state en Redis — démarrage frais");
  }

  const soaxBaseUrl = process.env.SOAX_PROXY_URL;
  let proxyExitIp: string | null = null;

  logger.info(`Config:`);
  logger.info(`  • Dossiers: ${localPool.size}`);
  logger.info(`  • Stratégie: One-Shot (1 clic/réveil, session réutilisée si valide)`);
  logger.info(`  • Intervalle: ${Math.round(intervalMs / 1000)}s (±jitter log-normal)`);

  if (useProxy) {
    logger.info(`  • Proxy: SOAX (1 IP fixe Kinshasa)`);

    // ─── Configure SOAX proxy ─────────────────────────────────────────────────
    if (soaxBaseUrl) {
      const soaxStickyUrl = makeCevProxyStickyUrl("soax", undefined, `cev-dossier-${accountId}`);
      process.env.IPROYAL_PROXY_URL = soaxStickyUrl;
      resetCevImpitInstances(); // Force impit to recreate with new proxy URL
      logger.info(`  • SOAX proxy configuré: ${soaxStickyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}…`);
      // Effectuer un health check pour récupérer l'IP de sortie et initialiser le guard
      proxyExitIp = await initCevProxyGuardWithExitIp(soaxStickyUrl, `cev-dossier-${accountId}`);
    } else if (process.env.IPROYAL_PROXY_URL) {
      // Si on utilise iProyal, aussi initialiser le guard
      proxyExitIp = await initCevProxyGuardWithExitIp(process.env.IPROYAL_PROXY_URL, `cev-dossier-${accountId}`);
    } else {
      logger.warn(`  ⚠️ AUCUN PROXY (SOAX_PROXY_URL et IPROYAL_PROXY_URL absents) — connexion directe`);
    }
  } else {
    logger.info(`  • Proxy: Désactivé (mode sans proxy via hunterConfig)`);
    delete process.env.IPROYAL_PROXY_URL;
    resetCevImpitInstances();
  }

  // applicationId pour les botLogs
  const logApplicationId = accountId;

  if (!vowintEmail || !vowintPassword) {
    logger.error( "Credentials VOWINT manquants dans hunterConfig");
    return;
  }

  // ─── Boucle principale de scan pour ce compte ─────────────────────────────
  const state: LoopState = {
    scanCount: savedScanCount,
    slotsFound: 0,
    rateLimits: 0,
    errors: 0,
    isRunning: false,
    startedAt: 0,
  };

  let nextScanAllowedAt = 0;
  // One-Shot: pas de siphonedCreds ni de gestion F5/full-session.
  // setupCevSessionHttp() réutilise automatiquement la session VOWINT si elle est encore valide (cache 4h).

  state.isRunning = true;
  state.startedAt = Date.now();
  logger.info( "Boucle de scan démarrée");

  while (state.isRunning) {
    try {
      // Respecter le calendrier de scan planifié (anti-spam même en cas de reconnexion/exception)
      const now = Date.now();
      if (now < nextScanAllowedAt) {
        const waitMs = nextScanAllowedAt - now;
        logger.info(`Attente planifiée / de sécurité : ${Math.round(waitMs / 1000)}s restantes...`);
        await sleep(waitMs);
      }

      // Re-check mode toutes les 50 scans
      if (state.scanCount > 0 && state.scanCount % 50 === 0) {
        const stillEnabled = await getBotConfigValue("cev_dossier_mode");
        if (stillEnabled !== "1") {
          logger.info( "Mode dossier désactivé → arrêt");
          state.isRunning = false;
          break;
        }
      }

      // ─── Vérifier si le job est toujours actif toutes les 5 scans ───
      // ET recharger les credentials (ils peuvent avoir changé dans Convex)
      if (state.scanCount % 5 === 0) {
        const latestJobs = await getActiveJobs();
        const latestJob = latestJobs.find((j: any) => j.id === accountId);
        if (!latestJob) {
          logger.info(`🛑 Job ${accountId} (${applicantName}) n'est plus actif → arrêt`);
          state.isRunning = false;
          break;
        }
        // Recharger les credentials si ils ont changé
        const freshEmail = latestJob.hunterConfig?.embassyUsername;
        const freshPassword = latestJob.hunterConfig?.embassyPassword;
        if (freshEmail && freshPassword && (freshEmail !== vowintEmail || freshPassword !== vowintPassword)) {
          logger.info(`🔑 Credentials VOWINT mis à jour depuis Convex (email: ${freshEmail.slice(0, 20)}…)`);
          invalidateVowintCache(vowintEmail); // invalider l'ancien cache
          vowintEmail = freshEmail;
          vowintPassword = freshPassword;
        }
      }

      // ─── Check stop signal (permet d'arrêter même en config automatique) ───
      if (state.scanCount > 0 && state.scanCount % 10 === 0) {
        const stopSignal = await getBotConfigValue("cev_session_stop");
        if (stopSignal === "1") {
          logger.info( "🛑 Signal d'arrêt reçu (cev_session_stop=1) → arrêt gracieux");
          state.isRunning = false;
          break;
        }
      }

      // ─── One-Shot: récupérer le prochain dossier (round-robin) ─────────────
      const dossier = localPool.getNextAvailable();
      if (!dossier) {
        // Tous les dossiers sont en PAUSE (slot déjà trouvé) → attente 30s
        logger.info(`⏸️ Tous les dossiers en pause — attente 30s`);
        await sleep(30_000);
        continue;
      }

      // Scan
      state.scanCount++;
      localPool.checkDailyReset();
      const stats = localPool.getStats();

      logger.info(`[Scan #${state.scanCount}] Dossier: #${dossier.index} ${dossier.vowintRef} | Actifs: ${stats.available}/${stats.total} | Total: ${stats.totalScans} scans`);

      // One-Shot: setupCevSessionHttp réutilise la session VOWINT si encore valide (cache 4h).
      // Si expirée → re-login + captcha automatique.
      const result = await performScan(
        vowintEmail,
        vowintPassword,
        dossier,
        logApplicationId,
        undefined, // pas de siphonedCreds en One-Shot
        0,
        logger,
      );

      // Log chaque scan dans Convex
      botLog({
        applicationId: logApplicationId,
        step: "cev_dossier_scan",
        status: result.status === "error" || result.status === "rate_limited" ? "warn" : "ok",
        data: {
          dossierIndex: dossier.index,
          dossier: `#${dossier.index} ${dossier.vowintRef}`,
          result: result.status,
          scanNumber: state.scanCount,
          poolActive: stats.available,
          poolTotal: stats.total,
        },
      });

      const uniqueJobId = `cev-dossier-${dossier.vowintRef}`;
      switch (result.status) {
        case "slot_found":
          logger.info(`  🚨 SLOT TROUVÉ!`);
          recordScan(uniqueJobId, dossier.vowintRef);
          recordSlotFound(uniqueJobId, dossier.vowintRef);
          await handleSlotFoundMulti(
            vowintEmail, vowintPassword,
            dossier,
            localPool.getAllDossiers(),
            logApplicationId,
            result.sessionCookie, result.integrationUrl,
            logger,
            result.selectSlotHtml,
            result.selectSlotUrl,
            hunterConfig.groupSize,
            result.selectSlotCookies,
            hunterConfig.cevBookingTargetPool, // CSV ou undefined
          );
          break;
        case "rate_limited":
          // Rare en One-Shot, mais possible si serveur répond avec rate-limit
          state.rateLimits++;
          recordScan(uniqueJobId, dossier.vowintRef);
          recordRateLimit(uniqueJobId, dossier.vowintRef, "CEV rate-limit");
          invalidateVowintCache(vowintEmail);
          logger.warn(`  ⚡ Rate-limit inattendu sur #${dossier.index} — invalidation session + pause 5min`);
          await sleep(5 * 60_000);
          break;
        case "error":
          state.errors++;
          recordScan(uniqueJobId, dossier.vowintRef);
          invalidateAnticaptchaCache();
          invalidateVowintCache(vowintEmail);
          logger.warn(`  🔄 Cache VOWINT et Anti-Captcha invalidés — prochain cycle utilisera des credentials frais`);
          break;
        case "no_slot":
          logger.info(`  — Pas de créneau disponible`);
          recordScan(uniqueJobId, dossier.vowintRef);
          localPool.recordClick(dossier);
          break;
        case "no_slot_poll":
          // Chemin legacy (full session) — ne devrait pas arriver en One-Shot
          logger.info(`  — Pas de créneau (poll direct)`);
          recordScan(uniqueJobId, dossier.vowintRef);
          break;

        case "probe_error":
          // Probe échouée (timeout/503/504/réseau) — retry immédiat avec le dossier suivant
          logger.warn(`  ⚡ Probe timeout/erreur sur #${dossier.index} ${dossier.vowintRef} — retry immédiat avec prochain dossier`);
          botLog({
            applicationId: logApplicationId,
            step: "cev_dossier_probe_error_retry",
            status: "warn",
            data: { dossier: dossier.vowintRef, dossierIndex: dossier.index, scanCount: state.scanCount },
          });
          // Petite pause anti-spam (3s) avant de retenter — pas le cycle complet 120s
          nextScanAllowedAt = Date.now() + 3_000;
          continue; // Skip le sleep normal, passer directement au dossier suivant

        case "limit_reached": {
          logger.warn(`  ⚠️ CAS 2 OVERVIEW — Limite de RDV atteinte pour ce dossier ${dossier.vowintRef}`);
          recordScan(uniqueJobId, dossier.vowintRef);
          botLog({
            applicationId: logApplicationId,
            step: "cev_dossier_limit_reached",
            status: "warn",
            data: {
              dossier: dossier.vowintRef,
              dossierIndex: dossier.index,
              scanCount: state.scanCount,
              autoCancelEnabled: !!(hunterConfig as any).cevAutoCancelOnLimitReached,
              overviewHtmlLen: result.overviewHtml?.length ?? 0,
              overviewUrl: result.overviewUrl ?? "",
            },
          });

          if (
            (hunterConfig as any).cevAutoCancelOnLimitReached &&
            result.overviewHtml &&
            result.overviewUrl &&
            result.sessionCookie
          ) {
            logger.info(`  🗑️ Auto-annulation activée — tentative d'annulation du RDV existant...`);
            try {
              const cancelResult = await cancelCevAppointment(
                result.overviewHtml,
                result.overviewUrl,
                result.sessionCookie,
                logApplicationId,
              );
              if (cancelResult.emailSent) {
                logger.info(`  ✅ Annulation réussie (${cancelResult.message?.slice(0, 80) ?? "OK"}) — invalidation session pour re-scan propre`);
                // Invalider la session VOWINT pour forcer un re-login propre au prochain scan
                invalidateVowintCache(vowintEmail);
                botLog({
                  applicationId: logApplicationId,
                  step: "cev_dossier_cancel_success",
                  status: "ok",
                  data: {
                    dossier: dossier.vowintRef,
                    message: cancelResult.message ?? "",
                  },
                });
              } else {
                logger.warn(`  ❌ Auto-annulation échouée: ${cancelResult.error}`);
                botLog({
                  applicationId: logApplicationId,
                  step: "cev_dossier_cancel_failed",
                  status: "fail",
                  data: {
                    dossier: dossier.vowintRef,
                    error: cancelResult.error ?? "unknown",
                  },
                });
              }
            } catch (cancelErr) {
              logger.error(`  Erreur auto-annulation: ${cancelErr}`);
            }
          } else if (!(hunterConfig as any).cevAutoCancelOnLimitReached) {
            logger.info(`  ℹ️ Auto-annulation désactivée — activer cevAutoCancelOnLimitReached dans la config admin pour débloquer ce dossier`);
          }
          break;
        }
      }

      // Stats périodiques
      if (state.scanCount % 25 === 0) {
        const uptimeMin = Math.round((Date.now() - state.startedAt) / 60_000);
        const scansPerHour = uptimeMin > 0 ? Math.round(state.scanCount / (uptimeMin / 60)) : 0;
        const poolStats = localPool.getStats();
        logger.info(`📊 Stats: ${state.scanCount} scans en ${uptimeMin}min (${scansPerHour}/h) | Slots: ${state.slotsFound} | RL: ${state.rateLimits} | Pool: ${poolStats.available}/${poolStats.total}`);
        botLog({
          applicationId: logApplicationId,
          step: "cev_dossier_v3_stats",
          status: "ok",
          data: { scanCount: state.scanCount, slotsFound: state.slotsFound, rateLimits: state.rateLimits, scansPerHour, uptimeMin },
        });
      }

      // ─── Sync pool state vers Redis (fire-and-forget, chaque scan) ──────────
      syncPoolStateToRedis({ ...localPool.exportState(), scanCount: state.scanCount }, redisKey);

      // ─── One-Shot: pause fixe ~2 min avec jitter log-normal (anti-shadow-ban) ──
      const jitterSign = Math.random() < 0.5 ? 1 : -1;
      const jitterAbs = logNormalJitter(20_000, 0.35); // centré ~20s d'écart
      const jitter = jitterSign * Math.min(jitterAbs, intervalMs * 0.3);
      const finalSleepMs = Math.max(60_000, intervalMs + jitter);
      nextScanAllowedAt = Date.now() + finalSleepMs;
      logger.info(`Pause One-Shot: ${Math.round(finalSleepMs / 1000)}s (jitter: ${Math.round(jitter / 1000)}s)`);

    } catch (loopErr) {
      logger.error(`Erreur loop: ${loopErr}`);
      state.errors++;
      
      // Sécurité anti-spam en cas d'erreur consécutive ou de crash (évite de marteler le serveur)
      const safetyPauseMs = 45000;
      nextScanAllowedAt = Math.max(nextScanAllowedAt, Date.now() + safetyPauseMs);
      logger.info(`Erreur détectée. Prochain scan planifié au plus tôt dans ${Math.round((nextScanAllowedAt - Date.now()) / 1000)}s.`);
    }
  }

  logger.info( "═══ CEV Dossier Loop v3 arrêté ═══");
}


/** Expose l'�tat pour monitoring */
export function getCevDossierState() {
  return { ...state, pool: null };
}





