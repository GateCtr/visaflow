/**
 * france-turnstile-placement.test.ts — Test property-based du placement du token
 * Turnstile (feature france-visa-hunter, task 5.2).
 *
 * Fonction sous test : `placeTurnstileToken(body, token)` de
 * `src/france/france-turnstile.ts` (helper PUR, ne mute pas `body`).
 *
 * Propriété couverte :
 *   - Property 7 : Le token Turnstile est placé dans le champ `captcha` —
 *     pour tout token non vide, le corps de requête construit porte ce token
 *     exactement dans le champ `captcha`, sans altérer les propriétés d'origine
 *     ni muter le corps source (Requirement 3.2).
 *
 * fast-check avec `{ numRuns: 100 }` conformément au design.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { placeTurnstileToken } from "../france/france-turnstile.js";

const NUM_RUNS = 100;

// ─── Générateurs ─────────────────────────────────────────────────────────────

/**
 * Génère un token Turnstile non vide (le champ `captcha` doit toujours être
 * renseigné avant une requête session/booking).
 */
const tokenArb: fc.Arbitrary<string> = fc.string({ minLength: 1 });

/**
 * Génère un corps de requête arbitraire (objet sans champ `captcha` imposé) :
 * les propriétés d'origine doivent être préservées à l'identique.
 */
const bodyArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string(),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { noNullPrototype: true },
);

// ─── Property 7 : token placé dans le champ captcha ──────────────────────────

describe("placeTurnstileToken — Property 7 : le token Turnstile est placé dans le champ captcha", () => {
  // Feature: france-visa-hunter, Property 7: Le token Turnstile est placé dans
  // le champ captcha — pour tout token non vide, body.captcha === token.
  // Validates: Requirements 3.2
  it("place le token exactement dans le champ captcha du corps de requête", () => {
    fc.assert(
      fc.property(bodyArb, tokenArb, (body, token) => {
        const result = placeTurnstileToken(body, token);
        expect(result.captcha).toBe(token);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 7: Le token Turnstile est placé dans
  // le champ captcha — les propriétés d'origine sont préservées à l'identique.
  // Validates: Requirements 3.2
  it("préserve toutes les propriétés d'origine du corps (hors captcha)", () => {
    fc.assert(
      fc.property(bodyArb, tokenArb, (body, token) => {
        const result = placeTurnstileToken(body, token);
        for (const key of Object.keys(body)) {
          if (key === "captcha") continue;
          expect(result[key]).toBe(body[key]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 7: Le token Turnstile est placé dans
  // le champ captcha — la fonction est pure, elle ne mute pas le corps source.
  // Validates: Requirements 3.2
  it("ne mute pas le corps de requête source (fonction pure)", () => {
    fc.assert(
      fc.property(bodyArb, tokenArb, (body, token) => {
        const snapshot = { ...body };
        placeTurnstileToken(body, token);
        expect(body).toStrictEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
