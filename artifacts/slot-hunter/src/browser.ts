import { chromium as baseChromium } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page, LaunchOptions } from "playwright";

const playwrightChromium = addExtra(baseChromium);
playwrightChromium.use(StealthPlugin());

const PROXY_URL = process.env.PROXY_URL;
const DRY_RUN = process.env.DRY_RUN === "true";

// ─── 2Captcha Proxy Pool ─────────────────────────────────────────────────────
// Mode whitelist : le serveur détecte sa propre IP au démarrage → appelle l'API
// 2captcha avec cette IP → reçoit N IPs résidentielles réelles → rotation.
//
// Prérequis (Railway) :
//   1. TWOCAPTCHA_API_KEY  → clé API 2captcha (variable Railway)
//   2. IP du serveur whitelistée dans le dashboard 2captcha (manuellement, une fois)
//      Si l'IP Railway change → re-whitelister la nouvelle IP (visible dans les logs)
//
// Fallback automatique : PROXY_URL statique → connexion directe (aucun crash).
class ProxyPool {
  private pool: string[] = [];
  private lastRefresh = 0;
  private serverIp: string | null = null;
  private whitelistError = false;
  private whitelistErrorAt: number | null = null;
  private readonly REFRESH_MS = 25 * 60_000; // 25 min (IPs ~30 min de validité)
  private readonly WHITELIST_RETRY_MS = 30 * 60_000; // retry whitelist après 30 min sans redémarrage
  private readonly POOL_SIZE = 50;

  /** Appelé au démarrage par index.ts après détection de l'IP publique */
  setServerIp(ip: string): void {
    this.serverIp = ip;
  }

  get isConfigured(): boolean {
    return !!(process.env.TWOCAPTCHA_API_KEY && this.serverIp);
  }

  async getProxy(): Promise<string | undefined> {
    if (!this.isConfigured) return undefined;

    if (this.whitelistError) {
      if (this.whitelistErrorAt !== null && Date.now() - this.whitelistErrorAt > this.WHITELIST_RETRY_MS) {
        console.log(`[ProxyPool] ⏱ 30 min écoulées depuis erreur whitelist — nouvelle tentative automatique...`);
        this.whitelistError = false;
        this.whitelistErrorAt = null;
        this.pool = [];
      } else {
        return undefined;
      }
    }

    if (this.pool.length < 5 || Date.now() - this.lastRefresh > this.REFRESH_MS) {
      await this.refresh();
    }

    if (this.pool.length === 0) return undefined;

    const proxy = this.pool.shift()!;
    this.pool.push(proxy);
    return `http://${proxy}`;
  }

  private async refresh(): Promise<void> {
    try {
      const key = process.env.TWOCAPTCHA_API_KEY!;
      const ip  = this.serverIp!;
      const url = `https://api.2captcha.com/proxy/generate_white_list_connections` +
        `?key=${key}&protocol=http&connection_count=${this.POOL_SIZE}&ip=${encodeURIComponent(ip)}`;

      const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const json = await res.json() as { status: string; request?: string; data?: string[] };

      if (json.status === "OK" && Array.isArray(json.data) && json.data.length > 0) {
        this.pool = [...json.data].sort(() => Math.random() - 0.5);
        this.lastRefresh = Date.now();
        this.whitelistError = false;
        console.log(`[ProxyPool] ✅ ${this.pool.length} IPs résidentielles 2captcha chargées`);
      } else if (json.request?.includes("IP_NOT_WHITELISTED") || json.request?.includes("NOT_WHITELISTED")) {
        this.whitelistError = true;
        this.whitelistErrorAt = Date.now();
        console.error(`[ProxyPool] ❌ IP ${ip} non whitelistée dans 2captcha!`);
        console.error(`[ProxyPool] → Allez sur 2captcha.com/proxy → "IP whitelist" → Ajoutez: ${ip}`);
        console.error(`[ProxyPool] → Proxy désactivé jusqu'au prochain redémarrage`);
      } else {
        console.error(`[ProxyPool] ❌ Refresh échoué: ${JSON.stringify(json)}`);
      }
    } catch (err) {
      console.error(`[ProxyPool] ❌ Erreur réseau: ${err}`);
    }
  }
}

export const proxyPool = new ProxyPool();

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
}

export async function launchBrowser(overrides?: BrowserOverrides): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const ua = randomUserAgent();
  const viewport = randomViewport();

  // Priorité : 2captcha pool résidentiel > PROXY_URL statique > connexion directe
  const proxyAddress = proxyPool.isConfigured
    ? await proxyPool.getProxy()
    : PROXY_URL;
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
