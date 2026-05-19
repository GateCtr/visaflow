// ─── Scheduler Utility Functions ────────────────────────────────────────────
// Extracted from index.ts — pure functions for interval generation, stagger,
// scheduling, and time formatting.

import type { HunterJob } from "./convexClient.js";
import {
  pausedJobs,
  completedJobs,
  scheduledNextDue,
  staggerOffsets,
  radioSilenceUntil,
  isInRadioSilence,
} from "./scheduler-state.js";

// ─── Mode flags (read from env at module load) ──────────────────────────────
export const isParallelMode = process.env.PARALLEL_WATCHER_MODE === "1" || process.env.PARALLEL_WATCHER_MODE === "true";

// V3 mode flag — mis à jour au démarrage via bot-config Convex
export let isV3Mode = false;
export function setIsV3Mode(val: boolean): void {
  isV3Mode = val;
}

// ─── Tier intervals : temps MINIMUM entre deux checks du MÊME dossier ──────
export const URGENCY_INTERVAL: Record<string, { min: number; max: number }> = {
  tres_urgent:  { min:  5 * 60_000, max: 10 * 60_000 },
  urgent:       { min: 15 * 60_000, max: 20 * 60_000 },
  prioritaire:  { min: 25 * 60_000, max: 35 * 60_000 },
  standard:     { min: 45 * 60_000, max: 60 * 60_000 },
};

// ─── Rush Hours : fenêtres de sortie de créneaux — consulat USA Kinshasa ────
export const RUSH_WINDOWS: { start: number; end: number }[] = [
  { start:  0, end:  2 },
  { start:  7, end:  9 },
  { start: 12, end: 14 },
];
export const RUSH_INTERVAL_MIN_MS =  5 * 60_000;
export const RUSH_INTERVAL_MAX_MS =  7 * 60_000;
export const RUSH_SILENCE_MIN_MS   =      45_000;
export const RUSH_SILENCE_MAX_MS   =      90_000;

// Kinshasa = UTC+1
export function getKinshasaHour(): number {
  return (new Date().getUTCHours() + 1) % 24;
}

export function isRushHour(): boolean {
  const h = getKinshasaHour();
  return RUSH_WINDOWS.some(({ start, end }) => h >= start && h < end);
}

// ─── Silence Radio constants ────────────────────────────────────────────────
export const SILENCE_RADIO_MIN_MS = 2 * 60_000;
export const SILENCE_RADIO_MAX_MS = 3 * 60_000;
export const SILENCE_RADIO_SAME_TIER_MIN_MS = 30_000;
export const SILENCE_RADIO_SAME_TIER_MAX_MS = 60_000;

// ─── Polling quand aucun job n'est dû ───────────────────────────────────────
export const IDLE_POLL_MIN_MS = 30_000;
export const IDLE_POLL_MAX_MS = 45_000;

export const URGENCY_ORDER: Record<string, number> = {
  tres_urgent: 0,
  urgent: 1,
  prioritaire: 2,
  standard: 3,
};

export const MAX_LOGIN_FAILURES = 3;
export const MAX_CONSECUTIVE_ERRORS = 5;

// ─── Distribution gaussienne pour les intervalles (anti-pattern bot) ─────────
export function gaussianRandom(mean: number, stddev: number, minClamp: number, maxClamp: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = mean + z * stddev;
  return Math.max(minClamp, Math.min(raw, maxClamp));
}

// ─── Skip intelligent : simuler un humain distrait (HORS rush uniquement) ───
export function shouldSkipCycle(urgencyTier: string): boolean {
  if (isRushHour()) return false;
  if (urgencyTier === "tres_urgent") return Math.random() < 0.05;
  if (urgencyTier === "urgent") return Math.random() < 0.07;
  return Math.random() < 0.10;
}

const lastIntervalUsed = new Map<string, number>();
let lastRushState: boolean | null = null;

export function generateIntervalMs(urgencyTier: string): number {
  const rush = urgencyTier === "tres_urgent" && isRushHour();

  if (rush !== lastRushState) {
    lastRushState = rush;
    if (rush) {
      const h = getKinshasaHour();
      log("INFO", `⚡ RUSH HOUR activé (${h}h00 Kinshasa) — intervalle tres_urgent → 3-4 min`);
    } else {
      log("INFO", "📻 RUSH HOUR terminé — retour intervalle normal tres_urgent (5-10 min)");
    }
  }

  const cfg = rush
    ? { min: RUSH_INTERVAL_MIN_MS, max: RUSH_INTERVAL_MAX_MS }
    : (URGENCY_INTERVAL[urgencyTier] ?? URGENCY_INTERVAL.standard);

  const last = lastIntervalUsed.get(urgencyTier);
  const minGap = rush ? 30_000 : 90_000;

  const center = (cfg.min + cfg.max) / 2;
  const stddev = (cfg.max - cfg.min) * 0.25;
  let interval = gaussianRandom(center, stddev, cfg.min, cfg.max);

  if (last !== undefined) {
    let attempts = 0;
    while (Math.abs(interval - last) < minGap && attempts < 6) {
      interval = gaussianRandom(center, stddev, cfg.min, cfg.max);
      attempts++;
    }
  }

  lastIntervalUsed.set(urgencyTier, interval);
  return Math.round(interval);
}

export function formatMs(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

// ─── Stagger : répartition uniforme des dossiers dans l'intervalle du tier ──
export function staggerInitialSchedules(jobs: HunterJob[]): void {
  const activeJobs = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    !completedJobs.has(j.id),
  );

  const byTier = new Map<string, HunterJob[]>();
  for (const job of activeJobs) {
    const tier = job.urgencyTier ?? "standard";
    const group = byTier.get(tier) ?? [];
    group.push(job);
    byTier.set(tier, group);
  }

  const now = Date.now();

  for (const [tier, tierJobs] of byTier.entries()) {
    if (tierJobs.length <= 1) continue;

    tierJobs.sort((a, b) => a.id.localeCompare(b.id));

    const rush = tier === "tres_urgent" && isRushHour();
    const cfg = rush
      ? { min: RUSH_INTERVAL_MIN_MS, max: RUSH_INTERVAL_MAX_MS }
      : (URGENCY_INTERVAL[tier] ?? URGENCY_INTERVAL.standard);
    const avgInterval = (cfg.min + cfg.max) / 2;

    const staggerStep = Math.round(avgInterval / tierJobs.length);

    for (let i = 0; i < tierJobs.length; i++) {
      const job = tierJobs[i];
      const baseOffset = i * staggerStep;
      const jitter = (Math.random() * 0.5 - 0.25) * staggerStep;
      const offset = Math.max(0, Math.round(baseOffset + jitter));
      staggerOffsets.set(job.id, offset);

      if (!scheduledNextDue.has(job.id)) {
        const due = now + offset;
        scheduledNextDue.set(job.id, due);
      }
    }

    log("INFO", `📐 Stagger ${tier}: ${tierJobs.length} dossiers décalés de ${formatMs(staggerStep)} (intervalle ${formatMs(avgInterval)})`);
    for (let i = 0; i < tierJobs.length; i++) {
      const job = tierJobs[i];
      const offset = staggerOffsets.get(job.id) ?? 0;
      log("INFO", `   └─ [${job.applicantName}] offset +${formatMs(offset)}`);
    }
  }
}

export function getNextCheckDue(job: HunterJob): number {
  const scheduled = scheduledNextDue.get(job.id);
  if (scheduled !== undefined) return scheduled;
  const lastCheck = job.lastCheckAt ?? job.hunterConfig.lastCheckAt;
  if (!lastCheck) return 0;
  const cfg = URGENCY_INTERVAL[job.urgencyTier] ?? URGENCY_INTERVAL.standard;
  return lastCheck + cfg.min;
}

export function findNextDueJob(jobs: HunterJob[]): HunterJob | null {
  const now = Date.now();

  const due = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    !isInRadioSilence(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    getNextCheckDue(j) <= now &&
    !((isParallelMode || isV3Mode) && (j.destination === "usa" || (!j.destination || j.destination === ""))),
  );

  if (due.length === 0) return null;

  due.sort((a, b) => {
    const tierDiff = (URGENCY_ORDER[a.urgencyTier] ?? 3) - (URGENCY_ORDER[b.urgencyTier] ?? 3);
    if (tierDiff !== 0) return tierDiff;
    return getNextCheckDue(a) - getNextCheckDue(b);
  });

  return due[0];
}

export function findNextDueJobSoon(jobs: HunterJob[], currentTier: string): HunterJob | null {
  const now = Date.now();
  const soonThreshold = now + 4 * 60_000;

  const candidates = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    !completedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    j.urgencyTier === currentTier &&
    getNextCheckDue(j) <= soonThreshold &&
    getNextCheckDue(j) > now,
  );

  return candidates.length > 0 ? candidates[0] : null;
}

export function getTimeUntilNextDue(jobs: HunterJob[]): number {
  const now = Date.now();

  const active = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    !((isParallelMode || isV3Mode) && (j.destination === "usa" || (!j.destination || j.destination === ""))),
  );

  if (active.length === 0) return IDLE_POLL_MAX_MS;

  const minDue = Math.min(...active.map((j) => getNextCheckDue(j)));
  const waitMs = Math.max(minDue - now, 0);

  return Math.min(Math.max(waitMs, IDLE_POLL_MIN_MS), IDLE_POLL_MAX_MS);
}

/**
 * FIX 3 : Coordination inter-dossiers.
 */
export function coordinateSiblings(currentJob: HunterJob): void {
  const now = Date.now();
  const tier = currentJob.urgencyTier;
  const COVERAGE_GAP_THRESHOLD_MS = 5 * 60_000;
  const ADVANCE_MIN_MS = 3 * 60_000;
  const ADVANCE_MAX_MS = 5 * 60_000;

  const siblings: { jobId: string; name: string; due: number }[] = [];
  for (const [jobId, due] of scheduledNextDue.entries()) {
    if (jobId === currentJob.id) continue;
    if (pausedJobs.has(jobId)) continue;
    if (completedJobs.has(jobId)) continue;
    if (isInRadioSilence(jobId)) continue;
    siblings.push({ jobId, name: jobId.slice(-6), due });
  }

  if (siblings.length === 0) return;

  const coverageEnd = now + COVERAGE_GAP_THRESHOLD_MS;
  const siblingCovering = siblings.find(s => s.due >= now && s.due <= coverageEnd);

  if (siblingCovering) {
    return;
  }

  const sortedSiblings = siblings
    .filter(s => s.due > coverageEnd)
    .sort((a, b) => a.due - b.due);

  if (sortedSiblings.length === 0) return;

  const target = sortedSiblings[0];
  const advanceMs = ADVANCE_MIN_MS + Math.random() * (ADVANCE_MAX_MS - ADVANCE_MIN_MS);
  const newDue = now + Math.round(advanceMs);

  if (target.due - newDue < 2 * 60_000) return;

  scheduledNextDue.set(target.jobId, newDue);
  log("INFO", `[coordination] ${currentJob.applicantName} dort → frère [${target.name}] avancé à +${formatMs(Math.round(advanceMs))} (était dans ${formatMs(target.due - now)})`);
}

// ─── Shared log function ────────────────────────────────────────────────────
export function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}
