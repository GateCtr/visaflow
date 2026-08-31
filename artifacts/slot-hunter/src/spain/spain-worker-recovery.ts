/**
 * spain-worker-recovery — Récupération asynchrone non bloquante d'un worker
 * (feature spain-synchronized-scan, composant RecoverySupervisor).
 *
 * Objectif : réparer en tâche de fond un worker tombé (`enterRecoveryAsync`) sans
 * jamais suspendre la cadence des autres workers. Le worker est déjà passé en
 * `RECOVERING` par la boucle appelante ; ce module tente de rétablir une session
 * valide selon la cause classifiée, puis fait transiter le worker vers `ARMED`
 * (via `transition(rt, "recovered")`) au succès. À l'échec, il journalise et
 * retente jusqu'à un maximum borné, avec un cas terminal et un cas non terminal
 * (pool épuisé) qui laisse le worker `RECOVERING` pour retentative au tick suivant.
 *
 * Stratégies par `FailureKind` (design.md — Error Handling scénarios 1-6) :
 *   - `cf_expired`   → re-solve CF sur la MÊME IP (garde l'exit IP) via initWorkerSession.
 *   - `session_dead` → nouveau PHPSESSID via initPhpState (garde IP + CF, pas de re-solve).
 *   - `http_5xx`     → short retry (2-3 tentatives, backoff ~2 s ×2) sur la même IP ;
 *                      escalade `proxy_dead` si la surcharge persiste.
 *   - `proxy_dead`   → swap réserve (~0 s) prioritaire (flag IP morte + replenish async),
 *                      sinon rotation d'IP + re-solve OBLIGATOIRE (changement d'exit IP).
 *
 * Contraintes de codage : strict mode, aucun `any`, types de retour explicites,
 * secrets exclusivement via `deps`/env, `try/catch` autour de tout appel réseau,
 * logs préfixés `[spain-recovery]`, cf_clearance jamais journalisé en clair.
 *
 * Réutilise sans réécrire :
 *   - `initWorkerSession` (spain-soax-solver)         — re-solve CF d'une session
 *   - `initPhpState`      (spain-dossier-worker)      — régénère le PHPSESSID
 *   - `rotateDecodoUrl`   (spain-decodo-pool)         — sélection d'une IP distincte
 *   - `flagDecodoIp`      (spain-decodo-pool)         — blacklist d'une IP morte
 *   - `transition`        (spain-worker-state-machine) — RECOVERING → ARMED
 *   - `ReservePoolManager.borrow`/`replenishAsync`    — swap réserve instantané
 *
 * _Requirements: 3.2, 3.4, 3.5, 3.6, 3.7, 5.2, 5.4, 10.4, 10.5, 10.6, 10.7,
 *   14.1, 14.2, 14.3, 14.4, 14.5_
 */

import type { FailureKind, WorkerRuntimeState } from "./spain-grid-config.js";
import type { ReservePoolManager } from "./spain-reserve-pool.js";
import { transition } from "./spain-worker-state-machine.js";
import { initWorkerSession } from "../spain-soax-solver.js";
import type { SpainCfSession } from "../spain-soax-solver.js";
import { initPhpState } from "../spain-dossier-worker.js";
import type { SpainDossierConfig, WorkerPhpState } from "../spain-dossier-worker.js";
import { rotateDecodoUrl, flagDecodoIp } from "../spain-decodo-pool.js";

// ─── Dépendances injectées ───────────────────────────────────────────────────

/**
 * Dépendances de récupération injectées par l'appelant (boucle worker /
 * orchestrateur). L'injection évite un couplage fort au module et rend la
 * récupération testable (mocks du pool, de la clé, de l'URL portail).
 */
export interface RecoveryDeps {
  /** Pool de sessions de réserve pré-solvées (swap ~0 s en cas de proxy mort). */
  reservePool: ReservePoolManager;
  /** Clé API CapSolver (lue depuis l'env par l'appelant ; jamais journalisée). */
  capsolverKey: string;
  /** URL du portail Bookitit (cible du solve CF / cycle complet). */
  portalUrl: string;
  /** Configuration du dossier (nécessaire à `initPhpState`). */
  config: SpainDossierConfig;
  /** Tag de journalisation identifiant le worker/dossier. */
  tag: string;
}

// ─── Bornes de récupération ──────────────────────────────────────────────────

/** Nombre maximal de tentatives de récupération avant abandon terminal (Req 3.6, 3.7). */
const MAX_RECOVERY_ATTEMPTS = 10;
/** Backoff fixe entre tentatives de récupération (Req 3.6). */
const RECOVERY_BACKOFF_MS = 5_000;

/** Short retry `http_5xx` : tentatives sur la même IP avant escalade (design scénario 2). */
const HTTP_5XX_MAX_RETRIES = 3;
/** Backoff de base du short retry `http_5xx` (~2 s ×2). */
const HTTP_5XX_BACKOFF_BASE_MS = 2_000;
const HTTP_5XX_BACKOFF_FACTOR = 2;

/** Longueur de tête conservée lors de la troncature du cf_clearance (Req 13.5). */
const CF_LOG_HEAD_LEN = 8;

// ─── Helpers internes ────────────────────────────────────────────────────────

/** Sommeil simple (backoff). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tronque un cf_clearance pour le journal (jamais en clair — Requirement 13.5). */
function truncCf(cfClearance: string | undefined): string {
  if (!cfClearance) return "<vide>";
  return `${cfClearance.slice(0, CF_LOG_HEAD_LEN)}…(${cfClearance.length}c)`;
}

/**
 * Normalise une URL proxy en clé de base non secrète (retire le suffixe sticky et
 * le mot de passe) afin de comparer l'exit IP de deux sessions sans exposer de
 * secret. Deux URLs partageant la même base sont réputées cibler la même exit IP.
 */
function proxyBaseKey(url: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const baseUser = user.replace(/-session-[^-]+-sessionduration-\d+/g, "");
    return `${baseUser}@${u.host}`;
  } catch {
    return url.replace(/:\/\/[^@]*@/, "://");
  }
}

/**
 * Vérifie qu'une session fraîchement solvée est bien liée à l'exit IP attendue
 * (`expectedProxyUrl`). Le cf_clearance étant lié à l'exit IP (prouvé), toute
 * divergence signifie que le solve a atterri sur une autre IP : la session doit
 * alors être rejetée et re-solvée sur l'IP courante avant émission (Requirement 10.5).
 *
 * On compare la clé de base (host + user sans suffixe sticky) plutôt que l'URL
 * complète, la portion sticky pouvant différer sans changer l'exit IP.
 */
function sessionMatchesExitIp(session: SpainCfSession, expectedProxyUrl: string): boolean {
  if (!session.soaxProxyUrl) {
    // Pas d'URL proxy portée par la session : on ne peut pas prouver la cohérence.
    // Prudence : considérer comme non concordant pour forcer un re-solve explicite.
    return false;
  }
  return proxyBaseKey(session.soaxProxyUrl) === proxyBaseKey(expectedProxyUrl);
}

/**
 * Re-solve une session CF sur une URL proxy donnée, en rejetant toute session dont
 * l'exit IP diverge de `expectedProxyUrl` (Requirement 10.5). En cas de divergence,
 * une seule nouvelle tentative de solve est faite sur l'IP courante avant abandon.
 *
 * @returns la `SpainCfSession` valide liée à l'exit IP attendue, ou `null` si échec.
 */
async function resolveOnExitIp(
  proxyUrl: string,
  expectedProxyUrl: string,
  deps: RecoveryDeps,
): Promise<SpainCfSession | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let result: Awaited<ReturnType<typeof initWorkerSession>>;
    try {
      result = await initWorkerSession(proxyUrl, deps.portalUrl, deps.capsolverKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[spain-recovery] ${deps.tag} re-solve CF: erreur réseau: ${message}`);
      return null;
    }

    if (result === null || !result.session.cfClearance) {
      console.error(`[spain-recovery] ${deps.tag} re-solve CF: session/cf_clearance absent`);
      return null;
    }

    const { session } = result;
    if (sessionMatchesExitIp(session, expectedProxyUrl)) {
      console.log(
        `[spain-recovery] ${deps.tag} re-solve CF OK sur exit IP courante | cf=${truncCf(session.cfClearance)}`,
      );
      return session;
    }

    // cf_clearance obtenu sur une exit IP différente : rejeter et re-solver sur l'IP
    // courante (Requirement 10.5). Une seule nouvelle tentative avant abandon.
    console.warn(
      `[spain-recovery] ${deps.tag} cf_clearance rejeté (exit IP divergente), re-solve sur l'IP courante (tentative ${attempt}/2)`,
    );
  }

  console.error(
    `[spain-recovery] ${deps.tag} re-solve CF: impossible d'obtenir un cf_clearance lié à l'exit IP courante`,
  );
  return null;
}

// ─── Tentatives de récupération par cause ────────────────────────────────────

/**
 * Exécute UNE tentative de récupération selon la cause `kind`. Retourne un verdict :
 * - `"recovered"`     : session valide rétablie ⟹ l'appelant fait transiter vers ARMED.
 * - `"retry"`         : échec récupérable ⟹ backoff puis nouvelle tentative.
 * - `"pool_exhausted"`: réserve vide ET rotation impossible ⟹ non terminal, reste
 *                       RECOVERING pour retenter au tick suivant (Req 14.1, 14.4).
 *
 * Ne lance jamais : toute erreur réseau est capturée et transformée en `"retry"`.
 * `kind` peut être escaladé en interne (`http_5xx` → `proxy_dead`) sans que
 * l'appelant ait à le savoir.
 */
type AttemptVerdict = "recovered" | "retry" | "pool_exhausted";

async function attemptRecovery(
  rt: WorkerRuntimeState,
  kind: FailureKind,
  deps: RecoveryDeps,
): Promise<AttemptVerdict> {
  switch (kind) {
    case "cf_expired": {
      // GET widget 403 → re-solve CF sur la MÊME exit IP (Requirement 10.7).
      const session = await resolveOnExitIp(rt.proxyUrl, rt.proxyUrl, deps);
      if (session === null) return "retry";
      rt.session = session;
      return "recovered";
    }

    case "session_dead": {
      // datetime 0B tous mois → nouveau PHPSESSID, garder IP + CF (Requirement 10.6).
      if (rt.session === undefined) {
        // Sans session CF, impossible de régénérer le PHPSESSID : escalade CF re-solve.
        console.warn(
          `[spain-recovery] ${deps.tag} session_dead sans session CF — escalade vers re-solve CF`,
        );
        const session = await resolveOnExitIp(rt.proxyUrl, rt.proxyUrl, deps);
        if (session === null) return "retry";
        rt.session = session;
      }
      let phpState: WorkerPhpState | null;
      try {
        phpState = await initPhpState(rt.session, deps.config, deps.tag);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[spain-recovery] ${deps.tag} session_dead: erreur initPhpState: ${message}`);
        return "retry";
      }
      if (phpState === null) {
        console.error(`[spain-recovery] ${deps.tag} session_dead: initPhpState a retourné null`);
        return "retry";
      }
      rt.phpState = phpState;
      // IP + CF conservés (rt.proxyUrl et rt.session inchangés).
      return "recovered";
    }

    case "http_5xx": {
      // 502/503/504 → short retry sur la MÊME IP (CF déjà résolu, surcharge serveur).
      // On revalide la session existante par un re-fetch léger via initWorkerSession
      // (qui traverse la surcharge sur la même IP). Si elle persiste, on escalade.
      for (let attempt = 1; attempt <= HTTP_5XX_MAX_RETRIES; attempt++) {
        let ok = false;
        try {
          const result = await initWorkerSession(rt.proxyUrl, deps.portalUrl, deps.capsolverKey);
          if (result !== null && result.session.cfClearance) {
            // La session doit rester liée à l'exit IP courante (Requirement 10.5).
            if (sessionMatchesExitIp(result.session, rt.proxyUrl)) {
              rt.session = result.session;
              ok = true;
            } else {
              console.warn(
                `[spain-recovery] ${deps.tag} http_5xx: session sur exit IP divergente rejetée`,
              );
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `[spain-recovery] ${deps.tag} http_5xx short retry ${attempt}/${HTTP_5XX_MAX_RETRIES}: ${message}`,
          );
        }

        if (ok) return "recovered";

        if (attempt < HTTP_5XX_MAX_RETRIES) {
          const backoff = HTTP_5XX_BACKOFF_BASE_MS * HTTP_5XX_BACKOFF_FACTOR ** (attempt - 1);
          await sleep(backoff);
        }
      }
      // Surcharge persistante : escalade vers proxy_dead (rotation).
      console.warn(
        `[spain-recovery] ${deps.tag} http_5xx persistant après ${HTTP_5XX_MAX_RETRIES} tentatives — escalade proxy_dead`,
      );
      return attemptRecovery(rt, "proxy_dead", deps);
    }

    case "proxy_dead": {
      // 1) Swap réserve PRIORITAIRE (~0 s, aucun solve synchrone bloquant — Req 5.2).
      const reserve = deps.reservePool.borrow(Date.now());
      if (reserve !== null) {
        // Blacklister l'IP morte pour l'exclure des sélections futures (Req 5.6).
        flagDecodoIp(rt.proxyUrl, "proxy_dead");
        rt.session = reserve.session;
        rt.proxyUrl = reserve.proxyUrl;
        // Reconstituer la réserve empruntée en tâche de fond (jamais bloquant — Req 5.3).
        deps.reservePool.replenishAsync(deps.capsolverKey, deps.portalUrl);
        console.log(
          `[spain-recovery] ${deps.tag} swap réserve ${reserve.stickyId} | cf=${truncCf(reserve.session.cfClearance)}`,
        );
        return "recovered";
      }

      // 2) Aucune réserve : rotation d'IP + re-solve OBLIGATOIRE (Req 5.4, 10.4).
      // Blacklister l'IP morte AVANT la rotation pour ne pas la re-sélectionner.
      flagDecodoIp(rt.proxyUrl, "proxy_dead");
      const newProxy = rotateDecodoUrl();
      if (newProxy === undefined) {
        // Pool épuisé (borrow null ET rotation échouée) : NON terminal (Req 14.1, 14.4).
        console.error(
          `[spain-recovery] ${deps.tag} pool épuisé (réserve vide + rotation impossible) — reste RECOVERING, retentera au tick`,
        );
        return "pool_exhausted";
      }
      rt.proxyUrl = newProxy;
      // Changement d'exit IP ⟹ re-solve obligatoire lié à la NOUVELLE IP (Req 10.4).
      const session = await resolveOnExitIp(newProxy, newProxy, deps);
      if (session === null) return "retry";
      rt.session = session;
      return "recovered";
    }

    case "agenda_empty":
    default: {
      // `agenda_empty` n'est pas une cause de récupération (le worker reste ARMED).
      // Défensif : ne rien faire, considérer comme récupéré pour ne pas boucler.
      console.warn(
        `[spain-recovery] ${deps.tag} cause de récupération inattendue "${String(kind)}" — aucune action`,
      );
      return "recovered";
    }
  }
}

// ─── Point d'entrée fire-and-forget ──────────────────────────────────────────

/**
 * Lance la récupération asynchrone d'un worker en tâche de fond et retourne
 * IMMÉDIATEMENT (fire-and-forget). Ne lance jamais d'exception vers l'appelant :
 * toute la logique est enveloppée dans une IIFE `async` protégée par `try/catch`.
 *
 * Le worker DOIT déjà être en état `RECOVERING` (posé par la boucle appelante).
 * Ce point d'entrée :
 *  - tente la récupération selon `kind` (voir `attemptRecovery`) ;
 *  - au SUCCÈS, fait transiter le worker vers `ARMED` via `transition(rt, "recovered")`
 *    (Requirement 3.5) — le worker rejoint la grille au prochain front de tick ;
 *  - à l'ÉCHEC, journalise `[spain-recovery]` (Req 3.6) puis retente avec un backoff
 *    de 5000 ms, jusqu'à `MAX_RECOVERY_ATTEMPTS` (10) tentatives ;
 *  - à l'ÉPUISEMENT des 10 tentatives, laisse le worker `RECOVERING` TERMINAL et
 *    journalise un abandon identifiant le worker et la cause (Requirement 3.7) ;
 *  - en cas de POOL ÉPUISÉ (réserve vide + rotation impossible), laisse le worker
 *    `RECOVERING` NON terminal et retourne sans boucler : la boucle de tick
 *    re-déclenchera une récupération au prochain tick (Requirements 14.1, 14.2, 14.5).
 *
 * @param rt   état runtime du worker (muté en place : `session`, `proxyUrl`, `state`).
 * @param kind cause classifiée de l'échec (ensemble fermé des causes de récupération).
 * @param deps dépendances injectées (pool de réserve, clés, config, tag).
 */
export function enterRecoveryAsync(
  rt: WorkerRuntimeState,
  kind: FailureKind,
  deps: RecoveryDeps,
): void {
  // Détache : la boucle principale du worker continue de dormir jusqu'au tick.
  void (async (): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      let verdict: AttemptVerdict;
      try {
        verdict = await attemptRecovery(rt, kind, deps);
      } catch (error) {
        // Filet de sécurité : aucune tentative ne doit laisser échapper une erreur.
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[spain-recovery] ${deps.tag} tentative ${attempt}/${MAX_RECOVERY_ATTEMPTS} (${kind}) — erreur inattendue: ${message}`,
        );
        verdict = "retry";
      }

      if (verdict === "recovered") {
        // Rejoint la grille au prochain front de tick (Requirement 3.5).
        transition(rt, "recovered");
        console.log(
          `[spain-recovery] ${deps.tag} ✅ récupéré (${kind}) en ${attempt} tentative(s) — RECOVERING → ARMED`,
        );
        return;
      }

      if (verdict === "pool_exhausted") {
        // NON terminal : reste RECOVERING, la boucle de tick retentera (Req 14.1/14.2/14.5).
        console.error(
          `[spain-recovery] ${deps.tag} 🕳️ pool épuisé (${kind}) — reste RECOVERING (non terminal), retentera au prochain tick`,
        );
        return;
      }

      // verdict === "retry" : journaliser l'échec et retenter après backoff (Req 3.6).
      console.error(
        `[spain-recovery] ${deps.tag} ❌ échec récupération (${kind}) tentative ${attempt}/${MAX_RECOVERY_ATTEMPTS}`,
      );
      if (attempt < MAX_RECOVERY_ATTEMPTS) {
        await sleep(RECOVERY_BACKOFF_MS);
      }
    }

    // Épuisement des 10 tentatives ⟹ RECOVERING terminal + log d'abandon (Req 3.7).
    console.error(
      `[spain-recovery] ${deps.tag} 🛑 abandon de récupération après ${MAX_RECOVERY_ATTEMPTS} tentatives — worker=${rt.dossierId} cause=${kind} — reste RECOVERING terminal`,
    );
  })().catch((error: unknown) => {
    // Ne jamais laisser échapper une erreur du fire-and-forget.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[spain-recovery] ${deps.tag} récupération interrompue (erreur non prévue): ${message}`);
  });
}
