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
 *   3. Si le token expire → re-login automatique (avec cooldown).
 *   4. Si le proxy meurt → rotation + re-login au prochain cycle.
 *
 * INTÉGRATION :
 *   - Utilise background-keep-alive.ts pour les pings individuels (déjà implémenté)
 *   - Ajoute la coordination : login initial, monitoring, re-login automatique
 *   - Appelé par index.ts au démarrage et quand de nouveaux dossiers apparaissent
 */

import { tokenCache, isCachedTokenValid } from "./usa-http.js";
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
  /** Nombre de re-login effectués. */
  reloginCount: number;
  /** Flag si le compte est en phase de cooldown (ne pas re-login). */
  inCooldown: boolean;
}

// ─── État global ────────────────────────────────────────────────────────────

const managedAccounts = new Map<string, ManagedAccount>();
let monitorTimer: ReturnType<typeof setInterval> | null = null;

/** Intervalle du monitor qui vérifie l'état de tous les comptes (ms). */
const MONITOR_INTERVAL_MS = 2 * 60_000; // Toutes les 2 min

/** Cooldown après un re-login automatique (ms). */
const RELOGIN_COOLDOWN_MS = 10 * 60_000; // 10 min

/** Marge avant expiration JWT pour déclencher un re-login proactif. */
const PROACTIVE_RELOGIN_BUFFER_MS = 12 * 60_000; // 12 min avant expiry

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Inscrit un compte pour le keep-alive permanent.
 * Si le compte a déjà un token valide en cache, active immédiatement le ping.
 * Sinon, effectue un login initial.
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
    inCooldown: false,
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

  // Pas de token valide → login initial
  console.log(`[accounts-ka] 🔑 ${username.slice(0, 12)}… — login initial pour keep-alive...`);
  const session = await attemptLogin(account);
  if (session) {
    startBackgroundKeepAlive(username, job.id);
    console.log(`[accounts-ka] ✅ ${username.slice(0, 12)}… inscrit — login OK, keep-alive actif`);
    return true;
  } else {
    console.warn(`[accounts-ka] ⚠️ ${username.slice(0, 12)}… — login initial échoué, sera retenté par le monitor`);
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
 * Démarre le monitor global qui surveille tous les comptes.
 * Vérifie toutes les 2 min si un token est sur le point d'expirer et re-login si nécessaire.
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
}> {
  const statuses: ReturnType<typeof getAccountsStatus> = [];
  for (const [key, account] of managedAccounts) {
    const cached = tokenCache.get(key);
    const valid = cached ? isCachedTokenValid(cached) : false;
    const expiresIn = cached ? Math.round((cached.expiresAt - Date.now()) / 60_000) : null;
    statuses.push({
      username: account.username.slice(0, 15) + "…",
      hasValidToken: valid,
      keepAliveActive: isBackgroundKeepAliveActive(key),
      expiresInMin: expiresIn,
      reloginCount: account.reloginCount,
    });
  }
  return statuses;
}

// ─── Logique interne ────────────────────────────────────────────────────────

async function monitorTick(): Promise<void> {
  const now = Date.now();

  for (const [key, account] of managedAccounts) {
    // Skip si en cooldown
    if (account.inCooldown) {
      if (now - account.lastLoginAt < RELOGIN_COOLDOWN_MS) continue;
      account.inCooldown = false;
    }

    const cached = tokenCache.get(key);

    // Cas 1 : Pas de token du tout → re-login
    if (!cached) {
      console.log(`[accounts-ka] 🔑 ${key.slice(0, 12)}… — pas de token, re-login...`);
      await handleRelogin(account);
      continue;
    }

    // Cas 2 : Token invalide (expiré, proxy mort, etc.) → re-login
    if (!isCachedTokenValid(cached)) {
      console.log(`[accounts-ka] 🔑 ${key.slice(0, 12)}… — token invalide, re-login...`);
      await handleRelogin(account);
      continue;
    }

    // Cas 3 : Token va expirer bientôt → re-login proactif
    const timeToExpiry = cached.expiresAt - now;
    if (timeToExpiry < PROACTIVE_RELOGIN_BUFFER_MS) {
      console.log(`[accounts-ka] 🔑 ${key.slice(0, 12)}… — token expire dans ${Math.round(timeToExpiry / 60_000)}min, re-login proactif...`);
      // Supprimer le cache pour forcer un nouveau login
      tokenCache.delete(key);
      await handleRelogin(account);
      continue;
    }

    // Cas 4 : Token valide mais keep-alive pas actif → réactiver
    if (!isBackgroundKeepAliveActive(key)) {
      startBackgroundKeepAlive(account.username, account.jobId);
    }
  }
}

async function handleRelogin(account: ManagedAccount): Promise<void> {
  const key = account.username.toLowerCase();

  // Arrêter le keep-alive existant
  stopBackgroundKeepAlive(account.username);

  const session = await attemptLogin(account);
  if (session) {
    account.lastLoginAt = Date.now();
    account.reloginCount++;
    account.inCooldown = true; // Cooldown pour ne pas spammer les logins
    startBackgroundKeepAlive(account.username, account.jobId);
    console.log(`[accounts-ka] ✅ ${key.slice(0, 12)}… re-login #${account.reloginCount} réussi — keep-alive réactivé`);
  } else {
    account.inCooldown = true;
    account.lastLoginAt = Date.now();
    console.warn(`[accounts-ka] ❌ ${key.slice(0, 12)}… re-login échoué — retry dans ${RELOGIN_COOLDOWN_MS / 60_000}min`);
  }
}

async function attemptLogin(account: ManagedAccount): Promise<boolean> {
  try {
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
