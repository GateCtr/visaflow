/**
 * Découverte réseau pour le widget citaconsular (Espagne) : JS métier vs Cloudflare, candidats XHR/fetch.
 *
 * Bundle Bookitit local : `citaconsular_bundle/`. Synthèse : `Analyse Technique du Système de Rendez-vous - Citaconsular.es.md`.
 * API (JSONP) : voir `citaconsularBookitit.ts`.
 *
 * Sans passage du challenge, seuls les scripts CF / Turnstile apparaissent. En local :
 *   CITACONSULAR_HEADED=1 pnpm run es:citaconsular:discover
 *
 * Variables optionnelles : CITACONSULAR_URL, CITACONSULAR_MAX_WAIT_MS, CITACONSULAR_OUT, PROXY_URL
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { chromium as baseChromium } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "playwright";
import { randomUserAgent, randomViewport } from "./browser.js";

const playwrightChromium = addExtra(baseChromium);
playwrightChromium.use(StealthPlugin());

const DEFAULT_WIDGET =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/#services";

/** Titres / interstitiels Cloudflare (FR / EN / ES). */
const CF_TITLE =
  /un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i;

function isJsUrl(u: string): boolean {
  return /\.js(\?|$)/i.test(u) && !u.includes("chrome-extension");
}

function isCloudflareStack(u: string): boolean {
  return (
    u.includes("cdn-cgi/challenge-platform") ||
    u.includes("challenges.cloudflare.com") ||
    u.includes("/turnstile/")
  );
}

type ReqRow = { url: string; method: string; resourceType: string };

async function launch(headed: boolean): Promise<{ browser: Browser; page: Page }> {
  const ua = randomUserAgent();
  const viewport = randomViewport();
  const proxyServer = process.env.PROXY_URL;
  const browser = await playwrightChromium.launch({
    headless: !headed,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    proxy: proxyServer ? { server: proxyServer } : undefined,
  }) as unknown as Browser;

  const context = await browser.newContext({
    userAgent: ua,
    viewport,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    extraHTTPHeaders: { "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
    javaScriptEnabled: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["es-ES", "es", "en"] });
    (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
  });

  const page = await context.newPage();
  return { browser, page };
}

async function main(): Promise<void> {
  const headed = process.env.CITACONSULAR_HEADED === "1";
  const startUrl = process.env.CITACONSULAR_URL ?? DEFAULT_WIDGET;
  const maxWaitMs = Number(process.env.CITACONSULAR_MAX_WAIT_MS ?? 120_000);
  const outPath = process.env.CITACONSULAR_OUT ?? "citaconsular-discovery.json";

  const byUrl = new Map<string, ReqRow>();
  const { browser, page } = await launch(headed);

  page.on("request", (req) => {
    const url = req.url();
    if (!byUrl.has(url)) {
      byUrl.set(url, { url, method: req.method(), resourceType: req.resourceType() });
    }
  });

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

  const waitStart = Date.now();
  while (Date.now() - waitStart < maxWaitMs) {
    let title = "";
    try {
      title = await page.title();
    } catch {
      /* navigation en cours */
    }
    if (!CF_TITLE.test(title)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  await new Promise((r) => setTimeout(r, 5000));

  let finalTitle = "";
  try {
    finalTitle = await page.title();
  } catch {
    /* ignore */
  }
  let finalUrl = "";
  try {
    finalUrl = page.url();
  } catch {
    /* ignore */
  }

  const all = [...byUrl.values()];
  const jsUrls = [...new Set(all.filter((r) => isJsUrl(r.url)).map((r) => r.url))].sort();
  const jsAppBundles = jsUrls.filter((u) => !isCloudflareStack(u));
  const jsCloudflare = jsUrls.filter((u) => isCloudflareStack(u));

  const apiMap = new Map<string, ReqRow>();
  for (const r of all) {
    if (
      (r.resourceType === "xhr" || r.resourceType === "fetch") &&
      r.url.includes("citaconsular") &&
      !r.url.includes("/cdn-cgi/")
    ) {
      apiMap.set(r.url, r);
    }
  }
  const apiCandidates = [...apiMap.values()].sort((a, b) => a.url.localeCompare(b.url));

  const payload = {
    capturedAt: new Date().toISOString(),
    startUrl,
    finalUrl,
    title: finalTitle,
    cloudflareBlocking: CF_TITLE.test(finalTitle),
    stats: { requests: all.length, js: jsUrls.length },
    jsAppBundles,
    jsCloudflare,
    apiCandidates,
  };

  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        outPath,
        cloudflareBlocking: payload.cloudflareBlocking,
        title: finalTitle,
        stats: payload.stats,
      },
      null,
      2,
    ),
  );
  console.log("\n--- jsAppBundles (hors Cloudflare / Turnstile) ---\n");
  for (const u of jsAppBundles) console.log(u);
  if (jsAppBundles.length === 0 && payload.cloudflareBlocking) {
    console.log(
      "(vide tant que le challenge Cloudflare n’est pas passé — relancer avec CITACONSULAR_HEADED=1)",
    );
  }
  console.log("\n--- apiCandidates (xhr/fetch citaconsular, hors cdn-cgi) ---\n");
  for (const r of apiCandidates) console.log(`${r.method} ${r.url}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
