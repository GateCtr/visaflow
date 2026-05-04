import * as dotenv from "dotenv";
dotenv.config();

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
    capsolverApiKey?: string;   // CapSolver API key (pour hCaptcha CEV)
    scheduleUrl?: string;
    portalApplicationId?: string;
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
  };
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

export async function sendHeartbeat(payload: {
  applicationId: string;
  result: "not_found" | "captcha" | "error" | "payment_required";
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
  channel?: "telegram" | string;
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
 * Enregistre un clic sur le bouton RDV CEV (pour tracking du rate limit 4 clics/heure).
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
 * Uploade n'importe quel fichier (image, PDF, etc.) vers Convex Storage.
 * @param base64 — contenu encodé en base64
 * @param contentType — ex: "image/png", "application/pdf"
 */
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
