/**
 * debug-cf-challenge.ts — Inspecte le DOM de la page CF challenge
 * Usage: node_modules/.bin/tsx debug-cf-challenge.ts
 */
import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const TARGET = process.env.TEST_URL ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const PROXY  = process.env.DECODO_PROXY_URL ?? "";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36";

const parsed = PROXY ? new URL(PROXY) : null;
const proxyServer = parsed ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}` : undefined;

console.log("=".repeat(60));
console.log("DEBUG CF Challenge — inspection DOM");
console.log(`Proxy: ${proxyServer ?? "(aucun)"}`);
console.log(`UA  : ${UA}`);
console.log("=".repeat(60));

const browser = await (puppeteer as any).launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
    ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
    `--user-agent=${UA}`,
  ],
});

const page = await browser.newPage();

// Auth proxy
if (parsed?.username) {
  const client = await (page as any).createCDPSession();
  await client.send("Fetch.enable", { handleAuthRequests: true });
  client.on("Fetch.authRequired", async (ev: any) => {
    if (ev.authChallenge?.source === "Proxy") {
      await client.send("Fetch.continueWithAuth", {
        requestId: ev.requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        },
      }).catch(() => {});
    } else {
      await client.send("Fetch.continueWithAuth", {
        requestId: ev.requestId,
        authChallengeResponse: { response: "Default" },
      }).catch(() => {});
    }
  });
  client.on("Fetch.requestPaused", async (ev: any) => {
    await client.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
  });
}

await page.setUserAgent(UA);
await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7" });

// Naviguer
console.log(`\n[debug] Navigation vers ${TARGET}…`);
try {
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 35_000 });
} catch (e) {
  console.warn(`[debug] Navigation error (non-fatal): ${e}`);
}

// Attendre un peu pour que le JS CF s'exécute
await new Promise(r => setTimeout(r, 5_000));

// Inspecter le DOM
const info = await page.evaluate(() => {
  const body = document.body?.innerHTML ?? "";
  const title = document.title;
  const url = window.location.href;

  // Chercher tous les attributs data-sitekey
  const sitekeyEls = Array.from(document.querySelectorAll("[data-sitekey]")).map(el => ({
    tag: el.tagName,
    sitekey: el.getAttribute("data-sitekey"),
    class: el.className,
    id: el.id,
  }));

  // Chercher input[name=cf-turnstile-response]
  const cfInputs = Array.from(document.querySelectorAll('[name="cf-turnstile-response"]')).map(el => ({
    tag: el.tagName,
    type: (el as HTMLInputElement).type,
    value: (el as HTMLInputElement).value?.slice(0, 30),
  }));

  // Chercher les scripts CF
  const cfScripts = Array.from(document.querySelectorAll("script[src]"))
    .map(s => (s as HTMLScriptElement).src)
    .filter(s => s.includes("cloudflare") || s.includes("challenges") || s.includes("turnstile") || s.includes("jsd"));

  // Challenge form
  const challengeForm = document.getElementById("challenge-form");
  const challengeFormHtml = challengeForm?.outerHTML?.slice(0, 500) ?? null;

  // Snippet body
  const bodySnippet = body.slice(0, 2000);

  // window.turnstile existence
  const hasTurnstile = typeof (window as any).turnstile !== "undefined";

  // CF-specific elements
  const cfElements = [
    "#cf-please-wait", ".cf-challenge-running", ".cf-im-under-attack",
    "#challenge-stage", "#challenge-body", ".challenge-running",
    "[data-cf-settings]", "#trk_jschal_js", "#cf-hcaptcha-container",
  ].map(sel => ({ sel, found: !!document.querySelector(sel) })).filter(x => x.found);

  return {
    title,
    url,
    sitekeyEls,
    cfInputs,
    cfScripts,
    challengeForm: challengeFormHtml,
    bodySnippet,
    hasTurnstile,
    cfElements,
    bodyLength: body.length,
  };
});

console.log("\n── DOM Inspection ─────────────────────────────────────────");
console.log(`Title          : ${info.title}`);
console.log(`URL            : ${info.url}`);
console.log(`Body length    : ${info.bodyLength}B`);
console.log(`window.turnstile: ${info.hasTurnstile}`);
console.log(`CF Elements    : ${JSON.stringify(info.cfElements)}`);
console.log(`[data-sitekey] : ${JSON.stringify(info.sitekeyEls)}`);
console.log(`CF inputs      : ${JSON.stringify(info.cfInputs)}`);
console.log(`CF scripts     : ${JSON.stringify(info.cfScripts)}`);
console.log(`Challenge form : ${info.challengeForm ?? "(absent)"}`);
console.log("\n── Body snippet (2000 chars) ───────────────────────────────");
console.log(info.bodySnippet.replace(/\s+/g, " ").slice(0, 1500));

// Screenshot
try {
  await page.screenshot({ path: "/tmp/cf-debug.png", fullPage: false });
  console.log("\n📸 Screenshot sauvegardé: /tmp/cf-debug.png");
} catch { /* non-fatal */ }

await browser.close();
console.log("\n=".repeat(60));
