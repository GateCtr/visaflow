/**
 * test-impit-full-flow.ts — Test hybride : cf-challenge-solver (browser) + Impit (HTTP)
 *
 * OBJECTIF : Résoudre CF via browser (une seule fois), puis reproduire le flow
 * widget Bookitit entièrement via Impit (HTTP pur) avec le cf_clearance obtenu.
 *
 * FLOW :
 *   Phase A — Browser (cf-challenge-solver) :
 *     Résout CF → exporte cf_clearance + cookies
 *
 *   Phase B — Impit pur (HTTP) :
 *     1. GET portail (avec cf_clearance) → PHPSESSID + token hidden
 *     2. POST portail (token) → session PHP initialisée + bkt_init_widget
 *     3. GET /onlinebookings/main/ (JSONP) → données réelles (126KB+)
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-impit-full-flow.ts
 *   SPAIN_HEADED=1 npx tsx src/scripts/test-impit-full-flow.ts
 */

import "dotenv/config";
import { Impit } from "impit";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import {
  solveCfChallengeWithRetry,
  setupProxyAuth,
} from "../cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ── Constants ─────────────────────────────────────────────────────────────────
const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";

// ── Logging ───────────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: string, msg: string): void {
  const icons: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

// ── Proxy resolution ──────────────────────────────────────────────────────────
function resolveProxy(): string | undefined {
  if (process.env.SPAIN_ISP_PROXY_URL?.trim()) return process.env.SPAIN_ISP_PROXY_URL.trim();
  if (process.env.DECODO_PROXY_URL?.trim()) return process.env.DECODO_PROXY_URL.trim();
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const csvPath = path.join(process.cwd(), "decodo-proxies.csv");
    const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const parts = lines[0].split(":");
      if (parts.length >= 4) {
        const [host, port, user, pass] = parts;
        return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      }
    }
  } catch { /* */ }
  return undefined;
}

// ── Cookie parser ─────────────────────────────────────────────────────────────
function extractSetCookies(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};
  const raw = headers.get("set-cookie") ?? "";
  // Headers.get returns comma-joined for multiple set-cookie
  for (const part of raw.split(/,(?=[^ ])/)) {
    const m = part.trim().match(/^([^=]+)=([^;]*)/);
    if (m) cookies[m[1]] = m[2];
  }
  return cookies;
}

function buildCookieString(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const proxyUrl = resolveProxy();
  const masked = proxyUrl ? proxyUrl.replace(/:([^@:]+)@/, ":***@").slice(0, 60) : "direct (no proxy)";

  section("TEST HYBRIDE — cf-challenge-solver → Impit flow Bookitit");
  log("INFO", `Proxy : ${masked}`);
  log("INFO", `Cible : ${SAOPOLO_URL.slice(0, 60)}…`);

  if (!proxyUrl) {
    log("ERR", "Proxy requis (SPAIN_ISP_PROXY_URL / DECODO_PROXY_URL / CSV)");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE A — Browser : résoudre CF et exporter cf_clearance
  // ═══════════════════════════════════════════════════════════════════════════
  section("PHASE A — Résolution CF via browser (cf-challenge-solver)");

  const proxyParsed = (() => {
    try {
      const u = new URL(proxyUrl);
      return { server: `${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    } catch { return null; }
  })();
  if (!proxyParsed) { log("ERR", "Proxy URL invalide"); process.exit(1); }

  const isHeaded = process.env.SPAIN_HEADED === "1";
  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled",
    "--disable-infobars", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader-webgl",
    "--enable-webgl", "--window-size=1366,768", "--disable-v8-code-cache", "--disable-crash-reporter",
    "--no-first-run", "--no-default-browser-check", `--proxy-server=${proxyParsed.server}`,
  ];

  log("STEP", "Lancement Chromium…");
  const browser: Browser = await (puppeteer as any).launch({
    headless: !isHeaded,
    args: launchArgs,
    slowMo: isHeaded ? 60 : 0,
    protocolTimeout: 180_000,
  });
  const pages = await browser.pages();
  const page: Page = pages[0] ?? await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  let cfClearance = "";
  let allCookies: Array<{ name: string; value: string }> = [];

  try {
    log("STEP", "solveCfChallengeWithRetry…");
    const cfResult = await solveCfChallengeWithRetry(page, browser, {
      targetUrl: SAOPOLO_URL,
      proxyUrl,
      maxRetries: 3,
      timeout: 90_000,
      cacheBustCdn: true,
      purgeStaleData: true,
    });

    if (!cfResult.success) {
      log("ERR", `CF solve échoué : ${cfResult.error}`);
      process.exit(1);
    }

    cfClearance = cfResult.cfClearance ?? "";
    allCookies = cfResult.allCookies ?? [];
    log("OK", `CF résolu — cf_clearance: ${cfClearance.slice(0, 30)}…`);
    log("INFO", `Cookies : ${allCookies.map((c) => c.name).join(", ")}`);
  } finally {
    await browser.close().catch(() => {});
    log("INFO", "Browser fermé (plus nécessaire)");
  }

  if (!cfClearance) {
    log("ERR", "cf_clearance vide — impossible de continuer");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE B — Impit pur avec cf_clearance injecté
  // ═══════════════════════════════════════════════════════════════════════════
  section("PHASE B — Impit HTTP pur (avec cf_clearance du browser)");

  const impit = new Impit({
    browser: "chrome",
    proxyUrl: proxyUrl || undefined,
  } as any);

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  const baseHeaders: Record<string, string> = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
  };

  // Injecter cf_clearance dans le jar
  const jar: Record<string, string> = { cf_clearance: cfClearance };
  // Ajouter les autres cookies CF
  for (const c of allCookies) {
    if (c.name !== "cf_clearance" && c.name !== "PHPSESSID") {
      jar[c.name] = c.value;
    }
  }

  // ─── ÉTAPE 1 : GET portail → PHPSESSID + token ──────────────────────────────
  section("ÉTAPE 1 — GET portail avec cf_clearance (PHPSESSID + token)");
  log("STEP", `GET ${SAOPOLO_URL.slice(0, 60)}…`);
  log("INFO", `Cookie injecté : cf_clearance=${cfClearance.slice(0, 20)}…`);

  const r1 = await impit.fetch(SAOPOLO_URL, {
    method: "GET",
    headers: {
      ...baseHeaders,
      "Cookie": buildCookieString(jar),
    },
  } as any) as unknown as Response;

  const body1 = await r1.text();
  const cookies1 = extractSetCookies(r1.headers);

  log("INFO", `HTTP ${r1.status} | ${body1.length}B`);
  log("INFO", `Set-Cookie : ${Object.keys(cookies1).join(", ") || "(aucun)"}`);

  // Stocker cookies
  Object.assign(jar, cookies1);

  // Si CF challenge page (pas le portail)
  if (body1.length < 2000 && /just a moment|checking|challenge/i.test(body1.slice(0, 500))) {
    log("ERR", "CF challenge bloque — cf_clearance nécessaire. Utiliser un proxy résidentiel ou ISP.");
    log("INFO", `Body[0:300] : ${body1.slice(0, 300)}`);
    process.exit(1);
  }

  // Extraire token hidden
  const tokenMatch = body1.match(/name="token"\s+value="([^"]+)"/i)
    ?? body1.match(/name='token'\s+value='([^']+)'/i)
    ?? body1.match(/id="token"[^>]*value="([^"]+)"/i);

  if (!tokenMatch) {
    log("ERR", "Token hidden non trouvé dans le HTML du portail");
    log("INFO", `Body[0:500] : ${body1.slice(0, 500)}`);
    // Chercher les formulaires
    const forms = body1.match(/<form[^>]*>/gi) ?? [];
    log("INFO", `Forms trouvés : ${forms.length}`);
    for (const f of forms.slice(0, 3)) log("INFO", `  ${f.slice(0, 100)}`);
    const inputs = body1.match(/<input[^>]*>/gi) ?? [];
    log("INFO", `Inputs trouvés : ${inputs.length}`);
    for (const i of inputs.slice(0, 5)) log("INFO", `  ${i.slice(0, 100)}`);
    process.exit(1);
  }

  const token = tokenMatch[1];
  log("OK", `Token extrait : ${token.slice(0, 30)}…`);
  log("INFO", `PHPSESSID : ${jar["PHPSESSID"]?.slice(0, 12) ?? "absent"}…`);
  log("INFO", `cf_clearance : ${jar["cf_clearance"]?.slice(0, 20) ?? "absent"}…`);

  // ─── ÉTAPE 2 : POST token → session PHP initialisée ────────────────────────
  section("ÉTAPE 2 — POST token (initialise session widget)");
  log("STEP", `POST ${SAOPOLO_URL.slice(0, 60)}… (token=${token.slice(0, 20)}…)`);

  const r2 = await impit.fetch(SAOPOLO_URL, {
    method: "POST",
    headers: {
      ...baseHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": buildCookieString(jar),
      "Referer": SAOPOLO_URL,
      "Origin": "https://www.citaconsular.es",
    },
    body: `token=${encodeURIComponent(token)}`,
    redirect: "follow",
  } as any) as unknown as Response;

  const body2 = await r2.text();
  const cookies2 = extractSetCookies(r2.headers);
  Object.assign(jar, cookies2);

  log("INFO", `HTTP ${r2.status} | ${body2.length}B`);
  log("INFO", `Set-Cookie : ${Object.keys(cookies2).join(", ") || "(aucun)"}`);

  // Extraire bkt_init_widget
  const bktMatch = body2.match(/var\s+bkt_init_widget\s*=\s*(\{[^}]+\})/);
  let bktWidget: Record<string, string> | null = null;

  if (bktMatch) {
    try {
      bktWidget = JSON.parse(bktMatch[1].replace(/'/g, '"'));
      log("OK", `bkt_init_widget extrait : ${Object.keys(bktWidget!).join(", ")}`);
    } catch (e) {
      log("WARN", `bkt_init_widget parse error : ${e}`);
    }
  } else {
    log("WARN", "bkt_init_widget non trouvé dans la réponse POST");
    // Chercher loadermaec ou bookitit
    const hasLoader = body2.includes("loadermaec") || body2.includes("bkt_init_widget");
    const hasBookitit = body2.includes("onlinebookings") || body2.includes("bookitit");
    log("INFO", `loadermaec: ${hasLoader}, bookitit: ${hasBookitit}`);
    log("INFO", `Body2[0:500] : ${body2.slice(0, 500)}`);
  }

  // ─── ÉTAPE 3 : GET /main/ JSONP ───────────────────────────────────────────
  section("ÉTAPE 3 — GET /main/ JSONP");

  // Construire l'URL comme jQuery le fait
  const params: Record<string, string> = bktWidget
    ? { ...bktWidget }
    : { type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34", lang: "es", version: "4" };
  delete params.srvsrc;
  params.callback = "bkt_main_cb";
  params._ = String(Date.now());

  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join("&");
  const mainUrl = `${BOOKITIT_BASE}/main/?${qs}`;

  log("STEP", `GET ${mainUrl.slice(0, 120)}…`);

  const r3 = await impit.fetch(mainUrl, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": SAOPOLO_URL,
      "Cookie": buildCookieString(jar),
    },
  } as any) as unknown as Response;

  const body3 = await r3.text();
  log("INFO", `HTTP ${r3.status} | ${body3.length}B`);
  log("INFO", `Content-Type : ${r3.headers.get("content-type") ?? "?"}`);

  if (body3.length === 0) {
    log("ERR", "/main/ → 0B — CF ou serveur refuse (session non initialisée)");
  } else if (body3.includes('"Exception"')) {
    log("ERR", `/main/ → Exception Bookitit : ${body3.slice(0, 200)}`);
  } else if (body3.length > 1000) {
    log("OK", `🎉 /main/ → ${body3.length}B de données RÉELLES via Impit pur !`);
    log("INFO", `Aperçu : ${body3.slice(0, 150)}`);

    // Test supplémentaire : getservices/
    section("BONUS — GET /getservices/ JSONP");
    const svcUrl = `${BOOKITIT_BASE}/getservices/?${qs}`;
    const r4 = await impit.fetch(svcUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": SAOPOLO_URL,
        "Cookie": buildCookieString(jar),
      },
    } as any) as unknown as Response;
    const body4 = await r4.text();
    log("INFO", `getservices/ → HTTP ${r4.status} | ${body4.length}B`);
    if (body4.length > 100) {
      log("OK", `getservices/ fonctionne via Impit ! (${body4.length}B)`);
      log("INFO", `Aperçu : ${body4.slice(0, 200)}`);
    }
  } else {
    log("WARN", `/main/ réponse courte (${body3.length}B) : ${body3.slice(0, 200)}`);
  }

  // ─── RÉSUMÉ ────────────────────────────────────────────────────────────────
  section("RÉSUMÉ");
  log("INFO", `Étape 1 (GET portail)  : ${body1.length}B | token=${token ? "✅" : "❌"}`);
  log("INFO", `Étape 2 (POST token)   : ${body2.length}B | bkt_init_widget=${bktWidget ? "✅" : "❌"}`);
  log("INFO", `Étape 3 (GET /main/)   : ${body3.length}B | ${body3.length > 1000 ? "✅ DONNÉES RÉELLES" : body3.includes("Exception") ? "❌ Exception" : "❌ Échec"}`);

  if (body3.length > 1000) {
    console.log("\n  ┌─────────────────────────────────────────────────────┐");
    console.log("  │ SUCCÈS : Impit pur reproduit le flow widget complet │");
    console.log("  │ → Pas besoin de browser pour le scan Bookitit       │");
    console.log("  └─────────────────────────────────────────────────────┘");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
