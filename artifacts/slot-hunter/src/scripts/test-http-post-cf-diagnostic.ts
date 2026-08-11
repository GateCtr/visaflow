/**
 * test-http-post-cf-diagnostic.ts — Diagnostic 0B HTTP responses post CF solve
 *
 * OBJECTIF : Identifier pourquoi les requêtes HTTP-only (undici/impit) vers Bookitit
 * retournent 0B après un solve CF réussi, alors que page.evaluate(fetch()) fonctionne.
 *
 * MÉTHODES TESTÉES (même cookies, même proxy, même UA) :
 *   A. page.evaluate(fetch()) — browser context (RÉFÉRENCE, doit fonctionner)
 *   B. undici fetch + ProxyAgent — Node.js HTTP brut via proxy
 *   C. Impit (Chrome TLS JA3/JA4) — fingerprint TLS Chrome émulé
 *   D. undici fetch SANS proxy — direct (contrôle négatif)
 *
 * DIAGNOSTIC :
 *   - Si A fonctionne et B/C échouent → TLS fingerprint binding (PHPSESSID lié à JA3)
 *   - Si A et C fonctionnent mais B échoue → JA3 fingerprint nécessaire
 *   - Si tout échoue → session/cookie invalide ou endpoint incorrect
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   SPAIN_ISP_PROXY_URL=http://user:pass@host:port \
 *   npx tsx src/scripts/test-http-post-cf-diagnostic.ts
 *
 *   # Mode headed :
 *   SPAIN_HEADED=1 SPAIN_ISP_PROXY_URL=... npx tsx src/scripts/test-http-post-cf-diagnostic.ts
 */

import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page, CDPSession } from "puppeteer";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { Impit } from "impit";
import {
  solveCfChallengeWithRetry,
  setupProxyAuth,
  preparePageStealth,
} from "../cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ── CLI flags ─────────────────────────────────────────────────────────────────
{
  const argv = process.argv.slice(2);
  if (argv.includes("--headed"))   process.env.SPAIN_HEADED   = "1";
  if (argv.includes("--devtools")) process.env.SPAIN_DEVTOOLS = "1";
  const sm = argv.find((a) => a.startsWith("--slow-mo="));
  if (sm) process.env.SPAIN_SLOW_MO = sm.split("=")[1];
}

// ── Constants ─────────────────────────────────────────────────────────────────
const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";

// ── Logging ───────────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: "INFO" | "OK" | "WARN" | "ERR" | "STEP" | "DIAG", msg: string): void {
  const icons: Record<string, string> = {
    INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ ", DIAG: "🔬",
  };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseProxy(proxyUrl: string): { server: string; username: string; password: string } | null {
  try {
    const u = new URL(proxyUrl);
    const server = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
    return { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  } catch { return null; }
}

function parseJsonp(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* */ }
  const m = raw.match(/^[\w$]+\((.+)\);?\s*$/s);
  if (m) { try { return JSON.parse(m[1]); } catch { /* */ } }
  return null;
}

interface HttpTestResult {
  method: string;
  status: number;
  bodyLength: number;
  bodySnippet: string;
  headers: Record<string, string>;
  error?: string;
  durationMs: number;
}

/**
 * Construit l'URL /main/ avec les paramètres bkt_init_widget (comme jQuery le fait).
 */
function buildMainUrl(bktWidget: Record<string, string>): string {
  const params = { ...bktWidget };
  delete params.srvsrc; // loadermaec.js supprime srvsrc avant l'appel
  params.callback = "bkt_main_cb";
  params._ = String(Date.now());
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join("&");
  return `${BOOKITIT_BASE}/main/?${qs}`;
}

/**
 * Construit les headers HTTP identiques à ceux d'un vrai Chrome sur le widget.
 */
function buildBrowserHeaders(ua: string, cookies: string, referer: string): Record<string, string> {
  const chromeMajor = ua.match(/Chrome\/(\d+)/)?.[1] ?? "149";
  return {
    "User-Agent": ua,
    "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": referer,
    "Cookie": cookies,
    "Sec-Ch-Ua": `"Not/A)Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Connection": "keep-alive",
  };
}

// ── Test Methods ──────────────────────────────────────────────────────────────

/**
 * Méthode A : fetch depuis le contexte browser (page.evaluate).
 * C'est la RÉFÉRENCE — fonctionne car même connexion TLS que le solve CF.
 */
async function testBrowserFetch(
  page: Page,
  mainUrl: string,
): Promise<HttpTestResult> {
  const t0 = Date.now();
  try {
    const result = await page.evaluate(async (url: string) => {
      try {
        const r = await fetch(url, {
          credentials: "include",
          headers: {
            "Accept": "text/javascript, application/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        const body = await r.text();
        const hdrs: Record<string, string> = {};
        r.headers.forEach((v, k) => { hdrs[k] = v; });
        return { status: r.status, body, headers: hdrs };
      } catch (e: unknown) {
        return { status: 0, body: "", headers: {}, err: String(e) };
      }
    }, mainUrl) as { status: number; body: string; headers: Record<string, string>; err?: string };

    return {
      method: "A) Browser page.evaluate(fetch)",
      status: result.status,
      bodyLength: result.body.length,
      bodySnippet: result.body.slice(0, 200),
      headers: result.headers,
      error: result.err,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      method: "A) Browser page.evaluate(fetch)",
      status: 0, bodyLength: 0, bodySnippet: "",
      headers: {}, error: String(err), durationMs: Date.now() - t0,
    };
  }
}

/**
 * Méthode B : undici fetch + ProxyAgent (Node.js TLS, pas Chrome JA3).
 * Teste si le problème est le fingerprint TLS ou juste les cookies/headers.
 */
async function testUndiciFetch(
  mainUrl: string,
  headers: Record<string, string>,
  proxyUrl: string,
): Promise<HttpTestResult> {
  const t0 = Date.now();
  try {
    const dispatcher = new ProxyAgent(proxyUrl);
    const resp = await undiciFetch(mainUrl, {
      method: "GET",
      headers,
      dispatcher,
      signal: AbortSignal.timeout(20_000),
    });
    const body = await resp.text();
    const hdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => { hdrs[k] = v; });
    return {
      method: "B) undici + ProxyAgent (Node TLS)",
      status: resp.status,
      bodyLength: body.length,
      bodySnippet: body.slice(0, 200),
      headers: hdrs,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      method: "B) undici + ProxyAgent (Node TLS)",
      status: 0, bodyLength: 0, bodySnippet: "",
      headers: {}, error: String(err), durationMs: Date.now() - t0,
    };
  }
}

/**
 * Méthode C : Impit (Chrome TLS JA3/JA4 emulation).
 * Teste si le JA3 Chrome suffit à faire accepter la requête par CF + PHP.
 */
async function testImpitFetch(
  mainUrl: string,
  headers: Record<string, string>,
  proxyUrl: string,
): Promise<HttpTestResult> {
  const t0 = Date.now();
  try {
    const impit = new Impit({
      browser: "chrome",
      proxyUrl: proxyUrl || undefined,
    } as any);
    const resp = await impit.fetch(mainUrl, {
      method: "GET",
      headers,
    } as any) as unknown as Response;
    const body = await resp.text();
    const hdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => { hdrs[k] = v; });
    return {
      method: "C) Impit (Chrome TLS JA3)",
      status: resp.status,
      bodyLength: body.length,
      bodySnippet: body.slice(0, 200),
      headers: hdrs,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      method: "C) Impit (Chrome TLS JA3)",
      status: 0, bodyLength: 0, bodySnippet: "",
      headers: {}, error: String(err), durationMs: Date.now() - t0,
    };
  }
}

/**
 * Méthode D : undici fetch SANS proxy (contrôle négatif — IP différente).
 * Doit échouer (CF bloque les IPs non-validées). Confirme que le proxy est nécessaire.
 */
async function testDirectFetch(
  mainUrl: string,
  headers: Record<string, string>,
): Promise<HttpTestResult> {
  const t0 = Date.now();
  try {
    const resp = await undiciFetch(mainUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await resp.text();
    const hdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => { hdrs[k] = v; });
    return {
      method: "D) undici direct (no proxy, control)",
      status: resp.status,
      bodyLength: body.length,
      bodySnippet: body.slice(0, 200),
      headers: hdrs,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      method: "D) undici direct (no proxy, control)",
      status: 0, bodyLength: 0, bodySnippet: "",
      headers: {}, error: String(err), durationMs: Date.now() - t0,
    };
  }
}

/**
 * Méthode E : Impit avec un NOUVEAU PHPSESSID (pas celui du browser).
 * Teste si le problème est le binding PHPSESSID↔TLS ou juste CF clearance.
 */
async function testImpitFreshSession(
  portalUrl: string,
  headers: Record<string, string>,
  proxyUrl: string,
): Promise<HttpTestResult> {
  const t0 = Date.now();
  try {
    const impit = new Impit({
      browser: "chrome",
      proxyUrl: proxyUrl || undefined,
    } as any);

    // Étape 1 : GET portail pour obtenir un PHPSESSID frais lié à CETTE connexion TLS
    const portalHeaders = { ...headers };
    delete portalHeaders["Cookie"]; // Pas de cookie → force un nouveau PHPSESSID
    // Garder cf_clearance uniquement
    const cfClearance = headers["Cookie"]?.match(/cf_clearance=([^;]+)/)?.[1];
    if (cfClearance) {
      portalHeaders["Cookie"] = `cf_clearance=${cfClearance}`;
    }

    const portalResp = await impit.fetch(portalUrl, {
      method: "GET",
      headers: portalHeaders,
    } as any) as unknown as Response;

    const setCookieHeader = portalResp.headers.get("set-cookie") ?? "";
    const phpSessionMatch = setCookieHeader.match(/PHPSESSID=([^;]+)/);
    const portalBody = await portalResp.text();

    if (!phpSessionMatch) {
      return {
        method: "E) Impit fresh PHPSESSID",
        status: portalResp.status,
        bodyLength: portalBody.length,
        bodySnippet: `No PHPSESSID in Set-Cookie. Body: ${portalBody.slice(0, 100)}`,
        headers: { "set-cookie": setCookieHeader.slice(0, 200) },
        error: "No PHPSESSID returned by portal",
        durationMs: Date.now() - t0,
      };
    }

    const freshPhpSession = phpSessionMatch[1];
    log("DIAG", `Impit PHPSESSID frais obtenu : ${freshPhpSession.slice(0, 12)}…`);

    // Étape 2 : Extraire bkt_init_widget depuis le HTML du portail
    const bktMatch = portalBody.match(/var\s+bkt_init_widget\s*=\s*(\{[^}]+\})/);
    let mainUrl: string;
    if (bktMatch) {
      try {
        const bkt = JSON.parse(bktMatch[1].replace(/'/g, '"'));
        mainUrl = buildMainUrl(bkt);
      } catch {
        mainUrl = `${BOOKITIT_BASE}/main/?callback=bkt_main_cb&_=${Date.now()}`;
      }
    } else {
      mainUrl = `${BOOKITIT_BASE}/main/?callback=bkt_main_cb&_=${Date.now()}`;
    }

    // Étape 3 : Appeler /main/ avec le PHPSESSID frais + cf_clearance
    const mainHeaders = { ...headers };
    const cookieParts = [`PHPSESSID=${freshPhpSession}`];
    if (cfClearance) cookieParts.push(`cf_clearance=${cfClearance}`);
    mainHeaders["Cookie"] = cookieParts.join("; ");
    mainHeaders["Referer"] = portalUrl;

    const mainResp = await impit.fetch(mainUrl, {
      method: "GET",
      headers: mainHeaders,
    } as any) as unknown as Response;
    const mainBody = await mainResp.text();
    const mainHdrs: Record<string, string> = {};
    mainResp.headers.forEach((v, k) => { mainHdrs[k] = v; });

    return {
      method: "E) Impit fresh PHPSESSID (same TLS)",
      status: mainResp.status,
      bodyLength: mainBody.length,
      bodySnippet: mainBody.slice(0, 200),
      headers: mainHdrs,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      method: "E) Impit fresh PHPSESSID (same TLS)",
      status: 0, bodyLength: 0, bodySnippet: "",
      headers: {}, error: String(err), durationMs: Date.now() - t0,
    };
  }
}

// ── Result display ────────────────────────────────────────────────────────────

function displayResult(r: HttpTestResult): void {
  const ok = r.bodyLength > 0 && !r.error;
  const icon = ok ? "✅" : "❌";
  console.log(`\n  ${icon} ${r.method}`);
  console.log(`     HTTP ${r.status} | ${r.bodyLength}B | ${r.durationMs}ms`);
  if (r.error) console.log(`     Error: ${r.error}`);
  if (r.bodySnippet) console.log(`     Body[0:150]: ${r.bodySnippet.slice(0, 150)}`);
  if (r.headers["content-type"]) console.log(`     Content-Type: ${r.headers["content-type"]}`);
  if (r.headers["cf-ray"]) console.log(`     CF-Ray: ${r.headers["cf-ray"]}`);
}

function diagnose(results: HttpTestResult[]): void {
  section("DIAGNOSTIC FINAL");

  const [browserResult, undiciResult, impitResult, directResult, impitFreshResult] = results;

  const browserOk = browserResult.bodyLength > 0;
  const undiciOk  = undiciResult.bodyLength > 0;
  const impitOk   = impitResult.bodyLength > 0;
  const directOk  = directResult.bodyLength > 0;
  const freshOk   = impitFreshResult?.bodyLength > 0;

  console.log("\n  Résumé :");
  console.log(`    A) Browser fetch    : ${browserOk ? "✅ OK" : "❌ 0B"} (${browserResult.bodyLength}B)`);
  console.log(`    B) undici+proxy     : ${undiciOk  ? "✅ OK" : "❌ 0B"} (${undiciResult.bodyLength}B)`);
  console.log(`    C) Impit (JA3)      : ${impitOk   ? "✅ OK" : "❌ 0B"} (${impitResult.bodyLength}B)`);
  console.log(`    D) Direct (no proxy): ${directOk  ? "✅ OK" : "❌ 0B"} (${directResult.bodyLength}B)`);
  if (impitFreshResult) {
    console.log(`    E) Impit fresh PHP  : ${freshOk ? "✅ OK" : "❌ 0B"} (${impitFreshResult.bodyLength}B)`);
  }

  console.log("\n  Analyse :");

  if (browserOk && !undiciOk && !impitOk) {
    console.log("  ┌─────────────────────────────────────────────────────────────────┐");
    console.log("  │ DIAGNOSTIC : PHPSESSID lié à la connexion TLS Chromium          │");
    console.log("  │                                                                 │");
    console.log("  │ Le serveur PHP lie la session au fingerprint TLS (JA3/JA4) du   │");
    console.log("  │ client. Ni undici (Node TLS) ni Impit ne reproduisent le même   │");
    console.log("  │ JA3 que le vrai Chromium qui a créé le PHPSESSID.               │");
    console.log("  │                                                                 │");
    console.log("  │ SOLUTION : utiliser page.evaluate(fetch()) depuis le browser    │");
    console.log("  │ Chromium pour TOUS les appels Bookitit /onlinebookings/*.       │");
    console.log("  │ C'est le pattern déjà implémenté dans spain-persistent-browser  │");
    console.log("  │ via registerSpainPageFetcher + callBookititEndpointViaBrowser.  │");
    console.log("  └─────────────────────────────────────────────────────────────────┘");
  } else if (browserOk && impitOk && !undiciOk) {
    console.log("  ┌─────────────────────────────────────────────────────────────────┐");
    console.log("  │ DIAGNOSTIC : JA3 fingerprint requis (CF vérifie le TLS)         │");
    console.log("  │                                                                 │");
    console.log("  │ Impit (Chrome JA3) fonctionne mais undici (Node TLS) échoue.    │");
    console.log("  │ CF valide que le JA3 de la requête correspond à celui du solve.  │");
    console.log("  │                                                                 │");
    console.log("  │ SOLUTION : utiliser Impit pour les requêtes HTTP-only.          │");
    console.log("  │ S'assurer que l'instance Impit qui a résolu CF est réutilisée   │");
    console.log("  │ (pas de nouvelle instance → même connexion TCP si possible).    │");
    console.log("  └─────────────────────────────────────────────────────────────────┘");
  } else if (browserOk && !impitOk && freshOk) {
    console.log("  ┌─────────────────────────────────────────────────────────────────┐");
    console.log("  │ DIAGNOSTIC : PHPSESSID du browser non transférable              │");
    console.log("  │                                                                 │");
    console.log("  │ Le PHPSESSID créé dans Chromium est INCOMPATIBLE avec Impit.    │");
    console.log("  │ Mais un PHPSESSID frais créé PAR Impit fonctionne.              │");
    console.log("  │                                                                 │");
    console.log("  │ SOLUTION : après le solve CF (pour cf_clearance), obtenir un    │");
    console.log("  │ NOUVEAU PHPSESSID depuis Impit (GET portail) avant d'appeler    │");
    console.log("  │ /main/. Ne pas réutiliser le PHPSESSID du browser.              │");
    console.log("  └─────────────────────────────────────────────────────────────────┘");
  } else if (!browserOk) {
    console.log("  ┌─────────────────────────────────────────────────────────────────┐");
    console.log("  │ DIAGNOSTIC : Même le browser échoue                             │");
    console.log("  │                                                                 │");
    console.log("  │ La session n'est pas valide (JSD oneshot non validé par CF,     │");
    console.log("  │ PHPSESSID expiré, ou widget non initialisé correctement).       │");
    console.log("  │                                                                 │");
    console.log("  │ Vérifier : le widget est-il chargé ? bkt_init_widget défini ?   │");
    console.log("  │ Le RUM beacon CF a-t-il été envoyé ? JSD oneshot reçu ?         │");
    console.log("  └─────────────────────────────────────────────────────────────────┘");
  } else {
    console.log("  → Cas non prévu — voir les résultats détaillés ci-dessus.");
  }
}

// ── Proxy resolution ──────────────────────────────────────────────────────────

/**
 * Résout le proxy à utiliser : SPAIN_ISP_PROXY_URL → DECODO_PROXY_URL → CSV pool.
 * Construit l'URL au format http://user:pass@host:port.
 */
function resolveProxy(): string | null {
  // 1. SPAIN_ISP_PROXY_URL (prioritaire)
  if (process.env.SPAIN_ISP_PROXY_URL?.trim()) return process.env.SPAIN_ISP_PROXY_URL.trim();
  // 2. DECODO_PROXY_URL
  if (process.env.DECODO_PROXY_URL?.trim()) return process.env.DECODO_PROXY_URL.trim();
  // 3. CSV pool (premier proxy)
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
  } catch { /* pas de CSV */ }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ispProxy = resolveProxy() ?? "";
  const isHeaded = process.env.SPAIN_HEADED === "1";
  const slowMo   = isHeaded ? Number(process.env.SPAIN_SLOW_MO ?? "60") : 0;
  const devtools = process.env.SPAIN_DEVTOOLS === "1";
  const execPath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;

  if (!ispProxy) {
    log("ERR", "Aucun proxy disponible (SPAIN_ISP_PROXY_URL / DECODO_PROXY_URL / decodo-proxies.csv)");
    log("INFO", "Usage : SPAIN_ISP_PROXY_URL=http://user:pass@host:port npx tsx src/scripts/test-http-post-cf-diagnostic.ts");
    process.exit(1);
  }

  const proxyParsed = parseProxy(ispProxy);
  if (!proxyParsed) {
    log("ERR", `Proxy URL invalide : ${ispProxy.replace(/:([^@:]+)@/, ":***@")}`);
    process.exit(1);
  }

  section("DIAGNOSTIC 0B HTTP — cf-challenge-solver + Bookitit");
  log("INFO", `Proxy   : ${ispProxy.replace(/:([^@:]+)@/, ":***@")}`);
  log("INFO", `Server  : ${proxyParsed.server}`);
  log("INFO", `Portail : ${SAOPOLO_URL.slice(0, 60)}…`);
  log("INFO", `Mode    : ${isHeaded ? "👁️  headed" : "headless"}`);

  // ─── PHASE 1 : Lancement Chromium + solve CF ─────────────────────────────────
  section("PHASE 1 — Lancement Chromium + solve CF");

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-webgl",
    "--window-size=1366,768",
    "--disable-v8-code-cache",
    "--disable-crash-reporter",
    "--no-first-run",
    "--no-default-browser-check",
    `--proxy-server=${proxyParsed.server}`,
  ];

  log("STEP", "puppeteer.launch()…");
  const browser: Browser = await (puppeteer as any).launch({
    headless: !isHeaded,
    args: launchArgs,
    slowMo,
    devtools,
    protocolTimeout: 180_000,
    ...(execPath ? { executablePath: execPath } : {}),
  });

  const pages = await browser.pages();
  const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  log("OK", "Chromium lancé");

  let postSolveAuthClient: CDPSession | null = null;

  try {
    // ── Solve CF ──────────────────────────────────────────────────────────────
    log("STEP", "solveCfChallengeWithRetry…");
    const t1 = Date.now();
    const cfResult = await solveCfChallengeWithRetry(page, browser, {
      targetUrl: SAOPOLO_URL,
      proxyUrl: ispProxy,
      maxRetries: 4,
      timeout: 90_000,
      cacheBustCdn: true,
      purgeStaleData: true,
      geoTimezone: "Europe/Madrid",
    });
    const solveMs = Date.now() - t1;

    if (!cfResult.success) {
      log("ERR", `CF solve échoué (${Math.round(solveMs / 1000)}s) : ${cfResult.error}`);
      process.exit(1);
    }

    log("OK", `CF résolu en ${Math.round(solveMs / 1000)}s — ${cfResult.solvedBy}`);
    log("INFO", `cf_clearance : ${(cfResult.cfClearance ?? "").slice(0, 35)}…`);
    const cfCookieNames = (cfResult.allCookies ?? []).map((c) => c.name).join(", ");
    log("INFO", `Cookies solve : ${cfCookieNames}`);

    // ─── PHASE 2 : Reload widget + extraire session ─────────────────────────────
    section("PHASE 2 — Reload widget + extraction session");

    // Re-attacher proxy auth après solve (le solver détache sa session interne)
    if (proxyParsed.username) {
      postSolveAuthClient = await setupProxyAuth(page, ispProxy);
      log("OK", "Proxy auth post-solve attaché");
    }

    // Naviguer vers le portail propre (CF fast-track avec cf_clearance)
    log("STEP", "page.goto(SAOPOLO_URL) — widget frais…");
    try {
      await page.goto(SAOPOLO_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (navErr: unknown) {
      log("WARN", `goto non-fatal : ${String(navErr).slice(0, 80)}`);
    }

    // Attendre que CF fast-track se termine
    const title = await page.title().catch(() => "?");
    if (/un instant|checking|just a moment/i.test(title)) {
      log("INFO", "CF fast-track en cours — attente 15s…");
      for (let i = 0; i < 15; i++) {
        await new Promise<void>((r) => setTimeout(r, 1_000));
        const t = await page.title().catch(() => "?");
        if (!/un instant|checking|just a moment/i.test(t)) {
          log("OK", `CF fast-track terminé (${i + 1}s)`);
          break;
        }
      }
    }

    // Attendre widget
    log("STEP", "Attente widget Bookitit…");
    try {
      await page.waitForSelector(
        "#idCaptchaButton, #idBktDefaultCustomContainer, form[action*='widgetdefault']",
        { visible: true, timeout: 20_000 },
      );
      log("OK", "Widget Bookitit chargé");
    } catch {
      log("WARN", "Widget non détecté — on continue");
    }

    // ── Extraire les données de session ────────────────────────────────────────
    log("STEP", "Extraction données session (cookies CDP + bkt_init_widget)…");

    // Cookies CDP (voit les HttpOnly)
    const cdpSession = await page.createCDPSession();
    const { cookies: allCdpCookies } = await cdpSession.send("Network.getAllCookies") as {
      cookies: Array<{ name: string; value: string; domain: string; httpOnly: boolean }>;
    };
    await cdpSession.detach().catch(() => {});

    const relevantCookies = allCdpCookies.filter(
      (c) => c.domain.includes("citaconsular") || c.domain.includes("bookitit"),
    );
    log("INFO", `Cookies CDP : ${relevantCookies.map((c) => `${c.name}(${c.httpOnly ? "HO" : "JS"})=${c.value.slice(0, 8)}…`).join(", ")}`);

    const phpSession = relevantCookies.find((c) => c.name === "PHPSESSID");
    const cfClearanceCookie = relevantCookies.find((c) => c.name === "cf_clearance");

    if (!phpSession) log("WARN", "PHPSESSID absent — /main/ va probablement échouer");
    if (!cfClearanceCookie) log("WARN", "cf_clearance absent — CF va bloquer");

    // Extraire bkt_init_widget
    const bktWidget = await page.evaluate(() => {
      const bkt = (window as any).bkt_init_widget;
      return bkt ? JSON.parse(JSON.stringify(bkt)) : null;
    }).catch(() => null) as Record<string, string> | null;

    if (bktWidget) {
      log("OK", `bkt_init_widget : wid=${bktWidget.wid ?? "?"}, type=${bktWidget.type ?? "?"}`);
    } else {
      log("WARN", "bkt_init_widget non défini — utilisation d'une URL /main/ minimale");
    }

    // UA de la page
    const pageUA = await page.evaluate(() => navigator.userAgent).catch(
      () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );

    // ─── PHASE 3 : Clic Continuar + JSD oneshot ─────────────────────────────────
    section("PHASE 3 — Clic Continuar + attente JSD oneshot");

    // Écouter JSD oneshot
    let jsdOneshotSeen = false;
    const jsdOneshotPromise = new Promise<void>((resolve) => {
      const handler = (resp: any) => {
        const url: string = resp.url?.() ?? "";
        if (!jsdOneshotSeen && url.includes("/jsd/oneshot/")) {
          jsdOneshotSeen = true;
          log("OK", `JSD oneshot détecté : ${url.slice(0, 80)}`);
          page.off("response", handler);
          resolve();
        }
      };
      page.on("response", handler);
      setTimeout(() => { page.off("response", handler); resolve(); }, 25_000);
    });

    // Clic Continuar
    const continuarResult = await page.evaluate(`(function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var captchaBtn = document.getElementById('idCaptchaButton');
      if (visible(captchaBtn)) { captchaBtn.click(); return 'idCaptchaButton'; }
      var all = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="submit"]'));
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!visible(el)) continue;
        var txt = (el.textContent || el.value || '').trim().toLowerCase();
        if (/^(continuar|continue|aceptar|ok)$/.test(txt)) { el.click(); return 'text:' + txt; }
      }
      return 'no_btn';
    })()`).catch(() => "error") as string;

    log(continuarResult === "no_btn" ? "WARN" : "OK", `Continuar → ${continuarResult}`);

    // Attendre JSD oneshot
    log("STEP", "Attente JSD oneshot (max 25s)…");
    await jsdOneshotPromise;

    if (jsdOneshotSeen) {
      log("INFO", "Délai 4s post-oneshot (CF + PHP initialisent session)…");
      await new Promise<void>((r) => setTimeout(r, 4_000));
    } else {
      log("WARN", "JSD oneshot non détecté — on teste quand même");
      await new Promise<void>((r) => setTimeout(r, 2_000));
    }

    // Attendre que la page se stabilise post-Continuar (navigation interne possible)
    try {
      await page.waitForSelector(
        "#idBktDefaultCustomContainer, .clsBktFlowContainer, [id*='bkt'], .bkt_services_list",
        { visible: true, timeout: 12_000 },
      );
      log("OK", "Container Bookitit visible post-Continuar");
    } catch {
      log("INFO", "Container Bookitit non détecté — on extrait quand même");
    }

    // ─── PHASE 4 : Ré-extraire cookies + bkt_init_widget post-Continuar ──────────
    section("PHASE 4 — Extraction cookies + bkt_init_widget post-Continuar");

    const cdpSession2 = await page.createCDPSession();
    const { cookies: postContinuarCookies } = await cdpSession2.send("Network.getAllCookies") as {
      cookies: Array<{ name: string; value: string; domain: string; httpOnly: boolean }>;
    };
    await cdpSession2.detach().catch(() => {});

    const finalCookies = postContinuarCookies.filter(
      (c) => c.domain.includes("citaconsular") || c.domain.includes("bookitit"),
    );
    log("INFO", `Cookies post-Continuar : ${finalCookies.map((c) => `${c.name}=${c.value.slice(0, 8)}…`).join(", ")}`);

    // Ré-extraire bkt_init_widget APRÈS Continuar (il est initialisé par le loader)
    // Poll car le widget peut mettre quelques secondes à s'initialiser (JSONP async)
    let bktWidgetPost: Record<string, string> | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      bktWidgetPost = await page.evaluate(() => {
        const bkt = (window as any).bkt_init_widget;
        return bkt ? JSON.parse(JSON.stringify(bkt)) : null;
      }).catch(() => null) as Record<string, string> | null;
      if (bktWidgetPost) break;
      await new Promise<void>((r) => setTimeout(r, 1_000));
      if (attempt === 3) log("INFO", "bkt_init_widget pas encore défini — attente…");
    }

    if (bktWidgetPost) {
      log("OK", `bkt_init_widget (post-Continuar) : wid=${bktWidgetPost.wid ?? "?"}, type=${bktWidgetPost.type ?? "?"}, src=${bktWidgetPost.src ?? "?"}`);
      log("INFO", `  Clés : ${Object.keys(bktWidgetPost).join(", ")}`);
    } else if (bktWidget) {
      log("WARN", "bkt_init_widget toujours non défini post-Continuar — utilisation pré-Continuar");
    } else {
      log("WARN", "bkt_init_widget jamais défini — fallback URL minimale (/main/ retournera Exception)");
    }

    const effectiveWidget = bktWidgetPost ?? bktWidget;

    // Construire cookie string pour les requêtes HTTP
    const cookieString = finalCookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    // Construire l'URL /main/ avec les params widget complets
    const mainUrl = effectiveWidget
      ? buildMainUrl(effectiveWidget)
      : `${BOOKITIT_BASE}/main/?callback=bkt_main_cb&_=${Date.now()}`;

    const referer = SAOPOLO_URL;
    const httpHeaders = buildBrowserHeaders(pageUA, cookieString, referer);

    log("INFO", `URL /main/ : ${mainUrl.slice(0, 150)}…`);
    log("INFO", `Cookie     : ${cookieString.slice(0, 100)}…`);
    log("INFO", `UA         : ${pageUA.slice(0, 80)}`);

    // ─── PHASE 5 : Tests comparatifs HTTP ────────────────────────────────────────
    section("PHASE 5 — Capture /main/ natif (widget jQuery) + tests HTTP");

    // Le widget jQuery appelle /main/ automatiquement via JSONP après init.
    // On capture cette réponse réseau au lieu de l'appeler manuellement.
    // L'appel manuel échoue car Bookitit requiert un token interne (via le form POST).

    // D'abord, capturer le /main/ natif fait par le widget (si pas déjà fait)
    log("STEP", "Capture /main/ natif via widget jQuery JSONP…");

    // Utiliser callBookititViaWidgetNativeJsonp pattern (jQuery.ajax JSONP)
    const nativeMainResult = await page.evaluate(`
      (function() {
        return new Promise(function(resolve) {
          var jq = window.jQuery;
          var init = window.bkt_init_widget;
          if (!jq || !init || !init.srvsrc) {
            resolve(JSON.stringify({ ok: false, reason: 'no_widget_or_jquery', jq: !!jq, init: !!init }));
            return;
          }
          var data = {};
          for (var k in init) {
            if (Object.prototype.hasOwnProperty.call(init, k)) data[k] = init[k];
          }
          var srvsrc = data.srvsrc;
          delete data.srvsrc;
          data._ = String(Date.now());
          var timer = setTimeout(function() {
            resolve(JSON.stringify({ ok: false, reason: 'timeout_22s' }));
          }, 22000);
          jq.ajax({
            url: srvsrc + '/onlinebookings/main/',
            dataType: 'jsonp',
            jsonp: 'callback',
            data: data,
            success: function(resp) {
              clearTimeout(timer);
              try { resolve(JSON.stringify({ ok: true, data: resp, len: JSON.stringify(resp).length })); }
              catch(e) { resolve(JSON.stringify({ ok: false, reason: 'stringify_error' })); }
            },
            error: function(_xhr, status) {
              clearTimeout(timer);
              resolve(JSON.stringify({ ok: false, reason: 'ajax_error_' + status }));
            }
          });
        });
      })()
    `).catch(() => '{"ok":false,"reason":"evaluate_error"}') as string;

    const nativeMain = JSON.parse(nativeMainResult);
    if (nativeMain.ok) {
      log("OK", `Widget JSONP /main/ natif → ${nativeMain.len}B`);
      const dataStr = JSON.stringify(nativeMain.data);
      log("INFO", `Contenu : ${dataStr.slice(0, 200)}`);

      // Vérifier si c'est une Exception ou des données réelles
      if (nativeMain.data?.Exception) {
        log("WARN", `Exception Bookitit : ${nativeMain.data.Exception.errors?.[0]?.message ?? "unknown"}`);
        log("INFO", "→ Le widget n'a pas initialisé la session correctement (token form non soumis?)");
      } else {
        log("OK", "🎉 Données Bookitit RÉELLES reçues via widget natif !");
        const keys = Object.keys(nativeMain.data ?? {});
        log("INFO", `Clés : ${keys.join(", ")}`);
      }
    } else {
      log("WARN", `Widget JSONP natif échoué : ${nativeMain.reason}`);
      log("INFO", `jQuery: ${nativeMain.jq ?? "?"}, bkt_init_widget: ${nativeMain.init ?? "?"}`);
    }


    // ── Capturer l'URL exacte que jQuery appelle (pour la reproduire en HTTP) ──
    // Intercepter la PROCHAINE requête /main/ ou /getservices/ que le widget fera
    let capturedMainUrl = "";
    let capturedMainBody = "";
    const networkCapture = new Promise<void>((resolve) => {
      const handler = async (resp: any) => {
        const url: string = resp.url?.() ?? "";
        if (url.includes("/onlinebookings/main/") || url.includes("/onlinebookings/getservices/")) {
          if (!capturedMainUrl) {
            capturedMainUrl = url;
            capturedMainBody = await resp.text().catch(() => "");
            log("OK", `Réseau capturé : ${url.slice(0, 120)} → ${capturedMainBody.length}B`);
          }
          page.off("response", handler);
          resolve();
        }
      };
      page.on("response", handler);
      setTimeout(() => { page.off("response", handler); resolve(); }, 15_000);
    });

    // Si le widget natif n'a pas de données, essayer getservices/ qui est l'étape après /main/
    if (!nativeMain.ok || nativeMain.data?.Exception) {
      log("STEP", "Tentative getservices/ via widget natif…");
      const getsvcResult = await page.evaluate(`
        (function() {
          return new Promise(function(resolve) {
            var jq = window.jQuery;
            var init = window.bkt_init_widget;
            if (!jq || !init || !init.srvsrc) {
              resolve(JSON.stringify({ ok: false, reason: 'no_widget' }));
              return;
            }
            var data = {};
            for (var k in init) {
              if (Object.prototype.hasOwnProperty.call(init, k)) data[k] = init[k];
            }
            var srvsrc = data.srvsrc;
            delete data.srvsrc;
            data._ = String(Date.now());
            var timer = setTimeout(function() {
              resolve(JSON.stringify({ ok: false, reason: 'timeout' }));
            }, 15000);
            jq.ajax({
              url: srvsrc + '/onlinebookings/getservices/',
              dataType: 'jsonp',
              jsonp: 'callback',
              data: data,
              success: function(resp) {
                clearTimeout(timer);
                resolve(JSON.stringify({ ok: true, data: resp, len: JSON.stringify(resp).length }));
              },
              error: function(_xhr, status) {
                clearTimeout(timer);
                resolve(JSON.stringify({ ok: false, reason: 'error_' + status }));
              }
            });
          });
        })()
      `).catch(() => '{"ok":false}') as string;

      const getsvc = JSON.parse(getsvcResult);
      if (getsvc.ok) {
        log("OK", `getservices/ natif → ${getsvc.len}B`);
        const svcStr = JSON.stringify(getsvc.data);
        log("INFO", `Contenu services : ${svcStr.slice(0, 250)}`);
      } else {
        log("WARN", `getservices/ natif échoué : ${getsvc.reason}`);
      }
    }

    await networkCapture;

    // ── Maintenant tester les mêmes endpoints via HTTP-only ──────────────────
    section("PHASE 5b — Tests HTTP-only avec URL capturée");

    // Utiliser l'URL capturée si disponible, sinon l'URL construite
    const testUrl = capturedMainUrl || mainUrl;
    log("INFO", `URL test : ${testUrl.slice(0, 150)}`);

    const results: HttpTestResult[] = [];

    // A) Browser fetch (référence)
    log("STEP", "Test A) page.evaluate(fetch) — browser context…");
    const resultA = await testBrowserFetch(page, testUrl);
    results.push(resultA);
    displayResult(resultA);

    // Pause entre les tests (éviter patterns bot)
    await new Promise<void>((r) => setTimeout(r, 1_500 + Math.random() * 1_000));

    // B) undici + proxy
    log("STEP", "Test B) undici + ProxyAgent — Node.js TLS via même proxy…");
    const resultB = await testUndiciFetch(testUrl, httpHeaders, ispProxy);
    results.push(resultB);
    displayResult(resultB);

    await new Promise<void>((r) => setTimeout(r, 1_500 + Math.random() * 1_000));

    // C) Impit (Chrome JA3)
    log("STEP", "Test C) Impit — Chrome TLS JA3 émulé via même proxy…");
    const resultC = await testImpitFetch(testUrl, httpHeaders, ispProxy);
    results.push(resultC);
    displayResult(resultC);

    await new Promise<void>((r) => setTimeout(r, 1_500 + Math.random() * 1_000));

    // D) Direct (contrôle négatif)
    log("STEP", "Test D) undici direct — sans proxy (contrôle négatif)…");
    const resultD = await testDirectFetch(testUrl, httpHeaders);
    results.push(resultD);
    displayResult(resultD);

    await new Promise<void>((r) => setTimeout(r, 1_500 + Math.random() * 1_000));

    // E) Impit avec PHPSESSID frais (diagnostic binding TLS↔session)
    log("STEP", "Test E) Impit fresh PHPSESSID — nouvelle session PHP via même TLS…");
    const resultE = await testImpitFreshSession(SAOPOLO_URL, httpHeaders, ispProxy);
    results.push(resultE);
    displayResult(resultE);

    // ─── DIAGNOSTIC ─────────────────────────────────────────────────────────────
    diagnose(results);

    if (isHeaded) {
      log("INFO", "Mode headed — fermeture dans 5s…");
      await new Promise<void>((r) => setTimeout(r, 5_000));
    }

  } finally {
    if (postSolveAuthClient) await postSolveAuthClient.detach().catch(() => {});
    await browser.close().catch(() => {});
    log("INFO", "Chromium fermé.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
