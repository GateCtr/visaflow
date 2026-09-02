/**
 * france-mask-secret.test.ts — Test property-based du masquage des secrets
 * (feature france-visa-hunter, task 2.4).
 *
 * Couverture :
 *   - Property 30 : Masquage des données sensibles — `maskSecret` ne révèle
 *     jamais plus que 8 caractères de la valeur d'origine, suivis de `...`
 *     (Requirement 12.4).
 *
 * Framework : fast-check + vitest, { numRuns: 100 }.
 * Aucun secret réel : fast-check génère des chaînes arbitraires.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { maskSecret } from "../france/france-http.js";

// Nombre maximal de caractères d'origine que `maskSecret` peut révéler.
const MAX_VISIBLE_CHARS = 8;
const MASK_SUFFIX = "...";

// Feature: france-visa-hunter, Property 30: Masquage des données sensibles —
// maskSecret ne révèle jamais plus que 8 caractères + "...".
// Validates: Requirements 12.4
describe("maskSecret (Property 30 — masquage des données sensibles)", () => {
  it("ne révèle jamais plus que les 8 premiers caractères + '...' (numRuns: 100)", () => {
    fc.assert(
      fc.property(fc.string(), (value: string) => {
        const masked = maskSecret(value);

        if (value.length === 0) {
          // Rien à masquer : chaîne vide retournée telle quelle.
          expect(masked).toBe("");
          return;
        }

        // La forme masquée se termine toujours par le suffixe de troncature.
        expect(masked.endsWith(MASK_SUFFIX)).toBe(true);

        // Partie révélée = tout sauf le suffixe.
        const revealed = masked.slice(0, masked.length - MASK_SUFFIX.length);

        // On ne révèle jamais plus de 8 caractères de la valeur d'origine.
        expect(revealed.length).toBeLessThanOrEqual(MAX_VISIBLE_CHARS);

        // La partie révélée est exactement le préfixe de la valeur d'origine
        // (aucun caractère au-delà des 8 premiers ne fuite).
        expect(revealed).toBe(value.slice(0, MAX_VISIBLE_CHARS));

        // Au-delà du seuil, la forme masquée est EXACTEMENT les 8 premiers
        // caractères suivis du suffixe : c'est l'expression exacte de « ne
        // révèle que les 8 premiers caractères ». (On n'utilise pas
        // `not.toContain(value.slice(8))` : pour une entrée dont la suite
        // n'est qu'un préfixe déjà révélé — ex. espaces répétés — ce test
        // serait faussement en échec alors qu'aucun caractère au-delà des 8
        // premiers ne fuite réellement.)
        if (value.length > MAX_VISIBLE_CHARS) {
          expect(masked).toBe(value.slice(0, MAX_VISIBLE_CHARS) + MASK_SUFFIX);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("masque toujours identiquement pour toute chaîne au-delà de 8 caractères (numRuns: 100)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: MAX_VISIBLE_CHARS + 1 }),
        (value: string) => {
          const masked = maskSecret(value);
          expect(masked).toBe(value.slice(0, MAX_VISIBLE_CHARS) + MASK_SUFFIX);
          // La longueur révélée est bornée quelle que soit la taille d'entrée.
          expect(masked.length).toBe(MAX_VISIBLE_CHARS + MASK_SUFFIX.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
