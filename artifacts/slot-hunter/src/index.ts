import * as dotenv from "dotenv";
dotenv.config();

import { getActiveJobs, sendHeartbeat, getPendingBotTest, type HunterJob, getActiveCevSessions, recordCevSessionCheck } from "./convexClient.js";
import { runHunterSession, runBotTestSession, type SessionResult } from "./navigator.js";
import { runCevCheck } from "./cevBooking.js";
import { pollCevSlot } from "./cevPolling.js";
import { USA_ENC_SEC_KEY } from "./usaPortal.js";
import { proxyPool } from "./browser.js";

// ─── CEV Sessions polling — boucle parallèle indépendante ───────────────────
// Tourne en background sans bloquer la boucle principale du bot Playwright.
// Pour chaque session active : check toutes les pollIntervalMs (défaut 30s).
// Coût : ~50ms par check, zéro captcha, zéro Playwright.
async function startCevPollingLoop(): Promise<void> {
  console.log("[CEV-POLL] Boucle de polling sessions CEV démarrée");
  while (true) {
    try {
      // L'API fait le claim atomique côté Convex : on ne reçoit QUE des sessions
      // dues qui sont maintenant lockées 30s pour empêcher un autre worker
      // (instance dupliquée, redémarrage) de les check en parallèle.
      const due = await getActiveCevSessions();

      if (due.length > 0) {
        console.log(`[CEV-POLL] ${due.length} session(s) claimée(s) à checker`);
      }

      // Check en parallèle (sessions indépendantes — chacune a son propre cookie)
      await Promise.all(due.map(async (s) => {
        const t0 = Date.now();
        const r = await pollCevSlot(s.integrationUrl, s.sessionCookie);
        const ms = Date.now() - t0;

        if (r.status === "slot_found") {
          console.log(`[CEV-POLL] 🚨 SLOT TROUVÉ session=${s.sessionId} (${ms}ms)`);
          await recordCevSessionCheck(s.sessionId, "slot_found");
        } else if (r.status === "session_expired") {
          console.log(`[CEV-POLL] ⏱️  Session expirée session=${s.sessionId} (${ms}ms)`);
          await recordCevSessionCheck(s.sessionId, "session_expired");
        } else if (r.status === "error") {
          console.log(`[CEV-POLL] ❌ Erreur session=${s.sessionId}: ${r.error} (${ms}ms)`);
          await recordCevSessionCheck(s.sessionId, "error", r.error);
        } else {
          // no_slot — log discret
          await recordCevSessionCheck(s.sessionId, "no_slot");
        }
      }));
    } catch (err) {
      console.warn("[CEV-POLL] Erreur boucle:", err);
    }

    // Polling fréquent (5s) — la condition "due" filtre selon pollIntervalMs de chaque session
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// ─── Auto-détection IP publique du serveur ───────────────────────────────────
async function detectServerIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json() as { ip: string };
    return data.ip ?? null;
  } catch {
    return null;
  }
}

// ─── Tier intervals : temps MINIMUM entre deux checks du MÊME dossier ──────
// tres_urgent : 3-5 min hors rush, 1-2 min pendant les rush hours.
// Safe car le token JWT USA est en cache 55 min → aucun re-login supplémentaire.
const URGENCY_INTERVAL: Record<string, { min: number; max: number }> = {
  tres_urgent:  { min:  3 * 60_000, max:  5 * 60_000 },
  urgent:       { min: 15 * 60_000, max: 20 * 60_000 },
  prioritaire:  { min: 25 * 60_000, max: 35 * 60_000 },
  standard:     { min: 45 * 60_000, max: 60 * 60_000 },
};

// ─── Rush Hours : fenêtres de sortie de créneaux — consulat USA Kinshasa ────
// Heure locale Kinshasa = UTC+1. Estimations basées sur les patterns observés :
//   00h00-02h00 → maintenance système / libération nocturne
//   07h00-09h00 → ouverture de journée
//   12h00-14h00 → pause déjeuner (annulations traitées)
// Pendant ces fenêtres, tres_urgent passe à 1-2 min (toujours safe, token en cache).
const RUSH_WINDOWS: { start: number; end: number }[] = [
  { start:  0, end:  2 },
  { start:  7, end:  9 },
  { start: 12, end: 14 },
];
const RUSH_INTERVAL_MIN_MS =      60_000; // 1 min
const RUSH_INTERVAL_MAX_MS =  2 * 60_000; // 2 min
const RUSH_SILENCE_MIN_MS   =      45_000; // 45 s
const RUSH_SILENCE_MAX_MS   =      90_000; // 90 s

// Kinshasa = UTC+1
function getKinshasaHour(): number {
  return (new Date().getUTCHours() + 1) % 24;
}

function isRushHour(): boolean {
  const h = getKinshasaHour();
  return RUSH_WINDOWS.some(({ start, end }) => h >= start && h < end);
}

// ─── Silence Radio : IP cooldown entre deux incursions consécutives ─────────
// Normal : 2-3 min. Rush hours : 45-90 s (session USA API ~2 min → cycle total ~3 min).
const SILENCE_RADIO_MIN_MS = 2 * 60_000;
const SILENCE_RADIO_MAX_MS = 3 * 60_000;

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
// Auto-pause après N erreurs transitoires consécutives (429/403/réseau) sur le même dossier.
// Évite d'harceler le portail en boucle si le compte est rate-limité ou bloqué.
const MAX_CONSECUTIVE_ERRORS = 5;

// ─── Vérification bundle portail USA (clé AES) ───────────────────────────────
// Une fois par jour : télécharge le bundle Angular du portail et vérifie que
// la clé AES hardcodée est toujours présente. Si elle a changé, pause tous les
// jobs USA et logue une alerte claire pour correction manuelle.
const BUNDLE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastBundleCheckAt = 0; // 0 = jamais vérifié → s'exécute au démarrage

const consecutiveLoginFailures = new Map<string, number>();
const consecutiveErrors = new Map<string, number>();
const pausedJobs = new Set<string>();

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

/**
 * Prochaine échéance planifiée par job, calculée une seule fois après chaque cycle.
 * Séparé de getIntervalMs pour éviter les effets de bord lors des appels multiples
 * à getNextCheckDue dans le même tour de boucle (filter + sort + getTimeUntilNextDue).
 */
const scheduledNextDue = new Map<string, number>();

/**
 * Génère un intervalle aléatoire pour un tier, en évitant de répéter
 * une valeur trop proche de la dernière utilisée pour ce tier.
 * Pour tres_urgent pendant une rush hour : utilise RUSH_INTERVAL (1-2 min).
 * À appeler UNE SEULE FOIS par cycle (dans handleResult), pas dans getNextCheckDue.
 */
const lastIntervalUsed = new Map<string, number>();
let lastRushState: boolean | null = null; // pour logger les transitions rush ↔ normal

function generateIntervalMs(urgencyTier: string): number {
  const rush = urgencyTier === "tres_urgent" && isRushHour();

  // Logger les transitions rush ↔ normal
  if (rush !== lastRushState) {
    lastRushState = rush;
    if (rush) {
      const h = getKinshasaHour();
      log("INFO", `⚡ RUSH HOUR activé (${h}h00 Kinshasa) — intervalle tres_urgent → 1-2 min`);
    } else {
      log("INFO", "📻 RUSH HOUR terminé — retour intervalle normal tres_urgent (3-5 min)");
    }
  }

  const cfg = rush
    ? { min: RUSH_INTERVAL_MIN_MS, max: RUSH_INTERVAL_MAX_MS }
    : (URGENCY_INTERVAL[urgencyTier] ?? URGENCY_INTERVAL.standard);

  const last = lastIntervalUsed.get(urgencyTier);
  // Anti-répétition : écart minimal 30s en rush, 90s en normal
  const minGap = rush ? 30_000 : 90_000;
  let interval = cfg.min + Math.random() * (cfg.max - cfg.min);

  if (last !== undefined) {
    let attempts = 0;
    while (Math.abs(interval - last) < minGap && attempts < 6) {
      interval = cfg.min + Math.random() * (cfg.max - cfg.min);
      attempts++;
    }
  }

  lastIntervalUsed.set(urgencyTier, interval);
  return Math.round(interval);
}

function getSilenceRadioMs(): number {
  if (isRushHour()) {
    return Math.round(RUSH_SILENCE_MIN_MS + Math.random() * (RUSH_SILENCE_MAX_MS - RUSH_SILENCE_MIN_MS));
  }
  return Math.round(SILENCE_RADIO_MIN_MS + Math.random() * (SILENCE_RADIO_MAX_MS - SILENCE_RADIO_MIN_MS));
}

function formatMs(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

/**
 * Retourne l'heure planifiée pour le prochain check du job.
 * Lit depuis scheduledNextDue (calculé une seule fois dans handleResult).
 * Si aucune valeur n'est encore planifiée (premier cycle), retourne 0 → dû immédiatement.
 */
function getNextCheckDue(job: HunterJob): number {
  const scheduled = scheduledNextDue.get(job.id);
  if (scheduled !== undefined) return scheduled;
  // Fallback : si Convex a un lastCheckAt, utiliser un intervalle minimum fixe
  const lastCheck = job.lastCheckAt ?? job.hunterConfig.lastCheckAt;
  if (!lastCheck) return 0;
  const cfg = URGENCY_INTERVAL[job.urgencyTier] ?? URGENCY_INTERVAL.standard;
  return lastCheck + cfg.min;
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
    if (!freshJobIds.has(jobId)) {
      // Job supprimé de Convex — nettoyer toutes les structures pour éviter une fuite mémoire.
      pausedJobs.delete(jobId);
      consecutiveLoginFailures.delete(jobId);
      consecutiveErrors.delete(jobId);
      scheduledNextDue.delete(jobId);
      continue;
    }
    const freshJob = freshJobs.find((j) => j.id === jobId);
    if (freshJob && freshJob.hunterConfig.isActive) {
      log("INFO", `[${freshJob.applicantName}] Admin reset détecté — reprise`);
      pausedJobs.delete(jobId);
      consecutiveLoginFailures.delete(jobId);
      consecutiveErrors.delete(jobId);
      scheduledNextDue.delete(jobId);  // forcer un check immédiat après reset admin
    }
  }

  for (const jobId of consecutiveLoginFailures.keys()) {
    if (!freshJobIds.has(jobId)) consecutiveLoginFailures.delete(jobId);
  }
  for (const jobId of consecutiveErrors.keys()) {
    if (!freshJobIds.has(jobId)) consecutiveErrors.delete(jobId);
  }
  for (const jobId of scheduledNextDue.keys()) {
    if (!freshJobIds.has(jobId)) scheduledNextDue.delete(jobId);
  }
}

async function handleResult(job: HunterJob, result: SessionResult): Promise<void> {
  log("INFO", `[${job.applicantName}] Résultat: ${result}`);

  switch (result) {
    case "slot_found":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      pausedJobs.add(job.id);
      log("INFO", `[${job.applicantName}] ✅ CRÉNEAU TROUVÉ — dossier retiré de la file`);
      return; // pas de reschedule : le job est terminé

    case "login_failed": {
      consecutiveErrors.delete(job.id);
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
        return; // pas de reschedule : le job est en pause
      }
      break;
    }

    case "error": {
      consecutiveLoginFailures.delete(job.id);
      const errCount = (consecutiveErrors.get(job.id) ?? 0) + 1;
      consecutiveErrors.set(job.id, errCount);
      log("WARN", `[${job.applicantName}] Erreur transitoire #${errCount}/${MAX_CONSECUTIVE_ERRORS} — prochain cycle selon tier`);

      // Auto-pause si le dossier génère trop d'erreurs consécutives (429/403/réseau)
      // pour éviter de harceler le portail en boucle sur un compte rate-limité
      if (errCount >= MAX_CONSECUTIVE_ERRORS) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] ${MAX_CONSECUTIVE_ERRORS} erreurs consécutives — auto-pause (compte potentiellement bloqué)`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${errCount} erreurs transitoires consécutives — vérifier statut portail`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Heartbeat pause échoué: ${err}`);
        }
        return; // pas de reschedule : le job est en pause
      }
      break;
    }

    case "captcha":
      log("WARN", `[${job.applicantName}] Bloqué par CAPTCHA — prochain cycle prévu selon tier`);
      break;

    case "payment_required":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      log("WARN", `[${job.applicantName}] 💳 Paiement portail requis — frais consulaires non validés par le portail`);
      break;

    case "not_found":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      log("INFO", `[${job.applicantName}] Aucun créneau disponible`);
      break;
  }

  // Planifier le prochain cycle : générer l'intervalle UNE SEULE FOIS ici,
  // stocké dans scheduledNextDue, lu de façon déterministe par getNextCheckDue.
  const intervalMs = generateIntervalMs(job.urgencyTier);
  const nextDue = Date.now() + intervalMs;
  scheduledNextDue.set(job.id, nextDue);
  log("INFO", `[${job.applicantName}] Prochain check dans ${formatMs(intervalMs)} (${new Date(nextDue).toLocaleTimeString("fr-CD")})`);
}

/**
 * Vérifie une fois par jour que la clé AES du portail USA n'a pas changé.
 * Si la clé est absente du bundle actuel : pause immédiate de tous les jobs USA
 * et alerte dans les logs — la correction reste manuelle (remplacer USA_ENC_SEC_KEY
 * dans usaPortal.ts puis rebuild + redéployer le container).
 */
async function checkPortalBundleKey(activeJobs: HunterJob[]): Promise<void> {
  const now = Date.now();
  if (now - lastBundleCheckAt < BUNDLE_CHECK_INTERVAL_MS) return;
  lastBundleCheckAt = now;

  log("INFO", "🔍 Vérification bundle portail USA (quotidienne)...");

  // UA aligné sur Chrome/135 — cohérent avec le reste du robot.
  // Chrome/120 était stale (2023) et pouvait être refusé par un WAF moderne.
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
  // IMPORTANT : lastBundleCheckAt est positionné ici (avant les appels réseau)
  // pour éviter que deux boucles parallèles lancent la vérification simultanément.
  // En cas d'erreur réseau transitoire, on retente dans BUNDLE_CHECK_RETRY_MS (30 min)
  // plutôt que 24h en repositionnant lastBundleCheckAt dans le catch.
  const BUNDLE_CHECK_RETRY_MS = 30 * 60 * 1000;

  try {
    // 1. Trouver le nom du bundle Angular actuel (hash content-based)
    const htmlRes = await fetch("https://www.usvisaappt.com/visaapplicantui/", {
      headers: { "User-Agent": UA, "Accept": "text/html" },
    });
    const html = await htmlRes.text();
    const match = html.match(/src="(main\.[a-f0-9]+\.js)"/);
    if (!match) {
      log("WARN", "🔍 Bundle check : impossible de trouver le nom du bundle — retry dans 30 min");
      lastBundleCheckAt = now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS;
      return;
    }
    const bundleName = match[1];

    // 2. Télécharger le bundle
    const bundleRes = await fetch(`https://www.usvisaappt.com/visaapplicantui/${bundleName}`, {
      headers: {
        "User-Agent": UA,
        "Referer": "https://www.usvisaappt.com/visaapplicantui/login",
      },
    });
    if (!bundleRes.ok) {
      log("WARN", `🔍 Bundle check : téléchargement échoué (HTTP ${bundleRes.status}) — retry dans 30 min`);
      lastBundleCheckAt = now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS;
      return;
    }
    const bundleText = await bundleRes.text();

    // 3. Vérifier si la clé actuelle est toujours présente
    if (bundleText.includes(USA_ENC_SEC_KEY)) {
      log("INFO", `🔍 Bundle check ✅ — clé AES inchangée (bundle: ${bundleName})`);
      return;
    }

    // 4. Clé absente → alerte + pause de tous les jobs USA actifs
    log("ERROR", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("ERROR", "🔴 ALERTE BUNDLE : la clé AES du portail USA a changé !");
    log("ERROR", `   Bundle actuel  : ${bundleName}`);
    log("ERROR", `   Clé en code    : ${USA_ENC_SEC_KEY}`);
    log("ERROR", "   ACTION REQUISE : exécuter check-portal-bundle.sh,");
    log("ERROR", "   mettre à jour USA_ENC_SEC_KEY dans usaPortal.ts,");
    log("ERROR", "   puis rebuild + redéployer le container Docker.");
    log("ERROR", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const usaJobs = activeJobs.filter((j) => j.destination === "usa");
    for (const job of usaJobs) {
      try {
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `⚠️ Clé AES du portail USA changée (bundle: ${bundleName}). Mise à jour manuelle requise. Robot mis en pause automatiquement.`,
          shouldPause: true,
        });
        log("WARN", `[${job.applicantName}] Mis en pause — clé AES périmée`);
      } catch (err) {
        log("WARN", `[${job.applicantName}] Erreur envoi pause heartbeat: ${err}`);
      }
    }
  } catch (err) {
    // Erreur réseau transitoire — retry dans 30 min (pas dans 24h)
    lastBundleCheckAt = now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS;
    log("WARN", `🔍 Bundle check : erreur réseau — retry dans 30 min (${err})`);
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

  // Lancer la boucle de polling CEV en background (indépendante de Playwright)
  startCevPollingLoop().catch((err) => {
    console.error("[CEV-POLL] Boucle crashée:", err);
  });

  // Détection IP serveur — utilisée automatiquement par le ProxyPool 2captcha
  const serverIp = await detectServerIp();
  if (serverIp) {
    proxyPool.setServerIp(serverIp);
    log("INFO", `IP serveur (Railway): ${serverIp}`);
    if (process.env.TWOCAPTCHA_API_KEY) {
      log("INFO", `Proxy 2captcha: TWOCAPTCHA_API_KEY ✅ — IP ${serverIp} doit être whitelistée sur 2captcha.com/proxy`);
    } else {
      log("WARN", `⚠️ TWOCAPTCHA_API_KEY absente de Railway — ajoutez-la dans les variables Railway pour activer le proxy résidentiel`);
    }
  } else {
    log("WARN", "IP serveur: indéterminée (ipify.org inaccessible)");
  }

  const proxyStatus = proxyPool.isConfigured
    ? `2captcha résidentiel rotatif ✅ (IP: ${serverIp})`
    : process.env.PROXY_URL
      ? "statique (PROXY_URL)"
      : "aucun ⚠️ — IP fixe Railway exposée";
  log("INFO", `Proxy: ${proxyStatus}`);
  log("INFO", "Intervalles tier — tres_urgent:3-5m (rush:1-2m)  urgent:15-20m  prioritaire:25-35m  standard:45-60m");
  log("INFO", `Silence radio: normal ${formatMs(SILENCE_RADIO_MIN_MS)}–${formatMs(SILENCE_RADIO_MAX_MS)} | rush ${formatMs(RUSH_SILENCE_MIN_MS)}–${formatMs(RUSH_SILENCE_MAX_MS)}`);
  log("INFO", `Rush windows Kinshasa (UTC+1): 00h-02h | 07h-09h | 12h-14h — actif maintenant: ${isRushHour() ? "OUI ⚡" : "non"}`);
  log("INFO", `Auto-pause après: ${MAX_LOGIN_FAILURES} login_failed consécutifs`);

  if (!convexUrl || !hunterKey) {
    log("ERROR", "CONVEX_SITE_URL et HUNTER_API_KEY sont requis — arrêt");
    process.exit(1);
  }

  while (true) {
    try {
      const pendingTest = await getPendingBotTest();
      if (pendingTest) {
        log("INFO", `🧪 Test bot détecté — ${pendingTest.destination} (${pendingTest.portalUrl})`);
        try {
          await runBotTestSession(pendingTest);
          log("INFO", `🧪 Test bot terminé — ${pendingTest.destination}`);
        } catch (err) {
          log("ERROR", `Erreur test bot ${pendingTest.destination}: ${err}`);
        }
        continue;
      }
    } catch (err) {
      log("WARN", `Vérification pending tests échouée (non critique): ${err}`);
    }

    let jobs: HunterJob[];
    try {
      jobs = await getActiveJobs();
    } catch (err) {
      log("ERROR", `Échec récupération jobs: ${err} — retry dans 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }

    syncAdminResets(jobs);

    // Vérification quotidienne du bundle portail USA (non bloquante)
    await checkPortalBundleKey(jobs);

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
      if (due.destination === "schengen") {
        const cevResult = await runCevCheck(due);
        // Mapper SchengenSessionResult → SessionResult
        result = cevResult === "slot_found" ? "slot_found"
               : cevResult === "error"      ? "error"
               : "not_found"; // 'not_found' et 'rate_limited' → pas de créneau, on reschedule normalement
      } else {
        result = await runHunterSession(due);
      }
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
