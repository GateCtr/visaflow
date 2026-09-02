/**
 * france-booking-slot-reservations.test.ts — Tests property-based du slotValue,
 * des reservations et de l'interprétation de la réponse de booking
 * (feature france-visa-hunter, task 10.3).
 *
 * Cibles (fonctions PURES de `src/france/france-booking.ts`) :
 *   - `computeSlotValue` / `buildSlotToKeep` — Property 25.
 *   - `buildReservations`                    — Property 26.
 *   - `interpretBookingResponse`             — Property 27.
 *
 * Propriétés couvertes :
 *   - Property 25 : slotValue déterministe et en minuscules — mêmes entrées →
 *     même sortie, sortie entièrement en minuscules ; le `SlotToKeep` porte ce
 *     `slotValue`, la `date` au format `YYYY-MM-DDTHH:MM:00`, le `time` et le
 *     `serviceName` fournis.
 *   - Property 26 : Structure des reservations bien formée pour Visas —
 *     `buildReservations` produit `{mainUser, secondaryUsers: [], sessionId,
 *     team}` avec `team = teamId` et `mainUser.services[0]` portant à la fois
 *     `customFields` (avec la clé motif) et `slotsToKeep`.
 *   - Property 27 : Succès du booking conditionné à qrCodes non vide —
 *     `interpretBookingResponse` retourne `success = true` ssi `data.qrCodes`
 *     est présent et non vide.
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any` : les entrées « arbitraires » sont typées
 * `unknown` et manipulées via des type guards.
 *
 * Validates: Requirements 10.8, 10.10, 10.11
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildReservations,
  buildSlotToKeep,
  computeSlotValue,
  interpretBookingResponse,
} from "../france/france-booking.js";
import { FRANCE_ALLOWED_MOTIFS, FRANCE_MOTIF_KEY } from "../france/france-config.js";
import type {
  BookingContact,
  BookingContext,
  FranceMotif,
  FranceServiceTarget,
  SlotToKeep,
} from "../france/france-types.js";

const NUM_RUNS = 100;

// ─── Générateurs communs ─────────────────────────────────────────────────────

/** Date `YYYY-MM-DD` réelle (existante), pour construire slotValue/SlotToKeep. */
const MS_PER_DAY = 86_400_000;
const MIN_DAY_MS = Date.UTC(2000, 0, 1);
const MAX_DAY_MS = Date.UTC(2035, 11, 31);

function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const slotDateIso: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: Math.floor((MAX_DAY_MS - MIN_DAY_MS) / MS_PER_DAY) })
  .map((offset) => formatUtcDay(MIN_DAY_MS + offset * MS_PER_DAY));

/** Heure `HH:MM` (00:00 .. 23:59). */
const timeHhMm: fc.Arbitrary<string> = fc
  .record({ h: fc.integer({ min: 0, max: 23 }), m: fc.integer({ min: 0, max: 59 }) })
  .map(({ h, m }) => `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);

/** Nom de service arbitraire (accents/casse/symboles inclus pour éprouver le slug). */
const serviceName: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 60 });

/** Motif appartenant à la liste autorisée. */
const franceMotif: fc.Arbitrary<FranceMotif> = fc.constantFrom(
  ...(FRANCE_ALLOWED_MOTIFS as readonly FranceMotif[]),
);

/** Contact bien formé (les bornes exactes sont testées par Property 23 ailleurs). */
const bookingContact: fc.Arbitrary<BookingContact> = fc.record({
  firstname: fc.string({ minLength: 1, maxLength: 30 }),
  lastname: fc.string({ minLength: 1, maxLength: 30 }),
  email: fc.emailAddress(),
  mobile: fc.string({ minLength: 6, maxLength: 20 }),
  birthdate: fc.record({
    month: fc.integer({ min: 0, max: 11 }),
    day: fc.integer({ min: 1, max: 28 }),
    year: fc.integer({ min: 1900, max: 2010 }),
  }),
});

const serviceTarget: fc.Arbitrary<FranceServiceTarget> = fc.record({
  serviceId: fc.string({ minLength: 1, maxLength: 24 }),
  serviceName,
});

const slotToKeep: fc.Arbitrary<SlotToKeep> = fc
  .record({ name: serviceName, date: slotDateIso, time: timeHhMm })
  .map(({ name, date, time }) => buildSlotToKeep(name, date, time, "0.00", 1));

const bookingContext: fc.Arbitrary<BookingContext> = fc.record({
  teamId: fc.string({ minLength: 1, maxLength: 24 }),
  sessionId: fc.string({ minLength: 1, maxLength: 36 }),
  service: serviceTarget,
  contact: bookingContact,
  motifKey: fc.constant("54cfd964c63f3386"),
  motif: franceMotif,
  slot: slotToKeep,
  captchaToken: fc.string({ minLength: 1, maxLength: 64 }),
});

// ─── Générateur de bruit `unknown` (pour Property 27) ─────────────────────────

const arbitraryUnknown: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.constant(undefined),
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie("node"), { maxKeys: 4 }),
  ) as fc.Arbitrary<unknown>,
})).node;

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 25: slotValue déterministe et en
// minuscules — pour tout triplet (serviceName, ISOdate, time), computeSlotValue
// est déterministe (mêmes entrées → même sortie), sa sortie est entièrement en
// minuscules, et le SlotToKeep construit porte ce slotValue, la date au format
// YYYY-MM-DDTHH:MM:00, le time et le serviceName fournis.
// Validates: Requirements 10.8
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 25 — computeSlotValue / buildSlotToKeep (france-booking.ts)", () => {
  it("computeSlotValue est déterministe (mêmes entrées → même sortie)", () => {
    fc.assert(
      fc.property(serviceName, slotDateIso, timeHhMm, (name, date, time) => {
        const a = computeSlotValue(name, date, time);
        const b = computeSlotValue(name, date, time);
        expect(a).toBe(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("computeSlotValue produit une sortie entièrement en minuscules", () => {
    fc.assert(
      fc.property(serviceName, slotDateIso, timeHhMm, (name, date, time) => {
        const value = computeSlotValue(name, date, time);
        expect(value).toBe(value.toLowerCase());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("buildSlotToKeep porte le slotValue, la date YYYY-MM-DDTHH:MM:00, le time et le serviceName", () => {
    fc.assert(
      fc.property(serviceName, slotDateIso, timeHhMm, (name, date, time) => {
        const slot = buildSlotToKeep(name, date, time, "0.00", 1);

        // Le slotValue est exactement celui de computeSlotValue (et en minuscules).
        expect(slot.slotValue).toBe(computeSlotValue(name, date, time));
        expect(slot.slotValue).toBe(slot.slotValue.toLowerCase());

        // Format de date : YYYY-MM-DDTHH:MM:00.
        expect(slot.date).toBe(`${date}T${time}:00`);
        expect(slot.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);

        // time et serviceName repris tels quels.
        expect(slot.time).toBe(time);
        expect(slot.serviceName).toBe(name);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("exemple : accents et casse sont slugifiés en minuscules", () => {
    const value = computeSlotValue("Visa Étudiant", "2026-03-15", "09:30");
    expect(value).toBe(value.toLowerCase());
    expect(value).toMatch(/^[a-z0-9-]+$/);
    expect(value).toContain("visa-etudiant");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 26: Structure des reservations bien
// formée pour Visas — pour tout BookingContext, buildReservations produit
// {mainUser, secondaryUsers: [], sessionId, team} où team = teamId, et
// mainUser.services[0] contient à la fois customFields (avec la clé motif) et
// slotsToKeep.
// Validates: Requirements 10.10
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 26 — buildReservations (france-booking.ts)", () => {
  it("produit {mainUser, secondaryUsers: [], sessionId, team=teamId} bien formé", () => {
    fc.assert(
      fc.property(bookingContext, (ctx) => {
        const reservations = buildReservations(ctx);

        // secondaryUsers est un tableau vide (Visas : reservation_people_max = 1).
        expect(Array.isArray(reservations.secondaryUsers)).toBe(true);
        expect(reservations.secondaryUsers).toHaveLength(0);

        // sessionId et team recopiés du contexte.
        expect(reservations.sessionId).toBe(ctx.sessionId);
        expect(reservations.team).toBe(ctx.teamId);

        // mainUser hérite du contact + expose exactement un service.
        expect(reservations.mainUser.firstname).toBe(ctx.contact.firstname);
        expect(reservations.mainUser.lastname).toBe(ctx.contact.lastname);
        expect(reservations.mainUser.services).toHaveLength(1);

        const service = reservations.mainUser.services[0];

        // customFields présents, avec la clé motif et la valeur du contexte.
        expect(Array.isArray(service.customFields)).toBe(true);
        const motifField = service.customFields.find((f) => f.key === FRANCE_MOTIF_KEY);
        expect(motifField).toBeDefined();
        expect(motifField?.values).toEqual([ctx.motif]);

        // birthdate converti en objet {month,day,year} (bundle setupUserForApi).
        expect(reservations.mainUser.birthdate).toEqual({
          month: ctx.contact.birthdate.month,
          day: ctx.contact.birthdate.day,
          year: ctx.contact.birthdate.year,
        });

        // slotsToKeep : slot COMPLET (bundle setupServiceForApi) — spread du slot
        // persisté + numberOfApplicants:1 + date réécrite "YYYY-MM-DDTHH:MM:00".
        expect(Array.isArray(service.slotsToKeep)).toBe(true);
        expect(service.slotsToKeep).toEqual([
          {
            time: ctx.slot.time,
            rate: ctx.slot.rate,
            capacity: ctx.slot.capacity,
            numberOfApplicants: 1,
            slotValue: ctx.slot.slotValue,
            serviceName: ctx.slot.serviceName,
            date: `${ctx.slot.date.slice(0, 10)}T${ctx.slot.time}:00`,
          },
        ]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 27: Succès du booking conditionné à
// qrCodes non vide — pour toute réponse de reservations/family,
// interpretBookingResponse retourne success = true si et seulement si
// data.qrCodes est présent et non vide.
// Validates: Requirements 10.11
// ═══════════════════════════════════════════════════════════════════════════

/** Oracle miroir du contrat : true ssi res.data.qrCodes est un tableau non vide. */
function hasNonEmptyQrCodes(res: unknown): boolean {
  if (typeof res !== "object" || res === null) return false;
  const data = (res as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const qrCodes = (data as { qrCodes?: unknown }).qrCodes;
  return Array.isArray(qrCodes) && qrCodes.length > 0;
}

describe("Property 27 — interpretBookingResponse (france-booking.ts)", () => {
  it("success = true ssi data.qrCodes est un tableau non vide (réponses conformes)", () => {
    const qrCodesArray = fc.array(
      fc.oneof(fc.string(), fc.integer(), fc.record({ code: fc.string() })),
      { minLength: 1, maxLength: 5 },
    );
    fc.assert(
      fc.property(qrCodesArray, (qrCodes) => {
        const result = interpretBookingResponse({ data: { qrCodes } });
        expect(result.success).toBe(true);
        expect(result.qrCodes).toEqual(qrCodes);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("success = false quand data.qrCodes est un tableau vide", () => {
    const result = interpretBookingResponse({ data: { qrCodes: [] } });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("success = false pour toute réponse sans qrCodes non vide (bruit arbitraire)", () => {
    fc.assert(
      fc.property(
        arbitraryUnknown.filter((v) => !hasNonEmptyQrCodes(v)),
        (res) => {
          expect(interpretBookingResponse(res).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("équivalence exacte avec l'oracle sur des réponses variées (avec/sans qrCodes)", () => {
    // Mélange volontaire de réponses conformes et non conformes.
    const mixedResponse = fc.oneof(
      arbitraryUnknown,
      fc
        .array(fc.string(), { maxLength: 4 })
        .map((qrCodes) => ({ data: { qrCodes } }) as unknown),
    );
    fc.assert(
      fc.property(mixedResponse, (res) => {
        expect(interpretBookingResponse(res).success).toBe(hasNonEmptyQrCodes(res));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
