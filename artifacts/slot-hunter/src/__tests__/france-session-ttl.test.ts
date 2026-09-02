/**
 * france-session-ttl.test.ts — Tests property-based du TTL de session
 * (feature france-visa-hunter, task 6.2).
 *
 * Cibles : les fonctions PURES de `src/france/france-session.ts` :
 *   - `isSessionExpired(session, nowMs)`  → Property 11 (expiration 30 min).
 *   - `shouldRenewSession(session, nowMs)` → Property 12 (renouvellement 25 min).
 *
 * Le temps est INJECTÉ via `nowMs` : aucun `Date.now()`, tests déterministes.
 *
 * On vérifie chaque property sur ≥ 100 itérations via `fast-check`
 * (`{ numRuns: 100 }`), en balayant explicitement les instants autour du seuil
 * (avant, exactement au seuil, après). Quelques exemples ancrés complètent les
 * bornes (0, seuil - 1, seuil, seuil + 1).
 *
 * Validates: Requirements 4.4, 5.1, 5.2
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ReservationSession } from "../france/france-types.js";
import {
  isSessionExpired,
  shouldRenewSession,
} from "../france/france-session.js";
import {
  FRANCE_SESSION_RENEW_MS,
  FRANCE_SESSION_TTL_MS,
} from "../france/france-config.js";

/**
 * Borne haute des horodatages générés : reste dans les entiers sûrs tout en
 * couvrant très largement une année de millisecondes.
 */
const MAX_OPENED_AT_MS = 10 ** 12;

/**
 * Générateur d'`openedAtMs` : entier positif borné, représentant un instant
 * d'ouverture réaliste (ms depuis l'epoch, ou horloge monotone injectée).
 */
const openedAtArb: fc.Arbitrary<number> = fc.integer({
  min: 0,
  max: MAX_OPENED_AT_MS,
});

/**
 * Générateur de décalage `elapsed = nowMs - openedAtMs`, centré autour d'un
 * seuil : couvre le négatif (horloge incohérente), zéro, le voisinage immédiat
 * du seuil (±2 ms) et de larges écarts avant/après.
 */
function elapsedAround(thresholdMs: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: -60_000, max: -1 }),
    fc.constant(0),
    fc.integer({ min: thresholdMs - 2, max: thresholdMs + 2 }),
    fc.integer({ min: 1, max: thresholdMs - 1 }),
    fc.integer({ min: thresholdMs, max: thresholdMs + 60 * 60_000 }),
  );
}

/**
 * Construit une session dont le `ttlMs` est le TTL canonique (30 min), afin
 * d'exercer la sémantique exacte de Property 11 (seuil = FRANCE_SESSION_TTL_MS).
 */
function sessionAt(openedAtMs: number): ReservationSession {
  return {
    sessionId: "test-session",
    openedAtMs,
    ttlMs: FRANCE_SESSION_TTL_MS,
  };
}

describe("isSessionExpired — Property 11 : expiration à 30 minutes exactement", () => {
  // Feature: france-visa-hunter, Property 11: Expiration de session à 30 minutes exactement —
  // isSessionExpired retourne true ssi (nowMs - openedAtMs) >= FRANCE_SESSION_TTL_MS (30 min).
  // Validates: Requirements 4.4, 5.1
  it("true ssi (nowMs - openedAtMs) >= 30 min", () => {
    fc.assert(
      fc.property(
        openedAtArb,
        elapsedAround(FRANCE_SESSION_TTL_MS),
        (openedAtMs, elapsed) => {
          const nowMs = openedAtMs + elapsed;
          const expected = nowMs - openedAtMs >= FRANCE_SESSION_TTL_MS;
          expect(isSessionExpired(sessionAt(openedAtMs), nowMs)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: france-visa-hunter, Property 11: le seuil est atteint EXACTEMENT à 30 min —
  // pas expiré à (TTL - 1), expiré à TTL exact.
  // Validates: Requirements 4.4, 5.1
  it("frontière exacte au TTL (seuil - 1 → false, seuil → true)", () => {
    fc.assert(
      fc.property(openedAtArb, (openedAtMs) => {
        const session = sessionAt(openedAtMs);
        expect(
          isSessionExpired(session, openedAtMs + FRANCE_SESSION_TTL_MS - 1),
        ).toBe(false);
        expect(
          isSessionExpired(session, openedAtMs + FRANCE_SESSION_TTL_MS),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Exemples ancrés (openedAtMs = 0).
  it("exemples ancrés : 0, seuil-1, seuil, seuil+1", () => {
    const session = sessionAt(0);
    expect(isSessionExpired(session, 0)).toBe(false);
    expect(isSessionExpired(session, FRANCE_SESSION_TTL_MS - 1)).toBe(false);
    expect(isSessionExpired(session, FRANCE_SESSION_TTL_MS)).toBe(true);
    expect(isSessionExpired(session, FRANCE_SESSION_TTL_MS + 1)).toBe(true);
  });
});

describe("shouldRenewSession — Property 12 : renouvellement anticipé à 25 minutes", () => {
  // Feature: france-visa-hunter, Property 12: Renouvellement anticipé à 25 minutes —
  // shouldRenewSession retourne true ssi (nowMs - openedAtMs) >= FRANCE_SESSION_RENEW_MS (25 min).
  // Validates: Requirements 5.2
  it("true ssi (nowMs - openedAtMs) >= 25 min", () => {
    fc.assert(
      fc.property(
        openedAtArb,
        elapsedAround(FRANCE_SESSION_RENEW_MS),
        (openedAtMs, elapsed) => {
          const nowMs = openedAtMs + elapsed;
          const expected = nowMs - openedAtMs >= FRANCE_SESSION_RENEW_MS;
          expect(shouldRenewSession(sessionAt(openedAtMs), nowMs)).toBe(
            expected,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: france-visa-hunter, Property 12: le seuil est atteint EXACTEMENT à 25 min —
  // pas de renouvellement à (RENEW - 1), renouvellement à RENEW exact.
  // Validates: Requirements 5.2
  it("frontière exacte au seuil de renouvellement (seuil - 1 → false, seuil → true)", () => {
    fc.assert(
      fc.property(openedAtArb, (openedAtMs) => {
        const session = sessionAt(openedAtMs);
        expect(
          shouldRenewSession(session, openedAtMs + FRANCE_SESSION_RENEW_MS - 1),
        ).toBe(false);
        expect(
          shouldRenewSession(session, openedAtMs + FRANCE_SESSION_RENEW_MS),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: france-visa-hunter, Property 12: le renouvellement précède l'expiration —
  // pour tout instant, shouldRenewSession implique (ou anticipe) isSessionExpired,
  // le seuil de renouvellement (25 min) étant < TTL (30 min).
  // Validates: Requirements 5.1, 5.2
  it("le renouvellement se déclenche avant l'expiration (RENEW < TTL)", () => {
    expect(FRANCE_SESSION_RENEW_MS).toBeLessThan(FRANCE_SESSION_TTL_MS);
    fc.assert(
      fc.property(openedAtArb, (openedAtMs) => {
        const session = sessionAt(openedAtMs);
        if (isSessionExpired(session, openedAtMs + FRANCE_SESSION_TTL_MS)) {
          expect(
            shouldRenewSession(session, openedAtMs + FRANCE_SESSION_TTL_MS),
          ).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Exemples ancrés (openedAtMs = 0).
  it("exemples ancrés : 0, seuil-1, seuil, seuil+1", () => {
    const session = sessionAt(0);
    expect(shouldRenewSession(session, 0)).toBe(false);
    expect(shouldRenewSession(session, FRANCE_SESSION_RENEW_MS - 1)).toBe(false);
    expect(shouldRenewSession(session, FRANCE_SESSION_RENEW_MS)).toBe(true);
    expect(shouldRenewSession(session, FRANCE_SESSION_RENEW_MS + 1)).toBe(true);
  });
});
