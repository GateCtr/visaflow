/**
 * france-booking-contact-motif.test.ts — Tests property-based de la validation
 * du contact et du motif (feature france-visa-hunter, task 10.2).
 *
 * Cibles (fonctions PURES) de `france-booking.ts` :
 *   - `validateContact(contact, currentYear?)`
 *   - `validateMotif(motif)`
 *
 * Propriétés couvertes :
 *   - Property 23 : Validation des bornes du contact — valide ssi
 *       firstname/lastname ∈ [1, 100] caractères, email = `@` + domaine (point
 *       après le `@`), mobile ∈ [6, 20] caractères, birthdate.month ∈ [0, 11],
 *       birthdate.day ∈ [1, 31], birthdate.year ∈ [1900, currentYear].
 *   - Property 24 : Validation du motif par appartenance à la liste —
 *       `validateMotif(motif)` vrai ssi `motif ∈ FRANCE_ALLOWED_MOTIFS`.
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any`.
 *
 * Validates: Requirements 10.4, 10.6
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { validateContact, validateMotif } from "../france/france-booking.js";
import { FRANCE_ALLOWED_MOTIFS } from "../france/france-config.js";
import type { BookingContact } from "../france/france-types.js";

const NUM_RUNS = 100;

// Année de référence injectée pour rendre `validateContact` déterministe.
const CURRENT_YEAR = 2026;

// ─── Oracle: contrat de validité d'un contact (miroir de validateContact) ─────

/** Un email est valide ssi il contient un seul `@` (≥ 1 char avant) et un
 * point dans le domaine, ni en tête ni en fin. */
function isValidEmailOracle(email: string): boolean {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return false;
  if (email.indexOf("@", atIndex + 1) !== -1) return false;
  const domain = email.slice(atIndex + 1);
  const dotIndex = domain.indexOf(".");
  return dotIndex > 0 && dotIndex < domain.length - 1;
}

function isValidContactOracle(contact: BookingContact, currentYear: number): boolean {
  const { firstname, lastname, email, mobile, birthdate } = contact;
  if (firstname.length < 1 || firstname.length > 100) return false;
  if (lastname.length < 1 || lastname.length > 100) return false;
  if (!isValidEmailOracle(email)) return false;
  if (mobile.length < 6 || mobile.length > 20) return false;
  const { month, day, year } = birthdate;
  if (!Number.isInteger(month) || month < 0 || month > 11) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  if (!Number.isInteger(year) || year < 1900 || year > currentYear) return false;
  return true;
}

// ─── Générateurs de champs conformes ──────────────────────────────────────────

/** Chaîne de longueur dans [min, max] (caractères imprimables, pas de `@`). */
function stringOfLength(min: number, max: number): fc.Arbitrary<string> {
  return fc
    .array(
      fc.integer({ min: 33, max: 126 }).filter((c) => c !== 64), // exclut '@'
      { minLength: min, maxLength: max },
    )
    .map((codes) => codes.map((c) => String.fromCharCode(c)).join(""));
}

const validFirstname = stringOfLength(1, 100);
const validLastname = stringOfLength(1, 100);
const validMobile = stringOfLength(6, 20);

/** Email `local@domain.tld` structurellement valide. */
const validEmail: fc.Arbitrary<string> = fc
  .record({
    local: stringOfLength(1, 10).map((s) => s.replace(/@/g, "x")),
    domain: fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
        minLength: 1,
        maxLength: 8,
      })
      .map((c) => c.join("")),
    tld: fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
        minLength: 2,
        maxLength: 4,
      })
      .map((c) => c.join("")),
  })
  .map(({ local, domain, tld }) => `${local}@${domain}.${tld}`);

const validBirthdate: fc.Arbitrary<BookingContact["birthdate"]> = fc.record({
  month: fc.integer({ min: 0, max: 11 }),
  day: fc.integer({ min: 1, max: 31 }),
  year: fc.integer({ min: 1900, max: CURRENT_YEAR }),
});

const validContact: fc.Arbitrary<BookingContact> = fc.record({
  firstname: validFirstname,
  lastname: validLastname,
  email: validEmail,
  mobile: validMobile,
  birthdate: validBirthdate,
});

// ─── Générateur de contact « quelconque » (souvent invalide) ──────────────────
//
// On mélange bornes hors intervalle et valeurs conformes pour couvrir largement
// l'espace : la propriété affirme l'équivalence avec l'oracle sur tout l'espace.

const anyString: fc.Arbitrary<string> = fc.string({ maxLength: 130 });
const anyEmail: fc.Arbitrary<string> = fc.oneof(validEmail, anyString);
const anyBirthdate: fc.Arbitrary<BookingContact["birthdate"]> = fc.record({
  month: fc.oneof(fc.integer({ min: -5, max: 16 }), fc.double({ min: -5, max: 16 })),
  day: fc.oneof(fc.integer({ min: -5, max: 40 }), fc.double({ min: -5, max: 40 })),
  year: fc.oneof(fc.integer({ min: 1850, max: CURRENT_YEAR + 10 }), fc.double()),
});

const anyContact: fc.Arbitrary<BookingContact> = fc.record({
  firstname: fc.oneof(validFirstname, anyString, fc.constant("")),
  lastname: fc.oneof(validLastname, anyString, fc.constant("")),
  email: anyEmail,
  mobile: fc.oneof(validMobile, anyString, fc.constant("")),
  birthdate: anyBirthdate,
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 23: Validation des bornes du contact —
// validateContact(contact, currentYear) renvoie { valid: true } ssi
// firstname/lastname ∈ [1, 100], email a un `@` + domaine avec point, mobile ∈
// [6, 20], birthdate.month ∈ [0, 11], day ∈ [1, 31], year ∈ [1900, currentYear].
// Sinon { valid: false, invalidField }.
// Validates: Requirements 10.4
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 23 — validateContact (france-booking.ts)", () => {
  it("accepte (valid: true) tout contact dont tous les champs sont dans leurs bornes", () => {
    fc.assert(
      fc.property(validContact, (contact) => {
        const result = validateContact(contact, CURRENT_YEAR);
        expect(result.valid).toBe(true);
        expect(result.invalidField).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("est équivalent à l'oracle des bornes sur tout l'espace (valide ssi oracle)", () => {
    fc.assert(
      fc.property(anyContact, (contact) => {
        const expected = isValidContactOracle(contact, CURRENT_YEAR);
        expect(validateContact(contact, CURRENT_YEAR).valid).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette un firstname vide ou > 100 caractères en pointant le bon champ", () => {
    const badFirstname = fc.oneof(fc.constant(""), stringOfLength(101, 130));
    fc.assert(
      fc.property(validContact, badFirstname, (base, firstname) => {
        const result = validateContact({ ...base, firstname }, CURRENT_YEAR);
        expect(result.valid).toBe(false);
        expect(result.invalidField).toBe("firstname");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette un mobile hors [6, 20] caractères", () => {
    const badMobile = fc.oneof(stringOfLength(0, 5), stringOfLength(21, 30));
    fc.assert(
      fc.property(validContact, badMobile, (base, mobile) => {
        const result = validateContact({ ...base, mobile }, CURRENT_YEAR);
        expect(result.valid).toBe(false);
        expect(result.invalidField).toBe("mobile");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette un email sans `@` ou sans point de domaine", () => {
    const badEmail = anyString.filter((s) => !isValidEmailOracle(s));
    fc.assert(
      fc.property(validContact, badEmail, (base, email) => {
        const result = validateContact({ ...base, email }, CURRENT_YEAR);
        expect(result.valid).toBe(false);
        expect(result.invalidField).toBe("email");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette un birthdate.month hors [0, 11]", () => {
    const badMonth = fc.oneof(
      fc.integer({ min: -10, max: -1 }),
      fc.integer({ min: 12, max: 24 }),
    );
    fc.assert(
      fc.property(validContact, badMonth, (base, month) => {
        const result = validateContact(
          { ...base, birthdate: { ...base.birthdate, month } },
          CURRENT_YEAR,
        );
        expect(result.valid).toBe(false);
        expect(result.invalidField).toBe("birthdate.month");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette un birthdate.day hors [1, 31]", () => {
    const badDay = fc.oneof(
      fc.integer({ min: -10, max: 0 }),
      fc.integer({ min: 32, max: 50 }),
    );
    fc.assert(
      fc.property(validContact, badDay, (base, day) => {
        const result = validateContact(
          { ...base, birthdate: { ...base.birthdate, day } },
          CURRENT_YEAR,
        );
        expect(result.valid).toBe(false);
        expect(result.invalidField).toBe("birthdate.day");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette un birthdate.year hors [1900, currentYear]", () => {
    const badYear = fc.oneof(
      fc.integer({ min: 1500, max: 1899 }),
      fc.integer({ min: CURRENT_YEAR + 1, max: CURRENT_YEAR + 50 }),
    );
    fc.assert(
      fc.property(validContact, badYear, (base, year) => {
        const result = validateContact(
          { ...base, birthdate: { ...base.birthdate, year } },
          CURRENT_YEAR,
        );
        expect(result.valid).toBe(false);
        expect(result.invalidField).toBe("birthdate.year");
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 24: Validation du motif par
// appartenance à la liste — validateMotif(motif) vrai ssi
// motif ∈ FRANCE_ALLOWED_MOTIFS. Toute chaîne hors liste est rejetée (false).
// Validates: Requirements 10.6
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 24 — validateMotif (france-booking.ts)", () => {
  it("accepte (true) exactement chaque motif de FRANCE_ALLOWED_MOTIFS", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FRANCE_ALLOWED_MOTIFS), (motif) => {
        expect(validateMotif(motif)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejette (false) toute chaîne hors de la liste autorisée", () => {
    const allowed = new Set<string>(FRANCE_ALLOWED_MOTIFS);
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }).filter((s) => !allowed.has(s)),
        (motif) => {
          expect(validateMotif(motif)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("est équivalent à l'appartenance à FRANCE_ALLOWED_MOTIFS sur un mélange de motifs valides et de bruit", () => {
    const allowed = new Set<string>(FRANCE_ALLOWED_MOTIFS);
    const mixed = fc.oneof(
      fc.constantFrom<string>(...FRANCE_ALLOWED_MOTIFS),
      fc.string({ maxLength: 60 }),
    );
    fc.assert(
      fc.property(mixed, (motif) => {
        expect(validateMotif(motif)).toBe(allowed.has(motif));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
