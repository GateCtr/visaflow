/**
 * cev-capture-compare.ts — Capture & Compare: Real Browser vs HTTP-only flow
 *
 * OBJECTIF :
 *   Identifier POURQUOI le serveur retourne toujours NoAvailability à notre bot HTTP
 *   alors que des humains (et d'autres bots) voient des slots disponibles.
 *
 * MÉTHODE :
 *   1. Faire le flow CEV ENTIER via Playwright (vrai Chrome headless stealth)
 *      → Login VOWINT → clic RDV → page /Captcha → widget hCaptcha se charge →
 *        résoudre captcha → le BROWSER soumet SetCaptchaToken (pas notre fetch)
 *   2. Intercepter la requête POST SetCaptchaToken DEPUIS LE BROWSER
 *      → Capturer TOUS les cookies, headers, body envoyés par le vrai navigateur
 *   3. Comparer avec ce que notre flow HTTP (cevHttpSetup.ts) envoie
 *   4. Logger les DIVERGENCES dans botLog (visible dans Convex dashboard)
 *
 * ACTIVATION :
 *   bot-config Convex: cev_capture_mode = "1"
 *   → Le dossier-loop exécutera UNE capture puis reviendra en mode normal
 *
 * RÉSULTAT ATTENDU :
 *   Si le browser envoie des cookies supplémentaires (ex: hCaptcha widget cookies)
 *   que notre HTTP pur n'envoie pas → c'est la cause du NoAvailability systématique.
 */

import { launchBrowser, randomDelay } from "./browser.js";
import { botLog } from "./convexClient.js";
import { getCevBrowserHeaders, getCevSessionUa } from "./cev-shared-impit.js";
import type { BrowserContext, Page, Request as PwRequest } from "playwright";

const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY?.trim() ?? "";
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY?.trim() ?? "";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CaptureResult {
  success: boolean;
  /** Cookies envoyés par le VRAI browser dans POST SetCaptchaToken */
  browserCookies: Record<string, string>;
  /** Headers envoyés par le VRAI browser */
  browserHeaders: Record<string, string>;
  /** Body envoyé par le browser */
  browserBody: string;
  /** Cookies que notre HTTP pur enverrait */
  httpOnlyCookies: Record<string, string>;
  /** Headers que notre HTTP pur enverrait */
  httpOnlyHeaders: Record<string, string>;
  /** Divergences détectées */
  divergences: string[];
  /** Réponse du serveur au POST SetCaptchaToken du browser */
  serverResponse: { status: number; body: string; redirectUrl?: string } | null;
  /** URL finale après redirect (NoAvailability ou SelectSlot) */
  finalVerdict: string;
  /** Erreur si échec */
  error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseCookieHeader(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  cookieHeader.split(";").forEach((pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (key) result[key.trim()] = rest.join("=").trim();
  });
  return result;
}

async function resolveHcaptchaToken(clientId: string): Promise<string | null> {
  const pageUrl = `${CEV_BASE}/Captcha`;

  // Anti-Captcha (prioritaire)
  if (ANTICAPTCHA_KEY) {
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
      const createData = (await createRes.json()) as { errorId: number; taskId?: number };
      if (createData.errorId === 0 && createData.taskId) {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const pollRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId: createData.taskId }),
          });
          const pollData = (await pollRes.json()) as {
            errorId: number;
            status: string;
            solution?: { gRecaptchaResponse?: string; token?: string };
          };
          if (pollData.status === "ready") {
            return pollData.solution?.gRecaptchaResponse ?? pollData.solution?.token ?? null;
          }
          if (pollData.errorId !== 0) break;
        }
      }
    } catch { /* fallback */ }
  }

  // CapSolver (fallback)
  if (CAPSOLVER_KEY) {
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
      const createData = (await createRes.json()) as { errorId: number; taskId?: string };
      if (createData.errorId === 0 && createData.taskId) {
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const pollRes = await fetch("https://api.capsolver.com/getTaskResult", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: createData.taskId }),
          });
          const pollData = (await pollRes.json()) as { errorId: number; status: string; solution?: { token?: string } };
          if (pollData.status === "ready" && pollData.solution?.token) {
            return pollData.solution.token;
          }
          if (pollData.errorId !== 0) break;
        }
      }
    } catch { /* failed */ }
  }

  return null;
}

// ─── Core: Capture Complète via Playwright ──────────────────────────────────

/**
 * Exécute le flow CEV complet via Playwright (comme un humain) et capture
 * EXACTEMENT ce que le browser envoie dans le POST SetCaptchaToken.
 *
 * Compare ensuite avec ce que notre flow HTTP pur enverrait.
 */
export async function runCevCaptureCompare(
  vowintEmail: string,
  vowintPassword: string,
  clientId: string,
  vowintAppUrl?: string,
): Promise<CaptureResult> {
  const result: CaptureResult = {
    success: false,
    browserCookies: {},
    browserHeaders: {},
    browserBody: "",
    httpOnlyCookies: {},
    httpOnlyHeaders: {},
    divergences: [],
    serverResponse: null,
    finalVerdict: "unknown",
  };

  let browser: any = null;

  try {
    botLog({ applicationId: clientId, step: "cev_capture_compare_start", status: "ok" });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1 : Lancer un vrai Chrome stealth
    // ══════════════════════════════════════════════════════════════════════════
    const launched = await launchBrowser({
      locale: "fr-BE",
      timezoneId: "Africa/Kinshasa",
      proxySource: "soax",  // Même proxy que le dossier-loop
    });
    browser = launched.browser;
    const context = launched.context;
    const page = launched.page;

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2 : Login VOWINT (comme un humain)
    // ══════════════════════════════════════════════════════════════════════════
    console.log("[CEV-CAPTURE] Phase 2: Login VOWINT...");
    await page.goto(`${VOWINT_BASE}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await randomDelay(1000, 2000);

    // Remplir le formulaire de login
    await page.fill('input[name="UserName"]', vowintEmail);
    await page.fill('input[name="Password"]', vowintPassword);
    await randomDelay(500, 1000);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ timeout: 30_000 }).catch(() => {});
    await randomDelay(1000, 2000);

    const postLoginUrl = page.url();
    console.log(`[CEV-CAPTURE] Post-login URL: ${postLoginUrl}`);

    if (postLoginUrl.includes("Login")) {
      result.error = "VOWINT_LOGIN_FAILED";
      botLog({ applicationId: clientId, step: "cev_capture_login_failed", status: "fail", data: { url: postLoginUrl } });
      await browser.close();
      return result;
    }

    botLog({ applicationId: clientId, step: "cev_capture_login_ok", status: "ok" });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 3 : Naviguer vers MyList et cliquer sur "Prendre rendez-vous"
    // ══════════════════════════════════════════════════════════════════════════
    console.log("[CEV-CAPTURE] Phase 3: Navigation vers MyList...");
    await page.goto(`${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomDelay(2000, 3000);

    // Chercher le bouton/lien qui déclenche GetEAppointmentUrl (le blob POST)
    // Le bouton contient typiquement un attribut ng-click ou un lien vers GetEAppointmentUrl
    const rdvButtonSelector = 'a[href*="GetEAppointmentUrl"], button[ng-click*="appointment"], a[ng-click*="GetEAppointment"], .btn-appointment, a.btn-primary[target="_blank"]';

    // Attendre que le DataTable charge
    await page.waitForSelector("table", { timeout: 15_000 }).catch(() => {});
    await randomDelay(1000, 2000);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 4 : Intercepter la navigation vers appointment.cloud.diplomatie.be/Captcha
    // ══════════════════════════════════════════════════════════════════════════
    // Au lieu de cliquer le bouton (qui ouvre un blob), on navigue directement
    // vers l'URL CEV comme le blob le ferait — mais EN GARDANT le contexte browser complet.

    // Extraire l'AppId depuis la page (comme le fait le code existant)
    const pageHtml = await page.content();
    const appIdMatch = pageHtml.match(/GetEAppointmentUrl\?id=([a-f0-9-]+)/i);
    let appId: string | null = appIdMatch?.[1] ?? null;

    if (!appId && vowintAppUrl) {
      appId = vowintAppUrl.match(/id=([a-f0-9-]+)/i)?.[1] ?? null;
    }

    if (!appId) {
      // Fallback: MyList API
      console.log("[CEV-CAPTURE] AppId non trouvé dans le HTML, tentative MyList...");
      const myListUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&start=0&length=10`;
      const myListResp = await page.evaluate(async (url: string) => {
        const r = await fetch(url, { credentials: "include" });
        return r.text();
      }, myListUrl);
      const idMatch = myListResp.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i);
      if (idMatch) appId = idMatch[0];
    }

    if (!appId) {
      result.error = "NO_APP_ID_FOUND";
      botLog({ applicationId: clientId, step: "cev_capture_no_appid", status: "fail" });
      await browser.close();
      return result;
    }

    console.log(`[CEV-CAPTURE] AppId trouvé: ${appId}`);
    botLog({ applicationId: clientId, step: "cev_capture_appid", status: "ok", data: { appId } });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 5 : Appeler GetEAppointmentUrl DEPUIS LE BROWSER (comme le blob)
    // ══════════════════════════════════════════════════════════════════════════
    console.log("[CEV-CAPTURE] Phase 5: GetEAppointmentUrl via browser fetch...");
    const eAppointmentResult = await page.evaluate(async (params: { url: string }) => {
      const r = await fetch(params.url, {
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      const text = await r.text();
      return { status: r.status, text, url: r.url };
    }, { url: `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${appId}` });

    let integrationUrl: string | null = null;
    try {
      const parsed = JSON.parse(eAppointmentResult.text);
      integrationUrl = typeof parsed === "string" ? parsed : parsed?.url ?? null;
    } catch {
      if (eAppointmentResult.text.includes("/Integration/VOW/")) {
        integrationUrl = eAppointmentResult.text.trim().replace(/^"|"$/g, "");
      }
    }

    if (!integrationUrl) {
      // Check redirect
      if (eAppointmentResult.status >= 300 && eAppointmentResult.status < 400) {
        result.error = `GET_EAPPOINTMENT_REDIRECT_${eAppointmentResult.status}`;
      } else {
        result.error = `GET_EAPPOINTMENT_FAILED: ${eAppointmentResult.text.slice(0, 200)}`;
      }
      botLog({ applicationId: clientId, step: "cev_capture_no_integration_url", status: "fail", data: { response: eAppointmentResult.text.slice(0, 300) } });
      await browser.close();
      return result;
    }

    console.log(`[CEV-CAPTURE] IntegrationUrl: ${integrationUrl.slice(0, 80)}...`);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 6 : Naviguer vers la page /Captcha (le browser pose TOUS les cookies)
    // ══════════════════════════════════════════════════════════════════════════
    console.log("[CEV-CAPTURE] Phase 6: Navigation vers integrationUrl → /Captcha...");

    // Ouvrir un nouvel onglet (comme le blob VOWINT ouvre un popup)
    const cevPage = await context.newPage();
    await cevPage.goto(integrationUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await randomDelay(2000, 4000);

    const captchaPageUrl = cevPage.url();
    console.log(`[CEV-CAPTURE] Page captcha URL: ${captchaPageUrl}`);

    // Vérifier qu'on est bien sur /Captcha
    if (!captchaPageUrl.includes("/Captcha") && !captchaPageUrl.includes("appointment.cloud")) {
      result.error = `UNEXPECTED_PAGE: ${captchaPageUrl}`;
      botLog({ applicationId: clientId, step: "cev_capture_wrong_page", status: "fail", data: { url: captchaPageUrl } });
      await browser.close();
      return result;
    }

    // Laisser le widget hCaptcha charger complètement
    await randomDelay(3000, 5000);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 7 : Capturer TOUS les cookies du browser AVANT SetCaptchaToken
    // ══════════════════════════════════════════════════════════════════════════
    const allCookiesBefore = await context.cookies();
    const cevCookiesBefore = allCookiesBefore.filter(
      (c) => c.domain.includes("appointment.cloud.diplomatie.be")
    );
    const hcaptchaCookies = allCookiesBefore.filter(
      (c) => c.domain.includes("hcaptcha.com")
    );

    botLog({
      applicationId: clientId,
      step: "cev_capture_cookies_before",
      status: "ok",
      data: {
        cevCookieNames: cevCookiesBefore.map((c) => c.name),
        cevCookieCount: cevCookiesBefore.length,
        hcaptchaCookieNames: hcaptchaCookies.map((c) => c.name),
        hcaptchaCookieCount: hcaptchaCookies.length,
        allDomains: [...new Set(allCookiesBefore.map((c) => c.domain))],
        totalCookies: allCookiesBefore.length,
      },
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 8 : Résoudre le hCaptcha
    // ══════════════════════════════════════════════════════════════════════════
    console.log("[CEV-CAPTURE] Phase 8: Résolution hCaptcha...");
    const hcaptchaToken = await resolveHcaptchaToken(clientId);
    if (!hcaptchaToken) {
      result.error = "HCAPTCHA_RESOLUTION_FAILED";
      botLog({ applicationId: clientId, step: "cev_capture_hcaptcha_failed", status: "fail" });
      await browser.close();
      return result;
    }
    console.log(`[CEV-CAPTURE] hCaptcha résolu (token len=${hcaptchaToken.length})`);

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 9 : INJECTER le token ET SOUMETTRE VIA LE BROWSER (successfullCaptcha)
    //           Intercepter la requête POST SetCaptchaToken
    // ══════════════════════════════════════════════════════════════════════════
    console.log("[CEV-CAPTURE] Phase 9: Soumission via successfullCaptcha() dans le browser...");

    // Préparer l'interception de la requête POST SetCaptchaToken
    let capturedRequest: { url: string; headers: Record<string, string>; body: string } | null = null;
    let capturedResponse: { status: number; body: string } | null = null;

    cevPage.on("request", (req: PwRequest) => {
      if (req.url().includes("Captcha/SetCaptchaToken") && req.method() === "POST") {
        const headers: Record<string, string> = {};
        const allHeaders = req.headers();
        for (const [k, v] of Object.entries(allHeaders)) {
          headers[k] = v;
        }
        capturedRequest = {
          url: req.url(),
          headers,
          body: req.postData() ?? "",
        };
        console.log("[CEV-CAPTURE] 🎯 POST SetCaptchaToken intercepté!");
        console.log(`[CEV-CAPTURE]   Cookie header: ${(headers["cookie"] ?? "").slice(0, 200)}...`);
      }
    });

    cevPage.on("response", async (resp) => {
      if (resp.url().includes("Captcha/SetCaptchaToken")) {
        try {
          const body = await resp.text();
          capturedResponse = { status: resp.status(), body };
          console.log(`[CEV-CAPTURE] 🎯 Réponse SetCaptchaToken: HTTP ${resp.status()} body=${body.slice(0, 200)}`);
        } catch { /* ignore */ }
      }
    });

    // Injecter le token et appeler successfullCaptcha() dans le contexte de la page
    // C'est EXACTEMENT ce que le widget hCaptcha fait quand l'utilisateur résout le captcha
    const submitResult = await cevPage.evaluate(async (token: string) => {
      try {
        // Appeler la fonction globale successfullCaptcha (définie dans le bundle sharedScripts)
        if (typeof (window as any).successfullCaptcha === "function") {
          (window as any).successfullCaptcha(token);
          return { method: "successfullCaptcha", ok: true };
        }
        // Fallback: appeler directement SharedAjaxService.setCaptchaToken
        if (typeof (window as any).SharedAjaxService?.setCaptchaToken === "function") {
          return new Promise<{ method: string; ok: boolean; response?: any }>((resolve) => {
            const ajaxUrl = (window as any).ajaxUrl || "https://appointment.cloud.diplomatie.be/";
            (window as any).SharedAjaxService.setCaptchaToken(
              ajaxUrl,
              { captcha: token },
              (resp: any) => resolve({ method: "SharedAjaxService", ok: true, response: resp }),
              (err: any) => resolve({ method: "SharedAjaxService", ok: false, response: err }),
            );
          });
        }
        return { method: "none_found", ok: false };
      } catch (err) {
        return { method: "error", ok: false, response: String(err) };
      }
    }, hcaptchaToken);

    console.log(`[CEV-CAPTURE] submitResult: ${JSON.stringify(submitResult)}`);

    // Attendre que la requête soit interceptée (le browser doit envoyer le POST)
    await new Promise((r) => setTimeout(r, 5000));

    // Attendre la navigation (successfullCaptcha fait location.href = redirectUrl)
    await randomDelay(3000, 5000);
    const finalUrl = cevPage.url();
    result.finalVerdict = finalUrl.includes("NoAvailability")
      ? "NoAvailability"
      : finalUrl.includes("SelectSlot")
        ? "SelectSlot"
        : finalUrl.includes("SessionExpired")
          ? "SessionExpired"
          : finalUrl;

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 10 : Construire la comparaison
    // ══════════════════════════════════════════════════════════════════════════
    if (capturedRequest) {
      result.browserHeaders = capturedRequest.headers;
      result.browserBody = capturedRequest.body;
      result.browserCookies = parseCookieHeader(capturedRequest.headers["cookie"] ?? "");
    }

    if (capturedResponse) {
      result.serverResponse = {
        status: capturedResponse.status,
        body: capturedResponse.body,
      };
      try {
        const parsed = JSON.parse(capturedResponse.body) as { redirectUrl?: string };
        if (parsed.redirectUrl) {
          result.serverResponse.redirectUrl = parsed.redirectUrl;
        }
      } catch { /* not JSON */ }
    }

    // Construire ce que notre HTTP pur enverrait
    const httpCookieString = cevCookiesBefore
      .filter((c) => c.name === "ASP.NET_SessionId" || c.name === "PreferredCulture")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    result.httpOnlyCookies = parseCookieHeader(httpCookieString);
    result.httpOnlyHeaders = getCevBrowserHeaders({
      referer: `${CEV_BASE}/Captcha`,
      origin: CEV_BASE,
      cookie: httpCookieString,
      contentType: "application/x-www-form-urlencoded",
      xRequestedWith: true,
      accept: "application/json, text/javascript, */*; q=0.01",
    });

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 11 : Identifier les DIVERGENCES
    // ══════════════════════════════════════════════════════════════════════════
    const browserCookieNames = Object.keys(result.browserCookies).sort();
    const httpCookieNames = Object.keys(result.httpOnlyCookies).sort();

    // Cookies dans le browser mais PAS dans notre HTTP
    const missingInHttp = browserCookieNames.filter((n) => !httpCookieNames.includes(n));
    if (missingInHttp.length > 0) {
      result.divergences.push(`COOKIES MANQUANTS dans HTTP: ${missingInHttp.join(", ")}`);
    }

    // Cookies dans HTTP mais PAS dans le browser
    const extraInHttp = httpCookieNames.filter((n) => !browserCookieNames.includes(n));
    if (extraInHttp.length > 0) {
      result.divergences.push(`COOKIES EN TROP dans HTTP: ${extraInHttp.join(", ")}`);
    }

    // Headers différents
    const criticalHeaders = ["content-type", "x-requested-with", "referer", "origin", "accept"];
    for (const h of criticalHeaders) {
      const bVal = (result.browserHeaders[h] ?? "").toLowerCase();
      const hVal = (result.httpOnlyHeaders[h.split("-").map((p, i) => i === 0 ? p : p[0].toUpperCase() + p.slice(1)).join("-")] ?? "").toLowerCase();
      if (bVal && hVal && bVal !== hVal) {
        result.divergences.push(`HEADER DIFF [${h}]: browser="${bVal}" vs http="${hVal}"`);
      }
    }

    result.success = capturedRequest !== null;

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 12 : Log FINAL dans Convex
    // ══════════════════════════════════════════════════════════════════════════
    botLog({
      applicationId: clientId,
      step: "cev_capture_compare_result",
      status: result.divergences.length > 0 ? "warn" : "ok",
      data: {
        success: result.success,
        finalVerdict: result.finalVerdict,
        browserCookieCount: browserCookieNames.length,
        browserCookieNames,
        httpCookieCount: httpCookieNames.length,
        httpCookieNames,
        missingInHttp,
        extraInHttp,
        divergences: result.divergences,
        hcaptchaCookiesInBrowser: hcaptchaCookies.map((c) => ({ name: c.name, domain: c.domain })),
        serverResponseStatus: result.serverResponse?.status,
        serverResponseRedirectUrl: result.serverResponse?.redirectUrl,
        submitMethod: submitResult.method,
        submitOk: submitResult.ok,
      },
    });

    console.log("[CEV-CAPTURE] ═══ RÉSULTAT ═══");
    console.log(`  Verdict: ${result.finalVerdict}`);
    console.log(`  Browser cookies: ${browserCookieNames.join(", ")}`);
    console.log(`  HTTP-only cookies: ${httpCookieNames.join(", ")}`);
    console.log(`  Divergences: ${result.divergences.length > 0 ? result.divergences.join(" | ") : "AUCUNE"}`);
    console.log(`  hCaptcha cookies in browser: ${hcaptchaCookies.map((c) => c.name).join(", ") || "AUCUN"}`);

    await browser.close();
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = msg;
    botLog({ applicationId: clientId, step: "cev_capture_compare_crash", status: "fail", data: { error: msg } });
    console.error("[CEV-CAPTURE] Crash:", msg);
    if (browser) await browser.close().catch(() => {});
    return result;
  }
}
