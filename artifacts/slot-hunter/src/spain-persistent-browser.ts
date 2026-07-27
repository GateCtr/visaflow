/**
 * spain-persistent-browser.ts — Session Cloudflare citaconsular.es via Chromium persistant
 *
 * ARCHITECTURE :
 *   1. Lance un Chromium unique avec userDataDir → profil complet conservé sur disque
 *      (cookies, localStorage, cache HTTP, service workers, WebGL/canvas context)
 *   2. Navigue vers le widget Bookitit dans le contexte principal → CF challenge résolu
 *      nativement par Chromium → cf_clearance extrait et exporté comme SpainCfSession
 *   3. Réutilise le même browser entre les scans → CF voit un utilisateur fidèle
 *   4. Par dossier : contexte incognito isolé (cookies séparés) → PHPSESSID propre
 *      sans risque de conflit entre dossiers parallèles
 *
 * COMPARAISON avec le mode HTTP-only :
 *   + Vrai Chromium → TLS/HTTP2 fingerprint identique à un vrai navigateur
 *   + Profil persistant → localStorage, cache, service workers conservés
 *   + Pas de coût CapSolver pour résoudre CF (Chromium le fait nativement)
 *   + Moins de faux refus CF sur les IPs déjà connues
 *   − Coût RAM : ~200-400 MB pour un process Chromium persistant
 *   − Scan légèrement plus lent au démarrage (navigation initiale ~10-30s)
 *
 * ACTIVATION :
 *   SPAIN_SESSION_MODE=persistent-browser
 *
 * VARIABLES D'ENVIRONNEMENT :
 *   SPAIN_CF_PROFILE_DIR  Dossier userDataDir (défaut: /tmp/spain-cf-profile)
 *   DECODO_PROXY_URL      Proxy ISP fixe (prioritaire)
 *   SOAX_PROXY_URL        Proxy résidentiel (fallback)
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { parseProxyForPuppeteer, randomUserAgent, randomViewport } from "./browser.js";
import {
  type SpainCfSession,
  cloneSpainCfSessionForDossier,
} from "./spain-soax-solver.js";
import { syncSpainCfSessionToRedis, type SerializableSpainCfSession } from "./spain-redis-persistence.js";

puppeteer.use(StealthPlugin());

// ─── Configuration ────────────────────────────────────────────────────────────

/** Dossier userDataDir pour le profil Chromium persistant. */
const CF_PROFILE_DIR = process.env.SPAIN_CF_PROFILE_DIR ?? "/tmp/spain-cf-profile";

/** TTL estimé du cf_clearance (115min — marge de 5min sur les ~2h réelles). */
const CF_CLEARANCE_TTL_MS = 115 * 60_000;

/** Timeout max pour la résolution CF (navigation + poll cf_clearance). */
const CF_SOLVE_TIMEOUT_MS = 90_000;

/** Intervalle de poll pour cf_clearance. */
const CF_POLL_INTERVAL_MS = 2_000;

/** Timeout health-check du browser (avant de le considérer mort). */
const BROWSER_HEALTH_TIMEOUT_MS = 5_000;

/** URL widget cible par défaut. */
const DEFAULT_WIDGET_URL = "https://www.citaconsular.es/es/hosteds/widgetdef498.html";

// ─── SpainPersistentBrowserManager ────────────────────────────────────────────

class SpainPersistentBrowserManager {
  private _browser: Browser | null = null;
  private _cachedSession: SpainCfSession | null = null;
  private _ua: string = randomUserAgent();
  private _viewport = randomViewport();

  // ── Proxy helpers ─────────────────────────────────────────────────────────

  private getProxyUrl(): string | undefined {
    return process.env.DECODO_PROXY_URL ?? process.env.SOAX_PROXY_URL;
  }

  private buildLaunchArgs(proxyUrl: string | undefined): {
    args: string[];
    proxyAuth: { username: string; password: string } | undefined;
  } {
    const vp = this._viewport;
    const args: string[] = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--window-size=${vp.width},${vp.height}`,
    ];

    let proxyAuth: { username: string; password: string } | undefined;
    if (proxyUrl) {
      const parsed = parseProxyForPuppeteer(proxyUrl);
      if (parsed) {
        args.push(`--proxy-server=${parsed.server}`);
        if (parsed.username) {
          proxyAuth = { username: parsed.username, password: parsed.password ?? "" };
        }
      }
    }

    return { args, proxyAuth };
  }

  // ── Browser lifecycle ─────────────────────────────────────────────────────

  private async isBrowserAlive(): Promise<boolean> {
    if (!this._browser) return false;
    try {
      await Promise.race([
        this._browser.pages(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("health-timeout")), BROWSER_HEALTH_TIMEOUT_MS),
        ),
      ]);
      return true;
    } catch {
      this._browser = null;
      return false;
    }
  }

  async getOrLaunchBrowser(): Promise<Browser> {
    if (await this.isBrowserAlive()) return this._browser!;

    const proxyUrl = this.getProxyUrl();
    const { args } = this.buildLaunchArgs(proxyUrl);

    // Rotate UA + viewport at each browser launch
    this._ua = randomUserAgent();
    this._viewport = randomViewport();

    const maskedProxy = proxyUrl
      ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 80)
      : "direct (no proxy)";
    console.log(`[spain-pb] 🚀 Lancement Chromium persistant`);
    console.log(`[spain-pb]    userDataDir : ${CF_PROFILE_DIR}`);
    console.log(`[spain-pb]    Proxy       : ${maskedProxy}`);
    console.log(`[spain-pb]    UA          : ${this._ua.slice(0, 80)}`);

    this._browser = await (puppeteer as any).launch({
      headless: true,
      userDataDir: CF_PROFILE_DIR,
      args,
    }) as Browser;

    return this._browser!;
  }

  // ── Session state ─────────────────────────────────────────────────────────

  isSessionValid(): boolean {
    if (!this._cachedSession) return false;
    return Date.now() < this._cachedSession.expiresAt;
  }

  isSessionExpiringSoon(): boolean {
    if (!this._cachedSession) return true;
    return (Date.now() + 10 * 60_000) >= this._cachedSession.expiresAt;
  }

  invalidateSession(): void {
    this._cachedSession = null;
    console.log("[spain-pb] 🗑️ Session CF invalidée");
  }

  getSession(): SpainCfSession | null {
    return this.isSessionValid() ? this._cachedSession : null;
  }

  // ── CF Session via Chromium persistant ────────────────────────────────────

  /**
   * Assure une session CF valide via le profil Chromium persistant.
   *
   * Stratégie :
   *   1. Cache mémoire valide → retour immédiat
   *   2. Sinon → navigation vers targetUrl dans le contexte principal (profil persistant)
   *   3. Poll cf_clearance jusqu'à CF_SOLVE_TIMEOUT_MS
   *   4. Extrait tous les cookies + construit SpainCfSession
   *   5. Persiste dans Redis pour survie aux redéploiements
   */
  async ensureSession(
    targetUrl: string = DEFAULT_WIDGET_URL,
  ): Promise<SpainCfSession | null> {
    if (this.isSessionValid()) {
      const remainMin = Math.round((this._cachedSession!.expiresAt - Date.now()) / 60_000);
      console.log(`[spain-pb] ♻️ Session CF réutilisée (reste ${remainMin}min)`);
      return this._cachedSession!;
    }

    const t0 = Date.now();
    console.log(`[spain-pb] 🔍 Résolution CF via Chromium persistant → ${targetUrl}`);

    const browser = await this.getOrLaunchBrowser();
    const proxyUrl = this.getProxyUrl();
    const { proxyAuth } = this.buildLaunchArgs(proxyUrl);

    // Utiliser la première page du contexte persistant (profil complet — cookies, cache, LS)
    const pages = await browser.pages();
    const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();

    await page.setUserAgent(this._ua);
    await page.setViewport(this._viewport);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    });
    if (proxyAuth) await page.authenticate(proxyAuth);

    // Script d'init stealth identique à browser.ts (webdriver + chrome enrichi)
    const navLanguages = ["fr-FR", "fr", "en-US", "en"];
    await (page as any).evaluateOnNewDocument(
      (langs: string[]) => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "languages", { get: () => langs });
        const noop = () => undefined;
        (window as any).chrome = {
          app: {
            isInstalled: false,
            InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
            RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
            getDetails: noop,
            getIsInstalled: noop,
            runningState: noop,
          },
          csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000 + 200, tran: 15 }),
          loadTimes: () => ({
            requestTime: Date.now() / 1000 - 0.4,
            startLoadTime: Date.now() / 1000 - 0.35,
            commitLoadTime: Date.now() / 1000 - 0.3,
            finishDocumentLoadTime: Date.now() / 1000 - 0.2,
            finishLoadTime: Date.now() / 1000 - 0.1,
            firstPaintTime: 0,
            firstPaintAfterLoadTime: 0,
            navigationType: "Other",
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: "h2",
            wasAlternateProtocolAvailable: false,
            connectionInfo: "h2",
          }),
          runtime: {
            PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd" },
            PlatformArch: { ARM: "arm", ARM64: "arm64", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
            PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
            RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" },
            OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
            OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
            connect: noop,
            sendMessage: noop,
            id: undefined,
          },
        };
      },
      navLanguages,
    );

    // Naviguer vers le widget
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: CF_SOLVE_TIMEOUT_MS,
      });
    } catch (navErr) {
      // La navigation peut timeout sur un challenge interactif long — on continue le poll
      console.warn(`[spain-pb] ⚠️ goto() timeout/erreur (non-fatal, poll cf_clearance…): ${navErr}`);
    }

    // Poll cf_clearance
    const deadline = Date.now() + CF_SOLVE_TIMEOUT_MS;
    let cfClearance = "";

    while (Date.now() < deadline) {
      try {
        const cookies = await page.cookies("https://www.citaconsular.es");
        const cfCookie = cookies.find((c) => c.name === "cf_clearance");
        if (cfCookie?.value) {
          cfClearance = cfCookie.value;
          break;
        }
      } catch {
        // Page peut être en cours de redirection — retry
      }
      await new Promise((r) => setTimeout(r, CF_POLL_INTERVAL_MS));
    }

    if (!cfClearance) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.error(`[spain-pb] ❌ cf_clearance non obtenu après ${elapsed}s`);
      return null;
    }

    // Extraire tous les cookies du domaine
    const allPuppeteerCookies = await page.cookies("https://www.citaconsular.es");
    const allCookies = allPuppeteerCookies.map((c) => ({ name: c.name, value: c.value }));

    const createdAt = Date.now();
    const elapsed = Math.round((createdAt - t0) / 1000);
    console.log(
      `[spain-pb] ✅ cf_clearance obtenu (${elapsed}s) | ${allCookies.length} cookies` +
      ` | expire ~${Math.round(CF_CLEARANCE_TTL_MS / 60_000)}min`,
    );
    console.log(`[spain-pb]    cf_clearance: ${cfClearance.slice(0, 40)}…`);

    const session: SpainCfSession = {
      cfClearance,
      cfDomain: ".citaconsular.es",
      soaxProxyUrl: proxyUrl ?? "",
      userAgent: this._ua,
      createdAt,
      expiresAt: createdAt + CF_CLEARANCE_TTL_MS,
      allCookies,
      extraHeaders: {},
      source: "playwright", // indique une session navigateur réelle (même champ que local-playwright-solver)
    };

    this._cachedSession = session;

    // Persistance Redis pour survie aux redéploiements
    try {
      syncSpainCfSessionToRedis(session as SerializableSpainCfSession);
    } catch (redisErr) {
      console.warn(`[spain-pb] ⚠️ Redis sync échoué (non-fatal): ${redisErr}`);
    }

    return session;
  }

  // ── Isolation PHPSESSID par dossier (contexte incognito) ──────────────────

  /**
   * Crée une session dossier isolée dans un contexte incognito.
   *
   * - Injecte les cookies CF partagés (sans PHPSESSID)
   * - Navigue vers /main/ → le serveur Bookitit émet un PHPSESSID frais
   * - Retourne une copie de la session CF avec ce PHPSESSID unique
   *
   * Utilité : éviter que deux dossiers partagent la même session applicative
   * Bookitit, ce qui causerait des erreurs de signin ou de summary croisés.
   *
   * Note : le contexte incognito est fermé après la fonction, mais la session
   * retournée contient les cookies nécessaires pour les appels impit suivants.
   */
  async createDossierSession(
    cfSession: SpainCfSession,
    portalUrl: string,
  ): Promise<SpainCfSession | null> {
    const t0 = Date.now();
    const browser = await this.getOrLaunchBrowser();
    const proxyUrl = this.getProxyUrl();
    const { proxyAuth } = this.buildLaunchArgs(proxyUrl);

    // createBrowserContext (Puppeteer v20+) → cookie store totalement isolé du profil principal
    // Remplace l'ancien createIncognitoBrowserContext() retiré dans Puppeteer v20.
    const incognito = await (browser as any).createBrowserContext();
    try {
      const page: Page = await incognito.newPage();

      await page.setUserAgent(cfSession.userAgent);
      await page.setViewport(this._viewport);
      await page.setExtraHTTPHeaders({
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      });
      if (proxyAuth) await page.authenticate(proxyAuth);

      // Injecter les cookies CF dans le contexte incognito (sans PHPSESSID)
      const cookiesToInject = cfSession.allCookies
        .filter((c) => c.name !== "PHPSESSID")
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: ".citaconsular.es",
          path: "/",
          secure: c.name === "cf_clearance",
        }));

      if (cookiesToInject.length > 0) {
        await page.setCookie(...cookiesToInject);
      }

      // GET /onlinebookings/main/ → le serveur émet un PHPSESSID pour ce contexte
      const publickey = portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
      const callback = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
      const query = new URLSearchParams({
        callback,
        type: "default",
        publickey,
        lang: "es",
        version: "4",
        src: portalUrl.replace(/\/?$/, "/"),
        _: String(Date.now()),
      });
      const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${query}`;

      await page.goto(mainUrl, { waitUntil: "networkidle0", timeout: 30_000 });

      const pageCookies = await page.cookies("https://www.citaconsular.es");
      const phpSessId = pageCookies.find((c) => c.name === "PHPSESSID")?.value;

      if (!phpSessId) {
        console.warn("[spain-pb] ❌ Contexte incognito — /main/ n'a pas fourni de PHPSESSID");
        return null;
      }

      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(
        `[spain-pb] 🔒 Session dossier isolée créée (${elapsed}s)` +
        ` — PHPSESSID=${phpSessId.slice(0, 12)}…`,
      );

      // Construire la session dossier : cookies CF + PHPSESSID frais
      const dossierCookies = [
        ...cfSession.allCookies.filter((c) => c.name !== "PHPSESSID"),
        { name: "PHPSESSID", value: phpSessId },
      ];

      return {
        ...cfSession,
        allCookies: dossierCookies,
      };
    } finally {
      await incognito.close().catch(() => {});
    }
  }

  // ── Fermeture propre ──────────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
    }
    this._cachedSession = null;
    console.log("[spain-pb] 🛑 Chromium persistant fermé");
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const spainPersistentBrowser = new SpainPersistentBrowserManager();

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Obtient ou renouvelle la session CF via Chromium persistant.
 * Même signature que `ensureSpainCfSession()` — échangeable dans la watcher loop.
 */
export async function ensureSpainPersistentBrowserSession(
  targetUrl: string = DEFAULT_WIDGET_URL,
): Promise<SpainCfSession | null> {
  return spainPersistentBrowser.ensureSession(targetUrl);
}

/** Équivalent de `isSpainCfSessionExpiringSoon()` pour le mode persistent-browser. */
export function isSpainPersistentBrowserSessionExpiringSoon(): boolean {
  return spainPersistentBrowser.isSessionExpiringSoon();
}

/** Équivalent de `getActiveSpainCfSession()` pour le mode persistent-browser. */
export function getActiveSpainPersistentBrowserSession(): SpainCfSession | undefined {
  return spainPersistentBrowser.getSession() ?? undefined;
}

/**
 * Crée une session dossier isolée (contexte incognito → PHPSESSID propre).
 * À appeler depuis spain-http-booking.ts en remplacement de createIsolatedBookingSession()
 * lorsque SPAIN_SESSION_MODE=persistent-browser.
 *
 * Si la navigation incognito échoue, retourne null → l'appelant doit traiter l'erreur.
 */
export async function createSpainPersistentBrowserDossierSession(
  cfSession: SpainCfSession,
  portalUrl: string,
): Promise<SpainCfSession | null> {
  return spainPersistentBrowser.createDossierSession(cfSession, portalUrl);
}
