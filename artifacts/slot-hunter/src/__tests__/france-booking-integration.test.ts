/**
 * france-booking-integration.test.ts — Tests d'intégration du flux de booking
 * multistep France (feature france-visa-hunter, task 10.6).
 *
 * Cible : `runBookingFlow` de `src/france/france-booking.ts`, exercée via un
 * STUB du client HTTP (`FranceHttpClient`) — aucun réseau/proxy réel.
 * `runBookingFlow` reçoit le client en paramètre : on injecte donc un stub typé
 * implémentant l'interface, plutôt que de mocker le module `undici` (convention
 * identique à `france-session-integration.test.ts`, plus fidèle au contrat de la
 * fonction et sans effet de bord).
 *
 * Scénarios couverts :
 *   1. Étape en erreur (une réponse `update-step-value` renvoie `ok=false`,
 *      statut >= 400) → interruption SANS `POST reservations/family`, résultat
 *      `{success:false, failedStep, failedStepIndex}` et log `[franceHunter]`
 *      identifiant l'étape et son `stepIndex` (Req 10.3).
 *   2. Contact invalide → arrêt AVANT tout appel réseau (aucun
 *      `update-step-value`, aucun envoi final) (Req 10.5).
 *   3. Motif hors liste → arrêt AVANT tout appel réseau (Req 10.7).
 *   4. `qrCodes` absent dans la réponse finale → booking échoué, session
 *      préservée, AUCUNE nouvelle tentative automatique (un seul envoi final)
 *      (Req 10.12).
 *
 * `runBookingFlow` n'utilise pas de `setTimeout` en propre (les retries/backoff
 * sont internes au client réel, ici stubbé) : pas besoin de fake timers.
 *
 * TypeScript strict : aucun `any`. Le stub et les scripts de réponses sont
 * entièrement typés.
 *
 * Validates: Requirements 10.3, 10.5, 10.7, 10.12
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBookingFlow } from "../france/france-booking.js";
import type { FranceHttpClient } from "../france/france-http.js";
import type {
  BookingContact,
  BookingContext,
  FranceAuthState,
  FranceHttpHeadResult,
  FranceHttpResult,
  FranceRequestOptions,
  SlotToKeep,
} from "../france/france-types.js";

// ─── Stub configurable du client HTTP France ─────────────────────────────────
//
// On enregistre chaque appel `post` (chemin + corps) et on renvoie une réponse
// scriptée en fonction du chemin ciblé. Les méthodes non exercées par
// `runBookingFlow` (`get`, `head`) lèvent si appelées, pour détecter tout écart
// de contrat.

/** Une réponse `post` scriptée : soit un résultat, soit une erreur à lever. */
type PostOutcome<T> =
  | { kind: "result"; value: FranceHttpResult<T> }
  | { kind: "throw"; error: Error };

/** Un appel `post` observé (chemin + corps), dans l'ordre. */
interface RecordedPost {
  path: string;
  body: unknown;
}

interface StubHttpClient extends FranceHttpClient {
  /** Appels `post` observés, dans l'ordre. */
  readonly posts: readonly RecordedPost[];
}

/**
 * Sélecteur de réponse `post` : reçoit le chemin et l'index d'appel courant,
 * retourne l'issue à appliquer.
 */
type PostRouter = (path: string, callIndex: number) => PostOutcome<unknown>;

/** Résultat de succès HTTP 200 générique porté par un corps arbitraire. */
function okResult(body: unknown = null): FranceHttpResult<unknown> {
  return { status: 200, ok: true, body, sessionError: false, teapot: false };
}

/** Résultat d'échec HTTP >= 400 (sans SESSION_ERROR). */
function failResult(status: number): FranceHttpResult<unknown> {
  return { status, ok: false, body: null, sessionError: false, teapot: false };
}

/**
 * Construit un stub `FranceHttpClient` dont `post` délègue à `router` la
 * sélection de l'issue à retourner (par chemin / index d'appel).
 */
function makeStub(auth: FranceAuthState, router: PostRouter): StubHttpClient {
  const posts: RecordedPost[] = [];
  const state: FranceAuthState = { ...auth };
  let callIndex = 0;

  const client: StubHttpClient = {
    posts,
    async post<T>(
      path: string,
      body: unknown,
      _opts?: FranceRequestOptions,
    ): Promise<FranceHttpResult<T>> {
      posts.push({ path, body });
      const outcome = router(path, callIndex);
      callIndex += 1;
      if (outcome.kind === "throw") {
        throw outcome.error;
      }
      return outcome.value as FranceHttpResult<T>;
    },
    async get<T>(
      _path: string,
      _opts?: FranceRequestOptions,
    ): Promise<FranceHttpResult<T>> {
      throw new Error("[test] get() ne devrait pas être appelé par runBookingFlow");
    },
    async head(
      _path: string,
      _opts?: FranceRequestOptions,
    ): Promise<FranceHttpHeadResult> {
      throw new Error("[test] head() ne devrait pas être appelé par runBookingFlow");
    },
    updateCsrf(token: string): void {
      state.handshakeToken = token;
    },
    authState(): Readonly<FranceAuthState> {
      return { ...state };
    },
  };
  return client;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_AUTH: FranceAuthState = {
  handshakeToken: "handshake-token-initial",
  appId: "app-id-initial",
};

const TEAM_ID = "6230a987df141cedfef4a188";
const SESSION_ID = "session-abc-123";
const SERVICE_NAME = "Visas";

const STEP_PATH = `/team/${TEAM_ID}/reservations-session/${SESSION_ID}/update-step-value`;
const DYN_PATH = `/team/${TEAM_ID}/reservations-session/${SESSION_ID}/update-dynamic-steps`;
const FAMILY_PATH = `/team/${TEAM_ID}/reservations/family`;

/** Contact valide (toutes bornes respectées). */
function validContact(): BookingContact {
  return {
    firstname: "Jean",
    lastname: "Dupont",
    email: "jean.dupont@example.com",
    mobile: "+33123456789",
    birthdate: { month: 5, day: 15, year: 1990 },
  };
}

/** Slot valide bien formé. */
function validSlot(): SlotToKeep {
  return {
    slotValue: "slot-visas-2026-09-15-09-30",
    date: "2026-09-15T09:30:00",
    time: "09:30",
    serviceName: SERVICE_NAME,
    rate: "0.00",
    capacity: 1,
  };
}

/** Contexte de booking complet et valide (contact + motif conformes). */
function validContext(overrides: Partial<BookingContext> = {}): BookingContext {
  return {
    teamId: TEAM_ID,
    sessionId: SESSION_ID,
    service: { serviceId: "svc-1", serviceName: SERVICE_NAME },
    contact: validContact(),
    motifKey: "54cfd964c63f3386",
    motif: "Etudiant",
    slot: validSlot(),
    captchaToken: "turnstile-booking-token",
    ...overrides,
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("runBookingFlow — intégration (mocks) — task 10.6", () => {
  beforeEach(() => {
    // Silence les logs [franceHunter] (error/log) tout en permettant l'assertion.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Scénario 1 : étape en erreur → pas d'envoi final ─────────────────────
  // Validates: Requirements 10.3

  it("une étape update-step-value renvoie >= 400 → interruption sans reservations/family", async () => {
    // L'étape « slots » (stepIndex 2) échoue en HTTP 400. On échoue le 3e POST
    // update-step-value (services=0, important-info=1, slots=2). L'appel
    // update-dynamic-steps qui précède slots est routé séparément (DYN_PATH).
    let stepCount = 0;
    const stub = makeStub(BASE_AUTH, (path) => {
      if (path === DYN_PATH) {
        return { kind: "result", value: okResult() };
      }
      if (path === STEP_PATH) {
        stepCount += 1;
        // 3e appel step = slots → échec.
        if (stepCount === 3) {
          return { kind: "result", value: failResult(400) };
        }
        return { kind: "result", value: okResult() };
      }
      return { kind: "result", value: okResult({ data: { qrCodes: ["x"] } }) };
    });

    const result = await runBookingFlow(stub, validContext());

    expect(result.success).toBe(false);
    // L'étape « slots » (stepIndex 2) est identifiée comme responsable.
    expect(result.failedStep).toBe("slots");
    expect(result.failedStepIndex).toBe(2);

    // Aucun appel à reservations/family (interruption avant l'envoi final).
    const familyCalls = stub.posts.filter((p) => p.path === FAMILY_PATH);
    expect(familyCalls).toHaveLength(0);

    // Persistance interrompue à l'étape en échec : 3 appels update-step-value
    // (services, important-info, slots ; slots échoue) + 1 update-dynamic-steps.
    const stepCalls = stub.posts.filter((p) => p.path === STEP_PATH);
    expect(stepCalls).toHaveLength(3);
    const dynCalls = stub.posts.filter((p) => p.path === DYN_PATH);
    expect(dynCalls).toHaveLength(1);

    // Un log d'erreur [franceHunter] identifiant l'étape et son stepIndex.
    const errorSpy = vi.mocked(console.error);
    const logged = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("[franceHunter]");
    expect(logged).toContain("slots");
    expect(logged).toContain("stepIndex 2");
  });

  it("une exception réseau sur une étape → interruption sans reservations/family", async () => {
    // services est la 1re étape persistée (index 0 depuis la suppression de welcome).
    const FAILING_CALL_INDEX = 0;
    const stub = makeStub(BASE_AUTH, (path, callIndex) => {
      if (path === STEP_PATH && callIndex === FAILING_CALL_INDEX) {
        return { kind: "throw", error: new Error("fetch failed") };
      }
      return { kind: "result", value: okResult() };
    });

    const result = await runBookingFlow(stub, validContext());

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe("services");
    expect(result.failedStepIndex).toBe(0);
    expect(stub.posts.filter((p) => p.path === FAMILY_PATH)).toHaveLength(0);
  });

  // ─── Scénario 2 : contact invalide → arrêt avant tout appel réseau ────────
  // Validates: Requirements 10.5

  it("contact invalide (email sans domaine) → arrêt avant envoi, aucun appel réseau", async () => {
    const stub = makeStub(BASE_AUTH, () => ({
      kind: "result",
      value: okResult(),
    }));

    const badContact = validContact();
    badContact.email = "jean.dupont-sans-domaine";
    const result = await runBookingFlow(stub, validContext({ contact: badContact }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("email");
    // Validation AMONT : aucun update-step-value ni reservations/family.
    expect(stub.posts).toHaveLength(0);
  });

  it("contact invalide (firstname vide) → arrêt avant envoi, aucun appel réseau", async () => {
    const stub = makeStub(BASE_AUTH, () => ({
      kind: "result",
      value: okResult(),
    }));

    const badContact = validContact();
    badContact.firstname = "";
    const result = await runBookingFlow(stub, validContext({ contact: badContact }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("firstname");
    expect(stub.posts).toHaveLength(0);
  });

  // ─── Scénario 3 : motif/clé manquant → arrêt avant tout appel réseau ──────
  // Validates: Requirements 10.7
  //
  // Le motif est SPÉCIFIQUE au service (custom_fields), donc on ne le valide
  // plus contre une liste globale figée. La garde runtime rejette seulement un
  // motif OU une clé de motif VIDE (le custom field Motif est required serveur).

  it("motif ou clé de motif vide → arrêt avant envoi, aucun appel réseau", async () => {
    const stub = makeStub(BASE_AUTH, () => ({
      kind: "result",
      value: okResult(),
    }));

    const ctx = validContext();
    const emptyMotifCtx: BookingContext = { ...ctx, motif: "   " };

    const result = await runBookingFlow(stub, emptyMotifCtx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Motif");
    expect(stub.posts).toHaveLength(0);

    // Une clé de motif vide est également rejetée (aucun appel réseau).
    const emptyKeyCtx: BookingContext = { ...ctx, motifKey: "" };
    const result2 = await runBookingFlow(stub, emptyKeyCtx);
    expect(result2.success).toBe(false);
    expect(result2.error).toContain("Motif");
    expect(stub.posts).toHaveLength(0);
  });

  // ─── Scénario 4 : qrCodes absent → échec, session préservée, pas de retry ──
  // Validates: Requirements 10.12

  it("qrCodes absent dans la réponse finale → booking échoué, un seul envoi final", async () => {
    const stub = makeStub(BASE_AUTH, (path) => {
      if (path === STEP_PATH) {
        return { kind: "result", value: okResult() };
      }
      // reservations/family : réponse 200 SANS data.qrCodes.
      return { kind: "result", value: okResult({ data: {} }) };
    });

    const result = await runBookingFlow(stub, validContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("qrCodes");

    // Les 5 étapes de formulaire ont bien été persistées (welcome + motif exclus).
    expect(stub.posts.filter((p) => p.path === STEP_PATH)).toHaveLength(5);

    // AUCUNE nouvelle tentative automatique : exactement UN envoi final.
    const familyCalls = stub.posts.filter((p) => p.path === FAMILY_PATH);
    expect(familyCalls).toHaveLength(1);

    // Log d'échec avec préservation de session / pas de retry auto.
    const errorSpy = vi.mocked(console.error);
    const logged = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("[franceHunter]");
    expect(logged).toContain("session préservée");
  });

  it("qrCodes vide ([]) dans la réponse finale → booking échoué (aucune nouvelle tentative)", async () => {
    const stub = makeStub(BASE_AUTH, (path) => {
      if (path === STEP_PATH) {
        return { kind: "result", value: okResult() };
      }
      return { kind: "result", value: okResult({ data: { qrCodes: [] } }) };
    });

    const result = await runBookingFlow(stub, validContext());

    expect(result.success).toBe(false);
    expect(stub.posts.filter((p) => p.path === FAMILY_PATH)).toHaveLength(1);
  });

  // ─── Contrôle positif : flux complet réussi ───────────────────────────────

  it("flux nominal complet (5 étapes OK + qrCodes présent) → succès", async () => {
    const stub = makeStub(BASE_AUTH, (path) => {
      if (path === STEP_PATH) {
        return { kind: "result", value: okResult() };
      }
      return {
        kind: "result",
        value: okResult({ data: { qrCodes: ["qr-1"] } }),
      };
    });

    const result = await runBookingFlow(stub, validContext());

    expect(result.success).toBe(true);
    expect(result.qrCodes).toEqual(["qr-1"]);
    expect(stub.posts.filter((p) => p.path === STEP_PATH)).toHaveLength(5);
    expect(stub.posts.filter((p) => p.path === FAMILY_PATH)).toHaveLength(1);
  });
});
