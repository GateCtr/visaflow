// ─── Germany RK-Termin Portal — Public API ──────────────────────────────────
// Point d'entrée du module germanyPortal.

export type {
  RKTerminConfig,
  RKTerminSession,
  RKTerminMonthResult,
  RKTerminDayResult,
  RKTerminTimeSlot,
  RKTerminBookingResult,
  RKTerminScanResult,
  RKTerminDynamicField,
  ImageCaptchaResult,
  CaptchaProvider,
} from "./types.js";

export {
  RKTERMIN_BASE_URL,
  RKTERMIN_ENDPOINTS,
  RKTERMIN_LOCATIONS,
  KINSHASA_CATEGORIES,
  RKTERMIN_TIMING,
  RKTERMIN_PATTERNS,
} from "./config.js";

export { initSession, isSessionValid } from "./rktermin-session.js";
export { extractCaptchaBase64, solveImageCaptcha } from "./rktermin-captcha.js";
export { scanMonth, scanDay, filterDatesByPreference } from "./rktermin-scan.js";
export { bookSlot } from "./rktermin-book.js";
export { runGermanyScan } from "./rktermin-orchestrator.js";
