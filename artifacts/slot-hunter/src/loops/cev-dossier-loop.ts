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

// ─── Configuration ──────────────────────────────────────────────────────────

const MAX_CLICKS_PER_DOSSIER_PER_HOUR = 4; // Marge sécurité (limite serveur = 5)
const CLICK_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const DEFAULT_INTERVAL_SEC = 30; // Pause par défaut entre scans

// ─── Dossier Slot (état de chaque dossier) ──────────────────────────────────

interface DossierSlot {
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
    this.slots = vowintRefs.map(ref => ({
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
        this.currentIndex = (idx + 1) % this.slots.length;
        return slot;
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
    log("WARN", `Dossier ${slot.vowintRef} rate-limité (${slot.rateLimitCount}x)`);
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

async function performScan(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
  applicationId: string,
): Promise<"no_slot" | "slot_found" | "rate_limited" | "error"> {

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
        return "rate_limited";
      }
      log("WARN", `  Erreur setup: ${result.error}`);
      return "error";
    }

    // Clic réussi — enregistrer
    pool.recordClick(dossier);

    if (result.slotsAvailable) {
      return "slot_found";
    }

    // Poll rapide si on a un cookie de session
    if (result.sessionCookie) {
      const pollResult = await pollCevSlot(
        result.integrationUrl ?? "",
        result.sessionCookie,
      );
      if (pollResult.status === "slot_found") {
        return "slot_found";
      }
    }

    return "no_slot";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `  Exception: ${msg.slice(0, 100)}`);
    return "error";
  }
}

// ─── Booking ────────────────────────────────────────────────────────────────

async function handleSlotFound(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
  applicationId: string,
): Promise<void> {
  log("INFO", `🚨 SLOT DÉTECTÉ sur dossier ${dossier.vowintRef} — BOOKING IMMÉDIAT`);
  state.slotsFound++;

  botLog({
    applicationId,
    step: "cev_dossier_slot_found",
    status: "ok",
    data: {
      dossier: dossier.vowintRef,
      scanCount: state.scanCount,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
    },
  });

  // Re-setup pour obtenir la session fraîche + booking
  const session = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    applicationId,
    applicationId,
    dossier.vowintRef,
  );

  if (!session.success || !session.sessionCookie || !session.integrationUrl) {
    log("ERROR", `  Session re-setup échoué pour booking`);
    return;
  }

  // Tentative booking HTTP
  try {
    const httpResult = await bookCevViaHttp(session.integrationUrl, session.sessionCookie, applicationId);
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

  // Calculer l'intervalle optimal
  const intervalStr = await getBotConfigValue("cev_dossier_interval_sec");
  const configuredInterval = intervalStr ? parseInt(intervalStr, 10) : 0;
  // Auto-calcul: 60 min ÷ (dossiers × 5 clics/h) = intervalle en minutes
  const autoIntervalSec = Math.ceil((60 * 60) / (pool.size * MAX_CLICKS_PER_DOSSIER_PER_HOUR));
  const intervalMs = (configuredInterval > 0 ? configuredInterval : autoIntervalSec) * 1000;

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
  if (soaxBaseUrl) {
    const soaxStickyUrl = makeCevProxyStickyUrl("soax", undefined, "cev-dossier-v3");
    process.env.IPROYAL_PROXY_URL = soaxStickyUrl;
    resetCevImpitInstances(); // Force impit to recreate with new proxy URL
    log("INFO", `  • SOAX proxy configuré: ${soaxStickyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}…`);
  } else if (!process.env.IPROYAL_PROXY_URL) {
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

      // Récupérer le prochain dossier disponible
      const dossier = pool.getNextAvailable();
      if (!dossier) {
        const waitMs = pool.getNextAvailableIn();
        const waitMin = Math.ceil(waitMs / 60_000);
        const stats = pool.getStats();
        log("INFO", `⏳ Tous les dossiers épuisés (${stats.exhausted}/${stats.total}) — attente ${waitMin} min`);
        await sleep(Math.min(waitMs + 5000, 5 * 60_000));
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
      const clicsRestants = (pool.size * MAX_CLICKS_PER_DOSSIER_PER_HOUR) - (stats.totalScans % (pool.size * MAX_CLICKS_PER_DOSSIER_PER_HOUR));
      log("INFO", `[Scan #${state.scanCount}] Dossier: ${dossier.vowintRef} | Dispo: ${stats.available}/${stats.total} | Total: ${stats.totalScans} scans`);

      const result = await performScan(
        vowintEmail!,
        vowintPassword!,
        dossier,
        logApplicationId,
      );

      switch (result) {
        case "slot_found":
          log("INFO", `  🚨 SLOT TROUVÉ!`);
          await handleSlotFound(vowintEmail!, vowintPassword!, dossier, logApplicationId);
          break;
        case "rate_limited":
          state.rateLimits++;
          log("WARN", `  ⚡ Rate-limit sur ${dossier.vowintRef} — rotation vers prochain dossier`);
          break;
        case "no_slot":
          log("INFO", `  — Pas de créneau`);
          break;
        case "error":
          state.errors++;
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

      // Pause entre les scans
      // Ajouter un jitter de ±20% pour paraître humain
      const jitter = intervalMs * 0.2 * (Math.random() * 2 - 1);
      await sleep(intervalMs + jitter);

    } catch (loopErr) {
      log("ERROR", `Erreur loop: ${loopErr}`);
      state.errors++;
      await sleep(30_000);
    }
  }

  log("INFO", "═══ CEV Dossier Loop v3 arrêté ═══");
}

/** Expose l'état pour monitoring */
export function getCevDossierState() {
  return { ...state, pool: pool.getStats() };
}
