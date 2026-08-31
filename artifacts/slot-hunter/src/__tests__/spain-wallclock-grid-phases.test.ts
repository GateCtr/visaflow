/**
 * spain-wallclock-grid-phases.test.ts — Tests unitaires + property-based pour les
 * phases de grille et le ralentissement tardif conditionnel
 * (feature spain-synchronized-scan, task 2.3).
 *
 * Tests couverts :
 *   - Unit : currentPhase aux bornes de fenêtre (preflight/hunt/late + hors
 *            fenêtre → preflight), avec mock du fuseau Europe/Madrid.
 *   - Unit : effectiveTickMs — late && !slotEverSeen ⟹ lateTickMs ; tous autres
 *            cas ⟹ huntTickMs ; jamais < huntTickMs.
 *   - Property 4 : Ralentissement tardif conditionnel —
 *                  ∀ t ∈ [lateStartMin, windowEndMin[ :
 *                  slotEverSeen === true ⟹ effectiveTickMs === huntTickMs.
 *                  (Validates: Requirements 8.3, 8.6)
 *
 * _Requirements: 7.1, 7.4, 8.1, 8.2, 8.3, 8.6, 12.4_
 *
 * Stratégie « mock » du fuseau Europe/Madrid : `currentPhase` dérive la
 * minute-dans-l'heure via `Intl.DateTimeFormat(..., timeZone: "Europe/Madrid")`.
 * Or l'Espagne est TOUJOURS à un décalage horaire ENTIER par rapport à UTC
 * (UTC+1 en hiver, UTC+2 en été). La minute-dans-l'heure est donc invariante par
 * ce décalage : `minute(Europe/Madrid) === minute(UTC)` pour tout instant.
 *
 * On construit donc des `nowMs` réels dont la minute UTC est maîtrisée
 * (`nowMs = ancrageHeure + minute * 60_000`), ce qui fixe déterministiquement la
 * minute-dans-l'heure Europe/Madrid SANS mocker `Intl` (approche stable sur toute
 * machine CI, indépendante du DST). Un test de garde vérifie explicitement cette
 * invariance pour éviter toute régression silencieuse.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createGridResolver } from "../spain/spain-wallclock-grid.js";
import type { GridConfig, ScanPhase } from "../spain/spain-grid-config.js";

// ─── Config de référence (bornes 5/13/17/25, ordre strict valide) ────────────

const CONFIG: GridConfig = {
  huntTickMs: 10_000,
  lateTickMs: 60_000,
  jitterPct: 0.2,
  windowStartMin: 5,
  huntStartMin: 13,
  lateStartMin: 17,
  windowEndMin: 25,
};

// ─── Fabrication de nowMs à minute-dans-l'heure contrôlée ────────────────────
//
// Ancrage sur une frontière d'heure UTC connue (2023-11-14T00:00:00Z, un instant
// arbitraire mais fixe). On ajoute `minute` minutes pour obtenir un instant dont
// la minute-dans-l'heure UTC — donc Europe/Madrid — vaut exactement `minute`.

/** Frontière d'heure UTC (minute 0, seconde 0) servant d'ancrage. */
const HOUR_ANCHOR_UTC_MS = Date.UTC(2023, 10, 14, 0, 0, 0, 0);

/** Construit un instant epoch dont la minute-dans-l'heure (UTC == Madrid) vaut `minute`. */
function nowMsAtMinute(minute: number): number {
  return HOUR_ANCHOR_UTC_MS + minute * 60_000;
}

/** Retourne la phase pour une minute-dans-l'heure donnée. */
function phaseAtMinute(resolver: ReturnType<typeof createGridResolver>, minute: number): ScanPhase {
  return resolver.currentPhase(nowMsAtMinute(minute));
}

// ─── Garde : invariance minute UTC == minute Europe/Madrid ───────────────────

describe("garde — minute-dans-l'heure invariante (UTC == Europe/Madrid)", () => {
  it("le fuseau Europe/Madrid ne modifie jamais la minute-dans-l'heure", () => {
    const madridMinute = (nowMs: number): number => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Madrid",
        hour12: false,
        minute: "2-digit",
      }).formatToParts(new Date(nowMs));
      const p = parts.find((x) => x.type === "minute");
      return Number(p?.value);
    };
    for (let m = 0; m < 60; m += 1) {
      const nowMs = nowMsAtMinute(m);
      expect(madridMinute(nowMs)).toBe(m);
    }
  });
});

// ─── currentPhase — bornes de fenêtre ────────────────────────────────────────
// Config : windowStart=5, huntStart=13, lateStart=17, windowEnd=25.
//   [0,5[   → preflight (avant fenêtre)
//   [5,13[  → preflight (fenêtre preflight)
//   [13,17[ → hunt
//   [17,25[ → late
//   [25,60[ → preflight (après fenêtre)

describe("currentPhase — bornes de fenêtre (mock Europe/Madrid)", () => {
  const resolver = createGridResolver(CONFIG);

  interface PhaseCase {
    readonly minute: number;
    readonly expected: ScanPhase;
    readonly label: string;
  }

  const cases: readonly PhaseCase[] = [
    { minute: 0, expected: "preflight", label: "minute 0 (avant windowStart)" },
    { minute: 4, expected: "preflight", label: "minute 4 (juste avant windowStart)" },
    { minute: 5, expected: "preflight", label: "minute 5 = windowStart (preflight)" },
    { minute: 12, expected: "preflight", label: "minute 12 (juste avant huntStart)" },
    { minute: 13, expected: "hunt", label: "minute 13 = huntStart (borne basse hunt)" },
    { minute: 16, expected: "hunt", label: "minute 16 (juste avant lateStart)" },
    { minute: 17, expected: "late", label: "minute 17 = lateStart (borne basse late)" },
    { minute: 24, expected: "late", label: "minute 24 (juste avant windowEnd)" },
    { minute: 25, expected: "preflight", label: "minute 25 = windowEnd (hors fenêtre)" },
    { minute: 30, expected: "preflight", label: "minute 30 (après fenêtre)" },
    { minute: 59, expected: "preflight", label: "minute 59 (fin d'heure)" },
  ];

  for (const c of cases) {
    it(`${c.label} → ${c.expected}`, () => {
      expect(phaseAtMinute(resolver, c.minute)).toBe(c.expected);
    });
  }

  it("couvre exhaustivement 0..59 sans jamais lancer ni retourner de phase inconnue", () => {
    const valid: readonly ScanPhase[] = ["preflight", "hunt", "late"];
    for (let m = 0; m < 60; m += 1) {
      const phase = phaseAtMinute(resolver, m);
      expect(valid).toContain(phase);
    }
  });
});

// ─── currentPhase — config de fenêtre invalide → preflight (Req 7.5) ─────────

describe("currentPhase — config invalide retourne preflight", () => {
  it("ordre non strict (huntStart >= lateStart) ⟹ preflight quelle que soit la minute", () => {
    const badConfig: GridConfig = {
      ...CONFIG,
      huntStartMin: 20,
      lateStartMin: 17, // hunt >= late → invalide
    };
    const resolver = createGridResolver(badConfig);
    for (let m = 0; m < 60; m += 5) {
      expect(phaseAtMinute(resolver, m)).toBe("preflight");
    }
  });
});

// ─── effectiveTickMs — table de cas ──────────────────────────────────────────
// late && !slotEverSeen ⟹ lateTickMs ; tous autres cas ⟹ huntTickMs.

describe("effectiveTickMs — sélection du tick", () => {
  const resolver = createGridResolver(CONFIG);

  it("late && slotEverSeen=false ⟹ lateTickMs (Req 8.2)", () => {
    expect(resolver.effectiveTickMs("late", false)).toBe(CONFIG.lateTickMs);
  });

  it("late && slotEverSeen=true ⟹ huntTickMs (Req 8.3)", () => {
    expect(resolver.effectiveTickMs("late", true)).toBe(CONFIG.huntTickMs);
  });

  it("hunt ⟹ huntTickMs (indépendant de slotEverSeen)", () => {
    expect(resolver.effectiveTickMs("hunt", false)).toBe(CONFIG.huntTickMs);
    expect(resolver.effectiveTickMs("hunt", true)).toBe(CONFIG.huntTickMs);
  });

  it("preflight ⟹ huntTickMs (indépendant de slotEverSeen)", () => {
    expect(resolver.effectiveTickMs("preflight", false)).toBe(CONFIG.huntTickMs);
    expect(resolver.effectiveTickMs("preflight", true)).toBe(CONFIG.huntTickMs);
  });

  it("ne retourne jamais un tick < huntTickMs (invariant, même si lateTick < huntTick)", () => {
    // Config pathologique : lateTickMs < huntTickMs. L'invariant doit tenir.
    const weird: GridConfig = { ...CONFIG, huntTickMs: 30_000, lateTickMs: 5_000 };
    const r = createGridResolver(weird);
    const phases: readonly ScanPhase[] = ["preflight", "hunt", "late"];
    for (const phase of phases) {
      for (const seen of [true, false]) {
        expect(r.effectiveTickMs(phase, seen)).toBeGreaterThanOrEqual(weird.huntTickMs);
      }
    }
  });
});

// ─── Property 4 : Ralentissement tardif conditionnel ─────────────────────────
// Validates: Requirements 8.3, 8.6
//
// ∀ t ∈ [lateStartMin, windowEndMin[ : slotEverSeen === true ⟹
//   effectiveTickMs(currentPhase(t), true) === huntTickMs.
// On génère des configs valides arbitraires + une minute dans la fenêtre tardive
// (garantie via le mock de fuseau) et on asserte l'égalité au tick de chasse.

describe("Property 4 — Ralentissement tardif conditionnel (Req 8.3, 8.6)", () => {
  /**
   * Génère une GridConfig valide (ordre strict windowStart < huntStart <
   * lateStart < windowEnd, minutes dans [0,59]) avec lateStart < windowEnd de
   * sorte que la fenêtre tardive [lateStart, windowEnd[ soit non vide.
   */
  const validConfigArb: fc.Arbitrary<GridConfig> = fc
    .tuple(
      // 4 minutes strictement croissantes dans [0, 59].
      fc.uniqueArray(fc.integer({ min: 0, max: 59 }), { minLength: 4, maxLength: 4 }),
      fc.integer({ min: 2700, max: 3_600_000 }), // huntTickMs (>= plancher métier)
      fc.integer({ min: 2700, max: 3_600_000 }), // lateTickMs candidate
      fc.double({ min: 0, max: 0.5, noNaN: true }), // jitterPct
    )
    .map(([minutes, huntTickMs, lateTickCandidate, jitterPct]) => {
      const sorted = [...minutes].sort((a, b) => a - b);
      const [windowStartMin, huntStartMin, lateStartMin, windowEndMin] = sorted as [
        number,
        number,
        number,
        number,
      ];
      return {
        huntTickMs,
        // lateTickMs >= huntTickMs (comme le garantit loadGridConfig en pratique).
        lateTickMs: Math.max(lateTickCandidate, huntTickMs),
        jitterPct,
        windowStartMin,
        huntStartMin,
        lateStartMin,
        windowEndMin,
      } satisfies GridConfig;
    });

  it("∀ config valide, ∀ minute ∈ [lateStart, windowEnd[ : slotEverSeen=true ⟹ tick == huntTickMs", () => {
    fc.assert(
      fc.property(validConfigArb, fc.integer({ min: 0, max: 59 }), (config, minuteOffset) => {
        const lateSpan = config.windowEndMin - config.lateStartMin;
        // Minute effective dans [lateStartMin, windowEndMin[.
        const minute = config.lateStartMin + (minuteOffset % lateSpan);

        const resolver = createGridResolver(config);
        const phase = resolver.currentPhase(nowMsAtMinute(minute));

        // La minute est dans la fenêtre tardive ⟹ phase late attendue.
        expect(phase).toBe("late");
        // Avec slotEverSeen=true, le tick effectif retombe sur huntTickMs.
        expect(resolver.effectiveTickMs(phase, true)).toBe(config.huntTickMs);
      }),
    );
  });

  it("∀ config valide, ∀ minute ∈ [lateStart, windowEnd[ : slotEverSeen=false ⟹ tick == lateTickMs", () => {
    // Contrepartie (Req 8.2) : confirme que le ralentissement N'a lieu QUE si
    // aucun créneau n'a été vu — ce qui donne du sens à la conditionnalité de P4.
    fc.assert(
      fc.property(validConfigArb, fc.integer({ min: 0, max: 59 }), (config, minuteOffset) => {
        const lateSpan = config.windowEndMin - config.lateStartMin;
        const minute = config.lateStartMin + (minuteOffset % lateSpan);

        const resolver = createGridResolver(config);
        const phase = resolver.currentPhase(nowMsAtMinute(minute));

        expect(phase).toBe("late");
        expect(resolver.effectiveTickMs(phase, false)).toBe(config.lateTickMs);
      }),
    );
  });

  it("∀ config valide, effectiveTickMs >= huntTickMs pour toute phase/slotEverSeen (Req 8.6/12.4)", () => {
    fc.assert(
      fc.property(
        validConfigArb,
        fc.constantFrom<ScanPhase>("preflight", "hunt", "late"),
        fc.boolean(),
        (config, phase, seen) => {
          const resolver = createGridResolver(config);
          expect(resolver.effectiveTickMs(phase, seen)).toBeGreaterThanOrEqual(config.huntTickMs);
        },
      ),
    );
  });
});
