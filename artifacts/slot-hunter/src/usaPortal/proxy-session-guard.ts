/**
 * Pillar 2 — Mid-Session Proxy Liveness Guard
 *
 * Protège les comptes lorsqu'un proxy tombe EN PLEINE SESSION (après login réussi).
 *
 * Problème résolu :
 *   Login via proxy IP-A → JWT lié à IP-A → proxy tombe → requête suivante part
 *   soit via IP Railway (162.x.x.x) soit timeout → portail détecte IP mismatch
 *   → activation CAPTCHA, restriction compte, voire blocage.
 *
 * Stratégie :
 *   - Vérifier la santé du proxy PÉRIODIQUEMENT (pas à chaque requête pour éviter le surcoût)
 *   - Si le proxy est confirmé mort → GELER la session (bloquer toute requête API)
 *   - Le cycle suivant (runUsaApiSession) détectera que le token cache est invalidé
 *     et fera un re-login propre avec un nouveau proxy
 *
 * Fréquence des checks :
 *   - Toutes les 2 minutes minimum (configurable)
 *   - Le check est un simple GET vers ipify.org via le proxy (< 5s)
 *   - Si le check échoue 2 fois consécutives → proxy déclaré mort
 */

import { botLog } from "../convexClient.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Intervalle minimum entre deux health checks mid-session (ms). */
const MID_SESSION_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** Timeout pour le health check mid-session (ms). */
const MID_SESSION_CHECK_TIMEOUT_MS = 5000;

/** Nombre d'échecs consécutifs avant de déclarer le proxy mort. */
const MAX_CONSECUTIVE_FAILURES = 2;

/** URL légère pour tester la connectivité. */
const HEALTH_CHECK_URL = "https://api.ipify.org?format=text";

// ─── État interne ───────────────────────────────────────────────────────────

interface ProxyGuardState {
  /** Proxy URL surveillé. */
  proxyUrl: string;
  /** Timestamp du dernier health check réussi. */
  lastCheckAt: number;
  /** Nombre d'échecs consécutifs. */
  consecutiveFailures: number;
  /** true si le proxy est déclaré mort (session gelée). */
  frozen: boolean;
  /** IP de sortie connue (du login). */
  expectedExitIp?: string;
}

/** État par username (chaque compte a son propre proxy guard). */
const guardStates = new Map<string, ProxyGuardState>();

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Initialise le guard pour une nouvelle session.
 * Appelé après un login réussi avec proxy.
 */
export function initProxyGuard(username: string, proxyUrl: string, exitIp?: string): void {
  const key = username.toLowerCase();
  guardStates.set(key, {
    proxyUrl,
    lastCheckAt: Date.now(),
    consecutiveFailures: 0,
    frozen: false,
    expectedExitIp: exitIp,
  });
  console.log(`[proxy-guard] ✅ Guard initialisé pour ${key.slice(0, 12)}… (IP: ${exitIp ?? "inconnue"})`);
}

/**
 * Libère le guard quand la session est terminée.
 */
export function releaseProxyGuard(username: string): void {
  guardStates.delete(username.toLowerCase());
}

/**
 * Vérifie si la session est gelée (proxy mort mid-session).
 * Si gelée, toute requête API DOIT être bloquée.
 */
export function isSessionFrozen(username?: string): boolean {
  if (!username) {
    // Vérifier si N'IMPORTE QUELLE session active est gelée
    for (const state of guardStates.values()) {
      if (state.frozen) return true;
    }
    return false;
  }
  const state = guardStates.get(username.toLowerCase());
  return state?.frozen ?? false;
}

/**
 * Vérifie la santé du proxy mid-session si l'intervalle est écoulé.
 * 
 * Retourne :
 *  - true  → proxy OK (ou check pas encore nécessaire)
 *  - false → proxy MORT → session gelée, toute requête bloquée
 *
 * IMPORTANT : cette fonction est NON-BLOQUANTE si le dernier check est récent.
 * Elle ne fait un vrai appel réseau que toutes les MID_SESSION_CHECK_INTERVAL_MS.
 */
export async function checkProxyLiveness(username?: string): Promise<boolean> {
  // Trouver l'état pertinent
  let state: ProxyGuardState | undefined;
  if (username) {
    state = guardStates.get(username.toLowerCase());
  } else {
    // Prendre le premier (cas single-account)
    state = guardStates.values().next().value as ProxyGuardState | undefined;
  }

  // Pas de proxy configuré → pas de guard nécessaire
  if (!state) return true;

  // Déjà gelé → bloquer immédiatement
  if (state.frozen) return false;

  // Check pas encore nécessaire (intervalle non écoulé)
  const elapsed = Date.now() - state.lastCheckAt;
  if (elapsed < MID_SESSION_CHECK_INTERVAL_MS) return true;

  // ── Exécuter le health check ──────────────────────────────────────────────
  const healthy = await performHealthCheck(state);

  if (healthy) {
    state.lastCheckAt = Date.now();
    state.consecutiveFailures = 0;
    return true;
  }

  // Échec
  state.consecutiveFailures++;
  state.lastCheckAt = Date.now();

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    // PROXY MORT → GELER la session
    state.frozen = true;
    const masked = state.proxyUrl.replace(/:([^:@]+)@/, ":***@");
    console.error(`[proxy-guard] 🚨 PROXY MORT mid-session — SESSION GELÉE`);
    console.error(`[proxy-guard]    ${state.consecutiveFailures} échecs consécutifs`);
    console.error(`[proxy-guard]    Proxy: ${masked.slice(0, 50)}…`);
    console.error(`[proxy-guard]    → Toute requête API bloquée jusqu'au prochain cycle (re-login)`);

    botLog({
      applicationId: username ?? "unknown",
      step: "proxy_guard_freeze",
      status: "fail",
      data: {
        consecutiveFailures: state.consecutiveFailures,
        proxyUrl: masked.slice(0, 50),
        expectedIp: state.expectedExitIp,
      },
    });

    return false;
  }

  // Premier échec → pas encore gelé, on avertit
  console.warn(
    `[proxy-guard] ⚠️ Health check échoué (${state.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}) — prochain check forcé dans 30s`,
  );
  // Réduire l'intervalle pour le prochain check (vérification rapide)
  state.lastCheckAt = Date.now() - MID_SESSION_CHECK_INTERVAL_MS + 30_000;

  return true; // Pas encore gelé
}

// ─── Health check interne ───────────────────────────────────────────────────

async function performHealthCheck(state: ProxyGuardState): Promise<boolean> {
  try {
    const { ProxyAgent } = await import("undici");
    const agent = new ProxyAgent(state.proxyUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MID_SESSION_CHECK_TIMEOUT_MS);

    const res = await fetch(HEALTH_CHECK_URL, {
      signal: controller.signal,
      // @ts-expect-error — undici dispatcher pour le proxy
      dispatcher: agent,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[proxy-guard] Health check HTTP ${res.status}`);
      return false;
    }

    const exitIp = (await res.text()).trim();

    // Vérifier que l'IP de sortie n'a pas changé (rotation inattendue)
    if (state.expectedExitIp && exitIp !== state.expectedExitIp) {
      console.warn(
        `[proxy-guard] ⚠️ IP de sortie changée mid-session: ${state.expectedExitIp} → ${exitIp}`,
      );
      // IP changée = le JWT est lié à l'ancienne IP → va causer un 401
      // On freeze aussi dans ce cas
      return false;
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("abort") || msg.includes("timeout");
    console.warn(
      `[proxy-guard] Health check échoué: ${isTimeout ? "TIMEOUT" : msg.slice(0, 100)}`,
    );
    return false;
  }
}
