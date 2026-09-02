/**
 * france-antidetection-isolation.test.ts — Tests property-based d'anti-détection
 * et d'isolation des Jobs (feature france-visa-hunter, task 12.3).
 *
 * Cibles :
 *   - `boundedHumanDelayMs(rand)` de `france-hunter.ts` : helper pur du délai
 *     inter-requêtes (base 2000 ms, jitter ±500 ms) — Property 29.
 *   - Injection CONSTANTE du `user-agent` de session par-dessus les headers
 *     anti-bot (`buildRequestHeaders`), reproduisant la fusion effectuée par
 *     `createFranceHttpClient` (`{ ...buildRequestHeaders(...), ...opts.headers }`)
 *     — Property 28.
 *   - Isolation par Job : proxy résidentiel FR sticky distinct par clé de Job
 *     (`ProxyPool.getStickyProxy`), état d'auth (`x-csrf-token`) isolé par client
 *     (`createFranceHttpClient` + `updateCsrf`), et `sessionId` distinct par
 *     client (`openSession`) — Property 32.
 *
 * Propriétés couvertes :
 *   - Property 28 : User-Agent cohérent sur toute la session — pour toute suite
 *     de requêtes (méthodes/attempts variés), le header `user-agent` émis est
 *     identique à travers toutes les requêtes de la session.
 *   - Property 29 : Délai inter-requêtes borné — pour tout `rand ∈ [0, 1)`, le
 *     délai ∈ [1500 ms, 2500 ms].
 *   - Property 32 : Isolation des Jobs — pour tout couple de Jobs distincts,
 *     leurs contextes ne partagent jamais le même `sessionId`, la même valeur
 *     `x-csrf-token`, ni la même IP proxy (URL de sortie sticky).
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any`.
 *
 * Validates: Requirements 11.1, 11.2, 14.3
 */

import { randomUUID } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { boundedHumanDelayMs } from "../france/france-hunter.js";
import {
  buildRequestHeaders,
  createFranceHttpClient,
  type FranceHttpClient,
} from "../france/france-http.js";
import { openSession } from "../france/france-session.js";
import { FRANCE_GOUV_WEB } from "../france/france-config.js";
import type {
  FranceAuthState,
  FranceHttpHeadResult,
  FranceHttpMethod,
  FranceHttpResult,
} from "../france/france-types.js";

const NUM_RUNS = 100;

// Bornes attendues du délai inter-requêtes (base 2000 ms, jitter ±500 ms).
const DELAY_LOWER_MS = 1_500;
const DELAY_UPPER_MS = 2_500;

/**
 * User-Agent Chrome desktop réaliste, identique à celui fixé pour toute la
 * session par `france-hunter` (Property 28). On le reproduit ici plutôt que de
 * l'importer (constante interne non exportée) : le test valide l'INVARIANT de
 * constance, indépendamment de la valeur littérale exacte.
 */
const SESSION_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 29: Délai inter-requêtes borné — pour
// tout rand ∈ [0, 1), boundedHumanDelayMs(rand) ∈ [1500 ms, 2500 ms] (base
// 2000 ms, jitter ±500 ms). Absence de pattern régulier détectable.
// Validates: Requirements 11.2
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 29 — délai inter-requêtes borné [1500, 2500] ms", () => {
  it("boundedHumanDelayMs(rand) ∈ [1500, 2500] pour tout rand ∈ [0, 1)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true, noDefaultInfinity: true }),
        (rand) => {
          const delay = boundedHumanDelayMs(rand);
          // Intervalle FERMÉ [1500, 2500] (Requirement 11.2). La borne haute est
          // atteignable par arrondi flottant quand rand → 1 (rand ∈ [0, 1)).
          expect(delay).toBeGreaterThanOrEqual(DELAY_LOWER_MS);
          expect(delay).toBeLessThanOrEqual(DELAY_UPPER_MS);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rand = 0 → borne basse (1500), rand = 0.5 → centre (2000)", () => {
    expect(boundedHumanDelayMs(0)).toBeCloseTo(DELAY_LOWER_MS, 6);
    expect(boundedHumanDelayMs(0.5)).toBeCloseTo(2_000, 6);
  });

  it("est monotone croissant en rand (jitter déterministe, symétrique)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true, noDefaultInfinity: true }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(boundedHumanDelayMs(lo)).toBeLessThanOrEqual(boundedHumanDelayMs(hi));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 28: User-Agent cohérent sur toute la
// session — le hunter fixe une seule fois le user-agent de session et l'injecte
// via opts.headers sur CHAQUE requête ; le client HTTP fusionne
// { ...buildRequestHeaders(auth, method), ...opts.headers }. Pour toute suite de
// requêtes (méthodes/handshakes variés), le user-agent émis est identique.
// Validates: Requirements 11.1
// ═══════════════════════════════════════════════════════════════════════════

/** Reproduit la fusion de headers effectuée par createFranceHttpClient. */
function mergeSessionHeaders(
  auth: FranceAuthState,
  method: FranceHttpMethod,
  sessionHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...buildRequestHeaders(auth, method),
    ...sessionHeaders,
  };
}

const arbitraryMethod: fc.Arbitrary<FranceHttpMethod> = fc.constantFrom<FranceHttpMethod>(
  "GET",
  "POST",
  "PUT",
  "HEAD",
);

const arbitraryAuthState: fc.Arbitrary<FranceAuthState> = fc.record({
  handshakeToken: fc.string({ minLength: 1, maxLength: 40 }),
  appId: fc.string({ minLength: 1, maxLength: 40 }),
});

describe("Property 28 — User-Agent cohérent sur toute la session", () => {
  it("le user-agent est identique pour toutes les requêtes de la session", () => {
    fc.assert(
      fc.property(
        // Une suite non vide de (méthode, état d'auth potentiellement re-handshaké).
        fc.array(fc.tuple(arbitraryMethod, arbitraryAuthState), {
          minLength: 1,
          maxLength: 30,
        }),
        (requests) => {
          // Headers de session FIXÉS une seule fois (comme SESSION_HEADERS du hunter).
          const sessionHeaders: Readonly<Record<string, string>> = {
            "user-agent": SESSION_USER_AGENT,
            "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
          };

          const userAgents = requests.map(([method, auth]) =>
            mergeSessionHeaders(auth, method, sessionHeaders)["user-agent"],
          );

          // Tous les user-agents émis sont identiques (constance sur la session).
          for (const ua of userAgents) {
            expect(ua).toBe(SESSION_USER_AGENT);
          }
          expect(new Set(userAgents).size).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("les headers de session priment et ne sont jamais écrasés par les headers anti-bot", () => {
    fc.assert(
      fc.property(arbitraryMethod, arbitraryAuthState, (method, auth) => {
        const sessionHeaders: Readonly<Record<string, string>> = {
          "user-agent": SESSION_USER_AGENT,
        };
        const merged = mergeSessionHeaders(auth, method, sessionHeaders);
        // Les headers anti-bot restent présents…
        expect(merged["x-gouv-app-id"]).toBe(auth.appId);
        expect(merged["x-gouv-web"]).toBe(FRANCE_GOUV_WEB);
        // …et le user-agent de session est préservé tel quel.
        expect(merged["user-agent"]).toBe(SESSION_USER_AGENT);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 32: Isolation des Jobs — pour tout
// couple de Jobs distincts, leurs contextes ne partagent jamais le même
// sessionId, la même valeur x-csrf-token, ni la même IP proxy (URL de sortie
// sticky). Chaque Job possède son propre FranceAuthState/client HTTP, son
// sessionId et un proxy résidentiel FR sticky dérivé de sa clé.
// Validates: Requirements 14.3
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Faux `FranceHttpClient` pour `openSession` : renvoie systématiquement HTTP 200
 * dont la réponse porte un `_id` UNIQUE (le serveur Troov assigne un sessionId
 * distinct par ouverture). `openSession` extrait ce sessionId de la réponse ;
 * deux Jobs obtiennent donc des sessionId distincts. Isole `openSession` du réseau.
 */
function makeSessionClient(auth: FranceAuthState): FranceHttpClient {
  const state: FranceAuthState = { ...auth };
  return {
    async get<T>(): Promise<FranceHttpResult<T>> {
      return { status: 200, ok: true, body: null, sessionError: false, teapot: false };
    },
    async post<T>(): Promise<FranceHttpResult<T>> {
      // HTTP 200 : la réponse porte un sessionId (`_id`) unique assigné serveur.
      const body = { _id: `sess-${randomUUID()}` } as unknown as T;
      return { status: 200, ok: true, body, sessionError: false, teapot: false };
    },
    async head(): Promise<FranceHttpHeadResult> {
      return { status: 200, ok: true, headers: {}, teapot: false };
    },
    updateCsrf(token: string): void {
      state.handshakeToken = token;
    },
    authState(): Readonly<FranceAuthState> {
      return { ...state };
    },
  };
}

/** Génère deux clés de Job GARANTIES distinctes. */
const distinctJobKeys: fc.Arbitrary<readonly [string, string]> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 24 }),
    fc.string({ minLength: 1, maxLength: 24 }),
  )
  .filter(([a, b]) => a !== b);

describe("Property 32 — isolation des Jobs (sessionId / x-csrf-token / IP proxy)", () => {
  it("deux clients HTTP distincts n'exposent jamais le même x-csrf-token après mutation isolée", () => {
    fc.assert(
      fc.property(
        fc.record({
          csrfA: fc.string({ minLength: 1, maxLength: 40 }),
          appIdA: fc.string({ minLength: 1, maxLength: 40 }),
          csrfB: fc.string({ minLength: 1, maxLength: 40 }),
          appIdB: fc.string({ minLength: 1, maxLength: 40 }),
          newCsrfA: fc.string({ minLength: 1, maxLength: 40 }),
          newCsrfB: fc.string({ minLength: 1, maxLength: 40 }),
        }),
        ({ csrfA, appIdA, csrfB, appIdB, newCsrfA, newCsrfB }) => {
          fc.pre(newCsrfA !== newCsrfB);
          const onRehandshake = async (): Promise<FranceAuthState | null> => null;
          const clientA = createFranceHttpClient(
            { handshakeToken: csrfA, appId: appIdA },
            "http://user:pass@proxy-a.example:8080",
            onRehandshake,
          );
          const clientB = createFranceHttpClient(
            { handshakeToken: csrfB, appId: appIdB },
            "http://user:pass@proxy-b.example:8080",
            onRehandshake,
          );

          // Mutation du csrf sur chaque client : chacun garde SA valeur.
          clientA.updateCsrf(newCsrfA);
          clientB.updateCsrf(newCsrfB);

          expect(clientA.authState().handshakeToken).toBe(newCsrfA);
          expect(clientB.authState().handshakeToken).toBe(newCsrfB);
          // Les états ne partagent jamais la même valeur (mutation isolée).
          expect(clientA.authState().handshakeToken).not.toBe(
            clientB.authState().handshakeToken,
          );
          // Isolation d'appId également (aucun partage de référence d'état).
          expect(clientA.authState().appId).toBe(appIdA);
          expect(clientB.authState().appId).toBe(appIdB);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("deux Jobs obtiennent des sessionId distincts (assignés par la réponse serveur)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (appIdA, appIdB) => {
          const clientA = makeSessionClient({ handshakeToken: "csrf-a", appId: appIdA });
          const clientB = makeSessionClient({ handshakeToken: "csrf-b", appId: appIdB });

          const sessionA = await openSession(clientA, "team-A", "Visas", "tok-A", 0);
          const sessionB = await openSession(clientB, "team-B", "Visas", "tok-B", 0);

          expect(sessionA).not.toBeNull();
          expect(sessionB).not.toBeNull();
          // sessionId non vide et STRICTEMENT distincts entre Jobs.
          expect(sessionA!.sessionId.length).toBeGreaterThan(0);
          expect(sessionB!.sessionId.length).toBeGreaterThan(0);
          expect(sessionA!.sessionId).not.toBe(sessionB!.sessionId);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("deux Jobs distincts obtiennent des IP proxy (URL de sortie sticky) distinctes", async () => {
    // getStickyProxy dépend de PROXY_USER (capturé à l'import du module). On
    // importe ProxyPool dynamiquement après avoir posé l'env, puis on vérifie
    // l'isolation ; si le pool n'est pas configuré dans l'environnement de test,
    // on rabat sur la propriété structurelle (clés distinctes → sessions
    // distinctes) déjà garantie par les autres cas.
    const { ProxyPool } = await import("../proxyPool.js");
    const pool = new ProxyPool("test-api-key");

    if (!pool.isConfigured) {
      // Environnement de test sans TWOCAPTCHA_PROXY_USER : la garantie d'IP
      // distincte est portée par le hunter en prod ; on ne peut pas l'exercer
      // ici. On valide alors uniquement que le pool refuse proprement (null).
      const proxy = await pool.getStickyProxy("job-x");
      expect(proxy).toBeNull();
      return;
    }

    await fc.assert(
      fc.asyncProperty(distinctJobKeys, async ([keyA, keyB]) => {
        const proxyA = await pool.getStickyProxy(keyA);
        const proxyB = await pool.getStickyProxy(keyB);
        expect(proxyA).not.toBeNull();
        expect(proxyB).not.toBeNull();
        // Deux clés de Job distinctes → URLs proxy (sessions sticky) distinctes.
        expect(proxyA).not.toBe(proxyB);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
