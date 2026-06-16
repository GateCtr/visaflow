import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page, CookieParam, Protocol } from "puppeteer";
import { ProxyPool } from "./proxyPool.js";

puppeteer.use(StealthPlugin());

const PROXY_URL           = process.env.PROXY_URL;
const IPROYAL_PROXY_URL   = process.env.IPROYAL_PROXY_URL;
const BRIGHTDATA_PROXY_URL = process.env.BRIGHTDATA_PROXY_URL;
const SOAX_PROXY_URL      = process.env.SOAX_PROXY_URL;
const DRY_RUN = process.env.DRY_RUN === "true";

export const proxyPool = new ProxyPool(process.env.TWOCAPTCHA_API_KEY ?? "");

// ─── User-Agents desktop uniquement ─────────────────────────────────────────
// Règle : UA desktop exclusivement. UA mobile + viewport desktop = détection bot
// immédiate par fingerprinting UA+viewport.
// Versions alignées sur juin 2026 : Chrome 147-148 (stable), Edge 148, Firefox 138,
// Safari 18, Opera 120. Profils variés : Windows/macOS/Linux.
// ⚠️ À mettre à jour environ tous les 3 mois quand Chrome dépasse +10 versions.
// UA Puppeteer — portails non-CEV (USA, Dubaï, Schengen, etc.)
// Règle : builds réels uniquement — le WAF détecte les .0.0.0 fictifs.
// Chrome 149 (stable juin 2026) en tête, Chrome 148 secondaire.
const USER_AGENTS = [
  // Chrome 149 stable Windows — version courante (juin 2026)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
  // Chrome 149 stable macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
  // Chrome 149 build patch variant
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.103 Safari/537.36",
  // Chrome 148 stable Windows — encore très répandu
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
  // Chrome 148 stable macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
  // Edge 148 stable Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36 Edg/148.0.2849.68",
  // Chrome 147 stable Windows — utilisateurs lents à mettre à jour
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7231.96 Safari/537.36",
  // Safari sur macOS Sequoia — diversité navigateur sur portails non-CEV
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  // Firefox sur Windows — diversité sur portails non-CEV
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
];

// ─── Rotation UA sans répétition consécutive ─────────────────────────────────
class UaRotator {
  private queue: string[] = [];
  private lastUsed: string | null = null;

  next(): string {
    if (this.queue.length === 0) {
      this.queue = [...USER_AGENTS].sort(() => Math.random() - 0.5);
    }
    if (this.lastUsed && this.queue[0] === this.lastUsed && this.queue.length > 1) {
      this.queue.push(this.queue.shift()!);
    }
    const ua = this.queue.shift()!;
    this.lastUsed = ua;
    return ua;
  }
}

const uaRotator = new UaRotator();

export function randomUserAgent(): string {
  return uaRotator.next();
}

export function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

// ─── Cookie type compatible Playwright ↔ Puppeteer ───────────────────────────
export interface CookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  url?: string;
}

// ─── PuppeteerContextAdapter ──────────────────────────────────────────────────
// Expose la même interface que Playwright BrowserContext pour que cevBooking.ts
// et les autres appelants n'aient pas besoin de changer leurs appels.
export class PuppeteerContextAdapter {
  private _initFns: Array<{ fn: Function | string; args: unknown[] }> = [];

  constructor(
    private _browser: Browser,
    private _page: Page,
    private _ua: string,
    private _viewport: { width: number; height: number },
    private _proxyAuth: { username: string; password: string } | undefined,
    private _extraHeaders: Record<string, string>,
  ) {}

  /** Crée et configure une nouvelle page (équivalent de context.newPage() Playwright). */
  async newPage(): Promise<Page> {
    const p = await this._browser.newPage();
    await p.setUserAgent(this._ua);
    await p.setViewport(this._viewport);
    await p.setExtraHTTPHeaders(this._extraHeaders);
    if (this._proxyAuth) await p.authenticate(this._proxyAuth);
    for (const { fn, args } of this._initFns) {
      await (p as any).evaluateOnNewDocument(fn, ...args);
    }
    return p;
  }

  /** Lit les cookies de la page courante (équivalent de context.cookies() Playwright). */
  async cookies(...urls: string[]): Promise<CookieLike[]> {
    const raw = await this._page.cookies(...urls) as Protocol.Network.Cookie[];
    return raw.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite as "Strict" | "Lax" | "None" | undefined,
    }));
  }

  /** Pose des cookies sur la page courante (équivalent de context.addCookies() Playwright). */
  async addCookies(cookies: CookieLike[]): Promise<void> {
    await this._page.setCookie(
      ...cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        url: c.url,
      }) as CookieParam),
    );
  }

  /**
   * Injecte un script d'init dans toutes les pages futures.
   * Équivalent de context.addInitScript() Playwright → evaluateOnNewDocument() Puppeteer.
   */
  async addInitScript(fn: Function | string, ...args: unknown[]): Promise<void> {
    this._initFns.push({ fn, args });
    await (this._page as any).evaluateOnNewDocument(fn, ...args);
  }

  /**
   * Attend l'ouverture d'une nouvelle page (popup/onglet).
   * Équivalent de context.waitForEvent('page', options) Playwright.
   * → browser.on('targetcreated') Puppeteer.
   */
  waitForEvent(event: string, options?: { timeout?: number }): Promise<Page> {
    if (event !== "page") throw new Error(`[PuppeteerContextAdapter] Unsupported event: ${event}`);
    const timeout = options?.timeout ?? 30_000;
    return new Promise<Page>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for new page (targetcreated)")),
        timeout,
      );
      this._browser.once("targetcreated" as any, async (target: any) => {
        if (target.type() === "page") {
          clearTimeout(timer);
          resolve(await target.page());
        }
      });
    });
  }

  /** Ferme le navigateur. */
  async close(): Promise<void> {
    await this._browser.close();
  }

  /** Accès direct au navigateur Puppeteer sous-jacent. */
  get browser(): Browser {
    return this._browser;
  }

  /**
   * Délègue les événements à la page Puppeteer sous-jacente.
   * Permet à netCapture.ts d'appeler context.on('request', ...) / context.on('response', ...).
   * Puppeteer intercepte request/response au niveau page (pas contexte) — compatible pour CEV.
   */
  on(event: string, listener: (...args: any[]) => void): void {
    (this._page as any).on(event, listener);
  }

  off(event: string, listener: (...args: any[]) => void): void {
    (this._page as any).off(event, listener);
  }
}

// ─── BrowserOverrides ─────────────────────────────────────────────────────────
export interface BrowserOverrides {
  locale?: string;
  timezoneId?: string;
  acceptLanguage?: string;
  /** Forcer la connexion directe même si un proxy est configuré (ex: retry après ERR_PROXY_CONNECTION_FAILED) */
  forceNoProxy?: boolean;
  /**
   * Forcer un proxy spécifique par nom :
   *   "brightdata" → BRIGHTDATA_PROXY_URL  (portail belge CEV — priorité 1)
   *   "iproyal"    → IPROYAL_PROXY_URL     (portail Espagne — priorité 2)
   *   "soax"       → SOAX_PROXY_URL        (résidentiel 191M IPs, ciblage ville)
   *   "2captcha"   → proxy résidentiel rotatif 2captcha (IP propre, bypass CF)
   *   "auto"       → sélection automatique (défaut)
   */
  proxySource?: "brightdata" | "iproyal" | "soax" | "2captcha" | "auto";
  /** Mode headless (true par défaut) */
  headless?: boolean;
}

// ─── launchBrowser ────────────────────────────────────────────────────────────
export async function launchBrowser(overrides?: BrowserOverrides): Promise<{
  browser: Browser;
  context: PuppeteerContextAdapter;
  page: Page;
}> {
  const ua = randomUserAgent();
  const viewport = randomViewport();

  // ── Résolution du proxy ───────────────────────────────────────────────────
  const forceNoProxy = overrides?.forceNoProxy ?? false;
  const proxySource  = overrides?.proxySource ?? "auto";
  let proxyAddress: string | undefined;

  if (!forceNoProxy) {
    if (proxySource === "brightdata" && BRIGHTDATA_PROXY_URL) {
      proxyAddress = BRIGHTDATA_PROXY_URL;
    } else if (proxySource === "iproyal" && IPROYAL_PROXY_URL) {
      proxyAddress = IPROYAL_PROXY_URL;
    } else if (proxySource === "soax" && SOAX_PROXY_URL) {
      proxyAddress = SOAX_PROXY_URL;
    } else if (proxySource === "2captcha" && proxyPool.isConfigured) {
      const poolResult = await proxyPool.getProxy();
      proxyAddress = poolResult?.proxy ?? PROXY_URL;
    } else {
      if (proxyPool.isConfigured) {
        const poolResult = await proxyPool.getProxy();
        proxyAddress = poolResult?.proxy ?? SOAX_PROXY_URL ?? IPROYAL_PROXY_URL ?? PROXY_URL;
      } else if (SOAX_PROXY_URL) {
        proxyAddress = SOAX_PROXY_URL;
      } else if (IPROYAL_PROXY_URL) {
        proxyAddress = IPROYAL_PROXY_URL;
      } else {
        proxyAddress = PROXY_URL;
      }
    }
  }

  const locale      = overrides?.locale      ?? "fr-FR";
  const timezoneId  = overrides?.timezoneId  ?? "Africa/Kinshasa";
  const defaultAcceptLang = (() => {
    const [lang, region] = locale.split("-");
    if (region) return `${locale},${lang};q=0.9,en-US;q=0.8,en;q=0.7`;
    return `${locale};q=0.9,en-US;q=0.8,en;q=0.7`;
  })();
  const acceptLanguage = overrides?.acceptLanguage ?? defaultAcceptLang;

  const langParts = locale.split("-");
  const navLanguages = overrides?.locale
    ? [locale, langParts[0], "en-US", "en"].filter((v, i, a) => a.indexOf(v) === i)
    : ["fr-FR", "fr", "en-US", "en"];

  // ── Puppeteer : proxy dans les args (--proxy-server) + authenticate() ──────
  const launchArgs: string[] = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    `--window-size=${viewport.width},${viewport.height}`,
  ];

  let proxyAuth: { username: string; password: string } | undefined;
  if (proxyAddress) {
    const parsed = parseProxyForPuppeteer(proxyAddress);
    if (parsed) {
      launchArgs.push(`--proxy-server=${parsed.server}`);
      if (parsed.username) {
        proxyAuth = { username: parsed.username, password: parsed.password ?? "" };
      }
    }
  }

  // BrightData intercepte TLS — ignoreHTTPSErrors via CDP après launch
  const ignoreTls = proxySource === "brightdata";
  if (ignoreTls) {
    launchArgs.push("--ignore-certificate-errors");
  }

  const browser = await (puppeteer as any).launch({
    headless: overrides?.headless ?? true,
    args: launchArgs,
    ignoreHTTPSErrors: ignoreTls,
    // Puppeteer timezoneId via CDP (set below per-page)
  }) as Browser;

  const page = await browser.newPage();
  await page.setUserAgent(ua);
  await page.setViewport(viewport);
  await page.setExtraHTTPHeaders({ "Accept-Language": acceptLanguage });
  if (proxyAuth) await page.authenticate(proxyAuth);

  // Timezone via CDP (Playwright l'expose en option contexte, Puppeteer via CDP)
  try {
    const client = await (page as any).target().createCDPSession();
    await client.send("Emulation.setTimezoneOverride", { timezoneId });
  } catch {
    // Non fatal si non supporté
  }

  // Init script — équivalent de context.addInitScript() Playwright
  const initFn = (langs: string[]) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => langs });

    // window.chrome enrichi — Chrome 148 expose app, csi, loadTimes, runtime complet.
    // Un { runtime: {} } nu est détecté instantanément par les WAF modernes.
    const noop = () => undefined;
    const noopObj = () => ({});
    (window as unknown as Record<string, unknown>).chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
        RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
        getDetails: noop,
        getIsInstalled: noop,
        runningState: noop,
      },
      csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000 + 200, tran: 15 }),
      loadTimes: () => ({
        requestTime: Date.now() / 1000 - Math.random() * 0.5,
        startLoadTime: Date.now() / 1000 - Math.random() * 0.4,
        commitLoadTime: Date.now() / 1000 - Math.random() * 0.3,
        finishDocumentLoadTime: Date.now() / 1000 - Math.random() * 0.2,
        finishLoadTime: Date.now() / 1000 - Math.random() * 0.1,
        firstPaintTime: 0,
        firstPaintAfterLoadTime: 0,
        navigationType: "Other",
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: "h2",
        wasAlternateProtocolAvailable: false,
        connectionInfo: "h2",
      }),
      runtime: {
        PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd" },
        PlatformArch: { ARM: "arm", ARM64: "arm64", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
        PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
        RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" },
        OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
        OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
        connect: noop,
        sendMessage: noop,
        id: undefined,
      },
      _: noopObj,
    };
  };

  await (page as any).evaluateOnNewDocument(initFn, navLanguages);

  const extraHeaders = { "Accept-Language": acceptLanguage };
  const context = new PuppeteerContextAdapter(browser, page, ua, viewport, proxyAuth, extraHeaders);

  return { browser, context, page };
}

// ─── Helpers humains ──────────────────────────────────────────────────────────

export async function randomDelay(minMs = 500, maxMs = 2000): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  await new Promise((r) => setTimeout(r, ms));
}

export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    const delay = 80 + Math.random() * 170;
    await page.keyboard.type(char, { delay });
    if (Math.random() < 0.05) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
    }
  }
}

export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = await page.$(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  const box = await el.boundingBox();
  if (!box) throw new Error(`Element has no bounding box: ${selector}`);

  const x = box.x + box.width / 2 + (Math.random() - 0.5) * 6;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * 4;

  await page.mouse.move(x - 50 + Math.random() * 20, y - 20 + Math.random() * 10);
  await randomDelay(100, 300);
  await page.mouse.move(x, y, { steps: 5 });
  await randomDelay(50, 150);
  await page.mouse.click(x, y);
}

export async function humanScroll(page: Page): Promise<void> {
  const scrolls = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < scrolls; i++) {
    const delta = 100 + Math.random() * 300;
    // Puppeteer : mouse.wheel prend un objet options (Playwright : args positionnels)
    await (page.mouse as any).wheel({ deltaY: delta });
    await randomDelay(300, 800);
  }
}

export function isDryRun(): boolean {
  return DRY_RUN;
}

// ─── iProyal Sticky Session ───────────────────────────────────────────────────

export function getIproyalSessionId(): string {
  return `j${new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "")}`;
}

export function buildStickyIproyalUrl(proxyUrl: string, sessionId?: string): string {
  try {
    if (!proxyUrl.includes("iproyal.com")) return proxyUrl;
    const u = new URL(proxyUrl);
    const decodedUser = decodeURIComponent(u.username);
    if (decodedUser.includes("_session-")) return proxyUrl;
    const sid = sessionId ?? getIproyalSessionId();
    const stickyUser = encodeURIComponent(`${decodedUser}_session-${sid}`);
    return `http://${stickyUser}:${u.password}@${u.host}`;
  } catch {
    return proxyUrl;
  }
}

/**
 * Parse une URL proxy pour Puppeteer.
 * Puppeteer: proxy via --proxy-server=HOST:PORT + page.authenticate({username, password})
 */
export function parseProxyForPuppeteer(
  proxyUrl: string,
): { server: string; username?: string; password?: string } | undefined {
  try {
    const url = new URL(proxyUrl.startsWith("http") ? proxyUrl : `http://${proxyUrl}`);
    const server = `${url.hostname}:${url.port || "8080"}`;
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    return { server, username, password };
  } catch {
    return undefined;
  }
}

/**
 * Alias pour compatibilité arrière (anciennement parseHttpProxyUrlForPlaywright).
 * Retourne le même objet { server, username, password }.
 */
export function parseHttpProxyUrlForPlaywright(
  proxyUrl: string,
): { server: string; username?: string; password?: string } | undefined {
  return parseProxyForPuppeteer(proxyUrl);
}

/** Alias court. */
export function parseProxyUrl(
  proxyUrl: string,
): { server: string; username?: string; password?: string } | undefined {
  return parseProxyForPuppeteer(proxyUrl);
}
