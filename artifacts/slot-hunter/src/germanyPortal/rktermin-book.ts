// ─── Germany RK-Termin — Booking Logic ──────────────────────────────────────
// Réserve un créneau : affiche le formulaire, résout le captcha, soumet.

import { RKTERMIN_ENDPOINTS, RKTERMIN_PATTERNS, RKTERMIN_TIMING } from "./config.js";
import { rkGet, rkPost, randomDelay, updateSession } from "./rktermin-session.js";
import { extractCaptchaBase64, solveImageCaptcha } from "./rktermin-captcha.js";
import type { RKTerminConfig, RKTerminSession, RKTerminBookingResult, RKTerminTimeSlot } from "./types.js";

const log = (level: string, msg: string) => console.log(`[${new Date().toISOString()}] [rktermin-book] [${level}] ${msg}`);

/**
 * Réserve un créneau RK-Termin.
 * Flow: GET showForm (captcha) → résoudre → POST addAppointment → confirmation.
 */
export async function bookSlot(
  session: RKTerminSession,
  config: RKTerminConfig,
  slot: RKTerminTimeSlot,
): Promise<{ session: RKTerminSession; result: RKTerminBookingResult }> {
  log("INFO", `Tentative de réservation: ${slot.date} ${slot.timeFrom}-${slot.timeTo} (openingPeriodId=${slot.openingPeriodId})`);
  
  // 1. GET appointment_showForm → récupérer le formulaire avec captcha
  await randomDelay(RKTERMIN_TIMING.interRequestDelayMs.min, RKTERMIN_TIMING.interRequestDelayMs.max);
  
  const { html: formHtml, newSession } = await rkGet(
    session,
    RKTERMIN_ENDPOINTS.appointmentShowForm,
    {
      locationCode: config.locationCode,
      realmId: config.realmId,
      categoryId: config.categoryId,
      dateStr: slot.date,
      openingPeriodId: slot.openingPeriodId,
    },
  );
  
  if (newSession) session = updateSession(session, newSession);

  // 1b. Extraire les champs hidden du formulaire (tokens anti-CSRF, openingPeriodId signé, etc.)
  //     Le portail RK-Termin valide ces tokens côté serveur — sans eux il retourne
  //     "An error occurred… address changed manually" même si la session est encore valide.
  const hiddenFields = extractHiddenFields(formHtml);
  log("DEBUG", `Champs hidden extraits: ${Object.keys(hiddenFields).join(", ") || "aucun"}`);

  // 2. Extraire le captcha du formulaire
  const captchaB64 = extractCaptchaBase64(formHtml);
  if (!captchaB64) {
    log("ERROR", "Captcha non trouvé dans le formulaire de booking");
    return {
      session,
      result: { status: "error", errorMessage: "Captcha non trouvé dans le formulaire" },
    };
  }
  
  // 3. Résoudre le captcha (avec retry)
  for (let attempt = 1; attempt <= RKTERMIN_TIMING.maxCaptchaRetries; attempt++) {
    const captchaResult = await solveImageCaptcha(captchaB64);
    
    if (captchaResult.status !== "solved" || !captchaResult.text) {
      log("WARN", `Captcha booking non résolu (attempt ${attempt}/${RKTERMIN_TIMING.maxCaptchaRetries})`);
      if (attempt === RKTERMIN_TIMING.maxCaptchaRetries) {
        return { session, result: { status: "captcha_failed" } };
      }
      continue;
    }
    
    // 4. Construire les données du formulaire
    await randomDelay(RKTERMIN_TIMING.postCaptchaPauseMs.min, RKTERMIN_TIMING.postCaptchaPauseMs.max);
    
    // Partir des champs hidden extraits du formulaire (tokens anti-CSRF, etc.)
    // puis écraser/compléter avec nos valeurs — l'ordre garantit que nos champs
    // ont priorité sur les defaults du serveur mais que les tokens restent présents.
    const formData: Record<string, string> = {
      ...hiddenFields,
      lastname: config.applicantLastname,
      firstname: config.applicantFirstname,
      email: config.applicantEmail,
      emailrepeat: config.applicantEmail,
      captchaText: captchaResult.text,
      locationCode: config.locationCode,
      realmId: String(config.realmId),
      categoryId: String(config.categoryId),
      openingPeriodId: slot.openingPeriodId,
      date: slot.date,
      dateStr: slot.date,
      "action:appointment_addAppointment": "Submit",
    };
    
    // Ajouter les champs dynamiques
    for (const field of config.dynamicFields) {
      formData[`fields[${field.index}].content`] = field.content;
      formData[`fields[${field.index}].definitionId`] = String(field.definitionId);
      formData[`fields[${field.index}].index`] = String(field.index);
    }
    
    log("DEBUG", `Soumission booking: ${config.applicantLastname} ${config.applicantFirstname} → ${slot.date} ${slot.timeFrom}`);
    
    // 5. POST appointment_addAppointment
    const { html: resultHtml, newSession: ns2 } = await rkPost(
      session,
      RKTERMIN_ENDPOINTS.appointmentAddAppointment,
      formData,
    );
    
    if (ns2) session = updateSession(session, ns2);
    
    // 6. Analyser la réponse
    const bookingResult = parseBookingResponse(resultHtml, slot);
    
    if (bookingResult.status === "booked") {
      log("INFO", `✅ RÉSERVATION RÉUSSIE! N° ${bookingResult.confirmationNumber} — ${slot.date} ${slot.timeFrom}-${slot.timeTo}`);
      return { session, result: bookingResult };
    }
    
    // Captcha incorrect → retry avec formulaire frais
    if (RKTERMIN_PATTERNS.captchaWrong.test(resultHtml)) {
      log("WARN", `Captcha booking incorrect (attempt ${attempt}): "${captchaResult.text}"`);
      
      if (attempt < RKTERMIN_TIMING.maxCaptchaRetries) {
        // Re-fetch le formulaire pour un nouveau captcha
        await randomDelay(1000, 2000);
        const { html: freshForm, newSession: ns3 } = await rkGet(
          session,
          RKTERMIN_ENDPOINTS.appointmentShowForm,
          {
            locationCode: config.locationCode,
            realmId: config.realmId,
            categoryId: config.categoryId,
            dateStr: slot.date,
            openingPeriodId: slot.openingPeriodId,
          },
        );
        if (ns3) session = updateSession(session, ns3);
        // Continuer avec le nouveau captcha dans la prochaine itération
        continue;
      }
      return { session, result: { status: "captcha_failed" } };
    }
    
    // Autre erreur (validation, slot pris, etc.)
    return { session, result: bookingResult };
  }
  
  return { session, result: { status: "captcha_failed" } };
}

// ─── Parser la réponse de booking ───────────────────────────────────────────

function parseBookingResponse(html: string, slot: RKTerminTimeSlot): RKTerminBookingResult {
  // Succès ?
  if (RKTERMIN_PATTERNS.bookingSuccess.test(html)) {
    // Extraire le numéro de confirmation
    const confMatch = html.match(RKTERMIN_PATTERNS.confirmationNumber);
    const confirmationNumber = confMatch?.[1] ?? confMatch?.[2] ?? confMatch?.[3] ?? "unknown";
    
    return {
      status: "booked",
      confirmationNumber,
      bookedDate: slot.date,
      bookedTime: `${slot.timeFrom} — ${slot.timeTo}`,
      bookedLocation: extractLocation(html),
    };
  }
  
  // Captcha incorrect ?
  if (RKTERMIN_PATTERNS.captchaWrong.test(html)) {
    return { status: "captcha_failed" };
  }
  
  // Erreur de validation email ?
  if (RKTERMIN_PATTERNS.emailValidationError.test(html)) {
    return {
      status: "validation_error",
      validationError: "Email invalide",
    };
  }
  
  // Créneau déjà pris ?
  if (RKTERMIN_PATTERNS.slotTaken.test(html)) {
    return { status: "slot_taken" };
  }
  
  // Autre erreur — extraire le message depuis les balises d'erreur courantes
  const errorPatterns = [
    /<div[^>]*class="[^"]*error[^"]*"[^>]*>(.*?)<\/div>/is,
    /<p[^>]*class="[^"]*error[^"]*"[^>]*>(.*?)<\/p>/is,
    /<span[^>]*class="[^"]*error[^"]*"[^>]*>(.*?)<\/span>/is,
    /<div[^>]*class="[^"]*alert[^"]*"[^>]*>(.*?)<\/div>/is,
    /<li[^>]*class="[^"]*error[^"]*"[^>]*>(.*?)<\/li>/is,
  ];
  for (const pattern of errorPatterns) {
    const m = html.match(pattern);
    const text = m?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (text && text.length > 3) {
      return { status: "validation_error", validationError: text.slice(0, 300) };
    }
  }

  // Succès avec texte alternatif (certaines ambassades utilisent d'autres formulations)
  if (/appointment.*confirm|termin.*bestät|rendez-vous.*confirm|booked.*successfully|Buchung.*erfolgreich/i.test(html)) {
    const confMatch = html.match(RKTERMIN_PATTERNS.confirmationNumber);
    const confirmationNumber = confMatch?.[1] ?? confMatch?.[2] ?? confMatch?.[3] ?? "unknown";
    return {
      status: "booked",
      confirmationNumber,
      bookedDate: slot.date,
      bookedTime: `${slot.timeFrom} — ${slot.timeTo}`,
      bookedLocation: extractLocation(html),
    };
  }

  // Réponse inattendue — logguer l'HTML pour diagnostic
  const snippet = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  console.log(`[rktermin-book] [DEBUG] Réponse inattendue — extrait texte: "${snippet}"`);

  return {
    status: "error",
    errorMessage: "Réponse inattendue du serveur (ni succès ni erreur détectée)",
  };
}

/** Extrait la localisation depuis la page de confirmation. */
function extractLocation(html: string): string {
  const locMatch = html.match(/Location:\s*([^<]+)|Ort:\s*([^<]+)/i);
  return locMatch?.[1]?.trim() ?? locMatch?.[2]?.trim() ?? "Kinshasa";
}

/**
 * Extrait tous les champs `<input type="hidden">` d'un formulaire HTML.
 * Ces tokens anti-CSRF sont obligatoires dans le POST — sans eux le portail
 * retourne "An error occurred… address changed manually".
 */
function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Matcher toutes les variantes d'ordre des attributs
  const hiddenRe = /<input[^>]+type=["']?hidden["']?[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hiddenRe.exec(html)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/\bname=["']([^"']*)["']/i);
    const valueMatch = tag.match(/\bvalue=["']([^"']*)["']/i);
    if (nameMatch?.[1]) {
      fields[nameMatch[1]] = valueMatch?.[1] ?? "";
    }
  }
  return fields;
}
