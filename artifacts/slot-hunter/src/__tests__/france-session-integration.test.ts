/**
 * france-session-integration.test.ts — Tests d'intégration de l'ouverture de
 * session France (feature france-visa-hunter, task 6.5).
 *
 * Cible : `openSession` de `src/france/france-session.ts`, exercée via un STUB
 * du client HTTP (`FranceHttpClient`) — aucun réseau/proxy réel. `openSession`
 * reçoit le client en paramètre : on injecte donc un stub typé implémentant
 * l'interface, plutôt que de mocker le module `undici` (convention plus fidèle
 * au contrat de la fonction et sans effet de bord).
 *
 * Scénarios couverts :
 *   1. Ouverture KO (HTTP >= 400 / erreur réseau) → 3 tentatives puis abandon
 *      (`openSession` retourne `null`), sans mutation d'état (Req 4.1, 4.5, 4.6).
 *   2. HTTP 404 `SESSION_ERROR` → l'ouverture retourne `null` immédiatement
 *      (session traitée comme expirée) ; le RE-BOOTSTRAP complet est ensuite
 *      rejoué par l'appelant avec un NOUVEAU Turnstile #1, et le contexte de
 *      scan (Scan_Window + Excluded_Days) détenu par l'appelant est PRÉSERVÉ
 *      inchangé à travers le re-bootstrap (Req 5.3, 5.4). Le re-bootstrap
 *      réussit et rend une session valide.
 *
 * Le backoff exponentiel entre tentatives LOGIQUES utilise de vrais
 * `setTimeout` ; on emploie donc les fake timers de vitest et
 * `vi.runAllTimersAsync()` pour dérouler les délais sans attente réelle.
 *
 * TypeScript strict : aucun `any`. Les compteurs/scripts de réponses sont
 * entièrement typés.
 *
 * Validates: Requirements 4.1, 4.6, 5.3, 5.4
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openSession } from "../france/france-session.js";
import type {
  FranceHttpClient,
} from "../france/france-http.js";
import type {
  FranceAuthState,
  FranceHttpHeadResult,
  FranceHttpResult,
  FranceRequestOptions,
  ReservationSession,
  ScanWindow,
} from "../france/france-types.js";
import {
  FRANCE_MAX_RETRIES,
  FRANCE_SESSION_TTL_MS,
} from "../france/france-config.js";

// ─── Stub configurable du client HTTP France ─────────────────────────────────
//
// On enregistre chaque appel `post` et on renvoie une réponse scriptée. Les
// méthodes non exercées par `openSession` (`get`, `head`) lèvent si appelées,
// pour détecter tout écart de contrat. `updateCsrf`/`authState` sont suivis.

/** Une réponse `post` scriptée : soit un résultat, soit une erreur à lever. */
type PostOutcome<T> =
  | { kind: "result"; value: FranceHttpResult<T> }
  | { kind: "throw"; error: Error };

interface StubHttpClient extends FranceHttpClient {
  /** Chemins des appels `post` observés, dans l'ordre. */
  readonly postPaths: readonly string[];
  /** Corps des appels `post` observés, dans l'ordre. */
  readonly postBodies: readonly unknown[];
  /** Tokens transmis à `updateCsrf`, dans l'ordre. */
  readonly csrfUpdates: readonly string[];
}

/** Corps envoyé par `openSession` (miroir de l'implémentation, SANS sessionId). */
interface OpenSessionBodyShape {
  standaloneServiceName: string;
  captcha: string;
}

/** sessionId (`_id`) par défaut renvoyé par les réponses de succès simulées. */
const STUB_SESSION_ID = "session-id-from-response-0001";

/**
 * Résultat de succès HTTP 200 : la réponse porte le sessionId dans `_id`
 * (contrat réel de l'API — `openSession` l'extrait de la réponse, pas du body).
 */
function okResult(sessionId: string = STUB_SESSION_ID): FranceHttpResult<unknown> {
  return { status: 200, ok: true, body: { _id: sessionId }, sessionError: false, teapot: false };
}

/** Résultat d'échec HTTP >= 400 (sans SESSION_ERROR). */
function failResult(status: number): FranceHttpResult<unknown> {
  return { status, ok: false, body: null, sessionError: false, teapot: false };
}

/** Résultat 404 `SESSION_ERROR`. */
function sessionErrorResult(): FranceHttpResult<unknown> {
  return { status: 404, ok: false, body: null, sessionError: true, teapot: false };
}

/**
 * Construit un stub `FranceHttpClient` dont `post` consomme, dans l'ordre, la
 * liste `outcomes`. Au-delà de la liste, la dernière issue est répétée.
 */
function makeStub(
  auth: FranceAuthState,
  outcomes: readonly PostOutcome<unknown>[],
): StubHttpClient {
  const postPaths: string[] = [];
  const postBodies: unknown[] = [];
  const csrfUpdates: string[] = [];
  const state: FranceAuthState = { ...auth };
  let index = 0;

  const client: StubHttpClient = {
    postPaths,
    postBodies,
    csrfUpdates,
    async post<T>(
      path: string,
      body: unknown,
      _opts?: FranceRequestOptions,
    ): Promise<FranceHttpResult<T>> {
      postPaths.push(path);
      postBodies.push(body);
      const outcome =
        outcomes[Math.min(index, outcomes.length - 1)] ??
        ({ kind: "result", value: okResult() } as PostOutcome<unknown>);
      index += 1;
      if (outcome.kind === "throw") {
        throw outcome.error;
      }
      return outcome.value as FranceHttpResult<T>;
    },
    async get<T>(
      _path: string,
      _opts?: FranceRequestOptions,
    ): Promise<FranceHttpResult<T>> {
      throw new Error("[test] get() ne devrait pas être appelé par openSession");
    },
    async head(
      _path: string,
      _opts?: FranceRequestOptions,
    ): Promise<FranceHttpHeadResult> {
      throw new Error("[test] head() ne devrait pas être appelé par openSession");
    },
    updateCsrf(token: string): void {
      csrfUpdates.push(token);
      state.handshakeToken = token;
    },
    authState(): Readonly<FranceAuthState> {
      return { ...state };
    },
  };
  return client;
}

const BASE_AUTH: FranceAuthState = {
  handshakeToken: "handshake-token-initial",
  appId: "app-id-initial",
};

const TEAM_ID = "6230a987df141cedfef4a188";
const SERVICE_NAME = "Visas";
const NOW_MS = 1_700_000_000_000;

/**
 * Déroule une promesse pilotée par des fake timers : on avance tous les timers
 * (backoff) jusqu'à résolution finale. On boucle tant que des timers restent.
 */
async function resolveWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = promise.finally(() => {
    settled = true;
  });
  // Laisse la première tentative synchrone s'exécuter puis vide les timers.
  while (!settled) {
    await vi.runAllTimersAsync();
    // microtask flush entre deux vagues de timers
    await Promise.resolve();
  }
  return wrapped;
}

describe("openSession — intégration (mocks) — task 6.5", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Scénario 1 : ouverture KO → 3 retries puis abandon ────────────────────
  // Validates: Requirements 4.1, 4.5, 4.6

  it("échec HTTP >= 400 répété → 3 tentatives puis null", async () => {
    const stub = makeStub(BASE_AUTH, [
      { kind: "result", value: failResult(400) },
    ]);

    const result = await resolveWithTimers(
      openSession(stub, TEAM_ID, SERVICE_NAME, "turnstile-token-1", NOW_MS),
    );

    expect(result).toBeNull();
    // FRANCE_MAX_RETRIES tentatives LOGIQUES, une requête post par tentative.
    expect(stub.postPaths).toHaveLength(FRANCE_MAX_RETRIES);
    // Cible d'endpoint correcte (Req 4.1).
    for (const path of stub.postPaths) {
      expect(path).toBe(`/team/${TEAM_ID}/reservations-session`);
    }
    // Aucun csrf mis à jour (aucun succès).
    expect(stub.csrfUpdates).toHaveLength(0);
  });

  it("erreurs réseau répétées (throw) → 3 tentatives puis null", async () => {
    const stub = makeStub(BASE_AUTH, [
      { kind: "throw", error: new Error("fetch failed") },
    ]);

    const result = await resolveWithTimers(
      openSession(stub, TEAM_ID, SERVICE_NAME, "turnstile-token-1", NOW_MS),
    );

    expect(result).toBeNull();
    expect(stub.postPaths).toHaveLength(FRANCE_MAX_RETRIES);
  });

  it("corps d'ouverture envoyé conforme : { standaloneServiceName, captcha } SANS sessionId", async () => {
    const stub = makeStub(BASE_AUTH, [
      { kind: "result", value: failResult(500) },
    ]);

    await resolveWithTimers(
      openSession(stub, TEAM_ID, SERVICE_NAME, "turnstile-abc", NOW_MS),
    );

    expect(stub.postBodies.length).toBeGreaterThan(0);
    const body = stub.postBodies[0] as OpenSessionBodyShape & { sessionId?: unknown };
    expect(body.standaloneServiceName).toBe(SERVICE_NAME);
    expect(body.captcha).toBe("turnstile-abc");
    // CONTRAT CRITIQUE (validé live) : AUCUN sessionId dans le body — un
    // sessionId envoyé fait répondre l'API HTTP 404.
    expect("sessionId" in body).toBe(false);
    expect(body.sessionId).toBeUndefined();
  });

  it("un succès APRÈS des échecs (< 3 tentatives) → session ouverte", async () => {
    const stub = makeStub(BASE_AUTH, [
      { kind: "result", value: failResult(503) },
      { kind: "result", value: okResult() },
    ]);

    const result = await resolveWithTimers(
      openSession(stub, TEAM_ID, SERVICE_NAME, "turnstile-token-1", NOW_MS),
    );

    expect(result).not.toBeNull();
    const session = result as ReservationSession;
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(session.openedAtMs).toBe(NOW_MS);
    expect(session.ttlMs).toBe(FRANCE_SESSION_TTL_MS);
    // 2 tentatives : 1 échec + 1 succès.
    expect(stub.postPaths).toHaveLength(2);
  });

  // ─── Scénario 2 : 404 SESSION_ERROR → re-bootstrap en préservant le contexte ─
  // Validates: Requirements 5.3, 5.4

  it("404 SESSION_ERROR → openSession retourne null immédiatement (1 seule tentative)", async () => {
    const stub = makeStub(BASE_AUTH, [
      { kind: "result", value: sessionErrorResult() },
    ]);

    const result = await resolveWithTimers(
      openSession(stub, TEAM_ID, SERVICE_NAME, "turnstile-token-1", NOW_MS),
    );

    expect(result).toBeNull();
    // SESSION_ERROR = abandon immédiat, PAS de retry logique (Req 5.3).
    expect(stub.postPaths).toHaveLength(1);
  });

  it("re-bootstrap complet après SESSION_ERROR en préservant window/excludeDays", async () => {
    // Contexte de scan détenu par l'appelant (l'orchestrateur), qui doit être
    // préservé inchangé à travers le re-bootstrap (Req 5.4).
    const scanWindow: ScanWindow = { start: "2026-09-01", end: "2026-09-30" };
    const excludeDays = new Set<string>(["2026-09-06", "2026-09-07"]);
    const windowSnapshot: ScanWindow = { ...scanWindow };
    const excludeSnapshot = new Set<string>(excludeDays);

    // Étape A — première session touchée par SESSION_ERROR → null.
    const stubExpired = makeStub(BASE_AUTH, [
      { kind: "result", value: sessionErrorResult() },
    ]);
    const firstToken = "turnstile-session-1";
    const expired = await resolveWithTimers(
      openSession(stubExpired, TEAM_ID, SERVICE_NAME, firstToken, NOW_MS),
    );
    expect(expired).toBeNull();

    // Le contexte de scan n'a PAS été muté par l'échec d'ouverture.
    expect(scanWindow).toEqual(windowSnapshot);
    expect([...excludeDays].sort()).toEqual([...excludeSnapshot].sort());

    // Étape B — re-bootstrap : NOUVEAU Turnstile #1 distinct, nouvelle session.
    const rebootstrapToken = "turnstile-session-2";
    expect(rebootstrapToken).not.toBe(firstToken);
    const nowAfter = NOW_MS + 5_000;
    const stubReopen = makeStub(BASE_AUTH, [
      { kind: "result", value: okResult() },
    ]);
    const reopened = await resolveWithTimers(
      openSession(stubReopen, TEAM_ID, SERVICE_NAME, rebootstrapToken, nowAfter),
    );

    // Nouvelle session valide obtenue.
    expect(reopened).not.toBeNull();
    const session = reopened as ReservationSession;
    expect(session.sessionId.length).toBeGreaterThan(0);
    expect(session.openedAtMs).toBe(nowAfter);
    expect(session.ttlMs).toBe(FRANCE_SESSION_TTL_MS);

    // Le nouveau Turnstile #1 a bien été placé dans le champ captcha.
    const reopenBody = stubReopen.postBodies[0] as OpenSessionBodyShape;
    expect(reopenBody.captcha).toBe(rebootstrapToken);

    // Contexte de scan TOUJOURS préservé après le re-bootstrap (Req 5.4).
    expect(scanWindow).toEqual(windowSnapshot);
    expect([...excludeDays].sort()).toEqual([...excludeSnapshot].sort());
  });

  it("re-bootstrap : nouveau sessionId distinct de l'ancien contexte de session", async () => {
    // Ancienne session (celle rejetée par SESSION_ERROR).
    const stale: ReservationSession = {
      sessionId: "stale-session-id",
      openedAtMs: NOW_MS - FRANCE_SESSION_TTL_MS,
      ttlMs: FRANCE_SESSION_TTL_MS,
    };

    const stubReopen = makeStub(BASE_AUTH, [
      { kind: "result", value: okResult("fresh-session-id-9999") },
    ]);
    const reopened = await resolveWithTimers(
      openSession(stubReopen, TEAM_ID, SERVICE_NAME, "turnstile-fresh", NOW_MS),
    );

    expect(reopened).not.toBeNull();
    const session = reopened as ReservationSession;
    // Le sessionId provient de la réponse (`_id`) et ne réutilise pas le stale.
    expect(session.sessionId).toBe("fresh-session-id-9999");
    expect(session.sessionId).not.toBe(stale.sessionId);
  });

  it("csrf mis à jour depuis la réponse de session lorsqu'un handshake est fourni", async () => {
    const stub = makeStub(BASE_AUTH, [
      {
        kind: "result",
        value: {
          status: 200,
          ok: true,
          body: { _id: "sess-with-handshake", handshake: "new-handshake-token" },
          sessionError: false,
          teapot: false,
        },
      },
    ]);

    const result = await resolveWithTimers(
      openSession(stub, TEAM_ID, SERVICE_NAME, "turnstile-token-1", NOW_MS),
    );

    expect(result).not.toBeNull();
    expect(stub.csrfUpdates).toEqual(["new-handshake-token"]);
  });
});
