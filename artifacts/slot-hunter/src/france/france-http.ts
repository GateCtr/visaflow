/**
 * France Visa Hunter — Client HTTP bas niveau.
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « Components and Interfaces » → `france-http.ts`).
 *
 * Ce fichier héberge d'abord les fonctions PURES de calcul réseau (aucun effet
 * de bord, aucun accès réseau) : backoff exponentiel, construction des headers
 * anti-bot et masquage des données sensibles. Le client stateful
 * (`createFranceHttpClient`, `fetchWithRetry`) et les validateurs de DTO sont
 * ajoutés par les tasks 2.5 et 2.6 dans ce même fichier.
 *
 * Règles projet appliquées :
 *   - TypeScript strict, aucun `any`, types de retour explicites.
 *   - Constantes en UPPER_SNAKE_CASE, fonctions en camelCase.
 *   - Logs/erreurs préfixés `[franceHunter]`.
 *
 * Requirements couverts par les helpers purs :
 *   - 1.6 : headers `x-gouv-app-id` + `x-gouv-web` sur toute requête.
 *   - 1.7 : header `x-csrf-token` uniquement sur POST/PUT.
 *   - 1.10 / 11.5 : backoff exponentiel déterministe `2000 * 2^attempt`.
 *   - 12.4 : masquage des données sensibles (≤ 8 caractères révélés).
 */

import { ProxyAgent } from "undici";

import {
  FRANCE_API_BASE,
  FRANCE_GOUV_WEB,
  FRANCE_MAX_RETRIES,
  FRANCE_RETRY_BACKOFF_MS,
  FRANCE_TIMEOUT_MS,
} from "./france-config.js";
import type {
  FranceAuthState,
  FranceHttpHeadResult,
  FranceHttpMethod,
  FranceHttpResult,
  FranceRequestOptions,
  FranceSlot,
} from "./france-types.js";

/**
 * Client HTTP stateful France (voir design.md → `france-http.ts`).
 *
 * Maintient l'état d'authentification anti-bot (jetons handshake) lié à un Job
 * et applique toutes les règles réseau (retries, backoff, 418/404/x-gouv-limit).
 */
export interface FranceHttpClient {
  /** GET avec headers x-gouv-* injectés, fetchWithRetry, gestion 418/404/x-gouv-limit. */
  get<T>(path: string, opts?: FranceRequestOptions): Promise<FranceHttpResult<T>>;
  /** POST sensible : inclut x-csrf-token. */
  post<T>(path: string, body: unknown, opts?: FranceRequestOptions): Promise<FranceHttpResult<T>>;
  /** HEAD (handshake) : pas de corps typé. */
  head(path: string, opts?: FranceRequestOptions): Promise<FranceHttpHeadResult>;
  /** Met à jour le x-csrf-token courant (réponse de session). */
  updateCsrf(token: string): void;
  /** État d'authentification anti-bot courant (lecture seule). */
  authState(): Readonly<FranceAuthState>;
}

// ---------------------------------------------------------------------------
// Constantes internes
// ---------------------------------------------------------------------------

/** Nombre maximal de caractères révélés par `maskSecret` (Requirement 12.4). */
const MASK_VISIBLE_CHARS = 8;

/** Suffixe ajouté aux valeurs masquées. */
const MASK_SUFFIX = "...";

// ---------------------------------------------------------------------------
// Helpers purs de calcul réseau
// ---------------------------------------------------------------------------

/**
 * Calcule le délai de backoff exponentiel pour une tentative donnée.
 *
 * Fonction pure et déterministe : `FRANCE_RETRY_BACKOFF_MS * 2^attempt`
 * (soit `2000 * 2^attempt` millisecondes), conformément à Property 3.
 *
 * @param attempt Numéro de tentative (0-indexé, `attempt >= 0`).
 * @returns Le délai de backoff en millisecondes.
 */
export function computeBackoffMs(attempt: number): number {
  return FRANCE_RETRY_BACKOFF_MS * 2 ** attempt;
}

/**
 * Construit les headers anti-bot pour une requête France.
 *
 * Fonction pure : injecte systématiquement `x-gouv-app-id` (= `auth.appId`) et
 * `x-gouv-web` (= `fr.gouv.consulat`, Requirement 1.6). Le header
 * `x-csrf-token` (= `auth.handshakeToken`) est ajouté UNIQUEMENT sur les
 * méthodes POST et PUT (Requirement 1.7).
 *
 * @param auth État d'authentification anti-bot courant.
 * @param method Méthode HTTP de la requête.
 * @returns Un dictionnaire de headers (clés en minuscules).
 */
/** Origine du portail public (headers Origin/Referer — requis par l'API Troov). */
const FRANCE_PORTAL_ORIGIN = "https://consulat.gouv.fr";

/** User-Agent navigateur réaliste (aligné sur le harnais live validé). */
const FRANCE_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function buildRequestHeaders(
  auth: FranceAuthState,
  method: FranceHttpMethod,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-gouv-app-id": auth.appId,
    "x-gouv-web": FRANCE_GOUV_WEB,
    // Headers navigateur exigés par l'API Troov (validés en live via
    // france-live-scan.mjs). Sans Origin/Referer, l'API répond 404/CAPTCHA_FAILED
    // de façon erratique. Clés en minuscules (normalisées par le client).
    "user-agent": FRANCE_BROWSER_UA,
    accept: "application/json, text/plain, */*",
    "accept-language": "fr-FR,fr;q=0.9",
    origin: FRANCE_PORTAL_ORIGIN,
    referer: `${FRANCE_PORTAL_ORIGIN}/`,
  };
  if (method === "POST" || method === "PUT") {
    headers["x-csrf-token"] = auth.handshakeToken;
  }
  return headers;
}

/**
 * Masque une valeur sensible pour le logging (Requirement 12.4, Property 30).
 *
 * Ne révèle jamais plus que les 8 premiers caractères de la valeur, suivis de
 * `...`. Pour une valeur de 8 caractères ou moins, tous les caractères
 * présents sont affichés (ce qui reste < 8 caractères révélés maximum), suivis
 * du suffixe. Une valeur vide est retournée telle quelle (rien à masquer).
 *
 * @param value La valeur sensible à masquer (token, clé, cookie, PII…).
 * @returns La forme masquée (≤ 8 caractères + `...`).
 */
export function maskSecret(value: string): string {
  if (value.length === 0) {
    return "";
  }
  return value.slice(0, MASK_VISIBLE_CHARS) + MASK_SUFFIX;
}
// ---------------------------------------------------------------------------
// Validateurs de DTO défensifs (fonctions pures)
// ---------------------------------------------------------------------------
//
// Principe (Requirement 12.2, Property 31) : toute réponse d'API externe non
// conforme au DTO attendu (champ manquant, type incorrect, format invalide)
// est rejetée — retour `null` pour les parseurs, `false` pour les prédicats —
// et AUCUNE donnée non validée n'est propagée en aval. Ces fonctions n'ont
// aucun effet de bord et ne font aucun accès réseau.

/**
 * Motif de validation d'une date `YYYY-MM-DD` :
 *   - année sur 4 chiffres,
 *   - mois `01`..`12`,
 *   - jour `01`..`31`.
 *
 * On borne le mois et le jour pour rejeter les formats structurellement
 * invalides (ex. `2026-13-40`) tout en restant tolérant sur la longueur des
 * mois (le portail est la source de vérité sur l'existence réelle du jour).
 */
const DATE_YYYY_MM_DD_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Motif de validation d'une heure `HH:MM` (`00`..`23` : `00`..`59`). */
const TIME_HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Motif d'une chaîne décimale à exactement deux décimales, ex. `0.00`. */
const RATE_TWO_DECIMALS_REGEX = /^\d+\.\d{2}$/;

/**
 * Indique si `value` est un objet non nul (et non un tableau) exploitable comme
 * enregistrement clé/valeur. Type guard pour restreindre `unknown`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Indique si `value` est une chaîne au format `YYYY-MM-DD`. */
function isDateString(value: unknown): value is string {
  return typeof value === "string" && DATE_YYYY_MM_DD_REGEX.test(value);
}

/**
 * Valide un créneau brut et le convertit en `FranceSlot` typé, ou retourne
 * `null` si non conforme.
 *
 * Conforme (Property 16) ssi :
 *   - `time` est une chaîne `HH:MM`,
 *   - `rate` est une chaîne décimale à deux décimales,
 *   - `capacity` est un entier strictement positif.
 */
function parseSlot(raw: unknown): FranceSlot | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { time, rate, capacity } = raw;
  if (typeof time !== "string" || !TIME_HH_MM_REGEX.test(time)) {
    return null;
  }
  if (typeof rate !== "string" || !RATE_TWO_DECIMALS_REGEX.test(rate)) {
    return null;
  }
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity <= 0) {
    return null;
  }
  return { time, rate, capacity };
}

/**
 * Parse et valide une réponse de créneaux (`GET /reservations/availability`).
 *
 * Retourne la liste des `FranceSlot` valides si l'entrée est un tableau dont
 * TOUS les éléments sont conformes au DTO. Rejette (`null`) toute entrée qui
 * n'est pas un tableau, ou qui contient au moins un créneau non conforme — on
 * ne propage jamais une réponse partiellement invalide (Property 31).
 *
 * @param raw Réponse brute non validée.
 * @returns La liste typée des créneaux, ou `null` si non conforme.
 */
export function parseSlots(raw: unknown): FranceSlot[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const slots: FranceSlot[] = [];
  for (const entry of raw) {
    const slot = parseSlot(entry);
    if (slot === null) {
      return null;
    }
    slots.push(slot);
  }
  return slots;
}

/**
 * Parse et valide une réponse de jours exclus (`POST /reservations/exclude-days`).
 *
 * Retourne `null` si l'entrée n'est pas un tableau (Property 31). Sinon, ne
 * conserve dans l'ensemble résultant QUE les valeurs qui sont des dates au
 * format `YYYY-MM-DD` ; toute valeur non conforme est écartée sans propagation
 * (Property 15).
 *
 * @param raw Réponse brute non validée.
 * @returns L'ensemble des dates valides `YYYY-MM-DD`, ou `null` si non-tableau.
 */
export function parseExcludeDays(raw: unknown): Set<string> | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const days = new Set<string>();
  for (const entry of raw) {
    if (isDateString(entry)) {
      days.add(entry);
    }
  }
  return days;
}

/**
 * Valide une fenêtre de scan brute (`GET /reservations/get-interval`).
 *
 * Retourne `true` ssi (Property 13) : `raw` est un objet portant `start` et
 * `end`, tous deux au format `YYYY-MM-DD`, avec `start <= end` (comparaison
 * lexicographique, équivalente à l'ordre chronologique pour ce format).
 *
 * @param raw Réponse brute non validée.
 * @returns `true` si la fenêtre est conforme, `false` sinon.
 */
export function isValidWindow(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  const { start, end } = raw;
  if (!isDateString(start) || !isDateString(end)) {
    return false;
  }
  return start <= end;
}

/**
 * Extrait l'identifiant de consulat d'une réponse `/team/slug/{slug}`.
 *
 * L'API `getPublicTeamBySlug` renvoie l'identifiant dans le champ **`_id`**
 * (confirmé live 2026-08-31). Par tolérance, on accepte aussi `teamId` s'il est
 * présent (autres endpoints / formes futures). Retourne la première chaîne non
 * vide trouvée parmi `_id` puis `teamId`, sinon `null`.
 *
 * @param raw Réponse brute non validée.
 * @returns L'identifiant de consulat (chaîne non vide) ou `null`.
 */
export function extractTeamId(raw: unknown): string | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (typeof raw._id === "string" && raw._id.length > 0) {
    return raw._id;
  }
  if (typeof raw.teamId === "string" && raw.teamId.length > 0) {
    return raw.teamId;
  }
  return null;
}

/**
 * Valide la présence d'un identifiant de consulat exploitable.
 *
 * Retourne `true` ssi (Property 6) `raw` est un objet portant un identifiant
 * non vide dans `_id` (champ réel de l'API) ou, par tolérance, `teamId`.
 *
 * @param raw Réponse brute non validée.
 * @returns `true` si un identifiant non vide est présent, `false` sinon.
 */
export function isValidTeamId(raw: unknown): boolean {
  return extractTeamId(raw) !== null;
}

/**
 * Valide la présence d'un `sessionId` exploitable (ouverture de session).
 *
 * Retourne `true` ssi (Property 9) `raw` est un objet dont le champ
 * `sessionId` est une chaîne non vide.
 *
 * @param raw Réponse brute non validée.
 * @returns `true` si `sessionId` est une chaîne non vide, `false` sinon.
 */
export function isValidSessionId(raw: unknown): boolean {
  return isRecord(raw) && typeof raw.sessionId === "string" && raw.sessionId.length > 0;
}

// ---------------------------------------------------------------------------
// Client HTTP stateful (createFranceHttpClient + fetchWithRetry)
// ---------------------------------------------------------------------------
//
// Comportement clé (Requirements 1.6–1.10, 8.5, 11.3–11.6, 12.5) :
//   - Chaque requête injecte `x-gouv-app-id` + `x-gouv-web` ; POST/PUT ajoutent
//     `x-csrf-token` (via buildRequestHeaders).
//   - Timeout 30 s via AbortController (FRANCE_TIMEOUT_MS).
//   - Retry sur erreur réseau ou statut >= 500, max FRANCE_MAX_RETRIES, backoff
//     exponentiel x2 (computeBackoffMs). Pas de retry sur 4xx SAUF 418.
//   - HTTP 418 → onRehandshake() puis rejeu de la requête d'origine (max 3
//     handshakes) ; met à jour l'auth state avec le nouveau handshake.
//   - HTTP 404 + { message: "SESSION_ERROR" } → sessionError: true, pas de retry
//     (laissé à france-session).
//   - Header `x-gouv-limit` (rate limit atteint) → backoff avant la requête
//     suivante.
//   - try/catch contextuel `[franceHunter]`, secrets masqués via maskSecret.

/** Statut HTTP « I'm a teapot » : handshake absent/invalide → re-handshake. */
const HTTP_TEAPOT = 418;

/** Statut HTTP à partir duquel une erreur est considérée serveur (retry). */
const HTTP_SERVER_ERROR_MIN = 500;

/** Statut HTTP « Too Many Requests » : rate limit → backoff + retry. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** Backoff plancher (ms) appliqué sur un 429 sans en-tête `Retry-After`. */
const RATE_LIMIT_MIN_BACKOFF_MS = 5_000;

/**
 * Parse l'en-tête `Retry-After` en millisecondes (fonction pure).
 *
 * Supporte le format « delta-seconds » (entier). Retourne `null` si absent ou
 * non numérique (le format date HTTP n'est pas utilisé par ce portail).
 *
 * @param value Valeur brute de l'en-tête `Retry-After`.
 * @returns Le délai en ms, ou `null`.
 */
function parseRetryAfterMs(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  return null;
}

/** Statut HTTP « Not Found » : peut porter un message `SESSION_ERROR`. */
const HTTP_NOT_FOUND = 404;

/** Message renvoyé par le portail dans un 404 signalant une session invalide. */
const SESSION_ERROR_MESSAGE = "SESSION_ERROR";

/** Nombre maximal de re-handshakes déclenchés par des 418 pour une requête. */
const MAX_HANDSHAKES = 3;

/** Header signalant qu'une limite de débit a été atteinte. */
const RATE_LIMIT_HEADER = "x-gouv-limit";

/**
 * Header portant un handshake RAFRAÎCHI dans les réponses (rejoué en
 * `x-csrf-token`). VALIDÉ LIVE 2026-09-01 : `POST reservations-session` renvoie
 * un nouveau `x-gouv-handshake` qu'il FAUT rejouer sur les POST suivants
 * (update-step-value / update-dynamic-steps / reservations/family). Sans ce
 * rafraîchissement, ces POST pendent (timeout).
 */
const HANDSHAKE_RESPONSE_HEADER = "x-gouv-handshake";

/** Pause asynchrone (backoff). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Indique si une erreur est d'origine réseau/transitoire (timeout, reset,
 * connexion refusée, abort). Ces erreurs sont éligibles au retry.
 */
function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
  const haystack = `${msg} ${causeMsg}`;
  return (
    haystack.includes("ConnectTimeout") ||
    haystack.includes("ECONNRESET") ||
    haystack.includes("ECONNREFUSED") ||
    haystack.includes("UND_ERR_CONNECT_TIMEOUT") ||
    haystack.includes("ETIMEDOUT") ||
    haystack.includes("aborted") ||
    haystack.includes("This operation was aborted") ||
    haystack.includes("fetch failed")
  );
}

/** Convertit les headers d'une réponse `Response` en Record (clés minuscules). */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

/** Construit l'URL complète (base + path + query string éventuelle). */
function buildUrl(path: string, query?: Record<string, string>): string {
  const base = path.startsWith("http")
    ? path
    : `${FRANCE_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query || Object.keys(query).length === 0) {
    return base;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, value);
  }
  return `${base}?${params.toString()}`;
}

/**
 * Extrait le message d'erreur d'un corps de réponse déjà parsé, s'il porte un
 * champ `message` de type chaîne. Retourne `undefined` sinon.
 */
function extractMessage(body: unknown): string | undefined {
  if (isRecord(body) && typeof body.message === "string") {
    return body.message;
  }
  return undefined;
}

/**
 * Fabrique le client HTTP France lié à un `proxyUrl` (proxy résidentiel FR
 * stable pour toute la session) et à un `auth` state mutable, avec un callback
 * `onRehandshake` invoqué sur HTTP 418.
 *
 * @param auth État d'authentification anti-bot initial (muté sur re-handshake
 *   et via `updateCsrf`).
 * @param proxyUrl URL du proxy résidentiel FR (dispatcher undici).
 * @param onRehandshake Callback rejouant un handshake ; retourne le nouvel état
 *   d'auth ou `null` si le handshake a échoué.
 * @returns Un `FranceHttpClient` prêt à l'emploi.
 */
export function createFranceHttpClient(
  auth: FranceAuthState,
  proxyUrl: string,
  onRehandshake: () => Promise<FranceAuthState | null>,
): FranceHttpClient {
  // Auth state courant (muté sur re-handshake / updateCsrf), isolé par Job.
  const state: FranceAuthState = { ...auth };

  // Dispatcher proxy stable pour toute la durée de vie du client (même IP de
  // sortie pour toute la session — Requirement 11.3).
  //
  // Le proxy est OPTIONNEL : si `proxyUrl` est vide/blanc, on n'installe aucun
  // dispatcher (connexion directe). En production le proxy résidentiel FR est
  // toujours fourni ; le mode direct sert aux diagnostics locaux (Req 11.3
  // inchangé dès qu'un proxy est présent).
  const dispatcher =
    proxyUrl.trim().length > 0 ? new ProxyAgent(proxyUrl) : undefined;

  // Backoff à appliquer AVANT la prochaine requête, armé par un x-gouv-limit.
  let pendingRateLimitBackoffMs = 0;

  /**
   * Exécute une requête HTTP avec toutes les règles réseau (retries, backoff,
   * timeout, 418 → re-handshake, 404 SESSION_ERROR, x-gouv-limit).
   *
   * Retourne l'objet `Response` brut ainsi qu'un éventuel corps texte déjà lu,
   * et des drapeaux normalisés. Le parsing JSON typé est délégué aux méthodes
   * publiques.
   */
  async function fetchWithRetry(
    method: FranceHttpMethod,
    path: string,
    body: unknown,
    opts: FranceRequestOptions | undefined,
  ): Promise<{
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    rawBody: string;
    sessionError: boolean;
    teapot: boolean;
  }> {
    const url = buildUrl(path, opts?.query);
    const timeoutMs = opts?.timeoutMs ?? FRANCE_TIMEOUT_MS;
    const maxRetries = opts?.maxRetries ?? FRANCE_MAX_RETRIES;

    let handshakeCount = 0;
    let attempt = 0;
    let lastError: unknown;

    // Boucle de tentatives (retries réseau/5xx + rejeu après re-handshake 418).
    while (attempt < maxRetries) {
      // Backoff dû à un rate limit signalé précédemment.
      if (pendingRateLimitBackoffMs > 0) {
        await sleep(pendingRateLimitBackoffMs);
        pendingRateLimitBackoffMs = 0;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const signal = opts?.signal
        ? anyAbortSignal(controller.signal, opts.signal)
        : controller.signal;

      try {
        const headers: Record<string, string> = {
          ...buildRequestHeaders(state, method),
          ...(opts?.headers ?? {}),
        };
        const hasBody = method === "POST" || method === "PUT";
        if (hasBody && body !== undefined && headers["content-type"] === undefined) {
          headers["content-type"] = "application/json";
        }

        const response = await fetch(url, {
          method,
          headers,
          body: hasBody && body !== undefined ? JSON.stringify(body) : undefined,
          signal,
          // `dispatcher` undefined = connexion directe (proxy optionnel).
          ...(dispatcher !== undefined ? { dispatcher } : {}),
        } as RequestInit & { dispatcher?: ProxyAgent });
        clearTimeout(timeout);

        const respHeaders = headersToRecord(response.headers);

        // Mémoriser le dernier x-gouv-limit observé ; armer un backoff avant la
        // requête suivante si une limite est signalée (Requirement 11.6).
        const rateLimit = respHeaders[RATE_LIMIT_HEADER];
        if (rateLimit !== undefined) {
          state.rateLimit = rateLimit;
          pendingRateLimitBackoffMs = computeBackoffMs(attempt);
        }

        // Rafraîchir le x-csrf-token depuis le header handshake de la réponse
        // (validé live) : le serveur fait tourner le jeton anti-bot. Sans ce
        // rejeu, les POST d'écriture suivants (update-step-value, etc.) pendent.
        const refreshedHandshake = respHeaders[HANDSHAKE_RESPONSE_HEADER];
        if (refreshedHandshake !== undefined && refreshedHandshake.length > 0) {
          state.handshakeToken = refreshedHandshake;
        }

        const status = response.status;

        // HTTP 418 : handshake absent/invalide → re-handshake puis rejeu.
        if (status === HTTP_TEAPOT) {
          if (handshakeCount >= MAX_HANDSHAKES) {
            return {
              status,
              ok: false,
              headers: respHeaders,
              rawBody: "",
              sessionError: false,
              teapot: true,
            };
          }
          handshakeCount += 1;
          const refreshed = await onRehandshake();
          if (refreshed === null) {
            return {
              status,
              ok: false,
              headers: respHeaders,
              rawBody: "",
              sessionError: false,
              teapot: true,
            };
          }
          // Mise à jour de l'auth state avec le nouveau handshake, puis rejeu
          // SANS consommer de tentative de retry réseau.
          state.handshakeToken = refreshed.handshakeToken;
          state.appId = refreshed.appId;
          if (refreshed.rateLimit !== undefined) {
            state.rateLimit = refreshed.rateLimit;
          }
          continue;
        }

        const rawBody = await response.text().catch(() => "");

        // HTTP 404 + SESSION_ERROR → remonté sans retry (france-session gère).
        if (status === HTTP_NOT_FOUND) {
          const parsed = safeJsonParse(rawBody);
          if (extractMessage(parsed) === SESSION_ERROR_MESSAGE) {
            return {
              status,
              ok: false,
              headers: respHeaders,
              rawBody,
              sessionError: true,
              teapot: false,
            };
          }
        }

        // HTTP 429 : rate limit → backoff (respecte `Retry-After` si présent)
        // puis retry. Le portail Troov limite les appels rapprochés
        // (availability) ; sans ce backoff, tous les jours suivants échouent.
        if (status === HTTP_TOO_MANY_REQUESTS) {
          attempt += 1;
          if (attempt >= maxRetries) {
            return {
              status,
              ok: false,
              headers: respHeaders,
              rawBody,
              sessionError: false,
              teapot: false,
            };
          }
          const retryAfterMs = parseRetryAfterMs(respHeaders["retry-after"]);
          const backoffMs = Math.max(
            RATE_LIMIT_MIN_BACKOFF_MS,
            retryAfterMs ?? computeBackoffMs(attempt - 1),
          );
          console.error(
            `[franceHunter] HTTP 429 (rate limit) ${method} ${maskSecret(url)} — ` +
              `backoff ${backoffMs} ms (tentative ${attempt}/${maxRetries}).`,
          );
          await sleep(backoffMs);
          continue;
        }

        // Statut serveur (>= 500) → retry avec backoff.
        if (status >= HTTP_SERVER_ERROR_MIN) {
          attempt += 1;
          if (attempt >= maxRetries) {
            return {
              status,
              ok: false,
              headers: respHeaders,
              rawBody,
              sessionError: false,
              teapot: false,
            };
          }
          await sleep(computeBackoffMs(attempt - 1));
          continue;
        }

        // Succès (2xx/3xx) ou 4xx non-retryable (hors 418/404 SESSION_ERROR).
        return {
          status,
          ok: response.ok,
          headers: respHeaders,
          rawBody,
          sessionError: false,
          teapot: false,
        };
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (!isTransientNetworkError(error)) {
          console.error(
            `[franceHunter] Erreur HTTP non transitoire ${method} ${maskSecret(url)}:`,
            error instanceof Error ? error.message : error,
          );
          throw error;
        }
        attempt += 1;
        if (attempt >= maxRetries) {
          break;
        }
        console.error(
          `[franceHunter] Erreur réseau ${method} ${maskSecret(url)} (tentative ${attempt}/${maxRetries}), retry…`,
          error instanceof Error ? error.message : error,
        );
        await sleep(computeBackoffMs(attempt - 1));
      }
    }

    throw new Error(
      `[franceHunter] Échec ${method} ${maskSecret(url)} après ${maxRetries} tentatives : ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  return {
    async get<T>(path: string, opts?: FranceRequestOptions): Promise<FranceHttpResult<T>> {
      const res = await fetchWithRetry("GET", path, undefined, opts);
      return toResult<T>(res);
    },

    async post<T>(
      path: string,
      body: unknown,
      opts?: FranceRequestOptions,
    ): Promise<FranceHttpResult<T>> {
      const res = await fetchWithRetry("POST", path, body, opts);
      return toResult<T>(res);
    },

    async head(path: string, opts?: FranceRequestOptions): Promise<FranceHttpHeadResult> {
      const res = await fetchWithRetry("HEAD", path, undefined, opts);
      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        teapot: res.teapot,
      };
    },

    updateCsrf(token: string): void {
      state.handshakeToken = token;
    },

    authState(): Readonly<FranceAuthState> {
      return { ...state };
    },
  };
}

/**
 * Compose deux `AbortSignal` : le signal résultant s'annule dès que l'un des
 * deux s'annule (timeout interne OU signal externe fourni par l'appelant).
 */
function anyAbortSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
  } else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/** Parse une chaîne JSON en tolérant l'échec (retourne `null`). */
function safeJsonParse(raw: string): unknown {
  if (raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Convertit le résultat interne de `fetchWithRetry` en `FranceHttpResult<T>`
 * (corps JSON parsé de façon défensive, `null` si absent/illisible).
 */
function toResult<T>(res: {
  status: number;
  ok: boolean;
  rawBody: string;
  sessionError: boolean;
  teapot: boolean;
}): FranceHttpResult<T> {
  const parsed = (safeJsonParse(res.rawBody) as T | null); // DIAG: parse même en échec pour voir le message 404
  return {
    status: res.status,
    ok: res.ok,
    body: parsed,
    sessionError: res.sessionError,
    teapot: res.teapot,
  };
}
