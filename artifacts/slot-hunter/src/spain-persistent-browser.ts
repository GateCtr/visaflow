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
    this._ua = randomChromeUA();
    this._viewport = randomViewport();

    const maskedProxy = proxyUrl
      ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 80)
      : "direct (no proxy)";
    console.log(`[spain-pb] 🚀 Lancement Chromium persistant`);
    console.log(`[spain-pb]    userDataDir : ${CF_PROFILE_DIR}`);
    console.log(`[spain-pb]    Proxy       : ${maskedProxy}`);
    console.log(`[spain-pb]    UA          : ${this._ua.slice(0, 80)}`);

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

    // Script d'init stealth : webdriver + platform + languages + chrome enrichi.
    // navigator.platform DOIT correspondre au UA — CF détecte immédiatement
    // un UA Macintosh avec platform="Linux x86_64" ou "Win32".
    const navLanguages = ["fr-FR", "fr", "en-US", "en"];
    const navPlatform = platformFromUA(this._ua);
    await (page as any).evaluateOnNewDocument(
      (langs: string[], platform: string) => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "platform", { get: () => platform });
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
      navPlatform,
    );

    // Supprimer le cf_clearance du profil avant de naviguer.
    //
    // POURQUOI : Le profil persistant accumule des clearances "dégradées" — émises
    // par CF pendant les tentatives Continuar bloquées sur "Un instant…". Ces
    // clearances fonctionnent pour le portail HTML mais PAS pour /main/ (CF distingue
    // les endpoints). En les supprimant, on force soit :
    //   A. Chromium résout Turnstile nativement → clearance fraîche valide pour TOUT
    //   B. CapSolver appelé → clearance liée au proxy Decodo + /main/ direct capturé
    // PHPSESSID et les autres cookies de profil (localStorage, GA) sont conservés.
    try {
      const cdpDel = await page.createCDPSession();
      await cdpDel.send("Network.deleteCookies", {
        name: "cf_clearance",
        domain: ".citaconsular.es",
      });
      await cdpDel.detach().catch(() => {});
      console.log("[spain-pb] 🗑️ cf_clearance du profil supprimé (résolution fraîche)");
    } catch { /* non-fatal */ }

    // Vider le cache navigateur : CF sert jsd/main.js depuis son CDN avec un nonce
    // à usage unique ; sans cache-bust, le même nonce (déjà consommé) est retourné.
    try {
      const cdpCache = await page.createCDPSession();
      await cdpCache.send("Network.clearBrowserCache");
      await cdpCache.detach().catch(() => {});
      console.log("[spain-pb] 🗑️ Cache navigateur vidé (nonce JSD frais)");
    } catch { /* non-fatal */ }

    // Naviguer vers le widget
    // ERR_TOO_MANY_RETRIES = Chromium bloqué en boucle d'auth proxy (typique en prod
    // avec Decodo ISP sticky-IP) → inutile de poller, aller directement au fallback CapSolver.
    let skipPollGoDirectToCapSolver = false;
    try {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: CF_SOLVE_TIMEOUT_MS,
      });
    } catch (navErr) {
      const errStr = String(navErr);
      if (errStr.includes("ERR_TOO_MANY_RETRIES")) {
        console.warn(`[spain-pb] ⚠️ ERR_TOO_MANY_RETRIES — proxy auth Chromium bloqué → skip poll, CapSolver direct`);
        skipPollGoDirectToCapSolver = true;
        // Fermer le browser cassé pour éviter que page.cookies() ne bloque
        try { await this._browser?.close(); } catch { /* non-fatal */ }
        this._browser = null;
      } else {
        // La navigation peut timeout sur un challenge interactif long — on continue le poll
        console.warn(`[spain-pb] ⚠️ goto() timeout/erreur (non-fatal, poll cf_clearance…): ${navErr}`);
      }
    }

    // Poll cf_clearance (sauté si ERR_TOO_MANY_RETRIES)
    const deadline = Date.now() + CF_SOLVE_TIMEOUT_MS;
    let cfClearance = "";

    if (!skipPollGoDirectToCapSolver) {
      while (Date.now() < deadline) {
        try {
          // Timeout sur chaque appel CDP pour éviter un hang si le browser est dans un état cassé
          const cookies = await Promise.race([
            page.cookies("https://www.citaconsular.es"),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("cookies-timeout")), 5_000),
            ),
          ]);
          const cfCookie = cookies.find((c) => c.name === "cf_clearance");
          if (cfCookie?.value) {
            cfClearance = cfCookie.value;
            break;
          }
        } catch {
          // Page peut être en cours de redirection ou CDP lent — retry
        }
        await new Promise((r) => setTimeout(r, CF_POLL_INTERVAL_MS));
      }
    }

    // Indique que CapSolver a déjà navigué vers /main/ et récupéré un PHPSESSID —
    // le flow Continuar ci-dessous sera sauté pour éviter de re-déclencher Turnstile.
    let capsolverHandledMain = false;
    // Corps JSONP de /main/ capturé via Chromium — stocké dans session.prefetchedMainHtml
    // pour que le scanner l'utilise directement (impit ne peut pas accéder à /main/).
    let capsolverPrefetchedMain = "";

    if (!cfClearance) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.warn(`[spain-pb] ⚠️ cf_clearance non obtenu après ${elapsed}s — fallback CapSolver…`);

      // ─── Fallback CapSolver ─────────────────────────────────────────────
      // Headless Chromium seul ne peut pas toujours résoudre le challenge CF
      // (Turnstile interactif). On utilise CapSolver pour obtenir un cf_clearance
      // lié au même proxy, puis on l'injecte dans le profil Chromium pour que
      // les appels HTTP suivants soient acceptés par CF.
      const capsolverKey = process.env.CAPSOLVER_API_KEY;
      const proxyForCap = this.getProxyUrl() ?? "";
      if (!capsolverKey || !proxyForCap) {
        console.error(
          "[spain-pb] ❌ Fallback CapSolver requis mais " +
          (!capsolverKey ? "CAPSOLVER_API_KEY manquant" : "aucun proxy configuré"),
        );
        return null;
      }

      const capResult = await solveSpainCloudflare(targetUrl, capsolverKey, proxyForCap);
      if (!capResult.success || !capResult.session) {
        console.error(`[spain-pb] ❌ Fallback CapSolver échoué: ${capResult.error ?? "erreur inconnue"}`);
        return null;
      }

      // Injecter le cf_clearance CapSolver dans le browser, puis re-naviguer
      // vers le portail pour que CF exécute son JSD Oneshot côté navigateur.
      // Cela produit un cf_clearance "upgradé" accepté par TOUS les endpoints CF
      // (portail + /onlinebookings/main/). Sans ce deuxième navigate, le cf_clearance
      // CapSolver seul passe /main/ mais est bloqué (403) sur la page portail.
      try {
        // Utiliser CDP Network.setCookie directement pour éviter le bug partitionKey
        // de Puppeteer 25+ avec Chromium <130 (page.setCookie appelle deleteCookies
        // avec partitionKey non supporté par le CDP de Chromium v123).
        const cdpForCookie = await page.createCDPSession();
        await cdpForCookie.send("Network.setCookie", {
          name: "cf_clearance",
          value: capResult.session.cfClearance,
          domain: ".citaconsular.es",
          path: "/",
          secure: true,
          sameSite: "None",
        });
        await cdpForCookie.detach().catch(() => {});
        cfClearance = capResult.session.cfClearance;
        console.log(`[spain-pb] ✅ cf_clearance CapSolver injecté: ${cfClearance.slice(0, 40)}…`);

        // ── Synchroniser le UA avec celui de CapSolver ────────────────────────
        // CF lie le cf_clearance au UA qui a résolu le challenge.
        // Si notre browser a un UA différent (ex: Macintosh vs Windows NT de CapSolver),
        // CF re-challenge la page → "Un instant…" permanent.
        // Fix : adopter le UA de CapSolver avant de re-naviguer.
        const capUA = capResult.session.userAgent;
        if (capUA && capUA !== this._ua) {
          await page.setUserAgent(capUA);
          this._ua = capUA;
          console.log(`[spain-pb] 🔄 UA synchronisé avec CapSolver: ${capUA.slice(0, 70)}`);
        }
      } catch (injectErr) {
        console.error(`[spain-pb] ❌ Injection cookie CapSolver échouée: ${injectErr}`);
        return null;
      }

      // Navigation directe vers /main/ pour obtenir PHPSESSID + contenu JSONP.
      //
      // POURQUOI on n'essaie plus de re-naviguer vers le portail :
      //   - Le portail (Turnstile) utilise un nonce JSD à usage unique.
      //   - CapSolver consomme ce nonce lors de sa résolution.
      //   - jsd/main.js est mis en cache CF → toutes les navigations suivantes
      //     reçoivent le MÊME nonce (déjà brûlé) → CF re-challenge → "Un instant…".
      //   - Network.clearBrowserCache ne suffit pas : le cache est côté CF, pas local.
      //
      // POURQUOI /main/ via le browser et PAS via impit :
      //   - CF vérifie le TLS/HTTP2 fingerprint pour /main/ et retourne 0B (text/html)
      //     pour les requêtes impit, même avec un cf_clearance valide.
      //   - Le browser Chromium a le bon fingerprint → CF laisse passer → JSONP retourné.
      //   - On stocke le body JSONP dans session.prefetchedMainHtml pour que le scanner
      //     le réutilise sans faire d'appel impit (qui échouerait de toute façon).
      const mainPublickey = targetUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
      const mainCallback = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
      const mainQuery = new URLSearchParams({
        callback: mainCallback,
        type: "default",
        publickey: mainPublickey,
        lang: "es",
        version: "4",
        src: targetUrl.replace(/\/?$/, "/"),
        _: String(Date.now()),
      });
      const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${mainQuery}`;

      console.log(`[spain-pb] 🎯 Navigation directe /main/ via Chromium (bypass portail Turnstile)…`);
      try {
        await page.goto(mainUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const mainCookies = await page.cookies("https://www.citaconsular.es");
        const phpSessIdDirect = mainCookies.find((c) => c.name === "PHPSESSID")?.value;

        // Capturer le body JSONP depuis le viewport du browser.
        // La réponse est un appel JSONP brut (ex: jQueryBookingXXX("...html..."));)
        // que le browser affiche comme texte dans document.body.
        const mainBodyRaw = await page.evaluate(
          () => (document.body?.innerText ?? document.documentElement?.innerText ?? "").trim(),
        ).catch(() => "");

        if (phpSessIdDirect) {
          console.log(
            `[spain-pb] ✅ PHPSESSID obtenu via /main/ direct: ${phpSessIdDirect.slice(0, 12)}… | ` +
            `body: ${mainBodyRaw.length}B`,
          );
          if (mainBodyRaw.length > 100) {
            // JSONP valide → on le mémorise pour le scanner
            capsolverPrefetchedMain = mainBodyRaw;
            console.log(`[spain-pb] 📦 /main/ JSONP capturé (${mainBodyRaw.length}B) — scanner l'utilisera directement`);
          } else {
            console.warn(`[spain-pb] ⚠️ /main/ body trop court (${mainBodyRaw.length}B) — scanner devra retenter`);
          }
        } else {
          // Diagnostic : CF a peut-être bloqué /main/ aussi
          console.warn(
            `[spain-pb] ⚠️ /main/ direct: pas de PHPSESSID. ` +
            `Body: "${mainBodyRaw.slice(0, 200)}"`,
          );
        }
      } catch (mainNavErr) {
        console.warn(`[spain-pb] ⚠️ Navigation /main/ direct (non-fatal): ${mainNavErr}`);
      }

      // Marquer que le path CapSolver a déjà géré /main/ → on saute le flow Continuar
      capsolverHandledMain = true;
    }

    // ── Flow complet portail → Continuar → #services → /main/ ───────────────
    // Ce flow est nécessaire quand Chromium a résolu CF nativement : il faut cliquer
    // Continuar pour que Bookitit charge /main/ et émettre un PHPSESSID.
    //
    // SKIPPÉ si capsolverHandledMain=true : CapSolver a déjà navigué vers /main/
    // directement (bypass portail Turnstile) — PHPSESSID déjà dans les cookies.
    if (!capsolverHandledMain) {
    console.log(`[spain-pb] 🖱️ Portail → Continuar → #services pour valider cf_clearance sur /main/…`);
    try {
      // Si on n'est plus sur la page portail (cas CapSolver déjà re-navigué), re-goto
      const currentUrl = page.url();
      if (!currentUrl.includes("citaconsular.es/es/hosteds")) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch((e: unknown) => {
          console.warn(`[spain-pb] ⚠️ goto portail (non-fatal): ${e}`);
        });
      } else {
        // Déjà sur le portail — attendre que le JS finisse de s'initialiser
        await new Promise((r) => setTimeout(r, 2_500));
      }

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
          // Diagnostic : loguer l'état DOM pour comprendre pourquoi le bouton est absent
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
        console.log(`[spain-pb] ✅ Continuar cliqué — attente hash #services (max 12s)…`);
        for (let w = 0; w < 12; w++) {
          await new Promise((r) => setTimeout(r, 1_000));
          const hash: string = await page.evaluate(() => window.location.hash).catch(() => "");
          if (hash && hash !== "" && hash !== "#custom") {
            console.log(`[spain-pb] ✅ Hash: "${hash}" — JSONP /main/ en cours`);
            break;
          }
        }
        // Laisser les requêtes JSONP /main/ + companions se terminer
        await new Promise((r) => setTimeout(r, 4_000));
      } else {
        console.warn(`[spain-pb] ⚠️ Bouton Continuar introuvable après 25s — cookies capturés sans clic`);
      }

      // Rafraîchir le cf_clearance post-Continuar (CF peut émettre un nouveau token)
      try {
        const postContCookies = await page.cookies("https://www.citaconsular.es");
        const postCf = postContCookies.find((c) => c.name === "cf_clearance");
        if (postCf?.value && postCf.value !== cfClearance) {
          cfClearance = postCf.value;
          console.log(`[spain-pb] 🔑 cf_clearance post-Continuar: ${cfClearance.slice(0, 40)}…`);
        }
      } catch { /* non-fatal */ }
    } catch (continueErr) {
      console.warn(`[spain-pb] ⚠️ Flow Continuar échoué (non-fatal): ${continueErr}`);
    }
    } // end if (!capsolverHandledMain)

    // ── Navigation universelle vers /main/ si prefetch pas encore fait ────────
    // Quand le cf_clearance vient du CACHE PROFIL (pas CapSolver), capsolverPrefetchedMain
    // est vide. On tente /main/ via Chromium ici aussi pour :
    //   1. Obtenir un PHPSESSID frais (si celui du profil est expiré)
    //   2. Capturer le JSONP /main/ → prefetchedMainHtml (impit ne peut pas y accéder)
    //
    // On utilise l'UA courant (peut être Macintosh ou Windows NT selon le profil).
    // CF fait confiance à Decodo ISP pour /main/ → devrait passer même si le portail
    // a refusé (UA mismatch avec le nonce Turnstile).
    if (!capsolverPrefetchedMain) {
      const ubPublickey = targetUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
      const ubCallback = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
      const ubQuery = new URLSearchParams({
        callback: ubCallback,
        type: "default",
        publickey: ubPublickey,
        lang: "es",
        version: "4",
        src: targetUrl.replace(/\/?$/, "/"),
        _: String(Date.now()),
      });
      const ubUrl = `https://www.citaconsular.es/onlinebookings/main/?${ubQuery}`;
      console.log(`[spain-pb] 🎯 Navigation universelle /main/ via Chromium…`);
      try {
        await page.goto(ubUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const ubCookies = await page.cookies("https://www.citaconsular.es");
        const phpSessIdUB = ubCookies.find((c) => c.name === "PHPSESSID")?.value;
        const ubBodyRaw = await page.evaluate(
          () => (document.body?.innerText ?? document.documentElement?.innerText ?? "").trim(),
        ).catch(() => "");
        if (phpSessIdUB) {
          console.log(
            `[spain-pb] ✅ /main/ universel: PHPSESSID=${phpSessIdUB.slice(0, 12)}… | body=${ubBodyRaw.length}B`,
          );
        }
        if (ubBodyRaw.length > 100) {
          capsolverPrefetchedMain = ubBodyRaw;
          console.log(`[spain-pb] 📦 /main/ JSONP capturé universellement (${ubBodyRaw.length}B)`);
        } else {
          console.warn(
            `[spain-pb] ⚠️ /main/ universel: body trop court ou vide (${ubBodyRaw.length}B) — ` +
            `snippet: "${ubBodyRaw.slice(0, 120)}"`,
          );
        }
      } catch (ubErr) {
        console.warn(`[spain-pb] ⚠️ Navigation universelle /main/ (non-fatal): ${ubErr}`);
      }
    }

    // Extraire tous les cookies du domaine (y compris le PHPSESSID frais)
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
      // Corps JSONP pré-fetchée via Chromium. Défini uniquement sur le path CapSolver
      // (quand le portail Turnstile est inaccessible → /main/ navigué directement).
      // Le scanner le consomme et bypasse l'appel impit (/main/ renvoie 0B via impit).
      ...(capsolverPrefetchedMain ? { prefetchedMainHtml: capsolverPrefetchedMain } : {}),
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
