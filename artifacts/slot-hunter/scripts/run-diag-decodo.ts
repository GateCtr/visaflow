/**
 * run-diag-decodo.ts — Lance le diagnostic CF avec le proxy Decodo ISP forcé
 * Bypasse la logique CSV/SOAX du script original
 */
import "dotenv/config";
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

function parseArgs(): { portal: string; headed: boolean } {
  const args = process.argv.slice(2);
  let portal = "kinshasa";
  let headed = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--portal" && args[i + 1]) { portal = args[++i]; }
    if (args[i] === "--headed") { headed = true; }
  }
  return { portal, headed };
}

async function main(): Promise<void> {
  const { portal, headed } = parseArgs();
  const portalConfig = PORTALS[portal];
  if (!portalConfig) { console.error(`❌ Portail inconnu: ${portal}`); process.exit(1); }

  // ── Proxy: Decodo ISP forcé depuis .env ──────────────────────────────────
  const proxyUrl = process.env.DECODO_PROXY_URL;
  if (!proxyUrl) { console.error("❌ DECODO_PROXY_URL absent dans .env"); process.exit(1); }

  let parsed: URL;
  try { parsed = new URL(proxyUrl); } catch { console.error("❌ URL proxy invalide"); process.exit(1); }
  const proxyServer = `http://${parsed.hostname}:${parsed.port || "10010"}`;
  const proxyAuth = { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };

  console.log("═".repeat(70));
  console.log("  DIAGNOSTIC CF CHALLENGE SOLVER — Decodo ISP");
  console.log("═".repeat(70));
  console.log(`  Portail  : ${portalConfig.name}`);
  console.log(`  URL      : ${portalConfig.url}`);
  console.log(`  Proxy    : ${parsed.hostname}:${parsed.port} (user: ${proxyAuth.username.slice(0, 8)}…)`);
  console.log(`  Mode     : ${headed ? "headed (visible)" : "headless"}`);
  console.log(`  CapSolver: ${process.env.CAPSOLVER_API_KEY ? "✅ disponible" : "❌ absent"}`);
  console.log("");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  const browser = await (puppeteer as any).launch({
    headless: !headed,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      `--proxy-server=${proxyServer}`,
      "--window-size=1280,800",
      "--disable-dev-shm-usage",
      "--lang=fr-FR",
    ],
  }) as Browser;

  const pages = await browser.pages();
  const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.authenticate(proxyAuth);
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8" });
  page.on("dialog", async (d: any) => { await d.accept().catch(() => {}); });

  // Client Hints CDP
  try {
    const cdp = await page.createCDPSession();
    await cdp.send("Network.setUserAgentOverride", {
      userAgent: UA,
      acceptLanguage: "fr-FR,fr;q=0.9",
      userAgentMetadata: {
        brands: [{ brand: "Not A;Brand", version: "99" }, { brand: "Chromium", version: "136" }, { brand: "Google Chrome", version: "136" }],
        fullVersion: "136.0.0.0", platform: "Windows", platformVersion: "10.0.0",
        architecture: "x86", model: "", mobile: false,
      },
    });
    await cdp.detach().catch(() => {});
    console.log("  ✅ CDP Client Hints alignés (Chrome/136 Windows)");
  } catch (e) { console.warn(`  ⚠️ CDP (non-fatal): ${e}`); }

  // ── Navigation ──────────────────────────────────────────────────────────
  console.log(`\n── Navigation ──────────────────────────────────────────────────────`);
  const navUrl = `${portalConfig.url}?_cb=${Date.now()}`;
  console.log(`  🌐 ${navUrl.slice(0, 80)}…`);
  const t0 = Date.now();

  try {
    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 70_000 });
  } catch (e: any) {
    console.warn(`  ⚠️ Timeout nav (non-fatal): ${e.message?.slice(0, 100)}`);
  }

  const navMs = Date.now() - t0;
  const currentUrl = page.url();

  if (currentUrl.startsWith("chrome-error://") || currentUrl === "about:blank") {
    console.error(`  ❌ Page d'erreur Chrome (${currentUrl}) — proxy inaccessible`);
    // Test connectivité directe
    console.log("  🔄 Tentative sans proxy (test direct)…");
    await page.authenticate({ username: "", password: "" });
    try {
      await page.goto("https://ifconfig.me/ip", { waitUntil: "load", timeout: 20_000 });
      const ip = await page.evaluate(() => document.body?.textContent?.trim() ?? "");
      console.log(`  📍 IP directe: ${ip}`);
    } catch (e2) {
      console.error("  ❌ Connexion directe aussi impossible");
    }
    await browser.close();
    return;
  }

  console.log(`  ✅ Chargé en ${Math.round(navMs / 1000)}s — URL: ${currentUrl.slice(0, 80)}`);
  console.log(`  📄 Titre: "${await page.title().catch(() => "?")}"`);

  // ── Détection ───────────────────────────────────────────────────────────
  console.log(`\n── Détection du challenge ─────────────────────────────────────────`);
  const challengeType: CfChallengeType = await detectChallengeType(page);
  console.log(`  🏷️  Type: ${challengeType}`);

  const preCookies = await page.cookies().catch(() => [] as any[]);
  const cfPre = preCookies.find((c: any) => c.name === "cf_clearance");
  console.log(`  🍪 cf_clearance pré-solve: ${cfPre ? cfPre.value.slice(0, 40) + "…" : "absent"}`);
  console.log(`  🍪 ${preCookies.length} cookies: ${preCookies.map((c: any) => c.name).join(", ")}`);

  // ── Résolution ──────────────────────────────────────────────────────────
  console.log(`\n── Résolution challenge CF ────────────────────────────────────────`);
  const solveResult: CfSolveResult = await solveCfChallenge(page, {
    timeout: 90_000,
    targetUrl: portalConfig.url,
    maxTurnstileClicks: 5,
    clickRetryDelay: 2_500,
    enableCapsolverFallback: !!process.env.CAPSOLVER_API_KEY,
    geoTimezone: "Europe/Madrid",
  });

  // ── Rapport ─────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log("  RAPPORT FINAL");
  console.log("═".repeat(70));
  console.log(`  Résultat       : ${solveResult.success ? "✅ SUCCÈS" : "❌ ÉCHEC"}`);
  console.log(`  Type challenge : ${solveResult.challengeType}`);
  console.log(`  Résolu par     : ${solveResult.solvedBy ?? "n/a"}`);
  console.log(`  Durée          : ${Math.round(solveResult.durationMs / 1000)}s`);
  if (solveResult.cfClearance) console.log(`  cf_clearance   : ${solveResult.cfClearance.slice(0, 50)}…`);
  if (solveResult.error) console.log(`  Erreur         : ${solveResult.error}`);
  if (solveResult.allCookies?.length) {
    console.log(`  Cookies (${solveResult.allCookies.length}):`);
    for (const c of solveResult.allCookies) {
      console.log(`    ${c.name}: ${String(c.value).slice(0, 50)}`);
    }
  }

  // Post-solve : widget Bookitit
  if (solveResult.success) {
    console.log("\n── Vérification post-solve ─────────────────────────────────────────");
    try {
      await page.goto(portalConfig.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const postTitle = await page.title().catch(() => "?");
      const w = await page.evaluate(() => ({
        hasJquery: typeof (window as any).jQuery === "function",
        hasBkt: typeof (window as any).bkt_init_widget === "object",
        bodyLen: document.body?.innerHTML?.length ?? 0,
        isChallenge: document.title.toLowerCase().includes("moment"),
      })).catch(() => ({ hasJquery: false, hasBkt: false, bodyLen: 0, isChallenge: false }));
      console.log(`  📄 Titre post-solve: "${postTitle}"`);
      console.log(`  jQuery: ${w.hasJquery ? "✅" : "❌"} | bkt_init_widget: ${w.hasBkt ? "✅" : "❌"} | body: ${w.bodyLen}B`);
      console.log(`  CF encore actif: ${w.isChallenge ? "⚠️ OUI" : "✅ NON"}`);
    } catch (e: any) {
      console.warn(`  ⚠️ Post-solve: ${e.message?.slice(0, 80)}`);
    }
  }

  try {
    const ts = Date.now();
    await page.screenshot({ path: `debug_dumps/cf-diag-${ts}.png`, fullPage: false });
    console.log(`  📸 Screenshot: debug_dumps/cf-diag-${ts}.png`);
  } catch { /* non-fatal */ }

  await browser.close();
  console.log("\n  🔋 Browser fermé.");
  process.exit(solveResult.success ? 0 : 1);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(2); });
