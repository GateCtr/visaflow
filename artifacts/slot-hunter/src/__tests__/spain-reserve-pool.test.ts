/**
 * spain-reserve-pool.test.ts — Tests unitaires du gestionnaire de pool de réserve
 * (feature spain-synchronized-scan, tâche 6.2).
 *
 * L'infra réseau/proxy est entièrement mockée via vitest (`vi.mock`) :
 *   - `initWorkerSession`  (spain-soax-solver)  — pré-solve d'une session CF
 *   - `rotateDecodoUrl`    (spain-decodo-pool)  — sélection d'une IP distincte
 *   - `flagDecodoIp`       (spain-decodo-pool)  — blacklist d'une IP morte
 *   - `isDecodoIpBlacklisted` (spain-decodo-pool) — exclusion des IP mortes
 *
 * Scénarios couverts :
 *   1. warmUp atteint targetSize sur des IP distinctes.
 *   2. borrow ignore les réserves cf_clearance expiré et retourne null si vide.
 *   3. size compte correctement (réserves valides uniquement, borné [0, targetSize]).
 *   4. replenishAsync retry 3× avec backoff exponentiel puis warn.
 *   5. IP mortes (blacklistées) exclues de toute sélection.
 *
 * _Requirements: 5.1, 5.3, 5.5, 5.6, 5.7, 11.7_
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpainCfSession } from "../spain-soax-solver.js";

// ─── Mocks des modules d'infra (aucun réseau/proxy réel en test) ──────────────

vi.mock("../spain-soax-solver.js", () => ({
  initWorkerSession: vi.fn(),
}));

vi.mock("../spain-decodo-pool.js", () => ({
  rotateDecodoUrl: vi.fn(),
  flagDecodoIp: vi.fn(),
  isDecodoIpBlacklisted: vi.fn(),
}));

import { initWorkerSession } from "../spain-soax-solver.js";
import {
  rotateDecodoUrl,
  flagDecodoIp,
  isDecodoIpBlacklisted,
} from "../spain-decodo-pool.js";
import { createReservePool } from "../spain/spain-reserve-pool.js";

// ─── Références typées aux mocks ──────────────────────────────────────────────

const mockInitWorkerSession = vi.mocked(initWorkerSession);
const mockRotateDecodoUrl = vi.mocked(rotateDecodoUrl);
const mockFlagDecodoIp = vi.mocked(flagDecodoIp);
const mockIsDecodoIpBlacklisted = vi.mocked(isDecodoIpBlacklisted);

// ─── Constantes de test ───────────────────────────────────────────────────────

const CAPSOLVER_KEY = "test-capsolver-key";
const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/test/";

/** Type de retour concret de initWorkerSession (session + impit + cfFromCache). */
type InitWorkerSessionResult = Awaited<ReturnType<typeof initWorkerSession>>;

// ─── Fabriques d'objets de test ───────────────────────────────────────────────

/** Construit une URL proxy Decodo factice, distincte par index. */
function makeProxyUrl(index: number): string {
  return `http://user:pass@10.0.0.${index}:10000`;
}

/**
 * Construit une SpainCfSession minimale mais complète pour les tests.
 * `expiresAt` contrôle l'expiration du cf_clearance testée par borrow/size.
 */
function makeCfSession(overrides: Partial<SpainCfSession> = {}): SpainCfSession {
  const now = Date.now();
  return {
    cfClearance: "cf_clearance_value_abcdef0123456789",
    cfDomain: ".citaconsular.es",
    soaxProxyUrl: "http://user:pass@10.0.0.1:10000",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0",
    createdAt: now,
    expiresAt: now + 60 * 60_000, // valide 1h par défaut
    allCookies: [{ name: "cf_clearance", value: "cf_clearance_value_abcdef0123456789" }],
    extraHeaders: {},
    ...overrides,
  };
}

/** Enveloppe une session dans le format de retour de initWorkerSession. */
function makeInitResult(session: SpainCfSession): InitWorkerSessionResult {
  // Le pool n'accède qu'à `result.session` ; impit est opaque côté pool.
  return {
    session,
    impit: {} as never,
    cfFromCache: false,
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Par défaut, aucune IP n'est morte.
  mockIsDecodoIpBlacklisted.mockReturnValue(false);
  // Par défaut, la reconstitution/warmUp obtient une session valide.
  mockInitWorkerSession.mockImplementation(async () =>
    makeInitResult(makeCfSession()),
  );
  // Silencer les logs du pool pour garder la sortie de test lisible.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SPAIN_RESERVE_POOL_SIZE;
});

// ─── Scénario 1 : warmUp atteint targetSize sur IP distinctes ─────────────────

describe("warmUp — pré-solve jusqu'à targetSize sur des IP distinctes", () => {
  it("atteint targetSize et sélectionne une IP distincte par réserve", async () => {
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));

    const pool = createReservePool({ targetSize: 4 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);

    // Le pool a atteint sa cible.
    expect(pool.size()).toBe(4);
    // Une session solvée par réserve.
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(4);

    // Chaque appel de solve a reçu une URL proxy distincte.
    const usedUrls = mockInitWorkerSession.mock.calls.map((c) => c[0]);
    expect(new Set(usedUrls).size).toBe(4);

    // La clé (capsolver) et l'URL portail sont bien propagées.
    for (const call of mockInitWorkerSession.mock.calls) {
      expect(call[1]).toBe(PORTAL_URL);
      expect(call[2]).toBe(CAPSOLVER_KEY);
    }
  });

  it("s'arrête proprement quand plus aucune IP distincte n'est disponible", async () => {
    // rotateDecodoUrl finit par retourner undefined (pool d'IP épuisé).
    const urls = [makeProxyUrl(1), makeProxyUrl(2)];
    let i = 0;
    mockRotateDecodoUrl.mockImplementation(() =>
      i < urls.length ? urls[i++] : undefined,
    );

    const pool = createReservePool({ targetSize: 5 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);

    // Seules 2 IP distinctes disponibles → warmUp s'arrête à 2, ne boucle pas.
    expect(pool.size()).toBe(2);
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(2);
  });

  it("ne compte pas les solves échoués comme des réserves", async () => {
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    // Le 2e solve échoue (null), les autres réussissent.
    let solveCall = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      solveCall++;
      if (solveCall === 2) return null;
      return makeInitResult(makeCfSession());
    });

    const pool = createReservePool({ targetSize: 3 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);

    // 3 réserves valides atteintes malgré 1 échec → au moins 4 tentatives.
    expect(pool.size()).toBe(3);
    expect(mockInitWorkerSession.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── Scénario 5 : IP mortes exclues de la sélection ───────────────────────────

describe("warmUp — les IP mortes (blacklistées) sont exclues", () => {
  it("saute les IP blacklistées et n'établit de réserve que sur des IP vivantes", async () => {
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    // Les IP d'index pair sont mortes.
    mockIsDecodoIpBlacklisted.mockImplementation((url) => {
      const match = url.match(/10\.0\.0\.(\d+):/);
      const idx = match ? Number(match[1]) : 0;
      return idx % 2 === 0;
    });

    const pool = createReservePool({ targetSize: 2 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);

    expect(pool.size()).toBe(2);
    // Aucune IP paire (morte) n'a servi de proxy pour un solve.
    for (const call of mockInitWorkerSession.mock.calls) {
      const url = call[0];
      const idx = Number(url.match(/10\.0\.0\.(\d+):/)?.[1] ?? "0");
      expect(idx % 2).toBe(1);
    }
  });
});

// ─── Scénario 2 : borrow ignore les réserves expirées, null si vide ───────────

describe("borrow — ignore les réserves cf_clearance expiré, null si vide", () => {
  it("retourne une réserve valide et la retire du pool", async () => {
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));

    const pool = createReservePool({ targetSize: 2 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);
    expect(pool.size()).toBe(2);

    const borrowed = pool.borrow(Date.now());
    expect(borrowed).not.toBeNull();
    expect(borrowed?.session.cfClearance).toBeTruthy();
    // La réserve empruntée est retirée du pool.
    expect(pool.size()).toBe(1);
  });

  it("ignore les réserves expirées et retourne une réserve valide", async () => {
    const now = 1_700_000_000_000;
    // Figer l'horloge : warmUp/size utilisent Date.now() en interne.
    vi.spyOn(Date, "now").mockReturnValue(now);
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    // 1re réserve déjà expirée, 2e encore valide, 3e valide → warmUp atteint 2 valides.
    let solveCall = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      solveCall++;
      const expiresAt = solveCall === 1 ? now - 1_000 : now + 60 * 60_000;
      return makeInitResult(makeCfSession({ createdAt: now, expiresAt }));
    });

    const pool = createReservePool({ targetSize: 2 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);

    // size ne compte que les réserves valides (l'expirée est ignorée).
    expect(pool.size()).toBe(2);

    const borrowed = pool.borrow(now);
    expect(borrowed).not.toBeNull();
    // La réserve retournée n'est pas expirée.
    expect(borrowed!.cfExpiresAtMs).toBeGreaterThan(now);
  });

  it("retourne null quand le pool est vide", () => {
    const pool = createReservePool({ targetSize: 2 });
    expect(pool.borrow(Date.now())).toBeNull();
  });

  it("retourne null quand toutes les réserves sont expirées", async () => {
    const now = 1_700_000_000_000;
    // Figer l'horloge à `now` pour que warmUp voie les réserves comme valides.
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    mockInitWorkerSession.mockImplementation(async () =>
      makeInitResult(makeCfSession({ createdAt: now, expiresAt: now + 60 * 60_000 })),
    );

    const pool = createReservePool({ targetSize: 2 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);
    expect(pool.size()).toBe(2);

    // Avancer l'horloge bien après l'expiration : toutes les réserves sont périmées.
    const wayLater = now + 2 * 60 * 60_000;
    dateSpy.mockReturnValue(wayLater);
    expect(pool.borrow(wayLater)).toBeNull();
    expect(pool.size()).toBe(0);
  });
});

// ─── Scénario 3 : size compte correctement ────────────────────────────────────

describe("size — compte les réserves valides, borné [0, targetSize]", () => {
  it("vaut 0 sur un pool neuf", () => {
    const pool = createReservePool({ targetSize: 4 });
    expect(pool.size()).toBe(0);
  });

  it("ne compte que les réserves dont le cf_clearance n'est pas expiré", async () => {
    const now = 1_700_000_000_000;
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    // 2 valides, 1 expirée sur 3 tentatives.
    let solveCall = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      solveCall++;
      const expiresAt = solveCall === 2 ? now - 5_000 : now + 60 * 60_000;
      return makeInitResult(makeCfSession({ createdAt: now, expiresAt }));
    });

    // targetSize 2 : warmUp boucle jusqu'à 2 valides malgré l'expirée.
    const pool = createReservePool({ targetSize: 2 });
    vi.spyOn(Date, "now").mockReturnValue(now);
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);

    expect(pool.size()).toBe(2);
  });
});

// ─── Scénario 4 : replenishAsync retry 3× avec backoff puis warn ──────────────

describe("replenishAsync — retry 3× avec backoff exponentiel puis warn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retente 3 fois avec backoff (2000ms, 4000ms) puis warn en cas d'échec persistant", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // targetSize 1 pour ne reconstituer qu'un slot.
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    // Tous les solves échouent → épuise les 3 tentatives.
    mockInitWorkerSession.mockResolvedValue(null);

    const pool = createReservePool({ targetSize: 1 });

    pool.replenishAsync(CAPSOLVER_KEY, PORTAL_URL);

    // Laisser la boucle async progresser à travers les backoffs (2000, 4000).
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.runAllTimersAsync();

    // 3 tentatives de solve exactement (REPLENISH_MAX_ATTEMPTS).
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(3);
    // IP morte blacklistée à chaque échec de solve.
    expect(mockFlagDecodoIp).toHaveBeenCalled();
    // Un warn final signalant l'échec de reconstitution.
    const warnedFailure = warnSpy.mock.calls.some((c) =>
      String(c[0]).includes("Reconstitution échouée"),
    );
    expect(warnedFailure).toBe(true);
    // Le pool reste vide (aucune réserve ajoutée) — réserves existantes préservées.
    expect(pool.size()).toBe(0);
  });

  it("reconstitue une réserve sans épuiser les tentatives si le solve réussit", async () => {
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    // 1er solve échoue, 2e réussit.
    let solveCall = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      solveCall++;
      if (solveCall === 1) return null;
      return makeInitResult(makeCfSession());
    });

    const pool = createReservePool({ targetSize: 1 });
    pool.replenishAsync(CAPSOLVER_KEY, PORTAL_URL);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.runAllTimersAsync();

    // 2 tentatives (échec puis succès), pas 3.
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(2);
    expect(pool.size()).toBe(1);
  });

  it("ne fait rien si le pool est déjà à targetSize", async () => {
    let ipIndex = 0;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));

    const pool = createReservePool({ targetSize: 1 });
    await pool.warmUp(CAPSOLVER_KEY, PORTAL_URL);
    expect(pool.size()).toBe(1);

    mockInitWorkerSession.mockClear();
    pool.replenishAsync(CAPSOLVER_KEY, PORTAL_URL);
    await vi.runAllTimersAsync();

    // Aucun solve : rien à reconstituer.
    expect(mockInitWorkerSession).not.toHaveBeenCalled();
  });
});

// ─── targetSize : bornage et override via env (Requirement 11.7) ──────────────

describe("targetSize — bornage [1,100] et override via SPAIN_RESERVE_POOL_SIZE", () => {
  it("utilise opts.targetSize quand valide", () => {
    const pool = createReservePool({ targetSize: 7 });
    expect(pool.targetSize).toBe(7);
  });

  it("SPAIN_RESERVE_POOL_SIZE prime sur opts.targetSize", () => {
    process.env.SPAIN_RESERVE_POOL_SIZE = "9";
    const pool = createReservePool({ targetSize: 3 });
    expect(pool.targetSize).toBe(9);
  });

  it("retombe sur le défaut 4 pour une valeur opts hors bornes", () => {
    const pool = createReservePool({ targetSize: 999 });
    expect(pool.targetSize).toBe(4);
  });

  it("ignore un SPAIN_RESERVE_POOL_SIZE non numérique et retombe sur opts", () => {
    process.env.SPAIN_RESERVE_POOL_SIZE = "abc";
    const pool = createReservePool({ targetSize: 5 });
    expect(pool.targetSize).toBe(5);
  });
});
