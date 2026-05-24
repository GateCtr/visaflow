// ─── CEV Stealth Loop v2 — Pool d'IPs rotatif + couverture 24/7 ─────────────
//
// Stratégie : rotation d'IPs iProyal pour contourner la limite 5 clics/heure.
// Chaque IP a son propre compteur de clics. Quand une IP atteint sa limite,
// on passe automatiquement à la suivante — ZERO downtime.
//
// Architecture :
//   - Pool de N IPs résidentielles iProyal (sticky sessions 60 min)
//   - Chaque IP peut faire 4 clics/heure (marge sécurité vs limite serveur de 5)
//   - Rotation automatique quand rate-limit détecté sur une IP
//   - Couverture 24/7 : avec 4 IPs → 16 checks/heure (mode observation 48h)
//
// ═══ MODE OBSERVATION 48H ═══
//   Budget : 2 GB iProyal + $4.19 anti-captcha
//   Config optimale : pool=4, checks_per_cycle=1, pause=30s
//   Débit : 16 checks/h = 1 check toutes les 3.75 min
//   Coût total 48h : ~$2.30 captcha + ~768 MB proxy (marge ~45%)
//   Objectif : observer quand CEV publie les 200 créneaux/jour (heure inconnue)
//
// Config Convex (bot-config) :
//   cev_stealth_mode = "1"                 → activer le loop
//   cev_stealth_pool_size = "4"            → nombre d'IPs dans le pool (défaut: 4)
//   cev_stealth_checks_per_cycle = "1"     → checks par cycle avant rotation (défaut: 1)
//   cev_stealth_pause_between_checks = "30" → secondes entre checks (défaut: 30)
//
// IMPORTANT : MUTUELLEMENT EXCLUSIF avec cev-setup-loop + cev-polling-loop.

import { setupCevSessionHttp } from "../cevHttpSetup.js";
import { bookCevViaHttp } from "../cevHttpBooking.js";
import { bookWithExistingSession } from "../cevBooking.js";
import { pollCevSlot } from "../cevPolling.js";
import {
  getActiveCevSessions,
  getPendingCevSetups,
  recordCevSessionCheck,
  reportSlotFound,
  botLog,
  getBotConfigValue,
} from "../convexClient.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Nombre d'IPs dans le pool (configurable via bot-config) */
let POOL_SIZE = 4;

/** Max clics par IP par heure (4 = marge sécurité vs limite serveur de 5) */
const MAX_CLICKS_PER_IP_PER_HOUR = 4;

/** Délai entre chaque check dans un cycle (ms) */
let INTER_CHECK_DELAY_MS = 30_000; // 30 secondes (mode observation 48h)

/** Checks par cycle (avant rotation IP) — 1 = rotation après chaque check (économise les clics) */
let CHECKS_PER_CYCLE = 1;

/** Pause entre cycles (rotation IP) — courte car on change d'IP */
const CYCLE_PAUSE_MIN_MS = 5_000;  // 5 secondes
const CYCLE_PAUSE_MAX_MS = 15_000; // 15 secondes

/** Délai initial avant le premier cycle */
const INITIAL_DELAY_MS = 5_000;

/** Cooldown d'une IP rate-limitée (ms) — elle reviendra disponible après */
const IP_COOLDOWN_MS = 65 * 60_000; // 65 min (marge sur les 60 min du serveur)

// ─── IP Pool Manager ────────────────────────────────────────────────────────

interface IpSlot {
  /** Index dans le pool (0-based) */
  index: number;
  /** Proxy URL complète */
  proxyUrl: string;
  /** Session ID iProyal (pour sticky) */
  sessionId: string;
  /** Timestamps des clics effectués sur cette IP */
  clickTimestamps: number[];
  /** Timestamp où cette IP sera à nouveau disponible (si rate-limitée) */
  cooldownUntil: number;
  /** Nombre total de checks réussis */
  totalChecks: number;
  /** Nombre de rate-limits rencontrés */
  rateLimitCount: number;
}

class CevIpPool {
  private slots: IpSlot[] = [];
  private currentIndex = 0;
  private readonly baseProxyUrl: string;

  constructor() {
    // iProyal proxy base — on ajoute un suffix _session-XXX pour le sticky
    this.baseProxyUrl = process.env.IPROYAL_PROXY_URL 
      || "http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa@geo.iproyal.com:12321";
  }

  /** Initialise le pool avec N IPs (sticky sessions iProyal) */
  initialize(poolSize: number): void {
    this.slots = [];
    for (let i = 0; i < poolSize; i++) {
      const sessionId = `cev_stealth_${i}_${Date.now().toString(36)}`;
      // iProyal sticky session format: ajouter _session-{id}_lifetime-60m au username
      const proxyUrl = this.buildStickyProxy(sessionId);
      this.slots.push({
        index: i,
        proxyUrl,
        sessionId,
        clickTimestamps: [],
        cooldownUntil: 0,
        totalChecks: 0,
        rateLimitCount: 0,
      });
    }
    this.currentIndex = 0;
    log("INFO", `Pool initialisé: ${poolSize} IPs (iProyal sticky sessions)`);
  }

  /** Construit l'URL proxy avec sticky session iProyal */
  private buildStickyProxy(sessionId: string): string {
    // Format iProyal: user_session-{id}_lifetime-60m:pass@host:port
    const url = new URL(this.baseProxyUrl.startsWith("http") ? this.baseProxyUrl : `http://${this.baseProxyUrl}`);
    const baseUser = url.username;
    // Ajouter le suffix sticky au username
    url.username = `${baseUser}_session-${sessionId}_lifetime-60m`;
    return url.toString();
  }

  /** Obtient la prochaine IP disponible (non rate-limitée, quota non épuisé) */
  getNextAvailable(): IpSlot | null {
    const now = Date.now();
    const startIndex = this.currentIndex;
    
    for (let attempts = 0; attempts < this.slots.length; attempts++) {
      const idx = (startIndex + attempts) % this.slots.length;
      const slot = this.slots[idx];
      
      // Skip si en cooldown
      if (slot.cooldownUntil > now) continue;
      
      // Purger les clics > 1 heure
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < 60 * 60_000);
      
      // Skip si quota atteint
      if (slot.clickTimestamps.length >= MAX_CLICKS_PER_IP_PER_HOUR) continue;
      
      // IP disponible !
      this.currentIndex = (idx + 1) % this.slots.length;
      return slot;
    }
    
    return null; // Toutes les IPs sont épuisées ou en cooldown
  }

  /** Enregistre un clic réussi sur une IP */
  recordClick(slot: IpSlot): void {
    slot.clickTimestamps.push(Date.now());
    slot.totalChecks++;
  }

  /** Met une IP en cooldown après un rate-limit */
  markRateLimited(slot: IpSlot): void {
    slot.cooldownUntil = Date.now() + IP_COOLDOWN_MS;
    slot.rateLimitCount++;
    log("WARN", `IP #${slot.index} rate-limitée → cooldown ${Math.round(IP_COOLDOWN_MS / 60_000)} min`);
  }

  /** Régénère une IP (nouvelle sticky session) — appelé quand le cooldown expire */
  regenerateSlot(slot: IpSlot): void {
    const newSessionId = `cev_stealth_${slot.index}_${Date.now().toString(36)}`;
    slot.sessionId = newSessionId;
    slot.proxyUrl = this.buildStickyProxy(newSessionId);
    slot.clickTimestamps = [];
    slot.cooldownUntil = 0;
    log("INFO", `IP #${slot.index} régénérée (nouvelle session sticky)`);
  }

  /** Temps avant qu'une IP ne soit à nouveau disponible */
  getNextAvailableIn(): number {
    const now = Date.now();
    let minWait = Infinity;
    
    for (const slot of this.slots) {
      if (slot.cooldownUntil > now) {
        minWait = Math.min(minWait, slot.cooldownUntil - now);
      } else {
        // Purger et vérifier quota
        slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < 60 * 60_000);
        if (slot.clickTimestamps.length < MAX_CLICKS_PER_IP_PER_HOUR) {
          return 0; // Disponible maintenant
        }
        // Quota atteint — calculer quand le plus ancien clic expire
        const oldest = slot.clickTimestamps[0];
        const availableAt = oldest + 60 * 60_000;
        minWait = Math.min(minWait, availableAt - now);
      }
    }
    
    return minWait === Infinity ? 60_000 : minWait;
  }

  /** Stats du pool */
  getStats(): { total: number; available: number; rateLimited: number; totalChecks: number } {
    const now = Date.now();
    let available = 0;
    let rateLimited = 0;
    let totalChecks = 0;
    
    for (const slot of this.slots) {
      totalChecks += slot.totalChecks;
      if (slot.cooldownUntil > now) {
        rateLimited++;
      } else {
        slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < 60 * 60_000);
        if (slot.clickTimestamps.length < MAX_CLICKS_PER_IP_PER_HOUR) {
          available++;
        }
      }
    }
    
    return { total: this.slots.length, available, rateLimited, totalChecks };
  }
}

const ipPool = new CevIpPool();

// ─── State ──────────────────────────────────────────────────────────────────

interface StealthState {
  cycleCount: number;
  totalChecks: number;
  slotsFound: number;
  lastCycleAt: number;
  consecutiveErrors: number;
  isRunning: boolean;
  startedAt: number;
  /** Budget tracking — estimated costs consumed */
  estimatedCaptchaCost: number;
  estimatedProxyMB: number;
}

const state: StealthState = {
  cycleCount: 0,
  totalChecks: 0,
  slotsFound: 0,
  lastCycleAt: 0,
  consecutiveErrors: 0,
  isRunning: false,
  startedAt: 0,
  estimatedCaptchaCost: 0,
  estimatedProxyMB: 0,
};

// ─── Budget Guards (mode observation 48h) ───────────────────────────────────
// S'arrêter automatiquement si on dépasse le budget prévu
const BUDGET_MAX_CAPTCHA_USD = 4.0;   // $4.19 dispo, stop à $4.00 (marge)
const BUDGET_MAX_PROXY_MB = 1900;      // 2048 MB dispo, stop à 1900 MB (marge)
const COST_PER_CAPTCHA_USD = 0.003;    // hCaptcha Proxyless via anti-captcha
const COST_PER_CHECK_PROXY_MB = 1.0;   // ~1 MB par setup complet (conservateur)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [CEV-STEALTH-v2] [${level}] ${msg}`);
}

// ─── Core: un check avec IP spécifique ──────────────────────────────────────

interface CheckResult {
  verdict: "no_slot" | "slot_found" | "error" | "rate_limited";
  sessionCookie?: string;
  integrationUrl?: string;
  validUntilMs?: number;
  error?: string;
}

async function performSingleCheck(
  vowintEmail: string,
  vowintPassword: string,
  applicationId: string,
  ipSlot: IpSlot,
  vowintAppUrl?: string,
): Promise<CheckResult> {
  // Configurer le proxy pour cette requête
  const prevIproyal = process.env.IPROYAL_PROXY_URL;
  process.env.IPROYAL_PROXY_URL = ipSlot.proxyUrl;

  try {
    // NE PAS invalider le cache VOWINT — la session login est réutilisable entre IPs.
    // Seul le GetEAppointmentUrl est sensible à l'IP (compteur 5 clics/h par IP).
    // Le re-login inutile DÉCLENCHE le rate-limit (testé et confirmé 19/05/2026).

    const result = await setupCevSessionHttp(
      vowintEmail,
      vowintPassword,
      applicationId,
      applicationId,
      vowintAppUrl,
    );

    if (!result.success) {
      if (result.error?.includes("RATE_LIMIT")) {
        return { verdict: "rate_limited", error: result.error };
      }
      return { verdict: "error", error: result.error };
    }

    // Enregistrer le clic réussi
    ipPool.recordClick(ipSlot);

    if (result.slotsAvailable) {
      return {
        verdict: "slot_found",
        sessionCookie: result.sessionCookie,
        integrationUrl: result.integrationUrl,
        validUntilMs: result.validUntilMs,
      };
    }

    // Poll API rapide avec le cookie frais
    if (result.sessionCookie) {
      const pollResult = await pollCevSlot(
        result.integrationUrl ?? "",
        result.sessionCookie,
      );
      if (pollResult.status === "slot_found") {
        return {
          verdict: "slot_found",
          sessionCookie: result.sessionCookie,
          integrationUrl: result.integrationUrl,
          validUntilMs: result.validUntilMs,
        };
      }
    }

    return { verdict: "no_slot" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { verdict: "error", error: msg };
  } finally {
    // Restaurer le proxy
    if (prevIproyal) {
      process.env.IPROYAL_PROXY_URL = prevIproyal;
    } else {
      delete process.env.IPROYAL_PROXY_URL;
    }
  }
}

// ─── Booking quand un slot est trouvé ───────────────────────────────────────

async function handleSlotFound(
  sessionCookie: string,
  integrationUrl: string,
  applicationId: string,
): Promise<void> {
  log("INFO", "🚨 SLOT DETECTE — Lancement booking IMMEDIAT...");
  state.slotsFound++;

  botLog({
    applicationId,
    step: "cev_stealth_slot_found",
    status: "ok",
    data: {
      cycleCount: state.cycleCount,
      totalChecks: state.totalChecks,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
    },
  });

  let booked = false;
  let bookedDate: string | undefined;
  let bookedTime: string | undefined;
  let bookedCode: string | undefined;
  let bookedScreenshot: string | undefined;

  // Tentative 1 : HTTP pur (rapide, ~5s)
  log("INFO", "  Tentative booking HTTP...");
  try {
    const httpResult = await bookCevViaHttp(integrationUrl, sessionCookie, applicationId);

    if (httpResult.success) {
      booked = true;
      bookedDate = httpResult.bookedDate;
      bookedTime = httpResult.bookedTime;
      bookedCode = httpResult.confirmationCode;
      log("INFO", `  ✅ BOOKING HTTP REUSSI! code=${bookedCode ?? "N/A"} date=${bookedDate ?? "?"}`);
    } else if (httpResult.needsPlaywright !== false) {
      log("INFO", `  HTTP insuffisant (${httpResult.error}) — fallback Playwright...`);

      const playwrightResult = await bookWithExistingSession(
        integrationUrl,
        sessionCookie,
        applicationId,
      );
      if (playwrightResult.success) {
        booked = true;
        bookedDate = playwrightResult.bookedDate;
        bookedTime = playwrightResult.bookedTime;
        bookedCode = playwrightResult.confirmationCode;
        bookedScreenshot = playwrightResult.screenshotStorageId;
        log("INFO", `  ✅ BOOKING PLAYWRIGHT REUSSI! code=${bookedCode ?? "N/A"} date=${bookedDate ?? "?"}`);
      } else {
        log("ERROR", `  ❌ Playwright echoue: ${playwrightResult.error}`);
      }
    } else {
      log("ERROR", `  ❌ Booking HTTP erreur definitive: ${httpResult.error}`);
    }
  } catch (err) {
    log("ERROR", `  💥 Crash booking: ${err}`);
  }

  if (booked) {
    await reportSlotFound({
      applicationId,
      date: bookedDate ?? "",
      time: bookedTime ?? "",
      location: "CEV - Ambassade de Belgique (Stealth v2 - IP Pool)",
      confirmationCode: bookedCode,
      screenshotStorageId: bookedScreenshot,
    });
    log("INFO", `  📤 Slot rapporté à Convex`);
  }
}

// ─── Loop principal v2 ──────────────────────────────────────────────────────

export async function startCevStealthLoop(): Promise<void> {
  log("INFO", "═══ CEV Stealth Loop v2 — IP Pool Rotatif ═══");

  // Vérifier si le mode stealth est activé
  const stealthEnabled = await getBotConfigValue("cev_stealth_mode");
  if (stealthEnabled !== "1") {
    log("INFO", "Mode stealth desactivé (cev_stealth_mode != 1) — attente activation...");
    while (true) {
      await sleep(60_000);
      const check = await getBotConfigValue("cev_stealth_mode");
      if (check === "1") {
        log("INFO", "Mode stealth activé par admin → démarrage!");
        break;
      }
    }
  }

  // Charger la config dynamique depuis Convex
  try {
    const poolSizeStr = await getBotConfigValue("cev_stealth_pool_size");
    if (poolSizeStr) POOL_SIZE = Math.max(2, Math.min(30, parseInt(poolSizeStr, 10) || 8));
    
    const checksStr = await getBotConfigValue("cev_stealth_checks_per_cycle");
    if (checksStr) CHECKS_PER_CYCLE = Math.max(1, Math.min(10, parseInt(checksStr, 10) || 4));
    
    const pauseStr = await getBotConfigValue("cev_stealth_pause_between_checks");
    if (pauseStr) INTER_CHECK_DELAY_MS = Math.max(5, parseInt(pauseStr, 10) || 20) * 1000;
  } catch { /* defaults */ }

  // Initialiser le pool d'IPs
  ipPool.initialize(POOL_SIZE);

  log("INFO", `Config: pool=${POOL_SIZE} IPs, ${CHECKS_PER_CYCLE} checks/cycle, ${INTER_CHECK_DELAY_MS / 1000}s entre checks`);
  log("INFO", `Débit théorique: ${POOL_SIZE * MAX_CLICKS_PER_IP_PER_HOUR} checks/heure (${POOL_SIZE} IPs × ${MAX_CLICKS_PER_IP_PER_HOUR} clics/IP)`);
  log("INFO", `Coût estimé 48h: ~$${((POOL_SIZE * MAX_CLICKS_PER_IP_PER_HOUR * 48 * 0.003)).toFixed(2)} captcha + ~${Math.round(POOL_SIZE * MAX_CLICKS_PER_IP_PER_HOUR * 48)} MB proxy`);
  log("INFO", `Mode OBSERVATION 48h: budget 2GB iProyal + $4.19 anti-captcha`);

  await sleep(INITIAL_DELAY_MS);

  state.isRunning = true;
  state.startedAt = Date.now();

  while (state.isRunning) {
    try {
      // Re-vérifier le mode toutes les 20 cycles
      if (state.cycleCount > 0 && state.cycleCount % 20 === 0) {
        const stillEnabled = await getBotConfigValue("cev_stealth_mode");
        if (stillEnabled !== "1") {
          log("INFO", "Mode stealth désactivé par admin → arrêt loop");
          state.isRunning = false;
          break;
        }
        // Recharger la config dynamique
        try {
          const poolSizeStr = await getBotConfigValue("cev_stealth_pool_size");
          if (poolSizeStr) {
            const newSize = Math.max(2, Math.min(30, parseInt(poolSizeStr, 10) || 8));
            if (newSize !== POOL_SIZE) {
              POOL_SIZE = newSize;
              ipPool.initialize(POOL_SIZE);
              log("INFO", `Pool redimensionné: ${POOL_SIZE} IPs`);
            }
          }
        } catch { /* ignore */ }
      }

      // Récupérer les credentials VOWINT
      const pendingSetups = await getPendingCevSetups();
      const target = pendingSetups.find(s => s.vowintEmail && s.vowintPassword);

      if (!target) {
        if (state.cycleCount === 0) {
          log("WARN", "Aucune session CEV avec credentials VOWINT — attente...");
        }
        await sleep(30_000);
        continue;
      }

      // ══════════════════════════════════════════════════════════════════════
      // OBTENIR UNE IP DISPONIBLE
      // ══════════════════════════════════════════════════════════════════════
      const ipSlot = ipPool.getNextAvailable();
      
      if (!ipSlot) {
        // Toutes les IPs sont épuisées — attendre la prochaine disponible
        const waitMs = ipPool.getNextAvailableIn();
        const waitMin = Math.ceil(waitMs / 60_000);
        const stats = ipPool.getStats();
        log("INFO", `⏳ Pool épuisé (${stats.rateLimited} rate-limited, 0 available) — attente ${waitMin} min`);
        await sleep(Math.min(waitMs + 5000, 5 * 60_000)); // Max 5 min d'attente
        continue;
      }

      // ══════════════════════════════════════════════════════════════════════
      // CYCLE : N checks avec cette IP
      // ══════════════════════════════════════════════════════════════════════
      state.cycleCount++;
      state.lastCycleAt = Date.now();

      const stats = ipPool.getStats();
      log("INFO", `═══ Cycle #${state.cycleCount} ═══ IP#${ipSlot.index} | Pool: ${stats.available}/${stats.total} dispo | Total: ${state.totalChecks} checks, ${state.slotsFound} slots`);

      let rateLimitedThisCycle = false;

      for (let i = 0; i < CHECKS_PER_CYCLE; i++) {
        const checkNum = i + 1;
        
        // Vérifier que l'IP a encore du quota
        const now = Date.now();
        ipSlot.clickTimestamps = ipSlot.clickTimestamps.filter(t => now - t < 60 * 60_000);
        if (ipSlot.clickTimestamps.length >= MAX_CLICKS_PER_IP_PER_HOUR) {
          log("INFO", `  IP#${ipSlot.index} quota atteint (${ipSlot.clickTimestamps.length}/${MAX_CLICKS_PER_IP_PER_HOUR}) → rotation`);
          break;
        }

        log("INFO", `  Check ${checkNum}/${CHECKS_PER_CYCLE} (IP#${ipSlot.index}, clics: ${ipSlot.clickTimestamps.length}/${MAX_CLICKS_PER_IP_PER_HOUR})...`);

        const check = await performSingleCheck(
          target.vowintEmail!,
          target.vowintPassword!,
          target.applicationId,
          ipSlot,
          target.vowintAppUrl,
        );

        state.totalChecks++;

        // ── Budget tracking ──────────────────────────────────────────────────
        state.estimatedCaptchaCost += COST_PER_CAPTCHA_USD;
        state.estimatedProxyMB += COST_PER_CHECK_PROXY_MB;

        // Budget guard — arrêt automatique si on approche des limites
        if (state.estimatedCaptchaCost >= BUDGET_MAX_CAPTCHA_USD) {
          log("ERROR", `💰 BUDGET CAPTCHA ÉPUISÉ: $${state.estimatedCaptchaCost.toFixed(2)} ≥ $${BUDGET_MAX_CAPTCHA_USD} — ARRÊT AUTOMATIQUE`);
          botLog({
            applicationId: target.applicationId,
            step: "cev_stealth_budget_exhausted",
            status: "fail",
            data: { reason: "captcha", spent: state.estimatedCaptchaCost, limit: BUDGET_MAX_CAPTCHA_USD, totalChecks: state.totalChecks },
          });
          state.isRunning = false;
          break;
        }
        if (state.estimatedProxyMB >= BUDGET_MAX_PROXY_MB) {
          log("ERROR", `💰 BUDGET PROXY ÉPUISÉ: ${Math.round(state.estimatedProxyMB)} MB ≥ ${BUDGET_MAX_PROXY_MB} MB — ARRÊT AUTOMATIQUE`);
          botLog({
            applicationId: target.applicationId,
            step: "cev_stealth_budget_exhausted",
            status: "fail",
            data: { reason: "proxy", spent: state.estimatedProxyMB, limit: BUDGET_MAX_PROXY_MB, totalChecks: state.totalChecks },
          });
          state.isRunning = false;
          break;
        }

        if (check.verdict === "slot_found") {
          log("INFO", `  🚨 SLOT TROUVÉ au check ${checkNum}!`);
          await recordCevSessionCheck(target.sessionId, "slot_found");
          await handleSlotFound(
            check.sessionCookie!,
            check.integrationUrl!,
            target.applicationId,
          );
          state.consecutiveErrors = 0;
          break;
        }

        if (check.verdict === "rate_limited") {
          log("WARN", `  ⚡ Rate-limit IP#${ipSlot.index} — rotation immédiate`);
          ipPool.markRateLimited(ipSlot);
          rateLimitedThisCycle = true;
          state.consecutiveErrors = 0; // Rate-limit n'est PAS une erreur — c'est normal
          break; // Sortir du cycle, prochaine itération = nouvelle IP
        }

        if (check.verdict === "error") {
          log("WARN", `  ❌ Erreur check ${checkNum}: ${check.error}`);
          state.consecutiveErrors++;
          if (check.error?.includes("LOGIN") || check.error?.includes("CSRF")) {
            break;
          }
          // Erreur non-fatale → continuer
        }

        if (check.verdict === "no_slot") {
          state.consecutiveErrors = 0;
          log("INFO", `  Check ${checkNum}: pas de créneau`);
        }

        // Pause entre les checks
        if (i < CHECKS_PER_CYCLE - 1) {
          const pause = randomBetween(INTER_CHECK_DELAY_MS * 0.8, INTER_CHECK_DELAY_MS * 1.2);
          await sleep(pause);
        }
      }

      // Rapporter no_slot à Convex (si pas de rate-limit ni slot)
      if (!rateLimitedThisCycle && state.slotsFound === 0) {
        await recordCevSessionCheck(target.sessionId, "no_slot").catch(() => {});
      }

      // Stats périodiques
      if (state.cycleCount % 25 === 0) {
        const poolStats = ipPool.getStats();
        const uptimeMin = Math.round((Date.now() - state.startedAt) / 60_000);
        const checksPerHour = uptimeMin > 0 ? Math.round(state.totalChecks / (uptimeMin / 60)) : 0;
        const captchaPct = Math.round((state.estimatedCaptchaCost / BUDGET_MAX_CAPTCHA_USD) * 100);
        const proxyPct = Math.round((state.estimatedProxyMB / BUDGET_MAX_PROXY_MB) * 100);
        const remainingHours = uptimeMin > 0 
          ? Math.round(((BUDGET_MAX_CAPTCHA_USD - state.estimatedCaptchaCost) / (state.estimatedCaptchaCost / (uptimeMin / 60))) * 10) / 10
          : 48;
        log("INFO", `  📊 Stats: ${state.totalChecks} checks en ${uptimeMin} min (${checksPerHour}/h) | Pool: ${poolStats.available}/${poolStats.total} dispo, ${poolStats.rateLimited} cooldown | Slots: ${state.slotsFound}`);
        log("INFO", `  💰 Budget: captcha $${state.estimatedCaptchaCost.toFixed(2)}/$${BUDGET_MAX_CAPTCHA_USD} (${captchaPct}%) | proxy ${Math.round(state.estimatedProxyMB)}/${BUDGET_MAX_PROXY_MB} MB (${proxyPct}%) | ETA restant: ~${remainingHours}h`);
        botLog({
          applicationId: target.applicationId,
          step: "cev_stealth_v2_stats",
          status: "ok",
          data: {
            cycleCount: state.cycleCount,
            totalChecks: state.totalChecks,
            checksPerHour,
            slotsFound: state.slotsFound,
            uptimeMin,
            poolAvailable: poolStats.available,
            poolTotal: poolStats.total,
            poolRateLimited: poolStats.rateLimited,
            budgetCaptchaUsed: state.estimatedCaptchaCost,
            budgetCaptchaMax: BUDGET_MAX_CAPTCHA_USD,
            budgetProxyUsedMB: state.estimatedProxyMB,
            budgetProxyMaxMB: BUDGET_MAX_PROXY_MB,
            estimatedRemainingHours: remainingHours,
          },
        });
      }

      // Gestion erreurs consécutives
      if (state.consecutiveErrors >= 10) {
        log("ERROR", `  10 erreurs consécutives — pause 5 min`);
        botLog({
          applicationId: target.applicationId,
          step: "cev_stealth_v2_errors",
          status: "fail",
          data: { errors: state.consecutiveErrors },
        });
        await sleep(5 * 60_000);
        state.consecutiveErrors = 0;
        continue;
      }

      // ══════════════════════════════════════════════════════════════════════
      // PAUSE COURTE entre cycles (on change d'IP → pas besoin d'attendre)
      // ══════════════════════════════════════════════════════════════════════
      if (rateLimitedThisCycle) {
        // Rate-limit → pas de pause, rotation immédiate vers prochaine IP
        log("INFO", `  ⚡ Rotation immédiate vers prochaine IP...`);
        await sleep(2_000); // Juste 2s pour éviter un burst
      } else {
        // Cycle normal terminé → petite pause humaine
        const pauseMs = randomBetween(CYCLE_PAUSE_MIN_MS, CYCLE_PAUSE_MAX_MS);
        await sleep(pauseMs);
      }

    } catch (loopErr) {
      log("ERROR", `Erreur loop: ${loopErr}`);
      state.consecutiveErrors++;
      await sleep(30_000);
    }
  }

  log("INFO", "═══ CEV Stealth Loop v2 arrêté ═══");
}

/** Expose l'état pour monitoring */
export function getCevStealthState(): Readonly<StealthState> & { pool: ReturnType<CevIpPool["getStats"]> } {
  return { ...state, pool: ipPool.getStats() };
}
