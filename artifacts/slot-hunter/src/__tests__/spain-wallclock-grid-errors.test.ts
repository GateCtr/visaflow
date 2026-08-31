/**
 * spain-wallclock-grid-errors.test.ts — Tests unitaires ciblés sur les cas
 * d'erreur et l'invariance de `msUntilNextTick` face aux entrées invalides
 * (feature spain-synchronized-scan, task 2.4).
 *
 * Portée (STRICTEMENT limitée à 2.4, sans recouvrement avec 2.2/2.3) :
 *   - Req 1.4 : front cible <= nowMs ⟹ viser le front suivant (ajout d'un tick).
 *   - Req 1.7 : lecture d'horloge non numérique ⟹ rejet + indication d'erreur,
 *               aucun réveil planifié (retour du sentinelle -1, console.error).
 *   - Req 2.5 : tick/jitterPct invalides ⟹ rejet + valeur précédente conservée
 *               (le sentinelle -1 signale « ne pas replanifier » ; la fonction
 *               étant pure, un appel invalide n'altère pas le résultat d'un appel
 *               valide antérieur/ultérieur).
 *
 * Le module sous test signale le rejet par la valeur sentinelle exportée
 * `MS_UNTIL_NEXT_TICK_ERROR` (= -1) accompagnée d'un `console.error("[spain-grid] …")`.
 * On lit l'implémentation réelle pour aligner les assertions : aucune exception
 * n'est levée, la valeur de retour est le contrat observable.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import { createGridResolver, MS_UNTIL_NEXT_TICK_ERROR } from "../spain/spain-wallclock-grid.js";
import type { GridResolver } from "../spain/spain-wallclock-grid.js";
import type { GridConfig } from "../spain/spain-grid-config.js";

// ─── Config de grille valide de référence ────────────────────────────────────
// jitterPct = 0.2 (dans [0, 0.5]) pour que la validation de jitter passe sur les
// cas nominaux ; les cas d'erreur jitterPct sont testés via des configs dédiées.

const BASE_CONFIG: GridConfig = {
  huntTickMs: 10_000,
  lateTickMs: 60_000,
  jitterPct: 0.2,
  windowStartMin: 5,
  huntStartMin: 13,
  lateStartMin: 17,
  windowEndMin: 25,
};

/** Construit un résolveur avec un override de config partiel. */
function makeResolver(overrides: Partial<GridConfig> = {}): GridResolver {
  return createGridResolver({ ...BASE_CONFIG, ...overrides });
}

// ─── Setup / teardown : espionnage silencieux de console.error ───────────────

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Req 1.4 — front cible <= nowMs ⟹ front suivant ──────────────────────────
// Quand nowMs tombe pile sur une frontière de grille (nowMs % tick === 0), le
// front de base nextFront = nowMs. Un jitter strictement négatif place alors
// target = nowMs + jitter <= nowMs : le calcul DOIT viser le front suivant
// (nextFront + tick + jitter) et retourner un délai strictement positif.

describe("msUntilNextTick — Req 1.4 : front cible <= nowMs vise le front suivant", () => {
  it("nowMs sur la frontière + jitter négatif ⟹ délai positif (~tick), jamais <= 0", () => {
    const resolver = makeResolver();
    const tick = 10_000;
    const nowMs = 1_000_000_000; // multiple exact de 10_000 → nextFront === nowMs

    // jitterMax = floor(0.2 * 10000) = 2000. On veut jitter < 0.
    // jitter = (|seed| mod (2*jitterMax+1)) - jitterMax. Avec seed = 0 ⟹ jitter = -2000.
    const workerSeed = 0;
    const delay = resolver.msUntilNextTick(nowMs, tick, workerSeed);

    // Sans le réajustement Req 1.4, target = nowMs - 2000 (dans le passé) ⟹ délai négatif.
    // Avec le réajustement : target = nowMs + tick - 2000 = nowMs + 8000.
    expect(delay).toBe(8000);
    expect(delay).toBeGreaterThan(0);
  });

  it("délai toujours dans [0, tick + jitterMax) même sur frontière avec jitter négatif", () => {
    const resolver = makeResolver();
    const tick = 10_000;
    const jitterMax = Math.floor(0.2 * tick); // 2000
    const upperExclusive = tick + jitterMax; // 12000
    const nowMs = 500_000; // multiple de 10_000

    for (const seed of [0, 1, 500, 1999, 2000, 12345, 99999]) {
      const delay = resolver.msUntilNextTick(nowMs, tick, seed);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(upperExclusive);
    }
  });

  it("nowMs juste après une frontière : le front de base est déjà dans le futur", () => {
    const resolver = makeResolver();
    const tick = 10_000;
    // nowMs = frontière + 1 ⟹ nextFront = frontière + tick, déjà > nowMs.
    const nowMs = 1_000_000_000 + 1;
    const delay = resolver.msUntilNextTick(nowMs, tick, 0);
    // nextFront = 1_000_010_000 ; jitter = -2000 ; target = 1_000_008_000 > nowMs.
    // délai = target - nowMs = 7999.
    expect(delay).toBe(7999);
    expect(delay).toBeGreaterThan(0);
  });
});

// ─── Req 1.7 — horloge non numérique ⟹ rejet + indication d'erreur ───────────

describe("msUntilNextTick — Req 1.7 : lecture d'horloge invalide ⟹ rejet, aucun réveil", () => {
  const invalidClocks: readonly { readonly label: string; readonly nowMs: number }[] = [
    { label: "NaN", nowMs: Number.NaN },
    { label: "+Infinity", nowMs: Number.POSITIVE_INFINITY },
    { label: "-Infinity", nowMs: Number.NEGATIVE_INFINITY },
  ];

  for (const { label, nowMs } of invalidClocks) {
    it(`nowMs = ${label} ⟹ retourne le sentinelle d'erreur et journalise [spain-grid]`, () => {
      const resolver = makeResolver();
      const result = resolver.msUntilNextTick(nowMs, 10_000, 42);

      // Aucun réveil planifiable : le sentinelle -1 est impossible pour un délai réel (>= 0).
      expect(result).toBe(MS_UNTIL_NEXT_TICK_ERROR);
      expect(result).toBe(-1);
      expect(result).toBeLessThan(0);

      // Indication d'erreur émise, préfixée module, identifiant l'échec de lecture d'horloge.
      expect(errorSpy).toHaveBeenCalled();
      const mentionsClock = errorSpy.mock.calls.some((args: readonly unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[spain-grid]") && args[0].includes("nowMs"),
      );
      expect(mentionsClock).toBe(true);
    });
  }

  it("un rejet horloge ne renvoie jamais une valeur >= 0 (aucun réveil planifié)", () => {
    const resolver = makeResolver();
    expect(resolver.msUntilNextTick(Number.NaN, 10_000, 1)).toBeLessThan(0);
  });
});

// ─── Req 2.5 — tick invalide ⟹ rejet + valeur précédente conservée ───────────

describe("msUntilNextTick — Req 2.5 : tick invalide ⟹ rejet, valeur précédente inchangée", () => {
  const invalidTicks: readonly { readonly label: string; readonly tick: number }[] = [
    { label: "tick = 0", tick: 0 },
    { label: "tick négatif", tick: -5000 },
    { label: "tick non entier", tick: 1500.5 },
    { label: "tick NaN", tick: Number.NaN },
    { label: "tick Infinity", tick: Number.POSITIVE_INFINITY },
  ];

  for (const { label, tick } of invalidTicks) {
    it(`${label} ⟹ sentinelle d'erreur + [spain-grid] nommant tick`, () => {
      const resolver = makeResolver();
      const result = resolver.msUntilNextTick(1_000_000, tick, 42);

      expect(result).toBe(MS_UNTIL_NEXT_TICK_ERROR);
      expect(result).toBeLessThan(0);
      expect(errorSpy).toHaveBeenCalled();
      const mentionsTick = errorSpy.mock.calls.some((args: readonly unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[spain-grid]") && args[0].includes("tick"),
      );
      expect(mentionsTick).toBe(true);
    });
  }

  it("un tick invalide n'altère pas la valeur d'un calcul valide antérieur (invariance/pureté)", () => {
    const resolver = makeResolver();
    const nowMs = 1_000_000;
    const validTick = 10_000;
    const seed = 42;

    // 1) Valeur de délai précédente valide.
    const previous = resolver.msUntilNextTick(nowMs, validTick, seed);
    expect(previous).toBeGreaterThanOrEqual(0);

    // 2) Appel invalide (rejet) : ne doit rien « écrire » qui change le résultat suivant.
    const rejected = resolver.msUntilNextTick(nowMs, -1, seed);
    expect(rejected).toBe(MS_UNTIL_NEXT_TICK_ERROR);

    // 3) Le même calcul valide reproduit exactement la valeur précédente : la
    //    « valeur précédemment retournée » est conservée (aucun effet de bord).
    const after = resolver.msUntilNextTick(nowMs, validTick, seed);
    expect(after).toBe(previous);
  });
});

// ─── Req 2.5 — jitterPct invalide ⟹ rejet + valeur précédente conservée ──────
// jitterPct est porté par la config du résolveur : un résolveur construit avec un
// jitterPct hors [0, 0.5] doit rejeter tout calcul de délai.

describe("msUntilNextTick — Req 2.5 : jitterPct hors [0, 0.5] ⟹ rejet", () => {
  const invalidJitters: readonly { readonly label: string; readonly jitterPct: number }[] = [
    { label: "jitterPct < 0", jitterPct: -0.1 },
    { label: "jitterPct > 0.5", jitterPct: 0.75 },
    { label: "jitterPct NaN", jitterPct: Number.NaN },
    { label: "jitterPct Infinity", jitterPct: Number.POSITIVE_INFINITY },
  ];

  for (const { label, jitterPct } of invalidJitters) {
    it(`${label} ⟹ sentinelle d'erreur + [spain-grid] nommant jitterPct`, () => {
      const resolver = makeResolver({ jitterPct });
      const result = resolver.msUntilNextTick(1_000_000, 10_000, 42);

      expect(result).toBe(MS_UNTIL_NEXT_TICK_ERROR);
      expect(result).toBeLessThan(0);
      expect(errorSpy).toHaveBeenCalled();
      const mentionsJitter = errorSpy.mock.calls.some((args: readonly unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[spain-grid]") && args[0].includes("jitterPct"),
      );
      expect(mentionsJitter).toBe(true);
    });
  }

  it("bornes exactes valides (0 et 0.5) ne déclenchent PAS de rejet lié au jitter", () => {
    // Sanity : confirme que le rejet ci-dessus vient bien du dépassement de borne
    // et non d'une autre cause. Aux bornes exactes, un délai valide est retourné.
    for (const jitterPct of [0, 0.5]) {
      const resolver = makeResolver({ jitterPct });
      const delay = resolver.msUntilNextTick(1_000_000, 10_000, 42);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    // Aucune erreur émise pour les bornes valides.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("un jitterPct invalide (config) préserve la valeur d'un résolveur valide distinct", () => {
    // Invariance Req 2.5 : le rejet d'un résolveur mal configuré n'affecte pas la
    // valeur retournée par un résolveur valide (états indépendants, fonctions pures).
    const validResolver = makeResolver({ jitterPct: 0.2 });
    const nowMs = 1_000_000;
    const previous = validResolver.msUntilNextTick(nowMs, 10_000, 42);

    const badResolver = makeResolver({ jitterPct: 0.9 });
    expect(badResolver.msUntilNextTick(nowMs, 10_000, 42)).toBe(MS_UNTIL_NEXT_TICK_ERROR);

    const after = validResolver.msUntilNextTick(nowMs, 10_000, 42);
    expect(after).toBe(previous);
  });
});
