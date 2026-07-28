/**
 * spain-http-booking.ts — Booking HTTP-only pour créneaux Espagne (sans Playwright)
 *
 * FLOW COMPLET (reverse-engineered depuis le bundle Bookitit citaconsular) :
 *   1. Extraire serviceId depuis le HTML rendu quand "found"
 *   2. Vérifier getwidgetconfigurations/ → captcha=0 (Kinshasa) → gct vide
 *                                        → captcha=1 (LMD/Cuba) → résoudre hCaptcha
 *   3. JSONP signin/ (login + password + gct + date/time/service[]/agenda[]) → bktToken
 *   4. Si validate requis → JSONP confirmclient/ (bktToken + OTP code)
 *   5. JSONP summary/ (bktToken + all params) → locator (code confirmation)
 *
 * PRÉREQUIS :
 *   - Session CF active (ensureSpainCfSession déjà fait par le scanner)
 *   - Credentials Bookitit (passport number + password pour Kinshasa)
 *   - CAPSOLVER_API_KEY uniquement si captcha=1 sur le widget
 *   - OTP flow configuré (email/SMS via Convex)
 *
 * PARAMÈTRES CONFIRMÉS par capture réelle 2026-07-28 (citaconsular.es) :
 *   - logintype=document (passport), pas "email"
 *   - services[]=bktXXX (PHP array notation, pas "services=")
 *   - agendas[]=bktXXX  (idem)
 *   - start/end pour datetime (pas date_from/date_to)
 *   - type, version, src, srvsrc requis sur chaque appel
 *   - gct vide si captcha=0 (Kinshasa), hCaptcha token si captcha=1
 */

import {
  spainCfFetch,
  cloneSpainCfSessionForDossier,
  type SpainCfSession,
} from "./spain-soax-solver.js";
import {
  requestOtpChallenge,
  consumeOtpCode,
  reportSpainWatcherScan,
} from "./convexClient.js";
import { matchServiceForVisa } from "./spain-service-mapping.js";
import { generateSpainConfirmationPdf, extractConfirmationData } from "./spain-confirmation-pdf.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpainBookingConfig {
  /** Email/login Bookitit */
  login: string;
  /** Mot de passe Bookitit */
  password: string;
  /** Application ID Convex (pour OTP + reporting) */
  applicationId?: string;
  /** Canal OTP : email, sms, ou manual */
  otpChannel?: "email" | "sms" | "manual";
  /** Si true, utilise signup au lieu de signin */
  useSignup?: boolean;
  /** Nom complet du demandeur (pour signupfirstappointment et logs) */
  applicantName?: string;
  /** Email du demandeur (requis pour signupfirstappointment/) */
  applicantEmail?: string;
  /** Service cible spécifique (si fourni, bypass l'auto-sélection) */
  targetServiceId?: string;
  /** Type de visa du dossier (pour le matching service, ex: "Visa C — Tourisme / Affaires") */
  visaType?: string;
  /** Services déjà obtenus via getservices/ (main/ ne contient que les templates). */
  availableServices?: ExtractedSlotInfo[];
}

export interface SpainBookingResult {
  status: "booked" | "otp_timeout" | "turnstile_failed" | "signin_failed" | "booking_failed" | "no_slots";
  locator?: string;
  errorMessage?: string;
  durationMs: number;
  /** PDF de confirmation généré (Buffer base64-ready) — présent uniquement si status="booked" */
  confirmationPdf?: Buffer;
}

export interface ExtractedSlotInfo {
  serviceId: string;
  serviceName: string;
  agendaId?: string;
  date?: string;
  time?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CAPSOLVER_BASE = "https://api.capsolver.com";
// Sitekey hCaptcha de citaconsular.es (widgets avec captcha=1, ex: LMD/Cuba)
// Confirmé par capture réseau 2026-07-28 (modal Aceptar Cuba → hcaptcha iframe)
const HCAPTCHA_SITEKEY = "38663b6a-85dc-4346-965e-f066cd8e7d26";

// ─── Captcha Solver ─────────────────────────────────────────────────────────

/**
 * Résout hCaptcha via CapSolver HCaptchaTaskProxyLess.
 * Utilisé uniquement quand getwidgetconfigurations/ retourne captcha != "0".
 * Pour Kinshasa (captcha=0) : ne pas appeler, passer gct="" directement.
 *
 * CONFIRMATION capture 2026-07-28 :
 *   - Kinshasa widget : captcha="0" → gct absent du signin
 *   - LMD/Cuba widget : hCaptcha présent → gct=P1_eyJ... (token hCaptcha)
 */
async function solveHCaptcha(
  pageUrl: string,
  sitekey: string = HCAPTCHA_SITEKEY,
): Promise<string | null> {
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  if (!capsolverKey) {
    console.error("[spain-booking] ❌ CAPSOLVER_API_KEY manquante pour hCaptcha");
    return null;
  }

  const t0 = Date.now();
  console.log(`[spain-booking] 🔐 Solving hCaptcha (sitekey: ${sitekey.slice(0, 20)}…)`);

  try {
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: capsolverKey,
        task: {
          type: "HCaptchaTaskProxyLess",
          websiteURL: pageUrl,
          websiteKey: sitekey,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const createData = (await createRes.json()) as { errorId: number; taskId?: string; errorDescription?: string };
    if (createData.errorId !== 0 || !createData.taskId) {
      console.error(`[spain-booking] ❌ hCaptcha createTask failed: ${createData.errorDescription}`);
      return null;
    }

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3_000));

      const resultRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: capsolverKey, taskId: createData.taskId }),
        signal: AbortSignal.timeout(10_000),
      });

      const resultData = (await resultRes.json()) as {
        status: "processing" | "ready" | "failed";
        solution?: { gRecaptchaResponse: string };
        errorDescription?: string;
      };

      if (resultData.status === "ready" && resultData.solution?.gRecaptchaResponse) {
        const elapsed = Math.round((Date.now() - t0) / 1000);
        console.log(`[spain-booking] ✅ hCaptcha résolu (${elapsed}s)`);
        return resultData.solution.gRecaptchaResponse;
      }

      if (resultData.status === "failed") {
        console.error(`[spain-booking] ❌ hCaptcha failed: ${resultData.errorDescription}`);
        return null;
      }
    }

    console.error(`[spain-booking] ❌ hCaptcha timeout (90s)`);
    return null;
  } catch (err) {
    console.error(`[spain-booking] ❌ hCaptcha error: ${err}`);
    return null;
  }
}

// ─── JSONP Caller ───────────────────────────────────────────────────────────

function parseJsonpResponse(text: string): unknown | null {
  const src = text.trim();
  if (!src) return null;
  const m = src.match(/^[\w$.]+\(([\s\S]*)\);?$/);
  if (!m) {
    try { return JSON.parse(src); } catch { return null; }
  }
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

async function callBookititEndpoint(
  session: SpainCfSession,
  endpoint: string,
  params: Record<string, string>,
  portalUrl: string,
): Promise<unknown | null> {
  const baseUrl = "https://www.citaconsular.es/onlinebookings/";
  const q = new URLSearchParams(params);
  q.set("callback", `cb${Date.now()}${Math.floor(Math.random() * 10000)}`);
  q.set("_", String(Date.now()));
  const url = `${baseUrl}${endpoint}?${q.toString()}`;

  const res = await spainCfFetch(url, session, {
    headers: {
      "Referer": portalUrl,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  });

  if (!res) return null;
  if (!res.ok) {
    console.warn(`[spain-booking] ${endpoint} returned ${res.status}`);
    return null;
  }

  const body = await res.text();
  return parseJsonpResponse(body);
}

function buildBookingCookieHeader(session: SpainCfSession): string {
  const preferredNames = ["_ga", "_ga_F3TYSDL945", "PHPSESSID"];
  const parts: string[] = [];

  for (const name of preferredNames) {
    const cookie = session.allCookies.find((candidate) => candidate.name === name);
    if (cookie) parts.push(`${cookie.name}=${cookie.value}`);
  }

  for (const cookie of session.allCookies) {
    if (!preferredNames.includes(cookie.name) && cookie.name !== "cf_clearance") {
      parts.push(`${cookie.name}=${cookie.value}`);
    }
  }

  if (session.cfClearance) parts.push(`cf_clearance=${session.cfClearance}`);
  return parts.join("; ");
}

/**
 * Initialise une session PHP Bookitit propre pour un dossier.
 *
 * La clearance CF et le proxy restent ceux de la session commune, mais le
 * PHPSESSID est supprimé de la copie avant le GET main/. Le serveur doit alors
 * émettre un nouveau PHPSESSID, qui reste uniquement dans cette copie locale
 * pour datetime/signin/summary.
 */
export async function createIsolatedBookingSession(
  cfSession: SpainCfSession,
  portalUrl: string,
): Promise<{ session: SpainCfSession; mainHtml?: string } | null> {
  const session = cloneSpainCfSessionForDossier(cfSession);
  const publickey = portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const referer = portalUrl.replace(/\/?$/, "/");
  const callback = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const query = new URLSearchParams({
    callback,
    type: "default",
    publickey,
    lang: "es",
    version: "4",
    src: referer,
    _: String(Date.now()),
  });

  // ─── Peak traffic retry for 5xx (server overload — CF session stays valid) ──
  // 504/502/503 = Bookitit saturé pendant l'ouverture de créneaux. Ne pas abandonner
  // le booking sur un timeout transitoire — retry jusqu'à 3× avec délai croissant.
  const BOOKING_OVERLOAD_CODES = new Set([502, 503, 504, 520, 524]);
  const bookingMainHeaders = {
    Cookie: buildBookingCookieHeader(session),
    Referer: referer,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Priority: "u=1, i",
  };
  let response: Response | null = null;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      const waitMs = attempt * 3_000;
      console.warn(`[spain-booking] 🔄 /main/ dédié retry ${attempt}/3 (surcharge serveur HTTP ${response?.status}) — attente ${waitMs / 1000}s`);
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
    response = await spainCfFetch(
      `https://www.citaconsular.es/onlinebookings/main/?${query}`,
      session,
      { headers: bookingMainHeaders },
    );
    if (!response || !BOOKING_OVERLOAD_CODES.has(response.status)) break;
    console.warn(`[spain-booking] ⚠️ /main/ dédié HTTP ${response.status} (surcharge Bookitit — traffic de pointe)`);
  }

  if (!response || !response.ok) {
    const statusCode = response?.status ?? "no response";
    if (response && BOOKING_OVERLOAD_CODES.has(response.status)) {
      console.warn(`[spain-booking] ❌ /main/ dédié surchargé (HTTP ${statusCode}) après 3 retries — booking interrompu`);
    } else {
      console.warn(`[spain-booking] ❌ main/ dédié échoué: HTTP ${statusCode}`);
    }
    return null;
  }

  for (const setCookie of response.headers.getSetCookie?.() ?? []) {
    const firstPart = setCookie.split(";", 1)[0] ?? "";
    const separator = firstPart.indexOf("=");
    if (separator <= 0) continue;

    const name = firstPart.slice(0, separator).trim();
    const value = firstPart.slice(separator + 1).trim();
    if (!name || !value) continue;

    const existingIndex = session.allCookies.findIndex((cookie) => cookie.name === name);
    const nextCookie = { name, value };
    if (existingIndex >= 0) session.allCookies[existingIndex] = nextCookie;
    else session.allCookies.push(nextCookie);

    if (name === "cf_clearance") session.cfClearance = value;
  }

  const phpSessId = session.allCookies.find((cookie) => cookie.name === "PHPSESSID")?.value;
  if (!phpSessId) {
    console.warn("[spain-booking] ❌ main/ dédié n'a pas fourni de PHPSESSID — booking interrompu");
    return null;
  }

  const rawBody = await response.text();
  let mainHtml: string | undefined;
  const jsonpMatch = rawBody.match(/^[^(]+\("(.*)"\);?$/s);
  if (jsonpMatch) {
    try {
      mainHtml = JSON.parse(`"${jsonpMatch[1]}"`);
    } catch {
      mainHtml = undefined;
    }
  } else if (rawBody.trim().startsWith("<")) {
    mainHtml = rawBody;
  }

  console.log(
    `[spain-booking] 🔒 Session Bookitit isolée créée — PHPSESSID=${phpSessId.slice(0, 12)}…` +
    ` | proxy partagé=${session.soaxProxyUrl ? "oui" : "non"}`,
  );

  return { session, mainHtml };
}

// ─── Service Extraction ─────────────────────────────────────────────────────

/**
 * Extrait les services rendus depuis le HTML de /main/.
 * Quand des créneaux sont disponibles, le HTML contient :
 *   <a href='#selectservice/ID'><div class="clsBktServiceDataContainer ...">
 *     <div class="clsBktServiceDataName">NOM</div>
 *   </div></a>
 */
export function extractServicesFromHtml(html: string): ExtractedSlotInfo[] {
  const results: ExtractedSlotInfo[] = [];

  // Remove templates to only look at rendered HTML
  const renderedHtml = html.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");

  // Extract services — IDs peuvent être numériques ou bkt-préfixés (ex: bkt1181774)
  const serviceMatches = [...renderedHtml.matchAll(/<a[^>]+href=['"]#selectservice\/([\w-]+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of serviceMatches) {
    const serviceId = m[1];
    const innerHtml = m[2];
    const nameMatch = innerHtml.match(/clsBktServiceDataName[^>]*>([^<]+)/i)
      ?? innerHtml.match(/>([^<]{5,})</);
    const name = nameMatch?.[1]?.trim() ?? "Service inconnu";
    results.push({ serviceId, serviceName: name });
  }

  return results;
}

// ─── Main Booking Flow ──────────────────────────────────────────────────────

/**
 * Exécute le booking HTTP-only complet.
 *
 * @param session - Session CF active (déjà résolue)
 * @param portalUrl - URL du widget citaconsular
 * @param mainHtml - HTML retourné par /main/ (contient les services rendus)
 * @param config - Credentials et configuration booking
 */
export async function executeHttpBooking(
  session: SpainCfSession,
  portalUrl: string,
  mainHtml: string,
  config: SpainBookingConfig,
): Promise<SpainBookingResult> {
  const t0 = Date.now();

  // ─── 1. Extraire les services disponibles ─────────────────────────────
  const services = config.availableServices?.length
    ? config.availableServices
    : extractServicesFromHtml(mainHtml);
  if (services.length === 0) {
    return { status: "no_slots", errorMessage: "Aucun service rendu dans le HTML", durationMs: Date.now() - t0 };
  }

  // Sélection du service cible :
  //   1. Si targetServiceId fourni → chercher par ID
  //   2. Si visaType fourni → matching par nom via spain-service-mapping
  //   3. Sinon → premier service disponible (legacy)
  let targetService: ExtractedSlotInfo | null = null;

  if (config.targetServiceId) {
    targetService = services.find((s) => s.serviceId === config.targetServiceId) ?? null;
    if (!targetService) {
      return { status: "no_slots", errorMessage: `Service cible ID ${config.targetServiceId} non trouvé dans le HTML`, durationMs: Date.now() - t0 };
    }
  } else if (config.visaType) {
    targetService = matchServiceForVisa(services, config.visaType);
    if (!targetService) {
      return { status: "no_slots", errorMessage: `Aucun service Bookitit ne matche le visa "${config.visaType}"`, durationMs: Date.now() - t0 };
    }
  } else {
    targetService = services[0];
  }

  const logPrefix = config.applicantName ? `[spain-booking][${config.applicantName}]` : "[spain-booking]";
  console.log(`${logPrefix} 🎯 Service cible: ${targetService.serviceName} (ID: ${targetService.serviceId})`);

  // Chaque dossier doit obtenir son propre PHPSESSID avant toute requête
  // datetime/signin/summary. La clearance CF et l'IP proxy restent partagées.
  const isolated = await createIsolatedBookingSession(session, portalUrl);
  if (!isolated) {
    return {
      status: "booking_failed",
      errorMessage: "Impossible d'établir une session PHP Bookitit isolée pour ce dossier",
      durationMs: Date.now() - t0,
    };
  }
  const bookingSession = isolated.session;

  // ─── 2. Récupérer les agendas pour ce service ────────────────────────
  const publickey = portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const portalReferer = portalUrl.replace(/\/?$/, "/");
  // Paramètres de base confirmés par capture réelle 2026-07-28 :
  // type, version, src, srvsrc sont requis sur CHAQUE appel JSONP.
  const baseParams: Record<string, string> = {
    type: "default",
    publickey,
    lang: "es",
    version: "4",
    src: portalReferer,
    srvsrc: "https://www.citaconsular.es",
  };

  console.log(`[spain-booking] 📋 Récupération agendas pour service ${targetService.serviceId}…`);
  const agendasPayload = await callBookititEndpoint(bookingSession, "getagendas/", {
    ...baseParams,
    "services[]": targetService.serviceId, // PHP array notation confirmée par capture
    selectedPeople: "1",
  }, portalUrl);

  let agendaId = "";
  if (agendasPayload && typeof agendasPayload === "object") {
    // Extract first agenda ID
    const agendaIds = extractIds(agendasPayload, /agenda.*id|^id$/i);
    if (agendaIds.length > 0) {
      agendaId = agendaIds[0];
      console.log(`[spain-booking] ✅ Agenda: ${agendaId}`);
    }
  }

  // ─── 3. Récupérer les créneaux datetime ───────────────────────────────
  console.log(`[spain-booking] 📅 Récupération datetime…`);
  const now = new Date();
  // Params datetime confirmés par capture 2026-07-28 : start/end (pas date_from/date_to)
  const buildDatetimeParams = (year: number, month: number) => ({
    ...baseParams,
    "services[]": targetService.serviceId,
    ...(agendaId ? { "agendas[]": agendaId } : {}),
    selectedPeople: "1",
    start: `${year}-${String(month + 1).padStart(2, "0")}-01`,
    end: new Date(year, month + 1, 0).toISOString().slice(0, 10),
  });

  const datetimePayload = await callBookititEndpoint(bookingSession, "datetime/",
    buildDatetimeParams(now.getFullYear(), now.getMonth()), portalUrl);

  let slotDate = "";
  let slotTime = "";
  if (datetimePayload && typeof datetimePayload === "object") {
    const slot = extractFirstSlot(datetimePayload);
    if (slot) {
      slotDate = slot.date;
      slotTime = slot.time;
      if (slot.agendaId) agendaId = slot.agendaId;
      console.log(`[spain-booking] ✅ Créneau: ${slotDate} à ${slotTime} (agenda: ${agendaId})`);
    }
  }

  if (!slotDate || !slotTime) {
    for (let m = 1; m <= 3; m++) {
      const futureDate = new Date(now.getFullYear(), now.getMonth() + m, 1);
      const mPayload = await callBookititEndpoint(bookingSession, "datetime/",
        buildDatetimeParams(futureDate.getFullYear(), futureDate.getMonth()), portalUrl);
      if (mPayload) {
        const slot = extractFirstSlot(mPayload);
        if (slot) {
          slotDate = slot.date;
          slotTime = slot.time;
          if (slot.agendaId) agendaId = slot.agendaId;
          console.log(`[spain-booking] ✅ Créneau trouvé mois+${m}: ${slotDate} à ${slotTime}`);
          break;
        }
      }
    }
  }

  if (!slotDate || !slotTime) {
    return { status: "no_slots", errorMessage: "Datetime API n'a retourné aucun créneau", durationMs: Date.now() - t0 };
  }

  // ─── 4. Widget config : captcha + registration_type ─────────────────
  // Kinshasa : captcha="0" → gct vide, pas d'appel CapSolver
  // LMD/Cuba : captcha="1" → hCaptcha requis → gct=P1_eyJ...
  //
  // registration_type détermine quel endpoint d'auth Bookitit utilise après
  // #selecttime — lu ici pour guider l'auto-découverte de l'endpoint signin.
  //   "2" → signin/          (compte existant, logintype=document — Kinshasa confirmé)
  //   "1" → signupfirstappointment/  (premier RDV, name+email sans password)
  //   autres/inconnu → on tente dans l'ordre
  let gctToken = "";
  let registrationType = "2"; // défaut Kinshasa
  try {
    const cfgPayload = await callBookititEndpoint(bookingSession, "getwidgetconfigurations/", baseParams, portalUrl);
    const widgetCfg = (cfgPayload as any)?.WidgetConfiguration;
    const captchaFlag = widgetCfg?.captcha;
    const captchaRequired = captchaFlag !== "0" && captchaFlag !== 0 && captchaFlag !== undefined && captchaFlag !== null;
    if (captchaRequired) {
      console.log(`[spain-booking] 🔐 Captcha requis (flag=${captchaFlag}) — résolution hCaptcha…`);
      gctToken = await solveHCaptcha(portalUrl) ?? "";
      if (!gctToken) {
        return { status: "turnstile_failed", errorMessage: "Impossible de résoudre le captcha hCaptcha", durationMs: Date.now() - t0 };
      }
    } else {
      console.log(`[spain-booking] ✅ captcha=0 — gct vide (Kinshasa / widget sans captcha)`);
    }
    if (widgetCfg?.registration_type !== undefined && widgetCfg.registration_type !== null) {
      registrationType = String(widgetCfg.registration_type);
      console.log(`[spain-booking] 📋 registration_type=${registrationType}`);
    }
  } catch {
    console.warn(`[spain-booking] ⚠️ getwidgetconfigurations/ échoué — on continue avec registration_type=${registrationType} (défaut)`);
  }

  // ─── 5. AUTO-DÉCOUVERTE DE L'ENDPOINT D'AUTH ──────────────────────────
  //
  // Valeurs confirmées depuis le bundle citaconsular_bundle/js/widgets/default/ :
  //
  //   widgetconfiguration.js :
  //     iFirstAppointment  = 1
  //     iSecondAppointment = 2
  //     iShowSignInStep    = 3
  //
  //   router.js (selecttime handler) :
  //     type=3               → navigate("signin")                   → SignInContainer
  //     type=1               → navigate("signup") → navigate("signupfirstappointment")
  //     type=2               → navigate("signup") → navigate("signupsecondappointment")
  //     autre/0/undefined    → navigate("signup") → reste sur #signup
  //
  //   Hash Backbone → Endpoint HTTP :
  //     #signin               registration_type=3  → signin/
  //     #signupsecondappointment  registration_type=2  → signin/
  //       (SignUpSecondAppointmentContainer extends SignInContainer, pas de submit() propre)
  //       (Cuba visa = type=2 → hash #signupsecondappointment → endpoint signin/)
  //     #signupfirstappointment  registration_type=1  → signupfirstappointment/
  //     #signup              type autre/0           → signup/
  //
  //   NB : "signedin/" n'est jamais utilisé en booking frais — signin.js l'active seulement
  //   si oClientValues_248295.signedInData.signedin est déjà défini (re-booking dans la
  //   même session widget). Notre bot démarre toujours une session fraîche → non applicable.
  //
  //   NB2 : il n'existe PAS d'endpoint HTTP "signupsecondappointment/" — c'est uniquement
  //   le nom de la vue Backbone. Confirmé par BOOKITIT_KNOWN_SUFFIXES dans spainPortal.ts
  //   ET par le bundle (signupsecondappointment.js extends SignInContainer, fetch→signin/).
  //
  // On construit une liste ordonnée de candidats (priorité selon registration_type),
  // on tente chacun et on retient le premier qui retourne un bktToken.
  // Un candidat est "raté" si : pas de réponse, ou réponse sans bktToken ET sans erreurs
  // métier (pas de bktToken + pas d'errors = mauvais endpoint, pas mauvais credentials).
  // Un candidat est "refusé" si : bktToken absent MAIS errors[] présent (bad credentials
  // sur le bon endpoint → pas de fallback).

  /** Params communs date/service pour tous les endpoints d'auth */
  const authBookingBase: Record<string, string> = {
    ...baseParams,
    "services[]": targetService.serviceId,
    ...(agendaId ? { "agendas[]": agendaId } : {}),
    date: slotDate,
    time: slotTime,
    selectedPeople: "1",
    comments: "",
    ...(gctToken ? { gct: gctToken } : {}),
  };

  /**
   * Candidats d'auth dans l'ordre de priorité.
   * Chaque candidat a un endpoint et ses params spécifiques.
   *
   * signin/               — compte existant (logintype=document, Kinshasa confirmé 2026-07-28)
   * signupfirstappointment/ — premier RDV (name+email, registration_type=1, pas de password)
   * signup/               — variante générique (similaire signupfirstappointment)
   */
  interface AuthCandidate {
    endpoint: string;
    label: string;
    params: Record<string, string>;
  }

  const candidateSignin: AuthCandidate = {
    endpoint: "signin/",
    label: "signin (logintype=document)",
    params: {
      ...authBookingBase,
      logintype: "document",
      login: config.login,
      password: config.password,
    },
  };

  const candidateSignupFirst: AuthCandidate = {
    endpoint: "signupfirstappointment/",
    label: "signupfirstappointment (name+email)",
    params: {
      ...authBookingBase,
      name: config.applicantName ?? config.login,
      email: config.login,
      // password absent intentionnellement : ce flow crée un compte sans password pré-existant
    },
  };

  const candidateSignup: AuthCandidate = {
    endpoint: "signup/",
    label: "signup (name+email fallback)",
    params: {
      ...authBookingBase,
      name: config.applicantName ?? config.login,
      email: config.login,
    },
  };

  // Ordre selon registration_type
  const authCandidates: AuthCandidate[] = registrationType === "1"
    ? [candidateSignupFirst, candidateSignin, candidateSignup]
    : [candidateSignin, candidateSignupFirst, candidateSignup]; // "2" ou inconnu → signin en premier

  console.log(
    `[spain-booking] 🔍 Auto-découverte endpoint auth — registration_type=${registrationType} — ` +
    `candidats: ${authCandidates.map((c) => c.endpoint).join(", ")}`,
  );

  // ─── Tentative séquentielle des candidats ────────────────────────────
  let signinPayload: unknown = null;
  let confirmedEndpoint = "";

  for (const candidate of authCandidates) {
    console.log(`[spain-booking] 🔑 Tentative ${candidate.label} (${candidate.endpoint})…`);
    const payload = await callBookititEndpoint(bookingSession, candidate.endpoint, candidate.params, portalUrl);

    if (!payload || typeof payload !== "object") {
      console.warn(`[spain-booking] ⚠️ ${candidate.endpoint} — pas de réponse ou format inattendu → candidat suivant`);
      continue;
    }

    const obj = payload as Record<string, unknown>;
    const inner = (obj as any).Client ?? obj;
    const errors = inner.errors ?? obj.errors;
    const hasErrors = Array.isArray(errors) && errors.length > 0;
    const token = inner.bktToken ?? (obj as any).bktToken ?? "";

    if (token) {
      // ✅ Succès — cet endpoint a fonctionné
      signinPayload = payload;
      confirmedEndpoint = candidate.endpoint;
      console.log(`[spain-booking] ✅ Endpoint confirmé: ${candidate.endpoint} — bktToken: ${String(token).slice(0, 20)}…`);
      break;
    }

    if (hasErrors) {
      // Bon endpoint, mauvais credentials → pas de fallback (retourner erreur métier immédiatement)
      const errMsg = (errors as Array<{ message?: string }>).map((e) => e.message).join(", ");
      console.error(`[spain-booking] ❌ ${candidate.endpoint} — erreurs métier (bon endpoint, credentials refusés): ${errMsg}`);
      return { status: "signin_failed", errorMessage: `Auth échouée sur ${candidate.endpoint}: ${errMsg}`, durationMs: Date.now() - t0 };
    }

    // Pas de token, pas d'erreurs → endpoint probablement incorrect, on essaie le suivant
    console.warn(
      `[spain-booking] ⚠️ ${candidate.endpoint} — réponse sans bktToken ni errors ` +
      `(endpoint incorrect ?) → candidat suivant. Réponse: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }

  if (!signinPayload || !confirmedEndpoint) {
    return {
      status: "signin_failed",
      errorMessage: `Aucun des ${authCandidates.length} endpoints d'auth n'a retourné de bktToken (${authCandidates.map((c) => c.endpoint).join(", ")})`,
      durationMs: Date.now() - t0,
    };
  }

  const signinObj = signinPayload as Record<string, unknown>;
  const clientObj = (signinObj as any).Client ?? signinObj;
  const bktToken = clientObj.bktToken ?? (signinObj as any).bktToken ?? "";

  // Check if OTP validation is required
  const validateRequired = (signinObj as any).validate !== undefined
    || clientObj.validate !== undefined;

  // ─── 6. CONFIRM CLIENT (OTP) ──────────────────────────────────────────
  if (validateRequired) {
    console.log(`[spain-booking] 📱 OTP requis — attente code…`);

    const validateBy = (signinObj as any).validateBy ?? (signinObj as any).Client?.validateBy ?? 0;
    const otpChannelLabel = validateBy === 0 ? "email" : "sms";
    console.log(`[spain-booking]    Canal: ${otpChannelLabel}`);

    // Request OTP via Convex
    if (config.applicationId) {
      await requestOtpChallenge({
        applicationId: config.applicationId,
        flow: "spain",
        channel: config.otpChannel ?? "email",
        ttlMs: 90_000,
      });
    }

    // Poll for OTP code (90s timeout)
    let otpCode = "";
    if (config.applicationId) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const result = await consumeOtpCode({ applicationId: config.applicationId, flow: "spain" });
        if (result.status === "ok") {
          otpCode = result.code;
          break;
        }
        if (result.status === "expired") break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }

    if (!otpCode) {
      return { status: "otp_timeout", errorMessage: "OTP non reçu dans les 90s", durationMs: Date.now() - t0 };
    }

    console.log(`[spain-booking] ✅ OTP reçu: ${otpCode}`);

    // Call confirmclient
    const confirmParams: Record<string, string> = {
      ...baseParams,
      bktToken: String(bktToken),
      code: otpCode,
    };

    // Add cellphone or email based on validateBy
    const clientEmail = config.login;
    if (validateBy === 0) {
      confirmParams.email = clientEmail;
    } else {
      // Would need phone from config
      confirmParams.email = clientEmail;
    }

    const confirmPayload = await callBookititEndpoint(bookingSession, "confirmclient/", confirmParams, portalUrl);
    if (!confirmPayload) {
      return { status: "booking_failed", errorMessage: "confirmclient/ pas de réponse", durationMs: Date.now() - t0 };
    }

    const confirmObj = confirmPayload as Record<string, unknown>;
    if (confirmObj.Valid !== true && (confirmObj as any) !== true) {
      if (confirmObj.Exceeded) {
        return { status: "booking_failed", errorMessage: "OTP Exceeded — trop de tentatives", durationMs: Date.now() - t0 };
      }
      return { status: "booking_failed", errorMessage: "OTP validation échouée", durationMs: Date.now() - t0 };
    }

    console.log(`[spain-booking] ✅ OTP validé`);
  }

  // ─── 7. SUMMARY (confirmation finale) ─────────────────────────────────
  console.log(`[spain-booking] 📝 Confirmation booking (summary/)…`);

  const summaryParams: Record<string, string> = {
    ...baseParams,
    "services[]": targetService.serviceId,
    ...(agendaId ? { "agendas[]": agendaId } : {}),
    date: slotDate,
    time: slotTime,
    bktToken: String(bktToken),
    login: config.login,
    logintype: "document", // cohérent avec signin
    event_created: "true",
    client_signin: "true",
  };

  const summaryPayload = await callBookititEndpoint(bookingSession, "summary/", summaryParams, portalUrl);
  if (!summaryPayload) {
    return { status: "booking_failed", errorMessage: "summary/ pas de réponse", durationMs: Date.now() - t0 };
  }

  // Extract locator from response
  // Response format: [{Event: {locator: "ABC123", state: 1, ...}}] or {Event: [...]}
  let locator = "";
  const summaryObj = summaryPayload as any;
  if (Array.isArray(summaryObj)) {
    locator = summaryObj[0]?.Event?.locator ?? "";
  } else if (summaryObj.Event) {
    locator = summaryObj.Event?.locator ?? "";
  } else if (summaryObj.Appointment) {
    locator = summaryObj.Appointment?.locator ?? "";
  }

  if (summaryObj.errors || summaryObj.Exception) {
    const errMsg = JSON.stringify(summaryObj.errors ?? summaryObj.Exception).slice(0, 200);
    console.error(`[spain-booking] ❌ Summary errors: ${errMsg}`);
    return { status: "booking_failed", errorMessage: `Summary échoué: ${errMsg}`, durationMs: Date.now() - t0 };
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[spain-booking] 🎉 BOOKING CONFIRMÉ ! Locator: ${locator} (${elapsed}s)`);

  // ─── 8. GÉNÉRATION PDF DE CONFIRMATION ────────────────────────────────
  let confirmationPdf: Buffer | undefined;
  try {
    const confirmData = extractConfirmationData(summaryPayload, {
      applicantName: config.applicantName ?? config.login,
      serviceName: targetService.serviceName,
      slotDate,
      slotTime,
    });

    if (confirmData) {
      console.log(`[spain-booking] 📄 Génération PDF confirmation…`);
      const pdf = await generateSpainConfirmationPdf(confirmData);
      if (pdf) {
        confirmationPdf = pdf;
        console.log(`[spain-booking] ✅ PDF généré: ${pdf.length} bytes`);
      }
    }
  } catch (pdfErr) {
    console.warn(`[spain-booking] ⚠️ PDF generation failed (non-fatal): ${pdfErr}`);
  }

  return {
    status: "booked",
    locator: locator || undefined,
    confirmationPdf,
    durationMs: Date.now() - t0,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractIds(value: unknown, keyHint: RegExp): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v && typeof v === "object") { walk(v); continue; }
      if ((typeof v === "string" || typeof v === "number") && keyHint.test(k)) {
        const s = String(v).trim();
        if (s.length > 0) out.add(s);
      }
    }
  };
  walk(value);
  return [...out];
}

function extractFirstSlot(payload: unknown): { date: string; time: string; agendaId?: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.Slots)) {
    for (const day of obj.Slots) {
      if (!day || typeof day !== "object") continue;
      const dayObj = day as Record<string, unknown>;
      const date = typeof dayObj.date === "string" ? dayObj.date : "";
      if (!date) continue;

      const agendaId = typeof dayObj.agenda === "string" ? dayObj.agenda
        : typeof dayObj.agenda === "number" ? String(dayObj.agenda)
        : undefined;

      const times = dayObj.times;
      if (!times || typeof times !== "object" || Array.isArray(times)) continue;

      for (const v of Object.values(times as Record<string, unknown>)) {
        if (!v || typeof v !== "object") continue;
        const t = v as Record<string, unknown>;
        const freeRaw = t.freeSlots ?? t.freeslots ?? t.free_slots;
        const free = typeof freeRaw === "number" ? freeRaw : typeof freeRaw === "string" ? parseInt(freeRaw, 10) : -1;
        if (free === 0) continue; // explicitly no slots

        const time = typeof t.time === "string" ? t.time
          : typeof t.hour === "string" ? t.hour
          : "09:00";

        return { date, time, agendaId };
      }
    }
  }

  return null;
}
