/**
 * spain-reserve-pool — Gestionnaire de pool de sessions de réserve pré-solvées
 * (feature spain-synchronized-scan, composant ReservePoolManager).
 *
 * Objectif : maintenir N sessions Cloudflare pré-solvées, chacune sur sa propre IP
 * Decodo, afin de permettre un swap ~0 s quand un proxy meurt en pleine chasse
 * (réparer en direct coûte un re-solve ~28-66 s). Le pool est pré-chauffé pendant la
 * phase preflight (`warmUp`), emprunté à la volée (`borrow`) et reconstitué en tâche
 * de fond (`replenishAsync`) sans jamais bloquer le chemin du swap.
 *
 * Contraintes de codage : strict mode, aucun `any`, types de retour explicites sur
 * toutes les fonctions exportées, secrets exclusivement via env, `try/catch` autour
 * de tous les appels réseau, logs préfixés `[spain-reserve-pool]`, cf_clearance jamais
 * journalisé en clair (tronqué à ~8 caractères + marqueur).
 *
 * Réutilise sans réécrire :
 *   - `initWorkerSession`      (spain-soax-solver)   — pré-solve d'une session CF
 *   - `rotateDecodoUrl`        (spain-decodo-pool)   — sélection d'une IP distincte
 *   - `flagDecodoIp`           (spain-decodo-pool)   — blacklist d'une IP morte
 *   - `isDecodoIpBlacklisted`  (spain-decodo-pool)   — exclusion des IP mortes
 *
 * _Requirements: 5.1, 5.3, 5.5, 5.6, 5.7, 11.7, 13.5_
 */

import type { SpainCfSession } from "../spain-soax-solver.js";
import { initWorkerSession } from "../spain-soax-solver.js";
import {
  rotateDecodoUrl,
  flagDecodoIp,
  isDecodoIpBlacklisted,
} from "../spain-decodo-pool.js";

// ─── Interfaces publiques (design.md, Component 3) ──────────────────────────

/** Une session de réserve pré-solvée, prête pour un swap instantané. */
export interface ReserveSession {
  /** Session CF pré-solvée (cf_clearance lié à l'exit IP de `proxyUrl`). */
  session: SpainCfSession;
  /** URL proxy Decodo (sticky) sur laquelle la session a été établie. */
  proxyUrl: string;
  /** Identifiant non secret dérivé de l'IP de base (jamais le secret proxy). */
  stickyId: string;
  /** Instant d'expiration du cf_clearance (ms epoch), = `session.expiresAt`. */
  cfExpiresAtMs: number;
  /** Instant de résolution de la session (ms epoch), = `session.createdAt`. */
  solvedAtMs: number;
}

/** Gestionnaire du pool de sessions de réserve. */
export interface ReservePoolManager {
  /** Taille cible du pool (SPAIN_RESERVE_POOL_SIZE, défaut 4 — configurable). */
  readonly targetSize: number;
  /** Pré-solve jusqu'à `targetSize` sessions (appelé en preflight). */
  warmUp(capsolverKey: string, portalUrl: string): Promise<void>;
  /** Emprunte une réserve valide (retire du pool). null si aucune valide. */
  borrow(nowMs: number): ReserveSession | null;
  /** Reconstitue une réserve manquante par re-solve, en tâche de fond. */
  replenishAsync(capsolverKey: string, portalUrl: string): void;
  /** Nombre de réserves actuellement prêtes (cf_clearance non expiré). */
  size(): number;
}

// ─── Bornes et défauts ──────────────────────────────────────────────────────

/** Bornes de `targetSize` (Requirement 11.7). */
const TARGET_SIZE_MIN = 1;
const TARGET_SIZE_MAX = 100;
const DEFAULT_TARGET_SIZE = 4;

/** Reconstitution en tâche de fond : retry et backoff exponentiel (Req 5.5). */
const REPLENISH_MAX_ATTEMPTS = 3;
const REPLENISH_BACKOFF_BASE_MS = 2_000;
const REPLENISH_BACKOFF_FACTOR = 2;

/** Longueur de tête conservée lors de la troncature du cf_clearance (Req 13.5). */
const CF_LOG_HEAD_LEN = 8;

// ─── Helpers internes ───────────────────────────────────────────────────────

/**
 * Résout la taille cible effective. Priorité à `SPAIN_RESERVE_POOL_SIZE` (borné
 * `[1, 100]`), sinon à `opts.targetSize` (borné de la même manière), sinon défaut 4.
 * Toute valeur non entière / hors bornes retombe sur le défaut.
 */
function resolveTargetSize(optsTargetSize: number): number {
  const clamp = (value: number): number | null => {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    if (value < TARGET_SIZE_MIN || value > TARGET_SIZE_MAX) return null;
    return value;
  };

  const raw = process.env.SPAIN_RESERVE_POOL_SIZE;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    const bounded = clamp(parsed);
    if (bounded !== null) return bounded;
    console.warn(
      `[spain-reserve-pool] SPAIN_RESERVE_POOL_SIZE invalide ("${raw}"), fallback sur opts/défaut.`,
    );
  }

  const fromOpts = clamp(optsTargetSize);
  if (fromOpts !== null) return fromOpts;

  console.warn(
    `[spain-reserve-pool] targetSize invalide (${String(optsTargetSize)}), défaut appliqué: ${DEFAULT_TARGET_SIZE}`,
  );
  return DEFAULT_TARGET_SIZE;
}

/**
 * Normalise une URL proxy en clé de base non secrète : on retire le suffixe sticky
 * Decodo et le mot de passe, on ne conserve que l'hôte/port et l'utilisateur de base.
 * Sert à (1) dédupliquer les IP déjà utilisées dans le pool et (2) dériver un
 * `stickyId` observable sans fuite de secret.
 */
function proxyBaseKey(url: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const baseUser = user.replace(/-session-[^-]+-sessionduration-\d+/g, "");
    return `${baseUser}@${u.host}`;
  } catch {
    // URL non parsable : retirer toute portion ressemblant à des identifiants.
    return url.replace(/:\/\/[^@]*@/, "://");
  }
}

/**
 * Dérive un `stickyId` court, stable et non secret depuis une URL proxy. Basé sur un
 * hash déterministe simple (djb2) de la clé de base — ne révèle ni le mot de passe ni
 * le token proxy.
 */
function deriveStickyId(url: string): string {
  const key = proxyBaseKey(url);
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) >>> 0;
  }
  return `sticky-${hash.toString(16).padStart(8, "0")}`;
}

/** Tronque un cf_clearance pour le journal (jamais en clair — Requirement 13.5). */
function truncCf(cfClearance: string): string {
  if (!cfClearance) return "<vide>";
  return `${cfClearance.slice(0, CF_LOG_HEAD_LEN)}…(${cfClearance.length}c)`;
}

/** true si la session de réserve a un cf_clearance encore valide à `nowMs`. */
function isReserveValid(reserve: ReserveSession, nowMs: number): boolean {
  return Boolean(reserve.session.cfClearance) && reserve.cfExpiresAtMs > nowMs;
}

/** Sommeil interruptible simple (backoff). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Implémentation du pool ─────────────────────────────────────────────────

/**
 * Crée un gestionnaire de pool de sessions de réserve pré-solvées.
 *
 * `targetSize` est déterminé à la création via `SPAIN_RESERVE_POOL_SIZE` (borné
 * `[1, 100]`), avec repli sur `opts.targetSize` puis sur le défaut 4 si invalide.
 *
 * @param opts.targetSize taille cible souhaitée (peut elle-même dériver d'env côté
 *   appelant) ; bornée `[1, 100]` en interne, défaut 4 si non entière/hors bornes.
 * @returns un `ReservePoolManager` prêt pour `warmUp` / `borrow` / `replenishAsync`.
 */
export function createReservePool(opts: { targetSize: number }): ReservePoolManager {
  const targetSize = resolveTargetSize(opts.targetSize);

  /** Réserves actuellement disponibles. */
  const reserves: ReserveSession[] = [];

  /**
   * Sélectionne une IP Decodo distincte, non blacklistée et non déjà utilisée par une
   * réserve du pool. Utilise `rotateDecodoUrl` (qui saute déjà les IP blacklistées)
   * jusqu'à `getDistinctAttempts` tentatives. Retourne `undefined` si le pool est
   * épuisé (toutes les IP utilisées/blacklistées) — l'appelant doit s'arrêter
   * gracieusement.
   */
  const pickDistinctIp = (usedBaseKeys: Set<string>): string | undefined => {
    // Nombre de tentatives borné : au-delà, on considère le pool épuisé.
    const maxAttempts = Math.max(targetSize, usedBaseKeys.size) + TARGET_SIZE_MAX;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate = rotateDecodoUrl();
      if (candidate === undefined) return undefined; // pool vide
      if (isDecodoIpBlacklisted(candidate)) continue; // IP morte
      const baseKey = proxyBaseKey(candidate);
      if (usedBaseKeys.has(baseKey)) continue; // déjà utilisée par une réserve/active
      return candidate;
    }
    return undefined; // pas d'IP distincte disponible
  };

  /**
   * Pré-solve une seule session sur une IP distincte fournie. Enveloppe l'appel réseau
   * dans un `try/catch` contextualisé. Retourne la `ReserveSession` ou `null`.
   */
  const solveOne = async (
    proxyUrl: string,
    capsolverKey: string,
    portalUrl: string,
  ): Promise<ReserveSession | null> => {
    try {
      const result = await initWorkerSession(proxyUrl, portalUrl, capsolverKey);
      if (result === null || !result.session.cfClearance) {
        console.warn(
          `[spain-reserve-pool] Pré-solve échoué (session/cf_clearance absent) — IP ${deriveStickyId(proxyUrl)}`,
        );
        return null;
      }
      const { session } = result;
      const reserve: ReserveSession = {
        session,
        proxyUrl,
        stickyId: deriveStickyId(proxyUrl),
        cfExpiresAtMs: session.expiresAt,
        solvedAtMs: session.createdAt,
      };
      console.log(
        `[spain-reserve-pool] ✅ Réserve pré-solvée — ${reserve.stickyId} | cf=${truncCf(session.cfClearance)} | exp=${new Date(reserve.cfExpiresAtMs).toISOString()}`,
      );
      return reserve;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[spain-reserve-pool] Erreur réseau au pré-solve (IP ${deriveStickyId(proxyUrl)}): ${message}`,
      );
      return null;
    }
  };

  const size = (): number => {
    const nowMs = Date.now();
    let count = 0;
    for (const reserve of reserves) {
      if (isReserveValid(reserve, nowMs)) count++;
    }
    // Bornage défensif dans [0, targetSize] (Requirement 5.7).
    return Math.min(Math.max(count, 0), targetSize);
  };

  const usedBaseKeysOfPool = (): Set<string> => {
    const set = new Set<string>();
    for (const reserve of reserves) set.add(proxyBaseKey(reserve.proxyUrl));
    return set;
  };

  const warmUp = async (capsolverKey: string, portalUrl: string): Promise<void> => {
    console.log(
      `[spain-reserve-pool] 🔥 warmUp — cible ${targetSize} réserve(s), ${reserves.length} déjà en pool.`,
    );
    const usedBaseKeys = usedBaseKeysOfPool();

    while (size() < targetSize) {
      const proxyUrl = pickDistinctIp(usedBaseKeys);
      if (proxyUrl === undefined) {
        console.warn(
          `[spain-reserve-pool] ⚠️ Plus d'IP distincte disponible — arrêt de warmUp à ${size()}/${targetSize} réserve(s).`,
        );
        break;
      }
      // Réserver la clé de base immédiatement pour ne pas la re-sélectionner même si
      // le solve échoue (une IP qui échoue au solve ne doit pas boucler indéfiniment).
      usedBaseKeys.add(proxyBaseKey(proxyUrl));

      const reserve = await solveOne(proxyUrl, capsolverKey, portalUrl);
      if (reserve !== null) {
        reserves.push(reserve);
      }
    }

    console.log(
      `[spain-reserve-pool] 🔥 warmUp terminé — ${size()}/${targetSize} réserve(s) prête(s).`,
    );
  };

  const borrow = (nowMs: number): ReserveSession | null => {
    // Purger et sélectionner en un seul passage : retirer la première réserve valide,
    // en éliminant au passage les réserves expirées rencontrées.
    while (reserves.length > 0) {
      const reserve = reserves.shift();
      if (reserve === undefined) break;
      if (isReserveValid(reserve, nowMs)) {
        console.log(
          `[spain-reserve-pool] 🤝 borrow — ${reserve.stickyId} emprunté | reste ${size()} valide(s).`,
        );
        return reserve;
      }
      // Réserve expirée : ne pas la remettre, journaliser (cf tronqué).
      console.warn(
        `[spain-reserve-pool] ⌛ Réserve ${reserve.stickyId} expirée (cf=${truncCf(reserve.session.cfClearance)}) — retirée.`,
      );
    }
    console.warn(`[spain-reserve-pool] 🤝 borrow — aucune réserve valide disponible (null).`);
    return null;
  };

  const replenishAsync = (capsolverKey: string, portalUrl: string): void => {
    // Fire-and-forget : ne bloque jamais le chemin du swap. Toute erreur est capturée
    // en interne (l'IIFE async ne rejette jamais vers l'appelant).
    void (async (): Promise<void> => {
      const missing = targetSize - size();
      if (missing <= 0) return;

      for (let slot = 0; slot < missing; slot++) {
        let replenished = false;

        for (let attempt = 1; attempt <= REPLENISH_MAX_ATTEMPTS; attempt++) {
          const usedBaseKeys = usedBaseKeysOfPool();
          const proxyUrl = pickDistinctIp(usedBaseKeys);
          if (proxyUrl === undefined) {
            console.warn(
              `[spain-reserve-pool] ♻️ Reconstitution: plus d'IP distincte disponible (tentative ${attempt}/${REPLENISH_MAX_ATTEMPTS}).`,
            );
          } else {
            usedBaseKeys.add(proxyBaseKey(proxyUrl));
            const reserve = await solveOne(proxyUrl, capsolverKey, portalUrl);
            if (reserve !== null) {
              reserves.push(reserve);
              replenished = true;
              console.log(
                `[spain-reserve-pool] ♻️ Réserve reconstituée — ${reserve.stickyId} | ${size()}/${targetSize} prête(s).`,
              );
              break;
            }
            // Solve échoué sur cette IP : la blacklister avant de retenter sur une autre.
            flagDecodoIp(proxyUrl, "reserve_resolve_failed");
          }

          if (attempt < REPLENISH_MAX_ATTEMPTS) {
            const backoff = REPLENISH_BACKOFF_BASE_MS * REPLENISH_BACKOFF_FACTOR ** (attempt - 1);
            await sleep(backoff);
          }
        }

        if (!replenished) {
          // Échec après 3 tentatives : ne pas interrompre les réserves existantes.
          console.warn(
            `[spain-reserve-pool] ♻️ Reconstitution échouée après ${REPLENISH_MAX_ATTEMPTS} tentatives — pool à ${size()}/${targetSize}. Réserves existantes préservées.`,
          );
        }
      }
    })().catch((error: unknown) => {
      // Filet de sécurité : ne jamais laisser échapper une erreur du fire-and-forget.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[spain-reserve-pool] ♻️ Reconstitution interrompue (erreur non prévue): ${message}`);
    });
  };

  return {
    targetSize,
    warmUp,
    borrow,
    replenishAsync,
    size,
  };
}
