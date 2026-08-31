/**
 * spain-worker-classify.test.ts — Tests unitaires + property-based pour
 * `classify` (feature spain-synchronized-scan, task 3.2).
 *
 * Tests couverts :
 *   - Property 7 : Classification totale — ∀ scan, classify(scan) ∈ FailureKind
 *                  (jamais undefined), exactement un kind par scan.
 *                  (Validates: Requirements 4.1)
 *   - Table de cas exhaustive status → FailureKind : proxy_error, cf_expired,
 *     session_dead, not_found, error (5xx / non-5xx), statut inconnu/nul/absent/
 *     vide → proxy_dead + warning.
 *     (Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9)
 */

import fc from "fast-check";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import { classify } from "../spain/spain-worker-state-machine.js";
import type { FailureKind } from "../spain/spain-grid-config.js";
import type { WorkerScanResult } from "../spain-dossier-worker.js";

// ─── Ensemble fermé des FailureKind valides (miroir du type sous test) ───────

const FAILURE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "proxy_dead",
  "http_5xx",
  "session_dead",
  "cf_expired",
  "agenda_empty",
]);

/**
 * Construit un WorkerScanResult à partir d'un statut arbitraire (potentiellement
 * hors du type déclaré) et d'un message d'erreur optionnel. `classify` lit
 * `status` comme `unknown` en interne, on peut donc lui fournir des valeurs
 * volontairement invalides via un cast unique et localisé (pas de `any`).
 */
function makeScan(status: unknown, errorMessage?: string): WorkerScanResult {
  return { status, errorMessage } as unknown as WorkerScanResult;
}

// ─── Setup / teardown : silence + espionnage des logs ────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Table de cas exhaustive status → FailureKind (Req 4.2–4.7) ──────────────

describe("classify — table de cas status → FailureKind", () => {
  interface StatusCase {
    readonly label: string;
    readonly status: string;
    readonly errorMessage?: string;
    readonly expected: FailureKind;
    readonly expectsWarn: boolean;
  }

  const cases: readonly StatusCase[] = [
    // — statuts directement mappés (Req 4.2, 4.5, 4.6, 4.7) —
    { label: "proxy_error → proxy_dead", status: "proxy_error", expected: "proxy_dead", expectsWarn: false },
    { label: "cf_expired → cf_expired", status: "cf_expired", expected: "cf_expired", expectsWarn: false },
    { label: "session_dead → session_dead", status: "session_dead", expected: "session_dead", expectsWarn: false },
    { label: "not_found → agenda_empty", status: "not_found", expected: "agenda_empty", expectsWarn: false },

    // — error avec code HTTP 5xx → http_5xx (Req 4.3) —
    { label: "error + 500 → http_5xx", status: "error", errorMessage: "HTTP 500 Internal Server Error", expected: "http_5xx", expectsWarn: false },
    { label: "error + 502 → http_5xx", status: "error", errorMessage: "upstream 502", expected: "http_5xx", expectsWarn: false },
    { label: "error + 503 → http_5xx", status: "error", errorMessage: "503 Service Unavailable", expected: "http_5xx", expectsWarn: false },
    { label: "error + 599 → http_5xx (borne haute)", status: "error", errorMessage: "gateway 599", expected: "http_5xx", expectsWarn: false },

    // — error sans code 5xx → proxy_dead (Req 4.4) —
    { label: "error sans message → proxy_dead", status: "error", expected: "proxy_dead", expectsWarn: false },
    { label: "error + 404 → proxy_dead", status: "error", errorMessage: "HTTP 404 Not Found", expected: "proxy_dead", expectsWarn: false },
    { label: "error + 499 → proxy_dead (borne basse exclue)", status: "error", errorMessage: "code 499", expected: "proxy_dead", expectsWarn: false },
    { label: "error + 600 → proxy_dead (au-delà de 5xx)", status: "error", errorMessage: "weird 600", expected: "proxy_dead", expectsWarn: false },
    { label: "error + timeout → proxy_dead", status: "error", errorMessage: "ETIMEDOUT connexion", expected: "proxy_dead", expectsWarn: false },

    // — statuts non reconnus / inattendus → proxy_dead + warning (Req 4.9) —
    { label: "found (succès inattendu) → proxy_dead + warn", status: "found", expected: "proxy_dead", expectsWarn: true },
    { label: "ajax_unavailable → proxy_dead + warn", status: "ajax_unavailable", expected: "proxy_dead", expectsWarn: true },
    { label: "statut inconnu → proxy_dead + warn", status: "zzz_unknown", expected: "proxy_dead", expectsWarn: true },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const result = classify(makeScan(c.status, c.errorMessage));
      expect(result).toBe(c.expected);
      if (c.expectsWarn) {
        expect(warnSpy).toHaveBeenCalled();
        // Le warning doit nommer le statut reçu (Req 4.9).
        const named = warnSpy.mock.calls.some((args: readonly unknown[]) =>
          typeof args[0] === "string" && args[0].includes(c.status),
        );
        expect(named).toBe(true);
      } else {
        expect(warnSpy).not.toHaveBeenCalled();
      }
    });
  }
});

// ─── Statuts nul / absent / vide → proxy_dead + warning (Req 4.9) ────────────

describe("classify — statut nul / absent / vide (Req 4.9)", () => {
  it("status null → proxy_dead + warning", () => {
    expect(classify(makeScan(null))).toBe("proxy_dead");
    expect(warnSpy).toHaveBeenCalled();
    const named = warnSpy.mock.calls.some((args: readonly unknown[]) =>
      typeof args[0] === "string" && args[0].includes("null"),
    );
    expect(named).toBe(true);
  });

  it("status absent (undefined) → proxy_dead + warning", () => {
    expect(classify(makeScan(undefined))).toBe("proxy_dead");
    expect(warnSpy).toHaveBeenCalled();
    const named = warnSpy.mock.calls.some((args: readonly unknown[]) =>
      typeof args[0] === "string" && args[0].includes("undefined"),
    );
    expect(named).toBe(true);
  });

  it("status vide ('') → proxy_dead + warning", () => {
    expect(classify(makeScan(""))).toBe("proxy_dead");
    expect(warnSpy).toHaveBeenCalled();
    const named = warnSpy.mock.calls.some((args: readonly unknown[]) =>
      typeof args[0] === "string" && args[0].includes("(empty)"),
    );
    expect(named).toBe(true);
  });

  it("objet scan absent (null) → proxy_dead + warning (défensif)", () => {
    // classify lit scan?.status : un scan null retombe sur status undefined.
    const result = classify(null as unknown as WorkerScanResult);
    expect(result).toBe("proxy_dead");
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ─── Property 7 : Classification totale (Req 4.1) ────────────────────────────
// Validates: Requirements 4.1
//
// ∀ scan (statut arbitraire, code HTTP arbitraire) :
//   - classify(scan) est toujours défini et appartient à FailureKind ;
//   - la fonction est déterministe (même entrée ⟹ même sortie) ;
//   - un seul kind est retourné (par construction : type de retour unitaire).

describe("Property 7 — Classification totale (Req 4.1)", () => {
  /** Statuts « connus » du type WorkerScanResult + variantes hors type. */
  const statusArb = fc.oneof(
    fc.constantFrom<string>(
      "found",
      "not_found",
      "error",
      "ajax_unavailable",
      "proxy_error",
      "session_dead",
      "cf_expired",
    ),
    fc.string(), // statuts arbitraires / inconnus / vides
  );

  it("∀ scan : classify(scan) ∈ FailureKind et n'est jamais undefined", () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.option(fc.string(), { nil: undefined }),
        (status, errorMessage) => {
          const kind = classify(makeScan(status, errorMessage));
          expect(kind).not.toBeUndefined();
          expect(FAILURE_KINDS.has(kind)).toBe(true);
        },
      ),
    );
  });

  it("∀ scan : classify est déterministe (même entrée ⟹ même kind)", () => {
    fc.assert(
      fc.property(
        statusArb,
        fc.option(fc.string(), { nil: undefined }),
        (status, errorMessage) => {
          const a = classify(makeScan(status, errorMessage));
          const b = classify(makeScan(status, errorMessage));
          expect(b).toBe(a);
        },
      ),
    );
  });

  it("∀ status 'error' + code ∈ [500,599] dans le message ⟹ http_5xx", () => {
    fc.assert(
      fc.property(fc.integer({ min: 500, max: 599 }), (code) => {
        const kind = classify(makeScan("error", `HTTP ${code} failure`));
        expect(kind).toBe("http_5xx");
      }),
    );
  });

  it("∀ status 'error' + code hors [500,599] ⟹ proxy_dead", () => {
    // Codes à 3 chiffres à frontière de mot, hors 500–599.
    const nonServerCode = fc
      .integer({ min: 100, max: 999 })
      .filter((c) => c < 500 || c > 599);
    fc.assert(
      fc.property(nonServerCode, (code) => {
        const kind = classify(makeScan("error", `status ${code}`));
        expect(kind).toBe("proxy_dead");
      }),
    );
  });
});
