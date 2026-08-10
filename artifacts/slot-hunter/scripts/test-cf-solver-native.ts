/**
 * test-cf-solver-native.ts — Test du solver CF NATIF (sans service tiers)
 *
 * Valide que cf-challenge-solver.ts peut :
 *   1. Détecter le type de challenge CF sur citaconsular.es
 *   2. Le résoudre par clic CDP humanisé (Bézier + CDP Input) ou JSD passif
 *   3. Retourner un cf_clearance + PHPSESSID valides
 *   4. (Bonus) Confirmer que les cookies permettent d'atteindre getservices/
 *      via impit en HTTP pur — sans browser
 *
 * AUCUN service tiers (CapSolver, 2Captcha…) — natif uniquement.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/test-cf-solver-native.ts
 *
 * Env :
 *   DECODO_PROXY_URL   — proxy ISP/résidentiel Decodo (recommandé)
 *   MAX_RETRIES        — tentatives max (défaut: 3)
 *   HEADLESS           — "false" pour voir le navigateur (défaut: true)
 *   SPAIN_TEST_URL     — URL cible (défaut: portail Kinshasa)
 */

import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Impit } from "impit";

import {
  detectChallengeType,
  solveCfChallengeWithRetry,
  preparePageStealth,
  type CfSolveResult,
} from "../src/cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ─── Config ──────────────────────────────────────────────────────────────────

const TARGET_URL =
  process.env.SPAIN_TEST_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

const WIDGET_KEY   = TARGET_URL.match(/widgetdefault\/([a-f0-9]+)/)?.[1] ?? "";
const BASE_BOOK    = "https://www.citaconsular.es/onlinebookings/";

const DECODO_PROXY_URL = process.env.DECODO_PROXY_URL ?? "";
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES ?? "3", 10);
const HEADLESS    = process.env.HEADLESS !== "false";

// ─── Couleurs ────────────────────────────────────────────────────────────────

const C = {
  GREEN:  "\x1b[32m", RED:    "\x1b[31m", YELLOW: "\x1b[33m",
  CYAN:   "\x1b[36m", BOLD:   "\x1b[1m",  DIM:    "\x1b[2m",  RESET: "\x1b[0m",
};

function log(icon: string, msg: string, color = C.RESET) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${C.DIM}[${ts}]${C.RESET} ${color}${icon}  ${msg}${C.RESET}`);
}
function header(title: string) {
  console.log(`\n${C.BOLD}${"═".repeat(68)}${C.RESET}`);
  console.log(`${C.BOLD}  ${title}${C.RESET}`);
  console.log(`${C.BOLD}${"═".repeat(68)}${C.RESET}\n`);
}
function elapsed(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }

// ─── Proxy parsing ───────────────────────────────────────────────────────────

function parseProxy(url: string): { server: string; username: string; password: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      server:   `${u.protocol}//${u.hostname}:${u.port || "10001"}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch { return null; }
}

// ─── Cookie jar helpers ──────────────────────────────────────────────────────

function buildCookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function mergeSetCookies(headers: Headers, jar: Map<string, string>): void {
  const raw = headers.get("set-cookie") ?? "";
  if (!raw) return;
  for (const part of raw.split(/,(?=[^ ])/)) {
    const nameVal = part.split(";")[0].trim();
    const eq = nameVal.indexOf("=");
    if (eq === -1) continue;
    jar.set(nameVal.slice(0, eq).trim(), nameVal.slice(eq + 1).trim());
  }
}

// ─── impit fetch helper ──────────────────────────────────────────────────────

async function impitFetch(
  url: string,
  impit: InstanceType<typeof Impit>,
  jar: Map<string, string>,
  ua: string,
  referer: string,
  method: "GET" | "POST" = "GET",
  body?: string,
  mode: "navigate" | "jsonp" | "form" = "navigate",
): Promise<{ status: number; body: string; ct: string }> {
  const secFetch = mode === "jsonp"
    ? { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9" }
    : mode === "form"
    ? { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept-Language": "fr-FR,fr;q=0.9" }
    : { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9" };

  const res = await impit.fetch(url, {
    method,
    headers: {
      "Cookie":     buildCookieHeader(jar),
      "User-Agent": ua,
      "Referer":    referer,
      ...secFetch,
    },
    ...(body ? { body } : {}),
  } as any);

  const text = await res.text();
  mergeSetCookies(res.headers, jar);
  return { status: res.status, body: text, ct: res.headers.get("content-type") ?? "" };
}

// ─── Test principal ──────────────────────────────────────────────────────────

async function runTest() {
  header("TEST CF-SOLVER NATIF — citaconsular.es (SANS service tiers)");

  // ── Checks préalables ─────────────────────────────────────────────────────
  log("🔍", "Vérifications…", C.CYAN);

  const proxy = parseProxy(DECODO_PROXY_URL);
  if (!proxy) {
    log("⚠️", "DECODO_PROXY_URL absent — test sans proxy (risque de blocage CF)", C.YELLOW);
  } else {
    log("✅", `Proxy ISP : ${proxy.server} (${proxy.username.slice(0, 8)}…)`, C.GREEN);
  }
  log("🚫", "CapSolver désactivé — mode NATIF uniquement", C.YELLOW);
  log("🎯", `Cible : ${TARGET_URL}`, C.CYAN);
  log("🔑", `Widget key : ${WIDGET_KEY}`, C.CYAN);
  log("🔁", `Max retries : ${MAX_RETRIES} | Headless : ${HEADLESS}`, C.DIM);

  // ── Lancer Puppeteer ──────────────────────────────────────────────────────
  header("PHASE 1 — Résolution CF native");

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1920,1080",
    "--lang=fr-FR",
  ];
  if (proxy) launchArgs.push(`--proxy-server=${proxy.server}`);

  const t0 = Date.now();
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: launchArgs,
    defaultViewport: { width: 1920, height: 1080 },
  });

  log("✅", `Puppeteer lancé en ${elapsed(Date.now() - t0)}`, C.GREEN);

  let result: CfSolveResult | null = null;
  let allCookies: Array<{ name: string; value: string }> = [];
  let cfClearance = "";
  let phpSessId   = "";
  let solverUa    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  try {
    const page = await browser.newPage();

    // Auth proxy
    if (proxy) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    // ── Détection avant solve ──
    log("🌐", "Navigation initiale…", C.CYAN);
    const navT0 = Date.now();
    try {
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e: any) {
      log("⚠️", `Timeout navigation (attendu CF) : ${e.message?.slice(0, 60)}`, C.YELLOW);
    }
    log("📄", `Chargé en ${elapsed(Date.now() - navT0)} — titre: "${await page.title().catch(() => "?")}"`, C.CYAN);

    const challengeBefore = await detectChallengeType(page);
    log("🏷️",  `Type CF détecté : ${C.BOLD}${challengeBefore}${C.RESET}`, C.CYAN);

    // ── Résolution native ──
    const solveT0 = Date.now();
    result = await solveCfChallengeWithRetry(page, browser, {
      targetUrl:              TARGET_URL,
      maxRetries:             MAX_RETRIES,
      timeout:                120_000,
      enableCapsolverFallback: false,   // ← NATIF uniquement
      proxyUrl:               DECODO_PROXY_URL || undefined,
      purgeStaleData:         true,
      cacheBustCdn:           true,
    });
    const solveMs = Date.now() - solveT0;

    if (result.success) {
      log("✅", `Challenge résolu en ${elapsed(solveMs)} via ${C.BOLD}${result.solvedBy}${C.RESET}`, C.GREEN);
      cfClearance = result.cfClearance ?? "";
      allCookies  = result.allCookies ?? [];

      // Extraire PHPSESSID
      phpSessId = allCookies.find(c => c.name === "PHPSESSID")?.value ?? "";

      // Lire le UA utilisé par Puppeteer
      solverUa = await page.evaluate(() => navigator.userAgent).catch(() => solverUa);

      log("🍪", `cf_clearance : ${cfClearance.slice(0, 50)}…`, C.GREEN);
      log("🍪", `PHPSESSID   : ${phpSessId ? phpSessId.slice(0, 25) + "…" : "absent"}`, phpSessId ? C.GREEN : C.YELLOW);
      log("🍪", `Total cookies : ${allCookies.length} — ${allCookies.map(c => c.name).join(", ")}`, C.CYAN);
      log("🤖", `User-Agent : ${solverUa.slice(0, 80)}`, C.DIM);

      // Screenshot post-solve
      const ss = `debug_dumps/cf-solver-native-${Date.now()}.png`;
      await page.screenshot({ path: ss, fullPage: false }).catch(() => {});
      log("📸", `Screenshot : ${ss}`, C.DIM);

    } else {
      log("❌", `Échec résolution : ${result.error}`, C.RED);
      const ss = `debug_dumps/cf-solver-native-fail-${Date.now()}.png`;
      await page.screenshot({ path: ss, fullPage: false }).catch(() => {});
      log("📸", `Screenshot : ${ss}`, C.DIM);
    }

  } finally {
    await browser.close().catch(() => {});
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 2 — Validation HTTP via impit avec les cookies obtenus
  // ─────────────────────────────────────────────────────────────────────────

  let mainOk       = false;
  let tokenPostOk  = false;
  let svcOk        = false;
  let mainBytes    = 0;
  let svcBody      = "";
  let services: Array<{ id: string; name?: string }> = [];

  if (result?.success && cfClearance && WIDGET_KEY) {
    header("PHASE 2 — Validation HTTP impit (cf_clearance Puppeteer → impit)");

    // Construire le jar à partir des cookies Puppeteer
    const jar = new Map<string, string>();

    // Ordre exact Burp : _ga first, cf_clearance last
    const nowSec   = Math.floor(Date.now() / 1000);
    const rnd9     = Math.floor(100_000_000 + Math.random() * 900_000_000);
    const pastTs   = nowSec - Math.floor(Math.random() * 30 * 86400);
    jar.set("_ga",            `GA1.1.${rnd9}.${pastTs}`);
    jar.set("_ga_F3TYSDL945", `GS2.1.s${nowSec}$o1$g0$t${nowSec}$j60$l0$h0`);
    if (phpSessId) jar.set("PHPSESSID", phpSessId);
    jar.set("cf_clearance", cfClearance);

    log("🍪", `Jar impit : ${[...jar.keys()].join(", ")}`, C.CYAN);

    // Même proxy que Puppeteer (même IP → CF accepte le clearance)
    const impit = new Impit({ browser: "chrome", proxyUrl: DECODO_PROXY_URL || undefined } as any);
    const ua    = solverUa;
    const ts    = `${Date.now()}`;

    // ── 2a : GET portail → confirmer accès + obtenir token Bookitit ──
    log("🌐", "GET portail Bookitit…", C.CYAN);
    const t2a = Date.now();
    const portalRes = await impitFetch(TARGET_URL, impit, jar, ua, "https://www.citaconsular.es/", "GET", undefined, "navigate");
    log("ℹ️",  `Portail : ${portalRes.status} | ${portalRes.body.length}B | ${elapsed(Date.now() - t2a)}`, C.DIM);

    if (portalRes.body.length < 100) {
      log("❌", "Portail → 0B (cf_clearance rejeté — TLS fingerprint impit ≠ Puppeteer)", C.RED);
    } else {
      // Chercher le token Bookitit dans le HTML
      const tokenMatch = portalRes.body.match(/<input[^>]*name=["']token["'][^>]*value=["']([^"']+)["']/)
                      ?? portalRes.body.match(/value="([a-f0-9]{30,42})"/);

      if (tokenMatch) {
        const bookititToken = tokenMatch[1];
        log("✅", `Token Bookitit : ${bookititToken}`, C.GREEN);

        // ── 2b : POST token → initialiser session PHP ──
        log("🌐", "POST portail (token Bookitit → initialisation session)…", C.CYAN);
        const t2b = Date.now();
        const postRes = await impitFetch(
          TARGET_URL, impit, jar, ua, TARGET_URL,
          "POST", `token=${encodeURIComponent(bookititToken)}`, "form"
        );
        log("ℹ️",  `POST : ${postRes.status} | ${postRes.body.length}B | ${elapsed(Date.now() - t2b)}`, C.DIM);
        tokenPostOk = postRes.body.length > 100;
        if (tokenPostOk) log("✅", "Session PHP initialisée (token accepté)", C.GREEN);
        else              log("⚠️", "POST token → réponse courte", C.YELLOW);

      } else if (portalRes.body.includes("idBktWidgetBody")) {
        // Portail déjà passé → widget chargé directement
        log("✅", "Portail → widget déjà chargé (pas de porte Bookitit)", C.GREEN);
        tokenPostOk = true;
      } else {
        log("⚠️", "Token Bookitit absent dans la réponse portail", C.YELLOW);
        log("ℹ️",  `Extrait : ${portalRes.body.slice(0, 200)}`, C.DIM);
      }
    }

    // ── 2c : GET /main/ ──
    log("🌐", "GET /main/ Bookitit…", C.CYAN);
    const mainUrl = `${BASE_BOOK}main/?callback=jQuery_main_${ts}&type=default&publickey=${WIDGET_KEY}&lang=es&version=4&src=${encodeURIComponent(TARGET_URL)}&_=${ts}`;
    const t2c = Date.now();
    const mainRes = await impitFetch(mainUrl, impit, jar, ua, TARGET_URL, "GET", undefined, "jsonp");
    mainBytes = mainRes.body.length;
    log("ℹ️",  `/main/ : ${mainRes.status} | ${mainBytes}B | ${elapsed(Date.now() - t2c)}`, C.DIM);

    if (mainBytes > 10_000) {
      mainOk = true;
      log("✅", `/main/ → ${mainBytes}B ✅`, C.GREEN);
      const noHoras = /no hay horas|no hay citas|No dates available/i.test(mainRes.body);
      if (noHoras) log("✅", "Signal 'No hay horas' → scanner opérationnel", C.GREEN);
    } else {
      log("❌", `/main/ → ${mainBytes}B`, C.RED);
    }

    // ── 2d : GET getservices/ (après délai GTM ~3s) ──
    if (mainOk) {
      const delay = 2800 + Math.floor(Math.random() * 800);
      log("⏳", `Attente ${delay}ms (GTM load)…`, C.DIM);
      await new Promise(r => setTimeout(r, delay));

      log("🌐", "GET getservices/…", C.CYAN);
      const svcUrl = `${BASE_BOOK}getservices/?callback=jQuery_svc_${ts}&type=default&publickey=${WIDGET_KEY}&lang=es&version=4&src=${encodeURIComponent(TARGET_URL)}&_=${ts}`;
      const t2d = Date.now();
      const svcRes = await impitFetch(svcUrl, impit, jar, ua, TARGET_URL, "GET", undefined, "jsonp");
      svcBody = svcRes.body;
      log("ℹ️",  `getservices/ : ${svcRes.status} | ${svcBody.length}B | ${elapsed(Date.now() - t2d)}`, C.DIM);

      if (svcBody.length > 10) {
        svcOk = true;
        log("✅", `getservices/ → ${svcBody.length}B ✅`, C.GREEN);

        // Parser les services
        const parsed = svcBody.replace(/^[^(]+\(/, "").replace(/\)\s*$/, "");
        try {
          const data = JSON.parse(parsed);
          const arr: any[] = Array.isArray(data) ? data : data?.Services ?? [];
          services = arr.map(s => ({ id: s.id, name: s.name }));
          for (const s of services.slice(0, 5)) {
            log("🔹", `Service id=${s.id} | ${(s.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 60)}`, C.CYAN);
          }
        } catch {
          log("⚠️", `Parse JSONP échoué — extrait : ${svcBody.slice(0, 200)}`, C.YELLOW);
        }
      } else {
        log("❌", "getservices/ → 0B (TLS fingerprint ou session non initialisée)", C.RED);
        log("ℹ️",  "→ Solution : utiliser les cookies PHPSESSID de Puppeteer + même IP", C.DIM);
      }
    }
  } else if (result?.success && !cfClearance) {
    log("⚠️", "cf_clearance absent malgré le succès — pas de validation HTTP", C.YELLOW);
  }

  // ─── Rapport final ────────────────────────────────────────────────────────
  header("RAPPORT FINAL");

  const totalMs = Date.now() - t0;
  const ok  = (b: boolean) => b ? `${C.GREEN}✅${C.RESET}` : `${C.RED}❌${C.RESET}`;

  console.log(`  ${ok(!!result?.success)}  CF challenge résolu (natif)     ${result?.success ? `via ${result.solvedBy}` : result?.error?.slice(0, 60) ?? ""}`);
  console.log(`  ${ok(!!cfClearance)}  cf_clearance obtenu               ${cfClearance ? cfClearance.slice(0, 40) + "…" : "absent"}`);
  console.log(`  ${ok(!!phpSessId)}   PHPSESSID obtenu                  ${phpSessId ? phpSessId.slice(0, 25) + "…" : "absent"}`);
  if (result?.success) {
    console.log(`  ${ok(tokenPostOk)}  Token Bookitit POST               ${tokenPostOk ? "OK" : "non testé ou échoué"}`);
    console.log(`  ${ok(mainOk)}  /main/ Bookitit (${mainBytes}B)         ${mainOk ? "signal 'No hay horas' détectable" : "échec"}`);
    console.log(`  ${ok(svcOk)}  getservices/ (${svcBody.length}B)          ${svcOk ? `${services.length} service(s)` : "0B — voir notes"}`);
  }
  console.log();
  console.log(`  Durée totale    : ${elapsed(totalMs)}`);
  console.log(`  Type challenge  : ${result?.challengeType ?? "?"}`);
  console.log(`  Stratégie       : ${result?.solvedBy ?? "aucune"}`);
  console.log(`  Proxy           : ${proxy ? proxy.server : "aucun"}`);
  console.log(`  Cookies totaux  : ${allCookies.length} — ${allCookies.map(c => c.name).join(", ")}`);
  console.log();

  if (!svcOk && result?.success) {
    console.log(`  ${C.YELLOW}Note getservices/ :${C.RESET}`);
    console.log(`  Si 0B, le TLS fingerprint impit ≠ Puppeteer → CF rejette sur les endpoints stricts.`);
    console.log(`  Solution : utiliser directement Puppeteer pour getservices/ aussi (page.evaluate fetch)`);
    console.log(`  OU passer le PHPSESSID Puppeteer + une IP dédiée fixe (ISP résidentiel).`);
    console.log();
  }

  process.exit(result?.success ? 0 : 1);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

runTest().catch(err => {
  console.error("💥 Fatal:", err instanceof Error ? err.message : err);
  process.exit(2);
});
