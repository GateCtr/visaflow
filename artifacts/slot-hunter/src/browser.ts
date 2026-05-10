import { chromium as baseChromium } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page, LaunchOptions } from "playwright";
import { ProxyPool } from "./proxyPool.js";

const playwrightChromium = addExtra(baseChromium);
playwrightChromium.use(StealthPlugin());

const PROXY_URL = process.env.PROXY_URL;
const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL;
const DRY_RUN = process.env.DRY_RUN === "true";

// ProxyPool centralisé (src/proxyPool.ts — inliné depuis proxy-service pour éviter
// les problèmes de résolution workspace sur Railway).
// initialize(ip) est appelé au démarrage dans index.ts :
//   → refresh immédiat de la whitelist 2captcha
//   → boucle auto-refresh toutes les 25 min (pas de whitelist manuelle requise)
// Fallback automatique : IPROYAL_PROXY_URL → 2captcha pool → PROXY_URL statique → connexion directe.
export const proxyPool = new ProxyPool(process.env.TWOCAPTCHA_API_KEY ?? "");

// ─── User-Agents desktop uniquement ─────────────────────────────────────────
// Règle : UA desktop exclusivement. UA mobile + viewport desktop = détection bot
// immédiate par fingerprinting UA+viewport.
// Versions alignées sur avril 2026 : Chrome 134-136, Edge 134, Firefox 136,
// Safari 18, Opera 120. Profils variés : Windows/macOS/Linux, navigateurs différents.
// ⚠️ À mettre à jour environ tous les 6 mois quand Chrome dépasse +10 versions.
const USER_AGENTS = [
  // Chrome sur Windows 10/11
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  // Edge sur Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
  // Chrome sur macOS (Chromium rapporte toujours 10_15_7 sur toutes versions macOS — comportement normal)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  // Safari sur macOS Sequoia
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  // Firefox sur Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  // Opera sur Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 OPR/120.0.0.0",
  // Chrome sur Linux (type bureau Ubuntu)
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
];

// ─── Rotation UA sans répétition consécutive ─────────────────────────────────
// Utilise un "deck mélangé" : chaque UA est utilisé une fois par cycle avant
// de recommencer. Garantit qu'on ne tombe jamais deux fois de suite sur le même UA.
class UaRotator {
  private queue: string[] = [];
  private lastUsed: string | null = null;

  next(): string {
    if (this.queue.length === 0) {
      // Recharger et mélanger le deck
      this.queue = [...USER_AGENTS].sort(() => Math.random() - 0.5);
    }
    // Si la tête du deck est le même UA que le précédent, on le déplace en fin
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

export interface BrowserOverrides {
  locale?: string;
  timezoneId?: string;
  acceptLanguage?: string;
  /** Forcer la connexion directe même si PROXY_URL est configuré (ex: retry après ERR_PROXY_CONNECTION_FAILED) */
  forceNoProxy?: boolean;
}

export async function launchBrowser(overrides?: BrowserOverrides): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const ua = randomUserAgent();
  const viewport = randomViewport();

  // Priorité : iProyal résidentiel > 2captcha pool > PROXY_URL statique > connexion directe
  // forceNoProxy: true → bypass proxy même si configuré (retry après ERR_PROXY_CONNECTION_FAILED)
  const forceNoProxy = overrides?.forceNoProxy ?? false;
  let proxyAddress: string | undefined;
  if (!forceNoProxy) {
    if (IPROYAL_PROXY_URL) {
      proxyAddress = IPROYAL_PROXY_URL;
    } else if (proxyPool.isConfigured) {
      const poolResult = await proxyPool.getProxy();
      proxyAddress = poolResult?.proxy ?? PROXY_URL;
    } else {
      proxyAddress = PROXY_URL;
    }
  }
  const proxyConfig = proxyAddress ? { server: proxyAddress } : undefined;

  const locale         = overrides?.locale         ?? "fr-FR";
  const timezoneId     = overrides?.timezoneId     ?? "Africa/Kinshasa";
  const acceptLanguage = overrides?.acceptLanguage ?? "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7";

  // Dériver le tableau navigator.languages depuis la locale fournie
  const langParts = locale.split("-");
  const navLanguages = overrides?.locale
    ? [locale, langParts[0], "en-US", "en"].filter((v, i, a) => a.indexOf(v) === i)
    : ["fr-FR", "fr", "en-US", "en"];

  const launchArgs: string[] = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=" + viewport.width + "," + viewport.height,
  ];

  const launchOptions: LaunchOptions = {
    headless: true,
    args: launchArgs,
    proxy: proxyConfig,
  };
  const browser = await playwrightChromium.launch(launchOptions) as unknown as Browser;

  const context = await browser.newContext({
    userAgent: ua,
    viewport,
    locale,
    timezoneId,
    extraHTTPHeaders: { "Accept-Language": acceptLanguage },
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
  });

  await context.addInitScript((langs: string[]) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => langs });
    (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
  }, navLanguages);

  const page = await context.newPage();

  return { browser, context, page };
}

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
    await page.mouse.wheel(0, delta);
    await randomDelay(300, 800);
  }
}

export function isDryRun(): boolean {
  return DRY_RUN;
}
