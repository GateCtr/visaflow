/**
 * spain-worker-state-machine — Tri strict des échecs et transitions d'état worker
 * (feature spain-synchronized-scan).
 *
 * Ce module formalise le comportement de la machine à états worker
 * (ARMED / SCANNING / RECOVERING). Il expose pour l'instant `classify`, la
 * fonction pure et synchrone qui transforme un résultat de scan en `FailureKind`
 * déterministe (tri strict des échecs).
 *
 * Les transitions d'état (`transition`) et le helper d'initialisation
 * (`createRuntimeState`) seront ajoutés ici ultérieurement (tâche 5.1) ; le module
 * est structuré pour accueillir ces ajouts sans réorganisation.
 *
 * Contraintes de codage : strict mode, aucun `any`, types de retour explicites sur
 * toutes les fonctions exportées, logs préfixés `[spain-classify]`. Fonctions pures
 * et synchrones (retour en < 100 ms).
 */

import { hashSeed } from "./spain-grid-config.js";
import type { FailureKind, WorkerRuntimeState, WorkerState } from "./spain-grid-config.js";
import type { SpainCfSession } from "../spain-soax-solver.js";
import type { WorkerScanResult, WorkerPhpState } from "../spain-dossier-worker.js";

// ─── Classifier — tri strict des échecs ──────────────────────────────────────

/**
 * Détecte si un message d'erreur porte un code HTTP dans l'intervalle 500–599
 * inclus. Extraction purement textuelle (aucun réseau), retour synchrone immédiat.
 *
 * On isole une séquence de 3 chiffres à frontière de mot pour éviter les faux
 * positifs (ex. un identifiant à 6 chiffres contenant "504"), puis on vérifie que
 * la valeur tombe bien dans [500, 599].
 *
 * @param errorMessage message d'erreur éventuel du résultat de scan.
 * @returns `true` si un code 500–599 est présent, sinon `false`.
 */
function isHttp5xx(errorMessage?: string): boolean {
  if (typeof errorMessage !== "string" || errorMessage.length === 0) {
    return false;
  }

  // Tous les groupes de 3 chiffres à frontière de mot (502, 503, 504, …).
  const matches = errorMessage.match(/\b\d{3}\b/g);
  if (matches === null) {
    return false;
  }

  for (const token of matches) {
    const code = Number.parseInt(token, 10);
    if (code >= 500 && code <= 599) {
      return true;
    }
  }

  return false;
}

/**
 * Classe un résultat de scan en exactement un `FailureKind` (tri strict, total).
 *
 * Correspondance (Requirements 4.2–4.7, 4.9) :
 * - `proxy_error`          → `proxy_dead`
 * - `cf_expired`           → `cf_expired`
 * - `session_dead`         → `session_dead`
 * - `not_found`            → `agenda_empty` (signal NORMAL, pas une erreur)
 * - `error` + code 500–599 → `http_5xx`, sinon → `proxy_dead`
 * - statut inconnu/nul/absent/vide → `proxy_dead` + `console.warn` nommant le statut
 *
 * Note : le statut `found` est un SUCCÈS traité EN DEHORS de `classify` (dans la
 * boucle worker) ; ce n'est pas un `FailureKind`. S'il atteint tout de même cette
 * fonction, il est traité défensivement comme un statut non reconnu → `proxy_dead`
 * + avertissement, sans jamais lancer d'exception.
 *
 * Fonction pure et synchrone : retourne en < 100 ms, ne lance jamais.
 *
 * @param scan résultat d'un cycle de scan worker.
 * @returns le `FailureKind` correspondant (jamais `undefined`).
 */
export function classify(scan: WorkerScanResult): FailureKind {
  const status: unknown = scan?.status;

  switch (status) {
    case "proxy_error":
      return "proxy_dead";
    case "cf_expired":
      return "cf_expired";
    case "session_dead":
      return "session_dead";
    case "not_found":
      return "agenda_empty";
    case "error":
      return isHttp5xx(scan.errorMessage) ? "http_5xx" : "proxy_dead";
    default: {
      // Statut inconnu, nul, absent, vide, ou `found`/`ajax_unavailable` inattendu :
      // repli déterministe `proxy_dead` + avertissement non fatal nommant le statut.
      const received =
        status === undefined
          ? "undefined"
          : status === null
            ? "null"
            : status === ""
              ? "(empty)"
              : String(status);
      console.warn(`[spain-classify] statut de scan non reconnu: "${received}" -> proxy_dead par défaut`);
      return "proxy_dead";
    }
  }
}

// ─── Machine à états worker — transitions ────────────────────────────────────

/**
 * Ensemble fermé des causes d'échec qui déclenchent une récupération
 * (transition vers `RECOVERING`). `agenda_empty` en est volontairement exclu :
 * c'est un signal NORMAL qui maintient le worker `ARMED` (Requirement 4.8).
 */
const RECOVERY_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "proxy_dead",
  "http_5xx",
  "session_dead",
  "cf_expired",
]);

/** Ensemble des états valides — garde-fou contre tout état nul/indéfini. */
const VALID_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
  "ARMED",
  "SCANNING",
  "RECOVERING",
]);

/**
 * Applique une transition d'état sur le runtime d'un worker en fonction de
 * l'événement observé, puis retourne le nouvel état. Ne lance jamais.
 *
 * Table de transition (Requirements 3.1, 3.2, 3.3, 4.8) :
 * - `scan_ok`      ⟹ `ARMED` (cycle réussi, prêt pour le prochain front).
 * - `agenda_empty` ⟹ `ARMED` (signal NORMAL, aucun compteur d'erreur incrémenté).
 * - `recovered`    ⟹ `ARMED` (la récupération asynchrone a rétabli une session).
 * - `proxy_dead` / `http_5xx` / `session_dead` / `cf_expired` ⟹ `RECOVERING`
 *   (ensemble fermé des causes d'échec ; la récupération est pilotée en tâche de
 *   fond hors de cette fonction pure).
 *
 * Invariant garanti : `rt.state ∈ {ARMED, SCANNING, RECOVERING}`, jamais nul ni
 * indéfini. Si `rt` arrivait avec un état corrompu et un événement non reconnu,
 * la fonction se replie de façon déterministe sur `ARMED` (défensif, ne lance pas).
 *
 * La fonction mute `rt.state` en place ET retourne la valeur, pour convenance de
 * l'appelant.
 *
 * @param rt état runtime du worker (muté en place).
 * @param event événement de transition : un `FailureKind`, `"scan_ok"` ou `"recovered"`.
 * @returns le nouvel état worker (toujours valide).
 */
export function transition(
  rt: WorkerRuntimeState,
  event: FailureKind | "scan_ok" | "recovered",
): WorkerState {
  let next: WorkerState;

  if (event === "scan_ok" || event === "recovered" || event === "agenda_empty") {
    // Succès, récupération rétablie, ou agenda vide (signal normal) ⟹ ARMED.
    next = "ARMED";
  } else if (RECOVERY_KINDS.has(event)) {
    // Ensemble fermé des causes d'échec ⟹ récupération asynchrone.
    next = "RECOVERING";
  } else {
    // Événement non reconnu : repli déterministe défensif, ne lance jamais.
    console.warn(`[spain-fsm] événement de transition non reconnu: "${String(event)}" -> ARMED par défaut`);
    next = "ARMED";
  }

  // Garde-fou final : ne jamais laisser un état invalide s'installer.
  rt.state = VALID_STATES.has(next) ? next : "ARMED";
  return rt.state;
}

// ─── Helper d'initialisation d'état runtime ──────────────────────────────────

/** Options d'initialisation d'un `WorkerRuntimeState`. */
export interface CreateRuntimeStateOptions {
  /** Identifiant du dossier worker (sert aussi à dériver le `gridSeed`). */
  dossierId: string;
  /** URL du proxy assigné au worker. */
  proxyUrl: string;
  /** Session CF déjà armée (optionnelle : `undefined` tant que non armée). */
  session?: SpainCfSession;
  /** État PHP initialisé (optionnel). */
  phpState?: WorkerPhpState;
}

/**
 * Produit un `WorkerRuntimeState` valide et cohérent pour démarrer un worker.
 *
 * Garanties (Requirements 3.1, 2.4) :
 * - `state` initialisé à `ARMED` (jamais nul/indéfini).
 * - `gridSeed = hashSeed(dossierId)` : déterministe et stable pour un même dossier.
 * - `slotEverSeen` initialisé à `false` (drapeau monotone).
 * - `lastScanAtMs` initialisé à `0` (aucun scan effectué).
 *
 * @param opts options d'initialisation (dossierId + proxyUrl requis).
 * @returns un état runtime prêt à être piloté par la boucle worker.
 */
export function createRuntimeState(opts: CreateRuntimeStateOptions): WorkerRuntimeState {
  return {
    dossierId: opts.dossierId,
    state: "ARMED",
    gridSeed: hashSeed(opts.dossierId),
    session: opts.session,
    phpState: opts.phpState,
    proxyUrl: opts.proxyUrl,
    slotEverSeen: false,
    lastScanAtMs: 0,
  };
}
