interface CapturedCookies {
  f5CookieValue: string;
  f5CookieName: string;
  aspNetSessionId: string;
  userAgent: string;
}

import { makeCevProxyStickyUrl, getCevProxyUrl } from "./cev-shared-impit.js";

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

function getProxyUrl(): string {
  // First priority: use the exact proxy already used by the CEV dossier loop
  const cevProxy = getCevProxyUrl();
  if (cevProxy) {
    log("INFO", "Utilisant le proxy du CEV dossier loop (même IP)");
    return cevProxy;
  }
  // Fallback: generate a new proxy URL
  const proxyUrl = process.env.SOAX_PROXY_URL
    ? makeCevProxyStickyUrl("soax", undefined, "session-worker")
    : process.env.IPROYAL_PROXY_URL
    ? process.env.IPROYAL_PROXY_URL
    : process.env.PROXY_URL ?? "";
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

  const PROXY_URL = getProxyUrl();

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
    log("ERROR", `Aucun proxy configuré ! (PROXY_URL / SOAX_PROXY_URL / IPROYAL_PROXY_URL)`);
    return null;
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
    }

    const userAgent = await browser.userAgent();
    log("INFO", `User-Agent: ${userAgent.slice(0, 80)}...`);

    // Step 1: Go to VOWINT to get TS0110ceb4 cookie
    log("INFO", `Navigating to VOWINT: ${VOWINT_URL}`);
    await page.goto(VOWINT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    const waitVowintSec = 10 + Math.random() * 5;
    log("INFO", `Waiting ${waitVowintSec.toFixed(1)}s on VOWINT for TS cookie...`);
    await new Promise(r => setTimeout(r, waitVowintSec * 1000));

    // Step 2: Go to CEV Captcha to get ASP.NET_SessionId
    log("INFO", `Navigating to CEV Captcha: ${CEV_URL}`);
    await page.goto(CEV_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    const waitCevSec = 5 + Math.random() * 3;
    log("INFO", `Waiting ${waitCevSec.toFixed(1)}s on CEV...`);
    await new Promise(r => setTimeout(r, waitCevSec * 1000));

    const cookies = await page.cookies();
    log("INFO", `${cookies.length} cookie(s) captured: ${cookies.map(c => c.name).join(", ")}`);

    const f5Cookie = cookies.find((c: any) => c.name.startsWith("TS"));
    const aspNetCookie = cookies.find((c: any) => c.name === "ASP.NET_SessionId");

    if (!f5Cookie) {
      log("WARN", `F5 cookie (TS*) not found! Cookies present: ${cookies.map((c: any) => c.name).join(", ")}`);
      log("INFO", "Trying reload VOWINT...");
      await page.goto(VOWINT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
      await new Promise(r => setTimeout(r, 10000));

      const cookies2 = await page.cookies();
      const f5Cookie2 = cookies2.find((c: any) => c.name.startsWith("TS"));
      const aspNetCookie2 = cookies2.find((c: any) => c.name === "ASP.NET_SessionId");

      if (!f5Cookie2) {
        log("ERROR", "F5 cookie still missing after reload! Cookies: " + cookies2.map((c: any) => c.name).join(", "));
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
      log("WARN", "ASP.NET_SessionId missing — only injecting F5 cookie");
    }

    log("INFO", `  Cookies captured: ${f5Cookie.name}=${f5Cookie.value.slice(0, 20)}... | ASP.NET_SessionId=${aspNetCookie?.value?.slice(0, 10) ?? "N/A"}...`);

    return {
      f5CookieValue: f5Cookie.value,
      f5CookieName: f5Cookie.name,
      aspNetSessionId: aspNetCookie?.value ?? "",
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
        validityMinutes: REFRESH_INTERVAL_MIN + 2,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text();
      log("ERROR", `Convex inject failed: HTTP ${res.status} - ${body.slice(0, 200)}`);
      return false;
    }

    const data = await res.json() as { ok?: boolean };
    if (data.ok) {
      log("INFO", `  Cookies injected into Convex (session: ${CEV_SESSION_ID.slice(0, 10)}...)`);
      return true;
    }

    log("WARN", `Unexpected Convex response: ${JSON.stringify(data)}`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Convex injection error: ${msg}`);
    return false;
  }
}

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

async function refreshCycle(): Promise<void> {
  try {
    log("INFO", "=== Start refresh cycle ===");

    const captured = await captureCookiesFromBrowser();
    if (!captured) {
      log("ERROR", "Capture failed — retry next cycle");
      return;
    }

    if (!captured.aspNetSessionId) {
      log("WARN", "ASP.NET_SessionId missing — inject F5 cookie only");
    }

    await injectCookiesToConvex(captured);
    log("INFO", `=== Cycle done — next in ${REFRESH_INTERVAL_MIN} min ===`);
  } catch (err) {
    log("ERROR", `Unexpected error during cycle: ${err}`);
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

  await refreshCycle();

  const intervalMs = REFRESH_INTERVAL_MIN * 60_000;
  setInterval(async () => {
    try {
      await refreshCycle();
    } catch (err) {
      log("ERROR", `Cycle crashed: ${err}`);
    }
  }, intervalMs);

  log("INFO", `Worker active — refresh every ${REFRESH_INTERVAL_MIN} min (Ctrl+C to stop)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSessionWorker().catch(err => {
    log("ERROR", `Fatal: ${err}`);
    process.exit(1);
  });
}

export {};
