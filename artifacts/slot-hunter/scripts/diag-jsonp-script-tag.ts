/**
 * diag-jsonp-script-tag.ts — Test JSONP via script tag depuis page.evaluate
 *
 * Hypothèse : CF autorise /onlinebookings/* uniquement via script tags
 * (sec-fetch-dest: script) comme jQuery JSONP, pas via XHR/fetch
 * (sec-fetch-dest: empty).
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { solveCfChallenge, preparePageStealth } from "../src/cf-challenge-solver.js";
import { resolveSpainProxy } from "../src/spain/spain-hybrid-session.js";

puppeteer.use(StealthPlugin());

const PORTAL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const KEY    = "2d01502f12dc08400e22aea87fb00ae34";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

function buildUrl(endpoint: string, extra: Record<string, string> = {}): string {
  const cb = `cb_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const params = new URLSearchParams({
    callback: cb,
    type: "default",
    publickey: KEY,
    lang: "es",
    version: "4",
    src: PORTAL,
    srvsrc: "https://www.citaconsular.es",
    _: Date.now().toString(),
    ...extra,
  });
  return { url: `https://www.citaconsular.es/onlinebookings/${endpoint}?${params}`, cb };
}

/** JSONP via script tag — sec-fetch-dest: script, sec-fetch-mode: no-cors */
async function jsonpScriptTag(page: any, endpoint: string, extra: Record<string, string> = {}): Promise<string> {
  const { url, cb } = buildUrl(endpoint, extra) as any;
  return page.evaluate(({ url, cb }: any) => {
    return new Promise<string>((resolve) => {
      (window as any)[cb] = (data: any) => {
        delete (window as any)[cb];
        resolve(JSON.stringify(data));
      };
      const script = document.createElement("script");
      script.src = url;
      script.onerror = () => { delete (window as any)[cb]; resolve("SCRIPT_ERROR"); };
      setTimeout(() => { delete (window as any)[cb]; resolve("TIMEOUT"); }, 15_000);
      document.head.appendChild(script);
    });
  }, { url, cb });
}

/** jQuery JSONP (si jQuery disponible sur la page) */
async function jqueryJsonp(page: any, endpoint: string, extra: Record<string, string> = {}): Promise<string> {
  const { url } = buildUrl(endpoint, extra) as any;
  return page.evaluate((url: string) => {
    return new Promise<string>((resolve) => {
      if (typeof (window as any).$ === "undefined") { resolve("NO_JQUERY"); return; }
      (window as any).$.ajax({
        url,
        dataType: "jsonp",
        success: (data: any) => resolve(JSON.stringify(data)),
        error: (_: any, status: string, err: any) => resolve(`JQ_ERROR: ${status} ${err}`),
        timeout: 15_000,
      });
    });
  }, url);
}

function mark(body: string): string {
  if (body === "TIMEOUT" || body === "SCRIPT_ERROR" || body === "NO_JQUERY") return `❌ ${body}`;
  if (body.startsWith("JQ_ERROR") || body.startsWith("EVAL_ERROR")) return `❌ ${body}`;
  if (body.length > 20) return `✅ ${body.length}B | ${body.slice(0, 100)}`;
  return `⚠️  ${body.slice(0, 80)}`;
}

async function main() {
  const proxyUrl = resolveSpainProxy();
  const proxyParsed = new URL(proxyUrl);
  const proxyServer = `http://${proxyParsed.hostname}:${proxyParsed.port}`;
  const proxyAuth = { username: decodeURIComponent(proxyParsed.username), password: decodeURIComponent(proxyParsed.password) };

  console.log("\n══ DIAG JSONP script tag vs XHR vs fetch ══════════════════════════════\n");

  const browser: any = await (puppeteer as any).launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,720",
      "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
      `--proxy-server=${proxyServer}`,
    ],
    defaultViewport: { width: 1280, height: 720 },
  });

  const pages = await browser.pages();
  const page: any = pages[0] ?? await browser.newPage();
  await page.authenticate(proxyAuth);
  await page.setUserAgent(UA);
  await preparePageStealth(page, UA);
  page.on("dialog", async (d: any) => { await d.accept().catch(() => {}); });

  let mainHtml = "";
  let mainResolve: (() => void) | null = null;
  const mainSignal = new Promise<void>(r => { mainResolve = r; });

  // Capturer les réponses réseau pour comparer sec-fetch-dest
  const networkCalls: Array<{ url: string; sf_dest?: string; sf_mode?: string; bodyLen: number }> = [];
  const CDP = await page.createCDPSession();
  await CDP.send("Network.enable");
  CDP.on("Network.requestWillBeSentExtraInfo", (e: any) => {
    const url: string = Object.values(e.headers ?? {}).join("") || "";
    // Chercher les headers dans le context
    const h = e.headers as Record<string, string>;
    const reqUrl = Object.entries(e.headers ?? {}).find(([k]) => k === ":path")?.[1] as string ?? "";
    if (reqUrl.includes("/onlinebookings/")) {
      networkCalls.push({
        url: reqUrl,
        sf_dest: h["sec-fetch-dest"],
        sf_mode: h["sec-fetch-mode"],
        bodyLen: 0,
      });
    }
  });
  CDP.on("Network.responseReceived", (e: any) => {
    const url: string = e.response?.url ?? "";
    if (url.includes("/onlinebookings/")) {
      const entry = networkCalls.find(c => url.includes(c.url));
      if (entry) entry.bodyLen = parseInt(e.response?.headers?.["content-length"] ?? "0", 10);
    }
  });

  page.on("response", async (res: any) => {
    const url: string = res.url();
    if (url.includes("/onlinebookings/main/") && res.status() === 200) {
      const text = await res.text().catch(() => "");
      if (text.length > 10_000) { mainHtml = text; mainResolve?.(); }
    }
  });

  // Phase 1 : CF + Continuar
  console.log("[Phase 1] CF solve + Continuar…");
  await page.goto(`${PORTAL}?_cb=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 70_000 }).catch(() => {});
  await solveCfChallenge(page, { targetUrl: PORTAL, timeout: 120_000, enableCapsolverFallback: false });
  await new Promise(r => setTimeout(r, 2_500));
  await page.evaluate(() => {
    const f = (document.querySelector('input[name="token"]') as HTMLInputElement)?.form
           ?? document.querySelector("form");
    if (f) (f as HTMLFormElement).submit();
  });
  await Promise.race([mainSignal, new Promise(r => setTimeout(r, 30_000))]);
  console.log(`  ✅ /main/ capturé: ${mainHtml.length}B`);

  // Pause pour laisser les calls initiaux du widget JS se terminer
  await new Promise(r => setTimeout(r, 3_000));

  // Réseau : afficher les calls capturés avec leurs sec-fetch-dest
  console.log(`\n[Réseau] Calls /onlinebookings/* capturés (${networkCalls.length}):`);
  for (const c of networkCalls.slice(-10)) {
    console.log(`  ${c.url.split("?")[0]} | sec-fetch-dest: ${c.sf_dest ?? "?"} | sec-fetch-mode: ${c.sf_mode ?? "?"} | content-length: ${c.bodyLen}`);
  }

  // Phase 2 : Tests
  console.log("\n[Phase 2] Tests JSONP script tag vs XHR vs fetch…\n");

  // A) Script tag JSONP
  console.log("── A) script tag JSONP (sec-fetch-dest: script) ────────────────────────");
  const a1 = await jsonpScriptTag(page, "getwidgetconfigurations/");
  console.log(`  getwidgetconfigurations/ : ${mark(a1)}`);
  const a2 = await jsonpScriptTag(page, "getservices/");
  console.log(`  getservices/              : ${mark(a2)}`);
  const a3 = await jsonpScriptTag(page, "main/");
  console.log(`  main/                     : ${mark(a3)}`);

  // B) jQuery JSONP (si disponible)
  console.log("\n── B) jQuery JSONP ─────────────────────────────────────────────────────");
  const b1 = await jqueryJsonp(page, "getservices/");
  console.log(`  getservices/ (jQuery)     : ${mark(b1)}`);
  const b2 = await jqueryJsonp(page, "main/");
  console.log(`  main/ (jQuery)            : ${mark(b2)}`);

  // C) fetch / XHR (contrôle — devrait échouer)
  console.log("\n── C) fetch (sec-fetch-dest: empty) — contrôle ─────────────────────────");
  const c1 = await page.evaluate(async (url: string) => {
    const r = await fetch(url, { credentials: "include" }).catch((e: any) => ({ status: 0, headers: { get: () => "" }, text: async () => `ERR: ${e.message}` }));
    return { status: (r as any).status, bodyLen: ((await (r as any).text()) as string).length, ct: (r as any).headers.get("content-type") };
  }, buildUrl("getservices/").url);
  console.log(`  getservices/ (fetch)      : `, c1);

  // D) Vérifier si le page.evaluate script tag capture les sec-fetch headers
  console.log("\n── D) CDP sec-fetch-dest sur nos calls (last 5) ────────────────────────");
  for (const c of networkCalls.slice(-5)) {
    console.log(`  ${c.url.split("?")[0]} → sec-fetch-dest: ${c.sf_dest ?? "pas capturé"}`);
  }

  await browser.close().catch(() => {});
  console.log("\n══ FIN ══════════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
