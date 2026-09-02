/**
 * france-scanner-slots.test.ts — Tests property-based du parse des créneaux et
 * de la séparation stricte identifiant/nom (feature france-visa-hunter, task 8.3).
 *
 * Cibles (fonctions PURES) :
 *   - `parseSlots(raw)` de `france-http.ts`
 *   - `buildGetIntervalPath(teamId, serviceId)` de `france-scanner.ts`
 *   - `buildAvailabilityQuery(serviceName, date, sessionId)` de `france-scanner.ts`
 *
 * Propriétés couvertes :
 *   - Property 16 : Parse des créneaux préserve les slots valides — pour tout
 *     tableau de créneaux bruts conformes {time HH:MM, rate décimal 2 chiffres,
 *     capacity entier positif}, `parseSlots` round-trip la même liste typée.
 *   - Property 17 : Séparation stricte identifiant `_id` / nom textuel — l'URL
 *     `get-interval` porte `serviceId` (jamais `serviceName`), l'URL
 *     `availability` porte `serviceName` dans le paramètre `name` (jamais
 *     `serviceId`).
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any` : les entrées « arbitraires » sont typées
 * `unknown` et manipulées via des type guards.
 *
 * Validates: Requirements 8.2, 8.4, 14.2
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseSlots } from "../france/france-http.js";
import { buildAvailabilityQuery, buildGetIntervalPath } from "../france/france-scanner.js";
import type { FranceSlot } from "../france/france-types.js";

const NUM_RUNS = 100;

// ─── Motifs de validation (miroirs du contrat de parseSlots) ─────────────────

/** Heure `HH:MM` (`00`..`23` : `00`..`59`). */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Chaîne décimale à exactement deux décimales, ex. `0.00`. */
const RATE_RE = /^\d+\.\d{2}$/;

/** Date `YYYY-MM-DD` structurellement valide. */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ─── Générateurs de créneaux conformes au DTO FranceSlot ─────────────────────

/** Heure `HH:MM` conforme. */
const validTime: fc.Arbitrary<string> = fc
  .record({ h: fc.integer({ min: 0, max: 23 }), m: fc.integer({ min: 0, max: 59 }) })
  .map(
    ({ h, m }) =>
      `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`,
  );

/** Chaîne décimale à deux décimales conforme. */
const validRate: fc.Arbitrary<string> = fc
  .record({ whole: fc.nat({ max: 9999 }), cents: fc.integer({ min: 0, max: 99 }) })
  .map(({ whole, cents }) => `${whole}.${cents.toString().padStart(2, "0")}`);

/** Entier strictement positif. */
const validCapacity: fc.Arbitrary<number> = fc.integer({ min: 1, max: 100 });

/** Créneau brut conforme au DTO. */
const validSlot: fc.Arbitrary<FranceSlot> = fc.record({
  time: validTime,
  rate: validRate,
  capacity: validCapacity,
});

// ─── Générateurs de valeurs « quelconques » (unknown) ────────────────────────

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

/** Type guard : `value` est un créneau conforme au DTO FranceSlot. */
function isConformingSlot(value: unknown): value is FranceSlot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { time, rate, capacity } = value as Record<string, unknown>;
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

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 16: Parse des créneaux préserve les
// slots valides — pour tout tableau de créneaux bruts conformes au DTO,
// parseSlots(raw) produit la MÊME liste de FranceSlot typés {time, rate,
// capacity} (round-trip de structure), où time respecte HH:MM, rate est une
// chaîne décimale à deux décimales et capacity est un entier positif.
// Validates: Requirements 8.2
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 16 — parseSlots préserve les slots valides (france-http.ts)", () => {
  it("round-trip : un tableau de créneaux conformes est préservé à l'identique", () => {
    fc.assert(
      fc.property(fc.array(validSlot, { maxLength: 20 }), (slots) => {
        // Cloner l'entrée pour vérifier que parseSlots ne mute pas la source.
        const raw = slots.map((s) => ({ ...s }));
        const result = parseSlots(raw);

        expect(result).not.toBeNull();
        // Round-trip de structure : même contenu, même ordre.
        expect(result).toEqual(slots);

        // Chaque slot conservé respecte le contrat de format.
        for (const slot of result ?? []) {
          expect(TIME_RE.test(slot.time)).toBe(true);
          expect(RATE_RE.test(slot.rate)).toBe(true);
          expect(Number.isInteger(slot.capacity) && slot.capacity > 0).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("un tableau vide produit une liste vide (pas null)", () => {
    expect(parseSlots([])).toEqual([]);
  });

  it("normalise le créneau à exactement {time, rate, capacity} (champs superflus écartés)", () => {
    fc.assert(
      fc.property(fc.array(validSlot, { maxLength: 10 }), (slots) => {
        const raw = slots.map((s) => ({ ...s, extra: "ignored", nested: { a: 1 } }));
        const result = parseSlots(raw);
        expect(result).toEqual(slots);
        for (const slot of result ?? []) {
          expect(Object.keys(slot).sort()).toEqual(["capacity", "rate", "time"]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette (null) tout tableau contenant au moins un créneau non conforme", () => {
    const nonConforming = arbitraryUnknown.filter((v) => !isConformingSlot(v));
    fc.assert(
      fc.property(
        fc.array(validSlot, { maxLength: 6 }),
        nonConforming,
        fc.array(validSlot, { maxLength: 6 }),
        (before, bad, after) => {
          const raw: unknown[] = [...before, bad, ...after];
          expect(parseSlots(raw)).toBeNull();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

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
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 17: Séparation stricte identifiant
// `_id` / nom textuel — pour tout service {serviceId, serviceName} distincts,
// l'URL construite pour get-interval contient serviceId (jamais serviceName),
// et l'URL construite pour availability contient serviceName dans le paramètre
// `name` (jamais serviceId).
// Validates: Requirements 8.4, 14.2
// ═══════════════════════════════════════════════════════════════════════════

/** Générateur de chaîne hexadécimale (identifiants techniques type `_id`). */
function hexArb(minLength: number, maxLength: number): fc.Arbitrary<string> {
  const hexChar = fc.constantFrom(..."0123456789abcdef".split(""));
  return fc
    .array(hexChar, { minLength, maxLength })
    .map((chars) => chars.join(""));
}

// Identifiants techniques : alphanumériques type MongoDB `_id` (safe en URL).
const serviceIdArb: fc.Arbitrary<string> = hexArb(12, 24);

// Noms textuels : chaînes lisibles avec espaces/accents (nécessitant encodage).
const serviceNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 3, maxLength: 40 })
  .filter((s) => s.trim().length >= 3);

const teamIdArb: fc.Arbitrary<string> = hexArb(6, 24);

const sessionIdArb: fc.Arbitrary<string> = hexArb(6, 24);

const dateArb: fc.Arbitrary<string> = fc
  .record({
    y: fc.integer({ min: 2024, max: 2035 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ y, m, d }) =>
      `${y}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`,
  )
  .filter((s) => DATE_RE.test(s));

/**
 * Paire {serviceId, serviceName} garantie distincte et sans inclusion mutuelle,
 * pour que les assertions « contient / ne contient jamais » soient sans
 * ambiguïté (serviceName préfixé pour ne jamais coïncider avec un id hexa).
 */
const distinctService: fc.Arbitrary<{ serviceId: string; serviceName: string }> = fc
  .record({ serviceId: serviceIdArb, serviceName: serviceNameArb })
  .map(({ serviceId, serviceName }) => ({
    serviceId,
    serviceName: `Service ${serviceName}`,
  }))
  .filter(
    ({ serviceId, serviceName }) =>
      serviceId !== serviceName &&
      !serviceName.includes(serviceId) &&
      !serviceId.includes(serviceName),
  );

describe("Property 17 — séparation stricte serviceId / serviceName (france-scanner.ts)", () => {
  it("get-interval porte serviceId et jamais serviceName", () => {
    fc.assert(
      fc.property(teamIdArb, distinctService, (teamId, { serviceId, serviceName }) => {
        const path = buildGetIntervalPath(teamId, serviceId);
        const url = new URL(path, "https://example.test");

        // serviceId présent dans le paramètre `serviceId`.
        expect(url.searchParams.get("serviceId")).toBe(serviceId);

        // serviceName jamais présent (ni brut, ni encodé) dans le path complet.
        expect(path.includes(serviceName)).toBe(false);
        expect(path.includes(encodeURIComponent(serviceName))).toBe(false);
        // Le nom n'apparaît sous aucune clé de query.
        for (const value of url.searchParams.values()) {
          expect(value).not.toBe(serviceName);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("availability porte serviceName dans le paramètre `name` et jamais serviceId", () => {
    fc.assert(
      fc.property(
        distinctService,
        dateArb,
        sessionIdArb,
        ({ serviceId, serviceName }, date, sessionId) => {
          const query = buildAvailabilityQuery(serviceName, date, sessionId);
          const params = new URLSearchParams(query);

          // serviceName porté par le paramètre `name` (décodé à l'identique).
          expect(params.get("name")).toBe(serviceName);

          // serviceId n'apparaît sous aucune clé de query.
          for (const value of params.values()) {
            expect(value).not.toBe(serviceId);
          }
          // serviceId absent de la query string brute (ni brut, ni encodé).
          expect(query.includes(serviceId)).toBe(false);
          expect(query.includes(encodeURIComponent(serviceId))).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("aucune fuite croisée : le path get-interval et la query availability ne partagent que ce qui leur revient", () => {
    fc.assert(
      fc.property(
        teamIdArb,
        distinctService,
        dateArb,
        sessionIdArb,
        (teamId, { serviceId, serviceName }, date, sessionId) => {
          const intervalPath = buildGetIntervalPath(teamId, serviceId);
          const availabilityQuery = buildAvailabilityQuery(serviceName, date, sessionId);

          // get-interval ne fuit jamais le nom.
          expect(intervalPath.includes(serviceName)).toBe(false);
          // availability ne fuit jamais l'identifiant.
          expect(availabilityQuery.includes(serviceId)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
