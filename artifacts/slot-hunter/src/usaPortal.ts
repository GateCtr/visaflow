import { launchBrowser, randomDelay } from "./browser.js";
import { solveCaptchaForSite } from "./captcha.js";
import { reportSlotFound, sendHeartbeat, type HunterJob } from "./convexClient.js";

type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed" | "payment_required";

const USA_BASE = "https://www.usvisaappt.com";
const USA_LOGIN_URL = `${USA_BASE}/identity/user/login`;
const USA_REFRESH_URL = `${USA_BASE}/identity/user/refreshToken`;
const USA_PAYMENT_URL = `${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus`;
const USA_APPT_REQUESTS_URL = `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser`;
// nosemgrep: generic-api-key — clé reCAPTCHA v2 publique, visible dans le HTML de usvisaappt.com, non secrète
const USA_SITE_KEY = "6LdVVDAqAAAAAK4DS06UwosT8o1SA_3WhzUDAWAp";
const USA_LOGIN_PAGE = "https://www.usvisaappt.com/visaapplicantui/login";
const USA_MISSION_ID = 323;

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

export async function solveCaptchaForUsa(captchaApiKey: string): Promise<string | null> {
  console.log("[usa] Résolution reCAPTCHA via 2captcha (site key USA)...");
  const token = await solveCaptchaForSite(captchaApiKey, USA_SITE_KEY, USA_LOGIN_PAGE);
  if (token) {
    console.log("[usa] reCAPTCHA résolu avec succès");
  } else {
    console.error("[usa] Échec résolution reCAPTCHA");
  }
  return token;
}

export async function getUsaSession(
  username: string,
  password: string,
  captchaApiKey?: string
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

  // Tenter d'abord sans CAPTCHA (l'API l'accepte souvent sans token)
  let session: UsaSession | null = null;
  let lastError = "";

  try {
    console.log("[usa] Tentative login sans CAPTCHA...");
    session = await loginUsaPortal(username, password, null);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[usa] Login sans captcha échoué (${lastError}) — essai avec CAPTCHA...`);
  }

  if (!session && captchaApiKey) {
    console.log("[usa] Résolution CAPTCHA via 2captcha...");
    const captchaToken = await solveCaptchaForUsa(captchaApiKey);
    if (!captchaToken) {
      throw new Error(`Login sans captcha: ${lastError} | Résolution 2captcha: échec (vérifier balance et clé API)`);
    }
    try {
      session = await loginUsaPortal(username, password, captchaToken);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Login (sans captcha): ${lastError} | Login (avec captcha): ${errMsg}`);
    }
  } else if (!session) {
    throw new Error(lastError || "Login échoué (raison inconnue)");
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

export async function loginUsaPortal(
  username: string,
  password: string,
  captchaToken: string | null
): Promise<UsaSession | null> {
  console.log(`[usa] Connexion API pour ${username} (captcha: ${captchaToken ? "oui" : "non"})...`);

  const body: Record<string, unknown> = {
    userName: username,
    password,
    missionId: USA_MISSION_ID,
  };

  if (captchaToken) {
    body.captchaToken = captchaToken;
  }

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

  console.log(`[usa] Paiement confirmé (pendingAppoStatus=1) — lancement scan créneaux...`);

  const slotResult = await scanUsaSlotsWithBrowser(job, session);
  return slotResult;
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
