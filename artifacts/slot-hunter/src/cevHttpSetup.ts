/**
 * cevHttpSetup.ts — Setup CEV session en HTTP pur (sans Playwright)
 *
 * Flux complet :
 *   1. Login VOWINT (ou réutiliser session existante)
 *   2. GET /Common/GetEAppointmentUrl?id={appId} → URL d'intégration CEV (= 1 clic VOWINT)
 *   3. GET {integrationUrl} → cookie ASP.NET_SessionId CEV
 *   4. Résoudre hCaptcha via Anti-Captcha
 *   5. POST /Captcha/SetCaptchaToken → validUntil + redirectUrl
 *
 * Optimisation : les cookies VOWINT sont persistés en mémoire entre les checks.
 * On ne re-login que si la session VOWINT a expiré (401/302 vers login).
 * Seul le GetEAppointmentUrl compte comme "clic" (limite 5/heure).
 *
 * Coût : 1 hCaptcha (~$0.003) par check
 */

import { botLog } from "./convexClient.js";
import { randomUserAgent } from "./browser.js";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY?.trim() ?? "";
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY?.trim() ?? "";

// ─── Cache session VOWINT (persisté en mémoire entre les checks) ─────────────
// Clé = vowintEmail, Valeur = { cookies, appId, ua, lastUsedAt }
// On réutilise la session tant qu'elle n'a pas expiré (détecté par 302 vers login).
interface VowintSessionCache {
  cookies: string;
  appId: string;       // UUID du dossier (pour GetEAppointmentUrl)
  ua: string;          // User-Agent utilisé lors du login (garder le même)
  lastUsedAt: number;  // timestamp du dernier usage réussi
}
const vowintSessionCache = new Map<string, VowintSessionCache>();

// Durée max avant de forcer un re-login (30 min — session VOWINT expire après ~20-30 min d'inactivité)
const VOWINT_SESSION_MAX_AGE_MS = 25 * 60_000;

export interface CevHttpSetupResult {
  success: boolean;
  sessionCookie?: string;
  validUntilMs?: number;
  integrationUrl?: string;
  redirectUrl?: string;       // URL retournée par SetCaptchaToken (indique si slots dispo)
  slotsAvailable?: boolean;   // true si redirectUrl contient SelectSlot
  error?: string;
}

/**
 * Obtient une session VOWINT (login + appId) — utilise le cache si disponible.
 * Ne re-login que si :
 *   - Pas de cache pour cet email
 *   - Cache expiré (> 25 min)
 *   - Session invalide (détecté par 302 vers login lors d'un appel ultérieur)
 */
async function getVowintSession(
  vowintEmail: string,
  vowintPassword: string,
  clientId: string,
  vowintAppUrl?: string,
): Promise<{ success: true; cookies: string; appId: string; ua: string } | { success: false; error: string }> {
  // Vérifier le cache
  const cached = vowintSessionCache.get(vowintEmail);
  if (cached && (Date.now() - cached.lastUsedAt) < VOWINT_SESSION_MAX_AGE_MS) {
    botLog({ applicationId: clientId, step: "cev_http_vowint_cache_hit", status: "ok", data: { appId: cached.appId } });
    cached.lastUsedAt = Date.now();
    return { success: true, cookies: cached.cookies, appId: cached.appId, ua: cached.ua };
  }

  // Cache miss ou expiré — faire un login complet
  const ua = randomUserAgent();

  // 1. GET page login → CSRF token + cookies
  const loginPageRes = await fetch(`${VOWINT_BASE}/`, {
    method: "GET",
    headers: { "User-Agent": ua, "Accept": "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!loginPageRes.ok) {
    return { success: false, error: `VOWINT_GET_FAILED_${loginPageRes.status}` };
  }
  const loginHtml = await loginPageRes.text();
  const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tokenMatch) return { success: false, error: "CSRF_TOKEN_NOT_FOUND" };
  const csrfToken = tokenMatch[1];
  const vowintCookies = extractCookies(loginPageRes);
  if (!vowintCookies) return { success: false, error: "VOWINT_COOKIES_NOT_FOUND" };

  // 2. POST login
  const loginRes = await fetch(`${VOWINT_BASE}/en/Account/Login`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": vowintCookies,
      "Referer": `${VOWINT_BASE}/`,
      "Origin": VOWINT_BASE,
      "Accept": "text/html,application/xhtml+xml,*/*",
    },
    body: new URLSearchParams({
      __RequestVerificationToken: csrfToken,
      UserName: vowintEmail,
      Password: vowintPassword,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (loginRes.status !== 302) {
    botLog({ applicationId: clientId, step: "cev_http_login_failed", status: "fail", data: { status: loginRes.status } });
    return { success: false, error: "CEV_VOWINT_SESSION_FAILED" };
  }

  // Suivre les redirections post-login pour collecter tous les cookies
  let cookies = mergeCookies(vowintCookies, loginRes);
  let redirectUrl = loginRes.headers.get("location");
  for (let i = 0; i < 5 && redirectUrl; i++) {
    const fullUrl = redirectUrl.startsWith("http") ? redirectUrl : `${VOWINT_BASE}${redirectUrl}`;
    const r = await fetch(fullUrl, {
      method: "GET",
      headers: { "User-Agent": ua, "Cookie": cookies, "Accept": "text/html,application/xhtml+xml,*/*", "Referer": `${VOWINT_BASE}/` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    cookies = mergeCookies(cookies, r);
    if (r.status >= 300 && r.status < 400) { redirectUrl = r.headers.get("location"); }
    else break;
  }
  botLog({ applicationId: clientId, step: "cev_http_login_ok", status: "ok" });

  // 3. Récupérer l'appId
  let appId: string | null = null;

  if (vowintAppUrl?.includes("GetEAppointmentUrl")) {
    appId = vowintAppUrl.match(/id=([^&]+)/)?.[1] ?? null;
  }

  if (!appId) {
    // GET IndexByUserId (initialise la vue)
    const pageRes = await fetch(`${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, {
      method: "GET",
      headers: { "User-Agent": ua, "Cookie": cookies, "Accept": "text/html,application/xhtml+xml,*/*", "Referer": `${VOWINT_BASE}/en`, "Upgrade-Insecure-Requests": "1" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      cookies = mergeCookies(cookies, pageRes);
      const m = html.match(/GetEAppointmentUrl\?id=([a-f0-9-]+)/i);
      if (m) appId = m[1];
    }

    // GET DataTables (initialise état serveur)
    if (!appId) {
      await fetch(`${VOWINT_BASE}/VisaApplication/DataTables`, {
        method: "GET",
        headers: { "User-Agent": ua, "Cookie": cookies, "Accept": "application/json, */*", "X-Requested-With": "XMLHttpRequest", "Referer": `${VOWINT_BASE}/en/VisaApplication/IndexByUserId` },
        signal: AbortSignal.timeout(10_000),
      }).then(r => { cookies = mergeCookies(cookies, r); return r.text(); }).catch(() => {});

      // GET MyList (DataTables AJAX)
      const dtUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&columns%5B0%5D%5Bdata%5D=VOWId&columns%5B0%5D%5Bname%5D=VOWUniqueId&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B1%5D%5Bdata%5D=FName&columns%5B1%5D%5Bname%5D=FirstName&columns%5B1%5D%5Bsearchable%5D=true&columns%5B1%5D%5Borderable%5D=true&columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B2%5D%5Bdata%5D=LName&columns%5B2%5D%5Bname%5D=LastName&columns%5B2%5D%5Bsearchable%5D=true&columns%5B2%5D%5Borderable%5D=true&columns%5B2%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B2%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B3%5D%5Bdata%5D=St&columns%5B3%5D%5Bname%5D=Status&columns%5B3%5D%5Bsearchable%5D=true&columns%5B3%5D%5Borderable%5D=true&columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B3%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=asc&start=0&length=10&search%5Bvalue%5D=&search%5Bregex%5D=false`;
      const listRes = await fetch(dtUrl, {
        method: "GET",
        headers: { "User-Agent": ua, "Cookie": cookies, "Accept": "application/json, */*", "X-Requested-With": "XMLHttpRequest", "Referer": `${VOWINT_BASE}/en/VisaApplication/IndexByUserId` },
        signal: AbortSignal.timeout(15_000),
      });
      if (listRes.ok) {
        const text = await listRes.text();
        try {
          const data = JSON.parse(text) as { data?: Array<{ Id?: string; VOWId?: string }> };
          const first = data.data?.find(d => d.Id || d.VOWId);
          if (first) appId = first.Id ?? first.VOWId ?? null;
        } catch {
          const m = text.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i);
          if (m) appId = m[0];
        }
      }
    }
  }

  if (!appId) {
    botLog({ applicationId: clientId, step: "cev_http_no_app_id", status: "fail" });
    return { success: false, error: "NO_APP_ID" };
  }

  botLog({ applicationId: clientId, step: "cev_http_app_id_found", status: "ok", data: { appId, source: "login" } });

  // Stocker dans le cache
  vowintSessionCache.set(vowintEmail, { cookies, appId, ua, lastUsedAt: Date.now() });

  return { success: true, cookies, appId, ua };
}

/** Invalide le cache VOWINT (appelé quand on détecte une session expirée) */
export function invalidateVowintCache(vowintEmail: string): void {
  vowintSessionCache.delete(vowintEmail);
}

/**
 * Setup complet d'une session CEV en HTTP pur.
 */
export async function setupCevSessionHttp(
  vowintEmail: string,
  vowintPassword: string,
  _applicationId: string,
  clientId: string,
  vowintAppUrl?: string,
): Promise<CevHttpSetupResult> {
  try {
    botLog({ applicationId: clientId, step: "cev_http_setup_start", status: "ok" });

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 1 : Obtenir session VOWINT (login ou cache)
    // ══════════════════════════════════════════════════════════════════════════
    const vowintSession = await getVowintSession(vowintEmail, vowintPassword, clientId, vowintAppUrl);
    if (!vowintSession.success) {
      return { success: false, error: vowintSession.error };
    }

    const { cookies: postLoginCookies, appId: vowintAppId, ua } = vowintSession;

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 2 : GET /Common/GetEAppointmentUrl → URL d'intégration CEV
    //           (= 1 clic VOWINT comptabilisé, limite 5/heure)
    // ══════════════════════════════════════════════════════════════════════════

    // Appeler GetEAppointmentUrl avec l'appId
    const eAppointmentUrl = `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${vowintAppId}`;
    let integrationUrl: string | null = null;

    if (eAppointmentUrl.includes("GetEAppointmentUrl")) {
      const eRes = await fetch(eAppointmentUrl, {
        method: "GET",
        headers: {
          "User-Agent": ua,
          "Cookie": postLoginCookies,
          "Accept": "application/json, text/html, */*",
          "X-Requested-With": "XMLHttpRequest",
          "If-Modified-Since": "0",
          "Referer": `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });

      if (eRes.ok) {
        const eText = await eRes.text();
        // La réponse peut être :
        //  - JSON : {"url": "https://appointment.cloud.diplomatie.be/Integration/VOW/..."}
        //  - Texte brut : "https://appointment.cloud.diplomatie.be/Integration/VOW/..."
        //  - JSON string : "\"https://appointment.cloud.diplomatie.be/Integration/VOW/...\""
        try {
          const eData = JSON.parse(eText) as { url?: string } | string;
          if (typeof eData === "string" && eData.includes("/Integration/VOW/")) {
            integrationUrl = eData;
          } else if (typeof eData === "object" && eData?.url) {
            integrationUrl = eData.url;
          }
        } catch {
          // Pas du JSON — vérifier si c'est une URL brute
          if (eText.includes("/Integration/VOW/")) {
            integrationUrl = eText.trim().replace(/^"|"$/g, "");
          }
        }
      }

      // Fallback: check redirect location
      if (!integrationUrl && eRes.status >= 300 && eRes.status < 400) {
        const loc = eRes.headers.get("location");
        if (loc?.includes("/Integration/VOW/")) {
          integrationUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
        }
      }
    } else {
      // URL directe fournie — l'utiliser telle quelle
      integrationUrl = eAppointmentUrl;
    }

    if (!integrationUrl) {
      // Si GetEAppointmentUrl a échoué, la session VOWINT est peut-être expirée → invalider le cache
      invalidateVowintCache(vowintEmail);
      botLog({ applicationId: clientId, step: "cev_http_no_integration_url", status: "fail" });
      return { success: false, error: "NO_INTEGRATION_URL" };
    }

    botLog({ applicationId: clientId, step: "cev_http_integration_url", status: "ok", data: { url: integrationUrl.slice(0, 100) } });

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 4 : GET integrationUrl → cookie ASP.NET_SessionId CEV
    // ══════════════════════════════════════════════════════════════════════════
    const cevRes = await fetch(integrationUrl, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Referer": `${VOWINT_BASE}/`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    let cevSessionCookie: string | null = null;
    const cevSetCookies = cevRes.headers.getSetCookie?.() ?? [];
    for (const c of cevSetCookies) {
      const m = c.match(/ASP\.NET_SessionId=([^;]+)/);
      if (m) { cevSessionCookie = m[1]; break; }
    }
    // Fallback raw header
    if (!cevSessionCookie) {
      const raw = cevRes.headers.get("set-cookie") ?? "";
      const m = raw.match(/ASP\.NET_SessionId=([^;]+)/);
      if (m) cevSessionCookie = m[1];
    }

    if (!cevSessionCookie) {
      botLog({ applicationId: clientId, step: "cev_http_no_cev_cookie", status: "fail", data: { status: cevRes.status } });
      return { success: false, error: "NO_CEV_SESSION_COOKIE" };
    }

    // Stocker uniquement la VALEUR du cookie (cohérent avec le Playwright setup)
    // Le polling reconstruit le header complet "ASP.NET_SessionId=xxx; PreferredCulture=en-US"
    const fullCevCookie = `ASP.NET_SessionId=${cevSessionCookie}; PreferredCulture=en-US`;
    botLog({ applicationId: clientId, step: "cev_http_cev_cookie_ok", status: "ok", data: { cookieLen: cevSessionCookie.length } });

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 5 : Résoudre hCaptcha
    // ══════════════════════════════════════════════════════════════════════════
    const hcaptchaToken = await solveHcaptcha(clientId);
    if (!hcaptchaToken) {
      return { success: false, error: "HCAPTCHA_FAILED" };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 6 : POST /Captcha/SetCaptchaToken → validUntil
    // ══════════════════════════════════════════════════════════════════════════
    const captchaRes = await fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": fullCevCookie,
        "User-Agent": ua,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${CEV_BASE}/Captcha`,
        "Origin": CEV_BASE,
        "Accept": "application/json, text/javascript, */*; q=0.01",
      },
      body: new URLSearchParams({ captcha: hcaptchaToken }).toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!captchaRes.ok) {
      botLog({ applicationId: clientId, step: "cev_http_captcha_submit_failed", status: "fail", data: { status: captchaRes.status } });
      return { success: false, error: `CAPTCHA_SUBMIT_${captchaRes.status}` };
    }

    const captchaData = await captchaRes.json() as { validUntil?: string; redirectUrl?: string };
    if (!captchaData.validUntil) {
      return { success: false, error: "CAPTCHA_NO_VALID_UNTIL" };
    }

    // Le serveur renvoie validUntil sans suffixe 'Z', donc on doit l'ajouter
    // pour que JavaScript l'interprète correctement comme UTC
    const validUntilStr = captchaData.validUntil.endsWith('Z') 
      ? captchaData.validUntil 
      : captchaData.validUntil + 'Z';
    const validUntilMs = new Date(validUntilStr).getTime();

    // Analyser le redirectUrl pour déterminer si des créneaux sont disponibles.
    // La capture réseau montre :
    //   - redirectUrl = "/Integration/VOW/{guid1}/{guid2}" → le serveur va rediriger vers SelectSlot ou NoAvailability
    //   - Si on suit : integrationUrl → 302 → SelectSlot → 302 → NoAvailability = session MORTE
    //   - La session CEV est SINGLE-USE : un seul passage dans le flow de redirections la tue.
    //
    // Stratégie : NE PAS suivre les redirections. Utiliser le cookie pour POST /Home/AvailableTimeSlots.
    // Si l'API retourne des slots → booking. Si 302/403 → session morte, refaire un setup.
    const captchaRedirectUrl = captchaData.redirectUrl ?? "";
    const slotsAvailable = captchaRedirectUrl.toLowerCase().includes("selectslot");

    botLog({
      applicationId: clientId,
      step: "cev_http_setup_complete",
      status: "ok",
      data: {
        validUntil: captchaData.validUntil,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable,
        integrationUrl: integrationUrl.slice(0, 80),
      },
    });

    return {
      success: true,
      sessionCookie: cevSessionCookie,  // Valeur brute (sans "ASP.NET_SessionId=")
      validUntilMs,
      integrationUrl,
      redirectUrl: captchaRedirectUrl || undefined,
      slotsAvailable,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    botLog({ applicationId: clientId, step: "cev_http_setup_error", status: "fail", data: { error: msg } });
    return { success: false, error: msg };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractCookies(res: Response): string | null {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    return setCookies.map(c => c.split(";")[0]).join("; ");
  }
  // Fallback: raw header
  const raw = res.headers.get("set-cookie");
  if (raw) {
    return raw.split(",").map(c => c.split(";")[0].trim()).join("; ");
  }
  return null;
}

function mergeCookies(existing: string, res: Response): string {
  const newCookies = extractCookies(res);
  if (!newCookies) return existing;

  // Parse existing into map
  const map = new Map<string, string>();
  existing.split(";").forEach(c => {
    const [k, v] = c.trim().split("=");
    if (k && v) map.set(k, v);
  });

  // Override with new
  newCookies.split(";").forEach(c => {
    const [k, v] = c.trim().split("=");
    if (k && v) map.set(k, v);
  });

  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function solveHcaptcha(clientId: string): Promise<string | null> {
  const pageUrl = `${CEV_BASE}/Captcha`;

  // Priorité 1 : Anti-Captcha
  if (ANTICAPTCHA_KEY) {
    botLog({ applicationId: clientId, step: "cev_http_hcaptcha_start", status: "ok", data: { service: "anticaptcha" } });
    try {
      const createRes = await fetch("https://api.anti-captcha.com/createTask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: ANTICAPTCHA_KEY,
          task: { type: "HCaptchaTaskProxyless", websiteURL: pageUrl, websiteKey: HCAPTCHA_SITEKEY },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const createData = await createRes.json() as { errorId: number; taskId?: number };
      if (createData.errorId === 0 && createData.taskId) {
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const pollRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId: createData.taskId }),
          });
          const pollData = await pollRes.json() as { errorId: number; status: string; solution?: { gRecaptchaResponse?: string; token?: string } };
          if (pollData.status === "ready") {
            const token = pollData.solution?.gRecaptchaResponse ?? pollData.solution?.token ?? null;
            if (token) {
              botLog({ applicationId: clientId, step: "cev_http_hcaptcha_solved", status: "ok", data: { service: "anticaptcha", seconds: (i + 1) * 5 } });
              return token;
            }
            break;
          }
          if (pollData.errorId !== 0) break;
        }
      }
    } catch { /* fallback */ }
  }

  // Priorité 2 : CapSolver
  if (CAPSOLVER_KEY) {
    botLog({ applicationId: clientId, step: "cev_http_hcaptcha_start", status: "ok", data: { service: "capsolver" } });
    try {
      const createRes = await fetch("https://api.capsolver.com/createTask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: CAPSOLVER_KEY,
          task: { type: "HCaptchaTaskProxyless", websiteURL: pageUrl, websiteKey: HCAPTCHA_SITEKEY },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const createData = await createRes.json() as { errorId: number; taskId?: string };
      if (createData.errorId === 0 && createData.taskId) {
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const pollRes = await fetch("https://api.capsolver.com/getTaskResult", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: createData.taskId }),
          });
          const pollData = await pollRes.json() as { errorId: number; status: string; solution?: { token?: string } };
          if (pollData.status === "ready" && pollData.solution?.token) {
            botLog({ applicationId: clientId, step: "cev_http_hcaptcha_solved", status: "ok", data: { service: "capsolver", seconds: (i + 1) * 3 } });
            return pollData.solution.token;
          }
          if (pollData.errorId !== 0) break;
        }
      }
    } catch { /* failed */ }
  }

  botLog({ applicationId: clientId, step: "cev_http_hcaptcha_failed", status: "fail" });
  return null;
}
