/**
 * france-scanner-integration.test.ts — Tests d'intégration (mocks) du scanner
 * France (feature france-visa-hunter, task 8.7).
 *
 * Cibles (fonctions réseau de `france-scanner.ts`) :
 *   - `getInterval(http, teamId, serviceId)`
 *   - `getExcludeDays(http, teamId, serviceId, sessionId)`
 *   - `scanAvailabilityForDay(http, teamId, serviceName, date, sessionId)`
 *   - `scanWindow(http, teamId, service, sessionId, prevExcluded)` (orchestration)
 *
 * Scénarios couverts (à base d'exemples, client HTTP simulé) :
 *   - `get-interval` invalide → interruption du scan (retour `null`) :
 *       • `start`/`end` manquants ou malformés,
 *       • `start > end`,
 *       • statut HTTP >= 400.
 *     _Requirement 6.4_ (et 6.2 pour la validation de fenêtre).
 *   - `exclude-days` non-tableau → interruption du scan (retour `null`).
 *     _Requirement 7.5_.
 *   - agenda `[]` (availability renvoie un tableau vide en HTTP 200) →
 *     poursuite normale : traité comme « aucun créneau ce jour », PAS une
 *     erreur ; le scan global aboutit et le jour figure dans la carte avec `[]`.
 *     _Requirement 8.3_.
 *
 * Le client HTTP est un faux `FranceHttpClient` typé qui route les réponses par
 * chemin (`get-interval`, `exclude-days`, `availability`). Aucun accès réseau
 * réel. TypeScript strict, aucun `any`.
 *
 * Framework : vitest.
 *
 * Validates: Requirements 6.4, 7.5, 8.3
 */

import { describe, expect, it, vi } from "vitest";

import type { FranceHttpClient } from "../france/france-http.js";
import {
  getExcludeDays,
  getInterval,
  scanAvailabilityForDay,
  scanWindow,
} from "../france/france-scanner.js";
import type {
  FranceAuthState,
  FranceHttpHeadResult,
  FranceHttpResult,
  FranceServiceTarget,
  FranceSlot,
} from "../france/france-types.js";

// ─── Faux client HTTP routant par chemin ─────────────────────────────────────

/** Réponse `get-interval` : soit un corps de fenêtre, soit un statut d'erreur. */
type IntervalOutcome =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "http_error"; readonly status: number };

/** Réponse `exclude-days` : soit un corps (tableau ou non), soit une erreur. */
type ExcludeOutcome =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "http_error"; readonly status: number };

/** Réponse `availability` par jour : soit un corps, soit une erreur HTTP. */
type AvailabilityOutcome =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "http_error"; readonly status: number };

interface FakeClientConfig {
  readonly interval?: IntervalOutcome;
  readonly exclude?: ExcludeOutcome;
  /** Réponse `availability` par jour `YYYY-MM-DD` (défaut : agenda `[]`). */
  readonly perDay?: ReadonlyMap<string, AvailabilityOutcome>;
}

/** Construit un `FranceHttpResult` 2xx portant `body`. */
function okResult<T>(body: T): FranceHttpResult<T> {
  return { status: 200, ok: true, body, sessionError: false, teapot: false };
}

/** Construit un `FranceHttpResult` d'erreur HTTP (statut >= 400, `body: null`). */
function errorResult<T>(status: number): FranceHttpResult<T> {
  return { status, ok: false, body: null, sessionError: false, teapot: false };
}

/** Extrait le paramètre `date` d'un chemin `availability?...`. */
function extractDate(path: string): string | null {
  const query = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get("date");
}

/**
 * Construit un `FranceHttpClient` factice, déterministe et synchrone, routant
 * par chemin : `get-interval`, `exclude-days`, `availability`. Tout chemin non
 * prévu lève une erreur explicite (détecte un routage inattendu du scanner).
 */
function makeFakeClient(config: FakeClientConfig): FranceHttpClient {
  const authState: FranceAuthState = { handshakeToken: "csrf-token", appId: "app-id" };

  return {
    async get<T>(path: string): Promise<FranceHttpResult<T>> {
      if (path.includes("/get-interval")) {
        const outcome = config.interval ?? { kind: "ok", body: { start: "2026-01-01", end: "2026-01-01" } };
        return outcome.kind === "ok"
          ? (okResult(outcome.body) as FranceHttpResult<T>)
          : errorResult<T>(outcome.status);
      }
      if (path.includes("/availability")) {
        const date = extractDate(path);
        const outcome = date === null ? undefined : config.perDay?.get(date);
        if (outcome === undefined) {
          // Défaut : agenda vide (HTTP 200, tableau vide).
          return okResult([] as FranceSlot[]) as FranceHttpResult<T>;
        }
        return outcome.kind === "ok"
          ? (okResult(outcome.body) as FranceHttpResult<T>)
          : errorResult<T>(outcome.status);
      }
      throw new Error(`[test] chemin GET inattendu: ${path}`);
    },
    async post<T>(path: string): Promise<FranceHttpResult<T>> {
      if (path.includes("/exclude-days")) {
        const outcome = config.exclude ?? { kind: "ok", body: [] };
        return outcome.kind === "ok"
          ? (okResult(outcome.body) as FranceHttpResult<T>)
          : errorResult<T>(outcome.status);
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

const TEAM_ID = "team-42";
const SESSION_ID = "session-1";
const SERVICE: FranceServiceTarget = {
  serviceId: "svc-id-123",
  serviceName: "Visas long séjour",
};

// Silence les logs d'erreur attendus (le scanner journalise en `[franceHunter]`).
function silenceConsole(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// get-interval invalide → interruption (getInterval / scanWindow → null)
// Validates: Requirements 6.4 (6.2 pour la validation de fenêtre)
// ═══════════════════════════════════════════════════════════════════════════

describe("get-interval invalide → interruption du scan", () => {
  it("retourne null quand start/end sont manquants", async () => {
    silenceConsole();
    const client = makeFakeClient({ interval: { kind: "ok", body: {} } });
    expect(await getInterval(client, TEAM_ID, SERVICE.serviceId)).toBeNull();
    expect(await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID)).toBeNull();
  });

  it("retourne null quand start/end sont malformés (format non YYYY-MM-DD)", async () => {
    silenceConsole();
    const client = makeFakeClient({
      interval: { kind: "ok", body: { start: "01/01/2026", end: "31-12-2026" } },
    });
    expect(await getInterval(client, TEAM_ID, SERVICE.serviceId)).toBeNull();
    expect(await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID)).toBeNull();
  });

  it("retourne null quand start > end", async () => {
    silenceConsole();
    const client = makeFakeClient({
      interval: { kind: "ok", body: { start: "2026-12-31", end: "2026-01-01" } },
    });
    expect(await getInterval(client, TEAM_ID, SERVICE.serviceId)).toBeNull();
    expect(await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID)).toBeNull();
  });

  it("retourne null quand le statut HTTP est >= 400", async () => {
    silenceConsole();
    for (const status of [400, 403, 404, 500]) {
      const client = makeFakeClient({ interval: { kind: "http_error", status } });
      expect(await getInterval(client, TEAM_ID, SERVICE.serviceId)).toBeNull();
      expect(await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID)).toBeNull();
    }
  });

  it("n'appelle jamais exclude-days ni availability quand get-interval échoue", async () => {
    silenceConsole();
    const client = makeFakeClient({ interval: { kind: "ok", body: { start: "bad", end: "bad" } } });
    const postSpy = vi.spyOn(client, "post");
    const getSpy = vi.spyOn(client, "get");

    const result = await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID);

    expect(result).toBeNull();
    // exclude-days est un POST : jamais atteint.
    expect(postSpy).not.toHaveBeenCalled();
    // Seul get-interval a été appelé côté GET (pas d'availability).
    for (const call of getSpy.mock.calls) {
      expect(call[0]).toContain("/get-interval");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// exclude-days non-tableau → interruption (getExcludeDays / scanWindow → null)
// Validates: Requirements 7.5
// ═══════════════════════════════════════════════════════════════════════════

describe("exclude-days non-tableau → interruption du scan", () => {
  const nonArrayBodies: readonly unknown[] = [
    {},
    { days: [] },
    "2026-01-01",
    42,
    null,
    true,
  ];

  it("getExcludeDays retourne null pour toute réponse non-tableau", async () => {
    silenceConsole();
    for (const body of nonArrayBodies) {
      const client = makeFakeClient({ exclude: { kind: "ok", body } });
      const result = await getExcludeDays(client, TEAM_ID, SERVICE.serviceId, SESSION_ID);
      expect(result).toBeNull();
    }
  });

  it("scanWindow retourne null (interruption) quand exclude-days n'est pas un tableau", async () => {
    silenceConsole();
    const client = makeFakeClient({
      interval: { kind: "ok", body: { start: "2026-01-01", end: "2026-01-03" } },
      exclude: { kind: "ok", body: { closed: [] } },
    });
    expect(await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID)).toBeNull();
  });

  it("n'appelle jamais availability quand exclude-days échoue", async () => {
    silenceConsole();
    const client = makeFakeClient({
      interval: { kind: "ok", body: { start: "2026-01-01", end: "2026-01-03" } },
      exclude: { kind: "ok", body: { closed: [] } },
    });
    const getSpy = vi.spyOn(client, "get");

    const result = await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID);

    expect(result).toBeNull();
    // Aucun GET availability déclenché (seul get-interval).
    for (const call of getSpy.mock.calls) {
      expect(call[0]).not.toContain("/availability");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// agenda [] → poursuite normale : « aucun créneau ce jour », pas une erreur
// Validates: Requirements 8.3
// ═══════════════════════════════════════════════════════════════════════════

describe("agenda [] (availability tableau vide, HTTP 200) → poursuite normale", () => {
  it("scanAvailabilityForDay retourne [] (et non null) pour un agenda vide", async () => {
    const client = makeFakeClient({
      perDay: new Map([["2026-01-01", { kind: "ok", body: [] }]]),
    });
    const slots = await scanAvailabilityForDay(
      client,
      TEAM_ID,
      SERVICE.serviceName,
      "2026-01-01",
      SESSION_ID,
    );
    expect(slots).not.toBeNull();
    expect(slots).toEqual([]);
  });

  it("scanWindow aboutit et inclut chaque jour vide avec [] (aucune erreur globale)", async () => {
    const client = makeFakeClient({
      interval: { kind: "ok", body: { start: "2026-01-01", end: "2026-01-03" } },
      exclude: { kind: "ok", body: [] },
      // Tous les jours renvoient un agenda vide.
      perDay: new Map([
        ["2026-01-01", { kind: "ok", body: [] }],
        ["2026-01-02", { kind: "ok", body: [] }],
        ["2026-01-03", { kind: "ok", body: [] }],
      ]),
    });

    const result = await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID);

    expect(result).not.toBeNull();
    const scan = result!;
    // Les 3 jours de la fenêtre sont présents, chacun avec un tableau vide.
    expect(scan.daySlots.size).toBe(3);
    for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
      expect(scan.daySlots.has(day)).toBe(true);
      expect(scan.daySlots.get(day)).toEqual([]);
    }
    // Agenda vide partout → aucune publication détectée.
    expect(scan.publication).toBeNull();
  });

  it("distingue agenda vide (poursuite, []) d'une erreur HTTP (jour omis)", async () => {
    silenceConsole();
    const validSlot: FranceSlot = { time: "09:00", rate: "0.00", capacity: 1 };
    const client = makeFakeClient({
      interval: { kind: "ok", body: { start: "2026-01-01", end: "2026-01-03" } },
      exclude: { kind: "ok", body: [] },
      perDay: new Map<string, AvailabilityOutcome>([
        ["2026-01-01", { kind: "ok", body: [] }], // agenda vide → []
        ["2026-01-02", { kind: "http_error", status: 500 }], // erreur → jour omis
        ["2026-01-03", { kind: "ok", body: [validSlot] }], // créneau réel
      ]),
    });

    const result = await scanWindow(client, TEAM_ID, SERVICE, SESSION_ID);

    expect(result).not.toBeNull();
    const scan = result!;
    // Jour vide présent avec [], jour en erreur omis, jour avec slot présent.
    expect(scan.daySlots.get("2026-01-01")).toEqual([]);
    expect(scan.daySlots.has("2026-01-02")).toBe(false);
    expect(scan.daySlots.get("2026-01-03")).toEqual([validSlot]);
    expect(scan.daySlots.size).toBe(2);
    // Publication détectée sur le jour avec créneau réel.
    expect(scan.publication).not.toBeNull();
    expect(scan.publication?.reason).toBe("availability");
    expect(scan.publication?.day).toBe("2026-01-03");
  });
});
