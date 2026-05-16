/**
 * URLs, referers et constantes temporelles du portail USA (bundle Angular / captures réseau).
 */

export const USA_BASE = "https://www.usvisaappt.com";
export const USA_LOGIN_URL = `${USA_BASE}/identity/user/login`;
export const USA_LOGOUT_URL = `${USA_BASE}/identity/user/logout`;
export const USA_REFRESH_URL = `${USA_BASE}/identity/user/refreshToken`;
export const USA_PAYMENT_STATUS_URL = `${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus`;
export const USA_APPT_REQUESTS_URL = `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser?type=GROUPREQUEST`;
export const USA_MISSION_ID = 323;

export const USA_ADMIN_URL = `${USA_BASE}/visaadministrationapi/v1`;
export const USA_APPOINTMENT_URL = `${USA_BASE}/visaappointmentapi`;
export const USA_NOTIFICATION_URL = `${USA_BASE}/visanotificationapi`;
export const USA_PAYMENT_URL = `${USA_BASE}/visapaymentapi/v1`;
export const USA_WORKFLOW_URL = `${USA_BASE}/visaworkflowprocessor`;
export const USA_INTEGRATION_URL = `${USA_BASE}/visaintegrationapi`;
export const USA_APPLICANT_API_URL = `${USA_BASE}/visaapplicantapi/v1`;

export const USA_OFC_LIST_URL = (
  missionId: number,
  visaClass?: string,
  visaCategory?: string,
  stateCode?: string,
  priority?: string,
): string => {
  const params = new URLSearchParams();
  if (visaCategory) params.append("visaCategory", visaCategory);
  if (visaClass && visaClass !== "nil") params.append("visaClass", visaClass);
  if (stateCode) params.append("stateCode", stateCode);
  if (priority) params.append("priority", priority);
  params.append("missionId", String(missionId));
  return `${USA_ADMIN_URL}/lookupcdt/wizard/getpost?${params.toString()}`;
};

export const USA_TRANSFORM_DATA_URL = (applicationId: string) =>
  `${USA_WORKFLOW_URL}/workflow/getTransformData/${applicationId}`;
export const USA_FIRST_AVAILABLE_MONTH_URL = `${USA_ADMIN_URL}/modifyslot/getFirstAvailableMonth`;
export const USA_SLOT_DATES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotDates`;
export const USA_SLOT_TIMES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotTime`;
export const USA_APP_DETAILS_URL = (applicationId: string, applicantId: number | string) =>
  `${USA_APPOINTMENT_URL}/appointments/getApplicationDetails?applicationId=${applicationId}&applicantId=${applicantId}`;
export const USA_CONFIRMATION_LETTER_URL = `${USA_NOTIFICATION_URL}/template/appointmentLetter`;
export const USA_SCHEDULE_URL = `${USA_APPOINTMENT_URL}/appointments/schedule`;
export const USA_RESCHEDULE_URL = `${USA_APPOINTMENT_URL}/appointments/reschedule`;
export const USA_SEARCH_URL = `${USA_APPOINTMENT_URL}/appointments/search`;
export const USA_SCHEDULED_INFO_URL = `${USA_APPOINTMENT_URL}/appointments/scheduledappointmentInfo`;
export const USA_SHOW_RESCHEDULE_BUTTON_URL = `${USA_APPOINTMENT_URL}/appointments/showRescheduleButton`;
export const USA_LANDING_PAGE_URL = `${USA_APPOINTMENT_URL}/appointments/getLandingPageDeatils`;
export const USA_SANITY_CHECK_URL = (applicationId: string, stepType: "slotBooking" | "appointmentLetter") =>
  `${USA_APPLICANT_API_URL}/visa/sanitycheck/${applicationId}?stepType=${stepType}`;
export const USA_FCS_CHECK_URL = (applicationId: string) =>
  `${USA_PAYMENT_URL}/feecollection/checkFcs/${applicationId}`;

export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// ── Refresh proactif Cognito ─────────────────────────────────────────────────
// AWS recommande de rafraîchir les tokens à ~75% de leur durée de vie.
// Token Cognito du portail USA = 60 min → refresh idéal à ~45 min (= 15 min avant expiry).
// On ajoute une variabilité ±3 min pour éviter un pattern "refresh à 45 min pile".
// Plage effective : refresh entre 12-18 min avant expiration (42-48 min après login).
export const PROACTIVE_REFRESH_MIN_MS = 12 * 60 * 1000; // 12 min avant expiration (min)
export const PROACTIVE_REFRESH_MAX_MS = 18 * 60 * 1000; // 18 min avant expiration (max)
// Valeur fixe conservée pour compatibilité (utilisée comme fallback)
export const PROACTIVE_REFRESH_MS = 15 * 60 * 1000; // 15 min avant expiration (centre)

export const USA_PORTAL_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_AUTH_IDLE_MS = USA_PORTAL_IDLE_TIMEOUT_MS - 2 * 60 * 1000;
export const MAX_SESSION_ABSOLUTE_MS = 50 * 60 * 1000;
// Durée max réaliste d'une session humaine (30-120 min max - portail déconnecte après 15 min inactivité)
export const MIN_HUMAN_SESSION_MS = 30 * 60 * 1000; // 30 minutes min
export const MAX_HUMAN_SESSION_MS = 120 * 60 * 1000; // 120 minutes max
// Pause variable entre sessions (5-45 min - plus réaliste et aléatoire)
export const MIN_SESSION_BREAK_MS = 5 * 60 * 1000; // 5 min
export const MAX_SESSION_BREAK_MS = 45 * 60 * 1000; // 45 min
// Pause nocturne réduite (00h30-04h00 - créneaux rares)
export const NIGHT_PAUSE_START_HOUR = 0; // 0h (minuit)
export const NIGHT_PAUSE_START_MINUTE = 30; // 30 min
export const NIGHT_PAUSE_END_HOUR = 4; // 4h
export const NIGHT_PAUSE_END_MINUTE = 0; // 0 min
// Heures d'activité normales (presque 24h sauf creux nocturne)
export const HUMAN_ACTIVE_START_HOUR = 4; // 4h
export const HUMAN_ACTIVE_END_HOUR = 0; // 0h (minuit) - avec minute check
export const PROXY_EXPIRY_BUFFER_MS = 2 * 60 * 1000;

// ── Algorithme "Session-First, Login-Last" ──────────────────────────────────
// Arrêter les scans avant l'expiration du token pour éviter les re-logins immédiats
// et ajouter un cooldown humain entre les sessions
export const SCAN_CUTOFF_BEFORE_EXPIRY_MS = 8 * 60 * 1000; // 8 min avant expiration
// Cooldown obligatoire après expiration du token avant re-login (5-8 min gaussien)
export const MIN_COOLDOWN_AFTER_EXPIRY_MS = 5 * 60 * 1000; // 5 min min
export const MAX_COOLDOWN_AFTER_EXPIRY_MS = 8 * 60 * 1000; // 8 min max

// ── Stratégie "Zero-Risk" - Multi-couche anti-détection ──────────────────────

// 1. Session Duration Randomization - Profils de durée variables
export const SESSION_DURATION_PROFILES = [
  { min: 25, max: 40, weight: 0.3 },   // Court (25-40 min) - 30%
  { min: 40, max: 70, weight: 0.5 },   // Moyen (40-70 min) - 50%  
  { min: 70, max: 120, weight: 0.2 },  // Long (70-120 min) - 20%
];

// 2. Heatmap Avoidance - Heures à éviter (UTC)
export const HEATMAP_RISK_ZONES = [
  { hour: 9, risk: 0.8, description: "Morning peak" },    // 9h-10h
  { hour: 14, risk: 0.7, description: "Afternoon peak" }, // 14h-15h  
  { hour: 18, risk: 0.6, description: "Evening peak" },   // 18h-19h
];

// 3. Anomaly Detection - Seuils de déclenchement
export const ANOMALY_DETECTION_THRESHOLDS = {
  responseTimeSpike: 5000,    // >5s de réponse = anomalie
  errorRateIncrease: 0.3,     // >30% d'erreurs = anomalie
  captchaFrequency: 0.2,      // >20% de captchas = anomalie
  consecutiveErrors: 3,       // 3 erreurs consécutives
  errorWindowMs: 5 * 60 * 1000, // Fenêtre de 5 min pour les erreurs
};

// 4. Graceful Degradation - Niveaux de santé serveur
export const SERVER_HEALTH_LEVELS = {
  HEALTHY: { threshold: 0.8, intervalMs: 180000, timeoutMs: 30000, retries: 3 },
  DEGRADED: { threshold: 0.5, intervalMs: 300000, timeoutMs: 45000, retries: 2 },
  STRESSED: { threshold: 0.3, intervalMs: 600000, timeoutMs: 60000, retries: 1 },
  CRITICAL: { threshold: 0.0, intervalMs: 900000, timeoutMs: 90000, retries: 0 },
};

// 5. Behavioral Model - Actions humaines simulées
export const HUMAN_ACTION_MODEL = {
  thinking: { min: 2000, max: 8000, probability: 0.4 },
  reading: { min: 5000, max: 15000, probability: 0.3 },
  navigating: { min: 3000, max: 10000, probability: 0.2 },
  idle: { min: 10000, max: 30000, probability: 0.1 },
};

// 6. Fingerprint Cycling - Profils cohérents pour utilisateur basé à Kinshasa (RDC)
export const FINGERPRINT_CYCLES = [
  { // Jour 1 : Chrome Windows - Kinshasa (français générique)
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    acceptLanguage: "fr,fr-FR;q=0.9,en;q=0.8",
    timezone: "Africa/Kinshasa",
    platform: "Windows"
  },
  { // Jour 2 : Chrome Windows - Kinshasa (français Congo)
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    acceptLanguage: "fr-CD,fr;q=0.9,en;q=0.8,ln;q=0.7",
    timezone: "Africa/Kinshasa",
    platform: "Windows"
  },
  { // Jour 3 : Edge Windows - Kinshasa
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
    acceptLanguage: "fr,fr-CD;q=0.9,en;q=0.8",
    timezone: "Africa/Kinshasa",
    platform: "Windows"
  },
  { // Jour 4 : Chrome Windows - Kinshasa (version légèrement plus ancienne)
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    acceptLanguage: "fr,en;q=0.9,fr-FR;q=0.8",
    timezone: "Africa/Kinshasa",
    platform: "Windows"
  },
  { // Jour 5 : Chrome macOS - Kinshasa (utilisateur Mac)
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    acceptLanguage: "fr,fr-FR;q=0.9,en-US;q=0.8,en;q=0.7",
    timezone: "Africa/Kinshasa",
    platform: "macOS"
  },
  { // Jour 6 : Chrome Windows - Kinshasa (avec lingala)
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    acceptLanguage: "fr,fr-CD;q=0.9,ln;q=0.8,en;q=0.7",
    timezone: "Africa/Kinshasa",
    platform: "Windows"
  },
  { // Jour 7 : Chrome Windows - Kinshasa (simple)
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
    timezone: "Africa/Kinshasa",
    platform: "Windows"
  },
];

export const REFERER_LOGIN = "https://www.usvisaappt.com/visaapplicantui/login";
export const REFERER_DASHBOARD = "https://www.usvisaappt.com/visaapplicantui/home/dashboard";
export const REFERER_REQUESTS = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests";
export const REFERER_CREATE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment";
export const REFERER_MANAGE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/manage-appointment";

// Keep-alive variable (5-12 min - plus aléatoire)
export const MIN_KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
export const MAX_KEEP_ALIVE_INTERVAL_MS = 12 * 60 * 1000; // 12 min
export const WARMUP_INTERVAL_MS = 8 * 60 * 1000;
