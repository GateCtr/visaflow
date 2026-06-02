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

import { setupCevSessionHttp, invalidateVowintCache } from "../cevHttpSetup.js";
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
} from "../cev-shared-impit.js";
import {
  getPendingCevSetups,
  getActiveCevSessions,
  getCevCredentials,
  recordCevSessionCheck,
  reportSlotFound,
  botLog,
  getBotConfigValue,
} from "../convexClient.js";
import {
  initCevRedis,
  syncPoolStateToRedis,
  restorePoolStateFromRedis,
  type SerializablePoolState,
} from "../cev-redis-persistence.js";
import { recordScan, recordSlotFound, recordRateLimit, recordRelogin, recordPause } from "../daily-stats.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const MAX_CLICKS_PER_SESSION = 4; // Limite GLOBALE par session VOWINT (serveur bloque au 5ème)
const MAX_CLICKS_PER_DOSSIER_PER_HOUR = 4; // Limite par dossier par heure (pour éviter rate-limit)
const CLICK_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const DEFAULT_INTERVAL_SEC = 225; // Pause par défaut entre scans (3 min 45 s)

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
}

class CevDossierPool {
  private slots: DossierSlot[] = [];
  private currentIndex = 0;

  /** Initialise le pool avec les numéros VOWINT */
  initialize(vowintRefs: string[]): void {
    this.slots = vowintRefs.map((ref, i) => ({
      index: i,
      vowintRef: ref.trim().toUpperCase(),
      clickTimestamps: [],
      totalScans: 0,
      rateLimitCount: 0,
    }));
    this.currentIndex = 0;
    log("INFO", `Pool initialisé: ${this.slots.length} dossiers`);
    this.slots.forEach((s, i) => log("INFO", `  #${i}: ${s.vowintRef}`));
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
          log("INFO", `  ⏸️ #${slot.index} ${slot.vowintRef} en PAUSE (slot trouvé) — skip`);
          continue;
        }
        this.currentIndex = (idx + 1) % this.slots.length;
        return slot;
      }

      // Dossier épuisé — loguer le skip
      if (attempts === 0 || this.slots.length <= 3) {
        const oldestClick = slot.clickTimestamps[0];
        const availableInMin = Math.ceil((oldestClick + CLICK_WINDOW_MS - now) / 60_000);
        log("INFO", `  ⏭️ #${slot.index} ${slot.vowintRef} épuisé (${slot.clickTimestamps.length}/${MAX_CLICKS_PER_DOSSIER_PER_HOUR}) — dispo dans ${availableInMin}min`);
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
    log("WARN", `Dossier #${slot.index} ${slot.vowintRef} rate-limité (${slot.rateLimitCount}x)`);
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
      })),
      savedAt: Date.now(),
    };
  }

  /** Restaure l'état depuis Redis (merge avec les dossiers configurés) */
  restoreState(saved: SerializablePoolState): void {
    // Créer un index rapide par vowintRef
    const savedMap = new Map(saved.slots.map(s => [s.vowintRef, s]));

    for (const slot of this.slots) {
      const savedSlot = savedMap.get(slot.vowintRef);
      if (savedSlot) {
        slot.clickTimestamps = savedSlot.clickTimestamps;
        slot.totalScans = savedSlot.totalScans;
        slot.rateLimitCount = savedSlot.rateLimitCount;
      }
    }

    // Restaurer currentIndex seulement s'il est valide
    if (saved.currentIndex >= 0 && saved.currentIndex < this.slots.length) {
      this.currentIndex = saved.currentIndex;
    }

    log("INFO", `Pool restauré depuis Redis (index=${this.currentIndex})`);
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

const pool = new CevDossierPool();

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [CEV-DOSSIER-v3] [${level}] ${msg}`);
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
): Promise<ScanResult> {

  try {
    const result = await setupCevSessionHttp(
      vowintEmail,
      vowintPassword,
      applicationId,
      applicationId,
      dossier.vowintRef, // Le numéro VOWINT sera résolu via MyList
    );

    if (!result.success) {
      if (result.error?.includes("RATE_LIMIT")) {
        pool.markRateLimited(dossier);
        return { status: "rate_limited" };
      }
      log("WARN", `  Erreur setup: ${result.error}`);
      return { status: "error" };
    }

    // Clic réussi — enregistrer
    pool.recordClick(dossier);
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `  Exception: ${msg.slice(0, 100)}`);
    return { status: "error" };
  }
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
): Promise<void> {
  log("INFO", `🚨 SLOT DÉTECTÉ sur dossier #${dossier.index} ${dossier.vowintRef} — DISCOVERY + BOOKING`);
  state.slotsFound++;

  // ── PAUSE immédiate du dossier (ne plus le re-scanner) ──
  pausedDossiers.add(dossier.vowintRef);
  log("INFO", `  ⏸️ Dossier #${dossier.index} ${dossier.vowintRef} mis en PAUSE`);

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
    log("INFO", `  🔬 Discovery avec session existante (pas de re-login)...`);

    const discovery = await discoverSlotBookingFlow(
      sessionCookie,
      integrationUrl,
      dossier.vowintRef,
      applicationId,
    );

    // Envoyer email admin
    log("INFO", `  📧 Envoi email admin...`);
    await sendSlotDetectedEmail(dossier.vowintRef, discovery);

    // Tenter le booking HTTP avec la session existante
    log("INFO", `  🎯 Tentative booking HTTP avec session existante...`);
    try {
      const httpResult = await bookCevViaHttp(integrationUrl, sessionCookie, applicationId);
      if (httpResult.success) {
        log("INFO", `  ✅ BOOKING RÉUSSI! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
        await reportSlotFound({
          applicationId,
          date: httpResult.bookedDate ?? "",
          time: httpResult.bookedTime ?? "",
          location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
          confirmationCode: httpResult.confirmationCode,
        });
        return;
      }
      log("INFO", `  ⚠️ Booking HTTP échoué: ${httpResult.error} — tentative avec re-login...`);
    } catch (err) {
      log("WARN", `  ⚠️ Booking HTTP crash: ${err} — tentative avec re-login...`);
    }
  }

  // ── FALLBACK : re-login + nouveau setup (si session existante a échoué) ──
  log("INFO", `  🔄 Re-login pour tentative fallback...`);
  const session = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    applicationId,
    applicationId,
    dossier.vowintRef,
  );

  if (!session.success || !session.sessionCookie || !session.integrationUrl) {
    log("ERROR", `  Session re-setup échoué pour booking fallback`);
    return;
  }

  // Tentative booking HTTP avec session fraîche
  try {
    const httpResult = await bookCevViaHttp(session.integrationUrl, session.sessionCookie, applicationId);
    if (httpResult.success) {
      log("INFO", `  ✅ BOOKING RÉUSSI (re-login)! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
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
    log("INFO", `  HTTP insuffisant — fallback Playwright...`);
    const pwResult = await bookWithExistingSession(
      session.integrationUrl,
      session.sessionCookie,
      applicationId,
    );
    if (pwResult.success) {
      log("INFO", `  ✅ BOOKING PLAYWRIGHT RÉUSSI! code=${pwResult.confirmationCode}`);
      await reportSlotFound({
        applicationId,
        date: pwResult.bookedDate ?? "",
        time: pwResult.bookedTime ?? "",
        location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
        confirmationCode: pwResult.confirmationCode,
        screenshotStorageId: pwResult.screenshotStorageId,
      });
    } else {
      log("ERROR", `  ❌ Booking échoué: ${pwResult.error}`);
    }
  } catch (err) {
    log("ERROR", `  💥 Crash booking: ${err}`);
  }
}

// ─── Loop Principal v3 ──────────────────────────────────────────────────────

export async function startCevDossierLoop(): Promise<void> {
  log("INFO", "═══ CEV Dossier Loop v3 — Pool de Dossiers ═══");

  // Vérifier si le mode est activé
  const enabled = await getBotConfigValue("cev_dossier_mode");
  if (enabled !== "1") {
    log("INFO", "Mode dossier désactivé (cev_dossier_mode != 1) — attente...");
    while (true) {
      await sleep(60_000);
      const check = await getBotConfigValue("cev_dossier_mode");
      if (check === "1") {
        log("INFO", "Mode dossier activé → démarrage!");
        break;
      }
    }
  }

  // Charger la liste de dossiers
  const dossierPoolStr = await getBotConfigValue("cev_dossier_pool");
  if (!dossierPoolStr || !dossierPoolStr.trim()) {
    log("ERROR", "cev_dossier_pool non configuré! Format: VOWINT6085888,VOWINT6085889,...");
    log("ERROR", "Attente configuration...");
    while (true) {
      await sleep(30_000);
      const check = await getBotConfigValue("cev_dossier_pool");
      if (check && check.trim()) {
        pool.initialize(check.split(",").map(s => s.trim()).filter(Boolean));
        break;
      }
    }
  } else {
    pool.initialize(dossierPoolStr.split(",").map(s => s.trim()).filter(Boolean));
  }

  // ─── Redis: restaurer l'état du pool ────────────────────────────────────────
  await initCevRedis();
  const savedPoolState = await restorePoolStateFromRedis();
  if (savedPoolState) {
    pool.restoreState(savedPoolState);
    log("INFO", `Pool state restauré depuis Redis — reprend à index=${savedPoolState.currentIndex}`);
  } else {
    log("INFO", "Pas de pool state en Redis — démarrage frais");
  }

  // Calculer l'intervalle optimal
  const intervalStr = await getBotConfigValue("cev_dossier_interval_sec");
  const configuredInterval = intervalStr ? parseInt(intervalStr, 10) : 0;
  const intervalMs = (configuredInterval > 0 ? configuredInterval : DEFAULT_INTERVAL_SEC) * 1000;

  log("INFO", `Config:`);
  log("INFO", `  • Dossiers: ${pool.size}`);
  log("INFO", `  • Clics/h total: ${pool.size * MAX_CLICKS_PER_DOSSIER_PER_HOUR}`);
  log("INFO", `  • Intervalle: ${Math.round(intervalMs / 1000)}s (1 scan toutes les ${Math.round(intervalMs / 1000)}s)`);
  log("INFO", `  • Proxy: SOAX (1 IP fixe Kinshasa)`);

  // ─── Configure SOAX proxy ─────────────────────────────────────────────────
  // cevImpitFetch() reads process.env.IPROYAL_PROXY_URL as the proxy to use.
  // We override it with the SOAX sticky URL so all requests go through SOAX.
  // (iProyal account expired/402 — SOAX is the active provider)
  const soaxBaseUrl = process.env.SOAX_PROXY_URL;
  let proxyExitIp: string | null = null;
  if (soaxBaseUrl) {
    const soaxStickyUrl = makeCevProxyStickyUrl("soax", undefined, "cev-dossier-v3");
    process.env.IPROYAL_PROXY_URL = soaxStickyUrl;
    resetCevImpitInstances(); // Force impit to recreate with new proxy URL
    log("INFO", `  • SOAX proxy configuré: ${soaxStickyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}…`);
    // Effectuer un health check pour récupérer l'IP de sortie et initialiser le guard
    proxyExitIp = await initCevProxyGuardWithExitIp(soaxStickyUrl, "cev-dossier-v3");
  } else if (process.env.IPROYAL_PROXY_URL) {
    // Si on utilise iProyal, aussi initialiser le guard
    proxyExitIp = await initCevProxyGuardWithExitIp(process.env.IPROYAL_PROXY_URL, "cev-dossier-v3");
  } else {
    log("WARN", `  ⚠️ AUCUN PROXY (SOAX_PROXY_URL et IPROYAL_PROXY_URL absents) — connexion directe`);
  }

  // Récupérer les credentials VOWINT via /hunter/cev-credentials (lecture sans lock)
  const creds = await getCevCredentials();
  let vowintEmail = creds?.vowintEmail;
  let vowintPassword = creds?.vowintPassword;
  // applicationId pour les botLogs — celui de l'application Convex associée à la session CEV
  const logApplicationId = creds?.applicationId ?? "cev-dossier-v3";

  if (!vowintEmail || !vowintPassword) {
    // Fallback: sessions actives (peut être lockée mais on tente)
    const allSessions = await getActiveCevSessions();
    const target = allSessions.find((s: any) => s.vowintEmail && s.vowintPassword);
    if (target) {
      vowintEmail = target.vowintEmail;
      vowintPassword = target.vowintPassword;
    }
  }

  if (!vowintEmail || !vowintPassword) {
    const pendingSetups = await getPendingCevSetups();
    const pending = pendingSetups.find(s => s.vowintEmail && s.vowintPassword);
    if (pending) {
      vowintEmail = pending.vowintEmail!;
      vowintPassword = pending.vowintPassword!;
    }
  }

  if (!vowintEmail || !vowintPassword) {
    log("ERROR", "Aucun compte VOWINT configuré — créer une session CEV avec vowintEmail/vowintPassword dans Convex");
    log("ERROR", "Attente credentials...");
    while (true) {
      await sleep(30_000);
      const retry = await getCevCredentials();
      if (retry) { vowintEmail = retry.vowintEmail; vowintPassword = retry.vowintPassword; break; }
      const sessions = await getActiveCevSessions();
      const t = sessions.find((s: any) => s.vowintEmail && s.vowintPassword);
      if (t) { vowintEmail = t.vowintEmail; vowintPassword = t.vowintPassword; break; }
    }
  }

  log("INFO", `Credentials VOWINT: ${vowintEmail!.slice(0, 5)}…`);

  state.isRunning = true;
  state.startedAt = Date.now();

  while (state.isRunning) {
    try {
      // Re-check mode toutes les 50 scans
      if (state.scanCount > 0 && state.scanCount % 50 === 0) {
        const stillEnabled = await getBotConfigValue("cev_dossier_mode");
        if (stillEnabled !== "1") {
          log("INFO", "Mode dossier désactivé → arrêt");
          state.isRunning = false;
          break;
        }
      }

      // ─── Check stop signal (permet d'arrêter même en config automatique) ───
      if (state.scanCount > 0 && state.scanCount % 10 === 0) {
        const stopSignal = await getBotConfigValue("cev_session_stop");
        if (stopSignal === "1") {
          log("INFO", "🛑 Signal d'arrêt reçu (cev_session_stop=1) → arrêt gracieux");
          state.isRunning = false;
          break;
        }
      }

      // Récupérer le prochain dossier disponible
      const dossier = pool.getNextAvailable();
      if (!dossier) {
        const waitMs = pool.getNextAvailableIn();
        const waitMin = Math.ceil(waitMs / 60_000);
        const stats = pool.getStats();
        log("INFO", `⏳ Tous les dossiers épuisés (${stats.exhausted}/${stats.total}) — attente ${waitMin} min`);
        // Attente réduite: max 2 min au lieu de 5 min
        await sleep(Math.min(waitMs + 5000, 2 * 60_000));
        continue;
      }

      // Utiliser les credentials chargés au démarrage
      if (!vowintEmail || !vowintPassword) {
        log("WARN", "Credentials VOWINT introuvables — attente 30s");
        await sleep(30_000);
        continue;
      }

      // Scan
      state.scanCount++;
      const stats = pool.getStats();

      // ─── Intervalle DYNAMIQUE basé sur les dossiers réellement actifs ──────
      // Si des dossiers sont rate-limités/pausés, les restants doivent espacer
      // leurs clics pour ne pas dépasser 4/h chacun.
      // Formula: 3600s / (dossiers_actifs × 4 clics/h) = intervalle minimum
      // Réduit: on accepte un rythme plus agressif (closer to rate limit)
      const activeDossiers = stats.available - pausedDossiers.size;
      const dynamicIntervalMs = activeDossiers > 0
        ? Math.ceil((3600 / (activeDossiers * MAX_CLICKS_PER_DOSSIER_PER_HOUR)) * 1000 * 0.6) // 60% du max théorique
        : intervalMs;
      // Utiliser le max entre l'intervalle configuré et le dynamique
      const effectiveIntervalMs = Math.max(intervalMs, dynamicIntervalMs);

      log("INFO", `[Scan #${state.scanCount}] Dossier: #${dossier.index} ${dossier.vowintRef} | Dispo: ${stats.available}/${stats.total} | Total: ${stats.totalScans} scans`);

      const result = await performScan(
        vowintEmail!,
        vowintPassword!,
        dossier,
        logApplicationId,
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
          log("INFO", `  🚨 SLOT TROUVÉ!`);
          recordScan(uniqueJobId, dossier.vowintRef);
          recordSlotFound(uniqueJobId, dossier.vowintRef);
          // Re-login préventif si on atteint la limite (avant le booking)
          if (globalSessionClicks >= MAX_CLICKS_PER_SESSION) {
            log("INFO", `  🔄 Session VOWINT: ${globalSessionClicks}/${MAX_CLICKS_PER_SESSION} clics — re-login préventif`);
            invalidateVowintCache(vowintEmail!);
            globalSessionClicks = 0;
            recordRelogin(uniqueJobId, dossier.vowintRef, "preventive");
          }
          await handleSlotFound(
            vowintEmail!, vowintPassword!, dossier, logApplicationId,
            result.sessionCookie, result.integrationUrl,
          );
          break;
        case "rate_limited":
          state.rateLimits++;
          recordScan(uniqueJobId, dossier.vowintRef);
          recordRateLimit(uniqueJobId, dossier.vowintRef, "CEV 5 clics/h");
          // Le rate-limit vient du serveur → session grillée, reset le compteur
          globalSessionClicks = 0;
          log("WARN", `  ⚡ Rate-limit sur #${dossier.index} ${dossier.vowintRef} — rotation vers prochain dossier`);
          break;
        case "no_slot":
          log("INFO", `  — Pas de créneau`);
          recordScan(uniqueJobId, dossier.vowintRef);
          // Re-login préventif après MAX_CLICKS_PER_SESSION clics GLOBAUX
          if (globalSessionClicks >= MAX_CLICKS_PER_SESSION) {
            log("INFO", `  🔄 Session VOWINT: ${globalSessionClicks}/${MAX_CLICKS_PER_SESSION} clics — re-login préventif`);
            invalidateVowintCache(vowintEmail!);
            globalSessionClicks = 0;
            recordRelogin(uniqueJobId, dossier.vowintRef, "preventive");
          }
          break;
        case "error":
          state.errors++;
          recordScan(uniqueJobId, dossier.vowintRef);
          break;
      }

      // Stats périodiques
      if (state.scanCount % 25 === 0) {
        const uptimeMin = Math.round((Date.now() - state.startedAt) / 60_000);
        const scansPerHour = uptimeMin > 0 ? Math.round(state.scanCount / (uptimeMin / 60)) : 0;
        const poolStats = pool.getStats();
        log("INFO", `📊 Stats: ${state.scanCount} scans en ${uptimeMin}min (${scansPerHour}/h) | Slots: ${state.slotsFound} | RL: ${state.rateLimits} | Pool: ${poolStats.available}/${poolStats.total}`);
        botLog({
          applicationId: logApplicationId,
          step: "cev_dossier_v3_stats",
          status: "ok",
          data: { scanCount: state.scanCount, slotsFound: state.slotsFound, rateLimits: state.rateLimits, scansPerHour, uptimeMin },
        });
      }

      // ─── Sync pool state vers Redis (fire-and-forget, chaque scan) ──────────
      syncPoolStateToRedis(pool.exportState());

      // Pause entre les scans (intervalle dynamique)
      // Jitter réduit à ±10% 
      const jitter = effectiveIntervalMs * 0.1 * (Math.random() * 2 - 1);
      await sleep(effectiveIntervalMs + jitter);

    } catch (loopErr) {
      log("ERROR", `Erreur loop: ${loopErr}`);
      state.errors++;
      await sleep(10_000); // Réduit de 30s → 10s
    }
  }

  log("INFO", "═══ CEV Dossier Loop v3 arrêté ═══");
}

/** Expose l'état pour monitoring */
export function getCevDossierState() {
  return { ...state, pool: pool.getStats() };
}
