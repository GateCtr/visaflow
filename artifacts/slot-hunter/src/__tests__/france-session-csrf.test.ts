/**
 * france-session-csrf.test.ts — Tests property-based du sessionId et du CSRF
 * (feature france-visa-hunter, task 6.4).
 *
 * Cibles (fonctions PURES / stateful de `src/france/france-http.ts`) :
 *   - `isValidSessionId(raw)`                         → Property 9 (validation sessionId).
 *   - `createFranceHttpClient(...).updateCsrf(token)` → Property 10 (mise à jour x-csrf-token).
 *
 * Pour Property 10, on construit un client via `createFranceHttpClient` puis, après
 * `updateCsrf(token)`, on vérifie que le x-csrf-token courant vaut la nouvelle valeur,
 * observé à la fois via `authState().handshakeToken` et via `buildRequestHeaders`
 * (header `x-csrf-token` sur les requêtes POST/PUT). Aucun accès réseau n'est réalisé :
 * seules les méthodes locales `updateCsrf`/`authState` sont exercées.
 *
 * Chaque property s'exécute sur ≥ 100 itérations via `fast-check` (`{ numRuns: 100 }`).
 *
 * Validates: Requirements 4.2, 4.3
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildRequestHeaders,
  createFranceHttpClient,
  isValidSessionId,
} from "../france/france-http.js";
import type { FranceAuthState } from "../france/france-types.js";

const NUM_RUNS = 100;

/** Proxy factice : jamais sollicité (aucune requête réseau dans ces tests). */
const DUMMY_PROXY_URL = "http://127.0.0.1:1";

/**
 * Générateur d'un état d'authentification initial arbitraire. Les jetons
 * peuvent être vides : `updateCsrf` doit refléter fidèlement la nouvelle valeur
 * quelle que soit la valeur de départ.
 */
const authStateArb: fc.Arbitrary<FranceAuthState> = fc.record({
  handshakeToken: fc.string(),
  appId: fc.string(),
  rateLimit: fc.option(fc.string(), { nil: undefined }),
});

// ─── Property 9 : validation du sessionId ────────────────────────────────────

describe("isValidSessionId — Property 9 : validation du sessionId", () => {
  // Feature: france-visa-hunter, Property 9: Validation du sessionId —
  // isValidSessionId(raw) est true ssi raw est un objet dont le champ
  // sessionId est une chaîne NON VIDE.
  // Validates: Requirements 4.2
  it("true ssi le champ sessionId est une chaîne non vide", () => {
    fc.assert(
      fc.property(fc.string(), (sessionId) => {
        expect(isValidSessionId({ sessionId })).toBe(sessionId.length > 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 9: Validation du sessionId —
  // rejet des valeurs sessionId non-chaîne (nombre, booléen, objet, null,
  // undefined, tableau) et des enregistrements sans champ sessionId.
  // Validates: Requirements 4.2
  it("false si sessionId absent ou de type non-chaîne", () => {
    const nonStringSessionId = fc.oneof(
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.array(fc.anything()),
      fc.record({ nested: fc.string() }),
    );
    fc.assert(
      fc.property(nonStringSessionId, (sessionId) => {
        expect(isValidSessionId({ sessionId })).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
    // Enregistrement sans champ sessionId du tout.
    expect(isValidSessionId({ other: "x" })).toBe(false);
    expect(isValidSessionId({})).toBe(false);
  });

  // Feature: france-visa-hunter, Property 9: Validation du sessionId —
  // rejet de toute entrée non-objet (chaîne, nombre, booléen, null,
  // undefined, tableau) : aucune donnée non conforme n'est acceptée.
  // Validates: Requirements 4.2
  it("false si l'entrée n'est pas un objet exploitable", () => {
    const nonRecord = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.array(fc.anything()),
    );
    fc.assert(
      fc.property(nonRecord, (raw) => {
        expect(isValidSessionId(raw)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Exemples ancrés.
  it("exemples ancrés", () => {
    expect(isValidSessionId({ sessionId: "abc-123" })).toBe(true);
    expect(isValidSessionId({ sessionId: "" })).toBe(false);
    expect(isValidSessionId({ sessionId: 42 })).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId("abc")).toBe(false);
    expect(isValidSessionId([{ sessionId: "abc" }])).toBe(false);
  });
});

// ─── Property 10 : mise à jour du x-csrf-token depuis la réponse de session ───

describe("updateCsrf — Property 10 : mise à jour du x-csrf-token depuis la réponse de session", () => {
  // Feature: france-visa-hunter, Property 10: Mise à jour du x-csrf-token depuis
  // la réponse de session — après http.updateCsrf(token), le x-csrf-token courant
  // du client (authState().handshakeToken) vaut exactement cette nouvelle valeur.
  // Validates: Requirements 4.3
  it("authState().handshakeToken vaut le token fourni à updateCsrf", () => {
    fc.assert(
      fc.property(authStateArb, fc.string(), (initialAuth, newCsrf) => {
        const http = createFranceHttpClient(initialAuth, DUMMY_PROXY_URL, () =>
          Promise.resolve(null),
        );
        http.updateCsrf(newCsrf);
        expect(http.authState().handshakeToken).toBe(newCsrf);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 10: Mise à jour du x-csrf-token depuis
  // la réponse de session — le header x-csrf-token émis sur les requêtes POST/PUT
  // reflète la nouvelle valeur (buildRequestHeaders lit le handshakeToken courant).
  // Validates: Requirements 4.3
  it("le header x-csrf-token émis sur POST/PUT reflète la valeur mise à jour", () => {
    fc.assert(
      fc.property(authStateArb, fc.string(), (initialAuth, newCsrf) => {
        const http = createFranceHttpClient(initialAuth, DUMMY_PROXY_URL, () =>
          Promise.resolve(null),
        );
        http.updateCsrf(newCsrf);
        const state = http.authState();
        expect(buildRequestHeaders(state, "POST")["x-csrf-token"]).toBe(newCsrf);
        expect(buildRequestHeaders(state, "PUT")["x-csrf-token"]).toBe(newCsrf);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 10: Mise à jour du x-csrf-token depuis
  // la réponse de session — la dernière mise à jour prime (idempotence de la
  // valeur finale sur des updateCsrf successifs).
  // Validates: Requirements 4.3
  it("la dernière valeur fournie à updateCsrf prime sur les précédentes", () => {
    fc.assert(
      fc.property(
        authStateArb,
        fc.array(fc.string(), { minLength: 1, maxLength: 6 }),
        (initialAuth, tokens) => {
          const http = createFranceHttpClient(initialAuth, DUMMY_PROXY_URL, () =>
            Promise.resolve(null),
          );
          for (const token of tokens) {
            http.updateCsrf(token);
          }
          const last = tokens[tokens.length - 1];
          expect(http.authState().handshakeToken).toBe(last);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: france-visa-hunter, Property 10: Mise à jour du x-csrf-token depuis
  // la réponse de session — updateCsrf ne modifie pas l'appId (isolation du csrf).
  // Validates: Requirements 4.3
  it("updateCsrf ne modifie pas l'appId", () => {
    fc.assert(
      fc.property(authStateArb, fc.string(), (initialAuth, newCsrf) => {
        const http = createFranceHttpClient(initialAuth, DUMMY_PROXY_URL, () =>
          Promise.resolve(null),
        );
        http.updateCsrf(newCsrf);
        expect(http.authState().appId).toBe(initialAuth.appId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Exemple ancré.
  it("exemple ancré : updateCsrf remplace bien le handshakeToken initial", () => {
    const http = createFranceHttpClient(
      { handshakeToken: "old-token", appId: "app-1" },
      DUMMY_PROXY_URL,
      () => Promise.resolve(null),
    );
    expect(http.authState().handshakeToken).toBe("old-token");
    http.updateCsrf("new-token");
    expect(http.authState().handshakeToken).toBe("new-token");
  });
});
