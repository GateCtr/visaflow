/**
 * Test : le JWT est-il invalidé APRÈS un refresh (même IP) ?
 * 
 * Hypothèse à vérifier :
 *   1. Login → accessToken A → appels API OK ✓
 *   2. Refresh → accessToken B (même IP) → appels API 401 ✗
 * 
 * Si le test confirme : le serveur lie le token à l'IP auth_time et le refresh
 * crée un nouveau token que le serveur ne "reconnaît" pas immédiatement
 * (délai de propagation Cognito ? Invalidation du premier token au refresh ?).
 * 
 * Usage : npx tsx src/test-refresh-ip-binding.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { loginUsaPortal, setUsaSessionProxy, makeIproyalStickyUrl } from "./usaPortal.js";
import {
  usaFetch,
  getBrowserHeaders,
  authHeaders,
  parseJwtExpiry,
} from "./usaPortal/usa-http.js";
import {
  USA_REFRESH_URL,
  USA_PAYMENT_STATUS_URL,
  USA_APPT_REQUESTS_URL,
  REFERER_DASHBOARD,
} from "./usaPortal/config.js";

const EMAIL = process.env.USA_EMAIL || "cbampasa@gmail.com";
const PASSWORD = process.env.USA_PASSWORD || "Akollad@2026";
const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL;
const BRIGHTDATA_PROXY_URL = process.env.BRIGHTDATA_PROXY_URL;
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY;

/** Build a 2captcha gateway sticky proxy URL for Congo */
function build2captchaProxy(sessionId: string): string {
  const user = process.env.TWOCAPTCHA_PROXY_USER ?? TWOCAPTCHA_API_KEY ?? "";
  const username = `${user}-zone-custom-region-cd_session-${sessionId}_lifetime-1h`;
  const password = user;
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@eu.proxy.2captcha.com:2334`;
}

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

async function getPublicIp(): Promise<string> {
  try {
    const res = await usaFetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(10_000) });
    const j = await res.json() as { ip: string };
    return j.ip;
  } catch { return "unknown"; }
}

/** Appel API authentifié léger pour tester le token */
async function testApiCall(accessToken: string, label: string, endpoint?: string): Promise<{ status: number; body: string }> {
  const url = endpoint ?? USA_APPT_REQUESTS_URL;
  const headers = authHeaders(accessToken, REFERER_DASHBOARD, false);
  
  try {
    const res = await usaFetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text().catch(() => "");
    console.log(`  [${label}] GET ${url.split("?")[0].split("/").pop()} → HTTP ${res.status}`);
    if (res.status !== 200) {
      console.log(`  [${label}] Body (extrait): ${body.slice(0, 200)}`);
    }
    return { status: res.status, body };
  } catch (err: any) {
    console.log(`  [${label}] ERREUR: ${err.message}`);
    return { status: -1, body: err.message };
  }
}

/** POST /refreshToken et retourne le nouveau access + refresh token */
async function doRefresh(accessToken: string, refreshToken: string): Promise<{
  newAccess: string;
  newRefresh: string;
  status: number;
  allHeaders: Record<string, string>;
} | null> {
  const headers: Record<string, string> = {
    ...getBrowserHeaders(),
    "Content-Type": "application/json",
    "Referer": REFERER_DASHBOARD,
  };

  const res = await usaFetch(USA_REFRESH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ refreshToken, username: EMAIL }),
    signal: AbortSignal.timeout(30_000),
  });

  const allHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { allHeaders[k] = v; });

  console.log(`  [refresh] POST /refreshToken → HTTP ${res.status}`);
  console.log(`  [refresh] Headers réponse: ${Object.keys(allHeaders).join(", ")}`);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.log(`  [refresh] Body: ${body.slice(0, 300)}`);
    return null;
  }

  const newAccess = stripBearer(res.headers.get("authorization"));
  const newRefresh = stripBearer(res.headers.get("refreshtoken")) || refreshToken;

  return { newAccess, newRefresh, status: res.status, allHeaders };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=".repeat(70));
  console.log(" TEST: JWT ↔ IP BINDING APRÈS REFRESH (proxy résidentiel iProyal)");
  console.log("=".repeat(70));
  console.log(`Email : ${EMAIL}`);
  console.log(`Proxy : ${IPROYAL_PROXY_URL ? "iProyal (résidentiel Kinshasa)" : "AUCUN"}\n`);

  // Configurer le proxy — utiliser 2captcha gateway (le seul qui marche)
  let proxyUrl: string | undefined;
  const proxyUser = process.env.TWOCAPTCHA_PROXY_USER ?? TWOCAPTCHA_API_KEY ?? "";

  if (proxyUser) {
    // 2captcha gateway sticky (iProyal backend) — pas besoin de solde iProyal direct
    const sessionId = `test-jwt-${Date.now().toString(36)}`;
    const username = `${proxyUser}-zone-custom-region-cd_session-${sessionId}_lifetime-1h`;
    proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(proxyUser)}@eu.proxy.2captcha.com:2334`;
    const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
    console.log(`Proxy sticky (2captcha gateway): ${masked}`);
    setUsaSessionProxy(proxyUrl);
  } else {
    console.warn("⚠️ Aucun proxy défini — test en direct");
    setUsaSessionProxy(undefined);
  }

  const ip = await getPublicIp();
  console.log(`IP publique: ${ip}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 1 : LOGIN
  // ══════════════════════════════════════════════════════════════════════════
  console.log("── ÉTAPE 1 : LOGIN ─────────────────────────────────────────────");
  let session;
  try {
    session = await loginUsaPortal(EMAIL, PASSWORD);
  } catch (err: any) {
    console.error(`❌ Login échoué: ${err.message}`);
    process.exit(1);
  }
  if (!session?.accessToken) {
    console.error("❌ Login sans accessToken");
    process.exit(1);
  }

  console.log(`✅ Login OK — fullName: ${session.fullName}`);
  console.log(`   accessToken: ${session.accessToken.slice(0, 30)}...`);
  console.log(`   refreshToken: ${session.refreshToken ? session.refreshToken.slice(0, 30) + "..." : "(absent)"}`);

  // Décoder le JWT pour voir auth_time et exp
  const payload = decodeJwtPayload(session.accessToken);
  if (payload) {
    console.log(`   JWT auth_time: ${payload.auth_time} (${new Date((payload.auth_time as number) * 1000).toISOString()})`);
    console.log(`   JWT exp: ${payload.exp} (${new Date((payload.exp as number) * 1000).toISOString()})`);
    console.log(`   JWT cognito:username: ${payload["cognito:username"]}`);
    console.log(`   JWT iss: ${(payload.iss as string)?.slice(0, 60)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 2 : APPEL API AVEC TOKEN ORIGINAL (doit marcher)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── ÉTAPE 2 : APPEL API — TOKEN ORIGINAL ────────────────────────");
  await sleep(2000); // Pause réaliste

  const test1 = await testApiCall(session.accessToken, "token-original");
  const originalWorks = test1.status === 200;
  console.log(`   Résultat: ${originalWorks ? "✅ OK (200)" : `❌ ÉCHEC (${test1.status})`}`);

  if (!originalWorks) {
    console.error("\n⚠️  Le token original ne fonctionne même pas — probablement restriction IP.");
    console.error("   Cela confirme que l'IP actuelle n'est pas autorisée pour les appels API.");
    // On continue quand même pour tester le refresh
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 3 : REFRESH TOKEN (même IP)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── ÉTAPE 3 : REFRESH TOKEN (même IP) ──────────────────────────");
  await sleep(3000); // Pause réaliste avant refresh

  if (!session.refreshToken) {
    console.error("❌ Pas de refresh token — impossible de tester");
    process.exit(1);
  }

  const refreshResult = await doRefresh(session.accessToken, session.refreshToken);
  if (!refreshResult || !refreshResult.newAccess) {
    console.error("❌ Refresh échoué — pas de nouveau token");
    process.exit(1);
  }

  console.log(`✅ Refresh OK — nouveau token reçu`);
  console.log(`   newAccess: ${refreshResult.newAccess.slice(0, 30)}...`);
  console.log(`   newRefresh: ${refreshResult.newRefresh.slice(0, 30)}...`);
  console.log(`   Même token? ${refreshResult.newAccess === session.accessToken ? "OUI (pas changé!)" : "NON (nouveau JWT)"}`);

  // Décoder le nouveau JWT
  const newPayload = decodeJwtPayload(refreshResult.newAccess);
  if (newPayload) {
    console.log(`   Nouveau JWT auth_time: ${newPayload.auth_time} (${new Date((newPayload.auth_time as number) * 1000).toISOString()})`);
    console.log(`   Nouveau JWT exp: ${newPayload.exp} (${new Date((newPayload.exp as number) * 1000).toISOString()})`);
    console.log(`   auth_time changé? ${newPayload.auth_time !== payload?.auth_time ? "OUI ⚠️" : "NON (identique)"}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 4 : APPEL API AVEC NOUVEAU TOKEN (même IP — va-t-il échouer?)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── ÉTAPE 4 : APPEL API — NOUVEAU TOKEN (post-refresh) ──────────");
  await sleep(2000);

  const test2 = await testApiCall(refreshResult.newAccess, "token-refresh");
  const refreshWorks = test2.status === 200;
  console.log(`   Résultat: ${refreshWorks ? "✅ OK (200)" : `❌ ÉCHEC (${test2.status})`}`);

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 5 : APPEL API AVEC ANCIEN TOKEN (est-il invalidé par le refresh?)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── ÉTAPE 5 : APPEL API — ANCIEN TOKEN (post-refresh) ────────────");
  await sleep(2000);

  const test3 = await testApiCall(session.accessToken, "ancien-token-post-refresh");
  const oldStillWorks = test3.status === 200;
  console.log(`   Résultat: ${oldStillWorks ? "✅ Ancien token encore valide" : `❌ Ancien token invalidé (${test3.status})`}`);

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 6 : 2ème APPEL API AVEC NOUVEAU TOKEN (avec un peu plus de délai)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n── ÉTAPE 6 : APPEL API — NOUVEAU TOKEN (5s après refresh) ───────");
  await sleep(5000);

  const test4 = await testApiCall(refreshResult.newAccess, "token-refresh-5s");
  const refresh5sWorks = test4.status === 200;
  console.log(`   Résultat: ${refresh5sWorks ? "✅ OK (200)" : `❌ ÉCHEC (${test4.status})`}`);

  // ══════════════════════════════════════════════════════════════════════════
  // SYNTHÈSE
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(70));
  console.log(" SYNTHÈSE");
  console.log("═".repeat(70));
  console.log(`  IP publique              : ${ip}`);
  console.log(`  Token original → API     : ${originalWorks ? "✅ 200" : `❌ ${test1.status}`}`);
  console.log(`  Refresh (même IP)        : ${refreshResult ? "✅ OK" : "❌ ÉCHEC"}`);
  console.log(`  Nouveau token → API      : ${refreshWorks ? "✅ 200" : `❌ ${test2.status}`}`);
  console.log(`  Ancien token → API       : ${oldStillWorks ? "✅ 200" : `❌ ${test3.status}`}`);
  console.log(`  Nouveau token → API (5s) : ${refresh5sWorks ? "✅ 200" : `❌ ${test4.status}`}`);

  console.log("\n── DIAGNOSTIC ──────────────────────────────────────────────────");
  if (originalWorks && !refreshWorks && !refresh5sWorks) {
    console.log("🔴 CONFIRMÉ: Le refresh INVALIDE le token pour les appels API.");
    console.log("   → Le serveur ne reconnaît pas le nouveau JWT immédiatement.");
    console.log("   → Cause probable: délai propagation Cognito OU le serveur");
    console.log("     garde un mapping session_id → access_token et le refresh");
    console.log("     ne met pas à jour ce mapping côté backend.");
    console.log("   → SOLUTION: NE PAS faire de refresh proactif — laisser le");
    console.log("     token original vivre ses 60 min puis re-login.");
  } else if (originalWorks && refreshWorks) {
    console.log("🟢 Le refresh fonctionne correctement — le nouveau token est accepté.");
    console.log("   → Le binding IP n'est PAS un problème quand on reste sur la même IP.");
    console.log("   → Le problème que tu observes vient d'un CHANGEMENT d'IP (proxy reset).");
  } else if (!originalWorks && !refreshWorks) {
    console.log("🟠 NI le token original NI le nouveau ne fonctionnent.");
    console.log("   → Problème en amont: IP bloquée, compte restreint, ou rate-limit.");
    console.log("   → L'IP directe Railway est peut-être blacklistée par le portail.");
  } else if (!originalWorks && refreshWorks) {
    console.log("🟡 CAS ÉTRANGE: Token original 401, mais nouveau token OK.");
    console.log("   → Peut indiquer que le refresh 'réinitialise' le binding IP.");
    console.log("   → C'est ta faille potentielle!");
  } else if (originalWorks && refreshWorks && !oldStillWorks) {
    console.log("🟡 Le refresh invalide l'ancien token (Cognito rotation).");
    console.log("   → Le nouveau token fonctionne, l'ancien est révoqué.");
    console.log("   → Comportement normal de rotation Cognito.");
  }

  console.log("\n" + "═".repeat(70));
  process.exit(0);
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
