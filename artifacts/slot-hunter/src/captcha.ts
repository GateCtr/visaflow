import type { Page } from "playwright";

const TWO_CAPTCHA_BASE = "https://2captcha.com";
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

// ─── Cloudflare Turnstile ─────────────────────────────────────────────────────

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

/**
 * Extrait le sitekey Turnstile CF depuis la page de challenge.
 * Cherche dans : iframe src param, attribut data-sitekey, HTML inline.
 */
async function extractTurnstileSitekey(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Depuis l'iframe challenges.cloudflare.com
    const iframes = document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"]'
    );
    for (const f of iframes) {
      const src = f.getAttribute("src") ?? "";
      // ?k=XXXX ou /k=XXXX
      const m = src.match(/[?&/]k=([0-9a-zA-Z_-]{10,})/);
      if (m) return m[1];
    }
    // Depuis un widget .cf-turnstile
    const widget = document.querySelector<HTMLElement>(
      ".cf-turnstile[data-sitekey], [data-cf-turnstile][data-sitekey]"
    );
    if (widget?.getAttribute("data-sitekey")) {
      return widget.getAttribute("data-sitekey")!;
    }
    // Scan HTML brut (fallback)
    const match = document.documentElement.innerHTML.match(
      /"sitekey"\s*:\s*"([0-9a-zA-Z_-]{10,})"|data-sitekey="([0-9a-zA-Z_-]{10,})"/
    );
    return match ? (match[1] ?? match[2] ?? "") : "";
  }).catch(() => "");
}

/**
 * Détecte et tente de résoudre un challenge Cloudflare Turnstile via 2captcha.
 * Utilisé APRÈS l'attente d'auto-résolution (voir waitAndResolveCloudflareTurnstile dans spainPortal).
 */
export async function detectAndSolveTurnstile(
  page: Page,
  twoCaptchaApiKey: string | undefined
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

  console.log(`[captcha] Turnstile CF détecté (titre: "${title}")`);

  if (!twoCaptchaApiKey) {
    console.warn("[captcha] Turnstile : 2captcha key absente — non résolu");
    return "no_key";
  }

  const siteKey = await extractTurnstileSitekey(page);
  if (!siteKey) {
    console.error("[captcha] Turnstile : sitekey introuvable dans la page");
    return "failed";
  }

  const pageUrl = page.url();
  let taskId: string | null = null;
  try {
    taskId = await submitTurnstileTask(twoCaptchaApiKey, siteKey, pageUrl);
  } catch (err) {
    console.error("[captcha] Soumission Turnstile échouée:", err instanceof Error ? err.message : String(err));
    return "failed";
  }
  if (!taskId) return "failed";

  const token = await pollCaptchaSolution(twoCaptchaApiKey, taskId);
  if (!token) return "failed";

  await injectTurnstileSolution(page, token);
  console.log("[captcha] Turnstile token injecté — attente rechargement page...");

  // Attendre que CF redirige vers la page réelle après injection du token
  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch {
    // Pas de navigation = token injecté mais CF n'a pas encore redirigé (normal si form.submit() n'a pas fonctionné)
  }

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
