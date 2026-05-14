import { proxyPool } from "../browser.js";

const accountRestrictedUntil = new Map<string, number>();
const accountRestrictionAttempts = new Map<string, number>();

export function isAccountRestricted(username: string): boolean {
  const until = accountRestrictedUntil.get(username.toLowerCase());
  return until !== undefined && Date.now() < until;
}

/** Timestamp fin de restriction (ms), si le compte est encore restreint. */
export function getAccountRestrictionDeadline(username: string): number | undefined {
  return accountRestrictedUntil.get(username.toLowerCase());
}

function getRestrictionAttemptCount(username: string): number {
  return accountRestrictionAttempts.get(username.toLowerCase()) || 0;
}

function incrementRestrictionAttempt(username: string): void {
  const key = username.toLowerCase();
  const current = getRestrictionAttemptCount(username);
  accountRestrictionAttempts.set(key, current + 1);
}

function resetRestrictionAttempts(username: string): void {
  accountRestrictionAttempts.delete(username.toLowerCase());
}

function calculateRestrictionDuration(attemptCount: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  const baseDuration = 60 * 60 * 1000;
  const maxDuration = 24 * 60 * 60 * 1000;

  if (attemptCount <= 0) {
    return baseDuration;
  }

  const exponentialDuration = baseDuration * Math.pow(2, attemptCount - 1);
  return Math.min(exponentialDuration, maxDuration);
}

export function markAccountRestricted(username: string, durationMs?: number, retryAfterHeader?: string): void {
  const key = username.toLowerCase();

  incrementRestrictionAttempt(username);
  const attemptCount = getRestrictionAttemptCount(username);

  const calculatedDuration = durationMs ?? calculateRestrictionDuration(attemptCount, retryAfterHeader);

  const until = Date.now() + calculatedDuration;
  accountRestrictedUntil.set(key, until);

  const endTime = new Date(until).toISOString().slice(11, 16);
  const durationMinutes = Math.round(calculatedDuration / 60000);
  const attemptInfo = attemptCount > 1 ? ` (tentative ${attemptCount}, backoff exponentiel)` : "";

  console.warn(`[usa] 🔒 Compte ${username} marqué "restreint" jusqu'à ${endTime} UTC (~${durationMinutes} min${attemptInfo})`);

  proxyPool.releaseStickyProxy(username);
  console.log(`[usa] 🔄 Sticky proxy libéré pour ${username} — nouvelle IP au prochain cycle`);

  setTimeout(() => {
    if (!isAccountRestricted(username)) {
      resetRestrictionAttempts(username);
      console.log(`[usa] ✅ Compte ${username} : restriction expirée, compteur réinitialisé`);
    }
  }, calculatedDuration + 1000);
}

export function isRestrictedBody(body: string): boolean {
  const lower = body.toLowerCase();

  const patterns = [
    /temporarily/i,
    /restricted/i,
    /access denied/i,
    /account (is |has been )?locked/i,
    /too many/i,
    /rate limit/i,
    /suspended/i,
    /try again later/i,
    /cooldown/i,
    /wait.*minutes/i,
    /please wait/i,
    /temporary block/i,
    /security measure/i,
    /excessive attempts/i,
    /multiple failed/i,
  ];

  return patterns.some((pattern) => pattern.test(lower));
}
