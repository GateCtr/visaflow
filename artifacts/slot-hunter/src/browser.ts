import { chromium as baseChromium } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page, LaunchOptions } from "playwright";

const playwrightChromium = addExtra(baseChromium);
playwrightChromium.use(StealthPlugin());

const PROXY_URL = process.env.PROXY_URL;
const DRY_RUN = process.env.DRY_RUN === "true";

// UAs desktop uniquement — les portails consulaires sont desktop-only.
// Les UAs mobiles (iPhone/Android) combinés à un viewport desktop (1280+px)
// sont immédiatement détectés comme bots par le fingerprinting UA+viewport.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0",
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
];

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

export async function launchBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const ua = randomUserAgent();
  const viewport = randomViewport();

  const proxyConfig = PROXY_URL
    ? { server: PROXY_URL }
    : undefined;

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
    locale: "fr-FR",
    timezoneId: "Africa/Kinshasa",
    extraHTTPHeaders: {
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["fr-FR", "fr", "en-US", "en"] });
    (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
  });

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
