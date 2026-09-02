/**
 * france-scanner-publication.test.ts — Tests property-based de détection de
 * publication (feature france-visa-hunter, task 8.4).
 *
 * Cible (fonction PURE) :
 *   - `detectPublication(prevExcluded, currExcluded, window, daySlots)` de
 *     `france-scanner.ts`.
 *
 * Propriétés couvertes :
 *   - Property 19 : Publication signalée sur créneaux disponibles — dès qu'un
 *     jour de `daySlots` porte des créneaux non vides, `detectPublication`
 *     renvoie une `SlotPublication` de raison `"availability"` dont `day` et
 *     `slots` correspondent à un jour disponible de la carte.
 *   - Property 20 : Publication signalée sur rétraction des jours exclus — en
 *     l'absence de disponibilité, si `currExcluded` retire un jour de la
 *     fenêtre présent dans `prevExcluded`, `detectPublication` renvoie une
 *     `SlotPublication` de raison `"exclude_days_retraction"`.
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any`.
 *
 * Validates: Requirements 9.1, 9.2
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { detectPublication } from "../france/france-scanner.js";
import type { FranceSlot, ScanWindow } from "../france/france-types.js";

const NUM_RUNS = 100;

// ─── Constantes de dates ──────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** Borne basse : 2000-01-01 (UTC). */
const MIN_DAY_MS = Date.UTC(2000, 0, 1);
/** Borne haute : 2035-12-31 (UTC). */
const MAX_DAY_MS = Date.UTC(2035, 11, 31);

/** Formate un timestamp UTC (minuit) en `YYYY-MM-DD`. */
function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Timestamp UTC (minuit) d'un jour dans [MIN_DAY_MS, MAX_DAY_MS]. */
const validDayMs: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: Math.floor((MAX_DAY_MS - MIN_DAY_MS) / MS_PER_DAY) })
  .map((offset) => MIN_DAY_MS + offset * MS_PER_DAY);

/** Date `YYYY-MM-DD` réelle (existante). */
const validDate: fc.Arbitrary<string> = validDayMs.map(formatUtcDay);

/**
 * Fenêtre bornée `{start, end}` avec `start <= end` et une amplitude limitée
 * (≤ 60 jours). Retourne aussi la liste énumérée des jours de la fenêtre.
 */
const boundedWindow: fc.Arbitrary<{ window: ScanWindow; days: string[] }> = fc
  .record({
    startMs: validDayMs,
    span: fc.integer({ min: 0, max: 60 }),
  })
  .map(({ startMs, span }) => {
    const endMs = Math.min(startMs + span * MS_PER_DAY, MAX_DAY_MS);
    const days: string[] = [];
    for (let cursor = startMs; cursor <= endMs; cursor += MS_PER_DAY) {
      days.push(formatUtcDay(cursor));
    }
    return { window: { start: formatUtcDay(startMs), end: formatUtcDay(endMs) }, days };
  });

// ─── Générateur de créneaux ───────────────────────────────────────────────────

/** Un créneau conforme au DTO `FranceSlot`. */
const arbitrarySlot: fc.Arbitrary<FranceSlot> = fc.record({
  time: fc
    .integer({ min: 0, max: 23 * 60 + 59 })
    .map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`),
  rate: fc.constant("0.00"),
  capacity: fc.integer({ min: 1, max: 5 }),
});

/** Liste NON vide de créneaux (au moins 1). */
const nonEmptySlots: fc.Arbitrary<FranceSlot[]> = fc.array(arbitrarySlot, {
  minLength: 1,
  maxLength: 4,
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 19: Publication signalée sur créneaux
// disponibles — WHEN au moins un jour de `daySlots` porte des créneaux non
// vides, detectPublication renvoie une SlotPublication de raison "availability"
// dont `day` appartient aux jours disponibles et `slots` = les créneaux de ce
// jour (Requirement 9.1). La disponibilité prime sur la rétraction.
// Validates: Requirements 9.1
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 19 — detectPublication signale la disponibilité", () => {
  it("renvoie une publication 'availability' avec day/slots correspondants", () => {
    fc.assert(
      fc.property(
        boundedWindow,
        // Sous-ensemble de jours (dans la fenêtre) portant des créneaux.
        fc.array(fc.tuple(validDate, nonEmptySlots), { minLength: 1, maxLength: 6 }),
        // Bruit : jours à agenda vide (slots = []).
        fc.array(validDate, { maxLength: 6 }),
        ({ window }, availablePairs, emptyDays) => {
          const daySlots = new Map<string, FranceSlot[]>();
          // Jours vides d'abord (peuvent être écrasés par des jours pleins).
          for (const day of emptyDays) {
            if (!daySlots.has(day)) {
              daySlots.set(day, []);
            }
          }
          // Puis les jours disponibles (garantissent au moins 1 slot non vide).
          for (const [day, slots] of availablePairs) {
            daySlots.set(day, slots);
          }

          const result = detectPublication(new Set(), new Set(), window, daySlots);

          // Une publication de disponibilité doit être signalée.
          expect(result).not.toBeNull();
          const pub = result!;
          expect(pub.reason).toBe("availability");

          // Le jour retourné a bien des créneaux non vides dans la carte.
          const slotsForDay = daySlots.get(pub.day);
          expect(slotsForDay).toBeDefined();
          expect(slotsForDay!.length).toBeGreaterThan(0);

          // Les slots retournés = ceux du jour dans la carte.
          expect(pub.slots).toEqual(slotsForDay);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("retourne le plus petit jour disponible (ordre croissant) quand plusieurs jours ont des slots", () => {
    fc.assert(
      fc.property(
        boundedWindow,
        fc.uniqueArray(validDate, { minLength: 2, maxLength: 6 }),
        ({ window }, days) => {
          const daySlots = new Map<string, FranceSlot[]>();
          for (const day of days) {
            daySlots.set(day, [{ time: "09:00", rate: "0.00", capacity: 1 }]);
          }
          const result = detectPublication(new Set(), new Set(), window, daySlots);
          expect(result).not.toBeNull();
          const expectedDay = [...days].sort()[0];
          expect(result!.day).toBe(expectedDay);
          expect(result!.reason).toBe("availability");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("ne signale PAS 'availability' si tous les jours sont à agenda vide", () => {
    fc.assert(
      fc.property(
        boundedWindow,
        fc.array(validDate, { maxLength: 8 }),
        ({ window }, emptyDays) => {
          const daySlots = new Map<string, FranceSlot[]>();
          for (const day of emptyDays) {
            daySlots.set(day, []);
          }
          // prev = curr : aucune rétraction => pas de publication du tout.
          const result = detectPublication(new Set(), new Set(), window, daySlots);
          expect(result).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 20: Publication signalée sur rétraction
// des jours exclus — WHEN aucune disponibilité n'est présente ET `currExcluded`
// retire (par rapport à `prevExcluded`) au moins un jour appartenant à la
// fenêtre, detectPublication renvoie une SlotPublication de raison
// "exclude_days_retraction" (Requirement 9.2). Le jour retourné est un jour
// rétracté de la fenêtre ; `slots` est vide.
// Validates: Requirements 9.2
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 20 — detectPublication signale la rétraction des jours exclus", () => {
  it("renvoie 'exclude_days_retraction' pour un jour de la fenêtre retiré de prevExcluded", () => {
    fc.assert(
      fc.property(
        // Fenêtre + sélection d'un sous-ensemble non vide de ses jours à rétracter.
        boundedWindow.chain(({ window, days }) =>
          fc.record({
            window: fc.constant(window),
            days: fc.constant(days),
            retracted: fc.subarray(days, { minLength: 1 }),
          }),
        ),
        // Jours exclus supplémentaires (bruit) présents dans les deux ensembles.
        fc.array(validDate, { maxLength: 4 }),
        ({ window, days, retracted }, extraStable) => {
          // prevExcluded : jours à rétracter + bruit stable.
          const prevExcluded = new Set<string>([...retracted, ...extraStable]);
          // currExcluded : ne contient plus les jours rétractés, mais garde le bruit stable.
          const currExcluded = new Set<string>(
            extraStable.filter((d) => !retracted.includes(d)),
          );
          // Aucune disponibilité.
          const daySlots = new Map<string, FranceSlot[]>();

          const result = detectPublication(prevExcluded, currExcluded, window, daySlots);
          expect(result).not.toBeNull();
          const pub = result!;
          expect(pub.reason).toBe("exclude_days_retraction");
          // Le jour retourné est bien un jour rétracté ∈ fenêtre.
          expect(retracted.includes(pub.day)).toBe(true);
          expect(days.includes(pub.day)).toBe(true);
          expect(pub.slots).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("ne signale PAS de rétraction si les jours retirés sont hors fenêtre", () => {
    fc.assert(
      fc.property(
        boundedWindow,
        fc.array(validDate, { maxLength: 6 }),
        ({ window, days }, retracted) => {
          const windowSet = new Set(days);
          // Ne garder que les jours HORS fenêtre.
          const outside = retracted.filter((d) => !windowSet.has(d));
          fc.pre(outside.length > 0);
          const prevExcluded = new Set<string>(outside);
          const currExcluded = new Set<string>();
          const daySlots = new Map<string, FranceSlot[]>();

          const result = detectPublication(prevExcluded, currExcluded, window, daySlots);
          expect(result).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("ne signale PAS de rétraction si currExcluded ne retire aucun jour (prev ⊆ curr)", () => {
    fc.assert(
      fc.property(
        boundedWindow,
        fc.array(validDate, { maxLength: 6 }),
        ({ window }, excluded) => {
          const prevExcluded = new Set<string>(excluded);
          // curr contient au moins tout prev (aucune rétraction).
          const currExcluded = new Set<string>(excluded);
          const daySlots = new Map<string, FranceSlot[]>();

          const result = detectPublication(prevExcluded, currExcluded, window, daySlots);
          expect(result).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("la disponibilité prime sur la rétraction", () => {
    fc.assert(
      fc.property(boundedWindow, ({ window, days }) => {
        fc.pre(days.length > 0);
        const retractedDay = days[0];
        const prevExcluded = new Set<string>([retractedDay]);
        const currExcluded = new Set<string>();
        // Un jour disponible en plus.
        const daySlots = new Map<string, FranceSlot[]>([
          [days[days.length - 1], [{ time: "10:30", rate: "0.00", capacity: 2 }]],
        ]);

        const result = detectPublication(prevExcluded, currExcluded, window, daySlots);
        expect(result).not.toBeNull();
        expect(result!.reason).toBe("availability");
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
