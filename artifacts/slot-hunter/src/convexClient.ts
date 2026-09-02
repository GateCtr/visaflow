import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config();
if (fs.existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: true });
}
const subEnv = path.join("artifacts", "slot-hunter", ".env");
if (fs.existsSync(subEnv)) {
  dotenv.config({ path: subEnv, override: true });
}
const subEnvLocal = path.join("artifacts", "slot-hunter", ".env.local");
if (fs.existsSync(subEnvLocal)) {
  dotenv.config({ path: subEnvLocal, override: true });
}

const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY ?? "";

if (!CONVEX_SITE_URL) {
  console.error("[convexClient] CONVEX_SITE_URL is not set");
}
if (!HUNTER_API_KEY) {
  console.error("[convexClient] HUNTER_API_KEY is not set");
}

const URGENCY_ORDER: Record<string, number> = {
  tres_urgent: 0,
  urgent: 1,
  prioritaire: 2,
  standard: 3,
};

export interface HunterJob {
  id: string;
  destination: string;
  visaType: string;
  applicantName: string;
  travelDate: string;
  urgencyTier: string;
  /** Classe de visa normalisée pour le canal de broadcast (ex: "F1", "B1/B2", "H"). */
  broadcastVisaClass: string | null;
  slotBookingRefs: {
    ds160Confirmation?: string;
    mrvReceiptNumber?: string;
    sevisId?: string;
    petitionReceiptNumber?: string;
    vfsRefNumber?: string;
  } | null;
  hunterConfig: {
    embassyUsername: string;
    embassyPassword: string;
    isActive: boolean;
    twoCaptchaApiKey?: string;
    capsolverApiKey?: string;
    scheduleUrl?: string;
    portalApplicationId?: string;
    applicantFirstname?: string;
    applicantLastname?: string;
    slotDateFrom?: string;
    slotDateDeadline?: string;
    checkCount?: number;
    lastResult?: string;
    lastCheckAt?: number;
    // CEV / Schengen
    vowintAppId?: string;
    cevCountry?: string;
    cevClickCount?: number;
    cevClickWindowStart?: number;
    // Mode reporter USA
    rescheduleMode?: boolean;
    rescheduleExistingDate?: string;
    // Proxy résidentiel USA
    useResidentialProxy?: boolean;
    // Mode nuit
    nightModeEnabled?: boolean;
    // CEV Dossier Loop v3
    cevDossierPool?: string;
    cevDossierExclude?: string;
    cevBookingTargetPool?: string;
    cevCompletedDossiers?: string;
    cevUseProxy?: boolean;
    cevScanIntervalSec?: number;
    // Group booking — min places libres requises par créneau
    groupSize?: number;
    // Session CEV active
    cevActiveSessionCookie?: string;
    cevActiveSessionValidUntil?: string;
    cevActiveSessionRedirectUrl?: string;
    // V3 Chasseur fields
    accountRole?: "eclaireur" | "confine" | "hybride";
    currentAppointmentDate?: string;
    maxLoginsPerDay?: number;
    rushWindows?: string;
    blindBookingEnabled?: boolean;
    slotPriorityDates?: string[];
    maxMonthsToScan?: number;
    preferredProxy?: string;
    // Siphonned F5 cookies
    cevSiphonedF5CookieValue?: string;
    cevSiphonedF5CookieName?: string;
    cevSiphonedAspNetSessionId?: string;
    cevSiphonedUserAgent?: string;
    cevSiphonedAt?: number;
    cevSiphonedValidUntil?: number;
    /** Active l'annulation automatique du RDV existant quand la limite Overview Cas 2 est atteinte */
    cevAutoCancelOnLimitReached?: boolean;
  };
  spainOtpConfig?: {
    channel: "email" | "sms" | "manual";
    email?: string;
    imapPassword?: string;
    phone?: string;
    configuredAt: number;
    lastUsedAt?: number;
  } | null;
  portalUrl: string | null;
  portalName: string | null;
  portalDashboardUrl: string | null;
  portalAppointmentUrl: string | null;
  portalScheduleUrl: string | null;
  lastCheckAt: number | null;
}

const RETRYABLE_HTTP_CODES = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < retries; i++) {
    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      lastError = err as Error;
      const delay = 1000 * (i + 1);
      console.warn(`[convexClient] Network error attempt ${i + 1}/${retries}, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!RETRYABLE_HTTP_CODES.has(res.status)) {
      return res;
    }

    const retryAfter = res.headers.get("Retry-After");
    const delay = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : 1000 * Math.pow(2, i);
    console.warn(`[convexClient] HTTP ${res.status} attempt ${i + 1}/${retries}, retrying in ${Math.round(delay)}ms...`);
    lastError = new Error(`HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError ?? new Error("fetch failed after retries");
}

export async function getActiveJobs(): Promise<HunterJob[]> {
  const url = `${CONVEX_SITE_URL}/hunter/jobs`;
  // GET — pas de body, donc pas de Content-Type
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: { "X-Hunter-Key": HUNTER_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`getActiveJobs failed: ${res.status} ${await res.text()}`);
  }

  const jobs: HunterJob[] = await res.json() as HunterJob[];

  return jobs
    .filter((j) => j.hunterConfig?.isActive === true)
    .sort((a, b) => {
      const pa = URGENCY_ORDER[a.urgencyTier] ?? 3;
      const pb = URGENCY_ORDER[b.urgencyTier] ?? 3;
      return pa - pb;
    });
}

export async function reportSlotFound(payload: {
  applicationId: string;
  date: string;
  time: string;
  location: string;
  confirmationCode?: string;
  screenshotStorageId?: string;
  bookedDossierRef?: string;
}): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/slot-found`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`reportSlotFound failed: ${res.status} ${text}`);
  }
}

export async function reportBookingLog(payload: {
  applicationId: string;
  dossierId: string;
  applicantName: string;
  date: string;
  time: string;
  status: "attempted" | "booked" | "failed";
  reason?: string;
  locator?: string;
  serviceName?: string;
}): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/spain-booking-log`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[reportBookingLog] ${res.status} ${text}`);
    }
  } catch (e) {
    // fire-and-forget — ne jamais bloquer le worker sur une erreur d'email
    console.warn(`[reportBookingLog] exception: ${e}`);
  }
}

export async function sendHeartbeat(payload: {
  applicationId: string;
  result: "not_found" | "captcha" | "error" | "payment_required" | "slot_found";
  errorMessage?: string;
  shouldPause?: boolean;
}): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/heartbeat`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sendHeartbeat failed: ${res.status} ${text}`);
  }
}

export interface BotTest {
  _id: string;
  destination: string;
  portalUrl: string;
  portalName: string;
  testUsername?: string;
  testPassword?: string;
  twoCaptchaApiKey?: string;
  testType?: string;  // "login" (défaut) | "logout"
  status: string;
}

export async function getPendingBotTest(): Promise<BotTest | null> {
  const url = `${CONVEX_SITE_URL}/hunter/pending-test`;
  // POST — claimPendingBotTest est une mutation (écriture DB).
  // Un GET pourrait être retransmis par un proxy HTTP (GET est idempotent par convention),
  // ce qui réclamerait le même test deux fois. POST évite ce risque.
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { test: BotTest | null };
  return data.test ?? null;
}

export async function reportBotTestResult(payload: {
  testId: string;
  result: string;
  latencyMs?: number;
  httpStatus?: number;
  errorMessage?: string;
}): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/test-result`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "X-Hunter-Key": HUNTER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.warn(`[convexClient] reportBotTestResult failed: ${res.status}`);
  }
}

export async function uploadScreenshot(base64: string): Promise<string | null> {
  return uploadFile(base64, "image/png");
}

export async function requestOtpChallenge(payload: {
  applicationId: string;
  flow: "spain" | string;
  channel?: "email" | "sms" | "telegram" | string;
  ttlMs?: number;
  chatId?: string;
}): Promise<{ challengeId: string; expiresAt: number } | null> {
  const url = `${CONVEX_SITE_URL}/hunter/otp/request`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok: boolean; challengeId: string; expiresAt: number };
    return data.ok ? { challengeId: data.challengeId, expiresAt: data.expiresAt } : null;
  } catch (err) {
    console.warn("[convexClient] requestOtpChallenge error:", err);
    return null;
  }
}

export async function consumeOtpCode(payload: {
  applicationId: string;
  flow: "spain" | string;
}): Promise<{ status: "ok"; code: string } | { status: "pending" | "expired" | "none" }> {
  const q = new URLSearchParams({
    applicationId: payload.applicationId,
    flow: payload.flow,
  });
  const url = `${CONVEX_SITE_URL}/hunter/otp/consume?${q.toString()}`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) return { status: "none" };
    const data = (await res.json()) as { status?: "ok" | "pending" | "expired" | "none"; code?: string };
    if (data.status === "ok" && data.code) return { status: "ok", code: data.code };
    if (data.status === "pending" || data.status === "expired" || data.status === "none") return { status: data.status };
    return { status: "none" };
  } catch (err) {
    console.warn("[convexClient] consumeOtpCode error:", err);
    return { status: "none" };
  }
}

/**
 * Enregistre un clic sur le bouton RDV CEV (pour tracking du rate limit 18 clics/heure).
 * Fire-and-forget — ne bloque pas le chemin critique.
 */
export function recordCevClick(payload: {
  applicationId: string;
  windowStart: number;
  clickCount: number;
}): void {
  const url = `${CONVEX_SITE_URL}/hunter/cev-click`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch((err) =>
    console.warn("[convexClient] recordCevClick fire-and-forget error:", err)
  );
}

/**
 * Réinitialise le compteur de clics CEV pour une application.
 * Appelé au démarrage du serveur pour éviter les pauses persistantes.
 */
export function resetCevClickCount(applicationId: string): void {
  const url = `${CONVEX_SITE_URL}/hunter/cev-click-reset`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ applicationId }),
  }).catch((err) =>
    console.warn("[convexClient] resetCevClickCount fire-and-forget error:", err)
  );
}

/**
 * Log fire-and-forget d'un événement du cycle de vie du bot.
 * N'attend jamais la réponse — ne bloque pas le chemin critique.
 */
export function botLog(payload: {
  applicationId: string;
  step: string;
  status: "ok" | "warn" | "fail";
  data?: Record<string, unknown>;
}): void {
  const url = `${CONVEX_SITE_URL}/hunter/log`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).catch((err) =>
    console.warn("[convexClient] botLog fire-and-forget error:", err)
  );
}

// ─── CEV Sessions (polling sans captcha) ────────────────────────────────────
export interface CevSessionTask {
  sessionId: string;
  applicationId: string;
  integrationUrl: string;
  sessionCookie: string;
  pollIntervalMs: number;
  vowintEmail?: string;
  vowintPassword?: string;
  vowintAppUrl?: string;
  siphonedF5CookieValue?: string;
  siphonedF5CookieName?: string;
  siphonedAspNetSessionId?: string;
  siphonedUserAgent?: string;
  siphonedAt?: number;
  siphonedValidUntil?: number;
}

export async function getActiveCevSessions(): Promise<CevSessionTask[]> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-sessions`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) {
      console.warn(`[convexClient] getActiveCevSessions failed: ${res.status}`);
      return [];
    }
    return (await res.json()) as CevSessionTask[];
  } catch (err) {
    console.warn("[convexClient] getActiveCevSessions error:", err);
    return [];
  }
}

export async function recordCevSessionCheck(
  sessionId: string,
  result: "no_slot" | "slot_found" | "session_expired" | "error",
  error?: string,
): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-sessions/check`;
  try {
    await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId, result, error }),
    });
  } catch (err) {
    console.warn("[convexClient] recordCevSessionCheck error:", err);
  }
}

/**
 * Tente de "claimer" un créneau côté Convex afin de limiter les tentatives concurrentes.
 * - slotKey: identifiant unique (ex: "CEV:{center}:{category}:{YYYY-MM-DD}:{HH:mm}")
 * - maxClaims: plafond autorisé (typiquement free-1)
 * - ttlSec: durée de validité du claim (auto-expire)
 */
export async function tryClaimCevSlot(
  slotKey: string,
  maxClaims: number,
  ttlSec: number = 10,
): Promise<{ ok: boolean; count?: number; max?: number; expiresAt?: number }>
{
  const url = `${CONVEX_SITE_URL}/hunter/cev/try-claim-slot`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slotKey, maxClaims, ttlSec }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[convexClient] tryClaimCevSlot failed: ${res.status} ${text}`);
      return { ok: false };
    }
    return (await res.json()) as { ok: boolean; count?: number; max?: number; expiresAt?: number };
  } catch (err) {
    console.warn("[convexClient] tryClaimCevSlot error:", err);
    return { ok: false };
  }
}

export interface CevSetupTask {
  sessionId: string;
  applicationId: string;
  integrationUrl: string;
  pollIntervalMs: number;
  // Identifiants VOWINT (mode credentials — bot se connecte et génère l'URL autonomement)
  vowintEmail?: string;
  vowintPassword?: string;
  vowintAppUrl?: string;
  // Siphoned cookies from F5 WAF
  siphonedF5CookieValue?: string;
  siphonedF5CookieName?: string;
  siphonedAspNetSessionId?: string;
  siphonedUserAgent?: string;
  siphonedAt?: number;
  siphonedValidUntil?: number;
}

export async function resetCevSetupLock(sessionId: string): Promise<boolean> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-sessions/reset-lock`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "X-Hunter-Key": HUNTER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getPendingCevSetups(): Promise<CevSetupTask[]> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-sessions/needs-setup`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) {
      console.warn(`[convexClient] getPendingCevSetups failed: ${res.status}`);
      return [];
    }
    return (await res.json()) as CevSetupTask[];
  } catch (err) {
    console.warn("[convexClient] getPendingCevSetups error:", err);
    return [];
  }
}

/**
 * Lecture des credentials VOWINT SANS lock ni conditions de timing.
 * Retourne le premier couple vowintEmail/vowintPassword trouvé dans les sessions CEV.
 * Utilisé par le dossier-loop qui a juste besoin des credentials, pas de claimer une session.
 */
export interface CevCredentials {
  vowintEmail: string;
  vowintPassword: string;
  vowintAppUrl?: string;
  sessionId: string;
  applicationId: string;
  status: string;
  // Ajouter les champs siphonnés
  siphonedF5CookieValue?: string;
  siphonedF5CookieName?: string;
  siphonedAspNetSessionId?: string;
  siphonedUserAgent?: string;
  siphonedAt?: number;
  siphonedValidUntil?: number;
}

export async function getCevCredentials(): Promise<CevCredentials | null> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-credentials`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) {
      console.warn(`[convexClient] getCevCredentials failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as CevCredentials | null;
  } catch (err) {
    console.warn("[convexClient] getCevCredentials error:", err);
    return null;
  }
}

/**
 * Enregistre un échec de login VOWINT lors du setup d'une session CEV.
 * Incrémente loginFailCount dans Convex (persisté — survie aux redémarrages Railway).
 * Retourne { loginFailCount, paused: true } quand la session est auto-pausée (≥ 3 échecs).
 */
export async function recordCevSetupLoginFail(
  sessionId: string,
  errorDetail?: string,
): Promise<{ loginFailCount: number; paused: boolean }> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-sessions/login-fail`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "X-Hunter-Key": HUNTER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, errorDetail }),
    });
    if (!res.ok) {
      console.warn(`[convexClient] recordCevSetupLoginFail failed: ${res.status}`);
      return { loginFailCount: 0, paused: false };
    }
    return (await res.json()) as { loginFailCount: number; paused: boolean };
  } catch (err) {
    console.warn("[convexClient] recordCevSetupLoginFail error:", err);
    return { loginFailCount: 0, paused: false };
  }
}

export async function injectCevF5Cookies(
  sessionId: string,
  f5TsCookieValueOrF5CookieValue: string,
  aspNetSessionId?: string,
  userAgent?: string,
  options?: {
    f5CookieName?: string;
    validityMinutes?: number;
  }
): Promise<boolean> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-sessions/inject-f5`;
  try {
    const body = {
      sessionId,
      f5CookieValue: f5TsCookieValueOrF5CookieValue,
      aspNetSessionId,
      userAgent,
      f5CookieName: options?.f5CookieName,
      validityMinutes: options?.validityMinutes,
    };
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'X-Hunter-Key': HUNTER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('[convexClient] injectCevF5Cookies failed:', res.status);
      return false;
    }
    const data = await res.json();
    return data.ok === true;
  } catch (err) {
    console.warn('[convexClient] injectCevF5Cookies error:', err);
    return false;
  }
}

export async function injectApplicationF5Cookies(
  applicationId: string,
  f5CookieValue: string,
  aspNetSessionId?: string,
  userAgent?: string,
  options?: {
    f5CookieName?: string;
    validityMinutes?: number;
  }
): Promise<boolean> {
  const url = `${CONVEX_SITE_URL}/hunter/applications/inject-f5`;
  try {
    const body = {
      applicationId,
      f5CookieValue,
      aspNetSessionId,
      userAgent,
      f5CookieName: options?.f5CookieName,
      validityMinutes: options?.validityMinutes,
    };
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'X-Hunter-Key': HUNTER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('[convexClient] injectApplicationF5Cookies failed:', res.status);
      return false;
    }
    const data = await res.json();
    return data.ok === true;
  } catch (err) {
    console.warn('[convexClient] injectApplicationF5Cookies error:', err);
    return false;
  }
}

export async function activateCevSession(
  sessionId: string,
  sessionCookie: string,
  validUntilMs?: number,
  integrationUrl?: string, // URL découverte par le bot lors du login VOWINT (mode credentials)
): Promise<boolean> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-sessions/activate`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId, sessionCookie, validUntilMs, integrationUrl }),
    });
    if (!res.ok) {
      console.warn(`[convexClient] activateCevSession failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[convexClient] activateCevSession error:", err);
    return false;
  }
}

/**
 * Persiste la session CEV active du cevPollingLoop dans Convex.
 * Fire-and-forget — ne bloque pas le chemin critique.
 * Survie aux crashs et redémarrages Railway.
 */
export function persistCevLoopSession(
  applicationId: string,
  session: { cookies: string; validUntil: string; redirectUrl: string },
): void {
  const url = `${CONVEX_SITE_URL}/hunter/cev-loop/persist`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      applicationId,
      sessionCookie: session.cookies,
      validUntil: session.validUntil,
      redirectUrl: session.redirectUrl,
    }),
  }).catch((err) =>
    console.warn("[convexClient] persistCevLoopSession fire-and-forget error:", err)
  );
}

/**
 * Restaure la session CEV active depuis Convex au démarrage du bot.
 * Retourne la session si elle est encore en base, null sinon.
 * Le caller doit vérifier isCevSessionValid() pour confirmer que le cookie n'est pas expiré.
 */
export async function restoreCevLoopSession(
  applicationId: string,
): Promise<{ cookies: string; validUntil: string; redirectUrl: string } | null> {
  const url = `${CONVEX_SITE_URL}/hunter/cev-loop/restore?applicationId=${encodeURIComponent(applicationId)}`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      session: { cookies: string; validUntil: string; redirectUrl: string } | null;
    };
    return data.session ?? null;
  } catch (err) {
    console.warn("[convexClient] restoreCevLoopSession error:", err);
    return null;
  }
}

/**
 * Attache un document généré par le bot (ex: PDF de confirmation) au dossier.
 * Stocké dans la table `documents` avec isAdminUpload:true + verifiedByAdmin:true.
 * Visible côté client uniquement après paiement de la prime de succès.
 */
export async function attachConfirmationDoc(payload: {
  applicationId: string;
  storageId: string;
  docKey: string;
  label: string;
}): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/attach-confirmation-doc`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[convexClient] attachConfirmationDoc failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.warn("[convexClient] attachConfirmationDoc error:", err);
  }
}

// ─── Bot Config (auto-découverte endpoints CEV) ──────────────────────────────

const CEV_CONFIG_KEY = "cev_booking_config_v1";

/**
 * Configuration auto-découverte lors du premier booking HTTP réussi.
 * Persistée dans Convex — survit aux redémarrages Railway sans redéploiement.
 */
export interface CevDiscoveredConfig {
  submitEndpoint: string;        // Endpoint POST confirmé (ex: /Home/SelectSlot)
  availabilityDateKey: string;   // Clé JSON de la date dans /Home/AvailableTimeSlots (ex: "date")
  availabilityTimeKey: string;   // Clé JSON de l'heure (ex: "time")
  availabilityIdKey?: string;    // Clé JSON de l'ID slot si présent (ex: "id")
  confirmedAt: number;           // Timestamp du dernier booking réussi
  successCount: number;          // Nombre total de bookings réussis avec cette config
}

export async function loadCevBookingConfig(): Promise<CevDiscoveredConfig | null> {
  const url = `${CONVEX_SITE_URL}/hunter/bot-config?key=${encodeURIComponent(CEV_CONFIG_KEY)}`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) return null;
    const data = await res.json() as { value: string | null };
    if (!data.value) return null;
    return JSON.parse(data.value) as CevDiscoveredConfig;
  } catch (err) {
    console.warn("[convexClient] loadCevBookingConfig error:", err);
    return null;
  }
}

export async function saveCevBookingConfig(config: CevDiscoveredConfig): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/bot-config`;
  try {
    await fetchWithRetry(url, {
      method: "POST",
      headers: { "X-Hunter-Key": HUNTER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ key: CEV_CONFIG_KEY, value: JSON.stringify(config) }),
    });
  } catch (err) {
    console.warn("[convexClient] saveCevBookingConfig error:", err);
  }
}

/**
 * Uploade n'importe quel fichier (image, PDF, etc.) vers Convex Storage.
 * @param base64 — contenu encodé en base64
 * @param contentType — ex: "image/png", "application/pdf"
 */
// ─── Spain Watcher ────────────────────────────────────────────────────────────

export interface SpainWatcherConfig {
  isActive: boolean;
  portalUrl: string;
  adminEmail: string;
  intervalMin?: number;
  intervalSec?: number;
}

/**
 * Récupère la configuration du veilleur Espagne depuis Convex.
 * Retourne null si pas encore configuré ou si le watcher est inactif.
 */
export async function getSpainWatcherConfig(): Promise<SpainWatcherConfig | null> {
  const url = `${CONVEX_SITE_URL}/hunter/spain-watcher/config`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { config: SpainWatcherConfig | null };
    if (!data.config || !data.config.isActive) return null;
    return data.config;
  } catch (err) {
    console.warn("[convexClient] getSpainWatcherConfig error:", err);
    return null;
  }
}

/**
 * Envoie le résultat d'un scan du veilleur Espagne à Convex.
 * Convex se charge d'envoyer l'email si status === "found".
 */
export async function reportSpainWatcherScan(payload: {
  status: "found" | "not_found" | "error";
  slotInfo?: string;
  screenshotStorageId?: string;
  errorMessage?: string;
  applicationId?: string;    // ID Convex du dossier (worker multi-dossier)
  dossierName?: string;      // Nom du demandeur
  detectedServices?: string; // JSON string of [{serviceId, serviceName}]
  detectedSlots?: string;    // JSON string of [{id, name, slots: [{d, t, n}]}]
  scanTrace?: string;        // JSON string SpainScanTrace
}): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/spain-watcher/scan-result`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[convexClient] reportSpainWatcherScan failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.warn("[convexClient] reportSpainWatcherScan error:", err);
  }
}

// ─── Spain Watcher : rush-prep commands (CF resolve / session pre-warm) ───────

/**
 * Demande la commande rush-prep en attente depuis Convex.
 * Retourne "cf_resolve" | "session_prep" | null.
 */
export async function pollRushPrepCommand(): Promise<"cf_resolve" | "session_prep" | null> {
  const url = `${CONVEX_SITE_URL}/hunter/spain-watcher/rush-prep`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { command: "cf_resolve" | "session_prep" | null };
    return data.command ?? null;
  } catch {
    return null;
  }
}

/**
 * Acquitte une commande rush-prep et transmet le résultat au singleton Convex.
 * result = "ok" ou "error: <message>"
 */
export async function ackRushPrepCommand(result: string): Promise<void> {
  const url = `${CONVEX_SITE_URL}/hunter/spain-watcher/rush-prep`;
  try {
    await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ result }),
    });
  } catch (err) {
    console.warn("[convexClient] ackRushPrepCommand error:", err);
  }
}

// ─── Slot Discovery (dates captées / ignorées par le bot) ─────────────────────

export interface SlotDiscoveryEvent {
  applicationId: string;
  destination: string;
  office: string;
  /** Date trouvée sur le portail (YYYY-MM-DD) */
  dateFound: string;
  /** Heure trouvée (optionnel, ex: "8:00 AM") */
  timeFound?: string;
  /** "captured" = date retenue pour booking, "ignored" = date écartée */
  outcome: "captured" | "ignored";
  /** Raison de l'ignorement (ex: "after_deadline", "before_from_date", "no_time_slots") */
  reason?: string;
  /** Contexte additionnel (deadline, fenêtre admin, etc.) */
  context?: Record<string, unknown>;
  /** Mode de scan : "schedule" (nouveau booking) ou "reschedule" (reporter un RDV existant). */
  mode?: "schedule" | "reschedule";
}

/**
 * Envoie un événement de découverte de créneau au backend Convex.
 * Fire-and-forget — ne bloque pas le chemin critique du scan.
 */
export function reportSlotDiscovery(event: SlotDiscoveryEvent): void {
  const url = `${CONVEX_SITE_URL}/hunter/slot-discovery`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...event,
      discoveredAt: Date.now(),
    }),
  }).catch((err) =>
    console.warn("[convexClient] reportSlotDiscovery fire-and-forget error:", err)
  );
}

/**
 * Envoie un batch d'événements de découverte (fin de cycle de scan).
 * Fire-and-forget.
 */
export function reportSlotDiscoveryBatch(events: SlotDiscoveryEvent[]): void {
  if (events.length === 0) return;
  const url = `${CONVEX_SITE_URL}/hunter/slot-discovery/batch`;
  fetch(url, {
    method: "POST",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      events: events.map((e) => ({ ...e, discoveredAt: Date.now() })),
    }),
  }).catch((err) =>
    console.warn("[convexClient] reportSlotDiscoveryBatch fire-and-forget error:", err)
  );
}

// ─── Bot Config: lecture de configuration admin depuis Convex ─────────────────

/**
 * Lit une valeur de configuration bot depuis Convex (table botConfigs).
 * Utilisé pour piloter des flags depuis le panneau admin sans redéployer.
 * Retourne null si la clé n'existe pas ou si Convex est inaccessible.
 */
export async function getBotConfigValue(key: string): Promise<string | null> {
  const url = `${CONVEX_SITE_URL}/hunter/bot-config?key=${encodeURIComponent(key)}`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) return null;
    const data = await res.json() as { value: string | null };
    return data.value ?? null;
  } catch (err) {
    console.warn(`[convexClient] getBotConfigValue(${key}) error:`, err);
    return null;
  }
}

// ─── Early Bird Prediction: bootstrap historique ─────────────────────────────

/**
 * Récupère les timestamps d'observations de slots depuis Convex (7 derniers jours).
 * Utilisé au démarrage du refresh continu pour bootstrapper le modèle de prédiction.
 */
export async function getSlotObservationTimestamps(
  destination: string,
  office: string,
): Promise<number[]> {
  const params = new URLSearchParams({ destination, office });
  const url = `${CONVEX_SITE_URL}/hunter/slot-discovery/timestamps?${params.toString()}`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
    });
    if (!res.ok) {
      console.warn(`[convexClient] getSlotObservationTimestamps failed: ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { timestamps: number[]; count: number };
    return data.timestamps ?? [];
  } catch (err) {
    console.warn("[convexClient] getSlotObservationTimestamps error:", err);
    return [];
  }
}

export async function uploadFile(base64: string, contentType: string): Promise<string | null> {
  const url = `${CONVEX_SITE_URL}/hunter/upload-screenshot`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ base64, contentType }),
    });

    if (!res.ok) {
      console.warn(`[convexClient] File upload failed (${contentType}): ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { ok: boolean; storageId?: string };
    return data.storageId ?? null;
  } catch (err) {
    console.warn("[convexClient] File upload error:", err);
    return null;
  }
}
