/**
 * Booking Retry V3 — Logique de retry après échec 409 (slot pris).
 *
 * RESPONSABILITÉ UNIQUE :
 *   Décider si on re-scanne immédiatement après un 409, et combien de fois.
 *   Le 409 signifie qu'un concurrent a booké le slot avant nous.
 *
 * STRATÉGIE :
 *   - 1er 409 → re-scan IMMÉDIAT (nouveau getSlotTime, le mois peut avoir d'autres slots)
 *   - 2ème 409 → re-scan après 2s (la concurrence est rude)
 *   - 3ème 409 → abandon de ce cycle (attendre le prochain intervalle de l'orchestrator)
 *   - Max 3 retries par cycle de scan (éviter boucle infinie)
 *
 * USAGE :
 *   const retry = createRetryTracker();
 *   while (retry.shouldRetry()) {
 *     const slot = await scanMultipleMonths(...);
 *     if (!slot) break;
 *     const result = await bookSlotDirect(...);
 *     if (result.success) break;
 *     if (result.slotTaken) { retry.recordAttempt(); await retry.waitBeforeRetry(); }
 *     else break; // Autre erreur (non-retryable)
 *   }
 */

import { sleep } from "../anti-detection/human-timing.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Tracker de retry pour un cycle de scan. */
export interface RetryTracker {
  /** Doit-on réessayer ? */
  shouldRetry(): boolean;
  /** Enregistre une tentative échouée (409). */
  recordAttempt(): void;
  /** Attend le délai approprié avant le prochain retry. */
  waitBeforeRetry(): Promise<void>;
  /** Nombre de tentatives effectuées. */
  readonly attempts: number;
  /** Nombre max de retries. */
  readonly maxRetries: number;
}

/** Configuration du retry. */
export interface RetryConfig {
  /** Nombre max de retries (défaut: 3). */
  maxRetries?: number;
  /** Délais entre les retries (ms). Index = numéro du retry (0-based). */
  delays?: number[];
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Crée un tracker de retry pour un cycle de scan.
 * À instancier au début de chaque cycle — reset automatique.
 */
export function createRetryTracker(config?: RetryConfig): RetryTracker {
  const maxRetries = config?.maxRetries ?? 3;
  const delays = config?.delays ?? [0, 2000, 4000]; // Immédiat, 2s, 4s
  let attempts = 0;

  return {
    shouldRetry(): boolean {
      return attempts < maxRetries;
    },

    recordAttempt(): void {
      attempts++;
      console.log(`[booking-retry] 🔄 409 retry #${attempts}/${maxRetries}`);
    },

    async waitBeforeRetry(): Promise<void> {
      const delayMs = delays[Math.min(attempts - 1, delays.length - 1)] ?? 2000;
      if (delayMs > 0) {
        console.log(`[booking-retry] ⏳ Attente ${delayMs}ms avant retry...`);
        await sleep(delayMs);
      }
    },

    get attempts() {
      return attempts;
    },

    get maxRetries() {
      return maxRetries;
    },
  };
}

/**
 * Détermine si une erreur est retryable (409 = oui, reste = non).
 */
export function isRetryableError(statusCode: number): boolean {
  return statusCode === 409;
}
