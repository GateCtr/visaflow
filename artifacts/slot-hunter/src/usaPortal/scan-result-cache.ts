/**
 * Cache des résultats de scan résolus (appDetails + OFC) par username.
 *
 * Utilisé par le mode parallèle : après le scan initial d'un job USA,
 * les appDetails résolus sont stockés ici pour que le OFC Watcher
 * puisse les récupérer et commencer à poll avec des données valides.
 *
 * Le scan principal (usa-scan-main.ts) appelle `cacheResolvedScanData()`
 * après avoir résolu les détails de la demande et les OFC.
 */

import type { UsaOfc, UsaAppDetails } from "./usa-scan-types.js";

// ─── Cache en mémoire ───────────────────────────────────────────────────────

interface CachedScanData {
  appDetails: UsaAppDetails;
  ofcs: UsaOfc[];
  resolvedAt: number;
}

const scanDataCache = new Map<string, CachedScanData>();

/**
 * Stocke les appDetails et OFC résolus pour un username.
 * Appelé depuis le scan principal après résolution réussie.
 */
export function cacheResolvedScanData(username: string, appDetails: UsaAppDetails, ofcs: UsaOfc[]): void {
  const key = username.toLowerCase();
  scanDataCache.set(key, { appDetails, ofcs, resolvedAt: Date.now() });
  console.log(`[scan-cache] 📝 Données résolues pour ${key.slice(0, 12)}… (applicantId=${appDetails.applicantId}, ${ofcs.length} OFC(s))`);
}

/**
 * Récupère les derniers appDetails résolus pour un username.
 * Retourne null si aucun scan n'a encore été fait.
 */
export function getLastResolvedAppDetails(username: string): UsaAppDetails | null {
  const cached = scanDataCache.get(username.toLowerCase());
  return cached?.appDetails ?? null;
}

/**
 * Récupère le premier OFC résolu pour un username (Kinshasa = 1 seul OFC habituellement).
 * Retourne null si aucun scan n'a encore été fait.
 */
export function getLastResolvedOfc(username: string): UsaOfc | null {
  const cached = scanDataCache.get(username.toLowerCase());
  if (!cached || cached.ofcs.length === 0) return null;
  return cached.ofcs[0];
}

/**
 * Vérifie si un username a des données de scan en cache.
 */
export function hasCachedScanData(username: string): boolean {
  return scanDataCache.has(username.toLowerCase());
}
