/**
 * Erreurs HTTP / portail levées pendant les scans USA.
 */

export class RateLimitError extends Error {
  constructor(public readonly endpoint: string, public readonly retryAfterMs?: number) {
    super(`Rate-limit (429) sur ${endpoint}`);
    this.name = "RateLimitError";
  }
}

export class AccountBlockedError extends Error {
  constructor(public readonly endpoint: string) {
    super(`Accès refusé (403) sur ${endpoint} — compte potentiellement bloqué`);
    this.name = "AccountBlockedError";
  }
}

export class TokenExpiredError extends Error {
  constructor() {
    super("Token JWT expiré en cours de scan (401)");
    this.name = "TokenExpiredError";
  }
}

export class AccountRestrictedError extends Error {
  constructor(
    public readonly retryAfterMs?: number,
    public readonly retryAfterHeader?: string,
  ) {
    const durationMs = retryAfterMs ?? 60 * 60 * 1000;
    super(`Compte temporairement restreint par le portail — attendre ${Math.round(durationMs / 60000)} min`);
    this.name = "AccountRestrictedError";
  }
}
