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
  botLog({ applicationId: clientId, step: 'cev_captcha_submit', status: 'ok', data: { cookieLen: sessionCookies.length } });

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
      botLog({ applicationId: clientId, step: 'cev_captcha_error', status: 'fail', data: { httpStatus: res.status } });
      return { status: 'session_error', error: `HTTP_${res.status}` };
    }

    const data = await res.json() as { validUntil?: string; redirectUrl?: string };

    if (!data.validUntil || !data.redirectUrl) {
      botLog({ applicationId: clientId, step: 'cev_captcha_bad_response', status: 'fail', data: { response: String(data) } });
      return { status: 'session_error', error: 'BAD_RESPONSE' };
    }

    // /Integration/Error/NoAvailability → no slots right now
    if (data.redirectUrl.includes('NoAvailability')) {
      botLog({ applicationId: clientId, step: 'cev_no_availability', status: 'ok', data: { redirectUrl: data.redirectUrl } });
      return { status: 'no_availability' };
    }

    // Any other redirect = slots are available
    botLog({ applicationId: clientId, step: 'cev_slots_available', status: 'ok', data: { validUntil: data.validUntil, redirectUrl: data.redirectUrl } });

    return {
      status: 'ready',
      session: {
        cookies: sessionCookies,
        validUntil: data.validUntil,
        redirectUrl: data.redirectUrl,
      },
    };
  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_captcha_exception', status: 'fail', data: { error: String(err) } });
    return { status: 'session_error', error: String(err) };
  }
}

/**
 * Poll /Home/AvailableTimeSlots with the session cookie.
 * Used during the window between captcha solves (session stays alive).
 * No additional VOWINT clicks needed during this phase.
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

    if (res.redirected) {
      if (res.url.includes('NoAvailability')) {
        botLog({ applicationId: clientId, step: 'cev_poll_no_slots', status: 'ok' });
        return { hasSlots: false, slots: [] };
      }
      if (res.url.includes('SessionExpired')) {
        botLog({ applicationId: clientId, step: 'cev_session_expired', status: 'warn' });
        return { hasSlots: false, slots: [], error: 'SESSION_EXPIRED' };
      }
    }

    if (!res.ok) {
      botLog({ applicationId: clientId, step: 'cev_poll_error', status: 'fail', data: { httpStatus: res.status } });
      return { hasSlots: false, slots: [], error: `HTTP_${res.status}` };
    }

    const raw = await res.json();
    const slots = parseSlots(raw);
    const hasSlots = slots.some(s => s.available);

    botLog({ applicationId: clientId, step: 'cev_poll_result', status: 'ok', data: { hasSlots, slotCount: slots.length } });
    return { hasSlots, slots };
  } catch (err) {
    botLog({ applicationId: clientId, step: 'cev_poll_exception', status: 'fail', data: { error: String(err) } });
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
