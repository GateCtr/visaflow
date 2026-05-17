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

import { tokenCache, isCachedTokenValid, isSessionInCooldown } from "./usa-http.js";
import { getUsaSession } from "./usa-session.js";
import { startBackgroundKeepAlive, stopBackgroundKeepAlive, isBackgroundKeepAliveActive } from "./background-keep-alive.js";
import { initProxyGuard } from "./proxy-session-guard.js";
import { preFlightProxyCheck } from "./proxy-health-check.js";
import { makeIproyalStickyUrl } from "./usa-http.js";
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

  // Résoudre le proxy pour ce compte
  let proxyUrl: string | undefined;
  if (job.hunterConfig.useResidentialProxy) {
    if (process.env.IPROYAL_PROXY_URL) {
      proxyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL, 720, username);
    } else if (proxyPool.isConfigured) {
      const poolResult = await proxyPool.getProxy();
      proxyUrl = poolResult?.proxy;
    }
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
}> {
  const statuses: ReturnType<typeof getAccountsStatus> = [];
  const now = Date.now();
  for (const [key, account] of managedAccounts) {
    const cached = tokenCache.get(key);
    const valid = cached ? isCachedTokenValid(cached) : false;
    const expiresIn = cached ? Math.round((cached.expiresAt - now) / 60_000) : null;
    const dormant = account.tokenDiedAt ? Math.round((now - account.tokenDiedAt) / 60_000) : null;
    statuses.push({
      username: account.username.slice(0, 15) + "…",
      hasValidToken: valid,
      keepAliveActive: isBackgroundKeepAliveActive(key),
      expiresInMin: expiresIn,
      reloginCount: account.reloginCount,
      dormantSinceMin: dormant,
    });
  }
  return statuses;
}

/**
 * Vérifie si un compte est prêt pour un re-login (token mort + cooldown terminé).
 * Appelé par le scheduler pour savoir s'il peut déclencher un login.
 */
export function isAccountReadyForRelogin(username: string): boolean {
  const key = username.toLowerCase();
  const cached = tokenCache.get(key);
  
  // Si pas de token → prêt (premier login)
  if (!cached) return true;
  
  // Si token valide → pas besoin de re-login
  if (isCachedTokenValid(cached)) return false;
  
  // Si en cooldown (8-25 min post-expiry de config.ts) → pas prêt
  if (isSessionInCooldown(cached)) return false;
  
  // Token expiré + cooldown terminé → prêt pour re-login
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
    // getUsaSession vérifie : restriction, cooldown, proxy expiry, pendingLogin lock
    const session = await getUsaSession(account.username, account.password);
    if (!session) return false;

    // Injecter le proxy dans le cache (pour que le booking race l'utilise)
    const key = account.username.toLowerCase();
    const cached = tokenCache.get(key);
    if (cached && account.proxyUrl) {
      cached.proxyUrl = account.proxyUrl;
      // Calculer l'expiration proxy (iProyal = 12h, 2captcha = 30min)
      const isIproyal = account.proxyUrl.includes("iproyal") || account.proxyUrl.includes("_session-");
      cached.proxyExpiresAt = Date.now() + (isIproyal ? 11.5 * 60 * 60 * 1000 : 30 * 60 * 1000);
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[accounts-ka] Login échoué pour ${account.username.slice(0, 12)}…: ${msg.slice(0, 100)}`);
    return false;
  }
}
