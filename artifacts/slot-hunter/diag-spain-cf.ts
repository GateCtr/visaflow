/**
 * diag-spain-cf.ts — diagnostique ce que Chromium voit sur citaconsular.es
 * Affiche : URL finale, titre, status CF, corps (400 chars), cookies.
 */
import * as dotenv from "dotenv";
dotenv.config();

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { parseProxyForPuppeteer } from "./src/browser.js";

puppeteer.use(StealthPlugin());

const TARGET = process.env.SPAIN_PORTAL_URL
  ?? "https://www.citaconsular.es/es/hosteds/widgetdef498.html";
const PROXY_URL = process.env.DECODO_PROXY_URL ?? process.env.SOAX_PROXY_URL;

function platformFromUA(ua: string): string {
  if (/Macintosh/i.test(ua)) return "MacIntel";
  if (/Windows NT/i.test(ua)) return "Win32";
  return "Linux x86_64";
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";
const PLATFORM = platformFromUA(UA);

async function run() {
  const proxyParsed = PROXY_URL ? parseProxyForPuppeteer(PROXY_URL) : null;

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-webgl",
    "--window-size=1280,800",
    ...(proxyParsed ? [`--proxy-server=${proxyParsed.server}`] : []),
  ];

  console.log(`[diag] UA       : ${UA.slice(0, 90)}`);
  console.log(`[diag] platform : ${PLATFORM}`);
  console.log(`[diag] proxy    : ${PROXY_URL ? PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 80) : "direct"}`);
  console.log(`[diag] target   : ${TARGET}`);

  const browser = await (puppeteer as any).launch({ headless: true, args });
  const page = await browser.newPage();

  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7" });
  if (proxyParsed?.username) {
    const client = await (page as any).createCDPSession();
    await client.send("Fetch.enable", { handleAuthRequests: true });
    client.on("Fetch.authRequired", async (event: any) => {
      const { requestId, authChallenge } = event;
      if (authChallenge?.source === "Proxy") {
        await client.send("Fetch.continueWithAuth", { requestId, authChallengeResponse: { response: "ProvideCredentials", username: proxyParsed.username!, password: proxyParsed.password ?? "" } }).catch(() => {});
      } else {
        await client.send("Fetch.continueWithAuth", { requestId, authChallengeResponse: { response: "Default" } }).catch(() => {});
      }
    });
    client.on("Fetch.requestPaused", async (event: any) => {
      await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
    });
  }

  await (page as any).evaluateOnNewDocument((ua: string, platform: string) => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "platform", { get: () => platform });
    Object.defineProperty(navigator, "userAgent", { get: () => ua });
  }, UA, PLATFORM);

  // Capture console + network errors from the page
  page.on("console", msg => console.log(`[page-console] ${msg.type()}: ${msg.text().slice(0, 200)}`));
  page.on("pageerror", err => console.log(`[page-error] ${err.message.slice(0, 200)}`));
  page.on("requestfailed", req => console.log(`[req-failed] ${req.url().slice(0, 120)} — ${req.failure()?.errorText}`));

  console.log("\n[diag] Navigation en cours…");
  const t0 = Date.now();

  try {
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    console.warn(`[diag] goto() erreur (${Math.round((Date.now()-t0)/1000)}s): ${err}`);
  }

  await new Promise(r => setTimeout(r, 5000)); // laisser le JS tourner 5s

  const finalUrl = page.url();
  const title = await page.title().catch(() => "?");
  const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? "").catch(() => "?");
  const htmlSnippet = await page.evaluate(() => document.documentElement?.outerHTML?.slice(0, 600) ?? "").catch(() => "?");
  const cookies = await page.cookies("https://www.citaconsular.es");

  console.log(`\n[diag] ─── Résultat après ${Math.round((Date.now()-t0)/1000)}s ───`);
  console.log(`[diag] URL finale : ${finalUrl}`);
  console.log(`[diag] Titre      : ${title}`);
  console.log(`[diag] Cookies    : ${cookies.map(c => c.name).join(", ") || "(aucun)"}`);
  console.log(`[diag] cf_clearance : ${cookies.find(c => c.name === "cf_clearance")?.value?.slice(0, 40) ?? "ABSENT"}`);
  console.log(`[diag] body (text): ${bodySnippet.replace(/\s+/g, " ").slice(0, 400)}`);
  console.log(`[diag] html (raw) : ${htmlSnippet.replace(/\s+/g, " ").slice(0, 400)}`);

  // Poll 10s de plus pour voir si CF se résout
  console.log("\n[diag] Poll cf_clearance 10s…");
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const c2 = await page.cookies("https://www.citaconsular.es");
    const cf = c2.find(c => c.name === "cf_clearance");
    const url2 = page.url();
    console.log(`[diag] t+${5+i*2}s — url=${url2.slice(0, 80)} — cf_clearance=${cf?.value?.slice(0,30) ?? "absent"}`);
    if (cf) { console.log("[diag] ✅ cf_clearance obtenu !"); break; }
  }

  await browser.close();
}

run().catch(err => { console.error("[diag] FATAL:", err); process.exit(1); });
