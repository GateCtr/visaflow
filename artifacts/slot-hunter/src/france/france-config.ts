/**
 * France Visa Hunter — Constantes et lecture d'environnement.
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « Components and Interfaces » → `france-config.ts`).
 *
 * Règles projet appliquées :
 *   - TypeScript strict, aucun `any`.
 *   - Constantes en UPPER_SNAKE_CASE.
 *   - Aucune valeur secrète en dur : les clés/secrets sont lus depuis
 *     l'environnement (`.env`/dotenv) via `loadFranceEnv` (Requirement 12.1).
 *   - Logs/erreurs préfixés `[franceHunter]`.
 *
 * Requirements couverts : 3.1 (sitekey Turnstile), 6.1 (base API scan),
 * 8.4 (séparation id/nom des services — via `FranceServiceTarget`),
 * 10.6 (motifs autorisés), 11.6 (backoff/timeouts), 12.1 (secrets via env),
 * 14.2 (identifiants portés par la config, jamais en dur).
 */

import type { FranceEnvConfig, FranceMotif } from "./france-types.js";

// ---------------------------------------------------------------------------
// Endpoints & identifiants publics (non secrets)
// ---------------------------------------------------------------------------

/** Base de l'API consulat.gouv.fr (Requirement 6.1). */
export const FRANCE_API_BASE = "https://api.consulat.gouv.fr/api";

/** Sitekey Turnstile (proxyless) du portail France (Requirement 3.1). */
export const FRANCE_TURNSTILE_SITEKEY = "0x4AAAAAAAc-bWzy0zJTmAqs";

/** Valeur du header anti-bot `x-gouv-web`. */
export const FRANCE_GOUV_WEB = "fr.gouv.consulat";

// ---------------------------------------------------------------------------
// Timeouts, retries & backoff (Requirement 11.6)
// ---------------------------------------------------------------------------

/** Timeout maximal par requête HTTP (30 s), appliqué via `AbortController`. */
export const FRANCE_TIMEOUT_MS = 30_000;

/** Nombre maximal de tentatives par requête. */
export const FRANCE_MAX_RETRIES = 3;

/** Base du backoff exponentiel : délai = `FRANCE_RETRY_BACKOFF_MS * 2^attempt`. */
export const FRANCE_RETRY_BACKOFF_MS = 2_000;

// ---------------------------------------------------------------------------
// TTL de session (Requirements 4.4, 5.1, 5.2)
// ---------------------------------------------------------------------------

/** Durée de vie d'une session de réservation : 30 minutes. */
export const FRANCE_SESSION_TTL_MS = 30 * 60_000;

/** Seuil de renouvellement anticipé : 25 minutes. */
export const FRANCE_SESSION_RENEW_MS = 25 * 60_000;

// ---------------------------------------------------------------------------
// Motifs autorisés (custom field Visas) — Requirement 10.6
// ---------------------------------------------------------------------------

/** Clé du custom field Motif (Visas). */
export const FRANCE_MOTIF_KEY = "54cfd964c63f3386";

/**
 * Liste runtime des motifs autorisés.
 *
 * Le type union canonique `FranceMotif` est déclaré dans `france-types.ts`.
 * L'annotation `readonly FranceMotif[]` ci-dessous garantit à la compilation
 * que cette liste ne contient que des membres de l'union (couverture exacte
 * des 7 motifs, vérifiée par les tests de config — task 1.3).
 */
export const FRANCE_ALLOWED_MOTIFS: readonly FranceMotif[] = [
  "Regroupement familial",
  "Visa retour",
  "Reunification familial",
  "Stagiaire associé",
  "Conjoint de Français - Installation",
  "Etudiant",
  "Autres",
] as const;

// ---------------------------------------------------------------------------
// Lecture d'environnement (aucun secret en dur) — Requirement 12.1
// ---------------------------------------------------------------------------

/** Variable d'environnement portant la clé API CapSolver. */
const ENV_CAPSOLVER_API_KEY = "CAPSOLVER_API_KEY";

/** Variable d'environnement portant l'URL du proxy résidentiel FR. */
const ENV_PROXY_URL = "PROXY_URL";

/**
 * Lit une variable d'environnement requise, en la nettoyant de ses espaces.
 * Lève une erreur explicite préfixée `[franceHunter]` si elle est absente ou vide.
 */
function requireEnv(name: string): string {
  const raw = process.env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) {
    throw new Error(
      `[franceHunter] Variable d'environnement requise manquante : ${name}. ` +
        `Définissez-la dans votre fichier .env (aucune valeur en dur autorisée).`,
    );
  }
  return value;
}

/**
 * Charge la configuration d'environnement France depuis `process.env`.
 *
 * Aucune valeur n'est codée en dur : les secrets proviennent exclusivement de
 * l'environnement (`.env`/dotenv). Lève une erreur explicite préfixée
 * `[franceHunter]` dès qu'une clé requise est absente (Requirements 10.6, 12.1).
 */
export function loadFranceEnv(): FranceEnvConfig {
  return {
    capsolverApiKey: requireEnv(ENV_CAPSOLVER_API_KEY),
    proxyUrl: requireEnv(ENV_PROXY_URL),
  };
}
