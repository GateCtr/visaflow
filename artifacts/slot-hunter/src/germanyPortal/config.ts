// ─── Germany RK-Termin Portal — Configuration & Constants ───────────────────

/** URL de base du portail RK-Termin */
export const RKTERMIN_BASE_URL = "https://service2.diplo.de/rktermin/extern";

/** Endpoints RK-Termin */
export const RKTERMIN_ENDPOINTS = {
  chooseRealmList: "choose_realmList.do",
  chooseCategoryList: "choose_categoryList.do",
  chooseCategory: "choose_category.do",
  appointmentShowMonth: "appointment_showMonth.do",
  appointmentShowDay: "appointment_showDay.do",
  appointmentShowForm: "appointment_showForm.do",
  appointmentAddAppointment: "appointment_addAppointment.do",
  appointmentRefreshCaptcha: "appointment_refreshCaptcha",
  appointmentRefreshCaptchaMonth: "appointment_refreshCaptchamonth",
} as const;

/** Headers HTTP standard pour simuler un navigateur normal */
export const RKTERMIN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,de;q=0.8,fr;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
} as const;

/** Configuration des ambassades connues */
export const RKTERMIN_LOCATIONS: Record<string, {
  label: string;
  locationCode: string;
  realms: Record<number, string>;
}> = {
  kinshasa: {
    label: "Ambassade d'Allemagne — Kinshasa",
    locationCode: "kins",
    realms: {
      731: "Nationale Visa für kongolesische Staatsangehörige",
      1505: "Nationale Visa für Drittstaatsangehörige",
      1276: "Schengenvisum (Tiers uniquement, pas congolais)",
      733: "Beglaubigungen (Légalisations)",
      735: "Deutscher Reisepass und Personalausweis",
    },
  },
  lagos: {
    label: "Consulat Général — Lagos",
    locationCode: "lago",
    realms: {
      1526: "Appointment for a short-term-visa",
      347: "Appointment for a national visa",
      695: "Schengen visa",
    },
  },
  kampala: {
    label: "Ambassade — Kampala",
    locationCode: "kamp",
    realms: {
      539: "National Visa / Long Term",
      1225: "Schengen Visa",
      542: "Consular Services",
    },
  },
  budapest: {
    label: "Ambassade — Budapest (Belarus desk)",
    locationCode: "buda",
    realms: {
      231: "National Visa (Belarus)",
    },
  },
};

/** Catégories de visa connues pour Kinshasa (realmId 731) */
export const KINSHASA_CATEGORIES = {
  familyReunification: { realmId: 731, categoryId: 3674, label: "Familienzusammenführung" },
  studies: { realmId: 731, categoryId: 3672, label: "Studium" },
  workChancenkarte: { realmId: 731, categoryId: 3675, label: "Erwerbstätigkeit/Ausbildung/Chancenkarte" },
  thirdCountryNational: { realmId: 1505, categoryId: 3673, label: "Visa National Tiers" },
  schengen: { realmId: 1276, categoryId: 3020, label: "Schengenvisum (Tiers)" },
} as const;

/** Timing et retry */
export const RKTERMIN_TIMING = {
  /** Délai entre requêtes HTTP (anti-rate-limit) */
  interRequestDelayMs: { min: 800, max: 2000 },
  /** Timeout global d'une requête HTTP (connexion + lecture de la réponse) */
  requestTimeoutMs: 45_000,
  /**
   * Timeout d'établissement de la connexion TCP/TLS.
   * undici plafonne à 10s par défaut : service2.diplo.de répond souvent en
   * 10-20s depuis une IP datacenter (Railway), ce qui produisait
   * « ConnectTimeoutError » AVANT que le timeout global ne s'applique.
   */
  connectTimeoutMs: 25_000,
  /** Retry automatique sur erreur réseau transitoire (ConnectTimeout, ECONNRESET…) */
  networkRetry: {
    /** Nombre total de tentatives par requête (1 = pas de retry) */
    maxAttempts: 3,
    /** Backoff exponentiel: base * 2^(n-1) + jitter */
    baseDelayMs: 1_500,
    maxDelayMs: 12_000,
  },
  /** Durée de vie max d'une session avant renouvellement */
  sessionMaxAgeMs: 10 * 60_000, // 10 minutes
  /** Délai entre les cycles de polling */
  pollingInterval: {
    normal: { min: 60_000, max: 60_000 },                 // 1 min
    rush: { min: 30_000, max: 60_000 },                   // 30-60s
    slotDetected: { min: 10_000, max: 20_000 },           // 10-20s
  },
  /** Max tentatives captcha par étape */
  maxCaptchaRetries: 5,
  /** Pause entre captcha et soumission (simule lecture humaine) */
  postCaptchaPauseMs: { min: 500, max: 1500 },
  /** Politique d'auto-pause d'un dossier dans la boucle Germany */
  autoPause: {
    /** Erreurs « métier » consécutives (captcha non trouvé, booking KO…) avant pause */
    maxBusinessErrors: 3,
    /**
     * Erreurs purement réseau consécutives avant mise en pause.
     * Bien plus tolérant : le portail allemand est régulièrement injoignable
     * quelques minutes, ce n'est pas un problème de configuration du dossier.
     */
    maxNetworkErrors: 12,
    /** Cooldown progressif après une erreur réseau (backoff exponentiel) */
    networkCooldownMs: { base: 120_000, max: 900_000 },   // 2 min → 15 min
    /** Durée de la pause automatique (reprise auto ensuite, pas de pause définitive) */
    pauseDurationMs: 30 * 60_000,                          // 30 min
  },
} as const;

/** Regex patterns pour parser le HTML RK-Termin */
export const RKTERMIN_PATTERNS = {
  /** Extraire le captcha base64 */
  captchaBase64: /background:white url\('data:image\/jpg;base64,([^']+)'\)/,
  /** Extraire les liens vers appointment_showDay (dates disponibles) */
  availableDayLinks: /appointment_showDay\.do[^"]*dateStr=([^"&]+)/g,
  /** Extraire les liens vers appointment_showForm (créneaux réservables) */
  bookableSlotLinks: /appointment_showForm\.do\?([^"]*)/g,
  /** Extraire l'openingPeriodId d'un lien */
  openingPeriodId: /openingPeriodId=(\d+)/,
  /** Extraire le mois affiché */
  displayedMonth: /(\d{2}\/\d{4})/,
  /** Détecter "aucun créneau" */
  noAppointments: /Unfortunately.*no appointments available|keine Termine|Leider sind aktuell keine Termine/i,
  /** Détecter "captcha incorrect" */
  captchaWrong: /The entered text was wrong|Der eingegebene Text war falsch/i,
  /** Détecter la période de booking */
  bookingPeriod: /between\s+(\d{2}\.\d{2}\.\d{4})\s+and\s+(\d{2}\.\d{2}\.\d{4})/,
  /** Extraire le numéro de confirmation */
  confirmationNumber: /appointment number is\s+(\d+)|Ihre Terminnummer lautet\s+(\d+)|number is\s+(\d+)/i,
  /** Détecter le succès */
  bookingSuccess: /successfully booked|erfolgreich gebucht|Ihr Termin.*wurde.*gespeichert/i,
  /** Extraire les heures d'un créneau */
  timeSlot: /(\d{1,2}:\d{2})\s*[—–-]\s*(\d{1,2}:\d{2})/g,
  /** Détecter créneau complet */
  slotTaken: /All appointments for this period are taken|Alle Termine.*belegt/i,
  /** Détecter le mode (calendrier vs waitlist) */
  isCalendarMode: /appointment_showMonth\.do/,
  isWaitlistMode: /appointment_showForm\.do\?locationCode/,
  /** Erreur de validation email */
  emailValidationError: /valid E-Mail|gültige E-Mail/i,
  /** Navigation mois suivant/précédent */
  nextMonth: /appointment_showMonth\.do[^"]*dateStr=([^"&]+)/g,
} as const;

/** User-Agents pour rotation */
export const RKTERMIN_USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
];
