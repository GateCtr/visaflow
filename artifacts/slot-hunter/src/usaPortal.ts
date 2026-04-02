import { createCipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { ProxyAgent } from "undici";
import { randomDelay, proxyPool } from "./browser.js";
import { reportSlotFound, sendHeartbeat, uploadFile, type HunterJob } from "./convexClient.js";

type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed" | "payment_required";

const USA_BASE = "https://www.usvisaappt.com";
const USA_LOGIN_URL = `${USA_BASE}/identity/user/login`;
const USA_LOGOUT_URL = `${USA_BASE}/identity/user/logout`;
const USA_REFRESH_URL = `${USA_BASE}/identity/user/refreshToken`;
const USA_PAYMENT_STATUS_URL = `${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus`;
// Bundle Angular : "/appointmentrequest/getallbyuser?type=GROUPREQUEST" pour les utilisateurs réguliers.
const USA_APPT_REQUESTS_URL = `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser?type=GROUPREQUEST`;
const USA_MISSION_ID = 323;

// Endpoints de scan de créneaux — extraits du bundle Angular public
const USA_ADMIN_URL = `${USA_BASE}/visaadministrationapi/v1`;
const USA_APPOINTMENT_URL = `${USA_BASE}/visaappointmentapi`;
const USA_NOTIFICATION_URL = `${USA_BASE}/visanotificationapi`;
const USA_PAYMENT_URL = `${USA_BASE}/visapaymentapi/v1`;
const USA_WORKFLOW_URL = `${USA_BASE}/visaworkflowprocessor`;
const USA_INTEGRATION_URL = `${USA_BASE}/visaintegrationapi`; // sanity check

// Bundle Angular (booking flow) : slotBookingService.getFilteredOfcPostList(De)
//   → GET visaAdminUrl + "/lookupcdt/wizard/getpost" avec params :
//     { visaCategory?, visaClass?, stateCode?, priority?, missionId }
// Différent de getOfcListByMissionId (admin only) → GET /ofcuser/ofclist/{missionId}
const USA_OFC_LIST_URL = (missionId: number, visaClass?: string, visaCategory?: string): string => {
  const params = new URLSearchParams();
  if (visaCategory) params.append("visaCategory", visaCategory);
  if (visaClass && visaClass !== "nil") params.append("visaClass", visaClass);
  params.append("missionId", String(missionId));
  return `${USA_ADMIN_URL}/lookupcdt/wizard/getpost?${params.toString()}`;
};
const USA_FIRST_AVAILABLE_MONTH_URL = `${USA_ADMIN_URL}/modifyslot/getFirstAvailableMonth`;
const USA_SLOT_DATES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotDates`;
const USA_SLOT_TIMES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotTime`;
const USA_APP_DETAILS_URL = (applicationId: string, applicantId: number) =>
  `${USA_APPOINTMENT_URL}/appointments/getApplicationDetails?applicationId=${applicationId}&applicantId=${applicantId}`;
const USA_CONFIRMATION_LETTER_URL = `${USA_NOTIFICATION_URL}/template/appointmentLetter`;
const USA_SCHEDULE_URL = `${USA_APPOINTMENT_URL}/appointments/schedule`;
// Anti-détection : endpoints que le vrai portail appelle dans son flux normal
const USA_LANDING_PAGE_URL = `${USA_APPOINTMENT_URL}/appointment/getLandingPageDeatils`;
// Retourne l'URL de base du sanity check — le stepType est ajouté en query param par l'appelant.
// Bundle Angular : this.sanityCheckUrl+`/visa/sanitycheck/${f}`,null,E?{params:{stepType:E}}:{}
const USA_SANITY_CHECK_URL = (applicationId: string, stepType: "slotBooking" | "appointmentLetter") =>
  `${USA_INTEGRATION_URL}/visa/sanitycheck/${applicationId}?stepType=${stepType}`;
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
export const USA_ENC_SEC_KEY = "OuoCdl8xQh/OX6LbmgLEtZxZrvnOmrubsMhPW1VPRjk=";

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
  csrfToken: string;
  expiresAt: number;
  userID: number;
  fullName: string;
  /** Index dans USA_UA_POOL assigné lors du login — réutilisé pour toute la durée du JWT.
   * Un même JWT vu depuis des UAs différents est une empreinte bot détectable. */
  uaIndex?: number;
  /** Proxy résidentiel assigné lors du login — réutilisé pour toute la durée du JWT.
   * Un même JWT vu depuis des IPs différentes est détectable côté serveur. */
  proxyUrl?: string;
  /** Jitter aléatoire ±5 min (en ms) appliqué sur TOKEN_REFRESH_BUFFER_MS.
   * Évite un pattern de login prédictible à intervalle fixe de ~55 min.
   * Calculé une fois au login — conservé lors des refreshs pour une dispersion cohérente. */
  jitterMs: number;
  /** OFCs autorisés pour ce compte — extrait de loggedInApplicantUser.ofc au login.
   * Bundle : S?.length>0 && (ofcList = ofcList.filter(B => S.some(se => se.postUserId===B.postUserId)))
   * Vide (non filtré) si le compte n'a pas de restriction d'OFC. */
  allowedOfcs?: Array<{ postUserId: number }>;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Verrou de login concurrent : si deux jobs pour le même compte tentent un login simultané,
 * le deuxième attend la résolution du premier au lieu d'envoyer une 2e requête au serveur.
 * Deux logins simultanés peuvent déclencher un lockout côté portail.
 */
const pendingLogin = new Map<string, Promise<UsaSession | null>>();

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
  // Le jitter ±5 min est fixé au moment du login et conservé tout au long du JWT.
  // Résultat : chaque compte se reconnecte à un moment légèrement différent,
  // ce qui brise le pattern "login toutes les 55 min pile" détectable par le portail.
  return Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS - cached.jitterMs;
}

async function refreshUsaToken(cached: CachedToken, username: string): Promise<CachedToken | null> {
  console.log("[usa] Renouvellement token via refresh token...");
  try {
    // Bundle Angular : http.post(authURL+"/refreshToken", {refreshToken, username}, {observe:"response"})
    // Les deux champs sont requis — le portail vérifie la cohérence refreshToken↔compte.
    const res = await usaFetch(USA_REFRESH_URL, {
      method: "POST",
      // Le refresh est appelé depuis la session active — referer = dashboard
      // Content-Type obligatoire car le body est du JSON
      headers: {
        ...getBrowserHeaders(),
        "Content-Type": "application/json",
        "Referer": REFERER_DASHBOARD,
      },
      body: JSON.stringify({ refreshToken: cached.refreshToken, username }),
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
      // Le CSRF token ne change pas lors du refresh (le bundle n'en capture pas un nouveau
      // dans fetchNewRefreshToken — seul l'Authorization header est sauvegardé).
      csrfToken: cached.csrfToken,
      expiresAt,
      userID: cached.userID,
      fullName: cached.fullName,
      // Proxy + UA hérités du token précédent — sticky pour toute la chaîne de refresh.
      uaIndex: cached.uaIndex,
      proxyUrl: cached.proxyUrl,
      // Jitter conservé du login initial — la dispersion temporelle reste cohérente
      // sur toute la chaîne de refreshs d'un même compte.
      jitterMs: cached.jitterMs,
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
  /** MFA requis : 1 (ou truthy) si le compte a l'authentification à 2 facteurs activée.
   * Dans ce cas, le token renvoyé est invalide et le bot doit avorter le login. */
  mfa?: number | boolean;
  /** Premier login forcé à changer le mot de passe — le bot ne gère pas ce cas. */
  firstTimeLogin?: boolean;
  /** OFCs autorisés pour ce compte.
   * Bundle : localStorage.setItem("loggedInApplicantUser", JSON.stringify(F.body))
   * Puis : S = JSON.parse(loggedInApplicantUser).ofc
   *        ofcList = ofcList.filter(B => S.some(se => se.postUserId === B.postUserId))
   * Si absent/vide : aucun filtre appliqué (compte sans restriction d'OFC). */
  ofc?: Array<{ postUserId: number }>;
}

interface UsaAppointmentRequest {
  applicationId: string;
  missionId: number;
  pendingAppoStatus: number;
  primaryApplicant: string;
  cancellable: boolean;
  messagetext: string | null;
  /** applicantId interne (si retourné par getUserHistoryApplicantPaymentStatus).
   * Correspond à selectedSlotDetails.applicantId dans le bundle Angular.
   * À utiliser de préférence à userID comme param applicantId de getApplicationDetails. */
  applicantId?: number;
  /** appointmentId interne du dossier en attente de créneau.
   * Bundle Angular : this.selectedSlotDetails.appointmentId
   * OBLIGATOIRE dans le payload PUT /appointments/schedule — le serveur l'utilise
   * pour identifier quelle demande de RDV associer au créneau réservé.
   * Sans lui, le payload est incorrect et le booking peut échouer silencieusement. */
  appointmentId?: number;
  /** applicantUUID interne — également requis dans le payload de booking.
   * Bundle Angular : this.selectedSlotDetails.applicantUUID */
  applicantUUID?: number;
}


export interface UsaSession {
  accessToken: string;
  refreshToken: string;
  /** Token CSRF retourné dans le header "Csrftoken" de la réponse de login.
   * L'intercepteur Angular l'injecte sous la forme CookieName: XSRF-TOKEN={csrfToken}
   * sur TOUS les PUT (source : bundle Angular, intercepteur HTTP). */
  csrfToken: string;
  userID: number;
  fullName: string;
  applicationId: string | null;
  pendingAppoStatus: number | null;
  /** missionId retourné par le serveur (cookie "missionId" dans le portail Angular).
   * Priorité sur USA_MISSION_ID si présent — garantit qu'on utilise la valeur serveur. */
  missionId: number;
  /** applicantId interne retourné par getUserHistoryApplicantPaymentStatus.
   * Correspond à selectedSlotDetails.applicantId dans le bundle Angular.
   * Utilisé comme param ?applicantId= dans getApplicationDetails à la place du userID
   * si le serveur le retourne — sinon on retombe sur userID comme fallback. */
  applicantId?: number;
  /** appointmentId interne du dossier en attente de créneau.
   * Bundle Angular : this.selectedSlotDetails.appointmentId
   * Inclus obligatoirement dans le payload PUT /appointments/schedule. */
  appointmentId?: number;
  /** applicantUUID interne — requis dans le payload de booking.
   * Bundle Angular : this.selectedSlotDetails.applicantUUID */
  applicantUUID?: number;
  /** OFCs autorisés pour ce compte — propagé depuis la réponse de login (data.ofc).
   * Bundle : S = JSON.parse(loggedInApplicantUser).ofc
   * Si non vide, seuls les OFCs dont postUserId figure dans cette liste sont scannés.
   * Vide ou absent = aucune restriction (compte sans filtre OFC). */
  allowedOfcs?: Array<{ postUserId: number }>;
}

// Referers spécifiques à chaque étape de navigation du portail Angular.
// Chaque appel API reçoit le referer de la page qui l'a déclenché (comme un vrai navigateur).
const REFERER_LOGIN      = "https://www.usvisaappt.com/visaapplicantui/login";
const REFERER_DASHBOARD  = "https://www.usvisaappt.com/visaapplicantui/home/dashboard";
const REFERER_REQUESTS   = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests";
const REFERER_CREATE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment";

// ─── Pool UA Chrome/Edge pour les appels API USA ─────────────────────────────
// Le portail Angular envoie des requêtes depuis Chrome uniquement → pas de Firefox/Safari ici.
// Sec-CH-UA doit correspondre exactement à la version Chrome dans le User-Agent (cohérence).
// IMPORTANT : ne jamais inclure de headers CORS côté requête (Access-Control-Allow-*) —
// ce sont des headers de RÉPONSE que seul le serveur envoie, jamais le navigateur.
const USA_UA_POOL: ReadonlyArray<{ ua: string; chUa: string; platform: string }> = [
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="134", "Google Chrome";v="134", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
  {
    ua:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"',
    platform: '"macOS"',
  },
  {
    ua:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="8"',
    platform: '"macOS"',
  },
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
    chUa:     '"Chromium";v="136", "Microsoft Edge";v="136", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
];

// UA actif pour la session courante — changé à chaque appel de runUsaApiSession()
let _sessionUa = USA_UA_POOL[1]; // Chrome/135 Windows par défaut

function pickSessionUa(): void {
  _sessionUa = USA_UA_POOL[Math.floor(Math.random() * USA_UA_POOL.length)];
  console.log(`[usa] UA session: ${_sessionUa.ua.match(/Chrome\/[\d.]+/)?.[0] ?? _sessionUa.ua.slice(0, 60)}`);
}

function getBrowserHeaders(): Record<string, string> {
  return {
    "Accept":             "application/json, text/plain, */*",
    // Chrome 123+ inclut zstd — son absence est un signal JA4H bot identifiable
    "Accept-Encoding":    "gzip, deflate, br, zstd",
    "Accept-Language":    "fr-CD,fr;q=0.9,en-US;q=0.6,en;q=0.5",
    "Cache-Control":      "no-cache",
    // NOTE : LanguageId N'est PAS ajouté ici.
    // L'intercepteur Angular ne l'envoie QUE pour /getLandingPageDeatils et /generatewizardtemplate.
    // Toutes les autres requêtes (slots, booking, login…) NE reçoivent PAS ce header.
    // → ajouté explicitement dans callLandingPage() uniquement.
    "Pragma":             "no-cache",
    "Origin":             "https://www.usvisaappt.com",
    "Referer":            REFERER_LOGIN,
    "Sec-CH-UA":          _sessionUa.chUa,
    "Sec-CH-UA-Mobile":   "?0",
    "Sec-CH-UA-Platform": _sessionUa.platform,
    "Sec-Fetch-Dest":     "empty",
    "Sec-Fetch-Mode":     "cors",
    "Sec-Fetch-Site":     "same-origin",
    "User-Agent":         _sessionUa.ua,
  };
}

// ─── Proxy résidentiel pour les appels API USA ────────────────────────────────
// Le proxyPool Playwright est 2captcha résidentiel — on l'injecte aussi dans fetch()
// via undici ProxyAgent pour que le portail USA voie une IP résidentielle, pas Railway.
// setUsaSessionProxy() est appelé au début de runUsaApiSession() et réinitialisé à la fin.
let _usaProxyAgent: ProxyAgent | undefined;

function setUsaSessionProxy(proxyUrl: string | undefined): void {
  if (proxyUrl) {
    _usaProxyAgent = new ProxyAgent(proxyUrl);
    const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
    console.log(`[usa] Proxy résidentiel actif: ${masked}`);
  } else {
    _usaProxyAgent = undefined;
  }
}

async function usaFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (_usaProxyAgent) {
    // @ts-expect-error — dispatcher est une option interne undici non présente dans RequestInit standard
    return fetch(url, { ...options, dispatcher: _usaProxyAgent });
  }
  return fetch(url, options);
}


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
        csrfToken: cached.csrfToken,
        userID: cached.userID,
        fullName: cached.fullName,
        applicationId: null,
        pendingAppoStatus: null,
        missionId: USA_MISSION_ID,
        allowedOfcs: cached.allowedOfcs ?? [],
      };
    }

    console.log("[usa] Token expiré — tentative de renouvellement...");
    const refreshed = await refreshUsaToken(cached, username);
    if (refreshed) {
      tokenCache.set(cacheKey, refreshed);
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        csrfToken: refreshed.csrfToken,
        userID: refreshed.userID,
        fullName: refreshed.fullName,
        applicationId: null,
        pendingAppoStatus: null,
        missionId: USA_MISSION_ID,
        // Préserver les OFCs autorisés depuis le token précédent — le refresh ne recrée pas la session
        allowedOfcs: cached.allowedOfcs ?? [],
      };
    }
    console.log("[usa] Refresh échoué — reconnexion complète");
    tokenCache.delete(cacheKey);
  }

  // ── Verrou anti-race-condition ──────────────────────────────────────────────
  // Si un login est déjà en cours pour ce compte (job concurrent), on attend sa
  // résolution plutôt que d'envoyer une 2e requête qui pourrait déclencher un lockout.
  const inFlight = pendingLogin.get(cacheKey);
  if (inFlight) {
    console.log(`[usa] Login déjà en cours pour ${username} — attente de la réponse en cours...`);
    return inFlight;
  }

  const loginPromise = (async (): Promise<UsaSession | null> => {
    let session: UsaSession | null = null;
    try {
      console.log("[usa] Login API avec credentials AES chiffrés...");
      session = await loginUsaPortal(username, password, null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Login USA échoué: ${msg}`);
    } finally {
      pendingLogin.delete(cacheKey);
    }

    if (!session) return null;

    const expiresAt = parseJwtExpiry(session.accessToken) || Date.now() + 55 * 60 * 1000;
    // Jitter ±5 min calculé une fois au login. Valeur aléatoire en ms dans [-300_000, +300_000].
    // Appliqué dans isCachedTokenValid() pour décaler l'expiration perçue de chaque compte,
    // évitant le pattern "login toutes les 55 min pile" corrélable entre comptes.
    const jitterMs = Math.floor((Math.random() * 2 - 1) * 5 * 60 * 1000);
    // uaIndex et proxyUrl sont volontairement absents ici — runUsaApiSession les injecte
    // immédiatement après (il connaît le proxy + UA assignés pour ce nouveau token).
    tokenCache.set(cacheKey, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      csrfToken: session.csrfToken,
      expiresAt,
      allowedOfcs: session.allowedOfcs ?? [],
      userID: session.userID,
      fullName: session.fullName,
      jitterMs,
    });

    return session;
  })();

  pendingLogin.set(cacheKey, loginPromise);
  return loginPromise;
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
      const res = await usaFetch(USA_LOGOUT_URL, {
        method: "POST",
        headers: {
          ...getBrowserHeaders(),
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
    response = await usaFetch(USA_LOGIN_URL, {
      method: "POST",
      // Content-Type obligatoire : body JSON. Referer = page de login (le formulaire poste vers lui-même).
      // authHeaders() ne convient pas ici car on n'a pas encore de token.
      headers: {
        ...getBrowserHeaders(),
        "Content-Type": "application/json",
        "Referer": REFERER_LOGIN,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[usa] Erreur réseau lors du login:", err);
    throw new Error(`Réseau: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 429 au login = trop de tentatives → risque de lockout compte
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
    throw new RateLimitError(USA_LOGIN_URL, waitMs);
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
  // "Csrftoken" : header de réponse de login capturé par le bundle Angular
  // (localStorage.setItem("CSRFTOKEN", this.csrfToken) dans le portail).
  // Réutilisé dans le header "CookieName: XSRF-TOKEN={csrfToken}" sur tous les PUT.
  const csrfToken = response.headers.get("csrftoken") ?? "";

  if (data.msg && (data.msg.toLowerCase().includes("invalid") || data.msg.toLowerCase().includes("incorrect"))) {
    console.error(`[usa] Login refusé par le portail: ${data.msg}`);
    throw new Error(`Portail: ${data.msg}`);
  }

  // Détection MFA — bundle: "1 == j.body?.mfa ? (this.mfaMsg = j.body?.msg, ...) : ..."
  // Si mfa est truthy (1 ou true), le portail demande un OTP — le bot ne supporte pas ce cas.
  // Le token renvoyé dans ce cas serait invalide, donc on avorte proprement.
  if (data.mfa) {
    console.error(`[usa] Compte avec MFA activé — message portail: ${data.msg ?? "none"}`);
    throw new Error(
      `Compte MFA activé (mfa=${data.mfa}) — authentification à 2 facteurs non supportée par le bot. ` +
      `Désactivez le MFA sur votre compte usvisaappt.com pour utiliser Joventy.`
    );
  }

  // Détection "firstTimeLogin" — le portail force un changement de mot de passe
  if (data.firstTimeLogin) {
    console.error(`[usa] Premier login — le portail exige un changement de mot de passe.`);
    throw new Error(
      `Premier login détecté — connectez-vous une fois manuellement sur usvisaappt.com pour changer votre mot de passe avant d'utiliser Joventy.`
    );
  }

  // Comparaison insensible à la casse — le serveur peut renvoyer "active", "Active" ou "ACTIVE"
  if ((data.isActive ?? "").toUpperCase() !== "ACTIVE") {
    console.warn(`[usa] Compte inactif: isActive=${data.isActive}, msg=${data.msg}`);
    throw new Error(`Compte non actif (isActive=${data.isActive})`);
  }

  if (!accessToken) {
    console.error("[usa] JWT absent du header 'authorization'");
    throw new Error("JWT manquant dans la réponse — login incomplet");
  }

  console.log(`[usa] Connecté en tant que ${data.fullName} (userID: ${data.userID}) — csrfToken: ${csrfToken ? `${csrfToken.slice(0, 8)}...` : "(absent)"}`);

  // Bundle : localStorage.setItem("loggedInApplicantUser", JSON.stringify(F.body))
  // Les OFCs autorisés pour ce compte sont dans F.body.ofc (tableau de {postUserId}).
  // Utilisés après getFilteredOfcPostList pour filtrer la liste des OFCs disponibles.
  const allowedOfcs: Array<{ postUserId: number }> = Array.isArray(data.ofc) ? data.ofc : [];
  if (allowedOfcs.length > 0) {
    console.log(`[usa] OFCs autorisés pour ${data.fullName}: ${allowedOfcs.map(o => o.postUserId).join(", ")}`);
  }

  return {
    accessToken,
    refreshToken: refreshToken ?? "",
    csrfToken,
    userID: data.userID,
    fullName: data.fullName,
    applicationId: null,
    pendingAppoStatus: null,
    missionId: USA_MISSION_ID,
    allowedOfcs,
  };
}

export async function checkUsaAppointmentRequestStatus(session: UsaSession): Promise<{
  status: "payment_required" | "scheduled" | "no_request" | "pending" | "error";
  applicationId: string | null;
  pendingAppoStatus: number | null;
  primaryApplicant: string | null;
  message: string;
  /** missionId tel que retourné par le serveur — à propager dans session.missionId */
  missionId: number;
  /** applicantId interne retourné par le serveur — à propager dans session.applicantId.
   * Utilisé à la place de session.userID dans le call ?applicantId= de getApplicationDetails. */
  applicantId?: number;
  /** appointmentId interne — à propager dans session.appointmentId.
   * Obligatoire dans le payload PUT /appointments/schedule (bundle: selectedSlotDetails.appointmentId). */
  appointmentId?: number;
  /** applicantUUID interne — à propager dans session.applicantUUID.
   * Obligatoire dans le payload PUT /appointments/schedule (bundle: selectedSlotDetails.applicantUUID). */
  applicantUUID?: number;
}> {
  const headers = authHeaders(session.accessToken, REFERER_REQUESTS, false);
  let data: UsaAppointmentRequest | null = null;

  try {
    const res = await usaFetch(USA_PAYMENT_STATUS_URL, { method: "GET", headers });
    if (!res.ok) {
      console.error(`[usa] Appointment status HTTP ${res.status}`);
      // 403/401 : le compte peut être bloqué ou le token invalide juste après le login —
      // vider le cache pour forcer une reconnexion propre au prochain cycle.
      if (res.status === 403 || res.status === 401) {
        const cacheKey = session.accessToken
          ? [...tokenCache.entries()].find(([, v]) => v.accessToken === session.accessToken)?.[0]
          : undefined;
        if (cacheKey) {
          console.warn(`[usa] ${res.status} sur appointment status — cache token vidé pour reconnexion`);
          tokenCache.delete(cacheKey);
        }
      }
      return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: `HTTP ${res.status}`, missionId: USA_MISSION_ID };
    }
    const raw = await res.json();
    if (!raw || typeof raw !== "object") {
      return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Aucune demande de RDV trouvée", missionId: USA_MISSION_ID };
    }
    // Le portail peut renvoyer un objet unique ou un tableau à un seul élément.
    data = (Array.isArray(raw) ? raw[0] : raw) as UsaAppointmentRequest;
    if (!data) {
      return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Tableau vide — aucune demande de RDV", missionId: USA_MISSION_ID };
    }
  } catch (err) {
    console.error("[usa] Erreur appel appointment status:", err);
    return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: String(err), missionId: USA_MISSION_ID };
  }

  const appId = data.applicationId ?? null;
  const appoStatus = data.pendingAppoStatus ?? null;
  const applicant = data.primaryApplicant ?? null;
  // applicantId interne (bundle : selectedSlotDetails.applicantId) — peut être absent de la réponse.
  const serverApplicantId: number | undefined =
    typeof data.applicantId === "number" ? data.applicantId : undefined;
  // appointmentId — CRITIQUE pour le payload de booking (bundle: selectedSlotDetails.appointmentId).
  const serverAppointmentId: number | undefined =
    typeof data.appointmentId === "number" ? data.appointmentId : undefined;
  // applicantUUID — requis dans le payload de booking (bundle: selectedSlotDetails.applicantUUID).
  const serverApplicantUUID: number | undefined =
    typeof data.applicantUUID === "number" ? data.applicantUUID : undefined;

  console.log(`[usa] pendingAppoStatus=${appoStatus} applicationId=${appId} applicant=${applicant}${serverApplicantId !== undefined ? ` applicantId=${serverApplicantId}` : ""}${serverAppointmentId !== undefined ? ` appointmentId=${serverAppointmentId}` : ""}${serverApplicantUUID !== undefined ? ` applicantUUID=${serverApplicantUUID}` : ""}`);

  // Interprétation de pendingAppoStatus — tirée du bundle Angular (getAppIdByUserId) :
  //   0           → aucune demande / paiement non confirmé (portal: synchronizeAccount)
  //   1           → créneau déjà attribué (portal: redirect dashboard)
  //   2, 3, etc.  → paiement fait, en attente de créneau (portal: aller à l'appointment create)
  // Le bundle confirme : "0 !== pendingAppoStatus" → toujours redirigé vers la création de RDV.

  // missionId retourné par le serveur (dans la réponse JSON) — fait office de cookie "missionId" du portail.
  const serverMissionId = typeof data.missionId === "number" && data.missionId > 0
    ? data.missionId
    : USA_MISSION_ID;

  if (appoStatus === 0 || appoStatus === null) {
    return {
      status: "no_request",
      applicationId: appId,
      pendingAppoStatus: appoStatus,
      primaryApplicant: applicant,
      message: `Aucune demande active ou paiement non confirmé (pendingAppoStatus: ${appoStatus})`,
      missionId: serverMissionId,
      applicantId: serverApplicantId,
      appointmentId: serverAppointmentId,
      applicantUUID: serverApplicantUUID,
    };
  }

  if (appoStatus === 1) {
    return {
      status: "scheduled",
      applicationId: appId,
      pendingAppoStatus: 1,
      primaryApplicant: applicant,
      message: `Créneau déjà attribué pour ${applicant} (applicationId: ${appId})`,
      missionId: serverMissionId,
      applicantId: serverApplicantId,
      appointmentId: serverAppointmentId,
      applicantUUID: serverApplicantUUID,
    };
  }

  // Status 2, 3 ou tout autre valeur non nulle = paiement effectué, scan pour créneau
  return {
    status: "pending",
    applicationId: appId,
    pendingAppoStatus: appoStatus,
    primaryApplicant: applicant,
    message: `Paiement confirmé (status=${appoStatus}) — scan créneaux pour ${applicant}`,
    missionId: serverMissionId,
    applicantId: serverApplicantId,
    appointmentId: serverAppointmentId,
    applicantUUID: serverApplicantUUID,
  };
}

export async function getUsaAppointmentRequests(session: UsaSession): Promise<UsaAppointmentRequest[]> {
  const headers = authHeaders(session.accessToken, REFERER_REQUESTS, false);

  try {
    const res = await usaFetch(USA_APPT_REQUESTS_URL, { method: "GET", headers });
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

  // ── Proxy + UA sticky sur la durée du JWT ────────────────────────────────
  // Principe : un même JWT doit toujours être présenté depuis la même IP et avec
  // le même User-Agent. Changer d'IP ou d'UA en cours de token = empreinte bot.
  //
  //  • Cache hit (token valide) → réutiliser le proxy et l'UA du cache
  //  • Nouveau token (login ou expiry) → assigner un nouveau proxy + UA,
  //    puis les stocker dans le cache juste après le login réussi.
  const cacheKeySticky = username.toLowerCase();
  const cachedSticky = tokenCache.get(cacheKeySticky);
  const hasStickyCache = cachedSticky !== undefined && isCachedTokenValid(cachedSticky);

  let sessionProxy: string | undefined;
  let sessionUaIdx: number;

  if (hasStickyCache && cachedSticky) {
    sessionProxy  = cachedSticky.proxyUrl;
    sessionUaIdx  = cachedSticky.uaIndex ?? Math.floor(Math.random() * USA_UA_POOL.length);
    const maskedProxy = sessionProxy ? sessionProxy.replace(/:([^:@]+)@/, ":***@") : "aucun (direct)";
    console.log(`[usa] Token en cache → proxy sticky: ${maskedProxy} | UA idx ${sessionUaIdx}`);
  } else {
    // Nouveau token → nouvelle identité réseau + navigateur
    sessionProxy = await proxyPool.getProxy();
    sessionUaIdx = Math.floor(Math.random() * USA_UA_POOL.length);
    console.log(`[usa] Nouveau token → nouvelle identité (UA idx ${sessionUaIdx})`);
  }

  // Activer le proxy et l'UA choisis pour TOUTE cette session
  _sessionUa = USA_UA_POOL[sessionUaIdx];
  console.log(`[usa] UA: ${_sessionUa.ua.match(/(?:Chrome|Edg)\/[\d.]+/)?.[0] ?? _sessionUa.ua.slice(0, 60)}`);
  setUsaSessionProxy(sessionProxy);
  if (!sessionProxy) {
    console.warn("[usa] ⚠️ Aucun proxy résidentiel — appels API via IP Railway directe");
  }
  // ──────────────────────────────────────────────────────────────────────────

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

  // ── Sticky proxy/UA : injecter dans le cache si nouveau token ────────────
  // getUsaSession() a créé une nouvelle entrée cache sans proxy ni UA.
  // On les injecte maintenant pour que les sessions suivantes (cache hit)
  // réutilisent exactement la même identité réseau.
  if (!hasStickyCache) {
    const freshEntry = tokenCache.get(cacheKeySticky);
    if (freshEntry) {
      freshEntry.proxyUrl = sessionProxy;
      freshEntry.uaIndex  = sessionUaIdx;
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Résolution du dossier actif ────────────────────────────────────────────
  // Le portail retourne toujours l'applicationId du dossier actif de la session.
  // Une session = un compte = un dossier principal → pas d'ambiguïté.
  const requestStatus = await checkUsaAppointmentRequestStatus(session);
  session.applicationId = requestStatus.applicationId;
  session.pendingAppoStatus = requestStatus.pendingAppoStatus;
  // Priorité au missionId serveur (équivalent au cookie "missionId" que le portail Angular lit).
  session.missionId = requestStatus.missionId;
  // applicantId interne (bundle : selectedSlotDetails.applicantId) — propagé si le serveur le retourne.
  if (requestStatus.applicantId !== undefined) {
    session.applicantId = requestStatus.applicantId;
  }
  // appointmentId interne — OBLIGATOIRE dans le payload de booking.
  // Bundle Angular : this.selectedSlotDetails.appointmentId → envoyé dans le PUT /appointments/schedule.
  if (requestStatus.appointmentId !== undefined) {
    session.appointmentId = requestStatus.appointmentId;
  }
  // applicantUUID interne — requis dans le payload de booking.
  if (requestStatus.applicantUUID !== undefined) {
    session.applicantUUID = requestStatus.applicantUUID;
  }

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
        location: `Ambassade USA Kinshasa (Mission ${session.missionId})`,
      });
    } catch { /* ignore */ }
    return "slot_found";
  }

  console.log(`[usa] ${requestStatus.message} — lancement scan créneaux via API directe...`);

  try {
    const slotResult = await scanUsaSlotsViaAPI(job, session);
    return slotResult;
  } finally {
    setUsaSessionProxy(undefined);
  }
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
  /** appointmentStatus — bundle Angular filtre sur "NEW" pour obtenir selectedSlotDetails. */
  appointmentStatus?: string;
  /** appointmentLocationType — "OFC" | "POST" */
  appointmentLocationType?: string;
  /** appointmentId — obligatoire dans le payload de booking (bundle Angular : selectedSlotDetails.appointmentId).
   * Vient de la réponse tableau de getApplicationDetails, filtrée sur appointmentStatus === "NEW". */
  appointmentId?: number;
  /** UUID de l'applicant — inclus dans le payload de booking (bundle Angular : selectedSlotDetails.applicantUUID).
   * Peut être string (sessionStorage) ou number (parseInt). On stocke string, parseInt au booking. */
  applicantUUID?: string | number;
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
  date?: string;       // peut être absent si l'API retourne slotDate à la place
  slotDate?: string;   // champ retourné par getSlotTime (utilisé comme appointmentDt au booking)
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
    ...getBrowserHeaders(),
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
  // Bundle intercepteur : /getLandingPageDeatils reçoit LanguageId:{Ue} en plus des headers standards.
  // Toutes les AUTRES requêtes NE reçoivent PAS LanguageId — c'est une condition explicite dans l'intercepteur.
  const headers = {
    ...sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_DASHBOARD, false),
    "LanguageId": "1",
  };
  try {
    const res = await usaFetch(USA_LANDING_PAGE_URL, { method: "GET", headers });
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
  const url = USA_SANITY_CHECK_URL(session.applicationId, "slotBooking");
  // POST sans corps — le portail envoie Content-Type mais pas de body
  const headers = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_CREATE_APT, true);
  try {
    const res = await usaFetch(url, { method: "POST", headers });
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
  const headers = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_CREATE_APT, false);
  try {
    const res = await usaFetch(url, { method: "GET", headers });
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
  // Bundle Angular : getappointmentByApplicationId(y, w) → ?applicationId=w&applicantId=y
  // y = applicantId interne (selectedSlotDetails.applicantId) ≠ userID de login dans la plupart des cas.
  // On utilise session.applicantId (propagé depuis getUserHistoryApplicantPaymentStatus) si disponible,
  // sinon session.userID comme fallback (le serveur peut l'accepter pour auth ou lookup).
  const applicantIdParam = session.applicantId ?? session.userID;
  const url = USA_APP_DETAILS_URL(applicationId, applicantIdParam);
  try {
    // GET — pas de Content-Type, Referer = page de création de RDV
    const res = await usaFetch(url, {
      headers: sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_CREATE_APT, false),
    });
    if (!res.ok) {
      console.warn(`[usa] getApplicationDetails HTTP ${res.status}`);
      return null;
    }
    // Bundle Angular : la réponse est un TABLEAU d'objets UsaAppDetails.
    // Angular fait : let z = [...Ee] puis filtre sur "NEW" == B.appointmentStatus.
    // selectedSlotDetails = relatedAppList[0] (premier item avec appointmentStatus "NEW").
    // appointmentId et applicantUUID viennent de ce même objet.
    const raw = await res.json();
    const list: UsaAppDetails[] = Array.isArray(raw) ? raw : [raw];
    // Filtrer pour obtenir uniquement les demandes en statut "NEW" (en attente de créneau)
    const newItems = list.filter(item => item.appointmentStatus === "NEW");
    const data = newItems.length > 0 ? newItems[0] : list[0];  // fallback au premier si pas de "NEW"
    if (!data) {
      console.warn(`[usa] getApplicationDetails: réponse vide ou inattendue (longueur=${list.length})`);
      return null;
    }
    console.log(
      `[usa] App details: applicantId=${data.applicantId}, visaType=${data.visaType}, visaClass=${data.visaClass}` +
      `${data.appointmentId !== undefined ? `, appointmentId=${data.appointmentId}` : ""}` +
      `${data.applicantUUID !== undefined ? `, applicantUUID=${data.applicantUUID}` : ""}` +
      ` (param applicantId=${applicantIdParam}, status=${data.appointmentStatus}, total=${list.length})`
    );
    return data;
  } catch (err) {
    console.warn(`[usa] getApplicationDetails erreur: ${err}`);
    return null;
  }
}

/**
 * Récupère la liste des OFCs disponibles pour une mission, filtrée par visa et OFCs autorisés.
 *
 * Bundle Angular (booking flow) :
 *   slotBookingService.getFilteredOfcPostList(De)
 *   → GET /lookupcdt/wizard/getpost?visaClass=...&missionId=...
 *   1. Filtre par officeType === "OFC" (ofcOrPost)
 *   2. Filtre par loggedInApplicantUser.ofc (si non vide)
 *
 * Différent de getOfcListByMissionId (admin) → GET /ofcuser/ofclist/{missionId}
 */
async function getUsaOfcList(
  session: UsaSession,
  missionId: number,
  visaClass?: string,
  visaCategory?: string,
): Promise<UsaOfc[]> {
  const url = USA_OFC_LIST_URL(missionId, visaClass, visaCategory);
  // GET — pas de Content-Type; les cookies applicationId+missionId doivent être présents
  const hdrs = session.applicationId
    ? sessionHeaders(session.accessToken, session.applicationId, missionId, REFERER_CREATE_APT, false)
    : authHeaders(session.accessToken, REFERER_CREATE_APT, false);
  try {
    const res = await usaFetch(url, { headers: hdrs });
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

    // Étape 1 : filtre par officeType — bundle: je.filter(B => B.officeType === this.ofcOrPost)
    let filtered = list.filter(o => o.officeType === "OFC");

    // Étape 2 : filtre par OFCs autorisés (loggedInApplicantUser.ofc)
    // Bundle : S?.length>0 && (ofcList = ofcList.filter(B => S.some(se => se.postUserId===B.postUserId)))
    const allowed = session.allowedOfcs ?? [];
    if (allowed.length > 0) {
      const allowedIds = new Set(allowed.map(o => o.postUserId));
      const before = filtered.length;
      filtered = filtered.filter(o => allowedIds.has(o.postUserId));
      console.log(`[usa] Filtre OFCs autorisés du compte: ${before} → ${filtered.length} OFC(s)`);
    }

    console.log(`[usa] OFCs (mission ${missionId}${visaClass ? `, visaClass=${visaClass}` : ""}): ${filtered.map(o => o.postName).join(", ") || "aucun"}`);
    return filtered;
  } catch (err) {
    // Re-lancer les erreurs circuit-breaker — elles doivent remonter jusqu'à scanUsaSlotsViaAPI.
    // Les avaler ici ferait continuer le scan silencieusement avec une liste vide, sans heartbeat.
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) {
      throw err;
    }
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
  appDetails: UsaAppDetails,
  dateFrom?: string,
  dateDeadline?: string
): Promise<SlotFound | null> {
  const basePayload: Record<string, unknown> = {
    postUserId: ofc.postUserId,
    applicantId: appDetails.applicantId,
    visaType: appDetails.visaType,
    visaClass: appDetails.visaClass,
    locationType: "OFC",
    applicationId: appDetails.applicationId,
  };
  // Bundle Angular : applicationDetails.applicantUUID est inclus dans le payload de booking
  if (appDetails.applicantUUID) basePayload.applicantUUID = appDetails.applicantUUID;

  // Toutes les requêtes de slot incluent les cookies APP_ID_TOBE + missionId (POST avec body)
  const hdrs = sessionHeaders(session.accessToken, appDetails.applicationId, session.missionId, REFERER_CREATE_APT, true);

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
    const res = await usaFetch(USA_FIRST_AVAILABLE_MONTH_URL, {
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

  // Vérification immédiate : si le premier mois disponible dépasse la date limite, inutile de continuer
  if (dateDeadline && firstMonth.date > dateDeadline) {
    console.log(`[usa] ⏭ OFC ${ofc.postName} ignoré — premier mois (${firstMonth.date}) après date limite (${dateDeadline})`);
    return null;
  }

  // 2. Dates disponibles dans ce mois
  const monthStart = new Date(firstMonth.date);
  monthStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  // fromDate = max(demain, début du mois, date minimum admin si définie)
  let fromDate = monthStart > tomorrow ? toYMD(monthStart) : toYMD(tomorrow);
  if (dateFrom && dateFrom > fromDate) {
    console.log(`[usa] 📅 Date minimum admin appliquée : ${dateFrom} (remplace ${fromDate})`);
    fromDate = dateFrom;
  }

  // toDate = fin du mois (plafonné à dateDeadline si définie)
  let toDate = lastDayOfMonth(monthStart);
  if (dateDeadline && dateDeadline < toDate) {
    toDate = dateDeadline;
    console.log(`[usa] 📅 Date limite admin appliquée : toDate → ${toDate}`);
  }

  // Si fromDate dépasse toDate après application des filtres, aucun créneau possible ce mois
  if (fromDate > toDate) {
    console.log(`[usa] Aucune date dans la fenêtre autorisée pour ${ofc.postName} (${fromDate} → ${toDate})`);
    return null;
  }

  let slotDates: UsaSlotDate[];
  try {
    const res = await usaFetch(USA_SLOT_DATES_URL, {
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

  // Filtrer les dates hors fenêtre (dateFrom et dateDeadline)
  if (dateFrom || dateDeadline) {
    const before = slotDates.length;
    slotDates = slotDates.filter(d => {
      if (dateFrom && d.date < dateFrom) return false;
      if (dateDeadline && d.date > dateDeadline) return false;
      return true;
    });
    if (slotDates.length < before) {
      console.log(`[usa] Filtre fenêtre : ${before - slotDates.length} date(s) hors plage ignorée(s)`);
    }
  }

  if (slotDates.length === 0) {
    console.log(`[usa] Aucune date disponible pour ${ofc.postName} dans la fenêtre ${fromDate} → ${toDate}`);
    return null;
  }

  console.log(`[usa] 📆 ${slotDates.length} date(s) avec créneaux pour ${ofc.postName}: ${slotDates.slice(0, 3).map(d => d.date).join(", ")}`);

  // 3. Horaires pour la première date disponible
  const targetDate = slotDates[0].date;
  let timeSlots: UsaTimeSlot[];
  try {
    // Bundle Angular (filterSlots) — payload getSlotTime : 8 champs.
    // Source : Oe = {fromDate, toDate, postUserId, applicantId, slotDate, visaType, visaClass, applicationId}
    //
    // DIFFÉRENCES CLÉS vs getSlotDates :
    //   ✅ getSlotTime inclut "slotDate" (la date précise pour laquelle on veut les horaires)
    //   ✅ getSlotTime inclut fromDate et toDate (même fenêtre que getSlotDates)
    //   ❌ getSlotTime N'inclut PAS "locationType" (uniquement dans getSlotDates)
    //
    // Le champ "locationType" est dans getSlotDates via basePayload.locationType = "OFC".
    // Il n'est PAS envoyé dans getSlotTime — différence subtile mais vérifiable côté serveur.
    const slotTimePayload = {
      fromDate,
      toDate,
      postUserId: basePayload.postUserId,
      applicantId: basePayload.applicantId,
      slotDate: targetDate,
      visaType: basePayload.visaType,
      visaClass: basePayload.visaClass,
      applicationId: basePayload.applicationId,
      // NB : pas de "locationType" ici (uniquement dans getSlotDates/getFirstAvailableMonth)
    };
    const res = await usaFetch(USA_SLOT_TIMES_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(slotTimePayload),
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
// Conversion temps 24h → format UItime Angular (12h AM/PM)
// ─────────────────────────────────────────────────────────────

/**
 * Reproduit exactement setUItime() du bundle Angular (portail US Visa).
 *
 * Angular reçoit startTime en ISO (ex. "2026-05-15T09:00:00.000Z"),
 * extrait la partie temps via datePipe("hh:mm") en 12h ET l'heure 24h brute,
 * puis appelle setUItime(display12h, hour24raw) pour produire le label "9:00 AM".
 *
 * Format de sortie : H:mm AM/PM (sans zéro initial sur l'heure).
 *   "09:00" → "9:00 AM"
 *   "14:00" → "2:00 PM"
 *   "12:00" → "12:00 PM"
 *   "00:00" → "12:00 AM"
 *
 * Ce format est envoyé tel quel dans le payload PUT /appointments/schedule
 * en tant que `appointmentTime`.  Envoyer le format 24h ("14:00") serait incorrect.
 */
function formatUItime(startTime: string): string {
  // Extraire "HH:mm" depuis une ISO ou une string "HH:mm:ss" / "HH:mm"
  let timePart: string;
  if (startTime.includes("T")) {
    timePart = startTime.split("T")[1].slice(0, 5); // "09:00"
  } else {
    timePart = startTime.slice(0, 5);               // "09:00"
  }

  const match = timePart.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) return timePart; // fallback si format inattendu

  const hour24 = parseInt(match[1], 10);
  const minutes = match[2];
  const hour12  = hour24 % 12 || 12;      // 0 → 12, 13 → 1, 12 → 12
  const suffix  = hour24 < 12 ? " AM" : " PM";

  return `${hour12}:${minutes}${suffix}`;  // ex. "9:00 AM", "2:00 PM"
}

// ─────────────────────────────────────────────────────────────
// Types & fonction de booking automatique
// ─────────────────────────────────────────────────────────────

/**
 * Payload exact envoyé par Angular dans PUT /appointments/schedule (OFC individuel).
 * 10 champs — ni plus, ni moins.  Source : bundle Angular, méthode bookSlot() + initBookSlot().
 *
 * Champs du bundle :
 *   se = { appointmentId, applicantUUID, appointmentLocationType, appointmentStatus,
 *           slotId, appointmentDt, appointmentTime }       ← 7 champs base (bookSlot())
 *   + De.postUserId = this.selectedOfc                     ← ajouté par initBookSlot()
 *   + De.applicantId = selectedSlotDetails.applicantId     ← ajouté par initBookSlot()
 *   + De.applicationId = this.applicationId                ← ajouté par initBookSlot()
 *
 * NE PAS inclure : visaType, visaClass, locationType, startTime, endTime, date, time.
 * Ces champs sont dans les payloads getSlotDates/getSlotTime/getFirstAvailableMonth, PAS dans le booking.
 */
interface UsaBookingPayload {
  appointmentId: number | undefined;
  applicantUUID: number | undefined;
  appointmentLocationType: "OFC" | "POST";
  appointmentStatus: "SCHEDULED";
  slotId: number;
  appointmentDt: string;
  appointmentTime: string;
  postUserId: number;
  applicantId: number;
  applicationId: string;
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
  found: { slot: UsaTimeSlot; bookingBase: Record<string, unknown>; date: string; time: string }
): Promise<UsaBookingResult> {
  // ─── Reconstruction du payload PUT /appointments/schedule (10 champs exacts du bundle) ───
  //
  // Le bundle Angular (bookSlot() + initBookSlot()) construit le payload en deux étapes :
  //
  // Étape 1 — bookSlot() : objet `se` avec 7 champs
  //   se = {
  //     appointmentId:          selectedSlotDetails.appointmentId || parseInt(sessionStorage("appointmentId")),
  //     applicantUUID:          selectedSlotDetails.applicantUUID || parseInt(sessionStorage("applicantUUID")),
  //     appointmentLocationType: this.ofcOrPost,             // "OFC"
  //     appointmentStatus:       "SCHEDULED",
  //     slotId:                  this.selectedSlot.slotId,
  //     appointmentDt:           this.selectedSlot.slotDate, // pas "date", pas "startTime"
  //     appointmentTime:         this.selectedSlot.UItime,   // "9:00 AM" (pas "09:00")
  //   }
  //
  // Étape 2 — initBookSlot(se) : 3 champs ajoutés par mutation directe sur se
  //   se.postUserId    = this.selectedOfc              (postUserId du bureau OFC sélectionné)
  //   se.applicantId   = selectedSlotDetails.applicantId
  //   se.applicationId = this.applicationId
  //
  // Total : 10 champs. PAS de visaType, visaClass, locationType, startTime, endTime, date, time.
  // Ces champs sont UNIQUEMENT dans les payloads getSlotDates/getSlotTime, JAMAIS dans le booking.

  const slotRaw = found.slot as Record<string, unknown>;
  const slotDate = slotRaw.slotDate as string | undefined ?? found.date;
  const appointmentTime = formatUItime(found.slot.startTime ?? found.time);

  const payload: UsaBookingPayload = {
    // ── 7 champs de bookSlot() ──
    appointmentId:          session.appointmentId,
    applicantUUID:          session.applicantUUID,
    appointmentLocationType: "OFC",
    appointmentStatus:       "SCHEDULED",
    slotId:                  found.slot.slotId,
    appointmentDt:           slotDate,
    appointmentTime,          // format 12h AM/PM via formatUItime() = setUItime() Angular

    // ── 3 champs ajoutés par initBookSlot() ──
    postUserId:    found.bookingBase.postUserId   as number,
    applicantId:   found.bookingBase.applicantId  as number,
    applicationId: found.bookingBase.applicationId as string,
  };

  console.log(
    `[usa] 📝 Tentative de booking — slotId=${payload.slotId}, appointmentDt=${slotDate}, ` +
    `appointmentTime=${appointmentTime}, appointmentId=${session.appointmentId ?? "N/A"}, ` +
    `OFC postUserId=${payload.postUserId}`
  );

  try {
    // L'intercepteur Angular ajoute sur TOUS les PUT deux mécanismes CSRF :
    //   1. CookieName: XSRF-TOKEN={csrfToken}  (localStorage["CSRFTOKEN"] — custom interceptor Angular)
    //   2. X-XSRF-TOKEN: {csrfToken}           (cookie XSRF-TOKEN → HttpClient built-in Angular)
    // Source : bundle Angular, intercepteur HTTP, clause "PUT"==v.method + HttpClientXsrfModule.
    const bookingHeaders = {
      ...sessionHeaders(session.accessToken, payload.applicationId, session.missionId),
      "CookieName": `XSRF-TOKEN=${session.csrfToken}`,
      "X-XSRF-TOKEN": session.csrfToken,
    };
    const res = await usaFetch(USA_SCHEDULE_URL, {
      method: "PUT",
      headers: bookingHeaders,
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

    // Circuit-breakers : ces erreurs pendant le booking stoppent tout le scan
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      throw new RateLimitError(USA_SCHEDULE_URL, waitMs);
    }
    if (res.status === 403) {
      throw new AccountBlockedError(USA_SCHEDULE_URL);
    }
    if (res.status === 401) {
      throw new TokenExpiredError();
    }

    // 409 = créneau déjà pris par un autre usager (race entre hunters)
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Créneau déjà pris (conflit 409)";
      console.warn(`[usa] ⚠️ Conflit 409 — ${msg}`);
      return { success: false, error: msg, statusCode: 409 };
    }

    // 502 = erreur serveur temporaire
    if (res.status === 502) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Erreur serveur 502";
      console.warn(`[usa] ⚠️ Serveur 502 — ${msg}`);
      return { success: false, error: msg, statusCode: 502 };
    }

    const text = await res.text();
    console.warn(`[usa] ⚠️ Booking échoué HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { success: false, error: `HTTP ${res.status}`, statusCode: res.status };

  } catch (err) {
    // Re-lancer les erreurs circuit-breaker pour qu'elles remontent jusqu'à scanUsaSlotsViaAPI
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] Booking erreur réseau: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Télécharge la lettre de confirmation de RDV au format PDF.
 * POST /visanotificationapi/template/appointmentLetter
 *
 * Séquence Angular :
 *   1. sanityCheck(appId, "appointmentLetter")  → fire-and-forget
 *   2. POST /template/appointmentLetter          → blob PDF
 *   3. createObjectURL(blob) + a.download        → téléchargement navigateur
 *
 * Payload : { applicationId, missionId, appointmentId? }
 * Headers : Accept: application/pdf  +  cookies missionId/APP_ID_TOBE via sessionHeaders.
 * Retourne le contenu PDF en Buffer, ou null en cas d'erreur.
 */
export async function downloadUsaConfirmationPdf(
  session: UsaSession,
  applicationId: string,
  appointmentId?: number | string
): Promise<Buffer | null> {
  console.log(`[usa] Téléchargement confirmation PDF — applicationId=${applicationId}, appointmentId=${appointmentId ?? "n/a"}...`);

  // Étape 1 : sanityCheck avec stepType="appointmentLetter" (fire-and-forget, comme le bundle Angular)
  // Le portail l'appelle juste avant de générer la lettre, sans attendre la réponse.
  if (session.applicationId) {
    const sanityUrl = USA_SANITY_CHECK_URL(session.applicationId, "appointmentLetter");
    const sanityHeaders = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_CREATE_APT, true);
    usaFetch(sanityUrl, { method: "POST", headers: sanityHeaders })
      .then(r => console.log(`[usa] sanityCheck(appointmentLetter) → HTTP ${r.status}`))
      .catch(e => console.warn("[usa] sanityCheck(appointmentLetter) ignoré:", e));
  }

  // Étape 2 : POST appointmentLetter → blob PDF
  // Payload aligné sur le bundle : { applicationId, missionId } + appointmentId si disponible.
  const letterPayload: Record<string, unknown> = {
    applicationId,
    missionId: session.missionId,
  };
  if (appointmentId !== undefined) letterPayload.appointmentId = appointmentId;

  try {
    const res = await usaFetch(USA_CONFIRMATION_LETTER_URL, {
      method: "POST",
      // sessionHeaders inclut les cookies APP_ID_TOBE + missionId.
      // Accept: application/pdf écrase le "application/json" de sessionHeaders.
      headers: {
        ...sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_CREATE_APT),
        "Accept": "application/pdf",
      },
      body: JSON.stringify(letterPayload),
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

  // 1. Récupérer les détails de la demande (applicantId, visaType, visaClass, appointmentId, applicantUUID)
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

  // Propager appointmentId et applicantUUID depuis getApplicationDetails → session.
  // Source bundle : selectedSlotDetails = relatedAppList[0] (filtrée "NEW")
  //   selectedSlotDetails.appointmentId → appointmentId dans bookSlot()
  //   selectedSlotDetails.applicantUUID → applicantUUID dans bookSlot()
  // Ces champs peuvent aussi venir de getUserHistoryApplicantPaymentStatus (propagés plus tôt).
  // On préfère la valeur de getApplicationDetails car c'est ce que le portail Angular utilise en priorité.
  if (appDetails?.appointmentId !== undefined) {
    console.log(`[usa] appointmentId depuis getApplicationDetails : ${appDetails.appointmentId}${session.appointmentId !== undefined ? ` (remplace session.appointmentId=${session.appointmentId})` : ""}`);
    session.appointmentId = appDetails.appointmentId;
  }
  if (appDetails?.applicantUUID !== undefined) {
    const uuidNum = typeof appDetails.applicantUUID === "number"
      ? appDetails.applicantUUID
      : parseInt(String(appDetails.applicantUUID), 10);
    if (!isNaN(uuidNum)) {
      console.log(`[usa] applicantUUID depuis getApplicationDetails : ${uuidNum}${session.applicantUUID !== undefined ? ` (remplace session.applicantUUID=${session.applicantUUID})` : ""}`);
      session.applicantUUID = uuidNum;
    }
  }

  // 2. Récupérer la liste des OFCs pour la mission
  // Bundle : getFilteredOfcPostList({visaClass, missionId, ...}) → /lookupcdt/wizard/getpost
  // visaClass et visaCategory passés comme params query pour pré-filtrer les OFCs par type de visa.
  let ofcList: UsaOfc[];
  try {
    ofcList = await getUsaOfcList(
      session,
      session.missionId,
      effectiveDetails.visaClass,
      effectiveDetails.visaType,
    );
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
      errorMessage: `Aucun OFC disponible pour mission ${session.missionId}`,
    });
    return "not_found";
  }

  // Fenêtre de réservation définie par l'admin (optionnel)
  const slotDateFrom = job.hunterConfig.slotDateFrom;
  const slotDateDeadline = job.hunterConfig.slotDateDeadline;
  if (slotDateFrom || slotDateDeadline) {
    console.log(`[usa] 📅 Fenêtre admin : ${slotDateFrom ?? "illimitée"} → ${slotDateDeadline ?? "illimitée"}`);
  }

  // 3. Scanner chaque OFC à la recherche d'un créneau
  for (const ofc of ofcList) {
    console.log(`[usa] Scan OFC: ${ofc.postName} (postUserId=${ofc.postUserId})`);
    // Délai humain entre OFCs — un vrai utilisateur prend 1.5-4s pour passer d'un bureau à l'autre
    await randomDelay(1500, 4000);

    let found: SlotFound | null;
    try {
      found = await findFirstSlotForOfc(session, ofc, effectiveDetails, slotDateFrom, slotDateDeadline);
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
      // Le booking et le téléchargement du PDF sont dans un try/catch séparé :
      // les erreurs circuit-breaker (RateLimit, Blocked, TokenExpired) doivent
      // stopper le scan et déclencher un heartbeat d'alerte, pas crasher silencieusement.
      let booking: UsaBookingResult;
      try {
        // ── 1. Booking automatique ────────────────────────────
        booking = await bookUsaSlot(session, found);
      } catch (bookErr) {
        if (bookErr instanceof RateLimitError) {
          const waitSec = Math.round((bookErr.retryAfterMs ?? 60000) / 1000);
          console.error(`[usa] ⛔ RATE LIMIT lors du booking — scan interrompu (retry: ${waitSec}s)`);
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Rate limit (429) lors du booking — ${bookErr.message}. Reprendre dans ~${waitSec}s.`,
          });
          return "error";
        }
        if (bookErr instanceof AccountBlockedError) {
          console.error(`[usa] ⛔ COMPTE BLOQUÉ lors du booking — ${bookErr.message}`);
          const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
          if (cacheKey) tokenCache.delete(cacheKey);
          await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Compte bloqué (403) lors du booking` });
          return "error";
        }
        if (bookErr instanceof TokenExpiredError) {
          console.error(`[usa] ⛔ TOKEN EXPIRÉ lors du booking — reconnexion au prochain cycle`);
          const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
          if (cacheKey) tokenCache.delete(cacheKey);
          await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Token JWT expiré lors du booking` });
          return "error";
        }
        // Erreur réseau inattendue — traiter comme booking échoué et continuer
        const msg = bookErr instanceof Error ? bookErr.message : String(bookErr);
        console.error(`[usa] Erreur inattendue lors du booking: ${msg}`);
        booking = { success: false, error: msg };
      }

      await randomDelay(1000, 2000);

      // 409 = créneau pris en concurrence AVANT notre booking.
      // Ne pas signaler le slot comme trouvé (on ne l'a pas obtenu) — scanner le prochain OFC.
      if (!booking.success && booking.statusCode === 409) {
        console.log("[usa] Conflit 409 — le créneau a été pris avant nous. Poursuite du scan...");
        continue;
      }

      // ── 2. Télécharger le PDF de confirmation ───────────────
      // Uniquement si le booking a réussi : le portail ne génère la lettre que sur un RDV confirmé.
      let pdfStorageId: string | undefined;
      if (booking.success) {
        const pdf = await downloadUsaConfirmationPdf(session, session.applicationId, booking.appointmentId);
        if (pdf) {
          console.log(`[usa] 📄 Confirmation PDF (${pdf.length} bytes) — upload vers Convex...`);
          const b64 = pdf.toString("base64");
          pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
          if (pdfStorageId) {
            console.log(`[usa] ✅ PDF uploadé → storageId: ${pdfStorageId}`);
          }
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

      return "slot_found";
    }
  }

  console.log(`[usa] Aucun créneau disponible sur ${ofcList.length} OFC(s)`);
  await sendHeartbeat({ applicationId: job.id, result: "not_found" });
  return "not_found";
}
