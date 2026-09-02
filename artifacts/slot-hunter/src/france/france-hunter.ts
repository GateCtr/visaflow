/**
 * France Visa Hunter — Orchestration `runFranceJob`.
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « Components and Interfaces » → `france-hunter.ts`) et
 * `requirements.md` (9.3, 11.1–11.4, 13.2, 13.3, 14.3).
 *
 * Rôle : point d'entrée invoqué par le dispatcher (`src/index.ts`) pour tout
 * Job de destination `france`. Orchestre le parcours complet en réutilisant les
 * modules du concern France (handshake, turnstile, session, scanner, booking) :
 *
 *   handshake → resolveTeam → Turnstile #1 (session) → openSession
 *     → boucle de scan (scanWindow) avec renouvellement de session à 25 min
 *       (shouldRenewSession) en chevauchement, jitter ±20 % via
 *       computePollingDelay
 *     → détection de publication
 *     → si publication + autoBook : Turnstile #2 (booking) → runBookingFlow.
 *
 * Isolation totale par Job (Requirement 14.3) : chaque Job possède son propre
 * `FranceAuthState`, son `sessionId`, son `x-csrf-token` et une IP proxy
 * distincte (proxy résidentiel FR sticky obtenu via `proxyPool.getStickyProxy`
 * avec la clé du Job). Le client HTTP est créé via `createFranceHttpClient`.
 *
 * Anti-détection :
 *   - User-Agent réaliste FIXÉ une seule fois et injecté de façon CONSTANTE sur
 *     chaque requête via `opts.headers` (Requirement 11.1, Property 28).
 *   - Délai inter-requêtes borné base 2000 ms ±500 ms ∈ [1500, 2500]
 *     (Requirement 11.2, Property 29), via le helper local `boundedHumanDelayMs`.
 *   - Timezone `Europe/Paris` : la géolocalisation est portée par le proxy
 *     résidentiel FR (Requirement 11.3) ; on la documente ici et on la reflète
 *     dans un header `Accept-Language` cohérent.
 *
 * Règles projet : TypeScript strict, aucun `any`, type de retour explicite,
 * `try/catch` contextuel préfixé `[franceHunter]`, secrets masqués via
 * `maskSecret`.
 *
 * Requirements couverts : 9.3, 11.1, 11.2, 11.3, 11.4, 13.2, 13.3, 14.3.
 */

import type { HunterJob } from "../convexClient.js";
import type { SessionResult } from "../usaPortal/types.js";
import { proxyPool } from "../browser.js";

import { loadFranceEnv } from "./france-config.js";
import { createFranceHttpClient, maskSecret } from "./france-http.js";
import { performHandshake, resolveTeam } from "./france-handshake.js";
import { buildFrancePageUrl, solveFranceTurnstile } from "./france-turnstile.js";
import { openSession, shouldRenewSession } from "./france-session.js";
import { computePollingDelay, scanWindow } from "./france-scanner.js";
import { buildSlotToKeep, runBookingFlow } from "./france-booking.js";
import type {
  BookingContact,
  BookingContext,
  FranceJobConfig,
  FranceServiceTarget,
  FranceSlot,
  ReservationSession,
  SlotPublication,
} from "./france-types.js";

// ---------------------------------------------------------------------------
// Constantes d'orchestration
// ---------------------------------------------------------------------------

/**
 * User-Agent Chrome desktop réaliste, FIXÉ pour toute la session (Requirement
 * 11.1, Property 28). Injecté de façon constante sur chaque requête HTTP via
 * `opts.headers`.
 */
const FRANCE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * Locale/timezone cohérentes avec un proxy résidentiel FR (Requirement 11.3).
 * La timezone effective (`Europe/Paris`) est portée par la géolocalisation du
 * proxy FR ; on reflète la locale côté header pour la cohérence anti-détection.
 */
const FRANCE_ACCEPT_LANGUAGE = "fr-FR,fr;q=0.9,en;q=0.8";

/** Timezone documentée (portée par le proxy FR — Requirement 11.3). */
const FRANCE_TIMEZONE = "Europe/Paris";

/** Base du délai inter-requêtes en ms (Requirement 11.2). */
const INTER_REQUEST_BASE_MS = 2_000;

/** Amplitude du jitter inter-requêtes en ms (±500 ms → borné [1500, 2500]). */
const INTER_REQUEST_JITTER_MS = 500;

/** Intervalle de polling par défaut si le Job n'en fournit pas (30 s). */
const DEFAULT_SCAN_INTERVAL_MS = 30_000;

/**
 * Fenêtre maximale d'exécution d'un Job (garde-fou wall-clock). On borne la
 * boucle de scan pour éviter une exécution infinie ; alignée sur ~1 TTL de
 * session (30 min) plus une marge pour couvrir un renouvellement.
 */
const MAX_JOB_WALLCLOCK_MS = 35 * 60_000;

// ---------------------------------------------------------------------------
// Headers constants de session (UA fixé une fois — Property 28)
// ---------------------------------------------------------------------------

/**
 * Headers émis de façon CONSTANTE sur chaque requête de la session.
 *
 * Le `User-Agent` est fixé une seule fois pour toute la durée de la session
 * (Requirement 11.1, Property 28) et injecté via `opts.headers` du client HTTP,
 * qui les fusionne avec les headers anti-bot `x-gouv-*`.
 */
const SESSION_HEADERS: Readonly<Record<string, string>> = {
  "user-agent": FRANCE_USER_AGENT,
  "accept-language": FRANCE_ACCEPT_LANGUAGE,
};

/** Pause asynchrone. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calcule un délai inter-requêtes borné (fonction pure, testable).
 *
 * Base 2000 ms avec jitter ±500 ms → valeur strictement bornée dans
 * `[1500, 2500]` (Requirement 11.2, Property 29). `rand ∈ [0, 1)` est fourni
 * par l'appelant (ex. `Math.random()`).
 *
 * @param rand Aléa dans `[0, 1)`.
 * @returns Le délai borné dans `[1500, 2500]` millisecondes.
 */
export function boundedHumanDelayMs(rand: number): number {
  // rand ∈ [0,1) → offset ∈ [-500, +500) → délai ∈ [1500, 2500).
  const offset = (rand * 2 - 1) * INTER_REQUEST_JITTER_MS;
  return INTER_REQUEST_BASE_MS + offset;
}

/** Insère un délai inter-requêtes humain borné entre deux requêtes. */
async function humanGap(): Promise<void> {
  await sleep(boundedHumanDelayMs(Math.random()));
}

// ---------------------------------------------------------------------------
// Mapping Job → configuration France
// ---------------------------------------------------------------------------

/**
 * Vue défensive des champs France potentiellement portés par `hunterConfig`.
 *
 * HYPOTHÈSE DE MAPPING (documentée) : l'interface `HunterJob` du monorepo n'a
 * PAS encore de champ dédié France. On lit donc la configuration France de
 * façon défensive depuis `job.hunterConfig` (dont le type est ouvert/extensible)
 * via un cast en lecture seule, SANS modifier `convexClient.ts` (changement
 * localisé — cf. consigne de la task 12.1). Les clés attendues :
 *
 *   - `franceConsulateSlug` : slug du consulat (Requirement 14.1).
 *   - `franceServiceId` / `franceServiceName` : cible de service (Requirement
 *     14.2, séparation stricte id/nom).
 *   - `franceContact*` / `franceBirthdate*` : contact principal (Requirement
 *     10.4).
 *   - `franceMotif` : motif autorisé (Requirement 10.6).
 *   - `franceAutoBook` : réservation automatique (Requirement 9.3).
 *   - `franceScanIntervalMs` : intervalle de polling (Requirement 9.4).
 *
 * Si les champs France requis sont absents/invalides, `mapJobToFranceConfig`
 * retourne `null` (le hunter journalise `[franceHunter]` et renvoie `"error"`).
 */
interface FranceHunterConfigView {
  franceConsulateSlug?: unknown;
  franceServiceId?: unknown;
  franceServiceName?: unknown;
  franceContactFirstname?: unknown;
  franceContactLastname?: unknown;
  franceContactEmail?: unknown;
  franceContactMobile?: unknown;
  franceBirthMonth?: unknown;
  franceBirthDay?: unknown;
  franceBirthYear?: unknown;
  franceMotifKey?: unknown;
  franceMotif?: unknown;
  franceAutoBook?: unknown;
  franceScanIntervalMs?: unknown;
}

/** Lit une chaîne non vide depuis une valeur inconnue, sinon `undefined`. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Lit un entier fini depuis une valeur inconnue (nombre ou chaîne), sinon `undefined`. */
function readInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

/**
 * Dérive une `FranceJobConfig` depuis le Job (lecture défensive de
 * `hunterConfig`), ou `null` si des champs France requis manquent.
 *
 * Aucune valeur codée en dur : les identifiants (slug, service) proviennent du
 * Job (Requirements 14.1, 14.2). Le contact et le motif sont validés en aval
 * par `runBookingFlow` (bornes/appartenance) ; ici on se limite à extraire les
 * champs et à rejeter tôt les absences structurelles.
 *
 * @param job Job planifié (destination `france`).
 * @returns La `FranceJobConfig` dérivée, ou `null` si incomplète.
 */
export function mapJobToFranceConfig(job: HunterJob): FranceJobConfig | null {
  const view = job.hunterConfig as unknown as FranceHunterConfigView;

  const consulateSlug = readString(view.franceConsulateSlug);
  const serviceId = readString(view.franceServiceId);
  const serviceName = readString(view.franceServiceName);
  const motifRaw = readString(view.franceMotif);
  const motifKey = readString(view.franceMotifKey);

  const firstname = readString(view.franceContactFirstname);
  const lastname = readString(view.franceContactLastname);
  const email = readString(view.franceContactEmail);
  const mobile = readString(view.franceContactMobile);
  const month = readInt(view.franceBirthMonth);
  const day = readInt(view.franceBirthDay);
  const year = readInt(view.franceBirthYear);

  const missing: string[] = [];
  if (consulateSlug === undefined) missing.push("franceConsulateSlug");
  if (serviceId === undefined) missing.push("franceServiceId");
  if (serviceName === undefined) missing.push("franceServiceName");
  if (motifRaw === undefined) missing.push("franceMotif");
  if (motifKey === undefined) missing.push("franceMotifKey");
  if (firstname === undefined) missing.push("franceContactFirstname");
  if (lastname === undefined) missing.push("franceContactLastname");
  if (email === undefined) missing.push("franceContactEmail");
  if (mobile === undefined) missing.push("franceContactMobile");
  if (month === undefined) missing.push("franceBirthMonth");
  if (day === undefined) missing.push("franceBirthDay");
  if (year === undefined) missing.push("franceBirthYear");

  if (
    consulateSlug === undefined ||
    serviceId === undefined ||
    serviceName === undefined ||
    motifRaw === undefined ||
    motifKey === undefined ||
    firstname === undefined ||
    lastname === undefined ||
    email === undefined ||
    mobile === undefined ||
    month === undefined ||
    day === undefined ||
    year === undefined
  ) {
    console.error(
      `[franceHunter] Configuration France incomplète pour le Job ${job.id} ` +
        `(champs manquants : ${missing.join(", ")}). Traitement abandonné.`,
    );
    return null;
  }

  // Le motif est SPÉCIFIQUE au service (custom_fields du service). On ne peut
  // pas le valider contre une liste globale figée (celle-ci ne vaut que pour
  // Visas). La validation « valeur ∈ valeurs du service » relève du job/UI qui
  // lit team.reservations_shop_availabilty[service].custom_fields.
  const motif: string = motifRaw;

  const service: FranceServiceTarget = { serviceId, serviceName };
  const contact: BookingContact = {
    firstname,
    lastname,
    email,
    mobile,
    birthdate: { month, day, year },
  };

  const scanIntervalMs = readInt(view.franceScanIntervalMs) ?? DEFAULT_SCAN_INTERVAL_MS;
  const autoBook = view.franceAutoBook === true || view.franceAutoBook === "true";

  return {
    consulateSlug,
    service,
    contact,
    motifKey,
    motif,
    autoBook,
    scanIntervalMs: scanIntervalMs > 0 ? scanIntervalMs : DEFAULT_SCAN_INTERVAL_MS,
  };
}

// ---------------------------------------------------------------------------
// Résolution du proxy résidentiel FR sticky (isolation par Job — Req 14.3, 11.3)
// ---------------------------------------------------------------------------

/**
 * Obtient un proxy résidentiel FR STABLE pour toute la session du Job.
 *
 * Utilise `proxyPool.getStickyProxy(job.id)` : chaque Job obtient une IP
 * distincte et STABLE (même IP pour toute la session — Requirements 11.3, 11.4,
 * 14.3). En l'absence de proxy sticky configuré, retombe sur
 * `loadFranceEnv().proxyUrl` (fallback env). Retourne `null` si aucune URL
 * proxy n'est disponible.
 *
 * @param job Job planifié (sa clé sert de clé sticky).
 * @param fallbackProxyUrl URL proxy de secours (env).
 * @returns L'URL du proxy à utiliser, ou `null` si indisponible.
 */
async function resolveStickyProxy(
  job: HunterJob,
  fallbackProxyUrl: string,
): Promise<string | null> {
  try {
    const sticky = await proxyPool.getStickyProxy(job.id);
    if (sticky !== null && sticky.length > 0) {
      return sticky;
    }
  } catch (error) {
    console.error(
      `[franceHunter] Échec d'obtention du proxy sticky pour le Job ${job.id}, ` +
        `repli sur le proxy d'environnement :`,
      error instanceof Error ? error.message : error,
    );
  }
  return fallbackProxyUrl.length > 0 ? fallbackProxyUrl : null;
}

// ---------------------------------------------------------------------------
// Point d'entrée dispatcher — runFranceJob
// ---------------------------------------------------------------------------

/**
 * Point d'entrée du hunter France, invoqué par le dispatcher pour un Job de
 * destination `france` (Requirement 13.1, câblage en task 12.2).
 *
 * Orchestration complète, avec isolation totale par Job (Requirement 14.3) :
 *   1. Charge l'environnement (clé CapSolver, proxy fallback) et dérive la
 *      config France (`mapJobToFranceConfig`). Config incomplète → `"error"`.
 *   2. Obtient un proxy résidentiel FR sticky (IP distincte/stable par Job).
 *   3. Handshake anti-bot (`performHandshake`) → `FranceAuthState` isolé.
 *   4. Crée le client HTTP (`createFranceHttpClient`) avec `onRehandshake`
 *      rejouant `performHandshake(proxyUrl)`.
 *   5. Résout le consulat (`resolveTeam`) → `teamId`.
 *   6. Résout Turnstile #1 (`session`) puis ouvre la session (`openSession`).
 *   7. Boucle de scan (`scanWindow`) bornée par `MAX_JOB_WALLCLOCK_MS`, avec
 *      renouvellement anticipé de session à 25 min (`shouldRenewSession`) en
 *      chevauchement et jitter de polling ±20 % (`computePollingDelay`).
 *   8. Sur publication : si `autoBook`, résout Turnstile #2 (`booking`),
 *      construit le `BookingContext` et appelle `runBookingFlow`. Sinon, une
 *      publication détectée vaut `"slot_found"`.
 *
 * @param job Job planifié de destination `france`.
 * @returns `SessionResult` : `"slot_found"` si booking réussi / publication
 *   trouvée (selon `autoBook`), `"not_found"` si aucune publication au terme du
 *   scan, `"error"` en cas d'échec de bootstrap/session/config.
 */
export async function runFranceJob(job: HunterJob): Promise<SessionResult> {
  console.log(
    `[franceHunter] Démarrage du Job ${job.id} (destination=${job.destination}, ` +
      `timezone documentée=${FRANCE_TIMEZONE}).`,
  );

  // --- 1. Environnement + configuration France ---------------------------
  let capsolverApiKey: string;
  let fallbackProxyUrl: string;
  try {
    const env = loadFranceEnv();
    capsolverApiKey = env.capsolverApiKey;
    fallbackProxyUrl = env.proxyUrl;
  } catch (error) {
    console.error(
      `[franceHunter] Environnement France invalide (Job ${job.id}) :`,
      error instanceof Error ? error.message : error,
    );
    return "error";
  }

  const config = mapJobToFranceConfig(job);
  if (config === null) {
    // mapJobToFranceConfig a déjà journalisé la cause précise.
    return "error";
  }

  try {
    // --- 2. Proxy résidentiel FR sticky (IP distincte/stable par Job) -----
    const proxyUrl = await resolveStickyProxy(job, fallbackProxyUrl);
    if (proxyUrl === null) {
      console.error(
        `[franceHunter] Aucun proxy résidentiel FR disponible pour le Job ${job.id}. ` +
          `Traitement abandonné.`,
      );
      return "error";
    }

    // --- 3. Handshake anti-bot (auth state isolé par Job) -----------------
    const authState = await performHandshake(proxyUrl);
    if (authState === null) {
      console.error(
        `[franceHunter] Bootstrap handshake échoué (Job ${job.id}) — abandon, état inchangé.`,
      );
      return "error";
    }

    // --- 4. Client HTTP isolé (onRehandshake sur 418) ---------------------
    const http = createFranceHttpClient(authState, proxyUrl, () =>
      performHandshake(proxyUrl),
    );

    // Options de requête constantes : UA fixé une fois pour toute la session
    // (Property 28), injecté via opts.headers sur CHAQUE requête.
    const sessionOpts = { headers: { ...SESSION_HEADERS } } as const;

    // --- 5. Résolution du consulat → teamId -------------------------------
    await humanGap();
    const team = await resolveTeam(http, config.consulateSlug);
    if (team === null) {
      console.error(
        `[franceHunter] Résolution du consulat échouée (Job ${job.id}, ` +
          `slug=${config.consulateSlug}) — abandon.`,
      );
      return "error";
    }
    const { teamId } = team;

    // --- 6. Turnstile #1 (session) + ouverture de session -----------------
    // URL RÉELLE de la page RDV du consulat (où vit le widget Turnstile). Le
    // token CapSolver doit être lié à cette URL, sinon l'API rejette
    // (`CAPTCHA_FAILED`).
    const pageUrl = buildFrancePageUrl(config.consulateSlug, config.service.serviceName);
    const sessionToken = await solveFranceTurnstile("session", capsolverApiKey, pageUrl);
    if (sessionToken === null) {
      console.error(
        `[franceHunter] Turnstile #1 (session) non résolu (Job ${job.id}) — abandon.`,
      );
      return "error";
    }

    await humanGap();
    let session: ReservationSession | null = await openSession(
      http,
      teamId,
      config.service.serviceName,
      sessionToken,
      Date.now(),
    );
    if (session === null) {
      console.error(
        `[franceHunter] Ouverture de session échouée (Job ${job.id}) — abandon, état inchangé.`,
      );
      return "error";
    }

    console.log(
      `[franceHunter] Session ouverte (Job ${job.id}, session=${maskSecret(session.sessionId)}) — ` +
        `démarrage du scan (intervalle ${config.scanIntervalMs} ms ±20 %).`,
    );

    // --- 7. Boucle de scan + renouvellement de session --------------------
    const deadlineMs = Date.now() + MAX_JOB_WALLCLOCK_MS;
    let prevExcluded: ReadonlySet<string> = new Set<string>();

    while (Date.now() < deadlineMs) {
      // Renouvellement anticipé (25 min) EN CHEVAUCHEMENT : on ouvre une
      // nouvelle session avant de basculer, sans perdre le contexte de scan
      // (prevExcluded) — Requirements 5.2, 5.4.
      if (shouldRenewSession(session, Date.now())) {
        console.log(
          `[franceHunter] Renouvellement anticipé de session (Job ${job.id}).`,
        );
        const renewToken = await solveFranceTurnstile("session", capsolverApiKey, pageUrl);
        if (renewToken !== null) {
          await humanGap();
          const renewed = await openSession(
            http,
            teamId,
            config.service.serviceName,
            renewToken,
            Date.now(),
          );
          if (renewed !== null) {
            // Bascule du sessionId sans perte du contexte de scan (prevExcluded
            // conservé) — Requirement 5.4.
            session = renewed;
            console.log(
              `[franceHunter] Session renouvelée (Job ${job.id}, session=${maskSecret(session.sessionId)}).`,
            );
          } else {
            console.error(
              `[franceHunter] Renouvellement de session échoué (Job ${job.id}) — ` +
                `poursuite avec la session courante jusqu'à expiration.`,
            );
          }
        } else {
          console.error(
            `[franceHunter] Turnstile de renouvellement non résolu (Job ${job.id}) — ` +
              `poursuite avec la session courante.`,
          );
        }
      }

      // Un cycle de scan complet de la fenêtre.
      await humanGap();
      const scan = await scanWindow(
        http,
        teamId,
        config.service,
        session.sessionId,
        prevExcluded,
      );

      if (scan === null) {
        // Étape bloquante en échec (get-interval / exclude-days) : on réessaie
        // au cycle suivant après le délai de polling (l'état de session est
        // préservé). SESSION_ERROR éventuel a déjà été journalisé en aval.
        console.error(
          `[franceHunter] Cycle de scan interrompu (Job ${job.id}) — nouvelle tentative au prochain cycle.`,
        );
      } else {
        prevExcluded = scan.excludeDays;

        if (scan.publication !== null) {
          console.log(
            `[franceHunter] Publication détectée (Job ${job.id}, raison=${scan.publication.reason}, ` +
              `jour=${scan.publication.day}, créneaux=${scan.publication.slots.length}).`,
          );
          return await handlePublication(
            http,
            job,
            config,
            teamId,
            session.sessionId,
            scan.publication,
            capsolverApiKey,
          );
        }
      }

      // Polling avec jitter ±20 % (Requirements 9.3, 9.4) — le sleep effectif
      // vit ici ; computePollingDelay est pur/testable.
      const delayMs = computePollingDelay(config.scanIntervalMs, Math.random());
      await sleep(delayMs);
    }

    console.log(
      `[franceHunter] Fin de la fenêtre d'exécution sans publication (Job ${job.id}).`,
    );
    return "not_found";
  } catch (error) {
    console.error(
      `[franceHunter] Erreur inattendue lors du traitement du Job ${job.id} :`,
      error instanceof Error ? error.message : error,
    );
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Gestion d'une publication détectée (booking conditionnel)
// ---------------------------------------------------------------------------

/**
 * Traite une publication détectée par le scanner.
 *
 * Si `autoBook` est désactivé, la seule détection d'une publication vaut
 * `"slot_found"` (un créneau a été trouvé). Sinon, on résout Turnstile #2
 * (`booking`), on construit le `BookingContext` (avec `buildSlotToKeep` sur le
 * jour de la publication et le premier créneau) et on exécute `runBookingFlow`.
 * Le booking réussi rend `"slot_found"`, l'échec rend `"error"` (état de
 * session préservé, aucune nouvelle tentative automatique — Req 10.12).
 *
 * @returns `SessionResult` reflétant l'issue.
 */
async function handlePublication(
  http: ReturnType<typeof createFranceHttpClient>,
  job: HunterJob,
  config: FranceJobConfig,
  teamId: string,
  sessionId: string,
  publication: SlotPublication,
  capsolverApiKey: string,
): Promise<SessionResult> {
  // Pas de réservation automatique : une publication suffit à signaler un slot.
  if (!config.autoBook) {
    console.log(
      `[franceHunter] Publication trouvée mais autoBook désactivé (Job ${job.id}) — ` +
        `signalement "slot_found" sans réservation.`,
    );
    return "slot_found";
  }

  // Choix du premier créneau du jour publié (le cas "exclude_days_retraction"
  // n'expose pas de créneaux directement : sans slot exploitable, on signale
  // tout de même la publication comme un slot trouvé).
  const firstSlot: FranceSlot | undefined = publication.slots[0];
  if (firstSlot === undefined) {
    console.log(
      `[franceHunter] Publication sans créneau exploitable (Job ${job.id}, raison=${publication.reason}) — ` +
        `signalement "slot_found" (booking non déclenché).`,
    );
    return "slot_found";
  }

  // Turnstile #2 (booking) — distinct du token de session (Requirement 3.3).
  // Même URL de page réelle que pour la session (widget lié à la page RDV).
  const bookingPageUrl = buildFrancePageUrl(config.consulateSlug, config.service.serviceName);
  const bookingToken = await solveFranceTurnstile("booking", capsolverApiKey, bookingPageUrl);
  if (bookingToken === null) {
    console.error(
      `[franceHunter] Turnstile #2 (booking) non résolu (Job ${job.id}) — booking abandonné.`,
    );
    return "error";
  }

  const slot = buildSlotToKeep(
    config.service.serviceName,
    publication.day,
    firstSlot.time,
    firstSlot.rate,
    firstSlot.capacity,
  );

  const bookingCtx: BookingContext = {
    teamId,
    sessionId,
    service: config.service,
    contact: config.contact,
    motifKey: config.motifKey,
    motif: config.motif,
    slot,
    captchaToken: bookingToken,
  };

  const result = await runBookingFlow(http, bookingCtx);
  if (result.success) {
    console.log(
      `[franceHunter] Booking réussi (Job ${job.id}) : ${result.qrCodes?.length ?? 0} qrCode(s).`,
    );
    return "slot_found";
  }

  console.error(
    `[franceHunter] Booking échoué (Job ${job.id}) : ${result.error ?? "cause inconnue"} ` +
      `(étape=${result.failedStep ?? "n/a"}) — session préservée.`,
  );
  return "error";
}
