/**
 * spain-recovery-nonblocking.integration.test.ts — Test d'intégration « recovery
 * non bloquant » (feature spain-synchronized-scan, tâche 11.2).
 *
 * Property 3 — Non-blocage de la récupération (Requirement 3.4) :
 *   ∀ workers w_i, w_j (i≠j) : si w_i.state === "RECOVERING", la durée de sleep de
 *   w_j jusqu'à son prochain front de grille est INDÉPENDANTE de w_i (aucun `await`
 *   partagé). On mocke un `proxy_dead` sur w_i dont la récupération prend ~30 s, et
 *   on asserte que w_j continue de scanner exactement à ses fronts de grille avec une
 *   dérive de tick ≤ 50 ms, pendant toute la durée de la récupération de w_i.
 *
 * Approche (test d'intégration piloté par les seams exportés, sans réseau réel) :
 *   - w_i : le VRAI `enterRecoveryAsync` (fire-and-forget) est lancé sur un runtime
 *     forcé en RECOVERING. La récupération `proxy_dead` traverse rotation + re-solve ;
 *     `initWorkerSession` est mocké pour prendre ~30 s (via fake timers), ce qui
 *     modélise un re-solve CF lent. Le pool de réserve injecté est vide (borrow → null)
 *     pour forcer le chemin lent rotation + re-solve.
 *   - w_j : une boucle de scan intégrée (miroir fidèle de la boucle worker de la
 *     tâche 10.1) construite sur le VRAI `createGridResolver` + `msUntilNextTick`.
 *     Elle dort jusqu'au prochain front de grille via `setTimeout` (fake timers) et
 *     enregistre l'instant de réveil réel vs le front visé.
 *
 * Aucun `await` ne relie w_j à la Promise de récupération de w_i : la cadence de w_j
 * est donc structurellement indépendante. Le test le prouve empiriquement en avançant
 * l'horloge simulée et en vérifiant que w_j exécute plusieurs ticks alignés (dérive
 * ≤ 50 ms) TANT QUE w_i reste RECOVERING.
 *
 * L'infra réseau/proxy est entièrement mockée (`vi.mock`) suivant les conventions des
 * tests frères (spain-worker-recovery.test.ts, spain-reserve-pool.test.ts). Le
 * `ReservePoolManager` est injecté en objet-espion via `RecoveryDeps`.
 *
 * Validates: Requirements 3.4
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpainCfSession } from "../spain-soax-solver.js";

// ─── Mocks des modules d'infra (aucun réseau/proxy réel en test) ──────────────

vi.mock("../spain-soax-solver.js", () => ({
  initWorkerSession: vi.fn(),
}));

vi.mock("../spain-dossier-worker.js", () => ({
  initPhpState: vi.fn(),
}));

vi.mock("../spain-decodo-pool.js", () => ({
  rotateDecodoUrl: vi.fn(),
  flagDecodoIp: vi.fn(),
}));

import { initWorkerSession } from "../spain-soax-solver.js";
import { rotateDecodoUrl, flagDecodoIp } from "../spain-decodo-pool.js";
import type { SpainDossierConfig } from "../spain-dossier-worker.js";
import { createGridResolver } from "../spain/spain-wallclock-grid.js";
import { createRuntimeState } from "../spain/spain-worker-state-machine.js";
import { loadGridConfig } from "../spain/spain-grid-config.js";
import type {
  GridConfig,
  WorkerRuntimeState,
} from "../spain/spain-grid-config.js";
import type {
  ReservePoolManager,
  ReserveSession,
} from "../spain/spain-reserve-pool.js";
import { enterRecoveryAsync } from "../spain/spain-worker-recovery.js";
import type { RecoveryDeps } from "../spain/spain-worker-recovery.js";

// ─── Références typées aux mocks ──────────────────────────────────────────────

const mockInitWorkerSession = vi.mocked(initWorkerSession);
const mockRotateDecodoUrl = vi.mocked(rotateDecodoUrl);
const mockFlagDecodoIp = vi.mocked(flagDecodoIp);

// ─── Constantes de test ───────────────────────────────────────────────────────

const CAPSOLVER_KEY = "test-capsolver-key";
const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/test/";
const PROXY_WI = "http://user:pass@10.0.0.1:10000";
const TAG_WI = "[w_i]";

/** Durée modélisée d'une récupération lente (re-solve CF), ~30 s. */
const SLOW_RECOVERY_MS = 30_000;

/** Tolérance de dérive de tick pour w_j (Requirement 3.4). */
const MAX_DRIFT_MS = 50;

/** Type de retour concret de initWorkerSession. */
type InitWorkerSessionResult = Awaited<ReturnType<typeof initWorkerSession>>;

// ─── Fabriques d'objets de test ───────────────────────────────────────────────

function makeProxyUrl(index: number): string {
  return `http://user:pass@10.0.0.${index}:10000`;
}

/** SpainCfSession minimale, `soaxProxyUrl` alignée sur l'exit IP attendue. */
function makeCfSession(proxyUrl: string): SpainCfSession {
  const now = Date.now();
  return {
    cfClearance: "cf_clearance_value_abcdef0123456789",
    cfDomain: ".citaconsular.es",
    soaxProxyUrl: proxyUrl,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0",
    createdAt: now,
    expiresAt: now + 60 * 60_000,
    allCookies: [
      { name: "cf_clearance", value: "cf_clearance_value_abcdef0123456789" },
    ],
    extraHeaders: {},
  };
}

function makeInitResult(session: SpainCfSession): InitWorkerSessionResult {
  return {
    session,
    impit: {} as never,
    cfFromCache: false,
  };
}

function makeConfig(id: string): SpainDossierConfig {
  return {
    id,
    applicantName: "Jane Doe",
    visaType: "schengen",
    login: "login",
    password: "password",
    applicationId: "APP-1",
    otpChannel: "manual",
    portalUrl: PORTAL_URL,
  };
}

/** Espion `ReservePoolManager` neutre (réserve vide par défaut → chemin lent). */
function makeReservePoolSpy(
  overrides: Partial<ReservePoolManager> = {},
): ReservePoolManager {
  return {
    targetSize: 4,
    warmUp: vi.fn(async () => undefined),
    borrow: vi.fn((): ReserveSession | null => null),
    replenishAsync: vi.fn(() => undefined),
    size: vi.fn(() => 0),
    ...overrides,
  };
}

function makeDeps(reservePool: ReservePoolManager): RecoveryDeps {
  return {
    reservePool,
    capsolverKey: CAPSOLVER_KEY,
    portalUrl: PORTAL_URL,
    config: makeConfig("dossier-w-i"),
    tag: TAG_WI,
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Property 3 : Non-blocage de la récupération (Req 3.4) ────────────────────

describe("Property 3 — recovery non bloquant : w_i RECOVERING ~30 s n'altère pas la cadence de w_j (Req 3.4)", () => {
  it("w_j scanne à chaque front de grille (dérive ≤ 50 ms) pendant toute la récupération lente de w_i", async () => {
    vi.useFakeTimers();

    // ── Config de grille : phase chasse pleine, tick 10 s, jitter nul pour un
    //    contrôle de dérive déterministe (le jitter borné est couvert par task 2.2).
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

    // Ancrer l'horloge simulée dans la fenêtre de chasse (minute 14 dans l'heure)
    // afin que la grille soit en phase `hunt` (tick plein 10 s).
    const baseHour = Date.UTC(2026, 0, 15, 12, 0, 0, 0);
    const startNow = baseHour + 14 * 60_000 + 137; // minute 14, +137 ms de désalignement
    vi.setSystemTime(startNow);

    // ── w_i : lancer la VRAIE récupération asynchrone (proxy_dead) ────────────
    // Réserve vide → borrow null → rotation + re-solve. Le re-solve (initWorkerSession)
    // prend SLOW_RECOVERY_MS (~30 s) : c'est le « recovery ~30 s » modélisé.
    mockRotateDecodoUrl.mockReturnValue(makeProxyUrl(200));
    mockInitWorkerSession.mockImplementation(
      (proxyUrl: string): Promise<InitWorkerSessionResult> =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(makeInitResult(makeCfSession(proxyUrl)));
          }, SLOW_RECOVERY_MS);
        }),
    );

    const poolWi = makeReservePoolSpy();
    const rtWi: WorkerRuntimeState = createRuntimeState({
      dossierId: "dossier-w-i",
      proxyUrl: PROXY_WI,
      session: makeCfSession(PROXY_WI),
    });
    // La boucle appelante a déjà posé RECOVERING avant d'appeler enterRecoveryAsync.
    rtWi.state = "RECOVERING";
    enterRecoveryAsync(rtWi, "proxy_dead", makeDeps(poolWi));

    // Laisser la microtask fire-and-forget démarrer (borrow → flag → rotate → solve).
    await Promise.resolve();
    await Promise.resolve();

    // w_i est bien parti en récupération lente et n'est PAS encore rétabli.
    expect(rtWi.state).toBe("RECOVERING");
    expect(poolWi.borrow).toHaveBeenCalledTimes(1);
    expect(mockFlagDecodoIp).toHaveBeenCalledWith(PROXY_WI, "proxy_dead");
    expect(mockRotateDecodoUrl).toHaveBeenCalledTimes(1);
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(1);

    // ── w_j : boucle de scan alignée sur la grille (miroir de la boucle worker) ─
    const rtWj: WorkerRuntimeState = createRuntimeState({
      dossierId: "dossier-w-j",
      proxyUrl: makeProxyUrl(2),
      session: makeCfSession(makeProxyUrl(2)),
    });

    /** Enregistrement d'un tick de w_j : front visé vs réveil réel + dérive. */
    interface TickRecord {
      targetFront: number;
      actualWakeMs: number;
      driftMs: number;
      wiStateAtWake: WorkerRuntimeState["state"];
    }
    const wjTicks: TickRecord[] = [];

    // Nombre de ticks de w_j à observer PENDANT la récupération de w_i.
    // 2 ticks × 10 s = 20 s < 30 s de récupération → w_i reste RECOVERING tout du long.
    const TICKS_TO_OBSERVE = 2;

    async function scanLoopWj(): Promise<void> {
      for (let i = 0; i < TICKS_TO_OBSERVE; i++) {
        const now = Date.now();
        const wait = grid.msUntilNextTick(now, huntTick, rtWj.gridSeed);
        expect(wait).toBeGreaterThanOrEqual(0);
        const targetFront = now + wait;

        // Dormir jusqu'au front de grille (setTimeout piloté par les fake timers).
        await new Promise<void>((resolve) => {
          setTimeout(resolve, wait);
        });

        const actualWakeMs = Date.now();
        wjTicks.push({
          targetFront,
          actualWakeMs,
          driftMs: Math.abs(actualWakeMs - targetFront),
          // On échantillonne l'état de w_i au réveil de w_j : il doit rester RECOVERING.
          wiStateAtWake: rtWi.state,
        });
        rtWj.lastScanAtMs = actualWakeMs;
        rtWj.state = "ARMED";
      }
    }

    const wjDone = scanLoopWj();

    // ── Avancer l'horloge simulée de 20 s (< 30 s) : w_j doit exécuter ses 2 ticks,
    //    w_i doit rester RECOVERING (son re-solve ~30 s n'est pas encore résolu). ──
    await vi.advanceTimersByTimeAsync(2 * huntTick);
    await wjDone;

    // w_j a bien exécuté le nombre de ticks attendu.
    expect(wjTicks).toHaveLength(TICKS_TO_OBSERVE);

    // Chaque réveil de w_j tombe sur un front de grille aligné (multiple de huntTick),
    // avec une dérive ≤ 50 ms — cadence INDÉPENDANTE de la récupération de w_i.
    for (const tick of wjTicks) {
      expect(tick.driftMs).toBeLessThanOrEqual(MAX_DRIFT_MS);
      // Le front visé est un multiple exact du tick de chasse (barrière commune).
      expect(tick.targetFront % huntTick).toBe(0);
      // Pendant que w_j scanne, w_i est TOUJOURS en récupération (aucun blocage mutuel).
      expect(tick.wiStateAtWake).toBe("RECOVERING");
    }

    // Les fronts de w_j sont strictement croissants et espacés d'exactement un tick
    // (aucune dérive cumulée introduite par la récupération de w_i).
    for (let i = 1; i < wjTicks.length; i++) {
      const delta = wjTicks[i].targetFront - wjTicks[i - 1].targetFront;
      expect(delta).toBe(huntTick);
    }

    // ── w_i toujours RECOVERING à 20 s : la récupération lente est encore en vol,
    //    et n'a jamais suspendu la boucle de w_j (prouve l'absence d'await partagé). ─
    expect(rtWi.state).toBe("RECOVERING");

    // ── Laisser la récupération de w_i se terminer (dépasser les 30 s) : elle
    //    rétablit alors la session et transite RECOVERING → ARMED, indépendamment. ─
    await vi.advanceTimersByTimeAsync(SLOW_RECOVERY_MS);
    await vi.runAllTimersAsync();

    expect(rtWi.state).toBe("ARMED");
    expect(rtWi.proxyUrl).toBe(makeProxyUrl(200)); // rotation vers la nouvelle IP
  });
});
