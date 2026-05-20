// ─── CEV Stealth Loop — Stratégie "3 checks + pause + re-login" ─────────────
//
// Objectif : surveiller les créneaux CEV (Belgique) avec UN SEUL COMPTE et
// UNE SEULE IP (Kinshasa) sans jamais déclencher le rate-limit VOWINT (5 clics/heure).
//
// Cycle complet (~5 min) :
//   1. LOGIN   — Se connecte proprement à VOWINT (POST /Login), récupère session + appId
//   2. CHASSE  — 3 vérifications max via GetEAppointmentUrl + hCaptcha + redirect probe
//                Chaque vérification espacée de 30 secondes
//   3. RESET   — Détruit toute trace en mémoire (cookies, cache session)
//   4. SOMMEIL — Pause complète de 3-4 minutes (aucune requête)
//   5. REPEAT  — Retour à l'étape 1
//
// Coût : 3 hCaptcha/cycle × ~$0.003 = ~$0.009/cycle ≈ $2.60/jour (24h continu)
// Débit : ~3 checks / 5 min = 36 checks/heure (bien sous la limite de 5 clics/heure
//         car chaque "clic" ici est un setup complet avec captcha)
//
// IMPORTANT : Ce loop est MUTUELLEMENT EXCLUSIF avec le cev-setup-loop + cev-polling-loop.
//   Quand stealth mode est activé, les deux autres loops sont désactivés pour ce compte.
//   Configurable via bot-config Convex : cev_stealth_mode = "1"

import { setupCevSessionHttp, invalidateVowintCache } from "../cevHttpSetup.js";
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

/** Nombre max de vérifications par cycle avant pause */
const MAX_CHECKS_PER_CYCLE = 3;

/** Délai entre chaque vérification dans un cycle (ms) */
const INTER_CHECK_DELAY_MS = 30_000; // 30 secondes

/** Pause totale entre les cycles (ms) — randomisée entre min et max */
const CYCLE_PAUSE_MIN_MS = 3 * 60_000; // 3 minutes
const CYCLE_PAUSE_MAX_MS = 4 * 60_000; // 4 minutes

/** Délai avant de lancer le premier cycle (évite un burst au démarrage) */
const INITIAL_DELAY_MS = 10_000; // 10 secondes

/** Nombre max de cycles sans succès avant de loguer un warning */
const WARN_AFTER_CYCLES = 50;

// ─── State ──────────────────────────────────────────────────────────────────

interface StealthState {
  cycleCount: number;
  totalChecks: number;
  slotsFound: number;
  lastCycleAt: number;
  consecutiveErrors: number;
  isRunning: boolean;
}

const state: StealthState = {
  cycleCount: 0,
  totalChecks: 0,
  slotsFound: 0,
  lastCycleAt: 0,
  consecutiveErrors: 0,
  isRunning: false,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [CEV-STEALTH] [${level}] ${msg}`);
}

// ─── Core: un check complet (login → captcha → redirect probe → verdict) ───

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
  vowintAppUrl?: string,
): Promise<CheckResult> {
  try {
    const result = await setupCevSessionHttp(
      vowintEmail,
      vowintPassword,
      applicationId,
      applicationId,
      vowintAppUrl,
    );

    if (!result.success) {
      // Distinguer rate-limit des autres erreurs
      if (result.error?.includes("RATE_LIMIT")) {
        return { verdict: "rate_limited", error: result.error };
      }
      return { verdict: "error", error: result.error };
    }

    // Setup réussi — vérifier le verdict
    if (result.slotsAvailable) {
      return {
        verdict: "slot_found",
        sessionCookie: result.sessionCookie,
        integrationUrl: result.integrationUrl,
        validUntilMs: result.validUntilMs,
      };
    }

    // NoAvailability ou autre — pas de créneau mais session valide
    // On peut aussi tenter un poll API rapide avec le cookie frais
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
  }
}

// ─── Core: un cycle complet (3 checks + destruction) ────────────────────────

interface CycleResult {
  checksPerformed: number;
  slotFound: boolean;
  sessionCookie?: string;
  integrationUrl?: string;
  applicationId?: string;
  error?: string;
  rateLimited: boolean;
}

async function runStealthCycle(
  vowintEmail: string,
  vowintPassword: string,
  applicationId: string,
  vowintAppUrl?: string,
): Promise<CycleResult> {
  const result: CycleResult = {
    checksPerformed: 0,
    slotFound: false,
    rateLimited: false,
  };

  for (let i = 0; i < MAX_CHECKS_PER_CYCLE; i++) {
    const checkNum = i + 1;
    log("INFO", `  Check ${checkNum}/${MAX_CHECKS_PER_CYCLE}...`);

    const check = await performSingleCheck(
      vowintEmail,
      vowintPassword,
      applicationId,
      vowintAppUrl,
    );

    result.checksPerformed++;
    state.totalChecks++;

    if (check.verdict === "slot_found") {
      log("INFO", `  SLOT TROUVE au check ${checkNum}!`);
      result.slotFound = true;
      result.sessionCookie = check.sessionCookie;
      result.integrationUrl = check.integrationUrl;
      result.applicationId = applicationId;
      return result; // Sortir immédiatement
    }

    if (check.verdict === "rate_limited") {
      log("WARN", `  Rate-limit détecté au check ${checkNum}: ${check.error}`);
      result.rateLimited = true;
      result.error = check.error;
      // STOP immédiat — ne pas continuer les checks, passer directement au sommeil long
      break;
    }

    if (check.verdict === "error") {
      log("WARN", `  Erreur au check ${checkNum}: ${check.error}`);
      result.error = check.error;
      // Continuer avec les checks suivants si l'erreur n'est pas fatale
      if (check.error?.includes("LOGIN") || check.error?.includes("CSRF")) {
        break; // Erreur de login = inutile de réessayer
      }
    }

    if (check.verdict === "no_slot") {
      log("INFO", `  Check ${checkNum}: pas de créneau`);
    }

    // Attendre 30 secondes avant le prochain check (sauf le dernier)
    if (i < MAX_CHECKS_PER_CYCLE - 1) {
      log("INFO", `  Pause inter-check: 30s...`);
      await sleep(INTER_CHECK_DELAY_MS);
    }
  }

  return result;
}

// ─── Destruction de session (le "nettoyage radical") ────────────────────────

function destroyAllSessions(vowintEmail: string): void {
  // 1. Invalider le cache VOWINT en mémoire
  invalidateVowintCache(vowintEmail);

  // 2. Pas de cookie jar global (fetch Node.js est stateless par défaut)
  //    Mais on s'assure qu'aucune variable locale ne persiste

  log("INFO", "  Sessions détruites (cache VOWINT vidé, état nettoyé)");
}

// ─── Booking quand un slot est trouvé ───────────────────────────────────────

async function handleSlotFound(
  sessionCookie: string,
  integrationUrl: string,
  applicationId: string,
): Promise<void> {
  log("INFO", "SLOT DETECTE — Lancement booking...");
  state.slotsFound++;

  botLog({
    applicationId,
    step: "cev_stealth_slot_found",
    status: "ok",
    data: {
      cycleCount: state.cycleCount,
      totalChecks: state.totalChecks,
    },
  });

  let booked = false;
  let bookedDate: string | undefined;
  let bookedTime: string | undefined;
  let bookedCode: string | undefined;
  let bookedScreenshot: string | undefined;

  // Tentative 1 : HTTP pur (rapide)
  log("INFO", "  Tentative booking HTTP...");
  try {
    const httpResult = await bookCevViaHttp(integrationUrl, sessionCookie, applicationId);

    if (httpResult.success) {
      booked = true;
      bookedDate = httpResult.bookedDate;
      bookedTime = httpResult.bookedTime;
      bookedCode = httpResult.confirmationCode;
      log("INFO", `  BOOKING HTTP REUSSI! code=${bookedCode ?? "N/A"} date=${bookedDate ?? "?"}`);
    } else if (httpResult.needsPlaywright !== false) {
      log("INFO", `  HTTP insuffisant (${httpResult.error}) — fallback Playwright...`);

      // Tentative 2 : Playwright
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
        log("INFO", `  BOOKING PLAYWRIGHT REUSSI! code=${bookedCode ?? "N/A"} date=${bookedDate ?? "?"}`);
      } else {
        log("ERROR", `  Playwright aussi echoue: ${playwrightResult.error}`);
      }
    } else {
      log("ERROR", `  Booking HTTP erreur definitive: ${httpResult.error}`);
    }
  } catch (err) {
    log("ERROR", `  Crash booking: ${err}`);
  }

  if (booked) {
    await reportSlotFound({
      applicationId,
      date: bookedDate ?? "",
      time: bookedTime ?? "",
      location: "CEV - Ambassade de Belgique (Stealth Loop)",
      confirmationCode: bookedCode,
      screenshotStorageId: bookedScreenshot,
    });
    log("INFO", `  Slot rapporte a Convex`);
  }
}

// ─── Loop principal ─────────────────────────────────────────────────────────

export async function startCevStealthLoop(): Promise<void> {
  log("INFO", "=== CEV Stealth Loop demarrage ===");
  log("INFO", `Config: ${MAX_CHECKS_PER_CYCLE} checks/cycle, ${INTER_CHECK_DELAY_MS / 1000}s inter-check, pause ${CYCLE_PAUSE_MIN_MS / 60_000}-${CYCLE_PAUSE_MAX_MS / 60_000} min`);

  // Vérifier si le mode stealth est activé
  const stealthEnabled = await getBotConfigValue("cev_stealth_mode");
  if (stealthEnabled !== "1") {
    log("INFO", "Mode stealth desactive (cev_stealth_mode != 1) — loop inactif");
    // Re-vérifier toutes les 60s au cas où l'admin l'active
    while (true) {
      await sleep(60_000);
      const check = await getBotConfigValue("cev_stealth_mode");
      if (check === "1") {
        log("INFO", "Mode stealth active par admin — demarrage!");
        break;
      }
    }
  }

  // Délai initial pour éviter un burst au démarrage
  await sleep(INITIAL_DELAY_MS);

  state.isRunning = true;

  while (state.isRunning) {
    try {
      // Re-vérifier périodiquement si le mode est toujours actif
      if (state.cycleCount > 0 && state.cycleCount % 10 === 0) {
        const stillEnabled = await getBotConfigValue("cev_stealth_mode");
        if (stillEnabled !== "1") {
          log("INFO", "Mode stealth desactive par admin — arret loop");
          state.isRunning = false;
          break;
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // Récupérer les sessions CEV needs_setup (contiennent les credentials)
      // ══════════════════════════════════════════════════════════════════════
      const pendingSetups = await getPendingCevSetups();
      const activeSessions = await getActiveCevSessions();

      // Trouver la session avec credentials VOWINT (celle d'Esther)
      // Priorité : needs_setup > active (en mode stealth on force le cycle complet)
      const target = pendingSetups.find(s => s.vowintEmail && s.vowintPassword)
        ?? (activeSessions.length > 0 ? null : null); // active sessions n'ont pas les credentials exposées

      if (!target) {
        // Pas de session avec credentials — attendre
        if (state.cycleCount === 0) {
          log("WARN", "Aucune session CEV avec credentials VOWINT trouvee — en attente...");
        }
        await sleep(30_000);
        continue;
      }

      // ══════════════════════════════════════════════════════════════════════
      // CYCLE COMPLET
      // ══════════════════════════════════════════════════════════════════════
      state.cycleCount++;
      state.lastCycleAt = Date.now();

      const cycleStart = Date.now();
      log("INFO", `═══ Cycle #${state.cycleCount} ═══ (total checks: ${state.totalChecks}, slots: ${state.slotsFound})`);

      // ETAPE 1 + 2 : Login + 3 checks
      const cycleResult = await runStealthCycle(
        target.vowintEmail!,
        target.vowintPassword!,
        target.applicationId,
        target.vowintAppUrl,
      );

      const cycleDuration = Date.now() - cycleStart;
      log("INFO", `  Cycle termine: ${cycleResult.checksPerformed} checks en ${Math.round(cycleDuration / 1000)}s`);

      // Rapporter à Convex
      if (cycleResult.slotFound && cycleResult.sessionCookie && cycleResult.integrationUrl) {
        // SLOT TROUVE — booking immédiat
        await recordCevSessionCheck(target.sessionId, "slot_found");
        await handleSlotFound(
          cycleResult.sessionCookie,
          cycleResult.integrationUrl,
          target.applicationId,
        );
        state.consecutiveErrors = 0;
      } else if (cycleResult.rateLimited) {
        // Rate-limit — pause longue (60 min) pour respecter VOWINT
        log("WARN", `  RATE-LIMIT detecte — pause longue 60 min`);
        state.consecutiveErrors++;
        botLog({
          applicationId: target.applicationId,
          step: "cev_stealth_rate_limit",
          status: "warn",
          data: { error: cycleResult.error, cycleCount: state.cycleCount },
        });
        // ETAPE 3 : Destruction radicale
        destroyAllSessions(target.vowintEmail!);
        // Pause longue
        await sleep(60 * 60_000);
        continue; // Skip la pause normale
      } else if (cycleResult.error) {
        state.consecutiveErrors++;
        log("WARN", `  Erreur cycle: ${cycleResult.error} (consecutives: ${state.consecutiveErrors})`);
        if (state.consecutiveErrors >= 5) {
          log("ERROR", `  5 erreurs consecutives — pause longue 10 min`);
          botLog({
            applicationId: target.applicationId,
            step: "cev_stealth_consecutive_errors",
            status: "fail",
            data: { errors: state.consecutiveErrors, lastError: cycleResult.error },
          });
          destroyAllSessions(target.vowintEmail!);
          await sleep(10 * 60_000);
          state.consecutiveErrors = 0;
          continue;
        }
      } else {
        // no_slot normal
        state.consecutiveErrors = 0;
        await recordCevSessionCheck(target.sessionId, "no_slot");
      }

      // Warning périodique
      if (state.cycleCount % WARN_AFTER_CYCLES === 0) {
        log("INFO", `  [Stats] ${state.cycleCount} cycles, ${state.totalChecks} checks, ${state.slotsFound} slots trouves`);
        botLog({
          applicationId: target.applicationId,
          step: "cev_stealth_stats",
          status: "ok",
          data: {
            cycleCount: state.cycleCount,
            totalChecks: state.totalChecks,
            slotsFound: state.slotsFound,
            uptimeMin: Math.round((Date.now() - (state.lastCycleAt - cycleDuration * state.cycleCount)) / 60_000),
          },
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // ETAPE 3 : DESTRUCTION RADICALE
      // ══════════════════════════════════════════════════════════════════════
      log("INFO", "  Nettoyage: destruction session...");
      destroyAllSessions(target.vowintEmail!);

      // ══════════════════════════════════════════════════════════════════════
      // ETAPE 4 : SOMMEIL (3-4 minutes)
      // ══════════════════════════════════════════════════════════════════════
      const pauseMs = randomBetween(CYCLE_PAUSE_MIN_MS, CYCLE_PAUSE_MAX_MS);
      log("INFO", `  Sommeil: ${Math.round(pauseMs / 1000)}s (${(pauseMs / 60_000).toFixed(1)} min) — aucune requete...`);
      await sleep(pauseMs);

    } catch (loopErr) {
      log("ERROR", `Erreur loop: ${loopErr}`);
      state.consecutiveErrors++;
      // En cas de crash, pause courte puis retry
      await sleep(30_000);
    }
  }

  log("INFO", "=== CEV Stealth Loop arrete ===");
}

/** Expose l'état pour monitoring (ex: endpoint /status) */
export function getCevStealthState(): Readonly<StealthState> {
  return { ...state };
}
