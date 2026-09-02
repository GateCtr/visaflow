/**
 * France Visa Hunter — Session de réservation et gestion du TTL.
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « Components and Interfaces » → `france-session.ts`,
 * Correctness Properties 11 et 12).
 *
 * Ce fichier contient :
 *   - les fonctions PURES de TTL (`shouldRenewSession`, `isSessionExpired`,
 *     task 6.1),
 *   - l'ouverture de session (`openSession`) et la mise à jour du
 *     `x-csrf-token` depuis la réponse (task 6.3).
 *
 * Règles projet appliquées :
 *   - TypeScript strict, aucun `any`, type de retour explicite.
 *   - Fonctions camelCase.
 *   - Le temps est INJECTÉ via le paramètre `nowMs` : aucun `Date.now()`
 *     implicite, pour des tests déterministes.
 *   - Logs/erreurs préfixés `[franceHunter]`, secrets masqués via `maskSecret`.
 *
 * Requirements couverts : 4.1 (POST reservations-session avec Turnstile #1),
 * 4.2 (validation sessionId non vide), 4.3 (mise à jour x-csrf-token),
 * 4.4 (expiration 30 min), 4.5/4.6 (3 tentatives puis abandon),
 * 5.1 (TTL 30 min), 5.2 (renouvellement anticipé 25 min),
 * 5.3 (SESSION_ERROR), 5.4/5.5 (renouvellement).
 */

import type { ReservationSession } from "./france-types.js";
import {
  type FranceHttpClient,
  computeBackoffMs,
  maskSecret,
} from "./france-http.js";
import {
  FRANCE_MAX_RETRIES,
  FRANCE_SESSION_RENEW_MS,
  FRANCE_SESSION_TTL_MS,
} from "./france-config.js";

/**
 * Pure : indique si la session doit être renouvelée de façon anticipée.
 *
 * Property 12 (Renouvellement anticipé à 25 minutes) : retourne `true` si et
 * seulement si le temps écoulé depuis l'ouverture atteint ou dépasse
 * `FRANCE_SESSION_RENEW_MS` (25 min). Le temps est injecté via `nowMs`.
 *
 * @param session Session de réservation active.
 * @param nowMs Instant courant en millisecondes (injecté).
 * @returns `true` ssi `nowMs - session.openedAtMs >= FRANCE_SESSION_RENEW_MS`.
 */
export function shouldRenewSession(
  session: ReservationSession,
  nowMs: number,
): boolean {
  return nowMs - session.openedAtMs >= FRANCE_SESSION_RENEW_MS;
}

/**
 * Pure : indique si la session est expirée.
 *
 * Property 11 (Expiration de session à 30 minutes exactement) : retourne
 * `true` si et seulement si le temps écoulé depuis l'ouverture atteint ou
 * dépasse le TTL (30 min). Le temps est injecté via `nowMs`.
 *
 * On respecte le TTL porté par la session (`session.ttlMs`) lorsqu'il est un
 * nombre fini et positif ; à défaut, on retombe sur la constante
 * `FRANCE_SESSION_TTL_MS` (30 min), conformément à Property 11.
 *
 * @param session Session de réservation active.
 * @param nowMs Instant courant en millisecondes (injecté).
 * @returns `true` ssi `nowMs - session.openedAtMs >= TTL`.
 */
export function isSessionExpired(
  session: ReservationSession,
  nowMs: number,
): boolean {
  const ttlMs =
    Number.isFinite(session.ttlMs) && session.ttlMs > 0
      ? session.ttlMs
      : FRANCE_SESSION_TTL_MS;
  return nowMs - session.openedAtMs >= ttlMs;
}

// ---------------------------------------------------------------------------
// Ouverture de session de réservation (task 6.3)
// ---------------------------------------------------------------------------
//
// Comportement clé (Requirements 4.1–4.3, 4.5, 4.6, 5.3–5.5) :
//   - POST /team/{teamId}/reservations-session avec le corps
//     { standaloneServiceName, captcha } (SANS sessionId — validé live : un
//     sessionId dans le body fait répondre l'API HTTP 404). Le `captcha` porte
//     le token Turnstile d'ouverture (Turnstile #1). Le sessionId est RETOURNÉ
//     par la réponse (champ `_id`).
//   - Le client HTTP (`http.post`) gère déjà en interne, PAR REQUÊTE, le
//     timeout 30 s, les retries réseau/5xx avec backoff exponentiel, le 418
//     (re-handshake) et le x-gouv-limit. Ici on entoure l'appel LOGIQUE d'une
//     boucle de FRANCE_MAX_RETRIES (= 3) tentatives : on réessaie lorsque
//     l'ouverture ne rend pas un sessionId valide (Req 4.5), en insérant un
//     backoff `computeBackoffMs` entre deux tentatives logiques.
//   - sessionId extrait de la réponse via `extractSessionId` (`_id` en priorité).
//   - Si un nouveau handshake/token est fourni dans le corps de la réponse
//     (champ `handshake` ou `token`), on met à jour le `x-csrf-token` via
//     `http.updateCsrf` (Req 4.3).
//   - Détection de SESSION_ERROR (result.sessionError) : session à traiter
//     comme expirée ; on abandonne l'ouverture (le re-bootstrap complet est
//     orchestré par france-hunter, Req 5.3).
//   - Retourne une ReservationSession { sessionId, openedAtMs: nowMs,
//     ttlMs: FRANCE_SESSION_TTL_MS } ou `null` après 3 échecs (Req 4.6/5.5).

/** Chemin de l'endpoint d'ouverture de session (relatif à FRANCE_API_BASE). */
const RESERVATIONS_SESSION_PATH = (teamId: string): string =>
  `/team/${teamId}/reservations-session`;

/**
 * Corps envoyé au POST d'ouverture de session.
 *
 * Le portail Troov attend un `sessionId` généré côté client ; le token
 * Turnstile #1 est placé dans le champ `captcha`.
 */
interface OpenSessionBody {
  standaloneServiceName: string;
  captcha: string;
}

/**
 * Forme (partielle) de la réponse d'ouverture de session telle qu'exploitée
 * ici. Tous les champs sont optionnels : la réponse est validée défensivement
 * (aucune donnée non validée n'est propagée).
 */
interface OpenSessionResponse {
  /** Identifiant de la session de réservation (champ réel de la réponse). */
  _id?: unknown;
  /** Nommage alternatif de l'identifiant. */
  id?: unknown;
  /** sessionId éventuel (tolérance). */
  sessionId?: unknown;
  /** Session imbriquée éventuelle. */
  session?: unknown;
  /** Nouveau handshake éventuel (rejoué en x-csrf-token). */
  handshake?: unknown;
  /** Nouveau token CSRF éventuel (nommage alternatif du handshake). */
  token?: unknown;
}

/**
 * Extrait l'identifiant de session d'une réponse d'ouverture (fonction pure).
 *
 * L'API renvoie l'identifiant dans `_id` (validé live 2026-08-31). Par
 * tolérance, on accepte aussi `id`, `sessionId`, puis `session._id`/`session.id`.
 * Retourne la première chaîne non vide trouvée, sinon `null`.
 */
function extractSessionId(body: OpenSessionResponse | null): string | null {
  if (body === null) {
    return null;
  }
  for (const key of ["_id", "id", "sessionId"] as const) {
    const v = body[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  const nested = body.session;
  if (typeof nested === "object" && nested !== null) {
    const rec = nested as Record<string, unknown>;
    for (const key of ["_id", "id"]) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) {
        return v;
      }
    }
  }
  return null;
}

/** Pause asynchrone (backoff entre tentatives logiques). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extrait un nouveau token CSRF/handshake de la réponse d'ouverture de session.
 *
 * On cherche, dans l'ordre, le champ `handshake` puis `token` du corps de la
 * réponse. Retourne une chaîne non vide, ou `undefined` si aucun nouveau token
 * n'est fourni. (Le client HTTP normalise les résultats POST sans exposer les
 * headers ; le handshake de session est porté par le corps.)
 */
function extractNewCsrf(body: OpenSessionResponse | null): string | undefined {
  if (body === null) {
    return undefined;
  }
  if (typeof body.handshake === "string" && body.handshake.length > 0) {
    return body.handshake;
  }
  if (typeof body.token === "string" && body.token.length > 0) {
    return body.token;
  }
  return undefined;
}

/**
 * Ouvre une session de réservation via `POST /team/{teamId}/reservations-session`.
 *
 * Envoie le corps `{ standaloneServiceName, captcha }` (SANS sessionId — un
 * sessionId dans le body fait répondre l'API 404). Le sessionId est extrait de
 * la réponse via `extractSessionId` (`_id`). Met à jour le
 * `x-csrf-token` si un nouveau handshake est fourni. Réessaie jusqu'à
 * `FRANCE_MAX_RETRIES` fois (backoff exponentiel entre tentatives logiques) tant
 * que l'ouverture ne produit pas de sessionId valide.
 *
 * @param http Client HTTP France lié au Job (proxy/auth isolés).
 * @param teamId Identifiant du consulat résolu (non vide).
 * @param standaloneServiceName Nom textuel complet du service cible.
 * @param turnstileToken Token Turnstile #1 (ouverture de session).
 * @param nowMs Instant courant en millisecondes (injecté).
 * @returns La `ReservationSession` ouverte, ou `null` après 3 échecs / SESSION_ERROR.
 */
export async function openSession(
  http: FranceHttpClient,
  teamId: string,
  standaloneServiceName: string,
  turnstileToken: string,
  nowMs: number,
): Promise<ReservationSession | null> {
  const path = RESERVATIONS_SESSION_PATH(teamId);

  for (let attempt = 0; attempt < FRANCE_MAX_RETRIES; attempt += 1) {
    // sessionId client généré à CHAQUE tentative logique (le portail Troov
    // attend un sessionId fourni par le client).
    // IMPORTANT (validé live 2026-08-31) : le POST reservations-session NE doit
    // PAS porter de `sessionId` dans le body. Envoyer un sessionId client
    // (UUID) fait répondre l'API HTTP 404 NotFound. Le body attendu est
    // strictement { standaloneServiceName, captcha } ; le sessionId est retourné
    // par la réponse (champ `_id`).
    const body: OpenSessionBody = {
      standaloneServiceName,
      captcha: turnstileToken,
    };

    try {
      const result = await http.post<OpenSessionResponse>(path, body);

      // 404 { message: "SESSION_ERROR" } → session à traiter comme expirée ;
      // le re-bootstrap complet est orchestré en amont (france-hunter, Req 5.3).
      if (result.sessionError) {
        console.error(
          `[franceHunter] Ouverture de session refusée (SESSION_ERROR) pour team ${maskSecret(teamId)} ` +
            `(tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}) — session traitée comme expirée.`,
        );
        return null;
      }

      // Statut HTTP >= 400 (hors 418/404 gérés par le client) → échec logique,
      // on réessaie (Req 4.5).
      if (result.ok) {
        // Le x-csrf-token est rafraîchi dans le client HTTP (`fetchWithRetry`)
        // depuis le HEADER `x-gouv-handshake` de la réponse (source fiable
        // validée live). En complément, si le BODY porte un handshake/token, on
        // le rejoue aussi (Req 4.3) — sans effet néfaste si identique.
        const newCsrf = extractNewCsrf(result.body);
        if (newCsrf !== undefined) {
          http.updateCsrf(newCsrf);
        }

        // Le sessionId est retourné par la réponse : champ `_id` (ou `id` /
        // `sessionId` / `session._id` en tolérance). Validé live : la réponse
        // 200 porte l'`_id` de la session de réservation.
        const sessionId = extractSessionId(result.body);

        if (sessionId !== null && sessionId.length > 0) {
          return {
            sessionId,
            openedAtMs: nowMs,
            ttlMs: FRANCE_SESSION_TTL_MS,
          };
        }

        console.error(
          `[franceHunter] Ouverture de session : sessionId absent/invalide ` +
            `(tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}, HTTP ${result.status}).`,
        );
      } else {
        console.error(
          `[franceHunter] Ouverture de session échouée pour team ${maskSecret(teamId)} ` +
            `(tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}, HTTP ${result.status}).`,
        );
      }
    } catch (error) {
      console.error(
        `[franceHunter] Erreur lors de l'ouverture de session (tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}) :`,
        error instanceof Error ? error.message : error,
      );
    }

    // Backoff exponentiel entre deux tentatives LOGIQUES (Req 4.5), sauf après
    // la dernière.
    if (attempt < FRANCE_MAX_RETRIES - 1) {
      await sleep(computeBackoffMs(attempt));
    }
  }

  console.error(
    `[franceHunter] Ouverture de session abandonnée après ${FRANCE_MAX_RETRIES} tentatives ` +
      `(team ${maskSecret(teamId)}) — état du Job inchangé.`,
  );
  return null;
}
