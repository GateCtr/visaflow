/**
 * france-handshake-parse.test.ts — Tests property-based du parse handshake
 * (feature france-visa-hunter, task 4.2).
 *
 * Fonctions sous test (helpers PURS, aucun effet de bord, aucun réseau) de
 * `src/france/france-handshake.ts` :
 *   - `parseHandshakeHeaders(headers)` : extrait `handshakeToken` depuis
 *     `x-gouv-handshake` et `appId` depuis `x-gouv-app-id`.
 *   - `isHandshakeValid(headers)` : vrai ssi les deux jetons sont non vides.
 *
 * Propriétés couvertes :
 *   - Property 1 : Parse du handshake extrait les deux jetons —
 *     `handshakeToken` = `x-gouv-handshake`, `appId` = `x-gouv-app-id`
 *     (Requirements 1.2, 1.4).
 *   - Property 2 : Validité du handshake ssi les deux jetons non vides
 *     (Requirements 1.3, 1.5).
 *
 * fast-check avec `{ numRuns: 100 }` conformément au design.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isHandshakeValid,
  parseHandshakeHeaders,
} from "../france/france-handshake.js";

const NUM_RUNS = 100;

const HANDSHAKE_HEADER = "x-gouv-handshake";
const APP_ID_HEADER = "x-gouv-app-id";
const RATE_LIMIT_HEADER = "x-gouv-limit";

// ─── Générateurs ─────────────────────────────────────────────────────────────

/**
 * Génère une valeur de jeton non vide (non blanche après trim), pour couvrir le
 * cas d'un handshake valide.
 */
const nonEmptyTokenArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((s) => s.trim().length > 0);

/**
 * Génère une valeur « vide au sens de la validité » : chaîne vide ou seulement
 * composée d'espaces/whitespace.
 */
const blankTokenArb: fc.Arbitrary<string> = fc.constantFrom(
  "",
  " ",
  "   ",
  "\t",
  "\n",
  " \t \n ",
);

/**
 * Construit un `Record<string, string>` de headers à partir de valeurs
 * optionnelles pour chaque header pertinent. Une valeur `undefined` signifie
 * que le header est absent.
 */
function buildHeaders(opts: {
  handshake?: string;
  appId?: string;
  rateLimit?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.handshake !== undefined) headers[HANDSHAKE_HEADER] = opts.handshake;
  if (opts.appId !== undefined) headers[APP_ID_HEADER] = opts.appId;
  if (opts.rateLimit !== undefined) headers[RATE_LIMIT_HEADER] = opts.rateLimit;
  return headers;
}

// ─── Property 1 : parse extrait les deux jetons ──────────────────────────────

describe("parseHandshakeHeaders — Property 1 : extraction des deux jetons", () => {
  // Feature: france-visa-hunter, Property 1: Parse du handshake extrait les deux
  // jetons — handshakeToken = x-gouv-handshake, appId = x-gouv-app-id.
  // Validates: Requirements 1.2, 1.4
  it("extrait handshakeToken = x-gouv-handshake et appId = x-gouv-app-id", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (handshake, appId) => {
        const headers = buildHeaders({ handshake, appId });
        const authState = parseHandshakeHeaders(headers);
        expect(authState.handshakeToken).toBe(handshake);
        expect(authState.appId).toBe(appId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 1: Parse du handshake extrait les deux
  // jetons — headers absents normalisés en chaîne vide, x-gouv-limit copié.
  // Validates: Requirements 1.2, 1.4
  it("normalise les jetons absents en chaîne vide et copie x-gouv-limit s'il est présent", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (handshake, appId, rateLimit) => {
          const headers = buildHeaders({ handshake, appId, rateLimit });
          const authState = parseHandshakeHeaders(headers);
          expect(authState.handshakeToken).toBe(handshake ?? "");
          expect(authState.appId).toBe(appId ?? "");
          if (rateLimit === undefined) {
            expect(authState.rateLimit).toBeUndefined();
          } else {
            expect(authState.rateLimit).toBe(rateLimit);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property 2 : validité ssi les deux jetons non vides ─────────────────────

describe("isHandshakeValid — Property 2 : validité ssi les deux jetons non vides", () => {
  // Feature: france-visa-hunter, Property 2: Validité du handshake ssi les deux
  // jetons (x-gouv-handshake ET x-gouv-app-id) sont non vides.
  // Validates: Requirements 1.3, 1.5
  it("retourne true quand les deux jetons sont non vides", () => {
    fc.assert(
      fc.property(nonEmptyTokenArb, nonEmptyTokenArb, (handshake, appId) => {
        const headers = buildHeaders({ handshake, appId });
        expect(isHandshakeValid(headers)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 2: Validité du handshake ssi les deux
  // jetons non vides — un jeton vide/blanc ou absent invalide le handshake.
  // Validates: Requirements 1.3, 1.5
  it("retourne false dès qu'au moins un jeton est vide, blanc ou absent", () => {
    const maybeMissingNonEmpty: fc.Arbitrary<string | undefined> = fc.option(
      nonEmptyTokenArb,
      { nil: undefined },
    );
    fc.assert(
      fc.property(
        // handshake : soit blanc/absent, soit valide
        fc.oneof(blankTokenArb, maybeMissingNonEmpty),
        fc.oneof(blankTokenArb, maybeMissingNonEmpty),
        (handshake, appId) => {
          const headers = buildHeaders({ handshake, appId });
          const handshakeOk = (handshake ?? "").trim().length > 0;
          const appIdOk = (appId ?? "").trim().length > 0;
          const expected = handshakeOk && appIdOk;
          expect(isHandshakeValid(headers)).toBe(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 2: Validité du handshake ssi les deux
  // jetons non vides — cohérence avec parseHandshakeHeaders.
  // Validates: Requirements 1.3, 1.5
  it("est équivalent au test des deux champs extraits par parseHandshakeHeaders (après trim)", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (handshake, appId) => {
          const headers = buildHeaders({ handshake, appId });
          const authState = parseHandshakeHeaders(headers);
          const expected =
            authState.handshakeToken.trim().length > 0 &&
            authState.appId.trim().length > 0;
          expect(isHandshakeValid(headers)).toBe(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
