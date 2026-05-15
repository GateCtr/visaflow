/**
 * Portail USA — point d’entrée. Modules : `impl.ts`, `usa-session.ts`, `usa-auth.ts`, `usa-http.ts`,
 * `scan-slot-booking.ts` (+ `usa-scan-main`, `usa-scan-types`, `usa-scan-preflight`, `usa-scan-details`, `usa-scan-find`, `usa-scan-book`, `usa-scan-confirmation`),
 * `appointments-api.ts`, `anti-detection.ts`, `config.ts`, `types.ts`, `crypto.ts`, `errors.ts`, `account-restriction.ts`.
 */
export { USA_ENC_SEC_KEY, updateAesKey, encryptPortalCredentials } from "./crypto.js";
export type { SessionResult, UsaSession, UsaAppointmentRequest } from "./types.js";
export { isAccountRestricted } from "./account-restriction.js";
export { makeIproyalStickyUrl, setUsaSessionProxy, rotateIproyalSession } from "./usa-http.js";
export { downloadUsaConfirmationPdf } from "./scan-slot-booking.js";
export { preFlightProxyCheck } from "./proxy-health-check.js";
export { generateCognitoEncodedData, detectCognitoEncodedDataUsage } from "./cognito-telemetry.js";
export { handle409Retry } from "./retry-409-logic.js";
export {
  checkUsaAppointmentRequestStatus,
  getUsaAppointmentRequests,
} from "./appointments-api.js";
export { logoutUsaPortal, loginUsaPortal } from "./usa-auth.js";
export { checkCaptchaConfig, resolveLoginCaptchaIfNeeded } from "./captcha-gate.js";
export { getUsaSession } from "./usa-session.js";
export { runUsaApiSession } from "./impl.js";
