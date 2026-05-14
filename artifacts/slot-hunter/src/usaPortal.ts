import { createCipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { ProxyAgent } from "undici";
import { Impit } from "impit";
import { randomDelay, proxyPool, launchBrowser } from "./browser.js";
import { reportSlotFound, sendHeartbeat, uploadFile, botLog, reportSlotDiscovery, reportSlotDiscoveryBatch, type SlotDiscoveryEvent, type HunterJob } from "./convexClient.js";
import { 
  humanLikeDelay, 
  humanPause, 
  getVariableBrowserHeaders, 
  shouldSimulateNetworkError, 
  simulateNetworkTimeout,
  shuffleArray,
  randomSubset,
  simulateMenuClick,
  simulatePageRefresh,
  estimateExecutionTime,
  printExecutionTimeReport,
  logHumanBehaviorStart,
  logHumanBehaviorEnd
} from "./humanBehavior.js";

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
const USA_INTEGRATION_URL = `${USA_BASE}/visaintegrationapi`;
// sanity check : migré de visaintegrationapi vers visaapplicantapi/v1 (mai 2026)
const USA_APPLICANT_API_URL = `${USA_BASE}/visaapplicantapi/v1`;

// Bundle Angular (booking flow) : slotBookingService.getFilteredOfcPostList(De)
//   → GET visaAdminUrl + "/lookupcdt/wizard/getpost" avec params :
//     { visaCategory?, visaClass?, stateCode?, priority?, missionId }
// Différent de getOfcListByMissionId (admin only) → GET /ofcuser/ofclist/{missionId}
const USA_OFC_LIST_URL = (
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

// Bundle Angular : renderService.getTransformData(applicationId, applicantId)
//   → GET visaWorkFlowURL + "/workflow/getTransformData/${applicationId}"
// Note : applicantId est dans la signature JS mais N'EST PAS dans l'URL (confirmé dans le bundle).
// Retourne un tableau dont [0].transformData est un JSON stringifié contenant :
//   stateCode, appointmentPriority, visaClass, paymentStatus, etc.
const USA_TRANSFORM_DATA_URL = (applicationId: string) =>
  `${USA_WORKFLOW_URL}/workflow/getTransformData/${applicationId}`;
const USA_FIRST_AVAILABLE_MONTH_URL = `${USA_ADMIN_URL}/modifyslot/getFirstAvailableMonth`;
const USA_SLOT_DATES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotDates`;
const USA_SLOT_TIMES_URL = `${USA_ADMIN_URL}/modifyslot/getSlotTime`;
const USA_APP_DETAILS_URL = (applicationId: string, applicantId: number | string) =>
  `${USA_APPOINTMENT_URL}/appointments/getApplicationDetails?applicationId=${applicationId}&applicantId=${applicantId}`;
const USA_CONFIRMATION_LETTER_URL = `${USA_NOTIFICATION_URL}/template/appointmentLetter`;
const USA_SCHEDULE_URL = `${USA_APPOINTMENT_URL}/appointments/schedule`;
// Reschedule : PUT au lieu de schedule — payload identique + rescheduleType (bundle Angular)
const USA_RESCHEDULE_URL = `${USA_APPOINTMENT_URL}/appointments/reschedule`;
// Recherche de détails RDV par applicationId (POST, retourne tableau avec appointmentId/UUID)
const USA_SEARCH_URL = `${USA_APPOINTMENT_URL}/appointments/search`;
// Dashboard : retourne les RDV planifiés (Bearer seulement, pas d'applicationId requis)
const USA_SCHEDULED_INFO_URL = `${USA_APPOINTMENT_URL}/appointments/scheduledappointmentInfo`;
// showRescheduleButton : retourne applicationId + appointmentId du RDV reschedule-able
// Découvert via capture Playwright — c'est l'endpoint CORRECT pour identifier le dossier à reschedule.
// Retourne : [{applicationId, appointmentId, showRescheduleButton: true, rescheduleLimit, showCancelButton}]
const USA_SHOW_RESCHEDULE_BUTTON_URL = `${USA_APPOINTMENT_URL}/appointments/showRescheduleButton`;
// Anti-détection : endpoints que le vrai portail appelle dans son flux normal
const USA_LANDING_PAGE_URL = `${USA_APPOINTMENT_URL}/appointments/getLandingPageDeatils`;
// Retourne l'URL de base du sanity check — le stepType est ajouté en query param par l'appelant.
// Bundle Angular (maj mai 2026) : endpoint migré de visaintegrationapi vers visaapplicantapi/v1
// Capture réelle : POST /visaapplicantapi/v1/visa/sanitycheck/{appId}?stepType=slotBooking → 200
const USA_SANITY_CHECK_URL = (applicationId: string, stepType: "slotBooking" | "appointmentLetter") =>
  `${USA_APPLICANT_API_URL}/visa/sanitycheck/${applicationId}?stepType=${stepType}`;
const USA_FCS_CHECK_URL = (applicationId: string) =>
  `${USA_PAYMENT_URL}/feecollection/checkFcs/${applicationId}`;

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Durée maximale d'une session en cache avant invalidation automatique.
// Même si le JWT est techniquement valide 55 min, le portail détecte les sessions
// inactives après ~15 min. On invalide à 10 min pour éviter de réutiliser un token
// après un logout raté ou un crash (cf. analyse de la contradiction JWT 55 min vs session réelle).
const MAX_SESSION_AGE_MS = 10 * 60 * 1000;

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

/**
 * Levée quand le portail renvoie 401 avec "temporarily restricted" — compte temporairement bloqué.
 * DIFFÉRENT de TokenExpiredError : le token est encore valide mais le compte est en cooldown.
 * Action : NE PAS supprimer le cache, NE PAS se reconnecter — attendre la fin de la restriction.
 * La restriction dure typiquement 15-30 min côté portail.
 */
class AccountRestrictedError extends Error {
  constructor(
    public readonly retryAfterMs?: number,
    public readonly retryAfterHeader?: string
  ) {
    const durationMs = retryAfterMs ?? 60 * 60 * 1000;
    super(`Compte temporairement restreint par le portail — attendre ${Math.round(durationMs / 60000)} min`);
    this.name = "AccountRestrictedError";
  }
}

// ─── Restriction account-level : map username → timestamp fin de restriction ──
// Quand "Access temporarily restricted" est détecté, on enregistre la fin de la
// fenêtre avec backoff exponentiel. Tous les appels au compte sont bloqués jusqu'à
// ce timestamp, SANS toucher au cache de token (le JWT reste valide).
const accountRestrictedUntil = new Map<string, number>();
const accountRestrictionAttempts = new Map<string, number>();

/** Vrai si le compte est actuellement en cooldown côté portail. */
export function isAccountRestricted(username: string): boolean {
  const until = accountRestrictedUntil.get(username.toLowerCase());
  return until !== undefined && Date.now() < until;
}

/** Obtient le nombre de tentatives de restriction pour un compte. */
function getRestrictionAttemptCount(username: string): number {
  return accountRestrictionAttempts.get(username.toLowerCase()) || 0;
}

/** Incrémente le compteur de tentatives de restriction. */
function incrementRestrictionAttempt(username: string): void {
  const key = username.toLowerCase();
  const current = getRestrictionAttemptCount(username);
  accountRestrictionAttempts.set(key, current + 1);
}

/** Réinitialise le compteur de tentatives après une période de succès. */
function resetRestrictionAttempts(username: string): void {
  accountRestrictionAttempts.delete(username.toLowerCase());
}

/** Calcule la durée de restriction avec backoff exponentiel. */
function calculateRestrictionDuration(attemptCount: number, retryAfterHeader?: string): number {
  // Priorité 1 : Header Retry-After du serveur (si présent)
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000; // Convertir en millisecondes
    }
  }
  
  // Priorité 2 : Backoff exponentiel basé sur le nombre de tentatives
  const baseDuration = 60 * 60 * 1000; // 1 heure de base
  const maxDuration = 24 * 60 * 60 * 1000; // Maximum 24 heures
  
  if (attemptCount <= 0) {
    return baseDuration; // Première restriction : 1 heure
  }
  
  // Backoff exponentiel : 1h, 2h, 4h, 8h, 16h, 24h (max)
  const exponentialDuration = baseDuration * Math.pow(2, attemptCount - 1);
  return Math.min(exponentialDuration, maxDuration);
}

/** Marque un compte comme restreint avec backoff exponentiel. */
function markAccountRestricted(username: string, durationMs?: number, retryAfterHeader?: string): void {
  const key = username.toLowerCase();
  
  // Incrémenter le compteur de tentatives
  incrementRestrictionAttempt(username);
  const attemptCount = getRestrictionAttemptCount(username);
  
  // Calculer la durée (avec backoff exponentiel si non spécifiée)
  const calculatedDuration = durationMs ?? calculateRestrictionDuration(attemptCount, retryAfterHeader);
  
  const until = Date.now() + calculatedDuration;
  accountRestrictedUntil.set(key, until);
  
  const endTime = new Date(until).toISOString().slice(11, 16);
  const durationMinutes = Math.round(calculatedDuration / 60000);
  const attemptInfo = attemptCount > 1 ? ` (tentative ${attemptCount}, backoff exponentiel)` : '';
  
  console.warn(`[usa] 🔒 Compte ${username} marqué "restreint" jusqu'à ${endTime} UTC (~${durationMinutes} min${attemptInfo})`);
  
  // Si la restriction est levée (après expiration), réinitialiser le compteur
  setTimeout(() => {
    if (!isAccountRestricted(username)) {
      resetRestrictionAttempts(username);
      console.log(`[usa] ✅ Compte ${username} : restriction expirée, compteur réinitialisé`);
    }
  }, calculatedDuration + 1000); // +1s pour être sûr
}

/** Teste si un corps de réponse 401 indique une restriction temporaire vs un token expiré. */
function isRestrictedBody(body: string): boolean {
  const lower = body.toLowerCase();
  
  // Patterns améliorés avec regex pour plus de robustesse
  const patterns = [
    /temporarily/i,
    /restricted/i,
    /access denied/i,
    /account (is |has been )?locked/i,
    /too many/i,
    /rate limit/i,
    /suspended/i,
    /try again later/i,
    /cooldown/i,
    /wait.*minutes/i,
    /please wait/i,
    /temporary block/i,
    /security measure/i,
    /excessive attempts/i,
    /multiple failed/i
  ];
  
  return patterns.some(pattern => pattern.test(lower));
}

// ─── Nouvelles fonctions anti-détection ──────────────────────────────────────

/**
 * Pause aléatoire entre les étapes pour simuler le comportement humain
 */
async function randomInterStepPause(minMs: number = 500, maxMs: number = 3000, jobId?: string): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  if (delay > 1000) {
    console.log(`[human] Pause inter-étape: ${Math.round(delay / 1000)}s`);
    // Log les pauses significatives
    if (jobId && delay > 2000) {
      botLog({
        applicationId: jobId,
        step: "human_behavior",
        status: "ok",
        data: {
          type: "inter_step_pause",
          durationMs: delay,
          minMs,
          maxMs
        }
      });
    }
  }
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Définit différents flows possibles pour varier la séquence des requêtes
 */
type FlowStep = "login" | "status" | "ofc" | "dates" | "times" | "warmup" | "noise" | "transform";
const POSSIBLE_FLOWS: FlowStep[][] = [
  ["login", "status", "ofc", "dates", "times"],
  ["login", "status", "dates", "ofc", "times"],
  ["login", "ofc", "status", "dates", "times"],
  ["login", "dates", "status", "ofc", "times"],
  ["login", "warmup", "status", "ofc", "dates", "times"],
  ["login", "status", "warmup", "ofc", "dates", "times"]
];

/**
 * Sélectionne un flow aléatoire pour cette session
 */
function selectRandomFlow(): FlowStep[] {
  const flow = POSSIBLE_FLOWS[Math.floor(Math.random() * POSSIBLE_FLOWS.length)];
  console.log(`[anti-detection] Flow sélectionné: ${flow.join(" → ")}`);
  return flow;
}

/**
 * Envoie des requêtes "bruit" occasionnelles pour simuler la navigation humaine
 */
async function sendAntiDetectionNoise(
  session: UsaSession, 
  jobId?: string
): Promise<void> {
  if (Math.random() < 0.15) { // 15% du temps
    const noiseEndpoints = [
      `${USA_BASE}/api/help`,
      `${USA_BASE}/api/faq`,
      `${USA_BASE}/api/contact`,
      `${USA_BASE}/api/privacy`,
      `${USA_BASE}/visaapplicantui/home/dashboard/help`,
      `${USA_BASE}/visaapplicantui/home/dashboard/faq`
    ];
    
    const endpoint = noiseEndpoints[Math.floor(Math.random() * noiseEndpoints.length)];
    try {
      console.log(`[anti-detection] 📡 Requête bruit vers: ${endpoint}`);
      await usaFetch(endpoint, {
        method: "GET",
        headers: authHeaders(session.accessToken, REFERER_DASHBOARD, false)
      });
      
      // Log la requête bruit
      if (jobId) {
        botLog({
          applicationId: jobId,
          step: "anti_detection",
          status: "ok",
          data: {
            type: "noise_request",
            endpoint: endpoint,
            timestamp: Date.now()
          }
        });
      }
    } catch (error) {
      // Ignorer les erreurs (comportement humain - les requêtes peuvent échouer)
      console.log(`[anti-detection] Requête bruit échouée (comportement normal): ${error}`);
    }
  }
}

/**
 * Système de réputation de proxy pour éviter les IPs à risque
 */
interface ProxyReputation {
  proxyUrl: string;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  banScore: number; // 0-100, plus haut = plus risqué
}

const proxyReputations = new Map<string, ProxyReputation>();

/**
 * Met à jour la réputation d'un proxy après une requête
 */
function updateProxyReputation(proxyUrl: string, success: boolean): void {
  const existing = proxyReputations.get(proxyUrl) || {
    proxyUrl,
    successCount: 0,
    failureCount: 0,
    lastUsed: Date.now(),
    banScore: 0
  };
  
  if (success) {
    existing.successCount++;
    // Réduire le banScore après des succès consécutifs
    existing.banScore = Math.max(0, existing.banScore - 5);
  } else {
    existing.failureCount++;
    // Augmenter le banScore après des échecs
    existing.banScore = Math.min(100, existing.banScore + 20);
  }
  
  existing.lastUsed = Date.now();
  proxyReputations.set(proxyUrl, existing);
  
  // Nettoyer les vieilles entrées (plus de 24h)
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [url, rep] of proxyReputations.entries()) {
    if (rep.lastUsed < twentyFourHoursAgo) {
      proxyReputations.delete(url);
    }
  }
}

/**
 * Choisit le meilleur proxy disponible basé sur la réputation
 */
function selectBestProxy(availableProxies: string[]): string | undefined {
  if (availableProxies.length === 0) return undefined;
  
  const reputations = availableProxies
    .map(url => proxyReputations.get(url) || {
      proxyUrl: url,
      successCount: 0,
      failureCount: 0,
      lastUsed: 0,
      banScore: 0
    })
    .filter(rep => rep.banScore < 50); // Éviter les proxies à haut risque
  
  if (reputations.length === 0) {
    // Tous les proxies ont un score élevé, prendre le moins pire
    return availableProxies[0];
  }
  
  // Priorité: faible banScore, puis succès élevés, puis récent
  const best = reputations.sort((a, b) => {
    if (a.banScore !== b.banScore) return a.banScore - b.banScore;
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    return b.lastUsed - a.lastUsed;
  })[0];
  
  return best.proxyUrl;
}

// ─── Warm-up throttle : éviter d'appeler landingPage+sanityCheck+checkFcs à chaque cycle ──
// Ces 3 appels "anti-détection" font +3 requêtes par cycle. En tier tres_urgent (3-5 min),
// c'est 36-60 appels supplémentaires par heure juste pour le warm-up.
// Solution : warm-up max 1 fois toutes les WARMUP_INTERVAL_MS (8 min).
const WARMUP_INTERVAL_MS = 8 * 60 * 1000;
const warmupLastCalledAt = new Map<string, number>(); // key = applicationId

/** Vrai si le warm-up doit être effectué (première fois ou > WARMUP_INTERVAL_MS depuis le dernier). */
function shouldDoWarmup(applicationId: string): boolean {
  const last = warmupLastCalledAt.get(applicationId);
  return last === undefined || Date.now() - last > WARMUP_INTERVAL_MS;
}

/**
 * Exécute des étapes avec variabilité humaine (ordre aléatoire, pauses)
 */
async function executeWithHumanVariability(
  steps: Array<{ name: string; execute: () => Promise<void>; critical?: boolean }>,
  context: string = "",
  jobId?: string
): Promise<void> {
  // Séparer les étapes critiques et non-critiques
  const criticalSteps = steps.filter(step => step.critical);
  const nonCriticalSteps = steps.filter(step => !step.critical);
  
  // Exécuter les étapes critiques dans l'ordre
  for (const step of criticalSteps) {
    console.log(`[human] ${context}Étape critique: ${step.name}`);
    await step.execute();
    await humanPause(300, `après ${step.name} `, jobId);
  }
  
  // Mélanger et exécuter les étapes non-critiques
  const shuffledSteps = shuffleArray(nonCriticalSteps);
  const stepsToExecute = randomSubset(shuffledSteps, 1, shuffledSteps.length);
  
  for (const step of stepsToExecute) {
    console.log(`[human] ${context}Étape aléatoire: ${step.name}`);
    await step.execute();
    await humanPause(500, `après ${step.name} `, jobId);
  }
  
  // 30% du temps : simuler un clic de menu supplémentaire
  if (Math.random() < 0.3) {
    await simulateMenuClick({}, jobId);
    await humanPause(200, "après clic menu ", jobId);
  }
  
  // 10% du temps : simuler un rafraîchissement
  if (Math.random() < 0.1) {
    await simulatePageRefresh(jobId);
  }
}

// ─── OFC round-robin : scanner 1 seule OFC par cycle (rotation) ─────────────
// Avec N OFCs et tier tres_urgent (3-5 min), scanner toutes les OFCs à chaque cycle =
// N×3 appels supplémentaires par cycle. Avec 3 OFCs → 9 appels → 108-180/heure.
// Solution : scanner 1 OFC par cycle en rotation. Chaque OFC est vérifiée toutes les N×(3-5) min.
// Acceptable car les créneaux n'apparaissent pas à la seconde — 10-15 min de latence est OK.
const ofcCursor = new Map<string, number>(); // key = applicationId, value = index OFC courant

// Clé AES du portail USA — extraite du bundle Angular public (visaapplicantui/main.js)
// nosemgrep: generic-api-key — clé publique, visible dans le JS client du portail
// Déclarée en `let` pour permettre la mise à jour automatique si le bundle Angular change.
export let USA_ENC_SEC_KEY = "OuoCdl8xQh/OX6LbmgLEtZxZrvnOmrubsMhPW1VPRjk=";

/**
 * Met à jour la clé AES en mémoire sans redémarrer le processus.
 * Appelé automatiquement par checkPortalBundleKey() quand le bundle change.
 * Tous les prochains appels à encryptPortalCredentials() utiliseront la nouvelle clé.
 */
export function updateAesKey(newKey: string): void {
  USA_ENC_SEC_KEY = newKey;
}

/**
 * Chiffre les credentials en AES-256-CBC avec PBKDF2 (SHA1, 1000 itérations),
 * identique à cryptoService.encrypt() du portail Angular.
 * Format de sortie : salt_hex(32) + iv_hex(32) + base64(ciphertext)
 */
export function encryptPortalCredentials(username: string, password: string): string {
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
  /** Timestamp (Date.now()) du moment où le token a été créé/rafraîchi.
   * Utilisé pour invalider le cache après MAX_SESSION_AGE_MS même si le JWT est
   * techniquement encore valide — protection contre les logouts ratés. */
  sessionStartedAt: number;
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
  const now = Date.now();

  // Protection contre les logouts ratés : si la session a été créée il y a plus de
  // MAX_SESSION_AGE_MS (10 min), on invalide le cache indépendamment de l'exp JWT.
  // Le portail détecte les sessions inactives après ~15 min — on coupe avant.
  const sessionAge = now - cached.sessionStartedAt;
  if (sessionAge >= MAX_SESSION_AGE_MS) {
    return false;
  }

  return now < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS - cached.jitterMs;
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
      // Réinitialiser le timestamp de session au moment du refresh — le nouveau token
      // démarre une nouvelle fenêtre de MAX_SESSION_AGE_MS.
      sessionStartedAt: Date.now(),
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
  messagetext: string | null;
  /** Champ "cancellable" retourné par getUserHistoryApplicantPaymentStatus.
   * Quand pendingAppoStatus=0 ET cancellable=true, le portail Angular affiche
   * le bouton "Reschedule" — signifie qu'un RDV terminé existe et peut être reporté.
   * La réponse peut ne contenir QUE {pendingAppoStatus:0, cancellable:true} sans applicationId.
   * Dans ce cas, il faut résoudre l'applicationId via showRescheduleButton / scheduledappointmentInfo. */
  cancellable?: boolean;
  /** applicantId interne (si retourné par getUserHistoryApplicantPaymentStatus).
   * Correspond à selectedSlotDetails.applicantId dans le bundle Angular.
   * Peut être un number OU une string GSS (ex: "ODXJKHXJQMZH").
   * À utiliser de préférence à userID comme param applicantId de getApplicationDetails. */
  applicantId?: number | string;
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
   * Peut être un number OU une string GSS (ex: "ODXJKHXJQMZH") selon la mission.
   * Utilisé comme param ?applicantId= dans getApplicationDetails à la place du userID
   * si le serveur le retourne — sinon on retombe sur userID comme fallback. */
  applicantId?: number | string;
  /** appointmentId interne du dossier en attente de créneau.
   * Bundle Angular : this.selectedSlotDetails.appointmentId
   * Inclus obligatoirement dans le payload PUT /appointments/schedule. */
  appointmentId?: number;
  /** applicantUUID interne — requis dans le payload de booking.
   * Bundle Angular : this.selectedSlotDetails.applicantUUID */
  applicantUUID?: number;
  /** appointmentUUID — identifiant unique du RDV (format UUID string).
   * Capturé depuis /appointments/search ou /scheduledappointmentInfo.
   * Utilisé dans le Referer dynamique du mode reschedule et dans le filtre /search.
   * Capture réseau : "0cbcba2c-a420-4d74-b99a-d7431aaa6897" */
  appointmentUUID?: string;
  /** OFCs autorisés pour ce compte — propagé depuis la réponse de login (data.ofc).
   * Bundle : S = JSON.parse(loggedInApplicantUser).ofc
   * Si non vide, seuls les OFCs dont postUserId figure dans cette liste sont scannés.
   * Vide ou absent = aucune restriction (compte sans filtre OFC). */
  allowedOfcs?: Array<{ postUserId: number }>;
  /** Code géographique du dossier — extrait de transformData[0].stateCode après getTransformData.
   * Bundle : this.stateCode = this.applicantData[0].stepTransformData.stateCode
   * Ajouté comme param ?stateCode= dans l'URL OFC list. Ex: "Kinshasa". */
  stateCode?: string;
  /** Priorité du dossier — extrait de transformData[0].appointmentPriority après getTransformData.
   * Bundle : this.appointmentPriority = this.applicantData[0].stepTransformData.appointmentPriority
   * Ajouté comme param ?priority= dans l'URL OFC list.
   * Valeurs possibles : "regular", "group", ou vide (absent = non transmis).
   * Si "group" + reschedule → converti en "regular" (bundle : rescheduleYN&&"group"==ap→"regular"). */
  appointmentPriority?: string;
  /** Drapeau positionné à true quand un RDV existant doit être reporté.
   * Indique que le booking doit utiliser PUT /appointments/reschedule au lieu de /schedule. */
  isReschedule?: boolean;
}

// Referers spécifiques à chaque étape de navigation du portail Angular.
// Chaque appel API reçoit le referer de la page qui l'a déclenché (comme un vrai navigateur).
const REFERER_LOGIN      = "https://www.usvisaappt.com/visaapplicantui/login";
const REFERER_DASHBOARD  = "https://www.usvisaappt.com/visaapplicantui/home/dashboard";
const REFERER_REQUESTS   = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests";
const REFERER_CREATE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/create-appointment";
const REFERER_MANAGE_APT = "https://www.usvisaappt.com/visaapplicantui/home/dashboard/manage-appointment";

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

/** Génère un ID de corrélation de 15 caractères aléatoires comme le bundle Angular. */
function generateCorrelationId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 15; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getBrowserHeaders(jobId?: string): Record<string, string> {
  const baseHeaders = {
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
    // Bundle Angular : X-Correlation-key présent sur toutes les requêtes authentifiées
    "X-Correlation-key":  generateCorrelationId(),
  };
  
  // Ajouter de la variabilité humaine aux headers
  return getVariableBrowserHeaders(baseHeaders, jobId);
}

// ─── Proxy résidentiel pour les appels API USA ────────────────────────────────
// Utilise undici ProxyAgent pour router les requêtes via un proxy résidentiel.
// setUsaSessionProxy() est appelé au début de runUsaApiSession() et réinitialisé à la fin.
let _usaProxyAgent: ProxyAgent | undefined;
let _usaProxyUrl: string | undefined;

/**
 * Génère une URL iProyal avec session sticky.
 * iProyal : les paramètres _session-{id}_lifetime-{durée} sont ajoutés AU MOT DE PASSE.
 * Format : user:password_session-{8chars}_lifetime-{60m}@host:port
 * Cela force le routeur iProyal à maintenir la même IP de sortie pendant toute la durée de la session.
 * Ref: https://docs.iproyal.com/proxies/residential/proxy/rotation
 */
export function makeIproyalStickyUrl(baseUrl: string, lifetimeMinutes: number = 60): string {
  try {
    const parsed = new URL(baseUrl);
    // Générer un session ID aléatoire de 8 caractères alphanumériques
    const sessionId = Array.from({ length: 8 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]
    ).join("");
    // Ajouter les paramètres sticky au mot de passe (après le password existant)
    // Si le password contient déjà _session-, on le remplace pour éviter les doublons
    let password = decodeURIComponent(parsed.password);
    password = password.replace(/_session-[^_]+/g, "").replace(/_lifetime-[^_]+/g, "");
    password += `_session-${sessionId}_lifetime-${lifetimeMinutes}m`;
    parsed.password = encodeURIComponent(password);
    console.log(`[usa] 🔒 Proxy sticky activé: session=${sessionId}, lifetime=${lifetimeMinutes}m`);
    return parsed.toString();
  } catch {
    // Si le parsing d'URL échoue, retourner l'URL d'origine (non-sticky)
    console.warn(`[usa] ⚠️ Impossible de parser l'URL proxy pour sticky session — fallback rotatif`);
    return baseUrl;
  }
}

export function setUsaSessionProxy(proxyUrl: string | undefined): void {
  if (proxyUrl) {
    _usaProxyUrl = proxyUrl;
    _usaProxyAgent = new ProxyAgent(proxyUrl);
    const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
    console.log(`[usa] Proxy résidentiel actif (undici): ${masked}`);
  } else {
    _usaProxyUrl = undefined;
    _usaProxyAgent = undefined;
  }
}

/**
 * Fetch avec fingerprint TLS Chrome via impit (anti-détection JA3/JA4).
 * 
 * impit génère un handshake TLS identique à un vrai Chrome, rendant le bot
 * indistinguable d'un navigateur réel au niveau réseau (ciphers, ALPN, extensions TLS).
 * 
 * IMPORTANT : on NE laisse PAS impit gérer les headers HTTP — on les envoie nous-mêmes
 * via getBrowserHeaders() pour garder le contrôle exact sur Sec-CH-UA, Referer, cookies, etc.
 * impit est utilisé UNIQUEMENT pour le fingerprint TLS sous-jacent.
 * 
 * Mode sans proxy : connexion directe via IP Railway (fixe et stable).
 * Le serveur USA lie le JWT à l'IP — pas de changement mid-session.
 */

// Instance impit singleton — réutilisée pour toutes les requêtes USA.
// browser:"chrome" = fingerprint TLS du dernier Chrome supporté par impit.
// redirect:"follow" = suit les redirections comme un vrai navigateur.
let _impitInstance: InstanceType<typeof Impit> | undefined;

function getImpitInstance(): InstanceType<typeof Impit> {
  if (!_impitInstance) {
    _impitInstance = new Impit({
      browser: "chrome",
    });
    console.log("[usa] ✅ impit initialisé (fingerprint TLS Chrome) — indétectable JA3/JA4");
  }
  return _impitInstance;
}

async function usaFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (_usaProxyAgent) {
    // Si un proxy est configuré (cas futur), utiliser le fetch natif avec ProxyAgent.
    // impit ne supporte pas directement undici ProxyAgent.
    // @ts-expect-error — dispatcher est une option interne undici non présente dans RequestInit standard
    return fetch(url, { ...options, dispatcher: _usaProxyAgent });
  }
  // Mode normal (sans proxy) : utiliser impit pour le fingerprint TLS Chrome.
  // Les headers sont passés tels quels — impit ne les modifie PAS quand on les fournit.
  const impit = getImpitInstance();
  return impit.fetch(url, options as Parameters<typeof impit.fetch>[1]) as unknown as Response;
}


export async function getUsaSession(
  username: string,
  password: string,
  _captchaApiKey?: string  // Conservé pour compatibilité — le portail USA ne requiert pas de CAPTCHA via API
): Promise<UsaSession | null> {
  const cacheKey = username.toLowerCase();

  // ── Guard restriction compte ────────────────────────────────────────────────
  // Si le portail a renvoyé "temporarily restricted" lors d'un appel précédent,
  // NE PAS tenter de login — cela prolongerait la restriction.
  // Retourner null signale à runUsaApiSession de skipper ce cycle.
  if (isAccountRestricted(username)) {
    const until = accountRestrictedUntil.get(cacheKey)!;
    const remainMin = Math.round((until - Date.now()) / 60000);
    console.warn(`[usa] 🔒 ${username} en restriction compte — ${remainMin} min restantes. Cycle ignoré.`);
    return null;
  }

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
      // AccountRestrictedError : le portail a refusé le login avec "temporarily restricted".
      // Enregistrer la restriction et retourner null — PAS d'exception qui casserait l'auto-pause.
      if (err instanceof AccountRestrictedError) {
        markAccountRestricted(username, err.retryAfterMs, err.retryAfterHeader);
        pendingLogin.delete(cacheKey);
        return null;
      }
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
      sessionStartedAt: Date.now(),
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

  // Bundle Angular : loginUser() vide sessionStorage avant login
  // Notre bot utilise une Map en mémoire (comportement équivalent)
  console.log(`[usa] Simulating sessionStorage.clear() before login (bundle behavior)`);

  let response: Response;
  try {
    // Bundle Angular : loginUser() envoie ses headers normaux
    const loginHeaders = {
      ...getBrowserHeaders(),
      "Content-Type": "application/json",
      "Referer": REFERER_LOGIN,
    };
    
    response = await usaFetch(USA_LOGIN_URL, {
      method: "POST",
      // Content-Type obligatoire : body JSON. Referer = page de login (le formulaire poste vers lui-même).
      // authHeaders() ne convient pas ici car on n'a pas encore de token.
      headers: loginHeaders,
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
    // 401 avec corps "temporarily restricted" = compte en cooldown côté portail.
    // NE PAS traiter comme une erreur de credentials — lever AccountRestrictedError
    // pour que getUsaSession puisse enregistrer la fenêtre de restriction sans loop.
    if (response.status === 401 && isRestrictedBody(rawBody + detail)) {
      const retryAfter = response.headers.get("Retry-After");
      throw new AccountRestrictedError(
        retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
        retryAfter ?? undefined
      );
    }
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  if (!data) {
    console.error("[usa] Réponse login invalide (JSON parse échoué)");
    throw new Error("Réponse non-JSON du portail USA");
  }

  const accessToken = response.headers.get("authorization");
  const refreshToken = response.headers.get("refreshtoken");

  // ── Extraction csrfToken robuste ───────────────────────────────────────────
  // Le bundle Angular lit : F.headers.get("Csrftoken") (header de réponse custom).
  // Problème observé : les proxies résidentiels (iProyal) filtrent parfois les headers
  // non-standard de la réponse HTTP. On cherche dans plusieurs sources :
  //   1. Header "Csrftoken" (case-insensitive via l'API Headers)
  //   2. Header "x-csrf-token" (variante normalisée parfois utilisée par des reverse-proxies)
  //   3. Header "set-cookie" contenant "XSRF-TOKEN=" (le serveur peut poser un cookie CSRF)
  //   4. Champ "csrfToken" ou "csrf" dans le body JSON (si le serveur a changé le format)
  let csrfToken = response.headers.get("Csrftoken")
    ?? response.headers.get("csrftoken")
    ?? response.headers.get("x-csrf-token")
    ?? "";

  // Fallback : chercher dans le Set-Cookie un XSRF-TOKEN
  if (!csrfToken) {
    const setCookie = response.headers.get("set-cookie") ?? "";
    const xsrfMatch = setCookie.match(/XSRF-TOKEN=([^;]+)/);
    if (xsrfMatch) {
      csrfToken = xsrfMatch[1];
      console.log(`[usa] csrfToken extrait depuis Set-Cookie: ${csrfToken.slice(0, 8)}...`);
    }
  }

  // Fallback : chercher dans le body JSON (si le serveur a migré le CSRF dans le body)
  if (!csrfToken && data) {
    const bodyAny = data as unknown as Record<string, unknown>;
    const fromBody = bodyAny.csrfToken ?? bodyAny.csrf ?? bodyAny.xsrfToken ?? bodyAny.CsrfToken;
    if (typeof fromBody === "string" && fromBody.length > 0) {
      csrfToken = fromBody;
      console.log(`[usa] csrfToken extrait depuis le body JSON: ${csrfToken.slice(0, 8)}...`);
    }
  }

  // Diagnostic : loguer les headers de réponse si le csrfToken est toujours absent
  if (!csrfToken) {
    const headerEntries = [...response.headers.entries()];
    const headerNames = headerEntries.map(([k]) => k).join(", ");
    console.warn(`[usa] ⚠️ csrfToken ABSENT de la réponse login — headers reçus: [${headerNames}]`);
    console.warn(`[usa] Headers détaillés: ${JSON.stringify(Object.fromEntries(headerEntries)).slice(0, 1000)}`);
    // Le csrfToken vide n'empêche PAS le login ni le polling (GET).
    // Il ne bloque QUE les opérations PUT (booking/reschedule).
    // On continue avec un warning plutôt que de crasher.

    // ── Fallback : retry login sans proxy pour capturer le csrfToken ────────
    // Si le proxy résidentiel filtre les headers non-standard, un appel direct
    // (sans dispatcher) devrait recevoir le header Csrftoken du serveur.
    // On ne refait PAS un vrai login (risque de lockout) — on réutilise le JWT
    // déjà obtenu. On fait juste un GET /refreshToken sans proxy pour lire les headers.
    // NOTE: si le serveur a vraiment supprimé le header (migration), ce fallback échouera aussi.
    if (_usaProxyAgent) {
      console.log("[usa] Tentative de récupération csrfToken via appel direct (sans proxy, TLS Chrome)...");
      try {
        // Fallback : appel direct sans proxy pour capturer le csrfToken
        const directRes = await fetch(USA_REFRESH_URL, {
          method: "POST",
          headers: {
            ...getBrowserHeaders(),
            "Content-Type": "application/json",
            "Referer": REFERER_DASHBOARD,
          },
          body: JSON.stringify({ refreshToken: refreshToken ?? "", username }),
        });
        const directCsrf = directRes.headers.get("Csrftoken") ?? directRes.headers.get("csrftoken") ?? "";
        if (directCsrf) {
          csrfToken = directCsrf;
          console.log(`[usa] ✅ csrfToken récupéré via appel direct (sans proxy): ${csrfToken.slice(0, 8)}...`);
        } else {
          const directHeaders = [...directRes.headers.entries()].map(([k]) => k).join(", ");
          console.warn(`[usa] csrfToken TOUJOURS absent sans proxy — headers directs: [${directHeaders}]`);
          console.warn(`[usa] ⚠️ Le serveur ne renvoie plus le header Csrftoken — les PUT (booking) échoueront.`);
        }
      } catch (directErr) {
        console.warn(`[usa] Fallback direct échoué: ${directErr instanceof Error ? directErr.message : directErr}`);
      }
    }
  }

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

export async function checkUsaAppointmentRequestStatus(
  session: UsaSession,
  portalApplicationId?: string,
): Promise<{
  /**
   * pendingAppoStatus=0 + cancellable=true → "cancellable" (RDV existant, peut être reporté)
   * pendingAppoStatus=0 + applicationId (sans cancellable) → "cancellable" (demande annulable)
   * pendingAppoStatus=0 sans applicationId ni cancellable → "no_request" (aucune demande active)
   * pendingAppoStatus !== 0 (1, 2, 3...) → "pending" (demande active, calendrier ouvert, scan créneaux)
   *
   * NOTE: Le bundle Angular ne distingue PAS les valeurs 1/2/3. Il fait uniquement
   *       `0 !== pendingAppoStatus` → redirect vers appointment/create.
   */
  status: "payment_required" | "no_request" | "pending" | "error" | "cancellable";
  applicationId: string | null;
  pendingAppoStatus: number | null;
  primaryApplicant: string | null;
  message: string;
  /** missionId tel que retourné par le serveur — à propager dans session.missionId */
  missionId: number;
  /** applicantId interne retourné par le serveur — à propager dans session.applicantId.
   * Utilisé à la place de session.userID dans le call ?applicantId= de getApplicationDetails.
   * Peut être number ou string GSS (ex: "ODXJKHXJQMZH"). */
  applicantId?: number | string;
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
      if (res.status === 401 || res.status === 403) {
        const errBody = await res.text().catch(() => "");
        // Distinction cruciale : "temporarily restricted" ≠ token expiré.
        // Si restreint → NE PAS vider le cache (le JWT reste valide) → juste retourner "error".
        // Le guard isAccountRestricted() dans getUsaSession bloquera les prochains cycles.
        if (res.status === 401 && isRestrictedBody(errBody)) {
          const username = [...tokenCache.entries()].find(([, v]) => v.accessToken === session.accessToken)?.[0] ?? "";
          if (username) markAccountRestricted(username, undefined, undefined);
          console.warn(`[usa] Compte temporairement restreint (401 sur appointment status) — cycles ignorés avec backoff exponentiel`);
          return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: `Compte restreint (401)`, missionId: USA_MISSION_ID };
        }
        // Vraie expiration de token ou 403 : vider le cache pour forcer reconnexion
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

    // ── Sélection de l'application active parmi un tableau potentiel ──────────
    // Le serveur peut retourner un tableau quand le compte a plusieurs dossiers.
    // Priorité de sélection :
    //   1. portalApplicationId renseigné par l'admin → chercher cet ID exactement
    //   2. Premier dossier avec pendingAppoStatus > 0 (paiement confirmé, actif)
    //   3. Fallback : raw[0] (comportement original)
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Tableau vide — aucune demande de RDV", missionId: USA_MISSION_ID };
      }
      const list = raw as UsaAppointmentRequest[];

      if (portalApplicationId) {
        // Priorité 1 : l'admin a ciblé un dossier spécifique
        const targeted = list.find((r) => r.applicationId === portalApplicationId);
        if (targeted) {
          console.log(`[usa] 🎯 portalApplicationId trouvé dans le tableau (${list.length} dossier(s)) : ${portalApplicationId}`);
          data = targeted;
        } else {
          console.warn(`[usa] ⚠️ portalApplicationId "${portalApplicationId}" introuvable dans le tableau de ${list.length} dossier(s). IDs disponibles : ${list.map((r) => r.applicationId).join(", ")}`);
          data = list[0];
        }
      } else {
        // Priorité 2 : premier dossier actif (paiement confirmé)
        const active = list.find((r) => typeof r.pendingAppoStatus === "number" && r.pendingAppoStatus > 0);
        if (active) {
          if (list.length > 1) {
            console.log(`[usa] 📋 Compte multi-dossiers (${list.length}) — dossier actif sélectionné : ${active.applicationId} (pendingAppoStatus=${active.pendingAppoStatus})`);
          }
          data = active;
        } else {
          // Fallback : aucun dossier avec paiement confirmé — prendre le premier
          data = list[0];
        }
      }
    } else {
      data = raw as UsaAppointmentRequest;
    }

    if (!data) {
      return { status: "no_request", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: "Aucune application sélectionnable", missionId: USA_MISSION_ID };
    }
  } catch (err) {
    console.error("[usa] Erreur appel appointment status:", err);
    return { status: "error", applicationId: null, pendingAppoStatus: null, primaryApplicant: null, message: String(err), missionId: USA_MISSION_ID };
  }

  const appId = data.applicationId ?? null;
  const appoStatus = data.pendingAppoStatus ?? null;
  const applicant = data.primaryApplicant ?? null;
  // applicantId interne (bundle : selectedSlotDetails.applicantId) — peut être absent de la réponse.
  // IMPORTANT: le portail peut retourner un number (ex: 6012807) OU une string GSS (ex: "ODXJKHXJQMZH")
  // selon la mission. Les deux formes sont valides et doivent être propagées telles quelles.
  const serverApplicantId: number | string | undefined =
    typeof data.applicantId === "number" ? data.applicantId :
    (typeof data.applicantId === "string" && data.applicantId.length > 0 ? data.applicantId : undefined);
  // appointmentId — CRITIQUE pour le payload de booking (bundle: selectedSlotDetails.appointmentId).
  const serverAppointmentId: number | undefined =
    typeof data.appointmentId === "number" ? data.appointmentId : undefined;
  // applicantUUID — requis dans le payload de booking (bundle: selectedSlotDetails.applicantUUID).
  const serverApplicantUUID: number | undefined =
    typeof data.applicantUUID === "number" ? data.applicantUUID : undefined;

  console.log(`[usa] pendingAppoStatus=${appoStatus} applicationId=${appId} applicant=${applicant}${serverApplicantId !== undefined ? ` applicantId=${serverApplicantId}` : ""}${serverAppointmentId !== undefined ? ` appointmentId=${serverAppointmentId}` : ""}${serverApplicantUUID !== undefined ? ` applicantUUID=${serverApplicantUUID}` : ""}`);

  // Interprétation de pendingAppoStatus — tirée du bundle Angular (getAppIdByUserId) :
  //
  // Le bundle ne fait qu'un seul test : `0 !== pendingAppoStatus`
  //   - Si pendingAppoStatus !== 0 (1, 2, 3, etc.) → navigate to appointment/create
  //     = l'utilisateur a une demande active, le calendrier est ouvert, prêt à sélectionner un créneau
  //   - Si pendingAppoStatus === 0 → "The Application has been completed successfully"
  //     = pas de demande active OU demande terminée, appel synchronizeAccount()
  //
  // IL N'Y A PAS de distinction entre 1, 2, 3 dans le bundle.
  // pendingAppoStatus=1 NE signifie PAS "créneau déjà bookté" — c'est simplement
  // une valeur non-nulle qui indique que la demande est active et le scan est possible.
  //
  // Pour détecter un créneau réellement bookté, il faut interroger showRescheduleButton
  // ou scheduledappointmentInfo qui retournent les RDV actifs avec appointmentId.

  // missionId retourné par le serveur (dans la réponse JSON) — fait office de cookie "missionId" du portail.
  const serverMissionId = typeof data.missionId === "number" && data.missionId > 0
    ? data.missionId
    : USA_MISSION_ID;

  if (appoStatus === 0 || appoStatus === null) {
    // pendingAppoStatus=0 signifie "aucune demande active ou paiement non confirmé"
    // D'après le bundle: 0 !== pendingAppoStatus → redirection vers création de RDV
    // Donc pendingAppoStatus=0 → pas de redirection
    
    // CAS 1 : pendingAppoStatus=0 + cancellable=true (avec ou sans applicationId)
    // La réponse API peut être simplement {"pendingAppoStatus":0,"cancellable":true}
    // sans applicationId — le portail Angular considère ce cas comme un RDV existant
    // qui peut être reporté (affiche le bouton "Reschedule").
    // L'applicationId sera résolu via showRescheduleButton / scheduledappointmentInfo.
    if (data.cancellable === true || appId) {
      const reason = data.cancellable === true
        ? `cancellable=true${appId ? ` + applicationId=${appId}` : " (sans applicationId — sera résolu via API)"}`
        : `applicationId=${appId} présent`;
      console.log(`[usa] ⚠️ pendingAppoStatus=0 mais ${reason} → demande annulable/reschedule`);
      return {
        status: "cancellable",
        applicationId: appId,
        pendingAppoStatus: 0,
        primaryApplicant: applicant,
        message: `Demande annulable (pendingAppoStatus=0, ${reason})`,
        missionId: serverMissionId,
        applicantId: serverApplicantId,
        appointmentId: serverAppointmentId,
        applicantUUID: serverApplicantUUID,
      };
    }
    
    console.log(`[usa] pendingAppoStatus=${appoStatus} → aucune demande active ou paiement non confirmé`);
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

  // Toute valeur non-nulle (1, 2, 3, etc.) = demande active, calendrier ouvert → scanner les créneaux
  // Le bundle Angular ne distingue pas les valeurs : `0 !== pendingAppoStatus` → appointment/create
  return {
    status: "pending",
    applicationId: appId,
    pendingAppoStatus: appoStatus,
    primaryApplicant: applicant,
    message: `Demande active (status=${appoStatus}) — scan créneaux pour ${applicant}`,
    missionId: serverMissionId,
    applicantId: serverApplicantId,
    appointmentId: serverAppointmentId,
    applicantUUID: serverApplicantUUID,
  };
}

export async function getUsaAppointmentRequests(session: UsaSession): Promise<UsaAppointmentRequest[]> {
  // visauserapi requiert le cookie missionId (comme tous les endpoints de slot).
  // On utilise sessionHeaders avec applicationId vide si non résolu — seul missionId compte ici.
  // Referer = page "Requests" du dashboard (REFERER_MANAGE_APT → 401 sur visauserapi).
  const appIdForCookie = session.applicationId ?? "";
  const headers = sessionHeaders(session.accessToken, appIdForCookie, session.missionId, REFERER_REQUESTS, false);

  try {
    const res = await usaFetch(USA_APPT_REQUESTS_URL, { method: "GET", headers });
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch { /* ignore */ }
      console.error(`[usa] Appointment requests HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
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

// ────────────────────────────────────────────────────────────────────────────
// RÉSOLUTION "CANCELLABLE" — API-first (remplace Playwright)
//
// Quand le workflow est terminé (pendingAppoStatus=0, cancellable=true), le portail
// Angular affiche un bouton "Reschedule". L'applicationId ne vient pas de
// getUserHistoryApplicantPaymentStatus dans cet état.
//
// Stratégie API-first (3 endpoints du bundle Angular, Bearer seulement) :
//  1. GET /appointments/scheduledappointmentInfo  → liste des RDV planifiés
//  2. GET /appointments/getLandingPageDeatils      → fallback données dashboard
//  3. POST /appointments/search                    → détails complets si appId trouvé
//
// Met à jour session.applicationId, session.appointmentId, session.applicantId,
// session.applicantUUID si trouvés.
// Retourne "proceed" (→ scan), "not_found" (→ skip), "error".
// ────────────────────────────────────────────────────────────────────────────

/**
 * Génère un X-Correlation-key de 15 chars alphanumériques (même algo que generateCorrelationId()
 * dans l'intercepteur Angular du bundle).
 */
function corrId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 15; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function fetchCancellableSessionIds(
  session: UsaSession,
  job: HunterJob,
): Promise<"proceed" | "not_found" | "error"> {
  const token = session.accessToken;
  console.log("[cancellable] Tentative API-first pour récupérer applicationId/appointmentId...");

  // Headers standards Angular (l'intercepteur injecte X-Correlation-key + Authorization)
  const stdH: Record<string, string> = {
    ...getBrowserHeaders(),
    "Authorization":     `Bearer ${token}`,
    "Content-Type":      "application/json",
    "Accept":            "application/json",
    "X-Correlation-key": corrId(),
    "Referer":           REFERER_DASHBOARD,
  };

  // ── Étape 0 (PRIORITÉ) : GET showRescheduleButton ──────────────────────────
  // Découvert via capture Playwright du flux réel Angular.
  // C'est l'endpoint que le portail appelle sur la page "Mes rendez-vous" pour
  // déterminer quel dossier peut être reschedule. Il retourne le BON applicationId
  // (celui avec le RDV actif), contrairement à scheduledappointmentInfo qui peut
  // retourner un ancien dossier.
  // Retourne : [{applicationId, appointmentId, showRescheduleButton, rescheduleLimit, showCancelButton}]
  let foundViaRescheduleBtn = false;
  try {
    console.log("[cancellable] GET showRescheduleButton...");
    const res = await usaFetch(USA_SHOW_RESCHEDULE_BUTTON_URL, { method: "GET", headers: stdH });
    console.log(`[cancellable] showRescheduleButton → HTTP ${res.status}`);
    if (res.ok) {
      const raw = await res.text();
      console.log(`[cancellable] showRescheduleButton réponse: ${raw.slice(0, 500)}`);
      let data: unknown;
      try { data = JSON.parse(raw); } catch { /* non-JSON */ }

      const items: Record<string, unknown>[] = Array.isArray(data) ? data as Record<string, unknown>[] :
        (data && typeof data === "object" ? [data as Record<string, unknown>] : []);

      // Chercher l'entrée avec showRescheduleButton=true
      for (const item of items) {
        if (item.showRescheduleButton !== true) continue;

        const appId = typeof item.applicationId === "string" ? item.applicationId : null;
        const apptId = typeof item.appointmentId === "number" ? item.appointmentId :
          (typeof item.appointmentId === "string" ? parseInt(item.appointmentId as string, 10) : undefined);
        // appointmentUUID est une string UUID — nécessaire pour le Referer dynamique du reschedule
        const apptUUID = typeof item.appointmentUUID === "string" ? item.appointmentUUID : undefined;

        if (appId) {
          session.applicationId = appId;
          foundViaRescheduleBtn = true;
          console.log(`[cancellable] ✅ applicationId depuis showRescheduleButton: ${appId}`);
        }
        if (apptId !== undefined && !isNaN(apptId)) {
          session.appointmentId = apptId;
          console.log(`[cancellable] ✅ appointmentId depuis showRescheduleButton: ${apptId}`);
        }
        if (apptUUID) {
          session.appointmentUUID = apptUUID;
          console.log(`[cancellable] ✅ appointmentUUID depuis showRescheduleButton: ${apptUUID}`);
        }
        if (foundViaRescheduleBtn) break;
      }
    } else {
      const errBody = await res.text().catch(() => "");
      console.warn(`[cancellable] showRescheduleButton HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[cancellable] showRescheduleButton erreur réseau: ${err}`);
  }

  // Si showRescheduleButton a donné les IDs, on peut skip les étapes suivantes
  if (foundViaRescheduleBtn && session.applicationId && session.appointmentId !== undefined) {
    console.log(`[cancellable] ✅ Résolution via showRescheduleButton — applicationId=${session.applicationId} appointmentId=${session.appointmentId}`);
    botLog({
      applicationId: job.id,
      step: "scan",
      status: "ok",
      data: {
        flow: "usa",
        phase: "cancellable_api_ok",
        source: "showRescheduleButton",
        applicationId: session.applicationId,
        appointmentId: session.appointmentId,
        applicantId: session.applicantId,
      },
    });
    return "proceed";
  }

  // ── Étape 1 (fallback) : GET scheduledappointmentInfo ──────────────────────
  // Retourne la liste des RDV "scheduled" de l'utilisateur connecté.
  // Ce tableau contient applicationId + appointmentId + appointmentUUID.
  let foundViaInfo = false;
  try {
    console.log("[cancellable] GET scheduledappointmentInfo...");
    const res = await usaFetch(USA_SCHEDULED_INFO_URL, { method: "GET", headers: stdH });
    console.log(`[cancellable] scheduledappointmentInfo → HTTP ${res.status}`);
    if (res.ok) {
      const raw = await res.text();
      console.log(`[cancellable] scheduledappointmentInfo réponse: ${raw.slice(0, 500)}`);
      let data: unknown;
      try { data = JSON.parse(raw); } catch { /* non-JSON */ }

      const items: Record<string, unknown>[] = Array.isArray(data) ? data as Record<string, unknown>[] :
        (data && typeof data === "object" ? [data as Record<string, unknown>] : []);

      for (const item of items) {
        const appId = typeof item.applicationId === "string" ? item.applicationId : null;
        const apptId = typeof item.appointmentId === "number" ? item.appointmentId :
          (typeof item.appointmentId === "string" ? parseInt(item.appointmentId, 10) : undefined);
        const applicantId = typeof item.applicantId === "number" ? item.applicantId :
          (typeof item.applicantId === "string" ? parseInt(item.applicantId, 10) : undefined);
        const applicantUUID = typeof item.applicantUUID === "number" ? item.applicantUUID :
          (typeof item.applicantUUID === "string" ? parseInt(item.applicantUUID, 10) : undefined);
        const appointmentUUID = typeof item.appointmentUUID === "string" ? item.appointmentUUID : undefined;

        if (appId) {
          session.applicationId = appId;
          foundViaInfo = true;
          console.log(`[cancellable] ✅ applicationId depuis scheduledappointmentInfo: ${appId}`);
        }
        if (apptId !== undefined && !isNaN(apptId)) {
          session.appointmentId = apptId;
          console.log(`[cancellable] ✅ appointmentId depuis scheduledappointmentInfo: ${apptId}`);
        }
        if (applicantId !== undefined && !isNaN(applicantId)) {
          session.applicantId = applicantId;
        }
        if (applicantUUID !== undefined && !isNaN(applicantUUID)) {
          session.applicantUUID = applicantUUID;
        }
        if (appointmentUUID) {
          session.appointmentUUID = appointmentUUID;
          console.log(`[cancellable] ✅ appointmentUUID depuis scheduledappointmentInfo: ${appointmentUUID}`);
        }
        if (foundViaInfo) break;
      }
    } else {
      const errBody = await res.text().catch(() => "");
      console.warn(`[cancellable] scheduledappointmentInfo HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[cancellable] scheduledappointmentInfo erreur réseau: ${err}`);
  }

  // ── Étape 2 : GET getLandingPageDeatils (fallback) ──────────────────────────
  // Dashboard data — retourne les infos de la demande en cours incluant applicationId.
  // Nécessite le header LanguageId (cf. intercepteur Angular dans le bundle).
  if (!session.applicationId) {
    try {
      console.log("[cancellable] Fallback GET getLandingPageDeatils...");
      const landingH = {
        ...stdH,
        "X-Correlation-key": corrId(),
        "LanguageId": "1",
      };
      const res = await usaFetch(USA_LANDING_PAGE_URL, { method: "GET", headers: landingH });
      console.log(`[cancellable] getLandingPageDeatils → HTTP ${res.status}`);
      if (res.ok) {
        const raw = await res.text();
        console.log(`[cancellable] getLandingPageDeatils réponse: ${raw.slice(0, 500)}`);
        // Chercher applicationId dans la réponse JSON (quel que soit le format)
        const appIdMatch = raw.match(/"applicationId"\s*:\s*"([^"]+)"/);
        if (appIdMatch) {
          session.applicationId = appIdMatch[1];
          console.log(`[cancellable] ✅ applicationId depuis getLandingPageDeatils: ${session.applicationId}`);
        }
        const apptIdMatch = raw.match(/"appointmentId"\s*:\s*(\d+)/);
        if (apptIdMatch && session.appointmentId === undefined) {
          session.appointmentId = parseInt(apptIdMatch[1], 10);
          console.log(`[cancellable] ✅ appointmentId depuis getLandingPageDeatils: ${session.appointmentId}`);
        }
      }
    } catch (err) {
      console.warn(`[cancellable] getLandingPageDeatils erreur: ${err}`);
    }
  }

  if (!session.applicationId) {
    console.warn("[cancellable] ❌ applicationId introuvable via les 2 endpoints dashboard");
    botLog({ applicationId: job.id, step: "scan", status: "warn", data: { flow: "usa", phase: "cancellable_api_no_appid" } });
    return "not_found";
  }

  // ── Étape 3 : POST /appointments/search — détails complets du RDV ────────────
  // Si on a l'applicationId, on appelle /search pour récupérer appointmentId exact +
  // applicantId + applicantUUID (correspondant à l'entrée "SCHEDULED"/"RESCHEDULED").
  if (session.appointmentId === undefined || session.applicantId === undefined) {
    try {
      console.log(`[cancellable] POST /appointments/search (applicationId=${session.applicationId})...`);
      // Capture réseau : le portail filtre par applicationId ET appointmentUUID quand disponible
      const searchObjects: Array<Record<string, string>> = [
        { key: "applicationId", value: session.applicationId, feildType: "STRING", operation: "EQUAL" },
      ];
      if (session.appointmentUUID) {
        searchObjects.push({ key: "appointmentUUID", value: session.appointmentUUID, feildType: "STRING", operation: "EQUAL" });
      }
      const searchPayload = { operation: "AND", searchObjects };
      const searchH = {
        ...stdH,
        "X-Correlation-key": corrId(),
        "Cookie": `APP_ID_TOBE=${session.applicationId}; missionId=${session.missionId}`,
      };
      const res = await usaFetch(USA_SEARCH_URL, {
        method: "POST",
        headers: searchH,
        body: JSON.stringify(searchPayload),
      });
      console.log(`[cancellable] /appointments/search → HTTP ${res.status}`);
      if (res.ok) {
        const raw = await res.text();
        console.log(`[cancellable] /appointments/search réponse: ${raw.slice(0, 600)}`);
        let rows: Record<string, unknown>[] = [];
        try { rows = JSON.parse(raw) as Record<string, unknown>[]; } catch { /* non-JSON */ }

        // Filtrer SCHEDULED ou RESCHEDULED + type POST (RDV ambassade) ou OFC
        const scheduled = rows.filter(r =>
          (r.appointmentStatus === "SCHEDULED" || r.appointmentStatus === "RESCHEDULED") &&
          (r.appointmentLocationType === "POST" || r.appointmentLocationType === "OFC")
        );
        const target = scheduled[0] ?? rows[0];

        if (target) {
          if (typeof target.appointmentId === "number" && session.appointmentId === undefined) {
            session.appointmentId = target.appointmentId;
            console.log(`[cancellable] ✅ appointmentId depuis /search: ${session.appointmentId}`);
          }
          if (typeof target.applicantId === "number" && session.applicantId === undefined) {
            session.applicantId = target.applicantId;
            console.log(`[cancellable] ✅ applicantId depuis /search: ${session.applicantId}`);
          }
          // applicantId peut aussi être une string GSS (ex: "RQUP3HHVQHOD")
          if (typeof target.applicantId === "string" && target.applicantId.length > 0 && session.applicantId === undefined) {
            session.applicantId = target.applicantId;
            console.log(`[cancellable] ✅ applicantId (GSS) depuis /search: ${session.applicantId}`);
          }
          const uuid = target.applicantUUID ?? target.appointmentUUID;
          if (typeof uuid === "number" && session.applicantUUID === undefined) {
            session.applicantUUID = uuid;
            console.log(`[cancellable] ✅ applicantUUID depuis /search: ${uuid}`);
          }
          // appointmentUUID est une string UUID (ex: "0cbcba2c-a420-4d74-b99a-d7431aaa6897")
          if (typeof target.appointmentUUID === "string" && !session.appointmentUUID) {
            session.appointmentUUID = target.appointmentUUID;
            console.log(`[cancellable] ✅ appointmentUUID depuis /search: ${session.appointmentUUID}`);
          }
        }
      } else {
        console.warn(`[cancellable] /appointments/search HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[cancellable] /appointments/search erreur: ${err}`);
    }
  }

  console.log(
    `[cancellable] ✅ Résolution API terminée — applicationId=${session.applicationId} ` +
    `appointmentId=${session.appointmentId ?? "N/A"} applicantId=${session.applicantId ?? "N/A"}`
  );
  botLog({
    applicationId: job.id,
    step: "scan",
    status: "ok",
    data: {
      flow: "usa",
      phase: "cancellable_api_ok",
      applicationId: session.applicationId,
      appointmentId: session.appointmentId,
      applicantId: session.applicantId,
    },
  });
  return "proceed";
}

export async function runUsaApiSession(job: HunterJob): Promise<SessionResult> {
  const { embassyUsername: username, embassyPassword: password, twoCaptchaApiKey } = job.hunterConfig;
  const sessionStartTime = Date.now();
  let result: SessionResult = "error";

  // Log le début du comportement humain
  logHumanBehaviorStart(job.id, `USA Portal - ${username}`);
  
  try {
    if (!username || !password) {
      console.error("[usa] Identifiants portail manquants dans hunterConfig");
      result = "error";
      return result;
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
    // ── Proxy résidentiel 2captcha (prioritaire pour USA) ──────────────────
    // Les IPs résidentielles du pool 2captcha sont STABLES pendant 30 min
    // (contrairement à iProyal/BrightData qui changent d'IP mid-session).
    // Le serveur USA lie le JWT à l'IP du login → on utilise getStickyProxy()
    // pour assigner UNE IP fixe par compte sur toute la durée du token.
    // Fallback : connexion directe Railway (IP fixe) si le pool est indisponible.
    const stickyProxyUrl = await proxyPool.getStickyProxy(username);
    if (stickyProxyUrl) {
      sessionProxy = stickyProxyUrl;
      const maskedProxy = stickyProxyUrl.replace(/:([^:@]+)@/, ":***@");
      console.log(`[usa] Nouveau token → proxy 2captcha sticky: ${maskedProxy}`);
    } else {
      // Pool vide ou non configuré → Railway direct (fallback sûr)
      sessionProxy = undefined;
      console.log(`[usa] Nouveau token → connexion DIRECTE (pool 2captcha indisponible — fallback IP Railway)`);
    }
    sessionUaIdx = Math.floor(Math.random() * USA_UA_POOL.length);
  }

  // Activer le proxy et l'UA choisis pour TOUTE cette session
  _sessionUa = USA_UA_POOL[sessionUaIdx];
  console.log(`[usa] UA: ${_sessionUa.ua.match(/(?:Chrome|Edg)\/[\d.]+/)?.[0] ?? _sessionUa.ua.slice(0, 60)}`);
  setUsaSessionProxy(sessionProxy);
  if (!sessionProxy) {
    console.warn("[usa] ⚠️ Aucun proxy résidentiel 2captcha — appels API via IP Railway directe (fallback)");
  }
  // ──────────────────────────────────────────────────────────────────────────

  let session: UsaSession | null = null;
  try {
    session = await getUsaSession(username, password, twoCaptchaApiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] getUsaSession échoué: ${msg}`);
    botLog({ applicationId: job.id, step: "login", status: "fail", data: { username, error: msg.slice(0, 300) } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: msg.slice(0, 300),
    });
    result = "login_failed";
    return result;
  }
  if (!session) {
    // null peut vouloir dire : compte temporairement restreint (isAccountRestricted() = true)
    // ou identifiants incorrects. On distingue les deux pour éviter l'auto-pause inutile.
    if (isAccountRestricted(username)) {
      const until = accountRestrictedUntil.get(username.toLowerCase())!;
      const remainMin = Math.round((until - Date.now()) / 60000);
      botLog({ applicationId: job.id, step: "login", status: "warn", data: { username, error: `Compte restreint — ${remainMin} min restantes` } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Compte restreint — cycle ignoré (${remainMin} min restantes)`,
      });
      result = "not_found";
      return result;  // "not_found" = pas de panique, on réessaie plus tard
    }
    botLog({ applicationId: job.id, step: "login", status: "fail", data: { username, error: "Identifiants incorrects ou portail indisponible" } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: "Connexion API USA échouée — identifiants incorrects ou portail indisponible",
    });
    result = "login_failed";
    return result;
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

  // ── Log login réussi dans Convex (visible dans botLogs du panneau admin) ──
  botLog({
    applicationId: job.id,
    step: "login",
    status: "ok",
    data: {
      flow: "usa",
      username,
      fullName: session.fullName,
      userID: session.userID,
      csrfToken: session.csrfToken ? "present" : "ABSENT",
      missionId: session.missionId,
    },
  });

  // ── Résolution du dossier actif ────────────────────────────────────────────
  // Le portail peut retourner plusieurs dossiers si le compte en gère plusieurs.
  // portalApplicationId (admin) → sélection exacte ; sinon → premier avec paiement confirmé.
  const requestStatus = await checkUsaAppointmentRequestStatus(session, job.hunterConfig.portalApplicationId);
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
    botLog({ applicationId: job.id, step: "appointment_status", status: "fail", data: { flow: "usa", status: "error", message: requestStatus.message } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: requestStatus.message,
    });
    result = "error";
    return result;
  }

  if (requestStatus.status === "no_request") {
    console.warn(`[usa] Aucune demande soumise : ${requestStatus.message}`);
    botLog({ applicationId: job.id, step: "appointment_status", status: "warn", data: { flow: "usa", status: "no_request", pendingAppoStatus: requestStatus.pendingAppoStatus, message: requestStatus.message, action: "L'utilisateur doit effectuer le paiement sur usvisaappt.com" } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "not_found",
      errorMessage: requestStatus.message,
    });
    result = "not_found";
    return result;
  }

  // ── Cas "cancellable" : demande avec applicationId mais pendingAppoStatus=0 (annulable) ──
  // Exemple : demande créée mais paiement non effectué, peut être annulée
  if (requestStatus.status === "cancellable") {
    const rescheduleMode = job.hunterConfig.rescheduleMode;
    if (!rescheduleMode) {
      console.log(`[usa] ♻️ Demande annulable (cancellable) — rescheduleMode non activé dans l'admin. Passage ignoré.`);
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: "cancellable: rescheduleMode non activé",
      });
      return "not_found";
    }

    console.log(`[usa] ♻️ Demande cancellable — résolution applicationId/appointmentId via API...`);
    botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "cancellable_api_start" } });

    const apiResult = await fetchCancellableSessionIds(session, job);
    if (apiResult === "error") {
      console.error("[usa] ❌ Résolution cancellable API échouée");
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Résolution cancellable API échouée" });
      return "error";
    }
    if (apiResult === "not_found") {
      console.warn("[usa] ⚠️ Résolution cancellable : aucun ID trouvé — skip");
      await sendHeartbeat({ applicationId: job.id, result: "not_found", errorMessage: "applicationId/appointmentId non trouvés via API dashboard" });
      return "not_found";
    }
    // apiResult = "proceed" : session.applicationId et session.appointmentId sont à jour
    console.log(`[usa] ✅ Résolution cancellable terminée — applicationId=${session.applicationId} appointmentId=${session.appointmentId}`);
    botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "cancellable_api_proceed", applicationId: session.applicationId, appointmentId: session.appointmentId } });
    // Marquer la session pour utiliser PUT /appointments/reschedule lors du booking
    session.isReschedule = true;
    // Laisser tomber vers le scan de créneaux (ne pas return ici)
  }

  // Note: Le statut "scheduled" n'existe plus. Si un RDV est déjà bookté,
  // il sera détecté via showRescheduleButton dans le flow cancellable (pendingAppoStatus=0 + cancellable=true).
  // Si pendingAppoStatus !== 0 → demande active, on scanne directement.

  console.log(`[usa] ${requestStatus.message} — lancement scan créneaux via API directe...`);
  botLog({
    applicationId: job.id,
    step: "login",
    status: "ok",
    data: {
      username,
      applicationId: session.applicationId,
      missionId: session.missionId,
      allowedOfcs: session.allowedOfcs?.map((o) => o.postUserId) ?? [],
    },
  });

  try {
    const slotResult = await scanUsaSlotsViaAPI(job, session);
    result = slotResult;
    return result;
  } finally {
    setUsaSessionProxy(undefined);
    // Note: NE PAS libérer le sticky proxy ici — on le garde pour le prochain cycle
    // du même compte. Le proxy sera automatiquement libéré après expiration (30 min).
    // proxyPool.releaseStickyProxy(username) → seulement si logout explicite.
  }
} catch (error) {
  console.error("[usa] Erreur inattendue dans runUsaApiSession:", error);
  result = "error";
} finally {
  // ── Logout propre après chaque cycle — comportement humain ─────────────
  // Un humain : login → check (~1-3 min) → ferme l'onglet → idle timeout → logout.
  // Le bundle Angular fait un POST /logout explicite quand le idle timer expire.
  // Si on ne logout pas et que le prochain scan est dans >15 min, le serveur voit
  // un JWT inactif pendant >15 min SANS logout reçu → comportement anormal → restriction.
  // En faisant un logout propre ici, le serveur voit une session normale de 1-3 min
  // qui se termine proprement, et le prochain cycle démarre avec un login frais.
  if (username) {
    try {
      // Petite pause avant logout (un humain ne clique pas "déconnexion" instantanément)
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
      await logoutUsaPortal(username);
      botLog({
        applicationId: job.id,
        step: "logout",
        status: "ok",
        data: { username, sessionDurationMs: Date.now() - sessionStartTime, result },
      });
    } catch (logoutErr) {
      // Logout échoué — non bloquant, le token expirera naturellement
      console.warn(`[usa] Logout échoué (non bloquant): ${logoutErr}`);
    }
  }

  // Log la fin du comportement humain
  const sessionDuration = Date.now() - sessionStartTime;
  logHumanBehaviorEnd(job.id, `USA Portal - ${username}`, sessionDuration);
}
return result;
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

/** Réponse brute de l'API /lookupcdt/wizard/getpost — champs réels du serveur.
 * Le portail renvoie `ofcName` et `code`, pas `postName`/`postCode`. */
interface UsaOfcRaw {
  postUserId: number;
  missionId?: number;
  ofcName?: string;
  postName?: string;  // Certaines missions renvoient postName au lieu de ofcName
  ofcAddress?: string;
  countryCode?: string;
  stateCode?: string;
  city?: string;
  officeType: string;
  code?: string;
  status?: string;
}

/** Normalise la réponse brute de l'API OFC en UsaOfc interne. */
function normalizeOfc(raw: UsaOfcRaw): UsaOfc {
  return {
    postUserId: raw.postUserId,
    postName: raw.ofcName ?? raw.postName ?? raw.city ?? `OFC-${raw.postUserId}`,
    officeType: raw.officeType,
    postCode: raw.code,
  };
}

interface UsaAppDetails {
  applicantId: number | string;
  applicationId: string;
  /** visaType envoyé dans les payloads slot (getFirstAvailableMonth, getSlotDates, etc.)
   * Ex: "NIV" (Non-Immigrant Visa). Différent de visaCategory! */
  visaType: string;
  visaClass: string;
  /** visaCategory envoyé dans l'URL getpost (OFC list).
   * Ex: "VisitorVisas". Le portail Angular l'envoie comme param ?visaCategory= dans getFilteredOfcPostList.
   * Distinct de visaType ("NIV") qui va dans les payloads de slot. */
  visaCategory?: string;
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
  /** visaTypeKey — short code format from /appointments/search (e.g. "NIV", "IV").
   * Used directly in slot payloads (getFirstAvailableMonth, getSlotDates, etc.). */
  visaTypeKey?: string;
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
  slotId: number | string;  // Le portail retourne un string alphanumérique (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
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

    // La réponse peut avoir deux formats (selon le endpoint/version du portail) :
    //   A) Tableau plat d'objets UsaAppDetails (historique)
    //   B) Objet unique avec gssApplicants[0].appointmentDetails[0] (format actuel capturé)
    // Le format B a les champs visaType/visaClass/appointmentId dans appointmentDetails,
    // pas au top-level de l'objet.
    let list: UsaAppDetails[];

    if (Array.isArray(raw)) {
      // Format A : tableau d'objets
      list = raw;
    } else if (raw && typeof raw === "object" && raw.gssApplicants?.length > 0) {
      // Format B : objet avec gssApplicants (format capturé dans la vraie session)
      const apptDetails = raw.gssApplicants[0]?.appointmentDetails;
      if (Array.isArray(apptDetails) && apptDetails.length > 0) {
        // Extraire les détails depuis appointmentDetails imbriqué
        list = apptDetails.map((ad: Record<string, unknown>) => ({
          applicantId: ad.applicantId ?? raw.gssApplicants[0]?.applicantId,
          applicationId: ad.applicationId ?? raw.applicationId,
          visaType: ad.visaType ?? "NIV",
          visaClass: (ad.visaClassCode ?? ad.visaClass) as string,
          visaCategory: (ad.visaCategoryCode ?? ad.visaCategory) as string,
          locationType: ad.appointmentLocationType,
          appointmentStatus: ad.appointmentStatus,
          appointmentLocationType: ad.appointmentLocationType,
          appointmentId: ad.appointmentId as number | undefined,
          applicantUUID: ad.applicantUUID ?? ad.appointmentUUID,
        })) as UsaAppDetails[];
        console.log(`[usa] getApplicationDetails: format gssApplicants détecté (${list.length} appointment(s))`);
      } else {
        // Pas d'appointmentDetails — traiter l'objet comme un UsaAppDetails direct
        list = [raw as unknown as UsaAppDetails];
      }
    } else {
      list = [raw as unknown as UsaAppDetails];
    }

    // Filtrer pour obtenir uniquement les demandes en statut "NEW" (en attente de créneau)
    const newItems = list.filter(item => item.appointmentStatus === "NEW");
    // En mode reschedule, les RDV existants sont en statut "SCHEDULED" — les inclure aussi
    const scheduledItems = list.filter(item => item.appointmentStatus === "SCHEDULED");
    const data = newItems.length > 0 ? newItems[0] : (scheduledItems.length > 0 ? scheduledItems[0] : list[0]);  // fallback au premier si pas de "NEW" ni "SCHEDULED"
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

// ─────────────────────────────────────────────────────────────────────────────
// getUsaTransformData — récupère stateCode + appointmentPriority pour l'URL OFC
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET /visaworkflowprocessor/workflow/getTransformData/{applicationId}
 *
 * Bundle Angular : renderService.getTransformData(applicationId, applicantId)
 *   Appelé sur la page /home/dashboard/requests ET dans le booking flow OFC step
 *   quand this.ofcOrPost/this.appointmentType/this.stateCode ne sont pas encore définis.
 *
 * Retourne un tableau. [0].transformData est un JSON stringifié contenant (entre autres) :
 *   - stateCode          → param ?stateCode= de l'URL OFC list
 *   - appointmentPriority → param ?priority= de l'URL OFC list (si présent)
 *   - visaClass, visaTypekey, paymentStatus, missionId, etc.
 *
 * Note bundle : malgré la signature JS getTransformData(y, w), seul y (applicationId)
 * est utilisé dans l'URL — w (applicantId) n'est pas transmis au serveur.
 */
async function getUsaTransformData(
  session: UsaSession,
  applicationId: string,
): Promise<{ stateCode?: string; appointmentPriority?: string; paymentStatus?: string; visaClass?: string; visaCategory?: string; visaCategoryKey?: string; applicantId?: string; visaTypeKey?: string } | null> {
  const url = USA_TRANSFORM_DATA_URL(applicationId);
  const hdrs = sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_REQUESTS, false);
  try {
    const res = await usaFetch(url, { headers: hdrs });
    if (res.status === 429) throw new RateLimitError("getTransformData", parseInt(res.headers.get("retry-after") ?? "60", 10) * 1000);
    if (res.status === 403) throw new AccountBlockedError("getTransformData");
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      console.warn(`[usa] getTransformData HTTP ${res.status} — ignoré (params OFC non enrichis)`);
      return null;
    }
    const raw = await res.json();
    const arr = Array.isArray(raw) ? raw : [];
    if (arr.length === 0) return null;

    // Bundle : B.stepTransformData = JSON.parse(B.transformData)
    // On parse le JSON stringifié dans .transformData
    let td: Record<string, unknown> = {};
    try {
      td = JSON.parse(arr[0].transformData as string) as Record<string, unknown>;
    } catch {
      console.warn("[usa] getTransformData: impossible de parser .transformData");
    }

    const stateCode        = typeof td.stateCode        === "string" ? td.stateCode        : undefined;
    const appointmentPriority = typeof td.appointmentPriority === "string" ? td.appointmentPriority : undefined;
    const paymentStatus    = typeof td.paymentStatus    === "string" ? td.paymentStatus    : undefined;
    // visaClass et visaCategory — nécessaires pour l'URL OFC list quand getApplicationDetails échoue
    // (cas "cancellable" : le dossier est terminé, getApplicationDetails filtre par appointmentStatus=NEW → vide)
    const visaClass        = typeof td.visaClass        === "string" ? td.visaClass        : undefined;
    const visaCategory     = typeof td.visaCategory     === "string" ? td.visaCategory     :
                             (typeof td.visaCategoryCode === "string" ? td.visaCategoryCode : undefined);
    // visaCategorykey (ex: "StudentsandExchangeVisitors") — c'est le CODE que le portail Angular
    // envoie dans l'URL lookupcdt/wizard/getpost?visaCategory=... 
    // DIFFÉRENT de visaCategory (label: "Students and Exchange Visitors") qui cause un 404.
    // Fallback: on tente aussi visaCategoryCode (champ du search response) et enfin on strip les espaces du label.
    const visaCategoryKey  = typeof td.visaCategorykey  === "string" ? td.visaCategorykey  :
                             (typeof td.visaCategoryCode === "string" ? td.visaCategoryCode :
                             (typeof td.visaCategory === "string" ? td.visaCategory.replace(/\s+/g, "") : undefined));
    // applicantId GSS (ex: "RQUP3HHVQHOD") — utilisé dans les payloads slot si getApplicationDetails échoue
    const applicantId      = typeof td.applicantid      === "string" ? td.applicantid      :
                             (typeof td.applicantId      === "string" ? td.applicantId      : undefined);
    // visaTypekey (ex: "NIV") — c'est ce que le portail envoie dans les payloads slot, PAS visaType ("Non-immigrant Visa")
    const visaTypeKey      = typeof td.visaTypekey      === "string" ? td.visaTypekey      : undefined;

    console.log(`[usa] getTransformData: stateCode=${stateCode ?? "(vide)"} priority=${appointmentPriority ?? "(vide)"} visaClass=${visaClass ?? "(vide)"} visaCategory=${visaCategory ?? "(vide)"} visaCategoryKey=${visaCategoryKey ?? "(vide)"} applicantId=${applicantId ?? "(vide)"} paymentStatus=${paymentStatus ?? "?"}`);
    return { stateCode, appointmentPriority, paymentStatus, visaClass, visaCategory, visaCategoryKey, applicantId, visaTypeKey };
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError) throw err;
    console.warn(`[usa] getTransformData erreur: ${err} — ignoré`);
    return null;
  }
}

async function getUsaOfcList(
  session: UsaSession,
  missionId: number,
  visaClass?: string,
  visaCategory?: string,
  stateCode?: string,
  priority?: string,
): Promise<UsaOfc[]> {
  const url = USA_OFC_LIST_URL(missionId, visaClass, visaCategory, stateCode, priority);
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
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      console.warn(`[usa] getOfcList HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    // L'API retourne des champs `ofcName`/`code` (pas `postName`/`postCode`) — normaliser.
    const rawList = Array.isArray(data) ? data as UsaOfcRaw[] : [];
    const list: UsaOfc[] = rawList.map(normalizeOfc);

    // Étape 1 : filtre par officeType — bundle: je.filter(B => B.officeType === this.ofcOrPost)
    // Le portail Angular utilise `this.ofcOrPost` qui vaut "OFC" par défaut (nouveau booking)
    // ou "POST" (reschedule d'un RDV POST, ex: Kinshasa où il n'y a PAS de bureau OFC séparé).
    // Pour les missions sans bureau OFC (ex: Kinshasa missionId=323 → un seul bureau officeType="POST"),
    // il faut inclure les bureaux POST sinon la liste est vide et le scan échoue.
    let filtered = list.filter(o => o.officeType === "OFC");

    // Fallback : si aucun OFC trouvé, utiliser les bureaux POST (cas Kinshasa, etc.)
    if (filtered.length === 0 && list.length > 0) {
      filtered = list.filter(o => o.officeType === "POST");
      if (filtered.length > 0) {
        console.log(`[usa] ⚠️ Aucun bureau OFC — fallback sur ${filtered.length} bureau(x) POST: ${filtered.map(o => o.postName).join(", ")}`);
      }
    }

    // Étape 2 : filtre par OFCs autorisés (loggedInApplicantUser.ofc)
    // Bundle : S?.length>0 && (ofcList = ofcList.filter(B => S.some(se => se.postUserId===B.postUserId)))
    const allowed = session.allowedOfcs ?? [];
    if (allowed.length > 0) {
      const allowedIds = new Set(allowed.map(o => o.postUserId));
      const before = filtered.length;
      filtered = filtered.filter(o => allowedIds.has(o.postUserId));
      console.log(`[usa] Filtre OFCs autorisés du compte: ${before} → ${filtered.length} OFC(s)`);
    }

    const paramStr = [
      visaClass    ? `visaClass=${visaClass}`   : null,
      visaCategory ? `cat=${visaCategory}`      : null,
      stateCode    ? `state=${stateCode}`        : null,
      priority     ? `priority=${priority}`      : null,
    ].filter(Boolean).join(" ");
    console.log(`[usa] OFCs (mission ${missionId}${paramStr ? ` ${paramStr}` : ""}): ${filtered.map(o => o.postName).join(", ") || "aucun"}`);
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
  slotId: number | string;  // string alphanumérique retourné par le portail (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
  ofcName: string;
  slot: UsaTimeSlot;
  bookingBase: Record<string, unknown>;
}

async function findFirstSlotForOfc(
  session: UsaSession,
  ofc: UsaOfc,
  appDetails: UsaAppDetails,
  dateFrom?: string,
  dateDeadline?: string,
  rescheduleYN?: boolean,
  referer?: string,
  discoveryEvents?: SlotDiscoveryEvent[]
): Promise<SlotFound | null> {
  const basePayload: Record<string, unknown> = {
    postUserId: ofc.postUserId,
    applicantId: appDetails.applicantId,
    // visaType dans les payloads slot : utiliser visaTypeKey ("NIV") si disponible, sinon visaType
    // Le portail Angular envoie visaTypekey (ex: "NIV") dans getFirstAvailableMonth/getSlotDates/getSlotTime
    visaType: (appDetails as unknown as Record<string, unknown>).visaTypeKey ?? appDetails.visaType,
    visaClass: appDetails.visaClass,
    // locationType : déterminé par le portail Angular via this.ofcOrPost.
    // Capture réseau 13/05/2026 (nouveau booking Baze, compte sabowaryan@gmail.com) :
    //   Le navigateur envoie locationType: "POST" pour Kinshasa (officeType="POST") → 200 OK.
    // Le bot envoyait "POST" aussi mais recevait 404 "applicant not found" — la différence
    // venait des COOKIES (APP_ID_TOBE/missionId) qui perturbaient la résolution côté serveur.
    // Fix : ne PAS envoyer les cookies de session pour getFirstAvailableMonth (voir hdrs ci-dessous).
    //
    // En mode reschedule, le portail utilise l'appointmentLocationType du RDV existant (ex: "POST").
    locationType: rescheduleYN
      ? (appDetails.appointmentLocationType ?? ofc.officeType ?? "POST")
      : (ofc.officeType ?? "OFC"),
    applicationId: appDetails.applicationId,
  };
  // Bundle Angular : applicationDetails.applicantUUID est inclus dans le payload de booking
  if (appDetails.applicantUUID) basePayload.applicantUUID = appDetails.applicantUUID;
  // Capture réseau 13/05/2026 : en mode reschedule, le payload NE contient PAS rescheduleYN.
  // Seuls 6 champs : postUserId, applicantId, visaType, visaClass, locationType, applicationId.
  // Le champ applicantUUID n'est PAS dans le payload de slot non plus (seulement dans le booking).

  // Referer en mode reschedule : URL dynamique avec les paramètres du RDV existant.
  // Capture réseau : /home/appointment/slot?type=POST&appUUID=xxx&applicantId=RQUP3HHVQHOD&ofcAppointmentDate=
  // En mode normal : /home/dashboard/create-appointment
  let slotReferer: string;
  if (rescheduleYN && session.appointmentUUID) {
    const locType = appDetails.appointmentLocationType ?? ofc.officeType ?? "POST";
    const appUUID = session.appointmentUUID;
    const applId = typeof appDetails.applicantId === "string" ? appDetails.applicantId : String(appDetails.applicantId);
    slotReferer = `https://www.usvisaappt.com/visaapplicantui/home/appointment/slot?type=${locType}&appUUID=${appUUID}&applicantId=${applId}&ofcAppointmentDate=`;
  } else {
    slotReferer = referer ?? REFERER_CREATE_APT;
  }

  // Capture réseau 13/05/2026 : en mode reschedule, PAS de cookies APP_ID_TOBE/missionId.
  // Le portail n'envoie que les cookies GA. Seul le Bearer token authentifie la requête.
  // IMPORTANT: Capture 13/05/2026 (nouveau booking Baze) confirme que le navigateur
  // N'ENVOIE PAS non plus APP_ID_TOBE/missionId pour un nouveau booking !
  // Le serveur retourne 404 "applicant not found" quand ces cookies sont présents
  // car ils perturbent la résolution de l'applicant côté serveur.
  // → Utiliser authHeaders (Bearer seulement) pour TOUS les modes de getFirstAvailableMonth/getSlotDates/getSlotTime.
  const hdrs = authHeaders(session.accessToken, slotReferer, true);

  /**
   * Vérifie le status HTTP et lève une erreur circuit-breaker si critique.
   * 429 → RateLimitError, 403 → AccountBlockedError,
   * 401 restricted → AccountRestrictedError, 401 autre → TokenExpiredError.
   * Retourne false si le statut est une erreur non-critique (scan de cet OFC abandonne).
   */
  async function checkSlotResponse(res: Response, endpoint: string): Promise<boolean> {
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
      const body401 = await res.text().catch(() => "");
      if (isRestrictedBody(body401)) {
        console.error(`[usa] ⛔ COMPTE RESTREINT (401) sur ${endpoint} — pause avec backoff exponentiel`);
        throw new AccountRestrictedError(undefined, undefined);
      }
      console.error(`[usa] ⛔ TOKEN EXPIRÉ (401) sur ${endpoint} — arrêt scan`);
      throw new TokenExpiredError();
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.log(`[usa] ${endpoint} HTTP ${res.status} pour OFC ${ofc.postName} — body: ${errBody.slice(0, 300)}`);
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
    if (!await checkSlotResponse(res, "getFirstAvailableMonth")) return null;
    firstMonth = await res.json() as UsaFirstAvailableMonthResponse;
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
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
    console.log(`[usa] ⏭ OFC ${ofc.postName} IGNORÉ — premier mois (${firstMonth.date}) après date limite (${dateDeadline})`);
    console.log(`[usa] 📊 [DISCOVERY] Date captée: ${firstMonth.date} | Statut: IGNORÉE | Raison: après deadline (${dateDeadline})`);
    // Enregistrer l'événement de découverte
    discoveryEvents?.push({
      applicationId: appDetails.applicationId,
      destination: "usa",
      office: ofc.postName,
      dateFound: firstMonth.date.split("T")[0],
      outcome: "ignored",
      reason: "after_deadline",
      context: { deadline: dateDeadline, firstAvailableMonth: firstMonth.date },
    });
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
    if (!await checkSlotResponse(res, "getSlotDates")) return null;
    const raw = await res.json();
    // Parsing adaptatif : le portail peut retourner deux formats selon le mode :
    //   A) Tableau d'objets : [{date: "...", slotsAvailable: N}] (nouveau booking)
    //   B) Tableau de strings ISO : ["2026-09-04T00:00:00.000+00:00", ...] (reschedule)
    // Capture réseau 13/05/2026 : format B confirmé en mode reschedule.
    if (Array.isArray(raw) && raw.length > 0) {
      if (typeof raw[0] === "string") {
        // Format B : tableau de strings ISO → convertir en UsaSlotDate[]
        slotDates = (raw as string[]).map(dateStr => ({
          date: dateStr.split("T")[0],  // "2026-09-04T00:00:00.000+00:00" → "2026-09-04"
          slotsAvailable: 1,            // au moins 1 créneau disponible (le serveur ne donne pas le compte)
        }));
        console.log(`[usa] getSlotDates: format string[] détecté (${slotDates.length} dates) — parsing adaptatif`);
      } else {
        // Format A : tableau d'objets (format historique)
        slotDates = raw as UsaSlotDate[];
      }
    } else {
      slotDates = [];
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] getSlotDates erreur: ${err}`);
    return null;
  }

  // Filtrer les dates hors fenêtre (dateFrom et dateDeadline)
  if (dateFrom || dateDeadline) {
    const before = slotDates.length;
    const ignoredDates: string[] = [];
    slotDates = slotDates.filter(d => {
      if (dateFrom && d.date < dateFrom) {
        ignoredDates.push(d.date);
        return false;
      }
      if (dateDeadline && d.date > dateDeadline) {
        ignoredDates.push(d.date);
        return false;
      }
      return true;
    });
    if (slotDates.length < before) {
      console.log(`[usa] 📊 Filtre fenêtre : ${before - slotDates.length} date(s) hors plage ignorée(s) → ${ignoredDates.join(", ")}`);
      // Enregistrer chaque date ignorée par le filtre de fenêtre
      for (const ignoredDate of ignoredDates) {
        const reason = (dateFrom && ignoredDate < dateFrom) ? "before_from_date" : "after_deadline";
        discoveryEvents?.push({
          applicationId: appDetails.applicationId,
          destination: "usa",
          office: ofc.postName,
          dateFound: ignoredDate.split("T")[0],
          outcome: "ignored",
          reason,
          context: { dateFrom, dateDeadline, window: `${fromDate} → ${toDate}` },
        });
      }
    }
  }

  if (slotDates.length === 0) {
    console.log(`[usa] Aucune date disponible pour ${ofc.postName} dans la fenêtre ${fromDate} → ${toDate}`);
    return null;
  }

  console.log(`[usa] 📆 ${slotDates.length} date(s) avec créneaux pour ${ofc.postName}: ${slotDates.slice(0, 3).map(d => d.date).join(", ")}`);
  console.log(`[usa] 📊 [DISCOVERY] ${slotDates.length} date(s) dans la fenêtre pour ${ofc.postName} — vérification horaires...`);
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
    if (!await checkSlotResponse(res, "getSlotTime")) return null;
    const raw = await res.json();
    timeSlots = Array.isArray(raw) ? raw as UsaTimeSlot[] : [];
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] getSlotTime erreur: ${err}`);
    return null;
  }

  if (timeSlots.length === 0) {
    console.log(`[usa] 📊 [DISCOVERY] Date captée: ${targetDate} | Statut: IGNORÉE | Raison: aucun horaire disponible`);
    console.log(`[usa] Aucun horaire disponible pour ${ofc.postName} le ${targetDate}`);
    discoveryEvents?.push({
      applicationId: appDetails.applicationId,
      destination: "usa",
      office: ofc.postName,
      dateFound: targetDate.split("T")[0],
      outcome: "ignored",
      reason: "no_time_slots",
      context: { dateFrom, dateDeadline },
    });
    return null;
  }

  const slot = timeSlots[0];
  const rawTime = slot.startTime ?? "";
  const time = rawTime.includes("T") ? rawTime.split("T")[1].slice(0, 5) : rawTime.slice(0, 5);

  console.log(`[usa] 🎯 CRÉNEAU TROUVÉ — ${ofc.postName} le ${targetDate} à ${time} (slotId=${slot.slotId})`);
  console.log(`[usa] 📊 [DISCOVERY] Date captée: ${targetDate} à ${time} | Statut: RETENUE pour booking | OFC: ${ofc.postName}`);
  discoveryEvents?.push({
    applicationId: appDetails.applicationId,
    destination: "usa",
    office: ofc.postName,
    dateFound: targetDate.split("T")[0],
    timeFound: time,
    outcome: "captured",
    context: { slotId: slot.slotId, totalTimeSlotsAvailable: timeSlots.length },
  });
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
 * Envoie le batch d'événements de découverte avec l'applicationId du job.
 * Les événements dans findFirstSlotForOfc utilisent le portalApplicationId,
 * mais pour Convex on a besoin du job.id (= Convex application _id).
 */
function reportSlotDiscovery_batch(events: SlotDiscoveryEvent[], jobId: string): void {
  // Overrider applicationId avec le jobId Convex (les events ont le portalApplicationId)
  const eventsWithJobId = events.map(e => ({ ...e, applicationId: jobId }));
  reportSlotDiscoveryBatch(eventsWithJobId);
}

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
  slotId: number | string;  // string alphanumérique (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
  appointmentDt: string;
  appointmentTime: string;
  postUserId: number;
  applicantId: number | string;
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
    // Bundle : appointmentLocationType = this.ofcOrPost (type du bureau sélectionné)
    // Pour Kinshasa (POST) → "POST", pour les bureaux OFC → "OFC"
    appointmentLocationType: (found.bookingBase.locationType as "OFC" | "POST") ?? "OFC",
    appointmentStatus:       "SCHEDULED",
    slotId:                  found.slot.slotId,
    appointmentDt:           slotDate,
    appointmentTime,          // format 12h AM/PM via formatUItime() = setUItime() Angular

    // ── 3 champs ajoutés par initBookSlot() ──
    postUserId:    found.bookingBase.postUserId   as number,
    applicantId:   found.bookingBase.applicantId  as number | string,
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
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
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
 * Reporter un RDV existant vers un nouveau créneau.
 * PUT /visaappointmentapi/appointments/reschedule
 *
 * Source bundle Angular : initRescheduleSlot(se) → initRescheduleAPI([se])
 *   se est identique au payload de schedule + rescheduleType = reschedProps.appointmentLocationType
 *   Le payload est envoyé en TABLEAU même pour un seul applicant.
 *
 * La valeur de appointmentId dans le payload = l'ID du RDV EXISTANT à reporter
 * (session.appointmentId, récupéré depuis /scheduledappointmentInfo ou /search).
 * rescheduleType = "POST" = type de l'appointment existant (ambassade = POST location).
 *
 * Codes d'erreur identiques à bookUsaSlot (409 = conflit, 429 = rate limit, etc.)
 */
async function rescheduleUsaSlot(
  session: UsaSession,
  found: { slot: UsaTimeSlot; bookingBase: Record<string, unknown>; date: string; time: string }
): Promise<UsaBookingResult> {
  const slotRaw = found.slot as Record<string, unknown>;
  const slotDate = slotRaw.slotDate as string | undefined ?? found.date;
  const appointmentTime = formatUItime(found.slot.startTime ?? found.time);

  // rescheduleType = type de localisation de l'appointment EXISTANT (POST = ambassade)
  // Bundle : se.rescheduleType = reschedProps.appointmentLocationType
  const rescheduleType: "POST" | "OFC" = (found.bookingBase.locationType as "POST" | "OFC") ?? "POST";

  // Payload identique au booking schedule + rescheduleType (array wrapper)
  const payload: UsaBookingPayload & { rescheduleType: "POST" | "OFC" } = {
    appointmentId:          session.appointmentId,
    applicantUUID:          session.applicantUUID,
    // Bundle : appointmentLocationType = this.ofcOrPost (type du bureau cible)
    appointmentLocationType: (found.bookingBase.locationType as "OFC" | "POST") ?? "OFC",
    appointmentStatus:       "SCHEDULED",
    slotId:                  found.slot.slotId,
    appointmentDt:           slotDate,
    appointmentTime,

    postUserId:    found.bookingBase.postUserId   as number,
    applicantId:   found.bookingBase.applicantId  as number | string,
    applicationId: found.bookingBase.applicationId as string,

    rescheduleType,
  };

  console.log(
    `[usa] ♻️ Tentative RESCHEDULE — slotId=${payload.slotId}, appointmentDt=${slotDate}, ` +
    `appointmentTime=${appointmentTime}, existingApptId=${session.appointmentId ?? "N/A"}, ` +
    `OFC postUserId=${payload.postUserId}, rescheduleType=${rescheduleType}`
  );

  try {
    const bookingHeaders = {
      ...sessionHeaders(session.accessToken, payload.applicationId, session.missionId, REFERER_MANAGE_APT),
      "CookieName":    `XSRF-TOKEN=${session.csrfToken}`,
      "X-XSRF-TOKEN":  session.csrfToken,
    };
    // Le portail envoie le payload en TABLEAU (initRescheduleAPI reçoit appointmentPayload qui est [])
    const res = await usaFetch(USA_RESCHEDULE_URL, {
      method: "PUT",
      headers: bookingHeaders,
      body: JSON.stringify([payload]),
    });

    if (res.ok) {
      let arr: UsaBookingResponse = [];
      try { arr = await res.json() as UsaBookingResponse; } catch { /* body vide */ }
      const msg = arr[0]?.responseMsg ?? "Reschedule confirmé";
      const appointmentId = arr[0]?.appointmentId;
      console.log(`[usa] ✅ RESCHEDULE RÉUSSI — "${msg}" (appointmentId=${appointmentId})`);
      return { success: true, appointmentId, responseMsg: msg };
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      throw new RateLimitError(USA_RESCHEDULE_URL, waitMs);
    }
    if (res.status === 403) throw new AccountBlockedError(USA_RESCHEDULE_URL);
    if (res.status === 401) {
      const b = await res.text().catch(() => "");
      if (isRestrictedBody(b)) throw new AccountRestrictedError(undefined, undefined);
      throw new TokenExpiredError();
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Créneau déjà pris (conflit 409)";
      console.warn(`[usa] ⚠️ Reschedule conflit 409 — ${msg}`);
      return { success: false, error: msg, statusCode: 409 };
    }
    if (res.status === 502) {
      const body = await res.json().catch(() => ({})) as { responseMsg?: string };
      const msg = body.responseMsg ?? "Erreur serveur 502";
      console.warn(`[usa] ⚠️ Reschedule serveur 502 — ${msg}`);
      return { success: false, error: msg, statusCode: 502 };
    }
    const text = await res.text();
    console.warn(`[usa] ⚠️ Reschedule échoué HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { success: false, error: `HTTP ${res.status}`, statusCode: res.status };

  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] Reschedule erreur réseau: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Télécharge la lettre de confirmation de RDV au format PDF.
 * POST /visanotificationapi/template/appointmentLetter
 *
 * Séquence Angular (capture réseau 13/05/2026) :
 *   1. POST sanityCheck(appId, "appointmentLetter")  → fire-and-forget, body vide, Content-Length: 0
 *   2. POST /template/appointmentLetter              → blob PDF
 *   3. createObjectURL(blob) + a.download            → téléchargement navigateur
 *
 * Payload réel capturé : { languageId: 1, applicationId, applicantId }
 *   - languageId: 1 (anglais)
 *   - applicationId: format court "fa68-6780-e96e-c8eb"
 *   - applicantId: format GSS string "RQUP3HHVQHOD"
 *   - PAS de missionId ni appointmentId dans le payload (contrairement à ce qu'on pensait)
 *
 * Referer réel : /visaapplicantui/home/dashboard/requests (pas create-appointment)
 * Headers : Accept: application/pdf  +  cookies missionId/APP_ID_TOBE via sessionHeaders.
 * Retourne le contenu PDF en Buffer, ou null en cas d'erreur.
 */
export async function downloadUsaConfirmationPdf(
  session: UsaSession,
  applicationId: string,
  _appointmentId?: number | string
): Promise<Buffer | null> {
  console.log(`[usa] Téléchargement confirmation PDF — applicationId=${applicationId}, applicantId=${session.applicantId ?? "n/a"}...`);

  // Étape 1 : sanityCheck avec stepType="appointmentLetter" (fire-and-forget, comme le bundle Angular)
  // Le portail l'appelle juste avant de générer la lettre, sans attendre la réponse.
  // Capture réseau : POST avec Content-Length: 0 (pas de body), Referer = dashboard/requests
  if (session.applicationId) {
    const sanityUrl = USA_SANITY_CHECK_URL(session.applicationId, "appointmentLetter");
    const sanityHeaders = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_REQUESTS, true);
    usaFetch(sanityUrl, { method: "POST", headers: sanityHeaders })
      .then(r => console.log(`[usa] sanityCheck(appointmentLetter) → HTTP ${r.status}`))
      .catch(e => console.warn("[usa] sanityCheck(appointmentLetter) ignoré:", e));
  }

  // Étape 2 : POST appointmentLetter → blob PDF
  // Payload aligné sur la capture réseau réelle (13/05/2026) :
  //   { "languageId": 1, "applicationId": "fa68-6780-e96e-c8eb", "applicantId": "RQUP3HHVQHOD" }
  // Content-Length capturé : 83 bytes — correspond exactement à ce payload.
  const letterPayload: Record<string, unknown> = {
    languageId: 1,
    applicationId,
    applicantId: session.applicantId ?? session.userID,
  };

  try {
    const res = await usaFetch(USA_CONFIRMATION_LETTER_URL, {
      method: "POST",
      // Referer = dashboard/requests (pas create-appointment) — capturé dans les logs réseau.
      // Accept: application/pdf écrase le "application/json" de sessionHeaders.
      headers: {
        ...sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_REQUESTS),
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
  try {
    if (!session.applicationId) {
      console.error("[usa] applicationId manquant dans la session — impossible de scanner");
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "applicationId manquant" });
      return "error";
    }

  // ── Sélection du flow aléatoire pour variabilité anti-détection ───────────
  const selectedFlow = selectRandomFlow();
  console.log(`[anti-detection] 🧠 Flow sélectionné pour cette session: ${selectedFlow.join(" → ")}`);
  
  // Pause initiale aléatoire
  await randomInterStepPause(300, 1500, job.id);

  // ── Anti-détection : warm-up throttlé (max 1×/8 min) ────────────────────────
  // Le portail appelle ces 3 endpoints à chaque ouverture de la page de booking.
  // Throttle à WARMUP_INTERVAL_MS pour éviter le flood : en tres_urgent (3-5 min),
  // sans throttle = 36-60 appels warm-up/heure supplémentaires → restriction account.
  const doWarmup = shouldDoWarmup(session.applicationId);
  if (doWarmup) {
    warmupLastCalledAt.set(session.applicationId, Date.now());
    console.log("[human] 🔥 Warm-up avec variabilité humaine...");

    // Simuler occasionnellement une erreur réseau (2% du temps)
    if (shouldSimulateNetworkError()) {
      console.log("[human] ⚡ Simulation d'erreur réseau pendant warm-up");
      await simulateNetworkTimeout(1500 + Math.random() * 2000);
    }

    // Exécuter le warm-up avec variabilité humaine
    await executeWithHumanVariability([
      {
        name: "Landing Page",
        execute: async () => await callLandingPage(session),
        critical: true
      },
      {
        name: "Sanity Check", 
        execute: async () => await callSanityCheck(session),
        critical: true
      },
      // NOTE: checkFcsPayment retiré du warm-up (mai 2026).
      // Le portail Angular actuel ne l'appelle plus dans le flux de booking
      // (absent des captures réseau 12-13/05/2026). L'endpoint retourne 401
      // systématiquement — probablement migré ou supprimé côté serveur.
      // Le paiement est déjà vérifié via getUserHistoryApplicantPaymentStatus
      // (pendingAppoStatus !== 0 ↔ paiement confirmé).
      {
        name: "Menu Navigation",
        execute: async () => await simulateMenuClick(session, job.id)
      },
      {
        name: "Page Refresh",
        execute: async () => await simulatePageRefresh(job.id)
      }
    ], "warm-up ", job.id);

  } else {
    const lastWarmup = warmupLastCalledAt.get(session.applicationId) ?? 0;
    const nextIn = Math.round((WARMUP_INTERVAL_MS - (Date.now() - lastWarmup)) / 60000);
    console.log(`[usa] Warm-up ignoré (prochain dans ~${nextIn} min) — économie 3 appels API`);
    
    // Même sans warm-up, ajouter un peu de variabilité
    if (Math.random() < 0.4) {
      await humanPause(500, "démarrage ", job.id);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  // 0. Récupérer d'abord getTransformData pour obtenir le bon applicantId (GSS string)
  //    Le portail Angular fait la même chose : getTransformData AVANT getApplicationDetails.
  //    Sans ça, getApplicationDetails est appelé avec userID (2720819) au lieu de "RQUP3HHVQHOD"
  //    et retourne 404 en mode cancellable/reschedule.
  let earlyTransformData: { stateCode?: string; appointmentPriority?: string; paymentStatus?: string; visaClass?: string; visaCategory?: string; visaCategoryKey?: string; applicantId?: string; visaTypeKey?: string } | null = null;
  try {
    earlyTransformData = await getUsaTransformData(session, session.applicationId);
    if (earlyTransformData) {
      if (earlyTransformData.stateCode) session.stateCode = earlyTransformData.stateCode;
      if (earlyTransformData.appointmentPriority) session.appointmentPriority = earlyTransformData.appointmentPriority;
      // Propager applicantId GSS dans la session pour que getApplicationDetails l'utilise
      if (earlyTransformData.applicantId && !session.applicantId) {
        session.applicantId = earlyTransformData.applicantId;
        console.log(`[usa] applicantId GSS depuis getTransformData (early): ${earlyTransformData.applicantId}`);
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] getTransformData early ignoré: ${err}`);
  }

  // 1. Récupérer les détails de la demande (applicantId, visaType, visaClass, appointmentId, applicantUUID)
  // ── NEW: appeler /appointments/search AVANT getApplicationDetails ──────────
  // Le vrai navigateur utilise cette API pour obtenir visaType, visaClass, applicantId, appointmentId
  // avec des valeurs fiables et plates (pas de nesting gssApplicants).
  let searchDetails: {
    visaType?: string;
    visaClass?: string;
    applicantId?: string;
    appointmentId?: number;
    appointmentLocationType?: string;
    visaCategory?: string;
  } | null = null;
  try {
    const searchPayload = {
      operation: "AND",
      searchObjects: [
        { key: "applicationId", value: session.applicationId, feildType: "STRING", operation: "EQUAL" },
      ],
    };
    const searchHeaders = authHeaders(session.accessToken, REFERER_CREATE_APT, true);
    const searchRes = await usaFetch(USA_SEARCH_URL, {
      method: "POST",
      headers: searchHeaders,
      body: JSON.stringify(searchPayload),
    });
    console.log(`[usa] /appointments/search → HTTP ${searchRes.status}`);
    if (searchRes.ok) {
      const searchRaw = await searchRes.text();
      console.log(`[usa] /appointments/search réponse: ${searchRaw.slice(0, 600)}`);
      let searchRows: Record<string, unknown>[] = [];
      try { searchRows = JSON.parse(searchRaw) as Record<string, unknown>[]; } catch { /* non-JSON */ }
      // Filter for appointmentStatus === "NEW" entries (same as Angular bundle logic)
      const newEntries = searchRows.filter(r => r.appointmentStatus === "NEW");
      const target = newEntries[0] ?? searchRows[0];
      if (target) {
        searchDetails = {
          visaType: typeof target.visaType === "string" ? target.visaType : undefined,
          visaClass: typeof target.visaClass === "string" ? target.visaClass : undefined,
          applicantId: typeof target.applicantId === "string" ? target.applicantId : undefined,
          appointmentId: typeof target.appointmentId === "number" ? target.appointmentId : undefined,
          appointmentLocationType: typeof target.appointmentLocationType === "string" ? target.appointmentLocationType : undefined,
          visaCategory: typeof target.visaCategory === "string" ? target.visaCategory : undefined,
        };
        console.log(`[usa] ✅ searchDetails: visaType=${searchDetails.visaType}, visaClass=${searchDetails.visaClass}, applicantId=${searchDetails.applicantId}, appointmentId=${searchDetails.appointmentId}, locationType=${searchDetails.appointmentLocationType}, visaCategory=${searchDetails.visaCategory}`);
        // Propagate applicantId GSS into session early
        if (searchDetails.applicantId && !session.applicantId) {
          session.applicantId = searchDetails.applicantId;
          console.log(`[usa] applicantId GSS depuis /appointments/search: ${searchDetails.applicantId}`);
        }
      }
    } else {
      console.warn(`[usa] /appointments/search HTTP ${searchRes.status} — will fallback to getApplicationDetails`);
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError || err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[usa] /appointments/search ignoré: ${err}`);
  }

  // Fallback: getApplicationDetails (may return nested gssApplicants format with undefined fields)
  const appDetails = await getUsaApplicationDetails(session, session.applicationId);
  if (!appDetails) {
    console.warn("[usa] getApplicationDetails échoué — tentative avec userID comme applicantId");
  }

  let effectiveDetails: UsaAppDetails = appDetails ?? {
    // Préférer session.applicantId (GSS string comme "ODXJKHXJQMZH") si disponible,
    // sinon fallback sur session.userID (number du login).
    applicantId: session.applicantId ?? session.userID,
    applicationId: session.applicationId,
    // FALLBACK UNIQUEMENT si getApplicationDetails échoue.
    // Ces valeurs seront TOUJOURS écrasées par getTransformData (appelé dans le flow OFC).
    // Si les deux APIs échouent, ces défauts permettent quand même de tenter un scan.
    // NOTE: "NIV" = Non-Immigrant Visa. Pour les Immigrant Visas (IV), getTransformData
    // retournera la bonne valeur (ex: visaTypekey="IV", visaClass="IR1", visaCategory="ImmigrantVisas").
    // Le bot ne code JAMAIS le type de visa en dur pour le booking — il vient toujours de l'API.
    visaType: earlyTransformData?.visaCategory ?? "NIV",
    visaClass: earlyTransformData?.visaClass ?? "B1/B2",
    visaCategory: earlyTransformData?.visaCategoryKey ?? "VisitorVisas",
    locationType: "OFC",
  };

  // ── Override effectiveDetails with searchDetails (priority: search > appDetails > defaults) ──
  if (searchDetails) {
    if (searchDetails.visaType) {
      effectiveDetails.visaType = searchDetails.visaType;
      effectiveDetails.visaTypeKey = searchDetails.visaType;
    }
    if (searchDetails.visaClass) effectiveDetails.visaClass = searchDetails.visaClass;
    if (searchDetails.applicantId) effectiveDetails.applicantId = searchDetails.applicantId;
    if (searchDetails.appointmentId !== undefined) effectiveDetails.appointmentId = searchDetails.appointmentId;
    if (searchDetails.appointmentLocationType) effectiveDetails.appointmentLocationType = searchDetails.appointmentLocationType;
    if (searchDetails.visaCategory) effectiveDetails.visaCategory = searchDetails.visaCategory;
    // Set locationType from search's appointmentLocationType for slot payloads
    if (searchDetails.appointmentLocationType) effectiveDetails.locationType = searchDetails.appointmentLocationType;
    console.log(`[usa] effectiveDetails enrichi depuis /appointments/search: visaType=${effectiveDetails.visaType}, visaClass=${effectiveDetails.visaClass}, applicantId=${effectiveDetails.applicantId}, locationType=${effectiveDetails.locationType}`);
  }

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

  // ── Exécution du flow aléatoire ───────────────────────────────────────────
  // Suivre la séquence définie par selectedFlow pour varier les patterns
  console.log(`[anti-detection] 🚀 Début exécution du flow: ${selectedFlow.join(" → ")}`);
  
  // Variables pour stocker les résultats des étapes
  let transformDataResult: any = earlyTransformData;
  let ofcListResult: UsaOfc[] = [];
  let scanResult: SessionResult = "not_found";
  
  // Exécuter chaque étape du flow avec pauses aléatoires
  for (const step of selectedFlow) {
    console.log(`[anti-detection] Étape: ${step}`);
    
    try {
      switch (step) {
        case "login":
          // Déjà fait avant cette fonction
          await randomInterStepPause(300, 1200, job.id);
          break;
          
        case "status":
          // Déjà fait avant cette fonction
          await randomInterStepPause(300, 1200, job.id);
          break;
          
        case "warmup":
          // Warm-up déjà géré au début de la fonction
          await randomInterStepPause(500, 1500, job.id);
          break;
          
        case "noise":
          // Envoyer des requêtes bruit anti-détection
          await sendAntiDetectionNoise(session, job.id);
          await randomInterStepPause(800, 2000, job.id);
          break;
          
        case "ofc":
          // Récupérer la liste des OFCs
          if (!transformDataResult && session.applicationId) {
            // Essayer d'abord getTransformData si pas encore fait
            try {
              transformDataResult = await getUsaTransformData(session, session.applicationId);
              if (transformDataResult) {
                if (transformDataResult.stateCode) session.stateCode = transformDataResult.stateCode;
                if (transformDataResult.appointmentPriority) session.appointmentPriority = transformDataResult.appointmentPriority;
                // Enrichir effectiveDetails si getApplicationDetails avait échoué (cas cancellable/reschedule)
                if (transformDataResult.visaClass && effectiveDetails.visaClass === "B1/B2") {
                  console.log(`[usa] visaClass enrichi depuis getTransformData: ${transformDataResult.visaClass} (remplace défaut "B1/B2")`);
                  effectiveDetails.visaClass = transformDataResult.visaClass;
                }
                if (transformDataResult.visaCategory && (!effectiveDetails.visaType || effectiveDetails.visaType === "NIV" || effectiveDetails.visaType.includes(" "))) {
                  // Le portail Angular envoie visaTypekey (ex: "NIV") dans les payloads slot, PAS le label
                  // long comme "Non-immigrant Visa". getTransformData retourne le bon code court.
                  console.log(`[usa] visaType/Category enrichi depuis getTransformData: ${transformDataResult.visaCategory} (remplace "${effectiveDetails.visaType}")`);
                  effectiveDetails.visaType = transformDataResult.visaCategory;
                }
                if (transformDataResult.applicantId && (effectiveDetails.applicantId === session.userID || effectiveDetails.applicantId === (session.applicantId ?? session.userID))) {
                  console.log(`[usa] applicantId enrichi depuis getTransformData: ${transformDataResult.applicantId} (remplace ${effectiveDetails.applicantId})`);
                  effectiveDetails.applicantId = transformDataResult.applicantId;
                }
              }
            } catch (err) {
              console.warn(`[usa] getTransformData ignoré avant OFC list: ${err}`);
            }
          }
          
          // Utiliser les données de getTransformData en priorité (plus fiables que getApplicationDetails
          // pour les cas cancellable/reschedule où appointmentStatus n'est plus "NEW")
          const ofcVisaClass = transformDataResult?.visaClass ?? effectiveDetails.visaClass;
          // visaCategory pour l'URL getpost — DOIT être le code clé (ex: "StudentsandExchangeVisitors")
          // PAS le label humain (ex: "Students and Exchange Visitors") qui retourne 404.
          // Priorité : visaCategorykey > visaCategoryCode (effectiveDetails) > fallback strip espaces
          const ofcVisaCategory = transformDataResult?.visaCategoryKey ?? effectiveDetails.visaCategory ?? effectiveDetails.visaType;

          // Bundle : appointmentPriority "group" + reschedule → "regular" (bot = pas de reschedule donc on envoie tel quel)
          const ofcPriority = session.appointmentPriority;
          ofcListResult = await getUsaOfcList(
            session,
            session.missionId,
            ofcVisaClass,
            ofcVisaCategory,
            session.stateCode,
            ofcPriority,
          );
          
          botLog({
            applicationId: job.id,
            step: "ofc_list",
            status: "ok",
            data: {
              flow: "usa",
              count: ofcListResult.length,
              offices: ofcListResult.map((o) => ({ name: o.postName, postUserId: o.postUserId })),
              visaClass: effectiveDetails.visaClass,
              visaType: effectiveDetails.visaType,
            },
          });
          
          if (ofcListResult.length === 0) {
            console.warn("[usa] Aucun OFC trouvé — vérifier missionId ou droits d'accès");
            botLog({ applicationId: job.id, step: "ofc_list", status: "warn", data: { flow: "usa", count: 0, missionId: session.missionId } });
            await sendHeartbeat({
              applicationId: job.id,
              result: "not_found",
              errorMessage: `Aucun OFC disponible pour mission ${session.missionId}`,
            });
            return "not_found";
          }
          
          await randomInterStepPause(1000, 2500, job.id);
          break;
          
        case "dates":
          // Cette étape est intégrée dans le scan des OFCs
          // Juste une pause pour simuler la navigation
          await randomInterStepPause(800, 1800, job.id);
          break;
          
        case "times":
          // Cette étape est intégrée dans le scan des OFCs  
          // Juste une pause pour simuler la navigation
          await randomInterStepPause(800, 1800, job.id);
          break;
          
        case "transform":
          // getTransformData
          if (session.applicationId) {
            try {
              transformDataResult = await getUsaTransformData(session, session.applicationId);
              if (transformDataResult) {
                if (transformDataResult.stateCode) session.stateCode = transformDataResult.stateCode;
                if (transformDataResult.appointmentPriority) session.appointmentPriority = transformDataResult.appointmentPriority;
                
                // Enrichir effectiveDetails
                if (transformDataResult.visaClass && effectiveDetails.visaClass === "B1/B2") {
                  console.log(`[usa] visaClass enrichi depuis getTransformData: ${transformDataResult.visaClass} (remplace défaut "B1/B2")`);
                  effectiveDetails.visaClass = transformDataResult.visaClass;
                }
                if (transformDataResult.visaCategory && (!effectiveDetails.visaType || effectiveDetails.visaType === "NIV" || effectiveDetails.visaType.includes(" "))) {
                  // Le portail Angular envoie visaTypekey (ex: "NIV") dans les payloads slot, PAS le label
                  // long comme "Non-immigrant Visa". getTransformData retourne le bon code court.
                  console.log(`[usa] visaType/Category enrichi depuis getTransformData: ${transformDataResult.visaCategory} (remplace "${effectiveDetails.visaType}")`);
                  effectiveDetails.visaType = transformDataResult.visaCategory;
                }
                if (transformDataResult.applicantId && (effectiveDetails.applicantId === session.userID || effectiveDetails.applicantId === (session.applicantId ?? session.userID))) {
                  console.log(`[usa] applicantId enrichi depuis getTransformData: ${transformDataResult.applicantId} (remplace ${effectiveDetails.applicantId})`);
                  effectiveDetails.applicantId = transformDataResult.applicantId;
                }
              }
            } catch (err) {
              console.warn(`[usa] getTransformData ignoré: ${err}`);
            }
          }
          await randomInterStepPause(600, 1500, job.id);
          break;
          
        default:
          // This should never happen, but TypeScript wants us to handle all cases
          console.warn(`[usa] Étape inattendue dans le flow: ${step}`);
          await randomInterStepPause(300, 1000, job.id);
          break;
      }
      
      // Pause entre les étapes
      if (Math.random() < 0.3) {
        await randomInterStepPause(300, 1000, job.id);
      }
      
    } catch (err) {
      // Gestion des erreurs circuit-breaker
      if (err instanceof RateLimitError) {
        const waitSec = Math.round((err.retryAfterMs ?? 60000) / 1000);
        console.error(`[usa] ⛔ RATE LIMIT détecté — scan interrompu (retry-after: ${waitSec}s)`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "rate_limit", endpoint: step, retryAfterMs: err.retryAfterMs, waitSec } });
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `Rate limit (429) — ${err.message}. Reprendre dans ~${waitSec}s.`,
        });
        return "error";
      }
      if (err instanceof AccountBlockedError) {
        console.error(`[usa] ⛔ COMPTE POTENTIELLEMENT BLOQUÉ — ${err.message}`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "blocked", endpoint: step, error: (err as Error).message } });
        const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
        if (cacheKey) tokenCache.delete(cacheKey);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `Compte bloqué (403) — ${err.message}`,
        });
        return "error";
      }
      if (err instanceof AccountRestrictedError) {
        const username = job.hunterConfig.embassyUsername ?? "";
        if (username) markAccountRestricted(username, err.retryAfterMs, err.retryAfterHeader);
        console.warn(`[usa] 🔒 Compte restreint — pause avec backoff exponentiel (cache préservé)`);
        botLog({ applicationId: job.id, step: "error", status: "warn", data: { flow: "usa", phase: "restricted", error: err.message } });
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
          errorMessage: `Compte restreint — cycles ignorés ~60 min`,
        });
        return "not_found";
      }
      if (err instanceof TokenExpiredError) {
        console.error(`[usa] ⛔ TOKEN EXPIRÉ — arrêt, reconnexion au prochain cycle`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "token_expired", error: "Token JWT expiré" } });
        const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
        if (cacheKey) tokenCache.delete(cacheKey);
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: "Token JWT expiré — reconnexion requise",
        });
        return "error";
      }
      
      // Erreur non-critique, continuer avec l'étape suivante
      console.warn(`[usa] Erreur non-critique à l'étape ${step}: ${err}`);
    }
  }
  
  // Si ofcList n'a pas été récupérée dans le flow, la récupérer maintenant
  if (ofcListResult.length === 0 && session.applicationId) {
    try {
      const ofcPriority = session.appointmentPriority;
      // Utiliser visaCategoryKey (code) en priorité pour éviter le 404 avec le label humain
      const fallbackVisaCategory = transformDataResult?.visaCategoryKey ?? effectiveDetails.visaCategory ?? effectiveDetails.visaType;
      ofcListResult = await getUsaOfcList(
        session,
        session.missionId,
        effectiveDetails.visaClass,
        fallbackVisaCategory,
        session.stateCode,
        ofcPriority,
      );
    } catch (err) {
      console.error(`[usa] Impossible de récupérer OFC list: ${err}`);
      return "error";
    }
  }
  
  if (ofcListResult.length === 0) {
    console.warn("[usa] Aucun OFC trouvé après exécution du flow");
    return "not_found";
  }

  // Utiliser la liste des OFCs récupérée
  const ofcList = ofcListResult;

  // Fenêtre de réservation définie par l'admin (optionnel)
  const slotDateFrom = job.hunterConfig.slotDateFrom;
  let slotDateDeadline = job.hunterConfig.slotDateDeadline;
  const rescheduleMode = job.hunterConfig.rescheduleMode;
  const rescheduleExistingDate = job.hunterConfig.rescheduleExistingDate;

  // Mode reporter : forcer dateDeadline à la veille du RDV existant
  if (rescheduleMode && rescheduleExistingDate) {
    const existingDateObj = new Date(rescheduleExistingDate + "T12:00:00");
    existingDateObj.setDate(existingDateObj.getDate() - 1);
    const computedDeadline = toYMD(existingDateObj);
    // Prendre la plus restrictive des deux deadlines
    if (!slotDateDeadline || computedDeadline < slotDateDeadline) {
      slotDateDeadline = computedDeadline;
    }
    console.log(`[usa] ♻️ Mode reporter : deadline forcée à ${slotDateDeadline} (veille du RDV existant ${rescheduleExistingDate})`);
    // Bundle : rescheduleYN && appointmentPriority==="group" → "regular"
    if (session.appointmentPriority === "group") {
      console.log(`[usa] ♻️ Mode reporter : appointmentPriority "group" → "regular"`);
      session.appointmentPriority = "regular";
    }
  }

  if (slotDateFrom || slotDateDeadline) {
    console.log(`[usa] 📅 Fenêtre admin : ${slotDateFrom ?? "illimitée"} → ${slotDateDeadline ?? "illimitée"}`);
  }

  // 3. Scanner les OFCs en round-robin (1 OFC par cycle) pour réduire le nombre
  //    d'appels API par cycle. Avec N OFCs, chaque OFC est vérifiée toutes les N×(3-5) min
  //    au lieu de scanner toutes les N à chaque cycle (économie : (N-1)×3 appels/cycle).
  //    Accepté car les créneaux n'apparaissent pas à la seconde — 10-15 min de latence OK.
  const cursorKey = session.applicationId;
  const cursor = ofcCursor.get(cursorKey) ?? 0;
  const ofcToScan = ofcList.length > 1
    ? [ofcList[cursor % ofcList.length]]
    : ofcList;
  ofcCursor.set(cursorKey, (cursor + 1) % ofcList.length);
  if (ofcList.length > 1) {
    console.log(`[usa] 🔄 Round-robin OFC : scanning ${ofcToScan[0].postName} (${cursor % ofcList.length + 1}/${ofcList.length})`);
  }

  // Collecteur d'événements de découverte de dates (pour stats et analyse de fréquence)
  const scanDiscoveryEvents: SlotDiscoveryEvent[] = [];

  try {
    for (const ofc of ofcToScan) {
      console.log(`[usa] Scan OFC: ${ofc.postName} (postUserId=${ofc.postUserId})`);
      botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "ofc_scanning", ofc: ofc.postName } });
      // Délai humain entre OFCs — un vrai utilisateur prend 1.5-4s pour passer d'un bureau à l'autre
      await randomDelay(1500, 4000);

      let found: SlotFound | null;
      try {
        found = await findFirstSlotForOfc(
          session, ofc, effectiveDetails, slotDateFrom, slotDateDeadline,
          rescheduleMode,
          rescheduleMode ? REFERER_MANAGE_APT : undefined,
          scanDiscoveryEvents
        );
      } catch (err) {
        // Gestion des erreurs pour findFirstSlotForOfc
        if (err instanceof RateLimitError) {
          const waitSec = Math.round((err.retryAfterMs ?? 60000) / 1000);
          console.error(`[usa] ⛔ RATE LIMIT détecté — scan interrompu (retry-after: ${waitSec}s)`);
          botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "rate_limit", endpoint: `findFirstSlotForOfc/${ofc.postName}`, retryAfterMs: err.retryAfterMs, waitSec } });
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Rate limit (429) — ${err.message}. Reprendre dans ~${waitSec}s.`,
          });
          return "error";
        }
        if (err instanceof AccountBlockedError) {
          console.error(`[usa] ⛔ COMPTE POTENTIELLEMENT BLOQUÉ — ${err.message}`);
          botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "blocked", endpoint: `findFirstSlotForOfc/${ofc.postName}`, error: (err as Error).message } });
          const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
          if (cacheKey) tokenCache.delete(cacheKey);
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Compte bloqué (403) — ${err.message}`,
          });
          return "error";
        }
        if (err instanceof AccountRestrictedError) {
          const username = job.hunterConfig.embassyUsername ?? "";
          if (username) markAccountRestricted(username, err.retryAfterMs, err.retryAfterHeader);
          console.warn(`[usa] 🔒 Compte restreint pendant le scan OFC ${ofc.postName} — pause avec backoff exponentiel (cache préservé)`);
          botLog({ applicationId: job.id, step: "error", status: "warn", data: { flow: "usa", phase: "restricted", ofc: ofc.postName, error: err.message } });
          await sendHeartbeat({
            applicationId: job.id,
            result: "not_found",
            errorMessage: `Compte restreint — cycles ignorés ~60 min`,
          });
          return "not_found";
        }
        if (err instanceof TokenExpiredError) {
          console.error(`[usa] ⛔ TOKEN EXPIRÉ en cours de scan — arrêt, reconnexion au prochain cycle`);
          botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "token_expired", error: "Token JWT expiré", ofc: ofc.postName } });
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
        const unexpectedMsg = err instanceof Error ? err.message : String(err);
        console.error(`[usa] Erreur inattendue sur OFC ${ofc.postName}: ${err}`);
        botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "scan", ofc: ofc.postName, error: unexpectedMsg.slice(0, 300) } });
        continue;
      }
      
      if (found) {
        botLog({
          applicationId: job.id,
          step: "slots_found",
          status: "ok",
          data: {
            flow: "usa",
            phase: "scan",
            ofc: found.ofcName,
            date: found.date,
            time: found.time,
            slotId: found.slotId,
          },
        });

        // Le booking et le téléchargement du PDF sont dans un try/catch séparé :
        // les erreurs circuit-breaker (RateLimit, Blocked, TokenExpired) doivent
        // stopper le scan et déclencher un heartbeat d'alerte, pas crasher silencieusement.
        let booking: UsaBookingResult;
        botLog({
          applicationId: job.id,
          step: "booking_attempt",
          status: "ok",
          data: { flow: "usa", ofc: found.ofcName, date: found.date, time: found.time, slotId: found.slotId },
        });
        try {
          // ── 1. Booking ou Reschedule automatique ─────────────
          // En mode reschedule (cancellable ou scheduled+rescheduleMode), le portail Angular
          // utilise PUT /appointments/reschedule au lieu de PUT /appointments/schedule.
          // Les deux cas (cancellable et scheduled+rescheduleMode) aboutissent au même
          // endpoint avec le même payload + rescheduleType:"POST".
          const useReschedule = rescheduleMode || session.isReschedule === true;

          booking = useReschedule
            ? await rescheduleUsaSlot(session, found)
            : await bookUsaSlot(session, found);
        } catch (bookErr) {
          if (bookErr instanceof RateLimitError) {
            const waitSec = Math.round((bookErr.retryAfterMs ?? 60000) / 1000);
            console.error(`[usa] ⛔ RATE LIMIT lors du booking — scan interrompu (retry: ${waitSec}s)`);
            botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "rate_limit", endpoint: "booking", retryAfterMs: bookErr.retryAfterMs, waitSec } });
            await sendHeartbeat({
              applicationId: job.id,
              result: "error",
              errorMessage: `Rate limit (429) lors du booking — ${bookErr.message}. Reprendre dans ~${waitSec}s.`,
            });
            return "error";
          }
          if (bookErr instanceof AccountBlockedError) {
            console.error(`[usa] ⛔ COMPTE BLOQUÉ lors du booking — ${bookErr.message}`);
            botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "blocked", endpoint: "booking", error: (bookErr as Error).message } });
            const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
            if (cacheKey) tokenCache.delete(cacheKey);
            await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Compte bloqué (403) lors du booking` });
            return "error";
          }
          if (bookErr instanceof AccountRestrictedError) {
            const username = job.hunterConfig.embassyUsername ?? "";
            if (username) markAccountRestricted(username, bookErr.retryAfterMs, bookErr.retryAfterHeader);
            console.warn(`[usa] 🔒 Compte restreint lors du booking — pause avec backoff exponentiel (cache préservé)`);
            botLog({ applicationId: job.id, step: "error", status: "warn", data: { flow: "usa", phase: "restricted", error: "Compte restreint lors du booking" } });
            await sendHeartbeat({ applicationId: job.id, result: "not_found", errorMessage: `Compte restreint lors du booking — pause 60 min` });
            return "not_found";
          }
          if (bookErr instanceof TokenExpiredError) {
            console.error(`[usa] ⛔ TOKEN EXPIRÉ lors du booking — reconnexion au prochain cycle`);
            botLog({ applicationId: job.id, step: "error", status: "fail", data: { flow: "usa", phase: "token_expired", error: "Token JWT expiré lors du booking" } });
            const cacheKey = job.hunterConfig.embassyUsername?.toLowerCase() ?? "";
            if (cacheKey) tokenCache.delete(cacheKey);
            await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Token JWT expiré lors du booking` });
            return "error";
          }
          // Erreur réseau inattendue — traiter comme booking échoué et continuer
          const msg = bookErr instanceof Error ? bookErr.message : String(bookErr);
          console.error(`[usa] Erreur inattendue lors du booking: ${msg}`);
          botLog({ applicationId: job.id, step: "booking_fail", status: "fail", data: { flow: "usa", error: msg.slice(0, 300), ofc: found.ofcName, date: found.date } });
          booking = { success: false, error: msg };
        }

        await randomDelay(1000, 2000);

        // 409 = créneau pris en concurrence AVANT notre booking.
        // Ne pas signaler le slot comme trouvé (on ne l'a pas obtenu) — scanner le prochain OFC.
        if (!booking.success && booking.statusCode === 409) {
          console.log("[usa] Conflit 409 — le créneau a été pris avant nous. Poursuite du scan...");
          botLog({ applicationId: job.id, step: "booking_fail", status: "warn", data: { flow: "usa", reason: "Conflit 409 — créneau pris par un autre utilisateur", ofc: found.ofcName, date: found.date } });
          continue;
        }

        // Tout autre échec de booking (502, erreur réseau, réponse inattendue) :
        // NE PAS reporter slot_found — ce serait un faux positif. Reporter une erreur et arrêter.
        if (!booking.success) {
          const errMsg = `Booking échoué (HTTP ${booking.statusCode ?? "err"}) sur ${found.ofcName} — ${booking.error}. Créneau NON confirmé.`;
          console.error(`[usa] ❌ ${errMsg}`);
          botLog({
            applicationId: job.id,
            step: "booking_fail",
            status: "fail",
            data: { flow: "usa", ofc: found.ofcName, date: found.date, time: found.time, slotId: found.slotId, statusCode: booking.statusCode, error: booking.error },
          });
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: errMsg,
          });
          return "error";
        }

        // ── 2. Télécharger le PDF de confirmation ───────────────
        // Uniquement si le booking a réussi : le portail ne génère la lettre que sur un RDV confirmé.
        let pdfStorageId: string | undefined;
        botLog({
          applicationId: job.id,
          step: "booking_success",
          status: "ok",
          data: {
            flow: "usa",
            ofc: found.ofcName,
            date: found.date,
            time: found.time,
            appointmentId: booking.appointmentId,
            responseMsg: booking.responseMsg,
          },
        });
        const pdf = await downloadUsaConfirmationPdf(session, session.applicationId, booking.appointmentId);
        if (pdf) {
          console.log(`[usa] 📄 Confirmation PDF (${pdf.length} bytes) — upload vers Convex...`);
          const b64 = pdf.toString("base64");
          pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
          if (pdfStorageId) {
            console.log(`[usa] ✅ PDF uploadé → storageId: ${pdfStorageId}`);
            botLog({
              applicationId: job.id,
              step: "confirmation_letter",
              status: "ok",
              data: { flow: "usa", pdfSizeBytes: pdf.length, storageId: pdfStorageId, appointmentId: booking.appointmentId },
            });
          }
        }

        // ── 3. Rapport vers Convex — booking réellement confirmé ──
        await reportSlotFound({
          applicationId: job.id,
          date: found.date,
          time: found.time,
          location: `${found.ofcName} — Ambassade USA (slotId=${found.slotId}, appointmentId=${booking.appointmentId})`,
          confirmationCode: booking.appointmentId?.toString(),
          screenshotStorageId: pdfStorageId,
        });

        return "slot_found";
      }
      // Aucun créneau pour cette OFC lors de ce cycle
      botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "ofc_no_slot", ofc: ofc.postName } });
    }
  } catch (error) {
    // Catch any unexpected errors in the OFC scanning try block
    console.error(`[usa] Erreur inattendue dans le scan OFC:`, error);
    await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: `Erreur inattendue: ${error instanceof Error ? error.message : String(error)}` });
    return "error";
  }

  console.log(`[usa] Aucun créneau disponible sur ${ofcList.length} OFC(s)`);

  // ── Résumé des découvertes de dates pour ce cycle ──
  if (scanDiscoveryEvents.length > 0) {
    const captured = scanDiscoveryEvents.filter(e => e.outcome === "captured").length;
    const ignored = scanDiscoveryEvents.filter(e => e.outcome === "ignored").length;
    const reasons = scanDiscoveryEvents
      .filter(e => e.outcome === "ignored")
      .reduce<Record<string, number>>((acc, e) => {
        acc[e.reason ?? "unknown"] = (acc[e.reason ?? "unknown"] ?? 0) + 1;
        return acc;
      }, {});
    const reasonStr = Object.entries(reasons).map(([r, n]) => `${r}:${n}`).join(", ");
    console.log(`[usa] 📊 [SCAN STATS] Dates découvertes: ${scanDiscoveryEvents.length} | Retenues: ${captured} | Ignorées: ${ignored} (${reasonStr})`);
    // Envoyer le batch vers Convex pour analyse de fréquence
    reportSlotDiscovery_batch(scanDiscoveryEvents, job.id);
  } else {
    console.log(`[usa] 📊 [SCAN STATS] Aucune date découverte sur ce cycle (portail vide ou erreur API)`);
  }

  botLog({ applicationId: job.id, step: "not_found", status: "warn", data: { flow: "usa", ofcCount: ofcList.length, offices: ofcList.map((o) => o.postName), discoveryCount: scanDiscoveryEvents.length, discoveredIgnored: scanDiscoveryEvents.filter(e => e.outcome === "ignored").length } });
  await sendHeartbeat({ applicationId: job.id, result: "not_found" });
  return "not_found";
  } catch (error) {
    // Check if this is the FCS payment check failed error
    if (error instanceof Error && error.message === "FCS payment check failed") {
      console.warn("[usa] FCS payment check failed — paiement non confirmé");
      return "payment_required";
    }
    
    console.error(`[usa] Erreur inattendue dans scanUsaSlotsViaAPI:`, error);
    await sendHeartbeat({ 
      applicationId: job.id, 
      result: "error", 
      errorMessage: `Erreur inattendue: ${error instanceof Error ? error.message : String(error)}` 
    });
    return "error";
  }
}