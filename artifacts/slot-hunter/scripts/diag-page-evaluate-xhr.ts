/**
 * diag-page-evaluate-xhr.ts — Diagnostic XHR vs fetch depuis page.evaluate
 *
 * Compare :
 *   A) page.evaluate(fetch)          → ce qu'on a actuellement
 *   B) page.evaluate(XMLHttpRequest) → ce que jQuery.ajax() utilise
 *   C) Timing : immédiat vs +3s vs +10s après /main/
 *   D) Log complet du body 113B de /main/
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { solveCfChallenge, preparePageStealth } from "../src/cf-challenge-solver.js";
import { resolveSpainProxy } from "../src/spain/spain-hybrid-session.js";

puppeteer.use(StealthPlugin());

const PORTAL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const KEY    = "2d01502f12dc08400e22aea87fb00ae34";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

function buildUrl(endpoint: string): string {
  const cb = `jq_${Date.now()}`;
  return `https://www.citaconsular.es/onlinebookings/${endpoint}?callback=${cb}&type=default&publickey=${KEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL)}&srvsrc=https%3A%2F%2Fwww.citaconsular.es&_=${Date.now()}`;
}

async function xhrFromPage(page: any, url: string): Promise<{ status: number; body: string; ct: string }> {
  return page.evaluate((url: string) => {
    return new Promise<{ status: number; body: string; ct: string }>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Accept", "text/javascript, application/javascript, application/ecmascript, */*; q=0.01");
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      xhr.withCredentials = true;
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText, ct: xhr.getResponseHeader("content-type") ?? "" });
      xhr.onerror = () => resolve({ status: 0, body: "XHR error", ct: "" });
      xhr.send();
    });
  }, url);
}

async function fetchFromPage(page: any, url: string): Promise<{ status: number; body: string; ct: string }> {
  return page.evaluate(async (url: string) => {
    try {
      const r = await fetch(url, {
        credentials: "include",
        headers: {
          "Accept": "text/javascript, application/javascript, application/ecmascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "priority": "u=1, i",
        },
      });
      const body = await r.text();
      return { status: r.status, body, ct: r.headers.get("content-type") ?? "" };
    } catch (e: any) {
      return { status: 0, body: `fetch error: ${e.message}`, ct: "" };
    }
  }, url);
}

function tag(label: string, res: { status: number; body: string; ct: string }): string {
  const mark = res.body.length > 100 ? "✅" : "❌";
  return `${mark} ${res.status} | ${res.body.length}B | ${res.ct.slice(0, 30)} | preview: ${res.body.slice(0, 80)}`;
}

async function main() {
  const proxyUrl = resolveSpainProxy();
  const proxyParsed = new URL(proxyUrl);
  const proxyServer = `http://${proxyParsed.hostname}:${proxyParsed.port}`;
  const proxyAuth = { username: decodeURIComponent(proxyParsed.username), password: decodeURIComponent(proxyParsed.password) };

  console.log("\n══ DIAG XHR vs FETCH ══════════════════════════════════════════════════════\n");

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

  // Track /main/ + calls faits par le widget JS (pour comparer)
  let mainCaptured = false;
  let mainResolve: (() => void) | null = null;
  const mainSignal = new Promise<void>(r => { mainResolve = r; });

  // Marquer quand le widget JS fait ses propres appels
  const widgetCalls: Array<{ url: string; t: number }> = [];
  page.on("request", (req: any) => {
    const url: string = req.url();
    if (url.includes("/onlinebookings/") && !url.includes("/main/")) {
      widgetCalls.push({ url: url.replace("https://www.citaconsular.es/onlinebookings/", "").split("?")[0], t: Date.now() });
    }
  });

  page.on("response", async (res: any) => {
    try {
      const url: string = res.url();
      if (url.includes("/onlinebookings/main/") && res.status() === 200) {
        const text = await res.text().catch(() => "");
        if (text.length > 10_000) {
          mainCaptured = true;
          mainResolve?.();
          console.log(`[t=0] ✅ /main/ intercepté (${text.length}B) — widget JS calls à venir…`);
        }
      }
    } catch { /* */ }
  });

  // Phase 1 : CF solve
  console.log("[Phase 1] Navigation + CF solve…");
  await page.goto(`${PORTAL}?_cb=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 70_000 }).catch(() => {});
  await solveCfChallenge(page, { targetUrl: PORTAL, timeout: 120_000, enableCapsolverFallback: false });
  console.log("  ✅ CF résolu");

  // Clic Continuar
  await new Promise(r => setTimeout(r, 2_500));
  await page.evaluate(() => {
    const tokenInput = document.querySelector('input[name="token"]') as HTMLInputElement | null;
    if (tokenInput?.form) { (tokenInput.form as HTMLFormElement).submit(); return; }
    (document.querySelector("form") as HTMLFormElement | null)?.submit();
  });

  console.log("[Phase 1] Continuar cliqué — attente /main/…");
  const t0 = Date.now();
  await Promise.race([mainSignal, new Promise(r => setTimeout(r, 35_000))]);
  const tMain = Date.now() - t0;
  console.log(`[t=${tMain}ms] /main/ capturé: ${mainCaptured}`);
  console.log(`           Widget JS a fait ${widgetCalls.length} appels: ${widgetCalls.map(c => c.url).join(", ")}`);

  // ── Tests au fil du temps ──────────────────────────────────────────────────
  console.log("\n[Phase 2] Tests XHR vs fetch à différents timings…\n");

  // T+0 : Immédiatement après /main/
  console.log("── T+0 (immédiat) ──────────────────────────────────────────────────────");
  const urlSvc0 = buildUrl("getservices/");
  const urlCfg0 = buildUrl("getwidgetconfigurations/");
  const [svcXhr0, svcFetch0, cfgXhr0] = await Promise.all([
    xhrFromPage(page, urlSvc0),
    fetchFromPage(page, urlSvc0),
    xhrFromPage(page, urlCfg0),
  ]);
  console.log(`  getservices/  XHR  : ${tag("", svcXhr0)}`);
  console.log(`  getservices/  fetch: ${tag("", svcFetch0)}`);
  console.log(`  getwidget/    XHR  : ${tag("", cfgXhr0)}`);

  // /main/ scan direct
  const urlMain0 = buildUrl("main/");
  const mainXhr0 = await xhrFromPage(page, urlMain0);
  const mainFetch0 = await fetchFromPage(page, urlMain0);
  console.log(`  /main/        XHR  : ${tag("", mainXhr0)}`);
  console.log(`  /main/        fetch: ${tag("", mainFetch0)}`);
  if (mainXhr0.body.length > 0 && mainXhr0.body.length < 300) {
    console.log(`  /main/ XHR full body: >>>${mainXhr0.body}<<<`);
  }
  if (mainFetch0.body.length > 0 && mainFetch0.body.length < 300) {
    console.log(`  /main/ fetch full body: >>>${mainFetch0.body}<<<`);
  }

  // T+5s
  console.log("\n── T+5s ────────────────────────────────────────────────────────────────");
  await new Promise(r => setTimeout(r, 5_000));
  const urlSvc5 = buildUrl("getservices/");
  const svcXhr5 = await xhrFromPage(page, urlSvc5);
  const svcFetch5 = await fetchFromPage(page, urlSvc5);
  console.log(`  getservices/  XHR  : ${tag("", svcXhr5)}`);
  console.log(`  getservices/  fetch: ${tag("", svcFetch5)}`);

  // T+15s
  console.log("\n── T+15s ───────────────────────────────────────────────────────────────");
  await new Promise(r => setTimeout(r, 10_000));
  const urlSvc15 = buildUrl("getservices/");
  const svcXhr15 = await xhrFromPage(page, urlSvc15);
  const svcFetch15 = await fetchFromPage(page, urlSvc15);
  console.log(`  getservices/  XHR  : ${tag("", svcXhr15)}`);
  console.log(`  getservices/  fetch: ${tag("", svcFetch15)}`);

  // Page state
  console.log(`\n[État final] URL: ${page.url()}`);
  const cookies = await page.cookies().catch(() => []) as any[];
  console.log(`[État final] Cookies: ${cookies.map((c: any) => c.name).join(", ")}`);

  await browser.close().catch(() => {});
  console.log("\n══ FIN ══════════════════════════════════════════════════════════════════\n");
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
