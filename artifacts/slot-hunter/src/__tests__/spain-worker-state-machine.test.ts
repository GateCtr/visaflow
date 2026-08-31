/**
 * spain-worker-state-machine.test.ts — Tests unitaires : matrice état × événement
 * pour `transition` et `createRuntimeState` (feature spain-synchronized-scan, task 5.2).
 *
 * Tests couverts :
 *   - Matrice complète état × événement : chaque transition vérifiée.
 *   - Invariant : `state ∈ {ARMED, SCANNING, RECOVERING}` toujours, jamais null/undefined.
 *   - `agenda_empty`/`scan_ok`/`recovered` ⟹ ARMED ; `agenda_empty` sans incrément
 *     de compteur d'erreur (Req 4.8).
 *   - Ensemble fermé {proxy_dead, http_5xx, session_dead, cf_expired} ⟹ RECOVERING.
 *   - Property (fast-check) : totalité — toute paire (état, événement) laisse un
 *     état valide, jamais null/undefined.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 4.8
 */

import fc from "fast-check";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import { transition, createRuntimeState } from "../spain/spain-worker-state-machine.js";
import type { FailureKind, WorkerState, WorkerRuntimeState } from "../spain/spain-grid-config.js";

// ─── Constantes de test ──────────────────────────────────────────────────────

/** Les 3 états valides de la machine (garde-fou d'invariant). */
const VALID_STATES: readonly WorkerState[] = ["ARMED", "SCANNING", "RECOVERING"];

/** Ensemble fermé des causes d'échec ⟹ RECOVERING (Req 3.2). */
const RECOVERY_KINDS: readonly FailureKind[] = [
  "proxy_dead",
  "http_5xx",
  "session_dead",
  "cf_expired",
];

/** Événements qui ramènent (ou maintiennent) l'état à ARMED (Req 3.1, 3.3, 4.8). */
const ARMED_EVENTS: readonly (FailureKind | "scan_ok" | "recovered")[] = [
  "scan_ok",
  "recovered",
  "agenda_empty",
];

/** Tous les événements possibles de l'union de `transition`. */
const ALL_EVENTS: readonly (FailureKind | "scan_ok" | "recovered")[] = [
  ...ARMED_EVENTS,
  ...RECOVERY_KINDS,
];

/**
 * Construit un `WorkerRuntimeState` de test dans un état donné, sans dépendre du
 * réseau ni d'une session réelle. Réutilise `createRuntimeState` pour la cohérence
 * du seed puis force l'état de départ.
 */
function makeRuntime(state: WorkerState): WorkerRuntimeState {
  const rt = createRuntimeState({
    dossierId: "dossier-test-42",
    proxyUrl: "http://proxy.example:8080",
  });
  rt.state = state;
  return rt;
}

// ─── Setup : silence des logs (le repli défensif log un warn) ────────────────

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── createRuntimeState — état initial cohérent (Req 3.1) ────────────────────

describe("createRuntimeState — état initial", () => {
  it("initialise state=ARMED, slotEverSeen=false, lastScanAtMs=0", () => {
    const rt = createRuntimeState({
      dossierId: "abc-123",
      proxyUrl: "http://proxy:1",
    });
    expect(rt.state).toBe("ARMED");
    expect(VALID_STATES).toContain(rt.state);
    expect(rt.slotEverSeen).toBe(false);
    expect(rt.lastScanAtMs).toBe(0);
    expect(rt.dossierId).toBe("abc-123");
    expect(Number.isInteger(rt.gridSeed)).toBe(true);
  });

  it("gridSeed déterministe pour un même dossierId", () => {
    const a = createRuntimeState({ dossierId: "same-id", proxyUrl: "http://p:1" });
    const b = createRuntimeState({ dossierId: "same-id", proxyUrl: "http://p:2" });
    expect(b.gridSeed).toBe(a.gridSeed);
  });
});

// ─── Matrice état × événement — transitions vers ARMED (Req 3.1, 3.3, 4.8) ───

describe("transition — événements ⟹ ARMED", () => {
  for (const from of VALID_STATES) {
    for (const event of ARMED_EVENTS) {
      it(`(${from}) --${event}--> ARMED`, () => {
        const rt = makeRuntime(from);
        const next = transition(rt, event);
        expect(next).toBe("ARMED");
        // Mutation en place cohérente avec le retour.
        expect(rt.state).toBe("ARMED");
      });
    }
  }
});

// ─── Matrice état × événement — transitions vers RECOVERING (Req 3.2) ────────

describe("transition — ensemble fermé ⟹ RECOVERING", () => {
  for (const from of VALID_STATES) {
    for (const kind of RECOVERY_KINDS) {
      it(`(${from}) --${kind}--> RECOVERING`, () => {
        const rt = makeRuntime(from);
        const next = transition(rt, kind);
        expect(next).toBe("RECOVERING");
        expect(rt.state).toBe("RECOVERING");
      });
    }
  }
});

// ─── agenda_empty : maintient ARMED sans incrément de compteur d'erreur (Req 4.8) ─

describe("transition — agenda_empty ne compte pas comme une erreur (Req 4.8)", () => {
  it("agenda_empty maintient ARMED sans ajouter de compteur/contexte d'erreur", () => {
    const rt = makeRuntime("SCANNING");
    // Snapshot des champs qui trahiraient un traitement d'erreur.
    const before = { ...rt };
    const next = transition(rt, "agenda_empty");

    expect(next).toBe("ARMED");
    expect(rt.state).toBe("ARMED");
    // agenda_empty est un signal NORMAL : aucun contexte de récupération ne doit
    // être posé, et aucun champ de type compteur d'erreur ne doit apparaître.
    expect(rt.recovery).toBeUndefined();
    expect(before.recovery).toBeUndefined();
    // slotEverSeen et lastScanAtMs restent inchangés par la transition pure.
    expect(rt.slotEverSeen).toBe(before.slotEverSeen);
    expect(rt.lastScanAtMs).toBe(before.lastScanAtMs);
  });

  it("agenda_empty répété reste ARMED (idempotent, aucune dérive vers RECOVERING)", () => {
    const rt = makeRuntime("ARMED");
    for (let i = 0; i < 10; i += 1) {
      transition(rt, "agenda_empty");
      expect(rt.state).toBe("ARMED");
      expect(rt.recovery).toBeUndefined();
    }
  });
});

// ─── Invariant global : l'état reste toujours valide (jamais null/undefined) ─

describe("transition — invariant d'état valide", () => {
  it("∀ (état, événement) de la matrice complète : state ∈ {ARMED, SCANNING, RECOVERING}", () => {
    for (const from of VALID_STATES) {
      for (const event of ALL_EVENTS) {
        const rt = makeRuntime(from);
        const next = transition(rt, event);
        expect(next).not.toBeNull();
        expect(next).not.toBeUndefined();
        expect(VALID_STATES).toContain(next);
        expect(VALID_STATES).toContain(rt.state);
      }
    }
  });

  it("séquence aléatoire d'événements ne produit jamais d'état invalide", () => {
    const rt = makeRuntime("ARMED");
    const sequence: (FailureKind | "scan_ok" | "recovered")[] = [
      "scan_ok",
      "proxy_dead",
      "recovered",
      "cf_expired",
      "agenda_empty",
      "http_5xx",
      "session_dead",
      "scan_ok",
    ];
    for (const event of sequence) {
      const next = transition(rt, event);
      expect(VALID_STATES).toContain(next);
    }
  });
});

// ─── Property (fast-check) : totalité de la transition ───────────────────────
// Validates: Requirements 3.1, 3.2, 3.3
//
// ∀ (état de départ, événement) : `transition` retourne toujours un état valide,
// jamais null/undefined, et l'événement dicte déterministiquement la cible.

describe("Property — transition totale et déterministe", () => {
  const stateArb = fc.constantFrom<WorkerState>("ARMED", "SCANNING", "RECOVERING");
  const eventArb = fc.constantFrom<FailureKind | "scan_ok" | "recovered">(...ALL_EVENTS);

  it("∀ (état, événement) : résultat ∈ {ARMED, SCANNING, RECOVERING}", () => {
    fc.assert(
      fc.property(stateArb, eventArb, (from, event) => {
        const rt = makeRuntime(from);
        const next = transition(rt, event);
        expect(VALID_STATES).toContain(next);
        expect(next).toBe(rt.state);
      }),
    );
  });

  it("∀ événement de récupération ⟹ RECOVERING ; sinon ⟹ ARMED", () => {
    fc.assert(
      fc.property(stateArb, eventArb, (from, event) => {
        const rt = makeRuntime(from);
        const next = transition(rt, event);
        const expected: WorkerState = (RECOVERY_KINDS as readonly string[]).includes(event)
          ? "RECOVERING"
          : "ARMED";
        expect(next).toBe(expected);
      }),
    );
  });
});
