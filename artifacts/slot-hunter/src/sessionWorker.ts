interface CapturedCookies {
  f5CookieValue: string;
  f5CookieName: string;
  aspNetSessionId: string;
  userAgent: string;
}

import { makeCevProxyStickyUrl, getCevProxyUrl } from "./cev-shared-impit.js";
import { getActiveJobs, injectApplicationF5Cookies } from "./convexClient.js";

const VOWINT_URL = "https://visaonweb.diplomatie.be";
const CEV_URL = "https://appointment.cloud.diplomatie.be/Captcha";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY ?? "";
let CEV_SESSION_ID = process.env.CEV_SESSION_ID ?? "";

let PROXY_URL = process.env.SOAX_PROXY_URL
  ? makeCevProxyStickyUrl("soax", undefined, "session-worker")
  : process.env.IPROYAL_PROXY_URL
  ? process.env.IPROYAL_PROXY_URL
  : process.env.PROXY_URL ?? "";

const REFRESH_INTERVAL_MIN = parseInt(process.env.REFRESH_INTERVAL_MIN ?? "13", 10);

// Cache pour la valeur cev_use_proxy depuis botConfig
let _cevUseProxyCache: boolean | null = null;
let _cevUseProxyLastChecked = 0;
const CEV_USE_PROXY_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Vérifie si le proxy doit être utilisé pour le sessionWorker.
 * Consulte botConfig "cev_use_proxy" (0 = désactivé, 1 = activé).
 * Par défaut: true (utiliser le proxy si configuré).
 */
async function shouldUseProxyForSessionWorker(): Promise<boolean> {
  const now = Date.now();
  
  // Retourner la valeur mise en cache si elle est récente
  if (_cevUseProxyCache !== null && (now - _cevUseProxyLastChecked) < CEV_USE_PROXY_CACHE_TTL_MS) {
    return _cevUseProxyCache;
  }
  
  // Mettre à jour le timestamp
  _cevUseProxyLastChecked = now;
  
  try {
    // Import dynamique pour éviter les problèmes de dépendance circulaire
    const { getBotConfigValue } = await import("./convexClient.js");
    const configValue = await getBotConfigValue("cev_use_proxy");
    
    if (configValue === "0") {
      _cevUseProxyCache = false;
      log("INFO", "🔄 Proxy désactivé via botConfig (cev_use_proxy=0)");
      return false;
    } else if (configValue === "1") {
      _cevUseProxyCache = true;
      log("INFO", "🔄 Proxy activé via botConfig (cev_use_proxy=1)");
      return true;
    } else {
      // Non configuré ou autre valeur → utiliser le proxy par défaut s'il est configuré
      _cevUseProxyCache = true;
      log("INFO", "🔄 Proxy par défaut (cev_use_proxy non configuré ou ≠ 0/1)");
      return true;
    }
  } catch (error) {
    // En cas d'erreur (Convex inaccessible), utiliser la valeur cache ou false par défaut
    log("WARN", `⚠️ Erreur lecture botConfig cev_use_proxy: ${error}`);
    if (_cevUseProxyCache === null) {
      _cevUseProxyCache = false; // Par défaut, NE PAS utiliser le proxy si Convex inaccessible
    }
    return _cevUseProxyCache;
  }
}

async function getProxyUrl(): Promise<string> {
  // Vérifier si le proxy est désactivé via botConfig
  const useProxy = await shouldUseProxyForSessionWorker();
  if (!useProxy) {
    log("INFO", "🔄 Proxy désactivé via botConfig → mode direct");
    return "";
  }

  // First priority: use the exact proxy already used by the CEV dossier loop
  const cevProxy = getCevProxyUrl();
  if (cevProxy) {
    log("INFO", "Utilisant le proxy du CEV dossier loop (même IP)");
    return cevProxy;
  }
  
  // IMPÉRATIF: Même proxy SOAX et même session-id que les dossiers
  // pour avoir la MÊME IP et capturer le cookie TS01 valide
  if (process.env.SOAX_PROXY_URL) {
    log("INFO", "🔒 MÊME PROXY SOAX que les dossiers (même IP obligatoire pour TS01)");
    log("INFO", "🔒 Session-id: 'cev-dossier-v3' (IDENTIQUE aux dossiers)");
    log("INFO", "⚠️ Les dossiers attendent 60s → pas de conflit simultané");
    return makeCevProxyStickyUrl("soax", undefined, "cev-dossier-v3");
  }
  
  // Fallback
  const proxyUrl = process.env.IPROYAL_PROXY_URL
    ? process.env.IPROYAL_PROXY_URL
    : process.env.PROXY_URL ?? "";
  
  if (!proxyUrl) {
    log("WARN", "Aucun proxy configuré — tentative en direct");
    return "";
  }
  
  return proxyUrl;
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [SESSION-WORKER] [${level}] ${msg}`);
}

async function captureCookiesFromBrowser(): Promise<CapturedCookies | null> {
  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer-extra");
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteer.default.use(StealthPlugin());
  } catch (err) {
    log("ERROR", `puppeteer-extra or puppeteer-extra-plugin-stealth not installed: ${err}`);
    log("ERROR", "  Run: npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth");
    return null;
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ];

  const PROXY_URL = await getProxyUrl();

  let proxyHost = "";
  let proxyPort = "";

  if (PROXY_URL) {
    try {
      const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
      proxyHost = parsed.hostname;
      proxyPort = parsed.port;
      launchArgs.push(`--proxy-server=${parsed.hostname}:${parsed.port}`);
      log("INFO", `Proxy configured: ${parsed.hostname}:${parsed.port}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log("ERROR", `Proxy URL invalide: ${PROXY_URL.slice(0, 40)}… — erreur: ${errMsg}`);
      return null;
    }
  } else {
    log("WARN", `Aucun proxy configuré — connexion directe (risque de blocage IP)`);
    // Pas de proxy, connexion directe
  }

  let browser: any = null;

  try {
    log("INFO", `Lancement du navigateur avec proxy: ${proxyHost}:${proxyPort}`);
    browser = await puppeteer.default.launch({
      headless: "new",
      args: launchArgs,
    });
    log("INFO", "Navigateur lancé avec succès");

    const page = await browser.newPage();

    if (PROXY_URL) {
      try {
        const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
        if (parsed.username) {
          log("INFO", `Authentification proxy avec username: ${decodeURIComponent(parsed.username).slice(0, 30)}…`);
          await page.authenticate({
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
          });
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log("ERROR", `Erreur lors de l'authentification proxy: ${errMsg}`);
        return null;
      }
    } else {
      log("INFO", "Pas de proxy — authentification directe");
    }

    const userAgent = await browser.userAgent();
    log("INFO", `User-Agent: ${userAgent.slice(0, 80)}...`);

    // CORRECTION IMPORTANTE : Seulement capturer TS01 depuis VOWINT homepage
    // ASP.NET_SessionId sera obtenu naturellement par les dossiers via leur flux VOWINT → CEV
    
    // Step 1: Go to VOWINT to get TS0110ceb4 cookie (IMMÉDIAT sur homepage)
    log("INFO", `Navigating to VOWINT homepage pour TS cookie: ${VOWINT_URL}`);
    await page.goto(VOWINT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    const waitVowintSec = 8 + Math.random() * 4;
    log("INFO", `Waiting ${waitVowintSec.toFixed(1)}s sur VOWINT pour TS cookie...`);
    await new Promise(r => setTimeout(r, waitVowintSec * 1000));

    // Step 2: NE PAS naviguer sur /Captcha ! Cela ne crée pas ASP.NET_SessionId
    // ASP.NET_SessionId sera créé par le flux réel : VOWINT → GetEAppointmentUrl → integrationUrl CEV
    log("INFO", "⚠️ NE PAS naviguer sur /Captcha - ASP.NET_SessionId sera obtenu par les dossiers via flux naturel");

    const cookies = await page.cookies();
    log("INFO", `${cookies.length} cookie(s) capturés: ${cookies.map((c: any) => c.name).join(", ")}`);

    const f5Cookie = cookies.find((c: any) => c.name.startsWith("TS"));
    const aspNetCookie = cookies.find((c: any) => c.name === "ASP.NET_SessionId");

    if (!f5Cookie) {
      log("WARN", `F5 cookie (TS*) introuvable! Cookies présents: ${cookies.map((c: any) => c.name).join(", ")}`);
      log("INFO", "Trying reload VOWINT...");
      await page.goto(VOWINT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
      await new Promise(r => setTimeout(r, 10000));

      const cookies2 = await page.cookies();
      const f5Cookie2 = cookies2.find((c: any) => c.name.startsWith("TS"));

      if (!f5Cookie2) {
        log("ERROR", "F5 cookie toujours manquant après reload! Cookies: " + cookies2.map((c: any) => c.name).join(", "));
        return null;
      }

      return {
        f5CookieValue: f5Cookie2.value,
        f5CookieName: f5Cookie2.name,
        aspNetSessionId: "", // Vide - obtenu par les dossiers
        userAgent,
      };
    }

    // ASP.NET_SessionId devrait être vide - c'est NORMAL
    if (aspNetCookie) {
      log("INFO", `ASP.NET_SessionId présent sur VOWINT (inattendu): ${aspNetCookie.value.slice(0, 10)}...`);
    } else {
      log("INFO", "ASP.NET_SessionId absent - NORMAL, sera obtenu par les dossiers via flux VOWINT → CEV");
    }

    log("INFO", `  ✅ TS cookie capturé: ${f5Cookie.name}=${f5Cookie.value.slice(0, 20)}...`);
    log("INFO", `  ✅ User-Agent: ${userAgent.slice(0, 80)}...`);

    return {
      f5CookieValue: f5Cookie.value,
      f5CookieName: f5Cookie.name,
      aspNetSessionId: "", // VIDE - ASP.NET_SessionId obtenu par les dossiers via flux naturel
      userAgent,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    log("ERROR", `Puppeteer error: ${msg}`);
    if (stack) log("ERROR", `Stack trace: ${stack}`);
    return null;
  } finally {
    if (browser) {
      try {
        log("INFO", "Fermeture du navigateur");
        await browser.close();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log("WARN", `Erreur lors de la fermeture du navigateur: ${errMsg}`);
      }
    }
  }
}

// Helper function to get all active CEV jobs
async function getAllActiveCevJobs(): Promise<any[]> {
  try {
    const jobs = await getActiveJobs();
    return jobs.filter((j: any) => 
      j.destination === "schengen" && 
      j.hunterConfig?.isActive === true &&
      (j.hunterConfig.cevDossierPool || j.hunterConfig.vowintAppId)
    );
  } catch {
    return [];
  }
}

async function injectCookiesToConvex(captured: CapturedCookies): Promise<boolean> {
  try {
    // CORRECTION : ASP.NET_SessionId vide est NORMAL - obtenu par les dossiers via flux naturel
    const aspNetSessionId = captured.aspNetSessionId;
    const hasAspNet = !!aspNetSessionId;
    
    const cevJobs = await getAllActiveCevJobs();
    
    if (cevJobs.length === 0) {
      log("WARN", "Aucun job CEV actif trouvé — pas d'injection");
      return false;
    }
    
    log("INFO", `🔄 Injecting cookies dans ${cevJobs.length} job(s) CEV actif(s)...`);
    
    let successCount = 0;
    for (const job of cevJobs) {
      const result = await injectApplicationF5Cookies(
        job.id,
        captured.f5CookieValue,
        aspNetSessionId,
        captured.userAgent,
        {
          f5CookieName: captured.f5CookieName,
          validityMinutes: REFRESH_INTERVAL_MIN + 2,
        }
      );
      
      if (result) {
        successCount++;
        log("INFO", `  ✅ Application ${job.id.slice(0, 15)}... (${job.applicantName || "sans nom"})`);
      } else {
        log("WARN", `  ❌ Échec injection pour ${job.id.slice(0, 15)}...`);
      }
    }
    
    if (!hasAspNet) {
      log("INFO", `  ⚠️ ASP.NET_SessionId vide - NORMAL, sera obtenu par les dossiers via flux VOWINT → CEV`);
    }
    
    if (successCount === cevJobs.length) {
      log("INFO", `✅ Tous les ${successCount} jobs ont reçu les cookies!`);
      return true;
    } else {
      log("WARN", `Injection terminée: ${successCount}/${cevJobs.length} réussis`);
      return successCount > 0;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Convex injection error: ${msg}`);
    return false;
  }
}

async function fetchActiveSession(): Promise<string | null> {
  try {
    const cevJobs = await getAllActiveCevJobs();
    
    if (cevJobs.length > 0) {
      return cevJobs[0].id;
    }
    return null;
  } catch {
    return null;
  }
}

async function refreshCycle(): Promise<boolean> {
  try {
    log("INFO", "=== Start refresh cycle (TS01 seulement) ===");

    const captured = await captureCookiesFromBrowser();
    if (!captured) {
      log("ERROR", "Capture failed — retry next cycle");
      return false;
    }

    // CORRECTION : ASP.NET_SessionId vide est NORMAL - obtenu par les dossiers via flux VOWINT → CEV
    if (!captured.aspNetSessionId) {
      log("INFO", "✅ ASP.NET_SessionId absent - NORMAL, sera obtenu par les dossiers via flux naturel");
    } else {
      log("INFO", `ℹ️ ASP.NET_SessionId présent (inattendu): ${captured.aspNetSessionId.slice(0, 10)}...`);
    }

    const injected = await injectCookiesToConvex(captured);
    log("INFO", `=== Cycle done — next in ${REFRESH_INTERVAL_MIN} min ===`);
    return injected; // Retourne true si au moins un injecté avec succès
  } catch (err) {
    log("ERROR", `Unexpected error during cycle: ${err}`);
    return false;
  }
}

export async function startSessionWorker(): Promise<void> {
  log("INFO", "===============================================");
  log("INFO", "  Session Worker (F5 Recruiter) — Starting     ");
  log("INFO", "===============================================");

  if (!CONVEX_SITE_URL) {
    log("ERROR", "CONVEX_SITE_URL missing! Example: https://xxx.convex.site");
    return;
  }
  if (!HUNTER_API_KEY) {
    log("ERROR", "HUNTER_API_KEY missing!");
    return;
  }

  if (!CEV_SESSION_ID) {
    log("INFO", "CEV_SESSION_ID not defined — trying to auto-detect...");
    const autoSessionId = await fetchActiveSession();
    if (autoSessionId) {
      CEV_SESSION_ID = autoSessionId;
      log("INFO", `  CEV session found automatically: ${CEV_SESSION_ID.slice(0, 15)}...`);
    } else {
      log("WARN", "Could not find an active CEV session! Worker will wait 30s before retrying...");
      setTimeout(() => startSessionWorker(), 30_000);
      return;
    }
  }

  log("INFO", `Config:`);
  log("INFO", `  - Convex: ${CONVEX_SITE_URL.slice(0, 40)}...`);
  log("INFO", `  - Session: ${CEV_SESSION_ID.slice(0, 15)}...`);
  log("INFO", `  - Proxy: ${PROXY_URL ? PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 50) + "..." : "(direct)"}`);
  log("INFO", `  - Interval: ${REFRESH_INTERVAL_MIN} min`);

  // Capture initiale - SIGNALER quand terminée
  log("INFO", "🔄 Session Worker: capture INITIALE en cours...");
  const initialCaptureResult = await refreshCycle();
  
  if (initialCaptureResult) {
    log("INFO", "✅ Session Worker : capture initiale TERMINÉE");
    log("INFO", "   → Cookies injectés dans Convex");
    log("INFO", "   → Dossiers peuvent démarrer MAINTENANT");
  } else {
    log("ERROR", "❌ Session Worker : capture initiale ÉCHOUÉE");
    log("INFO", "   → Dossiers démarreront avec cookies potentiellement expirés");
  }
  
  log("INFO", "   → Cookies sont SESSION (expirent après ~15-20min d'inactivité)");
  
  // Intervalle de rafraîchissement OPTIMISÉ : 45 minutes au lieu de 13
  // Pour maintenir la session active sans gaspillage
  const OPTIMIZED_INTERVAL_MIN = 45; // 45 minutes (au lieu de 13)
  const intervalMs = OPTIMIZED_INTERVAL_MIN * 60_000;
  
  setInterval(async () => {
    try {
      log("INFO", `🔄 Rafraîchissement session (toutes les ${OPTIMIZED_INTERVAL_MIN}min)`);
      await refreshCycle();
    } catch (err) {
      log("ERROR", `Cycle crashed: ${err}`);
    }
  }, intervalMs);
  
  log("INFO", `Worker active — refresh every ${OPTIMIZED_INTERVAL_MIN} min (optimisé)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSessionWorker().catch(err => {
    log("ERROR", `Fatal: ${err}`);
    process.exit(1);
  });
}

export {};
