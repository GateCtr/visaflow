/**
 * Reverse engineering citaconsular.es — Phase 3 : Session cookie extraction.
 *
 * Résultat Phase 2 :
 *   - app.bookitit.com/onlinebookings/ renvoie HTML (pas JSONP) sans session
 *   - Le serveur Bookitit valide une session côté serveur (cookies PHP/CodeIgniter)
 *   - La vraie bookititBase URL est injectée par citaconsular.es (pas toujours app.bookitit.com)
 *
 * Objectif Phase 3 :
 *   1. Playwright passe Cloudflare + charge le widget
 *   2. Intercepte la vraie bookititBase URL depuis les requêtes réseau
 *   3. Extrait les cookies de session Bookitit (PHPSESSID ou ci_session)
 *   4. Extrait bkt_init_widget + oClientValues depuis window globals
 *   5. Rejoue les JSONP endpoints en pur undici avec ces cookies
 *   6. Si ça marche → scan créneaux sans relancer le browser
 *
 * Usage : npx tsx src/reverse-spain.ts
 */
import { chromium as baseChromium } from "playwright";
import { addExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import { ProxyAgent } from "undici";

const playwrightChromium = addExtra(baseChromium);
playwrightChromium.use(StealthPlugin());

const WIDGET_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const proxy = process.env.IPROYAL_PROXY_URL;

function sep(title: string): void {
  console.log("\n" + "─".repeat(60));
  console.log(" " + title);
  console.log("─".repeat(60));
}

async function jsonpWithCookies(
  url: string,
  cookieHeader: string,
  referer: string,
): Promise<{ status: number; body: string; parsed: unknown | null }> {
  const cb = `cb${Date.now()}${Math.floor(Math.random() * 9999)}`;
  const full = url.includes("?")
    ? `${url}&callback=${cb}&_=${Date.now()}`
    : `${url}?callback=${cb}&_=${Date.now()}`;

  const agent = proxy ? new ProxyAgent(proxy) : undefined;
  const res = await fetch(full, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "es-ES,es;q=0.9",
      "Referer": referer,
      "Origin": "https://www.citaconsular.es",
      "Cookie": cookieHeader,
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(15_000),
    dispatcher: agent,
  } as RequestInit & { dispatcher?: ProxyAgent });

  const body = await res.text();
  let parsed: unknown = null;
  try {
    const m = body.trim().match(/^[\w$.]+\(([\s\S]*)\);?$/);
    parsed = m ? JSON.parse(m[1]) : JSON.parse(body);
  } catch { /* not json */ }

  return { status: res.status, body: body.slice(0, 500), parsed };
}

function firstMonthDay(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function lastMonthDay(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}
function collectIds(value: unknown, re: RegExp): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v && typeof v === "object") { walk(v); continue; }
      if ((typeof v === "string" || typeof v === "number") && re.test(k)) out.add(String(v).trim());
    }
  };
  walk(value);
  return [...out];
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log(" REVERSE Phase 3 — Session cookie + API directe Bookitit");
  console.log("=".repeat(60));
  console.log("Proxy:", proxy ? "iProyal ✅" : "direct");

  // ── Phase A : Playwright — passer CF, charger widget, capturer session ──
  sep("A. Playwright — bypass CF + capture session");

  const browser = await playwrightChromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--disable-gpu"],
    proxy: proxy ? { server: proxy } : undefined,
  }) as unknown as Browser;

  const context: BrowserContext = await (browser as unknown as {
    newContext(opts: Record<string, unknown>): Promise<BrowserContext>
  }).newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    extraHTTPHeaders: { "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    ((window as unknown) as Record<string, unknown>).chrome = { runtime: {} };
  });

  const page: Page = await context.newPage();

  // Capturer toutes les URLs de requêtes réseau (pour trouver bookititBase)
  const capturedRequests: string[] = [];
  const bookititBases = new Set<string>();
  let allDatetimePayloads: unknown[] = [];

  page.on("request", req => capturedRequests.push(req.url()));
  page.on("response", async res => {
    const u = res.url();
    const m = u.match(/^(https?:\/\/[^/]+\/.*?onlinebookings\/)/i);
    if (m) bookititBases.add(m[1]);
    if (u.includes("datetime/")) {
      try {
        const txt = await res.text().catch(() => "");
        const match = txt.trim().match(/^[\w$.]+\(([\s\S]*)\);?$/);
        const parsed = match ? JSON.parse(match[1]) : JSON.parse(txt);
        allDatetimePayloads.push(parsed);
        console.log("[network] datetime/ payload capturé:", JSON.stringify(parsed).slice(0, 200));
      } catch { /* skip */ }
    }
  });

  page.on("dialog", async d => { await d.accept().catch(() => undefined); });

  console.log("  Navigation vers:", WIDGET_URL);
  try {
    await page.goto(WIDGET_URL, { waitUntil: "commit", timeout: 30_000 });
  } catch {
    console.warn("  goto 30s timeout — retry 45s");
    await page.goto(WIDGET_URL, { waitUntil: "commit", timeout: 45_000 });
  }

  // Attente CF
  let title = await page.title().catch(() => "");
  console.log("  Titre initial:", title);
  const CF_RE = /just a moment|un instant|un momento|verifying you are human/i;
  if (CF_RE.test(title)) {
    console.log("  Cloudflare détecté — attente 25s...");
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 3000));
      title = await page.title().catch(() => "");
      if (!CF_RE.test(title)) { console.log(`  CF résolu après ${(i+1)*3}s`); break; }
    }
  }

  console.log("  Titre final:", title);
  console.log("  URL finale:", page.url());

  // Clic Continuar
  const SELECTORS = ["#idBktDefaultContinueButton", "#idDivBktContinueButton", ".clsDivContinueButton"];
  for (const sel of SELECTORS) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) {
      console.log("  Clic Continuar:", sel);
      await el.click().catch(() => undefined);
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }

  // Attendre les JSONP
  await new Promise(r => setTimeout(r, 5000));

  // ── Phase B : Extraction session ──────────────────────────────────────
  sep("B. Extraction cookies + variables JS");

  const cookies = await context.cookies();
  console.log("  Cookies total:", cookies.length);
  const bktCookies = cookies.filter(c =>
    c.domain.includes("bookitit") ||
    c.domain.includes("citaconsular") ||
    c.name.toLowerCase().includes("sess") ||
    c.name.toLowerCase().includes("phpsess") ||
    c.name.toLowerCase().includes("ci_") ||
    c.name.toLowerCase().includes("bkt")
  );
  console.log("  Cookies pertinents:", bktCookies.map(c => `${c.name}=${c.value.slice(0, 20)}... (domain: ${c.domain})`));

  const cookieHeader = bktCookies.map(c => `${c.name}=${c.value}`).join("; ");
  const allCookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  // Variables JS globales
  const jsGlobals = await page.evaluate(() => {
    const w = (window as unknown) as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    // bkt_init_widget
    if (w.bkt_init_widget) result.bkt_init_widget = w.bkt_init_widget;

    // oClientValues_XXXX
    for (const key of Object.keys(w)) {
      if (key.startsWith("oClientValues_")) result[key] = w[key];
    }

    // Tenter d'accéder à Utils.get_server_url si disponible
    if (w.Utils && typeof (w.Utils as Record<string, unknown>).get_server_url === "function") {
      try {
        result.server_url_from_utils = ((w.Utils as Record<string, unknown>).get_server_url as () => string)();
      } catch { /* ignore */ }
    }

    // Chercher toute variable contenant onlinebookings dans les globals
    for (const key of Object.keys(w)) {
      const val = w[key];
      if (typeof val === "string" && val.includes("onlinebookings")) {
        result[`_found_${key}`] = val;
      }
    }

    return result;
  });

  console.log("  JS Globals:", JSON.stringify(jsGlobals).slice(0, 800));
  console.log("  bookititBases interceptées:", [...bookititBases]);
  console.log("  Requêtes réseau totales:", capturedRequests.length);
  console.log("  Requêtes Bookitit:", capturedRequests.filter(u => u.includes("bookitit") || u.includes("onlinebookings")).length);

  // URL finale de la page (peut contenir des indices sur le routage)
  const finalUrl = page.url();

  // ── Phase C : Test JSONP direct avec cookies Playwright ───────────────
  sep("C. Rejouer JSONP en undici avec cookies extraits");

  const bases = [...bookititBases];
  if (bases.length === 0) {
    console.log("  ⚠️  Aucune bookititBase interceptée en navigation.");
    console.log("  Tentative avec app.bookitit.com générique + tous les cookies...");
    bases.push("https://app.bookitit.com/onlinebookings/");
  }

  for (const base of bases) {
    console.log(`\n  Base: ${base}`);

    // getwidgetconfigurations
    const initResult = await jsonpWithCookies(
      `${base}getwidgetconfigurations/`,
      allCookieHeader,
      finalUrl,
    );
    console.log(`  getwidgetconfigurations → HTTP ${initResult.status}`);
    console.log("  Body:", initResult.body.slice(0, 300));

    let services: string[] = [];
    let agendas: string[] = [];
    let initParams: Record<string, string> = {};

    if (initResult.parsed && typeof initResult.parsed === "object") {
      console.log("  ✅ JSONP parsé !");
      const cfg = initResult.parsed as Record<string, unknown>;
      const toS = (v: unknown): string | undefined =>
        typeof v === "string" || typeof v === "number" ? String(v) : undefined;
      if (toS(cfg.widget_id)) initParams.widget_id = toS(cfg.widget_id)!;
      if (toS(cfg.account_id)) initParams.account_id = toS(cfg.account_id)!;
      console.log("  initParams:", initParams);

      // getservices
      const svcResult = await jsonpWithCookies(
        `${base}getservices/?${new URLSearchParams({ ...initParams, selectedPeople: "1" })}`,
        allCookieHeader,
        finalUrl,
      );
      console.log(`  getservices → HTTP ${svcResult.status}, parsé: ${svcResult.parsed !== null}`);
      if (svcResult.parsed) {
        services = collectIds(svcResult.parsed, /(service.*id|^id$)/i).slice(0, 5);
        console.log("  Services:", services);
      }

      // getagendas
      const agResult = await jsonpWithCookies(
        `${base}getagendas/?${new URLSearchParams({ ...initParams, services: services.join(","), selectedPeople: "1" })}`,
        allCookieHeader,
        finalUrl,
      );
      console.log(`  getagendas → HTTP ${agResult.status}, parsé: ${agResult.parsed !== null}`);
      if (agResult.parsed) {
        agendas = collectIds(agResult.parsed, /(agenda.*id|^id$)/i).slice(0, 5);
        console.log("  Agendas:", agendas);
      }

      // datetime scan
      const d = new Date();
      const dtResult = await jsonpWithCookies(
        `${base}datetime/?${new URLSearchParams({
          ...initParams,
          services: services.join(","),
          agendas: agendas.join(","),
          start: firstMonthDay(d),
          end: lastMonthDay(d),
          selectedPeople: "1",
        })}`,
        allCookieHeader,
        finalUrl,
      );
      console.log(`  datetime → HTTP ${dtResult.status}, parsé: ${dtResult.parsed !== null}`);
      console.log("  Body:", dtResult.body.slice(0, 400));
    } else {
      console.log("  ❌ JSONP non parsé — HTML response ou erreur");
      console.log("  → Le serveur Bookitit rejette sans session browser valide");
    }
  }

  // ── Phase D : Vérifier si page.context().request fonctionne (approach actuelle) ──
  sep("D. Confirmation — page.context().request (approche actuelle)");
  if (bases.length > 0 && !bases[0].includes("app.bookitit")) {
    const base = bases[0];
    const req = page.context().request;
    try {
      const cb = `cb${Date.now()}`;
      const res = await req.get(`${base}getwidgetconfigurations/?callback=${cb}&_=${Date.now()}`, {
        timeout: 15_000,
      });
      const text = await res.text();
      const m = text.trim().match(/^[\w$.]+\(([\s\S]*)\);?$/);
      const parsed = m ? JSON.parse(m[1]) : null;
      console.log(`  HTTP: ${res.status()}`);
      console.log("  Parsé :", parsed !== null ? "✅ OUI" : "❌ NON");
      console.log("  Body  :", text.slice(0, 300));
    } catch (e) {
      console.log("  Erreur:", e instanceof Error ? e.message : e);
    }
  } else {
    console.log("  Skipped — base URL non connue ou générique");
  }

  await browser.close();

  // ── Synthèse ───────────────────────────────────────────────────────────
  sep("SYNTHÈSE ARCHITECTURE");
  console.log(`
  Bloqueurs identifiés :
  1. Cloudflare Turnstile sur citaconsular.es → Playwright OBLIGATOIRE (phase initiale)
  2. Bookitit valide la session PHP côté serveur → cookies requis pour JSONP direct
  3. bookititBase URL injectée dynamiquement par citaconsular.es dans le DOM

  Architecture optimale (hybride) :
  ┌──────────────────────────────────────────────────────────────┐
  │  PHASE 1 — Playwright (1x au démarrage ou si session morte)  │
  │    → passe Cloudflare Turnstile                              │
  │    → charge widget → capture bookititBase + cookies session  │
  │    → extrait bkt_init_widget + oClientValues (JS globals)    │
  └──────────────────────┬───────────────────────────────────────┘
                         │ cookies + base URL mis en cache
  ┌──────────────────────▼───────────────────────────────────────┐
  │  PHASE 2 — undici HTTP pur (polling toutes les N minutes)    │
  │    → getwidgetconfigurations/ via JSONP + cookies            │
  │    → getservices/ + getagendas/                              │
  │    → datetime/ (scan 9 mois)                                 │
  │    → 0 browser, ~50ms par appel, pas de Playwright overhead  │
  └──────────────────────────────────────────────────────────────┘
  Si session expirée (HTTP non-JSONP) → relancer Phase 1
  Si créneau trouvé → booking via Playwright (Phase 1 avec selecttime/#hash)

  Gain estimé :
  - Probe actuelle : ~5-15s (Playwright complet)
  - Probe optimisée : ~200ms (undici JSONP)
  - Session Bookitit TTL : ~30 min (PHPSESSID standard PHP)
  - Playwright relancé seulement 1x/30min au lieu de chaque probe
  `);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
