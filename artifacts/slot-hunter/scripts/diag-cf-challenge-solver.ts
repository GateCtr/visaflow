#!/usr/bin/env npx tsx
/**
 * diag-cf-challenge-solver.ts — Diagnostic du solver CF unifié
 *
 * Teste la résolution de challenges Cloudflare sur citaconsular.es
 * en utilisant le module cf-challenge-solver.ts avec un Chromium stealth.
 *
 * Usage :
 *   npx tsx scripts/diag-cf-challenge-solver.ts [--portal kinshasa|saopolo] [--headed]
 *
 * Prérequis :
 *   - Proxy configuré via fichier CSV (decodo-proxies.csv) ou variables d'env
 *   - Chromium installé via Puppeteer
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import {
  solveCfChallenge,
  detectChallengeType,
  type CfSolveResult,
  type CfChallengeType,
} from "../src/cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ─── Portails ────────────────────────────────────────────────────────────────

const PORTALS: Record<string, { name: string; url: string }> = {
  kinshasa: {
    name: "Kinshasa (RDC)",
    url: "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/",
  },
  saopolo: {
    name: "São Paulo (Brésil)",
    url: "https://www.citaconsular.es/pt/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/",
  },
};

// ─── Proxy CSV ──────────────────────────────────────────────────────────────

function loadProxyFromCsv(): string | undefined {
  const defaultCsvPath = resolve(process.cwd(), "decodo-proxies.csv");
  const csvPath = process.env.DECODO_PROXY_FILE
    ? resolve(process.env.DECODO_PROXY_FILE)
    : defaultCsvPath;

  if (!existsSync(csvPath)) return undefined;

  try {
    const content = readFileSync(csvPath, "utf-8");
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 4) continue;
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(":");
      const url = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      console.log(`  📄 Proxy chargé depuis CSV : ${host}:${port} (user=${user})`);
      return url;
    }
  } catch (err) {
    console.warn(`  ⚠️ Erreur lecture CSV proxy : ${err}`);
  }
  return undefined;
}

function resolveProxyUrl(): string {
  const fromCsv = loadProxyFromCsv();
  if (fromCsv) return fromCsv;
  if (process.env.SOAX_PROXY_URL) return process.env.SOAX_PROXY_URL;
  if (process.env.DECODO_PROXY_URL) return process.env.DECODO_PROXY_URL;
  return "";
}

// ─── Args CLI ───────────────────────────────────────────────────────────────

function parseArgs(): { portal: string; headed: boolean } {
  const args = process.argv.slice(2);
  let portal = "kinshasa";
  let headed = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--portal" && args[i + 1]) {
      portal = args[i + 1].toLowerCase();
      i++;
    }
    if (args[i] === "--headed") {
      headed = true;
    }
  }

  return { portal, headed };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { portal, headed } = parseArgs();
  const portalConfig = PORTALS[portal];
  if (!portalConfig) {
    console.error(`❌ Portail inconnu: "${portal}". Disponibles: ${Object.keys(PORTALS).join(", ")}`);
    process.exit(1);
  }

  console.log("═".repeat(70));
  console.log("  DIAGNOSTIC CF CHALLENGE SOLVER — VisaFlow 2026");
  console.log("═".repeat(70));
  console.log(`  Portail    : ${portalConfig.name}`);
  console.log(`  URL        : ${portalConfig.url}`);
  console.log(`  Mode       : ${headed ? "headed (visible)" : "headless"}`);
  console.log("");

  // ── Étape 1 : Proxy ──────────────────────────────────────────────────────
  console.log("── Étape 1 : Configuration proxy ─────────────────────────────────");
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) {
    console.error("  ❌ Aucun proxy configuré. Fichier decodo-proxies.csv ou variable d'env requise.");
    process.exit(1);
  }

  let proxyServer: string;
  let proxyAuth: { username: string; password: string } | undefined;
  try {
    const parsed = new URL(proxyUrl);
    proxyServer = `http://${parsed.hostname}:${parsed.port || "10001"}`;
    if (parsed.username) {
      proxyAuth = {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };
    }
    console.log(`  ✅ Proxy configuré : ${parsed.hostname}:${parsed.port}`);
  } catch {
    console.error("  ❌ URL proxy invalide");
    process.exit(1);
  }

  // ── Étape 2 : Lancement Chromium ──────────────────────────────────────────
  console.log("");
  console.log("── Étape 2 : Lancement Chromium stealth ──────────────────────────");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

  let browser: Browser | null = null;
  try {
    browser = await (puppeteer as any).launch({
      headless: !headed,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        `--proxy-server=${proxyServer}`,
        "--window-size=1280,720",
        "--use-gl=angle",
        "--use-angle=swiftshader-webgl",
        "--enable-webgl",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-v8-code-cache",
        "--disable-crash-reporter",
      ],
    }) as Browser;
    console.log("  ✅ Chromium lancé");
  } catch (err) {
    console.error(`  ❌ Échec lancement Chromium: ${err}`);
    process.exit(1);
  }

  let page: Page | null = null;
  try {
    const pages = await browser.pages();
    page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Authentification proxy
    if (proxyAuth) {
      await page.authenticate(proxyAuth);
      console.log("  ✅ Authentification proxy configurée");
    }

    // UA + viewport
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    // Stealth patches avancés — même niveau que spain-persistent-browser.ts
    await (page as any).evaluateOnNewDocument(() => {
      // ── webdriver ────────────────────────────────────────────────────────
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });

      // ── Screen/Window geometry plausible ─────────────────────────────────
      Object.defineProperty(window, "screenX", { get: () => 80 });
      Object.defineProperty(window, "screenY", { get: () => 60 });
      Object.defineProperty(window, "outerWidth", { get: () => 1280 });
      Object.defineProperty(window, "outerHeight", { get: () => 720 });
      Object.defineProperty(screen, "width", { get: () => 1920 });
      Object.defineProperty(screen, "height", { get: () => 1080 });
      Object.defineProperty(screen, "availWidth", { get: () => 1920 });
      Object.defineProperty(screen, "availHeight", { get: () => 1040 });
      Object.defineProperty(screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(screen, "pixelDepth", { get: () => 24 });

      // ── Dialogs ─────────────────────────────────────────────────────────
      (window as any).alert = () => {};
      (window as any).confirm = () => true;
      (window as any).prompt = () => "";

      // ── Languages (CF vérifie navigator.languages) ──────────────────────
      Object.defineProperty(navigator, "languages", {
        get: () => ["fr-FR", "fr", "en-US", "en"],
        configurable: true,
      });
      Object.defineProperty(navigator, "language", {
        get: () => "fr-FR",
        configurable: true,
      });

      // ── Platform cohérent avec UA Windows ───────────────────────────────
      Object.defineProperty(navigator, "platform", {
        get: () => "Win32",
        configurable: true,
      });

      // ── navigator.plugins (Chrome réel a toujours le plugin PDF) ────────
      const fakePlugin = {
        name: "PDF Viewer",
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        length: 1,
        0: { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
      };
      const fakePlugin2 = {
        name: "Chrome PDF Viewer",
        description: "Portable Document Format",
        filename: "internal-pdf-viewer",
        length: 1,
        0: { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
      };
      const pluginArr = [fakePlugin, fakePlugin2] as any;
      pluginArr.item = (i: number) => pluginArr[i] ?? null;
      pluginArr.namedItem = (n: string) => pluginArr.find((p: any) => p.name === n) ?? null;
      pluginArr.refresh = () => {};
      Object.defineProperty(navigator, "plugins", { get: () => pluginArr, configurable: true });

      const mimeArr = [
        { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: fakePlugin },
      ] as any;
      mimeArr.item = (i: number) => mimeArr[i] ?? null;
      mimeArr.namedItem = (n: string) => mimeArr.find((m: any) => m.type === n) ?? null;
      Object.defineProperty(navigator, "mimeTypes", { get: () => mimeArr, configurable: true });

      // ── Permissions API → notifications = "prompt" ──────────────────────
      const origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
      if (origQuery) {
        (navigator.permissions as any).query = (params: any) => {
          if (params?.name === "notifications") {
            return Promise.resolve({ state: "prompt", onchange: null });
          }
          return origQuery(params);
        };
      }

      // ── WebGL renderer — cacher SwiftShader (signal headless VM) ────────
      const UNMASKED_VENDOR = 0x9245;
      const UNMASKED_RENDERER = 0x9246;
      const fakeVendor = "Intel Inc.";
      const fakeRenderer = "Intel(R) UHD Graphics 620";

      const patchWebGL = (Ctx: any) => {
        if (!Ctx) return;
        const orig = Ctx.prototype.getParameter;
        Ctx.prototype.getParameter = function (param: number) {
          if (param === UNMASKED_VENDOR) return fakeVendor;
          if (param === UNMASKED_RENDERER) return fakeRenderer;
          return orig.call(this, param);
        };
      };
      patchWebGL((window as any).WebGLRenderingContext);
      patchWebGL((window as any).WebGL2RenderingContext);

      // ── window.chrome enrichi ───────────────────────────────────────────
      const noop = () => undefined;
      (window as any).chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
          RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
          getDetails: noop, getIsInstalled: noop, runningState: noop,
        },
        csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000 + 200, tran: 15 }),
        loadTimes: () => ({
          requestTime: Date.now() / 1000 - 0.4,
          startLoadTime: Date.now() / 1000 - 0.35,
          commitLoadTime: Date.now() / 1000 - 0.3,
          finishDocumentLoadTime: Date.now() / 1000 - 0.2,
          finishLoadTime: Date.now() / 1000 - 0.1,
          firstPaintTime: 0, firstPaintAfterLoadTime: 0,
          navigationType: "Other",
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          npnNegotiatedProtocol: "h2", wasAlternateProtocolAvailable: false,
          connectionInfo: "h2",
        }),
        runtime: {
          PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd" },
          PlatformArch: { ARM: "arm", ARM64: "arm64", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
          PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
          RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" },
          OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
          OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
          connect: noop, sendMessage: noop, id: undefined,
        },
      };
    });
    page.on("dialog", async (dialog: any) => {
      console.log(`  💬 Dialog: "${dialog.message().slice(0, 60)}" → accept`);
      await dialog.accept().catch(() => {});
    });

    console.log(`  ✅ Page configurée (UA: ${UA.slice(0, 50)}…)`);

    // ── CDP Client Hints alignment ──────────────────────────────────────────
    // CF vérifie la cohérence UA string ↔ sec-ch-ua ↔ Sec-CH-UA-Platform
    try {
      const cdpUA = await page.createCDPSession();
      await cdpUA.send("Network.setUserAgentOverride", {
        userAgent: UA,
        acceptLanguage: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        userAgentMetadata: {
          brands: [
            { brand: "Not A;Brand", version: "99" },
            { brand: "Chromium", version: "149" },
            { brand: "Google Chrome", version: "149" },
          ],
          fullVersion: "149.0.7827.55",
          platform: "Windows",
          platformVersion: "10.0.0",
          architecture: "x86",
          model: "",
          mobile: false,
        },
      });
      await cdpUA.detach().catch(() => {});
      console.log("  ✅ Client Hints CDP alignés — Chrome/149 Windows");
    } catch (err) {
      console.warn(`  ⚠️ CDP setUserAgentOverride (non-fatal): ${err}`);
    }

    // ── Étape 3 : Navigation ────────────────────────────────────────────────
    console.log("");
    console.log("── Étape 3 : Navigation vers le portail ──────────────────────────");
    const navUrl = `${portalConfig.url}${portalConfig.url.includes("?") ? "&" : "?"}_cb=${Date.now()}`;
    console.log(`  🌐 Navigation vers : ${navUrl.slice(0, 80)}…`);

    const navStart = Date.now();
    try {
      await page.goto(navUrl, { waitUntil: "load", timeout: 70_000 });
    } catch (err) {
      console.warn(`  ⚠️ Navigation timeout (non-fatal): ${err}`);
    }
    const navMs = Date.now() - navStart;
    console.log(`  ✅ Page chargée en ${Math.round(navMs / 1000)}s`);

    // Vérifier si page d'erreur Chrome
    const currentUrl = page.url();
    if (currentUrl.startsWith("chrome-error://") || currentUrl.startsWith("about:")) {
      console.error(`  ❌ Page d'erreur Chrome: ${currentUrl}`);
      console.error("  → Vérifier la connectivité proxy");
      return;
    }

    const pageTitle = await page.title().catch(() => "?");
    console.log(`  📄 Titre: "${pageTitle}"`);
    console.log(`  📄 URL: ${currentUrl.slice(0, 80)}`);

    // ── Étape 4 : Détection du challenge ────────────────────────────────────
    console.log("");
    console.log("── Étape 4 : Détection du type de challenge CF ──────────────────");

    const challengeType: CfChallengeType = await detectChallengeType(page);
    const challengeLabels: Record<CfChallengeType, string> = {
      jsd: "🔧 JS Detection (PoW + fingerprint passif)",
      managed: "🎛️ Managed Challenge (JSD ou Turnstile, décidé par CF)",
      turnstile: "🔘 Turnstile Interactif (checkbox visible)",
      turnstile_invis: "👻 Turnstile Invisible (PoW silencieux)",
      iuam: "🛡️ Under Attack Mode (countdown 5s)",
      blocked: "🚫 IP Bloquée (Access Denied)",
      none: "✅ Aucun challenge (page accessible)",
      unknown: "❓ Type indéterminé",
    };
    console.log(`  ${challengeLabels[challengeType] ?? challengeType}`);

    // Cookies actuels
    const preCookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
    const cfPre = preCookies.find((c) => c.name === "cf_clearance");
    console.log(`  🍪 cf_clearance pré-solve: ${cfPre ? `${cfPre.value.slice(0, 30)}…` : "absent"}`);
    console.log(`  🍪 Cookies total: ${preCookies.length} (${preCookies.map((c) => c.name).join(", ")})`);

    // ── Étape 5 : Résolution du challenge ───────────────────────────────────
    console.log("");
    console.log("── Étape 5 : Résolution du challenge CF ──────────────────────────");

    const solveResult: CfSolveResult = await solveCfChallenge(page, {
      timeout: 90_000,
      targetUrl: portalConfig.url,
      maxTurnstileClicks: 5,
      clickRetryDelay: 2_500,
      enableCapsolverFallback: !!process.env.CAPSOLVER_API_KEY,
    });

    // ── Étape 6 : Rapport ───────────────────────────────────────────────────
    console.log("");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log("  RAPPORT DE DIAGNOSTIC");
    console.log("══════════════════════════════════════════════════════════════════");
    console.log(`  Résultat       : ${solveResult.success ? "✅ SUCCÈS" : "❌ ÉCHEC"}`);
    console.log(`  Type challenge : ${solveResult.challengeType}`);
    console.log(`  Résolu par     : ${solveResult.solvedBy ?? "n/a"}`);
    console.log(`  Durée          : ${Math.round(solveResult.durationMs / 1000)}s`);
    if (solveResult.cfClearance) {
      console.log(`  cf_clearance   : ${solveResult.cfClearance.slice(0, 40)}…`);
    }
    if (solveResult.error) {
      console.log(`  Erreur         : ${solveResult.error}`);
    }
    if (solveResult.allCookies) {
      console.log(`  Cookies total  : ${solveResult.allCookies.length}`);
      for (const c of solveResult.allCookies) {
        console.log(`    ${c.name}: ${c.value.slice(0, 40)}${c.value.length > 40 ? "…" : ""}`);
      }
    }

    // Post-solve : vérifier si le widget Bookitit s'est chargé
    if (solveResult.success) {
      console.log("");
      console.log("── Vérification post-solve ─────────────────────────────────────");
      const postTitle = await page.title().catch(() => "?");
      const postUrl = page.url();
      console.log(`  📄 Titre post-solve: "${postTitle}"`);
      console.log(`  📄 URL post-solve: ${postUrl.slice(0, 80)}`);

      // Vérifier si le widget Bookitit s'est chargé (jQuery + bkt_init_widget)
      const widgetLoaded = await page.evaluate(() => {
        return {
          hasJquery: typeof (window as any).jQuery === "function",
          hasBktInit: typeof (window as any).bkt_init_widget === "object",
          hasBackbone: typeof (window as any).Backbone !== "undefined",
          bodyLength: document.body?.innerHTML?.length ?? 0,
        };
      }).catch(() => ({ hasJquery: false, hasBktInit: false, hasBackbone: false, bodyLength: 0 }));

      console.log(`  jQuery        : ${widgetLoaded.hasJquery ? "✅" : "❌"}`);
      console.log(`  bkt_init_widget: ${widgetLoaded.hasBktInit ? "✅" : "❌"}`);
      console.log(`  Backbone      : ${widgetLoaded.hasBackbone ? "✅" : "❌"}`);
      console.log(`  Body HTML     : ${widgetLoaded.bodyLength}B`);
    }

    console.log("");
    console.log("══════════════════════════════════════════════════════════════════");

  } catch (err) {
    console.error(`  ❌ Erreur fatale: ${err}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      console.log("  🔋 Browser fermé.");
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
