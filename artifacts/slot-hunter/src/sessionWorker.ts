/**
 * sessionWorker.ts — Le Recruteur
 *
 * Script standalone qui siphonne les cookies F5 WAF (TS01*) + ASP.NET_SessionId
 * depuis un vrai navigateur Chrome headless et les injecte dans Convex
 * via l'endpoint /hunter/cev-sessions/inject-f5.
 *
 * Architecture découplée :
 *   - Le Recruteur (ce script) génère les cookies WAF via Puppeteer Stealth
 *   - Le Chasseur (bot impit) utilise les cookies pour les requêtes HTTP
 *
 * Usage :
 *   npx tsx sessionWorker.ts
 *
 * Variables d'environnement requises :
 *   CONVEX_SITE_URL     — URL de l'API HTTP Convex (ex: https://xxx.convex.site)
 *   HUNTER_API_KEY      — Clé d'authentification pour les endpoints /hunter/*
 *   CEV_SESSION_ID      — ID de la session CEV cible dans Convex (ex: "jd7...")
 *
 * Variables optionnelles :
 *   PROXY_URL           — Proxy à utiliser (DOIT être le même que le Chasseur)
 *   REFRESH_INTERVAL_MIN — Intervalle de rafraîchissement en minutes (défaut: 13)
 */

interface CapturedCookies {
  f5CookieValue: string;
  f5CookieName: string;
  aspNetSessionId: string;
  userAgent: string;
}

// Import makeCevProxyStickyUrl to use the same proxy configuration as the main bot
import { makeCevProxyStickyUrl } from "./cev-shared-impit.js";

const CEV_URL = "https://appointment.cloud.diplomatie.be/";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY ?? "";
let CEV_SESSION_ID = process.env.CEV_SESSION_ID ?? "";
// Priorise SOAX via makeCevProxyStickyUrl pour utiliser la même configuration que le bot principal
let PROXY_URL = process.env.SOAX_PROXY_URL 
  ? makeCevProxyStickyUrl("soax", undefined, "session-worker")
  : process.env.IPROYAL_PROXY_URL 
  ? process.env.IPROYAL_PROXY_URL 
  : process.env.PROXY_URL ?? "";
const REFRESH_INTERVAL_MIN = parseInt(process.env.REFRESH_INTERVAL_MIN ?? "13", 10);

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [SESSION-WORKER] [${level}] ${msg}`);
}

/**
 * Lance un navigateur Chrome headless, navigue sur le CEV,
 * attend que le WAF F5 dépose ses cookies, et les capture.
 */
async function captureCookiesFromBrowser(): Promise<CapturedCookies | null> {
  // Import dynamique — puppeteer n'est requis QUE par ce worker
  let puppeteer: any;
  try {
    // @ts-ignore: puppeteer-extra has no official types
    puppeteer = await import("puppeteer-extra");
    // @ts-ignore: puppeteer-extra-plugin-stealth has no official types
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteer.default.use(StealthPlugin());
    
    // Install Chrome if it's missing
    try {
      const { install } = await import("@puppeteer/browsers");
      log("INFO", "Vérification installation Chrome pour Puppeteer…");
      await install({
        browser: "chrome",
        buildId: "latest",
        cacheDir: process.env.PUPPETEER_CACHE_DIR || undefined,
      });
      log("INFO", "✅ Chrome pour Puppeteer prêt !");
    } catch (installErr) {
      log("WARN", `Impossible d'installer Chrome automatiquement: ${installErr}`);
      log("WARN", "Tentative d'utilisation du Chrome système…");
    }
  } catch {
    log("ERROR", "puppeteer-extra ou puppeteer-extra-plugin-stealth non installé.");
    log("ERROR", "  → npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth @puppeteer/browsers");
    return null;
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ];

  if (PROXY_URL) {
    // Extraire host:port du proxy (ignorer auth — sera passée via page.authenticate)
    try {
      const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
      launchArgs.push(`--proxy-server=${parsed.hostname}:${parsed.port}`);
      log("INFO", `Proxy configuré: ${parsed.hostname}:${parsed.port}`);
    } catch {
      log("WARN", `URL proxy invalide: ${PROXY_URL.slice(0, 40)}… — connexion directe`);
    }
  }

  let browser: any = null;

  try {
    browser = await puppeteer.default.launch({
      headless: "new",
      args: launchArgs,
    });

    const page = await browser.newPage();

    // Authentification proxy si nécessaire
    if (PROXY_URL) {
      try {
        const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
        if (parsed.username) {
          await page.authenticate({
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
          });
        }
      } catch { /* pas d'auth */ }
    }

    // Capturer le User-Agent
    const userAgent = await browser.userAgent();
    log("INFO", `User-Agent: ${userAgent.slice(0, 80)}…`);

    // Naviguer vers le CEV
    log("INFO", `Navigation vers ${CEV_URL}…`);
    await page.goto(CEV_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    // Attendre que le WAF F5 exécute son JavaScript et dépose les cookies
    // Le JS F5 BIG-IP prend généralement 2-5 secondes
    const waitSec = 5 + Math.random() * 3; // 5-8 secondes
    log("INFO", `Attente ${waitSec.toFixed(1)}s pour exécution JS WAF F5…`);
    await new Promise(r => setTimeout(r, waitSec * 1000));

    // Capturer TOUS les cookies
    const cookies = await page.cookies();
    log("INFO", `${cookies.length} cookie(s) capturé(s)`);

    // Trouver le cookie F5 (commence par TS, peu importe le suffixe)
    const f5Cookie = cookies.find((c: any) => c.name.startsWith("TS"));
    const aspNetCookie = cookies.find((c: any) => c.name === "ASP.NET_SessionId");

    if (!f5Cookie) {
      log("WARN", `Cookie F5 (TS*) non trouvé. Cookies présents: ${cookies.map((c: any) => c.name).join(", ")}`);
      // Tenter un reload — parfois le F5 nécessite une deuxième navigation
      log("INFO", "Tentative reload…");
      await page.reload({ waitUntil: "networkidle2", timeout: 30_000 });
      await new Promise(r => setTimeout(r, 5000));

      const cookies2 = await page.cookies();
      const f5Cookie2 = cookies2.find((c: any) => c.name.startsWith("TS"));
      const aspNetCookie2 = cookies2.find((c: any) => c.name === "ASP.NET_SessionId");

      if (!f5Cookie2) {
        log("ERROR", "Cookie F5 toujours absent après reload. Cookies: " + cookies2.map((c: any) => c.name).join(", "));
        return null;
      }

      return {
        f5CookieValue: f5Cookie2.value,
        f5CookieName: f5Cookie2.name,
        aspNetSessionId: aspNetCookie2?.value ?? "",
        userAgent,
      };
    }

    if (!aspNetCookie) {
      log("WARN", "ASP.NET_SessionId non trouvé — le cookie F5 seul sera injecté");
    }

    log("INFO", `✅ Cookies capturés: ${f5Cookie.name}=${f5Cookie.value.slice(0, 20)}… | ASP.NET_SessionId=${aspNetCookie?.value?.slice(0, 10) ?? "N/A"}…`);

    return {
      f5CookieValue: f5Cookie.value,
      f5CookieName: f5Cookie.name,
      aspNetSessionId: aspNetCookie?.value ?? "",
      userAgent,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Erreur Puppeteer: ${msg}`);
    return null;

  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Envoie les cookies capturés à Convex via l'endpoint HTTP.
 */
async function injectCookiesToConvex(captured: CapturedCookies): Promise<boolean> {
  const endpoint = `${CONVEX_SITE_URL}/hunter/cev-sessions/inject-f5`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hunter-Key": HUNTER_API_KEY,
      },
      body: JSON.stringify({
        sessionId: CEV_SESSION_ID,
        f5CookieValue: captured.f5CookieValue,
        f5CookieName: captured.f5CookieName,
        aspNetSessionId: captured.aspNetSessionId,
        userAgent: captured.userAgent,
        validityMinutes: REFRESH_INTERVAL_MIN + 2, // Marge de 2 min
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      log("ERROR", `Convex inject failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
      return false;
    }

    const data = await res.json() as { ok?: boolean };
    if (data.ok) {
      log("INFO", `✅ Cookies injectés dans Convex (session: ${CEV_SESSION_ID.slice(0, 10)}…)`);
      return true;
    }

    log("WARN", `Réponse Convex inattendue: ${JSON.stringify(data)}`);
    return false;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Erreur injection Convex: ${msg}`);
    return false;
  }
}

/**
 * Récupère la session CEV active depuis Convex.
 */
async function fetchActiveSession(): Promise<string | null> {
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/hunter/cev-credentials`, {
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
      },
    });
    if (!res.ok) return null;
    const creds = await res.json();
    if (creds && creds.sessionId) {
      return creds.sessionId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Cycle complet : capture + injection.
 */
async function refreshCycle(): Promise<void> {
  try {
    log("INFO", "═══ Début cycle de rafraîchissement ═══");

    const captured = await captureCookiesFromBrowser();
    if (!captured) {
      log("ERROR", "Capture échouée — retry au prochain cycle");
      return;
    }

    if (!captured.aspNetSessionId) {
      log("WARN", "ASP.NET_SessionId absent — injection du cookie F5 seul");
    }

    await injectCookiesToConvex(captured);
    log("INFO", `═══ Fin cycle — prochain dans ${REFRESH_INTERVAL_MIN} min ═══`);
  } catch (err) {
    log("ERROR", `Erreur inattendue pendant le cycle: ${err}`);
  }
}

/**
 * Point d'entrée principal.
 */
export async function startSessionWorker(): Promise<void> {
  log("INFO", "╔══════════════════════════════════════════════════╗");
  log("INFO", "║   Session Worker (Recruteur F5) — Démarrage      ║");
  log("INFO", "╚══════════════════════════════════════════════════╝");

  // Validation des variables d'environnement
  if (!CONVEX_SITE_URL) {
    log("ERROR", "CONVEX_SITE_URL manquant ! Exemple: https://xxx.convex.site");
    // Ne pas crasher tout le bot — juste ne pas démarrer le worker
    return;
  }
  if (!HUNTER_API_KEY) {
    log("ERROR", "HUNTER_API_KEY manquant !");
    // Ne pas crasher tout le bot — juste ne pas démarrer le worker
    return;
  }

  // Récupérer la session CEV automatiquement si pas fournie
  if (!CEV_SESSION_ID) {
    log("INFO", "CEV_SESSION_ID non défini — tentative de récupération automatique...");
    const autoSessionId = await fetchActiveSession();
    if (autoSessionId) {
      CEV_SESSION_ID = autoSessionId;
      log("INFO", `✅ Session CEV trouvée automatiquement: ${CEV_SESSION_ID.slice(0, 15)}…`);
    } else {
      log("WARN", "Impossible de trouver une session CEV active ! Le worker attendra 30s avant de réessayer...");
      // Réessayer dans 30s
      setTimeout(() => startSessionWorker(), 30_000);
      return;
    }
  }

  log("INFO", `Config:`);
  log("INFO", `  • Convex: ${CONVEX_SITE_URL.slice(0, 40)}…`);
  log("INFO", `  • Session: ${CEV_SESSION_ID.slice(0, 15)}…`);
  log("INFO", `  • Proxy: ${PROXY_URL ? PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 50) + "…" : "(direct)"}`);
  log("INFO", `  • Intervalle: ${REFRESH_INTERVAL_MIN} min`);

  // Premier cycle immédiat
  await refreshCycle();

  // Boucle périodique
  const intervalMs = REFRESH_INTERVAL_MIN * 60_000;
  setInterval(async () => {
    try {
      await refreshCycle();
    } catch (err) {
      log("ERROR", `Crash cycle: ${err}`);
    }
  }, intervalMs);

  log("INFO", `Worker actif — refresh toutes les ${REFRESH_INTERVAL_MIN} min (Ctrl+C pour arrêter)`);
}

// Lancer automatiquement seulement si le fichier est exécuté directement
if (import.meta.url === `file://${process.argv[1]}`) {
  startSessionWorker().catch(err => {
    log("ERROR", `Fatal: ${err}`);
    process.exit(1);
  });
}

export {};
