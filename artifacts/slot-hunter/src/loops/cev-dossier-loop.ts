/**
 * CEV Dossier Loop v3 — Pool de DOSSIERS (pas d'IPs)
 *
 * STRATÉGIE :
 *   La limite des 5 clics/heure est PAR DOSSIER (AppId), pas par IP ni par compte.
 *   → On utilise N dossiers en rotation round-robin sur 1 seule IP SOAX.
 *   → 5 dossiers × 5 clics/h = 25 scans/heure = 1 scan toutes les ~2.5 min
 *
 * ARCHITECTURE :
 *   - 1 seule IP proxy (SOAX Kinshasa, sticky session 5min)
 *   - N dossiers VOWINT (configurés via bot-config "cev_dossier_pool")
 *   - Rotation round-robin entre les dossiers
 *   - Chaque dossier a son propre compteur de clics (5/h max)
 *   - Quand un dossier détecte un slot → booking immédiat avec CE dossier
 *
 * CONFIG Convex (bot-config) :
 *   cev_dossier_mode = "1"                  → activer ce loop
 *   cev_dossier_pool = "VOWINT6085888,VOWINT6085889,VOWINT6085890"
 *   cev_dossier_interval_sec = "30"         → pause entre chaque scan (défaut: calculé auto)
 *
 * IMPORTANT : MUTUELLEMENT EXCLUSIF avec cev-stealth-loop (v2 IP pool).
 */

import { setupCevSessionHttp, invalidateVowintCache, invalidateAnticaptchaCache, resolveFirstAppIdFromMyList } from "../cevHttpSetup.js";
import { bookCevViaHttp } from "../cevHttpBooking.js";
import { bookWithExistingSession } from "../cevBooking.js";
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
        page.click('[type="submit"], button[type="submit"], input[value="Login"], input[value="Log in"]'),
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

const MAX_CLICKS_PER_SESSION = 5; // Limite GLOBALE par session VOWINT (serveur bloque au 6ème)
const MAX_CLICKS_PER_DOSSIER_PER_HOUR = 5; // Vraie limite serveur CEV (vérifiée)
const CLICK_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const DEFAULT_INTERVAL_SEC = 150; // Pause par défaut — calibrée pour 3 dossiers × 5 clics × 80% = 150s

// Compteur GLOBAL de clics sur la session VOWINT courante
let globalSessionClicks = 0;

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

  /** Retourne le prochain dossier disponible (quota non épuisé) */
  getNextAvailable(): DossierSlot | null {
    if (this.slots.length === 0) return null;
    const now = Date.now();
    const startIndex = this.currentIndex;

    for (let attempts = 0; attempts < this.slots.length; attempts++) {
      const idx = (startIndex + attempts) % this.slots.length;
      const slot = this.slots[idx];

      // Purger les clics > 1 heure
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);

      // Vérifier quota
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
        // Vérifier si le dossier est en pause (slot trouvé précédemment)
        if (pausedDossiers.has(slot.vowintRef)) {
          this.logger.info(`  ⏸️ #${slot.index} ${slot.vowintRef} en PAUSE (slot trouvé) — skip`);
          continue;
        }
        this.currentIndex = (idx + 1) % this.slots.length;
        return slot;
      }

      // Dossier épuisé — loguer le skip
      if (attempts === 0 || this.slots.length <= 3) {
        const oldestClick = slot.clickTimestamps[0];
        const availableInMin = Math.ceil((oldestClick + CLICK_WINDOW_MS - now) / 60_000);
        this.logger.info(`  ⏭️ #${slot.index} ${slot.vowintRef} épuisé (${slot.clickTimestamps.length}/${MAX_CLICKS_PER_DOSSIER_PER_HOUR}) — dispo dans ${availableInMin}min`);
      }
    }

    return null; // Tous les dossiers sont épuisés
  }

  /** Enregistre un clic sur un dossier */
  recordClick(slot: DossierSlot): void {
    slot.clickTimestamps.push(Date.now());
    slot.totalScans++;
  }

  /** Marque un dossier comme rate-limité (tous ses clics comptés) */
  markRateLimited(slot: DossierSlot): void {
    // Remplir les clics pour bloquer ce dossier pendant 1h
    const now = Date.now();
    while (slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS).length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
      slot.clickTimestamps.push(now);
    }
    slot.rateLimitCount++;
    this.logger.warn(`Dossier #${slot.index} ${slot.vowintRef} rate-limité (${slot.rateLimitCount}x)`);
  }

  /** Temps d'attente avant qu'un dossier soit disponible */
  getNextAvailableIn(): number {
    const now = Date.now();
    let minWait = Infinity;

    for (const slot of this.slots) {
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
        return 0;
      }
      // Quand le plus ancien clic expire
      const oldest = slot.clickTimestamps[0];
      const availableAt = oldest + CLICK_WINDOW_MS;
      minWait = Math.min(minWait, availableAt - now);
    }

    return minWait === Infinity ? 60_000 : minWait;
  }

  /** Stats du pool */
  getStats(): { total: number; available: number; exhausted: number; totalScans: number } {
    const now = Date.now();
    let available = 0;
    let totalScans = 0;

    for (const slot of this.slots) {
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) available++;
      totalScans += slot.totalScans;
    }

    return {
      total: this.slots.length,
      available,
      exhausted: this.slots.length - available,
      totalScans,
    };
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
  status: "no_slot" | "slot_found" | "rate_limited" | "error" | "no_slot_poll";
  sessionCookie?: string;
  integrationUrl?: string;
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
}

/** Construit le cookie header complet depuis les données de session */
function buildFullSessionCookieStr(s: SiphonedCreds): string {
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

  // Clic réussi — enregistrer
  globalSessionClicks++;

  if (result.slotsAvailable) {
    return {
      status: "slot_found",
      sessionCookie: result.sessionCookie,
      integrationUrl: result.integrationUrl,
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

  return { status: "no_slot" };
}

// ─── Booking ────────────────────────────────────────────────────────────────

import { discoverSlotBookingFlow, sendSlotDetectedEmail } from "../cev-slot-discovery.js";

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

  // ── DISCOVERY : capturer TOUT le flow avec la session EXISTANTE ──
  // Pas de re-login ! On utilise la session qui vient de détecter le slot.
  // Le slot ne peut pas disparaître entre la détection et la capture.
  const sessionCookie = existingSessionCookie;
  const integrationUrl = existingIntegrationUrl;

  if (sessionCookie && integrationUrl) {
    logFn.info(`  🔬 Discovery avec session existante (pas de re-login)...`);

    const discovery = await discoverSlotBookingFlow(
      sessionCookie,
      integrationUrl,
      dossier.vowintRef,
      applicationId,
    );

    // Envoyer email admin
    logFn.info(`  📧 Envoi email admin...`);
    await sendSlotDetectedEmail(dossier.vowintRef, discovery);

    // Tenter le booking HTTP avec la session existante
    logFn.info(`  🎯 Tentative booking HTTP avec session existante...`);
    try {
      const httpResult = await bookCevViaHttp(integrationUrl, sessionCookie!, applicationId, siphoned);
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
      logFn.info(`  ⚠️ Booking HTTP échoué: ${httpResult.error} — tentative avec re-login...`);
    } catch (err) {
      logFn.warn(`  ⚠️ Booking HTTP crash: ${err} — tentative avec re-login...`);
    }
  }

  // ── FALLBACK : re-login + nouveau setup (si session existante a échoué) ──
    logFn.info(`  🔄 Re-login pour tentative fallback...`);
    const session = await setupCevSessionHttp(
      vowintEmail,
      vowintPassword,
      applicationId,
      applicationId,
      dossier.vowintRef,
      siphoned,
    );

  if (!session.success || !session.sessionCookie || !session.integrationUrl) {
    logFn.error(`  Session re-setup échoué pour booking fallback`);
    return;
  }

  // Tentative booking HTTP avec session fraîche
  try {
    const httpResult = await bookCevViaHttp(session.integrationUrl!, session.sessionCookie!, applicationId, siphoned);
    if (httpResult.success) {
      logFn.info(`  ✅ BOOKING RÉUSSI (re-login)! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
      await reportSlotFound({
        applicationId,
        date: httpResult.bookedDate ?? "",
        time: httpResult.bookedTime ?? "",
        location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
        confirmationCode: httpResult.confirmationCode,
      });
      return;
    }

    // Fallback Playwright
    logFn.info(`  HTTP insuffisant — fallback Playwright...`);
    const pwResult = await bookWithExistingSession(
      session.integrationUrl,
      session.sessionCookie,
      applicationId,
    );
    if (pwResult.success) {
      logFn.info(`  ✅ BOOKING PLAYWRIGHT RÉUSSI! code=${pwResult.confirmationCode}`);
      await reportSlotFound({
        applicationId,
        date: pwResult.bookedDate ?? "",
        time: pwResult.bookedTime ?? "",
        location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
        confirmationCode: pwResult.confirmationCode,
        screenshotStorageId: pwResult.screenshotStorageId,
      });
    } else {
      logFn.error(`  ❌ Booking échoué: ${pwResult.error}`);
    }
  } catch (err) {
    logFn.error(`  💥 Crash booking: ${err}`);
  }
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
  logger.info(`  • Clics/h total: ${localPool.size * MAX_CLICKS_PER_DOSSIER_PER_HOUR}`);
  logger.info(`  • Intervalle: ${Math.round(intervalMs / 1000)}s (1 scan toutes les ${Math.round(intervalMs / 1000)}s)`);

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
  let globalSessionClicks = 0;
  let siphonedCreds: SiphonedCreds | undefined = undefined;
  
  let lastF5CookieCapturedAt = 0;
  // F5-only mode : 30min. Full session mode : 4h (session CEV expire en 4h)
  const F5_COOKIE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
  const FULL_SESSION_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

  // Récupérer les credentials siphonnés depuis le job's hunterConfig
  const hc = job.hunterConfig as any;
  if (hc?.cevSiphonedF5CookieValue) {
    siphonedCreds = {
      f5CookieValue: hc.cevSiphonedF5CookieValue,
      f5CookieName: hc.cevSiphonedF5CookieName,
      aspNetSessionId: hc.cevSiphonedAspNetSessionId,
      userAgent: hc.cevSiphonedUserAgent,
      validUntil: hc.cevSiphonedValidUntil,
      siphonedAt: hc.cevSiphonedAt,
    };
    logger.info(`🍪 Cookies siphonnés chargés depuis hunterConfig: F5=${!!siphonedCreds.f5CookieValue}, ASP.NET=${!!siphonedCreds.aspNetSessionId}`);
    
    if (siphonedCreds.userAgent) {
      setCevExternalUserAgent(siphonedCreds.userAgent);
    }
  } else {
    logger.info( "🍪 Pas de cookies siphonnés dans hunterConfig");
  }

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

      // ─── Capturer session (mode F5 legacy ou full session) ──────────────────
      const nowTime = Date.now();

      // Lire le mode depuis botConfig (mis en cache 50 scans)
      let fullPuppeteerMode = false;
      if (state.scanCount % 50 === 0 || state.scanCount === 0) {
        const modeVal = await getBotConfigValue("cev_full_puppeteer_mode");
        fullPuppeteerMode = modeVal === "1";
      } else {
        // Réutiliser la valeur précédente — détecter si isFullSession déjà actif
        fullPuppeteerMode = !!siphonedCreds?.isFullSession;
      }

      const refreshInterval = fullPuppeteerMode
        ? FULL_SESSION_REFRESH_INTERVAL_MS
        : F5_COOKIE_REFRESH_INTERVAL_MS;

      const needsRefresh =
        !siphonedCreds ||
        nowTime - lastF5CookieCapturedAt > refreshInterval ||
        (siphonedCreds.validUntil && nowTime > siphonedCreds.validUntil);

      if (needsRefresh) {
        if (fullPuppeteerMode) {
          // ── MODE FULL SESSION : login + captcha complet via Puppeteer ─────
          logger.info(`🔐 Capture SESSION COMPLÈTE pour ${applicantName} (mode full-puppeteer)…`);
          
          // Trouver le premier dossier disponible pour la capture
          const targetDossier = localPool.getNextAvailable() ?? { vowintRef: dossiers[0] ?? "" };
          
          const fullSession = await captureFullSessionForAccount(
            accountId,
            vowintEmail,
            vowintPassword,
            targetDossier.vowintRef,
            logger,
            job.hunterConfig,
          );

          if (fullSession) {
            // Stocker dans le session manager
            cevSessionManager.storeSession(accountId, fullSession);

            // Convertir en siphonedCreds étendu
            siphonedCreds = {
              ...fullSessionToSiphoned(fullSession),
            };
            lastF5CookieCapturedAt = nowTime;
            setCevExternalUserAgent(fullSession.userAgent);
            logger.info(`✅ Session complète en cache (expire dans 4h) — appId=${fullSession.appId.slice(0, 12)}…`);
          } else {
            logger.warn(`❌ Capture session complète échouée — fallback mode F5 dans 2min…`);
            await sleep(2 * 60 * 1000);
            continue;
          }
        } else {
          // ── MODE LEGACY : capture F5 cookie uniquement ────────────────────
          logger.info(`🍪 Capture cookie F5 pour ${applicantName}…`);
          const f5Cookie = await captureF5CookieForAccount(accountId, logger, job.hunterConfig);

          if (f5Cookie) {
            const injectSuccess = await injectApplicationF5Cookies(
              accountId,
              f5Cookie.f5CookieValue,
              undefined,
              f5Cookie.userAgent,
              { f5CookieName: f5Cookie.f5CookieName, validityMinutes: 60 },
            );

            if (injectSuccess) {
              siphonedCreds = {
                f5CookieValue: f5Cookie.f5CookieValue,
                f5CookieName: f5Cookie.f5CookieName,
                userAgent: f5Cookie.userAgent,
                validUntil: nowTime + 60 * 60 * 1000,
                siphonedAt: nowTime,
              };
              lastF5CookieCapturedAt = nowTime;
              setCevExternalUserAgent(f5Cookie.userAgent);
              logger.info(`✅ Cookie F5 capturé et injecté pour ${applicantName}`);
            } else {
              logger.warn(`❌ Injection cookie F5 Convex échouée`);
            }
          } else {
            logger.warn(`❌ Capture cookie F5 échouée — réessaie dans 2min…`);
            await sleep(2 * 60 * 1000);
            continue;
          }
        }
      }
      
      // Double check we have cookies before scanning
      if (!siphonedCreds) {
        logger.warn(`❌ Toujours pas de cookies F5 — réessaie dans 2min...`);
        await sleep(2 * 60 * 1000);
        continue;
      }

      // Récupérer le prochain dossier disponible
      const dossier = localPool.getNextAvailable();
      if (!dossier) {
        const waitMs = localPool.getNextAvailableIn();
        const waitMin = Math.ceil(waitMs / 60_000);
        const stats = localPool.getStats();
        logger.info(`⏳ Tous les dossiers épuisés (${stats.exhausted}/${stats.total}) — attente ${waitMin} min`);
        // Attente réduite: max 2 min au lieu de 5 min
        await sleep(Math.min(waitMs + 5000, 2 * 60_000));
        continue;
      }

      // Scan
      state.scanCount++;
      
      // Vérifier et reset les compteurs quotidiens
      localPool.checkDailyReset();
      
      const stats = localPool.getStats();

      // ─── Intervalle DYNAMIQUE basé sur les dossiers réellement actifs ──────
      // Formule : capacité max (s/scan) divisée par 0.8 pour utiliser 80% du quota
      // → jamais de burst, jamais d'épuisement, jamais de pause forcée
      // Exemple : 6 dossiers × 5 clics/h → max=120s → safe=150s → 24 scans/h uniforme
      const activeDossiers = stats.available - pausedDossiers.size;
      const dynamicIntervalMs = activeDossiers > 0
        ? Math.ceil((3600 / (activeDossiers * MAX_CLICKS_PER_DOSSIER_PER_HOUR)) / 0.8 * 1000)
        : intervalMs;
      // Utiliser le PLUS GRAND des deux : dynamique est un plancher de sécurité,
      // l'utilisateur peut configurer un intervalle plus long via cevScanIntervalSec
      const effectiveIntervalMs = Math.max(intervalMs, dynamicIntervalMs);

      logger.info(`[Scan #${state.scanCount}] Dossier: #${dossier.index} ${dossier.vowintRef} | Dispo: ${stats.available}/${stats.total} | Total: ${stats.totalScans} scans`);

      const result = await performScan(
        vowintEmail,
        vowintPassword,
        dossier,
        logApplicationId,
        siphonedCreds,
        0,
        logger,
      );

      // Log chaque scan dans Convex avec le dossier concerné
      botLog({
        applicationId: logApplicationId,
        step: "cev_dossier_scan",
        status: result.status === "error" || result.status === "rate_limited" ? "warn" : "ok",
        data: {
          dossierIndex: dossier.index,
          dossier: `#${dossier.index} ${dossier.vowintRef}`,
          result: result.status,
          scanNumber: state.scanCount,
          poolAvailable: stats.available,
          poolTotal: stats.total,
        },
      });

      const uniqueJobId = `cev-dossier-${dossier.vowintRef}`;
      switch (result.status) {
        case "slot_found":
          logger.info(`  🚨 SLOT TROUVÉ!`);
          recordScan(uniqueJobId, dossier.vowintRef);
          recordSlotFound(uniqueJobId, dossier.vowintRef);
          // Réinitialiser compteur no-slots (slot trouvé = pas de shadow ban)
          if (siphonedCreds?.isFullSession) cevSessionManager.resetNoSlots(accountId);
          // Re-login préventif si on atteint la limite (avant le booking)
          if (globalSessionClicks >= MAX_CLICKS_PER_SESSION) {
            logger.info(`  🔄 Session VOWINT: ${globalSessionClicks}/${MAX_CLICKS_PER_SESSION} clics — re-login préventif`);
            invalidateVowintCache(vowintEmail);
            globalSessionClicks = 0;
            recordRelogin(uniqueJobId, dossier.vowintRef, "preventive");
          }
          await handleSlotFound(
            vowintEmail, vowintPassword, dossier, logApplicationId,
            result.sessionCookie, result.integrationUrl,
            siphonedCreds,
            logger,
          );
          break;
        case "rate_limited":
          state.rateLimits++;
          recordScan(uniqueJobId, dossier.vowintRef);
          recordRateLimit(uniqueJobId, dossier.vowintRef, "CEV 5 clics/h");
          localPool.markRateLimited(dossier);
          // Le rate-limit vient du serveur → session grillée, reset le compteur
          globalSessionClicks = 0;
          logger.warn(`  ⚡ Rate-limit sur #${dossier.index} ${dossier.vowintRef} — rotation vers prochain dossier`);
          break;
        case "error":
          state.errors++;
          recordScan(uniqueJobId, dossier.vowintRef);
          invalidateAnticaptchaCache();
          invalidateVowintCache(vowintEmail);
          globalSessionClicks = 0;
          // En mode full session : invalider aussi le cache session (session CEV expirée)
          if (siphonedCreds?.isFullSession) {
            cevSessionManager.invalidate(accountId);
            siphonedCreds = undefined;
            lastF5CookieCapturedAt = 0;
            logger.warn(`  🔄 Session complète invalidée — re-capture au prochain tour`);
          } else {
            logger.warn(`  🔄 Cache VOWINT et Anti-Captcha invalidés — prochain scan utilisera des credentials frais`);
          }
          break;
        case "no_slot":
          logger.info(`  — Pas de créneau (clic VOWINT consommé)`);
          recordScan(uniqueJobId, dossier.vowintRef);
          localPool.recordClick(dossier);
          globalSessionClicks++;
          if (globalSessionClicks >= MAX_CLICKS_PER_SESSION) {
            logger.info(`  🔄 Session VOWINT: ${globalSessionClicks}/${MAX_CLICKS_PER_SESSION} clics — re-login préventif`);
            invalidateVowintCache(vowintEmail);
            globalSessionClicks = 0;
            recordRelogin(uniqueJobId, dossier.vowintRef, "preventive");
          }
          break;
        case "no_slot_poll":
          // Mode full session : poll direct — AUCUN clic VOWINT consommé
          logger.info(`  — Pas de créneau (poll direct, pas de clic VOWINT)`);
          recordScan(uniqueJobId, dossier.vowintRef);
          // Shadow ban detection : N no-slots consécutifs → invalider la session
          {
            const shadowBanned = cevSessionManager.recordNoSlots(accountId);
            if (shadowBanned) {
              logger.warn(`  🚫 Shadow ban détecté — session complète invalidée → re-capture dans 2min`);
              siphonedCreds = undefined;
              lastF5CookieCapturedAt = 0;
              await sleep(2 * 60_000);
            }
          }
          break;
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

      // Pause entre les scans (intervalle dynamique)
      // Mode full session : intervalle réduit (30-60s) car pas de clics VOWINT consommés
      // Mode legacy : intervalle dynamique basé sur la capacité du pool
      let baseIntervalMs = effectiveIntervalMs;
      if (siphonedCreds?.isFullSession) {
        // Poll rapide : 30-60s (log-normal, centré 45s)
        baseIntervalMs = Math.max(20_000, logNormalJitter(45_000, 0.3));
      }
      // Jitter log-normal (anti-shadow ban — distribution réaliste vs uniform Math.random)
      const jitterSign = Math.random() < 0.5 ? 1 : -1;
      const jitterAbs = logNormalJitter(siphonedCreds?.isFullSession ? 10_000 : 25_000, 0.4);
      const jitter = jitterSign * Math.min(jitterAbs, baseIntervalMs * 0.4);
      const finalSleepMs = Math.max(10_000, baseIntervalMs + jitter);
      nextScanAllowedAt = Date.now() + finalSleepMs;
      logger.info(`Pause de ${Math.round(finalSleepMs / 1000)}s planifiée avant le prochain scan (jitter: ${Math.round(jitter / 1000)}s)`);

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





