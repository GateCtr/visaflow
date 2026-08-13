/**
 * test-puppeteer-then-impit.ts
 * 
 * 1. Puppeteer headless résout CF + JSD (js_detection.passed=true)
 * 2. Extrait cf_clearance + PHPSESSID + token
 * 3. Impit fait POST token + GET /main/ avec le bon cf_clearance
 */
import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Impit } from "impit";

puppeteer.use(StealthPlugin());

const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

async function main(): Promise<void> {
  const proxy = process.env.SPAIN_ISP_PROXY_URL;
  if (!proxy) { console.error("SPAIN_ISP_PROXY_URL required"); process.exit(1); }

  console.log("═".repeat(60));
  console.log("  Puppeteer (CF+JSD) → Impit (/main/)");
  console.log("═".repeat(60));

  console.log(`\n[1] CapSolver → cf_clearance (Managed Challenge)...`);
  const { solveSpainCloudflare } = await import("../spain-soax-solver.js");
  const capKey = process.env.CAPSOLVER_API_KEY!;
  const solve = await solveSpainCloudflare(PORTAL_URL, capKey, proxy);
  if (!solve.success || !solve.session) { console.error("CapSolver FAILED:", solve.error); process.exit(1); }
  const capClearance = solve.session.cfClearance;
  const capUA = solve.session.userAgent;
  console.log(`  cf_clearance: ${capClearance.slice(0, 25)}…`);

  // Parse proxy for Puppeteer
  const proxyUrl = new URL(proxy.startsWith("http") ? proxy : `http://${proxy}`);
  const proxyArg = `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`;
  const proxyUser = decodeURIComponent(proxyUrl.username);
  const proxyPass = decodeURIComponent(proxyUrl.password);

  console.log(`\n[2] Puppeteer headless — inject cf_clearance + let JSD execute...`);
  const browser = await (puppeteer as any).launch({
    headless: "new",
    args: [
      `--proxy-server=${proxyArg}`,
      "--disable-blink-features=AutomationControlled",
      "--lang=es-ES",
      "--no-sandbox",
    ],
  });

  const page = await browser.newPage();
  await page.authenticate({ username: proxyUser, password: proxyPass });
  await page.setUserAgent(capUA);

  // Inject cf_clearance cookie BEFORE navigation
  await page.setCookie({
    name: "cf_clearance",
    value: capClearance,
    domain: ".citaconsular.es",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "None",
  });

  console.log("  Navigating with injected cf_clearance...");
  await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45000 });

  // Wait for JSD to execute (it fires within a few seconds after page load)
  console.log("[3] Waiting 5s for JSD to execute...");
  await new Promise(r => setTimeout(r, 5000));

  // Extract cookies
  const cookies = await page.cookies();
  const cfClearance = cookies.find((c: any) => c.name === "cf_clearance")?.value ?? "";
  const phpSessId = cookies.find((c: any) => c.name === "PHPSESSID")?.value ?? "";
  const ua = await page.evaluate(() => navigator.userAgent);

  console.log(`  cf_clearance: ${cfClearance.slice(0, 30)}…`);
  console.log(`  PHPSESSID: ${phpSessId.slice(0, 12)}…`);
  console.log(`  UA: ${ua.slice(0, 60)}`);

  if (!cfClearance) {
    console.error("  ❌ No cf_clearance! CF challenge not resolved.");
    await browser.close();
    process.exit(1);
  }

  // Extract token from the page
  const token = await page.evaluate(() => {
    const input = document.querySelector('input[name="token"]') as HTMLInputElement;
    return input?.value ?? "";
  });
  console.log(`  Token: ${token ? token.slice(0, 20) + "…" : "NOT FOUND"}`);

  // Check if we're already past the token page (widget loaded)
  const hasWidget = await page.evaluate(() => {
    return document.body.innerHTML.includes("bkt_init_widget") || document.body.innerHTML.includes("loadermaec");
  });
  console.log(`  Widget already loaded: ${hasWidget}`);

  await browser.close();
  console.log("  Browser closed.");

  // Now use Impit with the valid cookies
  console.log(`\n[4] Impit session with real cf_clearance (js_detection.passed=true)...`);
  const impit = new Impit({ browser: "chrome", proxyUrl: proxy } as any);
  const cookieStr = `PHPSESSID=${phpSessId}; cf_clearance=${cfClearance}`;

  if (token && !hasWidget) {
    // POST token (Continuar)
    console.log("[5] POST token (Continuar)...");
    const r2 = await impit.fetch(PORTAL_URL, {
      method: "POST",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieStr,
        "Origin": "https://www.citaconsular.es",
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
      body: `token=${encodeURIComponent(token)}`,
    } as any) as unknown as Response;
    const postBody = await r2.text();
    console.log(`  → ${r2.status} | ${postBody.length}B`);
  }

  // GET /main/
  const ts = Date.now();
  const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=jQ_${ts}&type=default&publickey=2d01502f12dc08400e22aea87fb00ae34&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts + 1}`;
  console.log("\n[6] GET /main/...");
  const r3 = await impit.fetch(mainUrl, {
    method: "GET",
    headers: {
      "User-Agent": ua,
      "Cookie": cookieStr,
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": PORTAL_URL,
    },
  } as any) as unknown as Response;
  const mainBody = await r3.text();
  console.log(`  → ${r3.status} | ${mainBody.length}B`);

  if (mainBody.length > 1000) {
    console.log(`\n  🎉🎉🎉 /main/ → ${mainBody.length}B via Puppeteer cf_clearance + Impit!`);
    console.log(`  Aceptar: ${/aceptar/i.test(mainBody) ? "YES ✅" : "NO"}`);
  } else if (mainBody.length === 0) {
    console.log("  ❌ 0B — cf_clearance from Puppeteer not accepted by Impit");
    console.log("  (TLS fingerprint binding still applies)");
  } else {
    console.log(`  Body: ${mainBody.slice(0, 200)}`);
  }

  console.log("\n" + "═".repeat(60));
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
