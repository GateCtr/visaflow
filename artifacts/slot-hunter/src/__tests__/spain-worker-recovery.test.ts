/**
 * spain-worker-recovery.test.ts — Property + unit tests de la récupération
 * asynchrone non bloquante `enterRecoveryAsync` (feature spain-synchronized-scan,
 * tâche 7.2).
 *
 * L'infra réseau/proxy est entièrement mockée via vitest (`vi.mock`) :
 *   - `initWorkerSession` (spain-soax-solver)      — re-solve CF d'une session
 *   - `initPhpState`      (spain-dossier-worker)    — régénère le PHPSESSID
 *   - `rotateDecodoUrl`   (spain-decodo-pool)       — sélection d'une IP distincte
 *   - `flagDecodoIp`      (spain-decodo-pool)       — blacklist d'une IP morte
 *
 * Le `ReservePoolManager` est injecté sous forme d'objet-espion (mocks `borrow`,
 * `replenishAsync`, `size`, ...) via `RecoveryDeps` — on n'a donc pas besoin de
 * mocker `spain-reserve-pool.js`.
 *
 * Scénarios couverts :
 *   - Property 8 : Swap réserve prioritaire sur re-solve — `proxy_dead` avec
 *     `size()>0` au swap ⟹ aucun `initWorkerSession` synchrone bloquant. (Req 5.2)
 *   - Unit : transition SCANNING → RECOVERING en < 100 ms (Req 3.2).
 *   - Unit : `session_dead` garde IP + CF (Req 10.6).
 *   - Unit : `cf_expired` garde le PHPSESSID (Req 10.7).
 *   - Unit : backoff/retry max 10 puis reste RECOVERING terminal (Req 3.6, 3.7).
 *   - Unit : pool épuisé (borrow null + rotation impossible) reste RECOVERING
 *     non terminal (Req 14.1, 14.4).
 *
 * Validates: Requirements 3.2, 3.6, 3.7, 5.2, 10.6, 10.7, 14.1, 14.4
 */

import fc from "fast-check";
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
import { initPhpState } from "../spain-dossier-worker.js";
import type { SpainDossierConfig, WorkerPhpState } from "../spain-dossier-worker.js";
import { rotateDecodoUrl, flagDecodoIp } from "../spain-decodo-pool.js";
import { createRuntimeState, transition } from "../spain/spain-worker-state-machine.js";
import type {
  FailureKind,
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
const mockInitPhpState = vi.mocked(initPhpState);
const mockRotateDecodoUrl = vi.mocked(rotateDecodoUrl);
const mockFlagDecodoIp = vi.mocked(flagDecodoIp);

// ─── Constantes de test ───────────────────────────────────────────────────────

const CAPSOLVER_KEY = "test-capsolver-key";
const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/test/";
const CURRENT_PROXY = "http://user:pass@10.0.0.1:10000";
const TAG = "[test-worker]";

/** Nombre maximal de tentatives de récupération (miroir de MAX_RECOVERY_ATTEMPTS). */
const MAX_RECOVERY_ATTEMPTS = 10;
/** Backoff fixe entre tentatives (miroir de RECOVERY_BACKOFF_MS). */
const RECOVERY_BACKOFF_MS = 5_000;

/** Type de retour concret de initWorkerSession (session + impit + cfFromCache). */
type InitWorkerSessionResult = Awaited<ReturnType<typeof initWorkerSession>>;

// ─── Fabriques d'objets de test ───────────────────────────────────────────────

/** Construit une URL proxy Decodo factice, distincte par index. */
function makeProxyUrl(index: number): string {
  return `http://user:pass@10.0.0.${index}:10000`;
}

/**
 * Construit une SpainCfSession minimale mais complète pour les tests.
 * `soaxProxyUrl` doit correspondre à l'URL proxy attendue afin que le contrôle
 * d'exit IP (`sessionMatchesExitIp`) de la récupération considère la session valide.
 */
function makeCfSession(overrides: Partial<SpainCfSession> = {}): SpainCfSession {
  const now = Date.now();
  return {
    cfClearance: "cf_clearance_value_abcdef0123456789",
    cfDomain: ".citaconsular.es",
    soaxProxyUrl: CURRENT_PROXY,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0",
    createdAt: now,
    expiresAt: now + 60 * 60_000,
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

/** Construit un WorkerPhpState factice (les cycles n'inspectent pas son contenu). */
function makePhpState(agendaId = "agenda-42"): WorkerPhpState {
  return {
    services: [{ serviceId: "svc-1", serviceName: "Visa" }],
    agendaId,
    bestServiceId: "svc-1",
    bestServiceName: "Visa",
    allowAppointment: true,
    ds: {} as never,
  };
}

/** Construit une ReserveSession valide pour un swap. */
function makeReserveSession(index = 2): ReserveSession {
  const proxyUrl = makeProxyUrl(index);
  const session = makeCfSession({ soaxProxyUrl: proxyUrl });
  return {
    session,
    proxyUrl,
    stickyId: `sticky-000000${index}`,
    cfExpiresAtMs: session.expiresAt,
    solvedAtMs: session.createdAt,
  };
}

/** Config dossier minimale (seule la présence compte pour initPhpState mocké). */
function makeConfig(): SpainDossierConfig {
  return {
    id: "dossier-test-42",
    applicantName: "Jane Doe",
    visaType: "schengen",
    login: "login",
    password: "password",
    applicationId: "APP-1",
    otpChannel: "manual",
    portalUrl: PORTAL_URL,
  };
}

/**
 * Construit un espion `ReservePoolManager` avec des implémentations par défaut
 * neutres. Les tests surchargent `borrow`/`size`/... selon le scénario.
 */
function makeReservePoolSpy(
  overrides: Partial<ReservePoolManager> = {},
): ReservePoolManager {
  return {
    targetSize: 4,
    warmUp: vi.fn(async () => undefined),
    borrow: vi.fn(() => null),
    replenishAsync: vi.fn(() => undefined),
    size: vi.fn(() => 0),
    ...overrides,
  };
}

/** Construit un WorkerRuntimeState armé, session CF liée à `CURRENT_PROXY`. */
function makeRuntime(
  overrides: Partial<WorkerRuntimeState> = {},
): WorkerRuntimeState {
  const rt = createRuntimeState({
    dossierId: "dossier-test-42",
    proxyUrl: CURRENT_PROXY,
    session: makeCfSession(),
    phpState: makePhpState(),
  });
  // La boucle appelante a déjà posé RECOVERING avant d'appeler enterRecoveryAsync.
  rt.state = "RECOVERING";
  return { ...rt, ...overrides };
}

/** Construit les RecoveryDeps avec un pool injecté. */
function makeDeps(reservePool: ReservePoolManager): RecoveryDeps {
  return {
    reservePool,
    capsolverKey: CAPSOLVER_KEY,
    portalUrl: PORTAL_URL,
    config: makeConfig(),
    tag: TAG,
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Silencer les logs de récupération pour garder la sortie de test lisible.
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Property 8 : Swap réserve prioritaire sur re-solve (Req 5.2) ─────────────

describe("Property 8 — swap réserve prioritaire sur re-solve (proxy_dead)", () => {
  it("∀ proxy_dead avec réserve disponible : aucun initWorkerSession synchrone bloquant dans le chemin du swap", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Indices d'IP de réserve arbitraires (distincts de l'IP courante).
        fc.integer({ min: 2, max: 250 }),
        async (reserveIndex) => {
          vi.clearAllMocks();
          const reserve = makeReserveSession(reserveIndex);
          const pool = makeReservePoolSpy({
            size: vi.fn(() => 1), // réserve disponible au swap
            borrow: vi.fn(() => reserve), // le swap réussit
            replenishAsync: vi.fn(() => undefined),
          });
          const rt = makeRuntime();
          const deps = makeDeps(pool);

          enterRecoveryAsync(rt, "proxy_dead", deps);
          // Laisser la microtask du fire-and-forget se dérouler complètement.
          await Promise.resolve();
          await Promise.resolve();
          await new Promise((r) => setImmediate(r));

          // Le chemin du swap ne fait AUCUN re-solve synchrone bloquant.
          expect(mockInitWorkerSession).not.toHaveBeenCalled();
          // Le swap a bien emprunté une réserve et adopté son IP + session.
          expect(pool.borrow).toHaveBeenCalledTimes(1);
          expect(rt.proxyUrl).toBe(reserve.proxyUrl);
          expect(rt.session).toBe(reserve.session);
          // La reconstitution est déclenchée en tâche de fond (non bloquante).
          expect(pool.replenishAsync).toHaveBeenCalledTimes(1);
          // L'IP morte est blacklistée et le worker rejoint ARMED.
          expect(mockFlagDecodoIp).toHaveBeenCalledWith(CURRENT_PROXY, "proxy_dead");
          expect(rt.state).toBe("ARMED");
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ─── Unit : transition SCANNING → RECOVERING en < 100 ms (Req 3.2) ────────────

describe("transition SCANNING → RECOVERING (Req 3.2)", () => {
  it("passe de SCANNING à RECOVERING de façon synchrone en < 100 ms pour chaque cause de récupération", () => {
    const recoveryKinds: readonly FailureKind[] = [
      "proxy_dead",
      "http_5xx",
      "session_dead",
      "cf_expired",
    ];

    for (const kind of recoveryKinds) {
      const rt = makeRuntime();
      rt.state = "SCANNING";

      const start = performance.now();
      const next = transition(rt, kind);
      const elapsed = performance.now() - start;

      expect(next).toBe("RECOVERING");
      expect(rt.state).toBe("RECOVERING");
      expect(elapsed).toBeLessThan(100);
    }
  });
});

// ─── Unit : session_dead garde IP + CF (Req 10.6) ─────────────────────────────

describe("session_dead — garde IP + CF, régénère uniquement le PHPSESSID (Req 10.6)", () => {
  it("appelle initPhpState sans re-solve CF ni rotation d'IP, IP + session inchangées", async () => {
    mockInitPhpState.mockResolvedValue(makePhpState("agenda-neuf"));

    const rt = makeRuntime();
    const originalSession = rt.session;
    const pool = makeReservePoolSpy();
    const deps = makeDeps(pool);

    enterRecoveryAsync(rt, "session_dead", deps);
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    // Nouveau PHPSESSID régénéré.
    expect(mockInitPhpState).toHaveBeenCalledTimes(1);
    expect(rt.phpState?.agendaId).toBe("agenda-neuf");

    // Aucun re-solve CF ni rotation d'IP : IP + CF conservés.
    expect(mockInitWorkerSession).not.toHaveBeenCalled();
    expect(mockRotateDecodoUrl).not.toHaveBeenCalled();
    expect(rt.proxyUrl).toBe(CURRENT_PROXY);
    expect(rt.session).toBe(originalSession);

    // Récupéré ⟹ ARMED.
    expect(rt.state).toBe("ARMED");
  });
});

// ─── Unit : cf_expired garde le PHPSESSID (Req 10.7) ──────────────────────────

describe("cf_expired — re-solve CF sur la même IP, garde le PHPSESSID (Req 10.7)", () => {
  it("re-solve CF via initWorkerSession sur l'IP courante sans rotation, PHPSESSID inchangé", async () => {
    const originalPhpState = makePhpState("agenda-conserve");
    // Le re-solve renvoie une session liée à l'exit IP courante (CURRENT_PROXY).
    mockInitWorkerSession.mockResolvedValue(
      makeInitResult(makeCfSession({ soaxProxyUrl: CURRENT_PROXY })),
    );

    const rt = makeRuntime({ phpState: originalPhpState });
    const pool = makeReservePoolSpy();
    const deps = makeDeps(pool);

    enterRecoveryAsync(rt, "cf_expired", deps);
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    // Re-solve CF sur la MÊME IP (pas de rotation, pas de PHPSESSID régénéré).
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(1);
    expect(mockInitWorkerSession).toHaveBeenCalledWith(
      CURRENT_PROXY,
      PORTAL_URL,
      CAPSOLVER_KEY,
    );
    expect(mockRotateDecodoUrl).not.toHaveBeenCalled();
    expect(mockInitPhpState).not.toHaveBeenCalled();

    // Le PHPSESSID est conservé tel quel (garde le PHPSESSID — Req 10.7).
    expect(rt.phpState).toBe(originalPhpState);
    expect(rt.proxyUrl).toBe(CURRENT_PROXY);
    expect(rt.state).toBe("ARMED");
  });
});

// ─── Unit : backoff/retry max 10 puis RECOVERING terminal (Req 3.6, 3.7) ──────

describe("backoff/retry — max 10 tentatives puis reste RECOVERING terminal (Req 3.6, 3.7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retente 10 fois avec backoff 5000 ms sur échec persistant puis reste RECOVERING", async () => {
    // Aucune réserve : proxy_dead bascule sur rotation + re-solve.
    const pool = makeReservePoolSpy({
      size: vi.fn(() => 0),
      borrow: vi.fn(() => null),
    });
    // Rotation renvoie toujours une nouvelle IP (pas d'épuisement de pool)...
    let ipIndex = 100;
    mockRotateDecodoUrl.mockImplementation(() => makeProxyUrl(++ipIndex));
    // ...mais chaque re-solve échoue (null) → verdict "retry" à chaque tentative.
    mockInitWorkerSession.mockResolvedValue(null);

    const rt = makeRuntime();
    const deps = makeDeps(pool);

    enterRecoveryAsync(rt, "proxy_dead", deps);

    // Dérouler les 10 tentatives : 9 backoffs de 5000 ms entre elles.
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS);
    }
    await vi.runAllTimersAsync();

    // Exactement 10 tentatives de re-solve (borne MAX_RECOVERY_ATTEMPTS).
    expect(mockInitWorkerSession).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
    // Le worker reste RECOVERING (terminal — jamais transité vers ARMED).
    expect(rt.state).toBe("RECOVERING");
  });
});

// ─── Unit : pool épuisé reste RECOVERING non terminal (Req 14.1, 14.4) ────────

describe("pool épuisé — borrow null + rotation impossible reste RECOVERING non terminal (Req 14.1, 14.4)", () => {
  it("ne boucle pas et ne re-solve pas : sort immédiatement en laissant RECOVERING", async () => {
    // Réserve vide ET rotation impossible ⟹ pool épuisé (verdict pool_exhausted).
    const pool = makeReservePoolSpy({
      size: vi.fn(() => 0),
      borrow: vi.fn(() => null),
    });
    mockRotateDecodoUrl.mockReturnValue(undefined);

    const rt = makeRuntime();
    const deps = makeDeps(pool);

    enterRecoveryAsync(rt, "proxy_dead", deps);
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    // Aucun re-solve (rotation impossible) et aucune boucle de retry.
    expect(mockInitWorkerSession).not.toHaveBeenCalled();
    expect(pool.borrow).toHaveBeenCalledTimes(1);
    // L'IP morte est bien blacklistée avant la tentative de rotation.
    expect(mockFlagDecodoIp).toHaveBeenCalledWith(CURRENT_PROXY, "proxy_dead");
    // Reste RECOVERING (non terminal) — la boucle de tick retentera.
    expect(rt.state).toBe("RECOVERING");
  });
});
