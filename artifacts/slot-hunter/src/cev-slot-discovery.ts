/**
 * CEV Slot Discovery — Capture COMPLÈTE du flow booking quand un slot est détecté.
 *
 * OBJECTIF :
 *   Quand le scan CEV détecte un slot disponible (page calendrier), ce module :
 *   1. Capture TOUT le HTML, JS, headers, endpoints AJAX de la page calendrier
 *   2. Tente GET /Home/AvailableTimeSlots pour obtenir les slots JSON
 *   3. Explore la structure du formulaire de booking (hidden inputs, form actions)
 *   4. Sauvegarde TOUT dans Convex storage (pour reverse-engineering offline)
 *   5. Envoie un email d'alerte admin via Resend
 *   6. Tente le booking HTTP avec les données découvertes
 *
 * IMPORTANT : utilise la session EXISTANTE du scan (pas de re-login)
 *   → Le slot ne peut pas disparaître entre la détection et la capture
 *   → Le re-login est un fallback UNIQUEMENT si la session existante échoue
 *
 * ARCHITECTURE :
 *   - Appelé par handleSlotFound() dans cev-dossier-loop.ts
 *   - Sauvegarde vers Convex via uploadFile (JSON compressé)
 *   - Email via Resend directement (même pattern que adminReporting.ts)
 */

import { botLog, uploadFile } from "./convexClient.js";
import { cevImpitFetch, getCevBrowserHeaders } from "./cev-shared-impit.js";

const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM_EMAIL = "Hunter Bot <bot@joventy.cd>";
const ADMIN_EMAILS = ["sabowaryan@gmail.com", "admin@joventy.cd"];

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CapturedRequest {
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  durationMs: number;
}

export interface SlotDiscoveryResult {
  /** Timestamp de la découverte */
  discoveredAt: number;
  /** Dossier VOWINT qui a détecté le slot */
  vowintRef: string;
  /** Cookie de session CEV utilisé */
  sessionCookie: string;
  /** URL d'intégration (depuis GetEAppointmentUrl) */
  integrationUrl: string;
  /** HTML complet de la page calendrier/SelectSlot */
  calendarPageHtml: string;
  /** URL finale après redirections */
  calendarPageUrl: string;
  /** Scripts JS inline extraits de la page */
  inlineScripts: string[];
  /** Endpoints AJAX découverts dans le HTML/JS */
  ajaxEndpoints: string[];
  /** Hidden inputs du formulaire */
  hiddenInputs: Record<string, string>;
  /** Action du form (si présent) */
  formAction: string | null;
  /** Anti-forgery token */
  antiForgeryToken: string | null;
  /** Résultat de GET /Home/AvailableTimeSlots */
  availableTimeSlotsResponse: CapturedRequest | null;
  /** Résultat de GET /Home/GetAvailableTimeSlotsForPublic (si existe) */
  publicTimeSlotsResponse: CapturedRequest | null;
  /** Toutes les requêtes capturées pendant la discovery */
  allRequests: CapturedRequest[];
  /** Storages IDs Convex (si upload réussi) */
  convexStorageId?: string;
  /** Erreurs rencontrées */
  errors: string[];
}

// ─── Helpers extraction ─────────────────────────────────────────────────────

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const content = m[1].trim();
    if (content.length > 20) scripts.push(content);
  }
  return scripts;
}

function extractAjaxEndpoints(html: string): string[] {
  const endpoints = new Set<string>();
  const patterns = [
    /url\s*:\s*["']([^"']+)["']/gi,
    /\$\.(?:post|get|ajax)\(['"]([^'"]+)['"]/gi,
    /fetch\(['"]([^'"]+)['"]/gi,
    /ajaxUrl\s*=\s*["']([^"']+)["']/gi,
    /action\s*=\s*["']([^"']+)["']/gi,
    /href\s*=\s*["'](\/Home\/[^"']+|\/Integration\/[^"']+)["']/gi,
    /data-url\s*=\s*["']([^"']+)["']/gi,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(html)) !== null) {
      endpoints.add(m[1]);
    }
  }
  return [...endpoints].slice(0, 50);
}

function extractHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const regex = /<input[^>]+type=["']?hidden["']?[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const tag = m[0];
    const nameM = tag.match(/name="([^"]+)"/i);
    const valM = tag.match(/value="([^"]*)"?/i);
    if (nameM?.[1]) out[nameM[1]] = valM?.[1] ?? "";
  }
  return out;
}

function extractFormAction(html: string): string | null {
  const m = html.match(/<form[^>]+method=["']?post["']?[^>]*action="([^"]+)"/i)
    ?? html.match(/<form[^>]+action="([^"]+)"[^>]*method=["']?post["']?/i);
  return m?.[1] ?? null;
}

function extractAntiForgeryToken(html: string): string | null {
  const patterns = [
    /__RequestVerificationToken"[^>]*value="([^"]+)"/i,
    /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── Core: capture une requête HTTP avec timing ─────────────────────────────

async function captureRequest(
  url: string,
  options: RequestInit,
  label: string,
): Promise<CapturedRequest> {
  const start = Date.now();
  const reqHeaders: Record<string, string> = {};
  if (options.headers) {
    const h = options.headers as Record<string, string>;
    for (const [k, v] of Object.entries(h)) reqHeaders[k] = v;
  }

  try {
    const res = await cevImpitFetch(url, options, "[CEV-DISCOVERY]");
    const durationMs = Date.now() - start;
    const responseBody = await res.text().catch(() => "");
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    return {
      timestamp: start,
      method: (options.method ?? "GET").toUpperCase(),
      url,
      requestHeaders: reqHeaders,
      requestBody: options.body ? String(options.body) : undefined,
      responseStatus: res.status,
      responseHeaders,
      responseBody,
      durationMs,
    };
  } catch (err) {
    return {
      timestamp: start,
      method: (options.method ?? "GET").toUpperCase(),
      url,
      requestHeaders: reqHeaders,
      requestBody: options.body ? String(options.body) : undefined,
      responseStatus: 0,
      responseHeaders: {},
      responseBody: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Capture complète du flow booking après détection d'un slot.
 * Utilise la session EXISTANTE (pas de re-login) pour ne pas perdre le slot.
 *
 * @param sessionCookie - Cookie ASP.NET_SessionId du scan qui a détecté le slot
 * @param integrationUrl - URL d'intégration CEV
 * @param vowintRef - Numéro VOWINT du dossier
 * @param clientId - ID pour les botLogs
 * @param calendarHtml - HTML déjà capturé par le scan (optionnel, évite un GET supplémentaire)
 */
export async function discoverSlotBookingFlow(
  sessionCookie: string,
  integrationUrl: string,
  vowintRef: string,
  clientId: string,
  calendarHtml?: string,
): Promise<SlotDiscoveryResult> {
  const result: SlotDiscoveryResult = {
    discoveredAt: Date.now(),
    vowintRef,
    sessionCookie,
    integrationUrl,
    calendarPageHtml: "",
    calendarPageUrl: "",
    inlineScripts: [],
    ajaxEndpoints: [],
    hiddenInputs: {},
    formAction: null,
    antiForgeryToken: null,
    availableTimeSlotsResponse: null,
    publicTimeSlotsResponse: null,
    allRequests: [],
    errors: [],
  };

  const fullCookie = `ASP.NET_SessionId=${sessionCookie}; PreferredCulture=en-US`;

  botLog({
    applicationId: clientId,
    step: "cev_slot_discovery_start",
    status: "ok",
    data: { vowintRef, integrationUrl: integrationUrl.slice(0, 80) },
  });

  // ═══ ÉTAPE 1 : Obtenir la page calendrier (ou réutiliser le HTML du scan) ═══
  if (calendarHtml) {
    result.calendarPageHtml = calendarHtml;
    result.calendarPageUrl = integrationUrl;
  } else {
    const pageReq = await captureRequest(integrationUrl, {
      method: "GET",
      headers: getCevBrowserHeaders({ referer: `${CEV_BASE}/Captcha`, cookie: fullCookie }),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    }, "calendar_page");
    result.allRequests.push(pageReq);
    result.calendarPageHtml = pageReq.responseBody;
    result.calendarPageUrl = pageReq.url;

    if (pageReq.responseStatus !== 200) {
      result.errors.push(`Calendar page HTTP ${pageReq.responseStatus}`);
    }
  }

  // ═══ ÉTAPE 2 : Extraire la structure de la page ═══
  const html = result.calendarPageHtml;
  result.inlineScripts = extractInlineScripts(html);
  result.ajaxEndpoints = extractAjaxEndpoints(html);
  result.hiddenInputs = extractHiddenInputs(html);
  result.formAction = extractFormAction(html);
  result.antiForgeryToken = extractAntiForgeryToken(html);

  // ═══ ÉTAPE 3 : Tenter GET /Home/AvailableTimeSlots ═══
  const now = new Date();
  const slotsBody = JSON.stringify({ month: now.getMonth() + 1, year: now.getFullYear() });

  const slotsReq = await captureRequest(`${CEV_BASE}/Home/AvailableTimeSlots`, {
    method: "POST",
    headers: getCevBrowserHeaders({
      referer: result.calendarPageUrl || integrationUrl,
      cookie: fullCookie,
      contentType: "application/json",
      xRequestedWith: true,
      accept: "application/json, text/javascript, */*; q=0.01",
      origin: CEV_BASE,
    }),
    body: slotsBody,
    signal: AbortSignal.timeout(60_000),
  }, "available_time_slots");
  result.allRequests.push(slotsReq);
  result.availableTimeSlotsResponse = slotsReq;

  // ═══ ÉTAPE 3b : Tenter aussi /Home/GetAvailableTimeSlotsForPublic ═══
  const publicSlotsReq = await captureRequest(`${CEV_BASE}/Home/GetAvailableTimeSlotsForPublic`, {
    method: "POST",
    headers: getCevBrowserHeaders({
      referer: result.calendarPageUrl || integrationUrl,
      cookie: fullCookie,
      contentType: "application/json",
      xRequestedWith: true,
      accept: "application/json, text/javascript, */*; q=0.01",
      origin: CEV_BASE,
    }),
    body: slotsBody,
    signal: AbortSignal.timeout(60_000),
  }, "public_time_slots");
  result.allRequests.push(publicSlotsReq);
  result.publicTimeSlotsResponse = publicSlotsReq;

  // ═══ ÉTAPE 4 : Explorer d'autres endpoints découverts ═══
  const interestingEndpoints = result.ajaxEndpoints.filter(
    (e) => /slot|book|appoint|select|confirm|reserve|time/i.test(e)
  ).slice(0, 5);

  for (const endpoint of interestingEndpoints) {
    const fullUrl = endpoint.startsWith("http") ? endpoint : `${CEV_BASE}${endpoint}`;
    // GET seulement (pas de POST risqué sans connaître le body)
    const req = await captureRequest(fullUrl, {
      method: "GET",
      headers: getCevBrowserHeaders({
        referer: result.calendarPageUrl || integrationUrl,
        cookie: fullCookie,
        xRequestedWith: true,
        accept: "text/html, application/json, */*",
      }),
      signal: AbortSignal.timeout(30_000),
    }, `explore_${endpoint.slice(-30)}`);
    result.allRequests.push(req);
  }

  // ═══ ÉTAPE 5 : Sauvegarder dans Convex storage ═══
  try {
    const discoveryJson = JSON.stringify(result, null, 2);
    const base64 = Buffer.from(discoveryJson).toString("base64");
    const storageId = await uploadFile(base64, "application/json");
    if (storageId) {
      result.convexStorageId = storageId;
      console.log(`[cev-discovery] ✅ Discovery sauvegardée → storageId: ${storageId}`);
    }
  } catch (err) {
    result.errors.push(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ═══ ÉTAPE 6 : Log résumé dans botLog ═══
  botLog({
    applicationId: clientId,
    step: "cev_slot_discovery_complete",
    status: "ok",
    data: {
      vowintRef,
      storageId: result.convexStorageId ?? "upload_failed",
      calendarPageUrl: result.calendarPageUrl,
      antiForgeryTokenFound: !!result.antiForgeryToken,
      formAction: result.formAction,
      hiddenInputCount: Object.keys(result.hiddenInputs).length,
      ajaxEndpointsCount: result.ajaxEndpoints.length,
      ajaxEndpoints: result.ajaxEndpoints.slice(0, 10),
      inlineScriptsCount: result.inlineScripts.length,
      slotsResponseStatus: slotsReq.responseStatus,
      slotsResponsePreview: slotsReq.responseBody.slice(0, 500),
      publicSlotsStatus: publicSlotsReq.responseStatus,
      publicSlotsPreview: publicSlotsReq.responseBody.slice(0, 500),
      totalRequests: result.allRequests.length,
      errors: result.errors,
    },
  });

  return result;
}

// ─── Email notification admin ───────────────────────────────────────────────

export interface SlotBookingEmailData {
  vowintRef: string;
  detectedAt: number;
  slots: Array<{ date: string; time: string; free: number }>;
  totalFree: number;
  bookingResult: "success" | "failed" | "pending";
  confirmationCode?: string;
  bookedDate?: string;
  bookedTime?: string;
  error?: string;
  eligibleDossiers?: string[];
  strategy?: string;
}

/**
 * Envoie un email d'alerte à l'admin quand un slot CEV est détecté / booké.
 * Accepte l'ancien format SlotDiscoveryResult (legacy) ou le nouveau SlotBookingEmailData.
 */
export async function sendSlotDetectedEmail(
  vowintRef: string,
  data: SlotDiscoveryResult | SlotBookingEmailData,
): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log("[cev-discovery] RESEND_API_KEY non configuré — email slot ignoré");
    return false;
  }

  // Nouveau format : infos utiles (slots, résultat booking)
  if ("bookingResult" in data) {
    return sendBookingResultEmail(data);
  }

  // Legacy : discovery brute (fallback, ne devrait plus être le cas principal)
  return sendLegacyDiscoveryEmail(vowintRef, data);
}

/**
 * Email avec le résultat du booking : slots détectés, confirmation, erreur.
 */
async function sendBookingResultEmail(data: SlotBookingEmailData): Promise<boolean> {
  const isSuccess = data.bookingResult === "success";
  const emoji = isSuccess ? "✅" : "🚨";
  const statusLabel = isSuccess ? "BOOKING RÉUSSI" : data.bookingResult === "failed" ? "BOOKING ÉCHOUÉ" : "SLOT DÉTECTÉ";
  const borderColor = isSuccess ? "#16a34a" : "#dc2626";

  const subject = `${emoji} [CEV] ${statusLabel} — ${data.vowintRef}${isSuccess && data.bookedDate ? ` — ${data.bookedDate} ${data.bookedTime ?? ""}` : ""}`;

  const slotsRows = data.slots.map(s =>
    `<tr><td style="padding:6px 12px;font-family:monospace;">${s.date}</td><td style="padding:6px 12px;">${s.time}</td><td style="padding:6px 12px;text-align:center;font-weight:bold;color:${s.free <= 1 ? "#dc2626" : "#16a34a"}">${s.free}</td></tr>`
  ).join("\n");

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:2px solid ${borderColor};">

<h1 style="color:${borderColor};margin:0 0 16px;font-size:20px;">${emoji} ${statusLabel}</h1>

<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
<tr><td style="padding:8px;font-weight:bold;color:#374151;width:140px;">Dossier</td><td style="padding:8px;font-weight:bold;">${data.vowintRef}</td></tr>
<tr><td style="padding:8px;font-weight:bold;color:#374151;">Detecte a</td><td style="padding:8px;">${new Date(data.detectedAt).toLocaleString("fr-FR", { timeZone: "Europe/Brussels" })}</td></tr>
<tr><td style="padding:8px;font-weight:bold;color:#374151;">Places libres</td><td style="padding:8px;font-weight:bold;color:${data.totalFree <= 1 ? "#dc2626" : "#16a34a"}">${data.totalFree} place${data.totalFree > 1 ? "s" : ""}</td></tr>
${isSuccess ? `<tr><td style="padding:8px;font-weight:bold;color:#374151;">Confirmation</td><td style="padding:8px;font-weight:bold;color:#16a34a;font-size:16px;">${data.confirmationCode ?? "—"}</td></tr>
<tr><td style="padding:8px;font-weight:bold;color:#374151;">Date reservee</td><td style="padding:8px;font-weight:bold;">${data.bookedDate ?? "—"} ${data.bookedTime ?? ""}</td></tr>` : ""}
${data.error ? `<tr><td style="padding:8px;font-weight:bold;color:#dc2626;">Erreur</td><td style="padding:8px;color:#dc2626;">${data.error}</td></tr>` : ""}
${data.strategy ? `<tr><td style="padding:8px;font-weight:bold;color:#374151;">Strategie</td><td style="padding:8px;">${data.strategy}</td></tr>` : ""}
</table>

${data.slots.length > 0 ? `<h2 style="margin:24px 0 8px;color:#374151;font-size:15px;">Creneaux detectes</h2>
<table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;">
<tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;">Date</th><th style="padding:8px 12px;text-align:left;">Heure</th><th style="padding:8px 12px;text-align:center;">Places</th></tr>
${slotsRows}
</table>` : ""}

${data.eligibleDossiers && data.eligibleDossiers.length > 1 ? `<p style="margin:16px 0 0;font-size:12px;color:#6b7280;">Dossiers eligibles: ${data.eligibleDossiers.join(", ")}</p>` : ""}

<p style="margin:24px 0 0;color:#6b7280;font-size:11px;">Hunter Bot — ${new Date().toISOString()}</p>

</div>
</body></html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: ADMIN_EMAILS, subject, html: htmlBody }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[cev-discovery] Resend erreur HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return false;
    }
    const resData = (await res.json()) as { id?: string };
    console.log(`[cev-discovery] ✅ Email booking envoyé (id: ${resData.id ?? "?"})`);
    return true;
  } catch (err) {
    console.warn(`[cev-discovery] Erreur envoi email: ${err}`);
    return false;
  }
}

/**
 * Legacy : email discovery brut (fallback).
 */
async function sendLegacyDiscoveryEmail(vowintRef: string, discoveryResult: SlotDiscoveryResult): Promise<boolean> {
  const subject = `🚨 [CEV] SLOT DÉTECTÉ — ${vowintRef}`;
  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:monospace;">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:2px solid #dc2626;">
<h1 style="color:#dc2626;margin:0 0 16px;">🚨 SLOT CEV DÉTECTÉ</h1>
<table style="width:100%;border-collapse:collapse;margin:16px 0;">
<tr><td style="padding:8px;font-weight:bold;">Dossier</td><td style="padding:8px;">${vowintRef}</td></tr>
<tr><td style="padding:8px;font-weight:bold;">Detecte a</td><td style="padding:8px;">${new Date(discoveryResult.discoveredAt).toLocaleString("fr-FR")}</td></tr>
<tr><td style="padding:8px;font-weight:bold;">Convex storage</td><td style="padding:8px;">${discoveryResult.convexStorageId ?? "—"}</td></tr>
</table>
<p style="color:#6b7280;font-size:11px;">Hunter Bot — ${new Date().toISOString()}</p>
</div>
</body></html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: ADMIN_EMAILS, subject, html: htmlBody }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return false;
    const resData = (await res.json()) as { id?: string };
    console.log(`[cev-discovery] ✅ Email legacy envoyé (id: ${resData.id ?? "?"})`);
    return true;
  } catch (err) {
    console.warn(`[cev-discovery] Erreur envoi email legacy: ${err}`);
    return false;
  }
}
