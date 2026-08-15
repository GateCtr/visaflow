/**
 * spain-session-bootstrap.ts — Bootstrap hybride session Espagne
 *
 * Architecture :
 *   Phase 1 (Browser — lourd, une seule fois) :
 *     1. Puppeteer + stealth lance le portail citaconsular.es
 *     2. cf-challenge-solver résout le challenge CF nativement (Turnstile/JSD)
 *     3. Le handler dialog accepte automatiquement l'alerte Bienvenido
 *     4. Le solver clique "Continuar" (token gate Bookitit) → /main/ charge naturellement
 *     5. La session PHP est désormais initialisée côté serveur
 *     6. On extrait cookies + UA + proxy → SpainBootstrapContext
 *     7. Browser fermé.
 *
 *   Phase 2 (impit — léger, scanning/booking) :
 *     - Hérite du contexte complet : cf_clearance + PHPSESSID + UA + sec-ch-ua + même proxy IP
 *     - impit reproduit le fingerprint TLS Chrome (JA3/JA4) → CF laisse passer
 *     - getservices/, getagendas/, datetime/ fonctionnent sans browser overhead
 *
 * Pourquoi ça marche :
 *   - cf_clearance est lié à l'IP proxy ET au fingerprint TLS
 *   - impit { browser: "chrome" } reproduit exactement le TLS Chrome → CF accepte
 *   - PHPSESSID déjà initialisé par le POST Continuar → getservices/ répond (pas 0B)
 *   - Même proxy IP entre browser et impit → cf_clearance reste valide
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Impit } from "impit";
import type { Browser, Page } from "puppeteer";

import {
  solveCfChallenge,
  preparePageStealth,
  detectChallengeType,
  type CfSolveResult,
} from "../cf-challenge-solver.js";
import {
  setCevExternalUserAgent,
  getCevBrowserHeaders,
  getProxyImpit,
} from "../cev-shared-impit.js";

puppeteer.use(StealthPlugin());

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpainBootstrapContext {
  /** Tous les cookies extraits du browser, dans l'ordre Chrome */
  cookies: Array<{ name: string; value: string }>;

  /** Valeur du cookie cf_clearance (vide si absent — IP trusted) */
  cfClearance: string;

  /** Valeur du PHPSESSID (initialisé par le POST Continuar) */
  phpSessId: string;

  /** URL proxy identique à celle utilisée par le browser → cf_clearance reste valide */
  proxyUrl: string;

  /** User-Agent exact du browser Puppeteer */
  userAgent: string;

  /** sec-ch-ua dérivé du UA (ex: "Not/A)Brand";v="99", "Chromium";v="149", ...) */
  secChUa: string;

  /** sec-ch-ua-mobile : toujours "?0" (Windows) */
  secChUaMobile: string;

  /** sec-ch-ua-platform : toujours "\"Windows\"" */
  secChUaPlatform: string;

  /** HTML de /main/ capturé pendant le bootstrap (128KB) — peut être vide */
  prefetchedMainHtml: string;

  /** Timestamp de création */
  bootstrappedAt: number;

  /** Expiration : bootstrappedAt + 115 min (TTL cf_clearance) */
  expiresAt: number;

  /** Type de challenge CF rencontré */
  challengeType: string;

  /** Méthode de résolution utilisée */
  solvedBy: string;
}

export interface BootstrapOptions {
  /** Puppeteer headless (défaut: true) */
  headless?: boolean;

  /** Timeout global solve CF en ms (défaut: 120_000) */
  solveTimeout?: number;

  /** Timeout attente Continuar en ms (défaut: 30_000) */
  continuarTimeout?: number;

  /** Timeout attente /main/ en ms (défaut: 30_000) */
  mainTimeout?: number;
}

// ─── Proxy CSV loader ─────────────────────────────────────────────────────────

export function loadProxyCsvFirst(): string {
  // IP ISP dédiée Espagne — priorité absolue (fixe, non-rotative)
  if (process.env.SPAIN_ISP_PROXY_URL?.trim()) {
    return process.env.SPAIN_ISP_PROXY_URL.trim();
  }

  const csv = resolve(process.cwd(), "decodo-proxies.csv");
  if (!existsSync(csv)) return process.env.DECODO_PROXY_URL?.trim() ?? "";

  const lines = readFileSync(csv, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (!lines.length) return process.env.DECODO_PROXY_URL?.trim() ?? "";

  // Format CSV: host:port:user:pass
  const [host, port, user, ...passParts] = lines[0].split(":");
  const pass = passParts.join(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

// ─── UA → sec-ch-ua ───────────────────────────────────────────────────────────

function deriveSecChUa(ua: string): { secChUa: string; secChUaMobile: string; secChUaPlatform: string } {
  const major = ua.match(/Chrome\/(\d+)/)?.[1] ?? "149";
  return {
    secChUa: `"Not/A)Brand";v="99", "Chromium";v="${major}", "Google Chrome";v="${major}"`,
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"',
  };
}

// ─── buildCookieString ────────────────────────────────────────────────────────

/**
 * Reconstruit la chaîne Cookie: dans l'ordre exact Chrome (GA* en premier,
 * cf_clearance en dernier, PHPSESSID avant cf_clearance).
 */
export function buildCookieString(ctx: SpainBootstrapContext): string {
  const order = ["_ga", "_ga_F3TYSDL945", "PHPSESSID", "cf_clearance", "cf_chl_rc_ni"];
  const map = new Map(ctx.cookies.map((c) => [c.name, c.value]));

  const parts: string[] = [];
  // Ordered first
  for (const name of order) {
    if (map.has(name)) parts.push(`${name}=${map.get(name)!}`);
  }
  // Remaining cookies not in the ordered list
  for (const c of ctx.cookies) {
    if (!order.includes(c.name)) parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

// ─── createImpitFromContext ───────────────────────────────────────────────────

/**
 * Crée une instance impit unique héritant du contexte browser.
 * Utilise le MÊME proxy URL → cf_clearance reste valide.
 * browser: "chrome" → fingerprint TLS Chrome (JA3/JA4) → CF laisse passer.
 */
export function createImpitFromContext(ctx: SpainBootstrapContext): InstanceType<typeof Impit> {
  // Aligner le UA CEV sur celui du browser pour les headers sec-ch-ua
  setCevExternalUserAgent(ctx.userAgent);
  return getProxyImpit(ctx.proxyUrl || undefined);
}

/**
 * Construit les headers JSONP Bookitit alignés sur Chrome (ordre exact réseau).
 */
export function buildBookititJsonpHeaders(
  ctx: SpainBootstrapContext,
  referer: string,
): Record<string, string> {
  const cookie = buildCookieString(ctx);
  return getCevBrowserHeaders({
    referer,
    cookie,
    userAgent: ctx.userAgent,
    xRequestedWith: true,
    accept:
      "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
  });
}

// ─── Continuar button click ───────────────────────────────────────────────────

/**
 * Attend et clique le bouton "Continuar" dans la page Bookitit token-gate.
 *
 * Stratégie (dans l'ordre, sans vérification offsetParent — headless unreliable) :
 *   1. Soumettre le form contenant input[name="token"] (la vraie token gate Bookitit)
 *   2. Cliquer input[type=submit] ou button[type=submit]
 *   3. Cliquer tout bouton dont le texte/value contient "continuar|aceptar|continue"
 *   4. Soumettre n'importe quel form en fallback
 *
 * Retourne { clicked: boolean, method: string }.
 */
async function clickContinuar(
  page: Page,
  timeoutMs: number,
): Promise<{ clicked: boolean; method: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // Vérifier que CF challenge est terminé (titre ne contient plus "moment")
      const title = await page.title().catch(() => "");
      if (title.toLowerCase().includes("moment")) {
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }

      const result = await page.evaluate((): { ok: boolean; method: string } => {
        // ── Stratégie 1 : form contenant input[name="token"] (token gate Bookitit) ──
        const tokenInput = document.querySelector('input[name="token"]') as HTMLInputElement | null;
        if (tokenInput) {
          const form = (tokenInput as any).form || tokenInput.closest("form");
          if (form) {
            (form as HTMLFormElement).submit();
            return { ok: true, method: "form.submit(token gate)" };
          }
        }

        // ── Stratégie 2 : input[type=submit] ou button[type=submit] ──────────────
        const submitEls = Array.from(
          document.querySelectorAll<HTMLElement>('input[type="submit"], button[type="submit"]'),
        );
        if (submitEls.length > 0) {
          (submitEls[0] as any).click();
          return { ok: true, method: `submit button (${submitEls[0].tagName})` };
        }

        // ── Stratégie 3 : bouton avec texte continuar/aceptar/continue ───────────
        const allBtns = Array.from(document.querySelectorAll<HTMLElement>("button, input[type=button]"));
        for (const btn of allBtns) {
          const text = ((btn as any).value ?? btn.textContent ?? "").toLowerCase();
          if (/continuar|aceptar|continue|suivant|start/.test(text)) {
            btn.click();
            return { ok: true, method: `button text match: "${text.trim().slice(0, 20)}"` };
          }
        }

        // ── Stratégie 4 : soumettre n'importe quel form (fallback) ──────────────
        const anyForm = document.querySelector("form") as HTMLFormElement | null;
        if (anyForm) {
          anyForm.submit();
          return { ok: true, method: "form.submit() fallback" };
        }

        // ── Diagnostic : lister ce qu'on voit ────────────────────────────────────
        const bodySnippet = document.body?.innerHTML?.slice(0, 300) ?? "";
        return { ok: false, method: `aucun bouton trouvé | body: ${bodySnippet}` };
      });

      if (result.ok) return { clicked: true, method: result.method };

      // Log le diagnostic toutes les 5s
      if ((Date.now() % 5_000) < 1_000) {
        console.warn(`[spain-bootstrap] ⚠️ Continuar pas encore trouvé: ${result.method.slice(0, 100)}`);
      }
    } catch {
      // Non-fatal
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { clicked: false, method: "timeout" };
}

// ─── Main bootstrap ───────────────────────────────────────────────────────────

/**
 * Lance le bootstrap hybride complet.
 *
 * @param portalUrl  URL complète du portail citaconsular.es (widget URL)
 * @param proxyUrl   URL proxy au format http://user:pass@host:port
 *                   Si vide → charge depuis decodo-proxies.csv
 * @param opts       Options avancées
 */
export async function bootstrapSpainSession(
  portalUrl: string,
  proxyUrl?: string,
  opts: BootstrapOptions = {},
): Promise<SpainBootstrapContext> {
  const {
    headless = true,
    solveTimeout = 120_000,
    continuarTimeout = 40_000,
    mainTimeout = 35_000,
  } = opts;

  const effectiveProxy = proxyUrl?.trim() || loadProxyCsvFirst();
  const TAG = "[spain-bootstrap]";

  // UA identique au diag (Chrome 149 Windows)
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

  // ── Parse proxy pour Puppeteer ──────────────────────────────────────────────
  let proxyServer: string | undefined;
  let proxyAuth: { username: string; password: string } | undefined;
  if (effectiveProxy) {
    try {
      const parsed = new URL(effectiveProxy);
      proxyServer = `http://${parsed.hostname}:${parsed.port || "10001"}`;
      proxyAuth = {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      };
    } catch {
      console.warn(`${TAG} ⚠️ URL proxy invalide — sans proxy`);
    }
  }

  // ── Dossier debug ───────────────────────────────────────────────────────────
  mkdirSync("debug_dumps", { recursive: true });

  // ── Launch Puppeteer ─────────────────────────────────────────────────────────
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,720",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-webgl",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-v8-code-cache",
    "--disable-crash-reporter",
  ];
  if (proxyServer) launchArgs.push(`--proxy-server=${proxyServer}`);

  console.log(`${TAG} 🚀 Lancement Puppeteer (proxy: ${proxyServer ?? "aucun"})…`);
  const browser: Browser = await (puppeteer as any).launch({
    headless,
    args: launchArgs,
    defaultViewport: { width: 1280, height: 720 },
  });

  let solveResult: CfSolveResult | null = null;
  let prefetchedMainHtml = "";
  let allCookies: Array<{ name: string; value: string }> = [];

  try {
    const pages = await browser.pages();
    const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();

    // ── Auth proxy + UA + stealth ──────────────────────────────────────────────
    if (proxyAuth) await page.authenticate(proxyAuth);
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await preparePageStealth(page, UA);

    // ── Handler dialog Bienvenido (auto-accept) ────────────────────────────────
    page.on("dialog", async (dialog) => {
      console.log(`${TAG} 💬 Dialog: "${dialog.message().slice(0, 60)}" → accept`);
      await dialog.accept().catch(() => {});
    });

    // ── Intercepter /main/ pour le prefetch ────────────────────────────────────
    let mainResolve: (() => void) | null = null;
    const mainSignal = new Promise<void>((r) => { mainResolve = r; });

    page.on("response", async (response) => {
      try {
        const url = response.url();
        if (url.includes("/onlinebookings/main/") && response.status() === 200) {
          const text = await response.text().catch(() => "");
          if (text.length > 10_000) {
            prefetchedMainHtml = text;
            console.log(`${TAG} 📦 /main/ intercepté : ${text.length}B`);
            mainResolve?.();
          }
        }
      } catch { /* non-fatal */ }
    });

    // ── Navigation initiale ────────────────────────────────────────────────────
    console.log(`${TAG} 🌐 Navigation → ${portalUrl.slice(0, 80)}…`);
    const navT0 = Date.now();
    try {
      await page.goto(
        `${portalUrl}${portalUrl.includes("?") ? "&" : "?"}_cb=${Date.now()}`,
        { waitUntil: "domcontentloaded", timeout: 70_000 },
      );
    } catch (e: any) {
      console.warn(`${TAG} ⚠️ Navigation timeout (non-fatal): ${e.message?.slice(0, 80)}`);
    }

    const navTitle = await page.title().catch(() => "?");
    console.log(`${TAG} 📄 Chargé en ${Date.now() - navT0}ms — titre: "${navTitle}"`);

    const challengeType = await detectChallengeType(page);
    console.log(`${TAG} 🏷️  Type CF: ${challengeType}`);

    // ── Phase 1 : Résolution CF ────────────────────────────────────────────────
    console.log(`${TAG} 🔐 Résolution CF (max ${solveTimeout / 1000}s)…`);
    solveResult = await solveCfChallenge(page, {
      targetUrl: portalUrl,
      timeout: solveTimeout,
      enableCapsolverFallback: false, // Natif uniquement
      maxTurnstileClicks: 5,
      clickRetryDelay: 3_000,
    });

    if (!solveResult.success) {
      throw new Error(`CF solve échoué: ${solveResult.error}`);
    }

    console.log(`${TAG} ✅ CF résolu en ${Math.round(solveResult.durationMs / 1000)}s via ${solveResult.solvedBy}`);
    console.log(`${TAG} 🍪 cf_clearance: ${(solveResult.cfClearance ?? "absent").slice(0, 30)}…`);

    // ── Phase 2 : Cliquer Continuar (token gate Bookitit) ─────────────────────
    // Après le solve, la page montre la "token gate" Bookitit avec un bouton Continuar.
    // Ce clic POST le token → initialise la session PHP → widget JS charge /main/
    console.log(`${TAG} 🖱️  Attente + clic Continuar (max ${continuarTimeout / 1000}s)…`);

    // Screenshot pré-Continuar pour diagnostic
    await page.screenshot({ path: "debug_dumps/spain-bootstrap-pre-continuar.png", fullPage: false }).catch(() => {});
    const preTitle = await page.title().catch(() => "?");
    const preUrl   = page.url();
    console.log(`${TAG} 📄 Post-CF : titre="${preTitle}" url=${preUrl.slice(0, 80)}`);

    // Courte pause pour laisser la page post-CF se stabiliser
    await new Promise((r) => setTimeout(r, 2_500));

    const { clicked: continuarClicked, method: continuarMethod } = await clickContinuar(page, continuarTimeout);
    if (continuarClicked) {
      console.log(`${TAG} ✅ Continuar cliqué (${continuarMethod}) — attente /main/ (max ${mainTimeout / 1000}s)…`);
    } else {
      console.warn(`${TAG} ⚠️ Continuar introuvable (${continuarMethod}) — /main/ peut avoir déjà chargé via JSD auto`);
    }

    // ── Phase 3 : Attendre /main/ ──────────────────────────────────────────────
    await Promise.race([
      mainSignal,
      new Promise<void>((r) => setTimeout(r, mainTimeout)),
    ]);

    if (prefetchedMainHtml.length > 0) {
      console.log(`${TAG} ✅ /main/ capturé (${prefetchedMainHtml.length}B)`);
      const noHoras = /no hay horas disponibles/i.test(prefetchedMainHtml);
      console.log(`${TAG} 📊 Signal "No hay horas": ${noHoras ? "✅" : "❌ (créneaux possibles?)"}`);
    } else {
      console.warn(`${TAG} ⚠️ /main/ non intercepté dans le délai — cookies quand même exportés`);
    }

    // ── Extraction des cookies ─────────────────────────────────────────────────
    const rawCookies = await page.cookies("https://www.citaconsular.es").catch(() => [] as any[]);
    allCookies = rawCookies.map((c: any) => ({ name: c.name, value: c.value }));

    // Snapshot screenshot
    const ss = `debug_dumps/spain-bootstrap-${Date.now()}.png`;
    await page.screenshot({ path: ss, fullPage: false }).catch(() => {});
    console.log(`${TAG} 📸 Screenshot: ${ss}`);

    console.log(`${TAG} 🍪 Cookies exportés (${allCookies.length}): ${allCookies.map((c) => c.name).join(", ")}`);

  } finally {
    await browser.close().catch(() => {});
    console.log(`${TAG} 🔋 Browser fermé`);
  }

  // ── Construction du contexte ───────────────────────────────────────────────
  const cfClearance = solveResult?.cfClearance ?? "";
  const phpSessId = allCookies.find((c) => c.name === "PHPSESSID")?.value ?? "";
  const { secChUa, secChUaMobile, secChUaPlatform } = deriveSecChUa(UA);
  const now = Date.now();

  const ctx: SpainBootstrapContext = {
    cookies: allCookies,
    cfClearance,
    phpSessId,
    proxyUrl: effectiveProxy,
    userAgent: UA,
    secChUa,
    secChUaMobile,
    secChUaPlatform,
    prefetchedMainHtml,
    bootstrappedAt: now,
    expiresAt: now + 115 * 60 * 1000, // 115 min (TTL cf_clearance)
    challengeType: solveResult?.challengeType ?? "unknown",
    solvedBy: solveResult?.solvedBy ?? "none",
  };

  return ctx;
}

/**
 * Retourne true si le contexte est encore valide (cf_clearance non expiré).
 */
export function isBootstrapContextValid(ctx: SpainBootstrapContext): boolean {
  return Date.now() < ctx.expiresAt && !!ctx.cfClearance;
}

/**
 * Appelle un endpoint JSONP Bookitit via impit + contexte hérité du browser.
 * Retourne le body brut de la réponse (à parser en JSONP côté appelant).
 */
export async function callBookititEndpoint(
  ctx: SpainBootstrapContext,
  baseUrl: string,
  endpoint: string,
  params: Record<string, string>,
  referer: string,
): Promise<{ status: number; body: string }> {
  const impit = createImpitFromContext(ctx);
  const headers = buildBookititJsonpHeaders(ctx, referer);

  const url = new URL(`${baseUrl}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await impit.fetch(url.toString(), { method: "GET", headers } as any);
  const body = await res.text();
  return { status: res.status, body };
}
