/**
 * spain-2captcha-browser.ts — Intégration 2Captcha Browser API pour VisaFlow
 *
 * ARCHITECTURE :
 *   Au lieu de lancer un Chromium local (puppeteer.launch) et de lutter contre
 *   les détections headless/fingerprint/TLS, ce module se connecte à un navigateur
 *   cloud 2Captcha via CDP WebSocket. Le navigateur 2Captcha :
 *     - Tourne sur une infrastructure cloud avec fingerprint réel
 *     - Gère automatiquement les challenges CF via l'interface CDP `Captcha`
 *     - Supporte les proxies custom (Decodo, SOAX, etc.) via le CDP URL
 *     - Résout Turnstile, JSD, Managed Challenge, IUAM nativement
 *
 * FLUX :
 *   1. Obtenir connectionUri via POST /browser/connection (ou construction manuelle)
 *   2. Se connecter via puppeteer.connect({ browserWSEndpoint: cdpUrl })
 *   3. Activer Captcha.setAutoSolve ou Captcha.solve pour les challenges CF
 *   4. Naviguer vers citaconsular.es → CF challenge résolu automatiquement
 *   5. Extraire cf_clearance + PHPSESSID + tous les cookies
 *   6. Construire SpainCfSession compatible avec le scanner HTTP existant
 *
 * VARIABLES D'ENVIRONNEMENT :
 *   TWOCAPTCHA_API_KEY       — Clé API 2Captcha (obligatoire)
 *   TWOCAPTCHA_BROWSER_LOGIN — Login du browser account (optionnel si ACCOUNT_ID)
 *   TWOCAPTCHA_BROWSER_PASS  — Password du browser account
 *   TWOCAPTCHA_ACCOUNT_ID    — ID du browser account (pour /browser/connection)
 *   TWOCAPTCHA_PROFILE_ID    — ID du profil (optionnel, utilise Default sinon)
 *   TWOCAPTCHA_COUNTRY       — Code pays (défaut: "es" pour l'Espagne)
 *   TWOCAPTCHA_CDP_URL       — CDP URL complète (bypass la construction automatique)
 *
 * UTILISATION :
 *   // Mode 1: Via ensureSpainCfSession (SPAIN_SESSION_MODE=2captcha-browser)
 *   // → Intégré automatiquement dans spain-soax-solver.ts
 *
 *   // Mode 2: Direct
 *   import { solve2CaptchaBrowserSession } from "./spain-2captcha-browser.js";
 *   const result = await solve2CaptchaBrowserSession("https://www.citaconsular.es/...");
 *   if (result.success) console.log("cf_clearance:", result.session.cfClearance);
 */

import puppeteer from "puppeteer";
import type { Browser, Page, CDPSession } from "puppeteer";
import type { SpainCfSession } from "./spain-soax-solver.js";
import { getCurrentDecodoUrl } from "./spain-decodo-pool.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const LOG = "[2captcha-browser]";
const TWOCAPTCHA_API_BASE = "https://api.2captcha.com";
const TWOCAPTCHA_CDP_HOST = "cb.2captcha.com";
const TWOCAPTCHA_CDP_PORT = 9222;

/** Timeout navigation page (ms) */
const NAV_TIMEOUT_MS = 90_000;
/** Timeout résolution CAPTCHA (ms) */
const CAPTCHA_SOLVE_TIMEOUT_MS = 120_000;
/** Timeout connexion WebSocket (ms) */
const WS_CONNECT_TIMEOUT_MS = 30_000;
/** Délai avant de lancer Captcha.solve pour laisser le widget se charger */
const CAPTCHA_DETECT_DELAY_MS = 5_000;
/** detectTimeout pour Captcha.solve (ms) — temps alloué pour détecter le captcha */
const CAPTCHA_DETECT_TIMEOUT_MS = 15_000;
/** TTL du cf_clearance (ms) — marge de 5min sur les ~2h réelles */
const CF_CLEARANCE_TTL_MS = 115 * 60_000;
/** Max session duration sur 2Captcha Browser API */
const MAX_SESSION_DURATION_MS = 28 * 60_000; // 28min (marge sur les 30min max)

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface TwoCaptchaBrowserConfig {
  /** Clé API 2Captcha */
  apiKey: string;
  /** ID du browser account */
  accountId?: number;
  /** Login du browser account (alternatif à accountId) */
  browserLogin?: string;
  /** Password du browser account */
  browserPassword?: string;
  /** ID du profil */
  profileId?: string;
  /** Code pays (défaut: "es") */
  country?: string;
  /** CDP URL complète (bypass construction) */
  cdpUrl?: string;
  /** Activer le flag -clickcaptcha (défaut: true) */
  enableClickCaptcha?: boolean;
  /**
   * ID du proxy account 2Captcha résidentiel (proxyMode: "our_proxy").
   * Indispensable pour citaconsular.es — les IPs datacenter (Decodo/SOAX)
   * sont blacklistées par CF et reçoivent un JS challenge impossible.
   * Le proxy résidentiel 2Captcha obtient un Turnstile que le solver résout.
   */
  proxyAccountId?: number;
  /** Proxy custom à passer dans la connexion (datacenter — fallback uniquement) */
  customProxy?: {
    type: "http" | "https" | "socks5";
    host: string;
    port: number;
    login?: string;
    password?: string;
  };
}

export interface TwoCaptchaSolveResult {
  success: boolean;
  session?: SpainCfSession;
  error?: string;
  durationMs: number;
  /** Méthode de résolution utilisée */
  solvedBy?: "auto_solve" | "manual_solve" | "no_captcha";
}

// ─── Configuration Loader ───────────────────────────────────────────────────

/**
 * Charge la configuration 2Captcha depuis les variables d'environnement.
 */
export function load2CaptchaConfig(): TwoCaptchaBrowserConfig | null {
  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!apiKey) {
    console.warn(`${LOG} ⚠️ TWOCAPTCHA_API_KEY non définie — module désactivé`);
    return null;
  }

  const config: TwoCaptchaBrowserConfig = {
    apiKey,
    accountId: process.env.TWOCAPTCHA_ACCOUNT_ID
      ? parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID, 10)
      : undefined,
    browserLogin: process.env.TWOCAPTCHA_BROWSER_LOGIN?.trim(),
    browserPassword: process.env.TWOCAPTCHA_BROWSER_PASS?.trim(),
    profileId: process.env.TWOCAPTCHA_PROFILE_ID?.trim(),
    country: process.env.TWOCAPTCHA_COUNTRY?.trim() || "es",
    cdpUrl: process.env.TWOCAPTCHA_CDP_URL?.trim(),
    proxyAccountId: process.env.TWOCAPTCHA_PROXY_ACCOUNT_ID
      ? parseInt(process.env.TWOCAPTCHA_PROXY_ACCOUNT_ID, 10)
      : undefined,
  };

  // NOTE : On ne charge PAS le proxy datacenter Decodo/SOAX automatiquement.
  // Les IPs datacenter sont blacklistées par CF sur citaconsular.es — le challenge
  // JS ne se résout jamais. On utilise le proxy résidentiel 2Captcha (our_proxy)
  // qui est configuré au niveau du profil via l'API /browser/profiles.
  // Le proxy datacenter peut être forcé via TWOCAPTCHA_CUSTOM_PROXY_URL si nécessaire.
  const customProxyUrl = process.env.TWOCAPTCHA_CUSTOM_PROXY_URL?.trim();
  if (customProxyUrl) {
    try {
      const parsed = new URL(customProxyUrl.startsWith("http") ? customProxyUrl : `http://${customProxyUrl}`);
      config.customProxy = {
        type: (parsed.protocol.replace(":", "") as "http" | "https" | "socks5") || "http",
        host: parsed.hostname,
        port: parseInt(parsed.port, 10) || 80,
        login: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      };
    } catch (e) {
      console.warn(`${LOG} ⚠️ TWOCAPTCHA_CUSTOM_PROXY_URL invalide, ignorée: ${customProxyUrl}`);
    }
  }

  return config;
}

// ─── CDP URL Builder ────────────────────────────────────────────────────────

/**
 * Obtient la CDP URL via l'API /browser/connection.
 * Méthode recommandée par 2Captcha — le serveur construit l'URL correctement.
 */
async function getConnectionUriFromApi(config: TwoCaptchaBrowserConfig): Promise<string> {
  if (!config.accountId) {
    throw new Error(`${LOG} accountId requis pour /browser/connection`);
  }

  // ── Créer un profil dédié avec proxy résidentiel 2Captcha ────────────
  // Les IPs datacenter (Decodo/SOAX) sont blacklistées par CF sur citaconsular.es.
  // Le proxy résidentiel 2Captcha (our_proxy) reçoit un Turnstile que le solver résout.
  let profileId = config.profileId;
  if (!profileId && config.proxyAccountId) {
    profileId = `vf_${Date.now()}_${generateRandomId(6)}`;
    console.log(`${LOG} 📋 Création profil ${profileId} avec proxy résidentiel 2Captcha (id=${config.proxyAccountId})…`);
    const profileRes = await fetch(`${TWOCAPTCHA_API_BASE}/browser/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: config.apiKey,
        accountId: config.accountId,
        profileId,
        name: `VisaFlow CF ${new Date().toISOString().slice(0, 16)}`,
        proxyMode: "our_proxy",
        proxyAccountId: config.proxyAccountId,
        country: config.country || "es",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const profileData = await profileRes.json() as Record<string, unknown>;
    if (profileData.status !== "OK") {
      console.warn(`${LOG} ⚠️ Création profil échouée: ${profileData.errorCode ?? profileData.error} — fallback profil par défaut`);
      profileId = undefined;
    } else {
      console.log(`${LOG} ✅ Profil créé avec proxy résidentiel (country=${config.country || "es"})`);
    }
  }

  const body: Record<string, unknown> = {
    key: config.apiKey,
    accountId: config.accountId,
  };
  if (profileId) body.profileId = profileId;
  if (config.customProxy) body.customProxy = config.customProxy;

  console.log(`${LOG} 📡 Requête POST /browser/connection (accountId=${config.accountId}, profile=${profileId || "default"})…`);

  const res = await fetch(`${TWOCAPTCHA_API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json() as Record<string, unknown>;
  if (data.status !== "OK" || !data.connectionUri) {
    throw new Error(
      `${LOG} /browser/connection erreur: ${data.errorCode ?? data.error ?? JSON.stringify(data)}`,
    );
  }

  const uri = data.connectionUri as string;
  console.log(`${LOG} ✅ connectionUri obtenue (${uri.length} chars)`);
  return uri;
}

/**
 * Construit manuellement la CDP URL à partir des credentials.
 * Utilisé quand on a directement login/password sans passer par l'API.
 */
function buildCdpUrlManually(config: TwoCaptchaBrowserConfig): string {
  if (!config.browserLogin || !config.browserPassword) {
    throw new Error(`${LOG} browserLogin et browserPassword requis pour construction manuelle`);
  }

  const country = config.country || "es";
  const profileId = config.profileId || `profile_${generateRandomId(16)}`;

  let username = `${config.browserLogin}-zone-scraping_browser-country-${country}-pid-${profileId}`;

  // Ajouter -clickcaptcha pour la résolution Turnstile interactif
  if (config.enableClickCaptcha !== false) {
    username += "-clickcaptcha";
  }

  // Ajouter le proxy custom en base64url si présent
  if (config.customProxy) {
    const proxyString = buildProxyString(config.customProxy);
    const encoded = Buffer.from(proxyString).toString("base64url");
    username += `-proxy-${encoded}`;
  }

  const cdpUrl = `ws://${username}:${config.browserPassword}@${TWOCAPTCHA_CDP_HOST}:${TWOCAPTCHA_CDP_PORT}`;
  console.log(`${LOG} 🔧 CDP URL construite manuellement (profil: ${profileId})`);
  return cdpUrl;
}

/**
 * Résout la CDP URL à utiliser, par ordre de priorité :
 * 1. TWOCAPTCHA_CDP_URL (env var directe)
 * 2. API /browser/connection (si accountId disponible)
 * 3. Construction manuelle (si login/password disponibles)
 */
async function resolveCdpUrl(config: TwoCaptchaBrowserConfig): Promise<string> {
  // 1. CDP URL directe
  if (config.cdpUrl) {
    console.log(`${LOG} 🔗 CDP URL directe (env TWOCAPTCHA_CDP_URL)`);
    return config.cdpUrl;
  }

  // 2. Via API /browser/connection
  if (config.accountId) {
    return getConnectionUriFromApi(config);
  }

  // 3. Construction manuelle
  if (config.browserLogin && config.browserPassword) {
    return buildCdpUrlManually(config);
  }

  throw new Error(
    `${LOG} Configuration insuffisante — fournir TWOCAPTCHA_CDP_URL, ` +
    `ou TWOCAPTCHA_ACCOUNT_ID, ou TWOCAPTCHA_BROWSER_LOGIN + TWOCAPTCHA_BROWSER_PASS`,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateRandomId(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => chars[b % 36]).join("");
}

function buildProxyString(proxy: NonNullable<TwoCaptchaBrowserConfig["customProxy"]>): string {
  const auth = proxy.login && proxy.password ? `${proxy.login}:${proxy.password}@` : "";
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function maskCdpUrl(url: string): string {
  return url.replace(/:([^:@]{3})[^:@]*@/, ":$1***@");
}

/**
 * Injecte le flag -clickcaptcha dans une CDP URL 2Captcha.
 * Ce flag active la résolution de captchas par clic (reCAPTCHA, Turnstile interactif).
 * Position dans le username: après -pid-{profileId}, avant -proxy-{encoded} ou :password.
 */
function injectClickCaptchaFlag(cdpUrl: string): string {
  // Si déjà présent, ne rien faire
  if (cdpUrl.includes("-clickcaptcha")) return cdpUrl;

  // Pattern: ...-pid-{profileId}[-proxy-{encoded}]:password@host
  // Injecter -clickcaptcha après -pid-{profileId}
  const injected = cdpUrl.replace(
    /(-pid-[^-:]+)(-proxy-|-nocaptcha|:)/,
    "$1-clickcaptcha$2",
  );

  if (injected !== cdpUrl) {
    console.log(`${LOG} 🔧 Flag -clickcaptcha injecté dans CDP URL`);
  }
  return injected;
}

// ─── Core: Browser Session Solver ───────────────────────────────────────────

/**
 * Se connecte au navigateur cloud 2Captcha, navigue vers la cible,
 * résout les challenges CF automatiquement, et extrait les cookies.
 *
 * FLUX DÉTAILLÉ :
 *   1. Résoudre la CDP URL (API, env var, ou construction manuelle)
 *   2. puppeteer.connect() vers le navigateur cloud
 *   3. Créer une page + session CDP
 *   4. Configurer l'auto-solve Captcha via CDP `Captcha.setAutoSolve`
 *   5. Naviguer vers citaconsular.es
 *   6. Si challenge CF détecté → attendre résolution auto ou trigger manual
 *   7. Extraire cf_clearance + PHPSESSID + tous les cookies
 *   8. Déconnecter proprement
 */
export async function solve2CaptchaBrowserSession(
  targetUrl: string,
  configOverride?: Partial<TwoCaptchaBrowserConfig>,
): Promise<TwoCaptchaSolveResult> {
  const t0 = Date.now();
  let browser: Browser | null = null;

  try {
    // ── 1. Charger la config ──────────────────────────────────────────────
    const baseConfig = load2CaptchaConfig();
    if (!baseConfig) {
      return {
        success: false,
        error: "TWOCAPTCHA_API_KEY non définie",
        durationMs: Date.now() - t0,
      };
    }
    const config = { ...baseConfig, ...configOverride };

    // ── 2. Résoudre la CDP URL ────────────────────────────────────────────
    const cdpUrl = await resolveCdpUrl(config);
    console.log(`${LOG} 🌐 Connexion au navigateur cloud 2Captcha…`);
    console.log(`${LOG}    CDP: ${maskCdpUrl(cdpUrl)}`);

    // ── 3. Connecter Puppeteer au navigateur distant ──────────────────────
    browser = await puppeteer.connect({
      browserWSEndpoint: cdpUrl,
      defaultViewport: { width: 1920, height: 1080 },
      protocolTimeout: 300_000, // 5min pour Captcha.solve qui peut être long
    });
    console.log(`${LOG} ✅ Connecté au navigateur cloud 2Captcha`);

    // ── 4. Créer page + session CDP ──────────────────────────────────────
    const page = await browser.newPage();
    const session = await page.createCDPSession();

    // ── 5. Configurer les event listeners Captcha ─────────────────────────
    const captchaEvents: string[] = [];

    session.on("Captcha.detected", (params: any) => {
      captchaEvents.push("detected");
      console.log(`${LOG} 🔍 CAPTCHA détecté par 2Captcha — params: ${JSON.stringify(params)}`);
    });
    session.on("Captcha.waitForSolve", (params: any) => {
      captchaEvents.push("waitForSolve");
      console.log(`${LOG} ⏳ CAPTCHA envoyé au solver 2Captcha… params: ${JSON.stringify(params)}`);
    });
    session.on("Captcha.solveFinished", (params: any) => {
      captchaEvents.push("solveFinished");
      console.log(`${LOG} ✅ CAPTCHA résolu par 2Captcha ! params: ${JSON.stringify(params)}`);
    });
    session.on("Captcha.solveFailed", (params: any) => {
      captchaEvents.push("solveFailed");
      console.warn(`${LOG} ❌ Échec résolution CAPTCHA 2Captcha — params: ${JSON.stringify(params)}`);
    });
    // Catch-all pour tout événement CDP Captcha non listé
    session.on("*" as any, (...args: any[]) => { const [eventName, params] = args;
      if (typeof eventName === "string" && eventName.startsWith("Captcha.") && !["Captcha.detected","Captcha.waitForSolve","Captcha.solveFinished","Captcha.solveFailed"].includes(eventName)) {
        console.log(`${LOG} 📡 CDP event: ${eventName} — ${JSON.stringify(params)}`);
      }
    });

    // ── 6. Activer l'auto-solve Captcha ──────────────────────────────────
    console.log(`${LOG} 🤖 Activation Captcha.setAutoSolve…`);
    await session.send("Captcha.setAutoSolve" as any, {
      autoSolve: true,
      options: [{ type: "*" }],
    });

    // ── 7. Promise de résolution (auto-solve events) ─────────────────────
    const captchaSolved = new Promise<"solved" | "failed" | "timeout">((resolve) => {
      const onSolved = () => {
        cleanup();
        resolve("solved");
      };
      const onFailed = () => {
        cleanup();
        resolve("failed");
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, CAPTCHA_SOLVE_TIMEOUT_MS);

      const cleanup = () => {
        session.off("Captcha.solveFinished", onSolved);
        session.off("Captcha.solveFailed", onFailed);
        clearTimeout(timer);
      };

      session.on("Captcha.solveFinished", onSolved);
      session.on("Captcha.solveFailed", onFailed);
    });

    // ── 8. Naviguer vers la cible ────────────────────────────────────────
    // Utiliser domcontentloaded au lieu de networkidle2 : le challenge CF
    // maintient des connexions réseau actives qui empêchent networkidle2
    // de se déclencher, causant un timeout inutile.
    console.log(`${LOG} 🌍 Navigation vers ${targetUrl}…`);
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    const title = await page.title();
    console.log(`${LOG} 📄 Titre: "${title}"`);

    // ── 9. Détecter si un challenge CF est actif ─────────────────────────
    // Titres CF challenge dans toutes les langues connues
    const CF_CHALLENGE_TITLES = [
      "just a moment", "un momento", "un instant", "einen moment",
      "checking", "aguarde", "um momento", "一会儿",
    ];
    const isCfChallenge = await page.evaluate((titles: string[]) => {
      const t = document.title.toLowerCase();
      return (
        titles.some(c => t.includes(c)) ||
        !!document.querySelector(
          ".cf-challenge-running, #challenge-running, #challenge-stage, #cf-please-wait",
        ) ||
        !!document.querySelector('iframe[src*="challenges.cloudflare.com"]')
      );
    }, CF_CHALLENGE_TITLES);

    let solvedBy: TwoCaptchaSolveResult["solvedBy"] = "no_captcha";

    if (isCfChallenge) {
      console.log(`${LOG} 🛡️ Challenge CF détecté — attente résolution auto 2Captcha…`);

      // Diagnostic : capturer le type de challenge CF et le HTML
      const cfDiag = await page.evaluate(() => {
        const hasTurnstileIframe = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        const hasJsd = !!(window as any).__CF$cv$params;
        const hasCfChlOpt = !!(window as any)._cf_chl_opt;
        const cfChlOpt = (window as any)._cf_chl_opt ? JSON.stringify((window as any)._cf_chl_opt).slice(0, 300) : null;
        const challengeForm = document.querySelector('#challenge-form');
        const formAction = challengeForm?.getAttribute('action') ?? null;
        const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
          src: f.src?.slice(0, 120),
          id: f.id,
          title: f.title,
        }));
        return { hasTurnstileIframe, hasJsd, hasCfChlOpt, cfChlOpt, formAction, iframes, htmlLen: document.documentElement.outerHTML.length };
      });
      console.log(`${LOG} 🔬 Diagnostic CF: ${JSON.stringify(cfDiag)}`);

      // L'auto-solve est déjà actif. En parallèle, surveiller si CF finit par
      // résoudre le PoW lui-même (titre de page change = challenge passé).
      const pageCleared = new Promise<"cleared" | "still_challenge">((resolve) => {
        const interval = setInterval(async () => {
          try {
            const t = await page.title();
            const still = CF_CHALLENGE_TITLES.some(c => t.toLowerCase().includes(c));
            if (!still) {
              clearInterval(interval);
              resolve("cleared");
            }
          } catch { /* page may be navigating */ }
        }, 3_000);
        // Timeout de sécurité
        setTimeout(() => { clearInterval(interval); resolve("still_challenge"); }, CAPTCHA_SOLVE_TIMEOUT_MS + 5_000);
      });

      // Race entre auto-solve 2Captcha et résolution naturelle du PoW
      const autoResult = await Promise.race([
        captchaSolved,
        pageCleared.then(r => r === "cleared" ? "solved" as const : "timeout" as const),
      ]);

      if (autoResult === "solved") {
        solvedBy = "auto_solve";
        console.log(`${LOG} ✅ Challenge CF résolu (auto-solve ou PoW naturel) !`);
        // Attendre que la page se recharge après résolution
        await page.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 30_000,
        }).catch(() => {
          console.log(`${LOG} ⚠️ Pas de navigation post-solve (page peut déjà être chargée)`);
        });
      } else if (autoResult === "failed") {
        // Tenter un solve manuel comme fallback
        console.warn(`${LOG} ⚠️ Auto-solve échoué — tentative Captcha.solve manuelle…`);
        await new Promise((r) => setTimeout(r, CAPTCHA_DETECT_DELAY_MS));

        try {
          const solveResult = await session.send("Captcha.solve" as any, {
            detectTimeout: CAPTCHA_DETECT_TIMEOUT_MS,
            options: [{ type: "*" }],
          }) as { result?: { status: string; token?: string; errorMessage?: string } };

          if (solveResult?.result?.status === "solveFinished") {
            solvedBy = "manual_solve";
            console.log(`${LOG} ✅ Challenge résolu via Captcha.solve manuelle !`);
            await page.waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 30_000,
            }).catch(() => {});
          } else {
            return {
              success: false,
              error: `Captcha.solve échoué: ${solveResult?.result?.status} — ${solveResult?.result?.errorMessage ?? ""}`,
              durationMs: Date.now() - t0,
            };
          }
        } catch (solveErr: any) {
          return {
            success: false,
            error: `Captcha.solve erreur CDP: ${solveErr.message}`,
            durationMs: Date.now() - t0,
          };
        }
      } else {
        // Timeout — tenter un solve manuel
        console.warn(`${LOG} ⚠️ Auto-solve timeout ${CAPTCHA_SOLVE_TIMEOUT_MS}ms — tentative manuelle…`);
        try {
          const solveResult = await session.send("Captcha.solve" as any, {
            detectTimeout: CAPTCHA_DETECT_TIMEOUT_MS,
            options: [{ type: "*" }],
          }) as { result?: { status: string; token?: string; errorMessage?: string } };

          if (solveResult?.result?.status === "solveFinished") {
            solvedBy = "manual_solve";
            console.log(`${LOG} ✅ Challenge résolu via Captcha.solve (après timeout auto) !`);
            await page.waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 30_000,
            }).catch(() => {});
          } else {
            return {
              success: false,
              error: `Timeout auto-solve + manual échoué: ${solveResult?.result?.status}`,
              durationMs: Date.now() - t0,
            };
          }
        } catch (solveErr: any) {
          return {
            success: false,
            error: `Timeout auto-solve + Captcha.solve erreur: ${solveErr.message}`,
            durationMs: Date.now() - t0,
          };
        }
      }
    } else {
      console.log(`${LOG} ✅ Pas de challenge CF détecté — page accessible directement`);
      // Vérifier quand même si des cookies CF ont été émis silencieusement
      solvedBy = "no_captcha";
    }

    // ── 10. Extraire les cookies ─────────────────────────────────────────
    const cookies = await page.cookies();
    const cfClearanceCookie = cookies.find(
      (c) => c.name === "cf_clearance" && c.value.length > 10,
    );
    const phpSessionCookie = cookies.find((c) => c.name === "PHPSESSID");

    console.log(`${LOG} 🍪 Cookies extraits: ${cookies.length} total`);
    console.log(`${LOG}    cf_clearance: ${cfClearanceCookie ? "✅ " + cfClearanceCookie.value.slice(0, 20) + "…" : "❌ absent"}`);
    console.log(`${LOG}    PHPSESSID: ${phpSessionCookie ? "✅ " + phpSessionCookie.value.slice(0, 10) + "…" : "❌ absent"}`);

    if (!cfClearanceCookie) {
      // Peut arriver si le site ne challenge pas cette IP (confiance élevée)
      // ou si le challenge a été résolu mais le cookie n'a pas encore été émis
      console.warn(`${LOG} ⚠️ cf_clearance absent — navigation peut fonctionner sans (IP de confiance ?)`);
    }

    // ── 11. Capturer le User-Agent du navigateur cloud ───────────────────
    const userAgent = await page.evaluate(() => navigator.userAgent);
    console.log(`${LOG} 🌐 User-Agent: ${userAgent.slice(0, 60)}…`);

    // ── 12. Tenter le prefetch de /main/ (Bookitit widget) ──────────────
    let prefetchedMainHtml: string | undefined;
    const mainUrl = targetUrl.replace(/\/?$/, "/") + "onlinebookings/main/";
    try {
      console.log(`${LOG} 📦 Prefetch /main/ dans le navigateur cloud…`);
      const mainResponse = await page.goto(mainUrl, {
        waitUntil: "networkidle2",
        timeout: 30_000,
      });
      if (mainResponse && mainResponse.ok()) {
        const html = await mainResponse.text();
        if (html.length > 100) {
          prefetchedMainHtml = html;
          console.log(`${LOG} ✅ /main/ prefetché (${html.length} bytes)`);
        } else {
          console.warn(`${LOG} ⚠️ /main/ réponse trop courte (${html.length}B) — CF bloque ?`);
        }
      }
    } catch (e: any) {
      console.warn(`${LOG} ⚠️ Prefetch /main/ échoué: ${e.message}`);
    }

    // Re-lire les cookies après navigation /main/ (PHPSESSID peut apparaître ici)
    const finalCookies = await page.cookies();
    const finalPhpSession = finalCookies.find((c) => c.name === "PHPSESSID");
    const finalCfClearance = finalCookies.find(
      (c) => c.name === "cf_clearance" && c.value.length > 10,
    );

    if (finalPhpSession && !phpSessionCookie) {
      console.log(`${LOG} 🍪 PHPSESSID obtenu après /main/: ${finalPhpSession.value.slice(0, 10)}…`);
    }

    // ── 13. Détacher la session CDP et déconnecter ───────────────────────
    await session.detach().catch(() => {});
    await browser.disconnect();
    browser = null;

    // ── 14. Construire la SpainCfSession ─────────────────────────────────
    const now = Date.now();
    const cfClearanceValue = finalCfClearance?.value ?? cfClearanceCookie?.value ?? "";

    // Le proxy utilisé pour cette session — nécessaire pour que impit utilise la même IP
    const proxyUrl = config.customProxy ? buildProxyString(config.customProxy) : "";

    const allCookies = finalCookies.map((c) => ({ name: c.name, value: c.value }));

    const sessionResult: SpainCfSession = {
      cfClearance: cfClearanceValue,
      cfDomain: ".citaconsular.es",
      soaxProxyUrl: proxyUrl,
      userAgent,
      createdAt: now,
      expiresAt: now + CF_CLEARANCE_TTL_MS,
      allCookies,
      extraHeaders: {},
      source: "playwright", // Compatible avec le code existant qui vérifie source
      prefetchedMainHtml,
      phpSessionCreatedAt: finalPhpSession ? now : undefined,
    };

    const elapsed = Date.now() - t0;
    console.log(
      `${LOG} 🎉 Session 2Captcha Browser établie en ${(elapsed / 1000).toFixed(1)}s !` +
      ` | cf_clearance=${cfClearanceValue ? "✅" : "⚠️"} | PHPSESSID=${finalPhpSession ? "✅" : "❌"}` +
      ` | resolvedBy=${solvedBy} | cookies=${allCookies.length}`,
    );

    return {
      success: true,
      session: sessionResult,
      durationMs: elapsed,
      solvedBy,
    };
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`${LOG} ❌ Erreur solve 2Captcha Browser (${(elapsed / 1000).toFixed(1)}s): ${err.message}`);
    return {
      success: false,
      error: err.message,
      durationMs: elapsed,
    };
  } finally {
    if (browser) {
      await browser.disconnect().catch(() => {});
    }
  }
}

// ─── API Helpers ────────────────────────────────────────────────────────────

/**
 * Vérifie le statut du compte Browser API (traffic, limites, etc.)
 */
export async function check2CaptchaBrowserStatus(): Promise<{
  ok: boolean;
  trafficGb?: { total: number; used: number; available: number };
  accounts?: { count: number; max: number };
  error?: string;
}> {
  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "TWOCAPTCHA_API_KEY non définie" };

  try {
    const res = await fetch(
      `${TWOCAPTCHA_API_BASE}/browser?key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const data = await res.json() as Record<string, any>;

    if (data.status !== "OK") {
      return { ok: false, error: data.errorCode ?? data.error ?? "unknown" };
    }

    return {
      ok: true,
      trafficGb: data.browserTraffic
        ? {
            total: data.browserTraffic.totalGb,
            used: data.browserTraffic.usedGb,
            available: data.browserTraffic.availableGb,
          }
        : undefined,
      accounts: data.accounts
        ? { count: data.accounts.count, max: data.accounts.max }
        : undefined,
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Crée un browser account 2Captcha avec les paramètres optimaux pour VisaFlow.
 */
export async function create2CaptchaBrowserAccount(
  name: string = "VisaFlow Spain",
  proxyMode: "none" | "custom_proxy" = "none",
  customProxy?: TwoCaptchaBrowserConfig["customProxy"],
): Promise<{
  ok: boolean;
  accountId?: number;
  login?: string;
  password?: string;
  connectionUri?: string;
  error?: string;
}> {
  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "TWOCAPTCHA_API_KEY non définie" };

  const body: Record<string, unknown> = {
    key: apiKey,
    name,
    proxyMode,
  };
  if (proxyMode === "custom_proxy" && customProxy) {
    body.customProxy = customProxy;
  }

  try {
    const res = await fetch(`${TWOCAPTCHA_API_BASE}/browser/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json() as Record<string, any>;

    if (data.status !== "OK" || !data.account) {
      return { ok: false, error: data.errorCode ?? data.error ?? "unknown" };
    }

    console.log(`${LOG} ✅ Browser account créé: id=${data.account.id}, login=${data.account.login}`);
    return {
      ok: true,
      accountId: data.account.id,
      login: data.account.login,
      password: data.account.password,
      connectionUri: data.account.connectionUri,
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Liste les browser accounts existants.
 */
export async function list2CaptchaBrowserAccounts(): Promise<{
  ok: boolean;
  accounts?: Array<{
    id: number;
    login: string;
    name: string;
    proxyMode: string;
    connectionUri?: string;
    profilesCount: number;
  }>;
  error?: string;
}> {
  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "TWOCAPTCHA_API_KEY non définie" };

  try {
    const res = await fetch(
      `${TWOCAPTCHA_API_BASE}/browser/accounts?key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const data = await res.json() as Record<string, any>;

    if (data.status !== "OK") {
      return { ok: false, error: data.errorCode ?? data.error ?? "unknown" };
    }

    // L'API retourne data comme un objet indexé {"0": {...}, "1": {...}} ou un tableau
    const rawData = data.accounts ?? data.data ?? [];
    const dataArray = Array.isArray(rawData) ? rawData : Object.values(rawData);
    const accounts = dataArray.map((a: any) => ({
      id: a.id,
      login: a.login,
      name: a.name,
      proxyMode: a.proxyMode,
      connectionUri: a.connectionUri,
      profilesCount: a.profilesCount ?? 0,
    }));

    return { ok: true, accounts };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ─── Integration: ensureSpain2CaptchaBrowserSession ─────────────────────────

/**
 * Point d'entrée pour le mode SPAIN_SESSION_MODE=2captcha-browser.
 * Appelé par ensureSpainCfSession() dans spain-soax-solver.ts.
 *
 * Gère le cycle de vie complet :
 *   - Vérifie la session en cache mémoire
 *   - Si expirée/absente → solve via navigateur cloud 2Captcha
 *   - Stocke la session en cache pour réutilisation (~2h)
 */
let _cached2CaptchaSession: SpainCfSession | undefined;

export async function ensureSpain2CaptchaBrowserSession(
  targetUrl: string,
): Promise<SpainCfSession | null> {
  // Vérifier le cache mémoire
  if (_cached2CaptchaSession) {
    const remaining = _cached2CaptchaSession.expiresAt - Date.now();
    if (remaining > 10 * 60_000) {
      const remainMin = Math.round(remaining / 60_000);
      console.log(`${LOG} ♻️ Session 2Captcha réutilisée (reste ${remainMin}min)`);
      return _cached2CaptchaSession;
    }
    console.log(`${LOG} ⏰ Session 2Captcha expirée — renouvellement…`);
    _cached2CaptchaSession = undefined;
  }

  // Solve via 2Captcha Browser API
  const result = await solve2CaptchaBrowserSession(targetUrl);

  if (result.success && result.session) {
    _cached2CaptchaSession = result.session;
    return result.session;
  }

  console.error(`${LOG} ❌ Impossible d'établir une session 2Captcha: ${result.error}`);
  return null;
}

/** Invalide la session 2Captcha en cache (ex: après un 403). */
export function invalidate2CaptchaSession(): void {
  if (_cached2CaptchaSession) {
    console.log(`${LOG} 🗑️ Session 2Captcha invalidée`);
    _cached2CaptchaSession = undefined;
  }
}
