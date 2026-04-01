import { createCipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { randomDelay } from "./browser.js";
import { reportSlotFound, sendHeartbeat, uploadFile, type HunterJob } from "./convexClient.js";

type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed" | "payment_required";

const USA_BASE = "https://www.usvisaappt.com";
const USA_LOGIN_URL = `${USA_BASE}/identity/user/login`;
const USA_LOGOUT_URL = `${USA_BASE}/identity/user/logout`;
const USA_REFRESH_URL = `${USA_BASE}/identity/user/refreshToken`;
const USA_PAYMENT_STATUS_URL = `${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus`;
const USA_APPT_REQUESTS_URL = `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser`;
const USA_MISSION_ID = 323;

// Endpoints de scan de créneaux — extraits du bundle Angular public
const USA_ADMIN_URL = `${USA_BASE}/visaadministrationapi/v1`;
const USA_APPOINTMENT_URL = `${USA_BASE}/visaappointmentapi`;
const USA_NOTIFICATION_URL = `${USA_BASE}/visanotificationapi`;
const USA_PAYMENT_URL = `${USA_BASE}/visapaymentapi/v1`;
const USA_WORKFLOW_URL = `${USA_BASE}/visaworkflowprocessor`;
const USA_INTEGRATION_URL = `${USA_BASE}/visaintegrationapi`; // sanity check

const USA_OFC_LIST_URL = (missionId: number) =>
  `${USA_ADMIN_URL}/ofcuser/ofclist/${missionId}`;
const USA_FIRST_AVAILABLE_MONTH_URL = `${USA_ADMIN_URL}/modifyslot/getFirstAvailableMonth`;
const USA_SLOT_DATES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotDates`;
const USA_SLOT_TIMES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotTime`;
const USA_APP_DETAILS_URL = (applicationId: string, applicantId: number) =>
  `${USA_APPOINTMENT_URL}/appointments/getApplicationDetails?applicationId=${applicationId}&applicantId=${applicantId}`;
const USA_CONFIRMATION_LETTER_URL = `${USA_NOTIFICATION_URL}/template/appointmentLetter`;
const USA_SCHEDULE_URL = `${USA_APPOINTMENT_URL}/appointments/schedule`;
// Anti-détection : endpoints que le vrai portail appelle dans son flux normal
const USA_LANDING_PAGE_URL = `${USA_APPOINTMENT_URL}/appointment/getLandingPageDeatils`;
const USA_SANITY_CHECK_URL = (applicationId: string) =>
  `${USA_INTEGRATION_URL}/visa/sanitycheck/${applicationId}?stepType=slotBooking`;
const USA_FCS_CHECK_URL = (applicationId: string) =>
  `${USA_PAYMENT_URL}/feecollection/checkFcs/${applicationId}`;

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// Circuit-breaker : erreurs HTTP critiques pendant le scan
// ─────────────────────────────────────────────────────────────

/**
 * Levée quand le serveur renvoie 429 — rate limit actif.
 * Le scan DOIT s'arrêter immédiatement pour éviter un ban.
 */
class RateLimitError extends Error {
  constructor(public readonly endpoint: string, public readonly retryAfterMs?: number) {
    super(`Rate-limit (429) sur ${endpoint}`);
    this.name = "RateLimitError";
  }
}

/**
 * Levée quand le serveur renvoie 403 — compte potentiellement signalé ou bloqué.
 * Le scan doit s'arrêter et alerter.
 */
class AccountBlockedError extends Error {
  constructor(public readonly endpoint: string) {
    super(`Accès refusé (403) sur ${endpoint} — compte potentiellement bloqué`);
    this.name = "AccountBlockedError";
  }
}

/**
 * Levée quand le serveur renvoie 401 en cours de scan — token JWT expiré.
 * La session doit être rafraîchie avant toute nouvelle tentative.
 */
class TokenExpiredError extends Error {
  constructor() {
    super("Token JWT expiré en cours de scan (401)");
    this.name = "TokenExpiredError";
  }
}

// Clé AES du portail USA — extraite du bundle Angular public (visaapplicantui/main.js)
// nosemgrep: generic-api-key — clé publique, visible dans le JS client du portail
const USA_ENC_SEC_KEY = "OuoCdl8xQh/OX6LbmgLEtZxZrvnOmrubsMhPW1VPRjk=";

/**
 * Chiffre les credentials en AES-256-CBC avec PBKDF2 (SHA1, 1000 itérations),
 * identique à cryptoService.encrypt() du portail Angular.
 * Format de sortie : salt_hex(32) + iv_hex(32) + base64(ciphertext)
 */
function encryptPortalCredentials(username: string, password: string): string {
  const plaintext = `${username}:${password}`;
  const salt = randomBytes(16);
  const key = pbkdf2Sync(USA_ENC_SEC_KEY, salt, 1000, 32, "sha1");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return salt.toString("hex") + iv.toString("hex") + encrypted.toString("base64");
}

interface CachedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userID: number;
  fullName: string;
}

const tokenCache = new Map<string, CachedToken>();

function parseJwtExpiry(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return decoded.exp ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function isCachedTokenValid(cached: CachedToken): boolean {
  return Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS;
}

async function refreshUsaToken(cached: CachedToken): Promise<CachedToken | null> {
  console.log("[usa] Renouvellement token via refresh token...");
  try {
    const res = await fetch(USA_REFRESH_URL, {
      method: "POST",
      headers: { ...BROWSER_HEADERS },
      body: JSON.stringify({ refreshToken: cached.refreshToken }),
    });

    if (!res.ok) {
      console.warn(`[usa] Refresh token refusé (HTTP ${res.status}) — reconnexion complète requise`);
      return null;
    }

    const newAccessToken = res.headers.get("authorization");
    const newRefreshToken = res.headers.get("refreshtoken") ?? cached.refreshToken;

    if (!newAccessToken) {
      console.warn("[usa] Refresh: aucun token dans la réponse");
      return null;
    }

    const expiresAt = parseJwtExpiry(newAccessToken) || Date.now() + 55 * 60 * 1000;
    console.log("[usa] Token renouvelé avec succès");

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt,
      userID: cached.userID,
      fullName: cached.fullName,
    };
  } catch (err) {
    console.warn("[usa] Erreur lors du refresh:", err);
    return null;
  }
}

interface UsaLoginResponse {
  userName: string;
  userID: number;
  fullName: string;
  isActive: string;
  uuid: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  msg: string | null;
}

interface UsaAppointmentRequest {
  applicationId: string;
  missionId: number;
  pendingAppoStatus: number;
  primaryApplicant: string;
  cancellable: boolean;
  messagetext: string | null;
}

interface UsaPaymentStatus {
  applicationId: string;
  missionId: number;
  pendingAppoStatus: number;
  primaryApplicant: string;
  cancellable: boolean;
  messagetext: string | null;
}

export interface UsaSession {
  accessToken: string;
  refreshToken: string;
  userID: number;
  fullName: string;
  applicationId: string | null;
  pendingAppoStatus: number | null;
}

// Referers spécifiques à chaque étape de navigation du portail Angular.
// Chaque appel API reçoit le referer de la page qui l'a déclenché (comme un vrai navigateur).
const REFERER_LOGIN      = "https://www.usvisaappt.com/visaapplicantui/login";
const REFERER_DASHBOARD  = "https://www.usvisaappt.com/visaapplicantui/home/dashboard";
const REFERER_REQUESTS   = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests";
const REFERER_CREATE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment";

// Headers d'un vrai navigateur Chrome 124 sur Windows — identiques à ceux capturés par DevTools.
// IMPORTANT : ne jamais inclure de headers CORS côté requête (Access-Control-Allow-*) —
// ce sont des headers de RÉPONSE que seul le serveur envoie, jamais le navigateur.
const BROWSER_HEADERS: Record<string, string> = {
  "Accept":             "application/json, text/plain, */*",
  "Accept-Language":    "fr-CD,fr;q=0.9,en-US;q=0.6,en;q=0.5",
  "Cache-Control":      "no-cache",
  "Pragma":             "no-cache",
  "Origin":             "https://www.usvisaappt.com",
  "Referer":            REFERER_LOGIN,  // referer par défaut = page de login, surchargé par authHeaders()
  "Sec-CH-UA":          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-CH-UA-Mobile":   "?0",
  "Sec-CH-UA-Platform": '"Windows"',
  "Sec-Fetch-Dest":     "empty",
  "Sec-Fetch-Mode":     "cors",
  "Sec-Fetch-Site":     "same-origin",
  "User-Agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};


export async function getUsaSession(
  username: string,
  password: string,
  _captchaApiKey?: string  // Conservé pour compatibilité — le portail USA ne requiert pas de CAPTCHA via API
): Promise<UsaSession | null> {
  const cacheKey = username.toLowerCase();
  const cached = tokenCache.get(cacheKey);

  if (cached) {
    if (isCachedTokenValid(cached)) {
      const remainingMin = Math.round((cached.expiresAt - Date.now()) / 60000);
      console.log(`[usa] Token en cache valide pour ${cached.fullName} (expire dans ~${remainingMin} min)`);
      return {
        accessToken: cached.accessToken,
        refreshToken: cached.refreshToken,
        userID: cached.userID,
        fullName: cached.fullName,
        applicationId: null,
        pendingAppoStatus: null,
      };
    }

    console.log("[usa] Token expiré — tentative de renouvellement...");
    const refreshed = await refreshUsaToken(cached);
    if (refreshed) {
      tokenCache.set(cacheKey, refreshed);
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        userID: refreshed.userID,
        fullName: refreshed.fullName,
        applicationId: null,
        pendingAppoStatus: null,
      };
    }
    console.log("[usa] Refresh échoué — reconnexion complète");
    tokenCache.delete(cacheKey);
  }

  // Login direct avec credentials chiffrés en AES — le CAPTCHA est validé côté client uniquement
  let session: UsaSession | null = null;

  try {
    console.log("[usa] Login API avec credentials AES chiffrés...");
    session = await loginUsaPortal(username, password, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Login USA échoué: ${msg}`);
  }

  if (!session) return null;

  const expiresAt = parseJwtExpiry(session.accessToken) || Date.now() + 55 * 60 * 1000;
  tokenCache.set(cacheKey, {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt,
    userID: session.userID,
    fullName: session.fullName,
  });

  return session;
}

/**
 * Déconnecte l'utilisateur du portail USA et vide le cache de token.
 * Appelle POST /identity/user/logout avec le Bearer token en en-tête.
 */
export async function logoutUsaPortal(username: string): Promise<void> {
  const cacheKey = username.toLowerCase();
  const cached = tokenCache.get(cacheKey);

  if (cached) {
    console.log(`[usa] Déconnexion de ${username} du portail...`);
    try {
      const res = await fetch(USA_LOGOUT_URL, {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          Authorization: `Bearer ${cached.accessToken}`,
        },
        body: null,
      });
      console.log(`[usa] Logout HTTP ${res.status} — ${username}`);
    } catch (err) {
      console.warn(`[usa] Erreur réseau lors du logout (ignorée):`, err);
    } finally {
      tokenCache.delete(cacheKey);
      console.log(`[usa] Cache token supprimé pour ${username}`);
    }
  } else {
    console.log(`[usa] Aucune session active pour ${username} — rien à déconnecter`);
  }
}

export async function loginUsaPortal(
  username: string,
  password: string,
  _captchaToken?: string | null  // Conservé pour compatibilité — le CAPTCHA n'est pas requis par l'API
): Promise<UsaSession | null> {
  console.log(`[usa] Connexion API pour ${username} avec credentials AES chiffrés...`);

  // Le portail USA attend les credentials chiffrés en AES-256-CBC dans le champ "authorization"
  // Format découvert dans le bundle Angular public : { authorization: "Basic " + encrypt(user:pass) }
  const body = {
    authorization: `Basic ${encryptPortalCredentials(username, password)}`,
  };

  console.log(`[usa] Body login: {authorization: "Basic <AES_encrypted(${username}:***)}"}`);

  let response: Response;
  try {
    response = await fetch(USA_LOGIN_URL, {
      method: "POST",
      headers: BROWSER_HEADERS,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[usa] Erreur réseau lors du login:", err);
    throw new Error(`Réseau: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Lire le corps de la réponse dans tous les cas pour logger le vrai message d'erreur
  let rawBody = "";
  let data: UsaLoginResponse | null = null;
  try {
    rawBody = await response.text();
    data = JSON.parse(rawBody) as UsaLoginResponse;
  } catch {
    // pas du JSON
  }

  if (!response.ok) {
    const detail = data?.msg ?? rawBody.slice(0, 200);
    console.error(`[usa] Login HTTP ${response.status} — détail: ${detail}`);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  if (!data) {
    console.error("[usa] Réponse login invalide (JSON parse échoué)");
    throw new Error("Réponse non-JSON du portail USA");
  }

  const accessToken = response.headers.get("authorization");
  const refreshToken = response.headers.get("refreshtoken");

  if (data.msg && (data.msg.toLowerCase().includes("invalid") || data.msg.toLowerCase().includes("incorrect"))) {
    console.error(`[usa] Login refusé par le portail: ${data.msg}`);
    throw new Error(`Portail: ${data.msg}`);
  }

  if (data.isActive !== "ACTIVE") {
    console.warn(`[usa] Compte inactif: isActive=${data.isActive}, msg=${data.msg}`);
    throw new Error(`Compte non actif (isActive=${data.isActive})`);
  }

  if (!accessToken) {
    console.error("[usa] JWT absent du header 'authorization'");
    throw new Error("JWT manquant dans la réponse — login incomplet");
  }

  console.log(`[usa] Connecté en tant que ${data.fullName} (userID: ${data.userID})`);

  return {
    accessToken,
    refreshToken: refreshToken ?? "",
    userID: data.userID,
    fullName: data.fullName,
    applicationId: null,
    pendingAppoStatus: null,
  };
}

export async function checkUsaAppointmentRequestStatus(session: UsaSession): Promise<{
  status: "payment_required" | "scheduled" | "no_request" | "pending" | "error";
  applicationId: string | null;
  pendingAppoStatus: number | null;
  primaryApplicant: string | null;
  message: string;
}> {
  const headers = authHeaders(session.accessToken, REFERER_REQUESTS, false);
  let data: UsaPaymentStatus | null = null;

  try {
    const res = await fetch(USA_PAYMENT_STATUS_URL, { method: "GET", headers });
    if (!res.ok) {
      console.error(`[usa] Appointment status HTTP ${res.status}`);
      return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: `HTTP ${res.status}` };
    }
    const raw = await res.json();
    if (!raw || typeof raw !== "object") {
      return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Aucune demande de RDV trouvée" };
    }
    data = raw as UsaPaymentStatus;
  } catch (err) {
    console.error("[usa] Erreur appel appointment status:", err);
    return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: String(err) };
  }

  const appId = data.applicationId ?? null;
  const appoStatus = data.pendingAppoStatus ?? null;
  const applicant = data.primaryApplicant ?? null;

  console.log(`[usa] pendingAppoStatus=${appoStatus} applicationId=${appId} applicant=${applicant}`);

  // Interprétation de pendingAppoStatus — tirée du bundle Angular (getAppIdByUserId) :
  //   0           → aucune demande / paiement non confirmé (portal: synchronizeAccount)
  //   1           → créneau déjà attribué (portal: redirect dashboard)
  //   2, 3, etc.  → paiement fait, en attente de créneau (portal: aller à l'appointment create)
  // Le bundle confirme : "0 !== pendingAppoStatus" → toujours redirigé vers la création de RDV.

  if (appoStatus === 0 || appoStatus === null) {
    return {
      status: "no_request",
      applicationId: appId,
      pendingAppoStatus: appoStatus,
      primaryApplicant: applicant,
      message: `Aucune demande active ou paiement non confirmé (pendingAppoStatus: ${appoStatus})`,
    };
  }

  if (appoStatus === 1) {
    return {
      status: "scheduled",
      applicationId: appId,
      pendingAppoStatus: 1,
      primaryApplicant: applicant,
      message: `Créneau déjà attribué pour ${applicant} (applicationId: ${appId})`,
    };
  }

  // Status 2, 3 ou tout autre valeur non nulle = paiement effectué, scan pour créneau
  return {
    status: "pending",
    applicationId: appId,
    pendingAppoStatus: appoStatus,
    primaryApplicant: applicant,
    message: `Paiement confirmé (status=${appoStatus}) — scan créneaux pour ${applicant}`,
  };
}

export async function getUsaAppointmentRequests(session: UsaSession): Promise<UsaAppointmentRequest[]> {
  const headers = authHeaders(session.accessToken, REFERER_REQUESTS, false);

  try {
    const res = await fetch(USA_APPT_REQUESTS_URL, { method: "GET", headers });
    if (!res.ok) {
      console.error(`[usa] Appointment requests HTTP ${res.status}`);
      return [];
    }
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : [raw];
    return list as UsaAppointmentRequest[];
  } catch (err) {
    console.error("[usa] Erreur appel appointment requests:", err);
    return [];
  }
}

export async function runUsaApiSession(job: HunterJob): Promise<SessionResult> {
  const { embassyUsername: username, embassyPassword: password, twoCaptchaApiKey } = job.hunterConfig;

  if (!username || !password) {
    console.error("[usa] Identifiants portail manquants dans hunterConfig");
    return "error";
  }

  let session: UsaSession | null = null;
  try {
    session = await getUsaSession(username, password, twoCaptchaApiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] getUsaSession échoué: ${msg}`);
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: msg.slice(0, 300),
    });
    return "login_failed";
  }
  if (!session) {
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: "Connexion API USA échouée — identifiants incorrects ou portail indisponible",
    });
    return "login_failed";
  }

  // ── Résolution du dossier actif ────────────────────────────────────────────
  // Le portail retourne toujours l'applicationId du dossier actif de la session.
  // Une session = un compte = un dossier principal → pas d'ambiguïté.
  const requestStatus = await checkUsaAppointmentRequestStatus(session);
  session.applicationId = requestStatus.applicationId;
  session.pendingAppoStatus = requestStatus.pendingAppoStatus;

  if (requestStatus.status === "error") {
    console.error(`[usa] Erreur lecture statut demande : ${requestStatus.message}`);
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: requestStatus.message,
    });
    return "error";
  }

  if (requestStatus.status === "no_request") {
    console.warn(`[usa] Aucune demande soumise : ${requestStatus.message}`);
    await sendHeartbeat({
      applicationId: job.id,
      result: "not_found",
      errorMessage: requestStatus.message,
    });
    return "not_found";
  }

  if (requestStatus.status === "scheduled") {
    console.log(`[usa] ✅ Créneau déjà attribué : ${requestStatus.message}`);
    try {
      await reportSlotFound({
        applicationId: job.id,
        date: "Créneau déjà attribué",
        time: "",
        location: `Ambassade USA Kinshasa (Mission ${USA_MISSION_ID})`,
      });
    } catch { /* ignore */ }
    return "slot_found";
  }

  console.log(`[usa] ${requestStatus.message} — lancement scan créneaux via API directe...`);

  const slotResult = await scanUsaSlotsViaAPI(job, session);
  return slotResult;
}

// ─────────────────────────────────────────────────────────────
// Types pour les réponses des endpoints de slot (bundle Angular)
// ─────────────────────────────────────────────────────────────

interface UsaOfc {
  postUserId: number;
  postName: string;
  officeType: string;  // "OFC" | "POST"
  postCode?: string;
}

interface UsaAppDetails {
  applicantId: number;
  applicationId: string;
  visaType: string;
  visaClass: string;
  locationType?: string;
}

interface UsaFirstAvailableMonthResponse {
  present: boolean;
  date: string;  // "YYYY-MM-DD"
}

interface UsaSlotDate {
  date: string;        // "YYYY-MM-DD"
  slotsAvailable: number;
  [key: string]: unknown;
}

interface UsaTimeSlot {
  slotId: number;
  date: string;        // "YYYY-MM-DD"
  startTime: string;   // "HH:mm" ou "YYYY-MM-DDTHH:mm:ss"
  endTime: string;
  slotsAvailable?: number;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// Fonctions utilitaires de scan API
// ─────────────────────────────────────────────────────────────

/**
 * Headers de base authentifiés.
 * @param accessToken  JWT Bearer
 * @param referer      Page en cours dans le portail (simule la navigation réelle)
 * @param withBody     true = requête avec corps JSON → ajoute Content-Type
 *                     false = requête GET sans corps → pas de Content-Type (les navigateurs ne l'envoient pas)
 */
function authHeaders(
  accessToken: string,
  referer: string = REFERER_DASHBOARD,
  withBody = true
): Record<string, string> {
  const h: Record<string, string> = {
    ...BROWSER_HEADERS,
    "Authorization": `Bearer ${accessToken}`,
    "Referer": referer,
  };
  if (withBody) h["Content-Type"] = "application/json";
  return h;
}

/**
 * Variante enrichie avec les cookies de session lus par le serveur sur les endpoints de slot.
 * Le bundle Angular envoie `APP_ID_TOBE={applicationId}; missionId=323` sur toutes les requêtes
 * de slot — sans ces cookies, le serveur peut rejeter la requête ou la traiter comme suspecte.
 */
function sessionHeaders(
  accessToken: string,
  applicationId: string,
  missionId = USA_MISSION_ID,
  referer: string = REFERER_CREATE_APT,
  withBody = true
): Record<string, string> {
  return {
    ...authHeaders(accessToken, referer, withBody),
    "Cookie": `APP_ID_TOBE=${applicationId}; missionId=${missionId}`,
  };
}

/**
 * Warm-up : appelé par le portail Angular dès l'ouverture du tableau de bord.
 * Reproduire cet appel rend le robot indiscernable d'un utilisateur légitime.
 * Erreurs ignorées silencieusement (non bloquant).
 */
async function callLandingPage(session: UsaSession): Promise<void> {
  if (!session.applicationId) return;
  // GET depuis le dashboard — pas de Content-Type, Referer = dashboard parent
  const headers = sessionHeaders(session.accessToken, session.applicationId, USA_MISSION_ID, REFERER_DASHBOARD, false);
  try {
    const res = await fetch(USA_LANDING_PAGE_URL, { method: "GET", headers });
    console.log(`[usa] getLandingPageDeatils → HTTP ${res.status}`);
  } catch (err) {
    console.warn("[usa] getLandingPageDeatils ignoré :", err);
  }
}

/**
 * Sanity check : POST /visaintegrationapi/visa/sanitycheck/{appId}?stepType=slotBooking
 * Appelé par le portail Angular à chaque init de page de booking.
 * Fire-and-forget (n'attend pas la réponse pour continuer).
 */
async function callSanityCheck(session: UsaSession): Promise<void> {
  if (!session.applicationId) return;
  const url = USA_SANITY_CHECK_URL(session.applicationId);
  // POST sans corps — le portail envoie Content-Type mais pas de body
  const headers = sessionHeaders(session.accessToken, session.applicationId, USA_MISSION_ID, REFERER_CREATE_APT, true);
  try {
    const res = await fetch(url, { method: "POST", headers });
    console.log(`[usa] sanityCheck(slotBooking) → HTTP ${res.status}`);
  } catch (err) {
    console.warn("[usa] sanityCheck ignoré :", err);
  }
}

/**
 * Vérification du paiement FCS : GET /visapaymentapi/v1/feecollection/checkFcs/{appId}
 * Appelé par le portail avant la réservation de créneau.
 * Retourne true si le paiement est confirmé côté FCS.
 * En cas d'erreur réseau, on laisse le scan continuer (bénéfice du doute).
 */
async function checkFcsPayment(session: UsaSession): Promise<boolean> {
  if (!session.applicationId) return true; // laisser passer si pas d'appId
  const url = USA_FCS_CHECK_URL(session.applicationId);
  // GET — pas de Content-Type
  const headers = sessionHeaders(session.accessToken, session.applicationId, USA_MISSION_ID, REFERER_CREATE_APT, false);
  try {
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      console.warn(`[usa] checkFcs → HTTP ${res.status} — scan maintenu par prudence`);
      return true; // scan quand même
    }
    const data = await res.json() as { fcsStatus?: string; isPaid?: boolean; paymentStatus?: string };
    const paid = data.isPaid === true
      || data.fcsStatus === "1"
      || data.fcsStatus === "paid"
      || data.paymentStatus === "paid";
    console.log(`[usa] checkFcs → ${JSON.stringify(data)} → paid=${paid}`);
    return paid !== false; // tolérant si le format change
  } catch (err) {
    console.warn("[usa] checkFcs erreur réseau — scan maintenu :", err);
    return true;
  }
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(d: Date): string {
  return toYMD(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * Récupère les détails de la demande (applicantId, visaType, visaClass)
 * depuis GET /visaappointmentapi/appointments/getApplicationDetails
 */
async function getUsaApplicationDetails(
  session: UsaSession,
  applicationId: string
): Promise<UsaAppDetails | null> {
  const url = USA_APP_DETAILS_URL(applicationId, session.userID);
  try {
    // GET — pas de Content-Type, Referer = page de création de RDV
    const res = await fetch(url, {
      headers: sessionHeaders(session.accessToken, applicationId, USA_MISSION_ID, REFERER_CREATE_APT, false),
    });
    if (!res.ok) {
      console.warn(`[usa] getApplicationDetails HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as UsaAppDetails;
    console.log(`[usa] App details: applicantId=${data.applicantId}, visaType=${data.visaType}, visaClass=${data.visaClass}`);
    return data;
  } catch (err) {
    console.warn(`[usa] getApplicationDetails erreur: ${err}`);
    return null;
  }
}

/**
 * Récupère la liste des OFCs autorisés pour une mission.
 * GET /visaadministrationapi/v1/ofcuser/ofclist/{missionId}
 */
async function getUsaOfcList(session: UsaSession, missionId: number): Promise<UsaOfc[]> {
  // GET — pas de Content-Type; les cookies applicationId+missionId doivent être présents
  const hdrs = session.applicationId
    ? sessionHeaders(session.accessToken, session.applicationId, missionId, REFERER_CREATE_APT, false)
    : authHeaders(session.accessToken, REFERER_CREATE_APT, false);
  try {
    const res = await fetch(USA_OFC_LIST_URL(missionId), { headers: hdrs });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
      throw new RateLimitError("getOfcList", retryAfter * 1000);
    }
    if (res.status === 403) {
      throw new AccountBlockedError("getOfcList");
    }
    if (res.status === 401) {
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      console.warn(`[usa] getOfcList HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data as UsaOfc[] : [];
    console.log(`[usa] OFCs disponibles (mission ${missionId}): ${list.map(o => o.postName).join(", ") || "aucun"}`);
    return list.filter(o => o.officeType === "OFC");
  } catch (err) {
    console.warn(`[usa] getOfcList erreur: ${err}`);
    return [];
  }
}

/**
 * Pour un OFC donné, cherche le premier mois avec des créneaux disponibles,
 * puis les dates et horaires dans ce mois.
 * Retourne le premier créneau trouvé ou null.
 */
interface SlotFound {
  date: string;
  time: string;
  slotId: number;
  ofcName: string;
  slot: UsaTimeSlot;
  bookingBase: Record<string, unknown>;
}

async function findFirstSlotForOfc(
  session: UsaSession,
  ofc: UsaOfc,
  appDetails: UsaAppDetails
): Promise<SlotFound | null> {
  const basePayload = {
    postUserId: ofc.postUserId,
    applicantId: appDetails.applicantId,
    visaType: appDetails.visaType,
    visaClass: appDetails.visaClass,
    locationType: "OFC",
    applicationId: appDetails.applicationId,
  };

  // Toutes les requêtes de slot incluent les cookies APP_ID_TOBE + missionId (POST avec body)
  const hdrs = sessionHeaders(session.accessToken, appDetails.applicationId, USA_MISSION_ID, REFERER_CREATE_APT, true);

  /**
   * Vérifie le status HTTP et lève une erreur circuit-breaker si critique.
   * 429 → RateLimitError (ban imminent), 403 → AccountBlockedError, 401 → TokenExpiredError.
   * Retourne false si le statut est une erreur non-critique (scan de cet OFC abandonne).
   */
  function checkSlotResponse(res: Response, endpoint: string): boolean {
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
      console.error(`[usa] ⛔ RATE LIMIT (429) sur ${endpoint} — abandon scan complet`);
      throw new RateLimitError(endpoint, retryAfter * 1000);
    }
    if (res.status === 403) {
      console.error(`[usa] ⛔ ACCÈS REFUSÉ (403) sur ${endpoint} — compte potentiellement bloqué`);
      throw new AccountBlockedError(endpoint);
    }
    if (res.status === 401) {
      console.error(`[usa] ⛔ TOKEN EXPIRÉ (401) sur ${endpoint} — arrêt scan`);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      console.log(`[usa] ${endpoint} HTTP ${res.status} pour OFC ${ofc.postName}`);
      return false;
    }
    return true;
  }

  // 1. Premier mois disponible
  let firstMonth: UsaFirstAvailableMonthResponse;
  try {
    const res = await fetch(USA_FIRST_AVAILABLE_MONTH_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(basePayload),
    });
    if (!checkSlotResponse(res, "getFirstAvailableMonth")) return null;
    firstMonth = await res.json() as UsaFirstAvailableMonthResponse;
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) throw err;
    console.warn(`[usa] getFirstAvailableMonth erreur: ${err}`);
    return null;
  }

  if (!firstMonth.present || !firstMonth.date) {
    console.log(`[usa] Aucun créneau disponible pour OFC ${ofc.postName}`);
    return null;
  }

  console.log(`[usa] 📅 Premier mois disponible pour ${ofc.postName}: ${firstMonth.date}`);

  // 2. Dates disponibles dans ce mois
  const monthStart = new Date(firstMonth.date);
  monthStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const fromDate = monthStart > tomorrow ? toYMD(monthStart) : toYMD(tomorrow);
  const toDate = lastDayOfMonth(monthStart);

  let slotDates: UsaSlotDate[];
  try {
    const res = await fetch(USA_SLOT_DATES_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ ...basePayload, fromDate, toDate }),
    });
    if (!checkSlotResponse(res, "getSlotDates")) return null;
    const raw = await res.json();
    slotDates = Array.isArray(raw) ? raw as UsaSlotDate[] : [];
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) throw err;
    console.warn(`[usa] getSlotDates erreur: ${err}`);
    return null;
  }

  if (slotDates.length === 0) {
    console.log(`[usa] Aucune date disponible pour ${ofc.postName} entre ${fromDate} et ${toDate}`);
    return null;
  }

  console.log(`[usa] 📆 ${slotDates.length} date(s) avec créneaux pour ${ofc.postName}: ${slotDates.slice(0, 3).map(d => d.date).join(", ")}`);

  // 3. Horaires pour la première date disponible
  const targetDate = slotDates[0].date;
  let timeSlots: UsaTimeSlot[];
  try {
    const res = await fetch(USA_SLOT_TIMES_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ ...basePayload, fromDate, toDate, selectedDate: targetDate }),
    });
    if (!checkSlotResponse(res, "getSlotTime")) return null;
    const raw = await res.json();
    timeSlots = Array.isArray(raw) ? raw as UsaTimeSlot[] : [];
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) throw err;
    console.warn(`[usa] getSlotTime erreur: ${err}`);
    return null;
  }

  if (timeSlots.length === 0) {
    console.log(`[usa] Aucun horaire disponible pour ${ofc.postName} le ${targetDate}`);
    return null;
  }

  const slot = timeSlots[0];
  const rawTime = slot.startTime ?? "";
  const time = rawTime.includes("T") ? rawTime.split("T")[1].slice(0, 5) : rawTime.slice(0, 5);

  console.log(`[usa] 🎯 CRÉNEAU TROUVÉ — ${ofc.postName} le ${targetDate} à ${time} (slotId=${slot.slotId})`);
  return {
    date: targetDate,
    time,
    slotId: slot.slotId,
    ofcName: ofc.postName,
    slot,           // objet complet UsaTimeSlot pour le booking
    bookingBase: basePayload as Record<string, unknown>,  // champs communs au booking
  };
}

// ─────────────────────────────────────────────────────────────
// Types & fonction de booking automatique
// ─────────────────────────────────────────────────────────────

interface UsaBookingPayload {
  postUserId: number;
  applicantId: number;
  applicationId: string;
  visaType: string;
  visaClass: string;
  locationType: "OFC" | "POST";
  appointmentLocationType: "OFC" | "POST";
  slotId: number;
  date: string;
  startTime: string;
  endTime: string;
  [key: string]: unknown;
}

interface UsaBookingEntry {
  responseMsg?: string;
  appointmentId?: number;
  [key: string]: unknown;
}

type UsaBookingResponse = UsaBookingEntry[];

interface UsaBookingResult {
  success: boolean;
  appointmentId?: number;
  responseMsg?: string;
  error?: string;
  statusCode?: number;
}

/**
 * Réserve automatiquement un créneau trouvé par findFirstSlotForOfc.
 * PUT /visaappointmentapi/appointments/schedule
 *
 * Codes d'erreur connus (extraits du bundle Angular) :
 *   409 → créneau déjà pris par un autre usager (conflit)
 *   502 → erreur serveur temporaire
 *
 * Réponse succès : Array<{ responseMsg, appointmentId, ... }>
 */
async function bookUsaSlot(
  session: UsaSession,
  found: { slot: UsaTimeSlot; bookingBase: Record<string, unknown> }
): Promise<UsaBookingResult> {
  const payload = {
    ...found.bookingBase,
    ...found.slot,          // slotId, date, startTime, endTime + champs extra du portail
    appointmentLocationType: "OFC" as const,
  } as UsaBookingPayload;

  console.log(
    `[usa] 📝 Tentative de booking — slotId=${payload.slotId}, date=${payload.date}, ` +
    `OFC postUserId=${payload.postUserId}`
  );

  try {
    const res = await fetch(USA_SCHEDULE_URL, {
      method: "PUT",
      headers: sessionHeaders(session.accessToken, payload.applicationId),
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      let arr: UsaBookingResponse = [];
      try { arr = await res.json() as UsaBookingResponse; } catch { /* body vide */ }
      const msg = arr[0]?.responseMsg ?? "Booking confirmé";
      const appointmentId = arr[0]?.appointmentId;
      console.log(`[usa] ✅ BOOKING RÉUSSI — "${msg}" (appointmentId=${appointmentId})`);
      return { success: true, appointmentId, responseMsg: msg };
    }

    // 409 = créneau déjà pris
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { responseMessage?: string };
      const msg = body.responseMessage ?? "Créneau déjà pris (conflit 409)";
      console.warn(`[usa] ⚠️ Conflit 409 — ${msg}`);
      return { success: false, error: msg, statusCode: 409 };
    }

    // 502 = erreur serveur temporaire
    if (res.status === 502) {
      const body = await res.json().catch(() => ({})) as { responseMessage?: string };
      const msg = body.responseMessage ?? "Erreur serveur 502";
      console.warn(`[usa] ⚠️ Serveur 502 — ${msg}`);
      return { success: false, error: msg, statusCode: 502 };
    }

    const text = await res.text();
    console.warn(`[usa] ⚠️ Booking échoué HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { success: false, error: `HTTP ${res.status}`, statusCode: res.status };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] Booking erreur réseau: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Télécharge la lettre de confirmation de RDV au format PDF.
 * POST /visanotificationapi/template/appointmentLetter
 * Retourne le contenu PDF en Buffer, ou null en cas d'erreur.
 */
export async function downloadUsaConfirmationPdf(
  session: UsaSession,
  applicationId: string
): Promise<Buffer | null> {
  console.log(`[usa] Téléchargement confirmation PDF pour application ${applicationId}...`);
  try {
    const res = await fetch(USA_CONFIRMATION_LETTER_URL, {
      method: "POST",
      headers: {
        ...authHeaders(session.accessToken),
        "Accept": "application/pdf",
      },
      body: JSON.stringify({ applicationId }),
    });

    if (!res.ok) {
      console.warn(`[usa] downloadConfirmationPdf HTTP ${res.status}`);
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
      const text = await res.text();
      console.warn(`[usa] Réponse inattendue (non-PDF): ${text.slice(0, 200)}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    console.log(`[usa] Confirmation PDF téléchargée: ${buf.length} bytes`);
    return buf;
  } catch (err) {
    console.warn(`[usa] downloadConfirmationPdf erreur: ${err}`);
    return null;
  }
}

/**
 * Scan direct des créneaux USA via API — sans Playwright.
 * Utilise les endpoints découverts dans le bundle Angular du portail :
 *  - getFirstAvailableMonth → getSlotDates → getSlotTime
 * Remplace scanUsaSlotsWithBrowser (fragile, lent, consomme Chromium).
 */
async function scanUsaSlotsViaAPI(job: HunterJob, session: UsaSession): Promise<SessionResult> {
  if (!session.applicationId) {
    console.error("[usa] applicationId manquant dans la session — impossible de scanner");
    await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "applicationId manquant" });
    return "error";
  }

  // ── Anti-détection : reproduire le flux exact du portail Angular ────────────
  // Le portail appelle ces 3 endpoints à chaque ouverture de la page de booking.
  // Les omettre rend les requêtes de slot anormalement isolées → risque de ban.

  // a) Warm-up dashboard (getLandingPageDeatils) — navigation normale
  await callLandingPage(session);
  await randomDelay(400, 800);

  // b) Sanity check — vérifie l'état du workflow côté portail
  await callSanityCheck(session);
  await randomDelay(300, 600);

  // c) Vérification paiement FCS — confirmation avant booking
  const fcsOk = await checkFcsPayment(session);
  if (!fcsOk) {
    console.warn("[usa] checkFcs indique paiement non confirmé — scan interrompu");
    await sendHeartbeat({
      applicationId: job.id,
      result: "payment_required",
      errorMessage: "FCS payment check failed — paiement non confirmé côté serveur",
    });
    return "payment_required";
  }
  await randomDelay(300, 700);
  // ────────────────────────────────────────────────────────────────────────────

  // 1. Récupérer les détails de la demande (applicantId, visaType, visaClass)
  const appDetails = await getUsaApplicationDetails(session, session.applicationId);
  if (!appDetails) {
    console.warn("[usa] getApplicationDetails échoué — tentative avec userID comme applicantId");
  }

  const effectiveDetails: UsaAppDetails = appDetails ?? {
    applicantId: session.userID,
    applicationId: session.applicationId,
    visaType: "B",      // valeur par défaut pour visa touriste/affaires USA
    visaClass: "200",   // classe standard
    locationType: "OFC",
  };

  // 2. Récupérer la liste des OFCs pour la mission
  let ofcList: UsaOfc[];
  try {
    ofcList = await getUsaOfcList(session, USA_MISSION_ID);
  } catch (err) {
    if (err instanceof RateLimitError) {
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Rate limit (429) sur getOfcList` });
      return "error";
    }
    if (err instanceof AccountBlockedError || err instanceof TokenExpiredError) {
      const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
      if (cacheKey) tokenCache.delete(cacheKey);
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: err.message });
      return "error";
    }
    throw err;
  }
  if (ofcList.length === 0) {
    console.warn("[usa] Aucun OFC trouvé — vérifier missionId ou droits d'accès");
    await sendHeartbeat({
      applicationId: job.id,
      result: "not_found",
      errorMessage: `Aucun OFC disponible pour mission ${USA_MISSION_ID}`,
    });
    return "not_found";
  }

  // 3. Scanner chaque OFC à la recherche d'un créneau
  for (const ofc of ofcList) {
    console.log(`[usa] Scan OFC: ${ofc.postName} (postUserId=${ofc.postUserId})`);
    // Délai humain entre OFCs — un vrai utilisateur prend 1.5-4s pour passer d'un bureau à l'autre
    await randomDelay(1500, 4000);

    let found: SlotFound | null;
    try {
      found = await findFirstSlotForOfc(session, ofc, effectiveDetails);
    } catch (err) {
      if (err instanceof RateLimitError) {
        const waitSec = Math.round((err.retryAfterMs ?? 60000) / 1000);
        console.error(`[usa] ⛔ RATE LIMIT détecté — scan interrompu (retry-after: ${waitSec}s)`);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `Rate limit (429) — ${err.message}. Reprendre dans ~${waitSec}s.`,
        });
        return "error";
      }
      if (err instanceof AccountBlockedError) {
        console.error(`[usa] ⛔ COMPTE POTENTIELLEMENT BLOQUÉ — ${err.message}`);
        // Vider le cache pour forcer une reconnexion au prochain cycle
        const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
        if (cacheKey) tokenCache.delete(cacheKey);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `Compte bloqué (403) — ${err.message}`,
        });
        return "error";
      }
      if (err instanceof TokenExpiredError) {
        console.error(`[usa] ⛔ TOKEN EXPIRÉ en cours de scan — arrêt, reconnexion au prochain cycle`);
        const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
        if (cacheKey) tokenCache.delete(cacheKey);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: "Token JWT expiré en cours de scan — reconnexion requise",
        });
        return "error";
      }
      // Erreur inattendue — loguer et continuer sur le prochain OFC
      console.error(`[usa] Erreur inattendue sur OFC ${ofc.postName}: ${err}`);
      continue;
    }
    if (found) {
      // ── 1. Booking automatique ──────────────────────────────
      const booking = await bookUsaSlot(session, found);
      await randomDelay(1000, 2000);

      // ── 2. Télécharger le PDF de confirmation ───────────────
      let pdfStorageId: string | undefined;
      const pdf = await downloadUsaConfirmationPdf(session, session.applicationId);
      if (pdf) {
        console.log(`[usa] 📄 Confirmation PDF (${pdf.length} bytes) — upload vers Convex...`);
        const b64 = pdf.toString("base64");
        pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
        if (pdfStorageId) {
          console.log(`[usa] ✅ PDF uploadé → storageId: ${pdfStorageId}`);
        }
      }

      // ── 3. Rapport vers Convex ──────────────────────────────
      const bookingNote = booking.success
        ? `booking confirmé — appointmentId=${booking.appointmentId}`
        : `booking échoué (${booking.statusCode ?? "err"}: ${booking.error})`;

      await reportSlotFound({
        applicationId: job.id,
        date: found.date,
        time: found.time,
        location: `${found.ofcName} — Ambassade USA (slotId=${found.slotId}, ${bookingNote})`,
        confirmationCode: booking.appointmentId?.toString(),
        screenshotStorageId: pdfStorageId,
      });

      if (!booking.success && booking.statusCode === 409) {
        // Créneau pris en concurrence — continuer le scan sur les autres OFCs
        console.log("[usa] Conflit 409 — le créneau a été pris. Poursuite du scan...");
        continue;
      }

      return "slot_found";
    }
  }

  console.log(`[usa] Aucun créneau disponible sur ${ofcList.length} OFC(s)`);
  await sendHeartbeat({ applicationId: job.id, result: "not_found" });
  return "not_found";
}
