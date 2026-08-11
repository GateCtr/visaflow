/**
 * test-saopolo-browser-fetch.ts — Browser propre, résolution manuelle CF
 *
 * PAS de cf-challenge-solver. Le browser se lance, navigue, et ATTEND
 * que tu cliques le Turnstile manuellement. Ensuite POST+/main/ via fetch().
 * Objectif : confirmer si le 0B vient du cf-challenge-solver qui flag la session.
 */

import "dotenv/config";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import rebrowserPuppeteer from "rebrowser-puppeteer-core";
import type { Browser, Page } from "rebrowser-puppeteer-core";

const puppeteer = addExtra(rebrowserPuppeteer as any);
puppeteer.use(StealthPlugin());

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";
const ISP_PROXY_URL = process.env.SPAIN_ISP_PROXY_URL ?? "";
const isHeaded = process.env.SPAIN_HEADED === "1";

const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: string, msg: string): void {
  const icons: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

async function main(): Promise<void> {
  section("SAOPOLO — Browser propre + résolution manuelle CF");

  const proxyParsed = ISP_PROXY_URL ? (() => {
    try {
      const u = new URL(ISP_PROXY_URL);
      return { server: `${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    } catch { return null; }
  })() : null;

  log("INFO", `Proxy : ${proxyParsed ? proxyParsed.server : "(direct)"}`);
  log("INFO", `Mode  : headed (tu dois cliquer le Turnstile)`);

  // ═══ ÉTAPE 1 : Lancer browser et naviguer ═════════════════════════════════
  section("1 — Lancement browser + navigation (TU cliques le Turnstile)");

  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars", "--disable-dev-shm-usage",
    "--window-size=1366,768",
    "--no-first-run", "--no-default-browser-check",
    ...(proxyParsed ? [`--proxy-server=${proxyParsed.server}`] : []),
  ];

  const browser: Browser = await (puppeteer as any).launch({
    headless: false,
    channel: "chrome",
    args: launchArgs,
    protocolTimeout: 180_000,
  });

  const pages = await browser.pages();
  const page: Page = pages[0] ?? await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  // Auto-dismiss les dialogs JS (alert "Welcome / Bienvenido")
  page.on("dialog", async (dialog) => {
    log("INFO", `Dialog auto-dismiss: "${dialog.message().slice(0, 40)}"`);
    await dialog.accept();
  });

  // Proxy auth
  if (proxyParsed?.username) {
    await page.authenticate({ username: proxyParsed.username, password: proxyParsed.password });
  }

  log("STEP", `goto(${SAOPOLO_URL.slice(0, 55)}…)`);
  try {
    await page.goto(SAOPOLO_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (e) {
    log("WARN", `goto: ${String(e).slice(0, 50)}`);
  }

  // ═══ ATTENTE : tu cliques le Turnstile manuellement ═══════════════════════
  log("INFO", "");
  log("INFO", "╔══════════════════════════════════════════════════════════╗");
  log("INFO", "║  CLIQUE le checkbox Turnstile dans le navigateur !      ║");
  log("INFO", "║  Le script attend le cookie cf_clearance (max 120s)     ║");
  log("INFO", "╚══════════════════════════════════════════════════════════╝");
  log("INFO", "");

  // Attendre cf_clearance cookie (comme cf-challenge-solver fait)
  let cfResolved = false;
  for (let i = 0; i < 120; i++) {
    await new Promise<void>((r) => setTimeout(r, 1000));
    const cookies = await page.cookies();
    const cfClearance = cookies.find((c) => c.name === "cf_clearance");
    if (cfClearance) {
      log("OK", `cf_clearance détecté en ${i + 1}s ! (${cfClearance.value.slice(0, 25)}…)`);
      cfResolved = true;
      break;
    }
    if (i % 15 === 0 && i > 0) log("INFO", `Attente… (${i}s)`);
  }

  if (!cfResolved) {
    log("ERR", "cf_clearance non détecté après 120s");
    await browser.close();
    process.exit(1);
  }

  // Attendre que la page se recharge après le solve (CF redirige)
  log("STEP", "Attente page post-CF (widget ou reload)…");
  await new Promise<void>((r) => setTimeout(r, 3000));

  // Si on est encore sur la page challenge, reload
  const titleNow = await page.title().catch(() => "");
  if (!titleNow || /just a moment|un instant|verify/i.test(titleNow)) {
    log("INFO", "Reload pour charger le widget…");
    try {
      await page.goto(SAOPOLO_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch { /* non-fatal */ }
  }

  // Attendre le bouton Continuar
  try {
    await page.waitForSelector("#idCaptchaButton", { visible: true, timeout: 20_000 });
    log("OK", "Widget Continuar visible ✓");
  } catch {
    // Peut-être l'alert bloque — check title
    const t = await page.title().catch(() => "?");
    log("WARN", `Widget non visible (title: ${t}). Tentative dismiss + wait…`);
    await new Promise<void>((r) => setTimeout(r, 2000));
  }

  // Attendre JSD oneshot (background, ~5-8s)
  log("STEP", "Attente JSD oneshot (8s)…");
  await new Promise<void>((r) => setTimeout(r, 8000));

  // ═══ ÉTAPE 2 : Clic Continuar (natif) + intercepter /main/ JSONP ════════════
  section("2 — Clic Continuar natif + intercepter /main/ JSONP (loadermaec.js)");

  // Écouter la réponse /main/ AVANT de cliquer (le widget fera le JSONP naturellement)
  const mainResponsePromise = page.waitForResponse(
    (r: any) => {
      const u: string = r.url() ?? "";
      return u.includes("/onlinebookings/main/") || u.includes("/main/?callback=");
    },
    { timeout: 45_000 },
  ).then(async (r: any) => {
    const body = await r.text().catch(() => "");
    return { status: r.status(), length: body.length, preview: body.slice(0, 200) };
  }).catch((e: any) => ({ status: 0, length: 0, preview: `timeout: ${String(e).slice(0, 50)}` }));

  // Cliquer le bouton Continuar
  log("STEP", "Clic #idCaptchaButton (Continuar)…");
  await page.click("#idCaptchaButton").catch(() => {});

  // Dismiss l'éventuel alert "Welcome / Bienvenido" sur la page suivante
  await new Promise<void>((r) => setTimeout(r, 2000));

  // Attendre la réponse /main/ (le widget la fait naturellement via jQuery JSONP)
  log("STEP", "Attente réponse /main/ naturelle (jQuery JSONP, max 45s)…");
  const mainResult = await mainResponsePromise;

  // ═══ RÉSULTAT ═════════════════════════════════════════════════════════════
  section("RÉSULTAT");

  log("INFO", `/main/ → HTTP ${mainResult.status} | ${mainResult.length}B`);

  if (mainResult.length > 1000) {
    log("OK", `🎉🎉🎉 /main/ → ${mainResult.length}B — BOOKITIT FONCTIONNE !`);
    log("INFO", `Aperçu: ${mainResult.preview.slice(0, 100)}`);
    console.log("\n  ┌──────────────────────────────────────────────────────────────────┐");
    console.log("  │  SUCCÈS ! jQuery JSONP natif (loadermaec.js) passe.            │");
    console.log("  │  fetch() échouait. JSONP <script> fonctionne.                  │");
    console.log("  └──────────────────────────────────────────────────────────────────┘");
  } else if (mainResult.length === 0) {
    log("ERR", "/main/ → 0B — même le JSONP natif ne passe pas");
  } else {
    log("WARN", `/main/ → ${mainResult.length}B : ${mainResult.preview}`);
  }

  // Garder le browser ouvert pour inspection
  log("INFO", "Browser reste ouvert 15s…");
  await new Promise<void>((r) => setTimeout(r, 15_000));

  await browser.close();
  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
