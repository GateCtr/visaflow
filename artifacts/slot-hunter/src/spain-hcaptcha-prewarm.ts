/**
 * spain-hcaptcha-prewarm — Pré-résolution du token hCaptcha (gct) PAR DOSSIER pour
 * les portails Bookitit/citaconsular.es qui exigent un hCaptcha à la soumission du
 * signin/ (ex. Kinshasa depuis sept. 2026, Cuba).
 *
 * Problème résolu : NoneCap met ~8-14 s à résoudre un hCaptcha. Si on résout au
 * moment où le créneau est détecté (HH:13-14), cette latence fait rater le slot (le
 * temps de résoudre, le créneau est pris → signin/ 504). On pré-résout donc EN AMONT,
 * pendant la fenêtre HH:12→13, EN PARALLÈLE, avec UN TOKEN DÉDIÉ PAR DOSSIER. Ainsi,
 * quand un worker détecte un slot et appelle getsigninfields/, son token gct est déjà
 * prêt → il enchaîne directement sur signin/ sans latence dans le chemin critique.
 *
 * Pourquoi UN TOKEN PAR DOSSIER (et pas un pool partagé) : un token est consommé par
 * un seul signin/. Si N dossiers partageaient un token, le 1er le consommerait et les
 * N-1 autres se retrouveraient sans token. Chaque dossier a donc SON entrée dédiée.
 *
 * Propriété clé du token hCaptcha (confirmée par les tests prod) : il ne dépend que du
 * couple (sitekey, pageUrl) — pas de la session PHP/cookies. La résolution par dossier
 * consiste donc à résoudre, pour chaque dossier, un token qui lui est RÉSERVÉ (isolé),
 * afin d'éviter tout partage.
 *
 * TTL : un token hCaptcha vit ~120 s côté serveur. On considère un token « frais »
 * pendant FRESH_TTL_MS (marge à 100 s) et on le rafraîchit s'il vieillit alors qu'on
 * est encore dans la fenêtre de pré-résolution (le pic peut glisser au-delà de HH:13).
 *
 * Contraintes de codage : strict mode, aucun `any`, types de retour explicites, logs
 * préfixés `[spain-hcaptcha-prewarm]`, secrets exclusivement via env (jamais journalisés).
 */

import { solveSpainHcaptcha } from "./spain-http-booking.js";

/** Durée de fraîcheur d'un token (ms). hCaptcha vit ~120 s → marge de sécurité à 100 s. */
const FRESH_TTL_MS = 100_000;

/**
 * Seuil de rafraîchissement (ms) : si un token frais dépasse cet âge, on le re-résout
 * de manière proactive pendant la fenêtre de pré-résolution. Réglé à 30 s pour que
 * l'âge du token AU MOMENT DU SERVICE reste bas (~0-40 s selon la cadence de la boucle
 * orchestrateur), bien en dessous de la durée de vie hCaptcha (~120 s) → marge maximale
 * de validité serveur au signin/.
 */
const REFRESH_AT_AGE_MS = 30_000;

/** Sitekey/URL + token pré-résolu d'un dossier. */
interface DossierCaptcha {
  /** Sitekey hCaptcha détecté pour ce dossier (dynamique via /main/). */
  sitekey: string;
  /** URL de page portail normalisée (sans fragment). */
  pageUrl: string;
  /** Token gct pré-résolu (undefined tant que non résolu). */
  token?: string;
  /** Instant de résolution du token courant (ms epoch). */
  solvedAtMs: number;
  /** true tant qu'une résolution est en cours pour ce dossier (anti-concurrence). */
  solving: boolean;
}

/** Registre par dossierId. Peuplé par les workers (registerDossierCaptcha). */
const dossiers = new Map<string, DossierCaptcha>();

/** Normalise l'URL de page (retire le fragment `#...`), comme le fait le worker. */
function normalizePageUrl(pageUrl: string): string {
  return pageUrl.split("#")[0];
}

/** true si le token du dossier est frais (présent et dans le TTL). */
function hasFreshToken(entry: DossierCaptcha, nowMs: number): boolean {
  return entry.token !== undefined && nowMs - entry.solvedAtMs < FRESH_TTL_MS;
}

/**
 * Enregistre (ou met à jour) le couple sitekey/pageUrl d'un dossier qui exige un
 * hCaptcha. Appelé par le worker dès qu'il détecte la présence du hCaptcha sur son
 * portail. Idempotent ; ne déclenche PAS de résolution (c'est prewarmAllDossiers qui
 * le fait, dans la fenêtre de pré-résolution).
 *
 * @param dossierId identifiant du dossier.
 * @param sitekey sitekey hCaptcha détecté.
 * @param pageUrl URL de la page portail (fragment `#...` ignoré).
 */
export function registerDossierCaptcha(dossierId: string, sitekey: string, pageUrl: string): void {
  const normUrl = normalizePageUrl(pageUrl);
  const existing = dossiers.get(dossierId);
  if (existing === undefined) {
    dossiers.set(dossierId, { sitekey, pageUrl: normUrl, solvedAtMs: 0, solving: false });
    console.log(
      `[spain-hcaptcha-prewarm] 📌 dossier ${dossierId} enregistré (sitekey=${sitekey.slice(0, 8)}…, url=…${normUrl.slice(-24)})`,
    );
  } else {
    // Le portail/sitekey peut évoluer → tenir à jour sans jeter le token courant.
    existing.sitekey = sitekey;
    existing.pageUrl = normUrl;
  }
}

/**
 * Récupère le token gct pré-résolu et FRAIS d'un dossier, en le CONSOMMANT (retiré
 * du registre — usage unique). Retourne `null` si aucun token frais n'est disponible
 * (le worker fera alors un fallback de résolution à chaud).
 *
 * @param dossierId identifiant du dossier.
 * @returns token gct frais réservé à ce dossier, ou null.
 */
export function takeDossierToken(dossierId: string): string | null {
  const entry = dossiers.get(dossierId);
  if (entry === undefined) return null;

  const nowMs = Date.now();
  if (!hasFreshToken(entry, nowMs)) {
    return null;
  }

  const token = entry.token as string;
  const ageMs = nowMs - entry.solvedAtMs;
  // Consommer : on retire le token pour éviter toute réutilisation. Une nouvelle
  // pré-résolution le régénérera au prochain passage de prewarmAllDossiers.
  entry.token = undefined;
  entry.solvedAtMs = 0;
  console.log(
    `[spain-hcaptcha-prewarm] ✅ token servi au dossier ${dossierId} (âge ${(ageMs / 1000).toFixed(1)}s, ${token.length} car.)`,
  );
  return token;
}

/**
 * Résout (ou rafraîchit) le token d'UN dossier si nécessaire. Ne résout pas si un
 * token frais existe encore et n'a pas atteint le seuil de rafraîchissement, ou si
 * une résolution est déjà en cours pour ce dossier. Ne lève jamais.
 */
async function prewarmOne(entry: DossierCaptcha, dossierId: string): Promise<void> {
  if (entry.solving) return;

  const nowMs = Date.now();
  const ageMs = nowMs - entry.solvedAtMs;
  const needsSolve =
    entry.token === undefined || ageMs >= REFRESH_AT_AGE_MS || ageMs >= FRESH_TTL_MS;
  if (!needsSolve) return;

  entry.solving = true;
  const t0 = Date.now();
  try {
    const token = await solveSpainHcaptcha(entry.sitekey, entry.pageUrl);
    if (token) {
      entry.token = token;
      entry.solvedAtMs = Date.now();
      console.log(
        `[spain-hcaptcha-prewarm] 🔥 dossier ${dossierId} — token prêt (${token.length} car., ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    } else {
      console.warn(`[spain-hcaptcha-prewarm] ⚠️ dossier ${dossierId} — résolution vide (fallback à chaud au booking)`);
    }
  } catch (err) {
    console.warn(
      `[spain-hcaptcha-prewarm] ⚠️ dossier ${dossierId} — résolution échouée (non fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    entry.solving = false;
  }
}

/**
 * Pré-résout EN PARALLÈLE le token de chaque dossier enregistré qui en a besoin
 * (token absent, vieillissant, ou expiré). À appeler par l'orchestrateur à chaque
 * tick de la fenêtre de pré-résolution (HH:12→fin de fenêtre). Idempotent et sûr en
 * concurrence (garde `solving` par dossier). Ne lève jamais.
 *
 * On ne pré-résout que les dossiers passés en argument (dossiers actifs) ET
 * enregistrés comme ayant un hCaptcha requis → zéro solve gaspillé sur les portails
 * sans captcha.
 *
 * @param activeDossierIds identifiants des dossiers actifs à considérer.
 * @returns nombre de dossiers ayant un token frais après l'opération.
 */
export async function prewarmAllDossiers(activeDossierIds: readonly string[]): Promise<number> {
  const active = new Set(activeDossierIds);
  const tasks: Array<Promise<void>> = [];
  for (const [dossierId, entry] of dossiers) {
    if (!active.has(dossierId)) continue;
    tasks.push(prewarmOne(entry, dossierId));
  }
  if (tasks.length === 0) return 0;

  await Promise.allSettled(tasks);

  const nowMs = Date.now();
  let fresh = 0;
  for (const [dossierId, entry] of dossiers) {
    if (active.has(dossierId) && hasFreshToken(entry, nowMs)) fresh++;
  }
  return fresh;
}

/** true si au moins un dossier actif est enregistré comme ayant un hCaptcha requis. */
export function hasRegisteredDossiers(activeDossierIds: readonly string[]): boolean {
  for (const id of activeDossierIds) {
    if (dossiers.has(id)) return true;
  }
  return false;
}

/** Vide le registre (tests / arrêt propre). */
export function clearHcaptchaPrewarm(): void {
  dossiers.clear();
}
