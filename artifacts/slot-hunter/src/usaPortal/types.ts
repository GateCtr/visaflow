export type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed" | "payment_required";

export interface CachedToken {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  expiresAt: number;
  userID: number;
  fullName: string;
  sessionStartedAt: number;
  uaIndex?: number;
  proxyUrl?: string;
  proxyExpiresAt?: number;
  jitterMs: number;
  lastActivityAt: number;
  lastScanTime?: number; // Dernier scan pour délai minimum entre les scans
  allowedOfcs?: Array<{ postUserId: number }>;
}

export interface UsaLoginResponse {
  userName: string;
  userID: number;
  fullName: string;
  isActive: string;
  uuid: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  msg: string | null;
  mfa?: number | boolean;
  firstTimeLogin?: boolean;
  ofc?: Array<{ postUserId: number }>;
}

export interface UsaAppointmentRequest {
  applicationId: string;
  missionId: number;
  pendingAppoStatus: number;
  primaryApplicant: string;
  messagetext: string | null;
  cancellable?: boolean;
  applicantId?: number | string;
  appointmentId?: number;
  applicantUUID?: number;
}

export interface UsaSession {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  userID: number;
  fullName: string;
  applicationId: string | null;
  pendingAppoStatus: number | null;
  missionId: number;
  applicantId?: number | string;
  appointmentId?: number;
  applicantUUID?: number;
  appointmentUUID?: string;
  allowedOfcs?: Array<{ postUserId: number }>;
  stateCode?: string;
  appointmentPriority?: string;
  isReschedule?: boolean;
}
