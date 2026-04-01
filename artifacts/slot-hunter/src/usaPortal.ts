import { createCipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { launchBrowser, randomDelay } from "./browser.js";
import { reportSlotFound, sendHeartbeat, uploadFile, type HunterJob } from "./convexClient.js";

type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed" | "payment_required";

const USA_BASE = "https://www.usvisaappt.com";
const USA_LOGIN_URL = `${USA_BASE}/identity/user/login`;
const USA_LOGOUT_URL = `${USA_BASE}/identity/user/logout`;
const USA_REFRESH_URL = `${USA_BASE}/identity/user/refreshToken`;
const USA_PAYMENT_URL = `${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus`;
const USA_APPT_REQUESTS_URL = `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser`;
const USA_MISSION_ID = 323;

// Endpoints de scan de créneaux — extraits du bundle Angular public
const USA_ADMIN_URL = `${USA_BASE}/visaadministrationapi/v1`;
const USA_APPOINTMENT_URL = `${USA_BASE}/visaappointmentapi`;
const USA_NOTIFICATION_URL = `${USA_BASE}/visanotificationapi`;

const USA_OFC_LIST_URL = (missionId: number) =>
  `${USA_ADMIN_URL}/ofcuser/ofclist/${missionId}`;
const USA_FIRST_AVAILABLE_MONTH_URL = `${USA_ADMIN_URL}/modifyslot/getFirstAvailableMonth`;
const USA_SLOT_DATES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotDates`;
const USA_SLOT_TIMES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotTime`;
const USA_APP_DETAILS_URL = (applicationId: string, applicantId: number) =>
  `${USA_APPOINTMENT_URL}/appointments/getApplicationDetails?applicationId=${applicationId}&applicantId=${applicantId}`;
const USA_CONFIRMATION_LETTER_URL = `${USA_NOTIFICATION_URL}/template/appointmentLetter`;
const USA_SCHEDULE_URL = `${USA_APPOINTMENT_URL}/appointments/schedule`;

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

const BROWSER_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "fr-CD,fr;q=0.9,en-US;q=0.6,en;q=0.5",
  "Cache-Control": "no-cache",
  "Content-Type": "application/json",
  "Pragma": "no-cache",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "Origin, Content-Type, X-Auth-Token, content-type,-CSRF-Token, Authorization",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Max-Age": "1000",
  "Origin": "https://www.usvisaappt.com",
  "Referer": "https://www.usvisaappt.com/visaapplicantui/login",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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
  status: "payment_required" | "scheduled" | "no_request" | "error";
  applicationId: string | null;
  pendingAppoStatus: number | null;
  primaryApplicant: string | null;
  message: string;
}> {
  const headers = {
    ...BROWSER_HEADERS,
    "Authorization": `Bearer ${session.accessToken}`,
    "Referer": "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests",
  };

  let data: UsaPaymentStatus | null = null;

  try {
    const res = await fetch(USA_PAYMENT_URL, { method: "GET", headers });
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

  if (appoStatus === 1) {
    return {
      status: "scheduled",
      applicationId: appId,
      pendingAppoStatus: 1,
      primaryApplicant: applicant,
      message: `Créneau déjà attribué pour ${applicant} (applicationId: ${appId})`,
    };
  } else if (appoStatus === 2) {
    return {
      status: "payment_required",
      applicationId: appId,
      pendingAppoStatus: 2,
      primaryApplicant: applicant,
      message: `Formulaire complet — paiement MRV (185$) non encore effectué par ${applicant}`,
    };
  } else {
    return {
      status: "no_request",
      applicationId: appId,
      pendingAppoStatus: appoStatus,
      primaryApplicant: applicant,
      message: `Aucune demande de RDV soumise (pendingAppoStatus: ${appoStatus})`,
    };
  }
}

export async function getUsaAppointmentRequests(session: UsaSession): Promise<UsaAppointmentRequest[]> {
  const headers = {
    ...BROWSER_HEADERS,
    "Authorization": `Bearer ${session.accessToken}`,
    "Referer": "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests",
  };

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

  // ── Résolution du dossier cible ────────────────────────────────────────────
  // Si l'admin a renseigné un portalApplicationId, on l'utilise directement.
  // Sinon, on interroge le portail pour récupérer le dossier actif du compte.
  // Ceci est indispensable quand un compte portail gère plusieurs personnes.
  const manualAppId = job.hunterConfig.portalApplicationId?.trim() || null;

  if (manualAppId) {
    console.log(`[usa] portalApplicationId spécifié manuellement: ${manualAppId}`);
    session.applicationId = manualAppId;
    session.pendingAppoStatus = 3; // En attente de RDV — pas encore de créneau
  }

  const requestStatus = await checkUsaAppointmentRequestStatus(session);

  // Si ID manuel fourni, on conserve l'applicationId forcé ; sinon on prend celui du portail.
  if (!manualAppId) {
    session.applicationId = requestStatus.applicationId;
  }
  session.pendingAppoStatus = requestStatus.pendingAppoStatus ?? session.pendingAppoStatus;

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

  if (requestStatus.status === "payment_required") {
    console.warn(`[usa] 💳 ${requestStatus.message}`);
    await sendHeartbeat({
      applicationId: job.id,
      result: "payment_required",
      errorMessage: requestStatus.message,
    });
    return "payment_required";
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

  console.log(`[usa] Paiement confirmé (pendingAppoStatus=1) — lancement scan créneaux via API directe...`);

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

function authHeaders(accessToken: string): Record<string, string> {
  return {
    ...BROWSER_HEADERS,
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
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
    const res = await fetch(url, { headers: authHeaders(session.accessToken) });
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
  try {
    const res = await fetch(USA_OFC_LIST_URL(missionId), {
      headers: authHeaders(session.accessToken),
    });
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

  // 1. Premier mois disponible
  let firstMonth: UsaFirstAvailableMonthResponse;
  try {
    const res = await fetch(USA_FIRST_AVAILABLE_MONTH_URL, {
      method: "POST",
      headers: authHeaders(session.accessToken),
      body: JSON.stringify(basePayload),
    });
    if (!res.ok) {
      console.log(`[usa] getFirstAvailableMonth HTTP ${res.status} pour OFC ${ofc.postName}`);
      return null;
    }
    firstMonth = await res.json() as UsaFirstAvailableMonthResponse;
  } catch (err) {
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
      headers: authHeaders(session.accessToken),
      body: JSON.stringify({ ...basePayload, fromDate, toDate }),
    });
    if (!res.ok) {
      console.log(`[usa] getSlotDates HTTP ${res.status} pour ${ofc.postName}`);
      return null;
    }
    const raw = await res.json();
    slotDates = Array.isArray(raw) ? raw as UsaSlotDate[] : [];
  } catch (err) {
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
      headers: authHeaders(session.accessToken),
      body: JSON.stringify({ ...basePayload, fromDate, toDate, selectedDate: targetDate }),
    });
    if (!res.ok) {
      console.log(`[usa] getSlotTime HTTP ${res.status} pour ${targetDate}`);
      return null;
    }
    const raw = await res.json();
    timeSlots = Array.isArray(raw) ? raw as UsaTimeSlot[] : [];
  } catch (err) {
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
      headers: authHeaders(session.accessToken),
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
  const ofcList = await getUsaOfcList(session, USA_MISSION_ID);
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
    await randomDelay(800, 1500);

    const found = await findFirstSlotForOfc(session, ofc, effectiveDetails);
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

async function scanUsaSlotsWithBrowser(job: HunterJob, session: UsaSession): Promise<SessionResult> {
  const { browser, page } = await launchBrowser();

  try {
    const bearerToken = `Bearer ${session.accessToken}`;

    await page.setExtraHTTPHeaders({
      "Authorization": bearerToken,
    });

    const slotRef: { value: { date: string; location: string } | null } = { value: null };

    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("appointment") ||
        url.includes("schedule") ||
        url.includes("slot") ||
        url.includes("available") ||
        url.includes("dates") ||
        url.includes("calendar")
      ) {
        try {
          const body = await response.text();
          if (body && body.length < 50000) {
            const parsed = JSON.parse(body);
            const hasSlot = detectUsaSlotInResponse(parsed);
            if (hasSlot && !slotRef.value) {
              slotRef.value = hasSlot;
              console.log(`[usa] 🎯 CRÉNEAU DÉTECTÉ via API interception: ${JSON.stringify(hasSlot)}`);
            }
          }
        } catch { /* ignore parse errors */ }
      }
    });

    const dashboardUrl = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests";
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(2000, 4000);

    const scheduleUrl = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/Appointment-scheduled";
    await page.goto(scheduleUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(3000, 6000);

    if (slotRef.value) {
      await reportSlotFound({
        applicationId: job.id,
        date: slotRef.value.date,
        time: "",
        location: slotRef.value.location || `Ambassade USA Kinshasa (Mission ${USA_MISSION_ID})`,
      });
      return "slot_found";
    }

    console.log("[usa] Aucun créneau disponible détecté");
    await sendHeartbeat({ applicationId: job.id, result: "not_found" });
    return "not_found";
  } catch (err) {
    console.error("[usa] Erreur scan créneaux:", err);
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: `Erreur scan USA: ${String(err).slice(0, 200)}`,
    });
    return "error";
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

function detectUsaSlotInResponse(data: unknown): { date: string; location: string } | null {
  if (!data || typeof data !== "object") return null;

  const obj = data as Record<string, unknown>;

  if (obj.appointmentDate && obj.appointmentTime) {
    return {
      date: `${String(obj.appointmentDate)} ${String(obj.appointmentTime)}`,
      location: String(obj.location ?? obj.facilityName ?? `Mission ${USA_MISSION_ID}`),
    };
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = detectUsaSlotInResponse(item);
      if (found) return found;
    }
  }

  if (obj.availableDates && Array.isArray(obj.availableDates) && obj.availableDates.length > 0) {
    return {
      date: String(obj.availableDates[0]),
      location: `Ambassade USA Kinshasa (Mission ${USA_MISSION_ID})`,
    };
  }

  if (obj.slots && Array.isArray(obj.slots) && obj.slots.length > 0) {
    const slot = obj.slots[0] as Record<string, unknown>;
    return {
      date: String(slot.date ?? slot.appointmentDate ?? ""),
      location: `Ambassade USA Kinshasa (Mission ${USA_MISSION_ID})`,
    };
  }

  for (const key of Object.keys(obj)) {
    if (
      key.toLowerCase().includes("available") &&
      Array.isArray(obj[key]) &&
      (obj[key] as unknown[]).length > 0
    ) {
      return {
        date: `Créneau disponible (${key})`,
        location: `Ambassade USA Kinshasa (Mission ${USA_MISSION_ID})`,
      };
    }
  }

  return null;
}
