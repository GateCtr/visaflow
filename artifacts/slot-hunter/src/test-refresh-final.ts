/**
 * Test DÉFINITIF : login → API OK → refresh → API avec nouveau token
 * Endpoint : getUserHistoryApplicantPaymentStatus (celui qui marche)
 */
import * as dotenv from "dotenv";
dotenv.config();

import { loginUsaPortal, setUsaSessionProxy } from "./usaPortal.js";
import { usaFetch, getBrowserHeaders, authHeaders } from "./usaPortal/usa-http.js";
import { USA_REFRESH_URL, USA_PAYMENT_STATUS_URL, REFERER_DASHBOARD } from "./usaPortal/config.js";

const EMAIL = process.env.USA_EMAIL || "cbampasa@gmail.com";
const PASSWORD = process.env.USA_PASSWORD || "Akollad@2026";

function stripBearer(t: string | null | undefined): string {
  if (!t) return "";
  return t.trim().replace(/^Bearer\s+/i, "").trim();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return null; }
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function testApi(accessToken: string, label: string): Promise<number> {
  const h = authHeaders(accessToken, REFERER_DASHBOARD, false);
  const res = await usaFetch(USA_PAYMENT_STATUS_URL, { method: "GET", headers: h, signal: AbortSignal.timeout(15000) });
  const body = await res.text().catch(() => "");
  console.log(`  [${label}] GET /getUserHistoryApplicantPaymentStatus → HTTP ${res.status}`);
  if (res.status !== 200) console.log(`  [${label}] Body: ${body.slice(0, 200)}`);
  return res.status;
}

async function doRefresh(refreshToken: string): Promise<{ newAccess: string; newRefresh: string } | null> {
  const headers: Record<string, string> = {
    ...getBrowserHeaders(),
    "Content-Type": "application/json",
    "Referer": REFERER_DASHBOARD,
  };
  const res = await usaFetch(USA_REFRESH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ refreshToken, username: EMAIL }),
    signal: AbortSignal.timeout(30000),
  });
  console.log(`  [refresh] POST /refreshToken → HTTP ${res.status}`);
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    console.log(`  [refresh] Body: ${b.slice(0, 200)}`);
    return null;
  }
  const newAccess = stripBearer(res.headers.get("authorization"));
  const newRefresh = stripBearer(res.headers.get("refreshtoken")) || refreshToken;
  return { newAccess, newRefresh };
}

async function main() {
  console.log("=".repeat(70));
  console.log(" TEST DÉFINITIF: Login → API OK → Refresh → API nouveau token");
  console.log(" Endpoint: getUserHistoryApplicantPaymentStatus");
  console.log("=".repeat(70));

  // Proxy 2captcha gateway sticky
  const proxyUser = process.env.TWOCAPTCHA_PROXY_USER ?? process.env.TWOCAPTCHA_API_KEY ?? "";
  const sessionId = `final-${Date.now().toString(36)}`;
  const username = `${proxyUser}-zone-custom-region-cd_session-${sessionId}_lifetime-1h`;
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(proxyUser)}@eu.proxy.2captcha.com:2334`;
  setUsaSessionProxy(proxyUrl);

  // IP
  try {
    const ipRes = await usaFetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(10000) });
    const ipJ = await ipRes.json() as { ip: string };
    console.log(`IP proxy: ${ipJ.ip}`);
  } catch { console.log("IP: unknown"); }

  // ── 1. LOGIN ──
  console.log("\n── ÉTAPE 1 : LOGIN ──");
  let session;
  try {
    session = await loginUsaPortal(EMAIL, PASSWORD);
  } catch (e: any) {
    console.error(`❌ Login échoué: ${e.message}`);
    process.exit(1);
  }
  if (!session?.accessToken || !session.refreshToken) {
    console.error("❌ Pas de token/refresh");
    process.exit(1);
  }
  console.log(`✅ Login OK — ${session.fullName}`);
  const p1 = decodeJwtPayload(session.accessToken);
  if (p1) console.log(`   auth_time: ${p1.auth_time}, exp: ${p1.exp}`);

  // ── 2. API AVEC TOKEN ORIGINAL ──
  console.log("\n── ÉTAPE 2 : API avec token ORIGINAL (pas de refresh) ──");
  await sleep(3000);
  const s2 = await testApi(session.accessToken, "original");

  // ── 3. REFRESH ──
  console.log("\n── ÉTAPE 3 : REFRESH TOKEN (même IP) ──");
  await sleep(3000);
  const refreshResult = await doRefresh(session.refreshToken);
  if (!refreshResult?.newAccess) {
    console.error("❌ Refresh échoué");
    process.exit(1);
  }
  console.log(`✅ Refresh OK — nouveau token reçu`);
  const p2 = decodeJwtPayload(refreshResult.newAccess);
  if (p2) console.log(`   auth_time: ${p2.auth_time}, exp: ${p2.exp}`);
  console.log(`   Même token? ${refreshResult.newAccess === session.accessToken ? "OUI" : "NON (nouveau)"}`);

  // ── 4. API AVEC NOUVEAU TOKEN (immédiat) ──
  console.log("\n── ÉTAPE 4 : API avec NOUVEAU token (immédiat après refresh) ──");
  await sleep(2000);
  const s4 = await testApi(refreshResult.newAccess, "post-refresh-2s");

  // ── 5. API AVEC ANCIEN TOKEN ──
  console.log("\n── ÉTAPE 5 : API avec ANCIEN token (post-refresh) ──");
  await sleep(2000);
  const s5 = await testApi(session.accessToken, "ancien-post-refresh");

  // ── 6. API AVEC NOUVEAU TOKEN (10s après) ──
  console.log("\n── ÉTAPE 6 : API avec NOUVEAU token (10s après refresh) ──");
  await sleep(10000);
  const s6 = await testApi(refreshResult.newAccess, "post-refresh-10s");

  // ══ SYNTHÈSE ══
  console.log("\n" + "═".repeat(70));
  console.log(" SYNTHÈSE — getUserHistoryApplicantPaymentStatus");
  console.log("═".repeat(70));
  console.log(`  Token original → API        : ${s2 === 200 ? "✅ 200" : `❌ ${s2}`}`);
  console.log(`  Refresh                     : ✅ OK`);
  console.log(`  Nouveau token → API (2s)    : ${s4 === 200 ? "✅ 200" : `❌ ${s4}`}`);
  console.log(`  Ancien token → API          : ${s5 === 200 ? "✅ 200" : `❌ ${s5}`}`);
  console.log(`  Nouveau token → API (10s)   : ${s6 === 200 ? "✅ 200" : `❌ ${s6}`}`);

  console.log("\n── VERDICT ──");
  if (s2 === 200 && s4 !== 200 && s6 !== 200) {
    console.log("🔴 CONFIRMÉ : Le refresh INVALIDE le token pour les API.");
    console.log("   Le bundle Angular ne fait JAMAIS de refresh — et maintenant on sait pourquoi.");
    console.log("   → SOLUTION : Supprimer le refresh proactif. Token 60 min + re-login.");
  } else if (s2 === 200 && s4 === 200) {
    console.log("🟢 Le refresh fonctionne — le nouveau token est accepté.");
    console.log("   Le problème vient d'ailleurs (changement IP, rate-limit...).");
  } else if (s2 !== 200) {
    console.log("🟠 Token original AUSSI rejeté — compte probablement rate-limité.");
  }

  console.log("═".repeat(70));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
