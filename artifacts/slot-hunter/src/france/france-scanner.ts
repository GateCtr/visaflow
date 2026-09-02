/**
 * France Visa Hunter — Scanner (fonctions pures).
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « france-scanner.ts ») et `requirements.md` (6.x, 7.x, 8.x, 9.x).
 *
 * Ce fichier ne contient QUE des fonctions pures (task 8.1) :
 *   - `computeScannableDays` : jours ∈ [start, end] ∧ ∉ excludeDays, triés.
 *   - `detectPublication`    : détection de publication entre deux scans.
 *   - `buildGetIntervalPath` / `buildAvailabilityQuery` : construction d'URL
 *     séparant strictement `serviceId` (get-interval) et `serviceName`
 *     (availability) — Requirement 14.2.
 *
 * Les fonctions réseau (`getInterval`, `getExcludeDays`,
 * `scanAvailabilityForDay`, boucle de scan) et le helper pur de délai de
 * polling (`computePollingDelay`) sont ajoutés en task 8.5.
 *
 * TypeScript strict : aucun `any`, types de retour explicites, camelCase.
 * Logs/erreurs préfixés `[franceHunter]`, appels réseau encadrés `try/catch`.
 *
 * Requirements couverts : 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5,
 * 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4, 14.2.
 */

import {
  isValidWindow,
  parseExcludeDays,
  parseSlots,
  type FranceHttpClient,
} from "./france-http.js";
import type {
  ExcludeDaysBody,
  FranceServiceTarget,
  FranceSlot,
  GetIntervalResponse,
  ScanWindow,
  SlotPublication,
} from "./france-types.js";

// ---------------------------------------------------------------------------
// Arithmétique de dates (UTC, sans dépendance externe)
// ---------------------------------------------------------------------------

/** Nombre de millisecondes dans un jour. */
const MS_PER_DAY = 86_400_000;

/** Délai de base (ms) entre deux requêtes availability (anti rate-limit 429). */
const SCAN_PER_DAY_BASE_MS = 400;

/** Pause asynchrone. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Délai inter-jour jitté (fonction pure) : `baseMs * (0.8 + rand*0.4)` →
 * borné dans `[baseMs×0.8, baseMs×1.2)`. `rand ∈ [0,1)`.
 *
 * @param baseMs Délai de base en ms.
 * @param rand Aléa dans `[0, 1)`.
 * @returns Le délai jitté en ms.
 */
export function perDayDelayMs(baseMs: number, rand: number): number {
  return baseMs * (0.8 + rand * 0.4);
}

/**
 * Parse une date `YYYY-MM-DD` en timestamp UTC (minuit).
 * Retourne `null` si le format est invalide ou si la date n'existe pas
 * (ex. `2026-02-30`).
 */
function parseUtcDay(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (month < 1 || month > 12 || date < 1 || date > 31) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, date);
  const parsed = new Date(ms);
  // Rejeter les dates recalées par Date.UTC (ex. 2026-02-30 -> 2026-03-02).
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== date
  ) {
    return null;
  }
  return ms;
}

/** Formate un timestamp UTC en `YYYY-MM-DD`. */
function formatUtcDay(ms: number): string {
  const date = new Date(ms);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Jours scannables (Property 14 — Requirements 6.3, 7.4)
// ---------------------------------------------------------------------------

/**
 * Retourne toutes les dates `YYYY-MM-DD` de l'intervalle inclusif
 * `[window.start, window.end]` qui ne sont PAS dans `excludeDays`, triées par
 * ordre croissant.
 *
 * L'itération est en UTC pour éviter les décalages liés au DST. Si la fenêtre
 * est invalide (format KO ou `start > end`), retourne un tableau vide.
 */
export function computeScannableDays(
  window: ScanWindow,
  excludeDays: ReadonlySet<string>,
): string[] {
  const startMs = parseUtcDay(window.start);
  const endMs = parseUtcDay(window.end);
  if (startMs === null || endMs === null || startMs > endMs) {
    return [];
  }

  const days: string[] = [];
  for (let cursor = startMs; cursor <= endMs; cursor += MS_PER_DAY) {
    const day = formatUtcDay(cursor);
    if (!excludeDays.has(day)) {
      days.push(day);
    }
  }
  return days;
}

// ---------------------------------------------------------------------------
// Détection de publication (Properties 19, 20 — Requirements 9.1, 9.2)
// ---------------------------------------------------------------------------

/**
 * Détecte une publication entre deux scans successifs.
 *
 * Signale une `SlotPublication` si :
 *   (a) au moins un jour de `daySlots` possède des créneaux non vides
 *       → raison `"availability"`, retourne ce jour et ses slots ;
 *   (b) sinon, si `currExcluded` retire au moins un jour appartenant à la
 *       fenêtre qui était présent dans `prevExcluded`
 *       → raison `"exclude_days_retraction"`.
 *
 * Retourne `null` si aucune publication n'est détectée. La détection de
 * disponibilité (a) prime sur la rétraction (b).
 */
export function detectPublication(
  prevExcluded: ReadonlySet<string>,
  currExcluded: ReadonlySet<string>,
  window: ScanWindow,
  daySlots: ReadonlyMap<string, FranceSlot[]>,
): SlotPublication | null {
  // (a) Disponibilité : premier jour (ordre croissant) avec des créneaux.
  const availableDays: string[] = [];
  for (const [day, slots] of daySlots) {
    if (slots.length > 0) {
      availableDays.push(day);
    }
  }
  if (availableDays.length > 0) {
    availableDays.sort();
    const day = availableDays[0];
    return {
      reason: "availability",
      day,
      slots: daySlots.get(day) ?? [],
    };
  }

  // (b) Rétraction : un jour de la fenêtre, présent dans prevExcluded, retiré
  //     de currExcluded.
  const startMs = parseUtcDay(window.start);
  const endMs = parseUtcDay(window.end);
  if (startMs !== null && endMs !== null && startMs <= endMs) {
    const retractedDays: string[] = [];
    for (const day of prevExcluded) {
      if (currExcluded.has(day)) {
        continue;
      }
      const dayMs = parseUtcDay(day);
      if (dayMs !== null && dayMs >= startMs && dayMs <= endMs) {
        retractedDays.push(day);
      }
    }
    if (retractedDays.length > 0) {
      retractedDays.sort();
      return {
        reason: "exclude_days_retraction",
        day: retractedDays[0],
        slots: [],
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Construction d'URL — séparation stricte serviceId / serviceName (Property 17)
// ---------------------------------------------------------------------------

/**
 * Construit le chemin (path + query) de `get-interval`.
 *
 * Ce chemin porte l'identifiant technique `serviceId` (jamais `serviceName`) —
 * Requirement 14.2. Retourne un chemin relatif à `FRANCE_API_BASE`, ex. :
 * `/team/{teamId}/reservations/get-interval?serviceId={serviceId}`.
 */
export function buildGetIntervalPath(teamId: string, serviceId: string): string {
  const params = new URLSearchParams({ serviceId });
  return `/team/${encodeURIComponent(teamId)}/reservations/get-interval?${params.toString()}`;
}

/**
 * Construit la query string de `availability` pour un jour.
 *
 * Le nom textuel du service est porté par le paramètre `name` (jamais
 * `serviceId`) — Requirement 14.2. Paramètres fixes (Requirement 8.1) :
 * `places=1`, `matching=` (vide), `maxCapacity=1`. Retourne une query string
 * sans le `?` initial.
 */
export function buildAvailabilityQuery(
  serviceName: string,
  date: string,
  sessionId: string,
): string {
  const params = new URLSearchParams();
  params.set("name", serviceName);
  params.set("date", date);
  params.set("places", "1");
  params.set("matching", "");
  params.set("maxCapacity", "1");
  params.set("sessionId", sessionId);
  return params.toString();
}

// ---------------------------------------------------------------------------
// Résultat structuré d'un scan complet de la fenêtre
// ---------------------------------------------------------------------------

/**
 * Résultat d'un balayage complet de la fenêtre de scan.
 *
 * Retourné par `scanWindow` : porte la fenêtre déterminée, l'ensemble des
 * jours exclus courants, la carte jour → créneaux collectés, et l'éventuelle
 * publication détectée (`null` si aucune).
 */
export interface FranceScanResult {
  /** Fenêtre `[start, end]` retournée par `get-interval`. */
  window: ScanWindow;
  /** Jours fermés courants (issus de `exclude-days`). */
  excludeDays: Set<string>;
  /** Créneaux collectés par jour scanné (jour → slots, `[]` si agenda vide). */
  daySlots: Map<string, FranceSlot[]>;
  /** Publication détectée entre le scan précédent et courant, ou `null`. */
  publication: SlotPublication | null;
}

// ---------------------------------------------------------------------------
// getInterval — fenêtre de scan (Requirements 6.1, 6.2, 6.4)
// ---------------------------------------------------------------------------

/**
 * Récupère la fenêtre de scan via `GET get-interval?serviceId={serviceId}`.
 *
 * Utilise `buildGetIntervalPath` (identifiant technique `serviceId`, jamais le
 * nom textuel — Requirement 14.2). Valide `start`/`end` (présence, format
 * `YYYY-MM-DD`, ordre `start <= end`) via `isValidWindow` (Requirement 6.2).
 *
 * Retourne `null` — et journalise une erreur préfixée `[franceHunter]` — si la
 * requête échoue, si le statut n'est pas 200, ou si la réponse est non conforme
 * (Requirement 6.4). Le contrôle de session (404 `SESSION_ERROR`) est délégué à
 * l'appelant via le drapeau `sessionError` du client HTTP.
 *
 * @param http Client HTTP France (gère timeout/retry/proxy/418).
 * @param teamId Identifiant du consulat résolu.
 * @param serviceId `_id` du service cible.
 * @returns La `ScanWindow` validée, ou `null` si invalide/erreur.
 */
export async function getInterval(
  http: FranceHttpClient,
  teamId: string,
  serviceId: string,
): Promise<ScanWindow | null> {
  const path = buildGetIntervalPath(teamId, serviceId);
  try {
    const res = await http.get<GetIntervalResponse>(path);
    if (res.sessionError) {
      console.error("[franceHunter] get-interval: session expirée (SESSION_ERROR).");
      return null;
    }
    if (!res.ok || res.status !== 200) {
      console.error(`[franceHunter] get-interval: statut HTTP ${res.status} inattendu.`);
      return null;
    }
    if (!isValidWindow(res.body)) {
      console.error("[franceHunter] get-interval: fenêtre invalide (start/end/format/ordre).");
      return null;
    }
    // isValidWindow garantit start/end présents, format YYYY-MM-DD, start <= end.
    const window = res.body as GetIntervalResponse;
    return { start: window.start, end: window.end };
  } catch (error) {
    console.error(
      "[franceHunter] get-interval: échec de la requête:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// getExcludeDays — jours fermés (Requirements 7.1, 7.2, 7.3, 7.5)
// ---------------------------------------------------------------------------

/**
 * Récupère l'ensemble des jours fermés via `POST exclude-days`.
 *
 * Corps `{session: {[serviceId]: true}, sessionId}` (Requirement 7.1). Parse et
 * valide la réponse via `parseExcludeDays` : ne conserve que les dates
 * `YYYY-MM-DD` valides (Requirements 7.2, 7.3).
 *
 * Retourne `null` — et journalise une erreur préfixée `[franceHunter]` — si la
 * requête échoue, en cas de `SESSION_ERROR` (laissé à l'appelant), si le statut
 * n'est pas 200, ou si la réponse n'est pas un tableau (Requirement 7.5).
 *
 * @param http Client HTTP France.
 * @param teamId Identifiant du consulat résolu.
 * @param serviceId `_id` du service cible (clé du champ `session`).
 * @param sessionId Session de réservation active.
 * @returns L'ensemble des dates fermées, ou `null` si invalide/erreur.
 */
export async function getExcludeDays(
  http: FranceHttpClient,
  teamId: string,
  serviceId: string,
  sessionId: string,
): Promise<Set<string> | null> {
  const path = `/team/${encodeURIComponent(teamId)}/reservations/exclude-days`;
  const body: ExcludeDaysBody = {
    session: { [serviceId]: true },
    sessionId,
  };
  try {
    const res = await http.post<unknown>(path, body);
    if (res.sessionError) {
      console.error("[franceHunter] exclude-days: session expirée (SESSION_ERROR).");
      return null;
    }
    if (!res.ok || res.status !== 200) {
      console.error(`[franceHunter] exclude-days: statut HTTP ${res.status} inattendu.`);
      return null;
    }
    const excludeDays = parseExcludeDays(res.body);
    if (excludeDays === null) {
      console.error("[franceHunter] exclude-days: réponse non conforme (non-tableau).");
      return null;
    }
    return excludeDays;
  } catch (error) {
    console.error(
      "[franceHunter] exclude-days: échec de la requête:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// scanAvailabilityForDay — créneaux d'un jour (Requirements 8.1, 8.2, 8.3)
// ---------------------------------------------------------------------------

/**
 * Récupère les créneaux d'un jour via `GET availability`.
 *
 * Utilise `buildAvailabilityQuery` (nom textuel `serviceName`, jamais l'`_id` —
 * Requirement 14.2). Parse la réponse via `parseSlots`.
 *
 * Un tableau vide `[]` (HTTP 200) correspond au cas normal « agenda vide, aucun
 * créneau ce jour » : la fonction retourne `[]`, ce n'est PAS une erreur
 * (Requirement 8.3). Elle retourne `null` UNIQUEMENT en cas d'erreur réelle :
 * échec réseau, `SESSION_ERROR`, statut ≠ 200, ou DTO non conforme
 * (Requirements 8.1, 8.5). L'appelant décide s'il poursuit le scan des autres
 * jours (Requirement 8.5).
 *
 * @param http Client HTTP France.
 * @param teamId Identifiant du consulat résolu.
 * @param serviceName Nom textuel complet du service.
 * @param date Jour scanné au format `YYYY-MM-DD`.
 * @param sessionId Session de réservation active.
 * @returns Les créneaux (éventuellement `[]`), ou `null` en cas d'erreur.
 */
export async function scanAvailabilityForDay(
  http: FranceHttpClient,
  teamId: string,
  serviceName: string,
  date: string,
  sessionId: string,
): Promise<FranceSlot[] | null> {
  const query = buildAvailabilityQuery(serviceName, date, sessionId);
  const path = `/team/${encodeURIComponent(teamId)}/reservations/availability?${query}`;
  try {
    const res = await http.get<unknown>(path);
    if (res.sessionError) {
      console.error(`[franceHunter] availability ${date}: session expirée (SESSION_ERROR).`);
      return null;
    }
    if (!res.ok || res.status !== 200) {
      console.error(`[franceHunter] availability ${date}: statut HTTP ${res.status} inattendu.`);
      return null;
    }
    const slots = parseSlots(res.body);
    if (slots === null) {
      console.error(`[franceHunter] availability ${date}: DTO non conforme.`);
      return null;
    }
    // `slots` peut être `[]` : agenda vide, cas normal (Requirement 8.3).
    return slots;
  } catch (error) {
    console.error(
      `[franceHunter] availability ${date}: échec de la requête:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// scanWindow — boucle de scan complète (Requirements 8.5, 9.1, 9.2)
// ---------------------------------------------------------------------------

/**
 * Effectue un balayage complet de la fenêtre de scan pour un service.
 *
 * Séquence :
 *   1. `getInterval` → fenêtre `[start, end]` (interruption si `null`).
 *   2. `getExcludeDays` → jours fermés (interruption si `null`).
 *   3. `computeScannableDays` → jours à scanner (∈ fenêtre, ∉ exclus).
 *   4. `scanAvailabilityForDay` sur chaque jour : un jour en erreur (`null`)
 *      n'interrompt PAS le scan global — il est journalisé et ignoré de la
 *      carte de résultats (Requirement 8.5).
 *   5. `detectPublication` sur la carte collectée et la rétraction éventuelle
 *      des jours exclus par rapport à `prevExcluded` (Requirements 9.1, 9.2).
 *
 * Retourne `null` uniquement si l'une des deux étapes bloquantes (interval /
 * exclude-days) échoue. Sinon retourne un `FranceScanResult` structuré.
 *
 * @param http Client HTTP France.
 * @param teamId Identifiant du consulat résolu.
 * @param service Cible de service (`serviceId` pour interval, `serviceName`
 *   pour availability) — Requirement 14.2.
 * @param sessionId Session de réservation active.
 * @param prevExcluded Jours exclus du scan précédent (défaut : ensemble vide),
 *   utilisé pour détecter une rétraction (Requirement 9.2).
 * @returns Le résultat structuré du scan, ou `null` si une étape bloquante
 *   échoue.
 */
export async function scanWindow(
  http: FranceHttpClient,
  teamId: string,
  service: FranceServiceTarget,
  sessionId: string,
  prevExcluded: ReadonlySet<string> = new Set<string>(),
  /** Délai de base (ms) entre deux requêtes availability (0 en test). */
  perDayBaseMs: number = SCAN_PER_DAY_BASE_MS,
): Promise<FranceScanResult | null> {
  const window = await getInterval(http, teamId, service.serviceId);
  if (window === null) {
    return null;
  }

  const excludeDays = await getExcludeDays(http, teamId, service.serviceId, sessionId);
  if (excludeDays === null) {
    return null;
  }

  const scannableDays = computeScannableDays(window, excludeDays);
  const daySlots = new Map<string, FranceSlot[]>();
  let first = true;
  for (const day of scannableDays) {
    // Pause jittée entre deux requêtes availability (anti rate-limit 429 +
    // anti-détection). Le portail Troov limite les appels rapprochés ; le
    // harnais live espaçait ~250 ms. Pas de pause avant le premier jour.
    if (!first && perDayBaseMs > 0) {
      await sleep(perDayDelayMs(perDayBaseMs, Math.random()));
    }
    first = false;

    const slots = await scanAvailabilityForDay(
      http,
      teamId,
      service.serviceName,
      day,
      sessionId,
    );
    // Un jour en erreur (`null`) n'interrompt pas le scan global (Req 8.5) :
    // il est déjà journalisé par scanAvailabilityForDay et simplement omis.
    if (slots !== null) {
      daySlots.set(day, slots);
    }
  }

  const publication = detectPublication(prevExcluded, excludeDays, window, daySlots);

  return { window, excludeDays, daySlots, publication };
}

// ---------------------------------------------------------------------------
// computePollingDelay — jitter ±20 % (Property 21 — Requirements 9.3, 9.4)
// ---------------------------------------------------------------------------

/**
 * Calcule le délai de polling avec un jitter de ±20 % (fonction pure).
 *
 * Pour `baseMs` et un aléa `rand ∈ [0, 1)`, retourne
 * `baseMs * (0.8 + rand * 0.4)`, soit une valeur bornée dans
 * `[baseMs × 0.8, baseMs × 1.2)` (Property 21, Requirement 9.4). Le `sleep`
 * effectif reste dans `france-hunter` (qui fournit `Math.random()` comme
 * `rand`) ; ce helper pur est exposé ici pour être testable de façon
 * déterministe.
 *
 * @param baseMs Intervalle de polling de base en millisecondes.
 * @param rand Aléa dans `[0, 1)` (ex. `Math.random()`).
 * @returns Le délai borné dans `[baseMs × 0.8, baseMs × 1.2)`.
 */
export function computePollingDelay(baseMs: number, rand: number): number {
  return baseMs * (0.8 + rand * 0.4);
}
