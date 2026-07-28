/**
 * Test verbose du persistent-browser : screenshot + DOM analysis après CapSolver
 */
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { solveSpainCloudflare } from "./src/spain-soax-solver.js";
import * as fs from "fs";

puppeteer.use(StealthPlugin());

const EXECUTABLE =
  "/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";
const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const PROXY_URL = process.env.DECODO_PROXY_URL ?? "";
const CAP_KEY   = process.env.CAPSOLVER_API_KEY ?? "";

function parseProxy(url: string) {
  if (!url) return { server: "", username: "", password: "" };
  const u = new URL(url);
  return {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: u.username,
    password: u.password,
  };
}

const proxyParsed = parseProxy(PROXY_URL);
const args = [
  "--no-sandbox", "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--window-size=1280,800",
  ...(proxyParsed.server ? [`--proxy-server=${proxyParsed.server}`] : []),
];

console.log("[verbose] Lancement Chromium…");
const browser = await (puppeteer as any).launch({ headless: true, executablePath: EXECUTABLE, args });
const page = await browser.newPage();

// Suppression alert AVANT toute navigation
await (page as any).evaluateOnNewDocument(() => {
  (window as any).alert   = () => {};
  (window as any).confirm = () => true;
  (window as any).prompt  = () => "";
});
page.on("dialog", async (d: any) => {
  console.log(`[verbose] Dialog (${d.type()}): "${d.message().slice(0, 80)}" → accept`);
  await d.accept().catch(() => {});
});

await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36");
await page.setViewport({ width: 1280, height: 800 });
await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7" });

if (proxyParsed.username) {
  const client = await (page as any).createCDPSession();
  await client.send("Fetch.enable", { handleAuthRequests: true });
  client.on("Fetch.authRequired", async (event: any) => {
    const { requestId, authChallenge } = event;
    if (authChallenge?.source === "Proxy") {
      await client.send("Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: { response: "ProvideCredentials", username: proxyParsed.username, password: proxyParsed.password },
      }).catch(() => {});
    } else {
      await client.send("Fetch.continueWithAuth", { requestId, authChallengeResponse: { response: "Default" } }).catch(() => {});
    }
  });
  client.on("Fetch.requestPaused", async (event: any) => {
    await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
  });
}

// ── Étape 1 : obtenir cf_clearance via CapSolver ──────────────────────────
console.log("[verbose] Solve CapSolver…");
const capResult = await solveSpainCloudflare(PORTAL_URL, CAP_KEY, PROXY_URL);
if (!capResult.success || !capResult.session) {
  console.error("[verbose] CapSolver échoué:", capResult.error);
  await browser.close();
  process.exit(1);
}
console.log("[verbose] CapSolver OK — cf_clearance:", capResult.session.cfClearance.slice(0, 50));

// Injecter le cookie CF
const cdp = await page.createCDPSession();
await cdp.send("Network.setCookie", {
  name: "cf_clearance",
  value: capResult.session.cfClearance,
  domain: ".citaconsular.es",
  path: "/",
  secure: true,
  sameSite: "None",
});
await cdp.detach();

// ── Étape 2 : naviguer vers le portail ───────────────────────────────────
console.log("[verbose] goto portail…");
try {
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
} catch (e) {
  console.warn("[verbose] goto warn:", e);
}

// Screenshot état initial
await page.screenshot({ path: "/tmp/pb_step1_initial.png", fullPage: false });
console.log("[verbose] Screenshot 1 → /tmp/pb_step1_initial.png");

// Logger l'état de la page
const step1Info = await page.evaluate(() => ({
  hash: window.location.hash,
  title: document.title,
  bodySnippet: document.body?.innerText?.slice(0, 300) ?? "",
  hasContinueBtn: !!document.getElementById("idDivBktCustomContinueButton"),
  hasWidgetBody: !!document.getElementById("idBktWidgetDefaultBodyContainer"),
  hasCustomContainer: !!document.getElementById("idBktDefaultCustomContainer"),
})).catch(() => ({ error: "evaluate failed" }));
console.log("[verbose] Étape 1 état:", JSON.stringify(step1Info, null, 2));

// ── Étape 3 : attendre le widget (max 20s) ───────────────────────────────
console.log("[verbose] Attente widget Bookitit…");
let continueFound = false;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2_000));
  const s = await page.evaluate(() => ({
    hash: window.location.hash,
    hasContinueBtn: !!document.getElementById("idDivBktCustomContinueButton"),
    continueBtnVisible: (() => {
      const b = document.getElementById("idDivBktCustomContinueButton");
      return b ? b.offsetParent !== null : false;
    })(),
    hasWidgetBody: !!document.getElementById("idBktWidgetDefaultBodyContainer"),
    hasCustomContainer: !!document.getElementById("idBktDefaultCustomContainer"),
    bodyText: document.body?.innerText?.slice(0, 200) ?? "",
  })).catch(() => null);

  console.log(`[verbose] t+${(i + 1) * 2}s:`, JSON.stringify(s));

  if (s?.continueBtnVisible) {
    continueFound = true;
    console.log("[verbose] ✅ Bouton Continuar visible !");
    break;
  }
  if (s?.hash && s.hash !== "" && s.hash !== "#custom") {
    console.log("[verbose] ✅ Hash non-vide:", s.hash);
    break;
  }
}

await page.screenshot({ path: "/tmp/pb_step3_after_wait.png", fullPage: false });
console.log("[verbose] Screenshot 2 → /tmp/pb_step3_after_wait.png");

if (continueFound) {
  // Cliquer Continuar
  await page.evaluate(() => {
    const btn = document.getElementById("idDivBktCustomContinueButton");
    if (btn) (btn as HTMLElement).click();
  });
  console.log("[verbose] Clic Continuar envoyé — attente 8s…");
  await new Promise((r) => setTimeout(r, 8_000));
  await page.screenshot({ path: "/tmp/pb_step4_after_click.png", fullPage: false });
  console.log("[verbose] Screenshot 3 → /tmp/pb_step4_after_click.png");
  const finalInfo = await page.evaluate(() => ({
    hash: window.location.hash,
    bodyText: document.body?.innerText?.slice(0, 500) ?? "",
  })).catch(() => null);
  console.log("[verbose] Après clic:", JSON.stringify(finalInfo));
}

const finalCookies = await page.cookies("https://www.citaconsular.es");
console.log("[verbose] Cookies finaux:", finalCookies.map((c: any) => `${c.name}=${c.value.slice(0, 20)}`).join(" | "));

await browser.close();
console.log("[verbose] Test terminé.");
