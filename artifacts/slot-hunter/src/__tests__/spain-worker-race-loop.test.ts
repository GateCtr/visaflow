/**
 * spain-worker-race-loop.test.ts — Property + unit tests de la boucle worker
 * synchronisée et du mode RACE (feature spain-synchronized-scan, tâche 10.3).
 *
 * Le module `spain-dossier-worker.ts` tire un lourd graphe d'imports (impit,
 * CapSolver, Redis, Convex, Decodo). On mocke ici les modules d'infra dont
 * dépendent les fonctions SOUS TEST, de sorte qu'aucun réseau/proxy réel ne soit
 * touché :
 *   - `spain-slot-coordinator.js` → `publishSlotSnapshot` mockée (retry de publication).
 *
 * Le seuil de bypass RACE (`RACE_BYPASS_THRESHOLD`) est lu UNE FOIS depuis
 * `SPAIN_RACE_BYPASS_THRESHOLD` au chargement du module. On fixe donc la variable
 * AVANT l'import dynamique du module worker (dans `beforeAll`).
 *
 * Scénarios couverts :
 *   - Property 5 : Monotonie de slotEverSeen — ∀ transitions, jamais true → false.
 *     (via `markSlotSeen`, le setter monotone utilisé par la boucle worker.)
 *     Validates: Requirements 8.5, 9.1
 *   - Property 9 : Borne de fenêtre — ∀ itération, aucun scan si Date.now() >= windowEnd.
 *     (via `isWindowOpen` / `shouldScheduleWake`, les gardes de fenêtre de la boucle.)
 *     Validates: Requirements 12.1, 12.3
 *   - Unit : snapshot < 60 s ⟹ booking, ≥ 60 s ⟹ ignoré/expiré (Req 9.3, 9.4).
 *   - Unit : somme capacités ≥ seuil ⟹ bypass sémaphore (Req 9.5).
 *   - Unit : retry publication 3× avec backoff exponentiel (Req 9.6).
 *
 * Validates: Requirements 8.5, 9.1, 9.3, 9.4, 9.5, 9.6, 12.1, 12.3
 */

import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerRuntimeState } from "../spain/spain-grid-config.js";
import type { SlotSnapEntry } from "../spain-redis-persistence.js";

// ─── Mock du coordinateur de slots (publishSlotSnapshot → Redis) ──────────────
//
// spain-dossier-worker importe publishSlotSnapshot depuis spain-slot-coordinator.
// On mocke ce module pour intercepter la publication sans toucher Redis.

vi.mock("../spain-slot-coordinator.js", () => ({
  tryClaimSlot: vi.fn(),
  releaseSlotClaim: vi.fn(),
  reserveWorkerIp: vi.fn(),
  isIpReservedByOther: vi.fn(),
  releaseWorkerIp: vi.fn(),
  publishSlotSnapshot: vi.fn(),
  recordBookingWinner: vi.fn(),
}));

import { publishSlotSnapshot } from "../spain-slot-coordinator.js";

const mockPublishSlotSnapshot = vi.mocked(publishSlotSnapshot);

// ─── Seuil de bypass RACE fixé AVANT le chargement du module worker ───────────

const TEST_RACE_BYPASS_THRESHOLD = 5;

// ─── Références aux symboles importés dynamiquement ───────────────────────────

type WorkerModule = typeof import("../spain-dossier-worker.js");
let worker: WorkerModule;

beforeAll(async () => {
  // Le constant RACE_BYPASS_THRESHOLD est calculé à l'import → fixer l'env d'abord.
  process.env.SPAIN_RACE_BYPASS_THRESHOLD = String(TEST_RACE_BYPASS_THRESHOLD);
  worker = await import("../spain-dossier-worker.js");
});

afterAll(() => {
  delete process.env.SPAIN_RACE_BYPASS_THRESHOLD;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Silencer les logs du worker pour garder la sortie de test lisible.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Par défaut, la publication réussit.
  mockPublishSlotSnapshot.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Fabriques de test ────────────────────────────────────────────────────────

const TAG = "[test-worker]";

/** Construit un WorkerRuntimeState minimal et valide. */
function makeRuntimeState(overrides: Partial<WorkerRuntimeState> = {}): WorkerRuntimeState {
  return {
    dossierId: "dossier-test-1",
    state: "SCANNING",
    gridSeed: 123456,
    proxyUrl: "http://user:pass@10.0.0.1:10000",
    slotEverSeen: false,
    lastScanAtMs: 0,
    ...overrides,
  };
}

/** Construit une liste de créneaux avec une capacité libre donnée par créneau. */
function makeSlots(freeCapacities: number[]): Array<{ date: string; time: string; agendaId: string; freeslots: number }> {
  return freeCapacities.map((cap, i) => ({
    date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    time: `${String(9 + (i % 8)).padStart(2, "0")}:00`,
    agendaId: "ag-1",
    freeslots: cap,
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
//  Property 5 — Monotonie de slotEverSeen (jamais true → false)
//  Validates: Requirements 8.5, 9.1
// ══════════════════════════════════════════════════════════════════════════════

describe("Property 5 — monotonie de slotEverSeen (markSlotSeen)", () => {
  it("ne repasse JAMAIS slotEverSeen de true à false sur une suite de scans arbitraires", () => {
    fc.assert(
      fc.property(
        // Une suite de scans, chacun décrit par la capacité libre de ses créneaux.
        fc.array(fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 6 }), { maxLength: 40 }),
        (scanCapacities) => {
          const rt = makeRuntimeState({ slotEverSeen: false });
          let previous = rt.slotEverSeen;

          for (const caps of scanCapacities) {
            worker.markSlotSeen(rt, makeSlots(caps));
            // Invariant de monotonie : jamais true → false.
            if (previous === true) {
              expect(rt.slotEverSeen).toBe(true);
            }
            previous = rt.slotEverSeen;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("bascule à true dès qu'un créneau a une capacité libre > 0 et y reste", () => {
    const rt = makeRuntimeState({ slotEverSeen: false });

    // Scan sans capacité libre → reste false.
    expect(worker.markSlotSeen(rt, makeSlots([0, 0]))).toBe(false);
    expect(rt.slotEverSeen).toBe(false);

    // Scan avec capacité libre → bascule true, renvoie true (première transition).
    expect(worker.markSlotSeen(rt, makeSlots([0, 2]))).toBe(true);
    expect(rt.slotEverSeen).toBe(true);

    // Scan ultérieur SANS capacité → reste true (monotonie), renvoie false (pas de transition).
    expect(worker.markSlotSeen(rt, makeSlots([0, 0]))).toBe(false);
    expect(rt.slotEverSeen).toBe(true);
  });

  it("ne signale la transition qu'une seule fois (idempotent une fois true)", () => {
    const rt = makeRuntimeState({ slotEverSeen: false });
    expect(worker.markSlotSeen(rt, makeSlots([1]))).toBe(true);
    // Déjà true → renvoie false même avec capacité libre.
    expect(worker.markSlotSeen(rt, makeSlots([3]))).toBe(false);
    expect(rt.slotEverSeen).toBe(true);
  });

  it("un créneau à freeslots=0 ne déclenche jamais slotEverSeen", () => {
    const rt = makeRuntimeState({ slotEverSeen: false });
    expect(worker.markSlotSeen(rt, makeSlots([]))).toBe(false);
    expect(worker.markSlotSeen(rt, makeSlots([0, 0, 0]))).toBe(false);
    expect(rt.slotEverSeen).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Property 9 — Borne de fenêtre (aucun scan si Date.now() >= windowEnd)
//  Validates: Requirements 12.1, 12.3
// ══════════════════════════════════════════════════════════════════════════════

describe("Property 9 — borne de fenêtre (isWindowOpen / shouldScheduleWake)", () => {
  it("isWindowOpen est vrai ssi nowMs < windowEnd (∀ now, windowEnd)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (nowMs, windowEnd) => {
          expect(worker.isWindowOpen(nowMs, windowEnd)).toBe(nowMs < windowEnd);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("aucun scan (fenêtre fermée) dès que Date.now() >= windowEnd", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (windowEnd, over) => {
          // À windowEnd et au-delà, la fenêtre est fermée → pas de scan.
          expect(worker.isWindowOpen(windowEnd + over, windowEnd)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("shouldScheduleWake est vrai ssi le réveil tombe avant windowEnd (∀ wakeAt, windowEnd)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        (wakeAtMs, windowEnd) => {
          expect(worker.shouldScheduleWake(wakeAtMs, windowEnd)).toBe(wakeAtMs < windowEnd);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("ne planifie jamais un réveil à windowEnd ou au-delà (Req 12.3)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (windowEnd, over) => {
          expect(worker.shouldScheduleWake(windowEnd + over, windowEnd)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("cas bornes : now == windowEnd fermé, now == windowEnd-1 ouvert", () => {
    expect(worker.isWindowOpen(1_000, 1_000)).toBe(false);
    expect(worker.isWindowOpen(999, 1_000)).toBe(true);
    expect(worker.shouldScheduleWake(1_000, 1_000)).toBe(false);
    expect(worker.shouldScheduleWake(999, 1_000)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Unit — attemptBookingRace : fraîcheur du snapshot + seuil de bypass
//  Validates: Requirements 9.3, 9.4, 9.5
// ══════════════════════════════════════════════════════════════════════════════

describe("attemptBookingRace — fraîcheur du snapshot (Req 9.3 / 9.4)", () => {
  it("snapshot < 60 s ⟹ non expiré (booking autorisé)", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    const snapshot = {
      agendaId: "ag-1",
      serviceId: "svc-1",
      slots: makeSlots([1, 1]),
      detectedAtMs: nowMs - 59_000, // 59 s → frais
    };
    const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
    expect(decision.expired).toBe(false);
  });

  it("snapshot exactement 60 s ⟹ expiré (aucun booking depuis ce snapshot)", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    const snapshot = {
      agendaId: "ag-1",
      serviceId: "svc-1",
      slots: makeSlots([9, 9]),
      detectedAtMs: nowMs - worker.RACE_SNAPSHOT_FRESHNESS_MS, // pile 60 s → expiré (>=)
    };
    const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
    expect(decision.expired).toBe(true);
    // Un snapshot expiré ne doit jamais autoriser le bypass, quelle que soit la capacité.
    expect(decision.bypassSemaphore).toBe(false);
  });

  it("snapshot > 60 s ⟹ expiré", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    const snapshot = {
      agendaId: "ag-1",
      serviceId: "svc-1",
      slots: makeSlots([1]),
      detectedAtMs: nowMs - 120_000, // 2 min
    };
    const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
    expect(decision.expired).toBe(true);
  });

  it("attemptBookingRace ne mute jamais slotEverSeen (lecture seule)", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    worker.attemptBookingRace(
      rt,
      { agendaId: "ag", serviceId: "s", slots: makeSlots([0]), detectedAtMs: nowMs - 200_000 },
      nowMs,
      TAG,
    );
    // Snapshot expiré + capacité nulle : slotEverSeen reste true (jamais remis à false).
    expect(rt.slotEverSeen).toBe(true);
  });
});

describe("attemptBookingRace — seuil de bypass sémaphore (Req 9.5)", () => {
  it("somme des capacités >= seuil ⟹ bypass sémaphore (snapshot frais)", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    // 2 + 3 = 5 == seuil (TEST_RACE_BYPASS_THRESHOLD).
    const snapshot = {
      agendaId: "ag-1",
      serviceId: "svc-1",
      slots: makeSlots([2, 3]),
      detectedAtMs: nowMs - 1_000,
    };
    const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
    expect(decision.expired).toBe(false);
    expect(decision.totalFreeCapacity).toBe(5);
    expect(decision.bypassSemaphore).toBe(true);
  });

  it("somme des capacités < seuil ⟹ respect du sémaphore", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    // 1 + 2 = 3 < 5.
    const snapshot = {
      agendaId: "ag-1",
      serviceId: "svc-1",
      slots: makeSlots([1, 2]),
      detectedAtMs: nowMs - 1_000,
    };
    const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
    expect(decision.totalFreeCapacity).toBe(3);
    expect(decision.bypassSemaphore).toBe(false);
  });

  it("les capacités négatives sont ignorées (bornées à 0) dans la somme", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    // -5 borné à 0, + 6 = 6 >= 5.
    const snapshot = {
      agendaId: "ag-1",
      serviceId: "svc-1",
      slots: makeSlots([-5, 6]),
      detectedAtMs: nowMs - 1_000,
    };
    const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
    expect(decision.totalFreeCapacity).toBe(6);
    expect(decision.bypassSemaphore).toBe(true);
  });

  it("un snapshot expiré ne bypass jamais, même si la capacité dépasse le seuil", () => {
    const nowMs = 2_000_000;
    const rt = makeRuntimeState({ slotEverSeen: true });
    const snapshot = {
      agendaId: "ag-1",
      serviceId: "svc-1",
      slots: makeSlots([100]),
      detectedAtMs: nowMs - 90_000, // expiré
    };
    const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
    expect(decision.expired).toBe(true);
    expect(decision.bypassSemaphore).toBe(false);
  });

  it("property : bypass ssi (frais ET totalFreeCapacity >= seuil)", () => {
    const threshold = worker.RACE_BYPASS_THRESHOLD;
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 0, maxLength: 8 }),
        fc.integer({ min: 0, max: 200_000 }), // âge du snapshot en ms
        (caps, ageMs) => {
          const nowMs = 5_000_000;
          const rt = makeRuntimeState({ slotEverSeen: true });
          const snapshot = {
            agendaId: "ag-1",
            serviceId: "svc-1",
            slots: makeSlots(caps),
            detectedAtMs: nowMs - ageMs,
          };
          const decision = worker.attemptBookingRace(rt, snapshot, nowMs, TAG);
          const total = caps.reduce((s, c) => s + Math.max(0, c), 0);
          const fresh = ageMs < worker.RACE_SNAPSHOT_FRESHNESS_MS;
          expect(decision.totalFreeCapacity).toBe(total);
          expect(decision.expired).toBe(!fresh);
          expect(decision.bypassSemaphore).toBe(fresh && total >= threshold);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("publication/race — Bookitit arbitre sans blocage Redis", () => {
  it("désactive toute coordination pré-booking en race, mais la conserve hors race", () => {
    expect(worker.shouldCoordinateBeforeBooking(true)).toBe(false);
    expect(worker.shouldCoordinateBeforeBooking(false)).toBe(true);
  });

  it("plusieurs workers peuvent tenter immédiatement le même créneau", () => {
    const workers = Array.from({ length: 3 }, () => ({
      canAttempt: !worker.shouldCoordinateBeforeBooking(true),
    }));

    expect(workers.every((entry) => entry.canAttempt)).toBe(true);
  });

  it("un gagnant et plusieurs signin/ 0B font passer les perdants au candidat suivant", () => {
    const outcomes = [
      { status: "booked" as const, errorMessage: undefined },
      { status: "signin_failed" as const, errorMessage: "signin/ → 0B" },
      { status: "signin_failed" as const, errorMessage: "signin/ → 0B" },
    ];

    expect(outcomes.map((outcome) =>
      worker.shouldFallbackAfterSignin(outcome.status, outcome.errorMessage),
    )).toEqual([false, true, true]);
  });

  it("ne confond pas une erreur de credentials avec une race perdue", () => {
    expect(worker.shouldFallbackAfterSignin(
      "signin_failed",
      "Identifiants incorrects",
    )).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  Unit — publishSlotSnapshotWithRetry : retry 3× backoff exponentiel (Req 9.6)
//  Validates: Requirements 9.6
// ══════════════════════════════════════════════════════════════════════════════

describe("publishSlotSnapshotWithRetry — retry 3× backoff exponentiel (Req 9.6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SLOTS: SlotSnapEntry[] = [
    { date: "2026-08-01", time: "09:00", agendaId: "ag-1", freeslots: 2 },
  ];

  it("réussit du premier coup ⟹ un seul appel, aucun backoff", async () => {
    mockPublishSlotSnapshot.mockResolvedValueOnce(undefined);
    const p = worker.publishSlotSnapshotWithRetry("ag-1", "svc-1", SLOTS, TAG);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(true);
    expect(mockPublishSlotSnapshot).toHaveBeenCalledTimes(1);
  });

  it("échoue 3 fois ⟹ 3 tentatives, backoff 2000 puis 4000, renvoie false", async () => {
    mockPublishSlotSnapshot.mockRejectedValue(new Error("redis down"));
    const p = worker.publishSlotSnapshotWithRetry("ag-1", "svc-1", SLOTS, TAG);

    // 1re tentative immédiate (échec), backoff de 2000 ms avant la 2e.
    await vi.advanceTimersByTimeAsync(2_000);
    // 2e tentative (échec), backoff de 4000 ms avant la 3e.
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe(false);
    // Exactement 3 tentatives (MAX_ATTEMPTS), pas plus (pas de backoff après la 3e).
    expect(mockPublishSlotSnapshot).toHaveBeenCalledTimes(3);
  });

  it("échoue puis réussit à la 2e tentative ⟹ 2 appels, renvoie true", async () => {
    mockPublishSlotSnapshot
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined);
    const p = worker.publishSlotSnapshotWithRetry("ag-1", "svc-1", SLOTS, TAG);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe(true);
    expect(mockPublishSlotSnapshot).toHaveBeenCalledTimes(2);
  });

  it("ne lance jamais vers l'appelant même si publishSlotSnapshot rejette toujours", async () => {
    mockPublishSlotSnapshot.mockRejectedValue(new Error("boom"));
    const p = worker.publishSlotSnapshotWithRetry("ag-1", "svc-1", SLOTS, TAG);
    await vi.runAllTimersAsync();
    // La promesse se résout (false), ne rejette pas.
    await expect(p).resolves.toBe(false);
  });
});
