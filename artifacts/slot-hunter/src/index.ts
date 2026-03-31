import * as dotenv from "dotenv";
dotenv.config();

import { getActiveJobs, sendHeartbeat, type HunterJob } from "./convexClient.js";
import { runHunterSession, type SessionResult } from "./navigator.js";
import { randomDelay } from "./browser.js";

const MIN_INTERVAL_MS = 8 * 60 * 1000;
const MAX_INTERVAL_MS = 22 * 60 * 1000;
const INITIAL_DELAY_MIN_MS = 2000;
const INITIAL_DELAY_MAX_MS = 8000;
const MAX_CONSECUTIVE_FAILURES = 3;
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const URGENCY_INTERVAL: Record<string, { min: number; max: number }> = {
  tres_urgent: { min: 8 * 60 * 1000, max: 10 * 60 * 1000 },
  urgent: { min: 11 * 60 * 1000, max: 14 * 60 * 1000 },
  prioritaire: { min: 15 * 60 * 1000, max: 18 * 60 * 1000 },
  standard: { min: 19 * 60 * 1000, max: 22 * 60 * 1000 },
};

const consecutiveFailures = new Map<string, number>();
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
    log("INFO", `Skipping paused job: ${job.applicantName} (${job.id})`);
    return;
  }

  const initialDelay = INITIAL_DELAY_MIN_MS + Math.random() * (INITIAL_DELAY_MAX_MS - INITIAL_DELAY_MIN_MS);
  log("INFO", `[${job.applicantName}] Waiting ${Math.round(initialDelay)}ms before starting session...`);
  await new Promise((r) => setTimeout(r, initialDelay));

  log("INFO", `[${job.applicantName}] Starting hunt (${job.destination} / ${job.urgencyTier} / ${job.visaType})`);

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
      consecutiveFailures.delete(job.id);
      pausedJobs.add(job.id);
      log("INFO", `[${job.applicantName}] SLOT FOUND — removing from active queue`);
      break;

    case "login_failed":
    case "error": {
      const failures = (consecutiveFailures.get(job.id) ?? 0) + 1;
      consecutiveFailures.set(job.id, failures);
      log("WARN", `[${job.applicantName}] Failure #${failures}/${MAX_CONSECUTIVE_FAILURES}`);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] Max failures reached — pausing server-side via heartbeat`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${failures} login failures consécutives`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Failed to send pause heartbeat: ${err}`);
        }
      }
      break;
    }

    case "captcha":
      log("WARN", `[${job.applicantName}] Blocked by CAPTCHA — will retry next cycle`);
      break;

    case "not_found":
      consecutiveFailures.delete(job.id);
      break;
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

  const activeJobs = jobs.filter((j) => !pausedJobs.has(j.id));
  log("INFO", `${activeJobs.length} active jobs (${pausedJobs.size} paused)`);

  if (activeJobs.length === 0) {
    log("INFO", "No active jobs — sleeping until next poll");
    return;
  }

  for (const job of activeJobs) {
    await processJob(job);

    if (job !== activeJobs[activeJobs.length - 1]) {
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

  if (!convexUrl || !hunterKey) {
    log("ERROR", "CONVEX_SITE_URL and HUNTER_API_KEY are required — exiting");
    process.exit(1);
  }

  while (true) {
    try {
      await runCycle();
    } catch (err) {
      log("ERROR", `Cycle crashed (will retry): ${err}`);
    }

    const sleepMs = MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
    log("INFO", `Sleeping ${formatMs(sleepMs)} before next cycle...`);
    await new Promise((r) => setTimeout(r, sleepMs));

    try {
      const freshJobs = await getActiveJobs();
      for (const job of freshJobs) {
        if (pausedJobs.has(job.id) && job.hunterConfig.isActive) {
          const failures = consecutiveFailures.get(job.id) ?? 0;
          if (failures === 0) {
            log("INFO", `[${job.applicantName}] Re-activated by admin — removing from paused set`);
            pausedJobs.delete(job.id);
          }
        }
      }
    } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
