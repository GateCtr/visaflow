/**
 * spain-hybrid-session.ts — Session hybride Espagne (CF solve + page.evaluate fetch)
 *
 * Architecture validée par tests :
 *   ❌ impit → CF détecte la signature TLS/HTTP2 même IP dédiée → 0B
 *   ✅ page.evaluate(fetch) → Chrome réel → getservices/ 852B, /main/ 128KB
 *
 * Flow :
 *   1. Puppeteer + cf-challenge-solver → résout CF (Turnstile/JSD) sur IP ISP dédiée
 *   2. Bienvenido dialog auto-accepté
 *   3. Continuar form.submit() → PHPSESSID Bookitit initialisé côté serveur
 *   4. /main/ intercepté (128KB) — première réponse scan disponible
 *   5. Browser reste ouvert en arrière-plan
 *   6. Toutes les requêtes suivantes via page.evaluate(fetch(...)) :
 *      - Même connexion TCP → même TLS session → CF accepte
 *      - /main/ scan : ~400ms par appel
 *      - getservices/ getagendas/ datetime/ : identique
 *   7. Session valide ~115min (TTL cf_clearance) → renewSession() si besoin
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";

import {
  solveCfChallenge,
  preparePageStealth,
  detectChallengeType,
} from "../cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpainScanResult {
  status: number;
  body: string;
  bodyLength: number;
  hasSlots: boolean;        // false si "No hay horas disponibles" détecté
  durationMs: number;
}

export interface SpainServiceResult {
  id: string;
  name: string;
}

export interface SpainAgendaResult {
  id: string;
  name: string;
}

export interface HybridSessionConfig {
  portalUrl: string;
  widgetKey: string;
  proxyUrl?: string;        // Si absent → charge SPAIN_ISP_PROXY_URL ou CSV
  headless?: boolean;
  solveTimeout?: number;
  lang?: "es" | "pt" | "en" | "fr";
}

// ─── Proxy loader ──────────────────────────────────────────────────────────────

export function resolveSpainProxy(override?: string): string {
  if (override?.trim()) return override.trim();
  if (process.env.SPAIN_ISP_PROXY_URL?.trim()) return process.env.SPAIN_ISP_PROXY_URL.trim();
  const csv = resolve(process.cwd(), "decodo-proxies.csv");
  if (!existsSync(csv)) return process.env.DECODO_PROXY_URL?.trim() ?? "";
  const lines = readFileSync(csv, "utf-8").split("\n")
    .map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!lines.length) return process.env.DECODO_PROXY_URL?.trim() ?? "";
  const [host, port, user, ...pp] = lines[0].split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pp.join(":"))}@${host}:${port}`;
}

// ─── JSONP parser ──────────────────────────────────────────────────────────────

function parseJsonp(body: string): any {
  const m = body.match(/^(?:callback=)?[a-zA-Z0-9_$.]+\((.*)\);?$/s);
  if (m?.[1]) { try { return JSON.parse(m[1]); } catch { /* fall */ } }
  try { return JSON.parse(body); } catch { return null; }
}

// ─── SpainHybridSession ────────────────────────────────────────────────────────

/**
 * Session Espagne hybride — CF solve natif + HTTP via Chrome page.evaluate(fetch).
 *
 * Usage :
 *   const session = await SpainHybridSession.create({ portalUrl, widgetKey });
 *   const scan = await session.scanMain();            // /main/ 128KB
 *   const svc  = await session.getServices();         // getservices/ JSONP
 *   await session.close();
 */
export class SpainHybridSession {
  private browser: Browser;
  private page: Page;
  private config: Required<HybridSessionConfig>;
  private proxyUrl: string;
  private ua: string;
  private createdAt: number;
  private _prefetchedMainHtml: string;

  private constructor(
    browser: Browser,
    page: Page,
    config: Required<HybridSessionConfig>,
    proxyUrl: string,
    ua: string,
    prefetchedMainHtml: string,
  ) {
    this.browser = browser;
    this.page = page;
    this.config = config;
    this.proxyUrl = proxyUrl;
    this.ua = ua;
    this.createdAt = Date.now();
    this._prefetchedMainHtml = prefetchedMainHtml;
  }

  // ── Factory ─────────────────────────────────────────────────────────────────

  static async create(cfg: HybridSessionConfig): Promise<SpainHybridSession> {
    const config: Required<HybridSessionConfig> = {
      headless:     true,
      solveTimeout: 120_000,
      lang:         "es",
      proxyUrl:     "",
      ...cfg,
    };

    const TAG = "[spain-hybrid]";
    const proxyUrl = resolveSpainProxy(config.proxyUrl);
    mkdirSync("debug_dumps", { recursive: true });

    // UA Chrome 149 Windows (identique à diag + solver)
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

    // Parse proxy pour Puppeteer --proxy-server
    let proxyServer: string | undefined;
    let proxyAuth: { username: string; password: string } | undefined;
    if (proxyUrl) {
      try {
        const p = new URL(proxyUrl);
        proxyServer = `http://${p.hostname}:${p.port || "10001"}`;
        proxyAuth = { username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) };
      } catch { /* ignore */ }
    }

    console.log(`${TAG} 🚀 Lancement Puppeteer — proxy: ${proxyServer ?? "aucun"}`);
    const browser: Browser = await (puppeteer as any).launch({
      headless: config.headless,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,720",
        "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
        "--no-first-run", "--no-default-browser-check",
        "--disable-v8-code-cache", "--disable-crash-reporter",
        ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
      ],
      defaultViewport: { width: 1280, height: 720 },
    });

    const pages = await browser.pages();
    const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();

    if (proxyAuth) await page.authenticate(proxyAuth);
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await preparePageStealth(page, UA);

    // ── Dialog handler (Bienvenido alert) ──────────────────────────────────────
    page.on("dialog", async d => {
      console.log(`${TAG} 💬 Dialog: "${d.message().slice(0, 60)}" → accept`);
      await d.accept().catch(() => {});
    });

    // ── Intercepter /main/ ────────────────────────────────────────────────────
    let prefetchedMainHtml = "";
    let mainResolve: (() => void) | null = null;
    const mainSignal = new Promise<void>(r => { mainResolve = r; });

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

    // ── Navigation + CF solve ─────────────────────────────────────────────────
    console.log(`${TAG} 🌐 Navigation → ${config.portalUrl.slice(0, 80)}…`);
    try {
      await page.goto(
        `${config.portalUrl}${config.portalUrl.includes("?") ? "&" : "?"}_cb=${Date.now()}`,
        { waitUntil: "domcontentloaded", timeout: 70_000 },
      );
    } catch { /* timeout non-fatal */ }

    const challengeType = await detectChallengeType(page);
    console.log(`${TAG} 🏷️  CF type: ${challengeType}`);

    const solveResult = await solveCfChallenge(page, {
      targetUrl: config.portalUrl,
      timeout: config.solveTimeout,
      enableCapsolverFallback: false,
    });

    if (!solveResult.success) {
      await browser.close().catch(() => {});
      throw new Error(`CF solve échoué: ${solveResult.error}`);
    }

    console.log(`${TAG} ✅ CF résolu en ${Math.round(solveResult.durationMs / 1000)}s via ${solveResult.solvedBy}`);

    // ── Clic Continuar ────────────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 2_500));
    console.log(`${TAG} 🖱️  Clic Continuar…`);

    const clicked = await page.evaluate((): { ok: boolean; info: string } => {
      const tokenInput = document.querySelector('input[name="token"]') as HTMLInputElement | null;
      if (tokenInput) {
        const form = (tokenInput as any).form || tokenInput.closest("form");
        if (form) { (form as HTMLFormElement).submit(); return { ok: true, info: "form.submit(token)" }; }
      }
      const submitEl = document.querySelector<HTMLElement>('input[type="submit"], button[type="submit"]');
      if (submitEl) { submitEl.click(); return { ok: true, info: submitEl.tagName }; }
      const anyForm = document.querySelector("form");
      if (anyForm) { anyForm.submit(); return { ok: true, info: "anyForm" }; }
      return { ok: false, info: document.body?.innerText?.slice(0, 100) ?? "" };
    });

    if (clicked.ok) {
      console.log(`${TAG} ✅ Continuar cliqué (${clicked.info}) — attente /main/…`);
      await Promise.race([mainSignal, new Promise<void>(r => setTimeout(r, 35_000))]);
    } else {
      console.warn(`${TAG} ⚠️ Continuar non trouvé: ${clicked.info.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, 5_000));
    }

    if (prefetchedMainHtml.length > 0) {
      console.log(`${TAG} ✅ /main/ capturé (${prefetchedMainHtml.length}B)`);
    } else {
      console.warn(`${TAG} ⚠️ /main/ non capturé — session peut quand même être active`);
    }

    // Laisser le widget JS terminer son initialisation avant les fetches manuels
    await new Promise(r => setTimeout(r, 3_000));

    // Diagnostic : URL actuelle de la page + cookies disponibles
    const currentUrl = page.url();
    const allCookies = await page.cookies().catch(() => []);
    console.log(`${TAG} 📍 Page URL: ${currentUrl.slice(0, 100)}`);
    console.log(`${TAG} 🍪 Cookies (${allCookies.length}): ${allCookies.map(c => c.name).join(", ")}`);

    // Vérifier que fetch fonctionne depuis le contexte de la page
    const fetchCheck = await page.evaluate(async () => {
      try {
        const r = await fetch("https://www.citaconsular.es/favicon.ico", { credentials: "include" });
        const body = await r.text();
        return { ok: true, status: r.status, bodyLen: body.length };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }).catch(e => ({ ok: false, error: e.message }));
    console.log(`${TAG} 🔬 Fetch sanity check: ${JSON.stringify(fetchCheck)}`);

    // Test getservices/ direct depuis la page
    const gsUrl = `https://www.citaconsular.es/onlinebookings/getservices/?callback=test_cb&type=default&publickey=${config.widgetKey}&lang=${config.lang}&version=4&src=${encodeURIComponent(config.portalUrl)}&srvsrc=https%3A%2F%2Fwww.citaconsular.es&_=${Date.now()}`;
    const gsCheck = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          credentials: "include",
          headers: {
            "Accept": "text/javascript, application/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
          },
        });
        const body = await r.text();
        const ct = r.headers.get("content-type") ?? "?";
        return { status: r.status, bodyLen: body.length, ct, preview: body.slice(0, 100) };
      } catch (e: any) {
        return { status: 0, bodyLen: 0, ct: "?", preview: `ERROR: ${e.message}` };
      }
    }, gsUrl).catch(e => ({ status: 0, bodyLen: 0, ct: "?", preview: `EVAL_ERROR: ${e.message}` }));
    console.log(`${TAG} 🧪 getservices/ test: ${JSON.stringify(gsCheck)}`);

    return new SpainHybridSession(browser, page, config, proxyUrl, UA, prefetchedMainHtml);
  }

  // ── État ─────────────────────────────────────────────────────────────────────

  get prefetchedMainHtml(): string { return this._prefetchedMainHtml; }
  get aliveMs(): number { return Date.now() - this.createdAt; }
  get isExpired(): boolean { return this.aliveMs > 115 * 60_000; } // 115 min

  // ── Page.evaluate(fetch) — cœur de l'architecture ─────────────────────────

  /**
   * Exécute un fetch depuis la page Chrome déjà chargée.
   * Utilise le même TCP + TLS + HTTP2 que Chrome → CF accepte.
   */
  private async chromeFetch(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: string }> {
    return await this.page.evaluate(
      async (url, opts) => {
        try {
          const r = await fetch(url, {
            method: opts.method ?? "GET",
            headers: opts.headers ?? {},
            body: opts.body,
            credentials: "include",   // Envoyer les cookies du browser automatiquement
          });
          const body = await r.text();
          return { status: r.status, body };
        } catch (e: any) {
          return { status: 0, body: `fetch error: ${e.message}` };
        }
      },
      url, opts,
    );
  }

  // ── API publique ──────────────────────────────────────────────────────────────

  /**
   * Scan /main/ JSONP — détecte "No hay horas disponibles".
   * ~400ms par appel.
   */
  async scanMain(): Promise<SpainScanResult> {
    if (this._prefetchedMainHtml && this.aliveMs < 5_000) {
      // Utiliser le prefetch si très récent (< 5s)
      return {
        status: 200,
        body: this._prefetchedMainHtml,
        bodyLength: this._prefetchedMainHtml.length,
        hasSlots: !/no hay horas disponibles/i.test(this._prefetchedMainHtml),
        durationMs: 0,
      };
    }

    const cbName = `jsonp_${Date.now()}`;
    const url = this._buildUrl("main/", { callback: cbName });
    const t0 = Date.now();

    const { status, body } = await this.chromeFetch(url, {
      headers: this._jsonpHeaders(),
    });

    return {
      status,
      body,
      bodyLength: body.length,
      hasSlots: body.length > 100 && !/no hay horas disponibles/i.test(body),
      durationMs: Date.now() - t0,
    };
  }

  /** getservices/ JSONP → liste des services */
  async getServices(): Promise<SpainServiceResult[]> {
    const cbName = `jsonp_${Date.now()}`;
    const url = this._buildUrl("getservices/", { callback: cbName });
    const { body } = await this.chromeFetch(url, { headers: this._jsonpHeaders() });
    const data = parseJsonp(body);
    return (data?.Services ?? []).map((s: any) => ({
      id: String(s.id),
      name: (s.name ?? "").replace(/<[^>]*>/g, "").trim(),
    }));
  }

  /** getagendas/ JSONP → agendas pour un service */
  async getAgendas(serviceId: string): Promise<SpainAgendaResult[]> {
    const cbName = `jsonp_${Date.now()}`;
    const url = this._buildUrl("getagendas/", { service_id: serviceId, callback: cbName });
    const { body } = await this.chromeFetch(url, { headers: this._jsonpHeaders() });
    const data = parseJsonp(body);
    return (data?.Agendas ?? []).map((a: any) => ({ id: String(a.id), name: a.name ?? "" }));
  }

  /** datetime/ JSONP → créneaux pour une agenda + date */
  async getDatetime(agendaId: string, date: string): Promise<any[]> {
    const cbName = `jsonp_${Date.now()}`;
    const url = this._buildUrl("datetime/", { agenda: agendaId, date, callback: cbName });
    const { body } = await this.chromeFetch(url, { headers: this._jsonpHeaders() });
    const data = parseJsonp(body);
    return data?.Slots ?? data?.slots ?? [];
  }

  /** getwidgetconfigurations/ → config du widget */
  async getWidgetConfig(): Promise<any> {
    const cbName = `jsonp_${Date.now()}`;
    const url = this._buildUrl("getwidgetconfigurations/", { callback: cbName });
    const { body } = await this.chromeFetch(url, { headers: this._jsonpHeaders() });
    return parseJsonp(body)?.WidgetConfiguration ?? null;
  }

  /** Ferme le browser et libère les ressources */
  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
  }

  // ── Helpers privés ───────────────────────────────────────────────────────────

  private _buildUrl(endpoint: string, extra: Record<string, string> = {}): string {
    const base = "https://www.citaconsular.es/onlinebookings";
    const u = new URL(`${base}/${endpoint}`);
    const params: Record<string, string> = {
      type:    "default",
      publickey: this.config.widgetKey,
      lang:    this.config.lang,
      version: "4",
      src:     this.config.portalUrl,
      srvsrc:  "https://www.citaconsular.es",
      _:       Date.now().toString(),
      ...extra,
    };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private _jsonpHeaders(): Record<string, string> {
    return {
      "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Referer": this.config.portalUrl,
      "X-Requested-With": "XMLHttpRequest",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "priority": "u=1, i",
    };
    // Note: pas de Cookie header — credentials: "include" dans chromeFetch
    // envoie automatiquement les cookies du browser (cf_clearance + PHPSESSID)
  }
}
