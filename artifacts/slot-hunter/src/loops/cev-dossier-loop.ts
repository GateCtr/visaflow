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
import { pollCevSlot } from "../cevPolling.js";
import { cancelCevAppointment } from "../cevHttpCancel.js";
import { bookCevViaHttp, extractInlineSlotsFromHtml } from "../cevHttpBooking.js";
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
  makeCevDecodoStickyUrl,
} from "../cev-shared-impit.js";
import {
  getPendingCevSetups,
  getActiveCevSessions,
  getCevCredentials,
  recordCevSessionCheck,
  reportSlotFound,
  reportSlotDiscoveryBatch,
  type SlotDiscoveryEvent,
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
  acquireCevScanLock,
  releaseCevScanLock,
  tryClaimCevSlot,
  releaseCevSlot,
  reserveCevIp,
  releaseCevIp,
  type SerializablePoolState,
} from "../cev-redis-persistence.js";
import { buildCevSlotAssignment, parseCevDossierDeadlines, resolveCevDeadline, hasSlotWithinDeadline, type CevSlotCandidate } from "../cev-slot-assignment.js";
import { recordScan, recordSlotFound, recordRateLimit, recordRelogin, recordPause } from "../daily-stats.js";
import { createLogger } from "../logger.js";
import { cevSessionManager, fullSessionToSiphoned, type FullCevSession } from "../cev-session-manager.js";
import { solveHcaptchaWithProxy, parseProxyForAnticaptcha } from "../cev-hcaptcha.js";
import { getCevDecodoUrlForAccount, getCevDecodoUrlForIndex, hasCevDecodoProxy, getCevDecodoPoolSize } from "../cev-decodo-pool.js";
import { getCevScheduleDecision } from "../cev-schedule.js";

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
    rawUrl = makeCevProxyStickyUrl("soax", undefined, `cev-account-${accountId}`);
  } else if (process.env.IPROYAL_PROXY_URL) {
    rawUrl = makeCevProxyStickyUrl("iproyal", undefined, `cev-account-${accountId}`);
  } else if (hasCevDecodoProxy()) {
    rawUrl = getCevDecodoUrlForAccount(accountId) ?? "";
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

// ── One-Shot (Predator) ────────────────────────────────────────────────────
// Stratégie : 1 réveil par intervalle → 1 clic par dossier → fermeture → sleep
// Session VOWINT réutilisée si encore valide (cache 4h dans cevHttpSetup)
// NB : le quota MAX_CLICKS_PER_HOUR (4/dossier) est le garde-fou dur ; l'intervalle
// (cev-schedule) espace les scans. Pour que l'intervalle soit respecte sans etre coupe
// par le quota, il faut assez de formulaires : N >= 720 / intervalSec (5/h/formulaire).
const DEFAULT_INTERVAL_SEC = 60; // 60s par défaut (configurable via cevScanIntervalSec)

// ── Synchronisation sur grille d'horloge murale (porté de spain-wallclock-grid) ──
//
// Objectif : tous les comptes CEV détectent les créneaux dans la MÊME fenêtre de
// tick. Au lieu d'un sleep relatif (qui dérive), chaque compte dort jusqu'au
// prochain front absolu `ceil(now/tick)*tick` — l'horloge devient une barrière
// commune sans coordination centrale. Un jitter déterministe par compte casse le
// pattern régulier sans casser l'alignement.
const GRID_TICK_FLOOR_MS = 1_000;
const GRID_TICK_CEIL_MS = 3_600_000;

/**
 * Pourcentage de jitter appliqué au front de grille (fraction du tick), borné [0, 0.5].
 * Défaut faible (0.02 = ±3.6s à tick 180s) : les comptes tournent sur des IP + sessions
 * + AppId DISTINCTS, donc pas de justification anti-détection INTER-comptes. On veut au
 * contraire qu'ils frappent dans la MÊME fenêtre de vague (± quelques secondes) pour
 * capter la même publication et se répartir les créneaux. Le micro-jitter évite seulement
 * un pic à la milliseconde exacte si beaucoup de comptes. Mettre 0 pour synchro maximale.
 * Configurable via CEV_GRID_JITTER_PCT.
 */
const CEV_GRID_JITTER_PCT = ((): number => {
  const v = Number(process.env.CEV_GRID_JITTER_PCT ?? "0.02");
  if (!Number.isFinite(v)) return 0.02;
  return Math.min(0.5, Math.max(0, v));
})();

/**
 * Seuil du mode RACE : quand le nombre de créneaux distincts détectés est ≤ ce seuil,
 * on SKIP le claim Redis et tous les comptes foncent (le serveur CEV arbitre).
 * Évite qu'un compte attende poliment pendant qu'un concurrent rafle le seul créneau.
 * Configurable via CEV_RACE_MODE_SLOT_THRESHOLD, défaut 5, borné [1, 10000].
 */
const CEV_RACE_MODE_SLOT_THRESHOLD = ((): number => {
  const v = Number(process.env.CEV_RACE_MODE_SLOT_THRESHOLD ?? "5");
  if (!Number.isFinite(v)) return 5;
  return Math.min(10000, Math.max(1, Math.round(v)));
})();

/** Seed déterministe (FNV-1a) dérivé de l'accountId — jitter reproductible par compte. */
function gridSeedFromAccount(accountId: string): number {
  let h = 2166136261;
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Délai (ms) jusqu'au prochain front de grille absolu, jitter déterministe inclus.
 * Fonction pure — `nowMs` injecté.
 *
 * ALIGNEMENT ABSOLU (fix 2026-09-03) : tous les comptes visent le MÊME front de grille
 * absolu `ceil(now/tick)*tick`, indépendant de leur dernier scan → ils frappent ensemble.
 *
 * Le front absolu est calculé sur `now` (PAS `now + tick`). Ainsi, deux comptes dont les
 * horloges sont proches (à quelques secondes près) résolvent le MÊME front → alignement
 * préservé. Un plancher `now + tick` (version précédente) cassait ça : chaque compte
 * ajoutait son propre tick à son propre `now`, les poussant sur des fronts différents
 * → écart d'un tick entier entre comptes. C'était le bug de l'écart d'une minute.
 *
 * Respect de l'intervalle : le front absolu est naturellement à `[0, tick)` de `now`.
 * Si le front est TROP proche (< MIN_LEAD_MS, ex. `now` juste avant un front → sleep de
 * quelques secondes), on décale au front SUIVANT — mais cette décision, prise sur le
 * front absolu commun, est identique pour tous les comptes proches → ils restent alignés.
 * Le jitter déterministe (±jitterPct·tick) casse la régularité sans casser l'alignement.
 *
 * @param nowMs      horloge murale (ms epoch)
 * @param tick       intervalle de grille (ms), borné à [1000, 3600000]
 * @param workerSeed seed déterministe du compte (gridSeedFromAccount)
 */
function cevMsUntilNextTick(nowMs: number, tick: number, workerSeed: number): number {
  const effTick = Math.min(GRID_TICK_CEIL_MS, Math.max(GRID_TICK_FLOOR_MS, Math.round(tick)));
  // Front absolu commun à tous les comptes (barrière de synchronisation).
  let nextFront = Math.ceil(nowMs / effTick) * effTick;
  // Si le front est trop proche (sleep quasi nul), viser le front suivant — décision
  // basée sur le front ABSOLU, donc identique pour tous les comptes proches (reste aligné).
  const MIN_LEAD_MS = Math.min(5_000, Math.floor(effTick / 2));
  if (nextFront - nowMs < MIN_LEAD_MS) nextFront += effTick;
  const jitterMax = Math.floor(CEV_GRID_JITTER_PCT * effTick);
  const seedInt = Math.abs(Math.trunc(workerSeed));
  const jitter = jitterMax > 0 ? (seedInt % (2 * jitterMax + 1)) - jitterMax : 0;
  const target = nextFront + jitter;
  return Math.max(0, Math.round(target - nowMs));
}
const CLICK_WINDOW_MS = 60 * 60 * 1000;

// ── Quota de clics « Prendre rendez-vous » — contrainte serveur CEV ─────────
//
// L'architecture CEV interdit tout polling : une session est réputée CONSOMMÉE
// dès l'appel GetEAppointmentUrl. Si la réponse est « no availability », elle
// expire immédiatement — les 15 min de validUntil ne servent qu'au booking, et
// quitter la page tue la session. Chaque vérification coûte donc obligatoirement
// un cycle complet : login VOWINT → clic → captcha → Integration/VOW.
//
// Le serveur limite ces clics à 5/heure/dossier (confirme en prod : blocage a 5) ;
// on s'arrete a 4 pour garder une marge (un rate-limit VOWINT bloque le dossier
// bien plus longtemps qu'un simple skip). Le compteur est consulte AVANT chaque
// tentative : un dossier deja a 4 est conserve tel quel, aucun clic n'est emis,
// on passe au suivant. Pour respecter l'intervalle de cev-schedule sans etre coupe
// par ce quota, dupliquer les formulaires : N >= 720 / intervalSec (5/h/formulaire).
const MAX_CLICKS_PER_HOUR = 4;

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

  /** Purge les clics sortis de la fenêtre glissante et retourne ceux restants. */
  private recentClicks(slot: DossierSlot): number {
    const now = Date.now();
    slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
    return slot.clickTimestamps.length;
  }

  /** true si ce dossier peut encore émettre un clic « Prendre rendez-vous ». */
  hasClickBudget(slot: DossierSlot): boolean {
    return this.recentClicks(slot) < MAX_CLICKS_PER_HOUR;
  }

  /** Clics restants dans l'heure glissante pour ce dossier. */
  remainingClicks(slot: DossierSlot): number {
    return Math.max(0, MAX_CLICKS_PER_HOUR - this.recentClicks(slot));
  }

  /** Délai (ms) avant que ce dossier retrouve un clic ; 0 s'il en a déjà un. */
  clickAvailableIn(slot: DossierSlot): number {
    if (this.hasClickBudget(slot)) return 0;
    const oldest = Math.min(...slot.clickTimestamps);
    return Math.max(0, CLICK_WINDOW_MS - (Date.now() - oldest) + 1_000);
  }

  /**
   * Retourne le prochain dossier réellement cliquable (round-robin + quota).
   *
   * Le quota est vérifié ICI, avant toute consommation de session : un dossier
   * saturé n'est pas mis en attente, il est simplement sauté au profit du
   * suivant — le pool continue donc de scanner sans perdre de cycle.
   */
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
      if (!this.hasClickBudget(slot)) {
        const waitMin = Math.ceil(this.clickAvailableIn(slot) / 60_000);
        this.logger.info(
          `  🚦 #${slot.index} ${slot.vowintRef} — quota ${MAX_CLICKS_PER_HOUR}/h atteint ` +
          `(clic dispo dans ~${waitMin}min) — skip, dossier suivant`,
        );
        this.currentIndex = (idx + 1) % this.slots.length;
        continue;
      }
      this.currentIndex = (idx + 1) % this.slots.length;
      return slot;
    }

    return null; // Tous en pause ou tous à court de quota
  }

  /**
   * Dossiers mobilisables immédiatement (mode surcharge) : ni en pause, ni à
   * court de quota. Le dossier passé en `exclude` (déjà tenté) est retiré.
   */
  getEligibleForBurst(exclude?: DossierSlot): DossierSlot[] {
    return this.slots.filter(
      s => s !== exclude && !pausedDossiers.has(s.vowintRef) && this.hasClickBudget(s),
    );
  }

  /** Enregistre un clic « Prendre rendez-vous » réellement consommé côté CEV. */
  recordClick(slot: DossierSlot): void {
    slot.clickTimestamps.push(Date.now());
    slot.totalScans++;
  }

  /** Délai (ms) avant qu'un dossier quelconque du pool redevienne cliquable. */
  getNextAvailableIn(): number {
    const candidates = this.slots.filter(s => !pausedDossiers.has(s.vowintRef));
    if (candidates.length === 0) return 30_000;
    return Math.min(...candidates.map(s => this.clickAvailableIn(s)));
  }

  /** Stats du pool */
  getStats(): { total: number; available: number; exhausted: number; totalScans: number } {
    let totalScans = 0;
    for (const slot of this.slots) totalScans += slot.totalScans;
    const active = this.slots.filter(
      s => !pausedDossiers.has(s.vowintRef) && this.hasClickBudget(s),
    ).length;
    return {
      total: this.slots.length,
      available: active,
      exhausted: this.slots.length - active,
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

    // Les pausedDossiers ne sont PAS restaurés depuis Redis — c'est de l'état runtime transitoire.
    // Si un booking a échoué avant le redémarrage, le dossier doit scanner de nouveau.
    // Si un booking a réussi, le dossier est terminé de toute façon.

    this.logger.info(`Pool restauré depuis Redis (index=${this.currentIndex}, paused=0 — pauses non restaurées)`);
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

// ─── Erreurs réseau transitoires (surcharge serveur CEV) ────────────────────
//
// Contexte réel (publication de créneaux, 2026-08-13) : quand le portail belge
// est saturé, il ne renvoie pas une erreur applicative mais coupe la connexion —
// « tls handshake eof », « Connection reset by peer », 502/503/504. Un opérateur
// humain, lui, ferme l'onglet et reclique immédiatement sur « Prendre rendez-vous »
// jusqu'à passer. Le bot faisait l'inverse : il traitait ça comme une erreur de
// setup, invalidait ses caches et dormait 60-78 s — c'est-à-dire précisément
// pendant la fenêtre où les créneaux sont publiés puis raflés.
//
// Ces erreurs sont donc classées à part : retry rapide, aucun clic VOWINT
// consommé (recordClick n'est pas appelé), aucune invalidation de session
// (le login n'a jamais échoué — la couche TCP/TLS n'a même pas abouti).
const TRANSIENT_NETWORK_PATTERNS: RegExp[] = [
  /tls handshake eof/i,
  /unexpectedeof/i,
  /connectionreset/i,
  /connection reset by peer/i,
  /econnreset|econnaborted|econnrefused|epipe|etimedout|enetunreach|ehostunreach/i,
  /broken pipe/i,
  /failed to connect to the server/i,
  /hyper_util::client::legacy::Error/i,
  /operation was aborted due to timeout/i,
  /\btimed? ?out\b/i,
  /\baborted\b/i,
  /socket hang up/i,
  /dns error/i,
  /\bERROR_(?:502|503|504)\b/i,
  /\bHTTP (?:502|503|504)\b/i,
  /\b(?:502|503|504)\b.*\b(?:bad gateway|unavailable|gateway time)/i,
  /bad gateway|service unavailable|gateway time-?out/i,
];

/** true si l'erreur traduit une saturation/coupure réseau côté CEV, pas un échec logique. */
function isTransientNetworkError(err: string | undefined): boolean {
  if (!err) return false;
  return TRANSIENT_NETWORK_PATTERNS.some((re) => re.test(err));
}

// ─── Core: un scan avec un dossier spécifique ───────────────────────────────

interface ScanResult {
  status: "no_slot" | "slot_found" | "rate_limited" | "error" | "no_slot_poll" | "limit_reached" | "probe_error" | "transient_error";
  /** Message d'erreur brut — renseigné pour 'error' et 'transient_error'. */
  error?: string;
  /**
   * Cause de l'échec probe (status='probe_error') :
   *   'session_expired' — SessionExpired détecté pendant les retries redirectUrl → refaire GetEAppointmentUrl
   *   'transient'       — 504/réseau pur → retry si quota non épuisé
   */
  probeErrorType?: "transient" | "session_expired";
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
  /** URL proxy Decodo dédié à ce compte — transmis à setup et polling pour isolation par IP */
  accountProxyUrl?: string,
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
    const pollResult = await pollCevSlot(siphoned.integrationUrl, cookieStr, siphoned, accountProxyUrl);

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
    dossier.vowintRef,  // ipSlotId → isolation par dossier, évite la contamination croisée captcha
    undefined,  // presolvedHcaptchaToken
    accountProxyUrl,
  );

  if (!result.success) {
    if (result.error?.includes("RATE_LIMIT")) {
      return { status: "rate_limited" };
    }
    // ── Timeout captcha : session intacte, passer au dossier suivant ──────────
    // Le token n'a jamais été soumis → ASP.NET_SessionId encore valide.
    // NE PAS invalider le cache VOWINT — le prochain scan réutilisera la session.
    // Status "no_slot_poll" = le loop passe au dossier suivant sans retry ni invalidation.
    if (result.error === "HCAPTCHA_TIMEOUT_SESSION_INTACT") {
      logFn.warn(`  ⏱️ Timeout captcha (2Captcha saturé) — session CEV intacte, skip → dossier suivant`);
      return { status: "no_slot_poll" };
    }
    const isCaptchaError = result.error === "HCAPTCHA_FAILED" || 
                           result.error?.includes("CAPTCHA") ||
                           result.error?.includes("CAPTCHA_RETRY");
    // HCAPTCHA_REJECTED_BY_SERVER = captchaSolved:false retourné par CEV.
    // Root cause confirmé : le retry réutilisait la MÊME session VOWINT (ASP.NET_SessionId identique,
    // cache 4h). CEV marque la session comme "captcha tenté/expiré" après le 1er reject → tout nouveau
    // token soumis sur cette session reçoit aussi captchaSolved:false, même s'il est frais.
    // FIX : invalider AUSSI la session VOWINT sur HCAPTCHA_REJECTED_BY_SERVER pour forcer un re-login
    // complet (nouveau ASP.NET_SessionId) → CEV accepte le token frais sur la nouvelle session.
    const isServerRejection = result.error === "HCAPTCHA_REJECTED_BY_SERVER";
    const maxRetries = 2;
    if (isCaptchaError && _hcaptchaRetry < maxRetries) {
      logFn.warn(`  ⟳ ${result.error} — retry ${_hcaptchaRetry + 1}/${maxRetries} avec clé fraîche dans 30s…`);
      invalidateAnticaptchaCache();
      if (isServerRejection) {
        // Session CEV consommée/invalidée côté serveur après le 1er reject.
        // Invalider le cache VOWINT → prochain setupCevSessionHttp() fera un re-login complet
        // (nouveau ASP.NET_SessionId) plutôt que de réutiliser la session rejetée.
        // IMPORTANT: utiliser vowintRef comme ipSlotId pour invalider SEULEMENT cette session,
        // pas toutes les sessions du compte (évite la contamination croisée).
        invalidateVowintCache(vowintEmail, dossier.vowintRef);
        logFn.warn(`  🔄 Session VOWINT invalidée pour dossier ${dossier.vowintRef.slice(0, 20)}… → re-login isolé au prochain retry`);
      }
      await sleep(30_000);
      return performScan(vowintEmail, vowintPassword, dossier, applicationId, siphoned, _hcaptchaRetry + 1, logger, accountProxyUrl);
    }
    // Coupure réseau / surcharge serveur → retry rapide, pas de pause longue ni
    // d'invalidation de session (voir isTransientNetworkError).
    if (isTransientNetworkError(result.error)) {
      logFn.warn(`  ⚡ Setup interrompu par le réseau (serveur CEV saturé): ${result.error?.slice(0, 160)}`);
      return { status: "transient_error", error: result.error };
    }
    logFn.warn(`  Erreur setup: ${result.error}`);
    return { status: "error", error: result.error };
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
      accountProxyUrl,
    );
    if (pollResult.status === "slot_found") {
      return {
        status: "slot_found",
        sessionCookie: result.sessionCookie,
        integrationUrl: result.integrationUrl,
      };
    }
  }

  // Probe échouée (timeout/503/504/réseau ou SessionExpired) → signaler pour retry
  if (result.probeError) {
    return { status: "probe_error", probeErrorType: result.probeErrorType ?? "transient" };
  }

  return { status: "no_slot" };
}

// ─── Booking ────────────────────────────────────────────────────────────────

import { sendSlotDetectedEmail, type SlotBookingEmailData } from "../cev-slot-discovery.js";

/** Dossiers en pause (après slot_found) — ne pas re-scanner */
const pausedDossiers = new Set<string>();

// ─── Découvertes de dates (interface admin) ────────────────────────────────

/** Garde-fou volume : nombre max d'events publiés par détection. */
const MAX_CEV_DISCOVERY_EVENTS = 120;

/**
 * Publie les créneaux vus sur la page SelectSlot vers l'onglet « découvertes ».
 *
 * COÛT : zéro sur le chemin critique — l'appel est fait APRÈS le booking, le
 * parsing est local (HTML déjà en mémoire, aucune requête portail) et l'envoi
 * Convex est fire-and-forget. Les dates CEV sont déjà en ISO (`datePart`), donc
 * directement exploitables par les découvertes ET par le calendrier admin.
 */
function publishCevDiscoveries(
  applicationId: string,
  vowintRef: string,
  selectSlotHtml?: string,
  bookedDate?: string,
  bookedTime?: string,
): void {
  if (!selectSlotHtml || selectSlotHtml.length < 500) return;
  // setImmediate : le parsing regex/JSON ne s'exécute pas dans la continuation
  // du booking — aucune milliseconde volée à la capture du créneau.
  setImmediate(() => {
    try {
      const slots = extractInlineSlotsFromHtml(selectSlotHtml)
        .filter((s) => !!s.date)
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""))
        .slice(0, MAX_CEV_DISCOVERY_EVENTS);
      if (slots.length === 0) return;

      const events: SlotDiscoveryEvent[] = slots.map((s) => {
        const captured = !!bookedDate && s.date === bookedDate && (!bookedTime || s.time === bookedTime);
        return {
          applicationId,
          destination: "schengen",
          office: `CEV Belgique (${vowintRef})`,
          dateFound: s.date,
          timeFound: s.time || undefined,
          outcome: captured ? "captured" : "ignored",
          reason: captured ? undefined : bookedDate ? "other_slot_booked" : "slot_not_booked",
          context: { vowintRef, freeSlots: s.free ?? 1, source: "selectslot_inline" },
          mode: "schedule",
        } satisfies SlotDiscoveryEvent;
      });

      reportSlotDiscoveryBatch(events);
      log("INFO", `🗂️ [${vowintRef}] ${events.length} date(s) découverte(s) enregistrée(s)`);
    } catch (err) {
      log("WARN", `[${vowintRef}] publishCevDiscoveries (non bloquant): ${err}`);
    }
  });
}

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

  // ── PAUSE immédiate (empêche les re-scans concurrents pendant le booking) ──
  // La pause est LEVÉE en cas d'échec booking — seul le succès la rend définitive.
  pausedDossiers.add(dossier.vowintRef);
  logFn.info(`  ⏸️ Dossier #${dossier.index} ${dossier.vowintRef} mis en PAUSE temporaire (booking en cours)`);
  let _bookingSucceeded = false;
  let _bookedDate: string | undefined;
  let _bookedTime: string | undefined;

  try {
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
          bookedDossierRef: dossier.vowintRef,
        });
        _bookingSucceeded = true;
        _bookedDate = httpResult.bookedDate;
        _bookedTime = httpResult.bookedTime;
        return;
      }
      // Si NO_AVAILABILITY → le slot est pris par quelqu'un d'autre — dépause pour futurs créneaux
      if (httpResult.error === "NO_AVAILABILITY" || httpResult.error === "NO_SLOTS_IN_RESPONSE") {
        logFn.info(`  ❌ Slot disparu (${httpResult.error}) — pas de retry`);
        return; // finally dépause
      }
      // SessionExpired ou autre erreur → retry avec re-login
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
    return; // finally dépause
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
        bookedDossierRef: dossier.vowintRef,
      });
      _bookingSucceeded = true;
      _bookedDate = httpResult.bookedDate;
      _bookedTime = httpResult.bookedTime;
    } else {
      logFn.error(`  ❌ Booking HTTP (re-login) échoué: ${httpResult.error}`);
    }
  } catch (err) {
    logFn.error(`  💥 Crash booking: ${err}`);
  }
} finally {
  // ── Dates découvertes (interface admin) — hors chemin critique ────────────
  publishCevDiscoveries(applicationId, dossier.vowintRef, existingSelectSlotHtml, _bookedDate, _bookedTime);

  // ── Dépause si le booking n'a pas abouti ──────────────────────────────────
  // La pause était temporaire (anti-concurrent). Seul un booking confirmé la rend définitive.
  if (!_bookingSucceeded) {
    pausedDossiers.delete(dossier.vowintRef);
    logFn.info(`  ▶️ Dossier #${dossier.index} ${dossier.vowintRef} dépausé (booking non confirmé)`);
  } else {
    logFn.info(`  ⏸️ Dossier #${dossier.index} ${dossier.vowintRef} reste en PAUSE (booking confirmé)`);
  }
  } // fin try/finally
} // fin handleSlotFound

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
  /** Créneau ciblé (date, heure) alloué à ce compte — booking de CE créneau exact. */
  targetSlot?: { date: string; time: string },
  /** Date limite MAX "YYYY-MM-DD" — créneaux après cette date écartés (pas de booking). */
  maxDate?: string,
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
        targetSlot,
        maxDate,
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

  // ── Session isolée par dossier (ipSlotId = vowintRef) ──────────────────
  // Chaque dossier a son propre slot de cache VOWINT (clé = "email:vowintRef").
  // → Si ce dossier a déjà une session valide en cache (scan précédent ou scan
  //   en cours sur le même compte), setupCevSessionHttp saute le login VOWINT
  //   et commence directement à getAppointment — pas de captcha, ~5-10x plus rapide.
  // → On NE vide PAS le cache global : les autres dossiers gardent leurs propres sessions.
  // → Pas de risque "multiple session" CEV : chaque dossier a ses propres cookies VOWINT
  //   (isolés par ipSlotId) et obtient un ASP.NET_SessionId CEV distinct.
  logFn.info(`  [${vowintRef}] 🔑 Ouverture session (cache isolé par dossier — login sauté si session valide)...`);

  let session: Awaited<ReturnType<typeof setupCevSessionHttp>>;
  try {
    session = await setupCevSessionHttp(
      vowintEmail,
      vowintPassword,
      vowintRef,        // _applicationId (accountId par dossier)
      applicationId,    // clientId (pour les logs)
      vowintRef,        // vowintAppUrl
      undefined,        // siphoned
      vowintRef,        // ipSlotId → cache isolé par dossier, pas d'invalidation globale
    );
  } catch (err) {
    logFn.error(`  [${vowintRef}] ❌ Setup session crash: ${err}`);
    return { success: false, error: `session setup crash: ${err}` };
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
      targetSlot,
      maxDate,
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
  /** Index stable de ce compte (0-based) — pilote l'allocation déterministe des créneaux. */
  accountIndex: number = 0,
  /** Nombre total de comptes CEV actifs — base du décalage cyclique d'allocation. */
  totalAccounts: number = 1,
  /** Map { VOWINTREF → "YYYY-MM-DD" } des dates limites MAX par dossier (cevDossierDeadlines). */
  dossierDeadlines?: Map<string, string>,
  /** Date limite MAX globale "YYYY-MM-DD" (slotDateDeadline) — fallback si pas de deadline par AppId. */
  globalDeadline?: string,
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

  // ── PAUSE temporaire (anti-concurrent) — dépausée en fin de fonction si échec ──
  const _allPausedRefs = [detectingDossier.vowintRef, ...eligibleRefs];
  const _succeededRefs = new Set<string>();
  pausedDossiers.add(detectingDossier.vowintRef);
  eligibleRefs.forEach(ref => pausedDossiers.add(ref));
  logFn.info(`  ⏸️ ${_allPausedRefs.length} dossier(s) mis en PAUSE temporaire (booking en cours)`);

  // Variables hissées avant le try pour rester accessibles dans l'email post-finally.
  let totalFree = 0;
  let detectingBookingResult: Awaited<ReturnType<typeof bookDossierIsolated>> | null = null;
  let skipMulti = true;

  // try/finally garantit la dépause même si une exception survient pendant le booking.
  try {

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
  let inlineSlots: Array<{ date: string; time: string; free?: number }> = [];
  if (existingSelectSlotHtml && existingSelectSlotHtml.length > 500) {
    inlineSlots = extractInlineSlotsFromHtml(existingSelectSlotHtml);
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

  // ── Coordination inter-comptes : allocation déterministe + mode RACE ────────
  // Chaque compte reçoit une liste de créneaux ORDONNÉE par son accountIndex
  // (buildCevSlotAssignment) → les comptes visent des créneaux DISTINCTS, dans le
  // même ordre stable, sans se marcher dessus. Sous le seuil RACE, on contourne le
  // claim et on fonce (le serveur CEV arbitre) pour ne pas laisser un concurrent
  // rafler le seul créneau pendant qu'on coordonne.
  const distinctSlotCount = inlineSlots.length;
  const raceMode = distinctSlotCount > 0 && distinctSlotCount <= CEV_RACE_MODE_SLOT_THRESHOLD;
  // Date limite MAX du dossier détecteur : par AppId si définie, sinon globale, sinon aucune.
  const detectorDeadline = resolveCevDeadline(
    detectingDossier.vowintRef,
    dossierDeadlines ?? new Map(),
    globalDeadline,
  );
  const orderedSlots: CevSlotCandidate[] = buildCevSlotAssignment(
    String(applicationId),
    inlineSlots.map(s => ({ date: s.date, time: s.time, free: s.free ?? 1 })),
    groupSize ?? 1,
    totalAccounts,
    accountIndex,
    detectorDeadline,
  );
  if (orderedSlots.length > 0) {
    logFn.info(
      `  🎯 Allocation compte #${accountIndex}/${totalAccounts - 1} : ${orderedSlots.length} créneau(x) ordonnés` +
      (detectorDeadline ? ` (deadline ${detectorDeadline})` : ``) +
      (raceMode ? ` — MODE RACE (${distinctSlotCount} ≤ ${CEV_RACE_MODE_SLOT_THRESHOLD}, pas de claim)` : ` — 1er visé: ${orderedSlots[0].date} ${orderedSlots[0].time}`),
    );
  } else if (inlineSlots.length > 0 && detectorDeadline) {
    // Des créneaux existent mais tous APRÈS la deadline → ne rien booker (continuer à scanner).
    logFn.info(`  ⏳ ${detectingDossier.vowintRef} : ${inlineSlots.length} créneau(x) mais tous après la deadline ${detectorDeadline} — aucun booking, scan continue`);
    botLog({ applicationId, step: "cev_all_slots_after_deadline", status: "ok", data: { vowintRef: detectingDossier.vowintRef, deadline: detectorDeadline, slotCount: inlineSlots.length } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATÉGIE : BOOKER LE DOSSIER DÉTECTEUR EN PREMIER — TOUJOURS SI ÉLIGIBLE,
  //             ET EN FALLBACK D'URGENCE SI HORS POOL + TOTALFREE ≤ 1
  //
  // Contrainte CEV fondamentale : la session est liée au dossier détecteur.
  // Un dossier éligible ne peut PAS réutiliser cette session — il devrait refaire
  // le flux complet (login → getAppointment → captcha → selectDossier → SelectSlot),
  // ce qui prend 1-2 min minimum. Avec un seul créneau disponible, le slot est parti.
  //
  // Règles :
  //   • Détecteur dans le pool → booke immédiatement (cas nominal).
  //   • Détecteur hors pool + totalFree ≥ 2 → ne booke PAS. Les eligibles font un
  //     re-login isolé — les créneaux restants les attendent.
  //   • Détecteur hors pool + totalFree ≤ 1 → FALLBACK D'URGENCE : le détecteur booke
  //     quand même. Perdre le slot est pire que le "mauvais" dossier qui le prend.
  //     Le double-session est aussi évité : on n'ouvre PAS de seconde session eligible.
  // ═══════════════════════════════════════════════════════════════════════════

  const detectorIsEligible = eligibleRefs.includes(detectingDossier.vowintRef);
  // Fallback d'urgence : seul créneau disponible et détecteur hors pool.
  const detectorMustBookAsFallback = !detectorIsEligible && totalFree <= 1;

  if (!detectorIsEligible && !detectorMustBookAsFallback) {
    logFn.info(`  ℹ️ ${detectingDossier.vowintRef} hors pool de booking, totalFree=${totalFree} ≥ 2 → skip booking détecteur, wake eligibles`);
  }
  if (detectorMustBookAsFallback) {
    logFn.warn(`  ⚠️ FALLBACK URGENCE: ${detectingDossier.vowintRef} hors pool MAIS totalFree=${totalFree} (seul créneau) → booke pour éviter perte du slot`);
    botLog({ applicationId, step: "cev_detector_fallback_booking", status: "warn", data: { detectingDossier: detectingDossier.vowintRef, eligibleRefs, totalFree, reason: "single_slot_outside_pool" } });
  }

  if ((detectorIsEligible || detectorMustBookAsFallback) && existingSessionCookie && existingIntegrationUrl) {
    logFn.info(`  🎯 BOOKING IMMÉDIAT — ${detectingDossier.vowintRef} (session existante, pas de discovery)...`);

    // Liste des créneaux à tenter, dans l'ordre alloué à CE compte.
    // Deux cas où orderedSlots est vide :
    //   A. HTML absent (inlineSlots vide) → une passe sans cible [null] (bookCevViaHttp re-scanne/choisit).
    //   B. HTML présent MAIS tous les créneaux hors deadline du détecteur → NE PAS faire tenter
    //      le détecteur ([] ). Même avec un seul slot, on préfère relayer immédiatement vers un
    //      dossier du pool qui respecte la deadline (bloc de réveil ci-dessous) plutôt que de
    //      gaspiller un clic sur un booking voué à NO_SLOT_BEFORE_DEADLINE.
    const detectorBlockedByOwnDeadline = orderedSlots.length === 0 && inlineSlots.length > 0;
    const candidates: Array<CevSlotCandidate | null> =
      orderedSlots.length > 0 ? orderedSlots : (detectorBlockedByOwnDeadline ? [] : [null]);
    if (detectorBlockedByOwnDeadline) {
      logFn.info(`  ⛔ ${detectingDossier.vowintRef} : tous les créneaux hors deadline (${detectorDeadline ?? "?"}) → pas de tentative détecteur, relais direct aux dossiers éligibles`);
    }

    for (const candidate of candidates) {
      // ── Claim atomique NON BLOQUANT (sauf mode RACE) ────────────────────────
      // Si le créneau est déjà pris par un autre compte → on passe IMMÉDIATEMENT
      // au suivant (aucune attente). En mode RACE, pas de claim : tous foncent.
      if (candidate && !raceMode) {
        const claimed = await tryClaimCevSlot(candidate.date, candidate.time, String(applicationId), candidate.free);
        if (!claimed) {
          logFn.info(`  ⏭️ ${candidate.date} ${candidate.time} déjà claim par un autre compte → créneau suivant`);
          continue;
        }
        logFn.info(`  🔒 Claim OK ${candidate.date} ${candidate.time} → booking...`);
      }

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
          candidate ? { date: candidate.date, time: candidate.time } : undefined,
          detectorDeadline,
        );
      } catch (err) {
        logFn.error(`  💥 ${detectingDossier.vowintRef} → Booking crash: ${err}`);
        detectingBookingResult = null;
      }

      if (detectingBookingResult?.success) {
        logFn.info(`  ✅ ${detectingDossier.vowintRef} → BOOKING RÉUSSI! code=${detectingBookingResult.confirmationCode} date=${detectingBookingResult.bookedDate}`);
        _succeededRefs.add(detectingDossier.vowintRef);
        await reportSlotFound({
          applicationId,
          date: detectingBookingResult.bookedDate ?? "",
          time: detectingBookingResult.bookedTime ?? "",
          location: `CEV Belgique (${detectingDossier.vowintRef})`,
          confirmationCode: detectingBookingResult.confirmationCode,
          bookedDossierRef: detectingDossier.vowintRef,
        });
        botLog({ applicationId, step: "cev_multi_booking_success", status: "ok", data: { vowintRef: detectingDossier.vowintRef, confirmationCode: detectingBookingResult.confirmationCode, strategy: raceMode ? "race" : "claim", slot: candidate ? `${candidate.date} ${candidate.time}` : "auto" } });
        break; // booké → stop la cascade
      }

      // Échec sur ce créneau → libérer le claim pour qu'un autre compte puisse le tenter,
      // puis cascade vers le créneau suivant (aucune attente).
      if (candidate && !raceMode) {
        await releaseCevSlot(candidate.date, candidate.time, String(applicationId));
      }
      logFn.warn(`  ⚠️ ${detectingDossier.vowintRef} → échec sur ${candidate ? `${candidate.date} ${candidate.time}` : "auto"}: ${detectingBookingResult?.error ?? "?"} → créneau suivant`);
    }
  }

  // ── Décision multi-dossier basée sur le free RESTANT après le détecteur ────
  // Si free=3 et le détecteur a réussi → il reste 2 places → réveiller max 2 autres.
  // Si free=1 → pas de multi. Si détecteur a échoué (session expired) → le slot est peut-être pris par un humain → pas de multi non plus.
  const freeConsumedByDetector = detectingBookingResult?.success ? 1 : 0;
  const remainingFree = totalFree - freeConsumedByDetector;
  // Les "autres" sont tous les éligibles sauf le détecteur (qu'il soit éligible ou non,
  // sa place dans la liste parallèle ne le concerne pas — il a déjà booké ou est hors pool).
  const otherRefs = eligibleRefs.filter(ref => ref !== detectingDossier.vowintRef);

  // ── Filtrer les AUTRES dossiers sur leur DEADLINE ───────────────────────────
  // Un dossier n'est réveillé que si AU MOINS un créneau détecté tombe dans SA
  // fenêtre (deadline par AppId > globale > aucune). Évite de consommer un clic
  // pour un dossier dont tous les créneaux sont hors deadline.
  const otherRefsWithinDeadline = otherRefs.filter(ref =>
    hasSlotWithinDeadline(inlineSlots, resolveCevDeadline(ref, dossierDeadlines ?? new Map(), globalDeadline)),
  );

  // Cas clé : le détecteur a vu des créneaux mais N'A PAS pu booker à cause de SA
  // deadline (orderedSlots vide). On passe alors le relais IMMÉDIATEMENT aux dossiers
  // du pool dont la deadline accepte ces créneaux — sans attendre leur tour de round-robin.
  const detectorBlockedByDeadline =
    !detectingBookingResult?.success && inlineSlots.length > 0 && orderedSlots.length === 0;
  if (detectorBlockedByDeadline && otherRefsWithinDeadline.length > 0) {
    logFn.info(
      `  🔁 ${detectingDossier.vowintRef} bloqué par sa deadline (${detectorDeadline ?? "?"}) mais ` +
      `${otherRefsWithinDeadline.length} dossier(s) du pool éligible(s) à ces créneaux → réveil immédiat: [${otherRefsWithinDeadline.join(", ")}]`,
    );
    botLog({ applicationId, step: "cev_deadline_relay_wake", status: "ok", data: {
      detector: detectingDossier.vowintRef, detectorDeadline, eligibleByDeadline: otherRefsWithinDeadline,
      slotCount: inlineSlots.length,
    } });
  }

  // ── Booking multi-dossier : booker les AUTRES dossiers ÉLIGIBLES PAR DEADLINE sur
  //    les places restantes. On réveille au plus min(remainingFree, éligibles).
  //    Fallback d'urgence (détecteur hors pool + totalFree≤1) : pas de réveil (le seul
  //    créneau est pris, ouvrir une 2e session risque un "multiple session" CEV).
  const dossiersToWake = detectorMustBookAsFallback
    ? 0
    : Math.min(remainingFree, otherRefsWithinDeadline.length);
  skipMulti = dossiersToWake <= 0;

  if (skipMulti) {
    if (detectorBlockedByDeadline && otherRefsWithinDeadline.length === 0) {
      // Diagnostic explicite du cas "détecteur bloqué deadline mais personne à réveiller".
      const otherDeadlines = otherRefs.map(ref => `${ref}=${resolveCevDeadline(ref, dossierDeadlines ?? new Map(), globalDeadline) ?? "aucune"}`);
      const reason = otherRefs.length === 0
        ? `pool à 1 seul dossier (aucun autre à réveiller)`
        : `les ${otherRefs.length} autre(s) dossier(s) ont aussi une deadline incompatible avec les créneaux détectés`;
      logFn.info(`  🏁 ${detectingDossier.vowintRef} bloqué par deadline (${detectorDeadline ?? "?"}) — AUCUN relais possible : ${reason}. Créneaux: [${inlineSlots.slice(0, 5).map(s => s.date).join(", ")}]${otherRefs.length ? ` | deadlines autres: [${otherDeadlines.join(", ")}]` : ""}`);
      botLog({ applicationId, step: "cev_deadline_no_eligible_relay", status: "warn", data: {
        detector: detectingDossier.vowintRef, detectorDeadline,
        slots: inlineSlots.slice(0, 10).map(s => s.date),
        otherRefs, otherDeadlines,
      } });
    } else if (detectorMustBookAsFallback) {
      logFn.info(`  🏁 Fallback urgence (détecteur hors pool, seul créneau) — pas de multi-dossier (risque double session)`);
    } else if (detectingBookingResult?.success && remainingFree <= 0) {
      logFn.info(`  🏁 Booking réussi pour ${detectingDossier.vowintRef} — aucune place restante (free=${totalFree})`);
    } else if (totalFree <= 1) {
      logFn.info(`  🏁 totalFree=${totalFree} — pas de multi-dossier`);
    } else {
      logFn.info(`  🏁 Pas de multi-dossier (remainingFree=${remainingFree}, autres=${otherRefs.length})`);
    }
  } else {
    // ── Multi-dossier : booker les AUTRES dossiers en parallèle ─────────────
    // Le détecteur a déjà tenté (ou est hors pool avec totalFree≥2 — les créneaux
    // restants attendent). Chaque dossier éligible fait son propre re-login isolé.
    //
    // NOTE : on ne transfère PAS la session du détecteur aux eligibles. La session CEV
    // est liée au dossier qui a appelé selectDossier — un autre dossier ne peut pas la
    // réutiliser ; il doit refaire le flux complet (login → captcha → selectDossier).
    const selectedRefs = otherRefsWithinDeadline.slice(0, dossiersToWake);
    logFn.info(`  🚀 remainingFree=${remainingFree} — lancement ${selectedRefs.length} dossier(s) secondaire(s) éligible(s) par deadline [${selectedRefs.join(", ")}]...`);

    const bookingTasks = selectedRefs.map((vowintRef) => {
      const refDeadline = resolveCevDeadline(vowintRef, dossierDeadlines ?? new Map(), globalDeadline);
      // Slot unique + relais deadline : cibler EXACTEMENT le créneau le plus proche
      // dans la deadline de CE dossier, pour aller vite (pas de re-choix aléatoire).
      // Multi-slots : laisser bookDossierIsolated re-scanner et choisir (targetSlot undefined)
      // pour que chaque dossier réveillé prenne un créneau distinct via sa propre allocation.
      let targetForRef: { date: string; time: string } | undefined;
      if (detectorBlockedByDeadline) {
        const ordered = buildCevSlotAssignment(
          `${applicationId}:${vowintRef}`,
          inlineSlots.map(s => ({ date: s.date, time: s.time, free: s.free ?? 1 })),
          groupSize ?? 1, totalAccounts, accountIndex, refDeadline,
        );
        if (ordered.length > 0) targetForRef = { date: ordered[0].date, time: ordered[0].time };
      }
      return bookDossierIsolated(
        vowintEmail, vowintPassword,
        vowintRef, applicationId,
        groupSize, undefined, logger,
        targetForRef,
        refDeadline,
      ).then(result => ({ vowintRef, ...result }));
    });

    const results = await Promise.allSettled(bookingTasks);

    for (const settled of results) {
      if (settled.status === "rejected") {
        logFn.error(`  💥 Booking task crash: ${settled.reason}`);
        continue;
      }
      const r = settled.value;
      if (r.success) {
        logFn.info(`  ✅ ${r.vowintRef} → BOOKING RÉUSSI! code=${r.confirmationCode} date=${r.bookedDate}`);
        _succeededRefs.add(r.vowintRef);
        await reportSlotFound({
          applicationId,
          date: r.bookedDate ?? "",
          time: r.bookedTime ?? "",
          location: `CEV Belgique (${r.vowintRef})`,
          confirmationCode: r.confirmationCode,
          screenshotStorageId: r.screenshotStorageId,
          bookedDossierRef: r.vowintRef,
        });
        botLog({ applicationId, step: "cev_multi_booking_success", status: "ok", data: { vowintRef: r.vowintRef, confirmationCode: r.confirmationCode, strategy: "parallel" } });
      } else {
        logFn.warn(`  ❌ ${r.vowintRef} → Booking échoué: ${r.error}`);
        botLog({ applicationId, step: "cev_multi_booking_fail", status: "fail", data: { vowintRef: r.vowintRef, error: r.error } });
      }
    }
  }

  // ── Dépause des dossiers dont le booking n'a pas abouti ──────────────────
  // Seul le succès rend la pause définitive — les autres reprennent le scan.
  } finally {
    const toUnpause = _allPausedRefs.filter(ref => !_succeededRefs.has(ref));
    if (toUnpause.length > 0) {
      toUnpause.forEach(ref => pausedDossiers.delete(ref));
      logFn.info(`  ▶️ ${toUnpause.length} dossier(s) dépausé(s) (booking non confirmé): [${toUnpause.join(", ")}]`);
    }
    if (_succeededRefs.size > 0) {
      logFn.info(`  ⏸️ ${_succeededRefs.size} dossier(s) en PAUSE définitive (booking confirmé): [${[..._succeededRefs].join(", ")}]`);
    }
  }

  // ── Dates découvertes (interface admin) — après booking, fire-and-forget ──
  publishCevDiscoveries(
    applicationId,
    detectingDossier.vowintRef,
    existingSelectSlotHtml,
    detectingBookingResult?.bookedDate,
    detectingBookingResult?.bookedTime,
  );

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

  // ── Index de compte déterministe (accountIndex) ────────────────────────────
  // Tri stable des comptes par id → chaque compte reçoit un index 0-based fixe.
  // Cet index pilote l'allocation déterministe des créneaux (buildCevSlotAssignment) :
  // compte[0] vise le créneau[0], compte[1] le créneau[1], etc. → répartition sans
  // collision entre nos propres comptes tant que #créneaux ≥ #comptes.
  const sortedJobs = [...cevJobs].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
  const totalAccounts = sortedJobs.length;

  // Lancer une loop par compte (application), avec son index stable
  const loopPromises = sortedJobs.map((job: any, accountIndex: number) =>
    runAccountLoop(job, accountIndex, totalAccounts)
  );

  await Promise.all(loopPromises);
}

// ─── Loop par compte (application) ────────────────────────────────────────────

async function runAccountLoop(job: any, accountIndex: number = 0, totalAccounts: number = 1): Promise<void> {
  const accountId = job.id;
  const applicantName = job.applicantName;
  const hunterConfig = job.hunterConfig;
  const logger = createLogger(`CEV-Account:${applicantName}`);
  logger.info(`  • Index compte: ${accountIndex}/${totalAccounts - 1} (allocation créneaux déterministe)`);
  // Seed déterministe pour le jitter de grille (même valeur à chaque redémarrage).
  const gridSeed = gridSeedFromAccount(String(accountId));
  // Dates limites MAX : par AppId (cevDossierDeadlines CSV) + globale (slotDateDeadline).
  // Résolution au moment du booking : par AppId > globale > aucune limite.
  const dossierDeadlines = parseCevDossierDeadlines(hunterConfig.cevDossierDeadlines);
  const globalDeadline: string | undefined = hunterConfig.slotDateDeadline;
  if (dossierDeadlines.size > 0 || globalDeadline) {
    logger.info(`  • Dates limites: ${dossierDeadlines.size} par dossier${globalDeadline ? `, globale=${globalDeadline}` : ""}`);
  }
  
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
  
  // Proxy config (let → peut être rechargé depuis Convex en cours de loop)
  let useProxy = hunterConfig.cevUseProxy ?? await shouldUseProxy();
  
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
    logger.info(`Pool state restauré depuis Redis — reprend à index=${savedPoolState.currentIndex}, scanCount=${savedScanCount}`);
  } else {
    logger.info( "Pas de pool state en Redis — démarrage frais");
  }

  // ─── Restaurer les dossiers déjà bookés (cevCompletedDossiers) depuis Convex ──
  // Survit aux redémarrages : un dossier booké ne sera JAMAIS re-scanné.
  const completedStr: string = hunterConfig.cevCompletedDossiers ?? "";
  if (completedStr.trim()) {
    const completedRefs = completedStr.split(",").map((s: string) => s.trim().toUpperCase()).filter(Boolean);
    for (const ref of completedRefs) {
      pausedDossiers.add(ref);
    }
    logger.info(`  ✅ ${completedRefs.length} dossier(s) déjà booké(s) restauré(s) en pause: [${completedRefs.join(", ")}]`);
  }

  const soaxBaseUrl = process.env.SOAX_PROXY_URL;
  const decodoBaseUrl = process.env.DECODO_PROXY_URL;
  let proxyExitIp: string | null = null;
  /**
   * Proxy dédié à ce compte — résolu une seule fois au démarrage.
   * Passé explicitement à performScan → setupCevSessionHttp → cevImpitFetch
   * au lieu d'écrire dans process.env.IPROYAL_PROXY_URL (variable globale partagée).
   *
   * Pour Decodo CSV : 1 URL fixe par accountId (hash déterministe sur 10 IPs).
   * Pour SOAX / iProyal : null → comportement historique via process.env.
   */
  let accountProxyUrl: string | undefined;
  /** URL base Decodo réservée en Redis pour ce compte — libérée à l'arrêt du loop. */
  let reservedDecodoBaseUrl: string | undefined;

  logger.info(`Config:`);
  logger.info(`  • Dossiers: ${localPool.size}`);
  logger.info(`  • Stratégie: One-Shot (1 clic/réveil, session réutilisée si valide)`);
  logger.info(`  • Intervalle: ${Math.round(intervalMs / 1000)}s (±jitter log-normal)`);

  if (useProxy) {
    // ─── Configure proxy (priorité: Decodo CSV > SOAX > iProyal) ─────────────
    if (hasCevDecodoProxy()) {
      const poolSize = getCevDecodoPoolSize();
      logger.info(`  • Proxy: Decodo CSV pool (${poolSize} IP(s)) — 1 IP DISTINCTE par compte (index + réservation Redis)`);

      // ── Assignation par accountIndex + réservation Redis (façon Spain) ──────
      // On tente d'abord l'IP d'index = accountIndex (0,1,2… → zéro collision entre
      // comptes tant que #comptes ≤ #IP), puis on avance jusqu'à trouver une IP non
      // réservée par un AUTRE compte (SET NX). Garantit une exit IP distincte par
      // compte → pas d'association de comptes côté serveur.
      let decodoBaseUrl: string | undefined;
      for (let offset = 0; offset < poolSize; offset++) {
        const candidate = getCevDecodoUrlForIndex(accountIndex + offset);
        if (!candidate) break;
        const reserved = await reserveCevIp(candidate, String(accountId));
        if (reserved) {
          decodoBaseUrl = candidate;
          reservedDecodoBaseUrl = candidate; // pour libération au shutdown
          if (offset > 0) {
            logger.info(`  • IP index=${accountIndex} déjà réservée → décalage +${offset} (IP distincte garantie)`);
          }
          break;
        }
      }
      if (!decodoBaseUrl) {
        // Toutes les IP réservées par d'autres comptes (#comptes > #IP) → fallback
        // sur l'assignation par hash (comportement historique) plutôt que pas de proxy.
        logger.warn(`  ⚠️ Toutes les IP Decodo réservées (${poolSize} IP < comptes actifs) — fallback hash accountId`);
        decodoBaseUrl = getCevDecodoUrlForAccount(accountId);
      }
      if (decodoBaseUrl) {
        // CRITICAL: wrapper avec sessid sticky par compte pour garantir toujours la même IP.
        // Sans sessid, Decodo assigne une IP aléatoire à chaque connexion →
        // IP solve Anti-Captcha ≠ IP submit SetCaptchaToken → captchaSolved:false.
        const decodoUrl = makeCevDecodoStickyUrl(decodoBaseUrl, undefined, `cev-account-${accountId}`);
        accountProxyUrl = decodoUrl;
        process.env.IPROYAL_PROXY_URL = decodoUrl; // compat historique (ex: solveHcaptchaWithProxy)
        resetCevImpitInstances();
        logger.info(`  • Decodo proxy configuré (sticky): ${decodoUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 70)}…`);
        proxyExitIp = await initCevProxyGuardWithExitIp(decodoUrl, `cev-account-${accountId}`);
      } else {
        logger.warn(`  ⚠️ Pool Decodo vide — connexion directe`);
      }
    } else if (soaxBaseUrl) {
      logger.info(`  • Proxy: SOAX (sticky Kinshasa)`);
      const soaxStickyUrl = makeCevProxyStickyUrl("soax", undefined, `cev-account-${accountId}`);
      process.env.IPROYAL_PROXY_URL = soaxStickyUrl;
      resetCevImpitInstances();
      logger.info(`  • SOAX proxy configuré: ${soaxStickyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}…`);
      proxyExitIp = await initCevProxyGuardWithExitIp(soaxStickyUrl, `cev-account-${accountId}`);
    } else if (process.env.IPROYAL_PROXY_URL) {
      logger.info(`  • Proxy: iProyal (sticky session)`);
      proxyExitIp = await initCevProxyGuardWithExitIp(process.env.IPROYAL_PROXY_URL, `cev-account-${accountId}`);
    } else {
      logger.warn(`  ⚠️ AUCUN PROXY (Decodo CSV, SOAX_PROXY_URL, IPROYAL_PROXY_URL absents) — connexion directe`);
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
  /** Coupures réseau consécutives — pilote le backoff des retries rapides. */
  let consecutiveTransient = 0;
  /** Dernière rafale de surcharge — évite d'en enchaîner plusieurs d'affilée. */
  let lastSurgeAt = 0;
  /**
   * Dossier à retenter en priorité au prochain tour (après probe_error).
   * null = sélection normale round-robin via localPool.getNextAvailable().
   */
  let probeRetryDossier: DossierSlot | null = null;

  // ─── Mode SURCHARGE (surge burst) ────────────────────────────────────────
  //
  // Observation terrain : quand le portail belge éjecte (504 / TLS eof) à
  // répétition, ce n'est pas une panne — c'est la signature d'une publication de
  // créneaux en cours, avec des centaines d'utilisateurs qui cliquent en même
  // temps. Le scan séquentiel dossier par dossier est alors le pire réflexe :
  // il consomme le temps utile à raison d'un dossier toutes les 2 minutes.
  //
  // Stratégie : au bout de SURGE_TRANSIENT_THRESHOLD coupures consécutives, on
  // réveille TOUS les dossiers encore éligibles (non pausés, quota disponible)
  // et on les fait tenter la porte en parallèle. Ceux qui passent bookent ;
  // ceux qui se font éjecter n'ont rien consommé et repasseront selon leur
  // propre budget de clics. C'est exactement le comportement humain : rouvrir
  // plusieurs onglets pendant la bousculade.
  const SURGE_TRANSIENT_THRESHOLD = 3;
  const SURGE_MAX_PARALLEL = 6;
  const SURGE_COOLDOWN_MS = 90_000;

  /**
   * Tente en parallèle tous les dossiers éligibles. Retourne le nombre de
   * dossiers ayant effectivement passé la porte (créneau trouvé).
   */
  const runSurgeBurst = async (
    excluded: DossierSlot,
    logger: ReturnType<typeof createLogger>,
  ): Promise<number> => {
    const candidates = localPool.getEligibleForBurst(excluded).slice(0, SURGE_MAX_PARALLEL);
    if (candidates.length === 0) {
      logger.warn(`  🌊 Surcharge détectée mais aucun dossier éligible (pause ou quota) — rafale annulée`);
      return 0;
    }
    lastSurgeAt = Date.now();
    logger.warn(
      `  🌊 SURCHARGE CEV (${consecutiveTransient} coupures) — réveil de ${candidates.length} dossier(s) ` +
      `en parallèle: ${candidates.map(d => `#${d.index}`).join(", ")}`,
    );
    botLog({
      applicationId: logApplicationId,
      step: "cev_dossier_surge_burst",
      status: "warn",
      data: {
        consecutiveTransient,
        candidates: candidates.map(d => d.vowintRef).join(","),
        candidateCount: candidates.length,
        scanCount: state.scanCount,
      },
    });

    // Chaque dossier a sa propre session VOWINT/CEV : le parallélisme est sûr
    // ici (contrairement au booking Espagne), le lock distribué protégeant
    // seulement contre une seconde instance du bot.
    const attempts = await Promise.all(
      candidates.map(async (cand) => {
        const locked = await acquireCevScanLock(cand.vowintRef);
        if (!locked) return { cand, result: null as Awaited<ReturnType<typeof performScan>> | null };
        try {
          state.scanCount++;
          const res = await performScan(
            vowintEmail, vowintPassword, cand, logApplicationId, undefined, 0, logger, accountProxyUrl,
          );
          // Seules les tentatives réellement arrivées jusqu'à CEV consomment un clic.
          if (res.status !== "transient_error" && res.status !== "probe_error") {
            localPool.recordClick(cand);
          }
          return { cand, result: res };
        } catch (err) {
          logger.warn(`  🌊 Rafale — erreur sur #${cand.index} ${cand.vowintRef}: ${String(err).slice(0, 120)}`);
          return { cand, result: null };
        } finally {
          await releaseCevScanLock(cand.vowintRef);
        }
      }),
    );

    const winners = attempts.filter(a => a.result?.status === "slot_found");
    const rejected = attempts.filter(a => a.result?.status === "transient_error" || a.result === null);
    logger.warn(
      `  🌊 Rafale terminée — ${winners.length} passage(s), ${rejected.length} éjection(s) ` +
      `sur ${attempts.length} tentative(s)`,
    );

    // Les bookings restent séquentiels : deux dossiers qui visent le même
    // créneau doivent être départagés proprement par le claim, pas par la course.
    for (const w of winners) {
      const r = w.result!;
      state.slotsFound++;
      const jobId = `cev-dossier-${w.cand.vowintRef}`;
      recordScan(jobId, w.cand.vowintRef);
      recordSlotFound(jobId, w.cand.vowintRef);
      try {
        await handleSlotFoundMulti(
          vowintEmail, vowintPassword,
          w.cand,
          localPool.getAllDossiers(),
          logApplicationId,
          r.sessionCookie, r.integrationUrl,
          logger,
          r.selectSlotHtml,
          r.selectSlotUrl,
          hunterConfig.groupSize,
          r.selectSlotCookies,
          hunterConfig.cevBookingTargetPool,
          accountIndex,
          totalAccounts,
          dossierDeadlines,
          globalDeadline,
        );
      } catch (err) {
        logger.error(`  🌊 Booking rafale échoué sur ${w.cand.vowintRef}: ${err}`);
      }
    }

    return winners.length;
  };
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

      // ─── Schedule guard CEV : fenêtres horaires + jours OFF ─────────────────
      // Vérifié à chaque cycle — si hors fenêtre, on dort jusqu'à la prochaine.
      // Économie : ~65% de crédits captcha en moins (nuits + week-end coupés).
      const scheduleDecision = await getCevScheduleDecision(intervalMs);
      if (!scheduleDecision.allowed) {
        const sleepMin = Math.round(scheduleDecision.sleepUntilNextWindowMs / 60_000);
        logger.info(`⏸️ CEV Schedule OFF — ${scheduleDecision.bandLabel} — pause ${sleepMin}min`);
        nextScanAllowedAt = Date.now() + scheduleDecision.sleepUntilNextWindowMs;
        await sleep(scheduleDecision.sleepUntilNextWindowMs);
        continue;
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
        // Renouveler la réservation d'IP Redis (TTL 30 min) tant que ce compte tourne,
        // pour qu'un autre compte ne récupère pas l'IP après expiration du TTL.
        if (reservedDecodoBaseUrl) {
          await reserveCevIp(reservedDecodoBaseUrl, String(accountId)).catch(() => {});
        }
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

        // Recharger cevUseProxy — l'admin peut activer/désactiver le proxy sans redémarrer le bot
        const freshUseProxy: boolean = latestJob.hunterConfig?.cevUseProxy ?? false;
        if (freshUseProxy !== useProxy) {
          logger.info(`🔄 Proxy config changée: ${useProxy ? 'activé' : 'désactivé'} → ${freshUseProxy ? 'activé' : 'désactivé'}`);
          useProxy = freshUseProxy;
          if (useProxy) {
            // Activer le proxy (priorité: Decodo CSV > SOAX > iProyal)
            if (hasCevDecodoProxy()) {
              const decodoBaseUrl = getCevDecodoUrlForAccount(accountId);
              if (decodoBaseUrl) {
                // sticky par compte — même IP pour solve et submit captcha
                const decodoUrl = makeCevDecodoStickyUrl(decodoBaseUrl, undefined, `cev-account-${accountId}`);
                accountProxyUrl = decodoUrl;
                process.env.IPROYAL_PROXY_URL = decodoUrl;
                resetCevImpitInstances();
                proxyExitIp = await initCevProxyGuardWithExitIp(decodoUrl, `cev-account-${accountId}`);
                logger.info(`  • Proxy activé: Decodo CSV sticky (exit IP: ${proxyExitIp ?? "inconnue"})`);
              } else {
                logger.warn(`  ⚠️ Pool Decodo vide — proxy non activé malgré cevUseProxy=true`);
                useProxy = false;
              }
            } else if (process.env.SOAX_PROXY_URL) {
              const soaxStickyUrl = makeCevProxyStickyUrl("soax", undefined, `cev-account-${accountId}`);
              process.env.IPROYAL_PROXY_URL = soaxStickyUrl;
              resetCevImpitInstances();
              proxyExitIp = await initCevProxyGuardWithExitIp(soaxStickyUrl, `cev-account-${accountId}`);
              logger.info(`  • Proxy activé: SOAX (exit IP: ${proxyExitIp ?? "inconnue"})`);
            } else if (process.env.IPROYAL_PROXY_URL) {
              proxyExitIp = await initCevProxyGuardWithExitIp(process.env.IPROYAL_PROXY_URL, `cev-account-${accountId}`);
              logger.info(`  • Proxy activé: iProyal (exit IP: ${proxyExitIp ?? "inconnue"})`);
            } else {
              logger.warn(`  ⚠️ cevUseProxy=true mais aucun proxy disponible (Decodo CSV, SOAX, iProyal absents) — mode direct maintenu`);
              useProxy = false;
            }
          } else {
            // Désactiver le proxy
            accountProxyUrl = undefined;
            delete process.env.IPROYAL_PROXY_URL;
            resetCevImpitInstances();
            proxyExitIp = null;
            logger.info(`  • Proxy désactivé — connexion directe`);
          }
        }
      }

      // ─── Refresh dossiers complétés depuis Convex (survit aux redémarrages) ───
      if (state.scanCount % 5 === 0) {
        const latestJobForCompleted = await getActiveJobs().then(
          jobs => jobs.find((j: any) => j.id === accountId),
        ).catch(() => null);
        if (latestJobForCompleted) {
          const freshCompleted: string = latestJobForCompleted.hunterConfig?.cevCompletedDossiers ?? "";
          if (freshCompleted.trim()) {
            const completedRefs = freshCompleted.split(",").map((s: string) => s.trim().toUpperCase()).filter(Boolean);
            for (const ref of completedRefs) {
              if (!pausedDossiers.has(ref)) {
                pausedDossiers.add(ref);
                logger.info(`  ✅ Dossier ${ref} marqué booké (via Convex refresh) — mis en pause`);
              }
            }
          }
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

      // ─── One-Shot: récupérer le prochain dossier (round-robin ou retry probe) ──
      // Si une probe_error a demandé un retry sur le même dossier, l'utiliser en priorité.
      const isProbeRetry = probeRetryDossier !== null;
      const dossier: DossierSlot | null = probeRetryDossier ?? localPool.getNextAvailable();
      probeRetryDossier = null; // consommer le token de retry (1 seul retry par probe_error)
      if (!dossier) {
        // Aucun dossier cliquable : soit tous en pause (slot déjà trouvé), soit
        // tous à court de quota horaire. On attend la première libération plutôt
        // qu'un délai fixe — borné à 30s pour rester réactif aux pauses levées.
        const waitMs = Math.min(30_000, Math.max(5_000, localPool.getNextAvailableIn()));
        logger.info(
          `⏸️ Aucun dossier cliquable (pause ou quota ${MAX_CLICKS_PER_HOUR}/h) — ` +
          `nouvelle tentative dans ${Math.round(waitMs / 1000)}s`,
        );
        await sleep(waitMs);
        continue;
      }

      // ─── Lock distribué anti-double-instance (Replit + Railway) ─────────────
      // Deux instances partagent le même VOWINT Redis. Sans lock, elles appellent
      // SetCaptchaToken sur la même session CEV en même temps → l'une réussit,
      // l'autre reçoit captchaSolved:false (session déjà consommée).
      // SET NX EX 90s → atomique Redis → une seule instance scanne ce dossier à la fois.
      const scanLockAcquired = await acquireCevScanLock(dossier.vowintRef);
      if (!scanLockAcquired) {
        logger.warn(`  🔒 ${dossier.vowintRef} — lock scan distribué pris (autre instance en cours) → skip`);
        await sleep(2_000); // courte pause avant le prochain dossier
        continue;
      }

      // Scan
      state.scanCount++;
      localPool.checkDailyReset();
      const stats = localPool.getStats();

      logger.info(`[Scan #${state.scanCount}] Dossier: #${dossier.index} ${dossier.vowintRef} | Actifs: ${stats.available}/${stats.total} | Total: ${stats.totalScans} scans`);

      // One-Shot: setupCevSessionHttp réutilise la session VOWINT si encore valide (cache 4h).
      // Si expirée → re-login + captcha automatique.
      let result: Awaited<ReturnType<typeof performScan>>;
      try {
        result = await performScan(
          vowintEmail,
          vowintPassword,
          dossier,
          logApplicationId,
          undefined, // pas de siphonedCreds en One-Shot
          0,
          logger,
          accountProxyUrl,
        );
      } finally {
        // Libérer le lock après le scan (succès OU erreur)
        await releaseCevScanLock(dossier.vowintRef);
      }

      // Log chaque scan dans Convex
      botLog({
        applicationId: logApplicationId,
        step: "cev_dossier_scan",
        status:
          result.status === "error" || result.status === "rate_limited" || result.status === "transient_error"
            ? "warn"
            : "ok",
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
          // Le clic « Prendre rendez-vous » a bien été consommé côté CEV.
          localPool.recordClick(dossier);
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
            accountIndex,
            totalAccounts,
            dossierDeadlines,
            globalDeadline,
          );
          break;
        case "rate_limited":
          // Rare en One-Shot, mais possible si serveur répond avec rate-limit
          state.rateLimits++;
          recordScan(uniqueJobId, dossier.vowintRef);
          // Le serveur a compté la tentative : on la compte aussi localement.
          localPool.recordClick(dossier);
          recordRateLimit(uniqueJobId, dossier.vowintRef, "CEV rate-limit");
          invalidateVowintCache(vowintEmail);
          logger.warn(`  ⚡ Rate-limit inattendu sur #${dossier.index} — invalidation session + pause 5min`);
          await sleep(5 * 60_000);
          break;
        case "error":
          state.errors++;
          recordScan(uniqueJobId, dossier.vowintRef);
          // Échec applicatif (pas réseau) : GetEAppointmentUrl a pu être atteint,
          // donc on compte le clic par prudence — mieux vaut sur-compter que
          // déclencher un rate-limit VOWINT.
          localPool.recordClick(dossier);
          invalidateAnticaptchaCache();
          // FIX cascade : invalider UNIQUEMENT le cache du dossier en erreur (ipSlotId = vowintRef).
          // Avant : invalidateVowintCache(vowintEmail) sans ipSlotId = nuke TOUS les dossiers
          // du même email → cascade "AppID absent" sur les dossiers #1-#N qui perdaient
          // leur session valide à cause d'un seul dossier en échec.
          invalidateVowintCache(vowintEmail, dossier.vowintRef);
          logger.warn(`  🔄 Cache VOWINT invalidé pour ${dossier.vowintRef} + Anti-Captcha — prochain cycle utilisera des credentials frais`);
          break;
        case "no_slot":
          recordScan(uniqueJobId, dossier.vowintRef);
          localPool.recordClick(dossier);
          logger.info(
            `  — Pas de créneau disponible (clics restants ce dossier: ` +
            `${localPool.remainingClicks(dossier)}/${MAX_CLICKS_PER_HOUR})`,
          );
          break;
        case "no_slot_poll":
          // Chemin legacy (full session) — ne devrait pas arriver en One-Shot
          logger.info(`  — Pas de créneau (poll direct)`);
          recordScan(uniqueJobId, dossier.vowintRef);
          break;

        case "transient_error": {
          // ── Saturation serveur CEV (TLS eof / connection reset / 50x) ──────────
          // Reproduit le réflexe humain : on ne fait PAS de pause d'une minute, on
          // retente tout de suite avec le dossier suivant du pool (nouvelle session,
          // donc pas d'erreur "multi-session"). Aucun clic VOWINT n'est consommé
          // (recordClick non appelé) et les caches ne sont pas invalidés : l'échec
          // est au niveau TCP/TLS, la session applicative reste valide.
          consecutiveTransient++;
          state.errors++;
          // Backoff doux et borné : 2s, 4s, 8s, 16s, 30s max — reste très en deçà
          // du cycle nominal (~120s) pour ne pas rater la fenêtre de publication,
          // tout en évitant de marteler un serveur déjà à genoux.
          const transientDelayMs = Math.min(30_000, 2_000 * 2 ** Math.min(consecutiveTransient - 1, 4));
          logger.warn(
            `  ⚡ Serveur CEV saturé sur #${dossier.index} ${dossier.vowintRef} ` +
            `(coupure ${consecutiveTransient}) — retry dans ${Math.round(transientDelayMs / 1000)}s ` +
            `avec le dossier suivant, aucun clic consommé`,
          );
          botLog({
            applicationId: logApplicationId,
            step: "cev_dossier_transient_retry",
            status: "warn",
            data: {
              dossier: dossier.vowintRef,
              dossierIndex: dossier.index,
              scanCount: state.scanCount,
              consecutiveTransient,
              retryInSec: Math.round(transientDelayMs / 1000),
              error: (result.error ?? "").slice(0, 200),
            },
          });
          // ── Bascule en mode SURCHARGE ────────────────────────────────────────
          // Trois éjections d'affilée = le portail est bousculé, donc des créneaux
          // sont très probablement en train d'être publiés. On arrête de sonder un
          // dossier à la fois et on envoie tous les éligibles à la porte.
          if (
            consecutiveTransient >= SURGE_TRANSIENT_THRESHOLD &&
            Date.now() - lastSurgeAt > SURGE_COOLDOWN_MS
          ) {
            const won = await runSurgeBurst(dossier, logger);
            if (won > 0) {
              // Au moins un dossier est passé → le portail répond de nouveau.
              consecutiveTransient = 0;
              nextScanAllowedAt = Date.now() + 5_000;
              continue;
            }
            // Tout le monde a été éjecté : on laisse respirer un peu plus, mais on
            // reste largement sous le cycle nominal pour ne pas rater la fenêtre.
            nextScanAllowedAt = Date.now() + Math.min(20_000, transientDelayMs);
            continue;
          }

          nextScanAllowedAt = Date.now() + transientDelayMs;
          continue; // Skip la pause One-Shot : on reste en mode "insistance"
        }

        case "probe_error": {
          // Le clic GetEAppointmentUrl a bien été consommé côté VOWINT → le comptabiliser.
          recordScan(uniqueJobId, dossier.vowintRef);
          localPool.recordClick(dossier);

          const probeErrType = result.probeErrorType ?? "transient";
          const remaining = localPool.remainingClicks(dossier);

          // ── Stratégie de retry selon la cause ───────────────────────────────
          // 'session_expired' : la redirectUrl est expirée mais la session VOWINT (4h) est
          //   peut-être encore valide → refaire GetEAppointmentUrl donne une nouvelle redirectUrl
          //   sans recaptcha. On autorise le retry même si le quota normal (4/h) est épuisé
          //   (on n'est pas encore au 5e clic VOWINT).
          // 'transient' (504/réseau) : le serveur est saturé mais le clic a bien été compté.
          //   Si des clics restent (remaining > 0) → retry immédiat même dossier.
          //   Si quota épuisé (remaining === 0) → on autorise quand même 1 retry (5e clic)
          //   si c'est la 1ère probe_error consécutive (!isProbeRetry).
          //
          // Dans les deux cas, on n'autorise qu'UN SEUL retry par probe_error (isProbeRetry).
          // Si le retry probe-errore à son tour → dossier suivant.
          const canRetry =
            probeErrType === "session_expired"
              ? !isProbeRetry                          // 1 retry pour récupérer une nouvelle redirectUrl
              : !isProbeRetry;                         // 1 retry (5e clic si 504 persiste)

          if (canRetry) {
            logger.warn(
              `  ⚡ Probe ${probeErrType} sur #${dossier.index} ${dossier.vowintRef} ` +
              `(clics restants: ${remaining}) — clic compté, retry même dossier dans 3s…`,
            );
            botLog({
              applicationId: logApplicationId,
              step: "cev_dossier_probe_error_retry",
              status: "warn",
              data: {
                dossier: dossier.vowintRef,
                dossierIndex: dossier.index,
                probeErrType,
                remaining,
                action: "retry_same_dossier",
              },
            });
            probeRetryDossier = dossier; // forcer le même dossier au prochain tour
            nextScanAllowedAt = Date.now() + 3_000;
            continue;
          }

          // 2e probe_error consécutive (ou quota + TooMany) → dossier suivant
          consecutiveTransient++;
          const transientDelayMsProbe = Math.min(30_000, 2_000 * 2 ** Math.min(consecutiveTransient - 1, 4));
          logger.warn(
            `  ⚡ Probe ${probeErrType} (2e consécutive ou quota épuisé) sur #${dossier.index} ` +
            `${dossier.vowintRef} — passage au dossier suivant dans ${Math.round(transientDelayMsProbe / 1000)}s`,
          );
          botLog({
            applicationId: logApplicationId,
            step: "cev_dossier_probe_error_skip",
            status: "warn",
            data: {
              dossier: dossier.vowintRef,
              dossierIndex: dossier.index,
              probeErrType,
              remaining,
              consecutiveTransient,
              action: "skip_next_dossier",
            },
          });
          nextScanAllowedAt = Date.now() + transientDelayMsProbe;
          continue;
        }

        case "limit_reached": {
          logger.warn(`  ⚠️ CAS 2 OVERVIEW — Limite de RDV atteinte pour ce dossier ${dossier.vowintRef}`);
          recordScan(uniqueJobId, dossier.vowintRef);
          localPool.recordClick(dossier);
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
                // Isoler par dossier pour ne pas affecter les autres dossiers du même compte
                invalidateVowintCache(vowintEmail, dossier.vowintRef);
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

      // Un scan est allé au bout (pas de coupure réseau) → le serveur répond de
      // nouveau normalement, on réarme le backoff des retries rapides.
      consecutiveTransient = 0;

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

      // ─── One-Shot: pause adaptative (schedule) avec jitter log-normal (anti-shadow-ban) ──
      // Utilise l'intervalle du schedule (haute/moyenne/basse densité) au lieu du fixe.
      // ─── Grille d'horloge murale synchronisée (tous comptes alignés sur le même front) ──
      // On dort jusqu'au prochain front absolu `ceil(now/tick)*tick` au lieu d'un sleep
      // relatif : tous les comptes détectent dans la MÊME fenêtre de tick → ils voient la
      // même publication à l'instant T, puis se répartissent les créneaux (allocation
      // déterministe + claim). Le jitter déterministe par compte casse la régularité.
      const effectiveIntervalMs = scheduleDecision.intervalMs || intervalMs;
      const finalSleepMs = cevMsUntilNextTick(Date.now(), effectiveIntervalMs, gridSeed);
      nextScanAllowedAt = Date.now() + finalSleepMs;
      logger.info(`Grille: prochain front dans ${Math.round(finalSleepMs / 1000)}s (tick: ${Math.round(effectiveIntervalMs / 1000)}s, band: ${scheduleDecision.bandLabel}, jitterPct: ${CEV_GRID_JITTER_PCT})`);

    } catch (loopErr) {
      logger.error(`Erreur loop: ${loopErr}`);
      state.errors++;
      
      // Sécurité anti-spam en cas d'erreur consécutive ou de crash (évite de marteler le serveur)
      const safetyPauseMs = 45000;
      nextScanAllowedAt = Math.max(nextScanAllowedAt, Date.now() + safetyPauseMs);
      logger.info(`Erreur détectée. Prochain scan planifié au plus tôt dans ${Math.round((nextScanAllowedAt - Date.now()) / 1000)}s.`);
    }
  }

  // Libérer la réservation d'IP Redis pour que le créneau IP redevienne disponible
  // à un autre compte (ou à ce compte au prochain démarrage).
  if (reservedDecodoBaseUrl) {
    await releaseCevIp(reservedDecodoBaseUrl, String(accountId)).catch(() => {});
  }

  logger.info( "═══ CEV Dossier Loop v3 arrêté ═══");
}


/** Expose l'�tat pour monitoring */
export function getCevDossierState() {
  return { ...state, pool: null };
}





