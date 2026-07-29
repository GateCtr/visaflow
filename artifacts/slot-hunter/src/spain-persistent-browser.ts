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
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseProxyForPuppeteer, randomViewport } from "./browser.js";

// ─── UA Chrome/Edge exclusivement pour le persistent browser ─────────────────
// Safari/Firefox UAs servis par un moteur Chromium sont détectables via JS engine
// fingerprinting (propriétés Safari-only absentes, Gecko APIs manquantes, etc.).
const CHROME_UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.103 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36 Edg/148.0.2849.68",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7231.96 Safari/537.36",
];

let _uaIdx = Math.floor(Math.random() * CHROME_UA_POOL.length);
function randomChromeUA(): string {
  const ua = CHROME_UA_POOL[_uaIdx % CHROME_UA_POOL.length];
  _uaIdx++;
  return ua;
}

/**
 * Dérive navigator.platform depuis le UA pour éviter l'incohérence UA↔platform.
 * CF détecte immédiatement un UA Macintosh avec platform="Linux x86_64".
 */
function platformFromUA(ua: string): string {
  if (/Macintosh/i.test(ua)) return "MacIntel";
  if (/Windows NT/i.test(ua)) return "Win32";
  return "Linux x86_64";
}
import {
  type SpainCfSession,
  cloneSpainCfSessionForDossier,
  isSpainCfSessionExpiringSoon,
  getActiveSpainCfSession,
  setActiveSpainCfSession,
  solveSpainCloudflare,
} from "./spain-soax-solver.js";
import { syncSpainCfSessionToRedis, type SerializableSpainCfSession } from "./spain-redis-persistence.js";

puppeteer.use(StealthPlugin());

// ─── Proxy auth helper ────────────────────────────────────────────────────────

/**
 * Installe un handler CDP Fetch pour répondre aux challenges proxy 407.
 *
 * `page.authenticate()` ne fonctionne pas de façon fiable pour les proxies HTTP
 * en mode headless dans Puppeteer v22+ : il cible la couche page-level auth
 * (WWW-Authenticate) mais pas le proxy-level (Proxy-Authenticate / 407).
 * La solution correcte est `Fetch.enable { handleAuthRequests: true }` via CDP.
 */
async function setupPageProxyAuth(
  page: Page,
  creds: { username: string; password: string },
): Promise<void> {
  const client = await (page as any).createCDPSession();
  await client.send("Fetch.enable", { handleAuthRequests: true });
  client.on("Fetch.authRequired", async (event: any) => {
    const { requestId, authChallenge } = event;
    if (authChallenge?.source === "Proxy") {
      await client.send("Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: creds.username,
          password: creds.password,
        },
      }).catch(() => {});
    } else {
      // Pas un challenge proxy — continuer sans auth
      await client.send("Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: { response: "Default" },
      }).catch(() => {});
    }
  });
  client.on("Fetch.requestPaused", async (event: any) => {
    // Laisser passer toutes les requêtes non-auth interceptées
    await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
  });
}

// ─── Configuration ────────────────────────────────────────────────────────────

/** Dossier userDataDir pour le profil Chromium persistant. */
const CF_PROFILE_DIR = process.env.SPAIN_CF_PROFILE_DIR ?? "/tmp/spain-cf-profile";

/**
 * Purge les répertoires cache du profil Chromium sur disque AVANT le lancement.
 *
 * PROBLÈME : Chrome lit les fichiers de profil depuis le disque au démarrage.
 * Le CDP Storage.clearDataForOrigin ne modifie que la mémoire — les fichiers sur
 * disque (Cache, Code Cache, Service Worker, Local Storage, IndexedDB) restent stales
 * et sont relus au prochain lancement. Résultat : le JSD challenge token CF stocké dans
 * le profil (ex: timestamp 1785287132 vieux de 21 jours) est réutilisé indéfiniment.
 *
 * FIX : Supprimer ces répertoires sur disque avant puppeteer.launch() pour forcer
 * Chrome à reconstruire un cache propre. Le fichier Cookies est conservé (cf_clearance
 * + PHPSESSID de sessions antérieures restent disponibles si valides).
 */
function purgeProfileCacheOnDisk(profileDir: string): void {
  // CHIRURGIE PRÉCISE : on ne purge QUE le cache HTTP sur disque (Default/Cache).
  //
  // POURQUOI seulement Default/Cache :
  //   • Le script JSD CF (/cdn-cgi/challenge-platform/h/g/scripts/jsd/b0da9f4911ba/main.js)
  //     est mis en cache dans Default/Cache avec un token embarqué qui peut dater de jours.
  //   • Network.clearBrowserCache via CDP purge le cache mémoire mais PAS les fichiers
  //     Default/Cache/ sur disque → le script stale est relu au prochain lancement.
  //   • En supprimant Default/Cache/ avant le lancement, Chrome télécharge un script
  //     JSD frais avec le token courant → CF accepte le oneshot.
  //
  // POURQUOI PAS les autres répertoires :
  //   • Default/Code Cache/ — bytecode V8 compilé. CF accumule ici des données de
  //     reconnaissance ("profil de confiance") pour ce browser. Le purger force CF à
  //     re-évaluer le browser comme inconnu → managed challenge complet (Turnstile).
  //   • Default/Service Worker/ — CF enregistre un SW sur citaconsular.es. Le SW
  //     valide les requêtes JSD. Le purger = CF voit un browser sans historique.
  //   • Default/Local Storage/, Default/IndexedDB/ — CF challenge storage. Ces données
  //     sont déjà purgées via CDP Storage.clearDataForOrigin avant chaque navigation.
  //   • Default/Session Storage/ — session storage purgé par CDP aussi.
  //   • GPUCache, DawnGraphiteCache, DawnWebGPUCache — ne contiennent pas de tokens CF.
  const cacheDirs = [
    "Default/Cache",   // HTTP cache uniquement — script JSD stale ici
  ];
  let purged = 0;
  for (const dir of cacheDirs) {
    const fullPath = join(profileDir, dir);
    if (existsSync(fullPath)) {
      try {
        rmSync(fullPath, { recursive: true, force: true });
        purged++;
      } catch (e) {
        console.warn(`[spain-pb] ⚠️ Purge disque ${dir} (non-fatal): ${e}`);
      }
    }
  }
  if (purged > 0) {
    console.log(`[spain-pb] 🗑️ Default/Cache/ supprimé (script JSD stale purgé, Code Cache + SW + IndexedDB préservés)`);
  }
}

/** TTL estimé du cf_clearance (115min — marge de 5min sur les ~2h réelles). */
const CF_CLEARANCE_TTL_MS = 115 * 60_000;

/** Timeout max pour la résolution CF (navigation + poll cf_clearance). */
const CF_SOLVE_TIMEOUT_MS = 90_000;

/** Intervalle de poll pour cf_clearance. */
const CF_POLL_INTERVAL_MS = 2_000;

/** Timeout health-check du browser (avant de le considérer mort). */
const BROWSER_HEALTH_TIMEOUT_MS = 5_000;

/** URL widget cible par défaut. */
const DEFAULT_WIDGET_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

// ─── SpainPersistentBrowserManager ────────────────────────────────────────────

class SpainPersistentBrowserManager {
  private _browser: Browser | null = null;
  private _cachedSession: SpainCfSession | null = null;
  private _ua: string = randomChromeUA();
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
      // Software WebGL via SwiftShader — exposer WebGL sans GPU physique.
      // --disable-gpu supprime WebGL entièrement → signal bot détectable par CF.
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--enable-webgl",
      `--window-size=${vp.width},${vp.height}`,
      // Aligner le UA au niveau réseau (background requests, SW, prefetch) avec celui
      // de CapSolver. Sans ce flag, Chrome headless peut envoyer son UA interne dans
      // certaines requêtes même si page.setUserAgent() est appelé par la suite.
      `--user-agent=${this._ua}`,
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

  async getOrLaunchBrowser(preferredUA?: string): Promise<Browser> {
    if (await this.isBrowserAlive()) return this._browser!;

    // Use caller-supplied UA (e.g. CapSolver UA) if provided; otherwise rotate.
    // --user-agent launch flag must match the UA used by CapSolver when obtaining
    // cf_clearance — CF ties clearance to the exact UA string.
    this._ua = preferredUA ?? randomChromeUA();
    this._viewport = randomViewport();

    const proxyUrl = this.getProxyUrl();
    const { args } = this.buildLaunchArgs(proxyUrl);

    const maskedProxy = proxyUrl
      ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 80)
      : "direct (no proxy)";
    console.log(`[spain-pb] 🚀 Lancement Chromium persistant`);
    console.log(`[spain-pb]    userDataDir : ${CF_PROFILE_DIR}`);
    console.log(`[spain-pb]    Proxy       : ${maskedProxy}`);
    console.log(`[spain-pb]    UA          : ${this._ua.slice(0, 80)}`);

    // Purger les caches disque AVANT le lancement pour éviter les tokens JSD stales.
    // Le fichier Cookies est conservé pour réutiliser les cf_clearance + PHPSESSID valides.
    purgeProfileCacheOnDisk(CF_PROFILE_DIR);

    // CHROMIUM_EXECUTABLE_PATH : permet d'utiliser un Chromium préinstallé
    // (ex: celui de Playwright dans le nix store sur Replit) plutôt que le cache Puppeteer.
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
    if (executablePath) {
      console.log(`[spain-pb]    executablePath: ${executablePath}`);
    }

    this._browser = await (puppeteer as any).launch({
      headless: true,
      userDataDir: CF_PROFILE_DIR,
      args,
      ...(executablePath ? { executablePath } : {}),
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
    console.log(`[spain-pb] 🚀 Résolution CF — stratégie CapSolver-first + XHR intercept`);
    return this._resolveWithCapsolverFirst(targetUrl, t0);

  }

  // ── Résolution CapSolver-first + XHR intercept ────────────────────────────
  /**
   * Stratégie principale de résolution CF :
   *
   *   1. CapSolver résout le challenge CF en ~17s et retourne un cf_clearance
   *      lié au proxy Decodo (même IP que Chromium).
   *   2. cf_clearance injecté dans Chromium AVANT toute navigation → CF ne
   *      re-challenge pas (clearance déjà valide pour cette IP).
   *   3. UA synchronisé avec celui de CapSolver → CF lie clearance + UA.
   *   4. Listener `page.on('response')` armé sur /onlinebookings/main/ avant
   *      la navigation portail → capture la réponse XHR émise par le JS du
   *      portail après le clic Continuar. CF laisse passer les sous-requêtes
   *      XHR/fetch dans un contexte browser réel, contrairement aux navigations
   *      top-level vers l'endpoint JSONP (→ 0B silencieux via goto ou impit).
   *   5. Le JSONP capturé est stocké dans session.prefetchedMainHtml et réutilisé
   *      par le scanner HTTP sans appel impit (CF bloque impit sur /main/).
   */
  private async _resolveWithCapsolverFirst(
    targetUrl: string,
    t0: number,
  ): Promise<SpainCfSession | null> {
    const proxyUrl = this.getProxyUrl();
    const capsolverKey = process.env.CAPSOLVER_API_KEY;
    if (!capsolverKey || !proxyUrl) {
      console.error(
        "[spain-pb] ❌ " +
        (!capsolverKey ? "CAPSOLVER_API_KEY manquant" : "aucun proxy configuré (DECODO_PROXY_URL)"),
      );
      return null;
    }

    // ── Étape 1 : CapSolver → cf_clearance lié au proxy Decodo ───────────────
    console.log(`[spain-pb] 🤖 CapSolver → cf_clearance (proxy Decodo)…`);
    const capResult = await solveSpainCloudflare(targetUrl, capsolverKey, proxyUrl);
    if (!capResult.success || !capResult.session) {
      console.error(`[spain-pb] ❌ CapSolver échoué: ${capResult.error ?? "erreur inconnue"}`);
      return null;
    }
    const cfClearance = capResult.session.cfClearance;
    const capUA = capResult.session.userAgent || this._ua;
    console.log(`[spain-pb] ✅ CapSolver résolu (${Math.round((Date.now() - t0) / 1000)}s) — cf_clearance: ${cfClearance.slice(0, 40)}…`);
    console.log(`[spain-pb]    UA CapSolver: ${capUA.slice(0, 70)}`);

    // ── Étape 2 : Lancer/récupérer Chromium, configurer la page ──────────────
    // Passer capUA à getOrLaunchBrowser() : si le browser est (re)lancé, le
    // --user-agent flag utilisera directement l'UA de CapSolver sans rotation.
    const browser = await this.getOrLaunchBrowser(capUA);
    const { proxyAuth } = this.buildLaunchArgs(proxyUrl);

    const pages = await browser.pages();
    const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();

    // S'assurer que this._ua = capUA (si le browser était déjà vivant,
    // getOrLaunchBrowser retourne sans modifier this._ua — on le force ici).
    if (capUA && capUA !== this._ua) {
      this._ua = capUA;
    }
    await page.setUserAgent(this._ua);
    await page.setViewport(this._viewport);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    });
    // CDP Fetch handler remplace page.authenticate() — voir setupPageProxyAuth.
    if (proxyAuth) await setupPageProxyAuth(page, proxyAuth);

    // ── Dismiss window.alert/confirm/prompt ───────────────────────────────────
    // citaconsular.es affiche un window.alert() obligatoire après le challenge CF.
    // PROBLÈME : page.on("dialog") a une race condition si le dialog arrive pendant
    // la navigation. SOLUTION : supprimer window.alert via evaluateOnNewDocument
    // (s'exécute avant tout JS de la page) + handler backup.
    await (page as any).evaluateOnNewDocument(() => {
      (window as any).alert   = () => {};
      (window as any).confirm = () => true;
      (window as any).prompt  = () => "";
    });
    page.on("dialog", async (dialog: any) => {
      console.log(`[spain-pb] Dialog natif (${dialog.type()}): "${dialog.message().slice(0, 80)}" → accept`);
      await dialog.accept().catch(() => undefined);
    });

    // Script d'init stealth : webdriver + platform + languages + chrome enrichi +
    // WebGL renderer + navigator.plugins + Permissions.
    //
    // SIGNAUX BOT CRITIQUES patchés :
    //   • WebGL UNMASKED_RENDERER = "SwiftShader" → CF détecte les headless VMs
    //     → patché pour retourner un GPU Intel intégré (commun sur Win 10 laptop)
    //   • navigator.plugins = [] et navigator.mimeTypes = [] → vide en headless
    //     → Chrome réel a toujours au moins le plugin PDF + ses MIME types
    //   • navigator.webdriver = true → patché → undefined
    //   • Permissions API "notifications" → "prompt" (headless retourne souvent "denied")
    const navLanguages = ["fr-FR", "fr", "en-US", "en"];
    const navPlatform = platformFromUA(this._ua);
    await (page as any).evaluateOnNewDocument(
      (langs: string[], platform: string) => {
        // ── webdriver ─────────────────────────────────────────────────────────
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });

        // ── platform + languages ──────────────────────────────────────────────
        Object.defineProperty(navigator, "platform", { get: () => platform });
        Object.defineProperty(navigator, "languages", { get: () => langs });

        // ── navigator.plugins + mimeTypes (PDF plugin simulé) ────────────────
        // Chrome réel expose au minimum : Chrome PDF Plugin, Chrome PDF Viewer,
        // Native Client. Sans ces plugins, le score bot CF est très élevé.
        const makeMime = (type: string, desc: string, suffixes: string) => {
          const m = { type, description: desc, suffixes, enabledPlugin: null as any };
          return m;
        };
        const pdfMime1 = makeMime("application/pdf", "Portable Document Format", "pdf");
        const pdfMime2 = makeMime("text/pdf", "Portable Document Format", "pdf");
        const pdfPlugin = {
          name: "PDF Viewer",
          description: "Portable Document Format",
          filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
          length: 2,
          0: pdfMime1,
          1: pdfMime2,
          item: (i: number) => [pdfMime1, pdfMime2][i] ?? null,
          namedItem: (n: string) => ({ "application/pdf": pdfMime1, "text/pdf": pdfMime2 }[n] ?? null),
        };
        const pluginArr = [pdfPlugin];
        Object.defineProperty(pluginArr, "item", { value: (i: number) => pluginArr[i] ?? null });
        Object.defineProperty(pluginArr, "namedItem", { value: (n: string) => pluginArr.find((p) => p.name === n) ?? null });
        Object.defineProperty(pluginArr, "refresh", { value: () => {} });
        Object.defineProperty(navigator, "plugins", {
          get: () => pluginArr,
          configurable: true,
        });
        const mimeArr = [pdfMime1, pdfMime2];
        Object.defineProperty(mimeArr, "item", { value: (i: number) => mimeArr[i] ?? null });
        Object.defineProperty(mimeArr, "namedItem", {
          value: (n: string) => mimeArr.find((m) => m.type === n) ?? null,
        });
        Object.defineProperty(navigator, "mimeTypes", {
          get: () => mimeArr,
          configurable: true,
        });

        // ── Permissions API → "notifications" retourne "prompt" ───────────────
        // En headless Chromium sans profil utilisateur, Notification.permission
        // peut retourner "denied" (aucun prompt disponible) → signal bot fort.
        const origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
        if (origQuery) {
          (navigator.permissions as any).query = (params: any) => {
            if (params?.name === "notifications") {
              return Promise.resolve({ state: "prompt", onchange: null });
            }
            return origQuery(params);
          };
        }

        // ── WebGL renderer / vendor (cache SwiftShader) ───────────────────────
        // SwiftShader est la signature exacte d'un GPU virtuel headless.
        // CF le détecte via getParameter(UNMASKED_RENDERER_WEBGL / UNMASKED_VENDOR_WEBGL).
        // On simule un Intel Iris (GPU intégré commun sur Win 10 / Mac).
        const UNMASKED_VENDOR   = 0x9245;
        const UNMASKED_RENDERER = 0x9246;
        const fakeVendor   = "Intel Inc.";
        const fakeRenderer = platform === "MacIntel"
          ? "Intel Iris OpenGL Engine"
          : "Intel(R) UHD Graphics 620";

        const patchWebGL = (Ctx: any) => {
          if (!Ctx) return;
          const orig = Ctx.prototype.getParameter;
          Ctx.prototype.getParameter = function(param: number) {
            if (param === UNMASKED_VENDOR)   return fakeVendor;
            if (param === UNMASKED_RENDERER) return fakeRenderer;
            return orig.call(this, param);
          };
        };
        patchWebGL((window as any).WebGLRenderingContext);
        patchWebGL((window as any).WebGL2RenderingContext);

        // ── window.chrome enrichi ─────────────────────────────────────────────
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
      navPlatform,
    );

    // ── Étape 3 : Purge complète des données CF stockées dans le profil ─────────
    //
    // PROBLÈME : Le profil persistant (/tmp/spain-cf-profile) accumule des données
    // CF stales : tokens JSD expirés dans localStorage/IndexedDB, service workers
    // qui servent du JS CF mis en cache (avec nonce périmé), etc.
    //
    // SYMPTÔME observé : CF reçoit un JSD oneshot avec timestamp vieux de 21 jours
    // → CF rejette silencieusement → /main/ retourne 200 text/html 0B.
    //
    // Network.clearBrowserCache ne nettoie que le cache HTTP disk — PAS :
    //   • localStorage / sessionStorage (tokens JSD CF stockés ici)
    //   • IndexedDB (CF bot management data)
    //   • Service Workers + cache_storage (SW peut intercepter et servir du JS CF périmé)
    //
    // Fix : Storage.clearDataForOrigin avec toutes les catégories SAUF cookies
    // (on garde cf_clearance + PHPSESSID déjà en mémoire pour le profil).
    // Ensuite résolution cf_clearance fraîche via Network.deleteCookies.
    try {
      const cdpStorage = await page.createCDPSession();
      // Supprimer le cf_clearance du profil (on va injecter le cf_clearance CapSolver frais)
      await cdpStorage.send("Network.deleteCookies", {
        name: "cf_clearance",
        domain: ".citaconsular.es",
      });
      // Purger storage CF (localStorage, IndexedDB, ServiceWorkers, CacheStorage)
      // SANS cookies pour conserver PHPSESSID et autres cookies applicatifs.
      await cdpStorage.send("Storage.clearDataForOrigin", {
        origin: "https://www.citaconsular.es",
        storageTypes: "local_storage,session_storage,indexeddb,service_workers,cache_storage",
      });
      await cdpStorage.detach().catch(() => {});
      console.log("[spain-pb] 🗑️ Profil CF purgé (cf_clearance + localStorage/SW/IndexedDB — tokens JSD expirés supprimés)");
    } catch (purgeErr) {
      console.warn(`[spain-pb] ⚠️ Purge storage CF (non-fatal): ${purgeErr}`);
    }

    // Vider le cache HTTP navigateur : CF sert ses scripts JSD depuis CDN — sans
    // cache-bust, le même script (avec nonce périmé) est retourné du cache local.
    try {
      const cdpCache = await page.createCDPSession();
      await cdpCache.send("Network.clearBrowserCache");
      await cdpCache.detach().catch(() => {});
      console.log("[spain-pb] 🗑️ Cache HTTP navigateur vidé (scripts JSD frais)");
    } catch { /* non-fatal */ }

    // ── Étape 4 : Injecter le cf_clearance CapSolver dans le browser ──────────
    // On utilise CDP Network.setCookie directement pour éviter le bug partitionKey
    // de Puppeteer 25+ avec Chromium <130 (page.setCookie appelle deleteCookies
    // avec partitionKey non supporté par le CDP de Chromium v123).
    try {
      const cdpCookie = await page.createCDPSession();
      await cdpCookie.send("Network.setCookie", {
        name: "cf_clearance",
        value: cfClearance,
        domain: ".citaconsular.es",
        path: "/",
        secure: true,
        sameSite: "None",
      });
      await cdpCookie.detach().catch(() => {});
      console.log(`[spain-pb] ✅ cf_clearance CapSolver injecté dans Chromium`);
    } catch (injectErr) {
      console.error(`[spain-pb] ❌ Injection cookie CapSolver échouée: ${injectErr}`);
      return null;
    }

    // ── Étape 5 : Armer le listener XHR /main/ AVANT de naviguer ─────────────
    // CF bloque les navigations top-level (page.goto) vers /main/ même avec un
    // cf_clearance valide → retourne 0B. Mais quand le JS du portail appelle
    // /main/ en XHR/fetch après le clic Continuar, CF laisse passer la réponse
    // (sous-requête dans un contexte browser réel, pas une navigation top-level).
    // On écoute page.on('response') + CDP Network pour capturer le body.
    let capturedMainBody = "";
    // Timestamp quand le JSD oneshot a répondu — utilisé pour temporiser le fetch fallback.
    let jsdOneShotAt = 0;

    // CDP Network listener — plus fiable que page.on('response') pour les ressources
    // script (JSONP) car il fournit requestId → Network.getResponseBody peut être
    // appelé même si la réponse est déjà traitée par le browser.
    let cdpNet: any = null;
    const pendingMainRequests = new Map<string, string>(); // requestId → url
    const pendingJsdRequests  = new Map<string, string>(); // requestId → url (JSD oneshot)
    try {
      cdpNet = await page.createCDPSession();
      await cdpNet.send("Network.enable", {});

      cdpNet.on("Network.requestWillBeSent", (ev: any) => {
        const url: string = ev.request?.url ?? "";
        if (url.includes("citaconsular.es")) {
          console.log(`[spain-pb] 🌐 req: ${ev.request.method} ${url.slice(0, 120)}`);
        }
        if (url.includes("onlinebookings/main")) {
          pendingMainRequests.set(ev.requestId, url);
        }
        // Track JSD oneshot to capture response (tells us if CF accepted the token)
        if (url.includes("jsd/oneshot")) {
          pendingJsdRequests.set(ev.requestId, url);
        }
      });

      cdpNet.on("Network.responseReceived", (ev: any) => {
        const url: string = ev.response?.url ?? "";
        if (url.includes("onlinebookings/main")) {
          console.log(
            `[spain-pb] 📡 /main/ responseReceived: status=${ev.response.status}` +
            ` type=${ev.type} mimeType=${ev.response.mimeType}` +
            ` cf-ray=${ev.response.headers?.["cf-ray"] ?? "none"}`,
          );
        }
        // Log JSD oneshot response — set-cookie cf_clearance = CF accepted the challenge
        if (url.includes("jsd/oneshot")) {
          const setCookie: string = ev.response.headers?.["set-cookie"] ?? "";
          const hasCfClearance = setCookie.includes("cf_clearance");
          console.log(
            `[spain-pb] 🔑 JSD oneshot resp: status=${ev.response.status}` +
            ` cf-ray=${ev.response.headers?.["cf-ray"] ?? "none"}` +
            ` new-cf_clearance=${hasCfClearance ? "✅ oui (challenge accepté)" : "❌ non (rejeté ou pas d'upgrade)"}`,
          );
          jsdOneShotAt = Date.now(); // marquer le moment pour le délai post-JSD
          pendingJsdRequests.delete(ev.requestId);
        }
      });

      cdpNet.on("Network.loadingFinished", async (ev: any) => {
        if (!pendingMainRequests.has(ev.requestId)) return;
        pendingMainRequests.delete(ev.requestId);
        try {
          const { body, base64Encoded } = await cdpNet.send("Network.getResponseBody", {
            requestId: ev.requestId,
          });
          const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
          console.log(`[spain-pb] 📥 /main/ CDP body: ${decoded.length}B snippet="${decoded.slice(0, 80)}"`);
          if (decoded.length > capturedMainBody.length) {
            capturedMainBody = decoded;
          }
        } catch (cdpBodyErr) {
          console.warn(`[spain-pb] ⚠️ CDP getResponseBody /main/: ${cdpBodyErr}`);
        }
      });

      cdpNet.on("Network.loadingFailed", (ev: any) => {
        if (!pendingMainRequests.has(ev.requestId)) return;
        pendingMainRequests.delete(ev.requestId);
        console.warn(`[spain-pb] ❌ /main/ loadingFailed: ${ev.errorText}`);
      });
    } catch (cdpErr) {
      console.warn(`[spain-pb] ⚠️ CDP Network setup (non-fatal): ${cdpErr}`);
    }

    // Fallback page.on('response') — filtre large (sans slash final) pour ne
    // pas rater les URLs comme /onlinebookings/main?... (sans trailing slash)
    const mainResponseHandler = async (response: any) => {
      try {
        const url: string = response.url();
        if (!url.includes("onlinebookings/main")) return;
        const reqType: string = response.request().resourceType();
        if (reqType === "document") return;
        const status: number = response.status();
        const headers = response.headers();
        const body = await response.text().catch(() => "");
        console.log(
          `[spain-pb] 📡 page.on(response) /main/: status=${status} type=${reqType}` +
          ` size=${body.length}B cf-ray=${headers["cf-ray"] ?? "none"}`,
        );
        if (body.length > capturedMainBody.length) {
          capturedMainBody = body;
        }
      } catch { /* non-fatal */ }
    };
    page.on("response", mainResponseHandler);

    // ── Étape 6 : Naviguer vers le portail puis cliquer Continuar ────────────
    // Avec le cf_clearance frais injecté + UA synchronisé, CF accepte la page
    // portail sans re-challenger. Le JS du portail charge, on clique Continuar,
    // et le listener XHR capture la réponse /main/.
    let prefetchedMainHtml = "";
    try {
      console.log(`[spain-pb] 🖱️ Navigation portail → Continuar → interception XHR /main/…`);

      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (navErr) {
        const errStr = String(navErr);
        if (errStr.includes("ERR_TOO_MANY_RETRIES")) {
          // Proxy auth Chromium bloqué — le browser est cassé, fermer et remonter une erreur
          console.error(`[spain-pb] ❌ ERR_TOO_MANY_RETRIES — proxy auth Chromium bloqué`);
          try { await this._browser?.close(); } catch { /* non-fatal */ }
          this._browser = null;
          page.off("response", mainResponseHandler);
          return null;
        }
        // Timeout sur un challenge interactif — non-fatal, on continue
        console.warn(`[spain-pb] ⚠️ goto() portail timeout/erreur (non-fatal): ${navErr}`);
      }

      // Rafraîchir le cf_clearance post-navigation (CF peut émettre un nouveau token)
      try {
        const postNavCookies = await page.cookies("https://www.citaconsular.es");
        const postCf = postNavCookies.find((c) => c.name === "cf_clearance");
        if (postCf?.value && postCf.value !== cfClearance) {
          console.log(`[spain-pb] 🔑 cf_clearance post-navigation: ${postCf.value.slice(0, 40)}…`);
        }
      } catch { /* non-fatal */ }

      // Attendre et cliquer le bouton Continuar (max 25s, check toutes les 2s)
      let continueClicked = false;
      const contDeadline = Date.now() + 25_000;
      while (Date.now() < contDeadline && !continueClicked) {
        continueClicked = await page.evaluate(() => {
          // Sélecteur exact bundle custom.js
          const btn = document.getElementById("idDivBktCustomContinueButton");
          if (btn && (btn as HTMLElement).offsetParent !== null) { (btn as HTMLElement).click(); return true; }
          // Fallback : container custom → bouton "continuar/continue"
          const container = document.getElementById("idBktDefaultCustomContainer");
          if (container) {
            const cands = container.querySelectorAll("button, a, div, input[type='button'], input[type='submit']");
            for (let i = 0; i < cands.length; i++) {
              const el = cands[i] as HTMLElement;
              if (el.offsetParent !== null && /continuar|continue/i.test(el.textContent || "")) {
                el.click(); return true;
              }
            }
          }
          // Fallback global par texte
          const allClickable = document.querySelectorAll("a, button, [role='button'], div[onclick]");
          for (let i = 0; i < allClickable.length; i++) {
            const el = allClickable[i] as HTMLElement;
            const txt = (el.textContent || "").trim().toLowerCase();
            if ((txt.indexOf("continu") >= 0 || txt.indexOf("siguiente") >= 0) && el.offsetParent !== null) {
              el.click(); return true;
            }
          }
          return false;
        }).catch(() => false);

        if (!continueClicked) {
          const domState = await page.evaluate(() => ({
            hash: window.location.hash,
            title: document.title.slice(0, 60),
            hasBtn: !!document.getElementById("idDivBktCustomContinueButton"),
            btnVisible: (() => { const b = document.getElementById("idDivBktCustomContinueButton"); return b ? b.offsetParent !== null : false; })(),
            hasWidget: !!document.getElementById("idBktWidgetDefaultBodyContainer"),
            hasCustom: !!document.getElementById("idBktDefaultCustomContainer"),
            bodySnippet: (document.body?.innerText ?? "").slice(0, 120).replace(/\n/g, " "),
          })).catch(() => ({ error: "evaluate failed" }));
          console.log(`[spain-pb] 🔍 DOM: ${JSON.stringify(domState)}`);
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }

      if (continueClicked) {
        console.log(`[spain-pb] ✅ Continuar cliqué — attente XHR /main/ (max 15s)…`);
        // Attendre jusqu'à 15s que le listener XHR capture la réponse /main/
        const xhrDeadline = Date.now() + 15_000;
        while (Date.now() < xhrDeadline && capturedMainBody.length < 100) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (capturedMainBody.length > 100) {
          prefetchedMainHtml = capturedMainBody;
          console.log(`[spain-pb] 📦 /main/ XHR capturé via listener (${prefetchedMainHtml.length}B)`);
        } else {
          console.warn(
            `[spain-pb] ⚠️ XHR /main/ non capturé via listener (${capturedMainBody.length}B) — ` +
            `tentative fetch direct depuis contexte browser…`,
          );
        }
      } else {
        console.warn(`[spain-pb] ⚠️ Bouton Continuar introuvable après 25s — tentative fetch direct /main/…`);
      }
    } catch (flowErr) {
      console.warn(`[spain-pb] ⚠️ Flow portail→Continuar échoué (non-fatal): ${flowErr}`);
    } finally {
      page.off("response", mainResponseHandler);
      if (cdpNet) {
        cdpNet.detach().catch(() => {});
        cdpNet = null;
      }
    }

    // ── Fallback : fetch /main/ directement depuis le contexte browser ────────
    //
    // Si le listener n'a rien capturé (widget Bookitit non initialisé, JS bloqué,
    // nonce JSD expiré…), on exécute le fetch depuis le browser via page.evaluate().
    //
    // POURQUOI ça marche là où page.goto() échoue :
    //   - page.goto(mainUrl) = navigation top-level → CF challenge complet (0B)
    //   - fetch() dans page.evaluate() = sub-request XHR dans un contexte browser
    //     avec cf_clearance valide + proxy Decodo + UA synchronisé → CF laisse passer
    //   - Sec-Fetch-Site: same-origin (le browser est sur citaconsular.es) → CF
    //     ne re-challenge pas les sub-requests depuis un contexte browser valide
    //
    // POURQUOI impit échoue mais fetch() ici réussit :
    //   - impit = TLS fingerprint non-Chrome → CF bloque même avec cf_clearance
    //   - fetch() dans Chromium = TLS fingerprint Chrome réel → CF accepte
    if (prefetchedMainHtml.length < 100) {
      const publickey = targetUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
      const cbName = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
      const mainQuery = new URLSearchParams({
        callback: cbName,
        type: "default",
        publickey,
        lang: "es",
        version: "4",
        src: targetUrl.replace(/\/?$/, "/"),
        _: String(Date.now()),
      });
      const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${mainQuery}`;

      // S'assurer qu'on est sur un contexte same-origin citaconsular.es
      // (si page.goto portail a échoué, on pourrait être sur about:blank ou ailleurs)
      const currentOrigin: string = await page.evaluate(() => window.location.origin).catch(() => "");
      if (!currentOrigin.includes("citaconsular.es")) {
        console.log(`[spain-pb] 🔄 Pas sur citaconsular.es (${currentOrigin}) — navigation root pour contexte same-origin…`);
        await page.goto("https://www.citaconsular.es/", {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        }).catch((e: unknown) => console.warn(`[spain-pb] ⚠️ Navigation root (non-fatal): ${e}`));
      }

      // Temporisation post-JSD : le PHPSESSID peut nécessiter ~1.5s pour être
      // synchronisé côté backend Bookitit après le JSD oneshot. Sans ce délai,
      // le fetch arrive trop tôt et le serveur retourne 0B.
      const msSinceJsd = jsdOneShotAt > 0 ? Date.now() - jsdOneShotAt : 0;
      const waitMs = Math.max(0, 1_500 - msSinceJsd);
      if (waitMs > 0) {
        console.log(`[spain-pb] ⏳ Délai post-JSD ${waitMs}ms (sync backend Bookitit)…`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      console.log(`[spain-pb] 🎯 Fetch direct /main/ via page.evaluate()…`);
      const evalBody: string = await page.evaluate(async (url: string) => {
        try {
          const resp = await fetch(url, {
            method: "GET",
            // "include" transmet PHPSESSID + cf_clearance même en cross-origin.
            // "same-origin" omettait les cookies si le contexte de la page n'était
            // pas exactement sur citaconsular.es — PHPSESSID absent = 0B.
            credentials: "include",
            headers: {
              "Accept": "*/*",
              "X-Requested-With": "XMLHttpRequest",
            },
          });
          if (!resp.ok) return `__ERR_STATUS_${resp.status}`;
          return await resp.text();
        } catch (e: unknown) {
          return `__ERR_FETCH_${String(e).slice(0, 80)}`;
        }
      }, mainUrl).catch(() => "");

      if (evalBody.length > 100 && !evalBody.startsWith("__ERR_")) {
        prefetchedMainHtml = evalBody;
        console.log(`[spain-pb] 📦 /main/ fetch direct réussi (${evalBody.length}B) — scanner l'utilisera directement`);
      } else {
        console.warn(
          `[spain-pb] ⚠️ Fetch direct /main/ échoué: "${evalBody.slice(0, 120)}" — scanner devra retenter`,
        );
      }
    }

    // ── Étape 7 : Extraire les cookies + construire la session ────────────────
    const allPuppeteerCookies = await page.cookies("https://www.citaconsular.es");
    const allCookies = allPuppeteerCookies.map((c) => ({ name: c.name, value: c.value }));

    // Récupérer le cf_clearance final (peut avoir été mis à jour par CF post-Continuar)
    const finalCf = allCookies.find((c) => c.name === "cf_clearance")?.value || cfClearance;

    const createdAt = Date.now();
    const elapsed = Math.round((createdAt - t0) / 1000);
    console.log(
      `[spain-pb] ✅ Session CF prête (${elapsed}s) | ${allCookies.length} cookies` +
      ` | prefetch: ${prefetchedMainHtml.length}B | expire ~${Math.round(CF_CLEARANCE_TTL_MS / 60_000)}min`,
    );
    console.log(`[spain-pb]    cf_clearance: ${finalCf.slice(0, 40)}…`);

    const session: SpainCfSession = {
      cfClearance: finalCf,
      cfDomain: ".citaconsular.es",
      soaxProxyUrl: proxyUrl ?? "",
      userAgent: this._ua,
      createdAt,
      expiresAt: createdAt + CF_CLEARANCE_TTL_MS,
      allCookies,
      extraHeaders: {},
      source: "playwright",
      ...(prefetchedMainHtml ? { prefetchedMainHtml } : {}),
    };

    this._cachedSession = session;

    // Sync dans le cache de spain-soax-solver.ts pour que runSpainHttpProbe
    // (qui appelle ensureSpainCfSession en interne) trouve la session directement
    // sans déclencher un solve CapSolver.
    setActiveSpainCfSession(session);

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
      if (proxyAuth) await setupPageProxyAuth(page, proxyAuth);

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
        // CDP direct pour éviter le bug partitionKey Puppeteer 25+ / Chromium <130
        const cdpInject = await page.createCDPSession();
        for (const ck of cookiesToInject) {
          await cdpInject.send("Network.setCookie", ck).catch(() => {});
        }
        await cdpInject.detach().catch(() => {});
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

/**
 * Équivalent de `isSpainCfSessionExpiringSoon()` pour le mode persistent-browser.
 *
 * Si le manager PB a sa propre session en cache → on utilise son TTL.
 * Sinon (Puppeteer indisponible sur cet env) → on consulte la session soax fallback,
 * afin d'éviter un re-solve proactif à chaque cycle alors que la session est valide.
 */
export function isSpainPersistentBrowserSessionExpiringSoon(): boolean {
  if (spainPersistentBrowser.getSession()) {
    return spainPersistentBrowser.isSessionExpiringSoon();
  }
  // PB session absente → déléguer au cache soax (fallback actif)
  return isSpainCfSessionExpiringSoon();
}

/**
 * Équivalent de `getActiveSpainCfSession()` pour le mode persistent-browser.
 * Retourne la session PB si disponible, sinon la session soax fallback.
 */
export function getActiveSpainPersistentBrowserSession(): SpainCfSession | undefined {
  return spainPersistentBrowser.getSession() ?? getActiveSpainCfSession() ?? undefined;
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
