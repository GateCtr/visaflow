/**
 * test-scrapedo-citaconsular.ts — Test Scrape.do sur citaconsular.es
 *
 * Vérifie si l'API Scrape.do (render + super + geoCode=es) peut contourner
 * Cloudflare et accéder au widget Bookitit / aux endpoints JSONP.
 *
 * Usage :
 *   SCRAPE_DO_TOKEN=xxx tsx src/scripts/test-scrapedo-citaconsular.ts
 *
 * Options env :
 *   SCRAPE_DO_TOKEN      — jeton API (obligatoire, alias: SCRAPER_API_KEY)
 *   SCRAPE_DO_SUPER=1    — proxy résidentiel (10–25 crédits/requête, recommandé CF)
 *   SCRAPE_DO_GEO=es     — géo cible (défaut: es)
 *   SPAIN_PORTAL_URL     — URL widget (défaut: Kinshasa)
 */

import "dotenv/config";
import {
  KINSHASA_PORTAL_URL,
  KINSHASA_WIDGET_KEY,
  extractWidgetKey,
} from "../spain-portals.js";

const TOKEN = (process.env.SCRAPE_DO_TOKEN ?? process.env.SCRAPER_API_KEY ?? "").trim();
const USE_SUPER = process.env.SCRAPE_DO_SUPER !== "0";
const GEO = process.env.SCRAPE_DO_GEO ?? "es";
const PORTAL_URL = process.env.SPAIN_PORTAL_URL ?? KINSHASA_PORTAL_URL;
const WIDGET_KEY = extractWidgetKey(PORTAL_URL);
const WIDGET_BASE = `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/`;
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings/";

// ─── Log helpers ─────────────────────────────────────────────────────────────

function section(title: string) {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}
function subsection(title: string) {
  console.log(`\n  ── ${title}`);
}
function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

// ─── Scrape.do client ────────────────────────────────────────────────────────

interface ScrapeDoParams {
  render?: boolean;
  super?: boolean;
  geoCode?: string;
  pureCookies?: boolean;
  returnJSON?: boolean;
  customWait?: number;
  waitSelector?: string;
  setCookies?: string;
  timeout?: number;
  blockResources?: boolean;
}

interface ScrapeDoResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  elapsedMs: number;
  scrapeDoHeaders: Headers;
}

function buildScrapeDoUrl(targetUrl: string, params: ScrapeDoParams): string {
  const q = new URLSearchParams();
  q.set("token", TOKEN);
  q.set("url", targetUrl);
  if (params.render) q.set("render", "true");
  if (params.super) q.set("super", "true");
  if (params.geoCode) q.set("geoCode", params.geoCode);
  if (params.pureCookies) q.set("pureCookies", "true");
  if (params.returnJSON) q.set("returnJSON", "true");
  if (params.customWait != null) q.set("customWait", String(params.customWait));
  if (params.waitSelector) q.set("waitSelector", params.waitSelector);
  if (params.setCookies) q.set("setCookies", params.setCookies);
  if (params.timeout != null) q.set("timeout", String(params.timeout));
  if (params.blockResources === false) q.set("blockResources", "false");
  return `https://api.scrape.do/?${q.toString()}`;
}

async function scrapeDoFetch(
  targetUrl: string,
  params: ScrapeDoParams,
  label: string,
): Promise<ScrapeDoResult> {
  const apiUrl = buildScrapeDoUrl(targetUrl, params);
  const t0 = Date.now();
  info(`Requête: ${label}`);
  info(`Cible  : ${targetUrl.slice(0, 90)}${targetUrl.length > 90 ? "…" : ""}`);
  info(`Params : render=${!!params.render} super=${!!params.super} geo=${params.geoCode ?? "-"} pureCookies=${!!params.pureCookies} returnJSON=${!!params.returnJSON}`);

  const resp = await fetch(apiUrl, {
    method: "GET",
    signal: AbortSignal.timeout(params.timeout ?? 120_000),
  });
  const body = await resp.text();
  const elapsedMs = Date.now() - t0;

  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  console.log(`  📡 HTTP ${resp.status} | ${body.length}B | ${(elapsedMs / 1000).toFixed(1)}s`);
  return { status: resp.status, body, headers, elapsedMs, scrapeDoHeaders: resp.headers };
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function isCfChallenge(html: string): boolean {
  const slice = html.slice(0, 4000).toLowerCase();
  return (
    /just a moment|un instant|checking your browser|cf-browser-verification|challenge-platform/.test(slice)
    && !/bookitit|idbktd|widgetdefault|mainv1\.js/.test(slice)
  );
}

function analyzeHtml(html: string): void {
  const cf = isCfChallenge(html);
  const hasWidget = /widgetdefault|bookitit|idBkt|mainv1\.js/i.test(html);
  const hasCaptcha = /turnstile|cf-turnstile|hcaptcha/i.test(html);
  const hasServices = /#selectservice|selectservice|tramitaci/i.test(html);
  const title = html.match(/<title[^>]*>([^<]{0,120})/i)?.[1]?.trim() ?? "(sans title)";

  if (cf) fail(`Challenge Cloudflare détecté — title: "${title}"`);
  else if (hasWidget) ok(`Widget Bookitit présent — title: "${title}"`);
  else warn(`Pas de widget évident — title: "${title}"`);

  info(`  turnstile/captcha: ${hasCaptcha ? "oui" : "non"}`);
  info(`  services UI: ${hasServices ? "oui" : "non"}`);
  info(`  preview: ${html.replace(/\s+/g, " ").slice(0, 200)}…`);
}

function extractCookiesFromHeaders(headers: Record<string, string>): string {
  const raw = headers["set-cookie"] ?? headers["sd-set-cookie"] ?? "";
  if (!raw) return "";
  // Garder name=value pairs (ignore attributes)
  return raw
    .split(/,(?=\s*\w+=)/)
    .map((part) => part.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function findBookititRequests(jsonBody: string): string[] {
  try {
    const data = JSON.parse(jsonBody) as { requests?: Array<{ url?: string; response?: { content?: string } }> };
    const reqs = data.requests ?? [];
    return reqs
      .filter((r) => r.url?.includes("onlinebookings/"))
      .map((r) => {
        const ep = r.url?.match(/onlinebookings\/([^?]+)/)?.[1] ?? "?";
        const len = r.response?.content?.length ?? 0;
        return `${ep} → ${len}B`;
      });
  } catch {
    return [];
  }
}

function parseJsonp(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* continue */ }
  const m = raw.match(/^[\w$]+\((.+)\);?\s*$/s);
  if (m) { try { return JSON.parse(m[1]); } catch { /* continue */ } }
  return null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  section("TEST SCRAPE.DO × citaconsular.es — " + new Date().toISOString());

  if (!TOKEN) {
    fail("SCRAPE_DO_TOKEN (ou SCRAPER_API_KEY) manquant");
    info("Créez un compte sur https://scrape.do et ajoutez le token dans .env :");
    info("  SCRAPE_DO_TOKEN=votre_token");
    info("Puis relancez : tsx src/scripts/test-scrapedo-citaconsular.ts");
    process.exit(1);
  }

  info(`Portail  : ${PORTAL_URL}`);
  info(`Widget key: ${WIDGET_KEY}`);
  info(`Super    : ${USE_SUPER} | Geo: ${GEO}`);

  let sessionCookies = "";

  // ── Test 1 : page racine citaconsular.es ─────────────────────────────────
  subsection("Test 1 — Racine citaconsular.es (render + super)");
  try {
    const r1 = await scrapeDoFetch(
      "https://www.citaconsular.es/",
      { render: true, super: USE_SUPER, geoCode: GEO, pureCookies: true, customWait: 3000, timeout: 90_000 },
      "racine",
    );
    analyzeHtml(r1.body);
    sessionCookies = extractCookiesFromHeaders(r1.headers);
    if (sessionCookies) ok(`Cookies capturés (${sessionCookies.length}c): ${sessionCookies.slice(0, 120)}…`);
    else warn("Aucun Set-Cookie dans la réponse Scrape.do (pureCookies)");
  } catch (e) {
    fail(`Test 1 échoué: ${e}`);
  }

  // ── Test 2 : widget Kinshasa ─────────────────────────────────────────────
  subsection("Test 2 — Widget Bookitit (render + super + wait 5s)");
  try {
    const r2 = await scrapeDoFetch(
      WIDGET_BASE,
      {
        render: true,
        super: USE_SUPER,
        geoCode: GEO,
        pureCookies: true,
        customWait: 5000,
        blockResources: false,
        timeout: 120_000,
        setCookies: sessionCookies || undefined,
      },
      "widget",
    );
    analyzeHtml(r2.body);
    const c2 = extractCookiesFromHeaders(r2.headers);
    if (c2) sessionCookies = c2;
    if (sessionCookies.includes("cf_clearance")) ok("cf_clearance présent dans les cookies");
    else warn("cf_clearance absent — session CF peut être incomplète");
  } catch (e) {
    fail(`Test 2 échoué: ${e}`);
  }

  // ── Test 3 : returnJSON — capturer les requêtes réseau du widget ─────────
  subsection("Test 3 — returnJSON (requêtes réseau capturées par le headless)");
  try {
    const r3 = await scrapeDoFetch(
      WIDGET_BASE,
      {
        render: true,
        super: USE_SUPER,
        geoCode: GEO,
        returnJSON: true,
        customWait: 8000,
        blockResources: false,
        timeout: 120_000,
        setCookies: sessionCookies || undefined,
      },
      "returnJSON",
    );
    const bookititReqs = findBookititRequests(r3.body);
    if (bookititReqs.length > 0) {
      ok(`${bookititReqs.length} requête(s) Bookitit capturée(s):`);
      bookititReqs.forEach((line) => info(`    ${line}`));
    } else {
      warn("Aucune requête onlinebookings/ dans returnJSON");
      info(`Preview JSON: ${r3.body.slice(0, 300)}…`);
    }
  } catch (e) {
    fail(`Test 3 échoué: ${e}`);
  }

  // ── Test 4 : getwidgetconfigurations/ JSONP direct ───────────────────────
  subsection("Test 4 — getwidgetconfigurations/ JSONP (proxy, sans render)");
  const cfgCb = `jQueryCfg${Date.now()}`;
  const cfgParams = new URLSearchParams({
    callback: cfgCb,
    type: "default",
    publickey: WIDGET_KEY,
    lang: "es",
    version: "4",
    src: WIDGET_BASE,
    srvsrc: "https://www.citaconsular.es",
    _: String(Date.now()),
  });
  const cfgUrl = `${BOOKITIT_BASE}getwidgetconfigurations/?${cfgParams}`;

  try {
    const r4 = await scrapeDoFetch(
      cfgUrl,
      {
        render: false,
        super: USE_SUPER,
        geoCode: GEO,
        setCookies: sessionCookies || undefined,
        timeout: 60_000,
      },
      "getwidgetconfigurations",
    );
    const parsed = parseJsonp(r4.body);
    if (parsed && typeof parsed === "object") {
      const wc = (parsed as Record<string, unknown>).WidgetConfiguration as Record<string, unknown> | undefined;
      ok(`JSONP parsé — ${r4.body.length}B`);
      if (wc) {
        info(`  captcha=${wc.captcha} registration_type=${wc.registration_type}`);
      }
    } else if (isCfChallenge(r4.body)) {
      fail("Réponse HTML CF au lieu de JSONP");
    } else if (r4.body.length === 0) {
      fail("Body vide (0B) — session Bookitit non initialisée");
    } else {
      warn(`JSONP non parsé — ${r4.body.length}B: ${r4.body.slice(0, 150)}…`);
    }
  } catch (e) {
    fail(`Test 4 échoué: ${e}`);
  }

  // ── Test 5 : getwidgetconfigurations/ avec render (page exécute le JS) ───
  subsection("Test 5 — getwidgetconfigurations/ via render=true (headless exécute le fetch)");
  try {
    const r5 = await scrapeDoFetch(
      cfgUrl,
      {
        render: true,
        super: USE_SUPER,
        geoCode: GEO,
        setCookies: sessionCookies || undefined,
        customWait: 2000,
        timeout: 90_000,
      },
      "getwidgetconfigurations+render",
    );
    const parsed5 = parseJsonp(r5.body);
    if (parsed5) ok(`JSONP via render — ${r5.body.length}B`);
    else analyzeHtml(r5.body);
  } catch (e) {
    fail(`Test 5 échoué: ${e}`);
  }

  section("FIN — Résumé");
  info("Si Test 2 passe mais Test 4 = 0B → Bookitit exige same-origin browser (comme Decodo+Puppeteer).");
  info("Si Test 3 capture getwidgetconfigurations/ > 0B → Scrape.do peut remplacer le browser local.");
  info("Crédits : datacenter=1, super=10, super+render=25 par requête réussie.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
