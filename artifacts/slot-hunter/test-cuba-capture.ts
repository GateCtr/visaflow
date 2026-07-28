/**
 * test-cuba-capture.ts — Capture complète du flow Cuba bout-en-bout
 *
 * Stratégie :
 *   - Réutilise le profil Chromium persistant (/tmp/spain-cf-profile) qui a
 *     déjà prouvé son efficacité pour résoudre CF sur ce domaine.
 *   - CDP intercepte TOUTES les requêtes citaconsular.es pendant la session.
 *   - CapSolver est utilisé si le profil ne suffit pas à passer CF.
 *   - Navigue le portail + /main/ dans le browser pour capturer les vraies
 *     réponses API (getagendas/, datetime/, etc.).
 *   - Sauvegarde tout dans /tmp/cuba-capture/ + affiche un résumé actionnable.
 *
 * Usage:
 *   cd artifacts/slot-hunter && tsx test-cuba-capture.ts
 */

import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { parseProxyForPuppeteer } from "./src/browser.js";
import { solveSpainCloudflare } from "./src/spain-soax-solver.js";

puppeteer.use(StealthPlugin());

const CUBA_URL   = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const PUBLICKEY  = "28330379fc95acafd31ee9e8938c278ff";
const BASE       = "https://www.citaconsular.es/onlinebookings/";
const REFERER    = CUBA_URL.replace(/\/?$/, "/");
const OUT_DIR    = "/tmp/cuba-capture";
const PROFILE    = "/tmp/spain-cf-profile"; // même profil que spain-persistent-browser.ts
const UA         = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";
const CF_SOLVE_MS = 90_000;

// ─── Proxy auth CDP ───────────────────────────────────────────────────────────
async function setupProxyAuth(page: Page, creds: { username: string; password: string }) {
  const client = await (page as any).createCDPSession();
  await client.send("Fetch.enable", { handleAuthRequests: true });
  client.on("Fetch.authRequired", async (ev: any) => {
    await client.send("Fetch.continueWithAuth", {
      requestId: ev.requestId,
      authChallengeResponse: ev.authChallenge?.source === "Proxy"
        ? { response: "ProvideCredentials", ...creds }
        : { response: "Default" },
    }).catch(() => {});
  });
  client.on("Fetch.requestPaused", async (ev: any) => {
    await client.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
  });
}

// ─── JSONP parse ──────────────────────────────────────────────────────────────
function parseJsonp(raw: string): unknown {
  const m = raw.match(/^[^(]+\(([\s\S]*)\);?\s*$/);
  if (m) { try { return JSON.parse(m[1]); } catch { /* fall through */ } }
  try { return JSON.parse(raw); } catch { return null; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();

  console.log(`\n${"═".repeat(66)}`);
  console.log("  Cuba Portal — Capture réseau bout-en-bout");
  console.log(`${"═".repeat(66)}`);
  console.log(`  Portal  : ${CUBA_URL}`);
  console.log(`  Profile : ${PROFILE}`);
  console.log(`  OutDir  : ${OUT_DIR}\n`);

  const proxyUrl = process.env.DECODO_PROXY_URL ?? process.env.SOAX_PROXY_URL;
  const parsed   = proxyUrl ? parseProxyForPuppeteer(proxyUrl) : null;
  console.log(`  Proxy   : ${proxyUrl ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 70) : "direct (aucun)"}\n`);

  // ── Lancement Chromium (profil persistant) ─────────────────────────────────
  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
    "--window-size=1280,800",
  ];
  if (parsed) launchArgs.push(`--proxy-server=${parsed.server}`);

  const browser: Browser = await (puppeteer as any).launch({
    headless: true,
    userDataDir: PROFILE,
    args: launchArgs,
  }) as Browser;

  const pages = await browser.pages();
  const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7" });

  if (parsed?.username) {
    await setupProxyAuth(page, { username: parsed.username, password: parsed.password ?? "" });
  }

  await (page as any).evaluateOnNewDocument((platform: string) => {
    Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
    Object.defineProperty(navigator, "platform",   { get: () => platform });
    Object.defineProperty(navigator, "languages",  { get: () => ["fr-FR","fr","en-US","en"] });
    const noop = () => {};
    (window as any).chrome = {
      app: { isInstalled: false },
      runtime: { connect: noop, sendMessage: noop, id: undefined },
      loadTimes: () => ({ wasNpnNegotiated: true, npnNegotiatedProtocol: "h2", connectionInfo: "h2" }),
      csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 500, tran: 15 }),
    };
  }, "Win32");

  // ── CDP: capture all citaconsular requests ─────────────────────────────────
  const cdp = await (page as any).createCDPSession();
  await cdp.send("Network.enable", {
    maxResourceBufferSize: 20 * 1024 * 1024,
    maxTotalBufferSize:    40 * 1024 * 1024,
  });

  interface Entry {
    seq: number; requestId: string; method: string; url: string;
    postData?: string; responseStatus?: number; mimeType?: string;
    responseBody?: string; base64?: boolean; ts: number;
    responseHeaders?: Record<string, string>;
  }
  const log: Entry[] = [];

  cdp.on("Network.requestWillBeSent", (ev: any) => {
    const u: string = ev.request?.url ?? "";
    if (!/citaconsular\.es|cloudflare\.com/i.test(u)) return;
    log.push({ seq: log.length + 1, requestId: ev.requestId, method: ev.request.method, url: u, postData: ev.request.postData, ts: Date.now() });
  });

  cdp.on("Network.responseReceived", async (ev: any) => {
    const u: string = ev.response?.url ?? "";
    if (!/citaconsular\.es|cloudflare\.com/i.test(u)) return;
    const entry = log.find(e => e.requestId === ev.requestId);
    if (entry) {
      entry.responseStatus = ev.response.status;
      entry.mimeType = ev.response.mimeType;
      entry.responseHeaders = ev.response.headers;
    }
    // Capture bodies for key endpoints
    if (/onlinebookings\/(main|getservices|getagendas|datetime|getwidgetconfig)/i.test(u)
      || /\/cdn-cgi\/(rum|challenge-platform)/i.test(u)
      || /widgetdefault/i.test(u)) {
      try {
        const r = await cdp.send("Network.getResponseBody", { requestId: ev.requestId });
        if (entry && r?.body) { entry.responseBody = r.body; entry.base64 = r.base64Encoded; }
      } catch { /* freed */ }
    }
  });

  // ─── Étape 1 : Navigation initiale portail ─────────────────────────────────
  // IMPORTANT: Delete any stale/expired cf_clearance from the profile first.
  // The profile may have a clearance from a previous run that is now expired
  // (TTL ~115min). If we find it in the cookie jar, it's useless but confuses
  // the poll below into thinking CF is already solved.
  console.log("─── Étape 1 : Navigation portail (profil persistant) ───");
  try {
    await page.deleteCookie({ name: "cf_clearance", domain: ".citaconsular.es", path: "/" });
    await page.deleteCookie({ name: "cf_clearance", domain: "www.citaconsular.es", path: "/" });
    console.log("   Stale cf_clearance supprimé du profil");
  } catch { /* ok */ }

  try {
    // domcontentloaded: CF challenge page loads DOM quickly → goto() returns
    // fast, then we poll below while the browser executes the Turnstile JS.
    await page.goto(CUBA_URL, { waitUntil: "domcontentloaded", timeout: CF_SOLVE_MS });
  } catch (e) { console.warn(`   goto warn: ${e}`); }

  // Poll 90s pour cf_clearance natif (même durée que spain-persistent-browser.ts)
  // Gives the browser enough time to run the Turnstile challenge JS headlessly.
  let cfClearance = "";
  const d1 = Date.now() + 90_000;
  let lastSeenCf = "";
  while (Date.now() < d1) {
    const cookies = await page.cookies("https://www.citaconsular.es");
    const cf = cookies.find(c => c.name === "cf_clearance");
    if (cf?.value && cf.value !== lastSeenCf) {
      // New value appeared — wait a tick to see if it gets updated again by JSD
      lastSeenCf = cf.value;
      await new Promise(r => setTimeout(r, 3_000));
      const cs2 = await page.cookies("https://www.citaconsular.es");
      cfClearance = cs2.find(c => c.name === "cf_clearance")?.value ?? cf.value;
      console.log(`   cf_clearance natif (${Math.round((Date.now()-t0)/1000)}s): ${cfClearance.slice(0, 40)}…`);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // ─── Étape 2 : CapSolver si nécessaire ────────────────────────────────────
  if (!cfClearance) {
    console.log(`   cf_clearance non obtenu nativement après 90s → CapSolver…`);
    const capKey = process.env.CAPSOLVER_API_KEY;
    if (!capKey) { console.error("❌ CAPSOLVER_API_KEY manquant"); await browser.close(); process.exit(1); }
    const cap = await solveSpainCloudflare(CUBA_URL, capKey, proxyUrl ?? "");
    if (!cap.success || !cap.session) { console.error(`❌ CapSolver échoué: ${cap.error}`); await browser.close(); process.exit(1); }
    cfClearance = cap.session.cfClearance;
    await page.setCookie({ name: "cf_clearance", value: cfClearance, domain: ".citaconsular.es", path: "/", secure: true, sameSite: "None" });
    console.log(`   ✅ CapSolver (${Math.round((Date.now()-t0)/1000)}s): ${cfClearance.slice(0, 40)}…`);

    // Re-navigate avec le cookie injecté — le browser exécute le JSD oneshot nativement
    // (CF sert la vraie page puisque cf_clearance est valide), ce qui peut émettre
    // un nouveau cf_clearance post-JSD lié à l'état du browser réel.
    console.log("   Re-navigation portail avec clearance CapSolver (JSD natif)…");
    try {
      await page.goto(CUBA_URL, { waitUntil: "networkidle0", timeout: 45_000 });
    } catch (e) { console.warn(`   re-nav warn (non-fatal): ${e}`); }

    // Poll 20s pour un cf_clearance post-JSD
    const d2 = Date.now() + 20_000;
    while (Date.now() < d2) {
      const cs = await page.cookies("https://www.citaconsular.es");
      const cf = cs.find(c => c.name === "cf_clearance");
      if (cf?.value && cf.value !== cfClearance) {
        console.log(`   cf_clearance post-JSD: ${cf.value.slice(0, 40)}…`);
        cfClearance = cf.value;
        break;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const cookies1 = await page.cookies("https://www.citaconsular.es");
  console.log(`   Cookies: ${cookies1.map(c => c.name).join(", ")}`);

  // Save portal page HTML
  const portalHtml = await page.content().catch(() => "");
  fs.writeFileSync(`${OUT_DIR}/01-portal-page.html`, portalHtml);
  console.log(`   Portal HTML: ${portalHtml.length} chars (01-portal-page.html)\n`);

  // ─── Étape 3 : Navigate /main/ directly in browser ────────────────────────
  // This is how spain-persistent-browser.ts gets a valid PHPSESSID.
  // The browser navigates /main/ so CF assigns a server-side PHPSESSID that
  // is bound to the browser's cf_clearance and IP.
  console.log("─── Étape 3 : Navigation /main/ dans le browser ───");
  const cbMain = `jQCapture${Date.now()}`;
  const mainQ = new URLSearchParams({ callback: cbMain, type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: REFERER, _: String(Date.now()) });
  const mainUrl = `${BASE}main/?${mainQ}`;
  try {
    await page.goto(mainUrl, { waitUntil: "networkidle0", timeout: 25_000 });
  } catch (e) { console.warn(`   /main/ nav warn: ${e}`); }

  const mainPageContent = await page.content().catch(() => "");
  const mainRawText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const cookies2 = await page.cookies("https://www.citaconsular.es");
  const phpSessId = cookies2.find(c => c.name === "PHPSESSID")?.value ?? "";
  console.log(`   PHPSESSID: ${phpSessId ? phpSessId.slice(0, 15) + "…" : "NON OBTENU"}`);
  console.log(`   /main/ body length: ${mainRawText.length}`);
  fs.writeFileSync(`${OUT_DIR}/02-main-raw.txt`, mainRawText);
  console.log(`   Saved: 02-main-raw.txt (${mainRawText.length} chars)\n`);

  // Parse the /main/ JSONP
  const mainMatch = mainRawText.match(/^[^(]+\("(.*)"\);?$/s);
  let mainHtml = mainRawText;
  if (mainMatch) {
    try { mainHtml = JSON.parse(`"${mainMatch[1]}"`); } catch { /* keep raw */ }
  }
  fs.writeFileSync(`${OUT_DIR}/02-main-decoded.html`, mainHtml);

  // ─── Analyse du HTML /main/ ────────────────────────────────────────────────
  console.log("─── Analyse HTML /main/ ───");
  const renderedHtml = mainHtml.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");

  const noHorasVisible = /<div\s+style='text-align:\s*center;[^']*'[^>]*>\s*No hay horas disponibles/i.test(mainHtml);
  const noHorasHidden  = /<div\s+style='display:\s*none;[^']*'[^>]*>\s*No hay horas disponibles/i.test(mainHtml);
  const hasWidgetBody  = /idBktWidgetDefaultBodyContainer|idDivBktServicesContainer/i.test(mainHtml);

  console.log(`   mainHtml length          : ${mainHtml.length}`);
  console.log(`   renderedHtml length      : ${renderedHtml.length}`);
  console.log(`   hasWidgetBody            : ${hasWidgetBody}`);
  console.log(`   noHorasVisible           : ${noHorasVisible}`);
  console.log(`   noHorasHidden            : ${noHorasHidden}`);

  // Service link patterns
  const svcNumeric  = [...renderedHtml.matchAll(/#selectservice\/(\d+)/gi)];
  const svcAlpha    = [...renderedHtml.matchAll(/#selectservice\/([\w-]+)/gi)];
  const svcHref     = [...renderedHtml.matchAll(/href=['"]#selectservice\/([^'"]+)['"]/gi)];
  const svcIds      = [...new Set(svcHref.map(m => m[1]))];

  console.log(`   #selectservice numeric   : ${svcNumeric.length} (${[...new Set(svcNumeric.map(m=>m[1]))].join(", ") || "none"})`);
  console.log(`   #selectservice alpha     : ${svcAlpha.length} (${[...new Set(svcAlpha.map(m=>m[1]))].join(", ") || "none"})`);
  console.log(`   #selectservice (all IDs) : ${svcIds.join(", ") || "none"}`);

  // Container checks
  console.log(`   idListServices           : ${/idListServices/i.test(renderedHtml)}`);
  console.log(`   clsBktServiceDataContainer: ${/clsBktServiceDataContainer/i.test(renderedHtml)}`);
  console.log(`   idDivBktServicesContainer : ${/idDivBktServicesContainer/i.test(renderedHtml)}`);

  if (svcIds.length === 0) {
    // Print snippet around "selectservice" in template-removed html
    const idx = mainHtml.indexOf("selectservice");
    if (idx > 0) {
      console.log(`\n   Snippet autour de #selectservice (HTML complet, ±200 chars) :`);
      console.log(`   ${mainHtml.slice(Math.max(0, idx-100), idx+200).replace(/\s+/g," ")}`);
    }
    // Print snippet around "No hay horas"
    const nhIdx = mainHtml.indexOf("No hay horas disponibles");
    if (nhIdx >= 0) {
      console.log(`\n   Snippet autour de "No hay horas" (±300 chars) :`);
      console.log(`   ${mainHtml.slice(Math.max(0, nhIdx-150), nhIdx+200).replace(/\s+/g," ")}`);
    }
    if (!hasWidgetBody) {
      console.log("\n   ⚠️ Widget Bookitit non présent dans /main/ — la session est incomplète.");
      console.log("   Preview /main/ body (1000 chars):");
      console.log(`   ${mainHtml.slice(0,1000).replace(/\s+/g," ")}`);
    }
  }
  console.log();

  // ─── Étape 4 : Naviguer le portail HTML pour passer l'étape Aceptar ────────
  // La navigation directe /main/ dans le browser ne passe pas par le flow
  // portail → POST Continue → Aceptar. On repasse maintenant par le portail
  // pour obtenir le contexte complet (services rendus + getagendas/datetime/).
  console.log("─── Étape 4 : Flow portail complet (POST Continue → services) ───");
  try {
    await page.goto(CUBA_URL, { waitUntil: "networkidle0", timeout: 45_000 });
  } catch (e) { console.warn(`   portail nav warn: ${e}`); }
  await new Promise(r => setTimeout(r, 3000));

  // Détecter et cliquer le bouton Continue/Aceptar
  let clicked = false;
  const selectors = [
    "#idCaptchaButton",
    'button[onclick*="aceptar"]', 'button[onclick*="Aceptar"]',
    'input[type="submit"]', 'input[type="button"]',
    'button.btn-primary', 'button.btn-success',
    'button',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const txt = await page.evaluate(e => (e as HTMLElement).textContent?.trim() ?? (e as HTMLInputElement).value ?? "", el);
      if (/acepto|aceptar|continue|continuar|accept|entendido|vale|siguiente|next/i.test(txt) || sel === "#idCaptchaButton") {
        console.log(`   Clic: "${txt.slice(0,50)}" (${sel})`);
        await el.click();
        clicked = true;
        await new Promise(r => setTimeout(r, 4000));
        break;
      }
    } catch { /* try next */ }
  }
  if (!clicked) console.log("   Pas de bouton Aceptar (page SPA peut-être déjà sur les services)");

  await new Promise(r => setTimeout(r, 6000));

  const portalHtml2 = await page.content().catch(() => "");
  fs.writeFileSync(`${OUT_DIR}/03-after-portal.html`, portalHtml2);

  // Services après Aceptar
  const serviceLinks = await page.$$eval('a[href*="#selectservice"]', els =>
    els.map(el => ({ href: el.getAttribute("href"), text: el.textContent?.trim().slice(0,120) }))
  ).catch(() => []);
  console.log(`   Services trouvés: ${serviceLinks.length}`);
  for (const s of serviceLinks) console.log(`   • ${s.href}  "${s.text}"`);
  console.log();

  // ─── Étape 5 : Clic sur le 1er service → getagendas/ + datetime/ ──────────
  if (serviceLinks.length > 0) {
    console.log("─── Étape 5 : Clic 1er service → getagendas/datetime ───");
    try {
      const svcEl = await page.$('a[href*="#selectservice"]');
      if (svcEl) {
        const href = await page.evaluate(e => e.getAttribute("href"), svcEl);
        const txt  = await page.evaluate(e => e.textContent?.trim(), svcEl);
        console.log(`   Clic service: "${txt}" (${href})`);
        await svcEl.click();
        await new Promise(r => setTimeout(r, 12_000)); // getagendas/ + datetime/ fire
      }
    } catch (e) { console.warn(`   clic service warn: ${e}`); }

    const afterSvcHtml = await page.content().catch(() => "");
    fs.writeFileSync(`${OUT_DIR}/04-after-service.html`, afterSvcHtml);
    console.log(`   HTML après clic service: ${afterSvcHtml.length} chars (04-after-service.html)\n`);
  }

  // Wait for all pending requests to finish
  await new Promise(r => setTimeout(r, 5000));
  await browser.close();

  // ─── Résumé réseau ────────────────────────────────────────────────────────
  fs.writeFileSync(`${OUT_DIR}/network-log.json`, JSON.stringify(log, null, 2));

  const portalCalls   = log.filter(e => /widgetdefault/i.test(e.url));
  const bookititCalls = log.filter(e => /onlinebookings\/(main|getservices|getagendas|datetime|getwidgetconfig)/i.test(e.url));
  const cfCalls       = log.filter(e => /\/cdn-cgi\//i.test(e.url));
  const cookies3 = await (async () => { try { return JSON.parse(fs.readFileSync(`${OUT_DIR}/final-cookies.json`,"utf8")); } catch { return []; } })();

  console.log("─── Résumé réseau ───");
  console.log(`   Total requêtes : ${log.length}`);
  console.log(`   Portail        : ${portalCalls.length}`);
  console.log(`   Bookitit APIs  : ${bookititCalls.length}`);
  console.log(`   CF (cdn-cgi)   : ${cfCalls.length}\n`);

  // ── Appels Portail ────────────────────────────────────────────────────────
  if (portalCalls.length > 0) {
    console.log("🌐 APPELS PORTAIL :");
    for (const c of portalCalls) {
      const u = new URL(c.url);
      console.log(`  ${c.method} ${u.pathname} → ${c.responseStatus ?? "?"}`);
      if (c.responseBody) {
        const body = c.base64 ? Buffer.from(c.responseBody, "base64").toString("utf8") : c.responseBody;
        const tokenM = body.match(/name="token"\s+value="([^"]+)"/);
        if (tokenM) console.log(`    token CSRF: ${tokenM[1].slice(0, 30)}…`);
        const titleM = body.match(/<title[^>]*>([^<]*)<\/title>/i);
        if (titleM) console.log(`    title: ${titleM[1].trim()}`);
      }
    }
    console.log();
  }

  // ── Appels Bookitit ───────────────────────────────────────────────────────
  if (bookititCalls.length > 0) {
    console.log("🎯 APPELS BOOKITIT :");
    console.log("─".repeat(70));
    for (const c of bookititCalls) {
      const u    = new URL(c.url);
      const params = Object.fromEntries(u.searchParams);
      const elapsed = Math.round((c.ts - (log[0]?.ts ?? c.ts)) / 1000);
      console.log(`\n  [t+${elapsed}s] ${c.method} ${u.pathname}`);

      // Key params
      for (const k of ["publickey","type","lang","services[]","agendas[]","selectedPeople","start","end","version","srvsrc"]) {
        if (params[k]) console.log(`    ${k}: ${params[k]}`);
      }
      console.log(`    → HTTP ${c.responseStatus ?? "?"} | mime: ${c.mimeType ?? "?"}`);

      if (c.responseBody) {
        const raw = c.base64 ? Buffer.from(c.responseBody, "base64").toString("utf8") : c.responseBody;
        const safeName = u.pathname.replace(/\//g, "_").replace(/^_+|_+$/g, "") + ".txt";
        fs.writeFileSync(`${OUT_DIR}/${safeName}`, raw);
        const preview = raw.replace(/\s+/g, " ").slice(0, 600);
        console.log(`    body (600): ${preview}`);

        // For /main/: extract service IDs
        if (/\/main\//i.test(u.pathname)) {
          const jsonpM = raw.match(/^[^(]+\("(.*)"\);?$/s);
          let html = raw;
          if (jsonpM) { try { html = JSON.parse(`"${jsonpM[1]}"`); } catch { /* ok */ } }
          fs.writeFileSync(`${OUT_DIR}/main-decoded.html`, html);
          const rendered = html.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");
          const ids = [...new Set([...rendered.matchAll(/href=['"]#selectservice\/([^'"]+)['"]/gi)].map(m => m[1]))];
          if (ids.length > 0) console.log(`    ✅ SERVICE IDs détectés: ${ids.join(", ")}`);
          else console.log(`    ⚠️ Aucun service ID (#selectservice) dans le HTML rendu`);
          const nh = /No hay horas disponibles/i.test(html);
          console.log(`    "No hay horas disponibles": ${nh}`);
        }
      }
    }
    console.log();
  } else {
    console.log("⚠️ Aucun appel Bookitit capturé !\n");
  }

  // ── CF calls ──────────────────────────────────────────────────────────────
  if (cfCalls.length > 0) {
    console.log("🔒 APPELS CF :");
    for (const c of cfCalls) {
      const u = new URL(c.url);
      console.log(`  ${c.method} ${u.pathname.slice(0, 80)} → ${c.responseStatus ?? "?"}`);
    }
    console.log();
  }

  // ── Files ─────────────────────────────────────────────────────────────────
  console.log(`${"═".repeat(66)}`);
  console.log(`  Fichiers dans ${OUT_DIR}/`);
  for (const f of fs.readdirSync(OUT_DIR).sort()) {
    const sz = fs.statSync(`${OUT_DIR}/${f}`).size;
    console.log(`    ${f.padEnd(40)} ${(sz/1024).toFixed(1)} KB`);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n  Durée: ${elapsed}s | Bookitit: ${bookititCalls.length} | cf_clearance: ${cfClearance.slice(0,30)}…`);
  console.log(`${"═".repeat(66)}\n`);
  process.exit(0);
}

run().catch(e => { console.error("❌", e); process.exit(1); });
