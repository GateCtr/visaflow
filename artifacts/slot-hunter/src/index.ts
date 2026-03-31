import * as dotenv from "dotenv";
dotenv.config();

import { getActiveJobs, sendHeartbeat, type HunterJob } from "./convexClient.js";
import { runHunterSession, type SessionResult } from "./navigator.js";

const MIN_INTERVAL_MS = 8 * 60 * 1000;
const MAX_INTERVAL_MS = 22 * 60 * 1000;
const INITIAL_DELAY_MIN_MS = 2000;
const INITIAL_DELAY_MAX_MS = 8000;
const MAX_LOGIN_FAILURES = 3;

const URGENCY_INTERVAL: Record<string, { min: number; max: number }> = {
  tres_urgent: { min: 8 * 60 * 1000, max: 10 * 60 * 1000 },
  urgent: { min: 11 * 60 * 1000, max: 14 * 60 * 1000 },
  prioritaire: { min: 15 * 60 * 1000, max: 18 * 60 * 1000 },
  standard: { min: 19 * 60 * 1000, max: 22 * 60 * 1000 },
};

const consecutiveLoginFailures = new Map<string, number>();
const lastIntervals = new Map<string, number>();
const pausedJobs = new Set<string>();

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

function randomInterval(urgencyTier: string): number {
  const cfg = URGENCY_INTERVAL[urgencyTier] ?? URGENCY_INTERVAL.standard;
  let interval = cfg.min + Math.random() * (cfg.max - cfg.min);

  const last = lastIntervals.get(urgencyTier);
  if (last) {
    let attempts = 0;
    while (Math.abs(interval - last) < 60_000 && attempts < 5) {
      interval = cfg.min + Math.random() * (cfg.max - cfg.min);
      attempts++;
    }
  }

  lastIntervals.set(urgencyTier, interval);
  return Math.round(interval);
}

function formatMs(ms: number): string {
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m${sec}s`;
}

async function processJob(job: HunterJob): Promise<void> {
  if (pausedJobs.has(job.id)) {
    log("INFO", `Skipping paused job: ${job.applicantName}`);
    return;
  }

  if (!job.portalUrl) {
    log("WARN", `[${job.applicantName}] No portalUrl configured — skipping (set hunterConfig.portalUrl in admin)`);
    try {
      await sendHeartbeat({
        applicationId: job.id,
        result: "error",
        errorMessage: "Aucun portalUrl configuré pour ce dossier — skippé par le hunter",
      });
    } catch { /* ignore */ }
    return;
  }

  const initialDelay = INITIAL_DELAY_MIN_MS + Math.random() * (INITIAL_DELAY_MAX_MS - INITIAL_DELAY_MIN_MS);
  log("INFO", `[${job.applicantName}] Waiting ${Math.round(initialDelay)}ms before session...`);
  await new Promise((r) => setTimeout(r, initialDelay));

  log("INFO", `[${job.applicantName}] Hunt start (${job.destination} / ${job.urgencyTier})`);

  let result: SessionResult;
  try {
    result = await runHunterSession(job);
  } catch (err) {
    result = "error";
    log("ERROR", `[${job.applicantName}] Uncaught error: ${err}`);
  }

  log("INFO", `[${job.applicantName}] Result: ${result}`);

  switch (result) {
    case "slot_found":
      consecutiveLoginFailures.delete(job.id);
      pausedJobs.add(job.id);
      log("INFO", `[${job.applicantName}] SLOT FOUND — removed from queue`);
      break;

    case "login_failed": {
      const loginFails = (consecutiveLoginFailures.get(job.id) ?? 0) + 1;
      consecutiveLoginFailures.set(job.id, loginFails);
      log("WARN", `[${job.applicantName}] Login failure #${loginFails}/${MAX_LOGIN_FAILURES}`);

      if (loginFails >= MAX_LOGIN_FAILURES) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] ${MAX_LOGIN_FAILURES} consecutive login failures — pausing server-side`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${loginFails} login failures consécutives — vérifier les identifiants`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Failed to send pause heartbeat: ${err}`);
        }
      }
      break;
    }

    case "error":
      log("WARN", `[${job.applicantName}] Transient error (timeout/network/parsing) — will retry next cycle`);
      break;

    case "captcha":
      log("WARN", `[${job.applicantName}] Blocked by CAPTCHA — will retry next cycle`);
      break;

    case "not_found":
      consecutiveLoginFailures.delete(job.id);
      log("INFO", `[${job.applicantName}] No slot found this cycle`);
      break;
  }
}

function syncAdminResets(freshJobs: HunterJob[]): void {
  const freshJobIds = new Set(freshJobs.map((j) => j.id));

  for (const jobId of pausedJobs) {
    const freshJob = freshJobs.find((j) => j.id === jobId);
    if (freshJob && freshJob.hunterConfig.isActive) {
      log("INFO", `[${freshJob.applicantName}] Admin reset detected — resuming (clearing login failure count)`);
      pausedJobs.delete(jobId);
      consecutiveLoginFailures.delete(jobId);
    }
  }

  for (const jobId of consecutiveLoginFailures.keys()) {
    if (!freshJobIds.has(jobId)) {
      consecutiveLoginFailures.delete(jobId);
    }
  }
}

async function runCycle(): Promise<void> {
  log("INFO", "=== Starting hunt cycle ===");

  let jobs: HunterJob[];
  try {
    jobs = await getActiveJobs();
  } catch (err) {
    log("ERROR", `Failed to fetch jobs: ${err}`);
    return;
  }

  syncAdminResets(jobs);

  const activeJobs = jobs.filter((j) => !pausedJobs.has(j.id));
  log("INFO", `${activeJobs.length} active jobs (${pausedJobs.size} paused locally)`);

  if (activeJobs.length === 0) {
    log("INFO", "No active jobs — sleeping until next poll");
    return;
  }

  for (let i = 0; i < activeJobs.length; i++) {
    const job = activeJobs[i];
    await processJob(job);

    if (i < activeJobs.length - 1) {
      const interval = randomInterval(job.urgencyTier);
      log("INFO", `Waiting ${formatMs(interval)} before next job...`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  log("INFO", "=== Hunt cycle complete ===");
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const convexUrl = process.env.CONVEX_SITE_URL;
  const hunterKey = process.env.HUNTER_API_KEY;

  log("INFO", "=== Joventy Hunter starting ===");
  log("INFO", `Mode: ${dryRun ? "DRY RUN" : "PRODUCTION"}`);
  log("INFO", `Convex: ${convexUrl ? "configured" : "MISSING"}`);
  log("INFO", `Hunter API Key: ${hunterKey ? "configured" : "MISSING"}`);
  log("INFO", `Proxy: ${process.env.PROXY_URL ? "configured" : "none"}`);
  log("INFO", `Interval range: ${formatMs(MIN_INTERVAL_MS)}–${formatMs(MAX_INTERVAL_MS)} (varies by urgency)`);
  log("INFO", `Pause after: ${MAX_LOGIN_FAILURES} consecutive login_failed results (transient errors don't count)`);

  if (!convexUrl || !hunterKey) {
    log("ERROR", "CONVEX_SITE_URL and HUNTER_API_KEY are required — exiting");
    process.exit(1);
  }

  while (true) {
    try {
      await runCycle();
    } catch (err) {
      log("ERROR", `Cycle crashed (will retry in 30s): ${err}`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
