// ─── Germany RK-Termin Portal — Types & Interfaces ──────────────────────────

/** Configuration pour un scan RK-Termin (extraite du hunterConfig). */
export interface RKTerminConfig {
  locationCode: string;       // "kins", "lago", "kamp", etc.
  realmId: number;            // ID du domaine (731, 1276, 1505...)
  categoryId: number;         // ID catégorie visa (3674, 3672, 3675...)
  locale: string;             // "en" ou "de"
  /** Données applicant pour le booking automatique */
  applicantLastname: string;
  applicantFirstname: string;
  applicantEmail: string;
  /** Champs dynamiques (varient par ambassade/catégorie) */
  dynamicFields: RKTerminDynamicField[];
  /** Date min souhaitée (format dd.MM.yyyy) — ignore les créneaux avant cette date */
  slotDateFrom?: string;
  /** Date max souhaitée (deadline, format dd.MM.yyyy) */
  slotDateDeadline?: string;
}

/** Champ dynamique du formulaire RK-Termin (ex: nationalité, n° passeport). */
export interface RKTerminDynamicField {
  definitionId: number;
  index: number;
  content: string;
}

/** Session active RK-Termin (cookies). */
export interface RKTerminSession {
  jsessionId: string;
  keks: string;               // TERMINA / TERMINB / TERMINC
  /** Timestamp de création de la session */
  createdAt: number;
  /** Indique si le captcha month a déjà été résolu dans cette session */
  monthCaptchaSolved: boolean;
}

/** Résultat d'un scan mensuel. */
export interface RKTerminMonthResult {
  status: "dates_found" | "no_dates" | "captcha_failed" | "error";
  /** Dates disponibles (format dd.MM.yyyy) */
  availableDates: string[];
  /** Mois affiché (ex: "07/2026") */
  displayedMonth?: string;
  /** Période réservable (ex: "24.05.2026 — 01.08.2026") */
  bookingPeriod?: string;
  errorMessage?: string;
}

/** Créneau horaire disponible. */
export interface RKTerminTimeSlot {
  /** Date (format dd.MM.yyyy) */
  date: string;
  /** Heure début (format HH:mm) */
  timeFrom: string;
  /** Heure fin (format HH:mm) */
  timeTo: string;
  /** ID unique de la période d'ouverture (nécessaire pour le booking) */
  openingPeriodId: string;
  /** Disponible ou complet */
  available: boolean;
}

/** Résultat d'un scan journalier. */
export interface RKTerminDayResult {
  status: "slots_found" | "no_slots" | "captcha_failed" | "error";
  /** Créneaux horaires */
  slots: RKTerminTimeSlot[];
  /** Date du jour scanné */
  date: string;
  errorMessage?: string;
}

/** Résultat d'une tentative de réservation. */
export interface RKTerminBookingResult {
  status: "booked" | "captcha_failed" | "validation_error" | "slot_taken" | "error";
  /** Numéro de confirmation (ex: "25101762") */
  confirmationNumber?: string;
  /** Message d'erreur de validation (ex: "Please enter a valid E-Mail Adress") */
  validationError?: string;
  /** Date et heure réservées */
  bookedDate?: string;
  bookedTime?: string;
  bookedLocation?: string;
  errorMessage?: string;
}

/** Résultat complet d'une session de scan. */
export interface RKTerminScanResult {
  status: "slot_found" | "not_found" | "captcha_failed" | "error";
  /** Slot trouvé et réservé (si status = slot_found) */
  booking?: RKTerminBookingResult;
  /** Nombre de dates scannées */
  datesScanned: number;
  /** Nombre de captchas résolus */
  captchasSolved: number;
  /** Durée totale du scan en ms */
  durationMs: number;
  errorMessage?: string;
}

/** Provider de résolution captcha supporté. */
export type CaptchaProvider = "2captcha" | "capsolver" | "anticaptcha";

/** Résultat de résolution d'un captcha image. */
export interface ImageCaptchaResult {
  status: "solved" | "failed" | "timeout";
  text?: string;
  /** Temps de résolution en ms */
  solveTimeMs?: number;
  provider: CaptchaProvider;
}
