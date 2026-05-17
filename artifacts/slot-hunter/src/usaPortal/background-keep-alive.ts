/**
 * Background Keep-Alive — Maintien de session entre les cycles de scan.
 *
 * PROBLÈME RÉSOLU :
 *   Le portail USA invalide les sessions après ~15 min d'inactivité API.
 *   Avec un tier "urgent" (8-15 min entre scans) + jitter scheduler (~20 min total),
 *   le bot dépasse souvent les 15 min d'inactivité entre deux cycles.
 *   Résultat : re-login à CHAQUE cycle → ~3 logins/heure au lieu de ~1/heure.
 *
 * SOLUTION :
 *   Un timer background envoie un GET léger (getLandingPageDetails) toutes les 8-12 min
 *   ENTRE les cycles de scan (quand le scheduler dort). Le serveur voit de l'activité
 *   et ne kill pas la session. Au réveil du cycle suivant, le token est réutilisé
 *   sans re-login.
 *
 * CYCLE DE VIE :
 *   1. Après un scan réussi (session maintenue) → startBackgroundKeepAlive(username)
 *   2. Timer envoie un ping toutes les 8-12 min (variable, anti-pattern)
 *   3. Au début du cycle suivant → stopBackgroundKeepAlive(username) (le scan prend le relais)
 *   4. Si le keep-alive échoue (401) → arrêt auto + invalidation du cache token
 *   5. Si la session expire (max duration ou proxy) → arrêt auto
 *
 * SÉCURITÉ :
 *   - Ne démarre QUE si le token est valide et la session maintenue
 *   - S'arrête automatiquement si le proxy est mort (vérification avant envoi)
 *   - S'arrête automatiquement X min avant l'expiration du proxy/JWT
 *   - Intervalle variable (8-12 min) pour éviter un pattern régulier
 *   - Un seul timer actif par compte (pas d'accumulation)
 */

import { tokenCache } from "./usa-http.js";
import { usaFetch, authHeaders } from "./usa-http.js";
import { isCachedTokenValid } from "./usa-http.js";
import { USA_LANDING_PAGE_URL, REFERER_DASHBOARD, PROXY_EXPIRY_BUFFER_MS } from "./config.js";
import { isSessionFrozen } from "./proxy-session-guard.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Intervalle minimum entre deux keep-alive background (ms). */
const BG_KEEP_ALIVE_MIN_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes

/** Intervalle maximum entre deux keep-alive background (ms). */
const BG_KEEP_ALIVE_MAX_INTERVAL_MS = 12 * 60 * 1000; // 12 minutes

/** Marge avant expiration proxy pour arrêter le keep-alive (ms). */
const BG_STOP_BEFORE_PROXY_EXPIRY_MS = 7 * 60 * 1000; // 7 min avant expiration

/** Marge avant expiration JWT pour arrêter le keep-alive (ms). */
const BG_STOP_BEFORE_JWT_EXPIRY_MS = 10 * 60 * 1000; // 10 min avant expiration

// ─── État interne ───────────────────────────────────────────────────────────

interface BgKeepAliveState {
  timer: ReturnType<typeof setTimeout> | null;
  username: string;
  applicationId?: string;
  startedAt: number;
  pingCount: number;
  lastPingAt: number;
}

/** Un seul timer par compte (Map clé = username lowercase). */
const bgTimers = new Map<string, BgKeepAliveState>();

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Démarre le keep-alive background pour un compte.
 * Appelé après un cycle de scan réussi quand la session est maintenue.
 * Si un timer existe déjà pour ce compte, il est remplacé.
 */
export function startBackgroundKeepAlive(username: string, applicationId?: string): void {
  const key = username.toLowerCase();

  // Vérifier qu'un token valide existe en cache
  const cached = tokenCache.get(key);
  if (!cached || !isCachedTokenValid(cached)) {
    return; // Pas de session active, pas de keep-alive
  }

  // Arrêter l'ancien timer s'il existe
  stopBackgroundKeepAlive(username);

  // Programmer le premier ping
  const interval = getRandomInterval();
  const timer = setTimeout(() => bgKeepAliveTick(key), interval);
  // Empêcher le timer de bloquer l'arrêt du process
  if (timer.unref) timer.unref();

  const state: BgKeepAliveState = {
    timer,
    username: key,
    applicationId,
    startedAt: Date.now(),
    pingCount: 0,
    lastPingAt: Date.now(), // Considérer le dernier scan comme activité
  };

  bgTimers.set(key, state);

  const intervalMin = Math.round(interval / 60000);
  console.log(`[bg-keepalive] ✅ Timer démarré pour ${key.slice(0, 12)}… — premier ping dans ${intervalMin}min`);
}

/**
 * Arrête le keep-alive background pour un compte.
 * Appelé au début d'un nouveau cycle de scan (le scan prend le relais)
 * ou quand la session est terminée/invalidée.
 */
export function stopBackgroundKeepAlive(username: string): void {
  const key = username.toLowerCase();
  const state = bgTimers.get(key);
  if (!state) return;

  if (state.timer) {
    clearTimeout(state.timer);
  }

  const durationMin = Math.round((Date.now() - state.startedAt) / 60000);
  console.log(`[bg-keepalive] 🛑 Timer arrêté pour ${key.slice(0, 12)}… (actif ${durationMin}min, ${state.pingCount} ping(s))`);

  bgTimers.delete(key);
}

/**
 * Arrête tous les keep-alive background (cleanup au shutdown).
 */
export function stopAllBackgroundKeepAlives(): void {
  for (const [key, state] of bgTimers) {
    if (state.timer) clearTimeout(state.timer);
    console.log(`[bg-keepalive] 🛑 Cleanup: timer ${key.slice(0, 12)}… arrêté`);
  }
  bgTimers.clear();
}

/**
 * Vérifie si un keep-alive background est actif pour un compte.
 */
export function isBackgroundKeepAliveActive(username: string): boolean {
  return bgTimers.has(username.toLowerCase());
}

// ─── Logique interne ────────────────────────────────────────────────────────

/**
 * Tick du keep-alive background. Envoie un ping et reprogramme le suivant.
 */
async function bgKeepAliveTick(key: string): Promise<void> {
  const state = bgTimers.get(key);
  if (!state) return; // Timer annulé entre-temps

  const cached = tokenCache.get(key);

  // ── Vérifications de sécurité avant d'envoyer le ping ──

  // 1. Token supprimé ou invalide → arrêter
  if (!cached || !isCachedTokenValid(cached)) {
    console.log(`[bg-keepalive] 🛑 Token invalide/expiré pour ${key.slice(0, 12)}… — arrêt auto`);
    bgTimers.delete(key);
    return;
  }

  // 2. Proxy gelé (mid-session guard) → arrêter
  if (isSessionFrozen(state.username)) {
    console.log(`[bg-keepalive] 🛑 Proxy gelé pour ${key.slice(0, 12)}… — arrêt auto`);
    bgTimers.delete(key);
    return;
  }

  // 3. Proxy va expirer bientôt → arrêter (pas la peine de maintenir une session qui va mourir)
  if (cached.proxyExpiresAt) {
    const timeUntilProxyExpiry = cached.proxyExpiresAt - Date.now();
    if (timeUntilProxyExpiry < BG_STOP_BEFORE_PROXY_EXPIRY_MS) {
      console.log(`[bg-keepalive] 🛑 Proxy expire dans ${Math.round(timeUntilProxyExpiry / 60000)}min pour ${key.slice(0, 12)}… — arrêt auto`);
      bgTimers.delete(key);
      return;
    }
  }

  // 4. JWT va expirer bientôt → arrêter
  const timeUntilJwtExpiry = cached.expiresAt - Date.now();
  if (timeUntilJwtExpiry < BG_STOP_BEFORE_JWT_EXPIRY_MS) {
    console.log(`[bg-keepalive] 🛑 JWT expire dans ${Math.round(timeUntilJwtExpiry / 60000)}min pour ${key.slice(0, 12)}… — arrêt auto`);
    bgTimers.delete(key);
    return;
  }

  // ── Envoi du ping ──
  try {
    const res = await usaFetch(USA_LANDING_PAGE_URL, {
      method: "GET",
      headers: authHeaders(cached.accessToken, REFERER_DASHBOARD, false, key),
    });

    state.pingCount++;
    state.lastPingAt = Date.now();

    if (res.status === 401) {
      // Session morte côté serveur malgré le keep-alive
      console.warn(`[bg-keepalive] ❌ Ping 401 pour ${key.slice(0, 12)}… — session morte, arrêt + invalidation cache`);
      tokenCache.delete(key);
      bgTimers.delete(key);
      return;
    }

    if (res.status === 429) {
      // Rate limit — la requête a été vue, session probablement active
      console.log(`[bg-keepalive] 🏓 Ping #${state.pingCount} pour ${key.slice(0, 12)}… — 429 (rate-limited, session active)`);
      cached.lastActivityAt = Date.now();
    } else if (res.ok || res.status < 500) {
      // Succès
      console.log(`[bg-keepalive] 🏓 Ping #${state.pingCount} OK pour ${key.slice(0, 12)}… — session maintenue`);
      cached.lastActivityAt = Date.now();
    } else {
      // 5xx — serveur down, on ne touche pas à la session
      console.warn(`[bg-keepalive] ⚠️ Ping #${state.pingCount} HTTP ${res.status} pour ${key.slice(0, 12)}… — ignoré`);
    }
  } catch (err) {
    // Erreur réseau — proxy down potentiel. On continue mais on log.
    console.warn(`[bg-keepalive] ⚠️ Ping erreur réseau pour ${key.slice(0, 12)}…: ${err}`);
    // Après 2 erreurs réseau consécutives, arrêter
    // (détection simplifiée : si le dernier ping réussi date de > 20 min)
    if (Date.now() - state.lastPingAt > 20 * 60 * 1000) {
      console.warn(`[bg-keepalive] 🛑 Trop d'erreurs réseau pour ${key.slice(0, 12)}… — arrêt auto`);
      bgTimers.delete(key);
      return;
    }
  }

  // ── Programmer le prochain ping ──
  const nextInterval = getRandomInterval();
  state.timer = setTimeout(() => bgKeepAliveTick(key), nextInterval);
  if (state.timer.unref) state.timer.unref();
}

/**
 * Génère un intervalle aléatoire entre BG_KEEP_ALIVE_MIN et MAX (8-12 min).
 */
function getRandomInterval(): number {
  return BG_KEEP_ALIVE_MIN_INTERVAL_MS + Math.random() * (BG_KEEP_ALIVE_MAX_INTERVAL_MS - BG_KEEP_ALIVE_MIN_INTERVAL_MS);
}
