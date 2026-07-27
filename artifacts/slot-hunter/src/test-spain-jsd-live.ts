/**
 * TEST LIVE — Détection JSD Oneshot sur page widget citaconsular.es
 *
 * Répond à la question : quand CF sert le widget directement (clearance CapSolver
 * déjà valide), est-ce que CF émet quand même un JSD Oneshot en arrière-plan ?
 *
 * Usage (sur Railway ou machine avec proxy Decodo accessible) :
 *   CAPSOLVER_API_KEY=xxx DECODO_PROXY_URL=http://user:pass@isp.decodo.com:10001 \
 *   node_modules/.bin/tsx src/test-spain-jsd-live.ts
 *
 * Le script fait exactement ce que le bot ferait :
 *   1. Solve CF via CapSolver (AntiCloudflareTask) avec le proxy Decodo
 *   2. Lance Playwright avec le même proxy + injecte la clearance CapSolver
 *   3. Navigate vers le widget et écoute TOUS les flux réseau CF
 *   4. Attend 30s pour observer si JSD fire ou non
 *   5. Conclut clairement : scénario A (JSD émis ✅) ou B (JSD absent ❌)
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use((StealthPlugin as any)());

const WIDGET_URL = process.env.SPAIN_TEST_URL
  ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
const CAPSOLVER_BASE = "https://api.capsolver.com";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const DECODO_PROXY_URL = process.env.DECODO_PROXY_URL ?? "";

// ─── Couleurs console ─────────────────────────────────────────────────────────
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

function log(icon: string, msg: string, color = RESET) {
  console.log(`${color}${icon}  ${msg}${RESET}`);
}

// ─── Vérifications préalables ─────────────────────────────────────────────────
if (!CAPSOLVER_API_KEY) {
  console.error(`${RED}❌ CAPSOLVER_API_KEY manquant${RESET}`);
  process.exit(1);
}
if (!DECODO_PROXY_URL) {
  console.error(`${RED}❌ DECODO_PROXY_URL manquant${RESET}`);
  process.exit(1);
}

// ─── Étape 1 : Solve CF via CapSolver ────────────────────────────────────────
async function solveCfViaCapSolver(): Promise<{ cfClearance: string; userAgent: string } | null> {
  log("🚀", "Étape 1 — Solve CF via CapSolver (AntiCloudflareTask)…", CYAN);
  log("🔌", `Proxy: ${DECODO_PROXY_URL.replace(/:([^:@]+)@/, ":***@")}`, CYAN);

  // Proxy format pour CapSolver
  let proxyForCapsolver = DECODO_PROXY_URL;
  try {
    const p = new URL(DECODO_PROXY_URL);
    proxyForCapsolver = `http://${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}@${p.hostname}:${p.port || "5000"}`;
  } catch { /* keep raw */ }

  // Balance
  try {
    const bal = await fetch(`${CAPSOLVER_BASE}/getBalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY }),
      signal: AbortSignal.timeout(10_000),
    });
    const balData = await bal.json() as any;
    log("💰", `Balance CapSolver: $${balData.balance?.toFixed(3)}`, CYAN);
    if (balData.errorId !== 0 || (balData.balance ?? 0) <= 0) {
      log("❌", `Balance insuffisante: ${JSON.stringify(balData)}`, RED);
      return null;
    }
  } catch (e) { log("❌", `Balance check failed: ${e}`, RED); return null; }

  // Créer tâche
  const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_API_KEY,
      task: { type: "AntiCloudflareTask", websiteURL: WIDGET_URL, proxy: proxyForCapsolver },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const createData = await createRes.json() as any;
  if (createData.errorId !== 0 || !createData.taskId) {
    log("❌", `createTask failed: ${createData.errorDescription ?? createData.errorCode}`, RED);
    return null;
  }
  log("📤", `Task créée: ${createData.taskId}`, CYAN);

  // Poll résultat
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const resultRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId: createData.taskId }),
      signal: AbortSignal.timeout(15_000),
    });
    const rd = await resultRes.json() as any;
    if (rd.errorId !== 0) { log("❌", `Poll error: ${rd.errorCode}`, RED); return null; }
    if (rd.status === "ready" && rd.solution) {
      const cookies = rd.solution.cookies ?? {};
      const cfClearance = cookies["cf_clearance"] || rd.solution.token || "";
      if (!cfClearance) { log("❌", "Solution ready mais pas de cf_clearance", RED); return null; }
      log("✅", `Résolu en ${Math.round((Date.now() - t0) / 1000)}s`, GREEN);
      log("🍪", `cf_clearance: ${cfClearance.slice(0, 40)}…`, GREEN);
      log("🧑", `UA: ${rd.solution.userAgent?.slice(0, 80)}`, GREEN);
      return { cfClearance, userAgent: rd.solution.userAgent ?? "Mozilla/5.0" };
    }
    if (i % 4 === 0) log("⏳", `Poll #${i + 1}/60 — processing (${Math.round((Date.now() - t0) / 1000)}s)…`);
  }
  log("❌", "Timeout CapSolver", RED);
  return null;
}

// ─── Étape 2 : Playwright avec clearance CapSolver + écoute flux CF ───────────
async function testJsdOnWidget(cfClearance: string, userAgent: string): Promise<void> {
  log("\n🌐", "Étape 2 — Playwright : injection clearance CapSolver + écoute flux CF…", CYAN);

  // Parse proxy Decodo
  let proxyServer: { server: string; username?: string; password?: string } | undefined;
  try {
    const p = new URL(DECODO_PROXY_URL);
    proxyServer = {
      server: `${p.protocol}//${p.hostname}:${p.port || "10001"}`,
      username: decodeURIComponent(p.username),
      password: decodeURIComponent(p.password),
    };
    log("🔌", `Proxy Playwright: ${proxyServer.server}`, CYAN);
  } catch { log("⚠️", "Proxy URL non parseable — test sans proxy", YELLOW); }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1280,720",
      "--window-position=80,60",
    ],
    ...(proxyServer ? { proxy: proxyServer } : {}),
  } as any);

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 720 },
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });

  const page = await context.newPage();

  // ─── Injection clearance CapSolver ────────────────────────────────────────
  await context.addCookies([{
    name: "cf_clearance",
    value: cfClearance,
    domain: ".citaconsular.es",
    path: "/",
    secure: true,
    sameSite: "None",
  }]);
  log("🍪", `Clearance CapSolver injectée (1 cookie)`, CYAN);

  // ─── Collecte exhaustive des événements réseau CF ─────────────────────────
  const events: { type: string; url: string; statusCode?: number; setCookie?: string; ts: number }[] = [];

  page.on("request", (req: any) => {
    const url: string = req.url();
    if (url.includes("/cdn-cgi/") || url.includes("challenge-platform") || url.includes("jsd")) {
      events.push({ type: "REQ", url, ts: Date.now() });
      log("→", `[${(Date.now() / 1000).toFixed(1)}s] REQ  ${url.slice(0, 120)}`, YELLOW);
    }
  });

  page.on("response", async (res: any) => {
    const url: string = res.url();
    if (url.includes("/cdn-cgi/") || url.includes("challenge-platform") || url.includes("jsd")) {
      const headers: any = res.headers();
      const setCookie: string = headers["set-cookie"] ?? "";
      const status: number = res.status();
      events.push({ type: "RES", url, statusCode: status, setCookie, ts: Date.now() });
      const cfMatch = /cf_clearance=([^;]+)/.exec(setCookie);
      if (cfMatch) {
        log("🔑", `[${(Date.now() / 1000).toFixed(1)}s] RES  ${url.slice(0, 100)}`, GREEN);
        log("🎉", `  → Set-Cookie: cf_clearance=${cfMatch[1].slice(0, 40)}…  ← cf_clearance #2 !!!`, `${BOLD}${GREEN}`);
      } else {
        log("←", `[${(Date.now() / 1000).toFixed(1)}s] RES  HTTP ${status}  ${url.slice(0, 100)}`, YELLOW);
        if (setCookie) log("  ", `  Set-Cookie: ${setCookie.slice(0, 80)}`, YELLOW);
      }
    }
  });

  // ─── Navigation vers le widget ────────────────────────────────────────────
  log("🌐", `Navigation → ${WIDGET_URL}`, CYAN);
  const t0 = Date.now();
  await page.goto(WIDGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // État des cookies après navigation
  const cookiesAfterNav = await context.cookies();
  const cfAfterNav = cookiesAfterNav.find((c: any) => c.name === "cf_clearance");
  const phpSessId = cookiesAfterNav.find((c: any) => c.name === "PHPSESSID");

  log("\n📋", "── État après navigation ──", CYAN);
  log("", `  cf_clearance : ${cfAfterNav ? `✅ ${cfAfterNav.value.slice(0, 40)}…` : "❌ absent"}`, cfAfterNav ? GREEN : RED);
  log("", `  PHPSESSID    : ${phpSessId ? `✅ ${phpSessId.value.slice(0, 20)}…` : "❌ absent"}`, phpSessId ? GREEN : RED);
  log("", `  Tous cookies : ${cookiesAfterNav.map((c: any) => c.name).join(", ")}`);

  // Page title / challenge ?
  const title = await page.title().catch(() => "?");
  const content = await page.content().catch(() => "");
  const isChallenge = /just a moment|verifying|challenge/i.test(content.slice(0, 3000));
  log("", `  Titre        : "${title}" ${isChallenge ? "⚠️ CF CHALLENGE" : "✅ widget direct"}`, isChallenge ? YELLOW : GREEN);

  // ─── Attente JSD Oneshot (30s) ────────────────────────────────────────────
  log("\n⏳", "Attente JSD Oneshot (30s max)…", CYAN);
  const jsdWaitMs = 30_000;
  const tWait = Date.now();

  let jsdFired = false;
  let cfClearance2: string | null = null;

  while (!jsdFired && Date.now() - tWait < jsdWaitMs) {
    await new Promise(r => setTimeout(r, 500));
    // Check si JSD a été capturé dans les events
    const jsdEvent = events.find(e =>
      e.type === "RES" &&
      e.url.includes("/cdn-cgi/challenge-platform/") &&
      e.url.includes("/jsd/oneshot/") &&
      e.ts > t0
    );
    if (jsdEvent?.setCookie) {
      const match = /cf_clearance=([^;]+)/.exec(jsdEvent.setCookie);
      if (match) {
        jsdFired = true;
        cfClearance2 = match[1];
      }
    }
  }

  // Cookies finaux après attente
  const finalCookies = await context.cookies();
  const cfFinal = finalCookies.find((c: any) => c.name === "cf_clearance");

  // ─── Résultat ─────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  if (jsdFired && cfClearance2) {
    log("", `${BOLD}${GREEN}🎉 SCÉNARIO A — JSD Oneshot émis !${RESET}`, "");
    log("", `   CF a exécuté son JS en arrière-plan même avec widget direct.`, GREEN);
    log("", `   cf_clearance #2 (post-JSD): ${cfClearance2.slice(0, 50)}…`, GREEN);
    log("", `   → Le fix "toujours attendre JSD" fonctionnera en production.`, `${BOLD}${GREEN}`);
  } else {
    log("", `${BOLD}${RED}⚠️  SCÉNARIO B — JSD non émis après ${jsdWaitMs / 1000}s${RESET}`, "");
    log("", `   CF n'a PAS exécuté JSD sur la page widget quand clearance déjà valide.`, RED);
    log("", `   cf_clearance finale (CapSolver #1): ${cfFinal?.value.slice(0, 50) ?? "absent"}…`, YELLOW);
    log("", `   → Attendre JSD ne suffit pas. Autre approche nécessaire :`, `${BOLD}${RED}`);
    log("", `     - Naviguer d'abord vers l'URL portail (pas widget directement)`, RED);
    log("", `     - Forcer un reload sans cf_clearance pour déclencher l'interstitiel`, RED);
    log("", `     - Ou utiliser directement la clearance CapSolver avec impit+fingerprint`, RED);
  }
  console.log("═".repeat(60));

  // ─── Bilan détaillé des événements CF captés ──────────────────────────────
  console.log(`\n${CYAN}── Bilan réseau CF (${events.length} événements) ──${RESET}`);
  if (events.length === 0) {
    log("ℹ️", "Aucun flux CF capté — widget servi sans aucun script CF chargé", YELLOW);
  } else {
    for (const e of events) {
      const age = Math.round((e.ts - t0) / 1000);
      const hasCookie = e.setCookie?.includes("cf_clearance") ? " 🔑 cf_clearance!" : "";
      console.log(`  [+${age}s] ${e.type} ${e.statusCode ?? ""} ${e.url.slice(0, 100)}${hasCookie}`);
    }
  }

  await browser.close();
  log("\n🔋", "Navigateur fermé.", CYAN);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}`);
  console.log(`  TEST LIVE — JSD Oneshot sur widget citaconsular.es`);
  console.log(`${"═".repeat(60)}${RESET}\n`);

  const solved = await solveCfViaCapSolver();
  if (!solved) {
    log("❌", "Solve CapSolver échoué — test abandonné.", RED);
    process.exit(1);
  }

  await testJsdOnWidget(solved.cfClearance, solved.userAgent);
})();
