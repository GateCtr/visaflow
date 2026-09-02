/**
 * france-http-teamid.test.ts — Test property-based de validation du teamId
 * lors de la résolution de consulat (feature france-visa-hunter, task 4.4).
 *
 * Fonction sous test (helper PUR, aucun effet de bord, aucun réseau) de
 * `src/france/france-http.ts` :
 *   - `isValidTeamId(raw)` : vrai ssi `raw` est un objet dont le champ `teamId`
 *     est une chaîne non vide.
 *
 * Propriété couverte :
 *   - Property 6 : Validation du teamId — `isValidTeamId` true ssi `teamId` est
 *     une chaîne non vide (Requirement 2.2 : le hunter doit valider que le
 *     champ `teamId` est présent et est une chaîne non vide avant utilisation).
 *
 * fast-check v4 avec `{ numRuns: 100 }` conformément au design.
 * TypeScript strict, aucun `any` : les entrées « arbitraires » sont typées
 * `unknown` et manipulées via des type guards.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isValidTeamId } from "../france/france-http.js";

const NUM_RUNS = 100;

// ─── Générateur de valeurs « quelconques » (unknown) ─────────────────────────
//
// Échantillon large de valeurs JSON-like arbitraires (primitives, objets,
// tableaux, imbrications) pour éprouver le prédicat sur du bruit non conforme.

const arbitraryUnknown: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.constant(undefined),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: false }),
    fc.string(),
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("node"), { maxKeys: 4 }),
  ) as fc.Arbitrary<unknown>,
})).node;

// ─── Oracle (miroir exact du contrat de isValidTeamId) ───────────────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prédicat de référence : `raw` porte un `teamId` chaîne non vide. Miroir
 * exact du contrat (une chaîne de longueur > 0, y compris blancs, est valide ;
 * la chaîne vide ne l'est pas).
 */
function hasNonEmptyStringTeamId(raw: unknown): boolean {
  return isPlainRecord(raw) && typeof raw.teamId === "string" && raw.teamId.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 6: Validation du teamId — isValidTeamId
// retourne true si et seulement si l'entrée est un objet dont le champ `teamId`
// est une chaîne non vide.
// Validates: Requirements 2.2
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 6 — validation du teamId (isValidTeamId)", () => {
  it("est exactement équivalent au prédicat « objet avec teamId chaîne non vide » (iff)", () => {
    fc.assert(
      fc.property(arbitraryUnknown, (raw) => {
        expect(isValidTeamId(raw)).toBe(hasNonEmptyStringTeamId(raw));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("accepte (true) tout objet dont teamId est une chaîne non vide", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.dictionary(fc.string(), arbitraryUnknown, { maxKeys: 3 }),
        (teamId, extra) => {
          // On surcharge teamId après extra pour garantir sa présence non vide.
          expect(isValidTeamId({ ...extra, teamId })).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette (false) un objet dont teamId est la chaîne vide", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), arbitraryUnknown, { maxKeys: 3 }), (extra) => {
        expect(isValidTeamId({ ...extra, teamId: "" })).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette (false) un objet dont teamId n'est pas une chaîne", () => {
    const nonStringTeamId = arbitraryUnknown.filter((v) => typeof v !== "string");
    fc.assert(
      fc.property(
        nonStringTeamId,
        fc.dictionary(fc.string(), arbitraryUnknown, { maxKeys: 3 }),
        (teamId, extra) => {
          expect(isValidTeamId({ ...extra, teamId })).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette (false) toute entrée qui n'est pas un objet exploitable (null, tableau, primitive)", () => {
    const notARecord = arbitraryUnknown.filter((v) => !isPlainRecord(v));
    fc.assert(
      fc.property(notARecord, (raw) => {
        expect(isValidTeamId(raw)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
