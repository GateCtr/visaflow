/**
 * Test MINIMAL : login + appel API (SANS refresh).
 * Confirme que le token original fonctionne si on ne touche pas au refresh.
 */
import * as dotenv from "dotenv";
dotenv.config();

import { loginUsaPortal, setUsaSessionProxy } from "./usaPortal.js";
import { usaFetch, authHeaders } from "./usaPortal/usa-http.js";
import { USA_APPT_REQUESTS_URL, USA_PAYMENT_STATUS_URL, REFERER_DASHBOARD } from "./usaPortal/config.js";

const EMAIL = process.env.USA_EMAIL || "cbampasa@gmail.com";
const PASSWORD = process.env.USA_PASSWORD || "Akollad@2026";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("=".repeat(60));
  console.log(" TEST: Login + API (SANS refresh) — proxy 2captcha");
  console.log("=".repeat(60));

  // Proxy 2captcha gateway sticky
  const proxyUser = process.env.TWOCAPTCHA_PROXY_USER ?? process.env.TWOCAPTCHA_API_KEY ?? "";
  const sessionId = `norf-${Date.now().toString(36)}`;
  const username = `${proxyUser}-zone-custom-region-cd_session-${sessionId}_lifetime-1h`;
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(proxyUser)}@eu.proxy.2captcha.com:2334`;
  setUsaSessionProxy(proxyUrl);

  // IP
  try {
    const ipRes = await usaFetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(10000) });
    const ipJ = await ipRes.json() as { ip: string };
    console.log(`IP proxy: ${ipJ.ip}`);
  } catch { console.log("IP: unknown"); }

  // LOGIN
  console.log("\n[1] Login...");
  let session;
  try {
    session = await loginUsaPortal(EMAIL, PASSWORD);
  } catch (e: any) {
    console.error(`❌ Login échoué: ${e.message}`);
    process.exit(1);
  }
  if (!session?.accessToken) { console.error("❌ Pas de token"); process.exit(1); }
  console.log(`✅ Login OK — ${session.fullName} — token: ${session.accessToken.slice(0, 20)}...`);

  // Pause comme un humain
  await sleep(3000);

  // API 1 : getallbyuser
  console.log("\n[2] GET /appointmentrequest/getallbyuser (token original, PAS de refresh)...");
  const h1 = authHeaders(session.accessToken, REFERER_DASHBOARD, false);
  const r1 = await usaFetch(USA_APPT_REQUESTS_URL, { method: "GET", headers: h1, signal: AbortSignal.timeout(15000) });
  const b1 = await r1.text().catch(() => "");
  console.log(`   → HTTP ${r1.status}`);
  if (r1.status !== 200) console.log(`   Body: ${b1.slice(0, 200)}`);

  await sleep(2000);

  // API 2 : getUserHistoryApplicantPaymentStatus
  console.log("\n[3] GET /getUserHistoryApplicantPaymentStatus (token original)...");
  const h2 = authHeaders(session.accessToken, REFERER_DASHBOARD, false);
  const r2 = await usaFetch(USA_PAYMENT_STATUS_URL, { method: "GET", headers: h2, signal: AbortSignal.timeout(15000) });
  const b2 = await r2.text().catch(() => "");
  console.log(`   → HTTP ${r2.status}`);
  if (r2.status !== 200) console.log(`   Body: ${b2.slice(0, 200)}`);

  console.log("\n" + "=".repeat(60));
  console.log(` RÉSULTAT: getallbyuser=${r1.status}, paymentStatus=${r2.status}`);
  if (r1.status === 200 || r2.status === 200) {
    console.log(" ✅ Token original FONCTIONNE sans refresh !");
  } else {
    console.log(" ❌ Token original AUSSI rejeté — compte probablement restreint");
  }
  console.log("=".repeat(60));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
