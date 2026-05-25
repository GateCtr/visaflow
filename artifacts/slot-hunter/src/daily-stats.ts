/**
 * Daily Stats Collector — Singleton qui collecte les métriques tout au long de la journée.
 *
 * Métriques trackées :
 * - Uptime (heure de démarrage)
 * - Scans totaux (par dossier et global)
 * - Slots trouvés (avec dossier + heure)
 * - Rate-limits (par dossier)
 * - Re-logins (préventifs vs réactifs)
 * - Dossiers actifs / en pause (avec raison)
 * - Proxy health (SOAX OK, fallback direct)
 * - Couverture (% du temps où au moins 1 scan actif)
 * - Heures creuses (périodes sans activité)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlotFoundEntry {
  applicantName: string;
  jobId: string;
  foundAt: number; // timestamp
  slotDate?: string;
  slotTime?: string;
}

export interface RateLimitEntry {
  jobId: string;
  applicantName: string;
  timestamp: number;
  reason?: string;
}

export interface ReloginEntry {
  jobId: string;
  applicantName: string;
  timestamp: number;
  type: "preventive" | "reactive" | "emergency";
}

export interface PausedDossierEntry {
  jobId: string;
  applicantName: string;
  pausedAt: number;
  reason: string;
}

export interface ProxyFallbackEntry {
  timestamp: number;
  reason: string;
}

export interface IdlePeriod {
  start: number;
  end: number;
}

export interface DossierScanCount {
  applicantName: string;
  jobId: string;
  count: number;
}

export interface DailyStatsSnapshot {
  startedAt: number;
  reportGeneratedAt: number;
  uptimeMs: number;
  totalScans: number;
  scansPerDossier: DossierScanCount[];
  effectiveScansPerHour: number;
  slotsFound: SlotFoundEntry[];
  rateLimits: RateLimitEntry[];
  relogins: { preventive: number; reactive: number; emergency: number; total: number };
  reloginEntries: ReloginEntry[];
  activeDossiers: DossierScanCount[];
  pausedDossiers: PausedDossierEntry[];
  proxyStatus: string;
  proxyFallbackCount: number;
  proxyFallbacks: ProxyFallbackEntry[];
  idlePeriods: IdlePeriod[];
  coveragePercent: number;
}

// ─── Singleton State ────────────────────────────────────────────────────────

let startedAt: number = Date.now();
let totalScans: number = 0;
const scansByDossier: Map<string, { applicantName: string; count: number }> = new Map();
const slotsFound: SlotFoundEntry[] = [];
const rateLimits: RateLimitEntry[] = [];
const relogins: ReloginEntry[] = [];
const pausedDossiers: Map<string, PausedDossierEntry> = new Map();
const proxyFallbacks: ProxyFallbackEntry[] = [];

// Couverture : on track les moments où au moins 1 scan est actif
let lastScanTimestamp: number = 0;
let totalActiveMs: number = 0;
// On considère le système "actif" si un scan a été fait dans les 10 dernières minutes
const ACTIVITY_WINDOW_MS = 10 * 60_000;
// Track idle periods (>15 min sans scan)
const IDLE_THRESHOLD_MS = 15 * 60_000;
const idlePeriods: IdlePeriod[] = [];
let currentIdleStart: number | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

/** Réinitialise les stats pour un nouveau jour */
export function resetDailyStats(): void {
  startedAt = Date.now();
  totalScans = 0;
  scansByDossier.clear();
  slotsFound.length = 0;
  rateLimits.length = 0;
  relogins.length = 0;
  pausedDossiers.clear();
  proxyFallbacks.length = 0;
  lastScanTimestamp = 0;
  totalActiveMs = 0;
  idlePeriods.length = 0;
  currentIdleStart = null;
}

/** Enregistre un scan effectué */
export function recordScan(jobId: string, applicantName: string): void {
  totalScans++;
  const existing = scansByDossier.get(jobId);
  if (existing) {
    existing.count++;
  } else {
    scansByDossier.set(jobId, { applicantName, count: 1 });
  }

  // Update coverage tracking
  const now = Date.now();
  if (lastScanTimestamp > 0) {
    const gap = now - lastScanTimestamp;
    if (gap <= ACTIVITY_WINDOW_MS) {
      totalActiveMs += gap;
    } else {
      // Was idle, add the activity window from last scan
      totalActiveMs += ACTIVITY_WINDOW_MS;
    }
  }

  // End idle period if we were idle
  if (currentIdleStart !== null) {
    idlePeriods.push({ start: currentIdleStart, end: now });
    currentIdleStart = null;
  }

  lastScanTimestamp = now;
}

/** Vérifie périodiquement si on entre en période d'inactivité */
export function checkIdleState(): void {
  if (lastScanTimestamp === 0) return;
  const now = Date.now();
  const gap = now - lastScanTimestamp;
  if (gap > IDLE_THRESHOLD_MS && currentIdleStart === null) {
    currentIdleStart = lastScanTimestamp + IDLE_THRESHOLD_MS;
  }
}

/** Enregistre un slot trouvé */
export function recordSlotFound(jobId: string, applicantName: string, slotDate?: string, slotTime?: string): void {
  slotsFound.push({
    jobId,
    applicantName,
    foundAt: Date.now(),
    slotDate,
    slotTime,
  });
}

/** Enregistre un rate-limit */
export function recordRateLimit(jobId: string, applicantName: string, reason?: string): void {
  rateLimits.push({
    jobId,
    applicantName,
    timestamp: Date.now(),
    reason,
  });
}

/** Enregistre un re-login */
export function recordRelogin(jobId: string, applicantName: string, type: "preventive" | "reactive" | "emergency"): void {
  relogins.push({
    jobId,
    applicantName,
    timestamp: Date.now(),
    type,
  });
}

/** Enregistre un dossier mis en pause */
export function recordPause(jobId: string, applicantName: string, reason: string): void {
  pausedDossiers.set(jobId, {
    jobId,
    applicantName,
    pausedAt: Date.now(),
    reason,
  });
}

/** Retire un dossier de la liste des pauses (reprise) */
export function recordResume(jobId: string): void {
  pausedDossiers.delete(jobId);
}

/** Enregistre un fallback proxy (passage de SOAX à direct ou autre) */
export function recordProxyFallback(reason: string): void {
  proxyFallbacks.push({
    timestamp: Date.now(),
    reason,
  });
}

/** Génère un snapshot complet des stats du jour */
export function getDailySnapshot(proxyStatusStr: string): DailyStatsSnapshot {
  const now = Date.now();
  const uptimeMs = now - startedAt;

  // Finaliser la couverture
  checkIdleState();
  let finalActiveMs = totalActiveMs;
  if (lastScanTimestamp > 0) {
    const sinceLast = now - lastScanTimestamp;
    if (sinceLast <= ACTIVITY_WINDOW_MS) {
      finalActiveMs += sinceLast;
    } else {
      finalActiveMs += ACTIVITY_WINDOW_MS;
    }
  }
  const coveragePercent = uptimeMs > 0 ? Math.min(100, Math.round((finalActiveMs / uptimeMs) * 100)) : 0;

  // Scans/heure effectifs
  const uptimeHours = uptimeMs / 3_600_000;
  const effectiveScansPerHour = uptimeHours > 0 ? Math.round((totalScans / uptimeHours) * 10) / 10 : 0;

  // Relogins par type
  const preventiveRelogins = relogins.filter(r => r.type === "preventive").length;
  const reactiveRelogins = relogins.filter(r => r.type === "reactive").length;
  const emergencyRelogins = relogins.filter(r => r.type === "emergency").length;

  // Scans par dossier
  const scansPerDossier: DossierScanCount[] = [];
  for (const [jobId, data] of scansByDossier) {
    scansPerDossier.push({ jobId, applicantName: data.applicantName, count: data.count });
  }
  scansPerDossier.sort((a, b) => b.count - a.count);

  // Dossiers actifs (ceux qui ont des scans)
  const activeDossiers = scansPerDossier.filter(d => d.count > 0);

  // Idle periods — fermer la période courante si applicable
  const finalIdlePeriods = [...idlePeriods];
  if (currentIdleStart !== null) {
    finalIdlePeriods.push({ start: currentIdleStart, end: now });
  }

  return {
    startedAt,
    reportGeneratedAt: now,
    uptimeMs,
    totalScans,
    scansPerDossier,
    effectiveScansPerHour,
    slotsFound: [...slotsFound],
    rateLimits: [...rateLimits],
    relogins: {
      preventive: preventiveRelogins,
      reactive: reactiveRelogins,
      emergency: emergencyRelogins,
      total: relogins.length,
    },
    reloginEntries: [...relogins],
    activeDossiers,
    pausedDossiers: [...pausedDossiers.values()],
    proxyStatus: proxyStatusStr,
    proxyFallbackCount: proxyFallbacks.length,
    proxyFallbacks: [...proxyFallbacks],
    idlePeriods: finalIdlePeriods,
    coveragePercent,
  };
}

/** Retourne le timestamp de démarrage */
export function getStartedAt(): number {
  return startedAt;
}
