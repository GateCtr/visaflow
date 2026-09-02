/**
 * france-orchestration-dispatcher.integration.test.ts — Tests d'intégration de
 * l'orchestration `runFranceJob` et du routage dispatcher (feature
 * france-visa-hunter, task 12.4).
 *
 * Deux préoccupations couvertes, entièrement à base de mocks (aucun réseau,
 * proxy, CapSolver ni Convex réel) :
 *
 *   A) Routage dispatcher (Requirement 13.1). Le dispatcher réel vit dans
 *      `src/index.ts`, à l'intérieur de la boucle `main()` qui s'exécute au
 *      moment de l'import et tire un graphe d'imports réseau lourd (Playwright,
 *      impit, CapSolver, Redis, Convex). L'importer ici démarrerait le hunter.
 *      On reproduit donc À L'IDENTIQUE la décision de routage du dispatcher
 *      (mêmes comparaisons de chaînes sur `destination`) dans un helper local
 *      `routeDestination`, et on vérifie que `destination === "france"` route
 *      vers `runFranceJob` (mocké), qui est bien invoqué avec le Job et dont le
 *      résultat est propagé tel quel.
 *
 *   B) Orchestration `runFranceJob` de bout en bout (Requirements 13.2, 13.3).
 *      On mocke les sous-modules du concern France (handshake, turnstile,
 *      session, scanner, booking), la config (`loadFranceEnv`), le proxy
 *      (`proxyPool.getStickyProxy`) et la fabrique de client HTTP
 *      (`createFranceHttpClient`). On exerce alors `runFranceJob` sans réseau :
 *        - Parcours nominal (publication + autoBook + booking OK) → `"slot_found"`.
 *        - Publication détectée sans autoBook → `"slot_found"`.
 *        - Échec de bootstrap (handshake `null`) → `"error"`, sans mutation de
 *          l'état du Job (l'objet Job passé reste inchangé).
 *        - Échec de booking (`qrCodes` absent) → `"error"`, Job inchangé.
 *
 * Le temps réel des `humanGap()`/polling internes est neutralisé via les fake
 * timers de vitest ; on déroule les délais avec `vi.runAllTimersAsync()`.
 *
 * TypeScript strict : aucun `any`. Tous les mocks sont typés via
 * `vi.mocked(...)` et des fabriques de valeurs typées.
 *
 * Validates: Requirements 13.1, 13.2
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HunterJob } from "../convexClient.js";
import type { SessionResult } from "../usaPortal/types.js";
import type {
  BookingResult,
  FranceAuthState,
  FranceEnvConfig,
  ReservationSession,
  SlotPublication,
} from "../france/france-types.js";
import type { FranceScanResult } from "../france/france-scanner.js";

// ─── Mocks des dépendances de `runFranceJob` ─────────────────────────────────
//
// Les sous-modules France sont mockés intégralement. `france-http` conserve
// `maskSecret` réel (fonction pure, non réseau) via importActual, et ne stubbe
// que la fabrique de client HTTP.

vi.mock("../france/france-config.js", () => ({
  loadFranceEnv: vi.fn(),
}));

vi.mock("../browser.js", () => ({
  proxyPool: {
    getStickyProxy: vi.fn(),
  },
}));

vi.mock("../france/france-http.js", async () => {
  const actual =
    await vi.importActual<typeof import("../france/france-http.js")>(
      "../france/france-http.js",
    );
  return {
    ...actual,
    createFranceHttpClient: vi.fn(),
  };
});

vi.mock("../france/france-handshake.js", () => ({
  performHandshake: vi.fn(),
  resolveTeam: vi.fn(),
}));

vi.mock("../france/france-turnstile.js", () => ({
  solveFranceTurnstile: vi.fn(),
  // Helper pur : conservé réel (construit la websiteURL de la page RDV) pour
  // que `runFranceJob` puisse le composer sans exception.
  buildFrancePageUrl: (slug: string, serviceName: string): string =>
    `https://consulat.gouv.fr/${slug}/rendez-vous?name=${encodeURIComponent(serviceName)}`,
}));

vi.mock("../france/france-session.js", () => ({
  openSession: vi.fn(),
  shouldRenewSession: vi.fn(),
}));

vi.mock("../france/france-scanner.js", () => ({
  scanWindow: vi.fn(),
  computePollingDelay: vi.fn(),
}));

vi.mock("../france/france-booking.js", () => ({
  runBookingFlow: vi.fn(),
  buildSlotToKeep: vi.fn(),
  // validateMotif est utilisé par mapJobToFranceConfig : on le garde permissif
  // (tout motif de test est accepté) via un type guard toujours vrai.
  validateMotif: vi.fn(() => true),
}));

// Imports APRÈS les vi.mock (hoistés par vitest).
import { runFranceJob } from "../france/france-hunter.js";
import { loadFranceEnv } from "../france/france-config.js";
import { proxyPool } from "../browser.js";
import { createFranceHttpClient } from "../france/france-http.js";
import { performHandshake, resolveTeam } from "../france/france-handshake.js";
import { solveFranceTurnstile } from "../france/france-turnstile.js";
import { openSession, shouldRenewSession } from "../france/france-session.js";
import { scanWindow, computePollingDelay } from "../france/france-scanner.js";
import { runBookingFlow, buildSlotToKeep } from "../france/france-booking.js";

// ─── Fabriques de valeurs typées ─────────────────────────────────────────────

const FALLBACK_PROXY = "http://user:pass@fr-residential.example:8080";
const STICKY_PROXY = "http://user:pass@fr-sticky.example:8080";
const TEAM_ID = "6230a987df141cedfef4a188";
const NOW_MS = 1_700_000_000_000;

function makeEnv(): FranceEnvConfig {
  return {
    capsolverApiKey: "capsolver-key-xyz",
    proxyUrl: FALLBACK_PROXY,
  };
}

function makeAuthState(): FranceAuthState {
  return { handshakeToken: "handshake-token-abc", appId: "app-id-123" };
}

function makeSession(): ReservationSession {
  return {
    sessionId: "session-uuid-0001",
    openedAtMs: NOW_MS,
    ttlMs: 30 * 60_000,
  };
}

function makeSlot(): { time: string; rate: string; capacity: number } {
  return { time: "09:30", rate: "0.00", capacity: 1 };
}

function makePublicationScan(): FranceScanResult {
  const publication: SlotPublication = {
    reason: "availability",
    day: "2026-09-15",
    slots: [makeSlot()],
  };
  return {
    window: { start: "2026-09-01", end: "2026-09-30" },
    excludeDays: new Set<string>(["2026-09-06"]),
    daySlots: new Map([["2026-09-15", [makeSlot()]]]),
    publication,
  };
}

/**
 * Construit un `HunterJob` de destination `france` avec une `hunterConfig`
 * étendue portant les champs France attendus par `mapJobToFranceConfig`.
 *
 * `mapJobToFranceConfig` lit ces champs de façon défensive via un cast : on les
 * ajoute donc à `hunterConfig` (dont le type est fermé côté `HunterJob`) au
 * travers d'un merge typé, sans `any`.
 */
function makeFranceJob(overrides?: {
  autoBook?: boolean;
  id?: string;
}): HunterJob {
  const franceFields = {
    franceConsulateSlug: "ambassade-de-france-a-kinshasa",
    franceServiceId: "service-id-777",
    franceServiceName: "Visas",
    franceContactFirstname: "Jean",
    franceContactLastname: "Dupont",
    franceContactEmail: "jean.dupont@example.com",
    franceContactMobile: "+243900000000",
    franceBirthMonth: 5,
    franceBirthDay: 12,
    franceBirthYear: 1990,
    franceMotifKey: "54cfd964c63f3386",
    franceMotif: "Tourisme",
    franceAutoBook: overrides?.autoBook ?? true,
    franceScanIntervalMs: 30_000,
  };

  const hunterConfig: HunterJob["hunterConfig"] & typeof franceFields = {
    embassyUsername: "unused",
    embassyPassword: "unused",
    isActive: true,
    ...franceFields,
  };

  return {
    id: overrides?.id ?? "job-france-001",
    destination: "france",
    visaType: "court_sejour",
    applicantName: "Jean Dupont",
    travelDate: "2026-10-01",
    urgencyTier: "standard",
    broadcastVisaClass: null,
    slotBookingRefs: null,
    hunterConfig,
    spainOtpConfig: null,
    portalUrl: null,
    portalName: null,
    portalDashboardUrl: null,
    portalAppointmentUrl: null,
    portalScheduleUrl: null,
    lastCheckAt: null,
  };
}

function makeBookingOk(): BookingResult {
  return { success: true, qrCodes: ["QR-DATA-1"] };
}

function makeBookingFailNoQr(): BookingResult {
  return { success: false, error: "qrCodes absent", failedStep: "confirmation" };
}

/**
 * Déroule une promesse pilotée par des fake timers : avance tous les timers
 * (humanGap/polling) jusqu'à résolution. On boucle tant que la promesse n'est
 * pas réglée (chaque `humanGap` réinstalle un timer).
 */
async function resolveWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = promise.finally(() => {
    settled = true;
  });
  while (!settled) {
    await vi.runAllTimersAsync();
    await Promise.resolve();
  }
  return wrapped;
}

// ─── A) Routage dispatcher — miroir fidèle de src/index.ts ────────────────────
//
// Reproduit EXACTEMENT la cascade de comparaisons du dispatcher (src/index.ts),
// paramétrée par les handlers, pour vérifier la branche France sans importer
// index.ts (qui exécute main() à l'import). `runFranceJob` est le mock ci-dessus.

type DestinationHandlers = {
  schengen: (job: HunterJob) => Promise<SessionResult>;
  spain: (job: HunterJob) => Promise<SessionResult>;
  france: (job: HunterJob) => Promise<SessionResult>;
  default: (job: HunterJob) => Promise<SessionResult>;
};

async function routeDestination(
  job: HunterJob,
  handlers: DestinationHandlers,
): Promise<SessionResult> {
  const destination = job.destination;
  if (destination === "schengen") {
    return handlers.schengen(job);
  } else if (
    destination === "spain" ||
    destination === "espagne" ||
    destination === "es"
  ) {
    return handlers.spain(job);
  } else if (destination === "france") {
    return handlers.france(job);
  } else {
    return handlers.default(job);
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("France — orchestration + routage dispatcher (mocks) — task 12.4", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Valeurs par défaut « heureuses » ; chaque test surcharge au besoin.
    vi.mocked(loadFranceEnv).mockReturnValue(makeEnv());
    vi.mocked(proxyPool.getStickyProxy).mockResolvedValue(STICKY_PROXY);
    vi.mocked(performHandshake).mockResolvedValue(makeAuthState());
    // Client HTTP opaque : `runFranceJob` ne l'appelle jamais directement (tout
    // passe par les sous-modules mockés), donc un objet vide typé suffit.
    vi.mocked(createFranceHttpClient).mockReturnValue(
      {} as ReturnType<typeof createFranceHttpClient>,
    );
    vi.mocked(resolveTeam).mockResolvedValue({ teamId: TEAM_ID });
    vi.mocked(solveFranceTurnstile).mockResolvedValue("turnstile-token");
    vi.mocked(openSession).mockResolvedValue(makeSession());
    vi.mocked(shouldRenewSession).mockReturnValue(false);
    vi.mocked(computePollingDelay).mockReturnValue(30_000);
    vi.mocked(buildSlotToKeep).mockReturnValue({
      slotValue: "visas-2026-09-15-0930",
      date: "2026-09-15T09:30:00",
      time: "09:30",
      serviceName: "Visas",
      rate: "0.00",
      capacity: 1,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ── A) Routage dispatcher ──────────────────────────────────────────────────
  // Validates: Requirement 13.1

  describe("routage dispatcher", () => {
    // Le handler France du dispatcher est `runFranceJob` (câblage task 12.2).
    // On le modélise ici par un spy dédié qui DÉLÈGUE au vrai `runFranceJob`
    // (pleinement orchestré via les sous-modules mockés) : on peut ainsi
    // asserter à la fois le fait d'emprunter la branche France ET la propagation
    // fidèle du résultat de l'orchestration réelle.
    function makeHandlers(): DestinationHandlers {
      return {
        schengen: vi.fn<(job: HunterJob) => Promise<SessionResult>>(
          async () => "not_found",
        ),
        spain: vi.fn<(job: HunterJob) => Promise<SessionResult>>(
          async () => "error",
        ),
        france: vi.fn<(job: HunterJob) => Promise<SessionResult>>((job) =>
          runFranceJob(job),
        ),
        default: vi.fn<(job: HunterJob) => Promise<SessionResult>>(
          async () => "not_found",
        ),
      };
    }

    it("destination === \"france\" route vers le handler France et propage son résultat", async () => {
      vi.mocked(scanWindow).mockResolvedValue(makePublicationScan());
      vi.mocked(runBookingFlow).mockResolvedValue(makeBookingOk());

      const job = makeFranceJob();
      const handlers = makeHandlers();

      const result = await resolveWithTimers(routeDestination(job, handlers));

      // Le résultat de l'orchestration France remonte tel quel jusqu'au routeur.
      expect(result).toBe("slot_found");
      // La branche France a été empruntée avec le Job EXACT (même référence).
      expect(handlers.france).toHaveBeenCalledTimes(1);
      expect(handlers.france).toHaveBeenCalledWith(job);
      expect(vi.mocked(handlers.france).mock.calls[0]?.[0]).toBe(job);
      // Les autres branches n'ont pas été touchées.
      expect(handlers.schengen).not.toHaveBeenCalled();
      expect(handlers.spain).not.toHaveBeenCalled();
      expect(handlers.default).not.toHaveBeenCalled();
    });

    it("les autres destinations ne routent PAS vers France", async () => {
      const handlers = makeHandlers();

      for (const destination of ["schengen", "spain", "espagne", "es", "usa"]) {
        const job = { ...makeFranceJob(), destination };
        await routeDestination(job, handlers);
      }

      // La branche France n'est jamais empruntée pour ces destinations.
      expect(handlers.france).not.toHaveBeenCalled();
      expect(handlers.schengen).toHaveBeenCalledTimes(1); // schengen
      expect(handlers.spain).toHaveBeenCalledTimes(3); // spain + espagne + es
      expect(handlers.default).toHaveBeenCalledTimes(1); // usa
    });
  });

  // ── B) Orchestration `runFranceJob` de bout en bout ────────────────────────
  // Validates: Requirements 13.2, 13.3

  describe("runFranceJob — parcours nominal", () => {
    it("publication + autoBook + booking OK → \"slot_found\"", async () => {
      vi.mocked(scanWindow).mockResolvedValue(makePublicationScan());
      vi.mocked(runBookingFlow).mockResolvedValue(makeBookingOk());

      const job = makeFranceJob({ autoBook: true });
      const result = await resolveWithTimers(runFranceJob(job));

      expect(result).toBe("slot_found");
      // Deux Turnstile distincts : #1 (session) et #2 (booking), avec l'URL
      // réelle de la page RDV (websiteURL) en 3e argument.
      expect(solveFranceTurnstile).toHaveBeenCalledWith(
        "session",
        expect.any(String),
        expect.any(String),
      );
      expect(solveFranceTurnstile).toHaveBeenCalledWith(
        "booking",
        expect.any(String),
        expect.any(String),
      );
      expect(runBookingFlow).toHaveBeenCalledTimes(1);
    });

    it("publication détectée sans autoBook → \"slot_found\" sans booking", async () => {
      vi.mocked(scanWindow).mockResolvedValue(makePublicationScan());

      const job = makeFranceJob({ autoBook: false });
      const result = await resolveWithTimers(runFranceJob(job));

      expect(result).toBe("slot_found");
      expect(runBookingFlow).not.toHaveBeenCalled();
      // Turnstile #2 (booking) non sollicité sans autoBook.
      expect(solveFranceTurnstile).not.toHaveBeenCalledWith(
        "booking",
        expect.any(String),
        expect.any(String),
      );
    });

    it("utilise le proxy sticky FR pour le handshake (isolation par Job)", async () => {
      vi.mocked(scanWindow).mockResolvedValue(makePublicationScan());
      vi.mocked(runBookingFlow).mockResolvedValue(makeBookingOk());

      const job = makeFranceJob();
      await resolveWithTimers(runFranceJob(job));

      expect(proxyPool.getStickyProxy).toHaveBeenCalledWith(job.id);
      expect(performHandshake).toHaveBeenCalledWith(STICKY_PROXY);
    });
  });

  describe("runFranceJob — échecs → \"error\", état Job inchangé", () => {
    it("échec de bootstrap (handshake null) → \"error\" et Job non muté", async () => {
      vi.mocked(performHandshake).mockResolvedValue(null);

      const job = makeFranceJob();
      const jobSnapshot = structuredClone(job);

      const result = await resolveWithTimers(runFranceJob(job));

      expect(result).toBe("error");
      // Aucun scan/booking déclenché après un handshake raté.
      expect(scanWindow).not.toHaveBeenCalled();
      expect(runBookingFlow).not.toHaveBeenCalled();
      // L'état du Job est resté strictement inchangé (Requirement 13.2).
      expect(job).toEqual(jobSnapshot);
    });

    it("échec d'ouverture de session (null) → \"error\" et Job inchangé", async () => {
      vi.mocked(openSession).mockResolvedValue(null);

      const job = makeFranceJob();
      const jobSnapshot = structuredClone(job);

      const result = await resolveWithTimers(runFranceJob(job));

      expect(result).toBe("error");
      expect(scanWindow).not.toHaveBeenCalled();
      expect(job).toEqual(jobSnapshot);
    });

    it("échec du booking (qrCodes absent) → \"error\", session préservée, Job inchangé", async () => {
      vi.mocked(scanWindow).mockResolvedValue(makePublicationScan());
      vi.mocked(runBookingFlow).mockResolvedValue(makeBookingFailNoQr());

      const job = makeFranceJob({ autoBook: true });
      const jobSnapshot = structuredClone(job);

      const result = await resolveWithTimers(runFranceJob(job));

      expect(result).toBe("error");
      expect(runBookingFlow).toHaveBeenCalledTimes(1);
      // Aucune nouvelle tentative automatique de booking (Requirement 10.12).
      expect(job).toEqual(jobSnapshot);
    });

    it("configuration France incomplète → \"error\" sans bootstrap réseau", async () => {
      const job = makeFranceJob();
      // On retire un champ requis (slug) → mapJobToFranceConfig renvoie null.
      const brokenConfig = {
        ...job.hunterConfig,
      } as HunterJob["hunterConfig"] & { franceConsulateSlug?: unknown };
      delete brokenConfig.franceConsulateSlug;
      const brokenJob: HunterJob = { ...job, hunterConfig: brokenConfig };

      const result = await resolveWithTimers(runFranceJob(brokenJob));

      expect(result).toBe("error");
      // Rejet précoce : aucun handshake ni scan.
      expect(performHandshake).not.toHaveBeenCalled();
      expect(scanWindow).not.toHaveBeenCalled();
    });
  });
});
