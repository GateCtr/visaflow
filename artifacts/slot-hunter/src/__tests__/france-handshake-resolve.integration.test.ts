/**
 * france-handshake-resolve.integration.test.ts — Tests d'intégration (mocks) du
 * handshake anti-bot et de la résolution consulat (feature france-visa-hunter,
 * task 4.5).
 *
 * Couvre les COMPORTEMENTS RÉSEAU (à base de mocks, aucun accès réel) des
 * fonctions de `src/france/france-handshake.ts` et de leur interaction avec le
 * client HTTP de `src/france/france-http.ts` :
 *
 *   - Scénario A — Handshake header absent → retry (jusqu'à 3), puis `null`.
 *     `performHandshake` réémet `HEAD /handshake` tant que les jetons anti-bot
 *     (`x-gouv-handshake` / `x-gouv-app-id`) sont absents ou vides, dans la
 *     limite de 3 tentatives, avant d'abandonner en retournant `null`
 *     (Requirements 1.1, 1.3, 1.5, 1.10).
 *
 *   - Scénario B — HTTP 418 → re-handshake + rejeu de la requête d'origine
 *     (max 3 handshakes). Le client HTTP (`createFranceHttpClient`) déclenche
 *     `onRehandshake()` sur un 418, met à jour l'auth state puis rejoue la
 *     requête. Au-delà de 3 handshakes, il abandonne (`teapot: true`) sans
 *     rejouer indéfiniment (Requirement 1.8).
 *
 *   - Scénario C — Slug introuvable → abandon (`null`) + log `[franceHunter]`.
 *     `resolveTeam` retourne `null` sans muter d'état lorsque la réponse est en
 *     échec (HTTP >= 400) ou que le `teamId` est absent/invalide, en journalisant
 *     une erreur préfixée `[franceHunter]` incluant le slug (Requirements 2.1, 2.3).
 *
 * Approche de mock (conventions des tests frères) :
 *   - `undici.ProxyAgent` est mocké : `performHandshake` et le client HTTP en
 *     instancient un et le passent en `dispatcher` à `fetch` ; le stub évite tout
 *     I/O réseau réel via proxy.
 *   - Le `fetch` global est remplacé par un stub programmable par scénario.
 *   - Les temps de backoff sont neutralisés via fake timers (`vi.useFakeTimers`)
 *     pour garder les tests rapides et déterministes.
 *
 * Validates: Requirements 1.1, 1.8, 2.1, 2.3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock d'undici : ProxyAgent inerte (aucun dispatcher réseau réel) ─────────

vi.mock("undici", () => ({
  ProxyAgent: class {
    // Le constructeur accepte l'URL proxy mais ne fait aucun I/O.
    constructor(_url: string) {
      /* no-op */
    }
  },
}));

import {
  performHandshake,
  resolveTeam,
} from "../france/france-handshake.js";
import { createFranceHttpClient } from "../france/france-http.js";
import type { FranceHttpClient } from "../france/france-http.js";
import type {
  FranceAuthState,
  FranceHttpResult,
} from "../france/france-types.js";

// ─── Constantes de test ───────────────────────────────────────────────────────

const PROXY_URL = "http://user:pass@10.0.0.1:10000";
const HANDSHAKE_HEADER = "x-gouv-handshake";
const APP_ID_HEADER = "x-gouv-app-id";
const HTTP_TEAPOT = 418;

// ─── Fabriques de réponses `fetch` (Response-like) ───────────────────────────

/**
 * Construit un objet Response-like minimal exploitable par le code sous test.
 * `headers` est une vraie instance `Headers` (le code appelle `.forEach`).
 */
function makeResponse(opts: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  const status = opts.status;
  const ok = status >= 200 && status < 300;
  const bodyText = opts.body ?? "";
  return {
    status,
    ok,
    headers,
    text: () => Promise.resolve(bodyText),
    json: () => Promise.resolve(bodyText.length > 0 ? JSON.parse(bodyText) : null),
  } as unknown as Response;
}

/** Programme le `fetch` global avec une suite de réponses (dans l'ordre d'appel). */
function stubFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchMock = vi.fn(() => {
    const resp = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(resp);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Auth state initial (jetons valides), utilisé par le client HTTP. */
function makeAuthState(): FranceAuthState {
  return { handshakeToken: "handshake-token-initial", appId: "app-id-initial" };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Scénario A : handshake absent → retry (max 3) puis null (Req 1.1/1.10) ───

describe("performHandshake — Scénario A : handshake absent → retry puis null (Req 1.1, 1.10)", () => {
  it("réessaie jusqu'à 3 fois puis retourne null quand le header handshake est absent", async () => {
    vi.useFakeTimers();

    // Toutes les réponses HEAD sont HTTP 200 mais SANS jetons anti-bot : le
    // handshake est structurellement invalide → chaque tentative échoue.
    const fetchMock = stubFetchSequence([makeResponse({ status: 200, headers: {} })]);

    const promise = performHandshake(PROXY_URL);
    // Dérouler les backoffs (2000, 4000 ms) sans attendre le temps réel.
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeNull();
    // Exactement 3 tentatives (FRANCE_MAX_RETRIES) de HEAD /handshake.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect(init.method).toBe("HEAD");
    }
    // Abandon journalisé avec le préfixe projet.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("[franceHunter]");
  });

  it("réessaie quand app-id est vide même si le header handshake est présent, puis abandonne", async () => {
    vi.useFakeTimers();

    // handshake présent mais app-id VIDE → invalide (Req 1.5) sur toutes les tentatives.
    const fetchMock = stubFetchSequence([
      makeResponse({
        status: 200,
        headers: { [HANDSHAKE_HEADER]: "tok-abc", [APP_ID_HEADER]: "" },
      }),
    ]);

    const promise = performHandshake(PROXY_URL);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retourne l'auth state dès que le handshake est valide, sans épuiser les retries", async () => {
    vi.useFakeTimers();

    // 1ère tentative invalide (jetons absents), 2ème valide → succès à l'essai 2.
    const fetchMock = stubFetchSequence([
      makeResponse({ status: 200, headers: {} }),
      makeResponse({
        status: 200,
        headers: { [HANDSHAKE_HEADER]: "tok-xyz", [APP_ID_HEADER]: "app-42" },
      }),
    ]);

    const promise = performHandshake(PROXY_URL);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).not.toBeNull();
    expect(result?.handshakeToken).toBe("tok-xyz");
    expect(result?.appId).toBe("app-42");
    // 2 appels : la boucle s'arrête dès la réponse valide (pas de 3ème tentative).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── Scénario B : HTTP 418 → re-handshake + rejeu (max 3) (Req 1.8) ───────────

describe("createFranceHttpClient — Scénario B : HTTP 418 → re-handshake + rejeu (Req 1.8)", () => {
  it("déclenche onRehandshake sur un 418 puis rejoue la requête d'origine avec succès", async () => {
    // 1ère réponse : 418 (handshake absent/invalide) ; 2ème : succès après re-handshake.
    const fetchMock = stubFetchSequence([
      makeResponse({ status: HTTP_TEAPOT, headers: {} }),
      makeResponse({ status: 200, body: JSON.stringify({ teamId: "team-123" }) }),
    ]);

    // Le callback de re-handshake fournit un nouvel auth state (handshake « rafraîchi »).
    const onRehandshake = vi.fn(
      (): Promise<FranceAuthState | null> =>
        Promise.resolve({ handshakeToken: "fresh-token", appId: "fresh-app" }),
    );

    const client = createFranceHttpClient(makeAuthState(), PROXY_URL, onRehandshake);
    const result = await client.get<{ teamId: string }>("/team/slug/some-slug");

    // Le re-handshake a été déclenché exactement une fois, la requête rejouée.
    expect(onRehandshake).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ teamId: "team-123" });
    // L'auth state a bien été mis à jour avec le handshake rafraîchi.
    expect(client.authState().handshakeToken).toBe("fresh-token");
    expect(client.authState().appId).toBe("fresh-app");
  });

  it("abandonne (teapot: true) après le maximum de 3 handshakes sur des 418 répétés", async () => {
    // Toutes les réponses sont des 418 : chaque rejeu retombe sur un 418.
    const fetchMock = stubFetchSequence([makeResponse({ status: HTTP_TEAPOT, headers: {} })]);

    const onRehandshake = vi.fn(
      (): Promise<FranceAuthState | null> =>
        Promise.resolve({ handshakeToken: "fresh-token", appId: "fresh-app" }),
    );

    const client = createFranceHttpClient(makeAuthState(), PROXY_URL, onRehandshake);
    const result = await client.get<unknown>("/team/slug/some-slug");

    // Exactement 3 re-handshakes (MAX_HANDSHAKES), puis abandon.
    expect(onRehandshake).toHaveBeenCalledTimes(3);
    expect(result.teapot).toBe(true);
    expect(result.ok).toBe(false);
    // 1 requête initiale + 3 rejeux (après chaque re-handshake réussi) = 4 fetch.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("abandonne immédiatement (teapot: true) si le re-handshake échoue (retourne null)", async () => {
    const fetchMock = stubFetchSequence([makeResponse({ status: HTTP_TEAPOT, headers: {} })]);

    // Le re-handshake échoue → le client n'a plus de jetons valides, il abandonne.
    const onRehandshake = vi.fn((): Promise<FranceAuthState | null> => Promise.resolve(null));

    const client = createFranceHttpClient(makeAuthState(), PROXY_URL, onRehandshake);
    const result = await client.get<unknown>("/team/slug/some-slug");

    expect(onRehandshake).toHaveBeenCalledTimes(1);
    expect(result.teapot).toBe(true);
    expect(result.ok).toBe(false);
    // 1 requête initiale ; le re-handshake échoué stoppe tout rejeu.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Scénario C : slug introuvable → abandon (null) + log (Req 2.1, 2.3) ──────

describe("resolveTeam — Scénario C : slug introuvable → abandon + log [franceHunter] (Req 2.1, 2.3)", () => {
  /** Construit un client HTTP mocké dont `get` renvoie un résultat programmé. */
  function makeHttpClientReturning(result: FranceHttpResult<unknown>): {
    client: FranceHttpClient;
    get: ReturnType<typeof vi.fn>;
  } {
    const get = vi.fn(() => Promise.resolve(result));
    const client: FranceHttpClient = {
      get: get as FranceHttpClient["get"],
      post: vi.fn() as FranceHttpClient["post"],
      head: vi.fn() as FranceHttpClient["head"],
      updateCsrf: vi.fn(),
      authState: vi.fn(() => makeAuthState()),
    };
    return { client, get };
  }

  it("appelle GET /team/slug/{slug}?lang=fr et retourne { teamId } quand la réponse est valide", async () => {
    const { client, get } = makeHttpClientReturning({
      status: 200,
      ok: true,
      body: { teamId: "team-999" },
      sessionError: false,
      teapot: false,
    });

    const resolved = await resolveTeam(client, "ambassade-de-france-a-kinshasa");

    expect(resolved).toEqual({ teamId: "team-999" });
    // Vérifie le path encodé et le query lang=fr (Req 2.1).
    const [path, opts] = get.mock.calls[0] as [string, { query?: Record<string, string> }];
    expect(path).toBe("/team/slug/ambassade-de-france-a-kinshasa");
    expect(opts?.query).toEqual({ lang: "fr" });
  });

  it("retourne null et journalise [franceHunter] + slug quand le statut est HTTP >= 400", async () => {
    const slug = "consulat-inexistant";
    const { client } = makeHttpClientReturning({
      status: 404,
      ok: false,
      body: null,
      sessionError: false,
      teapot: false,
    });

    const resolved = await resolveTeam(client, slug);

    expect(resolved).toBeNull();
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("[franceHunter]");
    expect(logged).toContain(slug);
  });

  it("retourne null et journalise [franceHunter] + slug quand teamId est absent/invalide (HTTP 200)", async () => {
    const slug = "consulat-sans-teamid";
    const { client } = makeHttpClientReturning({
      status: 200,
      ok: true,
      body: { teamId: "" }, // chaîne vide → invalide (Req 2.2)
      sessionError: false,
      teapot: false,
    });

    const resolved = await resolveTeam(client, slug);

    expect(resolved).toBeNull();
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("[franceHunter]");
    expect(logged).toContain(slug);
  });

  it("retourne null et journalise quand la résolution jette une exception (résilience)", async () => {
    const slug = "consulat-erreur-reseau";
    const get = vi.fn(() => Promise.reject(new Error("boom réseau")));
    const client: FranceHttpClient = {
      get: get as FranceHttpClient["get"],
      post: vi.fn() as FranceHttpClient["post"],
      head: vi.fn() as FranceHttpClient["head"],
      updateCsrf: vi.fn(),
      authState: vi.fn(() => makeAuthState()),
    };

    const resolved = await resolveTeam(client, slug);

    expect(resolved).toBeNull();
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("[franceHunter]");
    expect(logged).toContain(slug);
  });
});
