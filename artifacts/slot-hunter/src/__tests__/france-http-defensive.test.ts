/**
 * france-http-defensive.test.ts — Test property-based de validation défensive
 * des DTO France (feature france-visa-hunter, task 2.7).
 *
 * Cible : les validateurs purs de `france-http.ts`
 *   - `parseSlots`          → `FranceSlot[] | null`
 *   - `parseExcludeDays`    → `Set<string> | null`
 *   - `isValidWindow`       → `boolean`
 *   - `isValidTeamId`       → `boolean`
 *   - `isValidSessionId`    → `boolean`
 *
 * Principe testé (Requirement 12.2) : toute réponse d'API externe non conforme
 * au DTO attendu est rejetée (`null` pour les parseurs, `false` pour les
 * prédicats) et AUCUNE donnée non validée n'est propagée en aval. Réciproque :
 * une réponse conforme est acceptée et le résultat typé respecte le contrat.
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any` : les entrées « arbitraires » sont typées
 * `unknown` et manipulées via des type guards.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isValidSessionId,
  isValidTeamId,
  isValidWindow,
  parseExcludeDays,
  parseSlots,
} from "../france/france-http.js";
import type { FranceSlot } from "../france/france-types.js";

const NUM_RUNS = 100;

// ─── Générateurs de valeurs « quelconques » (unknown) ────────────────────────
//
// Un échantillon large de valeurs JSON-like arbitraires : primitives, objets,
// tableaux, imbrications. Sert à vérifier que les validateurs ne « laissent
// jamais passer » du bruit non conforme.

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

// ─── Générateurs conformes ────────────────────────────────────────────────────

/** Date `YYYY-MM-DD` structurellement valide (mois 01..12, jour 01..31). */
const validDate: fc.Arbitrary<string> = fc
  .record({
    year: fc.integer({ min: 1000, max: 9999 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, day }) => {
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  });

/** Heure `HH:MM` valide (00..23:00..59). */
const validTime: fc.Arbitrary<string> = fc
  .record({
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ hour, minute }) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);

/** Chaîne décimale à exactement deux décimales, ex. `12.00`. */
const validRate: fc.Arbitrary<string> = fc
  .record({
    whole: fc.integer({ min: 0, max: 99_999 }),
    cents: fc.integer({ min: 0, max: 99 }),
  })
  .map(({ whole, cents }) => `${whole}.${String(cents).padStart(2, "0")}`);

/** Créneau conforme au DTO `FranceSlot`. */
const validSlot: fc.Arbitrary<FranceSlot> = fc.record({
  time: validTime,
  rate: validRate,
  capacity: fc.integer({ min: 1, max: 1000 }),
});

// ─── Prédicats de conformité (miroir du contrat, servent d'oracle) ────────────

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RATE_RE = /^\d+\.\d{2}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConformingSlot(value: unknown): value is FranceSlot {
  if (!isPlainRecord(value)) {
    return false;
  }
  const { time, rate, capacity } = value;
  return (
    typeof time === "string" &&
    TIME_RE.test(time) &&
    typeof rate === "string" &&
    RATE_RE.test(rate) &&
    typeof capacity === "number" &&
    Number.isInteger(capacity) &&
    capacity > 0
  );
}

function isConformingWindow(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  const { start, end } = value;
  return (
    typeof start === "string" &&
    DATE_RE.test(start) &&
    typeof end === "string" &&
    DATE_RE.test(end) &&
    start <= end
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 31: Validation défensive des réponses
// externes — toute réponse non conforme est rejetée (null/false) sans
// propagation de donnée non validée ; toute réponse conforme est acceptée.
// Validates: Requirements 12.2
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 31 — validation défensive des DTO France (france-http.ts)", () => {
  // ── parseSlots ─────────────────────────────────────────────────────────────

  describe("parseSlots", () => {
    it("rejette (null) toute entrée qui n'est pas un tableau", () => {
      fc.assert(
        fc.property(
          arbitraryUnknown.filter((v) => !Array.isArray(v)),
          (raw) => {
            expect(parseSlots(raw)).toBeNull();
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("rejette (null) tout tableau contenant au moins un créneau non conforme", () => {
      const badEntry = arbitraryUnknown.filter((v) => !isConformingSlot(v));
      fc.assert(
        fc.property(
          fc.array(validSlot, { maxLength: 4 }),
          badEntry,
          fc.array(validSlot, { maxLength: 4 }),
          (before, bad, after) => {
            const raw: unknown[] = [...before, bad, ...after];
            expect(parseSlots(raw)).toBeNull();
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("accepte un tableau de créneaux conformes et préserve exactement les données validées", () => {
      fc.assert(
        fc.property(fc.array(validSlot, { maxLength: 8 }), (slots) => {
          const result = parseSlots(slots);
          expect(result).not.toBeNull();
          // Aucune donnée non validée : la sortie est structurellement le DTO.
          expect(result).toEqual(slots.map((s) => ({ time: s.time, rate: s.rate, capacity: s.capacity })));
          for (const slot of result ?? []) {
            expect(isConformingSlot(slot)).toBe(true);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── parseExcludeDays ─────────────────────────────────────────────────────────

  describe("parseExcludeDays", () => {
    it("rejette (null) toute entrée qui n'est pas un tableau", () => {
      fc.assert(
        fc.property(
          arbitraryUnknown.filter((v) => !Array.isArray(v)),
          (raw) => {
            expect(parseExcludeDays(raw)).toBeNull();
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("ne propage jamais une valeur non conforme au format YYYY-MM-DD", () => {
      fc.assert(
        fc.property(fc.array(arbitraryUnknown, { maxLength: 8 }), (raw) => {
          const result = parseExcludeDays(raw);
          expect(result).not.toBeNull();
          const days = result ?? new Set<string>();
          // Toute valeur retenue est une date conforme…
          for (const day of days) {
            expect(DATE_RE.test(day)).toBe(true);
          }
          // …et toute valeur conforme de l'entrée est retenue (rien perdu à tort).
          const expected = new Set(
            raw.filter((v): v is string => typeof v === "string" && DATE_RE.test(v)),
          );
          expect(days).toEqual(expected);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("accepte un tableau de dates valides sans en perdre", () => {
      fc.assert(
        fc.property(fc.array(validDate, { maxLength: 8 }), (dates) => {
          const result = parseExcludeDays(dates);
          expect(result).toEqual(new Set(dates));
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── isValidWindow ────────────────────────────────────────────────────────────

  describe("isValidWindow", () => {
    it("rejette (false) toute entrée non conforme à la fenêtre de scan", () => {
      fc.assert(
        fc.property(
          arbitraryUnknown.filter((v) => !isConformingWindow(v)),
          (raw) => {
            expect(isValidWindow(raw)).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it("accepte (true) une fenêtre { start, end } de dates valides avec start <= end", () => {
      fc.assert(
        fc.property(validDate, validDate, (a, b) => {
          const [start, end] = a <= b ? [a, b] : [b, a];
          expect(isValidWindow({ start, end })).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("rejette (false) une fenêtre où start > end", () => {
      fc.assert(
        fc.property(
          validDate,
          validDate,
          (a, b) => {
            fc.pre(a !== b);
            const [start, end] = a > b ? [a, b] : [b, a]; // start strictement > end
            expect(isValidWindow({ start, end })).toBe(false);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── isValidTeamId ────────────────────────────────────────────────────────────

  describe("isValidTeamId", () => {
    it("rejette (false) toute entrée sans teamId chaîne non vide", () => {
      const notValid = arbitraryUnknown.filter(
        (v) => !(isPlainRecord(v) && typeof v.teamId === "string" && v.teamId.length > 0),
      );
      fc.assert(
        fc.property(notValid, (raw) => {
          expect(isValidTeamId(raw)).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("accepte (true) un objet avec teamId chaîne non vide", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.dictionary(fc.string(), arbitraryUnknown, { maxKeys: 3 }),
          (teamId, extra) => {
            expect(isValidTeamId({ ...extra, teamId })).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // ── isValidSessionId ─────────────────────────────────────────────────────────

  describe("isValidSessionId", () => {
    it("rejette (false) toute entrée sans sessionId chaîne non vide", () => {
      const notValid = arbitraryUnknown.filter(
        (v) => !(isPlainRecord(v) && typeof v.sessionId === "string" && v.sessionId.length > 0),
      );
      fc.assert(
        fc.property(notValid, (raw) => {
          expect(isValidSessionId(raw)).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("accepte (true) un objet avec sessionId chaîne non vide", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.dictionary(fc.string(), arbitraryUnknown, { maxKeys: 3 }),
          (sessionId, extra) => {
            expect(isValidSessionId({ ...extra, sessionId })).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
