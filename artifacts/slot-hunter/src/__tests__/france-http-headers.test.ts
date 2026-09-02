/**
 * france-http-headers.test.ts — Tests property-based des headers anti-bot
 * (feature france-visa-hunter, task 2.3).
 *
 * Fonction sous test : `buildRequestHeaders(auth, method)` de
 * `src/france/france-http.ts` (helper PUR, aucun effet de bord).
 *
 * Propriétés couvertes :
 *   - Property 4 : Headers anti-bot toujours présents — `x-gouv-app-id` =
 *     `authState.appId` et `x-gouv-web` = `fr.gouv.consulat`, quelle que soit
 *     la méthode HTTP (Requirement 1.6).
 *   - Property 5 : `x-csrf-token` sur les requêtes POST/PUT — sa valeur est le
 *     `handshakeToken` courant, et il est absent sur GET/HEAD (Requirement 1.7).
 *
 * fast-check avec `{ numRuns: 100 }` conformément au design.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildRequestHeaders } from "../france/france-http.js";
import { FRANCE_GOUV_WEB } from "../france/france-config.js";
import type { FranceAuthState, FranceHttpMethod } from "../france/france-types.js";

const NUM_RUNS = 100;

/** Toutes les méthodes HTTP supportées par le client France. */
const ALL_METHODS: readonly FranceHttpMethod[] = ["GET", "POST", "PUT", "HEAD"];

/** Méthodes considérées « sensibles » : elles portent le x-csrf-token. */
const CSRF_METHODS: readonly FranceHttpMethod[] = ["POST", "PUT"];

// ─── Générateurs ─────────────────────────────────────────────────────────────

/**
 * Génère un `FranceAuthState` arbitraire. Les jetons peuvent être vides pour
 * couvrir tous les cas : la fonction doit refléter fidèlement les valeurs
 * fournies sans les altérer.
 */
const authStateArb: fc.Arbitrary<FranceAuthState> = fc.record({
  handshakeToken: fc.string(),
  appId: fc.string(),
  rateLimit: fc.option(fc.string(), { nil: undefined }),
});

const methodArb: fc.Arbitrary<FranceHttpMethod> = fc.constantFrom(...ALL_METHODS);
const csrfMethodArb: fc.Arbitrary<FranceHttpMethod> = fc.constantFrom(...CSRF_METHODS);
const nonCsrfMethodArb: fc.Arbitrary<FranceHttpMethod> = fc.constantFrom("GET", "HEAD");

// ─── Property 4 : headers anti-bot toujours présents ─────────────────────────

describe("buildRequestHeaders — Property 4 : headers anti-bot toujours présents", () => {
  // Feature: france-visa-hunter, Property 4: Headers anti-bot toujours présents —
  // x-gouv-app-id = authState.appId, x-gouv-web = fr.gouv.consulat.
  // Validates: Requirements 1.6
  it("injecte x-gouv-app-id = auth.appId et x-gouv-web = fr.gouv.consulat pour toute méthode", () => {
    fc.assert(
      fc.property(authStateArb, methodArb, (auth, method) => {
        const headers = buildRequestHeaders(auth, method);
        expect(headers["x-gouv-app-id"]).toBe(auth.appId);
        expect(headers["x-gouv-web"]).toBe(FRANCE_GOUV_WEB);
        expect(FRANCE_GOUV_WEB).toBe("fr.gouv.consulat");
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── Property 5 : x-csrf-token sur les requêtes POST/PUT ──────────────────────

describe("buildRequestHeaders — Property 5 : x-csrf-token sur les requêtes POST/PUT", () => {
  // Feature: france-visa-hunter, Property 5: x-csrf-token sur les requêtes
  // POST/PUT — x-csrf-token = handshakeToken courant.
  // Validates: Requirements 1.7
  it("place x-csrf-token = auth.handshakeToken sur POST et PUT", () => {
    fc.assert(
      fc.property(authStateArb, csrfMethodArb, (auth, method) => {
        const headers = buildRequestHeaders(auth, method);
        expect(headers["x-csrf-token"]).toBe(auth.handshakeToken);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 5: x-csrf-token sur les requêtes
  // POST/PUT — absent sur les méthodes non sensibles (GET/HEAD).
  // Validates: Requirements 1.7
  it("n'ajoute pas x-csrf-token sur les méthodes non sensibles (GET/HEAD)", () => {
    fc.assert(
      fc.property(authStateArb, nonCsrfMethodArb, (auth, method) => {
        const headers = buildRequestHeaders(auth, method);
        expect(headers["x-csrf-token"]).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
