/**
 * Test : naviguer directement vers /main/ depuis Chromium avec cf_clearance CapSolver
 * (sans passer par le portail portail qui a Turnstile interactif)
 */
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { solveSpainCloudflare } from "./src/spain-soax-solver.js";
import { parseProxyForPuppeteer } from "./src/browser.js";

puppeteer.use(StealthPlugin());

process.env.PUPPETEER_EXECUTABLE_PATH =
  "/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const PROXY_URL = process.env.DECODO_PROXY_URL ?? "";
const CAP_KEY   = process.env.CAPSOLVER_API_KEY ?? "";

// ── Solve CapSolver ──────────────────────────────────────────────────────────
console.log("[test] CapSolver solve…");
const capResult = await solveSpainCloudflare(PORTAL_URL, CAP_KEY, PROXY_URL);
if (!capResult.success || !capResult.session) {
  console.error("[test] CapSolver échoué:", capResult.error);
  process.exit(1);
}
const { cfClearance, userAgent } = capResult.session;
console.log("[test] cf_clearance:", cfClearance.slice(0, 50));
console.log("[test] UA:", userAgent.slice(0, 80));

// ── Lancer Chromium ──────────────────────────────────────────────────────────
const proxyParsed = parseProxyForPuppeteer(PROXY_URL);
const args = [
  "--no-sandbox", "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
  "--window-size=1280,800",
  ...(proxyParsed ? [`--proxy-server=${proxyParsed.server}`] : []),
];
const browser = await (puppeteer as any).launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args,
});
const page = await browser.newPage();
await page.setUserAgent(userAgent);
await page.setViewport({ width: 1280, height: 800 });
await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7" });

// Auth proxy
if (proxyParsed?.username) {
  const client = await (page as any).createCDPSession();
  await client.send("Fetch.enable", { handleAuthRequests: true });
  client.on("Fetch.authRequired", async (event: any) => {
    const { requestId, authChallenge } = event;
    if (authChallenge?.source === "Proxy") {
      await client.send("Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: { response: "ProvideCredentials", username: proxyParsed.username!, password: proxyParsed.password ?? "" },
      }).catch(() => {});
    } else {
      await client.send("Fetch.continueWithAuth", { requestId, authChallengeResponse: { response: "Default" } }).catch(() => {});
    }
  });
  client.on("Fetch.requestPaused", async (event: any) => {
    await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
  });
}

// Alert dismiss
await (page as any).evaluateOnNewDocument(() => {
  (window as any).alert = () => {};
  (window as any).confirm = () => true;
});
page.on("dialog", async (d: any) => { await d.accept().catch(() => {}); });

// Injecter cf_clearance CapSolver
const cdp = await page.createCDPSession();
await cdp.send("Network.setCookie", {
  name: "cf_clearance",
  value: cfClearance,
  domain: ".citaconsular.es",
  path: "/",
  secure: true,
  sameSite: "None",
});
await cdp.detach();

// ── Test A : naviguer directement vers /main/ JSONP ──────────────────────────
const publickey = "25028fcd7126544630b8da0c6e60722b5";
const cb = `jQueryTest${Date.now()}`;
const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=${cb}&type=default&publickey=${publickey}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${Date.now()}`;

console.log("\n[test-A] goto /main/ directement…");
try {
  await page.goto(mainUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
} catch(e) { console.warn("[test-A] goto warn:", e); }

const pageA = await page.evaluate(() => ({
  title: document.title.slice(0, 60),
  bodyLength: document.body?.innerText?.length ?? 0,
  bodySnippet: (document.body?.innerText ?? "").slice(0, 200),
})).catch(() => ({ error: "evaluate failed" }));
console.log("[test-A] Résultat:", JSON.stringify(pageA, null, 2));

// ── Test B : naviguer vers le portail (pour voir si Turnstile toujours là) ───
console.log("\n[test-B] goto portail…");
try {
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
} catch(e) { console.warn("[test-B] goto warn:", e); }
await new Promise(r => setTimeout(r, 3000));
const pageB = await page.evaluate(() => ({
  title: document.title.slice(0, 60),
  hash: window.location.hash,
  hasContinue: !!document.getElementById("idDivBktCustomContinueButton"),
  bodySnippet: (document.body?.innerText ?? "").slice(0, 200),
})).catch(() => ({ error: "evaluate failed" }));
console.log("[test-B] Résultat:", JSON.stringify(pageB, null, 2));

await browser.close();
