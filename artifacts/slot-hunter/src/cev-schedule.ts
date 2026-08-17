/**
 * cev-schedule.ts — Smart scheduling pour CEV Belgique.
 *
 * Lit la config depuis Convex (botConfig key-value) et détermine :
 *   - Si le scan est autorisé maintenant (jour + tranche horaire)
 *   - Quel intervalle de polling utiliser (haute/moyenne/basse densité)
 *   - Combien de temps dormir si on est hors fenêtre
 *
 * Config keys Convex :
 *   cev_schedule_enabled      — "1" pour activer le schedule (sinon 24/7)
 *   cev_schedule_active_days  — CSV ISO day numbers (1=lun, 7=dim). Ex: "1,2,3,4,5"
 *   cev_schedule_timezone     — IANA timezone. Ex: "Europe/Brussels"
 *   cev_schedule_high         — "HH:MM-HH:MM=intervalSec,..." (haute densité)
 *   cev_schedule_med          — "HH:MM-HH:MM=intervalSec,..." (moyenne densité)
 *   cev_schedule_low          — "HH:MM-HH:MM=intervalSec,..." (basse densité)
 *
 * Heures non couvertes par high/med/low = OFF (pas de scan).
 */

import { getBotConfigValue } from "./convexClient.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduleBand {
  startMin: number; // minutes depuis minuit (ex: 07:00 = 420)
  endMin: number;   // minutes depuis minuit (ex: 14:00 = 840)
  intervalSec: number;
}

export interface CevScheduleResult {
  /** Si false, le scan est interdit maintenant (jour OFF ou hors fenêtre). */
  allowed: boolean;
  /** Intervalle de polling en ms (si allowed=true). */
  intervalMs: number;
  /** Temps en ms avant la prochaine fenêtre active (si allowed=false). */
  sleepUntilNextWindowMs: number;
  /** Label de la tranche active pour les logs. */
  bandLabel: string;
}

// ─── Cache en mémoire (évite de spammer Convex à chaque cycle) ─────────────────

interface CachedScheduleConfig {
  enabled: boolean;
  activeDays: Set<number>;
  timezone: string;
  bands: ScheduleBand[];
  fetchedAt: number;
}

let _cache: CachedScheduleConfig | null = null;
const CACHE_TTL_MS = 5 * 60_000; // Re-fetch config toutes les 5 min

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Parse une tranche horaire "HH:MM-HH:MM=intervalSec".
 * Supporte les tranches qui traversent minuit (ex: 22:00-02:00=300).
 */
function parseBand(raw: string): ScheduleBand | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})=(\d+)$/);
  if (!m) return null;
  const startMin = parseInt(m[1]) * 60 + parseInt(m[2]);
  const endMin = parseInt(m[3]) * 60 + parseInt(m[4]);
  const intervalSec = parseInt(m[5]);
  if (intervalSec < 10 || intervalSec > 3600) return null;
  return { startMin, endMin, intervalSec };
}

/**
 * Parse une liste de tranches séparées par des virgules.
 */
function parseBands(raw: string | null): ScheduleBand[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(",")
    .map((s) => parseBand(s))
    .filter((b): b is ScheduleBand => b !== null);
}

// ─── Config fetching ──────────────────────────────────────────────────────────

async function loadScheduleConfig(): Promise<CachedScheduleConfig> {
  // Vérifier le cache
  if (_cache && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache;
  }

  const [enabledRaw, daysRaw, tzRaw, highRaw, medRaw, lowRaw] = await Promise.all([
    getBotConfigValue("cev_schedule_enabled"),
    getBotConfigValue("cev_schedule_active_days"),
    getBotConfigValue("cev_schedule_timezone"),
    getBotConfigValue("cev_schedule_high"),
    getBotConfigValue("cev_schedule_med"),
    getBotConfigValue("cev_schedule_low"),
  ]);

  const enabled = enabledRaw === "1";
  const activeDays = new Set(
    (daysRaw || "1,2,3,4,5")
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => n >= 1 && n <= 7),
  );
  const timezone = tzRaw || "Europe/Brussels";

  const bands: ScheduleBand[] = [
    ...parseBands(highRaw || "07:00-14:00=90"),
    ...parseBands(medRaw || "05:00-07:00=180,15:00-22:00=180"),
    ...parseBands(lowRaw),
  ];

  _cache = { enabled, activeDays, timezone, bands, fetchedAt: Date.now() };
  return _cache;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Retourne l'heure courante dans la timezone configurée.
 * @returns { dayOfWeek (ISO: 1=lun, 7=dim), minuteOfDay (0-1439) }
 */
function getNowInTimezone(tz: string): { dayOfWeek: number; minuteOfDay: number } {
  const now = new Date();
  // Utiliser Intl pour obtenir l'heure locale dans la timezone cible
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);

  let hour = 0;
  let minute = 0;
  let weekday = "";
  for (const part of parts) {
    if (part.type === "hour") hour = parseInt(part.value);
    if (part.type === "minute") minute = parseInt(part.value);
    if (part.type === "weekday") weekday = part.value;
  }

  // Convertir weekday short (Mon, Tue, ...) en ISO (1=Mon, 7=Sun)
  const dayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const dayOfWeek = dayMap[weekday] ?? 1;
  const minuteOfDay = hour * 60 + minute;

  return { dayOfWeek, minuteOfDay };
}

/**
 * Vérifie si minuteOfDay est dans une bande (supporte les bandes qui traversent minuit).
 */
function isInBand(minuteOfDay: number, band: ScheduleBand): boolean {
  if (band.startMin <= band.endMin) {
    // Bande normale (ex: 07:00-14:00)
    return minuteOfDay >= band.startMin && minuteOfDay < band.endMin;
  }
  // Bande traversant minuit (ex: 22:00-02:00)
  return minuteOfDay >= band.startMin || minuteOfDay < band.endMin;
}

/**
 * Calcule le nombre de minutes jusqu'à la prochaine bande active.
 * Prend en compte le jour (si dimanche OFF, saute au lundi).
 */
function minutesUntilNextBand(
  dayOfWeek: number,
  minuteOfDay: number,
  bands: ScheduleBand[],
  activeDays: Set<number>,
): number {
  if (bands.length === 0) return 60; // fallback 1h

  // Chercher la prochaine bande aujourd'hui
  const todayBands = bands
    .filter((b) => b.startMin > minuteOfDay)
    .sort((a, b) => a.startMin - b.startMin);

  if (todayBands.length > 0 && activeDays.has(dayOfWeek)) {
    return todayBands[0].startMin - minuteOfDay;
  }

  // Pas de bande plus tard aujourd'hui → chercher le prochain jour actif
  const earliestBandStart = Math.min(...bands.map((b) => b.startMin));
  let daysAhead = 1;
  for (let i = 1; i <= 7; i++) {
    const futureDay = ((dayOfWeek - 1 + i) % 7) + 1; // ISO 1-7
    if (activeDays.has(futureDay)) {
      daysAhead = i;
      break;
    }
  }

  // Minutes restantes aujourd'hui + jours complets + début de la première bande
  const minutesLeftToday = 1440 - minuteOfDay;
  const fullDaysMinutes = (daysAhead - 1) * 1440;
  return minutesLeftToday + fullDaysMinutes + earliestBandStart;
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Détermine si le scan CEV est autorisé maintenant et retourne l'intervalle adapté.
 *
 * Si le schedule est désactivé (cev_schedule_enabled != "1"), retourne allowed=true
 * avec l'intervalle par défaut (celui passé en paramètre).
 *
 * @param defaultIntervalMs Intervalle par défaut quand le schedule est désactivé.
 */
export async function getCevScheduleDecision(defaultIntervalMs: number): Promise<CevScheduleResult> {
  const config = await loadScheduleConfig();

  // Schedule désactivé → mode 24/7 comme avant
  if (!config.enabled) {
    return {
      allowed: true,
      intervalMs: defaultIntervalMs,
      sleepUntilNextWindowMs: 0,
      bandLabel: "24/7 (schedule off)",
    };
  }

  const { dayOfWeek, minuteOfDay } = getNowInTimezone(config.timezone);

  // Vérifier le jour
  if (!config.activeDays.has(dayOfWeek)) {
    const sleepMin = minutesUntilNextBand(dayOfWeek, minuteOfDay, config.bands, config.activeDays);
    return {
      allowed: false,
      intervalMs: 0,
      sleepUntilNextWindowMs: sleepMin * 60_000,
      bandLabel: `jour OFF (day=${dayOfWeek})`,
    };
  }

  // Vérifier les tranches horaires
  for (const band of config.bands) {
    if (isInBand(minuteOfDay, band)) {
      const hh = String(Math.floor(band.startMin / 60)).padStart(2, "0");
      const mm = String(band.startMin % 60).padStart(2, "0");
      const hh2 = String(Math.floor(band.endMin / 60)).padStart(2, "0");
      const mm2 = String(band.endMin % 60).padStart(2, "0");
      return {
        allowed: true,
        intervalMs: band.intervalSec * 1000,
        sleepUntilNextWindowMs: 0,
        bandLabel: `${hh}:${mm}-${hh2}:${mm2} (${band.intervalSec}s)`,
      };
    }
  }

  // Aucune tranche ne match → OFF
  const sleepMin = minutesUntilNextBand(dayOfWeek, minuteOfDay, config.bands, config.activeDays);
  return {
    allowed: false,
    intervalMs: 0,
    sleepUntilNextWindowMs: Math.min(sleepMin * 60_000, 5 * 60_000), // cap 5min (re-évalue fréquemment après redéploiement)
    bandLabel: `hors fenêtre (${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")} ${config.timezone})`,
  };
}

/**
 * Force l'invalidation du cache (utile après un changement de config Convex).
 */
export function invalidateCevScheduleCache(): void {
  _cache = null;
}
