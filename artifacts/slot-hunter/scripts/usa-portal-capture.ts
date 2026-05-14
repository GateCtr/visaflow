#!/usr/bin/env tsx
/**
 * Capture manuelle portail USA (usvisaappt.com) — Playwright visible.
 *
 * Objectif : comprendre 401 / restriction / tokens (id vs access, headers, cookies)
 * en comparant ce que le navigateur envoie réellement à ce que fait le bot (usaFetch, impit, proxy).
 *
 * Prérequis : **Google Chrome** (ou Edge) déjà installé sur la machine — le script utilise
 * `channel: "chrome"` (Playwright pilote le Chrome système, sans `playwright install chromium`).
 * Optionnel : `USA_CAPTURE_CHANNEL=msedge` pour Microsoft Edge.
 *
 * Variables d’environnement (optionnel) :
 *  - USA_CAPTURE_PROXY_URL — si défini, force ce proxy (sauf USA_CAPTURE_NO_PROXY)
 *  - TWOCAPTCHA_API_KEY — sinon : pool résidentiel 2captcha (IP machine whitelistée), puis IPROYAL_PROXY_URL, puis PROXY_URL
 *  - USA_CAPTURE_NO_PROXY=1 — forcer sans proxy (navigateur direct malgré le .env)
 *  - USA_CAPTURE_START_URL — défaut : page de login Angular
 *  - USA_CAPTURE_CHANNEL — `chrome` (défaut) ou `msedge` : navigateur déjà installé
 *
 * Usage : depuis `artifacts/slot-hunter` : `pnpm run usa:portal:capture` (ou `npm run`).
 *         Depuis la racine du repo : `pnpm run usa:portal:capture` (script délégué au package slot-hunter).
 * Arrêt    : Ctrl+C, ou Entrée dans le terminal (si interactif), ou fermer la fenêtre du navigateur
 *            → écrit HAR, traces auth, storage, cookies, résumé.
 */

import "dotenv/config";
import * as fs from "fs";
import * as readline from "node:readline";
import * as path from "path";
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "playwright";
import { ProxyPool, detectPublicIp, parseHttpProxyUrlForPlaywright } from "../src/proxyPool.js";

const DEFAULT_START = "https://www.usvisaappt.com/visaapplicantui/login";
const HOST_NEEDLE = "usvisaappt.com";

const CAPTURE_ROOT = path.resolve(import.meta.dirname, "..", "captured", "usa-portal");

/** En-têtes réponse à conserver pour l’analyse auth (noms normalisés minuscules côté stockage). */
const RESPONSE_AUTH_HEADERS = [
  "authorization",
  "refreshtoken",
  "csrftoken",
  "set-cookie",
  "access-control-expose-headers",
];

/** Chemins ou segments d’URL jugés pertinents pour le problème JWT / 401 / restriction. */
function isAuthRelevantUrl(url: string): boolean {
  if (!url.includes(HOST_NEEDLE)) return false;
  const p = url.toLowerCase();
  return (
    p.includes("/identity/") ||
    p.includes("/visaappointmentapi/") ||
    p.includes("/visaworkflowprocessor/") ||
    p.includes("/visauserapi/") ||
    p.includes("/visaapplicantapi/") ||
    p.includes("/visapaymentapi/") ||
    p.includes("/visaadministrationapi/")
  );
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ts(): string {
  return new Date().toISOString();
}

function maskJwt(h: string | undefined): string | undefined {
  if (!h) return undefined;
  const v = h.startsWith("Bearer ") ? h.slice(7).trim() : h.trim();
  if (v.length < 30) return "[trop court]";
  return `${v.slice(0, 24)}…${v.slice(-16)} (len=${v.length})`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const t = token.replace(/^Bearer\s+/i, "").trim();
    const p = t.split(".")[1];
    if (!p) return null;
    const json = Buffer.from(p, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type PlaywrightProxy = NonNullable<ReturnType<typeof parseHttpProxyUrlForPlaywright>>;

function maskProxyServer(server: string): string {
  return server.replace(/:([^:@]+)@/, ":***@");
}

let capture2captchaPool: ProxyPool | null = null;
let capture2captchaInit: Promise<void> | null = null;

/** IP publique (sortie Internet) — une seule détection par lancement du script. */
let cachedPublicIp: string | null | undefined;

async function getCachedPublicIp(): Promise<string | null> {
  if (cachedPublicIp !== undefined) return cachedPublicIp;
  cachedPublicIp = await detectPublicIp();
  return cachedPublicIp;
}

async function initCapture2CaptchaPool(): Promise<ProxyPool | null> {
  const key = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!key) return null;
  if (!capture2captchaPool) capture2captchaPool = new ProxyPool(key);
  if (capture2captchaPool.isConfigured) return capture2captchaPool;
  if (!capture2captchaInit) {
    capture2captchaInit = (async () => {
      const ip = await getCachedPublicIp();
      if (ip) await capture2captchaPool!.initialize(ip);
    })();
  }
  await capture2captchaInit;
  return capture2captchaPool.isConfigured ? capture2captchaPool : null;
}

/** Ordre : explicite USA_CAPTURE_PROXY_URL → 2captcha (TWOCAPTCHA_API_KEY + whitelist IP) → iProyal → PROXY_URL. */
async function resolvePlaywrightProxy(): Promise<{ proxy: PlaywrightProxy | undefined; label: string }> {
  if (process.env.USA_CAPTURE_NO_PROXY === "1" || process.env.USA_CAPTURE_NO_PROXY === "true") {
    return { proxy: undefined, label: "(aucun — direct)" };
  }
  const explicit = process.env.USA_CAPTURE_PROXY_URL?.trim();
  if (explicit) {
    const p = parseHttpProxyUrlForPlaywright(explicit);
    if (p) {
      return { proxy: p, label: `USA_CAPTURE_PROXY_URL → ${maskProxyServer(p.server)}` };
    }
    console.warn("[usa-portal-capture] USA_CAPTURE_PROXY_URL invalide — chaîne par défaut (2captcha → iProyal…).");
  }

  const pool = await initCapture2CaptchaPool();
  if (pool) {
    const got = await pool.getProxy();
    if (got?.proxy) {
      const p = parseHttpProxyUrlForPlaywright(got.proxy);
      if (p) {
        return { proxy: p, label: `2captcha résidentiel → ${maskProxyServer(p.server)}` };
      }
    }
  }

  const iproyal = process.env.IPROYAL_PROXY_URL?.trim();
  const staticP = process.env.PROXY_URL?.trim();
  const raw = iproyal || staticP;
  if (!raw) {
    return { proxy: undefined, label: "(aucun — direct)" };
  }
  const p = parseHttpProxyUrlForPlaywright(raw);
  if (!p) {
    console.warn("[usa-portal-capture] URL proxy (iProyal / PROXY_URL) invalide — navigation sans proxy.");
    return { proxy: undefined, label: "(aucun — URL invalide)" };
  }
  const src = iproyal ? "IPROYAL_PROXY_URL" : "PROXY_URL";
  return { proxy: p, label: `${src} → ${maskProxyServer(p.server)}` };
}

/** Chrome ou Edge déjà installés — pas de binaire Chromium Playwright. */
function resolveBrowserChannel(): "chrome" | "msedge" {
  const c = (process.env.USA_CAPTURE_CHANNEL ?? "chrome").trim().toLowerCase();
  if (c === "msedge" || c === "edge") return "msedge";
  return "chrome";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [tronqué, ${s.length} octets au total]`;
}

interface AuthTraceRow {
  t: string;
  method: string;
  url: string;
  status: number;
  requestAuthorizationMasked?: string;
  requestCookieSnippet?: string;
  responseAuthHeaders: Record<string, string>;
  responseBodySnippet?: string;
  /** JWT issu du header Authorization de la *requête* (client → serveur). */
  decodedRequestAuthorizationPayload?: Record<string, unknown> | null;
  /** JWT issu du header Authorization de la *réponse* (ex. login / refresh). */
  decodedResponseAuthorizationPayload?: Record<string, unknown> | null;
}

interface RequestMeta {
  id: number;
  t: string;
}

const requestMeta = new WeakMap<Request, RequestMeta>();
let reqSeq = 0;

class UsaPortalCapture {
  private sessionDir = "";
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleStream: fs.WriteStream | null = null;
  private shuttingDown = false;
  private readonly authTrace: AuthTraceRow[] = [];
  private readonly allResponses: Array<{ t: string; url: string; status: number; ct?: string }> = [];

  async run(): Promise<void> {
    const stamp = Date.now();
    this.sessionDir = path.join(CAPTURE_ROOT, `portal-${stamp}`);
    ensureDir(this.sessionDir);

    const startUrl = process.env.USA_CAPTURE_START_URL?.trim() || DEFAULT_START;
    const harPath = path.join(this.sessionDir, "network.har");
    const browserChannel = resolveBrowserChannel();
    const publicIp = await getCachedPublicIp();
    const { proxy, label: proxyLabel } = await resolvePlaywrightProxy();

    console.log("═".repeat(64));
    console.log(" USA PORTAL — capture manuelle (usvisaappt.com)");
    console.log("═".repeat(64));
    console.log(`Dossier   : ${this.sessionDir}`);
    console.log(`Départ    : ${startUrl}`);
    console.log(`IP publique (sortie Internet / whitelist 2captcha) : ${publicIp ?? "(non détectée)"}`);
    console.log(`Navigateur: ${browserChannel} (système)`);
    console.log(`Proxy     : ${proxyLabel}`);
    console.log("");
    console.log("1) Connecte-toi et navigue comme d’habitude (dashboard, demandes, créneaux…).");
    console.log("2) Quand tu as fini : Entrée dans ce terminal, fermer le navigateur, ou Ctrl+C.");
    console.log("");

    fs.writeFileSync(
      path.join(this.sessionDir, "LISEZMOI.txt"),
      [
        "Capture portail USA (Angular) — usvisaappt.com",
        "",
        `Démarrage : ${startUrl}`,
        `IP publique (machine / sortie Internet) : ${publicIp ?? "non détectée"}`,
        `Proxy : ${proxyLabel}`,
        `Navigateur : ${browserChannel} (installation système, pas Chromium Playwright)`,
        "",
        "Fichiers :",
        "  - network.har          Trafic réseau (DevTools / analyse HAR)",
        "  - auth-trace.json      Requêtes « sensibles » + JWT décodé (requête et réponse)",
        "  - responses-index.json Liste minimale des réponses",
        "  - storage.json         localStorage + sessionStorage (tronqué)",
        "  - cookies.json         Cookies du contexte Playwright",
        "  - console.jsonl        Logs console navigateur",
        "",
        "Comparer avec le bot : src/usaPortal/usa-http.ts (usaFetch, impit vs fetch+proxy).",
      ].join("\n"),
      "utf8",
    );

    this.browser = await chromium.launch({
      channel: browserChannel,
      headless: false,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: "fr-FR",
      timezoneId: "Africa/Kinshasa",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      recordHar: { path: harPath, mode: "full", content: "embed" },
      ...(proxy ? { proxy } : {}),
    });

    this.page = await this.context.newPage();

    const consolePath = path.join(this.sessionDir, "console.jsonl");
    this.consoleStream = fs.createWriteStream(consolePath, { flags: "a" });

    this.page.on("console", (msg) => {
      const line = JSON.stringify({ t: ts(), type: msg.type(), text: msg.text() }) + "\n";
      this.consoleStream?.write(line);
      if (msg.type() === "error") console.error(`[console] ${msg.text()}`);
    });

    this.page.on("pageerror", (err) => {
      this.consoleStream?.write(JSON.stringify({ t: ts(), type: "pageerror", text: err.message }) + "\n");
      console.error(`[pageerror] ${err.message}`);
    });

    this.page.on("request", (req: Request) => {
      const id = ++reqSeq;
      requestMeta.set(req, { id, t: ts() });
    });

    this.page.on("response", async (res: Response) => {
      const url = res.url();
      const status = res.status();
      const ct = res.headers()["content-type"];
      this.allResponses.push({ t: ts(), url, status, ct });

      if (!isAuthRelevantUrl(url)) return;

      const req = res.request();
      const meta = requestMeta.get(req);
      const reqHeaders = req.headers();
      const resHeaders = res.headers();

      const rawResAuth = resHeaders["authorization"] ?? resHeaders["Authorization"];
      const decodedResAuth = rawResAuth ? decodeJwtPayload(rawResAuth) : null;

      const pickRes: Record<string, string> = {};
      for (const [k, v] of Object.entries(resHeaders)) {
        const low = k.toLowerCase();
        if (!RESPONSE_AUTH_HEADERS.includes(low)) continue;
        if (low === "authorization" || low === "refreshtoken") {
          pickRes[k] =
            low === "authorization" ? (maskJwt(v) ?? truncate(v, 100)) : truncate(v, 100);
        } else if (low === "set-cookie") {
          pickRes[k] = truncate(v, 2000);
        } else {
          pickRes[k] = v;
        }
      }

      let bodySnippet: string | undefined;
      try {
        const buf = await res.body();
        const txt = buf.toString("utf8");
        bodySnippet = truncate(txt, 6000);
      } catch {
        bodySnippet = "[corps illisible ou binaire]";
      }

      const authHdr = reqHeaders["authorization"] ?? reqHeaders["Authorization"];
      let decodedReq: Record<string, unknown> | null = null;
      if (authHdr?.startsWith("Bearer ")) {
        decodedReq = decodeJwtPayload(authHdr.slice(7));
      }

      const row: AuthTraceRow = {
        t: meta?.t ?? ts(),
        method: req.method(),
        url,
        status,
        requestAuthorizationMasked: maskJwt(authHdr),
        requestCookieSnippet: truncate(reqHeaders["cookie"] ?? "", 1200),
        responseAuthHeaders: pickRes,
        responseBodySnippet: bodySnippet,
        decodedRequestAuthorizationPayload: decodedReq,
        decodedResponseAuthorizationPayload: decodedResAuth,
      };
      this.authTrace.push(row);

      const flag = status === 401 || status === 403 ? " ⚠️" : "";
      console.log(`[api] ${req.method()} ${status}${flag} ${url.slice(0, 100)}…`);
    });

    await this.page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

    await new Promise<void>((resolve) => {
      let settled = false;
      let rl: readline.Interface | null = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (rl) {
          try {
            rl.close();
          } catch {
            /* */
          }
          rl = null;
        }
        resolve();
      };

      if (process.stdin.isTTY) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log(
          "\n→ Ferme la fenêtre du navigateur, ou appuie sur Entrée dans ce terminal, pour enregistrer HAR + traces.",
        );
        console.log("  (Ctrl+C fonctionne aussi si le terminal le reçoit.)\n");
        rl.once("line", () => done());
      } else {
        console.log(
          "\n→ Ferme la fenêtre du navigateur pour enregistrer (stdin non interactif : pas d’Entrée ici). Ctrl+C si possible.\n",
        );
      }

      this.browser?.once("disconnected", done);
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log("\n[usa-portal-capture] Finalisation…");

    try {
      this.consoleStream?.end();
    } catch {
      /* */
    }
    this.consoleStream = null;

    const storage: Record<string, unknown> = {};
    try {
      if (this.page) {
        storage.localStorage = await this.page.evaluate(() =>
          Object.fromEntries(Object.entries({ ...localStorage })),
        );
        storage.sessionStorage = await this.page.evaluate(() =>
          Object.fromEntries(Object.entries({ ...sessionStorage })),
        );
        storage.url = this.page.url();
        storage.title = await this.page.title();
      }
    } catch (e) {
      storage.error = String(e);
    }

    let cookies: unknown[] = [];
    try {
      if (this.context) cookies = await this.context.cookies();
    } catch {
      /* ignore */
    }

    if (this.sessionDir) {
      const trimStorage = (obj: unknown): unknown => {
        if (!obj || typeof obj !== "object") return obj;
        const o = obj as Record<string, string>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(o)) {
          out[k] = typeof v === "string" && v.length > 500 ? truncate(v, 500) : v;
        }
        return out;
      };

      const storageOut = {
        ...(storage as object),
        localStorage: trimStorage(storage.localStorage),
        sessionStorage: trimStorage(storage.sessionStorage),
      };

      fs.writeFileSync(path.join(this.sessionDir, "storage.json"), JSON.stringify(storageOut, null, 2), "utf8");
      fs.writeFileSync(path.join(this.sessionDir, "cookies.json"), JSON.stringify(cookies, null, 2), "utf8");
      fs.writeFileSync(path.join(this.sessionDir, "auth-trace.json"), JSON.stringify(this.authTrace, null, 2), "utf8");
      fs.writeFileSync(
        path.join(this.sessionDir, "responses-index.json"),
        JSON.stringify(this.allResponses, null, 2),
        "utf8",
      );

      const status401 = this.allResponses.filter((r) => r.status === 401).length;
      const status403 = this.allResponses.filter((r) => r.status === 403).length;
      const summary = {
        endedAt: ts(),
        sessionDir: this.sessionDir,
        totalResponses: this.allResponses.length,
        count401: status401,
        count403: status403,
        authTraceRows: this.authTrace.length,
        hints: [
          "Comparer token_use (id vs access) : auth-trace.json → decodedRequestAuthorizationPayload vs decodedResponseAuthorizationPayload.",
          "Si login renvoie accessToken null dans le JSON mais authorization en header, noter la différence avec le bot (usa-auth.ts).",
          "Si 401 seulement avec proxy côté bot : comparer TLS (impit sans proxy vs fetch+undici avec proxy) dans usa-http.ts.",
        ],
      };
      fs.writeFileSync(path.join(this.sessionDir, "capture-summary.json"), JSON.stringify(summary, null, 2), "utf8");

      console.log(`[usa-portal-capture] Écrit : ${this.sessionDir}`);
      console.log(`[usa-portal-capture] Lignes auth-trace : ${this.authTrace.length} | 401 : ${status401} | 403 : ${status403}`);
    }

    try {
      if (this.context) await this.context.close();
    } catch {
      /* */
    }
    try {
      if (this.browser) await this.browser.close();
    } catch {
      /* */
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

let active: UsaPortalCapture | null = null;

async function main(): Promise<void> {
  ensureDir(CAPTURE_ROOT);
  const cap = new UsaPortalCapture();
  active = cap;

  const onStop = async () => {
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
    if (active) {
      await active.shutdown();
      active = null;
    }
    process.exit(0);
  };

  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  try {
    await cap.run();
    if (active) {
      await active.shutdown();
      active = null;
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    if (active) {
      await active.shutdown();
      active = null;
    }
    process.exit(1);
  }
}

void main();
