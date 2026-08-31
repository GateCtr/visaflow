/**
 * spain-preflight-controller.test.ts — Tests unitaires du PreflightController
 * (feature spain-synchronized-scan, tâche 8.2).
 *
 * L'infra réseau/proxy est mockée via vitest (`vi.mock`) — le contrôleur importe
 * `initWorkerSession` et `rotateDecodoUrl` au niveau module :
 *   - `initWorkerSession` (spain-soax-solver)  — armement / re-solve d'une session CF
 *   - `rotateDecodoUrl`   (spain-decodo-pool)  — sélection d'une IP Decodo distincte
 *
 * Le `ReservePoolManager` est injecté directement en tant que dépendance mockée
 * (borrow / replenishAsync / warmUp / size), ce qui permet de piloter la présence
 * ou l'absence de réserve pour tester le swap et le re-solve.
 *
 * Scénarios couverts :
 *   1. isPreflightWindow aux bornes de la fenêtre `[windowStartMin, huntStartMin[`.
 *   2. armAll arme exactement une session par dossier non armé, isole les échecs
 *      (un dossier en échec n'interrompt pas les autres), et ne ré-arme pas.
 *   3. verifyAndRepair : swap réserve sur session invalide, re-solve si réserve
 *      vide, marque le dossier non prêt si toujours invalide à huntStartMin.
 *
 * Ancrage du fuseau Europe/Madrid : la minute-dans-l'heure est invariante par le
 * décalage horaire entier de l'Espagne (UTC+1/UTC+2), donc
 * `minute(Europe/Madrid) === minute(UTC)`. On fabrique des `nowMs` réels dont la
 * minute UTC est maîtrisée (`ancrageHeure + minute*60_000`), sans mocker `Intl`.
 *
 * _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpainCfSession } from "../spain-soax-solver.js";

// ─── Mocks des modules d'infra (aucun réseau/proxy réel en test) ──────────────

vi.mock("../spain-soax-solver.js", () => ({
  initWorkerSession: vi.fn(),
}));

vi.mock("../spain-decodo-pool.js", () => ({
  rotateDecodoUrl: vi.fn(),
}));

import { initWorkerSession } from "../spain-soax-solver.js";
import { rotateDecodoUrl } from "../spain-decodo-pool.js";
import { createPreflightController } from "../spain/spain-preflight-controller.js";
import type {
  PreflightDeps,
  PreflightController,
} from "../spain/spain-preflight-controller.js";
import type { GridConfig } from "../spain/spain-grid-config.js";
import type {
  ReservePoolManager,
  ReserveSession,
} from "../spain/spain-reserve-pool.js";
import type { SpainDossierConfig } from "../spain-dossier-worker.js";

// ─── Références typées aux mocks ──────────────────────────────────────────────

const mockInitWorkerSession = vi.mocked(initWorkerSession);
const mockRotateDecodoUrl = vi.mocked(rotateDecodoUrl);

/** Type de retour concret de initWorkerSession (session + impit + cfFromCache). */
type InitWorkerSessionResult = Awaited<ReturnType<typeof initWorkerSession>>;

// ─── Constantes de test ───────────────────────────────────────────────────────

const CAPSOLVER_KEY = "test-capsolver-key";
const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/test/";

/** Config de référence : windowStart=5, huntStart=13, lateStart=17, windowEnd=25. */
const CONFIG: GridConfig = {
  huntTickMs: 10_000,
  lateTickMs: 60_000,
  jitterPct: 0.2,
  windowStartMin: 5,
  huntStartMin: 13,
  lateStartMin: 17,
  windowEndMin: 25,
};

// ─── Ancrage nowMs à minute-dans-l'heure contrôlée (UTC == Madrid) ────────────

/** Frontière d'heure UTC (minute 0, seconde 0) servant d'ancrage. */
const HOUR_ANCHOR_UTC_MS = Date.UTC(2023, 10, 14, 0, 0, 0, 0);

/** Construit un instant epoch dont la minute-dans-l'heure (UTC == Madrid) vaut `minute`. */
function nowMsAtMinute(minute: number): number {
  return HOUR_ANCHOR_UTC_MS + minute * 60_000;
}

// ─── Fabriques d'objets de test ───────────────────────────────────────────────

/** Construit une URL proxy Decodo factice, distincte par index. */
function makeProxyUrl(index: number): string {
  return `http://user:pass@10.0.0.${index}:10000`;
}

/** Construit un SpainDossierConfig minimal mais complet pour les tests. */
function makeDossier(id: string): SpainDossierConfig {
  return {
    id,
    applicantName: `Applicant ${id}`,
    visaType: "schengen",
    login: `login-${id}`,
    password: "secret",
    applicationId: `app-${id}`,
    otpChannel: "manual",
    portalUrl: PORTAL_URL,
  };
}

/** Construit une SpainCfSession minimale mais complète. `expiresAt` contrôle la validité. */
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
  return {
    session,
    impit: {} as never,
    cfFromCache: false,
  };
}

/** Construit une ReserveSession de test à partir d'une session CF. */
function makeReserveSession(session: SpainCfSession, proxyUrl: string): ReserveSession {
  return {
    session,
    proxyUrl,
    stickyId: "sticky-test",
    cfExpiresAtMs: session.expiresAt,
    solvedAtMs: session.createdAt,
  };
}

/**
 * Fabrique un ReservePoolManager mocké. Par défaut : pool vide (`borrow` → null),
 * `size` → 0, `warmUp`/`replenishAsync` no-op. Surchargeable par test.
 */
function makeMockReservePool(overrides: Partial<ReservePoolManager> = {}): ReservePoolManager {
  return {
    targetSize: 4,
    warmUp: vi.fn(async () => undefined),
    borrow: vi.fn(() => null),
    replenishAsync: vi.fn(() => undefined),
    size: vi.fn(() => 0),
    ...overrides,
  };
}

/** Assemble les deps du contrôleur avec un pool de réserve donné. */
function makeDeps(reservePool: ReservePoolManager, config: GridConfig = CONFIG): PreflightDeps {
  return {
    config,
    reservePool,
    capsolverKey: CAPSOLVER_KEY,
    portalUrl: PORTAL_URL,
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Par défaut, chaque armement obtient une IP distincte et une session valide.
  let ipIndex = 0;
  mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
  mockInitWorkerSession.mockImplementation(async () => makeInitResult(makeCfSession()));
  // Silencer les logs du contrôleur pour garder la sortie de test lisible.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Scénario 1 : isPreflightWindow aux bornes ────────────────────────────────
// Fenêtre preflight = [windowStartMin, huntStartMin[ = [5, 13[.

describe("isPreflightWindow — bornes de la fenêtre [windowStartMin, huntStartMin[", () => {
  let controller: PreflightController;

  beforeEach(() => {
    controller = createPreflightController(makeDeps(makeMockReservePool()));
  });

  interface WindowCase {
    readonly minute: number;
    readonly expected: boolean;
    readonly label: string;
  }

  const cases: readonly WindowCase[] = [
    { minute: 0, expected: false, label: "minute 0 (avant windowStart)" },
    { minute: 4, expected: false, label: "minute 4 (juste avant windowStart)" },
    { minute: 5, expected: true, label: "minute 5 = windowStart (borne basse incluse)" },
    { minute: 6, expected: true, label: "minute 6 (dans la fenêtre)" },
    { minute: 12, expected: true, label: "minute 12 (juste avant huntStart)" },
    { minute: 13, expected: false, label: "minute 13 = huntStart (borne haute exclue)" },
    { minute: 14, expected: false, label: "minute 14 (après huntStart)" },
    { minute: 25, expected: false, label: "minute 25 = windowEnd (hors fenêtre)" },
    { minute: 59, expected: false, label: "minute 59 (fin d'heure)" },
  ];

  for (const c of cases) {
    it(`${c.label} → ${c.expected}`, () => {
      expect(controller.isPreflightWindow(nowMsAtMinute(c.minute))).toBe(c.expected);
    });
  }
});

// ─── Scénario 2 : armAll arme 1 session/dossier et isole les échecs ───────────

describe("armAll — arme exactement une session par dossier non armé", () => {
  it("arme chaque dossier avec une session sur une IP distincte", async () => {
    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    const dossiers = [makeDossier("d1"), makeDossier("d2"), makeDossier("d3")];

    await controller.armAll(dossiers);

    // Une session initialisée par dossier.
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(3);
    // Chaque armement sur une IP distincte.
    const usedUrls = mockInitWorkerSession.mock.calls.map((c) => c[0]);
    expect(new Set(usedUrls).size).toBe(3);
    // Tous les dossiers sont armés, aucun non prêt.
    const armed = controller.getArmedStates();
    expect(armed.size).toBe(3);
    expect(armed.get("d1")?.session).toBeDefined();
    expect(armed.get("d2")?.session).toBeDefined();
    expect(armed.get("d3")?.session).toBeDefined();
    expect(controller.getUnreadyDossiers().size).toBe(0);
  });

  it("propage capsolverKey et portalUrl à initWorkerSession", async () => {
    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    await controller.armAll([makeDossier("d1")]);

    const call = mockInitWorkerSession.mock.calls[0];
    expect(call[1]).toBe(PORTAL_URL);
    expect(call[2]).toBe(CAPSOLVER_KEY);
  });

  it("isole l'échec d'un dossier (init null) sans interrompre les autres", async () => {
    // Le 2e dossier échoue (session null), les autres réussissent.
    let solveCall = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      solveCall++;
      if (solveCall === 2) return null;
      return makeInitResult(makeCfSession());
    });

    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    await controller.armAll([makeDossier("d1"), makeDossier("d2"), makeDossier("d3")]);

    // Les 3 dossiers ont été tentés.
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(3);
    // Seuls d1 et d3 sont armés ; d2 (échec) n'a pas d'état armé.
    const armed = controller.getArmedStates();
    expect(armed.has("d1")).toBe(true);
    expect(armed.has("d2")).toBe(false);
    expect(armed.has("d3")).toBe(true);
  });

  it("isole une exception réseau à l'armement sans lancer ni interrompre les autres", async () => {
    // Le 1er dossier jette une erreur réseau, les suivants réussissent.
    let solveCall = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      solveCall++;
      if (solveCall === 1) throw new Error("ECONNRESET simulée");
      return makeInitResult(makeCfSession());
    });

    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    // Ne doit jamais rejeter.
    await expect(
      controller.armAll([makeDossier("d1"), makeDossier("d2")]),
    ).resolves.toBeUndefined();

    const armed = controller.getArmedStates();
    expect(armed.has("d1")).toBe(false);
    expect(armed.has("d2")).toBe(true);
  });

  it("ne ré-arme pas un dossier déjà armé (idempotence)", async () => {
    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    const dossiers = [makeDossier("d1"), makeDossier("d2")];

    await controller.armAll(dossiers);
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(2);

    mockInitWorkerSession.mockClear();
    // Second appel : les deux sont déjà armés → aucun nouvel init.
    await controller.armAll(dossiers);
    expect(mockInitWorkerSession).not.toHaveBeenCalled();
    expect(controller.getArmedStates().size).toBe(2);
  });

  it("interrompt l'init si le secret CapSolver est absent, sans révéler de valeur", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps: PreflightDeps = {
      config: CONFIG,
      reservePool: makeMockReservePool(),
      capsolverKey: "", // secret manquant
      portalUrl: PORTAL_URL,
    };
    const controller = createPreflightController(deps);

    await controller.armAll([makeDossier("d1")]);

    // Aucun appel réseau tenté.
    expect(mockInitWorkerSession).not.toHaveBeenCalled();
    // Aucun dossier armé.
    expect(controller.getArmedStates().size).toBe(0);
    // Le message nomme la variable d'env manquante.
    const named = errorSpy.mock.calls.some((c) =>
      String(c[0]).includes("CAPSOLVER_API_KEY"),
    );
    expect(named).toBe(true);
  });

  it("isole une session armée sans cf_clearance (échec silencieux du dossier)", async () => {
    let solveCall = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      solveCall++;
      if (solveCall === 1) return makeInitResult(makeCfSession({ cfClearance: "" }));
      return makeInitResult(makeCfSession());
    });

    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    await controller.armAll([makeDossier("d1"), makeDossier("d2")]);

    expect(controller.getArmedStates().has("d1")).toBe(false);
    expect(controller.getArmedStates().has("d2")).toBe(true);
  });
});

// ─── Scénario 2b : armAll parallélise par vagues bornées (concurrence) ────────
// Chaque solve CF dure ~20-40 s en réel → armer 20 dossiers en série déborderait la
// fenêtre preflight. armAll arme par vagues de SPAIN_PREFLIGHT_CONCURRENCY. On vérifie
// que (a) tous les dossiers sont armés, (b) la concurrence simultanée ne dépasse jamais
// la limite configurée, (c) plusieurs solves tournent bien EN PARALLÈLE (> 1 en vol).

describe("armAll — parallélisme borné par SPAIN_PREFLIGHT_CONCURRENCY", () => {
  const OLD_CONC = process.env.SPAIN_PREFLIGHT_CONCURRENCY;

  afterEach(() => {
    if (OLD_CONC === undefined) delete process.env.SPAIN_PREFLIGHT_CONCURRENCY;
    else process.env.SPAIN_PREFLIGHT_CONCURRENCY = OLD_CONC;
  });

  it("ne dépasse jamais la concurrence configurée et arme tous les dossiers", async () => {
    process.env.SPAIN_PREFLIGHT_CONCURRENCY = "5";

    // Instrumente initWorkerSession pour mesurer la concurrence réelle : chaque appel
    // incrémente un compteur "en vol", attend un micro-délai, puis résout. Le pic
    // observé ne doit jamais dépasser 5.
    let inFlight = 0;
    let maxInFlight = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return makeInitResult(makeCfSession());
    });

    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    const dossiers = Array.from({ length: 12 }, (_, i) => makeDossier(`d${i + 1}`));
    await controller.armAll(dossiers);

    // Tous armés.
    expect(controller.getArmedStates().size).toBe(12);
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(12);
    // Concurrence bornée : pic ≤ 5, et parallélisme effectif (> 1 en vol simultané).
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("concurrence=1 → armement strictement séquentiel (pic en vol = 1)", async () => {
    process.env.SPAIN_PREFLIGHT_CONCURRENCY = "1";

    let inFlight = 0;
    let maxInFlight = 0;
    mockInitWorkerSession.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return makeInitResult(makeCfSession());
    });

    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    await controller.armAll([makeDossier("d1"), makeDossier("d2"), makeDossier("d3")]);

    expect(controller.getArmedStates().size).toBe(3);
    expect(maxInFlight).toBe(1);
  });

  it("valeur invalide → concurrence par défaut (5), arme tout sans planter", async () => {
    process.env.SPAIN_PREFLIGHT_CONCURRENCY = "abc";
    const controller = createPreflightController(makeDeps(makeMockReservePool()));
    const dossiers = Array.from({ length: 6 }, (_, i) => makeDossier(`d${i + 1}`));
    await controller.armAll(dossiers);
    expect(controller.getArmedStates().size).toBe(6);
  });
});

// ─── Scénario 3 : verifyAndRepair — swap / re-solve / non prêt ────────────────

describe("verifyAndRepair — swap sur invalidité, re-solve si réserve vide, non prêt à huntStartMin", () => {
  /**
   * Arme un dossier avec une session dont l'expiration est fournie, puis retourne
   * le contrôleur et le pool mocké. `nowMs` sert d'horloge pour l'armement.
   */
  async function armOneWith(
    reservePool: ReservePoolManager,
    sessionExpiresAt: number,
    dossierId = "d1",
  ): Promise<PreflightController> {
    mockInitWorkerSession.mockImplementationOnce(async () =>
      makeInitResult(makeCfSession({ expiresAt: sessionExpiresAt })),
    );
    const controller = createPreflightController(makeDeps(reservePool));
    await controller.armAll([makeDossier(dossierId)]);
    return controller;
  }

  it("laisse intacte une session valide (aucune réparation)", async () => {
    const pool = makeMockReservePool();
    const nowMs = nowMsAtMinute(6); // dans la fenêtre preflight
    const controller = await armOneWith(pool, nowMs + 60 * 60_000);

    await controller.verifyAndRepair(nowMs);

    // Session valide → aucun swap ni re-solve.
    expect(pool.borrow).not.toHaveBeenCalled();
    expect(controller.getUnreadyDossiers().size).toBe(0);
  });

  it("swap vers une réserve quand la session armée est invalide (expirée)", async () => {
    const nowMs = nowMsAtMinute(6);
    const reserveSession = makeCfSession({ expiresAt: nowMs + 60 * 60_000 });
    const reserveProxy = makeProxyUrl(99);
    const pool = makeMockReservePool({
      borrow: vi.fn(() => makeReserveSession(reserveSession, reserveProxy)),
    });
    // Session armée déjà expirée à nowMs.
    const controller = await armOneWith(pool, nowMs - 1_000);

    await controller.verifyAndRepair(nowMs);

    // Une réserve a été empruntée + reconstitution déclenchée en fond.
    expect(pool.borrow).toHaveBeenCalledTimes(1);
    expect(pool.replenishAsync).toHaveBeenCalledTimes(1);
    // La session armée a été remplacée par celle de la réserve, et l'IP mise à jour.
    const rt = controller.getArmedStates().get("d1");
    expect(rt?.session?.cfClearance).toBe(reserveSession.cfClearance);
    expect(rt?.proxyUrl).toBe(reserveProxy);
    // Dossier prêt (session valide après swap).
    expect(controller.getUnreadyDossiers().size).toBe(0);
  });

  it("re-solve immédiat quand la réserve est vide (borrow → null)", async () => {
    const nowMs = nowMsAtMinute(6);
    const pool = makeMockReservePool({ borrow: vi.fn(() => null) });
    const controller = await armOneWith(pool, nowMs - 1_000);

    // Le re-solve (initWorkerSession) doit rendre une session valide.
    const reSolveProxy = makeProxyUrl(77);
    mockRotateDecodoUrl.mockReturnValueOnce(reSolveProxy);
    mockInitWorkerSession.mockImplementationOnce(async () =>
      makeInitResult(makeCfSession({ expiresAt: nowMs + 60 * 60_000 })),
    );

    await controller.verifyAndRepair(nowMs);

    // borrow tenté (vide) puis re-solve effectué.
    expect(pool.borrow).toHaveBeenCalledTimes(1);
    // initWorkerSession appelé une 2e fois (1x armement + 1x re-solve).
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(2);
    // Session réparée valide → dossier prêt.
    const rt = controller.getArmedStates().get("d1");
    expect(rt?.session?.expiresAt).toBeGreaterThan(nowMs);
    expect(rt?.proxyUrl).toBe(reSolveProxy);
    expect(controller.getUnreadyDossiers().size).toBe(0);
  });

  it("marque le dossier non prêt à huntStartMin si la session reste invalide après réparation", async () => {
    // À huntStartMin (minute 13), une réparation qui échoue ⟹ dossier non prêt.
    const nowMs = nowMsAtMinute(13);
    // Réserve vide + re-solve qui échoue (null) ⟹ session toujours invalide.
    const pool = makeMockReservePool({ borrow: vi.fn(() => null) });
    const controller = await armOneWith(pool, nowMs - 1_000);

    mockInitWorkerSession.mockImplementationOnce(async () => null); // re-solve échoue

    await controller.verifyAndRepair(nowMs);

    // Dossier marqué non prêt (Requirement 6.5).
    const unready = controller.getUnreadyDossiers();
    expect(unready.has("d1")).toBe(true);
  });

  it("ne marque PAS non prêt avant huntStartMin même si la réparation échoue (retentera)", async () => {
    // Avant huntStartMin (minute 10), réparation échouée ⟹ pas encore non prêt.
    const nowMs = nowMsAtMinute(10);
    const pool = makeMockReservePool({ borrow: vi.fn(() => null) });
    const controller = await armOneWith(pool, nowMs - 1_000);

    mockInitWorkerSession.mockImplementationOnce(async () => null); // re-solve échoue

    await controller.verifyAndRepair(nowMs);

    // Toujours invalide mais avant huntStartMin → pas encore marqué non prêt.
    expect(controller.getUnreadyDossiers().has("d1")).toBe(false);
  });

  it("isole les dossiers : un dossier invalide non réparable ne bloque pas un dossier valide", async () => {
    const nowMs = nowMsAtMinute(13);
    const pool = makeMockReservePool({ borrow: vi.fn(() => null) });
    const controller = createPreflightController(makeDeps(pool));

    // d1 armé valide, d2 armé invalide (expiré).
    mockInitWorkerSession
      .mockImplementationOnce(async () => makeInitResult(makeCfSession({ expiresAt: nowMs + 60 * 60_000 })))
      .mockImplementationOnce(async () => makeInitResult(makeCfSession({ expiresAt: nowMs - 1_000 })));
    await controller.armAll([makeDossier("d1"), makeDossier("d2")]);

    // Re-solve de d2 échoue → d2 non prêt.
    mockInitWorkerSession.mockImplementationOnce(async () => null);

    await controller.verifyAndRepair(nowMs);

    const unready = controller.getUnreadyDossiers();
    expect(unready.has("d1")).toBe(false);
    expect(unready.has("d2")).toBe(true);
    // d1 reste armé et prêt.
    expect(controller.getArmedStates().get("d1")?.session?.expiresAt).toBeGreaterThan(nowMs);
  });

  it("efface le statut non prêt d'un dossier réparé à un tick ultérieur", async () => {
    const nowMs = nowMsAtMinute(13);
    // 1re passe : réserve vide + re-solve échoue → non prêt.
    const reserveSession = makeCfSession({ expiresAt: nowMs + 60 * 60_000 });
    const borrowMock = vi
      .fn<ReservePoolManager["borrow"]>()
      .mockReturnValueOnce(null) // 1re réparation : pas de réserve
      .mockReturnValueOnce(makeReserveSession(reserveSession, makeProxyUrl(88))); // 2e : réserve dispo
    const pool = makeMockReservePool({ borrow: borrowMock });
    const controller = await armOneWith(pool, nowMs - 1_000);

    mockInitWorkerSession.mockImplementationOnce(async () => null); // re-solve 1re passe échoue
    await controller.verifyAndRepair(nowMs);
    expect(controller.getUnreadyDossiers().has("d1")).toBe(true);

    // 2e passe : swap réserve réussit → dossier de nouveau prêt.
    await controller.verifyAndRepair(nowMs);
    expect(controller.getUnreadyDossiers().has("d1")).toBe(false);
  });
});
