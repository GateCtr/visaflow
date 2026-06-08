/**
 * CEV Dossier Loop v3 — Pool de DOSSIERS (pas d'IPs)
 *
 * STRATÉGIE :
 *   La limite des 5 clics/heure est PAR DOSSIER (AppId), pas par IP ni par compte.
 *   → On utilise N dossiers en rotation round-robin sur 1 seule IP SOAX.
 *   → 5 dossiers × 5 clics/h = 25 scans/heure = 1 scan toutes les ~2.5 min
 *
 * ARCHITECTURE :
 *   - 1 seule IP proxy (SOAX Kinshasa, sticky session 5min)
 *   - N dossiers VOWINT (configurés via bot-config "cev_dossier_pool")
 *   - Rotation round-robin entre les dossiers
 *   - Chaque dossier a son propre compteur de clics (5/h max)
 *   - Quand un dossier détecte un slot → booking immédiat avec CE dossier
 *
 * CONFIG Convex (bot-config) :
 *   cev_dossier_mode = "1"                  → activer ce loop
 *   cev_dossier_pool = "VOWINT6085888,VOWINT6085889,VOWINT6085890"
 *   cev_dossier_interval_sec = "30"         → pause entre chaque scan (défaut: calculé auto)
 *
 * IMPORTANT : MUTUELLEMENT EXCLUSIF avec cev-stealth-loop (v2 IP pool).
 */

import { setupCevSessionHttp, invalidateVowintCache, invalidateAnticaptchaCache, resolveFirstAppIdFromMyList } from "../cevHttpSetup.js";
import { bookCevViaHttp } from "../cevHttpBooking.js";
import { bookWithExistingSession } from "../cevBooking.js";
import { pollCevSlot } from "../cevPolling.js";
import {
  initCevProxyGuard,
  releaseCevProxyGuard,
  isCevSessionFrozen,
  checkCevProxyLiveness,
  resetCevImpitInstances,
  makeCevProxyStickyUrl,
  initCevProxyGuardWithExitIp,
  setCevExternalUserAgent,
  getCevExternalUserAgent,
  shouldUseProxy,
  getCevBrowserHeaders,
  getCevSessionUa,
  cevImpitFetch,
} from "../cev-shared-impit.js";
import {
  getPendingCevSetups,
  getActiveCevSessions,
  getCevCredentials,
  recordCevSessionCheck,
  reportSlotFound,
  botLog,
  getBotConfigValue,
  getActiveJobs,
  resetCevClickCount,
  injectApplicationF5Cookies,
} from "../convexClient.js";
import {
  initCevRedis,
  syncPoolStateToRedis,
  restorePoolStateFromRedis,
  type SerializablePoolState,
} from "../cev-redis-persistence.js";
import { recordScan, recordSlotFound, recordRateLimit, recordRelogin, recordPause } from "../daily-stats.js";
import { createLogger } from "../logger.js";

// ─── Fonction pour capturer le cookie F5 (TS01) ──────────────────────────────

async function captureF5CookieForAccount(
  accountId: string, 
  logger: ReturnType<typeof createLogger>,
  hunterConfig?: { cevUseProxy?: boolean }
): Promise<{ f5CookieValue: string, f5CookieName: string, userAgent: string } | null> {
  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer-extra");
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteer.default.use(StealthPlugin());
  } catch (err) {
    logger.error(`puppeteer-extra or puppeteer-extra-plugin-stealth not installed: ${err}`);
    return null;
  }

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ];

  // Check if proxy should be used
  const useProxy = hunterConfig?.cevUseProxy ?? true;
  let PROXY_URL = "";
  if (useProxy) {
    // First try SOAX with accountId as identifier (same as the loop)
    if (process.env.SOAX_PROXY_URL) {
      PROXY_URL = makeCevProxyStickyUrl("soax", undefined, `cev-dossier-${accountId}`);
    } else if (process.env.IPROYAL_PROXY_URL) {
      PROXY_URL = makeCevProxyStickyUrl("iproyal", undefined, `cev-dossier-${accountId}`);
    } else {
      PROXY_URL = process.env.PROXY_URL ?? "";
    }
  }

  let proxyHost = "";
  let proxyPort = "";

  if (PROXY_URL) {
    try {
      const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
      proxyHost = parsed.hostname;
      proxyPort = parsed.port;
      launchArgs.push(`--proxy-server=${parsed.hostname}:${parsed.port}`);
      logger.info(`Proxy configuré pour capture cookie F5: ${proxyHost}:${proxyPort}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.warn(`Erreur config proxy: ${errMsg}`);
    }
  }

  let browser: any = null;
  const VOWINT_URL = "https://visaonweb.diplomatie.be";

  try {
    logger.info(`Lancement du navigateur pour capture cookie F5...`);
    browser = await puppeteer.default.launch({
      headless: "new",
      args: launchArgs,
    });
    logger.info("Navigateur lancé avec succès");

    const page = await browser.newPage();

    if (PROXY_URL) {
      try {
        const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
        if (parsed.username) {
          logger.info(`Authentification proxy avec username: ${decodeURIComponent(parsed.username).slice(0, 30)}…`);
          await page.authenticate({
            username: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
          });
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logger.error(`Erreur lors de l'authentification proxy: ${errMsg}`);
        return null;
      }
    }

    const userAgent = await browser.userAgent();
    logger.info(`User-Agent: ${userAgent.slice(0, 80)}...`);

    // Step 1: Go to VOWINT homepage
    logger.info(`Navigating to VOWINT homepage pour TS cookie: ${VOWINT_URL}`);
    await page.goto(VOWINT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    const waitVowintSec = 8 + Math.random() * 4;
    logger.info(`Waiting ${waitVowintSec.toFixed(1)}s sur VOWINT pour TS cookie...`);
    await new Promise(r => setTimeout(r, waitVowintSec * 1000));

    let cookies = await page.cookies();
    logger.info(`${cookies.length} cookie(s) capturés: ${cookies.map((c: any) => c.name).join(", ")}`);

    let f5Cookie = cookies.find((c: any) => c.name.startsWith("TS"));
    if (!f5Cookie) {
      logger.warn(`F5 cookie (TS*) introuvable! Essai rechargement...`);
      // Retry like session worker
      await page.goto(VOWINT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
      await new Promise(r => setTimeout(r, 10000));

      const cookies2 = await page.cookies();
      f5Cookie = cookies2.find((c: any) => c.name.startsWith("TS"));

      if (!f5Cookie) {
        logger.error("F5 cookie toujours manquant après reload!");
        return null;
      }
    }

    logger.success(`✅ Cookie F5 capturé: ${f5Cookie.name}=${f5Cookie.value.slice(0, 20)}...`);
    return { 
      f5CookieValue: f5Cookie.value, 
      f5CookieName: f5Cookie.name,
      userAgent: userAgent,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    logger.error(`Erreur Puppeteer capture cookie F5: ${msg}`);
    if (stack) logger.error(`Stack trace: ${stack}`);
    return null;
  } finally {
    if (browser) {
      try {
        logger.info("Fermeture du navigateur");
        await browser.close();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logger.warn(`Erreur lors de la fermeture du navigateur: ${errMsg}`);
      }
    }
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

const MAX_CLICKS_PER_SESSION = 5; // Limite GLOBALE par session VOWINT (serveur bloque au 6ème)
const MAX_CLICKS_PER_DOSSIER_PER_HOUR = 5; // Vraie limite serveur CEV (vérifiée)
const CLICK_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const DEFAULT_INTERVAL_SEC = 150; // Pause par défaut — calibrée pour 3 dossiers × 5 clics × 80% = 150s

// Compteur GLOBAL de clics sur la session VOWINT courante
let globalSessionClicks = 0;

// ─── Dossier Slot (état de chaque dossier) ──────────────────────────────────

interface DossierSlot {
  /** Index dans le pool (0-based) */
  index: number;
  /** Numéro VOWINT (ex: "VOWINT6085888") */
  vowintRef: string;
  /** Timestamps des clics GetEAppointmentUrl effectués */
  clickTimestamps: number[];
  /** Nombre total de scans réussis */
  totalScans: number;
  /** Nombre de rate-limits rencontrés */
  rateLimitCount: number;
  /** Date du dernier reset quotidien (timestamp) */
  lastDailyReset?: number;
}

class CevDossierPool {
  private slots: DossierSlot[] = [];
  private currentIndex = 0;
  private logger: ReturnType<typeof createLogger>;

  constructor(logger: ReturnType<typeof createLogger>) {
    this.logger = logger;
  }

  /** Initialise le pool avec les numéros VOWINT */
  initialize(vowintRefs: string[]): void {
    const now = Date.now();
    this.slots = vowintRefs.map((ref, i) => ({
      index: i,
      vowintRef: ref.trim().toUpperCase(),
      clickTimestamps: [],
      totalScans: 0,
      rateLimitCount: 0,
      lastDailyReset: now,
    }));
    this.currentIndex = 0;
    this.logger.info(`Pool initialisé: ${this.slots.length} dossiers`);
    this.slots.forEach((s, i) => this.logger.info(`  #${i}: ${s.vowintRef}`));
  }

  /** Retourne le prochain dossier disponible (quota non épuisé) */
  getNextAvailable(): DossierSlot | null {
    if (this.slots.length === 0) return null;
    const now = Date.now();
    const startIndex = this.currentIndex;

    for (let attempts = 0; attempts < this.slots.length; attempts++) {
      const idx = (startIndex + attempts) % this.slots.length;
      const slot = this.slots[idx];

      // Purger les clics > 1 heure
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);

      // Vérifier quota
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
        // Vérifier si le dossier est en pause (slot trouvé précédemment)
        if (pausedDossiers.has(slot.vowintRef)) {
          this.logger.info(`  ⏸️ #${slot.index} ${slot.vowintRef} en PAUSE (slot trouvé) — skip`);
          continue;
        }
        this.currentIndex = (idx + 1) % this.slots.length;
        return slot;
      }

      // Dossier épuisé — loguer le skip
      if (attempts === 0 || this.slots.length <= 3) {
        const oldestClick = slot.clickTimestamps[0];
        const availableInMin = Math.ceil((oldestClick + CLICK_WINDOW_MS - now) / 60_000);
        this.logger.info(`  ⏭️ #${slot.index} ${slot.vowintRef} épuisé (${slot.clickTimestamps.length}/${MAX_CLICKS_PER_DOSSIER_PER_HOUR}) — dispo dans ${availableInMin}min`);
      }
    }

    return null; // Tous les dossiers sont épuisés
  }

  /** Enregistre un clic sur un dossier */
  recordClick(slot: DossierSlot): void {
    slot.clickTimestamps.push(Date.now());
    slot.totalScans++;
  }

  /** Marque un dossier comme rate-limité (tous ses clics comptés) */
  markRateLimited(slot: DossierSlot): void {
    // Remplir les clics pour bloquer ce dossier pendant 1h
    const now = Date.now();
    while (slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS).length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
      slot.clickTimestamps.push(now);
    }
    slot.rateLimitCount++;
    this.logger.warn(`Dossier #${slot.index} ${slot.vowintRef} rate-limité (${slot.rateLimitCount}x)`);
  }

  /** Temps d'attente avant qu'un dossier soit disponible */
  getNextAvailableIn(): number {
    const now = Date.now();
    let minWait = Infinity;

    for (const slot of this.slots) {
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
        return 0;
      }
      // Quand le plus ancien clic expire
      const oldest = slot.clickTimestamps[0];
      const availableAt = oldest + CLICK_WINDOW_MS;
      minWait = Math.min(minWait, availableAt - now);
    }

    return minWait === Infinity ? 60_000 : minWait;
  }

  /** Stats du pool */
  getStats(): { total: number; available: number; exhausted: number; totalScans: number } {
    const now = Date.now();
    let available = 0;
    let totalScans = 0;

    for (const slot of this.slots) {
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) available++;
      totalScans += slot.totalScans;
    }

    return {
      total: this.slots.length,
      available,
      exhausted: this.slots.length - available,
      totalScans,
    };
  }

  /** Reset quotidien de tous les compteurs */
  checkDailyReset(): void {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    let resetCount = 0;

    for (const slot of this.slots) {
      if (!slot.lastDailyReset || (now - slot.lastDailyReset) > oneDayMs) {
        const oldTotal = slot.totalScans;
        slot.totalScans = 0;
        slot.lastDailyReset = now;
        resetCount++;
        this.logger.info(`📅 Reset quotidien ${slot.vowintRef}: ${oldTotal} scans → 0`);
      }
    }

    if (resetCount > 0) {
      this.logger.info(`📅 Reset quotidien terminé: ${resetCount} dossier(s) réinitialisé(s)`);
    }
  }

  get size(): number { return this.slots.length; }

  /** Exporte l'état complet du pool pour persistance Redis */
  exportState(): SerializablePoolState {
    return {
      currentIndex: this.currentIndex,
      slots: this.slots.map(s => ({
        vowintRef: s.vowintRef,
        clickTimestamps: [...s.clickTimestamps],
        totalScans: s.totalScans,
        rateLimitCount: s.rateLimitCount,
        lastDailyReset: s.lastDailyReset,
      })),
      pausedDossiers: Array.from(pausedDossiers),
      savedAt: Date.now(),
    };
  }

  /** Restaure l'état depuis Redis (merge avec les dossiers configurés) */
  restoreState(saved: SerializablePoolState): void {
    // Créer un index rapide par vowintRef
    const savedMap = new Map(saved.slots.map(s => [s.vowintRef, s]));
    const now = Date.now();

    for (const slot of this.slots) {
      const savedSlot = savedMap.get(slot.vowintRef);
      if (savedSlot) {
        slot.clickTimestamps = savedSlot.clickTimestamps;
        slot.totalScans = savedSlot.totalScans;
        slot.rateLimitCount = savedSlot.rateLimitCount;
        slot.lastDailyReset = savedSlot.lastDailyReset || now;
      } else {
        slot.lastDailyReset = now;
      }
    }

    // Restaurer currentIndex seulement s'il est valide
    if (saved.currentIndex >= 0 && saved.currentIndex < this.slots.length) {
      this.currentIndex = saved.currentIndex;
    }

    // Restaurer les dossiers en pause (backward compatibility: champ peut être undefined)
    if (saved.pausedDossiers) {
      saved.pausedDossiers.forEach(vowintRef => pausedDossiers.add(vowintRef));
    }

    this.logger.info(`Pool restauré depuis Redis (index=${this.currentIndex}, paused=${saved.pausedDossiers?.length || 0})`);
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

interface LoopState {
  scanCount: number;
  slotsFound: number;
  rateLimits: number;
  errors: number;
  isRunning: boolean;
  startedAt: number;
}

const state: LoopState = {
  scanCount: 0,
  slotsFound: 0,
  rateLimits: 0,
  errors: 0,
  isRunning: false,
  startedAt: 0,
};

// Temporary log function for legacy use
function log(level: "INFO" | "WARN" | "ERROR", msg: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] [CEV-DOSSIER-LEGACY] [${level}] ${msg}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Core: un scan avec un dossier spécifique ───────────────────────────────

interface ScanResult {
  status: "no_slot" | "slot_found" | "rate_limited" | "error";
  sessionCookie?: string;
  integrationUrl?: string;
}

async function performScan(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
  applicationId: string,
  siphoned?: {
    f5CookieValue?: string;
    f5CookieName?: string;
    aspNetSessionId?: string;
    userAgent?: string;
    validUntil?: number;
  },
  _hcaptchaRetry = 0,
  logger?: ReturnType<typeof createLogger>,
): Promise<ScanResult> {
  const logFn = logger || { 
    info: (msg: string) => log("INFO", msg), 
    warn: (msg: string) => log("WARN", msg), 
    error: (msg: string) => log("ERROR", msg) 
  };

  const result = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    applicationId,
    applicationId,
    dossier.vowintRef, // Le numéro VOWINT sera résolu via MyList
    siphoned,
  );

  if (!result.success) {
    if (result.error?.includes("RATE_LIMIT")) {
      return { status: "rate_limited" };
    }
    // Retry automatique sur erreurs captcha (HCAPTCHA_FAILED, CAPTCHA_NO_VALID_UNTIL, etc.)
    // Invalide le cache clé Anti-Captcha avant de réessayer → force relecture env + botConfig
    const isCaptchaError = result.error === "HCAPTCHA_FAILED" || 
                           result.error?.includes("CAPTCHA") ||
                           result.error?.includes("CAPTCHA_RETRY");
    if (isCaptchaError && _hcaptchaRetry < 2) {
      logFn.warn(`  ⟳ ${result.error} — retry ${_hcaptchaRetry + 1}/2 avec clé fraîche dans 5s…`);
      invalidateAnticaptchaCache();
      await sleep(5_000);
      return performScan(vowintEmail, vowintPassword, dossier, applicationId, siphoned, _hcaptchaRetry + 1, logger);
    }
    logFn.warn(`  Erreur setup: ${result.error}`);
    return { status: "error" };
  }

  // Clic réussi — enregistrer
  globalSessionClicks++;

  if (result.slotsAvailable) {
    return {
      status: "slot_found",
      sessionCookie: result.sessionCookie,
      integrationUrl: result.integrationUrl,
    };
  }

  // Poll rapide si on a un cookie de session
  if (result.sessionCookie) {
    const pollResult = await pollCevSlot(
      result.integrationUrl ?? "",
      result.sessionCookie,
      siphoned,
    );
    if (pollResult.status === "slot_found") {
      return {
        status: "slot_found",
        sessionCookie: result.sessionCookie,
        integrationUrl: result.integrationUrl,
      };
    }
  }

  return { status: "no_slot" };
}

// ─── Booking ────────────────────────────────────────────────────────────────

import { discoverSlotBookingFlow, sendSlotDetectedEmail } from "../cev-slot-discovery.js";

/** Dossiers en pause (après slot_found) — ne pas re-scanner */
const pausedDossiers = new Set<string>();

async function handleSlotFound(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
  applicationId: string,
  existingSessionCookie?: string,
  existingIntegrationUrl?: string,
  siphoned?: {
    f5CookieValue?: string;
    f5CookieName?: string;
    aspNetSessionId?: string;
    userAgent?: string;
    validUntil?: number;
  },
  logger?: ReturnType<typeof createLogger>,
): Promise<void> {
  const logFn = logger || { 
    info: (msg: string) => log("INFO", msg), 
    warn: (msg: string) => log("WARN", msg), 
    error: (msg: string) => log("ERROR", msg) 
  };
  logFn.info(`🚨 SLOT DÉTECTÉ sur dossier #${dossier.index} ${dossier.vowintRef} — DISCOVERY + BOOKING`);
  state.slotsFound++;

  // ── PAUSE immédiate du dossier (ne plus le re-scanner) ──
  pausedDossiers.add(dossier.vowintRef);
  logFn.info(`  ⏸️ Dossier #${dossier.index} ${dossier.vowintRef} mis en PAUSE`);

  botLog({
    applicationId,
    step: "cev_dossier_slot_found",
    status: "ok",
    data: {
      dossier: dossier.vowintRef,
      dossierIndex: dossier.index,
      scanCount: state.scanCount,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
      hasExistingSession: !!existingSessionCookie,
      paused: true,
    },
  });

  // ── DISCOVERY : capturer TOUT le flow avec la session EXISTANTE ──
  // Pas de re-login ! On utilise la session qui vient de détecter le slot.
  // Le slot ne peut pas disparaître entre la détection et la capture.
  const sessionCookie = existingSessionCookie;
  const integrationUrl = existingIntegrationUrl;

  if (sessionCookie && integrationUrl) {
    logFn.info(`  🔬 Discovery avec session existante (pas de re-login)...`);

    const discovery = await discoverSlotBookingFlow(
      sessionCookie,
      integrationUrl,
      dossier.vowintRef,
      applicationId,
    );

    // Envoyer email admin
    logFn.info(`  📧 Envoi email admin...`);
    await sendSlotDetectedEmail(dossier.vowintRef, discovery);

    // Tenter le booking HTTP avec la session existante
    logFn.info(`  🎯 Tentative booking HTTP avec session existante...`);
    try {
      const httpResult = await bookCevViaHttp(integrationUrl, sessionCookie!, applicationId, siphoned);
      if (httpResult.success) {
        logFn.info(`  ✅ BOOKING RÉUSSI! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
        await reportSlotFound({
          applicationId,
          date: httpResult.bookedDate ?? "",
          time: httpResult.bookedTime ?? "",
          location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
          confirmationCode: httpResult.confirmationCode,
        });
        return;
      }
      logFn.info(`  ⚠️ Booking HTTP échoué: ${httpResult.error} — tentative avec re-login...`);
    } catch (err) {
      logFn.warn(`  ⚠️ Booking HTTP crash: ${err} — tentative avec re-login...`);
    }
  }

  // ── FALLBACK : re-login + nouveau setup (si session existante a échoué) ──
    logFn.info(`  🔄 Re-login pour tentative fallback...`);
    const session = await setupCevSessionHttp(
      vowintEmail,
      vowintPassword,
      applicationId,
      applicationId,
      dossier.vowintRef,
      siphoned,
    );

  if (!session.success || !session.sessionCookie || !session.integrationUrl) {
    logFn.error(`  Session re-setup échoué pour booking fallback`);
    return;
  }

  // Tentative booking HTTP avec session fraîche
  try {
    const httpResult = await bookCevViaHttp(session.integrationUrl!, session.sessionCookie!, applicationId, siphoned);
    if (httpResult.success) {
      logFn.info(`  ✅ BOOKING RÉUSSI (re-login)! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
      await reportSlotFound({
        applicationId,
        date: httpResult.bookedDate ?? "",
        time: httpResult.bookedTime ?? "",
        location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
        confirmationCode: httpResult.confirmationCode,
      });
      return;
    }

    // Fallback Playwright
    logFn.info(`  HTTP insuffisant — fallback Playwright...`);
    const pwResult = await bookWithExistingSession(
      session.integrationUrl,
      session.sessionCookie,
      applicationId,
    );
    if (pwResult.success) {
      logFn.info(`  ✅ BOOKING PLAYWRIGHT RÉUSSI! code=${pwResult.confirmationCode}`);
      await reportSlotFound({
        applicationId,
        date: pwResult.bookedDate ?? "",
        time: pwResult.bookedTime ?? "",
        location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
        confirmationCode: pwResult.confirmationCode,
        screenshotStorageId: pwResult.screenshotStorageId,
      });
    } else {
      logFn.error(`  ❌ Booking échoué: ${pwResult.error}`);
    }
  } catch (err) {
    logFn.error(`  💥 Crash booking: ${err}`);
  }
}

// ─── Loop Principal v3 ──────────────────────────────────────────────────────

export async function startCevDossierLoop(): Promise<void> {
  const logger = createLogger("CEV-DOSSIER-v3");
  logger.info("═══ CEV Dossier Loop v3 — Multi-comptes via Applications ═══");

  // Vérifier si le mode est activé
  const enabled = await getBotConfigValue("cev_dossier_mode");
  if (enabled !== "1") {
    logger.info("Mode dossier désactivé (cev_dossier_mode != 1) — attente...");
    while (true) {
      await sleep(60_000);
      const check = await getBotConfigValue("cev_dossier_mode");
      if (check === "1") {
        logger.info("Mode dossier activé → démarrage!");
        break;
      }
    }
  }

  // Récupérer les applications CEV actives via getActiveJobs() (comme le bot USA)
  const jobs = await getActiveJobs();
  const cevJobs = jobs.filter((j: any) => 
    j.destination === "schengen" && 
    j.hunterConfig?.isActive === true &&
    (j.hunterConfig.cevDossierPool || j.hunterConfig.vowintAppId)
  );

  if (cevJobs.length === 0) {
    logger.warn("Aucune application CEV active trouvée (destination=schengen + hunterConfig.isActive=true)");
    logger.info("Attente configuration...");
    while (true) {
      await sleep(60_000);
      const checkJobs = await getActiveJobs();
      const checkCevJobs = checkJobs.filter((j: any) => 
        j.destination === "schengen" && 
        j.hunterConfig?.isActive === true &&
        (j.hunterConfig.cevDossierPool || j.hunterConfig.vowintAppId)
      );
      if (checkCevJobs.length > 0) {
        logger.info(`Applications CEV trouvées: ${checkCevJobs.length}`);
        break;
      }
    }
  }

  logger.info(`═══ ${cevJobs.length} compte(s) CEV actif(s) ═══`);
  cevJobs.forEach((job: any, i: number) => {
    const dossierPool = job.hunterConfig.cevDossierPool || job.hunterConfig.vowintAppId;
    logger.info(`  Compte #${i + 1}: ${job.applicantName} (${job.id})`);
    logger.info(`    Dossiers: ${dossierPool}`);
    logger.info(`    Proxy: ${job.hunterConfig.cevUseProxy ? 'activé' : 'désactivé'}`);
  });

  // Lancer une loop par compte (application)
  const loopPromises = cevJobs.map((job: any) => 
    runAccountLoop(job)
  );

  await Promise.all(loopPromises);
}

// ─── Loop par compte (application) ────────────────────────────────────────────

async function runAccountLoop(job: any): Promise<void> {
  const accountId = job.id;
  const applicantName = job.applicantName;
  const hunterConfig = job.hunterConfig;
  const logger = createLogger(`CEV-Account:${applicantName}`);
  
  // Récupérer les credentials VOWINT depuis hunterConfig
  let vowintEmail = hunterConfig.embassyUsername;
  let vowintPassword = hunterConfig.embassyPassword;
  
  // Déterminer le pool de dossiers
  let dossierPoolStr = hunterConfig.cevDossierPool;
  let dossiers: string[];
  
  if (!dossierPoolStr) {
    // Mode automatique: naviguer vers My Applications pour trouver les dossiers
    logger.info( "  → Aucun dossier fourni, navigation automatique vers My Applications...");
    try {
      const authResult = await setupCevSessionHttp(vowintEmail, vowintPassword, accountId, accountId);
      if (authResult.success && authResult.sessionCookie) {
        const firstDossier = await resolveFirstAppIdFromMyList(authResult.sessionCookie);
        if (firstDossier) {
          dossiers = [firstDossier];
          logger.info(`  → Dossier automatique trouvé: ${firstDossier}`);
        } else {
          logger.warn( "  → Aucun dossier trouvé via navigation automatique");
          dossiers = [];
        }
      } else {
        logger.warn( "  → Échec de l'authentification pour navigation automatique");
        dossiers = [];
      }
    } catch (err) {
      logger.error(`  → Erreur navigation automatique: ${err}`);
      dossiers = [];
    }
  } else {
    dossiers = dossierPoolStr.split(",").map((s: string) => s.trim()).filter(Boolean);
  }
  
  // Créer un pool local pour ce compte
  const localPool = new CevDossierPool(logger);
  localPool.initialize(dossiers);
  
  // Clé Redis spécifique à ce compte
  const redisKey = `visaflow:cev-pool:${accountId}`;
  
  // Intervalle de scan
  const intervalSec = hunterConfig.cevScanIntervalSec || DEFAULT_INTERVAL_SEC;
  const intervalMs = intervalSec * 1000;
  
  // Proxy config
  const useProxy = hunterConfig.cevUseProxy ?? await shouldUseProxy();
  
  logger.info(`═══ Compte: ${applicantName} (${dossiers.length} dossiers) ═══`);
  logger.info(`  Intervalle: ${intervalSec}s`);
  logger.info(`  Proxy: ${useProxy ? 'activé' : 'désactivé'}`);
  
  // ─── Redis: restaurer l'état du pool ────────────────────────────────────────
  await initCevRedis();
  const savedPoolState = await restorePoolStateFromRedis(redisKey, false); // freshStart=false pour préserver les clics
  let savedScanCount = 0;
  if (savedPoolState) {
    localPool.restoreState(savedPoolState);
    savedScanCount = savedPoolState.scanCount || 0;
    // Restaurer les dossiers en pause depuis Redis (backward compatibility: champ peut être undefined)
    if (savedPoolState.pausedDossiers) {
      savedPoolState.pausedDossiers.forEach(vowintRef => pausedDossiers.add(vowintRef));
    }
    logger.info(`Pool state restauré depuis Redis — reprend à index=${savedPoolState.currentIndex}, scanCount=${savedScanCount}, paused=${savedPoolState.pausedDossiers?.length || 0}`);
  } else {
    logger.info( "Pas de pool state en Redis — démarrage frais");
  }

  const soaxBaseUrl = process.env.SOAX_PROXY_URL;
  let proxyExitIp: string | null = null;

  logger.info(`Config:`);
  logger.info(`  • Dossiers: ${localPool.size}`);
  logger.info(`  • Clics/h total: ${localPool.size * MAX_CLICKS_PER_DOSSIER_PER_HOUR}`);
  logger.info(`  • Intervalle: ${Math.round(intervalMs / 1000)}s (1 scan toutes les ${Math.round(intervalMs / 1000)}s)`);

  if (useProxy) {
    logger.info(`  • Proxy: SOAX (1 IP fixe Kinshasa)`);

    // ─── Configure SOAX proxy ─────────────────────────────────────────────────
    if (soaxBaseUrl) {
      const soaxStickyUrl = makeCevProxyStickyUrl("soax", undefined, `cev-dossier-${accountId}`);
      process.env.IPROYAL_PROXY_URL = soaxStickyUrl;
      resetCevImpitInstances(); // Force impit to recreate with new proxy URL
      logger.info(`  • SOAX proxy configuré: ${soaxStickyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}…`);
      // Effectuer un health check pour récupérer l'IP de sortie et initialiser le guard
      proxyExitIp = await initCevProxyGuardWithExitIp(soaxStickyUrl, `cev-dossier-${accountId}`);
    } else if (process.env.IPROYAL_PROXY_URL) {
      // Si on utilise iProyal, aussi initialiser le guard
      proxyExitIp = await initCevProxyGuardWithExitIp(process.env.IPROYAL_PROXY_URL, `cev-dossier-${accountId}`);
    } else {
      logger.warn(`  ⚠️ AUCUN PROXY (SOAX_PROXY_URL et IPROYAL_PROXY_URL absents) — connexion directe`);
    }
  } else {
    logger.info(`  • Proxy: Désactivé (mode sans proxy via hunterConfig)`);
    delete process.env.IPROYAL_PROXY_URL;
    resetCevImpitInstances();
  }

  // applicationId pour les botLogs
  const logApplicationId = accountId;

  if (!vowintEmail || !vowintPassword) {
    logger.error( "Credentials VOWINT manquants dans hunterConfig");
    return;
  }

  // ─── Boucle principale de scan pour ce compte ─────────────────────────────
  const state: LoopState = {
    scanCount: savedScanCount,
    slotsFound: 0,
    rateLimits: 0,
    errors: 0,
    isRunning: false,
    startedAt: 0,
  };

  let nextScanAllowedAt = 0;
  let globalSessionClicks = 0;
  let siphonedCreds: {
    f5CookieValue?: string;
    f5CookieName?: string;
    aspNetSessionId?: string;
    userAgent?: string;
    validUntil?: number;
    siphonedAt?: number;
  } | undefined = undefined;
  
  let lastF5CookieCapturedAt = 0;
  const F5_COOKIE_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // Refresh every 30 minutes

  // Récupérer les credentials siphonnés depuis le job's hunterConfig
  const hc = job.hunterConfig as any;
  if (hc?.cevSiphonedF5CookieValue) {
    siphonedCreds = {
      f5CookieValue: hc.cevSiphonedF5CookieValue,
      f5CookieName: hc.cevSiphonedF5CookieName,
      aspNetSessionId: hc.cevSiphonedAspNetSessionId,
      userAgent: hc.cevSiphonedUserAgent,
      validUntil: hc.cevSiphonedValidUntil,
      siphonedAt: hc.cevSiphonedAt,
    };
    logger.info(`🍪 Cookies siphonnés chargés depuis hunterConfig: F5=${!!siphonedCreds.f5CookieValue}, ASP.NET=${!!siphonedCreds.aspNetSessionId}`);
    
    if (siphonedCreds.userAgent) {
      setCevExternalUserAgent(siphonedCreds.userAgent);
    }
  } else {
    logger.info( "🍪 Pas de cookies siphonnés dans hunterConfig");
  }

  state.isRunning = true;
  state.startedAt = Date.now();
  logger.info( "Boucle de scan démarrée");

  while (state.isRunning) {
    try {
      // Respecter le calendrier de scan planifié (anti-spam même en cas de reconnexion/exception)
      const now = Date.now();
      if (now < nextScanAllowedAt) {
        const waitMs = nextScanAllowedAt - now;
        logger.info(`Attente planifiée / de sécurité : ${Math.round(waitMs / 1000)}s restantes...`);
        await sleep(waitMs);
      }

      // Re-check mode toutes les 50 scans
      if (state.scanCount > 0 && state.scanCount % 50 === 0) {
        const stillEnabled = await getBotConfigValue("cev_dossier_mode");
        if (stillEnabled !== "1") {
          logger.info( "Mode dossier désactivé → arrêt");
          state.isRunning = false;
          break;
        }
      }

      // ─── Vérifier si le job est toujours actif toutes les 5 scans ───
      if (state.scanCount % 5 === 0) {
        const latestJobs = await getActiveJobs();
        const currentJobStillActive = latestJobs.some(j => j.id === accountId);
        if (!currentJobStillActive) {
          logger.info(`🛑 Job ${accountId} (${applicantName}) n'est plus actif → arrêt`);
          state.isRunning = false;
          break;
        }
      }

      // ─── Check stop signal (permet d'arrêter même en config automatique) ───
      if (state.scanCount > 0 && state.scanCount % 10 === 0) {
        const stopSignal = await getBotConfigValue("cev_session_stop");
        if (stopSignal === "1") {
          logger.info( "🛑 Signal d'arrêt reçu (cev_session_stop=1) → arrêt gracieux");
          state.isRunning = false;
          break;
        }
      }

      // ─── Capturer et injecter le cookie F5 si nécessaire ────────────────────
      const nowTime = Date.now();
      if (!siphonedCreds || nowTime - lastF5CookieCapturedAt > F5_COOKIE_REFRESH_INTERVAL_MS) {
        logger.info(`🍪 Capture du cookie F5 pour le compte ${applicantName}...`);
        
        const f5Cookie = await captureF5CookieForAccount(accountId, logger, job.hunterConfig);
        
        if (f5Cookie) {
          // Inject the cookie into the job's hunterConfig
          const injectSuccess = await injectApplicationF5Cookies(
            accountId,
            f5Cookie.f5CookieValue,
            undefined, // ASP.NET SessionId will be obtained naturally
            f5Cookie.userAgent,
            {
              f5CookieName: f5Cookie.f5CookieName,
              validityMinutes: 60, // Valid for 1 hour
            }
          );
          
          if (injectSuccess) {
            // Update our local siphonedCreds
            siphonedCreds = {
              f5CookieValue: f5Cookie.f5CookieValue,
              f5CookieName: f5Cookie.f5CookieName,
              userAgent: f5Cookie.userAgent,
              validUntil: nowTime + 60 * 60 * 1000,
              siphonedAt: nowTime,
            };
            
            lastF5CookieCapturedAt = nowTime;
            
            // Set external user agent
            setCevExternalUserAgent(f5Cookie.userAgent);
            
            logger.success(`🍪 Cookie F5 capturé et injecté avec succès pour le compte ${applicantName}`);
          } else {
            logger.warn(`❌ Échec de l'injection du cookie F5 dans Convex`);
          }
        } else {
          logger.warn(`❌ Échec de la capture du cookie F5 — réessaie dans 2min...`);
          await sleep(2 * 60 * 1000); // Wait 2 minutes before retrying capture
          continue; // Skip this loop iteration, no scan without cookies!
        }
      }
      
      // Double check we have cookies before scanning
      if (!siphonedCreds) {
        logger.warn(`❌ Toujours pas de cookies F5 — réessaie dans 2min...`);
        await sleep(2 * 60 * 1000);
        continue;
      }

      // Récupérer le prochain dossier disponible
      const dossier = localPool.getNextAvailable();
      if (!dossier) {
        const waitMs = localPool.getNextAvailableIn();
        const waitMin = Math.ceil(waitMs / 60_000);
        const stats = localPool.getStats();
        logger.info(`⏳ Tous les dossiers épuisés (${stats.exhausted}/${stats.total}) — attente ${waitMin} min`);
        // Attente réduite: max 2 min au lieu de 5 min
        await sleep(Math.min(waitMs + 5000, 2 * 60_000));
        continue;
      }

      // Scan
      state.scanCount++;
      
      // Vérifier et reset les compteurs quotidiens
      localPool.checkDailyReset();
      
      const stats = localPool.getStats();

      // ─── Intervalle DYNAMIQUE basé sur les dossiers réellement actifs ──────
      // Formule : capacité max (s/scan) divisée par 0.8 pour utiliser 80% du quota
      // → jamais de burst, jamais d'épuisement, jamais de pause forcée
      // Exemple : 6 dossiers × 5 clics/h → max=120s → safe=150s → 24 scans/h uniforme
      const activeDossiers = stats.available - pausedDossiers.size;
      const dynamicIntervalMs = activeDossiers > 0
        ? Math.ceil((3600 / (activeDossiers * MAX_CLICKS_PER_DOSSIER_PER_HOUR)) / 0.8 * 1000)
        : intervalMs;
      // Utiliser le PLUS GRAND des deux : dynamique est un plancher de sécurité,
      // l'utilisateur peut configurer un intervalle plus long via cevScanIntervalSec
      const effectiveIntervalMs = Math.max(intervalMs, dynamicIntervalMs);

      logger.info(`[Scan #${state.scanCount}] Dossier: #${dossier.index} ${dossier.vowintRef} | Dispo: ${stats.available}/${stats.total} | Total: ${stats.totalScans} scans`);

      const result = await performScan(
        vowintEmail,
        vowintPassword,
        dossier,
        logApplicationId,
        siphonedCreds,
        0,
        logger,
      );

      // Log chaque scan dans Convex avec le dossier concerné
      botLog({
        applicationId: logApplicationId,
        step: "cev_dossier_scan",
        status: result.status === "error" || result.status === "rate_limited" ? "warn" : "ok",
        data: {
          dossierIndex: dossier.index,
          dossier: `#${dossier.index} ${dossier.vowintRef}`,
          result: result.status,
          scanNumber: state.scanCount,
          poolAvailable: stats.available,
          poolTotal: stats.total,
        },
      });

      const uniqueJobId = `cev-dossier-${dossier.vowintRef}`;
      switch (result.status) {
        case "slot_found":
          logger.info(`  🚨 SLOT TROUVÉ!`);
          recordScan(uniqueJobId, dossier.vowintRef);
          recordSlotFound(uniqueJobId, dossier.vowintRef);
          // Re-login préventif si on atteint la limite (avant le booking)
          if (globalSessionClicks >= MAX_CLICKS_PER_SESSION) {
            logger.info(`  🔄 Session VOWINT: ${globalSessionClicks}/${MAX_CLICKS_PER_SESSION} clics — re-login préventif`);
            invalidateVowintCache(vowintEmail);
            globalSessionClicks = 0;
            recordRelogin(uniqueJobId, dossier.vowintRef, "preventive");
          }
          await handleSlotFound(
            vowintEmail, vowintPassword, dossier, logApplicationId,
            result.sessionCookie, result.integrationUrl,
            siphonedCreds,
            logger,
          );
          break;
        case "rate_limited":
          state.rateLimits++;
          recordScan(uniqueJobId, dossier.vowintRef);
          recordRateLimit(uniqueJobId, dossier.vowintRef, "CEV 5 clics/h");
          localPool.markRateLimited(dossier);
          // Le rate-limit vient du serveur → session grillée, reset le compteur
          globalSessionClicks = 0;
          logger.warn(`  ⚡ Rate-limit sur #${dossier.index} ${dossier.vowintRef} — rotation vers prochain dossier`);
          break;
        case "error":
          state.errors++;
          recordScan(uniqueJobId, dossier.vowintRef);
          // Invalider le cache de la clé Anti-Captcha pour que le prochain scan
          // relise process.env ET botConfig Convex — corrige anticaptcha_not_configured en cascade
          invalidateAnticaptchaCache();
          break;
        case "no_slot":
          logger.info(`  — Pas de créneau`);
          recordScan(uniqueJobId, dossier.vowintRef);
          // Clic réussi — enregistrer (déjà fait dans performScan, mais on enregistre ici aussi pour comptage pool)
          localPool.recordClick(dossier);
          globalSessionClicks++;
          // Re-login préventif après MAX_CLICKS_PER_SESSION clics GLOBAUX
          if (globalSessionClicks >= MAX_CLICKS_PER_SESSION) {
            logger.info(`  🔄 Session VOWINT: ${globalSessionClicks}/${MAX_CLICKS_PER_SESSION} clics — re-login préventif`);
            invalidateVowintCache(vowintEmail);
            globalSessionClicks = 0;
            recordRelogin(uniqueJobId, dossier.vowintRef, "preventive");
          }
          break;
      }

      // Stats périodiques
      if (state.scanCount % 25 === 0) {
        const uptimeMin = Math.round((Date.now() - state.startedAt) / 60_000);
        const scansPerHour = uptimeMin > 0 ? Math.round(state.scanCount / (uptimeMin / 60)) : 0;
        const poolStats = localPool.getStats();
        logger.info(`📊 Stats: ${state.scanCount} scans en ${uptimeMin}min (${scansPerHour}/h) | Slots: ${state.slotsFound} | RL: ${state.rateLimits} | Pool: ${poolStats.available}/${poolStats.total}`);
        botLog({
          applicationId: logApplicationId,
          step: "cev_dossier_v3_stats",
          status: "ok",
          data: { scanCount: state.scanCount, slotsFound: state.slotsFound, rateLimits: state.rateLimits, scansPerHour, uptimeMin },
        });
      }

      // ─── Sync pool state vers Redis (fire-and-forget, chaque scan) ──────────
      syncPoolStateToRedis({ ...localPool.exportState(), scanCount: state.scanCount }, redisKey);

      // Pause entre les scans (intervalle dynamique)
      // Jitter important de ±30s (anti-shadow ban)
      const jitter = (Math.random() * 60 - 30) * 1000; // ±30s aléatoires
      const finalSleepMs = Math.max(10_000, effectiveIntervalMs + jitter); // Garder au moins 10s
      nextScanAllowedAt = Date.now() + finalSleepMs;
      logger.info(`Pause de ${Math.round(finalSleepMs / 1000)}s planifiée avant le prochain scan (jitter: ${Math.round(jitter / 1000)}s)`);

    } catch (loopErr) {
      logger.error(`Erreur loop: ${loopErr}`);
      state.errors++;
      
      // Sécurité anti-spam en cas d'erreur consécutive ou de crash (évite de marteler le serveur)
      const safetyPauseMs = 45000;
      nextScanAllowedAt = Math.max(nextScanAllowedAt, Date.now() + safetyPauseMs);
      logger.info(`Erreur détectée. Prochain scan planifié au plus tôt dans ${Math.round((nextScanAllowedAt - Date.now()) / 1000)}s.`);
    }
  }

  logger.info( "═══ CEV Dossier Loop v3 arrêté ═══");
}


/** Expose l'�tat pour monitoring */
export function getCevDossierState() {
  return { ...state, pool: null };
}





