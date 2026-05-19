/**
 * Relay Client — Interface bot ↔ Convex pour le système de relais.
 *
 * CONCEPT :
 *   L'éclaireur actuel détecte qu'il doit passer le relais (budget bas,
 *   fenêtre de relais atteinte, etc.). Il appelle requestHandoff() via Convex.
 *   Convex sélectionne le successeur, met à jour les rôles et retourne le résultat.
 *   Le bot ajuste ensuite le comportement de chaque compte en conséquence.
 *
 * CRITÈRES DE DÉCLENCHEMENT DU RELAIS :
 *   1. Budget login <= 2 restants (garder la réserve emergency pour blind booking)
 *   2. Fenêtre de relais planifiée atteinte (configurable admin, ex: toutes les 3h)
 *   3. Token expiré + cooldown long (> 20 min) → autant passer la main
 *   4. Compte restreint par le portail → relais obligatoire
 *
 * PROTOCOLE :
 *   1. Éclaireur: shouldHandoff() → true
 *   2. Éclaireur: requestHandoff(visaClass, username, reason)
 *   3. Convex: sélection successeur, mise à jour rôles
 *   4. Successeur: au prochain poll, voit son rôle = "eclaireur" → login + scan
 *   5. Successeur: confirmRelay(visaClass, username) → confirme qu'il est prêt
 */

import { getRemainingLogins } from "../core/session-pool.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RelayState {
  visaClass: string;
  currentEclaireur: string;
  currentEclaireurAppId: string;
  activeeSince: number;
  history?: Array<{
    from: string;
    to: string;
    reason: string;
    at: number;
  }>;
}

export interface HandoffResult {
  ok: boolean;
  newEclaireur?: string;
  newEclaireurAppId?: string;
  applicantName?: string;
  reason?: string;
}

export interface RelayDecision {
  shouldRelay: boolean;
  reason: string;
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Seuil de budget sous lequel on déclenche le relais (garder 3 pour emergency blind booking). */
const RELAY_BUDGET_THRESHOLD = 3;

/** Durée max d'un shift éclaireur avant relais forcé (3h = 180 min). */
const MAX_SHIFT_DURATION_MS = 3 * 60 * 60_000;

/** Durée minimale d'un shift avant de pouvoir passer le relais (30 min — éviter les ping-pong). */
const MIN_SHIFT_DURATION_MS = 30 * 60_000;

// ─── Décision de relais ─────────────────────────────────────────────────────

/**
 * Détermine si l'éclaireur actuel devrait passer le relais.
 *
 * @param username - Username de l'éclaireur actuel
 * @param shiftStartedAt - Timestamp de début du shift actuel
 * @param isRestricted - Le compte est-il restreint par le portail ?
 * @param hasValidToken - Le token est-il encore valide ?
 * @param packSize - Nombre de membres dans la meute (si 1 seul = pas de relais possible)
 */
export function shouldHandoff(
  username: string,
  shiftStartedAt: number,
  isRestricted: boolean,
  hasValidToken: boolean,
  packSize: number,
): RelayDecision {
  // Pas de relais si la meute n'a qu'un seul membre
  if (packSize <= 1) {
    return { shouldRelay: false, reason: "meute_solo" };
  }

  const now = Date.now();
  const shiftDuration = now - shiftStartedAt;

  // Pas de relais si le shift est trop court (anti ping-pong)
  if (shiftDuration < MIN_SHIFT_DURATION_MS) {
    return { shouldRelay: false, reason: "shift_trop_court" };
  }

  // 1. Compte restreint → relais obligatoire
  if (isRestricted) {
    return { shouldRelay: true, reason: "compte_restreint" };
  }

  // 2. Budget épuisé ou critique
  const remaining = getRemainingLogins(username);
  if (remaining <= RELAY_BUDGET_THRESHOLD) {
    return {
      shouldRelay: true,
      reason: `budget_critique (${remaining} logins restants, seuil=${RELAY_BUDGET_THRESHOLD})`,
    };
  }

  // 3. Shift trop long (> 3h) → relais préventif pour distribuer l'usure
  if (shiftDuration >= MAX_SHIFT_DURATION_MS) {
    return {
      shouldRelay: true,
      reason: `shift_max_atteint (${Math.round(shiftDuration / 60_000)} min > ${MAX_SHIFT_DURATION_MS / 60_000} min)`,
    };
  }

  // 4. Token expiré sans possibilité de re-login rapide
  if (!hasValidToken && remaining <= RELAY_BUDGET_THRESHOLD + 1) {
    return {
      shouldRelay: true,
      reason: "token_expire_budget_bas",
    };
  }

  return { shouldRelay: false, reason: "shift_normal" };
}

// ─── API HTTP vers Convex ───────────────────────────────────────────────────

/**
 * Récupère l'état du relay pour une meute.
 */
export async function getRelayState(
  convexUrl: string,
  hunterKey: string,
  visaClass: string,
): Promise<RelayState | null> {
  try {
    const url = `${convexUrl}/hunter/relay/state?visaClass=${encodeURIComponent(visaClass)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Hunter-Key": hunterKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { state: RelayState | null };
    return data.state;
  } catch {
    return null;
  }
}

/**
 * Demande un passage de relais à Convex.
 * Convex sélectionne le meilleur successeur et met à jour les rôles.
 */
export async function requestHandoff(
  convexUrl: string,
  hunterKey: string,
  visaClass: string,
  currentUsername: string,
  reason: string,
): Promise<HandoffResult> {
  try {
    const res = await fetch(`${convexUrl}/hunter/relay/handoff`, {
      method: "POST",
      headers: {
        "X-Hunter-Key": hunterKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visaClass, currentUsername, reason }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }

    const data = await res.json() as HandoffResult;
    return data;
  } catch (err) {
    return { ok: false, reason: `network_error: ${err}` };
  }
}

/**
 * Confirme que le successeur est prêt (token actif ou login réussi).
 */
export async function confirmRelay(
  convexUrl: string,
  hunterKey: string,
  visaClass: string,
  username: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${convexUrl}/hunter/relay/confirm`, {
      method: "POST",
      headers: {
        "X-Hunter-Key": hunterKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visaClass, username }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
}

/**
 * Récupère la liste des membres d'une meute.
 */
export async function getPackMembers(
  convexUrl: string,
  hunterKey: string,
  visaClass: string,
): Promise<Array<{ applicationId: string; username: string; applicantName: string; accountRole: string }>> {
  try {
    const url = `${convexUrl}/hunter/relay/pack?visaClass=${encodeURIComponent(visaClass)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Hunter-Key": hunterKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { members: Array<{ applicationId: string; username: string; applicantName: string; accountRole: string }> };
    return data.members;
  } catch {
    return [];
  }
}
