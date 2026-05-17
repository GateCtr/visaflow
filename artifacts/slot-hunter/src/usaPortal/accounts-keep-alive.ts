/**
 * Accounts Keep-Alive — Maintien de session pour TOUS les comptes USA actifs.
 *
 * MOTIVATION :
 *   Dans l'ancien modèle séquentiel, seul le compte "en cours de scan" avait
 *   un keep-alive actif. Les autres comptes perdaient leur session (timeout 15 min)
 *   et devaient se re-loguer à chaque tour → latence critique au moment du booking.
 *
 *   Dans le nouveau modèle (watcher + booking race), TOUS les comptes doivent avoir
 *   un token prêt en permanence pour participer à la race instantanément.
 *
 * FONCTIONNEMENT :
 *   1. Au démarrage, après le login initial de chaque dossier, on inscrit le compte.
 *   2. Un timer per-account envoie des pings toutes les 8-12 min (via background-keep-alive.ts).
 *   3. Si le token expire → le compte "dort" pendant le cooldown (8-25 min)
 *      puis le SCHEDULER (pas ce monitor) décide quand re-login.
 *   4. Si le proxy meurt → le compte dort jusqu'à la prochaine fenêtre de scan.
 *
 * RÈGLE CRITIQUE — PAS DE RE-LOGIN AUTOMATIQUE :
 *   Le re-login automatique (proactif ou réactif) est un TRIGGER de restriction
 *   de compte sur le portail USA. Le monitor ne doit JAMAIS re-login un compte.
 *   Il ne fait que :
 *     - Maintenir les sessions existantes vivantes (pings)
 *     - Détecter quand un token est mort et arrêter le keep-alive
 *     - Reporter le statut pour que le scheduler sache quand relancer un login
 *
 * INTÉGRATION :
 *   - Utilise background-keep-alive.ts pour les pings individuels (déjà implémenté)
 *   - Le login initial est fait UNE FOIS par le scheduler lors de l'inscription
 *   - Les re-logins sont UNIQUEMENT déclenchés par le scheduler principal
 *     qui respecte les cooldowns de config.ts (8-25 min post-expiry)
 */

import { tokenCache, isCachedTokenValid, isSessionInCooldown, makeIproyalStickyUrl, rotateIproyalSession } from "./usa-http.js";
import { getUsaSession } from "./usa-session.js";
import { startBackgroundKeepAlive, stopBackgroundKeepAlive, isBackgroundKeepAliveActive } from "./background-keep-alive.js";
import { initProxyGuard } from "./proxy-session-guard.js";
import { preFlightProxyCheck } from "./proxy-health-check.js";
import { makeBrightDataStickyUrl, startBrightDataKeepAlive, stopBrightDataKeepAlive } from "./brightdata-proxy.js";
import { isAccountRestricted, getAccountRestrictionDeadline } from "./account-restriction.js";
import { proxyPool } from "../browser.js";
import type { HunterJob } from "../convexClient.js";
import { botLog } from "../convexClient.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ManagedAccount {
  username: string;
  password: string;
  proxyUrl?: string;
  jobId: string;
  job: HunterJob;
  /** Timestamp du dernier login réussi. */
  lastLoginAt: number;
  /** Nombre de re-login effectués (informatif seulement). */
  reloginCount: number;
  /** Timestamp de quand le token est devenu invalide (pour tracking). */
  tokenDiedAt: number | null;
}

// ─── État global ────────────────────────────────────────────────────────────

const managedAccounts = new Map<string, ManagedAccount>();
let monitorTimer: ReturnType<typeof setInterval> | null = null;

/** Intervalle du monitor qui vérifie l'état de tous les comptes (ms). */
const MONITOR_INTERVAL_MS = 2 * 60_000; // Toutes les 2 min

// ─── Rotation entre comptes ─────────────────────────────────────────────────
// Chaque compte a un "budget" de sessions par jour et une durée max d'activité
// continue. Quand un compte atteint sa limite, il dort et l'autre prend le relais.
// Objectif : max 6-8 logins/jour/compte = ~2-3h actif puis 2-3h de repos.

/** Durée max d'activité continue avant repos forcé (ms). */
const MAX_ACTIVE_DURATION_MIN_MS = 2 * 60 * 60_000; // 2h min
const MAX_ACTIVE_DURATION_MAX_MS = 3.5 * 60 * 60_000; // 3.5h max

/** Durée de repos entre les périodes d'activité (ms). */
const REST_DURATION_MIN_MS = 2 * 60 * 60_000; // 2h min
const REST_DURATION_MAX_MS = 3.5 * 60 * 60_000; // 3.5h max

/** Max sessions (logins) par compte par jour (24h glissant). */
const MAX_SESSIONS_PER_DAY = 8;

interface AccountRotationState {
  /** Timestamp du début de la période d'activité actuelle. */
  activeSessionStartedAt: number | null;
  /** Durée max d'activité pour cette période (randomisée). */
  currentActiveDurationMs: number;
  /** Timestamp de début du repos (null si pas en repos). */
  restingUntil: number | null;
  /** Historique des logins (timestamps) pour le cap journalier. */
  loginTimestamps: number[];
}

const rotationState = new Map<string, AccountRotationState>();

function getRotationState(username: string): AccountRotationState {
  const key = username.toLowerCase();
  if (!rotationState.has(key)) {
    rotationState.set(key, {
      activeSessionStartedAt: null,
      currentActiveDurationMs: randomBetween(MAX_ACTIVE_DURATION_MIN_MS, MAX_ACTIVE_DURATION_MAX_MS),
      restingUntil: null,
      loginTimestamps: [],
    });
  }
  return rotationState.get(key)!;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Vérifie si un compte est autorisé à être actif (pas en repos, pas au-dessus du cap).
 */
export function isAccountAllowedToBeActive(username: string): boolean {
  const state = getRotationState(username);
  const now = Date.now();

  // Si en repos forcé → pas autorisé
  if (state.restingUntil && now < state.restingUntil) {
    return false;
  }

  // Si repos terminé → reset
  if (state.restingUntil && now >= state.restingUntil) {
    state.restingUntil = null;
    state.activeSessionStartedAt = null;
    state.currentActiveDurationMs = randomBetween(MAX_ACTIVE_DURATION_MIN_MS, MAX_ACTIVE_DURATION_MAX_MS);
  }

  // Vérifier le cap journalier (24h glissant)
  const dayAgo = now - 24 * 60 * 60_000;
  state.loginTimestamps = state.loginTimestamps.filter(ts => ts > dayAgo);
  if (state.loginTimestamps.length >= MAX_SESSIONS_PER_DAY) {
    return false;
  }

  // Vérifier la durée max d'activité continue
  if (state.activeSessionStartedAt) {
    const activeDuration = now - state.activeSessionStartedAt;
    if (activeDuration >= state.currentActiveDurationMs) {
      // Temps d'activité expiré → forcer le repos
      const restDuration = randomBetween(REST_DURATION_MIN_MS, REST_DURATION_MAX_MS);
      state.restingUntil = now + restDuration;
      state.activeSessionStartedAt = null;
      const restMin = Math.round(restDuration / 60_000);
      console.log(`[rotation] 💤 ${username.slice(0, 12)}… — repos forcé ${restMin}min (actif depuis ${Math.round(activeDuration / 60_000)}min)`);
      return false;
    }
  }

  return true;
}

/**
 * Enregistre un login réussi dans le tracking de rotation.
 */
export function recordLoginForRotation(username: string): void {
  const state = getRotationState(username);
  const now = Date.now();
  state.loginTimestamps.push(now);
  if (!state.activeSessionStartedAt) {
    state.activeSessionStartedAt = now;
  }
}

/**
 * Retourne le temps restant de repos pour un compte (0 si pas en repos).
 */
export function getRestTimeRemaining(username: string): number {
  const state = getRotationState(username);
  if (!state.restingUntil) return 0;
  const remaining = state.restingUntil - Date.now();
  return Math.max(0, remaining);
}

/**
 * Retourne le nombre de sessions restantes pour aujourd'hui.
 */
export function getSessionsRemainingToday(username: string): number {
  const state = getRotationState(username);
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  const todayLogins = state.loginTimestamps.filter(ts => ts > dayAgo).length;
  return Math.max(0, MAX_SESSIONS_PER_DAY - todayLogins);
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Inscrit un compte pour le keep-alive permanent.
 * Si le compte a déjà un token valide en cache, active immédiatement le ping.
 * Sinon, effectue un login initial (SEUL login autorisé par ce module).
 */
export async function registerAccountForKeepAlive(job: HunterJob): Promise<boolean> {
  const { embassyUsername: username, embassyPassword: password } = job.hunterConfig;
  const key = username.toLowerCase();

  if (managedAccounts.has(key)) {
    // Déjà inscrit — juste mettre à jour le job
    managedAccounts.get(key)!.job = job;
    return true;
  }

  // ── Résoudre le proxy avec failover complet (iProyal → BrightData → 2captcha) ──
  // Même logique que impl.ts : pre-flight check sur chaque provider avant d'adopter.
  // Si un proxy est dead, on passe au suivant AVANT de créer le JWT.
  let proxyUrl: string | undefined;
  if (job.hunterConfig.useResidentialProxy) {
    proxyUrl = await resolveProxyWithFailover(username, job.id, job.hunterConfig);
  }

  const account: ManagedAccount = {
    username,
    password,
    proxyUrl,
    jobId: job.id,
    job,
    lastLoginAt: 0,
    reloginCount: 0,
    tokenDiedAt: null,
  };

  managedAccounts.set(key, account);

  // Vérifier si un token existe déjà en cache
  const cached = tokenCache.get(key);
  if (cached && isCachedTokenValid(cached)) {
    // Token déjà valide → activer le keep-alive directement
    startBackgroundKeepAlive(username, job.id);
    console.log(`[accounts-ka] ✅ ${username.slice(0, 12)}… inscrit (token en cache valide) — keep-alive actif`);
    return true;
  }

  // Pas de token valide → login initial (le SEUL login que ce module fait)
  console.log(`[accounts-ka] 🔑 ${username.slice(0, 12)}… — login initial pour keep-alive...`);
  const session = await attemptLogin(account);
  if (session) {
    account.lastLoginAt = Date.now();
    recordLoginForRotation(username);
    startBackgroundKeepAlive(username, job.id);
    console.log(`[accounts-ka] ✅ ${username.slice(0, 12)}… inscrit — login OK, keep-alive actif`);
    return true;
  } else {
    console.warn(`[accounts-ka] ⚠️ ${username.slice(0, 12)}… — login initial échoué`);
    return false;
  }
}

/**
 * Désinscrit un compte du keep-alive permanent.
 */
export function unregisterAccountFromKeepAlive(username: string): void {
  const key = username.toLowerCase();
  stopBackgroundKeepAlive(username);
  managedAccounts.delete(key);
  console.log(`[accounts-ka] 🗑️ ${username.slice(0, 12)}… désinscrit`);
}

/**
 * Démarre le monitor global qui surveille l'état des comptes.
 * Le monitor ne fait PAS de re-login — il surveille et arrête les keep-alive morts.
 */
export function startAccountsMonitor(): void {
  if (monitorTimer) return; // Déjà actif

  monitorTimer = setInterval(() => {
    monitorTick().catch(err => {
      console.error("[accounts-ka] ❌ Erreur monitor:", err);
    });
  }, MONITOR_INTERVAL_MS);
  if (monitorTimer.unref) monitorTimer.unref();

  console.log(`[accounts-ka] 🔄 Monitor démarré (check toutes les ${MONITOR_INTERVAL_MS / 60_000} min, ${managedAccounts.size} compte(s))`);
}

/**
 * Arrête le monitor global.
 */
export function stopAccountsMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  // Arrêter tous les keep-alive individuels
  for (const [key] of managedAccounts) {
    stopBackgroundKeepAlive(key);
  }
  managedAccounts.clear();
  console.log("[accounts-ka] 🛑 Monitor arrêté, tous les keep-alive nettoyés");
}

/**
 * Retourne le nombre de comptes avec un token valide (prêts pour la race).
 */
export function getReadyAccountCount(): number {
  let count = 0;
  for (const [key] of managedAccounts) {
    const cached = tokenCache.get(key);
    if (cached && isCachedTokenValid(cached)) count++;
  }
  return count;
}

/**
 * Retourne le statut de tous les comptes gérés.
 */
export function getAccountsStatus(): Array<{
  username: string;
  hasValidToken: boolean;
  keepAliveActive: boolean;
  expiresInMin: number | null;
  reloginCount: number;
  dormantSinceMin: number | null;
  restingMin: number | null;
  sessionsToday: number;
}> {
  const statuses: ReturnType<typeof getAccountsStatus> = [];
  const now = Date.now();
  for (const [key, account] of managedAccounts) {
    const cached = tokenCache.get(key);
    const valid = cached ? isCachedTokenValid(cached) : false;
    const expiresIn = cached ? Math.round((cached.expiresAt - now) / 60_000) : null;
    const dormant = account.tokenDiedAt ? Math.round((now - account.tokenDiedAt) / 60_000) : null;
    const restRemaining = getRestTimeRemaining(account.username);
    const sessionsLeft = getSessionsRemainingToday(account.username);
    statuses.push({
      username: account.username.slice(0, 15) + "…",
      hasValidToken: valid,
      keepAliveActive: isBackgroundKeepAliveActive(key),
      expiresInMin: expiresIn,
      reloginCount: account.reloginCount,
      dormantSinceMin: dormant,
      restingMin: restRemaining > 0 ? Math.round(restRemaining / 60_000) : null,
      sessionsToday: MAX_SESSIONS_PER_DAY - sessionsLeft,
    });
  }
  return statuses;
}

/**
 * Vérifie si un compte est prêt pour un re-login (token mort + cooldown terminé + rotation OK).
 * Appelé par le scheduler pour savoir s'il peut déclencher un login.
 */
export function isAccountReadyForRelogin(username: string): boolean {
  const key = username.toLowerCase();
  const cached = tokenCache.get(key);
  
  // FIX-17: Vérifier la restriction portail AVANT tout — évite les pre-flight proxy inutiles
  // Un compte restreint (401 "Access temporarily restricted") ne doit JAMAIS tenter un login
  // jusqu'à la date d'expiration de la restriction (~180 min).
  if (isAccountRestricted(username)) {
    return false;
  }
  
  // Si pas de token → prêt (premier login)
  if (!cached) return isAccountAllowedToBeActive(username);
  
  // Si token valide → pas besoin de re-login
  if (isCachedTokenValid(cached)) return false;
  
  // Si en cooldown (8-25 min post-expiry de config.ts) → pas prêt
  if (isSessionInCooldown(cached)) return false;
  
  // Vérifier que la rotation autorise ce compte à être actif
  if (!isAccountAllowedToBeActive(username)) return false;
  
  // Token expiré + cooldown terminé + rotation OK + pas restreint → prêt pour re-login
  return true;
}

/**
 * Effectue un re-login pour un compte (appelé UNIQUEMENT par le scheduler).
 * Respecte les gardes de usa-session.ts (cooldown, restriction, etc.)
 */
export async function performScheduledRelogin(username: string): Promise<boolean> {
  const key = username.toLowerCase();
  const account = managedAccounts.get(key);
  if (!account) return false;

  // Déléguer à getUsaSession qui vérifie toutes les conditions
  const session = await attemptLogin(account);
  if (session) {
    account.lastLoginAt = Date.now();
    account.reloginCount++;
    account.tokenDiedAt = null;
    // Enregistrer le login dans le tracking de rotation
    recordLoginForRotation(account.username);
    startBackgroundKeepAlive(account.username, account.jobId);
    console.log(`[accounts-ka] ✅ ${key.slice(0, 12)}… re-login planifié #${account.reloginCount} réussi — keep-alive réactivé`);
    return true;
  }
  return false;
}

// ─── Logique interne ────────────────────────────────────────────────────────

/**
 * Monitor tick — surveille l'état des comptes.
 * NE FAIT PAS DE RE-LOGIN. Seulement :
 *   - Arrête les keep-alive pour les tokens morts
 *   - Réactive les keep-alive si token redevenu valide (login externe)
 *   - Log le statut pour debug
 */
async function monitorTick(): Promise<void> {
  const now = Date.now();
  let readyCount = 0;
  let dormantCount = 0;

  for (const [key, account] of managedAccounts) {
    const cached = tokenCache.get(key);

    // Cas 1 : Pas de token → le compte est dormant, arrêter le keep-alive s'il tourne
    if (!cached) {
      if (isBackgroundKeepAliveActive(key)) {
        stopBackgroundKeepAlive(account.username);
        console.log(`[accounts-ka] 💤 ${key.slice(0, 12)}… — token absent, keep-alive arrêté (dormant)`);
      }
      if (!account.tokenDiedAt) account.tokenDiedAt = now;
      dormantCount++;
      continue;
    }

    // Cas 2 : Token invalide → arrêter le keep-alive, marquer comme dormant
    if (!isCachedTokenValid(cached)) {
      if (isBackgroundKeepAliveActive(key)) {
        stopBackgroundKeepAlive(account.username);
        console.log(`[accounts-ka] 💤 ${key.slice(0, 12)}… — token expiré/invalide, keep-alive arrêté (dormant, cooldown en cours)`);
      }
      if (!account.tokenDiedAt) account.tokenDiedAt = now;
      dormantCount++;
      continue;
    }

    // Cas 3 : Token valide — s'assurer que le keep-alive est actif
    if (!isBackgroundKeepAliveActive(key)) {
      startBackgroundKeepAlive(account.username, account.jobId);
      console.log(`[accounts-ka] 🔄 ${key.slice(0, 12)}… — token valide, keep-alive réactivé`);
    }
    account.tokenDiedAt = null;
    readyCount++;
  }

  // Log périodique (pas à chaque tick pour éviter le spam)
  if (managedAccounts.size > 0) {
    console.log(`[accounts-ka] 📊 Status: ${readyCount}/${managedAccounts.size} prêts, ${dormantCount} dormants`);
  }
}

async function attemptLogin(account: ManagedAccount): Promise<boolean> {
  try {
    // FIX 14: Activer le proxy AVANT le login pour que le JWT soit lié à l'IP proxy.
    // FIX 16: Failover proxy — si le proxy actuel est dead, re-résoudre avec la chaîne complète.
    const { setUsaSessionProxy } = await import("./usa-http.js");

    let proxyToUse = account.proxyUrl;

    // Si on a un proxy assigné, vérifier qu'il est vivant avant de login
    if (proxyToUse) {
      const health = await preFlightProxyCheck(proxyToUse, account.jobId);
      if (!health.healthy) {
        console.warn(`[accounts-ka] ⚠️ Proxy actuel DEAD pour ${account.username.slice(0, 12)}…: ${health.error}`);
        console.log(`[accounts-ka] 🔄 FIX16: Failover proxy en cours...`);

        // Re-résoudre avec la chaîne complète
        const newProxy = await resolveProxyWithFailover(account.username, account.jobId, account.job.hunterConfig);
        if (newProxy) {
          proxyToUse = newProxy;
          account.proxyUrl = newProxy; // Mettre à jour pour les prochains cycles
          console.log(`[accounts-ka] ✅ FIX16: Nouveau proxy résolu pour ${account.username.slice(0, 12)}…`);
        } else {
          console.error(`[accounts-ka] ❌ FIX16: TOUS LES PROXIES DOWN — login avorté pour ${account.username.slice(0, 12)}…`);
          botLog({ applicationId: account.jobId, step: "proxy_failover", status: "fail", data: { reason: "Tous les proxies down", username: account.username } });
          return false;
        }
      }
    }

    if (proxyToUse) {
      setUsaSessionProxy(proxyToUse);
    }

    // getUsaSession vérifie : restriction, cooldown, proxy expiry, pendingLogin lock
    const session = await getUsaSession(account.username, account.password);

    // Reset le proxy global après le login (ne pas polluer les autres flows)
    setUsaSessionProxy(undefined);

    if (!session) return false;

    // Injecter le proxy dans le cache (pour que le booking race l'utilise)
    const key = account.username.toLowerCase();
    const cached = tokenCache.get(key);
    if (cached && proxyToUse) {
      cached.proxyUrl = proxyToUse;
      // Calculer l'expiration proxy :
      //   - iProyal sticky = 12h
      //   - BrightData = pas d'expiry fixe (keep-alive actif)
      //   - 2captcha rotatif = 30min
      const isIproyal = proxyToUse.includes("iproyal") || proxyToUse.includes("_session-");
      const isBrightData = proxyToUse.includes("brd.superproxy") || proxyToUse.includes("brightdata");
      if (isIproyal) {
        cached.proxyExpiresAt = Date.now() + 11.5 * 60 * 60 * 1000; // 11.5h
      } else if (isBrightData) {
        cached.proxyExpiresAt = Date.now() + 23 * 60 * 60 * 1000; // 23h (keep-alive maintient)
      } else {
        cached.proxyExpiresAt = Date.now() + 30 * 60 * 1000; // 30min (2captcha rotatif)
      }
    }

    return true;
  } catch (err) {
    // Reset le proxy global même en cas d'erreur
    const { setUsaSessionProxy } = await import("./usa-http.js");
    setUsaSessionProxy(undefined);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[accounts-ka] Login échoué pour ${account.username.slice(0, 12)}…: ${msg.slice(0, 100)}`);
    return false;
  }
}

// ─── Résolution proxy avec failover complet ─────────────────────────────────

/**
 * Résout un proxy fonctionnel en testant chaque provider dans l'ordre.
 * Ordre : iProyal (sticky 12h) → BrightData (sticky + keep-alive) → 2captcha (rotatif).
 * Supporte la préférence par compte via hunterConfig.preferredProxy.
 *
 * @returns L'URL du proxy fonctionnel, ou undefined si tous sont down.
 */
async function resolveProxyWithFailover(
  username: string,
  jobId: string,
  hunterConfig: HunterJob["hunterConfig"],
): Promise<string | undefined> {
  const hasIproyal = !!process.env.IPROYAL_PROXY_URL;
  const hasBrightData = !!process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL;

  // Respecter la préférence du compte (FIX 8 de impl.ts)
  const preferredProxy: string = (hunterConfig as Record<string, unknown>).preferredProxy as string ?? "iproyal";
  const preferIproyal = preferredProxy !== "brightdata";

  // Construire la séquence de providers à tester
  type ProxyProvider = { name: string; resolve: () => Promise<string | undefined> };
  const providers: ProxyProvider[] = [];

  const iproyalProvider: ProxyProvider = {
    name: "iProyal",
    resolve: async () => {
      if (!hasIproyal) return undefined;
      // Rotation de session pour obtenir une nouvelle IP (le précédent était peut-être dead)
      rotateIproyalSession(username);
      const url = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 720, username);
      const health = await preFlightProxyCheck(url, jobId);
      if (health.healthy) {
        console.log(`[accounts-ka] 🌐 iProyal OK (${health.latencyMs}ms) — sticky 12h`);
        return url;
      }
      console.warn(`[accounts-ka] ⚠️ iProyal FAILED: ${health.error}`);
      return undefined;
    },
  };

  const brightDataProvider: ProxyProvider = {
    name: "BrightData",
    resolve: async () => {
      if (!hasBrightData) return undefined;
      const url = makeBrightDataStickyUrl(process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL!, username);
      const health = await preFlightProxyCheck(url, jobId);
      if (health.healthy) {
        startBrightDataKeepAlive(url, username);
        console.log(`[accounts-ka] 🌐 BrightData OK (${health.latencyMs}ms) — sticky + keep-alive`);
        return url;
      }
      console.warn(`[accounts-ka] ⚠️ BrightData FAILED: ${health.error}`);
      return undefined;
    },
  };

  const twoCaptchaProvider: ProxyProvider = {
    name: "2captcha",
    resolve: async () => {
      if (!proxyPool.isConfigured) return undefined;
      const poolResult = await proxyPool.getProxy();
      if (poolResult?.proxy) {
        console.log(`[accounts-ka] 🌐 2captcha rotatif OK (fallback final)`);
        return poolResult.proxy;
      }
      console.warn(`[accounts-ka] ⚠️ 2captcha pool vide ou non configuré`);
      return undefined;
    },
  };

  // Ordre selon la préférence du compte
  if (preferIproyal) {
    providers.push(iproyalProvider, brightDataProvider, twoCaptchaProvider);
  } else {
    providers.push(brightDataProvider, iproyalProvider, twoCaptchaProvider);
  }

  // Tester chaque provider dans l'ordre
  for (const provider of providers) {
    const url = await provider.resolve();
    if (url) {
      botLog({ applicationId: jobId, step: "proxy_failover", status: "ok", data: { provider: provider.name, username } });
      return url;
    }
  }

  // Tous les providers sont down
  console.error(`[accounts-ka] ❌ TOUS LES PROXIES DOWN (${providers.map(p => p.name).join(" + ")}) pour ${username.slice(0, 12)}…`);
  botLog({ applicationId: jobId, step: "proxy_failover", status: "fail", data: { reason: "Tous les providers down", username } });
  return undefined;
}
