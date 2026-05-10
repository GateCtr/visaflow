/**
 * Probe des 3 nouveaux endpoints découverts dans le bundle Angular :
 *   - GET /visaappointmentapi/appointments/getLandingPageDeatils  (dashboard data)
 *   - GET /visaappointmentapi/appointments/showRescheduleButton   (reschedule eligibility)
 *   - GET /visaappointmentapi/appointments/scheduledappointmentInfo (scheduled appointments list)
 *
 * Ces endpoints passent tous par l'intercepteur HTTP Angular → Authorization: Bearer <token>
 * Si getUserHistoryApplicantPaymentStatus fonctionne avec Bearer, ceux-ci devraient aussi.
 *
 * Usage :
 *   USA_EMAIL=... USA_PASSWORD=... npx tsx src/test-new-endpoints.ts
 */

import { loginUsaPortal, setUsaSessionProxy } from "./usaPortal.js";

const EMAIL    = process.env.USA_EMAIL    ?? "";
const PASSWORD = process.env.USA_PASSWORD ?? "";
if (!EMAIL || !PASSWORD) { console.error("❌ USA_EMAIL et USA_PASSWORD requis"); process.exit(1); }

// Activer le proxy résidentiel iProyal pour contourner le rate-limit IP de Replit
const PROXY_URL = process.env.IPROYAL_PROXY_URL ?? "";
if (PROXY_URL) {
  setUsaSessionProxy(PROXY_URL);
  console.log("[probe] Proxy iProyal activé pour le login");
} else {
  console.warn("[probe] ⚠️ IPROYAL_PROXY_URL absent — tentative sans proxy");
}

const USA_BASE     = "https://www.usvisaappt.com";
const APT_BASE     = `${USA_BASE}/visaappointmentapi`;
const WORKFLOW_BASE = `${USA_BASE}/visaworkflowprocessor`;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function probe(
  label: string,
  url: string,
  method: "GET" | "POST" | "PUT",
  headers: Record<string, string>,
  body?: unknown,
): Promise<void> {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log(`  ${method} ${url.replace(USA_BASE, "")}`);
  try {
    const opts: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const ct  = res.headers.get("content-type") ?? "";
    let text  = await res.text();
    const ico = res.ok ? "✅" : res.status === 401 ? "🔒" : res.status === 404 ? "🔍" : "❌";
    console.log(`  ${ico} HTTP ${res.status}`);
    if (text.length > 0 && text.length < 2000) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }
      console.log(`  Response:\n${text.split("\n").map(l => "    " + l).join("\n")}`);
    } else if (text.length > 0) {
      console.log(`  Response (${text.length} chars): ${text.slice(0, 500)}...`);
    } else {
      console.log(`  Response: (vide)`);
    }
    // Extra: dump response headers
    const importantHdrs = ["content-type", "www-authenticate", "x-correlation-id", "x-request-id"];
    for (const h of importantHdrs) {
      const v = res.headers.get(h);
      if (v) console.log(`  Header ${h}: ${v}`);
    }
  } catch (err) {
    console.log(`  ❌ Erreur réseau: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(65));
  console.log("  PROBE — 3 NOUVEAUX ENDPOINTS BUNDLE ANGULAR");
  console.log("=".repeat(65));

  // ── Login ─────────────────────────────────────────────────────────────────
  console.log("\n[1] Login...");
  let rawSession: Awaited<ReturnType<typeof loginUsaPortal>>;
  try {
    rawSession = await loginUsaPortal(EMAIL, PASSWORD);
  } catch (err) {
    console.error(`  ❌ Login échoué: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (!rawSession!) { console.error("  ❌ Session nulle"); process.exit(1); }
  const session = rawSession!;
  console.log(`  ✅ Token: ${session.accessToken.slice(0, 40)}...`);
  console.log(`  userID: ${session.userID}  missionId: ${session.missionId}`);
  console.log(`  applicationId: ${session.applicationId ?? "(absent)"}`);
  console.log(`  applicantId: ${session.applicantId ?? "(absent)"}`);

  const token = session.accessToken;
  const csrfToken = session.csrfToken ?? "";

  // X-Correlation-key : 15 chars alphanumériques (même logique que generateCorrelationId() dans le bundle)
  const corrId = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < 15; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  };

  // Headers standard (intercepteur Angular)
  const stdHeaders: Record<string, string> = {
    "Authorization":    `Bearer ${token}`,
    "Content-Type":     "application/json",
    "Accept":           "application/json",
    "X-Correlation-key": corrId(),
  };
  // Headers spéciaux pour getLandingPageDeatils (bundle : LanguageId header + X-Correlation-key)
  const langHeaders: Record<string, string> = {
    "Authorization":    `Bearer ${token}`,
    "Content-Type":     "application/json",
    "Accept":           "application/json",
    "LanguageId":       "1",
    "X-Correlation-key": corrId(),
  };
  // Headers avec CSRF (pour les PUT)
  const csrfHeaders: Record<string, string> = {
    ...stdHeaders,
    "X-Correlation-key": corrId(),
    "CookieName": `XSRF-TOKEN=${csrfToken}`,
    "Csrftoken":  csrfToken,
  };

  // ── Probe 1 : getLandingPageDeatils ────────────────────────────────────────
  await probe(
    "getLandingPageDeatils (typo officiel du portail)",
    `${APT_BASE}/appointments/getLandingPageDeatils`,
    "GET",
    langHeaders,
  );

  // Variante avec /appointment/ (sans s)
  await probe(
    "getLandingPageDeatils — variante /appointment/ (sans s)",
    `${APT_BASE}/appointment/getLandingPageDeatils`,
    "GET",
    langHeaders,
  );

  // ── Probe 2 : showRescheduleButton ─────────────────────────────────────────
  await probe(
    "showRescheduleButton",
    `${APT_BASE}/appointments/showRescheduleButton`,
    "GET",
    stdHeaders,
  );

  // ── Probe 3 : scheduledappointmentInfo ────────────────────────────────────
  await probe(
    "scheduledappointmentInfo",
    `${APT_BASE}/appointments/scheduledappointmentInfo`,
    "GET",
    stdHeaders,
  );

  // ── Probe 4 : cancelAppointment (PUT /appointments) ────────────────────────
  // Bundle : `cancelAppointment(p){ return this.httpClient.put(".../appointments",p) }`
  // On sonde avec GET d'abord pour voir ce que ça retourne
  await probe(
    "GET /appointments (endpoint générique)",
    `${APT_BASE}/appointments`,
    "GET",
    stdHeaders,
  );

  // ── Probe 5 : getlist ─────────────────────────────────────────────────────
  // Bundle : `getAppointmentsList(){ return this.http.get(this.visaAppointment+"/getlist") }`
  await probe(
    "getlist (liste appointments)",
    `${APT_BASE}/getlist`,
    "GET",
    stdHeaders,
  );

  // ── Probe 6 : /workflow/status/complete/{userID} ───────────────────────────
  // Bundle : `getIWpaymentDetails(h){ return http.get(...+"/workflow/status/complete/"+h) }`
  if (session.userID) {
    await probe(
      `workflow/status/complete/${session.userID}`,
      `${WORKFLOW_BASE}/workflow/status/complete/${session.userID}`,
      "GET",
      stdHeaders,
    );
  }

  // ── Probe 7 : workflow/getTransformData/{applicationId} ──────────────────
  // Bundle : `getTransformData(y,w){ return http.get(visaWorkFlowURL+"/workflow/getTransformData/"+y) }`
  // Si applicationId est absent, on peut tenter avec userID
  if (session.applicationId) {
    await probe(
      `workflow/getTransformData/${session.applicationId}`,
      `${WORKFLOW_BASE}/workflow/getTransformData/${session.applicationId}`,
      "GET",
      stdHeaders,
    );
  }

  // ── Probe 8 : /appointments/search ────────────────────────────────────────
  // Bundle : `searcApplicationDetails(h){ return http.post(".../appointments/search", h) }`
  await probe(
    "appointments/search — par userID",
    `${APT_BASE}/appointments/search`,
    "POST",
    stdHeaders,
    { userId: session.userID, missionId: session.missionId },
  );

  // ── Probe 9 : getApplicationHistory/{userID} ──────────────────────────────
  // Bundle : `checkRequestIdbyAppId(y){ return http.get(...+"/workflow/getApplicationHistory/"+y) }`
  if (session.userID) {
    await probe(
      `workflow/getApplicationHistory/${session.userID}`,
      `${WORKFLOW_BASE}/workflow/getApplicationHistory/${session.userID}`,
      "GET",
      { ...stdHeaders, "responseType": "text" },
    );
  }

  console.log("\n" + "=".repeat(65));
  console.log("  FIN PROBE");
  console.log("=".repeat(65));
  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
