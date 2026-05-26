/**
 * spain-http-booking.ts — Booking HTTP-only pour créneaux Espagne (sans Playwright)
 *
 * FLOW COMPLET (reverse-engineered depuis le bundle Bookitit citaconsular) :
 *   1. Extraire serviceId depuis le HTML rendu quand "found"
 *   2. Résoudre CF Turnstile via CapSolver (TurnstileTask) — ~2s, $0.001
 *   3. JSONP signin/ (login + password + gct + date/time/service/agenda) → bktToken
 *   4. Si validate requis → JSONP confirmclient/ (bktToken + OTP code)
 *   5. JSONP summary/ (bktToken + all params) → locator (code confirmation)
 *
 * PRÉREQUIS :
 *   - Session CF active (ensureSpainCfSession déjà fait par le scanner)
 *   - Credentials Bookitit (embassyUsername + embassyPassword)
 *   - CAPSOLVER_API_KEY pour Turnstile
 *   - OTP flow configuré (email/SMS via Convex)
 *
 * COÛT : ~$0.006 par booking (CF solve $0.005 + Turnstile $0.001)
 */

import {
  spainCfFetch,
  getSpainImpit,
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
  /** Nom du demandeur (pour signup et logs) */
  applicantName?: string;
  /** Service cible spécifique (si fourni, bypass l'auto-sélection) */
  targetServiceId?: string;
  /** Type de visa du dossier (pour le matching service, ex: "Visa C — Tourisme / Affaires") */
  visaType?: string;
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
const TURNSTILE_SITEKEY = "0x4AAAAAAAzAYjTopCMo0Y8u"; // CF Turnstile sitekey from citaconsular.es widget

// ─── Turnstile Solver ───────────────────────────────────────────────────────

/**
 * Résout le CF Turnstile via CapSolver TurnstileTask.
 * Retourne le token gct à envoyer avec signin/signup.
 */
async function solveTurnstile(
  pageUrl: string,
  sitekey: string = TURNSTILE_SITEKEY,
): Promise<string | null> {
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  if (!capsolverKey) {
    console.error("[spain-booking] ❌ CAPSOLVER_API_KEY manquante pour Turnstile");
    return null;
  }

  const t0 = Date.now();
  console.log(`[spain-booking] 🔐 Solving CF Turnstile (sitekey: ${sitekey.slice(0, 20)}…)`);

  try {
    // Create task
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: capsolverKey,
        task: {
          type: "AntiTurnstileTaskProxyLess",
          websiteURL: pageUrl,
          websiteKey: sitekey,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const createData = (await createRes.json()) as { errorId: number; taskId?: string; errorDescription?: string };
    if (createData.errorId !== 0 || !createData.taskId) {
      console.error(`[spain-booking] ❌ Turnstile createTask failed: ${createData.errorDescription}`);
      return null;
    }

    // Poll result
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
        solution?: { token: string };
        errorDescription?: string;
      };

      if (resultData.status === "ready" && resultData.solution?.token) {
        const elapsed = Math.round((Date.now() - t0) / 1000);
        console.log(`[spain-booking] ✅ Turnstile résolu (${elapsed}s)`);
        return resultData.solution.token;
      }

      if (resultData.status === "failed") {
        console.error(`[spain-booking] ❌ Turnstile failed: ${resultData.errorDescription}`);
        return null;
      }
    }

    console.error(`[spain-booking] ❌ Turnstile timeout (90s)`);
    return null;
  } catch (err) {
    console.error(`[spain-booking] ❌ Turnstile error: ${err}`);
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
    Referer: portalUrl,
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
  });

  if (!res) return null;
  if (!res.ok) {
    console.warn(`[spain-booking] ${endpoint} returned ${res.status}`);
    return null;
  }

  const body = await res.text();
  return parseJsonpResponse(body);
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

  // Extract services
  const serviceMatches = [...renderedHtml.matchAll(/<a[^>]+href=['"]#selectservice\/(\d+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
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
  const services = extractServicesFromHtml(mainHtml);
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

  // ─── 2. Récupérer les agendas pour ce service ────────────────────────
  const publickey = portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const baseParams: Record<string, string> = {
    publickey,
    lang: "es",
  };

  console.log(`[spain-booking] 📋 Récupération agendas pour service ${targetService.serviceId}…`);
  const agendasPayload = await callBookititEndpoint(session, "getagendas/", {
    ...baseParams,
    services: targetService.serviceId,
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
  const dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const dateTo = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  const datetimePayload = await callBookititEndpoint(session, "datetime/", {
    ...baseParams,
    services: targetService.serviceId,
    agendas: agendaId,
    selectedPeople: "1",
    date_from: dateFrom,
    date_to: dateTo,
  }, portalUrl);

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
    // Try next months
    for (let m = 1; m <= 3; m++) {
      const futureDate = new Date(now.getFullYear(), now.getMonth() + m, 1);
      const mFrom = futureDate.toISOString().slice(0, 10);
      const mTo = new Date(futureDate.getFullYear(), futureDate.getMonth() + 1, 0).toISOString().slice(0, 10);

      const mPayload = await callBookititEndpoint(session, "datetime/", {
        ...baseParams,
        services: targetService.serviceId,
        agendas: agendaId,
        selectedPeople: "1",
        date_from: mFrom,
        date_to: mTo,
      }, portalUrl);

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

  // ─── 4. Résoudre CF Turnstile ────────────────────────────────────────
  console.log(`[spain-booking] 🔐 Résolution Turnstile…`);
  const turnstileToken = await solveTurnstile(portalUrl);
  if (!turnstileToken) {
    return { status: "turnstile_failed", errorMessage: "Impossible de résoudre CF Turnstile", durationMs: Date.now() - t0 };
  }

  // ─── 5. SIGNIN ────────────────────────────────────────────────────────
  console.log(`[spain-booking] 🔑 Signin avec ${config.login.slice(0, 5)}…`);

  const signinParams: Record<string, string> = {
    ...baseParams,
    services: targetService.serviceId,
    agendas: agendaId,
    date: slotDate,
    time: slotTime,
    selectedPeople: "1",
    logintype: "email",
    login: config.login,
    password: encodeURIComponent(config.password),
    gct: turnstileToken,
  };

  const signinPayload = await callBookititEndpoint(session, "signin/", signinParams, portalUrl);

  if (!signinPayload || typeof signinPayload !== "object") {
    return { status: "signin_failed", errorMessage: "signin/ pas de réponse", durationMs: Date.now() - t0 };
  }

  const signinObj = signinPayload as Record<string, unknown>;

  // Check for errors
  if (signinObj.errors && Array.isArray(signinObj.errors) && signinObj.errors.length > 0) {
    const errMsg = (signinObj.errors as Array<{ message?: string }>).map(e => e.message).join(", ");
    console.error(`[spain-booking] ❌ Signin errors: ${errMsg}`);
    return { status: "signin_failed", errorMessage: `Signin échoué: ${errMsg}`, durationMs: Date.now() - t0 };
  }

  // Extract bktToken from response
  const bktToken = (signinObj as any).bktToken
    ?? (signinObj as any).Client?.bktToken
    ?? "";

  if (!bktToken) {
    console.error(`[spain-booking] ❌ Pas de bktToken dans la réponse signin`);
    console.error(`[spain-booking]    Response: ${JSON.stringify(signinPayload).slice(0, 500)}`);
    return { status: "signin_failed", errorMessage: "bktToken absent de la réponse signin", durationMs: Date.now() - t0 };
  }

  console.log(`[spain-booking] ✅ Signin OK — bktToken: ${String(bktToken).slice(0, 20)}…`);

  // Check if OTP validation is required
  const validateRequired = (signinObj as any).validate !== undefined
    || (signinObj as any).Client?.validate !== undefined;

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

    const confirmPayload = await callBookititEndpoint(session, "confirmclient/", confirmParams, portalUrl);
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
    services: targetService.serviceId,
    agendas: agendaId,
    date: slotDate,
    time: slotTime,
    bktToken: String(bktToken),
    login: config.login,
    logintype: "email",
    event_created: "true",
    client_signin: "true",
  };

  const summaryPayload = await callBookititEndpoint(session, "summary/", summaryParams, portalUrl);
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
