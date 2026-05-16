/**
 * Continuous Refresh — "Page Polling" pour maximiser la couverture temporelle.
 *
 * CONCEPT :
 *   Un humain sur la page des créneaux ne fait pas 1 check puis attend 15 min.
 *   Il rafraîchit la page toutes les 30s-2min pendant 5-10 min, puis se distrait
 *   2-4 min, puis recommence. Ce module implémente ce comportement.
 *
 * STRATÉGIE :
 *   - Après le scan initial complet (warmup + OFC list + dates + times), si pas de slot,
 *     on entre en "mode refresh" : on appelle uniquement getFirstAvailableMonth à intervalles
 *     variables (30-120s) pendant des "fenêtres" de 4-8 min.
 *   - Entre les fenêtres : pause de 1.5-3.5 min (humain regarde ailleurs).
 *   - On continue jusqu'à : slot trouvé, budget temps épuisé, ou token approche expiry.
 *
 * COÛT :
 *   - Zéro login supplémentaire (même session)
 *   - ~1 requête POST par refresh (léger)
 *   - Compte comme 1 seul "scan" dans le cap de session
 *
 * COUVERTURE :
 *   - Avant : 51s de check / 15 min = 6% du temps couvert
 *   - Après : ~30 min de check / 50 min session = 60% du temps couvert (10× mieux)
 */

import type { UsaSession } from "./types.js";
import type { HunterJob, SlotDiscoveryEvent } from "../convexClient.js";
import { botLog } from "../convexClient.js";
import {
  USA_FIRST_AVAILABLE_MONTH_URL,
  USA_SLOT_DATES_URL,
  USA_SLOT_TIMES_URL,
  SCAN_CUTOFF_BEFORE_EXPIRY_MS,
} from "./config.js";
import { usaFetch, authHeaders, tokenCache, updateSessionActivity } from "./usa-http.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { checkProxyLiveness, isSessionFrozen } from "./proxy-session-guard.js";
import type { UsaOfc, UsaAppDetails, UsaSlotDate, UsaTimeSlot } from "./usa-scan-types.js";
import { toYMD, lastDayOfMonth } from "./usa-scan-types.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Durée minimale d'une fenêtre de refresh (ms). */
const REFRESH_WINDOW_MIN_MS = 4 * 60 * 1000; // 4 min

/** Durée maximale d'une fenêtre de refresh (ms). */
const REFRESH_WINDOW_MAX_MS = 8 * 60 * 1000; // 8 min

/** Pause minimale entre les fenêtres (ms). */
const BREAK_MIN_MS = 1.5 * 60 * 1000; // 1.5 min

/** Pause maximale entre les fenêtres (ms). */
const BREAK_MAX_MS = 3.5 * 60 * 1000; // 3.5 min

/** Intervalle minimum entre deux refreshes dans une fenêtre (ms). */
const REFRESH_INTERVAL_MIN_MS = 30 * 1000; // 30s

/** Intervalle maximum entre deux refreshes dans une fenêtre (ms). */
const REFRESH_INTERVAL_MAX_MS = 120 * 1000; // 2 min

/** Budget total maximum pour le refresh continu (ms). */
const TOTAL_REFRESH_BUDGET_MS = 42 * 60 * 1000; // 42 min

/** Nombre maximum de fenêtres par session. */
const MAX_WINDOWS = 6;

/** Nombre maximum de refreshes au total (protection anti-abus). */
const MAX_TOTAL_REFRESHES = 45;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlotReadyForBooking {
  date: string;
  time: string;
  slotId: number | string;
  ofcName: string;
  slot: unknown; // UsaTimeSlot
  bookingBase: Record<string, unknown>;
}

export interface ContinuousRefreshResult {
  /** Résultat : slot trouvé ou pas. */
  slotDetected: boolean;
  /** Nombre total de refreshes effectués. */
  totalRefreshes: number;
  /** Nombre de fenêtres complétées. */
  windowsCompleted: number;
  /** Durée totale du refresh continu (ms). */
  totalDurationMs: number;
  /** Raison de l'arrêt. */
  stopReason: "slot_found" | "budget_exhausted" | "token_expiring" | "proxy_dead" | "error" | "max_refreshes" | "max_windows";
  /** Données du premier mois disponible si slot détecté. */
  firstAvailableMonth?: string;
  /** Slot prêt pour booking instantané (fast-path: skip full re-scan). */
  slotReady?: SlotReadyForBooking;
}

export interface ContinuousRefreshConfig {
  /** Session USA active. */
  session: UsaSession;
  /** Job hunter associé. */
  job: HunterJob;
  /** OFC(s) à surveiller. */
  ofcs: UsaOfc[];
  /** Détails de l'application. */
  appDetails: UsaAppDetails;
  /** Referer pour les requêtes. */
  referer: string;
  /** Username pour le cache token. */
  username: string;
  /** Mode reschedule ? */
  rescheduleYN?: boolean;
  /** Date minimum admin. */
  dateFrom?: string;
  /** Date limite admin. */
  dateDeadline?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Génère un intervalle gaussien entre min et max (centré au milieu). */
function gaussianInterval(min: number, max: number): number {
  // Box-Muller pour distribution naturelle
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const center = (min + max) / 2;
  const stddev = (max - min) * 0.25;
  const raw = center + z * stddev;
  return Math.max(min, Math.min(raw, max));
}

/** Vérifie si le token approche de l'expiration. */
function isTokenApproachingExpiry(username: string): boolean {
  const cached = tokenCache.get(username.toLowerCase());
  if (!cached) return true;
  const timeToExpiry = cached.expiresAt - Date.now();
  return timeToExpiry < SCAN_CUTOFF_BEFORE_EXPIRY_MS;
}

// ─── Fonction principale ────────────────────────────────────────────────────

/**
 * Exécute le refresh continu après un scan initial sans résultat.
 * Boucle avec des pauses humaines en vérifiant périodiquement la disponibilité.
 *
 * @returns Résultat du refresh continu (slot trouvé ou raison d'arrêt)
 */
export async function runContinuousRefresh(config: ContinuousRefreshConfig): Promise<ContinuousRefreshResult> {
  const { session, job, ofcs, appDetails, referer, username, rescheduleYN, dateFrom, dateDeadline } = config;
  const startTime = Date.now();
  let totalRefreshes = 0;
  let windowsCompleted = 0;

  console.log(`[refresh] 🔄 Démarrage refresh continu — budget ${Math.round(TOTAL_REFRESH_BUDGET_MS / 60000)} min, max ${MAX_WINDOWS} fenêtres`);
  botLog({
    applicationId: job.id,
    step: "continuous_refresh_start",
    status: "ok",
    data: {
      budgetMin: Math.round(TOTAL_REFRESH_BUDGET_MS / 60000),
      maxWindows: MAX_WINDOWS,
      ofcCount: ofcs.length,
      offices: ofcs.map(o => o.postName),
    },
  });

  // Boucle des fenêtres de refresh
  for (let windowIdx = 0; windowIdx < MAX_WINDOWS; windowIdx++) {
    // ── Vérifications de sécurité avant chaque fenêtre ──
    const elapsed = Date.now() - startTime;
    if (elapsed >= TOTAL_REFRESH_BUDGET_MS) {
      console.log(`[refresh] ⏱ Budget temps épuisé (${Math.round(elapsed / 60000)} min) — arrêt`);
      return makeResult("budget_exhausted", totalRefreshes, windowsCompleted, elapsed);
    }
    if (isTokenApproachingExpiry(username)) {
      console.log(`[refresh] ⏰ Token approche expiration — arrêt refresh`);
      return makeResult("token_expiring", totalRefreshes, windowsCompleted, elapsed);
    }
    if (totalRefreshes >= MAX_TOTAL_REFRESHES) {
      console.log(`[refresh] 🛑 Max refreshes atteint (${totalRefreshes}) — arrêt`);
      return makeResult("max_refreshes", totalRefreshes, windowsCompleted, elapsed);
    }

    // ── Durée de cette fenêtre (variable) ──
    const windowDuration = gaussianInterval(REFRESH_WINDOW_MIN_MS, REFRESH_WINDOW_MAX_MS);
    const windowDurationMin = Math.round(windowDuration / 60000 * 10) / 10;
    console.log(`[refresh] 📺 Fenêtre #${windowIdx + 1} — durée cible ${windowDurationMin} min`);

    const windowStart = Date.now();
    let windowRefreshes = 0;

    // ── Boucle de refresh dans la fenêtre ──
    while (Date.now() - windowStart < windowDuration) {
      // Vérifications rapides
      if (isTokenApproachingExpiry(username)) {
        return makeResult("token_expiring", totalRefreshes, windowsCompleted, Date.now() - startTime);
      }
      if (isSessionFrozen(username)) {
        return makeResult("proxy_dead", totalRefreshes, windowsCompleted, Date.now() - startTime);
      }

      // ── Exécuter le refresh léger ──
      const refreshResult = await doLightweightRefresh(config);
      totalRefreshes++;
      windowRefreshes++;

      // Mettre à jour l'activité de session (évite le timeout 15 min)
      updateSessionActivity(username);

      if (refreshResult.slotDetected) {
        const totalElapsed = Date.now() - startTime;
        console.log(`[refresh] 🚨 SLOT DÉTECTÉ au refresh #${totalRefreshes} (fenêtre #${windowIdx + 1}, ${Math.round(totalElapsed / 1000)}s écoulées)`);
        botLog({
          applicationId: job.id,
          step: "continuous_refresh_slot_detected",
          status: "ok",
          data: {
            refreshNumber: totalRefreshes,
            windowNumber: windowIdx + 1,
            windowRefreshes,
            totalElapsedSec: Math.round(totalElapsed / 1000),
            firstAvailableMonth: refreshResult.firstAvailableMonth,
            ofc: refreshResult.ofcName,
            fastPath: !!refreshResult.slotReady,
          },
        });
        return {
          slotDetected: true,
          totalRefreshes,
          windowsCompleted: windowIdx,
          totalDurationMs: totalElapsed,
          stopReason: "slot_found",
          firstAvailableMonth: refreshResult.firstAvailableMonth,
          slotReady: refreshResult.slotReady,
        };
      }

      if (refreshResult.error) {
        // Erreur critique (401, 403, 429) → propager
        return makeResult("error", totalRefreshes, windowsCompleted, Date.now() - startTime);
      }

      // ── Pause variable avant le prochain refresh (30-120s, gaussien) ──
      const interval = gaussianInterval(REFRESH_INTERVAL_MIN_MS, REFRESH_INTERVAL_MAX_MS);
      const intervalSec = Math.round(interval / 1000);

      // Log discret (pas à chaque refresh pour ne pas spammer)
      if (windowRefreshes % 3 === 0 || windowRefreshes === 1) {
        console.log(`[refresh] 🔄 Refresh #${totalRefreshes} (fenêtre #${windowIdx + 1}) — pas de slot — prochain dans ${intervalSec}s`);
      }

      // Attendre avec micro-variations (humain n'attend pas au ms près)
      const jitter = (Math.random() - 0.5) * 4000; // ±2s de jitter
      await new Promise(r => setTimeout(r, Math.max(5000, interval + jitter)));

      // Vérification budget global
      if (Date.now() - startTime >= TOTAL_REFRESH_BUDGET_MS) break;
      if (totalRefreshes >= MAX_TOTAL_REFRESHES) break;
    }

    // Fenêtre complétée
    windowsCompleted++;
    const windowElapsed = Math.round((Date.now() - windowStart) / 1000);
    console.log(`[refresh] ✅ Fenêtre #${windowIdx + 1} terminée — ${windowRefreshes} refreshes en ${windowElapsed}s`);
    botLog({
      applicationId: job.id,
      step: "continuous_refresh_window_done",
      status: "ok",
      data: {
        windowNumber: windowIdx + 1,
        windowRefreshes,
        windowDurationSec: windowElapsed,
        totalRefreshes,
        totalElapsedMin: Math.round((Date.now() - startTime) / 60000),
      },
    });

    // ── Pause entre les fenêtres (humain regarde son téléphone) ──
    if (windowIdx < MAX_WINDOWS - 1) {
      const breakDuration = gaussianInterval(BREAK_MIN_MS, BREAK_MAX_MS);
      const breakSec = Math.round(breakDuration / 1000);
      console.log(`[refresh] ☕ Pause inter-fenêtre: ${breakSec}s (humain distrait)`);

      // Pendant la pause, vérifier périodiquement le proxy
      const breakStart = Date.now();
      while (Date.now() - breakStart < breakDuration) {
        const chunk = Math.min(30000, breakDuration - (Date.now() - breakStart));
        await new Promise(r => setTimeout(r, chunk));

        // Vérifier le proxy toutes les 30s pendant la pause
        if (isSessionFrozen(username)) {
          return makeResult("proxy_dead", totalRefreshes, windowsCompleted, Date.now() - startTime);
        }
      }
    }
  }

  // Toutes les fenêtres épuisées
  const totalElapsed = Date.now() - startTime;
  console.log(`[refresh] 🏁 Refresh continu terminé — ${totalRefreshes} refreshes en ${Math.round(totalElapsed / 60000)} min, ${windowsCompleted} fenêtres`);
  botLog({
    applicationId: job.id,
    step: "continuous_refresh_end",
    status: "ok",
    data: {
      totalRefreshes,
      windowsCompleted,
      totalDurationMin: Math.round(totalElapsed / 60000),
      stopReason: "max_windows",
    },
  });
  return makeResult("max_windows", totalRefreshes, windowsCompleted, totalElapsed);
}

// ─── Refresh léger (1 requête par OFC) ──────────────────────────────────────

interface LightRefreshResult {
  slotDetected: boolean;
  firstAvailableMonth?: string;
  ofcName?: string;
  error?: boolean;
  /** Fast-path: slot fully resolved (dates + times) ready for instant booking. */
  slotReady?: SlotReadyForBooking;
}

/**
 * Refresh léger : appelle getFirstAvailableMonth pour chaque OFC.
 * Si un slot est détecté : enchaine IMMÉDIATEMENT getSlotDates + getSlotTime
 * pour avoir le slotId prêt pour le booking (fast-path, -5s de latence).
 */
async function doLightweightRefresh(config: ContinuousRefreshConfig): Promise<LightRefreshResult> {
  const { session, ofcs, appDetails, referer, rescheduleYN, dateFrom, dateDeadline } = config;

  // Headers pour les requêtes slot (Bearer uniquement, pas de cookies)
  const hdrs = authHeaders(session.accessToken, referer, true);

  for (const ofc of ofcs) {
    const basePayload: Record<string, unknown> = {
      postUserId: ofc.postUserId,
      applicantId: appDetails.applicantId,
      visaType: (appDetails as unknown as Record<string, unknown>).visaTypeKey ?? appDetails.visaType,
      visaClass: appDetails.visaClass,
      locationType: rescheduleYN
        ? (appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
        : (ofc.officeType ?? "OFC"),
      applicationId: appDetails.applicationId,
    };

    try {
      // ── Étape 1 : getFirstAvailableMonth (léger, 1 POST) ──
      const res = await usaFetch(USA_FIRST_AVAILABLE_MONTH_URL, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(basePayload),
      });

      // Erreurs critiques → propagation
      if (res.status === 429) {
        throw new RateLimitError("getFirstAvailableMonth/refresh", 60000);
      }
      if (res.status === 403) {
        throw new AccountBlockedError("getFirstAvailableMonth/refresh");
      }
      if (res.status === 401) {
        const body = await res.text().catch(() => "");
        if (isRestrictedBody(body)) {
          throw new AccountRestrictedError();
        }
        throw new TokenExpiredError();
      }

      if (!res.ok) {
        continue;
      }

      const data = await res.json() as { present?: boolean; date?: string };

      if (!data.present || !data.date) {
        continue; // Pas de slot pour cet OFC
      }

      // Vérifier que la date est dans la fenêtre autorisée
      if (dateDeadline && data.date > dateDeadline) {
        continue; // Slot détecté mais hors fenêtre
      }

      // ══════════════════════════════════════════════════════════════════════
      // 🚨 SLOT DÉTECTÉ — FAST-PATH : enchainer getSlotDates + getSlotTime
      // pour avoir le slotId prêt IMMÉDIATEMENT (économise 5-8s vs re-scan)
      // ══════════════════════════════════════════════════════════════════════
      console.log(`[refresh] ⚡ FAST-PATH: slot détecté OFC ${ofc.postName} (mois: ${data.date}) — résolution directe...`);

      // ── Étape 2 : getSlotDates ──
      const monthStart = new Date(data.date);
      monthStart.setHours(0, 0, 0, 0);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      let fromDateStr = monthStart > tomorrow ? toYMD(monthStart) : toYMD(tomorrow);
      if (dateFrom && dateFrom > fromDateStr) fromDateStr = dateFrom;
      let toDateStr = lastDayOfMonth(monthStart);
      if (dateDeadline && dateDeadline < toDateStr) toDateStr = dateDeadline;

      if (fromDateStr > toDateStr) {
        // Pas de dates valides dans la fenêtre malgré present:true
        return { slotDetected: true, firstAvailableMonth: data.date, ofcName: ofc.postName };
      }

      const datesRes = await usaFetch(USA_SLOT_DATES_URL, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ ...basePayload, fromDate: fromDateStr, toDate: toDateStr }),
      });

      if (!datesRes.ok) {
        // Fallback : retourne slot détecté sans fast-path (le re-scan normal prendra le relais)
        console.warn(`[refresh] ⚡ getSlotDates HTTP ${datesRes.status} — fallback re-scan`);
        return { slotDetected: true, firstAvailableMonth: data.date, ofcName: ofc.postName };
      }

      const datesRaw = await datesRes.json();
      let slotDates: UsaSlotDate[] = [];
      if (Array.isArray(datesRaw) && datesRaw.length > 0) {
        if (typeof datesRaw[0] === "string") {
          slotDates = (datesRaw as string[]).map(d => ({ date: d.split("T")[0], slotsAvailable: 1 }));
        } else {
          slotDates = datesRaw as UsaSlotDate[];
        }
      }

      // Filtrer par fenêtre admin
      slotDates = slotDates.filter(d => {
        if (dateFrom && d.date < dateFrom) return false;
        if (dateDeadline && d.date > dateDeadline) return false;
        return true;
      });

      if (slotDates.length === 0) {
        console.warn(`[refresh] ⚡ getSlotDates vide après filtrage — fallback re-scan`);
        return { slotDetected: true, firstAvailableMonth: data.date, ofcName: ofc.postName };
      }

      const targetDate = slotDates[0].date;
      console.log(`[refresh] ⚡ Date: ${targetDate} — appel getSlotTime...`);

      // ── Étape 3 : getSlotTime ──
      const timePayload = {
        fromDate: fromDateStr,
        toDate: toDateStr,
        postUserId: basePayload.postUserId,
        applicantId: basePayload.applicantId,
        slotDate: targetDate,
        visaType: basePayload.visaType,
        visaClass: basePayload.visaClass,
        applicationId: basePayload.applicationId,
        // PAS de locationType ici (conforme au bundle Angular)
      };

      const timeRes = await usaFetch(USA_SLOT_TIMES_URL, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(timePayload),
      });

      if (!timeRes.ok) {
        console.warn(`[refresh] ⚡ getSlotTime HTTP ${timeRes.status} — fallback re-scan`);
        return { slotDetected: true, firstAvailableMonth: data.date, ofcName: ofc.postName };
      }

      const timeSlots = (await timeRes.json()) as UsaTimeSlot[];
      if (!Array.isArray(timeSlots) || timeSlots.length === 0) {
        console.warn(`[refresh] ⚡ getSlotTime vide — slot disparu? fallback re-scan`);
        return { slotDetected: true, firstAvailableMonth: data.date, ofcName: ofc.postName };
      }

      // Prendre le premier créneau disponible
      const bestSlot = timeSlots[0];
      const slotTime = bestSlot.startTime ?? bestSlot.time ?? "unknown";
      const slotId = bestSlot.slotId ?? bestSlot.id ?? "unknown";

      console.log(`[refresh] ⚡ FAST-PATH COMPLET: ${ofc.postName} ${targetDate} ${slotTime} (slotId=${slotId})`);

      return {
        slotDetected: true,
        firstAvailableMonth: data.date,
        ofcName: ofc.postName,
        slotReady: {
          date: targetDate,
          time: slotTime,
          slotId,
          ofcName: ofc.postName,
          slot: bestSlot,
          bookingBase: basePayload,
        },
      };

    } catch (err) {
      // Erreurs circuit-breaker → signal d'arrêt
      if (
        err instanceof RateLimitError ||
        err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError ||
        err instanceof AccountRestrictedError
      ) {
        console.error(`[refresh] ⛔ Erreur critique pendant refresh: ${err.constructor.name}`);
        return { slotDetected: false, error: true };
      }
      // Erreur réseau/timeout → continuer (non fatal)
      console.warn(`[refresh] ⚠️ Erreur refresh OFC ${ofc.postName}: ${err}`);
    }
  }

  // Aucun slot détecté sur aucun OFC
  return { slotDetected: false };
}

// ─── Helper résultat ────────────────────────────────────────────────────────

function makeResult(
  stopReason: ContinuousRefreshResult["stopReason"],
  totalRefreshes: number,
  windowsCompleted: number,
  totalDurationMs: number,
): ContinuousRefreshResult {
  return { slotDetected: false, totalRefreshes, windowsCompleted, totalDurationMs, stopReason };
}
