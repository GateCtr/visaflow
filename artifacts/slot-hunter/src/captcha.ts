// Migration Puppeteer: Page type aliased to any
type Page = any;
import { buildStickyIproyalUrl } from "./browser.js";

const TWO_CAPTCHA_BASE = "https://2captcha.com";
const ANTICAPTCHA_BASE = "https://api.anti-captcha.com";
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 24;

const CF_CHALLENGE_TITLE =
  /un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i;

export type CaptchaResult = "solved" | "no_key" | "failed";

export async function solveCaptchaForSite(
  apiKey: string,
  siteKey: string,
  pageUrl: string
): Promise<string | null> {
  const captchaId = await submitCaptchaTask(apiKey, siteKey, pageUrl);
  if (!captchaId) return null;
  return pollCaptchaSolution(apiKey, captchaId);
}

async function submitCaptchaTask(
  apiKey: string,
  siteKey: string,
  pageUrl: string
): Promise<string | null> {
  const params = new URLSearchParams({
    key: apiKey,
    method: "userrecaptcha",
    googlekey: siteKey,
    pageurl: pageUrl,
    json: "1",
  });

  console.log(`[captcha] Soumission à 2captcha — siteKey: ${siteKey.slice(0, 12)}... pageUrl: ${pageUrl}`);

  let res: Response;
  try {
    res = await fetch(`${TWO_CAPTCHA_BASE}/in.php?${params.toString()}`);
  } catch (err) {
    console.error("[captcha] Réseau 2captcha inaccessible:", err);
    throw new Error(`2captcha réseau: ${err instanceof Error ? err.message : String(err)}`);
  }

  let data: { status: number; request: string };
  try {
    data = (await res.json()) as { status: number; request: string };
  } catch {
    const raw = await res.text().catch(() => "(non lisible)");
    console.error("[captcha] Réponse 2captcha non-JSON:", raw.slice(0, 200));
    throw new Error(`2captcha réponse invalide: ${raw.slice(0, 100)}`);
  }

  if (data.status !== 1) {
    // Codes d'erreur 2captcha courants :
    // ERROR_WRONG_USER_KEY, ERROR_KEY_DOES_NOT_EXIST, ERROR_ZERO_BALANCE,
    // ERROR_CAPTCHA_UNSOLVABLE, ERROR_IP_NOT_ALLOWED
    console.error("[captcha] Soumission refusée par 2captcha:", data.request);
    throw new Error(`2captcha erreur: ${data.request}`);
  }

  console.log(`[captcha] Tâche soumise, ID: ${data.request}`);
  return data.request;
}

async function pollCaptchaSolution(
  apiKey: string,
  captchaId: string
): Promise<string | null> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const params = new URLSearchParams({
      key: apiKey,
      action: "get",
      id: captchaId,
      json: "1",
    });

    let data: { status: number; request: string };
    try {
      const res = await fetch(`${TWO_CAPTCHA_BASE}/res.php?${params.toString()}`);
      data = (await res.json()) as { status: number; request: string };
    } catch (err) {
      console.warn(`[captcha] Erreur réseau/JSON pendant le poll (tentative ${i + 1}/${MAX_POLL_ATTEMPTS}):`, err);
      // Erreur transitoire — on continue à poller
      continue;
    }

    if (data.status === 1) {
      return data.request;
    }

    if (data.request !== "CAPCHA_NOT_READY") {
      console.error("[captcha] Poll error:", data.request);
      return null;
    }

    console.log(`[captcha] Waiting for solution... attempt ${i + 1}/${MAX_POLL_ATTEMPTS}`);
  }

  console.error("[captcha] Timed out waiting for solution");
  return null;
}

async function injectCaptchaSolution(page: Page, token: string): Promise<void> {
  await page.evaluate((tok: string) => {
    const textarea = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = tok;
      textarea.style.display = "block";
    }
    const callbacks = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, Record<string, { callback?: (t: string) => void }>> } }).___grecaptcha_cfg?.clients;
    if (callbacks) {
      for (const key of Object.keys(callbacks)) {
        const client = callbacks[key];
        for (const subKey of Object.keys(client)) {
          if (client[subKey]?.callback) {
            try { client[subKey].callback!(tok); } catch { /* ignore */ }
          }
        }
      }
    }
  }, token);
}

// ─── Anti-Captcha ───────────────────────────────────────────────────────────

const ANTICAPTCHA_POLL_MS = 5_000;
const ANTICAPTCHA_MAX_POLLS = 36; // 3 minutes max

interface AntiCaptchaCreateResponse {
  errorId: number;
  taskId?: number;
  errorCode?: string;
}

interface AntiCaptchaResultResponse {
  errorId: number;
  status: 'processing' | 'ready';
  solution?: { gRecaptchaResponse?: string; token?: string };
  errorCode?: string;
}

// ─── CapSolver — Turnstile (AntiTurnstileTaskProxyLess) ──────────────────────

const CAPSOLVER_BASE = "https://api.capsolver.com";
const CAPSOLVER_POLL_MS = 2_000;
const CAPSOLVER_MAX_POLLS = 30; // 60s max

interface CapSolverCreateResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: string;
  taskId?: string;
}

interface CapSolverResultResponse {
  errorId: number;
  errorCode?: string;
  status: string;
  solution?: { token?: string; userAgent?: string };
}

async function solveTurnstileViaAntiCaptcha(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
): Promise<string | null> {
  console.log(`[captcha] Turnstile → Anti-Captcha TurnstileTaskProxyless | siteKey: ${siteKey.slice(0, 14)}… | page: ${pageUrl}`);

  // 1. Créer la tâche
  let taskId: number;
  try {
    const createRes = await fetch(`${ANTICAPTCHA_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "TurnstileTaskProxyless",
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await createRes.json()) as AntiCaptchaCreateResponse;

    if (data.errorId !== 0 || !data.taskId) {
      console.error(`[captcha] Anti-Captcha createTask erreur: ${data.errorCode ?? data.errorId}`);
      return null;
    }
    taskId = data.taskId;
    console.log(`[captcha] Anti-Captcha tâche créée: ${taskId}`);
  } catch (err) {
    console.error("[captcha] Anti-Captcha createTask réseau:", err instanceof Error ? err.message : err);
    return null;
  }

  // 2. Poller le résultat
  for (let i = 0; i < ANTICAPTCHA_MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, ANTICAPTCHA_POLL_MS));

    try {
      const resultRes = await fetch(`${ANTICAPTCHA_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await resultRes.json()) as AntiCaptchaResultResponse;

      if (data.errorId !== 0) {
        console.error(`[captcha] Anti-Captcha poll erreur: ${data.errorCode ?? data.errorId}`);
        return null;
      }

      if (data.status === "ready") {
        const token = data.solution?.token ?? null;
        if (token) {
          console.log(`[captcha] Anti-Captcha token reçu en ${(i + 1) * ANTICAPTCHA_POLL_MS / 1000}s (longueur: ${token.length})`);
          return token;
        }
        console.error("[captcha] Anti-Captcha: status ready mais token absent");
        return null;
      }

      console.log(`[captcha] Anti-Captcha poll #${i + 1} — processing`);
    } catch (err) {
      console.warn(`[captcha] Anti-Captcha poll #${i + 1} réseau erreur:`, err instanceof Error ? err.message : err);
    }
  }

  console.error("[captcha] Anti-Captcha timeout");
  return null;
}

async function solveTurnstileViaCapsolver(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
): Promise<string | null> {
  console.log(`[captcha] Turnstile → CapSolver AntiTurnstileTaskProxyLess | siteKey: ${siteKey.slice(0, 14)}… | page: ${pageUrl}`);

  // 1. Créer la tâche
  let taskId: string;
  try {
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "AntiTurnstileTaskProxyLess",
          websiteURL: pageUrl,
          websiteKey: siteKey,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await createRes.json()) as CapSolverCreateResponse;

    if (data.errorId !== 0 || !data.taskId) {
      console.error(`[captcha] CapSolver createTask erreur: ${data.errorCode} — ${data.errorDescription}`);
      return null;
    }
    taskId = data.taskId;
    console.log(`[captcha] CapSolver tâche créée: ${taskId}`);
  } catch (err) {
    console.error("[captcha] CapSolver createTask réseau:", err instanceof Error ? err.message : err);
    return null;
  }

  // 2. Poller le résultat
  for (let i = 1; i <= CAPSOLVER_MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, CAPSOLVER_POLL_MS));

    try {
      const resultRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await resultRes.json()) as CapSolverResultResponse;

      if (data.errorId !== 0) {
        console.error(`[captcha] CapSolver getTaskResult erreur: ${data.errorCode}`);
        return null;
      }

      if (data.status === "ready") {
        const token = data.solution?.token;
        if (!token) {
          console.error("[captcha] CapSolver: status ready mais token absent");
          return null;
        }
        console.log(`[captcha] CapSolver token reçu en ${i * CAPSOLVER_POLL_MS / 1000}s (longueur: ${token.length})`);
        return token;
      }

      if (data.status !== "processing" && data.status !== "idle") {
        console.error(`[captcha] CapSolver statut inattendu: ${data.status}`);
        return null;
      }

      process.stdout.write(`[captcha] CapSolver #${i}/${CAPSOLVER_MAX_POLLS} — en attente…\r`);
    } catch (err) {
      console.warn(`[captcha] CapSolver poll erreur (tentative ${i}):`, err instanceof Error ? err.message : err);
    }
  }

  console.error("\n[captcha] CapSolver timeout — aucune solution reçue");
  return null;
}

// ─── Cloudflare Turnstile ─────────────────────────────────────────────────────

// ─── 2captcha Turnstile via createTask API (format moderne) ──────────────────

const TWOCAPTCHA_CREATE_TASK_URL = "https://api.2captcha.com/createTask";
const TWOCAPTCHA_GET_RESULT_URL = "https://api.2captcha.com/getTaskResult";
const TWOCAPTCHA_TURNSTILE_POLL_MS = 5_000;
const TWOCAPTCHA_TURNSTILE_MAX_POLLS = 36; // 3 min max

interface TwoCaptchaCreateTaskResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
}

interface TwoCaptchaGetResultResponse {
  errorId: number;
  errorCode?: string;
  status: "processing" | "ready";
  solution?: { token?: string; userAgent?: string };
}

/**
 * Résout Cloudflare Turnstile via l'API createTask de 2captcha (format moderne).
 * Utilise TurnstileTaskProxyless — 2captcha résout avec son propre pool de proxys.
 * 
 * Avantage : API unifiée, même format que CapSolver/Anti-Captcha.
 * Doc : https://api.2captcha.com — méthode createTask + TurnstileTaskProxyless
 */
async function solveTurnstileVia2captchaCreateTask(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  action?: string,
  cData?: string,
  chlPageData?: string,
): Promise<string | null> {
  console.log(`[captcha] Turnstile → 2captcha createTask (TurnstileTaskProxyless) | siteKey: ${siteKey.slice(0, 14)}… | page: ${pageUrl}`);

  // 1. Créer la tâche
  let taskId: number;
  try {
    const task: any = {
      type: "TurnstileTaskProxyless",
      websiteURL: pageUrl,
      websiteKey: siteKey,
    };

    // Ajouter les paramètres supplémentaires pour les pages de défi Cloudflare
    if (action) task.action = action;
    if (cData) task.data = cData;
    if (chlPageData) task.pagedata = chlPageData;

    const createRes = await fetch(TWOCAPTCHA_CREATE_TASK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await createRes.json()) as TwoCaptchaCreateTaskResponse;

    if (data.errorId !== 0 || !data.taskId) {
      console.error(`[captcha] 2captcha createTask erreur: ${data.errorCode ?? data.errorId} — ${data.errorDescription ?? "unknown"}`);
      return null;
    }
    taskId = data.taskId;
    console.log(`[captcha] 2captcha Turnstile tâche créée: ${taskId}`);
  } catch (err) {
    console.error("[captcha] 2captcha createTask réseau:", err instanceof Error ? err.message : err);
    return null;
  }

  // 2. Poller le résultat
  for (let i = 1; i <= TWOCAPTCHA_TURNSTILE_MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, TWOCAPTCHA_TURNSTILE_POLL_MS));

    try {
      const resultRes = await fetch(TWOCAPTCHA_GET_RESULT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await resultRes.json()) as TwoCaptchaGetResultResponse;

      if (data.errorId !== 0) {
        console.error(`[captcha] 2captcha getTaskResult erreur: ${data.errorCode ?? data.errorId}`);
        return null;
      }

      if (data.status === "ready") {
        const token = data.solution?.token ?? null;
        if (token) {
          console.log(`[captcha] 2captcha Turnstile token reçu en ${i * TWOCAPTCHA_TURNSTILE_POLL_MS / 1000}s (longueur: ${token.length})`);
          return token;
        }
        console.error("[captcha] 2captcha: status ready mais token absent");
        return null;
      }

      process.stdout.write(`[captcha] 2captcha Turnstile #${i}/${TWOCAPTCHA_TURNSTILE_MAX_POLLS} — processing…\r`);
    } catch (err) {
      console.warn(`[captcha] 2captcha poll #${i} réseau erreur:`, err instanceof Error ? err.message : err);
    }
  }

  console.error("\n[captcha] 2captcha Turnstile timeout — aucune solution reçue");
  return null;
}

async function submitTurnstileTask(
  apiKey: string,
  siteKey: string,
  pageUrl: string
): Promise<string | null> {
  const params = new URLSearchParams({
    key: apiKey,
    method: "turnstile",
    sitekey: siteKey,
    pageurl: pageUrl,
    json: "1",
  });

  console.log(`[captcha] Turnstile → 2captcha siteKey: ${siteKey.slice(0, 14)}… page: ${pageUrl}`);

  let res: Response;
  try {
    res = await fetch(`${TWO_CAPTCHA_BASE}/in.php?${params.toString()}`);
  } catch (err) {
    throw new Error(`2captcha réseau (Turnstile): ${err instanceof Error ? err.message : String(err)}`);
  }

  let data: { status: number; request: string };
  try {
    data = (await res.json()) as { status: number; request: string };
  } catch {
    const raw = await res.text().catch(() => "non lisible");
    throw new Error(`2captcha réponse Turnstile invalide: ${raw.slice(0, 100)}`);
  }

  if (data.status !== 1) {
    throw new Error(`2captcha Turnstile refusé: ${data.request}`);
  }

  console.log(`[captcha] Turnstile tâche soumise ID: ${data.request}`);
  return data.request;
}

async function injectTurnstileSolution(page: Page, token: string): Promise<void> {
  await page.evaluate((tok: string) => {
    // 1. Injecter dans l'input caché CF standard
    const hidden = document.querySelector<HTMLInputElement>(
      '[name="cf-turnstile-response"], input[name="cf_challenge_response"]'
    );
    if (hidden) hidden.value = tok;

    // 2. Appeler les callbacks déclarés sur le widget .cf-turnstile
    const w = window as unknown as Record<string, unknown>;
    const widgets = document.querySelectorAll<HTMLElement>(".cf-turnstile, [data-cf-turnstile]");
    for (const widget of widgets) {
      const cbName = widget.getAttribute("data-callback");
      if (cbName && typeof w[cbName] === "function") {
        try { (w[cbName] as (t: string) => void)(tok); } catch { /* ignore */ }
      }
    }

    // 3. Soumettre le formulaire challenge si présent
    const form = document.querySelector<HTMLFormElement>("#challenge-form, form[action*='cdn-cgi']");
    if (form) {
      // Placer le token dans un champ caché si pas encore trouvé
      let tokenInput = form.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]');
      if (!tokenInput) {
        tokenInput = document.createElement("input");
        tokenInput.type = "hidden";
        tokenInput.name = "cf-turnstile-response";
        form.appendChild(tokenInput);
      }
      tokenInput.value = tok;
      form.submit();
    }
  }, token);
}

export interface SitekeyResult {
  sitekey: string;
  /** true = CF Managed Challenge interstitiel (AntiCloudflareTask requis) */
  isCfChallenge: boolean;
}

/**
 * Extrait le sitekey + type de challenge depuis la page CF.
 *
 * Stratégie multi-couches :
 *  1. URLs de toutes les frames — pattern `/0x4.../` dans challenge-platform → CF Managed
 *  2. Iframes DOM (src chemin ou ?k=)
 *  3. Widget .cf-turnstile[data-sitekey]
 *  4. Scan HTML brut (fallback)
 */
export async function extractTurnstileSitekey(page: Page): Promise<SitekeyResult | null> {
  // 1. Scan des URLs de toutes les frames actives
  //    CF Managed Challenge embarque le sitekey dans l'URL de son iframe interne :
  //    challenges.cloudflare.com/cdn-cgi/challenge-platform/.../0x4XXXX/...
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const frameUrl = frame.url();
      if (!frameUrl || frameUrl === "about:blank" || frameUrl.startsWith("blob:")) continue;
      const mFrame = frameUrl.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
      if (mFrame) {
        const isCfChallenge = frameUrl.includes("challenge-platform");
        console.log(`[captcha] Sitekey dans frame URL (type: ${isCfChallenge ? "CF_CHALLENGE" : "turnstile"}): ${mFrame[1]}`);
        return { sitekey: mFrame[1], isCfChallenge };
      }
    } catch { /* frame déchargée */ }
  }

  // 2-4. Fallback DOM → probablement Turnstile standard
  const sitekey = await page.evaluate(() => {
    const iframes = document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"]'
    );
    for (const f of iframes) {
      const src = f.getAttribute("src") ?? "";
      const mPath = src.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
      if (mPath) return mPath[1];
      const mParam = src.match(/[?&]k=([0-9a-zA-Z_-]{10,})/);
      if (mParam) return mParam[1];
    }
    const widget = document.querySelector<HTMLElement>(
      ".cf-turnstile[data-sitekey], [data-cf-turnstile][data-sitekey]"
    );
    if (widget?.getAttribute("data-sitekey")) return widget.getAttribute("data-sitekey")!;
    const m0x4 = document.documentElement.innerHTML.match(/0x4[A-Za-z0-9_-]{10,}/);
    if (m0x4) return m0x4[0];
    const match = document.documentElement.innerHTML.match(
      /"sitekey"\s*:\s*"([0-9a-zA-Z_-]{10,})"|data-sitekey="([0-9a-zA-Z_-]{10,})"/
    );
    return match ? (match[1] ?? match[2] ?? "") : "";
  }).catch(() => "");

  if (!sitekey) return null;
  return { sitekey, isCfChallenge: false };
}

// ─── CapSolver — CF Managed Challenge (AntiCloudflareTask) ───────────────────

interface CfClearanceSolution {
  cfClearance: string;
  userAgent: string;
}

interface CapSolverCfResultResponse {
  errorId: number;
  errorCode?: string;
  status: string;
  solution?: { token?: string; userAgent?: string; cookies?: Array<{ name: string; value: string }> };
}

/**
 * Résout un Cloudflare Managed Challenge via CapSolver AntiCloudflareTask.
 * Retourne la valeur du cookie cf_clearance + le userAgent utilisé par CapSolver.
 * @param proxyUrl  URL proxy iProyal au format http://user:pass@host:port (recommandé)
 */
async function solveCfManagedChallengeViaCapsolver(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  proxyUrl?: string,
): Promise<CfClearanceSolution | null> {
  // AntiCloudflareTask peut échouer avec 1002 (intermittent) — on retente 3 fois
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await _tryAntiCloudflareTask(apiKey, siteKey, pageUrl, proxyUrl, attempt);
    if (result) return result;
    if (attempt < MAX_ATTEMPTS) {
      const jitter = 5_000 + Math.random() * 5_000;
      console.log(`[captcha] AntiCloudflareTask tentative ${attempt} échouée — retry dans ${Math.round(jitter / 1000)}s…`);
      await new Promise(r => setTimeout(r, jitter));
    }
  }
  console.error("[captcha] AntiCloudflareTask : toutes les tentatives ont échoué");
  return null;
}

async function _tryAntiCloudflareTask(
  apiKey: string,
  siteKey: string,
  pageUrl: string,
  proxyUrl: string | undefined,
  attempt: number,
): Promise<CfClearanceSolution | null> {
  const safeProxy = proxyUrl?.replace(/:[^:@]+@/, ":<redacted>@") ?? "aucun";
  console.log(`[captcha] CF Managed → CapSolver AntiCloudflareTask (tentative ${attempt}/3) | proxy: ${safeProxy.slice(0, 50)}`);

  // AntiCloudflareTask ne prend PAS de websiteKey — le challenge est détecté auto.
  const task: Record<string, unknown> = {
    type: "AntiCloudflareTask",
    websiteURL: pageUrl,
  };
  if (proxyUrl) task.proxy = proxyUrl;

  // 1. Créer la tâche
  let taskId: string;
  try {
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, task }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await createRes.json()) as CapSolverCreateResponse;
    if (data.errorId !== 0 || !data.taskId) {
      console.error(`[captcha] CapSolver AntiCloudflareTask erreur: ${data.errorCode} — ${data.errorDescription}`);
      return null;
    }
    taskId = data.taskId;
    console.log(`[captcha] CapSolver AntiCloudflareTask créée: ${taskId}`);
  } catch (err) {
    console.error("[captcha] CapSolver AntiCloudflareTask réseau:", err instanceof Error ? err.message : err);
    return null;
  }

  // 2. Poller le résultat (timeout 120s — CF challenge peut prendre du temps)
  for (let i = 1; i <= 60; i++) {
    await new Promise(r => setTimeout(r, CAPSOLVER_POLL_MS));
    try {
      const resultRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await resultRes.json()) as CapSolverCfResultResponse;
      if (data.errorId !== 0) {
        console.error(`[captcha] CapSolver CF poll erreur: ${data.errorCode}`);
        return null;
      }
      if (data.status === "ready") {
        // cf_clearance peut être dans solution.token ou solution.cookies
        let cfClearance = data.solution?.token ?? "";
        if (!cfClearance && data.solution?.cookies) {
          const cfCookie = data.solution.cookies.find(c => c.name === "cf_clearance");
          cfClearance = cfCookie?.value ?? "";
        }
        if (!cfClearance) {
          console.error("[captcha] CapSolver AntiCloudflareTask: ready mais cf_clearance absent");
          console.error("[captcha] Solution reçue:", JSON.stringify(data.solution).slice(0, 300));
          return null;
        }
        const userAgent = data.solution?.userAgent ?? "";
        console.log(`[captcha] ✅ cf_clearance reçu en ${i * CAPSOLVER_POLL_MS / 1000}s (longueur: ${cfClearance.length})`);
        return { cfClearance, userAgent };
      }
      if (data.status !== "processing" && data.status !== "idle") {
        console.error(`[captcha] CapSolver CF statut inattendu: ${data.status}`);
        return null;
      }
      process.stdout.write(`[captcha] CapSolver CF #${i}/60 — en attente…\r`);
    } catch (err) {
      console.warn(`[captcha] CapSolver CF poll erreur (tentative ${i}):`, err instanceof Error ? err.message : err);
    }
  }
  console.error("\n[captcha] CapSolver AntiCloudflareTask timeout");
  return null;
}

/**
 * Détecte et tente de résoudre un challenge Cloudflare.
 *
 * Deux branches selon le type de challenge détecté :
 *
 * ── CF Managed Challenge (interstitiel "Un momento…") ─────────────────────────
 *   → CapSolver AntiCloudflareTask (nécessite proxy iProyal) → cf_clearance cookie
 *
 * ── Turnstile widget standard (data-sitekey dans le DOM) ─────────────────────
 *   → Anti-Captcha TurnstileTaskProxyless (priorité)
 *   → CapSolver AntiTurnstileTaskProxyLess
 *   → Fallback : 2captcha
 *
 * Utilisé APRÈS l'attente d'auto-résolution (voir waitAndResolveCloudflareTurnstile dans spainPortal).
 *
 * @param proxyUrl  URL proxy au format http://user:pass@host:port
 *                  Requis pour AntiCloudflareTask (CF Managed Challenge).
 */
export async function detectAndSolveTurnstile(
  page: Page,
  twoCaptchaApiKey: string | undefined,
  capsolverApiKey?: string,
  proxyUrl?: string,
  anticaptchaApiKey?: string,
): Promise<CaptchaResult> {
  let title = "";
  try { title = await page.title(); } catch { /* ignore */ }

  const hasCfBlock = CF_CHALLENGE_TITLE.test(title) || await page.evaluate(() =>
    !!(
      document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
      document.querySelector('iframe[src*="challenge-platform"]') ||
      document.querySelector(".cf-turnstile") ||
      document.getElementById("challenge-form")
    )
  ).catch(() => false);

  if (!hasCfBlock) return "solved";

  console.log(`[captcha] Challenge CF détecté (titre: "${title}")`);

  const sitekeyResult = await extractTurnstileSitekey(page);
  if (!sitekeyResult) {
    console.error("[captcha] Sitekey CF introuvable dans la page");
    return "failed";
  }

  const { sitekey, isCfChallenge } = sitekeyResult;
  const pageUrl = page.url();

  // ── Branche A : CF Managed Challenge — CapSolver AntiCloudflareTask ────
  if (isCfChallenge) {
    console.log(`[captcha] Type: CF Managed Challenge | sitekey: ${sitekey}`);
    if (!capsolverApiKey) {
      console.warn("[captcha] CF Managed Challenge : CAPSOLVER_API_KEY absent — impossible à résoudre");
      return "no_key";
    }
    const solution = await solveCfManagedChallengeViaCapsolver(capsolverApiKey, sitekey, pageUrl, proxyUrl).catch(() => null);
    if (!solution) return "failed";

    // Injecter le cookie cf_clearance dans le contexte Playwright
    const domain = new URL(pageUrl).hostname;
    try {
      await page.context().addCookies([{
        name: "cf_clearance",
        value: solution.cfClearance,
        domain: `.${domain}`,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "None",
      }]);
      console.log("[captcha] ✅ Cookie cf_clearance injecté");
    } catch (err) {
      console.error("[captcha] Erreur injection cf_clearance:", err instanceof Error ? err.message : err);
      return "failed";
    }

    // Synchroniser le User-Agent avec celui utilisé par CapSolver pour résoudre le challenge.
    // cf_clearance est lié à l'UA — sans correspondance, CF rejette le cookie.
    if (solution.userAgent) {
      try {
        await page.setExtraHTTPHeaders({ "User-Agent": solution.userAgent });
        console.log(`[captcha] UA synchronisé: ${solution.userAgent.slice(0, 60)}…`);
      } catch { /* non critique */ }
    }

    // Recharger via reload() (pas goto) — réutilise la connexion iProyal existante
    // pour rester sur le même exit IP que CapSolver a utilisé → cf_clearance valide.
    console.log("[captcha] Rechargement post-injection (reload)...");
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { /* timeout acceptable */ }

    return "solved";
  }

  // ── Branche B : Turnstile widget standard ────────────────────────────────
  console.log(`[captcha] Type: Turnstile standard | sitekey: ${sitekey.slice(0, 14)}…`);
  let token: string | null = null;

  // Essayer d'intercepter les paramètres Cloudflare pour les pages de défi
  let action: string | undefined;
  let cData: string | undefined;
  let chlPageData: string | undefined;

  // Priorité 1 : 2captcha TurnstileTaskProxyless (API createTask — plus fiable et unifié)
  // 2captcha est priorisé car on a déjà un abonnement proxy+captcha combiné,
  // et le token Turnstile résolu via leur réseau est cohérent avec nos IPs résidentielles.
  if (twoCaptchaApiKey) {
    console.log("[captcha] Turnstile → 2captcha TurnstileTaskProxyless (priorité 1)");
    
    // Injecter le code pour intercepter window.turnstile.render
    try {
      await page.evaluate(() => {
        const w = window as any;
        if (w.turnstile && !w._turnstileIntercepted) {
          w._turnstileIntercepted = true;
          w.turnstile = new Proxy(w.turnstile, {
            get(target, prop) {
              if (prop === "render") {
                return function (a: any, b: any) {
                  const p = {
                    websiteURL: window.location.href,
                    websiteKey: b.sitekey,
                    action: b.action,
                    cData: b.cData,
                    chlPageData: b.chlPageData,
                    userAgent: navigator.userAgent,
                  };
                  
                  // Sauvegarder les paramètres dans window.params
                  w.params = p;
                  
                  // Sauvegarder le callback dans window.cfCallback
                  w.cfCallback = b.callback;
                  
                  // Appeler la fonction render originale
                  return target.render.apply(target, arguments);
                };
              }
              return (target as any)[prop];
            },
          });
        }
      });
    } catch (err) {
      console.warn("[captcha] Erreur injection interception:", err);
    }
    
    // Essayer d'intercepter les paramètres Cloudflare
    try {
      const params = await page.evaluate(() => {
        const w = window as any;
        if (w.params) {
          return w.params;
        }
        return null;
      }).catch(() => null);
      
      if (params) {
        action = params.action;
        cData = params.cData;
        chlPageData = params.chlPageData;
        console.log(`[captcha] Paramètres Cloudflare interceptés: action=${action ? 'oui' : 'non'}, cData=${cData ? 'oui' : 'non'}, chlPageData=${chlPageData ? 'oui' : 'non'}`);
      }
    } catch (err) {
      console.warn("[captcha] Erreur interception paramètres:", err);
    }
    
    token = await solveTurnstileVia2captchaCreateTask(
      twoCaptchaApiKey, 
      sitekey, 
      pageUrl,
      action,
      cData,
      chlPageData
    ).catch(() => null);
    
    if (token) {
      console.log("[captcha] ✅ 2captcha Turnstile token reçu");
      
      // Exécuter le callback avec le token
      try {
        await page.evaluate((t: string) => {
          const w = window as any;
          if (w.cfCallback && typeof w.cfCallback === 'function') {
            console.log("[captcha] Exécution du callback Turnstile avec le token");
            w.cfCallback(t);
          } else {
            // Fallback: essayer de trouver et remplir le champ cf-turnstile-response
            const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement;
            if (input) {
              input.value = t;
              console.log("[captcha] Champ cf-turnstile-response rempli");
            }
          }
        }, token);
        
        // Attendre un peu pour laisser le temps au callback de s'exécuter
        await new Promise(r => setTimeout(r, 2000));
        
        // Recharger la page
        console.log("[captcha] Rechargement après injection token...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        
      } catch (err) {
        console.warn("[captcha] Erreur exécution callback:", err);
      }
    } else {
      console.warn("[captcha] 2captcha Turnstile échec — fallback Anti-Captcha");
    }
  }

  // Priorité 2 : Anti-Captcha TurnstileTaskProxyless
  if (!token && anticaptchaApiKey) {
    console.log("[captcha] Turnstile → Anti-Captcha TurnstileTaskProxyless");
    token = await solveTurnstileViaAntiCaptcha(anticaptchaApiKey, sitekey, pageUrl).catch(() => null);
    if (token) {
      console.log("[captcha] ✅ Anti-Captcha Turnstile token reçu");
    } else {
      console.warn("[captcha] Anti-Captcha Turnstile échec — fallback CapSolver");
    }
  }

  // Priorité 3 : CapSolver AntiTurnstileTaskProxyLess
  if (!token && capsolverApiKey) {
    console.log("[captcha] Turnstile → CapSolver AntiTurnstileTaskProxyLess");
    token = await solveTurnstileViaCapsolver(capsolverApiKey, sitekey, pageUrl).catch(() => null);
    if (token) {
      console.log("[captcha] ✅ CapSolver Turnstile token reçu");
    } else {
      console.warn("[captcha] CapSolver Turnstile échec — aucun fallback restant");
    }
  }

  if (!token) {
    console.error("[captcha] Turnstile : tous les providers ont échoué");
    return "failed";
  }

  if (!token) return "failed";

  await injectTurnstileSolution(page, token);
  console.log("[captcha] Turnstile token injecté — attente rechargement...");

  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch { /* pas de navigation = form.submit() non déclenché */ }

  return "solved";
}

export async function detectAndSolveCaptcha(
  page: Page,
  twoCaptchaApiKey: string | undefined
): Promise<CaptchaResult> {
  const hasCaptcha = await page.evaluate(() => {
    return !!(
      document.querySelector(".g-recaptcha") ||
      document.querySelector("[data-sitekey]") ||
      document.querySelector("iframe[src*='recaptcha']")
    );
  });

  if (!hasCaptcha) return "solved";

  console.log("[captcha] reCAPTCHA detected on page");

  if (!twoCaptchaApiKey) {
    console.warn("[captcha] No 2captcha key configured — skipping");
    return "no_key";
  }

  const siteKey = await page.evaluate(() => {
    const el = document.querySelector("[data-sitekey]") as HTMLElement | null;
    return el?.getAttribute("data-sitekey") ?? "";
  });

  if (!siteKey) {
    console.error("[captcha] Could not find sitekey");
    return "failed";
  }

  const pageUrl = page.url();
  console.log(`[captcha] Submitting to 2captcha (siteKey: ${siteKey.slice(0, 10)}...)`);

  let captchaId: string | null = null;
  try {
    captchaId = await submitCaptchaTask(twoCaptchaApiKey, siteKey, pageUrl);
  } catch (err) {
    console.error("[captcha] Soumission 2captcha échouée:", err instanceof Error ? err.message : String(err));
    return "failed";
  }
  if (!captchaId) return "failed";

  const token = await pollCaptchaSolution(twoCaptchaApiKey, captchaId);
  if (!token) return "failed";

  await injectCaptchaSolution(page, token);
  console.log("[captcha] Solution injected successfully");
  return "solved";
}


// ─── Méthode avec proxy injection (comme @antiadmin/anticaptchaofficial) ─────────────────

interface TurnstileParams {
  websiteURL: string;
  websiteKey: string;
  action?: string;
  cData?: string;
  chlPageData?: string;
  userAgent: string;
}

/**
 * Résout Turnstile avec la méthode de proxy injection (comme @antiadmin/anticaptchaofficial).
 * Cette méthode intercepte window.turnstile.render pour capturer les paramètres exacts.
 */
export async function solveTurnstileWithProxyInjection(
  page: Page,
  anticaptchaApiKey: string,
): Promise<CaptchaResult> {
  console.log("[captcha] Tentative de résolution Turnstile avec proxy injection...");
  
  let params: TurnstileParams | null = null;
  let attempts = 0;
  const maxAttempts = 3;
  
  while (!params && attempts < maxAttempts) {
    attempts++;
    console.log(`[captcha] Tentative ${attempts}/${maxAttempts} d'interception des paramètres...`);
    
    try {
      // Injecter le proxy pour intercepter window.turnstile.render
      await page.evaluate(() => {
        // Déclarer turnstile sur window
        const w = window as any;
        if (w.turnstile) {
          w.turnstile = new Proxy(w.turnstile, {
            get(target, prop) {
              if (prop === "render") {
                return function (a: any, b: any) {
                  const p = {
                    websiteURL: window.location.href,
                    websiteKey: b.sitekey,
                    action: b.action,
                    cData: b.cData,
                    chlPageData: b.chlPageData,
                    userAgent: navigator.userAgent,
                  };
                  
                  // Sauvegarder les paramètres dans window.params
                  w.params = p;
                  
                  // Sauvegarder le callback dans window.cfCallback
                  w.cfCallback = b.callback;
                  
                  // Appeler la fonction render originale
                  return target.render.apply(target, arguments);
                };
              }
              return (target as any)[prop];
            },
          });
        }
      });
      
      // Attendre que les paramètres soient capturés
      params = await page.evaluate(() => {
        return new Promise<TurnstileParams | null>((resolve) => {
          setTimeout(() => resolve((window as any).params || null), 5000);
        });
      });
      
      if (!params) {
        console.log(`[captcha] Aucun paramètre capturé, attente avant nouvelle tentative...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (error) {
      console.warn(`[captcha] Erreur lors de l'interception:`, error instanceof Error ? error.message : error);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  if (!params) {
    console.error("[captcha] Impossible de capturer les paramètres Turnstile après", maxAttempts, "tentatives");
    return "failed";
  }
  
  console.log(`[captcha] Paramètres Turnstile capturés:`, {
    websiteKey: params.websiteKey.slice(0, 14) + "...",
    action: params.action,
    cData: params.cData ? params.cData.slice(0, 20) + "..." : "non défini",
    chlPageData: params.chlPageData ? params.chlPageData.slice(0, 20) + "..." : "non défini",
  });
  
  // Résoudre avec Anti-Captcha API
  try {
    // 1. Créer la tâche
    const createRes = await fetch(`${ANTICAPTCHA_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: anticaptchaApiKey,
        task: {
          type: "TurnstileTaskProxyless",
          websiteURL: params.websiteURL,
          websiteKey: params.websiteKey,
          action: params.action,
          data: params.cData,
          pageData: params.chlPageData,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    
    const createData = await createRes.json() as { errorId: number; errorCode?: string; taskId?: number };
    
    if (createData.errorId !== 0 || !createData.taskId) {
      console.error(`[captcha] Anti-Captcha createTask erreur: ${createData.errorCode ?? createData.errorId}`);
      return "failed";
    }
    
    const taskId = createData.taskId;
    console.log(`[captcha] Tâche Anti-Captcha créée: ${taskId}`);
    
    // 2. Poller le résultat
    for (let i = 0; i < ANTICAPTCHA_MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, ANTICAPTCHA_POLL_MS));
      
      try {
        const resultRes = await fetch(`${ANTICAPTCHA_BASE}/getTaskResult`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: anticaptchaApiKey, taskId }),
          signal: AbortSignal.timeout(10000),
        });
        
        const resultData = await resultRes.json() as { errorId: number; status: string; solution?: { token?: string } };
        
        if (resultData.errorId !== 0) {
          console.error(`[captcha] Anti-Captcha poll erreur: ${resultData.errorId}`);
          return "failed";
        }
        
        if (resultData.status === "ready") {
          const token = resultData.solution?.token;
          if (!token) {
            console.error("[captcha] Anti-Captcha: status ready mais token absent");
            return "failed";
          }
          
          console.log(`[captcha] Token Turnstile reçu (longueur: ${token.length})`);
          
          // 3. Exécuter le callback avec le token
          await page.evaluate((tok: string) => {
            if ((window as any).cfCallback && typeof (window as any).cfCallback === "function") {
              (window as any).cfCallback(tok);
            }
          }, token);
          
          console.log("[captcha] Callback exécuté avec le token");
          
          // 4. Attendre la redirection/navigation
          await new Promise(r => setTimeout(r, 5000));
          
          // Vérifier si le cookie cf_clearance est présent
          const cookies = await page.context().cookies();
          const cfClearance = cookies.find((c: any) => c.name === "cf_clearance");
          
          if (cfClearance) {
            console.log(`[captcha] Cookie cf_clearance obtenu: ${cfClearance.value.slice(0, 20)}...`);
            return "solved";
          } else {
            console.warn("[captcha] Aucun cookie cf_clearance trouvé après résolution");
            // Continuer quand même, peut-être que la page a été débloquée
            return "solved";
          }
        }
        
        console.log(`[captcha] Anti-Captcha poll #${i + 1} — processing`);
      } catch (error) {
        console.warn(`[captcha] Erreur réseau lors du poll #${i + 1}:`, error instanceof Error ? error.message : error);
      }
    }
    
    console.error("[captcha] Timeout lors de la résolution Turnstile");
    return "failed";
    
  } catch (error) {
    console.error("[captcha] Erreur lors de la résolution Turnstile:", error instanceof Error ? error.message : error);
    return "failed";
  }
}

/**
 * Version alternative de detectAndSolveTurnstile qui utilise la méthode de proxy injection.
 * À utiliser quand la méthode standard échoue.
 */
export async function detectAndSolveTurnstileWithInjection(
  page: Page,
  twoCaptchaApiKey: string | undefined,
  capsolverApiKey?: string,
  proxyUrl?: string,
  anticaptchaApiKey?: string,
): Promise<CaptchaResult> {
  // D'abord essayer la méthode standard
  const standardResult = await detectAndSolveTurnstile(page, twoCaptchaApiKey, capsolverApiKey, proxyUrl, anticaptchaApiKey);
  
  if (standardResult === "solved") {
    return "solved";
  }
  
  // Si la méthode standard échoue et qu'on a une clé Anti-Captcha, essayer la méthode d'injection
  if (anticaptchaApiKey && standardResult !== "no_key") {
    console.log("[captcha] Méthode standard échouée, tentative avec proxy injection...");
    return await solveTurnstileWithProxyInjection(page, anticaptchaApiKey);
  }
  
  return standardResult;
}
