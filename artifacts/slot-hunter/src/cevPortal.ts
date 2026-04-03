import fetch from 'node-fetch';
import { botLog } from './convexClient';

const CEV_BASE = 'https://appointment.cloud.diplomatie.be';

export interface CevSession {
  cookies: string;
  validUntil: string;
  redirectUrl: string;
}

export interface TimeSlot {
  date: string;
  time: string;
  available: boolean;
  raw: unknown;
}

export interface CevPollResult {
  hasSlots: boolean;
  slots: TimeSlot[];
  error?: string;
}

export type CevCaptchaResult =
  | { status: 'no_availability' }
  | { status: 'session_error'; error: string }
  | { status: 'ready'; session: CevSession };

/**
 * After Playwright has established a CEV session (POST from VOWINT blob → /Captcha),
 * solve hCaptcha and submit. The redirectUrl in the response tells us immediately
 * whether slots exist:
 *
 *   redirectUrl contains "NoAvailability" → no slots → status: 'no_availability'
 *   redirectUrl is a calendar/home page   → slots exist → status: 'ready'
 *
 * Flow:
 *  VOWINT blob POST → /Captcha (sets ASP.NET session cookie)
 *  → solve hCaptcha externally (2captcha/capsolver)
 *  → POST /Captcha/SetCaptchaToken { captcha: token }
 *  → receive { validUntil, redirectUrl }
 *  → redirectUrl determines availability immediately
 */
export async function completeCevCaptcha(
  sessionCookies: string,
  hcaptchaToken: string,
  clientId: string
): Promise<CevCaptchaResult> {
  botLog('cev_captcha_submit', { clientId, cookieLen: sessionCookies.length });

  try {
    const res = await fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': sessionCookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${CEV_BASE}/Captcha`,
        'Origin': CEV_BASE,
      },
      body: new URLSearchParams({ captcha: hcaptchaToken }).toString(),
    });

    if (!res.ok) {
      botLog('cev_captcha_error', { clientId, status: res.status });
      return { status: 'session_error', error: `HTTP_${res.status}` };
    }

    const data = await res.json() as { validUntil?: string; redirectUrl?: string };

    if (!data.validUntil || !data.redirectUrl) {
      botLog('cev_captcha_bad_response', { clientId, data });
      return { status: 'session_error', error: 'BAD_RESPONSE' };
    }

    // /Integration/Error/NoAvailability → no slots right now
    if (data.redirectUrl.includes('NoAvailability')) {
      botLog('cev_no_availability', { clientId, redirectUrl: data.redirectUrl });
      return { status: 'no_availability' };
    }

    // Any other redirect = slots are available
    botLog('cev_slots_available', { clientId, validUntil: data.validUntil, redirectUrl: data.redirectUrl });

    return {
      status: 'ready',
      session: {
        cookies: sessionCookies,
        validUntil: data.validUntil,
        redirectUrl: data.redirectUrl,
      },
    };
  } catch (err) {
    botLog('cev_captcha_exception', { clientId, error: String(err) });
    return { status: 'session_error', error: String(err) };
  }
}

/**
 * Poll /Home/AvailableTimeSlots with the session cookie.
 * Returns available slots or empty array if none.
 *
 * The POST body format for AvailableTimeSlots is not yet fully confirmed —
 * captured from the JS bundle: `callPost("/Home/AvailableTimeSlots", n, t, i)`
 * We send an empty object first; update once the exact schema is captured.
 */
export async function pollCevSlots(
  session: CevSession,
  clientId: string,
  requestBody: Record<string, unknown> = {}
): Promise<CevPollResult> {
  try {
    const res = await fetch(`${CEV_BASE}/Home/AvailableTimeSlots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': session.cookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${CEV_BASE}${session.redirectUrl}`,
        'Origin': CEV_BASE,
      },
      body: JSON.stringify(requestBody),
    });

    if (res.status === 302 || res.redirected) {
      const loc = res.url;
      if (loc.includes('NoAvailability')) {
        botLog('cev_no_slots', { clientId });
        return { hasSlots: false, slots: [] };
      }
      if (loc.includes('SessionExpired')) {
        botLog('cev_session_expired', { clientId });
        return { hasSlots: false, slots: [], error: 'SESSION_EXPIRED' };
      }
    }

    if (!res.ok) {
      botLog('cev_poll_error', { clientId, status: res.status });
      return { hasSlots: false, slots: [], error: `HTTP_${res.status}` };
    }

    const raw = await res.json();
    const slots = parseSlots(raw);
    const hasSlots = slots.some(s => s.available);

    botLog('cev_poll_result', { clientId, hasSlots, slotCount: slots.length });

    return { hasSlots, slots };
  } catch (err) {
    botLog('cev_poll_exception', { clientId, error: String(err) });
    return { hasSlots: false, slots: [], error: String(err) };
  }
}

/**
 * Check if the CEV session is still valid (hasn't expired).
 */
export function isCevSessionValid(session: CevSession): boolean {
  const validUntil = new Date(session.validUntil).getTime();
  const now = Date.now();
  const bufferMs = 60_000;
  return validUntil - now > bufferMs;
}

/**
 * Parse the raw response from /Home/AvailableTimeSlots.
 * Schema TBD — will be updated once first live capture is made.
 * Currently handles: array of objects, or object with slots array.
 */
function parseSlots(raw: unknown): TimeSlot[] {
  if (!raw) return [];

  const items: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>).slots)
      ? (raw as Record<string, unknown>).slots as unknown[]
      : [raw];

  return items.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      date: String(r.date ?? r.Date ?? r.day ?? ''),
      time: String(r.time ?? r.Time ?? r.hour ?? ''),
      available: Boolean(r.available ?? r.Available ?? r.isAvailable ?? true),
      raw: item,
    };
  });
}

/**
 * Playwright interception helper — call this in the Playwright session
 * that handles the VOWINT blob click to capture the CEV session POST params.
 *
 * Usage in playwright session:
 *   const cevParams = await interceptCevPost(page);
 *   // then use cevParams.cookies to poll
 */
export function buildCevInterceptInstructions(): string {
  return `
// INJECT IN PLAYWRIGHT before clicking "Prendre rendez-vous":
page.on('request', async (request) => {
  if (request.url().includes('appointment.cloud.diplomatie.be/Captcha') &&
      request.method() === 'POST') {
    console.log('CEV_POST_INTERCEPTED:', {
      url: request.url(),
      postData: request.postData(),
      headers: request.headers(),
    });
  }
});

page.on('response', async (response) => {
  if (response.url().includes('appointment.cloud.diplomatie.be/Captcha')) {
    const cookies = response.headers()['set-cookie'];
    console.log('CEV_SESSION_COOKIES:', cookies);
  }
});
  `.trim();
}
