// ─── Germany RK-Termin — Scan Logic ─────────────────────────────────────────
// Scanne le calendrier et détecte les créneaux disponibles.

import { RKTERMIN_ENDPOINTS, RKTERMIN_PATTERNS, RKTERMIN_TIMING } from "./config.js";
import { initSession, rkGet, rkPost, randomDelay, updateSession, isSessionValid } from "./rktermin-session.js";
import { extractCaptchaBase64, solveImageCaptcha } from "./rktermin-captcha.js";
import type { RKTerminConfig, RKTerminSession, RKTerminMonthResult, RKTerminDayResult, RKTerminTimeSlot } from "./types.js";

const log = (level: string, msg: string) => console.log(`[${new Date().toISOString()}] [rktermin-scan] [${level}] ${msg}`);

/**
 * Scan complet du mois : init session → résoudre captcha → parser calendrier.
 * Retourne les dates disponibles.
 */
export async function scanMonth(config: RKTerminConfig): Promise<{ session: RKTerminSession; result: RKTerminMonthResult }> {
  // 1. Initialiser la session (GET appointment_showMonth → captcha)
  const { session: freshSession, html: captchaPage } = await initSession(config);
  let session = freshSession;
  
  // 2. Vérifier s'il y a un message "pas de créneaux" AVANT le captcha
  if (RKTERMIN_PATTERNS.noAppointments.test(captchaPage)) {
    log("INFO", `Aucun créneau disponible pour ${config.locationCode} cat=${config.categoryId}`);
    return {
      session,
      result: { status: "no_dates", availableDates: [] },
    };
  }
  
  // 3. Extraire et résoudre le captcha
  const captchaB64 = extractCaptchaBase64(captchaPage);
  if (!captchaB64) {
    log("ERROR", "Captcha non trouvé dans la page month");
    return {
      session,
      result: { status: "error", availableDates: [], errorMessage: "Captcha non trouvé" },
    };
  }
  
  // Retry loop captcha — on garde une référence mutable à l'image courante.
  // Chaque tentative incorrecte ouvre une nouvelle session et récupère une
  // nouvelle image : sans ça CapSolver reçoit 3× la même image et retourne
  // 3× le même mauvais résultat (réponse cachée côté CapSolver).
  let currentCaptchaB64 = captchaB64;

  for (let attempt = 1; attempt <= RKTERMIN_TIMING.maxCaptchaRetries; attempt++) {
    const captchaResult = await solveImageCaptcha(currentCaptchaB64);
    
    if (captchaResult.status !== "solved" || !captchaResult.text) {
      log("WARN", `Captcha month non résolu (attempt ${attempt}/${RKTERMIN_TIMING.maxCaptchaRetries})`);
      if (attempt === RKTERMIN_TIMING.maxCaptchaRetries) {
        return { session, result: { status: "captcha_failed", availableDates: [] } };
      }
      continue;
    }
    
    // 4. Soumettre le captcha
    await randomDelay(RKTERMIN_TIMING.postCaptchaPauseMs.min, RKTERMIN_TIMING.postCaptchaPauseMs.max);
    
    const formData: Record<string, string> = {
      captchaText: captchaResult.text,
      locationCode: config.locationCode,
      realmId: String(config.realmId),
      categoryId: String(config.categoryId),
      openingPeriodId: "",
      date: "",
      dateStr: "",
      rebooking: "",
      token: "",
      lastname: "",
      firstname: "",
      email: "",
      "action:appointment_showMonth": "Continue",
    };
    
    const { html: calendarHtml, newSession } = await rkPost(
      session,
      RKTERMIN_ENDPOINTS.appointmentShowMonth,
      formData,
    );
    
    if (newSession) session = updateSession(session, newSession);
    
    // 5. Vérifier si le captcha était correct
    if (RKTERMIN_PATTERNS.captchaWrong.test(calendarHtml)) {
      log("WARN", `Captcha month incorrect (attempt ${attempt}): "${captchaResult.text}"`);
      
      if (attempt < RKTERMIN_TIMING.maxCaptchaRetries) {
        // Nouvelle session → nouvelle image captcha (diplo.de régénère le captcha).
        // On met à jour currentCaptchaB64 pour que le prochain appel
        // solveImageCaptcha() envoie la nouvelle image, pas l'ancienne.
        const { session: retrySession, html: retryPage } = await initSession(config);
        session = retrySession;
        const newCaptcha = extractCaptchaBase64(retryPage);
        if (!newCaptcha) {
          return { session, result: { status: "error", availableDates: [], errorMessage: "Captcha retry failed" } };
        }
        currentCaptchaB64 = newCaptcha; // ← image fraîche pour le prochain tour
        continue;
      }
      return { session, result: { status: "captcha_failed", availableDates: [] } };
    }
    
    // 6. Parser le calendrier
    session.monthCaptchaSolved = true;
    const result = parseCalendarHtml(calendarHtml);
    
    log("INFO", `Scan month terminé: ${result.availableDates.length} dates trouvées (mois: ${result.displayedMonth ?? "?"})`);
    return { session, result };
  }
  
  return { session, result: { status: "captcha_failed", availableDates: [] } };
}

/**
 * Scan des créneaux horaires pour un jour donné.
 * Nécessite une session avec captcha month déjà résolu.
 */
export async function scanDay(
  session: RKTerminSession,
  config: RKTerminConfig,
  dateStr: string,
): Promise<{ session: RKTerminSession; result: RKTerminDayResult }> {
  log("DEBUG", `Scan day: ${dateStr}`);
  
  await randomDelay(RKTERMIN_TIMING.interRequestDelayMs.min, RKTERMIN_TIMING.interRequestDelayMs.max);
  
  // GET appointment_showDay — PAS de captcha si session déjà validée
  const { html: dayHtml, newSession } = await rkGet(
    session,
    RKTERMIN_ENDPOINTS.appointmentShowDay,
    {
      locationCode: config.locationCode,
      realmId: config.realmId,
      categoryId: config.categoryId,
      dateStr,
    },
  );
  
  if (newSession) session = updateSession(session, newSession);
  
  // Vérifier si un captcha est nécessaire pour la vue jour
  const dayCaptcha = extractCaptchaBase64(dayHtml);
  if (dayCaptcha) {
    log("DEBUG", "Captcha day détecté — résolution...");
    
    for (let attempt = 1; attempt <= RKTERMIN_TIMING.maxCaptchaRetries; attempt++) {
      const captchaResult = await solveImageCaptcha(dayCaptcha);
      if (captchaResult.status !== "solved" || !captchaResult.text) {
        if (attempt === RKTERMIN_TIMING.maxCaptchaRetries) {
          return { session, result: { status: "captcha_failed", slots: [], date: dateStr } };
        }
        continue;
      }
      
      await randomDelay(RKTERMIN_TIMING.postCaptchaPauseMs.min, RKTERMIN_TIMING.postCaptchaPauseMs.max);
      
      const { html: dayResult, newSession: ns2 } = await rkPost(session, RKTERMIN_ENDPOINTS.appointmentShowDay, {
        captchaText: captchaResult.text,
        locationCode: config.locationCode,
        realmId: String(config.realmId),
        categoryId: String(config.categoryId),
        openingPeriodId: "",
        date: dateStr,
        dateStr,
        rebooking: "",
        token: "",
        lastname: "",
        firstname: "",
        email: "",
        "action:appointment_showDay": "Continue",
      });
      
      if (ns2) session = updateSession(session, ns2);
      
      if (RKTERMIN_PATTERNS.captchaWrong.test(dayResult)) {
        log("WARN", `Captcha day incorrect (attempt ${attempt})`);
        continue;
      }
      
      // Parser les créneaux
      const slots = parseDayHtml(dayResult, dateStr);
      return { session, result: slots };
    }
    
    return { session, result: { status: "captcha_failed", slots: [], date: dateStr } };
  }
  
  // Pas de captcha — parser directement
  const result = parseDayHtml(dayHtml, dateStr);
  return { session, result };
}

// ─── Helpers de parsing ─────────────────────────────────────────────────────

/** Parse le HTML du calendrier mensuel pour extraire les dates disponibles. */
function parseCalendarHtml(html: string): RKTerminMonthResult {
  // Dates disponibles (liens appointment_showDay)
  const dates: string[] = [];
  const dayRegex = new RegExp(RKTERMIN_PATTERNS.availableDayLinks.source, "g");
  let match: RegExpExecArray | null;
  while ((match = dayRegex.exec(html)) !== null) {
    if (match[1] && !dates.includes(match[1])) {
      dates.push(match[1]);
    }
  }
  
  // Mois affiché (format MM/YYYY)
  const monthMatch = html.match(RKTERMIN_PATTERNS.displayedMonth);
  const displayedMonth = monthMatch?.[1];
  
  // Période réservable
  const periodMatch = html.match(RKTERMIN_PATTERNS.bookingPeriod);
  const bookingPeriod = periodMatch ? `${periodMatch[1]} — ${periodMatch[2]}` : undefined;

  // Liens de navigation mois (dateStr des liens appointment_showMonth dans la page)
  const nextMonthDateStrs: string[] = [];
  const navRegex = new RegExp(RKTERMIN_PATTERNS.nextMonth.source, "g");
  let navMatch: RegExpExecArray | null;
  while ((navMatch = navRegex.exec(html)) !== null) {
    const dateStr = navMatch[1];
    if (dateStr && !nextMonthDateStrs.includes(dateStr)) {
      nextMonthDateStrs.push(dateStr);
    }
  }
  // Filtrer pour ne garder que les mois futurs par rapport au mois affiché.
  // displayedMonth est au format "MM/YYYY", dateStr est au format "MM.YYYY".
  // On convertit en nombre YYYYMM pour la comparaison.
  const currentYM = displayedMonth
    ? (() => { const [mm, yyyy] = displayedMonth.split("/"); return parseInt(yyyy) * 100 + parseInt(mm); })()
    : 0;
  const futureMonthDateStrs = nextMonthDateStrs.filter(ds => {
    // Tenter format MM.YYYY
    const parts = ds.split(".");
    if (parts.length === 2) {
      const ym = parseInt(parts[1]) * 100 + parseInt(parts[0]);
      return ym > currentYM;
    }
    // Tenter format dd.MM.YYYY (cas improbable pour une nav mois)
    if (parts.length === 3) {
      const ym = parseInt(parts[2]) * 100 + parseInt(parts[1]);
      return ym > currentYM;
    }
    return false;
  });

  if (dates.length === 0) {
    // Vérifier si "aucun créneau" explicite
    if (RKTERMIN_PATTERNS.noAppointments.test(html)) {
      return { status: "no_dates", availableDates: [], displayedMonth, bookingPeriod, nextMonthDateStrs: futureMonthDateStrs };
    }
    // Calendrier affiché mais aucun jour cliquable
    return { status: "no_dates", availableDates: [], displayedMonth, bookingPeriod, nextMonthDateStrs: futureMonthDateStrs };
  }
  
  return { status: "dates_found", availableDates: dates, displayedMonth, bookingPeriod, nextMonthDateStrs: futureMonthDateStrs };
}

/** Parse le HTML de la vue jour pour extraire les créneaux. */
function parseDayHtml(html: string, date: string): RKTerminDayResult {
  const slots: RKTerminTimeSlot[] = [];
  
  // Chercher les liens appointment_showForm (créneaux réservables)
  const slotRegex = new RegExp(RKTERMIN_PATTERNS.bookableSlotLinks.source, "g");
  let slotMatch: RegExpExecArray | null;
  while ((slotMatch = slotRegex.exec(html)) !== null) {
    const params = slotMatch[1];
    const periodMatch = params.match(RKTERMIN_PATTERNS.openingPeriodId);
    if (periodMatch) {
      slots.push({
        date,
        timeFrom: "", // sera enrichi ci-dessous
        timeTo: "",
        openingPeriodId: periodMatch[1],
        available: true,
      });
    }
  }
  
  // Extraire les heures depuis le contenu texte
  // Pattern: "10:30 — 11:00" suivi de "Book this appointment"
  const timeRegex = /(\d{1,2}:\d{2})\s*[—–\-]\s*(\d{1,2}:\d{2})/g;
  const times: Array<{ from: string; to: string }> = [];
  let timeMatch: RegExpExecArray | null;
  while ((timeMatch = timeRegex.exec(html)) !== null) {
    times.push({ from: timeMatch[1], to: timeMatch[2] });
  }
  
  // Associer les heures aux slots (dans l'ordre d'apparition)
  // Les créneaux "complets" n'ont pas de lien showForm, donc on filtre
  let slotIdx = 0;
  const sections = html.split(/\d{1,2}:\d{2}\s*[—–\-]\s*\d{1,2}:\d{2}/);
  const timeMatches = [...html.matchAll(/(\d{1,2}:\d{2})\s*[—–\-]\s*(\d{1,2}:\d{2})/g)];
  
  for (let i = 0; i < timeMatches.length; i++) {
    const afterTime = sections[i + 1] ?? "";
    const isBookable = /appointment_showForm|Book this appointment|Buchen/i.test(afterTime.split(/\d{1,2}:\d{2}/)[0] ?? afterTime.slice(0, 500));
    
    if (isBookable && slotIdx < slots.length) {
      slots[slotIdx].timeFrom = timeMatches[i][1];
      slots[slotIdx].timeTo = timeMatches[i][2];
      slotIdx++;
    }
  }
  
  // Fallback: si les heures n'ont pas pu être associées, utiliser l'ordre simple
  if (slots.length > 0 && !slots[0].timeFrom && times.length > 0) {
    // Trouver les créneaux réservables par position dans le HTML
    let bookableIdx = 0;
    for (let i = 0; i < times.length && bookableIdx < slots.length; i++) {
      // Vérifier si ce créneau est suivi par un lien "Book"
      slots[bookableIdx].timeFrom = times[i].from;
      slots[bookableIdx].timeTo = times[i].to;
      bookableIdx++;
    }
  }
  
  if (slots.length === 0) {
    return { status: "no_slots", slots: [], date };
  }
  
  log("INFO", `${slots.length} créneau(x) disponible(s) le ${date}: ${slots.map(s => `${s.timeFrom}-${s.timeTo}`).join(", ")}`);
  return { status: "slots_found", slots, date };
}

/**
 * Filtre les dates selon les préférences du dossier (slotDateFrom / slotDateDeadline).
 */
export function filterDatesByPreference(dates: string[], config: RKTerminConfig): string[] {
  if (!config.slotDateFrom && !config.slotDateDeadline) return dates;
  
  return dates.filter(dateStr => {
    const [day, month, year] = dateStr.split(".").map(Number);
    const date = new Date(year, month - 1, day);
    
    if (config.slotDateFrom) {
      const [fd, fm, fy] = config.slotDateFrom.split(".").map(Number);
      const from = new Date(fy, fm - 1, fd);
      if (date < from) return false;
    }
    
    if (config.slotDateDeadline) {
      const [dd, dm, dy] = config.slotDateDeadline.split(".").map(Number);
      const deadline = new Date(dy, dm - 1, dd);
      if (date > deadline) return false;
    }
    
    return true;
  });
}
