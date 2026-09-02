/**
 * france-booking-step-order.test.ts — Test property-based de l'ordre des étapes
 * du parcours de booking Visas (feature france-visa-hunter, task 10.5).
 *
 * Cibles de `src/france/france-booking.ts` :
 *   - `buildBookingSteps(ctx)`   — builder PUR de la liste ordonnée des étapes.
 *   - `BOOKING_STEP_ORDER`       — ordre canonique des `stepType`.
 *   - `runBookingFlow(http, ctx)` — persistance réseau des étapes via
 *     `POST .../update-step-value` (vérifiée ici via un client HTTP mocké).
 *
 * Propriété couverte :
 *   - Property 22 : Ordre des étapes et stepIndex du parcours Visas — la
 *     séquence des `stepType` persistés égale EXACTEMENT
 *     [services, important-info, slots, contact, motif, confirmation]
 *     (welcome EXCLU = ouverture de session) et chaque étape porte un
 *     `stepIndex` égal à sa position (0..5).
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any` : les corps interceptés sont typés `unknown`
 * et lus via des type guards.
 *
 * Validates: Requirements 10.2
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  BOOKING_STEP_ORDER,
  STEP_KEY_BY_TYPE,
  buildBookingSteps,
  runBookingFlow,
} from "../france/france-booking.js";
import { FRANCE_ALLOWED_MOTIFS } from "../france/france-config.js";
import type { FranceHttpClient } from "../france/france-http.js";
import type {
  BookingContact,
  BookingContext,
  FranceAuthState,
  FranceHttpHeadResult,
  FranceHttpResult,
  FranceMotif,
  FranceServiceTarget,
  SlotToKeep,
} from "../france/france-types.js";

const NUM_RUNS = 100;

/** Séquence canonique attendue (Property 22) — dupliquée volontairement ici
 * pour servir d'oracle indépendant de l'implémentation. */
const EXPECTED_STEP_ORDER: readonly string[] = [
  "services",
  "important-info",
  "slots",
  "contact",
  "confirmation",
];

// ─── Générateurs d'un BookingContext VALIDE (contact + motif conformes) ───────
//
// Property 22 concerne l'ordre des étapes persistées. Pour que `runBookingFlow`
// dépasse la validation amont (contact/motif) et atteigne la persistance, on
// génère un contexte dont le contact respecte les bornes (Property 23) et dont
// le motif appartient à FRANCE_ALLOWED_MOTIFS (Property 24).

function stringOfLength(min: number, max: number): fc.Arbitrary<string> {
  return fc
    .array(
      fc.integer({ min: 33, max: 126 }).filter((c) => c !== 64), // exclut '@'
      { minLength: min, maxLength: max },
    )
    .map((codes) => codes.map((c) => String.fromCharCode(c)).join(""));
}

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

const validContact: fc.Arbitrary<BookingContact> = fc.record({
  firstname: stringOfLength(1, 100),
  lastname: stringOfLength(1, 100),
  email: validEmail,
  mobile: stringOfLength(6, 20),
  birthdate: fc.record({
    month: fc.integer({ min: 0, max: 11 }),
    day: fc.integer({ min: 1, max: 31 }),
    year: fc.integer({ min: 1900, max: 2020 }),
  }),
});

/** Chaîne hexadécimale non vide (fast-check v4 : `hexaString` a été retiré). */
const hexId: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."0123456789abcdef".split("")), {
    minLength: 4,
    maxLength: 24,
  })
  .map((chars) => chars.join(""));

const validService: fc.Arbitrary<FranceServiceTarget> = fc.record({
  serviceId: hexId,
  serviceName: fc.string({ minLength: 1, maxLength: 40 }),
});

const validSlot: fc.Arbitrary<SlotToKeep> = fc.record({
  slotValue: fc.string({ minLength: 1, maxLength: 40 }),
  date: fc.constant("2026-09-01T09:30:00"),
  time: fc.constant("09:30"),
  serviceName: fc.string({ minLength: 1, maxLength: 40 }),
  rate: fc.constant("0.00"),
  capacity: fc.constant(1),
});

const validMotif: fc.Arbitrary<FranceMotif> = fc.constantFrom(
  ...FRANCE_ALLOWED_MOTIFS,
);

const validContext: fc.Arbitrary<BookingContext> = fc.record({
  teamId: hexId,
  sessionId: hexId,
  service: validService,
  contact: validContact,
  motifKey: fc.constant("54cfd964c63f3386"),
  motif: validMotif,
  slot: validSlot,
  captchaToken: fc.string({ minLength: 4, maxLength: 40 }),
});

// ─── Client HTTP mocké : enregistre les stepType/stepIndex des étapes POST ────

interface RecordedStep {
  readonly stepType: unknown;
  readonly stepIndex: unknown;
}

interface StepRecorder {
  readonly client: FranceHttpClient;
  readonly recorded: RecordedStep[];
}

/** Lit `{ key, stepIndex }` d'un corps `update-step-value` typé `unknown`. */
function readStepBody(body: unknown): RecordedStep {
  if (typeof body !== "object" || body === null) {
    return { stepType: undefined, stepIndex: undefined };
  }
  const record = body as { key?: unknown; stepIndex?: unknown };
  return { stepType: record.key, stepIndex: record.stepIndex };
}

function okResult<T>(bodyValue: T): FranceHttpResult<T> {
  return {
    status: 200,
    ok: true,
    body: bodyValue,
    sessionError: false,
    teapot: false,
  };
}

/**
 * Construit un client HTTP qui enregistre l'ordre des étapes envoyées à
 * `.../update-step-value` et renvoie une réponse booking valide (un qrCode)
 * pour `.../reservations/family`, de sorte que `runBookingFlow` aille au bout.
 */
function makeStepRecorder(): StepRecorder {
  const recorded: RecordedStep[] = [];

  const client: FranceHttpClient = {
    async get<T>(): Promise<FranceHttpResult<T>> {
      return okResult<T>(null as T);
    },
    async post<T>(path: string, body: unknown): Promise<FranceHttpResult<T>> {
      if (path.endsWith("/update-step-value")) {
        recorded.push(readStepBody(body));
        return okResult<T>(null as T);
      }
      if (path.endsWith("/reservations/family")) {
        return okResult<T>({ data: { qrCodes: ["qr-1"] } } as T);
      }
      return okResult<T>(null as T);
    },
    async head(): Promise<FranceHttpHeadResult> {
      return { status: 200, ok: true, headers: {}, teapot: false };
    },
    updateCsrf(): void {
      // no-op : le token CSRF n'intervient pas dans l'ordre des étapes.
    },
    authState(): Readonly<FranceAuthState> {
      return { handshakeToken: "test-csrf", appId: "test-app-id" };
    },
  };

  return { client, recorded };
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 22: Ordre des étapes et stepIndex du
// parcours Visas — la séquence des stepType persistés égale exactement
// [services, important-info, slots, contact, motif, confirmation] (welcome
// EXCLU) et chaque étape porte un stepIndex égal à sa position (0..5).
// Validates: Requirements 10.2
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 22 — ordre des étapes du booking Visas (buildBookingSteps)", () => {
  it("produit exactement la séquence canonique de stepType, avec stepIndex = position (0..5)", () => {
    fc.assert(
      fc.property(validContext, (ctx) => {
        const steps = buildBookingSteps(ctx);

        expect(steps).toHaveLength(EXPECTED_STEP_ORDER.length);
        expect(steps.map((s) => s.stepType)).toEqual(EXPECTED_STEP_ORDER);

        steps.forEach((step, position) => {
          expect(step.stepIndex).toBe(position);
          // `key` envoyé au portail == NOM D'ÉTAT réel (STEP_KEY_BY_TYPE),
          // distinct du stepType interne (validé live).
          expect(step.key).toBe(STEP_KEY_BY_TYPE[step.stepType]);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("BOOKING_STEP_ORDER est la séquence canonique attendue", () => {
    expect([...BOOKING_STEP_ORDER]).toEqual(EXPECTED_STEP_ORDER);
  });
});

describe("Property 22 — ordre des étapes persistées (runBookingFlow, http mocké)", () => {
  it("envoie update-step-value dans l'ordre canonique, stepIndex 0..6, avant reservations/family", async () => {
    await fc.assert(
      fc.asyncProperty(validContext, async (ctx) => {
        const { client, recorded } = makeStepRecorder();

        const result = await runBookingFlow(client, ctx);

        // Le flux doit avoir persisté les 6 étapes puis réussi (qrCode mocké).
        expect(result.success).toBe(true);
        expect(recorded).toHaveLength(EXPECTED_STEP_ORDER.length);

        // Séquence des `key` réels envoyés == noms d'état mappés (ordre canonique).
        const expectedKeys = EXPECTED_STEP_ORDER.map(
          (t) => STEP_KEY_BY_TYPE[t as keyof typeof STEP_KEY_BY_TYPE],
        );
        expect(recorded.map((r) => r.stepType)).toEqual(expectedKeys);

        // stepIndex == position (0..5).
        recorded.forEach((step, position) => {
          expect(step.stepIndex).toBe(position);
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
