/**
 * france-scanner-resilience-jitter.test.ts — Tests property-based de résilience
 * du scan et du jitter de polling (feature france-visa-hunter, task 8.6).
 *
 * Cibles :
 *   - `scanWindow(http, teamId, service, sessionId, prevExcluded)` de
 *     `france-scanner.ts` (boucle de scan complète) — Property 18.
 *   - `computePollingDelay(baseMs, rand)` de `france-scanner.ts`, le helper pur
 *     qui applique le jitter ±20 % réutilisé par la boucle de polling de
 *     `france-hunter` (via `humanBehavior`) — Property 21.
 *
 * Propriétés couvertes :
 *   - Property 18 : Un jour en erreur n'interrompt pas le scan global — pour une
 *     liste de jours scannables dont un sous-ensemble arbitraire produit une
 *     erreur (statut ≠ 200 hors `SESSION_ERROR`, ou DTO non conforme), le
 *     scanner produit un résultat pour chacun des jours restants (aucun jour
 *     valide n'est omis).
 *   - Property 21 : Intervalle de polling borné par le jitter — pour tout
 *     `base > 0`, l'intervalle effectif ∈ [base × 0.8, base × 1.2].
 *
 * Le client HTTP est simulé par un faux `FranceHttpClient` déterministe qui
 * route les réponses par chemin (`get-interval`, `exclude-days`,
 * `availability`) et injecte des erreurs par jour. Cela isole `scanWindow` de
 * tout accès réseau réel tout en respectant l'interface publique du client.
 *
 * Framework : vitest + fast-check, `{ numRuns: 100 }`.
 * TypeScript strict, aucun `any`.
 *
 * Validates: Requirements 8.5, 9.4
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { FranceHttpClient } from "../france/france-http.js";
import {
  computePollingDelay,
  scanWindow,
} from "../france/france-scanner.js";
import type {
  FranceAuthState,
  FranceHttpHeadResult,
  FranceHttpResult,
  FranceServiceTarget,
  FranceSlot,
} from "../france/france-types.js";

const NUM_RUNS = 100;

// ─── Constantes de dates ──────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const MIN_DAY_MS = Date.UTC(2000, 0, 1);
const MAX_DAY_MS = Date.UTC(2035, 11, 31);

/** Formate un timestamp UTC (minuit) en `YYYY-MM-DD`. */
function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Timestamp UTC (minuit) d'un jour dans [MIN_DAY_MS, MAX_DAY_MS]. */
const validDayMs: fc.Arbitrary<number> = fc
  .integer({ min: 0, max: Math.floor((MAX_DAY_MS - MIN_DAY_MS) / MS_PER_DAY) })
  .map((offset) => MIN_DAY_MS + offset * MS_PER_DAY);

/**
 * Fenêtre bornée `{start, end}` (amplitude ≤ 20 jours pour garder les scans
 * rapides) accompagnée de la liste énumérée des jours de la fenêtre.
 */
const boundedWindow: fc.Arbitrary<{ start: string; end: string; days: string[] }> = fc
  .record({
    startMs: validDayMs,
    span: fc.integer({ min: 0, max: 20 }),
  })
  .map(({ startMs, span }) => {
    const endMs = Math.min(startMs + span * MS_PER_DAY, MAX_DAY_MS);
    const days: string[] = [];
    for (let cursor = startMs; cursor <= endMs; cursor += MS_PER_DAY) {
      days.push(formatUtcDay(cursor));
    }
    return { start: formatUtcDay(startMs), end: formatUtcDay(endMs), days };
  });

// ─── Générateur de créneaux valides ──────────────────────────────────────────

const arbitrarySlot: fc.Arbitrary<FranceSlot> = fc.record({
  time: fc
    .integer({ min: 0, max: 23 * 60 + 59 })
    .map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`),
  rate: fc.constant("0.00"),
  capacity: fc.integer({ min: 1, max: 5 }),
});

// ─── Faux client HTTP déterministe ───────────────────────────────────────────

/** Une réponse `availability` pour un jour : soit OK (slots), soit en erreur. */
type DayOutcome =
  | { readonly kind: "ok"; readonly slots: FranceSlot[] }
  | { readonly kind: "http_error"; readonly status: number }
  | { readonly kind: "bad_dto"; readonly body: unknown };

interface FakeClientConfig {
  readonly window: { start: string; end: string };
  readonly excludeDays: string[];
  /** Résultat de `availability` par jour `YYYY-MM-DD`. */
  readonly perDay: ReadonlyMap<string, DayOutcome>;
}

/**
 * Construit un `FranceHttpClient` factice qui répond selon le chemin :
 *   - `get-interval` → fenêtre configurée (HTTP 200).
 *   - `exclude-days` → tableau des jours exclus (HTTP 200).
 *   - `availability?...&date=YYYY-MM-DD...` → réponse par jour (ok/erreur).
 * Toute la logique reste synchrone et déterministe (aucun accès réseau).
 */
function makeFakeClient(config: FakeClientConfig): FranceHttpClient {
  const authState: FranceAuthState = { handshakeToken: "csrf-token", appId: "app-id" };

  function ok<T>(body: T): FranceHttpResult<T> {
    return { status: 200, ok: true, body, sessionError: false, teapot: false };
  }

  function extractDate(path: string): string | null {
    const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
    const params = new URLSearchParams(query);
    return params.get("date");
  }

  return {
    async get<T>(path: string): Promise<FranceHttpResult<T>> {
      if (path.includes("/get-interval")) {
        return ok(config.window) as FranceHttpResult<T>;
      }
      if (path.includes("/availability")) {
        const date = extractDate(path);
        const outcome = date === null ? undefined : config.perDay.get(date);
        if (outcome === undefined || outcome.kind === "ok") {
          const slots = outcome?.kind === "ok" ? outcome.slots : [];
          return ok(slots) as FranceHttpResult<T>;
        }
        if (outcome.kind === "http_error") {
          return {
            status: outcome.status,
            ok: false,
            body: null,
            sessionError: false,
            teapot: false,
          } as FranceHttpResult<T>;
        }
        // bad_dto : HTTP 200 mais corps non conforme → parseSlots renvoie null.
        return ok(outcome.body) as FranceHttpResult<T>;
      }
      throw new Error(`[test] chemin GET inattendu: ${path}`);
    },
    async post<T>(path: string): Promise<FranceHttpResult<T>> {
      if (path.includes("/exclude-days")) {
        return ok([...config.excludeDays]) as FranceHttpResult<T>;
      }
      throw new Error(`[test] chemin POST inattendu: ${path}`);
    },
    async head(): Promise<FranceHttpHeadResult> {
      return { status: 200, ok: true, headers: {}, teapot: false };
    },
    updateCsrf(): void {
      /* no-op */
    },
    authState(): Readonly<FranceAuthState> {
      return authState;
    },
  };
}

const service: FranceServiceTarget = {
  serviceId: "svc-id-123",
  serviceName: "Visas long séjour",
};

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 18: Un jour en erreur n'interrompt pas
// le scan global — pour une liste de jours scannables dont un sous-ensemble
// arbitraire produit une erreur (statut ≠ 200 hors SESSION_ERROR, ou DTO non
// conforme), scanWindow produit un résultat pour chacun des jours restants
// (aucun jour valide omis) et n'échoue pas globalement.
// Validates: Requirements 8.5
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 18 — un jour en erreur n'interrompt pas le scan global", () => {
  it("collecte un résultat pour chaque jour non-erreur, quels que soient les jours en erreur", async () => {
    await fc.assert(
      fc.asyncProperty(
        boundedWindow,
        // Pour chaque jour de la fenêtre : décide s'il est ok / http_error / bad_dto.
        fc.infiniteStream(
          fc.oneof(
            { weight: 5, arbitrary: fc.array(arbitrarySlot, { maxLength: 3 }).map((slots) => ({ kind: "ok", slots }) as DayOutcome) },
            { weight: 2, arbitrary: fc.constantFrom(500, 502, 429, 403).map((status) => ({ kind: "http_error", status }) as DayOutcome) },
            {
              weight: 2,
              arbitrary: fc
                .oneof(fc.constant<unknown>(null), fc.constant<unknown>({}), fc.string(), fc.integer())
                .map((body) => ({ kind: "bad_dto", body }) as DayOutcome),
            },
          ),
        ),
        async ({ start, end, days }, outcomeStream) => {
          const iterator = outcomeStream[Symbol.iterator]();
          const perDay = new Map<string, DayOutcome>();
          const okDays = new Set<string>();
          const errorDays = new Set<string>();
          for (const day of days) {
            const outcome = iterator.next().value as DayOutcome;
            perDay.set(day, outcome);
            if (outcome.kind === "ok") {
              okDays.add(day);
            } else {
              errorDays.add(day);
            }
          }

          const client = makeFakeClient({ window: { start, end }, excludeDays: [], perDay });
          // perDayBaseMs = 0 : pas de pause inter-jour (test déterministe/rapide).
          const result = await scanWindow(client, "team-1", service, "session-1", new Set<string>(), 0);

          // Le scan global ne doit jamais échouer à cause de jours en erreur
          // (interval + exclude-days sont toujours valides ici).
          expect(result).not.toBeNull();
          const daySlots = result!.daySlots;

          // (1) Chaque jour non-erreur produit un résultat présent dans la carte.
          for (const day of okDays) {
            expect(daySlots.has(day)).toBe(true);
            expect(daySlots.get(day)).toEqual(
              (perDay.get(day) as { kind: "ok"; slots: FranceSlot[] }).slots,
            );
          }

          // (2) Aucun jour en erreur n'apparaît dans la carte (omis, pas propagé).
          for (const day of errorDays) {
            expect(daySlots.has(day)).toBe(false);
          }

          // (3) La carte ne contient QUE des jours ok (aucune donnée non validée).
          expect(daySlots.size).toBe(okDays.size);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("produit un résultat même quand TOUS les jours sont en erreur (carte vide, pas d'échec global)", async () => {
    await fc.assert(
      fc.asyncProperty(boundedWindow, async ({ start, end, days }) => {
        const perDay = new Map<string, DayOutcome>();
        for (const day of days) {
          perDay.set(day, { kind: "http_error", status: 500 });
        }
        const client = makeFakeClient({ window: { start, end }, excludeDays: [], perDay });
        const result = await scanWindow(client, "team-1", service, "session-1", new Set<string>(), 0);

        expect(result).not.toBeNull();
        expect(result!.daySlots.size).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Feature: france-visa-hunter, Property 21: Intervalle de polling borné par le
// jitter — pour tout base > 0 et tout rand ∈ [0, 1), computePollingDelay(base,
// rand) ∈ [base × 0.8, base × 1.2]. Le helper pur applique le jitter ±20 %
// réutilisé par la boucle de polling (Requirement 9.4).
// Validates: Requirements 9.4
// ═══════════════════════════════════════════════════════════════════════════

describe("Property 21 — intervalle de polling borné par le jitter ±20 %", () => {
  it("computePollingDelay(base, rand) ∈ [base × 0.8, base × 1.2] pour rand ∈ [0, 1)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 3_600_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true, noDefaultInfinity: true }),
        (base, rand) => {
          const delay = computePollingDelay(base, rand);
          const lower = base * 0.8;
          const upper = base * 1.2;
          // Tolérance flottante minime pour les bornes.
          const eps = base * 1e-9;
          expect(delay).toBeGreaterThanOrEqual(lower - eps);
          expect(delay).toBeLessThanOrEqual(upper + eps);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rand = 0 donne la borne basse (base × 0.8) et rand → 1 approche la borne haute (base × 1.2)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 3_600_000, noNaN: true, noDefaultInfinity: true }),
        (base) => {
          expect(computePollingDelay(base, 0)).toBeCloseTo(base * 0.8, 6);
          // rand = 0.5 → milieu exact = base (jitter symétrique).
          expect(computePollingDelay(base, 0.5)).toBeCloseTo(base, 6);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("est monotone croissant en rand (jitter déterministe)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 3_600_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true, noDefaultInfinity: true }),
        (base, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(computePollingDelay(base, lo)).toBeLessThanOrEqual(
            computePollingDelay(base, hi),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
