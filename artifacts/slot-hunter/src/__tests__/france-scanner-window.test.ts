/**
 * france-scanner-window.test.ts — Tests property-based de la fenêtre de scan et
 * des jours scannables (feature france-visa-hunter, task 8.2).
 *
 * Cibles (fonctions PURES) :
 *   - `computeScannableDays(window, excludeDays)` de `france-scanner.ts`
 *   - `isValidWindow(raw)` et `parseExcludeDays(raw)` de `france-http.ts`
 *
 * Propriétés couvertes :
 *   - Property 13 : Validation de la fenêtre de scan — `isValidWindow` vrai ssi
 *     `start`/`end` au format `YYYY-MM-DD` et `start <= end`.
 *   - Property 14 : Jours scannables strictement dans la fenêtre et hors jours
 *     exclus (∈ [start, end] ∧ ∉ excludeDays), triés, sans doublon.
 *   - Property 15 : Parse des jours exclus ne conserve que des dates valides
 *     `YYYY-MM-DD` (aucune valeur non conforme propagée).
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any` : les entrées « arbitraires » sont typées
 * `unknown` et manipulées via des type guards.
 *
 * Validates: Requirements 6.2, 6.3, 7.2, 7.3, 7.4
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isValidWindow, parseExcludeDays } from "../france/france-http.js";
import { computeScannableDays } from "../france/france-scanner.js";
import type { ScanWindow } from "../france/france-types.js";

const NUM_RUNS = 100;

// ─── Constantes de dates ──────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** Motif d'une date `YYYY-MM-DD` structurellement valide (mois 01..12, jour 01..31). */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ─── Générateurs de valeurs « quelconques » (unknown) ────────────────────────
//
// Sert à vérifier que les validateurs ne « laissent jamais passer » du bruit.

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

// ─── Générateurs de dates conformes ───────────────────────────────────────────
//
// On génère des dates réelles (existantes) via un timestamp UTC borné, ce qui
// garantit un ordre chronologique = ordre lexicographique pour le format
// `YYYY-MM-DD`, et facilite le calcul de l'oracle des jours scannables.

/** Borne basse : 2000-01-01 (UTC). */
const MIN_DAY_MS = Date.UTC(2000, 0, 1);
/** Borne haute : 2035-12-31 (UTC), fenêtres réalistes du portail. */
const MAX_DAY_MS = Date.UTC(2035, 11, 31);

/** Formate un timestamp UTC (minuit) en `YYYY-MM-DD`. */
function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Timestamp UTC (minuit) d'un jour aléatoire dans [MIN_DAY_MS, MAX_DAY_MS]. */
const validDayMs: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: Math.floor((MAX_DAY_MS - MIN_DAY_MS) / MS_PER_DAY) })
  .map((offset) => MIN_DAY_MS + offset * MS_PER_DAY);

/** Date `YYYY-MM-DD` réelle (existante). */
const validDate: fc.Arbitrary<string> = validDayMs.map(formatUtcDay);

/**
 * Fenêtre bornée `{start, end}` avec `start <= end` et une amplitude limitée
 * (≤ 60 jours) pour garder l'énumération des jours scannables raisonnable.
 */
const boundedWindow: fc.Arbitrary<{ startMs: number; endMs: number; window: ScanWindow }> = fc
  .record({
    startMs: validDayMs,
    span: fc.integer({ min: 0, max: 60 }),
  })
  .map(({ startMs, span }) => {
    const endMs = Math.min(startMs + span * MS_PER_DAY, MAX_DAY_MS);
    return {
      startMs,
      endMs,
      window: { start: formatUtcDay(startMs), end: formatUtcDay(endMs) },
    };
  });

// ─── Oracle: énumération des jours d'une fenêtre ──────────────────────────────

function enumerateDays(startMs: number, endMs: number): string[] {
  const days: string[] = [];
  for (let cursor = startMs; cursor <= endMs; cursor += MS_PER_DAY) {
    days.push(formatUtcDay(cursor));
  }
  return days;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Oracle miroir du contrat de `isValidWindow`. */
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
// Feature: france-visa-hunter, Property 13: Validation de la fenêtre de scan —
// isValidWindow(raw) vrai ssi raw = { start, end } au format YYYY-MM-DD avec
// start <= end. Toute entrée non conforme est rejetée (false).
// Validates: Requirements 6.2, 6.3
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 13 — isValidWindow (france-http.ts)", () => {
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
      fc.property(validDate, validDate, (a, b) => {
        fc.pre(a !== b);
        const [start, end] = a > b ? [a, b] : [b, a]; // start strictement > end
        expect(isValidWindow({ start, end })).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette (false) une fenêtre dont start ou end n'est pas au format YYYY-MM-DD", () => {
    const notADate = fc.oneof(
      fc.string().filter((s) => !DATE_RE.test(s)),
      fc.integer(),
      fc.constant(null),
      fc.constant(undefined),
    );
    fc.assert(
      fc.property(fc.oneof(validDate, notADate), fc.oneof(validDate, notADate), (start, end) => {
        fc.pre(
          !(typeof start === "string" && DATE_RE.test(start)) ||
            !(typeof end === "string" && DATE_RE.test(end)),
        );
        expect(isValidWindow({ start, end })).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette (false) toute entrée non conforme (bruit arbitraire)", () => {
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
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 14: Jours scannables strictement dans
// la fenêtre et hors jours exclus — computeScannableDays(window, excludeDays)
// retourne exactement { d : d ∈ [start, end] ∧ d ∉ excludeDays }, trié croissant
// et sans doublon.
// Validates: Requirements 6.3, 7.4
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 14 — computeScannableDays (france-scanner.ts)", () => {
  it("retourne exactement les jours de la fenêtre non exclus, triés et sans doublon", () => {
    fc.assert(
      fc.property(
        boundedWindow,
        // Un sous-ensemble arbitraire des jours de la fenêtre + du bruit hors fenêtre.
        fc.array(validDate, { maxLength: 30 }),
        ({ startMs, endMs, window }, rawExcluded) => {
          const excludeDays = new Set(rawExcluded);
          const result = computeScannableDays(window, excludeDays);

          // Oracle : jours de la fenêtre non exclus.
          const expected = enumerateDays(startMs, endMs).filter((d) => !excludeDays.has(d));

          // (1) Égalité exacte de contenu et d'ordre.
          expect(result).toEqual(expected);

          // (2) Chaque jour est dans [start, end].
          for (const d of result) {
            expect(d >= window.start && d <= window.end).toBe(true);
          }

          // (3) Aucun jour exclu n'est présent.
          for (const d of result) {
            expect(excludeDays.has(d)).toBe(false);
          }

          // (4) Trié strictement croissant (donc sans doublon).
          for (let i = 1; i < result.length; i += 1) {
            expect(result[i - 1] < result[i]).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("exclure tous les jours de la fenêtre produit un tableau vide", () => {
    fc.assert(
      fc.property(boundedWindow, ({ startMs, endMs, window }) => {
        const allDays = new Set(enumerateDays(startMs, endMs));
        expect(computeScannableDays(window, allDays)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("un ensemble d'exclusion vide retourne tous les jours de la fenêtre", () => {
    fc.assert(
      fc.property(boundedWindow, ({ startMs, endMs, window }) => {
        expect(computeScannableDays(window, new Set<string>())).toEqual(
          enumerateDays(startMs, endMs),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("retourne un tableau vide pour une fenêtre invalide (start > end ou format KO)", () => {
    const invalidWindow: fc.Arbitrary<ScanWindow> = fc.oneof(
      // start strictement > end (dates valides mais ordre inversé).
      fc.record({ a: validDate, b: validDate }).map(({ a, b }) => {
        const [start, end] = a > b ? [a, b] : [b, a];
        return { start, end };
      }).filter((w) => w.start > w.end),
      // format invalide.
      fc.record({
        start: fc.string().filter((s) => !DATE_RE.test(s)),
        end: validDate,
      }),
    );
    fc.assert(
      fc.property(invalidWindow, (window) => {
        expect(computeScannableDays(window, new Set<string>())).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 15: Parse des jours exclus ne conserve
// que des dates valides — parseExcludeDays(raw) retourne null si raw n'est pas
// un tableau ; sinon un Set ne contenant QUE les dates YYYY-MM-DD conformes de
// l'entrée (aucune valeur non conforme propagée).
// Validates: Requirements 7.2, 7.3
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 15 — parseExcludeDays (france-http.ts)", () => {
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

  it("ne conserve que les dates valides et ne perd aucune date conforme", () => {
    fc.assert(
      fc.property(fc.array(arbitraryUnknown, { maxLength: 12 }), (raw) => {
        const result = parseExcludeDays(raw);
        expect(result).not.toBeNull();
        const days = result ?? new Set<string>();

        // (1) Toute valeur retenue est une date conforme.
        for (const day of days) {
          expect(DATE_RE.test(day)).toBe(true);
        }

        // (2) Toute date conforme de l'entrée est retenue (rien perdu à tort),
        //     et rien d'autre n'est présent.
        const expected = new Set(
          raw.filter((v): v is string => typeof v === "string" && DATE_RE.test(v)),
        );
        expect(days).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("accepte un tableau de dates valides sans en perdre ni en ajouter", () => {
    fc.assert(
      fc.property(fc.array(validDate, { maxLength: 12 }), (dates) => {
        expect(parseExcludeDays(dates)).toEqual(new Set(dates));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
