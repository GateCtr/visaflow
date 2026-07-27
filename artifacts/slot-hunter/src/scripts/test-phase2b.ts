/**
 * test-phase2b.ts — Test isolé de la Phase 2b de solveSpainWidgetSession
 *
 * Ce script reproduit exactement la séquence Phase 2b :
 *   1. CapSolver → seed cf_clearance (même IP Decodo)
 *   2. Playwright + seed → widget servi directement (seededClearanceAccepted)
 *   3. Reload sans cf_clearance → observer ce que CF présente réellement
 *   4. Screenshot + dump HTML à chaque étape
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   CAPSOLVER_API_KEY=xxx DECODO_PROXY_URL=http://user:pass@host:port \
 *     node_modules/.bin/tsx src/scripts/test-phase2b.ts
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as fs from "fs";
import * as path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const WIDGET_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
const CAPSOLVER_BASE = "https://api.capsolver.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY;
const DECODO_PROXY_URL = process.env.DECODO_PROXY_URL;

const OUT_DIR = path.join(process.cwd(), "test-phase2b-output");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function capsolverSolve(
  url: string,
  apiKey: string,
  proxyUrl: string,
): Promise<string | null> {
  log("CAPSOLVER", `createTask AntiCloudflareTask → ${url}`);
  const parsed = new URL(proxyUrl);
  const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: "AntiCloudflareTask",
        websiteURL: url,
        proxy: `http://${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}@${parsed.hostname}:${parsed.port || "5000"}`,
      },
    }),
  });
  const createBody = (await createRes.json()) as any;
  if (createBody.errorId !== 0) {
    log("CAPSOLVER", `❌ createTask error: ${createBody.errorDescription}`);
    return null;
  }
  const taskId = createBody.taskId as string;
  log("CAPSOLVER", `Task créée: ${taskId}`);

  for (let i = 1; i <= 60; i++) {
    await sleep(3000);
    const pollRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const pollBody = (await pollRes.json()) as any;
    if (pollBody.status === "ready") {
      const token = pollBody.solution?.token as string | undefined;
      if (token) {
        log("CAPSOLVER", `✅ Résolu en ${i * 3}s — cf_clearance: ${token.slice(0, 30)}…`);
        return token;
      }
      log("CAPSOLVER", `❌ ready mais pas de token: ${JSON.stringify(pollBody.solution)}`);
      return null;
    }
    if (pollBody.status === "failed" || pollBody.errorId !== 0) {
      log("CAPSOLVER", `❌ Task failed: ${pollBody.errorDescription}`);
      return null;
    }
    if (i % 5 === 0) log("CAPSOLVER", `Poll #${i} — ${pollBody.status}`);
  }
  log("CAPSOLVER", "❌ Timeout 3min");
  return null;
}

function parseProxy(proxyUrl: string) {
  const p = new URL(proxyUrl);
  return {
    server: `http://${p.hostname}:${p.port}`,
    username: decodeURIComponent(p.username),
    password: decodeURIComponent(p.password),
  };
}

async function saveScreenshot(page: any, name: string) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  log("SCREENSHOT", `Sauvegardé → ${file}`);
}

async function dumpHtml(page: any, name: string) {
  const html = await page.content().catch(() => "(erreur)");
  const file = path.join(OUT_DIR, `${name}.html`);
  fs.writeFileSync(file, html);
  log("HTML", `Sauvegardé → ${file} (${html.length} chars)`);
  return html;
}

// ─── Analyse du contenu de la page ───────────────────────────────────────────

function analyzePageContent(html: string) {
  const checks = {
    "Formulaire token (interstitiel CF)": /input[^>]+name="token"/.test(html),
    "Just a moment (CF)": /just a moment/i.test(html),
    "iframe Turnstile (challenges.cloudflare)": /challenges\.cloudflare\.com/.test(html),
    "iframe Turnstile (cf-challenge-hcaptcha)": /cf-challenge/.test(html),
    "cdn-cgi/challenge-platform JS": /cdn-cgi\/challenge-platform/.test(html),
    "Widget citaconsular (hosteds)": /hosteds/.test(html),
    "JSD Oneshot": /jsd\/oneshot/.test(html),
    "Managed Challenge (mc.js)": /challenge-platform.*mc\.js/.test(html),
  };
  for (const [label, found] of Object.entries(checks)) {
    log("ANALYZE", `${found ? "✅" : "❌"} ${label}`);
  }
  return checks;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!CAPSOLVER_API_KEY) throw new Error("CAPSOLVER_API_KEY manquant");
  if (!DECODO_PROXY_URL) throw new Error("DECODO_PROXY_URL manquant");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  log("INIT", `Output dir: ${OUT_DIR}`);
  log("INIT", `Widget URL: ${WIDGET_URL}`);
  log("INIT", `Proxy: ${new URL(DECODO_PROXY_URL).hostname}:${new URL(DECODO_PROXY_URL).port}`);

  // ─── Étape 1 : CapSolver → seed cf_clearance ────────────────────────────
  log("STEP1", "=== CapSolver solve ===");
  const seedToken = await capsolverSolve(WIDGET_URL, CAPSOLVER_API_KEY!, DECODO_PROXY_URL!);
  if (!seedToken) {
    log("STEP1", "❌ CapSolver échoué — impossible de continuer");
    process.exit(1);
  }

  // ─── Setup Playwright ────────────────────────────────────────────────────
  const chromiumStealth = chromium as any;
  chromiumStealth.use((StealthPlugin as any)());

  const isHeadlessEnv = !process.env.DISPLAY;
  log("SETUP", `headless=${isHeadlessEnv} (DISPLAY=${process.env.DISPLAY ?? "non défini"})`);

  const proxy = parseProxy(DECODO_PROXY_URL!);
  const browser = await chromiumStealth.launch({
    headless: isHeadlessEnv,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-position=80,60",
      "--window-size=1280,720",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    proxy,
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });

  try {
    const page = await context.newPage();

    // Fingerprint patches
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(window, "screenX", { get: () => 80 });
      Object.defineProperty(window, "screenY", { get: () => 60 });
      Object.defineProperty(window, "outerWidth", { get: () => 1280 });
      Object.defineProperty(window, "outerHeight", { get: () => 720 });
      Object.defineProperty(screen, "width", { get: () => 1920 });
      Object.defineProperty(screen, "height", { get: () => 1080 });
    });

    // JSD listener
    let jsdCaptured = false;
    let jsdCfClearance: string | null = null;
    page.on("request", (req: any) => {
      if (req.url().includes("/jsd/oneshot/")) {
        jsdCaptured = true;
        log("JSD", `✅ Requête JSD Oneshot observée: ${req.url().slice(0, 80)}…`);
      }
    });
    page.on("response", async (res: any) => {
      try {
        if (res.url().includes("/jsd/oneshot/")) {
          const headers = res.headers();
          const setCookie = headers["set-cookie"] ?? "";
          const match = /cf_clearance=([^;]+)/.exec(setCookie);
          if (match) {
            jsdCfClearance = match[1]!;
            log("JSD", `✅ JSD Oneshot Set-Cookie cf_clearance: ${jsdCfClearance!.slice(0, 30)}…`);
          } else {
            log("JSD", `ℹ️ JSD status ${res.status()} — pas de Set-Cookie cf_clearance`);
          }
        }
      } catch {}
    });

    // ─── Étape 2 : Injecter seed + naviguer ──────────────────────────────
    log("STEP2", "=== Navigation avec seed CapSolver ===");
    await context.addCookies([
      {
        name: "cf_clearance",
        value: seedToken,
        domain: ".citaconsular.es",
        path: "/",
      },
    ]);
    log("STEP2", "🍪 Seed injecté");

    await page.goto(WIDGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(5000);
    await saveScreenshot(page, "step2-after-seed-navigation");
    const html2 = await dumpHtml(page, "step2-after-seed-navigation");
    log("STEP2", "--- Analyse contenu après navigation avec seed ---");
    analyzePageContent(html2);
    log("STEP2", `jsdCaptured=${jsdCaptured}, jsdCfClearance=${jsdCfClearance?.slice(0, 20) ?? "null"}`);

    const cookies2 = await context.cookies();
    const cf1 = cookies2.find((c: any) => c.name === "cf_clearance");
    log("STEP2", `cf_clearance dans jar: ${cf1 ? cf1.value.slice(0, 30) + "…" : "❌ absent"}`);

    // ─── Étape 3 : Phase 2b — Reload sans cf_clearance ───────────────────
    log("STEP3", "=== PHASE 2B : Reload sans cf_clearance ===");

    const cookiesBefore = await context.cookies();
    log("STEP3", `Cookies avant suppression: ${cookiesBefore.map((c: any) => c.name).join(", ")}`);

    const cookiesWithoutCf = cookiesBefore.filter((c: any) => c.name !== "cf_clearance");
    await context.clearCookies();
    if (cookiesWithoutCf.length > 0) {
      await context.addCookies(
        cookiesWithoutCf.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path ?? "/",
          secure: c.secure ?? false,
          sameSite: (c.sameSite ?? "Lax") as "Strict" | "Lax" | "None",
        })),
      );
    }
    log("STEP3", `Cookies après suppression cf_clearance: ${cookiesWithoutCf.map((c: any) => c.name).join(", ")}`);

    // Reset JSD flag
    jsdCaptured = false;
    jsdCfClearance = null;

    log("STEP3", "🔄 Reload…");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(3000);

    await saveScreenshot(page, "step3-immediately-after-reload");
    const html3a = await dumpHtml(page, "step3-immediately-after-reload");
    log("STEP3", "--- Analyse immédiatement après reload ---");
    analyzePageContent(html3a);

    // Attente passive 15s pour voir si CF résout seul (Managed Challenge headless)
    log("STEP3", "⏳ Attente 15s — CF Managed Challenge (résolution passive)…");
    for (let i = 1; i <= 15; i++) {
      await sleep(1000);
      if (jsdCaptured) {
        log("STEP3", `✅ JSD capturé à t+${i}s !`);
        break;
      }
    }

    await saveScreenshot(page, "step3-after-15s-wait");
    const html3b = await dumpHtml(page, "step3-after-15s-wait");
    log("STEP3", "--- Analyse après 15s d'attente ---");
    analyzePageContent(html3b);
    log("STEP3", `jsdCaptured=${jsdCaptured}, jsdCfClearance=${jsdCfClearance?.slice(0, 20) ?? "null"}`);

    const cookies3 = await context.cookies();
    const cf3 = cookies3.find((c: any) => c.name === "cf_clearance");
    log("STEP3", `cf_clearance dans jar après reload+wait: ${cf3 ? cf3.value.slice(0, 30) + "…" : "❌ absent"}`);

    // Chercher formulaire token
    const tokenInput = page.locator('input[name="token"]').first();
    const hasTokenForm = (await tokenInput.count()) > 0;
    log("STEP3", `Formulaire token présent: ${hasTokenForm}`);

    // Chercher iframe Turnstile
    const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
    const hasTurnstile = (await turnstileIframe.count()) > 0;
    log("STEP3", `Iframe Turnstile présente: ${hasTurnstile}`);

    // ─── Étape 4 : si Managed Challenge — attente longue (60s) ───────────
    if (!jsdCaptured && !hasTokenForm && !hasTurnstile) {
      log("STEP4", "=== Managed Challenge détecté — attente longue 60s ===");
      log("STEP4", "CF Managed Challenge est JS-only, résolution automatique en headless…");
      for (let i = 1; i <= 60; i++) {
        await sleep(1000);
        if (jsdCaptured) {
          log("STEP4", `✅ JSD capturé à t+${i}s !`);
          break;
        }
        const cookies4 = await context.cookies();
        const cf4 = cookies4.find((c: any) => c.name === "cf_clearance");
        if (cf4 && cf4.value !== (cf1?.value ?? "")) {
          log("STEP4", `✅ Nouveau cf_clearance apparu à t+${i}s: ${cf4.value.slice(0, 30)}…`);
          break;
        }
        if (i % 10 === 0) {
          log("STEP4", `t+${i}s — pas encore de cf_clearance/JSD`);
          await saveScreenshot(page, `step4-t${i}s`);
        }
      }
    }

    // ─── Résumé final ─────────────────────────────────────────────────────
    const finalCookies = await context.cookies();
    const finalCf = finalCookies.find((c: any) => c.name === "cf_clearance");
    await saveScreenshot(page, "step-final");
    const htmlFinal = await dumpHtml(page, "step-final");

    console.log("\n");
    log("RÉSULTAT", "========== RÉSUMÉ PHASE 2B ==========");
    log("RÉSULTAT", `JSD Oneshot observé: ${jsdCaptured ? "✅ OUI" : "❌ NON"}`);
    log("RÉSULTAT", `JSD cf_clearance #2 capturé: ${jsdCfClearance ? "✅ OUI — " + jsdCfClearance.slice(0, 30) + "…" : "❌ NON"}`);
    log("RÉSULTAT", `cf_clearance final dans jar: ${finalCf ? "✅ OUI — " + finalCf.value.slice(0, 30) + "…" : "❌ NON"}`);
    log("RÉSULTAT", `Screenshots et HTML → ${OUT_DIR}`);
    log("RÉSULTAT", "======================================");

  } finally {
    await browser.close();
    log("DONE", "Instance fermée.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
