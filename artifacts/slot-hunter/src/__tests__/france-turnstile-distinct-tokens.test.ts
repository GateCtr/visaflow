/**
 * france-turnstile-distinct-tokens.test.ts — Test property-based des deux tokens
 * Turnstile distincts par parcours (feature france-visa-hunter, task 5.3).
 *
 * Cible : `solveFranceTurnstile(purpose, apiKey)` de
 * `src/france/france-turnstile.ts`, qui encapsule `solveTurnstileToken`
 * (CapSolver, proxyless). Le design impose (Requirement 3.3) qu'un parcours
 * complet résolve exactement UN token de type `session` et exactement UN token
 * de type `booking`, ces deux tokens étant distincts (aucune réutilisation).
 *
 * Stratégie : on mocke `solveTurnstileToken` (via `vi.mock`) pour qu'il renvoie
 * un token distinct à chaque appel. On simule alors un parcours complet en
 * appelant `solveFranceTurnstile("session", …)` puis
 * `solveFranceTurnstile("booking", …)`, et on vérifie que :
 *   - un token de session ET un token de booking sont bien obtenus (non vides) ;
 *   - les deux tokens sont distincts ;
 *   - exactement une résolution aboutie a lieu pour `session` et une pour
 *     `booking` (aucun token n'est réutilisé d'une étape à l'autre).
 *
 * Vérifié sur ≥ 100 itérations `fast-check` (`{ numRuns: 100 }`), l'espace des
 * entrées couvrant des paires de tokens arbitraires mais garantis distincts.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { solveFranceTurnstile } from "../france/france-turnstile.js";
import { solveTurnstileToken } from "../capsolver-turnstile.js";
import type { TurnstilePurpose } from "../france/france-types.js";

// Mock du solveur CapSolver bas niveau : chaque appel renverra un token fourni
// par le test (voir `mockDistinctTokens`).
vi.mock("../capsolver-turnstile.js", () => ({
  solveTurnstileToken: vi.fn(),
}));

/** Référence typée vers le mock, pour piloter les valeurs de retour. */
const mockedSolve = vi.mocked(solveTurnstileToken);

/** Clé API factice (jamais journalisée par le wrapper). */
const FAKE_API_KEY = "test-capsolver-key";

/** URL de page RDV factice (websiteURL transmise à CapSolver). */
const FAKE_PAGE_URL = "https://consulat.gouv.fr/ambassade-de-france-a-kinshasa/rendez-vous?name=Visas";

/**
 * Programme le mock pour renvoyer, dans l'ordre, un token de session puis un
 * token de booking (un `{ token }` par appel réussi).
 */
function mockDistinctTokens(sessionToken: string, bookingToken: string): void {
  mockedSolve.mockReset();
  mockedSolve
    .mockResolvedValueOnce({ token: sessionToken })
    .mockResolvedValueOnce({ token: bookingToken });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("solveFranceTurnstile — deux tokens distincts par parcours", () => {
  // Feature: france-visa-hunter, Property 8: Deux tokens Turnstile distincts par
  // parcours — pour tout parcours complet (ouverture de session puis booking),
  // exactement un token de type "session" et un token de type "booking" sont
  // résolus, et ces deux tokens sont distincts (aucune réutilisation).
  // Validates: Requirements 3.3
  it("résout un token session et un token booking distincts sur un parcours complet", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Deux tokens non vides et garantis distincts (paire triée d'un set de 2).
        fc
          .set(fc.string({ minLength: 1, maxLength: 64 }), {
            minLength: 2,
            maxLength: 2,
          })
          .map(([a, b]): [string, string] => [a, b]),
        async ([sessionToken, bookingToken]) => {
          mockDistinctTokens(sessionToken, bookingToken);

          const session = await solveFranceTurnstile("session", FAKE_API_KEY, FAKE_PAGE_URL);
          const booking = await solveFranceTurnstile("booking", FAKE_API_KEY, FAKE_PAGE_URL);

          // Un token pour chaque étape, non vide.
          expect(typeof session).toBe("string");
          expect(typeof booking).toBe("string");
          expect(session).toBe(sessionToken);
          expect(booking).toBe(bookingToken);

          // Les deux tokens sont distincts (pas de réutilisation).
          expect(session).not.toBe(booking);

          // Exactement 2 résolutions abouties : une par étape.
          expect(mockedSolve).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: france-visa-hunter, Property 8: chaque appel passe bien le "purpose"
  // attendu — le wrapper n'échange pas les rôles session/booking.
  // Validates: Requirements 3.3
  it("appelle le solveur exactement une fois par purpose, sans réutiliser le token", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .set(fc.string({ minLength: 1, maxLength: 64 }), {
            minLength: 2,
            maxLength: 2,
          })
          .map(([a, b]): [string, string] => [a, b]),
        async ([sessionToken, bookingToken]) => {
          mockDistinctTokens(sessionToken, bookingToken);

          const purposes: TurnstilePurpose[] = ["session", "booking"];
          const resolved = new Map<TurnstilePurpose, string | null>();
          for (const purpose of purposes) {
            resolved.set(purpose, await solveFranceTurnstile(purpose, FAKE_API_KEY, FAKE_PAGE_URL));
          }

          // Un token distinct par purpose, aucun partagé.
          const sessionResult = resolved.get("session");
          const bookingResult = resolved.get("booking");
          expect(sessionResult).toBe(sessionToken);
          expect(bookingResult).toBe(bookingToken);
          expect(sessionResult).not.toBe(bookingResult);

          // Le solveur bas niveau a été sollicité une fois par étape.
          expect(mockedSolve).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Exemple ancré : deux tokens concrets, parcours nominal.
  it("exemple : tokens 'sess-abc' et 'book-xyz' restent distincts", async () => {
    mockDistinctTokens("sess-abc", "book-xyz");

    const session = await solveFranceTurnstile("session", FAKE_API_KEY, FAKE_PAGE_URL);
    const booking = await solveFranceTurnstile("booking", FAKE_API_KEY, FAKE_PAGE_URL);

    expect(session).toBe("sess-abc");
    expect(booking).toBe("book-xyz");
    expect(session).not.toBe(booking);
    expect(mockedSolve).toHaveBeenCalledTimes(2);
  });
});
