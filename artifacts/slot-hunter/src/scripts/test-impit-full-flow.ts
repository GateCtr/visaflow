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
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import rebrowserPuppeteer from "rebrowser-puppeteer-core";
import type { Browser, Page } from "rebrowser-puppeteer-core";
import {
  solveCfChallengeWithRetry,
} from "../cf-challenge-solver.js";
import { getCurrentDecodoUrl } from "../spain-decodo-pool.js";

const puppeteer = addExtra(rebrowserPuppeteer as any);
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
  // CLI --no-proxy force le mode direct
  if (process.argv.includes("--no-proxy")) return undefined;
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
    log("WARN", "Aucun proxy détecté — lancement en direct (IP locale)");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE A — Browser : résoudre CF et exporter cf_clearance
  // ═══════════════════════════════════════════════════════════════════════════
  section("PHASE A — Résolution CF via browser (cf-challenge-solver)");

  const proxyParsed = proxyUrl ? (() => {
    try {
      const u = new URL(proxyUrl);
      return { server: `${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    } catch { return null; }
  })() : null;
  if (proxyUrl && !proxyParsed) { log("ERR", "Proxy URL invalide"); process.exit(1); }

  const isHeaded = process.env.SPAIN_HEADED === "1";
  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled",
    "--disable-infobars", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader-webgl",
    "--enable-webgl", "--window-size=1366,768", "--disable-v8-code-cache", "--disable-crash-reporter",
    "--no-first-run", "--no-default-browser-check",
    ...(proxyParsed ? [`--proxy-server=${proxyParsed.server}`] : []),
  ];

  log("STEP", "Lancement Chromium…");
  const browser: Browser = await (puppeteer as any).launch({
    headless: !isHeaded,
    channel: "chrome",
    args: launchArgs,
    slowMo: isHeaded ? 60 : 0,
    protocolTimeout: 180_000,
  });
  const pages = await browser.pages();
  const page: Page = pages[0] ?? await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  let cfClearance = "";
  let allCookies: Array<{ name: string; value: string }> = [];
  let widgetToken = "";
  let widgetHtml = "";

  try {
    log("STEP", "solveCfChallengeWithRetry…");
    const cfResult = await solveCfChallengeWithRetry(page, browser, {
      targetUrl: SAOPOLO_URL,
      proxyUrl: proxyUrl || undefined,
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

    // ── Le widget est déjà chargé après le CF solve — extraire directement ──
    section("PHASE A.2 — Extraction token depuis la page post-solve (pas de reload)");

    // Attendre le bouton Continuar (= widget déjà chargé par le solve)
    try {
      await page.waitForSelector("#idCaptchaButton, input[name='token']", { visible: true, timeout: 10_000 });
      log("OK", "Widget déjà présent après CF solve");
    } catch {
      log("WARN", "Widget non détecté — tentative reload…");
      try {
        await page.goto(SAOPOLO_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
      } catch { /* non-fatal */ }
      await page.waitForSelector("#idCaptchaButton, input[name='token']", { visible: true, timeout: 15_000 }).catch(() => {});
    }

    // Extraire le HTML + token + cookies CDP (HttpOnly inclus)
    widgetHtml = await page.content().catch(() => "");
    const tokenMatch = widgetHtml.match(/name="token"\s+value="([^"]+)"/i);
    widgetToken = tokenMatch?.[1] ?? "";

    // Extraire TOUS les cookies via CDP (y compris HttpOnly)
    const cdpSession = await page.createCDPSession();
    const { cookies: cdpCookies } = await cdpSession.send("Network.getAllCookies");
    await cdpSession.detach().catch(() => {});
    allCookies = cdpCookies.map((c: any) => ({ name: c.name, value: c.value }));
    cfClearance = allCookies.find((c) => c.name === "cf_clearance")?.value ?? cfClearance;

    log("INFO", `Token extrait : ${widgetToken ? widgetToken.slice(0, 30) + "…" : "❌ ABSENT"}`);
    log("INFO", `Cookies CDP : ${allCookies.map((c) => c.name).join(", ")}`);
    log("INFO", `cf_clearance : ${cfClearance.slice(0, 25)}…`);
    log("INFO", `PHPSESSID : ${allCookies.find((c) => c.name === "PHPSESSID")?.value.slice(0, 12) ?? "absent"}…`);

  } finally {
    await browser.close().catch(() => {});
    log("INFO", "Browser fermé (Phase A terminée)");
  }

  if (!cfClearance) {
    log("ERR", "cf_clearance vide — impossible de continuer");
    process.exit(1);
  }
  if (!widgetToken) {
    log("ERR", "Token widget non extrait — le browser n'a pas chargé le widget correctement");
    log("INFO", `HTML[0:500] : ${widgetHtml.slice(0, 500)}`);
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE B — Impit pur : POST token + GET /main/
  // Le browser a extrait le token. Impit fait le POST (pas de GET = pas de TLS check CF initial).
  // ═══════════════════════════════════════════════════════════════════════════
  section("PHASE B — Impit HTTP : POST token → GET /main/");

  // Le cf_clearance est lié à l'IP de sortie. On doit utiliser le même proxy
  // que celui que le solver a utilisé (proxyUrl passé, ou Decodo pool par défaut).
  const effectiveProxy = proxyUrl || getCurrentDecodoUrl();
  log("INFO", `Proxy Impit (même IP que le solve) : ${effectiveProxy ? effectiveProxy.replace(/:([^@:]+)@/, ":***@").slice(0, 60) : "direct"}`);

  const impit = new Impit({
    browser: "chrome",
    proxyUrl: effectiveProxy || undefined,
  } as any);

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

  // Construire le jar avec TOUS les cookies du browser (PHPSESSID, cf_clearance, cf_chl_rc_ni…)
  const jar: Record<string, string> = {};
  for (const c of allCookies) {
    jar[c.name] = c.value;
  }

  const token = widgetToken;
  log("INFO", `Token : ${token.slice(0, 30)}…`);
  log("INFO", `Cookie jar : ${Object.keys(jar).join(", ")}`);

  // ─── ÉTAPE 1 : POST token directement (pas de GET !) ────────────────────────
  section("ÉTAPE 1 — POST token (session widget) — skip GET, TLS fingerprint bypass");
  log("STEP", `POST ${SAOPOLO_URL.slice(0, 60)}… (token=${token.slice(0, 20)}…)`);

  const r2 = await impit.fetch(SAOPOLO_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
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

  // Extraire bkt_init_widget — le JS utilise des guillemets simples et peut être multiline
  // Stratégie : chercher le bloc, normaliser les quotes, parser
  let bktWidget: Record<string, string> | null = null;

  // Regex permissive qui capture tout entre { et }; (ou };\n)
  const bktMatch = body2.match(/var\s+bkt_init_widget\s*=\s*(\{[\s\S]*?\});/);
  if (bktMatch) {
    try {
      // Normaliser : single quotes → double quotes, trailing commas, etc.
      let raw = bktMatch[1]
        .replace(/'/g, '"')              // ' → "
        .replace(/(\w+)\s*:/g, '"$1":')  // unquoted keys → "key":
        .replace(/,\s*}/g, "}")          // trailing comma
        .replace(/""(\w+)""/g, '"$1"');  // fix double-quoting from above if key was already quoted
      bktWidget = JSON.parse(raw);
      log("OK", `bkt_init_widget extrait : ${Object.keys(bktWidget!).join(", ")}`);
      log("INFO", `bkt_init_widget values : ${JSON.stringify(bktWidget).slice(0, 200)}`);
    } catch (e) {
      log("WARN", `bkt_init_widget parse error : ${e}`);
      log("INFO", `Raw match : ${bktMatch[1].slice(0, 300)}`);
      // Fallback : extraction par regex des paires clé/valeur
      bktWidget = {};
      const pairs = bktMatch[1].matchAll(/['"]?(\w+)['"]?\s*:\s*['"]([^'"]*)['"]/g);
      for (const [, k, v] of pairs) {
        bktWidget[k] = v;
      }
      if (Object.keys(bktWidget).length > 0) {
        log("OK", `bkt_init_widget (fallback regex) : ${Object.keys(bktWidget).join(", ")}`);
      } else {
        bktWidget = null;
      }
    }
  } else {
    log("WARN", "bkt_init_widget non trouvé dans la réponse POST");
    // Chercher loadermaec ou bookitit
    const hasLoader = body2.includes("loadermaec") || body2.includes("bkt_init_widget");
    const hasBookitit = body2.includes("onlinebookings") || body2.includes("bookitit");
    log("INFO", `loadermaec: ${hasLoader}, bookitit: ${hasBookitit}`);
    log("INFO", `Body2[0:500] : ${body2.slice(0, 500)}`);
  }

  // ─── ÉTAPE 2 : GET /main/ JSONP ───────────────────────────────────────────
  section("ÉTAPE 2 — GET /main/ JSONP");

  // Construire l'URL comme loadermaec.js le fait :
  // - prend bkt_init_widget
  // - supprime srvsrc
  // - ajoute version (depuis ?v=N du script tag) et src (URL du widget)
  // - ajoute callback + timestamp
  const params: Record<string, string> = bktWidget
    ? { ...bktWidget }
    : { type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34", lang: "es" };
  delete params.srvsrc;
  // loadermaec.js ajoute ces champs avant l'appel /main/
  if (!params.version) params.version = "4";
  if (!params.src) params.src = SAOPOLO_URL;
  // Supprimer les arrays vides (services=[], agendas=[], dates=[]) — 
  // loadermaec.js ne les envoie pas si vides
  for (const k of Object.keys(params)) {
    if (params[k] === "" || params[k] === "[]") delete params[k];
  }
  params.callback = "bkt_main_cb";
  params._ = String(Date.now());

  log("INFO", `/main/ params : ${JSON.stringify(params).slice(0, 200)}`);

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
  log("INFO", `Phase A (browser)      : CF résolu + token extrait (${widgetToken.slice(0, 20)}…)`);
  log("INFO", `Étape 1 (POST token)   : ${body2.length}B | bkt_init_widget=${bktWidget ? "✅" : "❌"}`);
  log("INFO", `Étape 2 (GET /main/)   : ${body3.length}B | ${body3.length > 1000 ? "✅ DONNÉES RÉELLES" : body3.includes("Exception") ? "❌ Exception" : "❌ Échec"}`);

  if (body3.length > 1000) {
    console.log("\n  ┌──────────────────────────────────────────────────────────────┐");
    console.log("  │ SUCCÈS : browser CF solve → Impit POST+/main/ fonctionne !  │");
    console.log("  │ → Le TLS binding est bypass via POST direct (pas de GET)    │");
    console.log("  └──────────────────────────────────────────────────────────────┘");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
