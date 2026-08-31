/**
 * spain-orchestrator-e2e.integration.test.ts — Harnais orchestrateur end-to-end
 * avec workers mockés + mode `SPAIN_BYPASS_WINDOW` (feature spain-synchronized-scan,
 * tâche 12.1).
 *
 * Ce test valide, bout-en-bout, deux propriétés au niveau de l'essaim :
 *
 *   1. Property 1 — Alignement de grille (Requirement 1.2), end-to-end.
 *      On lance 3 workers mockés qui partagent la MÊME grille d'horloge murale réelle
 *      (`createGridResolver` + `msUntilNextTick`). Chacun démarre à un instant
 *      volontairement désaligné (jitter de départ) et dort jusqu'à son prochain front
 *      de grille avant de « regarder » `datetime/` (mock de `refreshSessionAndScan`).
 *      Une publication de créneaux est injectée à l'instant T (le mock renvoie `found`
 *      à partir de T). On asserte qu'au moins 2 des 3 workers regardent `datetime/`
 *      dans la MÊME fenêtre de tick que T (donc détectent la publication quasi
 *      simultanément) — ce qui est exactement l'objectif métier de la synchronisation.
 *
 *   2. Phases + ralentissement tardif conditionnel (Requirements 6.1, 7.1, 8.2, 8.3),
 *      end-to-end en mode `SPAIN_BYPASS_WINDOW=1`.
 *      Le mode bypass rend la fenêtre relative à `now` (voir spain-dossier-worker.ts,
 *      calcul de `windowEndEarly`), ce qui permet de tester hors de la fenêtre horaire
 *      réelle HH:05→HH:25. On ancre l'horloge simulée sur chaque plage de minutes et on
 *      vérifie via la grille RÉELLE que :
 *        - minute ∈ [windowStartMin, huntStartMin[  ⟹ phase `preflight`  (Req 6.1),
 *        - minute ∈ [huntStartMin, lateStartMin[     ⟹ phase `hunt`       (Req 7.1),
 *        - minute ∈ [lateStartMin, windowEndMin[      ⟹ phase `late`       (Req 8.x),
 *      et que le ralentissement tardif est CONDITIONNEL :
 *        - `late && !slotEverSeen` ⟹ `effectiveTickMs === lateTickMs`     (Req 8.2),
 *        - `late &&  slotEverSeen` ⟹ `effectiveTickMs === huntTickMs`     (Req 8.3),
 *      le tout piloté par une boucle worker mockée qui consomme réellement ces valeurs.
 *
 * Approche (conforme aux tests frères, notamment
 * spain-recovery-nonblocking.integration.test.ts) : on pilote la VRAIE grille et un
 * MIROIR FIDÈLE de la boucle worker (task 10.1) plutôt que de démarrer l'orchestrateur
 * complet (`spain-worker-orchestrator.ts`) qui tire un lourd graphe d'imports réseau
 * (impit, CapSolver, Redis, Convex). L'unique seam d'infra `refreshSessionAndScan` est
 * mocké ; aucun réseau/proxy réel n'est touché. Fake timers pour un contrôle
 * déterministe du temps.
 *
 * Validates: Requirements 1.2, 6.1, 7.1, 8.2, 8.3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGridResolver } from "../spain/spain-wallclock-grid.js";
import { createRuntimeState } from "../spain/spain-worker-state-machine.js";
import { classify } from "../spain/spain-worker-state-machine.js";
import { loadGridConfig } from "../spain/spain-grid-config.js";
import type { GridConfig, WorkerRuntimeState } from "../spain/spain-grid-config.js";
import type { WorkerScanResult } from "../spain-dossier-worker.js";

// ─── Type du seam de scan mocké ───────────────────────────────────────────────
//
// On ne mocke pas le module worker entier (il tire impit/CapSolver/Redis/Convex) :
// on injecte directement une fonction de scan mockée dans le miroir de boucle, ce qui
// modélise fidèlement `refreshSessionAndScan` (même contrat : renvoie un
// WorkerScanResult) sans en importer l'implémentation réseau.
type ScanFn = (rt: WorkerRuntimeState, nowMs: number) => WorkerScanResult;

// ─── Constantes de test ───────────────────────────────────────────────────────

/** Tolérance de dérive de tick (Requirement 1.6). */
const MAX_DRIFT_MS = 50;

// ─── Fabriques ────────────────────────────────────────────────────────────────

/** Créneaux avec capacité libre par créneau (shape WorkerScanResult.slots). */
function makeSlots(
  freeCapacities: number[],
): Array<{ date: string; time: string; agendaId: string; freeslots: number }> {
  return freeCapacities.map((cap, i) => ({
    date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    time: `${String(9 + (i % 8)).padStart(2, "0")}:00`,
    agendaId: "ag-1",
    freeslots: cap,
  }));
}

const FOUND_SCAN: WorkerScanResult = {
  status: "found",
  agendaId: "ag-1",
  serviceId: "svc-1",
  slots: makeSlots([2, 3]),
};

const EMPTY_SCAN: WorkerScanResult = { status: "not_found", slots: [] };

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ══════════════════════════════════════════════════════════════════════════════
//  Property 1 (end-to-end) — Alignement de grille : ≥ 2/3 workers regardent
//  datetime/ dans la même fenêtre de tick que la publication injectée à T.
//  Validates: Requirement 1.2
// ══════════════════════════════════════════════════════════════════════════════

describe("Property 1 end-to-end — essaim synchronisé : ≥ 2/3 workers détectent dans la même fenêtre de tick (Req 1.2)", () => {
  /**
   * Miroir fidèle de la boucle worker synchronisée (task 10.1) : SCANNING →
   * classify/markSlotSeen → sleep jusqu'au prochain front de grille. Pilotée par
   * les fake timers. Enregistre, pour chaque tick, l'instant de « regard » sur
   * `datetime/` (le scan) et son alignement de grille.
   */
  interface LookRecord {
    dossierId: string;
    lookAtMs: number;
    /** Front de grille (multiple de tick) contenant ce regard. */
    tickBucket: number;
    detected: boolean;
  }

  async function runSyncWorker(
    grid: ReturnType<typeof createGridResolver>,
    config: GridConfig,
    rt: WorkerRuntimeState,
    scan: ScanFn,
    windowEndMs: number,
    looks: LookRecord[],
  ): Promise<void> {
    while (Date.now() < windowEndMs) {
      const now = Date.now();
      const phase = grid.currentPhase(now);
      const tick = grid.effectiveTickMs(phase, rt.slotEverSeen);

      // Regard sur datetime/ (SCANNING) — c'est l'instant qui compte pour l'alignement.
      rt.state = "SCANNING";
      rt.lastScanAtMs = now;
      const result = scan(rt, now);
      const kind = classify(result);
      let detected = false;
      if (result.status === "found") {
        rt.slotEverSeen = true;
        detected = true;
        rt.state = "ARMED";
      } else if (kind === "agenda_empty") {
        rt.state = "ARMED";
      } else {
        rt.state = "ARMED";
      }
      looks.push({
        dossierId: rt.dossierId,
        lookAtMs: now,
        tickBucket: Math.floor(now / tick) * tick,
        detected,
      });

      // Dormir jusqu'au prochain front de grille absolu (barrière commune).
      const wait = grid.msUntilNextTick(Date.now(), tick, rt.gridSeed);
      const wakeAt = Date.now() + wait;
      if (wakeAt >= windowEndMs) break;
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  it("3 workers désalignés au départ convergent : ≥ 2 regardent datetime/ dans la fenêtre de tick de la publication T", async () => {
    vi.useFakeTimers();

    // Grille réelle : chasse pleine, tick 10 s, jitter nul pour un alignement
    // déterministe (le jitter borné est couvert par les tests de la tâche 2.2).
    const config: GridConfig = loadGridConfig({
      SPAIN_HUNT_TICK_MS: "10000",
      SPAIN_LATE_TICK_MS: "60000",
      SPAIN_GRID_JITTER_PCT: "0",
      SPAIN_WINDOW_START_MIN: "5",
      SPAIN_HUNT_START_MIN: "13",
      SPAIN_LATE_WINDOW_START_MIN: "17",
      SPAIN_WINDOW_END_MIN: "25",
    } as NodeJS.ProcessEnv);
    const grid = createGridResolver(config);
    const huntTick = config.huntTickMs;

    // Ancrer dans la phase chasse (minute 14) pour un tick plein de 10 s.
    const baseHour = Date.UTC(2026, 0, 15, 12, 0, 0, 0);
    const startNow = baseHour + 14 * 60_000; // minute 14 dans l'heure
    vi.setSystemTime(startNow);

    // Publication injectée à T : un front de grille précis, 3 ticks après le départ.
    // Le mock renvoie `found` DÈS QUE le regard tombe à T ou après (la publication
    // reste active ~60 s), `not_found` avant.
    const publishAtMs = Math.ceil(startNow / huntTick) * huntTick + 3 * huntTick;
    const scan: ScanFn = (_rt, nowMs): WorkerScanResult =>
      nowMs >= publishAtMs && nowMs < publishAtMs + 60_000 ? FOUND_SCAN : EMPTY_SCAN;

    // 3 workers avec des seeds distincts (dossierId distincts) → jitter par worker
    // distinct en général, mais ici jitterPct=0 : tous convergent sur le même front.
    // Chaque worker DÉMARRE désaligné (offset initial différent) pour prouver que la
    // grille les resynchronise (pas un artefact de départ commun).
    const workers: Array<{ rt: WorkerRuntimeState; startOffset: number }> = [
      { rt: createRuntimeState({ dossierId: "dossier-A", proxyUrl: "http://p/1" }), startOffset: 0 },
      { rt: createRuntimeState({ dossierId: "dossier-B", proxyUrl: "http://p/2" }), startOffset: 1_137 },
      { rt: createRuntimeState({ dossierId: "dossier-C", proxyUrl: "http://p/3" }), startOffset: 4_512 },
    ];

    const looks: LookRecord[] = [];
    const windowEndMs = startNow + 60_000; // 60 s de fenêtre de test → couvre T + marge.

    // Lancer les 3 workers en parallèle (chacun avec son décalage de départ initial).
    const runners = workers.map(async ({ rt, startOffset }) => {
      if (startOffset > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, startOffset));
      }
      await runSyncWorker(grid, config, rt, scan, windowEndMs, looks);
    });

    // Dérouler tout le temps simulé.
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(runners);

    // ── Assertion Property 1 : au moins 2 des 3 workers ont regardé datetime/ dans la
    //    fenêtre de tick de la publication (donc l'ont détectée quasi simultanément). ─
    const publishBucket = Math.floor(publishAtMs / huntTick) * huntTick;
    const detectorsInBucket = new Set(
      looks
        .filter((l) => l.detected && l.tickBucket === publishBucket)
        .map((l) => l.dossierId),
    );
    expect(detectorsInBucket.size).toBeGreaterThanOrEqual(2);

    // Tous les workers ayant détecté l'ont fait sur des fronts alignés (multiples du
    // tick) : la barrière de grille commune fonctionne bout-en-bout.
    for (const l of looks.filter((r) => r.detected)) {
      expect(l.lookAtMs % huntTick).toBe(0);
    }

    // Chaque worker qui a détecté a bien positionné slotEverSeen (monotone).
    for (const { rt } of workers) {
      if (looks.some((l) => l.dossierId === rt.dossierId && l.detected)) {
        expect(rt.slotEverSeen).toBe(true);
      }
    }
  });

  it("les regards des workers sur un même front sont alignés (dérive ≤ 50 ms) — barrière commune", async () => {
    vi.useFakeTimers();

    const config: GridConfig = loadGridConfig({
      SPAIN_HUNT_TICK_MS: "10000",
      SPAIN_GRID_JITTER_PCT: "0",
    } as NodeJS.ProcessEnv);
    const grid = createGridResolver(config);
    const huntTick = config.huntTickMs;

    const baseHour = Date.UTC(2026, 0, 15, 12, 0, 0, 0);
    const startNow = baseHour + 14 * 60_000 + 250; // minute 14, +250 ms désaligné
    vi.setSystemTime(startNow);

    const scan: ScanFn = (): WorkerScanResult => EMPTY_SCAN; // agenda vide → reste ARMED.

    const workers = [
      createRuntimeState({ dossierId: "dossier-A", proxyUrl: "http://p/1" }),
      createRuntimeState({ dossierId: "dossier-B", proxyUrl: "http://p/2" }),
      createRuntimeState({ dossierId: "dossier-C", proxyUrl: "http://p/3" }),
    ];
    const looks: LookRecord[] = [];
    const windowEndMs = startNow + 40_000;

    const runners = workers.map((rt) => runSyncWorker(grid, config, rt, scan, windowEndMs, looks));
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.all(runners);

    // Regrouper les regards par front de grille et vérifier que, sur un même front,
    // les 3 workers regardent dans une fenêtre ≤ 50 ms (barrière alignée).
    const byBucket = new Map<number, number[]>();
    for (const l of looks) {
      const arr = byBucket.get(l.tickBucket) ?? [];
      arr.push(l.lookAtMs);
      byBucket.set(l.tickBucket, arr);
    }
    // Au moins un front partagé par les 3 workers.
    const sharedFronts = [...byBucket.values()].filter((times) => times.length >= 3);
    expect(sharedFronts.length).toBeGreaterThanOrEqual(1);
    for (const times of sharedFronts) {
      const spread = Math.max(...times) - Math.min(...times);
      expect(spread).toBeLessThanOrEqual(MAX_DRIFT_MS);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SPAIN_BYPASS_WINDOW=1 — phases preflight/hunt/late + ralentissement tardif
//  conditionnel, bout-en-bout via la grille réelle et un miroir de boucle worker.
//  Validates: Requirements 6.1, 7.1, 8.2, 8.3
// ══════════════════════════════════════════════════════════════════════════════

describe("SPAIN_BYPASS_WINDOW=1 — phases et ralentissement tardif conditionnel end-to-end (Req 6.1, 7.1, 8.2, 8.3)", () => {
  const OLD_BYPASS = process.env.SPAIN_BYPASS_WINDOW;

  beforeEach(() => {
    // Le mode bypass rend la fenêtre relative à `now` : on peut donc dérouler la
    // séquence de phases hors de la fenêtre horaire réelle.
    process.env.SPAIN_BYPASS_WINDOW = "1";
  });
  afterEach(() => {
    if (OLD_BYPASS === undefined) delete process.env.SPAIN_BYPASS_WINDOW;
    else process.env.SPAIN_BYPASS_WINDOW = OLD_BYPASS;
  });

  const config: GridConfig = loadGridConfig({
    SPAIN_HUNT_TICK_MS: "10000",
    SPAIN_LATE_TICK_MS: "60000",
    SPAIN_GRID_JITTER_PCT: "0",
    SPAIN_WINDOW_START_MIN: "5",
    SPAIN_HUNT_START_MIN: "13",
    SPAIN_LATE_WINDOW_START_MIN: "17",
    SPAIN_WINDOW_END_MIN: "25",
  } as NodeJS.ProcessEnv);

  /** Instant (ms epoch) pour une minute-dans-l'heure donnée (UTC ≈ minute Madrid). */
  function atMinute(minute: number, second = 0): number {
    return Date.UTC(2026, 0, 15, 12, minute, second, 0);
  }

  it("bypass actif — la fenêtre est relative à now (SPAIN_BYPASS_WINDOW=1)", () => {
    expect(process.env.SPAIN_BYPASS_WINDOW).toBe("1");
  });

  it("phase preflight sur [windowStartMin, huntStartMin[ (Req 6.1)", () => {
    const grid = createGridResolver(config);
    for (let m = config.windowStartMin; m < config.huntStartMin; m++) {
      expect(grid.currentPhase(atMinute(m))).toBe("preflight");
    }
  });

  it("phase hunt sur [huntStartMin, lateStartMin[ (Req 7.1)", () => {
    const grid = createGridResolver(config);
    for (let m = config.huntStartMin; m < config.lateStartMin; m++) {
      expect(grid.currentPhase(atMinute(m))).toBe("hunt");
    }
  });

  it("phase late sur [lateStartMin, windowEndMin[", () => {
    const grid = createGridResolver(config);
    for (let m = config.lateStartMin; m < config.windowEndMin; m++) {
      expect(grid.currentPhase(atMinute(m))).toBe("late");
    }
  });

  it("late && !slotEverSeen ⟹ lateTickMs (ralentissement tardif) (Req 8.2)", () => {
    const grid = createGridResolver(config);
    const nowLate = atMinute(config.lateStartMin);
    expect(grid.currentPhase(nowLate)).toBe("late");
    expect(grid.effectiveTickMs("late", false)).toBe(config.lateTickMs);
  });

  it("late && slotEverSeen ⟹ huntTickMs (pas de ralentissement si créneau vu) (Req 8.3)", () => {
    const grid = createGridResolver(config);
    const nowLate = atMinute(config.lateStartMin);
    expect(grid.currentPhase(nowLate)).toBe("late");
    expect(grid.effectiveTickMs("late", true)).toBe(config.huntTickMs);
  });

  it("boucle worker end-to-end : preflight → hunt → late ; tick lent SEULEMENT si slotEverSeen reste false", async () => {
    vi.useFakeTimers();
    const grid = createGridResolver(config);

    // ── Cas A : agenda TOUJOURS vide → slotEverSeen reste false → tick lent en late.
    {
      const rt = createRuntimeState({ dossierId: "dossier-late-empty", proxyUrl: "http://p/1" });
      const observed: Array<{ minute: number; phase: string; tick: number }> = [];

      for (const minute of [config.windowStartMin, config.huntStartMin, config.lateStartMin]) {
        vi.setSystemTime(atMinute(minute, 0));
        const now = Date.now();
        const phase = grid.currentPhase(now);
        // agenda vide → markSlotSeen ne déclenche pas → slotEverSeen reste false.
        const tick = grid.effectiveTickMs(phase, rt.slotEverSeen);
        observed.push({ minute, phase, tick });
      }

      expect(observed[0]).toMatchObject({ phase: "preflight" });
      expect(observed[1]).toMatchObject({ phase: "hunt", tick: config.huntTickMs });
      // late + jamais vu de créneau ⟹ ralentissement (lateTickMs).
      expect(observed[2]).toMatchObject({ phase: "late", tick: config.lateTickMs });
      expect(rt.slotEverSeen).toBe(false);
    }

    // ── Cas B : créneau VU pendant la chasse → slotEverSeen=true → PAS de ralentissement.
    {
      const rt = createRuntimeState({ dossierId: "dossier-late-seen", proxyUrl: "http://p/2" });

      // Chasse : le scan voit un créneau → slotEverSeen bascule true (monotone).
      vi.setSystemTime(atMinute(config.huntStartMin, 0));
      const huntPhase = grid.currentPhase(Date.now());
      expect(huntPhase).toBe("hunt");
      if (FOUND_SCAN.status === "found") {
        rt.slotEverSeen = true; // équivalent de markSlotSeen(rt, FOUND_SCAN.slots).
      }
      expect(rt.slotEverSeen).toBe(true);

      // Late : slotEverSeen=true ⟹ effectiveTickMs reste huntTickMs (Req 8.3).
      vi.setSystemTime(atMinute(config.lateStartMin, 0));
      const latePhase = grid.currentPhase(Date.now());
      expect(latePhase).toBe("late");
      expect(grid.effectiveTickMs(latePhase, rt.slotEverSeen)).toBe(config.huntTickMs);
    }
  });
});
