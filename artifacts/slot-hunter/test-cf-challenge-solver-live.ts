/**
 * test-cf-challenge-solver-live.ts — Test live du cf-challenge-solver.ts
 *
 * Vérifie que le solver Puppeteer natif résout RÉELLEMENT un challenge Cloudflare
 * sur citaconsular.es (portail Espagne protégé par CF Managed Challenge).
 *
 * Le test :
 *   1. Lance Puppeteer-extra + stealth plugin (headless)
 *   2. Configure un proxy résidentiel (Decodo ISP)
 *   3. Navigue vers le widget citaconsular.es
 *   4. Appelle solveCfChallenge() et mesure le résultat
 *   5. Vérifie que cf_clearance est obtenu
 *   6. Fait un GET post-clearance pour confirmer que la session est valide
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx test-cf-challenge-solver-live.ts
 *
 * Requires : DECODO_PROXY_URL dans .env (proxy ISP/résidentiel)
 *            CAPSOLVER_API_KEY optionnel (fallback CapSolver)
 */

import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  detectChallengeType,
  solveCfChallenge,
  type CfSolveResult,
} from "./src/cf-challenge-solver.js";

// ─── Plugin stealth ──────────────────────────────────────────────────────────
puppeteer.use(StealthPlugin());

// ─── Config ──────────────────────────────────────────────────────────────────

const TARGET_URL =
  process.env.SPAIN_TEST_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

const DECODO_PROXY_URL = process.env.DECODO_PROXY_URL ?? "";

// ─── Couleurs ────────────────────────────────────────────────────────────────
const C = {
  GREEN:  "\x1b[32m",
  RED:    "\x1b[31m",
  YELLOW: "\x1b[33m",
  CYAN:   "\x1b[36m",
  BOLD:   "\x1b[1m",
  DIM:    "\x1b[2m",
  RESET:  "\x1b[0m",
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
  header("TEST CF-CHALLENGE-SOLVER — citaconsular.es");

  // ── Vérifications préalables ──
  log("🔍", "Vérifications préalables…", C.CYAN);

  const proxy = parseProxy(DECODO_PROXY_URL);
  if (!proxy) {
    log("❌", "DECODO_PROXY_URL manquant ou invalide dans .env", C.RED);
    log("ℹ️", "Le test nécessite un proxy résidentiel/ISP pour contourner CF", C.YELLOW);
    process.exit(1);
  }
  log("✅", `Proxy: ${proxy.server} (user: ${proxy.username.slice(0, 6)}…)`, C.GREEN);

  const hasCapSolver = !!process.env.CAPSOLVER_API_KEY;
  log(hasCapSolver ? "✅" : "⚠️",
    `CapSolver: ${hasCapSolver ? "disponible (fallback activé)" : "absent (pas de fallback)"}`,
    hasCapSolver ? C.GREEN : C.YELLOW,
  );

  log("🎯", `Cible: ${TARGET_URL.slice(0, 70)}…`, C.CYAN);

  // ── Lancer Puppeteer ──
  log("🚀", "Lancement Puppeteer (headless + stealth + proxy)…", C.CYAN);
  const t0 = Date.now();

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--proxy-server=${proxy.server}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
      "--lang=fr-FR",
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  let page: any;
  let result: CfSolveResult | null = null;

  try {
    page = await browser.newPage();

    // Authentification proxy
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });

    // User-Agent Chrome 136 cohérent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    );

    // Locale + timezone Espagne
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    const launchMs = Date.now() - t0;
    log("✅", `Puppeteer lancé en ${launchMs}ms`, C.GREEN);

    // ── Navigation vers la cible ──
    log("🌐", `Navigation vers citaconsular.es…`, C.CYAN);
    const navT0 = Date.now();

    try {
      await page.goto(TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (navErr: any) {
      // CF challenge pages souvent timeout car elles ne finissent jamais de charger
      log("⚠️", `Navigation timeout/erreur (attendu pour CF): ${navErr.message?.slice(0, 80)}`, C.YELLOW);
    }

    const navMs = Date.now() - navT0;
    const pageTitle = await page.title().catch(() => "?");
    const pageUrl = page.url();
    log("📄", `Page chargée en ${navMs}ms — titre: "${pageTitle}"`, C.CYAN);
    log("🔗", `URL: ${pageUrl.slice(0, 80)}`, C.CYAN);

    // ── Étape 1 : Détection du type de challenge ──
    log("🔍", "Détection du type de challenge CF…", C.CYAN);
    const challengeType = await detectChallengeType(page);
    log("🏷️", `Type détecté: ${C.BOLD}${challengeType}${C.RESET}`, C.CYAN);

    if (challengeType === "none") {
      log("✅", "Pas de challenge CF — page déjà accessible (IP de confiance)", C.GREEN);
      const cookies = await page.cookies();
      const cf = cookies.find((c: any) => c.name === "cf_clearance");
      if (cf) {
        log("🍪", `cf_clearance déjà présent: ${cf.value.slice(0, 40)}…`, C.GREEN);
      }

      // Vérifier le contenu de la page
      const bodyText = await page.evaluate(() => document.body?.textContent?.trim().slice(0, 200) ?? "");
      log("📝", `Contenu page: "${bodyText.slice(0, 100)}…"`, C.CYAN);

      result = {
        success: true,
        challengeType: "none",
        cfClearance: cf?.value,
        durationMs: Date.now() - t0,
        solvedBy: "already_cleared",
      };
    } else if (challengeType === "blocked") {
      log("❌", "IP bloquée par Cloudflare — Access Denied", C.RED);
      result = {
        success: false,
        challengeType: "blocked",
        durationMs: Date.now() - t0,
        error: "IP blocked",
      };
    } else {
      // ── Étape 2 : Résolution du challenge ──
      log("🔓", `Résolution du challenge ${challengeType}…`, C.CYAN);
      log("⏱️", "Timeout: 120s (JSD passif + Turnstile clic + CapSolver fallback)", C.DIM);

      const solveT0 = Date.now();
      result = await solveCfChallenge(page, {
        timeout: 120_000,
        targetUrl: TARGET_URL,
        maxTurnstileClicks: 5,
        clickRetryDelay: 3_000,
        enableCapsolverFallback: hasCapSolver,
      });
      const solveMs = Date.now() - solveT0;

      if (result.success) {
        log("✅", `Challenge résolu en ${Math.round(solveMs / 1000)}s via ${result.solvedBy}`, C.GREEN);
        if (result.cfClearance) {
          log("🍪", `cf_clearance: ${result.cfClearance.slice(0, 40)}…`, C.GREEN);
        }
        if (result.allCookies?.length) {
          log("🍪", `Total cookies: ${result.allCookies.length} — ${result.allCookies.map(c => c.name).join(", ")}`, C.CYAN);
        }
      } else {
        log("❌", `Échec résolution: ${result.error}`, C.RED);
        log("🏷️", `Type final: ${result.challengeType}`, C.RED);
      }
    }

    // ── Étape 3 : Vérification post-clearance ──
    if (result?.success && result.cfClearance) {
      log("🔄", "Vérification post-clearance — GET page avec cf_clearance…", C.CYAN);
      try {
        // Recharger la page pour vérifier que cf_clearance fonctionne
        await page.goto(TARGET_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const postTitle = await page.title().catch(() => "?");
        const postUrl = page.url();
        const postBody = await page.evaluate(
          () => document.body?.textContent?.trim().slice(0, 300) ?? "",
        ).catch(() => "");

        const isStillChallenge = postTitle.toLowerCase().includes("just a moment") ||
                                  postTitle.toLowerCase().includes("un instant");

        if (isStillChallenge) {
          log("⚠️", `Post-clearance: toujours un challenge CF (titre: "${postTitle}")`, C.YELLOW);
          log("⚠️", "Le cf_clearance obtenu n'est peut-être pas valide pour cette IP/TLS session", C.YELLOW);
        } else {
          log("✅", `Post-clearance OK — titre: "${postTitle}"`, C.GREEN);
          log("📝", `Contenu: "${postBody.slice(0, 120)}…"`, C.CYAN);

          // Chercher des indices de contenu Bookitit
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
      const screenshotPath = `debug_dumps/cf-solver-test-${Date.now()}.png`;
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
  console.log(`  Statut:        ${status}${C.RESET}`);
  console.log(`  Type challenge: ${result?.challengeType ?? "?"}`);
  console.log(`  Stratégie:     ${result?.solvedBy ?? "aucune"}`);
  console.log(`  cf_clearance:  ${result?.cfClearance ? result.cfClearance.slice(0, 50) + "…" : "absent"}`);
  console.log(`  Durée totale:  ${Math.round(totalMs / 1000)}s`);
  console.log(`  Cookies:       ${result?.allCookies?.length ?? 0}`);
  console.log(`  Proxy:         ${proxy.server}`);
  console.log(`  CapSolver:     ${hasCapSolver ? "oui (fallback)" : "non"}`);
  console.log();

  process.exit(result?.success ? 0 : 1);
}

// ─── Entry ───────────────────────────────────────────────────────────────────
runTest().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
