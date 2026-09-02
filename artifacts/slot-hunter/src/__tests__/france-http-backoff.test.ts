/**
 * france-http-backoff.test.ts — Test property-based du backoff exponentiel
 * (feature france-visa-hunter, task 2.2).
 *
 * Cible : la fonction PURE `computeBackoffMs(attempt)` de
 * `src/france/france-http.ts`, spécifiée par le design comme
 * `FRANCE_RETRY_BACKOFF_MS * 2^attempt` (soit `2000 * 2^attempt`).
 *
 * On vérifie la Property 3 (Backoff exponentiel déterministe) sur ≥ 100
 * itérations via `fast-check` (`{ numRuns: 100 }`), plus quelques exemples
 * ancrés (attempt 0, 1, 2, 3) pour la lisibilité.
 *
 * L'espace d'entrée est borné à `attempt ∈ [0, 30]` : au-delà, `2^attempt`
 * dépasse `Number.MAX_SAFE_INTEGER` et la comparaison entière perd son sens.
 * Cette borne couvre très largement `FRANCE_MAX_RETRIES` (3) et toute
 * escalade réaliste de retries.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { computeBackoffMs } from "../france/france-http.js";
import { FRANCE_RETRY_BACKOFF_MS } from "../france/france-config.js";

/** Borne haute de l'espace d'entrée : reste dans les entiers sûrs. */
const MAX_ATTEMPT = 30;

describe("computeBackoffMs — backoff exponentiel déterministe", () => {
  // Feature: france-visa-hunter, Property 3: Backoff exponentiel déterministe —
  // pour tout attempt >= 0, delay = 2000 * 2^attempt (= FRANCE_RETRY_BACKOFF_MS * 2^attempt).
  // Validates: Requirements 1.10, 4.5, 5.5, 11.5, 11.6
  it("delay = FRANCE_RETRY_BACKOFF_MS * 2^attempt pour tout attempt >= 0", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_ATTEMPT }), (attempt) => {
        const expected = FRANCE_RETRY_BACKOFF_MS * 2 ** attempt;
        expect(computeBackoffMs(attempt)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: france-visa-hunter, Property 3: déterminisme — même entrée, même sortie.
  // Validates: Requirements 1.10, 11.5
  it("est déterministe (même attempt → même délai)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_ATTEMPT }), (attempt) => {
        expect(computeBackoffMs(attempt)).toBe(computeBackoffMs(attempt));
      }),
      { numRuns: 100 },
    );
  });

  // Feature: france-visa-hunter, Property 3: doublement à chaque tentative —
  // delay(attempt + 1) = 2 * delay(attempt).
  // Validates: Requirements 1.10, 11.5, 11.6
  it("double à chaque tentative suivante", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_ATTEMPT - 1 }), (attempt) => {
        expect(computeBackoffMs(attempt + 1)).toBe(2 * computeBackoffMs(attempt));
      }),
      { numRuns: 100 },
    );
  });

  // Exemples ancrés : base 2000 ms, puis 4000, 8000, 16000.
  it("produit les valeurs attendues pour les premières tentatives", () => {
    expect(computeBackoffMs(0)).toBe(2_000);
    expect(computeBackoffMs(1)).toBe(4_000);
    expect(computeBackoffMs(2)).toBe(8_000);
    expect(computeBackoffMs(3)).toBe(16_000);
  });
});
