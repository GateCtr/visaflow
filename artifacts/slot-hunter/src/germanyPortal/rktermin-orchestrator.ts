// ─── Germany RK-Termin — Orchestrator ───────────────────────────────────────
// Orchestre le scan complet : month → day → book. Interface pour la boucle.

import { scanMonth, scanNextMonth, scanDay, filterDatesByPreference } from "./rktermin-scan.js";
import { bookSlot } from "./rktermin-book.js";
import { randomDelay } from "./rktermin-session.js";
import { RKTERMIN_TIMING } from "./config.js";
import type { RKTerminConfig, RKTerminScanResult, RKTerminTimeSlot } from "./types.js";

const log = (level: string, msg: string) => console.log(`[${new Date().toISOString()}] [rktermin] [${level}] ${msg}`);

/**
 * Exécute un scan complet RK-Termin pour un dossier :
 * 1. Scan month (résolution captcha + calendrier)
 * 2. Pour chaque date dispo → scan day (créneaux horaires)
 * 3. Si créneau trouvé → tentative de booking
 *
 * @param config Configuration du scan (ambassade, catégorie, applicant data)
 * @param autoBook Si true, réserve automatiquement le premier créneau trouvé
 * @returns Résultat du scan (slot_found, not_found, captcha_failed, error)
 */
export async function runGermanyScan(
  config: RKTerminConfig,
  autoBook: boolean = true,
): Promise<RKTerminScanResult> {
  const startMs = Date.now();
  let captchasSolved = 0;
  let datesScanned = 0;
  
  try {
    // ─── STEP 1: Scan du mois ───────────────────────────────────────────────
    log("INFO", `🇩🇪 Scan RK-Termin: ${config.locationCode} realm=${config.realmId} cat=${config.categoryId}`);
    
    const { session, result: monthResult } = await scanMonth(config);

    // Captcha échoué ou erreur réseau → arrêt immédiat (pas de session valide pour naviguer)
    if (monthResult.status === "captcha_failed") {
      log("WARN", "Captcha month échoué après retries");
      return {
        status: "captcha_failed",
        datesScanned: 0,
        captchasSolved,
        durationMs: Date.now() - startMs,
        errorMessage: "Captcha month failed",
      };
    }

    if (monthResult.status === "error") {
      return {
        status: "error",
        datesScanned: 0,
        captchasSolved,
        durationMs: Date.now() - startMs,
        errorMessage: monthResult.errorMessage,
      };
    }

    // Captcha du mois 1 résolu (qu'il y ait des dates ou non) — session valide pour naviguer
    captchasSolved += 1;

    if (monthResult.status === "no_dates") {
      log("INFO", `Mois 1 (${monthResult.displayedMonth ?? "?"}) : aucune date — navigation mois suivants...`);
    } else {
      log("INFO", `Mois 1 (${monthResult.displayedMonth ?? "?"}) : ${monthResult.availableDates.length} date(s)`);
    }

    // ─── STEP 2: Naviguer vers les mois suivants (sans captcha) ────────────
    // IMPORTANT: on navigue même si le mois 1 est vide — le mois 2 ou 3 peut avoir des dates.
    // La session est déjà validée par le captcha du mois 1 — pas de nouveau captcha nécessaire.
    let currentSession = session;
    const allAvailableDates: string[] = [...monthResult.availableDates];

    const nextMonthLinks = monthResult.nextMonthDateStrs ?? [];
    const extraMonths = Math.max(0, Math.min(6, config.maxExtraMonths ?? 2));
    const monthsToScan = nextMonthLinks.slice(0, extraMonths); // configurable, défaut 2
    let lastMonthResult = monthResult;

    for (let mIdx = 0; mIdx < monthsToScan.length; mIdx++) {
      const monthDateStr = monthsToScan[mIdx];
      const { session: ns, result: nextResult } = await scanNextMonth(currentSession, config, monthDateStr);
      currentSession = ns;
      if (nextResult.status === "dates_found" || nextResult.status === "no_dates") {
        allAvailableDates.push(...nextResult.availableDates);
        log("INFO", `Mois ${mIdx + 2} (${nextResult.displayedMonth ?? monthDateStr}) : ${nextResult.availableDates.length} date(s)`);
        lastMonthResult = nextResult;
      } else {
        log("WARN", `Scan mois ${monthDateStr} échoué (${nextResult.status}) — arrêt navigation`);
        break;
      }
    }

    log("INFO", `Total: ${allAvailableDates.length} date(s) sur ${1 + monthsToScan.length} mois scannés`);

    // ─── STEP 3: Filtrer les dates selon les préférences ────────────────────
    const filteredDates = filterDatesByPreference(allAvailableDates, config);
    
    if (filteredDates.length === 0) {
      log("INFO", `${allAvailableDates.length} dates trouvées mais aucune dans la plage souhaitée`);
      return {
        status: "not_found",
        datesScanned: allAvailableDates.length,
        captchasSolved,
        durationMs: Date.now() - startMs,
      };
    }
    
    log("INFO", `${filteredDates.length} date(s) dans la plage: ${filteredDates.join(", ")}`);
    
    // ─── STEP 4: Scan des créneaux pour chaque date ─────────────────────────
    let bestSlot: RKTerminTimeSlot | null = null;
    
    for (const dateStr of filteredDates) {
      datesScanned++;
      
      await randomDelay(RKTERMIN_TIMING.interRequestDelayMs.min, RKTERMIN_TIMING.interRequestDelayMs.max);
      
      const { session: updatedSession, result: dayResult } = await scanDay(currentSession, config, dateStr);
      currentSession = updatedSession;
      
      if (dayResult.status === "slots_found" && dayResult.slots.length > 0) {
        // Choisir le créneau le plus tôt de la journée (meilleur choix que « premier »)
        const sorted = [...dayResult.slots].sort((a, b) => a.timeFrom.localeCompare(b.timeFrom));
        bestSlot = sorted[0];
        captchasSolved++; // captcha day résolu
        log("INFO", `🎯 Créneau trouvé: ${bestSlot.date} ${bestSlot.timeFrom}-${bestSlot.timeTo} (openingPeriodId=${bestSlot.openingPeriodId})`);
        break;
      }
      if (dayResult.status === "no_slots") {
        // Pas de créneaux ce jour-là, mais captcha day résolu
        captchasSolved++;
      }
      
      if (dayResult.status === "captcha_failed") {
        log("WARN", `Captcha day échoué pour ${dateStr} — skip`);
        continue;
      }
    }
    
    if (!bestSlot) {
      log("INFO", `Aucun créneau horaire disponible dans les ${datesScanned} jour(s) scannés`);
      return {
        status: "not_found",
        datesScanned,
        captchasSolved,
        durationMs: Date.now() - startMs,
      };
    }
    
    // ─── STEP 4: Booking automatique ────────────────────────────────────────
    if (!autoBook) {
      log("INFO", "Auto-book désactivé — créneau détecté mais non réservé");
      return {
        status: "slot_found",
        datesScanned,
        captchasSolved,
        durationMs: Date.now() - startMs,
        booking: {
          status: "detected", // slot détecté mais NON réservé
          bookedDate: bestSlot.date,
          bookedTime: `${bestSlot.timeFrom} — ${bestSlot.timeTo}`,
        },
      };
    }
    
    log("INFO", "Tentative de réservation automatique...");
    
    const { result: bookingResult } = await bookSlot(currentSession, config, bestSlot);
    
    if (bookingResult.status === "booked") {
      captchasSolved++; // captcha de réservation résolu
      log("INFO", `🎉 RÉSERVATION CONFIRMÉE! N° ${bookingResult.confirmationNumber}`);
      return {
        status: "slot_found",
        booking: bookingResult,
        datesScanned,
        captchasSolved,
        durationMs: Date.now() - startMs,
      };
    }
    
    if (bookingResult.status === "slot_taken") {
      log("WARN", "Créneau pris par quelqu'un d'autre avant nous");
      return {
        status: "not_found",
        datesScanned,
        captchasSolved,
        durationMs: Date.now() - startMs,
        errorMessage: "Slot taken by another user",
      };
    }
    
    // Erreur de booking (validation, captcha, etc.)
    log("WARN", `Booking échoué: ${bookingResult.status} — ${bookingResult.validationError ?? bookingResult.errorMessage ?? ""}`);
    return {
      status: "error",
      datesScanned,
      captchasSolved,
      durationMs: Date.now() - startMs,
      errorMessage: bookingResult.validationError ?? bookingResult.errorMessage,
    };
    
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Scan crash: ${errMsg}`);
    return {
      status: "error",
      datesScanned,
      captchasSolved,
      durationMs: Date.now() - startMs,
      errorMessage: errMsg,
    };
  }
}
