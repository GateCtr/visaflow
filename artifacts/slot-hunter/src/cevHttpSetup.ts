/**
 * cevHttpSetup.ts — Setup CEV session en HTTP pur (sans Playwright)
 *
 * Flux complet :
 *   1. GET visaonweb.diplomatie.be → extraire __RequestVerificationToken + cookie
 *   2. POST /en/Account/Login → authentification → cookie session VOWINT
 *   3. GET /Common/GetEAppointmentUrl?id={appId} → URL d'intégration CEV
 *   4. GET {integrationUrl} → cookie ASP.NET_SessionId CEV
 *   5. Résoudre hCaptcha via Anti-Captcha
 *   6. POST /Captcha/SetCaptchaToken → validUntil + redirectUrl
 *
 * Avantages vs Playwright :
 *   - ~5s au lieu de ~30s
 *   - Pas de Chromium (0 RAM supplémentaire)
 *   - Plus fiable (pas de timeout DOM, pas de proxy Playwright)
 *
 * Coût : 1 hCaptcha (~$0.003) par setup
 */

import { botLog } from "./convexClient.js";
import { randomUserAgent } from "./browser.js";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY?.trim() ?? "";
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY?.trim() ?? "";

export interface CevHttpSetupResult {
  success: boolean;
  sessionCookie?: string;
  validUntilMs?: number;
  integrationUrl?: string;
  error?: string;
}

/**
 * Setup complet d'une session CEV en HTTP pur.
 */
export async function setupCevSessionHttp(
  vowintEmail: string,
  vowintPassword: string,
  applicationId: string,
  clientId: string,
  vowintAppUrl?: string,
): Promise<CevHttpSetupResult> {
  const ua = randomUserAgent();

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 1 : GET page login VOWINT → extraire CSRF token + cookies
    // ══════════════════════════════════════════════════════════════════════════
    botLog({ applicationId: clientId, step: "cev_http_setup_start", status: "ok" });

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

    // Extraire __RequestVerificationToken du HTML
    const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!tokenMatch) {
      return { success: false, error: "CSRF_TOKEN_NOT_FOUND" };
    }
    const csrfToken = tokenMatch[1];

    // Extraire les cookies de la réponse
    const vowintCookies = extractCookies(loginPageRes);
    if (!vowintCookies) {
      return { success: false, error: "VOWINT_COOKIES_NOT_FOUND" };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 2 : POST login VOWINT
    // ══════════════════════════════════════════════════════════════════════════
    const loginBody = new URLSearchParams({
      __RequestVerificationToken: csrfToken,
      UserName: vowintEmail,
      Password: vowintPassword,
    }).toString();

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
      body: loginBody,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    // 302 = succès (redirect vers /), 200 = échec (page login avec erreur)
    if (loginRes.status !== 302) {
      botLog({ applicationId: clientId, step: "cev_http_login_failed", status: "fail", data: { status: loginRes.status } });
      return { success: false, error: "CEV_VOWINT_SESSION_FAILED" };
    }

    // Merger les cookies de login avec les cookies existants
    const postLoginCookies = mergeCookies(vowintCookies, loginRes);

    botLog({ applicationId: clientId, step: "cev_http_login_ok", status: "ok" });

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 3 : GET /Common/GetEAppointmentUrl → URL d'intégration CEV
    // ══════════════════════════════════════════════════════════════════════════
    const appUrl = vowintAppUrl ?? `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${applicationId}`;
    const eAppointmentUrl = appUrl.startsWith("http") ? appUrl : `${VOWINT_BASE}${appUrl}`;

    // Si c'est déjà une URL GetEAppointmentUrl, l'appeler directement
    let integrationUrl: string | null = null;

    if (eAppointmentUrl.includes("GetEAppointmentUrl")) {
      const eRes = await fetch(eAppointmentUrl, {
        method: "GET",
        headers: {
          "User-Agent": ua,
          "Cookie": postLoginCookies,
          "Accept": "application/json, text/html, */*",
          "Referer": `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });

      if (eRes.ok) {
        const eData = await eRes.json().catch(() => null) as { url?: string } | null;
        if (eData?.url) {
          integrationUrl = eData.url;
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
      integrationUrl = eAppointmentUrl;
    }

    if (!integrationUrl) {
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

    const fullCevCookie = `ASP.NET_SessionId=${cevSessionCookie}; PreferredCulture=en-US`;
    botLog({ applicationId: clientId, step: "cev_http_cev_cookie_ok", status: "ok", data: { cookieLen: fullCevCookie.length } });

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

    const validUntilMs = new Date(captchaData.validUntil).getTime();

    botLog({
      applicationId: clientId,
      step: "cev_http_setup_complete",
      status: "ok",
      data: { validUntil: captchaData.validUntil, integrationUrl: integrationUrl.slice(0, 80) },
    });

    return {
      success: true,
      sessionCookie: fullCevCookie,
      validUntilMs,
      integrationUrl,
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

  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
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
