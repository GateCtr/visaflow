/**
 * diag-session-http-alignment.ts — Diagnostic session browser → requêtes HTTP alignées
 *
 * OBJECTIF : Tester que les requêtes HTTP via la session browser obtiennent des réponses
 * valides (non-0B) en alignant exactement le format JSONP, les headers et l'ordre d'appel
 * sur ce que le widget natif Bookitit fait.
 *
 * DIAGNOSTICS :
 *   1. Obtention session browser (Puppeteer stealth) avec CF challenge résolu
 *   2. Extraction PHPSESSID + cf_clearance + cookies depuis le navigateur
 *   3. Test appels JSONP séquentiels via page.evaluate (même session TLS) :
 *      - main/ → getwidgetconfigurations/ → getservices/ → getagendas/ → datetime/
 *   4. Test appels JSONP via jQuery.ajax natif du widget (fallback)
 *   5. Test appels HTTP via impit avec la même session (comparaison)
 *   6. Rapport détaillé avec taille des réponses et détection des 0B
 *
 * Usage:
 *   npx tsx scripts/diag-session-http-alignment.ts [--portal kinshasa|saopolo]
 *
 * Prérequis:
 *   - Proxy configuré via fichier CSV (decodo-proxies.csv) ou variables d'env (SOAX_PROXY_URL / DECODO_PROXY_URL)
 *   - Chromium installé via Puppeteer
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  KINSHASA_PORTAL_URL,
  KINSHASA_WIDGET_KEY,
  SAOPOLO_PORTAL_URL,
  SAOPOLO_WIDGET_KEY,
  extractWidgetKey,
} from "../src/spain-portals.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const portal = process.argv.includes("--portal")
  ? process.argv[process.argv.indexOf("--portal") + 1]
  : "kinshasa";

const PORTAL_CONFIG = {
  kinshasa: { url: KINSHASA_PORTAL_URL, key: KINSHASA_WIDGET_KEY },
  saopolo: { url: SAOPOLO_PORTAL_URL, key: SAOPOLO_WIDGET_KEY },
}[portal] ?? { url: KINSHASA_PORTAL_URL, key: KINSHASA_WIDGET_KEY };

const BASE = "https://www.citaconsular.es/onlinebookings/";
const SRVSRC = "https://www.citaconsular.es";

// ─── Chargement proxy depuis CSV (priorité) ou variables d'env ──────────────

/** Parse le fichier CSV Decodo → première URL http://user:pass@host:port */
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

/** Résout le proxy : CSV → SOAX_PROXY_URL → DECODO_PROXY_URL → aucun */
function resolveProxyUrl(): string {
  const fromCsv = loadProxyFromCsv();
  if (fromCsv) return fromCsv;
  if (process.env.SOAX_PROXY_URL) return process.env.SOAX_PROXY_URL;
  if (process.env.DECODO_PROXY_URL) return process.env.DECODO_PROXY_URL;
  return "";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Génère un callback jQuery 2.1.1 natif — format exact utilisé par le widget Backbone Bookitit. */
function jqCallback(): string {
  return `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function buildParams(endpoint: string, extra: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams();
  q.append("callback", jqCallback());
  q.append("type", "default");
  q.append("publickey", PORTAL_CONFIG.key);
  q.append("lang", "es");
  q.append("version", "4");
  q.append("src", PORTAL_CONFIG.url.replace(/#.*$/, "").replace(/\/?$/, "/"));
  q.append("srvsrc", SRVSRC);
  for (const [k, v] of Object.entries(extra)) {
    q.append(k, v);
  }
  q.append("_", String(Date.now()));
  return q;
}

function parseJsonpPayload(text: string): unknown | null {
  if (!text || typeof text !== "string") return null;
  let src = text.trim();
  if (!src) return null;
  src = src.replace(/^callback=/i, "");
  const m = src.match(/^[\w$.]+\(([\s\S]*)\);?\s*$/);
  if (m) {
    try { return JSON.parse(m[1]); } catch { /* fall through */ }
  }
  try { return JSON.parse(src); } catch { return null; }
}

function formatSize(body: string): string {
  if (!body || body.length === 0) return "0B ❌";
  if (body.startsWith("__ERR_")) return `${body.slice(0, 60)} ❌`;
  return `${body.length}B ✅`;
}

// ─── Diagnostic Steps ───────────────────────────────────────────────────────

interface DiagResult {
  step: string;
  method: string;
  endpoint: string;
  size: number;
  status: "ok" | "empty" | "error";
  detail: string;
  callbackUsed?: string;
}

const results: DiagResult[] = [];

async function diagStep(
  step: string,
  method: string,
  endpoint: string,
  fn: () => Promise<{ body: string; callback?: string }>,
): Promise<string> {
  const t0 = Date.now();
  try {
    const { body, callback } = await fn();
    const elapsed = Date.now() - t0;
    const status = body.length > 10 && !body.startsWith("__ERR_") ? "ok" : "empty";
    const parsed = status === "ok" ? parseJsonpPayload(body) : null;
    const keys = parsed && typeof parsed === "object" ? Object.keys(parsed as object).slice(0, 5).join(",") : "-";
    const detail = `${body.length}B en ${elapsed}ms | keys=[${keys}]`;
    results.push({ step, method, endpoint, size: body.length, status, detail, callbackUsed: callback });
    console.log(`  ${status === "ok" ? "✅" : "❌"} [${step}] ${method} ${endpoint} → ${detail}${callback ? ` | cb=${callback.slice(0, 30)}…` : ""}`);
    return body;
  } catch (err) {
    const elapsed = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ step, method, endpoint, size: 0, status: "error", detail: `ERROR en ${elapsed}ms: ${msg.slice(0, 120)}` });
    console.log(`  ❌ [${step}] ${method} ${endpoint} → ERROR: ${msg.slice(0, 120)}`);
    return "";
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  DIAGNOSTIC : Session Browser → Requêtes HTTP Alignées         ║");
  console.log("║  Portail : " + portal.padEnd(54) + "║");
  console.log("║  Widget  : " + PORTAL_CONFIG.key.padEnd(54) + "║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  // ── Étape 1 : Lancement du browser Puppeteer stealth ──────────────────────
  console.log("═══ ÉTAPE 1 : Lancement du navigateur Puppeteer stealth ═══");
  let puppeteer: typeof import("puppeteer");
  let pluginStealth: typeof import("puppeteer-extra-plugin-stealth");
  try {
    puppeteer = await import("puppeteer");
    pluginStealth = await import("puppeteer-extra-plugin-stealth");
  } catch {
    console.error("❌ puppeteer ou puppeteer-extra-plugin-stealth non installé");
    process.exit(1);
  }

  // Utiliser puppeteer-extra si disponible
  let launchFn: typeof puppeteer.launch;
  try {
    const puppeteerExtra = await import("puppeteer-extra");
    puppeteerExtra.default.use(pluginStealth.default());
    launchFn = puppeteerExtra.default.launch.bind(puppeteerExtra.default);
    console.log("  ✅ puppeteer-extra + stealth plugin chargés");
  } catch {
    launchFn = puppeteer.launch.bind(puppeteer);
    console.log("  ⚠️ puppeteer-extra non disponible, utilisation de puppeteer vanilla");
  }

  const proxyUrl = resolveProxyUrl();
  const proxyArgs = proxyUrl ? [`--proxy-server=${new URL(proxyUrl).host}`] : [];

  const browser = await launchFn({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      ...proxyArgs,
    ],
  });

  const page = await browser.newPage();
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  await page.setUserAgent(ua);
  await page.setViewport({ width: 1920, height: 1080 });

  // Authentification proxy si nécessaire
  if (proxyUrl) {
    try {
      const proxyParsed = new URL(proxyUrl);
      if (proxyParsed.username) {
        await page.authenticate({
          username: decodeURIComponent(proxyParsed.username),
          password: decodeURIComponent(proxyParsed.password),
        });
        console.log(`  ✅ Proxy configuré : ${proxyParsed.host}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ Proxy auth échoué : ${e}`);
    }
  }

  console.log();

  // ── Étape 2 : Navigation vers le portail + résolution CF ──────────────────
  console.log("═══ ÉTAPE 2 : Navigation vers le portail + résolution CF ═══");
  const portalUrl = PORTAL_CONFIG.url;
  console.log(`  → Navigation vers ${portalUrl}`);

  try {
    await page.goto(portalUrl, { waitUntil: "networkidle2", timeout: 90_000 });
  } catch (e) {
    console.error(`  ❌ Navigation échouée : ${e}`);
    await browser.close();
    process.exit(1);
  }

  // Attendre que le widget se charge
  await new Promise((r) => setTimeout(r, 5000));
  const pageUrl = page.url();
  console.log(`  ✅ Page chargée : ${pageUrl}`);

  // Vérifier si on est bloqué par CF
  const pageContent = await page.content();
  const isCf = /just a moment|verifying|_cf_chl_opt|challenge-platform/i.test(pageContent.slice(0, 4000));
  if (isCf) {
    console.log("  ⚠️ Challenge Cloudflare détecté — attente de résolution (max 60s)…");
    await new Promise((r) => setTimeout(r, 15000));
    const pageContent2 = await page.content();
    const stillCf = /just a moment|verifying|_cf_chl_opt/i.test(pageContent2.slice(0, 4000));
    if (stillCf) {
      console.error("  ❌ Challenge CF non résolu après 60s");
      await browser.close();
      process.exit(1);
    }
    console.log("  ✅ Challenge CF résolu");
  } else {
    console.log("  ✅ Pas de challenge CF (accès direct)");
  }

  // ── Étape 3 : Extraction des cookies ──────────────────────────────────────
  console.log();
  console.log("═══ ÉTAPE 3 : Extraction des cookies ═══");
  const cookies = await page.cookies();
  const phpSessId = cookies.find((c) => c.name === "PHPSESSID");
  const cfClearance = cookies.find((c) => c.name === "cf_clearance");
  const allCookieNames = cookies.map((c) => `${c.name}=${c.value.slice(0, 15)}…`).join("; ");

  console.log(`  Cookies (${cookies.length}) : ${allCookieNames}`);
  console.log(`  PHPSESSID    : ${phpSessId ? phpSessId.value.slice(0, 20) + "…" : "❌ ABSENT"}`);
  console.log(`  cf_clearance : ${cfClearance ? cfClearance.value.slice(0, 20) + "…" : "❌ ABSENT"}`);

  // Vérifier si bkt_init_widget est disponible
  const widgetState = await page.evaluate(() => {
    const w = window as any;
    return {
      hasjQuery: !!w.jQuery,
      jQueryVersion: w.jQuery?.fn?.jquery ?? "N/A",
      hasBktInit: !!w.bkt_init_widget,
      bktKeys: w.bkt_init_widget ? Object.keys(w.bkt_init_widget).join(",") : "N/A",
      bktPublickey: w.bkt_init_widget?.publickey ?? "N/A",
      bktSrvsrc: w.bkt_init_widget?.srvsrc ?? "N/A",
    };
  });
  console.log(`  jQuery       : ${widgetState.hasjQuery ? `v${widgetState.jQueryVersion} ✅` : "❌ ABSENT"}`);
  console.log(`  bkt_init     : ${widgetState.hasBktInit ? `✅ keys=[${widgetState.bktKeys}]` : "❌ ABSENT"}`);
  console.log(`  publickey    : ${widgetState.bktPublickey}`);
  console.log(`  srvsrc       : ${widgetState.bktSrvsrc}`);
  console.log();

  // ── Étape 4 : Tests JSONP séquentiels via page.evaluate(fetch) ────────────
  console.log("═══ ÉTAPE 4 : Tests JSONP via page.evaluate(fetch) — même session TLS ═══");
  console.log("  (Simule des requêtes fetch() depuis le contexte page, avec credentials:include)");
  console.log();

  // 4a. getwidgetconfigurations/ (initialise la session PHP)
  const cfgCb = jqCallback();
  const cfgParams = buildParams("getwidgetconfigurations/");
  const cfgUrl = `${BASE}getwidgetconfigurations/?${cfgParams}`;

  const cfgBody = await diagStep("4a", "fetch", "getwidgetconfigurations/", async () => {
    const body = await page.evaluate(async (url: string) => {
      try {
        const r = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            "Accept": "text/javascript, application/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": window.location.href,
          },
        });
        return await r.text();
      } catch (e) {
        return `__ERR_FETCH_${String(e).slice(0, 100)}`;
      }
    }, cfgUrl);
    return { body, callback: cfgParams.get("callback") ?? "" };
  });

  // Pause séquentielle (le serveur initialise la session PHP)
  await new Promise((r) => setTimeout(r, 300));

  // 4b. getservices/
  const svcParams = buildParams("getservices/");
  const svcUrl = `${BASE}getservices/?${svcParams}`;

  const svcBody = await diagStep("4b", "fetch", "getservices/", async () => {
    const body = await page.evaluate(async (url: string) => {
      try {
        const r = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            "Accept": "text/javascript, application/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": window.location.href,
          },
        });
        return await r.text();
      } catch (e) {
        return `__ERR_FETCH_${String(e).slice(0, 100)}`;
      }
    }, svcUrl);
    return { body, callback: svcParams.get("callback") ?? "" };
  });

  // Extraire les services disponibles
  let serviceIds: string[] = [];
  const svcParsed = parseJsonpPayload(svcBody);
  if (svcParsed && typeof svcParsed === "object") {
    const p = svcParsed as Record<string, unknown>;
    if (Array.isArray(p.Services)) {
      for (const s of p.Services) {
        const id = s && typeof s === "object" ? (s as Record<string, unknown>).id : undefined;
        if (typeof id === "string" && id.length > 0) serviceIds.push(id);
      }
    }
  }
  console.log(`  → Services trouvés : ${serviceIds.length > 0 ? serviceIds.join(", ") : "aucun"}`);

  // 4c. getagendas/ (pour le premier service)
  if (serviceIds.length > 0) {
    const svcId = serviceIds[0];
    const agParams = buildParams("getagendas/", { "services[]": svcId });
    const agUrl = `${BASE}getagendas/?${agParams}`;

    await diagStep("4c", "fetch", `getagendas/ [${svcId}]`, async () => {
      const body = await page.evaluate(async (url: string) => {
        try {
          const r = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: {
              "Accept": "text/javascript, application/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
              "Referer": window.location.href,
            },
          });
          return await r.text();
        } catch (e) {
          return `__ERR_FETCH_${String(e).slice(0, 100)}`;
        }
      }, agUrl);
      return { body, callback: agParams.get("callback") ?? "" };
    });

    // 4d. datetime/ (mois courant)
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const dtParams = buildParams("datetime/", {
      "services[]": svcId,
      "start": start,
      "end": end,
      "selectedPeople": "1",
    });
    const dtUrl = `${BASE}datetime/?${dtParams}`;

    await diagStep("4d", "fetch", `datetime/ [${svcId}] ${start}→${end}`, async () => {
      const body = await page.evaluate(async (url: string) => {
        try {
          const r = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: {
              "Accept": "text/javascript, application/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
              "Referer": window.location.href,
            },
          });
          return await r.text();
        } catch (e) {
          return `__ERR_FETCH_${String(e).slice(0, 100)}`;
        }
      }, dtUrl);
      return { body, callback: dtParams.get("callback") ?? "" };
    });
  }

  console.log();

  // ── Étape 5 : Tests JSONP via jQuery.ajax natif (widget) ──────────────────
  console.log("═══ ÉTAPE 5 : Tests JSONP via jQuery.ajax natif (bkt_init_widget) ═══");
  console.log("  (Utilise le mécanisme exact du widget Backbone — callback auto-généré par jQuery)");
  console.log();

  async function jqueryAjaxJsonp(endpoint: string, extra: Record<string, string> = {}): Promise<string> {
    const epStr = JSON.stringify(endpoint);
    const extraStr = JSON.stringify(extra);
    const result = await page.evaluate(`
      (function(endpoint, extra) {
        return new Promise(function(resolve) {
          var jq = window.jQuery;
          var init = window.bkt_init_widget;
          if (!jq || !init || !init.srvsrc) {
            resolve('__ERR_NO_WIDGET');
            return;
          }
          var data = {};
          for (var k in init) {
            if (Object.prototype.hasOwnProperty.call(init, k)) data[k] = init[k];
          }
          var srvsrc = data.srvsrc;
          delete data.srvsrc;
          data._ = String(Date.now());
          for (var ek in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, ek)) data[ek] = extra[ek];
          }
          var timer = setTimeout(function() { resolve('__ERR_WIDGET_JSONP_TIMEOUT'); }, 22000);
          jq.ajax({
            url: srvsrc + '/onlinebookings/' + endpoint,
            dataType: 'jsonp',
            jsonp: 'callback',
            data: data,
            success: function(resp) {
              clearTimeout(timer);
              try { resolve(JSON.stringify(resp)); }
              catch(e) { resolve('__ERR_STRINGIFY'); }
            },
            error: function(_xhr, status) {
              clearTimeout(timer);
              resolve('__ERR_WIDGET_AJAX_' + String(status || 'error'));
            }
          });
        });
      })(${epStr}, ${extraStr})
    `) as string;
    return result;
  }

  // 5a. getwidgetconfigurations/ via jQuery
  await diagStep("5a", "jQuery.ajax", "getwidgetconfigurations/", async () => {
    const body = await jqueryAjaxJsonp("getwidgetconfigurations/");
    return { body };
  });

  await new Promise((r) => setTimeout(r, 300));

  // 5b. getservices/ via jQuery
  await diagStep("5b", "jQuery.ajax", "getservices/", async () => {
    const body = await jqueryAjaxJsonp("getservices/");
    return { body };
  });

  if (serviceIds.length > 0) {
    // 5c. getagendas/ via jQuery
    const svcId = serviceIds[0];
    await diagStep("5c", "jQuery.ajax", `getagendas/ [${svcId}]`, async () => {
      const body = await jqueryAjaxJsonp("getagendas/", { "services[]": svcId });
      return { body };
    });

    // 5d. datetime/ via jQuery
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    await diagStep("5d", "jQuery.ajax", `datetime/ [${svcId}]`, async () => {
      const body = await jqueryAjaxJsonp("datetime/", {
        "services[]": svcId,
        "start": start,
        "end": end,
        "selectedPeople": "1",
      });
      return { body };
    });
  }

  console.log();

  // ── Étape 6 : Tests JSONP via script-tag (fallback callBookititViaJQueryInPage) ─
  console.log("═══ ÉTAPE 6 : Tests JSONP via script-tag injection ═══");
  console.log("  (Simule callBookititViaJQueryInPage — script src=url?callback=jQueryXXX)");
  console.log();

  async function scriptTagJsonp(url: string): Promise<string> {
    const result = await page.evaluate(`
      (function() {
        return new Promise(function(resolve) {
          var cbName = 'jQuery21109' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
          var timer = setTimeout(function() {
            delete window[cbName];
            resolve('__ERR_SCRIPT_TIMEOUT');
          }, 22000);
          window.callback = window.callback || null;
          window[cbName] = function(data) {
            clearTimeout(timer);
            delete window[cbName];
            try { resolve(JSON.stringify(data)); }
            catch(e) { resolve('__ERR_STRINGIFY'); }
          };
          var sc = document.createElement('script');
          sc.src = '${url.replace(/'/g, "\\'")}'.replace(/callback=[^&]+/, 'callback=' + cbName);
          sc.onerror = function() {
            clearTimeout(timer);
            delete window[cbName];
            resolve('__ERR_SCRIPT_LOAD');
          };
          document.head.appendChild(sc);
        });
      })()
    `) as string;
    return result;
  }

  // 6a. getwidgetconfigurations/ via script-tag
  const stCfgParams = buildParams("getwidgetconfigurations/");
  await diagStep("6a", "script-tag", "getwidgetconfigurations/", async () => {
    const body = await scriptTagJsonp(`${BASE}getwidgetconfigurations/?${stCfgParams}`);
    return { body, callback: stCfgParams.get("callback") ?? "" };
  });

  await new Promise((r) => setTimeout(r, 300));

  // 6b. getservices/ via script-tag
  const stSvcParams = buildParams("getservices/");
  await diagStep("6b", "script-tag", "getservices/", async () => {
    const body = await scriptTagJsonp(`${BASE}getservices/?${stSvcParams}`);
    return { body, callback: stSvcParams.get("callback") ?? "" };
  });

  console.log();

  // ── Étape 7 : Comparaison avec impit (HTTP externe) ───────────────────────
  console.log("═══ ÉTAPE 7 : Tests via impit (HTTP externe — même cookies, TLS différent) ═══");
  console.log("  (Compare le résultat impit vs browser pour détecter le binding TLS du PHPSESSID)");
  console.log();

  let impitAvailable = false;
  try {
    const { Impit } = await import("impit");
    impitAvailable = true;

    const impit = new Impit({ browser: "chrome" });

    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const headers: Record<string, string> = {
      "User-Agent": ua,
      "Accept": "*/*",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Cookie": cookieStr,
      "Referer": PORTAL_CONFIG.url.replace(/#.*$/, "").replace(/\/?$/, "/"),
      "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="136", "Google Chrome";v="136"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
    };

    // 7a. getwidgetconfigurations/ via impit
    const impitCfgParams = buildParams("getwidgetconfigurations/");
    await diagStep("7a", "impit", "getwidgetconfigurations/", async () => {
      const res = await impit.fetch(`${BASE}getwidgetconfigurations/?${impitCfgParams}`, {
        headers,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      } as any) as unknown as Response;
      const body = await res.text();
      return { body, callback: impitCfgParams.get("callback") ?? "" };
    });

    await new Promise((r) => setTimeout(r, 300));

    // 7b. getservices/ via impit
    const impitSvcParams = buildParams("getservices/");
    await diagStep("7b", "impit", "getservices/", async () => {
      const res = await impit.fetch(`${BASE}getservices/?${impitSvcParams}`, {
        headers,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      } as any) as unknown as Response;
      const body = await res.text();
      return { body, callback: impitSvcParams.get("callback") ?? "" };
    });

    await impit.close();
  } catch (e) {
    console.log(`  ⚠️ impit non disponible ou erreur : ${e}`);
  }

  console.log();

  // ── Rapport final ─────────────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                    RAPPORT DIAGNOSTIC FINAL                     ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  console.log("┌─────────┬──────────────┬──────────────────────────────┬─────────┬──────────────────────────────────────┐");
  console.log("│ Étape   │ Méthode      │ Endpoint                     │ Taille  │ Détail                               │");
  console.log("├─────────┼──────────────┼──────────────────────────────┼─────────┼──────────────────────────────────────┤");

  for (const r of results) {
    const icon = r.status === "ok" ? "✅" : "❌";
    const step = r.step.padEnd(7);
    const method = r.method.padEnd(12);
    const ep = r.endpoint.slice(0, 28).padEnd(28);
    const size = `${r.size}B`.padEnd(7);
    const detail = r.detail.slice(0, 36);
    console.log(`│ ${icon} ${step}│ ${method} │ ${ep} │ ${size} │ ${detail.padEnd(36)} │`);
  }

  console.log("└─────────┴──────────────┴──────────────────────────────┴─────────┴──────────────────────────────────────┘");
  console.log();

  // Analyse
  const okCount = results.filter((r) => r.status === "ok").length;
  const emptyCount = results.filter((r) => r.status === "empty").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  console.log(`Résultat : ${okCount} ✅ OK | ${emptyCount} ❌ vides (0B) | ${errorCount} ⚠️ erreurs`);
  console.log();

  // Analyse spécifique browser vs impit
  const browserOk = results.filter((r) => (r.method === "fetch" || r.method.startsWith("jQuery") || r.method === "script-tag") && r.status === "ok").length;
  const impitOk = results.filter((r) => r.method === "impit" && r.status === "ok").length;
  const browserTotal = results.filter((r) => r.method !== "impit").length;
  const impitTotal = results.filter((r) => r.method === "impit").length;

  if (impitTotal > 0) {
    console.log("═══ ANALYSE : Browser vs impit ═══");
    console.log(`  Browser : ${browserOk}/${browserTotal} OK`);
    console.log(`  impit   : ${impitOk}/${impitTotal} OK`);
    if (browserOk > impitOk) {
      console.log("  → Conclusion : le PHPSESSID est probablement lié à la session TLS du browser.");
      console.log("    Les requêtes DOIVENT passer par le browser (page.evaluate) ou via jQuery.ajax natif.");
      console.log("    impit ne peut pas réutiliser le PHPSESSID obtenu par Chromium.");
    } else if (browserOk === impitOk && browserOk > 0) {
      console.log("  → Conclusion : les deux méthodes fonctionnent — le PHPSESSID n'est PAS lié au TLS.");
      console.log("    Les requêtes HTTP via impit avec les bons cookies/headers devraient fonctionner.");
    } else if (browserOk === 0 && impitOk === 0) {
      console.log("  → Conclusion : AUCUNE méthode ne fonctionne — vérifier la session CF et le PHPSESSID.");
    }
  }

  console.log();
  console.log("═══ VÉRIFICATIONS CLÉS ═══");
  if (!phpSessId) {
    console.log("  ❌ PHPSESSID absent — le browser n'a pas reçu de session PHP");
  }
  if (!cfClearance) {
    console.log("  ❌ cf_clearance absent — le challenge CF n'a pas été résolu");
  }
  if (!widgetState.hasjQuery) {
    console.log("  ❌ jQuery non chargé — le widget Bookitit n'est pas initialisé");
  }
  if (!widgetState.hasBktInit) {
    console.log("  ❌ bkt_init_widget absent — les params du widget ne sont pas disponibles");
  }
  if (phpSessId && cfClearance && widgetState.hasjQuery && widgetState.hasBktInit) {
    console.log("  ✅ Tous les prérequis sont en place (PHPSESSID, cf_clearance, jQuery, bkt_init_widget)");
  }

  await browser.close();
  console.log();
  console.log("Diagnostic terminé.");
  process.exit(okCount > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Erreur fatale :", err);
  process.exit(1);
});
