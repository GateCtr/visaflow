/**
 * test-spain-native-cf.ts
 *
 * Approche 2 : CF résolu nativement dans Chromium via proxy Decodo.
 * ─────────────────────────────────────────────────────────────────
 * Différence vs test-spain-pb.ts :
 *   AVANT  → CapSolver résout CF sur ses serveurs → cf_clearance lié à leur TLS
 *            → injecté dans notre Chromium → mismatch TLS → /main/ = 0B
 *   MAINTENANT → Chromium navigue directement avec proxy Decodo
 *            → CF émet cf_clearance lié à NOTRE Chromium TLS
 *            → /main/ reçoit les cookies corrects → body complet
 *
 * Watchdog 90s — arrêt immédiat si ça bloque.
 *
 * Usage: cd artifacts/slot-hunter && node_modules/.bin/tsx test-spain-native-cf.ts
 */
import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";

puppeteer.use(StealthPlugin());

// ── Config ────────────────────────────────────────────────────────────────────
const PROXY_URL    = process.env.DECODO_PROXY_URL ?? "";
const TARGET_URL   = process.env.TEST_PORTAL_URL  ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

// Watchdog 90s
const watchdog = setTimeout(() => {
  console.error("\n⏱️ WATCHDOG 90s — arrêt forcé");
  process.exit(4);
}, 90_000);
watchdog.unref();

// ── Parse proxy ───────────────────────────────────────────────────────────────
function parseProxy(url: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      server:   `${u.protocol}//${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("=".repeat(60));
console.log("TEST approche 2 — CF natif Chromium + proxy Decodo");
console.log(`  DECODO_PROXY_URL : ${PROXY_URL ? "✅ " + PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "❌ manquant"}`);
console.log(`  Target URL       : ${TARGET_URL}`);
console.log(`  UA               : ${UA.slice(0, 70)}`);
console.log("=".repeat(60));

if (!PROXY_URL) {
  console.error("❌ DECODO_PROXY_URL non défini — arrêt");
  process.exit(1);
}

const proxy = parseProxy(PROXY_URL)!;
const t0 = Date.now();
let browser: Browser | null = null;

async function cleanup() {
  try { await browser?.close(); } catch { /* non-fatal */ }
  clearTimeout(watchdog);
}

try {
  // ── 1. Lancer Chromium avec proxy Decodo ──────────────────────────────────
  console.log(`\n[step1] 🚀 Lancement Chromium (proxy: ${proxy.server})`);
  browser = await (puppeteer as any).launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--enable-webgl",
      "--window-size=1366,768",
      `--user-agent=${UA}`,
      `--proxy-server=${proxy.server}`,
    ],
  }) as Browser;

  const pages = await browser.pages();
  const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 768 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-ES,es;q=0.9,fr-FR;q=0.8,en;q=0.7" });

  // Auth proxy (CDP Fetch)
  const cdpProxy = await page.createCDPSession();
  await cdpProxy.send("Fetch.enable", { handleAuthRequests: true });
  cdpProxy.on("Fetch.authRequired", async (ev: any) => {
    await cdpProxy.send("Fetch.continueWithAuth", {
      requestId: ev.requestId,
      authChallengeResponse: { response: "ProvideCredentials", username: proxy.username, password: proxy.password },
    }).catch(() => {});
  });
  cdpProxy.on("Fetch.requestPaused", async (ev: any) => {
    await cdpProxy.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
  });

  // Supprimer window.alert
  await (page as any).evaluateOnNewDocument(() => {
    (window as any).alert   = () => {};
    (window as any).confirm = () => true;
    (window as any).prompt  = () => "";
  });
  page.on("dialog", async (d: any) => { await d.accept().catch(() => {}); });

  // ── 2. CDP Network — surveiller cf_clearance + /main/ ─────────────────────
  console.log("[step2] 🔭 CDP Network activé");
  const cdpNet = await page.createCDPSession();
  await cdpNet.send("Network.enable", {});

  let cfClearance    = "";
  let phpSessId      = "";
  let mainBody       = "";
  let jsdOneShotAt   = 0;

  // Surveiller les Set-Cookie pour capturer cf_clearance et PHPSESSID
  cdpNet.on("Network.responseReceived", (ev: any) => {
    const url: string = ev.response.url ?? "";
    const status: number = ev.response.status;

    if (url.includes("jsd/oneshot")) {
      const setCookie: string = ev.response.headers?.["set-cookie"] ?? "";
      const hasNewCf = setCookie.includes("cf_clearance");
      console.log(`[net] 🔑 JSD oneshot status=${status} new-cf_clearance=${hasNewCf ? "✅ OUI" : "❌ non"}`);
      jsdOneShotAt = Date.now();
    }

    if (url.includes("/onlinebookings/main/")) {
      console.log(`[net] 📡 /main/ responseReceived status=${status} type=${ev.type} mimeType=${ev.response.mimeType}`);
    }
  });

  // Capturer le body /main/ via CDP
  cdpNet.on("Network.loadingFinished", async (ev: any) => {
    if (mainBody.length > 100) return; // déjà capturé
    // On ne peut pas filtrer par URL ici sans requestId map — on lit tout ce qui a un body
  });

  // Capturer requestId des requêtes /main/
  const mainRequestIds = new Map<string, string>(); // requestId → url
  cdpNet.on("Network.requestWillBeSent", (ev: any) => {
    const url: string = ev.request.url ?? "";
    if (url.includes("/onlinebookings/main/")) {
      mainRequestIds.set(ev.requestId, url);
    }
    if (/jsd|challenge-platform|cf_clearance|citaconsular/.test(url)) {
      process.stdout.write(`[net] → ${ev.request.method} ${url.slice(0, 100)}\n`);
    }
  });

  (cdpNet as any).on("Network.loadingFinished", async (ev: any) => {
    if (!mainRequestIds.has(ev.requestId)) return;
    try {
      const { body } = await cdpNet.send("Network.getResponseBody", { requestId: ev.requestId });
      console.log(`[net] 📥 /main/ CDP body: ${body.length}B snippet="${body.slice(0, 80)}"`);
      if (body.length > 100) mainBody = body;
    } catch (e) { console.warn(`[net] ⚠️ getResponseBody: ${e}`); }
  });

  // ── 3. Naviguer vers le portail (CF challenge natif) ─────────────────────
  console.log(`\n[step3] 🌐 Navigation portail — CF natif (sans pre-inject)…`);
  const gotoErr = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 45_000 })
    .then(() => null)
    .catch((e: unknown) => String(e));
  if (gotoErr) console.warn(`[step3] ⚠️ goto non-fatal: ${gotoErr}`);

  // ── 4. Attendre cf_clearance (max 40s) via poll cookies ───────────────────
  console.log("[step4] ⏳ Attente cf_clearance natif (max 40s)…");
  const cfDeadline = Date.now() + 40_000;
  while (Date.now() < cfDeadline && !cfClearance) {
    const cookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
    const cf = cookies.find((c) => c.name === "cf_clearance");
    const php = cookies.find((c) => c.name === "PHPSESSID");
    if (cf) cfClearance = cf.value;
    if (php) phpSessId  = php.value;
    if (!cfClearance) await new Promise((r) => setTimeout(r, 1_500));
  }

  const elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);
  if (!cfClearance) {
    console.error(`[step4] ❌ cf_clearance non obtenu après 40s — CF challenge non résolu`);
    const snap = await page.content().catch(() => "");
    console.log(`[step4] DOM snippet: ${snap.slice(0, 300).replace(/\n/g, " ")}`);
    await cleanup();
    process.exit(2);
  }
  console.log(`[step4] ✅ cf_clearance obtenu (${elapsed1}s): ${cfClearance.slice(0, 50)}…`);
  console.log(`[step4]    PHPSESSID: ${phpSessId ? phpSessId.slice(0, 20) + "…" : "❌ absent"}`);

  // ── 5. Cliquer Continuar (max 25s) ────────────────────────────────────────
  console.log("[step5] 🖱️ Recherche bouton Continuar…");
  let clicked = false;
  const clickDeadline = Date.now() + 25_000;
  while (Date.now() < clickDeadline && !clicked) {
    clicked = await page.evaluate(() => {
      const btn = document.getElementById("idDivBktCustomContinueButton");
      if (btn && (btn as HTMLElement).offsetParent !== null) { (btn as HTMLElement).click(); return true; }
      const all = document.querySelectorAll("a, button, [role='button']");
      for (const el of Array.from(all)) {
        const txt = (el.textContent || "").trim().toLowerCase();
        if ((txt.includes("continu") || txt.includes("siguiente")) && (el as HTMLElement).offsetParent !== null) {
          (el as HTMLElement).click(); return true;
        }
      }
      return false;
    }).catch(() => false);

    if (!clicked) {
      const st = await page.evaluate(() => ({
        title: document.title.slice(0, 50),
        hasBtn: !!document.getElementById("idDivBktCustomContinueButton"),
        body: (document.body?.innerText ?? "").slice(0, 80).replace(/\n/g, " "),
      })).catch(() => ({ title: "?", hasBtn: false, body: "?" }));
      console.log(`[step5] 🔍 DOM: ${JSON.stringify(st)}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  if (!clicked) {
    console.error("[step5] ❌ Bouton Continuar introuvable après 25s");
    await cleanup();
    process.exit(3);
  }
  console.log("[step5] ✅ Continuar cliqué — attente /main/ (max 15s)…");

  // ── 6. Attendre body /main/ (listener CDP) ────────────────────────────────
  const mainDeadline = Date.now() + 15_000;
  while (Date.now() < mainDeadline && mainBody.length < 100) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // ── 7. Fallback fetch direct si listener a raté (délai post-JSD) ──────────
  if (mainBody.length < 100) {
    const msSinceJsd = jsdOneShotAt > 0 ? Date.now() - jsdOneShotAt : 0;
    const waitMs = Math.max(0, 1_500 - msSinceJsd);
    if (waitMs > 0) {
      console.log(`[step6] ⏳ Délai post-JSD ${waitMs}ms…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const publickey = TARGET_URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
    const cbName    = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    const mainQuery = new URLSearchParams({
      callback: cbName, type: "default", publickey, lang: "es", version: "4",
      src: TARGET_URL.replace(/\/?$/, "/"), _: String(Date.now()),
    });
    const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${mainQuery}`;

    console.log("[step6] 🎯 Fetch direct /main/ depuis contexte browser…");
    const fetched: string = await page.evaluate(async (url: string) => {
      try {
        const r = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { "Accept": "*/*", "X-Requested-With": "XMLHttpRequest" },
        });
        if (!r.ok) return `__ERR_${r.status}`;
        return await r.text();
      } catch (e: unknown) { return `__EXC_${String(e).slice(0, 80)}`; }
    }, mainUrl).catch(() => "");

    if (fetched.length > 100 && !fetched.startsWith("__ERR_") && !fetched.startsWith("__EXC_")) {
      mainBody = fetched;
      console.log(`[step6] 📦 Fetch direct réussi (${mainBody.length}B)`);
    } else {
      console.warn(`[step6] ⚠️ Fetch direct échoué: "${fetched.slice(0, 120)}"`);
    }
  } else {
    console.log(`[step5] 📦 /main/ capturé via listener CDP (${mainBody.length}B)`);
  }

  // ── Résultat ──────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const allCookies = await page.cookies("https://www.citaconsular.es").catch(() => []);

  await cleanup();

  console.log("\n" + "=".repeat(60));
  const ok = mainBody.length > 100;
  console.log(ok ? `✅ SUCCÈS (${elapsed}s)` : `❌ ÉCHEC — /main/ vide (${elapsed}s)`);
  console.log(`   cf_clearance  : ${cfClearance.slice(0, 50)}… [source: Chromium natif ✅]`);
  console.log(`   PHPSESSID     : ${phpSessId ? phpSessId.slice(0, 20) + "…" : "❌ absent"}`);
  console.log(`   cookies total : ${allCookies.length} (${allCookies.map((c) => c.name).join(", ")})`);
  console.log(`   /main/ body   : ${ok ? mainBody.length + "B — snippet: " + mainBody.slice(0, 120).replace(/\n/g, " ") : "❌ 0B"}`);
  console.log("=".repeat(60));

  process.exit(ok ? 0 : 2);

} catch (err) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  await cleanup();
  console.error(`\n❌ EXCEPTION (${elapsed}s):`, err);
  process.exit(1);
}
