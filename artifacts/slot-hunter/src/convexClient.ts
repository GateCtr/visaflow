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
    scheduleUrl?: string;
    checkCount?: number;
    lastResult?: string;
  };
  portalUrl: string | null;
  portalName: string | null;
  portalDashboardUrl: string | null;
  portalAppointmentUrl: string | null;
  portalScheduleUrl: string | null;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastError = err as Error;
      const delay = 1000 * (i + 1);
      console.warn(`[convexClient] fetch attempt ${i + 1} failed, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error("fetch failed after retries");
}

export async function getActiveJobs(): Promise<HunterJob[]> {
  const url = `${CONVEX_SITE_URL}/hunter/jobs`;
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "X-Hunter-Key": HUNTER_API_KEY,
      "Content-Type": "application/json",
    },
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
  result: "not_found" | "captcha" | "error";
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

export async function uploadScreenshot(base64: string): Promise<string | null> {
  const url = `${CONVEX_SITE_URL}/hunter/upload-screenshot`;
  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "X-Hunter-Key": HUNTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ base64, contentType: "image/png" }),
    });

    if (!res.ok) {
      console.warn(`[convexClient] Screenshot upload failed: ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { ok: boolean; storageId?: string };
    return data.storageId ?? null;
  } catch (err) {
    console.warn("[convexClient] Screenshot upload error:", err);
    return null;
  }
}
