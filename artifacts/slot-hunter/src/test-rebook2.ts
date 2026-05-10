/**
 * Test — Probe endpoints reschedule/cancel sur visaworkflowprocessor
 * Usage : USA_EMAIL="email" USA_PASSWORD="pass" npx tsx src/test-rebook2.ts
 */
import { loginUsaPortal, setUsaSessionProxy } from "./usaPortal.js";

const EMAIL    = process.env.USA_EMAIL    ?? "";
const PASSWORD = process.env.USA_PASSWORD ?? "";
if (!EMAIL || !PASSWORD) { console.error("USA_EMAIL + USA_PASSWORD requis"); process.exit(1); }

const BASE = "https://www.usvisaappt.com";
const MISSION_ID = 323;

async function probe(label: string, url: string, headers: Record<string, string>, method = "GET", body?: string): Promise<void> {
  try {
    const r = await fetch(url, { method, headers, body });
    const txt = await r.text();
    const ico = r.ok ? "✅" : r.status === 404 ? "🔍" : r.status >= 500 ? "⚠️" : "❌";
    console.log(`${ico} [${r.status}] ${label}`);
    if (r.ok || r.status !== 401) console.log(`   ${txt.slice(0, 400)}`);
  } catch (err) { console.log(`💥 ${label}: ${err}`); }
  await new Promise(r => setTimeout(r, 280));
}

async function main(): Promise<void> {
  setUsaSessionProxy(process.env.IPROYAL_PROXY_URL);
  const s = await loginUsaPortal(EMAIL, PASSWORD);
  if (!s) { console.error("Login failed"); process.exit(1); }

  console.log(`✅ Login: ${s.fullName} (userID=${s.userID})\n`);

  const hdr: Record<string, string> = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Authorization": `Bearer ${s.accessToken}`,
    "Origin": BASE,
    "Referer": `${BASE}/visaapplicantui/home/dashboard`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };

  console.log("=== SECTION A — visaworkflowprocessor endpoints reschedule ===");
  const WF = `${BASE}/visaworkflowprocessor/workflow`;
  for (const [label, path] of [
    ["getApplicationDetails?userId",          `${WF}/getApplicationDetails?userId=${s.userID}`],
    ["reschedule?userId",                      `${WF}/reschedule?userId=${s.userID}`],
    ["cancelAppointment?userId",               `${WF}/cancelAppointment?userId=${s.userID}`],
    ["getScheduledAppt?userId",                `${WF}/getScheduledAppt?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["getApptHistory?userId",                  `${WF}/getApptHistory?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["getManageAppointment?userId",            `${WF}/getManageAppointment?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["getUserApptDetails",                     `${WF}/getUserApptDetails?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["getAllApplicationByUserId",               `${WF}/getAllApplicationByUserId?userId=${s.userID}`],
    ["getPaidApplicationByUserId",             `${WF}/getPaidApplicationByUserId?userId=${s.userID}`],
    ["getApptByUserId",                        `${WF}/getApptByUserId?userId=${s.userID}`],
    ["getConfirmedApplicationByUserId",        `${WF}/getConfirmedApplicationByUserId?userId=${s.userID}`],
    ["getCompletedApplicationByUserId",        `${WF}/getCompletedApplicationByUserId?userId=${s.userID}`],
    ["getHistoryApplicationByUserId",          `${WF}/getHistoryApplicationByUserId?userId=${s.userID}`],
    ["getPaymentStatusByUserId",               `${WF}/getPaymentStatusByUserId?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["getUserHistApptPayStatus no param",      `${WF}/getUserHistoryApplicantPaymentStatus`],
  ] as [string, string][]) {
    await probe(label, path, hdr);
  }

  console.log("\n=== SECTION B — visaappointmentapi avec userId (pas de type) ===");
  const APPT = `${BASE}/visaappointmentapi`;
  for (const [label, path] of [
    ["appointments/getbyuserid (num)",         `${APPT}/appointments/getbyuserid/${s.userID}`],
    ["appointments/getbyuserid?id=num",        `${APPT}/appointments/getbyuserid?id=${s.userID}`],
    ["appointments/getExistingAppt",           `${APPT}/appointments/getExistingAppt?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["appointments/getcancellable",            `${APPT}/appointments/getcancellable?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["appointments/getapptbymission+user",     `${APPT}/appointments/getapptbymissionanduser?userId=${s.userID}&missionId=${MISSION_ID}`],
    ["appointmentrequest/getbyuserid",         `${APPT}/appointmentrequest/getbyuserid?userId=${s.userID}`],
    ["appointmentrequest/getallbyuser",        `${APPT}/appointmentrequest/getallbyuser?userId=${s.userID}`],
  ] as [string, string][]) {
    await probe(label, path, hdr);
  }

  console.log("\n=== SECTION C — Workflow/cancel via POST ===");
  const jsonHdr = { ...hdr, "Content-Type": "application/json" };
  await probe("POST workflow/cancelAppointment (userId body)", `${WF}/cancelAppointment`, jsonHdr, "POST", JSON.stringify({ userId: s.userID, missionId: MISSION_ID }));
  await probe("POST workflow/rescheduleAppointment (userId body)", `${WF}/rescheduleAppointment`, jsonHdr, "POST", JSON.stringify({ userId: s.userID, missionId: MISSION_ID }));
  await probe("PUT  workflow/cancelAppointment (userId body)", `${WF}/cancelAppointment`, jsonHdr, "PUT", JSON.stringify({ userId: s.userID, missionId: MISSION_ID }));

  console.log("\n=== SECTION D — visaintegrationapi (sanity check) ===");
  const INT = `${BASE}/visaintegrationapi`;
  await probe("getApplicationByUserId",  `${INT}/getApplicationByUserId?userId=${s.userID}`, hdr);
  await probe("getApptDetails",          `${INT}/getApptDetails?userId=${s.userID}`, hdr);

  setUsaSessionProxy(undefined);
  console.log("\n✅ FIN");
}

main().catch(err => { console.error(err); process.exit(1); });
