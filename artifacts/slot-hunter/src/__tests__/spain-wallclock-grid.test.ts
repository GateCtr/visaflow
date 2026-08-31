/**
 * spain-wallclock-grid.test.ts — Property tests pour `createGridResolver`
 * (feature spain-synchronized-scan, task 2.2).
 *
 * Propriétés couvertes :
 *   - Property 1 : Alignement de grille — ∀ w1,w2 même tick/nowMs, le front de
 *     base `nextFront = ceil(nowMs/effTick)*effTick` est identique au bit près
 *     (avant jitter). (Validates: Requirements 1.2)
 *   - Property 2 : Jitter borné — ∀ workerSeed, |jitter| <= jitterPct*tick et
 *     msUntilNextTick ∈ [0, tick + jitterMax] (borne sup INCLUSIVE : le réajustement
 *     Req 1.4 peut porter le délai jusqu'à `eff + jitterMax`). (Validates: Requirements 2.1, 2.3)
 *   - Property : déterminisme du jitter — même (workerSeed, tick, jitterPct) ⟹
 *     même valeur. (Validates: Requirements 2.2)
 *
 * Les entrées sont générées via fast-check : nowMs aléatoires, tick ∈ [2700, 60000],
 * workerSeed aléatoires. jitterPct est un paramètre de la GridConfig (fixé par
 * résolveur) : on le fait varier dans [0, 0.5] en construisant plusieurs résolveurs.
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

import { createGridResolver, MS_UNTIL_NEXT_TICK_ERROR } from "../spain/spain-wallclock-grid.js";
import type { GridConfig } from "../spain/spain-grid-config.js";

// ─── Constantes miroir du module sous test ──────────────────────────────────

/** Bornes du tick effectif utilisé pour le calcul (Requirement 12.4). */
const TICK_FLOOR_MS = 1000;
const TICK_CEIL_MS = 3_600_000;

/** Bornes du tick généré pour ces tests (task 2.2). */
const TICK_MIN = 2700;
const TICK_MAX = 60_000;

/**
 * Construit une GridConfig valide avec un jitterPct donné. Les autres champs sont
 * fixés à des valeurs par défaut cohérentes (ordre strict respecté) : ils n'ont
 * aucune influence sur `msUntilNextTick`, qui ne dépend que de `jitterPct`.
 */
function configWithJitter(jitterPct: number): GridConfig {
  return {
    huntTickMs: 10_000,
    lateTickMs: 60_000,
    jitterPct,
    windowStartMin: 5,
    huntStartMin: 13,
    lateStartMin: 17,
    windowEndMin: 25,
  };
}

/** Reproduit le bornage du tick effectif du module (clamp [1000, 3600000]). */
function effectiveTick(tick: number): number {
  return Math.min(Math.max(tick, TICK_FLOOR_MS), TICK_CEIL_MS);
}

/** Front de grille de base attendu (avant jitter). */
function expectedNextFront(nowMs: number, tick: number): number {
  const eff = effectiveTick(tick);
  return Math.ceil(nowMs / eff) * eff;
}

// ─── Générateurs fast-check partagés ─────────────────────────────────────────

/** nowMs réaliste et non négatif (millis d'epoch plausibles). */
const arbNowMs = fc.integer({ min: 0, max: 4_000_000_000_000 });
/** tick ∈ [2700, 60000] (entiers) comme spécifié par la tâche. */
const arbTick = fc.integer({ min: TICK_MIN, max: TICK_MAX });
/** workerSeed arbitraire (peut être négatif/grand : le module le normalise). */
const arbSeed = fc.integer({ min: -2_147_483_648, max: 2_147_483_647 });
/** jitterPct ∈ [0, 0.5] (borné comme la config réelle). */
const arbJitterPct = fc.double({ min: 0, max: 0.5, noNaN: true });

// ─── Property 1 : Alignement de grille ───────────────────────────────────────
// Validates: Requirements 1.2

describe("Property 1 — Alignement de grille (Req 1.2)", () => {
  it("∀ w1,w2 même tick/nowMs : le front de base est identique (avant jitter)", () => {
    fc.assert(
      fc.property(arbNowMs, arbTick, arbSeed, arbSeed, arbJitterPct, (nowMs, tick, seed1, seed2, jitterPct) => {
        const resolver = createGridResolver(configWithJitter(jitterPct));

        const front = expectedNextFront(nowMs, tick);
        const eff = effectiveTick(tick);
        const jitterMax = Math.floor(jitterPct * eff);

        // Le délai de chaque worker doit correspondre à SON front (base) + jitter,
        // le front de base étant identique pour les deux workers.
        const d1 = resolver.msUntilNextTick(nowMs, tick, seed1);
        const d2 = resolver.msUntilNextTick(nowMs, tick, seed2);

        // Reconstitue l'instant absolu ciblé par chaque worker.
        const target1 = nowMs + d1;
        const target2 = nowMs + d2;

        // Chaque cible est le front commun (± un tick pour réajustement passé) + jitter.
        // On vérifie que la cible retombe à jitterMax près d'un multiple de front commun.
        for (const target of [target1, target2]) {
          const deltaToFront = target - front;
          // La cible est soit dans [front - jitterMax, front + jitterMax], soit sur le
          // front suivant [front + eff - jitterMax, front + eff + jitterMax] (réajustement).
          const onFront = deltaToFront >= -jitterMax && deltaToFront <= jitterMax;
          const onNextFront = deltaToFront >= eff - jitterMax && deltaToFront <= eff + jitterMax;
          expect(onFront || onNextFront).toBe(true);
        }
      }),
    );
  });

  it("le front de base ceil(nowMs/eff)*eff est bien un multiple du tick effectif", () => {
    fc.assert(
      fc.property(arbNowMs, arbTick, (nowMs, tick) => {
        const eff = effectiveTick(tick);
        const front = expectedNextFront(nowMs, tick);
        expect(front % eff).toBe(0);
        expect(front).toBeGreaterThanOrEqual(nowMs);
      }),
    );
  });
});

// ─── Property 2 : Jitter borné ───────────────────────────────────────────────
// Validates: Requirements 2.1, 2.3

describe("Property 2 — Jitter borné (Req 2.1, 2.3)", () => {
  it("∀ workerSeed : |jitter| <= floor(jitterPct*tick)", () => {
    fc.assert(
      fc.property(arbNowMs, arbTick, arbSeed, arbJitterPct, (nowMs, tick, seed, jitterPct) => {
        const resolver = createGridResolver(configWithJitter(jitterPct));
        const eff = effectiveTick(tick);
        const jitterMax = Math.floor(jitterPct * eff);

        const delay = resolver.msUntilNextTick(nowMs, tick, seed);
        expect(delay).not.toBe(MS_UNTIL_NEXT_TICK_ERROR);

        // jitter effectif = (nowMs + delay) - front, modulo réajustement d'un tick.
        const front = expectedNextFront(nowMs, tick);
        const target = nowMs + delay;
        let jitter = target - front;
        // Si réajustement au front suivant, retirer un tick pour retrouver le jitter pur.
        if (jitter > jitterMax) {
          jitter -= eff;
        }
        expect(Math.abs(jitter)).toBeLessThanOrEqual(jitterMax);
      }),
    );
  });

  it("∀ entrée valide : msUntilNextTick ∈ [0, tick + jitterMax] (borne sup inclusive)", () => {
    fc.assert(
      fc.property(arbNowMs, arbTick, arbSeed, arbJitterPct, (nowMs, tick, seed, jitterPct) => {
        const resolver = createGridResolver(configWithJitter(jitterPct));
        const eff = effectiveTick(tick);
        const jitterMax = Math.floor(jitterPct * eff);

        const delay = resolver.msUntilNextTick(nowMs, tick, seed);
        expect(delay).toBeGreaterThanOrEqual(0);
        // Borne supérieure INCLUSIVE : le réajustement Req 1.4 (target <= nowMs ⟹
        // viser le front suivant) peut faire remonter le délai jusqu'à `eff + jitterMax`.
        // Cas limite : nowMs tombe exactement sur un front et jitter = 0 → delay = eff
        // (ex. nowMs=0, tick=2700, jitterPct=0 ⟹ delay=2700=eff). La branche normale
        // reste < eff + jitterMax ; seule la branche de réajustement peut atteindre la
        // borne. La borne garantie couvrant les deux branches est donc `<= eff + jitterMax`.
        expect(delay).toBeLessThanOrEqual(eff + jitterMax);
      }),
    );
  });

  it("jitterPct = 0 ⟹ aucun jitter (délai = front - nowMs, ou front suivant si front == nowMs)", () => {
    fc.assert(
      fc.property(arbNowMs, arbTick, arbSeed, (nowMs, tick, seed) => {
        const resolver = createGridResolver(configWithJitter(0));
        const delay = resolver.msUntilNextTick(nowMs, tick, seed);
        const eff = effectiveTick(tick);
        const front = expectedNextFront(nowMs, tick);
        // Sans jitter, la cible est le front. Si le front tombe exactement sur nowMs
        // (target <= nowMs), le module vise le front suivant (Req 1.4).
        const expected = front > nowMs ? front - nowMs : eff;
        expect(delay).toBe(expected);
      }),
    );
  });
});

// ─── Property : déterminisme du jitter ───────────────────────────────────────
// Validates: Requirements 2.2

describe("Property — déterminisme du jitter (Req 2.2)", () => {
  it("même (workerSeed, tick, nowMs, jitterPct) ⟹ même délai au bit près", () => {
    fc.assert(
      fc.property(arbNowMs, arbTick, arbSeed, arbJitterPct, (nowMs, tick, seed, jitterPct) => {
        const resolver = createGridResolver(configWithJitter(jitterPct));
        const a = resolver.msUntilNextTick(nowMs, tick, seed);
        const b = resolver.msUntilNextTick(nowMs, tick, seed);
        expect(b).toBe(a);
      }),
    );
  });

  it("deux résolveurs de même jitterPct produisent le même délai pour le même seed", () => {
    fc.assert(
      fc.property(arbNowMs, arbTick, arbSeed, arbJitterPct, (nowMs, tick, seed, jitterPct) => {
        const r1 = createGridResolver(configWithJitter(jitterPct));
        const r2 = createGridResolver(configWithJitter(jitterPct));
        expect(r2.msUntilNextTick(nowMs, tick, seed)).toBe(r1.msUntilNextTick(nowMs, tick, seed));
      }),
    );
  });

  it("le jitter ne dépend que de |trunc(workerSeed)| (seeds équivalents ⟹ même délai)", () => {
    // Le module normalise via Math.abs(Math.trunc(seed)) : seed et -seed (entiers)
    // produisent le même index de jitter.
    fc.assert(
      fc.property(arbNowMs, arbTick, fc.integer({ min: 0, max: 2_147_483_647 }), arbJitterPct, (nowMs, tick, seed, jitterPct) => {
        const resolver = createGridResolver(configWithJitter(jitterPct));
        const positive = resolver.msUntilNextTick(nowMs, tick, seed);
        const negative = resolver.msUntilNextTick(nowMs, tick, -seed);
        expect(negative).toBe(positive);
      }),
    );
  });
});
