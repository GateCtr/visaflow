/**
 * test-cf-solver-robust.ts — Test live du cf-challenge-solver ROBUSTE
 *
 * Teste la nouvelle fonction solveCfChallengeWithRetry() qui combine :
 *   • Stealth enrichi (WebGL, plugins, Client Hints CDP, webdriver patch)
 *   • Purge des données CF stales avant chaque tentative
 *   • Cache-bust CDN pour des nonces JSD fraîches
 *   • Retry avec rotation d'IP proxy (Decodo pool ou sessionid)
 *   • Clic Turnstile CDP humanisé + fallback CapSolver
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-cf-solver-robust.ts
 *
 * Variables d'environnement :
 *   DECODO_PROXY_URL   Proxy ISP/résidentiel (recommandé mais optionnel)
 *   CAPSOLVER_API_KEY  Clé CapSolver (fallback optionnel)
 *   MAX_RETRIES        Nombre max de tentatives (défaut: 3)
 *   HEADLESS           "false" pour voir le navigateur (défaut: true)
 */

import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  solveCfChallengeWithRetry,
  detectChallengeType,
  type CfSolveResult,
} from "../src/cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ─── Config ──────────────────────────────────────────────────────────────────

const TARGET_URL =
  process.env.SPAIN_TEST_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

const DECODO_PROXY_URL = process.env.DECODO_PROXY_URL ?? "";
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? "3", 10);
const HEADLESS = process.env.HEADLESS !== "false";

// ─── Couleurs ────────────────────────────────────────────────────────────────
const C = {
  GREEN: "\x1b[32m", RED: "\x1b[31m", YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m", BOLD: "\x1b[1m", DIM: "\x1b[2m", RESET: "\x1b[0m",
};

function log(icon: string, msg: string, color = C.RESET) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${C.DIM}[${ts}]${C.RESET} ${color}${icon}  ${msg}${C.RESET}`);
}

function header(title: string) {
  console.log(`\n${C.BOLD}${"═".repeat(70)}${C.RESET}`);
  console.log(`${C.BOLD}  ${title}${C.RESET}`);
  console.log(`${C.BOLD}${"═".repeat(70)}${C.RESET}\n`);
}

// ─── Proxy parsing ───────────────────────────────────────────────────────────

function parseProxy(proxyUrl: string): { server: string; username: string; password: string } | null {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return {
      server: `${u.protocol}//${u.hostname}:${u.port || "10001"}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch {
    return null;
  }
}

// ─── Test principal ──────────────────────────────────────────────────────────

async function runTest() {
  header("TEST CF-CHALLENGE-SOLVER ROBUSTE — citaconsular.es");

  // ── Vérifications préalables ──
  log("🔍", "Vérifications préalables…", C.CYAN);

  const proxy = parseProxy(DECODO_PROXY_URL);
  if (proxy) {
    log("✅", `Proxy: ${proxy.server} (user: ${proxy.username.slice(0, 6)}…)`, C.GREEN);
  } else {
    log("⚠️", "Pas de proxy configuré — test sans proxy (peut échouer sur CF)", C.YELLOW);
  }

  const hasCapSolver = !!process.env.CAPSOLVER_API_KEY;
  log(hasCapSolver ? "✅" : "⚠️",
    `CapSolver: ${hasCapSolver ? "disponible (fallback activé)" : "absent (pas de fallback)"}`,
    hasCapSolver ? C.GREEN : C.YELLOW,
  );

  log("🎯", `Cible: ${TARGET_URL.slice(0, 70)}…`, C.CYAN);
  log("🔄", `Max retries: ${MAX_RETRIES}`, C.CYAN);
  log("🖥️", `Headless: ${HEADLESS}`, C.CYAN);

  // ── Lancer Puppeteer ──
  log("🚀", "Lancement Puppeteer (stealth + proxy)…", C.CYAN);
  const t0 = Date.now();

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-webgl",
    "--disable-v8-code-cache",
    "--disable-crash-reporter",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1920,1080",
    "--lang=fr-FR",
  ];

  if (proxy) {
    launchArgs.push(`--proxy-server=${proxy.server}`);
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: launchArgs,
    defaultViewport: { width: 1920, height: 1080 },
  });

  let result: CfSolveResult | null = null;

  try {
    const page = (await browser.pages())[0] ?? await browser.newPage();

    // Authentification proxy (si proxy avec credentials dans --proxy-server)
    if (proxy) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    const launchMs = Date.now() - t0;
    log("✅", `Puppeteer lancé en ${launchMs}ms`, C.GREEN);

    // ── Résolution robuste avec retry ──
    log("🔓", `Résolution CF robuste (max ${MAX_RETRIES} tentatives)…`, C.CYAN);

    result = await solveCfChallengeWithRetry(page, browser, {
      targetUrl: TARGET_URL,
      maxRetries: MAX_RETRIES,
      proxyUrl: DECODO_PROXY_URL || undefined,
      timeout: 90_000,
      maxTurnstileClicks: 5,
      clickRetryDelay: 3_000,
      enableCapsolverFallback: hasCapSolver,
      purgeStaleData: true,
      cacheBustCdn: true,
    });

    // ── Vérification post-clearance ──
    if (result.success && result.cfClearance) {
      log("🔄", "Vérification post-clearance — GET page avec cf_clearance…", C.CYAN);
      try {
        await page.goto(TARGET_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const postTitle = await page.title().catch(() => "?");
        const postBody = await page.evaluate(
          () => document.body?.textContent?.trim().slice(0, 300) ?? "",
        ).catch(() => "");

        const isStillChallenge = postTitle.toLowerCase().includes("just a moment") ||
                                  postTitle.toLowerCase().includes("un instant");

        if (isStillChallenge) {
          log("⚠️", `Post-clearance: toujours un challenge CF (titre: "${postTitle}")`, C.YELLOW);
        } else {
          log("✅", `Post-clearance OK — titre: "${postTitle}"`, C.GREEN);
          log("📝", `Contenu: "${postBody.slice(0, 120)}…"`, C.CYAN);

          const hasBookitit = postBody.includes("bookitit") || postBody.includes("Bookitit") ||
                              postBody.includes("cita") || postBody.includes("disponible");
          if (hasBookitit) {
            log("🎉", "Contenu Bookitit détecté — session CF VALIDE", C.GREEN);
          }
        }
      } catch (err: any) {
        log("⚠️", `Vérification post-clearance échouée: ${err.message?.slice(0, 80)}`, C.YELLOW);
      }
    }

    // ── Screenshot diagnostic ──
    try {
      const screenshotPath = `debug_dumps/cf-solver-robust-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: false });
      log("📸", `Screenshot: ${screenshotPath}`, C.DIM);
    } catch { /* non-fatal */ }

  } catch (err: any) {
    log("💥", `Erreur fatale: ${err.message}`, C.RED);
    console.error(err.stack);
    result = {
      success: false,
      challengeType: "unknown",
      durationMs: Date.now() - t0,
      error: err.message,
    };
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Rapport final ──
  header("RAPPORT FINAL");

  const totalMs = Date.now() - t0;
  const status = result?.success ? `${C.GREEN}✅ SUCCÈS` : `${C.RED}❌ ÉCHEC`;
  console.log(`  Statut:         ${status}${C.RESET}`);
  console.log(`  Type challenge: ${result?.challengeType ?? "?"}`);
  console.log(`  Stratégie:      ${result?.solvedBy ?? "aucune"}`);
  console.log(`  cf_clearance:   ${result?.cfClearance ? result.cfClearance.slice(0, 50) + "…" : "absent"}`);
  console.log(`  Durée totale:   ${Math.round(totalMs / 1000)}s`);
  console.log(`  Cookies:        ${result?.allCookies?.length ?? 0}`);
  console.log(`  Proxy:          ${proxy?.server ?? "aucun"}`);
  console.log(`  CapSolver:      ${hasCapSolver ? "oui (fallback)" : "non"}`);
  console.log(`  Max retries:    ${MAX_RETRIES}`);
  console.log();

  process.exit(result?.success ? 0 : 1);
}

// ─── Entry ───────────────────────────────────────────────────────────────────
runTest().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
