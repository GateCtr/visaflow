/**
 * CEV Dossier Loop v3 — Pool de DOSSIERS + SESSION PERSISTANTE
 *
 * STRATEGIE :
 *   La limite des 5 clics/heure est PAR DOSSIER (AppId), pas par IP ni par compte.
 *   -> On utilise N dossiers en rotation round-robin sur 1 seule IP SOAX.
 *   -> 5 dossiers x 5 clics/h = 25 scans/heure = 1 scan toutes les ~2.5 min
 *
 * SESSION PERSISTANTE (v3.1) :
 *   Le cookie ASP.NET_SessionId CEV dure plusieurs heures.
 *   -> Login VOWINT + hCaptcha + GetEAppointmentUrl = 1 seul setup initial
 *   -> Ensuite, on REUTILISE le cookie pour tous les polls (POST /Home/AvailableTimeSlots)
 *   -> Re-login uniquement quand la session expire (detecte par 403/302->SessionExpired)
 *   -> Economie massive : 1 captcha toutes les ~2-4h au lieu de 1 par scan
 *
 * ARCHITECTURE :
 *   - 1 seule IP proxy (SOAX Kinshasa, sticky session 5min)
 *   - N dossiers VOWINT (configures via bot-config "cev_dossier_pool")
 *   - Chaque dossier a sa propre session CEV persistante
 *   - Rotation round-robin entre les dossiers pour le polling
 *   - Quand un dossier detecte un slot -> booking immediat avec CE dossier
 *
 * CONFIG Convex (bot-config) :
 *   cev_dossier_mode = "1"                  -> activer ce loop
 *   cev_dossier_pool = "VOWINT6085888,VOWINT6085889,VOWINT6085890"
 *   cev_dossier_interval_sec = "30"         -> pause entre chaque scan (defaut: calcule auto)
 *
 * IMPORTANT : MUTUELLEMENT EXCLUSIF avec cev-stealth-loop (v2 IP pool).
 */

import { setupCevSessionHttp } from "../cevHttpSetup.js";
import { bookCevViaHttp } from "../cevHttpBooking.js";
import { bookWithExistingSession } from "../cevBooking.js";
import { pollCevSlot } from "../cevPolling.js";
// cev-shared-impit not needed in v3.1 — polling uses pollCevSlot() which handles its own fetch
import {
  getPendingCevSetups,
  getActiveCevSessions,
  reportSlotFound,
  botLog,
  getBotConfigValue,
} from "../convexClient.js";


// --- Configuration ---

const MAX_CLICKS_PER_DOSSIER_PER_HOUR = 4; // Marge securite (limite serveur = 5)
const CLICK_WINDOW_MS = 60 * 60 * 1000; // 1 heure
const CEV_SESSION_MAX_AGE_MS = 3 * 60 * 60_000; // 3h — forcer re-login apres ce delai meme si pas expire
const CEV_SESSION_EXPIRY_GRACE_MS = 5 * 60_000; // 5 min avant validUntil → re-login preventif

// --- Persistent CEV Session (per dossier) ---

interface CevPersistentSession {
  /** ASP.NET_SessionId cookie value */
  sessionCookie: string;
  /** Integration URL used to establish the session */
  integrationUrl: string;
  /** Timestamp when validUntil expires (from SetCaptchaToken response) */
  validUntilMs: number;
  /** Timestamp when this session was created */
  createdAt: number;
  /** Number of successful polls with this session */
  pollCount: number;
}

/** Map: vowintRef -> persistent CEV session */
const persistentSessions = new Map<string, CevPersistentSession>();


/**
 * Check if a persistent session is still usable.
 * Returns false if expired, too old, or close to validUntil.
 */
function isSessionValid(session: CevPersistentSession): boolean {
  const now = Date.now();
  // Session too old (absolute max age)
  if (now - session.createdAt > CEV_SESSION_MAX_AGE_MS) return false;
  // validUntil approaching (with grace period)
  if (session.validUntilMs > 0 && now > session.validUntilMs - CEV_SESSION_EXPIRY_GRACE_MS) return false;
  return true;
}

/**
 * Establish a new CEV session for a dossier (full login + hCaptcha flow).
 * This consumes 1 VOWINT click (GetEAppointmentUrl).
 */
async function establishCevSession(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
): Promise<CevPersistentSession | null> {
  log("INFO", `  [SESSION] Etablissement session CEV pour ${dossier.vowintRef}...`);

  const result = await setupCevSessionHttp(
    vowintEmail,
    vowintPassword,
    "cev-dossier-v3",
    "cev-dossier-v3",
    dossier.vowintRef,
  );

  if (!result.success) {
    if (result.error?.includes("RATE_LIMIT")) {
      pool.markRateLimited(dossier);
      log("WARN", `  [SESSION] Rate-limit lors du setup pour ${dossier.vowintRef}`);
    } else {
      log("WARN", `  [SESSION] Echec setup: ${result.error}`);
    }
    return null;
  }

  if (!result.sessionCookie) {
    log("WARN", `  [SESSION] Pas de cookie dans la reponse setup`);
    return null;
  }

  // Record the click used to establish the session
  pool.recordClick(dossier);

  const session: CevPersistentSession = {
    sessionCookie: result.sessionCookie,
    integrationUrl: result.integrationUrl ?? "",
    validUntilMs: result.validUntilMs ?? (Date.now() + 2 * 60 * 60_000), // default 2h if unknown
    createdAt: Date.now(),
    pollCount: 0,
  };

  persistentSessions.set(dossier.vowintRef, session);
  const validForMin = Math.round((session.validUntilMs - Date.now()) / 60_000);
  log("INFO", `  [SESSION] Session etablie pour ${dossier.vowintRef} (valide ~${validForMin} min)`);

  // If slots were already detected during setup, return the session (caller will handle)
  if (result.slotsAvailable) {
    log("INFO", `  [SESSION] Slots detectes pendant le setup!`);
  }

  return session;
}


// --- Dossier Slot (state per dossier) ---

interface DossierSlot {
  /** Numero VOWINT (ex: "VOWINT6085888") */
  vowintRef: string;
  /** Timestamps des clics GetEAppointmentUrl effectues */
  clickTimestamps: number[];
  /** Nombre total de scans reussis */
  totalScans: number;
  /** Nombre de rate-limits rencontres */
  rateLimitCount: number;
}

class CevDossierPool {
  private slots: DossierSlot[] = [];
  private currentIndex = 0;

  /** Initialise le pool avec les numeros VOWINT */
  initialize(vowintRefs: string[]): void {
    this.slots = vowintRefs.map(ref => ({
      vowintRef: ref.trim().toUpperCase(),
      clickTimestamps: [],
      totalScans: 0,
      rateLimitCount: 0,
    }));
    this.currentIndex = 0;
    log("INFO", `Pool initialise: ${this.slots.length} dossiers`);
    this.slots.forEach((s, i) => log("INFO", `  #${i}: ${s.vowintRef}`));
  }

  /** Retourne le prochain dossier disponible (quota non epuise) */
  getNextAvailable(): DossierSlot | null {
    if (this.slots.length === 0) return null;
    const now = Date.now();
    const startIndex = this.currentIndex;

    for (let attempts = 0; attempts < this.slots.length; attempts++) {
      const idx = (startIndex + attempts) % this.slots.length;
      const slot = this.slots[idx];

      // Purger les clics > 1 heure
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);

      // Verifier quota
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
        this.currentIndex = (idx + 1) % this.slots.length;
        return slot;
      }
    }

    return null; // Tous les dossiers sont epuises
  }


  /** Retourne le prochain dossier pour le POLLING (pas de quota check — le poll ne coute rien) */
  getNextForPolling(): DossierSlot | null {
    if (this.slots.length === 0) return null;
    const startIndex = this.currentIndex;
    // Round-robin simple — on prend le prochain qui a une session active
    for (let attempts = 0; attempts < this.slots.length; attempts++) {
      const idx = (startIndex + attempts) % this.slots.length;
      const slot = this.slots[idx];
      const session = persistentSessions.get(slot.vowintRef);
      if (session && isSessionValid(session)) {
        this.currentIndex = (idx + 1) % this.slots.length;
        return slot;
      }
    }
    return null; // Aucun dossier avec session active
  }

  /** Enregistre un clic sur un dossier */
  recordClick(slot: DossierSlot): void {
    slot.clickTimestamps.push(Date.now());
    slot.totalScans++;
  }

  /** Marque un dossier comme rate-limite */
  markRateLimited(slot: DossierSlot): void {
    const now = Date.now();
    while (slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS).length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
      slot.clickTimestamps.push(now);
    }
    slot.rateLimitCount++;
    log("WARN", `Dossier ${slot.vowintRef} rate-limite (${slot.rateLimitCount}x)`);
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
      const oldest = slot.clickTimestamps[0];
      const availableAt = oldest + CLICK_WINDOW_MS;
      minWait = Math.min(minWait, availableAt - now);
    }

    return minWait === Infinity ? 60_000 : minWait;
  }

  /** Stats du pool */
  getStats(): { total: number; available: number; exhausted: number; totalScans: number; activeSessions: number } {
    const now = Date.now();
    let available = 0;
    let totalScans = 0;
    let activeSessions = 0;

    for (const slot of this.slots) {
      slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
      if (slot.clickTimestamps.length < MAX_CLICKS_PER_DOSSIER_PER_HOUR) available++;
      totalScans += slot.totalScans;
      const session = persistentSessions.get(slot.vowintRef);
      if (session && isSessionValid(session)) activeSessions++;
    }

    return { total: this.slots.length, available, exhausted: this.slots.length - available, totalScans, activeSessions };
  }

  get size(): number { return this.slots.length; }
  get allSlots(): DossierSlot[] { return this.slots; }
}


// --- State ---

interface LoopState {
  scanCount: number;
  slotsFound: number;
  rateLimits: number;
  errors: number;
  sessionEstablishments: number;
  sessionReuses: number;
  isRunning: boolean;
  startedAt: number;
}

const state: LoopState = {
  scanCount: 0,
  slotsFound: 0,
  rateLimits: 0,
  errors: 0,
  sessionEstablishments: 0,
  sessionReuses: 0,
  isRunning: false,
  startedAt: 0,
};

const pool = new CevDossierPool();

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [CEV-DOSSIER-v3] [${level}] ${msg}`);
}


// --- Core: Poll with existing persistent session ---

async function performPoll(
  dossier: DossierSlot,
): Promise<"no_slot" | "slot_found" | "session_expired" | "error"> {
  const session = persistentSessions.get(dossier.vowintRef);
  if (!session || !isSessionValid(session)) {
    return "session_expired";
  }

  try {
    const pollResult = await pollCevSlot(
      session.integrationUrl,
      session.sessionCookie,
    );

    switch (pollResult.status) {
      case "slot_found":
        session.pollCount++;
        return "slot_found";
      case "no_slot":
        session.pollCount++;
        return "no_slot";
      case "session_expired":
        // Invalidate the persistent session — will trigger re-login on next iteration
        persistentSessions.delete(dossier.vowintRef);
        log("INFO", `  [SESSION] Session expiree pour ${dossier.vowintRef} (apres ${session.pollCount} polls)`);
        return "session_expired";
      case "error":
        // Non-fatal error — session might still be valid
        log("WARN", `  Poll error: ${pollResult.error}`);
        return "error";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `  Exception poll: ${msg.slice(0, 100)}`);
    return "error";
  }
}


// --- Booking ---

async function handleSlotFound(
  vowintEmail: string,
  vowintPassword: string,
  dossier: DossierSlot,
  applicationId: string,
): Promise<void> {
  log("INFO", `[SLOT] SLOT DETECTE sur dossier ${dossier.vowintRef} — BOOKING IMMEDIAT`);
  state.slotsFound++;

  const session = persistentSessions.get(dossier.vowintRef);

  botLog({
    applicationId,
    step: "cev_dossier_slot_found",
    status: "ok",
    data: {
      dossier: dossier.vowintRef,
      scanCount: state.scanCount,
      sessionReuses: state.sessionReuses,
      uptimeMin: Math.round((Date.now() - state.startedAt) / 60_000),
      sessionAge: session ? Math.round((Date.now() - session.createdAt) / 60_000) : 0,
    },
  });

  // Use existing session cookie if available, otherwise re-setup
  let bookingCookie = session?.sessionCookie;
  let bookingUrl = session?.integrationUrl;

  if (!bookingCookie || !bookingUrl) {
    log("INFO", `  Re-setup pour obtenir session fraiche pour booking...`);
    const freshSession = await establishCevSession(vowintEmail, vowintPassword, dossier);
    if (!freshSession) {
      log("ERROR", `  Session re-setup echoue pour booking`);
      return;
    }
    bookingCookie = freshSession.sessionCookie;
    bookingUrl = freshSession.integrationUrl;
  }

  // Tentative booking HTTP
  try {
    const httpResult = await bookCevViaHttp(bookingUrl!, bookingCookie!, applicationId);
    if (httpResult.success) {
      log("INFO", `  BOOKING REUSSI! code=${httpResult.confirmationCode} date=${httpResult.bookedDate}`);
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
    const pwResult = await bookWithExistingSession(bookingUrl!, bookingCookie!, applicationId);
    if (pwResult.success) {
      log("INFO", `  BOOKING PLAYWRIGHT REUSSI! code=${pwResult.confirmationCode}`);
      await reportSlotFound({
        applicationId,
        date: pwResult.bookedDate ?? "",
        time: pwResult.bookedTime ?? "",
        location: `CEV Belgique (Dossier ${dossier.vowintRef})`,
        confirmationCode: pwResult.confirmationCode,
        screenshotStorageId: pwResult.screenshotStorageId,
      });
    } else {
      log("ERROR", `  Booking echoue: ${pwResult.error}`);
    }
  } catch (err) {
    log("ERROR", `  Crash booking: ${err}`);
  }
}


// --- Session Maintenance: ensure all dossiers have active sessions ---

async function ensureSessionsEstablished(
  vowintEmail: string,
  vowintPassword: string,
): Promise<void> {
  for (const slot of pool.allSlots) {
    const existing = persistentSessions.get(slot.vowintRef);
    if (existing && isSessionValid(existing)) continue; // Session still valid

    // Need to establish/re-establish session — check click quota first
    const now = Date.now();
    slot.clickTimestamps = slot.clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
    if (slot.clickTimestamps.length >= MAX_CLICKS_PER_DOSSIER_PER_HOUR) {
      log("INFO", `  [SESSION] ${slot.vowintRef}: quota epuise, skip re-login`);
      continue;
    }

    const session = await establishCevSession(vowintEmail, vowintPassword, slot);
    if (session) {
      state.sessionEstablishments++;
    } else {
      // Don't block the loop — other dossiers may still have active sessions
      log("WARN", `  [SESSION] Echec etablissement pour ${slot.vowintRef}`);
    }

    // Small delay between session setups to avoid burst
    await sleep(3000);
  }
}


// --- Loop Principal v3.1 (Persistent Session) ---

export async function startCevDossierLoop(): Promise<void> {
  log("INFO", "=== CEV Dossier Loop v3.1 — Pool de Dossiers + Session Persistante ===");

  // Verifier si le mode est active
  const enabled = await getBotConfigValue("cev_dossier_mode");
  if (enabled !== "1") {
    log("INFO", "Mode dossier desactive (cev_dossier_mode != 1) — attente...");
    while (true) {
      await sleep(60_000);
      const check = await getBotConfigValue("cev_dossier_mode");
      if (check === "1") {
        log("INFO", "Mode dossier active -> demarrage!");
        break;
      }
    }
  }

  // Charger la liste de dossiers
  const dossierPoolStr = await getBotConfigValue("cev_dossier_pool");
  if (!dossierPoolStr || !dossierPoolStr.trim()) {
    log("ERROR", "cev_dossier_pool non configure! Format: VOWINT6085888,VOWINT6085889,...");
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
  // With persistent sessions, polling is FREE (no click consumed)
  // So we can poll much more frequently than before
  const defaultPollInterval = 15; // 15s between polls (free, no captcha)
  const intervalMs = (configuredInterval > 0 ? configuredInterval : defaultPollInterval) * 1000;

  log("INFO", `Config:`);
  log("INFO", `  - Dossiers: ${pool.size}`);
  log("INFO", `  - Intervalle polling: ${Math.round(intervalMs / 1000)}s (GRATUIT — reutilise session)`);
  log("INFO", `  - Session max age: ${CEV_SESSION_MAX_AGE_MS / 60_000} min`);
  log("INFO", `  - Clics login/h max: ${pool.size * MAX_CLICKS_PER_DOSSIER_PER_HOUR} (seulement pour (re)login)`);
  log("INFO", `  - Proxy: SOAX (1 IP fixe Kinshasa)`);


  // Recuperer les credentials depuis les sessions CEV actives
  const allSessions = await getActiveCevSessions();
  const target = allSessions.find((s: any) => s.vowintEmail && s.vowintPassword);
  let vowintEmail = target?.vowintEmail;
  let vowintPassword = target?.vowintPassword;

  if (!vowintEmail || !vowintPassword) {
    // Fallback: chercher dans les sessions en needs_setup
    const pendingSetups = await getPendingCevSetups();
    const pending = pendingSetups.find(s => s.vowintEmail && s.vowintPassword);
    if (pending) {
      vowintEmail = pending.vowintEmail!;
      vowintPassword = pending.vowintPassword!;
    }
  }

  if (!vowintEmail || !vowintPassword) {
    log("ERROR", "Aucun compte VOWINT configure — attente session avec credentials...");
    while (true) {
      await sleep(30_000);
      const sessions = await getActiveCevSessions();
      const t = sessions.find((s: any) => s.vowintEmail && s.vowintPassword);
      if (t) { vowintEmail = t.vowintEmail; vowintPassword = t.vowintPassword; break; }
      const setups = await getPendingCevSetups();
      const p = setups.find(s => s.vowintEmail && s.vowintPassword);
      if (p) { vowintEmail = p.vowintEmail!; vowintPassword = p.vowintPassword!; break; }
    }
  }

  log("INFO", `Credentials VOWINT: ${vowintEmail!.slice(0, 5)}...`);

  // --- Phase 1: Establish initial sessions for all dossiers ---
  log("INFO", "Phase 1: Etablissement des sessions initiales...");
  await ensureSessionsEstablished(vowintEmail!, vowintPassword!);

  const stats = pool.getStats();
  log("INFO", `Sessions etablies: ${stats.activeSessions}/${stats.total}`);
  if (stats.activeSessions === 0) {
    log("WARN", "Aucune session active — le loop va retenter toutes les 60s");
  }

  state.isRunning = true;
  state.startedAt = Date.now();


  // --- Phase 2: Main polling loop (reuses persistent sessions) ---
  while (state.isRunning) {
    try {
      // Re-check mode toutes les 100 scans
      if (state.scanCount > 0 && state.scanCount % 100 === 0) {
        const stillEnabled = await getBotConfigValue("cev_dossier_mode");
        if (stillEnabled !== "1") {
          log("INFO", "Mode dossier desactive -> arret");
          state.isRunning = false;
          break;
        }
      }

      // Every 50 scans, re-establish expired sessions
      if (state.scanCount > 0 && state.scanCount % 50 === 0) {
        const currentStats = pool.getStats();
        if (currentStats.activeSessions < currentStats.total) {
          log("INFO", `[MAINTENANCE] Re-etablissement sessions (${currentStats.activeSessions}/${currentStats.total} actives)`);
          await ensureSessionsEstablished(vowintEmail!, vowintPassword!);
        }
      }

      // Get next dossier with active session for polling
      const dossier = pool.getNextForPolling();
      if (!dossier) {
        // No active sessions — try to re-establish
        const currentStats = pool.getStats();
        log("INFO", `Aucune session active (${currentStats.activeSessions}/${currentStats.total}) — re-etablissement...`);
        await ensureSessionsEstablished(vowintEmail!, vowintPassword!);
        const afterStats = pool.getStats();
        if (afterStats.activeSessions === 0) {
          // All dossiers exhausted or failed — wait for click quota to reset
          const waitMs = pool.getNextAvailableIn();
          const waitMin = Math.ceil(waitMs / 60_000);
          log("INFO", `Tous les dossiers epuises — attente ${waitMin} min`);
          await sleep(Math.min(waitMs + 5000, 5 * 60_000));
        }
        continue;
      }

      // --- POLL (FREE — reuses existing session cookie) ---
      state.scanCount++;
      const session = persistentSessions.get(dossier.vowintRef)!;
      const sessionAgeMin = Math.round((Date.now() - session.createdAt) / 60_000);

      if (state.scanCount % 10 === 1) {
        const pollStats = pool.getStats();
        log("INFO", `[Scan #${state.scanCount}] ${dossier.vowintRef} | Sessions: ${pollStats.activeSessions}/${pollStats.total} | Age: ${sessionAgeMin}min | Polls: ${session.pollCount} | Reuses: ${state.sessionReuses}`);
      }

      const result = await performPoll(dossier);
      state.sessionReuses++;

      switch (result) {
        case "slot_found":
          log("INFO", `  SLOT TROUVE!`);
          await handleSlotFound(vowintEmail!, vowintPassword!, dossier, "cev-dossier-v3");
          break;
        case "session_expired":
          log("INFO", `  Session expiree pour ${dossier.vowintRef} — sera re-etablie au prochain cycle`);
          break;
        case "no_slot":
          // Silent — only log every Nth scan
          if (state.scanCount % 20 === 0) {
            log("INFO", `  — Pas de creneau (poll #${session.pollCount})`);
          }
          break;
        case "error":
          state.errors++;
          break;
      }


      // Stats periodiques
      if (state.scanCount % 50 === 0) {
        const uptimeMin = Math.round((Date.now() - state.startedAt) / 60_000);
        const scansPerHour = uptimeMin > 0 ? Math.round(state.scanCount / (uptimeMin / 60)) : 0;
        const poolStats = pool.getStats();
        log("INFO", `Stats: ${state.scanCount} polls en ${uptimeMin}min (${scansPerHour}/h) | Sessions: ${poolStats.activeSessions}/${poolStats.total} | Logins: ${state.sessionEstablishments} | Reuses: ${state.sessionReuses} | Slots: ${state.slotsFound}`);
        botLog({
          applicationId: "cev-dossier-v3",
          step: "cev_dossier_v3_stats",
          status: "ok",
          data: {
            scanCount: state.scanCount,
            slotsFound: state.slotsFound,
            rateLimits: state.rateLimits,
            scansPerHour,
            uptimeMin,
            sessionEstablishments: state.sessionEstablishments,
            sessionReuses: state.sessionReuses,
            activeSessions: poolStats.activeSessions,
            totalDossiers: poolStats.total,
          },
        });
      }

      // Pause entre les polls (beaucoup plus court car gratuit)
      const jitter = intervalMs * 0.2 * (Math.random() * 2 - 1);
      await sleep(intervalMs + jitter);

    } catch (loopErr) {
      log("ERROR", `Erreur loop: ${loopErr}`);
      state.errors++;
      await sleep(30_000);
    }
  }

  log("INFO", "=== CEV Dossier Loop v3.1 arrete ===");
}

/** Expose l'etat pour monitoring */
export function getCevDossierState() {
  return { ...state, pool: pool.getStats() };
}
