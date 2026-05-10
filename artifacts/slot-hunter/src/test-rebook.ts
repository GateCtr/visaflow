/**
 * Script de test — Connexion USA + Exploration endpoints pour rebooking Christian
 * Usage : USA_EMAIL="email" USA_PASSWORD="pass" npx tsx src/test-rebook.ts
 */

import { setUsaSessionProxy, encryptPortalCredentials } from "./usaPortal.js";
import { proxyPool } from "./browser.js";

const EMAIL    = process.env.USA_EMAIL    ?? "";
const PASSWORD = process.env.USA_PASSWORD ?? "";

if (!EMAIL || !PASSWORD) {
  console.error("❌  USA_EMAIL et USA_PASSWORD requis");
  process.exit(1);
}

const USA_BASE = "https://www.usvisaappt.com";
const USA_MISSION_ID = 323;
const REFERER_DASHBOARD = `${USA_BASE}/visaapplicantui/home/dashboard`;
const REFERER_REQUESTS  = `${USA_BASE}/visaapplicantui/home/dashboard/requests`;
const REFERER_LOGIN     = `${USA_BASE}/visaapplicantui/home/auth/login`;

function getBrowserHeaders() {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Origin": USA_BASE,
  };
}


async function getPublicIp(): Promise<string> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
    return ((await res.json()) as { ip: string }).ip;
  } catch { return "unknown"; }
}

async function probe(
  label: string,
  url: string,
  options: { method?: string; headers: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { method: options.method ?? "GET", headers: options.headers, body: options.body });
    const body = await res.text();
    const prefix = res.ok ? "✅" : "❌";
    console.log(`   ${prefix} [${res.status}] ${label}`);
    if (res.ok || res.status < 500) {
      console.log(`      ${body.slice(0, 400)}`);
    }
    return { status: res.status, body };
  } catch (err) {
    console.log(`   💥 [ERR] ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 0, body: "" };
  }
}

async function main() {
  console.log("=".repeat(65));
  console.log("  TEST REBOOKING USA — Analyse endpoints");
  console.log("=".repeat(65));
  console.log(`Email: ${EMAIL}`);

  const serverIp = await getPublicIp();
  console.log(`IP directe: ${serverIp}`);

  const proxyUrl = process.env.IPROYAL_PROXY_URL;
  if (proxyUrl) {
    setUsaSessionProxy(proxyUrl);
    console.log(`Proxy: ${proxyUrl.replace(/:([^:@]+)@/, ":***@")}`);
  }

  // ── 1. Login raw — capture TOUT le body + headers ───────────────────────
  console.log("\n[1] LOGIN RAW — capture du body complet et tous les tokens...");
  const loginRes = await fetch(`${USA_BASE}/identity/user/login`, {
    method: "POST",
    headers: {
      ...getBrowserHeaders(),
      "Content-Type": "application/json",
      "Referer": REFERER_LOGIN,
    },
    body: JSON.stringify({ authorization: `Basic ${encryptPortalCredentials(EMAIL, PASSWORD)}` }),
  });

  const loginBody = await loginRes.text();
  console.log(`   HTTP ${loginRes.status}`);
  console.log(`   Body: ${loginBody}`);

  // Tokens depuis HEADERS de réponse
  const headerAccessToken   = loginRes.headers.get("authorization") ?? "";
  const headerRefreshToken  = loginRes.headers.get("refreshtoken") ?? "";
  const headerCsrfToken     = loginRes.headers.get("csrftoken") ?? "";
  console.log(`\n   Header authorization: ${headerAccessToken ? headerAccessToken.slice(0, 30) + "..." : "(absent)"}`);
  console.log(`   Header refreshtoken : ${headerRefreshToken ? headerRefreshToken.slice(0, 30) + "..." : "(absent)"}`);
  console.log(`   Header csrftoken    : ${headerCsrfToken ? headerCsrfToken.slice(0, 30) + "..." : "(absent)"}`);

  // Tokens depuis BODY JSON
  let bodyData: Record<string, unknown> = {};
  try { bodyData = JSON.parse(loginBody) as Record<string, unknown>; } catch { /* ignore */ }
  const bodyAccessToken  = (bodyData["accessToken"]  as string | undefined) ?? "";
  const bodyRefreshToken = (bodyData["refreshToken"] as string | undefined) ?? "";
  const bodyIdToken      = (bodyData["idToken"]      as string | undefined) ?? "";
  console.log(`\n   Body.accessToken  : ${bodyAccessToken  ? bodyAccessToken.slice(0, 30)  + "..." : "(absent)"}`);
  console.log(`   Body.refreshToken : ${bodyRefreshToken ? bodyRefreshToken.slice(0, 30) + "..." : "(absent)"}`);
  console.log(`   Body.idToken      : ${bodyIdToken      ? bodyIdToken.slice(0, 30)      + "..." : "(absent)"}`);
  console.log(`   Body.uuid         : ${bodyData["uuid"] ?? "(absent)"}`);
  console.log(`   Body.userID       : ${bodyData["userID"] ?? "(absent)"}`);
  console.log(`   Body.userName     : ${bodyData["userName"] ?? "(absent)"}`);

  if (!headerAccessToken) {
    console.error("\n❌ Pas de token — login échoué, abandon");
    process.exit(1);
  }

  const userID = bodyData["userID"] as number ?? 0;
  const uuid   = bodyData["uuid"] as string ?? "";

  // ── 2. getUserHistoryApplicantPaymentStatus (raw complet) ─────────────────
  console.log("\n[2] getUserHistoryApplicantPaymentStatus...");
  const baseHdr: Record<string, string> = {
    ...getBrowserHeaders(),
    "Authorization": `Bearer ${headerAccessToken}`,
    "Referer": REFERER_REQUESTS,
  };
  await probe("paymentStatus (Bearer header token)", `${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus`, { headers: baseHdr });

  // Si le body a aussi un accessToken différent, tester cela aussi
  if (bodyAccessToken && bodyAccessToken !== headerAccessToken) {
    const bodyHdr = { ...baseHdr, "Authorization": `Bearer ${bodyAccessToken}` };
    await probe("paymentStatus (Bearer body.accessToken)", `${USA_BASE}/visaworkflowprocessor/workflow/getUserHistoryApplicantPaymentStatus`, { headers: bodyHdr });
  }

  // ── 3. visauserapi — essai avec idToken / bodyAccessToken / uuid ──────────
  console.log("\n[3] visauserapi getallbyuser — essai de TOUS les tokens...");

  const cookieHdr = { ...baseHdr, "Cookie": `missionId=${USA_MISSION_ID}` };
  const targets = [
    `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser?type=GROUPREQUEST`,
    `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser?type=INDIVIDUAL`,
    `${USA_BASE}/visauserapi/appointmentrequest/getallbyuser`,
  ];

  // Tokens à essayer
  const tokensToTest: Array<[string, string]> = [
    ["header Bearer",    headerAccessToken],
    ...(bodyAccessToken  && bodyAccessToken  !== headerAccessToken ? [["body.accessToken Bearer",  bodyAccessToken ]] as [string, string][] : []),
    ...(bodyIdToken      ? [["body.idToken Bearer",     bodyIdToken     ]] as [string, string][] : []),
    ...(headerCsrfToken  ? [["csrfToken Bearer",        headerCsrfToken ]] as [string, string][] : []),
    ...(uuid             ? [["uuid as Bearer",          uuid            ]] as [string, string][] : []),
  ];

  for (const url of targets) {
    const urlLabel = url.split("?")[1] ?? "no-type";
    for (const [tLabel, token] of tokensToTest) {
      const h: Record<string, string> = {
        ...getBrowserHeaders(),
        "Authorization": `Bearer ${token}`,
        "Referer": REFERER_REQUESTS,
        "Cookie": `missionId=${USA_MISSION_ID}`,
      };
      await probe(`getallbyuser?${urlLabel} — ${tLabel}`, url, { headers: h });
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // ── 4. Endpoints alternatifs "manage appointment" ──────────────────────────
  console.log("\n[4] Endpoints alternatifs — gestion rendez-vous...");

  const hdr = cookieHdr;
  const userHdr = { ...cookieHdr, "Cookie": `missionId=${USA_MISSION_ID}; userId=${userID}` };
  void userHdr;

  // Liste exhaustive des endpoints potentiels
  const altEndpoints: Array<[string, string, Record<string, string>, string?, string?]> = [
    // visaappointmentapi
    ["getAppointmentsByUserId",       `${USA_BASE}/visaappointmentapi/appointments/getbyuserid?userId=${userID}`, hdr],
    ["getAppointmentsByUserIdV2",     `${USA_BASE}/visaappointmentapi/appointments/getappointmentsbyuserid?userId=${userID}`, hdr],
    ["getApptByApplicant",            `${USA_BASE}/visaappointmentapi/appointments/getbyapplicant?applicantId=${userID}&missionId=${USA_MISSION_ID}`, hdr],
    ["getApptByMission",              `${USA_BASE}/visaappointmentapi/appointments/getbymission?missionId=${USA_MISSION_ID}`, hdr],
    ["getScheduledAppointments",      `${USA_BASE}/visaappointmentapi/appointments/getscheduledappointments?userId=${userID}`, hdr],
    ["getApptRequestsByUser",         `${USA_BASE}/visaappointmentapi/appointmentrequests/getbyuserid?userId=${userID}`, hdr],
    // visauserapi alternatives
    ["visauserapi/user/getbyid",      `${USA_BASE}/visauserapi/user/getbyid?userId=${userID}`, hdr],
    ["visauserapi/user/getapplicant", `${USA_BASE}/visauserapi/user/getapplicant?userId=${userID}`, hdr],
    ["visauserapi/appointmentrequest/getbyuser", `${USA_BASE}/visauserapi/appointmentrequest/getbyuser?userId=${userID}`, hdr],
    // visaworkflowprocessor alternatives
    ["workflow/getapplicationbyuser", `${USA_BASE}/visaworkflowprocessor/workflow/getapplicationbyuser?userId=${userID}`, { ...baseHdr }],
    ["workflow/getapplications",      `${USA_BASE}/visaworkflowprocessor/workflow/getapplications?userId=${userID}`, { ...baseHdr }],
    ["workflow/getAppByUserId",       `${USA_BASE}/visaworkflowprocessor/workflow/getAppByUserId?userId=${userID}`, { ...baseHdr }],
  ];

  for (const [label, url, hdrs] of altEndpoints) {
    await probe(label, url, { headers: hdrs });
    await new Promise(r => setTimeout(r, 300));
  }

  // ── 5. Approche "manage-appointment" — navigation vers la page de gestion ──
  console.log("\n[5] Page manage-appointment (GET) + extraction d'applicationId...");
  const manageUrl = `${USA_BASE}/visaapplicantui/home/dashboard/manage-appointment`;
  const manageRes = await fetch(manageUrl, {
    method: "GET",
    headers: {
      ...getBrowserHeaders(),
      "Authorization": `Bearer ${headerAccessToken}`,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": REFERER_DASHBOARD,
      "Cookie": `missionId=${USA_MISSION_ID}`,
    },
  });
  const manageBody = await manageRes.text();
  console.log(`   HTTP ${manageRes.status} — ${manageBody.length} bytes`);
  if (manageRes.ok) {
    // Chercher des IDs dans la réponse HTML
    const ids = manageBody.match(/applicationId['":\s]+(\d+)/gi) ?? [];
    const apptIds = manageBody.match(/appointmentId['":\s]+(\d+)/gi) ?? [];
    console.log(`   applicationId patterns: ${ids.slice(0, 5).join(", ") || "(aucun)"}`);
    console.log(`   appointmentId patterns: ${apptIds.slice(0, 5).join(", ") || "(aucun)"}`);
  }

  setUsaSessionProxy(undefined);
  console.log("\n" + "=".repeat(65));
  console.log("  FIN");
  console.log("=".repeat(65));
  process.exit(0);
}

main().catch((err) => {
  console.error("Erreur:", err);
  setUsaSessionProxy(undefined);
  process.exit(1);
});
