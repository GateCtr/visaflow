/**
 * cevHttpSetup.ts — Setup CEV session en HTTP pur (sans Playwright)
 *
 * Flux complet :
 *   1. Login VOWINT (ou réutiliser session existante)
 *   2. GET /Common/GetEAppointmentUrl?id={appId} → URL d'intégration CEV (= 1 clic VOWINT)
 *   3. GET {integrationUrl} → cookie ASP.NET_SessionId CEV
 *   4. Résoudre hCaptcha via Anti-Captcha
 *   5. POST /Captcha/SetCaptchaToken → validUntil + redirectUrl
 *   6. GET redirectUrl (follow redirects) → /Integration/VOW/SelectSlot → VERDICT FINAL
 *      → 200 calendrier = session activée, polling possible
 *      → 302 → NoAvailability = pas de créneaux
 *
 * Optimisation : les cookies VOWINT sont persistés en mémoire entre les checks.
 * On ne re-login que si la session VOWINT a expiré (401/302 vers login).
 * Seul le GetEAppointmentUrl compte comme "clic" (limite 5/heure).
 *
 * Coût : 1 hCaptcha (~$0.003) par check, ZERO Playwright
 */

import { botLog } from "./convexClient.js";
import { randomUserAgent } from "./browser.js";
import { Impit } from "impit";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY?.trim() ?? "";
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY?.trim() ?? "";

// ─── Impit avec fingerprint TLS Chrome (même pattern que le bot USA) ───────────
// Garantit que les requêtes HTTP sont indistinguables d'un vrai Chrome (JA3/JA4).
const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL;

let _setupImpit: InstanceType<typeof Impit> | undefined;
function getSetupImpit(): InstanceType<typeof Impit> {
  if (!_setupImpit) {
    const opts: Record<string, unknown> = { browser: "chrome", ignoreTlsErrors: true };
    if (IPROYAL_PROXY_URL) opts.proxyUrl = IPROYAL_PROXY_URL;
    _setupImpit = new Impit(opts as any);
  }
  return _setupImpit;
}

/** Fetch CEV avec fingerprint TLS Chrome via impit.
 *  Fallback sans proxy si le proxy échoue (proxy down). */
async function cevSetupFetch(url: string, options: RequestInit): Promise<Response> {
  try {
    return await getSetupImpit().fetch(url, options as any) as unknown as Response;
  } catch (err) {
    if (IPROYAL_PROXY_URL) {
      console.log(`[CEV-SETUP] ⚠️ impit+proxy failed → fallback impit direct pour ${url.slice(0, 80)}`);
      const directImpit = new Impit({ browser: "chrome", ignoreTlsErrors: true } as any);
      return directImpit.fetch(url, options as any) as unknown as Response;
    }
    throw err;
  }
}

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
  redirectUrl?: string;       // URL retournée par SetCaptchaToken
  slotsAvailable?: boolean;   // true si la page calendrier (SelectSlot) a été atteinte → polling OK
  needsPlaywrightNavigation?: boolean; // DEPRECATED: toujours false — le redirect est suivi en HTTP maintenant
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
    signal: AbortSignal.timeout(30_000),
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
    signal: AbortSignal.timeout(30_000),
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
      signal: AbortSignal.timeout(20_000),
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
      signal: AbortSignal.timeout(30_000),
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
        signal: AbortSignal.timeout(20_000),
      }).then(r => { cookies = mergeCookies(cookies, r); return r.text(); }).catch(() => {});

      // GET MyList (DataTables AJAX)
      const dtUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&columns%5B0%5D%5Bdata%5D=VOWId&columns%5B0%5D%5Bname%5D=VOWUniqueId&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B1%5D%5Bdata%5D=FName&columns%5B1%5D%5Bname%5D=FirstName&columns%5B1%5D%5Bsearchable%5D=true&columns%5B1%5D%5Borderable%5D=true&columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B2%5D%5Bdata%5D=LName&columns%5B2%5D%5Bname%5D=LastName&columns%5B2%5D%5Bsearchable%5D=true&columns%5B2%5D%5Borderable%5D=true&columns%5B2%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B2%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B3%5D%5Bdata%5D=St&columns%5B3%5D%5Bname%5D=Status&columns%5B3%5D%5Bsearchable%5D=true&columns%5B3%5D%5Borderable%5D=true&columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B3%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=asc&start=0&length=10&search%5Bvalue%5D=&search%5Bregex%5D=false`;
      const listRes = await fetch(dtUrl, {
        method: "GET",
        headers: { "User-Agent": ua, "Cookie": cookies, "Accept": "application/json, */*", "X-Requested-With": "XMLHttpRequest", "Referer": `${VOWINT_BASE}/en/VisaApplication/IndexByUserId` },
        signal: AbortSignal.timeout(30_000),
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
        signal: AbortSignal.timeout(30_000),
      });

      if (eRes.ok) {
        const eText = await eRes.text();

        // ── Détection rate-limit VOWINT dans la réponse GetEAppointmentUrl ──
        // Quand les 5 clics/heure sont épuisés, VOWINT peut retourner :
        //   - Un HTML/texte contenant des messages d'erreur au lieu de l'URL
        //   - Un JSON avec un champ erreur type "ErrorTooManyAttempts"
        const rateLimitPatterns = [
          /5\s*fois/i, /5\s*times/i, /bloqu[ée]\s*pendant/i, /blocked\s*for/i,
          /too\s*many\s*attempts/i, /ErrorTooManyAttempts/i, /rate.?limit/i,
          /maximum.*tentatives/i, /maximum.*attempts/i,
          /veuillez\s*r[ée]essayer/i, /please\s*try\s*again\s*later/i,
        ];
        const isRateLimited = rateLimitPatterns.some(p => p.test(eText));
        if (isRateLimited) {
          invalidateVowintCache(vowintEmail);
          botLog({ applicationId: clientId, step: "cev_http_rate_limit_detected", status: "warn", data: { responsePreview: eText.slice(0, 300) } });
          return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS" };
        }

        // La réponse peut être :
        //  - JSON : {"url": "https://appointment.cloud.diplomatie.be/Integration/VOW/..."}
        //  - Texte brut : "https://appointment.cloud.diplomatie.be/Integration/VOW/..."
        //  - JSON string : "\"https://appointment.cloud.diplomatie.be/Integration/VOW/...\""
        try {
          const eData = JSON.parse(eText) as { url?: string; error?: string } | string;
          // Vérifier aussi un éventuel champ "error" dans le JSON
          if (typeof eData === "object" && eData?.error) {
            const errStr = eData.error;
            if (rateLimitPatterns.some(p => p.test(errStr))) {
              invalidateVowintCache(vowintEmail);
              botLog({ applicationId: clientId, step: "cev_http_rate_limit_json", status: "warn", data: { error: errStr } });
              return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS" };
            }
          }
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
      } else if (eRes.status === 429) {
        // HTTP 429 explicite = rate-limit
        invalidateVowintCache(vowintEmail);
        botLog({ applicationId: clientId, step: "cev_http_rate_limit_429", status: "warn", data: { status: eRes.status } });
        return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS" };
      }

      // Fallback: check redirect location
      if (!integrationUrl && eRes.status >= 300 && eRes.status < 400) {
        const loc = eRes.headers.get("location");
        if (loc?.includes("/Integration/VOW/")) {
          integrationUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
        }
        // Vérifier si la redirection pointe vers une page d'erreur/login (= session expirée ou rate-limit)
        if (!integrationUrl && loc) {
          const locLower = loc.toLowerCase();
          if (locLower.includes("error") || locLower.includes("login") || locLower.includes("account")) {
            invalidateVowintCache(vowintEmail);
            botLog({ applicationId: clientId, step: "cev_http_redirect_error", status: "warn", data: { redirectTo: loc } });
            // Possiblement un rate-limit déguisé en redirection vers erreur
            return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS_REDIRECT" };
          }
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
    const cevRes = await cevSetupFetch(integrationUrl, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Referer": `${VOWINT_BASE}/`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
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
    const captchaRes = await cevSetupFetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
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
      signal: AbortSignal.timeout(30_000),
    });

    if (!captchaRes.ok) {
      botLog({ applicationId: clientId, step: "cev_http_captcha_submit_failed", status: "fail", data: { status: captchaRes.status } });
      return { success: false, error: `CAPTCHA_SUBMIT_${captchaRes.status}` };
    }

    const captchaData = await captchaRes.json() as { validUntil?: string; redirectUrl?: string };
    
    // DEBUG: Loguer la réponse brute pour comprendre le format du validUntil
    botLog({
      applicationId: clientId,
      step: "cev_http_captcha_response",
      status: "ok",
      data: {
        validUntilRaw: captchaData.validUntil,
        redirectUrlRaw: captchaData.redirectUrl,
        now: new Date().toISOString(),
        nowLocal: new Date().toString(),
      },
    });
    
    if (!captchaData.validUntil) {
      return { success: false, error: "CAPTCHA_NO_VALID_UNTIL" };
    }

    // validUntil parsing
    const validUntilStr = captchaData.validUntil.endsWith('Z') 
      ? captchaData.validUntil 
      : captchaData.validUntil + 'Z';
    const validUntilMs = new Date(validUntilStr).getTime();

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 7 : Suivre redirectUrl pour ACTIVER la session et obtenir le VRAI verdict
    // ══════════════════════════════════════════════════════════════════════════
    // SetCaptchaToken retourne TOUJOURS une redirectUrl du type :
    //   /Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}
    // La page finale est déterminée APRÈS navigation :
    //   → GET redirectUrl → 302 → /Integration/VOW/SelectSlot
    //     → 302 → /Integration/Error/NoAvailability   (pas de créneaux)
    //     → 200  page calendrier                      (créneaux dispo → session activée pour polling)
    // On suit les redirections via fetch(redirect: 'follow') pour obtenir le verdict final.
    // Cela ACTIVE aussi la session côté serveur — après ça, POST /Home/AvailableTimeSlots fonctionne.
    const captchaRedirectUrl = captchaData.redirectUrl ?? "";

    if (!captchaRedirectUrl) {
      botLog({ applicationId: clientId, step: "cev_http_no_redirect_url", status: "fail" });
      return { success: false, error: "CAPTCHA_NO_REDIRECT_URL" };
    }

    // Construire l'URL absolue si relative
    const fullRedirectUrl = captchaRedirectUrl.startsWith("http")
      ? captchaRedirectUrl
      : `${CEV_BASE}${captchaRedirectUrl}`;

    let finalUrl = fullRedirectUrl;
    let probeBodyRaw = "";
    let probeBodyPreview = "";
    let probeHttpStatus = 0;

    try {
      const probe = await cevSetupFetch(fullRedirectUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "Cookie": fullCevCookie,
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7",
          "Referer": `${CEV_BASE}/Captcha`,
        },
        signal: AbortSignal.timeout(30_000),
      });
      finalUrl = probe.url; // URL après tous les 302
      probeHttpStatus = probe.status;

      // Capturer le body pour diagnostiquer
      try { probeBodyRaw = await probe.text(); } catch { /* ignore */ }
      // Extraire le texte visible (sans scripts/styles/tags)
      probeBodyPreview = probeBodyRaw
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);

      botLog({
        applicationId: clientId,
        step: "cev_http_redirect_probe",
        status: "ok",
        data: { httpStatus: probeHttpStatus, finalUrl, bodyPreview: probeBodyPreview || "(vide)" },
      });
    } catch (probeErr) {
      const errMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
      botLog({
        applicationId: clientId,
        step: "cev_http_redirect_probe_error",
        status: "warn",
        data: { error: errMsg },
      });
      // En cas d'échec réseau, retourner la session brute — le polling déterminera l'état
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        needsPlaywrightNavigation: false,
      };
    }

    // ── Classifier le verdict final ──────────────────────────────────────────

    // Cas 1 : NoAvailability — pas de créneaux, mais session correctement établie
    if (finalUrl.includes("NoAvailability")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_no_availability",
        status: "ok",
        data: { finalUrl, bodyPreview: probeBodyPreview.slice(0, 300) },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        needsPlaywrightNavigation: false,
      };
    }

    // Cas 2 : Session expirée / re-captcha demandé
    if (finalUrl.includes("SessionExpired") || finalUrl.includes("/Captcha")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_session_expired",
        status: "warn",
        data: { finalUrl, bodyPreview: probeBodyPreview.slice(0, 300) },
      });
      return { success: false, error: "SESSION_EXPIRED_AFTER_REDIRECT" };
    }

    // Cas 3 : Page d'erreur générique CEV (/Error/Default, /Error/*)
    if (finalUrl.includes("/Error/")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_error_page",
        status: "warn",
        data: { finalUrl, bodyPreview: probeBodyPreview.slice(0, 300) },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        needsPlaywrightNavigation: false,
      };
    }

    // Cas 4 : Page calendrier / SelectSlot → SESSION ACTIVÉE, slots potentiellement disponibles
    // Vérifier les marqueurs positifs dans le body pour confirmer
    const bodyLower = probeBodyRaw.toLowerCase();
    const hasCalendarMarkers = (
      bodyLower.includes("getavailabletimeslotsforpublic") ||
      bodyLower.includes("home/availabletimeslots") ||
      bodyLower.includes("selectslot") ||
      bodyLower.includes("data-slot-time") ||
      bodyLower.includes("calendar")
    );

    if (finalUrl.includes("SelectSlot") || hasCalendarMarkers) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_slots_available",
        status: "ok",
        data: {
          finalUrl,
          hasCalendarMarkers,
          validUntil: captchaData.validUntil,
          bodyPreview: probeBodyPreview.slice(0, 500),
          htmlRaw: probeBodyRaw.slice(0, 4000),
        },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: true,
        needsPlaywrightNavigation: false,
      };
    }

    // Cas 5 : URL inconnue — loguer et retourner la session pour polling
    botLog({
      applicationId: clientId,
      step: "cev_http_verdict_unknown",
      status: "warn",
      data: {
        finalUrl,
        httpStatus: probeHttpStatus,
        bodyPreview: probeBodyPreview.slice(0, 500),
        htmlRaw: probeBodyRaw.slice(0, 4000),
      },
    });
    return {
      success: true,
      sessionCookie: cevSessionCookie,
      validUntilMs,
      integrationUrl,
      redirectUrl: captchaRedirectUrl,
      slotsAvailable: false,
      needsPlaywrightNavigation: false,
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
        signal: AbortSignal.timeout(30_000),
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
        signal: AbortSignal.timeout(30_000),
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
