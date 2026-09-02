/**
 * France Visa Hunter — Wrapper de résolution Turnstile (proxyless).
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « Components and Interfaces » → `france-turnstile.ts`).
 *
 * Rôle : encapsuler `solveTurnstileToken` (CapSolver, mode proxyless) pour le
 * portail consulat.gouv.fr, avec retries + backoff exponentiel, et exposer un
 * helper pur plaçant le token résolu dans le champ `captcha` d'un corps de
 * requête (Property 7).
 *
 * Règles projet appliquées :
 *   - TypeScript strict, aucun `any`, types de retour explicites.
 *   - `try/catch` contextuel préfixé `[franceHunter]` autour des appels réseau.
 *   - Aucun secret en clair dans les logs : le token est masqué via `maskSecret`.
 *
 * Requirements couverts :
 *   - 3.1 : sitekey Turnstile du portail France (`FRANCE_TURNSTILE_SITEKEY`).
 *   - 3.2 : token placé dans le champ `captcha` du corps de requête.
 *   - 3.4 : retries 3× avec backoff ×2, `null` après échec.
 *
 * Note (Requirement 3.3, Property 8) : le paramètre `purpose`
 * (`"session"` | `"booking"`) sert au traçage/logging ; chaque appel produit un
 * token distinct — un pour l'ouverture de session, un pour la finalisation.
 */

import { solveTurnstileToken } from "../capsolver-turnstile.js";
import { FRANCE_MAX_RETRIES, FRANCE_TURNSTILE_SITEKEY } from "./france-config.js";
import { computeBackoffMs, maskSecret } from "./france-http.js";
import type { TurnstilePurpose } from "./france-types.js";

// ---------------------------------------------------------------------------
// Constantes locales au concern Turnstile
// ---------------------------------------------------------------------------

/**
 * Origine du portail public consulat.gouv.fr. C'est la `websiteURL` passée à
 * CapSolver pour la tâche Turnstile — validée en live (harnais
 * `france-live-scan.mjs` : `ORIGIN + "/"`). Le portail rend le widget en mode
 * explicit et n'exige pas une URL de page RDV spécifique côté CapSolver.
 */
const FRANCE_PORTAL_ORIGIN = "https://consulat.gouv.fr";

/** `websiteURL` CapSolver = racine du portail (confirmé live). */
const FRANCE_TURNSTILE_WEBSITE_URL = `${FRANCE_PORTAL_ORIGIN}/`;

/**
 * Type de tâche CapSolver : Turnstile sans proxy (proxyless).
 */
const FRANCE_TURNSTILE_TASK_TYPE = "AntiTurnstileTaskProxyLess" as const;

/**
 * URL de référence pour la résolution Turnstile (racine du portail).
 *
 * Conservée sous forme de helper pour compatibilité d'appel : le paramètre
 * `consulateSlug`/`serviceName` n'influence pas la `websiteURL` CapSolver (la
 * racine suffit, cf. harnais live). Retourne toujours la racine du portail.
 */
export function buildFrancePageUrl(_consulateSlug: string, _serviceName: string): string {
  return FRANCE_TURNSTILE_WEBSITE_URL;
}

/**
 * Petite pause asynchrone.
 *
 * @param ms Durée en millisecondes.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Résolution Turnstile
// ---------------------------------------------------------------------------

/**
 * Résout un token Turnstile via `solveTurnstileToken` (mode proxyless) pour le
 * portail France.
 *
 * Effectue jusqu'à `FRANCE_MAX_RETRIES` (3) tentatives, avec un backoff
 * exponentiel entre chaque échec (`computeBackoffMs`, base 2000 ms ×2). Retourne
 * le champ `token` du résultat, ou `null` si aucune tentative n'aboutit.
 *
 * @param purpose But de la résolution (`"session"` ou `"booking"`) — utilisé
 *   uniquement pour le traçage/logging ; chaque appel produit un token distinct.
 * @param apiKey Clé API CapSolver (jamais journalisée).
 * @param websiteURL URL RÉELLE de la page RDV du consulat qui rend le widget
 *   Turnstile (via `buildFrancePageUrl`). Indispensable : un token résolu sur
 *   une autre URL (ex. la racine du portail) est rejeté par l'API
 *   (`CAPTCHA_FAILED`).
 * @returns Le token Turnstile résolu, ou `null` après échec des tentatives.
 */
export async function solveFranceTurnstile(
  purpose: TurnstilePurpose,
  apiKey: string,
  websiteURL: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < FRANCE_MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[franceHunter] Résolution Turnstile (${purpose}) — tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}…`,
      );

      const result = await solveTurnstileToken(
        websiteURL,
        FRANCE_TURNSTILE_SITEKEY,
        apiKey,
        undefined,
        FRANCE_TURNSTILE_TASK_TYPE,
      );

      const token = result?.token;
      if (typeof token === "string" && token.length > 0) {
        console.log(
          `[franceHunter] Token Turnstile (${purpose}) résolu : ${maskSecret(token)}`,
        );
        return token;
      }

      console.warn(
        `[franceHunter] Turnstile (${purpose}) sans token (tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}).`,
      );
    } catch (error) {
      console.error(
        `[franceHunter] Échec résolution Turnstile (${purpose}), tentative ${attempt + 1}/${FRANCE_MAX_RETRIES}:`,
        error instanceof Error ? error.message : error,
      );
    }

    // Backoff avant la prochaine tentative (sauf après la dernière).
    if (attempt < FRANCE_MAX_RETRIES - 1) {
      const backoffMs = computeBackoffMs(attempt);
      console.log(
        `[franceHunter] Backoff Turnstile (${purpose}) : ${backoffMs} ms avant nouvelle tentative.`,
      );
      await sleep(backoffMs);
    }
  }

  console.error(
    `[franceHunter] Turnstile (${purpose}) : échec après ${FRANCE_MAX_RETRIES} tentatives.`,
  );
  return null;
}

// ---------------------------------------------------------------------------
// Helper pur — placement du token (Property 7)
// ---------------------------------------------------------------------------

/**
 * Place un token Turnstile dans le champ `captcha` d'un corps de requête.
 *
 * Fonction pure : ne mute pas `body`, retourne une nouvelle valeur combinant les
 * propriétés d'origine et le champ `captcha` (Requirement 3.2, Property 7).
 *
 * @param body Le corps de requête d'origine.
 * @param token Le token Turnstile à injecter.
 * @returns Une copie de `body` enrichie du champ `captcha`.
 */
export function placeTurnstileToken<T extends object>(
  body: T,
  token: string,
): T & { captcha: string } {
  return { ...body, captcha: token };
}
