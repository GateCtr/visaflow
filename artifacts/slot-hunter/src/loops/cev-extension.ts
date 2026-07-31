/**
 * CEV Extension Loop — Auto-discovery + Round-robin + Anti-shadow-ban
 *
 * Différences vs cev-dossier-loop.ts (One-Shot Predator) :
 *   ① Si aucun pool de dossiers configuré → découverte automatique de TOUS les
 *      dossiers disponibles dans MyList (via resolveAllAppIdsFromMyList).
 *   ② Round-robin pur après chaque scan : chaque dossier est scanné une fois
 *      avant que le premier dossier soit re-scanné.
 *   ③ Pause 1 min base + jitter log-normal + "paresse humaine" aléatoire
 *      (pause longue 2-5 min simulant l'utilisateur qui se lève, 12% du temps).
 *   ④ Anti-shadow-ban par dossier : suivi des erreurs consécutives, cooldown
 *      progressif (30 min → 60 min → 2 h), invalidation de session.
 *   ⑤ Headers parfaitement alignés sur les captures Burp Chrome 146 (2026-06-26)
 *      via cevHttpSetup.ts (aucun header custom ici).
 *
 * Config Convex (bot-config) :
 *   cev_extension_mode = "1"             → activer ce loop
 *   cev_extension_pause_sec  = "60"      → pause base entre scans (défaut : 60 s)
 *   cev_extension_lazy_prob  = "0.12"    → probabilité de pause longue (défaut : 12 %)
 *   cev_extension_lazy_min   = "120"     → pause lazy min en secondes (défaut : 120 s)
 *   cev_extension_lazy_max   = "300"     → pause lazy max en secondes (défaut : 300 s)
 *
 * Variables d'environnement :
 *   VOWINT_EMAIL / VOWINT_PASSWORD    → credentials globaux (fallback si non fournis
 *                                        via hunterConfig.embassyUsername/Password)
 *   SOAX_PROXY_URL / IPROYAL_PROXY_URL → proxy résidentiel optionnel
 */

import {
  setupCevSessionHttp,
  resolveAllAppIdsFromMyList,
  invalidateVowintCache,
  invalidateAnticaptchaCache,
} from "../cevHttpSetup.js";
import { pollCevSlot } from "../cevPolling.js";
import { bookCevViaHttp } from "../cevHttpBooking.js";
import {
  makeCevProxyStickyUrl,
  initCevProxyGuardWithExitIp,
  resetCevImpitInstances,
  shouldUseProxy,
} from "../cev-shared-impit.js";
import {
  getActiveJobs,
  getBotConfigValue,
  botLog,
  reportSlotFound,
} from "../convexClient.js";
import { createLogger } from "../logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExtDossier {
  appId: string;
  index: number;
  label: string;
}

type ScanStatus =
  | "no_slot"
  | "no_slot_poll"
  | "slot_found"
  | "rate_limited"
  | "error";

interface ScanResult {
  status: ScanStatus;
  sessionCookie?: string;
  integrationUrl?: string;
}

// ─── Per-dossier shadow-ban tracker ──────────────────────────────────────────

interface DossierHealth {
  consecutiveErrors: number;
  consecutiveRateLimits: number;
  cooldownUntil: number;
  totalScans: number;
  totalSlots: number;
}

const dossierHealth = new Map<string, DossierHealth>();

function getHealth(appId: string): DossierHealth {
  if (!dossierHealth.has(appId)) {
    dossierHealth.set(appId, {
      consecutiveErrors: 0,
      consecutiveRateLimits: 0,
      cooldownUntil: 0,
      totalScans: 0,
      totalSlots: 0,
    });
  }
  return dossierHealth.get(appId)!;
}

/** Signale un succès — réinitialise les compteurs d'erreur */
function markSuccess(appId: string): void {
  const h = getHealth(appId);
  h.consecutiveErrors = 0;
  h.consecutiveRateLimits = 0;
}

/** Signale une erreur réseau / setup — applique cooldown progressif */
function markError(appId: string, logger: ReturnType<typeof createLogger>): void {
  const h = getHealth(appId);
  h.consecutiveErrors++;
  h.consecutiveRateLimits = 0;

  // Cooldown progressif : 30 min → 60 min → 2 h → 2 h …
  const cooldowns = [30, 60, 120, 120]; // minutes
  const level = Math.min(h.consecutiveErrors - 1, cooldowns.length - 1);
  const cooldownMs = cooldowns[level] * 60_000;

  if (h.consecutiveErrors >= 2) {
    h.cooldownUntil = Date.now() + cooldownMs;
    logger.warn(
      `⚠️ [anti-shadow-ban] Dossier ${appId.slice(0, 8)}… : ` +
      `${h.consecutiveErrors} erreurs consécutives → cooldown ${cooldowns[level]} min`
    );
  }
}

/** Signale un rate-limit — cooldown exponentiel */
function markRateLimit(appId: string, vowintEmail: string, logger: ReturnType<typeof createLogger>): void {
  const h = getHealth(appId);
  h.consecutiveErrors = 0;
  h.consecutiveRateLimits++;

  const base = 10 * 60_000; // 10 min
  const cooldownMs = Math.min(base * Math.pow(2, h.consecutiveRateLimits - 1), 60 * 60_000); // max 60 min
  h.cooldownUntil = Date.now() + cooldownMs;

  invalidateVowintCache(vowintEmail);
  logger.warn(
    `⚡ [anti-shadow-ban] Rate-limit #${h.consecutiveRateLimits} sur ${appId.slice(0, 8)}… ` +
    `→ invalidation session + cooldown ${Math.round(cooldownMs / 60_000)} min`
  );
}

/** Vérifie si le dossier est en cooldown */
function isCooledDown(appId: string): boolean {
  return Date.now() < (dossierHealth.get(appId)?.cooldownUntil ?? 0);
}

// ─── Jitter humain ────────────────────────────────────────────────────────────

/**
 * Distribution log-normale centrée sur muMs.
 * Box-Muller — évite l'uniforme mécanique de Math.random() * N.
 */
function logNormal(muMs: number, sigmaFrac = 0.35): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
  const sigma = Math.log(1 + sigmaFrac * sigmaFrac);
  const mu = Math.log(muMs) - sigma / 2;
  return Math.max(50, Math.exp(mu + Math.sqrt(sigma) * z));
}

/**
 * Calcule la pause post-scan avec jitter + paresse humaine.
 *
 * Comportement cible :
 *   - 88 % du temps : pause ~1 min ±15 s (log-normale)
 *   - 12 % du temps : pause 2-5 min supplémentaires (l'opérateur fait une pause café)
 *   - Minimum absolu : 60 s (jamais de rafale)
 */
function computeHumanPause(
  baseSec: number,
  lazyProb: number,
  lazyMinSec: number,
  lazyMaxSec: number,
): number {
  const base = baseSec * 1000;
  const jitter = logNormal(15_000, 0.45) * (Math.random() < 0.5 ? 1 : -1);
  const lazy = Math.random() < lazyProb
    ? (lazyMinSec + Math.random() * (lazyMaxSec - lazyMinSec)) * 1000
    : 0;
  return Math.max(60_000, base + jitter + lazy);
}

// ─── Scan d'un dossier ────────────────────────────────────────────────────────

async function scanDossier(
  vowintEmail: string,
  vowintPassword: string,
  dossier: ExtDossier,
  applicationId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<ScanResult> {
  const result = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    applicationId,
    applicationId,
    dossier.appId,
  );

  if (!result.success) {
    if (result.error?.includes("RATE_LIMIT")) return { status: "rate_limited" };

    const isCaptchaErr =
      result.error === "HCAPTCHA_FAILED" ||
      result.error?.includes("CAPTCHA");

    if (isCaptchaErr) {
      logger.warn(`  ⟳ ${result.error} — retry unique avec clé fraîche dans 6 s…`);
      invalidateAnticaptchaCache();
      await sleep(6_000);
      const retry = await setupCevSessionHttp(
        vowintEmail, vowintPassword, applicationId, applicationId, dossier.appId,
      );
      if (!retry.success) {
        return { status: "error" };
      }
      if (retry.slotsAvailable) {
        return { status: "slot_found", sessionCookie: retry.sessionCookie, integrationUrl: retry.integrationUrl };
      }
      if (retry.sessionCookie) {
        const pr = await pollCevSlot(retry.integrationUrl ?? "", retry.sessionCookie);
        if (pr.status === "slot_found") {
          return { status: "slot_found", sessionCookie: retry.sessionCookie, integrationUrl: retry.integrationUrl };
        }
      }
      return { status: "no_slot" };
    }

    return { status: "error" };
  }

  if (result.slotsAvailable) {
    return { status: "slot_found", sessionCookie: result.sessionCookie, integrationUrl: result.integrationUrl };
  }

  if (result.sessionCookie) {
    const pr = await pollCevSlot(result.integrationUrl ?? "", result.sessionCookie);
    if (pr.status === "slot_found") {
      return { status: "slot_found", sessionCookie: result.sessionCookie, integrationUrl: result.integrationUrl };
    }
  }

  return { status: "no_slot" };
}

// ─── Booking ─────────────────────────────────────────────────────────────────

const pausedDossiers = new Set<string>();

async function handleSlotFound(
  vowintEmail: string,
  vowintPassword: string,
  dossier: ExtDossier,
  applicationId: string,
  sessionCookie?: string,
  integrationUrl?: string,
  logger?: ReturnType<typeof createLogger>,
): Promise<void> {
  const log = logger ?? createLogger("CEV-EXT");
  pausedDossiers.add(dossier.appId);
  log.info(`🚨 SLOT TROUVÉ — dossier ${dossier.label} | appId=${dossier.appId.slice(0, 8)}…`);

  try {
    const httpBook = await bookCevViaHttp(
      integrationUrl ?? "",
      sessionCookie ?? "",
      applicationId,
    );
    if (httpBook.success) {
      log.info(`  ✅ BOOKING HTTP: date=${httpBook.bookedDate} time=${httpBook.bookedTime} code=${httpBook.confirmationCode}`);
      await reportSlotFound({
        applicationId,
        date: httpBook.bookedDate ?? "",
        time: httpBook.bookedTime ?? "",
        location: `CEV Belgique (${dossier.label})`,
        confirmationCode: httpBook.confirmationCode,
        screenshotStorageId: httpBook.screenshotStorageId,
      });
      return;
    }
    log.warn(`  Booking HTTP échoué (${httpBook.error}) — slot enregistré sans booking`);
    await reportSlotFound({
      applicationId,
      date: "",
      time: "",
      location: `CEV Belgique (${dossier.label})`,
      confirmationCode: undefined,
    });
  } catch (err) {
    log.error(`  💥 Crash booking: ${err}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function parseCfg(v: string | undefined, defaultVal: number): number {
  const n = parseFloat(v ?? "");
  return isFinite(n) && n > 0 ? n : defaultVal;
}

// ─── Découverte automatique des dossiers ──────────────────────────────────────

/**
 * Tente de résoudre TOUS les dossiers pour ce compte.
 * Stratégie :
 *   1. Si hunterConfig.cevDossierPool → parse la liste CSV
 *   2. Sinon → login VOWINT minimal puis resolveAllAppIdsFromMyList
 * Retourne un tableau de ExtDossier prêts à être scannés.
 */
async function discoverDossiers(
  vowintEmail: string,
  vowintPassword: string,
  applicationId: string,
  hunterConfig: Record<string, unknown>,
  logger: ReturnType<typeof createLogger>,
): Promise<ExtDossier[]> {
  const poolStr = hunterConfig.cevDossierPool as string | undefined;
  if (poolStr) {
    const refs = poolStr.split(",").map(s => s.trim()).filter(Boolean);
    logger.info(`Pool configuré : ${refs.length} dossier(s) → ${refs.join(", ")}`);
    return refs.map((r, i) => ({ appId: r, index: i, label: r }));
  }

  logger.info("Aucun pool configuré → auto-découverte MyList…");

  const authRes = await setupCevSessionHttp(
    vowintEmail, vowintPassword, applicationId, applicationId,
  );
  if (!authRes.success || !authRes.sessionCookie) {
    logger.warn(`Auto-découverte : login échoué (${authRes.error})`);
    return [];
  }

  const appIds = await resolveAllAppIdsFromMyList(authRes.sessionCookie);
  if (appIds.length === 0) {
    logger.warn("Auto-découverte : aucun dossier trouvé dans MyList");
    return [];
  }

  logger.info(`Auto-découverte : ${appIds.length} dossier(s) → ${appIds.map(a => a.slice(0, 8) + "…").join(", ")}`);
  return appIds.map((id, i) => ({ appId: id, index: i, label: `#${i + 1}:${id.slice(0, 8)}` }));
}

// ─── Boucle par compte ────────────────────────────────────────────────────────

async function runExtAccountLoop(job: Record<string, unknown>): Promise<void> {
  const applicationId = job.id as string;
  const applicantName = job.applicantName as string;
  const hunterConfig = (job.hunterConfig ?? {}) as Record<string, unknown>;
  const logger = createLogger(`CEV-EXT:${applicantName}`);

  let vowintEmail = (hunterConfig.embassyUsername as string | undefined) ?? process.env.VOWINT_EMAIL ?? "";
  let vowintPassword = (hunterConfig.embassyPassword as string | undefined) ?? process.env.VOWINT_PASSWORD ?? "";

  if (!vowintEmail || !vowintPassword) {
    logger.error("Credentials VOWINT manquants (hunterConfig.embassyUsername/Password ou env VOWINT_EMAIL/PASSWORD)");
    return;
  }

  // ── Proxy ────────────────────────────────────────────────────────────────
  const useProxy = (hunterConfig.cevUseProxy as boolean | undefined) ?? await shouldUseProxy();
  if (useProxy) {
    if (process.env.SOAX_PROXY_URL) {
      const stickyUrl = makeCevProxyStickyUrl("soax", undefined, `cev-ext-${applicationId}`);
      process.env.IPROYAL_PROXY_URL = stickyUrl;
      resetCevImpitInstances();
      await initCevProxyGuardWithExitIp(stickyUrl, `cev-ext-${applicationId}`);
      logger.info(`Proxy SOAX configuré (${stickyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 55)}…)`);
    } else if (process.env.IPROYAL_PROXY_URL) {
      await initCevProxyGuardWithExitIp(process.env.IPROYAL_PROXY_URL, `cev-ext-${applicationId}`);
      logger.info("Proxy iProyal configuré");
    } else {
      logger.warn("Proxy activé dans hunterConfig mais aucune URL proxy — connexion directe");
    }
  } else {
    delete process.env.IPROYAL_PROXY_URL;
    resetCevImpitInstances();
    logger.info("Proxy désactivé");
  }

  // ── Lire config ──────────────────────────────────────────────────────────
  const [cfgPauseSec, cfgLazyProb, cfgLazyMin, cfgLazyMax] = await Promise.all([
    getBotConfigValue("cev_extension_pause_sec"),
    getBotConfigValue("cev_extension_lazy_prob"),
    getBotConfigValue("cev_extension_lazy_min"),
    getBotConfigValue("cev_extension_lazy_max"),
  ]);
  const basePauseSec  = parseCfg(cfgPauseSec  ?? undefined,  60);
  const lazyProb      = parseCfg(cfgLazyProb ?? undefined, 0.12);
  const lazyMinSec    = parseCfg(cfgLazyMin  ?? undefined,  120);
  const lazyMaxSec    = parseCfg(cfgLazyMax  ?? undefined,  300);

  // ── Découverte des dossiers ───────────────────────────────────────────────
  let dossiers = await discoverDossiers(vowintEmail, vowintPassword, applicationId, hunterConfig, logger);
  if (dossiers.length === 0) {
    logger.error("Aucun dossier disponible — boucle abandonnée");
    return;
  }

  logger.info(`═══ CEV Extension : ${applicantName} | ${dossiers.length} dossier(s) | base=${basePauseSec}s | lazy=${Math.round(lazyProb * 100)}% ═══`);

  let scanCount = 0;
  let cursor = 0;
  let nextScanAt = 0;
  let rediscoverAt = Date.now() + 4 * 60 * 60_000; // Re-découverte toutes les 4h

  while (true) {
    try {
      // ── Respecter le calendrier ──────────────────────────────────────────
      const now = Date.now();
      if (now < nextScanAt) {
        await sleep(nextScanAt - now);
      }

      // ── Vérification arrêt & config toutes les 10 scans ─────────────────
      if (scanCount > 0 && scanCount % 10 === 0) {
        const stopSig = await getBotConfigValue("cev_session_stop");
        if (stopSig === "1") {
          logger.info("🛑 Signal d'arrêt (cev_session_stop=1) → arrêt gracieux");
          return;
        }
        const extMode = await getBotConfigValue("cev_extension_mode");
        if (extMode !== "1") {
          logger.info("Mode extension désactivé → arrêt");
          return;
        }
      }

      // ── Reload credentials Convex toutes les 5 scans ─────────────────────
      if (scanCount > 0 && scanCount % 5 === 0) {
        const latestJobs = await getActiveJobs();
        const latestJob = latestJobs.find((j: unknown) => (j as Record<string, unknown>).id === applicationId);
        if (!latestJob) {
          logger.info(`🛑 Job ${applicationId} n'est plus actif → arrêt`);
          return;
        }
        const lj = latestJob as unknown as Record<string, unknown>;
        const cfg = (lj.hunterConfig ?? {}) as Record<string, unknown>;
        const freshEmail = cfg.embassyUsername as string | undefined;
        const freshPwd   = cfg.embassyPassword as string | undefined;
        if (freshEmail && freshPwd && (freshEmail !== vowintEmail || freshPwd !== vowintPassword)) {
          logger.info(`🔑 Credentials mis à jour (${freshEmail.slice(0, 20)}…)`);
          invalidateVowintCache(vowintEmail);
          vowintEmail   = freshEmail;
          vowintPassword = freshPwd;
        }
      }

      // ── Re-découverte automatique des dossiers (toutes les 4h) ───────────
      if (Date.now() >= rediscoverAt) {
        logger.info("🔄 Re-découverte automatique des dossiers MyList…");
        const fresh = await discoverDossiers(vowintEmail, vowintPassword, applicationId, hunterConfig, logger);
        if (fresh.length > 0) {
          // Conserver cursor si toujours valide
          cursor = cursor < fresh.length ? cursor : 0;
          dossiers = fresh;
          logger.info(`  ${dossiers.length} dossier(s) après re-découverte`);
        }
        rediscoverAt = Date.now() + 4 * 60 * 60_000;
      }

      // ── Prochain dossier : round-robin en ignorant les cooldowns ─────────
      let dossier: ExtDossier | null = null;
      for (let attempt = 0; attempt < dossiers.length; attempt++) {
        const idx = (cursor + attempt) % dossiers.length;
        const candidate = dossiers[idx];
        if (pausedDossiers.has(candidate.appId)) {
          continue;
        }
        if (isCooledDown(candidate.appId)) {
          const h = getHealth(candidate.appId);
          const remainMs = h.cooldownUntil - Date.now();
          logger.info(`  ⏳ ${candidate.label} en cooldown (${Math.ceil(remainMs / 60_000)} min restantes) — skip`);
          continue;
        }
        dossier = candidate;
        cursor = (idx + 1) % dossiers.length;
        break;
      }

      if (!dossier) {
        const allPaused = dossiers.every(d => pausedDossiers.has(d.appId));
        if (allPaused) {
          logger.info("⏸️ Tous les dossiers en pause (slot trouvé) — arrêt de la boucle");
          return;
        }
        // Tous en cooldown → attendre le cooldown le plus court
        const minCooldown = Math.min(
          ...dossiers
            .filter(d => !pausedDossiers.has(d.appId))
            .map(d => getHealth(d.appId).cooldownUntil)
        );
        const waitMs = Math.max(30_000, minCooldown - Date.now());
        logger.info(`⏳ Tous les dossiers en cooldown — attente ${Math.ceil(waitMs / 60_000)} min`);
        await sleep(waitMs);
        continue;
      }

      // ── Scan ─────────────────────────────────────────────────────────────
      scanCount++;
      const h = getHealth(dossier.appId);
      h.totalScans++;

      logger.info(`[Scan #${scanCount}] ${dossier.label} | Erreurs consec: ${h.consecutiveErrors} | Total: ${h.totalScans}`);

      const result = await scanDossier(vowintEmail, vowintPassword, dossier, applicationId, logger);

      botLog({
        applicationId,
        step: "cev_extension_scan",
        status: result.status === "error" || result.status === "rate_limited" ? "warn" : "ok",
        data: {
          dossier: dossier.label,
          appId: dossier.appId.slice(0, 8),
          result: result.status,
          scan: scanCount,
          consecutiveErrors: h.consecutiveErrors,
        },
      });

      // ── Traitement du résultat ───────────────────────────────────────────
      switch (result.status) {
        case "slot_found":
          h.totalSlots++;
          markSuccess(dossier.appId);
          await handleSlotFound(
            vowintEmail, vowintPassword, dossier, applicationId,
            result.sessionCookie, result.integrationUrl, logger,
          );
          break;

        case "no_slot":
        case "no_slot_poll":
          logger.info(`  — Pas de créneau`);
          markSuccess(dossier.appId);
          break;

        case "rate_limited":
          markRateLimit(dossier.appId, vowintEmail, logger);
          break;

        case "error":
          markError(dossier.appId, logger);
          invalidateAnticaptchaCache();
          break;
      }

      // ── Stats périodiques ────────────────────────────────────────────────
      if (scanCount % 20 === 0) {
        const uptimeMin = Math.round((Date.now() - (nextScanAt - basePauseSec * 1000 * scanCount)) / 60_000);
        botLog({
          applicationId,
          step: "cev_extension_stats",
          status: "ok",
          data: {
            scanCount,
            dossierCount: dossiers.length,
            paused: pausedDossiers.size,
            cooledDown: dossiers.filter(d => isCooledDown(d.appId)).length,
          },
        });
        logger.info(`📊 #${scanCount} scans | ${dossiers.length - pausedDossiers.size} actifs / ${dossiers.length}`);
      }

      // ── Pause humaine post-scan ──────────────────────────────────────────
      const pauseMs = computeHumanPause(basePauseSec, lazyProb, lazyMinSec, lazyMaxSec);
      const isLazy  = pauseMs > basePauseSec * 1000 + 20_000;
      logger.info(
        `Pause ${Math.round(pauseMs / 1000)}s` +
        (isLazy ? ` (☕ paresse humaine)` : ` (jitter log-normal)`)
      );
      nextScanAt = Date.now() + pauseMs;

    } catch (loopErr) {
      logger.error(`Erreur boucle: ${loopErr}`);
      // Sécurité anti-spam : au moins 45 s avant le prochain cycle
      nextScanAt = Math.max(nextScanAt, Date.now() + 45_000);
      logger.info(`Prochain cycle dans ${Math.ceil((nextScanAt - Date.now()) / 1000)}s`);
    }
  }
}

// ─── Point d'entrée principal ─────────────────────────────────────────────────

export async function startCevExtensionLoop(): Promise<void> {
  const logger = createLogger("CEV-EXT");
  logger.info("═══ CEV Extension Loop — démarrage ═══");

  // Attendre que le mode soit activé
  while (true) {
    const mode = await getBotConfigValue("cev_extension_mode");
    if (mode === "1") break;
    logger.info("Mode désactivé (cev_extension_mode != 1) — attente 60 s…");
    await sleep(60_000);
  }

  // Charger les jobs CEV actifs
  let jobs: Record<string, unknown>[] = [];
  while (jobs.length === 0) {
    const allJobs = await getActiveJobs();
    jobs = (allJobs as unknown[]).filter((j) => {
      const job = j as Record<string, unknown>;
      const hc = (job.hunterConfig ?? {}) as Record<string, unknown>;
      return (
        job.destination === "schengen" &&
        hc.isActive === true &&
        (hc.embassyUsername || process.env.VOWINT_EMAIL)
      );
    }) as Record<string, unknown>[];

    if (jobs.length === 0) {
      logger.warn("Aucun job CEV actif (destination=schengen + hunterConfig.isActive + credentials) — attente 60 s");
      await sleep(60_000);
    }
  }

  logger.info(`${jobs.length} compte(s) CEV actif(s) — lancement des boucles`);
  jobs.forEach((j, i) => logger.info(`  #${i + 1}: ${j.applicantName} (${String(j.id).slice(0, 8)}…)`));

  // Une boucle par compte (en parallèle)
  await Promise.all(jobs.map(job => runExtAccountLoop(job)));
  logger.info("═══ CEV Extension Loop — toutes les boucles terminées ═══");
}
