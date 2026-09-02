/**
 * France Visa Hunter — Handshake anti-bot et résolution consulat.
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « Components and Interfaces » → `france-handshake.ts`).
 *
 * Ce fichier héberge d'abord les fonctions PURES du handshake (aucun effet de
 * bord, aucun accès réseau) : extraction des jetons anti-bot depuis les headers
 * de réponse et validation de leur présence. Les fonctions réseau
 * (`performHandshake`, `resolveTeam`) sont ajoutées par la task 4.3 dans ce
 * même fichier.
 *
 * Règles projet appliquées :
 *   - TypeScript strict, aucun `any`, types de retour explicites.
 *   - Fonctions en camelCase.
 *   - Les clés de header sont lues en minuscules (le client HTTP normalise les
 *     headers en minuscules).
 *
 * Requirements couverts par les helpers purs :
 *   - 1.2 : extraction du header `x-gouv-handshake` → `handshakeToken`.
 *   - 1.4 : extraction du header `x-gouv-app-id` → `appId`.
 *   - 1.3 / 1.5 : handshake valide ssi les deux jetons sont présents et non
 *     vides (chaîne blanche/whitespace exclue).
 */

import { ProxyAgent } from "undici";

import {
  FRANCE_API_BASE,
  FRANCE_MAX_RETRIES,
  FRANCE_TIMEOUT_MS,
} from "./france-config.js";
import {
  computeBackoffMs,
  extractTeamId,
  maskSecret,
  type FranceHttpClient,
} from "./france-http.js";
import type { FranceAuthState } from "./france-types.js";

// ---------------------------------------------------------------------------
// Constantes de headers (clés en minuscules — normalisées par le client HTTP)
// ---------------------------------------------------------------------------

/** Header portant le jeton handshake (rejoué en `x-csrf-token`). */
const HANDSHAKE_HEADER = "x-gouv-handshake";

/** Header portant l'identifiant d'application anti-bot. */
const APP_ID_HEADER = "x-gouv-app-id";

/** Header optionnel signalant l'état du rate limiting serveur. */
const RATE_LIMIT_HEADER = "x-gouv-limit";

// ---------------------------------------------------------------------------
// Helpers purs de handshake
// ---------------------------------------------------------------------------

/**
 * Extrait l'état d'authentification anti-bot depuis les headers de réponse du
 * handshake (fonction pure).
 *
 * `handshakeToken` provient du header `x-gouv-handshake`, `appId` du header
 * `x-gouv-app-id`. Le header `x-gouv-limit`, s'il est présent, est copié dans
 * `rateLimit`. Les valeurs absentes sont normalisées en chaîne vide (la
 * validité est déterminée séparément par `isHandshakeValid`).
 *
 * @param headers Headers de réponse (clés en minuscules).
 * @returns Un `FranceAuthState` reflétant les jetons observés.
 */
export function parseHandshakeHeaders(headers: Record<string, string>): FranceAuthState {
  const authState: FranceAuthState = {
    handshakeToken: headers[HANDSHAKE_HEADER] ?? "",
    appId: headers[APP_ID_HEADER] ?? "",
  };
  const rateLimit = headers[RATE_LIMIT_HEADER];
  if (rateLimit !== undefined) {
    authState.rateLimit = rateLimit;
  }
  return authState;
}

/**
 * Indique si les headers du handshake sont valides (fonction pure).
 *
 * Le handshake est valide si et seulement si `x-gouv-handshake` ET
 * `x-gouv-app-id` sont tous deux présents et non vides une fois débarrassés de
 * leurs espaces (chaîne blanche/whitespace exclue) — Requirements 1.3, 1.5.
 *
 * @param headers Headers de réponse (clés en minuscules).
 * @returns `true` ssi les deux jetons sont non vides après `trim`.
 */
export function isHandshakeValid(headers: Record<string, string>): boolean {
  const handshakeToken = (headers[HANDSHAKE_HEADER] ?? "").trim();
  const appId = (headers[APP_ID_HEADER] ?? "").trim();
  return handshakeToken.length > 0 && appId.length > 0;
}

// ---------------------------------------------------------------------------
// Fonctions réseau : bootstrap handshake et résolution consulat
// ---------------------------------------------------------------------------
//
// Comportement clé (Requirements 1.1, 1.8–1.10, 2.1–2.4) :
//   - `performHandshake` : HEAD /handshake via undici ProxyAgent, timeout 30 s
//     (AbortController), retries backoff exponentiel (max 3, computeBackoffMs).
//     Retourne `null` après échec des 3 tentatives, jamais d'exception propagée.
//   - `resolveTeam` : GET /team/slug/{slug}?lang=fr via le client HTTP fourni
//     (qui gère lui-même retries/proxy/418), validation `teamId` non vide.
//     Retourne `null` si absent/invalide, sans mutation d'état.
//   - Logs préfixés `[franceHunter]`, secrets masqués via `maskSecret`.

/** Chemin du bootstrap anti-bot. */
const HANDSHAKE_PATH = "/handshake";

/** Pause asynchrone (backoff). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalise les headers d'une réponse `Response` en `Record` (clés minuscules),
 * afin de les passer aux helpers purs `parseHandshakeHeaders` / `isHandshakeValid`.
 */
function normalizeHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

/**
 * Exécute le bootstrap anti-bot du portail France (Requirements 1.1, 1.8–1.10).
 *
 * Envoie `HEAD /handshake` sur `FRANCE_API_BASE` à travers le proxy résidentiel
 * FR (dispatcher undici), avec un timeout de 30 s (`FRANCE_TIMEOUT_MS`) armé par
 * un `AbortController`. Les headers de réponse sont normalisés en minuscules,
 * puis les jetons anti-bot (`x-gouv-handshake` → `handshakeToken`,
 * `x-gouv-app-id` → `appId`) sont extraits via `parseHandshakeHeaders` et
 * validés via `isHandshakeValid`.
 *
 * En cas d'échec (erreur réseau, timeout, ou handshake absent/invalide), la
 * tentative est réessayée avec un backoff exponentiel (`computeBackoffMs`),
 * jusqu'à `FRANCE_MAX_RETRIES` (3) tentatives. Retourne `null` après épuisement
 * des tentatives — aucune exception n'est propagée à l'appelant.
 *
 * Le HEAD de handshake n'émet PAS de headers `x-gouv-*` : c'est précisément ce
 * bootstrap qui les produit.
 *
 * @param proxyUrl URL du proxy résidentiel FR (dispatcher undici).
 * @returns L'`FranceAuthState` validé, ou `null` après échec des 3 tentatives.
 */
export async function performHandshake(proxyUrl: string): Promise<FranceAuthState | null> {
  // Proxy OPTIONNEL : `proxyUrl` vide/blanc → connexion directe (aucun
  // dispatcher). En production le proxy résidentiel FR est toujours fourni ;
  // le mode direct sert aux diagnostics locaux.
  const dispatcher =
    proxyUrl.trim().length > 0 ? new ProxyAgent(proxyUrl) : undefined;
  const url = `${FRANCE_API_BASE}${HANDSHAKE_PATH}`;

  for (let attempt = 0; attempt < FRANCE_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FRANCE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        // Headers navigateur (Origin/Referer/UA/Accept) exigés par l'API Troov,
        // alignés sur le harnais live validé (france-live-scan.mjs).
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          accept: "application/json, text/plain, */*",
          "accept-language": "fr-FR,fr;q=0.9",
          origin: "https://consulat.gouv.fr",
          referer: "https://consulat.gouv.fr/",
        },
        signal: controller.signal,
        // `dispatcher` undefined = connexion directe (proxy optionnel).
        ...(dispatcher !== undefined ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: ProxyAgent });
      clearTimeout(timeout);

      const headers = normalizeHeaders(response.headers);
      if (!isHandshakeValid(headers)) {
        console.error(
          `[franceHunter] Handshake invalide/absent (HTTP ${response.status}, ` +
            `tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}).`,
        );
        if (attempt < FRANCE_MAX_RETRIES - 1) {
          await sleep(computeBackoffMs(attempt));
        }
        continue;
      }

      const authState = parseHandshakeHeaders(headers);
      console.log(
        `[franceHunter] Handshake obtenu (appId=${maskSecret(authState.appId)}, ` +
          `handshakeToken=${maskSecret(authState.handshakeToken)}).`,
      );
      return authState;
    } catch (error) {
      clearTimeout(timeout);
      console.error(
        `[franceHunter] Échec du handshake (tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}):`,
        error instanceof Error ? error.message : error,
      );
      if (attempt < FRANCE_MAX_RETRIES - 1) {
        await sleep(computeBackoffMs(attempt));
      }
    }
  }

  console.error(
    `[franceHunter] Handshake abandonné après ${FRANCE_MAX_RETRIES} tentatives.`,
  );
  return null;
}

/**
 * Résout le `teamId` d'un consulat à partir de son slug (Requirements 2.1–2.4).
 *
 * Envoie `GET /team/slug/{slug}?lang=fr` via le client HTTP fourni. Ce client
 * applique lui-même le timeout, les retries/backoff et le routage proxy ; il
 * n'est donc pas nécessaire de réimplémenter la logique de retry ici.
 *
 * La réponse est validée via `isValidTeamId` (champ `teamId` chaîne non vide).
 * En cas de statut non-OK, de corps absent, ou de `teamId` absent/invalide, la
 * fonction enregistre une erreur préfixée `[franceHunter]` incluant le slug et
 * retourne `null` — sans muter aucun état.
 *
 * @param http Client HTTP France lié au Job (proxy + auth anti-bot).
 * @param slug Slug du consulat, ex. `ambassade-de-france-a-kinshasa`.
 * @returns `{ teamId }` si résolu et valide, `null` sinon.
 */
export async function resolveTeam(
  http: FranceHttpClient,
  slug: string,
): Promise<{ teamId: string } | null> {
  const path = `/team/slug/${encodeURIComponent(slug)}`;
  try {
    const result = await http.get<unknown>(path, { query: { lang: "fr" } });

    if (!result.ok) {
      console.error(
        `[franceHunter] Résolution du consulat échouée (slug=${slug}, HTTP ${result.status}).`,
      );
      return null;
    }

    const teamId = extractTeamId(result.body);
    if (teamId === null) {
      console.error(
        `[franceHunter] teamId absent ou invalide dans la réponse de résolution (slug=${slug}).`,
      );
      return null;
    }

    return { teamId };
  } catch (error) {
    console.error(
      `[franceHunter] Erreur lors de la résolution du consulat (slug=${slug}):`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
