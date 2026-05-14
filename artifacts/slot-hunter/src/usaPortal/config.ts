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
export const PROACTIVE_REFRESH_MS = 8 * 60 * 1000; // Rafraîchir 8 min avant expiration Cognito

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

export const REFERER_LOGIN = "https://www.usvisaappt.com/visaapplicantui/login";
export const REFERER_DASHBOARD = "https://www.usvisaappt.com/visaapplicantui/home/dashboard";
export const REFERER_REQUESTS = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests";
export const REFERER_CREATE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment";
export const REFERER_MANAGE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/manage-appointment";

// Keep-alive variable (5-12 min - plus aléatoire)
export const MIN_KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
export const MAX_KEEP_ALIVE_INTERVAL_MS = 12 * 60 * 1000; // 12 min
export const WARMUP_INTERVAL_MS = 8 * 60 * 1000;
