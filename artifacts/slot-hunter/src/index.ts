import * as dotenv from "dotenv";
dotenv.config();

import { getActiveJobs, sendHeartbeat, type HunterJob } from "./convexClient.js";
import { runHunterSession, type SessionResult } from "./navigator.js";

// ─── Tier intervals : temps MINIMUM entre deux checks du MÊME dossier ──────
const URGENCY_INTERVAL: Record<string, { min: number; max: number }> = {
  tres_urgent:  { min:  8 * 60_000, max: 12 * 60_000 },
  urgent:       { min: 15 * 60_000, max: 20 * 60_000 },
  prioritaire:  { min: 25 * 60_000, max: 35 * 60_000 },
  standard:     { min: 45 * 60_000, max: 60 * 60_000 },
};

// ─── Silence Radio : IP cooldown entre deux incursions consécutives ─────────
const SILENCE_RADIO_MIN_MS = 3 * 60_000;
const SILENCE_RADIO_MAX_MS = 5 * 60_000;

// ─── Polling quand aucun job n'est dû ───────────────────────────────────────
const IDLE_POLL_MIN_MS = 60_000;
const IDLE_POLL_MAX_MS = 90_000;

const URGENCY_ORDER: Record<string, number> = {
  tres_urgent: 0,
  urgent: 1,
  prioritaire: 2,
  standard: 3,
};

const MAX_LOGIN_FAILURES = 3;

const consecutiveLoginFailures = new Map<string, number>();
const pausedJobs = new Set<string>();
const lastIntervalUsed = new Map<string, number>();

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

function getIntervalMs(urgencyTier: string): number {
  const cfg = URGENCY_INTERVAL[urgencyTier] ?? URGENCY_INTERVAL.standard;
  const last = lastIntervalUsed.get(urgencyTier);
  let interval = cfg.min + Math.random() * (cfg.max - cfg.min);

  if (last !== undefined) {
    let attempts = 0;
    while (Math.abs(interval - last) < 90_000 && attempts < 6) {
      interval = cfg.min + Math.random() * (cfg.max - cfg.min);
      attempts++;
    }
  }

  lastIntervalUsed.set(urgencyTier, interval);
  return Math.round(interval);
}

function getSilenceRadioMs(): number {
  return Math.round(SILENCE_RADIO_MIN_MS + Math.random() * (SILENCE_RADIO_MAX_MS - SILENCE_RADIO_MIN_MS));
}

function formatMs(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

function getNextCheckDue(job: HunterJob): number {
  const lastCheck = job.lastCheckAt ?? job.hunterConfig.lastCheckAt;
  if (!lastCheck) return 0;
  const cfg = URGENCY_INTERVAL[job.urgencyTier] ?? URGENCY_INTERVAL.standard;
  return lastCheck + getIntervalMs(job.urgencyTier);
}

function findNextDueJob(jobs: HunterJob[]): HunterJob | null {
  const now = Date.now();

  const due = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    getNextCheckDue(j) <= now,
  );

  if (due.length === 0) return null;

  due.sort((a, b) => {
    const tierDiff = (URGENCY_ORDER[a.urgencyTier] ?? 3) - (URGENCY_ORDER[b.urgencyTier] ?? 3);
    if (tierDiff !== 0) return tierDiff;
    return getNextCheckDue(a) - getNextCheckDue(b);
  });

  return due[0];
}

function getTimeUntilNextDue(jobs: HunterJob[]): number {
  const now = Date.now();

  const active = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl,
  );

  if (active.length === 0) return IDLE_POLL_MAX_MS;

  const minDue = Math.min(...active.map((j) => getNextCheckDue(j)));
  const waitMs = Math.max(minDue - now, 0);

  return Math.min(Math.max(waitMs, IDLE_POLL_MIN_MS), IDLE_POLL_MAX_MS);
}

function syncAdminResets(freshJobs: HunterJob[]): void {
  const freshJobIds = new Set(freshJobs.map((j) => j.id));

  for (const jobId of pausedJobs) {
    const freshJob = freshJobs.find((j) => j.id === jobId);
    if (freshJob && freshJob.hunterConfig.isActive) {
      log("INFO", `[${freshJob.applicantName}] Admin reset détecté — reprise`);
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

async function handleResult(job: HunterJob, result: SessionResult): Promise<void> {
  log("INFO", `[${job.applicantName}] Résultat: ${result}`);

  switch (result) {
    case "slot_found":
      consecutiveLoginFailures.delete(job.id);
      pausedJobs.add(job.id);
      log("INFO", `[${job.applicantName}] ✅ CRÉNEAU TROUVÉ — dossier retiré de la file`);
      break;

    case "login_failed": {
      const loginFails = (consecutiveLoginFailures.get(job.id) ?? 0) + 1;
      consecutiveLoginFailures.set(job.id, loginFails);
      log("WARN", `[${job.applicantName}] Échec login #${loginFails}/${MAX_LOGIN_FAILURES}`);

      if (loginFails >= MAX_LOGIN_FAILURES) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] ${MAX_LOGIN_FAILURES} échecs consécutifs — auto-pause`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${loginFails} login failures consécutives — vérifier les identifiants`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Heartbeat pause échoué: ${err}`);
        }
      }
      break;
    }

    case "error":
      log("WARN", `[${job.applicantName}] Erreur transitoire — prochain cycle prévu selon tier`);
      break;

    case "captcha":
      log("WARN", `[${job.applicantName}] Bloqué par CAPTCHA — prochain cycle prévu selon tier`);
      break;

    case "not_found":
      consecutiveLoginFailures.delete(job.id);
      log("INFO", `[${job.applicantName}] Aucun créneau disponible`);
      break;
  }
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const convexUrl = process.env.CONVEX_SITE_URL;
  const hunterKey = process.env.HUNTER_API_KEY;

  log("INFO", "=== Joventy Hunter démarrage (Joventy Shuffle v2) ===");
  log("INFO", `Mode: ${dryRun ? "DRY RUN" : "PRODUCTION"}`);
  log("INFO", `Convex: ${convexUrl ? "configuré" : "MANQUANT"}`);
  log("INFO", `Hunter API Key: ${hunterKey ? "configurée" : "MANQUANTE"}`);
  log("INFO", `Proxy: ${process.env.PROXY_URL ? "configuré" : "aucun"}`);
  log("INFO", "Intervalles tier — très_urgent:8-12m  urgent:15-20m  prioritaire:25-35m  standard:45-60m");
  log("INFO", `Silence radio inter-clients: ${formatMs(SILENCE_RADIO_MIN_MS)}–${formatMs(SILENCE_RADIO_MAX_MS)}`);
  log("INFO", `Auto-pause après: ${MAX_LOGIN_FAILURES} login_failed consécutifs`);

  if (!convexUrl || !hunterKey) {
    log("ERROR", "CONVEX_SITE_URL et HUNTER_API_KEY sont requis — arrêt");
    process.exit(1);
  }

  while (true) {
    let jobs: HunterJob[];
    try {
      jobs = await getActiveJobs();
    } catch (err) {
      log("ERROR", `Échec récupération jobs: ${err} — retry dans 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }

    syncAdminResets(jobs);

    const due = findNextDueJob(jobs);

    if (!due) {
      const waitMs = getTimeUntilNextDue(jobs);
      const activeCount = jobs.filter((j) => !pausedJobs.has(j.id) && j.hunterConfig?.isActive).length;

      if (activeCount === 0) {
        log("INFO", "Aucun dossier actif — polling dans 90s");
      } else {
        const tierCounts = jobs
          .filter((j) => !pausedJobs.has(j.id) && j.hunterConfig?.isActive)
          .reduce<Record<string, number>>((acc, j) => {
            acc[j.urgencyTier] = (acc[j.urgencyTier] ?? 0) + 1;
            return acc;
          }, {});
        const tierStr = Object.entries(tierCounts).map(([t, n]) => `${n}×${t}`).join(", ");
        log("INFO", `Aucun dossier dû (${tierStr}) — prochain check dans ${formatMs(waitMs)}`);
      }

      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const overdueMs = Date.now() - getNextCheckDue(due);
    const overdueStr = overdueMs > 0 ? ` (+${formatMs(overdueMs)} de retard)` : "";
    log("INFO", `▶ [${due.applicantName}] Check ${due.urgencyTier}${overdueStr}`);

    let result: SessionResult;
    try {
      result = await runHunterSession(due);
    } catch (err) {
      result = "error";
      log("ERROR", `[${due.applicantName}] Erreur session non capturée: ${err}`);
    }

    await handleResult(due, result);

    if (result !== "slot_found") {
      const silenceMs = getSilenceRadioMs();
      log("INFO", `📻 Silence radio ${formatMs(silenceMs)} (cooldown IP)...`);
      await new Promise((r) => setTimeout(r, silenceMs));
    }
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
