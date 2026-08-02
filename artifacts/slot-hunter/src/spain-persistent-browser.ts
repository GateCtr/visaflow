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
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseProxyForPuppeteer, randomViewport } from "./browser.js";
import { getCurrentDecodoUrl, rotateDecodoUrl, isDecodoMultiPool } from "./spain-decodo-pool.js";

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
} from "./spain-soax-solver.js";
import { solveTurnstileInPage, TURNSTILE_INTERCEPT_SCRIPT } from "./capsolver-turnstile.js";
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
function getDefaultCfProfileDir(): string {
  return join(tmpdir(), "spain-cf-profile");
}

function resolveCfProfileDir(): string {
  const explicit = process.env.SPAIN_CF_PROFILE_DIR?.trim();
  if (!explicit) return getDefaultCfProfileDir();

  // On Windows, explicit Linux paths such as /tmp/... do not resolve correctly.
  // If a Linux-style absolute path arrives via env or a stale config, fall back to
  // a writable OS-local profile folder instead of crashing Chromium.
  if (process.platform === "win32" && explicit.startsWith("/")) {
    const fallback = join(process.cwd(), ".spain-cf-profile");
    console.warn(`[spain-pb] ⚠️ Chemin Chromium non Windows (${explicit}) → fallback vers ${fallback}`);
    return fallback;
  }

  return resolve(explicit);
}

const CF_PROFILE_DIR = resolveCfProfileDir();

function ensureProfileDirectory(profileDir: string): string {
  try {
    mkdirSync(profileDir, { recursive: true });
    return profileDir;
  } catch (err) {
    const fallbackDir = join(process.cwd(), ".spain-cf-profile");
    try {
      mkdirSync(fallbackDir, { recursive: true });
      console.warn(`[spain-pb] ⚠️ Impossible d'utiliser ${profileDir} pour Chromium — fallback vers ${fallbackDir}: ${err}`);
      return fallbackDir;
    } catch (fallbackErr) {
      console.warn(`[spain-pb] ⚠️ Impossible de créer le profil Chromium: ${fallbackErr}`);
      return profileDir;
    }
  }
}

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
  // POURQUOI ces répertoires :
  //   • Default/Cache/ + Default/Code Cache/ — scripts JSD mis en cache avec nonce périmé
  //   • Default/Local Storage/, Default/IndexedDB/, Default/Session Storage/ — CF stocke
  //     l'état JSD (seeds, nonces) dans ces storages. CDP Storage.clearDataForOrigin ne
  //     couvre PAS les Storage Partitions de Chromium (partitions créées pour les iframes
  //     blob: et workers CF). La purge physique sur disque est la seule façon fiable de
  //     supprimer les nonces figés. Sans ça, le oneshot envoie toujours le même timestamp
  //     périmé (ex: 1785297931) → CF rejette → /main/ retourne 0B.
  //   • Default/Service Worker/ + Default/Cache Storage/ — SW CF peut interférer avec JSD
  //   • GPUCache, DawnGraphiteCache — ne contiennent pas de tokens CF, préservés
  const cacheDirs = [
    "Default/Cache",           // HTTP cache — script JSD stale
    "Default/Code Cache",      // Bytecode V8 compilé avec nonce baked-in
    "Default/Local Storage",   // Seeds JSD + nonces CF (partitions incluses)
    "Default/IndexedDB",       // État challenge CF (Storage Partitions non couvertes par CDP)
    "Default/Session Storage", // Tokens session CF
    "Default/Service Worker",  // SW CF enregistré
    "Default/Cache Storage",   // CacheAPI du SW CF
    // CRITIQUE : le fichier Cookies est relu depuis le disque AU DÉMARRAGE de Chrome.
    // Notre purge CDP (Network.deleteCookies) s'exécute APRÈS le lancement — trop tard :
    // cf_clearance + PHPSESSID stale sont déjà rechargés en mémoire depuis le profil.
    // CF voit ce cf_clearance "connu" → sert le même script JSD avec le nonce figé
    // → JSD oneshot rejeté → /main/ = 0B.
    //
    // PIÈGE Chrome 96+ : les cookies ne sont PLUS dans Default/Cookies mais dans
    // Default/Network/Cookies (sous-répertoire Network). L'ancien chemin n'existe
    // pas → le purge rate → cf_clearance survit → solve en 1s → nonce morte → 0B.
    // Fix : purger les DEUX chemins pour couvrir toutes les versions de Chromium.
    "Default/Cookies",         // Chromium < 96 (compatibilité)
    "Default/Network",         // Chromium 96+ : Cookies déplacé dans Default/Network/Cookies
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
    console.log(
      `[spain-pb] 🗑️ Profil CF purgé sur disque (${purged} répertoires : Cache, Code Cache, LocalStorage, IndexedDB, SW, CacheStorage, Cookies/Network)`,
    );
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
  /**
   * Mutex de lancement : empêche deux appels concurrents à puppeteer.launch().
   * Sans ce verrou, si isBrowserAlive() timeout pendant le Turnstile solve
   * (Chrome occupé → répond en >5s), deux appelants voient _browser=null et
   * tentent chacun launch() sur le même userDataDir → "browser already running".
   */
  private _launchPromise: Promise<Browser> | null = null;
  /**
   * Flag : un retry closeAndInvalidate a déjà été tenté pour la session courante
   * sans récupérer de prefetchedMainHtml. Empêche la boucle destructrice où
   * chaque probe (toutes les 10s) appelle closeAndInvalidate + retry à l'infini
   * quand le token JSD oneshot CF est périmé (ex: token émis à 07:05, encore
   * servi 2h38min plus tard → CF refuse → 0B → destroy → même token → 0B…).
   */
  private _prefetchRetried = false;
  /** Page principale du browser persistant — réutilisée entre les cycles de scan. */
  private _page: import("puppeteer").Page | null = null;

  /**
   * Cache des réponses Bookitit API capturées immédiatement après /main/.
   * Clé = nom de l'endpoint (ex: "getwidgetconfigurations/", "getservices/").
   * Rempli par _prefetchBookititApis() juste après la capture de /main/,
   * pendant que le state PHP Bookitit côté serveur est encore chaud.
   * Vidé par closeAndInvalidate / invalidateSession / close.
   */
  private _apiPrefetchCache: Map<string, string> = new Map();
  /**
   * Verrou in-flight pour ensureSession() : empêche deux appelants concurrents
   * (ex: watcher + retry unique) de lancer deux solves CF simultanés sur le
   * même manager, ce qui causerait deux navigations puppeteer vers le même
   * userDataDir et une course sur _browser / _cachedSession.
   */
  private _ensureSessionInFlight: Promise<SpainCfSession | null> | null = null;

  // ── Proxy helpers ─────────────────────────────────────────────────────────

  private getProxyUrl(): string | undefined {
    // Utilise le pool Decodo (DECODO_PROXY_URLS ou DECODO_PROXY_URL) en priorité
    return getCurrentDecodoUrl() ?? process.env.SOAX_PROXY_URL;
  }

  /**
   * Retourne l'URL proxy suivante du pool pour forcer une nouvelle IP.
   *
   * Mode A — IPs dédiées (DECODO_PROXY_URLS avec plusieurs ports) :
   *   Avance l'index du pool → port 10010 → 10011 → … → 10010.
   *   Le "-sessionid-XXXX" est IGNORÉ sur ce type de proxy (IP fixée par le port).
   *
   * Mode B — Proxy résidentiel/rotatif (DECODO_PROXY_URL seul) :
   *   Ajoute "-sessionid-XXXX" au username → le provider attribue une IP sticky
   *   différente pour chaque valeur de session → CF voit une IP inconnue.
   */
  private buildRotatedProxyUrl(baseUrl: string): string {
    // Mode A : pool multi-URLs (IPs dédiées à ports fixes)
    if (isDecodoMultiPool()) {
      const nextUrl = rotateDecodoUrl();
      if (nextUrl) return nextUrl;
    }

    // Mode B : URL unique → rotation via sessionid (résidentiel/rotatif)
    try {
      const u = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
      const decodedUser = decodeURIComponent(u.username);
      const sessionId = Math.random().toString(36).slice(2, 10);
      const baseUser = decodedUser.replace(/-sessionid-[a-z0-9]+$/i, "");
      const rotatedUser = `${baseUser}-sessionid-${sessionId}`;
      u.username = encodeURIComponent(rotatedUser);
      const rotated = u.toString();
      const masked = rotated.replace(/:([^:@]+)@/, ":***@");
      console.log(`[spain-pb] 🔄 Rotation IP proxy Decodo — session: ${sessionId} (${masked.slice(0, 70)})`);
      return rotated;
    } catch {
      console.warn("[spain-pb] ⚠️ Rotation proxy échouée — utilisation URL originale");
      return baseUrl;
    }
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
      // ── Anti-cache JSD : empêcher la réutilisation du bytecode V8 périmé ─────
      // Le script b0da9f4911ba/main.js contient un timestamp HMAC (~15min de validité).
      // --disable-v8-code-cache empêche Chrome de stocker/réutiliser le bytecode compilé.
      // NOTE : --disk-cache-size=0 est intentionnellement omis — il bloque le chargement
      // des scripts CF (jsd/main.js, b0da9f4911ba) → JSD oneshot jamais envoyé → timeout.
      // La purge disque des storages + Network.setCacheDisabled est suffisante.
      "--disable-v8-code-cache",
      // Railway/Docker bloquent posix_spawn du crashpad_handler (seccomp no-ptrace)
      // → Chrome reçoit SIGABRT immédiatement au lancement. Désactiver le crash reporter
      // évite ce fork() interdit sans impacter le fingerprint (c'est un process interne).
      "--disable-crash-reporter",
      "--no-first-run",
      "--no-default-browser-check",
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

    // Mutex : si un launch est déjà en cours, attendre son résultat plutôt que
    // de tenter un second puppeteer.launch() sur le même userDataDir.
    if (this._launchPromise) {
      console.log("[spain-pb] ⏳ Launch déjà en cours — attente du browser existant…");
      return this._launchPromise;
    }

    // Use caller-supplied UA (e.g. CapSolver UA) if provided; otherwise rotate.
    // --user-agent launch flag must match the UA used by CapSolver when obtaining
    // cf_clearance — CF ties clearance to the exact UA string.
    this._ua = preferredUA ?? randomChromeUA();
    this._viewport = randomViewport();

    const baseProxyUrl = this.getProxyUrl();
    // Forcer une rotation d'IP Decodo à chaque nouveau lancement de browser.
    // buildRotatedProxyUrl change d'URL dans le pool (IPs dédiées) ou de sessionid
    // (proxy résidentiel) pour que CF voie une IP inconnue → nonce frais.
    const proxyUrl = baseProxyUrl ? this.buildRotatedProxyUrl(baseProxyUrl) : undefined;
    const { args } = this.buildLaunchArgs(proxyUrl);

    const maskedProxy = proxyUrl
      ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 80)
      : "direct (no proxy)";
    const effectiveProfileDir = ensureProfileDirectory(CF_PROFILE_DIR);
    console.log(`[spain-pb] 🚀 Lancement Chromium persistant`);
    console.log(`[spain-pb]    userDataDir : ${effectiveProfileDir}`);
    console.log(`[spain-pb]    Proxy       : ${maskedProxy}`);
    console.log(`[spain-pb]    UA          : ${this._ua.slice(0, 80)}`);

    // Purger les caches disque AVANT le lancement pour éviter les tokens JSD stales.
    // Le fichier Cookies est conservé pour réutiliser les cf_clearance + PHPSESSID valides.
    purgeProfileCacheOnDisk(effectiveProfileDir);

    // CHROMIUM_EXECUTABLE_PATH : permet d'utiliser un Chromium préinstallé
    // (ex: celui de Playwright dans le nix store sur Replit) plutôt que le cache Puppeteer.
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
    if (executablePath) {
      console.log(`[spain-pb]    executablePath: ${executablePath}`);
    }

    this._launchPromise = ((puppeteer as any).launch({
      headless: true,
      userDataDir: effectiveProfileDir,
      args,
      ...(executablePath ? { executablePath } : {}),
    }) as Promise<Browser>).then((browser: Browser) => {
      this._browser = browser;
      this._launchPromise = null;
      return browser;
    }).catch((err: unknown) => {
      this._launchPromise = null;
      throw err;
    }) as Promise<Browser>;

    return this._launchPromise;
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

  /** Page Chromium principale — utilisée par callBookititEndpointViaBrowser pour les appels same-IP. */
  getActivePage(): import("puppeteer").Page | null {
    return this._page;
  }

  /**
   * Retourne la réponse précachée d'un endpoint Bookitit (capturée pendant le solve),
   * ou undefined si non disponible (cache miss → l'appelant doit faire le vrai appel).
   * @param endpoint  Nom de l'endpoint, ex: "getwidgetconfigurations/", "getservices/"
   */
  getApiPrefetchCached(endpoint: string): string | undefined {
    return this._apiPrefetchCache.get(endpoint);
  }

  /** True si un closeAndInvalidate+retry a déjà été tenté sans récupérer de prefetch. */
  get prefetchRetried(): boolean {
    return this._prefetchRetried;
  }

  /** Marque que le retry prefetch a été effectué (appeler depuis ensureSpainCfSession). */
  markPrefetchRetried(): void {
    this._prefetchRetried = true;
  }

  invalidateSession(): void {
    this._cachedSession = null;
    this._prefetchRetried = false;
    this._apiPrefetchCache.clear();
    console.log("[spain-pb] 🗑️ Session CF invalidée");
  }

  /**
   * Appelle getwidgetconfigurations/ et getservices/ depuis la page browser
   * immédiatement après la capture de /main/, pendant que le state PHP Bookitit
   * côté serveur est encore chaud (~quelques centaines de ms après /main/).
   *
   * Les réponses sont stockées dans _apiPrefetchCache (clé = nom endpoint)
   * pour être servies instantanément par callBookititEndpointViaBrowser().
   */
  async _prefetchBookititApis(page: import("puppeteer").Page, targetUrl: string): Promise<void> {
    const base = "https://www.citaconsular.es/onlinebookings/";
    const publickey = targetUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
    const src = targetUrl.replace(/\/?$/, "/");
    const srvsrc = "https://www.citaconsular.es";

    const buildParams = (cb: string) => {
      const q = new URLSearchParams();
      q.append("callback", cb);
      q.append("type", "default");
      q.append("publickey", publickey);
      q.append("lang", "es");
      q.append("version", "4");
      q.append("src", src);
      q.append("srvsrc", srvsrc);
      q.append("selectedPeople", "1");
      q.append("_", String(Date.now()));
      return q.toString();
    };

    const cfgUrl = `${base}getwidgetconfigurations/?${buildParams(`cbCfg${Date.now()}`)}`;
    const svcUrl = `${base}getservices/?${buildParams(`cbSvc${Date.now() + 1}`)}`;

    const fetchFromPage = async (url: string): Promise<string> => {
      try {
        return await page.evaluate(async (u: string) => {
          try {
            const r = await fetch(u, {
              method: "GET",
              credentials: "include",
              headers: {
                "Accept": "text/javascript, application/javascript, */*; q=0.01",
                "X-Requested-With": "XMLHttpRequest",
              },
            });
            const body = await r.text();
            return r.ok ? body : `__ERR_STATUS_${r.status}`;
          } catch (e: unknown) {
            return `__ERR_FETCH_${String(e).slice(0, 80)}`;
          }
        }, url);
      } catch {
        return "";
      }
    };

    console.log("[spain-pb] ⚡ Prefetch Bookitit APIs (getwidgetconfigurations + getservices)…");
    const [cfgRaw, svcRaw] = await Promise.all([fetchFromPage(cfgUrl), fetchFromPage(svcUrl)]);

    const cfgOk = cfgRaw.length > 0 && !cfgRaw.startsWith("__ERR_");
    const svcOk = svcRaw.length > 0 && !svcRaw.startsWith("__ERR_");
    console.log(
      `[spain-pb] ⚡ Prefetch terminé — getwidgetconfigurations: ${cfgOk ? cfgRaw.length + "B ✅" : "0B ❌"} | getservices: ${svcOk ? svcRaw.length + "B ✅" : "0B ❌"}`,
    );

    if (cfgOk) this._apiPrefetchCache.set("getwidgetconfigurations/", cfgRaw);
    if (svcOk) this._apiPrefetchCache.set("getservices/", svcRaw);
  }

  /**
   * Invalide la session ET ferme le browser.
   *
   * À utiliser quand /main/ retourne 0B (CF bloque cette IP Decodo) :
   * simple invalidateSession() ne suffit pas — getOrLaunchBrowser() réutilise
   * le browser existant avec la MÊME IP → CF bloque à nouveau.
   * La fermeture force buildRotatedProxyUrl() à générer un nouveau sessionid
   * Decodo → nouvelle IP sticky → CF émet un nonce frais → /main/ répond.
   */
  async closeAndInvalidate(): Promise<void> {
    this._cachedSession = null;
    this._prefetchRetried = false; // reset pour le prochain cycle
    this._page = null;
    this._apiPrefetchCache.clear();

    // Supprimer la clé Redis AVANT de relancer le browser, sinon ensureSession()
    // appelé depuis le retry unique va restaurer la même session cassée (boucle infinie).
    try {
      const { removeSpainCfSessionFromRedis } = await import("./spain-redis-persistence.js");
      removeSpainCfSessionFromRedis();
    } catch {
      // non-fatal
    }

    if (this._browser) {
      const browserToClose = this._browser;
      // Mettre _browser = null AVANT close() pour que les appels concurrents
      // n'entrent pas dans cette branche et tentent un double close().
      this._browser = null;
      try {
        await browserToClose.close();
      } catch {
        // SIGTERM déjà envoyé ou process déjà mort — non-fatal
      }
      // Attendre que le processus Chrome libère le verrou userDataDir.
      // Sans ce délai, puppeteer.launch() arrive trop tôt et échoue avec
      // "The browser is already running for /tmp/spain-cf-profile".
      await new Promise((r) => setTimeout(r, 1_500));
      console.log("[spain-pb] 🔄 Session + browser fermés — prochaine IP Decodo sera différente");
    } else {
      console.log("[spain-pb] 🗑️ Session invalidée (browser déjà fermé)");
    }
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
   *   2. Sinon → restauration Redis (survie aux redéploiements)
   *      Si la session Redis a un prefetchedMainHtml → retour immédiat (scanner l'utilisera)
   *   3. Sinon → navigation vers targetUrl dans le contexte principal (profil persistant)
   *   4. Poll cf_clearance jusqu'à CF_SOLVE_TIMEOUT_MS
   *   5. Extrait tous les cookies + construit SpainCfSession
   *   6. Persiste dans Redis pour survie aux redéploiements
   */
  async ensureSession(
    targetUrl: string = DEFAULT_WIDGET_URL,
  ): Promise<SpainCfSession | null> {
    if (this.isSessionValid()) {
      const remainMin = Math.round((this._cachedSession!.expiresAt - Date.now()) / 60_000);
      console.log(`[spain-pb] ♻️ Session CF réutilisée (reste ${remainMin}min)`);
      return this._cachedSession!;
    }

    // ── Verrou in-flight : empêche deux solves CF simultanés ──────────────────
    // Sans ce verrou, le watcher + le retry unique peuvent appeler ensureSession()
    // en même temps (quand _cachedSession vient d'être invalidée), ce qui lance
    // deux navigations puppeteer sur le même userDataDir → race sur _browser/
    // _cachedSession + double dépense CapSolver.
    if (this._ensureSessionInFlight) {
      console.log(`[spain-pb] ⏳ Solve CF déjà en cours — attente du résultat partagé`);
      return this._ensureSessionInFlight;
    }

    this._ensureSessionInFlight = this._ensureSessionImpl(targetUrl).finally(() => {
      this._ensureSessionInFlight = null;
    });
    return this._ensureSessionInFlight;
  }

  private async _ensureSessionImpl(
    targetUrl: string,
  ): Promise<SpainCfSession | null> {
    // ── Tentative restauration Redis ──────────────────────────────────────────
    // Après un redéploiement, le PB manager repart avec _cachedSession=null mais
    // la session précédente (avec prefetchedMainHtml) peut encore être valide en Redis.
    // Si on la restaure ici, le scanner réutilise directement le prefetchedMainHtml
    // sans browser solve — évite le JSD cookie-fantôme loop au restart.
    try {
      const { restoreSpainCfSessionFromRedis } = await import("./spain-redis-persistence.js");
      const redisData = await restoreSpainCfSessionFromRedis();
      if (redisData && Date.now() < redisData.expiresAt) {
        // N'utiliser la session Redis QUE si elle a un prefetchedMainHtml valide.
        // Sans prefetch (0B), source="playwright" mais _page=null → /main/ browser
        // retourne 0B → closeAndInvalidate → Redis restore → même session → boucle infinie.
        const hasPrefetch = (redisData.prefetchedMainHtml?.length ?? 0) > 0;
        if (!hasPrefetch) {
          console.warn(
            `[spain-pb] ⚠️ Session Redis sans prefetch (0B) — solve complet requis (IP peut être bloquée)`,
          );
          // Supprimer la clé cassée pour éviter qu'un autre cycle la restaure
          const { removeSpainCfSessionFromRedis } = await import("./spain-redis-persistence.js");
          removeSpainCfSessionFromRedis();
        } else {
          const restored: SpainCfSession = { ...redisData, source: "playwright" };
          this._cachedSession = restored;
          setActiveSpainCfSession(restored);
          const remainMin = Math.round((restored.expiresAt - Date.now()) / 60_000);
          console.log(
            `[spain-pb] ♻️ Session CF restaurée depuis Redis (reste ${remainMin}min` +
            `, prefetch: ${redisData.prefetchedMainHtml!.length}B)`,
          );
          return restored;
        }
      }
    } catch (redisRestoreErr) {
      console.warn(`[spain-pb] ⚠️ Restauration Redis (non-fatale): ${redisRestoreErr}`);
    }

    const t0 = Date.now();
    console.log(`[spain-pb] 🚀 Résolution CF — stratégie Turnstile injection (token injecté dans notre Chromium)`);
    return this._resolveWithTurnstileInjection(targetUrl, t0);

  }

  // ── Résolution via injection Turnstile dans notre Chromium ───────────────
  /**
   * Stratégie principale de résolution CF :
   *
   *   1. Notre Chromium navigue vers targetUrl → CF challenge Turnstile apparaît.
   *   2. CapSolver résout UNIQUEMENT le token Turnstile (AntiTurnstileTaskProxyLess).
   *   3. On injecte le token dans notre page via JS → CF valide dans notre contexte.
   *   4. CF émet cf_clearance lié à NOTRE TLS Chromium (pas celui de CapSolver).
   *   5. Listener CDP armé sur /onlinebookings/main/ avant le clic Continuar →
   *      capture le JSONP émis par le portail après Continuar. CF laisse passer
   *      les sous-requêtes XHR/fetch depuis un contexte browser réel.
   *   6. Le JSONP capturé est stocké dans session.prefetchedMainHtml et réutilisé
   *      par le scanner HTTP sans appel impit (CF bloque impit sur /main/).
   *
   * DIFFÉRENCE vs AntiCloudflareTask :
   *   AntiCloudflareTask fait le solve ENTIER côté infra CapSolver → cf_clearance
   *   lié à LEUR TLS → notre Chromium envoie un TLS différent → /main/ = 0B.
   *   Ici, CapSolver résout seulement le CAPTCHA math/IA, notre Chromium reste
   *   l'acteur de la validation finale → cf_clearance pour NOTRE TLS.
   */
  private async _resolveWithTurnstileInjection(
    targetUrl: string,
    t0: number,
  ): Promise<SpainCfSession | null> {
    const proxyUrl = this.getProxyUrl();
    // Note: CAPSOLVER_API_KEY n'est PAS requis pour le chemin JSD natif.
    // CF Managed Challenge (JSD) est résolu directement par notre Chromium stealth.
    // CapSolver n'est utilisé que si un widget Turnstile visible apparaît (rare sur
    // citaconsular.es). Sans clé CapSolver, le Turnstile physique click CDP prend le relais.
    if (!proxyUrl) {
      console.error("[spain-pb] ❌ aucun proxy configuré (DECODO_PROXY_URL ou decodo-proxies.csv requis)");
      return null;
    }

    // ── Étape 1 : Lancer/récupérer Chromium, configurer la page ──────────────
    // Pas d'UA CapSolver à synchroniser — on utilise notre propre UA Chrome.
    const browser = await this.getOrLaunchBrowser();
    const { proxyAuth } = this.buildLaunchArgs(proxyUrl);

    const pages = await browser.pages();
    let page: Page = pages.length > 0 ? pages[0] : await browser.newPage();
    this._page = page; // mémorisé pour callBookititEndpointViaBrowser

    await page.setUserAgent(this._ua);
    await page.setViewport(this._viewport);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    // ── Aligner les Client Hints CDP avec l'UA CapSolver ─────────────────────
    // CF signe le cf_clearance avec la signature TLS + les sec-ch-ua de CapSolver.
    // Si notre Chromium envoie ses propres Client Hints (version différente),
    // CF détecte la discordance et vide silencieusement le body de /main/ (0B).
    // Network.setUserAgentOverride force sec-ch-ua, sec-ch-ua-mobile et
    // sec-ch-ua-platform à correspondre exactement à l'UA reçu de CapSolver.
    try {
      const cdpUA = await page.createCDPSession();
      const chromeVer = this._ua.match(/Chrome\/([\d]+)/)?.[1] ?? "135";
      const navPlat    = platformFromUA(this._ua); // "Win32" | "MacIntel" | "Linux x86_64"
      const cdpPlatform   = navPlat === "MacIntel" ? "macOS" : navPlat === "Win32" ? "Windows" : "Linux";
      const cdpPlatformVer = navPlat === "MacIntel" ? "10_15_7" : navPlat === "Win32" ? "10.0.0" : "5.15.0";
      const cdpArch        = navPlat === "Linux x86_64" ? "x86_64" : "x86";
      await cdpUA.send("Network.setUserAgentOverride", {
        userAgent: this._ua,
        acceptLanguage: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        userAgentMetadata: {
          brands: [
            { brand: "Not A;Brand",   version: "99"       },
            { brand: "Chromium",      version: chromeVer  },
            { brand: "Google Chrome", version: chromeVer  },
          ],
          fullVersion: `${chromeVer}.0.0.0`,
          platform: cdpPlatform,
          platformVersion: cdpPlatformVer,
          architecture: cdpArch,
          model: "",
          mobile: false,
        },
      });
      await cdpUA.detach().catch(() => {});
      console.log(`[spain-pb] 🪪 Client Hints CDP alignés — Chrome/${chromeVer} ${cdpPlatform}`);
    } catch (cdpUAErr) {
      console.warn(`[spain-pb] ⚠️ CDP setUserAgentOverride (non-fatal): ${cdpUAErr}`);
    }

    // CDP Fetch handler remplace page.authenticate() — voir setupPageProxyAuth.
    if (proxyAuth) await setupPageProxyAuth(page, proxyAuth);

    // ── Intercepter window.turnstile.render pour capturer le sitekey ─────────
    // CF Managed Challenge avec render=explicit ne met JAMAIS data-sitekey dans
    // le DOM — il passe le sitekey à window.turnstile.render(el, { sitekey })
    // dynamiquement. Ce hook s'exécute avant tout JS de la page (evaluateOnNewDocument)
    // et sauvegarde le sitekey dans window.__cf_intercepted_sitekey.
    await (page as any).evaluateOnNewDocument(TURNSTILE_INTERCEPT_SCRIPT);

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
      // Supprimer le cf_clearance pour forcer un fresh challenge JSD
      await cdpStorage.send("Network.deleteCookies", {
        name: "cf_clearance",
        domain: ".citaconsular.es",
      });
      // CRITIQUE : Supprimer le PHPSESSID sur les deux domaines.
      // CF lie le challenge Cloudflare (token JSD / nonce) au PHPSESSID côté serveur.
      // Si le PHPSESSID est stale, citaconsular.es renvoie le MÊME nonce périmé dans
      // le HTML (ex: timestamp 1785297931 vieux de 33min) → JSD oneshot rejeté par CF
      // → /main/ retourne 0B. Purger le PHPSESSID force la création d'une nouvelle
      // session PHP, qui reçoit un nonce frais du serveur CF.
      await cdpStorage.send("Network.deleteCookies", {
        name: "PHPSESSID",
        domain: ".citaconsular.es",
      });
      await cdpStorage.send("Network.deleteCookies", {
        name: "PHPSESSID",
        domain: "www.citaconsular.es",
      });
      // Purger storage CF (localStorage, IndexedDB, ServiceWorkers, CacheStorage)
      // SANS cookies pour conserver les autres cookies applicatifs.
      await cdpStorage.send("Storage.clearDataForOrigin", {
        origin: "https://www.citaconsular.es",
        storageTypes: "local_storage,session_storage,indexeddb,service_workers,cache_storage",
      });
      await cdpStorage.detach().catch(() => {});
      console.log("[spain-pb] 🗑️ Profil CF purgé (cf_clearance + PHPSESSID + localStorage/SW/IndexedDB — nonce périmé cassé)");
    } catch (purgeErr) {
      console.warn(`[spain-pb] ⚠️ Purge storage CF (non-fatal): ${purgeErr}`);
    }

    // Désactiver le cache HTTP pour toute la session de la page.
    //
    // CRITIQUE : La page widgetdefault/... est visitée DEUX FOIS :
    //   1ère visite (JSD natif) → serveur génère un nonce frais (ex: 1785301530)
    //   2ème visite (portail)   → si cache activé, Chrome sert le MÊME HTML depuis
    //   le cache disque → loadermaec.js reçoit le même nonce périmé → JSD oneshot
    //   rejeté → /main/ = 0B.
    //
    // page.setCacheEnabled(false) utilise la session CDP interne de Puppeteer
    // (pas une session séparée qu'on detach()) → l'état PERSISTE sur toutes les
    // navigations suivantes de la page. Network.clearBrowserCache vide en plus le
    // cache mémoire du process Chrome pour cette page.
    try {
      await (page as any).setCacheEnabled(false);
      const cdpCache = await page.createCDPSession();
      await cdpCache.send("Network.enable");
      await cdpCache.send("Network.clearBrowserCache");
      await cdpCache.detach().catch(() => {});
      console.log("[spain-pb] 🗑️ Cache HTTP désactivé via page.setCacheEnabled(false) — nonce frais garanti sur TOUTES les navigations");
    } catch { /* non-fatal */ }

    // ── Étape 4 : Navigation → JSD s'exécute dans notre Chromium → cf_clearance ──
    //
    // STRATÉGIE (basée sur la doc CF JavaScript Detections) :
    //   CF utilise le script JSD (/cdn-cgi/challenge-platform/scripts/jsd/main.js)
    //   qui s'exécute DANS notre Chromium. Si le fingerprint est valide,
    //   CF émet automatiquement cf_clearance avec js_detection.passed = true.
    //
    // CapSolver (AntiCloudflareTask / AntiTurnstileTaskProxyLess) N'EST PAS applicable :
    //   - b0da9f4911ba (dans l'URL du script JSD) n'est pas un sitekey Turnstile valide
    //   - CapSolver rejette "invalid websiteKey (b0da9f4911ba)"
    //   - CF Managed Challenge utilise JS Detection, pas un widget Turnstile avec sitekey
    //
    // La solution : laisser le Chromium stealth exécuter le JSD nativement.
    // cf_clearance est émis pour NOTRE TLS → /main/ accepte nos requêtes impit.
    // STRATÉGIE UNE SEULE NAVIGATION :
    // On navigue vers targetUrl UNE SEULE FOIS avec waitUntil="load" pour que :
    //   1. CF exécute le JSD natif → cf_clearance émis
    //   2. Le widget Bookitit se charge EN MÊME TEMPS (loadermaec.js, jquery, etc.)
    //   3. On reste sur cette page et on clique Continuar directement
    //
    // POURQUOI une seule navigation (critique) :
    //   Une 2ème goto(targetUrl) re-déclenche un challenge CF → CF génère un JSD
    //   token lié à la SESSION de la 1ère navigation (déjà périmée de X minutes)
    //   → oneshot rejeté → /main/ = 0B. Le seul moyen d'avoir un oneshot frais
    //   est de cliquer Continuar DANS LA MÊME SESSION que le cf_clearance.
    console.log(`[spain-pb] 🌐 Navigation unique → JSD CF + widget Bookitit en parallèle : ${targetUrl.slice(0, 80)}`);
    try {
      await page.goto(targetUrl, { waitUntil: "load", timeout: 70_000 });
    } catch (navErr) {
      // Timeout non-fatal — CF challenge peut dépasser 35s, la boucle Continuar prend le relais
      console.warn(`[spain-pb] ⚠️ Navigation initiale (non-fatal, boucle widget prend le relais): ${navErr}`);
    }

    // ── Refresh page après navigation — CF peut avoir redirigé vers une nouvelle Frame ──
    // Si CF fait window.location.replace() ou crée une nouvelle Frame pendant la navigation,
    // l'ancienne variable `page` devient obsolète (detached Frame). On prend toujours
    // la première page vivante du browser pour éviter tous les TargetCloseError suivants.
    try {
      const freshPages = await browser.pages();
      if (freshPages.length > 0 && freshPages[0] !== page) {
        page = freshPages[0];
        this._page = page;
        console.log(`[spain-pb] 🔄 Référence page rafraîchie après navigation initiale (CF redirect détecté)`);
      }
    } catch { /* non-fatal */ }

    // Vérifier si cf_clearance déjà présent (profil persistant valide)
    {
      const existing = await page.cookies("https://www.citaconsular.es").catch(() => []);
      const hasCf = existing.find((c) => c.name === "cf_clearance");
      if (hasCf) {
        console.log(`[spain-pb] ♻️ cf_clearance déjà présent dans le profil — JSD non requis: ${hasCf.value.slice(0, 40)}…`);
      }
    }

    // Attendre que le JSD s'exécute et que CF émette cf_clearance (max 65s)
    // Le JSD dure 15min selon la doc CF, mais l'émission initiale prend ~10-40s.
    // Page "Un instant..." / "Just a moment" = JSD en cours → ATTENDRE, ne pas interrompre.
    console.log(`[spain-pb] ⏳ Attente cf_clearance via JSD natif (max 65s)…`);
    const jsdStartMs = Date.now();
    let cfObtained = false;
    let jsdSolveMs = 0; // durée pour obtenir cf_clearance — < 3s = IP de confiance CF (fast-track)
    const JSD_TIMEOUT_MS = 65_000;
    const jsdDeadline = Date.now() + JSD_TIMEOUT_MS;

    while (Date.now() < jsdDeadline) {
      const cookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
      const cf = cookies.find((c) => c.name === "cf_clearance");
      if (cf?.value) {
        cfObtained = true;
        jsdSolveMs = Date.now() - jsdStartMs;
        console.log(
          `[spain-pb] ✅ cf_clearance obtenu via JSD natif (${Math.round(jsdSolveMs / 1000)}s)` +
          ` — js_detection.passed=true pour NOTRE TLS` +
          (jsdSolveMs < 3_000 ? " ⚡ IP de confiance CF (fast-track détecté)" : "")
        );
        console.log(`[spain-pb]    cf_clearance: ${cf.value.slice(0, 40)}…`);
        break;
      }
      // Log intermédiaire toutes les 10s
      const elapsed = Math.round((Date.now() - jsdStartMs) / 1000);
      if (elapsed > 0 && elapsed % 10 === 0) {
        const title = await page.title().catch(() => "?");
        const url = page.url();
        console.log(`[spain-pb]    JSD polling ${elapsed}s — titre: "${title}" url: ${url.slice(0, 60)}`);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }

    if (!cfObtained) {
      // Diagnostic final
      const title = await page.title().catch(() => "?");
      const url = page.url();
      const cookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
      console.error(
        `[spain-pb] ❌ cf_clearance absent après ${JSD_TIMEOUT_MS / 1000}s` +
        ` | titre: "${title}" | url: ${url.slice(0, 60)}` +
        ` | cookies: ${cookies.map((c) => c.name).join(", ")}`,
      );
      console.error(`[spain-pb] ❌ JSD échoué — Chromium headless détecté par CF (stealth insuffisant) ou proxy rejeté`);
      return null;
    }

    // ── Étape 5 : Armer le listener XHR /main/ ────────────────────────────────
    // CF bloque les navigations top-level (page.goto) vers /main/ même avec un
    // cf_clearance valide → retourne 0B. Mais quand le JS du portail appelle
    // /main/ en XHR/fetch après le clic Continuar, CF laisse passer la réponse
    // (sous-requête dans un contexte browser réel, pas une navigation top-level).
    // On écoute page.on('response') + CDP Network pour capturer le body.
    let capturedMainBody = "";
    // Timestamp quand le JSD oneshot a répondu — utilisé pour temporiser le fetch fallback.
    let jsdOneShotAt = 0;

    // Promise résolue quand le JSD oneshot est détecté — utilisée par l'intercepteur /main/.
    // Permet de retarder /main/ jusqu'à ce que CF ait vu notre fingerprint JSD.
    let jsdOneShotResolve: (() => void) | null = null;
    const jsdOneShotSignal = new Promise<void>((resolve) => { jsdOneShotResolve = resolve; });

    // CDP Network listener — plus fiable que page.on('response') pour les ressources
    // script (JSONP) car il fournit requestId → Network.getResponseBody peut être
    // appelé même si la réponse est déjà traitée par le browser.
    let cdpNet: any = null;
    const pendingMainRequests = new Map<string, string>(); // requestId → url
    const pendingJsdRequests  = new Map<string, string>(); // requestId → url (JSD oneshot)
    const pendingApiRequests  = new Map<string, string>(); // requestId → endpoint name (getwidgetconfigurations/, getservices/, getagendas/, datetime/)
    // true si JSD oneshot a répondu AVEC un nouveau cf_clearance (challenge accepté).
    // Si false : le cookie cf_clearance est "fantôme" — la session est invalide pour /main/.
    let jsdOneShotAccepted = false;
    // Promise résolue quand cfg + svc sont capturées naturellement par le widget JS.
    let widgetApisResolve: (() => void) | null = null;
    const widgetApisSignal = new Promise<void>((resolve) => { widgetApisResolve = resolve; });
    let widgetApisCount = 0; // compte seulement cfg + svc
    // Promise résolue quand getagendas/ est capturé (suite au clic sur service simulé).
    let widgetSlotResolve: (() => void) | null = null;
    const widgetSlotSignal = new Promise<void>((resolve) => { widgetSlotResolve = resolve; });
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
        // Track widget JSONP APIs — capturés naturellement par le widget JS
        if (url.includes("onlinebookings/getwidgetconfigurations")) {
          pendingApiRequests.set(ev.requestId, "getwidgetconfigurations/");
        } else if (url.includes("onlinebookings/getservices") && !url.includes("getagendas") && !url.includes("datetime")) {
          pendingApiRequests.set(ev.requestId, "getservices/");
        } else if (url.includes("onlinebookings/getagendas")) {
          pendingApiRequests.set(ev.requestId, "getagendas/");
        } else if (url.includes("onlinebookings/datetime") && !url.includes("datetimetypes")) {
          // Store full URL so loadingFinished can extract the month for cache keying
          pendingApiRequests.set(ev.requestId, "datetime/:" + url);
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
          jsdOneShotAccepted = hasCfClearance; // true = challenge accepté, cf_clearance réémis
          console.log(
            `[spain-pb] 🔑 JSD oneshot resp: status=${ev.response.status}` +
            ` cf-ray=${ev.response.headers?.["cf-ray"] ?? "none"}` +
            ` new-cf_clearance=${hasCfClearance ? "✅ oui (challenge accepté)" : "❌ non — cookie fantôme, /main/ sera annulé"}`,
          );
          jsdOneShotAt = Date.now(); // marquer le moment pour le délai post-JSD
          pendingJsdRequests.delete(ev.requestId);
          // Signaler à l'intercepteur /main/ que le JSD oneshot est terminé.
          // CF a maintenant vu notre fingerprint — /main/ peut être libéré ou annulé.
          if (jsdOneShotResolve) jsdOneShotResolve();
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

      // Capturer les réponses naturelles du widget JS via CDP Network.
      // cfg + svc : appelés automatiquement par mainv1.js après /main/.
      // getagendas/ + datetime/ : appelés après clic sur service (simulé ci-dessous).
      cdpNet.on("Network.loadingFinished", async (ev: any) => {
        if (!pendingApiRequests.has(ev.requestId)) return;
        const rawEp = pendingApiRequests.get(ev.requestId)!;
        pendingApiRequests.delete(ev.requestId);
        // Resolve endpoint name and cache key (datetime/ is month-keyed)
        let ep = rawEp;
        let cacheKey = rawEp;
        if (rawEp.startsWith("datetime/:")) {
          ep = "datetime/";
          const dtUrl = rawEp.slice(10);
          try {
            const startParam = new URLSearchParams(new URL(dtUrl).search).get("start") ?? "";
            const month = startParam.slice(0, 7); // "YYYY-MM"
            cacheKey = month ? `datetime/${month}` : "datetime/";
          } catch { cacheKey = "datetime/"; }
        }
        try {
          const { body, base64Encoded } = await cdpNet.send("Network.getResponseBody", {
            requestId: ev.requestId,
          });
          const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
          if (decoded.length > 10 && !decoded.startsWith("__ERR_")) {
            if (ep === "datetime/") {
              console.log(`[spain-pb] 📦 Widget API ${cacheKey} capturée via CDP (${decoded.length}B) raw="${decoded.slice(0, 150)}"`);
            } else {
              console.log(`[spain-pb] 📦 Widget API ${ep} capturée via CDP (${decoded.length}B)`);
            }
            this._apiPrefetchCache.set(cacheKey, decoded);
            if (ep === "getwidgetconfigurations/" || ep === "getservices/") {
              widgetApisCount++;
              if (widgetApisCount >= 2 && widgetApisResolve) widgetApisResolve();
            } else if (ep === "getagendas/" && widgetSlotResolve) {
              widgetSlotResolve(); // signal pour arrêter l'attente
            }
          } else {
            console.warn(`[spain-pb] ⚠️ Widget API ${ep} (${cacheKey}) → 0B (serveur vide)`);
            if ((ep === "getwidgetconfigurations/" || ep === "getservices/")) {
              widgetApisCount++;
              if (widgetApisCount >= 2 && widgetApisResolve) widgetApisResolve();
            }
          }
        } catch { /* non-fatal */ }
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

    // cdpFetch sera armé APRÈS le clic Continuar pour intercepter /main/ si CF exige un JSD POST.
    let cdpFetch: any = null;

    // ── Étape 6 : Naviguer vers le portail puis cliquer Continuar ────────────
    // Avec le cf_clearance frais injecté + UA synchronisé, CF accepte la page
    // portail sans re-challenger. Le JS du portail charge, on clique Continuar,
    // et le listener XHR capture la réponse /main/.
    let prefetchedMainHtml = "";
    try {
      // On est déjà sur targetUrl après la 1ère navigation JSD — PAS de 2ème goto().
      // Le JSD oneshot doit être envoyé dans la MÊME session que le cf_clearance.
      // Un 2ème goto() déclencherait un challenge CF lié à la session périmée → token stale.
      const currentUrl = page.url();
      console.log(`[spain-pb] 🖱️ Page courante après JSD : ${currentUrl.slice(0, 80)} — attente widget Bookitit…`);

      // Attendre et cliquer le bouton Continuar (max 60s depuis la page courante)
      // La 1ère navigation est en "load" → widget peut déjà être initialisé.
      // Si CF a produit la page mais le widget JS tarde, la boucle attend jusqu'à 60s.
      let continueClicked = false;
      let turnstileClicked = false; // Ne cliquer la case Turnstile qu'une seule fois
      const contDeadline = Date.now() + 60_000;
      while (Date.now() < contDeadline && !continueClicked) {

        // ── Détecter et cliquer la case Turnstile (Managed Challenge visible) ──
        // CF peut afficher un widget "Vérifiez que vous êtes humain" même après JSD.
        // element.click() JS est rejeté (isTrusted=false) — seul un vrai clic physique
        // CDP (page.mouse.click) génère isTrusted=true et passe le challenge.
        if (!turnstileClicked) {
          // Utiliser page.frames() (niveau Puppeteer, pas DOM) pour trouver l'iframe
          // Cloudflare même si elle est dans un Shadow DOM fermé ou créée avec blob: URL.
          // document.querySelectorAll("iframe") ne traverse pas les Shadow DOM → hasTurnstile=false.
          const cfFrame = page.frames().find((f: any) => {
            const url: string = f.url() ?? "";
            const name: string = f.name() ?? "";
            return (
              url.includes("challenges.cloudflare.com") ||
              url.includes("cdn-cgi/challenge-platform") ||
              name.includes("cf-") ||
              name.includes("turnstile")
            );
          });
          // Récupérer le bounding box de l'iframe CF depuis la page principale
          const tfBox = cfFrame
            ? await page.evaluate((frameUrl: string): { x: number; y: number; w: number; h: number } | null => {
                // 1. Chercher l'iframe correspondant dans le DOM principal et Shadow DOM
                const all = document.querySelectorAll("*");
                for (const el of Array.from(all)) {
                  // Traverser Shadow DOM
                  const roots: (Document | ShadowRoot)[] = [document];
                  if ((el as any).shadowRoot) roots.push((el as any).shadowRoot);
                  for (const root of roots) {
                    const iframes = root.querySelectorAll("iframe");
                    for (const f of Array.from(iframes)) {
                      const r = (f as HTMLElement).getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, w: r.width, h: r.height };
                    }
                  }
                }
                // 2. Fallback : premier blob: iframe visible (Managed Challenge CF)
                const allIframes = document.querySelectorAll("iframe");
                for (const f of Array.from(allIframes)) {
                  if ((f as HTMLIFrameElement).src?.startsWith("blob:")) {
                    const r = (f as HTMLElement).getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return { x: r.x, y: r.y, w: r.width, h: r.height };
                  }
                }
                return null;
              }, cfFrame.url()).catch(() => null)
            : null;

          if (tfBox) {
            // Case à cocher Turnstile : ~24px depuis le bord gauche, centrée verticalement
            // Widget standard 300×65px → case à ~(24, hauteur/2)
            const cbX = Math.round(tfBox.x + 24);
            const cbY = Math.round(tfBox.y + tfBox.h / 2);
            console.log(
              `[spain-pb] 🖱️ Managed Challenge Turnstile détecté` +
              ` (${Math.round(tfBox.w)}×${Math.round(tfBox.h)} @ ${Math.round(tfBox.x)},${Math.round(tfBox.y)})` +
              ` — clic physique CDP case à cocher…`,
            );
            // Mouvement naturel avant le clic (évite un clic téléporté détectable par CF)
            await page.mouse.move(cbX - 80, cbY - 40, { steps: 12 });
            await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 150)));
            await page.mouse.move(cbX, cbY, { steps: 6 });
            await new Promise((r) => setTimeout(r, 80 + Math.floor(Math.random() * 80)));
            await page.mouse.click(cbX, cbY);
            turnstileClicked = true;
            console.log(`[spain-pb] ⏳ Clic physique effectué — attente validation CF Turnstile (4s)…`);
            await new Promise((r) => setTimeout(r, 4_000));
            // Vérifier si CF a réémis un cf_clearance suite à la validation du widget
            const postTsCookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
            const newCf = postTsCookies.find((c) => c.name === "cf_clearance");
            console.log(
              `[spain-pb] 🔑 Post-Turnstile cf_clearance: ` +
              (newCf ? `✅ réémis ${newCf.value.slice(0, 30)}…` : "❌ pas de réémission — fingerprint insuffisant"),
            );
          }
        }

        // ── Vérifier que CF a COMPLÈTEMENT fini avant de cliquer Continuar ──────
        // PROBLÈME : si on clique Continuar alors que le titre est encore "Un instant…",
        // CF est encore en train d'évaluer le JSD → /main/ reçoit 0B car CF n'a pas
        // encore émis le cf_clearance pour cette session.
        // SOLUTION (doc CF) : attendre que le titre inclue "Embajada" (page applicative)
        // ET ne contienne plus "instant" / "moment" avant de tenter le clic.
        const cfStillRunning = await page.evaluate(() => {
          const title = document.title.toLowerCase();
          const isCfChallenge = title.includes("instant") || title.includes("moment") || title.includes("checking");
          // Également vérifier s'il y a encore des iframes CF actives (challenge en cours)
          const hasCfIframe = !!document.querySelector(
            "iframe[src*='challenges.cloudflare.com'], iframe[src*='cdn-cgi/challenge-platform']"
          );
          return isCfChallenge || hasCfIframe;
        }).catch(() => false);

        if (cfStillRunning) {
          const title = await page.title().catch(() => "?");
          console.log(`[spain-pb] ⏳ CF challenge encore en cours (titre: "${title}") — attente avant Continuar…`);
          await new Promise((r) => setTimeout(r, 2_000));
          // Ne pas tenter le clic cette itération — recommencer la boucle
        } else {
          // CF a fini → clic Continuar avec le cf_clearance existant (déjà frais via JSD de la navigation).
          // NE PAS supprimer cf_clearance avant Continuar : la suppression déclenche un JSD spontané
          // "cookie fantôme" (CF valide sans réémettre cf_clearance), puis le widget appelle /main/
          // sans cf_clearance dans les cookies → CF retourne 0B systématiquement (comportement CF ≥ 2026-07).
          // Le cf_clearance obtenu pendant la navigation JSD est déjà valide pour /main/.

          // Tenter le clic Continuar
          const acceptFlowResult = await clickInteractiveSpainAcceptFlow(page);
          continueClicked = acceptFlowResult.clicked;
          if (!continueClicked) {
            console.log(`[spain-pb] 🖱️ clickInteractiveSpainAcceptFlow → ${acceptFlowResult.reason}`);
          }

          if (!continueClicked) {
            const domState = await page.evaluate(() => ({
              hash: window.location.hash,
              title: document.title.slice(0, 60),
              hasBtn: !!document.getElementById("idDivBktCustomContinueButton"),
              btnVisible: (() => { const b = document.getElementById("idDivBktCustomContinueButton"); return b ? b.offsetParent !== null : false; })(),
              hasWidget: !!document.getElementById("idBktWidgetDefaultBodyContainer"),
              hasCustom: !!document.getElementById("idBktDefaultCustomContainer"),
              hasTurnstile: !!document.querySelector("iframe[src*='challenges.cloudflare.com'], .cf-turnstile, [data-sitekey]"),
              bodySnippet: (document.body?.innerText ?? "").slice(0, 120).replace(/\n/g, " "),
            })).catch(() => ({ error: "evaluate failed" }));
            console.log(`[spain-pb] 🔍 DOM: ${JSON.stringify(domState)}`);
            await new Promise((r) => setTimeout(r, 2_000));
          }
        }
      }

      if (continueClicked) {
        console.log(`[spain-pb] ✅ Continuar cliqué — armer intercepteur /main/ pour JSD POST…`);

        // ── Intercepteur CDP Fetch POST : bloquer /main/ jusqu'au JSD de la SESSION POST ──
        //
        // COMPORTEMENT CF SELON LA VERSION :
        //
        // Ancien CF (≤ 2026-07): JSD oneshot déclenché PAR le POST Continuar.
        //   → L'intercepteur attend le signal JSD POST → /main/ libéré avec contenu.
        //
        // Nouveau CF (≥ 2026-07): JSD oneshot déclenché SPONTANÉMENT avant Continuar,
        //   juste après la suppression de cf_clearance (pendant le wait "bouton invisible").
        //   → Si on arme l'intercepteur et attend un JSD POST, celui-ci ne vient jamais
        //     → timeout 8s → /main/ libéré mais retourne 0B (CF n'a pas validé le POST).
        //
        // FIX : Si un JSD a déjà eu lieu avant le clic Continuar (jsdOneShotAt > 0),
        //   CF a DÉJÀ validé le fingerprint TLS → ne pas bloquer /main/.
        //   On laisse le widget appeler /main/ naturellement et le capture via
        //   Network.loadingFinished (cdpNet, déjà armé en début de function).
        //   Si au contraire aucun JSD spontané n'a eu lieu, on arme l'intercepteur
        //   comme avant (ancien comportement CF).

        const preContinuarJsdFired = jsdOneShotAt > 0;

        if (!preContinuarJsdFired) {
          // Ancien comportement : JSD attendu après le POST Continuar.
          jsdOneShotAccepted = false; // Reset — on attend le JSD POST
          const jsdPostSignal = new Promise<void>((resolve) => { jsdOneShotResolve = resolve; });

          try {
            cdpFetch = await page.createCDPSession();
            await cdpFetch.send("Fetch.enable", {
              patterns: [{ urlPattern: "*onlinebookings/main*", requestStage: "Request" }],
            });
            cdpFetch.on("Fetch.requestPaused", async (ev: any) => {
              const url: string = ev.request?.url ?? "";
              console.log(`[spain-pb] 🔒 /main/ intercepté POST — attente JSD POST (max 8s)… ${url.slice(0, 80)}`);
              const reason = await Promise.race([
                jsdPostSignal.then(() => "jsd" as const),
                new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8_000)),
              ]);
              if (reason === "jsd" && jsdOneShotAccepted) {
                // cf_clearance réémis → /main/ reçoit le JSONP avec délai de sécurité
                console.log(`[spain-pb] 🔓 /main/ libéré — JSD POST accepté ✅ délai 300ms…`);
                await new Promise((r) => setTimeout(r, 300));
              } else {
                // Timeout ou cookie fantôme — cf_clearance est toujours présent dans le browser
                // (on ne le supprime plus), CF l'enverra avec /main/ → contenu attendu.
                const why = reason === "timeout" ? "timeout 8s" : "cookie fantôme (CF session valide)";
                console.warn(`[spain-pb] ⚠️ /main/ libéré après ${why} — cf_clearance en place`);
                await new Promise((r) => setTimeout(r, 300));
              }
              await cdpFetch.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
            });
            console.log(`[spain-pb] 🔒 Intercepteur /main/ POST armé (CDP Fetch)`);
          } catch (fetchInterceptErr) {
            console.warn(`[spain-pb] ⚠️ Fetch interceptor /main/ POST (non-fatal): ${fetchInterceptErr}`);
          }
        } else {
          // JSD spontané avant Continuar — ne devrait plus arriver maintenant qu'on ne supprime
          // plus cf_clearance. CF a validé le fingerprint → /main/ peut s'exécuter librement.
          // On laisse Network.loadingFinished (déjà armé) capturer le body.
          console.log(`[spain-pb] ℹ️ JSD pré-Continuar détecté (${Date.now() - jsdOneShotAt}ms ago) — intercepteur Fetch désactivé, /main/ libre`);
        }

        // Attendre jusqu'à 20s que le listener XHR capture la réponse /main/
        console.log(`[spain-pb] ⏳ Attente XHR /main/ POST (max 20s)…`);
        const xhrDeadline = Date.now() + 20_000;
        while (Date.now() < xhrDeadline && capturedMainBody.length < 100) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (capturedMainBody.length > 100) {
          prefetchedMainHtml = capturedMainBody;
          console.log(`[spain-pb] 📦 /main/ XHR capturé via listener (${prefetchedMainHtml.length}B)`);
          // Attendre que mainv1.js charge et appelle naturellement getwidgetconfigurations/ + getservices/.
          // CDP les intercepte dans Network.loadingFinished ci-dessus — plus fiable que page.evaluate(fetch)
          // qui retournait 0B car appelé avant que le widget ait initialisé la session PHP.
          console.log(`[spain-pb] ⏳ Attente APIs widget naturelles (mainv1.js, max 10s)…`);
          await Promise.race([
            widgetApisSignal,
            new Promise<void>((r) => setTimeout(r, 10_000)),
          ]);
          const cfgLen = this._apiPrefetchCache.get("getwidgetconfigurations/")?.length ?? 0;
          const svcLen = this._apiPrefetchCache.get("getservices/")?.length ?? 0;
          console.log(
            `[spain-pb] ⚡ Widget APIs — getwidgetconfigurations: ${cfgLen > 0 ? cfgLen + "B ✅" : "0B ❌"} | getservices: ${svcLen > 0 ? svcLen + "B ✅" : "0B ❌"}`,
          );

          // ── Simulation clic service → déclenche getagendas/ + datetime/ naturellement ──
          // Ces endpoints ne sont appelés par le widget QUE sur interaction utilisateur.
          // Un appel page.evaluate(fetch()) retourne 0B : le PHPSESSID Bookitit est lié
          // à la séquence natural du widget. On simule un clic pour que le widget fasse
          // lui-même l'appel, et CDP intercepte la réponse.
          if (svcLen > 0) {
            try {
              const nowDt  = new Date();
              const curMo  = `${nowDt.getFullYear()}-${String(nowDt.getMonth() + 1).padStart(2, "0")}`;
              const nextMo = (() => { const d = new Date(nowDt.getFullYear(), nowDt.getMonth() + 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();

              // ── Chemin 1 : attente getagendas/ auto (Backbone single-service) ────
              // serviceslist.js checkSetSelected() auto-sélectionne si 1 seul service
              // sans rendre de liens #selectservice/ — getagendas/ arrive tout seul.
              console.log(`[spain-pb] ⏳ Attente getagendas/ auto (max 4s) → clic service si absent…`);
              await Promise.race([
                widgetSlotSignal,
                new Promise<void>((r) => setTimeout(r, 4_000)),
              ]);

              // ── Chemin 2 : fallback clic #selectservice/ (widget multi-services) ──
              // Si getagendas/ n'est pas encore arrivé après 4s, le widget a besoin
              // d'une interaction explicite sur un lien #selectservice/{id}.
              if ((this._apiPrefetchCache.get("getagendas/")?.length ?? 0) === 0) {
                console.log(`[spain-pb] 🔍 getagendas/ absent — tentative clic service (multi-service widget)…`);
                const clickedHref = await page.evaluate((): string | null => {
                  const links = Array.from(
                    document.querySelectorAll<HTMLAnchorElement>('a[href*="#selectservice/"]'),
                  );
                  for (const a of links) {
                    const href = a.getAttribute("href") ?? "";
                    if (href.includes("<%") || href.includes("%>")) continue;
                    a.click();
                    return href;
                  }
                  return null;
                }).catch(() => null);

                if (clickedHref) {
                  console.log(`[spain-pb] 🖱️ Clic service : ${clickedHref} — attente getagendas/ (max 8s)…`);
                  await Promise.race([
                    widgetSlotSignal,
                    new Promise<void>((r) => setTimeout(r, 8_000)),
                  ]);
                } else {
                  console.warn(`[spain-pb] ⚠️ Aucun lien #selectservice/ dans le DOM — getagendas/ non déclenché`);
                }
              }

              const agLen0 = this._apiPrefetchCache.get("getagendas/")?.length ?? 0;
              if (agLen0 > 0) {
                // getagendas/ capturé → le widget va appeler datetime/ dans les ~1-2s
                console.log(`[spain-pb] ✅ getagendas/ capturé (${agLen0}B) — attente datetime/ (max 5s)…`);
                let dtWaited = 0;
                while (dtWaited < 5_000) {
                  if ((this._apiPrefetchCache.get(`datetime/${curMo}`)?.length ?? this._apiPrefetchCache.get("datetime/")?.length ?? 0) > 0) break;
                  await new Promise<void>((r) => setTimeout(r, 300));
                  dtWaited += 300;
                }
              }

              const agLen = this._apiPrefetchCache.get("getagendas/")?.length ?? 0;
              const dtLen = this._apiPrefetchCache.get(`datetime/${curMo}`)?.length ?? this._apiPrefetchCache.get("datetime/")?.length ?? 0;
              console.log(
                `[spain-pb] ⚡ Slot APIs — getagendas: ${agLen > 0 ? agLen + "B ✅" : "0B ❌"} | datetime/${curMo}: ${dtLen > 0 ? dtLen + "B ✅" : "0B ❌"}`,
              );

              // ── Navigation mois suivant → capturer datetime/ pour mois +1 ──────
              // Le widget Bookitit n'appelle datetime/ que pour le mois affiché.
              // On simule un clic ">" pour capturer mois +1 aussi.
              if (!this._apiPrefetchCache.has(`datetime/${nextMo}`) && agLen > 0) {
                try {
                  console.log(`[spain-pb] 🗓 Navigation mois suivant → capture datetime/${nextMo}…`);
                  const nextClicked = await page.evaluate((): string | null => {
                    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
                      ".ui-datepicker-next, .fc-next-button, " +
                      "[class*='next'][class*='month'], [class*='month'][class*='next'], " +
                      "[class*='calendar'] [class*='next'], [class*='cal'] [class*='next'], " +
                      "a.next, button.next, span.next, i.next, " +
                      "a[title*='siguiente'], a[title*='next'], button[title*='next'], " +
                      "a[aria-label*='next'], button[aria-label*='next']",
                    ));
                    for (const btn of candidates) {
                      if (!btn.offsetParent) continue;
                      btn.click();
                      return btn.className + "|" + btn.tagName;
                    }
                    return null;
                  }).catch(() => null);

                  if (nextClicked) {
                    console.log(`[spain-pb] 🖱️ Bouton mois suivant cliqué (${nextClicked}) — attente datetime/${nextMo} (max 5s)…`);
                    let nmWaited = 0;
                    while (nmWaited < 5_000) {
                      if (this._apiPrefetchCache.has(`datetime/${nextMo}`)) break;
                      await new Promise<void>((r) => setTimeout(r, 300));
                      nmWaited += 300;
                    }
                    const dtNextLen = this._apiPrefetchCache.get(`datetime/${nextMo}`)?.length ?? 0;
                    console.log(`[spain-pb] 🗓 datetime/${nextMo}: ${dtNextLen > 0 ? dtNextLen + "B ✅" : "0B ❌ (non capturé)"}`);
                  } else {
                    console.warn(`[spain-pb] ⚠️ Bouton mois suivant introuvable — datetime/${nextMo} non capturé`);
                  }
                } catch (nmErr) {
                  console.warn(`[spain-pb] ⚠️ Navigation mois suivant (non-fatal): ${nmErr}`);
                }
              }
            } catch (slotErr) {
              console.warn(`[spain-pb] ⚠️ Attente slot APIs (non-fatal): ${slotErr}`);
            }
          }
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
      if (cdpFetch) {
        // Désactiver l'intercepteur Fetch — libère toutes les requêtes /main/ bloquées
        cdpFetch.send("Fetch.disable", {}).catch(() => {});
        cdpFetch.detach().catch(() => {});
        cdpFetch = null;
      }
      // Résoudre jsdOneShotSignal si pas encore résolu — évite les attentes bloquées
      if (jsdOneShotResolve) jsdOneShotResolve();
    }

    // ── Retry cookie fantôme : reset PHPSESSID uniquement + re-navigation ────
    //
    // PROBLÈME (cookie fantôme + /main/ = 0B) :
    //   La nonce JSD est time-windowed et liée au PHPSESSID Bookitit côté serveur.
    //   Le JSD natif la consomme pendant la résolution du CF Managed Challenge initial
    //   (étape 2 du flow). Quand le widget JS tente la MÊME nonce après Continuar →
    //   CF répond "cookie fantôme" (nonce déjà utilisée, pas de nouveau cf_clearance).
    //   Bookitit exige que le JSD post-Continuar émette un cf_clearance frais → 0B.
    //
    //   Ce problème survient SYSTÉMATIQUEMENT lors de la création/renouvellement de
    //   session (chaque solve consomme la nonce via JSD natif).
    //
    // FIX :
    //   Supprimer UNIQUEMENT PHPSESSID (pas cf_clearance) → Bookitit crée une
    //   NOUVELLE session PHP → CF génère une NONCE FRAÎCHE pour cette session.
    //   Re-naviguer vers le widget → CF ne re-challenge PAS (cf_clearance valide)
    //   → widget charge avec la nonce fraîche → JSD du widget la consomme EN PREMIER
    //   → CF émet un nouveau cf_clearance → /main/ retourne 124KB.
    //
    // POURQUOI pas de JSD natif au round 2 :
    //   cf_clearance est toujours valide → CF ne lance pas de Managed Challenge →
    //   JSD natif ne fire pas → nonce préservée pour le widget JSD post-Continuar.
    if (prefetchedMainHtml.length < 100 && jsdOneShotAt > 0 && !jsdOneShotAccepted) {
      // ── Détection IP de confiance CF (fast-track) ──────────────────────────────
      // Si cf_clearance a été obtenu en < 3s, CF reconnaît l'IP Decodo comme fiable
      // et émet cf_clearance sans JSD complet. Dans ce cas, le JSD post-Continuar
      // est toujours phantom car CF dit "déjà valide" → Round 2 est inutile :
      //   • Round 2 reset PHPSESSID seulement → même IP → CF réutilise le même
      //     challenge token (même timestamp dans /cdn-cgi/challenge-platform/…) →
      //     JSD oneshot encore phantom → /main/ = 0B garanti.
      // Fix : sauter Round 2, laisser closeAndInvalidate tourner vers une IP inconnue
      // de CF (qui fera un JSD complet 10-40s → vrai cf_clearance → /main/ = 124KB).
      const TRUSTED_IP_THRESHOLD_MS = 3_000;
      if (jsdSolveMs > 0 && jsdSolveMs < TRUSTED_IP_THRESHOLD_MS) {
        console.log(
          `[spain-pb] ⚡ IP de confiance CF (cf_clearance en ${jsdSolveMs}ms < ${TRUSTED_IP_THRESHOLD_MS}ms) — ` +
          `Round 2 ignoré (même challenge token garanti → phantom) — closeAndInvalidate + rotation IP nécessaire`,
        );
        // Ne pas entrer dans le bloc Round 2 — on tombe directement dans le fallback
        // fetch puis la session sera invalidée par l'HTTP scanner (0B → closeAndInvalidate).
      } else {
      console.log(
        `[spain-pb] 🔄 Cookie fantôme + /main/ 0B — reset PHPSESSID (cf_clearance conservé) ` +
        `+ re-navigation pour nonce fraîche…`,
      );
      try {
        // 1. Supprimer PHPSESSID uniquement — force nouvelle session PHP = nouvelle nonce CF
        const cdpPhpReset = await page.createCDPSession();
        await cdpPhpReset.send("Network.deleteCookies", { name: "PHPSESSID", domain: ".citaconsular.es" }).catch(() => {});
        await cdpPhpReset.send("Network.deleteCookies", { name: "PHPSESSID", domain: "www.citaconsular.es" }).catch(() => {});
        // Purger le storage CF lié à la session (localStorage JSD, IndexedDB) — la nonce
        // est également mise en cache dans localStorage. La vider garantit que CF recalcule
        // une nonce fraîche depuis le serveur lors du prochain chargement du widget.
        await cdpPhpReset.send("Storage.clearDataForOrigin", {
          origin: "https://www.citaconsular.es",
          storageTypes: "local_storage,session_storage,indexeddb",
        }).catch(() => {});
        await cdpPhpReset.detach().catch(() => {});
        console.log(`[spain-pb] 🗑️ PHPSESSID + localStorage JSD purgés — nonce fraîche attendue`);

        // 2. Re-navigation vers le widget — CF ne re-challenge PAS (cf_clearance valide)
        console.log(`[spain-pb] 🌐 Re-navigation widget (round 2 — nonce fraîche) : ${targetUrl.slice(0, 80)}`);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 40_000 })
          .catch((e: unknown) => console.warn(`[spain-pb] ⚠️ Re-navigation (non-fatal): ${e}`));

        // Refresh page reference après navigation
        try {
          const freshPages2 = await browser.pages();
          if (freshPages2.length > 0) { page = freshPages2[0]; this._page = page; }
        } catch { /* non-fatal */ }

        // 3. CDP Net listener minimal pour capturer /main/ du round 2
        let retryMainBody = "";
        let retryCdpNet: any = null;
        const retryMainPending = new Map<string, string>(); // requestId → url
        let retryJsdAccepted = false;

        try {
          retryCdpNet = await page.createCDPSession();
          await retryCdpNet.send("Network.enable", {});

          retryCdpNet.on("Network.requestWillBeSent", (ev: any) => {
            const url: string = ev.request?.url ?? "";
            if (url.includes("onlinebookings/main")) retryMainPending.set(ev.requestId, url);
            if (url.includes("citaconsular.es")) {
              console.log(`[spain-pb] 🌐 r2 req: ${ev.request.method} ${url.slice(0, 100)}`);
            }
          });

          retryCdpNet.on("Network.responseReceived", (ev: any) => {
            const url: string = ev.response?.url ?? "";
            if (url.includes("jsd/oneshot")) {
              const setCookie: string = ev.response.headers?.["set-cookie"] ?? "";
              retryJsdAccepted = setCookie.includes("cf_clearance");
              console.log(
                `[spain-pb] 🔑 r2 JSD oneshot: ` +
                (retryJsdAccepted ? "✅ nouveau cf_clearance émis" : "❌ cookie fantôme encore"),
              );
            }
          });

          retryCdpNet.on("Network.loadingFinished", async (ev: any) => {
            if (!retryMainPending.has(ev.requestId)) return;
            retryMainPending.delete(ev.requestId);
            try {
              const { body, base64Encoded } = await retryCdpNet.send("Network.getResponseBody", {
                requestId: ev.requestId,
              });
              const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
              if (decoded.length > retryMainBody.length) {
                retryMainBody = decoded;
                console.log(`[spain-pb] 📡 r2 /main/ capturé via CDP (${decoded.length}B)`);
              }
            } catch { /* non-fatal */ }
          });
        } catch (cdpErr) {
          console.warn(`[spain-pb] ⚠️ r2 CDP Net setup (non-fatal): ${cdpErr}`);
        }

        // 4. Attendre que CF finisse (si challenge inattendu) + trouver le bouton Continuar
        let retryContinuarClicked = false;
        const retryContDeadline = Date.now() + 25_000;
        while (Date.now() < retryContDeadline && !retryContinuarClicked) {
          const cfDone = await page.evaluate(() => {
            const title = document.title.toLowerCase();
            return !(title.includes("instant") || title.includes("moment") || title.includes("checking")) &&
              !document.querySelector("iframe[src*='challenges.cloudflare.com'], iframe[src*='cdn-cgi/challenge-platform']");
          }).catch(() => true);

          if (!cfDone) {
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }

          retryContinuarClicked = await page.evaluate(() => {
            const btn = document.getElementById("idDivBktCustomContinueButton");
            if (btn && (btn as HTMLElement).offsetParent !== null) { (btn as HTMLElement).click(); return true; }
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
            const allClickable = document.querySelectorAll("a, button, [role='button']");
            for (let i = 0; i < allClickable.length; i++) {
              const el = allClickable[i] as HTMLElement;
              const txt = (el.textContent || "").trim().toLowerCase();
              if ((txt.indexOf("continu") >= 0 || txt.indexOf("siguiente") >= 0) && el.offsetParent !== null) {
                el.click(); return true;
              }
            }
            return false;
          }).catch(() => false);

          if (!retryContinuarClicked) await new Promise((r) => setTimeout(r, 600));
        }

        if (retryContinuarClicked) {
          console.log(`[spain-pb] ✅ r2 Continuar cliqué — attente /main/ (20s)…`);
        } else {
          console.warn(`[spain-pb] ⚠️ r2 Continuar introuvable après 25s`);
        }

        // 5. Attendre que /main/ soit capturé (20s)
        const retryXhrDeadline = Date.now() + 20_000;
        while (Date.now() < retryXhrDeadline && retryMainBody.length < 100) {
          await new Promise((r) => setTimeout(r, 500));
        }

        if (retryCdpNet) {
          retryCdpNet.detach().catch(() => {});
          retryCdpNet = null;
        }

        if (retryMainBody.length > 100) {
          prefetchedMainHtml = retryMainBody;
          console.log(
            `[spain-pb] 📦 r2 /main/ capturé (${prefetchedMainHtml.length}B) — ` +
            (retryJsdAccepted ? "JSD ✅ cf_clearance frais" : "JSD ❌ cookie fantôme encore (session dégradée)"),
          );
          // Prefetch APIs companion pendant que la session PHP est chaude
          await this._prefetchBookititApis(page, targetUrl).catch((e: unknown) =>
            console.warn(`[spain-pb] ⚠️ r2 _prefetchBookititApis (non-fatal): ${e}`),
          );
        } else {
          console.warn(
            `[spain-pb] ⚠️ r2 /main/ toujours 0B après reset PHPSESSID ` +
            `(${retryMainBody.length}B) — fetch direct tentera en dernier recours`,
          );
        }
      } catch (retryErr) {
        console.warn(`[spain-pb] ⚠️ Retry cookie fantôme (non-fatal): ${retryErr}`);
      }
      } // fin else (non-trusted-IP Round 2)
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

      // Rafraîchir la référence page avant le fetch fallback — après le clic Continuar,
      // CF peut avoir redirigé vers une nouvelle Frame (la variable locale est obsolète).
      try {
        const freshPages = await browser.pages();
        if (freshPages.length > 0) {
          const livePage = freshPages[0];
          if (livePage !== page) {
            page = livePage;
            this._page = page;
            console.log(`[spain-pb] 🔄 Référence page rafraîchie avant fetch /main/ (Frame détachée évitée)`);
          }
        }
      } catch { /* non-fatal */ }

      // S'assurer qu'on est sur un contexte same-origin citaconsular.es
      // (si page.goto portail a échoué, on pourrait être sur about:blank ou ailleurs)
      const currentOrigin: string = await page.evaluate(() => window.location.origin).catch(() => "");
      if (!currentOrigin.includes("citaconsular.es")) {
        console.log(`[spain-pb] 🔄 Pas sur citaconsular.es (${currentOrigin}) — navigation root pour contexte same-origin…`);
        await page.goto("https://www.citaconsular.es/", {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        }).catch((e: unknown) => console.warn(`[spain-pb] ⚠️ Navigation root (non-fatal): ${e}`));
        // Refresh encore après la navigation root
        try {
          const freshPages = await browser.pages();
          if (freshPages.length > 0) { page = freshPages[0]; this._page = page; }
        } catch { /* non-fatal */ }
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
        // Même chose que pour le listener : prefetch immédiat pendant que le state PHP est chaud.
        await this._prefetchBookititApis(page, targetUrl).catch((e: unknown) =>
          console.warn(`[spain-pb] ⚠️ _prefetchBookititApis fallback (non-fatal): ${e}`),
        );
      } else {
        console.warn(
          `[spain-pb] ⚠️ Fetch direct /main/ échoué: "${evalBody.slice(0, 120)}" — scanner devra retenter`,
        );
      }
    }

    // ── Étape 7 : Extraire les cookies + construire la session ────────────────
    // Wrap en try/catch — si la page locale est devenue obsolète (Frame détachée après
    // une redirection CF), on tente un dernier refresh depuis browser.pages().
    let allPuppeteerCookies: import("puppeteer").Cookie[] = [];
    try {
      allPuppeteerCookies = await page.cookies("https://www.citaconsular.es");
    } catch (cookieErr) {
      console.warn(`[spain-pb] ⚠️ page.cookies() sur page obsolète (${String(cookieErr).slice(0, 80)}) — fallback browser.pages()…`);
      try {
        const freshPages = await browser.pages();
        if (freshPages.length > 0) {
          page = freshPages[0];
          this._page = page;
          allPuppeteerCookies = await page.cookies("https://www.citaconsular.es");
          console.log(`[spain-pb] ✅ Cookies récupérés via page fraîche (${allPuppeteerCookies.length} cookies)`);
        }
      } catch (fallbackErr) {
        console.warn(`[spain-pb] ⚠️ Fallback cookies échoué: ${fallbackErr} — session sans cookies frais`);
      }
    }
    const allCookies = allPuppeteerCookies.map((c) => ({ name: c.name, value: c.value }));

    // Récupérer le cf_clearance final (peut avoir été mis à jour par CF post-Continuar)
    const finalCf = allCookies.find((c) => c.name === "cf_clearance")?.value ?? "";

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

  // ── Re-solve proactif conditionnel ───────────────────────────────────────

  /**
   * Tente un re-solve CF en parallèle de la session courante.
   *
   * Comportement :
   *   Session A valide (expire bientôt) → lance un solve complet
   *   Si B ok (prefetchedMainHtml > 0) → remplace A par B
   *   Si B échoue ou prefetch vide    → restaure A, retry différé
   *
   * Différence critique avec closeAndInvalidate() + ensureSession() :
   *   - On ne ferme PAS le browser (pas de rotation IP, pas de délai 1.5s)
   *   - La session A reste active jusqu'à ce que B soit validée
   *   - Aucune fenêtre de vulnérabilité entre la destruction de A et la création de B
   */
  async tryRenewSession(
    targetUrl: string = DEFAULT_WIDGET_URL,
  ): Promise<SpainCfSession | null> {
    const backup = this._cachedSession;
    const backupRemainMin = backup
      ? Math.round((backup.expiresAt - Date.now()) / 60_000)
      : 0;

    console.log(
      `[spain-pb] 🔄 Re-solve proactif conditionnel` +
      (backup ? ` — session A conservée (${backupRemainMin}min restantes)` : ""),
    );

    // Effacer temporairement le cache pour que _resolveWithTurnstileInjection
    // soit effectivement appelé (sinon ensureSession() court-circuite).
    this._cachedSession = null;
    this._prefetchRetried = false;

    let newSession: SpainCfSession | null = null;
    try {
      const t0 = Date.now();
      newSession = await this._resolveWithTurnstileInjection(targetUrl, t0);
    } catch (err) {
      console.warn(`[spain-pb] ⚠️ Re-solve proactif — erreur inattendue: ${err}`);
    }

    // Valider : la nouvelle session doit avoir du prefetchedMainHtml
    const prefetchLen = (newSession as any)?.prefetchedMainHtml?.length ?? 0;
    const newValid = newSession != null && prefetchLen > 0;

    if (newValid) {
      // ✅ Nouvelle session ok → remplace A
      console.log(
        `[spain-pb] ✅ Re-solve proactif réussi — session B activée` +
        ` (prefetch: ${prefetchLen}B, expire: ${new Date(newSession!.expiresAt).toISOString()})`,
      );
      // _cachedSession déjà mis à jour par _resolveWithTurnstileInjection
      return newSession!;
    }

    // ❌ Nouvelle session vide/nulle → restaurer A
    if (backup && Date.now() < backup.expiresAt) {
      this._cachedSession = backup;
      setActiveSpainCfSession(backup);
      const remainMin = Math.round((backup.expiresAt - Date.now()) / 60_000);
      console.log(
        `[spain-pb] ↩️ Re-solve proactif échoué (prefetch: ${prefetchLen}B)` +
        ` — session A restaurée (${remainMin}min restantes), retry différé`,
      );
      return backup;
    }

    // Backup expiré ou absent + nouveau solve raté → session nulle
    console.warn(
      `[spain-pb] ❌ Re-solve proactif échoué et session A expirée` +
      ` — prochaine probe déclenchera un solve complet`,
    );
    return null;
  }

  // ── Fermeture propre ──────────────────────────────────────────────────────

  async close(): Promise<void> {
    this._page = null;
    this._apiPrefetchCache.clear();
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
 * Tente un re-solve CF en parallèle de la session courante (re-solve proactif conditionnel).
 *
 * Si le solve réussit avec prefetchedMainHtml > 0 → remplace la session actuelle.
 * Si le solve échoue → restaure l'ancienne session ; elle reste valide jusqu'à expiration.
 *
 * À utiliser depuis la watcher loop à la place de ensureSpainPersistentBrowserSession()
 * pour le chemin proactif (session expire bientôt mais pas encore expirée).
 */
export async function tryRenewSpainPersistentBrowserSession(
  targetUrl: string = DEFAULT_WIDGET_URL,
): Promise<SpainCfSession | null> {
  return spainPersistentBrowser.tryRenewSession(targetUrl);
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

/**
 * Exécute un GET depuis le contexte browser (page.evaluate → fetch) et retourne le body.
 *
 * Utilisé par le scanner pour appeler getwidgetconfigurations/ et getservices/ sans
 * changer d'IP : le browser et ces appels JSONP partagent le même proxy Decodo et le
 * même PHPSESSID, ce que impit ne peut pas garantir (rotation IP indépendante).
 *
 * Retourne une chaîne vide si le browser n'est pas disponible ou si le fetch échoue.
 */
/**
 * Appelle un endpoint Bookitit via jQuery.ajax depuis le contexte de la page Chromium.
 *
 * Utilisé comme fallback quand page.evaluate(fetch()) retourne 0B pour les endpoints
 * qui nécessitent la séquence naturelle du widget (signin/, summary/, confirmclient/).
 * jQuery est déjà chargé par le widget Bookitit — on réutilise son mécanisme AJAX
 * (même headers, même state PHP session) pour contourner le blocage 0B.
 *
 * Le résultat est le JSON.stringify() de l'objet déjà parsé par jQuery (pas de
 * wrapper JSONP) — parseJsonpResponse() le gère via le fallback JSON.parse().
 */
export async function callBookititViaJQueryInPage(url: string): Promise<string> {
  const page = spainPersistentBrowser.getActivePage();
  if (!page) {
    console.warn("[spain-pb] ⚠️ callBookititViaJQueryInPage — page non disponible");
    return "";
  }

  const endpoint = url.match(/\/onlinebookings\/([^?]+)/)?.[1] ?? url.slice(0, 60);
  const pageUrl = page.url().slice(0, 80);
  console.log(`[spain-pb] 🎯 jQueryAjax → ${endpoint} (page: ${pageUrl})`);

  try {
    // IMPORTANT : on passe la fonction comme string littérale, PAS comme fonction TS.
    // Raison : tsx/esbuild compile la source TS et injecte __name() dans les fonctions
    // pour le debug. Quand Puppeteer sérialise la fonction compilée et l'envoie au
    // browser, le browser lève ReferenceError: __name is not defined.
    // Passer la logique comme expression string évite toute transformation esbuild.
    const escapedUrl = JSON.stringify(url);
    // Promise.race : protège contre page.evaluate() qui se bloque si la page est dans un
    // état instable après CF challenge (le timer JS 22s dans le browser ne peut pas se déclencher
    // si V8 est gelé). Le timeout TS (26s) garantit une sortie propre dans tous les cas.
    const evalPromise = page.evaluate(`
      (function(u) {
        var jq = window.jQuery;
        if (!jq) {
          return fetch(u, {
            method: 'GET',
            credentials: 'include',
            headers: {
              'Accept': 'text/javascript, application/javascript, */*; q=0.01',
              'X-Requested-With': 'XMLHttpRequest'
            }
          }).then(function(r) {
            return r.text().then(function(b) {
              return r.ok ? b : ('__ERR_STATUS_' + r.status);
            });
          }).catch(function(e) {
            return '__ERR_NO_JQUERY_' + String(e).slice(0, 80);
          });
        }
        // Script tag manuel avec callback fixe.
        //
        // Pourquoi pas dataType:'jsonp' ?
        //   jQuery JSONP génère son propre cbName (jQuery21107…) et envoie "?callback=jQuery21107…".
        //   Le serveur Bookitit PRÉFIXE la réponse : "callback=jQuery21107…(data)".
        //   Le browser exécute le script — "callback = jQuery21107…(data)" est une ASSIGNATION
        //   (pas un appel direct), donc jQuery21107… est bien appelé…  mais jQuery s'attendait
        //   à "jQuery21107…(data)" sans le préfixe "callback=" → parseerror.
        //
        // Notre fix — script tag avec cbName qu'on contrôle :
        //   1. On déclare window[cbName] = resolve(JSON.stringify(data)).
        //   2. On injecte un <script src="url?callback=cbName">.
        //   3. Le serveur retourne "callback=cbName(data)".
        //   4. Le browser exécute : callback = cbName(data)
        //      → cbName(data) est évalué en premier → notre resolve() est appelé ✅.
        //   5. "callback" (variable globale) reçoit la valeur de retour (undefined) — sans effet.
        //   Note : si window.callback n'est pas déclaré, l'assignation lèverait un ReferenceError
        //   en mode strict. On force window.callback = window.callback || null pour l'éviter.
        return new Promise(function(resolve) {
          // IMPORTANT : le serveur Bookitit valide que callback= commence par "jQuery".
          // Toute autre valeur (ex: "__bkt_", "cb12345") retourne un body vide/incorrect.
          var cbName = 'jQuery__bkt_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
          var timer = setTimeout(function() {
            delete window[cbName];
            if (sc && sc.parentNode) sc.parentNode.removeChild(sc);
            resolve('__ERR_JQUERY_SCRIPT_TIMEOUT');
          }, 22000);
          window[cbName] = function(data) {
            clearTimeout(timer);
            delete window[cbName];
            if (sc && sc.parentNode) sc.parentNode.removeChild(sc);
            try { resolve(JSON.stringify(data)); }
            catch(e) { resolve('__ERR_STRINGIFY'); }
          };
          // Prévenir ReferenceError si le browser est en mode strict et "callback" non déclaré.
          if (typeof window.callback === 'undefined') window.callback = null;
          // Remplacer le callback dans l'URL par notre cbName fixe.
          var scriptUrl = u.replace(/([?&])callback=[^&]+/, function(m, sep) {
            return sep + 'callback=' + cbName;
          });
          var sc = document.createElement('script');
          sc.onerror = function() {
            clearTimeout(timer);
            delete window[cbName];
            resolve('');
          };
          sc.src = scriptUrl;
          document.head.appendChild(sc);
        });
      })(${escapedUrl})
    `);
    const timeoutPromise: Promise<string> = new Promise<string>((resolve) =>
      setTimeout(() => resolve("__ERR_EVALUATE_TIMEOUT"), 26_000),
    );
    const result = (await Promise.race([evalPromise, timeoutPromise])) as string;

    const bodyLen = result.length;
    console.log(`[spain-pb] 📡 jQueryAjax ${endpoint} → ${bodyLen}B`);

    if (result.startsWith("__ERR_")) {
      console.warn(`[spain-pb] ⚠️ jQueryAjax ${endpoint} échoué: ${result.slice(0, 160)}`);
      return "";
    }
    return result;
  } catch (err) {
    console.warn(`[spain-pb] ⚠️ callBookititViaJQueryInPage exception: ${err}`);
    return "";
  }
}

/**
 * Navigue le widget Bookitit vers #selecttime/DATE/TIME/AGENDA et capture TOUS les
 * appels réseau émis pendant la transition (XHR, fetch, JSONP via script tags).
 *
 * Stratégie en deux passes :
 *  1. Clic DOM réel sur l'élément du créneau si le widget est déjà à la vue datetime.
 *     (La click-handler Backbone peut faire un call HTTP AVANT de changer le hash —
 *      en changeant juste window.location.hash on saute cette étape.)
 *  2. Fallback : changer window.location.hash directement si aucun élément trouvé.
 *
 * Capture réseau : CDP Network.requestWillBeSent (attrape JSONP/script tags en plus
 * de XHR et fetch) + patch JS document.createElement('script') pour backup.
 *
 * Retourne le hash Backbone résolu (ex: "#signupsecondappointment") ou "" si timeout.
 */
export interface SpainAcceptFlowClickResult {
  clicked: boolean;
  reason: string;
  htmlSnippet: string;
}

export async function clickInteractiveSpainAcceptFlow(page: Page): Promise<SpainAcceptFlowClickResult> {
  try {
    const result = await page.evaluate(() => {
      const visible = (el: Element | null): boolean => {
        if (!el) return false;
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = (el as HTMLElement).getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      };

      const textOf = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();

      const tryClick = (el: Element | null, reason: string): { clicked: boolean; reason: string; htmlSnippet: string } | null => {
        if (!el || !visible(el)) return null;
        const htmlSnippet = (el as HTMLElement).outerHTML.slice(0, 220);
        (el as HTMLElement).click();
        return { clicked: true, reason, htmlSnippet };
      };

      const captchaContinueBtn = document.getElementById("idCaptchaButton") as HTMLElement | null;
      const captchaTokenForm = Array.from(document.forms).find((form) => {
        const tokenInput = form.querySelector('input[name="token"]');
        const actionMatches = form.action.includes("widgetdefault") || form.action.includes("hosteds");
        const textBlock = (form.innerText || "").toLowerCase();
        return !!tokenInput && (actionMatches || /continue|continuar|click on the continue button/.test(textBlock));
      });
      const captchaSubmit = captchaTokenForm?.querySelector("button, input[type='submit']") as HTMLElement | null;
      const explicitContinue = captchaContinueBtn ?? captchaSubmit;
      if (explicitContinue && visible(explicitContinue)) {
        const direct = tryClick(explicitContinue, "captcha:token-form");
        if (direct) return direct;
      }

      const hiddenTokenForm = Array.from(document.forms).find((form) => {
        const tokenInput = form.querySelector('input[name="token"]');
        if (!tokenInput) return false;
        const action = (form.getAttribute("action") ?? "").toLowerCase();
        const text = (form.innerText || "").toLowerCase();
        return action.includes("widgetdefault") || action.includes("hosteds") || /continue|continuar|click on the continue button/.test(text);
      });
      if (hiddenTokenForm) {
        const submitTarget = hiddenTokenForm.querySelector("button, input[type='submit'], input[type='button']") as HTMLElement | null;
        const tokenInput = hiddenTokenForm.querySelector('input[name="token"]') as HTMLInputElement | null;
        if (tokenInput && tokenInput.value) {
          const formAction = hiddenTokenForm.getAttribute("action") || window.location.href;
          const finalAction = formAction.startsWith("http") ? formAction : new URL(formAction, window.location.href).href;
          const formData = new FormData(hiddenTokenForm);
          const payload = new URLSearchParams();
          for (const [key, value] of formData.entries()) {
            if (typeof value === "string") payload.append(key, value);
          }
          const htmlSnippet = (hiddenTokenForm as HTMLFormElement).outerHTML.slice(0, 220);
          fetch(finalAction, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: payload.toString(),
            credentials: "include",
            redirect: "manual",
          }).catch(() => {});
          return { clicked: true, reason: "token-form:submit", htmlSnippet };
        }
        if (submitTarget && visible(submitTarget)) {
          const direct = tryClick(submitTarget, "token-form:submit-button");
          if (direct) return direct;
        }
      }

      const candidates = [
        document.getElementById("idDivBktCustomContinueButton"),
        document.getElementById("idDivBktButtonContinueContainer"),
        document.getElementById("idDivBktServicesContinueButton"),
        document.getElementById("idBktDefaultCustomContainer"),
      ];

      for (const candidate of candidates) {
        const reason = candidate?.id ?? "container";
        const direct = tryClick(candidate, `container:${reason}`);
        if (direct) return direct;
      }

      const buttons = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit'], div[role='button']"));
      for (const el of buttons) {
        const txt = textOf(el);
        if (!visible(el)) continue;
        if (/aceptar|accept|continuar|continue|siguiente|ok/i.test(txt)) {
          const direct = tryClick(el, `text:${txt.slice(0, 40)}`);
          if (direct) return direct;
        }
      }

      const fallback = Array.from(document.querySelectorAll("#idBktDefaultCustomContainer button, #idBktDefaultCustomContainer a, #idBktDefaultCustomContainer input"));
      for (const el of fallback) {
        if (!visible(el)) continue;
        const direct = tryClick(el, "fallback-container");
        if (direct) return direct;
      }

      return { clicked: false, reason: "no_visible_accept_button", htmlSnippet: (document.body?.innerHTML ?? "").slice(0, 220) };
    });

    return {
      clicked: Boolean((result as any)?.clicked),
      reason: String((result as any)?.reason ?? "unknown"),
      htmlSnippet: String((result as any)?.htmlSnippet ?? ""),
    };
  } catch (err) {
    return {
      clicked: false,
      reason: `evaluate_error:${String(err).slice(0, 80)}`,
      htmlSnippet: "",
    };
  }
}

export async function navigateToSelecttime(
  date: string,
  time: string,
  agendaId: string,
  portalUrl: string,
): Promise<string> {
  const page = spainPersistentBrowser.getActivePage();
  if (!page) {
    console.warn("[spain-pb] ⚠️ navigateToSelecttime — page non disponible");
    return "";
  }

  const hashTarget = `#selecttime/${encodeURIComponent(date)}/${encodeURIComponent(time)}${agendaId ? "/" + encodeURIComponent(agendaId) : ""}`;
  console.log(`[spain-pb] 🔀 navigateToSelecttime → ${hashTarget}`);

  // ── 1. CDP listener — attrape TOUT : XHR, fetch, script JSONP ────────────────
  let cdp: any = null;
  const cdpCaptured: string[] = [];
  try {
    cdp = await page.createCDPSession();
    await cdp.send("Network.enable", {});
    cdp.on("Network.requestWillBeSent", (ev: any) => {
      const url: string = ev.request?.url ?? "";
      if (url.includes("onlinebookings") || url.includes("citaconsular.es/es/")) {
        const entry = `[${(ev.resourceType ?? ev.type ?? "?").slice(0, 8)}] ${ev.request.method} ${url}`;
        cdpCaptured.push(entry);
        console.log(`[spain-pb] 🕵️ CDP: ${entry.slice(0, 200)}`);
      }
    });
  } catch (cdpErr) {
    console.warn(`[spain-pb] ⚠️ CDP session échouée (fallback JS patch seulement): ${cdpErr}`);
  }

  try {
    // ── 2. Patch JS — reset propre puis intercepte XHR + fetch + createElement(script) ──
    // IMPORTANT : réinitialiser __bkt_intercepted SANS || [] pour ne pas mélanger
    // les appels d'une invocation précédente.
    await page.evaluate(`
      window.__bkt_intercepted = [];
      if (!window.__bkt_patched) {
        window.__bkt_patched = true;
        (function() {
          var origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string' && url.includes('onlinebookings')) {
              window.__bkt_intercepted.push('XHR ' + method + ' ' + url);
            }
            return origOpen.apply(this, arguments);
          };
          var origFetch = window.fetch;
          window.fetch = function(input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('onlinebookings')) {
              window.__bkt_intercepted.push('FETCH ' + (init && init.method || 'GET') + ' ' + url);
            }
            return origFetch.apply(this, arguments);
          };
          // JSONP script tag injection — le vrai mécanisme Bookitit
          var origCreate = document.createElement.bind(document);
          document.createElement = function(tag, opts) {
            var el = origCreate(tag, opts);
            if (typeof tag === 'string' && tag.toLowerCase() === 'script') {
              var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
              if (srcDesc && srcDesc.set) {
                Object.defineProperty(el, 'src', {
                  configurable: true,
                  enumerable: true,
                  set: function(v) {
                    if (typeof v === 'string' && v.includes('onlinebookings')) {
                      window.__bkt_intercepted.push('JSONP GET ' + v);
                    }
                    srcDesc.set.call(this, v);
                  },
                  get: function() {
                    return srcDesc.get ? srcDesc.get.call(this) : '';
                  }
                });
              }
            }
            return el;
          };
        })();
      }
    `) as unknown;

    // ── 3. Tentative de clic DOM réel sur le créneau ───────────────────────────
    // Si le widget affiche déjà la grille de créneaux pour la bonne date, on
    // clique l'élément directement — la click-handler Backbone fera les appels
    // HTTP naturellement (AVANT de changer le hash).
    const timeFormatted = time; // ex: "09:00"
    const clickResult = (await page.evaluate(`
      (function(targetTime, targetDate, targetAgenda) {
        // Sélecteurs connus du widget Bookitit pour les créneaux horaires
        var selectors = [
          'a[href*="selecttime/' + targetDate + '/' + encodeURIComponent(targetTime) + '"]',
          'a[href*="selecttime"][href*="' + targetTime.replace(':', '%3A') + '"]',
          'a[href*="selecttime"][href*="' + targetTime + '"]',
          '.clsBktTimeSlotsItem a',
          '.clsBktAvailableTime a',
          '[data-time="' + targetTime + '"]',
          '.bkt-time-slot a',
          'li.clsBktSlot a',
        ];
        for (var i = 0; i < selectors.length; i++) {
          var els = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < els.length; j++) {
            var el = els[j];
            var txt = (el.textContent || '').trim();
            var href = el.getAttribute('href') || '';
            if (txt.includes(targetTime) || href.includes(encodeURIComponent(targetTime)) || href.includes(targetTime)) {
              if (el.offsetParent !== null) {
                el.click();
                return 'clicked:' + el.tagName + '[' + href.slice(0, 80) + '] text=' + txt.slice(0, 20);
              }
            }
          }
        }
        // Fallback: chercher n'importe quel lien selecttime contenant l'heure
        var allLinks = document.querySelectorAll('a[href*="selecttime"]');
        for (var k = 0; k < allLinks.length; k++) {
          var l = allLinks[k];
          var lhref = l.getAttribute('href') || '';
          if (lhref.includes(encodeURIComponent(targetTime)) || lhref.includes(targetTime)) {
            if (l.offsetParent !== null) {
              l.click();
              return 'clicked_fallback:' + lhref.slice(0, 80);
            }
          }
        }
        return 'no_element_visible';
      })(${JSON.stringify(timeFormatted)}, ${JSON.stringify(date)}, ${JSON.stringify(agendaId)})
    `)) as string;
    console.log(`[spain-pb] 🖱️ Clic DOM selecttime: ${clickResult}`);

    const domClickSucceeded = clickResult.startsWith("clicked");

    if (!domClickSucceeded) {
      // ── 4. Fallback : changer le hash directement ──────────────────────────
      console.log(`[spain-pb] ↩️  Fallback hash direct → ${hashTarget}`);
      await page.evaluate(`window.location.hash = ${JSON.stringify(hashTarget)}`) as unknown;
    }

    // ── 5. Attendre que le router Backbone résolve vers la vue auth (max 5s) ──
    const resolved = await (async () => {
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const hash = (await page.evaluate(`window.location.hash`)) as string;
        if (
          hash.includes("signin") ||
          hash.includes("signup") ||
          hash.includes("signupsecond") ||
          hash.includes("signupfirst")
        ) {
          return hash;
        }
      }
      return "";
    })();

    // ── 6. Laisser les appels async se terminer + rapport ─────────────────────
    await new Promise((r) => setTimeout(r, 800));

    if (cdpCaptured.length > 0) {
      console.log(`[spain-pb] 🔍 CDP selecttime → ${cdpCaptured.length} requête(s) réseau capturée(s) :`);
      for (const u of cdpCaptured) console.log(`[spain-pb]    ${u.slice(0, 220)}`);
    } else {
      console.log(`[spain-pb] 🔍 CDP selecttime → 0 requêtes réseau détectées (pure routing client ?)`);
    }

    try {
      const jsCaptured = (await page.evaluate(`window.__bkt_intercepted || []`)) as string[];
      if (jsCaptured.length > 0) {
        console.log(`[spain-pb] 🔍 JS patch selecttime → ${jsCaptured.length} appel(s) :`);
        for (const c of jsCaptured) console.log(`[spain-pb]    ${c.slice(0, 220)}`);
      } else {
        console.log(`[spain-pb] 🔍 JS patch selecttime → 0 appels (XHR/fetch/JSONP) interceptés`);
      }
    } catch { /* ignore */ }

    if (resolved) {
      console.log(`[spain-pb] ✅ selecttime résolu → ${resolved}`);
    } else {
      console.warn(`[spain-pb] ⚠️ selecttime — hash non résolu après 5s (router lent ou widget pas chargé ?)`);
    }
    return resolved;
  } catch (err) {
    console.warn(`[spain-pb] ⚠️ navigateToSelecttime exception: ${err}`);
    return "";
  } finally {
    if (cdp) {
      try { await cdp.detach(); } catch { /* ignore */ }
    }
  }
}

export async function callBookititEndpointViaBrowser(url: string): Promise<string> {
  // ── Cache-first : réponse déjà capturée pendant le solve (state PHP encore chaud) ──
  const endpoint = url.match(/\/onlinebookings\/([^?]+)/)?.[1] ?? url.slice(0, 60);
  // datetime/ cache is keyed by month ("datetime/YYYY-MM") to avoid juillet/août collision
  let cacheKey = endpoint;
  if (endpoint === "datetime/") {
    try {
      const startParam = new URLSearchParams(new URL(url).search).get("start") ?? "";
      const month = startParam.slice(0, 7); // "YYYY-MM"
      if (month) cacheKey = `datetime/${month}`;
    } catch { /* keep cacheKey = "datetime/" */ }
  }
  const cached = spainPersistentBrowser.getApiPrefetchCached(cacheKey);
  if (cached !== undefined) {
    console.log(`[spain-pb] 📋 callBrowser ${cacheKey} → cache (${cached.length}B)`);
    return cached;
  }

  let page = spainPersistentBrowser.getActivePage();
  if (!page) {
    console.log("[spain-pb] 🔄 callBookititEndpointViaBrowser — page absente, initialisation de la session persistante…");
    const ensured = await ensureSpainPersistentBrowserSession();
    if (!ensured) {
      console.warn("[spain-pb] ⚠️ callBookititEndpointViaBrowser — session browser introuvable après initialisation");
      return "";
    }
    page = spainPersistentBrowser.getActivePage();
  }
  if (!page) {
    console.warn("[spain-pb] ⚠️ callBookititEndpointViaBrowser — _page null (browser non lancé ou fermé)");
    return "";
  }
  // Logguer l'URL courante de la page pour détecter une navigation inattendue
  const pageUrl = page.url().slice(0, 80);
  console.log(`[spain-pb] 🌐 callBrowser → ${endpoint} (page: ${pageUrl})`);
  try {
    const result: { status: number; bodyLen: number; body: string } = await page.evaluate(
      async (u: string) => {
        try {
          const resp = await fetch(u, {
            method: "GET",
            credentials: "include",
            headers: {
              "Accept": "text/javascript, application/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
            },
          });
          const body = await resp.text();
          return { status: resp.status, bodyLen: body.length, body: resp.ok ? body : `__ERR_STATUS_${resp.status}` };
        } catch (e: unknown) {
          return { status: 0, bodyLen: 0, body: `__ERR_FETCH_${String(e).slice(0, 120)}` };
        }
      },
      url,
    );
    console.log(`[spain-pb] 📡 callBrowser ${endpoint} → HTTP ${result.status} | ${result.bodyLen}B`);
    if (result.body.startsWith("__ERR_")) {
      console.warn(`[spain-pb] ⚠️ callBookititEndpointViaBrowser échoué: ${result.body.slice(0, 140)}`);
      return "";
    }
    return result.body;
  } catch (err) {
    console.warn(`[spain-pb] ⚠️ callBookititEndpointViaBrowser exception: ${err}`);
    return "";
  }
}

/**
 * Soumet le formulaire signin/ en manipulant directement le DOM du widget Bookitit.
 *
 * Pourquoi cette approche ?
 *   fetch() et jQuery script tag retournent 0B pour signin/ et getsigninfields/.
 *   Ces endpoints PHP vérifient une variable de session qui n'est définie QUE quand
 *   le widget Backbone fait lui-même l'appel via son propre $.ajax() — pas via nos
 *   fetch() extérieurs. En remplissant le formulaire DOM et en cliquant Submit,
 *   c'est le widget qui émet l'appel signin/ → le serveur PHP l'accepte.
 *
 * Pré-condition : navigateToSelecttime() a déjà été appelé et le hash est sur
 *   #signupsecondappointment ou #signin (formulaire visible dans le DOM).
 *
 * Retourne le body JSONP de la réponse signin/ (string brute) ou "" si échec.
 */
/**
 * Mutex de booking browser : sérialise TOUT le flow executeHttpBooking quand
 * useBrowserCalls=true (session playwright).
 *
 * La page Chrome est un singleton partagé. Quand N dossiers bookent en
 * Promise.all, TOUS les appels browser (getagendas/, datetime/, signin/,
 * summary/) utilisent la même page. Sans ce verrou, deux dossiers concurrents
 * provoquent "detached Frame" / "TargetCloseError" dès le premier appel.
 *
 * Le _domSigninMutex ci-dessous reste en place pour les cas où un seul dossier
 * est en vol (protection interne) mais ce verrou de niveau supérieur couvre
 * l'intégralité du booking.
 */
let _browserBookingMutex: Promise<void> = Promise.resolve();

/**
 * Acquiert le verrou de booking browser.
 * Retourne une fonction release() à appeler dans finally{}.
 */
export async function acquireBrowserBookingLock(): Promise<() => void> {
  const prev = _browserBookingMutex;
  let release!: () => void;
  _browserBookingMutex = new Promise<void>((r) => { release = r; });
  console.log("[spain-pb] 🔐 Browser booking lock — attente verrou…");
  await prev;
  console.log("[spain-pb] 🔓 Browser booking lock — verrou acquis");
  return release;
}

/**
 * Mutex de la page DOM : sérialise les appels submitSigninFormViaDOM.
 *
 * Tous les dossiers bookent en parallèle (Promise.all dans le watcher), mais
 * submitSigninFormViaDOM touche la MÊME page Chromium (remplissage de champs,
 * click submit, waitForResponse). Sans mutex, deux dossiers concurrents
 * écrasent mutuellement leurs champs et reçoivent la mauvaise réponse.
 *
 * Pattern : chaîne de promesses. Chaque appelant attend que le précédent
 * ait libéré le verrou (resolve dans le finally) avant de démarrer.
 */
let _domSigninMutex: Promise<void> = Promise.resolve();

export async function submitSigninFormViaDOM(
  login: string,
  password: string,
): Promise<{ signinBody: string; summaryBody: string }> {
  // Acquérir le mutex — attendre que le dossier précédent ait fini
  const prevLock = _domSigninMutex;
  let releaseMutex!: () => void;
  _domSigninMutex = new Promise<void>((resolve) => { releaseMutex = resolve; });
  await prevLock;

  const page = spainPersistentBrowser.getActivePage();
  if (!page) {
    console.warn("[spain-pb] ⚠️ submitSigninFormViaDOM — page non disponible");
    releaseMutex();
    return { signinBody: "", summaryBody: "" };
  }

  // ── 1. Diagnostic DOM : voir ce que Backbone a rendu ────────────────────────
  const domDiag = (await page.evaluate(`
    (function() {
      var hash = window.location.hash;
      // Tous les éléments interactifs visibles (input, button, a, div cliquables)
      var all = Array.from(document.querySelectorAll('input, button, a, [onclick], [class*="Button"], [class*="button"], [class*="Submit"], [class*="submit"], [id*="Button"], [id*="button"], [id*="Submit"], [id*="submit"]'));
      var visible = all.filter(function(el) { return el.offsetParent !== null; });
      // HTML du container principal du formulaire
      var formContainer = document.querySelector('#idBktWidgetDefaultBodyContainer, #idBktDefaultCustomContainer, .clsBktSigninContainer, form');
      return JSON.stringify({
        hash: hash,
        visibleElements: visible.slice(0, 20).map(function(el) {
          return { tag: el.tagName, type: el.type || '', id: el.id || '', name: el.name || '', cls: el.className.slice(0, 60), txt: (el.textContent || '').trim().slice(0, 40) };
        }),
        formHtml: formContainer ? formContainer.innerHTML.slice(0, 800) : 'no-form-container',
        bodySnippet: (document.body.innerText || '').slice(0, 300).replace(/\\n/g, ' '),
      });
    })()
  `).catch(() => "{}")) as string;
  console.log(`[spain-pb] 🔍 DOM signin form: ${domDiag.slice(0, 1200)}`);

  // ── 2. Préparer la capture de signin/ ET summary/ via page.waitForResponse ────
  // IMPORTANT : créer les promesses AVANT le clic pour ne pas rater les réponses.
  // Après un signin réussi, le widget Backbone fire summary/ automatiquement —
  // on l'intercepte ici plutôt que de le rappeler manuellement (évite le 0B).
  let signinBody = "";
  const signinResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes("onlinebookings/signin"),
    { timeout: 20_000 },
  ).then(async (resp) => {
    const body = await resp.text();
    console.log(`[spain-pb] 📦 signin/ response via waitForResponse: ${body.length}B`);
    return body;
  }).catch((err) => {
    console.warn(`[spain-pb] ⚠️ waitForResponse signin/ échoué/timeout: ${err}`);
    return "";
  });

  // summary/ est émis automatiquement par le widget Backbone après signin réussi.
  // Timeout 35s : le serveur peut être lent sous charge (calcul côté Bookitit).
  const summaryResponsePromise = page.waitForResponse(
    (resp) => resp.url().includes("onlinebookings/summary"),
    { timeout: 35_000 },
  ).then(async (resp) => {
    const body = await resp.text();
    console.log(`[spain-pb] 📦 summary/ response via waitForResponse: ${body.length}B`);
    return body;
  }).catch((err) => {
    // Non-fatal : si signin échoue (mauvais credentials), summary/ n'est jamais émis.
    console.log(`[spain-pb] ℹ️ waitForResponse summary/ non reçu (normal si signin échoué): ${err}`);
    return "";
  });

  try {
    // ── 3. Remplir les champs et soumettre ────────────────────────────────────
    const fillResult = (await page.evaluate(`
      (function(login, password) {
        // Sélecteurs connus du widget Bookitit (signupfirstappointment / signupsecondappointment)
        // Hiérarchie : id précis → name → type input text/password → premier visible
        function findField(selectors) {
          for (var i = 0; i < selectors.length; i++) {
            var els = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < els.length; j++) {
              if (els[j].offsetParent !== null) return els[j];
            }
          }
          return null;
        }
        var loginField = findField([
          '#idBktSigninLogin', '#idBktLogin', '[name="login"]', '[id*="Login"]',
          '[id*="login"]', 'input[type="text"]', 'input:not([type="password"]):not([type="hidden"])',
        ]);
        var passField = findField([
          '#idBktSigninPassword', '#idBktPassword', '[name="password"]', '[id*="Password"]',
          '[id*="password"]', 'input[type="password"]',
        ]);
        var submitBtn = findField([
          // IDs Bookitit confirmés par dump DOM live 2026-07-30 (Saopola)
          '#idBktDefaultSignInConfirmButton',
          '#idBktSignInsubmit', '#idBktSigninButton', '#idBktSignInButton',
          '#idDivBktSignInsubmit', '#idDivBktSigninButton',
          // Classes confirmées : clsDivContinueButton (Bookitit signup second appointment)
          '.clsDivContinueButton', '.clsBktSigninSubmit', '.clsBktSignInSubmit', '.clsBktSubmitButton',
          // IDs partiels (Confirm, Submit, Button)
          '[id*="ConfirmButton"]', '[id*="Confirm"]',
          '[id*="SigninButton"]', '[id*="SignInButton"]', '[id*="SigninSubmit"]', '[id*="SignInsubmit"]',
          '[id*="Submit"]', '[id*="submit"]',
          // Éléments standard
          'button[type="submit"]', 'input[type="submit"]',
          // Liens et divs cliquables Bookitit (<a> et <div> fréquents pour les CTA)
          'a.clsBktButton', 'a.clsBkt', 'a[class*="Button"]', 'a[class*="button"]',
          'a[class*="Submit"]', 'a[class*="submit"]',
          '.clsBktButton', '.clsBkt', 'button.clsBkt',
          // Fallback large
          'button', 'a[href="#"]',
        ]);

        if (!loginField) return 'no_login_field';
        if (!passField) return 'no_password_field';

        // Setters natifs React/Backbone pour déclencher les event handlers
        var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') && Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        function setNativeValue(el, val) {
          if (nativeInputValueSetter) nativeInputValueSetter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        setNativeValue(loginField, login);
        setNativeValue(passField, password);

        var loginId = loginField.id || loginField.name || loginField.type;
        var passId = passField.id || passField.name || passField.type;

        if (!submitBtn) return 'no_submit_btn (login=' + loginId + ', pass=' + passId + ')';

        submitBtn.click();
        return 'submitted: login=' + loginId + ' pass=' + passId + ' btn=' + (submitBtn.id || submitBtn.className.slice(0,30));
      })(${JSON.stringify(login)}, ${JSON.stringify(password)})
    `)) as string;

    console.log(`[spain-pb] 🖱️ submitSigninFormViaDOM: ${fillResult}`);

    if (!fillResult.startsWith("submitted")) {
      console.warn(`[spain-pb] ⚠️ Formulaire non soumis: ${fillResult}`);
      return { signinBody: "", summaryBody: "" };
    }

    // ── 4. Attendre signin/ puis summary/ ────────────────────────────────────
    signinBody = await signinResponsePromise;

    if (!signinBody) {
      console.warn("[spain-pb] ⚠️ submitSigninFormViaDOM — pas de réponse signin/ après 20s");
      return { signinBody: "", summaryBody: "" };
    }

    // Si signin a réussi (bktToken présent), attendre summary/ automatique du widget.
    // Si signin a échoué (erreurs credentials), summary/ ne sera jamais émis → summaryBody="".
    const summaryBody = await summaryResponsePromise;
    if (summaryBody) {
      console.log(`[spain-pb] ✅ summary/ capturé automatiquement via widget Backbone (${summaryBody.length}B)`);
    }

    return { signinBody, summaryBody };

  } catch (err) {
    console.warn(`[spain-pb] ⚠️ submitSigninFormViaDOM exception: ${err}`);
    return { signinBody: "", summaryBody: "" };
  }
}
