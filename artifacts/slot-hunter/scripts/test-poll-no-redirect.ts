/**
 * TEST CRITIQUE: Poll /Home/AvailableTimeSlots SANS suivre le redirect après SetCaptchaToken
 * Si ça fonctionne → on peut poll en boucle rapide pendant 15 min avec un seul clic!
 */
import "dotenv/config";
import { Impit } from "impit";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY || "";
const SOAX = process.env.SOAX_PROXY_URL || "";
const p = new URL(SOAX);
p.password = encodeURIComponent(decodeURIComponent(p.password) + "_country-cd_city-kinshasa_sessionid-polltest" + Date.now() + "_sessiontime-600");
const impit = new Impit({ proxy: p.toString() });
const f = (u: string, o: any) => impit.fetch(u, o) as unknown as Promise<Response>;
function log(m: string) { console.log("[" + new Date().toISOString().slice(11, 19) + "] " + m); }

let allSetCookies: string[] = [];
function accumulateCookies(res: Response): string {
  const raw = res.headers.get("set-cookie");
  if (raw) for (const part of raw.split(/,\s*(?=[A-Za-z_\-.]+=)/)) {
    const name = part.split("=")[0].trim();
    allSetCookies = allSetCookies.filter(c => !c.startsWith(`${name}=`));
    allSetCookies.push(part.trim());
  }
  return buildCk();
}
function buildCk(): string {
  const pairs = new Map<string, string>();
  for (const sc of allSetCookies) { const m = sc.split(";")[0].trim(); const i = m.indexOf("="); if (i > 0) pairs.set(m.slice(0, i), m.slice(i + 1)); }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join("; ");
}

const APP_ID = "e978b2fd-472f-f111-a3ae-00505691de06"; // VOWINT5903406

async function main() {
  log("=== TEST: Poll sans redirect (VOWINT5903406) ===");

  // Login
  allSetCookies = [];
  const lp = await f(VOWINT_BASE + "/", { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" });
  await lp.text(); accumulateCookies(lp);
  const csrf = (await f(VOWINT_BASE + "/", { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" }).then(async r => { accumulateCookies(r); return (await r.text()).match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] || ""; }));
  // re-login fresh
  allSetCookies = [];
  const lp2 = await f(VOWINT_BASE + "/", { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" });
  const lhtml = await lp2.text(); accumulateCookies(lp2);
  const csrf2 = lhtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] || "";
  const lr = await f(VOWINT_BASE + "/en/Account/Login", { method: "POST", redirect: "manual", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": buildCk(), "Origin": VOWINT_BASE, "Referer": VOWINT_BASE + "/" }, body: new URLSearchParams({ __RequestVerificationToken: csrf2, UserName: "screentapinc@gmail.com", Password: "Akollad@2026" }).toString() });
  accumulateCookies(lr);
  if (lr.status !== 302) { log("Login FAILED: " + lr.status); process.exit(1); }
  let loc = lr.headers.get("location");
  for (let i = 0; i < 5 && loc; i++) { const r = await f((loc.startsWith("http") ? loc : VOWINT_BASE + loc), { method: "GET", headers: { "User-Agent": UA, "Cookie": buildCk() }, redirect: "manual" }); accumulateCookies(r); loc = r.status >= 300 ? r.headers.get("location") : null; }
  log("Login OK");

  // GetEAppointmentUrl (1 clic)
  log("GetEAppointmentUrl...");
  const eRes = await f(VOWINT_BASE + "/Common/GetEAppointmentUrl?id=" + APP_ID, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, "Cookie": buildCk(), "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/html, */*", "Referer": VOWINT_BASE + "/en/VisaApplication/IndexByUserId" } });
  const eText = await eRes.text();
  let integUrl = "";
  try { const d = JSON.parse(eText); integUrl = typeof d === "string" ? d : d?.url || ""; } catch { if (eText.includes("/Integration/")) integUrl = eText.trim().replace(/^"|"$/g, ""); }
  if (!integUrl) { log("❌ No URL: " + eText.slice(0, 100)); process.exit(1); }
  log("✅ URL: " + integUrl.slice(0, 80));

  // Get CEV cookie
  const i1 = await f(integUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": UA } });
  const cevCookie = (i1.headers.get("set-cookie") || "").match(/ASP\.NET_SessionId=([^;]+)/)?.[1] || "";
  if (!cevCookie) { log("❌ No CEV cookie"); process.exit(1); }
  const cevCk = `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`;
  log("✅ CEV cookie: " + cevCookie.slice(0, 16));

  // Navigate to /Captcha
  const captchaLoc = i1.headers.get("location") || "/Captcha";
  await f((captchaLoc.startsWith("http") ? captchaLoc : CEV_BASE + captchaLoc), { method: "GET", redirect: "follow", headers: { "User-Agent": UA, "Cookie": cevCk } }).then(r => r.text());
  log("Captcha page loaded");

  // Solve hCaptcha
  log("Solving hCaptcha (AntiCaptcha)...");
  const cr = await fetch("https://api.anti-captcha.com/createTask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, task: { type: "HCaptchaTaskProxyless", websiteURL: CEV_BASE + "/Captcha", websiteKey: HCAPTCHA_SITEKEY } }) });
  const cd = await cr.json() as any;
  if (cd.errorId !== 0) { log("❌ " + cd.errorDescription); process.exit(1); }
  log("  Task: " + cd.taskId);
  let token: string | null = null;
  for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 5000)); const gr = await fetch("https://api.anti-captcha.com/getTaskResult", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId: cd.taskId }) }); const gd = await gr.json() as any; if (gd.status === "ready") { token = gd.solution?.gRecaptchaResponse || gd.solution?.token; log("  ✅ Solved in " + (i + 1) * 5 + "s"); break; } if (gd.errorId !== 0) { log("  ❌ " + gd.errorDescription); break; } if (i % 6 === 5) log("  ..." + (i + 1) * 5 + "s"); }
  if (!token) { log("❌ Captcha failed"); process.exit(1); }

  // SetCaptchaToken
  log("POST SetCaptchaToken...");
  const stRes = await f(CEV_BASE + "/Captcha/SetCaptchaToken", { method: "POST", redirect: "manual", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cevCk, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*", "Referer": CEV_BASE + "/Captcha", "Origin": CEV_BASE }, body: "captcha=" + encodeURIComponent(token) });
  const stBody = await stRes.text();
  let stData: any;
  try { stData = JSON.parse(stBody); } catch { log("❌ Non-JSON: " + stBody.slice(0, 200)); process.exit(1); }
  log("✅ validUntil: " + stData.validUntil + " | redirect: " + (stData.redirectUrl || "").slice(0, 60));
  log("");

  // === THE CRITICAL TEST ===
  log("═══════════════════════════════════════════════════════════");
  log("  POLL /Home/AvailableTimeSlots SANS SUIVRE LE REDIRECT");
  log("═══════════════════════════════════════════════════════════");
  log("");

  const now = new Date();
  const m1 = now.getMonth() + 1, y1 = now.getFullYear();
  const m2 = m1 === 12 ? 1 : m1 + 1, y2 = m1 === 12 ? y1 + 1 : y1;

  for (let i = 0; i < 10; i++) {
    const month = i % 2 === 0 ? m1 : m2;
    const year = i % 2 === 0 ? y1 : y2;
    const pr = await f(CEV_BASE + "/Home/AvailableTimeSlots", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "Cookie": cevCk, "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/javascript, */*; q=0.01", "Referer": CEV_BASE + "/Integration/VOW/SelectSlot", "Origin": CEV_BASE }, body: JSON.stringify({ month, year }) });
    if (pr.status === 401 || pr.status === 403) { log(`#${i} (${month}/${year}): ❌ ${pr.status} SESSION MORTE`); break; }
    if (pr.status >= 300) { const l = pr.headers.get("location") || ""; log(`#${i} (${month}/${year}): ↗️ ${pr.status} → ${l.slice(0, 60)}`); if (l.includes("Session") || l.includes("Captcha")) { log("  Session dead"); break; } continue; }
    const pb = await pr.text();
    log(`#${i} (${month}/${year}): ✅ HTTP ${pr.status} → [${pb.slice(0, 150)}]`);
    try { const d = JSON.parse(pb); if (Array.isArray(d)) log(`  Array(${d.length}) ${d.length > 0 ? "🚨 SLOTS!" : "(vide)"}`); } catch {}
    if (i < 9) await new Promise(r => setTimeout(r, 3000));
  }

  log("");
  log("═══════════════════════════════════════════════════════════");
  log("  FIN DU TEST");
  log("═══════════════════════════════════════════════════════════");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
